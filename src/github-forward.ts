/**
 * GitHub team tags by push (2026-11-25). The keeper's `team:` search poll (src/github-teams.ts) reaches 10 teams
 * every 2 min, so with 45 teams a tag took up to ~10 min. `gh webhook forward --org <org>` (the cli/gh-webhook
 * extension) makes a temporary org "dev hook", streams its deliveries over a websocket and POSTs each to a local
 * URL; this module runs it and receives them, so a tag arrives in seconds.
 *
 *   - opt in per machine: `paw github forward on [--space s]` records `forward: {space}` in github-config.json;
 *     the MAILBOX of that space runs it (always up, one per space, already hosts the artil relay; the keeper is a
 *     one-shot 60s tick and cannot hold a stream). GitHub allows ONE forward per org, so one machine, one space.
 *   - the receiver listens on 127.0.0.1 (random port) and drops anything whose `X-Hub-Signature-256` is not the
 *     HMAC of a random secret paw keeps 0600 in `$PAW_HOME/secrets/github-forward.secret` (never logged; it is on
 *     gh's argv, which only this user's processes can read).
 *   - comment/review/review-comment/issue/PR bodies are scanned for `@<org>/<slug>`; each slug maps to the hosted
 *     agents whose team it is (the poller's map, {@link teamSeats}); the DM is the poller's ("you were tagged by …"),
 *     the id is claimed in the poller's `teams.seen` under the store lock, so a tag is sent exactly once whichever
 *     side sees it first. Tags by the agent's own bot or `github:` login are skipped, like the poller.
 *   - a comment or review on a PR the relay follows also triggers one relay sweep (`poke`), so PR followers hear
 *     it in seconds too (the sweep itself is unchanged and deduped by its own cursors).
 *   - gh exiting is restarted with backoff (5s doubling to 5 min), logged once per streak; "a hook already exists"
 *     (another forward for this org, anywhere) is said plainly. Health goes to `<PAW_HOME>/github-forward.json`
 *     (src/github-forward-status.ts): while it is up the keeper polls only to reconcile; otherwise at the old pace.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { readConfig, type GithubConfig } from "./github-app.ts";
import { writeForwardStatus, type ForwardState, type ForwardStatus } from "./github-forward-status.ts";
import { hostedSeats, prKey, readStore, teamSeats, updateStore, type PrKey } from "./github-relay.ts";
import { LIST_EVERY_MS, listTeams, mentionText, SEEN_MAX, seenId, taggedSlugs, type Rest, type Team } from "./github-teams.ts";

export const FORWARD_EVENTS = ["issue_comment", "pull_request_review", "pull_request_review_comment", "issues", "pull_request"];
export const RECEIVER_PATH = "/github";
const BODY_MAX = 26 << 20; // GitHub caps a delivery at 25 MB
const BACKOFF_MIN_MS = 5_000;
const BACKOFF_MAX_MS = 5 * 60_000;
const RESCAN_MS = 30_000;
const BEAT_MS = 30_000;
const POKE_DEBOUNCE_MS = 3_000;

const pawHomeDir = (): string => process.env.PAW_HOME?.trim() || join(homedir(), ".paw");
export const secretPath = (): string => join(pawHomeDir(), "secrets", "github-forward.secret");

/** The receiver's signing secret, made (64 hex chars, 0600, dir 0700) on first use. */
export function ensureSecret(): string {
  const p = secretPath();
  if (!existsSync(p)) {
    mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
    chmodSync(dirname(p), 0o700);
    writeFileSync(p, randomBytes(32).toString("hex") + "\n", { mode: 0o600, flag: "wx" });
  }
  chmodSync(p, 0o600);
  const s = readFileSync(p, "utf8").trim();
  if (!/^[0-9a-f]{64}$/.test(s)) throw new Error(`paw github: ${p} is not a forwarder secret — remove it (paw makes a new one)`);
  return s;
}

export function signatureOk(secret: string, body: Buffer, header: string | undefined): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const want = Buffer.from(`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`);
  const got = Buffer.from(header);
  return got.length === want.length && timingSafeEqual(got, want);
}

export interface Tag {
  /** The poller's dedupe id ({@link seenId}). */
  id: string;
  /** The id the poller wrote before 2026-11-25, when the payload has it (a PR body's issue id it has not). */
  legacy?: string;
  slug: string;
  repo: string;
  number: number;
  login: string;
  url: string;
}

interface Userish {
  login?: string;
}
interface Bodyish {
  id?: number;
  body?: string | null;
  html_url?: string;
  user?: Userish | null;
}

