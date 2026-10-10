/**
 * "אזל" / "חסום" on the kiosk — ONE TypeScript port of the Android till's rule (pos-android
 * domain/SoldOutRules.kt, the cloud's app/services/sold_out_rules.py; the shared golden
 * server/tests/fixtures/sold_out_golden.json) and of the Android kiosk's use of it
 * (domain/KioskCatalogView.kt `soldOut`), for the Windows kiosk (`@dash-lib/kioskSoldOut`) and the
 * browser kiosk:
 *
 *  - the catalog row's availability is its LOCK (`lockAvailable`; an older cloud: `isAvailable`) —
 *    the cloud folds a hand block into `isAvailable` at the pull, but never its automatic one
 *    (stock reached 0), and a block's end must lift it here, offline, at its time;
 *  - the blocks in force that reach this device come on the row (`blocks`, filtered by the cloud);
 *    the kiosk decides them with its OWN clock: "blocked" or "sold_out" in force → not sold
 *    (a kiosk has no manager to override), each until its `until` (an absolute instant);
 *  - a product that tracks stock with none here (no level = 0) is sold out;
 *  - `general.soldOutMode` "hide" leaves such a product out, else it shows greyed
 *    (lib/kioskConfig.ts `kioskCatalogView`).
 *
 * The block's shape (pos-server feat/item-block-targets, the golden's v5): a LEVEL (`scope` / `scopeId`)
 * and CHANNELS (`pos` / `kiosk` / `online` / `menu`) — where at that level it stops the item; a block
 * written before channels has a `target` (all / kiosks / tills) read as channels, and the two older
 * scopes `kiosks` / `kiosk` are kiosk-only; it names a product (`productId`) or a category
 * (`categoryId`); `kioskDisplay` ("hide" / "grey") is the kiosk's own look for it. This module reads
 * exactly what the rule needs ([itemBlockOf]) and ignores the rest.
 *
 * Pure; no imports (the node tests compile it alone).
 */

export type SoldOutState = 'available' | 'sold_out' | 'blocked';

export interface ItemBlock {
  id: string;
  scope: string;
  scopeId: string;
  kind: string;
  /** manual | auto (the cloud: stock reached 0). */
  source: string;
  until: string | null;
  createdAt: string | null;
  by: string | null;
  note: string | null;
  /** Whom at the level, before channels: all | kiosks | tills (null = all, every block before targets). */
  target: string | null;
  /** The channels it stops the item on; null = none written (its target's, SoldOutRules.channelsOf). */
  channels: string[] | null;
  /** The product it names, or null. */
  productId: string | null;
  /** The category it names (every product in it or below it), or null. */
  categoryId: string | null;
  /** A kiosk's own look for this block: "hide" / "grey"; null = `general.soldOutMode`. */
  kioskDisplay: string | null;
}

/** The four channels, in their order: "קופה" / "קיוסק" / "הזמנות אונליין" / "תפריט דיגיטלי". */
export const BLOCK_CHANNELS = ['pos', 'kiosk', 'online', 'menu'] as const;

/** The product a block is checked against: its id, and its category with every one above it (SoldOutRules.Item). */
export interface BlockItem {
  productId?: string | null;
  categoryIds?: readonly string[];
}

/** Who a device is, for [blockCovers] (SoldOutRules.Till). */
export interface BlockTill {
  companyId?: string | null;
  shopId?: string | null;
  areaId?: string | null;
  machineId?: string | null;
  isKiosk?: boolean;
  eventIds?: readonly string[];
  groupIds?: readonly string[];
  /** The channel it asks for: null = its device's ("kiosk" for a kiosk, else "pos"); "online" / "menu". */
  channel?: string | null;
}

export interface SoldOutDecision {
  state: SoldOutState;
  /** manual | auto | stock; null when available or blocked. */
  reason: string | null;
  block: ItemBlock | null;
  untilMs: number | null;
  /** On a kiosk: "hide" / "grey" asked by a block in force; null = `general.soldOutMode`. */
  display: string | null;
}

/** Nearest first (SoldOutRules.SCOPE_ORDER). */
export const BLOCK_SCOPE_ORDER = ['machine', 'kiosk', 'area', 'group', 'event', 'kiosks', 'shop', 'company'] as const;

