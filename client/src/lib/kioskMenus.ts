/**
 * "תפריטים" on the kiosks — ONE TypeScript port of what the Android kiosk does with the sales menus
 * (pos-android domain/CatalogMenus.kt `apply` / `present`, domain/KioskCatalogView.kt `menuCategories` /
 * `menuRules`, `KioskBasketCheck`), for the Windows kiosk (`@dash-lib/kioskMenus`) and the browser
 * kiosk (`/k`). The rules themselves are the cloud's (app/services/catalog_menu_rules.py,
 * docs/SPEC_MENUS.md), and every platform is pinned to the same answers by the shared golden
 * server/tests/fixtures/catalog_menus_golden.json (kioskMenus.test.ts runs every case of it: the
 * resolution AND the menu applied, prices to the agora). Change one, change all.
 *
 *  - **Which menu** — `resolve` (lib/menuSchedule.ts), on the surface `kiosk` ("היכן": a menu whose channel is
 *    `kiosk` or `both`), by the KIOSK's own clock (`localMomentOfMs`) — offline too. The block is the
 *    `catalogMenus` of the catalog pull (GET /sync/{m}/catalog), the very thing the Android kiosk reads.
 *  - **What it sells** — `layMenu`: while a menu is active ITS products and categories are the kiosk's, in
 *    ITS order and at ITS prices (a listed price replaces the catalog's), over the machine's own list
 *    ("גובר על הכל"); nothing to sell when the fallback is "לא למכור"; the catalog as it is otherwise. What
 *    the kiosk itself hides, a product's channel ("קופות בלבד"), "אזל" and blocks stay in force: this
 *    module never decides availability.
 *  - **The basket** — a line keeps the price it was added at when the menu changes under it
 *    (`keptListPrice`): the check before the charge compares CATALOG prices, so a swap is no "price
 *    change", and a line added under a menu that ended stays while its product is still sold here.
 *
 * Pure; imports only the self-contained menuSchedule.ts and kioskMoney.ts (the node tests compile it alone).
 */

import { agorotOfShekels } from './kioskMoney';
import { dayNumberOf, resolve, type BlockMenu, type LocalMoment, type MenuBlock, type MenuResolution, type MenuSurface } from './menuSchedule';

/** The surface of a kiosk. */
export const KIOSK_SURFACE: MenuSurface = 'kiosk';

/* -------------------------------------------------------------- the clock */

/**
 * The kiosk's own wall clock at `ms`: its local date and minute — never the browser's or the PC's time zone
 * string, never the cloud's. Seconds are dropped: a menu switches at a minute boundary.
 */
export function localMomentOfMs(ms: number): LocalMoment {
  const d = new Date(ms);
  const y = String(d.getFullYear()).padStart(4, '0');
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return { day: dayNumberOf(`${y}-${mo}-${da}`) ?? 0, minute: d.getHours() * 60 + d.getMinutes() };
}

/** Milliseconds from `ms` to the next minute boundary of the kiosk's clock (plus a little, so it is on the far side). */
export function msToNextMinute(ms: number, lag = 25): number {
  return 60_000 - (ms % 60_000) + lag;
}

/* ------------------------------------------------------------ the block */

type Row = Record<string, unknown>;

const isObject = (v: unknown): v is Row => !!v && typeof v === 'object' && !Array.isArray(v);
const idOf = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The block as the catalog pull carries it, or null when there is none to read. */
export function menuBlockOf(raw: unknown): MenuBlock | null {
  return isObject(raw) ? (raw as MenuBlock) : null;
}

/** Whether the block names any menu at all (a kiosk without menus shows no sign of them). */
export function hasMenus(block: MenuBlock | null | undefined): boolean {
  return Array.isArray(block?.menus) && block!.menus.length > 0;
}

/** The last menu of an id (as `resolve` reads them). */
export function menuById(block: MenuBlock | null | undefined, id: string | null): BlockMenu | null {
  if (!id || !Array.isArray(block?.menus)) return null;
  let found: BlockMenu | null = null;
  for (const m of block!.menus as unknown[]) if (isObject(m) && m.id === id) found = m as BlockMenu;
  return found;
}

