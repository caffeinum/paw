# Shared task list (beads), pad, board

Moved verbatim from CLAUDE.md (2026-10-02 split). Index: [CLAUDE.md](../../CLAUDE.md)

## beads task list

- `src/tasks.ts` + `web/app/tasks.js` — **the fleet's SHARED TASK LIST (beads, 2026-08-25).** The store
  is bd's own machine-wide db (`~/.beads`, embedded dolt — bd ≥1.x is dolt-only; `bd init` into a
  custom dir resolved to the global anyway, so paw uses bd's default rather than fighting it). THREE
  wires: (1) the connector injects `BEADS_DIR=~/.beads` into every agent's launch env — load-bearing
  because bd resolves a repo-local `.beads` FIRST, so an agent cwd'd in team2027 would otherwise file
  fleet tasks into that repo's own project tracker, invisibly; applies per agent at its NEXT restart.
  (2) The brief tells agents the discipline: file (`bd create`), claim before starting
  (`--status in_progress`), close with a reason, don't override BEADS_DIR. (3) `paw web` gets
  `GET/POST /api/tasks` (bd list --json / bd create, 15s server cache — each bd call spins an embedded
  dolt engine), a foldable Tasks sidebar section (in_progress > blocked > open > unknown-LAST; an
  unknown status renders as itself, never blank), and a **`/task <title> [-- description]`** composer
  command (leading-only, like /invite; on failure the text is PUT BACK in the composer). `!bd …` bang
  commands also run under `bdEnv()` (bash.ts) so they hit the same db. bd's install gotcha, hit live:
  a stale bd 0.63 in `~/.local/bin` shadowed homebrew's 1.x — `which bd` before trusting it. Tests in
  `check:web` (13 assertions); routes verified live (GET listed, POST filed + returned fresh list).

## operator requests become tasks

- **Operator requests become tasks (brief, 2026-09-09):** "auto-beads all incoming user requests so i can see
  the status of my prompts — well maybe not ALL". The brief now tells every agent: an operator DM that is
  more than one small immediate action (commit / open a PR / answer — no task) is filed with `bd create`
  BEFORE starting, assigned to the agent, claimed, closed with a reason; title in the operator's own
  wording cleaned up (typos, filler, "can you" dropped) — never a paraphrase, never a verbatim quote;
  description = the full ask + what done means; multi-step asks get one task with steps or `--parent`
  sub-tasks; when in doubt, file. Applies per agent at its next restart (the brief is built at spawn).

## task pad

