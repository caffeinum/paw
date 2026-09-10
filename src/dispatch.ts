/**
 * paw's CLI dispatch helpers — pure + unit-tested so routing regressions can't slip through.
 *
 * The endpoint-native rewrite shrank this to two helpers: every paw verb is now a paw-owned
 * command (no upstream verb renames to alias over, no flags-only cotal `stop` to positional-ize,
 * and there IS no top-level `send` to footgun — bin/paw.ts errors on it with a pointer instead).
 *
 * withDefaultSpace injects paw's default --space so the operator never types it. stripCotalNamespace
 * peels the `paw cotal <cmd>` escape-hatch prefix so bin can route the remainder to the cotald
 * subprocess.
 */

/**
 * `paw cotal <cmd> …` → strip the namespace word; bin spawns the remainder against bin/cotald.ts
 * (the raw cotal CLI composition root) as a subprocess. Stripping happens FIRST so the passthrough
 * still gets mesh gating + --space injection. Pure, so check:dispatch covers it.
 */
export function stripCotalNamespace(argv: string[]): string[] {
  return argv[0] === "cotal" ? argv.slice(1) : argv;
}

/**
 * Append `--space <space>` as a TRAILING flag (parseArgs collects flags from anywhere, so a command
 * that reads its subcommand from the FIRST positional — e.g. cotal's `history clear` via the
 * passthrough — still sees it; injecting at the front would shadow that subcommand). Skip injection
 * only when the operator passed a REAL `--space` flag — a `--space` token that has a following
 * value, or `--space=…` — never a bare `--space` word sitting as the final token of a message body.
 */
export function withDefaultSpace(argv: string[], space: string): string[] {
  // A `--` terminator ends PAW's arguments: everything after it belongs to something else (the MCP
  // server's own command line in `paw mcp add x -- npx -y pkg`). Appending to the very end put paw's
  // `--space paw` INSIDE that command — the server was configured to run `npx -y pkg --space paw`,
  // silently, which is precisely the leak the terminator exists to prevent. So the injection goes
  // BEFORE the terminator, and an operator `--space` is only recognised before it too: one written
  // after `--` is the child's argument, not an answer to paw's question.
  const end = argv.indexOf("--");
  const mine = end === -1 ? argv : argv.slice(0, end);
  const operatorPassedSpace = mine.some(
    (a, i) => (a === "--space" && i < mine.length - 1) || a.startsWith("--space="),
  );
  if (operatorPassedSpace) return argv;
  return end === -1 ? [...argv, "--space", space] : [...argv.slice(0, end), "--space", space, ...argv.slice(end)];
}

/**
 * Expand `--space=<v>` / `--server=<v>` into their two-token forms. withDefaultSpace recognizes
 * the `=` form as operator-provided (and skips injecting), but every paw command's hand parser
 * reads only the two-token form — without this, `paw ps --space=main` would pass the injection
 * skip and then be rejected by the command. Only these two flags: never touch positionals or
 * message bodies. Pure, so check:dispatch covers it.
 */
export function expandEqFlags(argv: string[]): string[] {
  return argv.flatMap((a) => {
    for (const flag of ["--space", "--server"]) {
      if (a.startsWith(flag + "=")) return [flag, a.slice(flag.length + 1)];
    }
    return [a];
  });
}