/** A menu price in agorot (the cloud's `_money`: HALF_UP to the agora); null for none / unreadable. */
export function menuPriceAgorot(value: unknown): number | null {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? agorotOfShekels(value) : null;
  if (typeof value === 'string' && /^\s*[-+]?(\d+(\.\d*)?|\.\d+)\s*$/.test(value)) return agorotOfShekels(Number(value));
  return null;
}

/** Every price any menu of the block sets for a product, by product id — the prices a line may legitimately keep. */
export function menuPriceSets(block: MenuBlock | null | undefined): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  for (const m of Array.isArray(block?.menus) ? (block!.menus as unknown[]) : []) {
    if (!isObject(m)) continue;
    for (const p of Array.isArray(m.products) ? (m.products as unknown[]) : []) {
      if (!isObject(p) || !idOf(p.id)) continue;
      const a = menuPriceAgorot(p.price);
      if (a === null) continue;
      const set = out.get(String(p.id)) ?? new Set<number>();
      set.add(a);
      out.set(String(p.id), set);
    }
  }
  return out;
}

/* --------------------------------------------------------------- what */

/** A product as the menu reads it: its category and the catalog's price (agorot). */
export interface MenuInput {
  id: string;
  categoryId: string | null;
  priceAgorot: number;
}

/** One product as a menu places it (CatalogMenus.kt MenuPlacement). */
export interface MenuPlacement {
  id: string;
  categoryId: string;
  priceAgorot: number;
  /** `menu` — the menu's own price; `catalog` — the catalog's (PriceSource). */
  source: 'menu' | 'catalog';
}

/** The menu over the till's products: categories and products in order (CatalogMenus.kt MenuApplied). */
export interface MenuApplied {
  categories: string[];
  products: MenuPlacement[];
}

/**
 * `menu` over `products` (in the till's own order) — catalog_menu_rules.apply: the menu's categories in its
 * order, then those of products it lists from a category it does not name; in each, the listed products in
 * the menu's order and — for a category with all of its products — the rest in the till's order. A listed
 * price replaces the catalog's (HALF_UP to the agora); a category left with nothing is dropped.
 */
export function applyMenu(menu: BlockMenu | null | undefined, products: readonly MenuInput[]): MenuApplied {
  const order: string[] = [];
  const allOf = new Map<string, boolean>();
  for (const c of Array.isArray(menu?.categories) ? (menu!.categories as unknown[]) : []) {
    if (!isObject(c) || !idOf(c.id) || allOf.has(String(c.id))) continue;
    order.push(String(c.id));
    // Python's `bool(c.get("all", True))`.
    allOf.set(String(c.id), 'all' in c ? !!c.all : true);
  }
  const listed = new Map<string, number>();
  const prices = new Map<string, number | null>();
  (Array.isArray(menu?.products) ? (menu!.products as unknown[]) : []).forEach((p, i) => {
    if (!isObject(p) || !idOf(p.id) || listed.has(String(p.id))) return;
    listed.set(String(p.id), i);
    prices.set(String(p.id), menuPriceAgorot(p.price));
  });

  const byCategory = new Map<string | null, MenuInput[]>();
  for (const p of products) {
    const list = byCategory.get(p.categoryId) ?? [];
    list.push(p);
    byCategory.set(p.categoryId, list);
  }
  // A product listed from a category the menu does not name brings its category, after.
  for (const p of products.filter((x) => listed.has(x.id)).sort((a, b) => listed.get(a.id)! - listed.get(b.id)!)) {
    if (p.categoryId && !allOf.has(p.categoryId)) {
      order.push(p.categoryId);
      allOf.set(p.categoryId, false);
    }
  }

  const categories: string[] = [];
  const placed: MenuPlacement[] = [];
  for (const cid of order) {
    const inside = byCategory.get(cid) ?? [];
    const first = inside.filter((p) => listed.has(p.id)).sort((a, b) => listed.get(a.id)! - listed.get(b.id)!);
    const rest = allOf.get(cid) ? inside.filter((p) => !listed.has(p.id)) : [];
    const chosen = [...first, ...rest];
    if (chosen.length === 0) continue;
    categories.push(cid);
    for (const p of chosen) {
      const own = prices.get(p.id) ?? null;
      placed.push({ id: p.id, categoryId: cid, priceAgorot: own ?? p.priceAgorot, source: own !== null ? 'menu' : 'catalog' });
    }
  }
  return { categories, products: placed };
}

