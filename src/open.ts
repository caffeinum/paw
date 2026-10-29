/**
 * `paw open [folder|name|repo@branch]` — folder-addressed sugar over cotal's `attach`. Resolves the
 * folder's agent (spawning it if absent), or falls back to a live agent's NAME, then attaches to its
 * live pty via cotal's own `attach` command. Where `paw chat` is the durable DM conversation, `open`
 * drops you into the agent's real terminal.
 *
 * Built on cotal: the spawn goes through the manager's service endpoint; the pty attach is cotal's own
 * `attach` run as a subprocess with the tty passed through — see {@link attachResolved}.
 * Self-registers an "open" command on import; bin/paw.ts ensures the mesh + manager are up first.
 */
import { spawnSync } from "node:child_process";
import { registry, type Command } from "@cotal-ai/core";
import { attachTmux, tmuxSession, tmuxSplit, tmuxSplitAdvice, tmuxWindowExists } from "./native-attach.ts";
import { liveSessionProcs } from "./named.ts";
import { existsSync, readdirSync } from "node:fs";
import { assertUnambiguousTarget, canonicalDir, cliRestartConsent, ensureAgentSpawned, folderForName, personaFilePath, registerInstance, resolveFolderAgent, setFolderName, type Kind } from "./addressing.ts";
import { KIT_AGENT, kitBinPath } from "./kit.ts";
import { agentSummary } from "./agent-summary.ts";
import { personaTranscriptRoots, readAgentType, readCwd, readHeadless, readKitStorage, readResumeId, transcriptPath } from "./session.ts";
import { claudeProjectDir } from "./adopt.ts";
import { dirname, join } from "node:path";
import { withManagerControl } from "./control.ts";
import { readForeground } from "./foreground.ts";
import { elsewhereAttach, localManagerInstanceId, runsElsewhere } from "./hosted.ts";
import { contractMismatchHint } from "./contract-mismatch.ts";
import { runTeed } from "./cotal-tee.ts";
import { isAddressHandle, resolveAddress } from "./address.ts";
import { cotaldViaNode, readRuntimeMarker, resolveSpace } from "./lifecycle.ts";
import { findMesh } from "@cotal-ai/workspace";
import { pawCotalRoot } from "./cotal-root.ts";
import { remoteCotalArgv } from "./dispatch.ts";
import { readRemoteMesh } from "./remote-mesh.ts";
import { pawServer } from "./server.ts";

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
  const { space: spaceArg, target: rawTarget, model, name: nameFlag } = parseArgs(argv);
  const target = rawTarget?.startsWith("@") ? rawTarget.slice(1) : rawTarget; // `@name` = that agent
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
    // --name attaches an EXTRA instance at this folder (its own persona); no --name keeps the
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
 * a cmux pointer, or cotal's grant-based pty attach). Behavior-identical to what `open()` used to inline.
 */
