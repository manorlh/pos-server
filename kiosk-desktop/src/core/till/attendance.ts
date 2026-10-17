/**
 * "נוכחות עובדים" — employee attendance on the Windows till, the port of pos-android domain/Attendance.kt and
 * domain/AttendanceCode.kt (pos-server docs/SPEC_ATTENDANCE.md; the cloud: app/routers/attendance.py):
 *
 *  - the state machine: not working → working ⇄ on break → (clock-out) not working; each transition gives the new shift
 *    and the one action that tells the cloud (`POST /sync/{m}/attendance/actions`), idempotent by the ids it carries and
 *    carrying the shift's clock-in for a cloud that never got it;
 *  - "סיום משמרת"'s checks: the open tables (blocked under `preventClockOutWithOpenTables`, else a warning once), the
 *    cash not deposited ("הכסף אצלי", `walletBlockClockOut`), then a manager under `requireManagerForClockOut`;
 *  - the merge of this till's copy with the cloud's view (`GET /sync/{m}/attendance/state`);
 *  - "קוד עובד בכל פעולה" (`attendanceRequireCodePerAction`, on by default): who is asked for a code and when, how an
 *    action was confirmed (`verifiedBy` / `origin` / `onBehalf` — never the code), the shared limit on wrong codes, which
 *    code is whose; "שעון נוכחות" on the sign-in screen (tills only);
 *  - the correction request's time ("16:05" today / yesterday on the wall clock → the UTC instant), the worked time.
 *
 * The rule this file keeps (AttendanceSeparationTest): attendance is NOT the till's sign-in. Signing in or out, the idle
 * lock, switching user never start or end a shift — only an explicit action here, or a manager in the cloud.
 *
 * Pure: the clock, the ids and bcrypt are parameters. Every Hebrew text is the Android till's (strings_attendance.xml).
 */

import { formatShekelSign } from '../money';

/* ------------------------------------------------------------------ the words */

/** pos-android res/values/strings_attendance.xml, word for word (%s → the function's arguments, in order). */
export const ATTENDANCE_TEXT = {
  menu: 'נוכחות',
  statusNotWorking: 'לא במשמרת',
  statusWorkingSince: (t: string) => `במשמרת מ־${t}`,
  statusBreakSince: (t: string) => `בהפסקה מ־${t}`,
  worked: (t: string) => `שעות במשמרת: ${t}`,
  breaks: (n: number, t: string) => `הפסקות: ${n} · ${t}`,
  pending: (n: number) => `בקשות תיקון ממתינות לאישור: ${n}`,
  offline: 'אין חיבור לענן — המצב לפי הקופה, ויישלח כשהחיבור יחזור.',
  clockIn: 'התחל משמרת',
  breakStart: 'יציאה להפסקה',
  breakEnd: 'חזרה מהפסקה',
  clockOut: 'סיום משמרת',
  requestCorrection: 'בקשת תיקון נוכחות',
  close: 'סגירה',
  cancel: 'ביטול',
  hello: (name: string) => `שלום, ${name}`,
  gateRequired: 'כדי למכור יש להתחיל משמרת.',
  gateBreak: 'את/ה בהפסקה. כדי להמשיך לעבוד — חזרה מהפסקה.',
  continueWithout: 'המשך בלי משמרת',
  signOut: 'יציאה',
  started: (t: string) => `המשמרת התחילה ב־${t}`,
  welcomeBack: (t: string) => `ברוכים השבים — במשמרת מ־${t}`,
  onBreakLocked: (name: string) => `${name} בהפסקה — הקופה ננעלה. לחזרה: קוד עובד.`,
  ended: (worked: string) => `המשמרת הסתיימה · ${worked} שעות`,
  failed: 'הפעולה לא נשמרה — נסו שוב',
  refusedOnShift: 'כבר במשמרת',
  refusedNotOnShift: 'לא במשמרת',
  refusedOnBreak: 'כבר בהפסקה',
  refusedNotOnBreak: 'לא בהפסקה',
  blockedTitle: 'לא ניתן לסיים משמרת',
  blockedBody: 'יש לך שולחנות פתוחים. יש להעביר אותם לעובד אחר, או לסיים באישור מנהל.',
  warningTitle: 'יש לך שולחנות פתוחים',
  warningBody: 'מומלץ להעביר אותם לעובד אחר לפני סיום המשמרת.',
  tableRow: (table: string, total: string) => `שולחן ${table} · ${total}`,
  transferTables: 'העברת שולחנות',
  managerApproval: 'אישור מנהל',
  finishAnyway: 'סיים בכל זאת',
  managerReasonTables: (name: string) => `סיום משמרת עם שולחנות פתוחים — ${name}`,
  managerReasonClockOut: (name: string) => `סיום משמרת — ${name}`,
  checking: 'בודק…',
  correctionTitle: 'בקשת תיקון נוכחות',
  correctionHint: 'הנוכחות לא משתנה עד שמנהל מאשר את הבקשה.',
  correctionKindMissingIn: 'כניסה חסרה',
  correctionKindMissingOut: 'יציאה חסרה',
  correctionKindWrongTime: 'שעה שגויה',
  correctionKindBreak: 'הפסקה',
  correctionFieldIn: 'שעת כניסה',
  correctionFieldOut: 'שעת יציאה',
  correctionToday: 'היום',
  correctionYesterday: 'אתמול',
  correctionTime: 'שעה (למשל 16:05)',
  correctionEndTime: 'עד שעה (רשות)',
  correctionReason: 'סיבה',
  correctionSend: 'שליחה לאישור מנהל',
  correctionSent: 'הבקשה נשלחה לאישור מנהל',
  clockTitle: 'שעון נוכחות',
  clockCodeHint: 'הקש/י את הקוד האישי שלך',
  clockOnBehalf: 'פעולה בשם עובד (באישור מנהל)',
  clockPickSelf: 'לקוד הזה יש יותר מעובד אחד — מי את/ה?',
  clockPickEmployee: 'בשם איזה עובד?',
  clockByManager: (name: string) => `באישור מנהל: ${name}`,
  clockActionIn: 'כניסה',
  clockActionOut: 'יציאה',
  clockCorrection: 'בקשת תיקון',
  clockTransferHint: 'להעברת השולחנות יש להיכנס לקופה.',
  clockDoneIn: (t: string, name: string) => `המשמרת התחילה ב־${t} · שלום, ${name}`,
  clockDoneBreak: (t: string, name: string) => `ההפסקה התחילה ב־${t} · ${name}`,
  clockDoneBack: (t: string, name: string) => `חזרה מהפסקה ב־${t} · שלום, ${name}`,
  clockDoneOut: (t: string, worked: string, name: string) => `המשמרת הסתיימה ב־${t} · ${worked} שעות · להתראות, ${name}`,
  clockDoneCorrection: (name: string) => `הבקשה נשלחה לאישור מנהל · ${name}`,
  codeTitle: 'קוד עובד',
  codePrompt: (name: string, what: string) => `${name}, הקש/י את הקוד שלך לאישור: ${what}`,
  codeConfirm: 'אישור',
  codeWrong: 'קוד שגוי',
  codeLocked: (seconds: number) => `יותר מדי ניסיונות שגויים. אפשר לנסות שוב בעוד ${seconds} שניות.`,
  onBehalfReason: (name: string, what: string) => `נוכחות בשם ${name} — ${what}`,
  walletTitle: 'כסף שלא הופקד',
  walletBody: (amount: string) => `יש בידך ${amount} להפקדה`,
  walletBlockedBody: (amount: string) => `יש בידך ${amount} להפקדה. יש להפקיד בקופה עם מגירה לפני סיום המשמרת, או לקבל אישור מנהל.`,
  managerReasonWallet: (name: string) => `${name} מסיים משמרת עם מזומן שלא הופקד`,
  /** The flow design's drawer row (flow_menu_attendance). */
  flowMenu: 'כניסה / יציאה ממשמרת',
} as const;

