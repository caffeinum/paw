/**
 * The office bridge: mirrors a space's agents into its agent-office over REST (src/office-api.ts).
 *
 * Pure mapping (row → join/status payloads, tapped message → office speech, office chat → paw DM) plus
 * {@link OfficeBridge}, a single sequential worker with every effect injected — the daemon wiring is
 * src/office-daemon.ts. One worker, one call at a time, so the office's limits (30 calls/10s per agent,
 * 120/10s and 10 joins/min per IP) are a local budget, and a 429 pauses the whole link for its
 * `retryAfter`. Nothing here can throw out of {@link OfficeBridge.tick}: a bad link logs, it never takes
 * the host daemon (or another space) down.
 */
import type { AgentStatus } from "./status.ts";
import type { BridgeState } from "./office-link.ts";
import { OfficeError, type OfficeCall } from "./office-api.ts";

export const ACTIVITY_MAX = 120;
/** Office text limit is 280; a mirrored line is clipped well under it. */
export const SPEECH_MAX = 200;
export const INBOUND_MAX = 2000;

export type OfficeStatus = "working" | "waiting" | "idle";
export interface Desired {
  present: boolean;
  status: OfficeStatus;
  activity?: string;
}

type Row = Pick<AgentStatus, "name" | "mesh" | "live" | "busy" | "tool" | "git" | "failure" | "stuck" | "emoji" | "hue">;

// Control and bidi-override characters: the office refuses them (SPOOF_CHARS_RE there).
const SPOOF = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/gu;

/** One line, no control/bidi characters, at most `max` chars (an ellipsis marks a cut). */
export function clip(text: string, max: number): string {
  const flat = text.replace(SPOOF, " ").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** `mcp__cotal__cotal_dm` → `cotal_dm`: the tool's own name, never its arguments (they can hold paths/secrets). */
export function toolName(name: string): string {
  const m = /^mcp__[^_]+(?:_[^_]+)*?__(.+)$/.exec(name);
  return m ? m[1]! : name;
}

/** `owner/repo` → `repo`. Never the folder path. */
function repoOf(row: Row): string | undefined {
  const r = row.git?.repo;
  return r ? r.split("/").pop() : undefined;
}

/** What the office should show for a paw row. */
export function desiredFor(row: Row): Desired {
  if (!row.live || row.mesh === "offline") return { present: false, status: "idle" };
  const repo = repoOf(row);
  if (row.stuck || (row.failure && !row.busy)) return { present: true, status: "waiting", activity: clip(row.stuck ? "stuck: needs a look" : "last turn failed: needs a look", ACTIVITY_MAX) };
  // waiting before busy: paw's busy inference counts a waiting agent as mid-turn
  if (row.mesh === "waiting") return { present: true, status: "waiting", ...(repo ? { activity: clip(`waiting · ${repo}`, ACTIVITY_MAX) } : {}) };
  if (row.mesh === "working" || row.busy) {
    const what = row.tool ? toolName(row.tool.name) : "working";
    return { present: true, status: "working", activity: clip(repo ? `${what} · ${repo}` : what, ACTIVITY_MAX) };
  }
  if (row.mesh === "starting") return { present: true, status: "idle", activity: "starting up" };
  return { present: true, status: "idle" };
}

const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });
/** The office takes ONE emoji; anything else is omitted rather than failing the join. */
export function singleEmoji(e: string | undefined): string | undefined {
  if (!e) return undefined;
  return [...graphemes.segment(e)].length === 1 && !/[\p{L}\p{N}\p{P}\s<>]/u.test(e.replace(/[‍️]/g, "")) ? e : undefined;
}

export function joinPayload(row: Row): { name: string; client: "paw"; hue?: number; emoji?: string } {
  const emoji = singleEmoji(row.emoji);
  return {
    name: clip(row.name, 32),
    client: "paw",
    ...(row.hue !== undefined && Number.isInteger(row.hue) && row.hue >= 0 && row.hue <= 359 ? { hue: row.hue } : {}),
    ...(emoji ? { emoji } : {}),
  };
}

export function statusPayload(d: Desired): { status: OfficeStatus; activity?: string } {
  return { status: d.status, ...(d.activity ? { activity: d.activity } : {}) };
}

