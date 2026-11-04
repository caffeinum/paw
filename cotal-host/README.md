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
with `cotal doctor auth --fix` 30s after the earliest one passes 75% of its life (read from the JWTs
on disk), about twice a day. It used to run hourly, and each pass is a ~100MB node process. The `$SYS` creds (membership-observer, connection-evictor)
last 30 days and need `cotal down` + `cotal up --rotate-sys`; next due 2026-11-15.

The machine must never auto-stop (`auto_stop_machines = "off"`): a stopped machine is a dead mesh.

## Office bridge (optional, off by default)

`paw office serve` can run next to the broker and mirror EVERY agent on the `team2027` mesh into one
agent-office, whichever machine each agent runs on (paw #85; design in paw's docs/notes/office.md
"Roster mode"). It is OFF unless both of these are set, and with neither the image and `start.sh`
behave exactly as before (the hook is one `if` that doesn't fire):

1. **paw in the image**: build arg `PAW_REF` = a caffeinum/paw commit (public repo: no build secret).
   Empty by default, which installs nothing. To turn it on, add to `fly.toml` (this repo auto-deploys
   `cotal-host/` from `main`, so that commit redeploys the broker):
   ```toml
   [build.args]
     PAW_REF = "<full commit sha of caffeinum/paw>"
   ```
2. **the office link**, as Fly secrets (never in fly.toml):
   ```sh
   fly secrets set -a 2027-cotal OFFICE_URL=https://<agent-office> OFFICE_JOIN_KEY=<joinKey> [OFFICE_OWNER_KEY=<ownerKey>]
   ```
   Optional: `OFFICE_HUMAN=<name>` (the human name the bridge's paw home uses on the space: agent DMs to
   that name are mirrored to the office's owner), `OFFICE_ROSTER=all`, `OFFICE_BRIDGE_HEAP_MB` (192).

What runs: `start.sh` starts `office-bridge.sh` in the background (and unsets the OFFICE_* keys before
`exec cotal up`, so the broker's env never holds them). That script records the space as a paw remote
mesh whose signer is the box's own `/data/cotal` (`paw mesh add … --root /data/cotal`, retried while
cotal up writes its auth on first boot), then supervises `paw office serve --space $COTAL_SPACE`:
`nice -n 10`, `NODE_OPTIONS=--max-old-space-size=192`, restart with backoff 10s → 10 min. Its paw home is
`/data/office-bridge` (link + agent tokens, so a redeploy resumes the same characters). It never runs
`cotal`, never signals nats or `cotal up`, and every failure is a log line (`fly logs`: `office-bridge:` /
`[office]`) — it cannot stop or restart the broker. Creds: the read-only `admin` observer (no presence,
no publish) for the roster and speech, and the `office` sender's own `operator` mint for office→agent DMs.

**Single bridge rule**: once this runs, disconnect every per-machine bridge into the same office
(`paw office disconnect --space team2027` on each linked laptop/box), or every agent appears twice.

Turn it off: `fly secrets unset -a 2027-cotal OFFICE_URL OFFICE_JOIN_KEY OFFICE_OWNER_KEY` (the characters
stay until the office times them out; `PAW_HOME=/data/office-bridge node /opt/paw/bin/paw.mjs office
disconnect --space team2027` over `fly ssh console` walks them out first).

## Known

- nats-server also opens an unencrypted websocket listener on a random port. Fly routes only
  4222 and 443 from the internet, so it is reachable only on the org's private network
  (still JWT-authed).
- Memory: 1GB since 2026-10-24 (512MB ran out). Budget in `fly.toml`: `GOMEMLIMIT=300MiB` for
  nats-server, `--max-old-space-size=192` for the node daemons, 512MB swap.
- No nats monitoring port: cotal 0.84 generates `server.conf` on every boot and has no flag for it.
- Cost: shared-cpu-1x 1GB (~$5.7/mo) + 1GB volume ($0.15) + dedicated IPv4 ($2) ≈ $7.9/mo.