/* ------------------------------------------------------------------ the parameters */

export const ATTENDANCE_KEYS = {
  ENABLED: 'attendanceEnabled',
  REQUIRE_CLOCK_IN: 'requireClockInBeforeLogin',
  PREVENT_OPEN_TABLES: 'preventClockOutWithOpenTables',
  REQUIRE_MANAGER: 'requireManagerForClockOut',
  REQUIRE_CODE: 'attendanceRequireCodePerAction',
} as const;

/** The till parameters; their defaults change nothing for a shop that never set them. */
export interface AttendanceParams {
  enabled: boolean;
  requireClockIn: boolean;
  preventOpenTables: boolean;
  requireManager: boolean;
  /** "קוד עובד בכל פעולה": on by default, but only bites where attendance itself is on. */
  requireCodePerAction: boolean;
}

export const DEFAULT_ATTENDANCE_PARAMS: AttendanceParams = { enabled: false, requireClockIn: false, preventOpenTables: true, requireManager: false, requireCodePerAction: true };

function flag(value: unknown, fallback: boolean): boolean {
  if (value === true) return true;
  if (value === false) return false;
  if (value === undefined || value === null) return fallback;
  const v = String(value).trim().toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes' || v === 'כן') return true;
  if (v === 'false' || v === '0' || v === 'no' || v === 'לא') return false;
  return fallback;
}

export function attendanceParamsOf(params: Record<string, unknown> | null | undefined): AttendanceParams {
  const p = params ?? {};
  return {
    enabled: flag(p[ATTENDANCE_KEYS.ENABLED], false),
    requireClockIn: flag(p[ATTENDANCE_KEYS.REQUIRE_CLOCK_IN], false),
    preventOpenTables: flag(p[ATTENDANCE_KEYS.PREVENT_OPEN_TABLES], true),
    requireManager: flag(p[ATTENDANCE_KEYS.REQUIRE_MANAGER], false),
    requireCodePerAction: flag(p[ATTENDANCE_KEYS.REQUIRE_CODE], true),
  };
}

/* ------------------------------------------------------------------ the shift */

/** "לא במשמרת" / "במשמרת" / "בהפסקה". A finished shift is "not working" again. */
export type AttendanceStatus = 'not_working' | 'working' | 'on_break';

export interface AttendanceBreak {
  id: string;
  startAt: string;
  endAt: string | null;
}

