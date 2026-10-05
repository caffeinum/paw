# kit agents — persona `agent: kit` (the lean Go harness, managed by paw)

Index: [CLAUDE.md](../../CLAUDE.md). Background: [lean-harness-poc.md](lean-harness-poc.md), kit's own
README (`~/Github/caffeinum/kit`). Code: `src/kit.ts` (connector + brief + binary), `src/brief.ts`
(the brief sections, shared with `src/connector.ts`), the `kit` branches in `src/addressing.ts`
(spawn), `src/open.ts`, `src/session.ts` (`writesClaudeTranscript`), `src/transcript.ts`
(`kitEnvelopeBlocks`), registration in `bin/cotald.ts`. Tests: `check:kit` (hermetic),
`scripts/lean/kit/e2e-kit-managed.ts` (own broker; fake or real provider).

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
    (kit CREATES a Claude Code session at that id, filed `~/.claude/projects/<slug of cwd>/<pin>.jsonl`
    on its first turn, refusing an id that already exists), `--resume <pin>` after. A brand-new agent
    therefore gets a fresh session; a claude agent switched to kit continues its claude transcript.
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
  (`writesClaudeTranscript`). kit puts each message INTO its prompt (`<channel source="cotal" …
  msg_id="…">body</channel>`, several coalesced per turn), so the parser shows each as `📨 dm from X`
  plus the body on the `│` rail (claude's own wake has no body — unchanged).
- `paw open/attach <name>`: says it runs on kit (headless, no TUI) and points at log/dm/stop.
- RAM, measured in the e2e: 7 MB footprint / 15 MB RSS at boot, 12–13 MB / 21 MB after real codex
  turns (claude TUI: 190–250 MB; headless claude: 150–185 MB).

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
   Remove `shareTools`-dependent expectations (no MCP for kit).
4. `paw restart evals-reviewer` → `paw status evals-reviewer` (managed, idle), `paw dm evals-reviewer
   "…"`, `paw log evals-reviewer`.
