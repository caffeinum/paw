/**
 * `paw claude [claude-args…]` — run the REAL claude in the operator's current shell, mesh-wired.
 *
 * Where `paw chat --fresh <folder>` spawns a HEADLESS agent under the manager (a pty/tmux/cmux tab you
 * attach to), `paw claude` execs `claude` right here (stdio inherited — your real tty), but wrapped with
 * paw's connector mesh-wiring: the cotal MCP server, presence, the mesh brief, unattended permissions.
 * So you get a normal, fully-interactive claude session in your terminal that is ALSO an addressable
 * peer on the mesh — teammates can `paw dm` it, it shows in `paw status`. It dies with the terminal
 * (Ctrl-C / closed tab), not warm; a durable resume-pin makes a later `paw open`/`paw chat` resume the
 * same conversation as a managed agent.
 *
 * Two-zone arg parse: leading `--space`/`--name` (and a literal `--` terminator) are paw's; the first
 * token that isn't one of those begins the claude PASSTHROUGH, forwarded verbatim. paw's own
 * connector-injected session flags are stripped so the operator's `--continue`/`--resume` wins.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { registry, type Command } from "@cotal-ai/core";
import {
  canonicalDir,
  ensureAgentSpawned,
  ensurePersonaFile,
  folderToName,
  restartAgent,
  psRowAlive,
  resolveModel,
  spawnLockPath,
  type PsRow,
} from "./addressing.js";
import { claudeProjectDir, latestSession, pinClaudeArgs, pinSession } from "./adopt.js";
import { withManagerControl } from "./control.js";
import { pawConnector } from "./connector.js";
import { confineAndTrustCwd } from "./cwd.js";
import { attachResolved } from "./open.js";
import { readForeground, registerForeground, unregisterForeground } from "./foreground.js";
import { daemonEnv, ensure, resolveSpace } from "./lifecycle.js";
import { withFileLockAsync } from "./lock.js";
import { resolveNamedSession } from "./named.js";
import { readClaudeArgs, readResumeId } from "./session.js";

/**
 * Two-zone parse: consume LEADING paw-owned opts (`--space <s>`, `--name <n>`, and `--space=`/`--name=`
 * forms), stopping at a literal `--` terminator or the first token that isn't a paw opt — everything
 * from there is the claude passthrough, forwarded VERBATIM. So `paw claude --name x -c -p "hi"` →
 * name=x, claudeArgs=["-c","-p","hi"], and `paw claude -- --space foo` treats `--space foo` as claude's.
 */
export function peelArgs(argv: string[]): { space?: string; name?: string; fg?: boolean; noAttach?: boolean; claudeArgs: string[] } {
  let space: string | undefined;
  let name: string | undefined;
  let fg = false;
  let noAttach = false;
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      i++; // the terminator itself isn't passed to claude
      break;
    }
    if (a === "--space") {
      space = argv[++i];
      if (space === undefined) throw new Error("paw: --space needs a value");
      continue;
    }
    if (a === "--name") {
      name = argv[++i];
      if (name === undefined) throw new Error("paw: --name needs a value");
      continue;
    }
    if (a.startsWith("--space=")) {
      space = a.slice("--space=".length);
      continue;
    }
    if (a.startsWith("--name=")) {
      name = a.slice("--name=".length);
      continue;
    }
    if (a === "--fg" || a === "--foreground") {
      fg = true;
      continue;
    }
    if (a === "--no-attach") {
      noAttach = true;
      continue;
    }
    break; // first non-paw token → claude passthrough begins here
  }
  return { space, name, fg, noAttach, claudeArgs: argv.slice(i) };
}

/** What session the operator's own claude args target, for the DURABLE pin: `--continue`/`-c` continues
 *  the folder's latest; `--resume <id|name>` resumes that one; a BARE `--resume`/`-r` (interactive
 *  picker) or no flag is "fresh" — an unknown session we don't pin. */
export function deriveSessionIntent(claudeArgs: string[]): { mode: "continue" | "resume" | "fresh"; token?: string } {
  for (let i = 0; i < claudeArgs.length; i++) {
    const a = claudeArgs[i];
    if (a === "--continue" || a === "-c") return { mode: "continue" };
    if (a === "--resume" || a === "-r") {
      const next = claudeArgs[i + 1];
      if (next !== undefined && !next.startsWith("-")) return { mode: "resume", token: next };
      return { mode: "resume" }; // bare picker — nothing to pin
    }
  }
  return { mode: "fresh" };
}

/** Drop paw's connector-injected session flags (`--resume <id>` / `--session-id <id>` pairs and the bare
 *  `--fork-session`) so the operator's OWN session control in the passthrough wins. Everything else the
 *  connector added (mesh MCP, persona, permission mode, disallowed tools) is kept. Pure — unit-tested. */
export function stripSessionFlags(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--resume" || a === "--session-id") {
      i++; // also drop the flag's value
      continue;
    }
    if (a === "--fork-session") continue;
    out.push(a);
  }
  return out;
}

