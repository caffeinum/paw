/**
 * What every paw agent is costing the machine right now — the shared snapshot behind `paw top` and
 * `paw optimize`, plus the one table both print.
 *
 * Processes come from ONE `ps -axE` (env appended): cotal stamps COTAL_NAME/COTAL_SPACE into every agent
 * it launches and children inherit it, so an agent's root is the topmost stamped process, which works
 * for registered agents and cotal_spawn peers alike with no registry lookup. A stamped process whose
 * parent is launchd (ppid 1) outlived the agent that started it: an orphan, still counted against it.
 *
 * Memory is macOS phys_footprint from ONE batched `footprint` call — RSS understates a claude by ~7×
 * (idle: 32MB RSS vs 241MB footprint), so RSS is never shown as memory; without footprint the cell is
 * `?`. CPU is the difference of cumulative cpu time over a ~1s window — `ps %cpu` is a decayed average
 * that read 5% for a process really using 22%.
 */
import { execFile } from "node:child_process";
import { cpus, loadavg } from "node:os";
import { basename } from "node:path";
import type { Verdict } from "./commands/optimize.js";
import { ago, hungTool, type AgentStatus } from "./status.js";
import { UNSTICK_TOOL_DEFAULT_MIN } from "./unstick.js";

export interface Proc {
  pid: number;
  ppid: number;
  pgid: number;
  ageMs: number;
  cpuMs: number;
  /** full ps text: argv, then the env */
  cmd: string;
  /** argv only (best effort: cut at the first `KEY=` token) */
  argv: string;
  agent?: string;
  space?: string;
}

export type Kind = "task" | "bg" | "mcp" | "tp" | "hook";

export interface Item {
  pid: number;
  kind: Kind;
  label: string;
  ageMs: number;
  mem?: number; // MB, the subtree's footprint
  cpu?: number; // %, the subtree's
  ports: number[];
  /** tracepaper launched through `npm exec` — the old install shape, fixed by a restart */
  stale?: boolean;
  pids: number[];
}

export interface AgentProcs {
  roots: number[];
  /** age of the oldest root process */
  ageMs: number;
  mem?: number;
  cpu?: number;
  items: Item[];
}

export interface Machine {
  memUsedMb?: number;
  memTotalMb?: number;
  swapUsedMb?: number;
  load: number;
  cores: number;
}

export interface Fleet {
  agents: Record<string, AgentProcs>;
  orphans: Array<Item & { agent: string }>;
  /** claude processes that are not paw agents (only collected with `all`) */
  other: Item[];
  machine: Machine;
  /** false when `footprint` couldn't run: every mem is undefined, never RSS */
  measured: boolean;
}

// ---------- parsing (pure) ----------

/** `[[dd-]hh:]mm:ss[.cc]` (ps etime/time) → ms. */
export function parseClock(s: string): number {
  const [d, rest] = s.includes("-") ? s.split("-") : ["0", s];
  const sec = rest.split(":").reduce((acc, p) => acc * 60 + Number(p), 0);
  return Math.round((Number(d) * 86400 + sec) * 1000);
}

function envVal(cmd: string, key: string): string | undefined {
  let last: string | undefined;
  for (const m of cmd.matchAll(new RegExp(`(?:^|\\s)${key}=(\\S*)`, "g"))) last = m[1];
  return last;
}

export function parsePs(text: string): Proc[] {
  const out: Proc[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const cmd = m[6];
    const cut = /\s[A-Z_][A-Z0-9_]*=/.exec(cmd);
    out.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      pgid: Number(m[3]),
      ageMs: parseClock(m[4]),
      cpuMs: parseClock(m[5]),
      cmd,
      argv: cut ? cmd.slice(0, cut.index) : cmd,
      agent: envVal(cmd, "COTAL_NAME"),
      space: envVal(cmd, "COTAL_SPACE"),
    });
  }
  return out;
}

/** `footprint --noCategories -f bytes` → pid → MB. */
export function parseFootprint(out: string): Map<number, number> {
  const mb = new Map<number, number>();
  for (const m of out.matchAll(/\[(\d+)\]:.*?Footprint:\s*(\d+) B/g)) mb.set(Number(m[1]), Number(m[2]) / 1048576);
  return mb;
}

