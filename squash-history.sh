#!/usr/bin/env bash
# Fix git history and clean up the conflicts that fixing it leaves behind.
#
#   ./squash-history.sh              interactive menu — the normal way in
#   ./squash-history.sh --tags       every tag: its name and what it points at
#
# The flags below do the same things without the menu, for scripts and CI:
#
#   ./squash-history.sh <base>                 fold every commit after <base> into one
#   ./squash-history.sh <base> -m "…"          fold it, for real
#   ./squash-history.sh <base> -m "…" --tag t  fold it, leaving a safety tag at the old HEAD
#   ./squash-history.sh <base> … --push        fold it and publish in one step
#   ./squash-history.sh --status               what is in progress, and how far from origin
#   ./squash-history.sh --conflicts            the conflicted files and their markers
#   ./squash-history.sh --abort                abort an unfinished merge / rebase / cherry-pick
#   ./squash-history.sh --restore <ref>        go back to a safety tag, hard
#   ./squash-history.sh --publish <ref>        push HEAD; <ref> is what the rewrite replaced
#
# <base> is any revision: a hash (the short form is enough), a tag, or HEAD~3.
# Everything after it becomes one commit whose tree is exactly what HEAD's tree
# is now, so no change is lost — only the intermediate steps disappear.
#
# The menu and the flags run the same functions, so the two paths cannot drift.
#
# The squash itself cannot conflict: `git reset --soft` moves HEAD and leaves
# the index and working tree alone. Conflicts come from the neighbours — a merge
# or rebase left half-finished, a rewritten branch that no longer fast-forwards
# against origin, or a rewrite that needs undoing. Those are what the status,
# conflicts, abort and restore entries are for.
#
# Nothing is pushed unless you ask for it, and even then only when origin is
# sitting exactly at the commit the rewrite started from. That check is stricter
# than --force-with-lease, which on its own is not enough: it compares against
# the remote-tracking ref, so as soon as you fetch someone else's commit it
# happily authorises discarding it. A plain --force is worse still.

set -euo pipefail

cd "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null || {
  echo "error: not a git repository" >&2
  exit 1
}

SELF="$(basename "$0")"

usage() {
  cat <<USAGE
$SELF — fix history, resolve what fixing it leaves behind

Run with no arguments for the interactive menu, which is the normal way to use
it. Everything below is for scripts and for when a menu is not what you want.

  $SELF                                  interactive menu
  $SELF --tags                           every tag: name, kind, what it points at

  $SELF <base-commit>                    fold every commit after <base> into one
  $SELF <base-commit> -m "…"             with a given commit message
  $SELF <base-commit> --tag <name>       leave a safety tag at the current HEAD first
  $SELF <base-commit> --push             publish the rewrite with --force-with-lease

  $SELF --status                         unfinished operation + divergence from origin
  $SELF --conflicts                      conflicted files, with their marker lines
  $SELF --abort                          abort an unfinished merge / rebase / cherry-pick
  $SELF --restore <ref>                  reset --hard back to a tag or commit
  $SELF --publish <ref>                  push HEAD; <ref> is what the rewrite replaced

Options: -m/--message, --tag, --push, -y/--yes, -n/--dry-run
USAGE
}

# ---------------------------------------------------------------- arguments --

MODE="menu"
BASE=""
MESSAGE=""
SAFETY_TAG=""
PUSH=0
ASSUME_YES=0
DRY_RUN=0
NO_MENU=0

