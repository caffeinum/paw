# Remote meshes (one paw, several brokers)

Index: [CLAUDE.md](../../CLAUDE.md)

## What it is

A space can live on a broker paw does not run — e.g. `team2027` on the JWT + TLS cotal 0.84 broker
at `tls://2027-cotal.fly.dev:4222` (`cotal up --no-manager` on Fly). The local `paw` space is
untouched: a space with no record resolves exactly as before.

- **Record** (`src/remote-mesh.ts`, `paw mesh add|rm|ls`): `$PAW_HOME/spaces/<space>/remote-mesh.json`
  = `{space, server: "tls://host:port", root, ts}`. `root` is a dir whose `.cotal/auth/auth.json` is the
  space's account **signer** (`cotal mint --signer` on the box: `space` + `account.pub` +
  `account.signingSeed`). The record holds the path, never the signer. `mesh add` refuses non-`tls://`
  servers, the default space, a signer for another space, and a signer readable by other users.
  Offline: it dials nothing; the first ensure() proves the link.
- **Routing** (`src/server.ts`): `pawServer(space = resolveSpace())` = the record's server, else the
  local broker (`localServer()` = `PAW_SERVER` or `nats://127.0.0.1:4222`). `PAW_SERVER` names the LOCAL
  broker only. `pawCotalRoot(space)` = record root (a disagreeing `PAW_COTAL_ROOT` fails loud).
  `meshTls(space)` → `{tls: true}` for remote spaces, `{}` locally (CotalEndpoint / probeConnect);
  `natsTls(space)` → `{tls: {}}` / `{}` for a RAW nats.js `connect()` (the presence probe, the status
  INBOX listing). Every paw dial of a remote space with creds REQUIRES TLS: without the option nats.js
  only upgrades when the broker asks, so a plaintext listener at that address got CONNECT + the creds
  (the presence probe did exactly that until 2026-10-19; `check:remote` holds a fake plaintext broker).
- **ensure()** (`src/lifecycle.ts`): for a remote space it never starts a broker
  (`ensureRemoteMesh`: one credentialed, TLS-required `probeConnect` minted from the signer, with a
  named reason for each failure), skips open-mesh stream bootstrap, then starts the usual
  `cotald supervise --space <s> --server tls://…` with `cwd = record root`, so cotal's Manager reads the
  stripped signer through its SecretStore seam (`validateSpaceAuthForRead` accepts it) and mints +
  renews per-agent creds itself. cotal 0.84 allows several managers per space (per-instance leases,
  "a second manager in a second workspace root coexists"), so this works beside a manager elsewhere.
- **"you"** on a remote space (`humanEndpointAuth`, src/addressing.ts): under auth an endpoint's id is
  its cred's nkey, so paw persists ONE human nkey (`spaces/<s>/human.nkey.json`, 0600) and mints it per
  role, mirroring cotal: `agent` (+ a fresh lifecycle uid) for the mailbox presence, `operator` to send
  and read the roster (`cotal send`), `admin` to read DM/channel history (`cotal console`). Local spaces
  keep `controlCreds`.
- **Seats** (`remoteTlsEnv`, src/connector.ts): cotal's launch env is an allowlist without the CA knobs;
  a remote space's seats get `NODE_EXTRA_CA_CERTS` / `SSL_CERT_FILE` through `envAllow` when set.
  `remoteSeatTls` adds `COTAL_TLS=1` to the seat env: the seat's cotal MCP reads its transport from that
  env var alone (the launch material carries servers + creds, no TLS flag) and nothing in cotal's
  launch sets it, so seats dialled `tls://` with `tls: false`. pawConnector (claude) only — kit /
  hermes / acp seats on a remote space get neither knob yet. The hub passes `COTAL_*` through.
- **CLI**: `pawServer(space)` is threaded through every command. The bin gate and the self-ensuring
  commands (status, chat, stop, rm) ensure `ensureSpaceFor(space)` = the `--space` when it is remote,
  else the current space as before.
- **One space per agent**: `assertOneSpace` (ensureAgentSpawned, adopt) refuses a session another
  space's persona pins, when either side is remote.

- **One manager per machine, pinned** (`pinFor`, src/control.ts): cotal 0.84 lets every machine run its
  own manager on the same remote space. Unpinned, describe + every command ride the class queue, so
  `ps`/`spawn`/`despawn` from this machine could land on ANOTHER machine's manager (and `paw down` could
  have despawned its agents). A remote space's control rail is pinned to THIS machine's manager instance
  (`loadManagerInstanceIdentity(root, space)`, persisted by cotal under the record root) with cotal's
  `--on` grant rows (`instancePinnedInstrumentCapabilities`); before that manager ever registered,
  control fails loud instead of reaching a foreign one. Local spaces keep the class route.
