/**
 * The cash host's journal (P:/specs/cash-paylink.md §4: "כל עסקה נרשמת ביומן בשרת לפני שנוגעים
 * במכשיר"): SQLite, synchronous=FULL (main/db/sqlite.ts) — a write is on the disk before the
 * device command it describes is sent.
 *
 *  - cash_tx            one row per transaction (its JSON, the starting counters inside), every change;
 *  - cash_cmd_log       every device command, with the counters read just before it;
 *  - cash_moves         float / refill / collect / count / dump / adjust, for the station's drawer;
 *  - cash_station_state the change ledger and the latched alerts per station.
 *
 * Uploads to the cloud (`POST /sync/{host}/cash/journal`) read what is not uploaded yet.
 */

import type { Db } from '../db/sqlite';
import type { Counters, CashTx, TxState } from '../../core/cash/tx';
import { OPEN_STATES } from '../../core/cash/tx';
import type { DeviceCommand } from '../../core/cash/device';
import type { LedgerState } from '../../core/cash/ledger';
import type { Latched } from '../../core/cash/alerts';

export type MoveKind = 'float' | 'refill' | 'collect' | 'count' | 'dump' | 'adjust';

export interface CashMove {
  id: string;
  stationId: string;
  kind: MoveKind;
  amountAgorot: number;
  pieces: Array<{ valueAgorot: number; kind: 'coin' | 'note'; count: number }>;
  expectedAgorot: number | null;
  countedAgorot: number | null;
  by: { userId: string | null; name: string | null } | null;
  note: string | null;
  at: number;
  /** The cloud command it carried out, if any. */
  commandId: string | null;
}

export interface StationState {
  ledger: LedgerState;
  latched: Latched[];
  /** The last watchdog sequence used (never repeated across restarts). */
  watchdogSeq: number;
  /** Extended escrow notes found at start (power cut) — waiting for staff. */
  extEscrowPending: boolean;
  /** Paylink's DISPENSER_PENDING bills — waiting for staff ("deliver_pending"). */
  billsPending: boolean;
  /** "מילוי דרך המקבל": the starting counters of a refill through the acceptor, while it runs. */
  refillVia: { start: Counters; by: CashMove['by']; startedAt: number } | null;
}

export const EMPTY_STATION_STATE: StationState = {
  ledger: { units: {}, cashbox: null },
  latched: [],
  watchdogSeq: 0,
  extEscrowPending: false,
  billsPending: false,
  refillVia: null,
};

export class CashJournal {
  constructor(private readonly db: Db) {}

  /* --------------------------------------------------------------- transactions */

  saveTx(t: CashTx): void {
    this.db.run(
      `INSERT INTO cash_tx (tx_id, station_id, client_id, state, json, created_at, updated_at, seq, acked)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tx_id) DO UPDATE SET state = excluded.state, json = excluded.json, updated_at = excluded.updated_at, seq = excluded.seq, acked = excluded.acked`,
      t.txId,
      t.stationId,
      t.clientId,
      t.state,
      JSON.stringify(t),
      t.createdAt,
      t.updatedAt,
      t.seq,
      t.acked ? 1 : 0,
    );
  }

  tx(txId: string): CashTx | null {
    const row = this.db.get<{ json: string }>('SELECT json FROM cash_tx WHERE tx_id = ?', txId);
    return row ? (JSON.parse(row.json) as CashTx) : null;
  }

  /** Transactions of a station not final yet (at most one in a healthy station). */
  openTxs(stationId: string): CashTx[] {
    const marks = OPEN_STATES.map(() => '?').join(',');
    return this.db
      .all<{ json: string }>(`SELECT json FROM cash_tx WHERE station_id = ? AND state IN (${marks}) ORDER BY created_at`, stationId, ...OPEN_STATES)
      .map((r) => JSON.parse(r.json) as CashTx);
  }

  /** Final transactions the client has not acknowledged. */
  unacked(stationId: string): CashTx[] {
    return this.db
      .all<{ json: string }>("SELECT json FROM cash_tx WHERE station_id = ? AND acked = 0 AND state IN ('DONE', 'HELD') ORDER BY created_at", stationId)
      .map((r) => JSON.parse(r.json) as CashTx);
  }

  byState(stationId: string, state: TxState, limit = 100): CashTx[] {
    return this.db
      .all<{ json: string }>('SELECT json FROM cash_tx WHERE station_id = ? AND state = ? ORDER BY created_at DESC LIMIT ?', stationId, state, limit)
      .map((r) => JSON.parse(r.json) as CashTx);
  }