/** The team tags one delivery carries, and the PR it is about (for the PR followers' sweep). */
export function tagsOf(event: string, p: Record<string, unknown>, org: string): { tags: Tag[]; pr?: PrKey } {
  const repo = (p.repository as { full_name?: string } | undefined)?.full_name;
  const action = p.action as string | undefined;
  if (!repo) return { tags: [] };
  type Kind = "ic" | "rc" | "rv" | "is";
  const pick = (): { thing?: Bodyish; kind?: Kind; number?: number; isPr: boolean } => {
    const issue = p.issue as (Bodyish & { number?: number; pull_request?: unknown }) | undefined;
    const pull = p.pull_request as (Bodyish & { number?: number }) | undefined;
    const edit = action === "created" || action === "edited";
    if (event === "issue_comment" && edit) return { thing: p.comment as Bodyish, kind: "ic", number: issue?.number, isPr: !!issue?.pull_request };
    if (event === "pull_request_review_comment" && edit) return { thing: p.comment as Bodyish, kind: "rc", number: pull?.number, isPr: true };
    if (event === "pull_request_review" && (action === "submitted" || action === "edited")) return { thing: p.review as Bodyish, kind: "rv", number: pull?.number, isPr: true };
    if (event === "issues" && (action === "opened" || action === "edited")) return { thing: issue, kind: "is", number: issue?.number, isPr: false };
    if (event === "pull_request" && (action === "opened" || action === "edited")) return { thing: pull, kind: "is", number: pull?.number, isPr: true };
    return { isPr: false };
  };
  const { thing, kind, number, isPr } = pick();
  if (!thing || !kind || typeof thing.id !== "number" || typeof number !== "number" || !thing.html_url) return { tags: [] };
  const pr = isPr && event !== "pull_request" ? prKey(repo, number) : undefined;
  const login = thing.user?.login ?? "a deleted account";
  const tags = taggedSlugs(thing.body, org).map((slug) => {
    const ids = seenId(kind, thing.id!, repo, number, slug);
    // A PR's pull id is not the issue id the poller once keyed its body by: no legacy id for it.
    const legacy = event === "pull_request" ? undefined : ids.legacy;
    return { id: ids.id, ...(legacy ? { legacy } : {}), slug, repo, number, login, url: thing.html_url! };
  });
  return { tags, ...(pr ? { pr } : {}) };
}

export interface ForwardDeps {
  send: (space: string, agent: string, text: string) => Promise<void>;
  log: (line: string) => void;
  machineOf: (space: string) => string;
  /** The `gh` binary (resolved lazily: a missing gh is a loud line, not a crashed mailbox). */
  gh: () => string;
  rest: () => Rest;
  /** One relay sweep now (PR followers); absent = PR events wait for the keeper. */
  poke?: () => Promise<void>;
  config?: () => GithubConfig;
  now?: () => number;
  rescanMs?: number;
  beatMs?: number;
  backoffMinMs?: number;
  backoffMaxMs?: number;
}

/** The org's team list: the poller's copy while fresh, else read now and kept for it. */
async function teamList(org: string, deps: ForwardDeps, now: number): Promise<Team[]> {
  const st = readStore().teams;
  if (st?.org === org && st.listedAt && now - st.listedAt < LIST_EVERY_MS) return st.teams;
  const teams = await listTeams(deps.rest(), org);
  updateStore((s) => {
    s.teams = s.teams?.org === org ? { ...s.teams, teams, listedAt: now } : { org, teams, listedAt: now, lastPoll: 0, next: 0, cursors: {}, seen: [] };
  });
  return teams;
}

/** Deliver one event's tags: claim each id once in the shared seen set, then DM; a failed send goes to the outbox. */
export async function deliverTags(org: string, tags: Tag[], deps: ForwardDeps): Promise<number> {
  if (!tags.length) return 0;
  const now = (deps.now ?? Date.now)();
  const config = (deps.config ?? readConfig)();
  const bySlug = teamSeats(hostedSeats(deps.machineOf).seats, await teamList(org, deps, now), config);
  let sent = 0;
  for (const t of tags) {
    const e = bySlug.get(t.slug);
    if (!e) continue; // a team no agent hosted here stands for
    if (e.target.self.some((s) => s.toLowerCase() === t.login.toLowerCase())) continue;
    const claimed = updateStore((s) => {
      if (!s.teams || s.teams.org !== org) s.teams = { org, teams: [], listedAt: 0, lastPoll: 0, next: 0, cursors: {}, seen: [] };
      if (s.teams.seen.includes(t.id) || (t.legacy && s.teams.seen.includes(t.legacy))) return false;
      s.teams.seen = [...s.teams.seen, t.id].slice(-SEEN_MAX);
      return true;
    });
    if (!claimed) continue;
    deps.log(`github: @${org}/${t.slug} tagged by ${t.login} in ${t.repo}#${t.number} (webhook)`);
    const text = mentionText(t);
    for (const seat of e.seats) {
      try {
        await deps.send(seat.space, seat.agent, text);
        sent++;
        deps.log(`github: ${t.repo}#${t.number} → ${seat.agent}#${seat.space}`);
      } catch (err) {
        const lastError = (err as Error).message;
        deps.log(`github: ${t.repo}#${t.number} → ${seat.agent}#${seat.space} failed (${lastError}); queued for the keeper`);
        updateStore((s) => void s.outbox.push({ space: seat.space, agent: seat.agent, pr: prKey(t.repo, t.number), text, attempts: 1, lastError }));
      }
    }
  }
  return sent;
}