export async function attachResolved(
  space: string,
  name: string,
  opts: { folder?: string; model?: string; brief?: string; kind?: Kind } = {},
): Promise<void> {
  const { folder, model, brief, kind } = opts;

  // A FOREGROUND `paw claude` agent lives in the operator's OWN terminal, not under the manager — there's
  // no pty to stream and no tmux/cmux window to enter. Point at that terminal instead of trying to attach.
  // No persona here and nothing to spawn from: the agent lives in another space (or nowhere). Say which,
  // instead of falling through to a tmux attach that dies reading the missing persona file.
  if (!folder && !existsSync(personaFilePath(space, name)) && !(readRuntimeMarker(space) === "tmux" && tmuxWindowExists(space, name))) {
    const spacesDir = dirname(dirname(dirname(personaFilePath(space, name))));
    const elsewhere = readdirSync(spacesDir).filter((s) => s !== space && existsSync(personaFilePath(s, name)));
    throw new Error(
      elsewhere.length
        ? `paw: no agent "${name}" in space ${space} — it's in ${elsewhere.join(", ")}: \`paw attach ${name}#${elsewhere[0]}\``
        : `paw: no agent "${name}" in space ${space} (\`paw status\` lists them)`,
    );
  }

  // Teleported: its terminal is on the other machine — attaching here could only start a second copy.
  const away = existsSync(personaFilePath(space, name)) ? runsElsewhere(space, name) : undefined;
  if (away) throw new Error(elsewhereAttach(name, away));

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

  // A window for this agent is already open in tmux → attach to IT, without asking the manager first.
  // Attaching is about a terminal, and the terminal is right there; routing through the manager's
  // liveness view first is how `paw attach evals` tried to RESTART a running agent when the manager's
  // view was wrong (2026-09-23 — it had marked evals `exited` while evals heartbeated on the mesh).
  const windowOpen = runtime === "tmux" && tmuxWindowExists(space, name);
  // One control round-trip: spawn if we resolved a folder. Attaching is per-runtime below.
  if (folder && !windowOpen) {
    // Attaching to an offline agent starts it, and a boot can take a minute: say so, never a blank wait.
    // Only a real spawn prints (a live agent is reused silently).
    const progress = (line: string) => process.stderr.write(`paw: attach ${name}: ${line}\n`);
    const r = await withManagerControl(space, pawServer(space), (ctl) => ensureAgentSpawned(ctl, { space, name, cwd: folder, model, brief, kind, progress, restartLive: cliRestartConsent(false) }));
    if (r.stuck) process.stderr.write(`paw: ${r.stuck}\n`);
  }

  // A HEADLESS agent (`claude -p`, docs/notes/headless.md) or a KIT agent (src/kit.ts) has no TUI
  // anywhere — its window holds only stderr. Attaching to it means watching what it does: follow its log.
  const persona = personaFilePath(space, name);
  if (!readHeadless(persona) && readAgentType(persona) === KIT_AGENT && kitView(space, name)) return;
  const kind_ = readHeadless(persona) ? "headless (claude -p, no TUI)" : readAgentType(persona) === KIT_AGENT ? "on kit (headless, no TUI)" : undefined;
  if (kind_) {
    process.stderr.write(`${agentSummary(space, name, persona, readHeadless(persona))}\n\n"${name}" runs ${kind_} — following its log (Ctrl-C stops watching; the agent keeps running) · \`paw dm ${name} "…"\` talks to it\n\n`);
    const r = spawnSync(process.execPath, [...process.execArgv, process.argv[1]!, "log", name, "-f", "--space", space], { stdio: "inherit" });
    if (r.error) throw new Error(`paw: couldn't follow ${name}'s log: ${r.error.message}`);
    return;
  }

  if (runtime === "tmux") {
    // Native tmux attach — drops you into the agent's real window (Ctrl-b d detaches, keeps it live).
    const harness = readAgentType(personaFilePath(space, name)) ?? "claude";
    process.stdout.write(
      `attaching to ${name} (${harness}) in tmux — Ctrl-b d detaches (stays live) · \`paw stop ${name}\` ends it\n`,
    );
    try {
      attachTmux(space, name);
    } catch (e) {
      // No window: before "is it running?", check whether it IS running — in a tmux server the socket
      // no longer reaches (the 2026-09-23 split). Then the fix is a socket, not a restart.
      const pin = readResumeId(personaFilePath(space, name));
      const split = pin ? tmuxSplit(liveSessionProcs(pin).map((p) => p.pid)) : undefined;
      if (split) throw new Error(`paw: can't attach "${name}" — its tmux window is unreachable, not gone.\n${tmuxSplitAdvice(name, split)}`);
      throw e;
    }
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

  // pty: cotal's own `attach` (bin/cotald.ts → runCli), with the tty passed straight through.
  //
  // Until cotal 0.15 the manager's `attach` handed back a loopback `ws://` URL that paw streamed with
  // its own client (src/attach-client.ts, dead code). Since 0.25 it returns a signed §13.6 SESSION
  // GRANT, redeemed over the mesh: on an authed mesh with a `session-caller` cred minted from the
  // space's signer, on a REGISTERED open mesh over a bare connection (cotal #1205, fixed by 0.84).
  // cotal also locates which manager instance hosts the seat (a scatter `ps` across every manager in
  // the space) and pins the call there, so an agent another machine's manager runs attaches too.
  // paw's only job is to run it from where cotal can find that material — see cotalAttachInvocation.
  await attachPty(space, name);
}

/**
 * How `cotal attach` must be invoked for `space` so it resolves the right trust material.
 *  - REMOTE space (`paw mesh add`): cwd = the record root (its `.cotal/auth` is the stripped signer),
 *    `--server <record server>`, NO `--space` — cotal's registry doesn't know the space, and naming it
 *    sends cotal down its raw open arm (bare connect → refused). See remoteCotalArgv.
 *    `on` (the hosting manager instance, see {@link localSeatPin}) becomes `--on <id>`, which skips
 *    cotal's scatter locate entirely.
 *  - LOCAL space: cwd = pawCotalRoot(space), `--space <s> --server <broker>` — the registry entry
 *    `cotal up` recorded carries the mode (open → bare redeem; PAW_AUTH=1 → the root's seed).
 * Pure over the records, so check:remote covers it.
 */
export function cotalAttachInvocation(space: string, name: string, on?: string): { argv: string[]; cwd: string; remote: boolean } {
  const remote = readRemoteMesh(space);
  if (remote) return { argv: remoteCotalArgv(["attach", "--name", name, ...(on ? ["--on", on] : [])], remote.server).argv, cwd: remote.root, remote: true };
  if (on) throw new Error(`paw: a manager pin (--on ${on}) only applies to a remote space; "${space}" is local`);
  return { argv: ["attach", "--name", name, "--space", space, "--server", pawServer(space)], cwd: pawCotalRoot(space), remote: false };
}

type SeatPinDeps = {
  remote: (space: string) => boolean;
  localInstanceId: (space: string) => string | undefined;
  inspect: (space: string, name: string) => Promise<{ ok: boolean; data?: unknown; error?: string }>;
};

const seatPinDeps: SeatPinDeps = {
  remote: (space) => readRemoteMesh(space) !== undefined,
  localInstanceId: localManagerInstanceId,
  inspect: (space, name) => withManagerControl(space, pawServer(space), (ctl) => ctl.inspect(name), { only: ["inspect"] }),
};

/**
 * THIS machine's manager instance when it hosts `name` on a remote space, else undefined.
 *
 * WHY: without `--on`, cotal locates the seat by scattering `ps` across every manager in the space,
 * pinned to the contract of whichever manager answered `describe` first. A space whose hosts run
 * different cotal versions then refuses ~half the calls — `paw attach evals-intern#team2027` failed
 * with "could not establish where … pinned digests … do not match" while this machine's manager
 * hosted the seat the whole time (see src/contract-mismatch.ts). paw's own rail is pinned to this
 * machine's instance (src/control.ts `pinFor`), so its `inspect` is answered by that manager alone
 * and never mismatches; a hit means `--on <that instance>` is exact. A miss (the seat runs on
 * another host) leaves the locate to cotal.
 */
export async function localSeatPin(space: string, name: string, d: SeatPinDeps = seatPinDeps): Promise<string | undefined> {
  if (!d.remote(space)) return undefined;
  const local = d.localInstanceId(space);
  if (!local) return undefined;
  const r = await d.inspect(space, name);
  if (!r.ok) return undefined;
  const row = r.data as { instanceId?: unknown } | undefined;
  if (typeof row?.instanceId === "string" && row.instanceId !== local)
    throw new Error(`paw: this machine's pinned manager rail answered for "${name}" with instance ${row.instanceId}, not its own ${local} — refusing to guess where it runs`);
  return local;
}

async function attachPty(space: string, name: string): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error(`paw: attaching to "${name}" needs a terminal (stdin and stdout must be a tty) — \`paw log ${name} -f\` follows it without one`);
  const on = await localSeatPin(space, name);
  const { argv, cwd, remote } = cotalAttachInvocation(space, name, on);
  const alternatives =
    `    paw chat ${name}  — talk to it\n` +
    `    paw log ${name} -f  — watch its session` +
    (remote ? "" : `\n    paw runtime tmux  — switch this space to tmux, where \`paw attach\` enters the real window`);
  // A local space cotal's registry doesn't know (its broker wasn't started by paw's `cotal up`, e.g. a
  // hand-run PAW_SERVER broker): cotal can't tell it is OPEN, takes the sealed arm and refuses for want
  // of a seed. Say that precisely up front instead of after a round trip.
  if (!remote && !findMesh(space))
    throw new Error(
      `paw: can't attach a terminal to "${name}": space "${space}" (broker ${pawServer(space)}) is not in cotal's mesh registry.\n` +
        `  cotal redeems the attach grant by the space's RECORDED mode — open → a bare connection, auth → a cred minted\n` +
        `  from the space seed. An unrecorded space gets neither (paw records a space only when it starts its broker).\n` +
        `  If the agent is running it is still reachable:\n${alternatives}`,
    );
  const [exec, args] = cotaldViaNode(argv);
  const where = on ? ` on this machine's manager ${on.slice(0, 8)}…` : remote ? " (not hosted by this machine's manager — cotal locates it across the space)" : "";
  process.stderr.write(`attaching to ${name}${where} — Ctrl-] detaches (the agent keeps running) · \`paw stop ${name}\` ends it\n`);
  const r = await runTeed(exec, args, { cwd }).catch((e: Error) => {
    throw new Error(`paw: couldn't run cotal attach for "${name}": ${e.message}`);
  });
  if (r.status === 0) return;
  const hint = contractMismatchHint({ space, text: r.stderr, remote, ...(remote ? { localInstanceId: localManagerInstanceId(space) } : {}) });
  // cotal already printed its own ✗ line (which names the root/broker it resolved). Add what still works.
  throw new Error(
    `paw: cotal couldn't attach a terminal to "${name}" (exit ${r.status ?? r.signal}) — see its message above.\n` +
      (hint ? `${hint}\n` : "") +
      `  If the agent is running it is still reachable:\n${alternatives}`,
  );
}

