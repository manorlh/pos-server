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
 * The block's shape may grow (targets, channels, a kiosk look — pos-server feat/item-block-targets):
 * this module reads only what the rule needs ([itemBlockOf]) and ignores the rest.
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
}

export interface SoldOutDecision {
  state: SoldOutState;
  /** manual | auto | stock; null when available or blocked. */
  reason: string | null;
  block: ItemBlock | null;
  untilMs: number | null;
}

/** Nearest first (SoldOutRules.SCOPE_ORDER). */
export const BLOCK_SCOPE_ORDER = ['machine', 'kiosk', 'area', 'group', 'event', 'kiosks', 'shop', 'company'] as const;

const AVAILABLE: SoldOutDecision = { state: 'available', reason: null, block: null, untilMs: null };

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
  };
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

export function blockCovers(b: ItemBlock, till: BlockTill): boolean {
  const has = (v: string | null | undefined): v is string => typeof v === 'string' && v.length > 0;
  switch (b.scope) {
    case 'company':
      return has(till.companyId) && b.scopeId === till.companyId;
    case 'shop':
      return has(till.shopId) && b.scopeId === till.shopId;
    case 'kiosks':
      return !!till.isKiosk && has(till.shopId) && b.scopeId === till.shopId;
    case 'area':
      return has(till.areaId) && b.scopeId === till.areaId;
    case 'machine':
      return has(till.machineId) && b.scopeId === till.machineId;
    case 'kiosk':
      return !!till.isKiosk && has(till.machineId) && b.scopeId === till.machineId;
    case 'event':
      return (till.eventIds ?? []).includes(b.scopeId);
    case 'group':
      return (till.groupIds ?? []).includes(b.scopeId);
    default:
      return false;
  }
}

const rank = (b: ItemBlock) => {
  const i = (BLOCK_SCOPE_ORDER as readonly string[]).indexOf(b.scope);
  return i < 0 ? BLOCK_SCOPE_ORDER.length : i;
};

/** The block shown: the nearest scope, then the newest (SoldOutRules.nearest). */
export function nearestBlock(blocks: readonly ItemBlock[]): ItemBlock | null {
  let best: ItemBlock | null = null;
  for (const b of blocks) {
    if (best === null) {
      best = b;
      continue;
    }
    const dr = rank(b) - rank(best);
    const created = (x: ItemBlock) => blockTimeMs(x.createdAt) ?? Number.MIN_SAFE_INTEGER;
    if (dr < 0 || (dr === 0 && created(b) > created(best))) best = b;
  }
  return best;
}

/**
 * What a device shows and allows for one product (SoldOutRules.decide). `till` null: the blocks were
 * already filtered for this device by the cloud (the catalog row) — only their ends are checked.
 */
export function decideSoldOut(
  blocks: readonly ItemBlock[],
  nowMs: number,
  opts: { till?: BlockTill | null; setting?: unknown; trackStock?: boolean; stock?: number | null } = {},
): SoldOutDecision {
  const live = blocks.filter((b) => blockInForce(b.until, nowMs) && (!opts.till || blockCovers(b, opts.till)));
  const hard = live.filter((b) => b.kind === 'blocked');
  if (hard.length > 0) {
    const shown = nearestBlock(hard)!;
    return { state: 'blocked', reason: null, block: shown, untilMs: blockTimeMs(shown.until) };
  }
  const soft = live.filter((b) => b.kind !== 'blocked');
  if (soft.length > 0) {
    const shown = nearestBlock(soft)!;
    return { state: 'sold_out', reason: shown.source === 'auto' ? 'auto' : 'manual', block: shown, untilMs: blockTimeMs(shown.until) };
  }
  if (autoSoldOutOn(opts.setting) && opts.trackStock === true && (opts.stock ?? 0) <= 0) return { state: 'sold_out', reason: 'stock', block: null, untilMs: null };
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
