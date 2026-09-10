/**
 * Claude transcript → structured blocks. The parsing half of `paw log`, with no rendering in it.
 *
 * WHY IT'S SPLIT OUT: `paw log` walked the `.jsonl` and emitted ANSI in one pass, so the only way to
 * get at an agent's turns was to print them to a terminal. A second consumer (a browser, a status
 * summary, anything asking "what is this agent doing right now") needs the same walk and none of the
 * escape codes. So the walk lives here and returns {@link Block}s; `src/log.ts` is now a renderer over
 * them. `check:transcript` covers this module; the byte-for-byte equality of `paw log`'s output
 * across the split was verified against real transcripts.
 *
 * Everything here is PURE except {@link tailRead}: no mesh, no color, no tty. paw is a mesh CLIENT,
 * and this half doesn't even touch the mesh — a transcript is a local file the agent's claude appends
 * to, so nothing in this module needs a broker, a manager, or a running agent.
 */
import { closeSync, openSync, readSync, statSync } from "node:fs";

/** One content part of a claude transcript record. */
export type Part = {
  type?: string;
  text?: string;
  name?: string;
  input?: unknown;
  id?: string;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
};

/**
 * One displayable unit of an agent's session. Deliberately carries SOURCE, not presentation —
 * `assistant` holds raw markdown rather than rendered output, because the terminal wants ANSI and a
 * browser wants HTML, and whichever one this type committed to would make the other a translation.
 */
export type Block =
  | { kind: "user"; text: string }
  /** The connector's `<channel source="cotal" …>` wake prompt, reduced to who woke it and how. */
  | { kind: "wake"; from: string; via: string }
  /** A `<task-notification>` wake — a monitor/hook firing, reduced the way Claude Code shows it. */
  | { kind: "notification"; summary: string; event?: string }
  /** A runtime failure the model reported as its whole turn (API error, failed background command).
   *  Claude Code colours these; paw was printing them as ordinary prose. */
  | { kind: "failure"; text: string }
  | { kind: "assistant"; markdown: string }
  | { kind: "tool"; name: string; display: string; arg: string }
  | { kind: "result"; lines: string[]; isError: boolean }
  /** The agent's OWN outgoing mesh DM — its reply, which is signal, unlike the rest of the plumbing. */
  | { kind: "reply"; to: string; text: string }
  | { kind: "channelReply"; channel: string; text: string }
  /** What a peer actually SAID to this agent — the body of a drained inbox, in full. */
  | { kind: "incoming"; text: string }
  | { kind: "spawn"; name: string };

export const HIDDEN = new Set(["ToolSearch"]); // pure plumbing, no signal in a log

/**
 * The bare cotal tool name if `name` is one of the mesh tools, however it was invoked — else undefined.
 *
 * WHY THIS EXISTS: the mesh rules used to test `name.startsWith("cotal_")`, but an agent never calls a
 * bare `cotal_dm`. It calls the MCP-namespaced `mcp__cotal__cotal_dm`, so every rule keyed on that
 * prefix silently never fired: an agent's outgoing DM rendered as an ordinary tool call, and the
 * discovery plumbing meant to be hidden was printed in full. Both were live in `paw log` output.
 *
 * The server is checked, not just stripped — `mcp__other__cotal_dm` is some other server's tool and
 * has no business being read as a mesh reply.
 */
export function meshTool(name: string): string | undefined {
  if (!name.startsWith("mcp__")) return name.startsWith("cotal_") ? name : undefined;
  const [, server, ...rest] = name.split("__");
  return server === "cotal" && rest.length ? rest.join("__") : undefined;
}

export function oneLine(s: string, max = 200): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

export const base = (p?: unknown): string => (typeof p === "string" && p ? p.split("/").pop()! : "?");
export const firstLine = (s: string): string => s.split("\n").find((l) => l.trim()) ?? "";

/** Display name matching the Claude Code UI. */
export function toolDisplayName(name: string): string {
  if (name === "Task") return "Agent";
  if (name.startsWith("mcp__")) return name.slice("mcp__".length).replace(/__/g, ":");
  return name;
}

