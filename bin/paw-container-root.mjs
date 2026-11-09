/**
 * Is Apple `container`'s apiserver pointed at the right install root? (docs/notes/sandbox.md#a-wrong-install-root)
 *
 * `container system start` writes `~/Library/Application Support/com.apple.container/apiserver/apiserver.plist`
 * with `CONTAINER_INSTALL_ROOT` derived from the path the CLI was INVOKED by. Run through the symlink
 * `~/.local/bin/container -> ~/.local/opt/container/bin/container` (the mini, 2026-11-06) it recorded `~/.local`,
 * where there are no plugins: the apiserver crash-looped ("cannot find any plugins with type network", 2,400+
 * launchd runs) and every sandboxed wake failed with a `container system status` ETIMEDOUT for ~30 hours.
 *
 * Only ever DIAGNOSES — paw never edits the plist or (re)starts Apple's services. Reading a file works over ssh
 * too, where `container system status` can't see the GUI-domain apiserver.
 *
 * Plain node ESM, no dependencies: imported by bin/paw-sandbox-run.mjs (manager's node) and src/sandbox.ts.
 */
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** The plugin the apiserver can't run without — its absence under the root is the crash loop's cause. */
export const NETWORK_PLUGIN = "container-network-vmnet";

/** Where `container system start` writes the apiserver's launchd plist. */
export function apiserverPlistPath(home = homedir()) {
  return join(home, "Library", "Application Support", "com.apple.container", "apiserver", "apiserver.plist");
}

/** The install root `bin` really lives in: realpath → `<root>/bin/container` → `<root>`. */
export function installRootOf(bin) {
  return dirname(dirname(realpathSync(bin)));
}

export function networkPluginDir(root) {
  return join(root, "libexec", "container", "plugins", NETWORK_PLUGIN);
}

/** The start command that can't record a wrong root: the REAL binary, the root spelled out. */
export function systemStartCommand(root) {
  return `${join(root, "bin", "container")} system start --install-root ${root}`;
}

/** The plist's CONTAINER_INSTALL_ROOT: undefined when there is no plist (services never started here) or it
 *  records none (nothing to judge — never a guessed root); throws when the plist exists but can't be read. */
export function readApiserverInstallRoot(plistPath = apiserverPlistPath()) {
  if (!existsSync(plistPath)) return undefined;
  const r = spawnSync("plutil", ["-convert", "json", "-o", "-", plistPath], { encoding: "utf8", timeout: 10_000 });
  if (r.status !== 0) throw new Error(`paw: can't read ${plistPath} (${(r.stderr || r.error?.message || `plutil exit ${r.status}`).trim()})`);
  let plist;
  try {
    plist = JSON.parse(r.stdout);
  } catch (e) {
    throw new Error(`paw: ${plistPath} did not convert to JSON (${e.message})`);
  }
  const root = plist?.EnvironmentVariables?.CONTAINER_INSTALL_ROOT;
  return typeof root === "string" && root.trim() ? root : undefined;
}

/**
 * The problem with the apiserver's recorded install root, as one actionable message, or undefined when it is
 * fine (or there is no plist to judge). `bin` is the `container` paw would run — undefined when it isn't on
 * this PATH (an ssh shell): the bad root is still named, just without the real one.
 */
export function diagnoseInstallRoot({ bin, plistPath = apiserverPlistPath(), uid = process.getuid?.() }) {
  const recorded = readApiserverInstallRoot(plistPath);
  if (recorded === undefined || existsSync(networkPluginDir(recorded))) return undefined;
  const head =
    `paw: Apple container's apiserver is registered with the wrong install root — ${plistPath} says ` +
    `CONTAINER_INSTALL_ROOT=${recorded}, which has no ${networkPluginDir(recorded)}, so the apiserver crash-loops ` +
    `("cannot find any plugins with type network") and every \`container\` call times out.\n`;
  if (!bin) return head + `  \`container\` is not on this PATH, so paw can't name the real root: it is the realpath of the \`container\` binary minus /bin/container. Fix: \`<root>/bin/container system stop; <root>/bin/container system start --install-root <root>\``;
  const real = installRootOf(bin);
  const realOk = existsSync(networkPluginDir(real));
  const domain = `gui/${uid ?? "$(id -u)"}`;
  return (
    head +
    (realOk
      ? `  \`${bin}\` resolves to ${realpathSync(bin)}, so the install root is ${real}. Fix (paw never edits it itself):\n` +
        `    ${join(real, "bin", "container")} system stop; ${systemStartCommand(real)}\n` +
        `  or edit the plist in place:\n` +
        `    plutil -replace EnvironmentVariables.CONTAINER_INSTALL_ROOT -string '${real}' '${plistPath}' && ` +
        `launchctl bootout ${domain}/com.apple.container.apiserver; launchctl bootstrap ${domain} '${plistPath}'\n` +
        `  (it happens when \`container system start\` runs through a symlink: always invoke the real binary with --install-root)`
      : `  \`${bin}\` resolves to ${realpathSync(bin)}, whose root ${real} has no ${networkPluginDir(real)} either — the install itself is incomplete; reinstall container, then \`<root>/bin/container system start --install-root <root>\``)
  );
}
