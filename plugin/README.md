# paw-cotal-plugin

paw's verbs, reachable from the `cotal` binary as **`cotal paw <verb> …`**.

Written for someone who already knows paw. If you know `paw chat`, you know `cotal paw chat` — the
grammar, the flags, the fail-loud errors and the exit codes are identical, because it is the same
program.

---

## 1. What this is — and what it isn't

**This is a namespaced PROXY, not a re-hosting.** `cotal paw <verb>` spawns `bin/paw.ts <verb>`.

What that genuinely buys:

- one entry point — paw's verbs on cotal's help surface, discoverable from the binary you already have
- no collision risk with cotal's builtins, now or after a cotal upgrade
- zero drift: there is no second copy of paw's dispatch, verb list, or arg handling to fall behind

What it does **not** buy — and this matters, because reducing paw's scope was the stated motivation:

> **Nothing moved into cotal and nothing was deleted.** Every line of paw still exists and still
> runs. This adds an entry point; it removes no code, no verb, and no maintenance burden. If you
> read this README and conclude paw got smaller, that is a misreading.

Real scope reduction is a different, unstarted piece of work: adopting `cotal.yaml` for the fleet
registry, and *dropping* the paw verbs cotal's builtins already cover. See §6 for the specific
candidates a teammate identified.

Both CLIs are the same layer over the same state. They read and write the same
`~/.paw/spaces/<space>/` (honouring `PAW_HOME` and `PAW_SPACE`), the same `folders.json` /
`agents.json` registry, the same personas, the same `inbox.cursor`, the same mesh, the same manager,
the same daemons. `paw status` and `cotal paw status` are two views of one machine state and can be
mixed freely in one session. **If they ever disagree, that is a bug.**

Your `cotal` binary's version and the `@cotal-ai/*` version paw is built against do not have to
match and are not kept in step — they only meet across an argv boundary. The extension peer-depends
on `@cotal-ai/core` (`>=0.14.0`) purely so cotal can link its own copy in and see the command
register; paw's subprocess resolves its own libraries from the checkout, as always.

---

## 2. Why one `paw` namespace instead of flat verbs

Seven paw verbs are **already** cotal builtin command names:

```
attach   status   stop   start   history   completion   down
```

`cotal ext add` fails the **entire install** on a name collision — builtins win
(`cli/dist/commands/ext.js`). And the extension loader's own collision handling (`ext-loader.js`)
exists precisely because "a base upgrade shipped the name", so `chat`, `inbox`, `log` and `files`
are all one cotal release away from the same fate. A flat contribution would be broken today and
fragile forever.

Under the namespace, `cotal status` stays cotal's and `cotal paw status` stays paw's. The migration
rule is one word: **type `cotal ` in front.**

### ⚠️ The one dangerous overlap: `history`

| command | what it does |
| --- | --- |
| `cotal paw history [channel]` | **reads** the message backlog |
| `cotal history clear --force` | **destroys** retained message history (alias of `clean history`) |

Same word, opposite meaning, one token apart. paw's `history` is read-only and always has been — it
fail-louds on a `clear` positional and points at `paw cotal history clear --force`. Under this
extension the destructive one is now *shorter to type* than the safe one. Be careful.

---

## 3. Install, verify, remove

Needs the `cotal` binary on your PATH. That ships as the **`cotal-ai`** npm package — not as any of
the `@cotal-ai/*` libraries paw depends on:

```sh
npm i -g cotal-ai          # only if `cotal --version` doesn't already answer
```

Then, from the paw checkout:

```sh
pnpm plugin:install
```

which is `pnpm plugin:build` (tsc + stamp the checkout path) followed by `cotal ext add ./plugin`.
Either half can be run by hand. Expected output:

```
✓ added paw-cotal-plugin@0.1.0 - provides: command:paw
```

Verify:

```sh
cotal help | grep paw      # → paw   warm claude-code agents on the mesh, one per folder (paw)
cotal paw                  # → paw's verb list
cotal paw sessions         # → same output as `paw sessions`
```

Remove:

```sh
cotal ext remove paw-cotal-plugin
```

Removing the extension removes nothing else — no agent, no persona, no session pin, no daemon. All
of that is paw's, in `~/.paw/`.

**You do not need to rebuild after editing paw.** The extension runs the checkout live, exactly as
the `paw` binary does. Rebuild only when you change something under `plugin/`, or when you **move
the checkout**.

