/**
 * Does the REAL `claude --resume` load a transcript the lean harness appended to? Fully offline:
 * the file is copied into a throwaway HOME/CLAUDE_CONFIG_DIR (re-keyed to a temp cwd), claude is
 * pointed at the loopback fake Anthropic API from scripts/lean/, and the request it rebuilds is
 * checked for every marker given (text the lean turns wrote: prompts, tool inputs, results, DMs).
 * Then lean's own reader must see claude's turn. Nothing under the operator's ~/.claude is touched.
 *
 *   node lean/tools/resume-check.ts <lean-binary> <lean-written transcript copy> <marker>…
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { startFake } from "../../scripts/lean/fake-anthropic.ts";
import { projectSlug } from "../../scripts/lean/session.ts";

const [bin, source, ...markers] = process.argv.slice(2);
if (!bin || !source || !markers.length) throw new Error("usage: node lean/tools/resume-check.ts <lean-binary> <transcript> <marker>…");
const claudeBin = process.env.CLAUDE_BIN ?? realpathSync(join(homedir(), ".local/bin/claude"));
const root = realpathSync(mkdtempSync(join(tmpdir(), "lean-resume-")));
const home = join(root, "home");
const config = join(home, ".claude");
const work = join(root, "work");
mkdirSync(work, { recursive: true });
const sessionId = randomUUID();
const projDir = join(config, "projects", projectSlug(work));
mkdirSync(projDir, { recursive: true });
const file = join(projDir, `${sessionId}.jsonl`);
writeFileSync(file, readFileSync(source, "utf8").split("\n").filter(Boolean).map((line) => {
  const r = JSON.parse(line);
  if ("sessionId" in r) r.sessionId = sessionId;
  if ("session_id" in r) r.session_id = sessionId;
  if ("cwd" in r) r.cwd = work;
  return JSON.stringify(r);
}).join("\n") + "\n");

const fake = await startFake(join(root, "requests"), (body) => (body.stream ? "CLAUDE-RESUMED-OK" : "x"));
const env: NodeJS.ProcessEnv = {};
for (const [k, v] of Object.entries(process.env)) if (!/^(CLAUDE|ANTHROPIC|COTAL|PAW|CMUX|OTEL)/.test(k)) env[k] = v;
Object.assign(env, {
  HOME: home, CLAUDE_CONFIG_DIR: config, ANTHROPIC_API_KEY: "sk-ant-api03-fake-for-loopback", ANTHROPIC_BASE_URL: fake.url,
  DISABLE_TELEMETRY: "1", DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_ERROR_REPORTING: "1",
});
let fails = 0;
try {
  const r = await new Promise<{ status: number | null; out: string }>((resolve) => {
    const p = spawn(claudeBin, ["-p", "--resume", sessionId, "--model", "claude-haiku-4-5", "--strict-mcp-config", "RESUME-CHECK"], { cwd: work, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    const t = setTimeout(() => p.kill("SIGTERM"), 120_000);
    p.on("close", (status) => { clearTimeout(t); resolve({ status, out }); });
  });
  const main = fake.requests().find((b) => JSON.stringify(b.messages ?? []).includes("RESUME-CHECK"));
  console.log(`claude exit ${r.status}: ${r.out.trim().slice(0, 200)}`);
  if (!main) throw new Error("claude sent no request carrying the resume prompt");
  const sent = JSON.stringify(main.messages);
  for (const m of markers) {
    const hit = sent.includes(m) || sent.includes(JSON.stringify(m).slice(1, -1));
    console.log(`${hit ? "✓" : "✗"} claude's rebuilt request contains ${JSON.stringify(m.slice(0, 80))}`);
    if (!hit) fails++;
  }
  const back = execFileSync(bin, ["dump", file], { encoding: "utf8", maxBuffer: 1 << 30 });
  const sees = back.includes("RESUME-CHECK") && back.includes("CLAUDE-RESUMED-OK");
  console.log(`${sees ? "✓" : "✗"} lean's reader sees claude's resumed turn`);
  if (!sees) fails++;
} finally {
  await fake.close();
  console.log(`artifacts in ${root}`);
}
process.exit(fails ? 1 : 0);
