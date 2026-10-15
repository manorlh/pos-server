/**
 * "מצב עבודה: קיוסק / קופה" on one device — the pure rules, a faithful port of the Android app's
 * domain/KioskTillMode.kt (P:\specs\kiosk-landscape-till-mode.md §5, the same rules as
 * web-till-spec-v2.md §6.3 / §6.9). The owner (09.10.2026): a business the owner allowed chooses by
 * itself how a device works today — as a kiosk or as a till; always a manager's code with
 * KIOSK_TILL_MODE on the device ("ניהול הקיוסק" → the till, the till's menu → the kiosk), the
 * dashboard's `enter_till` / `return_kiosk` both ways; the chosen mode survives a restart; held sales
 * never block the way to the kiosk. If the owner never allowed it (`kioskTillModeEnabled`, set by a
 * super admin or a distributor only), none of it exists.
 *
 * Fiscally nothing moves: the same machine, document series and prefix, shift and Z rules; the
 * documents carry the employee signed in on the till. Everything decided here is pure, so the rules
 * are pinned by test/workMode.test.ts (the port of KioskTillModeTest.kt). main/workMode.ts runs them.
 */

import { findByPin, lockAt, LOCKOUT_MS, MAX_FAILURES, NO_LOCK, usersAllowed, type BcryptCompare, type ExitLock, type RosterUser } from './desktopExit';

/** The permission a manager's code must hold (till_permissions.py, the Android `Perm.KIOSK_TILL_MODE`). */
export const KIOSK_TILL_MODE = 'KIOSK_TILL_MODE';
export const KIOSK_TILL_MODE_LABEL = 'מעבר למצב קופה בקיוסק';

/** The till event of every switch (pos-server TILL_EVENT_TYPES). */
export const TILL_EVENT = 'kiosk_till_mode' as const;

/** The cloud's word for the mode in `status.flowState` while the device works as a till. */
export const FLOW_TILL_MODE = 'till_mode';

/** The idle return's look at the device (kiosk mode: rare; till mode: every couple of seconds), and the notice before it. */
export const TICK_MS = 15_000;
export const TILL_TICK_MS = 2_000;
export const NOTICE_MS = 30_000;

/** How many answered dashboard commands are remembered, so a command the cloud lists again never runs twice. */
export const HANDLED_KEEP = 50;

/* ---------------------------------------------------------------- the mode */

/** The device's work mode now. */
export type WorkMode = 'kiosk' | 'till';

export function parseMode(value: unknown): WorkMode | null {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return v === 'kiosk' || v === 'till' ? v : null;
}

/* -------------------------------------------------------------- parameters */

export const PARAM_ENABLED = 'kioskTillModeEnabled';
export const PARAM_IDLE_RETURN = 'kioskTillModeIdleReturnMinutes';
export const DEFAULT_IDLE_MINUTES = 3;
export const MAX_IDLE_MINUTES = 240;

/** The till parameters of the feature (pos-server app/services/kiosk_till_mode.py, company → shop → area → device). */
export interface TillModeParams {
  /** The owner's gate: off — no button, no menu item, no dashboard switch. */
  enabled: boolean;
  /** A kiosk device in till mode goes back to the kiosk after this many idle minutes, at rest only; 0 = never. */
  idleReturnMinutes: number;
}

export const NO_PARAMS: TillModeParams = { enabled: false, idleReturnMinutes: DEFAULT_IDLE_MINUTES };

function boolOf(v: unknown, fallback: boolean): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v === 1 ? true : v === 0 ? false : fallback;
  if (typeof v !== 'string') return fallback;
  switch (v.trim().toLowerCase()) {
    case 'true':
    case '1':
    case 'yes':
    case 'כן':
      return true;
    case 'false':
    case '0':
    case 'no':
    case 'לא':
      return false;
    default:
      return fallback;
  }
}

/** The till's parameters map (the cloud's `parameters`); anything missing or wrong — the default, never a fail-open. */
export function paramsOf(parameters: Record<string, unknown> | null | undefined): TillModeParams {
  const p = parameters ?? {};
  const raw = p[PARAM_IDLE_RETURN];
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw.trim()) : Number.NaN;
  const idle = Number.isFinite(n) && n >= 0 && n === Math.floor(n) ? Math.min(MAX_IDLE_MINUTES, n) : DEFAULT_IDLE_MINUTES;
  return { enabled: boolOf(p[PARAM_ENABLED], false), idleReturnMinutes: idle };
}

