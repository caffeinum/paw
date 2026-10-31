/**
 * check:office — the agent-office bridge (src/office-bridge.ts, src/office-link.ts, src/commands/office.ts).
 *
 *   1. pure mapping: row → office_join / office_status payloads, change keys, clipping, tool names,
 *      tapped message → speech, office chat → paw DM.
 *   2. the link file: URL/key validation, 0600, keys never rendered; `paw office` arg parsing.
 *   3. the engine against a fake office: join → status → poll, change detection, leave, 429 backoff
 *      (respects retryAfter), 401 → rejoin, inbound delivery + reply routing, retry, join budget.
 *   4. integration against a REAL agent-office when PAW_OFFICE_TEST_URL + PAW_OFFICE_TEST_ADMIN_KEY are
 *      set (`npm run dev` in agent-office); skipped with a note otherwise.
 *
 * Hermetic for 1–3 (temp PAW_HOME, no mesh). 4 creates a throwaway office on the given deployment.
 */
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PAW_HOME = mkdtempSync(join(tmpdir(), "paw-office-"));
const { clip, desiredFor, inboundFor, inboundText, joinPayload, OfficeBridge, pollInterval, singleEmoji, speechFor, statusKey, statusPayload, toolName } = await import("../src/office-bridge.ts");
const { describeLink, makeLink, officeEmbed, readBridgeState, readOfficeLink, removeOfficeLink, viewerUrl, writeBridgeState, writeOfficeLink } = await import("../src/office-link.ts");
const { OfficeError, officeClient } = await import("../src/office-api.ts");
const { parseOfficeArgs, verifyLink } = await import("../src/commands/office.ts");
type BridgeState = import("../src/office-link.ts").BridgeState;

let failures = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) console.log(`  ok  ${msg}`);
  else {
    failures++;
    console.error(`  FAIL  ${msg}`);
  }
}
function throws(fn: () => unknown, re: RegExp, msg: string): void {
  try {
    fn();
    assert(false, `${msg} (did not throw)`);
  } catch (e) {
    assert(re.test((e as Error).message), `${msg} — ${(e as Error).message}`);
  }
}

type Row = Parameters<typeof desiredFor>[0];
const row = (name: string, over: Partial<Row> = {}): Row => ({ name, mesh: "idle", live: true, busy: false, git: { repo: "caffeinum/paw", worktree: false }, ...over });

