// Claude Code session JSONL: read a transcript into Messages-API messages, and append turns that
// `claude --resume` loads. The format notes behind every choice here are in docs/notes/lean-harness.md.
import { appendFileSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

export type Block = Record<string, any> & { type: string };
export interface ApiMessage { role: "user" | "assistant"; content: string | Block[] }
export interface Rec extends Record<string, any> { type: string; uuid?: string; parentUuid?: string | null }

/** Records that sit on the uuid/parentUuid conversation chain. Everything else is session metadata. */
const CHAIN_TYPES = new Set(["user", "assistant", "attachment", "system"]);

/** ~/.claude/projects/<slug>: every non-alphanumeric char of the absolute cwd becomes "-". */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

export function readRecords(path: string): Rec[] {
  const out: Rec[] = [];
  for (const [i, line] of readFileSync(path, "utf8").split("\n").entries()) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { throw new Error(`${path}:${i + 1}: not JSON — refusing to continue a corrupt transcript`); }
  }
  return out;
}

/** The leaf the next turn hangs off: the last main-thread chain record in file order. */
export function leafOf(recs: Rec[]): Rec {
  for (let i = recs.length - 1; i >= 0; i--) {
    const r = recs[i];
    if (CHAIN_TYPES.has(r.type) && r.uuid && !r.isSidechain) return r;
  }
  throw new Error("transcript has no main-thread chain record to continue from");
}

function isToolResultRecord(r: Rec): boolean {
  return r.type === "user" && Array.isArray(r.message?.content) && r.message.content.some((b: Block) => b.type === "tool_result");
}

/**
 * Parallel tool calls make the file a TREE, not a chain. claude writes one assistant record per
 * tool_use (all sharing message.id) and each result as a child of its own tool_use record, in
 * completion order — so the parentUuid walk follows ONE branch and sees only some of the uses and
 * results. claude reassembles the whole API message; so does this: the first time the walk meets
 * a message.id it emits every record of that id, then every tool_result whose parent is one of
 * them, both in file order (which is the order claude sends them in).
 */
function expandParallelToolCalls(recs: Rec[], chain: Rec[]): Rec[] {
  const order = new Map<string, number>();
  const byMsgId = new Map<string, Rec[]>();
  const resultsOf = new Map<string, Rec[]>();
  recs.forEach((r, i) => {
    if (!r.uuid || r.isSidechain) return;
    order.set(r.uuid, i);
    if (r.type === "assistant" && r.message?.id) byMsgId.set(r.message.id, [...(byMsgId.get(r.message.id) ?? []), r]);
    if (isToolResultRecord(r) && r.parentUuid) resultsOf.set(r.parentUuid, [...(resultsOf.get(r.parentUuid) ?? []), r]);
  });
  const out: Rec[] = [];
  const emitted = new Set<string>();
  const emittedMsg = new Set<string>();
  for (const r of chain) {
    if (emitted.has(r.uuid!)) continue;
    const mid = r.type === "assistant" ? r.message?.id : undefined;
    if (!mid || !(byMsgId.get(mid)?.length! > 1)) { out.push(r); emitted.add(r.uuid!); continue; }
    if (emittedMsg.has(mid)) continue;
    emittedMsg.add(mid);
    const group = byMsgId.get(mid)!;
    const results = group.flatMap((a) => resultsOf.get(a.uuid!) ?? []).sort((a, b) => order.get(a.uuid!)! - order.get(b.uuid!)!);
    for (const x of [...group, ...results]) { out.push(x); emitted.add(x.uuid!); }
  }
  return out;
}

/**
 * Walk parentUuid from the leaf to the root of the ACTIVE segment. A compact_boundary has
 * parentUuid null (logicalParentUuid keeps the pre-compaction link), so the walk naturally stops
 * there and the model sees only the summary and what follows it — what claude itself sends.
 */
