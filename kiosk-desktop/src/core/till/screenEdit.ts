/**
 * "עריכת מסך" — arranging the till's sell screen, as the Android till does it (pos-android domain/ProductOrder.kt,
 * ui/sell/ArrangeMode.kt, SellViewModel `startArrange` … `finishArrange`, `setProductLocked`):
 *
 *  - opened from the ☰ menu ("ניהול", teal, Edit) — a manager's, or with a manager's code (CATALOG_WRITE); on unless the
 *    cloud's `screenEditEnabled` says false, and `hiddenMenuItems` may hide it (`screen_edit`);
 *  - the product buttons are dragged to their places (among the buttons on screen — a category or a search: they take,
 *    in their new order, the places they held in the whole list, `mergeShownOrder`), the category tabs too;
 *  - ✕ makes a product inactive ("ללא פעיל": a lock, shown dimmed, never sold) and + makes it active again — at this till,
 *    the point of sale or the shop (`PUT /sync/{m}/products/{id}/availability`);
 *  - "סיום" ("שמור" once something moved) saves the order to the cloud (`PUT /sync/{m}/product-order`) at the level the
 *    parameter `productOrderScope` names ("לשאול בקופה": the till asks) — the cloud writes `productOrder` /
 *    `categoryOrder` into that settings layer and every till under it gets it with its settings (offline too: the synced
 *    settings are kept). The till's catalog is already built in that order (main/kiosk/catalog.ts); while arranging, and
 *    until the settings pull brings the saved order back, `arrangeCatalog` lays the working order over the catalog.
 *
 * The edit mode changes only the order and the availability: the colours and pictures of the categories and the till's
 * design are the dashboard's ("עיצוב קופה", "צבע ותמונה למחלקה"); the till only reads them. Pure; tested in
 * test/tillScreenEdit.test.ts.
 */

import type { Catalog } from '../../shared/till/protocol';

/** The Android words (res/values/strings_arrange.xml, strings.xml sell_lock_*), word for word. */
export const SCREEN_EDIT_TEXT = {
  title: 'עריכת מסך',
  /** arrange_hint without "· מצלמה לתמונה": the Windows till takes no product pictures. */
  hint: 'החזיקו וגררו לסידור · ✕ ללא פעיל',
  done: 'סיום',
  doneSave: 'שמור',
  cancel: 'ביטול',
  ok: 'הבנתי',
  reason: 'עריכת מסך הקופה — סידור פריטים',
  needsManager: 'שמירה מהקופה דורשת מנהל או אישור מנהל.',
  offline: 'אין חיבור לענן — הסידור לא נשמר. נסו שוב כשהחיבור יחזור.',
  scopeMachine: 'בקופה הזו',
  scopeArea: 'בנקודת המכירה',
  scopeShop: 'בכל הסניף',
  removeTitle: (name: string) => `להפוך את “${name}” ללא פעיל?`,
  removeBody: 'הפריט יוצג מעומעם ולא יימכר עד שיופעל שוב (+). השינוי נרשם בענן ואפשר לבטל אותו בכל עת.',
  removeIn: (scope: string) => `ללא פעיל ${scope}`,
  restoreTitle: (name: string) => `להפעיל שוב את “${name}”?`,
  restoreIn: (scope: string) => `פעיל שוב ${scope}`,
  saveTitle: 'איפה לשמור את סידור הפריטים?',
  saveBody: 'הסדר נשמר בענן ומסתנכרן לכל הקופות שבהיקף שתבחרו.',
  saveFor: (scope: string) => `לשמור ${scope}`,
  categoriesHint: 'החזיקו מחלקה וגררו אותה למקומה',
  lockTitle: 'נעילת מוצר',
  locked: (name: string) => `${name} ננעל למכירה.`,
  unlocked: (name: string) => `הנעילה של ${name} שוחררה.`,
  lockFailed: (name: string) => `לא ניתן היה לשנות את הנעילה של ${name}.`,
  lockRefused: (name: string) => `הענן לא אישר את שינוי הנעילה של ${name}, והמוצר הוחזר למצבו בענן.`,
  lockNeedsManager: 'נעילת מוצר דורשת מנהל.',
} as const;

/** "עריכת מסך בקופה" (on unless false). */
export const PARAM_SCREEN_EDIT = 'screenEditEnabled';
/** Where "סיום" saves. */
export const PARAM_PRODUCT_ORDER_SCOPE = 'productOrderScope';
/** The permission the edit mode and its writes need (Android ElevationScope.CATALOG_WRITE). */
export const SCREEN_EDIT_CODE = 'CATALOG_WRITE';

