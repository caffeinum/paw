#!/bin/sh
# Build kit for linux/amd64 from the local checkout, then deploy the image at origin/main's paw.
set -eu
cd "$(dirname "$0")"
KIT_SRC=${KIT_SRC:-$HOME/Github/caffeinum/kit}
mkdir -p bin
(cd "$KIT_SRC" && GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o "$OLDPWD/bin/kit" ./cmd/kit)
REF=$(git ls-remote https://github.com/caffeinum/paw.git refs/heads/main | cut -f1)
[ -n "$REF" ] || { echo "deploy: can't read caffeinum/paw main" >&2; exit 1; }
echo "deploy: paw $REF, kit from $KIT_SRC ($(cd "$KIT_SRC" && git rev-parse --short HEAD))"
exec fly deploy -a 2027-agents --remote-only --ha=false --build-arg "PAW_REF=$REF" "$@"
