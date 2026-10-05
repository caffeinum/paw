// Round-trip proof that the lean harness and the real `claude` share one session file, fully
// offline: no API key, no subscription usage, nothing under the operator's ~/.claude touched.
//
//   node scripts/lean/roundtrip.ts [<source transcript.jsonl>]
//
// 1. COPIES the source transcript (read-only) into a throwaway HOME + CLAUDE_CONFIG_DIR, re-keyed
//    to a fresh session id and a temp cwd.
// 2. `claude --bare -p --resume` (the real binary, pointed at a loopback fake API) — captures the
//    messages claude rebuilt from the TUI-written file and compares them with the lean reader's.
// 3. The lean harness continues the session one turn (incl. a Bash tool call) against the fake.
// 4. `claude --resume` again — the captured request must contain the lean turn, and claude's new
//    records must chain onto the lean leaf.
// 5. The lean reader loads the file again and must see claude's turn.
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { startFake } from "./fake-anthropic.ts";
import { activeChain, leafOf, projectSlug, readRecords, toMessages, type ApiMessage } from "./session.ts";
import { continueSession } from "./continue.ts";

const MODEL = "claude-haiku-4-5";
const source = process.argv.slice(2).find((a) => !a.startsWith("--"));
// --full drops claude's --bare: the real system prompt, tools and context attachments, read from a
// throwaway HOME (no operator settings, plugins, hooks or MCP servers).
const BARE = !process.argv.includes("--full");
if (!source) throw new Error("usage: node scripts/lean/roundtrip.ts <source transcript.jsonl>  (it is copied, never modified)");
const claudeBin = process.env.CLAUDE_BIN ?? realpathSync(join(homedir(), ".local/bin/claude"));

const root = realpathSync(mkdtempSync(join(tmpdir(), "lean-rt-")));
const home = join(root, "home");
const config = join(home, ".claude");
const work = join(root, "work");
mkdirSync(work, { recursive: true });
execFileSync("git", ["init", "-q", "-b", "main"], { cwd: work });
const sessionId = randomUUID();
const projDir = join(config, "projects", projectSlug(work));
mkdirSync(projDir, { recursive: true });
const file = join(projDir, `${sessionId}.jsonl`);

// 1. copy + re-key
const oldId = readRecords(source).find((r) => r.sessionId)?.sessionId;
const rekeyed = readFileSync(source, "utf8").split("\n").filter(Boolean).map((line) => {
  const r = JSON.parse(line);
  if ("sessionId" in r) r.sessionId = sessionId;
  if ("session_id" in r) r.session_id = sessionId;
  if ("cwd" in r) r.cwd = work;
  return JSON.stringify(r);
});
writeFileSync(file, rekeyed.join("\n") + "\n");
copyFileSync(file, join(root, "original-copy.jsonl"));
console.log(`temp root ${root}\nsession ${sessionId} (copied from ${oldId})`);

const fake = await startFake(join(root, "requests"), (body, n) => {
  if (body.stream) return "CLAUDE-SAW-IT";
  return n === 1 || !JSON.stringify(body.messages).includes("lean-tool-ran")
    ? [{ type: "tool_use", id: `toolu_lean_${n}`, name: "Bash", input: { command: "echo lean-tool-ran" } }]
    : "LEAN-DONE";
});

function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(CLAUDE|ANTHROPIC|COTAL|PAW|CMUX|OTEL)/.test(k)) continue; // no harness markers, no live mesh
    env[k] = v;
  }
  return {
    ...env, HOME: home, CLAUDE_CONFIG_DIR: config, ANTHROPIC_API_KEY: "sk-ant-api03-fake-for-loopback",
    ANTHROPIC_BASE_URL: fake.url, DISABLE_TELEMETRY: "1", DISABLE_AUTOUPDATER: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_ERROR_REPORTING: "1",
  };
}

/** Run the real claude, resuming the copy; return the main request it sent (the one carrying our prompt). */
// Async on purpose: the fake API lives in this process, so a sync spawn would deadlock it.
function run(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(claudeBin, args, { cwd: work, env: cleanEnv(), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    const t = setTimeout(() => p.kill("SIGTERM"), 120_000);
    p.on("close", (status) => { clearTimeout(t); resolve({ status, stdout, stderr }); });
  });
}

