/**
 * "שליטה חיה" — blocks on items ("אזל" / "חסום"), and remote control of tills and kiosks: the pure
 * parts the sheets and the attention feed share (pos-server app/services/sold_out.py,
 * block_durations.py, device_commands.py, kiosk_live.py).
 *
 * Kept free of React so `npm test` covers it: durations, countdowns, labels, the feed's items.
 */

export type BlockScope = 'company' | 'shop' | 'kiosks' | 'area' | 'group' | 'event' | 'machine' | 'kiosk';
export type BlockKind = 'sold_out' | 'blocked';
/**
 * Where a block stops the item (specs/item-blocks-targets.md §11): "קופה", "קיוסק", "הזמנות אונליין",
 * "תפריט דיגיטלי" — any of the four; a new block: all four.
 */
export type BlockChannel = 'pos' | 'kiosk' | 'online' | 'menu';
/**
 * What the channels mean for the devices (§2, kept for older devices): "all" = קופה + קיוסק ·
 * "kiosks" = קיוסק · "tills" = קופה · "none" = neither (online ordering / the digital menu only).
 */
export type BlockTarget = 'all' | 'kiosks' | 'tills' | 'none';
/** The kiosks' look for one block; null = the kiosk's own `general.soldOutMode`. */
export type KioskDisplay = 'hide' | 'grey';
/** The level a block is at (the older scopes `kiosks` / `kiosk` read as shop / machine). */
export type BlockLevel = 'company' | 'shop' | 'area' | 'group' | 'event' | 'machine';
/** Where it was set from. */
export type BlockOrigin = 'dashboard' | 'till' | 'kiosk' | 'controller' | 'kiosk_hide' | 'stock';

export interface ItemBlock {
  id: string;
  scope: BlockScope;
  scopeId: string;
  kind: BlockKind;
  source: 'manual' | 'auto';
  until: string | null;
  untilMode?: string | null;
  createdAt: string | null;
  by: string | null;
  note: string | null;
  /** Null for a block of a whole category. */
  productId: string | null;
  productName: string | null;
  imageUrl?: string | null;
  shopId: string | null;
  shopName?: string | null;
  scopeName: string | null;
  secondsLeft: number | null;
  inForce: boolean;
  /** Derived by the server from `channels`, for older devices. */
  target?: BlockTarget;
  /** The channels it stops the item on; absent on a block from an older server (read by its target). */
  channels?: BlockChannel[];
  level?: BlockLevel;
  itemType?: 'product' | 'category';
  /** The product's name, or the category's. */
  itemName?: string | null;
  /** A category block: the category; a product block: the product's category. */
  categoryId?: string | null;
  categoryName?: string | null;
  kioskDisplay?: KioskDisplay | null;
  origin?: BlockOrigin | null;
}

export type DurationMode = 'none' | 'minutes' | 'time' | 'end_of_day';

export interface DurationChoice {
  mode: DurationMode;
  minutes?: number;
  /** "HH:MM" for `time`. */
  at?: string;
}

/**
 * The quick presets: 15 דק׳, 30 דק׳, שעה, שעתיים, 4 שעות — next to "עד שעה…", "עד סוף היום" and
 * "עד ביטול" in the duration picker.
 */
export const DURATION_PRESETS = [15, 30, 60, 120, 240] as const;
/** "הארך". */
export const EXTEND_BY = [15, 30, 60] as const;
export const MAX_MINUTES = 7 * 24 * 60;

export function presetLabel(minutes: number): string {
  if (minutes === 60) return 'שעה';
  if (minutes === 120) return 'שעתיים';
  if (minutes % 60 === 0) return `${minutes / 60} שעות`;
  return `${minutes} דק׳`;
}

/** A custom-minutes field as typed: a whole number in range, or null. */
export function parseMinutes(text: string): number | null {
  const t = text.trim();
  if (!/^\d{1,5}$/.test(t)) return null;
  const n = Number(t);
  return n >= 1 && n <= MAX_MINUTES ? n : null;
}

/** An "עד שעה" field: "HH:MM" (24h), or null. */
export function parseHhmm(text: string): string | null {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(text.trim());
  if (!m) return null;
  return `${m[1].padStart(2, '0')}:${m[2]}`;
}

