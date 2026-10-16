/**
 * "מגירת מזומן" — the pure half of the Windows till's drawer (pos-android domain/CashDrawer.kt, RemoteDrawer.kt,
 * ReceiptPrinterConfig.kt `CashDrawerMode`; pos-server docs/SPEC_ROLES_PERMISSIONS.md, the owner's drawer spec §19;
 * P:/specs/bill-print-other-till.md §9).
 *
 * Every physical opening of a drawer is a `DrawerRequest` decided here, in the spec's order of checks:
 *
 *  1. who is asking (signed in, or the technician's own code for a hardware test);
 *  2. their role's permission for this kind of opening (`permissionOf`);
 *  3. the context and its reason (a manual opening needs one when the till says so; "אחר" a note);
 *  4. the sale / payment it claims (a cash sale must name its recorded sale);
 *  5. the shift (no open shift → "after the close": blocked by the setting, else its own permission);
 *  6. the limits (the manual openings of the shift, the cash-out approval amount, "every manual opening by a manager");
 *  7. a manager's override when one is needed — one action, both names recorded;
 *
 * and only then the audit row, the physical kick, the result (main/till/drawerService.ts). Offline changes nothing here:
 * the profile, the parameters and the counts are all local. Money: agorot (integers); a role's `maxAmount` is in shekels,
 * as the cloud sends it. Every Hebrew text is the Android till's.
 */

import { permissionState, type PermState, type RosterUser } from '../desktopExit';
import type { XTill } from '../sale';

/** The permission codes of the drawer (the cloud's catalogue; Android `Perm`). */
export const DRAWER_PERM = {
  ON_CASH_SALE: 'CASH_DRAWER.OPEN_ON_CASH_SALE',
  MANUAL: 'CASH_DRAWER.OPEN_MANUALLY',
  CHANGE: 'CASH_DRAWER.OPEN_FOR_CHANGE',
  CASH_IN: 'CASH_DRAWER.CASH_IN',
  CASH_OUT: 'CASH_DRAWER.CASH_OUT',
  DEPOSIT: 'CASH_DRAWER.DEPOSIT',
  COUNT: 'CASH_DRAWER.COUNT',
  BLIND_COUNT: 'CASH_DRAWER.BLIND_COUNT',
  TEST: 'CASH_DRAWER.OPEN_FOR_TEST',
  APPROVE: 'CASH_DRAWER.APPROVE_OPEN',
  AFTER_CLOSE: 'CASH_DRAWER.OPEN_AFTER_CLOSE',
  VIEW_LOG: 'CASH_DRAWER.VIEW_LOG',
  VIEW_MOVEMENTS: 'CASH_DRAWER.VIEW_CASH_MOVEMENTS',
  OPEN_REMOTE: 'CASH_DRAWER.OPEN_REMOTE',
  WALLET_DEPOSIT: 'CASH_DRAWER.WALLET_DEPOSIT',
  REFUND: 'REFUND',
} as const;

/** The drawer codes' Hebrew names (Android `Perm.LABELS`): "אין לך הרשאה: הוצאת מזומן". */
export const DRAWER_PERM_LABEL: Record<string, string> = {
  'CASH_DRAWER.OPEN_ON_CASH_SALE': 'פתיחת מגירה בעסקת מזומן',
  'CASH_DRAWER.OPEN_MANUALLY': 'פתיחת מגירה ידנית',
  'CASH_DRAWER.OPEN_FOR_CHANGE': 'פריטת כסף / מתן עודף',
  'CASH_DRAWER.CASH_IN': 'הכנסת מזומן',
  'CASH_DRAWER.CASH_OUT': 'הוצאת מזומן',
  'CASH_DRAWER.DEPOSIT': 'הפקדה',
  'CASH_DRAWER.COUNT': 'ספירת מגירה',
  'CASH_DRAWER.BLIND_COUNT': 'ספירה עיוורת',
  'CASH_DRAWER.OPEN_FOR_TEST': 'בדיקת מגירה',
  'CASH_DRAWER.APPROVE_OPEN': 'אישור פעולת מגירה',
  'CASH_DRAWER.OPEN_AFTER_CLOSE': 'פתיחת מגירה לאחר סגירה / Z',
  'CASH_DRAWER.VIEW_LOG': 'לוג פתיחות מגירה',
  'CASH_DRAWER.VIEW_CASH_MOVEMENTS': 'תנועות מזומן',
  'CASH_DRAWER.OPEN_REMOTE': 'פתיחת מגירה בקופה אחרת',
  'CASH_DRAWER.WALLET_DEPOSIT': 'קבלת הפקדת מזומן מעובד',
  REFUND: 'זיכוי / החזר',
  USER_SESSION_RELEASE: 'שחרור עובד מקופה אחרת',
  MULTI_DEVICE_LOGIN: 'עבודה בכמה מכשירים במקביל',
  ATTENDANCE_MANAGE: 'נוכחות — אישור מנהל',
};

