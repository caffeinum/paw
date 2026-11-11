/**
 * `paw top --problems` as a real TUI under a pty — hermetic: the harness (scripts/fixtures/problems-tui-harness.ts)
 * runs `runProblemsTui` on a fixture report with a `run` that only records each argv to a file. No mesh, no
 * manager, no agent. The screen is rendered with @xterm/headless (cotal's own dependency) and read back.
 *
 *   ↓ r n            → the restart confirm names research#paw; n runs nothing
 *   r y (two reads)  → exactly ["restart","research","--space","paw"] runs, then "press any key"
 *   ↓↓ r             → on the remote row: nothing runs, the footer names the other machine's command
 *   x / X            → the row hides, the dismissed count shows, X brings it back
 *   ry (one read)    → nothing runs (type-ahead never consents); n cancels
 *   q                → exit 0, alt screen left and the cursor shown again
 *
 * Run: pnpm check:problems-tty
 */
import { spawn as ptySpawn } from "@lydell/node-pty";
import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cotalManager = realpathSync(join(REPO, "node_modules", "@cotal-ai", "manager"));
type XTerm = { write(d: string, cb?: () => void): void; buffer: { active: { length: number; getLine(i: number): { translateToString(trim: boolean): string } | undefined } } };
const { Terminal } = createRequire(join(cotalManager, "package.json"))("@xterm/headless") as { Terminal: new (o: Record<string, unknown>) => XTerm };

const COLS = 140;
const ROWS = 30;
const dir = mkdtempSync(join(tmpdir(), "paw-problems-tty-"));
const record = join(dir, "runs.jsonl");
const term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true });
let raw = "";
const p = ptySpawn(process.execPath, [join(REPO, "scripts", "fixtures", "problems-tui-harness.ts"), "--record", record], {
  name: "xterm-256color",
  cols: COLS,
  rows: ROWS,
  cwd: REPO,
  env: { ...(process.env as Record<string, string>), PAW_HOME: dir, PAW_SPACE: `test-${process.pid}` },
});
p.onData((d) => {
  raw += d;
  term.write(d);
});
let exitCode: number | undefined;
p.onExit(({ exitCode: c }) => (exitCode = c));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const screen = async () => {
  await new Promise<void>((r) => term.write("", r));
  const b = term.buffer.active;
  const out: string[] = [];
  for (let i = Math.max(0, b.length - ROWS); i < b.length; i++) out.push(b.getLine(i)?.translateToString(true) ?? "");
  return out.join("\n");
};
const until = async (fn: (s: string) => boolean, ms = 5000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (fn(await screen())) return true;
  return false;
};
const runs = () => (existsSync(record) ? readFileSync(record, "utf8").trim().split("\n").filter(Boolean) : []);
const send = async (s: string, wait = 250) => {
  p.write(s);
  await sleep(wait);
};

let fails = 0;
const ok = (cond: boolean, msg: string) => {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) fails++;
};

try {
  ok(await until((s) => s.includes("problems on aleks-macbook") && s.includes("canary#paw")), "the fixture paints: header and rows");
  ok(raw.includes("\x1b[?1049h") && raw.includes("\x1b[?25l"), "the TUI enters the alt screen and hides the cursor");
  await send("\x1b[B");
  ok((await screen()).split("\n").some((l) => l.startsWith("▸ ⚠ research#paw")), "↓ selects research#paw");
  await send("r");
  ok(await until((s) => s.includes("restart research#paw? it is live (online) — its turn is cut and it resumes from its pin [y/N]")), "r: the confirm names research#paw");
  await send("n");
  ok((await until((s) => s.includes("✕ not restarted"))) && runs().length === 0, "n: nothing runs");
  await send("r");
  await until((s) => s.includes("[y/N]"));
  await send("y", 400);
  ok(await until((s) => s.includes("press any key")), "y: the action runs with the terminal handed over, then waits for a key");
  ok(runs().length === 1 && runs()[0] === JSON.stringify(["restart", "research", "--space", "paw"]), `y runs exactly ["restart","research","--space","paw"] (${runs().join(" | ")})`);
  ok(/\$ paw restart research --space paw/.test(await screen()) && (await screen()).includes("✓ done"), "the run shows its command and its outcome");
  await send(" ", 500);
  ok(await until((s) => s.includes("problems on aleks-macbook") && s.split("\n").some((l) => l.startsWith("▸ ⚠ research#paw"))), "back in the TUI, the cursor still on research#paw");
  await send("\x1b[B");
  await send("\x1b[B");
  ok((await screen()).split("\n").some((l) => l.startsWith("▸ ○ lizard#team2027")), "↓↓ selects the remote row");
  await send("r");
  ok((await until((s) => s.includes("on aleks-mac-mini: paw start lizard --space team2027"))) && runs().length === 1, "r on a remote row runs nothing and names that machine's command");
  await send("x");
  ok(await until((s) => s.includes("1 dismissed · X shows them") && !s.includes("lizard#team2027")), "x hides the row and counts it");
  await send("X");
  ok(await until((s) => s.includes("lizard#team2027") && !s.includes("dismissed")), "X brings it back");
  ok((await screen()).split("\n").some((l) => l.startsWith("▸ ⚠ queue#paw")), "the dismissed row's cursor moved to its neighbour and stays there");
  await send("\x1b[A");
  ok((await screen()).split("\n").some((l) => l.startsWith("▸ ⚠ research#paw")), "back on research#paw");
  await send("ry", 400);
  ok((await screen()).includes("[y/N]") && runs().length === 1, "`ry` in one write runs nothing — the confirm still waits");
  await send("n");
  ok((await until((s) => s.includes("✕ not restarted"))) && runs().length === 1, "n cancels it");
  await send("q", 600);
  for (let i = 0; i < 20 && exitCode === undefined; i++) await sleep(100);
  ok(exitCode === 0 && raw.includes("TUI_EXIT 0"), `q exits 0 (${exitCode})`);
  const tail = raw.slice(raw.lastIndexOf("\x1b[?1049h"));
  ok(tail.includes("\x1b[?1049l") && tail.includes("\x1b[?25h"), "the terminal is restored: alt screen left, cursor shown");
} finally {
  if (exitCode === undefined) p.kill();
}

if (fails) {
  console.log("--- screen ---\n" + (await screen()));
  process.exit(1);
}
console.log("check:problems-tty ok");
process.exit(0);
