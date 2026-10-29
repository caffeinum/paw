/**
 * What `paw chat` is waiting for: one entry PER SENT MESSAGE, per agent — never a single slot.
 *
 * A single slot lost track the moment you sent a second line to an agent that was mid-turn: the slot
 * was overwritten, no status flip announced it, the reply to line 1 cleared the slot stamped with the
 * time since line 2, and the agent's later turn for line 2 printed a bare "• x working". Line 2 looked
 * lost when it was only queued. Pure (no I/O, no clock) so check:chat drives it directly.
 */
export interface PendingMessage {
  id: string;
  name: string;
  at: number;
  /** Sent while the agent was already working: it waits for a later turn (or gets folded into this one). */
  queued: boolean;
  picked: boolean;
}

export interface SendOutcome {
  queued: boolean;
}

export interface ReplyOutcome {
  /** The pending message this reply answers; undefined when nothing was pending for that agent. */
  answered?: PendingMessage;
  /** Messages to that agent still waiting after this reply. */
  remaining: number;
}

const isWorking = (status: string | undefined): boolean => status === "working";

export class AwaitTracker {
  private pending = new Map<string, PendingMessage[]>();
  private status = new Map<string, string>();

  private key(name: string): string {
    return name.toLowerCase();
  }

  /** Record a send. `statusNow` is the agent's presence status from the live roster at send time. */
  sent(name: string, id: string, at: number, statusNow: string | undefined): SendOutcome {
    const k = this.key(name);
    if (statusNow !== undefined) this.status.set(k, statusNow);
    const queued = isWorking(statusNow);
    const list = this.pending.get(k) ?? [];
    list.push({ id, name, at, queued, picked: false });
    this.pending.set(k, list);
    return { queued };
  }

  /**
   * A presence update. Only a TRANSITION into working starts a turn — an activity update inside a turn
   * that was already running when you sent says nothing about your message. That turn picks up every
   * not-yet-picked message sent before it (claude folds queued input into its next turn). Returns the
   * messages this turn picked up, oldest first; empty when the event is not a new turn for them.
   */
  presence(name: string, status: string): PendingMessage[] {
    const k = this.key(name);
    const was = this.status.get(k);
    this.status.set(k, status);
    if (!isWorking(status) || isWorking(was)) return [];
    const picked = (this.pending.get(k) ?? []).filter((p) => !p.picked);
    for (const p of picked) p.picked = true;
    return picked;
  }

  /**
   * A reply from `name`. Answers the message it names in `replyTo` when that is one of ours. Otherwise
   * (a plain cotal_dm names none) it answers every message the agent's turn already picked up — a turn
   * drains the whole inbox, so one reply covers them all — or every pending one when no turn was seen.
   * Messages still queued for a later turn stay pending. `answered` is the NEWEST message covered, so the
   * elapsed time reads from your latest line, not from one sent hours ago (the 7472s "hey" of 2026-10-28).
   */
  reply(name: string, replyTo: string | undefined): ReplyOutcome {
    const k = this.key(name);
    const list = this.pending.get(k) ?? [];
    if (!list.length) return { remaining: 0 };
    const named = replyTo ? list.find((p) => p.id === replyTo) : undefined;
    const covered = named ? [named] : list.some((p) => p.picked) ? list.filter((p) => p.picked) : list;
    const rest = list.filter((p) => !covered.includes(p));
    if (rest.length) this.pending.set(k, rest);
    else this.pending.delete(k);
    return { answered: covered[covered.length - 1], remaining: rest.length };
  }

  pendingFor(name: string): readonly PendingMessage[] {
    return this.pending.get(this.key(name)) ?? [];
  }
}