console.log("1. mapping");
{
  assert(desiredFor(row("a", { live: false, mesh: "offline" })).present === false, "offline → not present (office_leave)");
  assert(desiredFor(row("a", { mesh: "idle", live: false })).present === false, "not live → not present");
  const w = desiredFor(row("a", { mesh: "working", tool: { id: "t", name: "Bash", summary: "cat ~/.secrets/token" } }));
  assert(w.status === "working" && w.activity === "Bash · paw", `working + pending tool → "Bash · paw", never the tool's arguments (${w.activity})`);
  assert(desiredFor(row("a", { mesh: "idle", busy: true })).status === "working", "paw's busy inference counts as working");
  assert(desiredFor(row("a", { mesh: "working", git: undefined })).activity === "working", "no git → no repo, never the folder path");
  assert(desiredFor(row("a", { mesh: "working", tool: { id: "t", name: "mcp__cotal__cotal_dm", summary: "" } })).activity === "cotal_dm · paw", "an MCP tool shows its own name");
  assert(toolName("mcp__claude_ai_Linear__list_issues") === "list_issues" && toolName("Read") === "Read", "toolName strips the mcp__server__ prefix");
  assert(desiredFor(row("a", { mesh: "waiting", busy: true })).status === "waiting", "waiting → waiting (even though paw's busy inference counts it as mid-turn)");
  assert(statusKey(desiredFor(row("a"))) === "idle\u0000" && !("activity" in statusPayload(desiredFor(row("a")))), "idle → idle, no activity");
  assert(desiredFor(row("a", { mesh: "starting" })).activity === "starting up", "starting → idle 'starting up'");
  assert(desiredFor(row("a", { failure: { text: "API Error 500", ts: 1 } })).status === "waiting", "a failed last turn → waiting (needs a look)");
  const long = desiredFor(row("a", { mesh: "working", tool: { id: "t", name: "x".repeat(300), summary: "" } }));
  assert((long.activity ?? "").length <= 120, "activity ≤ 120 chars");
  assert(statusKey(desiredFor(row("a", { mesh: "working" }))) !== statusKey(desiredFor(row("a", { mesh: "working", tool: { id: "t", name: "Bash", summary: "" } }))), "a different activity is a change");
  assert(statusKey(desiredFor({ ...row("a", { mesh: "working" }), activeMs: 1 } as Row)) === statusKey(desiredFor({ ...row("a", { mesh: "working" }), activeMs: 2 } as Row)), "fields the office doesn't show are not a change");
  const j = joinPayload(row("ada", { hue: 210, emoji: "🦊" }));
  assert(j.name === "ada" && j.hue === 210 && j.emoji === "🦊" && j.client === "paw", "join: name + persona hue + emoji + client paw");
  assert(!("emoji" in joinPayload(row("ada", { emoji: "🦊🐱" }))) && !("hue" in joinPayload(row("ada", { hue: 400 }))), "join: two emoji / an out-of-range hue are omitted, not sent to fail");
  assert(singleEmoji("👩‍💻") === "👩‍💻" && singleEmoji("a") === undefined, "singleEmoji: a ZWJ sequence is one emoji, a letter isn't");
  assert(clip("a‮ b\n\n c", 50) === "a b c" && clip("x".repeat(300), 200).length === 200 && clip("x".repeat(300), 200).endsWith("…"), "clip: one line, no bidi/control chars, ellipsis at the limit");

  const names = new Map([["id-b", "bob"], ["id-c", "carol"], ["id-x", "stranger"]]);
  const ctx = { humanId: "id-you", names, bridged: new Set(["ada", "bob"]), text: (m: { parts?: unknown }) => (m.parts as Array<{ text: string }>).map((p) => p.text).join(" ") };
  const msg = (o: object) => ({ id: "m", ts: 1, parts: [{ kind: "text", text: "hello there" }], ...o });
  const toB = speechFor(msg({ from: { id: "id-a", name: "ada" }, to: "id-b" }), ctx);
  assert(toB?.kind === "chat" && JSON.stringify(toB.to) === '{"agent":"bob"}' && toB.text === "hello there", "agent→agent DM → chat to the other agent");
  assert(JSON.stringify(speechFor(msg({ from: { id: "id-a", name: "ada" }, to: "id-you" }), ctx)?.to) === '{"human":true}', "agent→you DM → chat to the office's human");
  const authNames = new Map([...names, ["id-human-real", "human"]]);
  assert(JSON.stringify(speechFor(msg({ from: { id: "id-a", name: "ada" }, to: "id-human-real" }), { ...ctx, humanId: "id-observer", humanName: "human", names: authNames })?.to) === '{"human":true}', "auth/remote: a DM to the human's roster name (not the observer's card id) → chat to the office's human");
  const ch = speechFor(msg({ from: { id: "id-a", name: "ada" }, channel: "general" }), ctx);
  assert(ch?.kind === "say" && ch.text === "#general: hello there", "channel post → said aloud with its channel");
  assert(speechFor(msg({ from: { id: "id-a", name: "ada" }, channel: "events.local.UAQTPVE3J6LH" }), ctx) === undefined, "an events.* channel (ag-ui frames) is never said aloud");
  assert(speechFor(msg({ from: { id: "id-you", name: "you" }, to: "id-b" }), ctx) === undefined, "you→agent is not mirrored (can't be attributed over REST)");
  assert(speechFor(msg({ from: { id: "id-x", name: "stranger" }, to: "id-b" }), ctx) === undefined, "an unbridged sender is not mirrored");
  assert(speechFor(msg({ from: { id: "id-a", name: "ada" }, to: "id-c" }), ctx) === undefined, "a DM to an unbridged agent is not mirrored");
  assert(speechFor(msg({ from: { id: "id-a", name: "ada" }, to: "id-unknown" }), ctx) === undefined, "an unresolved recipient is dropped, never shown as an id");
  assert(speechFor({ from: { id: "id-a", name: "ada" } }, ctx) === undefined && speechFor(undefined, ctx) === undefined, "control frames (no parts) are ignored");
  assert((speechFor(msg({ from: { id: "id-a", name: "ada" }, to: "id-you", parts: [{ kind: "text", text: "y".repeat(5000) }] }), ctx)?.text.length ?? 0) <= 200, "a long DM is clipped to 200");

  const inbox = [
    { id: "1", from: "human:aleks", to: "ag-a", text: "hi ada", ts: 10 },
    { id: "2", from: "human:aleks", to: null, text: "hi room", ts: 11 },
    { id: "3", from: "ag-b", to: "ag-a", text: "mirrored line", ts: 12 },
    { id: "4", from: "ag-a", to: "human:aleks", text: "own", ts: 13 },
    { id: "5", from: "cursor-1", to: "ag-a", text: "from a cursor agent", ts: 14 },
  ];
  const got = inboundFor(inbox, "ag-a", new Set(["ag-a", "ag-b"])).map((m) => m.id);
  assert(got.join() === "1,5", `inbound: only messages TO this agent from a human or a non-paw agent (${got.join()})`);
  assert(inboundText(inbox[0]!, {}) === "[agent office] aleks: hi ada" && inboundText(inbox[4]!, { "cursor-1": "Cursy" }) === "[agent office] Cursy: from a cursor agent", "inbound text names the human / office agent");
  assert(pollInterval(3) === 15_000 && pollInterval(64) === 25_600, "poll interval grows with the fleet (≤ ~40 polls / 10s)");
}

