# kit agents — persona `agent: kit` (the lean Go harness, managed by paw)

Index: [CLAUDE.md](../../CLAUDE.md). Background: [lean-harness-poc.md](lean-harness-poc.md), kit's own
README (`~/Github/caffeinum/kit`). Code: `src/kit.ts` (connector + brief + binary), `src/brief.ts`
(the brief sections, shared with `src/connector.ts`), the `kit` branches in `src/addressing.ts`
(spawn, `applyAgentType` for `paw chat --agent`), `src/open.ts`, `src/session.ts`
(`writesClaudeTranscript`, `transcriptRoots`/`readKitStorage`), `src/transcript.ts`
(`kitEnvelopeBlocks`), registration in `bin/cotald.ts`. Tests: `check:kit` (hermetic),
`scripts/lean/kit/e2e-kit-managed.ts` (own broker; fake or real provider),
`scripts/lean/kit/e2e-kit-storage.ts` (own broker + throwaway HOME; storage modes, kit-first space,
busy, `paw chat --agent`).

## The persona

```
---
name: evals-reviewer
agent: kit
provider: codex        # or grok (openai/xai accepted; fake[:codex|:grok] for tests)
model: gpt-6.1-sol     # optional — kit's default otherwise; an explicit `--model` still wins
variant: high          # optional — codex reasoning effort (kit --effort)
cwd: /Users/aleks/Github/team2027/evals
resume: <uuid>         # minted at birth, as for every paw agent
storage: claude        # optional — see "Session storage"; absent (or `kit`) = kit's own store
---
<persona body — becomes part of kit's system prompt>
```

## How it runs

- `bin/cotald.ts` registers `kitConnector` (`src/kit.ts`) under `kit`; the persona's `agent:` pin
  makes the manager pick it on every spawn path (`paw start`, `restart`, `dm`/`chat` wake), exactly
  like codex/opencode agents.
