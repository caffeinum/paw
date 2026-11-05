/** The paw space a command acts on: `PAW_SPACE`, else the machine-wide default. Zero-dep leaf so
 *  modules lifecycle.ts imports (release.ts) can use it without an import cycle. */
export const DEFAULT_SPACE = "paw";

/** UNSET means the default; SET-but-empty (or whitespace) is refused. `PAW_SPACE=` used to fall
 *  through to `paw` — the LIVE space — so a test that meant to isolate itself joined the operator's
 *  mesh and started a second "you" beacon there (2026-10-21). */
export function resolveSpace(): string {
  const raw = process.env.PAW_SPACE;
  if (raw === undefined) return DEFAULT_SPACE;
  const space = raw.trim();
  if (space.length === 0) throw new Error("paw: PAW_SPACE is set but empty — unset it or give a space");
  return space;
}

/** The default space for a verb an AGENT runs about itself (`paw cron`): `PAW_SPACE` when set, else the
 *  space of the agent calling (cotal stamps COTAL_SPACE into its tools' env), else the default. An
 *  agent on a remote space (team2027) has no PAW_SPACE, and `paw` would be the wrong space for it. */
export function callerSpace(): string {
  if (process.env.PAW_SPACE !== undefined) return resolveSpace();
  return process.env.COTAL_SPACE?.trim() || DEFAULT_SPACE;
}

/** Verbs that default to the CALLING agent's space ({@link callerSpace}): `cron`, and every verb that can
 *  spawn an agent. An agent on team2027 that ran `paw open` got its new agent in `paw`, where its peers
 *  couldn't reach it (#78). A human shell has no COTAL_SPACE, so for it this is resolveSpace(). */
/** `status` and `log` too: they read the agents a spawning verb just made. An agent on team2027 ran
 *  `paw dm github:firegoat-ai/canary` (→ team2027), then `paw status` and `paw log canary` read `paw`,
 *  where neither canary nor canary-env is registered — both "missing" while live (#96). */
/** `relocate` too: an agent relocating ITSELF from team2027 got "no agent named … in space paw" (canary-env). */
export const CALLER_SPACE_VERBS: ReadonlySet<string> = new Set(["cron", "open", "attach", "chat", "start", "dm", "claude", "status", "log", "relocate"]);

/** The space `paw <verb>` acts on when no --space / `#space` names one. */
export function defaultSpaceFor(verb: string): string {
  return CALLER_SPACE_VERBS.has(verb) ? callerSpace() : resolveSpace();
}

/** Whether the space this invocation acts on was CHOSEN (`--space`, `<agent>#<space>`, `PAW_SPACE`) or only
 *  defaulted (the caller agent's COTAL_SPACE / the machine default). bin/paw.ts records it before dispatch;
 *  anything that never ran through it (tests, other entry points) reads "chosen" — the safe answer, since
 *  only a defaulted space may be swapped for the one space that actually holds the agent. */
let spaceChosen = true;
export function noteSpaceChosen(chosen: boolean): void {
  spaceChosen = chosen;
}
export function spaceWasChosen(): boolean {
  return spaceChosen;
}
