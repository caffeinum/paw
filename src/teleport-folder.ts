/**
 * `paw teleport --folder` (docs/notes/teleport.md#folder) — an agent whose folder is NOT a git checkout
 * moves its folder's files: the whole tree, as one tar stream over the transport, modes kept (a 0600
 * `state/secret_*` stays 0600; directories keep theirs; symlinks stay links). It lands in the folder paw
 * owns there, `<PAW_HOME>/agents/<name>` (never the source's absolute path: HOME differs between boxes,
 * and that folder is paw-managed under any PAW_ROOT). A destination that exists and isn't empty refuses,
 * unless it is this agent's own earlier copy. The plan lists secret-looking files by NAME only.
 */
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";
import type { Side } from "./teleport-shell.ts";

export type FolderEntry = { rel: string; bytes: number; mtimeMs: number; mode: number; link?: true };

export type FolderManifest = {
  root: string;
  files: FolderEntry[];
  bytes: number;
  /** Secret-looking files (cwd-relative names; contents never read). */
  secrets: string[];
};

/** A file whose name or mode says "secret": `secret*`, `*.key`, `.env*`, or no group/other access (0600). */
export function secretLooking(name: string, mode: number): boolean {
  const base = name.split("/").pop()!;
  return /^secret/i.test(base) || /\.key$/i.test(base) || /^\.env/.test(base) || (mode & 0o077) === 0;
}

/** Every entry under `root` (lstat: a symlink is one entry, never followed). */
export function folderManifest(root: string, home: string): FolderManifest {
  if (root === home || root === "/") throw new Error(`paw: "${root}" is the agent's folder — teleport won't move a whole HOME (or /) as a folder; give the agent a folder of its own`);
  const files: FolderEntry[] = [];
  const walk = (rel: string) => {
    const abs = rel ? join(root, rel) : root;
    for (const n of readdirSync(abs).sort()) {
      const r = rel ? `${rel}/${n}` : n;
      const st = lstatSync(join(root, r));
      if (st.isSymbolicLink()) files.push({ rel: r, bytes: 0, mtimeMs: Math.floor(st.mtimeMs), mode: st.mode & 0o7777, link: true });
      else if (st.isDirectory()) walk(r);
      else if (st.isFile()) files.push({ rel: r, bytes: st.size, mtimeMs: Math.floor(st.mtimeMs), mode: st.mode & 0o7777 });
    }
  };
  walk("");
  return {
    root,
    files,
    bytes: files.reduce((n, f) => n + f.bytes, 0),
    secrets: files.filter((f) => !f.link && secretLooking(f.rel, f.mode)).map((f) => f.rel),
  };
}

/** The entries of `after` new or changed since `before` — what the final pass after the stop re-sends. */
export function folderChanged(before: FolderEntry[], after: FolderEntry[]): FolderEntry[] {
  const was = new Map(before.map((f) => [f.rel, f]));
  return after.filter((f) => {
    const b = was.get(f.rel);
    return !b || b.bytes !== f.bytes || b.mtimeMs !== f.mtimeMs || b.mode !== f.mode;
  });
}

function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Source: a tar of the cwd-relative paths on stdin (`.` = the whole tree, directory modes included). */
export function folderPackScript(root: string): string {
  return `R=${shq(root)}
cd "$R" || exit 1
COPYFILE_DISABLE=1; export COPYFILE_DISABLE
if tar --version 2>/dev/null | grep -q bsdtar; then exec tar --no-mac-metadata --no-xattrs -c -f - -T -; else exec tar -c -f - -T -; fi`;
}

/** Destination: unpack under `dir` (created), keeping every mode the archive carries. */
export function folderUnpackScript(dir: string): string {
  return `D=${shq(dir)}
mkdir -p "$D" && cd "$D" && exec tar -x -p -f - --no-same-owner`;
}

/** Stream `rels` (default: the whole tree) of `from`'s `srcRoot` into `to`'s `dstRoot`. */
export async function copyFolder(
  from: Side,
  to: Side,
  srcRoot: string,
  dstRoot: string,
  rels: string[] | undefined,
  collect: (child: ReturnType<Side["spawn"]>, input?: Buffer | string | Readable) => Promise<{ code: number; stderr: string }>,
): Promise<void> {
  if (rels && !rels.length) return;
  const src = from.spawn(folderPackScript(srcRoot));
  const dst = to.spawn(folderUnpackScript(dstRoot));
  const [s, d] = await Promise.all([collect(src, (rels ?? ["."]).join("\n") + "\n"), collect(dst, src.stdout!)]);
  if (s.code !== 0) throw new Error(`paw: packing ${srcRoot} on ${from.label} failed: ${s.stderr.trim() || `exit ${s.code}`}`);
  if (d.code !== 0) throw new Error(`paw: unpacking into ${dstRoot} on ${to.label} failed: ${d.stderr.trim() || `exit ${d.code}`}`);
}

/** The plan's folder-files lines. */
export function folderPlanLines(f: FolderManifest, size: string): string[] {
  const shown = (xs: string[]) => (xs.length > 12 ? `${xs.slice(0, 12).join(", ")}, … +${xs.length - 12} more` : xs.join(", "));
  const lines = [`  files      ${f.files.length} file(s), ${size} — the whole folder, modes kept (0600 stays 0600)`];
  if (f.secrets.length) lines.push(`             ${f.secrets.length} secret-looking (names only, contents never shown): ${shown(f.secrets)}`);
  return lines;
}
