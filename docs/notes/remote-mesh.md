# Remote meshes (one paw, several brokers)

Index: [CLAUDE.md](../../CLAUDE.md)

## What it is

A space can live on a broker paw does not run — e.g. `team2027` on the JWT + TLS cotal 0.84 broker
at `tls://2027-cotal.fly.dev:4222` (`cotal up --no-manager` on Fly). The local `paw` space is
untouched: a space with no record resolves exactly as before.

- **Record** (`src/remote-mesh.ts`, `paw mesh add|rm|ls`): `$PAW_HOME/spaces/<space>/remote-mesh.json`
  = `{space, server: "tls://host:port", root, ts}`. `root` is a dir whose `.cotal/auth/auth.json` is the
  space's account **signer** (`cotal auth signer --out <file>` on the box — `cotal mint --signer` before cotal 0.100: `space` + `account.pub` +
  `account.signingSeed`). Optional `human` = your mesh name there (below). The record holds the path,
  never the signer. `mesh add` refuses non-`tls://`
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
- **Which step stalled (`src/connect-diag.ts`, 2026-10-24).** cotal's `probeConnect` reports only
  `timeout`/`unreachable`. On those two, paw re-walks the connect on its own sockets (DNS lookup, TCP,
  the plaintext NATS INFO greeting, the TLS upgrade, a TLS-first try if no INFO; 3s per step), times
  each, and names the first that failed: e.g. `TCP 26ms; then no NATS INFO greeting within 3s: …the
  broker is not serving them — stalled (overloaded or out of memory) — check \`fly status -a 2027-cotal\``,
  `the DNS lookup of … failed on this machine (getaddrinfo ENOTFOUND …)`, a refused port, an
  untrusted cert (with its code). Every step answering = the stall was past TLS (the creds' CONNECT,
  which paw can't time) or it recovered, and the text says both. Why: the team2027 outage (fly box
  out of memory, TCP fine, CONNECT silent for minutes) read as "the link is slow or the broker is
  overloaded". The 10s probe stays 10s: a stalled broker stays stalled. `check:connect-diag`.
