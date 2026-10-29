// `pnpm measure:chat` — paw chat's time-to-interactive under a real pty. READ-ONLY by construction:
// it types one letter early, never presses Enter, and leaves with Ctrl-U + Ctrl-D, so it is safe to
// point at a live agent (it sends nothing and never passes --restart).
//
//   node scripts/measure-chat-ttp.ts [-n 5] [--runtime bun|node] [--cwd <dir>] -- chat @skills
//
// Per run, from spawn: the first byte on screen, the first `you → ` prompt, the moment the early
// letter is echoed BEHIND that prompt (readline is live and has your key), and — when the build writes
// PAW_CHAT_TIMING — `ready` (connected, target resolved) and `settled` (no ◌ loader left on screen).
import { spawn as ptySpawn } from "@lydell/node-pty";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
if (sep < 0) throw new Error("usage: measure-chat-ttp.ts [-n N] [--runtime bun|node] [--cwd dir] [--label L] -- <paw args…>");
const opts = argv.slice(0, sep);
const pawArgs = argv.slice(sep + 1);
const flag = (f: string): string | undefined => {
  const i = opts.indexOf(f);
  return i < 0 ? undefined : opts[i + 1];
};
const n = Number(flag("-n") ?? "5");
const runtime = flag("--runtime") ?? "bun";
const cwd = flag("--cwd") ?? process.cwd();
const label = flag("--label") ?? pawArgs.join(" ");
const bun = join(process.env.HOME!, ".bun/bin/bun");
const repo = flag("--repo") ?? here.replace(/\/scripts$/, ""); // --repo: measure another checkout (a baseline)
const [exe, pre] = runtime === "bun" ? [bun, [join(repo, "bin/paw.ts")]] : [process.execPath, [join(repo, "bin/paw.mjs")]];
if (runtime === "bun" && !existsSync(bun)) throw new Error(`no bun at ${bun}`);

const strip = (s: string): string => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b[()][A-Z0-9]/g, "");
const LETTER = "Ж"; // rare enough that its first appearance after the prompt is the echo

type Run = { first?: number; prompt?: number; echo?: number; ready?: number; settled?: number; exit?: number; tail: string; marks: Record<string, number> };

async function once(i: number): Promise<Run> {
  const dir = mkdtempSync(join(tmpdir(), "paw-ttp-"));
  const timing = join(dir, "timing.jsonl");
  const t0 = performance.now();
  const p = ptySpawn(exe, [...pre, ...pawArgs], {
    name: "xterm-256color",
    cols: 120,
    rows: 40,
    cwd,
    env: { ...(process.env as Record<string, string>), PAW_CHAT_TIMING: timing, FORCE_COLOR: "1" },
  });
  const r: Run = { tail: "", marks: {} };
  let buf = "";
  let quitting = false;
  const at = () => Math.round(performance.now() - t0);
  const quit = () => {
    if (quitting) return;
    quitting = true;
    p.write("\x15"); // Ctrl-U: drop the letter (Ctrl-D only quits on an empty line)
    setTimeout(() => p.write("\x04"), 150);
  };
  p.onData((d) => {
    if (d.replaceAll(LETTER, "").trim()) r.first ??= at();
    buf += d;
    const plain = strip(buf);
    const promptAt = plain.indexOf("you → ");
    if (promptAt >= 0) {
      r.prompt ??= at();
      // The letter behind the prompt's `> ` (readline's echo, not the tty's cooked echo before it).
      if (r.echo === undefined && plain.slice(promptAt).includes(LETTER)) r.echo = at();
    }
  });
  // Typed the instant the command was entered — or, with --type-at prompt, once a prompt is drawn
  // (validates the echo detector against a build where early keys are not echoed).
  if (flag("--type-at") === "prompt") {
    const poll = setInterval(() => r.prompt !== undefined && (clearInterval(poll), p.write(LETTER)), 5);
  } else setTimeout(() => p.write(LETTER), 30);
  // Old builds write no timing: echo IS ready. New ones: wait for ready (+ settle), capped.
  const done = setInterval(() => {
    const ready = existsSync(timing) && /"ready"/.test(readFileSync(timing, "utf8"));
    const settled = existsSync(timing) && /"settled"/.test(readFileSync(timing, "utf8"));
    // An old build writes no timing file: the echo is the whole story. A new one: wait for settled.
    if (r.echo !== undefined && (settled || (!existsSync(timing) && at() > (r.echo ?? 0) + 300))) quit();
    if (at() > 45_000) quit();
  }, 25);
  const code = await new Promise<number>((res) => p.onExit(({ exitCode }) => res(exitCode)));
  clearInterval(done);
  r.exit = code;
  if (existsSync(timing)) {
    for (const line of readFileSync(timing, "utf8").trim().split("\n")) {
      const j = JSON.parse(line) as { mark: string; ms: number };
      r.marks[j.mark] ??= Math.round(j.ms);
      if (j.mark === "ready") r.ready = Math.round(j.ms);
      if (j.mark === "settled") r.settled = Math.round(j.ms);
    }
  }
  r.tail = strip(buf).split("\n").slice(-4).join(" | ").slice(0, 300);
  if (code !== 0) console.error(`  run ${i}: exit ${code} — ${r.tail}`);
  return r;
}

const runs: Run[] = [];
for (let i = 0; i < n; i++) {
  const r = await once(i);
  runs.push(r);
  console.error(`  run ${i}: first=${r.first} prompt=${r.prompt} echo=${r.echo} ready=${r.ready ?? "-"} settled=${r.settled ?? "-"} exit=${r.exit}`);
}
const med = (k: keyof Run): string => {
  const v = runs.map((r) => r[k]).filter((x): x is number => typeof x === "number").sort((a, b) => a - b);
  if (!v.length) return "-";
  const m = v[Math.floor(v.length / 2)];
  const p90 = v[Math.min(v.length - 1, Math.ceil(v.length * 0.9) - 1)];
  return `${m} (p90 ${p90})`;
};
console.log(`${label} [${runtime}, n=${n}]  first frame ${med("first")} · prompt ${med("prompt")} · typed key echoed ${med("echo")} · ready ${med("ready")} · settled ${med("settled")}  (ms)`);
const names = [...new Set(runs.flatMap((r) => Object.keys(r.marks)))];
if (names.length) {
  const medMark = (m: string): number | undefined => {
    const v = runs.map((r) => r.marks[m]).filter((x): x is number => typeof x === "number").sort((a, b) => a - b);
    return v.length ? v[Math.floor(v.length / 2)] : undefined;
  };
  console.log(`  marks (median ms from process start): ${names.map((m) => `${m} ${medMark(m)}`).join(" · ")}`);
}
