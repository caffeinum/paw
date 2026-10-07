# personalities (brainstorm, 2026-10-06)

Index: [CLAUDE.md](../../CLAUDE.md). Status: **implemented 2026-10-06** (see "Implemented" at the end;
the operator's answers there override the proposal below where they differ). Question from the
operator: should paw agents get random personalities, ideally ones that match their repo, and does
cotal's persona format support "personalization"?

Short answer: cotal has no personality fields, but its agent-file format already carries everything
needed. Flat frontmatter keys travel to the agent's presence card, and the body reaches the model.
Recommended shape: three flat keys (`vibe`, `emoji`, `hue`), drawn at birth by a seeded generator
weighted by the repo's domain. paw renders them as **one short VOICE line** in the brief and shows
`emoji`/`hue` in its UIs. Opt out with `personality: none`. Claude agents already all share one
personality (aeon), so each agent is framed as *a different cat*.

## 1. What cotal's format actually supports (0.58 / 0.66 dist, read from node_modules)

`@cotal-ai/core` `AgentDef` (core/dist/agent-file.d.ts) models: `name, role, kind, description, tags,
agent, subscribe, allowSubscribe, allowPublish, quiet, muted, model, variant, launchOptions,
capabilities, owner`, plus `meta` and `persona` (the markdown body).

- **No style/voice/avatar/emoji/color field exists.** Nothing in core, connector-claude-code or the
  manager knows about personality.
- **`meta`:** every *scalar* frontmatter key cotal doesn't model is swept into `def.meta` as a string
  (agent-file.js about line 150: `if (!known.has(k) && v !== null && typeof v !== "object")`). paw
  already relies on this for `resume`, `cwd`, `paw-kind`, `headless`, `hibernate`, `shareTools`, …
- **Nested maps are silently dropped from meta** (`typeof v !== "object"`). A `personality:` *block*
  would parse without error but never reach the card, and paw's line-based `setPersonaKeys` would
  mangle it. → **use flat keys.**
- **meta reaches the wire.** The MCP server builds the presence card from the agent file
  (connector-claude-code/dist/mcp.cjs about line 67475: `role, description, tags, meta: def?.meta`),
  and `AgentCard.meta` is "free-form advisory display metadata". So `emoji:`/`hue:` in a persona
  are **broadcast in presence for free**, and any roster reader (paw status, web, village, the telegram
  bridge, other agents' `cotal_roster`) can show them without reading persona files. Reserved meta
  keys to avoid: `connector, model, provider, host, cwd, repo, branch, head, sessionKind, sessionId`.
- **`role`** is functional, not cosmetic: `cotal_anycast(role, …)` routes on it. Never put a
  personality in `role`.
- **`description`** is the one-line card summary (`cotal personas list` falls back to the body's
  first line). It describes the job, not the voice.
- **How the body reaches the model:** claude connector → `--append-system-prompt-file
  <tmp>/persona.md` (body only, no frontmatter). paw's `appendSystemPrompt` (src/connector.ts) then
  writes a sibling `paw-brief.md` = **persona body + "\n\n" + mesh brief**, one flag. kit:
  `readKitPersona` takes `def.persona` and paw writes brief + body to its `--append-system-prompt-file`.
  Headless uses the same connector path. So anything paw renders lands in the system prompt for
  claude, kit and headless alike.
- **Today's bodies** are almost all one generic birth line (`ensurePersonaFile`): *You are the paw
  agent for the "queue" folder — a peer on the cotal mesh, acting unattended on this repository.*
  The exceptions are hand-written: `evals-reviewer` (job + "keep replies short and concrete") and
  `aleks-twin` (a full voice spec: message length, lowercase, favourite words, how he says yes/no).
  **aleks-twin already is a personality**, and it shows the format works.

### The personality agents already have
Every **claude** agent loads the operator's `~/.claude/CLAUDE.md` + `SOUL.md`: lowercase, terse,
"feral cat", "you are aeon, an uploaded cat", "meow", cat puns. So the 20-odd claude agents today are
**all the same cat**. kit agents (codex/grok) most likely don't load `~/.claude/CLAUDE.md` (unverified;
check kit's prompt assembly), so they are voiceless. A new personality layer therefore collides with,
and has to sit on top of, the aeon soul. It doesn't replace it.

## 2. Design options

| | what | for | against |
|---|---|---|---|
| a | personality frontmatter (name/vibe/voice/quirks/emoji/color) rendered into the brief | explicit, editable, diffable | hand-authored for 25 agents is chore work; a nested block is dropped by cotal |
| b | generated at birth from the repo (README, language, package.json, folder name) | fits the job: terse SRE for infra, sceptic for evals | needs an LLM or heuristics at birth; repo-derived traits can drift into *competence* claims ("expert reviewer") that change behaviour |
| c | seeded random (`seed = name`) from curated trait tables | deterministic, reproducible, rerollable, matches the operator's seed-design habit, no LLM call | pure random can mismatch the job (a chatty bard on the incident queue) |
| d | personality in the UIs (emoji, colour, village station glyph) vs only in the model's voice | UI identity is **zero-risk** to task quality and the biggest legibility win across 25 agents | voice-only is what makes it fun; UI-only is just an avatar |

### Trade-offs
- **Task quality / instruction-following:** style persona lines barely move accuracy. *Competence*
  personas ("world-class X") and *risk-posture* traits ("bold", "move fast") are what hurt, and with
  `bypassPermissions` a "yolo" vibe is a real hazard. Restrict the trait vocabulary to style axes
  only: verbosity, warmth, humour, formality, metaphor domain, sign-off. Caution, autonomy, honesty
  and thoroughness are **never** traits.
- **Token cost:** the brief is already ~1.5k tokens. A ≤60-token VOICE line is under 5%, paid once
  per session and then prompt-cached. Changing a personality busts the cache once.
- **Consistency:** the system prompt survives compaction (it isn't in the transcript), and a seeded
  persona key is stable across restarts. A personality edit only lands on the **next** spawn. paw
  must never restart a live agent to apply one; it applies at the next natural restart.
- **kit agents:** they get the same line via kit's brief. For them it is the *only* voice, since
  there is no aeon, so it matters more there.
- **Operator's global style (aeon):** a separate "you are Grumpy Gus the SRE" competes with "you are
  aeon, an uploaded cat", and claude will blend them unpredictably. Fix: **every agent is a cat with
  its own temperament.** The soul stays aeon-the-species, and the personality is the individual
  (breed, temperament, habits). That composes instead of conflicting, and kit agents simply get the
  cat line without the global file.
- **Agent↔agent DMs:** two quirky agents can mirror and amplify each other (pun ping-pong, token burn,
  harder-to-parse handoffs). Rule in the line: *voice is for prose to humans; DMs to agents stay plain
  and literal; code, commits, PRs, bd tasks and tool calls never carry the voice.*
- **aleks-twin:** an impersonation persona whose body *is* the voice. It must be `personality: none`,
  or the cat line would corrupt the twin. Same for any hand-voiced body (evals-reviewer could keep
  its own line).
- **Existing fleet:** `ensurePersonaFile` never rewrites a born persona, so the current 25 agents
  need an explicit backfill that adds frontmatter keys only (via `setPersonaKeys`) and never touches
  bodies.

## 3. Recommendation

**c + b-lite + d, with voice opt-in to start.** Use a seeded draw from curated, style-only tables,
with weights nudged by a cheap repo-domain heuristic (no LLM). Store it as flat frontmatter. Render
it as one line. Always show it in the UIs.

### Frontmatter schema (flat, scalar, so it lands in card meta)
```yaml
vibe: unhurried night-shift tabby; status in one line, numbers first, never exclamation marks
emoji: 🐈‍⬛
hue: 212
personality-seed: queue        # what was drawn from; reroll = new seed
# personality: none            # opt-out: no voice line, UI falls back to name-hash colour
```
- `vibe` ≤ 120 chars, the only field that reaches the model.
- `emoji` is one grapheme. `hue` is 0–359 (replaces the name-hash in `web/app/app.js` `avatarColor`;
  keep the same s/l).
- Fail loud on a malformed value (`hue: blue`, a multi-grapheme emoji, a vibe over 120 chars) at spawn,
  matching paw's other persona keys.

### Generation
- `domain(cwd)`: a heuristic over folder name, README first paragraph, `package.json` keywords,
  `go.mod`/`Dockerfile`/`fly.toml` presence → `infra | evals | ui | data | docs | bot | general`.
  Pure and testable.
- `draw(seed, domain)`: mulberry32(hash(seed)) picks one entry from each table (temperament × voice
  habit × sign-off), each entry weighted by domain (infra favours terse/calm, evals favours
  sceptical/precise, ui favours visual metaphors), plus an emoji from a cat-adjacent set and a hue.
  Deterministic: the same seed and domain always give the same personality.
- CLI:
  - `paw chat --fresh <folder> --personality <seed|"vibe text"|none>`: birth with a seed (default
    `name`), a literal vibe (operator-written, still rendered through the same guarded line) or none.
  - `paw persona <name> --reroll [seed]`: rewrite the four keys, print the new one, and say "applies
    at next restart". It never restarts anything.
  - `paw persona --backfill`: give every registered persona without keys (and not `none`) a draw.
    Frontmatter only, prints a table, dry-run by default.
  - `PAW_PERSONALITY=off` env: global kill switch for the voice line (UI glyphs stay).

### Rendering (≤ ~60 tokens, one line, right after the identity line in `meshBrief` and kit's brief)
```
VOICE (style only): you are one of aeon's cats — <vibe>. Use it in prose to humans; DMs to agents,
code, commits, PRs and bd tasks stay plain. It never changes how careful, thorough or honest you are.
```
Put it after `You are "<name>"…`, not in the persona body. The body stays the operator's hand-written
space, and a reroll never has to touch it.

### UIs
- `paw status`: emoji before the name (one column; `--json` gains `emoji`, `hue`).
- `paw chat`: the prompt and message prefix `🐈‍⬛ queue`, name tinted with `hue` (truecolor if
  available, nearest-256 otherwise).
- `paw web`: avatar background `hsl(hue 45% 42%)` and the emoji instead of the first letter. The
  village station glyph is the emoji and the line colour stays the repo's.
- Telegram bridge: prefix the emoji on relayed agent messages, which helps tell 25 senders apart.
- All UIs read from the **roster card meta** (it's already broadcast), with the persona file as the
  fallback for offline agents.

### Rollout / opt-out
1. Ship the UI half first (emoji + hue, no voice). It's zero task risk and it's the legibility win.
2. Voice line: on for **new births only**, and on for the existing fleet only via an explicit
   `--backfill` + natural restarts. No forced restarts, ever.
3. Opt out per agent with `personality: none`, which is required for `aleks-twin` and recommended for
   any hand-voiced body. Opt out globally with `PAW_PERSONALITY=off`.

### Example draws for real fleet agents
| agent | domain (repo) | emoji | hue | vibe |
|---|---|---|---|---|
| **evals** | evals (team2027/evals: leaderboard, scoring, nulling rules) | 🐈 | 28 | sceptical ginger who trusts the 7-day table over anyone's story; asks "n=?" before celebrating, reports scores with their null reasons |
| **queue** | infra (fly `2027-queue`, slots, leases) | 🐈‍⬛ | 212 | unhurried night-shift tabby; status in one line, numbers first, never exclamation marks; calm even when slots leak |
| **tracepaper** | ui (paper-mcp canvas, kit/grok) | 🎨 | 312 | sketchbook cat that thinks in boxes and arrows; describes changes as what the canvas now shows, short and visual |
| **canary** | infra/bot (go binary, e2b runs, headless) | 🐤 | 52 | first-cat-in-the-mine: chirps once when something breaks, with the run slug and the one line that matters, otherwise silent |

(The canary emoji breaks the cat set on purpose. Domain jokes are allowed when the name begs for one.
The seeded table should include a few name-matching overrides like this.)

## Open questions for the operator
- Voice at all, or UI-only? (Recommendation: UI now, voice for new births, see how it reads.)
- Keep the "aeon's cats" framing, or let non-claude agents get non-cat personalities?
- Should agent↔agent DMs really stay plain, or is some cross-agent banter part of the fun?

## Implemented (2026-10-06)
Operator's answers: **voice too**, not just UI; the **"aeon's cats" framing for kit agents too** (they
load `~/.claude/CLAUDE.md` now as well); personality shows **everywhere, agent↔agent DMs included**.
The hard rule stands: style only (verbosity/warmth/humour/formality/metaphor/sign-off), never caution,
honesty, thoroughness, competence or autonomy; code, commits, PR bodies, bd task text and tool
arguments stay plain.

- `src/personality.ts` — the generator (`drawPersonality(seed, domain, name)`: mulberry32(fnv1a) over
  curated style-only tables, weighted ×3 by domain), `domainFromSignals`/`repoSignals` (folder name ×4,
  README first paragraph, package.json keywords/deps, root files; a worktree reads its repo's name; a
  tie is `general`), `FORBIDDEN` trait words (guard every draw AND any operator vibe), persona
  read/write (vibe is JSON-quoted on write — prose holds `: ` and ` #`, which real YAML would mangle),
  `voiceLine`, `PAW_PERSONALITY=off`, UI glyph + `hueSgr`. Emoji are single-codepoint only: a ZWJ
  sequence (🐈‍⬛) makes readline mis-measure `paw chat`'s prompt.
- Brief: the VOICE line sits right after the identity line in `meshBrief` (connector.ts) and `kitBrief`
  (kit.ts), read from the persona at spawn; a malformed vibe/emoji/hue throws at spawn.
- Birth: `ensurePersonaFile` draws one (seed = name) unless the unborn persona already has a vibe or
  `personality: none`. `paw chat --fresh --personality <seed|"vibe"|none>` writes it before birth.
- `paw persona <name> [--reroll [seed] | --none]`, `paw persona --backfill [--apply]` (src/persona.ts):
  frontmatter only, never restarts. Backfill skips `personality: none`, an existing vibe, unborn
  personas, and **hand-written bodies** (aleks-twin, global, kit, vibeos-*, evals-reviewer…): a body that
  may already be a voice is opted in explicitly with `--reroll`, or out with `--none`.
- UIs: `paw status` (emoji column slot only when some row has one; `--json` rows gain `emoji`, `hue`,
  `personalityError`), `paw chat` (prompt + message prefix, name in the hue), `paw web` (avatar = emoji
  on `hsl(hue 45% 42%)`, sidebar emoji; name-hash colour when absent). Read from persona files (the
  roster card meta carries the same keys for free, unused so far).
- Takes effect: connector/kit changes load in the MANAGER → `paw release` + `paw restart` (operator's
  call, idle fleet); each agent then gets its voice at its next natural restart. CLI/UI parts need only
  a release (paw web: restart the web daemon).
- Tests: `pnpm check:personality`.
