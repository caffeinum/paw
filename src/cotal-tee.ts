/**
 * Run a cotal subprocess with stdin/stdout inherited (tty, raw mode and colour untouched — cotal
 * decides colour on stdout) and stderr forwarded LIVE while paw keeps a copy, so a refusal cotal
 * printed can be explained after it exits (see src/contract-mismatch.ts).
 */
import { spawn, spawnSync } from "node:child_process";

const KEEP = 256 * 1024;

export type TeedExit = { status: number | null; signal: NodeJS.Signals | null; stderr: string };

export function runTeed(exec: string, args: string[], opts: { cwd?: string } = {}): Promise<TeedExit> {
  return new Promise((resolve, reject) => {
    const child = spawn(exec, args, { stdio: ["inherit", "inherit", "pipe"], ...(opts.cwd ? { cwd: opts.cwd } : {}) });
    let kept = "";
    child.stderr.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
      kept = (kept + chunk.toString("utf8")).slice(-KEEP);
    });
    child.on("error", reject);
    child.on("close", (status, signal) => resolve({ status, signal, stderr: kept }));
  });
}

/** cotal verbs whose refusal can be a manager contract mismatch (they scatter or locate a seat), and
 *  that print no TUI on stderr — so teeing it is safe. Every other passthrough stays fully inherited. */
const MISMATCH_VERBS = new Set(["ps", "slots", "inspect", "attach", "stop", "input"]);

/** `paw cotal <verb>`: run cotal; for a {@link MISMATCH_VERBS} verb, follow a contract-mismatch refusal
 *  with paw's one-line explanation. Returns the exit status to exit with. */
export async function runCotalPassthrough(
  verb: string,
  exec: string,
  args: string[],
  o: { cwd?: string; space?: string; remote: boolean },
): Promise<number> {
  if (!MISMATCH_VERBS.has(verb) || !o.space) {
    const res = spawnSync(exec, args, { stdio: "inherit", ...(o.cwd ? { cwd: o.cwd } : {}) });
    if (res.error) throw new Error(`paw: couldn't run cotal ${verb}: ${res.error.message}`);
    return res.status ?? 1;
  }
  const r = await runTeed(exec, args, o.cwd ? { cwd: o.cwd } : {});
  const { contractMismatchHint, mentionsMismatch } = await import("./contract-mismatch.ts");
  if (mentionsMismatch(r.stderr)) {
    const localInstanceId = o.remote ? (await import("./hosted.ts")).localManagerInstanceId(o.space) : undefined;
    const hint = contractMismatchHint({ space: o.space, text: r.stderr, remote: o.remote, ...(localInstanceId ? { localInstanceId } : {}) });
    if (hint) process.stderr.write(`${hint}\n`);
  }
  return r.status ?? 1;
}