/** "12.00" — agorot as the golden writes a price. */
export function agorotText(agorot: number): string {
  const sign = agorot < 0 ? '-' : '';
  const a = Math.abs(Math.trunc(agorot));
  return `${sign}${Math.floor(a / 100)}.${String(a % 100).padStart(2, '0')}`;
}

/** The cloud's `sellable()`: the resolution, and the menu applied — null for the catalog as it is, nothing for "לא למכור". */
export function sellableMenu(
  block: MenuBlock | null | undefined,
  at: string | LocalMoment,
  surface: MenuSurface,
  products: readonly MenuInput[],
): { resolution: MenuResolution; applied: MenuApplied | null } {
  const resolution = resolve(block, at, surface);
  if (resolution.mode === 'menu') return { resolution, applied: applyMenu(menuById(block, resolution.menuId), products) };
  if (resolution.mode === 'none') return { resolution, applied: { categories: [], products: [] } };
  return { resolution, applied: null };
}

/* ------------------------------------------------------ the kiosk's view */

/** What the active menu makes of the kiosk (CatalogMenus.kt MenuView): small, computed once per answer. */
export interface KioskMenuState {
  mode: 'catalog' | 'menu' | 'none';
  menuId: string | null;
  menuName: string | null;
  level: string | null;
  /** The menu's categories in its order; null without a menu. */
  categoryOrder: string[] | null;
  /** The products the menu lists, in its category order and then its own; null without a menu. */
  productOrder: string[] | null;
  /** The categories the menu shows; null: every category (no menu). */
  categories: string[] | null;
  /** Any menu is assigned to this kiosk at all. */
  hasMenus: boolean;
}

export function noMenuState(block?: MenuBlock | null): KioskMenuState {
  return { mode: 'catalog', menuId: null, menuName: null, level: null, categoryOrder: null, productOrder: null, categories: null, hasMenus: hasMenus(block) };
}

/** The same menu answer (the catalog is laid again only when it changes — never per minute, never per tile). */
export function sameMenuAnswer(a: Pick<KioskMenuState, 'mode' | 'menuId'>, b: Pick<KioskMenuState, 'mode' | 'menuId'>): boolean {
  return a.mode === b.mode && a.menuId === b.menuId;
}

/**
 * What one minute of the kiosk's clock says: which menu — a handful of comparisons. The kiosk looks again
 * at every minute boundary and rebuilds its catalog only when this answer changes.
 */
export function menuKeyAt(block: MenuBlock | null | undefined, nowMs: number): string {
  const r = resolve(block, localMomentOfMs(nowMs), KIOSK_SURFACE);
  return `${r.mode}:${r.menuId ?? ''}`;
}

/** The menu laid over a kiosk's products (CatalogMenus.present): who is placed, at what price, and how it is shown. */
export interface MenuLay {
  state: KioskMenuState;
  /** The products a menu places by id; null when no menu is active (the catalog as it is, or nothing). */
  placed: ReadonlyMap<string, MenuPlacement> | null;
}

/**
 * The menu active on the kiosk at `nowMs` (its own clock) laid over `rows` — every product the shop lists
 * on this kiosk, in the till's own order (the general item and a deleted row are not products of it).
 */
