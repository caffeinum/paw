/**
 * Acceptance checks for `paw web` (src/web.ts) — the local http+ws daemon on 127.0.0.1 that a browser
 * reads paw's own state through. Hermetic: no mesh, no manager, no live agents, no tty, no browser.
 * Every other paw check runs with nothing else alive and this one must too, so everything real arrives
 * through a stubbed {@link WebDeps} — what is under test is the contract a browser sees, not whether the
 * mesh happens to be up.
 *
 * What these defend, in order of what it costs to get wrong:
 *
 *  1. **Origin and Host.** There is no token (operator's call), so these two are the ONLY thing between
 *     a page you happen to have open and a process that can DM as you. A cross-site fetch always carries
 *     an Origin; DNS rebinding arrives on a hostile Host that resolves to loopback. And CORS does not
 *     cover a WebSocket at all — the browser completes that handshake and hands the page a live feed of
 *     your DMs unless the server refuses the upgrade itself.
 *  2. **The WebSocket framing**, which is hand-rolled — the largest block of code here and the one with
 *     no library behind it. Its failure mode is the nastiest kind: a length read at the wrong width
 *     consumes the wrong number of bytes and leaves the stream MISALIGNED, after which every later frame
 *     is garbage and the feed dies silently rather than erroring. Hence the weight below on length
 *     boundaries, fragments, masking, split reads and the close handshake.
 *  3. **The conversation admits only the human's own mail.** The tap sees the whole space; if channel
 *     traffic or agent↔agent DMs enter the human's stream then everything is unread from day one and the
 *     unread signal is dead before anyone uses it. This is the check that protects the feature.
 *  4. **A busy port fails loud.** Auto-incrementing is the failure that looks like success: the operator
 *     opens the port they asked for, finds this morning's stale daemon, and debugs the wrong process.
 *  5. **The wire shapes**, so the client and the daemon cannot drift apart silently.
 *
 * Run: pnpm check:web
 */
import { connect, createServer, type Socket } from "node:net";
import { request } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Conversation,
  Village,
  allowedHost,
  allowedOrigin,
  keyOf,
  parseArgs,
  inviteText,
  serveStatic,
  startWebServer,
} from "../src/web.js";

const ESC = String.fromCharCode(27);
const NUL = String.fromCharCode(0);

// `/api/read` WRITES the shared inbox cursor, so point PAW_HOME at a temp dir before anything can touch
// the operator's real one. src/cursor.ts resolves it per call, so setting it here is early enough.
process.env.PAW_HOME = mkdtempSync(join(tmpdir(), "paw-web-home-"));

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`  ok  ${msg}`);
  else {
    failures++;
    console.error(`  FAIL  ${msg}`);
  }
}

type Entry = { from: string; text: string; ts: number; dir?: "in" | "out"; to?: string };

/* ── args ─────────────────────────────────────────────────────────────────────────────────────── */

assert(parseArgs([]).port === 7788, "the default port is 7788 — 7799 belongs to `cotal web` and both run at once");
assert(parseArgs(["--port", "9000"]).port === 9000, "--port is honoured");
assert(parseArgs([]).open === true && parseArgs(["--no-open"]).open === false, "--no-open suppresses the browser launch");
for (const bad of [["--port", "0"], ["--port", "70000"], ["--port", "http"], ["--port"], ["--prot", "9000"]]) {
  let threw = false;
  try {
    parseArgs(bad);
  } catch {
    threw = true;
  }
  assert(threw, `\`paw web ${bad.join(" ")}\` fails loud rather than falling back to a default port`);
}

/* ── Origin and Host, as pure rules ───────────────────────────────────────────────────────────── */

const P = 7788;
assert(allowedOrigin(`http://127.0.0.1:${P}`, P), "the loopback origin the page is served from is allowed");
assert(allowedOrigin(`http://localhost:${P}`, P), "localhost is the same daemon by another name and is allowed");
assert(allowedOrigin(`http://[::1]:${P}`, P), "the IPv6 loopback spelling is allowed");
assert(allowedOrigin(undefined, P), "a request with NO Origin is allowed — that is curl, not a page");

assert(!allowedOrigin("http://evil.example", P), "an unknown origin is refused");
assert(!allowedOrigin("https://evil.example", P), "https makes no difference to an unknown origin");
// A `startsWith` / `includes` check passes every one of these. They are the bug, not paranoia.
assert(!allowedOrigin(`http://127.0.0.1:${P}.evil.example`, P), "a look-alike HOST beginning with the address is refused");
assert(!allowedOrigin(`http://evil.example/http://127.0.0.1:${P}`, P), "the address appearing in a PATH is refused");
assert(!allowedOrigin(`http://127.0.0.1:${P}@evil.example`, P), "userinfo smuggling the address is refused");
assert(!allowedOrigin(`http://127.0.0.1:${P + 1}`, P), "the right host on the WRONG port is refused — another daemon is not this one");
assert(!allowedOrigin("null", P), "the literal `null` origin (sandboxed iframe, data: URL) is refused, and is not the same as absent");
assert(!allowedOrigin("http://127.0.0.1", P), "a portless loopback origin is refused rather than assumed to mean this port");

assert(allowedHost(`127.0.0.1:${P}`, P) && allowedHost(`localhost:${P}`, P), "a loopback Host is allowed");
assert(allowedHost(`LOCALHOST:${P}`, P), "the Host comparison is case-insensitive, as DNS is");
assert(!allowedHost(undefined, P), "a request with NO Host is refused — every HTTP/1.1 request carries one");
assert(!allowedHost(`paw.evil.example:${P}`, P), "a rebinding Host pointed at loopback is refused");
assert(!allowedHost(`127.0.0.1:${P + 1}`, P), "a loopback Host on the wrong port is refused");

/* ── the conversation admits only the human's own mail ────────────────────────────────────────── */

const ME = "local.humanid";
const parts = (s: string) => [{ kind: "text", text: s }];
const fakeEp = (history: unknown[] = []) =>
  ({
    card: { id: ME, name: "you" },
    getRoster: () => [{ card: { id: "local.devweb", name: "dev-web" } }],
    dmHistory: async () => history,
  }) as never;

const convo = new Conversation(fakeEp());
const inbound = convo.accept({ id: "m1", from: { id: "local.devweb", name: "dev-web" }, to: ME, ts: 100, parts: parts("on it") } as never);
assert(inbound?.dir === "in" && inbound.from === "dev-web" && inbound.text === "on it", "a DM addressed to you is accepted as incoming");
const outbound = convo.accept({ id: "m2", from: { id: ME, name: "you" }, to: "local.devweb", ts: 200, parts: parts("ship it") } as never);
assert(outbound?.dir === "out" && outbound.to === "dev-web", "your own DM is accepted as outgoing, with the recipient NAMED from the roster");

// THE ONE THAT PROTECTS THE FEATURE. The tap sees the whole space, not just your mail.
assert(
  convo.accept({ id: "m3", from: { id: "local.voice", name: "voice" }, to: "local.via", ts: 300, parts: parts("@via look") } as never) === undefined,
  "a DM between two OTHER agents never enters the human's conversation — otherwise unread is lit forever",
);
assert(
  convo.accept({ id: "m4", from: { id: "local.voice", name: "voice" }, ts: 400, parts: parts("posted to #general") } as never) === undefined,
  "channel traffic never enters the human's conversation",
);
assert(convo.accept(undefined as never) === undefined, "an undefined frame is survived — core does not try/catch the tap handler");
assert(convo.accept({ ts: 500, parts: [] } as never) === undefined, "a control reply carrying no `from` is survived rather than dereferenced");
assert(
  convo.accept({ id: "m1", from: { id: "local.devweb", name: "dev-web" }, to: ME, ts: 100, parts: parts("on it") } as never) === undefined,
  "a re-delivered message id is not accepted twice",
);
assert(convo.entries().length === 2, "only the two entries that are actually yours are held");

// After a fleet restart every agent carries a NEW id, and the roster can lag or be gone: an outgoing
// DM accepted before that id has been seen sending keeps the raw id, and the client's optimistic row
// (matched on the NAME) shows "waiting" forever. The name must land as soon as it is learnable.
const late = new Conversation(fakeEp());
const unnamed = late.accept({ id: "u1", from: { id: ME, name: "you" }, to: "local.newvibe", ts: 600, parts: parts("hey") } as never);
assert(unnamed?.dir === "out" && unnamed.to === "local.newvibe", "an unresolvable recipient stays an id — never guessed");
late.accept({ id: "u2", from: { id: "local.newvibe", name: "vibeos-landing" }, to: ME, ts: 700, parts: parts("hey back") } as never);
assert(late.entries().find((e) => e.dir === "out")?.to === "vibeos-landing", "the id is re-resolved on read once that peer has spoken");
const lateHist = new Conversation(fakeEp([{ id: "h9", from: { id: ME, name: "you" }, to: "local.newvibe", ts: 600, parts: parts("hey") }]));
await lateHist.reconcile();
assert(lateHist.entries()[0]?.to === "local.newvibe", "a reconciled history entry to an unseen id keeps the id");
lateHist.accept({ id: "h10", from: { id: "local.newvibe", name: "vibeos-landing" }, to: ME, ts: 700, parts: parts("yo") } as never);
assert(lateHist.entries()[0]?.to === "vibeos-landing", "a reconciled history entry is re-resolved too, not only the live tail");

/* ── the Village tracker: DM edges + last-spoken lines from the whole-space tap ─────────────────── */
{
  const ME = "local.humanid";
  const parts = (t: string) => [{ kind: "text", text: t }];
  const v = new Village(ME);
  // agent a DMs agent b — but b's id isn't known yet (nobody has seen b send), so no edge can form.
  v.note({ id: "e1", from: { id: "local.a", name: "alpha" }, to: "local.b", ts: 100, parts: parts("hi b") } as never);
  assert(v.snapshot().edges.length === 0, "village: an edge whose recipient id isn't resolved to a name yet is NOT drawn");
  assert(v.snapshot().last["alpha"]?.text === "hi b", "village: the sender's last-spoken line is recorded");
  // b now sends (resolving its name); a→b becomes drawable on the NEXT a→b frame.
  v.note({ id: "e2", from: { id: "local.b", name: "beta" }, to: "local.a", ts: 110, parts: parts("hi a") } as never);
  assert(v.snapshot().edges.length === 1, "village: a reply from beta resolves the pair and forms one edge");
  v.note({ id: "e3", from: { id: "local.a", name: "alpha" }, to: "local.b", ts: 120, parts: parts("again") } as never);
  const eg = v.snapshot().edges[0];
  assert(eg.count === 2 && eg.a <= eg.b, "village: repeated traffic increments the edge weight; the pair key is name-sorted");
  // a channel post is NOT a pairwise edge, but it still updates the sender's last line.
  v.note({ id: "e4", from: { id: "local.a", name: "alpha" }, channel: "general", ts: 130, parts: parts("posted") } as never);
  assert(v.snapshot().edges.length === 1, "village: a channel post creates no edge");
  assert(v.snapshot().last["alpha"]?.text === "posted", "village: a channel post still updates the sender's last line");
  // an edge to "you" resolves against the human id and labels it HUMAN_PEER-side.
  v.note({ id: "e5", from: { id: "local.a", name: "alpha" }, to: ME, ts: 140, parts: parts("for you") } as never);
  assert(v.snapshot().edges.some((e) => e.a === "you" || e.b === "you"), "village: an agent→you DM forms a you-edge");
  // a re-delivered id doesn't double-count.
  const before = v.snapshot().edges.find((e) => e.a !== "you" && e.b !== "you")!.count;
  v.note({ id: "e3", from: { id: "local.a", name: "alpha" }, to: "local.b", ts: 120, parts: parts("again") } as never);
  assert(v.snapshot().edges.find((e) => e.a !== "you" && e.b !== "you")!.count === before, "village: a re-delivered frame id is not counted twice");
  // the shape guard: a control frame with no `from` is survived, not dereferenced.
  v.note(undefined as never);
  v.note({ ts: 200, parts: [] } as never);
  assert(true, "village: an undefined / from-less frame is survived");
}

// A reconcile replaces the history and drops the live entries it now covers, WITHOUT losing the ones
// that arrived after the read started.
const reconciled = new Conversation(fakeEp([{ id: "h1", from: { id: "local.devweb", name: "dev-web" }, to: ME, ts: 100, parts: parts("on it") }]));
reconciled.accept({ id: "h1", from: { id: "local.devweb", name: "dev-web" }, to: ME, ts: 100, parts: parts("on it") } as never);
reconciled.accept({ id: "h2", from: { id: "local.devweb", name: "dev-web" }, to: ME, ts: 900, parts: parts("done") } as never);
await reconciled.reconcile();
assert(reconciled.entries().length === 2, "a reconcile de-duplicates the overlap instead of doubling it");
assert(reconciled.entries().some((e) => e.text === "done"), "a message newer than the re-read survives the reconcile rather than being dropped");

