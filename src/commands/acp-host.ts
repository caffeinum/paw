/**
 * `paw acp-host [install]` — the Rust seat host `agent: acp` agents run on by default (src/acp-host.ts).
 *  - no args: where paw expects it and whether it is installed.
 *  - `install`: cargo-build it from the cotal-connector-acp checkout and install it into $PAW_HOME/bin
 *    (also the upgrade). Running seats keep their old binary until they restart.
 * LOCAL — files only, no mesh.
 */
import { existsSync } from "node:fs";
import { registry, type Command } from "@cotal-ai/core";
import { ACP_HOST_INSTALL, acpHostBinPath, acpHostSrc, installAcpHost } from "../acp-host.ts";

const USAGE = "acp-host [install]";

async function acpHost(raw: string[]): Promise<void> {
  // The binary is per PAW_HOME, not per space: the dispatcher's injected --space is not ours to read.
  const argv = raw.filter((a, i) => a !== "--space" && raw[i - 1] !== "--space");
  if (argv.length === 0) {
    const bin = acpHostBinPath();
    console.log(existsSync(bin) ? `✓ ${bin}` : `✗ ${bin} missing — \`${ACP_HOST_INSTALL}\` builds it from ${acpHostSrc()}`);
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
  summary: "the Rust seat host acp agents run on: show, or install (cargo build) into $PAW_HOME/bin",
  usage: USAGE,
  run: (a) => acpHost([...a.raw]),
};

registry.register(acpHostCommand);
