#!/usr/bin/env bash
# Commit and push as one unit, recording the work in TASKS.md.
#
# The message you pass becomes both the git commit message AND a dated entry at the
# top of `## Completed` in TASKS.md — so the TODO update ships with the code that
# fulfilled it, in a single commit.
#
#   ./push.sh "Short title — what changed"
set -euo pipefail
cd "$(dirname "$0")"

MSG="${*:-}"
if [[ -z "$MSG" ]]; then
  echo "usage: ./push.sh \"Short title — what changed\"" >&2
  exit 1
fi

DATE="$(date +%F)"
ENTRY="- [x] ${DATE} — ${MSG}"

# 1. Record the TODO update: insert the entry as the newest `## Completed` line,
#    unless this exact message is already recorded.
if [[ -f TASKS.md ]] && ! grep -Fq "$MSG" TASKS.md; then
  awk -v entry="$ENTRY" '
    /^## Completed[[:space:]]*$/ { print; in_completed = 1; next }
    in_completed && /^[[:space:]]*$/ { print; print entry; in_completed = 0; next }
    { print }
  ' TASKS.md > TASKS.md.tmp && mv TASKS.md.tmp TASKS.md
  echo "TASKS.md: recorded \"$MSG\""
fi

# 2. Stage code + the TASKS.md update and commit them as one unit.
git add -A
if git diff --cached --quiet; then
  echo "nothing to commit"
  exit 0
fi
git commit -m "$MSG"

# 3. Push the current branch.
git push origin "$(git rev-parse --abbrev-ref HEAD)"
