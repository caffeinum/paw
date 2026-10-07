/**
 * The `/status`-style header `paw attach` prints for an agent with no TUI (kit, headless `claude -p`):
 * what it runs on, where, which session, how full its context is, and its process — all from paw's own
 * records (persona, transcript, process table), never by asking the agent.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { personaTranscriptRoots, personaValue, readAgentType, readCwd, readKitStorage, readResumeId, transcriptPath } from "./session.ts";
import { lastModel, lastUsage, tailRead } from "./transcript.ts";
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
  const harness = agent === "kit" ? `kit · ${provider ?? "?"}${model ? ` · ${model}` : " · (kit default model)"} · ${readKitStorage(persona)} store` :`${headless ? "claude -p (headless)" : agent}${model ? ` · ${model}` : ""}`;
  const pin = readResumeId(persona);
  const file = pin ? transcriptPath(pin, personaTranscriptRoots(persona)) : undefined;
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

/** The two lines `paw chat <agent>` shows under its banner: what the agent runs on and how full its
 *  context is — read from paw's own records (persona + transcript tail), never by asking the agent.
 *  The model is the one its newest turn actually used; the persona's `model:` only when there is none. */
export function chatAgentInfo(persona: string): { model: string; context: string } {
  const agent = readAgentType(persona) ?? "claude";
  const pin = readResumeId(persona);
  const file = pin ? transcriptPath(pin, personaTranscriptRoots(persona)) : undefined;
  const lines = file ? tailRead(file, 256 * 1024).split("\n").filter(Boolean) : [];
  const usage = lines.length ? lastUsage(lines) : undefined;
  const ran = lines.length ? lastModel(lines) : undefined;
  const asked = personaValue(persona, "model");
  const provider = agent === "kit" ? personaValue(persona, "provider") : undefined;
  const model = [agent === "claude" ? undefined : agent, provider, ran ?? asked ?? "(default)"].filter(Boolean).join(" · ") + (ran && asked && ran !== asked ? ` (persona says ${asked})` : "");
  // kit agents: the real window comes from kit's own model listing (claude's inference doesn't apply)
  const window = agent === "kit" ? kitModelWindow(ran ?? asked) : usage?.limit;
  const context = usage ? `${kfmt(usage.tokens)}${window ? ` / ${kfmt(window)} · ${Math.round((usage.tokens / window) * 100)}%` : ""}` : pin ? "— (no turns yet)" : "— (no session)";
  return { model, context };
}

/** A model's context window from kit's cached listing (`kit models` → <KIT_HOME>/models.json), or
 *  undefined when kit hasn't listed it — the banner then shows the token count alone. */
function kitModelWindow(model: string | undefined): number | undefined {
  if (!model) return undefined;
  const f = join(process.env.KIT_HOME?.trim() || join(homedir(), ".kit"), "models.json");
  if (!existsSync(f)) return undefined;
  const cache = JSON.parse(readFileSync(f, "utf8")) as { models?: Array<{ id?: string; context?: number }> };
  const hit = cache.models?.find((m) => m.id === model);
  return typeof hit?.context === "number" && hit.context > 0 ? hit.context : undefined;
}
