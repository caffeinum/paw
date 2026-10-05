/**
 * Read parity: the Go ClaudeLoader (`lean dump`) against scripts/lean/session.ts (verified against
 * claude 2.1.289's own --resume requests). Each transcript is COPIED to a temp dir first — the Go
 * loader takes a lock file next to the transcript, and nothing may touch a live one.
 *
 *   node lean/tools/parity.ts <lean-binary> <transcript.jsonl>…
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { activeChain, leafOf, readRecords, toMessages } from "../../scripts/lean/session.ts";

const [bin, ...files] = process.argv.slice(2);
if (!bin || !files.length) throw new Error("usage: node lean/tools/parity.ts <lean-binary> <transcript.jsonl>…");

type Sig = string;
function tsSigs(path: string): Sig[] {
  const recs = readRecords(path);
  return toMessages(activeChain(recs, leafOf(recs))).map((m) => {
    const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
    const parts = blocks
      .filter((b) => !(b.type === "text" && !String(b.text ?? "").length))
      .map((b) => {
        if (b.type === "tool_use") return `call:${b.id}`;
        if (b.type === "tool_result") return `result:${b.tool_use_id}`;
        if (b.type === "thinking" || b.type === "redacted_thinking") return "reasoning";
        return "text";
      });
    return `${m.role}[${parts.join(",")}]`;
  }).filter((s) => !s.endsWith("[]"));
}
function goSigs(path: string): Sig[] {
  const msgs = JSON.parse(execFileSync(bin, ["dump", path], { encoding: "utf8", maxBuffer: 1 << 30 })) as Array<{ role: string; blocks: Array<{ kind: string; call_id?: string }> }>;
  return msgs.map((m) => `${m.role}[${m.blocks.map((b) => (b.kind === "tool_call" ? `call:${b.call_id}` : b.kind === "tool_result" ? `result:${b.call_id}` : b.kind)).join(",")}]`);
}

let bad = 0;
for (const f of files) {
  const dir = mkdtempSync(join(tmpdir(), "lean-parity-"));
  const copy = join(dir, basename(f));
  copyFileSync(f, copy);
  try {
    const a = tsSigs(copy);
    const b = goSigs(copy);
    const at = a.findIndex((s, i) => s !== b[i]);
    const same = a.length === b.length && at === -1;
    if (!same) bad++;
    console.log(`${same ? "✓" : "✗"} ${basename(f)}: ts ${a.length} msgs, go ${b.length} msgs${same ? "" : ` — first diff at ${at === -1 ? Math.min(a.length, b.length) : at}: ts=${a[at]?.slice(0, 160)} go=${b[at]?.slice(0, 160)}`}`);
  } catch (e) {
    bad++;
    console.log(`✗ ${basename(f)}: ${(e as Error).message.split("\n")[0]}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
process.exit(bad ? 1 : 0);