/** The choice is complete enough to send. */
export function durationValid(choice: DurationChoice): boolean {
  if (choice.mode === 'minutes') return choice.minutes != null && choice.minutes >= 1 && choice.minutes <= MAX_MINUTES;
  if (choice.mode === 'time') return choice.at != null && parseHhmm(choice.at) != null;
  return true;
}

/** Seconds from `nowMs` to `until` (negative once it passed), or null with no end. */
export function secondsLeft(until: string | null | undefined, nowMs: number): number | null {
  if (!until) return null;
  const end = Date.parse(until);
  if (Number.isNaN(end)) return null;
  return Math.floor((end - nowMs) / 1000);
}

/** "עוד 47 דק׳", "עוד 2 ש׳ 5 דק׳", "עוד פחות מדקה", "הסתיים"; null with no end ("עד ביטול"). */
export function formatLeft(seconds: number | null): string | null {
  if (seconds == null) return null;
  if (seconds <= 0) return 'הסתיים';
  if (seconds < 60) return 'עוד פחות מדקה';
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `עוד ${minutes} דק׳`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h >= 48) return `עוד ${Math.round(h / 24)} ימים`;
  return m === 0 ? `עוד ${h} ש׳` : `עוד ${h} ש׳ ${m} דק׳`;
}

/** The local wall clock of `iso` in `timeZone` ("14:35"), with "מחר" / the date when not today. */
export function formatUntil(iso: string | null | undefined, nowMs: number, timeZone = 'Asia/Jerusalem'): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const day = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  const time = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(at);
  const today = day(new Date(nowMs));
  const tomorrow = day(new Date(nowMs + 24 * 3600 * 1000));
  const that = day(at);
  if (that === today) return time;
  if (that === tomorrow) return `מחר ${time}`;
  const [, mm, dd] = that.split('-');
  return `${dd}/${mm} ${time}`;
}

export const SCOPE_LABELS: Record<BlockScope, string> = {
  company: 'חברה',
  shop: 'סניף',
  kiosks: 'כל הקיוסקים בסניף',
  area: 'נקודת מכירה',
  group: 'קבוצת מכשירים',
  event: 'אירוע',
  machine: 'קופה',
  kiosk: 'קיוסק',
};

export function scopeLabel(scope: BlockScope, name?: string | null): string {
  const base = SCOPE_LABELS[scope] ?? scope;
  if (scope === 'kiosks') return name ? `${base} · ${name}` : base;
  return name ? `${base} · ${name}` : base;
}

export function kindLabel(kind: BlockKind): string {
  return kind === 'blocked' ? 'חסום' : 'אזל';
}

export const LEVEL_LABELS: Record<BlockLevel, string> = {
  company: 'חברה',
  shop: 'סניף',
  area: 'נקודת מכירה',
  group: 'קבוצת מכשירים',
  event: 'אירוע',
  machine: 'מכשיר',
};

export const TARGET_LABELS: Record<BlockTarget, string> = {
  all: 'קופות וקיוסקים',
  kiosks: 'קיוסקים בלבד',
  tills: 'קופות בלבד',
  none: 'אונליין ותפריט בלבד',
};

/** The four channels, in their order (the dialog's checkboxes, the labels' order). */
export const BLOCK_CHANNELS: readonly BlockChannel[] = ['pos', 'kiosk', 'online', 'menu'];

export const CHANNEL_LABELS: Record<BlockChannel, string> = {
  pos: 'קופה',
  kiosk: 'קיוסק',
  online: 'הזמנות אונליין',
  menu: 'תפריט דיגיטלי',
};

/** "תצוגה בקיוסק" — the key `null` is the kiosk's own setting. */
export const KIOSK_DISPLAY_LABELS: Record<'null' | KioskDisplay, string> = {
  null: 'לפי הגדרת הקיוסק',
  hide: 'הסתר',
  grey: 'הצג כאזל',
};

/** The row's badge for a block's own kiosk look. */
export const KIOSK_LOOK_BADGES: Record<KioskDisplay, string> = {
  hide: 'מוסתר בקיוסק',
  grey: 'באפור בקיוסק',
};

