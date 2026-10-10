/**
 * "מופיע ב — עריכה בכמות": the bulk screen's requests (pos-server app/routers/product_channels.py),
 * over item-blocks' "מופיע ב" — the canonical model: `appearsIn` on the product (lib/productChannel.ts
 * `APPEARS_IN_CHANNELS`, `appearsInOf`). Self-contained, so `npm test` compiles it alone.
 *
 * A change switches one or more channels on or off for the rows ticked, or for "all matching" a
 * filter — run on the server, pages never loaded included; the dry run answers the counts first.
 */

export const CHANNELS = ['pos', 'kiosk', 'online', 'menu'] as const;
export type Channel = (typeof CHANNELS)[number];

/** The he.json key (under `productChannels`) of each channel's name. */
export const CHANNEL_LABEL_KEYS: Record<Channel, string> = {
  pos: 'pos',
  kiosk: 'kiosk',
  online: 'online',
  menu: 'menu',
};

export const WEB_CHANNELS: readonly Channel[] = ['online', 'menu'];

export function isChannel(value: unknown): value is Channel {
  return typeof value === 'string' && (CHANNELS as readonly string[]).includes(value);
}

/** A row of `GET /product-channels/list`: its channels as the server resolves them. */
export interface ChannelRow {
  id: string;
  name: string;
  categoryId: string | null;
  appearsIn: Channel[];
}

/** Whether a row appears in a channel (an unknown value never does). */
export function appearsInChannel(row: Pick<ChannelRow, 'appearsIn'>, channel: Channel): boolean {
  return Array.isArray(row.appearsIn) && row.appearsIn.includes(channel);
}

/** "all matching" or the ticked rows, for `POST /product-channels/bulk`. */
export interface BulkFilter {
  search?: string;
  categoryIds?: string[];
  channelOn?: Channel[];
  channelOff?: Channel[];
  companyId?: string;
}

export function bulkBody(
  selection: { ids: string[] } | { allMatching: BulkFilter },
  set: Partial<Record<Channel, boolean>>,
  dryRun: boolean,
): { selection: { ids?: string[]; allMatching?: BulkFilter }; set: Partial<Record<Channel, boolean>>; dryRun: boolean } {
  const clean: Partial<Record<Channel, boolean>> = {};
  for (const c of CHANNELS) if (typeof set[c] === 'boolean') clean[c] = set[c];
  if ('ids' in selection) return { selection: { ids: [...new Set(selection.ids)] }, set: clean, dryRun };
  const f = selection.allMatching;
  const filter: BulkFilter = {};
  if (f.search && f.search.trim()) filter.search = f.search.trim();
  if (f.categoryIds && f.categoryIds.length) filter.categoryIds = [...f.categoryIds];
  if (f.channelOn && f.channelOn.length) filter.channelOn = f.channelOn.filter(isChannel);
  if (f.channelOff && f.channelOff.length) filter.channelOff = f.channelOff.filter(isChannel);
  if (f.companyId) filter.companyId = f.companyId;
  return { selection: { allMatching: filter }, set: clean, dryRun };
}

/** The server's bulk answer. */
export interface BulkResult {
  matched: number;
  changed: number;
  unchanged: number;
  refused: number;
  refusedSample: { id: string; name: string | null; reason: string }[];
  sample: { id: string; name: string; before: Channel[]; after: Channel[] }[];
  applied: boolean;
}