// The dedupe identity must not be forgeable from message CONTENT: under a space separator these two
// distinct messages collapse to one key and one of them silently disappears from the feed.
assert(keyOf({ from: "a", text: "b c", ts: 1 }) !== keyOf({ from: "a b", text: "c", ts: 1 }), "the dedupe key cannot be forged by putting the separator inside a name");
assert(keyOf({ from: "a", text: "b", ts: 1 }).includes(NUL), "the separator is a NUL — no message body can contain one");

/* ── static serving stays inside the bundle ───────────────────────────────────────────────────── */

const fakeRes = () => {
  const out = { status: 0 };
  return { out, res: { writeHead: (s: number) => void (out.status = s), end: () => {} } as never };
};
{
  const { out, res } = fakeRes();
  serveStatic(undefined, "/", res);
  assert(out.status === 503, "with no client bundle the UI 503s and says so — the API stays up regardless");
}
for (const escape of ["/../../etc/passwd", "/..%2f..%2f..%2fetc%2fpasswd", "/assets/../../../../etc/passwd"]) {
  const { out, res } = fakeRes();
  serveStatic("/nonexistent-root", escape, res);
  assert(out.status === 403, `a path escaping the client root is refused (${escape})`);
}

/* ── a live server, against stubs ─────────────────────────────────────────────────────────────── */

const freePort = async (): Promise<number> =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      if (typeof a === "string" || a === null) return reject(new Error("no port"));
      const p = a.port;
      s.close(() => resolve(p));
    });
  });

const conv: Entry[] = [
  { from: "you", text: "start on the queue bug", ts: 100, dir: "out", to: "dev-web" },
  { from: "dev-web", text: "on it", ts: 200, dir: "in" },
  { from: "design-web", text: "mock is up", ts: 400, dir: "in" },
];
const sent: Array<{ to: string; text: string }> = [];
const posted: Array<{ channel: string; text: string }> = [];
const deps = {
  space: "webcheck",
  convo: { entries: () => conv },
  status: async () => ({ rows: [{ name: "dev-web", status: "idle" }], errors: ["inbox lag unknown for via"] }),
  trace: (name: string) => {
    if (name !== "dev-web") throw new Error(`paw: no agent named "${name}"`);
    return [{ kind: "assistant", markdown: "**bold** and `code`" }];
  },
  dm: async (to: string, text: string) => {
    sent.push({ to, text });
    // One agent that cannot be reached, so the partial-failure paths (notably /api/invite) are
    // exercised against a real rejection rather than only the happy case.
    if (to === "boom") throw new Error(`paw: no agent named "boom"`);
    return { name: to };
  },
  post: async (channel: string, text: string) => {
    posted.push({ channel, text });
  },
  bash: async (agent: string, command: string) => {
    if (agent === "ghost") throw new Error(`paw: no agent named "ghost"`);
    const { runBash } = await import("../src/bash.js");
    return runBash(command, process.cwd());
  },
};

// A client bundle to serve, so static handling is exercised over the real socket too, not only in theory.
const root = mkdtempSync(join(tmpdir(), "paw-web-client-"));
writeFileSync(join(root, "index.html"), "<!doctype html><title>paw</title>");
mkdirSync(join(root, "assets"));
writeFileSync(join(root, "assets", "app.js"), "export const x = 1;\n");

const port = await freePort();
const server = await startWebServer({ ...deps, port, clientRoot: root });
const base = `http://127.0.0.1:${port}`;
const ORIGIN = { Origin: base };
assert(server.port === port, "the server reports the port it actually bound");

// A busy port must THROW. Binding elsewhere is worse than not starting.
let busy: Error | undefined;
try {
  const second = await startWebServer({ ...deps, port });
  await second.close();
} catch (e) {
  busy = e as Error;
}
assert(busy !== undefined, "starting on a port already in use THROWS rather than picking another");
assert(busy !== undefined && busy.message.includes(String(port)), "the busy-port error names the port that was refused");

/* ── the wire shapes ──────────────────────────────────────────────────────────────────────────── */

const statusBody = (await (await fetch(`${base}/api/status`, { headers: ORIGIN })).json()) as { space?: string; rows?: unknown; errors?: unknown };
assert(statusBody.space === "webcheck" && Array.isArray(statusBody.rows), "GET /api/status carries the space and its rows");
assert(
  Array.isArray(statusBody.errors) && (statusBody.errors as string[]).length === 1,
  "the status payload carries errors — an inbox lag paw could not query must not render as a measured zero",
);

const inboxBody = (await (await fetch(`${base}/api/inbox?sent=1`, { headers: ORIGIN })).json()) as { space?: string; cursor?: unknown; messages?: Entry[] };
assert(inboxBody.space === "webcheck" && typeof inboxBody.cursor === "number", "GET /api/inbox carries the space and the shared cursor");
assert((inboxBody.messages ?? []).some((m) => m.dir === "out"), "`sent=1` widens to BOTH directions — half a transcript is not a conversation");

const inboxDefault = (await (await fetch(`${base}/api/inbox`, { headers: ORIGIN })).json()) as { messages?: Entry[] };
assert(
  (inboxDefault.messages ?? []).length > 0 && (inboxDefault.messages ?? []).every((m) => m.dir !== "out"),
  "without `sent` the default stays the INBOX, so the flag is the only thing that widens it",
);
const limited = (await (await fetch(`${base}/api/inbox?limit=1`, { headers: ORIGIN })).json()) as { messages?: Entry[]; unread?: number };
assert(limited.messages?.length === 1 && limited.messages[0].text === "mock is up", "`limit` takes the NEWEST — a truncated tail is the useful half");
for (const bad of ["0", "-1", "1.5", "all"]) {
  assert((await fetch(`${base}/api/inbox?limit=${bad}`, { headers: ORIGIN })).status === 400, `limit=${bad} fails loud rather than being clamped silently`);
}

// `unread` is computed HERE, once, so two surfaces cannot disagree about what you have read.
const fresh0 = (await (await fetch(`${base}/api/inbox`, { headers: ORIGIN })).json()) as { unread?: number; cursor?: number };
assert(fresh0.cursor === 0 && fresh0.unread === 2, "the inbox payload carries `unread`, counting the two incoming messages past a cursor of 0");
assert(limited.unread === 2, "`unread` counts the WHOLE conversation, not the page just sliced — otherwise it is a different number per caller");
assert(
  ((await (await fetch(`${base}/api/inbox?sent=1`, { headers: ORIGIN })).json()) as { unread?: number }).unread === 2,
  "`sent=1` widens the messages but not the count — your own sends are never unread",
);

const before = Date.now();
const traceBody = (await (await fetch(`${base}/api/trace/dev-web`, { headers: ORIGIN })).json()) as { name?: string; blocks?: unknown[]; readAt?: number };
assert(traceBody.name === "dev-web" && Array.isArray(traceBody.blocks), "GET /api/trace/<name> names the agent it walked and carries blocks");
// A trace is a SNAPSHOT and the socket pushes only `message` and `status`, so the pane ages silently
// while the agent keeps working. A stale pane that LOOKS live is worse than no pane — the reader trusts
// it. `readAt` is what lets the client say "as of 19:44" instead of implying "now".
assert(typeof traceBody.readAt === "number" && Number.isFinite(traceBody.readAt), "the trace payload stamps `readAt`, so a snapshot cannot pass itself off as live");
assert((traceBody.readAt ?? 0) >= before && (traceBody.readAt ?? 0) <= Date.now(), "`readAt` is when THIS read happened, not a cached or fabricated time");
// Blocks carry SOURCE, not presentation — the contract check:transcript defends. A browser renders the
// markdown itself; ANSI on the wire means somebody rendered for a terminal on the way out.
assert(!JSON.stringify(traceBody).includes(ESC), "no ANSI escape reaches the trace payload");
const unknownTrace = await fetch(`${base}/api/trace/nobody`, { headers: ORIGIN });
assert(unknownTrace.status === 404, "a trace for an unknown agent fails loud");
assert(
  String(((await unknownTrace.json()) as { error?: string }).error ?? "").includes("nobody"),
  "the underlying message reaches the client verbatim — never an empty block list, which reads as a quiet agent",
);
assert((await fetch(`${base}/api/trace/dev-web?tail=0`, { headers: ORIGIN })).status === 400, "a nonsense tail fails loud");
assert((await fetch(`${base}/api/nope`, { headers: ORIGIN })).status === 404, "an unknown /api/ path 404s rather than falling through to the client shell");

const dmRes = await fetch(`${base}/api/dm`, {
  method: "POST",
  headers: { ...ORIGIN, "content-type": "application/json" },
  body: JSON.stringify({ to: "dev-web", text: "ship it" }),
});
assert(dmRes.status === 200, "POST /api/dm answers 200");
assert(((await dmRes.json()) as { name?: string }).name === "dev-web", "the response carries the RESOLVED agent name, so a folder path shows what it landed on");
assert(sent.length === 1 && sent[0].to === "dev-web" && sent[0].text === "ship it", "the DM reaches the send path verbatim");
assert((await fetch(`${base}/api/dm`, { headers: ORIGIN })).status === 405, "GET /api/dm is refused — a send is not something a link can do");

for (const [label, body] of [
  ["no recipient", { text: "ship it" }],
  ["no text", { to: "dev-web" }],
  ["an empty recipient", { to: "", text: "ship it" }],
  ["whitespace for a recipient", { to: "   ", text: "ship it" }],
  ["whitespace for a message", { to: "dev-web", text: "   " }],
  ["a non-string recipient", { to: 42, text: "ship it" }],
] as const) {
  const r = await fetch(`${base}/api/dm`, { method: "POST", headers: { ...ORIGIN, "content-type": "application/json" }, body: JSON.stringify(body) });
  assert(r.status === 400, `POST /api/dm with ${label} fails loud`);
}
assert(
  (await fetch(`${base}/api/dm`, { method: "POST", headers: { ...ORIGIN, "content-type": "application/json" }, body: "not json" })).status === 400,
  "POST /api/dm with a body that isn't JSON fails loud",
);
assert(sent.length === 1, "every rejected DM sent nothing — no fabricated recipient, no empty message");

/* ── marking mail read ────────────────────────────────────────────────────────────────────────────
 * The half that makes `unread` a signal rather than a number that only goes up. The browser DISPLAYS
 * without consuming, so it needs the same explicit verb `paw inbox --mark-read` already has; without it
 * the badge counts up and never down, and you clear it by opening a terminal.
 */
const markRead = (body: string): Promise<Response> =>
  fetch(`${base}/api/read`, { method: "POST", headers: { ...ORIGIN, "content-type": "application/json" }, body });

assert((await fetch(`${base}/api/read`, { headers: ORIGIN })).status === 405, "GET /api/read is refused — marking mail read is not something a link can do");
assert((await markRead("not json")).status === 400, "POST /api/read with a body that isn't JSON fails loud");

// Rejected, never coerced: advanceCursor silently no-ops on a non-number, so a bad `ts` would leave the
// badge stuck with no error anywhere — the exact failure this endpoint exists to fix.
for (const [label, body] of [
  ["no ts at all", "{}"],
  ["a null ts", '{"ts":null}'],
  ["a string ts", '{"ts":"200"}'],
  ["an infinite ts", '{"ts":1e999}'],
  ["a boolean ts", '{"ts":true}'],
] as const) {
  assert((await markRead(body)).status === 400, `POST /api/read with ${label} fails loud rather than coercing`);
}
assert(
  ((await (await fetch(`${base}/api/inbox`, { headers: ORIGIN })).json()) as { cursor?: number }).cursor === 0,
  "every rejected mark left the cursor exactly where it was",
);

// A `ts` ahead of anything paw knows about is the client marking to its WALL CLOCK, which would swallow
// a message that arrived between the render and the request. A legitimate caller cannot trip this: every
// ts it could have displayed came from this server.
const ahead = await markRead(JSON.stringify({ ts: Date.now() }));
assert(ahead.status === 400, "a ts ahead of the newest message paw knows about is refused — mark to what you DISPLAYED, not the clock");
assert(String(((await ahead.json()) as { error?: string }).error ?? "").includes("DISPLAYED"), "the refusal says what to send instead, rather than only that it was wrong");

const marked = await markRead(JSON.stringify({ ts: 200 }));
assert(marked.status === 200, "POST /api/read with the ts of a displayed message answers 200");
assert(((await marked.json()) as { cursor?: number }).cursor === 200, "it returns the RESULTING cursor, so the client re-syncs instead of trusting its own write");
const afterMark = (await (await fetch(`${base}/api/inbox`, { headers: ORIGIN })).json()) as { cursor?: number; unread?: number };
assert(afterMark.cursor === 200 && afterMark.unread === 1, "the badge actually goes DOWN — the whole point of the endpoint");

// FORWARD-ONLY. Two tabs racing must not un-read anything, so a lower ts is a no-op that still reports
// the truth rather than an error: the client asked to mark less than someone already had.
const rewind = await markRead(JSON.stringify({ ts: 100 }));
assert(rewind.status === 200, "marking to an OLDER ts is not an error — another surface simply got there first");
assert(((await rewind.json()) as { cursor?: number }).cursor === 200, "…and the cursor does not rewind, so a racing tab cannot un-read your mail");
assert(
  ((await (await fetch(`${base}/api/inbox`, { headers: ORIGIN })).json()) as { unread?: number }).unread === 1,
  "the count is unchanged after the attempted rewind",
);