export const ORIGIN_LABELS: Record<BlockOrigin, string> = {
  dashboard: 'דשבורד',
  till: 'קופה',
  kiosk: 'קיוסק',
  controller: 'קופה שולטת',
  kiosk_hide: 'מוסתר בקיוסקים',
  stock: 'מלאי',
};

export function kioskDisplayLabel(d: KioskDisplay | null | undefined): string {
  return KIOSK_DISPLAY_LABELS[d ?? 'null'];
}

export function originLabel(origin: string | null | undefined): string | null {
  if (!origin) return null;
  return ORIGIN_LABELS[origin as BlockOrigin] ?? origin;
}

const LEGACY_KIOSK_SCOPES: readonly BlockScope[] = ['kiosks', 'kiosk'];

/** What each target meant, as channels (a block written before channels). */
const TARGET_CHANNELS: Record<BlockTarget, readonly BlockChannel[]> = {
  all: ['pos', 'kiosk'],
  kiosks: ['kiosk'],
  tills: ['pos'],
  none: [],
};

type ChannelsOfInput = Pick<ItemBlock, 'scope'> & { target?: BlockTarget | null; channels?: readonly string[] | null };

/** Known channels only, each once, in the channels' order. */
export function orderedChannels(list: Iterable<string>): BlockChannel[] {
  const named = new Set(list);
  return BLOCK_CHANNELS.filter((c) => named.has(c));
}

/**
 * The channels a block stops the item on, as pos-server sold_out_rules.py `channels_of` reads them:
 * its own `channels`; one without (an older server / row), what its target meant — "all" (or none)
 * = קופה + קיוסק, never online nor the menu. An older kiosks / kiosk scope is for kiosks only.
 */
export function channelsOf(b: ChannelsOfInput): BlockChannel[] {
  const legacy = LEGACY_KIOSK_SCOPES.includes(b.scope);
  if (Array.isArray(b.channels)) {
    const own = orderedChannels(b.channels);
    return legacy ? own.filter((c) => c === 'kiosk') : own;
  }
  const target = b.target ?? 'all';
  // "All the shop's kiosks" for the tills only contradicts itself: nothing, never wider.
  if (legacy) return target === 'all' || target === 'kiosks' ? ['kiosk'] : [];
  return [...(TARGET_CHANNELS[target] ?? TARGET_CHANNELS.all)];
}

/** What the channels mean for the devices (pos-server `target_for`). */
export function targetForChannels(channels: readonly BlockChannel[]): BlockTarget {
  const pos = channels.includes('pos');
  const kiosk = channels.includes('kiosk');
  if (pos && kiosk) return 'all';
  if (kiosk) return 'kiosks';
  if (pos) return 'tills';
  return 'none';
}

/** Whom of the devices the block reaches: from its channels (an older kiosks / kiosk scope: the kiosks). */
export function targetOf(b: ChannelsOfInput): BlockTarget {
  return targetForChannels(channelsOf(b));
}

/** Every one of the four. */
export function isAllChannels(channels: readonly BlockChannel[]): boolean {
  return BLOCK_CHANNELS.every((c) => channels.includes(c));
}

/** "כל הערוצים" for all four, else "קיוסק · תפריט דיגיטלי" (in the channels' order); "אף ערוץ" for none. */
export function channelsLabel(channels: readonly BlockChannel[]): string {
  const named = orderedChannels(channels);
  if (named.length === 0) return 'אף ערוץ';
  if (named.length === BLOCK_CHANNELS.length) return 'כל הערוצים';
  return named.map((c) => CHANNEL_LABELS[c]).join(' · ');
}

/** The summary's words for channels that are not all four: "רק קיוסק", "רק קופה, קיוסק ותפריט דיגיטלי". */
function onlyChannelsPhrase(channels: readonly BlockChannel[]): string {
  const labels = orderedChannels(channels).map((c) => CHANNEL_LABELS[c]);
  if (labels.length === 0) return 'אף ערוץ';
  if (labels.length === 1) return `רק ${labels[0]}`;
  return `רק ${labels.slice(0, -1).join(', ')} ו${labels[labels.length - 1]}`;
}

