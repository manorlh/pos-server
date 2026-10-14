/**
 * "חסימות מהקופה" and "חסימה מהירה" (P:/specs/item-block-control.md; pos-server
 * app/services/item_block_control.py, app/routers/item_blocks.py).
 *
 * The rules — which till may block what, who releases — are the server's. What lives here is what
 * the dashboard shows and sends: the `itemBlocks` setting at one level with what it inherits and from
 * where, the managing-till picker (several tills, or all of them), and the quick block's states.
 */
import { BLOCK_CHANNELS, CHANNEL_LABELS, orderedChannels, type BlockChannel } from './liveControl';

export type TillBlockRole = 'managing' | 'local' | 'none';
export type LocalMaxLevel = 'machine' | 'area' | 'shop';
export type ManagingMaxLevel = 'area' | 'shop';
export type ReleaseMode = 'own_scope' | 'any_in_shop';
export type QuickLevel = 'shop' | 'company';
export type QuickDurationMode = 'end_of_day' | 'none' | 'minutes';
export type QuickState = 'available' | 'sold_out' | 'blocked';
export type ControlLevel = 'company' | 'shop' | 'area' | 'machine';
/** Where a value comes from: a settings layer, the main till (`role`), or the default. */
export type ValueSource = 'tenant' | 'company' | 'shop' | 'area' | 'machine' | 'main_till' | 'default';

export const ROLES: readonly TillBlockRole[] = ['managing', 'local', 'none'];
export const LOCAL_MAX_LEVELS: readonly LocalMaxLevel[] = ['machine', 'area', 'shop'];
export const MANAGING_MAX_LEVELS: readonly ManagingMaxLevel[] = ['area', 'shop'];
export const RELEASE_MODES: readonly ReleaseMode[] = ['own_scope', 'any_in_shop'];
export const QUICK_LEVELS: readonly QuickLevel[] = ['shop', 'company'];
export const QUICK_DURATION_MODES: readonly QuickDurationMode[] = ['end_of_day', 'none', 'minutes'];

export interface QuickDuration {
  mode: QuickDurationMode;
  minutes?: number;
}

export interface QuickDefaults {
  channels: BlockChannel[];
  level: QuickLevel;
  duration: QuickDuration;
}

/** One level's own `itemBlocks` (every key optional: unset = inherit). */
export interface ItemBlocksSettings {
  role?: TillBlockRole;
  localMaxLevel?: LocalMaxLevel;
  localChannels?: BlockChannel[];
  managingMaxLevel?: ManagingMaxLevel;
  releaseMode?: ReleaseMode;
  localRelease?: boolean;
  quickDefaults?: QuickDefaults;
}
export type ItemBlocksKey = keyof ItemBlocksSettings;

/** What a till gets (`parameters.itemBlocks`): always all six. */
export interface TillItemBlocks {
  role: TillBlockRole;
  localMaxLevel: LocalMaxLevel;
  localChannels: BlockChannel[];
  managingMaxLevel: ManagingMaxLevel;
  releaseMode: ReleaseMode;
  localRelease: boolean;
}

export interface ControlTill {
  id: string;
  name: string;
  posNumber?: string | null;
  areaId: string | null;
  areaName?: string | null;
  isMainTill: boolean;
  ownRole: TillBlockRole | null;
  role: TillBlockRole;
  roleSource: ValueSource;
  itemBlocks: TillItemBlocks;
}

/** `GET /item-blocks/control?level=&id=`. */
export interface ControlView {
  level: ControlLevel;
  id: string;
  name?: string | null;
  own: ItemBlocksSettings;
  inherited: ItemBlocksSettings;
  inheritedFrom: Partial<Record<ItemBlocksKey, ValueSource>>;
  defaults: Required<Omit<ItemBlocksSettings, 'role'>>;
  canWrite: boolean;
  mainTill?: { id: string; name: string; posNumber?: string | null } | null;
  /** A shop's (or a point of sale's) tills, kiosks aside. */
  tills?: ControlTill[];
  /** A shop's points of sale, with their own role. */
  areas?: { id: string; name: string; ownRole: TillBlockRole | null }[];
  /** A till's own row. */
  till?: ControlTill;
}

export interface QuickBlockRow {
  id: string;
  kind: 'sold_out' | 'blocked';
  level: string;
  scopeName?: string | null;
  channels: BlockChannel[];
  until: string | null;
  by?: string | null;
  source?: 'manual' | 'auto';
  itemType?: 'product' | 'category';
  note?: string | null;
}

