/**
 * The kiosk's catalog, from the till catalog the cloud sends (GET /sync/{m}/catalog) — the same
 * rules the Android kiosk applies (pos-android domain/KioskCatalogView.kt, KioskPresentation.kt):
 *
 *  - only what a kiosk sells: not delisted (`inStock`), not "קופות בלבד" (`salesChannel` pos_only),
 *    not "מחייב אישור מנהל במכירה" (itself or a category above it — client/src/lib/restrictedItems.ts;
 *    such a category disappears with everything beneath it: nobody at a kiosk types a manager's code),
 *    on this till's list when the machine catalog is "selected", in an active category;
 *  - never the general item, an open-price product or a weighed one (client lib/kioskSellable.ts — one rule for both
 *    TypeScript kiosks, the Android kiosk's KioskCatalogView.build: a customer keys no price and weighs nothing);
 *  - "אזל" = not available (`isAvailable` false);
 *  - modifier groups by the menu links (a product's own list, [] = none, else its category's), with
 *    the rules that price them (free choices, quantities, "מעט / הרבה / בצד") and the meals' slots —
 *    read by the shared money rules (client/src/lib/kioskMoney.ts, the Android till's, ported once);
 *  - quick notes from the menu (all ⊕ category ⊕ product);
 *  - pictures ONLY from the local media store (a variant sized for the card, a larger one for the
 *    sheet) — never a network URL on the screens.
 *
 * "תפריטים" (client/src/lib/kioskMenus.ts, docs/SPEC_MENUS.md): the `catalogMenus` block of the pull decides, by this
 * kiosk's own clock — offline too — which menu is active ("היכן": kiosk / both); then ITS products, categories, order and
 * prices are the kiosk's, over the machine's own list; none active: the fallback ("הקטלוג המלא" / "לא למכור"). Blocks and
 * "אזל" stay in force; what a menu does not place is kept apart (`held`) for an open basket and a meal's components.
 * The Android kiosk's rules (CatalogMenus.kt `present`), pinned by catalog_menus_golden.json (test/kioskMenus.test.ts).
 *
 * The kiosk's own order / hidden / featured rules are applied by the screens with the shared
 * `kioskCatalogView` (client/src/lib/kioskConfig.ts), exactly as the dashboard preview does.
 */

import { mealsOf, menuGroupIdsFor, menuGroupOf, menuNotesFor, parentOfCategories, type MealSlot, type MenuNotes, type MenuGroup } from '@dash-lib/kioskMoney';
import { hasMenus, layMenu, menuInputsOf, type KioskMenuState } from '@dash-lib/kioskMenus';
import type { MenuBlock } from '@dash-lib/menuSchedule';
import { upsellRulesOf, type KioskUpsellRule } from '@dash-lib/kioskUpsellRules';
import { addonOnlyRow, sellableOnKiosk } from '@dash-lib/kioskSellable';
import { noteImagesOf, optionImagesOf } from '@dash-lib/kioskItemFlow';
import { decideSoldOut, itemBlocksOf, kioskSoldOut, rowAvailable, type SaleState, type SoldOutState } from '@dash-lib/kioskSoldOut';
import { isRestrictedProduct, restrictedCategoryIds, type RestrictedCategoryRow } from '@dash-lib/restrictedItems';
import type { MediaRefIn } from '../../core/mediaPlan';
import { ofShekels } from '../../core/money';

export const ALLERGEN_HE: Record<string, string> = {
  gluten: 'גלוטן',
  milk: 'חלב',
  nuts: 'אגוזים',
  eggs: 'ביצים',
  peanuts: 'בוטנים',
  fish: 'דגים',
  soy: 'סויה',
  sesame: 'שומשום',
  celery: 'סלרי',
  mustard: 'חרדל',
  sulphites: 'סולפיטים',
  lupin: 'תורמוס',
  molluscs: 'רכיכות',
  crustaceans: 'סרטנים',
};

const DIETARY = ['vegan', 'vegetarian', 'dairy', 'meat', 'gluten_free', 'spicy'] as const;

