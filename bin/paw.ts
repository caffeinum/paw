#!/usr/bin/env node
/**
 * Composition root for the `paw` CLI — endpoint-native. This process imports ONLY @cotal-ai/core
 * (the registry + endpoint contracts) and paw's own command modules, which self-register into the
 * registry on import; dispatch is paw's own (first word → registry lookup → run). No @cotal-ai/cli,
 * no @cotal-ai/manager: the raw cotal CLI + the manager live behind bin/cotald.ts, a SEPARATE
 * composition root reached only as a subprocess — src/lifecycle.ts drives the daemons through it,
 * and `paw cotal <verb>` spawns it for raw cotal verbs paw doesn't surface.
 *
 * On top of dispatch, paw owns the daemon lifecycle (src/lifecycle.ts) so the operator never runs
 * `paw up` / `paw supervise`: a pre-dispatch gate brings the mesh (and, for control-plane verbs,
 * the manager) up before the command runs, routes `down` through paw's own teardown, and injects
 * the machine-wide default --space so the operator never types it.
 */
import "../src/log-stamp-boot.ts"; // first: timestamps a log-redirected daemon's lines (src/log-stamp.ts)
import { registry, type Command } from "@cotal-ai/core";
import { spawnSync } from "node:child_process";
import { downSpace, explicitSpace, expandEqFlags, expandShortForm, failureLine, hoistAddressSpace, oneShotReplyNote, remoteCotalArgv, SHORT_FORMS, stripCotalNamespace, withDefaultSpace } from "../src/dispatch.ts";
import { cotaldViaNode, ensure, resolveSpace, stop } from "../src/lifecycle.ts";
import { loadAllCommands, loadCommandsFor } from "../src/command-modules.ts";
import { readRemoteMesh } from "../src/remote-mesh.ts";
import { isRemoteSpace } from "../src/server.ts";

/** Verbs bin/paw.ts answers itself without any registry Command — they load no command module. */
const INLINE_VERBS = new Set(["cotal", "down", "create", "send"]);

/** Commands that talk to the mesh — they need NATS reachable before they run. */
const NEEDS_MESH = new Set(["inbox", "msg", "ask", "who", "history", "watch", "files", "bind"]);
/** Commands that drive the control plane — they additionally need the manager answering.
 *  `open`/`dm` are here too: they spawn the folder's agent through the manager.
 *  (`sessions`/`log` are local reads; `adopt` runs its own ensure once it decides to start;
 *  `mailbox` is the daemon ensure() itself spawns — gating it would recurse into the lock.) */
const NEEDS_MANAGER = new Set(["open", "attach", "dm", "tidy"]); // status, chat, rename, rm and stop ensure() themselves — each shares ensure()'s probe rail (lifecycle.ts ensureManagerOn)

/** Raw cotal verbs that drive the control plane — the passthrough must bring the manager up too,
 *  or a cold-machine `paw cotal ps`/`start` dead-ends on a mesh with no manager answering. */
const COTAL_NEEDS_MANAGER = new Set(["start", "ps", "stop", "attach", "spawn", "despawn"]);
// cotal verbs that talk to no mesh and reject a --space flag — passed through untouched.
const COTAL_SPACELESS = new Set(["feedback"]);

/** One-screen help: every registered (non-hidden) command + the raw-cotal passthrough hint. */
function help(): string {
  const commands = registry
    .all<Command>("command")
    .filter((c) => c.hidden !== true)
    .sort((a, b) => a.name.localeCompare(b.name));
  // The short form rides next to its verb (`attach, a`), so the help is where you learn them.
  const short = Object.fromEntries(Object.entries(SHORT_FORMS).map(([k, v]) => [v, k]));
  const label = (n: string) => (short[n] ? `${n}, ${short[n]}` : n);
  const width = Math.max(...commands.map((c) => label(c.name).length));
  const lines = commands.map((c) => `  ${label(c.name).padEnd(width)}  ${c.summary}`);
  return [
    "paw — warm claude agents on the cotal mesh, one per folder",
    "",
    "usage: paw <command> [args]",
    "",
    ...lines,
    `  ${"down".padEnd(width)}  stop the daemons paw started for this space`,
    "",
    "address another space: <agent>#<space> = <agent> --space <space>   (paw dm intern#team2027 \"hi\"; quote it under zsh extendedglob)",
    "raw cotal verbs: paw cotal <cmd> …   (subprocess passthrough to the cotal CLI)",
  ].join("\n");
}

