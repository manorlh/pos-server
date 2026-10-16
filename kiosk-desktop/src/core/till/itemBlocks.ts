/**
 * "חסימת פריטים מהקופה" — block / sold out an item or a department from the till, and release it (P:/specs/item-block-control.md,
 * P:/specs/item-blocks-targets.md; pos-android domain/ItemBlockControl.kt, domain/ItemBlocks.kt, ui/blocks/ItemBlockSheet.kt,
 * ui/blocks/ItemBlocksUi.kt, strings_item_blocks.xml; pos-server app/services/item_block_control.py, routers/item_blocks.py):
 *
 *  - what this till may block is the cloud's (`itemBlocks` — `role` managing / local / none, `localMaxLevel`, `localChannels`,
 *    `managingMaxLevel`, `releaseMode`, `localRelease`) and the user's (ITEM_BLOCK; ITEM_BLOCK_WIDE beyond the till's own
 *    reach) — the cloud checks both again and answers `allowed` itself to a till that says `item_block_control_v1`;
 *  - every write is the cloud's, at once (`POST /sync/{m}/item-blocks`, `…/{id}/clear`, the approver in `X-Pos-User-Id`);
 *    nothing is queued: offline, the blocks in force are read from the stored catalog, read-only;
 *  - the sale rule ("חסום" / "אזל") is the catalog's (the shared sold-out rules) — a block reaches it with the next catalog sync.
 *
 * Pure: the parameters, the cloud's answer, the clock in; the options, the request and the words out.
 */

export const ITEM_BLOCK_CAPABILITY = 'item_block_control_v1';

export type Channel = 'pos' | 'kiosk' | 'online' | 'menu';
export const ALL_CHANNELS: readonly Channel[] = ['pos', 'kiosk', 'online', 'menu'];
export type Level = 'machine' | 'area' | 'shop' | 'event';
export type Access = 'open' | 'approval' | 'locked_till' | 'locked_permission';
export type WideState = 'allow' | 'approval' | 'deny';

export interface ItemBlockPolicy {
  role: 'managing' | 'local' | 'none';
  localMaxLevel: 'machine' | 'area' | 'shop';
  localChannels: Channel[];
  managingMaxLevel: 'area' | 'shop';
  releaseMode: 'own_scope' | 'any_in_shop';
  localRelease: boolean;
  /** Read from the cloud's `itemBlocks` (false: the old rules — no limits). */
  fromCloud: boolean;
}

/** A till of a cloud without the control (or none set): managing, everything — the old rules. */
export const LEGACY_POLICY: ItemBlockPolicy = { role: 'managing', localMaxLevel: 'shop', localChannels: [...ALL_CHANNELS], managingMaxLevel: 'shop', releaseMode: 'own_scope', localRelease: true, fromCloud: false };

const low = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : '');

function channelsOf(v: unknown): Channel[] | null {
  const raw = Array.isArray(v) ? v.map((x) => low(x)) : typeof v === 'string' ? v.split(',').map((x) => x.trim().toLowerCase()) : null;
  if (!raw) return null;
  return ALL_CHANNELS.filter((c) => raw.includes(c));
}

