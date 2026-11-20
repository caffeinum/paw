/**
 * The manager's seat cap (cotal 0.103 `seatCap`, Cotal-AI/Cotal#4822): a ceiling on the live seats ONE
 * manager admits per owner. On every paw mesh the owner is cotal's single `local` owner (open mesh,
 * static JWT and the signer-authed remote spaces alike — only user-auth meshes split owners), so for
 * paw it is simply "at most N live agents on this machine's manager for this space": a brake on a
 * runaway spawn loop. Opt-in; unset = unlimited, cotal's default.
 *
 *   `PAW_MAX_SEATS` env (one-shot; set-but-empty fails loud) > `$PAW_HOME/spaces/<s>/max-seats` > unlimited.
 *
 * Read only when paw STARTS a manager (it is a manager option, not a live knob): a change needs
 * `paw restart --full` (a smart restart sees the mismatch and bounces the manager itself).
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { problemLine } from "./ux.ts";

export const MAX_SEATS_ENV = "PAW_MAX_SEATS";
export const SEAT_CAP_FLAG = "--seat-cap";

/** A cap paw passes on: a positive integer, or undefined for unlimited. */
export type SeatCap = number | undefined;

export function seatCapPath(space: string): string {
  return join(process.env.PAW_HOME?.trim() || join(homedir(), ".paw"), "spaces", space, "max-seats");
}

/** `unlimited`/`off` → undefined, a positive integer → it, anything else fails loud naming `source`. */
export function parseSeatCap(raw: string, source: string): SeatCap {
  const t = raw.trim();
  if (t === "unlimited" || t === "off") return undefined;
  const n = Number(t);
  if (!/^\d+$/.test(t) || !Number.isSafeInteger(n) || n < 1)
    throw new Error(`paw: ${source} must be a positive integer, "unlimited" or "off" (got ${JSON.stringify(raw)})`);
  return n;
}

export function resolveSeatCap(space: string, env: NodeJS.ProcessEnv = process.env): SeatCap {
  const raw = env[MAX_SEATS_ENV];
  if (raw !== undefined) {
    if (!raw.trim()) throw new Error(`paw: ${MAX_SEATS_ENV} is set but empty — unset it, or give a positive integer or "unlimited"`);
    return parseSeatCap(raw, MAX_SEATS_ENV);
  }
  const file = seatCapPath(space);
  return existsSync(file) ? parseSeatCap(readFileSync(file, "utf8"), file) : undefined;
}

/** The manager argv for a cap: nothing when unlimited, so an uncapped manager's command line is unchanged. */
export function seatCapArgs(cap: SeatCap): string[] {
  return cap === undefined ? [] : [SEAT_CAP_FLAG, String(cap)];
}

/** The cap a live manager runs with, read off its own command line (no flag = unlimited). */
export function seatCapOfCommands(cmds: Iterable<string>): SeatCap {
  for (const cmd of cmds) {
    if (!cmd.includes("supervise")) continue;
    const m = /--seat-cap (\d+)/.exec(cmd);
    return m ? Number(m[1]) : undefined;
  }
  return undefined;
}

export function seatCapText(cap: SeatCap): string {
  return cap === undefined ? "unlimited" : String(cap);
}

/** cotal's structured seat-cap facts (`ai.cotal.ep.seat-cap`), carried on a refused spawn reply. */
export type SeatCapFacts = { owner: string; seats: number; cap: number };

/** The operator-facing refusal: what, why, the two ways out. Pure. */
export function seatCapRefusal(o: { space: string; name: string; facts: SeatCapFacts; defaultSpace: boolean }): string {
  const flag = o.defaultSpace ? "" : ` --space ${o.space}`;
  const { seats, cap } = o.facts;
  return problemLine(
    "✕",
    `couldn't start ${o.name} — this machine's ${o.space} manager is at its seat cap (${seats} of ${cap} live agent${cap === 1 ? "" : "s"})`,
    "nothing was launched",
    `stop one (\`paw stop <name>${flag}\`), or raise ${MAX_SEATS_ENV} / ${seatCapPath(o.space).replace(homedir(), "~")} and \`paw restart --full${flag}\``,
  );
}
