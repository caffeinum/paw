/**
 * The `/status`-style header `paw attach` prints for an agent with no TUI (kit, headless `claude -p`):
 * what it runs on, where, which session, how full its context is, and its process — all from paw's own
 * records (persona, transcript, process table), never by asking the agent.
 */
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { personaValue, readAgentType, readCwd, readResumeId, transcriptPath } from "./session.ts";
import { lastUsage, tailRead } from "./transcript.ts";
import { meshIdentity } from "./named.ts";

const tilde = (p: string) => (p.startsWith(homedir()) ? "~" + p.slice(homedir().length) : p);
const kfmt = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

/** The agent's own process: the one whose environment says it is `name` in `space`. Pure apart from ps. */
function agentProcess(space: string, name: string, pattern: string): { pid: number; rssMb: number; etime: string } | undefined {
  let out = "";
  try {
    out = execFileSync("ps", ["-axo", "pid=,rss=,etime=,command="], { encoding: "utf8" });
  } catch {
    return undefined;
  }
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m || !m[4].includes(pattern)) continue;
    const pid = Number(m[1]);
    const id = meshIdentity(pid);
    if (id.name === name && id.space === space) return { pid, rssMb: Math.round(Number(m[2]) / 1024), etime: m[3] };
  }
  return undefined;
}

export function agentSummary(space: string, name: string, persona: string, headless: boolean): string {
  const agent = readAgentType(persona) ?? "claude";
  const provider = personaValue(persona, "provider");
  const model = personaValue(persona, "model");
  const harness = agent === "kit" ? `kit · ${provider ?? "?"}${model ? ` · ${model}` : " · (kit default model)"}` : `${headless ? "claude -p (headless)" : agent}${model ? ` · ${model}` : ""}`;
  const pin = readResumeId(persona);
  const file = pin ? transcriptPath(pin) : undefined;
  const usage = file ? lastUsage(tailRead(file, 128 * 1024).split("\n").filter(Boolean)) : undefined;
  const ctx = usage ? `${kfmt(usage.tokens)}${usage.limit ? `/${kfmt(usage.limit)} ${Math.round((usage.tokens / usage.limit) * 100)}%` : ""}` : "—";
  const proc = agentProcess(space, name, agent === "kit" ? "kit run" : "claude");
  const cwd = readCwd(persona);
  const rows: Array<[string, string]> = [
    ["agent", `${name} · space ${space}`],
    ["harness", harness],
    ["folder", cwd ? tilde(cwd) : "—"],
    ["session", pin ? `${pin}${file ? `  (${tilde(file)})` : "  (no transcript yet)"}` : "— (no pin)"],
    ["context", ctx],
    ["process", proc ? `pid ${proc.pid} · ${proc.rssMb}MB rss · up ${proc.etime}` : "not running"],
  ];
  return rows.map(([k, v]) => `  ${k.padEnd(8)} ${v}`).join("\n");
}
