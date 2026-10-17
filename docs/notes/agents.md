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
  start codex1` → `codex1 codex · tmux`. `agent: kit` (the lean Go harness on codex/grok) is the same mechanism with a
  paw-side connector — see [kit.md](kit.md). Non-claude agents are still NOT in the launchd fleet list on
  purpose (booting them at login spends codex/grok sessions — the operator's call). Test: `check:mcp`.

## hermes

- **`agent: hermes` (src/hermes.ts, src/hermes-profile.ts, 2026-10-09):** cotal's own
  `@cotal-ai/connector-hermes@0.72.1`, registered in cotald and REPLACED by a paw wrapper (like claude).
  cotal's launcher owns the seat: it joins the mesh, then runs `uv run --project <pkg> hermes gateway run`
  (hermes-agent from PyPI, range >=0.18,<0.22 — resolves to 0.19.0; the operator's own `hermes` CLI is
  NOT used) with an in-gateway cotal plugin (platform adapter + hooks + cotal_* tools). A reply to a DM
  goes back to the sender on its own. No AG-UI event plane ⇒ paw spawns it `events: false` (as kit).
- **Persona:** `agent: hermes`, `model: grok-4.7`, `provider: xai-oauth` (Hermes' provider id; required),
  optional `baseUrl:` (custom endpoint), `shareTools: none` (its tools come from the plugin). `paw chat
  <folder> --agent hermes --provider xai-oauth --model grok-4.7` births one. `PAW_MODEL` (a claude
  name) never applies to it.
- **Its own durable profile.** cotal's default is a disposable tmp profile deleted on every stop; paw
  instead runs each agent in `$PAW_HOME/hermes/profiles/<space>-<name>` via cotal's adopt mode
  (`COTAL_HERMES_ADOPT_HOME`). Hermes reads that as profile `<space>-<name>` of root `$PAW_HOME/hermes`, so
  its launchd label (`ai.hermes.gateway-<p>`), auth store and sessions never touch `~/.hermes`. paw
  REGENERATES config.yaml (model/provider/base_url, plugin + platform on, approvals off = bypass parity,
  `terminal.cwd` = the agent folder) and SOUL.md (persona body + paw brief) every launch; sessions,
  memories and auth.json are Hermes' and survive restarts/reboots (e2e: the MARK-ONE session is still
  listed after stop + start). The launcher gets a frontmatter-only copy of the persona (adopt mode refuses
  a body). Venv: `$PAW_HOME/hermes/venv` (`UV_PROJECT_ENVIRONMENT`, never inside a release). TMPDIR:
  `/tmp/paw-hermes-<uid>/<digest>` — the bridge socket name is 58 bytes and macOS caps socket paths at
  104, so `/var/folders/…` fails with a bare EINVAL; leftover `cotal-launch-*` there are wiped per launch.
- **OAuth = one login per profile, on purpose.** A login provider (`xai-oauth`, `openai-codex`, `nous`,
  …) refuses to launch until the profile has a credential, printing the command:
  `HERMES_HOME=<profile> ~/.paw/hermes/venv/bin/hermes auth add xai-oauth` (or the `uv run` form before
  the venv exists). Not shared with `~/.hermes`: hermes 0.19 reads a global credential as a fallback but
  writes a refreshed (rotated) token only to the profile, which would strand the other copy.
- **`hermesHome: /abs/profile`** runs the agent in an EXISTING Hermes profile (the hand-made seat's
  `~/.hermes/profiles/mesh`): paw writes nothing there but cotal's `plugins/cotal`; that profile's
  config.yaml must enable plugin + platform and picks the model, so `model:`/`provider:`/`baseUrl:` beside
  it are refused. Hermes is a singleton per profile — never run a paw agent on a profile another gateway
  (e.g. tmux `hermes-seat`) is using.
- **status / log / wake:** busy = presence only (no transcript; hooks set working/idle); the SESSION cell
  reads `(hermes)`. `paw log` fails loud naming the profile's `logs/` and `state.db`. Wake, `paw start`,
  restart revival and launchd fleet revival are the normal `ensureAgentSpawned` path.
- Tests: `check:hermes` (hermetic), `scripts/e2e-hermes.ts` (isolated mesh, fake OpenAI-compatible model:
  start → status → DM reply → stop → start → DM reply → log refusal).

## acp

`agent: acp` runs any Agent Client Protocol agent (fx acp, codex-acp, gemini, goose) through the standalone
plugin `cotal-connector-acp` (~/Github/caffeinum/cotal-connector-acp), vendored as
`vendor/cotal-connector-acp-<v>.tgz` (a file: dep keeps releases immutable; re-pack + `pnpm update
cotal-connector-acp` after a plugin change). `bin/cotald.ts` unregisters the plugin's vanilla `acp` and
registers `pawAcpConnector` (`src/acp.ts`), which spreads it and adds only:
- the paw brief as `COTAL_ACP_INSTRUCTIONS` (it rides the first prompt; ACP has no system prompt);
- `BEADS_DIR`/`BEADS_ACTOR`, and `niced()` from the persona's `nice:`;
- `acpPermission: allow` unless the persona or the spawn names one (the plugin has no default; paw is bypass).
- the seat host (`src/acp-host.ts`): **the Rust host by default**, at `$PAW_HOME/bin/cotal-acp-host-<rev12>`
  (cotal-connector-acp `native/rust`, built on cotal-rs; ~6 MB RSS live vs 57–145 MB for the node host).
  **Pinned:** `ACP_HOST_REV` is the plugin commit the vendored tgz was packed from, and the host is built from
  that same commit — the two share an env/launch contract (native/WIRE.md) with no handshake, so paw never
  pairs them across commits. `paw acp-host install` `git archive`s `native/rust` at that rev out of
  `$COTAL_ACP_REPO` (default ~/Github/caffeinum/cotal-connector-acp — its working tree, dirty or not, is never
  built) and runs `cargo build --release --locked` on it (`CARGO_NET_GIT_FETCH_WITH_CLI=true`: cotal-rs is a private git dep) (a rev whose Cargo.lock is stale fails there, loud),
  then installs atomically; live seats keep their binary until they restart. The rev is in the file name: a
  re-vendor fails loud until its host is installed, and a release rollback still finds its own older host.
  `ACP_PLUGIN_INTEGRITY` is the tgz's pnpm-lock integrity — check:acp fails a re-pack that didn't bump the
  pair. `paw acp-host` shows it (same executable-file test as the spawn gate). A missing binary **fails loud at
  spawn** with that command (CLI side in `ensureAgentSpawned`, and again in the manager's `buildLaunch`) —
  never a silent node fallback. Persona `acpHost: /abs/host` names another native host; `acpHost: ts` is
  the explicit node host (paw shadows it with launch option `host = node`, then adds the plugin's
  `dist/host.js` — the plugin itself accepts only an absolute executable). A spawn `--opt host=` wins.
No TMPDIR override: the control socket and launch material are made in the manager's `buildLaunch`, so the
seat's TMPDIR never mattered, and an override also stopped the seat from removing its launch-material dir.

Persona: `agent: acp`, `acpCommand: '["/abs/fx","acp"]'` (quoted JSON), optional `acpEnv:` /
`acpPermission:` / `acpHost:`. Spawned `events: false`, `shareTools: none`; `paw status` reads presence alone.
`--agent acp` refuses `--model` (the model goes in `acpCommand`) and refuses to birth a persona that has no
`acpCommand:` yet. Only claude harnesses get the `~/.claude.json` folder pre-trust (`confineCwdOnly` otherwise),
both at the spawn site and in `startupWatch`'s boot-time re-write (codex/opencode get neither; check:trust).

**An isolated space does not isolate the ACP agent's own home.** fx writes `~/.fx/sessions`, history and
usage, and bills the operator's account, whatever PAW_HOME says. In a test, pass `HOME` through `acpEnv`
pointing into the throwaway root, with only the auth file copied in (fx: `~/.fx/grok-auth.json`; check its
`expires_at_ms` is well ahead so fx does not refresh the copy). Keep the test PAW_HOME SHORT (`mktemp -d
/tmp/pw.XXXX`): a scratchpad-deep one pushes `hub.sock` past the 103-byte unix-socket limit and `paw status`
refuses. Live-verified 2026-10-16 on a private nats-server (`PAW_SERVER`): fx acp (grok) answered a `paw dm`,
`paw status`/`paw who` showed it idle, host = the Rust binary at ~6 MB RSS under nice 10.
2026-10-17, after the host pin: `paw acp-host install` built 1b8048a from a git archive (2.6 MB binary, ~1.5 min
cold); a scripted ACP agent (the plugin's test/fake-acp-agent.mjs) came up idle on it (7 MB RSS, nice 10) and
received a `paw dm` as its session/prompt. fx was not re-run: the grok access token had expired, and refreshing
a throwaway copy could rotate the operator's refresh token.

## src/session.ts

- `src/session.ts` — leaf module shared by connector (launch), spawn site (guard), and status:
  `readResumeId` (parse a persona's `resume:` pin) + `transcriptExists` (does `~/.claude/projects/*/<id>.jsonl`
  exist → resume vs first-boot-create). Kept separate so `addressing.ts` needn't import the connector.

## two-writer guard

- **Two-writer guard:** `ensureAgentSpawned` (and `adopt`) refuse to start an agent whose pinned
  session a standalone claude is holding (`foreignWriters` in `src/named.ts` = live non-mesh procs on
  that id) — resuming it would put two writers on one transcript and corrupt it. This is why `paw chat
  --fresh` no longer silently resumes a human's own live session (the `aleks` incident, 2026-06-26).
  A MESH holder running as the same name (env `COTAL_NAME`) is the agent itself, alive outside the
  manager — reused, not refused. See [addressing.md#unmanaged-agents](addressing.md#unmanaged-agents).
- **Startup classifier:** `classifyStartupScreen` returns `ready` for claude's idle input box + mode
  footer (`isIdleInput`, judged on the LAST lines only — older pane text can hold a dialog's leftover
  "Enter to confirm"), so `paw start` no longer logs an idle claude as an "unrecognised prompt".

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

**The tty-prompt trap (`answerStartupPrompt`, src/native-attach.ts; was `nudgeTmuxConfirm`).** claude's
`--dangerously-load-development-channels` prints a one-time confirmation. cotal's tmux runtime clears
it (`scheduleConfirm`, gated on the claude connector's `spec.confirm`, which paw preserves via
`{...spec, args}`) — **but only at 1s…5s after the window opens.** A cold claude on a loaded machine
reaches the prompt well after that, so every Enter lands BEFORE the question exists and the agent then
waits at it indefinitely with no mesh presence. `cotal-endpoint-telegram` hung ~90s until a human
pressed Enter, and this is the likeliest explanation for an agent stuck at `starting…`. paw therefore
nudges Enter again on every poll of `waitForMeshLive` during `STARTING_GRACE_MS` — the window where the
prompt actually appears. tmux only (pty clears its own; cmux windows aren't paw's to type into),
best-effort, never throws: a missing window is not a spawn failure.

**The trust race, and why the nudge now READS the window (2026-10-03, `startupWatch` in
src/addressing.ts, test `check:trust`).** paw pre-trusts a folder in `~/.claude.json` just before the
spawn, under its own lock — but claude rewrites that file without the lock, and a claude booting just
before erased the next agent's fresh entry (lost update; 3 of 5 isolated hub e2e runs, entry verified
missing). The new claude then showed its trust dialog, whose DEFAULT is "No, exit", and the blind
Enter picked it: against a real claude that is `exit 1`, before MCP — the agent simply vanished
(tmux), or sat at the dialog as `starting…` forever (pty, where nothing types). Now, every readiness
poll: (a) re-checks the trust entry and re-writes it if gone — any runtime, saves any claude that
hasn't read the file yet; (b) on tmux, captures the pane first: Enter ONLY at the dev-channels gate;
at the trust dialog, "Yes, I trust this folder" (cursor moved, one key per send) ONLY for a folder
paw's own policy trusts (`pawTrustedFolder` — the `confineAndTrustCwd` rule), after re-writing the
entry; anything else gets nothing, and an unrecognised prompt is logged with its last lines; (c) the
readiness-timeout error names what was seen (erased entry / a dialog paw won't answer / the prompt).
Verified against a real claude in a private tmux server: blind Enter → exit 1; the new answer → idle.
Live check (read-only, 2026-10-03): 121 of 129 registered folders trusted; the rest are deleted
worktrees, opencode1, and one extant worktree agent. So established agents rarely hit it — FIRST
boots of new folders while another claude writes the file do. Upstream ask for pty: docs/notes/
upstream-trust-hook.md (drafted, not filed).

**Since cotal 0.81.1 paw types at NEITHER prompt (`readStartupPrompt`).** cotal 0.80's claude connector
declares the trust replies as `confirmBefore` on every managed launch, and every runtime (pty, tmux,
cmux) answers them — Down onto "Yes, I trust this folder" once "❯ No, exit" is stable on two reads,
then Enter — before its dev-channels Enter, each step once and in order. A paw Down/Enter beside it
races that sequence (a second Down, or a key that clears the step cotal is waiting for, and the seat is
ended at 15s), so (b) above is now read-only: paw names the screen for `cause()` and still re-writes
an erased trust entry (a). The 0.68 "Claude home does not trust" refusal is gone upstream, and with it
`spawnPinned`'s retry. Headless launches drop `confirmBefore` with `confirm` (runtimes refuse one
without the other). → [cotal-dependency.md#cotal-0811](cotal-dependency.md#cotal-0811)
