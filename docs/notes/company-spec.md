# Company view — spec (PM, 2026-10-03)

Status: SPEC, not built. Owner of flows/data/scope: company-pm. Layout/visual: company-designer
(see "Visual spec" — the designer's section is authoritative where it disagrees on look).
Builder: company-builder. Index: [web.md](web.md), [tasks.md](tasks.md).

Operator's ask (aleks, verbatim): "a new page http://localhost:7788/new → input name of company →
select agents → creates a channel in cotal with these agents, and then shows paperclip ui at
http://localhost:7788/company/vibeos. each agent works on their beads, and work is structured like
that. use beads and cotal as storage, don't do any other storage (except maybe store my inputs or
states in my browser where relevant)." Also: "we have Board but it doesn't work well."

Out of scope by decree: approvals, budgets/spend, costs, hiring flows, heartbeats-as-scheduler.

---

## 0. MVP — information architecture (operator, 2026-10-03; supersedes earlier §0 cuts)

This section OVERRIDES §5, §8 and the designer's V-sections wherever they differ. Storage (§3) is
unchanged. Everything not listed here is LATER. Principle: **state lives in beads, talk lives in
cotal, actions live in the agents' traces** — the page shows those three, it never invents a fourth.

### 0.1 URLs (pushState; all served by the existing SPA fallback; absolute asset paths)

| url | level | what |
|---|---|---|
| `/new` | — | create a company |
| `/company/<slug>` | 0 | company home |
| `/company/<slug>/<agent>` | 1 | that agent's TASKS (default agent view) |
| `/company/<slug>/<agent>/dialog` | 2 | that agent's DIALOG |
| `/company/<slug>/<agent>/trace` | 3 | that agent's TRACE |
| `…?bead=<id>` | — | bead panel open over any of the above |

`<agent>` must be a member (or the operator → their "You" tasks); otherwise "<agent> is not in
<slug>" with a link home — never a guessed redirect. Agent views carry a breadcrumb
`<Company> › <agent>` and three tabs **Tasks · Dialog · Trace**. Browser back walks the levels.
Sidebar: "Companies" rows (+ "N on you" count) + "+ new company".

### 0.2 `/new`
Name (→ derived, editable slug), mission (optional), pick agents (checklist with live pip), **lead**
(one radio among the picked; default = first picked). Create = company epic bead
(`-l company:<slug>`, `metadata = {company:<slug>, org:{<agent>:{}…}}`, **assignee = lead**,
description = mission) → channel registry entry for `#slug` → `/api/invite` → kickoff post (§6).
Step list shows each step's result (errors verbatim); a failure after the bead → home with a retry
banner.

### 0.3 Level 0 — company home `/company/<slug>`
Operator: "the CEO agent talks to me and I give it tasks in random order; I can see progress on all
milestones." Three blocks:

- **(a) Chat with the lead** — the EXISTING paw web DM conversation + composer for the lead agent
  (same message list, pending/retry, drafts, `!cmd`, images, `/task` — whatever the agent chat view
  does today). Typing here = `/api/dm` to the lead. Header: lead name + live pip + "CEO". This is
  the primary surface; the operator hands work to the CEO here, the CEO turns it into beads.
- **(b) Milestones** — child epics of the company epic (§3.2 goals, called **milestones** in the UI;
  identified as: `issue_type == "epic"` AND `parent == <company epic>`; the `goal` label is optional
  — accept either, since the lead agent will create them with plain `bd create -t epic --parent`).
  Each row: title, assignee, progress bar + `done/total` over its whole subtree (closed / all
  descendants, from the company list which includes closed). Click → milestone expands to its
  beads (title + status + assignee; click a bead → bead panel). Company-level beads that sit
  directly under the epic and aren't epics are counted in a final "No milestone" row.
  No milestone UI for creating them in MVP: the CEO creates milestones (the §6 brief says how); a
  plain "+ milestone" input is allowed if trivial (`bd create -t epic --parent <epic> -l goal`).
- **(c) You** — the "You / waiting on you" items (§0.8), with Close/comment via the bead panel.
- **Team strip** — each member: name, live pip, ★ for the lead, `N open · M in progress`; click →
  level 1 for that agent.

### 0.4 Level 1 — TASKS `/company/<slug>/<agent>`
"I can look at any agent's current tasks and comment on them. Its state, not actions. All work
happens via beads/tickets." = the agent's company beads (assignee == agent), grouped by status
(in progress → blocked/waiting → open → done collapsed), each row title + status + milestone chip.
Click → **bead panel**: title, status, description, comments, add comment (plain = `bd comment`;
`@agent` = comment + DM, existing contract); on an operator bead also **Close** (optional reason).
**"+ add"** creates a bead assigned to this agent under the company (`bd create <t> --parent <epic or
chosen milestone> -a <agent> -l company:<slug>`) + ONE DM nudge (§5.4 text); under "You" it never
DMs. No status-editing for agent beads beyond what the existing panel ops offer — the agent owns
its state.

### 0.5 Level 2 — DIALOG `/company/<slug>/<agent>/dialog`
"I can open the agent dialog (like paw web does now) and see what it's doing; this is their
communication with each other." = REUSE paw web's conversation renderer (`renderMessages` row
markup, md, grouping, timestamps) over a wider message set:
- DMs where the agent is sender OR recipient — including agent↔agent, not just agent↔operator.
  Source: the same `ep.dmHistory` read paw web already does (src/feed.ts / web.ts `Conversation`),
  filtered to this agent, kept in a **separate store/admitter** from the operator's conversation (the
  web.ts rule: the human-scoped `Conversation` admitter must never be widened). Live updates via the
  existing whole-space `ep.tap`. Each row shows `from → to`.
- `#<slug>` channel messages sent by the agent or mentioning `@<agent>`, tagged `#slug`.
- dmHistory is god-view: on an auth mesh it throws — show "dialog unreadable: <error>" verbatim,
  never an empty conversation.
- Composer at the bottom = DM from the operator to this agent (existing `/api/dm`), same as the
  agent chat view today. New server route: `GET /api/dialog/<agent>?limit=` (+ `channel=<slug>`).

