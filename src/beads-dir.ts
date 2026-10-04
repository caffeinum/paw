/**
 * The beads db every paw surface and agent is pinned to. Default: bd's machine-wide `~/.beads`.
 *
 * `PAW_BEADS_DIR` overrides it — for an ISOLATED test space only (a test must never file beads into
 * the operator's live list). A paw-named knob rather than bd's own BEADS_DIR on purpose: every agent
 * shell already carries BEADS_DIR (the connector injects it), and an operator shell may carry one
 * for some repo's own tracker — honouring either would silently redirect the fleet's list.
 * Daemons inherit it through daemonEnv, so the manager's connector pins test agents to the same db.
 */
import { homedir } from "node:os";
import { join } from "node:path";

export function beadsDir(): string {
  const override = process.env.PAW_BEADS_DIR;
  return override ? override : join(homedir(), ".beads");
}