export function activeChain(recs: Rec[], leaf: Rec): Rec[] {
  const byId = new Map<string, Rec>();
  for (const r of recs) if (r.uuid) byId.set(r.uuid, r);
  const chain: Rec[] = [];
  const seen = new Set<string>();
  for (let r: Rec | undefined = leaf; r; r = r.parentUuid ? byId.get(r.parentUuid) : undefined) {
    if (seen.has(r.uuid!)) throw new Error(`parentUuid cycle at ${r.uuid}`);
    seen.add(r.uuid!);
    chain.push(r);
    if (r.parentUuid && !byId.has(r.parentUuid)) throw new Error(`dangling parentUuid ${r.parentUuid} under ${r.uuid}`);
  }
  chain.reverse();
  const expanded = expandParallelToolCalls(recs, chain);
  chain.length = 0;
  chain.push(...expanded);
  // A partial compaction keeps a tail of pre-boundary messages verbatim: claude splices
  // compactMetadata.preservedMessages right after the summary (their anchor).
  const preserved = chain[0]?.subtype === "compact_boundary" ? chain[0].compactMetadata?.preservedMessages : undefined;
  if (preserved?.uuids?.length) {
    const at = chain.findIndex((r) => r.uuid === preserved.anchorUuid);
    if (at === -1) throw new Error(`compact anchor ${preserved.anchorUuid} is not on the active chain`);
    const kept = (preserved.uuids as string[]).map((u) => {
      const r = byId.get(u);
      if (!r) throw new Error(`preserved message ${u} is missing from the transcript`);
      return r;
    });
    chain.splice(at + 1, 0, ...kept);
  }
  return chain;
}

/** Text an attachment record contributes to the next user message (claude stores it pre-rendered). */
function attachmentText(r: Rec): string[] {
  return (r.rendered ?? []).map((p: { content: unknown }) => (typeof p.content === "string" ? p.content : JSON.stringify(p.content)));
}

function asBlocks(content: string | Block[]): Block[] {
  return typeof content === "string" ? [{ type: "text", text: content }] : content;
}

type UserItem = { kind: "user"; blocks: Block[] } | { kind: "attachment"; texts: string[] } | { kind: "barrier" };

/**
 * Fold one run of user-side records into a single user message the way claude 2.1.289 does
 * (verified by capturing its --resume requests on real fleet transcripts): rendered attachments
 * BUBBLE UP past prompt/command records until they reach a record carrying a tool_result, a
 * dropped API-error turn (a barrier), or the start of the run. Landing right behind a tool_result
 * block they are appended INTO its content; otherwise they become text blocks at that spot.
 */
function userMessage(items: UserItem[]): ApiMessage {
  const placed: UserItem[] = [];
  let anchor = -1;
  for (const it of items) {
    if (it.kind === "barrier") { anchor = placed.length - 1; continue; }
    if (it.kind === "attachment") {
      if (it.texts.length) placed.splice(++anchor, 0, it);
      continue;
    }
    placed.push(it);
    if (it.blocks.some((b) => b.type === "tool_result")) anchor = placed.length - 1;
  }
  const content: Block[] = [];
  for (const it of placed) {
    if (it.kind === "barrier") continue;
    if (it.kind === "user") { content.push(...it.blocks.map((b) => ({ ...b }))); continue; }
    const last = content[content.length - 1];
    if (last?.type === "tool_result") {
      const text = it.texts.join("\n\n");
      last.content = typeof last.content === "string" || last.content == null
        ? [last.content ?? "", text].filter(Boolean).join("\n\n")
        : [...last.content, { type: "text", text }];
    } else content.push(...it.texts.map((text) => ({ type: "text", text })));
  }
  return { role: "user", content };
}

/**
 * Chain → Messages API messages. Assistant records that share a message.id are one API message
 * (claude writes one record per content block). Consecutive user-side records (prompt, tool
 * results, rendered attachments) become one user message.
 */