export function layMenu(block: MenuBlock | null | undefined, nowMs: number, rows: readonly MenuInput[]): MenuLay {
  const resolution = resolve(block, localMomentOfMs(nowMs), KIOSK_SURFACE);
  const any = hasMenus(block);
  if (resolution.mode === 'catalog') return { state: noMenuState(block), placed: null };
  if (resolution.mode === 'none') {
    return { state: { ...noMenuState(block), mode: 'none', hasMenus: any }, placed: null };
  }
  const menu = menuById(block, resolution.menuId);
  const applied = applyMenu(menu, rows);
  const placed = new Map(applied.products.map((p) => [p.id, p]));
  const explicit: string[] = [];
  for (const p of Array.isArray(menu?.products) ? (menu!.products as unknown[]) : []) {
    const id = isObject(p) ? idOf(p.id) : '';
    if (id && placed.has(id) && !explicit.includes(id)) explicit.push(id);
  }
  const rank = new Map(applied.categories.map((c, i) => [c, i]));
  const productOrder = explicit
    .map((id, i) => ({ id, i }))
    .sort((a, b) => (rank.get(placed.get(a.id)!.categoryId) ?? Number.MAX_SAFE_INTEGER) - (rank.get(placed.get(b.id)!.categoryId) ?? Number.MAX_SAFE_INTEGER) || a.i - b.i)
    .map((x) => x.id);
  return {
    state: {
      mode: 'menu',
      menuId: resolution.menuId,
      menuName: resolution.menuName,
      level: resolution.level,
      categoryOrder: applied.categories,
      productOrder,
      categories: applied.categories,
      hasMenus: true,
    },
    placed,
  };
}

/** The catalog rows as the menu reads them: not deleted, not the general item, listed by the shop; the price in agorot. */
export function menuInputsOf(products: ReadonlyArray<Row>): MenuInput[] {
  const out: MenuInput[] = [];
  for (const p of products) {
    if (p.deleted === true || p.isGeneral === true || p.shopListed === false) continue;
    const id = idOf(p.id);
    if (!id) continue;
    const price = typeof p.price === 'number' ? p.price : typeof p.price === 'string' && p.price.trim() ? Number(p.price) : 0;
    out.push({ id, categoryId: typeof p.categoryId === 'string' && p.categoryId ? p.categoryId : null, priceAgorot: agorotOfShekels(Number.isFinite(price) ? price : 0) });
  }
  return out;
}

/**
 * The kiosk's own order gives way to the active menu's (KioskCatalogView.menuRules): its categories in its order,
 * its listed products first in every category it shows. The kiosk's hidden items, pictures and "מומלצים" stay.
 */
export function withMenuOrder<C extends { catalog: { categoryOrder?: string[]; productOrder?: Record<string, string[]> } }>(
  cfg: C,
  state: Pick<KioskMenuState, 'mode' | 'categoryOrder' | 'productOrder' | 'categories'> | null | undefined,
): C {
  if (!state || state.mode !== 'menu') return cfg;
  const listed = state.productOrder ?? [];
  return {
    ...cfg,
    catalog: {
      ...cfg.catalog,
      categoryOrder: state.categoryOrder ?? [],
      productOrder: Object.fromEntries((state.categories ?? []).map((c) => [c, listed])),
    },
  };
}

/** The catalog's title with the active menu's name ("תפריט · צהריים", the Android kiosk's KioskCatalogScreen). */
export function titleWithMenu(title: string, state: Pick<KioskMenuState, 'mode' | 'menuName'> | null | undefined): string {
  return state && state.mode === 'menu' && state.menuName ? `${title} · ${state.menuName}` : title;
}

/* ---------------------------------------------------------- the basket */

/** A product's prices as the basket check reads them. */
export interface ProductPrices {
  /** The price the kiosk sells it at now (the menu's while one is active). */
  priceAgorot: number;
  /** The catalog's price, when a menu set `priceAgorot` (absent: there is no menu on it, the two are the same). */
  catalogPriceAgorot?: number | null;
}

/** A product's catalog price — its `basePrice` (SellableProduct.basePrice): what a menu swap never changes. */
export function basePriceOf(p: ProductPrices): number {
  return p.catalogPriceAgorot ?? p.priceAgorot;
}

/**
 * The prices of a product at the check: the catalog's now and the one it is sold at now. A product a menu
 * priced follows the menu; only a catalog-priced one follows the cloud's word (`cloudAgorot`) —
 * KioskPriceCheck.patched.
 */
export function pricesNow(p: ProductPrices, cloudAgorot?: number | null): { catalogAgorot: number; listAgorot: number } {
  if (p.catalogPriceAgorot !== undefined && p.catalogPriceAgorot !== null) return { catalogAgorot: p.catalogPriceAgorot, listAgorot: p.priceAgorot };
  const price = typeof cloudAgorot === 'number' ? cloudAgorot : p.priceAgorot;
  return { catalogAgorot: price, listAgorot: price };
}

