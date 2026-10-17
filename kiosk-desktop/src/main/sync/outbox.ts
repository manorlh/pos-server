/**
 * What still has to reach the cloud, in the till's order (pos-android data/sync/OutboxOrdering.kt,
 * OutboxSync.kt):
 *
 *  - side kinds first (card transmissions, acks) — outside the shift order;
 *  - then per shift, by its number: open(N) → documents(N) in batches of ≤ 200 → close(N) → …;
 *  - an open or a close that does not go stops the stream (a close must never overtake its
 *    documents); a document batch with a held/missing result or no network stops it; a REJECTED
 *    document is parked with a backoff (1, 2, 4… min, ≤ 1 h) and does not stop it;
 *  - `duplicate` is success; a result missing from the answer is not;
 *  - 409 missing_transactions on a close: those documents go again, then the close.
 */

import type { Db } from '../db/sqlite';

export type OutboxKind =
  | 'transaction'
  | 'shift_open'
  | 'shift_close'
  | 'transmission'
  | 'shift_close_ack'
  | 'till_z_ack'
  | 'kds_release'
  | 'till_event'
  // "מגירת מזומן" (main/till/drawerService.ts): a drawer opening's audit, a cash movement — side rows, idempotent by their ids.
  | 'drawer_event'
  | 'cash_movement';

/** `till_event`: a till event for the cloud's record (`POST /sync/{m}/events` — "יציאה לשולחן העבודה"). */
export const SIDE_KINDS: ReadonlySet<OutboxKind> = new Set(['transmission', 'shift_close_ack', 'till_z_ack', 'kds_release', 'till_event', 'drawer_event', 'cash_movement']);

/**
 * A refusal the cloud gives these for good (a 4xx): dropped and logged, never parked for ever —
 * a KDS release the kitchen engine refuses (`release_requires_payment`, `order_of_another_shop`…)
 * is not made acceptable by sending it again (pos-android KdsOutbox: "a 4xx refusal is final");
 * nor is a till event an older server does not know (422) — it stays in the device's own log.
 */
export const FINAL_ON_REFUSAL: ReadonlySet<OutboxKind> = new Set(['kds_release', 'till_event', 'drawer_event', 'cash_movement']);

export interface OutboxRow {
  seq: number;
  kind: OutboxKind;
  ref_id: string;
  created_at: string;
  attempts: number;
  last_error: string | null;
  next_at: number;
  /** The pairing the row was made under (schema 3); null — made before, or while unpaired. */
  machine_id?: string | null;
  tenant_id?: string | null;
}

/** The pairing the device is under now: its rows are the ones sent, counted and refused over. */
export interface OutboxOwner {
  machineId: string;
  tenantId: string | null;
}

/** Owner unknown (a row from before schema 3 whose pairing could not be told): never sent under any pairing. */
export const UNKNOWN_OWNER = 'unknown';

const BACKOFF_MIN_MS = 60_000;
const BACKOFF_MAX_MS = 3_600_000;

export function backoffMs(attempts: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.max(0, Math.min(6, attempts - 1)));
}

export class Outbox {
  private listeners = new Set<() => void>();

  /**
   * `owner`: the pairing now (null — unpaired). Without one (tests, tools) every row is this device's, as before. With
   * one, the rows of another pairing (another machine, or tenant) are held: never due, never counted, never sent —
   * `foreign()` lists them (the technician's "רשומות מהמכשיר הקודם").
   */
  constructor(
    private readonly db: Db,
    private readonly owner: () => OutboxOwner | null = () => null,
  ) {}

  /** The WHERE of this pairing's rows ('' — no pairing: every row). */
  private mine(): { sql: string; params: string[] } {
    const o = this.owner();
    if (!o) return { sql: '', params: [] };
    if (o.tenantId) return { sql: ' AND machine_id = ? AND (tenant_id IS NULL OR tenant_id = ?)', params: [o.machineId, o.tenantId] };
    return { sql: ' AND machine_id = ?', params: [o.machineId] };
  }