/** One shift as this till knows it: its own actions, merged with what the cloud said. */
export interface AttendanceShift {
  id: string;
  posUserId: string;
  clockInAt: string;
  clockInMachineId: string | null;
  breaks: AttendanceBreak[];
  clockOutAt: string | null;
  /** self | manager — who ended it. */
  closedBy: string | null;
  roleName: string | null;
}

export const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

export const openBreakOf = (s: AttendanceShift | null | undefined): AttendanceBreak | null => {
  if (!s) return null;
  for (let i = s.breaks.length - 1; i >= 0; i--) if (s.breaks[i]!.endAt === null) return s.breaks[i]!;
  return null;
};

export function statusOf(s: AttendanceShift | null | undefined): AttendanceStatus {
  if (!s || s.clockOutAt !== null) return 'not_working';
  return openBreakOf(s) ? 'on_break' : 'working';
}

export function breakMs(s: AttendanceShift, nowMs: number): number {
  const cap = ms(s.clockOutAt) ?? nowMs;
  let sum = 0;
  for (const b of s.breaks) {
    const st = ms(b.startAt);
    if (st === null) continue;
    const e = Math.min(ms(b.endAt) ?? cap, cap);
    sum += Math.max(0, e - st);
  }
  return sum;
}

/** From clock-in to clock-out (or now), less the breaks. */
export function workedMs(s: AttendanceShift, nowMs: number): number {
  const start = ms(s.clockInAt);
  if (start === null) return 0;
  const end = ms(s.clockOutAt) ?? nowMs;
  return Math.max(0, end - start - breakMs(s, nowMs));
}

/** "3:12" — hours and minutes of work. */
export function formatWorked(millis: number): string {
  const minutes = Math.max(0, Math.floor(millis / 60_000));
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;
}

/** "17:02" on the wall clock of `timeZone` (the machine's by default); "" for nothing. */
export function formatLocalTime(iso: string | null | undefined, timeZone?: string): string {
  if (!iso) return '';
  const t = ms(iso);
  if (t === null) return iso.length >= 16 ? iso.substring(11, 16) : iso;
  const parts = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone }).formatToParts(new Date(t));
  const h = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const m = parts.find((p) => p.type === 'minute')?.value ?? '00';
  return `${h}:${m}`;
}

/* ------------------------------------------------------------------ the actions */

export const ATTENDANCE_ACTION = {
  CLOCK_IN: 'clock_in',
  BREAK_START: 'break_start',
  BREAK_END: 'break_end',
  CLOCK_OUT: 'clock_out',
  CORRECTION: 'correction_request',
} as const;

export type AttendanceActionType = (typeof ATTENDANCE_ACTION)[keyof typeof ATTENDANCE_ACTION];
/** The four punches (a correction is asked from its own form). */
export type AttendancePunch = 'clock_in' | 'break_start' | 'break_end' | 'clock_out';

/** A manager's approval at the till (a code checked here, offline), or a manager's own. */
export interface ClockOutApproval {
  posUserId: string;
  name: string;
  /** open_tables | require_manager | wallet | on_behalf */
  reason: string;
}

/** One of the employee's open tables, as the clock-out check lists it. */
export interface AttendanceOpenTable {
  tableId: string;
  number: number | null;
  name: string | null;
  totalAgorot: number;
}

export type CorrectionKind = 'missing_in' | 'missing_out' | 'wrong_time' | 'break';
export const CORRECTION_KINDS: readonly CorrectionKind[] = ['missing_in', 'missing_out', 'wrong_time', 'break'];

/** "בקשת תיקון נוכחות": what the employee asks a manager to fix. */
export interface CorrectionRequest {
  id: string;
  kind: CorrectionKind;
  /** clock_in | clock_out (for wrong_time). */
  field: string | null;
  requestedTime: string;
  requestedEndTime: string | null;
  reason: string;
}

/** How one action was confirmed, as the cloud's `verifiedBy` / `origin` / `onBehalf` carry it. */
export interface ActionConfirmation {
  /** code | manager | session */
  verifiedBy: string;
  /** clock | session */
  origin: string;
  onBehalf: ClockOutApproval | null;
}

export const CONFIRM = {
  CODE: 'code',
  MANAGER: 'manager',
  SESSION: 'session',
  CLOCK: 'clock',
  IN_SESSION: 'session',
  ON_BEHALF_REASON: 'on_behalf',
} as const;

export const ownCode = (origin: string): ActionConfirmation => ({ verifiedBy: CONFIRM.CODE, origin, onBehalf: null });
export const sessionOnly = (): ActionConfirmation => ({ verifiedBy: CONFIRM.SESSION, origin: CONFIRM.IN_SESSION, onBehalf: null });

/** A manager's code for `subjectId`. A manager confirming their own action typed their own code: the employee's code. */
export function byManager(subjectId: string, managerId: string, managerName: string, origin: string): ActionConfirmation {
  if (managerId === subjectId) return ownCode(origin);
  return { verifiedBy: CONFIRM.MANAGER, origin, onBehalf: { posUserId: managerId, name: managerName, reason: CONFIRM.ON_BEHALF_REASON } };
}

/** What goes to the cloud for one action: idempotent by the ids it carries. */
export interface AttendanceAction {
  id: string;
  type: AttendanceActionType;
  posUserId: string;
  shiftId: string | null;
  at: string;
  breakId: string | null;
  shiftClockInAt: string | null;
  shiftClockInMachineId: string | null;
  breakStartedAt: string | null;
  approval: ClockOutApproval | null;
  openTables: AttendanceOpenTable[];
  correction: CorrectionRequest | null;
  verifiedBy: string | null;
  origin: string | null;
  onBehalf: ClockOutApproval | null;
}

