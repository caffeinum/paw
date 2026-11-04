/**
 * `paw office` — link a space to an agent-office (src/office-link.ts) that the mailbox daemon's bridge
 * mirrors the space's agents into (src/office-daemon.ts), and that paw web's ~office embeds.
 *
 *   paw office connect --url <base> --join-key <k> [--owner-key <k>] [--view-key <k>]
 *   paw office status [--json]
 *   paw office open
 *   paw office disconnect
 *   paw office serve [--url <base> --join-key <k> [--owner-key <k>] [--view-key <k>]] [--roster all]
 *
 * `serve` is the headless bridge (a container's CMD, next to the broker): only the bridge, no mailbox
 * beacon, no human presence, logs on stdout, SIGTERM stops it keeping the agent tokens. Its link comes
 * from the flags, else OFFICE_URL / OFFICE_JOIN_KEY / OFFICE_OWNER_KEY / OFFICE_VIEW_KEY / OFFICE_ROSTER,
 * else the link already stored. With no agents registered in this PAW_HOME it mirrors the whole roster.
 *
 * Keys are bearer secrets: stored 0600, never printed, never logged. `connect` proves the URL + keys
 * with a real `office_look` before writing anything.
 */
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { registry, type Command } from "@cotal-ai/core";
import { OfficeError, officeClient } from "../office-api.ts";
import { bridgeStatePath, describeLink, makeLink, readBridgeState, readOfficeLink, removeOfficeLink, viewerUrl, writeOfficeLink, type OfficeLink } from "../office-link.ts";
import { checkSpaceName } from "../remote-mesh.ts";
import { writeJson } from "../stdout.ts";

const USAGE =
  "office connect --url <agent-office url> --join-key <k> [--owner-key <k>] [--view-key <k>] [--roster all] | office status [--json] | office open | office disconnect | office serve [--url … --join-key … [--owner-key …]] [--roster all]   (all take --space <s>)";

export interface OfficeArgs {
  verb: "connect" | "status" | "open" | "disconnect" | "serve";
  space: string;
  url?: string;
  joinKey?: string;
  ownerKey?: string;
  viewKey?: string;
  roster?: "all";
  json: boolean;
}

const checkRoster = (v: string, from: string): "all" => {
  if (v !== "all") throw new Error(`paw: ${from} takes only "all" (mirror every agent on the mesh roster) — got "${v}"`);
  return v;
};

export function parseOfficeArgs(argv: string[]): OfficeArgs {
  const pos: string[] = [];
  const out: Partial<OfficeArgs> & { json: boolean } = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`paw: ${a} needs a value — ${USAGE}`);
      return v;
    };
    if (a === "--space") out.space = value();
    else if (a === "--url") out.url = value();
    else if (a === "--join-key") out.joinKey = value();
    else if (a === "--owner-key") out.ownerKey = value();
    else if (a === "--view-key") out.viewKey = value();
    else if (a === "--roster") out.roster = checkRoster(value(), "--roster");
    else if (a === "--json") out.json = true;
    else if (a.startsWith("-")) throw new Error(`paw: unknown flag "${a}" — ${USAGE}`);
    else pos.push(a);
  }
  const verb = pos.shift() ?? "status";
  if (verb !== "connect" && verb !== "status" && verb !== "open" && verb !== "disconnect" && verb !== "serve") throw new Error(`paw: unknown \`office ${verb}\` — ${USAGE}`);
  if (pos.length) throw new Error(`paw: unexpected "${pos[0]}" — ${USAGE}`);
  if (!out.space) throw new Error(`paw: which space? pass --space <s> — ${USAGE}`);
  checkSpaceName(out.space);
  const keyed = out.url !== undefined || out.joinKey !== undefined || out.ownerKey !== undefined || out.viewKey !== undefined;
  if (verb !== "connect" && verb !== "serve" && (keyed || out.roster)) throw new Error(`paw: --url/--join-key/--owner-key/--view-key/--roster belong to \`paw office connect\` / \`serve\` — ${USAGE}`);
  if (verb === "connect" && (!out.url || !out.joinKey)) throw new Error(`paw: \`paw office connect\` needs --url and --join-key — ${USAGE}`);
  if (verb === "serve" && keyed && (!out.url || !out.joinKey)) throw new Error(`paw: \`paw office serve\` with a link needs both --url and --join-key — ${USAGE}`);
  if (out.json && verb !== "status") throw new Error(`paw: --json belongs to \`paw office status\` — ${USAGE}`);
  return { ...out, verb, space: out.space } as OfficeArgs;
}

/** Where `serve`'s link comes from: flags win, else the OFFICE_* env (a container's secrets), else the stored link. */
export interface ServeConfig {
  url?: string;
  joinKey?: string;
  ownerKey?: string;
  viewKey?: string;
  roster?: "all";
  /** Which source the keys came from (for the log line; never the keys). */
  from: "flags" | "env" | "stored";
}