  onEnqueue(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Idempotent: one row per (kind, ref). Call inside the transaction that writes the entity. */
  enqueue(kind: OutboxKind, refId: string): void {
    const o = this.owner();
    this.db.run(
      'INSERT OR IGNORE INTO outbox (kind, ref_id, created_at, machine_id, tenant_id) VALUES (?, ?, ?, ?, ?)',
      kind,
      refId,
      new Date().toISOString(),
      o?.machineId ?? null,
      o?.tenantId ?? null,
    );
    queueMicrotask(() => this.listeners.forEach((fn) => fn()));
  }

  /** Every row of this pairing whose backoff is over. */
  due(nowMs = Date.now()): OutboxRow[] {
    const m = this.mine();
    return this.db.all<OutboxRow>(`SELECT * FROM outbox WHERE next_at <= ?${m.sql} ORDER BY seq`, nowMs, ...m.params);
  }

  /** This pairing's rows. */
  all(): OutboxRow[] {
    const m = this.mine();
    return this.db.all<OutboxRow>(`SELECT * FROM outbox WHERE 1 = 1${m.sql} ORDER BY seq`, ...m.params);
  }

  /** Every row on the device, whoever's (the backups). */
  everything(): OutboxRow[] {
    return this.db.all<OutboxRow>('SELECT * FROM outbox ORDER BY seq');
  }

  /** The rows of another pairing (held; none while unpaired — nothing is sent then). */
  foreign(): OutboxRow[] {
    if (!this.owner()) return [];
    const mine = new Set(this.all().map((r) => r.seq));
    return this.everything().filter((r) => !mine.has(r.seq));
  }

  /** This pairing's rows (of one kind). */
  count(kind?: OutboxKind): number {
    const m = this.mine();
    return kind
      ? (this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM outbox WHERE kind = ?${m.sql}`, kind, ...m.params)?.n ?? 0)
      : (this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM outbox WHERE 1 = 1${m.sql}`, ...m.params)?.n ?? 0);
  }

  /** This pairing's rows per kind. */
  countsByKind(): Array<{ kind: string; n: number }> {
    const m = this.mine();
    return this.db.all<{ kind: string; n: number }>(`SELECT kind, COUNT(*) AS n FROM outbox WHERE 1 = 1${m.sql} GROUP BY kind`, ...m.params);
  }

  /** This pairing's rows of these kinds, gone (after "ניתוק בכל זאת" — they are in the backup). */
  removeKinds(kinds: readonly string[]): void {
    const m = this.mine();
    this.db.tx(() => {
      for (const k of kinds) this.db.run(`DELETE FROM outbox WHERE kind = ?${m.sql}`, k, ...m.params);
    });
  }

  /** Rows with no owner yet (from before schema 3, or made while unpaired): `owner` tells each one's. */
  stampUnowned(owner: (row: OutboxRow) => { machineId: string; tenantId: string | null }): number {
    const rows = this.db.all<OutboxRow>('SELECT * FROM outbox WHERE machine_id IS NULL');
    this.db.tx(() => {
      for (const r of rows) {
        const o = owner(r);
        this.db.run('UPDATE outbox SET machine_id = ?, tenant_id = ? WHERE seq = ?', o.machineId, o.tenantId, r.seq);
      }
    });
    return rows.length;
  }

  remove(kind: OutboxKind, refId: string): void {
    this.db.run('DELETE FROM outbox WHERE kind = ? AND ref_id = ?', kind, refId);
  }

  /** Not taken: tried again after a backoff. */
  park(kind: OutboxKind, refId: string, error: string, nowMs = Date.now()): void {
    const row = this.db.get<OutboxRow>('SELECT * FROM outbox WHERE kind = ? AND ref_id = ?', kind, refId);
    const attempts = (row?.attempts ?? 0) + 1;
    this.db.run('UPDATE outbox SET attempts = ?, last_error = ?, next_at = ? WHERE kind = ? AND ref_id = ?', attempts, error.slice(0, 500), nowMs + backoffMs(attempts), kind, refId);
  }