/** The cloud's `itemBlocks` (an object, or its JSON text); each unknown value its default. Null — not a policy. */
export function policyOf(raw: unknown): ItemBlockPolicy | null {
  let o: unknown = raw;
  if (typeof raw === 'string') {
    if (!raw.trim().startsWith('{')) return null;
    try {
      o = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const r = o as Record<string, unknown>;
  const role = low(r.role);
  const lml = low(r.localMaxLevel);
  const mml = low(r.managingMaxLevel);
  const rm = low(r.releaseMode);
  const lr = r.localRelease;
  return {
    role: role === 'managing' || role === 'none' ? role : 'local',
    localMaxLevel: lml === 'machine' || lml === 'shop' ? lml : 'area',
    localChannels: channelsOf(r.localChannels) ?? ['pos'],
    managingMaxLevel: mml === 'area' ? 'area' : 'shop',
    releaseMode: rm === 'any_in_shop' ? 'any_in_shop' : 'own_scope',
    localRelease: typeof lr === 'boolean' ? lr : typeof lr === 'number' ? lr !== 0 : typeof lr === 'string' ? low(lr) !== 'false' : true,
    fromCloud: true,
  };
}

/** `itemBlocks` from the till parameters, else the old rules. */
export const policyFromParameters = (p: Record<string, unknown>): ItemBlockPolicy => policyOf(p.itemBlocks) ?? LEGACY_POLICY;

export const mayBlock = (p: ItemBlockPolicy) => p.role !== 'none';
export const mayRelease = (p: ItemBlockPolicy) => p.role !== 'none' || p.localRelease;

const RANK: Record<string, number> = { machine: 0, area: 1, shop: 2, event: 2 };
export const levelRank = (l: string): number => RANK[l] ?? 3;

/** What this till may reach (must equal the server's `allowed_out`). */
export interface BlockReach {
  levels: Level[];
  channels: Channel[];
  localLevels: Level[];
  localChannels: Channel[];
  defaultLevel: Level | null;
  defaultChannels: Channel[];
}

export function reachOf(p: ItemBlockPolicy, hasArea: boolean): BlockReach {
  const all: Level[] = ['machine', ...(hasArea ? (['area'] as Level[]) : []), 'shop', 'event'];
  let cap = levelRank(p.localMaxLevel);
  if (cap === 1 && !hasArea) cap = 0;
  const local = all.filter((l) => levelRank(l) <= cap);
  let levels: Level[] = [];
  let channels: Channel[] = [];
  if (p.role === 'local') {
    levels = local;
    channels = [...p.localChannels];
  } else if (p.role === 'managing') {
    levels = all.filter((l) => levelRank(l) <= levelRank(p.managingMaxLevel));
    channels = [...ALL_CHANNELS];
  }
  const narrowLevels = local.filter((l) => levels.includes(l));
  const narrowChannels = p.localChannels.filter((c) => channels.includes(c));
  const defaultLevel = levels.length === 0 ? null : narrowLevels.includes('area') ? 'area' : (narrowLevels[0] ?? levels[0]);
  const defaultChannels = levels.length === 0 ? [] : narrowChannels.length > 0 ? narrowChannels : channels.slice(0, 1);
  return { levels, channels, localLevels: narrowLevels, localChannels: narrowChannels, defaultLevel, defaultChannels };
}

/** The cloud's `allowed` (a till with the capability), read; null — none sent. */
export function cloudReachOf(raw: unknown): BlockReach | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const lv = (v: unknown) => (Array.isArray(v) ? (v.filter((x) => ['machine', 'area', 'shop', 'event'].includes(String(x))) as Level[]) : []);
  const d = r.defaults && typeof r.defaults === 'object' ? (r.defaults as Record<string, unknown>) : null;
  const dl = d ? String(d.level ?? '') : '';
  return {
    levels: lv(r.levels),
    channels: channelsOf(r.channels) ?? [],
    localLevels: lv(r.localLevels),
    localChannels: channelsOf(r.localChannels) ?? [],
    defaultLevel: ['machine', 'area', 'shop', 'event'].includes(dl) ? (dl as Level) : null,
    defaultChannels: d ? (channelsOf(d.channels) ?? []) : [],
  };
}

/** The reach that limits the sheet: the cloud's, else the policy's when it came from the cloud; null — no limits (old rules). */
export function reachFor(p: ItemBlockPolicy, cloud: BlockReach | null, hasArea: boolean): BlockReach | null {
  if (cloud) return cloud;
  if (!p.fromCloud) return null;
  return reachOf(p, hasArea);
}

export function access(v: string, allowed: readonly string[], local: readonly string[], wide: WideState): Access {
  if (!allowed.includes(v)) return 'locked_till';
  if (local.includes(v)) return 'open';
  return wide === 'allow' ? 'open' : wide === 'approval' ? 'approval' : 'locked_permission';
}

const WORST: Record<Access, number> = { open: 0, approval: 1, locked_permission: 2, locked_till: 3 };

/** The request's access: the worst of its channels and its level ("another device" counts as the area). */
export function requestAccess(reach: BlockReach | null, channels: readonly Channel[], level: Level, wide: WideState): Access {
  if (!reach) return 'open';
  const all = [...channels.map((c) => access(c, reach.channels, reach.localChannels, wide)), access(level, reach.levels, reach.localLevels, wide)];
  return all.reduce((a, b) => (WORST[b] > WORST[a] ? b : a), 'open' as Access);
}

/** Beyond the till's own reach: ITEM_BLOCK_WIDE too. */
export function isWide(reach: BlockReach | null, channels: readonly Channel[], level: Level): boolean {
  if (!reach) return false;
  return !(channels.every((c) => reach.localChannels.includes(c)) && reach.localLevels.includes(level));
}

/** Another device of the point of sale counts as the area. */
export const effectiveLevel = (level: Level, levelId: string | null, machineId: string | null): Level => (level === 'machine' && levelId !== null && levelId !== machineId ? 'area' : level);

/** The levels offered (shop, the area when there is one, the device, an event when the shop has some). */
export const offeredLevels = (hasArea: boolean, hasEvents: boolean): Level[] => ['shop', ...(hasArea ? (['area'] as Level[]) : []), 'machine', ...(hasEvents ? (['event'] as Level[]) : [])];

/* ------------------------------------------------------------------ the blocks */

export interface BlockView {
  id: string;
  kind: 'sold_out' | 'blocked';
  source: string | null;
  until: string | null;
  createdAt: string | null;
  by: string | null;
  note: string | null;
  productId: string | null;
  categoryId: string | null;
  itemType: 'product' | 'category';
  itemName: string | null;
  categoryName: string | null;
  level: string | null;
  scopeName: string | null;
  channels: Channel[];
  kioskDisplay: string | null;
  origin: string | null;
  inForce: boolean;
  releasable: boolean;
  releaseNeeds: 'ITEM_BLOCK' | 'ITEM_BLOCK_WIDE' | null;
  releaseHint: string | null;
}

const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

export function blockOf(raw: unknown): BlockView | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = s(r.id);
  if (!id) return null;
  const target = s(r.target);
  let channels = channelsOf(r.channels) ?? [];
  if (channels.length === 0 && target === 'kiosks') channels = ['kiosk'];
  if (channels.length === 0 && (target === 'tills')) channels = ['pos'];
  if (channels.length === 0) channels = [...ALL_CHANNELS];
  const itemType = s(r.itemType) === 'category' || (!s(r.productId) && !!s(r.categoryId)) ? 'category' : 'product';
  const needs = s(r.releaseNeeds);
  return {
    id,
    kind: s(r.kind) === 'blocked' ? 'blocked' : 'sold_out',
    source: s(r.source),
    until: s(r.until),
    createdAt: s(r.createdAt),
    by: s(r.by),
    note: s(r.note),
    productId: s(r.productId),
    categoryId: s(r.categoryId),
    itemType,
    itemName: s(r.itemName) ?? s(r.productName),
    categoryName: s(r.categoryName),
    level: s(r.level) ?? (s(r.scope) === 'kiosks' ? 'shop' : s(r.scope)),
    scopeName: s(r.scopeName),
    channels,
    kioskDisplay: s(r.kioskDisplay),
    origin: s(r.origin),
    inForce: r.inForce !== false,
    releasable: typeof r.releasable === 'boolean' ? r.releasable : r.removable === true,
    releaseNeeds: needs === 'ITEM_BLOCK' || needs === 'ITEM_BLOCK_WIDE' ? needs : null,
    releaseHint: s(r.releaseHint),
  };
}