async function claudeResume(prompt: string): Promise<any> {
  const before = fake.requests().length;
  const r = await run([...(BARE ? ["--bare"] : []), "-p", "--resume", sessionId, "--model", MODEL, "--strict-mcp-config", prompt]);
  if (r.status !== 0) throw new Error(`claude exited ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  const main = fake.requests().slice(before).find((b) => JSON.stringify(b.messages).includes(prompt));
  if (!main) throw new Error(`claude sent no request carrying "${prompt}" (stdout: ${r.stdout.trim()})`);
  console.log(`  claude stdout: ${r.stdout.trim()}`);
  return main;
}

function textOf(m: ApiMessage): string {
  return typeof m.content === "string" ? m.content : m.content.map((b) => b.text ?? b.thinking ?? (b.type === "tool_result" ? JSON.stringify(b.content) : b.type === "tool_use" ? `${b.name}${JSON.stringify(b.input)}` : `[${b.type}]`)).join("\n");
}

/**
 * What the model sees, modulo two things that don't change it: consecutive same-role turns (the
 * API concatenates them) and thinking blocks (claude drops them when the resuming model differs
 * from the one that signed them — this test resumes with haiku). Block types per role-turn.
 */
function shape(ms: ApiMessage[]): string[] {
  const out: { role: string; types: string[] }[] = [];
  for (const m of ms) {
    const types = (typeof m.content === "string" ? ["text"] : m.content.map((b) => b.type)).filter((t) => t !== "thinking" && t !== "redacted_thinking");
    if (!types.length) continue;
    const prev = out[out.length - 1];
    if (prev?.role === m.role) prev.types.push(...types);
    else out.push({ role: m.role, types });
  }
  return out.map((t) => `${t.role}:${t.types.join("+")}`);
}

function compare(label: string, lean: ApiMessage[], claude: ApiMessage[]): boolean {
  const ls = shape(lean), cs = shape(claude);
  const toolIds = (ms: ApiMessage[]) => ms.flatMap((m) => (typeof m.content === "string" ? [] : m.content.filter((b) => b.type === "tool_use").map((b) => b.id)));
  const sameTools = JSON.stringify(toolIds(lean)) === JSON.stringify(toolIds(claude));
  const cText = claude.map(textOf).join("\n");
  const missing = lean.flatMap((m) => (typeof m.content === "string" ? [m.content] : m.content.filter((b) => b.type === "text").map((b) => b.text)))
    .filter((t) => t.length > 20).filter((t) => !cText.includes(t.slice(0, 200))).length;
  const sameShape = JSON.stringify(ls) === JSON.stringify(cs);
  console.log(`${label}: ${ls.length} turns (lean) vs ${cs.length} (claude); same turn/block shape: ${sameShape}; same tool_use ids in order: ${sameTools}; lean text blocks absent from claude's request: ${missing}`);
  if (!sameShape) {
    const i = ls.findIndex((x, k) => x !== cs[k]);
    console.log(`  first difference at turn ${i}:\n   lean   ${ls.slice(i, i + 4).join(" | ")}\n   claude ${cs.slice(i, i + 4).join(" | ")}`);
  }
  return sameShape && sameTools;
}

try {
  // 2. read parity on the TUI-written file
  const lean0 = toMessages(activeChain(readRecords(file), leafOf(readRecords(file))));
  const req1 = await claudeResume("RT-PHASE-A");
  writeFileSync(join(root, "claude-phase-a.json"), JSON.stringify(req1, null, 1));
  const parityA = compare("read parity (TUI-written file)", lean0, req1.messages.slice(0, -1));

  // 3. lean continues (against the same loopback fake; a real key is never needed here)
  process.env.ANTHROPIC_API_KEY = "sk-ant-api03-fake-for-loopback";
  process.env.ANTHROPIC_BASE_URL = fake.url;
  const before = readRecords(file).length;
  const answer = await continueSession(file, "RT-LEAN-TURN please run the tool", MODEL);
  const added = readRecords(file).slice(before);
  console.log(`lean turn: answered "${answer}", appended ${added.length} records (${added.map((r) => r.type).join(", ")})`);
  const leanLeaf = leafOf(readRecords(file)).uuid;
  const leanView = toMessages(activeChain(readRecords(file), leafOf(readRecords(file))));

  // 4. claude resumes the lean-written turn
  const req2 = await claudeResume("RT-PHASE-B");
  writeFileSync(join(root, "claude-phase-b.json"), JSON.stringify(req2, null, 1));
  const sent = JSON.stringify(req2.messages);
  const checks = {
    "lean prompt": sent.includes("RT-LEAN-TURN"),
    "lean tool_use": sent.includes('"command":"echo lean-tool-ran"'),
    "lean tool_result": sent.includes("lean-tool-ran"),
    "lean final text": sent.includes("LEAN-DONE"),
  };
  console.log("claude --resume sees the lean turn:", checks);
  const after = readRecords(file);
  const firstClaude = after.slice(before + added.length).find((r) => r.uuid && r.type === "user" && JSON.stringify(r.message).includes("RT-PHASE-B"));
  console.log(`claude's new prompt record chains onto the lean leaf: ${firstClaude?.parentUuid === leanLeaf} (parent ${firstClaude?.parentUuid?.slice(0, 8)}, lean leaf ${leanLeaf?.slice(0, 8)})`);

  // 5. lean reads claude's turn back
  const lean2 = toMessages(activeChain(after, leafOf(after)));
  const back = JSON.stringify(lean2);
  const readsBack = back.includes("RT-PHASE-B") && back.includes("CLAUDE-SAW-IT");
  console.log(`lean reader sees claude's turn: ${readsBack}`);
  const parityB = compare("read parity (lean-written file)", leanView, req2.messages.slice(0, -1));
  // Two verdicts. INTEROP (hard): each side loads the other's turns. PARITY (soft): the lean reader
  // rebuilt exactly the turns claude sent — it diverges on attachments written by claude <2.1.280,
  // which carry no pre-rendered text (see docs/notes/lean-harness.md#attachments).
  const interop = Object.values(checks).every(Boolean) && firstClaude?.parentUuid === leanLeaf && readsBack;
  console.log(`INTEROP ${interop ? "OK" : "FAILED"} · READ PARITY ${parityA && parityB ? "EXACT" : "DIVERGES (see above)"}`);
  process.exitCode = interop ? 0 : 1;
} finally {
  await fake.close();
  console.log(`artifacts kept in ${root}`);
}
