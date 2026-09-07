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
#
# SemVer release automation (Conventional Commits):
#   If the commit subject is a `feat:` or a breaking change (`feat!:` / a
#   `BREAKING CHANGE` footer), push.sh cuts a release after pushing — it bumps the
#   version (0.x-aware: breaking is capped at a MINOR bump below 1.0.0), tags, and
#   creates a GitHub Release with generated notes. `fix:` only releases when forced.
#   Flags:
#     --release            # force a release even for fix/chore (defaults to PATCH)
#     --release=LEVEL      # force a specific bump: patch | minor | major
#     --no-release         # never release, even for feat/breaking
#   Only releases from the `main` branch. Requires `gh` for the GitHub Release.
set -euo pipefail
cd "$(dirname "$0")"

RELEASE_MODE=auto   # auto | force | off
FORCE_LEVEL=""      # patch | minor | major (from --release=LEVEL)
ARGS=()
for a in "$@"; do
  case "$a" in
    --no-release) RELEASE_MODE=off ;;
    --release) RELEASE_MODE=force ;;
    --release=patch|--release=minor|--release=major)
      RELEASE_MODE=force; FORCE_LEVEL="${a#--release=}" ;;
    --release=*) echo "invalid --release level: ${a#--release=} (use patch|minor|major)" >&2; exit 1 ;;
    *) ARGS+=("$a") ;;
  esac
done
MSG="${ARGS[*]:-}"
RECORD_COMPLETED=1

# No message and nothing changed? Stop before deriving a message from the todos.
if [[ -z "$MSG" && -z "$(git status --porcelain)" ]]; then
  echo "nothing to commit"
  exit 0
fi

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
    # No todos either: summarize the changed files so a message is never required.
    CHANGED="$(git status --porcelain | sed 's/^...//' | head -5 | paste -sd, -)"
    if [[ -z "$CHANGED" ]]; then
      echo "nothing to commit"
      exit 0
    fi
    MSG="chore: update ${CHANGED}"
    echo "message from changes: ${MSG}"
  else
    SUBJECT="$(printf '%s\n' "$TODOS" | head -1)"
    if [[ "$(printf '%s\n' "$TODOS" | grep -c .)" -gt 1 ]]; then
      MSG="$SUBJECT"$'\n\n'"$(printf '%s\n' "$TODOS" | sed 's/^/- /')"
    else
      MSG="$SUBJECT"
    fi
    echo "message from TODO: ${SUBJECT}"
  fi
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

# --- SemVer release automation (Conventional Commits) ---------------------------
# Decide the bump from the commit subject, unless overridden by flags.
SUBJECT="$(printf '%s\n' "$MSG" | head -1)"
level=none
if printf '%s' "$MSG" | grep -q 'BREAKING CHANGE'; then
  level=major
elif printf '%s' "$SUBJECT" | grep -Eq '^[a-z]+(\([^)]*\))?!:'; then
  level=major
elif printf '%s' "$SUBJECT" | grep -Eq '^feat(\([^)]*\))?:'; then
  level=minor
elif printf '%s' "$SUBJECT" | grep -Eq '^(fix|perf)(\([^)]*\))?:'; then
  level=patch
fi

# Flags override the detected level.
[[ -n "$FORCE_LEVEL" ]] && level="$FORCE_LEVEL"
[[ "$RELEASE_MODE" == "force" && "$level" == "none" ]] && level=patch
[[ "$RELEASE_MODE" == "off" ]] && level=none

# Auto mode only releases on a "big enough" change (minor/major); force releases any.
do_release=0
case "$RELEASE_MODE" in
  force) [[ "$level" != "none" ]] && do_release=1 ;;
  auto)  [[ "$level" == "minor" || "$level" == "major" ]] && do_release=1 ;;
esac

if [[ "$do_release" -eq 1 ]]; then
  BRANCH="$(git rev-parse --abbrev-ref HEAD)"
  if [[ "$BRANCH" != "main" ]]; then
    echo "release skipped: not on main (on ${BRANCH})"
  else
    # Base the next version on the latest tag, not the (possibly stale) version files.
    LATEST="$(git tag -l 'v[0-9]*' | sort -V | tail -1)"
    CUR="${LATEST#v}"; CUR="${CUR:-0.0.0}"
    IFS=. read -r MA MI PA <<<"$CUR"
    case "$level" in
      major)
        if [[ "$MA" -eq 0 && "$FORCE_LEVEL" != "major" ]]; then
          echo "pre-1.0: capping breaking change at a MINOR bump (0.x)"
          MI=$((MI + 1)); PA=0
        else
          MA=$((MA + 1)); MI=0; PA=0
        fi ;;
      minor) MI=$((MI + 1)); PA=0 ;;
      patch) PA=$((PA + 1)) ;;
    esac
    NEXT="${MA}.${MI}.${PA}"
    echo "==> Releasing v${NEXT} (bump: ${level}, from ${LATEST:-none})"
    scripts/release.sh "$NEXT"
    if command -v gh >/dev/null 2>&1; then
      if gh release view "v${NEXT}" >/dev/null 2>&1; then
        echo "release v${NEXT} already exists; leaving it for CI to attach assets"
      else
        gh release create "v${NEXT}" --title "v${NEXT}" --generate-notes
        echo "created GitHub Release v${NEXT} (binaries attach when CI runs)"
      fi
    else
      echo "gh not found: tag pushed; release.yml will publish when a runner is available"
    fi
  fi
fi

