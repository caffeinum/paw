# lean harness PoC: Claude Code sessions driven by codex and grok on the cotal mesh (2026-10-05)

Index: [CLAUDE.md](../../CLAUDE.md). Background, the session-format spec and the Anthropic-auth verdict:
[lean-harness.md](lean-harness.md). Code: `lean/` (a Go module). Test tools: `lean/tools/*.ts`.

## What it is

`lean run` is one process per agent, with no TUI, no shared host and no codex app-server. It:

- loads an existing **Claude Code session** (JSONL) as its conversation, and appends its own turns
  back in Claude Code's format, so `claude --resume` still opens the session;
- drives that conversation with a **non-Anthropic model on the operator's subscription** (OAuth):
  - OpenAI: the ChatGPT-plan codex backend;
  - xAI: SuperGrok;
- talks to the world **only through cotal**. It speaks the NATS/JetStream protocol directly and
  has its own presence (idle/working). DMs and channel posts arrive as turns, and it replies through
  built-in `cotal_dm` / `cotal_send` / `cotal_roster` tools (no MCP);
- runs the tools itself: a persistent Bash, Read, Write, Edit, and a codex-format `apply_patch`.

It never uses Anthropic subscription OAuth. The legal position in lean-harness.md#auth is unchanged.

## Result

- **Both providers ran live.**
  - Each continued a copy of a real 126-message, ~120k-token fleet transcript (vibeos-landing,
    `eebc3852…`, with parallel tool calls, cotal DMs and foreign MCP calls).
  - Each ran on an isolated mesh: own nats-server, `PAW_HOME`, space `lean-test-*`, `PAW_RELEASE=dev`.
  - Each was DMed by a peer. It read a file, edited it, ran bash and DMed back.
  - Each answered a DM queued mid-turn and a `paw dm` (the reply arrived in `paw inbox`).
  - Each showed `working`→`idle` presence, `paw status` showed it as `live (unmanaged)`, and it went
    `offline` on SIGTERM.
  - Models: `gpt-6-luna` (codex backend) and `grok-build-0.1` (SuperGrok).
  - `lean/tools/e2e-lean.ts`: all checks green on the final binary.
- **The real `claude` 2.1.289 resumes both lean-written transcripts.**
  - `lean/tools/resume-check.ts` runs offline against the loopback fake API.
  - claude's rebuilt request contained the lean prompts, the tool calls (`apply_patch`, `Edit`,
    `Bash`), the results and the DMs.
  - lean's reader then saw claude's own resumed turn.
- **Cross-provider history works.**
  - grok, continuing the codex-written copy, saw `apply_patch` (flattened to text).
  - codex, continuing the grok-written copy, saw grok's `str_replace_editor` edit as an
    `apply_patch` hunk. Both described the earlier edit correctly.
- **Read parity with the verified TS reader** (`scripts/lean/session.ts`): identical message and
  block structure (roles, kinds, tool ids) on 9 real transcripts, up to 964 messages.
  - That includes a 192 MB transcript read from its last compaction boundary: **1.0 s, 31 MB max
    RSS**.
  - Tool: `lean/tools/parity.ts`.