export interface KCategory {
  id: string;
  name: string;
  /** The catalog's own picture (local), or null. */
  imageUrl: string | null;
  /** The catalog's colour (`categories.color`, "צבע ותמונה למחלקה"): the initial of a category with no picture. */
  color?: string | null;
}

export interface KOption {
  id: string;
  name: string;
  /** Shekels (display). */
  price: number;
  /** The exact price (lib/kioskMoney.ts). */
  priceAgorot: number;
  isDefault: boolean;
  /** The most of this option in one dish; null: only the group's max. */
  maxQty: number | null;
  /** Its picture (local; its own, else its linked product's); null: none. */
  imageUrl?: string | null;
}

export interface KGroup {
  id: string;
  name: string;
  kind: 'choice' | 'addon' | 'removal';
  min: number;
  max: number | null;
  /** This many units of choice are free — the cheapest ones. */
  freeCount: number;
  allowQuantity: boolean;
  allowPre: boolean;
  options: KOption[];
}

export interface KProduct {
  id: string;
  name: string;
  /** Shekels (display); the main process prices the document from its own catalog, never this. */
  price: number;
  /** The exact price, agorot — the active menu's while one prices it. */
  priceAgorot: number;
  /** The catalog's own price when a menu set `priceAgorot`; absent: no menu is on it (client lib/kioskMenus.ts `basePriceOf`). */
  catalogPriceAgorot?: number;
  /**
   * The active menu that placed it ("תפריטים"), with where its price came from: `menu` / `catalog`. The kiosk's catalog: its own
   * menus (client lib/kioskMenus.ts). The till's: set while a till menu (core/till/menus.ts) is active — copied onto the sold line
   * (`menuId` / `menuName` / `priceSource`). Absent with no menu active.
   */
  menuId?: string | null;
  menuName?: string | null;
  priceSource?: 'menu' | 'catalog';
  /** "לא מקבל הנחות": no promotion discounts it (it still counts towards a spend threshold). */
  noDiscount: boolean;
  imageUrl: string | null;
  imageLarge: string | null;
  soldOut: boolean;
  available: boolean;
  /** A block's own look on the kiosks ("hide" / "grey"; null: `soldOutMode`) — `kioskCatalogView`. */
  kioskDisplay?: 'hide' | 'grey' | null;
  description: string | null;
  categoryId: string | null;
  dietaryTags: Array<(typeof DIETARY)[number]>;
  allergens: string[];
  sku: string | null;
  /** The product's barcode, for a scan (core/kioskScan.ts: barcode, then SKU, as the till). */
  barcode?: string | null;
  trackStock: boolean;
  /** A meal (menu.meals): its window opens, never the card's quick "+". */
  meal: boolean;
  /**
   * The till's catalog only (`buildKioskCatalog` channel `till`): "מחייב אישור מנהל במכירה" (itself or its
   * category) — the till sells it to a user who may (SELL_RESTRICTED_ITEMS), never a kiosk.
   */
  restricted?: boolean;
  /** The till's catalog only: the sale state by the shared rules (lib/kioskSoldOut.ts decideSoldOut) with this till's clock and stock. */
  sale?: { state: SoldOutState; reason: string | null; note: string | null; untilMs: number | null };
  /** The till's catalog only: the product IS a voucher (the cloud's `voucherId`) — credited from its receipt only. */
  voucherId?: string | null;
}

export interface KioskCatalogData {
  categories: KCategory[];
  products: KProduct[];
  /** "תפריטים": the menu active now — its order for the screens (`withMenuOrder`), its name for the title. */
  menu: KioskMenuState;
  /**
   * What the kiosk sells by its catalog but the active menu does not place (or "לא למכור" holds back): not on the
   * screens, kept for an open basket's lines and a meal's components (CatalogMenus.present: not on this till).
   */
  held: KProduct[];
  groups: Record<string, KGroup[]>;
  /** The meals' slots by meal product id (menu.meals). */
  meals: Record<string, MealSlot[]>;
  quickNotes: Record<string, string[]>;
  /** "הערה עם תמונה": a note chip's picture (local) by its text — an image tile, chosen like an option. */
  noteImages: Record<string, string>;
  /** Upsell candidates by trigger: product ids offered for a product, a category, or any order. */
  upsells: Array<{ triggerType: string; triggerIds: string[]; productIds: string[]; categoryIds: string[]; prompt: string | null }>;
  /** "הגדלת מכירה": the menu's rules as the Android kiosk reads them (`upsells` + `kioskUpsells`, lib/kioskUpsellRules.ts). */
  upsellRules: KioskUpsellRule[];
}

