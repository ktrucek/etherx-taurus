#!/usr/bin/env bash

# Version bumper for etherx-browser
# Usage: bash bump-version.sh patch|minor|major

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

BUMP_TYPE="${1:-patch}"

if [[ ! "$BUMP_TYPE" =~ ^(patch|minor|major)$ ]]; then
  echo "❌ Invalid bump type: $BUMP_TYPE"
  echo "Usage: bash bump-version.sh patch|minor|major"
  exit 1
fi

# Get current version from package.json
CURRENT_VERSION=$(jq -r '.version' package.json)
echo "📦 Current version: $CURRENT_VERSION"

# Parse semantic version
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
echo "🚀 New version: $NEW_VERSION"

# Update package.json
echo "[1/3] Updating package.json..."
jq ".version = \"$NEW_VERSION\"" package.json > package.json.tmp
mv package.json.tmp package.json

# Update Cargo.toml
echo "[2/3] Updating src-tauri/Cargo.toml..."
if [[ "$OSTYPE" == "darwin"* ]]; then
  sed -i '' "s/^version = .*/version = \"$NEW_VERSION\"/" src-tauri/Cargo.toml
else
  sed -i "s/^version = .*/version = \"$NEW_VERSION\"/" src-tauri/Cargo.toml
fi

# Commit and push
echo "[3/3] Committing and pushing..."
git add package.json src-tauri/Cargo.toml
git commit -m "version: bump to $NEW_VERSION"
git push origin main

echo ""
echo "✅ Version bumped to $NEW_VERSION"
echo ""
echo "📝 Next steps:"
echo "   1. Go to GitHub Actions: https://github.com/ktrucek/ether-taurus/actions"
echo "   2. Click on 'Release and Build' workflow"
echo "   3. Click 'Run workflow' button"
echo "   4. Select version bump type (patch/minor/major)"
echo "   5. Click 'Run workflow'"
echo ""
