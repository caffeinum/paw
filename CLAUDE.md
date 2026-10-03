# paw

Zero-config warm claude-code agents on the cotal mesh — one agent per folder, persistent,
addressable, talking to each other and to you. A thin layer over cotal with **no fork**.

This file is the INDEX. The full design notes, incident narratives and rationale live in
`docs/notes/*.md` (moved verbatim 2026-10-02 — this file was over Claude Code's 150k-char limit).
**Read the linked note before changing a subsystem.** New long notes go in `docs/notes/`, not here.

## Rules that prevent damage (read first)
- **Daemons run from an immutable RELEASE, never the checkout.** mesh/manager/mailbox/`paw web` resolve
  through `daemonRoot()` → `$PAW_HOME/releases/<content-hash>/`; `paw release` snapshots, `paw restart`
  cuts over. Never `pnpm add`/checkout/half-edit expecting live daemons to be unaffected — and never run
  installs as if they were. No release pinned → fail loud. → [lifecycle.md#release-discipline](docs/notes/lifecycle.md#release-discipline)
- **Test ONLY in an isolated space — on EVERY command:** `PAW_HOME=$(mktemp -d) PAW_SPACE=test-$$`
  (non-`paw`), plus `PAW_RELEASE=dev` when exercising the checkout. Never poke the live `paw` space while
  debugging. Tear down with `paw down` + `removeMesh(space)` (a leftover mesh-registry entry breaks
  later mesh starts). → [lifecycle.md#mesh-registry-hygiene](docs/notes/lifecycle.md#mesh-registry-hygiene)
- **An isolated space does NOT isolate `~/.claude`.** Never run `/model`, `/config` or any
  settings-writing command in a test agent — it changes the operator's global default.
- **Never restart/stop/interrupt a live agent without the operator's explicit go** — no automation may
  touch a live agent (the keeper's auto-unstick was removed for this). `paw sleep` is opt-in per agent.
- **Fail loud.** Never fabricate a fallback value (`?? ""`, `"unknown"`, a guessed name or a 0 count).
- **Subagents/worktrees:** never `git add -A`; never commit a `node_modules` symlink (mode `120000`).
- **CLI may run under bun; DAEMONS must be node+tsx** (node-pty ioctl; bun's `node:http` never emits
  `upgrade`; no `node:sqlite` under bun). → [lifecycle.md#dev](docs/notes/lifecycle.md#dev)
- **cmux runtime needs `automation.socketControlMode: "fullOpenAccess"`** in `~/.config/cmux/cmux.json`
  + a cmux app restart (the default `cmuxOnly` lineage gate rejects the detached manager).
  → [lifecycle.md#env-knobs](docs/notes/lifecycle.md#env-knobs)
- **`ensure()` never switches the manager runtime implicitly** — only `paw runtime <r>` / explicit
  `PAW_RUNTIME` (a switch despawns the whole fleet; 802ad0d).

## cotal 0.58 (2026-10-02)
Bumped 0.48.1 → **0.58.0** (all `@cotal-ai/*` pinned exact). `pawConnector` spreads `...claudeConnector`
so `eventChannel` (required since 0.5x) and future capabilities are inherited; `buildLaunch` needs a
`workspaceRoot` (`paw claude --fg` passes `pawCotalRoot(space)`); since 0.49 a manager SIGTERM spares
its agents, so `stopOwnedManager` despawns every agent first (`despawnManagedAgents`); `ensure()` only
warns on a runtime mismatch (802ad0d). `paw sleep` exists (src/sleep*.ts, mailbox-hosted stand-in).
Read the code for details. → [cotal-dependency.md#cotal-058](docs/notes/cotal-dependency.md#cotal-058),
[sleep.md](docs/notes/sleep.md)

## Layout
Each entry: what it is + the most load-bearing rule. Full notes behind the link.

### Composition roots & CLI → [cli.md](docs/notes/cli.md)
- `bin/paw.ts` — endpoint-native composition root: imports ONLY @cotal-ai/core + paw command modules;
  own dispatch, NEEDS_MESH/NEEDS_MANAGER pre-gating, `paw cotal <cmd>` → cotald subprocess; unknown
  command fails loud. → [cli.md#binpawts](docs/notes/cli.md#binpawts)
- `bin/paw.mjs` — package `bin` shim: node → repo tsx → bin/paw.ts (no dist/ build). → [cli.md#binpawmjs](docs/notes/cli.md#binpawmjs)
- `bin/cotald.ts` — cotal composition root (runCli + manager + paw connector aliased as the default
  agent type); **only ever a subprocess**; the only file allowed to import @cotal-ai/cli/manager. → [cli.md#bincotaldts](docs/notes/cli.md#bincotaldts)
- `src/commands/` — self-registering commands: stop, msg, ask, who, history (read-only), watch (tap
  handler shape-guarded), runtime/restart (restart revives the agents that were live). → [cli.md#srccommands](docs/notes/cli.md#srccommands)
- `src/commands/mcp.ts` — `paw mcp`: shared MCP servers live in cotal's config under key `claude` (NOT
  `paw`); per-agent selection is persona `shareTools:` (absent = all, `none` = none); never restarts. → [cli.md#paw-mcp](docs/notes/cli.md#paw-mcp)
- `src/commands/files.ts` — `paw files`: pure observer of `#files` (`ai.cotal.file` FileEntry, absolute
  paths, no bytes on the mesh). → [cli.md#paw-files](docs/notes/cli.md#paw-files)
- `src/commands/bind.ts` — `paw bind`: one-time Telegram bind code minted over the mesh, as a distinct
  ephemeral peer (never HUMAN_PEER — would contend for the inbox durable). → [cli.md#paw-bind](docs/notes/cli.md#paw-bind)
- `src/dispatch.ts` — `withDefaultSpace`, `stripCotalNamespace`, `expandEqFlags`. → [cli.md#srcdispatchts](docs/notes/cli.md#srcdispatchts)
- `src/names.ts` — `HUMAN_PEER`, zero deps. → [cli.md#srcnamests](docs/notes/cli.md#srcnamests)
- `src/global.ts` — `paw global`: always-on `global` agent at `~/.paw/global`, the wake authority;
  refuses to clobber a differently-named mapping. → [cli.md#paw-global](docs/notes/cli.md#paw-global)
- `src/keeper.ts` — the unstick sweep on the global keeper tick (history; see the no-auto-restart rule). → [cli.md#keeper-unstick-sweep](docs/notes/cli.md#keeper-unstick-sweep)
- `src/start.ts` — `paw start [<name>…]`: cold-start every REGISTERED agent (restart only revives live ones). → [cli.md#paw-start](docs/notes/cli.md#paw-start)
- `src/pacing.ts` — `awaitSpawnHeadroom`: load-gated revival (bounded 90s), anti-thundering-herd. → [cli.md#spawn-pacing](docs/notes/cli.md#spawn-pacing)
- `src/commands/launchd.ts` — `paw launchd`: fleet (one-shot, NO KeepAlive), web (KeepAlive), global
  keeper (60s StartInterval); explicit name list baked in. → [cli.md#paw-launchd](docs/notes/cli.md#paw-launchd)
- `src/stdout.ts` — `writeOut`/`writeJson`: loop on partial writes; bun truncated piped `--json`. → [cli.md#srcstdoutts](docs/notes/cli.md#srcstdoutts)

### Lifecycle, releases, managers → [lifecycle.md](docs/notes/lifecycle.md)
- `src/lifecycle.ts` — `ensure()` starts/adopts detached mesh + manager + mailbox under a per-space lock;
  manager/mailbox ownership by COMMAND SIGNATURE (space-exact pgrep), never recorded pid; runtime =
  `PAW_RUNTIME` > sticky preference > pty, RUNNING runtime read from the live cmdline; rollback net on a
  failed switch; `restartManager` bounces manager + beacon and reaps old tmux/cmux UI; tmux pinned to the
  default socket. → [lifecycle.md#srclifecyclets](docs/notes/lifecycle.md#srclifecyclets)
- `src/release.ts` + `src/commands/release.ts` — content-hashed immutable snapshots, atomic rename flip,
  `cp -Rc` node_modules (never symlink/hardlink), prune never deletes current, `PAW_RELEASE=dev|<id>`. → [lifecycle.md#release-discipline](docs/notes/lifecycle.md#release-discipline)
- `src/cotal-root.ts` — `pawCotalRoot(space)`: one root for a space from any cwd; every daemon spawns
  with that cwd (the team2027 foreign-auth incident). → [lifecycle.md#cotal-root](docs/notes/lifecycle.md#cotal-root)
- `nodeBin`/`viaTsx`/`withToolPath` — node resolved absolutely; tool dirs backfilled (appended) for
  stripped-PATH callers (Raycast, launchd). → [lifecycle.md#nodebin-and-viatsx](docs/notes/lifecycle.md#nodebin-and-viatsx)
- `explainManagerFailure` — classifies manager startup failures; a duplicate is detected only from the
  manager's own "already serves space" line, never a process count. → [lifecycle.md#explainmanagerfailure](docs/notes/lifecycle.md#explainmanagerfailure)
- `stripHarnessMarkers` — drop Claude Code session markers from daemon env (else every agent boots with
  transcripts OFF). → [lifecycle.md#stripharnessmarkers](docs/notes/lifecycle.md#stripharnessmarkers)
- `sanitizeNodeOptions`/`daemonEnv` — drop NODE_OPTIONS preloads that no longer exist on disk. → [lifecycle.md#sanitizenodeoptions-and-daemonenv](docs/notes/lifecycle.md#sanitizenodeoptions-and-daemonenv)
- `src/lock.ts` — O_EXCL file locks, pid-stamped, broken immediately on a dead holder. → [lifecycle.md#pid-stamped-locks](docs/notes/lifecycle.md#pid-stamped-locks), [lifecycle.md#srclockts](docs/notes/lifecycle.md#srclockts)

### Control rail → [control-rail.md](docs/notes/control-rail.md)
- `src/control.ts` — the ONE door to the manager: v0.4 service endpoint (`resolveService` once, invoke
  many); ops `ps`/`spawn`/`inspect`/`despawn`/`attach` (despawn/attach targeted by principal triple);
  **spawn is an acceptance, not an outcome** — paw then `waitForMeshLive`s; `sharedManagerControl` for
  long-running processes, dropped on transport failure or a stale-epoch refusal. `check:rail` covers it.

### Agents: connector, spawn, attach → [agents.md](docs/notes/agents.md)
- `src/connector.ts` — paw's only engine code: wraps the claude connector (spreads it), injects
  bypassPermissions, disallows AskUserQuestion/ExitPlanMode, the mesh brief, the durable `resume:` pin
  (`--session-id` first boot, `--resume` after), BEADS_DIR/BEADS_ACTOR env. Manager loads it at startup
  — connector edits need a release + restart. → [agents.md#srcconnectorts](docs/notes/agents.md#srcconnectorts)
- `src/cwd.ts` — PAW_ROOT confinement + claude folder pre-trust at the spawn site. → [agents.md#srccwdts](docs/notes/agents.md#srccwdts)
- `src/claude.ts` — `paw claude [args…]`: managed agent + attach by default (`--fg` = terminal-bound);
  passthrough args persisted as JSON `claudeArgs:` in the persona. → [agents.md#paw-claude](docs/notes/agents.md#paw-claude)
- `src/foreground.ts` — registry of `paw claude --fg` agents; self-reaps dead pids; prevents duplicate
  manager copies. → [agents.md#foreground-registry](docs/notes/agents.md#foreground-registry)
- persona `agent:` pin — which connector (claude/codex/opencode) respawns the agent. → [agents.md#agent-persona-pin](docs/notes/agents.md#agent-persona-pin)
- `src/session.ts` — `readResumeId`, `transcriptExists`; leaf module. → [agents.md#srcsessionts](docs/notes/agents.md#srcsessionts)
- **Two-writer guard** — never start an agent whose pinned session a standalone claude holds. → [agents.md#two-writer-guard](docs/notes/agents.md#two-writer-guard)
- `src/open.ts` — `paw open`/`paw attach`: runtime-aware; tmux → real window, cmux → names the tab, pty
  attach fails loud on cotal ≥0.25 (grant-based). → [agents.md#paw-open](docs/notes/agents.md#paw-open)
- `src/native-attach.ts` — `attachTmux`; default socket; `nudgeTmuxConfirm`. → [agents.md#native-attach](docs/notes/agents.md#native-attach)
- `src/attach-client.ts` — ws pty attach client, now dead code. → [agents.md#attach-client](docs/notes/agents.md#attach-client)
- Waking a sleeping agent: `cotal_dm("global", "wake <name>")`; the tty dev-channels prompt nudge. → [agents.md#waking-a-sleeping-agent-the-in-mesh-gap-and-the-tty-prompt](docs/notes/agents.md#waking-a-sleeping-agent-the-in-mesh-gap-and-the-tty-prompt)
- `src/sleep.ts`, `src/sleep-host.ts`, `src/sleep-state.ts` — `paw sleep`: opt-in hibernation; the
  mailbox hosts a stand-in presence so a DM wakes the agent and the backlog is re-published. → [sleep.md](docs/notes/sleep.md)

### Addressing → [addressing.md](docs/notes/addressing.md)
- `src/addressing.ts` — folder→name registry (`folders.json` defaults + `agents.json` extras, never
  both); `ensureAgentSpawned` (wake gate: start/reuse/restart from ps liveness, starting-grace 15s,
  busy-guard 3min, persona channel grants `[">"]` + `subscribe: [general]`); `assertUnambiguousTarget`. → [addressing.md#srcaddressingts](docs/notes/addressing.md#srcaddressingts)
- `src/adopt.ts` — `paw adopt`: bring a past/running session live; make-before-break `--force`;
  self-adopt via detached child; `assertSafeRepin` (one agent per session, `--replace` to re-pin);
  worktree sessions adoptable from the repo root. → [addressing.md#paw-adopt](docs/notes/addressing.md#paw-adopt)
- `src/rename.ts` — relabel (moves persona + pin). → [addressing.md#paw-rename](docs/notes/addressing.md#paw-rename)
- `src/rm.ts` — forget an agent; transcript always kept. → [addressing.md#paw-rm](docs/notes/addressing.md#paw-rm)
- `src/named.ts` — named-session resolution via `~/.claude/sessions`. → [addressing.md#named-sessions](docs/notes/addressing.md#named-sessions)
- `src/github.ts` — `github:owner/repo[#branch]` (pasted URLs accepted), blobless clone, no fork. → [addressing.md#github-handles](docs/notes/addressing.md#github-handles), [addressing.md#github-pasted-urls](docs/notes/addressing.md#github-pasted-urls)
- `src/worktree.ts` — `<repo>@<branch>` → existing worktree (never auto-creates); `resolveFolderArg`. → [addressing.md#worktrees](docs/notes/addressing.md#worktrees)

### Status → [status.md](docs/notes/status.md)
- `src/status.ts` — `paw status`: one row per agent (registered + unregistered ps peers); INBOX lag is
  the zombie detector (`?` on query failure, never a fabricated 0); `failure` from synthetic API-error
  turns; `busy` = paw's inference, distinct from the mesh's `working`; `--json`. → [status.md#srcstatusts](docs/notes/status.md#srcstatusts)

### Transcripts & log → [transcript-log.md](docs/notes/transcript-log.md)
- `src/sessions.ts`, `src/log.ts`, `src/transcript.ts` — `paw sessions`, `paw log` (dispatches on persona
  `agent:`; a pinned agent never falls back to a sibling's transcript); `TranscriptParser` shared by log
  + web. → [transcript-log.md#sessions-and-log](docs/notes/transcript-log.md#sessions-and-log)

### Messaging → [messaging.md](docs/notes/messaging.md)
- `src/dm.ts` — `paw dm`: fire-and-forget as "you", consume:false; `-` reads stdin. → [messaging.md#paw-dm](docs/notes/messaging.md#paw-dm)
- `src/mailbox.ts` — the "you" presence beacon daemon (consume:false); also hosts the sleep host. → [messaging.md#paw-mailbox](docs/notes/messaging.md#paw-mailbox)
- `src/inbox.ts` — `paw inbox`: pure reader + shared cursor; `--watch` keeps its own high-water mark;
  `--json` never advances the cursor; `--sent`, `--mark-read`. → [messaging.md#paw-inbox](docs/notes/messaging.md#paw-inbox)
- `src/feed.ts` — `messageText` (THE flattener), `observerEndpoint`, `readConversation`, `pollLoop`. → [messaging.md#srcfeedts](docs/notes/messaging.md#srcfeedts)
- `src/cursor.ts` — forward-only unread cursor shared by inbox + chat. → [messaging.md#srccursorts](docs/notes/messaging.md#srccursorts)
- Channel replay on restart; bound it with `paw cotal channels default --window 1h`. → [messaging.md#channel-replay-why-a-restarted-agent-gets-flooded](docs/notes/messaging.md#channel-replay-why-a-restarted-agent-gets-flooded)

### paw chat → [chat.md](docs/notes/chat.md)
- `src/chat.ts` — the headline REPL as a persistent human peer; bare `paw chat` = `.`, `--all` global,
  `@agent` filtered (hidden messages never marked read), `#channel`; `--fresh` is the birth verb (fails
  if an agent exists); follows the conversation only when input is empty. → [chat.md#srcchatts](docs/notes/chat.md#srcchatts)
- `src/images.ts` — `[Image #N]` attachments as TEXT (never a new part kind); stage ephemeral paths. → [chat.md#images](docs/notes/chat.md#images)
- `src/paste.ts` — bracketed paste → one `[Pasted text #N]` message; suppression starts at the START marker. → [chat.md#paste](docs/notes/chat.md#paste)
- `src/multiline.ts` — alt/shift+enter and trailing `\` continuation. → [chat.md#multiline](docs/notes/chat.md#multiline)
- `src/markdown.ts` — markdown → ANSI; never lose content, never eat placeholders. → [chat.md#markdown](docs/notes/chat.md#markdown)
- Also: echo + ↓ picker, modes, `!cmd` (detached from the tty), follow, visual rounds, wait feedback. →
  [chat.md](docs/notes/chat.md) (sections `echo-and-picker`, `modes`, `bang-commands`, `follows-the-conversation`, `visual-rounds`, `waiting-feedback`)

### paw web → [web.md](docs/notes/web.md)
- `src/web.ts` + `web/app/` — localhost-only browser UI on 7788 (busy port throws); exact Origin + Host
  checks; own `web.cursor`; drafts per target; `!cmd`; PRs; search; channels; village; quotes; archive.
  `!cmd` is arbitrary code execution — never expose paw web beyond loopback. → [web.md#paw-web](docs/notes/web.md#paw-web)
- `paw web` re-execs itself under node when the CLI is bun. → [web.md#node-re-exec](docs/notes/web.md#node-re-exec)
- `src/tasks.ts` + `web/app/{tasks,taskspad,board,editlist}.js` — fleet task list on beads (`~/.beads`,
  bd calls serialized); verify UI by COMPUTED STYLE, not class flags. → [tasks.md](docs/notes/tasks.md)

### Raycast → [raycast.md](docs/notes/raycast.md)
- `raycast/` — own npm project; shells out to the `paw` CLI (never joins the mesh); per-message read
  state; one refcounted poller per kind; install with `npx ray build -e dev`.

### Tests → [testing.md](docs/notes/testing.md)
- `scripts/check-*.ts` (`pnpm check:<name>`) — hermetic suites; `check:loop` (mesh only) and `check:rail`
  (real manager, enforced isolation). A green suite + typecheck has twice proven nothing about the wire.

## Env knobs (condensed — full text: [lifecycle.md#env-knobs](docs/notes/lifecycle.md#env-knobs))
- `PAW_SPACE` — default space (`paw`).
- `PAW_AUTH=1` — JWT-authed mesh (default open localhost).
- `PAW_PERMISSION` — override `bypassPermissions`.
- `PAW_MODEL` — default model for spawned agents (`--model` overrides).
- `PAW_RUNTIME` — `pty`|`tmux`|`cmux`; env > sticky `spaces/<s>/runtime` (`paw runtime <r>`) > pty.
  `paw restart [<r>]` force-bounces; from inside an agent it detaches a child. cmux needs `fullOpenAccess`.
- `PAW_ROOT` / `PAW_ALLOW_ANY_CWD=1` — cwd confinement.
- `PAW_HOME` — state root (default `~/.paw`; releases under it).
- `PAW_RELEASE` — unset = `current` release; `dev` = checkout (loud); `<id>` = pin/rollback.
- `PAW_COTAL_ROOT` — override the cotal root for a space.

## Dev
- ESM, tsx, no build step: `pnpm paw <cmd>`. `pnpm typecheck`, `pnpm check:launch` (+ the other `check:*`).
- Launcher `~/.local/bin/paw` may exec bun; verify the manager process is `node …/tsx/…`, never bun.
- **GitHub:** local `private-main` = full history, no upstream, never pushed. `main` is an orphan
  snapshot pushed to `origin`; `scripts/githooks/pre-push` refuses `private-main`. Visibility is the operator's call.
- pnpm 11 reads settings from `pnpm-workspace.yaml` (`allowBuilds.esbuild: false`, `verifyDepsBeforeRun: false`).
- Full Dev notes: [lifecycle.md#dev](docs/notes/lifecycle.md#dev).

## Conventions
- Build on cotal; contribute generic gaps upstream (per-agent cwd), keep paw-specific bits here.
- Fail loud; never fabricate fallback values.
- Full design: `~/paw-design.md`.

## Deep notes
| file | covers |
|---|---|
| [docs/notes/cli.md](docs/notes/cli.md) | composition roots, commands, mcp, files, bind, global, keeper, start, pacing, launchd, stdout |
| [docs/notes/lifecycle.md](docs/notes/lifecycle.md) | lifecycle.ts, releases, cotal root, node/tsx, manager failures, env hygiene, locks, full Env knobs (cmux socket gate), full Dev |
| [docs/notes/control-rail.md](docs/notes/control-rail.md) | the manager control rail (src/control.ts) |
| [docs/notes/cotal-dependency.md](docs/notes/cotal-dependency.md) | cotal 0.58, 0.48 bump, version history back to 0.9 |
| [docs/notes/agents.md](docs/notes/agents.md) | connector, cwd, paw claude, foreground, open/attach, waking |
| [docs/notes/sleep.md](docs/notes/sleep.md) | paw sleep / sleep host |
| [docs/notes/addressing.md](docs/notes/addressing.md) | registry, adopt, rename, rm, named sessions, github, worktrees |
| [docs/notes/status.md](docs/notes/status.md) | paw status, failure, busy, unregistered rows |
| [docs/notes/transcript-log.md](docs/notes/transcript-log.md) | paw sessions, paw log, transcript parser |
| [docs/notes/messaging.md](docs/notes/messaging.md) | dm, mailbox, inbox, feed, cursor, channel replay |
| [docs/notes/chat.md](docs/notes/chat.md) | paw chat and its input pipeline |
| [docs/notes/web.md](docs/notes/web.md) | paw web |
| [docs/notes/tasks.md](docs/notes/tasks.md) | beads task list, pad, board |
| [docs/notes/raycast.md](docs/notes/raycast.md) | Raycast extension |
| [docs/notes/testing.md](docs/notes/testing.md) | check scripts |