type Row = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);

/** A catalog group as the shared money rules read it (kioskMoney.ts MenuGroup). */
export function moneyGroupOf(g: KGroup): MenuGroup {
  return {
    id: g.id,
    name: g.name,
    kind: g.kind,
    minSelect: g.min,
    maxSelect: g.max,
    freeCount: g.freeCount,
    allowQuantity: g.allowQuantity,
    allowPre: g.allowPre,
    options: g.options.map((o) => ({ id: o.id, name: o.name, priceAgorot: o.priceAgorot, isDefault: o.isDefault, maxQty: o.maxQty })),
  };
}

/** The restricted categories of a catalog payload ("מחייב אישור מנהל במכירה", the tree resolved). */
function restrictedOf(categories: Row[]): Set<string> {
  return restrictedCategoryIds(categories.filter((c) => c.deleted !== true).map((c) => c as unknown as RestrictedCategoryRow));
}

/** A product row restricted by its own flag or its category's. */
function restrictedRow(p: Row, restricted: ReadonlySet<string>): boolean {
  return isRestrictedProduct(
    { categoryId: typeof p.categoryId === 'string' ? p.categoryId : null, requiresManagerApproval: p.requiresManagerApproval === true },
    restricted,
  );
}

/** Is this product sold on a kiosk at all — the one rule of client lib/kioskSellable.ts, shared with the browser kiosk. */
export { sellableOnKiosk };

/**
 * Is this product on a till's sell screen: not delisted, not "קיוסק בלבד" (`salesChannel` kiosk_only — the till hides
 * it from its sell screen, pos-server models/product.py), on this till's list when its catalog is "selected".
 * A manager-approval item is on it (flagged `restricted`; the user's rights decide).
 */
export function sellableOnTill(p: Row, machineCatalogMode: string | null | undefined): boolean {
  if (p.deleted === true) return false;
  if (p.inStock === false) return false;
  if (p.salesChannel === 'kiosk_only') return false;
  if (machineCatalogMode === 'selected' && p.inMachineCatalog === false) return false;
  return true;
}

export interface CatalogOptions {
  /** `kiosk` (default): what the self-order kiosk sells. `till`: what a till sells (sellableOnTill). */
  channel?: 'kiosk' | 'till';
}

