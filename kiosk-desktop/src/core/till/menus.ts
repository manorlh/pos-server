/**
 * "תפריטים" on the Windows till (pos-server docs/SPEC_MENUS.md; the Android till's domain/CatalogMenus.kt +
 * CatalogMenuRepository.kt): named sales menus by schedule — "בוקר", "צהריים", "הפי האוור". A catalog menu decides what this
 * till sells, in what order and at what price while it is active. (Not the modifier layer of the kiosk's `menu`.)
 *
 * The cloud sends the menus assigned along this till's chain in the catalog pull (`catalogMenus`, kept by CloudStore); the
 * till works out which is active on ITS OWN clock, offline. The rules are the cloud's own and are not written again here:
 * **when / which** is `@dash-lib/menuSchedule` (client/src/lib — pinned to the shared golden `catalog_menus_golden.json`);
 * **what** (`applyMenu`) is CatalogMenus.apply, pinned to the same golden by test/tillMenusCore.test.ts.
 *
 *  - the till's identity needs nothing here: the cloud already cut the block down to what is assigned along THIS till's chain
 *    (till › its device groups › point of sale › shop › company…), each assignment with its level and depth;
 *  - the surface is always 'pos' (the till's sell screen; the kiosk's own menus are another feature);
 *  - what a menu does to the catalog: its categories in its order (then those of products it lists from a category it does
 *    not name); in each, the listed products first in the menu's order, then — for a category with all its products — the
 *    rest in the till's own order. A listed price REPLACES the catalog's while the menu is active; availability (a lock, a
 *    block, "אזל") is not touched. No menu active: the fallback — the catalog as without menus, or nothing to sell.
 *
 * Pure: agorot in, agorot out; the wall clock is a Date (the till's own zone).
 */

import { resolve as resolveBlock, type LocalMoment, type MenuBlock, type MenuResolution, type MenuSurface } from '@dash-lib/menuSchedule';
import { ofShekels } from '../money';

/** The till's sell screen. */
export const TILL_SURFACE: MenuSurface = 'pos';

/** Where a sold line's price came from (`priceSource` on the wire). */
export type TillPriceSource = 'menu' | 'catalog';

/** What a sold line records of the menu active when it was priced (`menuId` / `menuName` / `priceSource`). */
export interface TillMenuFacts {
  menuId?: string | null;
  menuName?: string | null;
  priceSource?: TillPriceSource;
}

/** A product as the menu reads it: its place and its catalog price. */
export interface MenuInput {
  id: string;
  categoryId: string | null;
  priceAgorot: number;
}

/** One product as the menu places it: its category, its price and where that came from. */
export interface MenuPlacement {
  id: string;
  categoryId: string;
  priceAgorot: number;
  source: TillPriceSource;
}

/** The menu over the till's products: categories and products in order. */
export interface MenuApplied {
  categories: string[];
  products: MenuPlacement[];
}

const NOTHING: MenuApplied = { categories: [], products: [] };

/* ----------------------------------------------------------------- the clock */

const DAY_MS = 86_400_000;

/** The local wall-clock moment of `at`: the date as a day count, and the minute of the day (never through a time zone offset). */
export function localMomentOf(at: Date): LocalMoment {
  return { day: Math.floor(Date.UTC(at.getFullYear(), at.getMonth(), at.getDate()) / DAY_MS), minute: at.getHours() * 60 + at.getMinutes() };
}

/* ------------------------------------------------------------------- which */

/** The `catalogMenus` block as kept: an object, else none (a null, a list or a scalar reads as no menus). */
export function menuBlockOf(raw: unknown): MenuBlock | null {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as MenuBlock) : null;
}

/** The menu active on the till's own clock — the cloud's `resolve()` answer (`mode` 'menu' | 'catalog' | 'none'). */
export function resolveTillMenu(block: unknown, at: Date): MenuResolution {
  return resolveBlock(menuBlockOf(block), localMomentOf(at), TILL_SURFACE);
}

/** What changes the till's catalog: the mode and the menu (MenuResolution.key). */
export function menuKey(r: Pick<MenuResolution, 'mode' | 'menuId'>): string {
  return `${r.mode}|${r.menuId ?? ''}`;
}

/* -------------------------------------------------------------------- what */

interface ReadMenu {
  categories: Array<{ id: string; all: boolean }>;
  products: Array<{ id: string; priceAgorot: number | null }>;
}

/** A non-empty id (a number reads as its text, as the Android codec's optString). */
function idOf(v: unknown): string | null {
  if (typeof v === 'string') return v.length > 0 ? v : null;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

const DECIMAL = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** A listed price (shekels, a number or a numeric string) in agorot, HALF_UP; a boolean, a blank or junk: none. */
export function listedPriceAgorot(raw: unknown): number | null {
  let n: number;
  if (typeof raw === 'number') n = raw;
  else if (typeof raw === 'string' && DECIMAL.test(raw.trim())) n = Number(raw.trim());
  else return null;
  return Number.isFinite(n) ? ofShekels(n) : null;
}

function readMenu(raw: unknown): ReadMenu {
  const m = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const list = (v: unknown): Array<Record<string, unknown>> => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)) : []);
  const categories: ReadMenu['categories'] = [];
  for (const c of list(m.categories)) {
    const id = idOf(c.id);
    if (id === null) continue;
    // `all` absent or null: all its products; a text "false" is false, as the Android codec's optBoolean.
    const all = c.all === undefined || c.all === null ? true : typeof c.all === 'boolean' ? c.all : typeof c.all === 'string' ? c.all.toLowerCase() !== 'false' : true;
    categories.push({ id, all });
  }
  const products: ReadMenu['products'] = [];
  for (const p of list(m.products)) {
    const id = idOf(p.id);
    if (id === null) continue;
    products.push({ id, priceAgorot: listedPriceAgorot(p.price) });
  }
  return { categories, products };
}

