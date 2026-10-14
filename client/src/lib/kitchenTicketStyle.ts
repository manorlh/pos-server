/**
 * "עיצוב בון" (P:/specs/kitchen-ticket-designs.md §1, §6–§10; pos-server
 * app/services/kitchen_ticket_style.py): the kitchen ticket's look — the `ticketStyle` contract the
 * cloud resolves for each printer and the till draws by — and the dashboard's live preview of it.
 *
 * * The templates' looks, the resolve order (template → till parameters set at a level → the
 *   design's overrides → the printer's own options → the table kept → the ink saver), the notice's
 *   bands and the order of the lines (§9) are ports of the server's, pinned by the shared golden
 *   server/tests/fixtures/kitchen_ticket_designs_golden.json (kitchenTicketStyle.test.ts).
 * * `layoutTicket` draws a ticket the way the till would, approximately (text widths estimated, not
 *   measured), at 58 or 80 mm: what it says (every mandatory string of the golden), how long the
 *   paper runs and how much of it is solid black.
 *
 * Self-contained on purpose (no imports): the node test build compiles it alone.
 */

export type TemplateKey = 'classic' | 'classic_legacy' | 'large' | 'compact' | 'courses' | 'modern';
export type InfoField = 'table' | 'guests' | 'waiter' | 'time' | 'till' | 'order' | 'customer';
export type FooterField = InfoField | 'printer';
export type TextSize = 'xs' | 's' | 'm' | 'l';
export type MinTextSize = 'xs' | 's' | 'm';
export type MaxTextSize = 's' | 'm' | 'l';
export type HeaderSize = 's' | 'm' | 'l';
export type Fit = 'fit' | 'wrap';
export type HeaderFill = 'none' | 'outline' | 'fill';
export type LineLayout = 'inline' | 'stacked';
export type BandKey =
  | 'addition' | 'fire' | 'dining' | 'eatIn' | 'copy' | 'resent' | 'redirected' | 'tableNote' | 'notice' | 'training' | 'course';
export type BandStyle = 'double' | 'outline' | 'pill' | 'underline' | 'stars' | 'plain' | 'fill';
export type QtyStyle = 'plain' | 'box_outline' | 'box_fill';
export type ModLayout = 'inline' | 'indent';
export type ModMarks = 'asis' | 'plusminus' | 'words' | 'bullets';
export type ImportantNote = 'outline' | 'fill';
export type AllergyStyle = 'outline_warn' | 'fill';
export type Separators = 'solid' | 'dashed' | 'none';
export type Weight = 'thin' | 'normal' | 'thick';
export type ItemDivider = 'none' | 'thin' | 'dashed';
export type Spacing = 'tight' | 'normal';
export type OrderBy = 'added' | 'course' | 'category' | 'custom';
export type GroupHeaders = 'auto' | 'on' | 'off';
export type NoCourse = 'last' | 'first';
export type Grouping = 'none' | 'seat';
export type HeldCourse = 'plain' | 'dashed';
export type OrderListKind = 'course' | 'category';
export type Paper = 58 | 80;

export interface OrderEntry {
  kind: OrderListKind;
  id: string;
  name?: string | null;
}

/** A template's look, or a resolved style without its meta (`groupHeaders` still auto | on | off). */
export interface Look {
  fontScale: number;
  fit: Fit;
  header: { size: HeaderSize; fill: HeaderFill; layout: LineLayout; fields: InfoField[] };
  bands: Record<BandKey, BandStyle>;
  itemName: { maxSize: MaxTextSize; minSize: MinTextSize; maxLines: number };
  qty: QtyStyle;
  mods: { layout: ModLayout; marks: ModMarks };
  note: { frame: boolean; important: ImportantNote };
  allergy: AllergyStyle;
  separators: Separators;
  separatorWeight: Weight;
  itemDivider: ItemDivider;
  spacing: Spacing;
  layout: { qtyColumn: boolean; hangingIndent: boolean };
  order: { by: OrderBy; groupHeaders: GroupHeaders; noCourse: NoCourse; list: OrderEntry[] };
  grouping: Grouping;
  heldCourse: HeldCourse;
  totals: boolean;
  checkboxes: boolean;
  elapsed: boolean;
  footer: { layout: LineLayout; fields: FooterField[] };
  feedLines: number;
}

/** The whole `ticketStyle` the till draws by (P:/specs §10ב). */
export interface TicketStyle extends Omit<Look, 'order'> {
  version: number;
  template: TemplateKey;
  designId: string | null;
  designName: string | null;
  inkSaver: boolean;
  order: { by: OrderBy; groupHeaders: boolean; noCourse: NoCourse; list: OrderEntry[] };
}

/** A partial look: a named design's overrides (and `inkSaver`). */
export type Overrides = {
  inkSaver?: boolean;
  fontScale?: number;
  fit?: Fit;
  header?: Partial<Look['header']>;
  bands?: Partial<Record<BandKey, BandStyle>>;
  itemName?: Partial<Look['itemName']>;
  qty?: QtyStyle;
  mods?: Partial<Look['mods']>;
  note?: Partial<Look['note']>;
  allergy?: AllergyStyle;
  separators?: Separators;
  separatorWeight?: Weight;
  itemDivider?: ItemDivider;
  spacing?: Spacing;
  layout?: Partial<Look['layout']>;
  order?: Partial<Look['order']>;
  grouping?: Grouping;
  heldCourse?: HeldCourse;
  totals?: boolean;
  checkboxes?: boolean;
  elapsed?: boolean;
  footer?: Partial<Look['footer']>;
  feedLines?: number;
};

/** The options a level or a printer sets (the till parameters by their short names). */
export interface TicketOptions {
  fontScale?: number | null;
  header?: InfoField[] | null;
  checkboxes?: boolean | null;
  elapsed?: boolean | null;
  fit?: Fit | null;
  minTextSize?: MinTextSize | null;
  maxTextSize?: MaxTextSize | null;
  headerSize?: HeaderSize | null;
  inlineMods?: boolean | null;
  order?: OrderBy | null;
  orderList?: OrderEntry[] | null;
  groupHeaders?: GroupHeaders | null;
  noCourse?: NoCourse | null;
}

export interface TicketLine {
  productId?: string | null;
  categoryId?: string | null;
  name: string;
  quantity: number;
  notes?: string | null;
  mods?: string[] | null;
  removals?: string[] | null;
  important?: boolean | null;
  allergies?: string[] | null;
  seat?: string | null;
  course?: string | null;
  courseId?: string | null;
  mealName?: string | null;
  refill?: string | null;
  held?: boolean | null;
}

/** The till's ticket (pos-android KitchenTicketDto). */
export interface KitchenTicket {
  source: string;
  tableName?: string | null;
  zoneName?: string | null;
  guests?: number | null;
  waiterName?: string | null;
  createdAt: string;
  isAddition?: boolean;
  lines: TicketLine[];
  orderRef?: string | null;
  sourceName?: string | null;
  fire?: string | null;
  customerName?: string | null;
  dining?: string | null;
  notice?: string | null;
  training?: boolean | null;
  openedAt?: string | null;
}

export interface CourseRef {
  id: string;
  name: string;
  sortOrder?: number | null;
}

export interface CategoryRef {
  id: string;
  name?: string | null;
  parentId?: string | null;
  sortOrder?: number | null;
}

// ── The vocabulary ──────────────────────────────────────────────────────────