// A short form (`paw a` = `paw attach`) is expanded HERE, before anything reads the verb, so the
// mesh/manager gating, --space injection and the command lookup all see the real name.
const raw = [...process.argv.slice(2)];
if (raw.length) raw[0] = expandShortForm(raw[0]) as string;
const cmd = raw[0];
// Only the verb's own module is evaluated (src/command-modules.ts) — loading all ~43 was most of a
// short command's startup. help, completion and an unknown word still load every one.
if (cmd === undefined || !INLINE_VERBS.has(cmd)) await loadCommandsFor(cmd);

try {
  if (cmd === "cotal") {
    // `paw cotal <verb…>` escape hatch: spawn the COTAL composition root (bin/cotald.ts) as a
    // subprocess under plain node — runtime coordination, never a compile-time import. The verb still
    // gets a live mesh + the default --space, or it would run against a missing/wrong space.
    const rest = stripCotalNamespace(raw);
    if (rest.length === 0) {
      console.log("paw cotal <cmd> — passthrough to the cotal CLI; e.g. `paw cotal console`");
      process.exit(0);
    }
    const replyNote = oneShotReplyNote(rest);
    if (replyNote) console.error(replyNote);
    const spaceless = COTAL_SPACELESS.has(rest[0]);
    // A `--space` naming a REMOTE space is the space this verb needs up (as the command gate does);
    // with no --space, the current space may itself be remote (PAW_SPACE=team2027).
    const remote = spaceless ? undefined : readRemoteMesh(explicitSpace(rest) ?? resolveSpace());
    const space = spaceless
      ? undefined
      : (await ensure({ needMesh: true, needManager: COTAL_NEEDS_MANAGER.has(rest[0]), ...(remote ? { space: remote.space } : {}) })).space;
    if (remote) {
      // cotal can't resolve a remote paw space by name: run it from the record root (its signer) with
      // the record's server and no --space — see remoteCotalArgv.
      const { argv: remoteArgv, droppedCreds } = remoteCotalArgv(rest, remote.server);
      if (droppedCreds)
        process.stderr.write(
          `paw: --creds dropped — a raw creds file can't make control calls; cotal mints the one-shot instrument from ${remote.root}/.cotal/auth\n`,
        );
      const [exec, args] = cotaldViaNode(remoteArgv);
      const res = spawnSync(exec, args, { stdio: "inherit", cwd: remote.root });
      process.exit(res.status ?? 1);
    }
    const [exec, args] = cotaldViaNode(space ? withDefaultSpace(rest, space) : rest);
    const res = spawnSync(exec, args, { stdio: "inherit" });
    process.exit(res.status ?? 1);
  }

  if (cmd === "claude") {
    // `paw claude <claude-args…>`: exec the REAL claude in THIS terminal, mesh-wired (src/claude.ts).
    // A DEDICATED early branch (peer of `cotal`), BEFORE the NEEDS_* gating and BEFORE withDefaultSpace:
    // claude.ts self-ensures, and appending a trailing `--space` would leak into the claude passthrough.
    // The remaining raw tokens go through verbatim (claude.ts peels its own --space/--name first).
    const { runClaude } = await import("../src/claude.ts");
    await runClaude(hoistAddressSpace(cmd, raw.slice(1)));
    process.exit(0); // runClaude normally process.exit()s on the child's exit; this is a fallback
  }

  if (cmd === "__complete" || cmd === "completion") {
    // `paw __complete <words…>` / `paw completion …`: shell-completion (src/commands/complete.ts).
    // A DEDICATED early branch, BEFORE withDefaultSpace/expandEqFlags — `__complete`'s argv is
    // another command's HALF-TYPED line (the last word is the one under the cursor: an appended
    // trailing --space would corrupt it), and `completion install` reads its positional shell arg
    // the same trailing slot withDefaultSpace would clobber (`install --space paw` → tries to
    // install for shell "--space"). Neither needs a space at all — both are local-only.
    const command = registry.all<Command>("command").find((c) => c.name === cmd)!;
    await command.run({ values: {}, positionals: [], raw: raw.slice(1) });
    process.exit(0);
  }

  if (cmd === undefined || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(help());
    process.exit(0);
  }

  if (cmd === "create") {
    // `create` was folded into `paw chat --fresh` (hard remove, no alias). Redirect, don't silently 404.
    throw new Error(
      `paw: \`create\` was folded into \`paw chat --fresh\` — run \`paw chat --fresh <folder>\` to birth a new agent.`,
    );
  }
  if (cmd === "send") {
    // There is no top-level `send` anymore (it was cotal's). Human→agent traffic is `paw dm` (the
    // reply lands in `paw inbox`); channel/role sends are `paw msg` / `paw ask`; the raw mesh send
    // stays reachable via `paw cotal send …`.
    throw new Error(
      "paw: no `send` command — use `paw dm <agent> \"<msg>\"` (reply lands in `paw inbox`), " +
        "`paw msg <#channel> \"<text>\"`, `paw ask <role> \"<text>\"`, or `paw cotal send …` for the raw mesh send.",
    );
  }
  if (cmd === "down") {
    // `down` is a paw lifecycle verb: tear down only the daemons paw started for this space.
    await stop({ space: downSpace(raw.slice(1), resolveSpace) });
    process.exit(0);
  }

  const find = () => registry.all<Command>("command").find((c) => c.name === cmd);
  // A verb whose src/command-modules.ts entry is missing or stale still resolves (check:dispatch catches the map).
  const command = find() ?? (await loadAllCommands(), find());
  if (!command) {
    // No silent fallthrough to cotal: an unknown word is an error, with the passthrough as the way out.
    throw new Error(`paw: unknown command "${cmd}" — run \`paw\` for the list, or \`paw cotal ${cmd} …\` for a raw cotal verb.`);
  }

  // The gate ensures the CURRENT space (PAW_SPACE or the default), as it always has — except when the
  // command names a REMOTE space with --space: then that space's broker/manager is the one it needs.
  // `<agent>#<space>` becomes `<agent> --space <space>` FIRST, so the gate below ensures that space.
  const args = hoistAddressSpace(cmd, raw.slice(1));
  const named = explicitSpace(args);
  const gate = named && isRemoteSpace(named) ? { space: named } : {};
  if (NEEDS_MANAGER.has(cmd)) await ensure({ needMesh: true, needManager: true, ...gate });
  else if (NEEDS_MESH.has(cmd)) await ensure({ needMesh: true, ...gate });

  const argv = expandEqFlags(withDefaultSpace(args, resolveSpace()));
  await command.run({ values: {}, positionals: [], raw: argv });
} catch (err) {
  // Operator-facing failures should read as one clear line, not a V8 stack dump. The errors paw
  // throws are already actionable; keep the full stack behind PAW_DEBUG for when it isn't.
  // Never exit 1 SILENTLY: an error with an empty message (or a thrown non-Error) used to print a blank
  // line, and a launchd log then showed a failed run with no reason. failureLine always names one.
  process.stderr.write(failureLine(cmd, err, !process.stderr.isTTY) + "\n");
  if (process.env.PAW_DEBUG) console.error(err);
  process.exit(1);
}
