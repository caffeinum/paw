/**
 * Smoke check for paw's endpoint-native commands (src/commands/*): each self-registers into core's
 * registry with a summary + usage, and its exported pure helpers behave (render/format/resolve —
 * no mesh, no manager). Isolated PAW_HOME so real paw state is untouched; colors are tty-gated so
 * every assertion is on CONTENT (substring), never ANSI codes. Run: pnpm check:commands
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { registry, type Command, type CotalMessage, type Presence } from "@cotal-ai/core";

process.env.PAW_HOME = mkdtempSync(join(tmpdir(), "paw-commands-home-"));
process.env.PAW_SPACE = "cmdtest";
const space = "cmdtest";

// Import AFTER the env isolation is in place — the modules self-register on import.
const { resolveStopName } = await import("../src/commands/stop.js");
const { stripChannel, formatWhen, idNames } = await import("../src/commands/history.js");
const { renderTap } = await import("../src/commands/watch.js");
const { formatWho, dedupeRoster } = await import("../src/commands/who.js");
const { extractFileEntry, formatReceived, formatSize } = await import("../src/commands/files.js");
const { extractBindCode, formatBindOutput, BIND_CODE_PROTO } = await import("../src/commands/bind.js");
const { parseUnstickArgs } = await import("../src/commands/unstick.js");
const { tmuxTarget } = await import("../src/unstick.js");
await import("../src/commands/msg.js");
await import("../src/commands/ask.js");
const { folderToName } = await import("../src/addressing.js");
const { isStaleRefusal } = await import("../src/control.js");

// A manager refusal that names a gone incarnation must drop the shared handle; an ordinary refusal must not.
assert(
  isStaleRefusal('this request reached manager instance abc at epoch 46, but the caller bound to epoch 45 of the same instance; this incarnation is not the one it resolved against and "ps" WAS NOT RUN'),
  "an epoch-mismatch refusal is staleness",
);
assert(!isStaleRefusal('no agent named "nope"'), "an unknown-agent refusal is not staleness");
assert(!isStaleRefusal("error"), "a bare error is not staleness");

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`  ok  ${msg}`);
  else {
    failures++;
    console.error(`  FAIL  ${msg}`);
  }
}
function throws(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

// Every endpoint-native command is registered with a summary + usage.
for (const name of ["stop", "unstick", "msg", "ask", "who", "history", "watch", "files", "bind"]) {
  let cmd: Command | undefined;
  try {
    cmd = registry.resolve<Command>("command", name);
  } catch {
    cmd = undefined;
  }
  assert(cmd !== undefined, `"${name}" is registered`);
  assert(!!cmd && cmd.summary.length > 0, `"${name}" has a summary`);
  assert(!!cmd && !!cmd.usage && cmd.usage.length > 0, `"${name}" has a usage line`);
}

// unstick: arg parse + the EXACT tmux target (a prefix match would type Esc into `web-2` for `web`).
{
  const p = parseUnstickArgs(["queue-ea", "--force", "--space", "s1"]);
  assert(p.target === "queue-ea" && p.force && p.space === "s1", "unstick: name, --force and --space parse");
  assert(!parseUnstickArgs(["x"]).force, "unstick: --force is opt-in");
  assert(throws(() => parseUnstickArgs([])), "unstick: no target throws");
  assert(throws(() => parseUnstickArgs(["a", "b"])), "unstick: two targets throw");
  assert(throws(() => parseUnstickArgs(["a", "--kill"])), "unstick: an unknown flag throws");
  assert(tmuxTarget("paw", "web") === "=cotal-paw:=web", "unstick: tmux target pins session AND window to an exact match");
}

// (ps was merged into `paw status`; its rendering is covered by check:status. `paw cotal ps` is the raw view.)

// stop: resolveStopName — a registered NAME, a mapped folder, a raw manager name; fail-loud on anything else.
const folder = realpathSync(mkdtempSync(join(tmpdir(), "paw-commands-proj-")));
const name = folderToName(space, folder); // registers folder → basename
assert(resolveStopName(space, name) === name, "resolveStopName: a registered agent NAME resolves to itself");
assert(resolveStopName(space, folder) === name, "resolveStopName: a mapped folder resolves to its agent name");
const unmapped = realpathSync(mkdtempSync(join(tmpdir(), "paw-commands-unmapped-")));
assert(throws(() => resolveStopName(space, unmapped)), "resolveStopName: an unmapped folder throws");
assert(resolveStopName(space, "never-existed-xyz") === "never-existed-xyz", "resolveStopName: an unregistered NAME goes to the manager as-is (a cotal_spawn peer is stoppable)");
assert(throws(() => resolveStopName(space, "no/such/path")), "resolveStopName: a token that is neither a name nor a folder throws");

// history: stripChannel / formatWhen / idNames.
assert(stripChannel("#general") === "general", "stripChannel: strips one leading #");
assert(stripChannel("general") === "general", "stripChannel: bare name untouched");
assert(throws(() => stripChannel("#")), 'stripChannel: "#" alone throws');
const noon = new Date(2026, 5, 15, 12, 0).getTime();
assert(formatWhen(new Date(2026, 5, 15, 9, 5).getTime(), noon) === "09:05", "formatWhen: same day → HH:MM");
assert(formatWhen(new Date(2026, 4, 3, 9, 5).getTime(), noon) === "05-03 09:05", "formatWhen: other day → MM-DD HH:MM");
const msgs = [
  { id: "1", ts: 1, space, from: { id: "aa", name: "alice" }, parts: [{ kind: "text", text: "hi" }], channel: "general" },
  { id: "2", ts: 2, space, from: { id: "bb", name: "bob" }, parts: [{ kind: "text", text: "yo" }], to: "aa" },
] as unknown as CotalMessage[];
const names = idNames(msgs);
assert(names.get("aa") === "alice" && names.get("bb") === "bob", "idNames: sender ids map to names");

// watch: renderTap — one line per chat family, undefined for non-message traffic.
const nameFor = (id: string) => (id === "aa" ? "alice" : id.slice(0, 8));
const chanLine = renderTap(msgs[0], nameFor);
assert(!!chanLine && chanLine.includes("[general]") && chanLine.includes("alice") && chanLine.includes("hi"), "renderTap: channel message → [channel] name: text");
const dmLine = renderTap(msgs[1], nameFor);
assert(!!dmLine && dmLine.includes("dm") && dmLine.includes("bob") && dmLine.includes("alice") && dmLine.includes("yo"), "renderTap: dm → dm from → to: text");
const askMsg = { id: "3", ts: 3, space, from: { id: "cc", name: "carol" }, parts: [{ kind: "text", text: "?" }], toService: "review" } as unknown as CotalMessage;
const askLine = renderTap(askMsg, nameFor);
assert(!!askLine && askLine.includes("ask") && askLine.includes("carol") && askLine.includes("review"), "renderTap: anycast → ask from → role: text");
const beat = { id: "4", ts: 4, space, from: { id: "dd", name: "d" } } as unknown as CotalMessage;
assert(renderTap(beat, nameFor) === undefined, "renderTap: non-message traffic (no parts) → undefined");

// files: extractFileEntry pulls the FileEntry from an ai.cotal.file data part; formatSize/formatReceived render.
const fileEntry = { v: 1, ts: 1, name: "report.pdf", path: "/abs/files/report.pdf", size: 2_400_000, caption: "q3", source: "telegram" };
const fileMsg = {
  id: "f1", ts: 1, space, from: { id: "ee", name: "bridge" }, channel: "files",
  parts: [{ kind: "text", text: "📎 report.pdf" }, { kind: "data", data: { proto: "ai.cotal.file", ...fileEntry } }],
} as unknown as CotalMessage;
const pulled = extractFileEntry(fileMsg);
assert(!!pulled && pulled.name === "report.pdf" && pulled.path === "/abs/files/report.pdf", "extractFileEntry: pulls the FileEntry from an ai.cotal.file data part");
const noFile = { id: "f2", ts: 2, space, from: { id: "ff", name: "x" }, channel: "files", parts: [{ kind: "text", text: "hi" }] } as unknown as CotalMessage;
assert(extractFileEntry(noFile) === undefined, "extractFileEntry: a plain message → undefined");
const wrongProto = { id: "f3", ts: 3, space, from: { id: "gg", name: "y" }, channel: "files", parts: [{ kind: "data", data: { proto: "other" } }] } as unknown as CotalMessage;
assert(extractFileEntry(wrongProto) === undefined, "extractFileEntry: a data part with a different proto → undefined");
assert(formatSize(512) === "512 B", "formatSize: bytes");
assert(formatSize(2_400_000).includes("MB"), "formatSize: megabytes");
assert(formatSize(undefined) === "?", "formatSize: missing size → ? (never a fabricated 0)");
const rendered = formatReceived(fileEntry as never, "bridge", fileEntry.ts + 1000);
assert(rendered.includes("report.pdf") && rendered.includes("/abs/files/report.pdf") && rendered.includes("telegram") && rendered.includes("q3"), "formatReceived: name, abs path, source, caption all render");

// bind: extractBindCode pulls a well-formed ai.cotal.bind-code data part; formatBindOutput renders it.
const codeMsg = {
  id: "b1", ts: 1, space, from: { id: "tg", name: "telegram" }, to: "me",
  parts: [{ kind: "text", text: "bind code: ABC123 — valid 120s" }, { kind: "data", data: { proto: BIND_CODE_PROTO, v: 1, code: "ABC123", ttlSec: 120 } }],
} as unknown as CotalMessage;
const bc = extractBindCode(codeMsg);
assert(!!bc && bc.code === "ABC123" && bc.ttlSec === 120, "extractBindCode: pulls code + ttlSec from an ai.cotal.bind-code data part");
const noCode = { id: "b2", ts: 2, space, from: { id: "tg", name: "telegram" }, to: "me", parts: [{ kind: "text", text: "hi" }] } as unknown as CotalMessage;
assert(extractBindCode(noCode) === undefined, "extractBindCode: a plain DM → undefined");
const wrongBindProto = { id: "b3", ts: 3, space, from: { id: "tg", name: "telegram" }, to: "me", parts: [{ kind: "data", data: { proto: "other", v: 1, code: "X", ttlSec: 1 } }] } as unknown as CotalMessage;
assert(extractBindCode(wrongBindProto) === undefined, "extractBindCode: a data part with a different proto → undefined");
const noCodeField = { id: "b4", ts: 4, space, from: { id: "tg", name: "telegram" }, to: "me", parts: [{ kind: "data", data: { proto: BIND_CODE_PROTO, v: 1, ttlSec: 120 } }] } as unknown as CotalMessage;
assert(extractBindCode(noCodeField) === undefined, "extractBindCode: a bind-code part missing `code` → undefined (never fabricated)");
assert(formatBindOutput({ code: "ABC123", ttlSec: 120 }).includes("ABC123") && formatBindOutput({ code: "ABC123", ttlSec: 120 }).includes("/bind ABC123"), "formatBindOutput: renders the code + the ready-to-paste /bind line");

// who: formatWho — name/role + status, "(you)" only for the human id.
const agent = { card: { id: "aa", name: "web", role: "dev", kind: "agent" }, status: "working", ts: 0 } as unknown as Presence;
const agentLine = formatWho(agent, "human-id");
assert(agentLine.includes("web/dev") && agentLine.includes("working") && !agentLine.includes("(you)"), "formatWho: name/role + status, no (you) for a peer");
const you = { card: { id: "human-id", name: "you", kind: "endpoint" }, status: "idle", ts: 0 } as unknown as Presence;
assert(formatWho(you, "human-id").includes("(you)"), "formatWho: the human id is tagged (you)");

// lifecycle: manager/mailbox daemon-match patterns are SPACE-EXACT (the ownership-by-signature fix).
// Proven with a JS RegExp proxy for pgrep's ERE — the escaping + boundary logic is what matters.
const { managerMatchPattern, mailboxMatchPattern } = await import("../src/lifecycle.js");
const mgr1 = new RegExp(managerMatchPattern("owntest-1"));
const mgrCmd = (s: string) => `node .../tsx/cli.mjs .../bin/cotald.ts supervise --space ${s} --server nats://127.0.0.1:4222`;
assert(mgr1.test(mgrCmd("owntest-1")), "managerMatchPattern matches its own space's command line");
assert(!mgr1.test(mgrCmd("owntest-11")), "managerMatchPattern is SPACE-EXACT: owntest-1 does NOT match owntest-11");
assert(!mgr1.test(mgrCmd("owntest-1x")), "managerMatchPattern is SPACE-EXACT: owntest-1 does NOT match owntest-1x");
const mb1 = new RegExp(mailboxMatchPattern("owntest-1"));
const mbCmd = (s: string) => `node .../tsx/cli.mjs .../bin/paw.ts mailbox --space ${s}`;
assert(mb1.test(mbCmd("owntest-1")), "mailboxMatchPattern matches its own space (space is the last arg)");
assert(!mb1.test(mbCmd("owntest-11")), "mailboxMatchPattern is SPACE-EXACT: owntest-1 does NOT match owntest-11");
assert(new RegExp(mailboxMatchPattern("paw")).test("x .../bin/paw.ts mailbox --space paw"), "mailboxMatchPattern matches the production space `paw` at end-of-arg");
// regex metacharacters in the space value are escaped (never treated as regex operators).
assert(!new RegExp(managerMatchPattern("a.b")).test(mgrCmd("axb")), "managerMatchPattern escapes regex metachars in the space (a.b ≠ axb)");

// lifecycle: agentSelfName — the "am I running INSIDE a managed agent?" signal that makes `paw restart`
// detach when self-called. cotal stamps COTAL_NAME/COTAL_SPACE on an agent; an operator shell has neither.
const { agentSelfName } = await import("../src/lifecycle.js");
const savedName = process.env.COTAL_NAME;
const savedSpace = process.env.COTAL_SPACE;
delete process.env.COTAL_NAME;
delete process.env.COTAL_SPACE;
assert(agentSelfName("sp") === undefined, "agentSelfName: no COTAL_NAME (operator shell) → undefined");
process.env.COTAL_NAME = "ag";
assert(agentSelfName("sp") === "ag", "agentSelfName: COTAL_NAME set, no COTAL_SPACE → the name (any space)");
process.env.COTAL_SPACE = "sp";
assert(agentSelfName("sp") === "ag", "agentSelfName: COTAL_SPACE matches → the name");
assert(agentSelfName("other") === undefined, "agentSelfName: COTAL_SPACE mismatch → undefined (not our caller)");
if (savedName === undefined) delete process.env.COTAL_NAME; else process.env.COTAL_NAME = savedName;
if (savedSpace === undefined) delete process.env.COTAL_SPACE; else process.env.COTAL_SPACE = savedSpace;

// lifecycle: sanitizeNodeOptions — a cmux-wrapped session carries a NODE_OPTIONS preload pointing into
// a temp dir cmux later REAPS, so every node child paw spawns dies at preload before running. Drop only
// what's provably missing; a bare specifier / relative path isn't resolvable from here and must survive.
const { sanitizeNodeOptions } = await import("../src/lifecycle.js");
const realFile = join(process.env.PAW_HOME as string, "preload.cjs");
writeFileSync(realFile, "");
const gone = join(process.env.PAW_HOME as string, "reaped.cjs");
assert(sanitizeNodeOptions(undefined) === undefined, "sanitizeNodeOptions: unset stays unset");
assert(sanitizeNodeOptions("") === "", "sanitizeNodeOptions: empty is passed through untouched");
assert(sanitizeNodeOptions(`--require=${gone}`) === undefined, "sanitizeNodeOptions: sole missing --require=path → undefined (var deleted)");
assert(sanitizeNodeOptions(`--require ${gone}`) === undefined, "sanitizeNodeOptions: two-token `--require path` drops BOTH tokens");
assert(sanitizeNodeOptions(`--import=${gone}`) === undefined, "sanitizeNodeOptions: --import is a preload flag too");
assert(sanitizeNodeOptions(`-r ${gone}`) === undefined, "sanitizeNodeOptions: the -r short form is handled");
assert(sanitizeNodeOptions(`--require=${realFile}`) === `--require=${realFile}`, "sanitizeNodeOptions: an EXISTING preload is kept");
assert(sanitizeNodeOptions(`--require=${gone} --max-old-space-size=4096`) === "--max-old-space-size=4096", "sanitizeNodeOptions: unrelated flags survive the drop");
assert(sanitizeNodeOptions("--import tsx") === "--import tsx", "sanitizeNodeOptions: a BARE specifier is not ours to judge — kept");
assert(sanitizeNodeOptions("--require ./local.cjs") === "--require ./local.cjs", "sanitizeNodeOptions: a RELATIVE preload resolves against the child's cwd — kept");
assert(sanitizeNodeOptions(`--require=file://${gone}`) === undefined, "sanitizeNodeOptions: a file:// URL target is resolved and checked");
assert(sanitizeNodeOptions("--require") === "--require", "sanitizeNodeOptions: a dangling flag is left for node to complain about");

// cotal-root: the space's root must NOT come from the shell's cwd (a checkout with its own `.cotal/`
// hijacked it — the team2027 trust-bundle/lease incident, 2026-07-29). Registry entry wins; env overrides.
const { pawCotalRoot } = await import("../src/cotal-root.js");
const savedCotalHome = process.env.COTAL_HOME;
process.env.COTAL_HOME = mkdtempSync(join(tmpdir(), "paw-cotal-home-"));
mkdirSync(join(process.env.COTAL_HOME, "meshes"), { recursive: true });
writeFileSync(
  join(process.env.COTAL_HOME, "meshes", `space.${Buffer.from("rt", "utf8").toString("hex")}.json`),
  JSON.stringify({ space: "rt", server: "nats://127.0.0.1:4222", root: "/pinned/root", mode: "open" }),
);
assert(pawCotalRoot("rt") === "/pinned/root", "pawCotalRoot: reads the space's recorded root from the mesh registry");
assert(pawCotalRoot("never-started") === homedir(), "pawCotalRoot: a space with no registry entry falls back to homedir (where ~/.cotal lives)");
process.env.PAW_COTAL_ROOT = "/override";
assert(pawCotalRoot("rt") === "/override", "pawCotalRoot: PAW_COTAL_ROOT wins over the registry");
process.env.PAW_COTAL_ROOT = "relative/path";
let threw = false;
try {
  pawCotalRoot("rt");
} catch {
  threw = true;
}
assert(threw, "pawCotalRoot: a NON-absolute PAW_COTAL_ROOT fails loud (never silently resolved)");
delete process.env.PAW_COTAL_ROOT;
rmSync(process.env.COTAL_HOME, { recursive: true, force: true });
if (savedCotalHome === undefined) delete process.env.COTAL_HOME;
else process.env.COTAL_HOME = savedCotalHome;

rmSync(process.env.PAW_HOME as string, { recursive: true, force: true });
rmSync(folder, { recursive: true, force: true });
rmSync(unmapped, { recursive: true, force: true });

// ── /who shows one row per NAME ──────────────────────────────────────────────────────────────────
// The roster is keyed by mesh ID and every restart mints a new one, while cotal's sweep marks a stale
// peer `offline` in the in-memory map without removing it. A `paw chat` open all day therefore showed
// six dead `evals` rows and one live one. Nothing leaks on the mesh — a fresh connection sees only live
// peers — so it is fixed where it is rendered.
{
  const p = (name: string, status: string, ts = 0, id = `${name}-${status}-${ts}`) =>
    ({ card: { id, name }, status, ts }) as never;

  const rows = dedupeRoster([p("evals", "offline", 1), p("evals", "offline", 2), p("evals", "idle", 3), p("gaal", "offline", 1)]);
  assert(rows.length === 2, "one row per name, not per incarnation");
  assert(rows.find((r) => r.card.name === "evals")?.status === "idle", "the LIVE record wins over its dead predecessors");
  // An agent that is genuinely down still deserves a row — it is only the dead predecessors of a
  // RUNNING agent that are noise.
  assert(rows.find((r) => r.card.name === "gaal")?.status === "offline", "an agent with no live record still shows, as offline");
  // Among equals, most recent — so two live records (a race mid-restart) show the newer.
  const live2 = dedupeRoster([p("x", "idle", 10), p("x", "working", 20)]);
  assert(live2.length === 1 && live2[0].status === "working", "among live records the most recent wins");
  const dead2 = dedupeRoster([p("y", "offline", 20), p("y", "offline", 10)]);
  assert(dead2.length === 1 && dead2[0].ts === 20, "among dead records the most recent wins");
  assert(dedupeRoster([]).length === 0, "an empty roster stays empty");
}

// ── one answer to "how long may a spawn take" ────────────────────────────────────────────────────
// `paw dm` waited 20s for a fresh spawn; `paw chat`'s `@name` waited 8s, always. A cold claude
// resuming a days-old session takes ~20s, so the SAME agent woke fine via dm and reported "offline and
// couldn't be respawned" via chat (reported 2026-08-17). The constants are shared now; this asserts the
// relationship rather than the numbers, which is the part that must not drift.
{
  const { FRESH_SPAWN_MS, LIVE_AGENT_MS } = await import("../src/dm.js");
  assert(FRESH_SPAWN_MS > LIVE_AGENT_MS, "a fresh spawn is allowed longer than reaching an already-live agent");
  assert(FRESH_SPAWN_MS >= 20_000, "a cold start measured ~20s here — anything less calls a booting agent dead");
}


// ---- explainManagerFailure: the manager-startup error names the CAUSE, not tmux ----
{
  const { explainManagerFailure } = await import("../src/lifecycle.js");
  const base = { runtime: "tmux", space: "paw", logPath: "/tmp/manager.log" };

  // The reported case: 25 lease losses, and the old text asked about tmux.
  const churn = explainManagerFailure({ ...base, logTail: ["✓ manager up (space paw · tmux)", '! manager lost its singleton lease for space "paw" (timeout) - shutting down', "✓ manager up (space paw · tmux)"].join("\n") });
  assert(churn.includes("LOSING ITS LEASE"), "manager error: lease churn is NAMED, not buried in a log dump");
  assert(churn.includes("1×"), "manager error: …and counted, so the operator can see it is a loop");
  assert(!churn.includes("is tmux running"), "manager error: does NOT blame tmux when the log says otherwise");
  assert(churn.includes("/tmp/manager.log"), "manager error: points at the log instead of reprinting it");

  // Two managers is a different fault with a different fix.
  const dup = explainManagerFailure({ ...base, logTail: 'a manager already serves space "paw" (id local.x, tmux, pid 47032)' });
  assert(dup.includes("already serving this space") && dup.includes("paw down"), "manager error: competing managers get their own fix");
  // A healthy manager is TWO processes (tsx wrapper + node child), so a process COUNT can never mean
  // "duplicate" — only the manager's own self-report can.
  assert(!explainManagerFailure({ ...base, logTail: "✓ manager up (space paw · tmux)" }).includes("already serving this space"), "manager error: a normal 2-process manager is NOT reported as a duplicate");

  // The ONE case where naming the runtime is right.
  const missing = explainManagerFailure({ ...base, logTail: "tsx: line 20: exec: node: not found" });
  assert(missing.includes("isn't on PATH") && missing.includes("tmux"), "manager error: a missing binary DOES name the runtime");

  // Unknown cause: short, honest, with the last lines and the path — never a 20-line dump.
  const unknown = explainManagerFailure({ ...base, logTail: Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n") });
  assert(unknown.split("\n").length < 10, "manager error: an unknown cause stays SHORT rather than dumping the log");
  assert(unknown.includes("line 29"), "manager error: …but still shows the last lines, which is where the cause usually is");
  assert(explainManagerFailure({ ...base, logTail: "" }).includes("still be starting"), "manager error: an EMPTY log says so rather than showing blankness");
}


// ---- locks recover from a KILLED holder instead of waiting out a timer ----
{
  const { withFileLock } = await import("../src/lock.js");
  const { writeFileSync, existsSync, mkdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  const dir = join(process.env.PAW_HOME as string, "locktest");
  mkdirSync(dir, { recursive: true });

  // A lock left behind by a process that no longer exists must break IMMEDIATELY. Before the pid
  // stamp this waited on a 60s age test that a 30s waiter could never outlast — so Ctrl-C-ing a paw
  // command reliably broke the NEXT one.
  const dead = join(dir, "dead.lock");
  writeFileSync(dead, "999999"); // a pid that cannot be running
  const t0 = Date.now();
  const got = withFileLock(dead, () => "acquired");
  assert(got === "acquired" && Date.now() - t0 < 2000, "lock: a lock held by a DEAD pid breaks at once, not after a timeout");

  // Our own pid is alive, so that lock is genuinely held — it must NOT be stolen.
  const live = join(dir, "live.lock");
  writeFileSync(live, String(process.pid));
  let stolen = false;
  try {
    withFileLock(live, () => { stolen = true; return 0; }, { maxWaitMs: 150, staleMs: 60_000 });
  } catch {
    /* expected: times out rather than breaking a live holder */
  }
  assert(!stolen, "lock: a lock held by a LIVE process is never broken");

  // An old paw wrote empty locks; those must still work via the age backstop rather than throwing.
  const empty = join(dir, "empty.lock");
  writeFileSync(empty, "");
  let threw = false;
  try {
    withFileLock(empty, () => 0, { maxWaitMs: 150, staleMs: 60_000 });
  } catch {
    threw = true;
  }
  assert(threw, "lock: a pidless lock falls back to the AGE test (not stolen on sight)");
  assert(existsSync(dir), "lock: fixture dir intact");
}