/** The menu `id` of the block, as the cloud sent it; none when the block does not carry it. Two with one id: the last (as `resolve` keeps them). */
export function menuOf(block: unknown, id: string | null): unknown | null {
  const b = menuBlockOf(block);
  if (!b || id === null || !Array.isArray(b.menus)) return null;
  let found: unknown | null = null;
  for (const m of b.menus) if (m && typeof m === 'object' && !Array.isArray(m) && (m as { id?: unknown }).id === id) found = m;
  return found;
}

/** CatalogMenus.apply: the menu over the till's products (in the till's own order). A menu that is not there places nothing. */
export function applyMenu(menu: unknown | null, products: readonly MenuInput[]): MenuApplied {
  if (menu === null || menu === undefined) return NOTHING;
  const read = readMenu(menu);
  const order: string[] = [];
  const allOf = new Map<string, boolean>();
  for (const c of read.categories) {
    if (!allOf.has(c.id)) {
      order.push(c.id);
      allOf.set(c.id, c.all);
    }
  }
  const listed = new Map<string, number>();
  const prices = new Map<string, number | null>();
  read.products.forEach((p, i) => {
    if (!listed.has(p.id)) {
      listed.set(p.id, i);
      prices.set(p.id, p.priceAgorot);
    }
  });
  const byCategory = new Map<string | null, MenuInput[]>();
  for (const p of products) {
    const inside = byCategory.get(p.categoryId);
    if (inside) inside.push(p);
    else byCategory.set(p.categoryId, [p]);
  }
  const rank = (p: MenuInput) => listed.get(p.id) as number;
  const listedFirst = (list: readonly MenuInput[]) => list.filter((p) => listed.has(p.id)).sort((a, b) => rank(a) - rank(b));
  // A product listed from a category the menu does not name brings its category, after.
  for (const p of listedFirst(products)) {
    const cid = p.categoryId;
    if (cid !== null && cid !== '' && !allOf.has(cid)) {
      order.push(cid);
      allOf.set(cid, false);
    }
  }
  const outCategories: string[] = [];
  const outProducts: MenuPlacement[] = [];
  for (const cid of order) {
    const inside = byCategory.get(cid) ?? [];
    const chosen = [...listedFirst(inside), ...(allOf.get(cid) ? inside.filter((p) => !listed.has(p.id)) : [])];
    if (chosen.length === 0) continue;
    outCategories.push(cid);
    for (const p of chosen) {
      const own = prices.get(p.id) ?? null;
      outProducts.push({ id: p.id, categoryId: cid, priceAgorot: own ?? p.priceAgorot, source: own !== null ? 'menu' : 'catalog' });
    }
  }
  return { categories: outCategories, products: outProducts };
}

/** What the menu mode places over `products`: the menu applied, nothing to sell, or null for the catalog as it is. */
export function appliedFor(block: unknown, resolution: Pick<MenuResolution, 'mode' | 'menuId'>, products: readonly MenuInput[]): MenuApplied | null {
  if (resolution.mode === 'catalog') return null;
  if (resolution.mode === 'none') return NOTHING;
  return applyMenu(menuOf(block, resolution.menuId), products);
}

/** The cloud's `sellable()`: the resolution on the till's clock, and the menu applied (null: the catalog as it is). */
export function sellableAt(block: unknown, at: Date, products: readonly MenuInput[]): { resolution: MenuResolution; applied: MenuApplied | null } {
  const resolution = resolveTillMenu(block, at);
  return { resolution, applied: appliedFor(block, resolution, products) };
}

/* ------------------------------------------------------------- the catalog */

/** A catalog product as the menu lays itself on it. */
export interface MenuCatalogProduct extends TillMenuFacts {
  id: string;
  categoryId: string | null;
  /** Shekels (display). */
  price: number;
  priceAgorot: number;
}

/**
 * The till's catalog as the active menu presents it (CatalogMenus.present): a menu — only what it places, its categories and
 * products in ITS order, each at its listed price (else the catalog's) carrying the menu it was offered under; "לא למכור" —
 * nothing; the catalog — the same object back, untouched. Everything else about a product (its sale state, its lock, its
 * restriction) is as built.
 */
export function presentTillCatalog<C extends { id: string }, P extends MenuCatalogProduct>(
  catalog: { categories: C[]; products: P[] },
  block: unknown,
  resolution: Pick<MenuResolution, 'mode' | 'menuId' | 'menuName'>,
): { categories: C[]; products: P[] } {
  const applied = appliedFor(block, resolution, catalog.products.map((p) => ({ id: p.id, categoryId: p.categoryId, priceAgorot: p.priceAgorot })));
  if (applied === null) return catalog;
  const byId = new Map(catalog.products.map((p) => [p.id, p] as const));
  const categories = new Map(catalog.categories.map((c) => [c.id, c] as const));
  return {
    categories: applied.categories.map((id) => categories.get(id)).filter((c): c is C => c !== undefined),
    products: applied.products.map((at) => {
      const p = byId.get(at.id) as P;
      return { ...p, price: at.priceAgorot / 100, priceAgorot: at.priceAgorot, menuId: resolution.menuId, menuName: resolution.menuName ?? null, priceSource: at.source };
    }),
  };
}

/** What a sold line records of a product's menu: nothing when no menu was active when it was priced (PriceSource.of). */
export function lineMenuFacts(p: TillMenuFacts): { menuId: string; menuName: string | null; priceSource: TillPriceSource } | null {
  return p.menuId ? { menuId: p.menuId, menuName: p.menuName ?? null, priceSource: p.priceSource ?? 'catalog' } : null;
}
