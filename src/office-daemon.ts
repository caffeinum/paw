/**
 * The office bridge's home: started by the per-space mailbox daemon (src/mailbox.ts), the paw-owned
 * always-on process every space already runs (ensure() starts it, it hosts the sleep host and the
 * stale-id forwarder the same way). Idle until `paw office connect` writes a link; the link file is
 * re-read every {@link LINK_POLL_MS}, so connect/disconnect take effect without a restart, and a
 * restarted daemon resumes from the tokens in office-agents.json.
 *
 * While linked it holds ONE observer endpoint (never registers presence, never consumes — src/feed.ts):
 * its roster feeds collectStatus (the same rows `paw status`/paw web show) and its tap feeds speech.
 * Nothing here throws into the mailbox: every failure is a log line, and the beacon keeps beaconing.
 */
import { existsSync, rmSync } from "node:fs";
import { spacePrefix, type CotalEndpoint } from "@cotal-ai/core";
import { operatorName } from "./company.ts";
import { dropSharedManagerControl, sharedManagerControl } from "./control.ts";
import { listAgents } from "./addressing.ts";
import { sendAsYou, sendToPeerId } from "./dm.ts";
import { messageText, observerEndpoint } from "./feed.ts";
import { officeClient } from "./office-api.ts";
import { OFFICE_PEER, OfficeBridge, speechFor, withPresence, type PresenceLike, type TappedMessage } from "./office-bridge.ts";
import { bridgeStatePath, officeLinkPath, readBridgeState, readOfficeLink, writeBridgeState, type OfficeLink } from "./office-link.ts";
import { rosterRows, type RosterPresence } from "./office-roster.ts";
import { humanPeer } from "./names.ts";
import { isRemoteSpace } from "./server.ts";
import { collectStatus, type AgentStatus } from "./status.ts";

const LINK_POLL_MS = 10_000;
const ROWS_MS = 10_000;
/** Only the repo NAME reaches the office and it rarely changes: git (≈5 processes per agent) runs this often, not every roster read. */
const GIT_MS = 5 * 60_000;
const TICK_MS = 2_000;
/** A presence change (status, its stamp, harness activity) re-reads just those agents' rows, at most this often. */
const FAST_MS = 2_000;

/** `leave`: the link is gone (or now names another office) — walk the agents out instead of keeping their tokens. */
type StopBridge = (leave: boolean) => Promise<void>;

interface Active {
  key: string;
  office: string;
  stop: StopBridge;
}

const linkKey = (l: OfficeLink): string => JSON.stringify([l.url, l.office, l.joinKey, l.roster ?? ""]);

export interface BridgeHostOpts {
  /** `paw office serve`: no mailbox, possibly no registry — with no local agents it mirrors the whole roster. */
  headless?: boolean;
}

/** Which agents a link mirrors: the whole mesh roster (`--roster all`, or a headless serve with no agents
 *  registered here), else this paw home's agents. */
export function rosterMode(link: Pick<OfficeLink, "roster">, opts: BridgeHostOpts, localAgents: () => number): boolean {
  return link.roster === "all" || (opts.headless === true && localAgents() === 0);
}

