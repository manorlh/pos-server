/**
 * The browser kiosk's catalog (`/k`), from the till catalog the cloud sends
 * (GET /sync/{m}/catalog) — the same rules as the Windows kiosk's kiosk-desktop
 * src/main/kiosk/catalog.ts (and the Android kiosk's KioskCatalogView.kt):
 *
 *  - only what a kiosk sells: not deleted, not delisted (`inStock`), not "קופות בלבד"
 *    (`salesChannel` pos_only), not "מחייב אישור מנהל במכירה" (itself or a category above it,
 *    lib/restrictedItems.ts — such a category disappears with everything beneath it), on this till's
 *    list when the machine catalog is "selected", in an active category; "אזל" = not available;
 *  - modifier groups by the menu links (a product's own list, [] = none, else its category's), with
 *    the rules that price them (free choices, quantities, "מעט / הרבה / בצד") and the meals' slots —
 *    read by the shared money rules (lib/kioskMoney.ts, the Android till's, ported once);
 *    quick notes from the menu (all ⊕ category ⊕ product); upsells as the menu offers them;
 *  - pictures from the network (the kiosk's service worker keeps them), a Cloudinary picture asked
 *    at the card's / the sheet's size.
 *
 * The kiosk's own order / hidden / featured rules are applied by the screens with the shared
 * `kioskCatalogView` (lib/kioskConfig.ts), exactly as the dashboard preview does.
 *
 * Pure; no `@/` imports (the node tests compile it on its own).
 */

import { agorotOfShekels, mealsOf, menuGroupIdsFor, menuGroupOf, menuNotesFor, parentOfCategories, type MealSlot, type MenuNotes } from './kioskMoney';
import { upsellRulesOf, type KioskUpsellRule } from './kioskUpsellRules';
import { kioskSoldOut, rowAvailable, type SaleState } from './kioskSoldOut';
import { isRestrictedProduct, restrictedCategoryIds, type RestrictedCategoryRow } from './restrictedItems';

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
export type WebDietaryTag = (typeof DIETARY)[number];

export interface WebCategory {
  id: string;
  name: string;
  imageUrl: string | null;
}

export interface WebOption {
  id: string;
  name: string;
  /** Shekels (display). */
  price: number;
  /** The exact price (lib/kioskMoney.ts). */
  priceAgorot: number;
  isDefault: boolean;
  /** The most of this option in one dish; null: only the group's max. */
  maxQty: number | null;
}

export interface WebGroup {
  id: string;
  name: string;
  kind: 'choice' | 'addon' | 'removal';
  min: number;
  max: number | null;
  /** This many units of choice are free — the cheapest ones. */
  freeCount: number;
  allowQuantity: boolean;
  allowPre: boolean;
  options: WebOption[];
}

export interface WebProduct {
  id: string;
  name: string;
  /** Shekels (display). */
  price: number;
  /** The exact price, agorot. */
  priceAgorot: number;
  /** "לא מקבל הנחות": no promotion discounts it (it still counts towards a spend threshold). */
  noDiscount: boolean;
  imageUrl: string | null;
  imageLarge: string | null;
  soldOut: boolean;
  available: boolean;
  description: string | null;
  categoryId: string | null;
  dietaryTags: WebDietaryTag[];
  /** In Hebrew, for the sheet. */
  allergens: string[];
  /** As the catalog sends them (the till's held sale carries these). */
  allergenCodes: string[];
  sku: string | null;
  barcode: string | null;
  trackStock: boolean;
  meal: boolean;
}

export interface WebUpsell {
  triggerType: string;
  triggerIds: string[];
  productIds: string[];
  categoryIds: string[];
  prompt: string | null;
}

export interface WebCatalog {
  categories: WebCategory[];
  products: WebProduct[];
  groups: Record<string, WebGroup[]>;
  /** The meals' slots by meal product id (menu.meals). */
  meals: Record<string, MealSlot[]>;
  quickNotes: Record<string, string[]>;
  upsells: WebUpsell[];
  /** "הגדלת מכירה": the menu's rules as the Android kiosk reads them (`upsells` + `kioskUpsells`, lib/kioskUpsellRules.ts). */
  upsellRules: KioskUpsellRule[];
}

type Row = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null;
/** Shekels from the catalog, to the agora as the till reads them (Agorot.ofShekels). */
const money = (v: unknown) => agorotOfShekels(num(v) ?? 0) / 100;

