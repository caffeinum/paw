/**
 * The cotal root paw pins for a space — the ONE answer to "which `.cotal/` is this space's?".
 *
 * cotal resolves a checkout's root by walking UP from the cwd for a `.cotal/` dir (`findCotalRoot`),
 * which makes the operator's SHELL DIRECTORY part of the daemon's identity. That's right for cotal
 * (one mesh per checkout) and wrong for paw: paw is machine-wide — ONE space, ONE mesh, agents rooted
 * in dozens of unrelated folders — so the same `paw` command must resolve the same root from anywhere.
 *
 * Live consequence (2026-07-29): `~/Github/team2027` has its own `.cotal/auth/auth.json`, a legacy
 * monolith labelled space "main". Running paw from there resolved root to that repo, and since paw
 * spawns its daemons WITHOUT a cwd they inherited it — so the manager read that repo's auth through
 * cotal's SecretStore seam, which (unlike the FS reader, which correctly answers undefined for a
 * wrong-space bundle) fails LOUD: "the space trust bundle (auth/auth.json) failed trust-chain
 * validation for space \"paw\"", repeatedly, so the manager never stayed up. The same root split also
 * made it record team2027 as its root and fight the running manager for the space's singleton lease
 * ("a manager already serves space \"paw\" … root /Users/aleks"), and `paw down` from there would
 * have read `<team2027>/.cotal/nats.pid` — killing THAT repo's nats server instead of paw's.
 *
 * So: the root is a property of the SPACE, not of the shell. The machine mesh registry already
 * records it (`recordMesh` persists `root` when the mesh comes up), so read it back.
 *
 * Precedence: `PAW_COTAL_ROOT` (explicit escape hatch, must be absolute) > the space's registry entry
 * > `homedir()`. The homedir fallback is not a guess — it's where `~/.cotal` lives and exactly what
 * the registry holds for every paw space, so a first run (no entry yet) and steady state agree.
 */
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { findMesh } from "@cotal-ai/workspace";

export function pawCotalRoot(space: string): string {
  const override = process.env.PAW_COTAL_ROOT?.trim();
  if (override) {
    if (!isAbsolute(override)) throw new Error(`paw: PAW_COTAL_ROOT="${override}" must be an absolute path`);
    return override;
  }
  return findMesh(space)?.root ?? homedir();
}
