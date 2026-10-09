/**
 * "עיצוב קופה" — the till's order screens as the cloud designs them (pos-server
 * app/services/till_design.py, docs/SPEC_TILL_DESIGN.md). Self-contained, so `npm test` compiles
 * it alone.
 *
 * One versioned config, stored as partial override layers company → shop → area (point of sale)
 * → till: objects and the `texts` map deep-merge, lists and scalars replace, `null` inherits.
 * Nothing set anywhere is today's screens (`template: clean`, every other value "auto", which the
 * till resolves from its parameters).
 *
 * This file mirrors the Python module one to one — the schema and its error codes, the merge,
 * `forProfile` (what one device profile shows), the banknote buttons and the till parameters'
 * quick-pay buttons — and the shared fixture tests/fixtures/till_design_contract.json pins it
 * (tillDesign.test.ts runs every case). The till (pos-android domain/TillDesign.kt) mirrors it too.
 */

/* ------------------------------------------------------------ vocabularies */

export const SCHEMA_VERSION = 1;

export const TEMPLATES = ['clean', 'touch', 'professional', 'seated', 'fast', 'mobile'] as const;
export type Template = (typeof TEMPLATES)[number];
/** Phase 2: shown in the dashboard as "בקרוב", refused on save. */
export const PHASE2_TEMPLATES = ['courses', 'payDock', 'night', 'visual'] as const;
export type Phase2Template = (typeof PHASE2_TEMPLATES)[number];
/** Old names, read as their template (the cloud stores the new name). */
export const TEMPLATE_ALIASES: Record<string, Template> = {
  classic: 'clean',
  photo: 'touch',
  list: 'professional',
  keypad: 'professional',
  seats: 'seated',
  speed: 'fast',
  nightBar: 'fast',
  handheld: 'mobile',
};

export const PROFILES = ['handheld', 'tabletLandscape', 'tabletPortrait', 'ipadPortrait', 'ipadLandscape'] as const;
export type Profile = (typeof PROFILES)[number];
/** The device profiles' screens in dp (CSS px for the iPad sizes): [width, height]. */
export const PROFILE_SIZES: Record<Profile, [number, number]> = {
  handheld: [360, 640],
  tabletLandscape: [1280, 800],
  tabletPortrait: [800, 1280],
  ipadPortrait: [768, 1024],
  ipadLandscape: [1024, 768],
};
/** The profiles an Android till uses (the iPad ones are for the future web / Windows till). */
export const ANDROID_PROFILES: Profile[] = ['handheld', 'tabletLandscape', 'tabletPortrait'];

export const MODES = ['table', 'quick'] as const;
export type Mode = (typeof MODES)[number];

export const TILE_SIZES = ['auto', 'xs', 's', 'm', 'l'] as const;
export type TileSize = (typeof TILE_SIZES)[number];
export const TILE_STYLES = ['auto', 'card', 'photo', 'row', 'key'] as const;
export type TileStyle = (typeof TILE_STYLES)[number];
export const DENSITIES = ['compact', 'comfortable', 'spacious'] as const;
export type Density = (typeof DENSITIES)[number];
/** Where the bill stands. In RTL "end" is the LEFT side, "start" the right. */
export const BILL_POSITIONS = ['auto', 'end', 'start', 'bottom', 'sheet'] as const;
export type BillPosition = (typeof BILL_POSITIONS)[number];
export const CATEGORY_BARS = ['auto', 'top', 'side'] as const;
export type CategoryBar = (typeof CATEGORY_BARS)[number];
export const IMAGES = ['auto', 'show', 'hide'] as const;
export type ImagesMode = (typeof IMAGES)[number];
export const TEXT_SIZES = ['normal', 'large'] as const;
export type TextSize = (typeof TEXT_SIZES)[number];
export const COLOR_MODES = ['auto', 'light', 'dark'] as const;
export type ColorMode = (typeof COLOR_MODES)[number];
export const FIELD_MODES = ['auto', 'off', 'optional', 'required'] as const;
export type FieldMode = (typeof FIELD_MODES)[number];
export const FIELD_KEYS = ['customerName', 'serviceType', 'guests'] as const;
export type FieldKey = (typeof FIELD_KEYS)[number];
export const SUMMARY_STATES = ['auto', 'open', 'closed'] as const;
export type SummaryState = (typeof SUMMARY_STATES)[number];
export const MAP_STYLES = ['auto', 'classic', 'modern'] as const;
export type MapStyle = (typeof MAP_STYLES)[number];
export const SHOW_HIDE = ['auto', 'show', 'hide'] as const;
export type ShowHide = (typeof SHOW_HIDE)[number];

export const QUICK_ACTIONS = [
  'pay', 'fastCard', 'cashWithChange', 'fastCash', 'cashNotes',
  'hold', 'discount', 'customer', 'orderDetails', 'clear',
] as const;
export type QuickAction = (typeof QUICK_ACTIONS)[number];
export const TABLE_ACTIONS = ['send', 'bill', 'pay', 'split', 'move', 'guests', 'notes', 'discount', 'repeatRound'] as const;
export type TableAction = (typeof TABLE_ACTIONS)[number];
export type ActionId = QuickAction | TableAction;
/** The one button each list must keep when it is set: the payment screen / the kitchen. */
export const REQUIRED_ACTION: Record<Mode, ActionId> = { quick: 'pay', table: 'send' };
export const ACTION_BAR_MAX = 6;
export const ACTION_LABEL_MAX = 24;

/** Default labels (Hebrew, the till's language). A button's own `label` replaces it. */
export const ACTION_LABELS: Record<ActionId, string> = {
  send: 'שדר למטבח',
  bill: 'מעבר לחשבון',
  pay: 'תשלום',
  split: 'פיצול',
  move: 'העבר',
  guests: 'סועדים',
  notes: 'הערות',
  discount: 'הנחה',
  repeatRound: 'עוד סבב',
  fastCard: 'אשראי מהיר',
  cashWithChange: 'מזומן עם עודף',
  fastCash: 'מזומן מהיר',
  cashNotes: 'שטרות',
  hold: 'השהה',
  customer: 'לקוח',
  orderDetails: 'פרטי הזמנה',
  clear: 'נקה הזמנה',
};

/** Banknotes / coin for "שטרות" (cashNotes). */
export const CASH_NOTE_VALUES = [10, 20, 50, 100, 200] as const;
export const CASH_NOTES_MAX = 4;
export const CASH_COUNT_MIN = 1;
export const CASH_COUNT_MAX = 4;

export const QUANTITY_PRESETS_MIN = 2;
export const QUANTITY_PRESETS_MAX = 6;
export const QUANTITY_MAX = 99;
export const FAVORITES_MAX = 24;
export const MENU_IDS_MAX = 2000;
export const COLUMNS_CHOICES = [0, 2, 3, 4, 5, 6, 7, 8] as const;