assert(((await markRead(JSON.stringify({ ts: 400 }))).status) === 200, "marking to the newest message is allowed");
assert(
  ((await (await fetch(`${base}/api/inbox`, { headers: ORIGIN })).json()) as { unread?: number }).unread === 0,
  "reading everything leaves nothing unread",
);

// State-mutating and unauthenticated, so the Origin check is the only thing standing in front of it.
const evilRead = await fetch(`${base}/api/read`, {
  method: "POST",
  headers: { Origin: "http://evil.example", "content-type": "application/json" },
  body: JSON.stringify({ ts: 100 }),
});
assert(evilRead.status === 403, "POST /api/read from an unknown Origin is refused — a page must not be able to clear your unread mail");

/* ── the client bundle, over the socket ───────────────────────────────────────────────────────── */

const shell = await fetch(`${base}/`, { headers: ORIGIN });
assert(shell.status === 200 && (shell.headers.get("content-type") ?? "").startsWith("text/html"), "/ serves the client shell as html");
const asset = await fetch(`${base}/assets/app.js`, { headers: ORIGIN });
assert(asset.status === 200 && (asset.headers.get("content-type") ?? "").includes("javascript"), "a bundle asset is served with a javascript content-type");
assert((await fetch(`${base}/some/client/route`, { headers: ORIGIN })).status === 200, "an extensionless unknown path falls back to the shell — the client owns its routing");
assert((await fetch(`${base}/assets/missing.js`, { headers: ORIGIN })).status === 404, "a MISSING asset 404s instead of answering html that then fails to parse as JS");

/* ── Origin and Host, on the actual socket ────────────────────────────────────────────────────── */

const evil = { Origin: "http://evil.example" };
for (const [label, res] of [
  ["GET /api/status", await fetch(`${base}/api/status`, { headers: evil })],
  ["GET /api/inbox", await fetch(`${base}/api/inbox`, { headers: evil })],
  ["GET /api/trace", await fetch(`${base}/api/trace/dev-web`, { headers: evil })],
  ["GET /", await fetch(`${base}/`, { headers: evil })],
  [
    "POST /api/dm",
    await fetch(`${base}/api/dm`, {
      method: "POST",
      headers: { ...evil, "content-type": "application/json" },
      body: JSON.stringify({ to: "dev-web", text: "leak" }),
    }),
  ],
] as const) {
  assert(res.status === 403, `${label} from an unknown Origin is refused with 403`);
}
assert(sent.length === 1, "a DM from an unknown Origin never reaches the send path");
// A matching Origin, so ONLY the Host check can catch this one.
assert(
  (await fetch(`${base}/api/inbox`, { headers: { Host: `paw.evil.example:${port}`, Origin: `http://paw.evil.example:${port}` } })).status === 403,
  "a DNS-rebinding Host is refused even when its Origin agrees with itself",
);

/* ── the websocket handshake ──────────────────────────────────────────────────────────────────── */

const upgrade = (headers: Record<string, string>, path = "/ws"): Promise<number> =>
  new Promise((resolve, reject) => {
    const req = request({
      host: "127.0.0.1",
      port,
      path,
      headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", ...headers },
    });
    req.on("upgrade", (res, socket) => {
      socket.destroy();
      resolve(res.statusCode ?? 101);
    });
    req.on("response", (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
assert((await upgrade({ Origin: "http://evil.example" })) !== 101, "a WS upgrade from an unknown Origin is refused — CORS does not cover this");
assert((await upgrade({ Origin: base, Host: `paw.evil.example:${port}` })) !== 101, "a WS upgrade on a rebinding Host is refused");
assert((await upgrade({ Origin: base }, "/socket")) !== 101, "a WS upgrade on any path but /ws is refused");
assert((await upgrade({ Origin: base })) === 101, "a WS upgrade from the daemon's own origin succeeds");

/* ── the framing, which is hand-rolled ────────────────────────────────────────────────────────────
 * The failure that matters is not a REJECTED frame, it is a MISPARSED one: read a length at the wrong
 * width and the parser consumes the wrong number of bytes, after which every later frame is garbage and
 * the feed dies without ever erroring. So each case below sends something awkward and then sends a PING
 * — a pong coming back is the proof the stream is still aligned. That is the assertion; the awkward
 * frame is only the setup.
 */

/** A masked client frame, as a browser always sends (RFC 6455 §5.3). */
const clientFrame = (opcode: number, payload: Buffer, fin = true): Buffer => {
  const mask = Buffer.from([0x37, 0xfa, 0x21, 0x3d]);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
  let header: Buffer;
  if (payload.length < 126) header = Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | payload.length]);
  else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = (fin ? 0x80 : 0) | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = (fin ? 0x80 : 0) | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, mask, masked]);
};

/** Parse whole UNMASKED server frames (§5.1 — a server must never mask). Deliberately a second, separate
 *  implementation: checking the server's encoder with the server's own decoder would agree with itself. */
const parseServerFrames = (buf: Buffer): { frames: Array<{ opcode: number; payload: Buffer }>; rest: Buffer } => {
  const frames: Array<{ opcode: number; payload: Buffer }> = [];
  let b = buf;
  for (;;) {
    if (b.length < 2) break;
    const opcode = b[0] & 0x0f;
    let len = b[1] & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (b.length < 4) break;
      len = b.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (b.length < 10) break;
      len = Number(b.readBigUInt64BE(2));
      offset = 10;
    }
    if (b.length < offset + len) break;
    frames.push({ opcode, payload: Buffer.from(b.subarray(offset, offset + len)) });
    b = b.subarray(offset + len);
  }
  return { frames, rest: b };
};

interface RawWs {
  socket: Socket;
  frames: Array<{ opcode: number; payload: Buffer }>;
  closed: boolean;
}
const rawWs = async (): Promise<RawWs> => {
  const socket = connect(port, "127.0.0.1");
  await new Promise<void>((r, j) => {
    socket.once("connect", () => r());
    socket.once("error", j);
  });
  socket.write(
    `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: ${base}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n` +
      `Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`,
  );
  const ws: RawWs = { socket, frames: [], closed: false };
  let buf: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let handshaken = false;
  socket.on("data", (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    if (!handshaken) {
      const end = buf.indexOf("\r\n\r\n");
      if (end === -1) return;
      handshaken = true;
      buf = buf.subarray(end + 4);
    }
    const { frames, rest } = parseServerFrames(buf);
    ws.frames.push(...frames);
    buf = rest;
  });
  socket.on("error", () => void (ws.closed = true));
  socket.on("close", () => void (ws.closed = true));
  await new Promise((r) => setTimeout(r, 80)); // let the 101 land
  return ws;
};
const settle = (ms = 140): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Send the awkward thing, then a ping. A pong proves the parser is still aligned. */
const stillAligned = async (ws: RawWs, label: string, ...setup: Buffer[]): Promise<void> => {
  ws.frames.length = 0;
  for (const b of setup) ws.socket.write(b);
  ws.socket.write(clientFrame(0x9, Buffer.from(label)));
  await settle();
  const pong = ws.frames.find((f) => f.opcode === 0xa);
  assert(pong !== undefined && pong.payload.toString() === label, `the parser stays aligned after ${label}`);
};

{
  const ws = await rawWs();
  await stillAligned(ws, "a ping"); // the baseline: does ping/pong work at all
  await stillAligned(ws, "a small masked text frame", clientFrame(0x1, Buffer.from("hello")));
  // 126 is the length-encoding boundary: <126 is inline, 126 means "read 16 more bits". Off by one and
  // the parser eats two payload bytes as a length.
  await stillAligned(ws, "a 125-byte frame", clientFrame(0x1, Buffer.alloc(125, 0x61)));
  await stillAligned(ws, "a 126-byte frame", clientFrame(0x1, Buffer.alloc(126, 0x61)));
  await stillAligned(ws, "a 127-byte frame", clientFrame(0x1, Buffer.alloc(127, 0x61)));
  await stillAligned(ws, "a 65535-byte frame", clientFrame(0x1, Buffer.alloc(65535, 0x61)));
  await stillAligned(ws, "a 65536-byte frame (the 64-bit path)", clientFrame(0x1, Buffer.alloc(65536, 0x61)));
  // A fragmented message: FIN=0 opcode=text, then FIN=1 opcode=continuation. Neither carries anything
  // this API consumes, but both must still be CONSUMED or the remainder is read as a frame header.
  await stillAligned(ws, "a fragmented message", clientFrame(0x1, Buffer.from("he"), false), clientFrame(0x0, Buffer.from("llo"), true));
  await stillAligned(ws, "an unmasked client frame", Buffer.concat([Buffer.from([0x81, 0x05]), Buffer.from("plain")]));
  await stillAligned(ws, "two frames in one write", Buffer.concat([clientFrame(0x1, Buffer.from("a")), clientFrame(0x1, Buffer.from("b"))]));
  await stillAligned(ws, "a ping carrying a body", clientFrame(0x9, Buffer.from("keepalive")).subarray(0, 0), clientFrame(0x1, Buffer.from("x")));

  // TCP is a byte stream: a frame arrives in as many pieces as the network feels like, including splits
  // inside the 2-byte header and inside the 4-byte mask. Anything assuming one read is one frame breaks
  // here and nowhere else.
  const whole = clientFrame(0x1, Buffer.alloc(300, 0x62));
  ws.frames.length = 0;
  for (const cut of [1, 3, 8]) {
    ws.socket.write(whole.subarray(0, cut));
    await settle(20);
    ws.socket.write(whole.subarray(cut));
    await settle(20);
  }
  ws.socket.write(clientFrame(0x9, Buffer.from("split reads")));
  await settle();
  assert(ws.frames.find((f) => f.opcode === 0xa)?.payload.toString() === "split reads", "a frame split mid-header, mid-mask and mid-payload is reassembled");

  // Server→client encoding, across all three length paths.
  for (const size of [10, 200, 70_000]) {
    ws.frames.length = 0;
    server.broadcast({ type: "message", entry: { from: "dev-web", text: "x".repeat(size), ts: 600 } });
    await settle(size > 1000 ? 300 : 140);
    const got = ws.frames.filter((f) => f.opcode === 0x1).map((f) => JSON.parse(f.payload.toString()) as { type: string; entry?: { text?: string } });
    assert(got.length === 1 && got[0].entry?.text?.length === size, `a ${size}-byte payload is framed and arrives whole`);
    assert(got[0]?.type === "message", `a ${size}-byte payload keeps its type tag`);
  }

  // A client announcing more than the server would ever buffer is not a client it serves.
  const huge = Buffer.alloc(10);
  huge[0] = 0x81;
  huge[1] = 0x80 | 127;
  huge.writeBigUInt64BE(BigInt(2) ** BigInt(40), 2);
  ws.socket.write(huge);
  await settle();
  assert(ws.closed || ws.socket.destroyed, "a client announcing an absurd frame length is dropped rather than buffered");
}

// The close handshake: a close from the client is answered with a close, and the socket ends.
{
  const ws = await rawWs();
  ws.frames.length = 0;
  ws.socket.write(clientFrame(0x8, Buffer.alloc(0)));
  await settle();
  assert(ws.frames.some((f) => f.opcode === 0x8), "a client close is answered with a close frame");
  assert(ws.closed, "the socket is ended after the close handshake, not left half-open");
}

// A socket that has gone away must not take the broadcast down with it. This is the one that turns a
// closed laptop lid into a dead feed for every other tab.
{
  const dead = await rawWs();
  const alive = await rawWs();
  dead.socket.destroy();
  await settle();
  alive.frames.length = 0;
  server.broadcast({ type: "status", rows: [], errors: [] });
  await settle();
  assert(alive.frames.some((f) => f.opcode === 0x1), "a broadcast still reaches a live socket after another has died");

  // The last status is replayed to a socket the moment it connects, so a freshly-opened tab renders
  // populated rather than blank until the next tick.
  const fresh = await rawWs();
  await settle();
  const seeded = fresh.frames.filter((f) => f.opcode === 0x1).map((f) => JSON.parse(f.payload.toString()) as { type?: string });
  assert(seeded.some((f) => f.type === "status"), "a newly-connected socket is seeded with the last status");
  // A MESSAGE is not replayed: the authoritative history is /api/inbox, and a replayed message would
  // arrive a second time in a transcript the client already fetched.
  assert(!seeded.some((f) => f.type === "message"), "an old message is NOT replayed on connect — /api/inbox is the history");
  fresh.socket.destroy();
  alive.socket.destroy();
}