/** The action as `confirmation` says it was confirmed; unchanged without one. */
export function confirmedBy(a: AttendanceAction, c: ActionConfirmation | null | undefined): AttendanceAction {
  return c ? { ...a, verifiedBy: c.verifiedBy, origin: c.origin, onBehalf: c.onBehalf } : a;
}

export type AttendanceRefusal = 'already_on_shift' | 'not_on_shift' | 'already_on_break' | 'not_on_break';

export const REFUSAL_TEXT: Record<AttendanceRefusal, string> = {
  already_on_shift: ATTENDANCE_TEXT.refusedOnShift,
  not_on_shift: ATTENDANCE_TEXT.refusedNotOnShift,
  already_on_break: ATTENDANCE_TEXT.refusedOnBreak,
  not_on_break: ATTENDANCE_TEXT.refusedNotOnBreak,
};

export type AttendanceOutcome = { kind: 'done'; shift: AttendanceShift; action: AttendanceAction } | { kind: 'refused'; reason: AttendanceRefusal };

function action(type: AttendanceActionType, id: string, posUserId: string, shiftId: string | null, at: string, extra: Partial<AttendanceAction> = {}): AttendanceAction {
  return {
    id,
    type,
    posUserId,
    shiftId,
    at,
    breakId: null,
    shiftClockInAt: null,
    shiftClockInMachineId: null,
    breakStartedAt: null,
    approval: null,
    openTables: [],
    correction: null,
    verifiedBy: null,
    origin: null,
    onBehalf: null,
    ...extra,
  };
}

const ofShift = (s: AttendanceShift, id: string, type: AttendanceActionType, at: string, extra: Partial<AttendanceAction> = {}) =>
  action(type, id, s.posUserId, s.id, at, { shiftClockInAt: s.clockInAt, shiftClockInMachineId: s.clockInMachineId, ...extra });

/** The state machine (AttendanceMachine). */
export const AttendanceMachine = {
  clockIn(current: AttendanceShift | null, posUserId: string, shiftId: string, actionId: string, now: string, machineId: string | null, roleName: string | null = null): AttendanceOutcome {
    if (current && statusOf(current) !== 'not_working') return { kind: 'refused', reason: 'already_on_shift' };
    const shift: AttendanceShift = { id: shiftId, posUserId, clockInAt: now, clockInMachineId: machineId, breaks: [], clockOutAt: null, closedBy: null, roleName };
    return { kind: 'done', shift, action: action('clock_in', actionId, posUserId, shiftId, now) };
  },

  startBreak(current: AttendanceShift | null, breakId: string, actionId: string, now: string): AttendanceOutcome {
    const st = statusOf(current);
    if (!current || st === 'not_working') return { kind: 'refused', reason: 'not_on_shift' };
    if (st === 'on_break') return { kind: 'refused', reason: 'already_on_break' };
    const shift = { ...current, breaks: [...current.breaks, { id: breakId, startAt: now, endAt: null }] };
    return { kind: 'done', shift, action: ofShift(current, actionId, 'break_start', now, { breakId }) };
  },

  endBreak(current: AttendanceShift | null, actionId: string, now: string): AttendanceOutcome {
    if (!current || statusOf(current) === 'not_working') return { kind: 'refused', reason: 'not_on_shift' };
    const open = openBreakOf(current);
    if (!open) return { kind: 'refused', reason: 'not_on_break' };
    const shift = { ...current, breaks: current.breaks.map((b) => (b.id === open.id ? { ...b, endAt: now } : b)) };
    return { kind: 'done', shift, action: ofShift(current, actionId, 'break_end', now, { breakId: open.id, breakStartedAt: open.startAt }) };
  },

  /** A clock-out during a break ends the break with it (the cloud does the same). */
  clockOut(current: AttendanceShift | null, actionId: string, now: string, approval: ClockOutApproval | null = null, openTables: AttendanceOpenTable[] = []): AttendanceOutcome {
    if (!current || statusOf(current) === 'not_working') return { kind: 'refused', reason: 'not_on_shift' };
    const shift: AttendanceShift = { ...current, clockOutAt: now, closedBy: 'self', breaks: current.breaks.map((b) => (b.endAt === null ? { ...b, endAt: now } : b)) };
    return { kind: 'done', shift, action: ofShift(current, actionId, 'clock_out', now, { approval, openTables }) };
  },

  /** A correction request: never changes the shift here — a manager decides in the cloud. */
  correction(current: AttendanceShift | null, posUserId: string, actionId: string, now: string, request: CorrectionRequest): AttendanceAction {
    return action('correction_request', actionId, posUserId, current?.id ?? null, now, {
      shiftClockInAt: current?.clockInAt ?? null,
      shiftClockInMachineId: current?.clockInMachineId ?? null,
      correction: request,
    });
  },
};

