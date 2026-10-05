/**
 * The kit binary these tools drive: $KIT_BIN if set, else a fresh `go build` of the kit repo
 * ($KIT_SRC, default ~/Github/caffeinum/kit) into a temp dir. Fails loud when neither exists.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export function kitBin(): string {
  const bin = process.env.KIT_BIN;
  if (bin) {
    if (!existsSync(bin)) throw new Error(`KIT_BIN=${bin} does not exist`);
    return bin;
  }
  const src = process.env.KIT_SRC ?? join(homedir(), "Github/caffeinum/kit");
  if (!existsSync(join(src, "go.mod"))) throw new Error(`no kit checkout at ${src} — set KIT_SRC or KIT_BIN`);
  const out = join(mkdtempSync(join(tmpdir(), "kit-bin-")), "kit");
  execFileSync("go", ["build", "-o", out, "./cmd/kit"], { cwd: src, stdio: "inherit" });
  return out;
}
