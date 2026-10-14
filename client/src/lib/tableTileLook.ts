/**
 * "עיצוב השולחנות" (P:/specs/till-design-tables.md §1, the contract §5; pos-server
 * app/services/table_tile_look.py): how the till draws each table on its tables screen — the pure
 * helpers of the till design's "שולחנות ומפה" tab and its preview. The till parameters
 * `tableTileStyle`, `tableTileInfo`, `tableStateColors`, `tableOverdueMinutes`, `tableNumberSize`
 * as the till reads them (anything it cannot read: the default), the colours a table is drawn in,
 * what is written on it, and the sample floor every state shows on.
 *
 * Self-contained on purpose (no imports): the node test build compiles it alone.
 */

export type TileStyle = 'soft' | 'filled' | 'outline';
export type TileInfoField = 'guests' | 'time' | 'amount' | 'waiter' | 'course' | 'seats';
export type TableState = 'free' | 'occupied' | 'kitchen' | 'toPay' | 'otherTill' | 'overdue' | 'reserved';
export type NumberSize = 's' | 'm' | 'l';
export type StateColors = Record<TableState, string>;

export const TILE_STYLE_KEY = 'tableTileStyle';
export const TILE_INFO_KEY = 'tableTileInfo';
export const STATE_COLORS_KEY = 'tableStateColors';
export const OVERDUE_KEY = 'tableOverdueMinutes';
export const NUMBER_SIZE_KEY = 'tableNumberSize';
/** The tab's own parameters, in the order it lists them (the server's table_tile_look.LEVEL_KEYS). */
export const TILE_LOOK_KEYS = [TILE_STYLE_KEY, TILE_INFO_KEY, STATE_COLORS_KEY, OVERDUE_KEY, NUMBER_SIZE_KEY] as const;
/** The map's display (#101, table_map_display.py), edited in the same card. */
export const MAP_DISPLAY_KEYS = ['mapDecor', 'mapLegend', 'mapSymbolLabels', 'mapSymbolScale'] as const;

export const TILE_STYLES: TileStyle[] = ['soft', 'filled', 'outline'];
export const TILE_INFO_FIELDS: TileInfoField[] = ['guests', 'time', 'amount', 'waiter', 'course', 'seats'];
export const TABLE_STATES: TableState[] = ['free', 'occupied', 'kitchen', 'toPay', 'otherTill', 'overdue', 'reserved'];
export const NUMBER_SIZES: NumberSize[] = ['s', 'm', 'l'];
/** The number's size on the till (×tablesLabelSize's scales: 0.8 / 1 / 1.25). */
export const NUMBER_SCALE: Record<NumberSize, number> = { s: 0.8, m: 1, l: 1.25 };
export const INFO_NONE = 'none';
export const OVERDUE_RANGE = { min: 5, max: 600 } as const;

const HEX = /^#[0-9a-fA-F]{6}$/;

export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX.test(value.trim());
}

/** The till's colours today (pos-android ui/tables/TableVisuals.kt, the classic look). */
export const DEFAULT_STATE_COLORS: StateColors = {
  free: '#34c759',
  occupied: '#3b82f6',
  kitchen: '#f97316',
  toPay: '#ff9500',
  otherTill: '#af52de',
  overdue: '#ff3b30',
  reserved: '#30b0c7',
};

export const TILE_LOOK_DEFAULTS = {
  tableTileStyle: 'soft' as TileStyle,
  tableTileInfo: 'guests,time,amount',
  tableStateColors: formatStateColors(DEFAULT_STATE_COLORS),
  tableOverdueMinutes: 45,
  tableNumberSize: 'm' as NumberSize,
};

/** Hebrew for the tab (the server's labels too). */
export const STATE_NAMES: Record<TableState, string> = {
  free: 'פנוי',
  occupied: 'תפוס',
  kitchen: 'נשלח למטבח',
  toPay: 'לתשלום',
  otherTill: 'בקופה אחרת',
  overdue: 'מתעכב',
  reserved: 'שמור',
};
export const INFO_NAMES: Record<TileInfoField, string> = {
  guests: 'סועדים',
  time: 'זמן ישיבה',
  amount: 'סכום',
  waiter: 'מלצר',
  course: 'השלב הבא',
  seats: 'מקומות',
};

// ── Reading the parameters as the till does ───────────────────────────────────

export function parseTileStyle(value: unknown): TileStyle {
  return TILE_STYLES.includes(value as TileStyle) ? (value as TileStyle) : 'soft';
}

export function parseNumberSize(value: unknown): NumberSize {
  return NUMBER_SIZES.includes(value as NumberSize) ? (value as NumberSize) : 'm';
}

/** `"waiter, guests"` → ['guests', 'waiter'] (the till's order); `none` → []; unknown items dropped; not text → the default. */
export function parseTileInfo(value: unknown): TileInfoField[] {
  if (typeof value !== 'string') return parseTileInfo(TILE_LOOK_DEFAULTS.tableTileInfo);
  const text = value.trim().toLowerCase();
  if (text === INFO_NONE) return [];
  const parts = new Set(text.split(',').map((p) => p.trim()));
  return TILE_INFO_FIELDS.filter((f) => parts.has(f));
}