while [ $# -gt 0 ]; do
  case "$1" in
    --message|-m)
      [ $# -ge 2 ] || { echo "error: --message needs a value" >&2; exit 1; }
      MESSAGE="$2"; shift 2 ;;
    --message=*) MESSAGE="${1#*=}"; shift ;;

    --tag)
      [ $# -ge 2 ] || { echo "error: --tag needs a name" >&2; exit 1; }
      SAFETY_TAG="$2"; shift 2 ;;
    --tag=*) SAFETY_TAG="${1#*=}"; shift ;;

    --push)   PUSH=1; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    --dry-run|-n) DRY_RUN=1; shift ;;

    --status)    MODE="status"; NO_MENU=1; shift ;;
    --conflicts) MODE="conflicts"; NO_MENU=1; shift ;;
    --tags)      MODE="tags"; NO_MENU=1; shift ;;
    --abort)     MODE="abort"; NO_MENU=1; shift ;;
    --publish)
      MODE="publish"
      [ $# -ge 2 ] || { echo "error: --publish needs the ref the rewrite started from" >&2; exit 1; }
      BASE="$2"; shift 2 ;;
    --publish=*) MODE="publish"; BASE="${1#*=}"; shift ;;
    --restore)
      [ $# -ge 2 ] || { echo "error: --restore needs a ref" >&2; exit 1; }
      MODE="restore"; BASE="$2"; shift 2 ;;
    --restore=*) MODE="restore"; BASE="${1#*=}"; shift ;;

    -h|--help) NO_MENU=1; usage; exit 0 ;;
    -*) echo "error: unknown option: $1" >&2; exit 1 ;;
    *)
      [ "$MODE" = "menu" ] || { echo "error: $MODE takes no base commit" >&2; exit 1; }
      MODE="squash"; NO_MENU=1
      [ -z "$BASE" ] || { echo "error: more than one base commit given" >&2; exit 1; }
      BASE="$1"; shift ;;
  esac
done

# Interactive only when there is a person to answer, and only when asked to do
# one thing — a tag passed alongside --restore is a script, not a conversation.
# Otherwise the menu would swallow a commit hash on stdin and then sit there.
if [ "$MODE" = "menu" ] && [ ! -t 0 ]; then
  echo "error: no arguments and stdin is not a terminal, so there is no menu to show." >&2
  echo "       $SELF --help for the one-shot forms, or run $SELF from a terminal." >&2
  exit 2
fi

confirm() {
  # $1 is the question. Reads stdin, so it must not be fed from a pipeline that
  # is also the script's input.
  [ "$ASSUME_YES" -eq 1 ] && return 0
  local reply
  read -r -p "$1 [y/N] " reply || reply=""
  case "$reply" in
    [yY]|[yY][eE][sS]) return 0 ;;
    *) return 1 ;;
  esac
}

require_clean_tree() {
  # A dirty tree would end up inside whatever this script commits or discards,
  # silently, alongside whatever the user was in the middle of.
  if [ -n "$(git status --porcelain)" ]; then
    echo "error: working tree is not clean. Commit, stash, or discard first:" >&2
    git status --short >&2
    exit 1
  fi
}

# Which unfinished git operation, if any, owns this repository right now.
pending_operation() {
  local gitdir
  gitdir="$(git rev-parse --git-dir)"
  if [ -d "$gitdir/rebase-merge" ] || [ -d "$gitdir/rebase-apply" ]; then
    echo "rebase"
  elif [ -f "$gitdir/MERGE_HEAD" ]; then
    echo "merge"
  elif [ -f "$gitdir/CHERRY_PICK_HEAD" ]; then
    echo "cherry-pick"
  elif [ -f "$gitdir/REVERT_HEAD" ]; then
    echo "revert"
  elif [ -f "$gitdir/BISECT_LOG" ]; then
    echo "bisect"
  else
    echo "none"
  fi
}

# ---------------------------------------------------------------------- --tags --

# Every tag, with the name it was given and what it actually points at.
#
# A repository has two kinds of tag and they print differently, which matters
# here because these names are what the other modes take as arguments:
#
#   lightweight  %(objecttype) is "commit"; the tag is the commit, so
#                %(objectname) is already the commit sha, and %(contents:subject)
#                is the *commit's* subject line.
#   annotated    %(objecttype) is "tag"; %(objectname) is the sha of the tag
#                object, not the commit, and %(contents:subject) is the tag's own
#                message. %(*objectname) peels through to the commit.
#
# So the commit sha comes from %(*objectname) when present and %(objectname)
# otherwise, and the date has to come from %(*committerdate) for the same reason
# — an annotated tag has no %(committerdate) of its own.
cmd_tags() {
  local rows count
  rows="$(git for-each-ref refs/tags --sort=-creatordate \
    --format='%(refname:short)|%(objecttype)|%(objectname:short)|%(*objectname:short)|%(contents:subject)|%(*committerdate:short)|%(creatordate:short)')"

  if [ -z "$rows" ]; then
    echo "no tags in this repository"
    return 0
  fi

  count="$(printf '%s\n' "$rows" | wc -l | tr -d ' ')"
  echo "$count tag(s), newest first:"
  echo

  local name kind obj_sha peeled subject commit_date date
  while IFS='|' read -r name kind obj_sha peeled subject commit_date date; do
    if [ "$kind" = "tag" ]; then
      # Annotated: obj_sha is the tag object, peeled is the commit inside it.
      # The tag's own message is %(contents:subject), and it has no committer
      # date of its own, so the peeled commit supplies the date.
      printf '  %s\n' "$name"
      printf '      %-10s %s  annotated\n' "${peeled:-$obj_sha}" "$date"
      printf '      %s\n' "$subject"
    else
      # Lightweight: the tag *is* the commit, so obj_sha is already the sha and
      # %(contents:subject) is the commit's subject, not a tag message.
      printf '  %s\n' "$name"
      printf '      %-10s %s  lightweight\n' "$obj_sha" "$date"
      printf '      %s\n' "$subject"
    fi
    echo
  done <<<"$rows"
}