/** `lsof -Fpn` → pid → listening ports. */
export function parseLsof(out: string): Map<number, number[]> {
  const ports = new Map<number, number[]>();
  let pid = 0;
  for (const line of out.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n")) {
      const port = Number(line.slice(line.lastIndexOf(":") + 1));
      const list = ports.get(pid) ?? [];
      if (Number.isFinite(port) && !list.includes(port)) ports.set(pid, [...list, port]);
    }
  }
  return ports;
}

/** Two cumulative cpu-time reads `wallMs` apart → pid → %. A pid missing from either read is left out. */
export function cpuPercent(before: Map<number, number>, after: Map<number, number>, wallMs: number): Map<number, number> {
  const pct = new Map<number, number>();
  for (const [pid, t1] of after) {
    const t0 = before.get(pid);
    if (t0 !== undefined && wallMs > 0) pct.set(pid, Math.max(0, ((t1 - t0) / wallMs) * 100));
  }
  return pct;
}

// ---------- attribution + classification (pure) ----------

const SKIP = /^(node|bun|deno|python[\d.]*|npx|sh|bash|zsh|env|tsx|uvx)$/i;

/** A short human name for a command line: `fly agent`, `vibeos-mcp@0.2.2`, `pnpm dev`. */
export function shortLabel(argv: string): string {
  const t = argv.trim().split(/\s+/);
  let i = 0;
  while (i < t.length) {
    const b = basename(t[i]);
    if (SKIP.test(b) || t[i].startsWith("-")) i++;
    else if (/^(npm|pnpm|bun)$/.test(b) && /^(exec|run|x|dlx)$/.test(t[i + 1] ?? "")) i += 2;
    else break;
  }
  if (i >= t.length) return basename(t[0] ?? "?");
  const next = t[i + 1];
  const word = next && /^[a-z][\w.@:-]*$/i.test(next) ? ` ${next}` : "";
  return `${basename(t[i])}${word}`;
}

