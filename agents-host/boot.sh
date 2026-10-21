#!/bin/bash
# The boot (as root): make sure this box's team2027 record exists, snapshot the paw release the
# image carries, start the registered agents, then follow the logs. Fails loud into `fly logs`.
set -euo pipefail
SPACE=team2027
SERVER=tls://2027-cotal.fly.dev:4222
ROOT=/data/cotal-root
HUMAN=fly-agents
SIGNER=$ROOT/.cotal/auth/auth.json
log() { echo "boot: $*" >&2; }

# The signer is placed once over `fly ssh sftp` (README). Without it there is no mesh: say so and
# keep the machine up so the operator can SSH in and place it.
until [ -s "$SIGNER" ]; do
  log "no team2027 signer at $SIGNER — place it (agents-host/README.md, 'Mesh signer'); checking again in 60s"
  sleep 60
done
chmod 600 "$SIGNER"

# Nothing of paw runs yet: lock/pid files on the volume are a previous container's (its pids can be
# reused by this one, so a pid-stamped lock could look held).
if [ -d "$PAW_HOME/spaces" ]; then
  find "$PAW_HOME/spaces" -maxdepth 2 \( -name '*.lock' -o -name '*.pid' -o -name '*.pid.identity' \) -delete
fi
rm -f "$ROOT"/.cotal/*.pid "$ROOT"/.cotal/*.pid.identity

if [ ! -e "$PAW_HOME/spaces/$SPACE/remote-mesh.json" ]; then
  log "adding the $SPACE mesh record"
  paw mesh add "$SPACE" --server "$SERVER" --root "$ROOT" --as "$HUMAN"
fi
paw release
paw start --space "$SPACE" || log "paw start failed (exit $?) — see above"
paw status --space "$SPACE" || log "paw status failed (exit $?) — the manager is not up"

touch "$PAW_HOME/spaces/$SPACE/manager.log"
exec tail -n 50 -F "$PAW_HOME/spaces/$SPACE/manager.log"