export const STYLE_VERSION = 1;
export const TEMPLATES: TemplateKey[] = ['classic', 'classic_legacy', 'large', 'compact', 'courses', 'modern'];
export const DEFAULT_TEMPLATE: TemplateKey = 'classic';
export const TEMPLATE_LABELS: Record<TemplateKey, string> = {
  classic: 'קלאסי',
  classic_legacy: 'קלאסי (ישן)',
  large: 'גדול וברור',
  compact: 'חסכוני',
  courses: 'לפי קורסים ומושבים',
  modern: 'מודרני',
};
export const INFO_FIELDS: InfoField[] = ['table', 'guests', 'waiter', 'time', 'till', 'order', 'customer'];
export const FOOTER_FIELDS: FooterField[] = [...INFO_FIELDS, 'printer'];
export const TEXT_SIZES: TextSize[] = ['xs', 's', 'm', 'l'];
export const MIN_TEXT_SIZES: MinTextSize[] = ['xs', 's', 'm'];
export const MAX_TEXT_SIZES: MaxTextSize[] = ['s', 'm', 'l'];
export const HEADER_SIZES: HeaderSize[] = ['s', 'm', 'l'];
export const FITS: Fit[] = ['fit', 'wrap'];
export const HEADER_FILLS: HeaderFill[] = ['none', 'outline', 'fill'];
export const LINE_LAYOUTS: LineLayout[] = ['inline', 'stacked'];
export const BAND_KEYS: BandKey[] = [
  'addition', 'fire', 'dining', 'eatIn', 'copy', 'resent', 'redirected', 'tableNote', 'notice', 'training', 'course',
];
export const BAND_STYLES: BandStyle[] = ['double', 'outline', 'pill', 'underline', 'stars', 'plain', 'fill'];
export const QTY_STYLES: QtyStyle[] = ['plain', 'box_outline', 'box_fill'];
export const MOD_LAYOUTS: ModLayout[] = ['inline', 'indent'];
export const MOD_MARKS: ModMarks[] = ['asis', 'plusminus', 'words', 'bullets'];
export const IMPORTANT_NOTE_STYLES: ImportantNote[] = ['outline', 'fill'];
export const ALLERGY_STYLES: AllergyStyle[] = ['outline_warn', 'fill'];
export const SEPARATORS: Separators[] = ['solid', 'dashed', 'none'];
export const WEIGHTS: Weight[] = ['thin', 'normal', 'thick'];
export const ITEM_DIVIDERS: ItemDivider[] = ['none', 'thin', 'dashed'];
export const SPACINGS: Spacing[] = ['tight', 'normal'];
export const GROUPINGS: Grouping[] = ['none', 'seat'];
export const HELD_COURSE_STYLES: HeldCourse[] = ['plain', 'dashed'];
export const ORDER_BYS: OrderBy[] = ['added', 'course', 'category', 'custom'];
export const GROUP_HEADERS: GroupHeaders[] = ['auto', 'on', 'off'];
export const NO_COURSE: NoCourse[] = ['last', 'first'];
export const ORDER_LIST_KINDS: OrderListKind[] = ['course', 'category'];
export const ORDER_LIST_MAX = 40;
export const FONT_SCALE = { min: 80, max: 150, default: 100 } as const;
export const FEED_LINES = { min: 0, max: 6 } as const;
export const MAX_LINES_MAX = 4;

/** The till parameters (P:/specs §2, §6ב, §8, §9), in the server's order. */
export const PARAM_KEYS = {
  design: 'kitchenTicketDesign',
  inkSaver: 'kitchenTicketInkSaver',
  fontScale: 'kitchenTicketFontScale',
  header: 'kitchenTicketHeader',
  checkboxes: 'kitchenTicketCheckboxes',
  elapsed: 'kitchenTicketElapsed',
  fit: 'kitchenTicketFit',
  minTextSize: 'kitchenTicketMinTextSize',
  maxTextSize: 'kitchenTicketMaxTextSize',
  headerSize: 'kitchenTicketHeaderSize',
  inlineMods: 'kitchenTicketInlineMods',
  order: 'kitchenTicketOrder',
  orderList: 'kitchenTicketOrderList',
  groupHeaders: 'kitchenTicketGroupHeaders',
  noCourse: 'kitchenTicketNoCourse',
} as const;
export const PARAMETER_KEYS: string[] = Object.values(PARAM_KEYS);

/** Sizes in dots per paper width (P:/specs §8, §10ב); the server's `METRICS`. */
export const METRICS = {
  dotsPerMm: 8,
  paper: { '58': { dots: 384, pad: 10 }, '80': { dots: 576, pad: 15 } },
  avgCharEm: 0.5,
  itemSize: { '58': { xs: 21, s: 26, m: 30, l: 36 }, '80': { xs: 24, s: 29, m: 34, l: 42 } },
  charsPerLine: { '58': { xs: 34, s: 28, m: 24, l: 20 }, '80': { xs: 46, s: 38, m: 32, l: 26 } },
  headerRatio: { s: 1.3, m: 1.6, l: 2.0 },
  detailRatio: 0.8,
  smallSize: { '58': 18, '80': 22 },
  fitStep: 1,
  lineGap: { tight: 2, normal: 6 },
  separatorWidth: { thin: 1, normal: 3, thick: 5 },
  feedLineDots: 24,
};

// ── The templates' looks (before the ink saver) ──────────────────────────────

const BANDS_FRAMED: Record<BandKey, BandStyle> = {
  addition: 'double',
  fire: 'outline',
  dining: 'double',
  eatIn: 'outline',
  copy: 'outline',
  resent: 'double',
  redirected: 'outline',
  tableNote: 'outline',
  notice: 'outline',
  training: 'double',
  course: 'plain',
};
const BANDS_LEGACY: Record<BandKey, BandStyle> = {
  addition: 'fill',
  fire: 'outline',
  dining: 'fill',
  eatIn: 'outline',
  copy: 'fill',
  resent: 'fill',
  redirected: 'fill',
  tableNote: 'fill',
  notice: 'fill',
  training: 'outline',
  course: 'plain',
};

function allBands(style: BandStyle): Record<BandKey, BandStyle> {
  return Object.fromEntries(BAND_KEYS.map((k) => [k, style])) as Record<BandKey, BandStyle>;
}

function baseLook(): Look {
  return {
    fontScale: FONT_SCALE.default,
    fit: 'fit',
    header: { size: 'm', fill: 'none', layout: 'inline', fields: ['table', 'customer', 'guests', 'waiter', 'time'] },
    bands: { ...BANDS_FRAMED },
    itemName: { maxSize: 'm', minSize: 's', maxLines: 0 },
    qty: 'plain',
    mods: { layout: 'inline', marks: 'asis' },
    note: { frame: true, important: 'outline' },
    allergy: 'outline_warn',
    separators: 'solid',
    separatorWeight: 'thin',
    itemDivider: 'thin',
    spacing: 'tight',
    layout: { qtyColumn: true, hangingIndent: true },
    order: { by: 'added', groupHeaders: 'auto', noCourse: 'last', list: [] },
    grouping: 'none',
    heldCourse: 'plain',
    totals: false,
    checkboxes: false,
    elapsed: false,
    footer: { layout: 'inline', fields: ['order', 'till', 'printer'] },
    feedLines: 2,
  };
}

/** One level of groups laid over the new classic (as the server's `_look`). */
function look(changes: Overrides): Look {
  const out = baseLook() as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(changes)) {
    const base = out[key];
    out[key] =
      value && typeof value === 'object' && !Array.isArray(value) && base && typeof base === 'object' && !Array.isArray(base)
        ? { ...(base as object), ...(value as object) }
        : value;
  }
  return out as unknown as Look;
}

