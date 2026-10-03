# Agents: connector, spawn, attach, waking

Moved verbatim from CLAUDE.md (2026-10-02 split). Index: [CLAUDE.md](../../CLAUDE.md)

## src/connector.ts

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

## src/cwd.ts

- `src/cwd.ts` — `confineAndTrustCwd(cwd)`: PAW_ROOT confinement (out-of-root throws unless
  `PAW_ALLOW_ANY_CWD=1`) + Claude folder pre-trust (writes `hasTrustDialogAccepted`/onboarding into
  `~/.claude.json`, creating it if absent, under an adjacent lock; in-root only). Called by
  `ensureAgentSpawned` just before the manager spawn, returns the CANONICAL cwd to pass through (so the
  dir claude runs in matches the trust key). Moved out of the connector when cotal #43 gave the
  manager the cwd.

## paw claude

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

## foreground registry

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

## agent persona pin

- **`agent:` persona pin → which CONNECTOR respawns an agent (`readAgentType`, src/session.ts, 2026-09-01):**
  every paw wake/revival path (`paw start`, `paw restart` revival, `paw dm`/`chat` wake, adopt) spawns
  through `ensureAgentSpawned`, which used to send NO `agent` — so the manager's default (paw's claude
  connector) booted, and a codex/opencode agent spawned via `paw cotal spawn --agent …` would come back
  from any restart as a CLAUDE named codex1. The persona's frontmatter `agent: codex|opencode` is now
  forwarded as the spawn op's `agent` (cotal 0.25 `SPAWN_INPUT_SCHEMA` accepts it), so the harness is
  durable in the same file as the name/pin. Absent ⇒ default claude, unchanged. Verified live: `paw
  start codex1` → `codex1 codex · tmux`. Non-claude agents are still NOT in the launchd fleet list on
  purpose (booting them at login spends codex/grok sessions — the operator's call). Test: `check:mcp`.

## src/session.ts

- `src/session.ts` — leaf module shared by connector (launch), spawn site (guard), and status:
  `readResumeId` (parse a persona's `resume:` pin) + `transcriptExists` (does `~/.claude/projects/*/<id>.jsonl`
  exist → resume vs first-boot-create). Kept separate so `addressing.ts` needn't import the connector.

## two-writer guard

- **Two-writer guard:** `ensureAgentSpawned` (and `adopt`) refuse to start an agent whose pinned
  session a standalone claude is holding (`foreignWriters` in `src/named.ts` = live non-mesh procs on
  that id) — resuming it would put two writers on one transcript and corrupt it. This is why `paw chat
  --fresh` no longer silently resumes a human's own live session (the `aleks` incident, 2026-06-26).

## paw open

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

## native attach

- `src/native-attach.ts` — `attachTmux(space, name)` + `tmuxSession(space)` (= `cotal-<space>`): the
  tmux-runtime attach. Selects `<session>:<name>` (fail-loud if the window's gone), then
  `switch-client` when already inside tmux (attach-session can't nest) else `attach-session`. On the
  attach-session (plain-shell) path it STRIPS `TMUX_TMPDIR` so it hits the same STANDARD default socket
  the manager is pinned to (see lifecycle `defaultTmuxEnv`); the inside/switch-client path keeps ambient
  env (it needs the operator's real client on that default server). cmux is
  deliberately absent — its agents are GUI-app tabs paw can't take a terminal over.

## attach client

- `src/attach-client.ts` — paw's ws pty attach client (wire port of the manager's non-exported
  attach-client; framing byte-identical: binary = keystrokes, text `r:<cols>,<rows>` = resize,
  Ctrl-] = detach, full tty restore incl. alt-screen wheel→PageUp/Down translation). Uses node's
  global WebSocket (hence `engines.node >= 22`). Exports `attachTo(wsUrl)`.

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
