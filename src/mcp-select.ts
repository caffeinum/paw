/**
 * Which shared MCP servers ONE agent launches with — the selection math behind `paw mcp`, shared by the
 * listing (src/commands/mcp.ts) and the spawn site (ensureAgentSpawned), so what `paw mcp list` says an
 * agent gets is, by construction, what its next spawn sends.
 *
 * Three inputs:
 *   - `declared` — the servers cotal's config declares for paw's connector (`connectors.claude.mcpServers`);
 *   - `optIn`    — the OPT-IN servers among them (`connectors.claude.pawOptIn`, written by
 *                  `paw mcp add --only` / `paw mcp only`): no agent gets one unless it is named;
 *   - per agent  — the persona's `shareTools:` (absent / `none` / `a,b`) and `mcpOptIn:` (the opt-in
 *                  servers this agent was named for).
 *
 * WHY THE MARK LIVES IN COTAL'S CONFIG, beside the definitions: an opt-in server whose mark is lost
 * silently becomes shared with EVERY agent — the one failure this feature exists to prevent. A mark in a
 * second file (`$PAW_HOME/…`) can be lost, reset or never copied while the definition stays. Kept as a
 * connector-level key it is written in the same write as the server, removed in the same write, and
 * travels with the file. It is a CONNECTOR key, not a field on the server entry, because the entry is
 * handed verbatim to claude's `--mcp-config` — a field there is claude's to reject. cotal's reader
 * validates only `mcpServers` under a connector and its merge spreads the rest, so the key is tolerated.
 *
 * The rule: shareTools absent ⇒ every declared server EXCEPT the opt-in ones; `none` ⇒ nothing; a list ⇒
 * that list. Then every `mcpOptIn:` server is added on top — `--only` names the agent explicitly, so it
 * wins over `none`. With no opt-in server declared and no grant, the persona's selection is passed through
 * untouched (absent stays absent), so a fleet that never uses `--only` launches exactly as before.
 */
import { parseShareSelection } from "@cotal-ai/core";

/** The connector-level key in cotal's config listing the opt-in servers. */
export const OPT_IN_KEY = "pawOptIn";
/** The persona key naming the opt-in servers an agent was granted. */
export const GRANT_KEY = "mcpOptIn";

/** The opt-in server names a connector entry carries. A malformed mark fails loud: reading it as "none"
 *  would share a private server with every agent. */
export function readOptIn(connector: unknown, where: string): string[] {
  const raw = (connector as Record<string, unknown> | undefined)?.[OPT_IN_KEY];
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.some((x) => typeof x !== "string" || !x.trim()))
    throw new Error(`paw: ${where} ${OPT_IN_KEY} must be a list of server names (got ${JSON.stringify(raw)}) — fix it before any agent spawns`);
  return raw as string[];
}

/** A comma list (`a,b`) as names; absent/empty ⇒ []. */
export function splitList(value: string | undefined): string[] {
  return (value ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * The `shareTools` list to send for one agent, or undefined to send none (cotal then shares every
 * declared server). Throws on a grant naming a server that isn't declared — the spawn would otherwise
 * quietly launch without the server the operator named it for.
 */
export function shareSelection(opts: {
  declared: string[];
  optIn: string[];
  share: string | undefined;
  grants: string | undefined;
  agent: string;
}): string[] | undefined {
  const grants = splitList(opts.grants);
  const missing = grants.filter((g) => !opts.declared.includes(g));
  if (missing.length)
    throw new Error(
      `paw: "${opts.agent}" is granted ${missing.join(", ")} (persona ${GRANT_KEY}:) but no such MCP server is declared — ` +
        `\`paw mcp list\` shows what is; drop it with \`paw mcp unshare ${missing[0]} ${opts.agent}\``,
    );
  const optIn = opts.optIn.filter((s) => opts.declared.includes(s));
  if (!optIn.length && !grants.length) {
    const passthrough = parseShareSelection(opts.share);
    return passthrough && [...passthrough];
  }
  const base = opts.share === undefined ? opts.declared.filter((s) => !optIn.includes(s)) : (parseShareSelection(opts.share) ?? []);
  const picked = new Set([...base, ...grants]);
  // cotal's order: the declared order, then anything a selection names that isn't declared (cotal refuses
  // those itself, naming them — paw does not pre-empt that refusal with a second wording).
  return [...opts.declared.filter((s) => picked.has(s)), ...[...picked].filter((s) => !opts.declared.includes(s))];
}

/** The servers the agent actually launches with (selection resolved against `declared`). */
export function effectiveServers(opts: Parameters<typeof shareSelection>[0]): string[] {
  const sel = shareSelection(opts);
  if (sel === undefined) return [...opts.declared];
  return opts.declared.filter((s) => sel.includes(s));
}