/** The stored list: the till's order, or `none`. */
export function formatTileInfo(fields: readonly string[]): string {
  const on = new Set(fields);
  const list = TILE_INFO_FIELDS.filter((f) => on.has(f));
  return list.length ? list.join(',') : INFO_NONE;
}

export function toggleTileInfo(value: unknown, field: TileInfoField): string {
  const list = parseTileInfo(value);
  return formatTileInfo(list.includes(field) ? list.filter((f) => f !== field) : [...list, field]);
}

/** Every state's colour from the stored JSON: a state missing or not `#rrggbb` gets today's. */
export function parseStateColors(value: unknown): StateColors {
  let data: unknown = value;
  if (typeof value === 'string') {
    try {
      data = JSON.parse(value);
    } catch {
      data = null;
    }
  }
  const out: StateColors = { ...DEFAULT_STATE_COLORS };
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    for (const state of TABLE_STATES) {
      const c = (data as Record<string, unknown>)[state];
      if (isHexColor(c)) out[state] = c.trim().toLowerCase();
    }
  }
  return out;
}

/** The stored form: every state, in order, lower case, compact — byte for byte the server's. */
export function formatStateColors(colors: Partial<Record<TableState, string>>): string {
  const out: Record<string, string> = {};
  for (const state of TABLE_STATES) {
    const c = colors[state];
    out[state] = isHexColor(c) ? c.trim().toLowerCase() : DEFAULT_STATE_COLORS[state];
  }
  return JSON.stringify(out);
}

export function withStateColor(value: unknown, state: TableState, color: string): string {
  return formatStateColors({ ...parseStateColors(value), [state]: color });
}

/** The states whose colour is not today's. */
export function changedStates(colors: StateColors): TableState[] {
  return TABLE_STATES.filter((s) => colors[s] !== DEFAULT_STATE_COLORS[s]);
}

export function parseOverdue(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : NaN;
  return Number.isInteger(n) && n >= OVERDUE_RANGE.min && n <= OVERDUE_RANGE.max ? n : TILE_LOOK_DEFAULTS.tableOverdueMinutes;
}

/** Why a typed number of minutes would be refused (the server refuses it too), or null. */
export function overdueError(text: string): 'range' | null {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return 'range';
  const n = Number(t);
  return n >= OVERDUE_RANGE.min && n <= OVERDUE_RANGE.max ? null : 'range';
}

export interface TileLook {
  style: TileStyle;
  info: TileInfoField[];
  colors: StateColors;
  overdueMinutes: number;
  numberScale: number;
}

/** The look from the resolved parameters (a level's own over what it inherits). */
export function resolveTileLook(params: Record<string, unknown>): TileLook {
  return {
    style: parseTileStyle(params[TILE_STYLE_KEY]),
    info: parseTileInfo(params[TILE_INFO_KEY] ?? TILE_LOOK_DEFAULTS.tableTileInfo),
    colors: parseStateColors(params[STATE_COLORS_KEY]),
    overdueMinutes: parseOverdue(params[OVERDUE_KEY]),
    numberScale: NUMBER_SCALE[parseNumberSize(params[NUMBER_SIZE_KEY])],
  };
}

// ── The colours a table is drawn in ───────────────────────────────────────────