- **"you"** on a remote space (`humanEndpointAuth`, src/addressing.ts): under auth an endpoint's id is
  its cred's nkey, so paw persists ONE human nkey (`spaces/<s>/human.nkey.json`, 0600) and mints it per
  role, mirroring cotal: `agent` (+ a fresh lifecycle uid) for the mailbox presence, `operator` to send
  and read the roster (`cotal send`), `admin` to read DM/channel history (`cotal console`). Local spaces
  keep `controlCreds`. Its NAME is per space — see [human name](#human-name).
- **`paw chat`** (`openHumanInbox`, src/human-inbox.ts): chat is the one CONSUMING "you". Under auth an
  agent cred may only BIND its `dm_<owner>-<actor>-<uid>` / `dlv_…` durables; creating them is a
  `provisioner` act its launcher does (the manager for agents, `cotal spawn` for a foreground one).
  Nobody launched "you", so until 2026-10-19 chat bound a durable for a fresh uid no one had created
  and died with cotal's bare "consumer not found". Now chat does what `cotal spawn` does: per run, a
  fresh lifecycle uid → `provisionAgentDurables` under the signer → an `agent` cred for that uid
  (channel grant `>`, like a persona) → bind; on quit it retires the footprint (DM + DELIVER durables,
  read-ACL row, channel member rows) with a target-pinned `deprovisioner` cred over a TLS-REQUIRED dial
  (cotal's `deprovisionAgent` dials `tls: false`). A SIGKILLed chat leaves that one footprint behind
  (authed durables have no inactive threshold) — same class as a crashed `cotal spawn`. A bind failure
  is reworded by `describeInboxBindFailure`. e2e-remote drives chat over piped stdin and counts "you"'s
  durables before / during / after.
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
  - `chat-echo` (per `paw chat`, memory only, 24h, re-signed + reconnected in place) — sub ONLY "you"'s
    own outbound DM subject `inst.*.*.<o>.<you>`; publishes nothing.
  - `chat-history` (per tasks-view seed, 5 min) — DMs to and from "you" through two name- and
    filter-pinned consumers (`pawch_<hash>_<i>`), the `sleep-watch` read shape without the live sub.
  - the stand-in presence — cotal's own `agent` mint for a persisted stand-in nkey
    (`sleep/<name>.standin.nkey`, 0600), never the agent's seat identity.
- **INBOX lag**: per hosted seat, `consumers.info(DM_<s>, dm_<owner>-<actor>-<lifecycleUid>)` (all three
  from our ps row) with the `inbox-lag` cred and its scoped `inboxPrefix` (the old listing used the
  default `_INBOX.` → `Permissions Violation for Subscription to "_INBOX.<…>.*"`, and `CONSUMER.LIST` is
  in no narrow grant). Roster-only peers on a remote space are never claimed (`—`).
- **paw sleep / the sleep host**: on. The mailbox's host dials with the creds above; the sleep record
  pins `instanceId`, and the host drops (loudly, `sleep.log`) any record not slept by this machine's
  instance or whose persona is not here. Backlog reads are one named, filter-pinned consumer per subject.
## Human name

A shared broker sees every operator's mailbox, and they were all `you` (team2027 showed two; a DM to
`you` was ambiguous). The record's optional `human` names you on that space:

    paw mesh add team2027 --server tls://2027-cotal.fly.dev:4222 --root <dir> --as aleks-mac-mini
    paw mesh set team2027 --as aleks-mac-mini     # existing record; `--as you` resets
    paw restart --space team2027                  # running mailbox + agents pick it up (operator's call)

- **Resolution:** `humanPeer(space)` (src/names.ts) = record `human`, else `"you"`. No record ⇒ `"you"`,
  so local spaces and old records are unchanged. **No env override** on purpose: the detached mailbox,
  the manager that writes briefs and every CLI call must agree; a per-shell `PAW_HUMAN` would split them.
- **Validation:** `checkHumanName` — `[A-Za-z0-9][A-Za-z0-9._-]{0,63}` (a strict subset of cotal's
  `assertValidName`). Bad `--as` refused; a bad `human` in a record fails loud on read, never falls back.
- **Uses:** the card name of every human endpoint (mailbox beacon, dm, msg, ask, chat, inbox/history/
  watch/files observers, who) and the human named in the claude/kit/hermes/acp briefs (resolved at
  spawn). PR/website persona briefs no longer name the human (they defer to the mesh brief).
- **Identity is the nkey, not the name:** the DM inbox durable (`dlv_<id>`), unread cursor and
  `human.nkey.json` are untouched by a rename, so nothing is orphaned. UI labels for your own messages
  (web village/pending, dialog, feed `from`) stay `"you"` — perspective, not identity.
- `paw mesh ls` prints `as <name>`; `--force` re-add keeps an earlier `human` unless `--as` replaces it.

## Attach

`paw attach <agent> --space <remote>` (= `paw attach <agent>#<remote>`) works for pty agents, including
one another machine's manager hosts: paw runs cotal's `attach` from the record root with `--server
<record>` and no `--space`, so cotal mints the one-shot instrument + the `session-caller` cred from the
signer and pins the session to the hosting manager instance. `paw cotal <verb> --space <remote>` gets
the same rewrite (and drops a `--creds`, which cotal's control calls refuse). Ctrl-] detaches; the agent
keeps running. Details + per-space-type table: [agents.md#pty-attach-cotal-084](agents.md#pty-attach-cotal-084).
The gate still ensures THIS machine's manager on the space first (as for every NEEDS_MANAGER verb), and
the runtime branch reads THIS machine's runtime marker — an agent in another machine's tmux/cmux can't
be attached from here (no grant-based attach for those runtimes).

## paw chat / paw web taps

`paw chat` tapped the whole space (`cotal.<s>.>`) to mirror what another chat session sent; chat's
`agent` cred allows no such subscription, so on team2027 every chat printed
`Permissions Violation for Subscription to "cotal.team2027.>"` (2026-10-19). Neither job needs the
space (src/chat-own.ts): the channel half taps `chat.<o>.<you>.>` on chat's own connection (inside the
agent cred's `chat.*.*.>`), the DM half `inst.*.*.<o>.<you>` with the `chat-echo` cred; the tasks
view's last-exchange seed (`dmHistory`, a DM consumer the agent cred may not create) reads "you"'s
own conversation with `chat-history`. Never another agent's mail. `paw web` holds cotal's `admin`
observer cred (its village/dialog views read every DM by design), whose `sub.allow` enumerates
`chat.>`/`inst.>`/`svc.>` and excludes the space wildcard, so on a remote space it taps those three
(`webTapSubjects`). Local spaces keep the space-wide tap. e2e-remote drives two chat sessions (DM +
#general echo, /who, /ps, `@name`), the tasks + logs views under a pty, and `paw web`, and fails on
any permission line.

A CLI checkout from before that fix still prints it: chat's CLI runs from the checkout `paw` links to
(`~/.local/bin/paw` → the repo's `bin/paw.mjs`), not from a release, so the operator's
`paw chat @evals --space team2027` on 2026-10-19 hit it from a checkout at ae8e088 (chat.ts:1017
`ep.tap(handler)`, no subject = `cotal.<s>.>`). `check:remote` now fails if any `src/chat*.ts` calls
`ep.tap` outside chat-own.ts or if `tapOwnSends` places a tap without a subject on a remote space.

**`!cmd` for another machine's agent:** `!cmd` (chat and web) runs in the agent's registered folder on
THIS machine; an agent hosted elsewhere has none, and the old `no registered folder for "evals" —
\`paw status\` lists them` pointed at a status that only lists this machine's agents. On a remote space,
no persona here ⇒ `"evals" is hosted on another machine (<card meta.host>) — !cmd runs only for agents
hosted here` (`bangNoFolder`, src/hosted.ts; the host only when the card reports one — cotal's claude
connector doesn't). Never remote execution. e2e-remote drives `paw chat @<machine 2's agent>` from
machine 1: DM round-trip, `!pwd` gives that line, no permission line.

## Off on a remote space

The stale-id forwarder (re-publishes ANY peer's DM under its sender — no narrow grant for that) and
`paw spaces` (reads the local broker only). Presence-latch detection is ON since 2026-10-28 (a paw-signed
one-key `presence-probe` cred — [addressing.md#presence-latch-guard](addressing.md#presence-latch-guard)).

## cotal gaps found

- `--no-manager` broker: the delivery daemon's `delivery.creds` are standing-renewable (24h) with
  renewal owner = a manager on the SAME store. A remote paw manager is not that owner (it logs "not
  the daemon-credential renewal owner"), so on a broker-only box nothing renews them.
- Many manager-internal dials pass `tls: false` ("not yet wired to a recorded transport"): the
  connection still upgrades because the broker requires TLS, but nothing REQUIRES it.
  The Manager takes no transport option at all (paw's `cotald supervise` cannot pass one), so this
  stays cotal's to fix; paw's own dials and the seats require TLS.
- Seat launch env drops `NODE_EXTRA_CA_CERTS` and never sets `COTAL_TLS` (paw adds both, above).
- An authed consuming endpoint whose durable was never provisioned fails `pump()` with the raw
  JetStream "consumer not found" — no durable name, no hint that a provisioner must pre-create it
  (the register-only path has a full "lifecycle proof failed" message; the consume path has none).
- `cotal meshes add --mode auth` wants a fully composing trust root, so a signer-only root can't be
  registered in cotal's own registry — paw keeps its own record. Consequence: cotal verbs can't name
  the space (`--space` + `--server` on an unregistered space = cotal's raw OPEN arm, a bare connect),
  so paw runs them from the record root with `--server` only (`remoteCotalArgv`).
- A raw `--creds` control call is refused ("no endpoint-caller triple … cannot mint one") — by design,
  but the message doesn't say that `--server` from the root holding the signer is the working form.

## Test

`scripts/check-remote.ts` (`pnpm check:remote`, hermetic unit checks) and `scripts/e2e-remote.ts`
(`COTAL_BIN=<cotal-ai@0.100.0>/dist/cotal.js node scripts/e2e-remote.ts`): a private `cotal up
--no-manager` JWT + TLS broker with a self-signed cert, `auth signer`, `paw mesh add`, no-CA
refusal, a real haiku claude spawned by `paw dm --space` (its cotal MCP carries `COTAL_TLS=1`, read
with `ps -E`), reply read by `paw inbox`, who/status (the TLS-required presence probe reaches the broker),
`paw restart`, second DM. Step 4a/4b attaches under node-pty: `paw attach` (grant issued +
redeemed, claude's TUI streams, Ctrl-] exits 0, agent still live), `paw cotal attach --space R --creds
<junk>` (the operator's failing shape), and an attach from a second root while a SECOND manager
instance serves the space (cotal pins the session to the instance hosting the seat).
INBOX lag a real number (cached 0600 lag cred); a SECOND machine (own
PAW_HOME + root + signer copy + its own manager, driven through paw's library since both share one host's
process table) spawns its agent — machine 1 never lists it or its lag, and sleeping across machines fails
"hosted on another machine" (both directions, `--force` and `--after` too); then `paw sleep agent --now`,
the stand-in raised under its own nkey, a raw DM by name resolves to the stand-in, wakes the agent and is
re-delivered (reply in `paw inbox`); teardown. `E2E_HUMAN=<name>` runs it with `mesh add --as <name>` and asserts
the mailbox appears under that name, nobody is `you`, and the replies still reach the inbox. PAW_SPACE
is a decoy local space and PAW_SERVER a dead port, so
any path that ignores `--space` fails instead of touching the live mesh. The cotal-ai package must
be installed OUTSIDE the repo; run with `COTAL_SKIP_CONNECTOR_SEED=1` (the script sets it) or cotal
touches the operator's `~/.config/cotal` seed store.
