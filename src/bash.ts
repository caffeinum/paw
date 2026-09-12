/**
 * `!<command>` from the web composer: run a shell command in an AGENT'S FOLDER, then hand the agent
 * both the command and its output.
 *
 * WHY it hands the result to the agent rather than just printing it: the point isn't a terminal in a
 * browser — you have terminals. It is that `!git log --oneline -5` puts the answer in front of the
 * agent as context, so the next thing you ask is grounded in what the repo actually says instead of
 * what the agent last saw. Running it and keeping it to yourself would be the less useful half.
 *
 * ON THE SECURITY OF THIS, plainly: it is arbitrary code execution reachable from a page. What makes it
 * consistent rather than reckless is that `paw web` ALREADY exposes `POST /api/dm`, and a paw agent runs
 * with `bypassPermissions` — so anything that can reach this daemon can already ask an agent to run
 * whatever it likes. This adds directness, not capability, and it inherits the same and only defences:
 * a loopback bind, an exact-match Origin, and a Host check. It is not a boundary and must never be
 * described as one.
 *
 * The command runs through a shell ON PURPOSE — pipes and redirection are most of why you'd type `!` —
 * so nothing here may ever be assembled from anything but what the operator typed.
 */
import { spawn } from "node:child_process";
import { bdEnv } from "./tasks.js";

/** How long a command may run before it is killed. Long enough for a build step to say something,
 *  short enough that a hung command doesn't wedge the browser waiting on a reply. */
export const BASH_TIMEOUT_MS = 60_000;

/** Cap on captured output. A command that prints a gigabyte would otherwise become a message that
 *  hangs the renderer and a DM nothing can deliver. */
export const BASH_MAX_BYTES = 256 * 1024;

export interface BashResult {
  command: string;
  cwd: string;
  /** stdout and stderr, interleaved as the operator would see them in a terminal. */
  output: string;
  /** Process exit code; null when it was killed (timeout). */
  code: number | null;
  /** True when the command hit {@link BASH_TIMEOUT_MS} and was killed. */
  timedOut: boolean;
}

/** Is this line the bang form, and what is the command? Undefined when it isn't — a line merely
 *  CONTAINING a `!` is ordinary prose, so only a leading one counts. Pure. */
export function parseBang(line: string): string | undefined {
  const m = /^!(.*)$/s.exec(line);
  if (!m) return undefined;
  const cmd = m[1].trim();
  return cmd.length ? cmd : undefined;
}

/**
 * How to invoke the command so it sees the OPERATOR'S environment, not a bare `/bin/sh`.
 *
 * Reported live (2026-09-09): `!preview` → "command not found" — `preview` is an alias/function/PATH
 * addition defined in the operator's shell rc, and `/bin/sh -c` sources no rc at all, so none of it
 * exists. In `paw chat` the process IS the operator's (their shell exported the env), so running the
 * command through their own shell INTERACTIVELY (`$SHELL -ic`) loads `.zshrc`/`.bashrc` and gives back
 * their aliases, functions and PATH. `-i` matters: zsh/bash only source the interactive rc (where
 * aliases live) for an interactive shell; stdin is closed so it can't hang waiting for input.
 *
 * Gated on `interactive` (a real terminal, i.e. `paw chat`'s `!`): only zsh/bash then get `-ic` so
 * `.zshrc`/`.bashrc` (aliases, functions) load. A non-interactive caller (the `paw web` daemon, tests)
 * stays on `/bin/sh -c` — safe, fast, and never hanging on rc that needs a tty. Pure; shell injectable.
 */
export function shellInvocation(command: string, interactive: boolean, shell = process.env.SHELL): { sh: string; args: string[] } {
  // ONLY the interactive path (a real terminal — `paw chat`'s `!`) sources the operator's rc via `-ic`;
  // a non-tty caller (the `paw web` daemon, the tests) stays on a bare `/bin/sh -c`, because an
  // interactive shell with no controlling tty can hang or misbehave sourcing rc that guards on
  // interactivity — and the daemon's rc wouldn't be the operator's anyway.
  if (interactive && shell && /\/(zsh|bash)$/.test(shell)) return { sh: shell, args: ["-ic", command] };
  return { sh: "/bin/sh", args: ["-c", command] };
}

