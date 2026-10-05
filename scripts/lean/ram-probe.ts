// RAM probe: hold the ACTIVE conversation of N real transcripts in one node process (exactly what a
// many-agents host keeps resident: the post-compaction message list it sends each turn) and report
// heap/RSS per agent. Read-only on the transcripts.
//
//   node --expose-gc scripts/lean/ram-probe.ts <transcript.jsonl>...
import { statSync } from "node:fs";
import { activeChain, leafOf, readRecords, toMessages, type ApiMessage } from "./session.ts";

const gc = (globalThis as any).gc as (() => void) | undefined;
if (!gc) throw new Error("run with node --expose-gc");
const mb = (n: number) => (n / 2 ** 20).toFixed(1);
const snap = () => { gc(); gc(); return process.memoryUsage(); };

const files = process.argv.slice(2);
if (!files.length) throw new Error("pass transcript paths");
const base = snap();
const held: ApiMessage[][] = [];
let jsonBytes = 0;
for (const f of files) {
  const recs = readRecords(f);
  const msgs = toMessages(activeChain(recs, leafOf(recs)));
  held.push(msgs);
  jsonBytes += Buffer.byteLength(JSON.stringify(msgs));
  console.log(`${f.split("/").pop()}  file ${mb(statSync(f).size)}MB  active ${msgs.length} msgs  ${mb(Buffer.byteLength(JSON.stringify(msgs)))}MB json`);
}
const after = snap();
const heap = after.heapUsed - base.heapUsed;
const ext = after.external + after.arrayBuffers - base.external - base.arrayBuffers;
console.log(`\n${held.length} sessions: heap +${mb(heap)}MB (+${mb(ext)}MB external), rss ${mb(after.rss)}MB total (baseline rss ${mb(base.rss)}MB)`);
console.log(`per session: heap ${mb(heap / held.length)}MB, active-context json ${mb(jsonBytes / held.length)}MB`);
