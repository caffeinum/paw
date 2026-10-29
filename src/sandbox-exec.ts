/**
 * Running things INSIDE a sandboxed agent's VM from the host: `!cmd` in `paw chat` / `paw web`, and
 * `paw sandbox shell`. A `sandbox: container` agent's tools (`npm i -g neonctl` → its home's ~/.local/bin),
 * its `~/.env` and its PATH exist only in the VM — a host shell in its folder finds none of them (seen live:
 * `!neon auth login` → `zsh:1: command not found: neon`). So for such an agent the command goes through
 * `container exec -w <folder> <live id> … bash -lc <command>`, the command one argv element; the VM's env
 * (HOME, PATH, BASH_ENV → ~/.env) is the container's own, which `container exec` inherits (verified, 1.6.0).
 * Its container not running fails loud — falling back to the host is exactly the bug. docs/notes/sandbox.md.
 */
import { BASH_TIMEOUT_MS, runArgv, runBash, type BashResult } from "./bash.ts";
import { personaFilePath } from "./addressing.ts";
import { containerBin, listSandboxContainers } from "./sandbox.ts";
import { readSandbox } from "./session.ts";

/** Where `!cmd` runs for this agent: the host, or its VM (the running container's id). */
export type BangPlace = { kind: "host" } | { kind: "vm"; container: string; space: string; name: string };

/** An in-VM `!cmd` may run 5 min, not the host's 60s: the motivating case, `!neon auth login`, prints a URL and
 *  waits while you finish OAuth in the browser. Longer or truly interactive → `paw sandbox shell`. */
export const SANDBOX_BASH_TIMEOUT_MS = 5 * 60_000;

/** Appended to a timed-out VM bang's output (so the chat, the web result and the agent's DM all carry it). */
export function vmTimeoutHint(place: { space: string; name: string }, timeoutMs: number): string {
  return `paw: timed out after ${Math.round(timeoutMs / 1000)}s in ${place.name}'s VM — long/interactive? use \`paw sandbox shell ${place.name}#${place.space}\``;
}

/** The agent's ONE running paw container (labels paw.space/paw.agent). None or several fail loud. */
export function liveSandboxContainer(space: string, name: string, bin: string = containerBin()): string {
  const mine = listSandboxContainers(bin).filter((c) => c.space === space && c.agent === name);
  const running = mine.filter((c) => c.state === "running");
  if (running.length === 1) return running[0].id;
  if (!running.length)
    throw new Error(
      `paw: "${name}" is sandboxed (sandbox: container) and its VM is not running${mine.length ? ` (${mine.map((c) => `${c.id}: ${c.state}`).join(", ")})` : ""} — ` +
        `its tools live only in the VM, so the command was NOT run on this machine instead. \`paw start ${name}#${space}\`, then retry`,
    );
  throw new Error(`paw: "${name}" has ${running.length} running containers (${running.map((c) => c.id).join(", ")}) — refusing to guess which VM to run in; \`paw sandbox ls\``);
}

/** Host for an ordinary agent; the live VM for a sandboxed one (which throws if it isn't running). */
export function bangPlace(space: string, name: string, bin?: string): BangPlace {
  if (!readSandbox(personaFilePath(space, name))) return { kind: "host" };
  return { kind: "vm", container: liveSandboxContainer(space, name, bin ?? containerBin()), space, name };
}

/** `container exec` argv for one `!cmd`: the folder via `-w` (it is mounted at the same path), a login bash
 *  so the VM's profile + BASH_ENV apply, and `command` as ONE element — never spliced into a host shell line.
 *  `timeout -s KILL` (its own process group) because killing the `container exec` CLI does NOT stop the
 *  process in the VM (verified) — without it a timed-out `sleep`/login would run on forever. */
export function sandboxBashArgv(container: string, cwd: string, command: string, timeoutMs = SANDBOX_BASH_TIMEOUT_MS): string[] {
  return ["exec", "-w", cwd, container, "timeout", "-s", "KILL", String(Math.max(1, Math.ceil(timeoutMs / 1000))), "bash", "-lc", command];
}

/** `container exec` argv for an interactive login shell in the agent's folder (`paw sandbox shell`). */
export function sandboxShellArgv(container: string, cwd: string): string[] {
  return ["exec", "-i", "-t", "-w", cwd, container, "bash", "-l"];
}

/** Where a `!cmd` ran, for the line echoed above its output. */
export function bangWhere(name: string, cwd: string, place: BangPlace): string {
  return place.kind === "vm" ? `in ${name}'s VM: ${cwd}` : `in ${cwd}`;
}

/** Run `command` where `place` says. The host path is {@link runBash}, unchanged; the VM path is the same
 *  detached runner over `container exec`, streaming through `onOutput` the same way. Never throws. */
export async function runBang(
  command: string,
  cwd: string,
  place: BangPlace,
  o: { timeoutMs?: number; interactive?: boolean; onOutput?: (chunk: string) => void; bin?: string } = {},
): Promise<BashResult> {
  if (place.kind === "host") return runBash(command, cwd, o.timeoutMs ?? BASH_TIMEOUT_MS, o.interactive ?? false, o.onOutput);
  const timeoutMs = o.timeoutMs ?? SANDBOX_BASH_TIMEOUT_MS;
  const bin = o.bin ?? containerBin();
  // The host-side timer is a backstop a little after the in-VM `timeout`, so the VM's own kill reports first.
  const r = await runArgv(bin, sandboxBashArgv(place.container, cwd, command, timeoutMs), { command, cwd, timeoutMs: timeoutMs + 5_000, onOutput: o.onOutput, label: `${bin} exec` });
  // `timeout -s KILL` exits 137 when it fired — that is a timeout, not the command's own exit status.
  const timedOut = r.timedOut || r.code === 137;
  if (!timedOut) return { ...r, vm: place.container };
  const hint = vmTimeoutHint(place, timeoutMs);
  o.onOutput?.(`\n${hint}\n`);
  return { ...r, vm: place.container, code: null, timedOut: true, timeoutMs, output: `${r.output.replace(/\n?$/, "\n")}${hint}\n` };
}