---

## 4. The verbs

Every paw verb, unchanged, prefixed with `cotal paw`. Nothing is dropped, renamed, or reordered.
For what a verb does, run `paw <verb> --help` (not `cotal paw <verb> --help` — see §6) or read the
root `CLAUDE.md`.

| paw | as a cotal extension | note |
| --- | --- | --- |
| `paw` | `cotal paw` | the verb list |
| `chat [target] [--name n] [--fresh]` | `cotal paw chat …` | REPL as a persistent human peer. No cotal equivalent — `cotal console` is a read-only protocol view |
| `claude [claude-args…]` | `cotal paw claude …` | real claude in this terminal, mesh-wired |
| `open` / `attach [target]` | `cotal paw open` / `cotal paw attach` | ⚠️ `cotal attach` is pty-only and `--name`-only; paw's is folder-addressed, spawns on demand, and branches per runtime (pty→ws-pty, tmux→native, cmux→prints the tab) |
| `adopt [folder] [--resume …]` | `cotal paw adopt …` | no equivalent |
| `dm <target> "<msg>"` | `cotal paw dm …` | ⚠️ **not** `cotal send dm` — see §5 |
| `inbox [--history\|--watch\|--json\|--mark-read\|--sent]` | `cotal paw inbox …` | no equivalent |
| `msg <#channel>` / `ask <role>` | `cotal paw msg` / `cotal paw ask` | same wire op as `cotal send msg\|ask`; the difference is **sender identity** — see §5 |
| `who` | `cotal paw who` | `cotal endpoints` is close (name/role, kind, status, activity); only paw's `(you)` marker is missing |
| `watch` | `cotal paw watch` | `cotal console --plain` is the near-equivalent; nobody has A/B'd the render |
| `history [channel]` | `cotal paw history …` | ⚠️ reads. `cotal history` **destroys** — see §2 |
| `files` / `bind` | `cotal paw files` / `cotal paw bind` | no equivalent |
| `status [--json]` | `cotal paw status …` | ⚠️ `cotal status` is a different subject (setup + processes + mesh health); `cotal ps` lists only *managed* agents. paw's rows are the registry — live or not — plus JetStream consumer lag |
| `stop <name\|folder>` | `cotal paw stop …` | `cotal stop` is `--name` only; paw's positional resolves a registered name **or** a mapped folder |
| `start [<name>…]` | `cotal paw start …` | `cotal start` is a hidden tombstone (folded into `spawn --detach`) but still a registered name — hence still a collision |
| `restart` / `runtime [pty\|tmux\|cmux]` | `cotal paw restart` / `cotal paw runtime` | no equivalent; `cotal runtimes` merely *lists* installed runtimes |
| `rename` / `rm` | `cotal paw rename` / `cotal paw rm` | no equivalent |
| `global` | `cotal paw global` | no equivalent |
| `sessions` / `log` | `cotal paw sessions` / `cotal paw log` | local reads, no equivalent |
| `down` | `cotal paw down` | ⚠️ ownership-scoped: stops only what **paw** started (including the beacon). `cotal down` stops the whole stack |
| `mailbox` | `cotal paw mailbox` | daemon; `ensure()` starts it. Don't run it by hand |
| `completion …` | `cotal paw completion …` | installs completion for the **`paw`** binary, not for `cotal paw` — see §6 |
| `create` / `send` | `cotal paw create` / `cotal paw send` | still fail-loud redirects to `chat --fresh` / `dm\|msg\|ask` |
| `cotal <verb> …` | `cotal paw cotal <verb> …` | works, but pointless — you're already in the binary. Just run `cotal <verb>` |

---

## 5. Concepts that don't survive a naive port

Each of these exists because something broke. If anyone later reimplements paw's behaviour *inside*
cotal rather than proxying to it, these are the parts that will look redundant and are not.

### The durable "you" peer

An agent can only deliver a DM to a peer it can **resolve in the live roster**. That single fact
shapes three separate components:

- **`paw dm` is a pure sender** — `registerPresence:false`, `consume:false`, `watchPresence:true`
  only so it can resolve or spawn the target. It sends as `HUMAN_PEER`, the stable "you" identity.
  This is why paw owns `dm` instead of aliasing `cotal send dm`: cotal's sender is a throwaway peer
  literally named `send`, which exits the instant it has sent, so the agent's reply is undeliverable
  ("send went offline"). paw also addresses a **folder** and spawns from it; cotal only addresses a
  live name.