/**
 * The args to launch claude with. In FRESH mode (bare `paw claude`, no `--continue`/`--resume`) KEEP the
 * connector's injected `--session-id`/`--resume <persona-pin>` so the session is the folder's DURABLE
 * one — bare `paw claude` resumes the folder's session exactly like bare `paw chat`/`paw open`, and it's
 * recorded/resumable (dropping it would make claude mint a random session paw never sees). Only when the
 * operator supplied their OWN `--continue`/`--resume` do we strip the connector's session flags so theirs
 * wins. Pure — unit-tested.
 */
export function finalLaunchArgs(mode: "continue" | "resume" | "fresh", specArgs: string[], claudeArgs: string[]): string[] {
  return mode === "fresh" ? [...specArgs, ...claudeArgs] : [...stripSessionFlags(specArgs), ...claudeArgs];
}

/** Best-effort resolve a `--resume` token (a transcript id or a named session) to a real session id at
 *  `folder`, for the pin only. Returns undefined when it can't be resolved locally — claude itself
 *  validates the passthrough, so an unresolvable token just means "don't pin", never a hard failure. */
function resolveResumeId(folder: string, token: string): string | undefined {
  const dir = claudeProjectDir(folder);
  if (existsSync(join(dir, `${token}.jsonl`))) return token;
  const named = resolveNamedSession(folder, token);
  if (named && existsSync(join(dir, `${named}.jsonl`))) return named;
  return undefined;
}

/** The durable session id to pin for this launch (undefined = fresh / bare picker / unresolvable). */
function deriveSessionId(folder: string, claudeArgs: string[]): string | undefined {
  const intent = deriveSessionIntent(claudeArgs);
  if (intent.mode === "continue") return latestSession(claudeProjectDir(folder)); // may be undefined (no sessions yet)
  if (intent.mode === "resume" && intent.token) return resolveResumeId(folder, intent.token);
  return undefined;
}

/**
 * The DEFAULT `paw claude`: bring claude up as a MANAGED agent — warm, on the mesh, surviving this
 * terminal — and attach to it. Same destination as `paw adopt`, reached with claude's own flags
 * instead of a session id.
 *
 * The difference from `--fg` is not cosmetic. A foreground claude dies with the window it was
 * launched in, so the mesh peer it registered dies too, and a teammate that DMs it an hour later is
 * talking to nobody. A managed one keeps answering after you close the terminal, which is the entire
 * reason paw exists — so it is the default, and the terminal-bound one is the opt-in.
 *
 * The operator's extra claude flags are PERSISTED to the persona rather than passed once, so a
 * restart, a `paw restart`, or a reboot relaunches the same claude. Session flags are excluded: the
 * durable pin already carries the conversation, and a second source for it is how two writers end up
 * on one transcript.
 */
async function runManaged(
  space: string,
  folder: string,
  name: string,
  claudeArgs: string[],
  sessionId: string | undefined,
  noAttach: boolean,
): Promise<void> {
  const existingFg = readForeground(space, name);
  if (existingFg)
    throw new Error(
      `paw: an agent "${name}" is already live (foreground claude, pid ${existingFg.pid}) — ` +
        `\`paw stop ${name}\` first, or attach to that terminal`,
    );

  const { server } = await ensure({ needMesh: true, needManager: true, space });

  // Pin the conversation first, then the flags: both are read at LAUNCH by the connector, so they
  // must be on disk before the spawn below rather than applied to an already-running claude.
  if (sessionId) pinSession(space, name, sessionId);
  const configPath = ensurePersonaFile(space, name, { kind: "folder" });
  const wanted = stripSessionFlags(claudeArgs);
  const changed = JSON.stringify(readClaudeArgs(configPath)) !== JSON.stringify(wanted);
  pinClaudeArgs(space, name, wanted);

  await withManagerControl(space, server, async (ctl) => {
    // A live agent launched under DIFFERENT flags (or a different session) is not the agent the
    // operator just asked for, and flags are only read at launch — so restart it rather than
    // attaching to something that silently ignores what they typed. Unchanged → plain ensure, so a
    // bare `paw claude` on a warm agent attaches instead of bouncing it.
    if (changed || sessionId) await restartAgent(ctl, { space, name, cwd: folder, model: resolveModel() });
    else await ensureAgentSpawned(ctl, { space, name, cwd: folder, model: resolveModel() });
  });

  console.log(`paw: "${name}" is live on the mesh (managed — survives this terminal; \`paw stop ${name}\` to end it)`);
  if (noAttach) return;
  await attachResolved(space, name, { folder, model: resolveModel(), kind: "folder" });
}