/** The headline argument Claude Code shows in parens after the tool name. */
export function primaryArg(name: string, input: Record<string, unknown>): string {
  const s = (v: unknown, max = 80): string => oneLine(String(v ?? ""), max);
  switch (name) {
    case "Bash": return s(firstLine(String(input.command ?? "")), 80);
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit": return base(input.file_path);
    case "NotebookEdit": return base(input.notebook_path);
    case "Grep": return s(input.pattern, 60);
    case "Glob": return s(input.pattern, 60);
    case "WebFetch": return s(input.url, 80);
    case "WebSearch": return s(input.query, 60);
    case "Task":
    case "Agent": return s(input.description, 60);
    case "TodoWrite": return "";
    default:
      if (name.startsWith("mcp__")) {
        const parts = Object.entries(input)
          .filter(([, v]) => typeof v === "string" || typeof v === "number")
          .slice(0, 2)
          .map(([k, v]) => `${k}: ${s(v, 40)}`);
        return parts.join(", ");
      }
      return "";
  }
}

/** Pull the text out of a tool_result's `content` (string or content-part array). */
export function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === "string" ? p : p && p.type === "text" ? String(p.text ?? "") : ""))
      .join("");
  }
  return "";
}

/** Summarize a tool result the way Claude Code does — a short, tool-aware line (or a few for Bash). */
export function resultSummary(name: string, input: Record<string, unknown>, text: string, isError: boolean): string[] {
  if (isError) return [oneLine(firstLine(text) || "error", 120)];
  switch (name) {
    case "Write": {
      const lines = String(input.content ?? "").split("\n").length;
      return [`Wrote ${lines} line${lines === 1 ? "" : "s"} to ${base(input.file_path)}`];
    }
    case "Edit":
    case "MultiEdit":
      return [`Updated ${base(input.file_path)}`];
    case "Read": {
      const n = text ? text.split("\n").length : 0;
      return [`Read ${n} line${n === 1 ? "" : "s"}`];
    }
    case "Bash": {
      const lines = text.split("\n").filter((l) => l.trim()).slice(0, 3).map((l) => oneLine(l, 120));
      return lines.length ? lines : ["(no output)"];
    }
    case "TodoWrite":
      return ["updated todos"];
    default: {
      const first = oneLine(firstLine(text), 120);
      return [first || "done"];
    }
  }
}

/** Mesh tools that SEND something — the agent talking, which is signal. Everything else cotal exposes
 *  is discovery/bookkeeping and is hidden. */
const OUTGOING = new Set(["cotal_dm", "cotal_send", "cotal_broadcast", "cotal_multicast", "cotal_anycast"]);

/**
 * Marks a pending `cotal_inbox` so its RESULT is kept when the call itself is hidden.
 *
 * The wake marker says only "📨 dm from you" — the connector's prompt announces that mail arrived, it
 * does not carry the mail. The words a peer actually sent arrive later, as the RESULT of the agent
 * draining its inbox. Hiding the whole cotal_* family therefore hid the one place an incoming message
 * was ever visible, leaving a log where you could read every reply the agent sent and nothing anyone
 * said to it. Half a conversation.
 */
const INBOX_DRAIN = "\u0000inbox";

/**
 * Stateful parser: pairs each `tool_use` with the `tool_result` that arrives in a LATER record, so a
 * result can be attached to the call it belongs to. That pairing is the whole reason this is a class
 * rather than a function — the two halves are separate lines in the file, and a stateless pass would
 * have to buffer the entire transcript to reunite them.
 *
 * Fed one JSONL line at a time; returns the blocks for that line (most lines → 0 or 1).
 */
/**
 * A `<task-notification>` turn, reduced to what Claude Code shows.
 *
 * These are hook/monitor wakes, and the raw envelope is mostly machinery: a task id, XML tags, and a
 * standing instruction to the model about when to send a PushNotification. Claude Code renders the
 * whole thing as one line — `Monitor event: "<summary>"` — and paw was printing ~10 lines of the
 * envelope instead, which buries the actual trace (reported 2026-08-20 with both views side by side).
 *
 * The `<event>` body is KEPT, indented, because `paw log` and the trace view are read after the fact
 * to find out what happened — the event is the only part carrying that. Everything else is dropped.
 *
 * Returns undefined for anything that isn't one of these, so an unrecognised turn still renders in
 * full rather than being silently reduced to nothing.
 */
