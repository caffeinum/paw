/**
 * `paw mcp add|ls|rm … --to <agent>[#space]` — MCP servers a SANDBOXED agent owns, in its VM's user scope.
 *
 * A `sandbox: container` agent never gets the host's shared servers (`paw mcp add` without `--to`): those run
 * host commands with host secrets, and `--mcp-config` into the VM is cut to the cotal server alone
 * (src/sandbox.ts). What it CAN load is its own claude config — the VM's CLAUDE_CONFIG_DIR is /paw/claude =
 * host `$PAW_HOME/spaces/<s>/sandbox/<n>/claude`, whose `.claude.json` `mcpServers` is claude's USER scope.
 * So `--to` writes there, in exactly the shape `claude mcp add -s user` writes (verified against 2.1.304:
 * stdio = `{type:"stdio",command,args:[],env:{}}`, remote = `{type:"http"|"sse",url[,headers]}`).
 *
 * Why a direct file write, not `container exec <id> claude mcp add -s user …`: it works with the VM stopped
 * (the dir is a host folder), needs no exec channel, and the shape is the one claude writes. The concurrency
 * is the same as `claude mcp add` from a second process while the agent runs — and the restart that follows
 * is checked to have kept the entry (claude rewrites `.claude.json` often).
 *
 * "…and enables it": MCP servers load at claude start, so a LIVE agent is restarted by default — running
 * `paw mcp add … --to <agent>` IS the operator's explicit go for that one agent, and the output says so.
 * `--no-restart` skips it; a BUSY agent (mid-turn, paw status's judgement) is not restarted unless `--now`.
 * A stopped agent is not started: it picks the server up at its next start. docs/notes/cli.md#paw-mcp.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { McpServerSpec } from "@cotal-ai/core";
import { personaFilePath } from "./addressing.ts";
import { readCwd, readSandbox, sandboxClaudeDir } from "./session.ts";
import { SANDBOX_CLAUDE_BIN, containerBin, listSandboxContainers } from "./sandbox.ts";
import { sandboxBashArgv } from "./sandbox-exec.ts";

/** Names a sandboxed agent's own servers may not take: the launch passes cotal's server as `cotal`
 *  through `--mcp-config`, and a user-scope entry of the same name would shadow or clash with it. */
export const RESERVED_SANDBOX_SERVERS: readonly string[] = ["cotal"];

/** A sandboxed agent, resolved for `--to`. */
export interface SandboxTarget {
  space: string;
  name: string;
  persona: string;
  cwd: string;
  /** Host path of the VM's `/paw/claude/.claude.json`. */
  claudeJson: string;
}

/** `--to <agent>` → the agent's VM claude config. Not registered, or not sandboxed, fails loud — a host
 *  agent's servers come from the shared config, granted per persona. */
export function sandboxTarget(space: string, name: string): SandboxTarget {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error(`paw: --to "${name}" is not an agent name`);
  const persona = personaFilePath(space, name);
  const cwd = existsSync(persona) ? readCwd(persona) : undefined;
  if (!cwd) throw new Error(`paw: no agent "${name}" in space "${space}" (\`paw status --space ${space}\` lists them)`);
  if (!readSandbox(persona))
    throw new Error(
      `paw: "${name}" is not sandboxed — host agents get MCP servers from the shared config, chosen per persona (shareTools:/mcpOptIn:). ` +
        `Use \`paw mcp add <server> --only ${name} -- <cmd|url>\` for a new one, or \`paw mcp share <server> ${name}\` for an existing one`,
    );
  return { space, name, persona, cwd, claudeJson: join(sandboxClaudeDir(persona), ".claude.json") };
}

/** The spec in the exact shape `claude mcp add -s user` writes: stdio always carries `type`, `args` and
 *  `env` (empty ones included); a remote server is `{type,url}` plus `headers` only when given. Any other
 *  key a `--json` entry carries (e.g. `oauth`) is kept verbatim. */
export function claudeUserSpec(spec: McpServerSpec): McpServerSpec {
  if (spec.url !== undefined && spec.command === undefined) {
    const { type, url, headers, ...rest } = spec;
    const t = type ?? "http";
    if (t !== "http" && t !== "sse" && t !== "ws") throw new Error(`paw: a url server's type must be http, sse or ws (got "${t}")`);
    return { type: t, url, ...(headers && Object.keys(headers).length ? { headers } : {}), ...rest };
  }
  if (spec.command === undefined) throw new Error(`paw: an MCP server needs a "command" (stdio) or a "url" (http/sse)`);
  const { type, command, args, env, ...rest } = spec;
  if (type !== undefined && type !== "stdio") throw new Error(`paw: a command server is type stdio (got "${type}")`);
  return { type: "stdio", command, args: args ?? [], env: env ?? {}, ...rest };
}

