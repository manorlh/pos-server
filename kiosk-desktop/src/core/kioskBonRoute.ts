/**
 * "בון מטבח במדפסת הקיוסק" — where a kiosk's kitchen bon goes (`printing.bonOnKiosk`, off by default;
 * docs/SPEC_KIOSK.md §5, the owner 07.10.2026: "אין צורך שידפיס את בון של המטבח"). The port of
 * pos-android domain/KioskOrders.kt `KioskBon.route` / `ownShare` / `isOwnPrinter`, pinned by the
 * shared cases test/fixtures/kiosk_bon_route.json (the same bytes as pos-android's).
 *
 * Before its kitchen queue (main/kitchen) the Windows kiosk reached no kitchen printer: `windowsBonRoute` is that
 * route (every page on its own printer) — still what it does while it has never had the printers' settings.
 * `windowsBonRouteFor` is the Android kiosk's route over the settings it now pulls.
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

/**
 * The Windows kiosk's bon now that it reaches the shop's kitchen printers (main/kitchen): the Android kiosk's
 * `KioskBonService.bonRoute` over the printers' settings — the kitchen printers that may take its orders, and whether
 * the one bon printer it names is its own (`namesOwnPrinter`). Settings never pulled (a cloud that predates them, a
 * kiosk never online): as before ([windowsBonRoute]). Its own printer is its receipt printer: always there.
 */
export function windowsBonRouteFor(
  printing: { bonMode?: string | null; bonPrinterId?: string | null; bonOnKiosk?: boolean | null },
  config: { printers: ReadonlyArray<{ id: string; type: string | null; purpose: string | null; isHost: boolean; scope: string | null; inScope: boolean }> } | null,
): KioskBonRoute {
  if (!config) return windowsBonRoute(printing);
  const single = printing.bonMode === 'single' && !!printing.bonPrinterId;
  const named = single ? config.printers.find((p) => p.id === printing.bonPrinterId) : undefined;
  return kioskBonRoute({
    single,
    singleOwn: !!named && isOwnPrinter(named),
    bonOnKiosk: printing.bonOnKiosk === true,
    kitchenPrinters: config.printers.filter((p) => p.inScope && (p.purpose ?? 'kitchen') !== 'receipt').length,
    ownPrinter: true,
  });
}

/** The bon goes through the kitchen queue (main/kitchen): the routing, or a named bon printer that is not the kiosk's own. */
export function bonViaKitchen(route: KioskBonRoute, printing: { bonMode?: string | null; bonPrinterId?: string | null }, config: { printers: ReadonlyArray<{ id: string; type: string | null; purpose: string | null; isHost: boolean; scope: string | null }> } | null): boolean {
  if (!config) return false;
  if (route === 'kitchen') return true;
  if (route !== 'single') return false;
  const named = config.printers.find((p) => p.id === printing.bonPrinterId);
  return !named || !isOwnPrinter(named);
}

/** Said on an order whose bon the kiosk did not print by this setting. */
export const BON_NOT_ON_KIOSK = 'לא מודפס בקיוסק — "בון מטבח במדפסת הקיוסק" כבוי';