// ── optimistic-send reconciliation (web/app/pending.js) ──────────────────────────────────────────
// A pending row that is never retired sits under the real message forever — a duplicate no reload
// clears. The two destinations echo in different shapes, and the channel one was never matched
// (reported live 2026-08-06: every channel post rendered twice, plus a stuck "sending…").
{
  // The client is build-free vanilla JS; `pending.d.ts` states its shape so this suite can import it
  // without loosening the compiler for the project.
  const { isEchoed, survivingPending } = await import("../web/app/pending.js");

  // Exactly the shapes the handlers above return — a DM entry is directed, a channel entry is not.
  const dmEcho = { from: "agent", to: "agent", text: "hi", ts: 1, dir: "out" };
  const chEcho = { from: "you", channel: "team2027", text: "/invite @queue", ts: 2 };

  const dmPending = { to: "agent", text: "hi", state: "sending" };
  const chPending = { to: "#team2027", text: "/invite @queue", state: "sending" };

  assert(isEchoed(dmPending, [dmEcho], []), "pending: a DM is retired once the server echoes it");
  assert(isEchoed(chPending, [], [chEcho]), "pending: a CHANNEL post is retired once the server echoes it (the duplicate bug)");
  // The old predicate's exact failure, asserted so it cannot silently return.
  assert(!isEchoed(chPending, [chEcho], []), "pending: a channel echo in the DM array does NOT count (wrong array)");
  assert(!isEchoed({ to: "#team2027", text: "different", state: "sending" }, [], [chEcho]), "pending: a DIFFERENT text in the same channel is not an echo");
  assert(!isEchoed({ to: "#other", text: "/invite @queue", state: "sending" }, [], [chEcho]), "pending: the same text in ANOTHER channel is not an echo");
  // An agent's own post must never retire the operator's pending row — only `from: "you"` counts.
  assert(!isEchoed(chPending, [], [{ from: "evals", channel: "team2027", text: "/invite @queue", ts: 3 }]), "pending: an AGENT's identical post is not our echo");
  assert(!isEchoed(dmPending, [{ ...dmEcho, dir: undefined }], []), "pending: an inbound DM with the same text is not our echo");

  assert(survivingPending([chPending], [], [chEcho]).length === 0, "pending: an echoed channel row is dropped");
  assert(survivingPending([chPending], [], []).length === 1, "pending: an un-echoed row stays (still in flight)");
  assert(
    survivingPending([{ ...chPending, state: "failed" }], [], [chEcho]).length === 1,
    "pending: a FAILED row survives its own echo — it is the only handle to retry",
  );
}

// ── /invite ──────────────────────────────────────────────────────────────────────────────────────
// An invite is a REQUEST (cotal has no "add someone else to a channel" — an agent joins itself), so
// what these assert is that paw asks each agent, records only what it actually managed to ask, and
// never swallows a line that merely looks like a command.
{
  const { parseInvite } = await import("../web/app/commands.js");

  assert(parseInvite("/invite @queue")?.names.join() === "queue", "invite: parses a single @name");
  assert(parseInvite("/invite @a @b, c")?.names.join() === "a,b,c", "invite: parses several names, @ and commas optional");
  assert(parseInvite("  /INVITE @Queue  ")?.names.join() === "Queue", "invite: case-insensitive and space-tolerant");
  assert(parseInvite("/invite")?.names.length === 0, "invite: a bare /invite is RECOGNISED with no names (reported as usage, not posted)");
  assert(parseInvite("use /invite to add someone") === undefined, "invite: a mention mid-sentence is an ordinary message");
  assert(parseInvite("/invitation open") === undefined, "invite: a word merely STARTING with /invite is not the command");
  assert(parseInvite("hello") === undefined, "invite: ordinary text is not a command");
  const messy = parseInvite("/invite @bad name!");
  assert(messy?.names.join() === "bad", "invite: keeps only tokens that can actually name an agent");
  assert(messy?.invalid.join() === "name!", "invite: an unusable token is REPORTED, not silently dropped");

  assert(
    inviteText("team2027").includes('cotal_join("team2027")'),
    "invite: the DM names the exact call the agent must make",
  );

  // The endpoint. `dm` is stubbed by the harness, so this asserts paw's OWN behaviour: who gets asked,
  // what the channel is told, and what happens when one agent can't be reached.
  const inv = await fetch(`${base}/api/invite`, {
    method: "POST",
    headers: { ...ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ channel: "team2027", names: ["alpha", "boom", "beta"] }),
  });
  const invBody = (await inv.json()) as { invited?: string[]; failed?: { name: string; error: string }[] };
  assert(inv.status === 200, "invite: a partly-failing invite is still a 200 with a per-name result");
  assert(invBody.invited?.join() === "alpha,beta", "invite: the reachable agents are reported as invited");
  assert(invBody.failed?.length === 1 && invBody.failed[0].name === "boom", "invite: an unreachable agent is reported, and does NOT abort the rest");
  assert(
    posted.some((p) => p.channel === "team2027" && p.text === "invited @alpha, @beta to this channel"),
    "invite: the channel records only the agents actually reached",
  );
  assert(
    !posted.some((p) => p.text.includes("@boom")),
    "invite: an agent we could not DM is never announced as invited",
  );
  assert(sent.filter((d) => d.text.includes("cotal_join")).length === 3, "invite: every named agent is asked (including the one that failed)");

  const bad = await fetch(`${base}/api/invite`, {
    method: "POST",
    headers: { ...ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ channel: "team2027", names: [] }),
  });
  assert(bad.status === 400, "invite: an empty name list is a 400, not a silent no-op");
  const badCh = await fetch(`${base}/api/invite`, {
    method: "POST",
    headers: { ...ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ channel: "../etc", names: ["a"] }),
  });
  assert(badCh.status === 400, "invite: a malformed channel name is rejected");
  assert((await fetch(`${base}/api/invite`, { headers: ORIGIN })).status === 405, "invite: GET is 405 — an invite is not something a link can do");
}

