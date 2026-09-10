/**
 * Read-only sqlite that works under BOTH runtimes the CLI uses.
 *
 * `node:sqlite` is Node 22+ and bun 1.3 has no such builtin (`No such built-in module: node:sqlite`
 * — `paw log personal-grok` under the bun launcher). bun has `bun:sqlite` instead, which node does
 * not. Static-importing either one crashes the other runtime at load. Require the one that exists.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

type Stmt = { all: (...params: unknown[]) => unknown[] };
type RawDb = { prepare: (sql: string) => Stmt; close: () => void };

export type ReadonlySqlite = {
  all: (sql: string, ...params: unknown[]) => unknown[];
  close: () => void;
};

export function openReadonlySqlite(path: string): ReadonlySqlite {
  if (!existsSync(path)) throw new Error(`paw: no sqlite db at ${path}`);
  const db = open(path);
  return {
    all(sql: string, ...params: unknown[]): unknown[] {
      const stmt = db.prepare(sql);
      return params.length ? stmt.all(...params) : stmt.all();
    },
    close: () => db.close(),
  };
}

function open(path: string): RawDb {
  if (typeof process.versions.bun === "string") {
    const { Database } = require("bun:sqlite") as { Database: new (p: string, o?: { readonly?: boolean }) => RawDb };
    return new Database(path, { readonly: true });
  }
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (p: string, o?: { readOnly?: boolean; timeout?: number }) => RawDb;
  };
  return new DatabaseSync(path, { readOnly: true, timeout: 1000 });
}