/** The cloud's `AttendanceActionIn` (Moshi leaves nulls out): the outbox row's body. `sentAt` is set at delivery. */
export function payloadOf(a: AttendanceAction): Record<string, unknown> {
  const out: Record<string, unknown> = { id: a.id, type: a.type, posUserId: a.posUserId };
  const put = (k: string, v: unknown) => {
    if (v !== null && v !== undefined) out[k] = v;
  };
  put('shiftId', a.shiftId);
  put('breakId', a.breakId);
  out.at = a.at;
  put('shiftClockInAt', a.shiftClockInAt);
  put('shiftClockInMachineId', a.shiftClockInMachineId);
  put('breakStartedAt', a.breakStartedAt);
  if (a.approval) out.approval = { posUserId: a.approval.posUserId, name: a.approval.name, reason: a.approval.reason };
  if (a.openTables.length > 0) {
    out.openTables = a.openTables.map((t) => {
      const o: Record<string, unknown> = { tableId: t.tableId };
      if (t.number !== null) o.number = t.number;
      if (t.name !== null) o.name = t.name;
      o.total = t.totalAgorot / 100;
      return o;
    });
  }
  if (a.correction) {
    const c: Record<string, unknown> = { id: a.correction.id, kind: a.correction.kind };
    if (a.correction.field) c.field = a.correction.field;
    c.requestedTime = a.correction.requestedTime;
    if (a.correction.requestedEndTime) c.requestedEndTime = a.correction.requestedEndTime;
    c.reason = a.correction.reason;
    out.correction = c;
  }
  put('verifiedBy', a.verifiedBy);
  put('origin', a.origin);
  if (a.onBehalf) out.onBehalf = { posUserId: a.onBehalf.posUserId, name: a.onBehalf.name, reason: a.onBehalf.reason };
  return out;
}

/* ------------------------------------------------------------------ "סיום משמרת" */

export type WalletClockOutMode = 'warn' | 'block';

export type ClockOutCheck =
  | { kind: 'allowed' }
  /** "לא ניתן לסיים משמרת": the open tables — transfer them, or a manager approves. */
  | { kind: 'tables_blocked'; tables: AttendanceOpenTable[] }
  /** The parameter is off: a warning, and "סיים בכל זאת". */
  | { kind: 'tables_warning'; tables: AttendanceOpenTable[] }
  /** `requireManagerForClockOut`: a manager's code (a manager clocking out approves alone). */
  | { kind: 'needs_manager' }
  | { kind: 'wallet_warning'; amountAgorot: number }
  | { kind: 'wallet_blocked'; amountAgorot: number };

/**
 * In order: the open tables (blocked under `preventClockOutWithOpenTables`, else a warning once), the cash not deposited,
 * then the manager's approval under `requireManagerForClockOut`. One manager's approval answers all.
 */
export function checkClockOut(input: {
  params: AttendanceParams;
  openTables: readonly AttendanceOpenTable[];
  selfIsManager: boolean;
  approved: boolean;
  warningAcknowledged?: boolean;
  walletAgorot?: number | null;
  walletMode?: WalletClockOutMode;
  walletAcknowledged?: boolean;
}): ClockOutCheck {
  const { params, openTables, selfIsManager, approved } = input;
  if (openTables.length > 0) {
    if (params.preventOpenTables) {
      if (!approved) return { kind: 'tables_blocked', tables: [...openTables] };
    } else if (!input.warningAcknowledged && !approved) {
      return { kind: 'tables_warning', tables: [...openTables] };
    }
  }
  const w = input.walletAgorot ?? null;
  if (w !== null && w > 0 && !approved) {
    if ((input.walletMode ?? 'warn') === 'block') return { kind: 'wallet_blocked', amountAgorot: w };
    if (!input.walletAcknowledged) return { kind: 'wallet_warning', amountAgorot: w };
  }
  if (params.requireManager && !selfIsManager && !approved) return { kind: 'needs_manager' };
  return { kind: 'allowed' };
}

/** The employee's open tables, by table: this till's view and the cloud's, once each. */
export function unionTables(local: readonly AttendanceOpenTable[], cloud: readonly AttendanceOpenTable[]): AttendanceOpenTable[] {
  const seen = new Set<string>();
  const out: AttendanceOpenTable[] = [];
  for (const t of [...local, ...cloud]) {
    if (seen.has(t.tableId)) continue;
    seen.add(t.tableId);
    out.push(t);
  }
  return out;
}

export const tableLine = (t: AttendanceOpenTable): string => ATTENDANCE_TEXT.tableRow(t.number !== null ? String(t.number) : (t.name ?? ''), formatShekelSign(t.totalAgorot));

/* ------------------------------------------------------------------ the cloud's view */

/** What the cloud said about the employee (`GET sync/{m}/attendance/state`). */
export interface CloudAttendance {
  /** Their open shift, opened at whichever till. */
  open: AttendanceShift | null;
  /** The shift this till asked about, as the cloud has it (closed by a manager since?). */
  known: AttendanceShift | null;
  openTables: AttendanceOpenTable[];
  pendingCorrections: number;
  roleName: string | null;
  last24hSeconds: number | null;
}

