# paw CLI, commands and fleet verbs

Moved verbatim from CLAUDE.md (2026-10-02 split). Index: [CLAUDE.md](../../CLAUDE.md)

## bin/paw.ts

- `bin/paw.ts` — **the endpoint-native composition root** (rewritten 2026-07-02). Imports ONLY
  @cotal-ai/core (registry + contracts) and paw's own command modules, which self-register on
  import; dispatch is paw's own (first word → registry lookup → `run`), no `runCli`, no
  @cotal-ai/cli, no @cotal-ai/manager in the CLI process — per cotal's architecture docs ("build by
  binding core's contracts, not wrapping the CLI"; implementations meet at runtime over NATS, not
  at compile time). Pre-dispatch gating keyed to PAW command names (`NEEDS_MESH`: inbox/msg/ask/
  who/history/watch; `NEEDS_MANAGER`: chat/open/attach/dm/rename/rm/status/ps/stop) runs `ensure()`
  and appends the default `--space` (plus `expandEqFlags` so `--space=x`/`--server=x` reach the
  commands' two-token parsers). No args → paw's own one-screen help. `down` → lifecycle `stop()`;
  bare `create`/`send` fail-loud with redirects (`chat --fresh` / `dm|msg|ask`); unknown command →
  one-line error, exit 1 (no silent fallthrough).
  **`paw cotal <cmd>` namespace:** spawns `bin/cotald.ts` as a SUBPROCESS (node+tsx via
  `cotaldViaTsx`) with mesh ensured + `--space` injected — control-plane verbs (start/ps/stop/
  attach/spawn/despawn, `COTAL_NEEDS_MANAGER`) also bring the manager up. Bare `paw cotal` prints
  the passthrough hint and exits 0.

## bin/paw.mjs

- `bin/paw.mjs` — **the package `bin`** (`package.json` `"paw": "./bin/paw.mjs"`). Tiny node
  shim: `node` → repo `tsx` → `bin/paw.ts`. A clone / `pnpm paw` / PATH symlink does **not**
  need a `dist/` build (`dist/` is gitignored; pointing `bin` at it made `npx github:…` run a
  missing file). Fail-loud if tsx isn't installed. Daemons still resolve through `daemonRoot()`,
  never through this file. Cold-start: `pnpm install && pnpm paw release && pnpm paw chat .`
  (`paw release` is still a deliberate first act — `ensure()` never snapshots behind your back).
  Test: `check:commands`.

## bin/cotald.ts

- `bin/cotald.ts` — the COTAL composition root: imports `runCli` (@cotal-ai/cli) + @cotal-ai/manager
  (self-register their commands) + paw's connector (registered as "paw" AND aliased to the manager's
  default agent type "cotal"), then dispatches argv via runCli. **Only ever a subprocess** — lifecycle
  drives the daemons (`up`, `supervise`) through it and `paw cotal …` passes raw verbs to it; the
  operator never invokes it directly. This is the only file allowed to import @cotal-ai/cli or
  @cotal-ai/manager.

## src/commands