export interface Receiver {
  port: number;
  close: () => Promise<void>;
}

/** The local endpoint gh POSTs to: 127.0.0.1 only, signature checked before anything is parsed. */
export function startReceiver(secret: string, onEvent: (event: string, payload: Record<string, unknown>) => void, log: (line: string) => void): Promise<Receiver> {
  const server: Server = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== RECEIVER_PATH) {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > BODY_MAX) req.destroy();
      else chunks.push(c);
    });
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      if (!signatureOk(secret, body, req.headers["x-hub-signature-256"] as string | undefined)) {
        log(`github: webhook delivery REJECTED: bad or missing signature (${req.headers["x-github-event"] ?? "no event"})`);
        res.writeHead(401).end("bad signature");
        return;
      }
      const event = String(req.headers["x-github-event"] ?? "");
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(body.toString("utf8"));
      } catch {
        log(`github: webhook delivery ${event}: body is not JSON — dropped`);
        res.writeHead(400).end("not json");
        return;
      }
      res.writeHead(202).end("ok");
      if (event !== "ping") onEvent(event, payload);
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") return reject(new Error("receiver has no port"));
      resolve({ port: addr.port, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

const CONFLICT = /already exists|already (?:being )?forward|already active/i;
const NO_ACCESS = /do not have access to this feature|admin:org_hook|HTTP 403|HTTP 404/i;

/** Run the forwarder for `space`'s mailbox while `paw github forward on` names this space; returns its stop. */
export function startGithubForward(space: string, deps: ForwardDeps): () => Promise<void> {
  const now = () => (deps.now ?? Date.now)();
  const minMs = deps.backoffMinMs ?? BACKOFF_MIN_MS;
  const maxMs = deps.backoffMaxMs ?? BACKOFF_MAX_MS;
  let org: string | undefined;
  let receiver: Receiver | undefined;
  let starting: Promise<void> | undefined;
  let child: ChildProcess | undefined;
  let retry: NodeJS.Timeout | undefined;
  let fails = 0;
  let saidStreak = false;
  let saidKind = "";
  let saidConfig = "";
  let ended = false;
  let status: ForwardStatus | undefined;
  let queue = Promise.resolve();
  let pokeTimer: NodeJS.Timeout | undefined;

  const setStatus = (state: ForwardState, note?: string) => {
    const t = now();
    const prev = status;
    status = {
      org: org!,
      space,
      state,
      since: prev?.state === state ? prev.since : t,
      beat: t,
      pid: process.pid,
      events: prev?.events ?? 0,
      ...(prev?.lastEvent ? { lastEvent: prev.lastEvent } : {}),
      ...(note ? { note } : {}),
    };
    writeForwardStatus(status);
  };

  const poke = () => {
    if (!deps.poke || pokeTimer) return;
    pokeTimer = setTimeout(() => {
      pokeTimer = undefined;
      deps.poke!().catch((e: Error) => deps.log(`github: PR sweep after a webhook event failed: ${e.message}`));
    }, POKE_DEBOUNCE_MS);
  };

  const onEvent = (event: string, payload: Record<string, unknown>) => {
    if (!org) return;
    const o = org;
    if (status) {
      status = { ...status, events: status.events + 1, lastEvent: now() };
      writeForwardStatus(status);
    }
    queue = queue
      .then(async () => {
        const { tags, pr } = tagsOf(event, payload, o);
        await deliverTags(o, tags, deps);
        if (pr && readStore().prs[pr]) poke();
      })
      .catch((e: Error) => deps.log(`github: webhook ${event} not handled: ${e.message} — the keeper's poll will catch its tags`));
  };

  function run(): void {
    retry = undefined;
    if (ended || !org || !receiver || child) return;
    let gh: string;
    let secret: string;
    try {
      gh = deps.gh();
      secret = ensureSecret();
    } catch (e) {
      return fail((e as Error).message, false);
    }
    const args = ["webhook", "forward", `--org=${org}`, `--events=${FORWARD_EVENTS.join(",")}`, `--url=http://127.0.0.1:${receiver.port}${RECEIVER_PATH}`, `--secret=${secret}`];
    setStatus("starting");
    const c = spawn(gh, args, { stdio: ["ignore", "pipe", "pipe"] });
    child = c;
    let tail = "";
    let over = false;
    c.stdout!.resume();
    createInterface({ input: c.stderr! }).on("line", (line) => {
      tail = `${tail}\n${line}`.slice(-2_000);
      if (/Forwarding Webhook events from GitHub/i.test(line)) {
        if (saidStreak) deps.log(`github: webhook forwarder for ${org} is back up after ${fails} failed start(s)`);
        else deps.log(`github: webhook forwarder for ${org} is up (receiver 127.0.0.1:${receiver?.port})`);
        fails = 0;
        saidStreak = false;
        setStatus("up");
      }
    });
    const end = (why: string) => {
      if (over) return;
      over = true;
      if (child === c) child = undefined;
      if (ended || !org) return;
      const detail = tail.trim().split("\n").slice(-3).join(" | ").replace(secret, "<secret>");
      fail(`gh webhook forward exited (${why})${detail ? `: ${detail}` : ""}`, CONFLICT.test(tail));
    };
    c.on("error", (e) => end(e.message));
    c.on("close", (code, signal) => end(signal ? `signal ${signal}` : `exit ${code}`));
  }

  function fail(why: string, conflict: boolean): void {
    fails++;
    const plain = conflict
      ? `another \`gh webhook forward\` is already active for ${org} (GitHub allows one per org) — stop it, or delete its "cli" dev hook under github.com/organizations/${org}/settings/hooks; team tags are polled meanwhile`
      : NO_ACCESS.test(why)
        ? `${why} — the gh login needs the admin:org_hook scope on ${org} (\`gh auth refresh -s admin:org_hook\`); team tags are polled meanwhile`
        : `${why}; team tags are polled until it is back`;
    const kind = conflict ? "conflict" : NO_ACCESS.test(why) ? "access" : "down";
    if (!saidStreak || kind !== saidKind) deps.log(`github: webhook forwarder DOWN: ${plain} (retrying with backoff, said once until it is up)`);
    saidStreak = true;
    saidKind = kind;
    setStatus(conflict ? "conflict" : "down", why.slice(0, 300));
    const delay = conflict ? maxMs : Math.min(maxMs, minMs * 2 ** Math.min(fails - 1, 16));
    retry = setTimeout(run, delay);
  }

  async function stopAll(state: ForwardState, note?: string): Promise<void> {
    clearTimeout(retry);
    retry = undefined;
    const c = child;
    child = undefined;
    if (c && c.exitCode === null && c.signalCode === null) {
      const gone = new Promise<void>((r) => c.once("close", () => r()));
      c.kill("SIGTERM");
      const hard = setTimeout(() => c.kill("SIGKILL"), 5_000);
      await gone;
      clearTimeout(hard);
    }
    if (receiver) await receiver.close();
    receiver = undefined;
    if (org) setStatus(state, note);
    org = undefined;
    fails = 0;
    saidStreak = false;
  }

  async function tick(): Promise<void> {
    if (ended) return;
    let cfg: GithubConfig;
    try {
      cfg = (deps.config ?? readConfig)();
    } catch (e) {
      const m = `github: webhook forwarder: ${(e as Error).message}`;
      if (m !== saidConfig) deps.log(m);
      saidConfig = m;
      return;
    }
    const wantOrg = cfg.forward?.space === space ? cfg.org : undefined;
    const why = cfg.forward?.space === space && !cfg.org ? "github: webhook forwarder is on for this space but no org is set — `paw github org <org>`" : "";
    if (why !== saidConfig && why) deps.log(why);
    saidConfig = why;
    if (org && org !== wantOrg) {
      deps.log(`github: webhook forwarder for ${org} stopped (${wantOrg ? `org is now ${wantOrg}` : "turned off"})`);
      await stopAll("off");
    }
    if (!wantOrg || ended) return;
    if (!receiver) {
      org = wantOrg;
      receiver = await startReceiver(ensureSecret(), onEvent, deps.log);
    }
    if (!child && !retry) run();
    else if (status) setStatus(status.state, status.note); // heartbeat
  }

  const step = () => {
    starting = (starting ?? Promise.resolve()).then(tick).catch((e: Error) => deps.log(`github: webhook forwarder: ${e.message}`));
  };
  step();
  const scan = setInterval(step, deps.rescanMs ?? RESCAN_MS);
  const beat = setInterval(() => {
    if (status && org && !ended) setStatus(status.state, status.note);
  }, deps.beatMs ?? BEAT_MS);
  return async () => {
    ended = true;
    clearInterval(scan);
    clearInterval(beat);
    clearTimeout(pokeTimer);
    await starting;
    await stopAll("down", "mailbox stopped");
    await queue;
  };
}