const str = (o: Record<string, unknown>, k: string): string | null => {
  const v = o[k];
  if (v === null || v === undefined) return null;
  const s = String(v);
  return s.trim() === '' ? null : s;
};

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** A shift as either side writes it (the cloud's `shift_out`, or this till's copy). */
export function shiftOf(o: unknown): AttendanceShift | null {
  if (!isObj(o)) return null;
  const id = str(o, 'id');
  const clockIn = str(o, 'clockInAt');
  if (!id || !clockIn) return null;
  const breaks: AttendanceBreak[] = [];
  if (Array.isArray(o.breaks)) {
    for (const b of o.breaks) {
      if (!isObj(b)) continue;
      const bid = str(b, 'id');
      const start = str(b, 'startAt');
      if (!bid || !start) continue;
      breaks.push({ id: bid, startAt: start, endAt: str(b, 'endAt') });
    }
  }
  return {
    id,
    posUserId: str(o, 'posUserId') ?? '',
    clockInAt: clockIn,
    clockInMachineId: str(o, 'clockInMachineId'),
    breaks,
    clockOutAt: str(o, 'clockOutAt'),
    closedBy: str(o, 'closedBy'),
    roleName: str(o, 'roleName'),
  };
}

export function cloudOf(body: unknown): CloudAttendance | null {
  if (!isObj(body)) return null;
  const tables: AttendanceOpenTable[] = [];
  if (Array.isArray(body.openTables)) {
    for (const t of body.openTables) {
      if (!isObj(t)) continue;
      const tableId = str(t, 'tableId') ?? str(t, 'orderId');
      if (!tableId) continue;
      const n = t.number;
      const total = typeof t.total === 'number' ? t.total : Number(t.total ?? 0);
      tables.push({
        tableId,
        number: n === null || n === undefined || !Number.isFinite(Number(n)) ? null : Math.trunc(Number(n)),
        name: str(t, 'name'),
        totalAgorot: Number.isFinite(total) ? Math.round(total * 100) : 0,
      });
    }
  }
  const pc = Number(body.pendingCorrections ?? 0);
  const l24 = body.last24hSeconds;
  return {
    open: shiftOf(body.shift),
    known: shiftOf(body.known),
    openTables: tables,
    pendingCorrections: Number.isFinite(pc) ? Math.trunc(pc) : 0,
    roleName: str(body, 'roleName'),
    last24hSeconds: l24 === null || l24 === undefined || !Number.isFinite(Number(l24)) ? null : Math.trunc(Number(l24)),
  };
}

/** Field by field, set once: a time either side has stays; a break either side knows is kept. */
export function unionShift(mine: AttendanceShift, theirs: AttendanceShift): AttendanceShift {
  const byId = new Map<string, AttendanceBreak>();
  for (const b of [...theirs.breaks, ...mine.breaks]) {
    const had = byId.get(b.id);
    byId.set(b.id, had ? { ...had, endAt: had.endAt ?? b.endAt } : b);
  }
  // Where both have a time the cloud's stands: it is this till's own time, or a manager's correction of it.
  const out = theirs.clockOutAt ?? mine.clockOutAt;
  const breaks = [...byId.values()].sort((a, b) => (a.startAt < b.startAt ? -1 : a.startAt > b.startAt ? 1 : 0)).map((b) => (out !== null && b.endAt === null ? { ...b, endAt: out } : b));
  return { ...mine, clockInAt: theirs.clockInAt, clockOutAt: out, closedBy: theirs.closedBy ?? mine.closedBy, roleName: mine.roleName ?? theirs.roleName, breaks };
}

/**
 * This till's copy against the cloud's (AttendanceMerge.merge). The same shift: unioned. Another shift: this till's open
 * one stays (the cloud flags the overlap); otherwise the cloud's open one is adopted — clocked in at another till.
 */
export function mergeShift(local: AttendanceShift | null, cloud: CloudAttendance | null): AttendanceShift | null {
  if (!cloud) return local;
  const sameKnown = cloud.known && local && cloud.known.id === local.id ? cloud.known : null;
  const sameOpen = cloud.open && local && cloud.open.id === local.id ? cloud.open : null;
  const same = sameKnown ?? sameOpen;
  if (local && same) return unionShift(local, same);
  if (local && statusOf(local) !== 'not_working') return local;
  return cloud.open ?? local;
}

/* ------------------------------------------------------------------ the code */

/** The code typed to sign in counts for the cards shown right after it, for this long. */
export const FRESH_SIGN_IN_MS = 60_000;

/** Whether an in-session action asks for the employee's code first (`signedInAtMs` null: the menu's panel — always). */
export function sessionNeedsCode(params: AttendanceParams, signedInAtMs: number | null, nowMs: number): boolean {
  if (!params.requireCodePerAction) return false;
  if (signedInAtMs === null) return true;
  const d = nowMs - signedInAtMs;
  return !(d >= 0 && d <= FRESH_SIGN_IN_MS);
}

/** What an in-session action carries when no code was asked for it; null — a code is due. */
export function withoutPrompt(params: AttendanceParams, signedInAtMs: number | null, nowMs: number): ActionConfirmation | null {
  if (!params.requireCodePerAction) return sessionOnly();
  if (signedInAtMs !== null) {
    const d = nowMs - signedInAtMs;
    if (d >= 0 && d <= FRESH_SIGN_IN_MS) return ownCode(CONFIRM.IN_SESSION);
  }
  return null;
}

