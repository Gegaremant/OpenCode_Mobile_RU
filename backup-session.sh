#!/usr/bin/env bash
# Backup the opencode session for this project as Markdown + YAML.
#
#   ./backup-session.sh              current session (most recent here)
#   ./backup-session.sh --all        every session rooted at this directory
#   ./backup-session.sh --session ID one specific session
#   ./backup-session.sh --out-dir DIR write elsewhere (default: next to this script)
#
# Produces two files per session, next to this script:
#
#   yy-mm-dd_<name>_session.md     readable transcript
#   yy-mm-dd_<name>_session.yaml   structured data
#
# The date comes from the session's own creation time, not from now, so
# re-running this on the same session overwrites the same two files instead of
# accumulating copies.
#
# Reads the running server through `opencode api`, so authentication and
# service discovery are the CLI's own — no password or URL to pass in.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v opencode >/dev/null 2>&1; then
  echo "error: 'opencode' not found in PATH" >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "error: python3 not found in PATH" >&2
  exit 1
fi

# Always operate from the directory this script lives in, so "this project"
# means the same thing no matter where it is invoked from.
cd "$HERE"

OUT_DIR="$HERE"
ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --out-dir)
      [ $# -ge 2 ] || { echo "error: --out-dir needs a value" >&2; exit 1; }
      OUT_DIR="$2"; shift 2 ;;
    --out-dir=*)
      OUT_DIR="${1#*=}"; shift ;;
    --all|--session)
      ARGS+=("$1")
      if [ "$1" = "--session" ]; then
        [ $# -ge 2 ] || { echo "error: --session needs an id" >&2; exit 1; }
        ARGS+=("$2"); shift 2
      else
        shift
      fi ;;
    -h|--help)
      sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *)
      echo "error: unknown argument: $1" >&2
      exit 1 ;;
  esac
done

mkdir -p "$OUT_DIR"

exec python3 "$HERE/scripts/session-export.py" --out-dir "$OUT_DIR" ${ARGS[@]+"${ARGS[@]}"}