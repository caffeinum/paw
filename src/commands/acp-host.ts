/**
 * `paw acp-host [install]` — the Rust seat host `agent: acp` agents run on by default (src/acp-host.ts).
 *  - no args: where paw expects it and whether it is installed.
 *  - `install`: cargo-build it from the pinned cotal-connector-acp commit (ACP_HOST_REV, a `git archive`
 *    of it — never the working tree) into $PAW_HOME/bin. Running seats keep their binary until they restart.
 * LOCAL — files only, no mesh.
 */
import { registry, type Command } from "@cotal-ai/core";
import { ACP_HOST_INSTALL, ACP_HOST_REV, acpHostBinPath, acpHostRepo, installAcpHost, isExecutable } from "../acp-host.ts";

const USAGE = "acp-host [install]";

async function acpHost(raw: string[]): Promise<void> {
  // The binary is per PAW_HOME, not per space: the dispatcher's injected --space is not ours to read.
  const argv = raw.filter((a, i) => a !== "--space" && raw[i - 1] !== "--space");
  if (argv.length === 0) {
    const bin = acpHostBinPath();
    // The same test the spawn gate applies (resolveAcpHost): an executable regular file, not mere existence.
    console.log(
      isExecutable(bin)
        ? `✓ ${bin} (cotal-connector-acp ${ACP_HOST_REV.slice(0, 12)})`
        : `✗ ${bin} missing or not executable — \`${ACP_HOST_INSTALL}\` builds cotal-connector-acp ${ACP_HOST_REV.slice(0, 12)} from ${acpHostRepo()}`,
    );
    return;
  }
  if (argv.length === 1 && argv[0] === "install") {
    console.log(`✓ installed ${installAcpHost()}`);
    return;
  }
  throw new Error(`paw: ${USAGE}`);
}

const acpHostCommand: Command = {
  kind: "command",
  name: "acp-host",
  group: "Lifecycle",
  summary: "the Rust seat host acp agents run on: show, or install (cargo build of the pinned plugin commit) into $PAW_HOME/bin",
  usage: USAGE,
  run: (a) => acpHost([...a.raw]),
};

registry.register(acpHostCommand);
