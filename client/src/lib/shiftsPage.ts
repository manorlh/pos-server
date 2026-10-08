/**
 * The shifts page's rules (app/dashboard/shifts): which shop and till its own filters mean
 * beside the scope bar, the tills its "קופה" filter offers, the till's register number,
 * "רק פתוחות", and closing open shifts from there — one, or all of them at once.
 *
 * The owner (07.10.2026): "במשמרת תוסיף מספר קופה / סניף / אפשר לסנן ביניהם / אפשר להציג
 * רק פתוחים", "בענן במשמרת אפשר ללחוץ על סגור משמרת למכשיר הפתוח", and "לשלוח סגירה לכולם
 * במכה במשמרות פתוחות לפי הסניף או נקודת המכירה".
 *
 * A shift is closed exactly as the devices page closes it: a remote close
 * (`POST /machines/{id}/close-shift`, components/dashboard/machines/remote-shift-close.tsx)
 * for a till that can be asked, and — for a till that is offline (dead), by the devices
 * page's rule — the administrative close from the cloud instead
 * (components/dashboard/dead-till-recovery.tsx), never sent automatically.
 *
 * Pure, imports only lib/deviceProfile (relative), so `npm test` compiles it
 * (lib/shiftsPage.test.ts).
 */

import { isDisplayDevice } from './deviceProfile';

/** Case-insensitive id match (the API's ids against the client's, as lib/entityLookup). */
function same(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a == null || b == null || a === '' || b === '') return false;
  return a === b || a.toLowerCase() === b.toLowerCase();
}

/** What these rules read of a device (a `PosMachine` of `GET /machines`). */
export interface ShiftDevice {
  id: string;
  name: string;
  shopId?: string | null;
  posNumber?: string | number | null;
  isActive?: boolean | null;
  pairingStatus?: string | null;
  shiftStatus?: string | null;
  openShiftId?: string | null;
  reportedOpenShiftId?: string | null;
  closeShiftPending?: boolean | null;
  pendingCloseSource?: string | null;
  fiscal?: boolean | null;
  deviceRole?: unknown;
}

/** What these rules read of a shift (a row of `GET /shifts`). */
export interface ShiftRow {
  id: string;
  machineId: string;
  shopId?: string | null;
  status: string;
  posNumber?: string | null;
}

/* ------------------------------------------------------------ the register number */

/** A register number as the counter reads it ("2"), or null — never 0, never text. */
function registerNumber(raw: string | number | null | undefined): number | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return n > 0 ? n : null;
}

/**
 * The shift's till's register number ("מספר קופה"): the server's `posNumber` (the till's number in
 * the shift's shop), else — a server that predates it — the till's number now, only while the
 * till is still in the shift's shop (a number belongs to one shop's run).
 */
export function shiftRegisterNumber(shift: ShiftRow, device?: ShiftDevice | null): number | null {
  const own = registerNumber(shift.posNumber);
  if (own !== null || shift.posNumber !== undefined) return own;
  if (!device || !device.shopId || !same(device.shopId, shift.shopId)) return null;
  return registerNumber(device.posNumber);
}

/* ------------------------------------------------------------ the place filters */

/** The page's own "סניף" / "קופה" filters (URL `branch`, `till`; '' = all). */
export interface ShiftPagePlace {
  branch: string;
  till: string;
}

/** What the list is filtered on, and which of the page's filters the scope bar fixes. */
export interface ShiftPlace {
  shopId: string | null;
  machineId: string | null;
  /** The scope bar fixes the shop: the page's "סניף" shows it and cannot change it. */
  shopLocked: boolean;
  /** The scope bar fixes the till: the page's "קופה" shows it and cannot change it. */
  tillLocked: boolean;
}

/**
 * The page's filters beside the scope bar — they never fight it: a shop or a till the bar
 * fixes is the page's too (shown, locked); within the bar's shop the page narrows to one of
 * its tills; with nothing in the bar the page picks a shop and a till freely. A till of
 * another shop than the one chosen (a stale link) is dropped rather than shown empty.
 */
