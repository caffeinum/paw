/**
 * caffeinum/paw#1: the first agent on a fresh Mac died at claude's one-time "Bypass Permissions mode"
 * consent dialog, and `paw dm` said only "its process is gone".
 *
 *   CONSENT     ensureBypassConsent records `skipDangerousModePermissionPrompt: true` in claude's USER
 *               settings ($CLAUDE_CONFIG_DIR/settings.json, else ~/.claude/settings.json): created when
 *               absent, other keys + file mode kept, idempotent, malformed JSON refused untouched
 *   MODE        launchesBypass/managedLaunchesBypass read the argv the way claude does
 *   CLAUDE      the installed claude (when on PATH) still writes that key on accept and gates on it
 *   DIAGNOSTIC  seatDiagnostic reads the manager's `diagnostic:` for THIS spawn's seat only
 *
 * Hermetic: a temp HOME and CLAUDE_CONFIG_DIR; the operator's ~/.claude is never read or written.
 * Run: pnpm check:bypass-consent
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = realpathSync(mkdtempSync(join(tmpdir(), "pawbypass-")));
process.env.HOME = join(root, "home");
mkdirSync(process.env.HOME, { recursive: true });
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.PAW_PERMISSION;

const { ensureBypassConsent, hasBypassConsent, claudeUserSettingsPath, launchesBypass, managedLaunchesBypass, BYPASS_CONSENT_KEY } = await import("../src/bypass-consent.ts");
const { logOffset, seatDiagnostic } = await import("../src/manager-log.ts");

let fails = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) fails++;
};
const throws = (fn: () => unknown): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (e) {
    return (e as Error).message;
  }
};
const read = (f: string) => JSON.parse(readFileSync(f, "utf8"));

// ── CONSENT ───────────────────────────────────────────────────────────────────────────────────────
const homeSettings = join(process.env.HOME, ".claude", "settings.json");
ok("default path is ~/.claude/settings.json under HOME", claudeUserSettingsPath() === homeSettings, claudeUserSettingsPath());
ok("fresh machine: no consent", !hasBypassConsent());
ok("fresh machine: ensure writes", ensureBypassConsent() === true);
ok("fresh machine: settings.json created with the key", existsSync(homeSettings) && read(homeSettings)[BYPASS_CONSENT_KEY] === true);
ok("consent now read back", hasBypassConsent());
ok("idempotent: second ensure does not write", ensureBypassConsent() === false);

const cfg = join(root, "cfg");
process.env.CLAUDE_CONFIG_DIR = cfg;
const cfgSettings = join(cfg, "settings.json");
ok("CLAUDE_CONFIG_DIR moves the settings file", claudeUserSettingsPath() === cfgSettings);
mkdirSync(cfg, { recursive: true });
const existing = { model: "opus", permissions: { allow: ["Bash(ls:*)"] }, env: { FOO: "1" }, [BYPASS_CONSENT_KEY]: false };
writeFileSync(cfgSettings, JSON.stringify(existing));
chmodSync(cfgSettings, 0o600);
ok("an explicit false is not consent", !hasBypassConsent());
ok("existing file: ensure writes", ensureBypassConsent() === true);
const after = read(cfgSettings);
ok("existing file: the key is set", after[BYPASS_CONSENT_KEY] === true);
ok("existing file: every other key preserved", JSON.stringify({ ...after, [BYPASS_CONSENT_KEY]: false }) === JSON.stringify(existing), JSON.stringify(after));
ok("existing file: mode preserved", (statSync(cfgSettings).mode & 0o777) === 0o600, (statSync(cfgSettings).mode & 0o777).toString(8));
ok("no temp or lock file left behind", !readFileSync(cfgSettings, "utf8").includes("paw-") && !existsSync(`${cfgSettings}.paw-${process.pid}.tmp`) && !existsSync(`${cfgSettings}.paw-lock`));

writeFileSync(cfgSettings, "{ not json");
const bad = throws(() => ensureBypassConsent());
ok("malformed settings.json refused loudly", !!bad && bad.includes(cfgSettings), bad);
ok("malformed settings.json left untouched", readFileSync(cfgSettings, "utf8") === "{ not json");
writeFileSync(cfgSettings, "[1,2]");
ok("a non-object settings.json refused", !!throws(() => ensureBypassConsent()));
writeFileSync(cfgSettings, "");
ok("an empty settings.json is treated as {}", ensureBypassConsent() === true && read(cfgSettings)[BYPASS_CONSENT_KEY] === true);

process.env.CLAUDE_CONFIG_DIR = "relative/dir";
ok("a relative CLAUDE_CONFIG_DIR fails loud", !!throws(() => claudeUserSettingsPath()));
delete process.env.CLAUDE_CONFIG_DIR;

// ── MODE ──────────────────────────────────────────────────────────────────────────────────────────
ok("bypass mode detected", launchesBypass(["--model", "opus", "--permission-mode", "bypassPermissions"]));
ok("the LAST --permission-mode wins", !launchesBypass(["--permission-mode", "bypassPermissions", "--permission-mode", "plan"]));
ok("--dangerously-skip-permissions is bypass", launchesBypass(["--permission-mode", "default", "--dangerously-skip-permissions"]));
ok("no mode at all is not bypass", !launchesBypass(["--model", "opus"]));
ok("paw's default launch is bypass", managedLaunchesBypass([]));
ok("persona claudeArgs can opt out", !managedLaunchesBypass(["--permission-mode", "acceptEdits"]));
process.env.PAW_PERMISSION = "default";
ok("PAW_PERMISSION=default is not bypass", !managedLaunchesBypass([]));
process.env.PAW_PERMISSION = "bogus";
ok("an invalid PAW_PERMISSION throws", !!throws(() => managedLaunchesBypass([])));
delete process.env.PAW_PERMISSION;

// ── CLAUDE: the installed binary still keeps consent where paw writes it ──────────────────────────
const which = spawnSync("sh", ["-c", "command -v claude"], { encoding: "utf8" });
const claudeBin = which.status === 0 ? which.stdout.trim() : "";
if (!claudeBin) {
  console.log("- claude not on PATH: binary drift check skipped");
} else {
  const bin = readFileSync(realpathSync(claudeBin)).toString("latin1");
  ok("claude's accept handler writes skipDangerousModePermissionPrompt to userSettings", /"userSettings",\{skipDangerousModePermissionPrompt:!0\}/.test(bin));
  ok("claude's dialog text is the one paw pre-accepts", bin.includes("In Bypass Permissions mode, Claude Code will not ask for your ap"));
}

// ── DIAGNOSTIC ────────────────────────────────────────────────────────────────────────────────────
const log = join(root, "manager.log");
ok("a missing log has offset 0", logOffset(log) === 0);
ok("a missing log yields no diagnostic", seatDiagnostic(log, "first", 0) === undefined);
appendFileSync(log, `seat reaped: first (UOLD, uid u1, pid 1) - it exited; exit code 1; diagnostic: an OLD death\n`);
const from = logOffset(log);
ok("only lines from before the spawn: nothing", seatDiagnostic(log, "first", from) === undefined);
const CONFIRM = `Cotal startup confirmation failed: prompt "WARNING: Loading development channels" did not appear within 15000ms.`;
appendFileSync(
  log,
  [
    `some unrelated line`,
    `seat reaped: notfirst (UX, uid u2, pid 2) - it exited; exit code 1; diagnostic: someone else's`,
    `seat reaped: first (UNEW, uid u3, pid 3) - its process exited; exit code unknown, signal SIGTERM; diagnostic: ${CONFIRM}`,
    `seat reaped: other (UY, uid u4) - it exited; exit detail unavailable from runtime "tmux"`,
    ``,
  ].join("\n"),
);
ok("this spawn's diagnostic is read", seatDiagnostic(log, "first", from) === CONFIRM, seatDiagnostic(log, "first", from));
ok("a sibling name never matches", seatDiagnostic(log, "irst", from) === undefined);
ok("a seat with no diagnostic yields none", seatDiagnostic(log, "other", from) === undefined);
const from2 = logOffset(log);
appendFileSync(log, `spawn failed: second exited on launch - last output: Bypass Permissions mode; diagnostic: SIGTERM after the confirm timeout\n`);
ok("the 'exited on launch' form is read", seatDiagnostic(log, "second", from2) === "SIGTERM after the confirm timeout");

console.log(fails ? `\n${fails} check(s) failed` : "\nall bypass-consent checks passed");
process.exit(fails ? 1 : 0);
