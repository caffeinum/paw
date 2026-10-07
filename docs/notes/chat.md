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
  images — the connector flattens every inbound message to ONE string. Surface: `📋 [Pasted text #1]
  4 lines, 49 B` + a 3-line preview, a `[N pasted]` prompt badge, `/paste` to list, `/nopaste` to clear;
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
  are REPRINTED (`↵ ALPHA`) because the buffer rewrite that clears the line also erases what you typed —
  otherwise you compose a message you can no longer see. Never fires inside a paste. Verified live under
  a real pty: five typed lines → TWO messages, both with real newlines. Test: `check:paste`.

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
  resolve itself) and re-checks before rendering. The tap handler is shape-guarded (a space tap also sees control replies, which carry no
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
  the STICKY agent's registered folder (`folderForName`, fail-loud if unregistered or gone), the output
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
