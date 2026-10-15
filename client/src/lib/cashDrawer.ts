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
  | 'PERMISSION'
  // "מגירה נפתחה מרחוק" (P:/specs/bill-print-other-till.md §9): another till's drawer, opened from this one.
  | 'REMOTE_SALE'
  | 'REMOTE_MANUAL'
  // "הפקדת מזומן מעובד" (P:/specs/drawer-away.md §5.4): an employee's cash counted into this drawer.
  | 'WALLET_DEPOSIT';

export const DRAWER_EVENT_TYPES: DrawerEventType[] = [
  'CASH_SALE', 'MANUAL', 'CHANGE', 'CASH_IN', 'CASH_OUT', 'DEPOSIT', 'COUNT', 'TEST', 'REFUND', 'AFTER_CLOSE',
  'REMOTE_SALE', 'REMOTE_MANUAL', 'WALLET_DEPOSIT',
];

export const DRAWER_REASONS = [
  'CHANGE', 'GIVE_CHANGE', 'CASH_IN', 'CASH_OUT', 'DEPOSIT', 'COUNT', 'CORRECTION', 'TEST', 'OTHER',
] as const;

/**
 * "הכסף אצלי" (P:/specs/drawer-away.md §5.4): `wallet_in` — a cash payment kept by the employee;
 * `wallet_deposit` — counted into a drawer ("הפקדה מעובד"), its gap in `variance`.
 */
export type MovementType = 'cash_in' | 'cash_out' | 'deposit' | 'count' | 'wallet_in' | 'wallet_deposit';
export const MOVEMENT_TYPES: MovementType[] = ['cash_in', 'cash_out', 'deposit', 'count', 'wallet_in', 'wallet_deposit'];

/** One employee's cash not deposited yet (`GET /cash-drawer/wallets`). */
export interface CashWallet {
  employeeId: string;
  employeeName: string | null;
  balance: number;
  accruals: number;
  firstAt: string | null;
  lastAt: string | null;
}

export interface CashWalletsPage {
  wallets: CashWallet[];
  total: number;
}

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
  /** The till's register number (P:\specs\reports-upgrade.md §4.6, new: absent from an older server). */
  posNumber?: string | null;
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
  shopId?: string | null;
  shopName: string | null;
  machineId: string;
  machineName: string | null;
  /** The till's register number (§4.6, new). */
  posNumber?: string | null;
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

/** The days the server read (§4.6: sent even with no rows). */
export interface DrawerWindow {
  from: string;
  to: string;
}

export interface DrawerEventsPage {
  total: number;
  page: number;
  pageSize: number;
  rows: DrawerEventRow[];
  kpis: DrawerKpis;
  window?: DrawerWindow;
}

export interface MovementsPage {
  total: number;
  page: number;
  pageSize: number;
  rows: MovementRow[];
  totals: Partial<Record<MovementType, { count: number; amount: number; variance: number }>>;
  window?: DrawerWindow;
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

// ── The report's own filters in the URL (P:\specs\reports-upgrade.md §5) ──────────

/** The largest page the list endpoints serve: an export reads every page at this size. */
export const DRAWER_PAGE_SIZE_MAX = 500;

/**
 * The report's own filters as URL keys with their defaults (`ReportFilterSpec.extras`):
 * the openings' type, reason, manager approval, sale, result, role, exceptions only; the
 * movements' type; the employee and the shift of both lists.
 */
export const DRAWER_EXTRAS = {
  eventType: '',
  reason: '',
  approval: '',
  sale: '',
  result: '',
  role: '',
  employee: '',
  exceptions: '',
  movementType: '',
  shift: '',
} as const;

export type DrawerExtraKey = keyof typeof DRAWER_EXTRAS;

/** The URL keys each list reads (the other list's stay in the URL, unused). */
export const DRAWER_TAB_EXTRAS: Record<'events' | 'movements', readonly DrawerExtraKey[]> = {
  events: ['eventType', 'reason', 'approval', 'sale', 'result', 'role', 'employee', 'exceptions', 'shift'],
  movements: ['movementType', 'employee', 'shift'],
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A shift id the server takes (a uuid; anything else would be a 422). */
export function isShiftId(raw: string | null | undefined): boolean {
  return UUID.test((raw ?? '').trim());
}

const RESULTS = ['approved', 'denied', 'failed'] as const;

/**
 * One list's filters from the URL's extras — a value the server does not know is dropped,
 * never sent. The range and the scope are the page's (`from`, `to`, `companyId`…).
 */
export function drawerFiltersFromExtras(
  extras: Partial<Record<DrawerExtraKey, string>>,
  tab: 'events' | 'movements',
): DrawerFilters & { type?: MovementType[] } {
  const get = (k: DrawerExtraKey) => (extras[k] ?? '').trim();
  const out: DrawerFilters & { type?: MovementType[] } = {};
  const employee = get('employee');
  if (employee) out.employee = employee;
  const shift = get('shift');
  if (isShiftId(shift)) out.shiftId = shift;
  if (tab === 'movements') {
    const type = get('movementType') as MovementType;
    if (MOVEMENT_TYPES.includes(type)) out.type = [type];
    return out;
  }
  const eventType = get('eventType') as DrawerEventType;
  if (DRAWER_EVENT_TYPES.includes(eventType)) out.eventType = [eventType];
  const reason = get('reason');
  if (reason) out.reason = reason;
  const approval = get('approval');
  if (approval === 'yes' || approval === 'no') out.managerApproval = approval === 'yes';
  const sale = get('sale');
  if (sale === 'yes' || sale === 'no') out.withSale = sale === 'yes';
  const result = get('result') as (typeof RESULTS)[number];
  if (RESULTS.includes(result)) out.result = [result];
  const role = get('role');
  if (role) out.role = role;
  if (get('exceptions') === '1') out.exceptionsOnly = true;
  return out;
}

/** The extras that narrow the given list right now (for the export header and the badge). */
export function activeDrawerExtras(
  extras: Partial<Record<DrawerExtraKey, string>>,
  tab: 'events' | 'movements',
): DrawerExtraKey[] {
  const f = drawerFiltersFromExtras(extras, tab);
  const on: Record<DrawerExtraKey, boolean> = {
    eventType: Boolean(f.eventType),
    reason: Boolean(f.reason),
    approval: f.managerApproval === true || f.managerApproval === false,
    sale: f.withSale === true || f.withSale === false,
    result: Boolean(f.result),
    role: Boolean(f.role),
    employee: Boolean(f.employee),
    exceptions: Boolean(f.exceptionsOnly),
    movementType: Boolean(f.type),
    shift: Boolean(f.shiftId),
  };
  return DRAWER_TAB_EXTRAS[tab].filter((k) => on[k]);
}
