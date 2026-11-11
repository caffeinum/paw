/**
 * paw chat to an agent that runs on ANOTHER machine and is offline right now.
 *
 * Before (operator, 2026-11-11, `paw chat @2027-intern --space team2027`): a three-clause red wall
 * ("was teleported to ssh:mini at … — `paw teleport … --back` brings it back here — and it isn't on the
 * mesh right now (start it there: …) — lines to it are kept, not sent"), repeated under every refused
 * line. "why do i need to see this error? i know it was teleported, i am trying to chat with it".
 *
 * Now: the banner says ONE dim line — `○ offline — what you type sends when it's back · start it:
 * <exact command for its host>` — and lines typed to it are HELD here, in order, and sent the moment its
 * presence appears (chat already watches the roster). No over-the-mesh wake exists for another
 * machine's agent (the sleep host only stands in for agents THIS machine hosts, and under PAW_AUTH a
 * peer can't ask another machine's mailbox to spawn anything), so chat never starts it — it only waits.
 * A held line is in memory: a quit prints it in full, like every other unsent line.
 *
 * Pure (no mesh, no tty) — check:chat drives it.
 */
import { LOADER, OFF, problemLine } from "./ux.ts";
import type { Ledger } from "./peer-ledger.ts";

/** An offline target that runs elsewhere: where, and (when paw knows the transport) how to start it. */
export interface AwayTarget {
  name: string;
  where: string;
  start?: string;
}

/** The banner's one line under the agent row. The teleport history is NOT in it — the agent row
 *  already says `runs on <where>`, and when it left is not news to someone chatting with it. */
export function awayOfflineNote(t: AwayTarget): string {
  return problemLine(OFF, "offline", "what you type sends when it's back", t.start ? `start it: ${t.start}` : `start it on ${t.where}`);
}

/** The line under the FIRST held message of an absence (later ones are counted in the footer). */
export const heldLine = (name: string): string => `${LOADER} queued — sends when ${name} is back`;

/** The footer cell while lines wait for it. */
export const heldCell = (n: number, name: string): string => `${LOADER} ${n} waiting for ${name}`;

/** The transcript line when it comes back. */
export const backLine = (name: string, n: number): string =>
  n ? `${name} is back — sending ${n === 1 ? "the line" : `${n} lines`} you typed while it was offline` : `${name} is back`;

/** Lines typed to an offline away agent, per agent, in typed order. */
export class HeldForReturn {
  private readonly lines: { to: string; text: string }[] = [];
  /** Names whose `queued — sends when … is back` was already said this absence. */
  private readonly said = new Set<string>();

  /** Hold a line; true when it is the first one of this absence (say {@link heldLine} once). */
  hold(to: string, text: string): boolean {
    this.lines.push({ to, text });
    const k = to.toLowerCase();
    if (this.said.has(k)) return false;
    this.said.add(k);
    return true;
  }

  count(to?: string): number {
    return to === undefined ? this.lines.length : this.lines.filter((l) => l.to.toLowerCase() === to.toLowerCase()).length;
  }

  /** Take every line held for `to`, oldest first; the next absence says its line again. */
  drain(to: string): string[] {
    const k = to.toLowerCase();
    const out: string[] = [];
    for (let i = 0; i < this.lines.length; ) {
      if (this.lines[i]!.to.toLowerCase() === k) out.push(this.lines.splice(i, 1)[0]!.text);
      else i++;
    }
    this.said.delete(k);
    return out;
  }

  all(): { to: string; text: string }[] {
    return [...this.lines];
  }
}

/**
 * The host the peer ledger last saw `name` on (`meta.host` of its newest sighting within `maxAgeMs`),
 * when that sighting carries one. A sighting without a host says nothing — never a guessed machine.
 */
export function ledgerHost(ledger: Ledger, name: string, now: number, maxAgeMs: number): string | undefined {
  const want = name.toLowerCase();
  let best: { last: number; host?: string } | undefined;
  for (const e of Object.values(ledger)) {
    if (e.name.toLowerCase() !== want || now - e.last > maxAgeMs) continue;
    if (!best || e.last > best.last) best = e;
  }
  return best?.host;
}
