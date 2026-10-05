/**
 * Talk to tracepaper's shared server DIRECTLY over HTTP instead of through a per-agent stdio bridge.
 *
 * The shared `tracepaper` MCP entry (cotal config, key `claude`) launches `bun … tracepaper` per agent:
 * a ~17MB bridge whose only job is to tag requests with the agent's canvas and forward them to the
 * shared server. tracepaper ≥0.10.3 works the canvas out server-side from an `x-tracepaper-cwd` header,
 * so claude can connect straight to it: `{type:"http", url, headers:{x-tracepaper-cwd:<agent folder>}}`.
 *
 * Opt-in per space by a file holding the server's MCP url (`spaces/<s>/tracepaper-url`, e.g.
 * `http://127.0.0.1:4321/mcp`). It must only be written once a KeepAlive `tracepaper serve` ≥0.10.3
 * owns that port — an older server ignores the header and every agent's frames land on "default".
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function tracepaperUrlPath(space: string): string {
  return join(process.env.PAW_HOME?.trim() || join(homedir(), ".paw"), "spaces", space, "tracepaper-url");
}

/** The direct url, or undefined when the space still uses the bridge. A file that isn't an http(s) url
 *  fails loud — silently falling back would look switched while still costing the bridges. */
export function readTracepaperUrl(space: string): string | undefined {
  const p = tracepaperUrlPath(space);
  if (!existsSync(p)) return undefined;
  const url = readFileSync(p, "utf8").trim();
  if (!/^https?:\/\/[^\s]+$/.test(url)) throw new Error(`paw: ${p} must hold tracepaper's MCP url (e.g. http://127.0.0.1:4321/mcp), got "${url}"`);
  return url;
}

type McpServer = { command?: string; args?: string[]; env?: Record<string, string>; type?: string; url?: string; headers?: Record<string, string> };

/** Rewrite the launch's `tracepaper` MCP entry (if it has one — `shareTools:` may exclude it) to the
 *  direct HTTP form for an agent working in `cwd`. Rewrites `args` in place, inline or 0600 file. */
export function routeTracepaperDirect(args: string[], url: string, cwd: string): boolean {
  const i = args.indexOf("--mcp-config");
  if (i < 0 || i + 1 >= args.length) return false;
  const raw = args[i + 1]!;
  const inline = raw.trimStart().startsWith("{");
  const cfg = JSON.parse(inline ? raw : readFileSync(raw, "utf8")) as { mcpServers?: Record<string, McpServer> };
  if (!cfg.mcpServers?.tracepaper) return false;
  cfg.mcpServers.tracepaper = { type: "http", url, headers: { "x-tracepaper-cwd": cwd } };
  const out = JSON.stringify(cfg);
  if (inline) args[i + 1] = out;
  else writeFileSync(raw, out, { mode: 0o600 });
  return true;
}