- **`paw mailbox` is a beacon** — `registerPresence:true`, `consume:false`. It holds "you" present
  so a reply that arrives minutes later still resolves. It deliberately **never drains your inbox**.
- **`paw inbox` is a pure reader** — a throwaway, non-acking consumer.

The load-bearing constraint: cotal allows exactly **one active consumer** on "you"'s durable. A
second binder starves `paw chat`. A former `dm --wait` did exactly that and was removed. Unread
state is therefore a **local, forward-only cursor file** (`inbox.cursor`), not mesh acking, shared
by every paw surface.

**Port rule:** same `HUMAN_PEER` name, same `stableHumanId(space)`. Getting the id wrong fails
**silently** — a stale beacon once held "you" under a server-minted nkey while `paw inbox` read a
different id, and replies simply vanished for a day.

### Folder addressing

The mesh carries an agent's **name** but not its **cwd** — neither presence nor `ps` exposes it. So
paw owns the mapping: `folders.json` (folder → default name, basename collision-qualified with a
path hash) plus `agents.json` (extras only). An agent lives in exactly one of the two files, so they
cannot desync.

A bare folder target **always** hits the folder's default; extras are opt-in via explicit `--name`.
`assertUnambiguousTarget` fail-louds when a bare token is *both* a registered agent name and the
basename of a different folder — the `paw log .` / `paw log <name>` wrong-session class of bug.

**Port rule:** same files, same lock, same guard.

### Session pinning and adopt

Every persona is minted with a stable `resume: <uuid>` at birth. The connector emits `--session-id`
on first boot and `--resume` thereafter. **That one line is what makes an agent warm across
restarts**; a pinless persona cold-starts amnesiac every launch.

Two writers on one transcript corrupt it. So adopt refuses when a live non-mesh process holds the
id, and proposes `--force` — which is **make-before-break**: the new mesh agent is brought up and
confirmed live *first*, then the old holder is SIGTERMed. A failed spawn never strands you with a
dead session.

The connector's opinions apply to **every** paw agent, including the interactive `paw claude`:
`bypassPermissions` (`PAW_PERMISSION` overrides), `--disallowedTools AskUserQuestion,ExitPlanMode`
(a prompt-blocked agent can never drain a DM), and the mesh brief.

---

## 6. What's different / not yet working

### `--help` on a sub-verb is swallowed by cotal

`runCli` scans `rest.includes("--help")` **before** dispatch, and its own comments say that intercept
deliberately covers `rawArgs` commands. So `cotal paw chat --help` prints cotal's help for the `paw`
command, not paw's help for `chat`. There is no workaround from the extension side — `--` does not
stop it, because it is a plain token scan.

Use `paw chat --help` directly.

**A message body containing `--help` is FINE** — I assumed it was caught too and it isn't:
`cotal paw dm agent "run --help first"` produces byte-identical output to `paw dm …`, because the
scan only matches `--help` in a flag position, not inside a quoted argument. Tested, not reasoned.
`paw dm …` is unaffected. Every other flag-shaped token passes through untouched — verified for
`--`, `--json`, `--space=x` and double-spaced quoted arguments.

### ~0.2s extra process start per command