/** The screen texts a business may reword ("" = the default below). */
export const TEXT_DEFAULTS = {
  sendToKitchen: 'שדר למטבח',
  newSuffix: 'חדש',
  allSent: 'הכול שודר',
  goToBill: 'מעבר לחשבון',
  pay: 'תשלום',
  orderTitle: 'הזמנה',
  summary: 'סיכום ההזמנה',
  emptyOrder: 'ההזמנה ריקה',
  serviceType: 'סוג שירות',
  takeAway: 'לקחת',
  eatIn: 'לשבת',
  customerName: 'שם לקוח',
  addToSeat: 'הוספה לסועד',
  seatGeneral: 'כללי',
  nextQuantity: 'כמות לפריט הבא',
  otherQuantity: 'כמות אחרת',
  favorites: 'מועדפים',
  repeatRound: 'עוד סבב',
} as const;
export type TextKey = keyof typeof TEXT_DEFAULTS;
export const TEXT_KEYS = Object.keys(TEXT_DEFAULTS) as TextKey[];
export const TEXT_MAX = 40;

/* ------------------------------------------------------------ the config */

export interface ActionItem {
  action: ActionId;
  label: string;
}

export interface ProfileOverride {
  template: Template | null;
  tileSize: TileSize | null;
  tileStyle: TileStyle | null;
  density: Density | null;
  billPosition: BillPosition | null;
  categoryBar: CategoryBar | null;
  columns: number | null;
}
export const PROFILE_OVERRIDE_KEYS = ['template', 'tileSize', 'tileStyle', 'density', 'billPosition', 'categoryBar', 'columns'] as const;
export type ProfileOverrideKey = (typeof PROFILE_OVERRIDE_KEYS)[number];

export interface TillDesignConfig {
  schemaVersion: number;
  template: Template;
  layout: {
    tileSize: TileSize;
    tileStyle: TileStyle;
    density: Density;
    billPosition: BillPosition;
    categoryBar: CategoryBar;
    images: ImagesMode;
    columns: number;
    textSize: TextSize;
  };
  profiles: Record<Profile, ProfileOverride>;
  actionBar: { table: ActionItem[]; quick: ActionItem[] };
  quickCash: { notes: number[]; count: number };
  bar: { quantityPresets: number[]; favorites: string[]; repeatRound: boolean };
  menu: { categoryOrder: string[]; productOrder: string[]; hiddenCategories: string[] };
  colors: { accent: string | null; mode: ColorMode };
  texts: Partial<Record<TextKey, string>>;
  fields: Record<FieldKey, FieldMode>;
  behavior: { summary: SummaryState; lineStatus: boolean };
  tables: { mapStyle: MapStyle; showChairs: ShowHide };
}

/** A partial layer as stored / sent (`{overrides}`). */
export type TillDesignLayer = { [key: string]: unknown };

function emptyProfile(): ProfileOverride {
  return { template: null, tileSize: null, tileStyle: null, density: null, billPosition: null, categoryBar: null, columns: null };
}

export const TILL_DESIGN_DEFAULTS: TillDesignConfig = {
  schemaVersion: SCHEMA_VERSION,
  template: 'clean',
  layout: {
    tileSize: 'auto',
    tileStyle: 'auto',
    density: 'comfortable',
    billPosition: 'auto',
    categoryBar: 'auto',
    images: 'auto',
    columns: 0,
    textSize: 'normal',
  },
  profiles: {
    handheld: emptyProfile(),
    tabletLandscape: emptyProfile(),
    tabletPortrait: emptyProfile(),
    ipadPortrait: emptyProfile(),
    ipadLandscape: emptyProfile(),
  },
  // [] = "auto": a table's from its template, a quick order's from the till parameters.
  actionBar: { table: [], quick: [] },
  quickCash: { notes: [], count: 3 },
  bar: { quantityPresets: [1, 2, 3, 5], favorites: [], repeatRound: true },
  menu: { categoryOrder: [], productOrder: [], hiddenCategories: [] },
  colors: { accent: null, mode: 'auto' },
  texts: {},
  fields: { customerName: 'auto', serviceType: 'auto', guests: 'auto' },
  behavior: { summary: 'auto', lineStatus: true },
  tables: { mapStyle: 'auto', showChairs: 'auto' },
};

/* ----------------------------------------------- what each template is */

export type BillStyle = 'lines' | 'cards' | 'seats' | 'compact';
export type Feature = 'searchField' | 'seatCards' | 'quantityPresets' | 'favorites' | 'seatPicker';
/** A bill position once resolved ("auto" settled). */
export type ResolvedBillPosition = Exclude<BillPosition, 'auto'>;

export interface TemplateDefaults {
  tileStyle: Exclude<TileStyle, 'auto'>;
  billStyle: BillStyle;
  billPosition: Record<Mode, Record<Profile, ResolvedBillPosition>>;
  tableActions: ActionId[];
  features: Feature[];
  summaryCollapsible: boolean;
}

function allProfiles(position: ResolvedBillPosition): Record<Profile, ResolvedBillPosition> {
  return { handheld: position, tabletLandscape: position, tabletPortrait: position, ipadPortrait: position, ipadLandscape: position };
}

const SIDE: Record<Profile, ResolvedBillPosition> = {
  handheld: 'bottom',
  tabletLandscape: 'end',
  tabletPortrait: 'bottom',
  ipadPortrait: 'bottom',
  ipadLandscape: 'end',
};

function both(byProfile: Record<Profile, ResolvedBillPosition>): Record<Mode, Record<Profile, ResolvedBillPosition>> {
  return { table: { ...byProfile }, quick: { ...byProfile } };
}

/** The shared template table (docs/SPEC_TILL_DESIGN.md §4), as TEMPLATE_DEFAULTS in Python. */
export const TEMPLATE_DEFAULTS: Record<Template, TemplateDefaults> = {
  clean: {
    tileStyle: 'card',
    billStyle: 'lines',
    billPosition: {
      table: allProfiles('sheet'),
      quick: { handheld: 'sheet', tabletLandscape: 'end', tabletPortrait: 'bottom', ipadPortrait: 'bottom', ipadLandscape: 'end' },
    },
    tableActions: ['send'],
    features: [],
    summaryCollapsible: false,
  },
  touch: {
    tileStyle: 'photo',
    billStyle: 'cards',
    billPosition: both(SIDE),
    tableActions: ['send', 'bill'],
    features: [],
    summaryCollapsible: false,
  },
  professional: {
    tileStyle: 'row',
    billStyle: 'lines',
    billPosition: both({ handheld: 'sheet', tabletLandscape: 'end', tabletPortrait: 'end', ipadPortrait: 'end', ipadLandscape: 'end' }),
    tableActions: ['send', 'bill'],
    features: ['searchField'],
    summaryCollapsible: false,
  },
  seated: {
    tileStyle: 'card',
    billStyle: 'seats',
    billPosition: both(SIDE),
    tableActions: ['send', 'bill', 'split'],
    features: ['seatCards'],
    summaryCollapsible: false,
  },
  fast: {
    tileStyle: 'key',
    billStyle: 'compact',
    billPosition: both(SIDE),
    tableActions: ['send', 'repeatRound', 'bill'],
    features: ['quantityPresets', 'favorites'],
    summaryCollapsible: false,
  },
  mobile: {
    tileStyle: 'card',
    billStyle: 'lines',
    billPosition: both(allProfiles('bottom')),
    tableActions: ['send', 'bill'],
    features: ['seatPicker'],
    summaryCollapsible: true,
  },
};