/** The level the block is at: its `level`, an older kiosks / kiosk scope as shop / machine. */
export function levelOf(b: Pick<ItemBlock, 'scope'> & { level?: BlockLevel | null }): BlockLevel {
  if (b.level) return b.level;
  if (b.scope === 'kiosks') return 'shop';
  if (b.scope === 'kiosk') return 'machine';
  return b.scope;
}

/** "סניף · הרצליה", "נקודת מכירה · בר", "קיוסק · קיוסק 2" (an older kiosk scope), "מכשיר · קופה 3". */
export function levelLabel(b: Pick<ItemBlock, 'scope' | 'scopeName'> & { level?: BlockLevel | null }): string {
  const base = b.scope === 'kiosk' ? 'קיוסק' : LEVEL_LABELS[levelOf(b)] ?? b.scope;
  return b.scopeName ? `${base} · ${b.scopeName}` : base;
}

/** The product's name, or "מחלקה · שתייה" for a block of a whole category. */
export function itemLabel(
  b: Pick<ItemBlock, 'productId' | 'productName'> & { itemType?: 'product' | 'category'; itemName?: string | null; categoryName?: string | null },
): string {
  const isCategory = b.itemType === 'category' || (b.itemType == null && !b.productId);
  if (isCategory) return `מחלקה · ${b.itemName ?? b.categoryName ?? ''}`.trim();
  return b.itemName ?? b.productName ?? '';
}

/**
 * One line about a block: "אזל · נקודת מכירה · בר · רק קיוסק ותפריט דיגיטלי · עד 14:35 (עוד 47 דק׳)"
 * (the channels only when not all four).
 */
export function blockSummary(
  b: Pick<ItemBlock, 'kind' | 'scope' | 'scopeName' | 'until'> & {
    target?: BlockTarget | null;
    channels?: readonly string[] | null;
    level?: BlockLevel | null;
  },
  nowMs: number,
  timeZone?: string,
): string {
  const parts = [kindLabel(b.kind), levelLabel(b)];
  const channels = channelsOf(b);
  if (!isAllChannels(channels)) parts.push(onlyChannelsPhrase(channels));
  const until = formatUntil(b.until, nowMs, timeZone);
  const left = formatLeft(secondsLeft(b.until, nowMs));
  parts.push(until ? `עד ${until}${left ? ` (${left})` : ''}` : 'עד ביטול');
  return parts.join(' · ');
}

// ── Remote commands ──────────────────────────────────────────────────────────

export type DeviceAction =
  | 'lock'
  | 'unlock'
  | 'sync_now'
  | 'refresh_catalog'
  | 'sign_out'
  | 'restart_app'
  | 'install_update';

export const DEVICE_ACTIONS: { action: DeviceAction; label: string; hint: string; danger?: boolean }[] = [
  { action: 'lock', label: 'נעל קופה', hint: 'מסך נעילה עם הודעה — אחרי שהמכירה הנוכחית מסתיימת', danger: true },
  { action: 'unlock', label: 'שחרר', hint: 'פותח את הקופה מיד' },
  { action: 'sync_now', label: 'סנכרן עכשיו', hint: 'הקופה מסנכרנת מול הענן' },
  { action: 'refresh_catalog', label: 'רענן קטלוג', hint: 'משיכה מלאה של הקטלוג' },
  { action: 'sign_out', label: 'נתק משתמש', hint: 'העובד מנותק אחרי המכירה הנוכחית' },
  { action: 'restart_app', label: 'הפעל מחדש את האפליקציה', hint: 'רק כשאין מכירה או תשלום פתוחים', danger: true },
  { action: 'install_update', label: 'התקן עדכון עכשיו', hint: 'רק אם יש עדכון מוכן, ורק כשהקופה פנויה', danger: true },
];

export function actionLabel(action: string): string {
  return DEVICE_ACTIONS.find((a) => a.action === action)?.label ?? action;
}

const REFUSALS: Record<string, string> = {
  sale_in_progress: 'באמצע מכירה',
  payment_in_progress: 'באמצע תשלום',
  no_update: 'אין עדכון מוכן',
  not_supported: 'הקופה לא תומכת בפעולה',
  kiosk: 'קיוסק — השתמשו בעצירת קיוסק',
  needs_permission: 'נדרש אישור התקנה במכשיר',
  superseded: 'הוחלף בפקודה חדשה',
  manager_code: 'שוחרר בקוד מנהל בקופה',
  after_sale: 'יינעל בסוף המכירה',
  not_answered: 'לא נענה',
};