console.log("2. link file + args");
const KEY = (id: string, c = "a") => `${id}.${c.repeat(43)}`;
{
  throws(() => makeLink("s", "ftp://x", { joinKey: KEY("abcdefghijkm") }), /http/, "url: non-http refused");
  throws(() => makeLink("s", "http://office.example.com", { joinKey: KEY("abcdefghijkm") }), /plain http/, "url: plain http to a remote host refused");
  throws(() => makeLink("s", "https://office.example.com/o/abc", { joinKey: KEY("abcdefghijkm") }), /bare base URL/, "url: a page path refused");
  throws(() => makeLink("s", "http://127.0.0.1:8811", { joinKey: "nope" }), /--join-key is not an agent-office key/, "a malformed key is refused");
  throws(() => makeLink("s", "http://127.0.0.1:8811", { joinKey: KEY("abcdefghijkm"), ownerKey: KEY("zzzzzzzzzzzz") }), /different office/, "keys from two offices are refused");
  let leaked = false;
  try {
    makeLink("s", "http://127.0.0.1:8811", { joinKey: "secretsecret.notakey" });
  } catch (e) {
    leaked = (e as Error).message.includes("secretsecret");
  }
  assert(!leaked, "a bad key is never echoed in the error");
  const link = makeLink("s", "http://127.0.0.1:8811/", { joinKey: KEY("abcdefghijkm"), ownerKey: KEY("abcdefghijkm", "b") });
  const path = writeOfficeLink(link);
  assert((statSync(path).mode & 0o777) === 0o600, "office.json is 0600");
  assert(readOfficeLink("s")?.joinKey === link.joinKey && readOfficeLink("s")?.url === "http://127.0.0.1:8811", "round-trips, url normalised to the origin");
  assert(!describeLink(link).includes("aaaa") && !describeLink(link).includes("bbbb") && describeLink(link).includes("join, owner"), "describeLink names which keys are stored, never their values");
  assert(viewerUrl(link) === `http://127.0.0.1:8811/o/abcdefghijkm#k=${encodeURIComponent(link.ownerKey!)}`, "viewer: owner key in the fragment");
  const e = officeEmbed("s");
  assert(e.connected && e.src === viewerUrl(link) && !e.readOnly, "embed: linked with an owner key → src, not read-only");
  const st: BridgeState = { office: "abcdefghijkm", agents: { ada: { id: "ada-1", token: "t", joinedAt: 1 } } };
  writeBridgeState("s", st);
  assert(readBridgeState("s", "abcdefghijkm").agents.ada?.token === "t" && Object.keys(readBridgeState("s", "zzzzzzzzzzzz").agents).length === 0, "bridge state: kept for its office, fresh for another");
  assert((statSync(join(process.env.PAW_HOME!, "spaces", "s", "office-agents.json")).mode & 0o777) === 0o600, "office-agents.json is 0600");
  assert(removeOfficeLink("s") && readOfficeLink("s") === undefined && !officeEmbed("s").connected, "disconnect removes link + tokens");
  const none = officeEmbed("s");
  assert(!none.connected && none.command === "paw office connect --space s --url <agent-office url> --join-key <joinKey> --owner-key <ownerKey>", "embed: no link → the exact connect command");
  const a = parseOfficeArgs(["connect", "--url", "http://127.0.0.1:1", "--join-key", "k", "--space", "s"]);
  assert(a.verb === "connect" && a.space === "s" && a.joinKey === "k", "args: connect");
  assert(parseOfficeArgs(["--space", "s"]).verb === "status", "args: bare `paw office` = status");
  throws(() => parseOfficeArgs(["connect", "--url", "http://127.0.0.1:1", "--space", "s"]), /needs --url and --join-key/, "args: connect without --join-key");
  throws(() => parseOfficeArgs(["status", "--join-key", "k", "--space", "s"]), /belong to `paw office connect`/, "args: keys only on connect");
  throws(() => parseOfficeArgs(["frob", "--space", "s"]), /unknown `office frob`/, "args: unknown verb");
}

