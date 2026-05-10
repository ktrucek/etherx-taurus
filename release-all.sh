#!/usr/bin/env bash

# One command release flow:
# 1) bump version (package.json + Cargo.toml)
# 2) commit
# 3) create git tag vX.Y.Z
# 4) push branch + tag
# 5) GitHub Actions release workflow starts automatically on tag push

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

BUMP_TYPE="${1:-patch}"
REMOTE="${GIT_REMOTE:-origin}"
BRANCH="${GIT_BRANCH:-main}"

if [[ ! "$BUMP_TYPE" =~ ^(patch|minor|major)$ ]]; then
  echo "[error] Invalid bump type: $BUMP_TYPE"
  echo "[hint] Usage: bash ./release-all.sh patch|minor|major"
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "[error] jq is required but not installed."
  exit 1
fi

if ! git remote get-url "$REMOTE" >/dev/null 2>&1; then
  echo "[error] Remote '$REMOTE' does not exist."
  exit 1
fi

git fetch "$REMOTE" "$BRANCH"
git pull --rebase "$REMOTE" "$BRANCH"

CURRENT_VERSION="$(jq -r '.version' package.json)"
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_VERSION"

case "$BUMP_TYPE" in
  patch)
    PATCH=$((PATCH + 1))
    ;;
  minor)
    MINOR=$((MINOR + 1))
    PATCH=0
    ;;
  major)
    MAJOR=$((MAJOR + 1))
    MINOR=0
    PATCH=0
    ;;
esac

NEW_VERSION="$MAJOR.$MINOR.$PATCH"
NEW_TAG="v$NEW_VERSION"

echo "[release] Current version: $CURRENT_VERSION"
echo "[release] New version:     $NEW_VERSION"

jq ".version = \"$NEW_VERSION\"" package.json > package.json.tmp
mv package.json.tmp package.json

sed -i "s/^version = .*/version = \"$NEW_VERSION\"/" src-tauri/Cargo.toml

git add package.json src-tauri/Cargo.toml

if git diff --cached --quiet; then
  echo "[error] Nothing changed after version bump."
  exit 1
fi

git commit -m "release: $NEW_TAG"

if git rev-parse "$NEW_TAG" >/dev/null 2>&1; then
  echo "[error] Tag $NEW_TAG already exists locally."
  exit 1
fi

git tag "$NEW_TAG"

git push "$REMOTE" "$BRANCH"
git push "$REMOTE" "$NEW_TAG"

echo "[ok] Release prepared and pushed."
echo "[ok] GitHub Actions will build and publish artifacts for tag: $NEW_TAG"
echo "[link] https://github.com/ktrucek/etherx-taurus/actions"
