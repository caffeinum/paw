/**
 * Daemon-log timestamps (src/log-stamp.ts): the pure line stamper, then a real child process with
 * stdout+stderr on ONE file fd (as lifecycle spawns the daemons), and manager-log.ts still reading a
 * stamped manager.log. Hermetic: a temp dir, no mesh. Run: pnpm check:log-stamp
 */
import { spawn } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { installLogStamp, stampChunk, stripStamp, STAMP_ENV } from "../src/log-stamp.ts";
import { seatDiagnostic, seatExit } from "../src/manager-log.ts";

let failures = 0;
function assert(cond: boolean, msg: string, got?: string): void {
  if (cond) console.log(`  ok  ${msg}`);
  else {
    failures++;
    console.error(`  FAIL  ${msg}${got === undefined ? "" : `\n        got: ${JSON.stringify(got)}`}`);
  }
}

const T = new Date("2026-10-24T01:02:03.456Z");
const P = "2026-10-24T01:02:03.456Z ";
const stamp = (parts: Array<string | Uint8Array>) => {
  const st = { atLineStart: true };
  return Buffer.concat(parts.map((p) => stampChunk(typeof p === "string" ? Buffer.from(p) : p, st, T))).toString("utf8");
};

console.log("stampChunk");
assert(stamp(["a\nb\n"]) === `${P}a\n${P}b\n`, "every line of one write");
assert(stamp(["par", "tial\n", "next"]) === `${P}partial\n${P}next`, "a line split over writes is stamped once");
assert(stamp(["\n\n"]) === `${P}\n${P}\n`, "empty lines still stamped");
assert(stamp(["", "x\n"]) === `${P}x\n`, "an empty write changes nothing");
const snow = Buffer.from("❄ ok\n");
assert(stamp([snow.subarray(0, 2), snow.subarray(2)]) === `${P}❄ ok\n`, "a multibyte char split across writes survives");
assert(stripStamp(`${P}seat reaped: x (U) - y`) === "seat reaped: x (U) - y" && stripStamp("plain") === "plain", "stripStamp");

console.log("installLogStamp");
{
  let threw = false;
  try {
    installLogStamp({ [STAMP_ENV]: "yes" });
  } catch {
    threw = true;
  }
  assert(threw, "a malformed flag fails loud");
  assert(installLogStamp({}) === false, "absent flag: no wrap");
}

console.log("a daemon on a log fd");
const dir = mkdtempSync(join(tmpdir(), "paw-stamp-"));
try {
  const boot = fileURLToPath(new URL("../src/log-stamp-boot.ts", import.meta.url));
  const child = join(dir, "daemon.ts");
  writeFileSync(
    child,
    [
      `import ${JSON.stringify(boot)};`,
      `import { execFileSync } from "node:child_process";`,
      `console.log("hello from stdout");`,
      `console.error("an error line");`,
      `process.stdout.write("half ");`,
      `process.stdout.write("line\\n");`,
      `process.stderr.write(Buffer.from("two\\nlines\\n"));`,
      `process.stdout.write("cb\\n", () => process.stdout.write("after callback\\n"));`,
      `const inherited = execFileSync(process.execPath, ["-e", "process.stdout.write(String(process.env.${STAMP_ENV}))"], { encoding: "utf8" });`,
      `console.log("child sees flag: " + inherited);`,
    ].join("\n"),
  );
  const log = join(dir, "daemon.log");
  writeFileSync(log, "pre-existing unstamped line\n");
  const fd = openSync(log, "a");
  const code = await new Promise<number | null>((resolve) => {
    const p = spawn(process.execPath, [child], { stdio: ["ignore", fd, fd], env: { ...process.env, [STAMP_ENV]: "1" } });
    p.on("exit", resolve);
  });
  closeSync(fd);
  const lines = readFileSync(log, "utf8").split("\n").filter(Boolean);
  const ours = lines.slice(1);
  const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z /;
  assert(code === 0, "child exits 0", String(code));
  assert(lines[0] === "pre-existing unstamped line", "appends; never rewrites what was there");
  assert(ours.length === 8 && ours.every((l) => ISO.test(l)), "every new line has an ISO prefix", ours.join(" | "));
  const text = ours.map(stripStamp);
  assert(
    text.filter((l) => l !== "after callback").join("|") === "hello from stdout|an error line|half line|two|lines|cb|child sees flag: undefined",
    "nothing lost, nothing reordered",
    text.join("|"),
  );
  assert(text.includes("after callback"), "a write callback still fires");
  assert(text.includes("child sees flag: undefined"), "the flag is consumed — the daemon's children don't inherit it");

  const plainLog = join(dir, "plain.log");
  const pfd = openSync(plainLog, "a");
  await new Promise<void>((resolve) => {
    const env = { ...process.env };
    delete env[STAMP_ENV];
    spawn(process.execPath, [child], { stdio: ["ignore", pfd, pfd], env }).on("exit", () => resolve());
  });
  closeSync(pfd);
  assert(readFileSync(plainLog, "utf8").startsWith("hello from stdout\n"), "no flag (a `paw cotal` passthrough, an interactive CLI): output untouched");

  console.log("manager-log on a stamped log");
  const mgr = join(dir, "manager.log");
  writeFileSync(mgr, "");
  const from = 0;
  writeFileSync(mgr, `${P}seat reaped: kit (U1, uid u1, pid 9) - its own process exited and this manager did not stop it; exit code 1, signal 0; diagnostic: boom\n`);
  assert(seatDiagnostic(mgr, "kit", from) === "boom", "seatDiagnostic reads through the stamp");
  assert(seatExit(mgr, "kit", from)?.startsWith("its own process exited") === true, "seatExit reads through the stamp");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall log-stamp checks passed");
