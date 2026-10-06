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

export type OutboxKind = 'transaction' | 'shift_open' | 'shift_close' | 'transmission' | 'shift_close_ack' | 'till_z_ack';

export const SIDE_KINDS: ReadonlySet<OutboxKind> = new Set(['transmission', 'shift_close_ack', 'till_z_ack']);

export interface OutboxRow {
  seq: number;
  kind: OutboxKind;
  ref_id: string;
  created_at: string;
  attempts: number;
  last_error: string | null;
  next_at: number;
}

const BACKOFF_MIN_MS = 60_000;
const BACKOFF_MAX_MS = 3_600_000;

export function backoffMs(attempts: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.max(0, Math.min(6, attempts - 1)));
}

export class Outbox {
  private listeners = new Set<() => void>();

  constructor(private readonly db: Db) {}

  onEnqueue(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Idempotent: one row per (kind, ref). Call inside the transaction that writes the entity. */
  enqueue(kind: OutboxKind, refId: string): void {
    this.db.run('INSERT OR IGNORE INTO outbox (kind, ref_id, created_at) VALUES (?, ?, ?)', kind, refId, new Date().toISOString());
    queueMicrotask(() => this.listeners.forEach((fn) => fn()));
  }

  /** Every row whose backoff is over. */
  due(nowMs = Date.now()): OutboxRow[] {
    return this.db.all<OutboxRow>('SELECT * FROM outbox WHERE next_at <= ? ORDER BY seq', nowMs);
  }

  all(): OutboxRow[] {
    return this.db.all<OutboxRow>('SELECT * FROM outbox ORDER BY seq');
  }

  count(kind?: OutboxKind): number {
    return kind
      ? (this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM outbox WHERE kind = ?', kind)?.n ?? 0)
      : (this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM outbox')?.n ?? 0);
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