/**
 * A Cloudinary picture asked at `width` (auto format and quality); any other URL as it is.
 * Only a plain delivery URL (`/image/upload/v123/…` or `/image/upload/folder/…`) is rewritten.
 */
export function sizedImage(url: string | null, width: number): string | null {
  if (!url) return null;
  const m = /^(https:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\/)(.+)$/.exec(url);
  if (!m) return url;
  const first = m[2].split('/')[0];
  // Already transformed ("c_fill,w_300/…"): left alone.
  if (/[,_]/.test(first) && !/^v\d+$/.test(first)) return url;
  return `${m[1]}c_limit,w_${width},f_auto,q_auto/${m[2]}`;
}

/** Is this product sold on a kiosk at all. */
export function sellableOnKiosk(p: Row, machineCatalogMode: string | null | undefined): boolean {
  if (p.deleted === true) return false;
  if (p.inStock === false) return false;
  if (p.salesChannel === 'pos_only') return false;
  // "מחייב אישור מנהל במכירה": nobody at a kiosk can type a manager's code (its category: buildWebCatalog).
  if (p.requiresManagerApproval === true) return false;
  if (machineCatalogMode === 'selected' && p.inMachineCatalog === false) return false;
  return true;
}

export interface CatalogIn {
  products: Row[];
  categories: Row[];
  menu: Row | null;
  machineCatalog: { mode?: string } | null;
}

export function buildWebCatalog(
  catalog: CatalogIn,
  settings: Record<string, unknown>,
  /** This kiosk's stock levels and clock ("אזל" / "חסום"); absent: none here, now. */
  sale: SaleState = { stock: {}, nowMs: Date.now() },
): WebCatalog {
  const mode = catalog.machineCatalog?.mode ?? 'all';
  // "מחייב אישור מנהל במכירה", resolved over every category the catalog sent (lib/restrictedItems.ts).
  const restricted = restrictedCategoryIds(
    catalog.categories.filter((c) => c.deleted !== true).map((c) => c as unknown as RestrictedCategoryRow),
  );
  const activeCats = catalog.categories.filter(
    (c) => c.isActive !== false && c.deleted !== true && !restricted.has(String(c.id)),
  );
  const catIds = new Set(activeCats.map((c) => String(c.id)));
  const order = (list: unknown): string[] => (Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []);
  const catOrder = order(settings.categoryOrder);
  const prodOrder = order(settings.productOrder);
  const rank = (ids: string[], id: string) => {
    const i = ids.indexOf(id);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  const categories: WebCategory[] = activeCats
    .slice()
    .sort(
      (a, b) =>
        rank(catOrder, String(a.id)) - rank(catOrder, String(b.id)) ||
        (num(a.sortOrder) ?? 0) - (num(b.sortOrder) ?? 0) ||
        String(a.name ?? '').localeCompare(String(b.name ?? ''), 'he'),
    )
    .map((c) => ({ id: String(c.id), name: String(c.name ?? ''), imageUrl: sizedImage(str(c.imageUrl), 480) }));

  const menu = catalog.menu ?? {};
  const mealIds = new Set(Object.keys(((menu as { meals?: Record<string, unknown> }).meals ?? {}) as Record<string, unknown>));
  const products: WebProduct[] = catalog.products
    .filter(
      (p) =>
        sellableOnKiosk(p, mode) &&
        typeof p.categoryId === 'string' &&
        catIds.has(p.categoryId) &&
        !isRestrictedProduct({ categoryId: p.categoryId, requiresManagerApproval: p.requiresManagerApproval === true }, restricted),
    )
    .slice()
    .sort((a, b) => rank(prodOrder, String(a.id)) - rank(prodOrder, String(b.id)) || String(a.name ?? '').localeCompare(String(b.name ?? ''), 'he'))
    .map((p) => {
      const url = str(p.imageUrl);
      // "אזל" / "חסום" as the Android kiosk (lib/kioskSoldOut.ts, KioskCatalogView.soldOut): the row's lock,
      // delisted, the stock it tracks here, a block in force by the kiosk's clock.
      const available = rowAvailable(p);
      const tags = new Set(Array.isArray(p.dietaryTags) ? (p.dietaryTags as string[]) : []);
      const allergens = Array.isArray(p.allergens) ? (p.allergens as unknown[]).filter((a): a is string => typeof a === 'string') : [];
      return {
        id: String(p.id),
        name: String(p.name ?? ''),
        price: money(p.price),
        priceAgorot: agorotOfShekels(num(p.price) ?? 0),
        noDiscount: p.noDiscount === true,
        imageUrl: sizedImage(url, 480),
        imageLarge: sizedImage(url, 960),
        soldOut: kioskSoldOut(p, sale.stock[String(p.id)], sale.nowMs),
        available,
        description: str(p.description),
        categoryId: (p.categoryId as string) ?? null,
        dietaryTags: DIETARY.filter((t) => tags.has(t)),
        allergens: allergens.map((a) => ALLERGEN_HE[a] ?? a),
        allergenCodes: allergens,
        sku: str(p.sku),
        barcode: str(p.barcode),
        trackStock: p.trackStock === true,
        meal: mealIds.has(String(p.id)),
      };
    });

  const groupsById = new Map<string, WebGroup>();
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
      options: g.options.map((o) => ({ id: o.id, name: o.name, price: o.priceAgorot / 100, priceAgorot: o.priceAgorot, isDefault: o.isDefault, maxQty: o.maxQty })),
    });
  }
  const links = (menu.links ?? {}) as { categories?: Record<string, string[]>; products?: Record<string, string[]> };
  const parentOf = parentOfCategories(catalog.categories.filter((c) => c.deleted !== true));
  const notes = (menu.notes ?? {}) as MenuNotes;
  const groups: Record<string, WebGroup[]> = {};
  const quickNotes: Record<string, string[]> = {};
  for (const p of products) {
    // Menu.groupsFor: the product's own list, else the nearest category up its tree that has one.
    const ids = menuGroupIdsFor(links, [p.id], p.categoryId, parentOf);
    const list = ids.map((id) => groupsById.get(id)).filter((g): g is WebGroup => !!g && g.options.length > 0);
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
  // The meals of what the kiosk sells, each slot's choices among what it sells.
  const sold = new Set(products.map((p) => p.id));
  const meals: Record<string, MealSlot[]> = {};
  for (const [id, slots] of Object.entries(mealsOf(menu))) {
    if (!sold.has(id)) continue;
    const usable = slots.map((s) => ({ ...s, choices: s.choices.filter((c) => sold.has(c.productId)) })).filter((s) => s.choices.length > 0);
    if (usable.length > 0) meals[id] = usable;
  }
  return { categories, products, groups, meals, quickNotes, upsells, upsellRules: upsellRulesOf(menu) };
}

