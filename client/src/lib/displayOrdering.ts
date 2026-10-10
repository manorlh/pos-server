/**
 * "סדר תצוגה" — the one ordering editor of the four channels (pos-server
 * app/services/display_ordering.py, app/services/display_ordering_rules.py). Self-contained, so
 * `npm test` compiles it alone. The order itself is the server's; this module only moves ids
 * around the lists the editor shows and builds what it saves.
 *
 * An ordering: the categories' order, each category's products, the pinned ones (first, in their
 * own order) and where items with no position go. Positions are kept for hidden and blocked items
 * too — the shown lists filter after ordering, so nothing else moves.
 */

export type OrderingChannel = 'pos' | 'kiosk' | 'online' | 'menu';
export type OrderingLevel = 'tenant' | 'company' | 'shop' | 'area' | 'machine' | 'profile';

/** The levels each channel has, widest first (as the server's CHANNEL_LEVELS). */
export const CHANNEL_LEVELS: Record<OrderingChannel, OrderingLevel[]> = {
  pos: ['tenant', 'company', 'shop', 'area', 'machine'],
  kiosk: ['company', 'shop', 'machine'],
  online: ['tenant', 'company', 'shop', 'area', 'profile'],
  menu: ['tenant', 'company', 'shop', 'area', 'profile'],
};

export interface Ordering {
  categories: string[];
  products: Record<string, string[]>;
  pinned: { categories: string[]; products: Record<string, string[]> };
  newItems: 'end' | 'by_name';
}

export interface OrderingView {
  channel: OrderingChannel;
  level: OrderingLevel;
  targetId: string;
  targetName: string;
  effective: Ordering;
  source: { level: OrderingLevel | null; targetId: string | null; kind: 'binding' | 'legacy' | 'catalog' };
  binding: { id: string; orderingId: string; copiedFromOrderingId: string | null; copiedAt: string | null } | null;
  ordering: (Ordering & { id: string | null; version: number; implicit?: boolean }) | null;
  linkedWith: { channel: OrderingChannel; channelLabel: string; level: OrderingLevel; levelLabel: string; targetId: string; targetName: string | null }[];
  linkedLabel: string | null;
  diverged: boolean;
  catalog?: { categories: { id: string; name: string; sortOrder: number }[]; products: { id: string; name: string; categoryId: string | null; price: number | null }[] };
  arranged?: { categories: string[]; products: Record<string, string[]> };
}

export function emptyOrdering(): Ordering {
  return { categories: [], products: {}, pinned: { categories: [], products: {} }, newItems: 'end' };
}

/** `list` with the item at `from` moved to `to` (indices; out of range: unchanged). */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  if (from < 0 || from >= list.length || to < 0 || to >= list.length || from === to) return [...list];
  const out = [...list];
  const [item] = out.splice(from, 1);
  out.splice(to, 0, item);
  return out;
}

/** "מיקום מספרי": `id` to 1-based `position` (clamped). */
export function moveToPosition(list: readonly string[], id: string, position: number): string[] {
  const from = list.indexOf(id);
  if (from < 0 || !Number.isFinite(position)) return [...list];
  const to = Math.min(Math.max(Math.round(position) - 1, 0), list.length - 1);
  return moveItem(list, from, to);
}

export function togglePinned(pinned: readonly string[], id: string): string[] {
  return pinned.includes(id) ? pinned.filter((p) => p !== id) : [...pinned, id];
}

/** Pinned first (in their order), then the rest as listed — what the devices and the web show. */
export function pinnedFirst(pinned: readonly string[], list: readonly string[]): string[] {
  const set = new Set(pinned.filter((p) => list.includes(p)));
  return [...pinned.filter((p) => set.has(p)), ...list.filter((i) => !set.has(i))];
}

/**
 * The ordering the editor saves from what it shows: the arranged categories and products (the
 * catalog's items with no position included, so the save is the whole visible order) and the pins.
 */
export function orderingFromEditor(
  categories: readonly string[],
  products: Record<string, readonly string[]>,
  pinned: { categories: readonly string[]; products: Record<string, readonly string[]> },
  newItems: Ordering['newItems'] = 'end',
): Ordering {
  const pinnedProducts: Record<string, string[]> = {};
  for (const [cid, ids] of Object.entries(pinned.products)) if (ids.length) pinnedProducts[cid] = [...ids];
  const out: Record<string, string[]> = {};
  for (const [cid, ids] of Object.entries(products)) if (ids.length) out[cid] = [...ids];
  return {
    categories: [...categories],
    products: out,
    pinned: { categories: [...pinned.categories], products: pinnedProducts },
    newItems,
  };
}

/** "מקושר ל…" when the server has no label (an older one): the channels and targets it moves with. */
export function linkedText(view: Pick<OrderingView, 'linkedWith' | 'linkedLabel'>): string | null {
  if (view.linkedLabel) return view.linkedLabel;
  if (!view.linkedWith.length) return null;
  return `מקושר ל${view.linkedWith.map((l) => `${l.channelLabel} (${l.targetName ?? l.levelLabel})`).join(', ')}`;
}
