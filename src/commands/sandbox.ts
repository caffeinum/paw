/**
 * `paw sandbox build` — build paw's sandbox image (src/sandbox/Containerfile) with Apple's `container`.
 * `paw sandbox ls [--space <s>] [--json]` — paw's sandbox containers on this machine: which agent, its state,
 *   memory in use / limit, and whether a paw launcher still owns it (an `orphan` is a VM whose launcher was
 *   SIGKILLed — the agent's next launch removes it, or `container delete --force <id>` now).
 * docs/notes/sandbox.md.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { registry, type Command } from "@cotal-ai/core";
import { CONTAINERFILE, containerBin, defaultSandboxImage, listSandboxContainers, type SandboxContainer } from "../sandbox.ts";
import { writeJson, writeOut } from "../stdout.ts";

const USAGE = "sandbox build | sandbox ls [--space <s>] [--json]";

function build(argv: string[]): void {
  if (argv.length) throw new Error(`paw: \`sandbox build\` takes no arguments — ${USAGE}`);
  const bin = containerBin();
  const image = defaultSandboxImage();
  console.log(`paw: building ${image} from ${CONTAINERFILE}`);
  const r = spawnSync(bin, ["build", "--progress", "plain", "-t", image, "-f", CONTAINERFILE, dirname(CONTAINERFILE)], { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`paw: \`container build\` failed (${r.status ?? r.error?.message})`);
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

const mb = (b: number | undefined) => (b === undefined ? "?" : `${Math.round(b / (1024 * 1024))}M`);

function ls(argv: string[]): void {
  let space: string | undefined;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--json") json = true;
    else if (argv[i] === "--space" && argv[i + 1]) space = argv[++i];
    else throw new Error(`paw: unknown argument "${argv[i]}" — ${USAGE}`);
  }
  const bin = containerBin();
  const all: SandboxContainer[] = listSandboxContainers(bin).filter((c) => !space || c.space === space);
  const used = memoryInUse(bin, all.filter((c) => c.state === "running").map((c) => c.id));
  const owned = launcherOwned();
  const rows = all.map((c) => ({ ...c, memoryUsedBytes: used.get(c.id), launcher: owned.has(c.id) ? "live" : "orphan" }));
  if (json) return writeJson(rows);
  if (!rows.length) return writeOut(`no sandboxed agents${space ? ` on ${space}` : ""} (paw sandbox containers on this machine: none)\n`);
  const table = [["AGENT", "STATE", "MEM USED/LIMIT", "LAUNCHER", "IP", "CONTAINER"], ...rows.map((r) => [`${r.agent}#${r.space}`, r.state, `${mb(r.memoryUsedBytes)}/${mb(r.memoryBytes)}`, r.launcher, r.ip ?? "-", r.id])];
  const w = table[0].map((_, i) => Math.max(...table.map((row) => row[i].length)));
  writeOut(table.map((row) => row.map((v, i) => v.padEnd(w[i])).join("  ").trimEnd()).join("\n") + "\n");
  const orphans = rows.filter((r) => r.launcher === "orphan");
  if (orphans.length) writeOut(`\n${orphans.length} orphan(s): no paw launcher owns them — the agent's next launch removes them, or now: container delete --force ${orphans.map((o) => o.id).join(" ")}\n`);
}

const sandboxCommand: Command = {
  kind: "command",
  name: "sandbox",
  group: "Lifecycle",
  summary: "sandboxed agents (Apple container VMs) — sandbox build | sandbox ls",
  usage: USAGE,
  run: async (a) => {
    const [sub, ...rest] = a.raw;
    if (sub === "build") return build(rest);
    if (sub === "ls") return ls(rest);
    throw new Error(`paw: ${USAGE}`);
  },
};

registry.register(sandboxCommand);
