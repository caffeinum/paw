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

/** What a booting claude's terminal is showing, as far as paw may act on it. */
export type StartupScreen =
  | { kind: "dev-channels" }
  /** `keys` moves the cursor onto "Yes, I trust this folder" and confirms; undefined when the
   *  dialog didn't parse (no cursor, no Yes line) — then paw presses nothing. */
  | { kind: "trust"; keys?: string[] }
  | { kind: "other"; prompt: boolean };

const TRUST_YES = /Yes, I trust this folder/;
const CURSOR = /^\s*[❯>]/;

/**
 * Classify a captured pane. Pure; exported for check:trust. The dev-channels gate is claude's
 * "WARNING: Loading development channels" (the connector's own `confirm` text); the trust dialog is
 * the "Yes, I trust this folder" menu, whose DEFAULT is "No, exit" — an Enter there quits claude.
 * `prompt` marks an unrecognised screen that is waiting on a keypress, worth logging.
 */
export function classifyStartupScreen(text: string): StartupScreen {
  if (/Loading development channels/.test(text)) return { kind: "dev-channels" };
  const lines = text.split("\n");
  const yes = lines.findIndex((l) => TRUST_YES.test(l));
  if (yes >= 0) {
    // The menu's option lines run from the first option to the last; the cursor is the one marked ❯.
    const cursor = lines.findIndex((l, i) => CURSOR.test(l) && Math.abs(i - yes) <= 6);
    if (cursor < 0) return { kind: "trust" };
    const delta = yes - cursor;
    const move = Array.from({ length: Math.abs(delta) }, () => (delta > 0 ? "Down" : "Up"));
    return { kind: "trust", keys: [...move, "Enter"] };
  }
  return { kind: "other", prompt: /Enter to confirm|Esc to cancel|\(y\/n\)|\[Y\/n\]/i.test(text) };
}

/**
 * Answer claude's startup prompts in an agent's tmux window — by READING the window first.
 *
 * cotal's tmux runtime presses Enter at the dev-channels gate only 1s…5s after the window opens, and a
 * cold claude on a loaded machine reaches it later, so paw answers while it waits for the agent to
 * reach the mesh (`cotal-endpoint-telegram` hung ~90s until a human pressed Enter, 2026-08-17).
 *
 * This USED to be a blind Enter on every poll, and that was a bug with a body count: when the folder's
 * trust entry had been erased from ~/.claude.json (a concurrent claude rewrite), claude showed its
 * trust dialog, whose default is "No, exit" — the blind Enter chose it and the agent quit before it
 * ever reached MCP (reproduced against a real claude: exit 1). So now:
 *   - the dev-channels gate → Enter;
 *   - the trust dialog → ONLY when `trust()` says paw itself trusts this folder (it re-writes the
 *     entry first), move the cursor to "Yes, I trust this folder" and confirm; otherwise nothing;
 *   - anything else → nothing.
 * Returns what it saw (and the screen text) so the caller can name it if the boot never completes.
 * Best-effort, never throws: a missing window or tmux is not a spawn failure.
 */
export function answerStartupPrompt(
  space: string,
  name: string,
  env: NodeJS.ProcessEnv,
  trust: () => boolean,
): { screen: StartupScreen; text: string; sent?: string[] } | undefined {
  const target = `${tmuxSession(space)}:${name}`;
  const cap = spawnSync("tmux", ["capture-pane", "-p", "-t", target], { encoding: "utf8", timeout: 2000, env });
  if (cap.status !== 0 || typeof cap.stdout !== "string") return undefined;
  const text = cap.stdout;
  const screen = classifyStartupScreen(text);
  let keys: string[] | undefined;
  if (screen.kind === "dev-channels") keys = ["Enter"];
  else if (screen.kind === "trust" && screen.keys && trust()) keys = screen.keys;
  // One key per send-keys, a beat apart: a menu redraws between keystrokes, and a single burst of
  // "Down Enter" can reach a TUI as one chunk it doesn't split.
  for (const [i, k] of (keys ?? []).entries()) {
    if (i) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
    spawnSync("tmux", ["send-keys", "-t", target, k], { stdio: "ignore", timeout: 2000, env });
  }
  return { screen, text, sent: keys };
}
