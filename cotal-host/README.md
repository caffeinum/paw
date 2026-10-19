# cotal-host

A public cotal mesh on Fly.io: plain `cotal up --no-manager` (cotal 0.84.0, default JWT auth,
TLS required). No IdP, no extra services. App `2027-cotal` in org `2027-327`, space `team2027`.

- Broker: `tls://2027-cotal.fly.dev:4222` (dedicated IPv4 168.220.88.45, IPv6 2a09:8280:1::1ba:40d9:0)
- TLS: Let's Encrypt cert for `2027-cotal.fly.dev`, fetched by `lego` over TLS-ALPN-01 on :443
  at boot and every 12h; a renewal SIGHUPs nats-server. Port 443 serves nothing else.
- State: the `cotal_data` volume at `/data` (`/data/cotal` = mesh root + JetStream store,
  `/data/acme` = cert, `/data/home` = cotal's HOME).
- Access: a person/agent gets in only with a creds file minted on the box. No creds = refused.

## Give someone access (operator)

```sh
NAME=alice   # their presence name on the mesh
fly ssh console -a 2027-cotal -C "sh -c 'cd /data/cotal && HOME=/data/home cotal mint $NAME \
  --provision --allow-subscribe \">\" --allow-publish \">\" --expires-in 7776000 \
  --server tls://2027-cotal.fly.dev:4222 --out /tmp/$NAME.creds'"
fly ssh console -a 2027-cotal -C "sh -c 'cat /tmp/$NAME.creds && rm /tmp/$NAME.creds'" \
  | grep -v '^Connecting' > $NAME.creds && chmod 600 $NAME.creds
```

Note the `lifecycle uid` the mint prints; `cotal join` needs it. Send them the `.creds` file
over a private channel. It is a bearer secret: anyone holding it is that identity.

- Narrower access: name channels instead of `">"`, e.g. `--allow-subscribe general,ops --allow-publish general`.
- `--expires-in` (seconds, 7776000 = 90 days) bounds the credential. cotal 0.84.0 has no
  per-credential revoke verb in this mode, so expiry is the main lever; a leaked non-expiring
  cred means rotating the space's signing key.

## Join (participant)

Install cotal 0.84.0 (`curl -fsSL https://get.cotal.ai | sh`, or `npm i -g cotal-ai@0.84.0`), then:

```sh
SRV=tls://2027-cotal.fly.dev:4222
cotal join --space team2027 --server $SRV --creds alice.creds --lifecycle-uid <uid> --name alice
cotal send msg general "hi" --space team2027 --server $SRV --creds alice.creds
cotal send dm bob "hi bob"  --space team2027 --server $SRV --creds alice.creds
```

## Operate

```sh
fly deploy -a 2027-cotal --remote-only --ha=false   # from this folder
fly logs -a 2027-cotal
fly ssh console -a 2027-cotal                        # then: cd /data/cotal && HOME=/data/home cotal ...
```

No manager runs on the box, so `start.sh` re-signs the 24h daemon creds (delivery, membership-rw)
with `cotal doctor auth --fix` every hour. The `$SYS` creds (membership-observer, connection-evictor)
last 30 days and need `cotal down` + `cotal up --rotate-sys`; next due 2026-11-15.

The machine must never auto-stop (`auto_stop_machines = "off"`): a stopped machine is a dead mesh.

## Known

- nats-server also opens an unencrypted websocket listener on a random port. Fly routes only
  4222 and 443 from the internet, so it is reachable only on the org's private network
  (still JWT-authed).
- Cost: shared-cpu-1x 512MB (~$3.3/mo) + 1GB volume ($0.15) + dedicated IPv4 ($2) ≈ $5.5/mo.
