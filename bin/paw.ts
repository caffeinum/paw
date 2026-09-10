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
import { registry, type Command } from "@cotal-ai/core";
import { spawnSync } from "node:child_process";
import { runClaude } from "../src/claude.js"; // self-registers "claude" (real claude in this terminal, mesh-wired) + the runner bin routes to early
import "../src/chat.js"; // self-registers the "chat" command (message it — REPL; --fresh births a new agent)
import "../src/open.js"; // self-registers the "open" command (attach its terminal)
import "../src/adopt.js"; // self-registers the "adopt" command (resume a past claude session)
import "../src/rename.js"; // self-registers the "rename" command (relabel an agent, keep its session)
import "../src/rm.js"; // self-registers the "rm" command (forget an agent; always keeps its transcript)
import "../src/status.js"; // self-registers the "status" command (durability + two-writer health view)
import "../src/sessions.js"; // self-registers the "sessions" command (local: lists a folder's transcripts)
import "../src/log.js"; // self-registers the "log" command (local: read an agent's transcript directly)
import "../src/inbox.js"; // self-registers the "inbox" command (read your DM inbox; --history for all)
import "../src/dm.js"; // self-registers the "dm" command (fire-and-forget DM as "you")
import "../src/mailbox.js"; // self-registers the "mailbox" daemon (persistent "you" presence beacon)
import "../src/commands/stop.js"; // self-registers the "stop" command (folder-aware control-plane stop)
import "../src/commands/msg.js"; // self-registers the "msg" command (one-shot channel broadcast)
import "../src/commands/ask.js"; // self-registers the "ask" command (one-shot role anycast)
import "../src/commands/who.js"; // self-registers the "who" command (live roster)
import "../src/commands/history.js"; // self-registers the "history" command (channel/DM backlog)
import "../src/commands/bind.js"; // self-registers the "bind" command (mint a code to authorize a new Telegram chat)
import "../src/commands/files.js"; // self-registers the "files" command (list files endpoints shared on #files)
import "../src/commands/watch.js"; // self-registers the "watch" command (live tap of the space)
import "../src/commands/runtime.js"; // self-registers "runtime" + "restart" (manager runtime preference/bounce)
import "../src/commands/release.js"; // self-registers "release" (snapshot the checkout the daemons run from); LOCAL — files + a symlink, no mesh
import "../src/commands/mcp.js"; // self-registers "mcp" (which MCP servers agents get); LOCAL — reads config + personas, no mesh
import "../src/commands/launchd.js"; // self-registers "launchd" (fleet + web at login); LOCAL — plists + launchctl, self-resolves the manager only to capture the live list
import "../src/global.js"; // self-registers the "global" command (bring up the always-on $HOME machine agent)
import "../src/start.js"; // self-registers the "start" command (cold-start the whole registered fleet)
import "../src/web.js"; // self-registers the "web" command (local http+ws UI over feed/transcript/status)
import "../src/commands/complete.js"; // self-registers "completion" + the hidden "__complete" dispatcher (shell-completion)
import { expandEqFlags, stripCotalNamespace, withDefaultSpace } from "../src/dispatch.js";
import { cotaldViaTsx, ensure, resolveSpace, stop } from "../src/lifecycle.js";

/** Commands that talk to the mesh — they need NATS reachable before they run. */
const NEEDS_MESH = new Set(["inbox", "msg", "ask", "who", "history", "watch", "files", "bind"]);
/** Commands that drive the control plane — they additionally need the manager answering.
 *  `chat`/`open`/`dm` are here too: they spawn the folder's agent through the manager.
 *  (`sessions`/`log` are local reads; `adopt` runs its own ensure once it decides to start;
 *  `mailbox` is the daemon ensure() itself spawns — gating it would recurse into the lock.) */
const NEEDS_MANAGER = new Set(["chat", "open", "attach", "dm", "rename", "rm", "status", "stop"]);

/** Raw cotal verbs that drive the control plane — the passthrough must bring the manager up too,
 *  or a cold-machine `paw cotal ps`/`start` dead-ends on a mesh with no manager answering. */
const COTAL_NEEDS_MANAGER = new Set(["start", "ps", "stop", "attach", "spawn", "despawn"]);

/** One-screen help: every registered (non-hidden) command + the raw-cotal passthrough hint. */
function help(): string {
  const commands = registry
    .all<Command>("command")
    .filter((c) => c.hidden !== true)
    .sort((a, b) => a.name.localeCompare(b.name));
  const width = Math.max(...commands.map((c) => c.name.length));
  const lines = commands.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`);
  return [
    "paw — warm claude agents on the cotal mesh, one per folder",
    "",
    "usage: paw <command> [args]",
    "",
    ...lines,
    `  ${"down".padEnd(width)}  stop the daemons paw started for this space`,
    "",
    "raw cotal verbs: paw cotal <cmd> …   (subprocess passthrough to the cotal CLI)",
  ].join("\n");
}

const raw = process.argv.slice(2);
const cmd = raw[0];

try {
  if (cmd === "cotal") {
    // `paw cotal <verb…>` escape hatch: spawn the COTAL composition root (bin/cotald.ts) as a
    // subprocess under node+tsx — runtime coordination, never a compile-time import. The verb still
    // gets a live mesh + the default --space, or it would run against a missing/wrong space.
    const rest = stripCotalNamespace(raw);
    if (rest.length === 0) {
      console.log("paw cotal <cmd> — passthrough to the cotal CLI; e.g. `paw cotal console`");
      process.exit(0);
    }
    const { space } = await ensure({ needMesh: true, needManager: COTAL_NEEDS_MANAGER.has(rest[0]) });
    const [exec, args] = cotaldViaTsx(withDefaultSpace(rest, space));
    const res = spawnSync(exec, args, { stdio: "inherit" });
    process.exit(res.status ?? 1);
  }

  if (cmd === "claude") {
    // `paw claude <claude-args…>`: exec the REAL claude in THIS terminal, mesh-wired (src/claude.ts).
    // A DEDICATED early branch (peer of `cotal`), BEFORE the NEEDS_* gating and BEFORE withDefaultSpace:
    // claude.ts self-ensures, and appending a trailing `--space` would leak into the claude passthrough.
    // The remaining raw tokens go through verbatim (claude.ts peels its own --space/--name first).
    await runClaude(raw.slice(1));
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
    await stop();
    process.exit(0);
  }

  const command = registry.all<Command>("command").find((c) => c.name === cmd);
  if (!command) {
    // No silent fallthrough to cotal: an unknown word is an error, with the passthrough as the way out.
    throw new Error(`paw: unknown command "${cmd}" — run \`paw\` for the list, or \`paw cotal ${cmd} …\` for a raw cotal verb.`);
  }

  if (NEEDS_MANAGER.has(cmd)) await ensure({ needMesh: true, needManager: true });
  else if (NEEDS_MESH.has(cmd)) await ensure({ needMesh: true });

  const argv = expandEqFlags(withDefaultSpace(raw.slice(1), resolveSpace()));
  await command.run({ values: {}, positionals: [], raw: argv });
} catch (err) {
  // Operator-facing failures should read as one clear line, not a V8 stack dump. The errors paw
  // throws are already actionable; keep the full stack behind PAW_DEBUG for when it isn't.
  console.error((err as Error)?.message ?? String(err));
  if (process.env.PAW_DEBUG) console.error(err);
  process.exit(1);
}