export function serveConfig(args: OfficeArgs, env: NodeJS.ProcessEnv): ServeConfig {
  const e = (k: string): string | undefined => env[k]?.trim() || undefined;
  const envRoster = e("OFFICE_ROSTER");
  const roster = args.roster ?? (envRoster !== undefined ? checkRoster(envRoster, "OFFICE_ROSTER") : undefined);
  if (args.url || args.joinKey) return { url: args.url, joinKey: args.joinKey, ownerKey: args.ownerKey, viewKey: args.viewKey, roster, from: "flags" };
  const [url, joinKey] = [e("OFFICE_URL"), e("OFFICE_JOIN_KEY")];
  if (url || joinKey) {
    if (!url || !joinKey) throw new Error(`paw: office serve needs BOTH OFFICE_URL and OFFICE_JOIN_KEY (got only ${url ? "OFFICE_URL" : "OFFICE_JOIN_KEY"})`);
    return { url, joinKey, ownerKey: e("OFFICE_OWNER_KEY"), viewKey: e("OFFICE_VIEW_KEY"), roster, from: "env" };
  }
  if (args.ownerKey || args.viewKey) throw new Error(`paw: --owner-key/--view-key need --url and --join-key — ${USAGE}`);
  return { roster, from: "stored" };
}

async function serve(args: OfficeArgs): Promise<void> {
  const { space } = args;
  const out = (line: string): void => console.log(`${new Date().toISOString()} [office] ${line}`);
  const cfg = serveConfig(args, process.env);
  const { mailboxOfThisHome } = await import("../lifecycle.ts");
  const mailbox = mailboxOfThisHome(space);
  if (mailbox) throw new Error(`paw: this PAW_HOME's mailbox (pid ${mailbox}) already bridges space "${space}" — serve from a PAW_HOME without one, or \`paw down --space ${space}\` first`);
  let link: OfficeLink | undefined;
  if (cfg.url && cfg.joinKey) {
    const previous = readOfficeLink(space);
    link = makeLink(space, cfg.url, { joinKey: cfg.joinKey, ownerKey: cfg.ownerKey, viewKey: cfg.viewKey, roster: cfg.roster ?? previous?.roster });
    const look = await verifyLink(link);
    if (previous && previous.office !== link.office) removeOfficeLink(space);
    writeOfficeLink(link);
    out(`link from ${cfg.from}: office "${look.office?.name}" at ${link.url}/o/${link.office}`);
  } else {
    link = readOfficeLink(space);
    if (!link) throw new Error(`paw: space "${space}" has no office — pass --url/--join-key, set OFFICE_URL + OFFICE_JOIN_KEY, or \`paw office connect\` first`);
    if (cfg.roster && link.roster !== cfg.roster) writeOfficeLink((link = { ...link, roster: cfg.roster }));
    out(`stored link: ${describeLink(link)}`);
  }
  const { pawServer } = await import("../server.ts");
  const { startOfficeBridge } = await import("../office-daemon.ts");
  const server = pawServer(space);
  out(`space "${space}" on ${server}; headless (no mailbox, no presence)`);
  const stop = await startOfficeBridge(space, server, out, { headless: true });
  let stopping = false;
  const quit = (sig: string): void => {
    if (stopping) return;
    stopping = true;
    out(`${sig}: stopping (agent tokens kept — a restart resumes them)`);
    void stop()
      .catch((e: Error) => out(`stop failed: ${e.message}`))
      .finally(() => process.exit(0));
  };
  process.on("SIGTERM", () => quit("SIGTERM"));
  process.on("SIGINT", () => quit("SIGINT"));
  await new Promise<void>(() => {});
}

interface LookResult {
  office?: { id?: string; name?: string };
  agents?: Array<{ name: string; client?: string; status: string; activity?: string }>;
}

/** Prove the link: the join key (and owner key) can `office_look`; a view key is accepted when the office calls it read-only. */
export async function verifyLink(link: OfficeLink, fetchImpl: typeof fetch = fetch): Promise<LookResult> {
  const call = officeClient(link, fetchImpl);
  const look = (await call("look", {}).catch((e: Error) => {
    throw new Error(`paw: the office refused the join key — ${e.message}`);
  })) as LookResult;
  if (look?.office?.id !== link.office) throw new Error(`paw: ${link.url} answered office_look for "${look?.office?.id}", not ${link.office} — is --url the right deployment?`);
  if (link.ownerKey) await call("look", {}, { key: link.ownerKey }).catch((e: Error) => {
    throw new Error(`paw: the office refused the owner key — ${e.message}`);
  });
  if (link.viewKey) {
    try {
      await call("look", {}, { key: link.viewKey });
    } catch (e) {
      if (!(e instanceof OfficeError && e.status === 403)) throw new Error(`paw: the office refused the view key — ${(e as Error).message}`);
    }
  }
  return look;
}