/** The command a claude Bash tool runs: its shell is `zsh -c source …shell-snapshots… eval '<cmd>'`. */
export function evalLabel(cmd: string): string {
  const m = /eval '((?:[^']|'\\'')*)'/.exec(cmd);
  const text = (m ? m[1].replace(/'\\''/g, "'") : cmd).replace(/\\012/g, " ");
  const words = text.split(/\s+/).filter((w) => w && !/^[A-Z_][A-Z0-9_]*=/.test(w)).slice(0, 3).join(" ") || "sh";
  return words.length > 24 ? `${words.slice(0, 23)}…` : words;
}

export function classify(child: Proc, subtree: Proc[], rootPgid: number): { kind: Kind; label: string; stale?: boolean } {
  const text = subtree.map((p) => p.argv).join("\n");
  // `(node)` = a process mid-exit, gone before anyone could act on it
  if (/hook\.cjs|\bcaffeinate\b|hooks claude|^\(/.test(child.argv)) return { kind: "hook", label: shortLabel(child.argv) };
  if (child.cmd.includes("shell-snapshots")) return { kind: "task", label: evalLabel(child.cmd) };
  if (text.includes("tracepaper")) return { kind: "tp", label: "tp", stale: /^npm exec/.test(child.argv) };
  if (/connector-claude-code|mcp\.cjs/.test(text)) return { kind: "mcp", label: "mcp" };
  return { kind: child.pgid === rootPgid ? "mcp" : "bg", label: shortLabel(child.argv) };
}

interface Groups {
  agents: Map<string, { roots: Proc[]; children: Array<{ child: Proc; tree: Proc[]; rootPgid: number }> }>;
  orphans: Array<{ agent: string; tree: Proc[] }>;
  other: Proc[][];
  byPid: Map<number, Proc>;
}

export function groupProcs(procs: Proc[], space: string, all = false): Groups {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const kids = new Map<number, Proc[]>();
  for (const p of procs) if (p.pid !== p.ppid) kids.set(p.ppid, (kids.get(p.ppid) ?? []).concat(p));
  const tree = (p: Proc): Proc[] => [p, ...(kids.get(p.pid) ?? []).flatMap(tree)];
  const ours = (p: Proc | undefined) => p?.agent !== undefined && p.space === space;
  const g: Groups = { agents: new Map(), orphans: [], other: [], byPid };
  const stampedAncestor = (p: Proc) => {
    for (let q = byPid.get(p.ppid); q && q.pid > 1; q = byPid.get(q.ppid)) if (ours(q) && q.agent === p.agent) return true;
    return false;
  };
  for (const p of procs) {
    if (ours(p) && !stampedAncestor(p)) {
      // `npm exec` rewrites its title and hides its env, so an orphaned npx chain shows its stamp one level down.
      let head = p;
      for (let q = byPid.get(head.ppid); q && /^(npm exec|npx) /.test(q.argv); q = byPid.get(q.ppid)) head = q;
      if (head.ppid === 1) g.orphans.push({ agent: p.agent!, tree: tree(head) });
      else {
        const a = g.agents.get(p.agent!) ?? { roots: [], children: [] };
        a.roots.push(p);
        for (const c of kids.get(p.pid) ?? []) a.children.push({ child: c, tree: tree(c), rootPgid: p.pgid });
        g.agents.set(p.agent!, a);
      }
    } else if (all && !p.agent && basename(p.argv.split(/\s+/)[0]) === "claude" && basename(byPid.get(p.ppid)?.argv.split(/\s+/)[0] ?? "") !== "claude") {
      g.other.push(tree(p));
    }
  }
  return g;
}

export function groupPids(g: Groups): number[] {
  const pids = new Set<number>();
  for (const a of g.agents.values()) for (const p of [...a.roots, ...a.children.flatMap((c) => c.tree)]) pids.add(p.pid);
  for (const t of [...g.orphans.map((o) => o.tree), ...g.other]) for (const p of t) pids.add(p.pid);
  return [...pids];
}

export interface Measures {
  mem?: Map<number, number>;
  cpu?: Map<number, number>;
  ports: Map<number, number[]>;
}

export function buildFleet(g: Groups, m: Measures, machine: Machine): Fleet {
  const sum = (map: Map<number, number> | undefined, ps: Proc[]) => (map ? ps.reduce((s, p) => s + (map.get(p.pid) ?? 0), 0) : undefined);
  const item = (head: Proc, tree: Proc[], c: { kind: Kind; label: string; stale?: boolean }): Item => ({
    pid: head.pid,
    ...c,
    ageMs: head.ageMs,
    mem: sum(m.mem, tree),
    cpu: sum(m.cpu, tree),
    ports: [...new Set(tree.flatMap((p) => m.ports.get(p.pid) ?? []))],
    pids: tree.map((p) => p.pid),
  });
  const agents: Record<string, AgentProcs> = {};
  for (const [name, a] of g.agents) {
    const all = [...a.roots, ...a.children.flatMap((c) => c.tree)];
    agents[name] = {
      roots: a.roots.map((r) => r.pid),
      ageMs: Math.max(...a.roots.map((r) => r.ageMs)),
      mem: sum(m.mem, all),
      cpu: sum(m.cpu, all),
      items: a.children.map(({ child, tree, rootPgid }) => item(child, tree, classify(child, tree, rootPgid))),
    };
  }
  return {
    agents,
    orphans: g.orphans.map(({ agent, tree }) => ({ agent, ...item(tree[0], tree, { kind: "bg", label: shortLabel(tree[0].argv) }) })),
    other: g.other.map((tree) => item(tree[0], tree, { kind: "bg", label: `claude ${tree[0].argv.split(/\s+/).slice(1, 3).join(" ")}`.trim() })),
    machine,
    measured: m.mem !== undefined,
  };
}

// ---------- the live snapshot ----------

function run(cmd: string, args: string[]): Promise<{ out: string; missing: boolean }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }, (err, stdout) =>
      resolve({ out: stdout ?? "", missing: (err as NodeJS.ErrnoException | null)?.code === "ENOENT" }),
    );
  });
}

