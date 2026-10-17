/**
 * The rules of the two-pane product & category picker
 * (components/dashboard/catalog/product-category-picker.tsx), shared by the menus, the
 * promotions and the production vouchers. Pure: no React, no network — pinned by
 * catalogPicker.test.ts.
 *
 * A selection is an ordered list of categories, each either "whole" (every product in it,
 * the listed ones first) or partial (only its listed products), and an ordered list of
 * individually listed products. A screen that cannot take whole categories (a goods
 * voucher's items) picks with `whole: false`: ticking a category then lists its products one
 * by one. Ticking a category takes its sub-categories with it.
 */

export interface PickerCategory {
  id: string;
  name: string;
  parentId: string | null;
  isActive?: boolean;
  sortOrder?: number;
}

export interface PickerProduct {
  id: string;
  name: string;
  /** Null, or a category the picker does not know: under "ללא קטגוריה". */
  categoryId: string | null;
  price: number;
  sku?: string | null;
  isActive?: boolean;
  inStock?: boolean;
  tags?: string[];
  /** Why it cannot be picked here (shown, greyed); null/absent — it can. */
  blocked?: string | null;
  /** Short things to know, shown as badges. */
  notes?: string[];
}

/** The tree's node for products without a known category. */
export const UNCATEGORIZED = '__none__';

export interface PickedCategory {
  id: string;
  whole: boolean;
}

export interface PickerSelection {
  categories: PickedCategory[];
  products: string[];
}

export const EMPTY_SELECTION: PickerSelection = { categories: [], products: [] };

export interface CatalogIndex {
  categories: Map<string, PickerCategory>;
  /** Ordered children by parent id ('' — the roots). */
  children: Map<string, string[]>;
  products: Map<string, PickerProduct>;
  /** Products by their tree node (a category id or [UNCATEGORIZED]), in catalog order. */
  byNode: Map<string, PickerProduct[]>;
  /** Every product, in catalog order (by node, the tree's order). */
  all: PickerProduct[];
  /** The node and every node under it (memoised). */
  subtree: (id: string) => string[];
  /** "שתייה › קלה". */
  path: (id: string) => string;
  /** The node a product sits under. */
  nodeOf: (productId: string) => string;
}

const ROOT = '';

function byOrder(a: PickerCategory, b: PickerCategory): number {
  return (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name, 'he');
}

export function buildIndex(categories: readonly PickerCategory[], products: readonly PickerProduct[]): CatalogIndex {
  const cats = new Map<string, PickerCategory>();
  for (const c of categories) cats.set(c.id, c);
  const children = new Map<string, string[]>();
  const sorted = [...cats.values()].sort(byOrder);
  for (const c of sorted) {
    // A parent the picker does not know, or a loop to itself: a root.
    const parent = c.parentId && cats.has(c.parentId) && c.parentId !== c.id ? c.parentId : ROOT;
    const list = children.get(parent) ?? [];
    list.push(c.id);
    children.set(parent, list);
  }
  // Guard against parent cycles: anything not reachable from the roots becomes a root.
  const reached = new Set<string>();
  const walk = (id: string) => {
    for (const c of children.get(id) ?? []) {
      if (reached.has(c)) continue;
      reached.add(c);
      walk(c);
    }
  };
  walk(ROOT);
  for (const c of sorted) {
    if (!reached.has(c.id)) {
      for (const list of children.values()) {
        const i = list.indexOf(c.id);
        if (i >= 0) list.splice(i, 1);
      }
      children.set(ROOT, [...(children.get(ROOT) ?? []), c.id]);
      reached.add(c.id);
      walk(c.id);
    }
  }

  const productMap = new Map<string, PickerProduct>();
  const byNode = new Map<string, PickerProduct[]>();
  const node = (p: PickerProduct) => (p.categoryId && cats.has(p.categoryId) ? p.categoryId : UNCATEGORIZED);
  for (const p of products) {
    if (productMap.has(p.id)) continue;
    productMap.set(p.id, p);
    const k = node(p);
    const list = byNode.get(k) ?? [];
    list.push(p);
    byNode.set(k, list);
  }
  const all: PickerProduct[] = [];
  const order: string[] = [];
  const flatten = (id: string) => {
    for (const c of children.get(id) ?? []) {
      order.push(c);
      flatten(c);
    }
  };
  flatten(ROOT);
  order.push(UNCATEGORIZED);
  for (const id of order) all.push(...(byNode.get(id) ?? []));

  const subtrees = new Map<string, string[]>();
  const subtree = (id: string): string[] => {
    const hit = subtrees.get(id);
    if (hit) return hit;
    const out = [id];
    for (const c of children.get(id) ?? []) out.push(...subtree(c));
    subtrees.set(id, out);
    return out;
  };
  const path = (id: string): string => {
    const names: string[] = [];
    let c = cats.get(id);
    let guard = 0;
    while (c && guard++ < 20) {
      names.unshift(c.name);
      c = c.parentId && c.parentId !== c.id ? cats.get(c.parentId) : undefined;
    }
    return names.join(' › ');
  };
  const nodeOf = (productId: string) => {
    const p = productMap.get(productId);
    return p ? node(p) : UNCATEGORIZED;
  };
  return { categories: cats, children, products: productMap, byNode, all, subtree, path, nodeOf };
}

