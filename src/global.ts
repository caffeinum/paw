/**
 * `paw global` — bring up the always-on "GLOBAL" agent: a persistent, usually-idle mesh peer that can
 * reach the whole machine. Whenever a bridge (Telegram, etc.) is on the mesh you always have someone to
 * DM even if no folder-agents are up — from Telegram it shows in /switch and the /help footer. Warm +
 * resume-pinned like any paw agent, so it survives a manager bounce (revived by `paw restart`); idempotent
 * — reuses a live one rather than spawning a duplicate.
 *
 * Name: `global` (NOT `telegram` — the Telegram bridge itself joins the mesh as "telegram", so that name
 * would collide). Rooted at a DEDICATED `~/.paw/global` workspace rather than $HOME: it still reaches the
 * whole box (paw's usual bypassPermissions, no cwd confinement → Read/Bash anywhere via absolute paths),
 * but a neutral cwd avoids colliding with (and orphaning) an agent the operator may already have at $HOME.
 * Full machine access is the intended capability, kept behind the same allowlist the bridge enforces.
 */
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { registry, type Command } from "@cotal-ai/core";
import { canonicalDir, ensureAgentSpawned, lookupFolderName, setFolderName } from "./addressing.js";
import { withManagerControl } from "./control.js";
import { unstickSweep } from "./keeper.js";
import { ensure, resolveSpace } from "./lifecycle.js";

/** The always-on agent's fixed mesh name. Exported so other surfaces can reference it without a literal. */
export const GLOBAL_NAME = "global";

const GLOBAL_BRIEF =
  "You are the always-on GLOBAL agent for this machine. Your cwd is a neutral ~/.paw/global workspace, but " +
  "you have FULL machine access (no sandbox) — Read/run/edit anywhere via absolute paths. You're DM'd (often " +
  "from Telegram) to do things on the host: answer questions, run commands, kick off or hand off work to " +
  "folder-specific agents. Usually idle; when messaged, act and report back concisely. You are a peer on the " +
  "cotal mesh — reach teammates with the cotal_* tools.";

/** The global agent's dedicated workspace: `$PAW_HOME/global` (default `~/.paw/global`), created on demand.
 *  A neutral cwd so it never collides with a folder-agent the operator already has (e.g. one at $HOME). */
function globalFolder(): string {
  const root = process.env.PAW_HOME?.trim() || join(homedir(), ".paw");
  const dir = join(root, "global");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Parse the only flag we accept: `--space <s>` (bin/paw.ts appends the default). */
function parseSpace(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--space") return argv[i + 1];
    if (argv[i].startsWith("--space=")) return argv[i].slice("--space=".length);
  }
  return undefined;
}

async function globalUp(argv: string[]): Promise<void> {
  const space = parseSpace(argv) ?? resolveSpace();
  const folder = canonicalDir(globalFolder()); // dedicated ~/.paw/global workspace (full machine access, neutral cwd)
  // Fail loud rather than CLOBBER: the dedicated folder should only ever map to `global`. If it somehow
  // already holds a different name, force-renaming would orphan that agent — refuse and guide instead.
  const existing = lookupFolderName(space, folder);
  if (existing && existing !== GLOBAL_NAME) {
    throw new Error(
      `paw: ${folder} is already registered as agent "${existing}" (not "${GLOBAL_NAME}") — refusing to clobber it.\n` +
        `  \`paw rename ${folder} ${GLOBAL_NAME}\` to make it the global agent, or \`paw rm ${folder}\` to reset.`,
    );
  }
  const name = setFolderName(space, folder, GLOBAL_NAME).name; // pin the folder→name mapping to `global`
  const { server } = await ensure({ needMesh: true, needManager: true, space });
  const { spawned, restarted } = await withManagerControl(space, server, async (ctl) => {
    const r = await ensureAgentSpawned(ctl, { space, name, cwd: folder, brief: GLOBAL_BRIEF });
    // The keeper tick (launchd, every 60s) is the one periodic heartbeat paw has, so the fleet's
    // unstick sweep rides it: an agent sitting idle with DMs it never drains is restarted (src/keeper.ts).
    const restarted = await unstickSweep(space, ctl).catch((e: Error) => { console.error(`paw keeper: sweep failed: ${e.message}`); return [] as string[]; });
    return { ...r, restarted };
  });
  if (restarted.length) console.log(`  keeper: restarted ${restarted.join(", ")} (stuck with undrained DMs)`);
  console.log(spawned ? `✓ global agent up @${name} — full machine access, cwd ${folder}` : `✓ global agent already live @${name}`);
  console.log(`  DM it: \`paw dm ${name} "…"\`  ·  from a bridge it's in /switch and the /help footer`);
  console.log(`  stays warm (resume-pinned), revived by \`paw restart\`; \`paw stop ${name}\` ends it`);
  if (name !== GLOBAL_NAME) {
    console.log(`  ⚠ note: the name "${GLOBAL_NAME}" was already taken by another folder, so it's "${name}"`);
  }
}

const globalCommand: Command = {
  kind: "command",
  name: "global",
  group: "Lifecycle",
  summary: "bring up the always-on global agent (full machine access) — a persistent peer you can DM",
  usage: "global [--space <s>]",
  run: (a) => globalUp([...a.raw]),
};

registry.register(globalCommand);