- **RAM: ~16–19 MB footprint per agent**, plus 1.7 MB for its bash.
  - That is with a 120k-token context resident, against 184–247 MB for claude at a tiny context
    ([§ram](#ram)).

## Language: Go

The deciding fact is **one process per agent**. The earlier exploration chose TS for a *shared*
host, where node's baseline is paid once. Here it is paid per agent.

| measured (one idle process) | footprint | RSS | start → on the mesh |
|---|---|---|---|
| node 25 + `@cotal-ai/core` endpoint, nothing else (`lean/tools/node-baseline.ts`) | 62 MB | 110 MB | 212 ms (import + start) |
| **lean (Go), conversation of 120k tokens loaded, endpoint up** | **16 MB** | **24 MB** | ~100 ms |
| lean after 3 live turns | 18–19 MB | 25–30 MB | — |

- A TS harness would start at ~60 MB footprint per agent before any conversation or HTTP client.
  Go is about 4× smaller at the floor.
- The binary is 11.7 MB, with one dependency (`nats.go` 1.54.0, released 2026-09-18).
- **The cost of Go: no `@cotal-ai/core`.**
  - The open-mode wire contract was reverse-engineered by sniffing two real TS endpoints
    (`lean/tools/sniff-cotal.ts`) and reimplemented in `lean/transport/cotal.go` (~400 lines).
  - Interop was verified against real cotal: a TS `CotalEndpoint` prober, paw's mailbox ("you"),
    `paw dm`, `paw inbox` and `paw status` all see it.
  - Every cotal bump now needs a re-check, because the TS client can no longer be relied on to
    absorb protocol changes. Re-run `sniff-cotal.ts` plus `e2e-lean.ts`.
- Rust would save a few more MB but is slower to write. The per-agent cost is conversation plus
  socket buffers, so Go is already well under the noise of the bash child plus the model's context.

## Architecture: modules and interfaces

```
cmd/lean ── engine ──┬─ session.Store      (ClaudeStore: Claude Code JSONL)
                     ├─ provider.Provider  (OpenAI · XAI · Fake) ── toolmap.Mapper (Codex · Grok · Canonical)
                     ├─ engine.Mesh        (transport.Client: cotal over NATS)
                     └─ tools              (Shell, Read/Write/Edit, ApplyPatch)
auth.Source ── used by the providers (lean login / borrowed codex/opencode tokens)
```

**`conv`: the neutral model.**

- A conversation is `[]Message{Role, Blocks, Turn}`.
- Block kinds:
  - `text`;
  - `tool_call`: the canonical `Tool` plus `Input`, or `Foreign` (the original name) for a tool
    the engine doesn't have;
  - `tool_result`;
  - `reasoning`: an opaque payload tagged with the `Provider` that produced it, and replayed only
    to that provider.
- Canonical tools:

  | tool | input |
  |---|---|
  | `bash` | `{command, timeout_ms, workdir}` |
  | `read` | `{path, offset, limit}` |
  | `write` | `{path, content}` |
  | `edit` | `{path, old_string, new_string, replace_all}` |
  | `apply_patch` | `{patch}` |
  | `cotal_dm` | `{to, text}` |
  | `cotal_send` | `{channel, text}` |
  | `cotal_roster` | `{}` |

**`session.Store` (SessionLoader).**

```go
Load() ([]conv.Message, error)          // what the native harness itself would send on resume
Append(msgs ...conv.Message) error      // this harness's turns, in the native format
Compact(summary string, preTokens int) error
Meta() Meta                             // format, path, sessionId, cwd
Close() error                           // releases the single-writer lock
```

`ClaudeStore` (`session/claude.go`) is a port of `scripts/lean/session.ts`. It covers:

- the leaf walk;
- compaction boundaries and the preserved-tail splice;
- parallel tool-call trees;
- attachment bubbling;
- the API-error barrier;
- `local_command` records.

It adds:

- **A tail reader.** Files over 8 MB are scanned backwards for the last main-thread
  `compact_boundary` and parsed from there. Preserved messages are fetched by uuid. A dangling link
  falls back to a full read.
- **Claude-name mapping** for canonical tools: `Bash`, `Read`, `Edit`, `Write`,
  `mcp__cotal__cotal_dm` and so on. `apply_patch` is recorded under its own name, which claude
  replays as a historical tool call and the API accepts.
- **A single-writer lock**, `<file>.lean.lock`, holding a pid.
- **The two-writer refusal.** It refuses a transcript under the real `~/.claude/projects` whose
  session a live claude holds (`~/.claude/sessions/*.json`).

Records are written the way the earlier exploration verified (`entrypoint: sdk-cli`, one record per
API message, `last-prompt`). Compaction writes `compact_boundary` plus an `isCompactSummary` user
record.

Other formats slot in behind the same interface:

- **`CodexStore`** would map `~/.codex/sessions/…/rollout-*.jsonl` `response_item` lines (Responses-API
  items) to and from `conv`.
- **A Grok/opencode store** would map opencode's SQLite or JSON messages.

The engine does not change for either. Neither is built.

**`provider.Provider` (Backend).**

```go
Turn(ctx, Request{System, Messages []conv.Message, Tools []canonical, CacheKey}, onText) (conv.Message, error)
```

Each provider owns its wire format and composes a `toolmap.Mapper`. The shared `history()` maps the
neutral conversation through the mapper:

- A call goes out as a native tool call only if the mapper has an equivalent *and* its result is
  in the history.
- Anything else is flattened to text in place: a foreign MCP call, an unfinished call from an
  interrupted session, or an `apply_patch` sent to a family that has none.

The two providers:

- **`OpenAI`**
  - `POST chatgpt.com/backend-api/codex/responses`, Responses API, SSE.
  - Headers: `chatgpt-account-id` and `originator: paw_lean`.
  - Body: `store:false`, with `include: reasoning.encrypted_content`. Encrypted reasoning items are
    replayed with their ids stripped. `prompt_cache_key` is set to the session id.
  - Function tools, plus `apply_patch` as a **freeform custom tool with the Lark patch grammar**.
- **`XAI`**
  - `POST api.x.ai/v1/chat/completions`, SSE.
  - Indexed tool-call fragments are reassembled; results go back as `role:"tool"` messages.
  - The `x-grok-conv-id` header keeps one conversation on one prompt cache.

`Fake` runs the same mapping and decoding offline from a `FAKE: [...]` script.

**`toolmap.Mapper`: per-family tool names.**

```go
Specs(enabled) []Spec                                  // model-facing definitions (Grammar ⇒ freeform)
EncodeCall(call) (name, args string, freeform, ok bool) // history: canonical → model-facing; !ok ⇒ flatten
EncodeResult(call, result) string                       // e.g. codex's "Exit code: N\nOutput:" framing
DecodeCall(name, args) (tool string, input, error)      // model → canonical
```

**`engine`.**

- The loop: turn → calls → results, repeated, with a 50-step cap. Each message is appended to the
  store as it happens.
- **Queueing.** Mesh messages that arrive while a turn runs are coalesced into the next turn. They
  are acked only after that turn's prompt is written, so a crash redelivers them.
- **Duplicate-send guard.** An identical `cotal_dm` or `cotal_send` within one turn is refused, and
  three refusals end the turn.
- **Naive compaction.** It runs before a turn when the estimate (chars/4) passes `--compact-at`
  (default 180k). The model writes a summary with no tools; the store records a boundary plus the
  summary.
- **A turn failure is DMed back to the sender** rather than swallowed.

**`engine.Mesh` / `transport.Client` (cotal).**

```go
Inbox() <-chan *Inbound   SetStatus(string) error   DM(to, text) (Ref, error)
Send(channel, text) error Roster() []Peer           ID() string
```

**`auth.Source`.** `Token(ctx) (Token, error)`, plus `Login(home, provider)` and `Status(home)`.

## The cotal wire, as implemented (open mode, cotal 0.66.1)

| what | how |
|---|---|
| identity | `local.<actor>`. The actor is a stable random hex kept in `<state>/identity.json`; the `lifecycleUid` is fresh per process (base36, 20 random bytes) |
| presence | KV `cotal_presence_<space>`, key `local.<actor>`, value `{card:{name,kind:"agent",meta:{connector:"lean",provider,model},id,owner,actor}, lifecycleUid, status, statusSince, ts}`. Re-put every 2 s; on a clean stop the status becomes `offline` |
| roster | `WatchAll` on the presence bucket. A peer counts as live if its heartbeat is under 6 s old and it isn't offline. Names resolve to ids, and an ambiguous name is refused |
| DM out | JetStream publish to `cotal.<space>.inst.<toOwner>.<toActor>.local.<actor>`, with `Nats-Msg-Id` set |
| DM in | durable `dm_local-<actor>-<uid>` on `DM_<space>`, filter `…inst.local.<actor>.>`, explicit ack. Delivery starts after the last acked stream sequence (persisted), or "now" on first boot. The durable is deleted on a clean stop |
| channels | publish to `cotal.<space>.chat.local.<actor>.<ch>`; live read is a core subscription to `cotal.<space>.chat.*.*.<ch>` |
| message | `{id, ts, space, from:{id,name}, to \| channel, parts:[{kind:"text",text}]}` |

The engine wraps each inbound message as
`<channel source="cotal" kind="dm" from="…" from_id="…" msg_id="…">…</channel>`.

Not implemented:

- JWT/auth mode (`PAW_AUTH=1`);
- the v0.4 endpoint rails (describe/control, so `paw cotal` service calls can't reach it);
- channel history replay;
- mentions and attention modes;
- anycast;
- AG-UI events.

A lean agent is **unmanaged**: the manager doesn't spawn it, so `paw restart <name>` would try to
start a claude TUI for it.

## Tool mapping per provider

| canonical | Claude transcript | OpenAI / codex family | xAI / grok family |
|---|---|---|---|
| bash | `Bash {command, timeout}` | `shell_command {command, workdir, timeout_ms}` | `bash {command, timeout_ms}` |
| read | `Read {file_path, offset, limit}` | *(no tool)*; history shows `shell_command "nl -ba -w6 'p' \| sed -n 'a,bp'"` | `view_file {path, start_line, end_line}` |
| write | `Write {file_path, content}` | *(no tool)*; history shows `apply_patch` Add File | `create_file {path, content}` |
| edit | `Edit {file_path, old_string, new_string}` | *(no tool)*; history shows `apply_patch` Update File hunk | `str_replace_editor {path, old_str, new_str, replace_all}` |
| apply_patch | `apply_patch {patch}` | `apply_patch` **freeform** (Lark grammar) | *(no tool)*; flattened to text |
| cotal_* | `mcp__cotal__cotal_dm` … | `cotal_dm` / `cotal_send` / `cotal_roster` | same |
| foreign (MCP, Agent, ToolSearch …) | kept verbatim | flattened to text | flattened to text |

Why these names:

- **Codex.** The backend's own model catalogue (`GET /backend-api/codex/models`) declares
  `shell_type: shell_command` and `apply_patch_tool_type: freeform` for every current model. Shell
  results are framed codex-style: `Exit code: N\nOutput:`.
- **Grok.** These are the tool names of grok-cli, xAI's own harness. The SuperGrok OAuth scope is
  `grok-cli:access`.

Both families used their native tools correctly first time.

## Auth

Resolution order, per provider:

1. **lean's own device-flow login.** `lean login openai|xai` stores tokens in
   `<LEAN_HOME>/auth.json`, mode 0600. `LEAN_HOME` defaults to `$PAW_HOME/lean`, else
   `~/.paw/lean`. lean refreshes these tokens itself.
2. **A borrowed token, read-only.**
   - The sources are codex's `~/.codex/auth.json` (`auth_mode: chatgpt`) and opencode's
     `~/.local/share/opencode/auth.json` (`.xai`).
   - The token is used **only while it is still valid**, and lean **never refreshes it**. Both
     providers rotate refresh tokens, so refreshing from here would log the operator's own tool out.
   - The file is re-read on every call.
3. **Otherwise lean fails** with the exact login command.

Token values are never printed or logged. `lean auth` shows only where each token comes from and
when it expires.

Endpoints and clients (the public ones codex CLI and opencode use):

- **OpenAI:** device code at `auth.openai.com/api/accounts/deviceauth/usercode`. The operator enters
  the code at `/codex/device`; lean polls, then exchanges the code at `/oauth/token`. The client is
  codex's `app_EMoamEEZ73f0CkXaXp7hrann`.
- **xAI:** `auth.x.ai/oauth2/device/code`, then `/oauth2/token`. The client is
  `b1a00492-…`, with scope `… grok-cli:access api:access`.

What happened on this run:

- **codex:** used codex's borrowed token, valid until 2026-10-09.
- **xAI:**
  - opencode's token had expired on 2026-09-17, and its refresh token was dead (`invalid_grant`,
    seen when opencode itself tried to refresh).
  - lean printed a device code; the operator approved it; tokens were stored in
    `~/.paw/lean/auth.json`.
- `lean login openai` itself (the device flow) has **not** been exercised. Only the borrowed codex
  token was used.

## RAM

Measured with `footprint` (phys_footprint) and `ps` RSS, inside `e2e-lean.ts`:

| | footprint | RSS | context held |
|---|---|---|---|
| lean, idle at boot | 16 MB | 13–25 MB | 120k tokens loaded |
| lean after 3 live turns (codex / grok) | 18 / 19 MB | 25–30 MB | ~125k tokens |
| its bash child | 1.5–1.7 MB | 1–2.5 MB | |
| `claude -p` headless, after ~4 turns (headless.md) | 184 MB | 271 MB | tiny |
| claude TUI, after ~4 turns (headless.md) | 247 MB | 369 MB | tiny |
| claude TUI in the fleet (earlier measurements) | 234–527 MB | | real |
| node + cotal endpoint alone (the TS floor) | 62 MB | 110 MB | none |

Per agent, that is about 10× under headless claude and 13× under the TUI, at a far larger context.

## Things the live runs taught

- **Path confinement is necessary.** Both gpt-6-luna and grok-build-0.1 first reached for the
  *original* project's absolute paths from the session history: `Update File:
  /Users/aleks/Github/caffeinum/vibeos-landing/notes.txt`.
  - Those calls failed only because the file didn't exist there.
  - The file tools are now confined to `--cwd`, symlink-aware: a path outside it is an error
    result.
  - The system prompt names the working directory and says the earlier paths may not exist.
  - **The shell is not confined.** There is no sandbox.
  - A production lean agent should run in its session's own project anyway, as paw agents do. The
    problem appears when a session is continued *somewhere else*.
- **Models loop on `cotal_dm`.** grok-build-0.1 re-sent the same DM 45 times, until the step cap.
  The fix: a per-turn duplicate guard, plus a tool result that says "delivered … end the turn".
  After that, one DM per turn.
- **Prompt caching works on both subscriptions.** About 126k of 127k input tokens were cached from
  the second call on (codex `cached_tokens`, grok `cached_tokens`).

## Missing / next

- **Cotal:** auth mode, endpoint rails, history replay, mentions. Also manager integration: a
  persona `agent: lean` so `paw restart` / `start` / `launchd` start lean rather than claude.
- **Tools:**
  - Glob/Grep (the fleet greps through Bash);
  - WebFetch/Search;
  - background jobs and a Monitor equivalent;
  - images;
  - a shell sandbox;
  - mid-turn injection of queued messages (today they wait for the next turn);
  - interrupt.
- **Compaction:** no preserved tail, no mid-turn compaction. The token estimate is chars/4 rather
  than provider usage.
- **Session formats:** CodexStore and GrokStore are designed, not built. Claude attachments written
  before 2.1.280 without `rendered` text are skipped (same gap as session.ts).
- **Provider details:**
  - The OpenAI websocket transport (`prefer_websockets`) isn't used; SSE only.
  - No retry or backoff on 429/5xx; the turn fails and the failure is DMed to the sender.
  - `lean login openai` is untested live.
- **Cotal protocol drift:** the Go client has no TS to lean on. Re-run `sniff-cotal.ts` and
  `e2e-lean.ts` on every cotal bump.

## Running it

```sh
cd lean && go build -o /tmp/lean ./cmd/lean && go test ./...
/tmp/lean auth                          # where tokens would come from (no secrets)
/tmp/lean login xai                     # device flow: prints a URL + code, polls
/tmp/lean login openai

# one turn, no mesh (DMs printed) — ALWAYS on a copy, with --cwd a scratch dir
cp ~/.claude/projects/<slug>/<id>.jsonl /tmp/s.jsonl
/tmp/lean once --session /tmp/s.jsonl --cwd /tmp/work --provider openai --model gpt-6-luna "…"

# an agent on a mesh (isolated test space shown)
/tmp/lean run --session /tmp/s.jsonl --cwd /tmp/work --name codexy --space lean-test-1 \
  --server nats://127.0.0.1:<port> --provider openai --model gpt-6-luna

# checks (from the repo root)
node lean/tools/parity.ts /tmp/lean <transcripts…>              # read parity vs scripts/lean/session.ts
node lean/tools/resume-check.ts /tmp/lean <lean-written copy> <markers…>   # real claude --resume, offline
LEAN_BIN=/tmp/lean LEAN_SESSION=<transcript> LEAN_AGENTS="codexy=openai:gpt-6-luna,grokky=xai:grok-build-0.1" \
PAW_HOME=$(mktemp -d) PAW_SPACE=lean-test-$$ PAW_RELEASE=dev PAW_COTAL_ROOT=$(mktemp -d) PAW_BEADS_DIR=$(mktemp -d) \
  node lean/tools/e2e-lean.ts                                   # fake:openai / fake:xai run offline
node lean/tools/sniff-cotal.ts                                  # dump the TS endpoint's wire traffic
```