/* --------------------------------------------------------------- refusals */

/**
 * Why a switch is refused now — the wire code (what the cloud hears as `tillMode.returnBlocked`):
 *  - `disabled`: the owner's gate is closed;
 *  - `kiosk_payment`: a kiosk customer is paying, reading the result, or a card is on the terminal;
 *  - `customer_ordering`: a kiosk customer is in the middle of an order;
 *  - `basket_open`: the till's sell screen has lines rung up;
 *  - `payment_open`: the till's payment screen is up, holds a tender, or a card is on the terminal;
 *  - `table_open`: a table's order is open on screen;
 *  - `kiosk_config_missing`: a till's first kiosk mode — no kiosk config on the device yet, and the cloud did not answer.
 */
export type RefusalCode = 'disabled' | 'kiosk_payment' | 'customer_ordering' | 'basket_open' | 'payment_open' | 'table_open' | 'kiosk_config_missing';

/** The Android app's `kwork_refused_*`, word for word. */
export const REFUSAL_TEXT: Record<RefusalCode, string> = {
  disabled: 'מצב קופה אינו מופעל במכשיר הזה',
  kiosk_payment: 'יש תשלום בתהליך בקיוסק — אי אפשר לעבור עכשיו',
  customer_ordering: 'לקוח באמצע הזמנה — אפשר "איפוס מסך לקוח" ואז לעבור',
  basket_open: 'יש מכירה פתוחה — סיימו או השהו אותה',
  payment_open: 'יש תשלום בתהליך — סיימו אותו קודם',
  table_open: 'הזמנת שולחן פתוחה במסך — סגרו אותה קודם',
  kiosk_config_missing: 'אין עדיין תצורת קיוסק במכשיר — נדרש חיבור לענן בפעם הראשונה',
};

/** A refusal: its wire code (for the cloud) and its Hebrew text (for the screen). */
export interface TillModeRefusal {
  readonly wire: RefusalCode;
  readonly text: string;
}

const refusalOf = (wire: RefusalCode): TillModeRefusal => Object.freeze({ wire, text: REFUSAL_TEXT[wire] });

export const REFUSALS: Readonly<Record<RefusalCode, TillModeRefusal>> = {
  disabled: refusalOf('disabled'),
  kiosk_payment: refusalOf('kiosk_payment'),
  customer_ordering: refusalOf('customer_ordering'),
  basket_open: refusalOf('basket_open'),
  payment_open: refusalOf('payment_open'),
  table_open: refusalOf('table_open'),
  kiosk_config_missing: refusalOf('kiosk_config_missing'),
};

export function refusalText(r: TillModeRefusal | RefusalCode): string {
  return typeof r === 'string' ? REFUSAL_TEXT[r] : r.text;
}

/** The rest of the Android app's `kwork_*` / `kapp_staff_*` words (Hebrew is the default locale). */
export const WORK_TEXT = {
  title: 'מצב עבודה',
  kiosk: 'קיוסק',
  till: 'קופה',
  hint: 'המכשיר יעבוד כקופה עד שיוחזר לקיוסק — גם אחרי הפעלה מחדש. המסמכים יירשמו על שם העובד שנכנס. מכירות מושהות יחכו למצב קופה.',
  needsManager: `המעבר לקופה דורש קוד של מנהל עם ההרשאה "${KIOSK_TILL_MODE_LABEL}".`,
  approve: KIOSK_TILL_MODE_LABEL,
  approveBack: 'חזרה למצב קיוסק',
  approveToKiosk: 'מעבר למצב קיוסק',
  menuBack: 'חזרה למצב קיוסק',
  menuBackSub: 'המכשיר יחזור להזמנה עצמית ללקוחות',
  menuToKiosk: 'מעבר לקיוסק',
  countdown: (seconds: number) => `חוזר לקיוסק בעוד ${seconds} שניות`,
  stay: 'נשארים',
  heldNotice: (n: number) => `יש ${n} מכירות מושהות — יחכו במצב קופה`,
  heldGo: 'חזרה לקיוסק',
  cancel: 'ביטול',
  banner: 'מצב קופה — הקיוסק מושבת ללקוחות',
  bannerBack: 'חזרה לקיוסק',
  resetCustomer: 'איפוס מסך הלקוח',
} as const;

/* ------------------------------------------------------------- home role */

/**
 * What the cloud's `kiosk/sync` says of the device, as far as the work mode reads it: `kiosk` is its
 * word (a kiosk row exists and is on), `homeTill` that the row is a till's kiosk mode (`homeRole: "till"`).
 */
