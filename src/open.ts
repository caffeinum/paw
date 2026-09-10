/**
 * `paw open [folder|name|repo@branch]` — folder-addressed sugar over cotal's `attach`. Resolves the
 * folder's agent (spawning it if absent), or falls back to a live agent's NAME, then attaches to its
 * live pty via cotal's own `attach` command. Where `paw chat` is the durable DM conversation, `open`
 * drops you into the agent's real terminal.
 *
 * Built on cotal: the spawn goes through the manager's service endpoint. The PTY attach does NOT
 * work on cotal 0.25 and says so — see {@link attachResolved}.
 * Self-registers an "open" command on import; bin/paw.ts ensures the mesh + manager are up first.
 */
import { DEFAULT_SERVER, registry, type Command } from "@cotal-ai/core";
import { attachTmux, tmuxSession } from "./native-attach.js";
import { existsSync } from "node:fs";
import { assertUnambiguousTarget, canonicalDir, ensureAgentSpawned, folderForName, personaFilePath, registerInstance, resolveFolderAgent, setFolderName, type Kind } from "./addressing.js";
import { readAgentType } from "./session.js";
import { withManagerControl } from "./control.js";
import { readForeground } from "./foreground.js";
import { isAddressHandle, resolveAddress } from "./address.js";
import { readRuntimeMarker, resolveSpace } from "./lifecycle.js";

function parseArgs(argv: string[]): { space?: string; target?: string; model?: string; name?: string } {
  const out: { space?: string; target?: string; model?: string; name?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--space") out.space = argv[++i];
    else if (a === "--model") out.model = argv[++i];
    else if (a === "--name") out.name = argv[++i];
    else if (!a.startsWith("-") && out.target === undefined) out.target = a;
  }
  return out;
}

async function open(argv: string[]): Promise<void> {
  const { space: spaceArg, target, model, name: nameFlag } = parseArgs(argv);
  const space = spaceArg ?? resolveSpace();
  assertUnambiguousTarget(space, target); // a bare token that's BOTH a known name and a folder here → fail loud

  // A <repo>@<branch> ref or a real directory => folder mode (spawn the agent if absent). Otherwise the
  // arg is a live agent's NAME (e.g. one named after a session) — attach to it directly, no spawn.
  let folder: string | undefined;
  let name: string;
  let brief: string | undefined;
  let kind: Kind | undefined;
  if (target !== undefined && isAddressHandle(target)) {
    const addr = resolveAddress(target);
    folder = addr.cwd;
    // --name attaches an EXTRA instance at this folder (agents.json side-table); no --name keeps the
    // default path (addr.name sets the folder's default, else the folder-derived default name).
    name = nameFlag !== undefined
      ? registerInstance(space, folder, nameFlag)
      : addr.name ? setFolderName(space, folder, addr.name).name : resolveFolderAgent(space, folder);
    brief = addr.brief;
    kind = addr.kind;
  } else {
    // Resolve target → a real folder vs a bare agent NAME. ONLY canonicalDir may throw here; the name
    // computation (registerInstance can fail loud on a collision) happens AFTER the try/catch so its
    // error propagates instead of masquerading as "not a folder".
    let nameTarget: string | undefined;
    try {
      folder = canonicalDir(target ?? ".");
    } catch {
      if (target === undefined) throw new Error(`paw: "." is not a directory`);
      if (nameFlag !== undefined) {
        throw new Error(
          `paw: --name only names an EXTRA instance at a folder (paw open <folder> --name ${nameFlag}); "${target}" is an agent name, not a folder`,
        );
      }
      if (!/^[A-Za-z0-9_-]+$/.test(target)) {
        throw new Error(`paw: "${target}" is neither an existing folder nor a valid agent name`);
      }
      nameTarget = target;
      // A KNOWN agent by name → resume it from its registered folder (so `paw attach <offline-agent>`
      // wakes it instead of cotal's raw attach reporting "no agent"). Unknown name → folder stays
      // undefined → attach a live agent by name (or fail loud if none), never auto-created.
      const home = folderForName(space, target);
      if (home && existsSync(home)) folder = home;
    }
    name =
      nameTarget ?? (nameFlag !== undefined ? registerInstance(space, folder as string, nameFlag) : resolveFolderAgent(space, folder as string));
  }

  await attachResolved(space, name, { folder, model, brief, kind });
}

/**
 * The attach core shared by `paw open`/`paw attach` and `paw adopt`'s auto-attach: given a resolved
 * `space` + agent `name` (and an optional folder to spawn from), does the foreground check, reads the
 * runtime marker, spawns-if-needed over one control round-trip, then attaches per runtime (native tmux,
 * a cmux pointer, or the pty ws stream). Behavior-identical to what `open()` used to inline.
 */
