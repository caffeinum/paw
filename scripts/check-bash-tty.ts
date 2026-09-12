// `!cmd` in `paw chat` must not kill the chat's own terminal (2026-09-11).
//
// The bug: `paw chat` reads its tty through readline in raw mode; running the operator's shell
// INTERACTIVELY (`$SHELL -ic`, so aliases from .zshrc resolve) with that tty inherited made zsh's
// job-control init act on the terminal, and readline's next read failed with `EIO: i/o error, read`
// — every `!gs`, first try, under a real pty. The fix detaches the child into its own session. This
// check reproduces the exact shape: a child process under node-pty that raw-reads its stdin while
// `runBash(…, interactive=true)` runs a real `$SHELL -ic`, with keystrokes arriving throughout.
// Skipped (with a note) when $SHELL isn't zsh/bash, since the interactive path is a no-op then.
import { spawn as ptySpawn } from "@lydell/node-pty";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

if (process.argv.includes("--child")) {
  const { runBash } = await import("../src/bash.js");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  let typed = 0;
  process.stdin.on("data", (d) => (typed += d.length));
  process.stdin.on("error", (e: NodeJS.ErrnoException) => {
    process.stdout.write(`\nSTDIN_ERROR ${e.code} ${e.syscall}\n`);
    process.exit(3);
  });
  for (let i = 1; i <= 2; i++) {
    const r = await runBash("echo bang-ok", process.cwd(), 20000, true);
    process.stdout.write(`\nRUN${i} code=${r.code} timedOut=${r.timedOut} out=${r.output.trim().replace(/\n/g, "|")}\n`);
  }
  process.stdout.write(`\nTYPED=${typed}\nCHILD_DONE\n`);
  process.exit(0);
}

if (!/\/(zsh|bash)$/.test(process.env.SHELL ?? "")) {
  console.log(`check:bash-tty — skipped: $SHELL is ${process.env.SHELL ?? "unset"}, the interactive path is a plain /bin/sh -c`);
  process.exit(0);
}

const tsx = resolve(here, "../node_modules/tsx/dist/cli.mjs");
const p = ptySpawn(process.execPath, [tsx, fileURLToPath(import.meta.url), "--child"], {
  name: "xterm-256color",
  cols: 100,
  rows: 30,
  cwd: resolve(here, ".."),
  env: process.env as Record<string, string>,
});
let buf = "";
p.onData((d) => (buf += d));
const poke = setInterval(() => p.write("x"), 200); // an operator typing while the command runs
const exitCode = await new Promise<number>((res) => p.onExit(({ exitCode }) => res(exitCode)));
clearInterval(poke);
const plain = buf.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
const lines = plain.split(/\r?\n/).filter((l) => /^(RUN\d|STDIN_ERROR|TYPED=|CHILD_DONE)/.test(l));

let fails = 0;
const assert = (ok: boolean, msg: string) => {
  console.log(`${ok ? "✓" : "✗"} ${msg}`);
  if (!ok) fails++;
};
assert(!plain.includes("STDIN_ERROR"), "the chat's own tty read survives an interactive `$SHELL -ic` (no EIO)");
assert(exitCode === 0 && lines.includes("CHILD_DONE"), `the child finished cleanly (exit ${exitCode})`);
assert(lines.filter((l) => /^RUN\d code=0 timedOut=false out=bang-ok$/.test(l)).length === 2, "both interactive runs returned the command's output with exit 0 and no rc noise");
const typed = Number((lines.find((l) => l.startsWith("TYPED=")) ?? "TYPED=0").slice(6));
assert(typed > 0, `keystrokes kept flowing to the chat while the shell ran (${typed} bytes)`);
if (fails) {
  console.log("--- child output ---\n" + plain.slice(-2000));
  process.exit(1);
}
console.log("check:bash-tty ok");