export function parseTaskNotification(text: string): { kind: "notification"; summary: string; event?: string } | undefined {
  if (!text.includes("<task-notification>")) return undefined;
  const summary = text.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.trim();
  if (!summary) return undefined; // no summary ⇒ nothing to reduce it TO; show the raw turn instead
  const event = text.match(/<event>([\s\S]*?)<\/event>/)?.[1]?.trim();
  return { kind: "notification", summary, event: event || undefined };
}

/** A user-turn body → wake / notification / plain user. Shared by the claude parser and the
 *  opencode/codex harness readers so a cotal wake prompt looks the same on every surface. */
export function userTextBlock(text: string): Block {
  const note = parseTaskNotification(text);
  if (note) return note;
  if (text.includes('<channel source="cotal"')) {
    return { kind: "wake", from: text.match(/from="([^"]+)"/)?.[1] ?? "?", via: text.match(/kind="([^"]+)"/)?.[1] ?? "dm" };
  }
  return { kind: "user", text };
}

/**
 * Mesh-tool routing for one call. `"inbox"` means keep the RESULT (the mail) and hide the call;
 * `"hide"` means drop both; a Block is the call itself (reply/spawn); `undefined` is a real work tool.
 *
 * Lifted out of TranscriptParser so the opencode/codex readers apply the same hide/reply rules
 * without importing the jsonl parser.
 */
export function meshAction(name: string, input: Record<string, unknown>): Block | "inbox" | "hide" | undefined {
  const mesh = meshTool(name);
  const s = (v: unknown, max = 180): string => oneLine(String(v ?? ""), max);
  if (mesh === "cotal_spawn") return { kind: "spawn", name: String(input.name ?? "?") };
  if (mesh === "cotal_inbox") return "inbox";
  if (mesh && OUTGOING.has(mesh)) {
    if (input.channel !== undefined) return { kind: "channelReply", channel: String(input.channel), text: s(input.text) };
    if (input.to !== undefined) return { kind: "reply", to: String(input.to), text: s(input.text) };
    if (input.role !== undefined) return { kind: "reply", to: `@${String(input.role)}`, text: s(input.text) };
    return { kind: "reply", to: "?", text: s(input.text) };
  }
  if (mesh || HIDDEN.has(name)) return "hide";
  return undefined;
}

/** Map a harness-native tool name + args onto the shape `primaryArg`/`resultSummary` already know
 *  (claude's PascalCase + `file_path`/`command`). Unknown tools pass through unmolested. */
export function normalizeHarnessTool(name: string, input: Record<string, unknown>): { name: string; input: Record<string, unknown> } {
  const lower = name.toLowerCase();
  const mapped =
    lower === "bash" || lower === "shell" || lower === "exec" || lower === "exec_command" ? "Bash"
    : lower === "read" ? "Read"
    : lower === "write" ? "Write"
    : lower === "edit" ? "Edit"
    : lower === "multiedit" ? "MultiEdit"
    : lower === "grep" ? "Grep"
    : lower === "glob" ? "Glob"
    : lower === "webfetch" ? "WebFetch"
    : lower === "websearch" ? "WebSearch"
    : lower === "todowrite" ? "TodoWrite"
    : lower === "task" ? "Task"
    : name;
  const out: Record<string, unknown> = { ...input };
  if (typeof input.filePath === "string" && input.file_path === undefined) out.file_path = input.filePath;
  if (typeof input.cmd === "string" && input.command === undefined) out.command = input.cmd;
  if (Array.isArray(input.command)) out.command = input.command.map(String).join(" ");
  return { name: mapped, input: out };
}

/** Pull a tool result's display text out of the shapes opencode/codex actually store. */
export function harnessOutputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (output == null) return "";
  if (Array.isArray(output)) {
    return output
      .map((p) => {
        if (typeof p === "string") return p;
        if (p && typeof p === "object" && "text" in p && typeof (p as { text: unknown }).text === "string") {
          return (p as { text: string }).text;
        }
        return "";
      })
      .join("");
  }
  if (typeof output === "object") {
    const o = output as { output?: unknown; text?: unknown };
    if (typeof o.output === "string") return o.output;
    if (typeof o.text === "string") return o.text;
  }
  return "";
}

/**
 * Is this assistant turn a runtime FAILURE rather than something the model chose to say?
 *
 * Claude Code colours these — an API error is amber, a failed background command red — and paw printed
 * them as ordinary assistant prose, so a connection collapse read exactly like a considered remark.
 * Matched on the shapes claude actually emits as a whole turn; anything else stays prose, because
 * mis-flagging real writing as an error is the worse direction (it would recolour an agent QUOTING an
 * error while explaining it).
 */
