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
