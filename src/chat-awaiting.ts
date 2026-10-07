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
   * A reply from `name`. Answers the message it names in `replyTo` when that is one of ours, else the
   * OLDEST pending message to that agent — its elapsed time is measured from that message's send.
   */
  reply(name: string, replyTo: string | undefined): ReplyOutcome {
    const k = this.key(name);
    const list = this.pending.get(k) ?? [];
    let idx = replyTo ? list.findIndex((p) => p.id === replyTo) : -1;
    if (idx === -1 && list.length) idx = 0;
    if (idx === -1) return { remaining: 0 };
    const [answered] = list.splice(idx, 1);
    if (list.length) this.pending.set(k, list);
    else this.pending.delete(k);
    return { answered, remaining: list.length };
  }

  pendingFor(name: string): readonly PendingMessage[] {
    return this.pending.get(this.key(name)) ?? [];
  }
}