/**
 * A kit agent's live view: `kit <name>` (kit's own TUI — header, last message, current tool, status,
 * a prompt). Typed messages go through THIS paw (`paw dm <name> -`, as "you"), so the view needs no
 * mesh identity of its own. Returns false — caller falls back to summary + `paw log -f` — off a tty, when the
 * kit binary is missing or predates the view (its help has no `kit <name>`).
 */
function kitView(space: string, name: string): boolean {
  const bin = kitBinPath();
  if (!process.stdin.isTTY || !process.stdout.isTTY || !existsSync(bin)) return false;
  const help = spawnSync(bin, ["--help"], { encoding: "utf8" });
  if (help.error || !/kit <name> \| kit @<name>/.test(help.stdout ?? "")) return false;
  const target = KIT_SUBCOMMANDS.has(name) ? `@${name}` : name;
  const dm = [process.execPath, ...process.execArgv, process.argv[1]!, "dm", name, "--space", space, "-"];
  const r = spawnSync(bin, [target, "--space", space, "--server", pawServer(space), ...kitViewSession(personaFilePath(space, name)), "--", ...dm], { stdio: "inherit" });
  if (r.error) throw new Error(`paw: couldn't open ${name}'s kit view: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`paw: kit's view of ${name} exited with ${r.status ?? r.signal}`);
  return true;
}

/**
 * `--session <transcript>` for kit's view, resolved by paw's store-aware lookup — the view's own
 * default searches kit's store first whatever the persona says, so a `storage: claude` agent (which kit
 * runs with --overwrite) could be shown a stale fork, and before its first turn would be watched at a
 * kit-store path it never writes. Nothing to add for a kit-store agent with no transcript yet: kit's
 * default already names where `kit run` will create it.
 */
export function kitViewSession(persona: string): string[] {
  const pin = readResumeId(persona);
  if (!pin) return [];
  const found = transcriptPath(pin, personaTranscriptRoots(persona));
  if (found) return ["--session", found];
  const cwd = readCwd(persona);
  if (readKitStorage(persona) === "claude" && cwd) return ["--session", join(claudeProjectDir(cwd), `${pin}.jsonl`)];
  return [];
}

/** kit's subcommands: an agent named like one is addressed as `kit @<name>`. */
const KIT_SUBCOMMANDS = new Set(["run", "once", "auth", "dump", "help"]);

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
