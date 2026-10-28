/**
 * Which module self-registers each `paw` verb, so bin/paw.ts loads ONLY the module for the verb being
 * run. Evaluating all ~43 command modules up front cost every invocation ~165ms (native node) and ~2s
 * under tsx; a verb's own module plus its imports is a fraction of that.
 *
 * Every registered verb must be listed under the module that DEFINES it (scripts/check-dispatch.ts
 * loads each entry alone in a fresh process and compares the full set against `loadAllCommands()`).
 * A verb missing here still runs — bin/paw.ts falls back to loading every module — just slower.
 */
type Loader = () => Promise<unknown>;

const claude: Loader = () => import("./claude.ts"); // "claude" (real claude in this terminal, mesh-wired)
const chat: Loader = () => import("./chat.ts"); // "chat" (message it — REPL; --fresh births a new agent)
const open: Loader = () => import("./open.ts"); // "open" + "attach" (attach its terminal)
const adopt: Loader = () => import("./adopt.ts"); // "adopt" (resume a past claude session)
const rename: Loader = () => import("./rename.ts"); // "rename" (relabel an agent, keep its session)
const rm: Loader = () => import("./rm.ts"); // "rm" (forget an agent; always keeps its transcript)
const persona: Loader = () => import("./persona.ts"); // "persona" (show/reroll/backfill personalities)
const status: Loader = () => import("./status.ts"); // "status" (durability + two-writer health view)
const sessions: Loader = () => import("./sessions.ts"); // "sessions" (a folder's transcripts)
const log: Loader = () => import("./log.ts"); // "log" (read an agent's transcript directly)
const inbox: Loader = () => import("./inbox.ts"); // "inbox" (read your DM inbox)
const dm: Loader = () => import("./dm.ts"); // "dm" (fire-and-forget DM as "you")
const mailbox: Loader = () => import("./mailbox.ts"); // "mailbox" daemon (persistent "you" presence beacon)
const stop: Loader = () => import("./commands/stop.ts"); // "stop" (folder-aware control-plane stop)
const unstick: Loader = () => import("./commands/unstick.ts"); // "unstick" (Esc into a stuck tmux agent)
const type: Loader = () => import("./commands/type.ts"); // "type" (type into a tmux agent's terminal)
const msg: Loader = () => import("./commands/msg.ts"); // "msg" (one-shot channel broadcast)
const ask: Loader = () => import("./commands/ask.ts"); // "ask" (one-shot role anycast)
const who: Loader = () => import("./commands/who.ts"); // "who" (live roster)
const history: Loader = () => import("./commands/history.ts"); // "history" (channel/DM backlog)
const bind: Loader = () => import("./commands/bind.ts"); // "bind" (Telegram bind code)
const files: Loader = () => import("./commands/files.ts"); // "files" (files endpoints shared on #files)
const watch: Loader = () => import("./commands/watch.ts"); // "watch" (live tap of the space)
const runtime: Loader = () => import("./commands/runtime.ts"); // "runtime" + "restart"
const hub: Loader = () => import("./commands/hub.ts"); // "hub" (sticky cotal-hub mode)
const release: Loader = () => import("./commands/release.ts"); // "release" (snapshot the checkout)
const mcp: Loader = () => import("./commands/mcp.ts"); // "mcp" (which MCP servers agents get)
const launchd: Loader = () => import("./commands/launchd.ts"); // "launchd" (fleet + web at login)
const global: Loader = () => import("./global.ts"); // "global" (the always-on $HOME machine agent)
const sleep: Loader = () => import("./sleep.ts"); // "sleep" (opt-in hibernation)
const start: Loader = () => import("./start.ts"); // "start" (cold-start the registered fleet)
const teleport: Loader = () => import("./teleport.ts"); // "teleport" + hidden "__teleport"
const move: Loader = () => import("./move.ts"); // "move" (an agent to another space on this machine)
const optimize: Loader = () => import("./commands/optimize.ts"); // "optimize" (restart long-running idle agents)
const top: Loader = () => import("./commands/top.ts"); // "top" (per-agent memory/cpu/subprocesses)
const tidy: Loader = () => import("./commands/tidy.ts"); // "tidy" (DM agents holding background processes)
const cron: Loader = () => import("./commands/cron.ts"); // "cron" (scheduled wake-ups for agents)
const nice: Loader = () => import("./commands/nice.ts"); // "nice" (per-agent CPU priority)
const acpHost: Loader = () => import("./commands/acp-host.ts"); // "acp-host" (the Rust ACP seat host)
const mesh: Loader = () => import("./commands/mesh.ts"); // "mesh" (spaces on a remote broker)
const spaces: Loader = () => import("./commands/spaces.ts"); // "spaces" (broker streams per space)
const web: Loader = () => import("./web.ts"); // "web" (local http+ws UI)
const complete: Loader = () => import("./commands/complete.ts"); // "completion" + hidden "__complete"

/** verb → the module that registers it. */
export const COMMAND_LOADERS: Readonly<Record<string, Loader>> = {
  claude,
  chat,
  open,
  attach: open,
  adopt,
  rename,
  rm,
  persona,
  status,
  sessions,
  log,
  inbox,
  dm,
  mailbox,
  stop,
  unstick,
  type,
  msg,
  ask,
  who,
  history,
  bind,
  files,
  watch,
  runtime,
  restart: runtime,
  hub,
  release,
  mcp,
  launchd,
  global,
  sleep,
  start,
  teleport,
  __teleport: teleport,
  move,
  optimize,
  top,
  tidy,
  cron,
  nice,
  "acp-host": acpHost,
  mesh,
  spaces,
  web,
  completion: complete,
  __complete: complete,
};

/** Verbs that read the WHOLE registry, not just their own command (completion lists every verb). */
const NEEDS_EVERY_COMMAND = new Set(["completion", "__complete"]);

/** Every command module, in the order they always registered. */
export async function loadAllCommands(): Promise<void> {
  for (const load of new Set(Object.values(COMMAND_LOADERS))) await load();
}

/** Load what `verb` needs: its own module, or every module when it reads the whole registry, has no
 *  entry here (help, an unknown word — which then fails loud on the full list) or is missing one. */
export async function loadCommandsFor(verb: string | undefined): Promise<void> {
  const own = verb !== undefined && !NEEDS_EVERY_COMMAND.has(verb) && Object.hasOwn(COMMAND_LOADERS, verb) ? COMMAND_LOADERS[verb] : undefined;
  if (own) await own();
  else await loadAllCommands();
}
