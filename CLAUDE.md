# paw

Zero-config warm claude-code agents on the cotal mesh — one agent per folder, persistent,
addressable, talking to each other and to you. A thin layer over cotal with **no fork**.

## Layout
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
- `bin/paw.mjs` — **the package `bin`** (`package.json` `"paw": "./bin/paw.mjs"`). Tiny node
  shim: `node` → repo `tsx` → `bin/paw.ts`. A clone / `pnpm paw` / PATH symlink does **not**
  need a `dist/` build (`dist/` is gitignored; pointing `bin` at it made `npx github:…` run a
  missing file). Fail-loud if tsx isn't installed. Daemons still resolve through `daemonRoot()`,
  never through this file. Cold-start: `pnpm install && pnpm paw release && pnpm paw chat .`
  (`paw release` is still a deliberate first act — `ensure()` never snapshots behind your back).
  Test: `check:commands`.
- `bin/cotald.ts` — the COTAL composition root: imports `runCli` (@cotal-ai/cli) + @cotal-ai/manager
  (self-register their commands) + paw's connector (registered as "paw" AND aliased to the manager's
  default agent type "cotal"), then dispatches argv via runCli. **Only ever a subprocess** — lifecycle
  drives the daemons (`up`, `supervise`) through it and `paw cotal …` passes raw verbs to it; the
  operator never invokes it directly. This is the only file allowed to import @cotal-ai/cli or
  @cotal-ai/manager.
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
- `src/attach-client.ts` — paw's ws pty attach client (wire port of the manager's non-exported
  attach-client; framing byte-identical: binary = keystrokes, text `r:<cols>,<rows>` = resize,
  Ctrl-] = detach, full tty restore incl. alt-screen wheel→PageUp/Down translation). Uses node's
  global WebSocket (hence `engines.node >= 22`). Exports `attachTo(wsUrl)`.
- `src/lifecycle.ts` — paw owns the cotal daemon lifecycle: `ensure({needMesh,needManager,space})`
  auto-starts (or adopts) a **detached** mesh + manager under a per-space lock, with readiness gates;
  `stop()` tears down only daemons paw started.
  Mesh defaults to **open** (no creds) — `PAW_AUTH=1` for JWT; never forks.
  **Manager/mailbox ownership is by COMMAND SIGNATURE, not the recorded pid** (`managerProcs`/
  `mailboxProcs` = `pgrep -f`, both exported; `managerMatchPattern`/`mailboxMatchPattern` are the
  SPACE-EXACT regexes — `cotald\.ts supervise --space <s> --server` bounded by the always-emitted
  trailing ` --server`, `paw\.ts mailbox --space <s>( |$)` bounded by end-of-arg, so `owntest-1`
  never matches `owntest-11`; the space value is regex-escaped). WHY: paw records `spawn().pid`, but
  these daemons run under tsx (a re-exec CHILD) and cotal can detach, so the recorded pid is only the
  tsx WRAPPER — correctness then hinged on the wrapper staying alive AND forwarding signals, and a
  SINGLE pid can't represent the DUPLICATE managers a night of restart churn leaves orphaned (each
  overwrote the marker). That's the 2026-07-08 bug: `paw restart` errored "no paw-owned manager",
  `paw down` left the real manager running, retries spawned COMPETING managers. Since ONLY paw ever
  starts a `cotald supervise` / `paw.ts mailbox` for a space, a pgrep match IS paw's daemon — no pid
  bookkeeping needed. `stopOwnedManager(space)`/`stopMailbox(space)` SIGTERM ALL matching procs (dups
  included), wait for the signature to clear (~4s), SIGKILL any straggler, then drop the now-secondary
  markers; both are best-effort/no-throw. `ensureManagerUp`'s ownership check (adopt-vs-switch) and
  `restartManager`'s guard both use `managerProcs(space).length > 0`; `paw restart` with NO manager
  running is not an error — it just STARTS one (and its `liveAgentNames` swallows the "no responders"
  a managerless ps throws, so a cold restart brings a manager up cleanly). The MESH kill stays a pid
  marker (`meshPidPath` from cotal's own `nats.pid`, which is correct — not a spawn() pid). Space-
  exactness is unit-tested in `check:commands`. Verified live: `paw restart` → exactly one manager
  (no dup), `paw down` → zero managers + zero mailbox, `down` on `ex1` leaves `ex11` untouched.
  **Daemons are pinned to node+tsx.** `ensureMesh`/`ensureManagerUp` start the mesh (`up --detach`)
  and manager (`supervise`) by driving **bin/cotald.ts** via `cotaldViaTsx` (exported — bin/paw.ts
  reuses it for the passthrough); `ensureMailbox` spawns the beacon through **bin/paw.ts** via the
  private `pawViaTsx` (mailbox is a paw command, not a cotal one). Both use the repo's
  `node_modules/.bin/tsx` directly, NOT the current CLI runtime — so the **CLI may run under bun**
  (fast startup) while the daemons always run node+tsx (bun can't drive node-pty's ioctl →
  bun-hosted manager = pty stubs, no agents). `isReachable` is the only cotal-core import;
  readiness still probed in-process via a `ps` round-trip. **Runtime (`resolveRuntime(space?)`):**
  precedence is `PAW_RUNTIME` env (fail-loud on garbage) > the space's **sticky preference file**
  (`~/.paw/spaces/<space>/runtime`, set by `paw runtime <r>` — `readRuntimePreference`/
  `writeRuntimePreference`; a garbage file is ignored) > `pty`. `ensureManagerUp` records the runtime
  it started under (`manager.runtime` marker, distinct from the durable preference) and RESTARTS a
  paw-owned manager when the resolved runtime differs (the setting can't switch a daemon ensure()
  merely adopts). **The RUNNING runtime is read from the live supervise proc's cmdline
  (`actualManagerRuntime` — `--runtime` flag, absent = pty), NEVER the marker:** the marker is written
  at spawn time and survives failed switches/churn, and a stale cmux marker over a pty manager made
  `paw runtime cmux` adopt-and-skip ("already running cmux") while agents spawned headless and the
  cmux tabs sat empty (2026-07-12). The marker remains only for post-kill reap paths (no process left
  to ask); `paw runtime` show/switch + `paw restart`'s summary all use the live truth. **Rollback net:** a runtime SWITCH kills the known-good old manager BEFORE starting
  the new one, so a new runtime that never comes up (cmux not installed/reachable) would leave NONE;
  if the new manager misses the readiness window, `ensureManagerUp` **rolls back** — restarts the
  previous runtime and throws loud (`… failed to start under <new> … — restored the <old> manager`) —
  so the operator always ends with a working manager (a fresh start has nothing to roll back to and
  just throws the timeout). **`restartManager({space})`** (exported) is the force-bounce `paw restart`
  needs that ensure() won't do on a same-runtime manager (e.g. after a connector edit): under the lock,
  ensureMesh → (if `managerProcs(space)` non-empty) stop the manager by signature + **`reapRuntimeUi` the
  OLD runtime's leftover windows/tabs** → ensureManagerUp → **kill + re-spawn the beacon** (`stopMailbox`
  by signature → ensureMailbox). No running manager is NOT an error — it just starts one. The beacon
  refresh is load-bearing:
  the mailbox is a LONG-LIVED daemon ensure() only ADOPTS, so a STALE beacon (old paw code / old
  @cotal-ai in its memory) keeps holding "you" under a mismatched id — e.g. a server-minted nkey rather
  than the current `stableHumanId` — and agents then reply to a "you" that `paw inbox` doesn't read, so
  replies silently vanish (the "mailbox broken" incident of 2026-07-07: a Jul-6 beacon held
  `UASTVCQU…` while inbox read `f415f5d0…`). A plain restart of the manager wouldn't fix it; bouncing
  the beacon under the current code re-registers "you" = stableHumanId and the round-trip lands again.
  **UI reap (`reapRuntimeUi(space, runtime, agentNames?)`, exported):** on a RESTART/SWITCH the old
  manager's terminal UI must be gone BEFORE revival re-creates it, else you get DUPLICATE windows/tabs
  (the `cotal-paw`×2 / `cotal-paw-folder`×2 cmux bug of 2026-07-07). The manager DOES tear its own
  children down on a clean SIGTERM — verified for **tmux** (its agent windows close; only the session
  shell survives) — but that can MISS under **cmux** (the detached daemon's socket close lags/fails on
  shutdown), so paw reaps DEFENSIVELY after `stopOwnedManager` and before the new manager/revival. tmux
  → `tmux kill-session -t cotal-<space>` (session-scoped nuke; the new manager's `ensureSession` +
  revival recreate it, so it stays at N, not 2N). cmux → each agent is its OWN `cotal-<name>` tab and
  cmux labels carry NO space, so paw can only SAFELY close the tabs of the KNOWN agents (closing every
  `cotal-*` would nuke OTHER spaces) — hence `restartManager`/the switch branch capture the live agent
  NAMES (`managerAgentNames` ps round-trip) BEFORE the stop, then `reapRuntimeUi` matches `cotal-<name>`
  in `cmux list-workspaces` and `cmux close-workspace --workspace <ref>` each. Best-effort, NEVER throws
  (a stale/unreachable cmux app can't abort the restart); pty → no-op. Both `restartManager` and
  `ensureManagerUp`'s mismatch-restart (switch) reap the **OLD/RUNNING** runtime (the one whose UI
  exists), read from the `manager.runtime` marker before it's dropped — never the new one. `stop()`/`paw
  down` drops the `manager.runtime` marker but KEEPS the preference file (a durable choice, not a daemon
  marker), and calls the SAME `reapRuntimeUi(space, runtime)` (tmux → kill-session the per-space session
  `cotal-<space>`; the manager's per-window teardown closes agent windows but leaves the session shell,
  so stopping the manager alone would orphan it; cmux no-op here — no agent names). See the Env knobs
  entry + `src/commands/runtime.ts`. **cmux reap is UNVERIFIED live** (no cmux surface in CI); the tmux
  path is tested (`paw restart` keeps the window count at N, not 2N).
  **tmux socket pinning (`defaultTmuxEnv`, 2026-07-08):** the manager is a DETACHED daemon that inherits
  whatever `$TMUX`/`$TMUX_TMPDIR` the launching shell/surface had, and cotal's tmux driver calls bare
  `tmux` (no `-L`/`-S`), so its `cotal-<space>` server could land on a socket the operator's plain shell
  never looks at → `tmux ls` reports "no server running", the session is invisible, agents effectively
  headless though marked tmux. Fix (mirrors the cmux `CMUX_*` stripping — same detached-daemon /
  inherited-surface-socket class of bug): `startManagerDaemon` STRIPS `$TMUX`+`$TMUX_TMPDIR` for the tmux
  runtime, pinning the manager to tmux's STANDARD default socket (`/tmp/tmux-<uid>/default`) — exactly
  where a fresh operator shell + `paw attach` resolve `tmux`. `reapRuntimeUi`'s tmux kill-session runs on
  the SAME default socket (else a paw launched with a stray TMUX_TMPDIR reaps the wrong socket and orphans
  the session), and `attachTmux` strips `TMUX_TMPDIR` on the non-inside (attach-session) path (the inside
  switch-client path keeps ambient env — it needs the operator's real client on that same default server).
  CAVEAT: an operator who exports a CUSTOM `TMUX_TMPDIR` in their own interactive shell must export the
  same value for a bare `tmux attach` to see the default-socket session. Verified live: a manager launched
  with a custom `TMUX_TMPDIR` still lands `cotal-<space>` on the default socket (visible + `paw attach`
  select-window resolves it); the inherited custom socket has no server; `paw down` reaps it clean.
- `src/connector.ts` — paw's only engine code. Wraps `claudeConnector.buildLaunch` from
  @cotal-ai/connector-claude-code and injects: `--permission-mode bypassPermissions`
  (PAW_PERMISSION overrides; "default" emits no flag), `--disallowedTools AskUserQuestion,ExitPlanMode`
  (so a warm agent can't hang on a terminal prompt), the mesh brief (merged into
  `--append-system-prompt`, and it names the human peer so agents reply to it), and optional
  a durable session pin from an agent file's `resume:` frontmatter. **Durability:** every persona is
  minted with a stable `resume: <uuid>` at birth (`ensurePersonaFile`); the connector emits
  `--session-id <id>` on FIRST boot (no transcript under `~/.claude/projects/*/<id>.jsonl` yet) and
  `--resume <id>` thereafter — so an agent keeps its context across ANY restart. A pinless persona
  cold-starts a fresh, amnesiac session each launch (the paw-reset bug of 2026-06-26). `paw chat --fresh`
  cold-starts a fresh session and REFUSES if an agent already exists for the folder (resume is
  `paw chat`/`paw adopt`; reset is `paw rm` then `paw chat --fresh`); `paw chat`/`dm`/`open` ensure-live
  and resume the pin for warm continuity, and are now the way to recover a crashed warm agent. The manager
  loads this connector at startup (tsx = no hot-reload), so connector changes need a manager restart;
  a half-applied state (new pinned personas + old manager) boot-fails (`--resume` on a missing id).
  Pure composition; no cotal edits.
  **NOTE:** it no longer handles cwd — as of cotal #43 the manager owns the working directory
  (`runtime.spawn(name, spec, cwd)`); the connector never sees it. cwd confinement + folder pre-trust
  moved to `src/cwd.ts`, applied at the spawn site.
- `src/cwd.ts` — `confineAndTrustCwd(cwd)`: PAW_ROOT confinement (out-of-root throws unless
  `PAW_ALLOW_ANY_CWD=1`) + Claude folder pre-trust (writes `hasTrustDialogAccepted`/onboarding into
  `~/.claude.json`, creating it if absent, under an adjacent lock; in-root only). Called by
  `ensureAgentSpawned` just before the manager spawn, returns the CANONICAL cwd to pass through (so the
  dir claude runs in matches the trust key). Moved out of the connector when cotal #43 gave the
  manager the cwd.
- `src/chat.ts` — **the headline.** `paw chat [folder|name|repo@branch]`: joins the mesh as a
  PERSISTENT human peer (`HUMAN_PEER`, registerPresence+consume → addressable + receives replies live)
  and runs a readline REPL. **Mention-only with a latching sticky target:** with no arg it starts in
  broadcast mode (a plain line multicasts to `#general`); the moment you **`@name <msg>`** that peer
  becomes the sticky target and plain lines DM it until you `@` someone else. A positional target
  (folder→spawn-if-absent, or an agent NAME) just seeds the sticky target up front — a name that's a
  KNOWN agent (in the folder→name registry) is RESUMED from its registered folder even when offline
  (same as the in-REPL `@name` respawn; `open`/`attach` do this too), so `paw chat <name>` /
  `paw attach <name>` wakes a durable agent instead of erroring; only an UNKNOWN name (not a folder,
  not registered) fails loud — never auto-created from nothing. **`#channel
  <msg>`** always broadcasts explicitly; `/dm <name> <msg>` is a one-off DM; `/who` (roster); **`/ps`**
  (manager ps — same view as `paw ps`); `/quit` (or bare `exit`/`quit`). `@name` **tab-completes** from
  the live roster and **respawns** a known-but-offline agent (`folderForName` → resume). After a DM it
  prints `⏳ waiting for <name>…`, then `✓ <name> picked it up` when that peer's presence flips to
  `working` (an explicit receipt, since the reply can be minutes away), then stamps the reply's
  round-trip time; sent lines aren't re-echoed
  (readline shows the typed line); redelivered DMs get an ` (Nh ago)` age tag. Registers `chat`.
  **`--fresh` is the birth verb** (the former `paw create`, folded in 2026-06-30): `paw chat --fresh
  [folder]` mints a BRAND-NEW agent then drops into the REPL. The folder defaults to `.` (the current
  directory, like `paw chat <folder>`/`paw open`/the former `paw create`), and carries the load-bearing
  fail-loud-if-exists guard (`freshTarget` →
  `lookupFolderName` throws if an agent already exists for the folder — resume by dropping the flag, or
  `paw rm` then `--fresh` to reset; the guard that stopped `paw create evals` re-booting a stale session).
  There is no standalone `create` command anymore: bare `paw create` fail-louds with a redirect (bin).
- `src/claude.ts` — **claude with its own flags, brought onto the mesh.** `paw claude [claude-args…]`
  **spawns a MANAGED agent** (warm, survives the terminal) and **attaches** — the same destination as
  `paw adopt`, reached with claude's own flags instead of a session id. **`--fg`/`--foreground`** keeps
  the ORIGINAL behaviour: exec the REAL `claude` in the operator's CURRENT terminal (`spawn` with
  `stdio:"inherit"` — your real tty), mesh-wired (cotal MCP + presence + brief) but **dying with the
  terminal** (Ctrl-C / closed tab). **WHY managed became the default (2026-08-05, operator's call):** a
  foreground claude's mesh peer dies with the window, so a teammate that DMs it an hour later is talking
  to nobody — the warm, addressable agent is the whole reason paw exists, so the terminal-bound one is
  now the opt-in. `--no-attach` spawns without attaching.
  **Passthrough flags are PERSISTED, not passed once** — `claudeArgs:` in the persona frontmatter
  (written by `pinClaudeArgs` in adopt.ts, read by `readClaudeArgs` in session.ts, replayed by the
  connector on EVERY launch), because otherwise a restart/reboot silently relaunches a DIFFERENT claude
  than the operator asked for. Stored as a **JSON array**: an arg can contain spaces
  (`--append-system-prompt "be terse"`) and re-splitting a flattened string is the quoting bug this path
  exists to avoid; a malformed value **THROWS** rather than launching without the operator's flags.
  Appended LAST in the connector so an operator flag beats paw's default for the same flag. Session
  flags are deliberately NOT stored (the durable `resume:` pin owns the conversation — two sources for
  it is how two writers land on one transcript). A live agent whose flags/session CHANGED is
  `restartAgent`ed rather than attached to (flags are read only at launch); an unchanged bare
  `paw claude` just ensures + attaches, so it never bounces a warm agent for nothing.
  **Two-zone arg parse (`peelArgs`, pure/unit-tested):** LEADING `--space`/`--name`/`--fg`/`--no-attach`
  (+ `--space=`/`--name=` and a literal `--` terminator) are paw's; the first token that isn't one of those begins the
  claude PASSTHROUGH, forwarded VERBATIM. No folder positional — the folder is ALWAYS `canonicalDir(".")`
  (the cwd), name = `--name` ?? `folderToName`. Flow: (a) **dedup, fail-loud** — refuse if a live
  foreground entry OR a live manager ps row already owns the name (`paw open`/`paw stop` first); (b) derive
  the durable pin from the operator's own session flags (`deriveSessionIntent`/`deriveSessionId`:
  `--continue`/`-c` → `latestSession`; `--resume <id|name>` → that session; bare `--resume`/`-r` or fresh →
  no pin) and `pinSession` it (shared with adopt); (c) `ensure({needMesh,needManager})`; (d)
  `pawConnector.buildLaunch({…, servers:server, model:resolveModel()})`; (e) **`stripSessionFlags`** drops
  paw's connector-injected `--resume`/`--session-id`/`--fork-session` so the operator's OWN session control
  wins (`finalArgs = stripSessionFlags(spec.args) ++ claudeArgs`); (f) `confineAndTrustCwd`; (g)
  `registerForeground`; (h) spawn; (i) forward SIGTERM/SIGHUP, `unregisterForeground` on exit,
  `process.exit(code)`. **CAVEAT:** it carries paw's connector opinions — `bypassPermissions` +
  `--disallowedTools AskUserQuestion,ExitPlanMode` (set `PAW_PERMISSION` to change). `bin/paw.ts` routes it
  through a **dedicated early branch** (peer of `cotal`, BEFORE NEEDS_* gating + `withDefaultSpace` — a
  trailing `--space` would leak into the passthrough; claude.ts self-ensures). Test: `check:foreground`.
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
- `src/start.ts` — `paw start [<name>…]`: **COLD-START the fleet** — ensure mesh+manager, then spawn EVERY
  registered agent (`listAgents` = folders.json defaults ∪ agents.json extras), each resuming its pinned
  session. The verb `paw restart` isn't: restart revives only the agents that were LIVE (from `ps`), so
  after a reboot / `paw down` it brings nobody back; `paw start` sources from the REGISTRY, so it works
  from truly cold (the "can't see/poke agents after a restart" case — issue #10). `paw start <name…>` =
  just those. Idempotent (a live agent reads as "already live", not re-spawned); vanished folders + spawn
  failures (e.g. two-writer guard) are reported per-agent, never fatal to the rest. Self-ensures, NOT in
  bin gating. Live-tested on an isolated mesh (2 offline-registered agents → both cold-started).
- `src/foreground.ts` — the per-space **foreground-agent registry** backing `paw claude`'s visibility:
  one JSON file per agent (`ForegroundEntry {name,folder,pid,startedAt,sessionId?,argv}`) under
  `~/.paw/spaces/<space>/foreground/<name>.json` (ONE file per agent → concurrent launches never contend,
  no lock). `registerForeground`/`readForeground`/`listForeground`/`unregisterForeground` (atomic
  tmp+rename); reads **SELF-REAP dead pids** via a signal-0 probe (mirrors named.ts) — a `paw claude` dies
  with its terminal, so a stale entry never masquerades as live. Load-bearing everywhere paw could spawn a
  DUPLICATE: `ensureAgentSpawned` returns `{spawned:false}` at its VERY TOP for a live foreground name (so
  dm/chat/open/adopt/rename/revival address the live roster instead of racing a manager copy); `paw open`
  prints "runs as a foreground claude in another terminal (pid …)" and skips the ws-pty attach; `paw
  stop`/`paw rm` SIGTERM the pid + unregister (manager stopAgent is a no-op for it); `paw status` renders a
  registered-but-ps-absent foreground agent LIVE with runtime **`fg`**, pulling its mesh status + card.id
  from the ROSTER (so inbox-lag/zombie detection still works). Pure/hermetic-tested (`check:foreground`).
- `src/rename.ts` — `paw rename <folder|name> <newname>`: relabel an agent — the set is chat --fresh = new,
  adopt = resume, **rename = relabel**. `renameAgentOnDisk` (pure, unit-tested) renames the folders.json
  entry (`setFolderName`) and MOVES the persona file (resume pin + body kept, `name:` frontmatter
  rewritten to match), so the agent keeps its session. Fails loud on a no-op, an empty/invalid name, an
  unmapped target, or a name already held by a DIFFERENT folder (it pre-checks `folderForName` because
  `setFolderName` would otherwise silently hash-qualify). The first arg resolves as a known agent NAME
  (reverse lookup), a `<repo>@<branch>` worktree, or a folder path. If the agent is LIVE it's retired
  under the old name (`stopAgent`) and respawned under the new one (`ensureAgentSpawned`, resumes via
  the moved pin); if not live, only the on-disk state changes. In NEEDS_MANAGER. Test: `check:rename`.
- `src/rm.ts` — `paw rm <name|folder|repo@branch|github:owner/repo>`: **forget** an agent — the set is
  chat --fresh = new, adopt = resume, rename = relabel, **rm = forget**. Stops it if live (`stopAgent`), drops
  its folders.json mapping (`removeFolder` in addressing — locked RMW), and deletes its persona. The
  claude **transcript is ALWAYS kept** (it's the conversation; prints a `paw adopt --resume <id>` revive
  hint). `resolveRemoval` (exported, unit-tested) resolves the target three ways with NO spawn/clone: a
  registered agent NAME (`folderForName`), a folder/worktree/`github:` handle mapped in the registry
  (a github handle → its clone dir via `repoDir`, never fetched), or an **orphaned persona** (a
  `personas/<name>.md` with no mapping left — e.g. after a folder was re-registered under a new name).
  Fails loud if the target matches none. In NEEDS_MANAGER (to stop a live agent; no-op if offline).
  Test: `check:rm`. Pairs with the always-new birth semantics: `paw rm` then `paw chat --fresh` for a
  clean reset.
- `src/status.ts` — `paw status`: **the ONE agent view** (the former `paw ps` + `paw status`, MERGED —
  `paw ps` is deleted; the raw manager ps stays at `paw cotal ps`). One row per registered agent, live
  or not: **STATUS** (mesh idle/working/starting/offline via `meshStatus` over the manager ps —
  `mesh:"absent"` → starting), **RUNTIME** (the `manager.runtime` marker, shown only when live), **CWD**
  (tilde-abbreviated folder), **SESSION** (the human session name `"research"` via `nameForSession` if
  set, else a short id), **INBOX** (per-agent durable DM-consumer lag — the ZOMBIE detector, added
  after the 2026-07-12 team2027-research incident where a presence-`idle` agent sat deaf on an unacked
  DM for hours: `fetchInboxLag` queries JetStream `consumers.info(DM_<space>, dm_<id>)` where `id` is
  the agent's nkey from the manager's ps row (ps carries `id` — the card.id minted at spawn), rendering
  `✓` (drained), `N queued` (num_pending, undelivered), `N unread` (num_ack_pending, delivered-unacked),
  `—` (no consumer / not ps-listed — legit), or `?` (query FAILED — stderr detail, never a fabricated 0).
  A LIVE agent with queued/unread > 0 gets `⚠ inbox stuck — …, agent not consuming` and a footer count.
  CotalEndpoint keeps its jsm private, so status opens its own short-lived NATS connection via
  `@nats-io/{transport-node,jetstream}` (core's own client libs, now direct deps; creds via controlCreds
  under PAW_AUTH). ConsumerNotFound(10014)/StreamNotFound(10059) → `—`; other errors → `?`.),
  **ACTIVE** (transcript mtime, relative via `ago` — `transcriptMtime`), plus a
  durability/two-writer note (`⚠ two writers (pid …)` from `foreignWriters`, `⚠ no pin` (claude-only —
  an opencode/codex agent has no claude `resume:` so the warning is a lie), `fresh`, or
  quiet when durable). Rows sort live-first then most-recently-active. `formatStatus`/`meshStatus`/`ago`/
  `inboxText`/`inboxStuck` are pure/unit-tested. In NEEDS_MANAGER (reads the manager ps for liveness).
  Test: `check:status`.
- **Unregistered manager-listed agents get a row (2026-09-09):** `paw status`/`/api/status` rendered ONE
  row per REGISTERED agent (folders.json ∪ agents.json) joined with the manager's ps, so a
  `cotal_spawn(name, agent: "codex", cwd…)` peer — on the roster, in `paw cotal ps` — was invisible on
  paw's dashboard (personal relayed the operator's "why can't i see gpt-6_2"). Two sources of truth is the
  honest description; a dashboard that omits a live agent answers the wrong question. `collectStatus` now
  appends every ps row paw didn't register with what the ps row carries and NOTHING invented: no folder
  (`—`), no pin/transcript, inbox lag still read (the ps row has the id), `unregistered: {agent}` +
  the note `unregistered <harness> peer (cotal_spawn) — not revived by paw restart/start`; the web header
  shows the same. Registering after the fact is still manual (a persona with `agent: codex` + a
  folders.json/agents.json entry — the codex1/opencode1 pattern); `paw adopt` is a claude-transcript
  verb and has no codex form yet. Test: `check:status`.
- **`failure` (src/status.ts `transcriptFailure` → src/transcript.ts `recordFailure`/`lastFailure`, 2026-09-03)** —
  "from paw web it looks like the agent is ignoring me": the DM wakes it, claude tries a turn, the API
  refuses ("You've hit your session limit · resets 2:50am", "Login expired · Please run /login", "Request
  timed out", "API Error: …"), the turn ends with no reply, and the mesh still shows a healthy idle
  agent — presence knows only working/idle and `cotal_status` is something the MODEL would have to call.
  cotal has no rail for "the model couldn't run"; the transcript is the only place claude writes it, as
  a SYNTHETIC assistant turn: `message.model: "<synthetic>"` + `isApiErrorMessage: true` (the
  authoritative flag; the text family above is the fallback). "No response requested." is synthetic too
  and is NOT a failure. `lastFailure` walks the tail (64KB) NEWEST-first and lets the latest assistant
  turn decide — a failure followed by a real reply is recovery, not news. Surfaced as `AgentStatus.failure`
  ({text, ts}): `paw status` note column, `/api/status` rows, the web header (⚠ beats "idle"), a red pip
  on the row, and a standing notice above that agent's chat ("your DMs queue and will be answered once it
  can run again"). Measured on this box: 907 "Login expired" synthetic turns in one day across
  transcripts — the class is common. Test: `check:transcript`.
- **`inferBusy` (src/status.ts)** — paw's own "this agent is mid-turn" guess, rendered as **`busy`**,
  deliberately a DIFFERENT word from the mesh's `working` so a reader can tell what the agent said
  from what paw worked out. WHY it's needed: the connector publishes `working` only on the
  `UserPromptSubmit` hook, but a turn woken by a mesh DM arrives via the channel nudge + inbox drain
  and submits no user prompt — so essentially every agent-to-agent turn runs while presence still
  reads `idle`, which is why `paw status` looked like nothing was ever working. Transcript mtime is
  the one local signal that moves during a turn however it started: live + `idle` + written in the
  last 10s → `busy`. The agent's OWN `working`/`waiting` always wins (never overwritten by a guess),
  an offline agent is never busy, a missing mtime yields no inference rather than a fabricated one,
  and an mtime in the FUTURE (clock skew) is not evidence. Upstream fix would be cotal setting
  `working` when a channel-woken turn begins. Test: `check:status`.
- **`agent:` persona pin → which CONNECTOR respawns an agent (`readAgentType`, src/session.ts, 2026-09-01):**
  every paw wake/revival path (`paw start`, `paw restart` revival, `paw dm`/`chat` wake, adopt) spawns
  through `ensureAgentSpawned`, which used to send NO `agent` — so the manager's default (paw's claude
  connector) booted, and a codex/opencode agent spawned via `paw cotal spawn --agent …` would come back
  from any restart as a CLAUDE named codex1. The persona's frontmatter `agent: codex|opencode` is now
  forwarded as the spawn op's `agent` (cotal 0.25 `SPAWN_INPUT_SCHEMA` accepts it), so the harness is
  durable in the same file as the name/pin. Absent ⇒ default claude, unchanged. Verified live: `paw
  start codex1` → `codex1 codex · tmux`. Non-claude agents are still NOT in the launchd fleet list on
  purpose (booting them at login spends codex/grok sessions — the operator's call). Test: `check:mcp`.
- `src/session.ts` — leaf module shared by connector (launch), spawn site (guard), and status:
  `readResumeId` (parse a persona's `resume:` pin) + `transcriptExists` (does `~/.claude/projects/*/<id>.jsonl`
  exist → resume vs first-boot-create). Kept separate so `addressing.ts` needn't import the connector.
- **Two-writer guard:** `ensureAgentSpawned` (and `adopt`) refuse to start an agent whose pinned
  session a standalone claude is holding (`foreignWriters` in `src/named.ts` = live non-mesh procs on
  that id) — resuming it would put two writers on one transcript and corrupt it. This is why `paw chat
  --fresh` no longer silently resumes a human's own live session (the `aleks` incident, 2026-06-26).
- `src/open.ts` — `paw open [folder|name|repo@branch]`: resolve the folder's agent (spawn if absent)
  then attach — **runtime-aware** (branches on the `manager.runtime` marker via `readRuntimeMarker`),
  because the manager only streams a ws pty for `pty` agents (tmux/cmux are watched natively, their
  `attach` op throws by design): **pty** → **FAILS LOUD on cotal 0.25** — the manager's `attach` no
  longer returns a `ws://` URL at all (`ATTACH_OUTPUT_SCHEMA` is `{grant}`, a signed §13.6 session grant
  redeemed over the mesh with a `session-caller` cred minted from the space's LOCAL SEED, which an open
  mesh does not have; cotal's own `attach` refuses that same case). `src/attach-client.ts` is now dead
  code kept for the day paw learns to drive a session rail. The message names what still works
  (`paw chat` / `paw log` / `paw runtime tmux`); **tmux** → spawn
  then `attachTmux` (src/native-attach.ts) drops you into the agent's real window; **cmux** → prints
  the tab to switch to in the cmux app (no terminal takeover). Falls back to a
  live **agent name** if the arg isn't a folder (mirrors chat) — so `paw open <session-named-agent>`
  works. Prints the per-runtime lifecycle on attach. Registers **both `open` and `attach`** (same run —
  `paw attach <name>` is the documented wake verb, formerly a dispatch alias).