export const drawerPermLabel = (code: string): string => DRAWER_PERM_LABEL[code] ?? code;

/** Approving a drawer action is a drawer code's, except the approval itself (Android `Perm.isDrawer`). */
export const isDrawerCode = (code: string): boolean => code.startsWith('CASH_DRAWER.') && code !== DRAWER_PERM.APPROVE;

/* ------------------------------------------------------------------ contexts */

export type DrawerContext = 'CASH_SALE' | 'MANUAL' | 'CHANGE' | 'CASH_IN' | 'CASH_OUT' | 'DEPOSIT' | 'COUNT' | 'BLIND_COUNT' | 'TEST' | 'REFUND' | 'WALLET_DEPOSIT';

/** Each kind of opening: the event type it is recorded as, and the permission it is decided under. */
export const DRAWER_CONTEXT: Record<DrawerContext, { eventType: string; permission: string }> = {
  CASH_SALE: { eventType: 'CASH_SALE', permission: DRAWER_PERM.ON_CASH_SALE },
  MANUAL: { eventType: 'MANUAL', permission: DRAWER_PERM.MANUAL },
  CHANGE: { eventType: 'CHANGE', permission: DRAWER_PERM.CHANGE },
  CASH_IN: { eventType: 'CASH_IN', permission: DRAWER_PERM.CASH_IN },
  CASH_OUT: { eventType: 'CASH_OUT', permission: DRAWER_PERM.CASH_OUT },
  DEPOSIT: { eventType: 'DEPOSIT', permission: DRAWER_PERM.DEPOSIT },
  COUNT: { eventType: 'COUNT', permission: DRAWER_PERM.COUNT },
  // A count with the expected balance hidden until the counted amount is in (spec §9).
  BLIND_COUNT: { eventType: 'COUNT', permission: DRAWER_PERM.BLIND_COUNT },
  TEST: { eventType: 'TEST', permission: DRAWER_PERM.TEST },
  // Money handed back on a refund (spec §13): under the refund's own approval.
  REFUND: { eventType: 'REFUND', permission: DRAWER_PERM.REFUND },
  // "הפקדת מזומן מעובד" (P:/specs/drawer-away.md §5.4): an employee's cash counted into this drawer.
  WALLET_DEPOSIT: { eventType: 'WALLET_DEPOSIT', permission: DRAWER_PERM.WALLET_DEPOSIT },
};

/** The reasons of spec §5, by code, in the order the "פתח מגירה" sheet offers them (the till's `drawer_reason_<code>`). */
export const DRAWER_REASONS = ['CHANGE', 'GIVE_CHANGE', 'CASH_IN', 'CASH_OUT', 'DEPOSIT', 'COUNT', 'CORRECTION', 'TEST', 'OTHER'] as const;
export type DrawerReason = (typeof DRAWER_REASONS)[number];

export const DRAWER_REASON_LABEL: Record<DrawerReason, string> = {
  CHANGE: 'פריטת כסף',
  GIVE_CHANGE: 'מתן עודף',
  CASH_IN: 'הכנסת מזומן',
  CASH_OUT: 'הוצאת מזומן',
  DEPOSIT: 'הפקדה',
  COUNT: 'ספירת מגירה',
  CORRECTION: 'תיקון טעות',
  TEST: 'בדיקה',
  OTHER: 'אחר',
};

/** Reasons that open a screen of their own rather than the drawer straight away. */
export const MOVEMENT_REASONS: ReadonlySet<string> = new Set(['CASH_IN', 'CASH_OUT', 'DEPOSIT', 'COUNT']);