/** `ps -o pid=,time=` → pid → cumulative cpu ms. */
export function parseCpuTimes(text: string): Map<number, number> {
  const out = new Map<number, number>();
  for (const m of text.matchAll(/^\s*(\d+)\s+(\S+)\s*$/gm)) out.set(Number(m[1]), parseClock(m[2]));
  return out;
}

export function parseVmStat(text: string): number | undefined {
  const page = Number(/page size of (\d+)/.exec(text)?.[1]);
  const n = (k: string) => Number(new RegExp(`${k}:\\s+(\\d+)`).exec(text)?.[1] ?? NaN);
  const pages = n("Anonymous pages") - n("Pages purgeable") + n("Pages wired down") + n("Pages occupied by compressor");
  return Number.isFinite(pages * page) ? (pages * page) / 1048576 : undefined;
}

async function machineInfo(): Promise<Machine> {
  const [vm, sys] = await Promise.all([run("vm_stat", []), run("sysctl", ["-n", "hw.memsize", "vm.swapusage"])]);
  const [mem, swap] = sys.out.split("\n");
  const used = /used = ([\d.]+)M/.exec(swap ?? "");
  return {
    memUsedMb: parseVmStat(vm.out),
    memTotalMb: Number(mem) ? Number(mem) / 1048576 : undefined,
    swapUsedMb: used ? Number(used[1]) : undefined,
    load: loadavg()[0],
    cores: cpus().length,
  };
}

/** One snapshot of every process attributable to `space`'s agents. `sampleMs` 0 skips CPU. */
export async function snapshotFleet(space: string, opts: { all?: boolean; sampleMs?: number } = {}): Promise<Fleet> {
  const sampleMs = opts.sampleMs ?? 1000;
  const t0 = Date.now();
  const procs = parsePs((await run("ps", ["-axE", "-o", "pid=,ppid=,pgid=,etime=,time=,command="])).out);
  const g = groupProcs(procs, space, opts.all);
  const pids = groupPids(g);
  const list = ["-p", pids.join(",")];
  const [fp, lsof, machine] = await Promise.all([
    pids.length ? run("footprint", ["--noCategories", "-f", "bytes", ...pids.flatMap((p) => ["-p", String(p)])]) : Promise.resolve({ out: "", missing: false }),
    pids.length ? run("lsof", ["-nP", "-a", "-iTCP", "-sTCP:LISTEN", ...list, "-Fpn"]) : Promise.resolve({ out: "", missing: false }),
    machineInfo(),
  ]);
  let cpu: Map<number, number> | undefined;
  if (sampleMs > 0 && pids.length) {
    const wait = sampleMs - (Date.now() - t0);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const after = parseCpuTimes((await run("ps", ["-o", "pid=,time=", ...list])).out);
    cpu = cpuPercent(new Map(procs.map((p) => [p.pid, p.cpuMs])), after, Date.now() - t0);
  }
  return buildFleet(g, { mem: fp.missing ? undefined : parseFootprint(fp.out), cpu, ports: parseLsof(lsof.out) }, machine);
}

// ---------- the view (pure) ----------

export const fmtMb = (mb: number | undefined) => (mb === undefined ? "?" : mb >= 1024 ? `${(mb / 1024).toFixed(1)}G` : `${Math.round(mb)}M`);
const dur = (ms: number) => ago(0, ms);
const ports = (p: number[]) => p.map((x) => ` :${x}`).join("");

