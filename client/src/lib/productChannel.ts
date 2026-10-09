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
