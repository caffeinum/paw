/**
 * `paw unstick <name|folder> [--force] [--space s]` — interrupt the tool an agent is stuck inside, by
 * pressing Esc in its tmux pane (src/unstick.ts). The session survives and its queued DMs drain; this is
 * never a restart. Refuses unless the agent is live on the tmux runtime and its transcript shows a tool
 * call still running (`--force` sends the Esc anyway), prints the evidence before acting, and reports
 * what the transcript shows afterwards — interrupted, or still stuck.
 */
import { DEFAULT_SERVER, registry, type Command } from "@cotal-ai/core";
import { personaFilePath, psRowAlive, type PsRow } from "../addressing.js";
import { withManagerControl } from "../control.js";
import { readForeground } from "../foreground.js";
import { actualManagerRuntime, resolveSpace } from "../lifecycle.js";
import { readResumeId } from "../session.js";
import { ago, readTurnState, toolLabel } from "../status.js";
import { interruptTool, sendEscape } from "../unstick.js";
import { resolveStopName } from "./stop.js";

export function parseUnstickArgs(argv: string[]): { space?: string; target: string; force: boolean } {
  let space: string | undefined;
  let target: string | undefined;
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--space") {
      space = argv[++i];
      if (space === undefined) throw new Error("paw: --space needs a value");
    } else if (a === "--force") force = true;
    else if (a.startsWith("-")) throw new Error(`paw: unknown flag "${a}" — unstick <name|folder> [--force] [--space s]`);
    else if (target !== undefined) throw new Error("paw: unstick takes one agent");
    else target = a;
  }
  if (!target) throw new Error("paw: usage — unstick <name|folder> [--force] [--space s]");
  return { space, target, force };
}

async function unstick(argv: string[]): Promise<void> {
  const { space: spaceArg, target, force } = parseUnstickArgs(argv);
  const space = spaceArg ?? resolveSpace();
  const name = resolveStopName(space, target);

  if (readForeground(space, name)) {
    throw new Error(`paw: "${name}" runs as a foreground claude in another terminal — press Esc there; paw has no pane to type into`);
  }
  const row = await withManagerControl(space, DEFAULT_SERVER, async (ctl) => {
    const ps = await ctl.ps();
    if (!ps.ok) throw new Error(`paw: manager isn't answering (${ps.error ?? "no reply"})`);
    return ((ps.data as PsRow[]) ?? []).find((r) => r.name === name);
  });
  if (!row || !psRowAlive(row)) throw new Error(`paw: "${name}" isn't live — nothing is running to interrupt (\`paw status\`)`);
  const runtime = actualManagerRuntime(space);
  if (runtime !== "tmux") {
    throw new Error(
      `paw: "${name}" runs under the ${runtime ?? "unknown"} runtime — unstick needs tmux, the only runtime with a pane paw can send Esc to ` +
        `(pty seats have no reachable terminal; cmux tabs belong to the app). \`paw runtime tmux\` switches.`,
    );
  }

  const pin = readResumeId(personaFilePath(space, name));
  const state = pin ? readTurnState(pin) : undefined;
  const tool = state?.inFlight ? state.tool : undefined;
  const now = Date.now();

  if (!tool) {
    const why = !pin
      ? "it has no pinned session, so its transcript can't be read"
      : state === undefined
        ? "its transcript can't be read"
        : state.inFlight === false
          ? "its last turn has finished"
          : state.inFlight === undefined
            ? "its transcript shows no turn markers"
            : "its running turn has no unanswered tool call";
    if (!force) throw new Error(`paw: "${name}" isn't inside a tool — ${why}. \`--force\` sends Esc anyway.`);
    console.log(`paw: "${name}" isn't inside a tool (${why}) — sending Esc anyway (--force)`);
    sendEscape(space, name);
    console.log(`✓ Esc sent to ${name} (nothing to verify against)`);
    return;
  }

  const age = tool.startedMs !== undefined ? ago(tool.startedMs, now) : "unknown time";
  console.log(`${name}: inside ${toolLabel(tool)} — running ${age} (tool_use ${tool.id})`);
  console.log(`  sending Esc to tmux ${`cotal-${space}`}:${name} …`);
  const outcome = await interruptTool(space, name, pin!, tool);
  if (!outcome.interrupted) {
    throw new Error(
      `paw: sent Esc, but "${name}" is still inside ${tool.name} after ${Math.round(outcome.afterMs / 1000)}s — no result recorded for ${tool.id}. ` +
        `\`paw attach ${name}\` to look; \`paw restart ${name}\` is the heavier fix.`,
    );
  }
  const r = outcome.result;
  const flag = r.interrupted === true ? "interrupted" : r.isError ? "ended with an error" : "returned";
  const first = r.text.split("\n").find((l) => l.trim()) ?? "";
  console.log(`✓ ${name}: ${tool.name} ${flag} ${Math.round(outcome.afterMs / 100) / 10}s after Esc${first ? ` — ${first.slice(0, 100)}` : ""}`);
  console.log(`  the session is intact; queued DMs drain on its next turn`);
}

const unstickCommand: Command = {
  kind: "command",
  name: "unstick",
  group: "Mesh",
  summary: "interrupt the tool an agent is stuck inside (Esc in its tmux pane) — the session survives, never a restart",
  usage: "unstick <name|folder> [--force] [--space s]",
  run: (a) => unstick([...a.raw]),
};

registry.register(unstickCommand);
