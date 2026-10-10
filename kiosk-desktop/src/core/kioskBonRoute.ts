/**
 * "בון מטבח במדפסת הקיוסק" — where a kiosk's kitchen bon goes (`printing.bonOnKiosk`, off by default;
 * docs/SPEC_KIOSK.md §5, the owner 07.10.2026: "אין צורך שידפיס את בון של המטבח"). The port of
 * pos-android domain/KioskOrders.kt `KioskBon.route` / `ownShare` / `isOwnPrinter`, pinned by the
 * shared cases test/fixtures/kiosk_bon_route.json (the same bytes as pos-android's).
 *
 * The Windows kiosk reaches no kitchen printer: every page it prints is on its own printer. So for
 * it `kitchenPrinters` is 0, `ownPrinter` true and a named bon printer is its own (`singleOwn`) —
 * off, it prints no bon at all; on, the bon prints as before.
 */

export type KioskBonRoute = 'single' | 'kitchen' | 'own' | 'none';

export interface KioskBonFacts {
  /** One named bon printer (`bonMode: "single"` with `bonPrinterId`). */
  single: boolean;
  /** That printer is the kiosk's own. */
  singleOwn: boolean;
  bonOnKiosk: boolean;
  /** Kitchen printers that may take the kiosk's orders. */
  kitchenPrinters: number;
  /** The kiosk has a printer of its own that would take it. */
  ownPrinter: boolean;
}

export function kioskBonRoute(f: KioskBonFacts): KioskBonRoute {
  if (f.single && (!f.singleOwn || f.bonOnKiosk)) return 'single';
  if (f.kitchenPrinters > 0) return 'kitchen';
  if (!f.bonOnKiosk) return 'none';
  if (f.ownPrinter) return 'own';
  // On, and nothing of its own to print on: the routing, which says no printer takes it.
  return 'kitchen';
}

/** The routing's share for "this till" (lines routed nowhere, the till copy) may print on the kiosk itself. */
export function kioskBonOwnShare(route: KioskBonRoute, bonOnKiosk: boolean): boolean {
  return route === 'kitchen' && bonOnKiosk;
}

/** A printer that is the kiosk's own: its USB port or head, a cloud printer it hosts, a receipt printer set to it alone. */
export function isOwnPrinter(p: { type: string | null; purpose: string | null; isHost: boolean; scope: string | null }): boolean {
  const t = (p.type ?? '').trim().toLowerCase();
  return t === 'usb' || t === 'till' || (t === 'cloud' && p.isHost) || ((p.purpose ?? '').trim().toLowerCase() === 'receipt' && (p.scope ?? '').trim().toLowerCase() === 'machine');
}

/** The Windows kiosk's bon: everything it prints is on its own printer. */
export function windowsBonRoute(printing: { bonMode?: string | null; bonPrinterId?: string | null; bonOnKiosk?: boolean | null }): KioskBonRoute {
  return kioskBonRoute({
    single: printing.bonMode === 'single' && !!printing.bonPrinterId,
    singleOwn: true,
    bonOnKiosk: printing.bonOnKiosk === true,
    kitchenPrinters: 0,
    ownPrinter: true,
  });
}

/** Said on an order whose bon the kiosk did not print by this setting. */
export const BON_NOT_ON_KIOSK = 'לא מודפס בקיוסק — "בון מטבח במדפסת הקיוסק" כבוי';