export async function runClaude(argv: string[]): Promise<void> {
  const { space: spaceArg, name: nameArg, fg, noAttach, claudeArgs } = peelArgs(argv);
  const space = spaceArg ?? resolveSpace();
  const folder = canonicalDir("."); // always the operator's current directory — no folder positional
  const name = nameArg ?? folderToName(space, folder);

  const intent = deriveSessionIntent(claudeArgs);
  const sessionId = deriveSessionId(folder, claudeArgs); // the operator's explicit pin (undefined = fresh/bare)

  if (!fg) return runManaged(space, folder, name, claudeArgs, sessionId, noAttach === true);

  // Serialize the whole dedup→spawn→register window on the SAME per-(space,name) lock ensureAgentSpawned
  // uses, so two concurrent `paw claude` (or a racing `paw dm <folder>`) can't both pass the dedup and put
  // two writers under one mesh name. Released before the (long) interactive session runs — it only guards
  // the check+register window, not the session.
  const child = await withFileLockAsync(spawnLockPath(space, name), async () => {
    // (a) Dedup — a foreground claude for this name already runs in another terminal. Fail loud.
    const existingFg = readForeground(space, name);
    if (existingFg) {
      throw new Error(
        `paw: an agent "${name}" is already live (foreground claude, pid ${existingFg.pid}) — ` +
          `\`paw open ${name}\` to find its terminal, or \`paw stop ${name}\` first`,
      );
    }

    // (c) Bring the mesh + manager up (the connector wires the session to this mesh).
    const { server } = await ensure({ needMesh: true, needManager: true, space });

    // (a, cont.) Dedup against a live MANAGER agent (pty/tmux/cmux) already holding this name — BEFORE any
    //            persona-pin write, so a refused launch never mutates a running agent's state.
    await withManagerControl(space, server, async (ctl) => {
      const ps = await ctl.ps();
      if (!ps.ok) throw new Error(`paw: manager isn't answering (${ps.error ?? "no reply"})`);
      const row = ((ps.data as PsRow[]) ?? []).find((r) => r.name === name);
      if (row && psRowAlive(row)) {
        throw new Error(
          `paw: an agent "${name}" is already live under the manager — ` +
            `\`paw open ${name}\` to attach, or \`paw stop ${name}\` first`,
        );
      }
    });

    // (b) Pin the durable resume session AFTER the dedup passes → a later `paw open`/`paw chat` resumes
    //     THIS conversation. (fresh/bare: sessionId undefined; the persona's birth pin below is the durable one.)
    if (sessionId) pinSession(space, name, sessionId);

    // (d) Build the mesh-wired launch through paw's connector (mesh MCP, brief, permissions, the pin).
    const configPath = ensurePersonaFile(space, name, { kind: "folder" });
    const spec = pawConnector.buildLaunch({ space, name, configPath, servers: server, model: resolveModel() });

    // (e) fresh KEEPS the connector's durable session pin; an explicit --continue/--resume strips it + wins.
    const finalArgs = finalLaunchArgs(intent.mode, spec.args, claudeArgs);

    // (f) Confine + pre-trust the cwd (the same safety the manager spawn site applies).
    const cwd = confineAndTrustCwd(folder);

    // (h) Exec the REAL claude in this terminal (inherited stdio), carrying the connector's mesh env.
    const c = spawn(spec.command, finalArgs, { stdio: "inherit", cwd, env: daemonEnv(spec.env) });

    // (g) Register so the rest of paw sees it. The DURABLE session is the persona's EFFECTIVE pin — the
    //     operator's explicit one, else the birth id ensurePersonaFile just minted (so status/open/stop
    //     resume the RIGHT conversation, not an empty one). pid known only post-spawn.
    if (c.pid) {
      registerForeground(space, {
        name,
        folder,
        pid: c.pid,
        startedAt: Date.now(),
        sessionId: sessionId ?? readResumeId(configPath),
        argv: claudeArgs,
      });
    }
    return c;
  });

  child.on("error", (e: Error) => {
    unregisterForeground(space, name);
    console.error(`paw: couldn't launch claude (${e.message}) — is \`claude\` on your PATH?`);
    process.exit(1);
  });

  // (i) Forward terminal-lifecycle signals to the child, then unregister on exit. (SIGINT at a shared
  //     tty is delivered to the child by the terminal — don't double-handle it.)
  const forward = (sig: NodeJS.Signals) => () => {
    if (child.pid) {
      try {
        process.kill(child.pid, sig);
      } catch {
        /* already gone */
      }
    }
  };
  const onTerm = forward("SIGTERM");
  const onHup = forward("SIGHUP");
  process.on("SIGTERM", onTerm);
  process.on("SIGHUP", onHup);

  const [code, signal] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
  process.off("SIGTERM", onTerm);
  process.off("SIGHUP", onHup);
  unregisterForeground(space, name);
  process.exit(code ?? (signal ? 1 : 0));
}

const claudeCommand: Command = {
  kind: "command",
  name: "claude",
  group: "Lifecycle",
  summary: "start claude as a warm managed mesh agent and attach — claude [claude-args] (--fg runs it in THIS terminal instead)",
  usage: "claude [--name <n>] [--space <s>] [--fg] [--no-attach] [--] [any claude flags/args]   (--continue/--resume set the durable pin)",
  run: (a) => runClaude([...a.raw]),
};

registry.register(claudeCommand);