// ── conversation order, stepping, and draft scoping (web/app/conversation.js) ────────────────────
{
  const { orderTargets, stepTarget, draftKey } = await import("../web/app/conversation.js");

  const rows = [{ name: "queue", folder: "/Users/x/queue" }, { name: "evals", folder: "/Users/x/evals" }];
  const channels = ["general", "team2027"];
  const all = orderTargets({ channels, rows });
  assert(all[0] === null, "nav: Activity leads, because it is the row that leads");
  assert(all.join("|") === "|#general|#team2027|queue|evals", "nav: channels then agents, in the order the sidebar renders them");
  // The keyboard order MUST honour the filter, or the selection appears to jump to invisible rows.
  assert(orderTargets({ channels, rows, filter: "team" }).join("|") === "|#team2027", "nav: the sidebar filter applies to the keyboard order too");
  assert(orderTargets({ channels, rows, filter: "/Users/x/queue" }).join("|") === "|queue", "nav: an agent matches on FOLDER as well as name, as the sidebar does");
  assert(orderTargets().length === 1, "nav: with nothing loaded there is still Activity to sit on");

  assert(stepTarget(all, null, 1) === "#general", "step: down from Activity reaches the first channel");
  assert(stepTarget(all, "#general", -1) === null, "step: up returns to Activity");
  assert(stepTarget(all, "#team2027", 1) === "queue", "step: down crosses from channels into agents");
  // Clamped, not wrapped — in a 40-agent list a wrap is indistinguishable from a random jump.
  assert(stepTarget(all, null, -1) === null, "step: up from the top STAYS (clamped, never wraps)");
  assert(stepTarget(all, "evals", 1) === "evals", "step: down from the last row STAYS (clamped, never wraps)");
  // A focus filtered out from under you must not make the keypress a silent no-op.
  assert(stepTarget(orderTargets({ channels, rows, filter: "team" }), "queue", 1) === null, "step: a focus no longer in the list starts from the top");
  assert(stepTarget([], "queue", 1) === "queue", "step: an empty list leaves the focus alone");

  // The "new messages" divider: where the reader left off, frozen when the conversation is opened.
  const { firstUnreadTs } = await import("../web/app/conversation.js");
  const convo2 = [
    { ts: 100, dir: "in" },
    { ts: 200, dir: "out" },
    { ts: 300, dir: "in" },
    { ts: 400, dir: "in" },
  ];
  assert(firstUnreadTs(convo2, 250) === 300, "divider: sits at the first message newer than the cursor");
  assert(firstUnreadTs(convo2, 50) === 100, "divider: with everything unread it sits at the very first message");
  assert(firstUnreadTs(convo2, 400) === undefined, "divider: nothing newer than the cursor means NO divider");
  assert(firstUnreadTs(convo2, 300) === 400, "divider: the boundary is strictly newer — a message AT the cursor is read");
  // Your own sends are not something you need telling to read, and would put the line above your words.
  assert(firstUnreadTs([{ ts: 500, dir: "out" }], 100) === undefined, "divider: an outgoing message never opens the unread run");
  assert(firstUnreadTs([{ ts: 500, dir: "out" }, { ts: 600, dir: "in" }], 100) === 600, "divider: skips your send and marks the reply");
  // Out-of-order input must still yield the EARLIEST unread, or the line lands mid-run.
  assert(firstUnreadTs([{ ts: 900, dir: "in" }, { ts: 700, dir: "in" }], 500) === 700, "divider: takes the earliest unread, not the first seen");
  assert(firstUnreadTs(convo2, undefined) === undefined, "divider: no cursor yet ⇒ no divider (never guessed)");
  assert(firstUnreadTs([], 100) === undefined, "divider: an empty conversation has no divider");

  // ── the per-message read overlay ───────────────────────────────────────────────────────────────
  // The bug this fixes: reading a focused chat cleared nothing, because the shared cursor is ONE
  // timestamp for the whole inbox and advancing it from inside one conversation buries every other
  // agent's older mail. So the badge and the divider stayed on forever (reported 2026-08-07).
  {
    const { messageKey, isUnread, safeCursor } = await import("../web/app/read-state.js");
    const A = { ts: 300, from: "evals", text: "hi", dir: "in" };
    const B = { ts: 200, from: "queue", text: "older", dir: "in" };
    const mine = { ts: 400, from: "you", text: "mine", dir: "out" };

    assert(isUnread(A, 100, new Set()), "read: newer than the cursor and unmarked ⇒ unread");
    assert(!isUnread(A, 100, new Set([messageKey(A)])), "read: marking THIS message clears it, without touching the cursor");
    assert(!isUnread(A, 300, new Set()), "read: at or before the cursor is read");
    assert(!isUnread(mine, 100, new Set()), "read: your own send is never unread");
    // The whole point: clearing one conversation must not clear another's older mail.
    assert(isUnread(B, 100, new Set([messageKey(A)])), "read: reading evals leaves queue's OLDER message unread — the bug in one line");
    assert(messageKey(A) !== messageKey({ ...A, from: "queue" }), "read: identity includes the sender");
    assert(messageKey(A) !== messageKey({ ...A, ts: 301 }), "read: identity includes the timestamp");

    // The shared cursor still moves, but only as far as is provably safe.
    assert(safeCursor([A, B], 100, new Set([messageKey(A)])) === 199, "cursor: advances only to just before the OLDEST still-unread message");
    assert(safeCursor([A, B], 100, new Set([messageKey(A), messageKey(B)])) === 300, "cursor: everything read ⇒ advances to the newest");
    // Even with nothing read here, moving up to just before the oldest unread buries nothing — the
    // cursor is allowed to close a gap, it is only forbidden to pass something unread.
    assert(safeCursor([A, B], 100, new Set()) === 199, "cursor: closes the gap up to the oldest unread, burying nothing");
    assert(safeCursor([A, B], 199, new Set()) === undefined, "cursor: already just before the oldest unread ⇒ no move");
    assert(safeCursor([], 100, new Set()) === undefined, "cursor: nothing past the cursor ⇒ no advance");
    assert(safeCursor([mine], 100, new Set()) === undefined, "cursor: your own sends never move the cursor");

    // The divider obeys the same rule, or it re-opens over mail already read here.
    const conv = [B, A];
    assert(firstUnreadTs(conv, 100) === 200, "divider: without the overlay it marks the oldest unread");
    assert(firstUnreadTs(conv, 100, new Set([messageKey(B)])) === 300, "divider: a locally-read message no longer opens the line");
    assert(firstUnreadTs(conv, 100, new Set([messageKey(A), messageKey(B)])) === undefined, "divider: all read here ⇒ NO divider, even with the cursor held back");
  }

  // Where the divider lands: the line should divide two things you can SEE.
  const { markScrollTop } = await import("../web/app/conversation.js");
  assert(markScrollTop({ markTop: 1000, prevTop: 940 }) === 940, "scroll: a short previous message is shown in FULL above the line");
  // A 40-line reply is normal here; without the clamp the divider is pushed off the bottom, so you
  // scroll to a marker you then cannot see.
  assert(markScrollTop({ markTop: 1000, prevTop: 200 }) === 904, "scroll: a LONG previous message is clamped to the headroom");
  assert(markScrollTop({ markTop: 1000, prevTop: 200, maxHeadroom: 300 }) === 700, "scroll: the headroom is configurable");
  assert(markScrollTop({ markTop: 40 }) === 40, "scroll: no previous message ⇒ no headroom to leave");
  assert(markScrollTop({ markTop: 30, prevTop: 0 }) === 0, "scroll: near the top it lands at the top, never past it");
  assert(markScrollTop({ markTop: 10, prevTop: 500 }) === 10, "scroll: an out-of-order prev never yields a NEGATIVE headroom");
  assert(markScrollTop({ markTop: 0, prevTop: null }) === 0, "scroll: never negative");

  // ── where a jumped-to message lands (jumpScrollTop) ────────────────────────────────────────────
  {
    const { jumpScrollTop } = await import("../web/app/conversation.js");
    // The reported bug: an agent message TALLER than the viewport. Centring starts it off-screen, which
    // reads as the header cutting the text off.
    const tall = jumpScrollTop({ rowTop: 5000, rowHeight: 1200, viewport: 680 });
    assert(tall === 5000 - 12, "jump: a message taller than the viewport starts at its FIRST line, not centred off-screen");
    assert(tall < 5000, "jump: …with a small margin, never flush against the edge");
    // A short message can afford to show what came before it.
    const short = jumpScrollTop({ rowTop: 5000, rowHeight: 60, viewport: 680 });
    assert(short === 5000 - 96, "jump: a SHORT message gets headroom, so you see the message before it");
    // Between the two clamps the headroom tracks the space actually spare: viewport 680 − row 500 = 180,
    // a third of which is 60 — less than the 96 cap, so this is the region where it scales.
    assert(jumpScrollTop({ rowTop: 5000, rowHeight: 500, viewport: 680 }) === 4940, "jump: headroom scales with the space actually spare");
    assert(jumpScrollTop({ rowTop: 5000, rowHeight: 300, viewport: 680 }) === 4904, "jump: …but is CAPPED, so a short message never lands halfway down the screen");
    assert(jumpScrollTop({ rowTop: 10, rowHeight: 60, viewport: 680 }) === 0, "jump: near the top it lands at the top, never negative");
    assert(jumpScrollTop({ rowTop: 500 }) === 488, "jump: with no measurements it still falls back to a margin, not a crash");
  }

  // ── source-faithful newlines in the trace (md({gaps:true})) ────────────────────────────────────
  {
    const { md } = await import("../web/app/md.js");
    // The operator's actual message: paragraphs separated by a blank line, and a fenced block written
    // FLUSH against the line above it. Claude Code reproduces both; paw applied uniform margins.
    const src = ["one.", "", "**two:**", "", "three:", "```", "code", "```", "four.", "", "five."].join("\n");
    const withGaps = md(src, { gaps: true });
    const plain = md(src);

    assert(!plain.includes("mdgap"), "newlines: the CHAT keeps its uniform margins — gaps are opt-in");
    assert((withGaps.match(/mdgap/g) || []).length === 3, "newlines: one gap per BLANK line in the source, no more");
    // The load-bearing half: no blank line in the source ⇒ no gap on screen.
    const flush = withGaps.slice(withGaps.indexOf("three:"));
    assert(!flush.slice(0, flush.indexOf("<pre>")).includes("mdgap"), "newlines: a fence written FLUSH against the paragraph stays flush");
    assert(!withGaps.slice(withGaps.indexOf("</pre>"), withGaps.indexOf("four.")).includes("mdgap"), "newlines: …and the line after it stays flush too");
    assert(withGaps.includes("<p>four.</p>"), "newlines: content is unchanged — this is spacing, not a re-parse");
    assert(md("", { gaps: true }) === "", "newlines: empty in, empty out");
    assert(!md("only one line", { gaps: true }).includes("mdgap"), "newlines: no leading gap before the first block");
  }

  // ── quote reply (web/app/quote.js) ─────────────────────────────────────────────────────────────
  {
    const { quoteText, composeQuote, quotable } = await import("../web/app/quote.js");

    assert(quoteText("one line") === "> one line", "quote: a line is prefixed");
    assert(quoteText("a\nb") === "> a\n> b", "quote: every line is prefixed");
    // The one way this can misrepresent who said what: a bare blank line ENDS a markdown quote, so the
    // rest of the paragraph would render as though YOU wrote it.
    assert(quoteText("a\n\nb") === "> a\n>\n> b", "quote: a BLANK line is quoted too, or the block ends and the rest reads as yours");
    assert(quoteText("   indented") === ">    indented", "quote: leading indentation survives — in a code block it IS the meaning");
    assert(quoteText("trailing   \n\n") === "> trailing", "quote: trailing whitespace goes");
    assert(quoteText("   ") === "" && quoteText(undefined) === "", "quote: nothing to quote ⇒ nothing");
    assert(quoteText("a\r\nb") === "> a\n> b", "quote: CRLF normalises");

    assert(composeQuote("", "hi") === "> hi\n\n", "quote: lands with a blank line under it, so you write below");
    assert(composeQuote("my reply", "hi") === "> hi\n\nmy reply", "quote: an EXISTING draft is kept, below the quote — never destroyed");
    assert(composeQuote("keep me", "  ") === "keep me", "quote: an empty selection leaves the draft exactly as it was");

    assert(quotable({ text: "hello", insideMessage: true }), "quote: a real selection in a message is quotable");
    assert(!quotable({ text: "hello", insideMessage: false }), "quote: a selection OUTSIDE a message is not a quote");
    assert(!quotable({ text: "x", insideMessage: true }), "quote: a stray one-character selection doesn't pop a button at you");
    assert(!quotable({ text: "   ", insideMessage: true }), "quote: whitespace is not a selection");
  }

  // ── the PRs section (web/app/prs.js + git.ts rollup/parse) ─────────────────────────────────────
  {
    const { prGlyph, checkGlyph, diffLabel, shouldRefetch } = await import("../web/app/prs.js");
    const { rollupChecks, parsePr } = await import("../src/git.js");

    assert(prGlyph({ number: 1, url: "u" }).cls === "open", "pr: a plain PR is open");
    assert(prGlyph({ number: 1, url: "u", isDraft: true }).cls === "draft", "pr: a DRAFT is not 'open' — the point of draft is that it isn't ready");
    assert(prGlyph({ number: 1, url: "u", state: "MERGED", isDraft: true }).cls === "merged", "pr: merged wins over a stale draft flag");
    assert(prGlyph({ number: 1, url: "u", state: "CLOSED" }).cls === "closed", "pr: closed renders closed");

    assert(checkGlyph(undefined) === undefined, "pr: NO checks configured renders nothing — not a spinner that never resolves");
    assert(checkGlyph("fail")?.cls === "fail" && checkGlyph("pass")?.cls === "pass", "pr: check verdicts map to their own glyphs");

    assert(diffLabel({ number: 1, url: "u", additions: 12, deletions: 3 }) === "+12 −3", "pr: +/- renders");
    assert(diffLabel({ number: 1, url: "u", additions: 0, deletions: 0 }) === "+0 −0", "pr: ZERO is a real answer and shows");
    assert(diffLabel({ number: 1, url: "u" }) === "", "pr: UNKNOWN size shows nothing — '+0 −0' would state something false");

    // Rollup: any failure dominates, then pending; an unrecognised state is never called green.
    assert(rollupChecks([{ conclusion: "SUCCESS" }, { conclusion: "SUCCESS" }]) === "pass", "pr: all green ⇒ pass");
    assert(rollupChecks([{ conclusion: "SUCCESS" }, { conclusion: "FAILURE" }]) === "fail", "pr: one FAILURE dominates a wall of green");
    assert(rollupChecks([{ conclusion: "SUCCESS" }, { status: "IN_PROGRESS" }]) === "pending", "pr: something still running ⇒ pending");
    assert(rollupChecks([{ conclusion: "SUCCESS" }, { conclusion: "WHAT_IS_THIS" }]) === "pending", "pr: an UNKNOWN conclusion is pending, never claimed as pass");
    assert(rollupChecks([{ conclusion: "SKIPPED" }]) === "pass", "pr: skipped isn't a failure");
    assert(rollupChecks([]) === undefined && rollupChecks(undefined) === undefined, "pr: no checks at all ⇒ undefined, distinct from pending");

    // The parse is where GitHub's field names meet paw's.
    const parsed = parsePr(JSON.stringify({ number: 7, url: "https://x/7", title: "t", headRefName: "feat/x", additions: 5, deletions: 2, statusCheckRollup: [{ conclusion: "SUCCESS" }] }));
    assert(parsed?.branch === "feat/x" && parsed?.additions === 5 && parsed?.checks === "pass", "pr: parse maps headRefName→branch and rolls the checks up");
    assert(parsePr(JSON.stringify({ title: "no number" })) === undefined, "pr: a payload without number+url is NOT a PR");

    // Fetch pacing: never on the 2s poll, never while folded shut.
    assert(shouldRefetch({ now: 1000 }) === true, "pr: first ask always fetches");
    assert(shouldRefetch({ lastAt: 1000, now: 1000 + 2000 }) === false, "pr: the 2s message poll does NOT drag GitHub with it");
    assert(shouldRefetch({ lastAt: 1000, now: 1000 + 60_000 }) === true, "pr: refetches once the cache could have changed");
    assert(shouldRefetch({ folded: true, lastAt: undefined, now: 9e9 }) === false, "pr: folded shut ⇒ no network for a list nobody can see");
  }

  // ── archiving agents out of the sidebar (web/app/archive.js) ───────────────────────────────────
  {
    const { loadArchive, wokenSince, pruneArchive, partitionRoster } = await import("../web/app/archive.js");
    const rows = [{ name: "research" }, { name: "queue" }, { name: "canary" }];
    const archive = { queue: 1000, canary: 1000 };

    // The rule: archived STAYS archived until that agent says something.
    assert(wokenSince(archive, [{ from: "queue", ts: 900, dir: "in" }]).length === 0, "archive: an OLDER message doesn't wake an archived agent");
    assert(wokenSince(archive, [{ from: "queue", ts: 1500, dir: "in" }])[0] === "queue", "archive: a NEWER message brings it back");
    assert(wokenSince(archive, [{ from: "queue", ts: 1500, dir: "out" }]).length === 0, "archive: YOUR OWN send to an archived agent does NOT un-archive it");
    assert(wokenSince(archive, [{ from: "research", ts: 9999, dir: "in" }]).length === 0, "archive: a message from an UNARCHIVED agent changes nothing");

    const p1 = pruneArchive(archive, [{ from: "queue", ts: 1500, dir: "in" }]);
    assert(p1.changed && p1.archive.queue === undefined && p1.archive.canary === 1000, "archive: prune drops ONLY the woken agent");
    assert(pruneArchive(archive, []).changed === false, "archive: nothing woken ⇒ no write (this runs every 2s)");

    // Partition: what is hidden, and the two cases that must never hide.
    const a = partitionRoster(rows, archive);
    assert(a.visible.length === 1 && a.visible[0].name === "research", "archive: filed agents leave the list");
    assert(a.archived.length === 2, "archive: …and are counted, so nothing disappears silently");
    assert(partitionRoster(rows, archive, { focus: "queue" }).visible.some((r) => r.name === "queue"), "archive: the FOCUSED agent is never hidden from the list that navigates it");
    assert(partitionRoster(rows, archive, { filter: "can" }).visible.length === 3, "archive: a SEARCH overrides the archive — refusing to find what you typed is worse than an untidy list");
    assert(partitionRoster(rows, {}).archived.length === 0, "archive: empty archive hides nothing");

    // Storage is best-effort in ONE direction only.
    globalThis.localStorage = { getItem: () => "}{ not json", setItem() {}, removeItem() {} } as never;
    assert(Object.keys(loadArchive("paw")).length === 0, "archive: corrupt storage reads as EMPTY — a glitch must show too many agents, never hide one");
    globalThis.localStorage = { getItem: () => JSON.stringify({ a: "soon", b: 12 }), setItem() {}, removeItem() {} } as never;
    assert(loadArchive("paw").a === undefined && loadArchive("paw").b === 12, "archive: a non-numeric entry is dropped, not coerced");
  }

  // ── who an outgoing message went TO, in the Activity feed (recipientLabel) ──────────────────────
  {
    const { recipientLabel } = await import("../web/app/conversation.js");
    const roster = ["research", "queue", "paw-folder"];
    assert(recipientLabel("research", roster) === "research", "activity: a roster name renders as itself");
    assert(recipientLabel("canary-env-52", roster) === "canary-env-52", "activity: an OFFLINE agent still looks like a name and is kept whole");
    assert(recipientLabel("", roster) === "", "activity: no recipient ⇒ render nothing, never 'unknown'");
    assert(recipientLabel(undefined, roster) === "", "activity: an absent recipient is not a label");
    // The wire carries an id; paw resolves it to a name only if that id ever SENT. An unresolved id is
    // shortened so it can still be matched against `paw status` — never dressed up as a name.
    const id = "local.UB5BWUNBADLNHEY5T4AA62NLQCOED53FCWSLU7UFCCJN3ZHNJ7AXRELI";
    assert(recipientLabel(id, roster) === "UB5BWUNB…", "activity: an owner.actor id is shortened to its ACTOR, not faked into a name");
    assert(recipientLabel("f415f5d0063c44dcab9ab1b6c8dbab65", roster) === "f415f5d0…", "activity: a bare long id is shortened too");
    assert(recipientLabel("research") === "research", "activity: with no roster, a name-shaped token is still a name");
  }

  // Drafts are per (space, target): one composer, many conversations.
  assert(draftKey("paw", "queue") !== draftKey("paw", "evals"), "draft: two agents never share a draft — that is the bug being fixed");
  assert(draftKey("paw", "#general") !== draftKey("paw", "general"), "draft: a channel and a same-named agent are different conversations");
  assert(draftKey("paw", "queue") !== draftKey("other", "queue"), "draft: two SPACES sharing a browser origin never share a draft");
}

