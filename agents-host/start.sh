#!/bin/sh
# Runs as root at every boot: prepare the volume, then start paw (as root — the box is a sandbox).
set -eu
mkdir -p /data/home /data/repos /data/cotal-root/.cotal/auth
chown -R root:root /data/home /data/repos /data/cotal-root
chmod 700 /data/cotal-root/.cotal /data/cotal-root/.cotal/auth
# `paw teleport` mirrors a Mac folder at its own absolute path (/Users/…): keep that on the volume.
# A bind mount, not a symlink — claude resolves the real path for its project slug.
mkdir -p /data/mirror/Users /Users
mountpoint -q /Users || mount --bind /data/mirror/Users /Users
cd /data/home
exec env HOME=/data/home USER=root LOGNAME=root SHELL=/bin/bash IS_SANDBOX=1 /usr/local/bin/boot.sh