/** Where each "auto" comes from on the till (the dashboard shows it; the till applies it). */
export const LEGACY_MAP: Record<string, string[]> = {
  'layout.tileSize': ['productTileSize', 'productTileSizeTablet', 'productTileSizeTables', 'productTileSizeTabletTables'],
  'actionBar.quick': ['quickPayButton1', 'quickPayButton2', 'fastCard', 'fastCash'],
  'fields.customerName': ['askOrderName'],
  'fields.serviceType': ['askEatInTakeAway'],
  'fields.guests': ['tablesAskGuests'],
  'tables.mapStyle': ['tablesMapStyle'],
  'tables.showChairs': ['tablesShowChairs'],
  'colors.accent': ['brandPrimaryColor'],
  'menu.categoryOrder': ['categoryOrder'],
  'menu.productOrder': ['productOrder'],
};

/** The vocabularies and the template table, as `GET /till-design/defaults` sends them. */
export function tillDesignCatalog() {
  return {
    schemaVersion: SCHEMA_VERSION,
    templates: [...TEMPLATES],
    phase2Templates: [...PHASE2_TEMPLATES],
    templateAliases: { ...TEMPLATE_ALIASES },
    profiles: [...PROFILES],
    profileSizes: Object.fromEntries(PROFILES.map((p) => [p, [...PROFILE_SIZES[p]]])) as Record<Profile, number[]>,
    androidProfiles: [...ANDROID_PROFILES],
    templateDefaults: cloneJson(TEMPLATE_DEFAULTS),
    quickActions: [...QUICK_ACTIONS],
    tableActions: [...TABLE_ACTIONS],
    requiredAction: { ...REQUIRED_ACTION },
    actionLabels: { ...ACTION_LABELS },
    actionBarMax: ACTION_BAR_MAX,
    actionLabelMax: ACTION_LABEL_MAX,
    cashNoteValues: [...CASH_NOTE_VALUES],
    textDefaults: { ...TEXT_DEFAULTS },
    textMax: TEXT_MAX,
    favoritesMax: FAVORITES_MAX,
    legacyMap: cloneJson(LEGACY_MAP),
    vocab: {
      tileSize: [...TILE_SIZES],
      tileStyle: [...TILE_STYLES],
      density: [...DENSITIES],
      billPosition: [...BILL_POSITIONS],
      categoryBar: [...CATEGORY_BARS],
      images: [...IMAGES],
      textSize: [...TEXT_SIZES],
      colorMode: [...COLOR_MODES],
      fieldMode: [...FIELD_MODES],
      summary: [...SUMMARY_STATES],
      mapStyle: [...MAP_STYLES],
      showChairs: [...SHOW_HIDE],
      columns: [...COLUMNS_CHOICES],
    },
  };
}

/* ------------------------------------------------------------ JSON helpers */

type Dict = Record<string, unknown>;

