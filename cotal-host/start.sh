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

cd /data/cotal
exec cotal up --no-manager --space "$COTAL_SPACE" \
  --server "tls://$PUBLIC_HOST:4222" --host 0.0.0.0 \
  --store-dir /data/cotal/.cotal/nats \
  --tls-cert "$CERT" --tls-key "$KEY"