export type ClaudeJson = Record<string, unknown> & { mcpServers?: Record<string, McpServerSpec> };

/** The VM's `.claude.json`, or `{}` before the agent's first launch. Malformed fails loud — that file is
 *  claude's whole state (onboarding, trust, OAuth-adjacent bits); it is never rewritten from a guess. */
export function readClaudeJson(path: string): ClaudeJson {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`paw: ${path} is not valid JSON (${(e as Error).message}) — not touching it`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`paw: ${path} must be a JSON object`);
  const servers = (parsed as ClaudeJson).mcpServers;
  if (servers !== undefined && (typeof servers !== "object" || servers === null || Array.isArray(servers)))
    throw new Error(`paw: ${path} has a non-object "mcpServers" — not touching it`);
  return parsed as ClaudeJson;
}

/** Add `name`, every other key untouched. An existing server of that name is refused unless `force` —
 *  silently replacing a server the agent (or someone) set up would lose its config. Pure. */
export function withUserServer(doc: ClaudeJson, name: string, spec: McpServerSpec, force: boolean): { doc: ClaudeJson; replaced: boolean } {
  const servers = doc.mcpServers ?? {};
  const replaced = Object.hasOwn(servers, name);
  if (replaced && !force)
    throw new Error(`paw: "${name}" already exists in that agent's servers (${JSON.stringify(servers[name])}) — pass --force to replace it`);
  return { doc: { ...doc, mcpServers: { ...servers, [name]: spec } }, replaced };
}

/** Drop `name`, or undefined when it isn't there (so the caller fails loud instead of reporting a no-op). */
export function withoutUserServer(doc: ClaudeJson, name: string): ClaudeJson | undefined {
  const servers = doc.mcpServers;
  if (!servers || !Object.hasOwn(servers, name)) return undefined;
  const next = { ...servers };
  delete next[name];
  return { ...doc, mcpServers: next };
}

/** Atomic write (tmp + rename in the same dir), 0600 — the file can hold header tokens and env secrets. */
export function writeClaudeJson(path: string, doc: ClaudeJson): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.paw-mcp.tmp`;
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/** Servers the agent's claude sees in its folder: user scope (ours) and local scope (`claude mcp add`'s
 *  default inside the VM, keyed by project path). */
export function listedServers(doc: ClaudeJson, cwd: string): Array<{ name: string; scope: "user" | "local"; spec: McpServerSpec }> {
  const local = ((doc.projects as Record<string, { mcpServers?: Record<string, McpServerSpec> }> | undefined)?.[cwd]?.mcpServers) ?? {};
  return [
    ...Object.entries(doc.mcpServers ?? {}).map(([name, spec]) => ({ name, scope: "user" as const, spec })),
    ...Object.entries(local).map(([name, spec]) => ({ name, scope: "local" as const, spec })),
  ];
}

/** One line describing a server: `stdio  npx -y pkg` / `http  https://…  (headers: Authorization)`. Header
 *  and env VALUES are never printed — they are usually tokens. */
export function describeServer(spec: McpServerSpec): string {
  if (spec.url !== undefined) {
    const h = Object.keys(spec.headers ?? {});
    return `${spec.type ?? "http"}  ${spec.url}${h.length ? `  (headers: ${h.join(", ")})` : ""}`;
  }
  const e = Object.keys(spec.env ?? {});
  return `stdio  ${[spec.command, ...(spec.args ?? [])].join(" ")}${e.length ? `  (env: ${e.join(", ")})` : ""}`;
}

export type EnableAction = "restart" | "skipped" | "not-running" | "busy";

/** Whether to restart the agent so it loads its servers. Pure; the caller says why for each outcome. */
export function restartDecision(o: { live: boolean; busy: boolean; noRestart: boolean; now: boolean }): EnableAction {
  if (o.noRestart) return "skipped";
  if (!o.live) return "not-running";
  if (o.busy && !o.now) return "busy";
  return "restart";
}

/** `claude mcp get <name>`'s health line → a verdict. 2.1.304 prints `Status: ✔ Connected`,
 *  `Status: ! Needs authentication` or `Status: ✘ Failed to connect` (+ `Issue: …`). */
