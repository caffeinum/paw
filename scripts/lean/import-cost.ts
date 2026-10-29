// Dev aid: cumulative import cost of chat's graph, in load order (each line = the extra ms that module
// added on top of what was already loaded). Run under the runtime you care about:
//   bun scripts/lean/import-cost.ts      node scripts/lean/import-cost.ts
const mods = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["@cotal-ai/core", "../../src/addressing.ts", "../../src/lifecycle.ts", "../../src/control.ts", "../../src/log.ts", "../../src/status.ts", "../../src/chat-tasks.ts", "../../src/tasks.ts", "../../src/address.ts", "../../src/agent-summary.ts", "../../src/markdown.ts", "../../src/human-inbox.ts", "../../src/chat-own.ts", "../../src/commands/who.ts", "../../src/chat.ts"];
const t0 = performance.now();
for (const m of mods) {
  const t = performance.now();
  await import(m);
  console.log(`${String(Math.round(performance.now() - t)).padStart(5)}ms  ${m}`);
}
console.log(`${String(Math.round(performance.now() - t0)).padStart(5)}ms  total`);
