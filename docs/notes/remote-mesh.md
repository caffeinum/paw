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

## Off on a remote space (open-mesh only today)

The sleep host and stale-id forwarder (both dial bare), presence-latch detection (AUTH-GAP), and the
`paw status` INBOX lag column (the admin view holds no JetStream-API inbox rows → `?` + an error line).
`paw spaces` reads the local broker only.

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
`paw restart`, second DM, teardown. PAW_SPACE is a decoy local space and PAW_SERVER a dead port, so
any path that ignores `--space` fails instead of touching the live mesh. The cotal-ai package must
be installed OUTSIDE the repo; run with `COTAL_SKIP_CONNECTOR_SEED=1` (the script sets it) or cotal
touches the operator's `~/.config/cotal` seed store.