/** In force on the till's clock: no end, or an end still ahead (an unreadable one counts as in force). */
export function inForceAt(b: Pick<BlockView, 'until' | 'inForce'>, nowMs: number): boolean {
  if (!b.inForce) return false;
  if (!b.until) return true;
  const t = Date.parse(b.until);
  return !Number.isFinite(t) || t > nowMs;
}

/** The item's blocks in force (a department's through its chain): blocked first, then the soonest end. */
export function activeFor(blocks: readonly BlockView[], productIds: readonly string[], chain: ReadonlySet<string>, nowMs: number): BlockView[] {
  return blocks
    .filter((b) => inForceAt(b, nowMs))
    .filter((b) => (b.itemType === 'category' ? !!b.categoryId && chain.has(b.categoryId) : !!b.productId && productIds.includes(b.productId)))
    .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'blocked' ? -1 : 1) || (Date.parse(a.until ?? '') || Infinity) - (Date.parse(b.until ?? '') || Infinity));
}

/** A department and its parents (each node's ids), stopping at a loop. */
export function categoryChain(id: string | null, nodes: ReadonlyArray<{ id: string; cloudId?: string | null; parentId?: string | null }>): Set<string> {
  const out = new Set<string>();
  const seen = new Set<string>();
  let cur = id;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const n = nodes.find((x) => x.id === cur || x.cloudId === cur);
    out.add(cur);
    if (!n) break;
    out.add(n.id);
    if (n.cloudId) out.add(n.cloudId);
    cur = n.parentId ?? null;
  }
  return out;
}