console.log("3. engine (fake office)");
{
  let clock = 1_000_000;
  const calls: Array<{ tool: string; args: Record<string, unknown>; token?: string }> = [];
  let failNext: Error | undefined;
  const chat: Record<string, unknown[]> = {};
  let n = 0;
  const call = async (tool: string, args: Record<string, unknown>, opts: { token?: string } = {}) => {
    calls.push({ tool, args, token: opts.token });
    if (failNext) {
      const e = failNext;
      failNext = undefined;
      throw e;
    }
    if (tool === "join") return { agentToken: `tok-${args.name}-${++n}`, agent: { id: `id-${args.name}` } };
    if (tool === "chat_read") return { messages: chat[opts.token!.split("-")[1]!] ?? [], more: false, now: clock, names: {} };
    return { ok: true };
  };
  const delivered: Array<[string, string]> = [];
  let deliverFail = 0;
  const logs: string[] = [];
  let saves = 0;
  const state: BridgeState = { office: "o", agents: {} };
  const b = new OfficeBridge({
    call,
    state,
    save: () => saves++,
    deliver: async (agent, text) => {
      if (deliverFail > 0) {
        deliverFail--;
        throw new Error("mesh down");
      }
      delivered.push([agent, text]);
    },
    log: (l) => logs.push(l),
    operator: "aleks",
    now: () => clock,
  });
  const tools = () => calls.map((c) => `${c.tool}${c.args.name ? `:${c.args.name}` : ""}`).join(",");

  await b.tick();
  assert(calls.length === 0, "nothing happens before the first roster (an unread roster is not 'everyone offline')");
  b.setRows([row("ada", { mesh: "working", tool: { id: "t", name: "Edit", summary: "" }, hue: 30, emoji: "🦊" }), row("bob"), row("cy", { live: false, mesh: "offline" })]);
  await b.tick();
  assert(tools() === "join:ada,join:bob,status,status,chat_read,chat_read", `first pass: join the live two, set status, poll (${tools()})`);
  assert(calls[0]!.args.hue === 30 && calls[0]!.args.emoji === "🦊" && calls[0]!.args.client === "paw", "join carries persona hue + emoji");
  assert(state.agents.ada?.token === "tok-ada-1" && saves > 0, "the agentToken is kept in the state (saved)");
  const st = calls.find((c) => c.tool === "status" && c.token === "tok-ada-1");
  assert(st?.args.status === "working" && st.args.activity === "Edit · paw", "status: working with the tool + repo");
  calls.length = 0;
  clock += 2_000;
  await b.tick();
  assert(calls.length === 0, "unchanged roster → no calls (status only on change, polls on their interval)");
  b.setRows([row("ada", { mesh: "idle" }), row("bob")]);
  await b.tick();
  assert(tools() === "status" && calls[0]!.args.status === "idle", "a change → exactly one status call");
  calls.length = 0;
  clock += 15_000;
  await b.tick();
  assert(tools() === "chat_read,chat_read", "poll interval elapsed → a chat read per agent (the presence heartbeat)");

  // inbound office chat → paw DM; the agent's reply goes back to that human
  calls.length = 0;
  chat.ada = [{ id: "c1", from: "human:mira", to: "id-ada", text: "can you look at the build?", ts: clock - 1 }];
  clock += 15_000;
  await b.tick();
  assert(delivered.length === 1 && delivered[0]![0] === "ada" && delivered[0]![1] === "[agent office] mira: can you look at the build?", "office chat to ada → a paw DM to ada");
  assert(state.agents.ada?.since === clock && state.lastHuman === "mira", "cursor advanced to the office's clock; last human remembered");
  chat.ada = [];
  calls.length = 0;
  b.noteSpeech({ from: "ada", kind: "chat", to: { human: true }, text: "on it" });
  b.noteSpeech({ from: "ada", kind: "chat", to: { human: true }, text: "build is green" });
  b.noteSpeech({ from: "bob", kind: "chat", to: { agent: "ada" }, text: "pr up" });
  b.noteSpeech({ from: "cy", kind: "say", text: "nobody hears this" });
  await b.tick();
  const sends = calls.filter((c) => c.tool === "chat_send");
  assert(sends.length === 2 && sends[0]!.args.to === "human:mira" && sends[0]!.args.text === "on it / build is green", "ada's reply → chat_send to human:mira, consecutive lines coalesced");
  assert(sends[1]!.args.to === "id-ada" && sends[1]!.token === "tok-bob-2", "bob→ada → chat_send from bob's token to ada's office id");
  assert(!calls.some((c) => c.args.text === "nobody hears this"), "a line from an agent not in the office is dropped");

  // delivery failure retries, then succeeds without double delivery
  delivered.length = 0;
  const t0 = clock;
  chat.ada = [{ id: "c2", from: "human:mira", to: "id-ada", text: "again", ts: t0 + 1 }];
  deliverFail = 1;
  clock += 15_000;
  await b.tick();
  assert(delivered.length === 0 && state.agents.ada!.since === t0, "a failed delivery keeps the cursor just before the message");
  clock += 15_000;
  await b.tick();
  assert(delivered.length === 1 && delivered[0]![1].endsWith("again"), "…and the next poll delivers it once");
  assert(logs.some((l) => /attempt 1\/3/.test(l)), "the failed attempt is logged");
  chat.ada = [];

  // 429: pause the link for retryAfter, then resume
  calls.length = 0;
  b.setRows([row("ada", { mesh: "waiting" }), row("bob")]);
  failNext = new OfficeError(429, "rate limited", 7);
  await b.tick();
  assert(b.pausedFor() === 7_000 && logs.some((l) => /pausing 7s/.test(l)), "429 → pause the whole link for retryAfter (7s)");
  calls.length = 0;
  clock += 5_000;
  await b.tick();
  assert(calls.length === 0, "still paused at +5s → no calls");
  clock += 2_500;
  await b.tick();
  assert(calls.some((c) => c.tool === "status" && c.args.status === "waiting"), "after retryAfter the change is sent");

  // 401 on a token call → forget + rejoin
  calls.length = 0;
  b.setRows([row("ada", { mesh: "working" }), row("bob")]);
  failNext = new OfficeError(401, "unknown agentToken");
  await b.tick();
  assert(!state.agents.ada && logs.some((l) => /refused — rejoining/.test(l)), "401 → token dropped");
  calls.length = 0;
  await b.tick();
  assert(tools().startsWith("join:ada,status") && state.agents.ada?.token.startsWith("tok-ada-"), "…and rejoined next pass with a fresh token, status re-sent");

  // offline → leave
  calls.length = 0;
  b.setRows([row("ada", { mesh: "offline", live: false }), row("bob")]);
  await b.tick();
  assert(tools() === "leave" && !state.agents.ada, "offline → office_leave, token forgotten");

  // a persistent error backs off (per agent) and is logged, never thrown
  calls.length = 0;
  logs.length = 0;
  b.setRows([row("ada"), row("bob")]);
  failNext = new OfficeError(500, "boom");
  await b.tick();
  assert(logs.some((l) => /ada: boom \(failure 1; retry in 5s\)/.test(l)), "a 500 is logged with its backoff");
  calls.length = 0;
  clock += 1_000;
  await b.tick();
  assert(!calls.some((c) => c.args.name === "ada"), "…and ada isn't retried inside the backoff");
  clock += 5_000;
  await b.tick();
  assert(calls.some((c) => c.args.name === "ada") && logs.some((l) => /ada: recovered/.test(l)), "…then retried, recovery logged");

  // join key rotated: a link-level refusal — pause, keep every token, log once
  calls.length = 0;
  logs.length = 0;
  const before = JSON.stringify(state.agents);
  b.setRows([row("ada", { mesh: "working" }), row("bob")]);
  failNext = new OfficeError(401, "office status: HTTP 401 — missing or wrong key for this office (Authorization: Bearer <key> or ?key=)");
  await b.tick();
  assert(JSON.stringify(state.agents) === before && b.pausedFor() === 60_000, "join key refused → tokens kept, whole link paused 60s (not 'token refused — rejoining')");
  assert(logs.filter((l) => /REFUSED THE JOIN KEY/.test(l)).length === 1 && !logs.some((l) => /rejoining/.test(l)), "…logged once, loudly, with the reconnect command");
  clock += 60_000;
  calls.length = 0;
  await b.tick();
  assert(calls.some((c) => c.tool === "status") && logs.some((l) => /accepts the join key again/.test(l)), "…and resumes when the key works again");

  // a retried batch never re-delivers what already went through; a reply goes to whoever asked (an office agent too)
  delivered.length = 0;
  calls.length = 0;
  chat.ada = [
    { id: "c3", from: "id-bot", to: "id-ada", text: "first", ts: clock + 5 },
    { id: "c4", from: "human:mira", to: "id-ada", text: "second", ts: clock + 5 },
  ];
  let failSecond = true;
  const realDeliver = delivered.push.bind(delivered);
  delivered.push = (...items: Array<[string, string]>) => {
    if (items[0]![1].endsWith("second") && failSecond) {
      failSecond = false;
      throw new Error("mesh down");
    }
    return realDeliver(...items);
  };
  clock += 15_000;
  await b.tick();
  clock += 15_000;
  await b.tick();
  delivered.push = realDeliver;
  assert(delivered.map((d) => d[1]).join("|") === "[agent office] id-bot: first|[agent office] mira: second", `retry delivers only the failed message (${delivered.map((d) => d[1]).join("|")})`);
  chat.ada = [{ id: "c5", from: "id-bot", to: "id-ada", text: "status?", ts: clock + 1 }];
  clock += 15_000;
  await b.tick();
  chat.ada = [];
  calls.length = 0;
  b.noteSpeech({ from: "ada", kind: "chat", to: { human: true }, text: "all green" });
  await b.tick();
  assert(calls.find((c) => c.tool === "chat_send")?.args.to === "id-bot", "ada's reply to 'you' goes back to the office agent that asked");

  // disconnect: shutdown(leave) walks every held token out, then the bridge never ticks again
  calls.length = 0;
  await b.shutdown(true);
  assert(calls.filter((c) => c.tool === "leave").length === Object.keys(state.agents).length && calls.length > 0, "shutdown(leave) → office_leave for every held token");
  calls.length = 0;
  clock += 60_000;
  b.setRows([row("ada"), row("bob"), row("zed")]);
  await b.tick();
  assert(calls.length === 0, "…and a stopped bridge never calls (or rejoins) again");

  // join budget: 12 new agents → at most 8 joins a minute
  const s2: BridgeState = { office: "o", agents: {} };
  const c2: string[] = [];
  const b2 = new OfficeBridge({ call: async (tool, args) => (c2.push(tool), tool === "join" ? { agentToken: `t${args.name}`, agent: { id: `i${args.name}` } } : { messages: [], now: clock }), state: s2, save: () => {}, deliver: async () => {}, log: () => {}, operator: "x", now: () => clock });
  b2.setRows(Array.from({ length: 12 }, (_, i) => row(`a${i}`)));
  await b2.tick();
  assert(c2.filter((t) => t === "join").length === 8, `join budget: 8 of 12 joined in the first minute (${c2.filter((t) => t === "join").length})`);
  clock += 61_000;
  await b2.tick();
  assert(Object.keys(s2.agents).length === 12, "…the rest a minute later");
}

