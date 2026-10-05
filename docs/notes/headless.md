# Headless agents — `claude -p` instead of the TUI (persona `headless: true`, opt-in)

Index: [CLAUDE.md](../../CLAUDE.md). Code: `src/headless.ts` (the launch), `src/hub/headless.mjs` (the
wake path), the `readHeadless` branch at the end of `src/connector.ts`, the hook in `src/hub/daemon.mjs`
`start()`. Tests: `check:headless` (hermetic), `scripts/e2e-headless.ts` (real claudes, own broker).

## Why

A TUI claude keeps a full Ink render tree, scrollback and terminal state alive for an agent nobody
looks at. `claude -p --input-format stream-json --output-format stream-json` runs the same agent loop
(same tools, hooks, MCP, transcript, session id) with none of that. Measured: see **RAM** below.

## What -p keeps and what it drops (claude 2.1.289, probed directly)

| | -p stream-json |
|---|---|
| multi-turn on one process | yes — one JSON user message per line on stdin, one turn each, process stays up until stdin EOF |
| a message written mid-turn | queued by claude, run as its own turn after the current one |
| plugin hooks via `--plugin-dir` | ALL fire: SessionStart (at boot, before any input), UserPromptSubmit, Stop, SessionEnd |
| UserPromptSubmit `additionalContext` | reaches the model |
| MCP servers (`--mcp-config`, the hub shim) | yes, cotal tools work |
| `--session-id` / `--resume` | yes; transcript written to `~/.claude/projects/…` as usual |
| `~/.claude/sessions/<pid>.json` index | yes (`entrypoint: sdk-cli`, status busy/idle) — `liveSessionProcs` sees it |
| `--dangerously-load-development-channels` | accepted, no confirmation gate |
| **`claude/channel` push (the wake)** | **dropped** — the one thing paw has to replace |

So cotal's whole delivery design survives unchanged: the channel push only ever WAKES a turn; the
message bodies are injected by the UserPromptSubmit hook (and acked on handoff), presence is set by
the hooks (working on UserPromptSubmit, idle on Stop), and Stop re-requests a wake when more arrived
mid-turn. The only missing piece is "start a turn when a wake is pushed".

## Design

```
runtime (pty/tmux/cmux) ─ /bin/sh -c HEADLESS_SH … ─exec→ claude -p (stdin = FIFO, stdout = out.jsonl)
                                                             └─ cotal-shim ── hub.sock ── hub (one per space)
hub: serveClaudeSession writes notifications/claude/channel → sniffed → stream-json user turn → FIFO
```

- **Launch** (`headlessLaunch`, pure): paw's normal claude launch (cotal's args + paw's permissions,
  disallowed tools, brief, durable `--session-id`/`--resume` pin, claudeArgs, BEADS env — all
  unchanged) wrapped as `sh -c HEADLESS_SH paw-headless <dir> claude -p --input-format stream-json
  --output-format stream-json --verbose …`. The shell makes `<dir>/in` (a 0600 FIFO), rotates
  `out.jsonl` → `out.prev.jsonl`, and `exec`s claude with `0<>in 1>out.jsonl`. **No resident host
  process**: sh is replaced by claude. stdin is opened READ-WRITE so claude holds a writer itself and
  never sees EOF when the hub restarts. stderr stays on the runtime terminal. `<dir>` =
  `$PAW_HOME/spaces/<space>/headless/<name>/`. The dev-channels flag is KEPT (inert under -p) because
  `src/named.ts` uses it to tell a mesh agent from a hand-run claude for the two-writer guard. `confirm`
  is dropped (no gate). An initial prompt is refused (DM it instead).
- **Wake** (`src/hub/headless.mjs`): the hub already runs every agent's cotal MCP session
  (`serveClaudeSession`, docs/notes/hub.md). At session start it checks whether a live process reads
  that agent's FIFO (an `O_WRONLY|O_NONBLOCK` open fails with ENXIO otherwise — so a stale FIFO from an
  agent switched back to the TUI is not mistaken for a headless one) and, if so, wraps the session's
  output: every `notifications/claude/channel` line still goes to the shim (claude ignores it) AND is
  written to the FIFO as `{"type":"user","message":{"role":"user","content":"<channel source=\"cotal\" …>📨 …</channel>"}}`.