- `web/app/taskspad.js` — **the TASK PAD (2026-08-25): the shared list as an editable, Apple-Notes-style
  bullet list**, opened full-size over the main pane from the ⤢ on the Tasks header. Text-first: every
  title is contenteditable; Enter = next task (the auto-bullet); Backspace on an emptied row removes it;
  the BULLET is the status control (click cycles ○→◐→✓; blocked/deferred cycle back to open — never a
  state without an affordance). Edits debounce 1s (blur flushes) into `/api/tasks` ops
  (`op: create|update|close`); a NEW row gets bd's own id stamped in from `bd create --silent`.
  Discipline: the pad is the WRITER while the operator is in it — `maybeRender` skips a poll rebuild
  while a row is focused/dirty/inflight (the lost-draft bug, one surface over); a failed sync marks the
  row `⚠ not saved` and KEEPS the text; removing a synced row CLOSES it with a reason (shared list —
  never hard-delete an id a teammate may hold), an unsynced row just drops (`deletionPlan`). The Tasks
  header stays visible when the list is empty (unlike PRs) — an empty list is still where you ADD.
  Server ops in src/tasks.ts (`createTaskGetId`/`updateTask`/`closeTask`/`commentTask`); `/api/tasks`
  POST takes `op: create|update|close|comment` (+`parent`, `text`), and writes return `{ok}`/`{id}`
  WITHOUT re-listing (a re-list doubled every write's cost — each bd call boots an embedded dolt
  engine, ~1s). **bd calls are SERIALIZED** (`chain` in tasks.ts): dolt is single-writer and two
  overlapping pad writes made one fail. **Reads take their own lane** (`bdRead`, 2 at a time, `urgent`
  jumps the queue — 2026-10-05): a bead modal's `bd comments` used to wait behind the company page's
  list refresh, 0.4–2.2s live. Reads overlapping writes are safe (probed: 36 reads × 24 writes across
  processes, zero failures); caches capture `writeGeneration()` at the START of a read and don't store
  rows a mid-read paw write may have outdated. **Comments:** `allComments()` = ONE `bd export` (~1s
  for the whole db; `bd show <ids…> --include-comments` is ~0.6s PER id, `bd sql` refuses in embedded
  mode), 15s cache; `GET /api/company/<slug>/comments` serves a company's threads from it, the page
  keeps them in localStorage and re-reads only when bd's comment counts move, prefetches a row's
  thread on hover/focus, and the modal paints the thread in hand at once (measured modal→comments:
  median 670ms/max 1.05s → ~50ms). Pure parts tested in `check:web` (treeOrder/taskDepth/
  pasteOutline/relTime/cycleStatus/deletionPlan); DOM behaviour is verified with **python playwright
  (1.29, `/opt/homebrew/bin/playwright`) against the live daemon, asserting COMPUTED STYLE** — see
  the lesson below.
  **What the pad does (all 2026-08-25/26, each reported by the operator on first use):** SAVE ON
  BLUR (8s backstop, never under the fingers); ↑/↓ and ←/→ cross rows like one document; paste is
  plain-text, and an INDENTED paste (`pasteOutline`: tabs or the paste's smallest space step) files a
  real parent/child chain sequentially (a child's create needs its parent's id); **Tab/Shift-Tab**
  reparent via `bd update --parent` OPTIMISTICALLY (indent in ~30ms, write behind, revert on failure);
  children render indented (`treeOrder`/`taskDepth`, id chain bounded at 6); **drag the id chip** to
  reorder — display order only, persisted per space in localStorage, a parent carries its subtree and
  can't drop into it; the hover card on the id (created/by, updated, assignee, blocked-by); the **💬
  at the end of the text** (Notion-style, click-only — an input under a passing cursor was an ambush)
  opens the interactive card: `@agent message` → a **bd comment on the bead** + a DM nudge carrying
  the id (`bd show <id>` for the thread); no tag = bare note, nobody pinged; persistent 💬N when
  comments exist; ⛓ chip with open blocker ids (server enriches via `bd show` per dependent task
  inside the 15s cache); a refused status change **reverts the bullet and shows bd's words** ("blocked
  by open issues …") — never a lying ✓; double-click on a bullet is one cycle; sticky display order
  across rebuilds; a fetch that STARTED before the last write is refused (`lastWriteAt`) so a poll
  can't revert a save; `?at=tasks` deep-links the pad; exactly ONE sidebar row lights at a time (the
  pad yields Activity/agent highlights). `BEADS_ACTOR=<agent>` in the connector env makes agent-filed
  tasks say "created by research" rather than git's user.name.
  **The lesson that cost the evening:** `#taskspad{display:flex}` overrode `[hidden]` (an author
  `display` beats the UA's `display:none`), so the pad was PAINTED over every view from load while
  every close path "worked" — the property flipped, chats opened underneath. My probes asserted
  `.hidden`, never computed style, and agreed with the code against the operator's screenshots for
  three rounds. Fix is `#taskspad[hidden]{display:none}`; the discipline is a visible **client build
  stamp** (`CLIENT_BUILD`, shown in the pad hint + console) and an on-page **fault banner** for any
  uncaught error, so "which code is this tab running" is answered by a screenshot. Also: a launchd
  `kickstart -k` silently didn't take once — check the new pid/lstart after every deploy.

## board

- `web/app/board.js` — **the Board (2026-08-26): the same list as a kanban**, a VANILLA port of a
  21st.dev/shadcn "trello-kanban-board" React component the operator pasted ("ignore the tailwind
  stuff and rewrite it into your system"). paw web is no-build vanilla JS served from the checkout, so
  the port keeps the component's SHAPE (columns, draggable cards, drop highlight, add-a-card) and swaps
  its state for bd: columns are statuses (`columnsFor`, unknown status → To do, never lost), a drag
  between columns is `op:update status` (Done = `op:close`, the card leaves — closed tasks aren't in
  `bd list`), add-a-card is `op:create` (+status). Optimistic with bd's refusal printed on the card.
  **Tasks and Board are FOCUS TARGETS** (`TASKS = "~tasks"`, `BOARD = "~board"` in app.js, `?at=tasks|
  board`): `render()` reconciles the pad/board open state from `state.focus` — never opened/closed on
  their own — so selecting anything else replaces them, ✕/Esc = `focusTarget(null)`, and exactly one
  sidebar row lights. That replaced the overlay's parallel open/close state, which produced a whole
  class of "tapped X, got Y" bugs (a click on the already-focused agent under the pad toggled to
  Activity). **Re-click = scroll to end (2026-08-27):** clicking the already-selected agent or
  channel row no longer toggles to Activity — it jumps the conversation to its newest message
  (`scrollToEnd`); the toggle read as "the click broke" when you were three screens up. Gotcha: `const board = initBoard(…)` MUST be module-scope — declared inside a render
  function, `render()` resolved `board` to the `#board` ELEMENT (`window.board`) and threw
  `board.isOpen is not a function`; the fault banner surfaced it in one probe. Tests: `check:web`
  (columnsFor/initials); drag→status→revert, deep link and view swaps verified headless.
  **Sub-tasks + the card modal (2026-08-26):** a task whose parent is on the board is NOT its own
  card — it rides inside the parent's card as a checklist (`columnsFor` skips it, `childrenOf` lists
  it); the bullet cycles its status (optimistic, revert + reason on refusal), its TEXT opens its own
  modal (an inert sub-row was the first thing a probe hit — a click that does nothing reads as broken).
  Clicking a card opens a Notion-style modal: status chips (click = `move()`, Done closes and the
  modal dismisses), description, metadata, the sub-task checklist, and the COMMENT THREAD from
  `op:comments` (`listComments`/`parseComments` in tasks.ts over `bd comments <id> --json`, uncached —
  read on open) with a compose box (plain = `op:comment`; `@agent` = comment + `/api/dm` nudge, same
  contract as the pad's card). Cards use the CONTENT palette (`--content-alt`/`--line`/`--txt`) — the
  sidebar aubergine was unreadable in light mode. Verified headless: open → post (thread 0→1) → esc →
  sub-task modal.

## editlist

- `web/app/editlist.js` — **the editable-row contract, packaged (2026-08-26).** Sub-task checklists
  on the board (cards + modal) edit exactly like the task pad — rename on blur, Enter = new sibling
  (`op:create` with the list's parent), Backspace-empty = remove (close/drop), ↑/↓ and edge ←/→
  across rows — via `wireEditableList(container, {api, parent, onCreated/onRenamed/onRemoved,
  onSynced})` over rows shaped `.eli[data-id] > .elt[contenteditable]`. `keyAction` (pure, tested in
  `check:web`) holds the key rules that went wrong in the pad. **The pad still carries its ORIGINAL
  copy of this logic** (initTaskspad's closure) — folding it onto this module is the next
  consolidation; two copies is a known, dated debt, not a design. Board rows carry a hover `↗` to
  open the sub-task's own modal since the text is now an editor. Esc inside any editor ends the edit,
  never the modal (`.elt, input, textarea` are exempt from the modal's capture-phase Esc). Verified
  against bd: rename + Enter-create through the modal landed with the right parent.

## per-agent tasks sidebar

- **Per-agent tasks in a RIGHT SIDEBAR (2026-08-26; replaced the short-lived Chat|Trace|Tasks mode
  the same afternoon)** — `renderAgentTasks` in app.js renders into `#aside`; `render()` toggles
  `.body-grid.withaside` (a third 320px column) + `#aside[hidden]` on whether an AGENT is focused —
  never for channels/Activity/the pad/board. The list sits BESIDE the chat rather than replacing it. **Global db, filtered — decided over per-repo:** every
  agent is pinned to `~/.beads` (BEADS_DIR shadows repo-local `.beads` on purpose; the per-repo dbs
  were merged in), so an agent's list is `agentTasks(tasks, name)` (pure, in web/app/tasks.js:
  assignee OR createdBy, case-insensitive) — a FILTER of the one list, never a second store. Editable
  via editlist.js; a row added under the "assigned to X" group is created with `-a X` (the api wrapper
  injects `assignee` into `op:create` — the one seam editlist offers; server `createTaskGetId`/
  `updateTask` accept `assignee`). Never rebuilds while a row is focused. Verified: a row added under
  research landed in bd assigned to research.

## PR beads

- **PR-type beads (2026-08-26):** `bd create "<t>" -t merge-request --external-ref <PR url>`
  (`merge-request` is a CUSTOM type — `bd config set types.custom merge-request` was needed once in
  the global db; `bd list --type` names it but `create` refuses it unregistered). `parseTasks` carries
  `type`/`externalRef`; `listTasks` enriches merge-request beads with the LIVE PR via
  `prInfoByUrl(url)` (src/git.ts — `gh pr view <url>` from $HOME, same parse + 60s cache as the PRs
  sidebar, keyed `url:<url>`, non-GitHub refs short-circuit to undefined). `prChipHtml` (taskspad.js,
  pure, tested) renders the sidebar's vocabulary — ⧉ merged / ◍ open / ◌ draft / ⊘ closed + ✓✕•
  checks — as a link in the pad row, the board card footer, and the modal title; an unresolved ref
  still links as "↗ PR". Demo bead: beads-nlz → caffeinum/paw#15. **They also join the PRs SIDEBAR** (`taskPrRows` in
  tasks.ts, pure/tested; `/api/prs` merges them ahead of the live agents' folder PRs, deduped by url
  so a folder PR with a review bead shows once — with the bead id as `◇ <id>` on the row's second
  line). The operator asked for this AS A COMMENT ON THE BEAD through the pad's card, and the reply
  went back the same way (`bd comment` as paw-folder) — the comment→bead→nudge loop, used in anger.

## closed beads

- **Closed beads stay visible for a week, at the bottom (2026-08-26):** `listTasks` = open work
  (`bd list -n 0` — bd's default cap is a SILENT 50 rows) + `--status closed --closed-after <7d>`
  (`CLOSED_WINDOW_DAYS`), `STATUS_RANK.closed = 8` so they sort last; `closedAt`/`closeReason` pass
  through (hover card: "closed 3h ago — reason"). Client: `closedLast` (taskspad.js, pure/tested)
  is applied by `treeOrder` at EACH level — closed top-levels after open ones whatever the drag order,
  closed children at the end of their parent's checklist; the board's Done column HOLDS them (dimmed,
  `bdone`) instead of being drop-only; the per-agent tab says "N open (+M done this week)"; the
  sidebar Tasks count is OPEN-only and `taskPrRows` drops closed review beads from the PRs sidebar.
  Verified headless: 71 rows, closed at the end at each level, count 22, Done column 43.

## test beads db (PAW_BEADS_DIR)

- **Tests select their beads db with `PAW_BEADS_DIR` (2026-10-03, `src/beads-dir.ts`)** — `bdEnv()` and the
  connector's injected `BEADS_DIR` both resolve through `beadsDir()` = `PAW_BEADS_DIR`, else `~/.beads`.
  bd's own `BEADS_DIR` is deliberately IGNORED by paw: every agent shell already carries it (the
  connector injects it) and an operator shell may carry one for some repo's tracker, so honouring it
  would silently redirect the fleet's list. Daemons inherit `PAW_BEADS_DIR` via daemonEnv, so test
  agents spawned in an isolated space file into the same throwaway db (`bd init` it first).
