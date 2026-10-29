/**
 * e2e: paw chat's instant UI under a real pty, in an ISOLATED space (refuses anything else).
 *
 *   PAW_HOME=$(mktemp -d) PAW_SPACE=test-$$ PAW_RELEASE=dev node scripts/check-chat-tty.ts
 *
 * A raw CotalEndpoint peer `echoer` records every DM and #general post it gets. Then `paw chat`:
 *   1. a line typed BEFORE the prompt and one typed once it shows are both queued, then delivered to
 *      echoer exactly once each, in order — and nothing reaches #general;
 *   2. `@ghost hi` typed before ready says "no peer named ghost" and posts nothing;
 *   3. `paw chat nosuch` + an early line: the line is refused and kept (✕ not sent … text kept), the
 *      process stays up, /quit leaves, #general stays silent;
 *   4. echoer DMs "you" the moment its presence appears: the DM renders (listeners attach before connect);
 *   5. Ctrl-C at +80ms and at +400ms: exits within the startup-settle bound, bracketed paste turned off,
 *      a line queued before the quit is printed in full;
 *   6. pipe mode (`… | paw chat echoer`) delivers once — today's order, unchanged.
 */
import { spawn as ptySpawn } from "@lydell/node-pty";
import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CotalEndpoint, type CotalMessage, type Delivery, type MessageMeta } from "@cotal-ai/core";
import { controlCreds } from "../src/addressing.ts";
import { purgeTestSpace } from "../src/prune.ts";
import { ensure, stop } from "../src/lifecycle.ts";
import { pawServer } from "../src/server.ts";

const home = process.env.PAW_HOME?.trim();
const space = process.env.PAW_SPACE?.trim();
if (!home || home === join(homedir(), ".paw") || !space || space === "paw" || space === "team2027" || process.env.PAW_RELEASE !== "dev")
  throw new Error("check:chat-tty starts a mesh manager and sends messages — run it ONLY as PAW_HOME=$(mktemp -d) PAW_SPACE=test-$$ PAW_RELEASE=dev node scripts/check-chat-tty.ts");

const REPO = fileURLToPath(new URL("..", import.meta.url));
const bun = join(homedir(), ".bun/bin/bun");
const [exe, pre] = existsSync(bun) ? [bun, [join(REPO, "bin/paw.ts")]] : [process.execPath, [join(REPO, "bin/paw.mjs")]];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
const text = (m: CotalMessage) => m.parts.map((p) => (p.kind === "text" ? p.text : "")).join("");