/** A reason picked on "פתח מגירה" is that kind of opening (Android `DrawerReasons.contextOf`). */
export function contextOfReason(reason: string | null | undefined): DrawerContext {
  switch (reason) {
    case 'CHANGE':
    case 'GIVE_CHANGE':
      return 'CHANGE';
    case 'CASH_IN':
      return 'CASH_IN';
    case 'CASH_OUT':
      return 'CASH_OUT';
    case 'DEPOSIT':
      return 'DEPOSIT';
    case 'COUNT':
      return 'COUNT';
    case 'TEST':
      return 'TEST';
    default:
      return 'MANUAL';
  }
}

/* ------------------------------------------------------------------ settings */

/** The drawer's parameters (spec §17), read from the till parameters as the cloud writes them. */
export interface DrawerSettings {
  requireReason: boolean;
  requireNoteForOther: boolean;
  requireManagerForManual: boolean;
  movementsEnabled: boolean;
  /** Cash out / deposit above this (shekels) always needs a manager (0 = none). */
  approvalAmount: number;
  allowAfterClose: boolean;
  blindCount: boolean;
  /** Manual openings per employee per shift before each further one needs a manager (0 = none). */
  maxManualPerShift: number;
}

export const DEFAULT_DRAWER_SETTINGS: DrawerSettings = {
  requireReason: true,
  requireNoteForOther: true,
  requireManagerForManual: false,
  movementsEnabled: true,
  approvalAmount: 0,
  allowAfterClose: true,
  blindCount: false,
  maxManualPerShift: 0,
};

const str = (v: unknown): string | null => (v === undefined || v === null ? null : String(v));

export function drawerSettingsOf(params: Record<string, unknown>): DrawerSettings {
  const bool = (key: string, d: boolean) => {
    const v = str(params[key])?.trim().toLowerCase();
    return v === 'true' || v === '1' ? true : v === 'false' || v === '0' ? false : d;
  };
  const num = (key: string, d: number) => {
    const raw = str(params[key])?.trim();
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) ? n : d;
  };
  return {
    requireReason: bool('cashDrawer.requireReason', true),
    requireNoteForOther: bool('cashDrawer.requireNoteForOther', true),
    requireManagerForManual: bool('cashDrawer.requireManagerApproval', false),
    movementsEnabled: bool('cashDrawer.cashMovementsEnabled', true),
    approvalAmount: num('cashDrawer.cashOutApprovalAmount', 0),
    allowAfterClose: bool('cashDrawer.allowOpenAfterClose', true),
    blindCount: bool('cashDrawer.blindCount', false),
    maxManualPerShift: Math.trunc(num('cashDrawer.maxManualOpensPerShift', 0)),
  };
}

/* ------------------------------------------------------------ the drawer mode */

/**
 * `cashDrawer` (the receipt printer's drawer, ReceiptPrinterConfig.kt): never, on every payment that moves cash, that and a
 * button in the menu — and "בתשלום מזומן — לשאול" (bill-print-other-till §9א): "לפתוח מגירה?" after a cash payment.
 */
export type CashDrawerMode = 'off' | 'on_cash' | 'on_cash_and_button' | 'on_cash_ask' | 'on_cash_ask_and_button';

export function cashDrawerModeOf(params: Record<string, unknown>): CashDrawerMode {
  const v = (str(params.cashDrawer) ?? '').trim().toLowerCase();
  const asks = v.includes('לשאול') || v.includes('ask');
  const button = v.includes('כפתור') || v.includes('button');
  if (v === '' || v === 'כבוי' || v === 'off' || v === 'false') return 'off';
  if (asks && button) return 'on_cash_ask_and_button';
  if (asks) return 'on_cash_ask';
  if (button) return 'on_cash_and_button';
  return 'on_cash';
}

export const drawerModeOpensOnCash = (m: CashDrawerMode): boolean => m !== 'off';
export const drawerModeHasButton = (m: CashDrawerMode): boolean => m === 'on_cash_and_button' || m === 'on_cash_ask_and_button';
export const drawerModeAsks = (m: CashDrawerMode): boolean => m === 'on_cash_ask' || m === 'on_cash_ask_and_button';

