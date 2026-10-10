/**
 * The kiosk's tables. Additive migrations only (a version in `PRAGMA user_version`): a kiosk
 * that updates keeps every document, shift, Z and counter it has.
 *
 *  - kv:            settings, credentials, snapshots (the cloud's last word), counters
 *  - media:         the media index (url → content hash, variants)
 *  - documents:     fiscal documents (320/400), unique per (series, number) like the till
 *  - shifts:        the kiosk's shifts and their X (close) payloads
 *  - till_zs:       every Z the kiosk produced or pulled, with the number it got — never renumbered
 *  - outbox:        what still has to reach the cloud, in order
 *  - card_attempts: card charges whose outcome is not settled (written before the frame leaves)
 *  - kiosk_orders:  the self-order snapshots (pickup number, bon, receipt)
 *  - print_jobs:    receipts, bons and slips waiting for / sent to the printer
 */

import type { Db } from './sqlite';

const MIGRATIONS: string[] = [
  // 1
  `
  CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS media (
    url TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    ext TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    variants TEXT NOT NULL DEFAULT '[]',
    stored_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS ix_media_sha ON media(sha256);
  CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    document_type INTEGER NOT NULL,
    series INTEGER NOT NULL,
    number INTEGER NOT NULL,
    prefix TEXT,
    status TEXT NOT NULL,
    shift_id TEXT,
    order_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    total_agorot INTEGER NOT NULL,
    tip_agorot INTEGER NOT NULL DEFAULT 0,
    payload TEXT NOT NULL,
    synced_at TEXT,
    UNIQUE(series, number)
  );
  CREATE INDEX IF NOT EXISTS ix_documents_shift ON documents(shift_id);
  CREATE INDEX IF NOT EXISTS ix_documents_status ON documents(status);
  CREATE TABLE IF NOT EXISTS shifts (
    id TEXT PRIMARY KEY,
    sequence_number INTEGER NOT NULL,
    business_date TEXT NOT NULL,
    opened_at TEXT NOT NULL,
    opened_by_id TEXT,
    opened_by_name TEXT,
    opening_cash INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    closed_at TEXT,
    close_payload TEXT,
    close_accepted_at TEXT,
    z_report_id TEXT,
    z_number INTEGER
  );
  CREATE TABLE IF NOT EXISTS till_zs (
    id TEXT PRIMARY KEY,
    machine_id TEXT,
    number INTEGER NOT NULL,
    epoch INTEGER NOT NULL DEFAULT 0,
    closed_at TEXT NOT NULL,
    business_date TEXT,
    state TEXT NOT NULL,
    payload TEXT NOT NULL,
    printed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS outbox (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    ref_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    next_at INTEGER NOT NULL DEFAULT 0,
    UNIQUE(kind, ref_id)
  );
  CREATE TABLE IF NOT EXISTS card_attempts (
    vuid TEXT PRIMARY KEY,
    json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS kiosk_orders (
    local_id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS print_jobs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    ref_id TEXT,
    target TEXT NOT NULL,
    doc TEXT NOT NULL,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS ix_print_jobs_status ON print_jobs(status);
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

export function migrate(db: Db): void {
  const row = db.get<{ user_version: number }>('PRAGMA user_version');
  let version = row?.user_version ?? 0;
  while (version < MIGRATIONS.length) {
    const sql = MIGRATIONS[version];
    db.tx(() => {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${version + 1}`);
    });
    version++;
  }
}

/** A small typed key/value store in the `kv` table (each write is its own durable commit). */
export class Kv {
  constructor(private readonly db: Db) {}

  get(key: string): string | null {
    return this.db.get<{ value: string }>('SELECT value FROM kv WHERE key = ?', key)?.value ?? null;
  }

  set(key: string, value: string): void {
    this.db.run(
      'INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      key,
      value,
      Date.now(),
    );
  }

  delete(key: string): void {
    this.db.run('DELETE FROM kv WHERE key = ?', key);
  }

  getJson<T>(key: string): T | null {
    const raw = this.get(key);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  setJson(key: string, value: unknown): void {
    this.set(key, JSON.stringify(value));
  }

  getNumber(key: string): number | null {
    const raw = this.get(key);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }

  setNumber(key: string, value: number): void {
    this.set(key, String(value));
  }
}
