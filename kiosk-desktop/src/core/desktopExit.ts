/**
 * "יציאה לשולחן העבודה" — leaving R2M POS for Windows to the Windows desktop, the pure rules
 * (main/service.ts `desktopExit` runs them; main/index.ts does the window part).
 *
 *  - Who: an ACTIVE till user of this device's shop whose role allows `DESKTOP_EXIT` (the cloud's
 *    catalogue, pos-server app/services/till_permissions.py: managers yes, cashiers no), typing their
 *    own PIN. Decided here, offline, from the roster the cloud ships (`GET /sync/{m}/pos-users`:
 *    each user's bcrypt PIN hash and *effective* permissions). A roster from an older server (no
 *    `permissions`, or no `DESKTOP_EXIT` in them) answers as the user's legacy role would — a shop
 *    manager yes, a cashier no: exactly who could open the admin and "יציאה מהתוכנה" before.
 *  - The PIN: bcrypt only, as the Android till's PinVerifier (domain/PinVerifier.kt) — `$2a$` /
 *    `$2b$` / `$2y$`; anything else is a refusal, never a comparison (no plaintext, no SHA
 *    fallback). The vectors in test/fixtures/pin_verify_vectors.json are the server's too.
 *  - Five wrong codes lock the pad for a minute (kept across restarts; a clock moved back never
 *    lengthens it).
 *  - Never during an order or a payment (updatePolicy.ts `paymentGuard` — the technician gate's rule
 *    and "התקן עכשיו"'s): refused before the PIN is even looked at.
 *  - Every exit, and the way back, is a till event (`POST /sync/{m}/events`, type `desktop_exit`):
 *    who, when, from which screen.
 *  - The manager's menu ("ניהול הקיוסק") opens for a role that allows `KIOSK_UNLOCK` (as the
 *    Android kiosk's manager corner); its "יציאה לשולחן העבודה" and "יציאה מהתוכנה" need that
 *    same manager to hold `DESKTOP_EXIT` — never a legacy role string (main/service.ts).
 */

import { DESKTOP_IDLE_RETURN_DEFAULT } from '@dash-lib/desktopIdleReturn';
import { paymentGuard, type Activity } from './updatePolicy';

export const DESKTOP_EXIT = 'DESKTOP_EXIT';
export const PERMISSION_LABEL = 'יציאה לשולחן העבודה (Windows)';
/**
 * Opening the kiosk's manager menu ("ניהול הקיוסק"): the role's "יציאה מנעילת קופה (קיוסק)" —
 * the Android kiosk's manager corner asks the same (ElevationScope.KIOSK_UNLOCK).
 */
export const KIOSK_UNLOCK = 'KIOSK_UNLOCK';
export const KIOSK_UNLOCK_LABEL = 'יציאה מנעילת קופה (קיוסק)';
export const MAX_FAILURES = 5;
export const LOCKOUT_MS = 60_000;
/** The pad closes by itself when nobody types. */
export const PAD_IDLE_MS = 45_000;
/**
 * Back to the kiosk by itself after this long with nobody at the keyboard or mouse — the default
 * of the cloud's setting `desktopIdleReturnMinutes` (client lib/desktopIdleReturn.ts; 0 = never).
 */
export const IDLE_RETURN_MINUTES = DESKTOP_IDLE_RETURN_DEFAULT;

export type PermState = 'allow' | 'approval' | 'deny';

/** A till user as the roster carries them (main/sync/cloud.ts `PosUser`). */
export interface RosterUser {
  id: string;
  username: string;
  firstName: string | null;
  lastName: string | null;
  pinHash: string;
  /** The legacy role older tills read: `cashier` | `shop_manager`. */
  role: string;
  isActive: boolean;
  shopId?: string | null;
  /** The cloud's effective permissions (code → allow | approval | deny); absent from an older server. */
  permissions?: Record<string, string> | null;
  tillRoleName?: string | null;
}

/**
 * The cloud's permission codes (till_permissions.py `CODES`, the Android till's `Perm.ALL`), pinned
 * by test/desktopExit.test.ts against pos-server's tests/fixtures/till_permissions_matrix.json.
 */
