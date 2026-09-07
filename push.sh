#!/usr/bin/env bash
# Commit and push as one unit, tied to TASKS.md.
#
# Two modes:
#   ./push.sh                         # message is built from the `## In Progress` TODO
#                                     # statements (their bold titles) — checkpoints the
#                                     # current work under those todos.
#   ./push.sh "Title — what changed"  # explicit message; also recorded as a dated
#                                     # `## Completed` entry so the TODO update ships too.
#
# Either way, the code plus any TASKS.md change are committed together, then pushed.
set -euo pipefail
cd "$(dirname "$0")"

MSG="${*:-}"
RECORD_COMPLETED=1

if [[ -z "$MSG" ]]; then
  # No message: derive one from the `## In Progress` TODO statements.
  RECORD_COMPLETED=0
  TODOS="$(awk '
    /^## In Progress[[:space:]]*$/ { grab = 1; next }
    /^## / { grab = 0 }
    grab && /^- \[ \]/ {
      if (match($0, /\*\*[^*]+\*\*/)) {
        print substr($0, RSTART + 2, RLENGTH - 4)
      } else {
        line = $0; sub(/^- \[ \][^ ]* /, "", line); print line
      }
    }
  ' TASKS.md)"
  if [[ -z "$TODOS" ]]; then
    echo "no message given and no ## In Progress items to derive one from" >&2
    exit 1
  fi
  SUBJECT="$(printf '%s\n' "$TODOS" | head -1)"
  if [[ "$(printf '%s\n' "$TODOS" | grep -c .)" -gt 1 ]]; then
    MSG="$SUBJECT"$'\n\n'"$(printf '%s\n' "$TODOS" | sed 's/^/- /')"
  else
    MSG="$SUBJECT"
  fi
  echo "message from TODO: ${SUBJECT}"
fi

DATE="$(date +%F)"

# Explicit-message mode records the work at the top of `## Completed` (unless already there).
if [[ "$RECORD_COMPLETED" -eq 1 && -f TASKS.md ]] && ! grep -Fq "$MSG" TASKS.md; then
  awk -v entry="- [x] ${DATE} — ${MSG}" '
    /^## Completed[[:space:]]*$/ { print; in_completed = 1; next }
    in_completed && /^[[:space:]]*$/ { print; print entry; in_completed = 0; next }
    { print }
  ' TASKS.md > TASKS.md.tmp && mv TASKS.md.tmp TASKS.md
  echo "TASKS.md: recorded \"$MSG\""
fi

# Stage code + any TASKS.md update and commit them as one unit, then push.
git add -A
if git diff --cached --quiet; then
  echo "nothing to commit"
  exit 0
fi
git commit -m "$MSG"
git push origin "$(git rev-parse --abbrev-ref HEAD)"

