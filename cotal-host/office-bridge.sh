#!/bin/sh
# Optional: mirror every agent on the space's mesh into an agent-office (paw issue #85).
# start.sh runs this in the background ONLY when OFFICE_URL or OFFICE_JOIN_KEY is set. It supervises
# `paw office serve` as a separate, low-priority, heap-capped node process: it never touches nats or
# `cotal up`, and nothing it does can stop or restart the broker. Every failure is a log line.
set -u
log() { echo "office-bridge: $*" >&2; }

[ -n "${OFFICE_URL:-}" ] && [ -n "${OFFICE_JOIN_KEY:-}" ] || { log "needs both OFFICE_URL and OFFICE_JOIN_KEY - not starting"; exit 0; }
: "${PUBLIC_HOST:?}" "${COTAL_SPACE:?}"
PAW_DIR=${PAW_DIR:-/opt/paw}
[ -f "$PAW_DIR/bin/paw.mjs" ] || { log "paw is not in this image (build with PAW_REF=<caffeinum/paw commit>) - not starting"; exit 0; }

# Its own paw home on the volume: the office link, the agent tokens (resumed across restarts) and the
# `office` sender's nkey live here. Nothing else on the box reads it.
export PAW_HOME=${OFFICE_PAW_HOME:-/data/office-bridge}
mkdir -p "$PAW_HOME" && chmod 700 "$PAW_HOME"
paw() { NODE_OPTIONS="--max-old-space-size=${OFFICE_BRIDGE_HEAP_MB:-192}" nice -n 10 node "$PAW_DIR/bin/paw.mjs" "$@"; }

# The space as a paw REMOTE mesh whose signer is this box's own (/data/cotal/.cotal/auth): the bridge
# mints its creds from it like any paw machine does (observer to read the roster + tap, `operator` for
# the `office` peer's DMs). Dialled by the cert's name, which start.sh pins to 127.0.0.1. cotal up writes
# the auth on first boot, so retry until it loads.
tries=0
until paw mesh add "$COTAL_SPACE" --server "tls://$PUBLIC_HOST:4222" --root /data/cotal --force ${OFFICE_HUMAN:+--as "$OFFICE_HUMAN"} >/dev/null; do
  tries=$((tries + 1))
  [ "$tries" -lt 20 ] || { log "the box's signer never loaded for $COTAL_SPACE - giving up (the broker is unaffected)"; exit 0; }
  sleep 30
done

child=""
trap 'log "stopping"; [ -n "$child" ] && kill -TERM "$child" 2>/dev/null; wait "$child" 2>/dev/null; exit 0' TERM INT
backoff=10
while :; do
  started=$(date +%s)
  paw office serve --space "$COTAL_SPACE" &
  child=$!
  wait "$child"
  code=$?
  child=""
  if [ $(( $(date +%s) - started )) -ge 600 ]; then backoff=10; else backoff=$(( backoff * 2 )); [ "$backoff" -le 600 ] || backoff=600; fi
  log "paw office serve exited ($code) - restarting in ${backoff}s"
  sleep "$backoff"
done