export function failureText(markdown: string): string | undefined {
  const line = markdown.trim();
  if (/^API Error:/.test(line)) return line;
  if (/^Background command .* (failed|exited) with exit code \d+/i.test(line)) return line;
  // The rest of the family claude writes as a SYNTHETIC assistant turn when the model could not run
  // (seen across a day of transcripts, 2026-09-03): the harness speaking, never the agent.
  if (/^You've hit your session limit/.test(line)) return line;
  if (/^Login expired\b/.test(line)) return line;
  if (/^Please run \/login\b/.test(line)) return line;
  if (/^Request timed out\b/.test(line)) return line;
  return undefined;
}

/**
 * The runtime-failure verdict for ONE transcript record: claude stamps a turn the MODEL never produced
 * with `message.model: "<synthetic>"` and, for API refusals, `isApiErrorMessage: true`. That flag is
 * the authoritative signal; the text patterns above are the fallback for a synthetic turn without it.
 * "No response requested." is synthetic too but is the harness saying "nothing to say" — not a failure,
 * and flagging it would call every quiet agent broken.
 */
export function recordFailure(rec: unknown): { text: string; ts: number } | undefined {
  const r = rec as { type?: string; timestamp?: string; isApiErrorMessage?: boolean; message?: { role?: string; model?: string; content?: unknown } } | null;
  if (!r || typeof r !== "object" || r.type !== "assistant") return undefined;
  const c = r.message?.content;
  const text = (typeof c === "string" ? c : Array.isArray(c) ? c.filter((b): b is { type: string; text: string } => !!b && typeof b === "object" && (b as { type?: string }).type === "text").map((b) => b.text).join("\n") : "").trim();
  if (!text || /^No response requested\.?$/.test(text)) return undefined;
  const ts = r.timestamp ? Date.parse(r.timestamp) : NaN;
  const stamp = Number.isFinite(ts) ? ts : 0;
  if (r.isApiErrorMessage === true) return { text: text.split("\n")[0], ts: stamp };
  if (r.message?.model === "<synthetic>" && failureText(text)) return { text: failureText(text) as string, ts: stamp };
  return undefined;
}

/** Walk records NEWEST first: the latest assistant turn decides. A failure followed by a real reply
 *  means the agent recovered — reporting the old failure would be stale news presented as current. */
export function lastFailure(lines: string[]): { text: string; ts: number } | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    let rec: { type?: string } | undefined;
    try { rec = JSON.parse(lines[i]); } catch { continue; }
    if (rec?.type !== "assistant") continue;
    return recordFailure(rec);
  }
  return undefined;
}

export class TranscriptParser {
  private pending = new Map<string, { name: string; input: Record<string, unknown> }>();

  feed(line: string): Block[] {
    let rec: { type?: string; message?: { role?: string; content?: unknown } };
    try {
      rec = JSON.parse(line);
    } catch {
      // A truncated final line is NORMAL: the tail read cuts mid-record, and an agent mid-write leaves
      // a partial one. Skipping is right; a lenient parse here would invent a turn that never happened.
      return [];
    }
    const msg = rec.message ?? (rec as { role?: string; content?: unknown });
    const role = msg.role ?? rec.type;
    const content = msg.content;

    if (role === "user") return this.feedUser(content);
    if (role === "assistant" && Array.isArray(content)) return this.feedAssistant(content as Part[]);
    return [];
  }

  private feedUser(content: unknown): Block[] {
    if (typeof content === "string") return content.trim() ? [this.userBlock(content)] : [];
    if (!Array.isArray(content)) return [];
    const parts = content as Part[];
    const blocks: Block[] = [];
    const text = parts
      .filter((p) => p?.type === "text" && p.text?.trim())
      .map((p) => p.text)
      .join(" ");
    if (text.trim()) blocks.push(this.userBlock(text));
    for (const p of parts) {
      if (p?.type === "tool_result") {
        const b = this.resultBlock(p);
        if (b) blocks.push(b);
      }
    }
    return blocks;
  }

  private userBlock(text: string): Block {
    return userTextBlock(text);
  }