export type OrderScope = 'machine' | 'area' | 'shop';

/** The edit mode as the screens draw it (TillState `screenEdit`; absent while nobody is signed in). */
export interface ScreenEditState {
  /** The menu row may be offered: the parameter on, the route not refused by an older cloud, CATALOG_WRITE not hidden. */
  available: boolean;
  /** Arranging now: the tiles are moved, not sold. */
  on: boolean;
  /** "סיום" sent, waiting for the cloud. */
  saving: boolean;
  /** Something moved: the bar says "שמור" (else "סיום"). */
  dirty: boolean;
  /** A ✕ / + on its way to the cloud: that product's id. */
  lockBusy: string | null;
}

/** The order laid over the catalog: null — that list is left as the catalog has it. */
export interface ArrangeOrder {
  productIds: string[] | null;
  categoryIds: string[] | null;
}

/** A switch of the cloud's that is on unless it says false (Android `onUnlessFalse`). */
export function onUnlessFalse(value: unknown): boolean {
  if (value === false || value === 0) return false;
  if (value === null || value === undefined) return true;
  return !['false', '0', 'לא', 'no'].includes(String(value).trim().toLowerCase());
}

export function screenEditEnabled(parameters: Record<string, unknown>): boolean {
  return onUnlessFalse(parameters[PARAM_SCREEN_EDIT]);
}

/** The parameter's Hebrew option (or its code); unset: the shop. `ask` — "לשאול בקופה". */
export function parseOrderScope(value: unknown): OrderScope | 'ask' {
  switch (typeof value === 'string' ? value.trim() : '') {
    case 'נקודת מכירה':
    case 'area':
      return 'area';
    case 'קופה':
    case 'machine':
      return 'machine';
    case 'לשאול בקופה':
    case 'ask':
      return 'ask';
    default:
      return 'shop';
  }
}

/** "סיום": the level to save at, or `ask` (the parameter says so, or a point of sale this till is not in). */
export function doneScope(parameter: unknown, hasArea: boolean): OrderScope | 'ask' {
  const s = parseOrderScope(parameter);
  if (s === 'area' && !hasArea) return 'ask';
  return s;
}

/** The levels offered (✕ / + in this order; "איפה לשמור" reversed): this till, its point of sale (when in one), the shop. */
export function scopeChoices(hasArea: boolean): Array<{ scope: OrderScope; label: string }> {
  const out: Array<{ scope: OrderScope; label: string }> = [{ scope: 'machine', label: SCREEN_EDIT_TEXT.scopeMachine }];
  if (hasArea) out.push({ scope: 'area', label: SCREEN_EDIT_TEXT.scopeArea });
  out.push({ scope: 'shop', label: SCREEN_EDIT_TEXT.scopeShop });
  return out;
}