const AVAILABLE: SoldOutDecision = { state: 'available', reason: null, block: null, untilMs: null, display: null };

/** One block as the row carries it (SoldOutRules.blockOf); null without an id. Unknown keys are ignored. */
export function itemBlockOf(o: unknown): ItemBlock | null {
  if (!o || typeof o !== 'object') return null;
  const r = o as Record<string, unknown>;
  const text = (k: string): string | null => (typeof r[k] === 'string' && (r[k] as string).length > 0 ? (r[k] as string) : null);
  const plain = (k: string): string => (r[k] === null || r[k] === undefined ? '' : String(r[k]));
  const id = plain('id');
  if (!id) return null;
  return {
    id,
    scope: plain('scope'),
    scopeId: plain('scopeId'),
    kind: text('kind') ?? 'sold_out',
    source: text('source') ?? 'manual',
    until: text('until'),
    createdAt: text('createdAt'),
    by: text('by'),
    note: text('note'),
    target: text('target'),
    channels: channelsIn(r.channels),
    productId: text('productId'),
    categoryId: text('categoryId'),
    kioskDisplay: text('kioskDisplay'),
  };
}

/** A channels value (a list, or "pos,kiosk") in the channels' order, unknown names dropped; null if absent (SoldOutRules.channelsIn). */
export function channelsIn(value: unknown): string[] | null {
  let items: string[];
  if (typeof value === 'string') items = value.split(',').map((v) => v.trim());
  else if (Array.isArray(value)) items = value.map((v) => String(v));
  else return null;
  return BLOCK_CHANNELS.filter((c) => items.includes(c));
}

export function itemBlocksOf(list: unknown): ItemBlock[] {
  return (Array.isArray(list) ? list : []).map(itemBlockOf).filter((b): b is ItemBlock => b !== null);
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2}(?::\d{2})?)?$/;

/**
 * An ISO-8601 instant ("Z", an offset, or none = UTC) in epoch ms; null for none or unreadable
 * (SoldOutRules.parseMs: OffsetDateTime, else LocalDateTime at UTC — never a date alone).
 */
export function blockTimeMs(value: string | null | undefined): number | null {
  const text = value?.trim();
  if (!text) return null;
  const m = ISO.exec(text);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, frac, zone] = m;
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = s ? Number(s) : 0;
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  const local = Date.UTC(Number(y), month - 1, day, hour, minute, second, frac ? Number(frac.slice(0, 3).padEnd(3, '0')) : 0);
  // A day the month does not have (31 April) is not a date (java.time refuses it).
  if (new Date(local).getUTCDate() !== day) return null;
  if (!zone || zone === 'Z') return local;
  const sign = zone[0] === '-' ? -1 : 1;
  const [oh, om, os] = zone.slice(1).split(':').map(Number);
  if (oh > 18 || om > 59 || (os ?? 0) > 59) return null;
  return local - sign * ((oh * 60 + om) * 60 + (os ?? 0)) * 1000;
}

/** `autoSoldOutAtZero` as a settings layer stores it: on unless explicitly off (SoldOutRules.autoOn). */
export function autoSoldOutOn(setting: unknown): boolean {
  if (setting === null || setting === undefined) return true;
  if (typeof setting === 'boolean') return setting;
  if (typeof setting === 'number') return setting !== 0;
  if (typeof setting === 'string') return !['false', '0', 'no', 'off'].includes(setting.trim().toLowerCase());
  return true;
}

/** A block with this `until` is still in force at `nowMs`; an end that cannot be read: in force. */
export function blockInForce(until: string | null | undefined, nowMs: number): boolean {
  if (!until || !until.trim()) return true;
  const end = blockTimeMs(until);
  return end === null ? true : nowMs < end;
}

/** What each target meant, as channels (SoldOutRules.TARGET_CHANNELS). */
const TARGET_CHANNELS: Record<string, readonly string[]> = { all: ['pos', 'kiosk'], kiosks: ['kiosk'], tills: ['pos'] };

/** The two older scopes: their level, and the target they always meant (SoldOutRules.LEGACY_SCOPES). */
const LEGACY_SCOPES: Record<string, readonly [string, string]> = { kiosks: ['shop', 'kiosks'], kiosk: ['machine', 'kiosks'] };

