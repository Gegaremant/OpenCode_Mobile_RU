#!/usr/bin/env bash
# Fix git history and clean up the conflicts that fixing it leaves behind.
#
#   ./squash-history.sh                        show recent history, change nothing
#   ./squash-history.sh <base>                 what would be folded into <base>
#   ./squash-history.sh <base> -m "…"          fold it, for real
#   ./squash-history.sh <base> -m "…" --tag t  fold it, leaving a safety tag at the old HEAD
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
# The squash itself cannot conflict: `git reset --soft` moves HEAD and leaves
# the index and working tree alone. Conflicts come from the neighbours — a merge
# or rebase left half-finished, a rewritten branch that no longer fast-forwards
# against origin, or a rewrite that needs undoing. Those are what --status,
# --conflicts, --abort, --restore and --push are for.
#
# Nothing is pushed unless --push is passed, and even then only when origin is
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

  $SELF <base-commit>              fold every commit after <base> into one
  $SELF <base-commit> -m "…"       with a given commit message
  $SELF <base-commit> --tag <name> leave a safety tag at the current HEAD first
  $SELF <base-commit> --push       publish the rewrite with --force-with-lease

  $SELF --status                   unfinished operation + divergence from origin
  $SELF --conflicts                conflicted files, with their marker lines
  $SELF --abort                    abort an unfinished merge / rebase / cherry-pick
  $SELF --restore <ref>            reset --hard back to a tag or commit
  $SELF --publish <ref>            push HEAD; <ref> is what the rewrite replaced

Options: -m/--message, --tag, --push, -y/--yes, -n/--dry-run
USAGE
}

# ---------------------------------------------------------------- arguments --

MODE="squash"
BASE=""
MESSAGE=""
SAFETY_TAG=""
PUSH=0
ASSUME_YES=0
DRY_RUN=0

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

    --status)    MODE="status"; shift ;;
    --conflicts) MODE="conflicts"; shift ;;
    --abort)     MODE="abort"; shift ;;
    --publish)
      MODE="publish"
      [ $# -ge 2 ] || { echo "error: --publish needs the ref the rewrite started from" >&2; exit 1; }
      BASE="$2"; shift 2 ;;
    --publish=*) MODE="publish"; BASE="${1#*=}"; shift ;;
    --restore)
      [ $# -ge 2 ] || { echo "error: --restore needs a ref" >&2; exit 1; }
      MODE="restore"; BASE="$2"; shift 2 ;;
    --restore=*) MODE="restore"; BASE="${1#*=}"; shift ;;

    -h|--help) usage; exit 0 ;;
    -*) echo "error: unknown option: $1" >&2; exit 1 ;;
    *)
      [ "$MODE" = "squash" ] || { echo "error: $MODE takes no base commit" >&2; exit 1; }
      [ -z "$BASE" ] || { echo "error: more than one base commit given" >&2; exit 1; }
      BASE="$1"; shift ;;
  esac
done

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
    usage
    echo
    echo "Recent history:"
    git log --oneline -10
    return 0
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
    echo "History rewritten locally. To publish:"
    echo "  $SELF --publish"
    echo "or re-run the squash with --push to do both in one step."
    if [ -n "$SAFETY_TAG" ]; then
      echo "To undo: $SELF --restore $SAFETY_TAG"
    fi
  fi
}

# ---------------------------------------------------------------------- dispatch --

case "$MODE" in
  status)    cmd_status ;;
  conflicts) cmd_conflicts ;;
  abort)     cmd_abort ;;
  restore)   cmd_restore ;;
  publish)   cmd_publish ;;
  squash)    cmd_squash ;;
esac