export interface RawKioskFacts {
  kiosk: boolean;
  homeTill: boolean;
}

export const NOT_A_KIOSK: RawKioskFacts = { kiosk: false, homeTill: false };

/** The facts of a `kiosk/sync` answer (the snapshot the device keeps); a missing or odd one is "not a kiosk". */
export function rawFactsOf(snapshot: Record<string, unknown> | null | undefined): RawKioskFacts {
  const kiosk = snapshot?.kiosk === true;
  return { kiosk, homeTill: kiosk && snapshot?.homeRole === 'till' };
}

/**
 * "מצב עבודה" on a till by role (§5.10): its kiosk-mode row answers `kiosk: true, homeRole: "till"`. The
 * device is a kiosk to every part of the app only while it works as one — the snapshot the app reads
 * (`effective`) says `kiosk = false` in its home mode, so a till is a till exactly as before (its alerts,
 * its pay-at-till orders, its terminal); a kiosk by role is untouched.
 */
export const KioskHomeRole = {
  /** The facts the app reads: `raw` as the cloud said it, but no kiosk for a till at home. */
  effective(raw: RawKioskFacts, awayInKiosk: boolean): RawKioskFacts {
    return raw.homeTill && !awayInKiosk ? { ...raw, kiosk: false } : raw;
  },

  /** The mode now: a kiosk by role — till while its till session lasts; a till by role — kiosk while away. */
  mode(raw: RawKioskFacts, tillSession: boolean, awayInKiosk: boolean): WorkMode {
    if (raw.homeTill || !raw.kiosk) return awayInKiosk && raw.homeTill ? 'kiosk' : 'till';
    return tillSession ? 'till' : 'kiosk';
  },

  /** The mode the device opens in by its role (where the gate closing, or the cloud, sends it back). */
  home(raw: RawKioskFacts): WorkMode {
    return raw.kiosk && !raw.homeTill ? 'kiosk' : 'till';
  },

  /** What the device is by role — a till's kiosk-mode row leaves it a till. */
  kioskByRole(raw: RawKioskFacts): boolean {
    return raw.kiosk && !raw.homeTill;
  },

  /** The idle return applies to a kiosk by role in till mode only — a till at home is where it belongs. */
  idleReturnApplies(raw: RawKioskFacts): boolean {
    return KioskHomeRole.kioskByRole(raw);
  },
};

/** The kiosk snapshot as the rest of the app reads it: the same, but `kiosk: false` for a till at home. */
export function effectiveSnapshot(snapshot: Record<string, unknown> | null, awayInKiosk: boolean): Record<string, unknown> | null {
  if (!snapshot) return snapshot;
  const raw = rawFactsOf(snapshot);
  return KioskHomeRole.effective(raw, awayInKiosk).kiosk === raw.kiosk ? snapshot : { ...snapshot, kiosk: false };
}

/* -------------------------------------------------------------- the facts */

/** The kiosk side at the moment of a switch to the till. */
export interface KioskSideFacts {
  /** A payment under way, or its result on screen. */
  paying: boolean;
  cardInFlight: boolean;
  /** Away from the rest screens: a customer ordering. */
  ordering: boolean;
}

export const KIOSK_AT_REST: KioskSideFacts = { paying: false, cardInFlight: false, ordering: false };

/** The till side at the moment of a switch back to the kiosk. */
export interface TillSideFacts {
  basketOpen: boolean;
  checkoutOpen: boolean;
  holdsTender: boolean;
  cardInFlight: boolean;
  tableOpen: boolean;
  /** Held sales ("מכירות מושהות"): never a block — they wait for the next till mode (the owner). */
  heldSales: number;
}

export const QUIET_TILL: TillSideFacts = { basketOpen: false, checkoutOpen: false, holdsTender: false, cardInFlight: false, tableOpen: false, heldSales: 0 };

/** What the till engine tells: its side facts, who is signed in, and the last touch of its screens. */
export type TillFacts = TillSideFacts & {
  employee: { id: string; name: string } | null;
  lastActivityAtMs: number | null;
};

export const NO_TILL_FACTS: TillFacts = { ...QUIET_TILL, employee: null, lastActivityAtMs: null };

/**
 * The kiosk side from the kiosk's flow (core/kioskFlow.ts `wire`): paying while the flow says so (or a
 * payment holds it), a customer ordering on any order screen or the success screen they are reading.
 */
