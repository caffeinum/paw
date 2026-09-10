/**
 * Pure URL router for paw's full-URL addressing. Turns a typed http(s) URL into a plan describing
 * which resolver should execute it — NO IO here (no disk, no network, no clone), so it's hermetically
 * unit-testable (check:url). The IO half (clone / worktree / mkdir) lives in src/address.ts.
 *
 * One ordered data table (ROUTES); first host+path match wins; any unrecognised host is a website
 * (never an error). GitHub owner/repo strings are only string-built here into a `github:` handle —
 * src/github.ts re-validates them against its charset guard when the handle is executed.
 */

export type UrlKind = "repo" | "worktree" | "pr" | "web" | "stub";

export interface UrlPlan {
  kind: UrlKind;
  ghHandle?: string; // repo: "github:owner/repo"
  prNumber?: number; // pr
  owner?: string; // pr / worktree (clone + worktree naming)
  repo?: string; // pr / worktree
  ref?: string; // worktree: the GREEDY ref-or-ref/path candidate captured from a /tree|/blob/ URL —
  //             the IO half (src/address.ts) verifies which prefix is a REAL branch (never creates one).
  webSlug?: string; // web: the canonical host slug
  webUrl?: string; // web: the ORIGINAL typed URL (rides into the brief + first message)
  stub?: string; // the human label for a fail-loud stub ("gitlab MR", …)
}

/** A bare host (no scheme, no path): `react.dev`, `docs.python.org`. Requires at least one dot so a
 *  plain agent name ("web", "my-app") never reads as a host. Lowercase/dash/digit labels only. */
export const HOST_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/** Strip a single trailing `.git` a repo path may carry (github URLs rarely do, but be safe). */
function stripGit(repo: string): string {
  return repo.endsWith(".git") ? repo.slice(0, -".git".length) : repo;
}

/**
 * Canonicalise a website URL to a single per-HOST key: scheme (http/https) is irrelevant, `www.` is
 * stripped, the port/path/query/fragment are all dropped — so `https://react.dev`, `react.dev/`,
 * `http://react.dev`, and `https://www.react.dev/blog?utm=x#frag` ALL collapse to the `react.dev`
 * agent. The originally-typed URL is preserved separately (UrlPlan.webUrl) for the brief. A non-http(s)
 * scheme (file:/ftp:/data:) fails loud — paw addresses websites over http(s).
 */
export function canonicalizeWebUrl(u: URL): string {
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`paw: "${u.href}" is not an http(s) URL — paw addresses websites over http(s)`);
  }
  return u.hostname.toLowerCase().replace(/^www\./, ""); // hostname excludes the port already
}

interface Route {
  host: string; // exact host, after the www. strip
  pattern: RegExp; // tested against the URL pathname
  plan: (m: RegExpMatchArray) => UrlPlan;
}

/** Ordered routing table — first host+pattern match wins. Anything not matched here (any other host,
 *  or an unrecognised path on a listed host) falls through to the website catch-all in routeUrl. */
const ROUTES: Route[] = [
  // GitHub — the REAL resolvers (repo / branch / PR), plus the issue STUB.
  { host: "github.com", pattern: /^\/([^/]+)\/([^/]+)\/pull\/(\d+)/, plan: (m) => ({ kind: "pr", owner: m[1], repo: stripGit(m[2]), prNumber: Number(m[3]) }) },
  { host: "github.com", pattern: /^\/[^/]+\/[^/]+\/issues\/\d+/, plan: () => ({ kind: "stub", stub: "github issue" }) },
  // /tree/<ref>[/…] or /blob/<ref>/<path>: capture the ref GREEDILY (a slashed feature/release branch
  // is common). A URL can't unambiguously split "<ref>/<path>" without the repo's branch list, so the
  // IO half VERIFIES which prefix is a real branch and FAILS LOUD otherwise — a URL-derived ref must
  // never silently `checkout -b` the wrong branch (the fail-loud fix). Hence owner/repo/ref, not a
  // pre-baked #branch handle.
  { host: "github.com", pattern: /^\/([^/]+)\/([^/]+)\/(?:tree|blob)\/(.+)$/, plan: (m) => ({ kind: "worktree", owner: m[1], repo: stripGit(m[2]), ref: m[3] }) },
  { host: "github.com", pattern: /^\/([^/]+)\/([^/]+)\/?$/, plan: (m) => ({ kind: "repo", ghHandle: `github:${m[1]}/${stripGit(m[2])}` }) },
  // Other cloud sources — labeled fail-loud STUBS (constraint 3), one small table row each.
  { host: "gist.github.com", pattern: /^\/[^/]+\/[^/]+/, plan: () => ({ kind: "stub", stub: "gist" }) },
  { host: "gitlab.com", pattern: /\/-\/merge_requests\/\d+/, plan: () => ({ kind: "stub", stub: "gitlab MR" }) },
  { host: "bitbucket.org", pattern: /\/pull-requests\/\d+/, plan: () => ({ kind: "stub", stub: "bitbucket PR" }) },
  { host: "npmjs.com", pattern: /^\/package\//, plan: () => ({ kind: "stub", stub: "npm package" }) },
];

/**
 * Route a raw http(s) URL to a UrlPlan. Throws on a malformed or non-http(s) URL (fail loud); every
 * unrecognised host resolves to a website (never an error). Pure: no IO.
 */
export function routeUrl(raw: string): UrlPlan {
  const u = new URL(raw); // throws (TypeError) on a malformed URL — fail loud
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`paw: "${raw}" is not an http(s) URL — paw addresses websites and repos over http(s)`);
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  for (const r of ROUTES) {
    if (r.host !== host) continue;
    const m = u.pathname.match(r.pattern);
    if (m) return r.plan(m);
  }
  return { kind: "web", webSlug: canonicalizeWebUrl(u), webUrl: raw };
}
