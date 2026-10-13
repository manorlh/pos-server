/**
 * "סניף לא פעיל" (P:/specs/shop-code-and-inactive.md §3, approved 13.10.2026) — the shapes the
 * server sends and the small rules the dashboard applies; below, the devices' lock (the Windows app,
 * the browser kiosk, KDS, board and customer display). No imports, so `npm test` compiles it alone.
 * Mirrors server/app/services/shop_active.py.
 *
 * Owner: "אפשר להפוך לסניף לא פעיל, והפיכה כזו גם תנעל את המכשירים (הרשאה לסופר אדמין)".
 *
 * * The "סניף פעיל" switch is shown to everyone; only the super admin may flip it (the server
 *   answers anyone else 403 `shop_active_super_admin_only`).
 * * Every change asks for confirmation and a reason (422 `shop_active_reason_required` without
 *   one), and is logged: who, when, why (`GET /shops/{id}/active-log`).
 * * Off locks every till, kiosk, KDS screen and customer display of the shop once its current
 *   sale ends; a manager code at the till does not release it — only turning the shop back on
 *   does. A till locked by hand ("נעל קופה") stays locked when the shop is back on.
 * * The shop's reports stay visible; documents its devices still upload are accepted.
 */

export const SHOP_ACTIVE_REASON_MAX = 500;

export interface ShopActiveLogEntry {
  id: string;
  /** The state the shop was put in: false — turned off. */
  active: boolean;
  reason: string | null;
  at: string | null;
  userId: string | null;
  userName: string | null;
}

/** `GET /shops/{id}/active-log`. */
export interface ShopActiveStatus {
  shopId: string;
  isActive: boolean;
  /** The super admin only. */
  canChange: boolean;
  /** Newest first. */
  log: ShopActiveLogEntry[];
}

/** What is wrong with the reason before it is sent: `required`, or null. */
export function shopActiveReasonError(reason: string | null | undefined): 'required' | null {
  return (reason ?? '').trim() ? null : 'required';
}

/** `PUT /shops/{id}`'s body for the switch: the new state and why. */
export function shopActivePayload(active: boolean, reason: string): { isActive: boolean; activeReason: string } {
  return { isActive: active, activeReason: reason.trim().slice(0, SHOP_ACTIVE_REASON_MAX) };
}

/**
 * The edit form's body without the switch: it is flipped on its own (confirmed, with a reason),
 * never echoed back by a save of the shop's details — a stale value would read as a change.
 */
export function withoutActiveFields<T extends { isActive?: unknown; activeReason?: unknown }>(
  v: T,
): Omit<T, 'isActive' | 'activeReason'> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { isActive, activeReason, ...rest } = v;
  return rest;
}

/** The confirmation to show for flipping the switch to [next]: `off` or `on`. */
export function shopActiveConfirmKind(next: boolean): 'off' | 'on' {
  return next ? 'on' : 'off';
}

/** The latest change, for "כובה ע״י … ב-…". */
export function lastShopActiveChange(status: Pick<ShopActiveStatus, 'log'> | null | undefined): ShopActiveLogEntry | null {
  return status?.log?.[0] ?? null;
}

/* ═════════════════════════════════════════════════════════════════════════════════════════════
 * The devices — "הסניף אינו פעיל — פנו לתמיכה" on every screen of the shop that is not the Android
 * APK's: the Windows app (kiosk-desktop: kiosk, KDS, board), the browser kiosk (`/k`), the browser
 * KDS and board (`/kds`, `/board`) and the browser customer display (`/display`). The same rules and
 * the same words as the Android till (pos-android domain/ShopLock.kt, manorlh/pos-android#51):
 *
 * * The cloud says it as `shopActive` beside `trainingMode`: `GET /machines/me`, the heartbeat's
 *   reply, `GET /sync/{m}/settings` (top level on every answer, "unchanged" included, and
 *   `settings.shopActive` on a full / delta pull). Absent (an older server) is active; only an
 *   explicit false locks. The device keeps it, so it holds offline and across a reload.
 * * A kiosk (a till) applies it once the customer on it is done — ordering, paying, the success
 *   screen — never in the middle of a payment. Once the lock screen is up it stays up ("engaged"):
 *   nothing new starts under it. A kitchen screen, a board and a customer display show it at once.
 * * A manager's code never releases it — only the shop turned on again in the cloud. A kiosk's own
 *   pause is a separate lock, which a manager does lift.
 * * Still running under it: uploads of documents, shifts and Zs (orders already taken), the
 *   heartbeat and the settings pulls — so turning the shop on again unlocks at once.
 * * "סגירת משמרת ו-Z" with a manager's code where the device holds shifts (the Windows kiosk).
 * ═════════════════════════════════════════════════════════════════════════════════════════════ */

/** The Android till's own words (res/values/strings_shop_lock.xml). */
export const SHOP_LOCK_TEXT = {
  title: 'הסניף אינו פעיל — פנו לתמיכה',
  body: 'המכשיר נעול עד שהסניף יופעל מחדש בענן. מסמכים, משמרות ו-Z שעוד לא עלו ממשיכים לעלות לענן.',
  closeDay: 'סגירת משמרת ו-Z',
  closeDayDone: 'חזרה למסך הנעילה',
  managerMessage: 'סגירת משמרת ו-Z בסניף לא פעיל',
  nothingToClose: 'אין משמרת פתוחה בקופה זו. ה-Z של הסניף מופק בסגירת Z סניפי.',
} as const;

