/**
 * paw chat's outgoing messages: sent in order, retried through a flaky link, never silently dropped.
 *
 * A send on a slow remote broker failed with nats.js `TimeoutError` (`! timeout`) and the operator could
 * not tell whether the message went (team2027, 2026-10-27). Now a send whose failure is transient (a
 * timeout, a reconnect, a DNS/dial error — `classifyEndpointError`) is KEPT and re-published with
 * backoff, with the SAME message id (src/mesh-publish.ts), so a copy that did land is deduped by the
 * broker and a retry can never deliver twice. It gives up after {@link GIVE_UP_MS} — inside the
 * stream's 2-minute duplicate window, so even the last retry is still deduped — or at once on a
 * non-transient error (auth, permissions, anything unrecognised), and then says so ONCE; `/retry`
 * re-queues what failed, same ids.
 *
 * One FIFO: only the head is in flight, so a line typed while an earlier one is still retrying lands
 * after it. Pure apart from the injected publish and timers — check:chat drives it with a fake clock.
 */
import { classifyEndpointError } from "./conn-state.ts";

/** Stop retrying a transient failure this long after the first attempt (< the 2m dedup window). */
export const GIVE_UP_MS = 90_000;
/** Waits between attempts; the last repeats. */
export const BACKOFF_MS = [1000, 2000, 4000, 8000, 15_000];

export type OutState = "queued" | "sending" | "retrying" | "sent" | "failed";

export interface OutItem<M> {
  seq: number;
  /** Who it is for, as the transcript names it (`kit`, `#general`). */
  label: string;
  msg: M;
  /** First attempt of the CURRENT run (a `/retry` starts a new run, same message). */
  firstAt: number;
  /** When the message was first submitted — for the dedup-window warning on `/retry`. */
  createdAt: number;
  attempts: number;
  state: OutState;
  lastError?: string;
  /** Ran into at least one transient failure in this run (the transcript showed `◌ sending…`). */
  retried: boolean;
  /** The broker reported the msgID as already stored — an earlier attempt had landed. */
  duplicate?: boolean;
}

export type OutEvent<M> =
  /** First transient failure of a run: the message is pending, a retry is scheduled. */
  | { kind: "pending"; item: OutItem<M>; error: string }
  | { kind: "sent"; item: OutItem<M> }
  /** Given up: `transient` false = refused outright; true = the bound passed. */
  | { kind: "failed"; item: OutItem<M>; error: string; transient: boolean };

export interface OutboxOpts<M> {
  publish: (msg: M) => Promise<{ duplicate?: boolean } | void>;
  onEvent: (e: OutEvent<M>) => void;
  now?: () => number;
  /** Run `fn` after `ms`; returns a cancel. Defaults to an unref'd setTimeout. */
  schedule?: (fn: () => void, ms: number) => () => void;
  giveUpMs?: number;
  backoffMs?: number[];
}

const defaultSchedule = (fn: () => void, ms: number): (() => void) => {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return () => clearTimeout(t);
};

export class Outbox<M> {
  private readonly q: OutItem<M>[] = [];
  private readonly failedItems: OutItem<M>[] = [];
  private seq = 0;
  private busy = false;
  private cancelWait: (() => void) | undefined;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => () => void;
  private readonly giveUpMs: number;
  private readonly backoff: number[];
  private readonly waiters = new Map<number, (it: OutItem<M>) => void>();
  private readonly o: OutboxOpts<M>;

  constructor(o: OutboxOpts<M>) {
    this.o = o;
    this.now = o.now ?? Date.now;
    this.schedule = o.schedule ?? defaultSchedule;
    this.giveUpMs = o.giveUpMs ?? GIVE_UP_MS;
    this.backoff = o.backoffMs ?? BACKOFF_MS;
  }

  /** Queue a message; resolves with the item once it is sent or has failed for good. */
  submit(label: string, msg: M): Promise<OutItem<M>> {
    const at = this.now();
    const item: OutItem<M> = { seq: ++this.seq, label, msg, firstAt: at, createdAt: at, attempts: 0, state: "queued", retried: false };
    return this.enqueue(item);
  }

  /** Re-queue every failed message (oldest first), same ids. Returns what was re-queued. */
  retry(): OutItem<M>[] {
    const again = this.failedItems.splice(0);
    for (const it of again) {
      it.state = "queued";
      it.attempts = 0;
      it.retried = false;
      it.lastError = undefined;
      void this.enqueue(it);
    }
    return again;
  }

  /** The connection came back: stop waiting out the backoff and try the head now. */
  kick(): void {
    if (!this.cancelWait) return;
    this.cancelWait();
    this.cancelWait = undefined;
    void this.pump();
  }

  /** Not yet sent and not failed (in flight, retrying, or queued behind one). */
  pending(): OutItem<M>[] {
    return [...this.q];
  }

  failed(): OutItem<M>[] {
    return [...this.failedItems];
  }

  private enqueue(item: OutItem<M>): Promise<OutItem<M>> {
    const done = new Promise<OutItem<M>>((res) => this.waiters.set(item.seq, res));
    this.q.push(item);
    void this.pump();
    return done;
  }

  private settle(item: OutItem<M>): void {
    this.q.shift();
    this.waiters.get(item.seq)?.(item);
    this.waiters.delete(item.seq);
  }

  private async pump(): Promise<void> {
    if (this.busy || this.cancelWait) return;
    const item = this.q[0];
    if (!item) return;
    this.busy = true;
    if (item.state === "queued") {
      // A run's clock starts when it reaches the head — a line queued behind a retrying one gets its
      // own full window, not the leftovers of the one ahead.
      item.firstAt = this.now();
      item.state = "sending";
    }
    item.attempts++;
    let error: Error | undefined;
    let ack: { duplicate?: boolean } | void = undefined;
    try {
      ack = await this.o.publish(item.msg);
    } catch (e) {
      error = e instanceof Error ? e : new Error(String(e));
    }
    this.busy = false;
    if (!error) {
      item.state = "sent";
      if (ack && ack.duplicate) item.duplicate = true;
      this.settle(item);
      this.o.onEvent({ kind: "sent", item });
      return void this.pump();
    }
    const text = error.message || String(error);
    item.lastError = text;
    const transient = classifyEndpointError(error) === "transient";
    const elapsed = this.now() - item.firstAt;
    if (!transient || elapsed >= this.giveUpMs) {
      item.state = "failed";
      this.settle(item);
      this.failedItems.push(item);
      this.o.onEvent({ kind: "failed", item, error: text, transient });
      return void this.pump();
    }
    if (!item.retried) {
      item.retried = true;
      this.o.onEvent({ kind: "pending", item, error: text });
    }
    item.state = "retrying";
    const wait = Math.min(this.backoff[Math.min(item.attempts - 1, this.backoff.length - 1)], Math.max(0, this.giveUpMs - elapsed));
    this.cancelWait = this.schedule(() => {
      this.cancelWait = undefined;
      void this.pump();
    }, wait);
  }
}
