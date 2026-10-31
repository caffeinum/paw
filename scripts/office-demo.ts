/**
 * A visual smoke harness for the Office view: a real `startWebServer` (the check-web seam) serving the
 * real web/app/ client, with STUBBED deps — no mesh, no manager, no live agents, never port 7788, never
 * ~/.paw. The fixture fleet below is test data for this harness only; the view itself renders whatever
 * /api/status returns.
 *
 *   PAW_HOME=$(mktemp -d) PAW_SPACE=test-$$ PAW_RELEASE=dev PAW_SERVER=nats://127.0.0.1:1 \
 *     node scripts/office-demo.ts [--port N]
 *
 * Then open http://127.0.0.1:<port>/?at=office. Statuses flip and DM edges grow every few seconds so
 * walking, sitting, bubbles and arcs all get exercised. Ctrl-C to stop.
 */
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { startWebServer } from "../src/web.ts";

if (!process.env.PAW_HOME || process.env.PAW_HOME === join(process.env.HOME ?? "", ".paw")) {
  throw new Error("office-demo: set PAW_HOME to a temp dir (PAW_HOME=$(mktemp -d)) — this harness never touches ~/.paw");
}
if (!process.env.PAW_SPACE || process.env.PAW_SPACE === "paw") throw new Error("office-demo: set PAW_SPACE=test-$$ (never the live 'paw' space)");

const argPort = process.argv.indexOf("--port");
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
const port = argPort > 0 ? Number(process.argv[argPort + 1]) : await freePort();
if (port === 7788) throw new Error("office-demo: 7788 belongs to the live paw web — pick another port");

const G = "/Users/demo/Github";
type Row = Record<string, unknown> & { name: string; mesh: string; live: boolean };
const rows: Row[] = [
  { name: "evals", folder: `${G}/team2027/evals`, git: { repo: "team2027/evals", branch: "main" }, mesh: "working", live: true, busy: true, tool: { name: "Bash" }, hue: 28, emoji: "🧪" },
  { name: "evals-queue", folder: "/Users/demo/.superconductor/worktrees/evals/sc-queue", git: { repo: "team2027/evals", branch: "fix/queue", worktree: true, mainPath: `${G}/team2027/evals` }, mesh: "idle", live: true },
  { name: "evals-ui", folder: `${G}/team2027/evals/.claude/worktrees/ui`, git: { repo: "team2027/evals", branch: "feat/ui", worktree: true, mainPath: `${G}/team2027/evals` }, mesh: "waiting", live: true },
  { name: "research", folder: `${G}/team2027/research`, git: { repo: "team2027/research", branch: "main" }, mesh: "idle", live: true, emoji: "🔭" },
  { name: "firegoat", folder: `${G}/team2027/firegoat`, git: { repo: "team2027/firegoat", branch: "main" }, mesh: "working", live: true, busy: true },
  { name: "firegoat-docs", folder: `${G}/team2027/firegoat/docs`, git: { repo: "team2027/firegoat", branch: "docs" }, mesh: "idle", live: true },
  { name: "paw", folder: `${G}/caffeinum/paw`, git: { repo: "caffeinum/paw", branch: "main" }, mesh: "working", live: true, busy: true, tool: { name: "Edit" }, hue: 290, emoji: "🐾" },
  { name: "paw-office", folder: `${G}/caffeinum/paw.office`, git: { repo: "caffeinum/paw", branch: "feat/web-office-3d", worktree: true, mainPath: `${G}/caffeinum/paw` }, mesh: "idle", live: true },
  { name: "paw-web", folder: `${G}/caffeinum/paw-web`, git: { repo: "caffeinum/paw", branch: "web", worktree: true, mainPath: `${G}/caffeinum/paw` }, mesh: "idle", live: true, stuck: true },
  { name: "landing", folder: `${G}/caffeinum/vibeos-landing`, git: { repo: "caffeinum/vibeos-landing", branch: "main" }, mesh: "starting", live: true },
  { name: "landing-copy", folder: `${G}/caffeinum/vibeos-landing/copy`, git: { repo: "caffeinum/vibeos-landing", branch: "main" }, mesh: "idle", live: true },
  { name: "sleepy", folder: `${G}/caffeinum/vibeos-landing/old`, git: { repo: "caffeinum/vibeos-landing", branch: "old" }, mesh: "offline", live: false },
  { name: "codex-1", unregistered: { agent: "codex" }, mesh: "working", live: true, busy: true },
  { name: "codex-2", unregistered: { agent: "codex" }, mesh: "idle", live: true },
];

const lines = [
  "pushed the queue fix, CI is green — can you rerun the nightly?",
  "the leaderboard query is 4x faster with the new index",
  "PR #184 is up: retries now back off exponentially",
  "can you review the landing copy before I ship it?",
  "found it: the presence watch was rebinding every 30s",
  "screenshots attached, the night theme looks right now",
  "merging after one more check run",
];
const edges = new Map<string, { a: string; b: string; count: number; lastTs: number }>();
const last: Record<string, { text: string; ts: number }> = {};
const conv: Array<{ from: string; text: string; ts: number; dir: "in" | "out"; to?: string }> = [];
const live = () => rows.filter((r) => r.live).map((r) => r.name);
const pickOne = <T,>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)];

function talk(): void {
  const names = live();
  const a = pickOne(names);
  let b = pickOne([...names, "you"]);
  if (b === a) b = "you";
  const [x, y] = [a, b].sort();
  const k = `${x}\u0000${y}`;
  const e = edges.get(k) ?? { a: x, b: y, count: 0, lastTs: 0 };
  const ts = Date.now();
  e.count++;
  e.lastTs = ts;
  edges.set(k, e);
  const text = pickOne(lines);
  last[a] = { text, ts };
  if (b === "you") {
    conv.push({ from: a, text, ts, dir: "in" });
    server.broadcast({ type: "message", entry: { from: a, text, ts, dir: "in" } });
  }
}

function flip(): void {
  const r = pickOne(rows.filter((x) => x.live && !x.unregistered));
  const next = pickOne(["idle", "idle", "working", "waiting"]);
  r.mesh = next;
  r.busy = next === "working";
  if (r.mesh === "working") r.tool = pickOne([{ name: "Bash" }, { name: "Edit" }, { name: "Read" }]);
  else delete r.tool;
  server.broadcast({ type: "status", rows, errors: [], cursor: 0 });
}

const clientRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "web", "app");
const server = await startWebServer({
  port,
  space: process.env.PAW_SPACE,
  clientRoot,
  convo: { entries: () => conv },
  status: async () => ({ rows, errors: [] }),
  trace: () => [],
  dm: async (to: string) => ({ name: to }),
  village: () => ({ edges: [...edges.values()], last, generatedAt: Date.now() }),
});
for (let i = 0; i < 6; i++) talk();
setInterval(talk, 2500);
setInterval(flip, 7000);
setTimeout(() => {
  const l = rows.find((r) => r.name === "landing");
  if (l) l.mesh = "idle";
}, 12000);
console.log(`office demo: http://127.0.0.1:${server.port}/?at=office  (space ${process.env.PAW_SPACE}, PAW_HOME ${process.env.PAW_HOME})`);