export function shiftPlace(
  scope: { shopId: string | null; machineId: string | null },
  page: ShiftPagePlace,
  devices: readonly ShiftDevice[],
): ShiftPlace {
  const deviceOf = (id: string) => devices.find((d) => same(d.id, id));
  if (scope.machineId) {
    return {
      shopId: scope.shopId ?? deviceOf(scope.machineId)?.shopId ?? null,
      machineId: scope.machineId,
      shopLocked: true,
      tillLocked: true,
    };
  }
  const shopId = scope.shopId || page.branch || null;
  const till = page.till ? deviceOf(page.till) : undefined;
  // A till outside the shop is dropped; a till not (yet) in the list is kept when no shop is
  // chosen — the server filters on it alone and the list loads later.
  const machineId = !page.till ? null : shopId ? (till && same(till.shopId, shopId) ? page.till : null) : page.till;
  return { shopId, machineId, shopLocked: !!scope.shopId, tillLocked: false };
}

/** One till of the "קופה" filter: "קופה 2 · בר" (the shop's name too when no shop is chosen). */
export interface TillOption {
  id: string;
  name: string;
  number: number | null;
  shopId: string | null;
}

/**
 * The tills the "קופה" filter offers: the chosen shop's (every shop's when none), never a
 * screen (a KDS / the board takes no shifts), in the counter's order — by shop name when
 * every shop's are listed, then by register number (unnumbered after), then by name.
 */
export function tillOptions(
  devices: readonly ShiftDevice[],
  shopId: string | null,
  shopName: (id: string) => string = () => '',
): TillOption[] {
  return devices
    .filter((d) => !!d.shopId && !isDisplayDevice(d) && (!shopId || same(d.shopId, shopId)))
    .map((d) => ({ id: d.id, name: d.name, number: registerNumber(d.posNumber), shopId: d.shopId ?? null }))
    .sort((a, b) => {
      if (!shopId) {
        const byShop = shopName(a.shopId ?? '').localeCompare(shopName(b.shopId ?? ''), 'he-IL');
        if (byShop !== 0) return byShop;
      }
      if (a.number !== null && b.number !== null && a.number !== b.number) return a.number - b.number;
      if (a.number !== null && b.number === null) return -1;
      if (a.number === null && b.number !== null) return 1;
      return a.name.localeCompare(b.name, 'he-IL', { sensitivity: 'base' });
    });
}

/* ------------------------------------------------------------ "רק פתוחות" */

export type ShiftStatusFilter = 'all' | 'open' | 'closed';

/**
 * "רק פתוחות": one tap sets the status to open (in step with the status select); again, back to
 * all. Open and "awaiting a Z" exclude each other (a Z waits only for closed shifts), so turning
 * it on clears the latter.
 */
export function toggleOpenOnly(current: { status: ShiftStatusFilter; awaitingZ: boolean }): {
  status: ShiftStatusFilter;
  awaitingZ: boolean;
} {
  if (current.status === 'open' && !current.awaitingZ) return { status: 'all', awaitingZ: false };
  return { status: 'open', awaitingZ: false };
}

/* ------------------------------------------------------------ closing a shift */

/**
 * Whether this till has a shift the cloud can be asked to close (the devices page's rule).
 *
 * Not while a Z run is already waiting for that close: the run owns it, and a second,
 * standalone request would only race it. The row links to the run instead.
 */
export function canCloseShiftRemotely(m: ShiftDevice): boolean {
  return (
    m.isActive !== false &&
    m.pairingStatus === 'assigned' &&
    !!m.shopId &&
    (m.shiftStatus === 'open' || !!m.reportedOpenShiftId) &&
    !(m.closeShiftPending && m.pendingCloseSource === 'z_run')
  );
}

/**
 * The devices page's "dead till": unreachable (its `online`, the page's one decision), assigned,
 * not removed, not a screen. Only such a till is offered the administrative close — offering it
 * on a healthy till invites closing a shift out from under a cashier.
 */
export function deadTill(m: ShiftDevice, online: boolean): boolean {
  return !online && m.pairingStatus === 'assigned' && m.isActive !== false && !isDisplayDevice(m);
}

/** Why an open shift is not closed from here. */
export type ShiftCloseBlock = 'unknown_device' | 'screen' | 'removed' | 'unassigned' | 'z_run' | 'no_open_shift';