/** The level alone (an older kiosks / kiosk scope: shop / machine). */
export function levelName(b: ItemBlock): string {
  return LEGACY_SCOPES[b.scope]?.[0] ?? b.scope;
}

/**
 * The channels a block stops the item on: its own `channels`; a block with none, what its target meant
 * (no target = all = pos + kiosk). An older kiosks / kiosk scope is for kiosks only (with target tills it
 * contradicts itself: none) — SoldOutRules.channelsOf.
 */
export function channelsOf(b: ItemBlock): readonly string[] {
  if (b.channels === null) {
    const target = b.target ?? 'all';
    const legacy = LEGACY_SCOPES[b.scope];
    if (legacy !== undefined) return target === 'all' || target === 'kiosks' ? TARGET_CHANNELS[legacy[1]] : [];
    return TARGET_CHANNELS[target] ?? [];
  }
  return b.scope in LEGACY_SCOPES ? b.channels.filter((c) => c === 'kiosk') : b.channels;
}

/** The channel a device asks for (SoldOutRules.Till.deviceChannel). */
export function deviceChannel(till: BlockTill): string {
  return till.channel || (till.isKiosk ? 'kiosk' : 'pos');
}

function levelCovers(level: string, sid: string, till: BlockTill): boolean {
  const has = (v: string | null | undefined): v is string => typeof v === 'string' && v.length > 0;
  switch (level) {
    case 'company':
      return has(till.companyId) && sid === till.companyId;
    case 'shop':
      return has(till.shopId) && sid === till.shopId;
    case 'area':
      return has(till.areaId) && sid === till.areaId;
    case 'machine':
      return has(till.machineId) && sid === till.machineId;
    case 'event':
      return (till.eventIds ?? []).includes(sid);
    case 'group':
      return (till.groupIds ?? []).includes(sid);
    default:
      return false;
  }
}

/** Whether the block reaches this device (or channel): its level covers it, and its channels name it (SoldOutRules.covers). */
export function blockCovers(b: ItemBlock, till: BlockTill): boolean {
  return channelsOf(b).includes(deviceChannel(till)) && levelCovers(levelName(b), b.scopeId, till);
}

/** Whether the block is about this product: itself, or its category (or one above it); no item: yes (SoldOutRules.applies). */
export function blockApplies(b: ItemBlock, item: BlockItem | null | undefined): boolean {
  if (!item) return true;
  if (b.productId !== null) return typeof item.productId === 'string' && item.productId.length > 0 && b.productId === item.productId;
  if (b.categoryId !== null) return (item.categoryIds ?? []).includes(b.categoryId);
  // Neither named (an older stored form): it came on this product's own row.
  return true;
}

const rank = (b: ItemBlock) => {
  const i = (BLOCK_SCOPE_ORDER as readonly string[]).indexOf(b.scope);
  return i < 0 ? BLOCK_SCOPE_ORDER.length : i;
};

/** A product's own block before its category's (SoldOutRules.categoryRank). */
const categoryRank = (b: ItemBlock) => (b.productId === null && b.categoryId !== null ? 1 : 0);

/** The block shown: the nearest level, then the product's own, then the newest (SoldOutRules.nearest). */
export function nearestBlock(blocks: readonly ItemBlock[]): ItemBlock | null {
  let best: ItemBlock | null = null;
  for (const b of blocks) {
    if (best === null) {
      best = b;
      continue;
    }
    const dr = rank(b) - rank(best) || categoryRank(b) - categoryRank(best);
    const created = (x: ItemBlock) => blockTimeMs(x.createdAt) ?? Number.MIN_SAFE_INTEGER;
    if (dr < 0 || (dr === 0 && created(b) > created(best))) best = b;
  }
  return best;
}

/** A kiosk's own look among blocks in force: "hide" wins, then "grey", else null (the setting) — SoldOutRules.displayOf. */
export function displayOf(live: readonly ItemBlock[]): string | null {
  if (live.some((b) => b.kioskDisplay === 'hide')) return 'hide';
  if (live.some((b) => b.kioskDisplay === 'grey')) return 'grey';
  return null;
}

/**
 * What a device shows and allows for one product (SoldOutRules.decide). `till` null: the blocks were
 * already filtered for this device by the cloud (the catalog row) — only their ends are checked.
 */
