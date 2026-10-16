/**
 * The `acp` connector: any Agent Client Protocol agent (fx acp, codex-acp, gemini --acp, goose acp) as a
 * paw agent, through the standalone `cotal-connector-acp` plugin (vendored tarball, see package.json).
 * The plugin owns the seat: it starts the persona's `acpCommand:`, hands it the cotal tools over MCP and
 * turns mesh messages into prompts. paw wraps it only for what every paw agent gets: the paw brief (riding
 * the first prompt — ACP has no system prompt), beads, a short TMPDIR and the persona's `nice:`.
 *
 * Persona keys (all quoted strings): `agent: acp`, `acpCommand: '["/abs/fx","acp"]'`,
 * `acpEnv: '{"FX_PERMISSION_MODE":"full-access"}'` (optional), `acpPermission: allow|reject` (optional).
 * No AG-UI event plane → spawned with `events: false`; no shared MCP servers → `shareTools: none`.
 */
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { acpConnector } from "cotal-connector-acp";
import type { Connector, LaunchOpts, LaunchSpec } from "@cotal-ai/core";
import { beadsDir } from "./beads-dir.ts";
import { ADDRESSING_BRIEF, CHANNELS_BRIEF, OPERATOR_REQUESTS_BRIEF, TASKS_BRIEF, UNATTENDED_BRIEF, WAKE_BRIEF } from "./brief.ts";
import { niced } from "./connector.ts";
import { HUMAN_PEER } from "./names.ts";
import { readNice } from "./session.ts";

export { ACP_AGENT } from "./acp-agent.ts";

export function acpBrief(name: string): string {
  return [
    `You are "${name}", a paw agent rooted at this folder and a peer on the cotal mesh, running on an ACP harness.`,
    `The human operator is the peer "${HUMAN_PEER}"; a teammate is addressed by their agent name.`,
    ...ADDRESSING_BRIEF,
    ...CHANNELS_BRIEF,
    ...UNATTENDED_BRIEF,
    ...WAKE_BRIEF,
    ...TASKS_BRIEF,
    ...OPERATOR_REQUESTS_BRIEF,
  ].join(" ");
}

/** A short per-agent TMPDIR (macOS caps a socket path at 104 bytes; cotal's control socket lives there). */
function acpTmpDir(space: string, name: string): string {
  const dir = join(`/tmp/paw-acp-${userInfo().uid}`, createHash("sha256").update(`${space}\0${name}`).digest("hex").slice(0, 8));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export const pawAcpConnector: Connector = {
  ...acpConnector,
  buildLaunch(opts: LaunchOpts): LaunchSpec {
    const spec = acpConnector.buildLaunch(opts);
    return niced(
      {
        ...spec,
        env: {
          ...spec.env,
          COTAL_ACP_INSTRUCTIONS: acpBrief(opts.name),
          TMPDIR: acpTmpDir(opts.space, opts.name),
          BEADS_DIR: beadsDir(),
          BEADS_ACTOR: opts.name,
        },
      },
      readNice(opts.configPath),
    );
  },
};