export const CODES: readonly string[] = [
  'SELL', 'CALCULATOR.USE', 'PRICE_OVERRIDE', 'DISCOUNT', 'VOUCHER_DISCOUNT_OVERRIDE', 'LINE_VOID', 'OTH', 'REFUND', 'REPRINT',
  'TABLES.USE', 'TABLES.OPEN_OTHERS', 'TABLE_CANCEL', 'TABLE_VOID', 'TABLE_RESTORE', 'TABLE_UNLOCK',
  'SHIFT_OPEN', 'SHIFT_CLOSE', 'X', 'Z', 'TRANSMIT', 'VIEW_REPORTS',
  'CASH_DRAWER.OPEN_ON_CASH_SALE', 'CASH_DRAWER.OPEN_MANUALLY', 'CASH_DRAWER.OPEN_FOR_CHANGE', 'CASH_DRAWER.CASH_IN',
  'CASH_DRAWER.CASH_OUT', 'CASH_DRAWER.DEPOSIT', 'CASH_DRAWER.COUNT', 'CASH_DRAWER.BLIND_COUNT',
  'CASH_DRAWER.OPEN_FOR_TEST', 'CASH_DRAWER.APPROVE_OPEN', 'CASH_DRAWER.OPEN_AFTER_CLOSE', 'CASH_DRAWER.VIEW_LOG',
  'CASH_DRAWER.VIEW_CASH_MOVEMENTS',
  'CATALOG_WRITE', 'ATTENDANCE_MANAGE', 'USER_SESSION_RELEASE', 'CARD_UNRESOLVED', 'KIOSK_CONTROL', 'KIOSK_UNLOCK',
  DESKTOP_EXIT,
];
const KNOWN = new Set(CODES);

/** What a cashier needed a manager for before roles (the cloud's `LEGACY_APPROVAL_CODES`). */
const LEGACY_APPROVAL = new Set([
  'REFUND', 'DISCOUNT', 'VOUCHER_DISCOUNT_OVERRIDE', 'OTH', 'CATALOG_WRITE', 'TRANSMIT', 'TABLE_CANCEL', 'TABLE_UNLOCK', 'REPRINT', 'TABLE_VOID',
  'TABLE_RESTORE', 'USER_SESSION_RELEASE', 'KIOSK_UNLOCK', 'KIOSK_CONTROL', 'ATTENDANCE_MANAGE', 'CARD_UNRESOLVED',
]);
/** A shop manager's alone before roles (the cloud's `LEGACY_CASHIER_DENIED`). */
const LEGACY_CASHIER_DENIED = new Set(['CASH_DRAWER.APPROVE_OPEN', DESKTOP_EXIT]);

/** What the legacy role allowed (Android `PermissionProfile.legacy`); an unknown code is never granted. */
export function legacyState(role: string | null | undefined, code: string): PermState {
  if (!KNOWN.has(code)) return 'deny';
  if ((role ?? '').trim().toLowerCase() === 'shop_manager') return 'allow';
  if (LEGACY_APPROVAL.has(code)) return 'approval';
  if (LEGACY_CASHIER_DENIED.has(code)) return 'deny';
  return 'allow';
}

/** The cloud's answer for the user, or — a code it did not send — the legacy role's. */
export function permissionState(user: Pick<RosterUser, 'role' | 'permissions'>, code: string): PermState {
  if (!KNOWN.has(code)) return 'deny';
  const sent = user.permissions && typeof user.permissions === 'object' ? user.permissions[code] : undefined;
  if (sent === 'allow' || sent === 'approval' || sent === 'deny') return sent;
  return legacyState(user.role, code);
}

/**
 * The roster is this shop's (the cloud sends a machine its own shop's users); a row that names
 * another shop — the device moved, a stale copy — never opens anything here.
 */
export function ofShop(user: Pick<RosterUser, 'shopId'>, shopId: string | null | undefined): boolean {
  if (!shopId || !user.shopId) return true;
  return user.shopId.toLowerCase() === shopId.toLowerCase();
}

/**
 * Who may do `code` here with their own PIN: active, of this shop, with a PIN, and the role's
 * answer `allow` — nothing else counts (an "approval" is a second person's, not a pad's).
 */
export function usersAllowed(users: readonly RosterUser[], shopId: string | null | undefined, code: string): RosterUser[] {
  return users.filter((u) => u.isActive && !!u.pinHash && ofShop(u, shopId) && permissionState(u, code) === 'allow');
}

/** Who may take this device to the desktop (`DESKTOP_EXIT`). */
export function exitCandidates(users: readonly RosterUser[], shopId: string | null | undefined): RosterUser[] {
  return usersAllowed(users, shopId, DESKTOP_EXIT);
}