export const statusKey = (d: Desired): string => `${d.status}\u0000${d.activity ?? ""}`;

/** A line to say in the office on behalf of a bridged agent. */
export interface Speech {
  from: string;
  /** say = bubble + room chat (channel posts); chat = a message to one agent or to the office's human. */
  kind: "say" | "chat";
  to?: { agent: string } | { human: true };
  text: string;
}

export interface TappedMessage {
  id?: string;
  from?: { id?: string; name?: string };
  to?: unknown;
  channel?: unknown;
  parts?: unknown;
  ts?: number;
}

/**
 * A tapped mesh message → what to say in the office, or undefined. Only BRIDGED agents speak (the human
 * can't be attributed over REST, and the human's office chat already shows there); a DM to "you" goes to
 * the office's human, a DM to another bridged agent goes to that agent, a channel post is said aloud.
 */
export function speechFor(
  m: TappedMessage | undefined,
  ctx: { humanId: string; humanName?: string; names: ReadonlyMap<string, string>; bridged: ReadonlySet<string>; text: (m: TappedMessage) => string },
): Speech | undefined {
  if (!m || typeof m !== "object" || !Array.isArray(m.parts) || !m.from?.name || m.from.id === ctx.humanId) return undefined;
  const from = m.from.name;
  if (!ctx.bridged.has(from)) return undefined;
  const raw = ctx.text(m);
  if (!raw.trim()) return undefined;
  if (typeof m.channel === "string" && m.channel) return { from, kind: "say", text: clip(`#${m.channel}: ${raw}`, SPEECH_MAX) };
  if (typeof m.to !== "string" || !m.to) return undefined;
  // by id, or by the human's roster name: under auth the observer's card id isn't the human's DM id
  if (m.to === ctx.humanId || (ctx.humanName !== undefined && ctx.names.get(m.to) === ctx.humanName)) return { from, kind: "chat", to: { human: true }, text: clip(raw, SPEECH_MAX) };
  const to = ctx.names.get(m.to);
  if (!to || to === from || !ctx.bridged.has(to)) return undefined;
  return { from, kind: "chat", to: { agent: to }, text: clip(raw, SPEECH_MAX) };
}

export interface OfficeChatMsg {
  id: string;
  from: string;
  to: string | null;
  text: string;
  ts: number;
}

/** Office chat read for one bridged agent → the messages to deliver to it as paw DMs: addressed to it
 *  (not the room), from a human or a non-paw office agent — never another bridged agent's mirrored line. */
export function inboundFor(msgs: readonly OfficeChatMsg[], me: string, bridgedIds: ReadonlySet<string>): OfficeChatMsg[] {
  return msgs.filter((m) => m.to === me && m.from !== me && !bridgedIds.has(m.from));
}

/** The paw DM an office message becomes. */
export function inboundText(m: OfficeChatMsg, names: Record<string, string>): string {
  const who = m.from.startsWith("human:") ? m.from.slice(6) : (names[m.from] ?? m.from);
  return `[agent office] ${clip(who, 40)}: ${m.text.slice(0, INBOUND_MAX)}`;
}

/** Calls allowed per sliding window. */
export class Budget {
  private hits: number[] = [];
  private readonly max: number;
  private readonly windowMs: number;
  constructor(max: number, windowMs: number) {
    this.max = max;
    this.windowMs = windowMs;
  }
  allow(now: number): boolean {
    this.hits = this.hits.filter((t) => now - t < this.windowMs);
    if (this.hits.length >= this.max) return false;
    this.hits.push(now);
    return true;
  }
}

/** Chat poll per agent (it is also the presence heartbeat: any call keeps an agent from going away at 5 min). */
export const pollInterval = (agents: number): number => Math.max(15_000, agents * 400);

export interface BridgeDeps {
  call: OfficeCall;
  state: BridgeState;
  save: (s: BridgeState) => void;
  /** Deliver an office message to a paw agent as a DM from the operator. */
  deliver: (agent: string, text: string) => Promise<void>;
  log: (line: string) => void;
  /** The office's name for the operator when no office human has written yet (`human:<this>`). */
  operator: string;
  now?: () => number;
}

interface Pending {
  speech: Speech;
  at: number;
}