export function parseMcpGet(out: string): { state: "connected" | "needs-auth" | "failed" | "unknown"; detail?: string } {
  const status = /Status:\s*(.+)/.exec(out)?.[1]?.trim();
  const issue = /Issue:\s*(.+)/.exec(out)?.[1]?.trim();
  if (!status) return { state: "unknown", detail: out.trim().split("\n").slice(-3).join(" | ") || undefined };
  if (/connected/i.test(status) && !/fail/i.test(status)) return { state: "connected" };
  if (/auth/i.test(status)) return { state: "needs-auth", detail: issue };
  return { state: "failed", detail: issue ?? status };
}

/** Does the VM's running claude ignore its own config? `ps -eo args` lines of the image's claude. */
export function strictMcpRunning(psArgs: string): boolean {
  return psArgs.split("\n").some((l) => l.includes(SANDBOX_CLAUDE_BIN) && !l.includes(" mcp ") && l.includes("--strict-mcp-config"));
}

const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Everything the enable step touches outside this module — real by default, faked in check:mcp-sandbox. */
export interface EnableDeps {
  /** The agent's liveness and busyness, as `paw status` judges it. */
  agentState(t: SandboxTarget): Promise<{ live: boolean; busy: boolean }>;
  /** paw's single-agent restart (src/addressing.ts restartAgent, as `paw restart <agent>`). */
  restart(t: SandboxTarget, progress: (line: string) => void): Promise<void>;
  /** The agent's one RUNNING container id, or undefined. */
  liveContainer(t: SandboxTarget): string | undefined;
  /** Run a bash command line in the VM (read-only uses only). */
  exec(container: string, cwd: string, command: string, timeoutMs: number): { code: number | null; out: string };
  sleep(ms: number): Promise<void>;
  log(line: string): void;
}

