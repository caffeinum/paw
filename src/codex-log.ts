/**
 * Codex session → {@link Block}s. Rollout jsonl under `~/.codex/sessions` (and cotal-spawned
 * `~/.cotal/codex/<agent>/sessions`). Matched by `session_meta.payload.cwd`, never by sibling.
 */
import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pawCotalRoot } from "./cotal-root.js";
import { pathsMatch } from "./opencode-log.js";
import {
  failureText,
  harnessOutputText,
  meshAction,
  normalizeHarnessTool,
  primaryArg,
  resultSummary,
  tailRead,
  toolDisplayName,
  userTextBlock,
  type Block,
} from "./transcript.js";

export function resolveCodexRoots(space: string): string[] {
  const override = process.env.CODEX_HOME?.trim();
  if (override) return [join(override, "sessions")];
  const home = homedir();
  const roots = [join(home, ".codex", "sessions"), join(home, ".codex", "archived_sessions")];
  const cotal = join(pawCotalRoot(space), ".cotal", "codex");
  if (existsSync(cotal)) {
    for (const ent of readdirSync(cotal, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const sessions = join(cotal, ent.name, "sessions");
      if (existsSync(sessions)) roots.push(sessions);
    }
  }
  return roots;
}

/** Latest-mtime rollout whose session_meta cwd is this folder. */
export function findCodexSessionFile(folder: string, roots: string[]): string | undefined {
  let best: { file: string; mtime: number } | undefined;
  for (const root of roots) {
    for (const file of rolloutFiles(root)) {
      const cwd = sessionCwd(file);
      if (!cwd || !pathsMatch(cwd, folder)) continue;
      const mtime = statSync(file).mtimeMs;
      if (!best || mtime > best.mtime) best = { file, mtime };
    }
  }
  return best?.file;
}

export function parseCodexJsonl(text: string): Block[] {
  const parser = new CodexParser();
  const blocks: Block[] = [];
  for (const line of text.split("\n")) {
    if (line) blocks.push(...parser.feed(line));
  }
  return blocks;
}

export function codexBlocks(file: string, bytes: number): Block[] {
  return parseCodexJsonl(tailRead(file, bytes));
}

export class CodexParser {
  private pending = new Map<string, { name: string; input: Record<string, unknown> }>();

  feed(line: string): Block[] {
    let rec: { type?: string; payload?: Record<string, unknown> };
    try {
      rec = JSON.parse(line);
    } catch {
      return [];
    }
    if (rec.type !== "response_item" || !rec.payload || typeof rec.payload !== "object") return [];
    const pl = rec.payload;
    const kind = pl.type;
    if (kind === "message") return this.message(pl);
    if (kind === "function_call" || kind === "custom_tool_call") return this.call(pl);
    if (kind === "function_call_output" || kind === "custom_tool_call_output") return this.output(pl);
    return [];
  }

  private message(pl: Record<string, unknown>): Block[] {
    const role = typeof pl.role === "string" ? pl.role : "";
    if (role === "developer") return [];
    const text = contentText(pl.content);
    if (!text) return [];
    if (role === "user") return [userTextBlock(text)];
    if (role === "assistant") {
      const failed = failureText(text);
      return [failed ? { kind: "failure", text: failed } : { kind: "assistant", markdown: text }];
    }
    return [];
  }

  private call(pl: Record<string, unknown>): Block[] {
    const name = typeof pl.name === "string" ? pl.name : "";
    if (!name) throw new Error(`paw: codex tool call is missing a name`);
    const input = parseArgs(pl.arguments ?? pl.input);
    const callId = typeof pl.call_id === "string" ? pl.call_id : undefined;
    const mesh = meshAction(name, input);
    if (mesh === "hide") return [];
    if (mesh === "inbox") {
      if (callId) this.pending.set(callId, { name: "\u0000inbox", input });
      return [];
    }
    if (mesh) return [mesh];
    const { name: mapped, input: shaped } = normalizeHarnessTool(name, input);
    if (callId) this.pending.set(callId, { name: mapped, input: shaped });
    return [{ kind: "tool", name: mapped, display: toolDisplayName(mapped), arg: primaryArg(mapped, shaped) }];
  }

  private output(pl: Record<string, unknown>): Block[] {
    const callId = typeof pl.call_id === "string" ? pl.call_id : undefined;
    const pend = callId ? this.pending.get(callId) : undefined;
    if (!pend) return [];
    this.pending.delete(callId!);
    const text = outputText(pl.output);
    if (pend.name === "\u0000inbox") {
      const body = text.trim();
      return body && !/^no new messages/i.test(body) ? [{ kind: "incoming", text: body }] : [];
    }
    const isError = exitError(pl.output);
    return [{ kind: "result", lines: resultSummary(pend.name, pend.input, text, isError), isError }];
  }
}

function contentText(content: unknown): string {
  if (typeof content === "string") return stripEnv(content);
  if (!Array.isArray(content)) return "";
  const joined = content
    .map((p) => {
      if (!p || typeof p !== "object") return "";
      const t = p as { type?: string; text?: unknown };
      if ((t.type === "input_text" || t.type === "output_text" || t.type === "text") && typeof t.text === "string") {
        return t.text;
      }
      return "";
    })
    .join("\n");
  return stripEnv(joined);
}

function stripEnv(text: string): string {
  return text.replace(/<environment_context>[\s\S]*?<\/environment_context>\s*/g, "").trim();
}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    return { command: raw };
  }
  return {};
}

function outputText(output: unknown): string {
  if (typeof output === "string") {
    try {
      const v = JSON.parse(output);
      const inner = harnessOutputText(v);
      if (inner) return inner;
    } catch {
      // plain text, not json
    }
    return output;
  }
  return harnessOutputText(output);
}

function exitError(output: unknown): boolean {
  if (typeof output !== "string") return false;
  try {
    const v = JSON.parse(output) as { metadata?: { exit_code?: unknown } };
    return typeof v.metadata?.exit_code === "number" && v.metadata.exit_code !== 0;
  } catch {
    return false;
  }
}

function sessionCwd(file: string): string | undefined {
  const line = firstLineOf(file);
  if (!line) return undefined;
  let rec: { type?: string; payload?: { cwd?: unknown } };
  try {
    rec = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (rec.type !== "session_meta") return undefined;
  return typeof rec.payload?.cwd === "string" ? rec.payload.cwd : undefined;
}

function firstLineOf(file: string): string {
  const fd = openSync(file, "r");
  try {
    const chunks: Buffer[] = [];
    let offset = 0;
    const buf = Buffer.alloc(64 * 1024);
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, offset);
      if (n === 0) break;
      const slice = buf.subarray(0, n);
      const nl = slice.indexOf(0x0a);
      if (nl >= 0) {
        chunks.push(Buffer.from(slice.subarray(0, nl)));
        break;
      }
      chunks.push(Buffer.from(slice));
      offset += n;
      if (offset > 2 * 1024 * 1024) {
        throw new Error(`paw: ${file} first record exceeds 2MB — not a codex session_meta line`);
      }
    }
    return Buffer.concat(chunks).toString("utf8").trim();
  } finally {
    closeSync(fd);
  }
}

function rolloutFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.isFile() && ent.name.startsWith("rollout-") && ent.name.endsWith(".jsonl")) out.push(p);
    }
  };
  walk(root);
  return out;
}