- `src/native-attach.ts` — `attachTmux(space, name)` + `tmuxSession(space)` (= `cotal-<space>`): the
  tmux-runtime attach. Selects `<session>:<name>` (fail-loud if the window's gone), then
  `switch-client` when already inside tmux (attach-session can't nest) else `attach-session`. On the
  attach-session (plain-shell) path it STRIPS `TMUX_TMPDIR` so it hits the same STANDARD default socket
  the manager is pinned to (see lifecycle `defaultTmuxEnv`); the inside/switch-client path keeps ambient
  env (it needs the operator's real client on that default server). cmux is
  deliberately absent — its agents are GUI-app tabs paw can't take a terminal over.
- `src/adopt.ts` — `paw adopt [folder] [--resume <id|name>] [--name <n>] [--no-start] [--no-attach]` (`--session` aliases `--resume`):
  bring a PAST **or running** claude session back as a LIVE paw agent, **one step**. With no `--resume`,
  auto-picks the folder's NEWEST session via `latestSession` — **including one a live claude holds**. The
  two-writer guard then REFUSES + proposes `--force` (a takeover) when that newest session is live, rather
  than silently skipping to an OLDER session and leaving the running claude behind (the confusing "adopt
  succeeded but nothing was taken over" case — 2026-07-09). This EXPLICIT refuse-and-propose replaced the
  old `latestUnconflictedSession` silent-skip: `paw adopt ~` now surfaces "your live session is here —
  `--force` to take it over" instead of quietly mis-pinning an older one (which is still safe against the
  original `aleks` home-folder mis-pin, just louder). An
  explicit `--resume <id|name>` is honored exactly (the two-writer guard still warns/refuses there).
  Resolves under `~/.claude/projects/<encoded-cwd>/` — `--resume` accepts a transcript
  id OR a **named session** (`claude --session-name`/`/rename`), resolved name→id via `src/named.ts`,
  and VERIFIES the transcript's recorded
  `cwd` matches (the project-dir encoding is lossy; rejects a session-id with `../`), upserts
  `resume: <id>` into the folder's persona (CRLF-safe, never clobbers a frontmatter-free body), then
  `ensure()`s the mesh+manager and brings it live — but only **`restartAgent`** (stop + respawn) when
  the resume pin actually CHANGED; re-adopting the SAME session uses `ensureAgentSpawned` (no-op if live)
  so it doesn't churn the agent or leave ghost presence entries. The agent is **named after the session
  if it's named** (`/rename` → `folderToName(space, folder, sessionName)`), else the folder basename
  (first registration wins). A session id recorded under a different worktree → an error naming the
  owning folder (`locateSession`). `--no-start` keeps it pin-only/local (no mesh, no spawn). The connector's
  `resume:` injection makes the spawn launch with `--resume`, so it rejoins the mesh with full history.
  **Two-writers guard:** before starting, `liveSessionProcs` (src/named.ts) checks the
  `~/.claude/sessions` index for a LIVE process holding that session id; if one is a standalone `claude`
  TUI (no `--dangerously-load-development-channels` in its command line — paw's own mesh agents carry it
  and are excluded) adopt REFUSES with a `kill <pid>` hint, since two writers on one transcript corrupt
  it. **`--force` / `paw adopt .` is a MAKE-BEFORE-BREAK takeover, not a kill-first bypass:** it brings the
  new mesh agent up and CONFIRMS its mesh link is live via the manager's `ps` (`waitForMeshLive` —
  src/addressing.ts, NOT `waitForPeerId`: the control endpoint is `watchPresence:false` so its roster is
  always empty; `op:start` already blocks until the agent registers, so the confirm returns in ~ms),
  lifting the two-writer guard via `allowForeignWriter` for the brief overlap between the new agent
  connecting and the holder dying — THEN SIGTERMs the holder(s) (wait ~8s, SIGKILL any straggler), so a
  failed spawn NEVER strands the operator with a dead session (on a confirm TIMEOUT it stops the
  just-spawned agent first, so the holder stays the sole writer). Before the inline kill it re-checks
  `isSelfAncestor` on the live holders and REFUSES to SIGTERM a process it's running inside (a `ps`
  false-negative could otherwise slip a self-held session past the early self-detection). Residual: if the
  adopted name has QUEUED DMs the new agent may take a turn inside the (seconds-long) overlap — an accepted
  tradeoff; in the self case the old claude is idle (blocked on this very command).
  **Self-adopt (`paw adopt .` from INSIDE the very claude that holds the session, 2026-07-13):** killing
  your own ancestor mid-command would kill the adopt, so when the holder is a process ANCESTOR
  (`selfSessionProc`/`isSelfAncestor`, src/named.ts) adopt hands the takeover to a DETACHED child
  (`spawnDetachedAdopt` — reparented to launchd, `COTAL_*` stripped, `PAW_ADOPT_INFLIGHT=1`, runs the
  synchronous `--force --no-attach` takeover, then `finishDetachedAdopt` drops the pidfile) that outlives
  the old claude — **no `--force` needed** (adopting the session you typed the command in is unambiguous).
  Guarded by an `adopt.pid` in-flight file (`adoptInFlight` — no stacking a second takeover) + an
  `adopt.log`, mirroring `paw restart`'s self-detach (macOS has no `setsid` → node-detached spawn). A
  NON-self takeover (`--force` from another terminal) runs the same make-before-break INLINE and, on a real
  TTY, **auto-attaches in place** via `attachResolved` (src/open.ts) unless `--no-attach`. **`--name <n>`**
  overrides the agent name (sanitized via `sanitizeAdoptName`; fail-loud if it sanitizes empty), winning
  over the session's `/rename` name. `--no-start` only warns. (paw can't stop the reverse — a `claude -r`
  you launch AFTER adopting — that's outside paw; the adopted agent's mesh name is the **folder** name
  unless `--name`/a named session sets it.) Test: `check:adopt` (self-ancestor/sanitize/parseArgs/in-flight).
- `src/addressing.ts` — folder→agent addressing. The mesh carries an agent's NAME but not its cwd
  (neither presence/roster nor `ps` expose it), so paw owns a per-space folder→name registry under
  `~/.paw/spaces/<space>/folders.json` (basename, collision-qualified with a path hash so two
  folders never share one agent). Plus `ensureAgentSpawned` (ps→spawn through `src/control.ts`),
  `ensurePersonaFile`, `controlCreds` (now only `paw status`'s JetStream read — see the control-rail
  section), `waitForPeerId`, and a stable per-space human id (`human.id`, for open-mesh reply
  redelivery).
  **Multi-instance (`agents.json` extras side-table):** N claude agents per folder. `folders.json`
  (`Record<folder, defaultName>`) holds each folder's DEFAULT agent — **UNCHANGED**, still one name per
  folder; `agents.json` (NEW, `Record<extraName, folder>`) holds ONLY the EXTRAS (2nd+ instances). An
  agent lives in EXACTLY one file — default in folders.json, extra in agents.json, NEVER both → nothing
  to sync → cannot desync; an absent `agents.json` (every existing 1:1 install) → `{}`, byte-identical
  to today. `--name <n>` on `paw chat`/`dm`/`open` spawns/addresses an extra at a FOLDER target
  (`registerInstance(space, folder, name)` writes agents.json under the SAME lock as folders.json,
  fail-loud if `name` cleans to empty or is already taken by any default/extra); no `--name` → the
  folder's default, unchanged. **Bare folder addressing (`paw chat .` / `paw attach .` / `paw dm .`)
  hits the DEFAULT when one exists** — extras stay opt-in via `--name`. **No default + exactly one extra
  → that extra** (`resolveFolderAgent`): `cd ~/paw-opencode && paw chat .` reaches `opencode1` (agent:
  opencode), it does NOT mint a sibling claude in folders.json. Several extras and no default → fail
  loud. `ensureAgentSpawned` already forwards persona `agent:` so the extra respawns as itself. Test:
  `check:addressing`. Global name-uniqueness is preserved across
  `Object.values(folders.json) ∪ Object.keys(agents.json)`: `folderToName`/`setFolderName`'s `taken` set
  now unions agents.json keys, `folderForName` falls back to `readAgentIndex(space)[name]` (resolves both
  a default and an extra), `listAgents`/`agentNamesForFolder` union the extras, `removeAgentName` drops an
  extra (leaving the default; `removeFolder` still drops a folder's default). Worktrees (`repo@branch`)
  stay the answer for parallel agents in SEPARATE dirs — this is specifically the SAME dir. New exports:
  `readAgentIndex`/`writeAgentIndex`, `registerInstance`, `agentNamesForFolder`, `resolveFolderAgent`, `removeAgentName`. Test:
  `check:addressing` (+ `check:concurrency` for the N-way `registerInstance` race).
  **Wake gate (`spawnAction`/`psRowAlive`, pure + unit-tested):** `ensureAgentSpawned` decides
  start | reuse | **restart** from the manager's ps ROW LIVENESS (`status`/`mesh`), not mere
  name-in-list. A crash/bounce leaves an agent LISTED but dead on the mesh (`status:"running",
  mesh:"offline"` — a process alive but its mesh link gone); the old gate reused any listed name, so
  `paw dm`/`paw chat` could neither wake it (skipped as "already running") nor reach it (not consuming)
  → timeout. Now a listed-but-dead row (`mesh:"offline"` or `status:"exited"`) → **restart** (ADMIN
  stop the zombie, then start fresh/resumed); `"absent"` (mid-start) counts as alive so a legit boot
  isn't killed — **but that is BOUNDED at the spawn site (`STARTING_GRACE_MS`, 2026-08-12)**: a boot
  that FAILS sits at `starting…` forever, so every wake path reused it and timed out — `paw chat
  research` said "isn't reachable on the mesh" against an agent listed as starting for THIRTEEN HOURS,
  and the suggested `paw down` wouldn't clear it either (the manager relists it on the way back up).
  The one state meaning "wait" was the one state nothing could recover from. `ensureAgentSpawned` now
  `waitForMeshLive`s an `absent` row for 15s and, failing that, RESTARTS it. The pure gate stays
  permissive (killing a live boot only costs a resume; the alternative cost 13h of unreachability). `paw status` uses the same `psRowAlive` so it agrees with `paw ps` (previously it marked
  any listed name "live", disagreeing).
  **Busy-guard (2026-08-27):** the restart branch used to despawn SILENTLY, and it fired on agents
  that were merely BUSY — a claude deep in a deploy/test run lags its presence, reads `mesh:"offline"`,
  and the next `paw dm`/`/api/dm` killed it mid-command ("my deploy got killed right after an inbound
  DM", research + queue-ea; queue release v119 stuck at `running` was this). `restartDespiteOffline`
  (pure, `check:addressing`) refuses the restart when the pinned transcript was written within
  `BUSY_GUARD_MS` (3 min) — the same local truth `inferBusy` uses; the DM simply waits in the durable.
  Every restart now logs its EVIDENCE (ps status/mesh + transcript age) to stderr, so the next kill
  is attributable in one grep instead of a week of symptom reports. Verified the counter-hypothesis
  with harbor: a 194s FOREGROUND command survived three mid-run DM deliveries untouched — DM delivery
  does not interrupt tools at the claude layer. SCOPE: this covers queue-ea's class (operator DM →
  despawn). research's dead `run_in_background` watchers were NOT this (its session context was
  continuous — no respawn happened). MEASURED cause, 2026-08-27, in this session: **the claude harness
  reaps a turn's `run_in_background` Bash tasks when that TURN ENDS** — a heartbeat task armed at a
  quiet moment beat at 10:47:44/10:47:54 and was dead by 10:48:04, the moment the turn closed, with no
  DM in flight and a 600s timeout untouched. The `status: killed` notice surfaces at the NEXT wake,
  which under dense DMs is always a DM's UserPromptSubmit — hence the false correlation. Monitor
  watches are session-scoped and survive. The brief now tells agents so. Two traps worth keeping (research's
  words): "the timestamp on a `killed` notification is the next wake, not the death" — notification
  times alone build the wrong model; and the respawn-vs-reap discriminator is whether the session's
  CONTEXT survived (a respawn destroys it, a reap doesn't). cotal's tmux
  runtime also exposes `interrupt()` = Ctrl-C into the pane, but nothing in the manager calls it.
  Side-find filed upstream (cotal feedback 80f52a2c): one DM to a mid-turn agent is delivered
  repeatedly (3× in 194s; 37× to a sleeping agent) — unacked-DM redelivery re-fires the wake nudge. Refined by research's controlled capture (addendum filed): an IDLE recipient with current
  presence gets exactly one delivery and it WAKES a turn (UserPromptSubmit) — redelivery is specific
  to recipients that can't ack promptly (mid-turn / asleep). RETRACTED same hour (research, correctly): a
  failed cotal_dm to paw-folder (`no peer "paw-folder"`) looked like presence lag on a healthy idle
  agent, but paw-folder's INSTANCE ID changed between research's two messages — the send landed in a
  reconnect/restart gap where there genuinely was no peer, i.e. the resolver was right. "Recently
  active" (`ACTIVE 14s`) does not mean "continuously alive". The busy-guard stands on queue-ea's
  killed deploys and v119 alone; do not cite the roster flake. Reproduced live: killing an agent's connector (mesh drops,
  process lives) makes the zombie; `paw dm` then restarts it back to idle, old proc reaped.
  **Spawn contract (cotal ≥ the v0.7 line):** the manager REQUIRES a persona file to start an agent
  (a bare name → `.cotal/agents/<name>.md` that must exist — no silent default-ACL fallback). paw,
  which addresses by folder, auto-generates a minimal ephemeral persona at
  `~/.paw/spaces/<space>/personas/<name>.md` (its `name:` is the agent's mesh identity) and spawns
  via `--config <abs>`. `ensureAgentSpawned` also forwards cotal's per-agent `--model` override.
  **Channel grants (`GRANT_LINES`/`withChannelGrants`, 2026-08-06):** that minimal persona now declares
  `allowSubscribe: [">"]` + `allowPublish: [">"]`. cotal's defaults are tight ON PURPOSE — an omitted
  `allowSubscribe` means "read exactly what you `subscribe` to" (itself defaulting to `[general]`) and
  an omitted `allowPublish` is a hard DENY (publishing is the dangerous capability, so it must be
  declared) — and paw declared NEITHER, so every paw agent could read only #general and post to NO
  channel: `cotal_join("team2027")` failed with "not within this agent's read ACL", and the whole
  channels surface (`paw web`, `cotal_send`) was inert for paw-spawned agents. `>` matches every channel
  (`channelInAllow`); it's the honest grant HERE because a channel ACL isn't a boundary in paw — agents
  already run `bypassPermissions` with full machine access and can read any channel through the CLI
  regardless of their mesh cred — and a narrower list isn't knowable, since channels are created at
  runtime. **`subscribe` is deliberately LEFT at `[general]`:** the ACL says what an agent MAY read,
  joining stays its own runtime act (`cotal_join`), so permission doesn't mean being woken by every
  channel in the space. **Quoting is load-bearing** — a bare `>` is YAML's folded-block indicator (the
  frontmatter is parsed as real YAML), so it must be written `[">"]`; `[>]` is a parse error. Existing
  personas SELF-HEAL on their next spawn (`ensurePersonaFile` upgrades write-if-absent PER KEY, so a
  persona that already states its own scope is never widened) — which means an ALREADY-LIVE agent keeps
  the old ACL until it restarts, since the cred is minted at launch. Test: `check:addressing`.
  **Ambiguity guard:** `assertUnambiguousTarget(space, target)` fail-louds when a BARE positional is BOTH
  a registered agent name AND the basename of a DIFFERENT folder in the cwd (the `paw log .`/`paw log
  <name>` wrong-session class). Exempts sigil-carrying targets (`.`, `./x`, `/x`, `~…`, `github:`,
  `<repo>@<branch>`). Called by chat/dm/open/log/rm/rename/adopt/sessions right after the space resolves.
  Tested hermetically in `check:addressing`.
