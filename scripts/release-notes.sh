#!/usr/bin/env bash
# Assemble a structured changelog between two release tags.
#
#   scripts/release-notes.sh [CUR_TAG] [PREV_TAG]
#
# With no arguments it uses the latest tag as CUR and the tag before it as PREV.
# Output is Markdown on stdout: Conventional-Commit groups plus the TASKS.md
# entries completed in the range. It is deterministic (no network) and is used
# both as the AI prompt input and as the fallback release body when AI is off.
set -euo pipefail
cd "$(dirname "$0")/.."

CUR="${1:-$(git describe --tags --abbrev=0 2>/dev/null || echo "")}"
PREV="${2:-}"
if [[ -z "$PREV" && -n "$CUR" ]]; then
  PREV="$(git describe --tags --abbrev=0 "${CUR}^" 2>/dev/null || echo "")"
fi
RANGE="${PREV:+${PREV}..}${CUR:-HEAD}"

# Emit a section for one Conventional-Commit type group, if it has any commits.
emit() {
  local label="$1" pattern="$2" body
  body="$(git log --no-merges --pretty='%s' "$RANGE" 2>/dev/null \
    | grep -E "$pattern" \
    | sed -E 's/^[a-z]+(\([^)]*\))?!?: //' \
    | sed 's/^/- /' || true)"
  if [[ -n "$body" ]]; then
    printf '### %s\n\n%s\n\n' "$label" "$body"
  fi
}

emit "Features"  '^feat(\([^)]*\))?!?:'
emit "Fixes"     '^(fix|perf)(\([^)]*\))?!?:'
emit "Docs"      '^docs(\([^)]*\))?!?:'
emit "Internal"  '^(chore|refactor|ci|build|test|style)(\([^)]*\))?!?:'

# Completed TASKS.md items added in this range (strip the "- [x] DATE — " prefix).
if [[ -n "$PREV" ]]; then
  tasks="$(git diff "$RANGE" -- TASKS.md 2>/dev/null \
    | grep -E '^\+.*- \[x\]' \
    | sed -E 's/^\+//' \
    | sed -E 's/^- \[x\] [0-9]{4}-[0-9]{2}-[0-9]{2} — /- /' || true)"
  if [[ -n "$tasks" ]]; then
    printf '### Completed tasks\n\n%s\n\n' "$tasks"
  fi
fi

printf '**Full range:** `%s`\n' "$RANGE"
