# paw sessions, paw log, transcript parsing

Moved verbatim from CLAUDE.md (2026-10-02 split). Index: [CLAUDE.md](../../CLAUDE.md)

## sessions and log

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
