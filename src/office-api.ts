/**
 * The agent-office REST mirror: `POST <url>/api/o/<office>/<tool>` with `Authorization: Bearer <key>` and,
 * after joining, `X-Agent-Token`. Errors come back as `{error, retryAfter?}`; a 429 carries `retryAfter`
 * (seconds) and `Retry-After`. Nothing here logs a key or token — an error names the tool and the
 * server's message only.
 */
import type { OfficeLink } from "./office-link.ts";

export class OfficeError extends Error {
  readonly status: number;
  /** Seconds to wait, on a 429. */
  readonly retryAfter?: number;
  constructor(status: number, message: string, retryAfter?: number) {
    super(message);
    this.name = "OfficeError";
    this.status = status;
    if (retryAfter !== undefined) this.retryAfter = retryAfter;
  }
}

export type OfficeCall = (tool: string, args: Record<string, unknown>, opts?: { token?: string; key?: string }) => Promise<unknown>;

const TIMEOUT_MS = 15_000;

export function officeClient(link: Pick<OfficeLink, "url" | "office" | "joinKey">, fetchImpl: typeof fetch = fetch): OfficeCall {
  return async (tool, args, opts = {}) => {
    const headers: Record<string, string> = { authorization: `Bearer ${opts.key ?? link.joinKey}`, "content-type": "application/json" };
    if (opts.token) headers["x-agent-token"] = opts.token;
    let res: Response;
    try {
      res = await fetchImpl(`${link.url}/api/o/${link.office}/${tool}`, { method: "POST", headers, body: JSON.stringify(args), signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) {
      throw new OfficeError(0, `office ${tool}: ${link.url} unreachable (${(e as Error).message})`);
    }
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      throw new OfficeError(res.status, `office ${tool}: HTTP ${res.status}, not JSON (${text.slice(0, 120)})`);
    }
    if (!res.ok) {
      const b = (body ?? {}) as { error?: unknown; retryAfter?: unknown };
      const header = Number(res.headers.get("retry-after"));
      const retryAfter = typeof b.retryAfter === "number" ? b.retryAfter : Number.isFinite(header) && header > 0 ? header : undefined;
      throw new OfficeError(res.status, `office ${tool}: HTTP ${res.status} — ${typeof b.error === "string" ? b.error : text.slice(0, 200)}`, res.status === 429 ? (retryAfter ?? 10) : undefined);
    }
    return body;
  };
}
