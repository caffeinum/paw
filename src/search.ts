/**
 * Search across what paw can see: the human's DMs, channel backlogs, and the agents' claude transcripts.
 *
 * Two tiers on purpose (operator's ask, 2026-09-03): MESSAGES are cheap — the daemon already holds the
 * DM conversation in memory and reads channel backlogs on demand — so they answer first. TRANSCRIPTS are
 * the raw `~/.claude/projects/<cwd>/<uuid>.jsonl` files, hundreds of MB for a busy agent, so they are a
 * second, explicit pass with a time budget: `rg` finds candidate LINES (each line is one JSONL record),
 * and only those records are parsed. A hit's snippet comes from the record's human-readable TEXT
 * (user/assistant content), not from the raw JSON, so what the operator reads is what was said.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import type { Entry } from "./feed.js";

export interface MessageHit {
  kind: "dm" | "channel";
  /** The conversation to open: the agent's name for a DM, the channel name for a channel post. */
  target: string;
  from: string;
  ts: number;
  snippet: string;
}
export interface TranscriptHit {
  agent: string;
  ts: number | undefined;
  role: string;
  snippet: string;
}

/** A window of `width` chars around the first case-insensitive occurrence of `q` in `text`, with the
 *  match kept whole and `…` marking each cut. No match → the head of the text (a caller that passes a
 *  line rg matched on JSON structure still gets something readable, never an empty string). */
export function snippet(text: string, q: string, width = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const i = q ? flat.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (i < 0) return flat.length > width ? flat.slice(0, width) + "…" : flat;
  const half = Math.max(0, Math.floor((width - q.length) / 2));
  const start = Math.max(0, i - half);
  const end = Math.min(flat.length, i + q.length + half);
  return (start > 0 ? "…" : "") + flat.slice(start, end) + (end < flat.length ? "…" : "");
}

/** Case-insensitive substring search over DM entries. `dir` is kept in the hit's `from`/`target` split:
 *  an outgoing message opens the agent it went TO, an incoming one the agent it came FROM. */
export function searchEntries(entries: Entry[], q: string, limit = 200): MessageHit[] {
  const needle = q.toLowerCase();
  const out: MessageHit[] = [];
  if (!needle) return out;
  for (let i = entries.length - 1; i >= 0 && out.length < limit; i--) {
    const e = entries[i];
    if (!e.text.toLowerCase().includes(needle)) continue;
    const target = e.dir === "out" ? (e.to ?? e.from) : e.from;
    out.push({ kind: "dm", target, from: e.from, ts: e.ts, snippet: snippet(e.text, q) });
  }
  return out;
}

/** The human-readable text of one transcript record: a user or assistant message's text blocks joined.
 *  Tool calls/results and meta records yield "" — a match inside a tool payload is not "the agent said
 *  it", and surfacing raw JSON as a conversation hit would mislead. */
export function recordText(record: unknown): { role: string; text: string; ts: number | undefined } {
  const r = record as { type?: string; timestamp?: string; message?: { role?: string; content?: unknown } } | null;
  if (!r || typeof r !== "object") return { role: "", text: "", ts: undefined };
  const role = r.message?.role ?? r.type ?? "";
  const ts = r.timestamp ? Date.parse(r.timestamp) : undefined;
  const c = r.message?.content;
  if (typeof c === "string") return { role, text: c, ts: Number.isFinite(ts) ? ts : undefined };
  if (Array.isArray(c)) {
    const text = c
      .filter((b): b is { type: string; text: string } => !!b && typeof b === "object" && (b as { type?: string }).type === "text" && typeof (b as { text?: unknown }).text === "string")
      .map((b) => b.text)
      .join("\n");
    return { role, text, ts: Number.isFinite(ts) ? ts : undefined };
  }
  return { role, text: "", ts: Number.isFinite(ts) ? ts : undefined };
}

/** rg the transcript for candidate lines, parse only those, keep the ones whose TEXT contains the query.
 *  `cap` bounds hits per file; `deadline` (epoch ms) lets the caller spread one budget over many agents —
 *  a file whose scan would overrun is skipped and reported as truncated rather than blocking the rest. */
export function searchTranscript(file: string, q: string, cap = 20, deadline = Date.now() + 8000): Promise<{ hits: TranscriptHit[]; truncated: boolean; error?: string }> {
  return new Promise((resolve) => {
    if (!q) return resolve({ hits: [], truncated: false });
    if (!existsSync(file)) return resolve({ hits: [], truncated: false, error: `no transcript at ${file}` });
    const remaining = deadline - Date.now();
    if (remaining <= 0) return resolve({ hits: [], truncated: true });
    const child = execFile(
      "rg",
      ["-i", "-F", "--no-line-number", "--max-count", String(cap * 4), "--max-columns", "0", q, file],
      { maxBuffer: 64 * 1024 * 1024, timeout: remaining },
      (err, stdout) => {
        // rg exits 1 for "no matches" — that is an answer, not an error. Anything else is reported.
        const code = (err as { code?: number | string } | null)?.code;
        if (err && code !== 1) return resolve({ hits: [], truncated: (err as { killed?: boolean }).killed === true, error: (err as Error).message.split("\n")[0] });
        const hits: TranscriptHit[] = [];
        for (const line of String(stdout).split("\n")) {
          if (!line) continue;
          let rec: unknown;
          try { rec = JSON.parse(line); } catch { continue; }
          const { role, text, ts } = recordText(rec);
          if (!text || !text.toLowerCase().includes(q.toLowerCase())) continue; // matched only in tool JSON
          hits.push({ agent: "", ts, role, snippet: snippet(text, q) });
          if (hits.length >= cap) break;
        }
        resolve({ hits, truncated: hits.length >= cap });
      },
    );
    void child;
  });
}