/** `⧗ fly ssh (51m)` · `bg: pnpm dev :3000 3h 410M` · `mcp 80M` · `tp ×2 34M` — duplicates collapsed. */
export function subprocsCell(items: Item[], toolPid: number | undefined, width: number): string {
  const groups = new Map<string, Item[]>();
  for (const it of items) {
    if (it.kind === "hook") continue;
    const key = it.pid === toolPid ? `tool:${it.pid}` : `${it.kind}:${it.label}:${it.stale}:${it.ports.join()}`;
    groups.set(key, [...(groups.get(key) ?? []), it]);
  }
  const rank = (it: Item) => (it.pid === toolPid ? 0 : it.kind === "task" || it.kind === "bg" ? 1 : 2);
  const parts = [...groups.values()]
    .sort((a, b) => rank(a[0]) - rank(b[0]))
    .map((g) => {
      const it = g[0];
      const n = g.length > 1 ? ` ×${g.length}` : "";
      const mem = g.some((x) => x.mem !== undefined) ? ` ${fmtMb(g.reduce((s, x) => s + (x.mem ?? 0), 0))}` : "";
      if (it.pid === toolPid) return `⧗ ${it.label} (${dur(it.ageMs)})`;
      if (it.kind === "task" || it.kind === "bg") return `bg: ${it.label}${ports(it.ports)}${n} ${dur(Math.min(...g.map((x) => x.ageMs)))}${mem}`;
      return `${it.label}${it.stale ? "(npx)" : ""}${n}${mem}`;
    });
  let out = "";
  for (let i = 0; i < parts.length; i++) {
    const next = out ? `${out} · ${parts[i]}` : parts[i];
    const more = parts.length - i - 1;
    if (next.length + (more ? ` +${more}`.length : 0) > width && out) return `${out} +${parts.length - i}`;
    out = next;
  }
  return out;
}

/** The task item that IS the agent's open Bash call: started within 15s of the tool_use record. */
export function toolItem(row: Pick<AgentStatus, "tool">, items: Item[], now: number): Item | undefined {
  const t = row.tool;
  if (!t || t.name !== "Bash" || t.startedMs === undefined) return undefined;
  return items.filter((i) => i.kind === "task").find((i) => Math.abs(now - i.ageMs - t.startedMs!) < 15_000);
}

export function stateText(row: AgentStatus, procs: AgentProcs | undefined, now: number): string {
  const hung = hungTool(row, now);
  if (hung !== undefined) return `⧗ ${row.tool!.name} ${dur(hung)}`;
  if (row.failure) return `⚠ ${/limit/i.test(row.failure.text) ? "limit" : /login/i.test(row.failure.text) ? "login" : "api error"}`;
  if ((procs?.roots.length ?? 0) > 1) return `⚠ ${procs!.roots.length} procs`;
  if (row.conflictPids.length) return "⚠ 2 writers";
  if (!row.live && procs) return "⚠ off mesh";
  return row.busy ? "busy" : row.mesh;
}

/** A copy-paste command (or a plain note) for the one thing worth doing about this agent. */
export function hintFor(
  row: AgentStatus,
  procs: AgentProcs | undefined,
  verdict: Verdict,
  now: number,
  names: ReadonlySet<string>,
): { text: string; cmd?: string } | undefined {
  const inTool = hungTool(row, now);
  // Esc only past the keeper's own threshold — a 6-minute build is not stuck, just long.
  if (inTool !== undefined && inTool < UNSTICK_TOOL_DEFAULT_MIN * 60_000) return { text: `in a tool for ${dur(inTool)}` };
  if (inTool !== undefined) {
    return row.runtime === "tmux" ? { text: "stuck in a tool", cmd: `paw unstick ${row.name}` } : { text: `stuck in a tool (${row.runtime ?? "?"} has no pane to Esc)` };
  }
  if (procs && !names.has(row.name)) return { text: "no agent by this name on the manager or in the registry", cmd: `kill ${procs.roots.join(" ")}` };
  if (procs && !row.live) return { text: "running, but off the mesh — look first", cmd: `paw log ${row.name}` };
  const dup = /^(.+)_\d+$/.exec(row.name);
  if (dup && names.has(dup[1])) return { text: `duplicate of ${dup[1]}`, cmd: `paw stop --name ${row.name}` };
  if (row.conflictPids.length) {
    const other = row.conflictPids.filter((p) => !procs?.roots.includes(p));
    return { text: `pid ${other.join(",") || row.conflictPids.join(",")} also holds its session`, cmd: row.folder ? `paw adopt ${row.folder} --force` : undefined };
  }
  if (row.failure) return { text: row.failure.text.split("\n")[0].slice(0, 60) };
  if (verdict.act === "stop") return { text: "folder gone", cmd: `paw stop ${row.name}` };
  if (procs?.items.some((i) => i.stale)) {
    // `paw restart <agent>` only knows registered agents; a cotal_spawn peer is respawned by whoever spawned it
    return row.unregistered ? { text: "tracepaper via npx — respawn this cotal_spawn peer" } : { text: "tracepaper via npx", cmd: `paw restart ${row.name}` };
  }
  const server = procs?.items.find((i) => (i.kind === "task" || i.kind === "bg") && i.ports.length && i.pid !== toolItem(row, procs.items, now)?.pid);
  if (server) return { text: `bg server${ports(server.ports)}`, cmd: `kill ${server.pid}` };
  if (verdict.act === "restart") return { text: `idle ${dur(verdict.idleMs)}`, cmd: `paw optimize ${row.name}` };
  return undefined;
}