/**
 * An rc sourced by `-i` with no terminal trips on its own `setopt zle` (zsh refuses to enable the line
 * editor without a tty) and prints this per call. It is an artifact of HOW paw runs the shell, not
 * output of the operator's command, and their real shell never shows it — so it is dropped, and only
 * this exact line. Pure; unit-tested.
 */
export function stripRcNoise(stderr: string): string {
  return stderr
    .split("\n")
    .filter((l) => !/^\(eval\):\d+: can't change option: zle$/.test(l))
    .join("\n");
}

/**
 * Run `command` in `cwd`. Never throws: a failing command is a RESULT — its exit code and stderr are
 * exactly what the operator asked to see — not an exception for the route to turn into a 500.
 *
 * The child is DETACHED (its own session, no controlling tty) with stdin closed — load-bearing for the
 * interactive path, and measured (2026-09-11, `!gs` in `paw chat`): an interactive zsh that INHERITS
 * paw chat's tty initialises job control against it, and readline's next read on that tty fails with
 * `EIO: i/o error, read` — the chat died on the first `!` every time under a real pty. `setsid` gives
 * the shell no terminal to touch; readline's tty is untouched. Closing stdin is what makes "can't hang
 * waiting for input" true (a pipe left open never reaches EOF). A timeout kills the whole PROCESS GROUP
 * — with its own session the shell's children are no longer in ours, so killing the pid alone would
 * leave a `sleep`/build running.
 */
export async function runBash(command: string, cwd: string, timeoutMs = BASH_TIMEOUT_MS, interactive = false): Promise<BashResult> {
  return new Promise((resolve) => {
    // bdEnv, not process.env: `!bd create …` from the composer must hit the SAME shared task db the
    // agents' BEADS_DIR pins — without it bd resolves a repo-local .beads and the task lands in that
    // project's own tracker, invisibly. It also backfills PATH for the launchd-started daemon.
    const { sh, args } = shellInvocation(command, interactive);
    const child = spawn(sh, args, { cwd, env: bdEnv(), detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let done = false;
    const cap = (s: string, d: Buffer) => (s.length > BASH_MAX_BYTES ? s : s + d.toString());
    child.stdout.on("data", (d: Buffer) => (stdout = cap(stdout, d)));
    child.stderr.on("data", (d: Buffer) => (stderr = cap(stderr, d)));
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    }, timeoutMs);
    const finish = (code: number | null, spawnError?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const err = interactive ? stripRcNoise(stderr) : stderr;
      const both = `${stdout}${err}${spawnError ? `${spawnError}\n` : ""}`;
      resolve({
        command,
        cwd,
        output: both.length > BASH_MAX_BYTES ? `${both.slice(0, BASH_MAX_BYTES)}\n… output truncated` : both,
        // a killed or unspawnable command has no exit status — null, never a signal name or errno
        // rendered as though the command had exited with it
        code: timedOut ? null : code,
        timedOut,
      });
    };
    child.on("error", (e: NodeJS.ErrnoException) => finish(null, `paw: could not run ${sh}: ${e.message}`));
    child.on("close", (code) => finish(code));
  });
}

/**
 * The message the agent receives.
 *
 * Shaped like a terminal transcript because that is the form an agent reads most reliably — the command
 * on a `$` line, the output beneath, fenced so a stray backtick in the output can't reflow the rest of
 * the message. The cwd is stated because the same command means different things in different folders,
 * and the agent is being told about a shell it did not run.
 */
export function bashMessage(r: BashResult): string {
  const status = r.timedOut
    ? ` (timed out after ${Math.round(BASH_TIMEOUT_MS / 1000)}s)`
    : r.code === 0 || r.code === null
      ? ""
      : ` (exit ${r.code})`;
  const body = r.output.trim() || "(no output)";
  return [`I ran this in ${r.cwd}${status}:`, "```console", `$ ${r.command}`, body, "```"].join("\n");
}