/** The roots of the tree, in order. */
export function rootsOf(index: CatalogIndex): string[] {
  return index.children.get(ROOT) ?? [];
}

const selectable = (p: PickerProduct | undefined): p is PickerProduct => !!p && !p.blocked;

function wholeSet(sel: PickerSelection): Set<string> {
  return new Set(sel.categories.filter((c) => c.whole).map((c) => c.id));
}

/** Is the product picked (listed, or in a whole category). */
export function isPicked(index: CatalogIndex, sel: PickerSelection, productId: string): boolean {
  if (sel.products.includes(productId)) return true;
  const node = index.nodeOf(productId);
  return node !== UNCATEGORIZED && sel.categories.some((c) => c.whole && c.id === node);
}

/** A fast membership test over many products. */
export function pickedSet(index: CatalogIndex, sel: PickerSelection): Set<string> {
  const out = new Set(sel.products);
  for (const id of wholeSet(sel)) for (const p of index.byNode.get(id) ?? []) if (selectable(p)) out.add(p.id);
  return out;
}

export interface NodeCount {
  picked: number;
  total: number;
}

/** "12/30": picked of the pickable products in the node and its sub-categories. */
export function nodeCount(index: CatalogIndex, picked: ReadonlySet<string>, id: string): NodeCount {
  const nodes = id === UNCATEGORIZED ? [UNCATEGORIZED] : index.subtree(id);
  let total = 0;
  let n = 0;
  for (const node of nodes) {
    for (const p of index.byNode.get(node) ?? []) {
      if (!selectable(p)) continue;
      total++;
      if (picked.has(p.id)) n++;
    }
  }
  return { picked: n, total };
}

export type CheckState = 'all' | 'some' | 'none';

/** The tree checkbox: all / some (partial) / none. An empty category: whole or not. */
export function nodeState(index: CatalogIndex, sel: PickerSelection, picked: ReadonlySet<string>, id: string): CheckState {
  const { picked: n, total } = nodeCount(index, picked, id);
  if (total === 0) {
    const whole = wholeSet(sel);
    const nodes = id === UNCATEGORIZED ? [] : index.subtree(id);
    if (!nodes.length) return 'none';
    const w = nodes.filter((x) => whole.has(x)).length;
    return w === nodes.length ? 'all' : w ? 'some' : 'none';
  }
  return n === 0 ? 'none' : n === total ? 'all' : 'some';
}

/** Drop partial categories left with no listed product. */
function tidy(index: CatalogIndex, sel: PickerSelection): PickerSelection {
  const listedNodes = new Set(sel.products.map((id) => index.nodeOf(id)));
  return {
    categories: sel.categories.filter((c) => c.whole || listedNodes.has(c.id)),
    products: sel.products,
  };
}

function ensureCategory(cats: PickedCategory[], id: string, whole: boolean): PickedCategory[] {
  if (id === UNCATEGORIZED) return cats;
  const i = cats.findIndex((c) => c.id === id);
  if (i < 0) return [...cats, { id, whole }];
  if (whole && !cats[i].whole) return cats.map((c, j) => (j === i ? { ...c, whole: true } : c));
  return cats;
}

export interface PickOptions {
  /** Whole categories allowed (default). False: a category's products are listed one by one. */
  whole?: boolean;
}

/** Tick (on) or untick a tree node, with its sub-categories. */
export function setNode(
  index: CatalogIndex,
  sel: PickerSelection,
  id: string,
  on: boolean,
  opts: PickOptions = {},
): PickerSelection {
  const whole = opts.whole !== false;
  const nodes = id === UNCATEGORIZED ? [UNCATEGORIZED] : index.subtree(id);
  if (on) {
    if (!whole || id === UNCATEGORIZED) {
      const ids: string[] = [];
      for (const node of nodes) for (const p of index.byNode.get(node) ?? []) if (selectable(p)) ids.push(p.id);
      return setProducts(index, sel, ids, true, opts);
    }
    let cats = sel.categories;
    for (const node of nodes) cats = ensureCategory(cats, node, true);
    return { categories: cats, products: sel.products };
  }
  const drop = new Set(nodes);
  return {
    categories: sel.categories.filter((c) => !drop.has(c.id)),
    products: sel.products.filter((p) => !drop.has(index.nodeOf(p))),
  };
}

