// Lean harness PoC: continue a Claude Code session for one user turn by calling the Messages API
// directly, run a tiny tool loop (Bash, Read), and append the turn to the transcript in the format
// `claude --resume` loads.
//
//   node scripts/lean/continue.ts <transcript.jsonl> "<prompt>" [--model claude-haiku-4-5]
//
// Auth is ANTHROPIC_API_KEY only (per-token billing). A Claude subscription's OAuth token must not
// be used here — see docs/notes/lean-harness.md#auth. ANTHROPIC_BASE_URL points it elsewhere (the
// round-trip test aims it at a loopback fake). Only ever run it on a COPY of a transcript: it
// appends, and a live agent's transcript must have one writer.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { activeChain, leafOf, readRecords, toMessages, TranscriptWriter, type Block } from "./session.ts";

const SYSTEM = [
  "You are a coding agent running headless inside paw, a fleet of agents on the cotal mesh.",
  "Use the tools to inspect and change the working directory. Be brief.",
].join(" ");

const TOOLS = [
  {
    name: "Bash",
    description: "Run a shell command in the working directory and return its combined output.",
    input_schema: { type: "object", properties: { command: { type: "string" }, timeout: { type: "number" } }, required: ["command"] },
  },
  {
    name: "Read",
    description: "Read a text file by absolute path; returns numbered lines.",
    input_schema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] },
  },
];

function runTool(name: string, input: any, cwd: string): Promise<{ text: string; isError: boolean }> {
  if (name === "Read") {
    try {
      const lines = readFileSync(input.file_path, "utf8").split("\n");
      return Promise.resolve({ text: lines.map((l, i) => `${String(i + 1).padStart(6)}\t${l}`).join("\n"), isError: false });
    } catch (e) {
      return Promise.resolve({ text: String(e), isError: true });
    }
  }
  if (name === "Bash") {
    return new Promise((resolve) =>
      execFile("/bin/bash", ["-c", input.command], { cwd, timeout: input.timeout ?? 120_000, maxBuffer: 4 << 20 }, (err, stdout, stderr) =>
        resolve({ text: `${stdout}${stderr}`.trimEnd() || (err ? String(err) : ""), isError: !!err }),
      ),
    );
  }
  return Promise.resolve({ text: `unknown tool ${name}`, isError: true });
}

/** Cache the stable prefix: tools + system, plus the conversation up to its last message. */
function withCacheBreakpoint(messages: any[]): any[] {
  const out = structuredClone(messages);
  const last = out[out.length - 1];
  if (typeof last.content === "string") last.content = [{ type: "text", text: last.content }];
  last.content[last.content.length - 1].cache_control = { type: "ephemeral" };
  return out;
}

async function callApi(model: string, messages: any[]): Promise<{ msg: any; requestId: string | null }> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set — the lean harness bills per token and never uses subscription OAuth");
  const base = process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com";
  const res = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model, max_tokens: 4096,
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      tools: TOOLS, messages: withCacheBreakpoint(messages),
    }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Messages API ${res.status}: ${body.slice(0, 500)}`);
  return { msg: JSON.parse(body), requestId: res.headers.get("request-id") };
}

/**
 * Thinking blocks carry signatures bound to the model that produced them. When the lean harness
 * runs a different model than the TUI did, replaying them is refused, so they are dropped from
 * the request (never from the transcript).
 */
function forModel(messages: any[], model: string, producedBy: Set<string>): any[] {
  if (producedBy.size === 1 && producedBy.has(model)) return messages;
  return messages.map((m) =>
    m.role !== "assistant" || typeof m.content === "string"
      ? m
      : { ...m, content: m.content.filter((b: Block) => b.type !== "thinking" && b.type !== "redacted_thinking") },
  ).filter((m) => typeof m.content === "string" || m.content.length);
}

export async function continueSession(path: string, prompt: string, model: string): Promise<string> {
  const recs = readRecords(path);
  const leaf = leafOf(recs);
  const chain = activeChain(recs, leaf);
  const head = chain.find((r) => r.sessionId && r.cwd);
  if (!head) throw new Error(`${path}: no record carries sessionId + cwd`);
  const lastVersion = [...recs].reverse().find((r) => r.version)?.version;
  if (!lastVersion) throw new Error(`${path}: no record carries a claude version`);
  const models = new Set(chain.filter((r) => r.type === "assistant").map((r) => r.message?.model).filter((m) => m && m !== "<synthetic>"));

  const w = new TranscriptWriter(path, { sessionId: head.sessionId, cwd: head.cwd, version: lastVersion, gitBranch: head.gitBranch ?? "" }, leaf.uuid!);
  const promptId = randomUUID();
  const messages: any[] = toMessages(chain);
  w.userPrompt(prompt, promptId);
  const tail = messages[messages.length - 1];
  if (tail.role === "user") tail.content = [...(typeof tail.content === "string" ? [{ type: "text", text: tail.content }] : tail.content), { type: "text", text: prompt }];
  else messages.push({ role: "user", content: prompt });

  for (let step = 0; step < 20; step++) {
    const { msg, requestId } = await callApi(model, forModel(messages, model, models));
    const aRec = w.assistant(msg, requestId);
    messages.push({ role: "assistant", content: msg.content });
    const uses = (msg.content as Block[]).filter((b) => b.type === "tool_use");
    if (msg.stop_reason !== "tool_use" || !uses.length) {
      w.lastPrompt(prompt);
      return (msg.content as Block[]).filter((b) => b.type === "text").map((b) => b.text).join("\n");
    }
    const results: Block[] = [];
    const raw: unknown[] = [];
    for (const u of uses) {
      const r = await runTool(u.name, u.input, head.cwd);
      results.push({ type: "tool_result", tool_use_id: u.id, content: r.text, is_error: r.isError });
      raw.push(r.text);
    }
    w.toolResults(results, aRec.uuid!, promptId, raw.length === 1 ? raw[0] : raw);
    messages.push({ role: "user", content: results });
  }
  throw new Error("tool loop exceeded 20 steps");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [path, prompt] = process.argv.slice(2);
  if (!path || !prompt) throw new Error('usage: node scripts/lean/continue.ts <transcript.jsonl> "<prompt>" [--model <id>]');
  const mi = process.argv.indexOf("--model");
  const model = mi > 0 ? process.argv[mi + 1] : "claude-haiku-4-5";
  console.log(await continueSession(path, prompt, model));
}
