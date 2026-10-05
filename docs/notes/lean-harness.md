# lean harness: a headless Claude agent loop that speaks paw (exploration, 2026-10-05)

Index: [CLAUDE.md](../../CLAUDE.md). PoC: `scripts/lean/` (offline, no key needed). The headless
`claude -p` connector is a separate piece of work; this note doesn't cover it.

## Verdict: don't build it for the Claude fleet, for now

The engineering is feasible. Two things outside our control rule it out:

1. **Auth.** A custom harness can't use the Max subscription. It needs an API key billed per token
   ([§auth](#auth)).
2. **Cost.** At the fleet's measured usage, per-token billing comes to about **$9.6k–13.9k a month**
   ([§cost](#cost)). Almost all of that is cache reads on large contexts (median ~250k tokens per
   call). A leaner harness would cut it by about 4% at most, because it only changes the fixed prefix.

The RAM win is real: about **5–10 MB per agent instead of 150–500 MB** ([§ram](#ram)). But there are
ways to get most of it without leaving the official binary:

- the headless `claude -p` connector, so RAM is held only while a turn runs;
- `paw sleep` for idle agents;
- a cap on how many agents run at once.

Spend is heavily skewed. Three agents make up half of it, and 15 of the 41 agents active this week
cost under $10 each. So the agents that would be cheap to bill per token are the same ones that sit
idle, and sleeping them already frees their RAM at no cost.

**When to revisit:** any one of these would change the answer.

- Anthropic allows subscription use from a custom loop, or publishes the Agent SDK's in-process engine.
- The operator decides to run a long tail of light agents on an API key (about $300–650/month for
  15–20 agents at this week's rate) and wants them warm all the time.
- We want non-Anthropic models in the fleet.

If any of those happens: **build our own loop in TS/Node** on `@anthropic-ai/sdk` and
`@cotal-ai/core`, starting from `scripts/lean/session.ts`, which already round-trips Claude Code
transcripts. Use pi (MIT) as a reference, not as a dependency. Phases are in [§plan](#plan).

## auth

Sources were fetched on 2026-10-05.

- **Claude Code's "Legal and compliance" page**
  (https://code.claude.com/docs/en/legal-and-compliance):
  - "OAuth authentication is intended exclusively for purchasers of Claude Free, Pro, Max, Team, and
    Enterprise subscription plans and is designed to support ordinary use of Claude Code and other
    native Anthropic applications."
  - "Developers building products or services that interact with Claude's capabilities, including
    those using the Agent SDK, should use API key authentication … developers may not collect, store,
    or intermediate Claude.ai credentials or session tokens."
  - The February 2026 wording, quoted by The Register on 2026-02-20, was blunter: "Using OAuth tokens
    obtained through Claude Free, Pro, or Max accounts in any other product, tool, or service —
    including the Agent SDK — is not permitted and constitutes a violation of the Consumer Terms of
    Service."
- **Consumer Terms** (https://www.anthropic.com/legal/consumer-terms) prohibit this: "Except when you
  are accessing our Services via an Anthropic API Key or where we otherwise explicitly permit it, to
  access the Services through automated or non-human means, whether through a bot, script, or
  otherwise."
- **Enforcement:**
  - 2026-01-09: server-side safeguards against "spoofing the Claude Code harness". Accounts were
    banned (Thariq Shihipar, https://x.com/trq212/status/2009689809875591565).
  - 2026-04-04: subscription limits stopped covering third-party harnesses, starting with OpenClaw
    (TechCrunch).
  - 2026-03-19: opencode removed Anthropic OAuth and its Claude system prompt after a legal request
    (anomalyco/opencode PR #18186).
- **What a subscription does cover:**
  - The unmodified `claude` binary, including `claude -p`.
  - Personal Agent SDK use. The current page says "Advertised usage limits for Pro and Max plans
    assume ordinary, individual usage of Claude Code and the Agent SDK".
  - paw today is the unmodified binary, which is fine. A lean loop is not.
- **Licence:**
  - Neither `@anthropic-ai/claude-code` nor `@anthropic-ai/claude-agent-sdk` is open source. Their
    LICENSE.md reads "© Anthropic PBC. All rights reserved. Use is subject to the Legal Agreements…".
  - **We may not copy Claude Code's system prompt or tool descriptions.** A lean harness writes its own.
- **The PoC follows these rules:**
  - `scripts/lean/continue.ts` reads `ANTHROPIC_API_KEY` only, and refuses to run without it.
  - It never touches the Keychain or `~/.claude/.credentials.json`.
  - The round-trip test uses a loopback fake API, so it needs neither a key nor a subscription.

## cost

**Data:** fleet usage, measured from transcripts.

- Fleet = sessions that are a persona's `resume:` pin. 126 pins, 41 active in the last 7 days.
  Subagent transcripts are counted against their parent.
- Each API response is counted once, deduplicated by (message.id, requestId). Claude Code writes one
  record per content block and repeats the usage on each.
- Reproduce with `node scripts/lean/fleet-usage.ts --days 7` (read-only). It holds the price table
  and the tool counts.

| window | calls | cache read | cache write 1h / 5m | output | uncached in |
|---|---|---|---|---|---|
| 7 d | 21,983 (11,131 in subagents) | 7.22 B | 93.8 M / 78.3 M | 7.74 M | 48 k |
| 30 d | 54,774 | 16.15 B | 259.9 M / 166.3 M | 21.8 M | 293 k |

**Context per call** (7 days, input + cache read + cache write):

- 0–200k: 40% of calls.
- 200–400k: 28%.
- over 400k: 32%, up to the 1M window.
- Median: about 250k.

The fleet mostly runs Opus 5.5 / Opus 5 / Opus 4.8 at 1M context, with some Sonnet 5 and Fable 5.1.

**Prices:** list prices per MTok, from https://platform.claude.com/docs/en/about-claude/pricing,
fetched 2026-10-05.

| model | input | 5m write | 1h write | cache read | output |
|---|---|---|---|---|---|
| Opus 5.5 | $4 | $5 | $8 | $0.20 | $20 |
| Opus 5 / 4.8 | $5 | $6.25 | $10 | $0.50 | $25 |
| Sonnet 5 / 5.5 | $2 | $2.50 | $4 | $0.20 | $10 |
| Haiku 4.5 | $1 | $1.25 | $2 | $0.10 | $5 |
| Fable 5.1 | $10 | $12.50 | $20 | $0.25 | $50 |

There is no surcharge above 200k for 4.6+ models. Batch pricing is 50% off, but it doesn't suit
interactive agents.

**API-equivalent cost of the fleet:**

| | 7-day bill | per 30 days |
|---|---|---|
| actual model mix, last 7 d | **$3,229** | **≈ $13.9k** |
| actual model mix, last 30 d (measured) | — | **$9.6k** |
| same tokens, all Opus 5.5 | — | ≈ $11.7k |
| same tokens, all Sonnet 5 | ≈ $2.1k | ≈ $9.0k |
| same tokens, all Haiku 4.5 | ≈ $1.05k | ≈ $4.5k (its 200k window wouldn't hold these contexts anyway) |

- **Split** (7 days): cache reads $1,879 (58%), cache writes $1,199 (37%), output $159 (5%).
- **Skew** (7 days, per agent including its subagents):
  - The top 3 agents are 51% of spend; the top agent alone is $932.
  - 15 agents cost under $10 each, $72 in total.
  - 20 agents cost under $25, $148 in total.
  - 26 agents cost under $50, $367 in total.
- **What a lean harness would save:**
  - Claude Code's fixed prefix in a clean HOME is about 17k tokens: a 9 KB system prompt plus 24 tool
    schemas at 58 KB, captured below. The fleet's real prefix is larger (MCP listings, CLAUDE.md,
    skills).
  - A 3–5k-token lean prefix saves about 12–15k tokens × 22k calls a week ≈ 0.3 B of 7.2 B cache
    reads, roughly 4%, or about $60–75 a week.
  - The real cost levers are context size (compact earlier) and call count. Those are behaviour, not
    harness.

**Verdict on cost.** Moving the fleet to per-token billing costs about $10k a month. The operator's
call, but it isn't close.

## ram

**Measured.** `node --expose-gc scripts/lean/ram-probe.ts <24 most recently active fleet transcripts>`
keeps each agent's active conversation resident in one process. That is the post-compaction message
list sent every turn.

- **+103 MB heap for 24 sessions, 4.3 MB per agent.** Active context averages 2.1 MB of JSON.
- Node's own baseline is about 70 MB RSS.
- The probe's RSS peaked at 1.38 GB, because it `readFileSync`s whole transcripts (one is 380 MB) and
  V8 doesn't return that memory. A real host must **tail-read**: scan back to the last
  `compact_boundary`, then stream forward.

**Estimate per agent in a one-process host:**

| item | per agent | notes |
|---|---|---|
| active conversation | 2–8 MB | grows with context, 1M tokens ≈ 4 MB text |
| cotal endpoint (NATS conn + subs) | ~1 MB | one `CotalEndpoint` each |
| persistent shell | 2–4 MB | a real `bash` child, separate process |
| MCP servers | 0 if shared, 30–100 MB if per agent | tracepaper / yab / slack are separate processes, so pool them |

So 24 agents ≈ 70 MB + 24 × ~8 MB ≈ **0.3 GB** plus shared MCP processes.

**Compared with today:**

- `ps` snapshot right now: 19 `claude` processes, 2.97 GB RSS. They average 156 MB (min 113, max 468),
  and RSS undercounts macOS-compressed pages.
- Earlier per-agent measurements were 234–527 MB.
- A Rust host would save about 50 MB of baseline, nothing per agent. Conversation state dominates and
  it's small either way.

## session format

Read from ~450 transcripts written in the last 7 days by claude 2.1.111 … 2.1.289. **Verified** means
the real `claude` 2.1.289 was run against it by `scripts/lean/roundtrip.ts` and its `--resume` request
was captured.

### Location

- **[verified]** The file is `$CLAUDE_CONFIG_DIR/projects/<slug>/<sessionId>.jsonl`, where
  `CLAUDE_CONFIG_DIR` defaults to `~/.claude` and `<slug>` is the absolute cwd with **every
  non-alphanumeric character turned into `-`** (`/Users/aleks/.foo` → `-Users-aleks--foo`).
- **[verified]** `claude --resume <id>` finds the file through the cwd's slug.
- **[verified]** Nothing else has to be registered: no sessions index, no `~/.claude.json` entry.

### Record classes

Every line is a JSON object with a `type`.

- **Chain records** carry `uuid`, `parentUuid`, `isSidechain`, `sessionId`, `cwd`, `version`,
  `gitBranch`, `timestamp`, `userType` and `entrypoint`. There are four types:
  - `user`: `message: {role, content: string | blocks}`, `promptId`, plus `toolUseResult` and
    `sourceToolAssistantUUID` on tool results.
  - `assistant`: `message` is the raw API response (id, model, content, stop_reason, usage …), plus
    `requestId`.
  - `attachment`: `attachment: {type, …}`, plus `rendered: [{content}]` on newer versions.
  - `system`: has a `subtype`.
- **Metadata records** have no uuid and don't affect what the model sees:
  - `last-prompt {leafUuid, lastPrompt}`
  - `mode`, `permission-mode`, `ai-title`, `custom-title`, `agent-name`
  - `cost-state`, `file-history-snapshot/-delta`, `queue-operation`
  - `pr-link`, `atis-latch`, `worktree-state`, `relocated`, `frame-link`, `fork-context-ref`, …

### What a writer must emit for claude to load it cleanly

**[verified]** The lean PoC writes the records below and `claude --resume` loads them. It then
replays them to the model and appends its own turn, chained onto the lean leaf.

- `user` (prompt): the chain envelope + `promptId` + `message:{role:"user",content}`.
- `assistant`: the envelope + `requestId` + the whole API response as `message`.
  - **One record per API message is accepted.** claude itself writes one record per content block;
    either loads.
- `user` (tool results): the envelope + `message.content: [tool_result…]` + `toolUseResult` +
  `sourceToolAssistantUUID`.
- `last-prompt {leafUuid}`: the resume picker uses it. `-p --resume <id>` doesn't need it.
- **Envelope values:**
  - `version` is stamped with the last claude version seen in the file.
  - `entrypoint: "sdk-cli"`; `userType: "external"`.
  - `cwd`/`sessionId` are copied from the session.
  - `uuid` is a fresh v4; `parentUuid` is the previous leaf.

### How claude rebuilds the model's context

**[verified]**: implemented in `session.ts`, and identical turn-by-turn on 4 of 5 real transcripts.

1. **Leaf.** It continues from the last main-thread chain record in file order. Both sides agreed on
   it every time.
2. **Walk** parentUuid back to `null`.
   - A `compact_boundary` system record has `parentUuid: null` (the old link is kept in
     `logicalParentUuid`), so the walk stops there.
   - The model sees the `isCompactSummary` user message, then what follows.
3. **Partial compaction.** `compactMetadata.preservedMessages.uuids` are spliced in **right after the
   summary**. The summary is `anchorUuid`.
4. **Parallel tool calls make the file a tree.**
   - Each tool_use is its own assistant record with the same `message.id`, chained A ← B ← C.
   - Each result is a child of *its own* tool_use record, in completion order.
   - The walk sees one branch. claude reassembles the whole message: every same-id record, then every
     result whose parent is one of them, **in file order**.
5. **Assistant records with the same `message.id` are one API message.**
6. **Synthetic assistant turns are replayed.** These are `model: "<synthetic>"`, e.g. "No response
   requested."
7. **API-error stand-ins are not replayed.** These are `isApiErrorMessage: true`. They still act as a
   barrier in the next rule.
8. **Attachments:**
   - Their `rendered[].content` is sent as text.
   - They **bubble up** past prompt and command records until they reach a record carrying a
     `tool_result`, a dropped API-error turn, or the start of the user run.
   - Right behind a `tool_result` block they are **appended into its content** (`"\n\n"` + the text).
     Otherwise they become text blocks at that spot.
9. **Local commands.** `system` records with `subtype: "local_command"` (`/model`, `/compact` output)
   are sent as user text. All other `system` subtypes are not sent (`turn_duration`,
   `stop_hook_summary`, `api_error`, …).
10. **Thinking blocks** are stored as `"thinking": ""` plus a `signature` (display omitted).
    - claude **drops them when resuming with a different model** than the one that signed them.
    - The lean loop does the same (`forModel` in continue.ts).
    - Requests carry `context_management: clear_thinking_20251015`.

### Attachments

The only real parity gap.

- **claude ≥ 2.1.280** stores `rendered` on every model-visible attachment type. That covers
  environment, instructions, date, model, skill_listing, deferred_tools_delta, mcp_instructions_delta,
  hook_additional_context, total_tokens_reminder, file, queued_command and others. A 7-day survey
  found 0 records of those types without it.
- Types with no rendering are things like hook_success, prompt_snapshot, deferred_tools_record and
  credential_org. They carry no model text.
- **Older records** (2.1.1xx–2.1.27x) often have no `rendered`. claude re-renders them from the
  payload with internal per-type code. The lean reader can't do that without reimplementing ~30
  renderers.
- The one transcript that diverged (`global`) has pre-2.1.280 attachments in its active segment:
  re-read `file` attachments after a `/compact`.
- **Fix if we build:** render the handful of types that matter (`file`, the `*_delta` listings), or
  accept the divergence. It only affects content from before ~2026-09-25.
- **claude also re-renders some attachments from the current environment**, even when `rendered`
  exists (the deferred-tools listing, the attribution reminder). So **switching one session between
  claude and the lean harness rewrites the prompt cache**. At a 250k context on Opus 5.5 with a 1h
  write, that's about $2 per switch. Don't ping-pong.

### Elsewhere on disk

- **Sidechains:** subagents live in `<session>/subagents/agent-<id>.jsonl` (`isSidechain: true`,
  `agentId`) with `agent-<id>.meta.json {agentType, description, toolUseId, spawnDepth}`.
- **Large tool output** is offloaded to `<session>/tool-results/<id>.txt`.

### What claude actually sends

**[captured]**, `--full`, clean HOME, no MCP. The system array opens with an
`x-anthropic-billing-header: cc_version=…; cc_entrypoint=…` block, then the prompt text. Then:

- `tools`: 24 (Agent, Bash, Cron*, Edit, Enter/ExitWorktree, ListAgents, NotebookEdit, Read,
  ReportFindings, ScheduleWakeup, SendMessage, Skill, Task*, WebFetch, WebSearch, Workflow, Write).
- `thinking: {enabled, budget 31999, display: omitted}`, `max_tokens: 32000`.
- `metadata.user_id` = {device_id, account_uuid, session_id}.

Under `--bare`, claude uses a 3-tool "Claude Agent SDK" prompt and **replays no attachments at all**.
So parity is only meaningful against `--full`.

### Rules that carry over unchanged

- **One writer per transcript.** The two-writer guard applies to a lean host exactly as it does to a
  TUI. A takeover means stopping the lean agent, then `claude --resume`.
- **Never append to a live agent's file from outside its owner.**

## tools

**What the fleet actually uses.** 30 days, fleet sessions plus their subagents, tool_use blocks:

| tool | calls | lean-harness cost |
|---|---|---|
| Bash | 37,897 (~70%) | persistent shell + timeouts; "background" must outlive turns, as Monitor does |
| cotal MCP | 5,727 | in-process: call `CotalEndpoint` directly, no MCP |
| Read / Edit / Write | 1,999 / 1,989 / 1,442 | small; Edit's exact-match semantics must match what the model expects |
| SendMessage / Agent | 1,291 / 878 | in-process sidechains writing `subagents/agent-*.jsonl` |
| ToolSearch | 525 | deferred tool loading, only needed if the tool list is large |
| WebFetch / WebSearch | 470 / 274 | API server tools (`web_search`, `web_fetch`) cover them |
| Monitor | 285 | the brief tells agents to use it; needs a host-level watcher that injects events |
| MCP: 2027-evals / slack / tracepaper / chrome | 114 / 45 / 40 / 25 | a shared MCP client pool (stdio + http) |
| TaskStop, Skill, StructuredOutput, ScheduleWakeup, Artifact, CronCreate, ListAgents, Workflow | 89 … 10 | long tail; Skill = list + read SKILL.md |
| **Grep / Glob / TodoWrite** | **0** | the fleet greps through Bash, and doesn't use todos |

Hooks: the fleet's hooks are cmux/orca/dream glue, and none is needed for a headless agent. Plan mode
and AskUserQuestion are already disabled by paw.

## prior art

| project | lang | licence | many sessions / process | CC JSONL | fit |
|---|---|---|---|---|---|
| pi (earendil-works/pi, ex badlogic/pi-mono) | TS (Node/Bun) | MIT | yes, `createAgentSession()` | no; own tree-JSONL, swappable `SessionManager` | **best reference**: small, embeddable; lacks WebFetch/Task/todo |
| own loop on `@anthropic-ai/sdk` | TS | MIT (SDK) | yes | yes (`scripts/lean/session.ts`) | **recommended if built**; the JSONL layer is the hard part and it's done |
| opencode `serve` | TS on Bun | MIT | yes (HTTP server) | import only (3rd party) | heavy Bun runtime; Anthropic OAuth removed under legal request |
| goose (`goosed`) | Rust | Apache-2.0 | yes | no (SQLite) | lean, but MCP-extension tool model and not Node |
| codex `app-server` | Rust | Apache-2.0 | yes | no | OpenAI wire API, no Anthropic caching; architecture reference only |
| crush | Go | FSL-1.1-MIT | per project | no | source-available non-compete licence, avoid |
| claw-code | Rust | MIT, murky provenance | no | no | not production, leak-era provenance, avoid |
| Claude Agent SDK | spawns the CLI | proprietary | no (one CLI per session) | yes (it is CC) | no RAM win; `sdk.d.ts` confirms `spawnClaudeCodeProcess` |
| hermes-claude-session-bridge, claude-code-log, ccusage | Python / Rust | MIT | — | **write** / read / read | format cross-checks only |

None of them reads or writes Claude Code's JSONL natively, so the format layer is ours whichever loop
we pick.

## language

**TS on Node.** Everything we'd embed is TS:

- `@cotal-ai/core` (NATS, presence, DMs, channels)
- `@modelcontextprotocol/sdk`
- `@anthropic-ai/sdk`
- paw itself

paw's daemons are already node+tsx (node-pty, `node:sqlite`). Rust would save about 50 MB of baseline
and nothing per agent, since conversation state is a few MB in either language. It would also cost us
the cotal client. Go has no upside here.

## what we'd lose

Compared with real Claude Code:

- **Prompt and behaviour parity.**
  - We can't copy CC's system prompt or tool descriptions (licence).
  - The models are tuned against those exact tools: Read's numbered lines, Edit's unique-match rule,
    Bash's persistent cwd and env.
  - Our own prompts would behave close, but not identically.
- **Updates.** Claude Code ships almost daily (2.1.111 → 2.1.289 inside this 30-day window). Each
  release brings new tools (Monitor, Workflow, ScheduleWakeup, Artifact), new attachment kinds and
  fixes. A lean harness freezes the feature set, and the JSONL format can drift under it. A parity
  check against the real binary (`roundtrip.ts`) would have to run on every claude bump.
- **Ecosystem.** These would all need reimplementing or dropping:
  - skills/plugins/hooks
  - ToolSearch/deferred tools
  - auto-memory
  - claude.ai connectors
  - `/model` and effort controls
  - compaction quality (the API offers server-side compaction; ours would write
    `compact_boundary` + `isCompactSummary` so claude can still resume)
- **The TUI.** `paw attach` has nothing to attach to. A human takes over with
  `paw stop` → `claude --resume <id>`, which the format work supports.
- **Things we keep:** cotal-native presence and DMs (no MCP shim, no channel wake gap), and an
  API-key loop that runs anywhere.

## plan

Only if one of the revisit triggers fires. Each phase is gated on an isolated-space e2e
(`PAW_HOME=$(mktemp -d) PAW_SPACE=test-$$`) plus `roundtrip.ts --full` read parity on copies of fleet
transcripts.

0. **Done:** format spec (this note), and an interop proof in `scripts/lean/`.
1. **Host skeleton: `paw lean` daemon.**
   - One node process holding N agents.
   - Tail-reading loader; per-session two-writer lock.
   - `CotalEndpoint` per agent: presence, DMs and channels in, `cotal_dm`/`cotal_send` as in-process
     tools.
   - Bash (a persistent `bash` child with a sentinel protocol, timeouts), Read/Write/Edit.
   - Prompt caching: a 1h breakpoint on system + tools, a rolling one on the last message.
   - API key only; a per-agent token budget with loud refusal.
   - Gate: an agent answers a DM, and `claude --resume` takes over cleanly.
2. **Breadth.**
   - WebSearch/WebFetch via API server tools.
   - Agent/SendMessage as in-process sidechains (`subagents/agent-*.jsonl` + meta).
   - A Monitor equivalent: a background job whose events are queued as user messages.
   - Compaction writing `compact_boundary` + summary + `preservedMessages`.
3. **Context.** CLAUDE.md + memory loading (rendered as `instructions` attachments so claude replays
   them byte-for-byte), skills listing + Skill, a shared MCP client pool (stdio processes reused across
   agents, http direct).
4. **Fleet integration.**
   - A persona `agent: lean` pin, routed through the manager like codex/opencode, or hosted by paw
     directly.
   - `paw status` rows; spend telemetry from `usage`.

Hooks are skipped unless something needs one.

## running the PoC

Everything works on **copies**. No live transcript is ever appended to.

```sh
# offline round trip (no key, no subscription use): copy → claude --resume → lean turn → claude
# --resume → lean reads back. Uses a throwaway HOME/CLAUDE_CONFIG_DIR and a loopback fake API.
node scripts/lean/roundtrip.ts --full ~/.claude/projects/<slug>/<session>.jsonl

# real API, one turn, on a COPY (needs a per-token API key; never subscription OAuth)
mkdir -p /tmp/lean && cp ~/.claude/projects/<slug>/<session>.jsonl /tmp/lean/s.jsonl
ANTHROPIC_API_KEY=sk-ant-… node scripts/lean/continue.ts /tmp/lean/s.jsonl "what's next?" --model claude-haiku-4-5

# RAM of N resident conversations in one process
node --expose-gc scripts/lean/ram-probe.ts <transcript.jsonl>…
```

**Results on 2026-10-05** (claude 2.1.289, `--full`): every run printed `INTEROP OK`. That means:

- claude's `--resume` request contained the lean prompt, tool_use, tool_result and final text;
- claude's next prompt record chained onto the lean leaf;
- the lean reader saw claude's turn.

Read parity per transcript:

| transcript | records | turns | read parity |
|---|---|---|---|
| short sdk session | — | 4 | exact |
| compacted ×2 with preserved segment | 12.7k | 250 | exact |
| vibeos-landing (parallel tool calls, synthetic turn) | — | 260 | exact |
| queue (API-error barrier, `/model` local commands) | — | 1,334 | exact |
| global (pre-2.1.280 `file` attachments) | — | 601 vs 602 | diverges at turn 2, same tool_use ids |

Not exercised: the interactive TUI picker. It needs a login; `-p --resume` uses the same loader.