# Ask for a tag by number or by name, and return it on stdout. Numbered because
# tag names in this repository are long and hyphenated, and one typo means a
# ref that does not resolve.
# pick_tag and pick_ref are called as `ref="$(pick_tag …)"`, so everything they
# have to say — the numbered list, the prompt, the errors — has to go to stderr.
# Only the chosen value may reach stdout, or it arrives as part of the answer.
pick_tag() {
  local prompt="${1:-Tag}"
  local n
  n="$(git tag -l | wc -l | tr -d ' ')"
  if [ "$n" -eq 0 ]; then
    echo "no tags to choose from" >&2
    return 1
  fi

  local i name
  i=0
  while read -r name; do
    i=$((i + 1))
    printf '  %2d) %s\n' "$i" "$name" >&2
  done < <(git tag -l)

  local answer
  echo >&2
  read -r -p "$prompt [number or name, empty to cancel]: " answer || answer=""
  [ -n "$answer" ] || return 1

  if [[ "$answer" =~ ^[0-9]+$ ]]; then
    name="$(git tag -l | sed -n "${answer}p")"
    [ -n "$name" ] || { echo "no tag number $answer" >&2; return 1; }
    printf '%s\n' "$name"
    return 0
  fi

  if git rev-parse --verify --quiet "refs/tags/$answer" >/dev/null; then
    printf '%s\n' "$answer"
    return 0
  fi

  echo "not a tag: $answer" >&2
  return 1
}

# Ask for any revision: a tag from the numbered list, a recent commit from the
# log, or anything git understands typed in full.
pick_ref() {
  local prompt="${1:-Base commit}"
  local recent depth
  depth="${2:-10}"
  recent="$(git log --oneline -"$depth")"

  {
    echo "Recent commits — keep the numbered one and everything above it:"
    echo
  } >&2

  local n i line
  n="$(printf '%s\n' "$recent" | grep -c . || true)"
  i=0
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    i=$((i + 1))
    printf '  %2d) %s\n' "$i" "$line" >&2
  done <<<"$recent"

  local tags
  tags="$(git tag -l | tr '\n' ' ')"
  if [ -n "$tags" ]; then
    {
      echo
      echo "Tags: $tags"
    } >&2
  fi

  local answer
  echo >&2
  read -r -p "$prompt [number, ref, or empty to cancel]: " answer || answer=""
  [ -n "$answer" ] || return 1

  if [[ "$answer" =~ ^[0-9]+$ ]]; then
    if [ "$answer" -lt 1 ] || [ "$answer" -gt "$n" ]; then
      echo "no commit number $answer" >&2
      return 1
    fi
    # Resolve through HEAD~ so the answer is stable even if HEAD moves while
    # this runs, and hand back the short sha rather than the log line.
    git rev-parse --short "HEAD~$((answer - 1))"
    return 0
  fi

  if ! git rev-parse --verify --quiet "$answer^{commit}" >/dev/null; then
    echo "not something git can resolve: $answer" >&2
    return 1
  fi
  printf '%s\n' "$answer"
}

# ------------------------------------------------------------------- --status --

