/**
 * "שליטה חיה" — blocks on items ("אזל" / "חסום"), and remote control of tills and kiosks: the pure
 * parts the sheets and the attention feed share (pos-server app/services/sold_out.py,
 * block_durations.py, device_commands.py, kiosk_live.py).
 *
 * Kept free of React so `npm test` covers it: durations, countdowns, labels, the feed's items.
 */

export type BlockScope = 'company' | 'shop' | 'kiosks' | 'area' | 'group' | 'event' | 'machine' | 'kiosk';
export type BlockKind = 'sold_out' | 'blocked';

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
  productId: string;
  productName: string | null;
  imageUrl?: string | null;
  shopId: string | null;
  shopName?: string | null;
  scopeName: string | null;
  secondsLeft: number | null;
  inForce: boolean;
}

export type DurationMode = 'none' | 'minutes' | 'time' | 'end_of_day';

export interface DurationChoice {
  mode: DurationMode;
  minutes?: number;
  /** "HH:MM" for `time`. */
  at?: string;
}

/** The quick presets: 15 דק׳, 30 דק׳, שעה, שעתיים, 4 שעות. */
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

/** "עוד 47 דק׳", "עוד 2 ש׳ 5 דק׳", "עוד פחות מדקה", "הסתיים"; null with no end ("עד שאבטל"). */
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

/** One line about a block: "אזל · נקודת מכירה · בר · עד 14:35 (עוד 47 דק׳)". */
export function blockSummary(b: Pick<ItemBlock, 'kind' | 'scope' | 'scopeName' | 'until'>, nowMs: number, timeZone?: string): string {
  const parts = [kindLabel(b.kind), scopeLabel(b.scope, b.scopeName)];
  const until = formatUntil(b.until, nowMs, timeZone);
  const left = formatLeft(secondsLeft(b.until, nowMs));
  parts.push(until ? `עד ${until}${left ? ` (${left})` : ''}` : 'עד שאבטל');
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
      return 'לא נמסר (פג תוקף)';
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
      title: `${kindLabel(b.kind)} · ${b.productName ?? ''}`.trim(),
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
