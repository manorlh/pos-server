/**
 * The kiosk's catalog, from the till catalog the cloud sends (GET /sync/{m}/catalog) — the same
 * rules the Android kiosk applies (pos-android domain/KioskCatalogView.kt, KioskPresentation.kt):
 *
 *  - only what a kiosk sells: not delisted (`inStock`), not "קופות בלבד" (`salesChannel` pos_only),
 *    on this till's list when the machine catalog is "selected", in an active category;
 *  - "אזל" = not available (`isAvailable` false);
 *  - modifier groups by the menu links (a product's own list, [] = none, else its category's);
 *  - quick notes from the menu (all ⊕ category ⊕ product);
 *  - pictures ONLY from the local media store (a variant sized for the card, a larger one for the
 *    sheet) — never a network URL on the screens.
 *
 * The kiosk's own order / hidden / featured rules are applied by the screens with the shared
 * `kioskCatalogView` (client/src/lib/kioskConfig.ts), exactly as the dashboard preview does.
 */

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
  isDefault: boolean;
}

export interface KGroup {
  id: string;
  name: string;
  kind: string;
  min: number;
  max: number | null;
  options: KOption[];
}

export interface KProduct {
  id: string;
  name: string;
  /** Shekels (display); the main process prices the document from its own catalog, never this. */
  price: number;
  imageUrl: string | null;
  imageLarge: string | null;
  soldOut: boolean;
  available: boolean;
  description: string | null;
  categoryId: string | null;
  dietaryTags: Array<(typeof DIETARY)[number]>;
  allergens: string[];
  sku: string | null;
  trackStock: boolean;
  /** A meal (menu.meals): its window opens, never the card's quick "+". */
  meal: boolean;
}

export interface KioskCatalogData {
  categories: KCategory[];
  products: KProduct[];
  groups: Record<string, KGroup[]>;
  quickNotes: Record<string, string[]>;
  /** Upsell candidates by trigger: product ids offered for a product, a category, or any order. */
  upsells: Array<{ triggerType: string; triggerIds: string[]; productIds: string[]; categoryIds: string[]; prompt: string | null }>;
}

type Row = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);

/** Is this product sold on a kiosk at all. */
export function sellableOnKiosk(p: Row, machineCatalogMode: string | null | undefined): boolean {
  if (p.deleted === true) return false;
  if (p.inStock === false) return false;
  if (p.salesChannel === 'pos_only') return false;
  if (machineCatalogMode === 'selected' && p.inMachineCatalog === false) return false;
  return true;
}

export function buildKioskCatalog(
  catalog: { products: Row[]; categories: Row[]; menu: Row | null; machineCatalog: { mode?: string } | null },
  settings: Record<string, unknown>,
  localImage: (url: string | null, size: 'card' | 'large') => string | null,
): KioskCatalogData {
  const mode = catalog.machineCatalog?.mode ?? 'all';
  const activeCats = catalog.categories.filter((c) => c.isActive !== false && c.deleted !== true);
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
    .filter((p) => sellableOnKiosk(p, mode) && typeof p.categoryId === 'string' && catIds.has(p.categoryId))
    .slice()
    .sort((a, b) => rank(prodOrder, String(a.id)) - rank(prodOrder, String(b.id)) || String(a.name ?? '').localeCompare(String(b.name ?? ''), 'he'))
    .map((p) => {
      const url = str(p.imageUrl);
      const available = p.isAvailable !== false;
      const tags = Array.isArray(p.dietaryTags) ? new Set(p.dietaryTags as string[]) : new Set<string>();
      return {
        id: String(p.id),
        name: String(p.name ?? ''),
        price: ofShekels(num(p.price) ?? 0) / 100,
        imageUrl: localImage(url, 'card'),
        imageLarge: localImage(url, 'large'),
        soldOut: !available,
        available,
        description: str(p.description),
        categoryId: (p.categoryId as string) ?? null,
        dietaryTags: DIETARY.filter((t) => tags.has(t)),
        allergens: Array.isArray(p.allergens) ? (p.allergens as string[]).map((a) => ALLERGEN_HE[a] ?? a) : [],
        sku: str(p.sku),
        trackStock: p.trackStock === true,
        meal: mealIds.has(String(p.id)),
      };
    });

  const menu = catalog.menu ?? {};
  const groupsById = new Map<string, KGroup>();
  for (const g of Array.isArray(menu.groups) ? (menu.groups as Row[]) : []) {
    if (typeof g.id !== 'string') continue;
    const kind = String(g.kind ?? 'addon');
    const maxRaw = num(g.maxSelect);
    groupsById.set(g.id, {
      id: g.id,
      name: String(g.name ?? ''),
      kind,
      min: Math.max(0, num(g.minSelect) ?? 0),
      max: kind === 'choice' && maxRaw === null ? 1 : maxRaw,
      options: (Array.isArray(g.options) ? (g.options as Row[]) : [])
        .filter((o) => typeof o.id === 'string')
        .map((o) => ({ id: String(o.id), name: String(o.name ?? ''), price: ofShekels(num(o.price) ?? 0) / 100, isDefault: o.isDefault === true })),
    });
  }
  const links = (menu.links ?? {}) as { categories?: Record<string, string[]>; products?: Record<string, string[]> };
  const notes = (menu.notes ?? {}) as { all?: Row[]; categories?: Record<string, Row[]>; products?: Record<string, Row[]> };
  const noteTexts = (list: Row[] | undefined) => (Array.isArray(list) ? list.map((n) => str(n.text)).filter((t): t is string => !!t) : []);
  const groups: Record<string, KGroup[]> = {};
  const quickNotes: Record<string, string[]> = {};
  for (const p of products) {
    const own = links.products?.[p.id];
    const ids = Array.isArray(own) ? own : p.categoryId ? (links.categories?.[p.categoryId] ?? []) : [];
    const list = ids.map((id) => groupsById.get(id)).filter((g): g is KGroup => !!g && g.options.length > 0);
    if (list.length > 0) groups[p.id] = list;
    const q = [...noteTexts(notes.all), ...(p.categoryId ? noteTexts(notes.categories?.[p.categoryId]) : []), ...noteTexts(notes.products?.[p.id])];
    if (q.length > 0) quickNotes[p.id] = Array.from(new Set(q));
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
  return { categories, products, groups, quickNotes, upsells };
}

/** The pictures the kiosk keeps for its catalog (not of what it hides or does not sell). */
export function catalogMedia(
  catalog: { products: Row[]; categories: Row[]; machineCatalog: { mode?: string } | null },
  hidden: { categories: string[]; products: string[] },
): MediaRefIn[] {
  const mode = catalog.machineCatalog?.mode ?? 'all';
  const out: MediaRefIn[] = [];
  const http = (u: unknown): u is string => typeof u === 'string' && /^https?:\/\//i.test(u);
  for (const c of catalog.categories) {
    if (c.isActive === false || hidden.categories.includes(String(c.id))) continue;
    if (http(c.imageUrl)) out.push({ url: c.imageUrl, kind: 'image', sha256: null, bytes: null });
  }
  for (const p of catalog.products) {
    if (!sellableOnKiosk(p, mode) || hidden.products.includes(String(p.id))) continue;
    if (http(p.imageUrl)) out.push({ url: p.imageUrl, kind: 'image', sha256: null, bytes: null });
  }
  return out;
}