export type ReleaseWhy = 'offline' | 'no_permission' | 'auto_stock' | 'company' | 'managing';

export const releaseNeedsWide = (b: BlockView, reach: BlockReach | null): boolean =>
  b.releaseNeeds === 'ITEM_BLOCK_WIDE' ? true : b.releaseNeeds === 'ITEM_BLOCK' ? false : isWide(reach, b.channels, (b.level as Level) ?? 'shop');

/** Why "שחרר" is not offered on a row (null: it is). */
export function releaseWhy(b: BlockView, live: boolean, reach: BlockReach | null, wide: WideState): ReleaseWhy | null {
  if (!live) return 'offline';
  if (b.releasable && wide === 'deny' && releaseNeedsWide(b, reach)) return 'no_permission';
  if (b.releasable) return null;
  if (b.source === 'auto' || b.origin === 'stock') return 'auto_stock';
  if (b.level === 'company' || b.level === 'group') return 'company';
  return 'managing';
}

/** The release's words (whyText): the server's hint wins but for "no permission" and offline. */
export function releaseWhyText(why: ReleaseWhy | null, hint: string | null): string | null {
  if (why === null || why === 'offline') return null;
  if (why === 'no_permission') return IB_TEXT.whyNoPermission;
  if (hint) return hint;
  return why === 'auto_stock' ? IB_TEXT.whyAuto : why === 'company' ? IB_TEXT.whyCompany : IB_TEXT.whyManaging;
}

/* ------------------------------------------------------------------ the request */

export type DurationChoice = { mode: 'minutes'; minutes: number } | { mode: 'time'; at: string } | { mode: 'end_of_day' } | { mode: 'none' };

/** "9:30" → "09:30", "1435" → "14:35"; "24:00", "12:60" → null. */
export function hhmmOf(raw: string): string | null {
  const m = /^(\d{1,2}):?(\d{2})$/.exec(raw.trim().replace('.', ':'));
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
}

export interface BlockRequest {
  productId?: string | null;
  categoryId?: string | null;
  kind: 'sold_out' | 'blocked';
  channels: Channel[];
  level: Level;
  levelId?: string | null;
  kioskDisplay?: 'hide' | 'grey' | null;
  note?: string | null;
  duration: DurationChoice;
}