/** An orphan older than its agent's live process was left by an earlier incarnation — nothing tracks it
 *  any more. A younger one was detached ON PURPOSE by the agent running now (a `nohup` job), so it isn't
 *  cleanup, it's that agent's work. */
export function orphanAbandoned(o: Item & { agent: string }, fleet: Pick<Fleet, "agents">): boolean {
  const a = fleet.agents[o.agent];
  return !a || o.ageMs > a.ageMs;
}

/** Ports an agent's own background work listens on — a restart would orphan that server. */
export function serverPorts(procs: AgentProcs | undefined): number[] {
  return (procs?.items ?? []).filter((i) => i.kind === "task" || i.kind === "bg").flatMap((i) => i.ports);
}

export function verdictText(v: Verdict): string {
  if (v.act === "restart") return `→ restart (idle ${dur(v.idleMs)})`;
  if (v.act === "stop") return `■ stop: folder gone (idle ${dur(v.idleMs)})`;
  if (v.act === "skip") return `– skip: ${v.reason}`;
  return "– active recently";
}

export interface TopRow {
  name: string;
  state: string;
  mem?: number;
  cpu?: number;
  activeMs?: number;
  /** undefined: the agent has no process at all */
  items?: Item[];
  toolPid?: number;
  note?: string;
}

