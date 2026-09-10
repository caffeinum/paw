# paw public-repo readiness — 2026-09-09 (updated after resume)

The cold-start container subagent died on a usage limit before finishing. Static pass landed;
install path was then rewired (beads-6bfz) rather than adding `prepare: tsc`.

## What's already fine
- **No secrets tracked.** No API keys/tokens, no `.env`, no `auth.json`/`.pem`/creds in `git ls-files`.
- **No functional hard-coded paths.** All `/Users/aleks` matches in `src/`|`bin/`|`web/` are in
  COMMENTS (incident narratives) or `scripts/check-*.ts` test fixtures — none in shipping code paths.
- Node engine pinned (`>=22`), `type: module`, `packageManager: pnpm@11.1.2`.
- **LICENSE** = Apache-2.0 (`LICENSE` file + `package.json` `license`).
- **Package bin** is `./bin/paw.mjs` (committed node shim → tsx → `bin/paw.ts`). `dist/` stays
  gitignored. A clone does not need a build. `prepare: tsc` was rejected: `REPO_ROOT` from
  `dist/src/release.js` would resolve to `dist/`, and daemons spawn tsx from `daemonRoot()` anyway.
- **README quickstart** is clone + `pnpm install` + `pnpm paw release` + `pnpm paw chat .`.
  `paw release` is load-bearing (no pin → fail loud). `@cotal-ai/*` arrives via pnpm — no
  separate `get.cotal.ai` install.

## Still gating before flipping public
1. **Repo is private.** `npx github:caffeinum/paw` / a stranger clone fails until the operator
   flips visibility.
2. **`/Users/aleks` in COMMENTS** — cosmetic, not functional.
3. **Container repro** of the two-line clone path — still unrun (subagent died on usage).

## Not paw's to do unattended
- Flipping repo visibility to public.

## Shipped 2-line quickstart
```bash
git clone https://github.com/caffeinum/paw && cd paw && pnpm install && pnpm paw release
pnpm paw chat .
```