/** §9א: "לפתוח מגירה?" — unanswered for `timeoutSec`, it does `openByDefault` (`cashDrawerAskDefault`: open — the default — or skip). */
export interface DrawerAskSettings {
  timeoutSec: number;
  openByDefault: boolean;
}

export const DRAWER_ASK_TIMEOUT = { DEFAULT: 8, MIN: 3, MAX: 60 } as const;

export function drawerAskSettingsOf(params: Record<string, unknown>): DrawerAskSettings {
  const raw = str(params.cashDrawerAskTimeoutSec)?.trim();
  const n = raw ? Number(raw) : NaN;
  const timeoutSec = Number.isFinite(n) ? Math.min(DRAWER_ASK_TIMEOUT.MAX, Math.max(DRAWER_ASK_TIMEOUT.MIN, Math.trunc(n))) : DRAWER_ASK_TIMEOUT.DEFAULT;
  const d = (str(params.cashDrawerAskDefault) ?? '').trim().toLowerCase();
  return { timeoutSec, openByDefault: !['skip', 'no', 'לא', 'false'].includes(d) };
}

/** The cashier's answer — null: none in time — as what happens. */
export const drawerAskOpens = (s: DrawerAskSettings, answer: boolean | null): boolean => answer ?? s.openByDefault;

/** §9ב `remotePrintDrawer`: another till's drawer after a cash payment whose receipt went there. */
export type RemoteDrawerMode = 'never' | 'ask' | 'auto';

export function remoteDrawerModeOf(raw: unknown): RemoteDrawerMode {
  const v = (str(raw) ?? '').trim().toLowerCase();
  return v === 'ask' ? 'ask' : v === 'auto' || v === 'always' ? 'auto' : 'never';
}

export type RemoteDrawerAction = 'none' | 'ask' | 'open';

/** §9ב: only for a payment that moved cash, only where the printer there has a drawer (unknown — the host decides). */
export function remoteDrawerAction(mode: RemoteDrawerMode, cashMoved: boolean, hostHasDrawer: boolean | null): RemoteDrawerAction {
  if (!cashMoved || hostHasDrawer === false) return 'none';
  if (mode === 'ask') return 'ask';
  if (mode === 'auto') return 'open';
  return 'none';
}

/** The host's answer to another till's drawer job (§9ב): `null` — open; else the ack's error code. */
export type HostDrawerVerdict = null | 'no_drawer' | 'busy_payment' | 'expired';

/** §9ב / §10.9: the host opens only when its printer has a drawer, it is not mid-payment, and the job is not past its time. */
export function hostDrawerVerdict(hasDrawer: boolean, midPayment: boolean, expired = false): HostDrawerVerdict {
  if (expired) return 'expired';
  if (!hasDrawer) return 'no_drawer';
  if (midPayment) return 'busy_payment';
  return null;
}

/* ---------------------------------------------------------------- the request */

/** One request to open a drawer — never a kick by itself. Amounts in agorot. */
export interface DrawerRequest {
  context: DrawerContext;
  reason?: string | null;
  note?: string | null;
  /** A movement's amount, a sale's cash, a refund's payout. */
  amountAgorot?: number | null;
  saleId?: string | null;
  paymentId?: string | null;
  tableId?: string | null;
  originalSaleId?: string | null;
  /** The movement this opening serves (spec §7: two records). */
  movementId?: string | null;
  /** Already approved by a manager for this very action (a refund's approver): not asked again — and recorded. */
  preApproved?: boolean;
  /** A hardware test from the technician's screen, with no one signed in. */
  technician?: boolean;
  /**
   * The drawer of another till's printer (bill-print-other-till §9ב–§9ג): decided under `CASH_DRAWER.OPEN_REMOTE` — and every
   * rule of its own kind besides; its own kind's permission denied refuses it too.
   */
  remote?: boolean;
  /** A payment's document (its type code and number): another till's drawer job and a wallet's note say it. */
  documentType?: string | null;
  documentNumber?: string | null;
}

export const requestPermission = (r: DrawerRequest): string => (r.remote ? DRAWER_PERM.OPEN_REMOTE : DRAWER_CONTEXT[r.context].permission);
export const requestIsManual = (r: DrawerRequest): boolean => r.context === 'MANUAL' || r.context === 'CHANGE';
/** Opens the drawers that open on cash (a payment, a refund, an employee's deposit). */
export const requestPaymentLike = (r: DrawerRequest): boolean => r.context === 'CASH_SALE' || r.context === 'REFUND' || r.context === 'WALLET_DEPOSIT';
const isMovement = (c: DrawerContext) => c === 'CASH_IN' || c === 'CASH_OUT' || c === 'DEPOSIT';