console.log("4. integration (real agent-office)");
const url = process.env.PAW_OFFICE_TEST_URL;
const admin = process.env.PAW_OFFICE_TEST_ADMIN_KEY;
if (!url || !admin) {
  console.log("  skip  set PAW_OFFICE_TEST_URL=http://127.0.0.1:<port> and PAW_OFFICE_TEST_ADMIN_KEY=<ADMIN_KEY> (agent-office `npm run dev` + its .dev.vars) to run it");
} else {
  const res = await fetch(`${url}/api/offices`, { method: "POST", headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" }, body: JSON.stringify({ name: "paw check:office" }) });
  assert(res.status === 201, `created a throwaway office (${res.status})`);
  const created = (await res.json()) as { joinKey: string; ownerKey: string; viewKey: string };
  const link = makeLink("live", url, created);
  const look = await verifyLink(link);
  assert(look.office?.name === "paw check:office", "verifyLink: office_look with the join, owner and view keys");
  let refused = "";
  try {
    await verifyLink({ ...link, joinKey: `${link.office}.${"z".repeat(43)}` });
  } catch (e) {
    refused = (e as Error).message;
  }
  assert(/refused the join key/.test(refused) && !refused.includes("zzzz"), "verifyLink: a wrong key fails loudly without echoing it");
  const state: BridgeState = { office: link.office, agents: {} };
  const delivered: Array<[string, string]> = [];
  const logs: string[] = [];
  let b = new OfficeBridge({ call: officeClient(link), state, save: () => {}, deliver: async (a, t) => void delivered.push([a, t]), log: (l) => logs.push(l), operator: "tester" });
  b.setRows([row("ada", { mesh: "working", tool: { id: "t", name: "Bash", summary: "" }, hue: 120, emoji: "🦊" }), row("bob", { mesh: "waiting" })]);
  await b.tick();
  const after = (await officeClient(link)("look", {})) as { agents: Array<{ id: string; name: string; status: string; activity?: string; client?: string }> };
  const ada = after.agents.find((a) => a.name === "ada");
  const bob = after.agents.find((a) => a.name === "bob");
  assert(ada?.status === "working" && ada.activity === "Bash · paw" && ada.client === "paw", `ada in the office: working "Bash · paw" (${JSON.stringify(ada)})`);
  assert(bob?.status === "waiting", "bob in the office: waiting");
  // a human chats ada from the owner viewer socket → the next poll delivers it as a paw DM
  const ws = new WebSocket(`${url.replace(/^http/, "ws")}/o/${link.office}/ws`, ["agent-office", `ao-key.${link.ownerKey}`]);
  await new Promise<void>((ok, bad) => {
    ws.onopen = () => ok();
    ws.onerror = () => bad(new Error("viewer socket failed"));
  });
  ws.send(JSON.stringify({ type: "chat", to: ada!.id, text: "hello from the office", as: "mira" }));
  await new Promise((r) => setTimeout(r, 500));
  ws.close();
  for (const a of Object.values(state.agents)) delete a.since; // force the poll now
  (b as unknown as { lastPoll: Map<string, number> }).lastPoll.clear();
  await b.tick();
  assert(delivered.some(([a, t]) => a === "ada" && t === "[agent office] mira: hello from the office"), `office chat → paw DM to ada (${JSON.stringify(delivered)})`);
  b.noteSpeech({ from: "ada", kind: "chat", to: { human: true }, text: "hi mira" });
  await b.tick();
  const chat = (await officeClient(link)("chat_read", { since: 0 }, { token: state.agents.ada!.token })) as { messages: Array<{ from: string; to: string | null; text: string }> };
  assert(chat.messages.some((m) => m.from === ada!.id && m.to === "human:mira" && m.text === "hi mira"), "ada's reply → office chat to human:mira");
  // the operator rotates the join key: tokens survive, the bridge pauses instead of orphaning characters
  const rotated = (await officeClient(link)("rotate-keys", { which: "join" }, { key: link.ownerKey })) as { joinKey?: string };
  assert(typeof rotated.joinKey === "string", "rotated the join key (owner-only rotate-keys)");
  b.setRows([row("ada", { mesh: "idle" }), row("bob", { mesh: "waiting" })]);
  await b.tick();
  assert(Object.keys(state.agents).sort().join() === "ada,bob" && logs.some((l) => /REFUSED THE JOIN KEY/.test(l)), "stale join key → tokens kept, refusal logged (no 'rejoining')");
  const link2 = { ...link, joinKey: rotated.joinKey! };
  b = new OfficeBridge({ call: officeClient(link2), state, save: () => {}, deliver: async () => {}, log: (l) => logs.push(l), operator: "tester" });
  b.setRows([row("ada", { mesh: "idle" }), row("bob", { mesh: "waiting" })]);
  await b.tick();
  const re = (await officeClient(link2)("look", {})) as { agents: Array<{ name: string; status: string }> };
  assert(re.agents.length === 2 && re.agents.find((a) => a.name === "ada")?.status === "idle", `reconnected with the new key: same two characters, ada's change lands (${JSON.stringify(re.agents)})`);
  b.setRows([row("ada", { mesh: "offline", live: false }), row("bob", { mesh: "offline", live: false })]);
  await b.tick();
  const gone = (await officeClient(link2)("look", {})) as { agents: unknown[] };
  assert(gone.agents.length === 0 && Object.keys(state.agents).length === 0, "offline → both walked out");
  assert(!logs.some((l) => l.includes(link.joinKey) || l.includes(link2.joinKey) || l.includes(link.ownerKey!)), "no key in any log line");
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\ncheck:office ok");