export function kioskFactsOf(flow: { flowState: string; busy: boolean }, cardInFlight: boolean): KioskSideFacts {
  return {
    paying: flow.flowState === 'paying' || flow.busy,
    cardInFlight,
    ordering: flow.flowState === 'ordering' || flow.flowState === 'success',
  };
}

/* ----------------------------------------------------------- how it began */

/** How a switch came about (the till event's `reason`). `cloud`: the cloud stopped naming this device a kiosk, or the owner's gate closed. */
export type WorkModeSource = 'manual' | 'idle' | 'remote' | 'cloud';

const SOURCES: readonly WorkModeSource[] = ['manual', 'idle', 'remote', 'cloud'];

/** The mode that is not the device's home: who switched it and since when (kept across a restart). */
export interface TillSession {
  sinceMs: number;
  by: string | null;
  byId: string | null;
  source: WorkModeSource;
}

export function sessionToJson(s: TillSession): string {
  return JSON.stringify({ sinceMs: s.sinceMs, by: s.by, byId: s.byId, source: s.source });
}

/** A session kept as JSON; anything unreadable is no session. */
export function parseSession(json: string | null | undefined): TillSession | null {
  if (!json) return null;
  let o: unknown;
  try {
    o = JSON.parse(json);
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const r = o as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v : null);
  const since = Number(r.sinceMs);
  const source = SOURCES.find((s) => s === r.source);
  return { sinceMs: Number.isFinite(since) ? Math.trunc(since) : 0, by: text(r.by), byId: text(r.byId), source: source ?? 'manual' };
}

/** A switch asked from the dashboard (the kiosk commands `enter_till` / `return_kiosk`), carried out when it may. */
export interface WorkModeCommand {
  id: string;
  mode: WorkMode;
  by: string | null;
}

/** The kiosk/sync answer's `workMode` ({id, mode, by}); null when absent or unreadable. */
export function parseCommand(raw: unknown): WorkModeCommand | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === 'string' && o.id.trim() !== '' ? o.id : typeof o.id === 'number' ? String(o.id) : null;
  const mode = parseMode(o.mode);
  if (!id || !mode) return null;
  return { id, mode, by: typeof o.by === 'string' && o.by.trim() !== '' ? o.by : null };
}

/* ------------------------------------------------------ approval and rules */

/** The approval a switch on the device needs, after the facts allow it — always a manager's code with KIOSK_TILL_MODE. */
export type TillApproval = 'none' | 'manager';

/**
 * The approval a switch on the device needs — the owner's rule: always a manager's code with
 * KIOSK_TILL_MODE (no parameter turns it off). `codeHolds`: the code already typed on this screen —
 * the manager who opened "ניהול הקיוסק", or the employee signed in on the till — is such a manager's.
 */
export function approval(codeHolds: boolean): TillApproval {
  return codeHolds ? 'none' : 'manager';
}

/** Whether the device may go to the till now; null — yes. */
export function mayEnter(params: TillModeParams, kiosk: KioskSideFacts): TillModeRefusal | null {
  if (!params.enabled) return REFUSALS.disabled;
  if (kiosk.paying || kiosk.cardInFlight) return REFUSALS.kiosk_payment;
  if (kiosk.ordering) return REFUSALS.customer_ordering;
  return null;
}

/**
 * Whether the device may go back to the kiosk now; null — yes. Never over a sale: lines on the sell
 * screen, the payment screen, a card, a table's order. Held sales never block (the owner): they stay
 * held and come back in the next till mode (`heldNoticeOf`).
 */
export function mayReturn(till: TillSideFacts): TillModeRefusal | null {
  if (till.cardInFlight || till.checkoutOpen || till.holdsTender) return REFUSALS.payment_open;
  if (till.basketOpen) return REFUSALS.basket_open;
  if (till.tableOpen) return REFUSALS.table_open;
  return null;
}

/** "יש N מכירות מושהות — יחכו במצב קופה": said on the way back to the kiosk; null when none. */
export function heldNoticeOf(till: TillSideFacts): number | null {
  return till.heldSales > 0 ? till.heldSales : null;
}

/**
 * The idle return: in till mode, the minutes set (0 = never), that long since the last touch, and
 * nothing open. `idleMs`: since the last touch.
 */
export function idleReturnDue(params: TillModeParams, idleMs: number, till: TillSideFacts): boolean {
  return params.enabled && params.idleReturnMinutes > 0 && idleMs >= params.idleReturnMinutes * 60_000 && mayReturn(till) === null;
}