const SPEECH_QUEUE_MAX = 40;
const IP_BUDGET = 100; // of the office's 120 calls / 10s per IP
const JOIN_BUDGET = 8; // of its 10 joins / min per IP
const AGENT_BUDGET = 20; // of its 30 calls / 10s per agent
const BACKOFF_MAX_MS = 5 * 60_000;
const DELIVER_ATTEMPTS = 3;
const KEY_REFUSED_PAUSE_MS = 60_000;

/** A 401 for the office key (agent-office: "missing or wrong key for this office"), as opposed to an unknown agentToken. */
export const keyRefusal = (e: unknown): boolean => e instanceof OfficeError && e.status === 401 && /missing or wrong key/i.test(e.message);

export class OfficeBridge {
  private readonly d: BridgeDeps;
  private readonly now: () => number;
  private rows = new Map<string, Row>();
  private rowsKnown = false;
  private sent = new Map<string, string>();
  private lastPoll = new Map<string, number>();
  private fails = new Map<string, { n: number; until: number }>();
  private deliverFails = new Map<string, number>();
  /** Who last wrote to each bridged agent from the office (`human:<name>` or an office agent id): where its reply to "you" goes. */
  private lastFrom = new Map<string, string>();
  /** Office message ids already delivered per agent, so a retried batch never DMs one twice. */
  private delivered = new Map<string, Set<string>>();
  private keyRefused = false;
  private stopped = false;
  private queue: Pending[] = [];
  private dropped = 0;
  private pausedUntil = 0;
  private readonly ip = new Budget(IP_BUDGET, 10_000);
  private readonly joins = new Budget(JOIN_BUDGET, 60_000);
  private readonly perAgent = new Map<string, Budget>();
  private running = false;

  constructor(deps: BridgeDeps) {
    this.d = deps;
    this.now = deps.now ?? Date.now;
  }

  get state(): BridgeState {
    return this.d.state;
  }

  /** The latest roster. Until the first call nothing is joined or left (an unread roster is not "everyone offline"). */
  setRows(rows: readonly Row[]): void {
    this.rows = new Map(rows.map((r) => [r.name, r]));
    this.rowsKnown = true;
  }

  /** Names currently mirrored (present on the paw side). */
  bridged(): Set<string> {
    return new Set([...this.rows.values()].filter((r) => desiredFor(r).present).map((r) => r.name));
  }

  /** Queue a line; consecutive lines from one speaker to one target coalesce. */
  noteSpeech(s: Speech): void {
    const last = this.queue.at(-1)?.speech;
    if (last && last.from === s.from && last.kind === s.kind && JSON.stringify(last.to) === JSON.stringify(s.to)) {
      last.text = clip(`${last.text} / ${s.text}`, SPEECH_MAX);
      return;
    }
    this.queue.push({ speech: { ...s }, at: this.now() });
    if (this.queue.length > SPEECH_QUEUE_MAX) {
      this.queue.shift();
      this.dropped++;
    }
  }

  pausedFor(): number {
    return Math.max(0, this.pausedUntil - this.now());
  }

  /** One pass: leaves, joins, status changes, speech, then chat polls — as far as the budgets allow. */
  async tick(): Promise<void> {
    if (this.running || !this.rowsKnown || this.stopped) return;
    this.running = true;
    try {
      await this.pass();
    } catch (e) {
      this.d.log(`office bridge: unexpected ${(e as Error).stack ?? e}`);
    } finally {
      this.running = false;
    }
  }

  /** Stop ticking (waits out a pass in flight). `leave` walks every agent this bridge holds a token for out —
   *  the link is gone, so nobody else will, and the office would otherwise keep them for an hour. */
  async shutdown(leave: boolean): Promise<number> {
    this.stopped = true;
    for (let i = 0; this.running && i < 200; i++) await new Promise((r) => setTimeout(r, 100));
    if (!leave) return 0;
    let left = 0;
    for (const [name, a] of Object.entries(this.d.state.agents)) {
      try {
        await this.d.call("leave", {}, { token: a.token });
        left++;
      } catch (e) {
        if (!(e instanceof OfficeError && e.status === 401 && !keyRefusal(e))) this.d.log(`office bridge: couldn't walk ${name} out: ${(e as Error).message}`);
      }
    }
    return left;
  }