/**
 * What a kiosk reports to the cloud (`kiosk/sync` status) while its shop lock is up: the cloud's
 * flow states have no word of their own for it (kiosk_control.FLOW_STATES), so `paused`, with the
 * screen named. The kiosk's service reads that screen as "the lock is engaged".
 */
export const SHOP_LOCK_FLOW = { flowState: 'paused', screen: 'shop_locked' } as const;

function flagOf(v: unknown): boolean | null {
  if (v === true || v === false) return v;
  if (typeof v === 'number' && Number.isFinite(v)) return v !== 0;
  if (typeof v === 'string') {
    const t = v.trim().toLowerCase();
    if (t === 'true' || t === '1' || t === 'yes') return true;
    if (t === 'false' || t === '0' || t === 'no') return false;
  }
  return null;
}

/**
 * The cloud's `shopActive` in an answer (`machines/me`, the heartbeat, the settings pull): true /
 * false, or null — the answer said nothing of it (an older server). The top level first, then
 * `settings.shopActive`.
 */
export function shopActiveSaid(body: unknown): boolean | null {
  if (!body || typeof body !== 'object') return null;
  const o = body as Record<string, unknown>;
  const top = flagOf(o.shopActive);
  if (top !== null) return top;
  const s = o.settings;
  return s && typeof s === 'object' && !Array.isArray(s) ? flagOf((s as Record<string, unknown>).shopActive) : null;
}

/**
 * The state kept after an answer: what it said; nothing said — as it was, except on a full settings
 * answer (`full`), which with neither field is an older server's: active — never a lock left behind
 * that nothing would lift.
 */
export function shopActiveAfter(kept: boolean, said: boolean | null, full = false): boolean {
  if (said !== null) return said;
  return full ? true : kept;
}

/** A kept value read back (storage): active unless it says false — absent or unreadable is active. */
export function shopActiveKept(v: unknown): boolean {
  return flagOf(v) !== false;
}

/** Which device asks. A till and a kiosk sell; the others only show. */
export type ShopLockSurface = 'till' | 'kiosk' | 'kds' | 'board' | 'customer_display';

export interface ShopLockFacts {
  shopActive: boolean;
  surface: ShopLockSurface;
  /** A till's sale, or a kiosk's customer ordering, paying or on the success screen: the lock waits for it. */
  saleInProgress?: boolean;
  /** The lock screen has been up since the shop went off: it waits for no sale again. */
  engaged?: boolean;
}

function sells(surface: ShopLockSurface): boolean {
  return surface === 'till' || surface === 'kiosk';
}

/**
 * The shop's lock screen is up now: on a kitchen screen, a board and a customer display at once
 * (they sell nothing); on a till and a kiosk once the sale in progress ended — or it is engaged.
 */
export function shopLockShown(f: ShopLockFacts): boolean {
  if (f.shopActive) return false;
  if (!sells(f.surface)) return true;
  return !f.saleInProgress || !!f.engaged;
}

/** Engaged from the moment the lock screen is up, until the shop is active again. */
export function shopLockEngaged(wasEngaged: boolean, shown: boolean, shopActive: boolean): boolean {
  return !shopActive && (wasEngaged || shown);
}

/** The two locks a device may be under: the shop's ("סניף לא פעיל") and its own (a kiosk's pause, "נעל קופה"). */
export type DeviceLock = 'shop' | 'device';

/** A manager's code on the device releases [lock]: the device's own lock only — never the shop's. */
export function managerCodeReleases(lock: DeviceLock): boolean {
  return lock === 'device';
}

/** A new sale may start (a payment, a kiosk order sent): not once the shop's lock is engaged. */
export function newSaleAllowed(shopActive: boolean, engaged: boolean): boolean {
  return shopActive || !engaged;
}

/** What a device does, as the shop lock sees it. */
export type ShopLockAction =
  | 'sell'
  | 'order'
  | 'tables'
  | 'kiosk_order'
  | 'voucher_redeem'
  | 'shift_close'
  | 'z'
  | 'upload'
  | 'heartbeat'
  | 'settings_pull';

/** What the shop lock stops (§3 "מה חסום"). Everything else goes on. */
export const SHOP_LOCK_BLOCKED: ReadonlySet<ShopLockAction> = new Set<ShopLockAction>(['sell', 'order', 'tables', 'kiosk_order', 'voucher_redeem']);

export function shopLockAllows(action: ShopLockAction, shopActive: boolean): boolean {
  return shopActive || !SHOP_LOCK_BLOCKED.has(action);
}

/** The lock screen offers "סגירת משמרת ו-Z" where shifts and Zs are made (a till, a kiosk). */
export function closeDayOffered(surface: ShopLockSurface): boolean {
  return sells(surface);
}

/**
 * A kiosk's close of the day from its lock, by its Z mode (the Android kiosk's "משמרת ו-Z"): its
 * own Z (`till` — an open shift is closed first), else the shift's close (the shop Z makes the Z);
 * null — nothing to close here (the cloud's Z mode with no shift open).
 */
export type CloseDayKind = 'till_z' | 'shift_close';

export function kioskCloseDay(f: { zMode: string; shiftOpen: boolean }): CloseDayKind | null {
  if (f.zMode === 'till') return 'till_z';
  return f.shiftOpen ? 'shift_close' : null;
}

/** The till permission a manager approves it with (till_permissions.py: "סגירת Z בקופה", "סגירת משמרת"). */
export function closeDayPermission(kind: CloseDayKind): 'Z' | 'SHIFT_CLOSE' {
  return kind === 'till_z' ? 'Z' : 'SHIFT_CLOSE';
}