// ---- spawn pacing (src/pacing.ts) — the anti-thundering-herd gate for revival ----
{
  const { hasHeadroom, loadThreshold, awaitSpawnHeadroom } = await import("../src/pacing.js");

  assert(loadThreshold(10) === 20, "pacing: default threshold is ncpu × 2");
  assert(hasHeadroom(19.9, 10), "pacing: load just under the threshold is headroom");
  assert(!hasHeadroom(20, 10), "pacing: load AT the threshold gates (saturated is not headroom)");
  assert(!hasHeadroom(141, 10), "pacing: the incident's load 141 on 10 cores gates");
  assert(hasHeadroom(141, 10, 15), "pacing: factor is honored");

  // Immediate clear: a machine with headroom never waits and never announces a wait.
  {
    let waited = false;
    const r = await awaitSpawnHeadroom({ sample: () => 1, cpus: 10, onWait: () => { waited = true; }, sleep: async () => {} });
    assert(r === "clear" && !waited, "pacing: headroom up front → clear, no wait announced");
  }
  // Load that settles: gate announces once, polls, clears when the sampler drops.
  {
    const samples = [141, 90, 30, 5];
    let announced = 0;
    let sleeps = 0;
    const r = await awaitSpawnHeadroom({
      sample: () => samples.shift() ?? 5,
      cpus: 10,
      pollMs: 10,
      capMs: 1000,
      onWait: () => announced++,
      sleep: async () => { sleeps++; },
    });
    assert(r === "clear", "pacing: clears once load drops below the threshold");
    assert(announced === 1, "pacing: the wait is announced exactly once");
    assert(sleeps === 3, "pacing: polls until the first sample with headroom");
  }
  // Load that never settles: BOUNDED — gives up at the cap so revival can't wedge forever.
  {
    const r = await awaitSpawnHeadroom({ sample: () => 200, cpus: 10, pollMs: 10, capMs: 35, sleep: async () => {} });
    assert(r === "gave-up", "pacing: a machine that never clears is a bounded wait, not a wedge");
  }
}

