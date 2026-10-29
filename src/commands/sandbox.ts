/**
 * `paw sandbox build` — build paw's sandbox image (src/sandbox/Containerfile) with Apple's `container`.
 * `paw sandbox ls [--json]` — EVERY paw sandbox container on this machine (VMs are per machine, so this is a
 *   machine view: the `--space` the dispatcher appends to every verb is accepted and ignored): agent#space, state,
 *   memory in use / limit, its persistent home ($PAW_HOME/containers/<name>), and whether a paw launcher still owns it (an `orphan` is a VM whose launcher was
 *   SIGKILLed — the agent's next launch removes it, or `container delete --force <id>` now), and the VM ports its
 *   launcher forwards to the host's loopback (from the launcher's `forwards.json`).
 * `paw sandbox shell <agent>[#space]` — an interactive login bash in the agent's RUNNING VM, in its folder
 *   (`container exec -it`): the VM's PATH, HOME and ~/.env, a real TTY (OAuth logins, REPLs). Not running → fails loud.
 * docs/notes/sandbox.md.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { registry, type Command } from "@cotal-ai/core";
import { pawHomeDir } from "../lifecycle.ts";
import { CONTAINERFILE, containerBin, defaultSandboxImage, listSandboxContainers, readSandboxHomeOwner, sandboxHomeDir, type SandboxContainer } from "../sandbox.ts";
import { writeJson, writeOut } from "../stdout.ts";
import { personaFilePath } from "../addressing.ts";
import { liveSandboxContainer, sandboxShellArgv } from "../sandbox-exec.ts";
import { readCwd, readSandbox } from "../session.ts";

const USAGE = "sandbox build | sandbox ls [--json] | sandbox shell <agent>[#space]";

/** Drop the `--space <s>` bin/paw.ts appends to every verb (withDefaultSpace): both subcommands are per machine. */
function dropSpace(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--space" && argv[i + 1] !== undefined) i++;
    else out.push(argv[i]);
  }
  return out;
}