/** The first of `candidates` whose PIN this is (bcrypt one at a time), or null. */
export async function findByPin(candidates: readonly RosterUser[], pin: string, compare: BcryptCompare): Promise<RosterUser | null> {
  for (const u of candidates) {
    if (await verifyPin(pin, u.pinHash, compare)) return u;
  }
  return null;
}

/** May this user (re-read from the roster now) take the device out — the admin's buttons. */
export function userMayExit(users: readonly RosterUser[], shopId: string | null | undefined, userId: string | null | undefined): RosterUser | null {
  if (!userId) return null;
  return exitCandidates(users, shopId).find((u) => u.id === userId) ?? null;
}

export function displayName(u: Pick<RosterUser, 'firstName' | 'lastName' | 'username'>): string {
  return [u.firstName, u.lastName].filter(Boolean).join(' ') || u.username;
}

/* ------------------------------------------------------------------- the PIN */

/** bcrypt hashes start `$2a$`, `$2b$` or `$2y$` (PinVerifier.BCRYPT_PREFIX). */
export const BCRYPT_PREFIX = /^\$2[aby]?\$/;

export type BcryptCompare = (pin: string, hash: string) => Promise<boolean>;

/** PinVerifier.verify, ported: a blank PIN or hash, or a hash that is not bcrypt, is a refusal. */
export async function verifyPin(pin: string, storedHash: string | null | undefined, compare: BcryptCompare): Promise<boolean> {
  if (!pin || pin.trim() === '' || !storedHash || storedHash.trim() === '') return false;
  if (!BCRYPT_PREFIX.test(storedHash)) return false;
  try {
    return (await compare(pin, storedHash)) === true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ the lock */

export interface ExitLock {
  failures: number;
  lockedUntilMs: number;
}

export const NO_LOCK: ExitLock = { failures: 0, lockedUntilMs: 0 };

/** The lock as it stands now: run out → cleared; reaching too far (the clock moved back) → cut. */
export function lockAt(lock: ExitLock | null | undefined, nowMs: number): ExitLock {
  const l = lock && Number.isFinite(lock.failures) && Number.isFinite(lock.lockedUntilMs) ? lock : NO_LOCK;
  if (l.lockedUntilMs <= 0) return l;
  if (l.lockedUntilMs <= nowMs) return NO_LOCK;
  if (l.lockedUntilMs - nowMs > LOCKOUT_MS) return { ...l, lockedUntilMs: nowMs + LOCKOUT_MS };
  return l;
}

/* -------------------------------------------------------------- the decision */

/** Not during an order or a payment: the reason in Hebrew, or null. */
export function exitGuard(activity: Activity | null | undefined): string | null {
  return activity ? paymentGuard(activity) : null;
}

export type ExitOutcome = 'granted' | 'wrong' | 'locked_out' | 'locked' | 'busy' | 'no_managers' | 'blank';

export interface ExitDecision {
  outcome: ExitOutcome;
  user: RosterUser | null;
  lock: ExitLock;
  triesLeft: number;
  lockedForMs: number;
  message: string | null;
}

export const TEXT = {
  busy: (why: string) => `אי אפשר לצאת עכשיו — ${why}`,
  locked: (ms: number) => `${MAX_FAILURES} ניסיונות שגויים — נסו שוב בעוד ${Math.max(1, Math.ceil(ms / 1000))} שניות`,
  wrong: (left: number) => `קוד שגוי, או שאין לו הרשאת "${PERMISSION_LABEL}" — ${left === 1 ? 'נותר ניסיון אחד' : `נותרו ${left} ניסיונות`}`,
  noManagers: `לא נמצא בסניף מנהל עם הרשאת "${PERMISSION_LABEL}". מגדירים בדשבורד: קופאים (POS) ← תפקידים והרשאות (המשתמשים מתעדכנים בסנכרון הבא).`,
  blank: 'הקלידו את קוד המנהל',
} as const;

/**
 * One try at the pad. The order matters: an order or a payment refuses before anything else (no
 * attempt is spent); a running lock refuses without looking at the PIN; only then is the PIN
 * checked — against the users who may leave, one bcrypt at a time, the first match wins.
 */
export async function decideExit(input: {
  users: readonly RosterUser[];
  shopId: string | null | undefined;
  pin: string;
  lock: ExitLock | null | undefined;
  nowMs: number;
  activity: Activity | null | undefined;
  compare: BcryptCompare;
}): Promise<ExitDecision> {
  const lock = lockAt(input.lock, input.nowMs);
  const lockedFor = Math.max(0, lock.lockedUntilMs - input.nowMs);
  const base = { user: null, lock, triesLeft: Math.max(0, MAX_FAILURES - lock.failures), lockedForMs: lockedFor };
  const guard = exitGuard(input.activity);
  if (guard) return { ...base, outcome: 'busy', message: TEXT.busy(guard) };
  if (lockedFor > 0) return { ...base, outcome: 'locked', triesLeft: 0, message: TEXT.locked(lockedFor) };
  const candidates = exitCandidates(input.users, input.shopId);
  if (candidates.length === 0) return { ...base, outcome: 'no_managers', message: TEXT.noManagers };
  const pin = String(input.pin ?? '');
  if (pin.trim() === '') return { ...base, outcome: 'blank', message: TEXT.blank };
  const u = await findByPin(candidates, pin, input.compare);
  if (u) return { outcome: 'granted', user: u, lock: NO_LOCK, triesLeft: MAX_FAILURES, lockedForMs: 0, message: null };
  const failures = lock.failures + 1;
  if (failures >= MAX_FAILURES) {
    const next = { failures, lockedUntilMs: input.nowMs + LOCKOUT_MS };
    return { outcome: 'locked_out', user: null, lock: next, triesLeft: 0, lockedForMs: LOCKOUT_MS, message: TEXT.locked(LOCKOUT_MS) };
  }
  return { outcome: 'wrong', user: null, lock: { failures, lockedUntilMs: 0 }, triesLeft: MAX_FAILURES - failures, lockedForMs: 0, message: TEXT.wrong(MAX_FAILURES - failures) };
}

/* ------------------------------------------------------------- the record */

/** `POST /sync/{m}/events` (pos-server schemas/audit_exception.py `TillEventIn`, type `desktop_exit`). */
export interface DesktopExitEvent {
  id: string;
  type: 'desktop_exit';
  occurredAt: string;
  shiftId: string | null;
  posUserId: string | null;
  details: Record<string, unknown>;
}

/** The exit, while it lasts (kept, so a restart on the desktop still records the way back). */
export interface DesktopExitState {
  eventId: string;
  userId: string;
  userName: string;
  atMs: number;
}

export type ReturnVia = 'tray' | 'shortcut' | 'taskbar' | 'relaunch' | 'idle' | 'restart';

export function exitEvent(input: {
  id: string;
  atMs: number;
  user: RosterUser;
  shiftId: string | null;
  screen: string;
  deviceRole: string | null;
  appVersion: string;
  /** `exit` to the desktop (default), or `quit` — "יציאה מהתוכנה" from the manager's menu. */
  action?: 'exit' | 'quit';
  /** `admin`: from the manager's menu (no second code); absent: the corner's pad. */
  via?: 'admin';
}): DesktopExitEvent {
  return {
    id: input.id,
    type: 'desktop_exit',
    occurredAt: new Date(input.atMs).toISOString(),
    shiftId: input.shiftId,
    posUserId: input.user.id,
    details: {
      action: input.action ?? 'exit',
      ...(input.via ? { via: input.via } : {}),
      permission: DESKTOP_EXIT,
      userName: displayName(input.user),
      ...(input.user.tillRoleName ? { roleName: input.user.tillRoleName } : {}),
      screen: input.screen,
      ...(input.deviceRole ? { deviceRole: input.deviceRole } : {}),
      appVersion: input.appVersion,
    },
  };
}

export function returnEvent(input: { id: string; atMs: number; exit: DesktopExitState; via: ReturnVia; shiftId: string | null }): DesktopExitEvent {
  return {
    id: input.id,
    type: 'desktop_exit',
    occurredAt: new Date(input.atMs).toISOString(),
    shiftId: input.shiftId,
    posUserId: input.exit.userId,
    details: {
      action: 'return',
      exitId: input.exit.eventId,
      userName: input.exit.userName,
      via: input.via,
      awaySeconds: Math.max(0, Math.round((input.atMs - input.exit.atMs) / 1000)),
    },
  };
}

/**
 * Back to the kiosk by itself: out for at least the limit AND nobody at the keyboard or mouse for
 * the limit (Windows' own idle time) — a manager still working on the desktop is never pulled back.
 */
export function shouldAutoReturn(input: { systemIdleSec: number; exitedAtMs: number; nowMs: number; limitMinutes: number }): boolean {
  if (!(input.limitMinutes > 0)) return false;
  const limitMs = input.limitMinutes * 60_000;
  return input.nowMs - input.exitedAtMs >= limitMs && input.systemIdleSec * 1000 >= limitMs;
}