export function realEnableDeps(): EnableDeps {
  return {
    async agentState(t) {
      const { managerProcs, ensure } = await import("./lifecycle.ts");
      if (managerProcs(t.space).length === 0) return { live: false, busy: false }; // no manager here → nothing of ours runs
      await ensure({ needMesh: true, needManager: true, space: t.space });
      const { withManagerControl } = await import("./control.ts");
      const { pawServer } = await import("./server.ts");
      const { collectStatus } = await import("./status.ts");
      return withManagerControl(t.space, pawServer(t.space), async (ctl) => {
        const { rows } = await collectStatus(t.space, ctl, { only: () => new Set([t.name]), git: false });
        const row = rows.find((r) => r.name === t.name);
        if (!row) throw new Error(`paw: "${t.name}" has no status row in space "${t.space}"`);
        const busy = row.busy === true || row.mesh === "working" || row.mesh === "waiting";
        return { live: row.live, busy };
      });
    },
    async restart(t, progress) {
      const { ensure } = await import("./lifecycle.ts");
      await ensure({ needMesh: true, needManager: true, space: t.space });
      const { withManagerControl } = await import("./control.ts");
      const { pawServer } = await import("./server.ts");
      const { restartAgent } = await import("./addressing.ts");
      await withManagerControl(t.space, pawServer(t.space), async (ctl) => {
        await restartAgent(ctl, { space: t.space, name: t.name, cwd: t.cwd, progress });
      });
    },
    liveContainer(t) {
      const running = listSandboxContainers().filter((c) => c.space === t.space && c.agent === t.name && c.state === "running");
      if (running.length > 1) throw new Error(`paw: "${t.name}" has ${running.length} running containers (${running.map((c) => c.id).join(", ")}) — \`paw sandbox ls\``);
      return running[0]?.id;
    },
    exec(container, cwd, command, timeoutMs) {
      const r = spawnSync(containerBin(), sandboxBashArgv(container, cwd, command, timeoutMs), { encoding: "utf8", timeout: timeoutMs + 5_000 });
      return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: (line) => console.log(line),
  };
}

/** Is the stdio server's command on the VM's PATH? Only when the VM runs — otherwise a note, never a guess. */
export function checkCommandInVm(t: SandboxTarget, command: string, deps: EnableDeps): void {
  let id: string | undefined;
  try {
    id = deps.liveContainer(t);
  } catch (e) {
    deps.log(`  note: couldn't look for ${t.name}'s VM (${(e as Error).message.replace(/^paw: /, "")}) — "${command}" must exist IN the VM, not on this machine`);
    return;
  }
  if (!id) {
    deps.log(`  note: "${command}" runs IN ${t.name}'s VM, not on this machine — it isn't running, so that wasn't checked (install it there: \`paw sandbox shell ${t.name}#${t.space}\`)`);
    return;
  }
  const r = deps.exec(id, t.cwd, `command -v ${sq(command)}`, 30_000);
  if (r.code === 0) deps.log(`  "${command}" found in the VM: ${r.out.trim().split("\n").pop()}`);
  else deps.log(`  ⚠ "${command}" is NOT on the VM's PATH — the server will fail to start until it is installed there (\`paw sandbox shell ${t.name}#${t.space}\`; installs land in its persistent home)`);
}

export interface EnableOpts {
  server: string;
  /** "add": verify the server answers after the restart; "rm": just restart. */
  verb: "add" | "rm";
  noRestart: boolean;
  now: boolean;
  /** How long to wait for the VM to come back before giving up on the verification. */
  bootWaitMs?: number;
}

/** After the write: restart (or say why not), then check the server from inside the VM. Returns the action. */
export async function enableInAgent(t: SandboxTarget, o: EnableOpts, deps: EnableDeps): Promise<EnableAction> {
  const addr = `${t.name}#${t.space}`;
  const st = o.noRestart ? { live: false, busy: false } : await deps.agentState(t);
  const action = restartDecision({ live: st.live, busy: st.busy, noRestart: o.noRestart, now: o.now });
  const what = o.verb === "add" ? `loads ${o.server}` : `drops ${o.server}`;
  if (action === "skipped") {
    deps.log(`not restarted (--no-restart) — ${t.name} ${what} at its next start: \`paw restart ${addr}\``);
    return action;
  }
  if (action === "not-running") {
    deps.log(`${t.name} isn't running — it ${what} when it next starts (\`paw start ${addr}\`)`);
    return action;
  }
  if (action === "busy") {
    deps.log(`⚠ ${t.name} is busy (mid-turn) — NOT restarted, so its turn isn't killed. It ${what} at its next start: \`paw restart ${addr}\` when it's idle, or re-run with --now`);
    return action;
  }
  deps.log(`restarting ${t.name} so it ${what} (an MCP server loads at claude start; --no-restart skips this)…`);
  await deps.restart(t, (line) => deps.log(`  ${line}`));
  deps.log(`✓ restarted ${t.name}`);
  if (o.verb === "add") await verifyInVm(t, o, deps);
  return action;
}

async function verifyInVm(t: SandboxTarget, o: EnableOpts, deps: EnableDeps): Promise<void> {
  // claude rewrites `.claude.json` constantly; a restart that dropped our entry must not read as success.
  if (!Object.hasOwn(readClaudeJson(t.claudeJson).mcpServers ?? {}, o.server))
    throw new Error(`paw: ${o.server} is no longer in ${t.claudeJson} after the restart — claude rewrote the file without it; re-run \`paw mcp add … --to ${t.name}#${t.space}\``);
  const deadline = Date.now() + (o.bootWaitMs ?? 90_000);
  let id: string | undefined;
  for (;;) {
    try {
      id = deps.liveContainer(t);
    } catch {
      id = undefined;
    }
    if (id || Date.now() >= deadline) break;
    await deps.sleep(2_000);
  }
  if (!id) {
    deps.log(`  ⚠ ${t.name}'s VM didn't come up within ${Math.round((o.bootWaitMs ?? 90_000) / 1000)}s — couldn't check ${o.server}; \`paw sandbox ls\`, then \`paw mcp ls --to ${t.name}#${t.space}\``);
    return;
  }
  const ps = deps.exec(id, t.cwd, "ps -eo args", 30_000);
  if (ps.code === 0 && strictMcpRunning(ps.out))
    deps.log(
      `  ⚠ ${t.name}'s claude runs with --strict-mcp-config, which IGNORES its own servers — this paw's sandboxed launch predates own-MCP support ` +
        `(or the persona sets sandboxOwnMcp: false). The server is installed but not loaded.`,
    );
  const r = deps.exec(id, t.cwd, `${SANDBOX_CLAUDE_BIN} mcp get ${sq(o.server)}`, 60_000);
  const v = parseMcpGet(r.out);
  if (v.state === "connected") deps.log(`  ✓ ${o.server}: connected (checked in the VM with \`claude mcp get\`)`);
  else if (v.state === "needs-auth")
    deps.log(
      `  ! ${o.server}: needs authentication (OAuth) — run \`paw sandbox shell ${t.name}#${t.space}\`, then \`claude mcp login ${o.server}\` ` +
        `and open the URL it prints on this machine (the VM's callback port is forwarded to localhost); then \`paw restart ${t.name}#${t.space}\``,
    );
  else if (v.state === "failed") deps.log(`  ✘ ${o.server}: failed to connect${v.detail ? ` — ${v.detail}` : ""}`);
  else deps.log(`  ? ${o.server}: couldn't read its status from \`claude mcp get\`${v.detail ? ` (${v.detail})` : ""}`);
}
