/**
 * What a kiosk sells at all — ONE rule for the Windows kiosk (kiosk-desktop main/kiosk/catalog.ts) and the browser
 * kiosk (lib/kioskWebCatalog.ts), the Android kiosk's (pos-android domain/KioskCatalogView.kt `build`): a product is
 * on a kiosk only when it is
 *
 *  - not deleted, not delisted (`inStock`), not "קופות בלבד" (`salesChannel` pos_only), not "מחייב אישור מנהל
 *    במכירה" — nobody at a kiosk types a manager's code (its category's flag: lib/restrictedItems.ts, applied where
 *    the category rows are at hand);
 *  - on this till's list when the machine catalog is "selected" — unless a menu places it ("גובר על הכל", SPEC_MENUS
 *    §3.3: a menu beats the machine's own list);
 *  - not one nobody can order at a kiosk (`neverOnKiosk`): the general item, an open-price product and a weighed one.
 *
 * Pure; no imports (the node tests compile it on its own).
 */

type Row = Record<string, unknown>;

/**
 * Products a customer can never order at a kiosk: the general item (a price and a name keyed by a person), an
 * open-price product (a price keyed) and a weighed product (a weight put on a scale). Left out of the screens, of a
 * menu's products, of what is kept for an open basket and of the pictures the kiosk keeps — whatever a menu lists,
 * whatever the machine's list says (KioskCatalogView.build: `!isGeneral && !isOpenPrice && !isWeighed`).
 */
export function neverOnKiosk(p: Row): boolean {
  return p.isGeneral === true || p.isOpenPrice === true || p.isWeighed === true;
}

/**
 * Is this product sold on a kiosk at all. `menuActive`: a menu places it, and a menu beats the machine's own
 * list ("גובר על הכל", SPEC_MENUS §3.3) — everything else (delisted, "קופות בלבד", "מחייב אישור מנהל", the
 * products no kiosk sells) stays.
 */
export function sellableOnKiosk(p: Row, machineCatalogMode: string | null | undefined, menuActive = false): boolean {
  if (p.deleted === true) return false;
  if (p.inStock === false) return false;
  if (p.salesChannel === 'pos_only') return false;
  // "מחייב אישור מנהל במכירה": nobody at a kiosk can type a manager's code (its category: the catalog builders).
  if (p.requiresManagerApproval === true) return false;
  // The general item, open-price and weighed products: a customer can key no price and weigh nothing.
  if (neverOnKiosk(p)) return false;
  if (!menuActive && machineCatalogMode === 'selected' && p.inMachineCatalog === false) return false;
  return true;
}
