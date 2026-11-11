/**
 * The problems TUI on a fixture — no mesh, no manager, no agent. `fixtureReport` is shared with
 * check:top's reducer section; run directly, it drives `runProblemsTui` with a `run` that only APPENDS each
 * argv (one JSON line) to the file named by `--record`, for check:problems-tty under a real pty.
 *
 *   node scripts/fixtures/problems-tui-harness.ts --record <file> [--queued N]
 */
import { appendFileSync } from "node:fs";
import type { AgentStatus } from "../../src/status.ts";
import type { ProblemsReport, SpaceInput } from "../../src/problems.ts";

const M = 60_000;
const H = 3_600_000;

/** Four problems: canary (dead, here), research (inbox, live, here), queue (hung tool, here), lizard (offline on another machine). */
export async function fixtureReport(now: number, o: { queued?: number } = {}): Promise<ProblemsReport> {
  const P = await import("../../src/problems.ts");
  const here = { label: "aleks-macbook", via: "manager" as const, here: true };
  const row = (name: string, x: Partial<AgentStatus> = {}): AgentStatus => ({ name, space: "paw", folder: `/w/${name}`, mesh: "idle", live: true, durable: true, conflictPids: [], inbox: { kind: "none" }, busy: false, host: here, ...x });
  const input = (space: string, rows: AgentStatus[]): SpaceInput => ({ space, machine: "aleks-macbook", managerDown: false, rows, sleep: new Map(), wedges: new Map(), asks: [], gone: new Set(), ownedHere: () => space === "paw" });
  const paw = input("paw", [
    row("canary", { live: false, mesh: "offline", host: undefined, seat: "exited", activeMs: now - 3 * H }),
    row("research", { inbox: { kind: "lag", queued: o.queued ?? 3, unread: 0 }, activeMs: now - 2 * H }),
    row("queue", { busy: true, tool: { id: "toolu_1", name: "Bash", summary: "fly ssh console -a q", startedMs: now - 47 * M } }),
  ]);
  const team = input("team2027", [
    row("lizard", { space: "team2027", live: false, mesh: "offline", host: { label: "aleks-mac-mini", via: "teleport", here: false }, elsewhere: { how: "teleported", where: "aleks-mac-mini" }, durable: false }),
  ]);
  return {
    now,
    machine: "aleks-macbook",
    spaces: [
      { space: "paw", remote: false, server: "nats://127.0.0.1:4222", read: "ok" },
      { space: "team2027", remote: true, server: "tls://2027-cotal.fly.dev:4222", read: "ok" },
    ],
    notRead: [],
    problems: P.sortProblems([...P.classify(paw, now), ...P.classify(team, now)]),
    errors: [],
  };
}

const arg = (k: string) => {
  const i = process.argv.indexOf(k);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

if (process.argv.includes("--record")) {
  const record = arg("--record")!;
  const queued = Number(arg("--queued") ?? 3);
  const { runProblemsTui } = await import("../../src/problems-tui.ts");
  const code = await runProblemsTui({
    collect: () => fixtureReport(Date.now(), { queued }),
    run: async (argv) => {
      appendFileSync(record, JSON.stringify(argv) + "\n");
      return 0;
    },
    refreshMs: 200,
  });
  process.stdout.write(`\nTUI_EXIT ${code}\n`);
  process.exit(code);
}
