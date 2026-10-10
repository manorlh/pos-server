/**
 * "היכן הפריט נמכר" as the product form edits it (pos-server app/services/sales_channel.py,
 * docs/SPEC_PRODUCT_CHANNELS.md). Self-contained, so `npm test` compiles it alone.
 *
 * - `all` — "קופות וקיוסק": every product so far, and the default for a new one.
 * - `kiosk_only` — "קיוסק בלבד": the tills' sell screen hides it.
 * - `pos_only` — "קופות בלבד": the self-order kiosk hides it.
 *
 * The tills and the kiosk apply it, and hide a category left with nothing to sell on their
 * channel. A missing or unknown value reads as `all`, as the server sends it.
 *
 * The form now edits "מופיע ב" (below), and `salesChannel` follows its pos / kiosk part.
 */

export const SALES_CHANNELS = ['all', 'kiosk_only', 'pos_only'] as const;
export type SalesChannel = (typeof SALES_CHANNELS)[number];

export const DEFAULT_SALES_CHANNEL: SalesChannel = 'all';

/** The he.json key (under `products`) of each choice's label. */
export const SALES_CHANNEL_LABEL_KEYS: Record<SalesChannel, string> = {
  all: 'salesChannelAll',
  kiosk_only: 'salesChannelKioskOnly',
  pos_only: 'salesChannelPosOnly',
};

export function isSalesChannel(value: unknown): value is SalesChannel {
  return typeof value === 'string' && (SALES_CHANNELS as readonly string[]).includes(value);
}

/** The stored value as the form shows it: anything but a known code is `all`. */
export function salesChannelOf(value: unknown): SalesChannel {
  return isSalesChannel(value) ? value : DEFAULT_SALES_CHANNEL;
}

/** Shown on the tills' sell screen. */
export function soldAtTills(value: unknown): boolean {
  return salesChannelOf(value) !== 'kiosk_only';
}

/** Shown at the self-order kiosk. */
export function soldAtKiosk(value: unknown): boolean {
  return salesChannelOf(value) !== 'pos_only';
}

/** The list's badge: only a product not sold everywhere says where it is. */
export function salesChannelBadgeKey(value: unknown): string | null {
  const channel = salesChannelOf(value);
  return channel === 'all' ? null : SALES_CHANNEL_LABEL_KEYS[channel];
}

// ── "מופיע ב" ────────────────────────────────────────────────────────────────
//
// The channels a product appears in (pos-server app/services/product_channels.py,
// specs/item-blocks-targets.md §11): "קופה", "קיוסק", "הזמנות אונליין", "תפריט דיגיטלי". A product
// that never had it set appears where "היכן הפריט נמכר" says — and not online nor in the digital
// menu: those start off until the product is published there. Saving a list sets `salesChannel`
// from its pos / kiosk part (the tills and the kiosks still read that).

export const APPEARS_IN_CHANNELS = ['pos', 'kiosk', 'online', 'menu'] as const;
export type AppearsInChannel = (typeof APPEARS_IN_CHANNELS)[number];

/** The he.json key (under `products`) of each channel's label. */
export const APPEARS_IN_LABEL_KEYS: Record<AppearsInChannel, string> = {
  pos: 'appearsInPos',
  kiosk: 'appearsInKiosk',
  online: 'appearsInOnline',
  menu: 'appearsInMenu',
};

/** Known channels only, each once, in the channels' order. */
export function orderedAppearsIn(values: readonly unknown[]): AppearsInChannel[] {
  return APPEARS_IN_CHANNELS.filter((c) => values.includes(c));
}

/** What "היכן הפריט נמכר" means as channels: never online, never the menu. */
export function appearsInFromSalesChannel(value: unknown): AppearsInChannel[] {
  const channel = salesChannelOf(value);
  if (channel === 'pos_only') return ['pos'];
  if (channel === 'kiosk_only') return ['kiosk'];
  return ['pos', 'kiosk'];
}

/** The product's "מופיע ב": its own list, else its `salesChannel`'s (online and the menu off). */
export function appearsInOf(product: { appearsIn?: unknown; salesChannel?: unknown }): AppearsInChannel[] {
  if (Array.isArray(product.appearsIn)) return orderedAppearsIn(product.appearsIn);
  return appearsInFromSalesChannel(product.salesChannel);
}

/** The `salesChannel` the pos / kiosk part means (in neither: `all`, as the server writes it). */
export function salesChannelForAppears(list: readonly AppearsInChannel[]): SalesChannel {
  const pos = list.includes('pos');
  const kiosk = list.includes('kiosk');
  if (pos && !kiosk) return 'pos_only';
  if (kiosk && !pos) return 'kiosk_only';
  return 'all';
}

/** The list with `channel` ticked or not, in order. */
export function withAppearsIn(list: readonly AppearsInChannel[], channel: AppearsInChannel, on: boolean): AppearsInChannel[] {
  return orderedAppearsIn(on ? [...list, channel] : list.filter((c) => c !== channel));
}

/** At neither the tills nor the kiosk ("לא יופיע בקופות ובקיוסקים"). */
export function appearsAtNoDevice(list: readonly AppearsInChannel[]): boolean {
  return !list.includes('pos') && !list.includes('kiosk');
}

/** The list's badge: null for today's default (exactly קופה + קיוסק), else the channels it appears in. */
export function appearsInBadge(product: { appearsIn?: unknown; salesChannel?: unknown }): AppearsInChannel[] | null {
  const list = appearsInOf(product);
  return list.length === 2 && list.includes('pos') && list.includes('kiosk') ? null : list;
}
