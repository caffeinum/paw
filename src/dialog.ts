/**
 * An agent's DIALOG (docs/notes/company-spec.md §0.5): every DM the agent sent or received — agent↔
 * agent included, not just agent↔you — plus its posts in a company channel and posts that @mention it.
 *
 * A SEPARATE store from the human's `Conversation` (web.ts): that admitter is scoped to the operator's
 * own mail on purpose (it drives unread), and must never be widened. This one admits every DM, holds
 * only a capped live tail from the whole-space tap, and is FILTERED per request. Deep history is the
 * same `ep.dmHistory` read paw web already does — god-view, so on an authed mesh it throws, and the
 * route reports that verbatim instead of an empty dialog.
 */
import type { CotalMessage } from "@cotal-ai/core";
import { messageText } from "./feed.ts";
import { HUMAN_PEER } from "./names.ts";

export interface DialogEntry {
  from: string;
  /** DM recipient: a NAME when the stream has seen that id send, else the raw id (never a guess). */
  to?: string;
  /** Set for a channel post. */
  channel?: string;
  text: string;
  ts: number;
}

/** The fields of a DM/channel message this needs (HistoryMessage and tapped frames both have them). */
export interface RawMessage {
  id?: string;
  from: { id?: string; name: string };
  to?: string;
  channel?: string;
  ts: number;
  parts: CotalMessage["parts"];
}

const LIVE_CAP = 2000;

/** id → name, learned from every sender seen (history or tap). The operator's own endpoint is "you". */
export function namesFrom(msgs: RawMessage[], meId: string, into = new Map<string, string>()): Map<string, string> {
  for (const m of msgs) if (m.from?.id && m.from.name) into.set(m.from.id, m.from.id === meId ? HUMAN_PEER : m.from.name);
  into.set(meId, HUMAN_PEER);
  return into;
}

/** DMs (no channel) with the agent on either end, as named entries, oldest first, deduped by id/key. Pure. */
export function dialogDms(msgs: RawMessage[], agent: string, names: Map<string, string>, meId: string): DialogEntry[] {
  const seen = new Set<string>();
  const out: DialogEntry[] = [];
  for (const m of msgs) {
    if (!m || !m.from || m.channel || !m.to) continue;
    const from = m.from.id === meId ? HUMAN_PEER : m.from.name;
    const to = names.get(m.to) ?? m.to;
    if (from !== agent && to !== agent) continue;
    const key = m.id ?? `${m.ts}\0${from}\0${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ from, to, text: messageText(m as CotalMessage), ts: m.ts });
  }
  return out.sort((a, b) => a.ts - b.ts);
}

/** Channel posts BY the agent or @mentioning it. Pure. */
export function dialogChannel(posts: Array<{ from: string; text: string; ts: number }>, agent: string, channel: string): DialogEntry[] {
  const mention = new RegExp(`(^|[^A-Za-z0-9._-])@${agent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9._-])`);
  return posts.filter((p) => p.from === agent || mention.test(p.text)).map((p) => ({ from: p.from, text: p.text, ts: p.ts, channel }));
}

/** The live half: every DM the tap sees (capped), so a dialog updates between history reads. */
export class DialogTail {
  private live: RawMessage[] = [];
  private ids = new Set<string>();
  readonly names = new Map<string, string>();

  accept(m: CotalMessage | undefined): void {
    if (!m || typeof m !== "object" || !Array.isArray(m.parts) || !m.from) return; // control frames carry no from
    if (m.from.id && m.from.name) this.names.set(m.from.id, m.from.name);
    if (typeof m.channel === "string" && m.channel) return;
    if (typeof m.to !== "string" || !m.to || typeof m.id !== "string" || this.ids.has(m.id)) return;
    this.ids.add(m.id);
    this.live.push(m as unknown as RawMessage);
    if (this.live.length > LIVE_CAP) {
      for (const old of this.live.splice(0, this.live.length - LIVE_CAP)) if (old.id) this.ids.delete(old.id);
    }
  }

  tail(): RawMessage[] {
    return [...this.live];
  }
}