function build(argv: string[]): void {
  if (argv.length) throw new Error(`paw: \`sandbox build\` takes no arguments — ${USAGE}`);
  const bin = containerBin();
  const image = defaultSandboxImage();
  console.log(`paw: building ${image} from ${CONTAINERFILE}`);
  const r = spawnSync(bin, ["build", "--progress", "plain", "-t", image, "-f", CONTAINERFILE, dirname(CONTAINERFILE)], { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`paw: \`container build\` failed (${r.status ?? r.error?.message})`);
  // `container build` leaves its BuildKit VM running (~4 GB resident on the mini) — a one-shot build doesn't need it.
  const stop = spawnSync(bin, ["builder", "stop"], { encoding: "utf8", timeout: 60_000 });
  if (stop.status !== 0) console.error(`paw: built, but \`container builder stop\` failed — the builder VM still holds its memory (${(stop.stderr || stop.error?.message || "").trim()})`);
  console.log(`paw: built ${image} — sandboxed agents (persona \`sandbox: container\`) launch from it`);
}

/** container id → memory in use (bytes), from one `container stats --no-stream` of the running ones. */
function memoryInUse(bin: string, ids: string[]): Map<string, number> {
  if (!ids.length) return new Map();
  const r = spawnSync(bin, ["stats", "--no-stream", "--format", "json", ...ids], { encoding: "utf8", timeout: 30_000 });
  if (r.status !== 0) throw new Error(`paw: \`container stats\` failed (${(r.stderr || r.error?.message || "").trim()})`);
  const rows = JSON.parse(r.stdout || "[]") as Array<{ id: string; memoryUsageBytes?: number }>;
  return new Map(rows.flatMap((s) => (typeof s.memoryUsageBytes === "number" ? [[s.id, s.memoryUsageBytes] as const] : [])));
}

/** Container ids a live paw launcher (bin/paw-sandbox-run.mjs) still owns, from its `--name <id>` argv. */
function launcherOwned(): Set<string> {
  const ps = execFileSync("/bin/ps", ["-A", "-o", "command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const owned = new Set<string>();
  for (const line of ps.split("\n")) {
    if (!line.includes("paw-sandbox-run.mjs")) continue;
    const m = line.match(/ --name (\S+)/);
    if (m) owned.add(m[1]);
  }
  return owned;
}

/** The ports the launcher of container `id` forwards (bin/paw-sandbox-forward.mjs writes `forwards.json` beside
 *  launcher.log); undefined when it writes none (forwarding off, no launcher) or the file is an older launch's. */
export function readForwards(home: string, space: string, agent: string, id: string): { ports: number[]; skipped: number[] } | undefined {
  const f = join(home, "spaces", space, "sandbox", agent, "forwards.json");
  if (!existsSync(f)) return undefined;
  const s = JSON.parse(readFileSync(f, "utf8")) as { container?: string; ports?: number[]; skipped?: number[] };
  if (s.container !== id) return undefined;
  if (!Array.isArray(s.ports) || !Array.isArray(s.skipped)) throw new Error(`paw: ${f} has no ports/skipped lists`);
  return { ports: s.ports, skipped: s.skipped };
}
const portList = (f: { ports: number[]; skipped: number[] } | undefined) =>
  !f ? "-" : [...f.ports.map(String), ...f.skipped.map((p) => `${p}(host busy)`)].join(",") || "-";

const mb = (b: number | undefined) => (b === undefined ? "?" : `${Math.round(b / (1024 * 1024))}M`);

function ls(argv: string[]): void {
  let json = false;
  for (const a of argv) {
    if (a === "--json") json = true;
    else throw new Error(`paw: unknown argument "${a}" — ${USAGE}`);
  }
  const bin = containerBin();
  const all: SandboxContainer[] = listSandboxContainers(bin);
  const used = memoryInUse(bin, all.filter((c) => c.state === "running").map((c) => c.id));
  const owned = launcherOwned();
  const rows = all.map((c) => ({
    ...c,
    memoryUsedBytes: used.get(c.id),
    launcher: owned.has(c.id) ? "live" : "orphan",
    forwards: readForwards(pawHomeDir(), c.space, c.agent, c.id),
    home: readSandboxHomeOwner(c.agent) === c.space ? sandboxHomeDir(c.agent) : undefined,
  }));
  if (json) return writeJson(rows);
  if (!rows.length) return writeOut("no sandboxed agents on this machine (no paw sandbox containers)\n");
  const table = [["AGENT", "STATE", "MEM USED/LIMIT", "LAUNCHER", "IP", "PORTS", "CONTAINER", "HOME"], ...rows.map((r) => [`${r.agent}#${r.space}`, r.state, `${mb(r.memoryUsedBytes)}/${mb(r.memoryBytes)}`, r.launcher, r.ip ?? "-", portList(r.forwards), r.id, r.home ?? "-"])];
  const w = table[0].map((_, i) => Math.max(...table.map((row) => row[i].length)));
  writeOut(table.map((row) => row.map((v, i) => v.padEnd(w[i])).join("  ").trimEnd()).join("\n") + "\n");
  const orphans = rows.filter((r) => r.launcher === "orphan");
  if (orphans.length) writeOut(`\n${orphans.length} orphan(s): no paw launcher owns them — the agent's next launch removes them, or now: container delete --force ${orphans.map((o) => o.id).join(" ")}\n`);
}

function shell(argv: string[]): void {
  let space: string | undefined;
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--space" && argv[i + 1] !== undefined) space = argv[++i];
    else if (argv[i].startsWith("-")) throw new Error(`paw: unknown flag "${argv[i]}" — ${USAGE}`);
    else pos.push(argv[i]);
  }
  if (pos.length !== 1 || !space) throw new Error(`paw: \`sandbox shell\` takes one agent — ${USAGE}`);
  const name = pos[0];
  const persona = personaFilePath(space, name);
  if (!existsSync(persona)) throw new Error(`paw: no agent "${name}" on space "${space}" (no persona at ${persona})`);
  if (!readSandbox(persona)) throw new Error(`paw: "${name}" is not sandboxed (no \`sandbox: container\` in ${persona}) — its folder is on this machine; just cd there`);
  const cwd = readCwd(persona);
  if (!cwd) throw new Error(`paw: "${name}"'s persona ${persona} has no cwd:`);
  const bin = containerBin();
  const r = spawnSync(bin, sandboxShellArgv(liveSandboxContainer(space, name, bin), cwd), { stdio: "inherit" });
  if (r.error) throw new Error(`paw: could not run \`${bin} exec\`: ${r.error.message}`);
  process.exitCode = r.status ?? 1;
}

const sandboxCommand: Command = {
  kind: "command",
  name: "sandbox",
  group: "Lifecycle",
  summary: "sandboxed agents (Apple container VMs) — sandbox build | sandbox ls | sandbox shell <agent>",
  usage: USAGE,
  run: async (a) => {
    if (a.raw[0] === "shell") return shell(a.raw.slice(1));
    const [sub, ...rest] = dropSpace([...a.raw]);
    if (sub === "build") return build(rest);
    if (sub === "ls") return ls(rest);
    throw new Error(`paw: ${USAGE}`);
  },
};

registry.register(sandboxCommand);