// ---- launchd (src/commands/launchd.ts) — pure arg parse + plist rendering ----
{
  const { parseLaunchdArgs, renderPlist, fleetJob, webJob, FLEET_LABEL, WEB_LABEL } = await import("../src/commands/launchd.js");
  const threw = (f: () => unknown): boolean => {
    try {
      f();
      return false;
    } catch {
      return true;
    }
  };

  assert(parseLaunchdArgs([]).action === "status", "launchd: no args → status");
  const inst = parseLaunchdArgs(["install", "research", "queue-ea", "--web-port", "7788", "--space", "x"]);
  assert(inst.action === "install" && inst.names.join(",") === "research,queue-ea" && inst.webPort === 7788 && inst.space === "x" && inst.web, "launchd: install parses names + flags");
  assert(!parseLaunchdArgs(["install", "a", "--no-web"]).web, "launchd: --no-web");
  assert(threw(() => parseLaunchdArgs(["install", "--web-port", "abc"])), "launchd: garbage --web-port throws");
  assert(threw(() => parseLaunchdArgs(["status", "extra"])), "launchd: a positional after status/uninstall throws");
  assert(threw(() => parseLaunchdArgs(["--bogus"])), "launchd: unknown flag throws");

  const cli = ["/usr/bin/node", "/repo/node_modules/tsx/dist/cli.mjs", "/repo/bin/paw.ts"];
  const env = { PATH: "/a:/b", HOME: "/h" };
  const fleet = fleetJob("paw", ["research", "a&b"], { cli, env, log: "/l/launchd.log", cwd: "/h" });
  assert(fleet.label === FLEET_LABEL && !fleet.keepAlive, "launchd: fleet job is one-shot (no KeepAlive)");
  assert(fleet.args.join(" ") === "/usr/bin/node /repo/node_modules/tsx/dist/cli.mjs /repo/bin/paw.ts start research a&b --space paw", "launchd: fleet job runs `paw start <names> --space`");
  const web = webJob("paw", 7788, { cli, env, log: "/l/web.log", cwd: "/h" });
  assert(web.label === WEB_LABEL && web.keepAlive, "launchd: web job is KeepAlive");
  assert(web.args.slice(3).join(" ") === "web --no-open --port 7788 --space paw", "launchd: web job args");
  assert(webJob("paw", undefined, { cli, env, log: "/l", cwd: "/h" }).args.slice(3).join(" ") === "web --no-open --space paw", "launchd: web job omits --port when unset");

  const plist = renderPlist(fleet);
  assert(plist.includes("<key>Label</key>\n  <string>dev.cotal.paw</string>"), "launchd: plist carries the label");
  assert(plist.includes("<string>a&amp;b</string>"), "launchd: plist XML-escapes args");
  assert(plist.includes("<key>KeepAlive</key>\n  <false/>"), "launchd: fleet plist KeepAlive false");
  assert(renderPlist(web).includes("<key>KeepAlive</key>\n  <true/>"), "launchd: web plist KeepAlive true");
  assert(plist.includes("<key>PATH</key>\n    <string>/a:/b</string>"), "launchd: plist writes PATH env");
  assert(plist.includes("<key>RunAtLoad</key>\n  <true/>"), "launchd: RunAtLoad");
  assert(plist.includes("<string>/l/launchd.log</string>"), "launchd: stdout/err → log path");
  const { globalJob, GLOBAL_LABEL, GLOBAL_INTERVAL_S } = await import("../src/commands/launchd.js");
  const g = globalJob("paw", { cli, env, log: "/l/g.log", cwd: "/h" });
  assert(g.label === GLOBAL_LABEL && !g.keepAlive && g.startInterval === GLOBAL_INTERVAL_S, "launchd: global keeper is a StartInterval one-shot, not KeepAlive");
  assert(g.args.slice(3).join(" ") === "global --space paw", "launchd: global keeper runs `paw global --space <s>`");
  const gp = renderPlist(g);
  assert(gp.includes(`<key>StartInterval</key>\n  <integer>${GLOBAL_INTERVAL_S}</integer>`), "launchd: keeper plist carries StartInterval");
  assert(!renderPlist(fleet).includes("StartInterval"), "launchd: the fleet job never re-runs on an interval (it would re-wake stopped agents)");
  assert(!parseLaunchdArgs(["install", "a", "--no-global"]).global && parseLaunchdArgs(["install", "a"]).global, "launchd: --no-global opts out of the keeper");
}

