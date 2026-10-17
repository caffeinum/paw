/**
 * The `acp` connector: any Agent Client Protocol agent (fx acp, codex-acp, gemini --acp, goose acp) as a
 * paw agent, through the standalone `cotal-connector-acp` plugin (vendored tarball, see package.json).
 * The plugin owns the seat: it starts the persona's `acpCommand:`, hands it the cotal tools over MCP and
 * turns mesh messages into prompts. paw wraps it only for what every paw agent gets: the paw brief (riding
 * the first prompt — ACP has no system prompt), beads, the persona's `nice:`, and paw's permission stance
 * (`acpPermission: allow` unless the persona says otherwise — the plugin itself has no default).
 *
 * Persona keys (all quoted strings): `agent: acp`, `acpCommand: '["/abs/fx","acp"]'`,
 * `acpEnv: '{"FX_PERMISSION_MODE":"full-access"}'` (optional), `acpPermission: allow|reject` (optional),
 * `acpHost: /abs/host|ts` (optional; default the pinned Rust host at $PAW_HOME/bin/cotal-acp-host-<rev>, src/acp-host.ts).
 * No AG-UI event plane → spawned with `events: false`; no shared MCP servers → `shareTools: none`.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { acpConnector } from "cotal-connector-acp";
import type { Connector, LaunchOpts, LaunchSpec } from "@cotal-ai/core";
import { resolveAcpHost } from "./acp-host.ts";
import { beadsDir } from "./beads-dir.ts";
import { ADDRESSING_BRIEF, CHANNELS_BRIEF, OPERATOR_REQUESTS_BRIEF, TASKS_BRIEF, UNATTENDED_BRIEF, WAKE_BRIEF } from "./brief.ts";
import { niced } from "./connector.ts";
import { HUMAN_PEER } from "./names.ts";
import { personaValue, readNice } from "./session.ts";

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

/** paw is always bypass: answer the agent's permission requests `allow`, unless the persona or the
 *  spawn names a policy itself. */
function withPawPermission(opts: LaunchOpts): LaunchOpts {
  if (opts.launchOptions?.permission !== undefined) return opts;
  if (opts.configPath && personaValue(opts.configPath, "acpPermission") !== undefined) return opts;
  return { ...opts, launchOptions: { ...opts.launchOptions, permission: "allow" } };
}

/** The plugin's bundled node host, the one it runs when no acpHost is set. */
function tsHostEntry(): string {
  const entry = join(dirname(fileURLToPath(import.meta.resolve("cotal-connector-acp"))), "host.js");
  if (!existsSync(entry)) throw new Error(`paw: acpHost: ts, but the plugin's node host ${entry} is missing`);
  return entry;
}

/**
 * The seat host. A launch option `host` always wins (the plugin reads it before the persona). Unset, the
 * default is paw's Rust binary. `acpHost: ts` cannot reach the plugin as is (it accepts only an absolute
 * executable, and would refuse "ts"), so paw shadows it with `host = node` and then adds the node host's
 * entry — exactly the spec the plugin builds when no host is set.
 */
function launchOnHost(opts: LaunchOpts): LaunchSpec {
  if (opts.launchOptions?.host !== undefined) return acpConnector.buildLaunch(opts);
  const host = resolveAcpHost(opts.configPath);
  if (host.kind === "persona") return acpConnector.buildLaunch(opts);
  const hostPath = host.kind === "default" ? host.path : process.execPath;
  const spec = acpConnector.buildLaunch({ ...opts, launchOptions: { ...opts.launchOptions, host: hostPath } });
  if (host.kind === "default") return spec;
  if (spec.command !== process.execPath || (spec.args ?? []).length !== 0)
    throw new Error(`paw: acpHost: ts — the plugin built an unexpected launch (${spec.command} ${JSON.stringify(spec.args)})`);
  return { ...spec, args: [tsHostEntry()] };
}

export const pawAcpConnector: Connector = {
  ...acpConnector,
  buildLaunch(opts: LaunchOpts): LaunchSpec {
    const spec = launchOnHost(withPawPermission(opts));
    return niced(
      {
        ...spec,
        env: {
          ...spec.env,
          COTAL_ACP_INSTRUCTIONS: acpBrief(opts.name),
          BEADS_DIR: beadsDir(),
          BEADS_ACTOR: opts.name,
        },
      },
      readNice(opts.configPath),
    );
  },
};