### 0.6 Level 3 — TRACE `/company/<slug>/<agent>/trace`
"I can look at the agent's trace, its action log." = REUSE paw web's existing trace view as-is
(`renderTrace` over `GET /api/trace/<name>?tail=&bytes=`, "load older turns", live refresh). No new
server work.

### 0.7 Reuse, not rebuild (builder guidance)
The company pages should live inside paw web's existing shell (`index.html` + `app.js` state/focus
model), not a separate `company.html`, so Dialog/Trace/lead-chat reuse the real renderers, composer,
drafts and pending logic. Where `app.js` hard-codes `#msgs`/`#trace` containers, lift the renderer
into a module that takes a container + list (`conversation.js` already holds the pure helpers)
rather than copying it. Any copy is a dated debt, like editlist.js vs the pad.

### 0.8 The operator is a team member agents can block on

 (operator, 2026-10-03: "there should be a way
for agents to be blocked on me, so I am also someone who's part of the team, but mostly they speak to
the CEO and it makes all decisions"):
- Operator name = `PAW_OPERATOR`, else the OS login (e.g. `aleks`; the fleet already assigns to
  `aleks`). Shown on the page as "You (aleks)" so a wrong resolution is visible. The operator is a
  member of EVERY company implicitly — NOT written into `metadata.org` (org lists agents only).
- **Blocked on you** = an open company bead that (a) is assigned to the operator, or (b) has a
  dependency of `type: "blocks"` whose `depends_on_id` is an OPEN company bead assigned to the
  operator. Pure bd data: `bd list --json` already carries `dependencies:[{issue_id, depends_on_id,
  type}]` (verified bd 1.2.2) — no extra bd call, no new storage. Note bd leaves the waiting bead's
  `status` as `open` (blocked-ness is computed), so the page computes it; closing the operator bead
  clears it with no further write. `parseTasks` must pass `dependencies` through (type `blocks` only).
- Display: home block (c) lists (a) and, under a "waiting on you" sub-heading, (b) each with its
  blocker's title; the same beads show "on you" in the owning agent's Tasks. Count on the (c)
  header and the sidebar Companies row (`vibeos · 2 on you`).
- Escalation is the LEAD's job, written into the §6 kickoff/instructions: members report to the lead
  by DM; only the lead escalates to the operator, by `bd create "<decision needed>" --parent <epic>
  -a <operator> -d "<context, options, recommendation>"` and, when other work waits on it,
  `bd dep add <waiting-id> <operator-bead-id>`. Agents never DM the operator for status. (This is how
  vibeOS already works: `beads-z32x` "decide: hosted AI…", `beads-cca6` "approve outreach…".)

### 0.9 API needed
`GET/POST /api/companies`; `GET /api/company/<slug>` (company, lead, operator, members with live,
issues with dependencies + labels + metadata); `POST /api/company/<slug>` ops `issue-create`,
`retry-channel` (+ `milestone-create` if the input is built); **new** `GET /api/dialog/<agent>`;
existing `/api/dm`, `/api/trace/<name>`, `/api/channel/<slug>`, `/api/tasks` ops
`comments`/`comment`/`close`.

### 0.10 Acceptance (isolated space + PAW_BEADS_DIR temp db; never the live db/mesh/agents)
§9 checks 1 (no roles/reports; assignee = chosen lead), 2, 3, 4, 8, 9, 10, 11, 12, plus:
- **13** home: typing in the lead chat delivers a DM to the lead (agent's inbox / `paw inbox --sent`),
  and the lead's reply renders there; milestones show correct `done/total` after closing one child
  (closed counted from the company list, not the 7-day window).
- **14** `/company/<slug>/<agent>/dialog` shows an agent↔agent DM between two test agents (not
  involving the operator) and a `#slug` post by the agent; on refusal it shows the error.
- **15** `/company/<slug>/<agent>/trace` renders the existing trace for that agent; back button
  returns to Tasks, then home.
- **16** `/company/<slug>/stranger` → "stranger is not in <slug>".

### 0.11 LATER (do not build now)
Channel join state, nudge state on cards, roles, reports-to, org chart, changing the lead, member
add/remove after creation, mission editing, activity feed, Untriaged + filing, ⚠ unlabelled fixing,
lane grouping switch / By-status company board, drag-and-drop, reassign/reparent UI, keyboard
shortcuts, milestone due dates.

## 1. Why the Board doesn't work (observed, live `?at=board`, 2026-10-03, read-only)

1. **No scope.** One global firehose: To do 106 · In progress 26 · Blocked 4 · Done 188, mixing
   mail, evals, queue, vibeOS and paw beads. There is no way to say "show me vibeOS". This is the
   root failure; everything else is secondary.
2. **No "who".** The only owner signal is 2-letter initials (`VL`, `AL`, `ET`, `QE`) — `VL` is
   `vibeos-landing`, which is no longer an agent name (the persona is `vibeos-ceo`; 9 open beads
   still carry the old assignee). Nothing says whether the owner is live, busy, or asleep.
3. **Parent cards balloon.** Sub-tasks render as an inline checklist inside the parent card, so one
   parent (the mail client) is a full screen tall and pushes everything else off.
4. **Done dominates.** 188 dimmed cards are the largest column; a week of closed work is louder
   than the 4 blocked items that actually need the operator.
5. **Counts disagree with bd** (Blocked 4 on the board vs 8 `blocked` in `bd list`) because blocked
   children are folded into parents — the number on the column header is not the number of
   blocked beads, and nothing says so.
6. **No structure above a task.** There are 163 beads, 1 epic, **0 labels**. Nothing groups work
   into goals/projects, so a kanban can only ever be a pile.

Fix: the Board is not deleted. The company page is the scoped, structured surface; inside a company
the kanban becomes one view (`Issues → by status`), with children collapsed to a `3/5` chip, Done
capped, and real per-agent ownership. The global `?at=board` stays as-is for MVP (later: add a
company/assignee filter chip row to it and collapse children there too — see §9).

## 2. How aleks actually runs a company today (vibeOS, observed)

- Agents: `vibeos-ceo` (lead, cwd vibeos-landing), `vibeos-pm`, `vibeos-yc`, `vibeos-intern`,
  `vibeos-writer`, `vibeos-vercel`, `vibeos-hexclave`, `vibeos-docker`, `vibeos-mcp`,
  `vibeos-legacy`. Roles live only in persona prose ("The team lead and CEO is vibeos-ceo",
  "To ask for work, file a bead to vibeos-ceo"). Reporting lines are implicit: everyone → ceo.
- Work is already beads: `bd create … -a vibeos-ceo -d "<user, hypothesis, metric, read date…>"`,
  `--parent` for steps, comments for handoffs, `aleks` as assignee for "decide/approve" asks
  (`beads-z32x` "decide: hosted AI…", `beads-cca6` "approve outreach…").
- So the company view must (a) give these existing beads a home without asking agents to change
  much, (b) surface "assigned to aleks" as the operator's queue, (c) make roles/reporting explicit.

## 3. Storage mapping (beads + cotal only; localStorage for UI state)

### 3.1 The company = one epic bead + one cotal channel

Slug rule: `^[a-z0-9][a-z0-9-]{0,40}$` (also a valid channel name under paw's existing
`/^[a-z0-9][a-z0-9_-]{0,63}$/i`). Display name = epic title. Slug = channel name = label suffix.

Company epic (created once, at `/new`):

```
bd create "<Display Name>" -t epic --silent \
  -a <lead> \
  -d "<mission, free text>" \
  -l company:<slug> \
  --metadata '{"company":"<slug>","org":{"<lead>":{"role":"ceo"},"<a2>":{"role":"pm","reportsTo":"<lead>"},…}}'
```

Verified on bd 1.2.2 in throwaway dbs (2026-10-03):
- **Labels INHERIT to children** by default (`bd create --parent X` copies all of X's labels;
  `--no-inherit-labels` opts out). So the ONLY label on the epic is `company:<slug>` — every goal and
  issue created under it (by the page OR by an agent with plain `--parent`) is in the company for
  free, and `bd list -l company:<slug>` returns the whole tree in one call. Roster/roles/reporting
  must NOT be labels, or every child would carry `member:`/`role:` junk.
- **Metadata does NOT inherit**, so the org lives in the epic's `metadata` JSON. Metadata keys must
  match `[a-zA-Z_][a-zA-Z0-9_.]*` (agent names have dashes → they can't be keys of
  `--set-metadata`), hence one `org` object keyed by agent name, written whole with
  `bd update <epic> --metadata '<full json>'` (server does read-modify-write inside tasks.ts's
  serialized `chain`; the page is the only writer of `org`). `--set-metadata company=<slug>` merges
  per key, so other metadata keys a human/agent adds are preserved — the server must also preserve
  unknown keys when it rewrites (read, mutate `org`, write back everything).

Fields:
- Root lookup: `bd list --metadata-field company=<slug> --all -n 0 --json` → must be exactly 1 row.
  0 → "no company <slug>" + link to `/new?name=<slug>`. >1 → fail loud naming every id.
  All companies: `bd list --has-metadata-key company --all -n 0 --json`.
- `assignee` = the lead (Paperclip's CEO). Change = `bd update <epic> -a <agent>` (+ make sure the
  lead is in `org` and has no `reportsTo`).
- `description` = mission. Edit = `bd update <epic> -d …`.
- Members = keys of `metadata.org`. Role = `org[a].role` (free text; absent → UI shows "—", never a
  guessed role). Reporting line = `org[a].reportsTo` (a member name; absent for the lead). A non-lead
  member with no `reportsTo` is drawn under the lead with a dashed "(default)" edge — visible, not
  silently invented. Cycles and unknown managers are refused at write (400 with the cycle named).
- Malformed `metadata.org` (not an object, member value not an object, `reportsTo` to a non-member)
  → the page renders the company with a red banner quoting the problem; it never "repairs" silently.

Cotal channel `#<slug>` (created at `/new`):

- Registry entry (makes the channel exist before anyone posts, and tells joiners the rules):
  `seedChannelRegistry({ servers, space, file: { channels: { <slug>: { description, instructions } } } })`
  from `@cotal-ai/core` (same call `paw cotal channels set <slug> --desc … --instructions …` makes).
  - `description` = mission (one line, truncated at 200 chars).
  - `instructions` = the company brief (§6). On an auth mesh this write is privileged — the refusal
    text is returned verbatim to the page; never swallowed.
- Membership: cotal has no "add someone"; joining is the agent's own act. Reuse `/api/invite`
  (DMs `inviteText(slug)` to each, posts "invited @a, @b to this channel"). The page then shows each
  member's channel state from evidence: `joined` if the durable members registry
  (`ep.channelMembers(slug)`) lists them OR they have posted in `#<slug>`; otherwise `invited`.
  If `channelMembers` is refused on the observer endpoint, say "membership unreadable (<error>)" in
  the lane header / Org node — never render a guess. The epic's `metadata.org` is the roster of record; the
  channel is the conversation.

### 3.2 Goals = child epics of the company epic

```
bd create "<goal title>" -t epic --parent <company-epic> -l goal -a <owner?> -d "<what done means>" --silent
# inherits company:<slug> from the epic; `goal` is added on top. NOTE `goal` then inherits to the
# goal's children too — so a goal is defined as: label `goal` AND parent == the company epic.
```

- Paperclip's Goals tree = direct children of the company epic that carry `goal`, and their
  descendants. Direct children WITHOUT `goal` are "company-level issues" (shown in a "No goal" group).
- Progress = closed / total over the goal's descendant beads (from the company list, which includes
  closed — §3.4). Displayed as `7/12`, never a percentage without the counts.

### 3.3 Issues = every bead labelled `company:<slug>`

- Create (from the page): `bd create "<title>" --silent --parent <goal-or-issue-or-epic> [-a <member>] [-d …]`
  — always with a parent inside the company (default: the company epic), so the label is inherited;
  the server additionally passes `-l company:<slug>` (idempotent) so a future bd default change
  can't silently drop it.
- Reparent: `bd update <id> --parent <new>` where `<new>` is inside the company; "detach" in the UI
  means `--parent <company-epic>`, never an empty parent. NOTE reparenting does not re-run label
  inheritance: moving a bead INTO a company from outside also needs `--add-label company:<slug>`
  (the `file` op does both).
- Assign: `bd update <id> -a <agent>`; status via existing `op:update status` / `op:close`.
- Comments: existing `op:comment` / `op:comments` (`bd comment <id> <text>`, `bd comments <id> --json`).
- Dependencies (display MVP, edit later): existing `blockedBy` enrichment.
- Membership in a company is the LABEL. Belt and braces: the server also computes descendants of the
  epic from `parent` over the global list; any descendant missing the label is shown with
  "⚠ unlabelled — fix" (`bd update <id> --add-label company:<slug>`). Never silently treated as in.

### 3.4 Untriaged = members' beads that aren't in the company yet

Existing vibeOS work has no labels. The Issues view has an **Untriaged** group: open beads whose
`assignee` or `created_by` is a member, without `company:<slug>`, and not under the epic. One-click
"→ file into company" = `bd update <id> --add-label company:<slug> --parent <goal-or-epic>` (goal
from a picker; default the company epic). Only a bead WITHOUT a parent outside the company is
reparented; a bead that already has a parent elsewhere keeps it and only gains the label (its
children then do NOT gain it — label inheritance is create-time only — so the UI offers "file with
subtree", which labels each descendant). Bulk "file all" with a confirm count. Nothing is auto-labelled.

Stale assignee names (e.g. `vibeos-landing`): an assignee that is neither a member nor a known agent
(status rows ∪ personas) renders as `⚠ vibeos-landing (no such agent)` with a "reassign" action. The
page never maps old→new names by guess.

### 3.5 Activity = channel + bead timestamps

Merged, newest first, from data that already exists:
- `#<slug>` messages (existing `GET /api/channel/<slug>?limit=…`).
- Bead events derived from fields on the company list: `created_at`+`created_by` → "created",
  `started_at` → "started" (assignee), `closed_at`+`close_reason` → "closed: <reason>",
  `updated_at` without a matching event → "updated" (only shown if within 24h, coalesced per bead).
- Comments: the feed shows `💬 N` deltas only for beads whose `comment_count` changed since the
  page's last poll (per-tab, in memory); the thread itself loads on issue open. MVP does NOT call
  `bd comments` per bead for the feed (each bd call boots dolt ≈1s).
- Later: `bd history <id>` for exact field diffs on an opened issue.

### 3.6 Browser-only state (localStorage, key prefix `paw.company.<slug>.`)

View toggle (lanes/kanban), collapsed goals, Done-collapsed, draft texts per composer (new issue,
comment per issue id), last-seen activity timestamp (for the "new since" divider), `/new` form draft.
Every access in try/catch; the page works with storage empty or throwing. Nothing that other
viewers or agents need lives here.

## 4. Server API (extends src/web.ts patterns; all errors pass bd/cotal text through, 502)

| route | method | does |
|---|---|---|
| `/api/companies` | GET | `bd list --has-metadata-key company --all -n 0 --json` → `[{slug, name, epic, lead, members, status}]`. Feeds the sidebar "Companies" section + `/new` slug collision check. 15s cache shared with tasks' `chain`. |
| `/api/companies` | POST `{name, slug, mission, lead, members:[{name, role?, reportsTo?}]}` | Validate (slug regex, slug unused, lead ∈ members, members are known agents, no reportsTo cycle). Then IN ORDER: (1) `bd create` the epic with `-l company:<slug>` + `--metadata` (§3.1) → id; (2) `seedChannelRegistry` for `#slug` (desc+instructions); (3) `/api/invite` logic for every member except none (all are agents); (4) post a kickoff message in `#slug` (§6). Returns `{slug, epic, invited, failed, channelError?}`. A failure at (1) aborts. A failure at (2)–(4) returns 200 with the error fields set — the company exists (the bead is the record) and the page shows a banner with a "retry channel setup" button; never pretend success. |
| `/api/company/<slug>` | GET | `{company, members:[{name, role, reportsTo, live, busy, state, joined}], issues:Task[], errors}`. `issues` = `bd list --label company:<slug> --all -n 0 --json` (ONE bd call, closed included so goal progress is right) ∪ unlabelled descendants of the epic (from the cached global `listTasks`), each flagged `unlabelled:true`. `untriaged` = §3.4 from the cached global list. Members' live/busy from the status the server already polls. `joined` per §3.1. 15s cache, invalidated by any company write. |
| `/api/company/<slug>` | POST `{op, …}` | `op: member-add {name, role?, reportsTo?}` (org metadata + invite DM), `member-remove {name}` (drop from `org` only, refused if others report to them; never despawns or leaves the channel for the agent — say so in the UI), `member-set {name, role?, reportsTo?}`, `lead {name}`, `mission {text}` (epic description + registry description), `goal-create {title, description?, owner?}`, `file {ids:[…], parent?}` (add `company:<slug>` label, optional reparent), `retry-channel`. |
| `/api/tasks` | POST (existing) | Extend: `op:create` accepts `labels:string[]` (→ `-l`); `op:update` accepts `addLabels`/`removeLabels` (→ `--add-label`/`--remove-label`). `parseTasks` passes `labels`, `metadata`, `started_at` through (`Task.labels?: string[]`, `metadata?`, `startedAt?`). Everything else reuses existing ops. |
| `/api/channel/<slug>` | GET/POST (existing) | Activity feed + posting in the company channel. |
| `/api/dm` | POST (existing) | Assignment / mention nudges (§5.4). |
| `/api/invite` | POST (existing) | Reused by create + member-add. |

All writes still go through tasks.ts's serialized `chain` (dolt is single-writer). The company epic
create is one `bd create` with all labels (one dolt boot), not N label calls.

## 5. User flows

### 5.1 `/new` — create a company
1. Field: **Name** ("vibeOS"). Slug auto-derived (`vibeos`), editable, live-validated against the
   regex and `/api/companies` (taken → "vibeos exists — open it" link).
2. Field: **Mission** (one-liner, optional but prompted: "what is this company for?").
3. **Agents**: checklist of all agents from status rows (registered + live), showing live dot, cwd
   basename, current in_progress bead title. Filter box (typing `vibeos` narrows). Pre-check none.
4. For each checked agent: **role** (free text with suggestions ceo/pm/eng/research/writer/infra/
   advisor) and **reports to** (select among checked; default = lead). Exactly one **Lead** radio.
5. **Create** → POST `/api/companies` → spinner lists steps live ("bead ✓ · channel ✓ · invited 9/10
   · ⚠ vibeos-legacy: <error>") → redirect to `/company/<slug>` when the bead exists (even if a later
   step failed; the banner carries the failure).
6. `/new` form draft persists in localStorage until created.

### 5.2 `/company/<slug>` — company home (agreed with company-designer 2026-10-03)
Header topic: name, mission (click to edit), `#slug · N agents · N open · N goals`. The member
roster is NOT a separate strip — it lives in the agent lane headers and the Org tab; each member's
live/busy/asleep pip AND channel state (`invited` / `joined` / `membership unreadable`) must be
visible there. Three tabs, URL `?v=work|org|activity`, keys 1/2/3:

- **Work** (default) — answers "what's everyone doing and what needs me", top to bottom:
  (a) **Needs you** — beads assigned to `aleks` + `blocked` + stale `in_progress` (no update >24h);
  max 5 rows + "N more"; rendered ONLY when non-empty. (b) **Goals** tree with `closed/total` per
  goal; clicking a goal filters the lanes (filter chip shows it; ✕ clears). (c) **Lanes**, grouping
  toggle by agent (default) / status / goal. Agent lanes: lead first then org order; header = pip,
  name, role, channel state, "now: <in_progress title>" / idle / asleep (this replaces a separate
  "Now" list). Then `Unassigned`, a stale-assignee lane per unknown name ("⚠ vibeos-landing (no such
  agent)" + reassign), and **Untriaged** last, collapsed by default, count + "file all". There is no
  `aleks` lane — aleks-assigned work is in Needs you; the assignee picker still offers aleks.
  By-status = the fixed Board (Done collapsed, last 7 days). Cards: title, id, goal chip, assignee,
  💬N, ⛓N, children as `3/5` (never inline checklists), nudge state. Drag between agent lanes =
  reassign (+nudge); between status columns = status; onto a goal = reparent. "⚠ N unlabelled" is a
  chip in the filter line. Activity is a 320px right rail on Work at ≥1100px.
- **Org** — tree from `metadata.org[*].reportsTo` rooted at the lead (above it: "aleks — board");
  node = name, role, pip, channel state, `open · in progress` counts; dashed edge for a default
  line. Click node → Work filtered to that agent. Edit role/reports-to inline (member-set).
- **Activity** — §3.5 feed, full width (the same feed as Work's rail below 1100px), filter chips
  (all · channel · beads · one agent), composer posts to `#slug`.

### 5.3 Issue detail (drawer over the company page; `?issue=<id>` deep-links)
Title (editable), status chips (existing move semantics, bd refusal shown verbatim and reverted),
assignee picker (members + aleks), parent picker (goals + issues in this company; "company root"),
description (editable), children list (editable via editlist.js, new rows inherit the company label
and this parent), blocked-by chips, merged thread — bead comments + `#slug` messages that mention the id, each tagged with its source (filtered client-side from the channel history already loaded; no extra bd call) — and a composer. Composer: plain text = `bd comment`;
`@agent text` = comment + DM nudge (existing pad/board contract, unchanged).

### 5.4 How agents are told about work (no new mechanism)
- **Assignment nudge**: when the operator assigns or reassigns from the page (picker, lane drag, or
  creating an issue with an assignee), the server DMs the assignee:
  `"<company>: you've been assigned beads-xxxx — <title>. bd show beads-xxxx for details; claim it with bd update beads-xxxx --status in_progress."`
  One DM per assignment, not per edit. The UI shows "nudged ✓" / "nudge failed: <error>" on the card.
  Assigning to `aleks` never DMs.
- **@mention** in a comment → DM (existing).
- **Channel**: `#slug` is where the team talks; the kickoff and instructions (§6) tell them so. The
  page does NOT post every bead change into the channel (that is the flood we avoid — "don't flood DMs").
- Waking: a DM to a sleeping agent wakes it via the existing sleep host; invites are sequential
  (existing anti-thundering-herd behaviour). Never restart/attach an agent from this page.

## 6. The company brief (channel `instructions` + kickoff post)

```
#<slug> is the <Name> company. Mission: <mission>.
Lead (CEO): <lead> — makes the decisions. Members: <a>, <b>, …  Operator: <operator> (a human).
How we work:
- report to <lead> by DM: progress, questions, blockers. Do not DM <operator> for status.
- <operator> gives work to <lead> in chat; <lead> turns it into beads and assigns them.
- <lead> keeps milestones: bd create "<milestone>" -t epic --parent <epic-id> -l goal; work for a
  milestone goes under it (--parent <milestone-id>). Progress = closed/total of its subtree.
- only <lead> escalates to <operator>: bd create "<decision needed>" --parent <epic-id> -a <operator>
  -d "<context, options, recommendation>"; if work waits on it: bd dep add <waiting-id> <that-id>.
  <operator> answers by commenting and closing that bead, which unblocks the waiting work.
Work lives in beads (~/.beads, your BEADS_DIR):
- every bead for this company carries company:<slug> — create under the company: --parent <epic-id>
  (the label is inherited) or add -l company:<slug>.
- your queue: bd list --label company:<slug> -a <you>
- claim before starting (--status in_progress), close with a reason, comment handoffs on the bead.
- ask a teammate for work by filing a bead assigned to them.
Talk here in #<slug>; DMs for 1:1 with <lead>.
```

The same text is posted once as the kickoff message after invites. Persona files are NOT edited
(personas are the registry; prose stays the operator's).

## 7. Navigation & routing

- paw web's sidebar gains a **Companies** section (from `/api/companies`): one row per company +
  "+ New company" → `/new`. The global Board/Tasks stay.
- `/new` and `/company/<slug>` are served by the existing SPA fallback in `serveStatic`.
  **Gotcha:** `index.html` loads `./app.js` relatively — under `/company/vibeos` that resolves to
  `/company/app.js` → 404. Builder must make asset URLs absolute (`/app.js`, and the module imports
  resolve relative to `/app.js` then, which is fine) — check every `src=`/`href=`/`import` and
  `fetch` (all fetches are already absolute `/api/...`).
- Company views are FOCUS TARGETS like Tasks/Board (`render()` reconciles from state; exactly one
  sidebar row lights; selecting another sidebar row leaves; Esc never ejects from the company page — it closes the drawer/menus, else clears the goal filter, per V3/V10). The URL path is the state for these two routes; `?v=` and
  `?issue=` are the sub-state. Back/forward work (pushState).

## 8. MVP vs later

**Original MVP (superseded by §0 — kept as the roadmap):**
1. `/new` create flow (§5.1) with roles, reports-to, lead; POST `/api/companies`.
2. `/company/<slug>`: Work tab (Needs you, Goals, lanes by agent/status/goal, Untriaged + file
   action, activity rail); Issue drawer (§5.3); Org tab; Activity tab (§3.5).
3. Goal create; issue create in a lane/goal; reassign/reparent/status; assignment nudge DM.
4. Org tab from `metadata.org`, with member-set editing inline.
5. `/api/tasks` label passthrough; `Task.labels/startedAt`.
6. Sidebar Companies section.

**Later:**
- Global Board: company/assignee filter chips, children collapsed to `n/m`, Done collapsed.
- `bd history` field diffs in the issue drawer; per-comment activity entries.
- Dependency editing (`bd dep add`), priority editing, drag-ordering within a lane.
- Org chart drag-to-reparent; "chain of command" escalation button (reassign to manager + comment).
- Company archive (`bd close <epic>` + channel description "archived").
- Stale-work detector tuned per role; "status cards" equivalent.

## 9. Acceptance checks (builder runs ALL in an isolated space — never the live db/mesh)

Setup: `PAW_HOME=$(mktemp -d) PAW_SPACE=test-$$ PAW_RELEASE=dev` plus `BEADS_DIR=$(mktemp -d)/.beads`
with `bd init` (the live `~/.beads` must not be written by tests). A paw web on a non-7788 port.

1. `/new` with name "Test Co", 3 agents, lead A, B reports to A, C role "writer" → exactly one epic
   bead (`bd list --metadata-field company=test-co --all --json`) with labels `[company:test-co]`
   only, `metadata.org` = `{A:{role:…}, B:{reportsTo:A,…}, C:{role:"writer"}}`, assignee A,
   description = mission. A goal + issue created under it carry `company:test-co` and NO org data.
2. `paw cotal channels list` shows `#test-co` with the mission description and instructions; each
   agent received the invite DM (`paw inbox --sent` or the channel's "invited @A, @B, @C" line).
3. Browser at `/company/test-co` loads (no 404 for any asset — check network log); the 3 agent
   lanes show pip + role + invited/joined state from evidence; Needs you is absent when empty.
4. Create a goal and an issue in B's lane → `bd show` has `company:test-co`, parent = goal,
   assignee B; B got exactly one assignment DM.
5. Drag the issue to C's lane → assignee C, C nudged, B not re-nudged; drag to Blocked column →
   status blocked; a bd refusal (close with open blocker) reverts the card and shows bd's text.
6. A bead assigned to B without the label appears in Untriaged; "file into company" adds the label
   and it moves into B's lane. A bead under the goal created without the label shows the
   "⚠ unlabelled" action and still appears.
7. Activity shows the kickoff message, the goal/issue "created" events, and the close with reason.
8. `/company/nope` → "no company nope" + link to `/new?name=nope`; two company epics with the
   same slug (`metadata.company`) → page names both ids (fail loud).
9. localStorage disabled (throwing) → page still renders and works.
10. Computed-style check (not class flags) that the drawer and company page are actually visible /
    hidden (the taskspad `[hidden]` lesson), plus the `CLIENT_BUILD` stamp visible.
11. `pnpm typecheck` + `pnpm check:web` green, new pure helpers (label parsing → company model,
    org tree + cycle check, activity merge, untriaged filter) unit-tested in check:web.

## Visual & interaction

(company-designer owns everything below this heading: layouts desktop+phone, components, nav fit,
keyboard, board fixes. PM owns everything above. Where this section and the flows above disagree on
look, this section wins; on data/scope, the flows win.)

Mock: [company-mock.html](company-mock.html) — static, fake data, open it in a browser. Top-left
switcher: `/company/vibeos` · `/new` · empty company. Keys work in the mock. Resize below 1100px and
860px to see tablet and phone.

### V1. Principles
- **Reuse paw web, don't invent a design system.** Every colour is an existing token (`--content`,
  `--content-alt`, `--line`, `--txt`, `--txt-dim`, `--link`, `--selected`, `--green`, `--amber`,
  `--red`). Status colours are the ones already in tasks/board CSS (`#4a9eda` progress, `#d05548`
  blocked, `#4caf7d` done) — lift them into tokens `--prog`/`--blocked`/`--done` in index.html so the
  pad, board and company share them. Reused as-is: `.chead` + `h1` + `.topic`, `.modes` (the tab
  control), `.btn`, `.pip.on|busy|off`, `.av` + `avatarColor(name)`, `.tag`, `.mst` status chips,
  `.aside` geometry (320px, `--content-alt`, left border), breakpoints 1100 / 860, the phone
  sidebar drawer + `.menu` button. Status glyphs are the pad's vocabulary: ○ open · ◐ in progress
  · ⊘ blocked · ✓ done.
- **Content palette, never aubergine** inside the page (the Board lesson: aubergine cards were
  unreadable in light mode).
- New CSS is prefixed `.co-` (or scoped under `#company`) and lives in index.html next to `#board`.
  Remember `#company[hidden]{display:none}` — the taskspad lesson.
- **Density:** 13–14px body in cards, 11–12px meta, 15px for page body text. One line of meta per
  card, max 2 lines of title (`-webkit-line-clamp:2`). Nothing in a card grows with data.

### V2. Navigation
- Sidebar: new **Companies** section between the Tasks/Board/Village rows and Channels, same `.sec`
  fold header with count. Row = `▣` glyph (in the `.hash` slot) + company slug + open-issue count
  (dim, like the Tasks count — NOT the red unread badge; open work isn't unread). Last row `+ new
  company` at `.addrow` opacity → `/new`. Active row uses the existing `.row.active`.
- Companies are focus targets (§7): exactly one sidebar row lit; Esc from the company page with no
  drawer open does nothing (it's a page, not an overlay — Esc only closes the drawer/menus).
- `#slug ↗` button in the header right opens the channel in the normal chat view (same app, no new tab).
- ⌘K palette: companies listed as `▣ vibeos` targets, plus "New company".

### V3. `/company/<slug>` layout
Header (`.chead`): `h1` = display name · `.topic` = `#slug · N agents · N open · N goals` · right:
`.modes` tabs **Work · Org · Activity** (keys 1/2/3, URL `?v=`) + `#slug ↗`.

**Work** (desktop ≥1100: grid `1fr 320px`; the right column is the Activity rail):
1. **Needs you** — bordered box, 3px `--red` left edge, title "NEEDS YOU · N" in `--red`. Rows:
   status glyph · title · right-aligned reason in 11px dim ("assigned to you · <who> asked 2h ago" in
   red; "blocked · vibeos-pm · 1h"; "in progress, silent 2d · vibeos-docker"). Max 5 + "N more"
   (expands in place). Click → drawer. **Not rendered at all when empty** — no "all clear" box.
2. **Mission** line (13px dim, "Mission ·" bold) — click to edit inline (contenteditable, blur
   saves, Esc reverts). Empty mission shows "add a mission" at .4 opacity.
3. **Goals** — `co-h` label row ("GOALS" 11px caps dim + `+ goal` small btn right). Each goal row is
   a 4-column grid: chevron · title (ellipsis) · 120px stacked progress bar (done/progress/blocked
   segments in the status colours over `--line`) · `closed/total` tabular-nums. Sub-goals indent
   28px, 13px, dim. Click a goal = select (3px `--selected` inset left edge + `--content-alt`) AND
   filter the lanes (chip in the filter line); click again or ✕ on the chip clears. Double-click /
   Enter on a selected goal opens it in the drawer (goals are beads too).
4. **Filter line** — pill chips: active goal (✕), `blocked only`, `show done`, `⚠ N unlabelled —
   label them` (amber, only when N>0), and the grouping segmented control **agent · status · goal**
   right-aligned. Grouping + chips persist in localStorage per company.
5. **Lanes** — horizontal row of 272px lanes, gap 12px, page-padding 20px; the lanes area scrolls
   horizontally inside the pane (never the page). Lane = `--content-alt` box, radius 10, 1px `--line`.
   - **Agent lane header:** 24px `.av` · name (14px 900) · ★ if lead · `.pip` · count bubble. Line 2
     (12px dim, indented under the name): role ("—" if none) · channel state (`joined` dim;
     `invited` amber; `membership unreadable` red with the error in `title`). Line 3: a "now" box
     (`--content` bg, 1px line): `now  <in_progress title>`; idle → italic dim "idle — nothing
     claimed"; offline/asleep → "asleep · DM wakes it". Clicking the now box opens that issue.
   - Order: lead first, then org (BFS) order; then **Unassigned** (grey `?` avatar, hint "drag onto
     an agent to assign (DMs them)"); then one **⚠ <name>** lane per stale assignee (amber name,
     "no such agent — old name?" + `reassign all…`); then **Untriaged**, collapsed to a 200px header-
     only lane with count + `show` / `file all…` (file all asks to confirm with the count).
   - **Cards** (see V5). Within a lane: in_progress, blocked, open; then a fold "▸ ✓ N done this
     week" (expands to dimmed struck-through cards). `+ new issue  [c]` at the bottom: becomes an
     inline single-line input in place (Enter creates in this lane with the active goal as parent,
     Esc cancels, text kept as a draft).
   - **Group by status** = the fixed Board: columns To do / In progress / Blocked / Done, same card,
     Done collapsed to a fold. Column count = the number of beads shown in it (no hidden children
     inflating/deflating it). **Group by goal** = one lane per goal + "No goal".
6. **Activity rail** (right, ≥1100 only) — see V7.

**Org** — centered top-down tree. Root "aleks · you · the board" (`--content-alt`, 150px), then the
lead, then reports. Node 208px card: 28px avatar · name · ★ · pip right · role line · channel state
· "◐ <now title>" or idle/asleep · "N open · N done this week". Connectors are 1px `--line`, rounded
corners at the elbows. A member with no `reportsTo` hangs under the lead with a **dashed** node
border and the tooltip "no reports-to — placed under the lead by default". Click a node → Work tab,
scrolled to that agent's lane, first card selected. Hover a node → small `edit` link → inline role
input + reports-to select (member-set). MVP: no drag.

**Activity** tab — the same feed as the rail, centered at max-width 760, plus agent filter chip and
a composer at the bottom that posts to `#slug` (reuse the chat composer component, not a new one).

### V4. Phone (≤860px) and tablet (≤1100px)
- ≤1100: the Activity rail is dropped (Work = one column); Activity tab is its home. Same rule as
  `.aside`.
- ≤860: sidebar becomes the existing drawer (☰). Header wraps like chat (`.right` stays on the title
  row, `.topic` gets its own line); `#slug ↗` hides (the sidebar has the channel).
  **Lanes stack vertically, full width** — no horizontal scroll anywhere on the page (verified in
  the mock: `scrollWidth == 390` at 390px). Tapping a lane header collapses/expands it; collapsed
  state persists. Goal rows shrink the bar to 64px. Needs-you reasons wrap under the title.
  Org becomes an indented list (each level 18px + a left rule) instead of a tree.
  Drawer = full-screen sheet with ✕ top-right. Drag is desktop-only; on touch, reassign/status/
  reparent are in the drawer (pickers) — every drag action has a non-drag path.

### V5. Issue card
Grid `16px 1fr`. Col 1: status glyph (click = cycle ○→◐→✓, blocked→○; same optimistic + revert-with-
bd's-words contract as the pad; refusal text shows under the card in `--red` 11px for 6s and stays
in `title`). Col 2: title 13px/600, 2-line clamp. Meta line 11px dim, single line, in this order and
only when present: id (mono 10.5px) · `⛓ <blocker short id>` (red) · `☰ 2/3` children · `◎ <goal>`
(only when grouping isn't by goal) · `◍ PR ✓` (prChipHtml vocabulary) · `💬 N` · `nudged ✓` /
`nudge failed` (green / red, for 30s after an assignment, then gone; failure stays until retried)
· relative time right-aligned (`updated_at`). No description, no inline checklist, no initials
avatar (the lane IS the assignee; in status/goal grouping, a 16px `.av` + name replaces the time).
Hover: border darkens; selected (keyboard): 2px `--selected` outline. Dragging: .5 opacity, lane
under the pointer gets a dashed `--selected` border.

### V6. Issue drawer
Right-side panel over the page (not a centered modal — the Board's modal hid the context you were
deciding in): width `min(520px,100%)`, full height, `--content`, left border + soft shadow; the
lanes stay visible and keyboard-navigable behind it (j/k with the drawer open moves the selection
AND swaps the drawer content). Top bar (12px dim): breadcrumb company › goal › parent (ellipsis),
id pill, `↗` (open in Tasks pad), ✕. Body: `.mst` status chips row → title (20px/700,
contenteditable) → properties grid (96px key column): assignee (picker: members + aleks, shows pip),
goal/parent (picker), blocked by (red mono pills + reason), PR, created by/ago → description
(editable, `pre-wrap`) → **Sub-issues** with `n/m` (editlist.js rows) → **Thread**: one merged
timeline, oldest first, auto-scrolled to the newest. Entry kinds: system lines (dim, 12px, glyph
bullet: "filed under <goal>", "claimed", "closed: <reason>") and messages (28px avatar, name, a
source tag — `💬 bead` grey or `# slug` link-blue — time, body via md.js). Composer pinned at the
bottom: textarea (placeholder "comment on <id> — @agent pings them"), `☐ also post in #slug`,
`⏎ send · ⇧⏎ newline`, green `Comment` button. Draft per issue id persists (localStorage).

### V7. Activity feed
Rows: 22px avatar · **who** · dim verb · link-blue mono id (opens drawer) · `· 12m`; optional quote
line (2-line clamp, 2px left rule) for comments, channel messages and close reasons. Day dividers
("TODAY", "YESTERDAY", date) in 11px caps. Filter chips `all · issues · chat` (+ agent on the full
tab). A "new since you last looked" red line (the chat `.newline` style) at the last-seen timestamp
(localStorage). Newest first in the rail and the tab.

### V8. `/new`
Single centered column, max-width 620, page padding 32/20. Title "New company" 22px/900 + one-line
lede. Fields: **Name** (display) → derived **slug** row under it (`#` + small mono input, "derived
from the name until you edit it"; once edited it stops following) → live help line: valid → "becomes
channel **#slug** and page `/company/slug`"; invalid → red rule text; taken → red "#slug already
exists — open it". **Mission** (placeholder "what is this company for?"). **Crew**: a search box +
list (max-height 260, scrolls) of every agent: checkbox · avatar · name · cwd (mono dim) · right:
pip + "in <company>" if already a member somewhere. ↑/↓ move a highlight, Space toggles, typing
filters. Selected agents appear below as rows: avatar · name · role input (datalist suggestions
ceo/pm/eng/research/writer/infra/advisor) · `◉ ★ lead` radio · reports-to select (hidden for the
lead; options = other selected agents; default the lead) · ✕. First checked agent becomes lead.
**Preview** box (dashed border, dim): "Create will: open #slug and invite N agents (…); file the
company epic bead (label, metadata.org, mission as description); post the kickoff in #slug" — it
updates live and is the operator's last look at what's about to happen on the mesh.
Footer: green **Create company** (disabled until name valid + not taken + ≥1 agent + one lead),
`Cancel`, hint `⌘⏎ create · esc cancel`. On create the footer turns into the step list (✓ green /
◐ amber running / ⚠ red with the error text verbatim / ○ pending); on bead success it navigates to
the company page after 600ms, carrying any failure into the page banner (amber left edge, text +
`retry channel setup`). The form draft persists until created.

### V9. Empty, loading, error states
- **No companies** (sidebar): Companies section shows only `+ new company`.
- **Company with no goals**: Goals block = dashed box "No goals yet — a goal is what the crew is
  for" + `+ add the first goal`. Lanes still render.
- **Agent lane with nothing**: dashed inner box "nothing assigned" + `+ new issue`.
- **Needs you empty**: not rendered.
- **Loading**: render header + lane skeletons from the cached `/api/companies` row instantly (names,
  counts); never a full-page spinner. A bd call in flight shows `saving…` on the touched card only.
- **Errors** fail loud, in place: `/api/company` failure → red banner under the header with the
  server's text verbatim + retry; malformed `metadata.org` → red banner quoting the problem; a card
  write refusal → bd's words under the card. `/company/<unknown>` → empty state "no company
  <slug>" + `create it` → `/new?name=<slug>`; duplicate roots → red banner naming every id.
- Visible `CLIENT_BUILD` stamp in the Work filter line hint (dim, right), like the pad.

### V10. Keyboard
Active only when focus is not in an input/textarea/select/contenteditable (Esc there = blur/revert).
| key | does |
|---|---|
| `1` `2` `3` | Work / Org / Activity |
| `j` `k` | next / previous card in the lane (first press selects the first card) |
| `h` `l` | previous / next lane, keeping the row index |
| `⏎` | open the selected card in the drawer |
| `esc` | close drawer → else clear selection → else clear goal filter |
| `s` | cycle status of the selected card |
| `c` | new issue in the selected card's lane (or the first agent lane) |
| `a` | assignee picker for the selected card (reuses the ⌘K palette UI, filtered to members + aleks) |
| `g` | group-by cycle agent → status → goal |
| `/` | focus the top filter (filters cards by title/id within the company) |
| `⌘⏎` | on /new: create; in the drawer composer: send |
Option-↑/↓ keeps its existing meaning (steps sidebar targets, Companies included).

### V11. What this fixes from the Board (maps to §1)
1. No scope → the page IS a scope (company), plus goal filter chip.
2. No "who" → lanes are people: full name, pip, role, channel state, and what they're on now; stale
   names get their own amber lane instead of hiding behind initials.
3. Ballooning parents → children are a `☰ n/m` chip; the checklist lives in the drawer only.
4. Done dominates → Done is a per-lane fold ("✓ N done this week"), collapsed by default.
5. Counts disagree → a column/lane count = cards shown in it; children never counted silently.
6. No structure → goals tree with progress on top; group-by-goal.
7. Modal hides context → side drawer; j/k keep working behind it.
8. Phone: 4×280px columns scrolled sideways → stacked lanes, no page h-scroll, drawer as a sheet.
9. Drag-only status → glyph click, `s`, drawer chips; every drag has a non-drag path.
10. Nothing says "needs you" → Needs-you box first, only when non-empty.
