/**
 * "מגירת מזומן" — the pure half of the drawer reports (pos-server app/routers/cash_drawer.py,
 * docs/SPEC_ROLES_PERMISSIONS.md; the owner's drawer spec §16): the row shapes, the query
 * string of the filters, and the shift timeline's running expected balance.
 */

export type DrawerEventType =
  | 'CASH_SALE'
  | 'MANUAL'
  | 'CHANGE'
  | 'CASH_IN'
  | 'CASH_OUT'
  | 'DEPOSIT'
  | 'COUNT'
  | 'TEST'
  | 'REFUND'
  | 'AFTER_CLOSE'
  | 'PERMISSION';

export const DRAWER_EVENT_TYPES: DrawerEventType[] = [
  'CASH_SALE', 'MANUAL', 'CHANGE', 'CASH_IN', 'CASH_OUT', 'DEPOSIT', 'COUNT', 'TEST', 'REFUND', 'AFTER_CLOSE',
];

export const DRAWER_REASONS = [
  'CHANGE', 'GIVE_CHANGE', 'CASH_IN', 'CASH_OUT', 'DEPOSIT', 'COUNT', 'CORRECTION', 'TEST', 'OTHER',
] as const;

export type MovementType = 'cash_in' | 'cash_out' | 'deposit' | 'count';
export const MOVEMENT_TYPES: MovementType[] = ['cash_in', 'cash_out', 'deposit', 'count'];

export interface DrawerEventRow {
  id: string;
  category: 'drawer' | 'permission';
  eventType: DrawerEventType;
  permission: string | null;
  decision: 'allow' | 'approval' | 'deny' | null;
  result: 'approved' | 'denied' | 'failed';
  resultReason: string | null;
  shopId: string | null;
  shopName: string | null;
  machineId: string;
  machineName: string | null;
  drawerName: string | null;
  deviceId: string | null;
  shiftId: string | null;
  employeeId: string | null;
  employeeName: string | null;
  employeeRole: string | null;
  approverId: string | null;
  approverName: string | null;
  tableId: string | null;
  saleId: string | null;
  paymentId: string | null;
  originalSaleId: string | null;
  reason: string | null;
  reasonNote: string | null;
  movementId: string | null;
  cashMovementType: string | null;
  amount: number | null;
  expectedBalance: number | null;
  offline: boolean;
  occurredAt: string | null;
  exceptions: string[];
}

export interface MovementRow {
  id: string;
  type: MovementType;
  amount: number | null;
  expectedBefore: number | null;
  expectedAfter: number | null;
  variance: number | null;
  blind: boolean;
  reason: string | null;
  note: string | null;
  source: string | null;
  shopName: string | null;
  machineId: string;
  machineName: string | null;
  shiftId: string | null;
  employeeId: string | null;
  employeeName: string | null;
  approverId: string | null;
  approverName: string | null;
  drawerEventId: string | null;
  offline: boolean;
  occurredAt: string | null;
}

export interface DrawerKpis {
  openings: number;
  saleOpenings: number;
  manualOpenings: number;
  cashInCount: number;
  cashIn: number;
  cashOutCount: number;
  cashOut: number;
  depositCount: number;
  deposits: number;
  managerApprovals: number;
  afterCloseOpenings: number;
  blockedAttempts: number;
  failedOpenings: number;
  countVariances: number;
  countVarianceTotal: number;
  exceptions: number;
}

export interface DrawerEventsPage {
  total: number;
  page: number;
  pageSize: number;
  rows: DrawerEventRow[];
  kpis: DrawerKpis;
}

export interface MovementsPage {
  total: number;
  page: number;
  pageSize: number;
  rows: MovementRow[];
  totals: Partial<Record<MovementType, { count: number; amount: number; variance: number }>>;
}

export type TimelineItem = ({ kind: 'event' } & DrawerEventRow) | ({ kind: 'movement' } & MovementRow);

export interface ShiftTimeline {
  shift: {
    id: string;
    machineId: string;
    sequenceNumber: number | null;
    openedAt: string | null;
    closedAt: string | null;
    openingCash: number | null;
    expectedCash: number | null;
    countedCash: number | null;
    discrepancy: number | null;
    cashIn: number;
    cashOut: number;
    deposits: number;
  };
  kpis: DrawerKpis;
  items: TimelineItem[];
  exceptions: {
    id: string;
    type: string;
    severity: string;
    status: string;
    occurredAt: string | null;
    amount: number | null;
    posUserName: string | null;
    tillEventId: string | null;
  }[];
}

/** The report's filters (spec §16): company, shop, till, employee, role, shift, dates, type, reason… */
export interface DrawerFilters {
  from?: string;
  to?: string;
  companyId?: string;
  shopId?: string;
  machineId?: string;
  employee?: string;
  role?: string;
  shiftId?: string;
  eventType?: DrawerEventType[];
  reason?: string;
  managerApproval?: boolean | null;
  withSale?: boolean | null;
  result?: ('approved' | 'denied' | 'failed')[];
  exceptionsOnly?: boolean;
}

/** The filters as query parameters: empty ones left out, lists comma-joined, tri-states only when set. */
export function drawerQuery(f: DrawerFilters): Record<string, string> {
  const out: Record<string, string> = {};
  const put = (k: string, v: string | undefined | null) => {
    if (v !== undefined && v !== null && v !== '') out[k] = v;
  };
  put('from', f.from);
  put('to', f.to);
  put('companyId', f.companyId);
  put('shopId', f.shopId);
  put('machineId', f.machineId);
  put('employee', f.employee);
  put('role', f.role);
  put('shiftId', f.shiftId);
  if (f.eventType?.length) out.eventType = f.eventType.join(',');
  put('reason', f.reason);
  if (f.managerApproval === true || f.managerApproval === false) out.managerApproval = String(f.managerApproval);
  if (f.withSale === true || f.withSale === false) out.withSale = String(f.withSale);
  if (f.result?.length) out.result = f.result.join(',');
  if (f.exceptionsOnly) out.exceptionsOnly = 'true';
  return out;
}

/** How a movement moves the expected balance (spec §8): in +, out and deposits −, a count nothing. */
export function movementSign(type: MovementType): number {
  return type === 'cash_in' ? 1 : type === 'cash_out' || type === 'deposit' ? -1 : 0;
}

/**
 * The expected balance after each timeline item. The till's own snapshot when it sent one
 * (an event's `expectedBalance`, a movement's `expectedAfter`) — it knows its cash sales —
 * else the last known balance moved by the movement. Openings by themselves never move
 * it (spec §20: "פתיחה בלבד אינה משפיעה").
 */
export function runningExpected(items: TimelineItem[], opening: number | null): (number | null)[] {
  let balance: number | null = opening;
  return items.map((item) => {
    if (item.kind === 'event') {
      if (item.expectedBalance !== null && item.expectedBalance !== undefined) balance = item.expectedBalance;
      return balance;
    }
    if (item.expectedAfter !== null && item.expectedAfter !== undefined) {
      balance = item.expectedAfter;
    } else if (balance !== null && item.amount !== null) {
      balance = Math.round((balance + movementSign(item.type) * item.amount) * 100) / 100;
    }
    return balance;
  });
}

/** True when a row deserves a second look: refused, failed, after close, or flagged. */
export function isNotable(row: Pick<DrawerEventRow, 'result' | 'eventType' | 'exceptions'>): boolean {
  return row.result !== 'approved' || row.eventType === 'AFTER_CLOSE' || row.exceptions.length > 0;
}