// ── `!cmd` — run in the agent's folder, then hand the agent the result ───────────────────────────
// This is arbitrary code execution reachable from a page. It is consistent with what `paw web` already
// exposes (POST /api/dm against agents that run bypassPermissions), not a new capability — and it
// inherits the same and only defences, asserted above: loopback, exact Origin, Host.
{
  const { parseBang, bashMessage, runBash, shellInvocation } = await import("../src/bash.js");

  // The `!` runner uses the OPERATOR'S shell so their rc (aliases, functions, PATH) loads — reported
  // live 2026-09-09: `!preview` "command not found" under a bare /bin/sh that sources nothing.
  assert(JSON.stringify(shellInvocation("preview", true, "/bin/zsh")) === JSON.stringify({ sh: "/bin/zsh", args: ["-ic", "preview"] }), "zsh runs -ic so .zshrc (aliases/functions) is sourced");
  assert(JSON.stringify(shellInvocation("preview", true, "/usr/local/bin/bash")) === JSON.stringify({ sh: "/usr/local/bin/bash", args: ["-ic", "preview"] }), "bash runs -ic too");
  assert(JSON.stringify(shellInvocation("preview", true, "")) === JSON.stringify({ sh: "/bin/sh", args: ["-c", "preview"] }), "no $SHELL (a stripped daemon) falls back to /bin/sh -c");
  assert(JSON.stringify(shellInvocation("preview", true, "/usr/bin/fish")) === JSON.stringify({ sh: "/bin/sh", args: ["-c", "preview"] }), "an unmodelled shell falls back to /bin/sh -c rather than guessing its rc flags");
  assert(JSON.stringify(shellInvocation("preview", false, "/bin/zsh")) === JSON.stringify({ sh: "/bin/sh", args: ["-c", "preview"] }), "a NON-interactive caller (web daemon, tests) stays on /bin/sh -c even with a zsh $SHELL — no rc hang");

  assert(parseBang("!pwd") === "pwd", "a leading ! is the command form");
  assert(parseBang("!  git log -5  ") === "git log -5", "the command is trimmed");
  assert(parseBang("!echo a | wc -l") === "echo a | wc -l", "pipes survive — a shell is the point");
  // Prose that merely contains a `!` must never run: the failure mode is executing something nobody typed.
  assert(parseBang("that's odd!") === undefined, "a ! mid-sentence is ordinary prose");
  assert(parseBang("!") === undefined, "a bare ! is not a command");
  assert(parseBang("!   ") === undefined, "whitespace after ! is not a command");
  assert(parseBang("hello") === undefined, "ordinary text is not a command");

  // MODE vs RUNNABLE are different questions, and conflating them was the bug: gating the UI on
  // `parseBang` meant a bare `!` typed into an empty box did NOT switch, so the first character of the
  // command was typed in the wrong mode — exactly when you want to know which mode you're in.
  const { isBangMode } = await import("../web/app/bash.js");
  assert(isBangMode("!"), "a bare ! switches the composer the instant it is typed");
  assert(isBangMode("!pwd") && isBangMode("! pwd"), "still in command mode once a command follows");
  assert(!isBangMode(""), "backspacing the ! flips straight back to a message");
  assert(!isBangMode("hello!"), "a ! that isn't leading is prose, in either question");
  assert(parseBang("!") === undefined && isBangMode("!"), "a bare ! is command MODE but not a command to RUN");

  // The message an agent receives: a terminal transcript, fenced so stray backticks can't reflow it.
  const msg = bashMessage({ command: "pwd", cwd: "/tmp/x", output: "/tmp/x\n", code: 0, timedOut: false });
  assert(msg.includes("$ pwd") && msg.includes("/tmp/x"), "the agent is told the command AND its output");
  assert(msg.includes("```console"), "output is fenced");
  assert(bashMessage({ command: "x", cwd: "/w", output: "", code: 3, timedOut: false }).includes("(exit 3)"), "a failing command reports its exit code");
  assert(bashMessage({ command: "x", cwd: "/w", output: "", code: null, timedOut: true }).includes("timed out"), "a killed command says so rather than looking empty");
  assert(bashMessage({ command: "x", cwd: "/w", output: "   ", code: 0, timedOut: false }).includes("(no output)"), "silence is stated, not rendered as an empty fence");

  // A real command, really run — the exit code and stderr are RESULTS, never exceptions.
  const ok = await runBash("echo hello", process.cwd());
  assert(ok.output.trim() === "hello" && ok.code === 0, "runBash captures stdout and a zero exit");
  const bad = await runBash("echo oops >&2; exit 7", process.cwd());
  assert(bad.code === 7 && bad.output.includes("oops"), "a failing command returns its code and stderr instead of throwing");
  const cwdRun = await runBash("pwd", tmpdir());
  assert(cwdRun.output.trim().endsWith(tmpdir().replace(/\/$/, "").split("/").pop() ?? ""), "it runs in the cwd it was given");
  // `code` is a NUMBER on exit and a STRING on spawn failure; reporting the raw value would render
  // "exit ETIMEDOUT".
  const killed = await runBash("sleep 5", process.cwd(), undefined, 150);
  assert(killed.timedOut === true && killed.code === null, "a timeout is flagged, and its code is null rather than a string");

  // The route: runs, then hands it to the agent. Both halves are reported.
  const ran = await fetch(`${base}/api/bash`, {
    method: "POST",
    headers: { ...ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ agent: "dev-web", command: "echo hi" }),
  });
  const body = (await ran.json()) as { output?: string; delivered?: boolean; code?: number };
  assert(ran.status === 200 && body.output?.trim() === "hi", "/api/bash returns what the command printed");
  assert(body.delivered === true, "the result was handed to the agent");
  assert(sent.some((d) => d.to === "dev-web" && d.text.includes("$ echo hi")), "the agent got the command AND the output as a message");
  assert((await fetch(`${base}/api/bash`, { headers: ORIGIN })).status === 405, "GET is 405 — running a command is not something a link can do");
  const noCmd = await fetch(`${base}/api/bash`, { method: "POST", headers: { ...ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ agent: "dev-web" }) });
  assert(noCmd.status === 400, "a missing command is a 400, not an empty shell");
  // An unknown agent has no folder, so there is nowhere to run — refused rather than run somewhere else.
  const noAgent = await fetch(`${base}/api/bash`, { method: "POST", headers: { ...ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ agent: "ghost", command: "pwd" }) });
  assert(noAgent.status === 400, "an unknown agent is refused rather than defaulted to some directory");
}

// ── markdown TABLES in the web renderer (web/app/md.js) ──────────────────────────────────────────
// A 21-row results table rendered as a WALL OF PROSE: table rows had no case, so every `| a | b |` line
// fell through to the paragraph branch and got joined with spaces. The terminal got away without table
// support because it is monospace and the raw pipes line up; a proportional font destroys them.
{
  const { md, splitRow, parseAlign } = await import("../web/app/md.js");

  assert(splitRow("| a | b |").join(",") === "a,b", "outer pipes are delimiters, not empty cells");
  assert(splitRow("a | b").join(",") === "a,b", "the pipe-less outer form is equally valid markdown");
  // An escaped pipe belongs INSIDE a cell — splitting on it tears one cell in two and shifts every
  // column after it.
  assert(splitRow("| a \\| b | c |").join(",") === "a | b,c", "an escaped pipe stays in its cell");

  // THIS is what makes a table a table. A line with pipes is ordinary prose without it.
  assert(parseAlign("|---|---|")?.length === 2, "a plain delimiter row is recognised");
  assert(parseAlign("|:--|:-:|--:|")?.join(",") === "left,center,right", "alignment is read per column");
  assert(parseAlign("| a | b |") === undefined, "a content row is not a delimiter row");
  assert(parseAlign("hello - world") === undefined, "prose with a dash is not a delimiter row");
  assert(parseAlign(undefined) === undefined, "no next line ⇒ no table");

  const table = md("| run | status |\n|---|---|\n| d6bb0557 | outdated |\n| 89074e24 | current |");
  assert(table.includes("<table>") && table.includes("<thead>"), "a header + delimiter + rows becomes a real table");
  assert((table.match(/<tr>/g) ?? []).length === 3, "one header row and two body rows");
  assert(table.includes("<th>run</th>") && table.includes("<td>d6bb0557</td>"), "cells land in the right kind of cell");
  assert(table.includes('class="tablewrap"'), "wrapped so a wide table scrolls itself, never the page");
  assert(md("|a|b|\n|:-:|--:|\n|1|2|").includes('style="text-align:center"'), "alignment reaches the markup");
  // Cells are markdown too — the real tables are full of `**bold**` and `code`.
  assert(md("| a |\n|---|\n| **hi** |").includes("<strong>hi</strong>"), "inline markdown renders inside cells");

  // The rules that keep prose safe: pipes alone are NOT a table.
  const prose = md("this | that | the other");
  assert(!prose.includes("<table>") && prose.includes("<p>"), "a sentence containing pipes stays a paragraph");
  // Ragged rows keep every cell: dropping one loses data an agent wrote.
  assert((md("|a|b|\n|---|---|\n|1|2|3|").match(/<td>/g) ?? []).length === 3, "an over-long row keeps all its cells");
  // A table ends at a blank line, and what follows is its own block.
  const after = md("|a|\n|---|\n|1|\n\nafter the table");
  assert(after.includes("</table>") && after.includes("<p>after the table</p>"), "text after a table is not swallowed into it");
  // Escaping still happens first — everything here is text an agent wrote.
  assert(!md("| <img src=x onerror=alert(1)> |\n|---|\n| x |").includes("<img"), "HTML in a cell is escaped, not executed");
}