export async function startOfficeBridge(space: string, server: string, log: (line: string) => void = (l) => console.error(`[office] ${l}`), opts: BridgeHostOpts = {}): Promise<() => Promise<void>> {
  let active: Active | undefined;
  let lastLinkError = "";
  let lastStartError = "";
  let checking = false;
  const check = async (): Promise<void> => {
    if (checking) return;
    checking = true;
    try {
      let link: OfficeLink | undefined;
      try {
        link = readOfficeLink(space);
        lastLinkError = "";
      } catch (e) {
        if ((e as Error).message !== lastLinkError) log((lastLinkError = (e as Error).message));
        return; // an unreadable link keeps whatever is running — never guessed as "disconnected"
      }
      const key = link ? linkKey(link) : "";
      if (active && active.key === key) return;
      if (active) {
        const leave = !link || link.office !== active.office;
        await active.stop(leave).catch((e: Error) => log(`stopping the bridge failed: ${e.message}`));
        active = undefined;
        if (!link) rmSync(bridgeStatePath(space), { force: true }); // its tokens were just walked out: dead
        log(link ? "office link changed — restarting the bridge" : "office disconnected — agents walked out, bridge stopped");
      }
      if (link) {
        active = { key, office: link.office, stop: await runBridge(space, server, link, log, () => void check(), opts) };
        lastStartError = "";
      }
    } catch (e) {
      const msg = (e as Error).message;
      if (msg !== lastStartError) log(`bridge failed to start (retrying every ${LINK_POLL_MS / 1000}s; logged once): ${msg}`);
      lastStartError = msg;
    } finally {
      checking = false;
    }
  };
  void check(); // never holds up the mailbox's own startup
  const timer = setInterval(() => void check(), LINK_POLL_MS);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await active?.stop(false); // a daemon restart resumes from the saved tokens
  };
}

/** Same subjects as paw web's tap (web.ts webTapSubjects): the whole space open, the chat/inst/svc planes under auth. */
function tapSubjects(space: string): Array<string | undefined> {
  if (!isRemoteSpace(space)) return [undefined];
  const p = spacePrefix(space);
  return [`${p}.chat.>`, `${p}.inst.>`, `${p}.svc.>`];
}

async function runBridge(space: string, server: string, link: OfficeLink, log: (line: string) => void, recheck: () => void, opts: BridgeHostOpts): Promise<StopBridge> {
  const state = readBridgeState(space, link.office); // throws on a bad file — before anything needs stopping
  const linked = (): boolean => existsSync(officeLinkPath(space));
  const ep: CotalEndpoint = await observerEndpoint(space, server, { watchPresence: true });
  ep.on("error", (e: Error) => log(`mesh: ${e.message}`));
  try {
    await ep.start();
    const roster = rosterMode(link, opts, () => listAgents(space).length);
    return roster ? wireRoster(space, server, link, log, recheck, state, linked, ep) : wire(space, server, link, log, recheck, state, linked, ep);
  } catch (e) {
    await ep.stop().catch(() => {});
    throw e;
  }
}

type Deliver = (agent: string, text: string) => Promise<{ from: string }>;

function makeBridge(space: string, link: OfficeLink, log: (line: string) => void, state: ReturnType<typeof readBridgeState>, linked: () => boolean, deliver: Deliver): OfficeBridge {
  return new OfficeBridge({
    call: officeClient(link),
    state,
    save: (s) => {
      if (!linked()) return; // `paw office disconnect` removed the link: never resurrect its tokens file
      try {
        writeBridgeState(space, s);
      } catch (e) {
        log(`couldn't save office-agents.json: ${(e as Error).message}`);
      }
    },
    deliver,
    log,
    operator: operatorName(),
  });
}

/** Tapped mesh traffic → office speech. `displayName` maps a sender's mesh id to its office name (roster
 *  mode renames colliding agents); `names` is id → name for DM targets, kept current by the caller. */
function tapSpeech(space: string, ep: CotalEndpoint, bridge: OfficeBridge, names: Map<string, string>, log: (line: string) => void, displayName: (id: string, name: string) => string = (_id, name) => name): void {
  const seen = new Set<string>(); // one frame can arrive on more than one tapped subject
  const onTap = (_subject: string, m: unknown): void => {
    try {
      const raw = m as TappedMessage | undefined;
      const msg = raw?.from?.id && raw.from.name ? { ...raw, from: { ...raw.from, name: displayName(raw.from.id, raw.from.name) } } : raw;
      if (msg?.from?.id && msg.from.name) names.set(msg.from.id, msg.from.name);
      if (typeof msg?.id === "string") {
        if (seen.has(msg.id)) return;
        if (seen.size > 2000) seen.clear();
        seen.add(msg.id);
      }
      const s = speechFor(msg, { humanId: ep.card.id, humanName: humanPeer(space), officeId: bridge.officeId(), names, bridged: bridge.bridged(), text: (x) => messageText(x as Parameters<typeof messageText>[0]) });
      if (s) bridge.noteSpeech(s);
    } catch (e) {
      log(`tap: ${(e as Error).message}`);
    }
  };
  for (const subject of tapSubjects(space)) ep.tap(onTap, subject ? { subject } : undefined);
}

