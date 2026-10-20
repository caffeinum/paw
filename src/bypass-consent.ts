/**
 * Claude Code's one-time "Bypass Permissions mode" consent, recorded before paw launches a seat in it.
 *
 * paw launches every claude with `--permission-mode bypassPermissions` (PAW_PERMISSION aside). On a
 * machine where bypass was never accepted, claude first shows a consent dialog ("In Bypass Permissions
 * mode, Claude Code will not ask for your approval…", default "No, exit"). cotal's startup watch answers
 * only the trust dialog and the dev-channels gate, so it waited 15s for the gate, SIGTERMed the seat and
 * the first agent on a fresh Mac died (caffeinum/paw#1).
 *
 * Where claude keeps the answer (verified in the 2.1.304 binary): accepting the dialog calls
 * `updateSettings("userSettings", {skipDangerousModePermissionPrompt: true})` — the USER settings file,
 * `$CLAUDE_CONFIG_DIR/settings.json` (default `~/.claude/settings.json`). The dialog renders only while
 * no user/local/flag/policy settings carry that flag. The older `bypassPermissionsModeAccepted` in
 * ~/.claude.json is a legacy key claude migrates into the settings flag and then deletes.
 *
 * paw always runs bypass (operator rule), so it pre-accepts the dialog the way src/cwd.ts pre-accepts
 * folder trust: a plain flag, written atomically, the rest of the file preserved.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { withFileLock } from "./lock.ts";

/** Claude Code's permission modes — PAW_PERMISSION must be one of these (fail loud otherwise). */
const PERMISSION_MODES = ["default", "acceptEdits", "bypassPermissions", "plan"] as const;

/**
 * Default permission mode for paw agents. They run unattended on your repos, so they must not
 * block on tool-approval prompts — hence `bypassPermissions`. Override per process with
 * PAW_PERMISSION (one of PERMISSION_MODES) to put a human back in the loop. An unknown value
 * throws rather than passing a bad mode through to claude with a misleading "launching" notice.
 */
export function permissionMode(): string {
  const override = process.env.PAW_PERMISSION?.trim();
  if (!override) return "bypassPermissions";
  if (!(PERMISSION_MODES as readonly string[]).includes(override)) {
    throw new Error(`paw: PAW_PERMISSION="${override}" is not a valid permission mode (expected one of: ${PERMISSION_MODES.join(", ")})`);
  }
  return override;
}

/** Does this claude argv launch in bypass mode? claude takes the LAST `--permission-mode`, and
 *  `--dangerously-skip-permissions` is bypass whatever the mode says. */
export function launchesBypass(args: readonly string[]): boolean {
  if (args.includes("--dangerously-skip-permissions")) return true;
  const i = args.lastIndexOf("--permission-mode");
  return i !== -1 && args[i + 1] === "bypassPermissions";
}

/** The argv paw hands a managed claude, as far as the mode goes: paw's mode, then the persona's own
 *  `claudeArgs:` (appended last by the connector, so they win). */
export function managedLaunchesBypass(claudeArgs: readonly string[]): boolean {
  return launchesBypass(["--permission-mode", permissionMode(), ...claudeArgs]);
}

/** Claude Code's USER settings file: `$CLAUDE_CONFIG_DIR/settings.json`, else `~/.claude/settings.json`. */
export function claudeUserSettingsPath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR?.trim();
  if (dir && !isAbsolute(dir)) {
    throw new Error(`paw: CLAUDE_CONFIG_DIR="${dir}" is not absolute — claude resolves a relative one per folder, so paw cannot know which settings.json it reads`);
  }
  return join(dir || join(homedir(), ".claude"), "settings.json");
}

export const BYPASS_CONSENT_KEY = "skipDangerousModePermissionPrompt";

/** Has claude's bypass consent been recorded in the user settings file? */
export function hasBypassConsent(): boolean {
  const file = claudeUserSettingsPath();
  if (!existsSync(file)) return false;
  return readSettings(file)[BYPASS_CONSENT_KEY] === true;
}

function readSettings(file: string): Record<string, unknown> {
  const raw = readFileSync(file, "utf8");
  let parsed: unknown;
  try {
    parsed = raw.trim() === "" ? {} : JSON.parse(raw);
  } catch (e) {
    throw new Error(`paw: ${file} is not valid JSON (${(e as Error).message}); refusing to record claude's bypass-permissions consent in it — fix the file, or run \`claude --permission-mode bypassPermissions\` once and accept`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`paw: ${file} is not a JSON object; refusing to record claude's bypass-permissions consent in it`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Record claude's bypass consent (`skipDangerousModePermissionPrompt: true`) in the user settings file
 * so a paw seat never meets the dialog. Idempotent (no write when already set), creates the file when
 * claude has never run, preserves every other key and the file's mode, serialized against concurrent
 * paw spawns, atomic (temp + rename). Returns true when it wrote.
 */
export function ensureBypassConsent(): boolean {
  const file = claudeUserSettingsPath();
  mkdirSync(dirname(file), { recursive: true });
  return withFileLock(`${file}.paw-lock`, () => {
    const exists = existsSync(file);
    const settings = exists ? readSettings(file) : {};
    if (settings[BYPASS_CONSENT_KEY] === true) return false;
    settings[BYPASS_CONSENT_KEY] = true;
    const tmp = `${file}.paw-${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, { mode: exists ? statSync(file).mode & 0o777 : 0o644 });
    renameSync(tmp, file);
    console.error(`paw: recorded Claude Code's bypass-permissions consent (${BYPASS_CONSENT_KEY}: true) in ${file} — paw agents run --permission-mode bypassPermissions unattended`);
    return true;
  });
}
