/**
 * Where a hermes agent's Hermes profile lives — a leaf module (no cotal connector import), so the CLI
 * side (addressing, log, status) can name it without registering cotal's hermes connector in its
 * process. The connector itself is src/hermes.ts.
 */
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { readHermesHome } from "./session.ts";

export const HERMES_AGENT = "hermes";

/** Hermes' profile-id pattern (hermes_cli/profiles.py `_PROFILE_ID_RE`). */
const PROFILE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** paw's Hermes root: the parent of every paw-owned profile. Never the operator's `~/.hermes`. */
export function hermesRoot(): string {
  return join(process.env.PAW_HOME?.trim() || join(homedir(), ".paw"), "hermes");
}

/** The venv uv provisions cotal's project-pinned hermes-agent into, shared by every paw hermes agent. Its
 *  `bin/hermes` is the CLI to inspect or log in a paw profile with — the version that reads it. */
export function hermesVenv(): string {
  return join(hermesRoot(), "venv");
}

/** The Hermes profile id paw gives an agent: `<space>-<name>`, made legal for Hermes (lowercase,
 *  `[a-z0-9_-]`, ≤64) — with a digest suffix whenever that changed it, so two names never share one. */
export function hermesProfileId(space: string, name: string): string {
  const plain = `${space}-${name}`;
  if (PROFILE_ID_RE.test(plain)) return plain;
  const digest = createHash("sha256").update(`${space}\0${name}`).digest("hex").slice(0, 8);
  const cleaned = plain.toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 55);
  return `${cleaned || "p"}-${digest}`;
}

/** The profile a hermes agent runs in: the persona's `hermesHome:` (an adopted profile), else paw's own. */
export function hermesHomeFor(configPath: string | undefined, space: string, name: string): string {
  return readHermesHome(configPath) || join(hermesRoot(), "profiles", hermesProfileId(space, name));
}