  /** Held (the cloud is not ready for it yet): the error kept, tried again at the next flush. */
  hold(kind: OutboxKind, refId: string, error: string): void {
    this.db.run('UPDATE outbox SET last_error = ? WHERE kind = ? AND ref_id = ?', error.slice(0, 500), kind, refId);
  }
}

/* ------------------------------------------------------------------ order */

export interface ShiftKey {
  id: string;
  sequence: number;
  openedAt: string;
}

export type Step =
  | { kind: 'side'; row: OutboxRow }
  | { kind: 'open'; shiftId: string; row: OutboxRow }
  | { kind: 'docs'; shiftId: string | null; rows: OutboxRow[] }
  | { kind: 'close'; shiftId: string; row: OutboxRow };

/**
 * The delivery plan (OutboxOrdering): side rows; documents without a shift; then per shift by
 * (sequence, openedAt, id): open → documents (≤ 200 a batch) → close.
 */
export function plan(rows: readonly OutboxRow[], shiftOf: (docId: string) => string | null, shifts: (id: string) => ShiftKey | null): Step[] {
  const steps: Step[] = [];
  for (const r of rows) if (SIDE_KINDS.has(r.kind)) steps.push({ kind: 'side', row: r });
  const groups = new Map<string | null, { open?: OutboxRow; docs: OutboxRow[]; close?: OutboxRow }>();
  const group = (id: string | null) => {
    let g = groups.get(id);
    if (!g) groups.set(id, (g = { docs: [] }));
    return g;
  };
  for (const r of rows) {
    if (r.kind === 'shift_open') group(r.ref_id).open = r;
    else if (r.kind === 'shift_close') group(r.ref_id).close = r;
    else if (r.kind === 'transaction') group(shiftOf(r.ref_id)).docs.push(r);
  }
  const keys = [...groups.keys()].sort((a, b) => {
    if (a === null) return -1;
    if (b === null) return 1;
    const ka = shifts(a);
    const kb = shifts(b);
    return (ka?.sequence ?? 0) - (kb?.sequence ?? 0) || (ka?.openedAt ?? '').localeCompare(kb?.openedAt ?? '') || a.localeCompare(b);
  });
  for (const k of keys) {
    const g = groups.get(k)!;
    if (k !== null && g.open) steps.push({ kind: 'open', shiftId: k, row: g.open });
    for (let i = 0; i < g.docs.length; i += 200) steps.push({ kind: 'docs', shiftId: k, rows: g.docs.slice(i, i + 200) });
    if (k !== null && g.close) steps.push({ kind: 'close', shiftId: k, row: g.close });
  }
  return steps;
}

/** One document's fate in a batch answer. */
export type DocResult = 'synced' | 'rejected' | 'held';

/** Results by id (accepted and duplicate are success; missing is held, never assumed taken). */
export function docResults(sentIds: readonly string[], body: unknown): Map<string, { result: DocResult; reason: string | null }> {
  const out = new Map<string, { result: DocResult; reason: string | null }>();
  const results = body && typeof body === 'object' && Array.isArray((body as { results?: unknown }).results) ? ((body as { results: unknown[] }).results as Array<Record<string, unknown>>) : [];
  const byId = new Map(results.filter((r) => r && typeof r.id === 'string').map((r) => [String(r.id), r]));
  for (const id of sentIds) {
    const r = byId.get(id);
    if (!r) out.set(id, { result: 'held', reason: 'missing from the answer' });
    else if (r.status === 'accepted' || r.status === 'duplicate') out.set(id, { result: 'synced', reason: null });
    else if (r.status === 'rejected') out.set(id, { result: 'rejected', reason: typeof r.reason === 'string' ? r.reason : 'rejected' });
    else out.set(id, { result: 'held', reason: `status ${String(r.status)}` });
  }
  return out;
}