function channels(hex: string): [number, number, number] {
  const h = isHexColor(hex) ? hex.trim() : '#000000';
  return [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

/** `hex` mixed with `toward` by `t` (0: itself, 1: `toward`). */
export function mixHex(hex: string, toward: string, t: number): string {
  const a = channels(hex);
  const b = channels(toward);
  const k = Math.max(0, Math.min(1, t));
  return `#${a.map((v, i) => Math.round(v + (b[i] - v) * k).toString(16).padStart(2, '0')).join('')}`;
}

/** WCAG relative luminance, 0 (black) – 1 (white). */
export function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export const INK = { dark: '#0f172a', light: '#ffffff', number: '#1e293b', muted: '#64748b', table: '#ffffff', edge: '#94a3b8' };

/** The words on a filled table: white, or dark on a light colour (the contract's rule). */
export function inkOn(hex: string): string {
  return luminance(hex) > 0.6 ? INK.dark : INK.light;
}

export interface TileColors {
  fill: string;
  /** A second stop for a soft tint (top → bottom); the same as `fill` otherwise. */
  fill2: string;
  stroke: string;
  /** The edge's width, as a multiple of the usual one. */
  strokeScale: number;
  number: string;
  info: string;
  /** The word's pill (under the table) and its words. */
  pill: string;
  pillText: string;
}

/** A table in `color` drawn in `style` (the contract §5): soft — today's; filled; outline. */
export function tileColors(style: TileStyle, color: string): TileColors {
  const c = isHexColor(color) ? color.toLowerCase() : DEFAULT_STATE_COLORS.occupied;
  if (style === 'filled') {
    const ink = inkOn(c);
    return { fill: c, fill2: c, stroke: mixHex(c, '#000000', 0.2), strokeScale: 1, number: ink, info: ink, pill: c, pillText: ink };
  }
  if (style === 'outline') {
    return { fill: INK.table, fill2: INK.table, stroke: c, strokeScale: 2.5, number: INK.number, info: INK.muted, pill: c, pillText: inkOn(c) };
  }
  return {
    fill: mixHex(INK.table, c, 0.05),
    fill2: mixHex(INK.table, c, 0.13),
    stroke: c,
    strokeScale: 1.6,
    number: INK.number,
    info: INK.muted,
    pill: c,
    pillText: inkOn(c),
  };
}

// ── The sample floor (the preview) ────────────────────────────────────────────

/** The order states are dealt to the tables, so a few tables already show the busy ones. */
export const SAMPLE_ORDER: TableState[] = ['occupied', 'kitchen', 'toPay', 'free', 'overdue', 'otherTill', 'reserved'];

export function sampleState(index: number): TableState {
  return SAMPLE_ORDER[((index % SAMPLE_ORDER.length) + SAMPLE_ORDER.length) % SAMPLE_ORDER.length];
}

export interface SampleTable {
  state: TableState;
  guests: number | null;
  /** Seated, in minutes (null: nobody). */
  minutes: number | null;
  /** The order's total, in shekels. */
  amount: number | null;
  waiter: string | null;
  course: string | null;
  seats: number;
}

const WAITERS = ['דנה', 'יוסי', 'מאיה', 'עומר'];
const COURSES = ['ראשונות', 'עיקריות', 'קינוחים'];

/** What a sample table in `state` has on it — the overdue one past the threshold. */
export function sampleTable(state: TableState, index: number, seats: number, overdueMinutes: number): SampleTable {
  const waiter = WAITERS[index % WAITERS.length];
  const course = COURSES[index % COURSES.length];
  const base = { state, seats, waiter: null, course: null, guests: null, minutes: null, amount: null };
  switch (state) {
    case 'free':
    case 'reserved':
      return base;
    case 'occupied':
      return { ...base, guests: Math.max(1, Math.min(seats || 2, 2 + (index % 3))), minutes: 12, amount: 64, waiter, course: COURSES[0] };
    case 'kitchen':
      return { ...base, guests: Math.max(1, Math.min(seats || 4, 4)), minutes: 34, amount: 218, waiter, course };
    case 'toPay':
      return { ...base, guests: Math.max(1, Math.min(seats || 2, 2)), minutes: 71, amount: 342, waiter, course: null };
    case 'otherTill':
      return { ...base, guests: 3, minutes: 22, amount: 129, waiter, course };
    case 'overdue':
      return { ...base, guests: Math.max(1, Math.min(seats || 3, 3)), minutes: overdueMinutes + 18, amount: 187, waiter, course };
  }
}

/** "1:12 ש׳" past an hour, else "34 דק׳" (the till's seatedText). */
export function minutesText(minutes: number): string {
  if (minutes < 60) return `${minutes} דק׳`;
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')} ש׳`;
}

/** The lines written under the number, in the till's order: only what the table has. */
export function tileInfoLines(info: readonly TileInfoField[], t: SampleTable): string[] {
  const out: string[] = [];
  for (const f of TILE_INFO_FIELDS) {
    if (!info.includes(f)) continue;
    if (f === 'guests' && t.guests != null) out.push(`${t.guests} סועדים`);
    else if (f === 'time' && t.minutes != null) out.push(minutesText(t.minutes));
    else if (f === 'amount' && t.amount != null) out.push(`₪${t.amount}`);
    else if (f === 'waiter' && t.waiter) out.push(t.waiter);
    else if (f === 'course' && t.course) out.push(`הבא: ${t.course}`);
    else if (f === 'seats') out.push(`${t.seats} מקומות`);
  }
  return out;
}

/** The word under a sample table (the till's badge): its state, a booking's hour, the other till. */
export function stateWord(t: SampleTable): string {
  if (t.state === 'reserved') return 'שמור 20:30';
  if (t.state === 'otherTill') return 'בקופה 2';
  return STATE_NAMES[t.state];
}

// ── One level's card: what it sets, what it inherits, the edits not saved yet ──

/**
 * The values the level's tills get once the edits are saved: an edit (null: back to what it
 * inherits), else the level's own value, else what it inherits.
 */
export function effectiveParams(
  inherited: Record<string, unknown>,
  own: Record<string, unknown>,
  edits: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...inherited };
  for (const [k, v] of Object.entries(own)) if (v !== null && v !== undefined) out[k] = v;
  for (const [k, v] of Object.entries(edits)) out[k] = v === null || v === undefined ? inherited[k] : v;
  return out;
}

/** Does the level set `key` itself, with the edits? */
export function setsItself(own: Record<string, unknown>, edits: Record<string, unknown>, key: string): boolean {
  const v = key in edits ? edits[key] : own[key];
  return v !== null && v !== undefined;
}

/** Only the edits that change the level's own value, as the server takes them (null: inherit). */
export function changedParams(own: Record<string, unknown>, edits: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(edits)) {
    const before = own[k] ?? null;
    const after = v ?? null;
    if (JSON.stringify(before) !== JSON.stringify(after)) out[k] = after;
  }
  return out;
}