cmd_status() {
  local op behind ahead
  op="$(pending_operation)"
  echo "repository: $(pwd)"
  echo "branch:     $(git rev-parse --abbrev-ref HEAD)  @ $(git rev-parse --short HEAD)"
  echo

  if [ "$op" = "none" ]; then
    echo "operation:  none in progress"
  else
    echo "operation:  $op IN PROGRESS"
    local unmerged
    unmerged="$(git diff --name-only --diff-filter=U | wc -l | tr -d ' ')"
    echo "            $unmerged file(s) still conflicted — $SELF --conflicts"
    echo "            $SELF --abort to back out of it"
  fi
  echo

  if [ -n "$(git status --porcelain)" ]; then
    echo "working tree: dirty"
    git status --short | sed 's/^/  /'
  else
    echo "working tree: clean"
  fi
  echo

  local upstream
  upstream="$(git rev-parse --abbrev-ref '@{u}' 2>/dev/null || true)"
  if [ -z "$upstream" ]; then
    echo "upstream:    none configured (nothing to compare against, nothing to push to)"
  else
    read -r behind ahead <<<"$(git rev-list --left-right --count "$upstream...HEAD")"
    echo "upstream:    $upstream  ($behind behind, $ahead ahead)"
    if [ "$behind" -gt 0 ] && [ "$ahead" -gt 0 ]; then
      echo "            DIVERGED — a plain push will be rejected. Either"
      echo "            $SELF --restore and redo, or fetch and reconcile by hand."
    elif [ "$behind" -gt 0 ]; then
      echo "            origin has $behind commit(s) this branch lacks. A force-push"
      echo "            would discard them, so --push will refuse until they are"
      echo "            reconciled by hand."
    fi
  fi
}

# ----------------------------------------------------------------- --conflicts --

cmd_conflicts() {
  local files count
  files="$(git diff --name-only --diff-filter=U)"
  if [ -z "$files" ]; then
    echo "no conflicted files"
    local op
    op="$(pending_operation)"
    [ "$op" = "none" ] || echo "($op is in progress but has no unresolved conflicts — $SELF --abort to back out)"
    return 0
  fi

  count="$(printf '%s\n' "$files" | wc -l | tr -d ' ')"
  echo "$count conflicted file(s):"
  echo

  local f markers
  while IFS= read -r f; do
    echo "  $f"
    if [ ! -f "$f" ]; then
      echo "    (deleted in one side)"
      continue
    fi
    # The marker lines, so the shape of the disagreement is visible without
    # opening every file.
    markers="$(grep -nE '^(<<<<<<<|=======|>>>>>>>|\|\|\|\|\|\|\|)' "$f" 2>/dev/null || true)"
    if [ -n "$markers" ]; then
      printf '%s\n' "$markers" | sed 's/^/    /'
    else
      echo "    (no textual markers — check the file, it may be a binary or a rename)"
    fi
    local stages
    stages="$(git ls-files -u -- "$f" | wc -l | tr -d ' ')"
    if [ "$stages" -gt 0 ]; then
      echo "    ($stages unmerged index stage(s))"
    fi
    echo
  done <<<"$files"

  # Unquoted heredoc: $SELF is meant to expand. <file> is left literal on purpose —
  # the names above are the real ones, this is the shape of the command.
  cat <<HOWTO
To settle one by hand: edit the file, then
  git add <file>
When everything is staged:
  git commit            (after a merge)
  git rebase --continue (after a rebase)
Or back the whole thing out:
  $SELF --abort
HOWTO
}

# --------------------------------------------------------------------- --abort --

cmd_abort() {
  local op
  op="$(pending_operation)"
  case "$op" in
    none) echo "nothing to abort: no merge, rebase, cherry-pick or revert in progress"; return 0 ;;
    rebase) git rebase --abort ;;
    merge) git merge --abort ;;
    cherry-pick) git cherry-pick --abort ;;
    revert) git revert --abort ;;
    bisect) git bisect reset ;;
  esac
  echo "aborted $op"
  echo "HEAD is now $(git rev-parse --short HEAD)"
}

# ------------------------------------------------------------------- --restore --

cmd_restore() {
  local ref="$BASE"
  if ! git rev-parse --verify --quiet "$ref^{commit}" >/dev/null; then
    echo "error: '$ref' is not a commit in this repository" >&2
    exit 1
  fi
  local target
  target="$(git rev-parse "$ref^{commit}")"
  local current
  current="$(git rev-parse HEAD)"

  if [ "$target" = "$current" ]; then
    echo "HEAD is already $ref ($(git rev-parse --short HEAD))"
    return 0
  fi

  echo "Going back to $ref — $(git log -1 --format='%s' "$target")"
  echo "  from  $(git rev-parse --short HEAD)  $(git log -1 --format='%s' HEAD)"
  echo
  echo "This is reset --hard: the working tree becomes exactly $ref, and any"
  echo "uncommitted work in it is gone."
  echo
  confirm "Proceed?" || { echo "aborted"; exit 1; }

  if [ -n "$(git status --porcelain)" ]; then
    local stash
    stash="restore-$(git rev-parse --short HEAD)"
    git stash push --include-untracked -m "$stash: before $SELF --restore" >/dev/null
    echo "uncommitted work stashed as '$stash'"
  fi

  git reset --hard "$target" >/dev/null
  echo
  echo "restored to $(git rev-parse --short HEAD)"
  echo "stashed work, if any: git stash list"
}

