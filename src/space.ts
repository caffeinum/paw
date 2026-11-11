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

/** HOW the space this invocation acts on was picked — every verb's namespace starts here:
 *  `flag` (`--space`), `address` (`<agent>#<space>`), `env` (`PAW_SPACE`, often from a shell rc the operator
 *  forgot — the 2026-11-11 tracepaper incident: `PAW_SPACE=team2027` in ~/.zshrc routed `paw adopt .` into
 *  team2027 silently), `caller` (the calling agent's COTAL_SPACE) or `default` (`paw`). */
export type SpaceHow = "flag" | "address" | "env" | "caller" | "default";
export type SpaceChoice = { space: string; how: SpaceHow };

/** Pure: how `space` was picked, from what bin/paw.ts saw. */
export function spaceChoiceOf(o: { space: string; flag: boolean; address: boolean; verb: string; env: NodeJS.ProcessEnv }): SpaceChoice {
  if (o.flag) return { space: o.space, how: "flag" };
  if (o.address) return { space: o.space, how: "address" };
  if (o.env.PAW_SPACE !== undefined) return { space: o.space, how: "env" };
  if (CALLER_SPACE_VERBS.has(o.verb) && o.env.COTAL_SPACE?.trim()) return { space: o.space, how: "caller" };
  return { space: o.space, how: "default" };
}

/** Where a space came from, as a short phrase for a line (`from PAW_SPACE`), or "" when it is plain. */
export function spaceProvenance(how: SpaceHow): string {
  return how === "env" ? "from PAW_SPACE" : how === "caller" ? "the calling agent's space" : how === "default" ? "the default space" : "";
}

/** The choice bin/paw.ts recorded before dispatch. Anything that never ran through it (tests, other entry
 *  points) reads a `flag` choice of the resolved space — "chosen", the safe answer, since only a defaulted
 *  space may be swapped for the one space that actually holds the agent. */
let choice: SpaceChoice | undefined;
export function noteSpaceChoice(c: SpaceChoice): void {
  choice = c;
}
export function spaceChoice(space: string): SpaceChoice {
  return choice && choice.space === space ? choice : { space, how: "flag" };
}
/** Whether the space was CHOSEN (`--space`, `#space`, `PAW_SPACE`) rather than only defaulted. */
export function spaceWasChosen(): boolean {
  return !choice || !(choice.how === "default" || choice.how === "caller");
}