// ---- tasks (src/tasks.ts + web/app/tasks.js) — parse, sort, glyphs, /task command ----
{
  const { parseTasks, sortTasks, bdEnv } = await import("../src/tasks.js");
  const { taskGlyph, parseTaskCommand } = await import("../web/app/tasks.js");

  const rows = parseTasks(
    JSON.stringify([
      { id: "beads-a", title: "open one", status: "open", priority: 1 },
      { id: "beads-b", title: "working", status: "in_progress", priority: 3 },
      { id: "beads-c", title: "stuck", status: "blocked", priority: 0 },
      { id: "beads-d", title: "later", status: "someday_new_status" },
      { title: "no id — dropped", status: "open" },
      "garbage row",
    ]),
  );
  assert(rows.map((t) => t.id).join(",") === "beads-b,beads-c,beads-a,beads-d", "tasks: in_progress > blocked > open > unknown-last");
  assert(rows.length === 4, "tasks: malformed rows dropped, list survives");
  let threwOnEnvelope = false;
  try {
    parseTasks(JSON.stringify({ error: "not an array" }));
  } catch {
    threwOnEnvelope = true;
  }
  assert(threwOnEnvelope, "tasks: a non-array envelope throws rather than rendering as empty");
  assert(sortTasks([]).length === 0, "tasks: empty list sorts to empty");
  assert(bdEnv().BEADS_DIR?.endsWith("/.beads") === true, "tasks: bdEnv pins the machine-wide db");
  assert((bdEnv().PATH ?? "").includes("/opt/homebrew/bin"), "tasks: bdEnv backfills tool dirs into PATH");

  assert(taskGlyph("in_progress").glyph === "◐" && taskGlyph("blocked").cls === "blocked", "tasks: known glyphs");
  assert(taskGlyph("brand_new").glyph === "?" && taskGlyph("brand_new").label === "brand_new", "tasks: unknown status renders as itself");

  assert(parseTaskCommand("/task fix the login flow")?.title === "fix the login flow", "tasks: /task parses a title");
  const withDesc = parseTaskCommand("/task fix login -- users bounce at step 2");
  assert(withDesc?.title === "fix login" && withDesc?.description === "users bounce at step 2", "tasks: ` -- ` splits description");
  assert(parseTaskCommand("use /task to file things") === undefined, "tasks: prose mentioning /task still sends");
  const { cycleStatus, deletionPlan, statusGlyph, pasteLines, relTime, treeOrder, taskDepth } = await import("../web/app/taskspad.js");
  {
    const flat = [
      { id: "a", title: "A", status: "open" },
      { id: "c", title: "C", status: "open" },
      { id: "a1", title: "A1", status: "open", parent: "a" },
      { id: "b", title: "B", status: "open", parent: "gone" },
      { id: "a1x", title: "A1X", status: "open", parent: "a1" },
    ];
    const ordered = treeOrder(flat).map((t) => t.id).join(",");
    assert(ordered === "a,a1,a1x,c,b", `treeOrder: children under parents, orphans top-level (got ${ordered})`);
    const sunk = treeOrder([
      { id: "z", status: "closed" },
      { id: "p", status: "open" },
      { id: "p.done", status: "closed", parent: "p" },
      { id: "p.open", status: "open", parent: "p" },
      { id: "q", status: "open" },
    ]).map((t) => t.id).join(",");
    assert(sunk === "p,p.open,p.done,q,z", `treeOrder: closed sink to the bottom at EACH level, order otherwise kept (got ${sunk})`);
    const byId = new Map(flat.map((t) => [t.id, t]));
    assert(taskDepth(flat[0], byId) === 0 && taskDepth(flat[2], byId) === 1 && taskDepth(flat[4], byId) === 2, "taskDepth walks the chain");
    const loopMap = new Map([["x", { id: "x", parent: "y" }], ["y", { id: "y", parent: "x" }]]);
    assert(taskDepth(loopMap.get("x"), loopMap) === 6, "taskDepth: a parent cycle is bounded, not a hang");
  }
  const now = Date.parse("2026-08-25T12:00:00Z");
  assert(relTime("2026-08-25T11:59:30Z", now) === "30s ago" && relTime("2026-08-25T09:00:00Z", now) === "3h ago" && relTime("2026-08-23T12:00:00Z", now) === "2d ago", "taskspad: relTime buckets");
  assert(relTime("garbage", now) === "" && relTime(undefined, now) === "", "taskspad: relTime is empty for garbage, never NaN");
  {
    const rows = parseTasks(JSON.stringify([{ id: "x-1", title: "t", status: "open", created_at: "2026-08-25T09:00:00Z", created_by: "research", updated_at: "2026-08-25T10:00:00Z" }]));
    assert(rows[0].createdAt === "2026-08-25T09:00:00Z" && rows[0].createdBy === "research" && rows[0].updatedAt === "2026-08-25T10:00:00Z", "tasks: metadata fields pass through");
  }
  assert(pasteLines("- Modal evals\r\n• case study\n\n2. Arena launch\n   * indented\n").join("|") === "Modal evals|case study|Arena launch|indented", "taskspad: paste strips bullets/numbers, drops blanks, handles CRLF");
  assert(pasteLines("just one line").join("|") === "just one line", "taskspad: single-line paste is one title");
  assert(pasteLines("  \n\n").length === 0, "taskspad: whitespace paste is nothing");
  const { pasteOutline } = await import("../web/app/taskspad.js");
  {
    const o = pasteOutline("- parent\n\t- child a\n\t- child b\n\t\t- grandchild\n- parent two");
    assert(o.map((x) => `${x.title}:${x.depth}`).join("|") === "parent:0|child a:1|child b:1|grandchild:2|parent two:0", `outline: tabs nest (got ${o.map((x) => x.title + ":" + x.depth).join("|")})`);
    const sp = pasteOutline("alpha\n  beta\n    gamma");
    assert(sp.map((x) => x.depth).join(",") === "0,1,2", "outline: space indents nest by smallest step");
    assert(pasteOutline("  all\n  same\n  indent").every((x) => x.depth === 0), "outline: uniform indent is depth 0 — shallowest line anchors");
  }
  assert(cycleStatus("open") === "in_progress" && cycleStatus("in_progress") === "closed" && cycleStatus("closed") === "open", "taskspad: bullet cycles open→prog→done→open");
  assert(cycleStatus("blocked") === "open" && cycleStatus("deferred") === "open", "taskspad: blocked/deferred cycle back to open, never a dead end");
  assert(deletionPlan(true) === "close" && deletionPlan(false) === "drop", "taskspad: synced rows CLOSE (shared list), unsynced rows drop");
  assert(statusGlyph("in_progress") === "◐" && statusGlyph("weird") === "?", "taskspad: glyphs incl. unknown-as-?");
  assert(parseTaskCommand("/task") === undefined && parseTaskCommand("/task   ") === undefined, "tasks: bare /task is not a task");
  const { agentTasks } = await import("../web/app/tasks.js");
  const pool = [{ id: "1", assignee: "research" }, { id: "2", createdBy: "Research" }, { id: "3", assignee: "evals", createdBy: "aleks" }, { id: "4" }];
  assert(agentTasks(pool, "research").map((t) => t.id).join(",") === "1,2", "agentTasks: assigned-to OR filed-by, case-insensitive");
  assert(agentTasks(pool, "").length === 0 && agentTasks(pool, "nobody").length === 0, "agentTasks: no name / unknown name → nothing, never everything");
}

// ---- board (web/app/board.js) — pure column bucketing + initials ----
{
  const { columnsFor, initials, COLUMNS } = await import("../web/app/board.js");
  const cols = columnsFor([
    { id: "a", status: "open" },
    { id: "b", status: "in_progress" },
    { id: "c", status: "blocked" },
    { id: "d", status: "someday_new" },
  ]);
  assert(cols.map((c) => c.id).join(",") === COLUMNS.map((c) => c.id).join(","), "board: columns in workflow order");
  assert(cols[0].tasks.map((t) => t.id).join(",") === "a,d", "board: unknown status lands in To do, never vanishes");
  assert(cols[1].tasks.length === 1 && cols[2].tasks.length === 1 && cols[3].tasks.length === 0, "board: buckets by status; Done starts empty");
  assert(initials("Aleksey Bykhun") === "AB" && initials("research") === "RE" && initials("") === "", "board: initials");
  const { childrenOf } = await import("../web/app/board.js");
  const nested = columnsFor([
    { id: "p", status: "open" },
    { id: "p.1", status: "open", parent: "p" },
    { id: "p.2", status: "closed", parent: "p" },
    { id: "o", status: "in_progress", parent: "gone" },
  ]);
  assert(nested[0].tasks.map((t) => t.id).join(",") === "p", "board: children ride inside the parent's card, not as cards");
  assert(nested[1].tasks.map((t) => t.id).join(",") === "o", "board: an orphan (parent not on the board) is still a card");
  assert(childrenOf([{ id: "p" }, { id: "p.1", parent: "p" }, { id: "x", parent: "q" }], "p").map((t) => t.id).join(",") === "p.1", "board: childrenOf is direct children only");
  const { parseComments } = await import("../src/tasks.js");
  const cs = parseComments(JSON.stringify([{ author: "research", text: "on it", created_at: "2026-08-26T03:57:13Z" }, { text: "anon" }, "junk"]));
  assert(cs.length === 2 && cs[0].author === "research" && cs[1].author === "?" && cs[1].createdAt === "", "tasks: parseComments tolerant per row, author never fabricated as a name");
  {
    const { parseTasks: parseT } = await import("../src/tasks.js");
    const [mr] = parseT(JSON.stringify([{ id: "x-1", title: "review", status: "open", issue_type: "merge-request", external_ref: "https://github.com/o/r/pull/7" }]));
    assert(mr.type === "merge-request" && mr.externalRef === "https://github.com/o/r/pull/7", "tasks: merge-request type + external ref pass through");
    const { prChipHtml } = await import("../web/app/taskspad.js");
    assert(prChipHtml({ type: "task" }) === "", "prChip: a plain task gets no chip");
    assert(prChipHtml({ type: "merge-request", externalRef: "https://x/pull/1" }).includes("↗ PR"), "prChip: unresolved PR still links");
    const chip = prChipHtml({ type: "merge-request", externalRef: "u", pr: { url: "https://github.com/o/r/pull/7", number: 7, state: "MERGED", checks: "pass" } });
    assert(chip.includes("⧉ #7") && chip.includes("ck pass") && chip.includes('href="https://github.com/o/r/pull/7"'), "prChip: merged + passing renders the PRs-sidebar vocabulary");
    assert(prChipHtml({ type: "merge-request", externalRef: "u", pr: { url: "u", number: 1, state: "OPEN", isDraft: true } }).includes("◌ #1"), "prChip: draft glyph");
    const { taskPrRows } = await import("../src/tasks.js");
    const rows = taskPrRows([
      { id: "b-1", title: "review", status: "open", type: "merge-request", externalRef: "u", pr: { url: "https://github.com/o/r/pull/9", number: 9 }, assignee: "research" },
      { id: "b-2", title: "unresolved", status: "open", type: "merge-request", externalRef: "u2" },
      { id: "b-3", title: "plain", status: "open", pr: { url: "x", number: 1 } },
    ] as never);
    assert(rows.length === 1 && rows[0].task === "b-1" && rows[0].agent === "research" && rows[0].pr.number === 9, "taskPrRows: only merge-request beads WITH a resolved PR, labelled by assignee, carrying the bead id");
    const { sortTasks: sortT, isOpen } = await import("../src/tasks.js");
    const ordered = sortT([
      { id: "c", title: "", status: "closed" },
      { id: "o", title: "", status: "open" },
      { id: "p", title: "", status: "in_progress" },
    ] as never).map((x) => x.id).join(",");
    assert(ordered === "p,o,c", `tasks: closed sorts LAST (got ${ordered})`);
    assert(!isOpen({ status: "closed" } as never) && isOpen({ status: "blocked" } as never), "tasks: isOpen");
    assert(taskPrRows([{ id: "b-9", title: "", status: "closed", type: "merge-request", externalRef: "u", pr: { url: "u9", number: 9 } }] as never).length === 0, "taskPrRows: a closed review bead leaves the PRs sidebar");
    const [cl] = parseT(JSON.stringify([{ id: "x", title: "t", status: "closed", closed_at: "2026-08-26T01:00:00Z", close_reason: "shipped" }]));
    assert(cl.closedAt === "2026-08-26T01:00:00Z" && cl.closeReason === "shipped", "tasks: closed_at/close_reason pass through");
  }
  let bad = false; try { parseComments("{}"); } catch { bad = true; }
  assert(bad, "tasks: parseComments rejects a non-array envelope");
}

// ---- editlist (web/app/editlist.js) — the shared editable-row contract ----
{
  const { keyAction } = await import("../web/app/editlist.js");
  const mid = { offset: 2, len: 5, collapsed: true };
  const start = { offset: 0, len: 5, collapsed: true };
  const end = { offset: 5, len: 5, collapsed: true };
  assert(keyAction("Enter", "abc", mid) === "new-sibling", "editlist: Enter = new sibling");
  assert(keyAction("Backspace", "", start) === "remove" && keyAction("Backspace", "abc", start) === "prev-end" && keyAction("Backspace", "abc", mid) === "none", "editlist: backspace removes only an EMPTY row; at start of text it walks up");
  assert(keyAction("ArrowLeft", "abc", start) === "prev-end" && keyAction("ArrowLeft", "abc", mid) === "none", "editlist: ← crosses only at the start");
  assert(keyAction("ArrowRight", "abc", end) === "next-start" && keyAction("ArrowRight", "abc", mid) === "none", "editlist: → crosses only at the end");
  assert(keyAction("ArrowUp", "abc", mid) === "up" && keyAction("ArrowDown", "abc", mid) === "down", "editlist: arrows move rows");
  assert(keyAction("Tab", "abc", mid) === "indent" && keyAction("Tab", "abc", mid, true) === "outdent", "editlist: tab/shift-tab");
  assert(keyAction("a", "abc", mid) === "none", "editlist: typing is none");
}

// ---- /api/prs: worktree expansion (pure over fake git) ----
{
  const { expandAgentWorktrees } = await import("../src/web.js");
  const fake = {
    toplevel: (d: string) => (d.startsWith("/repo") ? "/repo" : undefined),
    worktrees: (root: string) => (root === "/repo" ? ["/repo", "/repo-wt-a", "/repo-wt-b"] : []),
  };
  const x = expandAgentWorktrees([{ name: "a1", folder: "/repo" }, { name: "a2", folder: "/repo-wt-a" }, { name: "plain", folder: "/just/a/folder" }], fake);
  assert(x.map((t) => t.folder).join(",") === "/repo,/repo-wt-a,/repo-wt-b", `prs: every worktree of the repo, once (got ${x.map((t) => t.folder).join(",")})`);
  assert(x.every((t) => t.agent === "a1"), "prs: the first agent in the repo labels its worktrees; the second adds none");
  assert(!x.some((t) => t.folder.startsWith("/just")), "prs: a plain folder (no repo) is skipped");
  const boom = expandAgentWorktrees([{ name: "x", folder: "/repo" }], { toplevel: () => { throw new Error("git gone"); }, worktrees: () => [] });
  assert(boom.length === 0, "prs: one bad repo yields nothing rather than failing the sweep");
  const { keepSidebarPr } = await import("../src/web.js");
  assert(keepSidebarPr("OPEN", false) && keepSidebarPr("MERGED", true) && !keepSidebarPr("MERGED", false) && !keepSidebarPr("CLOSED", false) && !keepSidebarPr(undefined, false), "prs: sibling worktrees only when OPEN; the agent's own folder always");
}

await server.close();
assert((await fetch(`${base}/api/status`, { headers: ORIGIN }).then(() => false).catch(() => true)) === true, "close() actually stops answering");

if (failures > 0) {
  console.error(`\n${failures} paw web check(s) failed`);
  process.exit(1);
}
console.log("\nall paw web checks passed 🐾");


