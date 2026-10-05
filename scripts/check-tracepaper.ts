/** check:tracepaper — the direct-HTTP rewrite of the tracepaper MCP entry (src/tracepaper-direct.ts). Hermetic. */
import { mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "paw-tp-"));
process.env.PAW_HOME = home;
const { readTracepaperUrl, routeTracepaperDirect, tracepaperUrlPath } = await import("../src/tracepaper-direct.ts");

let n = 0;
const ok = (c: boolean, m: string) => {
  if (!c) throw new Error(`✗ ${m}`);
  n++;
};

const bridge = { command: "bun", args: ["run", "tracepaper"] };
const cotal = { command: "shim", args: ["sock"] };

// inline config
const a = ["--strict-mcp-config", "--mcp-config", JSON.stringify({ mcpServers: { cotal, tracepaper: bridge } })];
ok(routeTracepaperDirect(a, "http://127.0.0.1:4321/mcp", "/w/repo"), "inline: rewritten");
const ca = JSON.parse(a[2]).mcpServers;
ok(ca.tracepaper.type === "http" && ca.tracepaper.url === "http://127.0.0.1:4321/mcp" && ca.tracepaper.headers["x-tracepaper-cwd"] === "/w/repo", "inline: http entry with the agent's folder");
ok(JSON.stringify(ca.cotal) === JSON.stringify(cotal), "inline: other servers untouched");

// file config keeps 0600
const f = join(home, "mcp.json");
writeFileSync(f, JSON.stringify({ mcpServers: { cotal, tracepaper: bridge } }), { mode: 0o600 });
const b = ["--mcp-config", f];
ok(routeTracepaperDirect(b, "http://x/mcp", "/w/b"), "file: rewritten");
ok(JSON.parse(readFileSync(f, "utf8")).mcpServers.tracepaper.headers["x-tracepaper-cwd"] === "/w/b", "file: folder header");
ok((statSync(f).mode & 0o777) === 0o600, "file: stays 0600");

// no tracepaper entry (shareTools excluded it) / no config
const c = ["--mcp-config", JSON.stringify({ mcpServers: { cotal } })];
ok(!routeTracepaperDirect(c, "http://x/mcp", "/w") && !JSON.parse(c[1]).mcpServers.tracepaper, "no entry: left alone");
ok(!routeTracepaperDirect(["-p"], "http://x/mcp", "/w"), "no --mcp-config: no-op");

// the opt-in file
ok(readTracepaperUrl("s") === undefined, "no file: bridge mode");
mkdirSync(join(home, "spaces", "s"), { recursive: true });
writeFileSync(tracepaperUrlPath("s"), "http://127.0.0.1:4321/mcp\n");
ok(readTracepaperUrl("s") === "http://127.0.0.1:4321/mcp", "file: url read, trimmed");
writeFileSync(tracepaperUrlPath("s"), "yes please");
let threw = false;
try {
  readTracepaperUrl("s");
} catch {
  threw = true;
}
ok(threw, "garbage file: fails loud");

console.log(`tracepaper direct: ${n} checks passed 🐾`);
