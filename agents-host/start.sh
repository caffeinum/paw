#!/bin/sh
# Runs as root at every boot: prepare the volume, then start paw (as root — the box is a sandbox).
set -eu
mkdir -p /data/home /data/repos /data/cotal-root/.cotal/auth
chown -R root:root /data/home /data/repos /data/cotal-root
chmod 700 /data/cotal-root/.cotal /data/cotal-root/.cotal/auth
cd /data/home
exec env HOME=/data/home USER=root LOGNAME=root SHELL=/bin/bash IS_SANDBOX=1 /usr/local/bin/boot.sh
