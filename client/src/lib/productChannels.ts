/**
 * "מופיע ב" — the four channels a product appears in (pos-server app/services/product_channels.py,
 * specs/digital-menu-ordering-cards-plan.md §4). Self-contained, so `npm test` compiles it alone.
 *
 * - `pos` — "קופה": the tills' sell screen (quick order and tables too);
 * - `kiosk` — "קיוסק": the self-order kiosk;
 * - `online` — "הזמנות אונליין": the online ordering site;
 * - `menu` — "תפריט דיגיטלי": the view-only digital menu.
 *
 * The tills' and kiosks' pair is the product's `salesChannel` (all / kiosk_only / pos_only, and
 * `none` — neither); the web channels start off: a product reaches the public only through a
 * published profile. A shop or a point of sale may differ for a channel (an exception); the
 * nearest level that says wins. This is not a block: "חסום" / "אזל" always win, apart.
 */

export const CHANNELS = ['pos', 'kiosk', 'online', 'menu'] as const;
export type Channel = (typeof CHANNELS)[number];
export type Channels = Record<Channel, boolean>;

export const DEVICE_CHANNELS: readonly Channel[] = ['pos', 'kiosk'];
export const WEB_CHANNELS: readonly Channel[] = ['online', 'menu'];

/** The he.json key (under `productChannels`) of each channel's name. */
export const CHANNEL_LABEL_KEYS: Record<Channel, string> = {
  pos: 'pos',
  kiosk: 'kiosk',
  online: 'online',
  menu: 'menu',
};

/** Every product so far: the tills and the kiosks, the web channels off. */
export const DEFAULT_CHANNELS: Channels = { pos: true, kiosk: true, online: false, menu: false };

export type StoredCode = 'all' | 'kiosk_only' | 'pos_only' | 'none';

export function isChannel(value: unknown): value is Channel {
  return typeof value === 'string' && (CHANNELS as readonly string[]).includes(value);
}

/** `[tills, kiosks]` of a stored code; a missing or unknown one is both (as the server reads it). */
export function pairOf(code: unknown): [boolean, boolean] {
  switch (code) {
    case 'kiosk_only':
      return [false, true];
    case 'pos_only':
      return [true, false];
    case 'none':
      return [false, false];
    default:
      return [true, true];
  }
}

export function codeOfPair(pos: boolean, kiosk: boolean): StoredCode {
  if (pos && kiosk) return 'all';
  if (kiosk) return 'kiosk_only';
  if (pos) return 'pos_only';
  return 'none';
}

/** The product's channels: `channels` from the server when whole, else from `salesChannel` (web off). */
export function channelsOf(product: { channels?: unknown; salesChannel?: unknown } | null | undefined): Channels {
  const raw = product?.channels;
  if (raw && typeof raw === 'object') {
    const value = raw as Record<string, unknown>;
    if (CHANNELS.every((c) => typeof value[c] === 'boolean')) {
      return { pos: !!value.pos, kiosk: !!value.kiosk, online: !!value.online, menu: !!value.menu };
    }
  }
  const [pos, kiosk] = pairOf(product?.salesChannel);
  return { pos, kiosk, online: false, menu: false };
}

/** Only the channels that differ (what a save sends). */
export function channelsPatch(before: Channels, after: Channels): Partial<Channels> {
  const out: Partial<Channels> = {};
  for (const c of CHANNELS) if (before[c] !== after[c]) out[c] = after[c];
  return out;
}

/** The list's chips: nothing for a product as every product was (tills + kiosks, no web); else what is on. */
export function channelChips(channels: Channels): Channel[] {
  const isDefault = CHANNELS.every((c) => channels[c] === DEFAULT_CHANNELS[c]);
  if (isDefault) return [];
  return CHANNELS.filter((c) => channels[c]);
}

/** Nowhere at all: the list says so. */
export function appearsNowhere(channels: Channels): boolean {
  return CHANNELS.every((c) => !channels[c]);
}

export type ChannelSource = 'product' | 'shop' | 'area';

export interface ChannelOverride {
  id?: string;
  level: 'shop' | 'area';
  targetId: string;
  targetName?: string | null;
  shopId?: string | null;
  shopName?: string | null;
  channel: Channel;
  allowed: boolean;
  updatedBy?: string | null;
  updatedAt?: string | null;
}

/** Each channel at a shop / point of sale and from where (the server's `resolve`, same rule). */
export function effectiveAt(
  defaults: Channels,
  overrides: readonly ChannelOverride[],
  shopId: string | null | undefined,
  areaId?: string | null,
): Record<Channel, { allowed: boolean; source: ChannelSource }> {
  const out = {} as Record<Channel, { allowed: boolean; source: ChannelSource }>;
  for (const c of CHANNELS) {
    const area = areaId ? overrides.find((o) => o.channel === c && o.level === 'area' && o.targetId === areaId) : undefined;
    const shop = shopId ? overrides.find((o) => o.channel === c && o.level === 'shop' && o.targetId === shopId) : undefined;
    const hit = area ?? shop;
    out[c] = hit ? { allowed: hit.allowed, source: hit.level } : { allowed: defaults[c], source: 'product' };
  }
  return out;
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
  set: Partial<Channels>,
  dryRun: boolean,
): { selection: { ids?: string[]; allMatching?: BulkFilter }; set: Partial<Channels>; dryRun: boolean } {
  const clean: Partial<Channels> = {};
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
  sample: { id: string; name: string; before: Channels; after: Channels }[];
  applied: boolean;
}