/** Why a request cannot go (null: it can). */
export function requestRefusal(r: BlockRequest): string | null {
  if (!!r.productId === !!r.categoryId) return 'invalid';
  if (r.channels.length === 0 || r.channels.some((c) => !ALL_CHANNELS.includes(c))) return IB_TEXT.pickChannel;
  if (!['shop', 'area', 'machine', 'event'].includes(r.level)) return 'invalid';
  if (r.level === 'machine' && !r.channels.includes('pos') && !r.channels.includes('kiosk')) return 'invalid';
  if (r.level === 'event' && !r.levelId) return IB_TEXT.pickEvent;
  if (r.duration.mode === 'time' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(r.duration.at)) return IB_TEXT.badTime;
  if (r.duration.mode === 'minutes' && !(Number.isInteger(r.duration.minutes) && r.duration.minutes >= 1 && r.duration.minutes <= 10_080)) return 'invalid';
  return null;
}

/** The body of `POST /sync/{m}/item-blocks`, as Android sends it. */
export function requestBody(r: BlockRequest): Record<string, unknown> {
  const channels = ALL_CHANNELS.filter((c) => r.channels.includes(c));
  const note = r.note?.trim().slice(0, 200) || null;
  return {
    ...(r.productId ? { productId: r.productId } : { categoryId: r.categoryId }),
    kind: r.kind,
    channels,
    level: r.level,
    ...(r.levelId && (r.level === 'machine' || r.level === 'event') ? { levelId: r.levelId } : {}),
    ...(channels.includes('kiosk') && r.kioskDisplay ? { kioskDisplay: r.kioskDisplay } : {}),
    ...(note ? { note } : {}),
    duration: r.duration,
  };
}

const two = (n: number) => String(n).padStart(2, '0');

/** "עד HH:MM" the same day, "עד dd/MM HH:MM" another, "עד ביטול" — in the till's local time. */
export function untilText(until: string | null, nowMs: number): string {
  if (!until) return IB_TEXT.untilCancel;
  const t = Date.parse(until);
  if (!Number.isFinite(t)) return IB_TEXT.untilCancel;
  const d = new Date(t);
  const n = new Date(nowMs);
  const hm = `${two(d.getHours())}:${two(d.getMinutes())}`;
  const same = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  return same ? `עד ${hm}` : `עד ${two(d.getDate())}/${two(d.getMonth() + 1)} ${hm}`;
}

/** A refusal of the cloud in the till's words: the scope's own message, else "הענן סירב: …". */
export function refusalText(status: number, body: unknown): { text: string; needsWide: boolean } {
  const detail = body && typeof body === 'object' ? (body as { detail?: unknown }).detail : null;
  const d = detail && typeof detail === 'object' && !Array.isArray(detail) ? (detail as Record<string, unknown>) : null;
  const code = d ? s(d.code) : typeof detail === 'string' ? detail : null;
  const message = d ? s(d.message) : null;
  if (code === 'block_scope_not_allowed') return { text: message ?? IB_TEXT.scopeNotAllowed, needsWide: d?.needs === 'ITEM_BLOCK_WIDE' };
  return { text: IB_TEXT.refused(message ?? code ?? String(status)), needsWide: false };
}

/** Offline: the blocks in force read from the stored catalog's rows (removable never). */
export function blocksFromCatalog(products: ReadonlyArray<{ id?: unknown; name?: unknown; blocks?: unknown }>, nowMs: number): BlockView[] {
  const byId = new Map<string, BlockView>();
  for (const p of products) {
    const blocks = Array.isArray(p.blocks) ? p.blocks : [];
    for (const raw of blocks) {
      const b = blockOf({ ...(raw as Record<string, unknown>), productName: (raw as Record<string, unknown>)?.productName ?? p.name });
      if (!b || byId.has(b.id) || !inForceAt(b, nowMs)) continue;
      byId.set(b.id, { ...b, releasable: false });
    }
  }
  return [...byId.values()].sort((a, b) => (a.kind === b.kind ? (a.itemName ?? '').localeCompare(b.itemName ?? '') : a.kind === 'blocked' ? -1 : 1));
}