const failures: string[] = [];
const ok = (label: string, pass: boolean, detail = ""): void => {
  console.log(`${pass ? "  ok " : "  FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!pass) failures.push(label);
};

await ensure({ needMesh: true, needManager: true, space });
const server = pawServer(space);

// ── echoer: a bare mesh peer (no claude), records DMs + #general ──────────────────────────────────
const dms: string[] = [];
const general: string[] = [];
let pingOnJoin = false;
const echoer = new CotalEndpoint({ space, servers: server, creds: await controlCreds(space), card: { name: "echoer", kind: "agent" }, registerPresence: true, consume: true, watchPresence: true });
echoer.on("error", (e: Error) => console.error("echoer:", e.message));
echoer.on("warning", () => {});
echoer.on("message", (m: CotalMessage, d: Delivery, meta: MessageMeta) => {
  d.ack();
  if (meta.kind === "dm") dms.push(text(m));
  else if (meta.kind === "channel") general.push(text(m));
});
echoer.on("presence", (ev: { type: string; presence: { card: { id: string; name: string } } }) => {
  if (pingOnJoin && ev.type === "join" && ev.presence.card.name === "you") {
    pingOnJoin = false;
    void echoer.unicast(ev.presence.card.id, "ping-the-moment-you-joined");
  }
});
await echoer.start();

/** One `paw chat` under a pty. `script` runs against it; returns the plain output and exit code. */
async function chat(args: string[], script: (io: { write(s: string): void; out(): string; t(): number; waitFor(re: RegExp, ms: number): Promise<boolean> }) => Promise<void>, budgetMs = 30_000) {
  const t0 = Date.now();
  const p = ptySpawn(exe, [...pre, "chat", ...args], { name: "xterm-256color", cols: 120, rows: 40, cwd: REPO, env: { ...(process.env as Record<string, string>), FORCE_COLOR: "1" } });
  let raw = "";
  p.onData((d) => (raw += d));
  const exited = new Promise<number>((r) => p.onExit(({ exitCode }) => r(exitCode)));
  let done = false;
  void exited.then(() => (done = true));
  const io = {
    write: (s: string) => !done && p.write(s),
    out: () => strip(raw),
    t: () => Date.now() - t0,
    waitFor: async (re: RegExp, ms: number) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (re.test(strip(raw))) return true;
        if (done) return re.test(strip(raw));
        await sleep(25);
      }
      return false;
    },
  };
  await script(io);
  const code = await Promise.race([exited, sleep(budgetMs).then(() => undefined)]);
  if (code === undefined) p.kill();
  return { raw, plain: strip(raw), code, ms: Date.now() - t0 };
}

try {
  // 1. type-ahead: one line before the prompt, one once it shows — queued, then sent once each, in order.
  {
    dms.length = 0;
    general.length = 0;
    const r = await chat(["echoer"], async (io) => {
      setTimeout(() => io.write("one-early\r"), 30);
      await io.waitFor(/you → /, 5000);
      io.write("two-at-prompt\r");
      const end = Date.now() + 20_000;
      while (Date.now() < end && dms.filter((d) => /one-early|two-at-prompt/.test(d)).length < 2) await sleep(50);
      await sleep(500); // a duplicate would land now
      io.write("/quit\r");
    });
    const got = dms.filter((d) => /one-early|two-at-prompt/.test(d));
    ok("1. both early lines reach echoer exactly once, in typed order", JSON.stringify(got) === JSON.stringify(["one-early", "two-at-prompt"]), JSON.stringify(got));
    ok("1. …they were queued while connecting (◌ queued)", (r.plain.match(/◌ queued — sends when connected/g) ?? []).length >= 1, `${(r.plain.match(/◌ queued/g) ?? []).length}×`);
    ok("1. …and #general heard nothing", general.length === 0, JSON.stringify(general));
    ok("1. /quit exits 0", r.code === 0, `exit ${r.code}`);
  }

  // 2. `@ghost hi` before ready → refused by name, nothing posted.
  {
    dms.length = 0;
    general.length = 0;
    const r = await chat(["echoer"], async (io) => {
      setTimeout(() => io.write("@ghost hi-ghost\r"), 30);
      await io.waitFor(/no peer named "ghost"/, 20_000);
      await sleep(300);
      io.write("/quit\r");
    });
    ok("2. @ghost before ready → no peer named ghost", /no peer named "ghost"/.test(r.plain), r.plain.split("\n").slice(-6).join(" | "));
    ok("2. …and nothing was sent anywhere", dms.every((d) => !/hi-ghost/.test(d)) && general.length === 0);
  }

  // 3. an unreachable target: the queued line is refused and kept, the chat stays up, /quit leaves.
  {
    general.length = 0;
    const r = await chat(["nosuch"], async (io) => {
      setTimeout(() => io.write("hi-nobody\r"), 30);
      const refused = await io.waitFor(/✕ not sent to nosuch: .* text kept/, 20_000);
      ok("3. a line to an unreachable target is refused and kept", refused, io.out().split("\n").slice(-6).join(" | "));
      await sleep(300);
      ok("3. …the chat is still up", !/\$ $/.test(io.out()) && /you → .*nosuch/.test(io.out()));
      io.write("\x15/quit\r");
    });
    ok("3. …#general stayed silent (never a fallback post)", general.length === 0, JSON.stringify(general));
    ok("3. /quit leaves", r.code !== undefined, `exit ${r.code}`);
  }

  // 4. a DM that lands the moment "you" joins is shown (listeners attached before connect).
  {
    pingOnJoin = true;
    const r = await chat(["echoer"], async (io) => {
      await io.waitFor(/ping-the-moment-you-joined/, 8_000);
      await sleep(300);
      io.write("/quit\r");
    });
    ok("4. a DM sent the moment you join renders", /ping-the-moment-you-joined/.test(r.plain), r.plain.split("\n").slice(-6).join(" | "));
    pingOnJoin = false;
  }

  // 5. Ctrl-C during startup: leaves promptly, terminal restored, queued lines printed in full.
  for (const at of [80, 400]) {
    const r = await chat(["echoer"], async (io) => {
      setTimeout(() => io.write("keep-this-line\r"), 30);
      setTimeout(() => io.write("\x03"), at);
    }, 15_000);
    ok(`5. Ctrl-C at +${at}ms exits within the settle bound`, r.code !== undefined && r.ms < 12_000, `exit ${r.code} after ${r.ms}ms`);
    ok(`5. …bracketed paste is switched off on the way out`, r.raw.includes("\x1b[?2004l"));
    const sent = dms.includes("keep-this-line");
    ok(`5. …the queued line is printed in full (or it was sent before the quit)`, /keep-this-line/.test(r.plain.slice(r.plain.lastIndexOf("quitting") >= 0 ? r.plain.lastIndexOf("quitting") : 0)) || sent, sent ? "sent" : "printed");
    dms.length = 0;
  }

  // 6. pipe mode: today's order — connect, then read lines — one delivery.
  {
    dms.length = 0;
    const child = spawn(exe, [...pre, "chat", "echoer"], { cwd: REPO, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const end = Date.now() + 20_000;
    while (Date.now() < end && !/you → /.test(strip(out))) await sleep(50);
    child.stdin.write("piped-line\n");
    while (Date.now() < end && !dms.includes("piped-line")) await sleep(50);
    await sleep(500);
    child.stdin.end();
    await new Promise((r) => child.on("exit", r));
    ok("6. pipe mode delivers once", dms.filter((d) => d === "piped-line").length === 1, JSON.stringify(dms));
    ok("6. …banner after the connect (today's order)", strip(out).indexOf("connecting to echoer") < strip(out).indexOf("paw chat") && /status: reusing live agent/.test(strip(out)), strip(out).slice(0, 200));
  }
} finally {
  await echoer.stop().catch(() => {});
  await stop({ space }).catch((e) => console.error("teardown stop:", (e as Error).message));
  await purgeTestSpace(space, server).catch((e) => {
    console.error("teardown purge:", (e as Error).message);
    process.exitCode = 1;
  });
  rmSync(join(home, "spaces", space), { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\n${failures.length} chat tty check(s) failed:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log("\npaw chat takes keys from the first frame 🐾");
