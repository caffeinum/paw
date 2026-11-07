/**
 * e2e for beads-y1eg: the PATCHED claude connector (dist/mcp.cjs) reports a turn that ended with background work
 * still running as presence `working` + activity "background: …", and plain `idle` once it is done.
 *
 * Boots an isolated mesh, runs the real mcp.cjs as the child of a process named `claude` (the probe refuses any
 * other parent), feeds it Stop hook events over its control socket, and watches its presence from an observer.
 *
 *   PAW_HOME=$(mktemp -d) PAW_SPACE=test-$$ PAW_RELEASE=dev node scripts/e2e-stop-background.ts
 *
 * PAW_E2E_MCP_CJS=<path> runs another (patched) copy of mcp.cjs; its deps resolve from the installed package.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CotalEndpoint } from "@cotal-ai/core";
import { ensure, stop } from "../src/lifecycle.ts";
import { purgeTestSpace } from "../src/prune.ts";
import { pawServer } from "../src/server.ts";

const space = process.env.PAW_SPACE ?? "";
if (!/^test-/.test(space) || !process.env.PAW_HOME || process.env.PAW_RELEASE !== "dev")
  throw new Error("run isolated: PAW_HOME=$(mktemp -d) PAW_SPACE=test-$$ PAW_RELEASE=dev node scripts/e2e-stop-background.ts");

const pkg = realpathSync(join(import.meta.dirname, "..", "node_modules", "@cotal-ai", "connector-claude-code"));
const mcp = process.env.PAW_E2E_MCP_CJS ?? join(pkg, "dist", "mcp.cjs");
if (!readFileSync(mcp, "utf8").includes("idleOrBackground"))
  throw new Error(`${mcp} is not patched (no idleOrBackground) — run \`pnpm install\` to apply patches/@cotal-ai__connector-claude-code@0.100.0.patch`);

let fails = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) fails++;
};

const dir = mkdtempSync(join(tmpdir(), "paw-stopbg-"));
const transcript = join(dir, "t.jsonl");
const ctl = join(dir, "ctl.sock");
const token = randomBytes(24).toString("hex");
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const rec = (msAgo: number, r: object) => JSON.stringify({ timestamp: iso(msAgo), ...r });

let child: ChildProcess | undefined;
let observer: CotalEndpoint | undefined;
let server: string | undefined;
try {
  await ensure({ needMesh: true, space });
  server = pawServer();
  observer = new CotalEndpoint({ space, servers: server, card: { name: "stopbg-observer", kind: "endpoint", id: `observer${process.pid}` }, registerPresence: false, consume: false, watchPresence: true });
  await observer.start();

  // `claude` = a symlink to node, so the mcp's parent's command basename is `claude`; it just runs the mcp.
  const fakeClaude = join(dir, "claude");
  symlinkSync(process.execPath, fakeClaude);
  const parentJs = join(dir, "parent.cjs");
  writeFileSync(parentJs, `const c = require("node:child_process").spawn(process.execPath, [${JSON.stringify(mcp)}], { stdio: ["pipe", "ignore", "inherit"] });
process.stdin.pipe(c.stdin); c.on("exit", (code) => process.exit(code ?? 1));`);
  writeFileSync(transcript, "");
  child = spawn(fakeClaude, [parentJs], {
    stdio: ["pipe", "ignore", "inherit"],
    env: {
      // never this process's own COTAL_* (run from inside an agent, they are that agent's identity)
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("COTAL_"))),
      NODE_PATH: dirname(dirname(pkg)), // the pnpm virtual-store node_modules holding the connector's deps
      COTAL_NAME: "stopbg-agent",
      COTAL_SPACE: space,
      COTAL_SERVERS: server,
      COTAL_SUBSCRIBE: "general",
      COTAL_ALLOW_SUBSCRIBE: ">",
      COTAL_ALLOW_PUBLISH: ">",
      COTAL_CONTROL_SOCKET: ctl,
      COTAL_CONTROL_TOKEN: token,
      COTAL_TELEMETRY_DISABLED: "1",
      PAW_BACKGROUND_PROBE: join(import.meta.dirname, "..", "src", "background-scan.ts"),
    },
  });

  const presence = () => observer!.getRoster().find((p) => p.card.name === "stopbg-agent") as { status?: string; activity?: string } | undefined;
  const waitFor = async (what: string, pred: (p: ReturnType<typeof presence>) => boolean, ms = 20_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (pred(presence())) return true;
      await new Promise((r) => setTimeout(r, 250));
    }
    console.error(`  timed out waiting for ${what}; presence = ${JSON.stringify(presence())}`);
    return false;
  };
  const hook = (event: object) =>
    new Promise<void>((resolve, reject) => {
      const s = connect(ctl, () => s.write(JSON.stringify({ token, event }) + "\n"));
      s.on("data", () => s.end());
      s.on("close", () => resolve());
      s.on("error", reject);
    });

  ok("the agent joins the mesh", await waitFor("join", (p) => p !== undefined));
  await hook({ hook_event_name: "UserPromptSubmit", transcript_path: transcript });
  ok("a prompt → working", await waitFor("working", (p) => p?.status === "working"));

  // the turn launches a Workflow + an async Agent, then ends (dated after the fake claude started: the probe
  // ignores anything older, as a previous incarnation's)
  await new Promise((r) => setTimeout(r, 2500));
  writeFileSync(transcript, [
    rec(400, { type: "user", toolUseResult: { status: "async_launched", taskId: "w1", taskType: "local_workflow", workflowName: "x" } }),
    rec(300, { type: "user", toolUseResult: { isAsync: true, status: "async_launched", agentId: "a1" } }),
  ].join("\n") + "\n");
  await hook({ hook_event_name: "Stop", transcript_path: transcript });
  ok("Stop with background open → working + 'background: workflow + subagent'", await waitFor("background", (p) => p?.status === "working" && p?.activity === "background: workflow + subagent"), JSON.stringify(presence()));

  // both finish: their notifications start a turn that ends in another Stop
  writeFileSync(transcript, readFileSync(transcript, "utf8") + [
    rec(200, { type: "user", message: { content: "<task-notification>\n<task-id>w1</task-id>\n<status>completed</status>\n</task-notification>" } }),
    rec(100, { type: "user", message: { content: "<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n</task-notification>" } }),
  ].join("\n") + "\n");
  await hook({ hook_event_name: "Stop", transcript_path: transcript });
  ok("Stop after everything finished → idle, the background line cleared", await waitFor("idle", (p) => p?.status === "idle" && !p?.activity), JSON.stringify(presence()));

  // background again, then a NEW prompt: working, and the stale background line must not ride along
  writeFileSync(transcript, readFileSync(transcript, "utf8") + rec(0, { type: "user", toolUseResult: { status: "async_launched", taskId: "w2", taskType: "local_workflow", workflowName: "y" } }) + "\n");
  await hook({ hook_event_name: "Stop", transcript_path: transcript });
  ok("background again → working + 'background: workflow'", await waitFor("background 2", (p) => p?.status === "working" && p?.activity === "background: workflow"), JSON.stringify(presence()));
  await hook({ hook_event_name: "UserPromptSubmit", transcript_path: transcript });
  ok("a new prompt → working with the background line cleared", await waitFor("cleared", (p) => p?.status === "working" && !p?.activity), JSON.stringify(presence()));
} finally {
  child?.kill("SIGTERM");
  await observer?.stop().catch(() => {});
  await stop({ space }).catch((e) => console.error(`teardown: ${(e as Error).message}`));
  if (server) await purgeTestSpace(space, server).catch((e) => console.error(`purge: ${(e as Error).message}`));
}
console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
