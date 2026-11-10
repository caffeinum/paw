# paw chat

Moved verbatim from CLAUDE.md (2026-10-02 split). Index: [CLAUDE.md](../../CLAUDE.md)

## src/chat.ts

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
  round-trip time. **Awaiting is tracked PER SENT MESSAGE** (`src/chat-awaiting.ts` `AwaitTracker`,
  2026-10-06): a single slot was overwritten by a 2nd line sent mid-turn, so the reply to line 1 was
  timed from line 2 and line 2's later turn printed a bare `• x working` — it looked lost when it was
  only queued. Now a send to an agent whose roster presence is already `working` prints `⏳ queued —
  <agent> is mid-turn`; "picked it up" fires only on a TRANSITION into `working` (an activity update
  inside the turn that was running when you sent claims nothing) and covers every unpicked message sent
  before it (`picked up your N messages`); a reply answers the message its `replyTo` names when that is
  one of ours, else the OLDEST pending one, timed from that message's send, then `⏳ still waiting for
  <agent> on N more message(s)` if any remain. A queued line folded into the CURRENT turn gets no
  receipt (paw can't see that) — just its reply. Sent lines aren't re-echoed
  (readline shows the typed line); redelivered DMs get an ` (Nh ago)` age tag. Registers `chat`.
  **`--fresh` is the birth verb** (the former `paw create`, folded in 2026-06-30): `paw chat --fresh
  [folder]` mints a BRAND-NEW agent then drops into the REPL. The folder defaults to `.` (the current
  directory, like `paw chat <folder>`/`paw open`/the former `paw create`), and carries the load-bearing
  fail-loud-if-exists guard (`freshTarget` →
  `lookupFolderName` throws if an agent already exists for the folder — resume by dropping the flag, or
  `paw rm` then `--fresh` to reset; the guard that stopped `paw create evals` re-booting a stale session).
  There is no standalone `create` command anymore: bare `paw create` fail-louds with a redirect (bin).

## waiting feedback

- **`paw chat` says what it is waiting for** — resolving a target can take tens of seconds (a cold
  claude, or an agent already `starting`) and the terminal printed NOTHING for the whole time: no
  banner, no hint. "Why does it take so long to load" is two complaints, and the SILENCE is the half
  paw controls — a wait you can see is a wait, a blank screen is a hang (and a hang is what makes an
  operator Ctrl-C, which is what left the stuck lock above). Now prints `connecting to <name>…` before
  the wait, plus `cold start — this can take up to Ns` when it actually spawned one. Written straight
  to stdout because the readline that owns `emit` isn't up yet.
- **Startup runs concurrently (`src/chat-startup.ts`, 2026-10-28).** ensure() runs beside the human
  inbox + chat endpoint: ensure's `onMeshUp` starts the inbox → endpoint chain. Any failure releases
  what the others acquired (endpoint stopped, the remote inbox durables retired) and throws the first
  failure in startup order (ensure's first — it names the broker fault). The startup control resolves
  only `CHAT_STARTUP_COMMANDS` (ps/spawn/inspect/despawn — `check:chat` greps addressing.ts's
  `ctl.<op>` calls against it). Measured then: remote team2027 2.63s → 1.84s, local 0.73s → 0.65s —
  and that was still the time to a PROMPT, which the instant UI below took off the critical path.

## instant UI

"It's still slow — I want to be able to type right after it. The UI should show instantly, maybe with
loaders everywhere" (operator, 2026-10-28, on a laggy wifi with 200–800ms RTT spikes). So the network is
no longer between `paw chat` and a prompt that takes keys. Three moments, in a terminal:

1. **First frame (~25ms bun / ~80ms node from process start)** — `bin/paw.ts`'s fast path loads the
   core-free `src/chat-preshell.ts` BEFORE @cotal-ai/core: it lexes the target from argv (no
   validation), paints the banner + `you → <label> ◌>` through the same pure `renderBanner`
   (`src/chat-banner.ts`) chat uses, and puts the tty in raw mode — keys typed now wait in the kernel
   (not cooked-echoed, not lost) until readline reads them. Bracketed paste is switched on right
   after raw mode, before the frame: a paste landing before chat.ts has loaded still arrives marked (one
   `[Pasted text #1]`, never N messages or a pasted `!…` line run as a command); chat.ts's stdin
   wrapper splits a chunk after the paste's end marker, so keys the kernel hands over in the same
   chunk land after the paste is staged. `--space=X` is lexed like `--space X`. A frame that would not
   fit on screen (banner + prompt ≥ rows) is ONE line (`🐾 paw chat ◌ loading`) — a taller one's top
   would scroll out of erase's reach and strand a copy in the scrollback. A failure before chat's own
   banner (bad argv, unknown name) erases the frame first (`eraseFrame`, idempotent, also called from
   bin/paw.ts's failure handler). Ctrl-C during the ~200ms import is held like any key; chat.ts quits
   on it once loaded. The terminal restore is ONE idempotent `restoreTerminal` armed BEFORE raw mode,
   on `exit` and on SIGINT/SIGTERM/SIGHUP (a signal chat.ts doesn't listen for yet: frame erased,
   paste off, cooked mode, then die of the same signal). Raw goes on before paste, so a Ctrl-C can no
   longer SIGINT the process between "paste on" and its undo; one typed before the raw switch (~60ms
   node) is the kernel's SIGINT on a terminal paw never touched — `check:chat-tty` 5 asserts "paste
   switched on ⇒ switched off", not an unconditional `\e[?2004l`.
   `PAW_CHAT_PRESHELL=0` skips it.
2. **Readline live (~250ms, the core import floor)** — chat.ts resolves a READ-ONLY target from the
   registry (an unknown/ambiguous name still fails loud here, before any network; the pre-shell frame
   is erased first), adopts the frame (erase + repaint in one write), creates readline and prompts.
   Typed-ahead keys echo now.
3. **Ready (connect + wake, seconds on a remote space)** — `boot()` runs behind the prompt:
   `concurrentStartup` → mutating target resolution (`--fresh`/`--name`/`--agent`/a cloning URL still
   resolve here, after ensure, as before) → wake gate → `waitForPeerId` → `ready`.

**Is the agent there? Files first, then the roster** (operator, 2026-11-04: "the instant load first paints
the prompt and then checks if the agent exists, but if the agent doesn't exist the prompt is real bad").
Before painting, the pre-shell asks the FILES (`src/chat-lookup.ts` `checkChatTarget`, core-free,
measured ~0.15–0.4ms in a real run, PAW_CHAT_TIMING `preshell` mark carries `lookup` + `lookupMs`): a
name with a persona `cwd:` here whose folder exists (or an unmigrated folders.json/agents.json entry) →
`known` → the normal `you → name ◌>` frame. A valid bare/`@` name registered nowhere here → `unknown`:
the frame says `◌ looking for @name on <space>…` in the status row AND the prompt (keys still held and
queued). Folders, `.`, URLs, `#channel`, `--all`, `--fresh/--name/--agent` → painted as before. chat.ts
keeps its own verdict (`lookup = "pending"` for a non-mutating, interactive bare name with no folder —
pipe mode is unchanged) and settles it on the live roster in `boot()` (`settleLookup`): roster read and
the name on it (a peer hosted on another machine — the team2027 case) → `found`, normal prompt, queued
lines replay to it; roster read and no such name → `absent`; roster never read in 5s, or boot failed →
`unreachable` — never a guessed "not found". For `absent`/`unreachable` the queued lines are refused at
replay exactly like any lost target (first single line back in the input, the rest kept and printed on
quit), THEN the chooser opens (`src/chat-chooser.ts`) above the prompt:
`✕ no agent @x in <space> — did you mean:` + suggestions (`suggestNames`: same-modulo-punctuation,
prefix, substring, OSA distance ≤1–2, typo'd prefix; live roster + local registry; `noAgentMessage` uses
the same helper) + `open @x in <other space>` (another local space's persona, or a peer of that name in its
`peers.json` ledger — "seen on its mesh") + `show all conversations` + `quit`; the unreachable form offers
`retry` (re-settles, or re-runs boot after a failed one) + `quit`. Keys: ↑/↓ + Enter, 1–9, Esc/Ctrl-C
quit; any other key closes it and reaches the input (so `@other`, `/who`, editing the kept line all work).
It owns its keys via stdin's emit wrapper (readline never sees them), is erased/redrawn around every
printed line like the picker (row count via `paintedRows`, so wrapped rows erase whole), and blocks the
banner's in-place repaint while open. A switch goes through the ordinary `@name` path; "show all" drops
the target in-process; another space is a new `paw chat @x --space <s>` exec'd after this one's clean
shutdown (one REPL = one space's endpoint). Nothing is ever created (`--fresh` is named as text only).
The agent coming up later closes the chooser (the existing "is on the mesh now" path).
`check:chat` (lookup/suggest/elsewhere/chooser keys) + `check:chat-tty` cases 11–12.

**Loaders, never guesses.** Each banner field is a `Slot` (`src/chat-boot.ts`): loading = dim `◌`,
ok = the value, err = red `✕ why`. The machine (`on …`) waits for the presence view's FIRST read on
every space; the footer's peer status is `<name> ◌` until then — `peerStatusTag` never says `offline`
from a roster that was never read. The footer's left label is `bootLabel` (`◌ starting mesh 2s`,
`◌ opening inbox`, `◌ connecting`, `◌ waking <n>`, `◌ waiting for <n>`, `✕ not connected —
/reconnect · /quit`). The banner is a LIVE history entry: repainted where it stands while it is the
last thing painted (`canRepaintInPlace`: tty, chat view, no picker/paste, no resize since, fits on
screen); otherwise each change is ONE dim delta line (`  status: reusing live agent`) — including a
field that resolved to NOTHING (`on: no machine known`, `model: no reading here`), or its `◌` would
read as loading forever — marked `bannerDelta`, which a ←/→ redraw skips (the repainted banner says it
already). Repaints are
coalesced (one `setImmediate` flush) and held while a paste is arriving. `PAW_CHAT_TIMING=<file>`
writes JSONL marks (`preshell chat prompt meshUp inbox roster endpoint agent ready settled`).

**Lines typed before ready** (`lineNeedsMesh`): `/imgs /noimg /paste /nopaste /help /quit /exit quit
exit /conn /reconnect` run at once; everything else (plain, `@…`, `#…`, `!…`, other `/cmd`) is
queued (`DeferredQueue`) WITH the attachments/pastes staged for it, said as `◌ queued — sends when
connected`, counted in the prompt badge + footer. On ready they replay in typed order through the SAME
`handleLine`, so `@bob x` then a plain line sends both to bob. Replay takes ONE line at a time
(`DeferredQueue.shift`) until the queue is empty, and while it runs (`replaying`) every line but a quit
joins the queue behind it — a replayed line can wait seconds (presence, a respawn, a `!cmd`), and a
line typed then must neither jump ahead nor take its attachments. The replayed line's attachments sit
in `pending`/`pastes`; anything staged meanwhile goes to `liveStage` (`stage()`), merged back after.
Rules that keep a queued line from going somewhere it wasn't typed for:
- a backlog/early DM never retargets while anything is queued or replaying (`shouldFollowDm` `holding`);
- a target that can't be reached sets `targetLost`; the plain-line branch is now `else if (curName)` —
  it REFUSES (`✕ not sent to <n>: <why> — text kept (↑ to recall)`; a live line is put back in the
  buffer) instead of ever falling through to `sendPost(room)`. Broadcasts stay explicit. A REPLAYED
  refusal goes back into the input (attachments still staged) when the input is empty and the line is
  one line; otherwise it is kept whole (pastes + image lines composed in) in `keptUnsent` and printed
  on quit — never "↑ to recall" for a line readline's history doesn't hold. The target coming up later
  clears it; `@other` recovers;
- every other refusal keeps the line too (`keep()` in `handleLine`, `giveBack`): `@name msg` / `/dm name msg`
  / `#chan msg` to a name that isn't there (or another space) used to print "no peer" and drop `msg`
  (`warnStranded` only previewed 60 chars, and only with something staged). A live one now goes back into
  the input (`your text is back in the input — …`), a replayed one through replayDeferred as above; if the
  input is in use by then it goes to `keptUnsent` instead. `check:chat-tty` 2;
- `@name` and `/who` after ready wait (≤5s, `waitForPresenceSnapshot`) for the roster's first read,
  and never respawn an agent on the word of a roster that hasn't loaded.

**Restart consent** (`src/chat-consent.ts`): the wake gate's `restart it? [y/N]` is asked IN the REPL
(the old second readline on stdin would race the first). The draft is LEFT ALONE (stashing it split a
half-typed message in two), the prompt becomes `restart <n>? [y/N]>` — via `promptFor()`, so every
prompt redraw (a queued line, a staged paste, a hidden-DM badge) keeps showing it — and only a line
typed into an empty buffer whose first key came ≥300ms after the question, not pasted, not a replay,
not in `!` mode, AND that is `y`/`yes`/`n`/`no`/an empty Enter answers it. Any other line is an
ordinary message (never swallowed as "no") and the question stays open. Quit answers no. `--restart`
still means allow; pipes never ask.

**Listener gap.** `startEndpoint` attaches `message`, `presence`, `presence-view`, the conn state and
the own-send tap (`tapOwnSubject`) BEFORE `startResilient` — a DM landing the moment the inbox binds is
shown and acked, not redelivered a minute later. The remote half of the echo (`startEcho`, a second
narrowly-signed connection) starts after ready and is never awaited: another session's DMs in chat's
first ~0.5s are not echoed (they are in `paw history`).

**Quit during startup, and the inbox ledger.** `shutdown()` is the one way out (`/quit`, Ctrl-D,
Ctrl-C via readline's SIGINT, SIGTERM): abort boot, restore the terminal + console, print everything
unsent IN FULL (queued lines, outbox pending/failed, the draft), then wait (≤10s, saying so) for an
in-flight startup to settle — `concurrentStartup` never interrupts a step; it skips what hasn't
started, lets the rest settle, releases, and throws AbortError. Exit 1 when it never reached ready. A
second Ctrl-C leaves at once: `left chat inbox <uid> on <space> — the next paw chat retires it`. That
is true because a remote inbox is LEDGERED before it exists: `prepareHumanInbox` (local work only)
writes `$PAW_HOME/spaces/<s>/chat-inboxes/<uid>.json {pid, server, channels, startedAt}`, its release
is registered before `provision()` dials, release deletes the entry once retired, and every chat that
reaches ready runs `sweepOrphanInboxes` (dead pids only; a failure is shown, never swallowed).
`retireHumanInbox` tolerates a footprint that was never (fully) made.

**Endpoint state on failure.** A startup endpoint that is stopped (`concurrentStartup`'s failure path)
or fails to start is forgotten whole (`dropEndpoint`: `ep`, `conn`, `me`, `rosterSeen`, `peerHold`), and
a boot failure after the concurrent startup tears down what it acquired — so `/reconnect` never trusts
a dead endpoint's roster (a live agent shown `offline`, `@name` "no peer") nor leaks a first inbox.

**Pipe mode** (stdin or stdout not a tty) keeps today's order: connect + resolve, then the banner, then
read lines; a failure throws. `check:chat-tty` (isolated space, real pty, a bare `echoer` peer)
covers type-ahead delivery (once, in order, nothing to #general), `@ghost` refusal, an unreachable
target, a DM at join, Ctrl-C at +20/50/80/120/400ms, SIGTERM in the pre-shell window, pipe mode, an early multi-line paste (one message), a
refused multi-line queued line (kept, printed on quit), an argv error (frame erased first) and a
14-row terminal (one-line frame). `pnpm measure:chat -- chat @x` measures it
(read-only: one early key, Ctrl-U + Ctrl-D, never Enter; `--repo <dir>` measures another checkout).

Measured 2026-10-28 (pty 120×40, bun, n=5 medians, ms from spawn; baseline c68b1ae typed AT the prompt
since earlier keys were not shown):

| | first frame | prompt | typed key echoed | ready |
|---|---|---|---|---|
| remote `@queue-ea#team2027`, before | 223 | 1533 (p90 3030) | 1539 | = prompt |
| remote, after | 38 | 38 | 251 | 1562 (p90 2971) |
| local `@skills`, before | 219 | 622 | 629 | = prompt |
| local, after | 40 | 40 | 255 | 648 |
| local under node (`bin/paw.mjs`), after | 103 | 103 | 412 | 775 |

Re-measured after the review fixes (same rig, branch vs a c68b1ae copy, n=5–6 medians): remote
`@queue-ea#team2027` first frame 40 · key echoed 260 · ready 1082 (p90 1472) vs main's prompt 1406
(p90 3156); local isolated `--all` 40 · 252 · ready 406 vs main's prompt 382; node 100 · 409 · 529.

The ~230ms before readline is the @cotal-ai/core import (`scripts/lean/import-cost.ts`); wifi now only
decides how long the `◌` loaders stay up.

## images

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

## markdown

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

## paste

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
  images — the connector flattens every inbound message to ONE string. Surface (since 2026-11-06, see [multiline](#multiline) "readable"): NOTHING is printed into the
  conversation when a paste is staged — the hint row says `📋 1 pasted … /nopaste drops it`, the prompt
  keeps its `[N pasted]` badge — and the paste is shown INLINE under the line that mentions it once that
  line is held or sent (`📋 [Pasted text #1] 25 lines, 2 KB` + up to 10 wrapped rows + `… +N more
  lines`). `/paste` lists in the same form, `/nopaste` clears;
  `\e[?2004l` on shutdown so the operator's shell doesn't inherit the mode. Test: `check:paste` (38
  assertions incl. reassembly at EVERY split point); verified live under node-pty — a 4-line paste that
  used to be 4 messages now sends as ONE.

## multiline

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
  are REPRINTED because the buffer rewrite that clears the line also erases what you typed —
  otherwise you compose a message you can no longer see. Never fires inside a paste. Verified live under
  a real pty: five typed lines → TWO messages, both with real newlines. Test: `check:paste`.

- **Readable drafts and sends (2026-11-06, `src/compose-view.ts`, pure).** The operator: "I cannot read
  what I send … I cannot read what I am inputting for multiline messages", with a screenshot of a sent
  message full of blank `│` rows, a 3-line `…`-clipped paste preview printed ABOVE its own
  `[Pasted text #1]` line, and that placeholder dangling below it. Still a plain line REPL (no full-screen
  TUI, no alternate screen, no cursor math over earlier rows) — the fix is only in what gets printed:
  - **one rail** (`  │ `): the first held line prints as readline's own echo would (`you → x> line`),
    every later one on the rail, and **the continuation prompt IS the rail** (`promptFor` returns it while
    `held` is non-empty) — so the draft, the line being typed and readline's echo of the final line read as
    one block. Held lines wrap on the rail; each held line's rows are one `heldEntries` group, so
    ⌫-on-empty / Ctrl+U still take exactly that line's rows back (and reset the prompt).
  - **a paste shows inline at its placeholder** (`railLine`/`railPastes`): a line that is ONLY the
    placeholder becomes the `📋` block; a line mentioning it keeps its text with the block underneath; up
    to 10 rows, long lines WRAPPED (indentation kept — pastes are often code), blank runs folded, `… +N
    more lines` counting the rest. Nothing prints at stage time any more (that is what put the preview
    above its own line); the hint row names the staged paste instead.
  - **the hint row turns into the draft's keys** while lines are held or a paste is staged
    (`draft · 3 lines · 📋 1 pasted │ enter sends  alt+enter or \ new line  ⌫ … ctrl+u …`).
  - **the cross-session echo** (`↗ you → x (other session):`) reads the wire text back with
    `parseComposed` (the inverse of `composePastes`' fences) and draws it on the same rail: blank runs
    folded, each paste inline at its placeholder, never the raw `--- [Pasted text #1] ---` fences. It is
    no longer markdown-rendered — it is your own text, shown as typed.
  - **The wire text is unchanged** — `check:chat-tty` 13 asserts the exact DM (incl. the trailing space
    the placeholder rewrite has always left: `[Pasted text #1] \n`), and passes on the old code too.
  Tests: `check:paste` (wrap, fold, inline paste, parse round-trip, the screenshot's message),
  `check:chat` (draft hint), `check:chat-tty` 13 (real pty, isolated space).

## earlier block

**`paw chat @agent` opens on what was already said (`src/chat-backlog.ts`, pure; wired in chat.ts
`loadBacklog`, 2026-11-06).** Operator: "`paw chat @agent` should SHOW the messages exchanged with that
agent BEFORE the chat started … not start from an empty screen", on open AND on a switch. Screen:

    ── earlier with kit · 6 messages in the last 24h · 31 older · /more ──
    you → kit (3h ago): can you rebase #104?
    🐈 kit (3h ago): done — pushed, CI green
    ── now ──
    you → kit>

- **When:** on open, once the endpoint is up (it reads the DM stream, not the agent — so it shows while a
  cold agent is still waking; a name still being looked up waits for the roster), and on every `@name`
  that changes the target (the ↓ picker goes through `@name`). Before `@name <msg>` sends, so the block
  sits above what you are about to say. Never on the follow-the-conversation retarget, `--all`, or a
  `#channel`. Interactive only: a piped chat reads no history, and `--history` there fails loud.
- **How much:** default the last 20 within 24h (whichever is fewer); `--history N` = the last N, no time
  window; `--history 0` = off; `/more [N]` (default 20) = N OLDER ones, put right under the agent's first
  divider (whose count it updates) and redrawn. Nothing in the window but older exists → `(nothing with kit
  in the last 24h — N older · /more shows them)`; nothing at all → `(no earlier messages with kit)`.
- **Instant UI:** a `◌ loading earlier messages with kit…` line holds the block's place; keys are never
  blocked. When it lands and the loader is still the last thing painted (same width), the loader's rows
  are erased and the block painted in place (`lastPaint` = the text + painter state before it); otherwise
  the chat view is redrawn like a view switch. With the picker/chooser open only the history is updated
  (the next redraw shows it). A failed read REPLACES the loader with a red `! couldn't load earlier
  messages with kit: <why> — /more retries` — never an empty block.
- **Never news.** The block is read through `readOwnConversation` (src/chat-own.ts — the tasks seed's
  reader) and placed directly; it never passes through `onMessage`, so it can't follow/retarget, answer an
  await, or advance the unread cursor (`check:chat` greps `loadBacklog` for it; `check:chat-tty` 15 asserts
  the cursor didn't move). Entries are `historical: true` chat entries: shown in the chat view only (the
  logs view's transcript already says it — and in the messages view, which is chat plus), dimmed (ANSI stripped, then dim), rendered like their live twins
  — inbound through markdown with the agent's glyph, outbound on the rail via `parseComposed`/`railMessage`
  (images and `[Pasted text #N]` inline), `(Nh ago)` age tags.
- **Dedup by id.** `readOwnConversation` now returns ids (`feed.ts` `withIds`, opt-in so other surfaces'
  payloads keep their shape). `shownIds` holds every id chat put on screen (live DMs, the echo, earlier
  blocks) and `ownIds` our sends; the pick skips both at the moment it is placed, and a live DM whose id
  is already in an earlier block is acked + marked read (it IS on screen) but not printed again — a DM
  waiting in the inbox when chat opens is in the stream AND delivered live, so this happens on every open.
  An outbound row whose recipient the stream couldn't name matches by the target's live id. A row with no
  id fails loud.
- **Remote spaces:** the same `chat-history` cred as the tasks seed — two name+filter-pinned consumers on
  "you"'s own DM subjects, a fresh 5-min cred per read, never the space wildcard or `dmHistory`
  (`check:remote` guards that no `src/chat*.ts` but chat-own.ts reads DM history). Agent replies addressed
  to your human name (`humanPeer(space)`) are DMs to "you"'s id, so they are in it.
- Tests: `check:chat` (`backlog:` — sizes/flags, both directions, window, dedup, `/more`'s cutoff, dividers,
  visibility, History.replace/insertAt, the never-news grep); `check:chat-tty` 14–16 (isolated space, real
  pty: block on open with a live duplicate shown once, on `@echo2` with an unread DM a filtered chat had
  hidden — cursor unchanged, no `↪ replying`, plain line goes to echo2 — `--history 1` + `/more 3`,
  `--history 0`); `check:remote` (only chat-own reads, its remote read never calls `dmHistory`).
  Not verified against team2027 (live space — never touched by tests).

## echo and picker

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
  resolve itself) and re-checks before rendering. On a REMOTE space the tap is narrowed to "you"'s own
  send subjects (src/chat-own.ts, [remote-mesh.md](remote-mesh.md#paw-chat--paw-web-taps)) — the
  space wildcard is a Permissions Violation for chat's `agent` cred. The tap handler is shape-guarded (a space tap also sees control replies, which carry no
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

## modes

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
  An empty `@`/`#` fails loud rather than silently meaning global. **Bare `paw chat` = `.` (2026-09-14, operator: "paw attach and paw chat should default to . even if called without args")** — it preselects this folder's agent like `paw attach`/`paw open` always did (the usage string already claimed `default: "."`); the every-conversation view with nothing preselected moved to **`--all`** (`chatTargetArg`, pure; `--all` + a target fails loud). **`--only` reaches the FILTERED (`@name`) view by FOLDER or `.` instead of by name** (operator, 2026-09-09: "does `paw chat .` filter to one agent? if not add `paw chat --only .`") — `paw chat --only .` resolves the cwd's agent and shows/reads/sends only it, `paw chat --only <folder>` likewise; it fails loud on a `#channel` target (already single-channel) or an empty/broadcast target (nothing to filter to), and is a redundant no-op on `@name` (already filtered). Verified live under a pty: `paw chat --only .` → "showing: this agent only", prompt `you → paw-folder (only)>`. **The cross-session ECHO is filtered
  by the SAME predicate** (2026-08-20): it arrives through `ep.tap`, not the message handler, so
  `passesFilter` never saw it and `paw chat @a` printed every line you typed to @b in another window,
  under a banner promising "this agent only". Not merely untidy — those lines carry whatever you sent
  elsewhere, including a secret meant for one agent, into a view opened for another. Test: `check:chat` (19 assertions);
  the fail-loud paths verified against the real CLI. Verified live 2026-08-21 (operator screenshot):
  `paw chat @research` showed the filter banner, sent only to research, and announced hidden DMs from
  two other agents as dim one-liners without consuming them.

## bang commands

- **`!cmd` in `paw chat` (2026-09-09, operator's ask: "same logic as paw web")** — the same contract as the
  web composer, reusing src/bash.ts verbatim (`parseBang` / `runBash` / `bashMessage`): the command runs in
  the STICKY agent's registered folder (`folderForName`, fail-loud if unregistered or gone — on a remote
  space an agent with no persona here is reported as hosted on another machine, see
  [remote-mesh.md](remote-mesh.md#paw-chat--paw-web-taps)), the output
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
  **A sandboxed agent's `!cmd` runs in ITS VM (2026-10-28)** — `container exec … bash -lc`, never the host; its
  VM down fails loud; output now streams (batched ~100ms) so a login's URL shows while it waits.
  → [sandbox.md](sandbox.md#cmd-and-a-shell-in-the-vm-srcsandbox-exects)
  **The shell is DETACHED from the chat's tty (`runBash`, 2026-09-11):** `!gs` killed `paw chat` with
  `EIO: i/o error, read` ("happened a few times"). Reproduced deterministically under node-pty: an
  interactive zsh (`-ic`, needed for aliases) that INHERITS the chat's controlling tty runs its
  job-control init against it, and readline's next read on that tty fails EIO — first `!`, every time.
  `runBash` now `spawn`s with `detached:true` (own session, no ctty) + `stdio:["ignore",…]` (stdin really
  closed — execFile left a pipe open, so an rc/command reading stdin hung, the check:web hang) and kills
  the PROCESS GROUP on timeout (a detached child's `sleep`/build is no longer in ours). `stripRcNoise`
  drops only the exact `(eval):N: can't change option: zle` line an rc prints when sourced without a
  tty. Applies to web's `!` too (same function; no behaviour change there). Test: `check:bash-tty` —
  a real pty child raw-reading stdin while `runBash(…, interactive)` runs `$SHELL -ic` with keystrokes
  arriving; skips when `$SHELL` isn't zsh/bash. `@lydell/node-pty` became a devDependency for it.

## follows the conversation

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

## visual rounds

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

## views

- **`paw chat` views: logs | chat | messages | beads (`src/chat-views.ts`; tasks 2026-10-07, the order
  and the messages view 2026-11-06)** — ← → on an EMPTY input line step between exactly four views
  (clamped at the ends, no wrap); ↓ opens the picker. The default is `chat`. `logs` = the target's
  transcript (needs a target — with none it says "pick one with ↓"); `chat` = the conversation;
  `messages` = chat plus the target's traffic with OTHER peers, indented right (below); `beads` (was
  `tasks`, renamed 2026-11-06) = a fullscreen dashboard of the target's beads. The interleaved
  `logs + chat` view that used to sit in the middle was REMOVED on the operator's ask (2026-10-07) —
  and with it the transcript-vs-DM dedup (`dropSender`) that only that view needed. `logs`/`chat`
  are filters over one `History`, reprinted on a switch (`\e[2J\e[3J` + replay through the shared
  `Painter`); `beads` shows NOTHING from the history (`entryVisible` is false for every entry there).
  `messages` behaves like `chat` everywhere chat-ness matters (`showsChat`: follow-the-conversation,
  the banner repainted in place, the earlier block placed in place) and adds `peer` entries (`showsPeers`).
  The hint under the prompt names the current view and where each arrow goes from here.
- **A transcript that isn't written YET is followed, not given up on (2026-10-28).** Operator: "i dont think
  logs view works for the containers, why?" — `paw log fly#team2027` showed fly's trace, chat's logs view
  never did. Cause (from the live timestamps): `paw chat @fly` / `@vercel` were opened as the sandboxed agents
  were born — chat 19:39:50, fly's transcript file born 19:39:55 (vercel: 19:44:58 vs 19:46:14; a VM cold start
  is 10–20s before turn one). `openAgentLog` correctly threw "pinned to session … but it has no transcript
  yet", and `LogFollower` treated EVERY open error as final for the chat session (`failed` was sticky), so
  the logs view stayed at that one note forever. Nothing sandbox-specific in the reading itself —
  `personaTranscriptRoots` already pointed at `spaces/<s>/sandbox/<n>/claude/projects`; any freshly born agent
  had the same hole, a VM just makes the window long enough to hit every time. Fix: log.ts throws
  `TranscriptNotYet` (`retryable = true`) for "pinned, nothing written" and "unpinned, no session yet"; the
  follower re-opens such a target on every pump (no redraw, the note still shown once, worded "Following —
  its trace shows here once written"), and backfills the moment turn one lands. Other errors stay final.
  `paw web`'s trace (`traceBlocks` → `blocksForAgent`) was checked for the same bug and doesn't have it: it
  is stateless and re-polled every 5s. `check:chat` covers the follower and an end-to-end sandboxed persona.
- **The messages view (`src/chat-peers.ts`, pure; wired in chat.ts `onPeerTraffic`/`ensurePeers`,
  2026-11-06).** Operator: "same as chat, PLUS the messages this agent sent to and received from OTHER
  peers … indented/tabulated to the RIGHT … so they don't distract from my own conversation". Screen:

      you → kit: rebase #104 please
      🐈 kit: on it
                              kit → bob (2m ago): can you review #104 after CI?
                              bob → kit (1m ago): lgtm, merging
                              kit → #general: #104 merged
      🐈 kit: done — pushed, CI green

  - **What counts** (`classifyPeer`): DMs the target sent to anyone but "you", DMs anyone but "you" sent
    to it (by every id it had — roster, tap-seen senders, paw's ledger, `curId`; a restart changes it),
    its channel posts (`kit → #general`) and anycasts. Cron and the office bridge are DM senders
    (`cron`, `office`), so they show as `cron → kit`. Anything with "you" in it is chat's, never here.
    An unnamed recipient stays its short id — never a guessed name.
  - **Layout** (`peerRows`): indent = a fixed 4 cols (`PEER_INDENT`; was a quarter of the width until 2026-11-06 — read as a separate column); `from → to (age):`
    label, a one-line body on the label row else a block under it (2 more cols), markdown-rendered then
    stripped and dimmed whole; wraps inside the right column, never reaching the last column. Painted as
    a side of its own (`other`, tight), so a run of them sits together with air around it. The `peer`
    entry stores the MESSAGE (`PeerMsg`), not rendered text: `Painter` lays it out at paint time (its
    `peer` constructor arg = chat.ts `layPeer`) at the width and age of that moment, and a resize in the
    messages view redraws (debounced 150ms) — a row frozen at the old width used to overflow its indent
    and wrap into the left column after a narrowing (review, 2026-11-06).
  - **Live** (open mesh; remote below): `tapPeerTraffic` — a second space-wide `ep.tap` in chat-own.ts, attached before
    the endpoint starts. Rows are captured for the current target AND every agent whose earlier rows were
    read this session (`peerAgents`), and shown only while that agent is the target — so @kit → @bob →
    @kit shows what kit said in between. Dedup is per agent (`peerShown`, `<agent>\0<id>`: kit → bob is a
    row under both). A gap in the tap (transport down, or the endpoint replaced by `/reconnect`;
    `peerDownAt`) is READ BACK once a started endpoint is up again (`catchUpPeers`: every tracked agent,
    from 5s before the gap, unseen ids only, under a `── N messages … while the connection was down ──`
    line; a failed read is red). A channel post "you" also receive comes through `onMessage` as a chat
    line (which adds its id to `shownIds`); the tap waits 300ms for that, and if delivery is slower still,
    `onMessage` SWAPS the tapped row for its line (`swapPeerRowFor`, exact by id) — never shown twice.
    Stale-id forwards (src/forward-mark.ts) are paired exactly (`isPeerForwardOf`): history drops a
    forward whose original it holds (`dropPairedPeerForwards`), live drops one whose original was placed
    (`peerOriginals`), and an unpaired forward shows what the sender wrote, the note removed. Never news:
    no follow, no await, no cursor.
  - **Earlier** (`ensurePeers`): once per agent per session, on entering the view and on every
    retarget while in it (`pumpLogs` checks each second — the target moves down many paths). Sized like
    the earlier block (`--history`: last 20 within 24h; N = last N; 0 = off), deduped by id against
    `shownIds`/`ownIds`. A `◌ loading kit's messages with other peers…` loader holds the place (keys never
    blocked); the rows are MERGED BY TIME into that agent's earlier block (between its divider and
    `── now ──`, `mergeByTs`; earlier-block rows now carry `ts`) and the view redrawn, and a summary
    `── N messages between kit and other peers in the last 24h, indented right · M older not shown ──`
    replaces the loader; with no earlier block they go where the loader was. A failed read replaces the
    loader with a red `! couldn't load kit's messages with other peers: <why>`. Read by `readPeerTraffic`
    (chat-own.ts): open mesh — `dmHistory` (the whole DM stream) + `listChannels`/`multiChannelHistory`;
    remote — the `chat-peers` read (below). Recipients named from stream senders → ledger → live roster.
    No `/more` for these rows yet.
  - **Remote spaces: read with the operator-only `chat-peers` cred (2026-11-06, operator's go).** chat's own
    creds cover only "you"'s subjects, and the `admin` observer is space-wide, so chat-own signs a narrow
    cred from the space signer per job ([remote-mesh.md](remote-mesh.md#paw-chat--paw-web-taps) has the
    exact subject list): for each of the target's ids (live + ledger, ≤16) its DMs to and from it and its
    own channel posts — never the space wildcard. Earlier rows and every read-back sign a fresh 5-minute
    READ cred (pinned consumers, no subscribe). Live rows come off ONE tap on the current target
    (`ensurePeerTap` in chat.ts, `tapAgentTraffic` in chat-own.ts), subscribe-only, re-signed before expiry
    make-before-break; a retarget in the messages view retires it, and coming back to that agent reads
    the time it was off back (`peerTapOffAt` → `catchUpPeers(since, [agent])`). Failures stay loud (red
    line); >16 ids = a yellow note. The ids come from paw's ledger, which the mailbox keeps on remote
    spaces since the team2027 empty-read miss (src/ledger-recorder.ts); with none of the target's earlier
    ids known, a yellow `! only <agent>'s current mesh id is known …` sits under the summary. Anycasts aren't read remotely. The old yellow "not readable" note and
    `remotePeersNote` are gone.
  - Tests: `check:chat` (`peers:` — classification incl. old ids, cron/office, channels, "you" excluded,
    unnamed ids; indent/rows/wrap; sizing; summary; `mergeByTs`; a remote read signs `chat-peers` and
    dials instead of refusing, never `dmHistory`; a remote switch retires the tap and reads back; `ensurePeers`
    never follows/marks read); `check:remote` (the cred's subjects are exactly the agent's, no wildcard /
    admin rows, re-signed per read, the tap renewed make-before-break, only chat-own mints it); `check:chat-tty` 17 (real pty: echoer's
    earlier DM to `bob` merged into the block at col 24 as `echoer → bob`, your DM from echoer at col 0, a
    live `bob → echoer` at col 24). The remote path is not verified against team2027 (hermetic only).
- **The beads view (`src/chat-tasks.ts`, pure; wired in chat.ts `paintTasks`; was `tasks`, fullscreen
  2026-11-06)** — title `beads · <agent>` + live status, the `paw status` info row, then the target's
  beads (`assignee` = the agent; with no target, the operator's own via `operatorName()` plus "pick an
  agent with ↓ to see its beads"): in_progress ◐ → blocked ⊘ → open ○ → deferred ◌ (priority, then most
  recently touched), then the last 24h's closed ✓ dimmed, at most 3; one row each — glyph, id, title, age.
  **Fullscreen** (operator: "NOT a split view anymore"): the last message each way that sat under the
  beads is gone, and with it the DM-stream seed (`seedConversation`/`lastSaid`/`lastExchange`) — the bead
  list gets every row between the head and the receipt line. **Reads:** `listAssigned` (src/tasks.ts) = two bd reads
  on the READ lane (never the write chain), uncached, only while the view is on screen: on entry,
  every 12s, and (≥3s apart) on a DM or presence change from that agent; one read in flight at a time;
  a failed read is SHOWN (`! beads: …`), never rendered as "no beads". **Painting:** cursor home, each
  row overwritten + `\e[K`, `\e[J` below, then the prompt — and ONLY when the painted text changed, so
  an idle refresh writes zero bytes (measured: 0 bytes over 13s incl. a refresh). Ages are
  MINUTE-resolution (`now`, `3m`, `2h`) for that reason — a seconds counter repainted every tick. The
  first paint after a switch clears the scrollback like any view switch; a submitted line, a resize or
  a view switch force a repaint (readline's echo moved the screen). **Fit:** exactly the terminal minus
  prompt+hint: the beads scroll (`↑ N above · wheel/PgUp`, `… +N more · wheel/PgDn`, whole beads). Receipts and errors (`⏳ waiting…`,
  `! …`) have no scrolling conversation to land in here, so the newest one is a notice line under the
  title, cleared when a message arrives. The picker, paste, images, modes and `!cmd` all keep working
  (paints are skipped while the picker is open). Tests: `check:chat` (4 views, hint, bead order and
  filtering, fullscreen render fills 4–60 rows with no conversation pane, ANSI wrap); `check:chat-tty`
  19 (real pty, 40 beads in an isolated `PAW_BEADS_DIR`: fullscreen, no conversation rows); live (not
  re-run since 2026-11-06 — needs nats-server + @xterm/headless):
  `scripts/lean/e2e-chat-tasks.ts` (isolated nats + PAW_HOME + PAW_BEADS_DIR, fake `kit` peer, node-pty
  + @xterm/headless — order, glyphs, round-trip, no-flicker idle, a bead closed elsewhere turning ✓,
  a 14-row terminal, ← back through chat to logs).
- **The mouse in the beads view (`src/mouse.ts`; opt-in click mode 2026-10-10, ON BY DEFAULT in the view
  2026-11-06).** Operator: "Mouse wheel scrolling must work in it, not only PgUp/PgDn". Terminals can't
  capture the mouse for part of the screen, and always-on capture across chat (7b39ffe) killed native
  drag-select and was reverted — so reporting is tied to the VIEW: `syncMouse()` turns `?1000h ?1006h`
  on exactly while the beads view is up and select mode is off, and off otherwise. The wheel scrolls the
  bead list by 3, a left click on a parent's icon cell (`▾`/`▸` + its status glyph, 3 cols) toggles its
  fold, everything else is a no-op. **ctrl+o = select mode** (reconciles the old click mode, inverted):
  the mouse goes back to the terminal (`?1000l`), a yellow `select mode · mouse is the terminal's (select
  text) · wheel doesn't scroll · ctrl+o gives it back` row sits under the title, the hint swaps
  `wheel scrolls · ctrl+o select text` for `ctrl+o mouse back (wheel scrolls)`; every entry into beads
  starts with select mode off. Most terminals also select with a modifier held while reporting is on
  (shift in iTerm2/kitty/ghostty/xterm, fn/option in Terminal.app). ctrl+o because readline binds nothing
  to it (probed); ignored while picking or mid-paste. The chat/messages/logs views NEVER have reporting on
  (`check:chat-tty` 19 asserts the first `?1000h` comes after both were used), so selection there is the
  terminal's. Mouse reports are cut out of every stdin chunk by a wrapper on `process.stdin.emit` (in
  front of every listener, readline included — readline would otherwise type `0;10;5M` into the line);
  the strip is always on. **Off on every way out:** leaving the view, ctrl+o, `shutdown()` (ctrl+c/EOF/
  SIGINT/SIGTERM/`/quit`) writes `?1000l ?1006l` unconditionally, and a `process.on("exit")` hook writes it
  synchronously if reporting is still on (crash path). **Ctrl-Z** (`r.on("SIGTSTP")` in `createRepl`, which
  takes readline's own suspend over): reporting + bracketed paste off and raw mode off, THEN
  `SIGSTOP` (not SIGTSTP — the kernel discards that in an orphaned process group, e.g. a chat leading its
  pty session); on SIGCONT raw mode, bracketed paste and `syncMouse()` come back and the view repaints.
  `check:chat-tty` 21. Folds are view state. A folded parent renders
  `▸ ○ id (+N)` (N = every hidden descendant); its descendants are NOT rows at all, so the pager's counts
  are painted rows only and the wheel/PgUp/PgDn reach every one. `renderTasksPanel` (pure) returns
  `{ rows, hits }` and `hitAt` resolves a click. Caveat: needs SGR (1006) mouse support — every modern
  terminal has it; under tmux with `mouse off` the wheel never reaches chat (PgUp/PgDn still work). Tests:
  `check:chat` (fold tree + hidden counts, scroll with folds reaching every row, hit map, SGR decode/strip,
  hints, select-mode row); `check:chat-tty` 19–20 (real pty: on at entry, a synthetic wheel-down shows
  `↑ 3 above`, ctrl+o off then on, ← out writes `?1000l`, `/quit` in beads writes `?1000l` last).

## remote agents

An agent can run on ANOTHER machine on the same mesh space: teleported away (its persona here keeps the
`teleported:` marker, see [teleport.md#the-marker](teleport.md#the-marker)) or simply hosted elsewhere on a
remote space (no persona here). `runsElsewhere(space, name, card?)` in src/hosted.ts is the ONE notion
(`elsewhereOf` is the pure core): `{ how: teleported|hosted, where, cwd? }` — `where` is the marker's
`teleported:` value (`origin` → "the machine it came from"), else the roster card's `meta.host`, else
"another machine"; `cwd` is the marker's `teleportedCwd:` (never guessed — older markers have none, the
header then shows the host alone). A same-host card is NOT elsewhere (its files are on this box).
Messaging works over the mesh as usual (PR #31's wake gate returns the live peer id). Everything that would
read this machine's frozen copy says where it runs instead (2026-10-23, operator: "do the remote version…
or disable functions that don't make sense for remote agents"):

| feature | remote agent |
|---|---|
| messages, `@name`, `/dm`, `#channel`, pastes (inline text) | work, over the mesh |
| header | `agent: tracepaper  runs on ssh:mini · /Users/aleks/.paw/repos/caffeinum/tracepaper`, `status: live on the mesh`, no model/context lines (stale), one dim line `logs, ctx, !cmd and files are on ssh:mini — from here you message it over the mesh`; the help line drops `!cmd runs in its folder` |
| `← logs` view | `(no logs for tracepaper — logs live on ssh:mini, where it runs — the transcript on this machine stopped when it left)` |
| `paw log`, web trace | `paw: no logs for "tracepaper" here — logs live on ssh:mini, where it runs — …` (guard in `openAgentLog`, persona-present agents only) |
| `!cmd` (chat + web) | `! !cmd runs on this machine, not on ssh:mini where tracepaper works` |
| image/file attachment (chat) | staging warns `⚠ tracepaper runs on ssh:mini and can't open a file on this machine — /noimg drops it and keeps your text`; the send is refused (`AwayFilesRefused` thrown in `flush`, nothing sent, still staged): `! not sent — tracepaper runs on ssh:mini and can't open [Image #1] (a file on this machine) — /noimg drops it and keeps your text`. The refused line waits in `awayDraft` (the input is needed to type `/noimg`); `/noimg` drops the images AND puts the line back into the input without its placeholders (`dropPlaceholders`, whitespace tidied), so Enter sends the words alone. A quit before that prints it in full; a second refusal moves the first into `keptUnsent`. Before 2026-11-10 `/noimg` cleared the images and the typed line was simply gone. Actually carrying the image to the other machine is the real follow-up. `check:chat-tty` 22 |
| `paw dm` / web send with an attachment line | `sendAsYou` refuses: `paw: not sent — … (a file on this machine)` (`attachedPlaceholders` reads the `📷/📎 [Image #N] /abs` lines) |
| `paw attach` / `paw open` | `paw: "tracepaper" runs on ssh:mini — attach to it there; from here \`paw chat @tracepaper\` messages it` |
| `paw status` / tasks-view info | live + mesh from the roster, busy only from its own `working` claim; no ctx/failure/last-active/inbox/git; never "unmanaged — paw restart re-adopts it"; note `runs on ssh:mini · <cwd> — ctx, logs and folder are there` |

Not done (follow-ups): logs over the mesh — claude seats publish AG-UI frames on `events.<owner>.<actor>`
(cotal ≥0.84, on unless `events: false`), so a remote claude agent's trace could be rendered from that
stream; kit/hermes/acp spawn with `events: false` (no event plane), so tracepaper (kit) would still have
none. ctx % over the mesh needs the remote to publish it (card meta or an event). Files over the mesh
(`#files` announces absolute paths — meaningless on another box; the agent's own `📷 /mini/path` replies
404 in paw web here). Tests: `check:teleport` (marker cwd, runsElsewhere, log/attach refusals, status row),
`check:remote` (elsewhereOf + strings), `check:images` (`attachedPlaceholders`).

## where it runs (hint row, picker, banner)

The hint row under the input right-aligns `mesh <space>[ (remote)] · on <machine>` for the target
(`· not running` when it runs nowhere, `mesh <space>` alone with no target); the hint is elided before
the tag drops, and the tag gives way below 14 columns of hint (`hintWithTag`, src/chat-views.ts). Picker
and `$` mode keep the plain hint. Machine comes from the same `machineOf` as `paw status` (card
`meta.machine`/`meta.host`, else the teleport marker, else a local space's persona → this machine, else
`?` while live) — chat reads no manager ps, so on a remote space a live agent whose card has no host
reads `?`. Another machine is cyan, `?` yellow. ↓ picker rows append `· <machine>` when the row fits; the
banner prints the mesh line once. Tests: `check:chat` (whereTag, hintWithTag widths).

## connection state

`src/conn-state.ts` (`ConnState`, `attachConn`, `logConn`). cotal 0.100's endpoint reports trouble one
event at a time: a `warning` per failed presence heartbeat (2s) and an `error` per failed presence-watch
rebind — `sweep()` → `rebindStalePresenceWatch` once per TTL (6s) while a held link keeps the watch
silent, and the rebind's consumer create rejects with nats.js `TimeoutError`, message exactly
`timeout`. chat printed every `error` as `! <message>`, so a remote fly space filled with red
`! timeout` (2026-10-26). Now chat, `paw inbox --watch` and `paw web` feed the endpoint's `transport`,
`connection`, `warning` and `error` events into one state: `connecting` / `connected` / `degraded`
(socket up, transient failures within 20s) / `reconnecting (n)` (n = failed dials only) /
`disconnected Ns` (cotal's terminal-close supervisor is rebuilding). chat leads the hint row's right side
with it (`● connected · mesh … · on …`, green/yellow/red), redrawn by a 1s tick only when the label
changes. Transcript lines: ONE when a non-connected streak lasts 30s (with the last reason), ONE when it
recovers. Printed immediately: auth/permission refusals (even inside a `mesh connection closed`),
creds/bearer refresh failures, cotal `transient: false` escalations (presence-write-stuck only while the
connection is UP — during an outage it is the outage restated), and anything unrecognised (fail loud);
a repeated loud text is counted, not reprinted, for 10 min. `/conn` prints the state, the session's
transient + loud counts and the last of each; `PAW_CONN_DEBUG=1` prints every raw signal. `show()` now
clears from the prompt's FIRST row (`getCursorPos().rows`), so a wrapped input no longer leaves stale
prompt rows above each printed line. Upstream: cotal should log one line per failure streak, not per
heartbeat. Tests: `check:chat` (`conn:` cases).

**Quieter still (2026-10-27).** `paw chat @queue#team2027` still printed, over a few minutes, ~5
`! mesh degraded for 30s …` / `● mesh connected again after 2m …` pairs, a loud `! presence writes to
bucket … failed 4 consecutive times … (last refusal: timeout)` ×4, and `→ queue joined` / `← queue went
offline` every minute for a peer that never left — under a footer that already said so. Now:
- **presence-write-stuck with `lastError` a timeout** (`isPresenceStall`: cotal's `PresenceWriteStuckError`
  `code` + `lastError`) is transient — the same stall `degraded` shows. Any other refusal (permission, a
  latched/damaged store, #1356) stays loud; a `transient: false` error without that code + lastError is loud.
- **Transcript threshold 2 min** (`SUSTAIN_MS`, was 30s) and **coalesced** (`COALESCE_MS` 10 min): at most
  one problem line + its recovery per window. A sustained episode inside the window is counted, not
  printed, and the next printed line says `(+N earlier episodes, M warnings, shown in the footer only —
  /conn)`; one still going when the window ends prints then (a long outage is never hidden). Applies to
  `paw inbox --watch` and `paw web` too (they share `logConn`; neither prints presence).
- **Presence joins/departures** go through `src/presence-hold.ts` (`PresenceHold`). While the view is
  quiet — conn phase not `connected`, `ep.presenceView().fresh` false, or `ep.presenceWriteFailure()?.stuck`
  — nothing prints; the latest state per peer id is held, and when live again only the NET change prints
  (left-and-back prints nothing, really gone prints once, new prints a join). On a live view an offline
  waits `OFFLINE_DEBOUNCE_MS` (12s = 2 × cotal's 6s TTL) and a join inside it cancels it; a join prints
  at once. Peers present at attach are seeded so a real departure still prints. `update` events
  (status lines, `picked it up`) are unchanged.
- `/conn` adds the sustained-episode count (and how many were footer-only), the last 5 warnings/errors,
  the presence view state, our own presence-write failure, and how many joins/departures are held.
Root cause of the flaps (investigated read-only 2026-10-27): not the broker (CPU 2–6%, no iowait, RSS
under GOMEMLIMIT, presence KV memory-backed). The mac's and the mini's timeout bursts don't overlap
(the mac's run into `getaddrinfo ENOTFOUND` — its own link drops; the mini's 05:28–05:37Z / 05:58Z took
every seat offline in one ms — a shared uplink stall, likely its Wi-Fi). cotal's 2s heartbeat / 6s TTL
turns any >4–6s client stall into fleet-wide flaps. Tests: `check:chat` (`conn:` + `presence:` cases).

**An indicator, not spam (2026-10-27, later).** `paw chat @2027-intern --space team2027` over this mac's
dropping Wi-Fi/DNS still printed: `! timeout` right after a send (was it sent?), repeated `! mesh degraded
for 3m …` / `● mesh connected again after 4m …` pairs, a raw `! getaddrinfo ENOTFOUND`, and a `• 2027-intern
● idle` / `● working` line per status flip. Now:
- **Sends never print a bare error.** The `timeout` was the JetStream publish ack: cotal's `unicast` /
  `multicast` → `js.publish(subject, msg, { msgID: msg.id })` → nats.js `nc.request` with the JetStream
  context's default 5s timeout, one attempt (`retries` 1) → `TimeoutError("timeout")`, caught by the line handler's
  `! ${message}`. A timed-out publish may or may not have been STORED, and `unicast` mints the id inside the
  call, so a re-send through it could deliver twice. `src/mesh-publish.ts` drafts the message (`draftDm` /
  `draftPost`, the exact shape and subject cotal uses) with an id paw owns and publishes it with
  `msgID = id` (`publishDraft`), so a re-publish of a copy that landed is deduped by the stream (2m
  `duplicate_window` on the DM and chat streams). It reads cotal's PRIVATE `js` client — the one coupling,
  checked loud (`needs a new hook` if a bump renames it); cotal nulls it in its rebuild window, reported as
  cotal's own `reconnecting - try again shortly` (transient). Upstream gap: `unicast`/`multicast` should
  take `opts.id`.
- **`src/outbox.ts` (`Outbox`)** — every chat send (sticky DM, `@name msg`, `/dm`, `#chan msg`, room post,
  `!cmd` result, stuck-seat queue) goes through one FIFO (only the head is in flight, so order holds). A
  transient failure (`classifyEndpointError`) prints ONE dim `◌ sending… you → kit: status   (timeout —
  retrying)` and retries with backoff 1/2/4/8/15s; the conn tick `kick()`s it the moment the socket is back.
  Success after a retry: `✓ sent after 14s · ⏳ waiting for kit…` (a first-try success is unchanged: just
  `⏳`). Give-up after `GIVE_UP_MS` 90s (inside the 2m dedup window, so the last retry still dedups) or at
  once on a non-transient error (auth, permissions, unknown — the real reason): ONE red `✕ not sent to kit:
  timeout — no ack in 90s, 6 tries — /retry to send again   (status)`. `/retry` re-queues every failed
  message with its SAME id (`↻ sending again → kit: …`; past the 2m window it says the first copy, if it
  did land, would arrive twice). Quitting with unsent messages prints them. The footer shows `◌ sending N`
  (only once a send has hit trouble) and `✕ N not sent · /retry`. Ids are recorded in `ownIds` BEFORE the
  publish, so the echo tap's in-flight wait (`sending` counter) is gone.
- **A silently dead socket is replaced, not retried into (2026-11-04).** On a flaky Wi-Fi (router RTT
  200ms–1s, resets) sends still ended `✕ not sent … no ack in 95s, 8 tries` under a `◐ degraded` footer.
  Cause: the TCP flow had died with no RST (Wi-Fi/NAT dropped it); nats.js only notices through its own
  PINGs (every 2 min, stale after 2 unanswered — 4–6 min), so the transport read "up" and all 8 tries
  (5s JetStream ack timeout each, 1/2/4/8/15s backoff = exactly 95s) rode the dead socket. Reproduced
  with a black-holing TCP proxy: baseline = failed at 95s, transport never went down. Fix (`src/link-probe.ts`): a send whose ack timed out PINGs the connection
  (`nc.flush()`); no PONG in `PROBE_MS` 5s → `nc.reconnect()`. The connection comes from cotal's public
  `onConnection` option; a live-but-slow link answers the PONG and is left alone. The outbox's `kick()`
  now also ABANDONS an attempt in flight (it rode the old socket) and re-sends at once, and chat kicks on
  the endpoint's `transport` up EVENT (the 1s phase tick misses a forced reconnect's same-ms down/up).
  Measured: silent drop 95s ✕ → 10s ✓; 20s total outage → ✓ at 30s; 12 sends over 0.2–1s jitter with a
  RST or black hole every 15s → 12/12 (each black hole costs its head ~10–14s; the baseline run had lost
  4 of 7 when stopped); 4s RTT → no forced reconnect (a 3s probe bound forced 2); 0 duplicates throughout
  (same msgID). Tried and dropped: tighter transport pings alone
  (`transportPingIntervalMs` 5s/2: 22s and p50 60s on the jitter run — detection is slower and a queued
  FIFO waits on it). `/conn` counts the forced reconnects. Tests: `check:chat` (`send: kick() mid-flight`,
  `probe:` cases), `scripts/e2e-send-retry.ts` case 3 (silent drop).
- **Degraded never prints.** `ConnState.settle` now prints only for a SOCKET-DOWN streak (connecting /
  reconnecting / disconnected) past 2 min, plus its recovery, coalesced per 10 min as before. A degraded
  spell (socket up) lives in the footer; `/conn` counts `degraded spells over 2m`. Applies to `paw inbox
  --watch` and `paw web` (shared `logConn`).
- **DNS/dial errors are state.** ENOTFOUND, EAI_AGAIN, ECONNREFUSED, ECONNRESET, EHOSTUNREACH, ENETUNREACH,
  ETIMEDOUT, `getaddrinfo` are transient; a failed dial makes the phase `reconnecting` for `DIAL_FAIL_MS`
  (20s, unless the transport reports up — so a side dial can't pin it) and its code rides in the footer
  (`◌ reconnecting (2) ENOTFOUND`) and `/conn` (`last failed dial: ENOTFOUND`). The echo tap's errors feed
  the same state instead of printing `! <message>`. Auth/permission stay loud.
- **Status flips live in the footer.** The presence handler prints only `✓ kit picked it up — …` (the ⏳/✓
  flow) and the debounced joins/departures; every other `update` (idle ↔ working, activity) just redraws
  the footer, which now leads with `peerStatusTag`: the target's live status (`2027-intern ● working`), or
  with no target who is working (`kit, queue working` / `3 working`, filter-aware). `/who` lists everyone.
Tests: `check:chat` (`send:`, `publish:`, `footer:`, DNS `conn:` cases); `scripts/e2e-send-retry.ts` (a
private nats-server + a TCP proxy that HOLDS bytes like a dropped link: the stalled send times out, shows
pending, lands once the link is back — the held copy and the retry dedup to ONE delivery; past a short
bound it fails once and `retry()` still delivers once). Run it with the isolated env:
`PAW_HOME=$(mktemp -d) PAW_SPACE=test-$$ PAW_RELEASE=dev node scripts/e2e-send-retry.ts`.