/** One product of `GET /item-blocks/quick`. */
export interface QuickItem {
  productId: string;
  name: string;
  sku?: string | null;
  imageUrl?: string | null;
  categoryName?: string | null;
  state: QuickState;
  until: string | null;
  scopeLevel: string | null;
  scopeName: string | null;
  blocks: QuickBlockRow[];
}

export interface QuickList {
  shop: { id: string; name: string };
  quickDefaults: QuickDefaults;
  items: QuickItem[];
}

// ── The Hebrew ────────────────────────────────────────────────────────────────

export const ROLE_LABELS: Record<TillBlockRole, string> = {
  managing: 'קופה מנהלת',
  local: 'קופה רגילה',
  none: 'אין חסימה',
};

export const ROLE_HINTS: Record<TillBlockRole, string> = {
  managing: 'חוסמת בכל היקף ובכל ערוץ, בגבולות הרשאת העובד.',
  local: 'חוסמת רק עד ההיקף ובערוצים שהוגדרו לקופה רגילה.',
  none: 'לא חוסמת. רואה את החסימות, ומשחררת רק אם "שחרור מקופה" דלוק.',
};

export const LOCAL_LEVEL_LABELS: Record<LocalMaxLevel, string> = {
  machine: 'רק הקופה',
  area: 'נקודת המכירה',
  shop: 'כל הסניף',
};

export const MANAGING_LEVEL_LABELS: Record<ManagingMaxLevel, string> = {
  area: 'נקודת המכירה שלה',
  shop: 'כל הסניף',
};

export const RELEASE_MODE_LABELS: Record<ReleaseMode, string> = {
  own_scope: 'מה שהקופה רשאית לחסום',
  any_in_shop: 'כל חסימה בסניף',
};

export const QUICK_LEVEL_LABELS: Record<QuickLevel, string> = {
  shop: 'הסניף',
  company: 'כל החברה',
};

export const QUICK_STATE_LABELS: Record<QuickState, string> = {
  available: 'זמין',
  sold_out: 'אזל',
  blocked: 'חסום',
};

export const SOURCE_LABELS: Record<ValueSource, string> = {
  tenant: 'מהמפיץ',
  company: 'מהחברה',
  shop: 'מהסניף',
  area: 'מנקודת המכירה',
  machine: 'מהקופה',
  main_till: 'הקופה הראשית',
  default: 'ברירת מחדל',
};

export function channelsText(channels: readonly BlockChannel[]): string {
  const list = orderedChannels(channels);
  if (list.length === BLOCK_CHANNELS.length) return 'כל הערוצים';
  return list.map((c) => CHANNEL_LABELS[c]).join(', ');
}

export function quickDurationText(d: QuickDuration): string {
  if (d.mode === 'none') return 'עד ביטול';
  if (d.mode === 'minutes') {
    const m = d.minutes ?? 0;
    if (m % 60 === 0 && m >= 60) return m === 60 ? 'שעה' : `${m / 60} שעות`;
    return `${m} דק׳`;
  }
  return 'עד סוף היום';
}

/** "כל הערוצים · הסניף · עד סוף היום". */
export function quickDefaultsText(q: QuickDefaults): string {
  return [channelsText(q.channels), QUICK_LEVEL_LABELS[q.level], quickDurationText(q.duration)].join(' · ');
}

// ── One level: own, inherited, default ───────────────────────────────────────

export interface Effective<T> {
  value: T | undefined;
  from: 'own' | 'inherited' | 'default';
  /** The layer it is inherited from. */
  source?: ValueSource;
}

/** The level's value for a key: its own, else inherited (and from where), else the default. */
export function effectiveOf<K extends ItemBlocksKey>(view: Pick<ControlView, 'own' | 'inherited' | 'inheritedFrom' | 'defaults'>, key: K): Effective<ItemBlocksSettings[K]> {
  if (view.own[key] !== undefined) return { value: view.own[key], from: 'own' };
  if (view.inherited[key] !== undefined) return { value: view.inherited[key], from: 'inherited', source: view.inheritedFrom[key] };
  const defaults = view.defaults as ItemBlocksSettings;
  return { value: defaults[key], from: 'default' };
}

/** The level's own object with `key` set — or removed (`undefined`: inherit again). */
export function withOwn<K extends ItemBlocksKey>(own: ItemBlocksSettings, key: K, value: ItemBlocksSettings[K] | undefined): ItemBlocksSettings {
  const next: ItemBlocksSettings = { ...own };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next;
}

