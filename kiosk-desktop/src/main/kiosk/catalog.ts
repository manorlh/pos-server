/**
 * The kiosk's catalog, from the till catalog the cloud sends (GET /sync/{m}/catalog) — the same
 * rules the Android kiosk applies (pos-android domain/KioskCatalogView.kt, KioskPresentation.kt):
 *
 *  - only what a kiosk sells: not delisted (`inStock`), not "קופות בלבד" (`salesChannel` pos_only),
 *    not "מחייב אישור מנהל במכירה" (itself or a category above it — client/src/lib/restrictedItems.ts;
 *    such a category disappears with everything beneath it: nobody at a kiosk types a manager's code),
 *    on this till's list when the machine catalog is "selected", in an active category;
 *  - "אזל" = not available (`isAvailable` false);
 *  - modifier groups by the menu links (a product's own list, [] = none, else its category's), with
 *    the rules that price them (free choices, quantities, "מעט / הרבה / בצד") and the meals' slots —
 *    read by the shared money rules (client/src/lib/kioskMoney.ts, the Android till's, ported once);
 *  - quick notes from the menu (all ⊕ category ⊕ product);
 *  - pictures ONLY from the local media store (a variant sized for the card, a larger one for the
 *    sheet) — never a network URL on the screens.
 *
 * The kiosk's own order / hidden / featured rules are applied by the screens with the shared
 * `kioskCatalogView` (client/src/lib/kioskConfig.ts), exactly as the dashboard preview does.
 */

import { mealsOf, menuGroupIdsFor, menuGroupOf, menuNotesFor, parentOfCategories, type MealSlot, type MenuNotes, type MenuGroup } from '@dash-lib/kioskMoney';
import { upsellRulesOf, type KioskUpsellRule } from '@dash-lib/kioskUpsellRules';
import { kioskSoldOut, rowAvailable, type SaleState } from '@dash-lib/kioskSoldOut';
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
  /** The exact price, agorot. */
  priceAgorot: number;
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
}

export interface KioskCatalogData {
  categories: KCategory[];
  products: KProduct[];
  groups: Record<string, KGroup[]>;
  /** The meals' slots by meal product id (menu.meals). */
  meals: Record<string, MealSlot[]>;
  quickNotes: Record<string, string[]>;
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

/** Is this product sold on a kiosk at all. */
export function sellableOnKiosk(p: Row, machineCatalogMode: string | null | undefined): boolean {
  if (p.deleted === true) return false;
  if (p.inStock === false) return false;
  if (p.salesChannel === 'pos_only') return false;
  // "מחייב אישור מנהל במכירה" — its own flag here; its category's in buildKioskCatalog / catalogMedia.
  if (p.requiresManagerApproval === true) return false;
  if (machineCatalogMode === 'selected' && p.inMachineCatalog === false) return false;
  return true;
}

export function buildKioskCatalog(
  catalog: { products: Row[]; categories: Row[]; menu: Row | null; machineCatalog: { mode?: string } | null },
  settings: Record<string, unknown>,
  localImage: (url: string | null, size: 'card' | 'large') => string | null,
  /** This kiosk's stock levels and clock ("אזל" / "חסום"); absent: none here, now. */
  sale: SaleState = { stock: {}, nowMs: Date.now() },
): KioskCatalogData {
  const mode = catalog.machineCatalog?.mode ?? 'all';
  const restricted = restrictedOf(catalog.categories);
  const activeCats = catalog.categories.filter((c) => c.isActive !== false && c.deleted !== true && !restricted.has(String(c.id)));
  const catIds = new Set(activeCats.map((c) => String(c.id)));
  const order = (list: unknown): string[] => (Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []);
  const catOrder = order(settings.categoryOrder);
  const prodOrder = order(settings.productOrder);
  const rank = (ids: string[], id: string) => {
    const i = ids.indexOf(id);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  const categories: KCategory[] = activeCats
    .slice()
    .sort((a, b) => rank(catOrder, String(a.id)) - rank(catOrder, String(b.id)) || (num(a.sortOrder) ?? 0) - (num(b.sortOrder) ?? 0) || String(a.name ?? '').localeCompare(String(b.name ?? ''), 'he'))
    .map((c) => ({ id: String(c.id), name: String(c.name ?? ''), imageUrl: localImage(str(c.imageUrl), 'card') }));

  const mealIds = new Set(Object.keys(((catalog.menu ?? {}) as { meals?: Record<string, unknown> }).meals ?? {}));
  const products: KProduct[] = catalog.products
    .filter((p) => sellableOnKiosk(p, mode) && typeof p.categoryId === 'string' && catIds.has(p.categoryId) && !restrictedRow(p, restricted))
    .slice()
    .sort((a, b) => rank(prodOrder, String(a.id)) - rank(prodOrder, String(b.id)) || String(a.name ?? '').localeCompare(String(b.name ?? ''), 'he'))
    .map((p) => {
      const url = str(p.imageUrl);
      // "אזל" / "חסום" as the Android kiosk (lib/kioskSoldOut.ts, KioskCatalogView.soldOut): the row's lock,
      // delisted, the stock it tracks here, a block in force by the kiosk's clock.
      const available = rowAvailable(p);
      const tags = Array.isArray(p.dietaryTags) ? new Set(p.dietaryTags as string[]) : new Set<string>();
      return {
        id: String(p.id),
        name: String(p.name ?? ''),
        price: ofShekels(num(p.price) ?? 0) / 100,
        priceAgorot: ofShekels(num(p.price) ?? 0),
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
      };
    });

  const menu = catalog.menu ?? {};
  const groupsById = new Map<string, KGroup>();
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
  const groups: Record<string, KGroup[]> = {};
  const quickNotes: Record<string, string[]> = {};
  for (const p of products) {
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

/** The pictures the kiosk keeps for its catalog (not of what it hides or does not sell). */
export function catalogMedia(
  catalog: { products: Row[]; categories: Row[]; machineCatalog: { mode?: string } | null },
  hidden: { categories: string[]; products: string[] },
): MediaRefIn[] {
  const mode = catalog.machineCatalog?.mode ?? 'all';
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
  return out;
}
