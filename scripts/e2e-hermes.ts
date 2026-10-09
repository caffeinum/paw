/**
 * END-TO-END: an `agent: hermes` persona on a REAL, ISOLATED mesh — cotal's Hermes connector run by
 * paw's manager in paw's own Hermes profile, against a FAKE OpenAI-compatible model (no provider
 * credentials spent, the operator's ~/.hermes never read or written).
 *
 *   1 `paw start` of a hermes agent comes up (uv-provisioned hermes-agent, gateway + cotal plugin)
 *   2 the profile is paw's: $PAW_HOME/hermes/profiles/<space>-<name>, config.yaml from the persona
 *   3 `paw status` shows it live with harness hermes (json) and "(hermes)" in the table
 *   4 a DM gets a reply (the fake model echoes the word back)
 *   5 `paw stop` takes it down; `paw start` revives it in the SAME profile (sessions kept); DM again
 *   6 `paw log` fails loud, naming the profile
 *
 *   PAW_HOME=$(mktemp -d) PAW_SPACE=hermes-test-$$ PAW_RELEASE=dev PAW_COTAL_ROOT=$(mktemp -d) PAW_BEADS_DIR=$(mktemp -d) \
 *     node scripts/e2e-hermes.ts
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const space = process.env.PAW_SPACE ?? "";
if (!process.env.PAW_HOME || !space.startsWith("hermes-test-") || process.env.PAW_RELEASE !== "dev" || !process.env.PAW_COTAL_ROOT || !process.env.PAW_BEADS_DIR)
  throw new Error("isolated run only: PAW_HOME, PAW_SPACE=hermes-test-*, PAW_RELEASE=dev, PAW_COTAL_ROOT, PAW_BEADS_DIR");
const REPO = fileURLToPath(new URL("..", import.meta.url));

const freePort = () =>
  new Promise<number>((r) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => r(p));
    });
  });

// ── the fake model: OpenAI chat.completions, streaming or not; echoes the last MARK-* word it was sent ──
const llmCalls: string[] = [];
const reply = (body: { messages?: Array<{ role: string; content: unknown }> }): string => {
  const text = JSON.stringify(body.messages ?? []);
  const marks = text.match(/MARK-[A-Z0-9]+/g);
  return marks ? `pong ${marks[marks.length - 1]}` : "ok";
};
const llm = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    llmCalls.push(`${req.method} ${req.url}`);
    if (req.url?.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "fake-model", object: "model", context_length: 200000 }] }));
      return;
    }
    const body = raw ? JSON.parse(raw) : {};
    const content = reply(body);
    const id = `chatcmpl-${Date.now()}`;
    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta: object, finish: string | null) =>
        res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 0, model: "fake-model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
      chunk({ role: "assistant", content }, null);
      chunk({}, "stop");
      res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 0, model: "fake-model", choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\n`);
      res.end("data: [DONE]\n\n");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id, object: "chat.completion", created: 0, model: "fake-model", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }));
  });
});
const llmPort = await freePort();
await new Promise<void>((r) => llm.listen(llmPort, "127.0.0.1", () => r()));

const port = await freePort();
process.env.PAW_SERVER = `nats://127.0.0.1:${port}`;
process.env.PAW_RUNTIME = "pty";
process.env.OPENAI_API_KEY = "sk-fake-e2e"; // the custom endpoint's key; the manager forwards OPENAI_API_KEY to the seat
delete process.env.PAW_COTAL_HUB;
const nats = spawn("nats-server", ["-js", "-p", String(port), "-a", "127.0.0.1", "-sd", mkdtempSync(join(tmpdir(), "hermesjs-"))], { stdio: "ignore" });

const { CotalEndpoint } = await import("@cotal-ai/core");
const { removeMesh } = await import("@cotal-ai/workspace");
const { stop, managerProcs, mailboxProcs } = await import("../src/lifecycle.ts");
const { ensurePersonaFile, setFolderName, setPersonaKeys } = await import("../src/addressing.ts");
const { hermesHomeFor } = await import("../src/hermes-profile.ts");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) fails++;
};
const until = async <T>(fn: () => T | undefined | Promise<T | undefined>, ms: number, every = 500): Promise<T | undefined> => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(every)) {
    const v = await fn();
    if (v) return v;
  }
  return undefined;
};
const paw = (...args: string[]) => {
  const r = spawnSync(process.execPath, [join(REPO, "bin/paw.mjs"), ...args, "--space", space], { env: process.env, encoding: "utf8", timeout: 600_000 });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
};
const tail = (s: string, n = 4) => s.trim().split("\n").slice(-n).join(" | ");
type Row = { name: string; live?: boolean; mesh?: string; harness?: string };
let statusErr = "";
const statusRow = (name: string): Row | undefined => {
  const r = paw("status", "--json");
  try {
    return (JSON.parse(r.out) as { rows: Row[] }).rows.find((x) => x.name === name);
  } catch (e) {
    statusErr = `${(e as Error).message}: ${tail(r.err)} ${r.out.slice(0, 200)}`;
    return undefined;
  }
};
const inbox: Array<{ from: string; text: string }> = [];
let prober: InstanceType<typeof CotalEndpoint> | undefined;
const H = "herm";
try {
  await until(() => spawnSync("nc", ["-z", "127.0.0.1", String(port)]).status === 0 || undefined, 10_000, 100);

  const folder = realpathSync(mkdtempSync(join(tmpdir(), "hermes-agent-")));
  setFolderName(space, folder, H);
  ensurePersonaFile(space, H, { brief: `You are ${H}, a test agent.` });
  setPersonaKeys(space, H, { agent: "hermes", provider: "custom", model: "fake-model", baseUrl: `http://127.0.0.1:${llmPort}/v1`, shareTools: "none" });
  const home = hermesHomeFor(undefined, space, H);

  // ── 1-2 up, in paw's own profile ─────────────────────────────────────────────────────────────
  const st = paw("start", H);
  ok("paw start of an agent: hermes persona", st.code === 0, tail(st.out + st.err));
  const rowUp = await until(() => (statusRow(H)?.live && statusRow(H)?.mesh === "idle" ? statusRow(H) : undefined), 180_000, 2000);
  ok("…live + idle on the mesh", !!rowUp, JSON.stringify(statusRow(H)) + statusErr);
  ok("profile is paw's: $PAW_HOME/hermes/profiles/<space>-<name>", home === join(process.env.PAW_HOME!, "hermes", "profiles", `${space}-${H}`) && existsSync(home), home);
  const cfg = existsSync(join(home, "config.yaml")) ? readFileSync(join(home, "config.yaml"), "utf8") : "";
  ok("config.yaml: model + provider + base_url from the persona, cotal on, approvals off", /default: "fake-model"/.test(cfg) && /provider: "custom"/.test(cfg) && cfg.includes(`127.0.0.1:${llmPort}`) && /enabled: \[cotal\]/.test(cfg) && /mode: "off"/.test(cfg));
  ok("SOUL.md carries the persona body + paw's brief", /a test agent/.test(readFileSync(join(home, "SOUL.md"), "utf8")) && /running on Hermes/.test(readFileSync(join(home, "SOUL.md"), "utf8")));
  ok("the operator's ~/.hermes was not the profile", !home.startsWith(join(process.env.HOME!, ".hermes")));

  // ── 3 status ─────────────────────────────────────────────────────────────────────────────────
  ok("paw status --json: harness hermes", statusRow(H)?.harness === "hermes", JSON.stringify(statusRow(H)));
  const table = paw("status").out;
  ok("paw status table: the row names its harness", table.split("\n").some((l) => l.includes(H) && l.includes("(hermes)")), tail(table, 3));

  // ── 4 DM → reply ─────────────────────────────────────────────────────────────────────────────
  prober = new CotalEndpoint({ space, servers: process.env.PAW_SERVER!, channels: ["general"], consume: true, registerPresence: true, watchPresence: true, card: { name: "prober", kind: "endpoint", id: "prober" } });
  prober.on("error", () => {});
  prober.on("message", (m: { from?: { name?: string }; parts?: Array<{ text?: string }> }, d: { ack(): void }) => {
    inbox.push({ from: m.from?.name ?? "?", text: (m.parts ?? []).map((p) => p.text ?? "").join(" ") });
    d.ack();
  });
  await prober.start();
  const dmAndWait = async (word: string) => {
    const pr = await until(() => prober!.getRoster().find((p) => p.card.name === H && p.status !== "offline"), 60_000, 200);
    if (!pr) return undefined;
    await prober!.unicast(pr.card.id, `reply with exactly: ${word}`);
    return until(() => inbox.find((m) => m.from === H && m.text.includes(word)), 120_000, 300);
  };
  const r1 = await dmAndWait("MARK-ONE");
  ok("a DM gets a reply from the hermes agent", !!r1, r1 ? JSON.stringify(r1) : `inbox=${JSON.stringify(inbox)} llm=${llmCalls.length}`);

  // ── 5 stop → start revives in the same profile ──────────────────────────────────────────────
  const sp = paw("stop", H);
  ok("paw stop", sp.code === 0, tail(sp.out + sp.err));
  const down = await until(() => (statusRow(H)?.live === false ? true : undefined), 60_000, 1000);
  ok("…it is down", !!down, JSON.stringify(statusRow(H)));
  ok("…and its profile survives the stop (sessions kept)", existsSync(join(home, "state.db")) || existsSync(join(home, "sessions")));
  const st2 = paw("start", H);
  ok("paw start revives it", st2.code === 0, tail(st2.out + st2.err));
  const rowUp2 = await until(() => (statusRow(H)?.live && statusRow(H)?.mesh === "idle" ? statusRow(H) : undefined), 180_000, 2000);
  ok("…live + idle again", !!rowUp2, JSON.stringify(statusRow(H)));
  await sleep(2000);
  const r2 = await dmAndWait("MARK-TWO");
  ok("a DM after the revival gets a reply", !!r2, r2 ? JSON.stringify(r2) : `inbox=${JSON.stringify(inbox.slice(-3))}`);

  // ── 6 paw log ────────────────────────────────────────────────────────────────────────────────
  const lg = paw("log", H);
  ok("paw log fails loud, naming the profile", lg.code !== 0 && lg.err.includes("hermes agent") && lg.err.includes(home), tail(lg.err));
} finally {
  await prober?.stop().catch(() => {});
  await stop({ space }).catch((e) => console.error("stop:", (e as Error).message));
  await sleep(2000);
  ok("down: manager + mailbox gone", managerProcs(space).length === 0 && mailboxProcs(space).length === 0);
  removeMesh(space);
  nats.kill("SIGTERM");
  llm.close();
}
console.log(fails ? `\n${fails} FAILED` : "\ne2e passed");
process.exit(fails ? 1 : 0);
