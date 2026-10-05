// What the fleet would cost on a per-token API key, from its own transcripts (read-only).
//
//   node scripts/lean/fleet-usage.ts [--days 7] [--space paw]
//
// Fleet = sessions pinned by a persona's `resume:` (subagent transcripts under them count too).
// Each API response is counted ONCE: claude writes one record per content block and repeats the
// usage on each, so records are deduplicated by (message.id, requestId). List prices per MTok,
// fetched 2026-10-05 from platform.claude.com/docs/en/about-claude/pricing — update PRICES when they move.
import { createReadStream, readdirSync, readFileSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";

type Price = [input: number, write5m: number, write1h: number, read: number, output: number];
const PRICES: Record<string, Price> = {
  "claude-opus-5-5": [4, 5, 8, 0.2, 20],
  "claude-opus-5": [5, 6.25, 10, 0.5, 25],
  "claude-opus-4-8": [5, 6.25, 10, 0.5, 25],
  "claude-opus-4-6": [5, 6.25, 10, 0.5, 25],
  "claude-sonnet-5-5": [2, 2.5, 4, 0.2, 10],
  "claude-sonnet-5": [2, 2.5, 4, 0.2, 10],
  "claude-haiku-4-5-20251001": [1, 1.25, 2, 0.1, 5],
  "claude-fable-5-1": [10, 12.5, 20, 0.25, 50],
  "claude-fable-5": [10, 12.5, 20, 0.25, 50],
};

const arg = (name: string, dflt: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const days = Number(arg("--days", "7"));
const space = arg("--space", "paw");
const since = Date.now() - days * 86_400_000;
const cutIso = new Date(since).toISOString();

const personas = join(process.env.PAW_HOME ?? join(homedir(), ".paw"), "spaces", space, "personas");
const pins = new Set(
  readdirSync(personas).filter((f) => f.endsWith(".md")).flatMap((f) => {
    const m = /^resume:\s*(\S+)/m.exec(readFileSync(join(personas, f), "utf8"));
    return m ? [m[1]] : [];
  }),
);

function* transcripts(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* transcripts(p);
    else if (e.name.endsWith(".jsonl") && statSync(p).mtimeMs >= since) yield p;
  }
}

const projects = join(homedir(), ".claude", "projects");
const seen = new Set<string>();
const tokens = { calls: 0, input: 0, read: 0, w5m: 0, w1h: 0, output: 0 };
const perAgent = new Map<string, number>();
const tools = new Map<string, number>();
const unpriced = new Set<string>();

for (const f of transcripts(projects)) {
  const rel = f.slice(projects.length + 1).split("/");
  const session = rel.length === 2 ? rel[1].replace(/\.jsonl$/, "") : rel[1];
  if (!pins.has(session)) continue;
  for await (const line of createInterface({ input: createReadStream(f) })) {
    if (!line.includes('"assistant"')) continue;
    let r: any;
    try { r = JSON.parse(line); } catch { continue; }
    if (r.type !== "assistant" || (r.timestamp ?? "") < cutIso) continue;
    const m = r.message ?? {};
    for (const b of m.content ?? []) {
      if (b?.type !== "tool_use") continue;
      const name = b.name.startsWith("mcp__") ? `mcp__${b.name.split("__")[1]}__*` : b.name;
      tools.set(name, (tools.get(name) ?? 0) + 1);
    }
    const key = `${m.id}|${r.requestId}`;
    const u = m.usage;
    if (!u || seen.has(key) || m.model === "<synthetic>") continue;
    seen.add(key);
    const p = PRICES[m.model];
    if (!p) { unpriced.add(m.model); continue; }
    const cc = u.cache_creation ?? {};
    const t = {
      input: u.input_tokens ?? 0, read: u.cache_read_input_tokens ?? 0,
      w5m: cc.ephemeral_5m_input_tokens ?? 0, w1h: cc.ephemeral_1h_input_tokens ?? 0, output: u.output_tokens ?? 0,
    };
    tokens.calls++;
    for (const k of Object.keys(t) as (keyof typeof t)[]) tokens[k] += t[k];
    const usd = (t.input * p[0] + t.w5m * p[1] + t.w1h * p[2] + t.read * p[3] + t.output * p[4]) / 1e6;
    perAgent.set(session, (perAgent.get(session) ?? 0) + usd);
  }
}

if (unpriced.size) throw new Error(`no price for model(s): ${[...unpriced].join(", ")} — add them to PRICES`);
const total = [...perAgent.values()].reduce((a, b) => a + b, 0);
const B = (n: number) => `${(n / 1e9).toFixed(2)}B`, M = (n: number) => `${(n / 1e6).toFixed(1)}M`;
console.log(`fleet (${pins.size} pins, ${perAgent.size} active), last ${days} days`);
console.log(`calls ${tokens.calls}  cache read ${B(tokens.read)}  cache write 1h ${M(tokens.w1h)} / 5m ${M(tokens.w5m)}  output ${M(tokens.output)}  uncached in ${M(tokens.input)}`);
console.log(`API-equivalent: $${total.toFixed(0)} → $${((total * 30) / days).toFixed(0)} per 30 days`);
const sorted = [...perAgent.values()].sort((a, b) => b - a);
for (const lim of [10, 25, 50, 100]) {
  const under = sorted.filter((c) => c < lim);
  console.log(`  agents under $${lim}/${days}d: ${under.length}, together $${under.reduce((a, b) => a + b, 0).toFixed(0)}`);
}
console.log("tool_use counts:", [...tools.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => `${k} ${v}`).join(", "));