/**
 * Pick (on) or unpick products. Picking lists them (blocked ones are skipped). Unpicking one
 * of a whole category turns the category partial with the rest of its products listed, in
 * the order shown — nothing else changes for the owner.
 */
export function setProducts(
  index: CatalogIndex,
  sel: PickerSelection,
  ids: readonly string[],
  on: boolean,
  opts: PickOptions = {},
): PickerSelection {
  void opts;
  if (on) {
    const have = pickedSet(index, sel);
    const add = ids.filter((id) => !have.has(id) && selectable(index.products.get(id)));
    if (!add.length) return sel;
    let cats = sel.categories;
    for (const id of add) cats = ensureCategory(cats, index.nodeOf(id), false);
    return { categories: cats, products: [...sel.products, ...add] };
  }
  const remove = new Set(ids);
  let next = sel;
  const whole = wholeSet(sel);
  const opened = new Set<string>();
  for (const id of ids) {
    const node = index.nodeOf(id);
    if (whole.has(node) && !opened.has(node)) {
      opened.add(node);
      next = materialize(index, next, node);
    }
  }
  next = {
    categories: next.categories.map((c) => (opened.has(c.id) ? { ...c, whole: false } : c)),
    products: next.products.filter((p) => !remove.has(p)),
  };
  return tidy(index, next);
}

/**
 * The products of one node as shown: its listed ones in their order, then (a whole category)
 * the rest in catalog order.
 */
export function nodeProducts(index: CatalogIndex, sel: PickerSelection, node: string): PickerProduct[] {
  const listed = sel.products.filter((id) => index.nodeOf(id) === node).map((id) => index.products.get(id)).filter(
    (p): p is PickerProduct => !!p,
  );
  const isWhole = sel.categories.some((c) => c.whole && c.id === node);
  if (!isWhole) return listed;
  const seen = new Set(listed.map((p) => p.id));
  return [...listed, ...(index.byNode.get(node) ?? []).filter((p) => selectable(p) && !seen.has(p.id))];
}

/** List every product of a whole category (in the order shown), so each can carry its own setting. */
export function materialize(index: CatalogIndex, sel: PickerSelection, node: string): PickerSelection {
  const shown = nodeProducts(index, sel, node);
  const listed = new Set(sel.products);
  const add = shown.filter((p) => !listed.has(p.id)).map((p) => p.id);
  return add.length ? { categories: sel.categories, products: [...sel.products, ...add] } : sel;
}

/** Every picked product, in the order shown: by category order, then the listed ones of no picked category. */
export function pickedInOrder(index: CatalogIndex, sel: PickerSelection): PickerProduct[] {
  const out: PickerProduct[] = [];
  const seen = new Set<string>();
  for (const c of sel.categories) {
    for (const p of nodeProducts(index, sel, c.id)) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      out.push(p);
    }
  }
  for (const id of sel.products) {
    if (seen.has(id)) continue;
    const p = index.products.get(id);
    if (!p) continue;
    seen.add(id);
    out.push(p);
  }
  return out;
}

/** The ids between [anchor] and [id] (inclusive) in the visible list — a shift-click range. */
export function rangeIds(visible: readonly string[], anchor: string | null, id: string): string[] {
  const b = visible.indexOf(id);
  const a = anchor === null ? -1 : visible.indexOf(anchor);
  if (b < 0) return [];
  if (a < 0) return [id];
  const [from, to] = a <= b ? [a, b] : [b, a];
  return visible.slice(from, to + 1);
}

export interface ProductFilter {
  search?: string;
  status?: 'all' | 'active' | 'inactive';
  stock?: 'all' | 'in' | 'out';
  tag?: string | null;
  /** Only the picked ones (a set from [pickedSet]). */
  onlyPicked?: ReadonlySet<string> | null;
}

