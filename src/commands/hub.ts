/**
 * `paw hub [on|off]` — the cotal hub's mode for a space, as a STICKY choice (src/hub/paths.ts).
 *
 *   paw hub        — show the mode, where it came from, and the hub's health.
 *   paw hub on     — write the mode, then bring the hub up. New spawns use it; agents already
 *                    running keep their own `node mcp.cjs` until they next restart.
 *   paw hub off    — write the mode. New spawns go back to `node mcp.cjs`; the hub keeps running
 *                    while any agent is still on a shim (stopping it would take their tools away)
 *                    and stops itself here once none is.
 *
 * Like `paw runtime`, this is the ONLY thing that switches: an ordinary ensure() never bounces an
 * agent over a mode mismatch (commit 802ad0d's rule) — it starts a hub that should be running and
 * never stops one. `PAW_COTAL_HUB=1|0` stays a transient override for one process tree.
 */
import { registry, type Command } from "@cotal-ai/core";
import { ensure, formatHubLine, hubShimProcs, hubState, resolveSpace, stopHub } from "../lifecycle.ts";
import { hubModeFile, writeHubMode } from "../hub/paths.ts";

function parse(argv: string[]): { mode?: "on" | "off"; space?: string } {
  const out: { mode?: "on" | "off"; space?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--space") out.space = argv[++i];
    else if (a === "on" || a === "off") {
      if (out.mode) throw new Error(`paw hub: one mode at a time (got ${out.mode} and ${a})`);
      out.mode = a;
    } else throw new Error(`paw hub: unknown argument "${a}" — usage: paw hub [on|off]`);
  }
  return out;
}

async function hub(argv: string[]): Promise<void> {
  const { mode, space: spaceArg } = parse(argv);
  const space = spaceArg ?? resolveSpace();
  if (process.env.PAW_COTAL_HUB?.trim() && mode)
    console.error(`paw: note — PAW_COTAL_HUB=${process.env.PAW_COTAL_HUB} overrides the sticky mode in THIS shell's processes`);
  if (mode === "on") {
    writeHubMode(space, "on");
    await ensure({ needMesh: true, space }); // starts the hub under the space lock (the mode is on now)
    console.log(`cotal hub ON for space ${space} (sticky). New agents use it; running ones switch at their next restart (\`paw restart <name>\`, or \`paw restart\` for all).`);
  } else if (mode === "off") {
    writeHubMode(space, "off");
    const shims = hubShimProcs(space).length;
    if (shims > 0)
      console.log(`cotal hub OFF for space ${space} (sticky). New agents use their own mcp.cjs; the hub keeps serving the ${shims} agent${shims === 1 ? "" : "s"} still on it — restart them, then \`paw hub off\` again to stop it.`);
    else {
      await stopHub(space);
      console.log(`cotal hub OFF for space ${space} (sticky); no agent was on it, so it is stopped.`);
    }
  }
  const h = await hubState(space);
  const file = hubModeFile(space);
  console.log(
    formatHubLine(h) ??
      `cotal hub: off${file === "garbage" ? " (mode file unreadable/garbage → treated as off)" : file ? "" : " (default)"} · not running`,
  );
}

const hubCommand: Command = {
  kind: "command",
  name: "hub",
  group: "Mesh",
  summary: "cotal hub mode (one MCP process for every agent): show, or switch it on/off for the space",
  usage: "hub [on|off] [--space s]",
  run: (a) => hub([...a.raw]),
};
registry.register(hubCommand);