  private budget(agent: string, now: number): boolean {
    let b = this.perAgent.get(agent);
    if (!b) this.perAgent.set(agent, (b = new Budget(AGENT_BUDGET, 10_000)));
    return b.allow(now) && this.ip.allow(now);
  }

  private blocked(name: string, now: number): boolean {
    const f = this.fails.get(name);
    return !!f && now < f.until;
  }

  private async pass(): Promise<void> {
    const now = this.now();
    if (now < this.pausedUntil) return;
    if (this.dropped) {
      this.d.log(`office bridge: speech queue full — dropped ${this.dropped} oldest line(s)`);
      this.dropped = 0;
    }
    const agents = this.d.state.agents;
    const want = new Map([...this.rows].map(([n, r]) => [n, desiredFor(r)]));

    for (const name of Object.keys(agents)) {
      if (want.get(name)?.present) continue;
      if (this.blocked(name, now) || !this.budget(name, now)) continue;
      if (!(await this.run(name, () => this.d.call("leave", {}, { token: agents[name]!.token }), true))) continue;
      this.forget(name);
    }
    for (const [name, d] of want) {
      if (!d.present || agents[name] || this.blocked(name, now)) continue;
      if (!this.joins.allow(now) || !this.budget(name, now)) break;
      const r = (await this.run(name, () => this.d.call("join", joinPayload(this.rows.get(name)!)))) as { agentToken?: string; agent?: { id?: string } } | undefined;
      if (!r) continue;
      if (typeof r.agentToken !== "string" || typeof r.agent?.id !== "string") {
        this.fail(name, new Error("office join: response has no agentToken/agent.id"));
        continue;
      }
      agents[name] = { id: r.agent.id, token: r.agentToken, joinedAt: now };
      this.sent.delete(name);
      this.d.save(this.d.state);
    }
    for (const [name, d] of want) {
      const a = agents[name];
      if (!d.present || !a || this.sent.get(name) === statusKey(d) || this.blocked(name, now)) continue;
      if (!this.budget(name, now)) continue;
      if (await this.run(name, () => this.d.call("status", statusPayload(d), { token: a.token }))) this.sent.set(name, statusKey(d));
    }
    while (this.queue.length) {
      const { speech: s } = this.queue[0]!;
      const a = agents[s.from];
      if (!a || this.blocked(s.from, now)) {
        this.queue.shift(); // its speaker isn't in the office (or is failing, already logged): nowhere to say it
        continue;
      }
      if (!this.budget(s.from, now)) break;
      const ok = await this.run(s.from, () => this.say(s, a.token));
      if (!ok && this.now() < this.pausedUntil) return;
      this.queue.shift(); // said, or failed loudly — never retried forever
    }
    const ids = new Set(Object.values(agents).map((a) => a.id));
    const every = pollInterval(Object.keys(agents).length);
    for (const name of Object.keys(agents)) {
      if (now - (this.lastPoll.get(name) ?? 0) < every || this.blocked(name, now)) continue;
      if (!this.budget(name, now)) break;
      if (!(await this.poll(name, ids))) return;
    }
  }

  private async say(s: Speech, token: string): Promise<unknown> {
    if (s.kind === "say") return this.d.call("say", { text: s.text }, { token });
    if (s.to && "human" in s.to) {
      const to = this.lastFrom.get(s.from) ?? `human:${this.d.state.lastHuman ?? this.d.operator}`;
      return this.d.call("chat_send", { to, text: s.text }, { token });
    }
    const target = s.to ? this.d.state.agents[s.to.agent] : undefined;
    if (target) return this.d.call("chat_send", { to: target.id, text: s.text }, { token });
    return this.d.call("say", { text: clip(`@${s.to?.agent}: ${s.text}`, SPEECH_MAX) }, { token });
  }