# --------------------------------------------------------------------- --squash --

# Publish the current HEAD over <remote>/<branch> with --force-with-lease,
# refusing when origin holds a commit this branch does not include.
#
# $1 is the commit the rewrite was based on — the pre-rewrite HEAD. It has to be
# passed explicitly for a separate --publish, because once the rewrite has
# happened origin/main is genuinely no longer an ancestor of HEAD, so HEAD itself
# cannot answer "is origin somewhere I left off?". The safety tag from the squash
# is exactly the right value: it is the commit the rewrite replaced.
publish_branch() {
  local rewrite_from="${1:-HEAD}"

  local upstream
  upstream="$(git rev-parse --abbrev-ref '@{u}' 2>/dev/null || true)"
  if [ -z "$upstream" ]; then
    echo "no upstream configured — nothing to push."
    return 0
  fi

  # `git push <repo> <branch>` — the upstream is "origin/main", which as a
  # single argument would name a *repository* called origin/main. Split it.
  local remote branch remote_sha
  remote="${upstream%%/*}"
  branch="${upstream#*/}"

  # Only force-push when everything on origin is already included in what this
  # branch had before the rewrite.
  #
  # The test is ancestry, not equality: our own unpushed commits make
  # rewrite_from a descendant of origin, which is the normal case and is
  # perfectly safe. What must not happen is origin holding a commit the rewrite
  # does not include — that commit would be discarded.
  #
  # --force-with-lease cannot do this job. It compares against the remote-tracking
  # ref, which `git fetch` updates, so someone else's commit that has already been
  # fetched makes the lease pass and the force-push then throws it away. That is
  # not hypothetical; it is what the first version of this script did.
  remote_sha="$(git rev-parse "$remote/$branch")"
  if ! git merge-base --is-ancestor "$remote_sha" "$rewrite_from"; then
    local lost
    lost="$(git rev-list --count "HEAD..$remote_sha")"
    echo "not pushing: $remote/$branch has $lost commit(s) this rewrite does not"
    echo "include, and force-pushing would discard them."
    echo
    echo "  rewriting from $(git rev-parse --short "$rewrite_from")"
    echo "  origin has      $(git rev-parse --short "$remote_sha")"
    if git merge-base --is-ancestor "$rewrite_from" "$remote_sha"; then
      echo
      echo "They sit on top of the commit we rewrote — someone pushed after we"
      echo "did. Take their commits first:"
      echo "  git rebase $remote/$branch"
    else
      echo
      echo "They are on a different line than ours, not on top of it. This branch"
      echo "and origin have diverged, and that has to be reconciled by hand before"
      echo "history can be rewritten at all."
    fi
    echo
    echo "The rewrite itself is intact locally:"
    echo "  git log --oneline $remote/$branch ^HEAD    what origin has that we do not"
    echo "  $SELF --restore <ref>                       to undo the rewrite entirely"
    return 1
  fi

  echo "pushing $branch to $remote with --force-with-lease…"
  # Still --force-with-lease, not --force: it closes the window between the check
  # above and the push actually landing.
  if git push --force-with-lease "$remote" "$branch"; then
    echo "pushed."
  else
    echo
    echo "push refused — origin moved between the check and the push."
    echo "$SELF --status to see how far apart the two are."
    return 1
  fi
}

cmd_publish() {
  local op
  op="$(pending_operation)"
  if [ "$op" != "none" ]; then
    echo "error: $op is in progress. Finish it ($SELF --abort) first." >&2
    exit 1
  fi

  if ! git rev-parse --verify --quiet "$BASE^{commit}" >/dev/null; then
    echo "error: '$BASE' is not a commit in this repository" >&2
    exit 1
  fi

  echo "Publishing HEAD $(git rev-parse --short HEAD), on the authority of"
  echo "$(git rev-parse --short "$BASE")  $(git log -1 --format='%s' "$BASE")"
  echo
  confirm "Proceed?" || { echo "aborted"; exit 1; }
  publish_branch "$BASE"
}

