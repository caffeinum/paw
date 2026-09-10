/**
 * `paw release` — the CUTOVER verb of paw's release discipline (src/release.ts holds the WHY).
 *
 *   paw release                 snapshot this checkout, flip `current` to it
 *   paw release --no-activate   snapshot only (stage the new version beside the old one)
 *   paw release --force         re-copy even when the id already exists (a re-run after an install)
 *   paw release --list          what's on disk, and which one the daemons run from
 *   paw release --prune [N]     drop all but the newest N (default 3); never the current one
 *
 * Deliberately does NOT restart anything. Standing a version up and cutting over are two acts, and
 * the second one already has a verb — `paw restart` bounces the manager and revives the fleet, and it
 * resolves the release fresh at spawn time, so it comes up from whatever `current` now points at.
 * Folding the bounce in here would make "take a snapshot" drop every agent, which is the surprise
 * this whole discipline exists to remove.
 *
 * LOCAL: no mesh, no manager (hence out of bin/paw.ts's NEEDS_* gating) — it copies files and moves a
 * symlink.
 */
import { registry, type Command } from "@cotal-ai/core";
import {
  REPO_ROOT,
  activateRelease,
  cleanStaging,
  createRelease,
  currentRelease,
  listReleases,
  pruneReleases,
  releaseId,
  releasesDir,
} from "../release.js";

const tty = process.stdout.isTTY === true;
const wrap = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const c = { dim: wrap("2"), bold: wrap("1"), green: wrap("32") };

interface Args {
  list: boolean;
  prune?: number;
  activate: boolean;
  force: boolean;
}

/** Parse the flags. `--prune` takes an OPTIONAL count, so a following non-numeric token is left
 *  alone rather than swallowed (and a garbage count fails loud instead of silently meaning 3). */
export function parseReleaseArgs(argv: string[]): Args {
  const out: Args = { list: false, activate: true, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--list") out.list = true;
    else if (a === "--no-activate") out.activate = false;
    else if (a === "--force") out.force = true;
    else if (a === "--prune") {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        const n = Number(next);
        if (!Number.isInteger(n) || n < 1) throw new Error(`paw: --prune takes a positive integer (got "${next}")`);
        out.prune = n;
        i++;
      } else out.prune = 3;
    } else if (a === "--space") i++; // injected by bin/paw.ts; a release is machine-wide, not per-space
    else throw new Error(`paw: unknown argument "${a}" — release [--list] [--prune N] [--no-activate] [--force]`);
  }
  return out;
}

function show(): void {
  const cur = currentRelease();
  const all = listReleases();
  console.log(c.dim(`releases in ${releasesDir()}`));
  if (all.length === 0) {
    console.log("  (none) — run `paw release` to snapshot this checkout");
  } else {
    for (const r of all) {
      const mark = r.id === cur?.id ? c.green(" ← current (daemons run from here)") : "";
      console.log(`  ${c.bold(r.id)}  ${new Date(r.createdAt).toLocaleString()}${mark}`);
    }
  }
  const pending = releaseId(REPO_ROOT);
  console.log(
    pending === cur?.id
      ? c.dim(`checkout ${REPO_ROOT} matches the current release`)
      : c.dim(`checkout ${REPO_ROOT} would snapshot as ${pending} — \`paw release\` to stand it up`),
  );
}

const release: Command = {
  kind: "command",
  name: "release",
  summary: "snapshot this checkout into an immutable release the daemons run from",
  usage: "paw release [--list] [--prune N] [--no-activate] [--force]",
  async run({ raw }) {
    const args = parseReleaseArgs([...raw]);
    cleanStaging(); // a crashed snapshot leaves a .staging-* dir; it is never a release, so drop it

    if (args.prune !== undefined) {
      const dropped = pruneReleases(args.prune);
      console.log(dropped.length ? `pruned ${dropped.length}: ${dropped.join(", ")}` : "nothing to prune");
      return;
    }
    if (args.list) return show();

    const before = currentRelease()?.id;
    const rel = createRelease({ force: args.force });
    console.log(`${c.green("✓")} release ${c.bold(rel.id)}  ${c.dim(rel.path)}`);
    if (!args.activate) {
      console.log(c.dim(`current is still ${before ?? "(unset)"} — \`paw release\` again (without --no-activate) to cut over`));
      return;
    }
    activateRelease(rel.id);
    if (before === rel.id) console.log(c.dim("already current — the daemons are running this code"));
    else console.log(`current: ${c.dim(before ?? "(unset)")} → ${c.bold(rel.id)}   ${c.dim("`paw restart` to bring the daemons onto it")}`);
  },
};

registry.register(release);