/** A full pull replaces; a delta upserts by id (the menu only when sent). A full pull of nothing never empties the kiosk. */
export function applyCatalogPull(prev: CatalogIn & { serverTime: string | null }, body: Record<string, unknown>): CatalogIn & { serverTime: string | null } {
  const rows = (v: unknown): Row[] => (Array.isArray(v) ? v.filter((x): x is Row => !!x && typeof x === 'object' && typeof (x as Row).id === 'string') : []);
  const upsert = (old: Row[], next: Row[]) => {
    if (next.length === 0) return old;
    const byId = new Map(old.map((r) => [String(r.id), r]));
    for (const r of next) byId.set(String(r.id), r);
    return [...byId.values()];
  };
  const full = body.syncType === 'full';
  const products = rows(body.products);
  const categories = rows(body.categories);
  const menu = body.menu && typeof body.menu === 'object' ? (body.menu as Row) : null;
  return {
    products: full ? (products.length === 0 && prev.products.length > 0 ? prev.products : products) : upsert(prev.products, products),
    categories: full ? (categories.length === 0 && prev.categories.length > 0 ? prev.categories : categories) : upsert(prev.categories, categories),
    menu: menu ?? prev.menu,
    machineCatalog: (body.machineCatalog as CatalogIn['machineCatalog']) ?? prev.machineCatalog,
    serverTime: typeof body.serverTime === 'string' ? body.serverTime : prev.serverTime,
  };
}

/** Every media URL a config holds ({url, kind} refs, any depth): what the service worker keeps. */
export function configMediaUrls(cfg: unknown): string[] {
  const out = new Set<string>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (typeof o.url === 'string' && /^https?:\/\//i.test(o.url) && (o.kind === 'image' || o.kind === 'video' || o.kind === 'font')) out.add(o.url);
      for (const x of Object.values(o)) walk(x);
    }
  };
  walk(cfg);
  return [...out];
}