/** What "סגור משמרת" does for one open shift. */
export interface ShiftCloseOffer {
  /** `remote`: ask the till; `administrative`: close from the cloud (a dead till); null: nothing here. */
  action: 'remote' | 'administrative' | null;
  /** A close is already on its way ("ממתין לסגירה בקופה"). */
  pending: boolean;
  /** With no action: why. */
  blocked: ShiftCloseBlock | null;
}

/** "סגור משמרת" for [shift] on [device] (undefined: not in the user's devices list). */
export function shiftCloseOffer(shift: ShiftRow, device: ShiftDevice | undefined, online: boolean): ShiftCloseOffer {
  const none = (blocked: ShiftCloseBlock | null): ShiftCloseOffer => ({ action: null, pending: false, blocked });
  if (shift.status !== 'open') return none(null);
  if (!device) return none('unknown_device');
  if (isDisplayDevice(device)) return none('screen');
  const pending = !!device.closeShiftPending;
  if (deadTill(device, online)) return { action: 'administrative', pending, blocked: null };
  if (canCloseShiftRemotely(device)) return { action: 'remote', pending, blocked: null };
  const blocked: ShiftCloseBlock =
    device.isActive === false
      ? 'removed'
      : device.pairingStatus !== 'assigned' || !device.shopId
        ? 'unassigned'
        : device.closeShiftPending && device.pendingCloseSource === 'z_run'
          ? 'z_run'
          : 'no_open_shift';
  return { action: null, pending, blocked };
}

/** One open shift in "סגור את כל המשמרות הפתוחות". */
export interface BulkCloseItem<S extends ShiftRow, D extends ShiftDevice> {
  shift: S;
  device: D | undefined;
  offer: ShiftCloseOffer;
}

/**
 * "סגור את כל המשמרות הפתוחות": the open shifts of the page's place (shop, till, area — and
 * the scope bar) split by what is done with each, by the same rule as one shift:
 *
 *  - `remote`: asked to close, one request per device (a device has one open shift; were a
 *    second listed, the first — the newest — stands for the device);
 *  - `administrative`: offline (dead) — listed apart, each with its own "סגירה מנהלית",
 *    never sent automatically;
 *  - `blocked`: nothing from here (a Z run already waits for the close, a removed till …).
 */
export function planBulkClose<S extends ShiftRow, D extends ShiftDevice>(
  shifts: readonly S[],
  devices: readonly D[],
  online: (device: D) => boolean,
): { remote: BulkCloseItem<S, D>[]; administrative: BulkCloseItem<S, D>[]; blocked: BulkCloseItem<S, D>[] } {
  const remote: BulkCloseItem<S, D>[] = [];
  const administrative: BulkCloseItem<S, D>[] = [];
  const blocked: BulkCloseItem<S, D>[] = [];
  const asked = new Set<string>();
  for (const shift of shifts) {
    if (shift.status !== 'open') continue;
    const device = devices.find((d) => same(d.id, shift.machineId));
    const offer = shiftCloseOffer(shift, device, device ? online(device) : false);
    const item = { shift, device, offer };
    if (offer.action === 'remote') {
      const key = shift.machineId.toLowerCase();
      if (asked.has(key)) continue;
      asked.add(key);
      remote.push(item);
    } else if (offer.action === 'administrative') administrative.push(item);
    else blocked.push(item);
  }
  return { remote, administrative, blocked };
}

/** A remote close's state as the bulk dialog shows it per row. */
export type BulkCloseOutcome = 'sending' | 'sent' | 'pending' | 'closed' | 'refused';

/**
 * "נשלח" (the cloud holds the request, the till has not taken it), "ממתין לסגירה בקופה" (the till
 * took it and is closing), "נסגר", "נדחה" (refused, failed, expired or cancelled — with why);
 * nothing back yet: "שולח…".
 */
export function bulkCloseOutcome(state: { status?: string | null; failed?: boolean } | null | undefined): BulkCloseOutcome {
  if (!state) return 'sending';
  if (state.failed) return 'refused';
  switch (state.status) {
    case 'waiting_close':
      return 'sent';
    case 'closing':
      return 'pending';
    case 'completed':
      return 'closed';
    case 'failed':
    case 'expired':
    case 'cancelled':
      return 'refused';
    default:
      return 'sending';
  }
}
