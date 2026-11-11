/**
 * Hermetic check for the sandboxed-sender handoff relay (src/handoff-relay.ts, docs/notes/sandbox.md#handoff).
 * team2027, 2026-11-10: betterstack (sandboxed) could read a token but `handoff --to vercel` died in its VM
 * ("no persona"), because a VM sees neither the personas nor other agents' folders.
 *
 * A throwaway PAW_HOME holds personas + folders; requests are written exactly as the `handoff` script
 * writes them in a VM (`<own folder>/.handoff/.outbox/<id>/{to,name,value[,force]}`). Asserted:
 *   1. a request lands in the recipient's .handoff/NAME, mode 0600 in a 0700 dir, byte-exact; the request
 *      is gone and a receipt `<id>.ok` names it without the value;
 *   2. the log line names sender, recipient, NAME and size — never the value;
 *   3. an existing NAME is refused without `force`, replaced with it;
 *   4. refusals are receipts (`<id>.err`), never a guess: unknown agent, bad name, a recipient on another
 *      machine, a teleported recipient, a missing folder;
 *   5. only SANDBOXED senders on this machine are relayed; a folder two sandboxed agents share is refused once;
 *   6. a dot-named (uncommitted) request is left alone; an old uncollected receipt is swept;
 *   7. `agent#space` reaches another local space.
 * Run: pnpm check:handoff-relay
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "paw-handoff-"));
process.env.PAW_HOME = home;
const { relayTick, OUTBOX } = await import("../src/handoff-relay.ts");

let failures = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};

const SPACE = "test-handoff";
const HERE = "test-mini";
const folders = join(home, "folders");
const persona = (space: string, name: string, fields: Record<string, string>) => {
  const dir = join(home, "spaces", space, "personas");
  mkdirSync(dir, { recursive: true });
  const folder = fields.cwd ?? join(folders, name);
  mkdirSync(folder, { recursive: true });
  const fm = Object.entries({ cwd: folder, ...fields }).map(([k, v]) => `${k}: ${v}`);
  writeFileSync(join(dir, `${name}.md`), `---\n${fm.join("\n")}\n---\n${name}\n`);
  return folder;
};
const SECRET = "tok_live_9f8e7d6c5b4a";
let seq = 0;
const request = (folder: string, to: string, name: string, extra: { force?: boolean; value?: string; dotted?: boolean } = {}) => {
  const id = `r${++seq}`;
  const dir = join(folder, OUTBOX, extra.dotted ? `.tmp-${id}` : id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "to"), `${to}\n`);
  writeFileSync(join(dir, "name"), `${name}\n`);
  writeFileSync(join(dir, "value"), extra.value ?? SECRET, { mode: 0o600 });
  if (extra.force) writeFileSync(join(dir, "force"), "");
  return { id, receipt: (kind: "ok" | "err") => join(folder, OUTBOX, `${id}.${kind}`), dir };
};
const logs: string[] = [];
const tick = () => relayTick(SPACE, HERE, (l) => logs.push(l));
const mode = (p: string) => (statSync(p).mode & 0o777).toString(8);

const sender = persona(SPACE, "betterstack", { sandbox: "container", machine: HERE });
const vercel = persona(SPACE, "vercel", { sandbox: "container", machine: HERE });
persona(SPACE, "elsewhere", { machine: "aleks-macbook" });
persona(SPACE, "gone", { teleported: "fly:app" });
const hostAgent = persona(SPACE, "host", {});
const ghostDir = persona(SPACE, "ghost", {});
rmSync(ghostDir, { recursive: true });
const shared = join(folders, "shared");
persona(SPACE, "twin-a", { sandbox: "container", cwd: shared });
persona(SPACE, "twin-b", { sandbox: "container", cwd: shared });
const otherSpace = persona("test-other", "fly", {});

// 1 + 2: delivery
const r1 = request(sender, "vercel", "BETTERSTACK_LOGS_TOKEN");
ok("one request handled", tick() === 1);
const stored = join(vercel, ".handoff", "BETTERSTACK_LOGS_TOKEN");
ok("value lands in the recipient's .handoff/NAME, byte-exact", existsSync(stored) && readFileSync(stored, "utf8") === SECRET);
ok("file 0600, dir 0700", existsSync(stored) && mode(stored) === "600" && mode(join(vercel, ".handoff")) === "700", existsSync(stored) ? `${mode(stored)} / ${mode(join(vercel, ".handoff"))}` : "missing");
ok("request removed, no claimed leftovers", !existsSync(r1.dir) && readdirSync(join(sender, OUTBOX)).every((e) => !e.startsWith(".claimed")));
const receipt = existsSync(r1.receipt("ok")) ? readFileSync(r1.receipt("ok"), "utf8") : "";
ok("receipt names it, without the value", /stored BETTERSTACK_LOGS_TOKEN → vercel#test-handoff \(\d+ bytes\)/.test(receipt) && !receipt.includes(SECRET), receipt.trim());
ok("log line: sender → recipient NAME (size), never the value", logs.some((l) => l === `[handoff] betterstack → vercel#test-handoff BETTERSTACK_LOGS_TOKEN (${SECRET.length} bytes)`) && logs.every((l) => !l.includes(SECRET)), logs.join(" | "));

// 3: no overwrite unless force
const r2 = request(sender, "vercel", "BETTERSTACK_LOGS_TOKEN", { value: "second" });
tick();
ok("an existing NAME is refused without force", existsSync(r2.receipt("err")) && readFileSync(stored, "utf8") === SECRET, existsSync(r2.receipt("err")) ? readFileSync(r2.receipt("err"), "utf8").trim() : "no receipt");
const r3 = request(sender, "vercel", "BETTERSTACK_LOGS_TOKEN", { value: "second", force: true });
tick();
ok("force replaces it", existsSync(r3.receipt("ok")) && readFileSync(stored, "utf8") === "second" && mode(stored) === "600");

// 4: refusals
const refusal = (to: string, name: string, want: RegExp, label: string) => {
  const r = request(sender, to, name);
  tick();
  const text = existsSync(r.receipt("err")) ? readFileSync(r.receipt("err"), "utf8") : "";
  ok(label, want.test(text) && !existsSync(r.receipt("ok")), text.trim() || "no .err receipt");
};
refusal("nobody", "X", /no agent "nobody#test-handoff" on this machine/, "unknown recipient → refused");
refusal("vercel", "../etc", /bad secret name/, "path-ish secret name → refused");
refusal("elsewhere", "X", /runs on aleks-macbook, not here/, "recipient on another machine → refused");
refusal("gone", "X", /teleported/, "teleported recipient → refused");
refusal("ghost", "X", /folder .* doesn't exist/, "recipient folder missing → refused");
refusal("vercel#bad space", "X", /bad recipient/, "malformed agent#space → refused");

// 5: who may send
logs.length = 0;
const fromHost = request(hostAgent, "vercel", "FROM_HOST");
const fromTwin = request(shared, "vercel", "FROM_TWIN");
tick();
ok("a host (unsandboxed) agent's outbox is not relayed", existsSync(fromHost.dir) && !existsSync(join(vercel, ".handoff", "FROM_HOST")));
const twinErr = existsSync(fromTwin.receipt("err")) ? readFileSync(fromTwin.receipt("err"), "utf8") : "";
ok("a folder shared by two sandboxed agents is refused once, with a receipt", !existsSync(fromTwin.dir) && /shared by several sandboxed agents/.test(twinErr) && !existsSync(join(vercel, ".handoff", "FROM_TWIN")), twinErr.trim());
logs.length = 0;
tick();
ok("…and not re-logged every pass", !logs.some((l) => l.includes("shared")), logs.join(" | "));

// 6: uncommitted requests and stale receipts
const dotted = request(sender, "vercel", "HALF_WRITTEN", { dotted: true });
const old = join(sender, OUTBOX, "r999.ok");
writeFileSync(old, "stored X\n");
const past = (Date.now() - 11 * 60_000) / 1000;
utimesSync(old, past, past);
tick();
ok("a .tmp- (uncommitted) request is left alone", existsSync(dotted.dir) && !existsSync(join(vercel, ".handoff", "HALF_WRITTEN")));
ok("an uncollected receipt older than 10 min is swept", !existsSync(old));

// 7: another local space
const r7 = request(sender, "fly#test-other", "CROSS_SPACE");
tick();
ok("agent#space reaches another local space", existsSync(r7.receipt("ok")) && readFileSync(join(otherSpace, ".handoff", "CROSS_SPACE"), "utf8") === SECRET);

rmSync(home, { recursive: true, force: true });
if (failures) {
  console.error(`\n${failures} handoff relay check(s) failed`);
  process.exit(1);
}
console.log("\nhandoff relay checks passed");