- `buildLaunch` → `<kit> run --cwd . --name <n> --space <s> --server <url> --provider … [--model …]
  [--effort …] --channels <subscribe> --actor <COTAL_ID> --lifecycle-uid <uid>
  --append-system-prompt-file <PAW_HOME>/spaces/<s>/kit/<n>/system.md (--session-id|--resume) <pin>`.
  - **cwd `.`**: the manager owns the working directory and hands it to the runtime (cotal #43);
    kit resolves it to the real path.
  - **identity**: the manager mints an actor + lifecycle uid per spawn and its readiness fence waits
    for presence under exactly `local.<actor>` with that uid. kit (cotal-go `Config.Actor/LifecycleUID`)
    adopts both, so `paw status` shows it MANAGED, ps tracks it, `paw stop/restart` despawn it.
  - **session**: same rule as the claude connector — `--session-id <pin>` while no transcript exists
    in the stores kit reads (kit CREATES a session at that id on its first turn, refusing an id it can
    already find), `--resume <pin>` after; plus `--overwrite` for `storage: claude`. Which store is the
    next section. A brand-new agent gets a fresh session; a claude agent switched to kit continues its
    claude transcript (in place with `storage: claude`, as a fork without).
  - **no cotal MCP / hub shim**: kit speaks cotal itself (built-in cotal_dm/cotal_send/cotal_roster).
    Shared MCP servers (`paw mcp`) cannot reach it — the connector refuses a non-empty share.
  - **env**: an OS allow-list (PATH, HOME, TERM, LANG, TMPDIR, XDG_*, KIT_HOME…) + `COTAL_NAME`/
    `COTAL_SPACE` (paw's process-identity stamps) + `BEADS_DIR`/`BEADS_ACTOR`. Nothing else of the
    manager's env. Tokens: kit's own `~/.kit/auth.json`, else borrowed read-only from codex/opencode.
  - **system prompt**: kit's own (tools, reply rule) + the persona body + `kitBrief`: the shared brief
    sections (channels, wake-via-global, beads tasks, operator requests) minus claude-only parts
    (cotal_inbox/anycast, cotal_join, image Reads, run_in_background). `src/brief.ts` holds the
    sections; the claude brief is byte-identical to before the split.
- `ensureAgentSpawned` (CLI side) for a kit agent: sends `events: false` (kit publishes no AG-UI event
  plane; the manager refuses an armed spawn on a connector without one), never applies the
  `PAW_MODEL` default (a claude model name), skips the claude startup watch (no TUI, no trust dialog),
  and calls `ensureKitBinary()`.
- **The binary**: `$KIT_BIN` if set (never built over), else `$PAW_HOME/bin/kit`, built on first spawn
  from `$KIT_SRC` (default `~/Github/caffeinum/kit`) with `go build`. The manager's connector only
  resolves the path and fails loud if it is missing. **Upgrading kit** = rebuild it:
  `cd ~/Github/caffeinum/kit && go build -o ~/.paw/bin/kit ./cmd/kit` (or delete the file and the next
  spawn builds it), then `paw restart <agent>`. It is NOT part of a paw release snapshot.
- `paw log <name>`: kit writes Claude Code JSONL, so the claude log path reads it
  (`writesClaudeTranscript`), from the store the persona's `storage:` names. kit puts each message INTO its prompt (`<channel source="cotal" …
  msg_id="…">body</channel>`, several coalesced per turn), so the parser shows each as `📨 dm from X`
  plus the body on the `│` rail (claude's own wake has no body — unchanged).
- `paw open/attach <name>` on a tty: runs kit's own live view, `kit <name> --space <s> --server <url>
  -- <this paw> dm <name> --space <s> -` (`kit @<name>` for a name that is a kit subcommand: run,
  once, auth, dump, help). The view shows header (harness · provider · model, folder, session,
  context, process), the latest turn's messages, the current tool + result / live bash output, the
  generation status and a `> ` prompt; Enter runs that `paw dm` with the text on stdin, so messages
  arrive from "you"; Esc/Ctrl-C leave, the agent keeps running. Status comes from kit's
  `<transcript>.kit.status` (phase, retries) when the kit binary writes one, else from presence +
  transcript timing. Off a tty, or when the binary at `kitBinPath()` predates the view (its
  `--help` has no `kit <name>`), it falls back to the summary + `paw log -f`. Details: kit's README
  "The view". Test: `scripts/lean/kit/e2e-kit-tui.ts` (isolated mesh, node-pty + @xterm/headless
  from `$XTERM_DIR`; green 2026-10-06: header/sections/prompt, a typed `FAKE:` turn shows the
  running bash with live output then `↩ you`, Alt+Enter two-line prompt, Esc leaves, agent stays).
  paw passes the view `--session <transcript>` from its own store-aware lookup (`kitViewSession`):
  the view's default searches kit's store first whatever the persona says.
- **kit as the first agent of a space**: cotal-go refuses to create the space's streams (it exited
  "stream DM_<space> … not found" until a TS endpoint had joined), and none of paw's daemons consumes,
  so a brand-new space had none until its first claude agent. `ensure()` (when it needs the manager —
  every spawn path) and `restartManager` now call `ensureSpaceStreams` (src/lifecycle.ts): one stream
  listing; if any of CHAT_/DM_/TASK_/INBOX_/DLV_ is missing, core's own `createSpaceStreams` (the same
  definitions `CotalEndpoint.ensureStreams` uses) creates them. Open meshes only (`cotal up`
  provisions an auth mesh). Never re-adds an existing stream, so a drifted config is never touched.
- **busy**: `paw status` judges a kit agent by its presence alone (`liveTurn`, src/status.ts). kit sets
  `working` for exactly the turn and `idle` after, but its transcript never closes a turn the claude
  way — the turn ends right after the reply cotal_dm, last record a tool_result, no turn_duration — so
  the transcript turn inference read every idle kit agent as busy.
- RAM, measured in the e2e: 7 MB footprint / 15 MB RSS at boot, 12–13 MB / 21 MB after real codex
  turns (claude TUI: 190–250 MB; headless claude: 150–185 MB).

## Session storage (`storage:`)

kit (branch `feat/session-storage-modes`, d047459 — not on kit main yet) has two stores, same slug
(`ClaudeSlug(cwd)`) and same Claude Code JSONL format:

- **kit's own** (default; persona `storage:` absent or `kit`): `<KIT_HOME|~/.kit>/sessions/<slug>/<id>.jsonl`.
  A new session is created there; resuming an id that exists only in claude's store FORKS it there
  (atomic copy) and appends only to the copy — the claude original is never written again.
- **claude's** (`storage: claude` → `kit run --overwrite`): `~/.claude/projects/<slug>/<id>.jsonl`,
  read and appended in place — what kit did before the branch. **Every kit agent that existed before
  the branch carries `storage: claude`** (operator's rule: existing kit agents stay bound to their
  claude sessions). A value other than `kit`/`claude` throws (`readKitStorage`) — a typo must not
  silently fork an agent.

paw's lookup (`transcriptRoots(agent, storage)` / `personaTranscriptRoots(persona)` in src/session.ts):
a kit agent on kit's store searches kit's store, then claude's; every other agent — claude, codex…,
and kit with `storage: claude` — searches claude's alone (the same id can exist in both with different
continuations, so a claude view must never see kit's fork). Used by: kit.ts (`--session-id` vs
`--resume`: a transcript in EITHER searched store means `--resume`, since kit refuses `--session-id`
for an id it can find), `paw log` + web trace (`agentTranscriptFile`: the cwd-local claude file is a
shortcut only within the claude tier, so a fork wins over its original), `paw status` (pins resolved
per store, one listing each), `paw attach` summary + kit view, `paw sleep` (activity/activeMs), the
dm/chat wake gate's busy check. `paw unstick`/`paw type` need a tmux pane, which a kit agent never has,
so they stay claude-only. Not forwarded: `CLAUDE_CONFIG_DIR` (paw's claude lookups are `~/.claude`).

Switching an agent: `storage: claude` → removed = its next boot forks the claude transcript into kit's
store (the claude original stays as it was at the switch). Removed → `storage: claude` = kit resumes
the claude original and the fork is ignored (paw then shows the original too) — turns made in the fork
are not in it.

## `paw chat <folder> --agent <type>`

`paw chat <folder> --agent kit [--provider codex|grok] [--model M] [--name N]` creates the agent on
that harness (or targets it if it already runs there), then chats as usual. Plain `paw chat` still
never creates; `--agent` is the explicit ask. Types: `kit`, `codex`, `opencode`, `claude`
(`applyAgentType`/`checkAgentSpec`, src/addressing.ts). A new agent's persona gets `agent:` (absent for
claude), `provider:` (kit only, default codex), `model:` (non-claude only — a claude `--model` stays a
per-spawn flag), `shareTools: none` (kit), a fresh `resume:` uuid, `cwd:`, grants and the default body.
Fails loud: an unknown type; `--provider` without `--agent kit`; `--agent X` on an existing agent whose
`agent:` is not X (or a different kit provider) — switching harness is a persona edit; `--agent` with
`--all` or a bare unregistered name (no folder). Works with `--fresh` and `--name`.

## kit's own CLI (no paw needed)

`kit` / `kit --continue` / `kit --resume [<id|name>]` [`--follow`] — load a session like `claude`
does for the current folder, join the mesh (name = folder basename, space/server from
PAW_SPACE/PAW_SERVER or paw's defaults, provider from KIT_PROVIDER, default codex), run silently in
the foreground; `--follow` prints the activity in `paw log`'s shape. Such an agent is UNMANAGED in
`paw status`. Details in kit's README.

## Verified (2026-10-05, isolated: own nats-server, PAW_HOME=/tmp/kh.*, PAW_SPACE=kit-test-*, PAW_RELEASE=dev)

`scripts/lean/kit/e2e-kit-managed.ts`, with `fake:codex` and with real `codex` / `gpt-6.1-sol`
(the operator's borrowed codex login), both green:
`paw start` (paw built the binary) → one `kit run` with `--session-id <pin>`, presence under the
manager's principal, `paw status --json` live + managed + idle; a DM answered; the transcript appears
at the folder's claude project under the pin; `paw restart` → `--resume <pin>`, new incarnation,
remembers PELICAN-42 (real codex); still managed; `paw log` shows the messages and replies; `paw open`
says kit; `paw stop` → offline, process gone, status not live. Then kit's CLI: bare `kit` silent,
named after the folder, new session filed like claude's, DM answered, SIGTERM → offline + exit 0;
`kit --continue --follow` same session, prints history + live activity, SIGINT → exit 0;
`kit --resume` lists and exits 1.

## Verified (2026-10-06, isolated: own nats-server, throwaway HOME + PAW_HOME, PAW_SPACE=kit-test-*, PAW_RELEASE=dev, KIT_BIN = kit built from feat/session-storage-modes d047459)

`scripts/lean/kit/e2e-kit-storage.ts` (fake:codex), all green: a fresh broker has no space streams;
`ensure()` creates them; a kit agent is the space's FIRST agent and comes up live + idle; default
storage launches `--session-id` without `--overwrite`, the transcript lands in `<HOME>/.kit/sessions`
and not in claude's store; after a turn + 11s, `paw status` says idle and `busy: false`; `paw log`
reads the kit-store file; restart → `--resume`. `storage: claude` → `--overwrite --session-id`, then
`--resume --overwrite`, turns in claude's file, none in kit's. Same agent with the line removed →
`--resume` without `--overwrite`, kit forks into its store, the new turn only in the fork, the claude
original untouched, `paw log` shows the fork. `paw chat <dir> --agent kit --provider fake:codex --name
chatty` births the persona (agent kit, provider, shareTools none, pin, cwd), starts it, a typed line
gets the reply on screen; `--agent codex` on it and `--agent gpt` fail loud.
`scripts/lean/kit/e2e-kit-managed.ts` with the same binary and a throwaway HOME: green after making it
store-aware (two stale assertions fixed: `paw open`'s kit notice goes to stderr since bfb66ed; kit's
`--resume` listing now says "store priority").

## Not verified / not done

tmux/cmux runtimes (pty only); PAW_AUTH meshes (the connector refuses them); `paw sleep` on a kit
agent; launchd fleet lists (non-claude agents stay out on purpose); the two-writer guard only knows
claude's session index — kit has its own `<transcript>.kit.lock` (refuses a second kit) and refuses a
transcript a live claude holds, but paw's `waitForSessionRelease` does not see a kit holder.

## Switching the live evals-reviewer to kit (after merge + `paw release`)

Operator only, when the fleet is idle — never automated.

1. Build the binary paw will use: `cd ~/Github/caffeinum/kit && go build -o ~/.paw/bin/kit ./cmd/kit`.
2. `paw release` then `paw restart` (the manager loads the new connector registration at startup;
   `paw restart` revives the agents that were live).
3. Edit `~/.paw/spaces/paw/personas/evals-reviewer.md`: `agent: kit`, add `provider: codex`, keep
   (or set) `model: gpt-6.1-sol`, keep `resume:` and `cwd:`. If it was a codex agent, its `resume:`
   pin has no Claude transcript, so its first kit boot creates a fresh session at that id.
   Remove `shareTools`-dependent expectations (no MCP for kit). Add `storage: claude` to keep it
   appending to its claude transcript (leave it out to fork into kit's store — see "Session storage").
4. `paw restart evals-reviewer` → `paw status evals-reviewer` (managed, idle), `paw dm evals-reviewer
   "…"`, `paw log evals-reviewer`.