cmd_squash() {
  if [ -z "$BASE" ]; then
    echo "error: no base commit given." >&2
    echo "       $SELF <base-commit>   or run $SELF for the menu." >&2
    return 2
  fi

  local op
  op="$(pending_operation)"
  if [ "$op" != "none" ]; then
    echo "error: $op is in progress. Finish it ($SELF --abort) or commit it first." >&2
    exit 1
  fi

  if ! git rev-parse --verify --quiet "$BASE^{commit}" >/dev/null; then
    echo "error: '$BASE' is not a commit in this repository" >&2
    exit 1
  fi
  local base_sha
  base_sha="$(git rev-parse "$BASE^{commit}")"

  # A base that is not an ancestor of HEAD means reset --soft would take the
  # whole branch somewhere else and drop every commit in between. That is not a
  # squash, and it is not something to do by accident.
  if ! git merge-base --is-ancestor "$base_sha" HEAD; then
    echo "error: $BASE is not an ancestor of HEAD — that would rewrite the branch," >&2
    echo "       not squash it. Pick a commit that is on this branch." >&2
    exit 1
  fi

  local fold_count
  fold_count="$(git rev-list --count "$base_sha..HEAD")"
  if [ "$fold_count" -eq 0 ]; then
    echo "nothing to fold: HEAD is already $BASE"
    return 0
  fi

  require_clean_tree

  local tree_before
  tree_before="$(git rev-parse --short HEAD^{tree})"

  # Remembered before the rewrite so the publish step can tell a pure history
  # edit from someone else's work sitting on origin.
  local rewrite_from
  rewrite_from="$(git rev-parse HEAD)"

  echo "Squashing $fold_count commit(s) after $BASE into one:"
  echo
  git log --oneline --reverse "$base_sha..HEAD" | sed 's/^/  /'
  echo
  echo "Tree $tree_before before and after: no change is lost, only the steps between."
  echo "Base stays at $(git rev-parse --short "$base_sha")."

  if [ "$DRY_RUN" -eq 1 ]; then
    echo
    echo "--dry-run: nothing changed."
    return 0
  fi

  echo
  confirm "Proceed?" || { echo "aborted"; exit 1; }

  if [ -n "$SAFETY_TAG" ]; then
    if git rev-parse --verify --quiet "refs/tags/$SAFETY_TAG" >/dev/null; then
      echo "error: tag '$SAFETY_TAG' already exists — pick another name" >&2
      exit 1
    fi
    git tag "$SAFETY_TAG"
    echo "safety tag: $SAFETY_TAG -> $(git rev-parse --short HEAD)"
  fi

  # --soft moves HEAD and leaves both the index and the working tree alone, so
  # everything after <base> collapses into whatever is staged — which is the tree
  # we already had.
  git reset --soft "$base_sha"

  if [ -z "$MESSAGE" ]; then
    MESSAGE="$(printf 'Squash %s commits after %s into one' "$fold_count" "$(git rev-parse --short "$base_sha")")"
  fi

  git commit -m "$MESSAGE" >/dev/null

  local tree_after
  tree_after="$(git rev-parse --short HEAD^{tree})"
  echo
  echo "done. $(git rev-parse --short HEAD)  $MESSAGE"
  echo "tree:   $tree_after"
  if [ "$tree_before" != "$tree_after" ]; then
    echo "WARNING: tree changed from $tree_before to $tree_after — this should not happen."
  fi

  # ------------------------------------------------------------------ publish --
  if [ "$PUSH" -eq 1 ]; then
    echo
    publish_branch "$rewrite_from"
  else
    echo
    echo "History rewritten locally."
    if [ -n "$SAFETY_TAG" ]; then
      echo
      echo "  safety tag: $SAFETY_TAG  →  $(git rev-parse --short "$SAFETY_TAG")"
      echo "  undo:       $SELF --restore $SAFETY_TAG"
      echo "  publish:    $SELF --publish $SAFETY_TAG"
    fi
    echo
    echo "Nothing was pushed. Publishing means discarding these old commits on"
    echo "origin, so it is a separate, deliberate step."
  fi
}

# ------------------------------------------------------------------------ menu --