/**
 * The list price of a dish the basket line keeps at the check before the charge. A menu switching under an
 * open basket changes nothing: the line keeps the price it was added at while its catalog price is the same
 * (`catalogAgorot` — the line's memory of it; a line added with no menu has none and its own price is the
 * catalog's); a real change of the catalog's price reprices it to what the kiosk sells it at now. A price the
 * line carries that no menu of the block sets and the catalog does not have is nobody's: the catalog's.
 *
 * KioskBasketCheck.of / apply. Without the line's own price (an older screen) — what the kiosk sells it at now.
 */
export function keptListPrice(
  line: { listAgorot?: number | null; catalogAgorot?: number | null },
  now: { catalogAgorot: number; listAgorot: number },
  menuPrices: ReadonlySet<number> | undefined,
): number {
  const added = line.listAgorot;
  if (typeof added !== 'number' || !Number.isFinite(added)) return now.listAgorot;
  const was = typeof line.catalogAgorot === 'number' ? line.catalogAgorot : added;
  if (was !== now.catalogAgorot) return now.listAgorot;
  if (added === now.catalogAgorot || menuPrices?.has(added)) return added;
  return now.listAgorot;
}

/**
 * What a sold line records of the menu (`priceSource`, CatalogMenus.kt PriceSource.of): nothing when no menu was
 * active when it was added; `menu` — the menu's price; `catalog` — the catalog's, inside a menu.
 */
export function lineMenuFields(p: { menuId?: string | null; menuName?: string | null; priceSource?: string | null }): {
  menuId: string | null;
  menuName: string | null;
  priceSource: 'menu' | 'catalog' | null;
} {
  if (!p.menuId) return { menuId: null, menuName: null, priceSource: null };
  return { menuId: p.menuId, menuName: p.menuName ?? null, priceSource: p.priceSource === 'menu' ? 'menu' : 'catalog' };
}

/* ---------------------------------------------------- the screens' basket */

/** What a basket line remembers of its product's price: where the menu stands when it is added (a PProduct's menu fields). */
interface PricedProduct {
  id: string;
  menuId?: string | null;
  priceAgorot?: number;
}

/**
 * The key of a plain dish's line — one per dish, menu and price, so a line added under another menu never shares a
 * key with the one already in the basket (the order and its checks name a line by its key).
 */
export function plainLineKey(p: PricedProduct): string {
  return `${p.id}-plain${p.menuId ? `-${p.menuId}-${p.priceAgorot ?? ''}` : ''}`;
}

/**
 * Whether a tap on `p` joins the plain line `l` of the basket: the same dish at the same price, under the same menu
 * (Cart.add merges only then) — after a menu switch a new tap is a line of its own at the new price; "+1" on an
 * existing line is the line's own business and keeps its price.
 */
export function joinsPlainLine(l: { product: PricedProduct; unitAgorot?: number; unit: number }, p: PricedProduct & { price: number }): boolean {
  const at = p.priceAgorot ?? Math.round(p.price * 100);
  const own = l.unitAgorot ?? Math.round(l.unit * 100);
  return l.product.id === p.id && (l.product.menuId ?? null) === (p.menuId ?? null) && own === at;
}

/**
 * What a basket line tells the check before the charge about its price ("תפריטים"): the dish's own price as it was added
 * at (the menu's while a menu priced it), and — under a menu — the catalog's price then and the menu. The check keeps the
 * price while the catalog's has not moved (`keptListPrice`).
 */
export function menuMemoryOf(l: {
  product: { price: number; priceAgorot?: number; catalogPriceAgorot?: number; menuId?: string | null; priceSource?: 'menu' | 'catalog' | null };
}): { listAgorot: number; catalogAgorot?: number; menuId?: string; priceSource?: 'menu' | 'catalog' } {
  const listAgorot = l.product.priceAgorot ?? Math.round(l.product.price * 100);
  if (!l.product.menuId) return { listAgorot };
  return {
    listAgorot,
    ...(typeof l.product.catalogPriceAgorot === 'number' ? { catalogAgorot: l.product.catalogPriceAgorot } : {}),
    menuId: l.product.menuId,
    priceSource: l.product.priceSource === 'menu' ? 'menu' : 'catalog',
  };
}