/** "שעון נוכחות": tills only — never on a self-order kiosk (a kiosk taken for staff included) nor a KDS screen. */
export function clockShown(params: AttendanceParams, role: string | null | undefined, kioskSnapshot: boolean, kdsScreen: boolean): boolean {
  return params.enabled && (role ?? '').trim().toLowerCase() !== 'kiosk' && !kioskSnapshot && !kdsScreen;
}

/** The clock's buttons for a state: כניסה / יציאה להפסקה / חזרה מהפסקה / יציאה. */
export function clockActions(status: AttendanceStatus): AttendancePunch[] {
  if (status === 'not_working') return ['clock_in'];
  if (status === 'working') return ['break_start', 'clock_out'];
  return ['break_end', 'clock_out'];
}

/** How long the clock's confirmation stays before the sign-in screen is back. */
export const CLOCK_DONE_MS = 3_500;
/** The limiter's key for the clock, where nobody is identified before the code. */
export const CLOCK_ATTEMPTS_KEY = 'attendance-clock';
export const CODE_MIN_LENGTH = 4;
export const CODE_MAX_LENGTH = 6;

/** Five wrong codes in a row lock that key for a minute; a right one clears it (PinAttemptLimiter). */
export class PinAttemptLimiter {
  private readonly entries = new Map<string, { failures: number; lockedUntil: number }>();

  constructor(
    private readonly nowMs: () => number = () => Date.now(),
    private readonly maxFailures = 5,
    private readonly lockMs = 60_000,
  ) {}

  lockedForMs(key: string): number {
    const e = this.entries.get(key);
    return e ? Math.max(0, e.lockedUntil - this.nowMs()) : 0;
  }

  lockedForSeconds(key: string): number {
    return Math.floor((this.lockedForMs(key) + 999) / 1000);
  }

  /** A wrong code; true when this one locked the key. */
  failure(key: string): boolean {
    const e = this.entries.get(key) ?? { failures: 0, lockedUntil: 0 };
    e.failures += 1;
    this.entries.set(key, e);
    if (e.failures >= this.maxFailures) {
      e.lockedUntil = this.nowMs() + this.lockMs;
      e.failures = 0;
      return true;
    }
    return false;
  }

  success(key: string): void {
    this.entries.delete(key);
  }
}

export type CodeCheck<U> = { kind: 'match'; user: U } | { kind: 'ambiguous'; users: U[] } | { kind: 'wrong' } | { kind: 'locked'; seconds: number };

/** `pin` against `candidates` (one employee in a session; the whole roster at the clock), counted under `key`. */
export async function checkCode<U extends { pinHash?: string | null }>(
  pin: string,
  candidates: readonly U[],
  limiter: PinAttemptLimiter,
  key: string,
  verify: (pin: string, hash: string | null | undefined) => Promise<boolean> | boolean,
): Promise<CodeCheck<U>> {
  const locked = limiter.lockedForSeconds(key);
  if (locked > 0) return { kind: 'locked', seconds: locked };
  const matches: U[] = [];
  if (pin.length >= CODE_MIN_LENGTH) {
    for (const u of candidates) if (await verify(pin, u.pinHash)) matches.push(u);
  }
  if (matches.length === 0) {
    limiter.failure(key);
    const now = limiter.lockedForSeconds(key);
    return now > 0 ? { kind: 'locked', seconds: now } : { kind: 'wrong' };
  }
  limiter.success(key);
  return matches.length === 1 ? { kind: 'match', user: matches[0]! } : { kind: 'ambiguous', users: matches };
}

/* ------------------------------------------------------------------ the correction's time */

const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** Typing a time on a number pad: digits only, the colon put in ("1605" → "16:05"). */
export function timeInput(raw: string): string {
  const digits = raw.replace(/\D+/g, '').slice(0, 4);
  return digits.length <= 2 ? digits : `${digits.slice(0, digits.length - 2)}:${digits.slice(-2)}`;
}

/** The offset (ms) of `timeZone` from UTC at the instant `utcMs`. */
function zoneOffsetMs(timeZone: string | undefined, utcMs: number): number {
  if (!timeZone) return -new Date(utcMs).getTimezoneOffset() * 60_000;
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(utcMs));
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second'));
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/**
 * "16:05" on the day `daysBack` days before `today` ({y, m (1-12), d}), on the wall clock of `timeZone` (the machine's by
 * default) → the UTC instant the cloud takes ("2026-10-06T13:05:00.000Z"). Null when it is not a time.
 */
export function correctionTimeIso(daysBack: number, hhmm: string, today: { y: number; m: number; d: number }, timeZone?: string): string | null {
  const m = HHMM.exec(hhmm.trim());
  if (!m) return null;
  const day = new Date(Date.UTC(today.y, today.m - 1, today.d - daysBack));
  const wall = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), Number(m[1]), Number(m[2]));
  let guess = wall - zoneOffsetMs(timeZone, wall);
  // Across a DST change the offset at the answer is the one that counts.
  guess = wall - zoneOffsetMs(timeZone, guess);
  return new Date(guess).toISOString();
}

/** Today on the wall clock of `timeZone` (the machine's by default). */
export function todayIn(nowMs: number, timeZone?: string): { y: number; m: number; d: number } {
  const local = new Date(nowMs + zoneOffsetMs(timeZone, nowMs));
  return { y: local.getUTCFullYear(), m: local.getUTCMonth() + 1, d: local.getUTCDate() };
}

