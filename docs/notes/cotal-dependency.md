# cotal dependency

Moved verbatim from CLAUDE.md (2026-10-02 split). Index: [CLAUDE.md](../../CLAUDE.md)

## cotal 0.170.0

**Bumped 0.100.0 → 0.170.0 on 2026-11-19, NOT rolled out** (operator's ask for the latest, inside the
7-day min-release-age window: 0.170.0 published 2026-11-19T04:33Z). `minimumReleaseAgeExclude` lists the
eleven 0.170.0 packages by EXACT version, replacing 0.100.0's — **delete it after 2026-11-26**. Same
package set (no renames; core adds `json-schema-library`, drops `acorn`; nats.js deps now pinned exact
3.4.0); bundled nats-server still `@eplightning/nats-server-*@^2.14.0`, broker floor still 2.12. Every
package declares node `>=22.10` (0.115.4, `module.flushCompileCache()`); paw's `engines` follows.
~300 tagged releases (0.100.1–0.170.0); read from `docs/UPGRADING.md` at v0.170.0, the release notes and
the package diffs.

### The three blockers (each needs the operator's decision)

1. **Issued-authority stores created before 0.111 (SPEC 13.15).** Every manager boot runs
   `createEndpointStreams` → `ensureIssuedStores` (open and static meshes alike), and since 0.111 that
   refuses a `KV_cotal_issued_<s>`/`KV_cotal_accepted_<s>` created without `allow_msg_ttl`
   (`IssuedStoreBeforeRetentionError`). 0.85–0.110 managers created exactly those, so every space a 0.100
   paw manager has run — the live `paw` space on the local broker AND `team2027` on the Fly broker —
   holds them, and a 0.170 manager there never comes up. Reproduced on a private broker: a copy of the
   live 0.100 release booted a manager for a test space, `paw down`, then this branch's `paw status` →
   "the manager didn't answer … the issued-authority store cotal_issued_<s> was created before bounded
   retention … never adopted". The reverse is fine (a 0.100 manager boots on 0.170-created stores). The
   upstream fix is a one-time, per-space migration: stop EVERY issuer and resolver of the space (every
   manager on every machine), then `cotal up --space <s> --recreate-issued-stores <backup-dir>` (cotal
   ≥0.113, on a broker that same `up` launches; an embedder calls `removeIssuedStoresBeforeRetention`
   with an `issued-store-recreate` credential), then respawn every static agent — every generation
   issued before is refused afterwards. For `paw` that means paw's own local broker restarted through
   `cotal up` with the flag; for `team2027` the Fly broker runs cotal 0.84, which has no such flag, so
   either the broker moves to ≥0.113 first (a `cotal-host/` change — merging it redeploys the broker)
   or paw runs the embedder call with a cred minted from its signer, with this Mac's AND the MacBook's
   team2027 managers stopped. paw has no command for either yet.
2. **Persona frontmatter `cwd:` is refused (0.165).** `parseAgentFileSource` throws `"cwd" is not
   supported in frontmatter` (and `worktree`) instead of sweeping it into `meta`. `cwd:` is paw's folder
   key in every persona (src/addressing.ts, ~20 files read or write it), so every spawn, wake, restart and
   `cotal_personas` read fails. The parser is in core's `dist/agent-file.js` AND bundled into the claude
   connector's `dist/mcp.cjs` (the seat reads `COTAL_AGENT_FILE`), the hermes connector's
   `dist/launch.js` and the codex connector's `dist/host.js`/`dist/personal.js`. Options: rename paw's
   key (e.g. `folder:`) with a migration of every persona in every space — an older release then reads
   every agent as an orphan, so a rollback needs the reverse migration; or a pnpm patch dropping the two
   keys from the refusal in all five files (the mcp.cjs hunk adds another ~480 KB to the connector patch).
