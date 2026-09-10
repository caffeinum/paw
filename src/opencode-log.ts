/**
 * OpenCode session → {@link Block}s. The store is sqlite (`session`/`message`/`part`), not claude
 * jsonl, so this stays out of TranscriptParser.
 *
 * Cotal-spawned agents pin OPENCODE_DB to `<cotal-root>/.cotal/opencode/<name>/opencode.db`.
 * Interactive opencode uses `~/.local/share/opencode/opencode.db`. Tests set `OPENCODE_DB`.
 */
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pawCotalRoot } from "./cotal-root.js";
import { openReadonlySqlite } from "./sqlite-readonly.js";
import {
  failureText,
  harnessOutputText,
  meshAction,
  normalizeHarnessTool,
  primaryArg,
  resultSummary,
  toolDisplayName,
  userTextBlock,
  type Block,
} from "./transcript.js";

const SKIP_PART = new Set(["step-start", "step-finish", "reasoning", "patch", "file", "compaction", "subtask", "agent", "retry"]);

export function pathsMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const ra = resolve(a);
  const rb = resolve(b);
  if (ra === rb) return true;
  try {
    if (existsSync(ra) && existsSync(rb) && realpathSync(ra) === realpathSync(rb)) return true;
  } catch {
    // a path that cannot be realpath'd is still compared by resolve() above
  }
  return false;
}

/** The sqlite file this agent writes, or undefined if none is on disk yet. */
export function resolveOpencodeDb(space: string, name: string): string | undefined {
  const override = process.env.OPENCODE_DB?.trim();
  if (override) return override;
  const pinned = join(pawCotalRoot(space), ".cotal", "opencode", name, "opencode.db");
  if (existsSync(pinned)) return pinned;
  const global = join(homedir(), ".local", "share", "opencode", "opencode.db");
  if (existsSync(global)) return global;
  return undefined;
}

export function latestOpencodeSession(dbPath: string, folder: string): { id: string; directory: string } | undefined {
  return withReadonlyDb(dbPath, (db) => {
    const rows = db.all("SELECT id, directory, time_updated FROM session ORDER BY time_updated DESC") as Array<{
      id: string;
      directory: string;
      time_updated: number;
    }>;
    for (const row of rows) {
      if (typeof row.id !== "string" || typeof row.directory !== "string") {
        throw new Error(`paw: opencode db ${dbPath} has a session row missing id/directory`);
      }
      if (pathsMatch(row.directory, folder)) return { id: row.id, directory: row.directory };
    }
    return undefined;
  });
}

export function opencodeBlocks(dbPath: string, sessionId: string): Block[] {
  const rows = withReadonlyDb(dbPath, (db) => {
    return db.all(
      `SELECT p.data AS part, m.data AS message
       FROM part p JOIN message m ON m.id = p.message_id
       WHERE p.session_id = ?
       ORDER BY p.time_created ASC, p.id ASC`,
      sessionId,
    ) as Array<{ part: string; message: string }>;
  });
  return blocksFromOpencodeRows(rows);
}

/** Pure: one sqlite part (+ its message) → blocks. Exported for tests that inject rows. */
export function blocksFromOpencodeRows(rows: Array<{ part: unknown; message: unknown }>): Block[] {
  const blocks: Block[] = [];
  for (const row of rows) {
    const part = parseJson(row.part, "part");
    const message = parseJson(row.message, "message");
    const role = typeof message.role === "string" ? message.role : "";
    blocks.push(...partBlocks(part, role));
  }
  return blocks;
}

function partBlocks(part: Record<string, unknown>, role: string): Block[] {
  const type = typeof part.type === "string" ? part.type : "";
  if (SKIP_PART.has(type)) return [];
  if (type === "text") {
    const text = typeof part.text === "string" ? part.text.trim() : "";
    if (!text) return [];
    if (role === "user") return [userTextBlock(text)];
    const failed = failureText(text);
    return [failed ? { kind: "failure", text: failed } : { kind: "assistant", markdown: text }];
  }
  if (type === "tool") return toolBlocks(part);
  return [];
}

function toolBlocks(part: Record<string, unknown>): Block[] {
  const name = typeof part.tool === "string" ? part.tool : "";
  if (!name) throw new Error(`paw: opencode tool part is missing tool name`);
  const state = (part.state && typeof part.state === "object" ? part.state : {}) as {
    status?: string;
    input?: unknown;
    output?: unknown;
    error?: unknown;
  };
  const rawInput = (state.input && typeof state.input === "object" && !Array.isArray(state.input)
    ? state.input
    : {}) as Record<string, unknown>;
  const mesh = meshAction(name, rawInput);
  if (mesh === "hide") return [];
  if (mesh === "inbox") {
    const body = harnessOutputText(state.output).trim();
    return body && !/^no new messages/i.test(body) ? [{ kind: "incoming", text: body }] : [];
  }
  if (mesh) return [mesh];

  const { name: mapped, input } = normalizeHarnessTool(name, rawInput);
  const call: Block = { kind: "tool", name: mapped, display: toolDisplayName(mapped), arg: primaryArg(mapped, input) };
  const status = state.status;
  if (status !== "completed" && status !== "error") return [call];
  const isError = status === "error";
  const text = isError && typeof state.error === "string"
    ? state.error
    : harnessOutputText(state.output);
  return [call, { kind: "result", lines: resultSummary(mapped, input, text, isError), isError }];
}

function parseJson(raw: unknown, label: string): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== "string") throw new Error(`paw: opencode ${label} is not JSON`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`paw: opencode ${label} is not valid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`paw: opencode ${label} JSON is not an object`);
  }
  return parsed as Record<string, unknown>;
}

function withReadonlyDb<T>(path: string, fn: (db: { all: (sql: string, ...params: unknown[]) => unknown[] }) => T): T {
  const db = openReadonlySqlite(path);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}
