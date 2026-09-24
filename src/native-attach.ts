/**
 * Native (non-pty) attach for tmux — the multiplexer runtimes watch each agent in a real terminal
 * window, so there's no ws pty to stream (the manager's `attach` op throws by design). Instead paw
 * drives the multiplexer directly: select the agent's window, then attach (or switch-client if the
 * operator is already inside tmux). The manager names the per-space session `cotal-<space>` and each
 * window after the agent, so the target is deterministic — paw needn't parse the manager's guidance.
 *
 * cmux attach is intentionally NOT here: cmux agents live in a GUI app tab paw can't take a terminal
 * over, so `paw attach` just points the operator at the tab (see src/open.ts). pty keeps the ws path.
 */
import { spawnSync, execFileSync } from "node:child_process";

/**
 * TWO tmux servers on one socket path (2026-09-23): the running server's socket FILE disappeared (cause
 * not established), and the next `tmux new-session` — the manager spawning an agent — found no server
 * there and started a SECOND one, which now owns the path. The first server keeps running every agent
 * it had, but no `tmux` command can reach it: `paw attach` finds no window, the manager marks those
 * agents `exited`, and they are in fact heartbeating on the mesh. tmux's own remedy is SIGUSR1, which
 * makes a server recreate its socket — but the path is taken, so the newer server's socket has to be
 * moved aside first. This returns what `paw attach` needs to say that, or undefined when it isn't the
 * case (the agent really isn't in any tmux server, or it's in the one the socket reaches).
 */
export function tmuxSplit(holderPids: number[]): { agentServer: number; socketServer?: number; socketPath?: string } | undefined {
  const sh = (cmd: string, args: string[]) => spawnSync(cmd, args, { stdio: ["ignore", "pipe", "ignore"], env: plainTmuxEnv() }).stdout?.toString().trim() ?? "";
  let agentServer: number | undefined;
  for (const pid of holderPids) {
    const ppid = Number(sh("ps", ["-o", "ppid=", "-p", String(pid)]));
    if (ppid > 1 && /^tmux\b/.test(sh("ps", ["-o", "command=", "-p", String(ppid)]))) {
      agentServer = ppid;
      break;
    }
  }
  if (!agentServer) return undefined;
  const socketServer = Number(sh("tmux", ["display-message", "-p", "#{pid}"])) || undefined;
  if (socketServer === agentServer) return undefined;
  const socketPath = sh("tmux", ["display-message", "-p", "#{socket_path}"]) || undefined;
  return { agentServer, socketServer, socketPath };
}

/** Does the agent's window exist in the tmux server the socket reaches? Exact name match. */
export function tmuxWindowExists(space: string, name: string): boolean {
  const r = spawnSync("tmux", ["list-windows", "-t", `=${tmuxSession(space)}`, "-F", "#{window_name}"], { stdio: ["ignore", "pipe", "ignore"], env: plainTmuxEnv() });
  return r.status === 0 && (r.stdout?.toString() ?? "").split("\n").includes(name);
}

/** The recovery, spelled out. Pure, so it's testable; paw never runs it itself — moving sockets under
 *  a live fleet is the operator's call, and the command is short enough to read before running. */
export function tmuxSplitAdvice(name: string, split: { agentServer: number; socketServer?: number; socketPath?: string }): string {
  const path = split.socketPath ?? "/private/tmp/tmux-$(id -u)/default";
  const aside = `${path}-${split.socketServer ?? "new"}`;
  return [
    `  ${name} is still running — in tmux server ${split.agentServer}, which lost its socket: the path now belongs to ${split.socketServer ? `server ${split.socketServer}` : "another server"}, so no tmux command (or paw) can reach it.`,
    `  every agent that server runs is in the same state: live on the mesh, marked exited by the manager.`,
    `  recover — move the newer server's socket aside, then have ${split.agentServer} recreate its own:`,
    `    mv ${path} ${aside} && kill -USR1 ${split.agentServer}`,
    `  agents started in the newer server stay reachable with:  tmux -S ${aside} attach`,
  ].join("\n");
}

function plainTmuxEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.TMUX_TMPDIR;
  delete env.TMUX;
  return env;
}

/** The tmux session the manager opens per space (manager.ts: `cotal-${space}`). */
export function tmuxSession(space: string): string {
  return `cotal-${space}`;
}

/**
 * Attach to a tmux-runtime agent's window. Selects `<session>:<name>` first (so the attach lands on
 * that agent, not whatever window was last active), then attaches — `switch-client` when already
 * inside tmux (attach-session refuses to nest), `attach-session` otherwise. Fails loud with the
 * manual command when tmux isn't reachable or the window is gone.
 */
export function attachTmux(space: string, name: string): void {
  const session = tmuxSession(space);
  const target = `${session}:${name}`;
  const inside = !!process.env.TMUX?.trim();
  const verb = inside ? "switch-client" : "attach-session";

  // The manager pins its tmux server to the STANDARD default socket (lifecycle.defaultTmuxEnv strips
  // $TMUX/$TMUX_TMPDIR), so from a plain shell we must resolve tmux the same way — else a stray
  // TMUX_TMPDIR in the operator's env would send us to an empty socket ("no server running"). When
  // the operator is already INSIDE tmux we keep their ambient env: switch-client needs their real
  // client on the (default) server the manager also uses.
  let env: NodeJS.ProcessEnv = process.env;
  if (!inside) {
    env = { ...process.env };
    delete env.TMUX_TMPDIR;
  }

  // Point the session at the agent's window. A missing window is a real error — don't silently
  // attach to some other agent's window.
  const sel = spawnSync("tmux", ["select-window", "-t", target], { stdio: ["ignore", "ignore", "pipe"], env });
  if (sel.status !== 0) {
    const why = sel.stderr?.toString().trim() || `no tmux window "${name}" in ${session}`;
    throw new Error(`paw: can't find "${name}" in tmux (${why}). Is it running? \`paw status ${name}\``);
  }

  const res = spawnSync("tmux", [verb, "-t", session], { stdio: "inherit", env });
  if (res.error) {
    throw new Error(
      `paw: tmux ${verb} failed — ${res.error.message}. Attach manually: ` +
        `tmux attach-session -t ${session} \\; select-window -t ${target}`,
    );
  }
}

/**
 * Press Enter in an agent's tmux window — clearing claude's one-time dev-channels confirmation.
 *
 * cotal's tmux runtime already schedules this, but only at 1s…5s after the window opens. A cold claude
 * on a loaded machine does not reach the prompt within five seconds, so every Enter lands BEFORE the
 * question exists and the agent then sits at it indefinitely: `cotal-endpoint-telegram` hung ~90s with
 * no mesh presence until a human pressed Enter, and it reads exactly like a failed spawn (2026-08-17).
 *
 * So paw nudges again while it is ALREADY waiting for the agent to reach the mesh — the window where
 * the prompt actually appears. Harmless if there is no prompt: Enter at an idle claude prompt submits
 * nothing. Best-effort and never throws — a missing window or a tmux that isn't running must not turn
 * a spawn into an error.
 */
export function nudgeTmuxConfirm(space: string, name: string, env: NodeJS.ProcessEnv): void {
  try {
    execFileSync("tmux", ["send-keys", "-t", `${tmuxSession(space)}:${name}`, "Enter"], {
      stdio: "ignore",
      timeout: 2000,
      env,
    });
  } catch {
    /* no window, no tmux, no session — none of which is a spawn failure */
  }
}
