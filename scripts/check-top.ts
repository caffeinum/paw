/**
 * `paw top` / the fleet snapshot: process attribution from a ps fixture (title-rewritten `npm exec`,
 * ppid-1 orphans, another space), classification, the footprint/lsof/cpu parses, hint + verdict
 * selection, and the table layout. Pure — no ps, no mesh. Run: pnpm check:top
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PAW_HOME = mkdtempSync(join(tmpdir(), "paw-top-home-"));
const f = await import("../src/fleet.js");
const { parseTopArgs } = await import("../src/commands/top.js");
const { optimizeVerdict } = await import("../src/commands/optimize.js");

let n = 0;
const ok = (c: boolean, m: string) => {
  if (!c) throw new Error(`top: ${m}`);
  n++;
  console.log(`  ok  ${m}`);
};

const S = "COTAL_SPACE=paw";
// pid ppid pgid etime time command(+env)
const PS = [
  `    1     0     1 07-00:00:00   1:00.00 /sbin/launchd`,
  `  500     1   500 07-00:00:00   0:10.00 tmux new-session -d -s cotal-paw`,
  // queue: claude + cotal mcp + npx tracepaper chain (npm exec hides env) + a stuck Bash tool + a bg dev server
  `  600   500   600    01:00:00   5:00.00 claude --dangerously-load-development-channels server:cotal HOME=/u COTAL_NAME=queue ${S}`,
  `  601   600   600    01:00:00   0:30.00 node /r/@cotal-ai/connector-claude-code/dist/mcp.cjs COTAL_NAME=queue ${S}`,
  `  602   600   600    01:00:00   0:01.00 npm exec github:caffeinum/tracepaper   `,
  `  603   602   600    01:00:00   0:02.00 node /u/.npm/_npx/f5/node_modules/.bin/tracepaper COTAL_NAME=queue ${S}`,
  `  610   600   610       51:00   0:00.50 /bin/zsh -c source /u/.claude/shell-snapshots/snapshot-zsh-1.sh 2>/dev/null || true && eval 'fly ssh console -a q' < /dev/null COTAL_NAME=queue ${S}`,
  `  611   610   610       51:00   0:00.20 fly ssh console -a q COTAL_NAME=queue ${S}`,
  `  620   600   620    03:00:00   0:40.00 /bin/zsh -c source /u/.claude/shell-snapshots/snapshot-zsh-2.sh && eval 'pnpm dev' COTAL_NAME=queue ${S}`,
  `  621   620   620    03:00:00   0:40.00 node /x/vite PORT=3000 COTAL_NAME=queue ${S}`,
  `  630   600   630       00:01   0:00.01 node /u/.claude/hook.cjs COTAL_NAME=queue ${S}`,
  // an orphan left by a previous queue incarnation, and one detached by the running one
  `  700     1   700 01-16:00:00   0:05.00 ugrep -G pattern COTAL_NAME=queue ${S}`,
  `  701     1   701       10:00   0:05.00 canary run --x COTAL_NAME=queue ${S}`,
  // an orphaned npx chain: npm exec (no env) under launchd, the stamp one level down
  `  710     1   710 07-00:00:00   0:02.00 npm exec vibeos-mcp@0.2.2 --token t   `,
  `  711   710   710 07-00:00:00   7:54.00 node /u/.npm/_npx/14/node_modules/.bin/vibeos-mcp COTAL_NAME=vibeos-mcp ${S}`,
  // two roots for one name, another space, and a claude outside the mesh
  `  800   500   800    02:00:00   1:00.00 claude --resume a COTAL_NAME=dup ${S}`,
  `  801   500   801    01:00:00   1:00.00 claude --resume a COTAL_NAME=dup ${S}`,
  `  900   500   900    02:00:00   1:00.00 claude COTAL_NAME=queue COTAL_SPACE=other`,
  `  950     1   950    04:00:00   9:00.00 /u/.local/bin/claude --settings x TERM=xterm`,
].join("\n");

const procs = f.parsePs(PS);
ok(procs.length === 19, "ps fixture parses every row");
ok(f.parseClock("01-16:26:38") === (86400 + 16 * 3600 + 26 * 60 + 38) * 1000 && f.parseClock("135:53.21") === 8153210, "etime (dd-hh:mm:ss) and cumulative time (mmm:ss.cc)");
ok(procs[2].agent === "queue" && procs[2].space === "paw" && procs[2].argv.startsWith("claude --dangerously") && !procs[2].argv.includes("HOME="), "env stamp read; argv cut before the env");

const g = f.groupProcs(procs, "paw", true);
ok([...g.agents.keys()].sort().join() === "dup,queue", "roots: queue + dup, not the other space");
ok(g.agents.get("queue")!.roots.length === 1, "a title-rewritten npm exec child is NOT a second root");
ok(g.agents.get("dup")!.roots.length === 2, "two live roots for one name are both kept (a duplicate, never a pick)");
ok(g.orphans.map((o) => o.tree[0].pid).sort().join() === "700,701,710", "ppid-1 stamped processes are orphans; an orphaned npx chain is headed by npm exec");
ok(g.orphans.find((o) => o.tree[0].pid === 710)!.agent === "vibeos-mcp", "orphan attributed to the stamped descendant's agent");
ok(g.other.length === 1 && g.other[0][0].pid === 950, "--all: a claude with no stamp is 'not paw'");
ok(f.groupPids(f.groupProcs(procs, "paw")).length === 15, "measured pids = agent trees + orphans (no 'other' without --all)");

const mem = f.parseFootprint(
  [600, 601, 602, 603, 610, 611, 620, 621, 630, 700, 701, 710, 711, 800, 801, 950]
    .map((p) => `======\nx [${p}]: 64-bit    Footprint: ${100 * 1048576} B (16384 bytes per page)\n======\n`)
    .join("") + "footprint: Unable to find pid for process matching '99'",
);
ok(mem.size === 16 && mem.get(600) === 100, "footprint output → MB per pid (a vanished pid doesn't break the parse)");
const ports = f.parseLsof("p621\nf20\nn*:3000\nf21\nn127.0.0.1:3000\np701\nf9\nn*:8123\n");
ok(ports.get(621)!.join() === "3000" && ports.get(701)!.join() === "8123", "lsof -F → ports per pid, deduped");
const cpu = f.cpuPercent(new Map([[600, 1000], [601, 0]]), f.parseCpuTimes("  600   0:01.50\n  601   0:00.00\n  999   0:09.00\n"), 1000);
ok(Math.round(cpu.get(600)!) === 50 && cpu.get(601) === 0 && !cpu.has(999), "cpu = Δ cumulative time / wall; a pid new in the second read is left out");

const fleet = f.buildFleet(f.groupProcs(procs, "paw"), { mem, cpu, ports }, { load: 1, cores: 10 });
const q = fleet.agents.queue;
const kind = (pid: number) => q.items.find((i) => i.pid === pid)!;
ok(kind(601).kind === "mcp" && kind(602).kind === "tp" && kind(602).stale === true, "cotal mcp; npx tracepaper chain is tp + stale");
ok(kind(610).kind === "task" && kind(610).label === "fly ssh console", "a Bash tool shell is a task labelled by its eval'd command");
ok(kind(620).ports.join() === "3000" && kind(630).kind === "hook", "a bg task carries its subtree's ports; hook.cjs is a hook");
ok(q.mem === 900 && kind(602).mem === 200, "memory sums the whole tree / the item's subtree");
ok(Math.round(q.cpu!) === 50, "cpu sums the tree");
ok(f.shortLabel("npm exec vibeos-mcp@0.2.2 --token t") === "vibeos-mcp@0.2.2" && f.shortLabel("/opt/homebrew/bin/fly agent run /x.log") === "fly agent" && f.shortLabel("pnpm dev") === "pnpm dev", "short labels");
ok(f.orphanAbandoned(fleet.orphans.find((o) => o.pid === 700)!, fleet) && !f.orphanAbandoned(fleet.orphans.find((o) => o.pid === 701)!, fleet), "an orphan older than its agent is abandoned; a younger one was detached by the running agent");

// ---- state, hints, verdicts ----
const now = 10_000_000_000;
const H = 3_600_000;
const base = { name: "queue", folder: "/tmp", mesh: "idle", live: true, runtime: "tmux", pin: "p", durable: true, activeMs: now - 30 * H, busy: false, conflictPids: [], inbox: { kind: "lag", queued: 0, unread: 0 } } as const;
const row = (o: object = {}) => ({ ...base, ...o }) as never;
const names = new Set(["queue", "queue_2", "dup"]);
const verdict = (r: never, p = q) => optimizeVerdict(r, p.roots.map((pid) => ({ pid })), now, { sinceMs: 24 * H, ports: f.serverPorts(p) });
const hint = (r: never, p: typeof q | undefined = q) => f.hintFor(r, p, verdict(r, p ?? q), now, names);
const stuckTool = { id: "t", name: "Bash", summary: "fly ssh", startedMs: now - 51 * 60_000 };
const stuck = row({ tool: stuckTool });

ok(f.stateText(stuck, q, now) === "⧗ Bash 51m", "stuck tool wins the state cell");
ok(f.stateText(row({ failure: { text: "You've reached your limit", ts: 0 } }), q, now) === "⚠ limit", "a runtime failure shows as limit/login");
ok(f.stateText(row(), fleet.agents.dup, now) === "⚠ 2 procs", "two roots → duplicate state");
ok(f.stateText(row({ busy: true }), q, now) === "busy", "otherwise busy/idle");
ok(hint(stuck)?.cmd === "paw unstick queue", "stuck tool on tmux → paw unstick");
ok(hint(row({ tool: { ...stuckTool, startedMs: now - 6 * 60_000 } }))?.text === "in a tool for 6m" && !hint(row({ tool: { ...stuckTool, startedMs: now - 6 * 60_000 } }))?.cmd, "a 6-minute tool is long, not stuck — no Esc before the keeper's 30m");
ok(hint(row({ tool: stuckTool, runtime: "pty" }))?.cmd === undefined, "stuck on pty → a note, no command");
ok(hint(row({ name: "ghost" }))?.cmd === "kill 600", "a process no registry/manager knows → kill");
ok(hint(row({ live: false }))?.cmd === "paw log queue", "running but off the mesh → look first, never kill");
ok(hint(row({ name: "queue_2" }))?.cmd === "paw stop --name queue_2", "<name>_N duplicate → paw stop --name");
ok(hint(row({ conflictPids: [600, 4242] }))?.cmd === "paw adopt /tmp --force" && hint(row({ conflictPids: [600, 4242] }))!.text.includes("4242"), "two writers → names the foreign pid, adopt --force takes over");
ok(hint(row({ failure: { text: "Login expired", ts: 0 } }))?.cmd === undefined, "failure → note only");
ok(hint(row({ folder: "/definitely/gone" }), { ...q, items: q.items.filter((i) => i.pid !== 620) })?.cmd === "paw stop queue", "folder gone + idle → paw stop");
ok(hint(row())?.cmd === "paw restart queue", "npx tracepaper → paw restart");
ok(hint(row({ unregistered: { agent: "claude" } }))?.cmd === undefined, "npx tracepaper on an unregistered peer → no restart command (paw restart can't reach it)");
const noTp = { ...q, items: q.items.filter((i) => i.kind !== "tp") };
ok(hint(row(), noTp)?.cmd === "kill 620", "a bg server → kill its pid");
const quiet = { ...q, items: q.items.filter((i) => i.kind !== "tp" && i.pid !== 620) };
ok(hint(row(), quiet)?.cmd === "paw optimize queue", "idle >24h, nothing else → paw optimize <name>");
ok(verdict(row(), q).act === "skip" && (verdict(row(), q) as { reason: string }).reason.includes(":3000"), "optimize skips an agent holding a live server");
ok(f.verdictText(verdict(row(), quiet)) === "→ restart (idle 1d)", "verdict text");

// ---- the table ----
const older = row({ tool: { id: "t", name: "Bash", summary: "fly", startedMs: now - 2 * H } });
ok(f.toolItem(older, q.items, now) === undefined, "a tool is matched only to a task that started when the tool_use did");
ok(f.toolItem(stuck, q.items, now)?.pid === 610, "…and found when it did");
const cell = f.subprocsCell(q.items, 610, 200);
ok(cell.startsWith("⧗ fly ssh console (51m)") && cell.includes("bg: pnpm dev :3000 3h 200M") && cell.includes("tp(npx) 200M") && !cell.includes("hook"), `subprocs cell: tool first, bg with port/age/mem, hooks hidden — ${cell}`);
ok(f.subprocsCell([...q.items, { ...kind(601), pid: 1 }], undefined, 200).includes("mcp ×2 200M"), "duplicates collapse ×N with summed memory");
ok(/ \+\d$/.test(f.subprocsCell(q.items, 610, 30)), "overflow truncates with +N, never mid-part");
const rows = f.topRows([stuck], { ...fleet, agents: { queue: { ...q, items: q.items.map((i) => (i.pid === 610 ? { ...i, ageMs: 51 * 60_000 } : i)) } } }, now, () => "paw unstick queue");
ok(rows.length === 1 && rows[0].toolPid === 610 && rows[0].state === "⧗ Bash 51m", "topRows wires state + tool");
const wide = f.renderTable(rows, { width: 200, now, noteHeader: "HINT" }).split("\n");
ok(wide[0].includes("HINT") && wide.length === 2 && wide[1].endsWith("paw unstick queue"), "wide: HINT is a column");
const narrow = f.renderTable(rows, { width: 100, now, noteHeader: "HINT" }).split("\n");
ok(!narrow[0].includes("HINT") && narrow[2].includes("↳ paw unstick queue"), "narrow: the hint moves to its own line");
ok(f.renderTable(rows, { width: 200, now, noteHeader: "HINT", verbose: true }).includes("tool fly ssh console"), "-v expands the items");
ok(f.sortRows([{ name: "a", state: "", mem: 1 }, { name: "b", state: "", mem: 9 }], "mem")[0].name === "b", "sort by mem desc");
let threw = false;
try { parseTopArgs(["--sort", "rss"]); } catch { threw = true; }
ok(threw && parseTopArgs(["-v", "--all", "--json", "queue"]).names[0] === "queue", "args: flags, names; bad --sort fails loud");
ok(f.parseVmStat("Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages wired down: 100.\nPages purgeable: 0.\nAnonymous pages: 200.\nPages occupied by compressor: 100.\n") === (400 * 16384) / 1048576, "vm_stat → used MB");

console.log(`✓ check:top — ${n} assertions`);