3. **A managed claude launch needs a declared `cotal` MCP server (0.145, Cotal#5852).**
   `claudeConnector.buildLaunch` throws unless `~/.claude.json`'s user-scope `mcpServers` or the seat
   folder's `.mcp.json` names a server `cotal` (cotal: "Claude Code binds the `server:cotal` wake channel
   only to a server its own configuration declares"; `cotal setup` registers it with `claude mcp add
   --scope user`). This Mac's `~/.claude.json` has none, so every spawn is accepted by the manager and
   then dies with nothing in manager.log (paw: "never reached the mesh within 61s — its process is gone").
   Measured on claude 2.1.328 with paw's launch (`--strict-mcp-config` + the `--mcp-config` cotal entry +
   dev-channels), isolated space, haiku: with the assert bypassed and NO declaration an idle agent woke
   on a DM in 4s; with a folder `.mcp.json` declaring `cotal` (assert intact) it woke in 3s. So this
   claude does not need the declaration for paw's launch shape, but cotal refuses without it. Options: a
   user-scope `cotal` entry on every machine that spawns claude seats (global: every plain claude session
   then starts that server too, and its command must point at a path that outlives paw releases), a
   pnpm patch of the assert, or a paw-side launch shape cotal accepts.

Behind both persona and wake bypasses (a scratch copy of the tree, never committed), the suites that
those two block pass: `check:sandbox`, `check:sleep`, `check:kit`, `check:personality`, `check:hermes`,
`check:trust`. So the three blockers are the whole of what stops the claude path; the sandbox item below
is separate.

### Also broken, not a decision

- **Sandboxed seats' control socket.** 0.169 binds a seat's control socket only in a directory owned by
  the user with no group/other bits (`assertControlSocketDir`); `SANDBOX_CONTROL_SOCKET` is
  `/tmp/cotal-control.sock` in the VM, and the VM's `/tmp` is 1777, so a `sandbox: container` seat's
  cotal MCP refuses to start (`check:hub` hit the same refusal on a 0755 fixture dir). Fix: a 0700 dir
  made inside the VM before claude starts (e.g. the VM command wrapped in `sh -c 'mkdir -m 700 … && exec
  "$@"'`). Not done here: it needs a real VM to verify.

### What changed upstream, and what paw did

- **Core patch dropped.** (a) The meta-validator perf fix shipped upstream (0.1xx `ProfileAjv`: one lazily
  built, process-wide Ajv meta-validates; a custom `$schema` stays on the closure's instance — paw's
  design). (b) KV watch consumer deletes: upstream KEPT #691 (no stream-wide `CONSUMER.DELETE` on the
  presence/channels/membership KV for any role) but fixed the symptom differently — #4123: the endpoint
  wraps its connection's `request` and refuses, locally, a delete of its own recorded watch consumer that
  its credential's claims exclude, so nats.js's rebuild delete never reaches the broker (no Publish
  Violation); the consumer is reaped at its 5-minute inactive threshold. #3914: a presence-watch rebind
  now retires its predecessor (paw's endpoint.js hunk). Seats now read the roster and channel registry
  with batched Direct Gets on demand (no watch). `check:kv-consumer-perms` is rewritten for this: the
  grants carry no such delete; a RAW nats.js watch on a minted agent cred still logs the violation (paw
  runs none); a real `CotalEndpoint`'s refused delete reaches the broker log zero times. Residual: a
  rebuilt watch's old `oc_…` consumer lives up to 5 minutes, as upstream intends.
- **Connector patch regenerated** for a MINIFIED `dist/mcp.cjs` (identifiers kept). Both changes are the
  same as on 0.100: the bundled nats.js `_closed` bounds its goodbye flush to 1s, and the Stop hook reports
  `working` + `background: …` via `PAW_BACKGROUND_PROBE` (`idleOrBackground`, `clearBackground`,
  `leaveBackground` inserted after `let promptOpen=false;` inside `createClaudeHandle(deps)`). Made with
  `pnpm patch` + string replacements that must each match exactly once; a unified diff carries whole
  lines, and the transport sits on one 537 KB line, so the patch file is 1.3 MB. Re-key it on every bump
  the same way. `check:nats-reconnect` and `check:sleep` H7 now read the INSTALLED bundle, not the patch
  text; `scripts/e2e-stop-background.ts` (real mcp.cjs, fake claude) passes all six.
- **`@nats-io/transport-node@3.4.0` patch kept.** nats.js 3.5.0 (2026-11-16) no longer awaits the flush on
  a stale link, but cotal 0.170 pins 3.4.0 exactly. Drop both transport hunks when cotal moves to ≥3.5.0.
- **Launch spec** (claude): new `confirmBlockers` (first-run style picker, login method, bypass warning —
  never answered; 0.109.14) and `confirmNotice` (once seats). Runtimes refuse blockers without `confirm`,
  so `headlessLaunch` now drops them with `confirm`/`confirmBefore`/`confirmReady` (`check:headless`).
  `--allowedTools WebFetch(domain:github.com),…` is added; `--strict-mcp-config` still follows
  `mcpServersExclusive`; `--permission-mode bypassPermissions` and the trust `confirmBefore` only when the
  manager passes `cwd` (it does). The seat entry is `dist/seat.cjs` (compile cache under
  `~/.cotal/compile-cache`, not redirected by `COTAL_HOME`; `NODE_DISABLE_COMPILE_CACHE=1` turns it off).
- **Control exchange (0.164–0.169).** Seats get `COTAL_CONTROL_KEY` + `COTAL_CONTROL_VERSION` (in the launch
  material); both ends prove the key and it never crosses the socket; `COTAL_CONTROL_TOKEN` is refused.
  paw's code passes cotal's env through untouched; the test fixtures (`check:hub`, `e2e-stop-background`,
  `e2e-mcp-reconnect`) moved to the key + version and `controlCall`, and the fixture dirs are 0700.
- **`serveClaudeSession`** (the hub): same signature; `runClaudeSeat` added. `check:hub` green.
- **Manager control contract**: cluster revision 37 → 51 (spawn `eventPayloads` input at 49,
  `permissionRequests` gone at 51). paw sends neither; `check:rail` green (ps/inspect/despawn/input), and
  spawns answered in the scratch smoke.
- **Tool payload publication (0.16x)**: Claude seats with an event plane now publish tool inputs and
  results on a separate `EVP_<space>` stream by default. On the open local mesh anyone who can reach the
  broker can read them; persona `eventPayloads: false` (or spawn `--no-event-payloads`) keeps names and
  timings only. paw changes nothing — operator's call. A space whose broker setup predates it has no
  `EVP_` stream: the seat warns and keeps going.
- **Streams**: a space now also has `EVP_<s>` and `KV_cotal_anycast_<s>`; `spaceStreamNames`
  (src/prune.ts) mirrors cotal's `spaceDeletionStreams` again (check:prune caught the two unowned).
- **`probeConnect`** gained `tls-unsupported` (a listener without the required TLS);
  `connectVerdict`/`explainConnectFailure` take it (`check:connect-diag`).
- **workspace**: `createManagerInstanceIdentity(root, space, mint)` takes a mint FUNCTION (check-remote);
  a Cotal home reached through a symlink is refused (`PERMISSION_DENIED … use the physical path`) — macOS
  `tmpdir()` is under `/var` → `/private/var`, so check-boot / check-prune realpath their temp dirs.
  `~/.cotal` is physical; nothing live is affected.
- **CLI**: help's usage line names the runner (`pnpm cotal <command> [options]`; check-spawn-env);
  `supervise` prints a deprecation line (paw keeps it); `cotal up --detach` without `--no-manager` no
  longer exits 1 under cotald (check:boot's canary NOTE) — paw keeps `--no-manager`. `cotal auth …`
  (incl. `auth signer`) lives in `@cotal-ai/auth`, which `cotal-ai` ships and cotald never had — paw's
  hints still point at the standalone `cotal`. The bundled nats-server must not be writable by others
  (paw's releases are 0755 under `~/.paw`; it passes).
- **Unchanged**: #1629 self-exec guard (under `PAW_AUTH=1` delivery still can't start via cotald); opt-out
  telemetry (since 0.109.4 `COTAL_TELEMETRY_DISABLED`/`DO_NOT_TRACK` also reach the agents a manager
  spawns); persona keys other than `cwd`/`worktree` still sweep into `meta`.

### Verification (isolated: temp PAW_HOME/COTAL_HOME/PAW_COTAL_ROOT, PAW_RELEASE=dev, a private nats-server via PAW_SERVER)

- `pnpm install` from an empty node_modules: both patches apply, no ERR_PNPM_PATCH_FAILED; `pnpm typecheck`.
- All 76 `check:*`: green except the blocked ones — `check:sandbox`, `check:sleep`, `check:kit`,
  `check:personality`, `check:hermes` (persona `cwd:`), `check:trust` (wake declaration) — and
  `check:doctor`'s "restart-free (A1)" pair, which compares the manager graph and package.json with
  `origin/main` and fails on any PR that needs a full restart, as a bump does. `check:chat`/`check:commands`
  only fail when the RUNNER sets `PAW_COTAL_ROOT` (they make remote spaces of their own); green without it.
- `check:rail`, `check:loop`, `check:hub`, `check:boot`, `check:kv-consumer-perms`, `e2e-stop-background`: green.
- Smoke (scratch copy with the persona + wake bypasses, haiku): cold `paw dm .` → reply in 7s, `paw status`
  busy → online, idle DM woke it in 3–4s; `paw down` + `purgeTestSpace` left nothing. Unbypassed, the
  same spawn dies silently (blocker 3). `e2e-hub` (scratch, tmux): see the PR.
- NOT run: `e2e-remote` / `e2e-attach-local` (need `COTAL_BIN` from a `cotal-ai@0.170.0` install), a real
  sandbox VM, the live cutover.

### Cross-host

- The team2027 broker (cotal-ai 0.84, nats-server 2.14) meets 0.170's floor (2.12) and serves its
  streams; no client feature needs a newer nats-server. What 0.170 needs from the SPACE is the
  issued-store migration (blocker 1), which the 0.84 broker cannot run.
- A 0.170 manager here beside the MacBook's 0.100 one: cotal's scattered reads (`paw cotal ps`, cotal's
  `attach` locate for a seat on the other host) hit "pinned digests … do not match the served contract"
  (revision 37 vs 51), as with 0.84/0.100 — src/contract-mismatch.ts names it; paw's own rail pins this
  machine's instance and is unaffected. After the issued-store migration the MacBook's 0.100 manager still
  boots (0.100 accepts the TTL'd stores, verified), but its agents' old generations are refused, so it
  respawns them too.
- 0.166: an agent on the new connector leaves a durable channel only through a ≥0.166 delivery daemon;
  team2027's is 0.84, so such a leave is refused (said, not silent). 0.154: role-holder anycast takes need
  a ≥0.154 delivery daemon; paw sets no roles.

## cotal 0.100.0

**Bumped 0.84.0 → 0.100.0 on 2026-10-23** (operator-approved, inside the 7-day min-release-age window:
0.100.0 published 2026-10-23T16:16Z). `minimumReleaseAgeExclude` lists the eleven 0.100.0 packages (the ten
direct ones + transitive `@cotal-ai/seat`) by EXACT version, replacing 0.84.0's — **delete it after
2026-10-30**. Every package has a 0.100.0; nats-server (2.14.0) and the other deps are unchanged. Sixteen
releases (0.85–0.100, ~1260 commits); read from the packages' changesets. What changed, and what paw did:
- **0.85 `LaunchSpec.confirmReady`** (6e10d50): the claude connector now declares input-screen texts
  (`? for shortcuts`, `(shift+tab to cycle)`) so a seat whose claude skips the dev-channels warning
  (channels off by org policy) still starts. Every runtime REFUSES `confirmReady` without `confirm`
  ("startup choices require a final confirmation prompt"), and `headlessLaunch` dropped only `confirm` +
  `confirmBefore` — every headless agent would have been refused at spawn. It now drops `confirmReady`
  too; `check:headless` asserts it, `e2e-headless` spawns one.
- **0.100 signer export moved** (`cotal mint --signer` → `cotal auth signer --out <file>`), and the export
  refuses an `--out` inside any `.cotal/` (LIFECYCLE_BLOCKED). paw's `mesh add` / auth-required hints
  name both forms (the team2027 box still runs 0.84); `e2e-remote` and `e2e-teleport` export beside the
  root and copy in. The file format is unchanged (`e2e-remote` loads it).
- **0.9x CLI output**: `cotal --help` leads with the space state (the "lateral agent coordination" tagline
  is gone — `check:spawn-env` now asserts the usage line); attach ends with a `Detached` report instead of
  `detached from <name>`; multi-manager `cotal ps` puts the count under the `manager <id>` title.
  `e2e-remote`/`e2e-attach-local` parse both forms. paw's own code parses none of these.
- **0.95 opt-out usage telemetry** (b7acdcc, 6999190): `runCli` arms it for every command, so cotald's
  `up` and every `paw cotal <verb>` POST one event to `https://cotal.ai/v1/telemetry` (level `regular`)
  and create `~/.cotal/telemetry.json` in the OS user's dir — `COTAL_HOME` does NOT redirect it, so test
  runs leak it into the real `~/.cotal`. The one-time notice prints only to a TTY stderr. **paw changes
  nothing — operator's call**: `COTAL_TELEMETRY_DISABLED=1` (or `DO_NOT_TRACK=1`) in the daemon env, or
  `paw cotal telemetry off`. Test runs should export `COTAL_TELEMETRY_DISABLED=1`.
- **#1629 self-exec guard: unchanged.** `selfArgv`/`runsCliEntry` still admit only the `cotal-ai` package's
  own entry; there is no hook for an embedder to name its entry. Under `PAW_AUTH=1` `cotal up` still
  reports a degraded control plane, exits 1, and paw adopts the broker (re-verified on 0.84 and 0.100);
  cotal's delivery daemon still doesn't start under paw. (0.100 runs it as the hidden `__daemon-deliver`;
  `cotal deliver` is deprecated — paw invokes neither.)
- **Core meta-validator patch re-keyed and REGENERATED**: 0.100's `dist/schema-profile.js` moved the hunks
  ~70 lines, and pnpm's applier refused the 0.84 patch (`ERR_PNPM_PATCH_FAILED`; `patch -p1` applied it with
  offsets). Same content; upstream still compiles a fresh `Ajv2020` per contract. The new build-time
  `standaloneContractSource` also builds a fresh Ajv — left alone (never on a runtime path).
- **0.91 `up` seeds a default persona** (5263954): `<root>/.cotal/agents/default.md`. For the live `paw`
  space the root is `$HOME`, so the next cold boot writes `~/.cotal/agents/default.md`. paw's personas
  live in `$PAW_HOME/spaces/<s>/personas`, so nothing reads it.
- **0.87 seats outlive their manager on static-auth meshes** (aae54dd, 8fc9dca): the manager writes
  `.cotal/seat-records/<space>/<name>.json`; a successor of the same instance adopts a surviving tmux seat
  (or restarts a `supervise`d one) instead of retiring it. Open meshes record nothing (`!this.auth`), and
  macOS pty seats carry no reference. paw still despawns every agent before stopping its manager, so this
  matters only after a manager crash or a failed despawn — the seat is then taken back, not left
  unmanaged. No change.
- **0.87 history reads use per-connection `hist_<readerId>_<n>` consumers** (c06cf5b, breaking for static
  observer/admin cred FILES minted before 0.87). paw mints a fresh admin/agent cred per command from the
  current core, and its own remote readers (`chat-history`, `inbox-lag`) sign their own named consumers —
  no change. A long-lived cred file minted by 0.84 must be reminted to read history with a 0.100 client.
- Audited, no change needed: launch shape unchanged (`--mcp-config` with a `cotal` server, `--plugin-dir`,
  dev-channels; paw's `--strict-mcp-config`, `--permission-mode`, nice wrapper all still land —
  `check:launch`); 0.86 PreToolUse hook denies `cotal_*` tools from any MCP server but `cotal` /
  `plugin_cotal_cotal` (hub mode rewrites the `cotal` entry in place, so the hub passes); 0.85 numbered
  trust dialog (`check:trust` green); 0.86 spawn acceptances expire / a resubmitted ended goal is refused
  (paw never resubmits); 0.86 `supervise` signal handling (paw runs its own supervise); 0.88 presence
  `runtime` field, 0.100 manager host in presence, empty-bucket snapshots; 0.92.1 tmux `-u`; 0.92.2 bearer
  command names the resolved entry; 0.100 `--creds` without `--server` dials the registered broker (paw
  always passes `--server` for remote); 0.100 `up` refuses a group-writable root (`~` is 0750); 0.86–0.100
  `cotal setup` now installs the cotal Claude plugin user-scope and a Claude Desktop entry (paw never runs
  setup — don't run `paw cotal setup` casually either); no KV/stream config change or migration found.
- Verified (isolated: temp PAW_HOME/COTAL_HOME/PAW_COTAL_ROOT, PAW_RELEASE=dev, own nats-server per run,
  haiku): `pnpm typecheck`; all 48 `check:*` — green except `check:rename` (`bd close` fails) and
  `check:web` (ECONNRESET), both failing identically on main; `check:presence-latch`/`check:prune` failed
  once each on an ENOTEMPTY temp-dir cleanup race and passed on two reruns (and on main); `check:rail`;
  `check:loop`; `check:boot` (cold boot, concurrent boot; the old-argv canary still exits 1). `e2e-headless`:
  one failure ("paw open hl says it is headless") — identical on main. `e2e-hub` (tmux): three shim-count
  failures — identical on main (its `shims()` filter also matches each claude, whose inline `--mcp-config`
  names the shim). `e2e-remote` against a 0.100 broker: all 85 ok. **`e2e-remote` against a cotal 0.84
  broker + delivery daemon (team2027's shape) with paw on 0.100: all 85 ok** (a temp copy with the version
  pin relaxed and `mint --signer`). `e2e-attach-local`: ok. CLI smoke on pty: `paw dm .` cold-starts
  manager + mailbox + agent, reply in 6s; `paw stop`, `paw down` (nothing left); cold `paw start <name>`
  resumes it, second DM answered in 4s; `paw stop` + `paw down` → no process names the temp dir or space.
  PAW_AUTH cold boot and three boot/kill/boot cycles in one root: adopted / clean.
- Cutover (operator's call): `rm -rf node_modules && pnpm install` (the patch re-key — pnpm does not
  re-apply a changed patch over an existing node_modules), `paw release`, `paw restart`. The restart
  despawns every agent under the old manager and brings hub + manager + mailbox up from the new release,
  so no 0.84 manager ever runs 0.100 seats locally; the broker isn't restarted and needs nothing. The
  team2027 broker can stay on 0.84 (verified above); upgrade it at leisure with `auth signer` in mind.
  NOT verified: a 0.84 paw machine and a 0.100 paw machine on one remote space at once.

### KV watch consumer delete patch

2026-10-28, in `patches/@cotal-ai__core@0.100.0.patch` beside the meta-validator hunks. The team2027
broker logged `Publish Violation` for `$JS.API.CONSUMER.DELETE.KV_cotal_presence_team2027.oc_…` and
`…KV_cotal_channels_team2027.oc_…` from `cotal:aleks-mac-mini` and `cotal:vercel`. The connection name
is `cotal:<card name>`, and only an endpoint that watches BOTH buckets logs both. So these are agent-
profile endpoints: the mini's human peer (mailbox / chat / web under `--as aleks-mac-mini`) and an
agent named `vercel`. A manager watches presence only, under its own card name.
- **Cause:** a KV watch is a nats.js ordered push consumer `oc_<nuid>_<serial>`. Each rebuild (two missed
  30s heartbeats, a sequence gap) deletes the predecessor before creating `_<serial+1>`. cotal 0.100
  deliberately minted no CONSUMER.DELETE on those streams (#691), because the name can't be pinned in a
  grant: the only grant that can express it covers the whole stream. So every rebuild was refused, and
  the old consumer stayed for its 5-minute inactive threshold. cotal swallows the refusal client-side
  (`isOwnWatchDelete`), but the broker still logs it and still holds the consumer.
- **Patch (dist/provision.js):** `$JS.API.CONSUMER.DELETE.<stream>.>` only for the KV streams each long-lived
  role watches. `agent` gets presence + channels. `observer`/`admin` get presence + channels + membership.
  `supervisor` (the local AND the signer-backed remote paw manager) gets presence. Nothing else changes:
  no stream purge/delete, and no CHAT/DM/DLV/TASK/manager-KV consumer delete. Those streams hold only
  ordered watch consumers, with no durable on them.
  **Residual (why upstream said no):** a holder can delete a peer's watch cursor on those buckets.
  The peer's ordered consumer rebuilds itself on its next missed heartbeat, so that is a self-healing
  roster/registry stall, not data access. `operator`/`deployer`/`teardown` are one-shot and untouched.
- **Patch (dist/endpoint.js):** `rebindStalePresenceWatch` ("presence watch silent … rebound") stopped the
  old watch and never deleted its consumer. It now deletes it the way `retireDeliveryLeaseWatch` already
  does (#3966). The seat's cotal MCP server (`mcp.cjs`) bundles its own endpoint code and does not get
  this hunk. Its nats.js rebuild deletes do work, because the permission lives in the JWT the manager mints.
- **Proof:** `pnpm check:kv-consumer-perms` runs a private JWT + TLS broker (cotal `serverConfig`, a
  self-signed cert, its own log file). For each role it opens a watch the way `kv.watch()` does and drives
  nats.js's own `reset()`:
  1. With the grant minus the new rows (0.100 as shipped), the violation and the leftover `_1` reproduce.
  2. With the patched `mintCreds` grant, `_1` is replaced by `_2`, there is no violation, and stop + delete leaves nothing.
  3. The patched cred still can't delete a consumer on CHAT/DM/the manager KV or on a bucket it doesn't
     watch, and can't purge or delete the KV stream.

  The broker log is counted at the end. A one-off run with a real `CotalEndpoint` (agent cred, card
  `vercel`) on a `cotal up --no-manager` JWT + TLS broker: the rebind deleted the old consumer, with zero
  violation lines in the broker log.
- **Takes effect** only for creds minted by patched code; agent/observer/admin JWTs carry no expiry.
  Each machine hosting team2027 peers has to:
  1. pull, then `pnpm install` (verify `grep -c "paw patch" node_modules/@cotal-ai/core/dist/provision.js` = 6);
  2. `paw release`;
  3. `paw restart --space team2027`. The new manager's supervisor cred and fresh seat creds come from it.
     The mailbox's agent cred too.

  Also restart `paw web` and any open `paw chat` there, since they mint their own creds at start. The
  fly broker needs nothing: permissions live in user JWTs signed by the space account. A non-paw cotal
  host on the space, such as the `vercel` agent if a plain-cotal box runs it, needs the same cotal patch.

## cotal 0.84.0

**Bumped 0.81.1 → 0.84.0 on 2026-10-16** (operator-approved, inside the 7-day min-release-age window:
0.84.0 published 2026-10-16T19:38Z). `minimumReleaseAgeExclude` lists the eleven 0.84.0 packages by
EXACT version (replacing 0.81.1's) — **delete it after 2026-10-24**. What changed, and what paw did:
- **0.84 `up --detach` exits 1 on a degraded control plane** — found by the 2026-10-20 reboot (the login
  `paw start` failed every cold boot). paw now passes `--no-manager`; see
  [lifecycle.md#srclifecyclets](lifecycle.md#srclifecyclets) ("Cold mesh boot"). Under `PAW_AUTH=1` the
  delivery daemon still can't start via cotald (cotal's #1629 self-exec guard) — open upstream gap.
- **0.84 native MCP discovery** (#3943, `feat(claude)!`): the claude connector drops
  `--strict-mcp-config` unless the launch is exclusive (`LaunchOpts.mcpServersExclusive`, or a carried
  home); the manager sets it only when the persona names `shareTools:`. So every paw agent WITHOUT
  `shareTools:` would have booted the operator's user/project/plugin/claude.ai MCP servers too —
  against paw's contract (cotal + `paw mcp`-shared servers only). `pawConnector` now calls
  `claudeConnector.buildLaunch({ ...opts, mcpServersExclusive: true })`. `check:launch` already
  asserted `--strict-mcp-config` and failed without the fix; verified live on a spawned claude's argv.
- **0.82 `serveClaudeSession` shipped upstream** (#3921 — davidfarah2003's rework of #2401, exported
  from `@cotal-ai/connector-claude-code/mcp`, `default` → `mcp.cjs`, types `mcp.d.cts`). The
  connector patch is DROPPED. What paw's patch had beyond upstream, and where it went: `log` option →
  `attributeSessionStderr` in `src/hub/daemon.mjs` prefixes stderr written inside a session's
  `sessionContext` (lines cotal writes from MCP transport callbacks stay unprefixed); input EOF →
  upstream DOES call `onShutdown` on input end/close, so the hub sends the exit line only when
  `sock.readableEnded` is false; `import` condition → not needed (the hub `createRequire`s);
  realpath entry check → not needed (upstream's guard is `require.main === module`, false under the
  ESM hub); AG-UI close bounded at 5s → NOT carried: upstream `close()` awaits `events.close()`
  unbounded — the hub's existing 5s leak counter (restart past 5 leaked closes) is the backstop.
- **Core meta-validator patch re-keyed unchanged** (applies cleanly; 0.84.0's `compileWithinBudget`
  still builds a fresh `Ajv2020`). pnpm did not re-apply a changed `patchedDependencies` over an
  existing node_modules ("Already up to date", even with `--force`) — `rm -rf node_modules` first.
- **0.83 connector-store downgrade refusal** (#3941): a cotal executable older than the connector
  store refuses every backward migration. Only `cotal setup`/seeding touches that store; paw never
  runs it, so rolling back to a 0.81.1 release is not blocked — but do not run `paw cotal setup`
  from an older release after 0.84 seeded the store.
- Audited, no change needed: 0.82 `connectOrThrow` throws `ConnectRefusal` on user-auth meshes (paw
  imports neither); 0.82 MCP server launched with `--optimize-for-size --max-semi-space-size=1` (#2403,
  ours — `routeCotalToHub` replaces the whole `cotal` entry in hub mode); 0.82 `cotal_status`
  activity-only fix; 0.82 opencode `serve.<token>.pid` records; 0.82.1 macOS identity-pin parse fix
  (0.82.0's pin regression never shipped to paw); 0.84 vanished mesh records read as absent;
  `pnpm typecheck` clean.
- Verified (isolated: temp PAW_HOME + cotal root, PAW_RELEASE=dev, own nats-server per run, haiku):
  typecheck; all 39 hermetic `check:*`; `check:loop`; `check:rail` with `PAW_RAIL_SPAWN=1` (real claude
  up in ~2.7s, despawned); `e2e-hub` on tmux (3 agents on shims, DMs, #general wake, hub SIGKILL and
  full hub+supervisor outage with mesh ids unchanged, status, sleep/wake, `paw restart`, `paw down` —
  all green); CLI e2e on pty: `paw dm . "reply with just: ok"` in a fresh git folder → agent idle in
  ~7s, replied "ok" by 13s; its claude argv carried `--strict-mcp-config` and `--permission-mode
  bypassPermissions` under `nice -n 10`; `paw down` → nothing left naming the space. The live `paw`
  hub/manager/mailbox pids were the same before and after.
- NOT verified / open: the live cutover (`rm -rf node_modules && pnpm install` + `paw release` +
  `paw restart` — operator's call); a real claude trust dialog on tmux (pre-trusted folders only).
- **Upstream-able gap (2026-10-19): `cotal send dm|ask` is unreplyable.** The one-shot sends from a fresh
  principal per run with no inbox and no presence, yet carries a human-looking `<login>@<host>` name, so
  an agent that replies (as briefed) stores the reply where nobody reads it. Not a join bug — headless
  `cotal join` prints DMs addressed to it in full. paw warns at `paw cotal send` (`oneShotReplyNote`); no
  patch. → [messaging.md#replies-to-a-one-shot-cotal-send-the-headless-join-missing-dms](messaging.md#replies-to-a-one-shot-cotal-send-the-headless-join-missing-dms)

## cotal 0.81.1

**Bumped 0.72.1 → 0.81.1 on 2026-10-14** (operator-approved, inside the 7-day min-release-age window:
0.81.1 published 2026-10-13T17:06Z). `minimumReleaseAgeExclude` lists the eleven 0.81.1 packages
(the ten direct ones + transitive `@cotal-ai/seat`) by EXACT version — **delete it after 2026-10-20**.
Every package has a 0.81.1; no other dependency was blocked by the gate. What broke, and what paw changed:
- **0.80 managed seats default to `--permission-mode bypassPermissions`** (#3834): the claude connector
  adds it unless its own launch options name a mode. paw's connector appended its own mode only when
  not `default`, so `PAW_PERMISSION=default` would silently have run bypass. paw now drops cotal's
  pair and ALWAYS passes its own `--permission-mode` (`default` included). `check:launch` asserts
  exactly one flag per mode.
- **0.80 managed workspace trust** (5417401): the connector no longer refuses an untrusted seat dir;
  it declares `confirmBefore` (Down onto "Yes, I trust this folder", then Enter) and every runtime
  (pty, tmux, cmux) answers it before the dev-channels Enter, each step once and in order. Two
  consequences: (1) every runtime REFUSES `confirmBefore` without `confirm`, and `headlessLaunch`
  dropped only `confirm` — a headless agent would have been refused at spawn; it now drops both.
  (2) paw's tmux poll also pressed Down+Enter at the trust dialog, which races cotal's sequence (a
  double Down, or a key clearing the step cotal waits on → seat ended at 15s). paw's poll is now
  read-only (`readStartupPrompt`); it still re-writes an erased `~/.claude.json` entry and names the
  screen in the timeout error. `spawnPinned`'s retry on "Claude home does not trust" went with the
  refusal. `check:trust` now drives cotal's real `confirmWatch` with the connector's own
  `confirm` + `confirmBefore` beside paw's poll on a fake claude and proves the pair boots.
- **Hub patch re-keyed** to `@cotal-ai/connector-claude-code@0.81.1` (#2401 still open; the PR branch
  was rebased onto d759b79 but 0.81.1 does not ship it). Rebuilt on 0.81.1's main(), which changed a
  lot: control socket bound and awaited BEFORE `agent.start()` (custody claim, 15d10c9), the
  `waitForEventConnection` gate (no 20s `whenConnected` timeout), one transcript source per holder,
  `eventPlaneStopped` no longer stops the seat (the plane re-establishes itself, fded3ab — so
  `onShutdown(1)` no longer happens), `envFlag`/`eventPlaneArmed(config, env)`. Kept paw's extras
  over the PR: `log` option, `import` condition on `./mcp`, realpath entry check, input EOF closes
  the session WITHOUT `onShutdown` (the hub must not send a shim its exit line on a dropped socket),
  AG-UI holder close bounded at 5s. Startup failure closes what started (the PR's try/catch).
- **Core meta-validator patch re-keyed unchanged** (applied cleanly with offsets): 0.81.1's
  `compileWithinBudget` still builds a fresh `Ajv2020` per compile.
- **0.76 local inbox custody** (15d10c9): `MeshAgent.start()` takes a per-process O_EXCL lock keyed by
  (servers, space, principal, lifecycleUid) under `~/.cotal-consumers/`. The hub serves many sessions
  in one process, each with its own lifecycleUid, so they don't collide; a killed hub's locks are
  reclaimed by pid. Exercised by the hub-kill e2e below.
- **0.76 control socket no longer unlinked before listen** (15d10c9, "never unlink an existing path:
  it may belong to a live listener"). The hub serves each session on the socket path from its LAUNCH
  env — the same path on every shim reconnect — so after a hub SIGKILL every session's restart hit
  `EADDRINUSE` and the agent stayed OFFLINE (reproduced: the e2e's DM after the kill went unanswered
  for 180s). `clearDeadSocket` in `src/hub/daemon.mjs` now probes the path before
  `serveClaudeSession`: a refused connect proves it dead → unlinked; a live listener is left for
  cotal's own refusal; any other probe error throws. `check:hub` covers absent/live/SIGKILLed/non-socket.
- Audited, no change needed: 0.74 `Pane.confirm` removal (layout panes only; paw sets none); 0.74
  strict `COTAL_CHANNEL`/`COTAL_EVENTS` parsing (paw sets neither; the hub forwards cotal's own env);
  0.77–0.81 spawn-field refusals (`bad-request` on blank `model`/`cwd`/`agent`… — paw sets them only
  when non-empty); 0.79 strict `spawn`/`spawn.env` config reader (live `~/.config/cotal/config.json`
  loads under 0.81.1's `loadCotalConfig`: `connectors` only, 3 MCP servers); `takeCodePoints` and
  auth-plane API changes (paw imports none); `pnpm typecheck` clean with no source change.
- Verified (isolated, PAW_RELEASE=dev, own nats-server per run, temp PAW_HOME/space/cotal root,
  haiku): typecheck; all 35 hermetic `check:*` (check:web flakes ~1 in 2 with `fetch failed:
  ECONNRESET` right after its company-route server is closed and reopened on the same port — a
  keep-alive race in the test, unrelated to cotal; it passes on rerun); `check:loop`; `check:rail`
  with `PAW_RAIL_SPAWN=1` (real claude spawned in ~3s and despawned); `e2e-hub` on TMUX (3 real
  agents on shims, DM + #general wake, DMs during a hub SIGKILL and during a full hub+supervisor
  outage, mesh ids unchanged, sleep/wake, `paw restart`, `paw down` — all green); and a CLI e2e on
  pty: `paw hub on`, `paw dm . "reply with just: ok"` in a fresh git folder → agent live in ~6s,
  replied "ok"; presence stream `KV_cotal_presence_<space>` is `storage: memory`; SIGKILL of the hub
  daemon only (supervisor kept its pid) → new hub, "cleared a dead control socket", agent rejoined in
  ~2s and answered a DM; `paw sleep --now --force` → asleep with 0 shims; a DM woke it (new
  session, answered in ~12s); `paw down` + `removeMesh` → 0 processes left. The live `paw`
  hub/supervisor/manager/mailbox pids were the same before and after every run.
- NOT verified / open: the live cutover (`pnpm install` + `paw release` + `paw restart` in the
  operator's checkout — operator's call); tmux runtime against a REAL claude trust dialog (the e2e
  folder was pre-trusted, so cotal's trust replies were exercised only against the fake in
  `check:trust`); `purgeTestSpace`/`paw spaces prune` named in CLAUDE.md do not exist in this tree —
  teardown was `paw down` + `removeMesh` + killing the private broker (its store was a temp dir).

## cotal 0.72.1

**Bumped 0.66.1 → 0.72.1 on 2026-10-07** (operator's ask, inside the 7-day min-release-age window:
`minimumReleaseAgeExclude` lists the ten 0.72.1 packages by EXACT version — delete it after
2026-10-14). What broke, and what paw changed:
- **0.69 spawn `shareTools` is a LIST** (manager cluster doc rev 22). paw sent the persona's flag
  string (`none`, `a,b`) and the manager refused it — "shareTools: expected an array of strings" —
  so every kit agent (`shareTools: none`) and every `paw mcp share`-scoped agent would have failed to
  spawn. The spawn site now sends core's `parseShareSelection(share)`; the persona keeps the string.
- **0.71 tmux/cmux runtimes own the dev-channels gate**: they read the pane, press Enter ONCE when the
  connector's `confirm` text shows, and END the seat if it hasn't shown within 15s. paw's
  `answerStartupPrompt` also pressed Enter there; a paw Enter landing first clears the gate before
  cotal's 250ms read sees it, and cotal then kills a healthy seat at 15s. paw no longer types at the
  gate (it still answers the trust dialog, and `cause()` names a seat stuck at the gate).
  `check:trust` runs core's `confirmWatch` beside paw's poll on a fake claude to prove the pair boots.
  RISK, upstream's call: a claude that takes >15s to reach the gate (a loaded box — the 2026-08-17
  telegram boot took ~90s) is now ended by cotal, where paw used to rescue it.
- **0.68 untrusted seat dir refused before launch** (`LaunchOpts.cwd`, the manager's ~/.claude.json).
  paw pre-trusts the exact canonical cwd, which the check accepts. The 2026-10-03 race (a booting
  claude rewrites ~/.claude.json and erases the entry) now surfaces as that refusal instead of the
  dialog, so `spawnPinned` re-writes the entry and retries ONCE on "Claude home does not trust".
- **0.68 launcher-resolved model**: connectors no longer read the persona's `model:`. The manager
  resolves flag-else-persona itself; paw's one direct `buildLaunch` caller (`paw claude --fg`) now
  passes `resolveModel() ?? readModel(configPath)`.
- **Hub patch re-keyed** to `@cotal-ai/connector-claude-code@0.72.1` (#2401 still open) and rebuilt
  on 0.72.1's main(): per-session `wake` + `createClaudeHandle({surfaced})`, the named-hooks
  `AguiEmitterHolder` with `eventPlaneStopped` (its stopSeat closes the session and calls
  `onShutdown(1)` — `mcp.cjs` exits 1 as upstream does), channel detection on `oninitialized`. Plus the
  #2401 review fixes: `./mcp` export has an `import` condition; the entry check is `require.main ===
  module` OR realpath(argv[1]) === realpath(__filename); the control env is read BEFORE the agent
  starts (a throwing `controlFromEnv` no longer leaks a joined agent); `close()` closes the AG-UI
  holder (bounded 5s) and stops the wake policy. `onShutdown` now receives the exit code.
- Audited, no change needed: 0.71 role grammar (paw sets no roles; no live persona has `role:`);
  0.71 whitespace model refused (no blank `model:` in live personas); 0.71 `spawn.env` COTAL_ names
  (live config has no `spawn.env`); 0.69 MCP-server reader — the live `~/.config/cotal/config.json`
  loads under 0.72.1's `loadCotalConfig` (3 servers; command/arg paths exist); 0.70.1 hook relay
  (bundled in the connector, nothing for paw to import); 0.70 `peerLabel`/`controlReplyFrom`.
- Verified (isolated: own nats-server per run, temp PAW_HOME/space/cotal root, PAW_RELEASE=dev,
  haiku): typecheck; all 33 hermetic `check:*`; `check:rail` with `PAW_RAIL_SPAWN=1` (real claude
  spawned in 4s, despawned); `check:loop`; `e2e-hub` on TMUX (3 agents on shims, DM + #general wake,
  hub SIGKILL gap, sleep/wake, `paw restart` CLI, then `paw down --space <test>` CLI — the
  dev-channels gate answered by cotal alone); `e2e-headless` (claude -p woken by the hub, restart
  resumes); kit e2e (`~/.paw/bin/kit`, fake provider; `paw chat --agent kit` born with `shareTools:
  none` comes up — the list fix); `e2e-sleep`; `e2e-stale-forward`; `e2e-unmanaged` (0.72.1 spares a
  tmux agent across a manager stop). The live `paw` manager/mailbox/hub pids were the same before and
  after every run.
- NOT verified / open: a `>15s` boot to the dev-channels gate under real load (cotal now ends that
  seat — not reproduced); a 0.66.1 → 0.72.1 cutover of a live-shaped fleet (`paw release` +
  `paw restart` were not run — operator's call); `e2e-headless`'s "paw open hl says it is headless"
  fails on a stale expectation from bfb66ed (open now prints a status summary), unrelated to cotal.

### core meta-validator patch
`patches/@cotal-ai__core@0.72.1.patch` (2026-10-09, perf only). Every contract compile in
`schema-profile.js` built a fresh `Ajv2020`, and a fresh instance re-compiles the 2020-12 meta-schema
the first time it validates a schema — ~90% of each compile, paid 66 times by a cold full resolve of
the manager (33 commands × input/output) and enough to trip the `! schema: compile took …` note on a
loaded host. The patch keeps the per-closure fresh instance with the exact `AJV_PROFILE_OPTIONS` (so
members/`$id`s never leak between closures) and overrides only ajv's `validateSchema` hook on it: a
document whose `$schema` is absent or a key every instance is born with is meta-validated by ONE
lazily-built, process-wide `Ajv2020` that never registers caller documents; any other `$schema` (e.g.
one naming a closure member) takes ajv's own path on the per-closure instance, as before. Because the
hook fires where ajv always called it, error precedence is unchanged (a nested bad `$anchor` still
reports `invalid anchor` before `schema is invalid`). The timing note is untouched; the first compile
in a process still pays the one meta-schema compile inside its window.
- Measured (one host, unloaded, 7 cold processes each, medians): the 66 real manager contracts
  compile in 412ms → 83ms (per-compile median 5.6 → 0.56ms; first compile ~25ms both); a cold
  `resolveService` of the manager is 441ms → 113ms wall, 659 → 183ms CPU. Meta-schema compiles per
  process: one per contract → 1.
- Semantics: 31-case before/after diff (valid verdicts + errors, refusals and their exact messages,
  member `$ref`, same `$id` across closures, `$schema` naming a member/unknown/non-string, error
  order) — identical except the meta-compile count.
- NOT done: routing `resolveService` through `createCompiledContractCache`. Upstream compiles each
  command's validators separately on purpose (endpoint-invoke.js "a compiled contract is not shared"),
  an ajv validator carries mutable `.errors`, and paw's long-lived processes already resolve once
  (`sharedManagerControl`); after this patch a whole resolve's compiles cost ~80ms.

**Bumped 0.58.0 → 0.66.1 on 2026-10-05** (operator's ask, inside the 7-day min-release-age window:
`pnpm-workspace.yaml` `minimumReleaseAgeExclude` lists the ten 0.66.1 packages incl. transitive
`@cotal-ai/seat` by EXACT version — delete it once 0.66.1 is a week old). What it took:
- **Hub patch re-keyed** to `@cotal-ai/connector-claude-code@0.66.1` (#2401 still open). Hand-applied
  to the published dist: export prologue + `serveClaudeSession` + `main()` as a thin caller, keeping
  0.66.1's unmanaged `cotal_how_to_join` server and its stdin-EOF shutdown (the hosted session closes
  on input `end` too). Re-key it on every bump.
- **0.59 launch material** lives in per-launch `cotal-*` temp dirs owned by the launcher. The manager
  forks a reclaim watcher (`/bin/sh -c p=$$ n=$1…`) that then `exec`s claude, so the watcher is a
  CHILD of claude for its whole life — `paw sleep`'s shell gate read it as a running shell and
  refused every sleep; `shellDescendants` now skips it. `paw-brief.md` (beside the persona file) lives
  in that dir and is reaped with it — fine, it's per launch. `paw claude --fg` is its own launcher:
  it now wraps the spec with core's `reclaimWithChild` so its dirs are removed after exit.
- **0.59 repeated flags error**: audited — paw never emits a flag twice (`withDefaultSpace` skips an
  operator `--space`/`--space=`; `up`/`supervise` argv are built once).
- **0.59 cotal_dm `replyTo`**: a DM is refused when the recipient holds unanswered messages from one
  peer across SEVERAL conversations (`contextId`). paw's `you` (dm/chat/web) sends no `contextId`, so
  replies to `you` are never refused (e2e: 3 separate `paw dm`s, one reply, no refusal). A peer that
  does use two contexts gets the refusal with the id list; haiku re-sent with `replyTo` on its own.
  No brief change needed.
- **0.62 manager stop** despawns pty agents itself; paw's explicit pre-stop despawn stays (tmux rows,
  older managers). **0.66 `headState`→`gateState`**: paw never reads either; `isStaleRefusal` still
  matches 0.66's epoch refusal ("bound to epoch N … this incarnation is not the one it resolved against").
- Verified live (isolated, haiku): >48k DM delivered (arrives as a hook file the agent `Read`s — one
  haiku then treated every later channel push as prompt injection, for the rest of its session);
  claude SIGKILL → its `mcp.cjs` exits on stdin EOF and leaves the mesh (0.66.1); a second
  `supervise` from the SAME cotal root exits 1 ("already serves space"); paw restart/down/sleep/hub
  e2e; a 0.58 release (tmux + hub, 2 agents) cut over by a 0.66.1 `paw release` + `paw restart` in 12s,
  both agents revived on shims. NOT fixed: a second `supervise` from a DIFFERENT root
  (PAW_COTAL_ROOT) still comes up beside the first and both serve the space (the 0.63 split-brain
  exit did not fire within 60s; upstream b54103a8).
- Found on the way: `paw down` ignored `--space` (stopped the default space — fixed, `downSpace`);
  the hub daemon exited 0 forever under a symlinked PAW_HOME (main guard compared unresolved argv[1]).

## cotal 0.58

**Bumped 0.48.1 → 0.58.0 on 2026-10-02** (5401a20; all `@cotal-ai/*` pinned EXACT and coherent).
What broke and how paw answered (details in the commits — cacc445, 5401a20, 802ad0d):
- **`eventChannel` is inherited, never hand-copied.** 0.5x refuses to start a seat whose connector
  lacks `eventChannel` ("does not publish an AG-UI event plane"); `pawConnector` used a hand-copied
  subset of the claude connector's fields, so every spawn failed. It now spreads `...claudeConnector`
  and overrides only `name` + `buildLaunch` (src/connector.ts), so new upstream capabilities travel.
  `check:launch` asserts every claude capability is inherited.
- **`workspaceRoot` is required by `buildLaunch`** (the event write-ahead log's home). The manager
  passes its own; paw's one direct caller, `paw claude --fg` (src/claude.ts), passes
  `pawCotalRoot(space)`. A mesh-registry record must also carry `ts`.
- **Since 0.49 a manager SIGTERM SPARES its agents** — they keep running and stay on the mesh, the
  next manager's ps is empty (no adoption), and paw's two-writer guard then refuses to revive them.
  `stopOwnedManager` therefore DESPAWNS every listed agent first (`despawnManagedAgents`, parallel,
  failures named), waits on the rows' pids (a despawn reply is not exit proof), then signals; the
  signal wait is 15s because a clean 0.5x stop deregisters its service instance.
- **`ensure()` never switches the manager's runtime implicitly** (802ad0d): a plain `paw status`
  during the cutover saw a stray pty manager beside the tmux one, read it as a mismatch and
  "switched" — despawning all 25 agents. Now a mismatch only WARNS; only `paw runtime <r>` or an
  explicit `PAW_RUNTIME` restarts into another runtime.
- `paw sleep` landed on 0.58 — see [sleep.md](sleep.md).

## cotal dependency
**paw is on cotal 0.48.1 (bumped from 0.25.0 on 2026-09-08, operator's ask).** Type-clean and every
hermetic suite green on the first try — and, as with 0.25, that proved NOTHING about the wire. What the
isolated end-to-end (`PAW_HOME=/tmp/… PAW_SPACE=up048 PAW_RELEASE=dev paw dm <folder>`) found:
- **Every seat exited 1 at launch, silently, under pty.** cotal ≥0.48 hands claude the agent-file
  persona as `--append-system-prompt-file <tmp>`; paw merged its brief into `--append-system-prompt`;
  claude refuses the two together ("Cannot use both …"). The pty runtime shows no output and the
  manager logs only `seat reaped … exit code 1`; the answer came from running the connector's own
  `LaunchSpec` under node-pty and reading claude's stderr. `appendSystemPrompt` (src/connector.ts) now
  writes a paw-owned sibling `paw-brief.md` (persona + brief) beside cotal's temp file and re-points the
  `-file` flag at it — never mutating cotal's file (cotal reaps it), never a second flag. `check:launch`.
- **`subscribe` must be explicit** (since 0.33): an omitted `subscribe` meant `[general]` and now means
  NO channel (and `saveAgentFile` refuses a persona without one). `GRANT_LINES` gained
  `subscribe: [general]`; the per-key self-heal adds it to every existing persona on its next spawn, an
  explicit narrower list is kept. Verified: a `#general` broadcast reached the 0.48 agent (CHANNELOK).
- **Seats get a CONSTRUCTED env** (0.31): PATH/HOME/locale + COTAL_* + connector-declared credential
  names, not the manager's ambient env. paw's connector env (BEADS_DIR, BEADS_ACTOR) still reaches the
  seat — verified with `ps -E` — and the harness-marker leak is closed upstream too (paw keeps
  `stripHarnessMarkers` for the daemons themselves).
- Upstream fixes that retire paw workarounds' CAUSES (keep the workarounds, they're cheap): a stalled
  presence-KV watch no longer sweeps the roster offline; the manager no longer exits over its lease;
  channel join-backfill is pull-only (no replay storm); one spawn `--resume` flag preflighted per connector.
- The control contract is unchanged in shape (`ps`/`inspect`/`spawn`/`despawn`/`attach`, `SPAWN_INPUT_SCHEMA`
  still carries `agent`, `config`, `cwd`, `shareTools`) — `check:rail` answered from three processes.
- Standalone `cotal` (get.cotal.ai launcher at `~/.local/bin/cotal`, `~/.local/share/cotal`) was
  updated the same day via `cotal update --self` + `cotal update` (connectors reconciled to 0.48.1); a
  stale bun-global `cotal-ai@0.15` that shadowed it on PATH (`~/.bun/bin/cotal`) was removed.
- NOT verified live on 0.48: codex/opencode seats (`agent:` pin), cmux runtime, PAW_AUTH. The
  isolated repro dir pattern (`/tmp/paw048`, tmux variant `/tmp/paw048t`) + `removeMesh` teardown is the
  cheapest way to check a bump before cutting the live fleet over.

**cotal was first PUBLISHED on npm** (`@cotal-ai/{core,cli,workspace,manager,connector-claude-code,tmux,cmux}`,
currently **v0.11.3**), so paw consumes it via published semver deps (`^0.11.3`) — no local checkout
required to install (`pnpm install` resolves straight from the registry; switched 2026-06-30).
**0.11 owner+actor PRINCIPAL grammar (migrated 2026-07-13, the BIG breaking change):** a mesh identity is
now a two-token `(owner, actor)` **principal**; `AgentCard.id` = its **dot-form `<owner>.<actor>`** (open
mesh owner = `DEV_OWNER` = `"local"`, actor = the connection nkey) — and that dot-form is what `unicast`/DM
address, `presence.card.id` carries, and `msg.from.id` stamps. **Tokens must be NATS-safe `[A-Za-z0-9_]`
— NO dashes.** Three paw fixes: (1) `stableHumanId` minted a dashed `randomUUID()` → rejected on connect
("invalid owner/actor token"); it now strips dashes (`humanIdToken`) and migrates a legacy `human.id` in
place. (2) The manager's ps/start reply `id` is the **RAW nkey** (a durable/teardown key), NOT the wire
principal — paw fed it straight to `unicast` → "not a valid recipient principal". `wirePrincipal(id)`
(exported, addressing.ts; mirrors the manager's own `managedPrincipal`) derives the dot-form (`local.<nkey>`
if dashless, pass-through if already dotted); `ensureAgentSpawned` returns it, and `paw status`'s inbox-lag
`parsePrincipalKey(wirePrincipal(id))`s the ps nkey before `dmDurable(owner, actor)` (the durable is now
`dm_<owner>-<actor>`, not `dm_<id>`). (3) DM delivery is JetStream in 0.11, and an agent publishes PRESENCE
**before** it runs `ensureStreams`, so a send right after presence can hit a not-yet-created DM stream
("jetstream is not enabled"). `paw dm` waits for presence on a fresh spawn (`readyId`) AND retries the send
on that transient (`unicastResilient`, ~6× 800ms) — cold `paw dm <newfolder>` then delivers. Verified live
on an isolated 0.11 mesh: cold spawn+dm → agent consumes → replies to the "you" inbox, status inbox-lag ✓.
**0.9 control-plane breaking change:** the cred **profile** `"manager"` was removed from the `Profile`
union and split into tiers — `"control-caller-privileged"` (ps/start) and `"control-caller-admin"`
(stop/attach). The control SUBJECT names are unchanged (`CONTROL_PRIVILEGED === "manager"`,
`CONTROL_ADMIN === "admin"`), so `requestControl(subject, …)` was untouched; only `mintCreds(…, profile)`
in `controlCreds`/`probeCreds` moved to `"control-caller-privileged"`. CAVEAT: under `PAW_AUTH=1` a
cross-agent stop (stopAgent/restartAgent) rides the privileged-tier cred on an ADMIN subject and is
under-privileged; open mesh (default) is unaffected (undefined creds). Per-tier creds are the follow-up
if the auth path ever needs stop. paw
depends on cotal only as *packages* (code-level imports), NOT a binary it shells out to, and is **fully
fork-free** — the upstream packages are vanilla. The last custom commit, `feat(cli): re-export lifecycle
helpers` (re-exported `startMeshDetached`/`ensureManager`/`managerUp`), was **dropped 2026-06-29**: paw no
longer imports any of them — `344afc0` (daemons-via-tsx-bin) made paw DRIVE cotal's registered
`up`/`supervise` commands instead of importing the helpers, so the shim became dead code (recoverable at
`86c1b68` if ever needed). The only cotal-`@cotal-ai/cli` import left is `runCli`, a stock upstream
export — and since the endpoint-native rewrite it lives ONLY in `bin/cotald.ts` (the subprocess-only
composition root); the `paw` CLI process imports just @cotal-ai/core (+ workspace via addressing). **PR #43 (per-agent cwd) MERGED** 2026-06-25 as `b786fcf`: the manager owns the cwd and passes it
to `runtime.spawn`, NOT to the connector's `buildLaunch` (no `cwd` on `LaunchOpts`), so paw's cwd
confine+pre-trust lives in `src/cwd.ts` (spawn site). Was paw's last reason to fork; now upstreamed.
**v0.8 / #120** split the machine-local workstation layer (auth paths, mesh registry/target, preflight)
out of `@cotal-ai/core` into a new package **`@cotal-ai/workspace`** — so paw depends on it too and imports
`authDir`/`findCotalRoot`/`loadSpaceAuth`/`saveSpaceAuth` from there (`mintCreds`/`newIdentity`/
`createSpaceAuth`/`isReachable` stay in core). **Caveat:** a just-published cotal version can be held for a
few days by a registry min-release-age policy (supply-chain guard); it's an explicit dep, so override the
gate or pin to the latest cotal release older than the window. The daemons still run node+tsx
(`cotalViaTsx`) regardless of how cotal is installed.
