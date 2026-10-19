/**
 * `paw mesh` — which spaces live on a REMOTE broker (src/remote-mesh.ts).
 *
 *   paw mesh [ls] [--json]                                   list remote records
 *   paw mesh add <space> --server tls://host:port --root <dir> [--force]
 *   paw mesh rm <space>
 *
 * `--root` is a directory whose `.cotal/auth/auth.json` is the space's account signer — the file
 * `cotal mint --signer` writes on the box that runs the broker. It is a bearer secret: paw checks it
 * loads for this space and is private to you (0600), and never prints it. Local only: no broker is
 * dialled here — the first command that needs the space (ensure()) proves the link.
 */
import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import { registry, type Command } from "@cotal-ai/core";
import { authDir, loadSpaceAuth } from "@cotal-ai/workspace";
import { DEFAULT_SPACE } from "../space.ts";
import { checkRemoteServer, checkSpaceName, listRemoteMeshes, readRemoteMesh, removeRemoteMesh, writeRemoteMesh } from "../remote-mesh.ts";
import { writeJson } from "../stdout.ts";

const USAGE = "mesh [ls [--json]] | mesh add <space> --server tls://host:port --root <dir> [--force] | mesh rm <space>";

export interface MeshArgs {
  verb: "ls" | "add" | "rm";
  space?: string;
  server?: string;
  root?: string;
  force: boolean;
  json: boolean;
}

/** bin/paw.ts appends the current `--space`; a positional space wins over it. */
export function parseMeshArgs(argv: string[]): MeshArgs {
  const out: MeshArgs = { verb: "ls", force: false, json: false };
  const pos: string[] = [];
  let flagSpace: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("-")) throw new Error(`paw: ${a} needs a value — ${USAGE}`);
      return v;
    };
    if (a === "--server") out.server = value();
    else if (a === "--root") out.root = value();
    else if (a === "--space") flagSpace = value();
    else if (a === "--force") out.force = true;
    else if (a === "--json") out.json = true;
    else if (a.startsWith("-")) throw new Error(`paw: unknown flag "${a}" — ${USAGE}`);
    else pos.push(a);
  }
  const verb = pos.shift() ?? "ls";
  if (verb !== "ls" && verb !== "add" && verb !== "rm") throw new Error(`paw: unknown \`mesh ${verb}\` — ${USAGE}`);
  out.verb = verb;
  if (pos.length > 1) throw new Error(`paw: unexpected "${pos[1]}" — ${USAGE}`);
  out.space = pos[0] ?? (verb === "ls" ? undefined : flagSpace);
  if (verb !== "add" && (out.server || out.root || out.force)) throw new Error(`paw: --server/--root/--force belong to \`paw mesh add\` — ${USAGE}`);
  return out;
}

/** The signer under `root` must load for `space` and be readable by you alone. Never echoes it. */
export function checkSignerRoot(space: string, rootArg: string): string {
  const root = resolve(rootArg);
  let st;
  try {
    st = statSync(root);
  } catch {
    throw new Error(`paw: --root ${root} does not exist`);
  }
  if (!st.isDirectory()) throw new Error(`paw: --root ${root} is not a directory`);
  const dir = authDir(root);
  const auth = loadSpaceAuth(dir, space);
  if (!auth)
    throw new Error(
      `paw: no signer for space "${space}" under ${dir} — on the broker's box run \`cotal mint --signer --out signer.json\`, ` +
        `copy it to ${join(dir, "auth.json")} (chmod 600)`,
    );
  if (!auth.account?.signingSeed) throw new Error(`paw: the auth under ${dir} for "${space}" carries no account signing seed — it cannot mint agent creds`);
  for (const f of [join(dir, "auth.json")]) {
    let mode: number;
    try {
      mode = statSync(f).mode;
    } catch {
      continue; // split-layout roots carry account.<hex>.json instead; loadSpaceAuth already proved them
    }
    if (mode & 0o077) throw new Error(`paw: ${f} is readable by other users (mode ${(mode & 0o777).toString(8)}) — it is a bearer secret: chmod 600 ${f}`);
  }
  return root;
}

async function mesh(argv: string[]): Promise<void> {
  const args = parseMeshArgs(argv);
  if (args.verb === "ls") {
    const all = listRemoteMeshes();
    if (args.json) return writeJson(all);
    if (!all.length) return console.log("no remote meshes — every space is on the local broker. add one: paw mesh add <space> --server tls://host:port --root <dir>");
    for (const r of all) console.log(`${r.space.padEnd(20)} ${r.server.padEnd(36)} ${r.root}`);
    return;
  }
  const space = args.space;
  if (!space) throw new Error(`paw: which space? — ${USAGE}`);
  checkSpaceName(space);
  if (args.verb === "rm") {
    const { managerProcs, mailboxProcs } = await import("../lifecycle.ts");
    if (managerProcs(space).length || mailboxProcs(space).length)
      throw new Error(`paw: space "${space}" still has paw daemons running — \`paw down --space ${space}\` first`);
    if (!removeRemoteMesh(space)) throw new Error(`paw: space "${space}" has no remote record`);
    return console.log(`✓ "${space}" is no longer a remote mesh (the signer under its root was left alone)`);
  }
  if (space === DEFAULT_SPACE) throw new Error(`paw: "${DEFAULT_SPACE}" is the local default space — a remote mesh needs its own space name`);
  if (!args.server) throw new Error(`paw: --server tls://host:port is required — ${USAGE}`);
  if (!args.root) throw new Error(`paw: --root <dir> is required (the dir whose .cotal/auth/auth.json is the signer) — ${USAGE}`);
  const server = checkRemoteServer(args.server);
  const root = checkSignerRoot(space, args.root);
  const existing = readRemoteMesh(space);
  if (existing && !args.force)
    throw new Error(`paw: "${space}" is already remote (${existing.server}, root ${existing.root}) — pass --force to replace it`);
  const path = writeRemoteMesh({ space, server, root, ts: new Date().toISOString() });
  console.log(`✓ space "${space}" → ${server} (signer under ${root})`);
  console.log(`  record: ${path}`);
  console.log(`  next: paw dm --space ${space} <folder> "hi"   (paw runs a manager + mailbox here; it never starts that broker)`);
}

const meshCommand: Command = {
  kind: "command",
  name: "mesh",
  group: "Mesh",
  summary: "which spaces live on a remote broker (add/rm/ls); local spaces need no record",
  usage: USAGE,
  run: (a) => mesh([...a.raw]),
};

registry.register(meshCommand);