  /** Read one agent's chat and deliver what is addressed to it. False = stop this pass (paused). */
  private async poll(name: string, bridgedIds: ReadonlySet<string>): Promise<boolean> {
    const a = this.d.state.agents[name]!;
    const r = (await this.run(name, () => this.d.call("chat_read", a.since === undefined ? {} : { since: a.since }, { token: a.token }))) as
      | { messages?: OfficeChatMsg[]; more?: boolean; now?: number; names?: Record<string, string> }
      | undefined;
    if (!r) return this.now() >= this.pausedUntil;
    this.lastPoll.set(name, this.now());
    const msgs = Array.isArray(r.messages) ? r.messages : [];
    let since = r.more && msgs.length ? msgs.at(-1)!.ts : typeof r.now === "number" ? r.now : a.since;
    let done = this.delivered.get(name);
    if (!done) this.delivered.set(name, (done = new Set()));
    for (const m of inboundFor(msgs, a.id, bridgedIds)) {
      if (done.has(m.id)) continue;
      try {
        await this.d.deliver(name, inboundText(m, r.names ?? {}));
        this.deliverFails.delete(m.id);
        done.add(m.id);
        if (done.size > 500) done.delete(done.values().next().value!);
        this.lastFrom.set(name, m.from);
        if (m.from.startsWith("human:")) this.d.state.lastHuman = m.from.slice(6);
      } catch (e) {
        const n = (this.deliverFails.get(m.id) ?? 0) + 1;
        this.deliverFails.set(m.id, n);
        if (n < DELIVER_ATTEMPTS) {
          this.d.log(`office bridge: couldn't deliver an office message to ${name} as a paw DM (attempt ${n}/${DELIVER_ATTEMPTS}, retrying): ${(e as Error).message}`);
          since = m.ts - 1; // re-read from here next poll
          break;
        }
        this.d.log(`office bridge: GAVE UP delivering an office message to ${name} after ${n} attempts: ${(e as Error).message}`);
        this.deliverFails.delete(m.id);
      }
    }
    if (since !== a.since) {
      if (since !== undefined) a.since = since;
      this.d.save(this.d.state);
    }
    return true;
  }

  private forget(name: string): void {
    delete this.d.state.agents[name];
    this.sent.delete(name);
    this.lastPoll.delete(name);
    this.d.save(this.d.state);
  }

  private fail(name: string, e: Error): void {
    const f = this.fails.get(name) ?? { n: 0, until: 0 };
    f.n++;
    f.until = this.now() + Math.min(BACKOFF_MAX_MS, 5_000 * 2 ** (f.n - 1));
    this.fails.set(name, f);
    if (f.n === 1 || f.n % 10 === 0) this.d.log(`office bridge: ${name}: ${e.message} (failure ${f.n}; retry in ${Math.round((f.until - this.now()) / 1000)}s)`);
  }

  /** Run one office call for `name`. 429 → pause the link; join key refused → pause the link, keep every
   *  token; 401 on a token call → rejoin; else per-agent backoff. */
  private async run(name: string, fn: () => Promise<unknown>, leaving = false): Promise<unknown> {
    try {
      const r = await fn();
      if (this.keyRefused) {
        this.d.log("office bridge: the office accepts the join key again — resuming");
        this.keyRefused = false;
      }
      if (this.fails.has(name)) {
        this.d.log(`office bridge: ${name}: recovered`);
        this.fails.delete(name);
      }
      return r ?? {};
    } catch (e) {
      if (e instanceof OfficeError && e.status === 429) {
        this.pausedUntil = this.now() + (e.retryAfter ?? 10) * 1000;
        this.d.log(`office bridge: rate limited by the office — pausing ${e.retryAfter ?? 10}s`);
        return undefined;
      }
      if (e instanceof OfficeError && keyRefusal(e)) {
        // The Bearer join key itself (rotated, office deleted): every call fails the same way, and the agent
        // tokens are still good — keep them, pause the whole link, say so once.
        this.pausedUntil = this.now() + KEY_REFUSED_PAUSE_MS;
        if (!this.keyRefused) this.d.log(`office bridge: the office REFUSED THE JOIN KEY (rotated?) — pausing; reconnect with the new key: \`paw office connect --space <s> --url <url> --join-key <new> [--owner-key <k>]\` (${e.message})`);
        this.keyRefused = true;
        return undefined;
      }
      if (e instanceof OfficeError && e.status === 401 && this.d.state.agents[name]) {
        // Unknown agentToken: walked out after an hour of silence, kicked, or the office lost it. Leaving is
        // then already done; anything else rejoins on the next pass.
        this.forget(name);
        if (leaving) return {};
        this.d.log(`office bridge: ${name}'s office token was refused — rejoining`);
        return undefined;
      }
      this.fail(name, e as Error);
      return undefined;
    }
  }
}