async function office(argv: string[]): Promise<void> {
  const args = parseOfficeArgs(argv);
  const { space } = args;
  if (args.verb === "serve") return serve(args);
  if (args.verb === "connect") {
    const link = makeLink(space, args.url!, { joinKey: args.joinKey!, ownerKey: args.ownerKey, viewKey: args.viewKey, roster: args.roster });
    const look = await verifyLink(link);
    const previous = readOfficeLink(space);
    if (previous && previous.office !== link.office) removeOfficeLink(space); // a different office: old tokens mean nothing there
    const path = writeOfficeLink(link);
    console.log(`✓ space "${space}" → office "${look.office?.name}" at ${link.url}/o/${link.office}`);
    console.log(`  link (0600): ${path}`);
    if (link.roster === "all") console.log(`  roster mode: EVERY agent on the space's mesh roster is mirrored — disconnect any other bridge into this office, or agents appear twice`);
    console.log(`  the space's mailbox daemon mirrors its agents within ~10s (a mailbox from an older release needs \`paw restart --space ${space}\`)`);
    if (!viewerUrl(link)) console.log(`  no --owner-key/--view-key: paw web's ~office can't embed the viewer, and office chat needs --owner-key`);
    else if (!link.ownerKey) console.log(`  view key only: the embedded office is read-only — reconnect with --owner-key to chat with agents from it`);
    return;
  }
  const link = readOfficeLink(space);
  if (!link) {
    if (args.verb === "status" && args.json) return writeJson({ space, connected: false });
    if (args.verb === "disconnect") throw new Error(`paw: space "${space}" has no office connected`);
    throw new Error(`paw: space "${space}" has no office — \`paw office connect --space ${space} --url <agent-office url> --join-key <k> --owner-key <k>\``);
  }
  if (args.verb === "open") {
    const url = viewerUrl(link);
    if (!url) throw new Error(`paw: the office link for "${space}" has no owner or view key — reconnect with --owner-key (or --view-key)`);
    // argv to the opener, never stdout: the fragment carries the key
    spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { stdio: "ignore", detached: true }).unref();
    console.log(`opened the office viewer for "${space}" (${link.url}/o/${link.office})`);
    return;
  }
  if (args.verb === "disconnect") {
    const state = readBridgeState(space, link.office);
    // Link first: the mailbox's bridge sees it gone within a tick, stops saving tokens and walks out
    // whatever it holds (a token it rejoined after this read included); these leaves cover a mailbox
    // that isn't running. Both sides leaving the same token is harmless (the second gets a 401).
    removeOfficeLink(space);
    const call = officeClient(link);
    const failed: string[] = [];
    for (const [name, a] of Object.entries(state.agents)) {
      await call("leave", {}, { token: a.token }).catch((e: Error) => {
        if (!(e instanceof OfficeError && e.status === 401)) failed.push(`${name} (${e.message})`);
      });
    }
    console.log(`✓ space "${space}" disconnected from ${link.url}/o/${link.office} — ${Object.keys(state.agents).length - failed.length} agent(s) walked out`);
    if (failed.length) console.log(`  couldn't walk out: ${failed.join(", ")} — the office times them out after an hour`);
    return;
  }
  const state = readBridgeState(space, link.office);
  const statePath = bridgeStatePath(space);
  const savedAt = existsSync(statePath) ? statSync(statePath).mtime.toISOString() : undefined;
  let look: LookResult | undefined;
  let lookError: string | undefined;
  try {
    look = (await officeClient(link)("look", {})) as LookResult;
  } catch (e) {
    lookError = (e as Error).message;
  }
  const mirrored = Object.keys(state.agents).sort();
  if (args.json)
    return writeJson({
      space,
      connected: true,
      url: link.url,
      office: link.office,
      name: look?.office?.name,
      keys: { join: true, owner: !!link.ownerKey, view: !!link.viewKey },
      roster: link.roster === "all" ? "all" : "local",
      mirrored,
      stateSavedAt: savedAt,
      agents: look?.agents,
      ...(lookError ? { error: lookError } : {}),
    });
  console.log(`office for "${space}": ${look?.office?.name ? `"${look.office.name}" ` : ""}${describeLink(link)}`);
  console.log(`mirrored by the bridge: ${mirrored.length ? mirrored.join(", ") : "none yet"}${savedAt ? ` (state saved ${savedAt})` : ""}`);
  if (lookError) throw new Error(`paw: the office is unreachable right now — ${lookError}`);
  for (const a of look?.agents ?? []) console.log(`  ${a.name.padEnd(24)} ${a.status.padEnd(8)} ${a.client && a.client !== "paw" ? `[${a.client}] ` : ""}${a.activity ?? ""}`);
}

const officeCommand: Command = {
  kind: "command",
  name: "office",
  group: "Mesh",
  summary: "link a space to an agent-office: its agents appear there, office chat reaches them, paw web's ~office embeds it",
  usage: USAGE,
  run: (a) => office([...a.raw]),
};

registry.register(officeCommand);