/* -------------------------------------------------------------- the profile */

/** A role's limits as the cloud ships them on the roster: `{code: {maxAmount: shekels, maxPercent}}`. */
export type PermLimits = Record<string, Record<string, number>>;

/** A till user as the drawer reads them: their states (the cloud's or the legacy role's) and their limits. */
export type DrawerUser = Pick<RosterUser, 'role' | 'permissions'> & { limits?: PermLimits | null };

export const stateOfUser = (u: DrawerUser, code: string): PermState => permissionState(u, code);

/** `code`'s own limits cover this amount (agorot) — a limit not set covers anything. */
export function withinLimits(u: DrawerUser, code: string, amountAgorot?: number | null): boolean {
  const max = u.limits?.[code]?.maxAmount;
  if (amountAgorot === null || amountAgorot === undefined || typeof max !== 'number' || !Number.isFinite(max)) return true;
  return Math.abs(amountAgorot) <= Math.round(max * 100);
}

/** May do `code` alone at this amount: allowed, and within its limits (Android `PermissionProfile.covers`). */
export const covers = (u: DrawerUser, code: string, amountAgorot?: number | null): boolean => stateOfUser(u, code) === 'allow' && withinLimits(u, code, amountAgorot);

/** May `approver` say yes to `code` for somebody else (Android `PermissionService.mayApprove`). */
export function mayApproveCode(approver: DrawerUser, code: string, amountAgorot?: number | null): boolean {
  if (!covers(approver, code, amountAgorot)) return false;
  if (isDrawerCode(code) && stateOfUser(approver, DRAWER_PERM.APPROVE) !== 'allow') return false;
  return true;
}

/* -------------------------------------------------------------- the verdict */

export type ApprovalWhy = 'ROLE' | 'OVER_LIMIT' | 'SETTING';
export type DenyWhy = 'ROLE' | 'NOT_SIGNED_IN' | 'SETTING';

export type DrawerVerdict =
  | { kind: 'proceed'; eventType: string; permission: string; decision: PermState }
  | { kind: 'approval'; eventType: string; permission: string; why: ApprovalWhy; amountAgorot: number | null }
  | { kind: 'refused'; eventType: string; permission: string; why: string };

/** The prompt's message for a denial (Android `PermissionService.deniedText`). */
export function deniedText(code: string, why: DenyWhy): string {
  if (why === 'NOT_SIGNED_IN') return 'יש להתחבר לקופה';
  if (why === 'SETTING') return `${drawerPermLabel(code)} — חסום בהגדרות הקופה`;
  return `אין לך הרשאה: ${drawerPermLabel(code)}`;
}

/** The prompt's line for an approval: why a manager is asked (Android `PermissionService.approvalText`). */
export function approvalText(code: string, why: ApprovalWhy): string {
  if (why === 'OVER_LIMIT') return `${drawerPermLabel(code)} — מעל המותר לך, דורש אישור מנהל`;
  if (why === 'SETTING') return `${drawerPermLabel(code)} — באישור מנהל לפי הגדרות הקופה`;
  return `${drawerPermLabel(code)} — דורש אישור מנהל`;
}

/** What `evaluate` knows besides the request. */
export interface DrawerSituation {
  user: DrawerUser | null;
  shiftOpen: boolean;
  settings: DrawerSettings;
  /** Manual openings this employee already made in the open shift. */
  manualOpensThisShift?: number;
}

/** The drawer of another till's printer opened from this one: with a payment, or by hand (§9ב–§9ג). */
export const REMOTE_SALE = 'REMOTE_SALE';
export const REMOTE_MANUAL = 'REMOTE_MANUAL';

