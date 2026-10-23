/**
 * `paw mesh` — which spaces live on a REMOTE broker (src/remote-mesh.ts).
 *
 *   paw mesh [ls] [--json]                                   list remote records
 *   paw mesh add <space> --server tls://host:port --root <dir> [--as <name>] [--force]
 *   paw mesh set <space> --as <name>                          your mesh name on that space
 *   paw mesh rm <space>
 *
 * `--as` is the operator's mesh name on the space (src/names.ts `humanPeer`) — default `you`. On a
 * SHARED broker every operator's mailbox would otherwise register as `you`; pick a distinct one.
 *
 * `--root` is a directory whose `.cotal/auth/auth.json` is the space's account signer — the file
 * `cotal auth signer --out` (before cotal 0.100: `cotal mint --signer`) writes on the box that runs the broker. It is a bearer secret: paw checks it
 * loads for this space and is private to you (0600), and never prints it. Local only: no broker is
 * dialled here — the first command that needs the space (ensure()) proves the link.
 */
import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import { registry, type Command } from "@cotal-ai/core";
import { authDir, loadSpaceAuth } from "@cotal-ai/workspace";
import { HUMAN_PEER } from "../names.ts";
import { DEFAULT_SPACE } from "../space.ts";
import { checkHumanName, checkRemoteServer, checkSpaceName, listRemoteMeshes, readRemoteMesh, removeRemoteMesh, writeRemoteMesh } from "../remote-mesh.ts";
import { writeJson } from "../stdout.ts";

const USAGE = "mesh [ls [--json]] | mesh add <space> --server tls://host:port --root <dir> [--as <name>] [--force] | mesh set <space> --as <name> | mesh rm <space>";

export interface MeshArgs {
  verb: "ls" | "add" | "set" | "rm";
  space?: string;
  server?: string;
  root?: string;
  /** `--as`: the operator's mesh name on this space (validated by checkHumanName). */
  human?: string;
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
    else if (a === "--as") out.human = checkHumanName(value());
    else if (a === "--space") flagSpace = value();
    else if (a === "--force") out.force = true;
    else if (a === "--json") out.json = true;
    else if (a.startsWith("-")) throw new Error(`paw: unknown flag "${a}" — ${USAGE}`);
    else pos.push(a);
  }
  const verb = pos.shift() ?? "ls";
  if (verb !== "ls" && verb !== "add" && verb !== "set" && verb !== "rm") throw new Error(`paw: unknown \`mesh ${verb}\` — ${USAGE}`);
  out.verb = verb;
  if (pos.length > 1) throw new Error(`paw: unexpected "${pos[1]}" — ${USAGE}`);
  out.space = pos[0] ?? (verb === "ls" ? undefined : flagSpace);
  if (verb !== "add" && (out.server || out.root || out.force)) throw new Error(`paw: --server/--root/--force belong to \`paw mesh add\` — ${USAGE}`);
  if (out.human !== undefined && verb !== "add" && verb !== "set") throw new Error(`paw: --as belongs to \`paw mesh add\` / \`paw mesh set\` — ${USAGE}`);
  if (verb === "set" && out.human === undefined) throw new Error(`paw: \`paw mesh set\` needs --as <name> — ${USAGE}`);
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
      `paw: no signer for space "${space}" under ${dir} — on the broker's box run \`cotal auth signer --out signer.json\` (\`cotal mint --signer --out signer.json\` before cotal 0.100), ` +
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
    for (const r of all) console.log(`${r.space.padEnd(20)} ${r.server.padEnd(36)} as ${(r.human ?? HUMAN_PEER).padEnd(16)} ${r.root}`);
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
  if (args.verb === "set") {
    const existing = readRemoteMesh(space);
    if (!existing) throw new Error(`paw: space "${space}" has no remote record — \`paw mesh add ${space} --server … --root … --as ${args.human}\` first (local spaces are always "${HUMAN_PEER}")`);
    const { human: _old, ...rest } = existing;
    writeRemoteMesh({ ...rest, ...(args.human !== HUMAN_PEER ? { human: args.human } : {}), ts: new Date().toISOString() });
    console.log(`✓ you are "${args.human}" on "${space}" (was "${existing.human ?? HUMAN_PEER}")`);
    console.log(`  running daemons keep the old name until restarted — \`paw restart --space ${space}\` (mailbox + manager, revives live agents with the new brief)`);
    console.log(`  your identity (nkey, unread inbox) is unchanged: a DM inbox is keyed by id, not name`);
    return;
  }
  if (space === DEFAULT_SPACE) throw new Error(`paw: "${DEFAULT_SPACE}" is the local default space — a remote mesh needs its own space name`);
  if (!args.server) throw new Error(`paw: --server tls://host:port is required — ${USAGE}`);
  if (!args.root) throw new Error(`paw: --root <dir> is required (the dir whose .cotal/auth/auth.json is the signer) — ${USAGE}`);
  const server = checkRemoteServer(args.server);
  const root = checkSignerRoot(space, args.root);
  const existing = readRemoteMesh(space);
  if (existing && !args.force)
    throw new Error(`paw: "${space}" is already remote (${existing.server}, root ${existing.root}) — pass --force to replace it`);
  // --force keeps a name set earlier unless --as replaces it; "you" is the default, so it is not stored.
  const human = args.human ?? existing?.human;
  const path = writeRemoteMesh({ space, server, root, ...(human !== undefined && human !== HUMAN_PEER ? { human } : {}), ts: new Date().toISOString() });
  console.log(`✓ space "${space}" → ${server} (signer under ${root}), you are "${human ?? HUMAN_PEER}" there`);
  console.log(`  record: ${path}`);
  console.log(`  next: paw dm --space ${space} <folder> "hi"   (paw runs a manager + mailbox here; it never starts that broker)`);
}

const meshCommand: Command = {
  kind: "command",
  name: "mesh",
  group: "Mesh",
  summary: "which spaces live on a remote broker (add/set/rm/ls) and your name there; local spaces need no record",
  usage: USAGE,
  run: (a) => mesh([...a.raw]),
};

registry.register(meshCommand);