/* ------------------------------------------------------------------ the lines the screens show */

export function statusLine(shift: AttendanceShift | null | undefined, timeZone?: string): string {
  const st = statusOf(shift);
  if (st === 'not_working' || !shift) return ATTENDANCE_TEXT.statusNotWorking;
  if (st === 'working') return ATTENDANCE_TEXT.statusWorkingSince(formatLocalTime(shift.clockInAt, timeZone));
  return ATTENDANCE_TEXT.statusBreakSince(formatLocalTime(openBreakOf(shift)?.startAt, timeZone));
}

/** The panel's lines under the status: the job title, the worked time, the breaks, the corrections waiting. */
export function panelLines(shift: AttendanceShift | null, cloud: CloudAttendance | null, nowMs: number, opts: { breaks?: boolean } = {}): string[] {
  const out: string[] = [];
  if (cloud?.roleName) out.push(cloud.roleName);
  const st = statusOf(shift);
  if (shift && st !== 'not_working') {
    out.push(ATTENDANCE_TEXT.worked(formatWorked(workedMs(shift, nowMs))));
    if (opts.breaks !== false && shift.breaks.length > 0) out.push(ATTENDANCE_TEXT.breaks(shift.breaks.length, formatWorked(breakMs(shift, nowMs))));
  }
  if (cloud && cloud.pendingCorrections > 0) out.push(ATTENDANCE_TEXT.pending(cloud.pendingCorrections));
  return out;
}

/** The words of an action, for the code's prompt ("…לאישור: יציאה להפסקה"). */
export const ACTION_WORD: Record<AttendanceActionType, string> = {
  clock_in: ATTENDANCE_TEXT.clockIn,
  break_start: ATTENDANCE_TEXT.breakStart,
  break_end: ATTENDANCE_TEXT.breakEnd,
  clock_out: ATTENDANCE_TEXT.clockOut,
  correction_request: ATTENDANCE_TEXT.requestCorrection,
};

export const CORRECTION_KIND_LABEL: Record<CorrectionKind, string> = {
  missing_in: ATTENDANCE_TEXT.correctionKindMissingIn,
  missing_out: ATTENDANCE_TEXT.correctionKindMissingOut,
  wrong_time: ATTENDANCE_TEXT.correctionKindWrongTime,
  break: ATTENDANCE_TEXT.correctionKindBreak,
};

/* ------------------------------------------------------------------ the state the screen draws */

/** A button of a card: the punch it sends, its words, and its look. */
export interface AttendanceButton {
  action: AttendancePunch;
  label: string;
  tone: 'primary' | 'tonal' | 'danger';
}

/** The employee's card: the signed-in employee's (gate, offer, panel) or the clock's. */
export interface AttendanceCard {
  userId: string;
  title: string;
  /** "במשמרת מ־17:02" (or "בודק…" while the cloud is asked). */
  status: string;
  /** A message under it ("כדי למכור יש להתחיל משמרת.") and the panel's lines, one per line. */
  lines: string[];
  offline: boolean;
  buttons: AttendanceButton[];
  loading: boolean;
}

/** One sheet over everything (the code, a manager's code, a name, the clock-out checks, the form, the clock's word). */
export type AttendanceSheet =
  | { kind: 'code'; title: string; prompt: string; error: string | null; lockedSeconds: number; busy: boolean; alternative: string | null }
  | { kind: 'manager'; title: string; prompt: string; error: string | null; lockedSeconds: number; busy: boolean }
  | { kind: 'pick'; title: string; users: Array<{ id: string; name: string }> }
  | { kind: 'clockOut'; variant: 'blocked' | 'warning' | 'wallet_warning' | 'wallet_blocked'; title: string; body: string; lines: string[]; transferHint: string | null; canApprove: boolean; canFinish: boolean; canTransfer: boolean }
  | { kind: 'correction'; busy: boolean }
  | { kind: 'done'; text: string };

/** `attendance` in the till's state: only where the shop runs attendance (`attendanceEnabled`). */
export interface AttendanceState {
  /** "שעון נוכחות" on the sign-in screen (tills only); its button opens the clock. */
  clockShown: boolean;
  /** The clock is open (nobody signed in by it). */
  clockOpen: boolean;
  /** The menu row's second line: the signed-in employee's state; null — nobody signed in. */
  menuLine: string | null;
  /**
   * After a PIN: `required` — "כדי למכור יש להתחיל משמרת" (`requireClockInBeforeLogin`), `break` — on a break: selling
   * waits behind a card that cannot be dismissed (its only ways out: the punch, or "יציאה"). Null — nothing blocks.
   */
  gate: 'required' | 'break' | null;
  /** The card after a PIN (the gate's, or the offer "התחל משמרת" / "המשך בלי משמרת"), the panel's, or the clock's. */
  card: AttendanceCard | null;
  /** Which card it is: the gate (no dismiss), the offer, the menu's panel, or the clock. */
  cardKind: 'gate' | 'offer' | 'panel' | 'clock' | null;
  sheet: AttendanceSheet | null;
  /** A short word after an action (Android's banner), gone after a few seconds. */
  message: string | null;
  busy: boolean;
  /** Actions not yet taken by the cloud (sent when the connection is back). */
  unsent: number;
}