/** How long the first roster read waits for the presence watch's initial snapshot before retrying. */
const SNAPSHOT_MS = 5_000;

/**
 * Roster mode: every live agent on the mesh roster, from presence alone (src/office-roster.ts) — no
 * registry, no manager ps, no transcripts, no git. Rows are recomputed from the observer's roster each
 * tick (a pure pass over memory). Office chat is delivered to the agent's mesh ID from the `office` peer:
 * the name may be another machine's, or shared by two.
 */
function wireRoster(space: string, server: string, link: OfficeLink, log: (line: string) => void, recheck: () => void, state: ReturnType<typeof readBridgeState>, linked: () => boolean, ep: CotalEndpoint): StopBridge {
  const idOf = new Map<string, string>(); // office name → mesh id, from the latest roster pass
  const displayOf = new Map<string, string>(); // mesh id → office name
  const bridge = makeBridge(space, link, log, state, linked, async (agent, text) => {
    const id = idOf.get(agent);
    if (!id) throw new Error(`"${agent}" is no longer on the mesh roster`);
    return sendToPeerId({ space, server, id, text, sender: OFFICE_PEER });
  });
  log(`bridging EVERY agent on space "${space}"'s mesh roster (presence only) into ${link.url}/o/${link.office}`);
  const names = new Map<string, string>();
  tapSpeech(space, ep, bridge, names, log, (id, name) => displayOf.get(id) ?? name);

  let unread = "";
  const refresh = async (): Promise<void> => {
    // An unread or silent roster is not "everyone left": keep the office as it is until it reads again.
    let view = ep.presenceView();
    if (view.state === "unpopulated") {
      await ep.waitForPresenceSnapshot(SNAPSHOT_MS);
      view = ep.presenceView();
    }
    if (!view.fresh) {
      if (unread !== view.state) log(`mesh roster ${view.state === "stale" ? "silent past the liveness window" : "not read yet"} — office left as it was until it reads again`);
      unread = view.state;
      return;
    }
    if (unread) log("mesh roster readable again");
    unread = "";
    const roster = ep.getRoster() as unknown as RosterPresence[];
    const rows = rosterRows(roster, Date.now());
    for (const p of roster) names.set(p.card.id, p.card.name);
    idOf.clear();
    displayOf.clear();
    for (const r of rows) {
      idOf.set(r.name, r.id);
      displayOf.set(r.id, r.name);
      names.set(r.id, r.name);
    }
    bridge.setRows(rows);
  };
  let busy = false;
  const tick = (): void => {
    if (!linked()) return recheck(); // disconnected: stop now (walking the agents out), not at the next link poll
    if (busy) return;
    busy = true;
    void refresh()
      .then(() => bridge.tick())
      .catch((e: Error) => log(`roster pass failed: ${e.message}`))
      .finally(() => (busy = false));
  };
  tick();
  const tickTimer = setInterval(tick, TICK_MS);
  return async (leave) => {
    clearInterval(tickTimer);
    const left = await bridge.shutdown(leave);
    if (leave) log(`walked ${left} agent(s) out of ${link.url}/o/${link.office}`);
    await ep.stop().catch(() => {});
  };
}

