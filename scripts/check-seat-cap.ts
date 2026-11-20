/**
 * The manager seat cap (src/seat-cap.ts): env/file resolution (fail loud), the manager argv, reading it
 * back off a live command line, cotal's refusal marker → paw's problem line, and the smart-restart plan.
 * Pure — no mesh. The live refusal is scripts/e2e-seat-cap.ts. Run: pnpm check:seat-cap
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { seatCapFrom, seatCapRefused } from "@cotal-ai/core";

process.env.PAW_HOME = mkdtempSync(join(tmpdir(), "paw-seatcap-home-"));
delete process.env.PAW_MAX_SEATS;
const S = await import("../src/seat-cap.ts");
const { planRestart } = await import("../src/manager-fingerprint.ts");

let n = 0;
const ok = (c: boolean, m: string) => {
  if (!c) throw new Error(`seat-cap: ${m}`);
  n++;
  console.log(`  ok  ${m}`);
};
const throws = (fn: () => unknown, re?: RegExp) => {
  try {
    fn();
    return false;
  } catch (e) {
    return re ? re.test((e as Error).message) : true;
  }
};

ok(S.resolveSeatCap("s1") === undefined, "nothing set = unlimited");
ok(S.resolveSeatCap("s1", { PAW_MAX_SEATS: "12" }) === 12, "env sets it");
ok(S.resolveSeatCap("s1", { PAW_MAX_SEATS: "unlimited" }) === undefined && S.resolveSeatCap("s1", { PAW_MAX_SEATS: "off" }) === undefined, "env unlimited/off = no cap");
ok(throws(() => S.resolveSeatCap("s1", { PAW_MAX_SEATS: "" }), /set but empty/), "env set-but-empty fails loud");
for (const bad of ["0", "-1", "2.5", "ten", "1e3"]) ok(throws(() => S.resolveSeatCap("s1", { PAW_MAX_SEATS: bad }), /positive integer/), `env ${JSON.stringify(bad)} fails loud`);
const file = S.seatCapPath("s2");
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, "20\n");
ok(S.resolveSeatCap("s2", {}) === 20, "the space's max-seats file sets it");
ok(S.resolveSeatCap("s2", { PAW_MAX_SEATS: "3" }) === 3, "env beats the file");
writeFileSync(file, "lots");
ok(throws(() => S.resolveSeatCap("s2", {}), /max-seats must be/), "a garbage file fails loud naming it");

ok(S.seatCapArgs(undefined).length === 0, "unlimited adds no argv (an uncapped manager's command line is unchanged)");
ok(S.seatCapArgs(4).join(" ") === "--seat-cap 4", "a cap is --seat-cap <n>");
const sup = (extra: string) => `node /x/bin/cotald.ts supervise --space s --server nats://h:1${extra}`;
ok(S.seatCapOfCommands([sup(" --seat-cap 7")]) === 7, "read back off the manager's command line");
ok(S.seatCapOfCommands([sup("")]) === undefined, "no flag = unlimited");
ok(S.seatCapOfCommands(["node mailbox.ts --space s", sup(" --runtime tmux --seat-cap 2")]) === 2, "only the supervise line counts");

// cotal's refusal: resource-exhausted + the ai.cotal.ep.seat-cap marker, which control.ts's replyOf carries.
const refused = seatCapRefused("owner local holds 2 of the 2 seats …", { owner: "local", seats: 2, cap: 2 });
const facts = seatCapFrom(refused);
ok(refused.code === "resource-exhausted" && facts?.seats === 2 && facts.cap === 2 && facts.owner === "local", "cotal's marker carries owner/seats/cap");
const line = S.seatCapRefusal({ space: "team2027", name: "kit", facts: { owner: "local", seats: 2, cap: 2 }, defaultSpace: false });
ok(line.startsWith("✕ couldn't start kit — "), "refusal is a ✕ problem line naming the agent");
ok(/seat cap \(2 of 2 live agents\)/.test(line) && /nothing was launched/.test(line), "says the count and that nothing launched");
ok(/paw stop <name> --space team2027/.test(line) && /paw restart --full --space team2027/.test(line), "names both ways out, with the space");
ok(/1 of 1 live agent\)/.test(S.seatCapRefusal({ space: "s", name: "a", facts: { owner: "local", seats: 1, cap: 1 }, defaultSpace: true })), "singular");

const facts0 = {
  full: false,
  pendingRevive: false,
  managerPids: [1],
  managerRoot: "/r/a",
  targetRoot: "/r/a",
  runningRuntime: "pty",
  preferredRuntime: "pty",
  releaseOf: () => "a",
  fingerprintOf: () => "f",
  managerAnswers: async () => true,
};
ok((await planRestart(facts0)).kind === "keep-manager", "same code, no caps → smart restart keeps the manager");
ok((await planRestart({ ...facts0, runningSeatCap: 5, preferredSeatCap: 5 })).kind === "keep-manager", "same cap → keeps the manager");
const changed = await planRestart({ ...facts0, runningSeatCap: 5, preferredSeatCap: undefined });
ok(changed.kind === "full" && /seat cap 5/.test(changed.why), "a changed cap → full restart, naming it");

console.log(`✓ check:seat-cap — ${n} assertions`);