export function decideSoldOut(
  blocks: readonly ItemBlock[],
  nowMs: number,
  opts: { till?: BlockTill | null; setting?: unknown; trackStock?: boolean; stock?: number | null; item?: BlockItem | null } = {},
): SoldOutDecision {
  const live = blocks.filter((b) => blockInForce(b.until, nowMs) && (!opts.till || blockCovers(b, opts.till)) && blockApplies(b, opts.item));
  const display = displayOf(live);
  const hard = live.filter((b) => b.kind === 'blocked');
  if (hard.length > 0) {
    const shown = nearestBlock(hard)!;
    return { state: 'blocked', reason: null, block: shown, untilMs: blockTimeMs(shown.until), display };
  }
  const soft = live.filter((b) => b.kind !== 'blocked');
  if (soft.length > 0) {
    const shown = nearestBlock(soft)!;
    return { state: 'sold_out', reason: shown.source === 'auto' ? 'auto' : 'manual', block: shown, untilMs: blockTimeMs(shown.until), display };
  }
  if (autoSoldOutOn(opts.setting) && opts.trackStock === true && (opts.stock ?? 0) <= 0) return { state: 'sold_out', reason: 'stock', block: null, untilMs: null, display: null };
  return AVAILABLE;
}

/** The soonest end among the blocks still in force — when the kiosk must look again (SoldOutRules.nextEndMs). */
export function nextBlockEndMs(blocks: readonly ItemBlock[], nowMs: number): number | null {
  let out: number | null = null;
  for (const b of blocks) {
    const end = blockTimeMs(b.until);
    if (end !== null && end > nowMs && (out === null || end < out)) out = end;
  }
  return out;
}

/** What a catalog build needs for the sale states: this kiosk's stock levels by product id, and its clock. */
export interface SaleState {
  stock: Readonly<Record<string, number>>;
  nowMs: number;
}

/** A catalog row as the kiosk reads its sale state. */
export interface SoldOutRow {
  isAvailable?: unknown;
  lockAvailable?: unknown;
  inStock?: unknown;
  trackStock?: unknown;
  blocks?: unknown;
}

/** The row's availability: its lock, else (an older cloud) `isAvailable` (CatalogRepository's mapping). */
export function rowAvailable(row: SoldOutRow): boolean {
  const lock = typeof row.lockAvailable === 'boolean' ? row.lockAvailable : null;
  return (lock ?? row.isAvailable) !== false;
}

/**
 * Sold out on the kiosk now (KioskCatalogView.soldOut): locked, delisted, out of the stock it tracks
 * (`stock`: this kiosk's level of it; none = 0), or a block in force.
 */
export function kioskSoldOut(row: SoldOutRow, stock: number | null | undefined, nowMs: number): boolean {
  if (!rowAvailable(row) || row.inStock === false) return true;
  if (row.trackStock === true && (stock ?? 0) <= 0) return true;
  const blocks = itemBlocksOf(row.blocks);
  return blocks.length > 0 && decideSoldOut(blocks, nowMs).state !== 'available';
}

/** When a catalog's sale states change next by the clock alone (a block's end); null: not by the clock. */
export function catalogNextChangeMs(rows: readonly SoldOutRow[], nowMs: number): number | null {
  let out: number | null = null;
  for (const r of rows) {
    const end = nextBlockEndMs(itemBlocksOf(r.blocks), nowMs);
    if (end !== null && (out === null || end < out)) out = end;
  }
  return out;
}

/** The stock levels of `GET /sync/{m}/stock` (`levels[]`: productId, onHand), by product id. */
export function stockLevelsOf(body: unknown): Record<string, number> {
  const levels = body && typeof body === 'object' ? (body as { levels?: unknown }).levels : null;
  const out: Record<string, number> = {};
  for (const l of Array.isArray(levels) ? levels : []) {
    const r = l as Record<string, unknown>;
    const id = typeof r?.productId === 'string' ? r.productId : null;
    const on = typeof r?.onHand === 'number' ? r.onHand : typeof r?.onHand === 'string' && r.onHand.trim() ? Number(r.onHand) : NaN;
    if (id && Number.isFinite(on)) out[id] = on;
  }
  return out;
}