const LOOKS: Record<TemplateKey, Look> = {
  classic: baseLook(),
  classic_legacy: look({
    fit: 'wrap',
    header: { size: 'l', layout: 'stacked', fields: ['table', 'customer', 'order', 'guests'] },
    bands: { ...BANDS_LEGACY },
    itemName: { maxSize: 'l', minSize: 'm' },
    mods: { layout: 'indent' },
    note: { important: 'fill' },
    allergy: 'fill',
    separatorWeight: 'normal',
    itemDivider: 'none',
    spacing: 'normal',
    layout: { qtyColumn: false, hangingIndent: false },
    order: { groupHeaders: 'on' },
    footer: { layout: 'stacked', fields: ['time', 'waiter', 'order', 'till', 'printer'] },
    feedLines: 3,
  }),
  large: look({
    header: { size: 'l', fill: 'outline', layout: 'stacked' },
    bands: { ...allBands('double'), eatIn: 'outline' },
    itemName: { maxSize: 'l', minSize: 'm', maxLines: 2 },
    qty: 'box_outline',
    mods: { layout: 'indent', marks: 'plusminus' },
    separatorWeight: 'thick',
    itemDivider: 'none',
    spacing: 'normal',
    footer: { layout: 'stacked' },
    feedLines: 3,
  }),
  compact: look({
    header: { size: 's', fields: ['table', 'customer', 'guests', 'time', 'waiter'] },
    bands: { ...allBands('stars'), eatIn: 'underline', course: 'underline' },
    itemName: { maxSize: 's', minSize: 'xs' },
    note: { frame: false },
    separators: 'dashed',
    itemDivider: 'none',
  }),
  courses: look({
    bands: { ...BANDS_FRAMED, course: 'double' },
    spacing: 'normal',
    itemDivider: 'none',
    order: { by: 'course' },
    grouping: 'seat',
    heldCourse: 'dashed',
    totals: true,
    checkboxes: true,
  }),
  modern: look({
    header: { fill: 'outline', layout: 'stacked' },
    bands: {
      addition: 'double', fire: 'outline', dining: 'pill', eatIn: 'pill', copy: 'outline', resent: 'double',
      redirected: 'outline', tableNote: 'outline', notice: 'outline', training: 'outline', course: 'underline',
    },
    mods: { layout: 'indent', marks: 'bullets' },
    separators: 'dashed',
    itemDivider: 'none',
    spacing: 'normal',
    elapsed: true,
  }),
};

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** A template's whole look before the ink saver (a fresh copy). */
export function templateStyle(template: TemplateKey): Look {
  return clone(LOOKS[template] ?? LOOKS.classic);
}

export function isTemplate(value: unknown): value is TemplateKey {
  return typeof value === 'string' && (TEMPLATES as string[]).includes(value);
}

/** The elements of a look drawn in solid black (none in any default look, §8). */
export function blackParts(style: Look | TicketStyle): string[] {
  const out = BAND_KEYS.filter((k) => style.bands[k] === 'fill').map((k) => `bands.${k}`);
  if (style.header.fill === 'fill') out.push('header.fill');
  if (style.qty === 'box_fill') out.push('qty');
  if (style.allergy === 'fill') out.push('allergy');
  if (style.note.important === 'fill') out.push('note.important');
  return out;
}

// ── Resolving ────────────────────────────────────────────────────────────────

const MANDATORY_FIELD: InfoField = 'table';

function filterFields(style: Look, allowed: InfoField[]): void {
  const keep = new Set<string>([...allowed, MANDATORY_FIELD]);
  style.header.fields = style.header.fields.filter((f) => keep.has(f));
  style.footer.fields = style.footer.fields.filter((f) => keep.has(f) || f === 'printer');
}

function applyOptions(style: Look, o: TicketOptions): void {
  if (o.fontScale != null) style.fontScale = o.fontScale;
  if (o.header != null) filterFields(style, o.header);
  if (o.checkboxes != null) style.checkboxes = o.checkboxes;
  if (o.elapsed != null) style.elapsed = o.elapsed;
  if (o.fit && FITS.includes(o.fit)) style.fit = o.fit;
  if (o.minTextSize && MIN_TEXT_SIZES.includes(o.minTextSize)) style.itemName.minSize = o.minTextSize;
  if (o.maxTextSize && MAX_TEXT_SIZES.includes(o.maxTextSize)) style.itemName.maxSize = o.maxTextSize;
  if (o.headerSize && HEADER_SIZES.includes(o.headerSize)) style.header.size = o.headerSize;
  if (o.inlineMods != null) style.mods.layout = o.inlineMods ? 'inline' : 'indent';
  if (o.order && ORDER_BYS.includes(o.order)) style.order.by = o.order;
  if (o.orderList != null) style.order.list = o.orderList.map((e) => ({ kind: e.kind, id: e.id }));
  if (o.groupHeaders && GROUP_HEADERS.includes(o.groupHeaders)) style.order.groupHeaders = o.groupHeaders;
  if (o.noCourse && NO_COURSE.includes(o.noCourse)) style.order.noCourse = o.noCourse;
}

function merge(base: Record<string, unknown>, over: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(over)) {
    if (value === undefined || value === null) continue;
    const current = base[key];
    if (value && typeof value === 'object' && !Array.isArray(value) && current && typeof current === 'object' && !Array.isArray(current)) {
      merge(current as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      base[key] = clone(value);
    }
  }
}

/** §6ב, in place: no filled area left but the text itself. */
export function applyInkSaver<T extends Look | TicketStyle>(style: T): T {
  for (const key of BAND_KEYS) if (style.bands[key] === 'fill') style.bands[key] = 'double';
  if (style.header.fill === 'fill') style.header.fill = 'outline';
  if (style.qty === 'box_fill') style.qty = 'box_outline';
  if (style.allergy === 'fill') style.allergy = 'outline_warn';
  if (style.note.important === 'fill') style.note.important = 'outline';
  if (style.separatorWeight !== 'thin') style.separatorWeight = 'thin';
  return style;
}