/** Steps 1–7 of spec §19, in that order (Android `CashDrawerPolicy.evaluate`). */
export function evaluateDrawer(request: DrawerRequest, situation: DrawerSituation): DrawerVerdict {
  const afterClose = !situation.shiftOpen && request.context !== 'TEST';
  const eventType = request.remote ? (request.context === 'CASH_SALE' ? REMOTE_SALE : REMOTE_MANUAL) : afterClose ? 'AFTER_CLOSE' : DRAWER_CONTEXT[request.context].eventType;
  // After the close the opening is decided under its own permission.
  const permission = afterClose ? DRAWER_PERM.AFTER_CLOSE : requestPermission(request);
  const refused = (why: string, perm = permission): DrawerVerdict => ({ kind: 'refused', eventType, permission: perm, why });

  // 1. Who.
  const user = situation.user;
  if (!user) {
    return request.technician && request.context === 'TEST' ? { kind: 'proceed', eventType, permission, decision: 'allow' } : refused(deniedText(permission, 'NOT_SIGNED_IN'));
  }
  // 2. The role.
  const state = stateOfUser(user, permission);
  if (state === 'deny') return refused(deniedText(permission, 'ROLE'));
  // Another till's drawer: never what this kind of opening is denied here.
  if (request.remote && stateOfUser(user, DRAWER_CONTEXT[request.context].permission) === 'deny') {
    const own = DRAWER_CONTEXT[request.context].permission;
    return refused(deniedText(own, 'ROLE'), own);
  }
  // 3. Context and reason.
  const manual = requestIsManual(request);
  if (manual && situation.settings.requireReason && !(request.reason ?? '').trim()) return refused('יש לבחור סיבה לפתיחת המגירה');
  if (request.reason === 'OTHER' && situation.settings.requireNoteForOther && !(request.note ?? '').trim()) return refused('בסיבה "אחר" חובה לכתוב הערה');
  const movement = isMovement(request.context);
  if (movement && !situation.settings.movementsEnabled) return refused('הכנסה / הוצאה / הפקדה כבויות בהגדרות הקופה');
  if (movement && (request.amountAgorot === null || request.amountAgorot === undefined || request.amountAgorot <= 0)) return refused('יש להזין סכום');
  // 4. The sale / payment it claims (spec §4, §12, §13).
  if (request.context === 'CASH_SALE' && !(request.saleId ?? '').trim()) return refused('אין עסקת מזומן שנרשמה — המגירה נפתחת רק אחרי תשלום מזומן');
  if (request.context === 'REFUND' && !(request.saleId ?? '').trim()) return refused('אין זיכוי שנרשם');
  // 5. The shift.
  if (afterClose && !situation.settings.allowAfterClose) return refused(deniedText(permission, 'SETTING'));
  // 6. Limits.
  let why: ApprovalWhy | null = state === 'approval' ? 'ROLE' : null;
  // A refund's own limit was the refund's question (checkout), not the drawer's.
  if (why === null && request.context !== 'REFUND' && !covers(user, permission, movement ? request.amountAgorot : null)) why = 'OVER_LIMIT';
  const approvesDrawer = stateOfUser(user, DRAWER_PERM.APPROVE) === 'allow';
  if (why === null && manual && !afterClose) {
    const max = situation.settings.maxManualPerShift;
    if (max > 0 && (situation.manualOpensThisShift ?? 0) >= max) why = 'OVER_LIMIT';
    if (situation.settings.requireManagerForManual && !approvesDrawer) why = 'SETTING';
  }
  if (why === null && (request.context === 'CASH_OUT' || request.context === 'DEPOSIT')) {
    const limit = situation.settings.approvalAmount;
    if (limit > 0 && (request.amountAgorot ?? 0) > Math.round(limit * 100)) why = 'SETTING';
  }
  // 7. The override.
  if (why !== null && !request.preApproved) return { kind: 'approval', eventType, permission, why, amountAgorot: request.amountAgorot ?? null };
  return { kind: 'proceed', eventType, permission, decision: state };
}

/**
 * May `approver` approve `verdict` for someone else: allowed it alone within their limit for the amount, allowed to approve
 * drawer actions — a refund's by the refund's own rule (Android `CashDrawerPolicy.mayApprove`).
 */
export function mayApproveDrawer(approver: DrawerUser, verdict: Extract<DrawerVerdict, { kind: 'approval' }>): boolean {
  if (verdict.permission === DRAWER_PERM.REFUND) return covers(approver, DRAWER_PERM.REFUND, verdict.amountAgorot);
  if (!mayApproveCode(approver, verdict.permission, verdict.amountAgorot)) return false;
  return stateOfUser(approver, DRAWER_PERM.APPROVE) === 'allow';
}