export function toMessages(chain: Rec[]): ApiMessage[] {
  const out: ApiMessage[] = [];
  let pending: UserItem[] = [];
  let lastAssistantId: string | undefined;
  const flush = () => {
    // a run of attachments that render nothing (hook_success, prompt_snapshot, …) sends nothing
    const msg = userMessage(pending);
    if (msg.content.length) out.push(msg);
    pending = [];
  };
  for (const r of chain) {
    if (r.type === "assistant") {
      const m = r.message;
      if (!m) continue;
      // "<synthetic>" turns ("No response requested.") ARE replayed. API-error stand-ins are not,
      // but they still stop attachments bubbling up (claude drops them only after placing those).
      if (r.isApiErrorMessage) { pending.push({ kind: "barrier" }); continue; }
      const blocks = (m.content as Block[]).map(({ caller: _c, ...b }) => b);
      // Parallel tool calls: one API message spread over several same-id records, with results
      // pending between them — join the open assistant message while only results pend.
      const open = out[out.length - 1];
      const onlyResults = pending.every((it) => it.kind === "user" ? it.blocks.every((b) => b.type === "tool_result") : it.kind !== "attachment");
      if (m.id && m.id === lastAssistantId && open?.role === "assistant" && onlyResults) {
        open.content = [...asBlocks(open.content), ...blocks];
        continue;
      }
      flush();
      out.push({ role: "assistant", content: blocks });
      lastAssistantId = m.id;
      continue;
    }
    if (r.type === "user") pending.push({ kind: "user", blocks: asBlocks(r.message.content) });
    // a slash command run between turns (/model, /mcp, …) is a system record the model still sees
    else if (r.type === "system" && r.subtype === "local_command" && typeof r.content === "string") pending.push({ kind: "user", blocks: [{ type: "text", text: r.content }] });
    else if (r.type === "attachment") pending.push({ kind: "attachment", texts: attachmentText(r) });
  }
  flush();
  if (out[0]?.role !== "user") throw new Error("reconstructed conversation does not start with a user message");
  return out;
}

/** Appends main-thread records to a transcript, chaining each to the previous one. */
export class TranscriptWriter {
  private parent: string;
  private path: string;
  private base: { sessionId: string; cwd: string; version: string; gitBranch: string };
  constructor(path: string, base: { sessionId: string; cwd: string; version: string; gitBranch: string }, leafUuid: string) {
    this.path = path;
    this.base = base;
    this.parent = leafUuid;
  }

  get leaf(): string { return this.parent; }

  private write(rec: Rec): Rec {
    appendFileSync(this.path, JSON.stringify(rec) + "\n");
    if (rec.uuid) this.parent = rec.uuid;
    return rec;
  }

  private envelope(type: string): Rec {
    return {
      parentUuid: this.parent, isSidechain: false, type, uuid: randomUUID(), timestamp: new Date().toISOString(),
      userType: "external", entrypoint: "sdk-cli", cwd: this.base.cwd, sessionId: this.base.sessionId,
      version: this.base.version, gitBranch: this.base.gitBranch,
    };
  }

  userPrompt(text: string, promptId: string): Rec {
    return this.write({ ...this.envelope("user"), promptId, message: { role: "user", content: text } });
  }

  /** One record per API message (claude splits per block; either loads — see the doc). */
  assistant(msg: Record<string, any>, requestId: string | null): Rec {
    return this.write({ ...this.envelope("assistant"), requestId, message: msg });
  }

  toolResults(results: Block[], assistantUuid: string, promptId: string, toolUseResult: unknown): Rec {
    return this.write({
      ...this.envelope("user"), promptId, message: { role: "user", content: results },
      toolUseResult, sourceToolAssistantUUID: assistantUuid,
    });
  }

  /** Metadata (no uuid): which leaf `--resume` lands on and the prompt shown in the picker. */
  lastPrompt(text: string): void {
    this.write({ type: "last-prompt", lastPrompt: text.slice(0, 200), leafUuid: this.parent, sessionId: this.base.sessionId });
  }
}
