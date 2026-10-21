#!/bin/sh
# Runs as root at every boot: prepare the volume, then hand over to the agent user.
set -eu
mkdir -p /data/home /data/repos /data/cotal-root/.cotal/auth
chown agent:agent /data/home /data/repos
chown -R agent:agent /data/cotal-root
chmod 700 /data/cotal-root/.cotal /data/cotal-root/.cotal/auth
exec runuser -u agent -- env HOME=/data/home USER=agent LOGNAME=agent SHELL=/bin/bash /usr/local/bin/boot.sh