export async function attachResolved(
  space: string,
  name: string,
  opts: { folder?: string; model?: string; brief?: string; kind?: Kind } = {},
): Promise<void> {
  const { folder, model, brief, kind } = opts;

  // A FOREGROUND `paw claude` agent lives in the operator's OWN terminal, not under the manager — there's
  // no pty to stream and no tmux/cmux window to enter. Point at that terminal instead of trying to attach.
  const fg = readForeground(space, name);
  if (fg) {
    process.stdout.write(
      `"${name}" runs as a foreground claude in another terminal (pid ${fg.pid}) — switch to that terminal ` +
        `(Ctrl-C there ends it). \`paw dm ${name} "…"\` to message it from here.\n`,
    );
    return;
  }

  // The manager watches tmux/cmux agents natively (no ws pty — its `attach` op throws there), so the
  // attach path is per-runtime. paw records what runtime it started the manager under; branch on it.
  const runtime = readRuntimeMarker(space);

  // One control round-trip: spawn if we resolved a folder. Attaching is per-runtime below.
  if (folder) {
    await withManagerControl(space, DEFAULT_SERVER, (ctl) => ensureAgentSpawned(ctl, { space, name, cwd: folder, model, brief, kind }));
  }

  if (runtime === "tmux") {
    // Native tmux attach — drops you into the agent's real window (Ctrl-b d detaches, keeps it live).
    const harness = readAgentType(personaFilePath(space, name)) ?? "claude";
    process.stdout.write(
      `attaching to ${name} (${harness}) in tmux — Ctrl-b d detaches (stays live) · \`paw stop ${name}\` ends it\n`,
    );
    attachTmux(space, name);
    return;
  }
  if (runtime === "cmux") {
    // cmux agents live in a GUI app tab; paw can't take the terminal over. Point at the tab.
    process.stdout.write(
      `"${name}" runs in a cmux tab — switch to it in the cmux app (window "${name}" in the ${tmuxSession(space)} workspace). ` +
        `\`paw stop ${name}\` ends it.\n`,
    );
    return;
  }

  // pty: THERE IS NO TERMINAL TO ATTACH TO ANY MORE, and this says so rather than half-working.
  //
  // Until cotal 0.15 the manager's `attach` handed back a loopback `ws://` URL and paw streamed the pty
  // with its own wire client (src/attach-client.ts, still in the tree). cotal 0.25's `attach` returns a
  // signed §13.6 SESSION GRANT instead — no URL anywhere in the reply schema — which a caller redeems
  // over the mesh by minting a per-session `session-caller` credential and driving the framed session
  // rail. paw cannot do that here for a reason that is not about effort: minting that credential needs
  // the space's local trust SEED, and paw's default mesh is OPEN (no auth material at all). cotal's own
  // `attach` refuses the same case in the same words ("mesh attach needs the local space seed"), so on
  // a paw open mesh this door is shut upstream, not merely unported.
  //
  // The agent is UP and reachable — only the terminal takeover is gone — so the useful thing is to say
  // what still works instead of a bare error.
  throw new Error(
    `paw: can't attach a terminal to "${name}" under the pty runtime on cotal 0.25.\n` +
      `  cotal replaced the manager's ws pty attach with a signed session grant that must be redeemed with\n` +
      `  a credential minted from the space's local seed — which an OPEN mesh (paw's default) does not have.\n` +
      `  The agent itself is running and reachable:\n` +
      `    paw chat ${name}     talk to it\n` +
      `    paw log ${name}      watch its session\n` +
      `    paw runtime tmux     switch the fleet to tmux, where \`paw attach\` enters the real window`,
  );
}

const openCommand: Command = {
  kind: "command",
  name: "open",
  group: "Mesh",
  summary: "attach to a folder's agent terminal (auto-spawns it) — open [<folder>|<name>|<repo>@<branch>] [--name <n>]",
  usage: 'open [<folder>|<name>|<repo>@<branch>] [--name <n>]   (default: ".", --name attaches an extra instance at the folder)',
  run: (a) => open([...a.raw]),
};

// `paw attach` IS `paw open` — the folder-aware attach (CLAUDE.md: `paw attach <name>` wakes a
// durable agent). Registered as its own command name, same run, replacing the old dispatch alias.
const attachCommand: Command = {
  kind: "command",
  name: "attach",
  group: "Mesh",
  summary: "alias of open — attach to a folder's agent terminal (auto-spawns it)",
  usage: 'attach [<folder>|<name>|<repo>@<branch>] [--name <n>]   (default: ".", --name attaches an extra instance at the folder)',
  run: (a) => open([...a.raw]),
};

registry.register(openCommand, attachCommand);