- `src/commands/` — the native command modules (one file each, self-registering core `Command`s),
  all speaking the endpoint API directly: `stop.ts` (folder-aware positional via the registry — `resolveStopName`; `--name` is the
  raw cotal-parity escape hatch that goes STRAIGHT to the manager, reaching registry-less agents like
  an auto-numbered `web-2`), `msg.ts` (multicast), `ask.ts` (anycast), `who.ts` (roster), `history.ts`
  (channelHistory / dmHistory god-view tail; positional `clear` fail-louds toward
  `paw cotal history clear --force` — paw's history only READS), `watch.ts` (ep.tap of the whole space
  until Ctrl-C; the tap handler is hardened against non-message frames — control replies carry no
  `from`, and core doesn't try/catch tap handlers, so an unguarded deref would kill the feed for good),
  `runtime.ts` (registers BOTH `runtime` + `restart`: `paw runtime` shows the sticky preference + the
  last-started `manager.runtime` marker LOCALLY, `paw runtime <r>` writes the preference then `ensure()`s
  to apply it, `paw restart [<r>]` force-bounces the manager via `restartManager` — deliberately OUT of
  bin/paw.ts's mesh/manager gating so they self-ensure AFTER writing the preference; a pre-ensure would
  boot the STALE runtime). **Restart-revival:** a manager bounce drops all agents (the manager comes up
  empty; paw's registry is paw's, not the manager's), so both `paw restart` and a `paw runtime` SWITCH
  capture the live agent names FIRST (`liveAgentNames`, ps rows passing `psRowAlive`), then `reviveAgents`
  re-spawns exactly those from the folder→name registry after the bounce (each resumes its pinned session
  → warm). Idempotent (ensureAgentSpawned reuses a live agent), so a no-op switch doesn't churn; a
  registry-less or vanished-folder name is skipped + reported, never fabricated. This is what makes
  "restart brings everyone back without a manual dm/chat probe" true. Test: `check:commands`.

## paw mcp

- `src/commands/mcp.ts` — **`paw mcp`**: which of the operator's MCP servers paw's agents get (2026-08-12).
  A paw agent launches with **cotal's MCP server and nothing else** — the connector always emits
  `--strict-mcp-config`, dropping every ambient server, because N agents each booting a heavy helper
  eats the machine. Sharing one was possible but had NO surface. **Definitions live in cotal's own
  config** (`globalConfigPath()` = `~/.config/cotal/config.json`, `connectors.claude.mcpServers`) —
  cotal already reads that file, and a second paw-owned format for the same thing is one more place for
  the truth to disagree with itself; **the per-agent SELECTION lives in the persona** (`shareTools:`,
  read by `readShareTools` in session.ts, forwarded by `ensureAgentSpawned` as the start op's
  `shareTools`). **The key is `claude`, NOT `paw`** (`PAW_CONNECTOR`): bin/cotald.ts registers paw's
  connector under the manager's DEFAULT agent type, so cotal looks servers up there — under any other
  key the config parses, cotal reads it, and shares nothing, silently. **The plumbing was ONE missing
  line:** cotal's start op has always accepted `shareTools` (`parseShareSelection` manager-side); paw
  simply never sent it, so per-agent MCP was upstream-supported and merely unwired. **Absent
  `shareTools:` ≠ `none`:** absent ⇒ every declared server (cotal's default, and what makes `add` reach
  every agent without editing a single persona); `none` ⇒ share nothing, a real choice. **Nothing
  restarts an agent** — claude reads MCP config at startup, and bouncing someone's fleet as a side
  effect of editing config isn't a config command's call; each command names the now-stale agents and
  prints `paw restart <name>`. Verified live: added a server, scoped it to one agent, restarted, and
  read the MERGED temp config the process actually launched with (shared server + cotal's own, so mesh
  tools survive). Test: `check:mcp` (hermetic, pure helpers).
  **`paw restart <agent>` (src/commands/runtime.ts)** — there was no verb for cycling ONE agent;
  `paw restart` means the MANAGER, and the only way was `paw stop` + `paw start`. It matters exactly
  after a change an agent reads only at startup (a new MCP server, an edited persona), which is when
  bouncing the fleet is the wrong tool. Runtime names and agent names are disjoint, so the positional
  itself says which is meant; an unknown word fails loud naming both possibilities.

## paw files

- `src/commands/files.ts` — `paw files [--limit N] [--channel c] [--path-only] [--json]`: list the
  files that file-bridge endpoints (Telegram, etc.) have shared onto the mesh. PURE OBSERVER, same
  shape as `history.ts` (HUMAN_PEER card, registerPresence/consume/watchPresence all false — never
  binds a durable consumer, never in the roster); reads `ep.channelHistory("files", …)` and keeps
  only messages carrying a `data` part with `proto === "ai.cotal.file"`. **The `#files` channel is the
  convention** (default `"files"`, a dedicated channel NOT `#general`; `--channel` overrides). **The
  feed is DECOUPLED:** each announcement carries the FileEntry (name + **ABSOLUTE** local path +
  size/mime/caption/source) INSIDE the message — no bytes cross the mesh and paw never reads the
  endpoint's stateRoot; it just prints the paths for you (or an agent) to open with a Read tool.
  Renders `<when> <name> (<size>) · <abs-path>` + caption + a dim `from <source>/<sender> · <age>`;
  `--path-only` → bare abs paths (pipe into Read/xargs), `--json` → the raw FileEntry array. The wire
  contract (the `ai.cotal.file` proto + the FileEntry type) is RE-DECLARED locally — paw imports ONLY
  @cotal-ai/core, never endpoint-core. Pure helpers `extractFileEntry`/`formatReceived`/`formatSize`
  are exported + unit-tested. In NEEDS_MESH (mesh only, NOT the manager). **Pull-first discovery:** the
  connector's mesh brief tells every agent files land on #files → `paw files` to list (or
  `cotal_join("files")` to watch live), open the printed path with Read, treat paths as DATA (Read,
  never execute). Test: `check:commands`.

## paw bind

- `src/commands/bind.ts` — `paw bind [--peer telegram]`: the SECURE way to authorize a NEW Telegram
  chat onto the mesh, replacing the insecure learn-first-chat ("first stranger to text the bot wins").
  Mints a **short-lived, one-time code OVER THE MESH** from the endpoint bridge, then the operator types
  `/bind <code>` in the chat they want to authorize. Authorization rests on "you can produce a code
  minted on the trusted side (the mesh)", NOT on "you can talk to the bot" (the bot `@username` is
  enumerable + the token semi-public). **Wire contract** (mirrored EXACTLY on the endpoint side,
  `endpoint-core/src/bind.ts`; re-declared LOCALLY here so bind imports ONLY @cotal-ai/core): a MINT
  REQUEST is a DM carrying a data part `{proto:"ai.cotal.bind-request", v:1}` the endpoint INTERCEPTS
  before its forward-to-chats path (never relayed to Telegram); the MINT RESPONSE unicasts back a DM
  with a readable text line AND `{proto:"ai.cotal.bind-code", v:1, code, ttlSec}`. **Same one path as an
  agent's `cotal_dm("telegram", <bind-request>)`** — CLI and agents share it. paw's side: connect as a
  **DISTINCT, EPHEMERAL peer** (`paw-bind`, its own random `randomUUID()`-derived minted id — NOT
  HUMAN_PEER), registerPresence:true + consume:true + watchPresence:true, resolve the `telegram` peer on
  the roster (fail loud if absent — "is the bridge running?"), unicast the bind-request, WAIT ~10s for
  the reply DM (fail loud on timeout — "old bridge without /bind support"), print the code + the
  ready-to-paste `/bind <code>` line. **Why a distinct ephemeral peer:** consume:true binds a durable
  DM consumer keyed to the peer's id; connecting under HUMAN_PEER would contend for `dm_<you>`, the
  SINGLE slot `paw inbox`/`paw chat` share (cotal allows one active consumer per durable). A random
  per-run id gives bind its OWN short-lived durable that self-retires — zero contention with "you"'s
  inbox. Pure helpers `extractBindCode` (rejects a data part missing `code`/`ttlSec` — never fabricated)
  + `formatBindOutput` are exported/unit-tested (`check:commands`). NEEDS_MESH (mesh only, no manager).
  **learn-first-chat is deprecated** to a documented dev/test-only flag (kept working, insecure);
  `--chat <id>` seeds still work. Verify: `check:commands`.

