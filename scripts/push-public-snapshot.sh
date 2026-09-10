#!/bin/sh
# Push HEAD's TREE to the `public` remote as an orphan commit (no parents, no history).
# origin is untouched. this checkout keeps full history and you keep committing here.
set -e
root=$(git rev-parse --show-toplevel)
cd "$root"
url=$(git remote get-url public 2>/dev/null || true)
if [ -z "$url" ]; then
  echo "paw: no 'public' remote — add one (e.g. git remote add public git@github.com:caffeinum/paw-public.git)" >&2
  exit 1
fi
origin=$(git remote get-url origin)
if [ "$url" = "$origin" ]; then
  echo "paw: 'public' remote is the same as origin — refusing to force-push an orphan over history" >&2
  exit 1
fi
# origin/main is the public-shaped branch; this script is only for a second remote.
head=$(git rev-parse --short HEAD)
tree=$(git rev-parse "HEAD^{tree}")
commit=$(git commit-tree "$tree" -m "public snapshot of $head")
git push public "$commit":refs/heads/main --force
echo "public/main <- $commit (tree of $head, no parents)"