  recent(stationId: string, limit = 50): CashTx[] {
    return this.db
      .all<{ json: string }>('SELECT json FROM cash_tx WHERE station_id = ? ORDER BY created_at DESC LIMIT ?', stationId, limit)
      .map((r) => JSON.parse(r.json) as CashTx);
  }

  /** Final (or acknowledged) transactions whose last change is not in the cloud. */
  toUpload(limit = 50): CashTx[] {
    return this.db
      .all<{ json: string }>("SELECT json FROM cash_tx WHERE seq > uploaded_seq AND state IN ('DONE','HELD') ORDER BY updated_at LIMIT ?", limit)
      .map((r) => JSON.parse(r.json) as CashTx);
  }

  markTxUploaded(txId: string, seq: number): void {
    this.db.run('UPDATE cash_tx SET uploaded_seq = MAX(uploaded_seq, ?) WHERE tx_id = ?', seq, txId);
  }

  /* --------------------------------------------------------------- commands */

  /** Before every device command: the command and the counters read just before it. */
  logCommand(stationId: string, txId: string | null, cmd: DeviceCommand, counters: Counters | null, at: number): number {
    const r = this.db.run(
      'INSERT INTO cash_cmd_log (station_id, tx_id, op, command, counters, at) VALUES (?, ?, ?, ?, ?, ?)',
      stationId,
      txId,
      cmd.op,
      JSON.stringify(cmd),
      JSON.stringify(counters),
      at,
    );
    return Number(r.lastInsertRowid);
  }

  commandResult(id: number, result: unknown): void {
    this.db.run('UPDATE cash_cmd_log SET result = ? WHERE id = ?', JSON.stringify(result), id);
  }

  commandsOf(txId: string): Array<{ op: string; command: DeviceCommand; counters: Counters | null; at: number; result: unknown }> {
    return this.db
      .all<{ op: string; command: string; counters: string; at: number; result: string | null }>('SELECT op, command, counters, at, result FROM cash_cmd_log WHERE tx_id = ? ORDER BY id', txId)
      .map((r) => ({ op: r.op, command: JSON.parse(r.command), counters: JSON.parse(r.counters), at: r.at, result: r.result ? JSON.parse(r.result) : null }));
  }

  /** Keeps the command log to the last `days` (transactions keep their own summary). */
  pruneCommands(beforeAt: number): void {
    this.db.run('DELETE FROM cash_cmd_log WHERE at < ?', beforeAt);
  }

  /* --------------------------------------------------------------- movements */

  saveMove(m: CashMove): void {
    this.db.run('INSERT OR IGNORE INTO cash_moves (id, station_id, kind, json, at) VALUES (?, ?, ?, ?, ?)', m.id, m.stationId, m.kind, JSON.stringify(m), m.at);
  }

  moves(stationId: string, limit = 100): CashMove[] {
    return this.db
      .all<{ json: string }>('SELECT json FROM cash_moves WHERE station_id = ? ORDER BY at DESC LIMIT ?', stationId, limit)
      .map((r) => JSON.parse(r.json) as CashMove);
  }

  movesToUpload(limit = 50): CashMove[] {
    return this.db.all<{ json: string }>('SELECT json FROM cash_moves WHERE uploaded = 0 ORDER BY at LIMIT ?', limit).map((r) => JSON.parse(r.json) as CashMove);
  }

  markMoveUploaded(id: string): void {
    this.db.run('UPDATE cash_moves SET uploaded = 1 WHERE id = ?', id);
  }

  /* --------------------------------------------------------------- station state */

  stationState(stationId: string): StationState {
    const row = this.db.get<{ json: string }>('SELECT json FROM cash_station_state WHERE station_id = ?', stationId);
    if (!row) return structuredClone(EMPTY_STATION_STATE);
    try {
      return { ...structuredClone(EMPTY_STATION_STATE), ...(JSON.parse(row.json) as Partial<StationState>) };
    } catch {
      return structuredClone(EMPTY_STATION_STATE);
    }
  }

  saveStationState(stationId: string, s: StationState, at: number): void {
    this.db.run(
      'INSERT INTO cash_station_state (station_id, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(station_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at',
      stationId,
      JSON.stringify(s),
      at,
    );
  }

  tx_count(stationId: string): number {
    return this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM cash_tx WHERE station_id = ?', stationId)?.n ?? 0;
  }
}