export function buildKioskCatalog(
  catalog: { products: Row[]; categories: Row[]; menu: Row | null; machineCatalog: { mode?: string } | null; catalogMenus?: MenuBlock | null },
  settings: Record<string, unknown>,
  localImage: (url: string | null, size: 'card' | 'large') => string | null,
  /** This kiosk's stock levels and clock ("אזל" / "חסום"); absent: none here, now. */
  sale: SaleState = { stock: {}, nowMs: Date.now() },
  options: CatalogOptions = {},
): KioskCatalogData {
  const till = options.channel === 'till';
  const mode = catalog.machineCatalog?.mode ?? 'all';
  const restricted = restrictedOf(catalog.categories);
  // A kiosk never shows what needs a manager's code; a till shows it, flagged, to the user who may sell it.
  const activeCats = catalog.categories.filter((c) => c.isActive !== false && c.deleted !== true && (till || !restricted.has(String(c.id))));
  const catIds = new Set(activeCats.map((c) => String(c.id)));
  // "תפריטים": the menu active on this kiosk's own clock, laid over what the shop lists (client lib/kioskMenus.ts).
  // The till lays its own menus (core/till/menus.ts, the surface "pos") over what this builds: none here for it.
  const lay = layMenu(till ? null : catalog.catalogMenus, sale.nowMs, menuInputsOf(catalog.products));
  const menuOn = lay.state.mode === 'menu';
  const menuCats = menuOn ? new Set(lay.state.categories ?? []) : null;
  const menuRank = new Map((lay.state.categoryOrder ?? []).map((id, i) => [id, i]));
  const order = (list: unknown): string[] => (Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []);
  const catOrder = order(settings.categoryOrder);
  const prodOrder = order(settings.productOrder);
  const rank = (ids: string[], id: string) => {
    const i = ids.indexOf(id);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  const categories: KCategory[] = activeCats
    // A menu shows its own categories only, in its order; "לא למכור": none.
    .filter((c) => lay.state.mode !== 'none' && (!menuCats || menuCats.has(String(c.id))))
    .slice()
    .sort(
      (a, b) =>
        (menuOn ? (menuRank.get(String(a.id)) ?? 0) - (menuRank.get(String(b.id)) ?? 0) : 0) ||
        rank(catOrder, String(a.id)) - rank(catOrder, String(b.id)) ||
        (num(a.sortOrder) ?? 0) - (num(b.sortOrder) ?? 0) ||
        String(a.name ?? '').localeCompare(String(b.name ?? ''), 'he'),
    )
    .map((c) => ({ id: String(c.id), name: String(c.name ?? ''), imageUrl: localImage(str(c.imageUrl), 'card'), color: str(c.color) }));

  const mealIds = new Set(Object.keys(((catalog.menu ?? {}) as { meals?: Record<string, unknown> }).meals ?? {}));
  const inActiveCategory = (p: Row) => typeof p.categoryId === 'string' && catIds.has(p.categoryId);
  /** What this channel sells by the catalog's own rules (no menu): its list, its channel, an active category. */
  const byCatalog = (p: Row) => (till ? sellableOnTill(p, mode) : sellableOnKiosk(p, mode) && !restrictedRow(p, restricted)) && inActiveCategory(p);
  /** What an active menu places: over the machine's list; the channel, the manager's approval and delisting stay. */
  const byMenu = (p: Row) => !!lay.placed?.has(String(p.id)) && sellableOnKiosk(p, mode, true) && inActiveCategory(p) && !restrictedRow(p, restricted);
  const ordered = catalog.products
    .slice()
    .sort((a, b) => rank(prodOrder, String(a.id)) - rank(prodOrder, String(b.id)) || String(a.name ?? '').localeCompare(String(b.name ?? ''), 'he'));
  // "תוספת בלבד" (lib/kioskSellable.ts addonOnlyRow): never on the kiosk's screens, whatever a menu places — kept below.
  // The till's sell screen is the till's own (its menus are laid by core/till/menus.ts over this list).
  const onScreens = (p: Row) => till || !addonOnlyRow(p);
  const onKiosk = lay.state.mode === 'menu' ? ordered.filter((p) => byMenu(p) && onScreens(p)) : lay.state.mode === 'none' ? [] : ordered.filter((p) => byCatalog(p) && onScreens(p));
  const onKioskIds = new Set(onKiosk.map((p) => String(p.id)));
  // Held: what the catalog sells but the screens do not show — an open basket's lines and a meal's components (an add-on
  // only among them, under any menu mode).
  const keptRows = ordered.filter((p) => byCatalog(p) && !onKioskIds.has(String(p.id)) && (lay.state.mode !== 'catalog' || addonOnlyRow(p)));
  const productOf = (p: Row): KProduct => {
    const url = str(p.imageUrl);
    // "אזל" / "חסום" as the Android kiosk (lib/kioskSoldOut.ts, KioskCatalogView.soldOut): the row's lock,
    // delisted, the stock it tracks here, a block in force by the kiosk's clock.
    const available = rowAvailable(p);
    const tags = Array.isArray(p.dietaryTags) ? new Set(p.dietaryTags as string[]) : new Set<string>();
    const place = lay.state.mode === 'menu' ? lay.placed?.get(String(p.id)) : undefined;
    const catalogAgorot = ofShekels(num(p.price) ?? 0);
    const priceAgorot = place ? place.priceAgorot : catalogAgorot;
    return {
      id: String(p.id),
      name: String(p.name ?? ''),
      price: priceAgorot / 100,
      priceAgorot,
      ...(place ? { catalogPriceAgorot: catalogAgorot, menuId: lay.state.menuId, menuName: lay.state.menuName, priceSource: place.source } : {}),
      noDiscount: p.noDiscount === true,
      imageUrl: localImage(url, 'card'),
      imageLarge: localImage(url, 'large'),
      soldOut: kioskSoldOut(p, sale.stock[String(p.id)], sale.nowMs),
      available,
      kioskDisplay: p.kioskDisplay === 'hide' ? 'hide' : p.kioskDisplay === 'grey' ? 'grey' : null,
      description: str(p.description),
      categoryId: (p.categoryId as string) ?? null,
      dietaryTags: DIETARY.filter((t) => tags.has(t)),
      allergens: Array.isArray(p.allergens) ? (p.allergens as string[]).map((a) => ALLERGEN_HE[a] ?? a) : [],
      sku: str(p.sku),
      barcode: str(p.barcode),
      trackStock: p.trackStock === true,
      meal: mealIds.has(String(p.id)),
      ...(till ? { restricted: restrictedRow(p, restricted), sale: tillSaleState(p, sale, catalogSettings(settings)) } : {}),
      ...(till && str(p.voucherId) ? { voucherId: str(p.voucherId) } : {}),
    };
  };
  const products: KProduct[] = onKiosk.map(productOf);
  const held: KProduct[] = keptRows.map(productOf);

  const menu = catalog.menu ?? {};
  const groupsById = new Map<string, KGroup>();
  const optionImages = optionImagesOf(menu.groups);
  for (const row of Array.isArray(menu.groups) ? (menu.groups as Row[]) : []) {
    const g = menuGroupOf(row);
    if (!g) continue;
    groupsById.set(g.id, {
      id: g.id,
      name: g.name,
      kind: g.kind,
      min: g.minSelect,
      max: g.maxSelect,
      freeCount: g.freeCount,
      allowQuantity: g.allowQuantity,
      allowPre: g.allowPre,
      options: g.options.map((o) => ({
        id: o.id, name: o.name, price: o.priceAgorot / 100, priceAgorot: o.priceAgorot, isDefault: o.isDefault, maxQty: o.maxQty,
        imageUrl: localImage(optionImages[o.id] ?? null, 'card'),
      })),
    });
  }
  const noteImages: Record<string, string> = {};
  for (const [text, pic] of Object.entries(noteImagesOf(menu.notes))) {
    const local = localImage(pic, 'card');
    if (local) noteImages[text] = local;
  }
  const links = (menu.links ?? {}) as { categories?: Record<string, string[]>; products?: Record<string, string[]> };
  const parentOf = parentOfCategories(catalog.categories.filter((c) => c.deleted !== true));
  const notes = (menu.notes ?? {}) as MenuNotes;
  const groups: Record<string, KGroup[]> = {};
  const quickNotes: Record<string, string[]> = {};
  // The groups and notes of what is held too: a line already in the basket is priced and checked by them.
  for (const p of [...products, ...held]) {
    // Menu.groupsFor: the product's own list, else the nearest category up its tree that has one.
    const ids = menuGroupIdsFor(links, [p.id], p.categoryId, parentOf);
    const list = ids.map((id) => groupsById.get(id)).filter((g): g is KGroup => !!g && g.options.length > 0);
    if (list.length > 0) groups[p.id] = list;
    // Menu.notesFor: its own chips, else the nearest category's up the tree; then the shop's for every dish.
    const q = menuNotesFor(notes, [p.id], p.categoryId, parentOf);
    if (q.length > 0) quickNotes[p.id] = q;
  }
  const upsells = (Array.isArray(menu.upsells) ? (menu.upsells as Row[]) : []).map((u) => {
    const options = Array.isArray(u.options) ? (u.options as Row[]) : [];
    return {
      triggerType: String(u.triggerType ?? 'order'),
      triggerIds: order(u.triggerIds),
      productIds: [...options.filter((o) => o.type === 'product' && typeof o.id === 'string').map((o) => String(o.id)), ...(typeof u.productId === 'string' ? [u.productId] : [])],
      categoryIds: options.filter((o) => o.type === 'category' && typeof o.id === 'string').map((o) => String(o.id)),
      prompt: str(u.prompt) ?? str(u.message),
    };
  });
  // The meals of what the kiosk sells, each slot's choices among what it sells (a component the menu does not
  // place is still sold by the catalog: it stays a choice, as on the Android kiosk).
  const sold = new Set([...products, ...held].map((p) => p.id));
  const meals: Record<string, MealSlot[]> = {};
  for (const [id, slots] of Object.entries(mealsOf(menu))) {
    if (!onKioskIds.has(id)) continue;
    const usable = slots.map((s) => ({ ...s, choices: s.choices.filter((c) => sold.has(c.productId)) })).filter((s) => s.choices.length > 0);
    if (usable.length > 0) meals[id] = usable;
  }
  return { categories, products, menu: lay.state, held, groups, meals, quickNotes, noteImages, upsells, upsellRules: upsellRulesOf(menu) };
}

/** `autoSoldOutAtZero`: on unless a layer turns it off (SoldOutRules.autoOn). */
function catalogSettings(settings: Record<string, unknown>): { auto: unknown } {
  return { auto: settings.autoSoldOutAtZero };
}

/**
 * A till product's sale state NOW — the Android till's `SoldOutRules.decide` (lib/kioskSoldOut.ts): the blocks the cloud sent
 * for this device with the till's own clock, and its stock under "אזל אוטומטי". The row's own lock (`lockAvailable` /
 * `isAvailable` false) is a separate refusal the engine makes ("אינו זמין למכירה").
 */
export function tillSaleState(p: Row, sale: SaleState, o: { auto: unknown }): NonNullable<KProduct['sale']> {
  const d = decideSoldOut(itemBlocksOf(p.blocks), sale.nowMs, { setting: o.auto, trackStock: p.trackStock === true, stock: sale.stock[String(p.id)] ?? null });
  return { state: d.state, reason: d.reason, note: d.block?.note?.trim() || null, untilMs: d.untilMs };
}

/** The pictures the kiosk keeps for its catalog (not of what it hides or does not sell). */
export function catalogMedia(
  catalog: { products: Row[]; categories: Row[]; machineCatalog: { mode?: string } | null; catalogMenus?: MenuBlock | null; menu?: Row | null },
  hidden: { categories: string[]; products: string[] },
): MediaRefIn[] {
  // A kiosk with menus keeps the pictures of whatever a menu may place — over the machine's list — so that a menu
  // starting offline (by the clock) finds its pictures on the disk.
  const mode = hasMenus(catalog.catalogMenus) ? 'all' : (catalog.machineCatalog?.mode ?? 'all');
  const restricted = restrictedOf(catalog.categories);
  const out: MediaRefIn[] = [];
  const http = (u: unknown): u is string => typeof u === 'string' && /^https?:\/\//i.test(u);
  for (const c of catalog.categories) {
    if (c.isActive === false || hidden.categories.includes(String(c.id)) || restricted.has(String(c.id))) continue;
    if (http(c.imageUrl)) out.push({ url: c.imageUrl, kind: 'image', sha256: null, bytes: null });
  }
  for (const p of catalog.products) {
    if (!sellableOnKiosk(p, mode) || hidden.products.includes(String(p.id)) || restrictedRow(p, restricted)) continue;
    if (http(p.imageUrl)) out.push({ url: p.imageUrl, kind: 'image', sha256: null, bytes: null });
  }
  // The add-on options' and the note chips' pictures (the item's window and its pages show them).
  const menu = catalog.menu ?? {};
  const seen = new Set(out.map((r) => r.url));
  for (const pic of [...Object.values(optionImagesOf(menu.groups)), ...Object.values(noteImagesOf(menu.notes))]) {
    if (http(pic) && !seen.has(pic)) {
      seen.add(pic);
      out.push({ url: pic, kind: 'image', sha256: null, bytes: null });
    }
  }
  return out;
}
