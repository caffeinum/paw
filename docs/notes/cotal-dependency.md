# cotal dependency

Moved verbatim from CLAUDE.md (2026-10-02 split). Index: [CLAUDE.md](../../CLAUDE.md)

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
