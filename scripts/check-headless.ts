/**
 * Hermetic checks for headless agents (docs/notes/headless.md): no broker, no claude.
 *
 *  - headlessLaunch: the TUI launch becomes `sh -c … claude -p stream-json …`, keeps the mesh marker
 *    flag and the session pin, drops `confirm`, refuses a prompt and a clashing claudeArgs flag;
 *  - HEADLESS_SH really makes the FIFO, rotates out.jsonl and execs with stdin/stdout wired (a fake
 *    "claude" that echoes stdin to stdout);
 *  - readHeadless parses true/false/absent and throws on garbage;
 *  - the hub driver over a real FIFO: a push becomes a stream-json turn, pushes during a turn are held
 *    and coalesced into ONE turn after the `result` line, a stale FIFO with no reader is not headless.
 */
import { spawn } from "node:child_process";
import { appendFileSync, closeSync, constants, mkdtempSync, openSync, readFileSync, readSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const { headlessLaunch, HEADLESS_SH } = await import("../src/headless.ts");
const { readHeadless } = await import("../src/session.ts");
const { channelPush, createHeadlessDriver, hasReader, headlessDirFor, isResult, wakeTurn } = await import("../src/hub/headless.mjs");

let fails = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) fails++;
};
const throws = (f: () => unknown, re: RegExp) => {
  try {
    f();
    return false;
  } catch (e) {
    return re.test((e as Error).message);
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tmp = mkdtempSync(join(tmpdir(), "pawhl-"));

// ── headlessLaunch ────────────────────────────────────────────────────────────────────────────
const tui = {
  command: "/x/claude",
  args: ["--dangerously-load-development-channels", "server:cotal", "--plugin-dir", "/p", "--resume", "abc", "--model", "haiku"],
  env: { COTAL_NAME: "a" },
  confirm: "WARNING: Loading development channels",
  control: { path: "/c", token: "t" },
};
const hl = headlessLaunch(tui, "/d/a");
ok("command is /bin/sh -c HEADLESS_SH", hl.command === "/bin/sh" && hl.args[0] === "-c" && hl.args[1] === HEADLESS_SH);
ok("then $0, the dir, the claude binary", hl.args[2] === "paw-headless" && hl.args[3] === "/d/a" && hl.args[4] === "/x/claude");
const cargs = hl.args.slice(5);
ok("claude gets -p stream-json in/out + --verbose", cargs.join(" ").startsWith("-p --input-format stream-json --output-format stream-json --verbose"));
ok("keeps the dev-channels flag (named.ts mesh marker) and the resume pin", cargs.includes("--dangerously-load-development-channels") && cargs.join(" ").includes("--resume abc"));
ok("drops confirm, keeps env + control", hl.confirm === undefined && hl.env?.COTAL_NAME === "a" && hl.control?.token === "t");
ok("refuses an initial prompt", throws(() => headlessLaunch({ ...tui, args: ["hello", ...tui.args] }, "/d"), /initial prompt/));
ok("refuses a claudeArgs -p", throws(() => headlessLaunch({ ...tui, args: [...tui.args, "-p"] }, "/d"), /sets -p itself/));
ok("refuses a launch without the mesh marker", throws(() => headlessLaunch({ ...tui, args: ["--model", "x"] }, "/d"), /dev-channels/));

// ── HEADLESS_SH for real (a fake claude: cat) ─────────────────────────────────────────────────
{
  const d = join(tmp, "sh", "agent");
  const run = () => spawn("/bin/sh", ["-c", HEADLESS_SH, "paw-headless", d, "/bin/cat"], { stdio: ["ignore", "ignore", "inherit"] });
  const p1 = run();
  for (let i = 0; i < 40 && !hasReader(d); i++) await sleep(50);
  ok("HEADLESS_SH made the FIFO and the exec'd process reads it", existsSync(join(d, "in")) && statSync(join(d, "in")).isFIFO() && hasReader(d));
  const fd = openSync(join(d, "in"), constants.O_WRONLY | constants.O_NONBLOCK);
  appendFileSync(fd, "line-1\n");
  closeSync(fd);
  await sleep(200);
  ok("stdin → stdout (out.jsonl) wiring", readFileSync(join(d, "out.jsonl"), "utf8") === "line-1\n");
  ok("a writer closing is not EOF (the process holds its own writer)", p1.exitCode === null);
  p1.kill("SIGTERM");
  await sleep(200);
  ok("no reader once it exits — a stale FIFO is not a headless agent", !hasReader(d));
  const p2 = run();
  for (let i = 0; i < 40 && !hasReader(d); i++) await sleep(50);
  ok("relaunch rotates the old output to out.prev.jsonl", readFileSync(join(d, "out.prev.jsonl"), "utf8") === "line-1\n" && readFileSync(join(d, "out.jsonl"), "utf8") === "");
  p2.kill("SIGTERM");
}

// ── readHeadless ──────────────────────────────────────────────────────────────────────────────
const persona = (v?: string) => {
  const f = join(tmp, `p${Math.random()}.md`);
  writeFileSync(f, `---\nname: a\n${v === undefined ? "" : `headless: ${v}\n`}---\nbody\n`);
  return f;
};
ok("readHeadless: absent ⇒ false, true ⇒ true, false ⇒ false", readHeadless(persona()) === false && readHeadless(persona("true")) === true && readHeadless(persona("false")) === false);
ok("readHeadless: garbage throws", throws(() => readHeadless(persona("yes")), /expected true or false/));

// ── pure hub helpers ──────────────────────────────────────────────────────────────────────────
const push = { content: "📨 New DM from x — delivering your Cotal inbox now.", meta: { kind: "dm", from: 'x"<y>' } };
const turn = JSON.parse(wakeTurn(push));
ok("wakeTurn: a stream-json user turn wrapping the push", turn.type === "user" && turn.message.role === "user" && turn.message.content.includes(push.content) && turn.message.content.startsWith('<channel source="cotal" kind="dm" from="x&#34;&#60;y&#62;">'));
ok("wakeTurn: refuses an empty push", throws(() => wakeTurn({ content: "" }), /without content/));
ok("channelPush: finds the notification", channelPush(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/claude/channel", params: push })}\n`)?.content === push.content);
ok("channelPush: ignores other MCP output", channelPush('{"jsonrpc":"2.0","id":1,"result":{}}\n') === undefined && channelPush(Buffer.from("x")) === undefined);
ok("headlessDirFor: refuses unsafe names", headlessDirFor("/s", "../x") === undefined && headlessDirFor("/s", "a/b") === undefined && headlessDirFor("/s", "ok-1") === "/s/headless/ok-1");

ok(
  "isResult: any key order, never a substring in content, never a partial line",
  isResult('{"duration_api_ms":1,"type":"result"}') && !isResult(JSON.stringify({ type: "user", c: '"type":"result"' })) && !isResult('{"type":"result"'),
);

// ── the driver over a real FIFO ───────────────────────────────────────────────────────────────
{
  const d = join(tmp, "drv");
  execFileSync("mkdir", ["-p", d]);
  execFileSync("mkfifo", [join(d, "in")]);
  writeFileSync(join(d, "out.jsonl"), '{"type":"result","subtype":"success"}\n'); // history: must not count
  const rd = openSync(join(d, "in"), constants.O_RDWR | constants.O_NONBLOCK); // the "claude"
  const drain = (): string[] => {
    const b = Buffer.alloc(65536);
    try {
      const n = readSync(rd, b, 0, b.length, null);
      return b.subarray(0, n).toString("utf8").split("\n").filter(Boolean);
    } catch {
      return [];
    }
  };
  const logs: string[] = [];
  const drv = createHeadlessDriver({ dir: d, name: "drv", log: (m: string) => logs.push(m) });
  drv.push(push);
  let got = drain();
  ok("idle: a push is written at once as one turn", got.length === 1 && JSON.parse(got[0]!).message.content.includes("New DM from x"), JSON.stringify(drv.state()));
  drv.push({ content: "second", meta: { kind: "dm" } });
  drv.push({ content: "third", meta: { kind: "dm" } });
  ok("busy: later pushes are held, not written", drain().length === 0 && drv.state().held === 2);
  appendFileSync(join(d, "out.jsonl"), `${JSON.stringify({ type: "assistant", message: { content: '{"type":"result"}' } })}\n`);
  await sleep(800);
  ok('a quoted "type":"result" inside content is not a turn end', drain().length === 0 && drv.state().held === 2);
  // claude 2.1.289 writes result lines with `duration_api_ms` first — key order is not stable
  appendFileSync(join(d, "out.jsonl"), `${JSON.stringify({ duration_api_ms: 13765, stop_reason: "end_turn", type: "result", subtype: "success", result: "ok 📨" })}\n`);
  await sleep(800);
  got = drain();
  ok("turn end: the held pushes go out as ONE coalesced turn", got.length === 1 && JSON.parse(got[0]!).message.content.includes("2 Cotal wakes"), got.join(" | "));
  ok("…and that turn is now the busy one", drv.state().busy && drv.state().held === 0);
  // a long partial line straddling reads, then a result
  appendFileSync(join(d, "out.jsonl"), `{"type":"result","x":"${"z".repeat(600_000)}"`);
  drv.push({ content: "fourth", meta: { kind: "dm" } });
  await sleep(700);
  appendFileSync(join(d, "out.jsonl"), `}\n`);
  await sleep(700);
  ok("a 600KB line (split across polls) is never a turn end", drain().length === 0 && drv.state().held === 1);
  appendFileSync(join(d, "out.jsonl"), '{"subtype":"success","type":"result"}\n');
  await sleep(800);
  got = drain();
  ok("…and doesn't hide the result after it", got.length === 1 && JSON.parse(got[0]!).message.content.includes("fourth"), got.join(" | "));
  drv.close();
  closeSync(rd);
  // no reader: a write fails loud in the log and the wake stays held (retried after 5s, not spammed)
  writeFileSync(join(d, "out.jsonl"), "");
  const drv2 = createHeadlessDriver({ dir: d, name: "drv2", log: (m: string) => logs.push(m) });
  drv2.push(push);
  await sleep(1200);
  ok("no reader: logged once, held for retry", logs.filter((l) => l.includes("drv2") && l.includes("ENXIO")).length === 1 && drv2.state().held === 1, logs.join(" | "));
  drv2.close();
}

console.log(fails ? `${fails} FAILED` : "check:headless passed");
process.exit(fails ? 1 : 0);
