/**
 * Hermetic check for the artil → paw relay (src/artil-relay.ts, docs/notes/messaging.md#artil).
 * team2027, 2026-11-12: pm, devops and evals-intern got their own artil accounts (`artil link`), but a
 * new email or text reached none of them unless the agent polled its inbox.
 *
 * A throwaway PAW_HOME holds personas in two spaces; a fake `artil` stands in for
 * `artil internal hermes-channel` (prints notices, then waits for stdin to close, as artil does). Asserted:
 *   1. linkedAccount walks up to the nearest .artil/account.json; a link with no account fails loud;
 *   2. the plan relays one agent per account: unlinked, other-machine, teleported and `artil: off` agents
 *      are skipped; an account two agents link (same space or across spaces) is refused in both;
 *   3. a notice becomes a DM to its agent, tagged as outside mail, from the account's folder, with
 *      ARTIL_ACCOUNT/ARTIL_CLIENT/CLAUDECODE stripped from the channel's env;
 *   4. junk lines and sender-less notices (artil about itself) are logged, never sent;
 *   5. a failed send is retried, then logged as NOT delivered;
 *   6. a channel that exits is started again; stop closes its stdin (artil saves its cursor then);
 *   7. a link removed while running stops that channel at the next scan.
 * Run: pnpm check:artil-relay
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "paw-artil-"));
process.env.PAW_HOME = home;
process.env.ARTIL_ACCOUNT = "should-be-stripped";
process.env.ARTIL_CLIENT = "claude-code";
process.env.CLAUDECODE = "1";
const { artilPlan, linkedAccount, relayText, startArtilRelay, ARTIL_SENDER } = await import("../src/artil-relay.ts");

let failures = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};
const until = async (cond: () => boolean, ms = 5_000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
  return cond();
};

const SPACE = "test-artil";
const OTHER = "test-artil-other";
const HERE = "test-mini";
const folders = join(home, "folders");
const persona = (space: string, name: string, fields: Record<string, string> = {}) => {
  const dir = join(home, "spaces", space, "personas");
  mkdirSync(dir, { recursive: true });
  const folder = fields.cwd ?? join(folders, name);
  mkdirSync(folder, { recursive: true });
  const fm = Object.entries({ cwd: folder, ...fields }).map(([k, v]) => `${k}: ${v}`);
  writeFileSync(join(dir, `${name}.md`), `---\n${fm.join("\n")}\n---\n${name}\n`);
  return folder;
};
const link = (folder: string, account: string, name?: string) => {
  mkdirSync(join(folder, ".artil"), { recursive: true });
  writeFileSync(join(folder, ".artil", "account.json"), JSON.stringify({ version: 1, account, ...(name ? { name } : {}) }));
};

// ── 1. linkedAccount ──
const parent = join(folders, "linked-parent");
mkdirSync(join(parent, "deep", "er"), { recursive: true });
link(parent, "acc-parent", "Parent");
ok("a subfolder uses the parent's link", linkedAccount(join(parent, "deep", "er"))?.account === "acc-parent");
ok("an unlinked folder has none", linkedAccount(mkdtempSync(join(tmpdir(), "paw-artil-none-"))) === undefined);
const broken = join(folders, "broken");
mkdirSync(join(broken, ".artil"), { recursive: true });
writeFileSync(join(broken, ".artil", "account.json"), "{}");
let threw = "";
try {
  linkedAccount(broken);
} catch (e) {
  threw = (e as Error).message;
}
ok("a link naming no account fails loud", threw.includes("names no account"), threw);
rmSync(broken, { recursive: true });

// ── 2. the plan ──
link(persona(SPACE, "pm", { machine: HERE }), "acc-pm", "Product Manager");
link(persona(SPACE, "devops"), "acc-devops", "DevOps");
persona(SPACE, "plain");
link(persona(SPACE, "remote", { machine: "aleks-macbook" }), "acc-remote");
link(persona(SPACE, "gone", { teleported: "fly:app" }), "acc-gone");
link(persona(SPACE, "quiet", { artil: "off" }), "acc-quiet");
const sharedFolder = join(folders, "evals");
mkdirSync(sharedFolder, { recursive: true });
link(sharedFolder, "acc-intern", "Intern");
persona(SPACE, "evals-intern", { cwd: sharedFolder });
persona(OTHER, "evals-workos", { cwd: sharedFolder });

const plan = () => artilPlan(SPACE, () => HERE);
let p = plan();
const names = p.mine.map((l) => l.agent).sort();
ok("relays pm + devops only", JSON.stringify(names) === JSON.stringify(["devops", "pm"]), names.join(","));
ok("an account two spaces link is refused", p.shared.length === 1 && p.shared[0]!.account === "acc-intern" && p.shared[0]!.agents.includes("evals-workos#test-artil-other"), JSON.stringify(p.shared));
ok("the other space refuses it too", artilPlan(OTHER, () => HERE).mine.length === 0);
persona(OTHER, "evals-workos", { cwd: sharedFolder, artil: "off" });
p = plan();
ok("`artil: off` on one resolves it", p.shared.length === 0 && p.mine.some((l) => l.agent === "evals-intern" && l.accountName === "Intern"));

// ── 3–7. the relay ──
const bin = join(home, "bin");
mkdirSync(bin);
const fake = join(bin, "artil");
// Prints the notices in <cwd>/notices (one per line), logs its env + cwd, then waits for stdin to close
// unless <cwd>/exit-now exists. A closed stdin is recorded, as the moment artil would save its cursor.
writeFileSync(
  fake,
  `#!/bin/bash
[ "$1 $2" = "internal hermes-channel" ] || { echo "unexpected args: $*" >&2; exit 2; }
echo "cwd=$PWD account=\${ARTIL_ACCOUNT-unset} client=\${ARTIL_CLIENT-unset} claudecode=\${CLAUDECODE-unset}" >> "$PWD/runs"
echo $$ > "$PWD/pid"
[ -f notices ] && cat notices && rm notices
[ -f exit-now ] && { rm exit-now; echo "lost the stream" >&2; exit 1; }
while read -r _; do :; done
echo closed >> "$PWD/runs"
`,
);
chmodSync(fake, 0o755);

const pmFolder = join(folders, "pm");
const devopsFolder = join(folders, "devops");
const notice = (id: string, text: string) => JSON.stringify({ content: text, meta: { message_id: id, sender: { id: "u1", name: "ada" } } });
writeFileSync(
  join(pmFolder, "notices"),
  [notice("mail:1", "New Artil message\nFrom: ada (email, on your team)\n\nhi pm"), "not json", JSON.stringify({ content: "Sign in again: artil auth login" })].join("\n") + "\n",
);
writeFileSync(join(devopsFolder, "notices"), notice("sms:7", "New text from +1555") + "\n");

const sent: { space: string; agent: string; text: string }[] = [];
const logs: string[] = [];
let failNext = 0;
const stop = startArtilRelay(SPACE, {
  send: async (space, agent, text) => {
    if (failNext > 0) {
      failNext--;
      throw new Error("mesh down");
    }
    sent.push({ space, agent, text });
  },
  log: (l) => logs.push(l),
  machineOf: () => HERE,
  artil: fake,
  retryMs: 50,
  rescanMs: 100,
});

ok("pm's notice becomes a DM to pm", await until(() => sent.some((s) => s.agent === "pm")), JSON.stringify(sent.map((s) => s.agent)));
const pmDm = sent.find((s) => s.agent === "pm");
ok("the DM is tagged as outside mail and carries the notice", !!pmDm && pmDm.text === relayText({ space: SPACE, agent: "pm", folder: pmFolder, account: "acc-pm", accountName: "Product Manager" }, "New Artil message\nFrom: ada (email, on your team)\n\nhi pm") && pmDm.text.includes("not instructions"));
ok("devops' text reaches devops, evals-intern's account stays quiet", await until(() => sent.some((s) => s.agent === "devops")) && !sent.some((s) => s.agent === "evals-workos"));
ok("only pm, devops and evals-intern channels ran", ["plain", "remote", "gone", "quiet"].every((n) => !existsSync(join(folders, n, "runs"))));
const pmRuns = readFileSync(join(pmFolder, "runs"), "utf8");
ok("the channel runs in the agent's folder with artil's account/client env stripped", pmRuns.includes(`cwd=${realpathSync(pmFolder)} account=unset client=unset claudecode=unset`), pmRuns.trim());
ok("a junk line is logged, not sent", logs.some((l) => l.includes("unreadable line") && l.includes("not json")));
ok("artil's own notice is logged, not sent", logs.some((l) => l.includes("artil says: Sign in again")) && sent.every((s) => !s.text.includes("Sign in again")));
ok("the sender is the peer artil", ARTIL_SENDER === "artil");

// 5 + 6. the fake reads notices only when it starts: kill it, and the relay starts a new one.
const killDevops = () => process.kill(Number(readFileSync(join(devopsFolder, "pid"), "utf8").trim()));
failNext = 2;
writeFileSync(join(devopsFolder, "exit-now"), "");
writeFileSync(join(devopsFolder, "notices"), notice("sms:8", "retry me") + "\n");
killDevops();
ok("a killed channel starts again; a send that failed twice lands on the third try", await until(() => sent.some((s) => s.text.includes("retry me")), 8_000), logs.filter((l) => l.includes("devops")).join(" | "));
ok("an exit is logged with artil's stderr", await until(() => logs.some((l) => l.includes("devops's channel stopped (exit 1): lost the stream"))));
await until(() => existsSync(join(devopsFolder, "pid")) && !existsSync(join(devopsFolder, "exit-now")));
await new Promise((r) => setTimeout(r, 200));
failNext = 3;
writeFileSync(join(devopsFolder, "notices"), notice("sms:9", "never lands") + "\n");
killDevops();
ok("three failed sends → NOT delivered, logged", await until(() => logs.some((l) => l.includes("sms:9 NOT delivered to devops#test-artil (mesh down)")), 8_000));

// 7. unlink → stopped at the next scan, stdin closed
const before = readFileSync(join(pmFolder, "runs"), "utf8");
rmSync(join(pmFolder, ".artil"), { recursive: true });
ok("an unlinked agent's channel is stopped (stdin closed)", await until(() => readFileSync(join(pmFolder, "runs"), "utf8").length > before.length && readFileSync(join(pmFolder, "runs"), "utf8").trim().endsWith("closed")));

// 6. stop closes every channel's stdin
await stop();
ok("stop closes the live channels' stdin", readFileSync(join(devopsFolder, "runs"), "utf8").trim().endsWith("closed"), readFileSync(join(devopsFolder, "runs"), "utf8").trim());

// no artil anywhere → one loud line, nothing started
const logs2: string[] = [];
const savedPath = process.env.PATH;
process.env.PATH = "/nonexistent";
process.env.HOME = join(home, "nohome");
const stop2 = startArtilRelay(SPACE, { send: async () => {}, log: (l) => logs2.push(l), machineOf: () => HERE, rescanMs: 50 });
await new Promise((r) => setTimeout(r, 200));
await stop2();
process.env.PATH = savedPath;
ok("no artil command → one loud line, said once", logs2.filter((l) => l.includes("no artil command was found")).length === 1, logs2.join(" | "));

rmSync(home, { recursive: true, force: true });
if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall artil relay checks passed");