/** The notice before the idle return: seconds left while within `NOTICE_MS` of it; null otherwise. */
export function idleCountdownSec(params: TillModeParams, idleMs: number, till: TillSideFacts): number | null {
  if (!params.enabled || params.idleReturnMinutes <= 0 || mayReturn(till) !== null) return null;
  const left = params.idleReturnMinutes * 60_000 - idleMs;
  return left >= 1 && left <= NOTICE_MS ? Math.floor((left + 999) / 1000) : null;
}

/**
 * What a pending dashboard command does now: run it, or wait with the refusal that holds it (said to
 * the cloud as `tillMode.returnBlocked`). A command for the mode the device is already in is done at
 * once; with the owner's gate closed it is answered (done) and nothing moves.
 */
export interface CommandOutcome {
  run: boolean;
  done: boolean;
  blocked: TillModeRefusal | null;
}

export function remote(command: WorkModeCommand, current: WorkMode, params: TillModeParams, kiosk: KioskSideFacts, till: TillSideFacts): CommandOutcome {
  if (!params.enabled) return { run: false, done: true, blocked: REFUSALS.disabled };
  if (command.mode === current) return { run: false, done: true, blocked: null };
  const refusal = command.mode === 'till' ? mayEnter(params, kiosk) : mayReturn(till);
  return refusal === null ? { run: true, done: true, blocked: null } : { run: false, done: false, blocked: refusal };
}

/* -------------------------------------------------- what the cloud sees */

/** The till event's details for one switch (`POST /sync/{m}/events`, type `kiosk_till_mode`). */
export function eventDetails(input: {
  to: WorkMode;
  source: WorkModeSource;
  by: string | null;
  byId: string | null;
  employee: string | null;
  heldSales?: number;
  commandId?: string | null;
}): Record<string, unknown> {
  return {
    action: input.to === 'till' ? 'enter' : 'exit',
    mode: input.to,
    reason: input.source,
    by: input.by,
    byId: input.byId,
    employee: input.employee,
    heldSales: input.heldSales && input.heldSales > 0 ? input.heldSales : null,
    commandId: input.commandId ?? null,
  };
}

/** The till event as it goes to the cloud (pos-server schemas/audit_exception.py `TillEventIn`) and is kept on the device. */
export interface WorkModeEvent {
  id: string;
  type: typeof TILL_EVENT;
  occurredAt: string;
  shiftId: string | null;
  posUserId: string | null;
  details: Record<string, unknown>;
}

export function workModeEvent(input: { id: string; atMs: number; shiftId: string | null; posUserId: string | null; details: Record<string, unknown> }): WorkModeEvent {
  return { id: input.id, type: TILL_EVENT, occurredAt: new Date(input.atMs).toISOString(), shiftId: input.shiftId, posUserId: input.posUserId, details: input.details };
}

/** What the cloud hears in till mode (`status.tillMode`). */
export interface TillModeStatus {
  since: string | null;
  enteredBy: string | null;
  employee: string | null;
  source: WorkModeSource | null;
  returnBlocked: RefusalCode | null;
}

export function statusJson(session: TillSession | null, employee: string | null, blocked: TillModeRefusal | null): TillModeStatus {
  return {
    since: session ? new Date(session.sinceMs).toISOString() : null,
    enteredBy: session?.by ?? null,
    employee: employee ?? null,
    source: session?.source ?? null,
    returnBlocked: blocked?.wire ?? null,
  };
}

/* ------------------------------------------------ the kiosk/sync answer */

/** What a `kiosk/sync` answer does to the two sessions (KioskRepository.syncNow, ported). */
export interface SessionPlan {
  dropTill: boolean;
  dropAway: boolean;
  /** A kiosk made of a till with an employee signed in (perhaps mid-sale) is never yanked away: its till session starts. */
  startTill: boolean;
}

/**
 * The sessions after the cloud's word changed:
 *  - a device that is no longer a kiosk drops the whole kiosk side at once;
 *  - a till made a kiosk by role while an employee is signed in keeps the till, with the way back to the kiosk;
 *  - a kiosk by role made a till's kiosk-mode row (or the reverse): the other mode's session goes.
 */