/** The verdict's `decision` as the audit writes it. */
export function decisionOf(v: DrawerVerdict): PermState {
  return v.kind === 'proceed' ? v.decision : v.kind === 'approval' ? 'approval' : 'deny';
}

/* ----------------------------------------------------------- the movements */

export const MOVEMENT = {
  CASH_IN: 'cash_in',
  CASH_OUT: 'cash_out',
  DEPOSIT: 'deposit',
  COUNT: 'count',
  WALLET_IN: 'wallet_in',
  WALLET_DEPOSIT: 'wallet_deposit',
} as const;

export type MovementType = (typeof MOVEMENT)[keyof typeof MOVEMENT];

/** Σ of a shift's movements, by type (`cash_movements.type`); a count moves nothing. */
export interface CashMovementTotals {
  cashIn: number;
  cashOut: number;
  deposits: number;
}

export function movementTotalsOf(rows: ReadonlyArray<{ type: string; amountAgorot: number }>): CashMovementTotals {
  const t = { cashIn: 0, cashOut: 0, deposits: 0 };
  for (const r of rows) {
    if (r.type === MOVEMENT.CASH_IN) t.cashIn += r.amountAgorot;
    else if (r.type === MOVEMENT.CASH_OUT) t.cashOut += r.amountAgorot;
    else if (r.type === MOVEMENT.DEPOSIT) t.deposits += r.amountAgorot;
  }
  return t;
}

export const movementsNet = (m: CashMovementTotals): number => m.cashIn - m.cashOut - m.deposits;

/**
 * One shift's wallet figures on this device (drawer-away §5.6): `walletIn` — the cash its payments left with employees;
 * `walletDeposits` — what was counted into its drawer from employees. The drawer's expected cash moves by the net, always.
 */
export interface WalletTotals {
  walletIn: number;
  walletDeposits: number;
}

export function walletTotalsOf(rows: ReadonlyArray<{ type: string; amountAgorot: number }>): WalletTotals {
  const t = { walletIn: 0, walletDeposits: 0 };
  for (const r of rows) {
    if (r.type === MOVEMENT.WALLET_IN) t.walletIn += r.amountAgorot;
    else if (r.type === MOVEMENT.WALLET_DEPOSIT) t.walletDeposits += r.amountAgorot;
  }
  return t;
}

export const walletNet = (w: WalletTotals): number => w.walletDeposits - w.walletIn;

/**
 * The expected drawer balance (spec §8): opening + cash sales (net of cash refunds) + cash tips + Cash In − Cash Out −
 * deposits − the cash left with employees + their deposits here. A count moves nothing; an opening by itself moves nothing.
 */
export function expectedDrawer(input: { openingAgorot: number; cashNetAgorot: number; cashTipsAgorot: number; movements?: CashMovementTotals; wallets?: WalletTotals }): number {
  return input.openingAgorot + input.cashNetAgorot + input.cashTipsAgorot + (input.movements ? movementsNet(input.movements) : 0) + (input.wallets ? walletNet(input.wallets) : 0);
}

/**
 * The shift close's `till` with the drawer's figures (Android `toShiftClose`): the movements (only the types that moved
 * anything) and the wallets (only when not zero) as keys, and both inside `expectedCash` — a close with none is byte for byte
 * what it was. Shekels, as the close carries them.
 */
export function tillWithDrawer(till: XTill, movements: CashMovementTotals, wallets: WalletTotals): XTill {
  const out: XTill = { ...till };
  const s = (a: number) => Math.round(a) / 100;
  const delta = movementsNet(movements) + walletNet(wallets);
  if (delta !== 0) out.expectedCash = s(Math.round(till.expectedCash * 100) + delta);
  if (movements.cashIn > 0) out.cashIn = s(movements.cashIn);
  if (movements.cashOut > 0) out.cashOut = s(movements.cashOut);
  if (movements.deposits > 0) out.deposits = s(movements.deposits);
  if (wallets.walletIn > 0) out.walletIn = s(wallets.walletIn);
  if (wallets.walletDeposits > 0) out.walletDeposits = s(wallets.walletDeposits);
  return out;
}