/* ------------------------------------------------------------------ the views */

/** One row as the screens show it. */
export interface BlockRowView {
  id: string;
  kind: 'sold_out' | 'blocked';
  words: ReturnType<typeof rowWords>;
  releasable: boolean;
  /** Releasing it needs ITEM_BLOCK_WIDE (the approval asks for it). */
  wide: boolean;
  why: string | null;
}

export interface BlocksListView {
  live: boolean;
  banner: string | null;
  rows: BlockRowView[];
  mayBlock: boolean;
}

export interface BlockOption<V extends string = string> {
  v: V;
  label: string;
  access: Access;
}

export interface BlockSheetView {
  title: string;
  productId: string | null;
  categoryId: string | null;
  live: boolean;
  banner: string | null;
  rows: BlockRowView[];
  releaseAll: number;
  mayBlock: boolean;
  /** The item and its department (a product in a department): "מה". */
  what: Array<{ v: 'product' | 'category'; label: string; id: string }>;
  channels: BlockOption<Channel>[];
  levels: BlockOption<Level>[];
  devices: Array<{ id: string; label: string; access: Access }>;
  events: Array<{ id: string; name: string }>;
  defaults: { channels: Channel[]; level: Level | null; kind: 'sold_out' | 'blocked' };
  notes: string[];
  machineId: string | null;
}


/* ------------------------------------------------------------------ the words */

export const CHANNEL_LABEL: Record<Channel, string> = { pos: 'קופה', kiosk: 'קיוסק', online: 'הזמנות אונליין', menu: 'תפריט דיגיטלי' };
export const LEVEL_LABEL: Record<string, string> = { shop: 'סניף', area: 'נקודת מכירה', machine: 'מכשיר', event: 'אירוע', company: 'חברה', group: 'קבוצת מכשירים' };
export const ORIGIN_LABEL: Record<string, string> = { dashboard: 'דשבורד', till: 'קופה', kiosk: 'קיוסק', controller: 'קופה שולטת', kiosk_hide: 'מוסתר בקיוסקים', stock: 'מלאי' };

/** A row in words (BlockRow). */
export function rowWords(b: BlockView, nowMs: number): { pill: string; name: string; level: string; channels: string; kiosk: string | null; auto: string | null; meta: string; note: string | null } {
  const level = `${LEVEL_LABEL[b.level ?? ''] ?? b.level ?? ''}${b.scopeName ? ` · ${b.scopeName}` : ''}`;
  const meta = [untilText(b.until, nowMs), b.by ? `ע״י ${b.by}` : null, b.origin ? (ORIGIN_LABEL[b.origin] ?? null) : null].filter(Boolean).join(' · ');
  return {
    pill: b.kind === 'blocked' ? IB_TEXT.kindBlocked : IB_TEXT.kindSoldOut,
    name: b.itemType === 'category' ? `מחלקה · ${b.categoryName ?? b.itemName ?? ''}` : (b.itemName ?? ''),
    level,
    channels: b.channels.map((c) => CHANNEL_LABEL[c]).join(' · '),
    kiosk: b.channels.includes('kiosk') ? (b.kioskDisplay === 'hide' ? 'מוסתר בקיוסק' : b.kioskDisplay === 'grey' ? 'באפור בקיוסק' : null) : null,
    auto: b.source === 'auto' ? 'אוטומטי — מלאי 0' : null,
    meta,
    note: b.note ? `“${b.note}”` : null,
  };
}