/** `kitchenTicketHeader` / a printer's list → the fields, in their order, the table always. */
export function parseHeader(value: unknown): InfoField[] | null {
  const parts = Array.isArray(value)
    ? value.map((v) => String(v).trim())
    : typeof value === 'string'
      ? value.split(',').map((v) => v.trim()).filter(Boolean)
      : null;
  if (!parts || parts.some((p) => !(INFO_FIELDS as string[]).includes(p))) return null;
  const chosen = new Set<string>([...parts, MANDATORY_FIELD]);
  return INFO_FIELDS.filter((f) => chosen.has(f));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `custom`'s list from `[{kind, id}]` or "course:<id>,category:<id>"; null when the till could not use it. */
export function parseOrderList(value: unknown): OrderEntry[] | null {
  const raw = typeof value === 'string' ? value.split(',').map((v) => v.trim()).filter(Boolean) : value;
  if (!Array.isArray(raw)) return null;
  const out: OrderEntry[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    let kind: unknown;
    let id: unknown;
    if (typeof entry === 'string' && entry.includes(':')) {
      [kind, id] = [entry.slice(0, entry.indexOf(':')), entry.slice(entry.indexOf(':') + 1)];
    } else if (entry && typeof entry === 'object') {
      kind = (entry as OrderEntry).kind;
      id = (entry as OrderEntry).id;
    } else return null;
    const ident = String(id ?? '').trim().toLowerCase();
    if (!(ORDER_LIST_KINDS as unknown[]).includes(kind) || !UUID_RE.test(ident)) return null;
    const key = `${kind}:${ident}`;
    if (seen.has(key)) return null;
    seen.add(key);
    out.push({ kind: kind as OrderListKind, id: ident });
  }
  return out.length > ORDER_LIST_MAX ? null : out;
}

export function orderListText(entries: OrderEntry[]): string {
  return entries.map((e) => `${e.kind}:${e.id}`).join(',');
}

/** The level options from the till parameters SET at some level (key → value); unreadable ones skipped. */
export function levelOptions(params: Record<string, unknown>): TicketOptions {
  const o: TicketOptions = {};
  const p = params;
  const n = p[PARAM_KEYS.fontScale];
  if (typeof n === 'number' && Number.isInteger(n) && n >= FONT_SCALE.min && n <= FONT_SCALE.max) o.fontScale = n;
  if (p[PARAM_KEYS.header] != null) o.header = parseHeader(p[PARAM_KEYS.header]);
  if (typeof p[PARAM_KEYS.checkboxes] === 'boolean') o.checkboxes = p[PARAM_KEYS.checkboxes] as boolean;
  if (typeof p[PARAM_KEYS.elapsed] === 'boolean') o.elapsed = p[PARAM_KEYS.elapsed] as boolean;
  if (FITS.includes(p[PARAM_KEYS.fit] as Fit)) o.fit = p[PARAM_KEYS.fit] as Fit;
  if (MIN_TEXT_SIZES.includes(p[PARAM_KEYS.minTextSize] as MinTextSize)) o.minTextSize = p[PARAM_KEYS.minTextSize] as MinTextSize;
  if (MAX_TEXT_SIZES.includes(p[PARAM_KEYS.maxTextSize] as MaxTextSize)) o.maxTextSize = p[PARAM_KEYS.maxTextSize] as MaxTextSize;
  if (HEADER_SIZES.includes(p[PARAM_KEYS.headerSize] as HeaderSize)) o.headerSize = p[PARAM_KEYS.headerSize] as HeaderSize;
  if (typeof p[PARAM_KEYS.inlineMods] === 'boolean') o.inlineMods = p[PARAM_KEYS.inlineMods] as boolean;
  if (ORDER_BYS.includes(p[PARAM_KEYS.order] as OrderBy)) o.order = p[PARAM_KEYS.order] as OrderBy;
  if (p[PARAM_KEYS.orderList] != null) o.orderList = parseOrderList(p[PARAM_KEYS.orderList]);
  if (GROUP_HEADERS.includes(p[PARAM_KEYS.groupHeaders] as GroupHeaders)) o.groupHeaders = p[PARAM_KEYS.groupHeaders] as GroupHeaders;
  if (NO_COURSE.includes(p[PARAM_KEYS.noCourse] as NoCourse)) o.noCourse = p[PARAM_KEYS.noCourse] as NoCourse;
  return o;
}

export interface ResolveInput {
  /** The till parameters SET on the till's levels (key → value); `kitchenTicketInkSaver` as it resolves. */
  params?: Record<string, unknown> | null;
  overrides?: Overrides | null;
  designId?: string | null;
  designName?: string | null;
  printer?: TicketOptions | null;
  /** `${kind}:${id}` → the course's / category's name, for `order.list`. */
  names?: Record<string, string> | null;
}

/** The full `ticketStyle` (the server's `resolve_with_params`). */
export function resolveStyle(template: TemplateKey, input: ResolveInput = {}): TicketStyle {
  const params = input.params ?? {};
  const t: TemplateKey = isTemplate(template) ? template : DEFAULT_TEMPLATE;
  const lookNow = templateStyle(t) as Look & { inkSaver?: boolean };
  applyOptions(lookNow, levelOptions(params));
  const ink = params[PARAM_KEYS.inkSaver];
  lookNow.inkSaver = typeof ink === 'boolean' ? ink : true;
  if (input.overrides) merge(lookNow as unknown as Record<string, unknown>, input.overrides as Record<string, unknown>);
  applyOptions(lookNow, input.printer ?? {});
  if (!lookNow.header.fields.includes(MANDATORY_FIELD)) lookNow.header.fields.unshift(MANDATORY_FIELD);
  const item = lookNow.itemName;
  if (TEXT_SIZES.indexOf(item.minSize) > TEXT_SIZES.indexOf(item.maxSize)) item.minSize = item.maxSize as MinTextSize;
  const headers = lookNow.order.groupHeaders;
  const order = {
    by: lookNow.order.by,
    groupHeaders: headers === 'on' || (headers === 'auto' && lookNow.order.by !== 'added'),
    noCourse: lookNow.order.noCourse,
    list: lookNow.order.list.map((e) => ({ kind: e.kind, id: e.id, name: input.names?.[`${e.kind}:${e.id}`] ?? null })),
  };
  const inkSaver = lookNow.inkSaver;
  delete lookNow.inkSaver;
  const style: TicketStyle = {
    version: STYLE_VERSION,
    template: t,
    designId: input.designId ?? null,
    designName: input.designName ?? null,
    inkSaver,
    ...(lookNow as Omit<Look, 'order'>),
    order,
  };
  if (inkSaver) applyInkSaver(style);
  // The server's key order.
  const keys = ['version', 'template', 'designId', 'designName', 'inkSaver', ...Object.keys(baseLook())];
  return Object.fromEntries(keys.map((k) => [k, (style as unknown as Record<string, unknown>)[k]])) as unknown as TicketStyle;
}

// ── The notice's parts ──────────────────────────────────────────────────────

export const NOTICE_SEPARATOR = ' · ';
export const NOTICE_KINDS: Array<[BandKey, string[]]> = [
  ['tableNote', ['הערה לשולחן:', 'TABLE NOTE:']],
  ['redirected', ['הופנה מ:', 'Redirected from:']],
  ['resent', ['הדפסה חוזרת', 'PRINTED AGAIN']],
  ['copy', ['העתק', 'COPY', 'עותק ', 'Copy ']],
];

export function noticeParts(notice: string | null | undefined): Array<[BandKey, string]> {
  const out: Array<[BandKey, string]> = [];
  for (const part of (notice ?? '').split(NOTICE_SEPARATOR)) {
    const text = part.trim();
    if (!text) continue;
    const kind = NOTICE_KINDS.find(([, prefixes]) => prefixes.some((p) => text.startsWith(p)))?.[0] ?? 'notice';
    out.push([kind, text]);
  }
  return out;
}

// ── The order of the lines (§9) ─────────────────────────────────────────────

export interface LineGroup {
  key: string;
  kind: 'course' | 'category' | 'none';
  title: string | null;
  lines: number[];
}

/** Each category's place in the catalog: the tree depth first, siblings by (sortOrder, name). */
export function categoryPositions(categories: CategoryRef[]): Record<string, number> {
  const ids = new Set(categories.map((c) => c.id));
  const children = new Map<string | null, CategoryRef[]>();
  for (const c of categories) {
    const parent = c.parentId && ids.has(c.parentId) ? c.parentId : null;
    children.set(parent, [...(children.get(parent) ?? []), c]);
  }
  const out: Record<string, number> = {};
  let next = 0;
  const walk = (parent: string | null) => {
    const kids = [...(children.get(parent) ?? [])].sort(
      (a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || cmp(a.name ?? '', b.name ?? ''),
    );
    for (const c of kids) {
      if (c.id in out) continue;
      out[c.id] = next++;
      walk(c.id);
    }
  };
  walk(null);
  return out;
}

/** The server's str ordering (code points), so a tie between names sorts the same everywhere. */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** "מ2" before "מ10": digits as numbers. */
export function seatKey(seat: string | null | undefined): Array<[number, number, string]> {
  return (seat ?? '').trim().split(/(\d+)/).filter(Boolean).map((p) => (/^\d+$/.test(p) ? [0, Number(p), ''] : [1, 0, p]));
}

function compareKeys(a: Array<[number, number, string]>, b: Array<[number, number, string]>): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const [x, y] = [a[i], b[i]];
    if (x[0] !== y[0]) return x[0] - y[0];
    if (x[1] !== y[1]) return x[1] - y[1];
    const c = cmp(x[2], y[2]);
    if (c) return c;
  }
  return a.length - b.length;
}

function ancestors(categoryId: string | null | undefined, categories: CategoryRef[]): string[] {
  const parents = new Map(categories.map((c) => [c.id, c.parentId ?? null]));
  const chain: string[] = [];
  let current = categoryId ?? null;
  while (current && !chain.includes(current)) {
    chain.push(current);
    current = parents.get(current) ?? null;
  }
  return chain;
}