// package bin must be a committed file that exists — `./dist/bin/paw.js` was gitignored, so
// `npx github:caffeinum/paw` / a fresh clone ran a missing path (beads-6bfz).
{
  const { readFileSync, existsSync } = await import("node:fs");
  const { dirname, join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { bin?: { paw?: string } };
  const bin = pkg.bin?.paw;
  assert(typeof bin === "string" && bin === "./bin/paw.mjs", "package.json bin.paw is the committed tsx launcher, not dist/");
  const launcher = join(root, "bin/paw.mjs");
  assert(existsSync(launcher), "bin/paw.mjs exists");
  const body = readFileSync(launcher, "utf8");
  assert(body.startsWith("#!/usr/bin/env node"), "bin/paw.mjs has a node shebang");
  assert(body.includes("paw.ts") && body.includes("tsx"), "launcher runs the TS composition root through tsx");
}

// ── paw type: typing into an agent's terminal (2026-09-23) ──────────────────────────────────────────
{
  const { parseTypeArgs, parseTyped, parseKeyNames, paneTail } = await import("../src/commands/type.js");
  const { paneInput } = await import("../src/unstick.js");

  // targeting: @name / folder / none → this folder; a bare word is TEXT
  const t1 = parseTypeArgs(["/model", "claude-fable-5", "--space", "paw"]);
  assert(t1.target === undefined && t1.words.join(" ") === "/model claude-fable-5" && t1.space === "paw", "type: no target → this folder's agent; `/model` is text, not a path; the injected --space is peeled off");
  const t2 = parseTypeArgs(["@evals", "/compact"]);
  assert(t2.target === "evals" && t2.words.join(" ") === "/compact", "type: @name targets an agent, like chat's sigil");
  assert(parseTypeArgs([".", "hi"]).target === "." && parseTypeArgs(["~/x", "hi"]).target === "~/x", "type: a folder sigil targets that folder's agent");
  const t3 = parseTypeArgs(["evals", "/compact"]);
  assert(t3.target === undefined && t3.bareFirst === "evals", "type: a bare first word is text — and handed back so the command can ask `did you mean @evals?`");
  assert(parseTypeArgs(["@a", "/model", "x", "--fast"]).words.join(" ") === "/model x --fast", "type: flags AFTER the text starts belong to the text");
  assert(parseTypeArgs(["--", "-x"]).words.join(" ") === "-x", "type: `--` lets text start with a dash");
  assert(parseTypeArgs(["--keys", "Down", "Enter"]).keys, "type: --keys");
  let e = "";
  try { parseTypeArgs(["@a"]); } catch (x) { e = (x as Error).message; }
  assert(e.includes("usage"), "type: nothing to type → usage");

  // line vs keys
  const line = parseTyped("/model claude-fable-5");
  assert(!line.exact && JSON.stringify(line.parts) === JSON.stringify([{ literal: "/model claude-fable-5" }, { key: "Enter" }]), "typed: plain text is a LINE — Enter appended");
  const enter = parseTyped("\\n");
  assert(enter.exact && JSON.stringify(enter.parts) === JSON.stringify([{ key: "Enter" }]), "typed: `\\n` alone is exactly one Enter (confirm a dialog) — nothing appended");
  const two = parseTyped("2\\n");
  assert(two.exact && JSON.stringify(two.parts) === JSON.stringify([{ literal: "2" }, { key: "Enter" }]), "typed: `2\\n` picks option 2");
  const oneShot = parseTyped("/model claude-fable-5\\n\\n");
  assert(JSON.stringify(oneShot.parts) === JSON.stringify([{ literal: "/model claude-fable-5" }, { key: "Enter" }, { key: "Enter" }]), "typed: `/model x\\n\\n` = the line, Enter, then Enter to confirm");
  assert(JSON.stringify(parseTyped("\\e").parts) === JSON.stringify([{ key: "Escape" }]) && JSON.stringify(parseTyped("a\\\\nb").parts) === JSON.stringify([{ literal: "a\\nb" }, { key: "Enter" }]), "typed: `\\e` is Escape; `\\\\n` is a literal backslash-n");
  assert(JSON.stringify(parseTyped("2\n").parts) === JSON.stringify([{ literal: "2" }, { key: "Enter" }]), "typed: a REAL newline ($'2\\n') is Enter too");
  assert(JSON.stringify(parseKeyNames(["Down", "C-c", "Enter"])) === JSON.stringify([{ key: "Down" }, { key: "C-c" }, { key: "Enter" }]), "keys: tmux key names");
  e = "";
  try { parseKeyNames(["Dwon"]); } catch (x) { e = (x as Error).message; }
  assert(e.includes('"Dwon"'), "keys: a typo'd key name fails loud instead of being typed as text");

  // the input box, read from a real Claude Code pane (evals, captured 2026-09-23)
  const rule = "─".repeat(60);
  const idle = `  That thread is done.\n\n${rule}\n❯ \n\n${rule}\n  🐾 evals [main] (Opus 5) 430k/1m at 43% >\n  ⏵⏵ bypass permissions on`;
  assert(JSON.stringify(paneInput(idle)) === JSON.stringify({ visible: true, text: "" }), "pane: an idle agent's box is visible and empty → safe to type");
  assert(paneInput(idle.replace("❯ ", "❯ half written")).text === "half written", "pane: half-written input is seen — typing would append to it");
  assert(!paneInput(`Do you want to proceed?\n❯ 1. Yes\n  2. No\nEsc to cancel`).visible, "pane: a numbered choice list is NOT the input box (no rules around it)");
  assert(!paneInput("> quoted markdown\nplain").visible, "pane: a stray `>` line isn't the box");
  assert(paneTail("a\n\n  b  \nc\n", 2).join("|") === "  b|c", "pane: tail = the last non-blank lines");
}

if (failures > 0) {
  console.error(`\n${failures} paw command check(s) failed`);
  process.exit(1);
}
console.log("\nall paw command checks passed 🐾");


// ── launchd bakes a paw-owned nvm shim, never a versioned (brew Cellar / nvm versions) path ──
{
  const { nvmShim, stableNodeBin } = await import("../src/commands/launchd.js");
  const { existsSync, statSync, readFileSync } = await import("node:fs");
  const body = nvmShim("/Users/x/.nvm");
  assert(body.startsWith("#!/bin/sh"), "shim is a sh script launchd can exec directly");
  assert(body.includes('. "$NVM_DIR/nvm.sh" --no-use'), "shim sources nvm.sh (nvm's own resolution, no re-implementation)");
  assert(body.includes("nvm which default"), "shim asks nvm for the DEFAULT node at launch time");
  assert(body.includes('exec "$NODE"'), "shim execs so the job's pid IS node");
  assert(!body.includes("homebrew"), "shim never mentions brew");
  const p = stableNodeBin();
  assert(existsSync(p) && (statSync(p).mode & 0o111) !== 0, "stableNodeBin returns an existing executable");
  if (existsSync(`${process.env.HOME}/.nvm/nvm.sh`)) {
    assert(p.endsWith("/bin/node") && readFileSync(p, "utf8").includes("nvm which default"), "with nvm installed, the baked path is paw's shim, not a versioned binary");
    assert(!p.includes("/Cellar/") && !p.includes("/.nvm/versions/"), "never a path an upgrade can delete");
  }
  console.log("✓ launchd node path is the nvm shim");
}

// ---- paw optimize: the cutoff parse and the careful restart verdict ----
{
  const { parseWindow, parseOptimizeArgs, optimizeVerdict } = await import("../src/commands/optimize.js");
  const ok = (c: boolean, m: string) => { if (!c) throw new Error(`optimize: ${m}`); console.log(`  ok  optimize: ${m}`); };
  ok(parseWindow("24h", "--since") === 86_400_000 && parseWindow("30m", "--since") === 1_800_000 && parseWindow("2d", "--since") === 172_800_000, "windows parse (m/h/d)");
  let threw = false; try { parseWindow("24", "--since"); } catch { threw = true; }
  ok(threw, "a unitless window fails loud");
  const a = parseOptimizeArgs(["--since", "48h", "--dry-run", "research"]);
  ok(a.sinceMs === 172_800_000 && a.dryRun && a.names[0] === "research", "flags + names");
  const now = 10_000_000_000;
  const H = 3_600_000;
  const row = { name: "x", folder: "/tmp", mesh: "idle", live: true, runtime: "tmux", pin: "p", durable: true, activeMs: now - 30 * H, busy: false, conflictPids: [], inbox: { kind: "lag", queued: 0, unread: 0 } } as never;
  const one = [{ pid: 7, mesh: true }];
  const o = { sinceMs: 24 * H };
  const v = (r: object, p: object[] = one) => optimizeVerdict({ ...(row as object), ...r } as never, p as never, now, o);
  ok(v({}).act === "restart", "idle, last active 30h ago, alone on its session → restart");
  ok(v({ activeMs: now - 2 * H }).act === "recent", "active 2h ago → not a candidate");
  ok(v({ activeMs: undefined }).act === "skip", "unknown last activity → skip, never assume idle");
  ok(v({}, [...one, { pid: 8, mesh: true }]).act === "skip", "two processes on one session → never touched");
  ok(v({ busy: true }).act === "skip" && v({ mesh: "working" }).act === "skip", "mid-turn / working → skip");
  ok(v({ inbox: { kind: "lag", queued: 0, unread: 2 } }).act === "skip", "unread DMs → skip");
  ok(v({ durable: false }).act === "skip" && v({ harness: "codex" }).act === "skip", "no resumable session / non-claude → skip");
  ok(v({ live: false }).act === "skip" && v({ runtime: "fg" }).act === "skip", "offline / foreground → skip");
  ok(v({ folder: "/definitely/not/here" }).act === "stop", "folder deleted + idle past the window → stop (it can never come back there)");
  ok(v({ folder: "/definitely/not/here", busy: true }).act === "skip", "folder deleted but mid-turn → still left alone");
}
