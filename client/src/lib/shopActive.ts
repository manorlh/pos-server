/**
 * "סניף לא פעיל" (P:/specs/shop-code-and-inactive.md §3, approved 13.10.2026) — the shapes the
 * server sends and the small rules the dashboard applies. No imports, so `npm test` compiles it
 * alone. Mirrors server/app/services/shop_active.py.
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