  private resultBlock(p: Part): Block | undefined {
    const pend = p.tool_use_id ? this.pending.get(p.tool_use_id) : undefined;
    if (!pend) return undefined; // result for a hidden/mesh tool → no signal
    this.pending.delete(p.tool_use_id!);
    const isError = p.is_error === true;
    if (pend.name === INBOX_DRAIN) {
      const body = resultText(p.content).trim();
      // "no new messages" is a drain that found nothing — an empty envelope, not something a peer said.
      return body && !/^no new messages/i.test(body) ? { kind: "incoming", text: body } : undefined;
    }
    return { kind: "result", lines: resultSummary(pend.name, pend.input, resultText(p.content), isError), isError };
  }

  private feedAssistant(parts: Part[]): Block[] {
    const blocks: Block[] = [];
    for (const p of parts) {
      if (p?.type === "text" && p.text?.trim()) {
        {
          // A runtime failure is not prose: claude reports API errors and failed background commands
          // as a whole assistant turn, and Claude Code colours them rather than printing them as
          // something the model decided to say.
          const failed = failureText(p.text);
          blocks.push(failed ? { kind: "failure", text: failed } : { kind: "assistant", markdown: p.text.trim() });
        }
      } else if (p?.type === "tool_use" && p.name) {
        const b = this.toolBlock(p);
        if (b) blocks.push(b);
      }
    }
    return blocks;
  }

  private toolBlock(p: Part): Block | undefined {
    const name = p.name!;
    const input = (p.input ?? {}) as Record<string, unknown>;
    const mesh = meshAction(name, input);
    if (mesh === "inbox") {
      if (p.id) this.pending.set(p.id, { name: INBOX_DRAIN, input });
      return undefined;
    }
    if (mesh === "hide") return undefined;
    if (mesh) return mesh;

    if (p.id) this.pending.set(p.id, { name, input });
    return { kind: "tool", name, display: toolDisplayName(name), arg: primaryArg(name, input) };
  }
}

/**
 * Is a turn IN FLIGHT right now, judged from the transcript's tail?
 *
 * Claude closes every completed turn with a `system` record of subtype `turn_duration` (preceded by
 * `stop_hook_summary`). A turn still running ends on an `assistant` record with `stop_reason:
 * "tool_use"` and the `user` record carrying the tool result — no closing marker. So scanning backwards
 * for whichever comes first answers the question exactly:
 *
 *   idle:     … assistant(end_turn) · attachment · system(stop_hook_summary) · system(turn_duration)
 *   working:  … assistant(tool_use) · user(tool_result)
 *
 * WHY THIS BEATS THE MTIME GUESS it replaces: mtime says "wrote something in the last 10 seconds",
 * which misses an agent thinking for a minute and misses one blocked on a slow tool. This is exact for
 * as long as the turn runs, however quiet it is.
 *
 * Returns undefined when the file shows NO completion marker at all — hooks can be disabled, and a
 * transcript without them would otherwise read as permanently working. Undefined means "cannot tell
 * from here", so the caller can fall back rather than assert something false.
 */
export function turnInFlight(tailText: string): boolean | undefined {
  const lines = tailText.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    let rec: { type?: string; subtype?: string; message?: { stop_reason?: string } };
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // a truncated tail line proves nothing either way
    }
    if (rec.type === "system" && rec.subtype === "turn_duration") return false; // closed, and closed last
    if (rec.type === "assistant") {
      // `stop_reason` decides, and it must: `turn_duration` is NOT always written. A real transcript
      // was found with a completed turn (`end_turn`) and no turn_duration anywhere in the file, and
      // relying on the marker alone reported that finished session as working forever.
      const stop = rec.message?.stop_reason;
      if (stop === "end_turn" || stop === "stop_sequence") return false; // the model stopped, nothing followed
      return true; // tool_use (or an unknown reason) → a step is still in flight
    }
    if (rec.type === "user") return true; // a tool result or a new prompt — either way the turn continues
  }
  return undefined;
}

/** Read the last `bytes` of a file as text, dropping a leading partial line. Cheap on huge transcripts. */
export function tailRead(file: string, bytes: number): string {
  const size = statSync(file).size;
  const start = Math.max(0, size - bytes);
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    let s = buf.toString("utf8");
    if (start > 0) s = s.slice(s.indexOf("\n") + 1); // drop the partial first line
    return s;
  } finally {
    closeSync(fd);
  }
}