/** Android's words (strings_item_blocks.xml). */
export const IB_TEXT = {
  title: 'חסומים כעת',
  refresh: 'רענן',
  offline: 'אין חיבור — מוצג מהקטלוג השמור בקופה (לקריאה בלבד).',
  blockItem: 'חסום פריט',
  pickerTitle: 'בחרו פריט או מחלקה לחסימה',
  pickerSearch: 'חיפוש פריט או מחלקה',
  department: (name: string) => `מחלקה · ${name}`,
  empty: 'אין חסימות פעילות',
  loading: 'טוען…',
  releasedOne: 'החסימה בוטלה',
  sheetTitle: (name: string) => `חסום / אזל · ${name}`,
  sheetOffline: 'אין חיבור לענן — אי אפשר לחסום או לבטל עכשיו.',
  nowBlocked: 'חסום כעת',
  release: 'שחרר',
  releaseAll: (n: number) => `שחרר הכל (${n})`,
  notBlocked: 'הפריט לא חסום כעת',
  tillMayNot: 'קופה זו לא חוסמת פריטים — חוסמים מהקופה המנהלת או מהענן.',
  another: 'חסימה נוספת',
  what: 'מה',
  where: 'איפה',
  level: 'רמה',
  kind: 'סוג',
  kioskDisplay: 'תצוגה בקיוסק',
  duration: 'לכמה זמן',
  note: 'סיבה (לא חובה)',
  theItem: 'הפריט',
  wholeDepartment: 'כל המחלקה',
  withApproval: ' · באישור מנהל',
  pickChannel: 'בחרו לפחות ערוץ אחד',
  levelShop: (name: string | null) => (name ? `סניף · ${name}` : 'סניף'),
  levelArea: (name: string | null) => (name ? `נקודת מכירה ${name}` : 'נקודת מכירה'),
  levelMachine: 'מכשיר',
  levelEvent: 'אירוע',
  onlyManaging: 'רק בקופה המנהלת',
  noWide: 'אין לך הרשאה: חסימה מעבר לקופה',
  wideApproval: 'חסימה מעבר לקופה — יתבקש אישור מנהל.',
  onlyThisDevice: 'מקופה זו חוסמים רק אותה',
  pickEvent: 'בחרו אירוע',
  badTime: 'השעה חייבת להיות בתבנית HH:MM',
  kindSoldOut: 'אזל',
  kindBlocked: 'חסום',
  hintSoldOut: 'בקופה מוצג "אזל" — מכירה רק באישור מנהל.',
  hintBlocked: 'הקופה מסרבת למכור.',
  kioskDefault: 'לפי הגדרת הקיוסק',
  kioskHide: 'הסתר',
  kioskGrey: 'הצג כאזל',
  d30: '30 דק׳',
  d60: 'שעה',
  d120: 'שעתיים',
  dAt: 'עד שעה…',
  dEndOfDay: 'עד סוף היום',
  dNone: 'עד ביטול',
  atLabel: 'שעה (HH:MM)',
  confirmBlocked: 'חסום',
  confirmSoldOut: 'סמן אזל',
  cancel: 'ביטול',
  close: 'סגור',
  blockedUntil: (u: string) => `נחסם · ${u}`,
  soldOutUntil: (u: string) => `סומן אזל · ${u}`,
  untilCancel: 'עד ביטול',
  whyAuto: 'אזל אוטומטי במלאי 0 — משתחרר כשהמלאי מתעדכן, או מהענן',
  whyCompany: 'חסימה של החברה — שחרור מהענן',
  whyManaging: 'שחרור מהקופה המנהלת / מהענן',
  whyNoPermission: 'אין לך הרשאה לשחרר חסימה מעבר לקופה',
  refused: (what: string) => `הענן סירב: ${what}`,
  approve: 'אישור מנהל — חסימת פריט / אזל',
  approveWide: 'אישור מנהל — חסימה מעבר לקופה',
  released: 'שוחרר — הפריט חזר למכירה',
  releasedCount: (n: number) => `שוחררו ${n}`,
  scopeNotAllowed: 'מחוץ למה שמותר לקופה הזו — רק בקופה המנהלת',
} as const;
