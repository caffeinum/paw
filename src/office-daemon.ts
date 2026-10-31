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
import { sendAsYou } from "./dm.ts";
import { messageText, observerEndpoint } from "./feed.ts";
import { officeClient } from "./office-api.ts";
import { OfficeBridge, speechFor, type TappedMessage } from "./office-bridge.ts";
import { bridgeStatePath, officeLinkPath, readBridgeState, readOfficeLink, writeBridgeState, type OfficeLink } from "./office-link.ts";
import { humanPeer } from "./names.ts";
import { isRemoteSpace } from "./server.ts";
import { collectStatus, type AgentStatus } from "./status.ts";

const LINK_POLL_MS = 10_000;
const ROWS_MS = 10_000;
/** Only the repo NAME reaches the office and it rarely changes: git (≈5 processes per agent) runs this often, not every roster read. */
const GIT_MS = 5 * 60_000;
const TICK_MS = 2_000;

/** `leave`: the link is gone (or now names another office) — walk the agents out instead of keeping their tokens. */
type StopBridge = (leave: boolean) => Promise<void>;

interface Active {
  key: string;
  office: string;
  stop: StopBridge;
}

const linkKey = (l: OfficeLink): string => JSON.stringify([l.url, l.office, l.joinKey]);

export async function startOfficeBridge(space: string, server: string, log: (line: string) => void = (l) => console.error(`[office] ${l}`)): Promise<() => Promise<void>> {
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
        active = { key, office: link.office, stop: await runBridge(space, server, link, log, () => void check()) };
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

async function runBridge(space: string, server: string, link: OfficeLink, log: (line: string) => void, recheck: () => void): Promise<StopBridge> {
  const state = readBridgeState(space, link.office); // throws on a bad file — before anything needs stopping
  const linked = (): boolean => existsSync(officeLinkPath(space));
  const ep: CotalEndpoint = await observerEndpoint(space, server, { watchPresence: true });
  ep.on("error", (e: Error) => log(`mesh: ${e.message}`));
  try {
    await ep.start();
    return wire(space, server, link, log, recheck, state, linked, ep);
  } catch (e) {
    await ep.stop().catch(() => {});
    throw e;
  }
}

function wire(space: string, server: string, link: OfficeLink, log: (line: string) => void, recheck: () => void, state: ReturnType<typeof readBridgeState>, linked: () => boolean, ep: CotalEndpoint): StopBridge {
  const bridge = new OfficeBridge({
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
    deliver: async (agent, text) => {
      await sendAsYou({ space, server, target: agent, text, byName: true });
    },
    log,
    operator: operatorName(),
  });
  log(`bridging space "${space}" into ${link.url}/o/${link.office}`);

  const names = new Map<string, string>();
  const seen = new Set<string>(); // one frame can arrive on more than one tapped subject
  const onTap = (_subject: string, m: unknown): void => {
    try {
      const msg = m as TappedMessage | undefined;
      if (msg?.from?.id && msg.from.name) names.set(msg.from.id, msg.from.name);
      if (typeof msg?.id === "string") {
        if (seen.has(msg.id)) return;
        if (seen.size > 2000) seen.clear();
        seen.add(msg.id);
      }
      const s = speechFor(msg, { humanId: ep.card.id, humanName: humanPeer(space), names, bridged: bridge.bridged(), text: (x) => messageText(x as Parameters<typeof messageText>[0]) });
      if (s) bridge.noteSpeech(s);
    } catch (e) {
      log(`tap: ${(e as Error).message}`);
    }
  };
  for (const subject of tapSubjects(space)) ep.tap(onTap, subject ? { subject } : undefined);

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
      bridge.setRows(rows);
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
  const tick = (): void => {
    if (linked()) void bridge.tick();
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
