/**
 * The till's staff: who signs in with a PIN, and what each may do — the Android till's rules on the roster the
 * cloud ships (`GET /sync/{m}/pos-users`: each user's bcrypt PIN hash and EFFECTIVE permissions;
 * pos-android domain/PinVerifier.kt, domain/PermissionService.kt), decided here, offline.
 *
 *  - the PIN is checked against the shop's active users with a PIN hash, bcrypt only (core/desktopExit.ts verifyPin —
 *    no plaintext, no fallback); five wrong codes lock the pad for a minute (the Windows exit pad's rule, its own lock);
 *  - a permission answers `allow` (do it), `approval` (a manager's code first) or `deny` (no) — the cloud's word for the
 *    user, or — a code it did not send — the legacy role's (permissionState);
 *  - who may approve a code: an active user of the shop whose own answer for it is `allow` (a manager's code).
 *
 * Pure: bcrypt is injected, the clock is a parameter. Every Hebrew text is the Android till's (PermissionService).
 */

import {
  LOCKOUT_MS,
  MAX_FAILURES,
  NO_LOCK,
  displayName,
  findByPin,
  lockAt,
  ofShop,
  permissionState,
  usersAllowed,
  type BcryptCompare,
  type ExitLock,
  type PermState,
  type RosterUser,
} from '../desktopExit';

export type { PermState, RosterUser };

/** The permission codes the till asks (the cloud's catalogue, core/desktopExit.ts CODES). */
export const PERM = {
  SELL: 'SELL',
  SELL_RESTRICTED: 'SELL_RESTRICTED_ITEMS',
  SHIFT_OPEN: 'SHIFT_OPEN',
  SHIFT_CLOSE: 'SHIFT_CLOSE',
  X: 'X',
  Z: 'Z',
  REPRINT: 'REPRINT',
  DRAWER_ON_CASH_SALE: 'CASH_DRAWER.OPEN_ON_CASH_SALE',
  CATALOG_WRITE: 'CATALOG_WRITE',
  KIOSK_TILL_MODE: 'KIOSK_TILL_MODE',
} as const;

/** Hebrew names for "אין לך הרשאה: …" and the approval prompt — the cloud's labels (PermissionService.LABELS). */
export const PERM_LABEL: Record<string, string> = {
  SELL: 'מכירה מהירה',
  CALCULATOR: 'מחשבון — מכירה בסכום חופשי',
  PRICE_OVERRIDE: 'הקלדת מחיר לפריט במחיר פתוח',
  DISCOUNT: 'הנחה',
  LINE_VOID: 'ביטול שורה',
  REFUND: 'זיכוי / החזר',
  REPRINT: 'הדפסה חוזרת',
  SELL_RESTRICTED_ITEMS: 'מכירת פריט המחייב אישור מנהל',
  SHIFT_OPEN: 'פתיחת משמרת',
  SHIFT_CLOSE: 'סגירת משמרת',
  X: 'דוח X',
  Z: 'סגירת Z',
  TRANSMIT: 'שידור עסקאות אשראי',
  VIEW_REPORTS: 'דוחות בקופה',
  'CASH_DRAWER.OPEN_ON_CASH_SALE': 'פתיחת מגירה בעסקת מזומן',
  'CASH_DRAWER.OPEN_MANUALLY': 'פתיחת מגירה ידנית',
  CATALOG_WRITE: 'עריכת קטלוג',
  ITEM_BLOCK: 'חסימת פריט / אזל',
  KIOSK_UNLOCK: 'יציאה מנעילת קופה',
  DESKTOP_EXIT: 'יציאה לשולחן העבודה (Windows)',
  KIOSK_TILL_MODE: 'מעבר למצב קופה בקיוסק',
  CARD_UNRESOLVED: 'עסקת אשראי לא ידועה',
};

export const permLabel = (code: string): string => PERM_LABEL[code] ?? code;

/** The Android till's words (PermissionService.deniedText / approvalText). */
export const TEXT = {
  notSignedIn: 'יש להתחבר לקופה',
  denied: (code: string) => `אין לך הרשאה: ${permLabel(code)}`,
  approval: (code: string) => `${permLabel(code)} — דורש אישור מנהל`,
  loginShort: 'הקוד קצר מדי',
  loginBad: 'הקוד אינו מזוהה',
  loginNoStaff: 'טרם סונכרנו עובדים למכשיר. בדוק את החיבור בהגדרות.',
  locked: (ms: number) => `יותר מדי ניסיונות. נסו שוב בעוד ${Math.max(1, Math.ceil(ms / 1000))} שניות.`,
  noApprover: (code: string) => `אין בסניף מנהל עם ההרשאה "${permLabel(code)}"`,
  managerWrong: 'קוד מנהל שגוי',
} as const;