/** Lower case, no niqqud / geresh variants, single spaces. */
export function normalizeSearch(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[֑-ׇ]/g, '')
    .replace(/[׳'`]/g, "'")
    .replace(/[״"]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

export function matchesFilter(p: PickerProduct, f: ProductFilter, q: string = normalizeSearch(f.search ?? '')): boolean {
  if (f.status === 'active' && p.isActive === false) return false;
  if (f.status === 'inactive' && p.isActive !== false) return false;
  if (f.stock === 'in' && p.inStock === false) return false;
  if (f.stock === 'out' && p.inStock !== false) return false;
  if (f.tag && !(p.tags ?? []).includes(f.tag)) return false;
  if (f.onlyPicked && !f.onlyPicked.has(p.id)) return false;
  if (!q) return true;
  const terms = q.split(' ');
  const hay = normalizeSearch(`${p.name} ${p.sku ?? ''}`);
  return terms.every((t) => hay.includes(t));
}

/** The list pane: the focused node's products (with its sub-categories), or a search over all. */
export function visibleProducts(index: CatalogIndex, focus: string | null, f: ProductFilter): PickerProduct[] {
  const q = normalizeSearch(f.search ?? '');
  let source: PickerProduct[];
  if (q || focus === null) source = index.all;
  else if (focus === UNCATEGORIZED) source = index.byNode.get(UNCATEGORIZED) ?? [];
  else source = index.subtree(focus).flatMap((n) => index.byNode.get(n) ?? []);
  return source.filter((p) => matchesFilter(p, f, q));
}

/** Every tag the catalog's products carry, sorted. */
export function tagsOf(index: CatalogIndex): string[] {
  const s = new Set<string>();
  for (const p of index.all) for (const t of p.tags ?? []) s.add(t);
  return [...s].sort((a, b) => a.localeCompare(b, 'he'));
}

function moveIn<T>(list: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return [...list];
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/** Reorder the picked categories. */
export function moveCategory(sel: PickerSelection, id: string, toIndex: number): PickerSelection {
  const from = sel.categories.findIndex((c) => c.id === id);
  return { categories: moveIn(sel.categories, from, Math.max(0, Math.min(toIndex, sel.categories.length - 1))), products: sel.products };
}

/**
 * Move a product within its category to [toIndex] of the order shown. A whole category is
 * listed first (materialize) so the new order holds.
 */
export function moveProduct(index: CatalogIndex, sel: PickerSelection, id: string, toIndex: number): PickerSelection {
  const node = index.nodeOf(id);
  const base = materialize(index, sel, node);
  const shown = nodeProducts(index, base, node).map((p) => p.id);
  const from = shown.indexOf(id);
  if (from < 0) return sel;
  const reordered = moveIn(shown, from, Math.max(0, Math.min(toIndex, shown.length - 1)));
  // Put the node's products back where they were in the global list, in the new order.
  const slots: number[] = [];
  base.products.forEach((p, i) => {
    if (index.nodeOf(p) === node) slots.push(i);
  });
  const products = [...base.products];
  slots.forEach((slot, i) => {
    products[slot] = reordered[i];
  });
  return { categories: base.categories, products };
}

/* ---------- whole categories with or without their sub-categories ---------- */

/**
 * Whole categories as a screen that reads "a category includes its sub-categories" stores
 * them: a whole category whose parent is whole too is left out.
 */
export function compressWhole(index: CatalogIndex, ids: readonly string[]): string[] {
  const set = new Set(ids);
  return ids.filter((id) => {
    const parent = index.categories.get(id)?.parentId;
    return !(parent && set.has(parent));
  });
}

/** The reverse: a stored category stands for itself and every sub-category under it. */
export function expandWhole(index: CatalogIndex, ids: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const nodes = index.categories.has(id) ? index.subtree(id) : [id];
    for (const n of nodes) {
      if (seen.has(n)) continue;
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

/** A group-style screen's value (products + whole categories) as a selection. */
export function selectionOf(index: CatalogIndex, categoryIds: readonly string[], productIds: readonly string[]): PickerSelection {
  const categories: PickedCategory[] = categoryIds.map((id) => ({ id, whole: true }));
  const have = new Set(categoryIds);
  for (const id of productIds) {
    const node = index.nodeOf(id);
    if (node !== UNCATEGORIZED && !have.has(node)) {
      have.add(node);
      categories.push({ id: node, whole: false });
    }
  }
  return { categories, products: [...productIds] };
}

/** The reverse: whole categories and the products listed outside them. */
export function groupOf(index: CatalogIndex, sel: PickerSelection): { categoryIds: string[]; productIds: string[] } {
  const whole = wholeSet(sel);
  return {
    categoryIds: sel.categories.filter((c) => c.whole).map((c) => c.id),
    productIds: sel.products.filter((id) => !whole.has(index.nodeOf(id))),
  };
}

/* ---------- prices (the menus' "מחיר בתפריט") ---------- */

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * A price for each product: `set` — the same price; `percent` — the base price changed by
 * [value] percent (−10: ten percent off), never below 0. Prices as text with up to 2 decimals.
 */
export function bulkPrices(
  products: readonly { id: string; price: number }[],
  mode: 'set' | 'percent',
  value: number,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!Number.isFinite(value)) return out;
  for (const p of products) {
    const next = mode === 'set' ? value : (p.price ?? 0) * (1 + value / 100);
    out[p.id] = String(round2(Math.max(0, next)));
  }
  return out;
}
