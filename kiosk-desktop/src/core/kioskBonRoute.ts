/**
 * "בון מטבח במדפסת הקיוסק" — where a kiosk's kitchen bon goes (`printing.bonOnKiosk`: true / false / "auto", auto
 * by default — the owner 17.10.2026: "אותה מדפסת יכולה להיות הכל"; docs/SPEC_KIOSK.md §29.1). The port of
 * pos-android domain/KioskOrders.kt `KioskBon.route` / `ownShare` / `isOwnPrinter`, pinned by the
 * shared cases test/fixtures/kiosk_bon_route.json (the same bytes as pos-android's).
 *
 * auto: the kitchen printers if any take the kiosk's orders, else the KDS if it takes the order, else the kiosk's own
 * printer (after the receipt / pickup slip). true: as auto, and the routing's share for "this till" prints on the kiosk.
 * false (a level chose it): never on the kiosk.
 *
 * Before its kitchen queue (main/kitchen) the Windows kiosk reached no kitchen printer: `windowsBonRoute` is that
 * route (every page on its own printer) — still what it does while it has never had the printers' settings.
 * `windowsBonRouteFor` is the Android kiosk's route over the settings it now pulls.
 */

export type KioskBonRoute = 'single' | 'kitchen' | 'own' | 'none';

/** `printing.bonOnKiosk`: on / off as a level chose it, or "auto" (the default). */
export type BonOnKioskSetting = boolean | 'auto';

/** The setting as the config has it: true / false as chosen, anything else (missing, "auto") auto. */
export function bonOnKioskSetting(v: unknown): BonOnKioskSetting {
  return v === true || v === false ? v : 'auto';
}

export interface KioskBonFacts {
  /** One named bon printer (`bonMode: "single"` with `bonPrinterId`). */
  single: boolean;
  /** That printer is the kiosk's own. */
  singleOwn: boolean;
  bonOnKiosk: BonOnKioskSetting;
  /** Kitchen printers that may take the kiosk's orders. */
  kitchenPrinters: number;
  /** The KDS takes the order (a KDS kiosk in a shop that runs it). */
  kds?: boolean;
  /** The kiosk has a printer of its own that would take it. */
  ownPrinter: boolean;
}

/** The kiosk's own printer may take the bon: on, or auto when the KDS does not take the order. */
export function kioskOwnMayPrint(setting: BonOnKioskSetting, kds: boolean): boolean {
  return setting === true || (setting === 'auto' && !kds);
}

export function kioskBonRoute(f: KioskBonFacts): KioskBonRoute {
  const own = kioskOwnMayPrint(f.bonOnKiosk, f.kds === true);
  if (f.single && (!f.singleOwn || own)) return 'single';
  if (f.kitchenPrinters > 0) return 'kitchen';
  if (!own) return 'none';
  if (f.ownPrinter) return 'own';
  // On, and nothing of its own to print on: the routing, which says no printer takes it (a staff alert).
  // Auto: no printer anywhere — no bon, no alert on every order.
  return f.bonOnKiosk === true ? 'kitchen' : 'none';
}

/** The routing's share for "this till" (lines routed nowhere, the till copy) may print on the kiosk itself. */
export function kioskBonOwnShare(route: KioskBonRoute, bonOnKiosk: BonOnKioskSetting): boolean {
  return route === 'kitchen' && bonOnKiosk === true;
}

/** A printer that is the kiosk's own: its USB port or head, a cloud printer it hosts, a receipt printer set to it alone. */
export function isOwnPrinter(p: { type: string | null; purpose: string | null; isHost: boolean; scope: string | null }): boolean {
  const t = (p.type ?? '').trim().toLowerCase();
  return t === 'usb' || t === 'till' || (t === 'cloud' && p.isHost) || ((p.purpose ?? '').trim().toLowerCase() === 'receipt' && (p.scope ?? '').trim().toLowerCase() === 'machine');
}

/** The Windows kiosk's bon: everything it prints is on its own printer. */
export function windowsBonRoute(printing: KioskPrintingFacts, kds = false): KioskBonRoute {
  return kioskBonRoute({
    single: printing.bonMode === 'single' && !!printing.bonPrinterId,
    singleOwn: true,
    bonOnKiosk: bonOnKioskSetting(printing.bonOnKiosk),
    kitchenPrinters: 0,
    kds,
    ownPrinter: true,
  });
}

/** The kiosk's `printing` as the bon route reads it. */
export interface KioskPrintingFacts {
  bonMode?: string | null;
  bonPrinterId?: string | null;
  bonOnKiosk?: boolean | string | null;
}

/**
 * The Windows kiosk's bon now that it reaches the shop's kitchen printers (main/kitchen): the Android kiosk's
 * `KioskBonService.bonRoute` over the printers' settings — the kitchen printers that may take its orders, and whether
 * the one bon printer it names is its own (`namesOwnPrinter`). Settings never pulled (a cloud that predates them, a
 * kiosk never online): as before ([windowsBonRoute]). Its own printer is its receipt printer: always there.
 */
export function windowsBonRouteFor(
  printing: KioskPrintingFacts,
  config: { printers: ReadonlyArray<{ id: string; type: string | null; purpose: string | null; isHost: boolean; scope: string | null; inScope: boolean }> } | null,
  kds = false,
): KioskBonRoute {
  if (!config) return windowsBonRoute(printing, kds);
  const single = printing.bonMode === 'single' && !!printing.bonPrinterId;
  const named = single ? config.printers.find((p) => p.id === printing.bonPrinterId) : undefined;
  return kioskBonRoute({
    single,
    singleOwn: !!named && isOwnPrinter(named),
    bonOnKiosk: bonOnKioskSetting(printing.bonOnKiosk),
    kitchenPrinters: config.printers.filter((p) => p.inScope && (p.purpose ?? 'kitchen') !== 'receipt').length,
    kds,
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

/** Said on an order with no bon under "auto": no kitchen printer, no KDS for it, and no printer of the kiosk's own. */
export const BON_NO_PRINTER = 'אין בון — אין מדפסת מטבח, KDS או מדפסת בקיוסק';

/** Why an order of route "none" has no bon. */
export function bonNoneDetail(printing: KioskPrintingFacts): string {
  return bonOnKioskSetting(printing.bonOnKiosk) === false ? BON_NOT_ON_KIOSK : BON_NO_PRINTER;
}
