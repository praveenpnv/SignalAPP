#!/usr/bin/env bash
# Publish SIGNALS to a GitHub repo and print the Pages URL.
#
#   ./publish.sh praveenpnv/signals
#   ./publish.sh https://github.com/praveenpnv/signals.git
#
# The repo must already exist on GitHub and be PUBLIC for the resulting
# link to work for anyone. Everything needed to serve the site is already
# committed — no build step runs on GitHub's side.

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "usage: ./publish.sh <owner/repo | git url>" >&2
  exit 1
fi

ARG="$1"
case "$ARG" in
  http*|git@*) REMOTE="$ARG" ;;
  */*)         REMOTE="https://github.com/${ARG}.git" ;;
  *) echo "expected owner/repo or a git URL, got: $ARG" >&2; exit 1 ;;
esac

SLUG="$(printf '%s' "$REMOTE" | sed -E 's#.*github\.com[:/]##; s#\.git$##')"
OWNER="${SLUG%%/*}"
NAME="${SLUG##*/}"
OWNER_LC="$(printf '%s' "$OWNER" | tr '[:upper:]' '[:lower:]')"

echo "▸ publishing to $REMOTE"

[ -d .git ] || git init -q
git add -A
git diff --cached --quiet || git commit -q -m "SIGNALS: live open-source intelligence globe"
git branch -M main

if git remote get-url origin >/dev/null 2>&1; then
  git remote set-url origin "$REMOTE"
else
  git remote add origin "$REMOTE"
fi

git push -u origin main

cat <<MSG

✓ pushed.

One manual step left — turn on GitHub Pages:

  https://github.com/${SLUG}/settings/pages
  Source: "Deploy from a branch"  →  Branch: main  →  Folder: / (root)  →  Save

Give it a minute, then your shareable link is:

  https://${OWNER_LC}.github.io/${NAME}/

If the Pages tab offers nothing, the repo is private (Pages needs it public
unless you're on GitHub Enterprise) or an org policy is blocking it.
MSG
