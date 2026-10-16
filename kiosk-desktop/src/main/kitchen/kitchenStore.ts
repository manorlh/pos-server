/**
 * The kitchen queue on disk (SQLite `kitchen_jobs`, in the device's own kiosk.db): every ticket for every printer,
 * written before anything is sent, with its state (core/kitchen/queue.ts) — a restart, a crash or a day offline loses
 * none and prints none twice. Its own table, created here (additive, `IF NOT EXISTS`): nothing of the fiscal schema.
 */

import type { Db, SqlValue } from '../db/sqlite';
import type { JobKind, JobState, KitchenJob } from '../../core/kitchen/queue';
import type { JobRoute } from '../../core/kitchen/routing';

const DDL = `
CREATE TABLE IF NOT EXISTS kitchen_jobs (
  id TEXT PRIMARY KEY,
  printer_id TEXT NOT NULL,
  printer_name TEXT NOT NULL,
  printer_json TEXT NOT NULL,
  ticket_json TEXT NOT NULL,
  route TEXT NOT NULL,
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  queued_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  next_attempt_at INTEGER NOT NULL,
  finished_at INTEGER,
  relay_via TEXT,
  relay_host TEXT,
  relay_job_id TEXT,
  ack_status TEXT,
  lan_origin INTEGER NOT NULL DEFAULT 0,
  dismissed INTEGER NOT NULL DEFAULT 0,
  discard_reason TEXT,
  ref_id TEXT
);
CREATE INDEX IF NOT EXISTS ix_kitchen_jobs_state ON kitchen_jobs(state, next_attempt_at);
CREATE INDEX IF NOT EXISTS ix_kitchen_jobs_ref ON kitchen_jobs(ref_id);
CREATE INDEX IF NOT EXISTS ix_kitchen_jobs_relay ON kitchen_jobs(relay_job_id);
`;

interface Row {
  id: string;
  printer_id: string;
  printer_name: string;
  printer_json: string;
  ticket_json: string;
  route: string;
  kind: string;
  state: string;
  attempts: number;
  last_error: string | null;
  queued_at: number;
  created_at: number;
  updated_at: number;
  next_attempt_at: number;
  finished_at: number | null;
  relay_via: string | null;
  relay_host: string | null;
  relay_job_id: string | null;
  ack_status: string | null;
  lan_origin: number;
  dismissed: number;
  discard_reason: string | null;
  ref_id: string | null;
}

const fromRow = (r: Row): KitchenJob => ({
  id: r.id,
  printerId: r.printer_id,
  printerName: r.printer_name,
  printerJson: r.printer_json,
  ticketJson: r.ticket_json,
  route: r.route as JobRoute,
  kind: r.kind as JobKind,
  state: r.state as JobState,
  attempts: Number(r.attempts),
  lastError: r.last_error,
  queuedAt: Number(r.queued_at),
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
  nextAttemptAt: Number(r.next_attempt_at),
  finishedAt: r.finished_at === null ? null : Number(r.finished_at),
  relayVia: r.relay_via,
  relayHost: r.relay_host,
  relayJobId: r.relay_job_id,
  ackStatus: r.ack_status,
  lanOrigin: Number(r.lan_origin),
  dismissed: Number(r.dismissed),
  discardReason: r.discard_reason,
  refId: r.ref_id,
});

const COLS =
  'id, printer_id, printer_name, printer_json, ticket_json, route, kind, state, attempts, last_error, queued_at, created_at, updated_at, next_attempt_at, finished_at, relay_via, relay_host, relay_job_id, ack_status, lan_origin, dismissed, discard_reason, ref_id';

const values = (j: KitchenJob): SqlValue[] => [
  j.id,
  j.printerId,
  j.printerName,
  j.printerJson,
  j.ticketJson,
  j.route,
  j.kind,
  j.state,
  j.attempts,
  j.lastError,
  j.queuedAt,
  j.createdAt,
  j.updatedAt,
  j.nextAttemptAt,
  j.finishedAt,
  j.relayVia,
  j.relayHost,
  j.relayJobId,
  j.ackStatus,
  j.lanOrigin,
  j.dismissed,
  j.discardReason,
  j.refId,
];

export class KitchenStore {
  constructor(private readonly db: Db) {
    db.exec(DDL);
  }