/** The lines in the order the style prints them, in groups (the server's `order_lines`). */
export function orderLines(
  lines: TicketLine[],
  style: Pick<TicketStyle, 'order' | 'grouping'>,
  courses: CourseRef[],
  categories: CategoryRef[],
): LineGroup[] {
  const { by, noCourse } = style.order;
  const sortedCourses = [...courses].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || cmp(a.name, b.name));
  const courseRank = new Map(sortedCourses.map((c, i) => [c.id, i]));
  const courseByName = new Map<string, CourseRef>();
  for (const c of sortedCourses) if (!courseByName.has(c.name)) courseByName.set(c.name, c);
  const catRank = categoryPositions(categories);
  const catNames = new Map(categories.map((c) => [c.id, c.name ?? null]));
  // A course the till does not know keeps its place among the unknown ones: as first added.
  const firstSeen = new Map<string, number>();
  lines.forEach((l, i) => {
    const n = (l.course ?? '').trim();
    if (!firstSeen.has(n)) firstSeen.set(n, i);
  });
  const courseOf = (line: TicketLine): { id: string | null; name: string } | null => {
    if (line.courseId) {
      const found = courses.find((c) => c.id === line.courseId);
      if (found) return found;
    }
    const name = (line.course ?? '').trim();
    if (!name) return null;
    return courseByName.get(name) ?? { id: null, name };
  };
  type Keyed = { key: string; kind: LineGroup['kind']; title: string | null; rank: Array<number | string>; index: number };
  const keyed: Keyed[] = [];
  const BIG = 10 ** 6;
  lines.forEach((line, index) => {
    const course = courseOf(line);
    if (by === 'added') {
      const title = course ? course.name : null;
      const last = keyed[keyed.length - 1];
      const key = last && last.title === title ? last.key : `run|${new Set(keyed.map((k) => k.key)).size}|${title}`;
      keyed.push({ key, kind: course ? 'course' : 'none', title, rank: [keyed.length], index });
    } else if (by === 'course') {
      if (!course) keyed.push({ key: 'none', kind: 'none', title: null, rank: [noCourse === 'first' ? -1 : BIG], index });
      else
        keyed.push({
          key: `course|${course.name}`, kind: 'course', title: course.name,
          rank:
            course.id != null && courseRank.has(course.id)
              ? [courseRank.get(course.id)!, 0]
              : [10 ** 5, firstSeen.get(course.name) ?? 0],
          index,
        });
    } else if (by === 'category') {
      const cid = line.categoryId ?? null;
      keyed.push({
        key: `category|${cid}`, kind: cid ? 'category' : 'none', title: cid ? catNames.get(cid) ?? null : null,
        rank: [cid != null && cid in catRank ? catRank[cid] : BIG], index,
      });
    } else {
      const chain = ancestors(line.categoryId, categories);
      let hit: { position: number; entry: OrderEntry; title: string | null } | null = null;
      (style.order.list ?? []).some((entry, position) => {
        if (entry.kind === 'course' && course && (entry.id === course.id || (entry.name && entry.name === course.name))) {
          hit = { position, entry, title: course.name };
          return true;
        }
        if (entry.kind === 'category' && chain.includes(entry.id)) {
          hit = { position, entry, title: entry.name ?? catNames.get(entry.id) ?? null };
          return true;
        }
        return false;
      });
      if (!hit) keyed.push({ key: 'rest', kind: 'none', title: null, rank: [BIG], index });
      else {
        const h = hit as { position: number; entry: OrderEntry; title: string | null };
        keyed.push({ key: `${h.entry.kind}|${h.entry.id}`, kind: h.entry.kind, title: h.title, rank: [h.position], index });
      }
    }
  });
  const rankCmp = (a: Keyed, b: Keyed) => {
    for (let i = 0; i < Math.max(a.rank.length, b.rank.length); i++) {
      const [x, y] = [a.rank[i], b.rank[i]];
      if (x === undefined) return -1;
      if (y === undefined) return 1;
      if (x !== y) return typeof x === 'number' && typeof y === 'number' ? x - y : cmp(String(x), String(y));
    }
    return a.index - b.index;
  };
  const groups: LineGroup[] = [];
  for (const k of [...keyed].sort(rankCmp)) {
    let g = groups.find((x) => x.key === k.key);
    if (!g) {
      g = { key: k.key, kind: k.kind, title: k.title, lines: [] };
      groups.push(g);
    }
    g.lines.push(k.index);
  }
  if (style.grouping === 'seat') {
    for (const g of groups) {
      g.lines.sort((i, j) => {
        const [a, b] = [lines[i].seat, lines[j].seat];
        if ((a == null) !== (b == null)) return a == null ? 1 : -1;
        return compareKeys(seatKey(a), seatKey(b)) || i - j;
      });
    }
  }
  return groups;
}

// ── The sample tickets (the golden's) ───────────────────────────────────────

const line = (name: string, quantity: number, more: Partial<TicketLine> = {}): TicketLine => ({ name, quantity, ...more });

/** The golden's `preview_table`: what the preview and the design test print show (P:/specs §4). */
export const SAMPLE_TICKET: KitchenTicket = {
  source: 'table',
  tableName: '12',
  zoneName: 'גן',
  guests: 4,
  waiterName: 'דנה',
  createdAt: '2026-10-14T17:14:00Z',
  isAddition: true,
  lines: [
    line('סלט ירוק', 1, { mods: ['+ אבוקדו'], removals: ['בלי בצל'], seat: 'מ1', course: 'ראשונות' }),
    line("קרפצ'יו בקר", 1, { notes: 'רוטב בצד', seat: 'מ2', course: 'ראשונות' }),
    line('המבורגר 250 גרם', 1, {
      mods: ['מדיום'], removals: ['בלי עגבנייה'], allergies: ['אגוזים'], seat: 'מ1', course: 'עיקריות',
      mealName: 'ארוחה עסקית', held: true,
    }),
    line('פסטה ארביאטה', 2, { notes: 'ללא גלוטן', important: true, seat: 'מ2', course: 'עיקריות', held: true }),
  ],
  orderRef: '4471',
  sourceName: 'קופה 1',
  dining: 'take_away',
  notice: 'הערה לשולחן: יום הולדת — להביא נר',
  openedAt: '2026-10-14T16:49:00Z',
};
export const SAMPLE_PRINTER_NAME = 'מטבח';
export const TEST_PRINT_NOTICE = 'הדפסת ניסיון — לא להכנה';

/** The golden's `order_three_courses` with its till data: the order preview (§9). */
export const ORDER_SAMPLE_COURSES: CourseRef[] = [
  { id: 'c0000000-0000-4000-8000-000000000002', name: 'עיקריות', sortOrder: 1 },
  { id: 'c0000000-0000-4000-8000-000000000001', name: 'ראשונות', sortOrder: 0 },
  { id: 'c0000000-0000-4000-8000-000000000003', name: 'קינוחים', sortOrder: 2 },
];
export const ORDER_SAMPLE_CATEGORIES: CategoryRef[] = [
  { id: 'a0000000-0000-4000-8000-000000000001', name: 'שתייה', parentId: null, sortOrder: 0 },
  { id: 'a0000000-0000-4000-8000-000000000002', name: 'סלטים', parentId: null, sortOrder: 1 },
  { id: 'a0000000-0000-4000-8000-000000000003', name: 'מנות עיקריות', parentId: null, sortOrder: 2 },
  { id: 'a0000000-0000-4000-8000-000000000004', name: 'בשרים', parentId: 'a0000000-0000-4000-8000-000000000003', sortOrder: 0 },
  { id: 'a0000000-0000-4000-8000-000000000005', name: 'מתוקים', parentId: null, sortOrder: 3 },
];
export const ORDER_SAMPLE: KitchenTicket = {
  source: 'table',
  tableName: '5',
  guests: 3,
  waiterName: 'דנה',
  createdAt: '2026-10-14T17:30:00Z',
  isAddition: false,
  lines: [
    line('עוגת שוקולד', 1, { seat: 'מ1', course: 'קינוחים', categoryId: ORDER_SAMPLE_CATEGORIES[4].id }),
    line('סטייק סינטה', 1, { seat: 'מ2', course: 'עיקריות', categoryId: ORDER_SAMPLE_CATEGORIES[3].id, mods: ['מדיום'] }),
    line('סלט יווני', 1, { seat: 'מ2', course: 'ראשונות', categoryId: ORDER_SAMPLE_CATEGORIES[1].id }),
    line('לימונדה', 2, { categoryId: ORDER_SAMPLE_CATEGORIES[0].id }),
    line('חומוס', 1, { seat: 'מ1', course: 'ראשונות', categoryId: ORDER_SAMPLE_CATEGORIES[1].id }),
    line('פסטה ארביאטה', 1, { seat: 'מ10', course: 'עיקריות', categoryId: ORDER_SAMPLE_CATEGORIES[2].id }),
  ],
  orderRef: '4490',
  sourceName: 'קופה 1',
  openedAt: '2026-10-14T17:00:00Z',
};

// ── The preview: a ticket drawn as the till would, approximately ──────────────

export type Align = 'start' | 'center';
export type DrawOp =
  | { type: 'text'; x: number; y: number; size: number; bold: boolean; text: string; align: Align; white?: boolean; gray?: boolean }
  | { type: 'rect'; x: number; y: number; w: number; h: number; fill: boolean; stroke: number; rounded?: boolean; dashed?: boolean; gray?: boolean }
  | { type: 'line'; x1: number; y1: number; x2: number; y2: number; stroke: number; dashed?: boolean };

