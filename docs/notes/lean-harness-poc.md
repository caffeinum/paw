# lean harness PoC → kit (moved 2026-10-05)

Index: [CLAUDE.md](../../CLAUDE.md). Background: [lean-harness.md](lean-harness.md).

The Go prototype that continued Claude Code sessions with codex and grok over the cotal mesh
(formerly `lean/` in this repo) is now its own repo, **kit**: `~/Github/caffeinum/kit`
(`github.com/caffeinum/kit`, local only). Its README carries the full write-up that used to live
here: results, the Go-vs-node RAM numbers, architecture, tool mapping, auth, live-run lessons.

- The cotal client it uses is `~/Github/caffeinum/cotal-go` (`github.com/caffeinum/cotal-go`).
- CLI: `kit run|once|dump`, `kit auth [status]`, `kit auth codex|grok`; `--provider codex|grok`.
  Tokens in `~/.kit/auth.json` (`KIT_HOME`), or borrowed read-only from codex/opencode.
- The TS checks stay in paw because they drive paw and its TS session reader:
  `scripts/lean/kit/{e2e-kit,parity,resume-check,node-baseline,sniff-cotal}.ts`. They use `$KIT_BIN`
  or `go build` the kit repo (`$KIT_SRC`). `sniff-cotal.ts` is cotal-go's wire re-verification
  tool — re-run it plus `e2e-kit.ts` on every cotal bump.