function wire(space: string, server: string, link: OfficeLink, log: (line: string) => void, recheck: () => void, state: ReturnType<typeof readBridgeState>, linked: () => boolean, ep: CotalEndpoint): StopBridge {
  // from the office peer, never "you": nothing said in the office carries the operator's authority (#81)
  const bridge = makeBridge(space, link, log, state, linked, async (agent, text) => ({ from: (await sendAsYou({ space, server, target: agent, text, byName: true, sender: OFFICE_PEER })).from }));
  log(`bridging space "${space}" into ${link.url}/o/${link.office}`);
  const names = new Map<string, string>();
  tapSpeech(space, ep, bridge, names, log);

  let rowsError = "";
  let rowsBusy = false;
  let gitAt = 0;
  const gitOf = new Map<string, AgentStatus["git"]>();
  const refreshRows = async (): Promise<void> => {
    if (rowsBusy) return;
    rowsBusy = true;
    try {
      const withGit = Date.now() - gitAt >= GIT_MS;
      const { rows } = await collectStatus(space, await sharedManagerControl(space, server), { roster: () => ep.getRoster(), git: withGit });
      if (withGit) {
        gitAt = Date.now();
        gitOf.clear();
        for (const r of rows) gitOf.set(r.name, r.git);
      } else for (const r of rows) r.git = gitOf.get(r.name);
      for (const p of ep.getRoster()) names.set(p.card.id, p.card.name);
      bridge.setRows(withPresence(rows, ep.getRoster() as PresenceLike[]));
      if (rowsError) log("roster readable again");
      rowsError = "";
    } catch (e) {
      await dropSharedManagerControl(space, server).catch(() => {});
      const msg = (e as Error).message;
      if (msg !== rowsError) log(`roster unreadable — office left as it was until it reads again: ${msg}`);
      rowsError = msg;
    } finally {
      rowsBusy = false;
    }
  };
  // #82: a presence change (an agent's status, when it entered it, or its harness's turn progress) re-reads
  // only those agents, so the office follows a working/waiting/idle flip within seconds instead of the 10s roster.
  const seenPresence = new Map<string, string>();
  const dirty = new Set<string>();
  let fastAt = 0;
  let fastError = "";
  ep.on("presence", (e: { presence?: PresenceLike }) => {
    const p = e?.presence;
    if (!p?.card?.name) return;
    const sig = `${p.status}|${p.statusSince ?? ""}|${p.activeAt ?? ""}`;
    if (seenPresence.get(p.card.name) === sig) return;
    seenPresence.set(p.card.name, sig);
    dirty.add(p.card.name);
  });
  const refreshDirty = async (): Promise<void> => {
    if (!dirty.size || rowsBusy || Date.now() - fastAt < FAST_MS) return;
    const want = new Set(dirty);
    dirty.clear();
    fastAt = Date.now();
    rowsBusy = true;
    try {
      const { rows } = await collectStatus(space, await sharedManagerControl(space, server), { roster: () => ep.getRoster(), git: false, only: (all) => new Set(all.filter((n) => want.has(n))) });
      for (const r of rows) r.git = gitOf.get(r.name);
      bridge.patchRows(withPresence(rows, ep.getRoster() as PresenceLike[]));
      fastError = "";
    } catch (e) {
      for (const n of want) dirty.add(n); // the full read every 10s still covers them; logged there
      const msg = (e as Error).message;
      if (msg !== fastError) log(`targeted roster read failed (the full read every ${ROWS_MS / 1000}s still runs; logged once): ${msg}`);
      fastError = msg;
      return;
    } finally {
      rowsBusy = false;
    }
  };
  const tick = (): void => {
    if (linked()) void refreshDirty().then(() => bridge.tick());
    else recheck(); // disconnected: stop now (walking the agents out), not at the next link poll
  };
  void refreshRows().then(tick);
  const rowsTimer = setInterval(() => void refreshRows(), ROWS_MS);
  const tickTimer = setInterval(tick, TICK_MS);
  return async (leave) => {
    clearInterval(rowsTimer);
    clearInterval(tickTimer);
    const left = await bridge.shutdown(leave);
    if (leave) log(`walked ${left} agent(s) out of ${link.url}/o/${link.office}`);
    await ep.stop().catch(() => {});
  };
}