const tty = process.stdout.isTTY === true;
const paint = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
export const color = { dim: paint("2"), bold: paint("1"), red: paint("31"), yellow: paint("33"), green: paint("32") };
const fit = (s: string, w: number) => (s.length > w ? `${s.slice(0, Math.max(0, w - 1))}…` : s.padEnd(w));
const plain = (s: string) => s.replace(/\x1b\[\d+m/g, "");

/** The table `paw top` and `paw optimize` both print. `noteHeader` is HINT or VERDICT; it gets its own
 *  column when the terminal has room beside a readable SUBPROCS, else a `↳` line under the row. */
export function renderTable(rows: TopRow[], o: { width: number; now: number; noteHeader: string; verbose?: boolean }): string {
  const nameW = Math.min(26, Math.max(4, ...rows.map((r) => r.name.length)));
  const stateW = Math.min(16, Math.max(5, ...rows.map((r) => r.state.length)));
  const fixed = nameW + stateW + 6 + 5 + 6 + 10;
  const noteMax = Math.max(0, ...rows.map((r) => plain(r.note ?? "").length));
  const inline = noteMax > 0 && o.width - fixed - noteMax - 2 >= 40;
  const subW = Math.max(20, o.width - fixed - (inline ? noteMax + 2 : 0));
  const cells = rows.map((r) => (r.items ? subprocsCell(r.items, r.toolPid, subW) : "(no process)"));
  const subCol = Math.min(subW, Math.max(8, ...cells.map((c) => c.length)));
  const head = `${"NAME".padEnd(nameW)}  ${"STATE".padEnd(stateW)}  ${"MEM".padStart(6)} ${"CPU".padStart(5)}  ${"ACTIVE".padEnd(6)}  ${"SUBPROCS".padEnd(subCol)}${inline ? `  ${o.noteHeader}` : ""}`;
  const lines = [color.dim(head.trimEnd())];
  rows.forEach((r, i) => {
    const st = fit(r.state, stateW);
    const stc = /^[⚠⧗]/.test(r.state) ? color.yellow(st) : /idle|busy|working/.test(r.state) ? color.green(st) : color.dim(st);
    const cpu = r.cpu === undefined ? "?" : `${Math.round(r.cpu)}%`;
    const note = r.note ?? "";
    lines.push(
      `${color.bold(fit(r.name, nameW))}  ${stc}  ${fmtMb(r.mem).padStart(6)} ${cpu.padStart(5)}  ${fit(r.activeMs === undefined ? "—" : ago(r.activeMs, o.now), 6)}  ` +
        `${cells[i].padEnd(inline ? subCol : 0)}${inline && note ? `  ${note}` : ""}`.trimEnd(),
    );
    if (!inline && note) lines.push(`${" ".repeat(nameW + 2)}${color.dim("↳")} ${note}`);
    if (o.verbose) {
      for (const it of r.items ?? []) {
        const c = it.cpu === undefined ? "?" : `${Math.round(it.cpu)}%`;
        const what = `${it.pid === r.toolPid ? "tool" : it.kind}${it.label === it.kind ? "" : ` ${it.label}`}${it.stale ? " (npx)" : ""}${ports(it.ports)}`;
        lines.push(color.dim(`${" ".repeat(nameW + 2)}${String(it.pid).padStart(6)}  ${fit(what, 36)} ${fmtMb(it.mem).padStart(6)} ${c.padStart(5)}  ${dur(it.ageMs)}`));
      }
    }
  });
  return lines.join("\n");
}

/** Every live agent, and any agent with processes the manager doesn't list, as table rows. */
export function topRows(
  statuses: AgentStatus[],
  fleet: Fleet,
  now: number,
  note: (row: AgentStatus, procs: AgentProcs | undefined) => string | undefined,
): TopRow[] {
  const byName = new Map(statuses.map((s) => [s.name, s]));
  for (const name of Object.keys(fleet.agents)) {
    if (!byName.has(name)) byName.set(name, { name, folder: "", mesh: "offline", live: false, durable: false, conflictPids: [], inbox: { kind: "none" } });
  }
  return [...byName.values()]
    .filter((s) => s.live || fleet.agents[s.name])
    .map((s) => {
      const p = fleet.agents[s.name];
      return { name: s.name, state: stateText(s, p, now), mem: p?.mem, cpu: p?.cpu, activeMs: s.activeMs, items: p?.items, toolPid: p && toolItem(s, p.items, now)?.pid, note: note(s, p) };
    });
}

export function sortRows(rows: TopRow[], by: string): TopRow[] {
  const cmp: Record<string, (a: TopRow, b: TopRow) => number> = {
    mem: (a, b) => (b.mem ?? -1) - (a.mem ?? -1),
    cpu: (a, b) => (b.cpu ?? -1) - (a.cpu ?? -1),
    active: (a, b) => (b.activeMs ?? 0) - (a.activeMs ?? 0),
    name: (a, b) => a.name.localeCompare(b.name),
  };
  if (!cmp[by]) throw new Error(`paw: --sort takes mem, cpu, active or name (got "${by}")`);
  return [...rows].sort(cmp[by]);
}

/** Everything attributed to the space: agent trees plus orphans. */
export function pawMb(f: Fleet): number | undefined {
  return f.measured ? [...Object.values(f.agents), ...f.orphans].reduce((s, x) => s + (x.mem ?? 0), 0) : undefined;
}

export function machineLine(m: Machine, pawMb: number | undefined): string {
  const swap = m.swapUsedMb === undefined ? "swap ?" : `swap ${fmtMb(m.swapUsedMb)}`;
  const load = `load ${m.load.toFixed(0)}/${m.cores} cores`;
  return [
    `mem ${fmtMb(m.memUsedMb)}/${fmtMb(m.memTotalMb)} used (paw ${fmtMb(pawMb)})`,
    m.load > m.cores * 2 ? color.yellow(load) : load,
    (m.swapUsedMb ?? 0) > 2048 ? color.red(swap) : swap,
  ].join(" · ");
}
