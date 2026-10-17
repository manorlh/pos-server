/**
 * The kiosk's local database: one SQLite file (WAL, synchronous=FULL — a fiscal counter is on
 * disk before it is used).
 *
 * Engine: Node's built-in `node:sqlite` (DatabaseSync), which ships inside Electron's Node — no
 * native module to rebuild per Electron version, nothing downloaded at install, a smaller
 * installer. Its API is the same synchronous shape as better-sqlite3 (prepare → run/get/all), so
 * better-sqlite3 can replace it behind this adapter without touching any caller.
 *
 * The Windows 7 build (Electron 22 = Node 16.17, P:/specs/windows7-till.md) has no `node:sqlite`: there the
 * engine is better-sqlite3 (prebuilt for Electron 22, in that installer's node_modules) — `betterSqliteEngine`.
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

/** better-sqlite3's statement: `reader` says whether it returns rows (get / all refuse a statement that does not). */
interface BetterStatement {
  readonly reader: boolean;
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface BetterDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): BetterStatement;
  close(): unknown;
}

/** better-sqlite3 binds a blob only as a Buffer; node:sqlite takes any Uint8Array. */
function bindable(params: SqlValue[]): unknown[] {
  return params.map((p) => (p instanceof Uint8Array && !Buffer.isBuffer(p) ? Buffer.from(p.buffer, p.byteOffset, p.byteLength) : p));
}

/**
 * better-sqlite3 behind node:sqlite's shape — the Windows 7 build (Electron 22, Node 16.17) has no `node:sqlite`.
 * Same SQLite file, same SQL; a statement that returns no rows answers get / all with nothing, as node:sqlite does.
 */
export function betterSqliteEngine(Better: new (path: string) => BetterDatabase): DatabaseCtor {
  return class implements DatabaseLike {
    private readonly db: BetterDatabase;
    constructor(path: string) {
      this.db = new Better(path);
    }
    exec(sql: string): void {
      this.db.exec(sql);
    }
    prepare(sql: string): StatementLike {
      const s = this.db.prepare(sql);
      return {
        run: (...params) => s.run(...bindable(params)),
        get: (...params) => {
          if (s.reader) return s.get(...bindable(params));
          s.run(...bindable(params));
          return undefined;
        },
        all: (...params) => {
          if (s.reader) return s.all(...bindable(params));
          s.run(...bindable(params));
          return [];
        },
      };
    }
    close(): void {
      this.db.close();
    }
  };
}

/** A module the bundle must not inline (a native one, found in the app's node_modules at run time). */
function requireAtRunTime(name: string): unknown {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(name);
}

function loadEngine(): DatabaseCtor {
  const getBuiltin = (process as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
  const mod = getBuiltin?.('node:sqlite') as { DatabaseSync?: DatabaseCtor } | undefined;
  if (mod?.DatabaseSync) return mod.DatabaseSync;
  // The Windows 7 build (Electron 22 = Node 16.17): better-sqlite3, prebuilt for that Electron, in its node_modules.
  let better: unknown;
  try {
    better = requireAtRunTime('better-sqlite3');
  } catch {
    better = null;
  }
  if (typeof better === 'function') return betterSqliteEngine(better as new (path: string) => BetterDatabase);
  throw new Error('No SQLite engine: node:sqlite is not in this runtime (Node ≥ 22.13 / Electron ≥ 35) and better-sqlite3 is not installed');
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
