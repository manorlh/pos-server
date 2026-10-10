/**
 * Which role this Windows device plays — decided by the cloud, never on the PC.
 *
 * The dashboard's "הוספת מכשיר" sets the device type (קופה / קיוסק / מסך מטבח / מסך מוכן-לא מוכן)
 * on the pairing code; the machine then is that from its first `machines/me` (`deviceRole`). Two
 * older paths are still read so nothing already installed changes:
 *
 *  - a kiosk: the `kiosk/sync` snapshot says `kiosk: true` (a till converted on the kiosks page,
 *    or a kiosk code) — the kiosk always wins: today's kiosk, unchanged;
 *  - a KDS screen made on the KDS page (`kds_devices` row; `kdsScreen` parameter): its
 *    `kds/device` answer — a `pickup` screen is the order status board.
 *
 * KDS and the board are NOT tills: no documents, no shifts, no Z, no payments (the cloud enforces
 * it too). `fiscal` says which roles may ever touch the ledger.
 *
 * "מצב עבודה: קיוסק / קופה" (core/workMode.ts, main/workMode.ts) moves a device between the two
 * fiscal roles by the day's choice, never the cloud's role: a kiosk by role in its till session opens
 * as the till; a till by role away in its kiosk mode opens as the kiosk (its kiosk snapshot, read as
 * `kioskActive`, is the effective one — a till at home is no kiosk). Same machine, same series, same
 * shift: nothing fiscal moves with the role.
 */

import type { AppRole } from '../shared/roles';

export const ROLES: readonly AppRole[] = ['kiosk', 'till', 'kds', 'order_status_board', 'customer_display'];

export interface RoleInfo {
  /** Hebrew, as the dashboard names it. */
  label: string;
  /** Issues fiscal documents (shifts, Z, payments). */
  fiscal: boolean;
  /** Built in this version (else a placeholder screen). */
  ready: boolean;
}

export const ROLE_INFO: Record<AppRole, RoleInfo> = {
  kiosk: { label: 'קיוסק', fiscal: true, ready: true },
  till: { label: 'קופה', fiscal: true, ready: true },
  kds: { label: 'מסך מטבח (KDS)', fiscal: false, ready: true },
  order_status_board: { label: 'מסך מוכן / לא מוכן', fiscal: false, ready: true },
  customer_display: { label: 'מסך לקוח', fiscal: false, ready: false },
};

/** The cloud's word for a role (`machines/me` deviceRole), tolerant of older / other spellings. */
export function normalizeRole(raw: unknown): AppRole | null {
  if (typeof raw !== 'string') return null;
  const r = raw.trim().toLowerCase().replace(/[-\s]/g, '_');
  if (r === 'kiosk') return 'kiosk';
  if (r === 'till' || r === 'pos' || r === 'cashier') return 'till';
  if (r === 'kds' || r === 'kitchen' || r === 'kitchen_display') return 'kds';
  if (r === 'order_status_board' || r === 'status_board' || r === 'pickup' || r === 'pickup_board' || r === 'ready_board') return 'order_status_board';
  if (r === 'customer_display') return 'customer_display';
  return null;
}

export interface RoleFacts {
  paired: boolean;
  /** `machines/me` deviceRole (null before the first read). */
  deviceRole: unknown;
  /**
   * `kiosk/sync` answered `kiosk: true` — the EFFECTIVE word (core/workMode.ts): a till by role at home,
   * whose kiosk-mode row answers `kiosk: true, homeRole: "till"`, is no kiosk until it works as one.
   */
  kioskActive: boolean;
  /** `kds/device` answered a device (station / expo / manager / pickup), if it was asked. */
  kdsDevice: { role: string; isActive?: boolean } | null;
  /** "מצב עבודה": a kiosk by role works as a till today (its till session) — it opens as the till. */
  tillSession?: boolean;
}

/** The role to open in; null = not known yet (the "waiting" screen). */
export function resolveRole(f: RoleFacts): AppRole | null {
  if (!f.paired) return null;
  if (f.kioskActive) return f.tillSession ? 'till' : 'kiosk';
  const cloud = normalizeRole(f.deviceRole);
  const kds = f.kdsDevice && f.kdsDevice.isActive !== false ? f.kdsDevice : null;
  const kdsRole: AppRole | null = kds ? (kds.role === 'pickup' ? 'order_status_board' : 'kds') : null;
  if (cloud === 'order_status_board') return 'order_status_board';
  if (cloud === 'kds') return kdsRole ?? 'kds';
  // A till made a KDS screen on the KDS page (before roles were chosen at "הוספת מכשיר").
  if (kdsRole && (cloud === 'till' || cloud === null)) return kdsRole;
  return cloud;
}

/** Whether the role may ever open a shift, issue a document or charge. Unknown = not. */
export function isFiscal(role: AppRole | null): boolean {
  return role ? ROLE_INFO[role].fiscal : false;
}

/** Whether the shell asks `kds/device` (as the till: only a screen, or a till flagged `kdsScreen`). */
export function asksKdsDevice(deviceRole: unknown, kdsScreenParam: boolean): boolean {
  const r = normalizeRole(deviceRole);
  return r === 'kds' || r === 'order_status_board' || kdsScreenParam;
}
