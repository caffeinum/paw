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
    throw new Error(`paw: can't find "${name}" in tmux (${why}). Is it running? \`paw ps\``);
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
