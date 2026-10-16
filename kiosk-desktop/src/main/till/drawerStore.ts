/**
 * The till's local audit of the cash drawer and its cash movements (pos-android data/local/DrawerEntities.kt — the drawer
 * spec §14): one row per attempt to open a drawer (granted, denied or failed at the printer), written BEFORE the physical kick
 * and updated with its result; one row per Cash In / Cash Out / Deposit / count and per wallet movement ("הכסף אצלי",
 * P:/specs/drawer-away.md §5.4). Never deleted by a user; uploaded through the outbox with its own id (`drawer_event`,
 * `cash_movement` — side rows), so a resend is the same row in the cloud. Money in agorot.
 *
 * Its own tables, created here if missing (no numbered migration: the schema's versions stay the fiscal ledger's).
 */

import type { Db } from '../db/sqlite';

export const DRAWER_TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS till_drawer_events (
    id TEXT PRIMARY KEY,
    category TEXT NOT NULL,
    event_type TEXT NOT NULL,
    result TEXT NOT NULL,
    shift_id TEXT,
    employee_id TEXT,
    movement_id TEXT,
    occurred_at TEXT NOT NULL,
    json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS ix_till_drawer_events_shift ON till_drawer_events(shift_id);
  CREATE TABLE IF NOT EXISTS till_cash_movements (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    amount_agorot INTEGER NOT NULL,
    shift_id TEXT,
    employee_id TEXT,
    occurred_at TEXT NOT NULL,
    json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS ix_till_cash_movements_shift ON till_cash_movements(shift_id);
`;

/** One opening attempt, or one permission decision (`category = permission`). */
export interface DrawerEventRow {
  id: string;
  category: 'drawer' | 'permission';
  /** CASH_SALE | MANUAL | CHANGE | CASH_IN | CASH_OUT | DEPOSIT | COUNT | TEST | REFUND | AFTER_CLOSE | REMOTE_SALE | REMOTE_MANUAL | WALLET_DEPOSIT | PERMISSION */
  eventType: string;
  permission: string | null;
  decision: 'allow' | 'approval' | 'deny' | null;
  /** approved | denied | failed | pending (the audit row before the kick). */
  result: 'approved' | 'denied' | 'failed' | 'pending';
  resultReason: string | null;
  companyId: string | null;
  shopId: string | null;
  machineId: string | null;
  drawerId: string | null;
  drawerName: string | null;
  deviceId: string | null;
  shiftId: string | null;
  employeeId: string | null;
  employeeName: string | null;
  employeeRole: string | null;
  approverId: string | null;
  approverName: string | null;
  approverMethod: string | null;
  tableId: string | null;
  saleId: string | null;
  paymentId: string | null;
  originalSaleId: string | null;
  reason: string | null;
  reasonNote: string | null;
  movementId: string | null;
  cashMovementType: string | null;
  amountAgorot: number | null;
  expectedBalanceAgorot: number | null;
  offline: boolean;
  occurredAt: string;
  details: Record<string, unknown> | null;
}

/** Cash that moved without a sale (spec §7), the counts (§9), and the wallets (drawer-away §5.4). */
export interface CashMovementRow {
  id: string;
  /** cash_in | cash_out | deposit | count | wallet_in | wallet_deposit */
  type: string;
  /** Always positive; a count's counted amount. */
  amountAgorot: number;
  expectedBeforeAgorot: number | null;
  expectedAfterAgorot: number | null;
  /** A count: counted − expected; a deposit: counted − the wallet shown. */
  varianceAgorot: number | null;
  blind: boolean;
  reason: string | null;
  note: string | null;
  /** Cash In: where the money came from ("מקור הכסף"); a wallet accrual: `sale:<id>`. */
  source: string | null;
  shiftId: string | null;
  employeeId: string | null;
  employeeName: string | null;
  approverId: string | null;
  approverName: string | null;
  drawerEventId: string | null;
  offline: boolean;
  occurredAt: string;
}

export class DrawerStore {
  constructor(private readonly db: Db) {
    db.exec(DRAWER_TABLES_SQL);
  }

  putEvent(row: DrawerEventRow): void {
    this.db.run(
      `INSERT INTO till_drawer_events (id, category, event_type, result, shift_id, employee_id, movement_id, occurred_at, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET result = excluded.result, movement_id = excluded.movement_id, json = excluded.json`,
      row.id,
      row.category,
      row.eventType,
      row.result,
      row.shiftId,
      row.employeeId,
      row.movementId,
      row.occurredAt,
      JSON.stringify(row),
    );
  }

  event(id: string): DrawerEventRow | null {
    const r = this.db.get<{ json: string }>('SELECT json FROM till_drawer_events WHERE id = ?', id);
    return r ? (JSON.parse(r.json) as DrawerEventRow) : null;
  }

  /** Manual openings (not a sale's) by this employee in this shift that went through. */
  manualOpensOfShift(shiftId: string, employeeId: string): number {
    return (
      this.db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM till_drawer_events WHERE category = 'drawer' AND result = 'approved' AND shift_id = ? AND employee_id = ? AND event_type IN ('MANUAL', 'CHANGE')",
        shiftId,
        employeeId,
      )?.n ?? 0
    );
  }

  eventsOfShift(shiftId: string): DrawerEventRow[] {
    return this.db.all<{ json: string }>('SELECT json FROM till_drawer_events WHERE shift_id = ? ORDER BY occurred_at', shiftId).map((r) => JSON.parse(r.json) as DrawerEventRow);
  }

  putMovement(row: CashMovementRow): void {
    this.db.run(
      `INSERT INTO till_cash_movements (id, type, amount_agorot, shift_id, employee_id, occurred_at, json) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET json = excluded.json`,
      row.id,
      row.type,
      row.amountAgorot,
      row.shiftId,
      row.employeeId,
      row.occurredAt,
      JSON.stringify(row),
    );
  }

  movement(id: string): CashMovementRow | null {
    const r = this.db.get<{ json: string }>('SELECT json FROM till_cash_movements WHERE id = ?', id);
    return r ? (JSON.parse(r.json) as CashMovementRow) : null;
  }

  movementsOfShift(shiftId: string): CashMovementRow[] {
    return this.db.all<{ json: string }>('SELECT json FROM till_cash_movements WHERE shift_id = ? ORDER BY occurred_at', shiftId).map((r) => JSON.parse(r.json) as CashMovementRow);
  }

  /** "הכסף אצלי" (§5.5): the wallet rows, with whether the cloud has them yet (still in the outbox). */
  walletRows(): Array<CashMovementRow & { pending: boolean }> {
    return this.db
      .all<{ json: string; pending: number }>(
        "SELECT m.json AS json, EXISTS(SELECT 1 FROM outbox o WHERE o.kind = 'cash_movement' AND o.ref_id = m.id) AS pending FROM till_cash_movements m WHERE m.type IN ('wallet_in', 'wallet_deposit') ORDER BY m.occurred_at",
      )
      .map((r) => ({ ...(JSON.parse(r.json) as CashMovementRow), pending: r.pending === 1 }));
  }
}

/* --------------------------------------------------------------- the wire */

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
/** The cloud wants a UUID or nothing for these: anything else (a demo id) is left out. */
const uuidOrNull = (v: string | null | undefined): string | null => (v && UUID.test(v) ? v : null);
const shekels = (a: number | null | undefined): number | null => (a === null || a === undefined ? null : Math.round(a) / 100);

function clean(o: Record<string, unknown>): Record<string, unknown> {
  for (const k of Object.keys(o)) if (o[k] === null || o[k] === undefined) delete o[k];
  return o;
}

/** `POST /sync/{m}/cash-drawer/events` (pos-server app/schemas/cash_drawer.py DrawerEventIn). */
export function drawerEventWire(e: DrawerEventRow): Record<string, unknown> {
  return clean({
    id: e.id,
    category: e.category,
    eventType: e.eventType,
    permission: e.permission,
    decision: e.decision,
    // The audit row before the kick never left pending on the wire.
    result: e.result === 'pending' ? 'failed' : e.result,
    resultReason: e.resultReason?.slice(0, 1000) ?? null,
    drawerId: e.drawerId,
    drawerName: e.drawerName,
    deviceId: e.deviceId,
    shiftId: uuidOrNull(e.shiftId),
    employeeId: e.employeeId,
    employeeName: e.employeeName,
    employeeRole: e.employeeRole,
    approverId: e.approverId,
    approverName: e.approverName,
    approverMethod: e.approverMethod,
    tableId: e.tableId,
    saleId: uuidOrNull(e.saleId),
    paymentId: e.paymentId,
    originalSaleId: uuidOrNull(e.originalSaleId),
    // The cloud's column is 32 characters (a code); a longer cash-out reason stays whole on its movement.
    reason: e.reason ? e.reason.slice(0, 32) : null,
    reasonNote: e.reasonNote,
    movementId: uuidOrNull(e.movementId),
    cashMovementType: e.cashMovementType,
    amount: shekels(e.amountAgorot),
    expectedBalance: shekels(e.expectedBalanceAgorot),
    offline: e.offline,
    occurredAt: e.occurredAt,
    details: e.details && Object.keys(e.details).length > 0 ? e.details : null,
  });
}

/** `POST /sync/{m}/cash-drawer/movements` (CashMovementIn). */
export function cashMovementWire(m: CashMovementRow): Record<string, unknown> {
  return clean({
    id: m.id,
    type: m.type,
    amount: Math.round(m.amountAgorot) / 100,
    expectedBefore: shekels(m.expectedBeforeAgorot),
    expectedAfter: shekels(m.expectedAfterAgorot),
    variance: shekels(m.varianceAgorot),
    blind: m.blind,
    reason: m.reason ? m.reason.slice(0, 100) : null,
    note: m.note,
    source: m.source ? m.source.slice(0, 200) : null,
    shiftId: uuidOrNull(m.shiftId),
    employeeId: m.employeeId,
    employeeName: m.employeeName,
    approverId: m.approverId,
    approverName: m.approverName,
    drawerEventId: uuidOrNull(m.drawerEventId),
    offline: m.offline,
    occurredAt: m.occurredAt,
  });
}