- `src/sessions.ts` — `paw sessions [folder]`: LOCAL. Lists a folder's claude transcripts (id · when ·
  first user message · «name» if the session was named) and the agent's MODE — "fresh" vs
  "adopted ← <id>" (read from the persona's `resume:`), marking the pinned transcript. (NEW) `src/log.ts`
  — `paw log [folder|name|repo@branch] [--tail N] [--follow]`: read an agent's session DIRECTLY from its
  transcript (turns + tool calls) without attaching/messaging. LOCAL, read-only. **Dispatches on the
  persona `agent:`** — claude jsonl (`~/.claude/projects/…`), opencode sqlite (`<cotal-root>/.cotal/opencode/<name>/opencode.db`
  else `~/.local/share/opencode/opencode.db`, session.directory must be the agent's folder;
  `src/sqlite-readonly.ts` require()s `bun:sqlite` under bun and `node:sqlite` under node — a static
  `node:sqlite` import crashes the bun launcher: `No such built-in module: node:sqlite`),
  codex jsonl (`~/.codex/sessions` + `~/.cotal/codex/*/sessions`, matched on session_meta.cwd).
  Other harnesses (hermes, jcode, …) fail loud. Never a sibling's session in the same folder.
  Claude/codex **tail-read only the last ~512KB** so it's cheap on huge (100s-MB) transcripts; `--follow` polls.
  Renders in the **Claude-Code TUI shape**: `●` bullets for assistant text (markdown "glow" — headings,
  bold/italic, code, lists) and tool calls (`● Write(file)`), a `⎿` rail for each tool's result **paired
  from the following tool_result record** (a stateful `Renderer` holds tool_use→result by id), and `> `
  for user/wake turns. Tool names match the UI (`Task`→`Agent`, `mcp__x__y`→`x:y`); results are tool-aware
  (`Wrote N lines`, `Read N lines`, `Updated <f>`, first ~3 Bash lines, errors in red); the agent's own
  outgoing mesh DMs surface as `↩` replies, cotal plumbing/`ToolSearch` hidden.
  **`<task-notification>` renders like Claude Code does (`parseTaskNotification`, 2026-08-20)** — a
  monitor/hook wake arrives as an XML envelope (task id, `<summary>`, `<event>`, plus a standing
  instruction to the model about when to send a PushNotification). paw printed the whole thing, ~10
  lines of machinery per wake, burying the actual trace; Claude Code shows ONE line. Now reduced to a
  `notification` Block: the **`<summary>` VERBATIM** as the bullet — it already reads as the sentence CC
  prints, and a label of paw's own produced `Monitor event: "Monitor event: "…""` on real data and
  would have been simply wrong for the summaries that aren't monitor events (`Background command …
  completed`) — with the `<event>` body on the SAME `⎿` rail every other result uses. The id, the tags
  and the instruction are dropped. **No summary ⇒ `undefined`**, so an envelope paw doesn't understand
  renders in FULL rather than being silently reduced to nothing. Fixing it in `transcript.ts` fixed BOTH
  consumers at once (that is what the split is for), but note the web trace's blocks are parsed
  SERVER-side, so a client reload isn't enough — `paw web` must restart. Test: `check:transcript` (10
  assertions); verified against a real transcript and in the browser.
  **Source-faithful newlines in the trace (`md(text, {gaps:true})`, 2026-08-20)** — the SAME assistant
  message rendered in Claude Code and in paw's trace had different vertical rhythm, because CC
  reproduces the AUTHOR's line structure while paw applied uniform CSS margins to every block. Compared
  against the raw markdown rather than guessing from pixels: the source has `\n\n` between paragraphs
  and **no blank line** around its fenced block, and CC shows exactly that — fence flush against the
  paragraph above, next paragraph flush below. `md()` now optionally emits a `.mdgap` div per BLANK
  SOURCE LINE, and `.trace-md` blocks carry NO margin of their own (two sources of spacing would double
  it). **Opt-in, not default:** uniform margins are right for the chat, where every message is prose;
  the trace is a REPRODUCTION of another tool's output. Test: `check:web` (7 assertions incl. the
  flush-fence case); verified in the browser against the exact message from the operator's screenshots.
  **Runtime failures are coloured, not printed as prose (`failureText`, 2026-08-20)** — claude reports
  an API error or a failed background command AS A WHOLE ASSISTANT TURN, so paw rendered a connection
  collapse in the same ink as a considered remark; Claude Code colours them. Now a `failure` Block,
  amber on both surfaces (amber not red: the runtime failed, the session didn't). Matched on the exact
  shapes claude emits as a whole turn — an agent *discussing* an error stays prose, because
  mis-flagging real writing is the worse direction.
  **What paw CANNOT match, and why:** Claude Code's `✳ Crunched for 14s` / `Worked for 16m 22s` status
  lines appear **0 times in the transcript** — they are live UI chrome computed by the running TUI, not
  data. paw reads a file after the fact, so those cannot be reproduced without inventing durations,
  which would be worse than omitting them.
  **The PARSE lives in `src/transcript.ts`** (`TranscriptParser.feed(line) → Block[]`, `tailRead`,
  `meshTool`), split out of log.ts 2026-08-06 so a SECOND consumer (a browser, a status summary) gets the
  same walk without the ANSI; `log.ts` is now the terminal renderer over those Blocks, which carry SOURCE
  (raw markdown, summary lines) never presentation. The split was verified byte-identical on three real
  transcripts, piped AND under a tty, plus a live `--follow`. **`meshTool()` then fixed a rule that had
  NEVER FIRED:** the mesh cases tested `name.startsWith("cotal_")`, but an agent calls
  `mcp__cotal__cotal_dm` — so replies rendered as ordinary tool calls and the plumbing meant to be hidden
  printed in full (a real 60-block window: 21 plumbing lines / 0 replies before, 0 / 18 after). It checks
  the SERVER (so `mcp__other__cotal_dm` stays a tool call) and routes by the field the call CARRIES
  (`channel` → channel post, `to` → DM, `role` → anycast), because keying on the tool name printed `↩ ?`
  for every tool whose recipient lives under another key. Test: `check:transcript`. `--tail N` counts rendered
  BLOCKS (turns/actions), not raw lines. `blocksForAgent` dispatches by `agent:`; the claude path still
  goes through `chooseTranscriptId`: a PINNED agent's transcript is authoritative — if its file doesn't
  exist yet (booted, no turns) it **fails loud** rather than falling back to the folder's newest, which
  could surface an UNRELATED live session (the `paw log aleks`→human's-own-session bug); only an
  UNPINNED *claude* agent falls back to its latest. Opencode/codex never consult claude jsonl — falling
  back would print a SIBLING in the same folder (`paw log personal-grok` → `personal`'s perkmal-55).
  Missing session for that harness fails loud naming it. Test: `check:log`.
  The sessions command flags a pinned
  session that's ALSO open in a standalone `claude` outside paw (⚠ pid …, via `liveSessionProcs`) — the
  reverse two-writer case paw can't block. Read-only (uses `lookupFolderName`, never registers).
- `src/dm.ts` — `paw dm <name|folder|repo@branch> "<msg>"|-`: **fire-and-forget** DM to an agent. A lone
  **`-`** reads the message on **STDIN** — for producers that hand text to a command rather than build an
  argv (voice dictation prompted it: yapless runs its `output.command` with the transcript on stdin).
  NOT `"$(cat)"` at the call site: dictation is full of apostrophes and newlines so shell quoting breaks
  on the first possessive, and argv is world-readable in `ps` so every utterance would leak to any
  process listing on the machine. paw OWNS
  `dm` (NOT aliased to cotal's `send`) so it sends under the stable **"you"** identity — cotal's `send dm`
  fires from a throwaway peer literally named "send" (registerPresence:false, no inbox) that's gone the
  instant it sends, so the agent's reply is undeliverable ("send went offline"). Sending as "you"
  addresses the reply to your durable inbox; read it with `paw inbox`. **Pure sender**: registerPresence
  false (the mailbox beacon holds "you" present), **consume:false** (never binds "you"'s single durable
  consumer — that's `paw inbox`'s, and contending would starve it), watchPresence true only to
  resolve/spawn the target like chat (folder→spawn, offline name→respawn via `folderForName`). No
  wait/stream mode — the LIVE conversation is `paw chat`, the ASYNC hand-off is dm + inbox (a former
  `--wait` bound the durable consumer and could starve inbox/chat; removed). NEEDS_MANAGER.
- `src/mailbox.ts` — `paw mailbox` (daemon; auto-started by `ensure()`, not run by hand): the
  persistent **"you" presence beacon**. An agent can only deliver a DM to a peer it can RESOLVE in the
  live roster, so without a standing "you" presence a reply sent after `paw dm` exits is undeliverable
  ("send went offline"). This holds the stable "you" identity online (2s presence heartbeat) so agents
  can always reach you; their DMs land in your durable inbox for `paw inbox`. **Pure beacon:
  registerPresence:true, consume:false** — it never drains/acks your inbox (that would starve
  `paw inbox`/chat — cotal allows ONE active consumer on "you"'s durable). lifecycle.ts `ensureMailbox()`
  spawns it DETACHED (`node bin/paw.ts mailbox --space <s>` via the tsx runtime, pid in `mailbox.pid`, log in
  `mailbox.log`), called from `ensure()` on any mesh-up context; `stop()`/`paw down` kills it.
- `src/inbox.ts` — `paw inbox [--history] [--watch] [--limit N]`: read the human peer ("you")'s DM inbox — the
  READ half of the async loop (`paw dm @agent "task"`, walk away, `paw inbox` to collect the
  reply/PR/question). **PURE READER**: reads the DM stream directly via `ep.dmHistory()` (a throwaway,
  non-acking consumer, observer endpoint — registerPresence:false/consume:false) filtered to
  `m.to === me`, so it NEVER binds the durable consumer and can't contend with a live chat/`dm --wait`.
  "New since last time" is the SHARED local cursor (`src/cursor.ts`, `inbox.cursor`), NOT mesh acking:
  **default** shows DMs with `ts > cursor` then `advanceCursor`s past them; **`--history`** shows the
  last N (default 50), cursor untouched. **`--watch`** is a live foreground tail: it polls the SAME
  pure-reader path every 2s (mirrors `log --follow`), prints DMs as they arrive, and advanceCursor-s
  past each so the shared unread state stays consistent (Ctrl-C to exit; never binds the durable
  consumer, so it runs alongside a live `paw chat`). **It keeps its OWN high-water mark rather than
  gating on the shared cursor** (fixed 2026-08-06, reported live): the cursor answers "what haven't I
  read?" and EVERY surface advances it, so a `paw chat` open in another tab displayed each DM, moved the
  cursor past it, and the cursor-gated tail sat showing nothing while mail visibly arrived next door. A
  tail answers a different question — "what is arriving while I watch?" — which must hold whether or not
  something else also read it. First tick drains the unread backlog (cursor-gated, the useful catch-up);
  everything after is gated on what the tail itself has shown; it still ADVANCES the cursor, because
  reading here IS reading. Verified against a reader racing the cursor: old code printed 0/6, new 6/6.
  `--watch` + `--history` fail loud (contradictory).
  `paw chat` advances the SAME cursor when it shows a DM, so a
  message read live in chat won't re-surface in inbox (and vice-versa) — one unread state across both. Reads the newest via a tail (dmHistory returns oldest-N, so fetch up to `FETCH_CAP=10k` and
  slice the tail — a deeper history needs a tail-read API cotal lacks). NEEDS_MESH (mesh only).
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
- `src/named.ts` — named-session resolution. `claude --session-name`/`/rename` write the human name into
  `~/.claude/sessions/<pid>.json` (the transcript file stays UUID-named), so `resolveNamedSession(folder,
  name)` scans that index for a `{name, cwd===folder}` match (most-recent wins) and `namesForFolder`
  maps id→name for the listing. Read-only; tolerates partial index files.
- `src/github.ts` — github-handle addressing: `github:owner/repo[#branch]` (branch delim is `#`, not
  `@`) adopts a REMOTE repo by cloning it ONCE (blobless `gh repo clone … -- --filter=blob:none`, the
  upstream directly — **no fork**) into `<PAW_HOME or ~/.paw>/repos/<owner>/<repo>` and resolving to
  that folder. Idempotent (an existing `.git` checkout is reused, never re-cloned); a `#branch` is
  checked out, **CREATED if missing** (local → checkout, remote-tracking → checkout, else `checkout -b`).
  All sync (execFileSync) since `resolveFolderArg` is sync. `parseGithubHandle`/`ghCloneArgs` are pure
  + unit-tested; owner/repo validated against GitHub's charset (also blocks traversal/argv injection),
  unsafe branches (`..`, leading `/`, control chars) rejected. Fails loud if `gh` is missing or the
  clone fails (points at `gh auth status`). Test: `check:github`.
- `src/worktree.ts` — worktree addressing: `<repo>@<branch>` resolves (via `git worktree list`) to the
  folder of the worktree that has `<branch>` checked out. **Strict v1: resolves an existing worktree,
  fails loud if the branch/worktree is missing (never auto-creates).** `resolveFolderArg(target)` is
  the shared entry point used by chat/open/adopt/dm — it now resolves `github:owner/repo[#branch]`
  (clone via `src/github.ts`) first, then a `<repo>@<branch>` worktree, else a plain folder.
  `paw sessions <repo>` is repo-aware: lists every worktree + the claude transcripts inside each;
  `paw sessions <repo>@<branch>` shows just that worktree.
- `src/dispatch.ts` — pure, unit-tested CLI routing, SHRUNK by the endpoint-native rewrite (no more
  alias table — every paw verb is a paw-owned command now; `applyAliases`/`withNamePositional`/
  `isBareDmSend` deleted with their reasons). Three helpers remain: `withDefaultSpace` (append
  `--space` as a TRAILING flag; skip only on a real operator `--space` flag — never a bare `--space`
  word in a message body), `stripCotalNamespace` (peel the `paw cotal <cmd>` prefix so bin routes the
  remainder to the cotald subprocess), and `expandEqFlags` (`--space=x`/`--server=x` → two-token form
  the commands' hand parsers read; only those two flags, positionals untouched). check:dispatch.
- `src/images.ts` — **image/file attachments for `paw chat` + `paw dm`** (the `[Image #1]` flow). You
  drag an image onto the terminal and it inserts the PATH as ordinary keystrokes; `peelLine` pulls
  those paths out, substitutes `[Image #N]` in place, and the file rides as a `📷 [Image #1] <abs path>`
  line under the text. **The carrier is TEXT, deliberately — NOT a data part.** The claude connector
  flattens every inbound message with `parts.map(p => p.kind === "text" ? p.text : JSON.stringify(p.data))`
  (`toInboxItem`), and that ONE line is the only channel the model ever reads, so: a `kind:"data"`
  FileEntry reaches the agent as ~150 chars of raw JSON per image (worse than a clean path), and a
  `kind:"ai.cotal.image"` EXTENSION part is a **trap** — it's legal on the wire (passes core's
  `isMessagePart`) but `JSON.stringify(undefined)` flattens it to the EMPTY STRING, i.e. simultaneously
  valid and invisible. paw has FOUR independent copies of that flattener (chat.ts/inbox.ts/
  history.ts/watch.ts `textOf`), so any new part kind would silently vanish or leak JSON in three of
  them. Plain text hits every surface correctly with no new part kind — the same route the Telegram
  bridge already proves in production. If paw ever does need structure here it MUST be `kind:"data"`
  + the EXISTING `ai.cotal.file` proto, never a new proto and never an extension kind.
  **Staging (load-bearing):** cmux — the terminal where Cmd-V of image DATA yields a path at all —
  writes the pasted image to a temp file and later REAPS it (`cleanupTransferredTemporaryImageFiles`),
  so announcing the source path can hand an agent a file that's already gone. `stageAttachment` copies
  into `~/.paw/spaces/<space>/images/` **only when the source is under an ephemeral root** (`/tmp`,
  `/private/tmp`, `/var/folders`, …, matched on a path BOUNDARY so `/tmp` never matches `/tmpfoo` —
  same class as lifecycle.ts's space-exact regexes); a file in your repo is read IN PLACE so later
  edits are seen. Fails loud if the copy fails, never falls back to the doomed path.
  **Parsing:** `tokenizeLine` handles all three real drag conventions (backslash-escaped —
  ghostty/cmux/wezterm/Terminal.app; single-quoted — VS Code + kitty-at-prompt; bare), `paw dm` uses
  `peelWords` instead (the SHELL already unquoted, so each argv word is a finished path — re-tokenizing
  would re-split a name with spaces). **Absolute paths ONLY** — a bare `logo.png` is ambiguous (your
  cwd or the agent's folder?) and every terminal inserts absolute, so resolving it would be guessing.
  A path that doesn't EXIST is left alone silently — `write the chart to /tmp/out.png` is ordinary
  prose and must send as typed; the absence of the 📷 line is the signal that nothing attached.
  **Live buffer rewrite:** Cmd-V is invisible to paw — the terminal consumes the shortcut and writes
  the path in as ordinary keystrokes — so there's no paste event to hook. Instead a SECOND
  `process.stdin.on("data")` listener (alongside readline's own; it does NOT steal bytes) re-peels
  `rl.line` on `setImmediate` (required — at "data" time readline hasn't folded the chunk into
  `rl.line` yet) and, when a path resolves, rewrites the visible buffer via readline's own Ctrl-U +
  Ctrl-K + `write` so it redraws correctly with the re-widthed prompt. You SEE `[Image #1] ` where you
  pasted, and keep typing after it. TTY-only; the Enter-time peel remains the correctness backstop for
  a missed burst or piped stdin. Verified under a real node-pty.
  **`hasProse` is the send gate, not emptiness:** a path-only line peels to the NON-empty body
  `"[Image #1]"`, so an emptiness check sent a placeholder-only message — and a multi-file drop
  (which arrives as several separate readline lines) sent one PER file, each renumbered `#1` because
  the send cleared the pending list (caught live 2026-07-24). A path-only line now STAGES: the prompt
  shows `[N img]`, `/imgs` lists, `/noimg` clears, and the next line with prose flushes everything as
  ONE message. `[Image #N]` numbering is **per message** (matching Claude Code), so two concurrent chat
  sessions can each emit `[Image #1]` — harmless, the path is right there in the text. Extensions are
  exactly claude's Read-renderable set (png/jpe?g/gif/webp); anything else attaches as `📎 [File #N]`
  so paw never promises a picture Read can't display. **The connector brief is what makes it work at
  all** (the agent only sees the image if it calls Read) — the manager loads the connector at startup
  with no hot-reload, so a connector change needs `paw restart`. Test: `check:images` (hermetic);
  verified live end-to-end — agent Read the staged path and described the picture.
- `raycast/` — **the Raycast extension** (its own npm project, NOT a pnpm workspace member; paw's
  tsconfig `include` is explicit so `pnpm typecheck` never sees it). Two commands: **Paw Agents** (the
  `paw status` roster — mesh status, runtime, folder, inbox lag, last-active; Enter chats) and **Paw
  Chat** (opens straight into ONE GLOBAL transcript — every agent's DMs to "you" land in the same
  inbox, so the dropdown picks who your NEXT message goes to, not what you're looking at; the List
  SEARCH BAR is the composer — Raycast has no chat primitive, so `filtering={false}` + controlled
  `searchText` is the idiomatic substitute).
  **It SHELLS OUT to the `paw` CLI, never joining the mesh itself** — paw's human peer "you" owns a
  SINGLE durable DM consumer and cotal allows one active consumer per durable, so a second process
  connecting under that identity would contend with a live `paw chat`/`paw inbox` and starve it. Via
  the CLI, Raycast is just another reader of the same state. Raycast runs extensions with a MINIMAL
  PATH (no shell rc, no nvm), so the launcher is invoked by ABSOLUTE path — fine, because
  `~/.local/bin/paw` already resolves bun/tsx absolutely for exactly this class of caller (verified
  with `env -i`). Sending is `paw dm` (which also WAKES an offline agent from its pin); replies arrive
  by POLLING `paw inbox --json` every 2s (skipping a tick while the previous one is still in flight,
  or a slow mesh stacks `paw` processes; a RUN of failed polls toasts instead of looking like a quiet
  empty chat). The chat opens on the last 30 inbox messages and then shows anything newer than the
  moment it opened — a bounded tail, because the inbox holds the whole history with every agent and
  replaying all of it would bury the conversation you just started. There is no mesh-side "working"
  signal to render (`cotal_status` is agent-invoked, so peers read `idle` mid-turn), so a pending line
  carries the honest client-side one instead: `sending…`, then a ticking `waiting 12s`, then `failed`.
  **Installing is `npx ray build -e dev`, run ONCE — no dev server needed.**
  That hands the compiled bundle to the Raycast app, which keeps its OWN copy: nothing is written into
  the extension folder (no `dist/`, no hidden build dir — checked), and the commands stay in Raycast
  after the CLI exits. Re-run it after a change to push the new build; `npm run dev` is the same thing
  plus a file watcher. (An earlier note here claimed the extension was only live while `ray develop`
  ran — WRONG, and it sent the operator hunting for a daemon they did not need.) **Unread state is RAYCAST'S OWN, tracked PER MESSAGE**
  (`src/read-state.ts`, a LocalStorage Set keyed per space). Two designs failed first, both worth
  keeping: (1) sharing paw's `inbox.cursor` — every paw surface advances it as a side effect of
  DISPLAYING, so with `paw chat` open in a terminal it is past the newest message before Raycast
  renders and nothing is ever unread; (2) a Raycast-local CURSOR — still ONE number for the whole
  inbox, so reading anything from agent B silently marked agent A's older messages read, and since it
  only moved on an explicit keystroke it never moved at all. The unit of reading is a MESSAGE, so the
  state is per message, and a message is marked read when you SELECT it — that makes the state
  maintain itself instead of depending on a shortcut nobody presses. Bounded at 2000 keys (oldest fall
  off, which can only resurface an old message as unread, never hide a new one); an unparseable value
  reads as "nothing known read", never "all read" — a storage glitch should show too much mail, not
  hide it. ⌘⇧R marks everything currently VISIBLE (in a focused view, that conversation only) and also
  advances paw's shared cursor, since "I have read these" is true everywhere. The store is SHARED, not
  per-component, for the same reason `feed.ts` is: Raycast keeps pushed-behind views MOUNTED and the
  chat stacks a focused view over the unfocused one, so two components each held a copy loaded at
  mount and the filtered and unfiltered views disagreed about what you had read. Subscribers and the
  in-flight load are keyed BY SPACE — one session only talks to one space today, but a flat set would
  quietly hand space A's read state to a view showing space B.
  **Image attachments** ride as extra
  ARGV WORDS to `paw dm`, that command's existing contract (it peels absolute paths, stages them,
  rewrites to `[Image #1]`), so Raycast gets paw's whole attachment pipeline and cannot drift from the
  terminal. macOS has TWO clipboard shapes and both are handled: a COPIED FILE exposes a path
  (`Clipboard.read().file`), while a SCREENSHOT is raw image DATA with no path — Raycast exposes no
  image buffer, so that case goes through `osascript` (`the clipboard as «class PNGf»`) written under
  `~/.paw/clipboard/`. A zero-byte or failed extraction is DROPPED rather than announced as an image the
  agent can't Read, and a FAILED send puts the staged images back instead of silently losing them.
  Verified end to end: clipboard data → osascript → `paw dm` argv → staged → received → Read rendered it.
  **Empty states are gated on the FIRST read**, in both commands: before it lands, "no messages" /
  "no agents registered" is not true, it is not-yet-known, and flashing it reads as a broken chat or a
  dead mesh. An error also counts as loaded — better the empty state than a spinner forever.
  **Enter on an EMPTY composer toggles the filter** (it was a no-op before): narrow to the agent whose
  message the cursor is on, Enter again on empty widens back. The primary action RENAMES itself
  ("Send" / "Filter to X" / "Show All Agents"), because an unlabelled key that does two different
  things depending on hidden state is a feature nobody finds.
  **Two modes, expressed as NAVIGATION.** Unfocused, the chat is the whole inbox (every agent's DMs to
  "you" share one stream); opening an agent from the roster pushes a FOCUSED view — that agent's
  messages plus your own sends to them — on top of the unfocused one (`ChatEntry`). So Escape widens to
  the full transcript and Escape again goes back, WITHOUT paw binding Escape: it is bindable, but taking
  "go back" away from the operator is a worse trade than one extra view on the stack. The recipient
  dropdown is hidden while focused (switching it there would send to B while you read A).
  **`src/feed.ts` — one refcounted poller per kind, because Raycast keeps pushed-behind views MOUNTED.**
  The moment the chat stacked two views, per-component intervals meant TWO `paw` processes every 2s,
  each spawning a runtime and connecting to NATS — the cost is O(views), and views are exactly what the
  operator adds by navigating. N subscribers now share ONE interval and ONE invocation; the last
  unsubscribe stops it, and a new subscriber gets the last payload immediately so a pushed view renders
  populated rather than blank-then-filled. The roster feed yields the WHOLE `StatusPayload`, not just
  rows: `errors` carries paw's inbox-lag query failures (which paw reports rather than fabricating a
  zero for), and dropping them to keep the type tidy would discard the one signal saying the lag column
  is unknown rather than fine.
  **Row shape:** the row carries the AGENT NAME, the read/unread state and the time — and NOT the
  message, which lives in the detail pane. Three columns competing for a narrow list truncated all
  three ("paw-fol… / all thre… / 3 minutes"); dropping the preview gives the name and stamp room to
  render whole. The LEFT slot carries ONE signal — this is new: an unread row gets a dot, a READ row
  gets NO icon, so the eye lands on what changed instead of scanning a column of identical decoration
  (an indicator every row has indicates nothing). A FAILED send keeps its mark regardless — an error
  must never be the thing that renders as blank. An unread line from an agent that is currently OFFLINE
  goes RED, because that is the case where no reply is coming until something wakes it; the roster
  behind it is re-read every 15s (much slower than the 2s message poll — presence changes on a human
  timescale) since a red "offline" dot that is merely STALE is worse than none. Offline stays GREY on
  the agents list on purpose: most agents are offline most of the time, so painting twenty rows red
  would make the resting state look like an alarm. Times are
  RELATIVE (`date-fns` `formatDistanceStrict`, pinned 4.4.0 for the age gate) computed from a threaded
  `now` rather than the wall clock, so the whole list renders off ONE instant and cannot disagree with
  itself; `now` ticks every 1s while awaiting a reply and every 30s otherwise, because a relative stamp
  that stops ticking freezes at whatever it said when the last message landed. **State is never encoded
  in colour alone** — Raycast themes recolour, and a tinted tag can land invisible against the accent
  (the "red on red" report), so unread is a glyph in the accessory TEXT (`● unread`), which inherits the
  theme's own foreground.
  `@raycast/api` is PINNED to 1.104.23, the newest release outside the
  registry's min-release-age window (the gate is a supply-chain guard — pin, don't override).
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
- **`paw inbox --sent`** — widen the read to BOTH directions (adds `dir: "in"|"out"` and, for an
  outgoing message, `to`). The default stays your INBOX (messages addressed to "you"); a chat UI needs
  the whole conversation, because a transcript of only the other side is half of one and reopening it
  would lose everything YOU said. The recipient is an ID on the wire, so names are resolved from the
  stream itself (any agent you have talked to has almost certainly replied, and its reply carries
  `from.name`); an id that never appears as a sender STAYS an id — an id you can still match on is
  honest, a guessed name is not.
- **`paw inbox --mark-read`** — the EXPLICIT "I've seen these" verb, added for surfaces that DISPLAY
  without consuming. Every other read path either advances `inbox.cursor` as a side effect of PRINTING
  (the default) or deliberately never touches it (`--history`, `--json`); a GUI showing unread state
  needs a way to clear it that isn't "print everything again". Forward-only like every other writer, and
  it counts BEFORE advancing (counting after always reports 0 — caught immediately).
- **`paw status --json` / `paw inbox --json`** — machine-readable output added for the extension and
  useful for any tool. status emits the SAME `AgentStatus` rows the table renders (so the two cannot
  disagree) plus the inbox-lag `errors` IN the payload rather than only on stderr. **inbox's `--json`
  never advances the shared `inbox.cursor`** — a GUI polling every second would otherwise silently
  mark everything read out from under `paw inbox`/`paw chat`, which share that one unread marker;
  `--watch` + `--json` fail loud (one-shot vs feed).
- `src/markdown.ts` — **markdown → ANSI (the "glow" pass), shared by `paw log` and `paw chat`.** Agents
  write markdown everywhere else, so they write it on the mesh too; printed raw it's `**this**` and a
  wall of un-delimited code. Extracted from `log.ts` (which had a private `inlineMd`/`renderMarkdown`
  and now imports these) and upgraded with fenced code blocks, ordered lists, horizontal rules,
  strikethrough and links. It is a RENDERER, not a parser, and the two rules that keep it honest are
  **never lose content** (fence DELIMITERS are consumed — they become the `│` rail — and nothing else
  is; an UNTERMINATED fence still renders its lines rather than swallowing them) and **never eat paw's
  own placeholders** (`[Image #1]`/`[Pasted text #1]` are bracket-shaped, so the link rule requires
  `](` immediately after the label — a bare `[…]` is left alone; unit-tested both ways). ORDER IS
  LOAD-BEARING in `inlineMd`: code spans first so their contents are shielded from the emphasis passes
  (`` `a*b*c` `` must not italicise) and the ANSI they leave behind carries no `*`/`_`/`~` to trip a
  later pass; bold before italic, else `**x**` reads as an empty italic around `*x*`. Emphasis may not
  open or close on WHITESPACE — without that, arithmetic prose (`2 * 3 * 4`) and shell globs italicise
  everything between them (caught by `check:markdown`, not by review). Fenced bodies get NO inline pass
  — the point of a code block is that its contents aren't markdown. Colors are tty-gated, so piping
  `paw log`/`paw chat` still yields clean ANSI-free text (which is what every assertion checks).
  `paw chat` renders every inbound peer message through it: a one-line body stays on the header line,
  anything longer becomes an indented block beneath. Test: `check:markdown`; verified live under
  node-pty (headings, bullets, ordered lists, fenced code, blockquote, links all render in a real chat).
- `src/paste.ts` — **multi-line paste for `paw chat`** (the `[Pasted text #1]` flow, sibling to
  `[Image #1]`). readline is line-oriented, so pasting a 40-line stack trace fired 40 `line` events and
  sent 40 SEPARATE messages — each a fragment, each waking the agent, the last arriving before the
  first was read. **The signal is bracketed paste (DEC mode 2004)**: with `\e[?2004h` set the terminal
  wraps pasted content in `\e[200~`…`\e[201~`, the only trustworthy "this was pasted" marker — a
  timing debounce would be a guess, and paw doesn't guess. **Why a PREPENDED raw listener** (verified
  under a real pty, node 26): (1) `prependListener("data")` sees the chunk WITH both markers before
  readline processes it; (2) readline silently DROPS the markers (they decode as unknown CSI
  sequences), so they never reach `rl.line` and can't be recovered there; (3) the paste then fires
  exactly ONE line event per newline in the payload and leaves the trailing segment in `rl.line`. So
  chat flags the paste from the raw chunk, **swallows exactly that many line events**, then rewrites
  the buffer to the placeholder via the same Ctrl-U/Ctrl-K rewrite the image swap uses. readline itself
  is never wrapped or replaced, so editing/history/completion are untouched. **The first swallowed line
  is `<what you'd already typed>` + `<the payload's first line>` FUSED** — the prefix is recovered by
  stripping the known first line, so `check this ` survives the paste landing after it. **The rewrite
  must be `setImmediate`-DEFERRED**: the last swallowed line fires while readline is still mid-chunk,
  so clearing then lets readline append the tail AFTER the placeholder
  (`[Pasted text #1]   at gamma()` — caught in the live pty test, same class as the image swap's
  deferral).
  **A paste ARRIVES IN CHUNKS, so suppression starts at the START marker (2026-08-12).** A pty hands
  stdin ~1022 bytes at a time, so a 3KB paste is FOUR `data` events and `\e[201~` lands only in the
  last — while readline processes each chunk as it arrives and submits its lines. Arming the collapse
  off the FINISHED payload (all `feed` can yield) was therefore three chunks too late, and a 40-line
  build log went out as **38 separate messages**. NOT a regression: it never worked above one chunk,
  and every test + live check used a 4-line paste that fits in one. Now `pasteOpen` is set on the START
  marker and every line event while open is HELD; `pasteFired` counts those so the count-based swallow
  only covers the final chunk (both orders work, incl. open+close within one chunk). The typed PREFIX
  is fused into the first submitted line and separable only once the payload's first line is known, so
  the raw line is kept and split at completion. Measured under a real pty: 38 messages before, 1 after.
  `check:paste` feeds ~3KB in 1022-byte slices and asserts `pasting` holds across the gap — a
  single-chunk fixture cannot exercise it.
  `PasteScanner` reassembles a payload split across ANY chunk boundary including
  mid-marker (a 6-byte escape sequence is not atomic on a pty read); `\r`/`\r\n` normalize to `\n`
  (terminals send `\r` inside a paste, and readline ends a line on either, so the count and the
  payload must agree). **Collapse is thresholded** (`shouldCollapse`: ≥2 lines, or ≥800 chars): a short
  single-line paste is indistinguishable from typing and MUST behave exactly as before — verified live.
  **Unlike an image the text RIDES IN the message** (there's no file to Read): the body keeps
  `[Pasted text #N]` where you pasted it and each payload follows in a fence naming the same
  placeholder, so several pastes stay individually addressable. Same plain-text carrier rationale as
  images — the connector flattens every inbound message to ONE string. Surface: `📋 [Pasted text #1]
  4 lines, 49 B` + a 3-line preview, a `[N pasted]` prompt badge, `/paste` to list, `/nopaste` to clear;
  `\e[?2004l` on shutdown so the operator's shell doesn't inherit the mode. Test: `check:paste` (38
  assertions incl. reassembly at EVERY split point); verified live under node-pty — a 4-line paste that
  used to be 4 messages now sends as ONE.
- `src/multiline.ts` — **typing a multi-line message in `paw chat`** (2026-08-13), the other half of
  `paste.ts`: pasting several lines was handled, TYPING them wasn't — you got one line, or you sent
  three messages. **Two ways in, because terminals disagree about what they send.** (1) A continuation
  KEY: alt+enter (`ESC CR`/`ESC LF`) plus the CSI-u encodings of shift/ctrl+enter (`\e[13;2u`,
  `\e[13;5u`) that kitty-protocol terminals emit — **measured under a real pty before being relied on:
  readline DROPS all four as unrecognised escapes (no line event, nothing inserted), which is precisely
  what makes them free to define rather than a key paw has to fight readline for.** Detected at the END
  of the chunk (it usually carries the character typed just before it). (2) A **trailing backslash**,
  the universal fallback — a key only works if your terminal sends it and there's no way to know but to
  try. **ODD** trailing backslashes continue: `C:\path\\` ends in an ESCAPED backslash and is a
  finished line, and miscounting would swallow the Enter on any path, regex or LaTeX macro. Held lines
  are REPRINTED (`↵ ALPHA`) because the buffer rewrite that clears the line also erases what you typed —
  otherwise you compose a message you can no longer see. Never fires inside a paste. Verified live under
  a real pty: five typed lines → TWO messages, both with real newlines. Test: `check:paste`.
- **`paw chat` cross-session echo + the ↓ agent picker** — two additions that both hang off the
  same fact: every `paw chat` runs as the SAME peer ("you"). **Echo:** a message one session sends is
  addressed to the AGENT, not to "you", so other open sessions never received it and their transcripts
  silently diverged. chat now `ep.tap`s the space — a plain NATS subscribe, ephemeral, NO durable
  consumer, so it cannot contend with the inbox (the one-consumer rule) — and surfaces anything sent
  by "you" that this process didn't send, as `↗ you → <agent> (other session): …`. Telling mine from
  theirs is EXACT, not heuristic: `unicast`/`multicast` mint a uuid per message and return it, so
  every send records its id in `ownIds` and the tap does a lookup rather than matching text and
  timestamps. **But the check cannot be made immediately** — the broker echoes a publish back to our
  own tap BEFORE `unicast` has returned the id, so "not in `ownIds`" is not yet evidence of "not
  mine", and deciding on the spot made a session label its OWN message `(other session)` (seen live).
  The tap therefore waits out any in-flight send (`sending` counter, plus a short grace for the
  resolve itself) and re-checks before rendering. The tap handler is shape-guarded (a space tap also sees control replies, which carry no
  `from`, and core doesn't try/catch it — an unguarded deref kills the feed permanently).
  **↓ picker:** readline maps down-arrow to history-next, which on an EMPTY line with nothing ahead
  does nothing — so the keystroke was free. ↓ opens a real picker: live peers (with status) then
  registered-but-offline agents (a message wakes those from their pin), **typing filters it**, ↑/↓ move
  the selection, Enter picks. Mid-edit ↓ stays history-next. Built ON readline, not against it — **the
  selection IS the line buffer** (`@name`), so Enter needs no interception and flows through the
  existing `@name` handler, which already latches the sticky target and respawns an offline agent.
  **The filter is held in the picker's OWN state, never read back from `rl.line`:** readline handles
  ↑/↓ as history-prev/next and REPLACES the buffer with a past line before the prepended handler runs,
  so reading the filter from it saw something that no longer looked like `@name` and closed the picker
  — the arrows cycled history and the marker never moved (reported live). A typed key re-syncs the
  filter from the buffer; an arrow never does.
  Pausing readline to own the keyboard would also stop the data events the filter reads, and
  re-implementing editing/history/completion for one widget is a bad trade. Redraw erases exactly the
  rows it drew (`moveCursor` + `clearScreenDown`); submit RESETS without erasing, because readline has
  already echoed the line and those rows are scrollback — erasing there would eat unrelated output. Both verified under a real node-pty, the echo with two concurrent chats in one space.
- **`paw chat` modes: the sigil says what you're looking at (`parseChatTarget`/`passesFilter`, 2026-08-19)** —
  chat only ever answered "who am I talking to"; "what am I looking at" was always *everything*. Four
  forms now: `paw chat` (global — every conversation, plain lines to #general) · `paw chat <folder>`
  (global, that agent PRESELECTED — **unchanged**, so no existing invocation shifts meaning) ·
  **`paw chat @<agent>`** (FILTERED: only that agent's DMs are shown, marked read, and sent to) ·
  **`paw chat '#<channel>'`** (that channel only; plain lines POST to it). The sigils are the operator's
  existing in-REPL vocabulary (`@name`, `#channel`) reused as the argument grammar rather than a second
  one, and a BARE name keeping its old meaning is what makes the sigil an opt-IN. **A hidden message is
  never marked read** — `passesFilter` gates the SAME branch that calls `advanceCursor`, because hiding
  a DM and advancing past it would silently consume mail you never saw (the shared-cursor mistake, one
  scope down); it's announced in one dim line and stays in `paw inbox`. Channel mode passes
  `channels: [room]` to the endpoint — the default subscription is #general only, so a filtered session
  would otherwise wait on traffic it never receives (posting needs no subscription, being a publish).
  `shouldFollowDm` is **disabled** in a filtered session (the target IS the point), and an in-REPL
  `@other` moves the FILTER with the target, so the view never stops matching who you're addressing.
  An empty `@`/`#` fails loud rather than silently meaning global. **`--only` reaches the FILTERED (`@name`) view by FOLDER or `.` instead of by name** (operator, 2026-09-09: "does `paw chat .` filter to one agent? if not add `paw chat --only .`") — `paw chat --only .` resolves the cwd's agent and shows/reads/sends only it, `paw chat --only <folder>` likewise; it fails loud on a `#channel` target (already single-channel) or an empty/broadcast target (nothing to filter to), and is a redundant no-op on `@name` (already filtered). Verified live under a pty: `paw chat --only .` → "showing: this agent only", prompt `you → paw-folder (only)>`. **The cross-session ECHO is filtered
  by the SAME predicate** (2026-08-20): it arrives through `ep.tap`, not the message handler, so
  `passesFilter` never saw it and `paw chat @a` printed every line you typed to @b in another window,
  under a banner promising "this agent only". Not merely untidy — those lines carry whatever you sent
  elsewhere, including a secret meant for one agent, into a view opened for another. Test: `check:chat` (19 assertions);
  the fail-loud paths verified against the real CLI. Verified live 2026-08-21 (operator screenshot):
  `paw chat @research` showed the filter banner, sent only to research, and announced hidden DMs from
  two other agents as dim one-liners without consuming them.
- **`!cmd` in `paw chat` (2026-09-09, operator's ask: "same logic as paw web")** — the same contract as the
  web composer, reusing src/bash.ts verbatim (`parseBang` / `runBash` / `bashMessage`): the command runs in
  the STICKY agent's registered folder (`folderForName`, fail-loud if unregistered or gone), the output
  prints in the chat, and the agent is DM'd the identical console transcript so the answer becomes its
  context. Needs an `@name` target — a channel has no folder, so broadcast mode refuses with a hint rather
  than guessing a directory. Only a LEADING `!` counts (parseBang), so prose with a `!` still sends. The
  output is ONE emit (emit redraws the prompt per call; a build log emitted line by line is N redraws).
  **It is a MODE, like the web composer** ("i dont see the prompt change"): `!` as the first character
  on an empty line with an agent targeted is CONSUMED and the prompt flips to
  `$ runs in ~/folder → then tells <agent>>` — the mode is shown by the prompt, not by a sigil sitting in
  the text, so what you send and what you see agree. Backspace on the empty command line leaves it (the
  reverse of the key that entered it), Esc leaves it keeping the text, switching `@name` leaves it (a
  command typed for one folder never runs in another), and one command per entry. Implemented as a
  prepended stdin listener (the picker/paste pattern): the `!` check runs after readline folds the key in
  (`setImmediate`, `rl.line === "!"`), Backspace is read BEFORE readline eats it against an already-empty
  buffer. Verified under node-pty: `!` → prompt flips; BS → back; `echo MODE_OK` ran + DM landed; Esc kept `abc`.
- **`paw chat` follows the conversation (`shouldFollowDm`, 2026-08-19)** — an arriving DM takes over the
  sticky target when your input is EMPTY, so answering whoever just spoke (the overwhelmingly common
  next act) doesn't cost a re-typed `@name`. "Empty" is deliberately WIDER than the text buffer, because
  retargeting under someone's hands is precisely how a message reaches the wrong agent: HELD
  continuation lines are a message that simply hasn't hit Enter, and STAGED images/pastes are composed
  input too — you dropped that file FOR the agent on screen, so switching under it would reintroduce the
  misdirection `stagedFor` exists to prevent (2026-08-17) by another door. Two DM kinds never retarget,
  neither being someone talking to you NOW: `historical` (backlog replay on join) and a STALE
  redelivery — JetStream re-delivers an unacked DM from a crashed session, so a days-old message can
  land mid-conversation; the cutoff is the SAME 60s line `agoTag` draws, so what you SEE tagged as old
  is exactly what refuses to steal focus. Always ANNOUNCED (`↪ replying to <name>`) — a target that
  moves silently is the bug, not the feature. In broadcast mode it latches a target where there was
  none. Test: `check:chat` (pure predicate). NOT yet verified live: a second `paw chat` would contend
  for "you"'s single durable consumer, and one was open.
- **`paw chat` visual rounds** — every `emit` declares its SIDE (`you` | `peer` | `sys`) and a blank
  line is inserted when the side changes, so your message, the ⏳/✓ receipts and the reply group into
  one block with air before the next. Tracking the side (rather than blank-lining every emit) keeps a
  burst of presence/roster noise tight instead of double-spaced. Multi-line message bodies indent
  their continuation lines so a 30-line reply reads as a block instead of colliding with the next prompt.
  **The blank belongs AFTER the receipt, not after your own line.** Everything conversational
  (`you`/`peer`) closes with a trailing blank, because emit ALWAYS redraws the prompt right after — so
  that trailing blank IS the air before the prompt; `sys` noise is excluded so presence churn stays
  tight. Two subtleties, both found by replaying the pty stream through a terminal model (raw byte
  dumps LIE here — they still show prompts that `clearLine` erased on a real screen): the line YOU type
  is echoed by readline and never passes through `emit`, so the handler claims `lastSide = "you"` on
  submit — otherwise the first receipt reads as a peer→you side CHANGE and opens with a blank, putting
  the air after your message instead of after the ⏳. And `trailingBlank` is cleared on submit, since a
  blank the previous round ended on is no longer adjacent once a prompt and your typed line sit between.
- `src/names.ts` — `HUMAN_PEER` constant (the name the human joins under), shared by the connector
  brief and chat with zero deps to avoid a cycle.
- `src/tasks.ts` + `web/app/tasks.js` — **the fleet's SHARED TASK LIST (beads, 2026-08-25).** The store
  is bd's own machine-wide db (`~/.beads`, embedded dolt — bd ≥1.x is dolt-only; `bd init` into a
  custom dir resolved to the global anyway, so paw uses bd's default rather than fighting it). THREE
  wires: (1) the connector injects `BEADS_DIR=~/.beads` into every agent's launch env — load-bearing
  because bd resolves a repo-local `.beads` FIRST, so an agent cwd'd in team2027 would otherwise file
  fleet tasks into that repo's own project tracker, invisibly; applies per agent at its NEXT restart.
  (2) The brief tells agents the discipline: file (`bd create`), claim before starting
  (`--status in_progress`), close with a reason, don't override BEADS_DIR. (3) `paw web` gets
  `GET/POST /api/tasks` (bd list --json / bd create, 15s server cache — each bd call spins an embedded
  dolt engine), a foldable Tasks sidebar section (in_progress > blocked > open > unknown-LAST; an
  unknown status renders as itself, never blank), and a **`/task <title> [-- description]`** composer
  command (leading-only, like /invite; on failure the text is PUT BACK in the composer). `!bd …` bang
  commands also run under `bdEnv()` (bash.ts) so they hit the same db. bd's install gotcha, hit live:
  a stale bd 0.63 in `~/.local/bin` shadowed homebrew's 1.x — `which bd` before trusting it. Tests in
  `check:web` (13 assertions); routes verified live (GET listed, POST filed + returned fresh list).
- **Operator requests become tasks (brief, 2026-09-09):** "auto-beads all incoming user requests so i can see
  the status of my prompts — well maybe not ALL". The brief now tells every agent: an operator DM that is
  more than one small immediate action (commit / open a PR / answer — no task) is filed with `bd create`
  BEFORE starting, assigned to the agent, claimed, closed with a reason; title in the operator's own
  wording cleaned up (typos, filler, "can you" dropped) — never a paraphrase, never a verbatim quote;
  description = the full ask + what done means; multi-step asks get one task with steps or `--parent`
  sub-tasks; when in doubt, file. Applies per agent at its next restart (the brief is built at spawn).
- `web/app/taskspad.js` — **the TASK PAD (2026-08-25): the shared list as an editable, Apple-Notes-style
  bullet list**, opened full-size over the main pane from the ⤢ on the Tasks header. Text-first: every
  title is contenteditable; Enter = next task (the auto-bullet); Backspace on an emptied row removes it;
  the BULLET is the status control (click cycles ○→◐→✓; blocked/deferred cycle back to open — never a
  state without an affordance). Edits debounce 1s (blur flushes) into `/api/tasks` ops
  (`op: create|update|close`); a NEW row gets bd's own id stamped in from `bd create --silent`.
  Discipline: the pad is the WRITER while the operator is in it — `maybeRender` skips a poll rebuild
  while a row is focused/dirty/inflight (the lost-draft bug, one surface over); a failed sync marks the
  row `⚠ not saved` and KEEPS the text; removing a synced row CLOSES it with a reason (shared list —
  never hard-delete an id a teammate may hold), an unsynced row just drops (`deletionPlan`). The Tasks
  header stays visible when the list is empty (unlike PRs) — an empty list is still where you ADD.
  Server ops in src/tasks.ts (`createTaskGetId`/`updateTask`/`closeTask`/`commentTask`); `/api/tasks`
  POST takes `op: create|update|close|comment` (+`parent`, `text`), and writes return `{ok}`/`{id}`
  WITHOUT re-listing (a re-list doubled every write's cost — each bd call boots an embedded dolt
  engine, ~1s). **bd calls are SERIALIZED** (`chain` in tasks.ts): dolt is single-writer and two
  overlapping pad writes made one fail. Pure parts tested in `check:web` (treeOrder/taskDepth/
  pasteOutline/relTime/cycleStatus/deletionPlan); DOM behaviour is verified with **python playwright
  (1.29, `/opt/homebrew/bin/playwright`) against the live daemon, asserting COMPUTED STYLE** — see
  the lesson below.
  **What the pad does (all 2026-08-25/26, each reported by the operator on first use):** SAVE ON
  BLUR (8s backstop, never under the fingers); ↑/↓ and ←/→ cross rows like one document; paste is
  plain-text, and an INDENTED paste (`pasteOutline`: tabs or the paste's smallest space step) files a
  real parent/child chain sequentially (a child's create needs its parent's id); **Tab/Shift-Tab**
  reparent via `bd update --parent` OPTIMISTICALLY (indent in ~30ms, write behind, revert on failure);
  children render indented (`treeOrder`/`taskDepth`, id chain bounded at 6); **drag the id chip** to
  reorder — display order only, persisted per space in localStorage, a parent carries its subtree and
  can't drop into it; the hover card on the id (created/by, updated, assignee, blocked-by); the **💬
  at the end of the text** (Notion-style, click-only — an input under a passing cursor was an ambush)
  opens the interactive card: `@agent message` → a **bd comment on the bead** + a DM nudge carrying
  the id (`bd show <id>` for the thread); no tag = bare note, nobody pinged; persistent 💬N when
  comments exist; ⛓ chip with open blocker ids (server enriches via `bd show` per dependent task
  inside the 15s cache); a refused status change **reverts the bullet and shows bd's words** ("blocked
  by open issues …") — never a lying ✓; double-click on a bullet is one cycle; sticky display order
  across rebuilds; a fetch that STARTED before the last write is refused (`lastWriteAt`) so a poll
  can't revert a save; `?at=tasks` deep-links the pad; exactly ONE sidebar row lights at a time (the
  pad yields Activity/agent highlights). `BEADS_ACTOR=<agent>` in the connector env makes agent-filed
  tasks say "created by research" rather than git's user.name.
  **The lesson that cost the evening:** `#taskspad{display:flex}` overrode `[hidden]` (an author
  `display` beats the UA's `display:none`), so the pad was PAINTED over every view from load while
  every close path "worked" — the property flipped, chats opened underneath. My probes asserted
  `.hidden`, never computed style, and agreed with the code against the operator's screenshots for
  three rounds. Fix is `#taskspad[hidden]{display:none}`; the discipline is a visible **client build
  stamp** (`CLIENT_BUILD`, shown in the pad hint + console) and an on-page **fault banner** for any
  uncaught error, so "which code is this tab running" is answered by a screenshot. Also: a launchd
  `kickstart -k` silently didn't take once — check the new pid/lstart after every deploy.
- `web/app/board.js` — **the Board (2026-08-26): the same list as a kanban**, a VANILLA port of a
  21st.dev/shadcn "trello-kanban-board" React component the operator pasted ("ignore the tailwind
  stuff and rewrite it into your system"). paw web is no-build vanilla JS served from the checkout, so
  the port keeps the component's SHAPE (columns, draggable cards, drop highlight, add-a-card) and swaps
  its state for bd: columns are statuses (`columnsFor`, unknown status → To do, never lost), a drag
  between columns is `op:update status` (Done = `op:close`, the card leaves — closed tasks aren't in
  `bd list`), add-a-card is `op:create` (+status). Optimistic with bd's refusal printed on the card.
  **Tasks and Board are FOCUS TARGETS** (`TASKS = "~tasks"`, `BOARD = "~board"` in app.js, `?at=tasks|
  board`): `render()` reconciles the pad/board open state from `state.focus` — never opened/closed on
  their own — so selecting anything else replaces them, ✕/Esc = `focusTarget(null)`, and exactly one
  sidebar row lights. That replaced the overlay's parallel open/close state, which produced a whole
  class of "tapped X, got Y" bugs (a click on the already-focused agent under the pad toggled to
  Activity). **Re-click = scroll to end (2026-08-27):** clicking the already-selected agent or
  channel row no longer toggles to Activity — it jumps the conversation to its newest message
  (`scrollToEnd`); the toggle read as "the click broke" when you were three screens up. Gotcha: `const board = initBoard(…)` MUST be module-scope — declared inside a render
  function, `render()` resolved `board` to the `#board` ELEMENT (`window.board`) and threw
  `board.isOpen is not a function`; the fault banner surfaced it in one probe. Tests: `check:web`
  (columnsFor/initials); drag→status→revert, deep link and view swaps verified headless.
  **Sub-tasks + the card modal (2026-08-26):** a task whose parent is on the board is NOT its own
  card — it rides inside the parent's card as a checklist (`columnsFor` skips it, `childrenOf` lists
  it); the bullet cycles its status (optimistic, revert + reason on refusal), its TEXT opens its own
  modal (an inert sub-row was the first thing a probe hit — a click that does nothing reads as broken).
  Clicking a card opens a Notion-style modal: status chips (click = `move()`, Done closes and the
  modal dismisses), description, metadata, the sub-task checklist, and the COMMENT THREAD from
  `op:comments` (`listComments`/`parseComments` in tasks.ts over `bd comments <id> --json`, uncached —
  read on open) with a compose box (plain = `op:comment`; `@agent` = comment + `/api/dm` nudge, same
  contract as the pad's card). Cards use the CONTENT palette (`--content-alt`/`--line`/`--txt`) — the
  sidebar aubergine was unreadable in light mode. Verified headless: open → post (thread 0→1) → esc →
  sub-task modal.
- `web/app/editlist.js` — **the editable-row contract, packaged (2026-08-26).** Sub-task checklists
  on the board (cards + modal) edit exactly like the task pad — rename on blur, Enter = new sibling
  (`op:create` with the list's parent), Backspace-empty = remove (close/drop), ↑/↓ and edge ←/→
  across rows — via `wireEditableList(container, {api, parent, onCreated/onRenamed/onRemoved,
  onSynced})` over rows shaped `.eli[data-id] > .elt[contenteditable]`. `keyAction` (pure, tested in
  `check:web`) holds the key rules that went wrong in the pad. **The pad still carries its ORIGINAL
  copy of this logic** (initTaskspad's closure) — folding it onto this module is the next
  consolidation; two copies is a known, dated debt, not a design. Board rows carry a hover `↗` to
  open the sub-task's own modal since the text is now an editor. Esc inside any editor ends the edit,
  never the modal (`.elt, input, textarea` are exempt from the modal's capture-phase Esc). Verified
  against bd: rename + Enter-create through the modal landed with the right parent.
- **Per-agent tasks in a RIGHT SIDEBAR (2026-08-26; replaced the short-lived Chat|Trace|Tasks mode
  the same afternoon)** — `renderAgentTasks` in app.js renders into `#aside`; `render()` toggles
  `.body-grid.withaside` (a third 320px column) + `#aside[hidden]` on whether an AGENT is focused —
  never for channels/Activity/the pad/board. The list sits BESIDE the chat rather than replacing it. **Global db, filtered — decided over per-repo:** every
  agent is pinned to `~/.beads` (BEADS_DIR shadows repo-local `.beads` on purpose; the per-repo dbs
  were merged in), so an agent's list is `agentTasks(tasks, name)` (pure, in web/app/tasks.js:
  assignee OR createdBy, case-insensitive) — a FILTER of the one list, never a second store. Editable
  via editlist.js; a row added under the "assigned to X" group is created with `-a X` (the api wrapper
  injects `assignee` into `op:create` — the one seam editlist offers; server `createTaskGetId`/
  `updateTask` accept `assignee`). Never rebuilds while a row is focused. Verified: a row added under
  research landed in bd assigned to research.
- **PR-type beads (2026-08-26):** `bd create "<t>" -t merge-request --external-ref <PR url>`
  (`merge-request` is a CUSTOM type — `bd config set types.custom merge-request` was needed once in
  the global db; `bd list --type` names it but `create` refuses it unregistered). `parseTasks` carries
  `type`/`externalRef`; `listTasks` enriches merge-request beads with the LIVE PR via
  `prInfoByUrl(url)` (src/git.ts — `gh pr view <url>` from $HOME, same parse + 60s cache as the PRs
  sidebar, keyed `url:<url>`, non-GitHub refs short-circuit to undefined). `prChipHtml` (taskspad.js,
  pure, tested) renders the sidebar's vocabulary — ⧉ merged / ◍ open / ◌ draft / ⊘ closed + ✓✕•
  checks — as a link in the pad row, the board card footer, and the modal title; an unresolved ref
  still links as "↗ PR". Demo bead: beads-nlz → caffeinum/paw#15. **They also join the PRs SIDEBAR** (`taskPrRows` in
  tasks.ts, pure/tested; `/api/prs` merges them ahead of the live agents' folder PRs, deduped by url
  so a folder PR with a review bead shows once — with the bead id as `◇ <id>` on the row's second
  line). The operator asked for this AS A COMMENT ON THE BEAD through the pad's card, and the reply
  went back the same way (`bd comment` as paw-folder) — the comment→bead→nudge loop, used in anger.
- **Closed beads stay visible for a week, at the bottom (2026-08-26):** `listTasks` = open work
  (`bd list -n 0` — bd's default cap is a SILENT 50 rows) + `--status closed --closed-after <7d>`
  (`CLOSED_WINDOW_DAYS`), `STATUS_RANK.closed = 8` so they sort last; `closedAt`/`closeReason` pass
  through (hover card: "closed 3h ago — reason"). Client: `closedLast` (taskspad.js, pure/tested)
  is applied by `treeOrder` at EACH level — closed top-levels after open ones whatever the drag order,
  closed children at the end of their parent's checklist; the board's Done column HOLDS them (dimmed,
  `bdone`) instead of being drop-only; the per-agent tab says "N open (+M done this week)"; the
  sidebar Tasks count is OPEN-only and `taskPrRows` drops closed review beads from the PRs sidebar.
  Verified headless: 71 rows, closed at the end at each level, count 22, Done column 43.
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
- `src/github.ts` accepts a PASTED URL under the `github:` sigil (2026-08-24):
  `github:https://github.com/o/r`, `github:github.com/o/r/`, `github:git@github.com:o/r.git` all peel
  to `o/r` (+ `#branch` kept) — the old error `invalid owner "https:"` was true and useless.
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
- `src/cotal-root.ts` — `pawCotalRoot(space)`: THE cotal root for a space, replacing every bare
  `findCotalRoot()` (which defaults to `process.cwd()`). cotal finds a checkout's root by walking UP
  from the cwd for a `.cotal/` dir — correct for cotal (one mesh per checkout), WRONG for paw, which is
  machine-wide (one space, one mesh, agents rooted in dozens of unrelated folders), so the same command
  must resolve the same root from anywhere. Precedence: `PAW_COTAL_ROOT` (escape hatch, absolute or
  fail-loud) > the space's mesh-registry entry (`recordMesh` persists `root` at mesh-up; read back with
  `findMesh`) > `homedir()` (not a guess — where `~/.cotal` lives, and what the registry holds for every
  paw space, so first-run and steady-state agree). Zero-dep leaf like `names.ts`/`cursor.ts` so both
  `lifecycle.ts` and `addressing.ts` can import it without a cycle. **The 2026-07-29 incident:**
  `~/Github/team2027` has its own `.cotal/auth/auth.json`, a LEGACY MONOLITH labelled space `"main"`.
  paw spawned its daemons with NO `cwd`, so the manager inherited the operator's shell directory,
  resolved root there, and read that repo's auth through cotal's SecretStore seam — which, unlike the FS
  reader (`loadSpaceAuth` correctly answers `undefined` for a wrong-space bundle, so the CLI itself
  degraded to open mode), fails LOUD: `the space trust bundle (auth/auth.json) failed trust-chain
  validation for space "paw"`. The manager never stayed up. The same root split made it record
  `root /Users/aleks/Github/team2027` and fight the running manager for the space's SINGLETON LEASE
  (`a manager already serves space "paw" … root /Users/aleks` / `wrong last sequence`), and
  `cotalNatsPidPath` is root-relative too, so `paw down` from there would have read
  `<team2027>/.cotal/nats.pid` and killed THAT repo's nats server. Fix is two-sided: the five bare
  `findCotalRoot()` call sites now take the space (`cotalNatsPidPath`, `probeCreds`, `ensureSpaceAuth`,
  `controlCreds`), AND every daemon spawn passes `cwd: pawCotalRoot(space)` so the daemon's OWN root
  discovery agrees with paw's. Verified live: `paw status` from inside a directory holding a
  mislabeled `.cotal/auth/auth.json` now works. Test: `check:commands`.
- `src/release.ts` + `src/commands/release.ts` — **OTP-style RELEASE DISCIPLINE: the daemons run from an
  IMMUTABLE snapshot, never from the operator's checkout** (2026-08-21). **The incident:** every daemon
  (mesh `up`, manager `supervise`, mailbox beacon, `paw web`) resolved its entry file AND its
  `node_modules/tsx/dist/cli.mjs` from `REPO_ROOT` — `/Users/aleks/Github/paw`, the tree the operator also
  EDITS. A `pnpm add @cotal-ai/*@0.25.0` ran there while a 0.15 manager was live; the next `ensure()`
  started a SECOND manager off the half-installed tree → two managers on incompatible protocol versions →
  fleet down. Generalised: any `git checkout`, install, or half-saved edit in the repo was an unreviewed
  LIVE change to whatever daemon started next. **The fix is the OTP one — you don't mutate a running
  system, you stand a new version up beside it and cut over:** `paw release` snapshots the checkout into
  `$PAW_HOME/releases/<id>/` and flips a `current` pointer; `paw restart` (unchanged) brings the daemons
  up from wherever it now points. **The id is a CONTENT hash** (12 hex of a sha256 over
  bin/+src/+web/+package.json+pnpm-lock.yaml, sorted paths, `<relpath>\0<filehash>`), so the same tree is
  the same release (re-running is a free no-op) and a bumped dependency — which moves pnpm-lock — is a
  DIFFERENT release by construction. **Not `git describe`:** the incident's tree was DIRTY, and a describe
  would have called it the same release as the clean one it no longer was. node_modules is copied but not
  hashed (100MB+); the lockfile is the honest statement of intent, and `paw release` is a deliberate act
  you run AFTER an install, never something ensure() does behind your back (`--force` re-copies for the
  one case the id can't see). **node_modules travels as `cp -Rc`** — an APFS CoW clone, ~free, degrading
  to a real copy elsewhere; **a symlink or `cp -l` hardlink back into the checkout is FORBIDDEN — that
  aliases the bytes and IS the original bug with extra steps** (asserted: the release's inode differs).
  Immutability is content-addressing + write-once: built under a `.staging-*` name, renamed into place
  (so no reader ever sees a half-copy), never written again. **The flip is rename(2)** — a symlink made
  under a temp name and renamed over the pointer, so another process sees the old id or the new one and
  never a missing pointer (unlink-then-create would leave a window where paw has NO release, which under
  fail-loud is a command that dies for nothing; asserted from a real child process: 214k reads across 4k
  flips, 0 missing). `currentRelease` reads the LINK, never `realpathSync` — realpath rewrites the path
  through every symlink above it (a `$PAW_HOME` under `/var` comes back `/private/var`) and the release
  path would stop matching the one `paw release` printed. **`daemonRoot()` fails LOUD when nothing is
  pinned** (naming the one-line fix) rather than falling back to the checkout — the silent fallback is the
  behaviour being ended. **THE BOUNDARY:** the discipline covers what paw spawns as a child of itself —
  every `viaTsx` caller: mesh, manager, mailbox, `paw web`'s node re-exec, the detached restart/adopt
  children, and the `paw cotal` passthrough (which must speak the manager's cotal version). The
  short-lived foreground CLI still runs straight from the checkout: it exits in a second, can't drift out
  from under anything, and keeping it there keeps the dev loop fast. `PAW_RELEASE=dev` puts the daemons
  back on the checkout, printing a loud line every time (it IS the pre-incident behaviour);
  `PAW_RELEASE=<id>` pins/rolls back. **`paw release --prune N` never deletes the CURRENT release** however
  old it is — that's what the live daemons are running, and deleting it would be the outage from the other
  direction. **The pgrep ownership patterns are unaffected, and that was the load-bearing check:**
  `managerMatchPattern`/`mailboxMatchPattern` match `cotald\.ts supervise --space <s> --server` — the TAIL
  of the entry path plus flags, naming no directory — so a daemon launched from a release dir still
  matches and `paw down`/`paw restart` still find it, still space-exactly (asserted against release-dir
  argv in check:release). Had they been anchored to a path prefix, this change would have silently
  orphaned every daemon. Test: `check:release` (64 assertions: determinism, lock-sensitivity,
  immutability under a live edit + a reinstall, argv stability, cross-process flip atomicity, prune
  safety, the pgrep patterns, arg parse). Verified live on an isolated space: no release → fail loud;
  `paw release` → `ensure()` brought mesh+manager+beacon up with every daemon argv under
  `releases/<id>/`; editing the checkout changed neither the release's bytes nor the resolved argv;
  a second snapshot + `paw restart` cut over to the new dir.
  **`check:loop` and `check:spawn-env` set `PAW_RELEASE=dev`** — the first must never write into the
  operator's REAL `~/.paw/releases` or move the pointer their live daemons follow (a test must not cut
  over production), the second is about PATH/exec resolution, not which tree.
- **`nodeBin` / `viaTsx` (src/lifecycle.ts)** — the daemon spawn resolves node ABSOLUTELY, never via
  PATH. `node_modules/.bin/tsx` is a shell shim whose last line is a bare `exec node …`, so spawning a
  daemon through it required `node` in the CHILD's PATH. The launcher already resolves bun absolutely,
  so the CLI itself runs from anywhere — which is exactly what hid this: **paw works right up until it
  has to START a daemon**, then dies with `tsx: line 20: exec: node: not found` buried in
  mesh.log/manager.log while the terminal shows a generic "mesh failed to start". Exposed by the
  Raycast extension (Raycast runs extensions with a minimal PATH — no shell rc, no nvm, no
  `/opt/homebrew/bin`), but a launchd job or any stripped env does the same. `viaTsx` now runs
  `<abs node> node_modules/tsx/dist/cli.mjs <entry>`; `nodeBin()` prefers `process.execPath` when that
  IS node, then the usual absolute installs, then nvm's `default` alias, and FAILS LOUD rather than
  returning a bare "node" that would fail later as somebody else's error.
  **`withToolPath` — node was only the FIRST hop.** A daemon inherits the caller's PATH and then has to
  exec `tmux`/`cmux`/`gh`/`claude` itself; on a normal macOS box every one of those lives in
  `/opt/homebrew/bin`, `~/.bun/bin` or `~/.local/bin`, none of which a stripped PATH has. So resolving
  node absolutely fixed the mesh but left the manager coming up and failing to exec `tmux` — surfacing
  as `manager started but did not answer ps within 8s (is tmux running and reachable?)`, which names
  tmux and is not a tmux problem. `daemonEnv` now BACKFILLS the missing tool dirs, and so do the tmux
  reap, the `cmux ping` probe/reap and the detached-restart wake. Missing dirs are APPENDED, never
  prepended: the operator's ordering is a deliberate choice (it is how a chosen node version or a
  shimmed binary wins) and paw only fills what isn't there at all; non-existent dirs are skipped.
  Test: `check:spawn-env`, which asserts the exec is absolute and not the shim, that a present
  tmux/cmux/gh stays reachable, that ordering is preserved — and RUNS the resolved command under a
  stripped PATH, since both bugs type-checked fine. NOT covered: a full mesh+manager COLD start from a
  stripped PATH, because `DEFAULT_SERVER` is a hard constant in core and `ensure()` takes no server
  override, so an isolated boot can't avoid the live 4222.
- **`explainManagerFailure` (src/lifecycle.ts, 2026-08-20)** — the manager-startup error used to dump
  ~20 lines of manager.log and ask "is tmux running and reachable?", which is the WRONG question in
  every case but one and reads as a tmux fault. It now CLASSIFIES the tail and names the cause in two
  lines: a second manager (`already serves space` / `managerProcs > 1`) → "they compete and neither
  wins, `paw down`"; **lease churn** (`lost its singleton lease`, COUNTED) → "it started but keeps
  losing its lease and restarting, which drops every agent each time"; a missing binary (`not
  found`/ENOENT) → the one case that DOES name the runtime; else the last 3 lines. Always ends with the
  log PATH rather than reprinting it — a path is a better offer than 20 lines of someone else's output.
  **A duplicate is detected ONLY from the manager's own `already serves space` line, NEVER from a
  process count:** a healthy manager is TWO processes (the tsx wrapper + the node child it re-execs —
  the same fact that made `managerProcs` signature-based in the first place), so `> 1` is true on every
  working install. I shipped that heuristic and it would have labelled every failure a duplicate; caught
  the same day by reading `ps` on a healthy box.
  **WHY it matters (reported live):** on a dead LTE link `paw chat` failed this way and the message
  pointed at tmux. The real chain is **slow internet → slow agent boots → loaded machine → LOCAL mesh
  timeout → the 0.15 lease bug tears the manager down → paw restarts it → it revives the whole fleet →
  repeat** (measured in the operator's log: 25 lease losses, 24 restarts, ending with 2 competing
  managers). paw's mesh itself never touches the internet — `DEFAULT_SERVER` is `nats://127.0.0.1:4222`,
  a raw IP with no DNS, and `ensure()` makes no HTTP calls; the internet enters ONLY through the agents
  the manager spawns. Test: `check:commands` (9 assertions on the classification).
- **Mesh-registry hygiene** — `~/.cotal/meshes/<space>.json` records which mesh owns a server URL, and
  cotal's `up` preflight matches the FIRST entry holding a port. `check:loop` used to delete its paw
  state dir but NOT its registry entry, so every run left a `pawloopprobe` claiming
  `nats://127.0.0.1:4222`; with six such leftovers accumulated, a mesh restart failed with
  `✗ nats://127.0.0.1:4222 is already in use by mesh "forktest-90246"` — a test space from weeks
  earlier. `check:loop` now calls `removeMesh(space)` in its teardown. A test that litters shared
  machine state is a landmine that goes off much later, in an unrelated command.
- **`stripHarnessMarkers` / `HARNESS_SESSION_MARKERS` (src/lifecycle.ts, 2026-09-08)** — Claude Code stamps its
  own process tree with session markers (`CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_SESSION_ID`, `CLAUDECODE`,
  the messaging socket/token, …). A `paw restart`/`paw start` run INSIDE a claude session (an agent
  restarting the fleet after an outage — exactly what paw-folder did) passed them to the detached manager
  and from it to EVERY agent it spawned, which then booted as "child sessions" with **transcript saving
  OFF** ("inherited CLAUDE_CODE_CHILD_SESSION marker", operator screenshot) — paw's durability silently
  gone for the whole fleet. `daemonEnv` (the one choke point: mesh, manager, mailbox, detached
  restart/adopt children, `paw claude`) now drops an EXPLICIT marker list; operator config under the same
  prefix (`CLAUDE_CODE_USE_BEDROCK`…) is kept — a list, not a prefix wipe. Verified live: after a clean
  restart no manager/agent env carries the markers and no pane says transcript off. Test: `check:spawn-env`.
  **2026-09-08 outage, for the record:** nats-server 2.14.0's filestore for `KV_cotal_presence_paw` hit
  `Critical write error: no message found` at 06:38 (disk 98% full, the KV carried 122 never-cleaned
  presence-watch consumers, its msg block had just rotated); every presence put failed for 3h20m →
  empty roster, manager/mailbox timeouts, keeper flapping, MCP links closed, while every daemon was
  RUNNING. Fix: delete the (ephemeral) presence KV, `paw restart`, `paw start`. Neither cotal nor paw
  detected a failed stream — follow-up in beads-eic (store hygiene, keeper probe, disk headroom).
- **`sanitizeNodeOptions` / `daemonEnv` (src/lifecycle.ts)** — the env every paw-spawned child gets:
  the operator's, minus NODE_OPTIONS preloads that would kill it before it runs. cmux wraps a claude
  session with `NODE_OPTIONS=--require=<tmp>/cmux-claude-node-options/restore-node-options.cjs` and
  later REAPS that temp dir out from under the still-running session (the same reaping `images.ts`
  stages pasted images around), after which EVERY node process spawned from that terminal dies at
  preload with `MODULE_NOT_FOUND` before reaching a line of its own code. paw's detached children
  inherit the env, so `paw adopt .` printed its `⟳ adopting…` banner from the PARENT while the child
  was already dead — the traceback went to `adopt.log`, so the terminal showed a success banner and
  nothing happened, twice (2026-07-29). A preload that isn't on disk cannot be honoured and isn't
  paw's to keep: drop it and say so, rather than let node kill a daemon with a stack trace about a
  file the operator never named. Only ABSOLUTE and `file://` targets are checked — a bare specifier
  (`--import tsx`) resolves from node_modules at load time and a relative one against the CHILD's cwd,
  so neither is paw's to judge; a dangling flag with no target passes through (node's error is
  clearer). Applied at every spawn site: mesh `up`, the manager daemon, the mailbox beacon, the
  detached restart/adopt children, and `paw claude` (whose HOOKS are node — the same stale preload
  breaks them, which is how the session that hit this showed `Stop hook error` too). Test:
  `check:commands`.
- **`paw web` RE-EXECS ITSELF UNDER NODE when the CLI is bun (`reexecUnderNode`, 2026-08-19)** — paw's
  rule was always "the CLI may run under bun, the DAEMONS must be node+tsx", written for node-pty's
  ioctl. `paw web` is a long-lived daemon started through that same CLI, so it inherited bun and hit a
  SECOND incompatibility: **bun's `node:http` server never emits `upgrade`**, so the WebSocket handshake
  gets NO REPLY — not a 403, not a close, nothing. Measured side by side on identical code: bun answers
  nothing (the client sits on `connecting…` forever), node returns `101 Switching Protocols` instantly.
  Without the socket the browser falls back to its 2s poll, which browsers throttle hard in a BACKGROUND
  tab — so mail appeared to arrive "only on start", which is exactly how it was reported. `web()` now
  hands the whole command to `pawViaTsx` (now exported) and becomes a passthrough — stdio inherited,
  exit code forwarded, SIGINT/TERM/HUP forwarded so Ctrl-C stops the child rather than orphaning it.
  Re-exec rather than refuse: the operator asked for a server, and "run it a different way" is paw's job.
  Done BEFORE `ensure()` so nothing runs twice. Verified live through the real bun launcher: a bun parent
  with a node child, `101` on the handshake, `status` frames arriving, socket staying open. Test:
  `check:spawn-env` (the node branch must NOT fork; the bun branch is unreachable from node and was
  verified live).
- `src/web.ts` + `web/app/` — **`paw web`**: the mesh in a browser, LOCALHOST only (added 2026-08-06,
  built by three agents: dev-web the daemon, pm-web the acceptance checks, paw-folder the client).
  `paw web [--port 7788] [--space s] [--no-open]` — **7788 because cotal web owns 7799**, and a busy port
  THROWS rather than picking another (auto-increment is the failure that looks like success: you open the
  port you asked for and debug this morning's stale daemon). Serves `GET /api/status` · `/api/inbox` ·
  `/api/trace/<name>` · `POST /api/dm` · `POST /api/read` and a `/ws` pushing `{type:"message"|"status"}`.
  **WHY IT EXISTS rather than `cotal web`:** cotal web cannot see paw-local state (per-folder agents,
  sessions, the shared cursor) or an agent's TRACE — the claude transcript lives on disk and never crosses
  the mesh. **Security (no token, operator's call):** loopback bind + EXACT-match Origin (a `startsWith`
  passes `127.0.0.1:7788.evil.example`, ours-in-the-path and ours-as-userinfo) + a **Host** check, which is
  what actually stops DNS rebinding. **The server owns unread** — over the WHOLE conversation, not the
  page slice, or the count changes with every `limit` a caller passes; `dir !== "out"` (not `=== "in"`,
  because the inbox-only shape omits `dir` and everything in it is by definition addressed to you).
  `POST /api/read {ts}` is the CLEAR half — without it the badge only ever counts up, since the cursor
  advances when a paw surface DISPLAYS a message and a browser isn't one. `ts` is what was displayed, not
  `Date.now()`, and the client only marks when the tab is **visible and focused** — rendering happens in a
  background tab too, and silently-cleared mail is worse than a stuck badge. **The hand-rolled WebSocket
  framing is where the bugs were:** 27 assertions found a control frame >125 bytes truncating its length
  and desynchronising the stream (RFC 6455 §5.5). The pong is the assertion in those tests — a misparse
  leaves the stream misaligned rather than erroring. Tests: `check:web` (hermetic; it
  points PAW_HOME at a temp dir because `/api/read` WRITES the shared cursor).
  **`/invite @agent` (composer slash-command, 2026-08-06)** — `POST /api/invite {channel, names}` DMs
  each agent asking it to `cotal_join` the channel you're viewing, then posts `invited @a, @b to this
  channel`. It is a **REQUEST, not an admin action, and the surface must not pretend otherwise**: cotal
  has no "add someone else to a channel" — membership is the agent's OWN act — so paw can only ask, and
  the channel line is what makes the ask visible even if the agent never acts on it. Only agents
  actually REACHED are announced (naming an un-DM-able one would claim something that didn't happen);
  one failure never aborts the rest; the DMs go SEQUENTIALLY because each may spawn a sleeping agent.
  The parse (`web/app/commands.js`, tested) is client-side since it decides command-vs-message, matches
  only at the START of a line (so "use /invite to add someone" still sends as a message), and REPORTS a
  token that can't name an agent rather than dropping it (`/invite @a @b!` must not read as though @b
  was asked). In a DM it stays an ordinary message — there's no channel to invite anyone to. **Caveat
  that WILL bite: an agent's ACL is minted at SPAWN**, so an agent already running from before the
  channel-grant fix refuses the join until restarted (observed live; the agent diagnosed itself:
  "ACL is baked at spawn"). Verified live end-to-end into a brand-new channel.
  **Drafts, conversation stepping, and the unread divider (`web/app/conversation.js`, 2026-08-07).**
  **Drafts are PER (space, target)** — there is ONE textarea, so nothing scoped them and a half-typed
  line stayed in the box on switch, i.e. one global draft following you around (that's how a message for
  one agent gets sent to the next one you open). Persisted in localStorage, because the point of keeping
  what you typed is that it survives the reload you most want it back after; keyed by SPACE too, since
  two spaces share a browser origin. **Staged images move with the draft but are NOT persisted** —
  unscoped they'd attach to whatever you opened next, but a persisted staged path would promise a file
  cmux may have reaped (the failure images.ts stages around). Cleared when the draft becomes a message,
  NOT on a failed send (that text lives on in the retryable pending row). **The restore waits for the
  first inbox read**: the key needs the space, which only that read reveals — restoring in `readUrl`
  reads the wrong key, comes back empty, and leaves the draft on disk with no way to reach it.
  **Option-↑/↓ steps conversations** in the sidebar's own order AND filter (`orderTargets` — a keyboard
  order that disagrees with the visible one makes the selection look like it jumps at random). CLAMPED,
  never wrapped (in a 40-agent list a wrap is indistinguishable from a glitch); a focus filtered out from
  under you starts from the top rather than doing nothing. Bound on the DOCUMENT so it works with the
  cursor in the composer, `preventDefault` because macOS otherwise moves the caret by paragraph.
  **The "new" divider** marks where you left off. `firstUnreadTs` is computed ONCE when the conversation
  is opened and FROZEN: the cursor advances as messages are displayed, so a live one would slide away
  while you were still looking for your place. Only INBOUND messages open the run (your own send would
  put the line above your own words); CHANNELS are excluded because unread is tracked against the DM
  cursor and there is no channel equivalent — a divider there would be unsupported. The scroll-to-divider
  is ONE-SHOT (scrolling on every poll is the bug that made reading older messages impossible). Test:
  `check:web`; all three verified in a real browser.
  **`!cmd` in the composer (2026-08-13)** — `POST /api/bash {agent, command}` runs a shell command in the
  FOCUSED AGENT'S folder (`folderForName`; an unregistered name fails loud rather than defaulting to
  some directory), then **DMs the agent the command AND its output** (`bashMessage`, a fenced console
  transcript). Handing it over IS the feature: `!git log -5` becomes the agent's context, so the next
  question is grounded in what the repo says. Stated plainly: **this is arbitrary code execution
  reachable from a page.** It's consistent because `paw web` ALREADY exposes `/api/dm` against agents
  running `bypassPermissions` — directness, not new capability — and inherits the same and only
  defences (loopback + exact Origin + Host). NOT a boundary. Only a LEADING `!` counts (`src/bash.ts`
  `parseBang`, mirrored client-side in `web/app/bash.js`), so prose containing one never runs; the
  command goes through a SHELL on purpose (pipes are most of why you'd type it), so nothing may ever be
  assembled from anything but what the operator typed. 60s timeout, 256KB output cap, and `code` is
  read as a NUMBER only (a spawn failure sets it to a STRING like ETIMEDOUT, which would render as
  "exit ETIMEDOUT"). The result returns even when the DM fails, so a command whose delivery breaks
  isn't also lost to the operator. Test: `check:web`.
  **A rebuild waits for your text selection (`selectionInside`/`pendingRender`, 2026-08-19)** —
  `renderMessages` writes `innerHTML`, which destroys every node in the list and takes the operator's
  SELECTION with it. The relative stamps ("3m ago") change on their own, so a poll eventually produces
  different HTML through no action of yours: selections vanished every 15–30s while reading. A rebuild
  now POSTPONES while a non-collapsed selection sits inside `#msgs`, and runs the moment it clears
  (`selectionchange`); a SEND bypasses it, because your own message is your action, not a poll.
  **Two mistakes worth keeping, both mine, both caught only by using it:** (1) I first paired this with
  a "skip if the HTML is identical" MEMO, which broke the list outright — the empty-state branch writes
  `#msgs` without touching the memo, so the two desync and every later render is skipped against a DOM
  that no longer matches (a cache of what the DOM holds must be invalidated by EVERY writer, and this
  function is not the only one). (2) The `selectionchange` listener must clear `pendingRender` BEFORE
  calling `render()`: render rebuilds the sidebar, which perturbs the selection and re-fires the event —
  with the flag still set that is an infinite loop, and it froze the tab. Verified live: a selection
  held 20s across ~10 poll ticks with **0** rebuilds, then 7 rebuilds the instant it was released.
  NOTE the underlying cost this only mitigates — the list is **300 rows / ~420KB of HTML rebuilt
  wholesale**; the real fix is incremental rendering or a smaller Activity window.
  **Quote reply, clickable names, and timestamp-jump (`web/app/quote.js`, 2026-08-19)** — three ways to
  act on a message you are looking at, all missing until now. **Quote reply:** select text in a message
  → a button follows the SELECTION (fixed-position, where you finished dragging) → the text lands in
  the composer markdown-quoted, ABOVE any draft you had, with a blank line under it and the caret
  below. **Every line is quoted INCLUDING blanks** — a bare blank line ENDS a markdown quote block, so
  a half-quoted paragraph renders as quote-then-body and silently attributes the rest to YOU; that is
  the one way this can misrepresent who said what. Leading indentation survives (in a code block it IS
  the meaning). **`mouseup`, not `selectionchange`** (the latter fires per character and the button
  would chase the cursor mid-drag), deferred a tick (at mouseup the selection isn't yet what the
  browser will report), and the handler IGNORES events from the button itself — otherwise its own
  mouseup re-creates the button after the click hid it. `hideQuote` removes EVERY `.quotebtn` in the
  DOM rather than the one the closure holds: the tracked reference can be reassigned between create and
  hide, and the orphan floats over the page acting on a selection you can no longer see. **Names and
  the `→` chip open that conversation** (only when the name is a known agent — an unresolved id has no
  conversation to open). **The timestamp jumps to that message**: it was already the row's most precise
  handle and did nothing. A pending jump **OWNS the scroll for that render** — the follow-to-bottom
  logic runs later in `renderMessages` and would otherwise throw you back to the newest message with
  the row still flashing three screens away, which reads as a half-working click. The flash is held in
  STATE (`flashTs`), not as a class on the node, because the 2s poll rebuilds every row. In Activity,
  quoting also OPENS the quoted message's conversation — there is no composer to quote into there.
  **The jump TOP-aligns, it does not centre (`jumpScrollTop`)** — centring was wrong in a way that looks
  like a different bug entirely: an agent message is routinely TALLER than the viewport (measured live:
  2357px in a 553px list), so centring starts it above the top of the list and the operator reports
  "ignores header size" — the header overlaps nothing, the message simply began off-screen. When you
  jump to a message you want its BEGINNING, so it top-aligns and gives back whatever headroom is spare:
  a short message shows some of the conversation above it for context, a tall one gets a 12px margin
  and starts at its first line. Both clamps matter — uncapped, a short message would land halfway down
  the screen. Test: `check:web` (21 assertions incl. the taller-than-viewport case); all verified in a
  real browser.
  **The PRs section (`web/app/prs.js`, `/api/prs`, `prInfoMany`, 2026-08-19)** — what the RUNNING agents
  currently have open on GitHub, in one place. Different question from the roster ("who is here"): a
  fleet that mostly writes code is really working on a handful of PRs, and the only way to see one was
  to focus an agent and read its header. **LIVE agents only** — that's what "active agents' cwds" means,
  and a stopped agent's branch isn't work in progress; including 40 of them turns a decoration into a
  rate limit. **Cost is the whole design constraint:** each entry is a `gh pr view` network call, so it
  rides git.ts's 60s cache (which caches MISSES too — the common case is a branch with no PR),
  `prInfoMany` runs them ≤5 at a time, and `shouldRefetch` refuses to run on the 2s message poll or
  while the section is folded shut. `prInfo` gained `headRefName`→`branch` (the PR's OWN branch, not
  the folder's current one — a worktree can be checked out elsewhere), `additions`/`deletions`, and
  `rollupChecks`: **any failure dominates, then pending, and an UNRECOGNISED conclusion is pending —
  never claimed as pass.** No checks configured is `undefined` and renders NOTHING, distinct from a
  spinner that never resolves; an unknown diff size renders nothing rather than a false `+0 −0` (zero
  itself is a real answer and shows). Two lines because a PR carries two kinds of fact — what it is
  (status · #number · title · checks) and where it came from (agent · branch · ±) — and one line makes
  the branch truncate and take the title with it; the whole row is one link to GitHub. Sorted by number
  DESC (the number IS the chronology). Verified live against the real daemon and real `gh` data.
  Test: `check:web` (21 assertions).
  **Every worktree, not just the agent's folder (2026-08-27):** `expandAgentWorktrees` (web.ts, pure
  over injected git fns, tested) turns each live agent's folder into ALL worktrees of its repo
  (`gitToplevel` + `listWorktrees` from src/worktree.ts — superconductor's and claude's worktree dirs
  are plain `git worktree`s and show up); a non-repo folder contributes nothing; a worktree reached
  through two agents is one target. The first sweep found 25 PRs of which 12 were merged/closed on
  dead worktrees, hence `keepSidebarPr`: sibling-worktree PRs only while OPEN (drafts included), the
  agent's OWN folder in any state. 13 open across evals + canary-env-52 after the filter.
  **Channel unread (`Channels.stamps`/`activity`, `/api/channel-unread`, `paw.chseen.<space>`, 2026-09-03)** —
  channel rows light up (bold + count) like agent rows. The DM cursor is ONE number for the inbox with
  no channel equivalent, so a channel keeps its own client-side "last seen" stamp per space
  (`loadSeen`/`saveSeen`/`markSeen`, forward-only, corrupt ⇒ nothing seen ⇒ everything unread — too
  much mail, never hidden mail). The SERVER counts: the tracker records every message stamp per channel
  (the one-time backlog scan + the tap, deduped, capped at FETCH_CAP) and `POST /api/channel-unread
  {seen}` answers `{channel: {latest, unread}}` = stamps strictly after `seen[channel]` (never looked
  ⇒ everything counts). A channel is marked seen only when it is the FOCUSED view AND the tab is
  visible+focused — the same `lookedAt` rule DMs use — up to the newest message on screen; the client
  polls the count on every status tick and on a channel `message` socket frame, skipping a tick while
  one is in flight; a daemon without the route leaves the last counts standing rather than flashing to
  zero. Test: `check:web` (both sides).
  **Search (`src/search.ts`, `/api/search`, 2026-09-03)** — the sidebar box FILTERS as you type (as
  before) and **Enter SEARCHES**: two tiers because they cost differently. `scope=messages` = the DM
  conversation the daemon already holds (`searchEntries`, an outgoing hit opens the agent it went TO)
  plus every channel's backlog (`channelMessages`); `scope=transcripts` = the agents' claude jsonl:
  `rg -i -F` finds candidate LINES (one record each), only those are parsed, and a hit is kept only when
  the record's human-readable TEXT (`recordText` — user/assistant text blocks, never tool JSON) contains
  the query; one 12s budget across agents (`agents=` narrows it — the client passes the filter box's
  matches), per-file cap 20, `truncated` reported rather than silently cut. Results are a view in the
  message pane (`SEARCH = "~search"` sentinel, `?at=search&q=`; composer hidden); a DM/channel hit
  opens the conversation and `jumpTo`s the message, a transcript hit opens that agent's trace (no
  in-trace jump yet). Measured live: 122MB + 369MB transcripts searched in 0.3s. Test: `check:web`.
  **Channel header** says `N seen here` (or `everyone subscribes` for #general) instead of the roster
  count that read as "71 agents" on a brand-new channel; an unfolded channel also carries a
  `+ add agent…` row that runs the same `/invite` request (paw can only ASK; joining is the agent's act).
  **The Village tab (`web/app/village.js` + `Village` in web.ts + `/api/village`, 2026-09-09)** — a map of
  the fleet. Iterated with the operator through 5 tracepaper mocks (A grid / B city-blocks / C transit-
  lines-by-owner / D nested-folder-areas / E folder-tree-metro); **E is the shipped design**: the FOLDER
  TREE is the map. A grey orthogonal backbone IS the filesystem — `~` → `Github`/`.superconductor`/`.paw`,
  `Github` → `team2027`/`caffeinum`, each folder → its repos, each repo → the agents living in it — so you
  trace any agent home by walking the line to the root (`buildTree` compresses lone agent-less chains like
  `.claude/worktrees` into one hop; `segmentsFor` maps a folder to its chain, a cotal_spawn peer with no
  folder lives under `· workers`; "you" is a leaf off the root). DM traffic is drawn as STEPPY orange
  rails on the RIGHT (operator: "steppy too") — orthogonal like the backbone, never diagonal, staggered
  lanes, weight = message count. Grouping by REPOSITORY/folder, NOT by owner-type (the C mistake the
  operator corrected: "should not group by type, it should group by repository"). **Edges are REAL**: the
  `Village` tracker rides the same whole-space `ep.tap` and counts DMs `from.name → to` once BOTH ends
  resolve to a name (never a raw id); live-accumulated (paw has no historical agent↔agent store), `last`-
  lines seeded from `Conversation` history for the hover card. Station colours = live/busy/off; a hollow
  ring + dot = interchange (talks across repos or to you, `crossRepo`). Station label is `name · branch`
  (`stationLabel`, from `row.git.branch` already on `/api/status`; worktrees get ⑂) so two checkouts
  of the same repo don't look identical. Shows the living map (live +
  currently-talking); a silent sleeper is hidden but `placement()` keeps its localStorage slot so it
  returns where it was (persistent locations — a new agent is APPENDED). A view like Tasks/Board:
  `VILLAGE = "~village"`, `?at=village`, one sidebar row, composer hidden. Verified headless (real folder
  tree, path compression, status, 0 JS errors). Tests: `check:web` (Village tracker server-side; buildTree/
  segmentsFor/crossRepo/placement client-side).

  **Channels are agent FOLDERS (`web/app/channels.js`, 2026-09-03)** — each channel row carries a ▸
  that unfolds the agents in it: click the channel = message the channel, click an agent beneath it =
  DM that agent (`focusAgent`); the chevron stops propagation so unfolding is never "open". WHERE
  MEMBERSHIP COMES FROM, stated honestly: on an OPEN mesh cotal has no membership registry paw can
  read — `ep.channelMembers()` and `ep.readMembership()` both answer EMPTY (probed live: the members KV
  is manager-written on authed meshes, the feed needs the delivery daemon). So the server's `Channels`
  tracker keeps `authors` = who has been SEEN posting per channel (the tap, plus a ONE-TIME backlog scan
  per channel on the roster tick — a failed scan is retried, never marked done, because "nobody here"
  would be a claim), exposed as `channelMembers` on `/api/status`; the client rule (`channelMembersFor`)
  lists those authors, marks non-roster authors (a human, an endpoint) as `nonagent` (shown, not
  clickable), and lists the WHOLE roster for #general since every paw persona subscribes to it. Open
  state is per space in localStorage (`paw.chopen.<space>`; corrupt ⇒ nothing open). Verified headless
  (playwright, computed style): unfold → names, click agent → `?at=<agent>`, click channel → `→ #ch`,
  survives reload. Test: `check:web`.
  **Foldable sidebar sections (`applyFolds`/`toggleFold`, 2026-08-19)** — Channels · Agents · Archived
  each fold from their header, and the fold is PERSISTED per space (a fold you must redo on every
  reload is a setting that fights you). The header became a control, so it looks like one: pointer,
  hover, `user-select:none`, and a chevron pointing the way the click will go. The row COUNT appears
  only while a section is FOLDED — open, the rows are right there and a number is noise; folded, it is
  the only thing saying what's hidden. `applyFolds` runs on every render (driven from state, never from
  the DOM's current classes) so a fold survives the 2s poll rebuilding the rows underneath it. Archived
  is its OWN foldable section rather than a toggle inside Agents, and its header is `hidden` when
  nothing is filed. A corrupt fold value reads as NOTHING folded — same direction as everywhere else,
  because a section silently shut looks like data that has gone missing. Verified in a real browser:
  fold, chevron, count-when-folded, survives a poll, persists, and unarchiving from inside the Archived
  section returns the agent to Agents.
  **Archiving agents out of the sidebar (`web/app/archive.js`, 2026-08-19)** — this space has 56+
  agents and most are finished work, so the list you navigate by had stopped being navigable. The
  operator's rule IS the design: **archived stays archived until that agent SAYS something** — an
  inbound message un-files it automatically, which is what separates this from a hide-list you must
  remember to prune. State is `name → archived-AT ms`, NOT a set: a set can only answer "is this
  hidden", while the wake rule needs "has anything arrived SINCE", and with a set the very message that
  un-archived an agent would re-archive it on the next poll. **Your own send never un-archives** (that
  is you talking to something you filed away; otherwise clearing a backlog un-files everything you just
  tidied). Two rows are never hidden: the **FOCUSED** agent (the view must exist in the list that
  navigates it — so archiving the OPEN conversation also leaves it, or the button reads as broken) and
  anything matching a **SEARCH** (a search that won't find what you typed is worse than an untidy
  list). Corrupt storage reads as EMPTY — a glitch must show too many agents, never hide one. Client-
  side per space like drafts/read-state: a view preference for THIS surface, never a fact about the
  mesh. The prune runs inside `renderAgents` (every 2s) and only WRITES when something actually woke.
  Verified in a real browser, both directions: archived-before-the-message came back into the list and
  out of storage, archived-after stayed put. **Un-archiving is not instant** — it fires on the first
  poll after the message reaches the client, a few seconds. Test: `check:web` (14 assertions).
  **Who an outgoing message went TO, in Activity (`recipientLabel`, 2026-08-19)** — Activity is every
  conversation at once, and an outgoing row said only "you", so the one fact a mixed feed cannot
  recover was which agent you said it to (inbound rows never had the problem — they carry `from`).
  Rendered as a chip in the header's existing tag slot (empty until now for outgoing; inbound shows
  `AGENT`), and **only in Activity** — in a focused conversation the answer IS the view, so the chip
  would be noise on every row. The recipient is an ID on the wire and paw resolves it to a name only if
  that id has ever appeared as a SENDER, so the label must render both: a roster name renders whole, an
  unresolved id is SHORTENED to its actor (`UB5BWUNB…`) and never dressed up as a name — a truncated id
  can still be matched against `paw status`, whereas a guessed name is a false claim about who you
  talked to. Grouping is keyed on (dir, recipient) too, so two consecutive sends to DIFFERENT agents
  don't merge into one block under a single avatar — which is precisely the confusion being fixed.
  Test: `check:web`; verified in a real browser against the live daemon (client files are read
  per-request, so a reload picks up client changes with no restart — unlike routes).
  **The browser owns its OWN unread cursor (`web.cursor` / `WEB_CURSOR`, 2026-08-19)** — every TERMINAL
  surface advances the shared `inbox.cursor` as a side effect of PRINTING a DM (that's what makes one
  unread state span `paw inbox` and `paw chat`), so a `paw chat` left running in another window walks
  it past the newest message within seconds and a browser reading it can only ever report **0 unread**.
  Reported live with the cause correctly guessed ("maybe cause i have paw chat running") and CONFIRMED
  before fixing: `paw chat .` live as pid 44377, shared cursor 40s old. The shared cursor answers "have
  I seen this ANYWHERE"; a GUI needs "what have I shown YOU", and only one of those may be moved by a
  process in another window. **Raycast reached this exact conclusion first** (`src/read-state.ts`) and
  its notes here warned about it — the web was wired to the shared cursor anyway. Two deliberate
  asymmetries: marking read in the browser advances **BOTH** cursors ("I have read these" is true
  everywhere; "the browser displayed these" is only true here), and `webCursor()` **SEEDS** from the
  shared one on first use, because a fresh file reads 0 and would light the ENTIRE history as unread —
  a wrong answer with a badge on it, not an honest "don't know yet". `cursor.ts` takes a `which` name
  (default `inbox`) so a display-only surface can keep its own. Verified live: a new DM lit `unread: 1`
  and STAYED lit while the shared cursor advanced past it.
  **Never size the composer from a HIDDEN measurement (`autogrow`, 2026-08-19)** — the real cause of
  "input field does not work". Activity hides the composer outright (`.main.nofocus .comp{display:none}`)
  and a hidden element measures `scrollHeight` 0, so writing that back PINS the textarea to
  `height: 0px`. `switchDraft` → `autogrow` runs from `focusTarget` BEFORE `render()` reveals the
  composer, which is exactly that case: switching from Activity to an agent left a ZERO-height box the
  operator could neither see nor click into, and nothing re-measures on its own so it stayed collapsed.
  The SECOND switch looked fine because the composer was already visible by then — hence the decisive
  clue, "only the first switch is broken". Fix is two-sided: `autogrow` returns early when
  `offsetParent === null` (a measurement taken while hidden is never persisted), and `focusTarget`
  re-runs it AFTER `render()` so a restored multi-line draft gets its true height. Verified in a real
  browser: first switch 22px + focused + typing visible, a 3-line draft 66px and still 66px when
  switched back to.
  **The caret follows the conversation you pick (`focusComposer`, 2026-08-19)** — choosing an agent
  revealed the composer but left focus on `BODY`, so you typed and nothing appeared and the box read as
  BROKEN when it was merely unfocused ("input field does not work", reported live). Worst coming FROM
  Activity, which has no composer at all (`.main.nofocus .comp{display:none}`), so the box is newly
  revealed and the operator has no reason to suspect it needs a click. Focused in `focusTarget` — a
  DELIBERATE switch — and never in `render()`, which runs on every 2s poll and would yank the caret out
  of whatever you were mid-way through typing. Skipped when the caret is in ANOTHER input: the sidebar
  search is a text field and Option-↑/↓ steps conversations while you are still in it, so grabbing focus
  there would break filtering to fix typing. Verified in a real browser on all three: click from
  Activity → caret in the composer, a half-typed line survives the poll, and a step from the search box
  keeps the caret in the search box.
  **`web/app/pending.js` — retiring an optimistic send (2026-08-06).** A send is put on screen
  immediately and held in `state.pending` (NOT `state.messages`, which the next read REPLACES wholesale —
  a row pushed there vanishes on reload, and silently disappearing is worse than a duplicate), then
  retired when the server echoes it back. The trap: **the two destinations echo in different SHAPES, in
  different ARRAYS.** A DM comes back into `state.messages` directed (`dir:"out"` + `to`); a channel post
  comes back into `state.channelMessages` as `{from:"you", channel, text, ts}` — no direction, no
  recipient. The single `dir === "out"` test therefore NEVER matched a channel post, and `loadChannel`
  didn't reconcile at all, so every channel post rendered TWICE: the real message plus a pending row
  stuck at `sending…` that no reload cleared (reported live). Identity is (destination, exact text) since
  `Entry` carries no wire id. Split into its own module + `.d.ts` so the predicate is asserted directly —
  including what must NOT retire a row: another agent's identical post, an inbound DM with the same text,
  and a FAILED send (the operator's only handle to retry it).
- `src/feed.ts` — **the shared read path** (added 2026-08-06): `messageText` (THE flattener — it had four
  independent copies in chat/inbox/watch/history, which this file's own notes warned about),
  `observerEndpoint` (connect as "you" but only to LOOK: registerPresence:false + consume:false, so no
  reader can ever bind the durable), `readConversation` (dmHistory → `Entry[]`, `withSent` widens to both
  directions), `FETCH_CAP`, and `pollLoop` (the non-overlapping tick — the re-entrancy guard is the point:
  a tick outlasting its interval would re-read the same pre-advance cursor and print twice). `paw inbox`
  (+`--watch`) is now a renderer over it; watch/history/chat take `messageText` from here.
  **It deliberately does NOT own `paw chat`'s connection:** chat joins as a PARTICIPANT (registerPresence
  + consume — it's a peer others must reach), everything here is an OBSERVER. Collapsing those into one
  factory would hide the distinction that matters most.
- `src/cursor.ts` — the human's single "have I seen this DM?" marker: one local file per space
  (`inbox.cursor`, a ms epoch), zero-dep like names.ts. `readCursor`/`advanceCursor` (FORWARD-only, so
  concurrent readers can't rewind each other). BOTH readers advance it — `paw inbox` when it shows new
  mail, `paw chat` when it displays a DM live — so one unread state spans both surfaces (read a DM in
  chat → inbox won't re-surface it). Separate from cotal's durable ack so inbox never binds that slot.
- **Locks are PID-STAMPED and break on a dead holder (`src/lock.ts`, 2026-08-20)** — the lock file used
  to be created EMPTY and staleness was purely `mtime > STALE_MS` (60s), while a waiter gave up at
  `MAX_WAIT_MS` (30s). Those two constants make a guaranteed-lose race: a lock abandoned by a KILLED
  holder can never be broken inside the wait window, so the waiter always times out first. Ctrl-C-ing a
  `paw chat` that was mid-spawn therefore poisoned the next command for 30s and then failed it —
  reported live as `paw attach research` → `timed out acquiring lock … spawn.research.lock`. Now each
  holder writes its pid and `holderAlive` probes it with signal 0 (the self-reap pattern from
  foreground.ts): **ESRCH ⇒ break immediately, EPERM ⇒ alive (held), unreadable/pidless ⇒ fall back to
  the age test** (an older paw's empty locks still work). Timeouts are injectable (`LockOpts`) so the
  WAITING paths are testable without waiting 30s. Test: `check:commands`.
- **`paw chat` says what it is waiting for** — resolving a target can take tens of seconds (a cold
  claude, or an agent already `starting`) and the terminal printed NOTHING for the whole time: no
  banner, no hint. "Why does it take so long to load" is two complaints, and the SILENCE is the half
  paw controls — a wait you can see is a wait, a blank screen is a hang (and a hang is what makes an
  operator Ctrl-C, which is what left the stuck lock above). Now prints `connecting to <name>…` before
  the wait, plus `cold start — this can take up to Ns` when it actually spawned one. Written straight
  to stdout because the readline that owns `emit` isn't up yet.
- `src/lock.ts` — dependency-free exclusive file locks (`withFileLock` sync / `withFileLockAsync`),
  shared by the connector (pre-trust), addressing (folder→name registry RMW + per-(space,name) spawn
  serialization). cross-process safe: O_EXCL create, retry, stale-break.
- `scripts/check-launch.ts` (`pnpm check:launch`) — connector smoke checks.
  `scripts/check-addressing.ts` (`pnpm check:addressing`) — name/registry/collision/model + the
  ambiguity guard (`assertUnambiguousTarget`: name-vs-folder collision throws, sigils exempt), no daemons.
  `scripts/check-adopt.ts` (`pnpm check:adopt`) — session discovery + cwd-verify + persona resume upsert.
  `scripts/check-concurrency.ts` (`pnpm check:concurrency`) — N processes race the folder→name registry
  (the lock keeps names distinct + all persisted).
  `scripts/check-dispatch.ts` (`pnpm check:dispatch`) — --space injection (operator --space/-= form
  respected; trailing body-word not mistaken), `stripCotalNamespace`, `expandEqFlags`
  (--space=/--server= expansion, positionals untouched), + all 7 native commands self-register.
  `scripts/check-commands.ts` (`pnpm check:commands`) — the native commands' registration
  (summary/usage present) + pure helpers (formatPs, resolveStopName, stripChannel, formatWhen,
  idNames, renderTap, formatWho) under a temp PAW_HOME; hermetic, no daemons.
  `scripts/check-worktree.ts` (`pnpm check:worktree`) — builds a temp repo+worktree; parse/list/resolve
  `<repo>@<branch>`, fail-loud on missing branch/worktree.
  `scripts/check-images.ts` (`pnpm check:images`) — the attachment helpers: the tokenizer against all
  three drag/quote conventions with REAL files whose names contain spaces, absolute-only resolution
  (+ `file://`/`~`), `hasProse` (the path-only-line regression), ephemeral BOUNDARY matching, staging
  copy-vs-in-place (and that a staged copy survives the original being reaped), and `composeMessage`.
  Hermetic; its non-ephemeral fixture lives beside the repo, NOT under tmpdir() (which is itself
  ephemeral — that would test the wrong staging branch).
  `scripts/check-github.ts` (`pnpm check:github`) — parse `github:owner/repo[#branch]` + fail-loud on
  malformed/unsafe; pure `ghCloneArgs`; `ensureBranch` against a pre-created local repo (hermetic, no clone).
  `scripts/check-rm.ts` (`pnpm check:rm`) — `removeFolder` (registry RMW + idempotent) and `resolveRemoval`
  by name / folder / orphaned-persona, fail-loud on an unknown target (hermetic, no daemons).
  `scripts/check-foreground.ts` (`pnpm check:foreground`) — the foreground registry (register/read/list +
  stale-pid self-reap), the `ensureAgentSpawned` reuse-guard ({spawned:false} for a live foreground name),
  and `paw claude`'s pure helpers (`peelArgs`, `deriveSessionIntent`, `stripSessionFlags`); hermetic, no daemons.
  `scripts/check-release.ts` (`pnpm check:release`) — the release discipline against a tiny FAKE checkout
  under a temp PAW_HOME: id determinism + lockfile sensitivity, snapshot completeness, node_modules is a
  clone (inode differs) and never a symlink, immutability under a checkout edit AND a node_modules
  rewrite, daemon argv resolving through the release and NOT moving when the checkout does, the pgrep
  ownership patterns against release-dir argv, cross-process flip atomicity (a real child hammering
  readlink while the parent flips), prune keeping the current release, and the arg parse. Hermetic.
  `scripts/check-loop.ts` (`pnpm check:loop`) — boots an isolated mesh and proves the human↔agent
  reply loop closes (persistent peer addressable + reply lands); self-tears-down. **It does NOT start a
  manager** (`ensure({needMesh:true})`, no `needManager`) and makes NO control call — which is precisely
  why it stayed green through a completely dead control rail. That gap is `check:rail`'s job.
  `scripts/check-rail.ts` (`pnpm check:rail`) — **the control-rail check**: `ensure({needMesh,
  needManager})`, let the manager settle, then call `ps` from THREE SEPARATE PROCESSES (own connection,
  own `resolveService`, nothing warm inherited) — the shape of every real paw invocation and the one
  that was never tested. Also asserts a refusal comes back as a refusal PROMPTLY (`inspect`/`despawn` of
  an unknown name), since the dead rail's symptom was silence, not error. `PAW_RAIL_SPAWN=1` adds a REAL
  claude spawn + despawn (off by default: an API session and ~a minute, but it is the only stage that
  exercises a manager holding state). **Isolation is ENFORCED, not documented** — it refuses to run
  without a non-default `PAW_HOME` and a `PAW_SPACE` that isn't `paw`, because it starts a real manager;
  and it `removeMesh(space)`es on teardown (the check:loop landmine).

## The manager control rail — `src/control.ts` (cotal 0.25)

**paw has exactly one door to the manager, and it is not `requestControl` any more.** cotal's 1d slice
DELETED the manager's bespoke `ctl.<tier>.<owner>.<actor>` subjects; control moved to the manager's v0.4
**service endpoint** on the `ep.*` rails. `src/control.ts` (`ManagerControl` / `withManagerControl`) is
the only place that speaks it, and `src/names.ts` deliberately holds no control constants any more.

**How the breakage hid, which is the part worth remembering.** `ep.requestControl(…)` still EXISTS on
the endpoint, so the 0.25 bump type-checked, passed all 20 hermetic suites and `check:loop`, and was
still wrong: it addressed a subject nobody serves. Worse, it did not fail — cotal's `requestControl`
uses `noMux` with a named reply subject, so it sat until its own 4s timeout while a RAW request to the
same subject drew `no responders` in ~1ms. "Nobody is home" and "still thinking" looked identical, which
is what turned a one-line diagnosis into an evening. Evidence, not reading: `grep -rn serveControl
node_modules/@cotal-ai/manager/dist` → **zero matches** in 0.25 (0.15 has it), and core's own
`controlCallerPermissions` says "the manager `ctl` rail is gone". The `manager-service-contract.js`
header still claims the two rails are "dual-served … until 1d deletes those" — **that prose is stale;
believe the code.**

**A control call is no longer one request.** It is: connect → `describe` the endpoint → fetch its §13.7
contract documents from the store → recompile the input/output validators (all of that is
`resolveService`) → `invokeCommand`. That costs a round trip plus a store read, so `ManagerControl`
RESOLVES ONCE and invokes many times — paw polls `ps` every 500ms while waiting for an agent, and
re-resolving per call would turn one readiness wait into dozens of describes. It is a thin port of
cotal's own `askManager` (`@cotal-ai/cli` `lib/control.js`), read rather than guessed at; paw carries
none of its operator I/O, `--on` instance pinning or user-bearer mode (one local manager per space, no
user auth).

**Op → command renames (v0.3 → v0.4):** `start`→**`spawn`**, the named `stop`→**`despawn`**, per-agent
`status`→**`inspect`**; `ps` unchanged. `despawn`/`attach` are **TARGETED**: they address an agent by its
principal TRIPLE `(owner, actor, lifecycleUid)`, never by alias, so each one first resolves the name via
`inspect` **on the same rail** (cotal mints `inspect`'s read row onto the same capability arm, so
resolving on another tier's connection would be a grant paw isn't holding). Mode is `any` (cross-agent
operator reach), matching cotal's own non-bearer `stop`.

**The PAW_AUTH tier caveat is finally closed.** `controlCreds` minted the PRIVILEGED tier and
stopAgent/restartAgent then rode it onto an ADMIN subject — under-privileged, and only ever working
because the open mesh enforces nothing. The tier is now chosen by the COMMAND (`ps`/`spawn`/`inspect` →
`control-caller-privileged`; `despawn`/`attach` → `control-caller-admin`), lazily, one rail per tier.
On an open mesh both tiers share ONE bare connection under a synthesized `DEV_OWNER` triple, because
there is no credential system to isolate. `controlCreds` survives for exactly one caller now: `paw
status`'s own JetStream inbox-lag read. **NOT verified live:** every authed path — no PAW_AUTH mesh was
stood up.

**SPAWN IS AN ACCEPTANCE, NOT AN OUTCOME (the sharpest edge).** Since cotal's P2 item 2 the `spawn`
reply returns as soon as the identity is ALLOCATED; the old `start` blocked until the agent was ready.
cotal offers `submitAndFollowGoal` to restore blocking and **paw deliberately does not use it** — the
reason is specific, not stylistic: paw's readiness wait is not passive. It polls `ps` and, on the tmux
runtime, presses Enter at claude's one-time dev-channels prompt on EVERY poll (`nudgeStartupPrompt`),
which is the only thing that unsticks a cold claude that reached the prompt after cotal's own 1s…5s
nudge window. Blocking inside the spawn call would suspend paw for exactly the window its only recovery
action needs. So `ensureAgentSpawned` takes the acceptance and then `waitForMeshLive`s for
`SPAWN_READY_MS` (60s — what the old blocking call was given), throwing loud if the agent never lands.
Consequence to keep in mind: a boot failure now surfaces as paw's readiness timeout, not as the
manager's own `ok:false`, so the message says "accepted but never reached the mesh" and points at
`paw status` / `paw log`.
**The reply's SHAPE changed too:** it is `{name, owner, actor, uid, goalId, …}`, so the agent's wire
principal is now STATED (`principalKey(owner, actor)`) rather than re-derived from a raw nkey by
`wirePrincipal` — which is strictly better, since paw no longer has to guess an owner. A reply missing
either token yields NO id (the caller falls back to waiting for presence), never a half-formed
principal.

**The readiness gate needed two changes, and the second is the subtle one.** `MANAGER_READY_MS` went
8s → **20s** (a resolve is a describe + store fetch + recompile, and none of it can succeed until the
manager finishes REGISTERING its service a few seconds after the process starts). But the fix that
actually mattered is `READY_PROBE_MS` (1.5s): `managerAnswers` runs in a RETRY LOOP, and with the
default 10s resolve deadline a single early attempt outlived the entire readiness window — one probe,
no retries, and a perfectly healthy manager reported as "didn't answer". Measured on an idle machine:
resolve ~450ms, `ps` ~310ms once registered.

**`sharedManagerControl(space, server)` — one handle per long-running process (2026-08-24).**
`withManagerControl` is right for a one-shot CLI (open → ask → close → exit). `paw web` called it
per POLL, so every 2s tick re-ran the whole resolve — describe + contract-store fetch + an Ajv
recompile of every validator — and cotal printed its `! schema: compile took ~110ms of process CPU`
advisory for each one (the "random errors" log of 2026-08-23; the advisory is cotal's own reference
budget observation, NOT a refusal — their comment says the number "was very nearly all instrument").
The shared handle resolves once; `collectStatus(space, ctl?)` takes it optionally (web passes it,
the `paw status` CLI keeps opening its own — a cached open socket would keep a one-shot process alive
past its last line). **Staleness:** the resolved service is per manager INSTANCE, so a manager restart
would leave the cached handle addressing a ghost; `ManagerControl.stale` flips on any transport-level
failure inside `invoke`/`invokeTargeted` (never on a refusal), and `sharedManagerControl` closes and
replaces a stale handle on the next call — one failed poll, not a wedged daemon. Verified live: web
under launchd, 0 advisories in 25s of polling (was ~12). NOT verified live: the stale→replace path
across a real manager bounce (would churn the live fleet).

**Staleness has TWO shapes, and the second one wedged the daemon for a day (2026-09-08).** cotal pins a
resolved service to the manager's registration EPOCH; a re-registration (same instance, epoch 45→46 — a
broker reconnect, the presence-KV rebuild after the outage) makes every later command come back as an
`ok:false` REFUSAL: "the caller bound to epoch 45 … this incarnation is not the one it resolved against".
Transport-only staleness never flipped, so `paw web` sat on the dead handle through ~10k refused polls
with rows frozen at 10:02 AM. Now `isStaleRefusal` (matched on cotal's own SPEC 13.2 wording, never on a
generic error — an unknown-agent refusal must not drop a good handle) flips `stale` from inside
`invoke`/`invokeTargeted`, and `paw web`'s `refreshStatus` additionally `dropSharedManagerControl`s on
ANY failure (one re-resolve is a few hundred ms; a wedged daemon is the alternative). Same day, same
cause, other symptom: after a fleet restart every agent has a NEW id, the web's presence watch was dead,
and an outgoing DM accepted before that id had been seen sending kept the raw id — the client's
optimistic row matches on the NAME, so it read `waiting 1m` while the message had long been delivered.
`Conversation` now re-resolves unnamed recipients on every read (`unnamed` map, live AND reconciled
history). Tests: `check:commands` (predicate), `check:web` (late naming).

**`paw open`'s pty attach is GONE upstream**, not merely unported — see the `src/open.ts` entry.

**Verified live** on an isolated space (`check:rail`): a manager started by one process answered `ps`
from three separate fresh processes in 340/311/309ms; unknown-name `inspect`/`despawn` refused in
216ms/1ms; and with `PAW_RAIL_SPAWN=1` a real claude spawned in 4.4s (`id=local.UBDG…`), appeared in a
separate process's `ps`, and despawned.

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

## Waking a sleeping agent (the in-mesh gap, and the tty prompt)

**Agent→agent DMs cannot wake anyone.** `cotal_dm` resolves a NAME through the roster, and a stopped
agent isn't on it, so the send fails at resolution: `Couldn't DM: no peer "queue" in space "paw"`.
**Nothing is queued** and the payload is lost — the sender re-composes it later. Verified first-hand by
`research`, three times (2026-08-17); it cost 5 minutes for `noninteractive`, ~100 for `queue`, and
`canary-env-52` never came up. Agents knew exactly what was wrong and could only escalate to a human.

**The convention (in the connector brief since 7d4a26b):** `cotal_dm("global", "wake <name>")`.
`global` is always on (hence always addressable) and paw's CLI is what actually spawns agents, so this
keeps host-launch authority in ONE place instead of granting `spawn` to all 54 personas — cotal's own
docs call that grant host-launch authority, not "add a teammate". **The verb is NARROW because global
said so on review:** the first draft was `run: paw start <name>`, and it objected that `run: <string>`
normalises routing arbitrary commands through the one process with full host access ("today `paw
start`, tomorrow `run: rm -rf`"). `wake <name>` = one intent, one mapping. The brief tells global —
which reads the same brief — to validate the name against `paw status` and refuse anything else.

**The tty-prompt trap (`nudgeTmuxConfirm`, src/native-attach.ts).** claude's
`--dangerously-load-development-channels` prints a one-time confirmation. cotal's tmux runtime clears
it (`scheduleConfirm`, gated on the claude connector's `spec.confirm`, which paw preserves via
`{...spec, args}`) — **but only at 1s…5s after the window opens.** A cold claude on a loaded machine
reaches the prompt well after that, so every Enter lands BEFORE the question exists and the agent then
waits at it indefinitely with no mesh presence. `cotal-endpoint-telegram` hung ~90s until a human
pressed Enter, and this is the likeliest explanation for an agent stuck at `starting…`. paw therefore
nudges Enter again on every poll of `waitForMeshLive` during `STARTING_GRACE_MS` — the window where the
prompt actually appears. tmux only (pty clears its own; cmux windows aren't paw's to type into),
best-effort, never throws: a missing window is not a spawn failure.

## Channel replay (why a restarted agent gets flooded)

**Symptom (2026-08-13):** restart an agent and it takes ~25 wake nudges in a row, replaying channel
traffic from days ago — "New channel from you — delivering your Cotal inbox now", over and over. They
are CHANNEL messages, not DMs.

**Cause, from cotal's own resolution:** replay-on-join is `per-channel ?? space default ?? **true**`
(`effectiveReplay`), and an unset `replayWindow` means **the full retained window**, not a recent
slice. The backfill runs on **first connect of a process** — and a restart IS a first connect for the
new process (a reconnect reopens the subs WITHOUT re-backfilling; only a fresh process re-reads). So
every restart replays a channel's entire retained history, and each replayed message fires its own
wake nudge.

**The lever** (`paw cotal channels …`, verified live):
```
paw cotal channels list                          # space default + per-channel entries
paw cotal channels default --replay --window 1h  # bound it space-wide
paw cotal channels set general --window 24h      # or per channel
paw cotal channels default --no-replay           # or no backfill at all
```
**`--window` is a DURATION, never a count** — `parseDuration` accepts only `<n><s|m|h|d>` and THROWS
otherwise, so "the last 10 messages" is not expressible. Set to `1h` for this space.

**The cost of a short window, and why it's a real trade:** this space's channel `deliveryClass` is
`live`, and in open mode there is no durable backstop for channels (Plane-3 needs the delivery daemon,
which paw doesn't run — see the delivery-daemon note). So the replay IS the only catch-up path: an
agent down longer than the window doesn't get that traffic late, it never gets it.

**Reading the config back is not trivial:** `channelDefaults` is populated by a KV watch gated on
`doWatch && doWatchChannels`, so an `observerEndpoint` with `watchPresence:false` NEVER opens the
channel registry and reports every window as unbounded — which looks exactly like "the setting didn't
take". Probe with `watchPresence:true` (a real agent opens it via `consume:true` instead).

## Env knobs
- `PAW_SPACE` — override the machine-wide default space (`paw`). Folder → agent NAME, not space.
- `PAW_AUTH=1` — JWT-authed mesh instead of the default open localhost mesh (open needs no creds).
- `PAW_PERMISSION` — override the default `bypassPermissions` (one of default/acceptEdits/bypassPermissions/plan).
- `PAW_MODEL` — default model for spawned agents (cotal's per-agent `--model`); a `--model` flag on
  `paw chat`/`paw open` overrides it. Blank = unset (no fabricated default).
- `PAW_RUNTIME` — one-shot override of the manager runtime: `pty` (default; headless warm agents),
  `tmux`, or `cmux` (each agent in its own tab/pane). `bin/cotald.ts` imports `@cotal-ai/{tmux,cmux}`
  so the runtimes register. **Precedence: `PAW_RUNTIME` env > the space's sticky preference file
  (`~/.paw/spaces/<space>/runtime`) > `pty`.** The discoverable surface is the **`paw runtime`** /
  **`paw restart`** commands (below) — the env var is the transient override; the preference file is
  the durable per-space choice. Because the manager is a background daemon `ensure()` ADOPTS, changing
  the setting alone can't switch a running one — `ensureManagerUp` records the runtime it started
  (`manager.runtime` marker) and, when the resolved runtime differs from the running manager paw OWNS,
  **restarts it** into the new runtime (durable agents re-wake on the next chat/open) with a rollback
  net (see the lifecycle bullet). A switch/restart also **`reapRuntimeUi`s the OLD runtime's leftover
  windows/tabs** right after stopping the old manager, so the revived agents don't stack DUPLICATE
  windows/tabs next to orphans the manager's own SIGTERM teardown missed (tmux → `kill-session
  cotal-<space>`; cmux → close the KNOWN agents' `cotal-<name>` tabs; see the lifecycle bullet).
  A marker-less owned manager counts as `pty` (so the first switch
  triggers); a manager paw doesn't own is never killed (warns instead). `cmux`/`tmux` must be installed
  + reachable or the switch rolls back to the previous runtime and fails loud with the log tail.
  Invalid env value → fail loud; a garbage preference FILE is ignored (falls to pty).
  **cmux works from ANY shell (`assertRuntimeUsable` = `cmux ping`):** the cmux app is a SINGLETON
  reachable over a stable DEFAULT unix socket — `cmux ping` finds it from any process, no cmux surface
  needed. The earlier "cmux only works from inside a cmux terminal" belief was a bug: paw's detached
  manager INHERITED the launching cmux shell's per-surface `CMUX_SOCKET_PATH`, and the cmux CLI PREFERS
  that over the default socket — so when that surface/window closed, every LATER agent spawn targeted a
  DEAD socket ("cmux couldn't reach the app"), i.e. spawns "only worked from the same tab". Fixed on two
  fronts: (1) `startManagerDaemon` STRIPS `CMUX_SOCKET_PATH` from the cmux manager's env (and pins
  `CMUX_BUNDLED_CLI_PATH`=`cmuxBin()` so a detached, outside-a-surface manager can still find the CLI), so
  the manager always reaches the app via the stable default socket — a spawn no longer depends on which
  tab launched paw; (2) `assertRuntimeUsable(cmux)` now probes `cmux ping` (with `CMUX_SOCKET_PATH` unset,
  matching the manager) instead of requiring `CMUX_SOCKET_PATH` — so `paw runtime cmux`/`restart`/a fresh
  cmux start work from a plain terminal as long as the app is running, and fail loud only when it isn't.
  `cmuxBin()` falls back to the macOS bundled CLI (`/Applications/cmux.app/…/bin/cmux`) when
  `CMUX_BUNDLED_CLI_PATH` is unset. Gated only on the START/SWITCH paths (ensureManagerUp fresh-start +
  mismatch-restart, restartManager, the `paw runtime`/`restart` entry points); ADOPTING a running manager
  takes no probe (a control request over the mesh). Raw `paw cotal supervise --runtime cmux` stays
  available. tmux/pty are always usable. **DM caveat is NOT runtime-specific:** a warm agent receives DMs live under any
  runtime IF its mesh consumer is healthy; a claude whose link went stale through restart churn shows
  "idle" from cached presence but stops consuming — re-spawn it (`paw stop` + `paw chat`), don't blame
  the runtime.
  **⚠ cmux SETUP REQUIREMENT — `automation.socketControlMode` must NOT be `cmuxOnly` (2026-07-08, hard-won):**
  the DEEPEST cmux blocker isn't env at all — it's a cmux-SIDE gate. cmux's `automation.socketControlMode`
  defaults to **`cmuxOnly`**, which authorizes socket control by the client's cmux PROCESS LINEAGE (peer
  creds / ancestry — NOT env, NOT a password). paw's manager is a DETACHED daemon (`setsid`, reparented to
  init) with NO cmux-surface ancestry, so under `cmuxOnly` EVERY spawn/close is rejected mid-write
  ("cmux couldn't reach the app" / "Failed to write to socket (Broken pipe, errno 32)") — even though the
  app pings fine and the env is perfect. It "works then breaks" because it only works while the manager
  still has cmux ancestry (freshly forked from a surface-launched paw), and dies the instant it detaches.
  **No paw-side env/socket fix beats a lineage gate.** FIX (operator's `~/.config/cmux/cmux.json`), verified
  live on **cmux 0.64.17**: set `automation.socketControlMode` to **`"fullOpenAccess"`** ("Full open access"
  in Settings → Automation) and **RESTART the cmux app** (see caveats). Enum:
  `off · cmuxOnly · automation · password · allowAll · openAccess · fullOpenAccess · full`.
  **The other modes are BROKEN on 0.64.17** (all filed as cmux bugs, `~/cmux-socket-repro.py`): `password`
  and `automation` need a server password, but a password Saved via the Settings GUI is NEVER registered
  server-side ("Password mode is enabled but no socket password is configured in Settings" — rejects every
  client, lineage included); `allowAll` still demands auth. So `fullOpenAccess` (no auth at all — any local
  process may drive the socket, a security trade-off) is the ONLY working headless-automation mode.
  **Apply caveats (all cmux bugs):** (1) `cmux reload-config` does NOT re-read `socketControlMode` — it's a
  LAUNCH-time setting, so a full **app restart** is required to apply a file change (the GUI applies live but
  see #2). (2) A file-managed `socketControlMode` (present in `cmux.json`) **locks/greys the Settings
  dropdown**, and the app WRITES the key into `cmux.json` itself when you Save a password — so once it's in
  the file, the GUI can't change it and removing it from the file + restart may not fully un-stick the app's
  internal state. Net: drive it purely from `cmux.json` + app restart, don't fight the GUI.
  `access_mode` in `cmux capabilities` reflects the CALLER's auth path (a cmux-descended shell ALWAYS shows
  `cmuxOnly` / passes regardless of the server mode), NOT the server's configured mode — so it (and any test
  from a cmux terminal or from Claude Code running inside cmux) is USELESS to preflight this. The ONLY valid
  test is a process reparented to init (ppid=1, no cmux lineage) — `~/cmux-socket-repro.py`. Verified live:
  under `fullOpenAccess` a ppid=1 process (and paw's ORPHANED detached manager) spawns agents into
  `cotal-<name>` tabs with no auth; under `cmuxOnly`/`password`/`automation` it's rejected.
  `ensureAgentSpawned` appends a socketControlMode hint to a cmux-unreachable spawn error. The earlier
  `CMUX_*`/shim-PATH strips + the `CMUX_SOCKET_PASSWORD` injection are still correct (harmless under
  `fullOpenAccess`; needed if cmux ever ships a working `password` mode) — but the socketControlMode gate is
  the load-bearing one.
  - **`paw runtime`** (`src/commands/runtime.ts`) — no-arg: LOCAL, prints the preferred runtime + the
    last-started `manager.runtime` marker (flags drift). `paw runtime <pty|tmux|cmux>`: writes the
    preference then `ensure()`s (restarts on a switch). **`paw restart [<r>]`**: force-bounce the
    paw-owned manager (optionally set the preference first) — the bounce `ensure()` won't do on a
    same-runtime manager (e.g. after a connector edit). Neither is in NEEDS_MANAGER/NEEDS_MESH gating:
    they self-ensure AFTER writing the preference (pre-ensuring would boot the STALE runtime).
    **Self-restart (`paw restart` from INSIDE a managed agent, 2026-07-13):** an agent that runs `paw
    restart` can't finish it synchronously — the bounce's revive step SIGTERMs its own caller mid-command,
    leaving a half-restart / stacked managers (the 2026-07-13 disaster: `paw down; paw dm; …` one-liner
    killed the operator mid-bounce → competing 0.10+0.11 managers → `no responders`). So `paw restart`
    now DETECTS self-invocation via `agentSelfName(space)` (cotal stamps `COTAL_NAME`/`COTAL_SPACE` on a
    managed agent, inherited by its tool subprocesses; an operator shell has neither) and hands off to a
    **detached child** (`spawnDetachedRestart` — `spawn(detached:true)` reparented to launchd, node+tsx,
    **`COTAL_*` stripped** so the child isn't seen as an agent and can't re-detach, `PAW_WAKE_AGENT=<name>`
    set) that outlives the caller's death, completes the bounce+revive, then `finishDetachedRestart` wakes
    the agent with a `paw dm … "resume where you left off"` (a respawned claude session is idle until it
    gets a turn — proven live). Guarded by a `restart.pid` in-flight file (`restartInFlight` — no stacking,
    the direct fix for the multi-manager mess) + a `restart.log`; macOS has **no `setsid`**, hence the
    node-detached spawn (the same mechanism the mesh/manager/mailbox daemons use), NOT a shell trick. A
    plain **operator** shell (no `COTAL_NAME`) still gets today's SYNCHRONOUS bounce (inline output + exit
    code). `agentSelfName` is pure/unit-tested (`check:commands`); both paths verified live on an isolated
    mesh. This is what makes "an agent restarts itself onto new code and keeps working" one command.
- `PAW_ROOT` — opt-in cwd confinement root (absolute; unset = no confinement). `PAW_ALLOW_ANY_CWD=1`
  permits one out-of-root cwd (which is then neither bypassed nor pre-trusted).
- `PAW_HOME` — paw state root (default `~/.paw`). Releases live under `$PAW_HOME/releases`.
- `PAW_RELEASE` — which tree the DAEMONS run from (src/release.ts). Unset = the `current` release
  (fail-loud if none: `paw release`). `dev` = the live checkout, announced loudly on every resolution —
  the pre-incident behaviour, kept as the dev loop's escape hatch. `<id>` = pin one release (a rollback:
  `paw release --list` shows what's on disk). It never affects the CLI itself, only what it spawns.

## Dev
- ESM, run TS directly with tsx — no build step for dev: `pnpm paw <cmd>` (= `tsx bin/paw.ts`).
- **The CLI may run under bun; the DAEMONS must be node+tsx.** The CLI startup tax is real — tsx
  ~0.82s vs bun ~0.21s (~4×) on every `paw` invocation — so the launcher (`~/.local/bin/paw`) MAY
  exec bun for speed. What previously made bun fatal: cotal's `ensureManager`/`startMeshDetached`
  re-exec the *current* runtime (`selfArgv()`), so a bun CLI spawned the manager under bun, where
  `@lydell/node-pty`'s native ioctl fails (`ioctl(2) failed`) → pty stubs stuck `starting…`, no agents
  (2026-06-26: bricked all 5 agents). FIXED by `cotalViaTsx` (src/lifecycle.ts): paw now spawns the
  mesh/manager/beacon via the repo's tsx-bin directly, so they're node+tsx regardless of the CLI
  runtime. To switch the CLI to bun: change the launcher's last line to
  `exec bun "/Users/aleks/Github/paw/bin/paw.ts" "$@"`. Verify after: `paw ps`, then confirm the
  manager process is `node …/tsx/…` (NOT bun) and a `paw chat --fresh <folder>` boots a real claude (RSS > 100MB).
- `pnpm typecheck`, `pnpm check:launch`.
- **History vs github (2026-09-10):** github visibility is the whole repo, not per-branch. Full history lives on local `private-main` (**no upstream**, never pushed). `main` is an orphan snapshot of that tree and is what `origin` has; future commits on `main` are the public git log. `remote.origin.push` is `main:main` only. `scripts/githooks/pre-push` refuses `private-main`. `scripts/push-public-snapshot.sh` is leftover from a second remote and should not be used to rewrite origin. Visibility flip of `caffeinum/paw` is the operator's.
- pnpm 11 reads settings from `pnpm-workspace.yaml`, NOT the package.json `pnpm` field or `.npmrc`.
  Ours declines esbuild's build (`allowBuilds.esbuild: false` — same as the global ignore-scripts
  policy; esbuild runs from its prebuilt platform binary) and disables the pre-run deps check
  (`verifyDepsBeforeRun: false`) so scripts don't choke on the intentionally-skipped build.

## Conventions
- Build on cotal; contribute generic gaps upstream (per-agent cwd), keep paw-specific bits here.
- Fail loud; never fabricate fallback values.
- Full design: `~/paw-design.md`.