/** "נשלח" / "נמסר לקופה" / "בוצע בקופה" / "נדחה: באמצע מכירה"… */
export function commandStatusLabel(status: string, detail?: string | null): string {
  const why = detail ? REFUSALS[detail] ?? detail : null;
  switch (status) {
    case 'pending':
      return 'נשלח';
    case 'delivered':
      return 'נמסר לקופה';
    case 'done':
      return why ? `בוצע בקופה (${why})` : 'בוצע בקופה';
    case 'refused':
      return why ? `נדחה: ${why}` : 'נדחה';
    case 'failed':
      return why ? `נכשל: ${why}` : 'נכשל';
    case 'cancelled':
      return 'בוטל';
    case 'expired':
      return detail === 'not_answered' ? 'נמסר ולא נענה (פג תוקף)' : 'לא נמסר (פג תוקף)';
    default:
      return status;
  }
}

export function commandTone(status: string): 'ok' | 'wait' | 'bad' | 'muted' {
  if (status === 'done') return 'ok';
  if (status === 'pending' || status === 'delivered') return 'wait';
  if (status === 'refused' || status === 'failed' || status === 'expired') return 'bad';
  return 'muted';
}

// ── The attention feed ───────────────────────────────────────────────────────

export interface LiveItemAction {
  labelKey: string;
  actionId: string;
  context: Record<string, string | number | null>;
}

export interface LiveItem {
  id: string;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  body: string;
  actions: LiveItemAction[];
}

export interface DeviceCommandRow {
  id: string;
  machineId: string;
  action: string;
  status: string;
  detail: string | null;
  createdAt: string | null;
}

export interface DeviceRow {
  machineId: string;
  name: string;
  posNumber?: string | null;
  isKiosk: boolean;
  online: boolean;
  state: { locked: boolean; message: string | null; lockedAt: string | null; lockedBy: string | null };
  open: DeviceCommandRow[];
  recent: DeviceCommandRow[];
}

/** Active blocks, then devices locked or with a command waiting / refused — the feed's items. */
export function liveItemsFrom(blocks: ItemBlock[], devices: DeviceRow[], nowMs: number): LiveItem[] {
  const out: LiveItem[] = [];
  for (const b of blocks) {
    if (!b.inForce) continue;
    out.push({
      id: `block:${b.id}`,
      severity: b.kind === 'blocked' ? 'warning' : 'info',
      title: `${kindLabel(b.kind)} · ${itemLabel(b)}`.trim(),
      body: blockSummary(b, nowMs),
      actions: [
        ...(b.until ? EXTEND_BY.map((m) => ({ labelKey: `liveControl.extend${m}`, actionId: 'block.extend', context: { blockId: b.id, minutes: m } })) : []),
        { labelKey: 'liveControl.clearNow', actionId: 'block.clear', context: { blockId: b.id } },
      ],
    });
  }
  for (const d of devices) {
    if (d.state.locked) {
      out.push({
        id: `lock:${d.machineId}`,
        severity: 'warning',
        title: `${d.name} נעולה`,
        body: d.state.message ?? '',
        actions: [{ labelKey: 'liveControl.unlock', actionId: 'device.unlock', context: { machineId: d.machineId } }],
      });
    }
    const latest = new Map<string, DeviceCommandRow>();
    for (const c of d.recent) if (!latest.has(c.action)) latest.set(c.action, c);
    for (const c of latest.values()) {
      const bad = commandTone(c.status) === 'bad';
      const waiting = c.status === 'pending' && secondsLeft(c.createdAt, nowMs) != null && -(secondsLeft(c.createdAt, nowMs) ?? 0) > 120;
      if (!bad && !waiting) continue;
      out.push({
        id: `cmd:${c.id}`,
        severity: bad ? 'warning' : 'info',
        title: `${d.name}: ${actionLabel(c.action)}`,
        body: commandStatusLabel(c.status, c.detail),
        actions: [{ labelKey: 'liveControl.retry', actionId: 'device.retry', context: { machineId: d.machineId, action: c.action } }],
      });
    }
  }
  return out;
}