// ── channels as agent folders (web/app/channels.js) ──────────────────────────────────────────────
{
  const { channelMembersFor, sortMembers, toggleOpen, loadOpen, GENERAL } = await import("../web/app/channels.js");
  const rows = [{ name: "research", mesh: "idle" }, { name: "aws", mesh: "offline" }, { name: "paw-folder", mesh: "working" }];
  const members = { team2027: ["research", "aleks", "aws"], quiet: [] };
  const g = channelMembersFor(GENERAL, members, rows);
  assert(g.length === 3 && g.every((m) => m.agent), "#general lists the whole roster as agents (every paw persona subscribes to it)");
  const t = channelMembersFor("team2027", members, rows);
  assert(t.length === 3, "another channel lists exactly the authors seen there");
  assert(t.find((m) => m.name === "aleks")?.agent === false, "a non-roster author (a human) is shown but not as an agent");
  assert(t.find((m) => m.name === "research")?.live === true && t.find((m) => m.name === "aws")?.live === false, "liveness comes from the roster row");
  assert(channelMembersFor("quiet", members, rows).length === 0, "a channel with no traffic has no members — an absence, not a claim");
  assert(channelMembersFor("unknown", undefined, rows).length === 0, "no members map at all → empty, never a throw");
  const sorted = sortMembers(t).map((m) => m.name);
  assert(sorted.join(",") === "research,aws,aleks", "live agents, then offline agents, then non-agents; alphabetical within");
  let open: Record<string, true> = {};
  open = toggleOpen(open, "team2027");
  assert(open.team2027 === true, "toggle opens");
  open = toggleOpen(open, "team2027");
  assert(open.team2027 === undefined, "toggle again closes (key removed, not set false)");
  // corrupt storage reads as nothing open
  globalThis.localStorage = { getItem: () => "not json", setItem: () => {} } as unknown as Storage;
  assert(Object.keys(loadOpen("paw")).length === 0, "a corrupt open-state value reads as nothing open");
  globalThis.localStorage = { getItem: () => JSON.stringify(["a"]), setItem: () => {} } as unknown as Storage;
  assert(Object.keys(loadOpen("paw")).length === 0, "an array where an object is expected reads as nothing open");
  console.log("✓ channels as agent folders");
}


// ── search (src/search.ts) ────────────────────────────────────────────────────────────────────────
{
  const { snippet, searchEntries, recordText } = await import("../src/search.js");
  assert(snippet("the quick brown fox jumps over the lazy dog", "brown", 20).includes("brown"), "snippet keeps the match whole");
  assert(snippet("aaaa PELICAN bbbb", "pelican").includes("PELICAN"), "snippet matches case-insensitively and returns original casing");
  assert(snippet("x".repeat(500), "nomatch", 40) === "x".repeat(40) + "…", "no match → the head of the text, cut and marked, never empty");
  assert(snippet("a\n\n  b   c", "b") === "a b c", "whitespace is flattened for a one-line snippet");
  const entries: import("../src/feed.js").Entry[] = [
    { from: "research", text: "deploy is green", ts: 1, dir: "in" },
    { from: "you", to: "queue", text: "please redeploy v119", ts: 2, dir: "out" },
    { from: "harbor", text: "nothing here", ts: 3, dir: "in" },
  ];
  const hits = searchEntries(entries, "deploy");
  assert(hits.length === 2, "two messages mention deploy");
  assert(hits[0].ts === 2 && hits[0].target === "queue", "an OUTGOING hit opens the agent it went TO, newest first");
  assert(hits[1].target === "research", "an incoming hit opens the agent it came from");
  assert(searchEntries(entries, "").length === 0, "an empty query matches nothing, never everything");
  const rec = { type: "assistant", timestamp: "2026-09-01T00:00:00Z", message: { role: "assistant", content: [{ type: "text", text: "sent PELICAN" }, { type: "tool_use", name: "Bash", input: { cmd: "PELICAN" } }] } };
  const rt = recordText(rec);
  assert(rt.role === "assistant" && rt.text === "sent PELICAN" && rt.ts === Date.parse("2026-09-01T00:00:00Z"), "recordText takes only the TEXT blocks, with role and ts");
  assert(recordText({ type: "user", message: { role: "user", content: "hello" } }).text === "hello", "a string content is text");
  assert(recordText({ type: "system" }).text === "" && recordText(null).text === "", "meta/invalid records yield no text");
  console.log("✓ search helpers");
}


// ── channel unread (web/app/channels.js + Channels.activity) ─────────────────────────────────────
{
  const { loadSeen, markSeen, channelUnread } = await import("../web/app/channels.js");
  let seen: Record<string, number> = {};
  seen = markSeen(seen, "team2027", 100);
  assert(seen.team2027 === 100, "markSeen records the stamp");
  assert(markSeen(seen, "team2027", 50) === seen, "a stale (older) stamp never moves seen backwards");
  assert(markSeen(seen, "team2027", NaN) === seen, "a non-number stamp is ignored");
  assert(channelUnread({ team2027: { latest: 120, unread: 3 } }, "team2027") === 3, "the server's count is what renders");
  assert(channelUnread({}, "quiet") === 0 && channelUnread(undefined, "quiet") === 0, "unknown to the server → 0, never lit");
  globalThis.localStorage = { getItem: () => JSON.stringify({ a: 5, b: "x", c: null }), setItem: () => {} } as unknown as Storage;
  const l = loadSeen("paw");
  assert(l.a === 5 && !("b" in l) && !("c" in l), "loadSeen keeps only finite numbers");
  globalThis.localStorage = { getItem: () => "[]", setItem: () => {} } as unknown as Storage;
  assert(Object.keys(loadSeen("paw")).length === 0, "an array reads as nothing seen");
  const { Channels } = await import("../src/web.js");
  const c = new Channels();
  c.noteStamps("x", [10, 20, 30, 20]);
  c.noteStamps("x", [40]);
  const act = c.activity({ x: 20 });
  assert(act.x.latest === 40 && act.x.unread === 2, "activity counts stamps strictly after seen (30, 40) and reports the newest");
  assert(c.activity({}).x.unread === 4, "never looked → everything counts");
  assert(c.activity({ x: 40 }).x.unread === 0, "looked at the newest → nothing unread");
  console.log("✓ channel unread");
}

/* ── the Village view: folder-tree build + segments + cross-repo (client, web/app/village.js) ──── */
{
  const { segmentsFor, buildTree, crossRepo, placement, stationLabel } = await import("../web/app/village.js");
  assert(JSON.stringify(segmentsFor({ name: "x", folder: "/Users/aleks/Github/team2027/evals" })) === JSON.stringify(["Github", "team2027", "evals"]), "segmentsFor strips the home prefix to the folder chain");
  assert(JSON.stringify(segmentsFor({ name: "w", unregistered: { agent: "codex" } })) === JSON.stringify(["· workers"]), "a cotal_spawn peer with no folder lives under · workers");
  assert(JSON.stringify(segmentsFor({ name: "wt", folder: "/Users/aleks/.superconductor/worktrees/evals/sc-x", git: { repo: "team2027/evals", worktree: true, mainPath: "/Users/aleks/Github/team2027/evals" } })) === JSON.stringify(["Github", "team2027", "evals"]), "a worktree is placed under its repo's MAIN folder, not where it physically sits");
  const tree = buildTree([
    { name: "research", folder: "/Users/aleks/Github/team2027", mesh: "idle", live: true },
    { name: "evals", folder: "/Users/aleks/Github/team2027/evals", mesh: "idle", live: true },
    { name: "aw", folder: "/Users/aleks/Github/team2027/evals/.claude/worktrees", mesh: "idle", live: true },
    { name: "land", folder: "/Users/aleks/Github/caffeinum/vibeos-landing", mesh: "working", live: true },
  ]);
  const gh = tree.children.get("Github")!;
  // a superconductor worktree of team2027/evals nests under Github/team2027/evals (not a separate branch)
  const treeWt = buildTree([{ name: "wt", folder: "/Users/aleks/.superconductor/worktrees/evals/sc-x", mesh: "idle", live: true, git: { repo: "team2027/evals", worktree: true, mainPath: "/Users/aleks/Github/team2027/evals" } }]);
  // a lone chain compresses to one node (`Github/team2027/evals`) holding the agent
  const wtNode = [...treeWt.children.values()][0];
  assert(wtNode && wtNode.name.endsWith("evals") && wtNode.agents.some((a: { name: string }) => a.name === "wt"), "a worktree agent is a leaf of its repo node");
  // a git-less superconductor worktree resolves to its repo by the `worktrees/<name>/` path segment,
  // matched against another agent that DOES report team2027/evals (operator, 2026-09-09).
  const treeInfer = buildTree([
    { name: "evals", folder: "/Users/aleks/Github/team2027/evals", mesh: "idle", live: true, git: { repo: "team2027/evals" } },
    { name: "scw", folder: "/Users/aleks/.superconductor/worktrees/evals/sc-frozen-x", mesh: "idle", live: true },
  ]);
  const inferNode = [...treeInfer.children.values()][0];
  assert(inferNode && inferNode.agents.some((a: { name: string }) => a.name === "scw"), "a git-less worktree is inferred into its repo by the worktrees/<name> path");
  assert(gh && gh.children.has("team2027") && gh.children.has("caffeinum"), "buildTree nests repos under the Github owner folders");
  const t27 = gh.children.get("team2027")!;
  assert(t27.agents.some((a: { name: string }) => a.name === "research"), "an agent at the folder root is a leaf of that node");
  const evals = t27.children.get("evals")!;
  // .claude/worktrees is a lone agent-less chain → compressed onto one node holding `aw`
  assert(evals.children.size === 1 && [...evals.children.values()][0].name.includes("worktrees") && [...evals.children.values()][0].agents[0].name === "aw", "single-child chains compress (.claude/worktrees → one hop)");
  // caffeinum/vibeos-landing is a lone chain under caffeinum with the agent at the leaf
  const caf = gh.children.get("caffeinum")!;
  const landAgent = caf.agents[0] ?? [...caf.children.values()][0]?.agents[0];
  assert(landAgent?.name === "land", "a repo folder holds its agent as a leaf");
  // cross-repo: research(team2027) ↔ land(caffeinum) crosses; research ↔ evals (same team2027) does not
  const rows = [
    { name: "research", folder: "/Users/aleks/Github/team2027" },
    { name: "evals", folder: "/Users/aleks/Github/team2027/evals" },
    { name: "land", folder: "/Users/aleks/Github/caffeinum/vibeos-landing" },
  ];
  const ap = { research: {}, evals: {}, land: {}, you: {} };
  const cross = crossRepo(([["research", "land"], ["research", "evals"], ["research", "you"]] as Array<[string, string]>).map(([a, b]) => ({ a, b, count: 1 })), ap, rows);
  assert((cross.get("land") || 0) > 0 && (cross.get("you") || 0) > 0, "crossRepo flags an agent talking to another repo and to you");
  assert(!cross.has("evals"), "same-owner traffic (team2027 ↔ team2027) is NOT a cross-repo interchange");
  // placement persistence: a known name keeps its rank, a fresh one is appended.
  const store: Record<string, string> = {};
  globalThis.localStorage = { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; } } as unknown as Storage;
  const r1 = placement("paw", ["b", "a"]);
  assert(r1("a") < r1("b"), "first placement seeds the name-sorted order (a before b)");
  const r2 = placement("paw", ["a", "b", "c"]);
  assert(r2("a") === r1("a") && r2("b") === r1("b") && r2("c") > r2("b"), "a new agent is APPENDED — existing slots never move");
  assert(stationLabel("you") === "you" && stationLabel("research") === "research", "no branch → just the name");
  assert(stationLabel("research", "main") === "research · main", "a checkout's branch sits on the station");
  assert(stationLabel("wt", "feat/x", true) === "wt · ⑂ feat/x", "a worktree is marked so it doesn't look like the main checkout");
  const treeBr = buildTree([{ name: "research", folder: "/Users/aleks/Github/team2027", mesh: "idle", live: true, git: { repo: "team2027", branch: "main", worktree: false } }]);
  assert([...treeBr.children.values()][0].agents[0].branch === "main", "buildTree carries the branch onto the leaf");
  console.log("✓ village tree");
}

/* ── the ⌘K palette ranking (web/app/palette.js) ────────────────────────────────────────────────── */
{
  const { rankItems } = await import("../web/app/palette.js");
  const items = [
    { target: "research", label: "research", kind: "agent" as const },
    { target: "re", label: "re", kind: "agent" as const },
    { target: "#general", label: "#general", kind: "channel" as const },
    { target: "aws", label: "aws", kind: "agent" as const },
    { target: "rearrange", label: "rearrange", kind: "agent" as const },
  ];
  assert(rankItems(items, "").length === 5, "an empty query returns everything, order untouched");
  const r = rankItems(items, "re").map((i) => i.label);
  assert(r[0] === "re", "an EXACT match ranks first");
  assert(r[1] === "rearrange" && r[2] === "research", "then PREFIX matches, shorter first");
  assert(!r.includes("aws"), "a non-match is dropped");
  assert(rankItems(items, "gen").map((i) => i.label).includes("#general"), "a channel matches by its label including the #");
  assert(rankItems(items, "zzz").length === 0, "no match → empty list (the palette shows 'no match')");
  console.log("✓ palette ranking");
}