/** A stored list: a JSON array, or the settings sync's `[a,b,c]` (Android `parseProductOrder`); junk reads as none. */
export function parseOrder(stored: unknown): string[] {
  let items: unknown[];
  if (Array.isArray(stored)) items = stored;
  else if (typeof stored === 'string') {
    const s = stored.trim();
    if (!s.startsWith('[') || !s.endsWith(']')) return [];
    items = s.slice(1, -1).split(',');
  } else return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of items) {
    if (typeof raw !== 'string' && typeof raw !== 'number') continue;
    const id = String(raw).trim().replace(/^"+|"+$/g, '').trim();
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/** `items` in `order` (by `idOf`): those on it first, as listed; the rest after, as they came. Stable (Android orderProducts). */
export function orderBy<T>(items: readonly T[], order: readonly string[], idOf: (t: T) => string): T[] {
  if (order.length === 0 || items.length < 2) return items.slice();
  const rank = new Map<string, number>();
  order.forEach((id, i) => {
    if (!rank.has(id)) rank.set(id, i);
  });
  return items
    .map((item, index) => ({ item, index, r: rank.get(idOf(item)) ?? Number.MAX_SAFE_INTEGER }))
    .sort((a, b) => a.r - b.r || a.index - b.index)
    .map((x) => x.item);
}

/** `ids` with the one at `from` moved to `to` (indices in `ids`; out of range or the same: unchanged). */
export function moved<T>(ids: readonly T[], from: number, to: number): T[] {
  if (from < 0 || to < 0 || from >= ids.length || to >= ids.length || from === to) return ids.slice();
  const out = ids.slice();
  const [x] = out.splice(from, 1);
  out.splice(to, 0, x);
  return out;
}

/**
 * The whole order after the buttons on screen were rearranged into `shown`: the products on screen take, in their new
 * order, the places they held in `full`; every other product keeps its place; anything shown that `full` did not know
 * goes at the end (Android `mergeShownOrder`).
 */
export function mergeShownOrder(full: readonly string[], shown: readonly string[]): string[] {
  const shownSet = new Set(shown);
  let i = 0;
  const out = full.map((id) => (shownSet.has(id) && i < shown.length ? shown[i++] : id));
  while (i < shown.length) out.push(shown[i++]);
  return [...new Set(out)];
}

/**
 * The button `fromId` dropped on `toId`'s place among `shown` (the ids on screen, in order): the new whole order, or null
 * when nothing moves (either is not on screen, or it is the same).
 */
export function moveAmongShown(full: readonly string[], shown: readonly string[], fromId: string, toId: string): string[] | null {
  const from = shown.indexOf(fromId);
  const to = shown.indexOf(toId);
  if (from < 0 || to < 0 || from === to) return null;
  return mergeShownOrder(full, moved(shown, from, to));
}

/** The category tab `fromId` dropped on `toId`'s place: the new order of all of them, or null. */
export function moveCategory(ids: readonly string[], fromId: string, toId: string): string[] | null {
  const from = ids.indexOf(fromId);
  const to = ids.indexOf(toId);
  if (from < 0 || to < 0 || from === to) return null;
  return moved(ids, from, to);
}

/**
 * The till's catalog snapshot in the arranged order (the engine's `catalogSnapshot` through this, while arranging and
 * until the saved order comes back with the settings). Departments keep their colours; nothing is added or dropped.
 */
export function arrangeCatalog(catalog: Catalog, order: ArrangeOrder | null): Catalog {
  if (!order || (!order.productIds && !order.categoryIds)) return catalog;
  return {
    ...catalog,
    departments: order.categoryIds ? orderBy(catalog.departments, order.categoryIds, (d) => d.id) : catalog.departments,
    products: order.productIds ? orderBy(catalog.products, order.productIds, (p) => p.id) : catalog.products,
  };
}

/** Two lists the same (the saved order came back with the settings). */
export function sameOrder(a: readonly string[] | null, b: readonly string[] | null): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** The cloud's answer to a write, read: ok / needs a manager (401/403) / the route missing (404) / anything else. */
export type WriteOutcome = 'ok' | 'manager' | 'missing' | 'refused' | 'offline';

export function writeOutcome(r: { kind: 'ok' } | { kind: 'offline' } | { kind: 'refused'; status: number }): WriteOutcome {
  if (r.kind === 'ok') return 'ok';
  if (r.kind === 'offline') return 'offline';
  if (r.status === 401 || r.status === 403) return 'manager';
  if (r.status === 404) return 'missing';
  return 'refused';
}

/** "סיום"'s notice for an answer that is not ok (Android finishArrange): a manager, else "אין חיבור לענן…". */
export function saveNotice(outcome: WriteOutcome): string | null {
  if (outcome === 'ok') return null;
  return outcome === 'manager' ? SCREEN_EDIT_TEXT.needsManager : SCREEN_EDIT_TEXT.offline;
}

/**
 * ✕ / +'s notice (Android setProductLocked): sent — "ננעל" / "שוחררה"; refused by the cloud (4xx) — "הוחזר למצבו";
 * offline or a server error — "לא ניתן היה לשנות" (the Windows till does not queue a lock).
 */
export function lockNotice(outcome: WriteOutcome, name: string, locked: boolean): string {
  if (outcome === 'ok') return locked ? SCREEN_EDIT_TEXT.locked(name) : SCREEN_EDIT_TEXT.unlocked(name);
  if (outcome === 'manager') return SCREEN_EDIT_TEXT.lockNeedsManager;
  if (outcome === 'refused' || outcome === 'missing') return SCREEN_EDIT_TEXT.lockRefused(name);
  return SCREEN_EDIT_TEXT.lockFailed(name);
}

/** The availability write's body: a lock is `active: false`; + releases this level's lock (`active: null` = inherit). */
export function lockBody(scope: OrderScope, locked: boolean): Record<string, unknown> {
  return { scope, active: locked ? false : null };
}