export function planAfterSync(prev: RawKioskFacts, next: RawKioskFacts, held: { till: boolean; away: boolean }, employeeSignedIn: boolean): SessionPlan {
  const plan: SessionPlan = { dropTill: false, dropAway: false, startTill: false };
  let till = held.till;
  let away = held.away;
  if (!next.kiosk && prev.kiosk) {
    plan.dropTill = till;
    plan.dropAway = away;
    till = false;
    away = false;
  }
  if (next.kiosk && !next.homeTill && !KioskHomeRole.kioskByRole(prev) && employeeSignedIn) {
    plan.startTill = true;
    till = true;
  }
  if (next.homeTill) {
    if (till) {
      plan.dropTill = true;
      plan.startTill = false;
    }
  } else if (away) plan.dropAway = true;
  return plan;
}

/* -------------------------------------------------- the manager's code */

export type ManagerOutcome = 'granted' | 'wrong' | 'locked_out' | 'locked' | 'no_managers' | 'blank';

export interface ManagerDecision {
  outcome: ManagerOutcome;
  user: RosterUser | null;
  lock: ExitLock;
  triesLeft: number;
  lockedForMs: number;
  message: string | null;
}

export const MANAGER_TEXT = {
  locked: (ms: number) => `${MAX_FAILURES} ניסיונות שגויים — נסו שוב בעוד ${Math.max(1, Math.ceil(ms / 1000))} שניות`,
  wrong: (left: number) => `קוד שגוי, או שאין לו הרשאת "${KIOSK_TILL_MODE_LABEL}" — ${left === 1 ? 'נותר ניסיון אחד' : `נותרו ${left} ניסיונות`}`,
  noManagers: `לא נמצא בסניף מנהל עם הרשאת "${KIOSK_TILL_MODE_LABEL}". מגדירים בדשבורד: קופאים (POS) ← תפקידים והרשאות (המשתמשים מתעדכנים בסנכרון הבא).`,
  blank: 'הקלידו את קוד המנהל',
} as const;

/** Who may switch the device's mode with their own code: active, of this shop, with `KIOSK_TILL_MODE` allowed. */
export function managersFor(users: readonly RosterUser[], shopId: string | null | undefined): RosterUser[] {
  return usersAllowed(users, shopId, KIOSK_TILL_MODE);
}

/**
 * One try at the manager's code, as the desktop exit's pad (decideExit): a running lock refuses without
 * looking at the code; then the code is checked against the managers who hold KIOSK_TILL_MODE (bcrypt, one
 * at a time, the first match wins); five wrong codes lock it for a minute (kept across restarts).
 */
export async function decideManager(input: {
  users: readonly RosterUser[];
  shopId: string | null | undefined;
  code: string;
  lock: ExitLock | null | undefined;
  nowMs: number;
  compare: BcryptCompare;
}): Promise<ManagerDecision> {
  const lock = lockAt(input.lock, input.nowMs);
  const lockedFor = Math.max(0, lock.lockedUntilMs - input.nowMs);
  const base = { user: null, lock, triesLeft: Math.max(0, MAX_FAILURES - lock.failures), lockedForMs: lockedFor };
  if (lockedFor > 0) return { ...base, outcome: 'locked', triesLeft: 0, message: MANAGER_TEXT.locked(lockedFor) };
  const candidates = managersFor(input.users, input.shopId);
  if (candidates.length === 0) return { ...base, outcome: 'no_managers', message: MANAGER_TEXT.noManagers };
  const code = String(input.code ?? '');
  if (code.trim() === '') return { ...base, outcome: 'blank', message: MANAGER_TEXT.blank };
  const u = await findByPin(candidates, code, input.compare);
  if (u) return { outcome: 'granted', user: u, lock: NO_LOCK, triesLeft: MAX_FAILURES, lockedForMs: 0, message: null };
  const failures = lock.failures + 1;
  if (failures >= MAX_FAILURES) {
    return { outcome: 'locked_out', user: null, lock: { failures, lockedUntilMs: input.nowMs + LOCKOUT_MS }, triesLeft: 0, lockedForMs: LOCKOUT_MS, message: MANAGER_TEXT.locked(LOCKOUT_MS) };
  }
  return { outcome: 'wrong', user: null, lock: { failures, lockedUntilMs: 0 }, triesLeft: MAX_FAILURES - failures, lockedForMs: 0, message: MANAGER_TEXT.wrong(MAX_FAILURES - failures) };
}

/** Whether this user (read from the roster now) holds KIOSK_TILL_MODE — their own code on screen needs no second one. */
export function userHolds(users: readonly RosterUser[], shopId: string | null | undefined, userId: string | null | undefined): boolean {
  return !!userId && managersFor(users, shopId).some((u) => u.id === userId);
}
