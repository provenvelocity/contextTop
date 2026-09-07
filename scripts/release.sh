#!/usr/bin/env bash
# Release helper: bump the version everywhere, run the CI-parity checks, then
# commit, tag, and push. Pushing the tag triggers .github/workflows/release.yml,
# which builds the per-platform VSIX + engine and publishes a GitHub Release.
#
#   scripts/release.sh 0.1.3
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${1:-}"
if [[ -z "$VERSION" ]]; then
  echo "usage: scripts/release.sh <version>   (e.g. scripts/release.sh 0.1.3)" >&2
  exit 1
fi
VERSION="${VERSION#v}"
TAG="v${VERSION}"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "working tree is not clean; commit or stash first" >&2
  exit 1
fi
if git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null; then
  echo "tag ${TAG} already exists" >&2
  exit 1
fi

echo "==> Bumping version to ${VERSION}"
# Workspace crate version (root Cargo.toml has the single top-level `version = ...`).
perl -0pi -e 's/^version = "[^"]*"/version = "'"$VERSION"'"/m' Cargo.toml
# Extension manifest version.
node -e "const f='apps/vscode/package.json',j=require('./'+f);j.version='$VERSION';require('fs').writeFileSync(f,JSON.stringify(j,null,2)+'\n')"

echo "==> Validating (CI parity)"
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
npm --prefix apps/vscode run compile
python3 scripts/check-docs.py

echo "==> Commit, tag, push"
git add -A
git commit -m "release: ${TAG}"
git tag -a "${TAG}" -m "contextTop ${TAG}"
git push origin main --follow-tags

echo "==> Released ${TAG}. release.yml will build and attach the VSIX + engine artifacts."
