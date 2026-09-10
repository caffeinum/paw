/**
 * Per-agent cwd safety: PAW_ROOT confinement + Claude folder pre-trust, applied at the SPAWN SITE
 * (src/addressing.ts) just before paw asks the manager to start an agent there.
 *
 * This used to live in the connector, which received the cwd on LaunchOpts. As of cotal's per-agent
 * cwd landing upstream (PR #43, b786fcf), the manager owns the working directory and passes it
 * straight to the runtime (`runtime.spawn(name, spec, cwd)`) — the connector never sees it. So the
 * confine+trust step moves here, to the one place paw still resolves the folder itself.
 */
import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, sep } from "node:path";
import { withFileLock } from "./lock.js";

/**
 * Optional confinement root that paw agent cwds must stay within (after symlink resolution).
 * Confinement is OPT-IN: unset PAW_ROOT => undefined => no confinement. When set it must be a
 * non-empty absolute path (fail loud otherwise); canonicalised for like-for-like compare.
 */
function pawRoot(): string | undefined {
  const raw = process.env.PAW_ROOT;
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new Error(`paw: PAW_ROOT is set but empty — unset it to disable cwd confinement, or set an absolute path`);
  }
  if (!isAbsolute(trimmed)) {
    throw new Error(`paw: PAW_ROOT must be an absolute path, got "${trimmed}"`);
  }
  return realpathSync(trimmed);
}

/** True when `child` is the root itself or nested under it. Trailing-separator compare so `/repo`
 *  does not match a sibling `/repo-evil`. */
function isInside(root: string, child: string): boolean {
  if (child === root) return true;
  const base = root.endsWith(sep) ? root : root + sep;
  return child.startsWith(base);
}

/** The paw-MANAGED cwd islands: `~/.paw/repos` (clones + PR/branch worktrees) and `~/.paw/web`
 *  (website scratch) — the ONLY dirs paw itself creates and roots agents in, so they're always-allowed
 *  even under a PAW_ROOT pointed at a code tree (else `github:`/url agents break, the latent 2026-07
 *  bug). Deliberately NOT all of ~/.paw: state like spaces/ (personas, folders.json, locks) is never an
 *  agent cwd, so widening the island to the whole home would needlessly weaken confinement. Tolerant:
 *  a not-yet-created subdir contributes nothing to allow. */
function pawManagedRoots(): string[] {
  const home = process.env.PAW_HOME?.trim() || join(homedir(), ".paw");
  const roots: string[] = [];
  for (const sub of ["repos", "web"]) {
    try {
      roots.push(realpathSync(join(home, sub)));
    } catch {
      // subdir doesn't exist yet — nothing under it to allow
    }
  }
  return roots;
}

/**
 * Confine an agent's cwd to PAW_ROOT. paw defaults to bypassPermissions and pre-trusts the cwd, and
 * an auto-daemon lets any peer drive cotal_spawn — so an out-of-root cwd is a real escalation path.
 * Returns the canonical cwd and whether it is in-root. An out-of-root cwd throws unless it's under
 * paw's own state root (repos/worktrees/web scratch — paw-managed) or PAW_ALLOW_ANY_CWD=1 opts in.
 * Fail-loud: never silently downgrade an escape.
 */
export function confineCwd(abs: string): { canonical: string; inRoot: boolean } {
  const root = pawRoot();
  if (root === undefined) return { canonical: abs, inRoot: true }; // confinement opt-in: unset => allow
  const inRoot = isInside(root, abs);
  if (inRoot) return { canonical: abs, inRoot };
  // paw's own scratch (~/.paw/repos, ~/.paw/web) is paw-managed — allow + pre-trust it. Returning inRoot
  // is correct: paw owns these dirs, so it's not an escalation.
  if (pawManagedRoots().some((r) => isInside(r, abs))) return { canonical: abs, inRoot: true };
  if (process.env.PAW_ALLOW_ANY_CWD === "1") return { canonical: abs, inRoot };
  throw new Error(
    `paw: refusing to launch an agent at "${abs}" — it escapes PAW_ROOT ("${root}"). ` +
      `paw pre-trusts and bypasses permissions for the cwd, so an out-of-root folder is an escalation. ` +
      `Set PAW_ROOT to a parent of this folder, or set PAW_ALLOW_ANY_CWD=1 to override.`,
  );
}

/**
 * Pre-accept Claude Code's per-folder workspace-trust dialog by writing the trust flags into
 * ~/.claude.json before launch. Without this an unattended session blocks on the trust prompt the
 * first time it opens an untrusted folder. Creates the file if Claude has never run; idempotent;
 * preserves all other config; serialized against concurrent paw spawns via an adjacent lock and
 * written atomically (temp file + rename).
 *
 * Residual limitation: Claude itself rewrites ~/.claude.json on activity without taking this lock,
 * so a paw write racing a live Claude write can still lose; the idempotent check self-heals on the
 * next spawn. Trust is per-folder, so a lost write only re-shows that one folder's dialog.
 */
function pretrustFolder(abs: string): void {
  const file = join(homedir(), ".claude.json");
  withFileLock(`${file}.paw-lock`, () => {
    const config = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
    if (typeof config !== "object" || config === null) {
      throw new Error(`paw: ~/.claude.json is not a JSON object; refusing to pre-trust ${abs}`);
    }
    if (!config.projects) config.projects = {};
    const project = config.projects[abs] ?? {};
    if (project.hasTrustDialogAccepted === true && project.hasCompletedProjectOnboarding === true) {
      return;
    }
    project.hasTrustDialogAccepted = true;
    project.hasCompletedProjectOnboarding = true;
    config.projects[abs] = project;
    const tmp = `${file}.paw-${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(config, null, 2));
    renameSync(tmp, file);
  });
}

/**
 * Confine + pre-trust a folder before paw asks the manager to spawn an agent there, returning the
 * CANONICAL cwd to hand the manager (so the dir claude runs in matches the trust key). An in-root cwd
 * is pre-trusted; an explicitly-allowed out-of-root cwd (PAW_ALLOW_ANY_CWD=1) is NOT pre-trusted — the
 * override grants access, not silent trust, so claude's trust dialog still gates it.
 */
export function confineAndTrustCwd(cwd: string): string {
  if (!isAbsolute(cwd)) {
    throw new Error(`paw: agent cwd must be absolute, got "${cwd}"`);
  }
  // realpathSync canonicalises symlinks (so the trust key matches the cwd claude reports) and throws
  // ENOENT for a missing folder — fail loud rather than trust a phantom directory.
  const { canonical, inRoot } = confineCwd(realpathSync(cwd));
  if (inRoot) pretrustFolder(canonical);
  return canonical;
}