function isDict(v: unknown): v is Dict {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A deep copy of JSON-shaped data. */
export function cloneJson<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

/** Structural equality of JSON-shaped values (key order does not matter). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => jsonEqual(x, b[i]));
  }
  if (isDict(a) && isDict(b)) {
    const ka = Object.keys(a).filter((k) => a[k] !== undefined);
    const kb = Object.keys(b).filter((k) => b[k] !== undefined);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && jsonEqual(a[k], b[k]));
  }
  return false;
}

/**
 * The canonical JSON the cloud hashes for `configVersion` (Python `json.dumps(cfg,
 * sort_keys=True, separators=(",", ":"), ensure_ascii=False)`); its SHA-256's first 16 hex
 * characters are the version.
 */
export function canonicalJson(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (isDict(v)) {
    const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split('.')) {
    if (!isDict(cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

/** A copy of `obj` with `path` set to `value` (copy-on-write along the path). */
export function setPath<T>(obj: T, path: string, value: unknown): T {
  const parts = path.split('.');
  const root: Dict = isDict(obj) ? { ...obj } : {};
  let cur = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const next = cur[parts[i]];
    const copy: Dict = isDict(next) ? { ...next } : {};
    cur[parts[i]] = copy;
    cur = copy;
  }
  const last = parts[parts.length - 1];
  if (value === undefined) delete cur[last];
  else cur[last] = value;
  return root as unknown as T;
}

export function moveItem<T>(list: readonly T[], index: number, delta: number): T[] {
  const to = index + delta;
  if (index < 0 || index >= list.length || to < 0 || to >= list.length) return [...list];
  const out = [...list];
  const [item] = out.splice(index, 1);
  out.splice(to, 0, item);
  return out;
}

/** `list` with the item at `from` moved to `to` (a drag's drop). */
export function moveTo<T>(list: readonly T[], from: number, to: number): T[] {
  if (from < 0 || from >= list.length || to < 0 || to >= list.length || from === to) return [...list];
  const out = [...list];
  const [item] = out.splice(from, 1);
  out.splice(to, 0, item);
  return out;
}

/* --------------------------------------------------------------- the schema */

/** One validation error, as the server reports it (`{path, code, message}`). */
export interface TillDesignIssue {
  path: string;
  code: string;
  message: string;
}

const INVALID = Symbol('invalid');
type Checked = unknown | typeof INVALID;

const HEX = /^#[0-9A-Fa-f]{6}$/;
const ID_MAX = 64;

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

function fail(errors: TillDesignIssue[], path: string, code: string, message: string): typeof INVALID {
  errors.push({ path, code, message });
  return INVALID;
}

function join(path: string, key: string): string {
  return path ? `${path}.${key}` : key;
}

abstract class SchemaNode {
  nullable = false;
  /** Objects and maps deep-merge; everything else replaces. */
  merges = false;
  abstract check(value: unknown, path: string, errors: TillDesignIssue[]): Checked;
  checkLayer(value: unknown, path: string, errors: TillDesignIssue[]): Checked {
    return this.check(value, path, errors);
  }
}

class BoolNode extends SchemaNode {
  check(value: unknown, path: string, errors: TillDesignIssue[]): Checked {
    if (typeof value !== 'boolean') return fail(errors, path, 'invalid_type', 'must be true or false');
    return value;
  }
}

class IntNode extends SchemaNode {
  constructor(readonly lo: number, readonly hi: number) {
    super();
  }
  check(value: unknown, path: string, errors: TillDesignIssue[]): Checked {
    if (!isInt(value)) return fail(errors, path, 'invalid_type', 'must be an integer');
    if (value < this.lo || value > this.hi) return fail(errors, path, 'out_of_range', `must be between ${this.lo} and ${this.hi}`);
    return value;
  }
}

class StrNode extends SchemaNode {
  constructor(readonly maxLen: number, readonly minLen = 0) {
    super();
  }
  check(value: unknown, path: string, errors: TillDesignIssue[]): Checked {
    if (typeof value !== 'string') return fail(errors, path, 'invalid_type', 'must be a string');
    if (value.length > this.maxLen) return fail(errors, path, 'too_long', `at most ${this.maxLen} characters`);
    if (value.length < this.minLen) return fail(errors, path, 'required', `at least ${this.minLen} characters`);
    return value;
  }
}

class EnumNode extends SchemaNode {
  constructor(readonly values: readonly string[], nullable = false) {
    super();
    this.nullable = nullable;
  }
  check(value: unknown, path: string, errors: TillDesignIssue[]): Checked {
    if (value === null && this.nullable) return null;
    if (typeof value !== 'string' || !this.values.includes(value)) {
      return fail(errors, path, 'invalid_value', `must be one of: ${this.values.join(', ')}`);
    }
    return value;
  }
}

class IntChoiceNode extends SchemaNode {
  constructor(readonly values: readonly number[], nullable = false) {
    super();
    this.nullable = nullable;
  }
  check(value: unknown, path: string, errors: TillDesignIssue[]): Checked {
    if (value === null && this.nullable) return null;
    if (!isInt(value) || !this.values.includes(value)) {
      return fail(errors, path, 'invalid_value', `must be one of: ${this.values.join(', ')}`);
    }
    return value;
  }
}

class ColorNode extends SchemaNode {
  constructor(nullable = false) {
    super();
    this.nullable = nullable;
  }
  check(value: unknown, path: string, errors: TillDesignIssue[]): Checked {
    if (value === null && this.nullable) return null;
    if (typeof value !== 'string' || !HEX.test(value)) return fail(errors, path, 'invalid_color', 'must be a colour #RRGGBB');
    return value;
  }
}

class TemplateNode extends SchemaNode {
  constructor(nullable = false) {
    super();
    this.nullable = nullable;
  }
  check(value: unknown, path: string, errors: TillDesignIssue[]): Checked {
    if (value === null && this.nullable) return null;
    if (typeof value === 'string' && (PHASE2_TEMPLATES as readonly string[]).includes(value)) {
      return fail(errors, path, 'template_not_available', 'this template is not available yet (phase 2)');
    }
    if (typeof value !== 'string' || !(TEMPLATES as readonly string[]).includes(value)) {
      return fail(errors, path, 'invalid_value', `must be one of: ${TEMPLATES.join(', ')}`);
    }
    return value;
  }
}

class ListNode extends SchemaNode {
  constructor(
    readonly item: SchemaNode,
    readonly opts: { minLen?: number; maxLen: number; unique?: boolean },
  ) {
    super();
  }
  check(value: unknown, path: string, errors: TillDesignIssue[]): Checked {
    if (!Array.isArray(value)) return fail(errors, path, 'invalid_type', 'must be a list');
    const before = errors.length;
    if (value.length > this.opts.maxLen) fail(errors, path, 'too_many', `at most ${this.opts.maxLen} items`);
    if (value.length < (this.opts.minLen ?? 0)) fail(errors, path, 'too_few', `at least ${this.opts.minLen} item(s)`);
    const out: unknown[] = [];
    const seen = new Set<string>();
    value.forEach((item, i) => {
      const cleaned = this.item.check(item, `${path}[${i}]`, errors);
      if (cleaned === INVALID) return;
      if (this.opts.unique) {
        const marker = canonicalJson(cleaned);
        if (seen.has(marker)) {
          fail(errors, `${path}[${i}]`, 'duplicate', 'duplicate value');
          return;
        }
        seen.add(marker);
      }
      out.push(cleaned);
    });
    if (errors.length > before) return INVALID;
    return out;
  }
}

class ObjNode extends SchemaNode {
  constructor(
    readonly fields: Record<string, SchemaNode>,
    readonly fill: Record<string, unknown> = {},
    merges = true,
  ) {
    super();
    this.merges = merges;
  }
  check(value: unknown, path: string, errors: TillDesignIssue[]): Checked {
    if (!isDict(value)) return fail(errors, path, 'invalid_type', 'must be an object');
    const before = errors.length;
    const out: Dict = {};
    for (const key of Object.keys(value)) {
      if (!(key in this.fields)) fail(errors, join(path, key), 'unknown_key', 'unknown key');
    }
    for (const [key, node] of Object.entries(this.fields)) {
      let raw: unknown;
      if (key in value) raw = value[key];
      else if (key in this.fill) raw = cloneJson(this.fill[key]);
      else {
        fail(errors, join(path, key), 'required', 'required');
        continue;
      }
      const cleaned = node.check(raw, join(path, key), errors);
      if (cleaned !== INVALID) out[key] = cleaned;
    }
    if (errors.length > before) return INVALID;
    return out;
  }
  checkLayer(value: unknown, path: string, errors: TillDesignIssue[]): Checked {
    if (!isDict(value)) return fail(errors, path, 'invalid_type', 'must be an object');
    const out: Dict = {};
    for (const [key, raw] of Object.entries(value)) {
      const node = this.fields[key];
      if (!node) {
        fail(errors, join(path, key), 'unknown_key', 'unknown key');
        continue;
      }
      if (raw === null || raw === undefined) continue; // inherit
      const cleaned = node.merges ? node.checkLayer(raw, join(path, key), errors) : node.check(raw, join(path, key), errors);
      if (cleaned !== INVALID) out[key] = cleaned;
    }
    return out;
  }
}

/** An id-keyed object with fixed keys (`texts`). */
class MapNode extends SchemaNode {
  constructor(
    readonly value: SchemaNode,
    readonly keys: readonly string[],
  ) {
    super();
    this.merges = true;
  }
  private walk(value: unknown, path: string, errors: TillDesignIssue[], layer: boolean): Checked {
    if (!isDict(value)) return fail(errors, path, 'invalid_type', 'must be an object');
    const before = errors.length;
    const out: Dict = {};
    for (const [key, raw] of Object.entries(value)) {
      if (!this.keys.includes(key)) {
        fail(errors, join(path, key), 'unknown_key', 'unknown key');
        continue;
      }
      if ((raw === null || raw === undefined) && (layer || this.value.nullable)) {
        if (!layer) out[key] = null;
        continue;
      }
      const cleaned = this.value.check(raw, join(path, key), errors);
      if (cleaned !== INVALID) out[key] = cleaned;
    }
    if (!layer && errors.length > before) return INVALID;
    return out;
  }
  check(value: unknown, path: string, errors: TillDesignIssue[]): Checked {
    return this.walk(value, path, errors, false);
  }
  checkLayer(value: unknown, path: string, errors: TillDesignIssue[]): Checked {
    return this.walk(value, path, errors, true);
  }
}

const ID = new StrNode(ID_MAX, 1);

function actionItem(actions: readonly string[]): ObjNode {
  return new ObjNode({ action: new EnumNode(actions), label: new StrNode(ACTION_LABEL_MAX) }, { label: '' }, false);
}

const PROFILE_OVERRIDE = new ObjNode(
  {
    template: new TemplateNode(true),
    tileSize: new EnumNode(TILE_SIZES, true),
    tileStyle: new EnumNode(TILE_STYLES, true),
    density: new EnumNode(DENSITIES, true),
    billPosition: new EnumNode(BILL_POSITIONS, true),
    categoryBar: new EnumNode(CATEGORY_BARS, true),
    columns: new IntChoiceNode(COLUMNS_CHOICES, true),
  },
  { template: null, tileSize: null, tileStyle: null, density: null, billPosition: null, categoryBar: null, columns: null },
);

const SCHEMA = new ObjNode({
  schemaVersion: new IntChoiceNode([SCHEMA_VERSION]),
  template: new TemplateNode(),
  layout: new ObjNode({
    tileSize: new EnumNode(TILE_SIZES),
    tileStyle: new EnumNode(TILE_STYLES),
    density: new EnumNode(DENSITIES),
    billPosition: new EnumNode(BILL_POSITIONS),
    categoryBar: new EnumNode(CATEGORY_BARS),
    images: new EnumNode(IMAGES),
    columns: new IntChoiceNode(COLUMNS_CHOICES),
    textSize: new EnumNode(TEXT_SIZES),
  }),
  profiles: new ObjNode(Object.fromEntries(PROFILES.map((p) => [p, PROFILE_OVERRIDE]))),
  actionBar: new ObjNode({
    table: new ListNode(actionItem(TABLE_ACTIONS), { maxLen: ACTION_BAR_MAX }),
    quick: new ListNode(actionItem(QUICK_ACTIONS), { maxLen: ACTION_BAR_MAX }),
  }),
  quickCash: new ObjNode({
    notes: new ListNode(new IntChoiceNode(CASH_NOTE_VALUES), { maxLen: CASH_NOTES_MAX, unique: true }),
    count: new IntNode(CASH_COUNT_MIN, CASH_COUNT_MAX),
  }),
  bar: new ObjNode({
    quantityPresets: new ListNode(new IntNode(1, QUANTITY_MAX), {
      minLen: QUANTITY_PRESETS_MIN,
      maxLen: QUANTITY_PRESETS_MAX,
      unique: true,
    }),
    favorites: new ListNode(ID, { maxLen: FAVORITES_MAX, unique: true }),
    repeatRound: new BoolNode(),
  }),
  menu: new ObjNode({
    categoryOrder: new ListNode(ID, { maxLen: MENU_IDS_MAX, unique: true }),
    productOrder: new ListNode(ID, { maxLen: MENU_IDS_MAX, unique: true }),
    hiddenCategories: new ListNode(ID, { maxLen: MENU_IDS_MAX, unique: true }),
  }),
  colors: new ObjNode({ accent: new ColorNode(true), mode: new EnumNode(COLOR_MODES) }),
  texts: new MapNode(new StrNode(TEXT_MAX), TEXT_KEYS),
  fields: new ObjNode(Object.fromEntries(FIELD_KEYS.map((k) => [k, new EnumNode(FIELD_MODES)]))),
  behavior: new ObjNode({ summary: new EnumNode(SUMMARY_STATES), lineStatus: new BoolNode() }),
  tables: new ObjNode({ mapStyle: new EnumNode(MAP_STYLES), showChairs: new EnumNode(SHOW_HIDE) }),
});

/* --------------------------------------------------------------- validation */

function dedupe(errors: TillDesignIssue[]): TillDesignIssue[] {
  const seen = new Set<string>();
  const out: TillDesignIssue[] = [];
  for (const e of errors) {
    const key = `${e.path}\u0000${e.code}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(e);
    }
  }
  return out;
}

/** The rules one node cannot see: the bars' required button and duplicates; a preset of 1. */
function crossField(cfg: Dict, errors: TillDesignIssue[]): void {
  const bars = isDict(cfg.actionBar) ? cfg.actionBar : {};
  for (const mode of MODES) {
    const items = bars[mode];
    if (!Array.isArray(items) || items.length === 0) continue;
    const actions = items.filter(isDict).map((i) => i.action);
    const seen = new Set<unknown>();
    actions.forEach((action, i) => {
      if (seen.has(action)) errors.push({ path: `actionBar.${mode}[${i}]`, code: 'duplicate', message: 'this button is already on the bar' });
      seen.add(action);
    });
    const required = REQUIRED_ACTION[mode];
    if (!actions.includes(required)) {
      errors.push({ path: `actionBar.${mode}`, code: `action_bar_missing_${required}`, message: `the bar must keep the '${required}' button` });
    }
  }
  const bar = isDict(cfg.bar) ? cfg.bar : {};
  const presets = bar.quantityPresets;
  if (Array.isArray(presets) && presets.length > 0 && !presets.includes(1)) {
    errors.push({ path: 'bar.quantityPresets', code: 'quantity_presets_need_one', message: 'the presets must include 1' });
  }
}

/** Drop objects a layer left empty (`{"layout": {}}`, a profile with nothing set). */
function pruneEmpty(layer: Dict): Dict {
  const out: Dict = {};
  for (const [key, raw] of Object.entries(layer)) {
    let value = raw;
    const node = SCHEMA.fields[key];
    if (key === 'profiles' && isDict(value)) {
      value = Object.fromEntries(Object.entries(value).filter(([, v]) => isDict(v) && Object.keys(v).length > 0));
    }
    if (isDict(value) && Object.keys(value).length === 0 && node instanceof ObjNode) continue;
    out[key] = value;
  }
  return out;
}

/** A partial layer as the dashboard sends it: `{cleaned, errors}` (nulls dropped) — `validate_layer`. */
export function validateTillDesignLayer(overrides: unknown): { cleaned: TillDesignLayer; errors: TillDesignIssue[] } {
  const errors: TillDesignIssue[] = [];
  let cleaned = SCHEMA.checkLayer(overrides, '', errors);
  if (cleaned === INVALID || !isDict(cleaned)) cleaned = {};
  const pruned = pruneEmpty(cleaned as Dict);
  crossField(pruned, errors);
  return { cleaned: pruned, errors: dedupe(errors) };
}

/** A complete config (an effective one, the editor's draft): every rule — `validate_config`. */
export function validateTillDesign(cfg: unknown): TillDesignIssue[] {
  const errors: TillDesignIssue[] = [];
  SCHEMA.check(cfg, '', errors);
  crossField(isDict(cfg) ? cfg : {}, errors);
  return dedupe(errors);
}

/** A stored layer with whatever no longer validates dropped (never throws). */
export function sanitizeStoredLayer(overrides: unknown): TillDesignLayer {
  if (!isDict(overrides)) return {};
  const { cleaned, errors } = validateTillDesignLayer(overrides);
  for (const e of errors) {
    if (e.path.startsWith('actionBar.') && e.code.startsWith('action_bar_missing')) {
      const mode = e.path.split('.')[1].split('[')[0];
      const bars = cleaned.actionBar;
      if (isDict(bars)) delete bars[mode];
    }
    if (e.path === 'bar.quantityPresets') {
      const bar = cleaned.bar;
      if (isDict(bar)) delete bar.quantityPresets;
    }
  }
  return pruneEmpty(cleaned);
}

/* ------------------------------------------------------- merge and resolve */

function mergeNode(node: SchemaNode | undefined, base: unknown, layer: unknown): unknown {
  if (node instanceof ObjNode && node.merges && isDict(base) && isDict(layer)) {
    const out: Dict = { ...base };
    for (const [key, value] of Object.entries(layer)) {
      const child = node.fields[key];
      if (!child || value === null || value === undefined) continue;
      out[key] = key in base ? mergeNode(child, base[key], value) : cloneJson(value);
    }
    return out;
  }
  if (node instanceof MapNode && isDict(base) && isDict(layer)) {
    const out: Dict = { ...base };
    for (const [key, value] of Object.entries(layer)) {
      if (value === null || value === undefined) continue;
      out[key] = cloneJson(value);
    }
    return out;
  }
  return cloneJson(layer);
}

/**
 * `base` ⊕ each layer in turn, as the cloud merges: objects and `texts` deep-merge, lists and
 * scalars replace, a `null` (or absent) value inherits; keys the schema does not know are left
 * out. Inputs are not mutated.
 */
export function deepMerge<T>(base: T, ...layers: Array<TillDesignLayer | null | undefined>): T {
  let out = cloneJson(base) as unknown;
  for (const layer of layers) {
    if (isDict(layer) && Object.keys(layer).length > 0) out = mergeNode(SCHEMA, out, layer);
  }
  return out as T;
}

/** DEFAULTS ⊕ the stored layers (sanitised): what a till gets — `resolve`. */
export function resolveTillDesign(...layers: Array<TillDesignLayer | null | undefined>): TillDesignConfig {
  return deepMerge(TILL_DESIGN_DEFAULTS, ...layers.map((l) => sanitizeStoredLayer(l)));
}

/**
 * The minimal layer that, merged over `parent` (what this level inherits), yields `edited`:
 * only the keys whose value differs, objects walked key by key. A `null` cannot be saved (it
 * means "inherit"), so a value cleared to null over a non-null parent falls back to inheriting;
 * an empty text over no parent text is nothing.
 */
export function pruneOverrides(parent: unknown, edited: unknown): TillDesignLayer {
  const out: TillDesignLayer = {};
  if (!isDict(edited)) return out;
  const p = isDict(parent) ? parent : {};
  for (const [key, value] of Object.entries(edited)) {
    if (value === undefined || value === null) continue;
    const inherited = p[key];
    if (jsonEqual(value, inherited)) continue;
    if ((inherited === undefined || inherited === null) && value === '') continue;
    if (isDict(value) && (isDict(inherited) || inherited === undefined || inherited === null)) {
      const sub = pruneOverrides(inherited, value);
      if (Object.keys(sub).length > 0) out[key] = sub;
      continue;
    }
    out[key] = cloneJson(value);
  }
  return out;
}

export interface ConfigChange {
  path: string;
  before: unknown;
  after: unknown;
}

/** Every leaf (scalar or list) that differs between two configs, by dotted path. */
export function diffConfigs(before: unknown, after: unknown, prefix = ''): ConfigChange[] {
  const out: ConfigChange[] = [];
  if (isDict(before) && isDict(after)) {
    const keys = Array.from(new Set([...Object.keys(before), ...Object.keys(after)]));
    for (const key of keys) out.push(...diffConfigs(before[key], after[key], prefix ? `${prefix}.${key}` : key));
    return out;
  }
  const norm = (v: unknown) => (v === undefined ? null : v);
  if (!jsonEqual(norm(before), norm(after))) out.push({ path: prefix, before: norm(before), after: norm(after) });
  return out;
}

/** A template id as stored or as an older name; anything else (a phase-2 one) is clean. */
export function canonicalTemplate(value: unknown): Template {
  if (typeof value === 'string') {
    const v = TEMPLATE_ALIASES[value] ?? value;
    if ((TEMPLATES as readonly string[]).includes(v)) return v as Template;
  }
  return 'clean';
}

export function isPhase2Template(value: unknown): value is Phase2Template {
  return typeof value === 'string' && (PHASE2_TEMPLATES as readonly string[]).includes(value);
}

/* ----------------------------------------------- what one profile shows */

export interface ProfileView {
  profile: Profile;
  width: number;
  height: number;
  template: Template;
  /** "auto" stays: the till resolves it with its parameters (resolveTileSize). */
  tileSize: TileSize;
  tileStyle: Exclude<TileStyle, 'auto'>;
  density: Density;
  billPosition: Record<Mode, ResolvedBillPosition>;
  billStyle: BillStyle;
  summaryCollapsible: boolean;
  categoryBar: Exclude<CategoryBar, 'auto'>;
  /** 0 = by the tile style / tile size and the pane width. */
  columns: number;
  images: ImagesMode;
  textSize: TextSize;
  features: Feature[];
  /** table: the bar or the template's; quick: the bar, or [] — the till parameters'. */
  actions: Record<Mode, ActionItem[]>;
}

/**
 * The config as one device profile shows it (Python `for_profile`): the profile's overrides
 * over the base, every "auto" the config itself can settle settled (the bill position and the
 * tile style from the template, the table's bar), and what only the till knows left "auto"
 * (the tile size, the quick order's buttons). On the handheld a side bill becomes "bottom"
 * and the category bar is always on top.
 */
export function forProfile(cfg: TillDesignConfig | Dict, rawProfile: string): ProfileView {
  const c = cfg as Dict;
  const profile: Profile = (PROFILES as readonly string[]).includes(rawProfile) ? (rawProfile as Profile) : 'handheld';
  const profiles = isDict(c.profiles) ? c.profiles : {};
  const over = isDict(profiles[profile]) ? (profiles[profile] as Dict) : {};
  const layout = isDict(c.layout) ? c.layout : {};
  const layoutDefaults = TILL_DESIGN_DEFAULTS.layout as unknown as Dict;
  const pick = (key: string): unknown => {
    const value = over[key];
    if (value !== null && value !== undefined) return value;
    return key in layout ? layout[key] : layoutDefaults[key];
  };
  const template = canonicalTemplate(over.template || c.template);
  const defaults = TEMPLATE_DEFAULTS[template];
  let tileStyle = pick('tileStyle') as TileStyle;
  if (!(TILE_STYLES as readonly string[]).includes(tileStyle) || tileStyle === 'auto') tileStyle = defaults.tileStyle;
  const chosen = pick('billPosition') as BillPosition;
  const bill = {} as Record<Mode, ResolvedBillPosition>;
  for (const mode of MODES) {
    let position: ResolvedBillPosition =
      (BILL_POSITIONS as readonly string[]).includes(chosen) && chosen !== 'auto'
        ? (chosen as ResolvedBillPosition)
        : defaults.billPosition[mode][profile];
    if (profile === 'handheld' && (position === 'start' || position === 'end')) position = 'bottom';
    bill[mode] = position;
  }
  let categoryBar = pick('categoryBar') as CategoryBar;
  if (!(CATEGORY_BARS as readonly string[]).includes(categoryBar) || categoryBar === 'auto' || profile === 'handheld') categoryBar = 'top';
  const bars = isDict(c.actionBar) ? c.actionBar : {};
  const tableItems = Array.isArray(bars.table) ? (bars.table as ActionItem[]) : [];
  const quickItems = Array.isArray(bars.quick) ? (bars.quick as ActionItem[]) : [];
  const tableActions = tableItems.length
    ? tableItems.map((i) => ({ ...i }))
    : defaults.tableActions.map((a) => ({ action: a, label: '' }));
  const [width, height] = PROFILE_SIZES[profile];
  return {
    profile,
    width,
    height,
    template,
    tileSize: pick('tileSize') as TileSize,
    tileStyle: tileStyle as Exclude<TileStyle, 'auto'>,
    density: pick('density') as Density,
    billPosition: bill,
    billStyle: defaults.billStyle,
    summaryCollapsible: defaults.summaryCollapsible,
    categoryBar: categoryBar as Exclude<CategoryBar, 'auto'>,
    columns: (pick('columns') as number) || 0,
    images: ('images' in layout ? layout.images : 'auto') as ImagesMode,
    textSize: ('textSize' in layout ? layout.textSize : 'normal') as TextSize,
    features: [...defaults.features],
    actions: { table: tableActions, quick: quickItems.map((i) => ({ ...i })) },
  };
}

/**
 * The banknote buttons ("שטרות") for a total, in shekels, each over the total (so each shows a
 * change): the chosen notes that cover it, else ("auto", `notes` empty) the next round amounts
 * over it — the next 10, 20, 50, 100, 200 — without repeats, at most `count`.
 */
export function quickCashNotes(totalAgorot: number, notes: readonly number[], count: number): number[] {
  const n = Math.max(CASH_COUNT_MIN, Math.min(CASH_COUNT_MAX, Math.trunc(count || 3)));
  if (totalAgorot <= 0) return [];
  if (notes.length > 0) {
    return Array.from(new Set(notes))
      .sort((a, b) => a - b)
      .filter((note) => note * 100 > totalAgorot)
      .slice(0, n);
  }
  const out: number[] = [];
  for (const step of [10, 20, 50, 100, 200]) {
    const amount = (Math.floor(totalAgorot / (step * 100)) + 1) * step;
    if (!out.includes(amount)) out.push(amount);
  }
  return out.sort((a, b) => a - b).slice(0, n);
}

/* ------------------------------------ the overlapping till parameters */

const QUICK_PAY_WORDS: Record<string, ActionId> = {
  'אשראי מהיר': 'fastCard',
  'מזומן עם עודף': 'cashWithChange',
  'מזומן מהיר': 'fastCash',
  fastcard: 'fastCard',
  cash: 'cashWithChange',
  fastcash: 'fastCash',
};
const QUICK_PAY_ORDER: ActionId[] = ['fastCard', 'cashWithChange', 'fastCash'];
const DEFAULT_QUICK_PAY: ActionId[] = ['fastCard', 'cashWithChange'];

function quickPayWord(value: unknown): ActionId | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  return QUICK_PAY_WORDS[v] ?? QUICK_PAY_WORDS[v.toLowerCase()] ?? null;
}

/**
 * What a quick order's "auto" bar is on a till with these parameters: the two quick-pay buttons
 * (each slot its choice or its default, the second moved off a repeat, a disallowed one dropped)
 * and "pay" — Python `legacy_quick_actions`.
 */
export function legacyQuickActions(parameters: Record<string, unknown>): ActionItem[] {
  const chosen = ['quickPayButton1', 'quickPayButton2'].map((key, slot) => quickPayWord(parameters[key]) ?? DEFAULT_QUICK_PAY[slot]);
  const distinct: ActionId[] = [];
  for (let action of chosen) {
    if (distinct.includes(action)) action = QUICK_PAY_ORDER.find((a) => !distinct.includes(a)) as ActionId;
    distinct.push(action);
  }
  const allowed = new Set<ActionId>(['cashWithChange']);
  if (parameters.fastCard !== false) allowed.add('fastCard');
  if (parameters.fastCash !== false) allowed.add('fastCash');
  return [...distinct.filter((a) => allowed.has(a)).map((a) => ({ action: a, label: '' })), { action: 'pay', label: '' }];
}

/** `legacy` of `GET /till-design/settings`: the "auto" values as the till parameters set them. */
export interface TillDesignLegacy {
  tileSize: { quick: Exclude<TileSize, 'auto'>; quickTablet: Exclude<TileSize, 'auto'>; table: Exclude<TileSize, 'auto'>; tableTablet: Exclude<TileSize, 'auto'> };
  quickActions: ActionItem[];
  fields: Record<FieldKey, 'off' | 'required'>;
  tables: { mapStyle: 'classic' | 'modern'; showChairs: 'show' | 'hide' };
}

/** Nothing set in the till parameters (the hints' fallback before the server answers). */
export const LEGACY_FALLBACK: TillDesignLegacy = {
  tileSize: { quick: 'm', quickTablet: 'm', table: 'm', tableTablet: 'm' },
  quickActions: legacyQuickActions({}),
  fields: { customerName: 'off', serviceType: 'off', guests: 'off' },
  tables: { mapStyle: 'classic', showChairs: 'show' },
};

/** Which `legacy.tileSize` key a profile and mode read. */
export function legacyTileKey(profile: Profile, mode: Mode): keyof TillDesignLegacy['tileSize'] {
  const tablet = profile !== 'handheld';
  if (mode === 'table') return tablet ? 'tableTablet' : 'table';
  return tablet ? 'quickTablet' : 'quick';
}

/** The tile size a profile shows in a mode: the config's, else ("auto") the till parameters'. */
export function resolveTileSize(view: Pick<ProfileView, 'tileSize' | 'profile'>, mode: Mode, legacy: TillDesignLegacy | null | undefined): Exclude<TileSize, 'auto'> {
  if (view.tileSize !== 'auto' && (TILE_SIZES as readonly string[]).includes(view.tileSize)) return view.tileSize as Exclude<TileSize, 'auto'>;
  return (legacy ?? LEGACY_FALLBACK).tileSize[legacyTileKey(view.profile, mode)] ?? 'm';
}

/** A field's mode on the till: its own, else ("auto") the till parameters'. */
export function resolveFieldMode(mode: FieldMode, legacy: Exclude<FieldMode, 'auto'> | null | undefined): Exclude<FieldMode, 'auto'> {
  return mode === 'auto' ? (legacy ?? 'off') : mode;
}

/** The action bar a mode shows: the view's, the quick one's "auto" from the till parameters. */
export function actionsFor(view: Pick<ProfileView, 'actions'>, mode: Mode, legacy: TillDesignLegacy | null | undefined): ActionItem[] {
  const list = view.actions[mode];
  if (list.length > 0 || mode === 'table') return list;
  return (legacy ?? LEGACY_FALLBACK).quickActions.map((i) => ({ ...i }));
}

/** A screen text: the business's own wording, else the default. */
export function textOf(cfg: Pick<TillDesignConfig, 'texts'>, key: TextKey): string {
  const own = cfg.texts?.[key];
  return typeof own === 'string' && own.trim() ? own : TEXT_DEFAULTS[key];
}

/** A button's label: its own, else the texts' wording (send / pay / goToBill / repeatRound), else the default. */
export function actionLabelOf(item: ActionItem, cfg: Pick<TillDesignConfig, 'texts'>): string {
  if (item.label && item.label.trim()) return item.label;
  if (item.action === 'send') return textOf(cfg, 'sendToKitchen');
  if (item.action === 'pay') return textOf(cfg, 'pay');
  if (item.action === 'bill') return textOf(cfg, 'goToBill');
  if (item.action === 'repeatRound') return textOf(cfg, 'repeatRound');
  return ACTION_LABELS[item.action] ?? item.action;
}

/** Shekels from agorot as the till writes them: "₪108", "₪2.80". */
export function formatShekels(agorot: number): string {
  const sign = agorot < 0 ? '-' : '';
  const abs = Math.abs(Math.round(agorot));
  const whole = Math.floor(abs / 100);
  const cents = abs % 100;
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}₪${grouped}${cents ? `.${cents.toString().padStart(2, '0')}` : ''}`;
}

/* ------------------------------------------------------------ the menu */

export interface MenuCategoryIn {
  id: string;
  name: string;
}
export interface MenuProductIn {
  id: string;
  categoryId: string | null;
}

/**
 * The categories in the menu's order: those in `categoryOrder` first, in its order, then the
 * rest in the till's own order. `hidden` ones are flagged, not dropped (the editor shows them).
 */
export function orderCategories<C extends MenuCategoryIn>(categories: readonly C[], menu: Pick<TillDesignConfig['menu'], 'categoryOrder'>): C[] {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const out: C[] = [];
  const seen = new Set<string>();
  for (const id of menu.categoryOrder ?? []) {
    const c = byId.get(id);
    if (c && !seen.has(id)) {
      out.push(c);
      seen.add(id);
    }
  }
  for (const c of categories) if (!seen.has(c.id)) out.push(c);
  return out;
}

/** The products in the flat `productOrder` (as the till's productOrder setting), the rest after in the till's order. */
export function orderProducts<P extends MenuProductIn>(products: readonly P[], menu: Pick<TillDesignConfig['menu'], 'productOrder'>): P[] {
  const rank = new Map<string, number>();
  (menu.productOrder ?? []).forEach((id, i) => {
    if (!rank.has(id)) rank.set(id, i);
  });
  return products
    .map((p, i) => ({ p, i }))
    .sort((a, b) => {
      const ra = rank.has(a.p.id) ? (rank.get(a.p.id) as number) : Number.MAX_SAFE_INTEGER;
      const rb = rank.has(b.p.id) ? (rank.get(b.p.id) as number) : Number.MAX_SAFE_INTEGER;
      return ra - rb || a.i - b.i;
    })
    .map((x) => x.p);
}

/**
 * What the till's category bar and "הכל" show: the categories in order without the hidden ones,
 * and the products in order, those of a hidden category left out (still reachable by search).
 */
export function menuView<C extends MenuCategoryIn, P extends MenuProductIn>(
  categories: readonly C[],
  products: readonly P[],
  menu: TillDesignConfig['menu'],
): { categories: C[]; products: P[] } {
  const hidden = new Set(menu.hiddenCategories ?? []);
  const cats = orderCategories(categories, menu).filter((c) => !hidden.has(c.id));
  const catRank = new Map(cats.map((c, i) => [c.id, i]));
  const ordered = orderProducts(products, menu).filter((p) => !p.categoryId || !hidden.has(p.categoryId));
  // Within "הכל" the products follow their category's place, then their own order.
  const prods = ordered
    .map((p, i) => ({ p, i }))
    .sort((a, b) => {
      const ca = a.p.categoryId && catRank.has(a.p.categoryId) ? (catRank.get(a.p.categoryId) as number) : Number.MAX_SAFE_INTEGER;
      const cb = b.p.categoryId && catRank.has(b.p.categoryId) ? (catRank.get(b.p.categoryId) as number) : Number.MAX_SAFE_INTEGER;
      return ca - cb || a.i - b.i;
    })
    .map((x) => x.p);
  return { categories: cats, products: prods };
}

/** The flat product order the editor saves: every category's products in their shown order. */
export function flatProductOrder<C extends MenuCategoryIn, P extends MenuProductIn>(
  categories: readonly C[],
  products: readonly P[],
  menu: Pick<TillDesignConfig['menu'], 'categoryOrder' | 'productOrder'>,
): string[] {
  const ordered = orderProducts(products, menu);
  const out: string[] = [];
  for (const c of orderCategories(categories, menu)) {
    for (const p of ordered) if (p.categoryId === c.id) out.push(p.id);
  }
  for (const p of ordered) if (!out.includes(p.id)) out.push(p.id);
  return out;
}

/* ------------------------------------------------- the preview's geometry */

/** Tile heights (dp) by tile size — the till's TileSize — and the density factor. */
export const TILE_HEIGHT_DP: Record<Exclude<TileSize, 'auto'>, number> = { xs: 92, s: 112, m: 150, l: 196 };
export const DENSITY_FACTOR: Record<Density, number> = { compact: 0.85, comfortable: 1, spacious: 1.15 };
/** `textSize: large` multiplies every type size. */
export const LARGE_TEXT_FACTOR = 1.15;

/** The side bill's width (dp): 36% of the screen, 340–460 (professional: 40%, at least 300). */
export function sideBillWidth(template: Template, screenWidth: number): number {
  if (template === 'professional') return Math.round(Math.max(300, Math.min(520, screenWidth * 0.4)));
  return Math.round(Math.max(340, Math.min(460, screenWidth * 0.36)));
}

/**
 * How many columns a product grid shows on a pane `paneWidth` dp wide (its padding taken off):
 * `columns` when set, else by the tile style and size. Mirrors the till's rules (TillDesign.kt).
 */
export function gridColumns(opts: {
  style: Exclude<TileStyle, 'auto'>;
  size: Exclude<TileSize, 'auto'>;
  paneWidth: number;
  handheld: boolean;
  columns?: number;
  gap?: number;
}): number {
  const { style, size, paneWidth, handheld } = opts;
  if (opts.columns && opts.columns > 0) return opts.columns;
  const gap = opts.gap ?? 10;
  const fit = (target: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.floor((paneWidth + gap) / (target + gap))));
  switch (style) {
    case 'row':
      return paneWidth > 900 ? 2 : 1;
    case 'photo': {
      if (handheld) return 2;
      const target = { xs: 160, s: 200, m: 240, l: 300 }[size];
      return fit(target, 2, 6);
    }
    case 'key': {
      if (handheld) return { xs: 4, s: 3, m: 3, l: 2 }[size];
      const target = { xs: 110, s: 125, m: 140, l: 180 }[size];
      return fit(target, 3, 8);
    }
    case 'card':
    default: {
      if (handheld) return { xs: 4, s: 3, m: 2, l: 2 }[size];
      const [target, cap] = ({ xs: [110, 8], s: [140, 6], m: [190, 5], l: [260, 4] } as const)[size];
      return fit(target, 2, cap);
    }
  }
}

/** A tile's height (dp) by its style, size and density (a photo tile: by its width). */
export function tileHeight(opts: {
  style: Exclude<TileStyle, 'auto'>;
  size: Exclude<TileSize, 'auto'>;
  density: Density;
  tileWidth: number;
  withPhoto: boolean;
}): number {
  const f = DENSITY_FACTOR[opts.density] ?? 1;
  switch (opts.style) {
    case 'row':
      return opts.density === 'compact' ? 48 : opts.density === 'spacious' ? 64 : 56;
    case 'key':
      return Math.round(({ xs: 60, s: 66, m: 72, l: 88 }[opts.size]) * f);
    case 'photo':
      return opts.withPhoto
        ? Math.round((opts.tileWidth * 10) / 16 + 64 * f)
        : Math.round(Math.max(112, Math.min(184, opts.tileWidth * 0.42)) * f);
    case 'card':
    default:
      return Math.round(TILE_HEIGHT_DP[opts.size] * f);
  }
}