export interface TicketLayout {
  width: number;
  height: number;
  ops: DrawOp[];
  /** The paper it takes, feed lines included (cm). */
  lengthCm: number;
  /** Solid black (fills) over the ticket's area, in percent; text and lines are not counted. */
  blackPct: number;
}

export interface LayoutOptions {
  paper: Paper;
  printerName?: string;
  copy?: number;
  copies?: number;
  courses?: CourseRef[];
  categories?: CategoryRef[];
  timeZone?: string;
  cutPaper?: boolean;
  /** The real text widths (a canvas); the estimate when left out. */
  measure?: Measure;
}

const BIDI = /[\u200e\u200f\u2066-\u2069]/g;

/** An estimate of a text's width at `size` dots (the till measures; the preview guesses). */
export function textWidth(text: string, size: number, bold = false): number {
  let em = 0;
  for (const ch of text.replace(BIDI, '')) {
    if (ch === ' ') em += 0.28;
    else if (/[0-9]/.test(ch)) em += 0.55;
    else if (/[.,:'"·|()\-–—]/.test(ch)) em += 0.3;
    else if (/[A-Z]/.test(ch)) em += 0.62;
    else em += METRICS.avgCharEm;
  }
  return em * size * (bold ? 1.05 : 1);
}

/** How wide a text is drawn: the estimate, or the real canvas (the Windows kiosk's bon). */
export type Measure = (text: string, size: number, bold: boolean) => number;

/** Greedy word wrap; a word wider than the line is broken where it must. */
export function wrapText(text: string, size: number, width: number, bold = false, measure: Measure = textWidth): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const pieces: string[] = [];
  for (const w of words) {
    if (measure(w, size, bold) <= width) {
      pieces.push(w);
      continue;
    }
    let part = '';
    for (const ch of w) {
      if (part && measure(part + ch, size, bold) > width) {
        pieces.push(part);
        part = '';
      }
      part += ch;
    }
    if (part) pieces.push(part);
  }
  if (pieces.length === 0) return [''];
  const rows: string[] = [];
  let current = '';
  for (const p of pieces) {
    const next = current ? `${current} ${p}` : p;
    if (current && measure(next, size, bold) > width) {
      rows.push(current);
      current = p;
    } else current = next;
  }
  rows.push(current);
  return rows;
}

function hhmm(iso: string | null | undefined, timeZone: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${get('hour')}:${get('minute')}`;
}

function stamp(iso: string, timeZone: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 16).replace('T', ' ');
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

function qtyText(q: number): string {
  return Number.isInteger(q) ? String(q) : String(Math.round(q * 1000) / 1000);
}

/** A table name of digits only is "שולחן 12"; any other name as it is. */
export function tableTitle(name: string): string {
  const n = name.trim();
  return /^\d+$/.test(n) ? `שולחן ${n}` : n;
}

/** A choice / removal as the style marks it. */
export function markMod(text: string, removal: boolean, marks: ModMarks): string {
  const t = text.trim();
  if (marks === 'asis') return t;
  const bare = removal ? t.replace(/^בלי\s+/, '') : t.replace(/^\+\s*/, '');
  if (marks === 'plusminus') return removal ? `− ${bare}` : `+ ${bare}`;
  if (marks === 'words') return removal ? `בלי ${bare}` : `עם ${bare}`;
  return removal ? `• בלי ${bare}` : `• ${bare}`;
}

export function elapsedMinutes(ticket: KitchenTicket): number | null {
  if (!ticket.openedAt) return null;
  const a = new Date(ticket.openedAt).getTime();
  const b = new Date(ticket.createdAt).getTime();
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return null;
  return Math.floor((b - a) / 60000);
}

/** "סה"כ 5 פריטים · 2 קורסים": whole quantities count, a weighed line counts one. */
export function totalsText(lines: TicketLine[]): string {
  const items = lines.reduce((n, l) => n + (Number.isInteger(l.quantity) ? l.quantity : 1), 0);
  const courses = new Set(lines.map((l) => (l.course ?? '').trim()).filter(Boolean)).size;
  return `סה"כ ${items} פריטים · ${courses} קורסים`;
}

/**
 * The ticket drawn in `style` at `opts.paper` — draw operations in dots, top to bottom, right to
 * left. `classic_legacy` follows the till's renderer of before; the others the contract's sizes,
 * the one-line fitting and the hanging indent (P:/specs §7, §8, §10).
 */
export function layoutTicket(ticket: KitchenTicket, style: TicketStyle, opts: LayoutOptions): TicketLayout {
  const legacy = style.template === 'classic_legacy';
  const paperKey = String(opts.paper) as '58' | '80';
  const W = METRICS.paper[paperKey].dots;
  const scale = W / 384;
  const pad = legacy ? 10 * scale : METRICS.paper[paperKey].pad;
  const usable = W - 2 * pad;
  const f = style.fontScale / 100;
  const tz = opts.timeZone ?? 'Asia/Jerusalem';
  const ops: DrawOp[] = [];
  const tw: Measure = opts.measure ?? textWidth;
  const wrap = (t: string, size: number, width: number, bold = false) => wrapText(t, size, width, bold, tw);
  const gap = METRICS.lineGap[style.spacing] * scale;
  let y = 6 * scale;
  let black = 0;

  const itemMax = (legacy ? 36 * scale : METRICS.itemSize[paperKey][style.itemName.maxSize]) * f;
  const itemMin = (legacy ? 36 * scale : METRICS.itemSize[paperKey][style.itemName.minSize]) * f;
  const detail = legacy ? 26 * scale * f : itemMax * METRICS.detailRatio;
  const small = (legacy ? 20 * scale : METRICS.smallSize[paperKey]) * f;
  const bandSize = legacy ? 34 * scale * f : itemMax;
  const headerSize = legacy ? 56 * scale * f : itemMax * METRICS.headerRatio[style.header.size];
  const stroke = (w: Weight) => METRICS.separatorWidth[w] * scale;

  const text = (t: string, x: number, size: number, bold: boolean, align: Align, extra: { white?: boolean; gray?: boolean } = {}) =>
    ops.push({ type: 'text', x, y, size, bold, text: t, align, ...extra });
  const rect = (r: Omit<Extract<DrawOp, { type: 'rect' }>, 'type'>) => {
    ops.push({ type: 'rect', ...r });
    if (r.fill) black += r.w * r.h;
  };
  const centred = (t: string, size: number, bold = false, extra: { gray?: boolean } = {}) => {
    for (const row of wrap(t, size, usable, bold)) {
      y += size + gap;
      text(row, W / 2, size, bold, 'center', extra);
    }
  };
  const startX = W - pad;
  const divider = (kind: Separators = style.separators) => {
    if (kind === 'none') {
      y += 6 * scale;
      return;
    }
    y += 8 * scale;
    ops.push({ type: 'line', x1: pad, y1: y, x2: W - pad, y2: y, stroke: stroke(style.separatorWeight), dashed: kind === 'dashed' });
    y += 6 * scale;
  };

  /** A band: its text, framed / underlined / starred / filled as the style says. */
  const band = (t: string, how: BandStyle, size = bandSize) => {
    const label = how === 'stars' ? `*** ${t} ***` : t;
    if (how === 'stars' || how === 'plain' || how === 'underline') {
      y += 6 * scale;
      centred(label, size, true);
      if (how === 'underline') {
        y += 4 * scale;
        const w = Math.min(usable, tw(label, size, true) + 16 * scale);
        ops.push({ type: 'line', x1: W / 2 - w / 2, y1: y, x2: W / 2 + w / 2, y2: y, stroke: 2 * scale });
      }
      return;
    }
    const rows = wrap(label, size, usable - 24 * scale, true);
    const top = y + 10 * scale;
    const h = rows.length * (size + 6 * scale) + 14 * scale;
    const inset = how === 'pill' ? Math.max(0, (usable - Math.max(...rows.map((r) => tw(r, size, true))) - 48 * scale) / 2) : 0;
    rect({ x: pad + inset, y: top, w: usable - 2 * inset, h, fill: how === 'fill', stroke: (how === 'double' ? 2 : 4) * scale, rounded: how === 'pill' });
    if (how === 'double') {
      rect({ x: pad + 5 * scale, y: top + 5 * scale, w: usable - 10 * scale, h: h - 10 * scale, fill: false, stroke: 2 * scale });
    }
    y = top + 4 * scale;
    for (const row of rows) {
      y += size + 6 * scale;
      text(row, W / 2, size, true, 'center', { white: how === 'fill' });
    }
    y = top + h;
  };

  // ── The head ──
  if (ticket.training) band('הדרכה', legacy ? 'outline' : style.bands.training, legacy ? 30 * scale * f : bandSize);

  const fields = style.header.fields;
  const customer = (ticket.customerName ?? '').trim();
  const table = (ticket.tableName ?? '').trim();
  const order = (ticket.orderRef ?? '').trim();
  const zone = (ticket.zoneName ?? '').trim();
  const minutes = style.elapsed ? elapsedMinutes(ticket) : null;
  let headline: string;
  let headlineIs: 'customer' | 'table' | 'sale' | 'none';
  if (ticket.source === 'test') {
    headline = 'בדיקת מדפסת';
    headlineIs = 'none';
  } else if (customer && (legacy || fields.includes('customer'))) {
    headline = customer;
    headlineIs = 'customer';
  } else if (table) {
    headline = tableTitle(table);
    headlineIs = 'table';
  } else if (order) {
    headline = `מכירה #${order}`;
    headlineIs = 'sale';
  } else {
    headline = 'הזמנה';
    headlineIs = 'none';
  }
  const sub: string[] = [];
  if (legacy) {
    if (order && customer) sub.push(`מכירה #${order}`);
    if (zone) sub.push(zone);
    if (ticket.guests) sub.push(`סועדים: ${ticket.guests}`);
  } else {
    for (const field of fields) {
      if (field === 'table') {
        if (headlineIs !== 'table' && table) sub.push(tableTitle(table));
        if (zone) sub.push(zone);
      } else if (field === 'guests' && ticket.guests) sub.push(`${ticket.guests} סועדים`);
      else if (field === 'waiter' && ticket.waiterName) sub.push(ticket.waiterName.trim());
      else if (field === 'time') {
        const t = hhmm(ticket.createdAt, tz);
        if (t) sub.push(t);
      } else if (field === 'till' && ticket.sourceName) sub.push(ticket.sourceName.trim());
      else if (field === 'order' && order && headlineIs !== 'sale') sub.push(`#${order}`);
      else if (field === 'customer' && customer && headlineIs !== 'customer') sub.push(customer);
    }
    if (minutes != null) sub.push(`פתוח ${minutes} דק'`);
  }
  const subText = sub.join(legacy ? '  ·  ' : ' · ');

  if (legacy) {
    let size = headerSize;
    const longest = headline.split(' ').reduce((a, b) => (b.length > a.length ? b : a), headline);
    while (size > 30 * scale * f && tw(longest, size, true) > usable) size -= 2 * scale;
    centred(headline, size, true);
    if (subText) centred(subText, 24 * scale * f, true);
  } else {
    let size = headerSize;
    const fill = style.header.fill;
    const boxed = fill !== 'none';
    const room = usable - (boxed ? 24 * scale : 0);
    while (size > itemMin && tw(headline, size, true) > room) size -= 1;
    const inline =
      style.header.layout === 'inline' && !boxed && subText &&
      tw(headline, size, true) + tw(` · ${subText}`, detail, false) <= usable;
    if (inline) {
      y += size + gap;
      text(`${headline} · ${subText}`, startX, size, true, 'start');
      // The sub-header is smaller: one text run drawn at the headline's size here is an
      // approximation (the till draws two sizes on one baseline).
    } else {
      const top = y + 6 * scale;
      const rows = wrap(headline, size, room, true);
      const h = rows.length * (size + gap) + (boxed ? 16 * scale : 0);
      if (boxed) rect({ x: pad, y: top, w: usable, h, fill: fill === 'fill', stroke: 3 * scale });
      y = top + (boxed ? 6 * scale : 0);
      for (const row of rows) {
        y += size + gap;
        text(row, W / 2, size, true, 'center', { white: fill === 'fill' });
      }
      y = top + h;
      if (subText) {
        for (const row of wrap(subText, detail, usable, true)) {
          y += detail + gap;
          text(row, W / 2, detail, true, 'center');
        }
      }
    }
  }

  if (ticket.isAddition) band('תוספת', style.bands.addition, legacy ? 34 * scale * f : bandSize);
  if (ticket.fire && ticket.fire.trim()) band(`הוצא: ${ticket.fire.trim()}`, style.bands.fire, legacy ? 34 * scale * f : bandSize);
  if (legacy) {
    if (ticket.notice && ticket.notice.trim()) band(ticket.notice.trim(), style.bands.notice === 'fill' ? 'fill' : style.bands.notice, 38 * scale * f);
  } else {
    for (const [kind, part] of noticeParts(ticket.notice)) band(part, style.bands[kind], bandSize * 0.85);
  }
  if (ticket.dining === 'take_away') band('לקחת', style.bands.dining, legacy ? 40 * scale * f : bandSize);
  if (ticket.dining === 'eat_in') band('לשבת', style.bands.eatIn, legacy ? 40 * scale * f : bandSize);
  divider();

  // ── The lines ──
  const groups = orderLines(ticket.lines, style, opts.courses ?? [], opts.categories ?? []);
  const qtyCol = style.layout.qtyColumn;
  const hanging = style.layout.hangingIndent;
  const check = style.checkboxes ? '☐ ' : '';
  const courseShown = (g: LineGroup) => style.order.groupHeaders && g.kind === 'course';

  const detailRows = (t: string, x: number, width: number, size: number, bold: boolean, extra: { gray?: boolean } = {}) => {
    for (const row of wrap(t, size, width, bold)) {
      y += size + 4 * scale;
      text(row, x, size, bold, 'start', extra);
    }
  };
  const boxed = (t: string, x: number, width: number, size: number, how: 'fill' | 'outline' | 'outline_warn') => {
    const rows = wrap(t, size, width - 16 * scale, true);
    const top = y + 8 * scale;
    const h = rows.length * (size + 6 * scale) + 10 * scale;
    rect({ x: x - width, y: top, w: width, h, fill: how === 'fill', stroke: (how === 'outline_warn' ? 3 : 2) * scale });
    y = top;
    for (const row of rows) {
      y += size + 6 * scale;
      text(row, x - 8 * scale, size, true, 'start', { white: how === 'fill' });
    }
    y = top + h;
  };

  for (const group of groups) {
    const groupLines = group.lines.map((i) => ticket.lines[i]);
    const held = style.heldCourse === 'dashed' && group.kind === 'course' && groupLines.length > 0 && groupLines.every((l) => l.held);
    const groupTop = y;
    if (style.order.groupHeaders && group.title) {
      if (legacy) {
        y += 6 * scale;
        centred(`— ${group.title} —`, 28 * scale * f, true);
      } else {
        const how = style.bands.course;
        if (how === 'plain') {
          y += 4 * scale;
          centred(`── ${group.title} ──`, bandSize * 0.85, true, { gray: held });
        } else band(group.title, how, bandSize * 0.85);
      }
    }
    if (held) centred('ממתין ל-FIRE', detail, true, { gray: true });
    let seat: string | null | undefined;
    for (const ln of groupLines) {
      if (style.grouping === 'seat' && ln.seat && ln.seat !== seat) {
        seat = ln.seat;
        y += 2 * scale;
        detailRows(ln.seat, startX, usable, detail, true, { gray: held });
      }
      const qty = qtyText(ln.quantity);
      const gray = held || undefined;
      if (legacy) {
        const rows = wrap(`${qty} × ${ln.name}`, itemMax, usable, true);
        y += 8 * scale;
        for (const row of rows) {
          y += itemMax + 6 * scale;
          text(row, startX, itemMax, true, 'start');
        }
        const subInfo = [ln.seat, ln.mealName ? `(${ln.mealName})` : null, ln.refill].filter(Boolean).join('  ·  ');
        const inset = 24 * scale;
        if (subInfo) detailRows(subInfo, startX - inset, usable - inset, 22 * scale * f, true);
        if (ln.allergies?.length) boxed(`⚠ אלרגיה: ${ln.allergies.join(', ')}`, startX, usable, 28 * scale * f, style.allergy);
        for (const m of ln.mods ?? []) detailRows(markMod(m, false, style.mods.marks), startX - inset, usable - inset, 26 * scale * f, false);
        for (const r of ln.removals ?? []) detailRows(markMod(r, true, style.mods.marks), startX - inset, usable - inset, 28 * scale * f, true);
        const note = (ln.notes ?? '').trim();
        if (note && ln.important) boxed(`! ${note}`, startX, usable, 26 * scale * f, style.note.important);
        else if (note) {
          const top = y + 8 * scale;
          const before = ops.length;
          y = top;
          detailRows(note, startX - inset, usable - inset - 8 * scale, 26 * scale * f, true);
          y += 8 * scale;
          ops.splice(before, 0, { type: 'rect', x: pad, y: top, w: usable - inset + 8 * scale, h: y - top, fill: false, stroke: 2 });
        }
        y += 4 * scale;
        continue;
      }
      // The quantity column ("2×") and the name after it, one line where it fits (§7, §8).
      const qtyLabel = style.qty === 'plain' ? `${qty}×` : qty;
      const colW = qtyCol ? Math.max(tw('12×', itemMax, true), tw(qtyLabel, itemMax, true)) + 10 * scale : 0;
      const nameText = `${check}${ln.name}`;
      const nameWidth = usable - colW - (qtyCol ? 0 : tw(`${qtyLabel} `, itemMax, true));
      let size = itemMax;
      if (style.fit === 'fit') {
        while (size - METRICS.fitStep >= itemMin && tw(nameText, size, true) > nameWidth) size -= METRICS.fitStep;
        if (tw(nameText, size, true) > nameWidth) size = itemMin;
      }
      const mods = [
        ...(ln.mods ?? []).map((m) => markMod(m, false, style.mods.marks)),
        ...(ln.removals ?? []).map((r) => markMod(r, true, style.mods.marks)),
      ];
      const note = (ln.notes ?? '').trim();
      const inlineParts = [...mods, ...(note && !ln.important ? [note] : [])];
      const oneLine = tw(nameText, size, true) <= nameWidth;
      // Choices on the item's line, smaller, after " · " — only when the whole line fits (§8).
      const inlineText = inlineParts.length ? `· ${inlineParts.join(' · ')}` : '';
      const nameRun = tw(`${nameText} `, size, true);
      const inline =
        style.mods.layout === 'inline' && oneLine && inlineParts.length > 0 &&
        nameRun + tw(inlineText, size * METRICS.detailRatio, false) <= nameWidth;
      const nameX = startX - colW;
      const rows = wrap(nameText, size, hanging ? nameWidth : usable, true);
      y += 6 * scale;
      rows.forEach((row, i) => {
        y += size + gap;
        if (i === 0) {
          if (qtyCol) {
            if (style.qty !== 'plain') {
              const bw = colW - 6 * scale;
              rect({ x: startX - bw, y: y - size, w: bw, h: size + 6 * scale, fill: style.qty === 'box_fill', stroke: 2 * scale });
              text(qty, startX - bw / 2, size, true, 'center', { white: style.qty === 'box_fill', gray });
            } else text(qtyLabel, startX, size, true, 'start', { gray });
            text(row, nameX, size, true, 'start', { gray });
          } else text(`${qtyLabel} ${row}`, startX, size, true, 'start', { gray });
          if (inline) {
            const used = qtyCol ? nameRun : tw(`${qtyLabel} ${row} `, size, true);
            text(inlineText, (qtyCol ? nameX : startX) - used, size * METRICS.detailRatio, false, 'start', { gray });
          }
        } else text(row, hanging ? nameX : startX, size, true, 'start', { gray });
      });
      const dsize = size * METRICS.detailRatio;
      const dx = hanging ? nameX : startX - 16 * scale;
      const dw = hanging ? nameWidth : usable - 16 * scale;
      const info = [
        style.grouping === 'seat' ? null : ln.seat,
        ln.mealName ? `(${ln.mealName})` : null,
        ln.refill,
        !courseShown(group) && ln.course ? ln.course : null,
      ].filter(Boolean).join(' · ');
      if (info) detailRows(info, dx, dw, dsize, false, { gray });
      if (ln.allergies?.length) boxed(`⚠ אלרגיה: ${ln.allergies.join(', ')}`, dx, dw, dsize, style.allergy);
      if (!inline) {
        for (const m of mods) detailRows(m, dx, dw, dsize, m.includes('בלי') || m.startsWith('−'), { gray });
        if (note && !ln.important) {
          if (style.note.frame) boxed(note, dx, dw, dsize, 'outline');
          else detailRows(note, dx, dw, dsize, true, { gray });
        }
      }
      if (note && ln.important) boxed(`! ${note}`, dx, dw, dsize, style.note.important);
      if (style.itemDivider !== 'none') {
        y += 4 * scale;
        ops.push({ type: 'line', x1: pad, y1: y, x2: W - pad, y2: y, stroke: 1, dashed: style.itemDivider === 'dashed' });
      }
      y += 2 * scale;
    }
    if (held) rect({ x: pad - 3 * scale, y: groupTop + 4 * scale, w: usable + 6 * scale, h: y - groupTop, fill: false, stroke: 2 * scale, dashed: true, gray: true });
  }
  if (style.totals) {
    y += 4 * scale;
    centred(totalsText(ticket.lines), detail, true);
  }
  divider();

  // ── The foot ──
  const copies = opts.copies ?? 1;
  const printerName = opts.printerName ?? '';
  const printerText = copies > 1 ? `${printerName}${legacy ? '  ·  ' : ' · '}עותק ${opts.copy ?? 1}/${copies}` : printerName;
  if (legacy) {
    centred(stamp(ticket.createdAt, tz), small);
    if (ticket.waiterName) centred(`מלצר/קופאי: ${ticket.waiterName}`, small);
    const refs = [
      order && table ? `הזמנה #${order}` : null,
      ticket.sourceName ? `קופה: ${ticket.sourceName}` : null,
    ].filter(Boolean).join('  ·  ');
    if (refs) centred(refs, small);
    if (printerText) centred(printerText, 24 * scale * f, true);
    y += 14 * scale;
  } else {
    const foot: string[] = [];
    for (const field of style.footer.fields) {
      if (field === 'time') foot.push(hhmm(ticket.createdAt, tz) ?? '');
      else if (field === 'waiter' && ticket.waiterName) foot.push(ticket.waiterName);
      else if (field === 'order' && order) foot.push(`#${order}`);
      else if (field === 'till' && ticket.sourceName) foot.push(ticket.sourceName);
      else if (field === 'guests' && ticket.guests) foot.push(`${ticket.guests} סועדים`);
      else if (field === 'customer' && customer && headlineIs !== 'customer') foot.push(customer);
      else if (field === 'table' && table && headlineIs !== 'table') foot.push(tableTitle(table));
      else if (field === 'printer' && printerText) foot.push(printerText);
    }
    const parts = foot.filter(Boolean);
    if (style.footer.layout === 'inline') {
      if (parts.length) centred(parts.join(' · '), small);
    } else for (const p of parts) centred(p, small);
    y += 8 * scale;
  }
  const height = Math.max(Math.ceil(y), 120);
  const feed = (opts.cutPaper === false ? 6 : style.feedLines) * METRICS.feedLineDots;
  return {
    width: W,
    height,
    ops,
    lengthCm: Math.round(((height + feed) / METRICS.dotsPerMm / 10) * 10) / 10,
    blackPct: Math.round((black / (W * height)) * 1000) / 10,
  };
}

/** What the ticket says, in drawing order, one space between, bidi marks removed (the golden's check). */
export function layoutText(layout: TicketLayout): string {
  return layout.ops
    .filter((op): op is Extract<DrawOp, { type: 'text' }> => op.type === 'text')
    .map((op) => op.text)
    .join(' ')
    .replace(BIDI, '');
}