Every `cotal paw <verb>` starts one additional process (paw's CLI) on top of cotal's own: ~0.2s when
bun is on the box, ~0.8s under node+tsx. Irrelevant next to a mesh round-trip; noticeable if you
script a tight loop of `cotal paw status`.

### Finding the checkout — and what happens when it moves

`cotal ext add <path>` installs with `npm install --install-links`, which **copies** the package into
cotal's extension prefix (`$XDG_CONFIG_HOME/cotal/extensions`, else `~/.config/cotal/extensions`).
Once copied, nothing relative leads back to the checkout — and the checkout is what has to run,
because `src/lifecycle.ts` pins `REPO_ROOT` to it and drives the mesh/manager/beacon daemons through
`<root>/bin/*.ts` under `<root>/node_modules/tsx`.

Resolution order, each branch verified (`<root>/bin/paw.ts` must exist) before it is used:

| # | source | on failure |
| --- | --- | --- |
| 1 | `PAW_REPO` env | loud (must be absolute **and** a real checkout) |
| 2 | `dist/paw-root.json`, stamped at build time | loud — **does not fall through to 3** |
| 3 | `~/Github/paw`, the documented convention | loud, naming all three fixes |

**If you move the checkout, `cotal paw` breaks with one clear line** naming the stale path and the
fix (`pnpm plugin:install` again, or set `PAW_REPO`). It deliberately does *not* silently fall back
to `~/Github/paw` when a stamp exists but has gone stale: you built from a specific tree, and quietly
running a different one is worse than an error. The `~/Github/paw` default applies only when there is
no stamp at all, and even then only if that path really is a paw checkout.

`PAW_BIN` is a fourth escape hatch: point it at an executable paw launcher (e.g.
`~/.local/bin/paw`) and the runtime-selection logic is skipped entirely.

Runtime selection otherwise mirrors `~/.local/bin/paw`: prefer `$HOME/.bun/bin/bun`, else bun if
cotal itself runs under bun, else `<node> <root>/node_modules/tsx/dist/cli.mjs`. Every path is
resolved **absolutely** — a stripped PATH (launchd, Raycast, a mesh-agent shell) has none of these on
it, which paw already learned the hard way (`nodeBin` / `withToolPath` in `src/lifecycle.ts`).

### This is why it isn't publishable

The package cannot carry paw's code. `ext add` hard-fails any extension that declares an
`@cotal-ai/*` package as a regular dependency (they must be peers, so cotal can link its own copies
in), and `--install-links` would copy a `file:`-depended paw into the prefix *without* its
`node_modules/tsx` and with `REPO_ROOT` pointing at the copy — the daemons would stop starting.
Bundling has the same `REPO_ROOT` problem, plus it would freeze paw's code at build time.

So the shim resolves an absolute path on the operator's disk. That works, and it is honest ugliness:
it makes this a **local-trial plugin, not a publishable one**. The real fix later is publishing paw
itself, so the extension can depend on it properly.

`bun link` was also considered: `ext add` accepts only a local path or a registry name, and a linked
global package is neither. The path route needs no linking.

### No `local-process` descriptor for the mailbox beacon

Not done here — but **less blocked than this section first claimed**, and the correction is worth
recording because the original reasoning was wrong in its conclusion.

`LocalProcess.pidFile` is a path relative to `<mesh root>/.cotal`; `localProcessPath` rejects
absolute and traversing templates (`workspace/dist/local-process.js:5-14`), and `extensions.js`
validates it at install time. paw's beacon pidfile is `$PAW_HOME/spaces/<space>/mailbox.pid`, which
is indeed outside any cotal root — so **today** a descriptor would point at a path that never exists.

What the first draft got wrong was treating that as a wall. **The paw space's mesh root is
`/Users/aleks`** (`~/.cotal/meshes/space.706177.json`), so `pidFile: "mailbox.pid"` resolves to
`~/.cotal/mailbox.pid` — a perfectly legal target, alongside cotal's own `manager.pid` and
`nats.pid`. The obstacle is only that paw writes the file somewhere else, which is paw's choice and
movable, not a constraint cotal imposes.

So this is an open opportunity rather than a dead end: move (or additionally write) the beacon
pidfile under the space's cotal root and register the descriptor, and `cotal status` gains the
beacon's health while `cotal down` reaps it. Coherent here precisely because **paw** starts the
beacon — contrast the Telegram bridge, where launchd's `KeepAlive` would restart the process within
`ThrottleInterval` seconds and make `cotal down` report a stop that didn't hold.

Until someone does that: `paw down` / `cotal paw down` stops the beacon; `cotal status` and
`cotal down` don't know about it.

### Daemon lifecycle: paw's gate, not cotal's

paw's pre-dispatch gate (`NEEDS_MESH` / `NEEDS_MANAGER` → `ensure()`) has no equivalent under cotal —
cotal expects you to have run `cotal up`. **This was handled by not touching it**: the gate lives in
`bin/paw.ts`, which is exactly what the proxy spawns, so `cotal paw chat` brings the mesh and manager
up on its own, identically to `paw chat`. The same goes for the default `--space` injection and
`expandEqFlags`. None of it is reimplemented here; all of it runs.

### Completion

`cotal paw <TAB>` does not complete. `cotal paw completion install` installs paw's own completion for
the **`paw`** binary. Wiring the other direction is possible — cotal offers `Command.complete` and
paw already has a `__complete` dispatcher — it just isn't wired.

### Verbs a real scope reduction would drop (not done here)

The proxy passes *everything* through; nothing is blocked. For the record, a teammate's analysis
identified these as the ones cotal's builtins could plausibly replace: `who` → `cotal endpoints`;
`watch` → `cotal console --plain` (a judgement call nobody has A/B'd); `completion` →
`cotal completion` (four shells, and it completes extension commands); and `paw cotal <verb>`, which
is redundant inside the binary. Deciding those is separate work.

### Untested paths — stated specifically

Everything below the CLI boundary is paw's, unchanged, and covered by paw's own suite. Through
*this* entry point, only **local, read-only** verbs were exercised end to end.

- **No mesh verb was run through the extension.** `DEFAULT_SERVER` is a hard constant in
  `@cotal-ai/core` and paw's `ensure()` takes no server override, so there is no way to boot an
  isolated mesh through paw — running `cotal paw status` / `chat` / `dm` would have meant touching
  the operator's live `nats://127.0.0.1:4222`. Not done.
- **`cotal paw chat` was never driven interactively.** What was proven is narrower and should not be
  read as more: under a real node-pty, the spawned paw child reports a **tty on both stdin and
  stdout**. That is the precondition `chat`'s REPL, `open`/`attach`'s pty takeover and `paw claude`'s
  inherit-spawn depend on — it is *tty-capable*, verified. Whether the REPL, the pty attach client
  and the claude handoff actually behave correctly through this path is **untested**.
- ~~cotal-ai 0.15.0 untested~~ — **now verified.** `cotal-ai` was installed globally at the
  operator's explicit request (`bun i -g cotal-ai`, which their policy permits for a deliberate
  install even while the registry's minimum-release-age gate still holds for `package.json`
  dependencies). The extension installs and dispatches on **0.15.0**, against the live mesh. So the
  verified set is 0.14.6, 0.14.9 and 0.15.0.

  Worth knowing: your `cotal` binary and the `@cotal-ai/*` libraries paw builds against do **not**
  have to match, and here they don't — the binary is 0.15.0 while paw is on 0.14.6. They only meet
  across an argv boundary.
- **Signal handling is partly unproven.** SIGTERM/SIGHUP forwarding to the child is implemented;
  SIGINT is deliberately a parent no-op (the terminal already delivers it to the foreground process
  group, and paw's own handlers must be the ones that run). Neither was exercised against a real
  interactive session.

---

## 7. What was tested

On an isolated cotal — `XDG_CONFIG_HOME` pointed at a temp dir, which is what `extensionsDir()` keys
off, so the operator's real `~/.config/cotal` was never even created — with `PAW_HOME` and
`PAW_SPACE` also temp, and no mesh started at any point:

- `cotal ext add ./plugin` succeeds on **cotal-ai 0.14.6 and 0.14.9**, reporting
  `provides: command:paw`, and links `@cotal-ai/core` from the running binary
- `cotal help` lists `paw` under **Extensions**
- bare `cotal paw` prints paw's verb list; `cotal paw nosuchverb` prints paw's fail-loud line and
  **exits 1**
- `cotal paw sessions` produces the **same output** as `paw sessions`. One run of the pair came out
  `diff`-clean, but that is not the claim to make: the listing carries **relative timestamps**
  (`7s ago`), which change between two sequential runs by construction, and a second reviewer's run
  differed by exactly that. Identical modulo the clock — not byte-identical
- argv fidelity and exit-code propagation, via a stub `PAW_BIN`: `--`, `--json`, `--space=x` and a
  double-spaced quoted argument all arrive verbatim; a child exiting 7 makes cotal exit 7
- tty inheritance, under a real node-pty: the paw child reports a tty on stdin and stdout
- all three root-resolution tiers and their failure modes: relative `PAW_REPO`; a `PAW_REPO` that
  isn't a checkout; a **stale stamp** (errors rather than falling through to the convention); a
  missing stamp with a valid `~/Github/paw` (resolves); a missing stamp with no checkout anywhere
  (one clear line naming all three fixes); a missing `PAW_BIN`
- `cotal ext remove paw-cotal-plugin` removes `command:paw` and leaves the prefix empty