  /** Every job, in one transaction — a ticket's copies for every printer are written together or not at all. Idempotent by id. */
  insertAll(jobs: readonly KitchenJob[]): void {
    if (jobs.length === 0) return;
    this.db.tx(() => {
      for (const j of jobs) this.db.run(`INSERT OR IGNORE INTO kitchen_jobs (${COLS}) VALUES (${COLS.split(',').map(() => '?').join(', ')})`, ...values(j));
    });
  }

  update(j: KitchenJob): void {
    const [, ...rest] = values(j);
    this.db.run(
      `UPDATE kitchen_jobs SET ${COLS.split(', ')
        .slice(1)
        .map((c) => `${c} = ?`)
        .join(', ')} WHERE id = ?`,
      ...rest,
      j.id,
    );
  }

  byId(id: string): KitchenJob | null {
    const r = this.db.get<Row>('SELECT * FROM kitchen_jobs WHERE id = ?', id);
    return r ? fromRow(r) : null;
  }

  byIds(ids: readonly string[]): KitchenJob[] {
    if (ids.length === 0) return [];
    const found = new Map(this.db.all<Row>(`SELECT * FROM kitchen_jobs WHERE id IN (${ids.map(() => '?').join(', ')})`, ...ids).map((r) => [r.id, fromRow(r)]));
    // In the order asked for (the order's own list of its tickets).
    return ids.map((id) => found.get(id)).filter((j): j is KitchenJob => j !== undefined);
  }

  byRelayJobId(id: string): KitchenJob | null {
    const r = this.db.get<Row>('SELECT * FROM kitchen_jobs WHERE relay_job_id = ?', id);
    return r ? fromRow(r) : null;
  }

  byRef(refId: string): KitchenJob[] {
    return this.db.all<Row>('SELECT * FROM kitchen_jobs WHERE ref_id = ? ORDER BY created_at', refId).map(fromRow);
  }

  /** Waiting to print (PENDING), oldest first. */
  pending(): KitchenJob[] {
    return this.db.all<Row>("SELECT * FROM kitchen_jobs WHERE state = 'pending' ORDER BY created_at, queued_at").map(fromRow);
  }

  /** Handed to a host and due a status question. */
  dueRelayed(now: number): KitchenJob[] {
    return this.db.all<Row>("SELECT * FROM kitchen_jobs WHERE state = 'relayed' AND next_attempt_at <= ? ORDER BY created_at", now).map(fromRow);
  }

  nextRelayedAt(): number | null {
    const r = this.db.get<{ t: number | null }>("SELECT MIN(next_attempt_at) AS t FROM kitchen_jobs WHERE state = 'relayed'");
    return r?.t === null || r?.t === undefined ? null : Number(r.t);
  }

  heldFor(hold: string): KitchenJob[] {
    return this.db.all<Row>("SELECT * FROM kitchen_jobs WHERE state = 'held' AND last_error = ?", hold).map(fromRow);
  }

  /** Jobs surfaced for a person under [reason] (FAILED, not handled). */
  surfacedFor(reason: string): KitchenJob[] {
    return this.db.all<Row>("SELECT * FROM kitchen_jobs WHERE state = 'failed' AND dismissed = 0 AND last_error = ?", reason).map(fromRow);
  }

  /** Answers owed to the cloud for jobs printed here for other devices. */
  pendingAcks(): KitchenJob[] {
    return this.db.all<Row>('SELECT * FROM kitchen_jobs WHERE relay_job_id IS NOT NULL AND ack_status IS NOT NULL ORDER BY updated_at').map(fromRow);
  }

  /** Every job not finished (and the failed ones not handled): what a restart recovers and the staff see. */
  open(): KitchenJob[] {
    return this.db.all<Row>("SELECT * FROM kitchen_jobs WHERE state IN ('held', 'pending', 'printing', 'sending', 'relayed') OR (state = 'failed' AND dismissed = 0) ORDER BY created_at").map(fromRow);
  }

  recent(limit = 200): KitchenJob[] {
    return this.db.all<Row>('SELECT * FROM kitchen_jobs ORDER BY created_at DESC LIMIT ?', limit).map(fromRow);
  }

  delete(id: string): void {
    this.db.run('DELETE FROM kitchen_jobs WHERE id = ?', id);
  }

  all(): KitchenJob[] {
    return this.db.all<Row>('SELECT * FROM kitchen_jobs ORDER BY created_at').map(fromRow);
  }
}
