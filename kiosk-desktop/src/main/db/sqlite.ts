/**
 * The kiosk's local database: one SQLite file (WAL, synchronous=FULL — a fiscal counter is on
 * disk before it is used).
 *
 * Engine: Node's built-in `node:sqlite` (DatabaseSync), which ships inside Electron's Node — no
 * native module to rebuild per Electron version, nothing downloaded at install, a smaller
 * installer. Its API is the same synchronous shape as better-sqlite3 (prepare → run/get/all), so
 * better-sqlite3 can replace it behind this adapter without touching any caller.
 */

export type SqlValue = string | number | bigint | null | Uint8Array;

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface Db {
  exec(sql: string): void;
  run(sql: string, ...params: SqlValue[]): RunResult;
  get<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): T | undefined;
  all<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): T[];
  /** `fn` in one transaction (nested calls join the outer one). */
  tx<T>(fn: () => T): T;
  close(): void;
  readonly path: string;
}

interface StatementLike {
  run(...params: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: SqlValue[]): unknown;
  all(...params: SqlValue[]): unknown[];
}

interface DatabaseLike {
  exec(sql: string): void;
  prepare(sql: string): StatementLike;
  close(): void;
}

type DatabaseCtor = new (path: string) => DatabaseLike;

function loadEngine(): DatabaseCtor {
  const mod = process.getBuiltinModule?.('node:sqlite') as { DatabaseSync?: DatabaseCtor } | undefined;
  if (mod?.DatabaseSync) return mod.DatabaseSync;
  throw new Error('node:sqlite is not available in this runtime (Node ≥ 22.13 / Electron ≥ 35 required)');
}

export function openDb(path: string): Db {
  const Ctor = loadEngine();
  const raw = new Ctor(path);
  const cache = new Map<string, StatementLike>();
  const prep = (sql: string): StatementLike => {
    let s = cache.get(sql);
    if (!s) {
      s = raw.prepare(sql);
      cache.set(sql, s);
    }
    return s;
  };
  let depth = 0;
  if (path !== ':memory:') {
    raw.exec('PRAGMA journal_mode = WAL');
  }
  raw.exec('PRAGMA synchronous = FULL');
  raw.exec('PRAGMA foreign_keys = ON');
  raw.exec('PRAGMA busy_timeout = 5000');

  const db: Db = {
    path,
    exec: (sql) => raw.exec(sql),
    run: (sql, ...params) => {
      const r = prep(sql).run(...params);
      return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
    },
    get: <T,>(sql: string, ...params: SqlValue[]) => (prep(sql).get(...params) as T | undefined) ?? undefined,
    all: <T,>(sql: string, ...params: SqlValue[]) => prep(sql).all(...params) as T[],
    tx: <T,>(fn: () => T): T => {
      if (depth > 0) {
        depth++;
        try {
          return fn();
        } finally {
          depth--;
        }
      }
      raw.exec('BEGIN IMMEDIATE');
      depth = 1;
      try {
        const out = fn();
        raw.exec('COMMIT');
        return out;
      } catch (e) {
        try {
          raw.exec('ROLLBACK');
        } catch {
          /* already rolled back */
        }
        throw e;
      } finally {
        depth = 0;
      }
    },
    close: () => {
      cache.clear();
      raw.close();
    },
  };
  return db;
}
