#!/bin/sh
# Get/renew a Let's Encrypt cert for the broker hostname (TLS-ALPN-01 on :443), then run the mesh.
set -eu
: "${PUBLIC_HOST:?}" "${COTAL_SPACE:?}"
ACME=/data/acme
CERT="$ACME/certificates/$PUBLIC_HOST.crt"
KEY="$ACME/certificates/$PUBLIC_HOST.key"
mkdir -p "$HOME" /data/cotal "$ACME"

lego run --path "$ACME" --accept-tos --tls --domains "$PUBLIC_HOST"

# cotal's local daemons dial the broker by the cert's name; keep that dial on the box.
grep -q " $PUBLIC_HOST\$" /etc/hosts || echo "127.0.0.1 $PUBLIC_HOST" >> /etc/hosts
# Process records from the previous boot point at pids of a dead container.
rm -f /data/cotal/.cotal/*.pid /data/cotal/.cotal/*.pid.identity

# Renew twice a day; nats-server re-reads cert_file/key_file on SIGHUP.
( while sleep 43200; do
    lego run --path "$ACME" --accept-tos --tls --domains "$PUBLIC_HOST" \
      --deploy-hook "kill -HUP \$(cat /data/cotal/.cotal/nats.pid)" || echo "start: cert renewal failed" >&2
  done ) &

# No manager runs here, so nothing else renews the daemon creds (delivery, membership-rw: 24h TTL).
# doctor --fix re-signs a cred only once it is past 75% of its life, and the daemons re-read the file at
# that same 75% point (then every 60s until it changes). A fixed cadence must stay well under 25% of the
# TTL (6h) or a renewal can land at expiry, and each pass is a ~100MB node process. So wake just past
# the earliest renewal point, read from the JWTs on disk: about two passes a day, each a minute after due.
CREDS_DIR=/data/cotal/.cotal/space.$(printf %s "$COTAL_SPACE" | od -An -tx1 | tr -d ' \n')
renew_at() {
  jwt=$(sed -n '/BEGIN NATS USER JWT/{n;p;q;}' "$1")
  p=$(printf %s "$jwt" | cut -d. -f2 | tr '_-' '/+')
  while [ $(( ${#p} % 4 )) -ne 0 ]; do p="$p="; done
  claims=$(printf %s "$p" | base64 -d 2>/dev/null)
  iat=$(printf %s "$claims" | sed -n 's/.*"iat":\([0-9]*\).*/\1/p')
  exp=$(printf %s "$claims" | sed -n 's/.*"exp":\([0-9]*\).*/\1/p')
  [ -n "$iat" ] && [ -n "$exp" ] || { echo "start: can't read iat/exp from $1" >&2; return 1; }
  echo $(( iat + (exp - iat) * 3 / 4 ))
}
next_renewal() {
  a=$(renew_at "$CREDS_DIR/delivery.creds") && b=$(renew_at "$CREDS_DIR/membership-rw.creds") || return 1
  [ "$a" -lt "$b" ] && echo "$a" || echo "$b"
}
( while :; do
    if due=$(next_renewal); then
      wait_s=$(( due - $(date +%s) + 30 ))
      [ "$wait_s" -ge 300 ] || wait_s=300   # a pass that did not renew must not respawn node every minute
    else
      echo "start: can't place the next daemon creds renewal - checking again in 1h" >&2
      wait_s=3600
    fi
    sleep "$wait_s"
    ( cd /data/cotal && cotal doctor auth --space "$COTAL_SPACE" --fix ) >/dev/null 2>&1 \
      || echo "start: daemon creds renewal failed" >&2
  done ) &

# The $SYS creds (membership-observer, connection-evictor) live 30 days and only a STOPPED broker can
# re-mint them (`cotal up --rotate-sys`; agents, creds and data survive). So: rotate at boot when they
# are close, and restart the machine daily-checked when they get close while running.
ROTATE_DAYS=10
ROTATE_FLAG=/data/cotal/.rotate-sys-now   # touch it + restart the machine to force a rotation
sys_days_left() {
  exp=$(cd /data/cotal && cotal doctor auth --space "$COTAL_SPACE" 2>&1 \
    | sed -n 's/.*\(membership-observer\|connection-evictor\)\.creds.* expires \([0-9T:.Z-]*\).*/\2/p' | sort | head -1)
  [ -n "$exp" ] || { echo "start: can't read the \$SYS creds expiry from cotal doctor auth" >&2; return 1; }
  echo $(( ($(date -d "$exp" +%s) - $(date +%s)) / 86400 ))
}
ROTATE=""
if [ -e "$ROTATE_FLAG" ]; then
  ROTATE="--rotate-sys"; rm -f "$ROTATE_FLAG"; echo "start: rotating \$SYS creds (forced by $ROTATE_FLAG)" >&2
elif left=$(sys_days_left) && [ "$left" -lt "$ROTATE_DAYS" ]; then
  ROTATE="--rotate-sys"; echo "start: rotating \$SYS creds ($left days left)" >&2
fi
MAIN=$$   # exec below keeps this pid: it becomes cotal up
( while sleep 86400; do
    if left=$(sys_days_left) && [ "$left" -lt "$ROTATE_DAYS" ]; then
      echo "start: \$SYS creds expire in $left days - restarting to rotate them" >&2
      kill -TERM "$MAIN"; exit 0
    fi
  done ) &

cd /data/cotal
exec cotal up $ROTATE --no-manager --space "$COTAL_SPACE" \
  --server "tls://$PUBLIC_HOST:4222" --host 0.0.0.0 \
  --store-dir /data/cotal/.cotal/nats \
  --tls-cert "$CERT" --tls-key "$KEY"
