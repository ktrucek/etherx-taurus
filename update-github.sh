#!/usr/bin/env bash
set -euo pipefail

# One-command GitHub update helper.
# Usage:
#   bash ./update-github.sh
#   bash ./update-github.sh "moja poruka commita"
#   GIT_REMOTE=origin GIT_BRANCH=main bash ./update-github.sh "update"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$REPO_ROOT" ]]; then
  echo "[error] Ovaj folder nije git repo."
  exit 1
fi

PROJECT_PATH="$(realpath --relative-to="$REPO_ROOT" "$SCRIPT_DIR")"
if [[ "$PROJECT_PATH" == "." ]]; then
  PROJECT_PATH=""
fi

REMOTE="${GIT_REMOTE:-origin}"
BRANCH="${GIT_BRANCH:-$(git branch --show-current 2>/dev/null || true)}"
COMMIT_MSG="${1:-update: $(date '+%Y-%m-%d %H:%M:%S')}"

if [[ -z "$BRANCH" ]]; then
  BRANCH="main"
fi

if ! git remote get-url "$REMOTE" >/dev/null 2>&1; then
  echo "[error] Remote '$REMOTE' ne postoji."
  echo "Dostupni remote-i:"
  git remote -v || true
  exit 1
fi

echo "[update-github] Remote: $REMOTE"
echo "[update-github] Branch: $BRANCH"
if [[ -n "$PROJECT_PATH" ]]; then
  echo "[update-github] Path:   $PROJECT_PATH"
else
  echo "[update-github] Path:   ."
fi

# Stage only this project directory to avoid accidentally committing sibling folders.
if [[ -n "$PROJECT_PATH" ]]; then
  git -C "$REPO_ROOT" add -A -- "$PROJECT_PATH"
else
  git -C "$REPO_ROOT" add -A
fi

if git diff --cached --quiet; then
  echo "[update-github] Nema lokalnih izmjena za commit."
else
  git commit -m "$COMMIT_MSG"
  echo "[ok] Commit napravljen."
fi

# Rebase before push to avoid non-fast-forward errors when possible.
git pull --rebase "$REMOTE" "$BRANCH"

if ! git push "$REMOTE" "$BRANCH"; then
  echo "[error] Push nije uspio." >&2
  echo "[hint] Provjeri da li je repo archived/read-only ili je token istekao." >&2
  echo "[hint] Ako je repo archived na GitHub-u, unarchive pa ponovi komandu." >&2
  exit 1
fi

echo "[ok] GitHub update zavrsen ($REMOTE/$BRANCH)."
