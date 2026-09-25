#!/bin/sh
# Builds the throwaway branch ms/features: main with the given feature branches merged
# in, then rebuilds and restarts the game. Run it again whenever a feature changes.
# Fix bugs on the feature branches, never on ms/features.
#
#   scripts/integrate.sh feat/ms/a feat/ms/b
set -e

if [ $# -eq 0 ]; then
  echo "usage: $0 <branch>..." >&2
  exit 1
fi
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "Commit or stash your changes first." >&2
  exit 1
fi

git config rerere.enabled true # replay earlier conflict resolutions
git checkout -B ms/features main
# One at a time: a single multi-branch merge gives up on the first conflict. When one
# stops, resolve it, `git commit`, then run the script again (rerere remembers the fix).
for branch in "$@"; do
  git merge --no-edit "$branch"
done
docker compose up -d --build