/** What to send: the own object, or null when nothing is left (the level inherits everything). */
export function ownPayload(own: ItemBlocksSettings): ItemBlocksSettings | null {
  const out: ItemBlocksSettings = {};
  for (const [k, v] of Object.entries(own) as [ItemBlocksKey, unknown][]) {
    if (v !== undefined && v !== null) (out as Record<string, unknown>)[k] = v;
  }
  if (out.localChannels) out.localChannels = orderedChannels(out.localChannels);
  return Object.keys(out).length ? out : null;
}

export function sameOwn(a: ItemBlocksSettings, b: ItemBlocksSettings): boolean {
  return JSON.stringify(canonical(ownPayload(a))) === JSON.stringify(canonical(ownPayload(b)));
}

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])]));
  }
  return v;
}

/** The role a level shows when nothing sets one: "לפי הקופה הראשית". */
export function roleText(role: TillBlockRole | undefined, from: Effective<unknown>['from']): string {
  if (role) return ROLE_LABELS[role];
  return from === 'default' ? 'לפי הקופה הראשית (היא מנהלת, השאר רגילות)' : '';
}

// ── The managing-till picker ─────────────────────────────────────────────────

export interface ManagingPick {
  /** "כל הקופות": role = managing at the shop (or the point of sale). */
  all: boolean;
  /** The tills that are managing. */
  selected: string[];
}

/** The picker as the server stands: "all" when the level itself says managing; the managing tills. */
export function managingPickOf(view: Pick<ControlView, 'own' | 'tills'>): ManagingPick {
  return {
    all: view.own.role === 'managing',
    selected: (view.tills ?? []).filter((t) => t.role === 'managing').map((t) => t.id),
  };
}

/** "כל הקופות" switched: every till then (all on), or back to the main till alone (all off). */
export function toggleAll(pick: ManagingPick, tills: readonly ControlTill[], on: boolean): ManagingPick {
  if (on) return { all: true, selected: tills.map((t) => t.id) };
  const main = tills.find((t) => t.isMainTill);
  return { all: false, selected: main ? [main.id] : [] };
}

export function toggleTill(pick: ManagingPick, tillId: string, on: boolean): ManagingPick {
  const selected = on ? Array.from(new Set([...pick.selected, tillId])) : pick.selected.filter((id) => id !== tillId);
  return { ...pick, selected };
}

export function samePick(a: ManagingPick, b: ManagingPick): boolean {
  return a.all === b.all && [...a.selected].sort().join(',') === [...b.selected].sort().join(',');
}

/** "קופה ראשית (1) · קופה 3" / "כל הקופות" / "כל הקופות חוץ מ: בר" / "אין קופה מנהלת". */
export function managingSummary(pick: ManagingPick, tills: readonly ControlTill[]): string {
  const named = (t: ControlTill) => (t.posNumber ? `${t.name} (${t.posNumber})` : t.name);
  if (pick.all) {
    const out = tills.filter((t) => !pick.selected.includes(t.id));
    return out.length ? `כל הקופות חוץ מ: ${out.map(named).join(', ')}` : 'כל הקופות';
  }
  const chosen = tills.filter((t) => pick.selected.includes(t.id));
  return chosen.length ? chosen.map(named).join(' · ') : 'אין קופה מנהלת';
}

/** The body of `PUT /item-blocks/control/managing`. */
export function managingBody(shopId: string, areaId: string | null, pick: ManagingPick) {
  return { shopId, areaId: areaId ?? undefined, all: pick.all, machineIds: pick.selected };
}

// ── The quick block ──────────────────────────────────────────────────────────

/** Whether a tap changes anything: the state it already has does nothing. */
export function quickTapChanges(item: Pick<QuickItem, 'state'>, next: QuickState): boolean {
  return item.state !== next;
}

/** The line under a blocked product: "אזל · הסניף · עד 23:59" (the deciding block's scope). */
export function quickScopeText(item: Pick<QuickItem, 'state' | 'scopeName' | 'scopeLevel'>): string | null {
  if (item.state === 'available') return null;
  const where = item.scopeName || (item.scopeLevel ? item.scopeLevel : '');
  return [QUICK_STATE_LABELS[item.state], where].filter(Boolean).join(' · ');
}

/**
 * Blocks the quick "זמין" does not lift: a category's, one past the quick channels, or the company's
 * while the quick level is the shop — the full form ("התאמה") or "חסומים כעת" handles those.
 */
export function quickLeftovers(item: Pick<QuickItem, 'blocks'>, quick: Pick<QuickDefaults, 'channels' | 'level'>): QuickBlockRow[] {
  const set = new Set(quick.channels);
  return item.blocks.filter(
    (b) =>
      b.itemType === 'category' ||
      !b.channels.every((c) => set.has(c)) ||
      (b.level === 'company' && quick.level !== 'company'),
  );
}