## src/dispatch.ts

- `src/dispatch.ts` — pure, unit-tested CLI routing, SHRUNK by the endpoint-native rewrite (no more
  alias table — every paw verb is a paw-owned command now; `applyAliases`/`withNamePositional`/
  `isBareDmSend` deleted with their reasons). Three helpers remain: `withDefaultSpace` (append
  `--space` as a TRAILING flag; skip only on a real operator `--space` flag — never a bare `--space`
  word in a message body), `stripCotalNamespace` (peel the `paw cotal <cmd>` prefix so bin routes the
  remainder to the cotald subprocess), and `expandEqFlags` (`--space=x`/`--server=x` → two-token form
  the commands' hand parsers read; only those two flags, positionals untouched). check:dispatch.

## src/names.ts

- `src/names.ts` — `HUMAN_PEER` constant (the name the human joins under), shared by the connector
  brief and chat with zero deps to avoid a cycle.

## paw global

- `src/global.ts` — `paw global`: bring up the **always-on GLOBAL agent** — a persistent, usually-idle
  mesh peer with FULL machine access you can DM (esp. from a bridge) to "reach the box". Name is fixed to
  `global` (NOT `telegram` — the bridge itself joins as "telegram", would collide). Rooted at a DEDICATED
  `$PAW_HOME/global` (default `~/.paw/global`) workspace, NOT `$HOME`: it still reaches everything (paw's
  usual `bypassPermissions`, no cwd confinement → Read/Bash anywhere via absolute paths), but a neutral cwd
  avoids colliding with / orphaning an agent the operator already has at `$HOME` (e.g. `/Users/aleks` was
  already `paw`). Idempotent (`ensureAgentSpawned` reuses a live one), warm/resume-pinned, and revived by
  `paw restart` (registered agent). **Fail-loud, never clobber:** if the dedicated folder is somehow mapped
  to a non-`global` name it refuses (proposes `paw rename`/`paw rm`) rather than force-renaming + orphaning.
  Self-ensures (mesh+manager), NOT in bin gating. Surfaced from a bridge via the endpoint-core `/help`
  footer (`--help-footer` / `$COTAL_TG_HELP_FOOTER` → generic `helpFooter` config) + `/switch`/`/who`.
  Exports `GLOBAL_NAME`.

## keeper unstick sweep

- `src/keeper.ts` — **the unstick sweep, riding the `paw global` keeper tick (2026-09-06).** The case:
  vibeos-landing held 6 delivered-but-unacked DMs for ~17h; every ack-wait cycle redelivered them, every
  redelivery printed a wake nudge in its TUI (the exact repeating you×4/telegram×2 pattern the operator
  screenshotted), and no turn ever drained the inbox while the mesh read a healthy idle agent. `paw
  status` said `⚠ inbox stuck`; nothing acted; `paw restart <name>` drained all six at once. Correlated
  (not proven) with claude's in-place auto-update under the running session ("✔ Update installed ·
  Restart to update" on screen). `unstickDecision` (pure, `check:status`) restarts ONLY: live + `idle`
  (its own word) + `inboxStuck` + transcript QUIET for `STUCK_MS` (10 min — the same local truth as
  `inferBusy`/the busy-guard, so a mid-turn agent is never bounced) + no `failure` (a refused turn can't
  drain either; a restart changes nothing until the cause clears) + a 30-min per-agent cooldown
  (`spaces/<s>/unstick/<name>` marker). `unstickSweep` logs the evidence to stderr before each restart.
  Wired into `globalUp` because the launchd `dev.cotal.paw-global` job is paw's one periodic heartbeat
  (60s); a sweep failure is logged, never fails the tick. Filed upstream as cotal feedback 0c3eddb2
  (asks: redelivery backoff, presence ≠ idle with ack-pending DMs, connector self-heal).

## paw start

- `src/start.ts` — `paw start [<name>…]`: **COLD-START the fleet** — ensure mesh+manager, then spawn EVERY
  registered agent (`listAgents` = folders.json defaults ∪ agents.json extras), each resuming its pinned
  session. The verb `paw restart` isn't: restart revives only the agents that were LIVE (from `ps`), so
  after a reboot / `paw down` it brings nobody back; `paw start` sources from the REGISTRY, so it works
  from truly cold (the "can't see/poke agents after a restart" case — issue #10). `paw start <name…>` =
  just those. Idempotent (a live agent reads as "already live", not re-spawned); vanished folders + spawn
  failures (e.g. two-writer guard) are reported per-agent, never fatal to the rest. Self-ensures, NOT in
  bin gating. Live-tested on an isolated mesh (2 offline-registered agents → both cold-started).

## spawn pacing

- `src/pacing.ts` — **spawn pacing: the anti-thundering-herd gate for fleet revival (2026-08-21).**
  The incident: a machine deep in swap (14.4/15.3GB, load 141 on 10 low-power-throttled cores) missed
  a lease renew → manager restarted → revival respawned SEVEN agents in a burst, deepening the exact
  starvation that caused the loss. The revival loops were already sequential, but on 0.25 spawn is an
  ACCEPTANCE and mesh-live lands when the connector registers presence — the heavy part of a claude
  boot (transcript resume, MCP servers) continues after, so boots overlap almost completely.
  `awaitSpawnHeadroom` waits (poll 5s) for load1 < ncpu×2 before each spawn in `reviveAgents`
  (runtime.ts) and `paw start` — BOUNDED at 90s, then spawns anyway: an agent that stays down is the
  other failure (its name is unresolvable on the roster — the wake gap). **No message is lost either
  way:** DMs to a down agent queue in its durable JetStream consumer and deliver on reconnect (the
  INBOX column); the gate only widens the not-yet-resolvable window. 0.25's lease fix held twice in
  the same log ("renew had in fact landed … keeps serving") — the burst was paw's own amplifier, now
  removed. Pure/injectable (sampler, sleep, cpus); tested in `check:commands` (10 assertions).
  NOTE: `reviveAgents` runs in the CLI process (live from the checkout), but a SELF-restart's
  detached child runs release code — cut a `paw release` for full coverage.

## paw launchd

- `src/commands/launchd.ts` — **`paw launchd install <name>… | uninstall | status` (2026-08-24):** the
  fleet + `paw web` at LOGIN. paw's daemons are lazy (first `ensure()` starts them), so after a reboot
  nothing ran until the operator typed a paw command — the 2026-08-21 reboot left the fleet down for
  hours. Two jobs, deliberately different shapes: `dev.cotal.paw` = `paw start <names> --space <s>`,
  RunAtLoad, **NO KeepAlive** (a one-shot; KeepAlive would re-run it every ThrottleInterval and re-wake
  agents the operator deliberately stopped); `dev.cotal.paw-web` = `paw web --no-open`, KeepAlive (a
  long-lived server is what KeepAlive is for). **The agent list is explicit and baked into the plist**
  — `paw start` with no names is the 28-agent herd; with no names, install captures the LIVE fleet and
  fails loud if nothing is live. Runs node + the checkout's tsx + `bin/paw.ts` (the CLI's documented
  home; the daemons still resolve through the release), PATH written from `toolDirs()` because launchd
  gives a minimal env (`nodeBin`/`toolDirs` now exported). Logs at `spaces/<s>/launchd{,-web}.log`.
  bootout-then-bootstrap so a re-install replaces the running definition; install also RUNS the fleet
  job immediately (idempotent). Verified live: fleet job exited 0 under launchd ("10 already live"),
  web job running and listening on 7788 after handing over from a manual `paw web`. Pure helpers
  (`parseLaunchdArgs`, `renderPlist`, `fleetJob`, `webJob`) tested in `check:commands` (19 assertions).
  **Third job — `dev.cotal.paw-global`, the KEEPER (2026-08-26):** `paw global --space <s>` on a
  60s `StartInterval` (RunAtLoad, no KeepAlive — the command exits by design; idempotent, a healthy
  tick is one ps round-trip). WHY: `global` is the wake authority (`cotal_dm("global","wake <name>")`),
  and the fleet job runs ONCE at login, so once global exited nothing brought it back — the whole
  convention was dead and `personal` had to shell out `paw start` itself (operator screenshot,
  2026-08-26). Only global gets this: a periodic re-run of the FLEET job would re-wake agents the
  operator deliberately stopped (`renderPlist(fleet)` is asserted to carry no StartInterval).
  `--no-global` opts out. Gotcha met on install: zsh does NOT word-split `$NAMES` — passing a shell
  variable of names to `paw launchd install` bakes ONE bogus quoted name into the fleet plist; pass
  the names literally (or `${=NAMES}`).

## src/stdout.ts

- `src/stdout.ts` — `writeOut`/`writeJson`: stdout writes that cannot be truncated by process exit.
  **The 2026-08-03 bug, surfaced by the Raycast extension:** `paw inbox --json` under **bun** with
  stdout on a **PIPE** delivered a 150 KB payload as 64900 / 97259 / 129725 bytes — a different cut
  each run, exit code 0, no error either side; the extension reported "paw returned unparseable
  output" on a body that BEGAN as valid JSON. Under node+tsx the same command was byte-correct every
  run, and switching the emitter to `writeSync(1, …)` made bun correct every run. **What is NOT
  established: the mechanism.** Minimal repros (a big `console.log` under bun with an explicit exit,
  with a natural exit, and after a socket teardown) all came out WHOLE — so "bun drops buffered stdout
  on exit" is NOT a sufficient explanation and must not be repeated as one; something about paw's real
  teardown (many sockets, JetStream consumers, timers) is needed to trigger it. A defence whose
  necessity is MEASURED, not understood. It hides easily — redirecting to a FILE writes synchronously
  and comes out whole, and `paw … | wc -c` comes out whole because a fast reader keeps the pipe
  drained; it bites only a consumer that pipes and reads at its own pace, i.e. exactly the `--json`
  paths. `writeOut` loops on partial writes (a pipe accepts only what fits — treating a short write as
  done IS the truncation) and retries EAGAIN/EINTR, letting a real EPIPE surface. Human-facing prose
  stays on console.log: a torn line is visible to a person, silently truncated JSON is not. Test:
  `check:stdout` — which asserts the PROPERTY (a 400 KB payload arrives whole through a pipe, 5×
  under bun) and honestly is NOT a reproduction of the original failure, since that needs a live mesh.