- **Hosted here** (src/hosted.ts): an agent is this machine's iff its persona is in this
  `$PAW_HOME/spaces/<s>/personas/` AND its ps row's `instanceId` is the local manager's. Only such an
  agent may be slept, stood in for, or have a stand-in identity minted; anything else that is live on
  the roster fails loud: `"<name>" is hosted on another machine`.
- **Narrow creds** (src/remote-creds.ts): paw signs its own user JWTs with the space signer, one
  allow-list per job, each with an expiry:
  - `inbox-lag` — pub `$JS.API.CONSUMER.INFO.DM_<s>.*` + its `_INBOX_<id>.>`; cached
    `spaces/<s>/creds/inbox-lag.creds` (0600, 24h, re-signed with <1h left).
  - `sleep-watch` (per sleeping agent, memory only, 24h, renewed in place) — sub the stand-in's + old
    seat's DM subjects; consumer CREATE/INFO/MSG.NEXT/DELETE pinned to `pawsl_<hash>_<host|cli><i>` names
    AND their filter (a stream-wide MSG.NEXT could drain an agent's durable); `STREAM.INFO DM_<s>`.
  - `sleep-forward` (per wake, 5 min) — pub ONLY `inst.<woken seat>.<sender>` for the backlog's senders.
  - `dm-cursor` (per `paw sleep`, 5 min) — `STREAM.INFO DM_<s>` only.
  - the stand-in presence — cotal's own `agent` mint for a persisted stand-in nkey
    (`sleep/<name>.standin.nkey`, 0600), never the agent's seat identity.
- **INBOX lag**: per hosted seat, `consumers.info(DM_<s>, dm_<owner>-<actor>-<lifecycleUid>)` (all three
  from our ps row) with the `inbox-lag` cred and its scoped `inboxPrefix` (the old listing used the
  default `_INBOX.` → `Permissions Violation for Subscription to "_INBOX.<…>.*"`, and `CONSUMER.LIST` is
  in no narrow grant). Roster-only peers on a remote space are never claimed (`—`).
- **paw sleep / the sleep host**: on. The mailbox's host dials with the creds above; the sleep record
  pins `instanceId`, and the host drops (loudly, `sleep.log`) any record not slept by this machine's
  instance or whose persona is not here. Backlog reads are one named, filter-pinned consumer per subject.

## Off on a remote space

The stale-id forwarder (re-publishes ANY peer's DM under its sender — no narrow grant for that),
presence-latch detection (AUTH-GAP), and `paw spaces` (reads the local broker only).

## cotal gaps found

- `--no-manager` broker: the delivery daemon's `delivery.creds` are standing-renewable (24h) with
  renewal owner = a manager on the SAME store. A remote paw manager is not that owner (it logs "not
  the daemon-credential renewal owner"), so on a broker-only box nothing renews them.
- Many manager-internal dials pass `tls: false` ("not yet wired to a recorded transport"): the
  connection still upgrades because the broker requires TLS, but nothing REQUIRES it.
  The Manager takes no transport option at all (paw's `cotald supervise` cannot pass one), so this
  stays cotal's to fix; paw's own dials and the seats require TLS.
- Seat launch env drops `NODE_EXTRA_CA_CERTS` and never sets `COTAL_TLS` (paw adds both, above).
- `cotal meshes add --mode auth` wants a fully composing trust root, so a signer-only root can't be
  registered in cotal's own registry — paw keeps its own record.

## Test

`scripts/check-remote.ts` (`pnpm check:remote`, hermetic unit checks) and `scripts/e2e-remote.ts`
(`COTAL_BIN=<cotal-ai@0.84.0>/dist/cotal.js node scripts/e2e-remote.ts`): a private `cotal up
--no-manager` JWT + TLS broker with a self-signed cert, `mint --signer`, `paw mesh add`, no-CA
refusal, a real haiku claude spawned by `paw dm --space` (its cotal MCP carries `COTAL_TLS=1`, read
with `ps -E`), reply read by `paw inbox`, who/status (the TLS-required presence probe reaches the broker),
`paw restart`, second DM; INBOX lag a real number (cached 0600 lag cred); a SECOND machine (own
PAW_HOME + root + signer copy, its own manager) spawns its agent — machine 1 never lists it or its lag
and `paw sleep` on it fails "hosted on another machine" (both directions, `--force` too); then
`paw sleep agent --now`, stand-in raised under its own nkey, a raw DM by name resolves to the stand-in,
wakes the agent and is re-delivered (reply in `paw inbox`); teardown. PAW_SPACE is a decoy local space and PAW_SERVER a dead port, so
any path that ignores `--space` fails instead of touching the live mesh. The cotal-ai package must
be installed OUTSIDE the repo; run with `COTAL_SKIP_CONNECTOR_SEED=1` (the script sets it) or cotal
touches the operator's `~/.config/cotal` seed store.