# The menu only decides *what* to do; it then runs exactly the same functions
# the flags run, so there is one implementation of every action and no way for
# the interactive and scripted paths to drift apart.
menu() {
  while :; do
    local op
    op="$(pending_operation)"
    local behind ahead
    behind=0
    ahead=0
    local upstream
    upstream="$(git rev-parse --abbrev-ref '@{u}' 2>/dev/null || true)"
    [ -n "$upstream" ] && read -r behind ahead <<<"$(git rev-list --left-right --count "$upstream...HEAD")"

    cat <<MENU
────────────────────────────────────────────────────────────
$SELF   $(git rev-parse --abbrev-ref HEAD) @ $(git rev-parse --short HEAD)
$upstream $( [ -n "$upstream" ] && printf '(%s behind, %s ahead)' "$behind" "$ahead" || printf '(none)' )
operation: $op$( [ "$op" = "none" ] || printf '  ← unfinished, abort or finish it' )
────────────────────────────────────────────────────────────

  1) Status       what is in progress, and how far from origin
  2) Tags         every tag: its name and what it points at
  3) Conflicts    conflicted files, with their marker lines
  4) Abort        abort an unfinished merge / rebase / cherry-pick
  5) Squash       fold every commit after a point into one
  6) Restore      go back to a chosen tag, hard
  7) Publish      push HEAD, given the ref the rewrite replaced
  8) Quit

MENU

    local choice
    # Ctrl-D ends input, and so does a closed terminal; either way, leave rather
    # than spin on a read that will never return anything.
    read -r -p "Choose [1-8]: " choice || { echo; echo "no input — leaving"; return 0; }
    echo

    case "$choice" in
      # Read-only views exit non-zero on purpose (an unfinished operation, an
      # absent tag) and some of them call `exit 1`. Nothing may kill the menu, so
      # each one runs in a subshell and the menu carries on regardless.
      1) ( cmd_status ) || true; echo ;;
      2) ( cmd_tags ) || true; echo ;;
      3) ( cmd_conflicts ) || true; echo ;;
      4) ( cmd_abort ) || true; echo ;;
      5)
        local base
        if ! base="$(pick_ref "Fold everything after which point?" 12)"; then
          echo "cancelled"; echo; continue
        fi
        # A squash from the menu always leaves a safety tag: the point of an
        # interactive rewrite is that you can look at it before publishing.
        local tag_name
        tag_name="pre-$(date +%y%m%d-%H%M%S)"
        while git rev-parse --verify --quiet "refs/tags/$tag_name" >/dev/null; do
          tag_name="${tag_name}x"
        done
        local message
        read -r -p "Commit message (empty for a generated one): " message || message=""
        echo
        SAFETY_TAG="$tag_name"
        PUSH=0
        BASE="$base"
        MESSAGE="$message"
        # Subshell: cmd_squash ends in `exit 1` when it refuses, and that must
        # land back at the menu rather than closing it.
        ( cmd_squash ) || true
        unset SAFETY_TAG PUSH BASE MESSAGE
        echo ;;
      6)
        local ref
        if ! ref="$(pick_tag "Restore to which tag?")"; then
          echo "cancelled"; echo; continue
        fi
        ( cmd_restore_one "$ref" ) || true
        echo ;;
      7)
        local ref
        if ! ref="$(pick_tag "Publish — which ref did the rewrite replace?")"; then
          echo "cancelled"; echo; continue
        fi
        ( cmd_publish_one "$ref" ) || true
        echo ;;
      8|q|quit|exit) echo "bye"; return 0 ;;
      "") ;;   # just Enter — redraw
      *) echo "not one of 1-8"; echo ;;
    esac
  done
}

# cmd_restore / cmd_publish read $BASE, which the flag path sets from argv. The
# menu assigns it directly instead of prefixing the call: a temporary assignment
# on a function call is not reliably scoped in every shell, and the menu is not
# re-entrant anyway.
cmd_restore_one() {
  BASE="$1"
  cmd_restore
}

cmd_publish_one() {
  BASE="$1"
  cmd_publish
}

# ---------------------------------------------------------------------- dispatch --

case "$MODE" in
  menu)      menu ;;
  status)    cmd_status ;;
  tags)      cmd_tags ;;
  conflicts) cmd_conflicts ;;
  abort)     cmd_abort ;;
  restore)   cmd_restore ;;
  publish)   cmd_publish ;;
  squash)    cmd_squash ;;
esac
