/**
 * Point a claude launch's `cotal` MCP server at the hub shim instead of `node mcp.cjs`.
 *
 * cotal's buildLaunch passes `--strict-mcp-config --mcp-config <cfg>` where `<cfg>` is either inline
 * JSON or (when operator servers are shared) a 0600 temp file. Only the `cotal` entry changes; every
 * shared server and the env claude hands its MCP children stay exactly as cotal built them — the
 * shim forwards the session's `COTAL_*` env to the hub in its handshake.
 */
import { readFileSync, writeFileSync } from "node:fs";

interface McpConfig {
  mcpServers: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
}

/** Rewrites `args` in place. Throws if the launch has no `cotal` MCP entry to replace — a launch
 *  that silently kept `node mcp.cjs` would look like hub mode while costing what it saves. */
export function routeCotalToHub(args: string[], shim: string, socket: string): void {
  const i = args.indexOf("--mcp-config");
  if (i < 0 || i + 1 >= args.length) throw new Error("paw: cotal hub — this launch has no --mcp-config to route");
  const raw = args[i + 1]!;
  const inline = raw.trimStart().startsWith("{");
  const cfg = JSON.parse(inline ? raw : readFileSync(raw, "utf8")) as McpConfig;
  const cotal = cfg.mcpServers?.cotal;
  if (!cotal) throw new Error("paw: cotal hub — the launch's MCP config has no `cotal` server");
  cfg.mcpServers.cotal = { ...cotal, command: shim, args: [socket] };
  const out = JSON.stringify(cfg);
  if (inline) args[i + 1] = out;
  else writeFileSync(raw, out, { mode: 0o600 });
}