/** The shop's users who may sign in here: active, of this shop, with a PIN. */
export function loginCandidates(users: readonly RosterUser[], shopId: string | null | undefined): RosterUser[] {
  return users.filter((u) => u.isActive && !!u.pinHash && ofShop(u, shopId));
}

export type LoginOutcome = 'granted' | 'wrong' | 'locked_out' | 'locked' | 'no_staff' | 'short';

export interface LoginDecision {
  outcome: LoginOutcome;
  user: RosterUser | null;
  lock: ExitLock;
  triesLeft: number;
  message: string | null;
}

/** One try at the lock screen. A running lock refuses without looking at the PIN; five wrong ones lock it for a minute. */
export async function tryLogin(input: {
  users: readonly RosterUser[];
  shopId: string | null | undefined;
  pin: string;
  lock: ExitLock | null | undefined;
  nowMs: number;
  compare: BcryptCompare;
}): Promise<LoginDecision> {
  const lock = lockAt(input.lock, input.nowMs);
  const lockedFor = Math.max(0, lock.lockedUntilMs - input.nowMs);
  const base = { user: null, lock, triesLeft: Math.max(0, MAX_FAILURES - lock.failures) };
  if (lockedFor > 0) return { ...base, outcome: 'locked', triesLeft: 0, message: TEXT.locked(lockedFor) };
  const candidates = loginCandidates(input.users, input.shopId);
  if (candidates.length === 0) return { ...base, outcome: 'no_staff', message: TEXT.loginNoStaff };
  const pin = String(input.pin ?? '').trim();
  if (pin.length < 4) return { ...base, outcome: 'short', message: TEXT.loginShort };
  const user = await findByPin(candidates, pin, input.compare);
  if (user) return { outcome: 'granted', user, lock: NO_LOCK, triesLeft: MAX_FAILURES, message: null };
  const failures = lock.failures + 1;
  if (failures >= MAX_FAILURES) {
    return { outcome: 'locked_out', user: null, lock: { failures, lockedUntilMs: input.nowMs + LOCKOUT_MS }, triesLeft: 0, message: TEXT.locked(LOCKOUT_MS) };
  }
  return { outcome: 'wrong', user: null, lock: { failures, lockedUntilMs: 0 }, triesLeft: MAX_FAILURES - failures, message: TEXT.loginBad };
}

/** What the user may do with `code`: the cloud's word, or the legacy role's. */
export function stateOf(user: Pick<RosterUser, 'role' | 'permissions'>, code: string): PermState {
  return permissionState(user, code);
}

/** The codes the screens hide or show by: the ones the user holds outright (`allow`). */
export function allowedCodes(user: Pick<RosterUser, 'role' | 'permissions'>, codes: readonly string[]): string[] {
  return codes.filter((c) => permissionState(user, c) === 'allow');
}

/** Who may approve `code` with their own PIN here (a manager's code): active, of this shop, `allow`. */
export function approversOf(users: readonly RosterUser[], shopId: string | null | undefined, code: string): RosterUser[] {
  return usersAllowed(users, shopId, code);
}

export type ApprovalOutcome = { ok: true; user: RosterUser } | { ok: false; reason: 'no_approver' | 'wrong' | 'locked'; message: string; lock: ExitLock };

/** A manager's code for `code`: bcrypt against the users who may approve it; the same one-minute lock after five wrong. */
export async function approve(input: {
  users: readonly RosterUser[];
  shopId: string | null | undefined;
  code: string;
  pin: string;
  lock: ExitLock | null | undefined;
  nowMs: number;
  compare: BcryptCompare;
}): Promise<ApprovalOutcome> {
  const lock = lockAt(input.lock, input.nowMs);
  const lockedFor = Math.max(0, lock.lockedUntilMs - input.nowMs);
  if (lockedFor > 0) return { ok: false, reason: 'locked', message: TEXT.locked(lockedFor), lock };
  const candidates = approversOf(input.users, input.shopId, input.code);
  if (candidates.length === 0) return { ok: false, reason: 'no_approver', message: TEXT.noApprover(input.code), lock };
  const user = await findByPin(candidates, String(input.pin ?? '').trim(), input.compare);
  if (user) return { ok: true, user };
  const failures = lock.failures + 1;
  const next = failures >= MAX_FAILURES ? { failures, lockedUntilMs: input.nowMs + LOCKOUT_MS } : { failures, lockedUntilMs: 0 };
  return { ok: false, reason: failures >= MAX_FAILURES ? 'locked' : 'wrong', message: failures >= MAX_FAILURES ? TEXT.locked(LOCKOUT_MS) : TEXT.managerWrong, lock: next };
}

export { displayName };