- **Queueing**: the hub tails `out.jsonl` (size poll, 500ms) for `result` lines (the turn end; key
  order is NOT stable, so candidate lines are parsed, lines >256KB skipped). A wake pushed while a
  turn it started is running is HELD and coalesced: N wakes during a turn → ONE turn after it ("📨 N
  Cotal wakes arrived while you were working"), whose UserPromptSubmit hook injects every queued body.
  A hold older than 10 min is written anyway (claude queues stdin turns itself, so a missed `result`
  costs one turn, never a deaf agent). At (re)connect the state is unknown → assumed idle (same cost).
- **Selection**: persona frontmatter `headless: true` (`readHeadless`; garbage throws). NOT a new
  `agent:` connector name: the manager keys shared MCP servers (`paw mcp`) by connector name, and
  `paw log`/`status`/web/launchd all branch on `agent:` — a flag on the claude connector keeps every
  one of those paths as-is. Switch: edit the persona, `paw restart <name>`. Default unchanged.
- **Requires hub mode** (`paw hub on`): the hub is the only process that sees the wake. The connector
  throws at launch otherwise rather than boot a deaf agent.

## paw-side, not upstream (for now)

The wake replacement needs (a) a process that sees the channel push and (b) a way into claude's stdin.
In paw both exist without new processes: the hub is already the per-space MCP host, and the runtime
command can be a self-`exec`ing shell. Upstream cotal would have to do it inside `mcp.cjs` (one node
process per agent — the thing the hub removes) or grow a host. The clean upstream shape, worth
proposing once this has run for a while: `serveClaudeSession({ …, onChannel })` — a host callback for
the push, so a host like paw's hub needn't sniff JSON-RPC — plus a claude connector option that emits
the `-p` launch. No cotal patch was needed for this version.

## What is lost (no TUI)

- **No attach.** `paw open`/`paw attach` print that the agent is headless and point at `paw log` /
  `paw dm` / `paw stop`. The tmux window (tmux runtime) shows only claude's stderr.
- **No interrupt.** There is no Esc; a runaway turn ends only with `paw stop`/`paw restart` (same
  durable pin, so context is kept). stream-json has a `control_request` interrupt — not wired.
- **No TUI-only commands** (`/model`, `/compact`, `/clear`…) — claude -p auto-compacts on its own.
- **`paw log` works unchanged** (it reads the transcript by the pinned session id); `out.jsonl` is the
  raw stream (incl. hook events) for debugging, kept for one previous run as `out.prev.jsonl`.
  It grows with the process lifetime (~transcript size); rotated at every launch.
- **Startup prompts can't be answered**, but -p has none (no trust dialog, no dev-channels gate).
- **Boot with mail waiting**: SessionStart injects pending messages as context at boot, but a turn only
  runs on the next wake — same as the TUI today (verify if it matters).

## RAM (measured, see e2e-headless; haiku, pty runtime, same prompts)

2026-10-05, claude 2.1.289, haiku, pty runtime, hub mode, isolated broker. Both agents got the same
DMs: READY, a `sleep 20` Bash turn, two DMs mid-turn (plus NOTED for `hl`). `claude+shim` is the
steady per-agent cost. Other descendants (the operator's global `~/.claude/settings.json` hooks:
npm/node/bun/git, ~200MB at boot, then a persistent bun ~18MB) are identical in both modes and
excluded.

| | headless (`hl`) | TUI (`tui`) | saved |
|---|---|---|---|
| at boot, idle, 0 turns — phys_footprint | 151 MB | 189 MB | 38 MB |
| at boot — rss | 233 MB | 279 MB | 46 MB |
| after ~4 turns — phys_footprint | 184 MB | 247 MB | **63 MB** |
| after ~4 turns — rss | 271 MB | 369 MB | **99 MB** |

An earlier run of the same script: 184 vs 251 MB footprint (67 MB). The cotal shim is 1.3 MB in
both. **Host cost: zero new processes** — `sh` execs into claude, and the wake path lives in the hub,
which hub mode already runs (84–88 MB footprint, shared by every agent in the space, headless or not).
So at 25 agents the headless saving is ~1.5 GB footprint on top of the hub's own saving. The gap
should widen with context (the TUI holds the rendered conversation; 0 → 4 turns grew it 58 MB vs
33 MB headless) — not measured at opus-size contexts. `out.jsonl` after those turns: 106 KB.

Queueing, verified from `out.prev.jsonl` of the same run: 4 `result` lines for 5 DMs — READY, the
busy turn, ONE coalesced turn that answered both mid-turn DMs (Q1+Q2), NOTED. The first run, with a
prefix-matching turn detector that never saw a `result`, also showed the 10-min valve work: the held
wake was written, claude queued it, nothing was lost.

## Not verified

tmux/cmux runtimes (pty only), PAW_AUTH meshes, `paw sleep` on a headless agent, more than one
headless agent at once, opus-size contexts, a stream-json interrupt.
