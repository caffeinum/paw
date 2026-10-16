# cotal dependency

Moved verbatim from CLAUDE.md (2026-10-02 split). Index: [CLAUDE.md](../../CLAUDE.md)

## cotal 0.84.0

**Bumped 0.81.1 → 0.84.0 on 2026-10-16** (operator-approved, inside the 7-day min-release-age window:
0.84.0 published 2026-10-16T19:38Z). `minimumReleaseAgeExclude` lists the eleven 0.84.0 packages by
EXACT version (replacing 0.81.1's) — **delete it after 2026-10-24**. What changed, and what paw did:
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
