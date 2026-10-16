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
 *
 * Phase 2 (P:\specs\till-design-phase2.md §6, approved: "windows לא כעת, כל השאר"): the four
 * templates that were "בקרוב", a profile's own action bar, "כמו הבסיס" over a parent's value
 * ("base" / "brand"), the new templates' sections, "הוצא הבא" and the table's tenders.
 *
 * "הנפשות" (P:/specs/till-motion.md "תיקון 14.10"): `motion` — the kiosk's Motion Engine on the till
 * (lib/kioskMotionEngine.ts, surface "till"), every key optional (nothing set: "legacy", today's
 * screens), merged per event and parameter; checked by the engine's own tables, as the server does.
 *
 * "שם פריט מלא ותג i" (P:/specs/product-tile-text.md §5): `look` — the four till parameters of
 * lib/productTileText.ts as the design's own fields under "מראה", every key optional (absent: the till
 * parameters'); a code wins over the parameter, "base" undoes a level above's value (pos-android
 * domain/TillDesignLook.kt reads the same).
 *
 * "זרימה" (P:/specs/flow-design.md §9): `flow` — the till's shell for every device (`shell`) or per profile
 * (`profiles.<p>`, "base" = as `shell`), with its options; absent from the defaults like `look`. `flowView` /
 * `flowForProfile` mirror the server's `flow_view` / `flow_for_profile`, pinned by the shared fixture
 * tests/fixtures/flow_design_contract.json (pos-android domain/FlowDesign.kt reads the same).
 */

import {
  MOTION_GLOBAL_SPEEDS,
  MOTION_MULTIPLIER_MAX,
  MOTION_MULTIPLIER_MIN,
  MOTION_PARAMS,
  TILL_MOTION_EVENTS,
  TILL_MOTION_PRESETS,
  motionEventTypesOf,
  motionParamRange,
  type MotionEngineSettings,
  type MotionEventKey,
  type MotionParam,
} from './kioskMotionEngine';
import {
  INFO_BADGES,
  MIN_TEXT_SIZES,
  NAME_FITS,
  NAME_MAX_LINES_MAX,
  NAME_MAX_LINES_MIN,
  PRODUCT_TEXT_DEFAULTS,
  isProductTextCode,
  type ProductTextDesign,
  type ProductTextKey,
  type ProductTextSettings,
} from './productTileText';

/* ------------------------------------------------------------ vocabularies */

export const SCHEMA_VERSION = 1;

export const TEMPLATES = ['clean', 'touch', 'professional', 'seated', 'fast', 'mobile', 'courses', 'payDock', 'night', 'visual'] as const;
export type Template = (typeof TEMPLATES)[number];
/** Templates still refused on save ("template_not_available"): none since phase 2 (decision 1: hide what is not built). */
export const PHASE2_TEMPLATES: readonly string[] = [];
/** Phase 2's four templates: a till older than the server's `phase2MinVersion` shows "נקי" in their place. */
export const PHASE2_NEW_TEMPLATES: readonly Template[] = ['courses', 'payDock', 'night', 'visual'];
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

/**
 * "כמו הבסיס (גם אם נקבע ברמה שמעל)" (phase 2 §3.10): `null` in a layer inherits, so these say
 * it explicitly — "base" in a profile's fields (its bars too), "brand" in `colors.accent`.
 * `forProfile` reads them as not set; they stay in the effective config.
 */
export const AS_BASE = 'base';
export const ACCENT_BRAND = 'brand';
export type AsBase = typeof AS_BASE;

export const TILE_SIZES = ['auto', 'xs', 's', 'm', 'l'] as const;
export type TileSize = (typeof TILE_SIZES)[number];
export const TILE_STYLES = ['auto', 'card', 'photo', 'row', 'key'] as const;
export type TileStyle = (typeof TILE_STYLES)[number];
/** A template's own tile style, never chosen: the visual menu's dish cards. */
export const TEMPLATE_TILE_STYLES = ['dish'] as const;
/** A tile style once resolved (a template's own included). */
export type ResolvedTileStyle = Exclude<TileStyle, 'auto'> | (typeof TEMPLATE_TILE_STYLES)[number];
export const DENSITIES = ['compact', 'comfortable', 'spacious'] as const;
export type Density = (typeof DENSITIES)[number];
/** Where the bill stands. In RTL "end" is the LEFT side, "start" the right. */
export const BILL_POSITIONS = ['auto', 'end', 'start', 'bottom', 'sheet'] as const;
export type BillPosition = (typeof BILL_POSITIONS)[number];
/** A template's own bill position, never chosen: the visual menu's floating drawer. */
export const TEMPLATE_BILL_POSITIONS = ['drawer'] as const;
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
/**
 * "איך זה עובד" of the courses (P:/specs/fire-restaurant-flow.md §5, §8.1): `hints.fireHints`, the till parameter
 * `fireHints`'s codes; absent (the defaults have no `hints`, like `look`) — the parameter's.
 */
export const FIRE_HINTS = ['on', 'first_time', 'off'] as const;
export type FireHints = (typeof FIRE_HINTS)[number];
export const MAP_STYLES = ['auto', 'classic', 'modern'] as const;
export type MapStyle = (typeof MAP_STYLES)[number];
export const SHOW_HIDE = ['auto', 'show', 'hide'] as const;
export type ShowHide = (typeof SHOW_HIDE)[number];

/*
 * "זרימה" (P:/specs/flow-design.md §9): the till's shell — a home of the open orders, a wizard for a new one,
 * a side menu of big rows. Absent from the defaults like `look`; every key optional, null inherits.
 */
export const FLOW_SECTION = 'flow';
/** `flow.shell` (every device at the level): "רגיל (כמו היום)" / "זרימה". Never "base" — that is a profile's. */
export const FLOW_SHELLS = ['classic', 'flow'] as const;
export type FlowShell = (typeof FLOW_SHELLS)[number];
/** `flow.profiles.<p>`: classic, flow, or "base" ("כמו הבסיס" = as `shell`, also over a level above's value). */
export const FLOW_PROFILE_VALUES = [...FLOW_SHELLS, AS_BASE] as const;
/** The home's view: "auto" — the map when the till has tables. */
export const FLOW_HOMES = ['auto', 'orders', 'tables'] as const;
export type FlowHome = (typeof FLOW_HOMES)[number];
/** The wizard's first step: ask table or pickup / straight to the table's number / straight to a pickup. */
export const FLOW_FIRST_STEPS = ['type', 'table', 'pickup'] as const;
export type FlowFirstStep = (typeof FLOW_FIRST_STEPS)[number];
/** "כמה סועדים?": "auto" — the till parameter tablesAskGuests. */
export const FLOW_ASK_GUESTS = ['auto', 'always', 'never'] as const;
export type FlowAskGuests = (typeof FLOW_ASK_GUESTS)[number];
/** A pickup's name: "auto" — as today (at payment, askOrderName) / none / asked in the wizard / required there. */
export const FLOW_PICKUP_NAMES = ['auto', 'off', 'ask', 'required'] as const;
export type FlowPickupName = (typeof FLOW_PICKUP_NAMES)[number];

/** Phase 2 adds, at the end: a quick order's "עוד סבב", a table's "הוצא הבא" and its tenders. */
export const QUICK_ACTIONS = [
  'pay', 'fastCard', 'cashWithChange', 'fastCash', 'cashNotes',
  'hold', 'discount', 'customer', 'orderDetails', 'clear',
  'repeatRound',
] as const;
export type QuickAction = (typeof QUICK_ACTIONS)[number];
export const TABLE_ACTIONS = [
  'send', 'bill', 'pay', 'split', 'move', 'guests', 'notes', 'discount', 'repeatRound',
  'fire', 'cashWithChange', 'cashNotes', 'fastCash', 'fastCard',
] as const;
export type TableAction = (typeof TABLE_ACTIONS)[number];
export type ActionId = QuickAction | TableAction;
/** The one button each list must keep when it is set: the payment screen / the kitchen. */
export const REQUIRED_ACTION: Record<Mode, ActionId> = { quick: 'pay', table: 'send' };
export const ACTION_BAR_MAX = 6;
export const ACTION_LABEL_MAX = 24;

/** Default labels (Hebrew, the till's language). A button's own `label` replaces it. */
export const ACTION_LABELS: Record<ActionId, string> = {
  send: 'שגר',
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
  // The till writes the next course's name ("הוצא עיקריות"); this is the label with none.
  fire: 'הוצא הבא',
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

/* Phase 2's sections. */
/** "זמן להוציא": 0 = off, else 5–60 minutes (a reminder on the screen only). */
export const FIRE_GAP_MIN = 5;
export const FIRE_GAP_MAX = 60;
export const NIGHT_HANDS = ['right', 'left'] as const;
export type NightHand = (typeof NIGHT_HANDS)[number];
export const DESCRIPTION_LINES = [0, 1, 2] as const;
/** `visual.dietary`: "auto" = the till parameter showDietaryMarks. */
export const DIETARY_MODES = ['auto', 'show', 'hide'] as const;
export type DietaryMode = (typeof DIETARY_MODES)[number];
/** `orderNumber.prefix`: "" = auto (the till's number when the shop has more than one), else up to 4 letters / digits. */
export const ORDER_PREFIX_MAX = 4;
const ORDER_PREFIX = /^[0-9A-Za-z\u05D0-\u05EA]*$/;

/** The screen texts a business may reword ("" = the default below). */
export const TEXT_DEFAULTS = {
  sendToKitchen: 'שגר',
  newSuffix: 'חדש',
  allSent: 'הכול שוגר',
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

/** A profile's bars (phase 2 §3.4): null or "base" = the base's, [] = auto, a list = this profile's. */
export interface ProfileActionBar {
  table: ActionItem[] | AsBase | null;
  quick: ActionItem[] | AsBase | null;
}

/** A profile's overrides: null inherits; "base" = as the base, over a parent's value. */
export interface ProfileOverride {
  template: Template | AsBase | null;
  tileSize: TileSize | AsBase | null;
  tileStyle: TileStyle | AsBase | null;
  density: Density | AsBase | null;
  billPosition: BillPosition | AsBase | null;
  categoryBar: CategoryBar | AsBase | null;
  columns: number | AsBase | null;
  actionBar: ProfileActionBar;
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
  bar: { quantityPresets: number[]; favorites: string[]; repeatRound: boolean; openTabs: boolean };
  menu: { categoryOrder: string[]; productOrder: string[]; hiddenCategories: string[] };
  /** null = the brand colour (inherits); "brand" = the brand colour over a parent's accent. */
  colors: { accent: string | null; mode: ColorMode };
  texts: Partial<Record<TextKey, string>>;
  fields: Record<FieldKey, FieldMode>;
  behavior: { summary: SummaryState; lineStatus: boolean };
  tables: { mapStyle: MapStyle; showChairs: ShowHide };
  courses: { fireGapMinutes: number; autoFireFirst: boolean };
  payDock: { savings: boolean };
  night: { hand: NightHand; quickAddons: boolean };
  visual: { descriptionLines: number; dietary: DietaryMode };
  professional: { keyboard: boolean; fKeys: boolean };
  orderNumber: { atOpen: boolean; prefix: string };
  /** "הנפשות": the Motion Engine's `motion` (absent: nothing set at any level — "legacy", today's screens). */
  motion?: MotionEngineSettings;
  /** "מראה" — "שם פריט מלא ותג i": the design's own four (absent / "base": the till parameters'). */
  look?: ProductTextDesign;
  /** "הסבר לעובד" (fire-restaurant-flow.md §5): absent — the till parameter `fireHints`. */
  hints?: { fireHints?: FireHints };
  /** "זרימה" (flow-design.md §9): absent — "רגיל" on every device, every option its default. */
  flow?: FlowSettings;
}

/** The `flow` section as the levels set it: every key optional (absent / null: inherit, else the default). */
export interface FlowSettings {
  shell?: FlowShell | null;
  profiles?: Partial<Record<Profile, FlowShell | AsBase | null>>;
  home?: FlowHome | null;
  firstStep?: FlowFirstStep | null;
  askGuests?: FlowAskGuests | null;
  notes?: boolean | null;
  pickupName?: FlowPickupName | null;
  /** #RRGGBB; null — inherit (none set: our palette, spec §5.3); "base" — our palette over a level above's colour. */
  background?: string | AsBase | null;
}

/** `flow` with every key settled — the shared fixture's "expect". */
export interface FlowView {
  /** profile → "classic" / "flow", for every profile. */
  shell: Record<Profile, FlowShell>;
  home: FlowHome;
  firstStep: FlowFirstStep;
  askGuests: FlowAskGuests;
  notes: boolean;
  pickupName: FlowPickupName;
  background: string | null;
}

/** Each option's value when no level sets it. */
export const FLOW_DEFAULTS: Omit<FlowView, 'shell'> = {
  home: 'auto',
  firstStep: 'type',
  askGuests: 'auto',
  notes: true,
  pickupName: 'auto',
  background: null,
};

/** A partial layer as stored / sent (`{overrides}`). */
export type TillDesignLayer = { [key: string]: unknown };

function emptyProfile(): ProfileOverride {
  return {
    template: null,
    tileSize: null,
    tileStyle: null,
    density: null,
    billPosition: null,
    categoryBar: null,
    columns: null,
    actionBar: { table: null, quick: null },
  };
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
  // [] = "auto": a table's from its template, a quick order's from the till parameters (or the
  // template's own, payDock).
  actionBar: { table: [], quick: [] },
  quickCash: { notes: [], count: 3 },
  bar: { quantityPresets: [1, 2, 3, 5], favorites: [], repeatRound: true, openTabs: false },
  menu: { categoryOrder: [], productOrder: [], hiddenCategories: [] },
  colors: { accent: null, mode: 'auto' },
  texts: {},
  fields: { customerName: 'auto', serviceType: 'auto', guests: 'auto' },
  behavior: { summary: 'auto', lineStatus: true },
  tables: { mapStyle: 'auto', showChairs: 'auto' },
  // Phase 2: every default is today's behaviour.
  courses: { fireGapMinutes: 0, autoFireFirst: true },
  payDock: { savings: true },
  night: { hand: 'right', quickAddons: true },
  visual: { descriptionLines: 2, dietary: 'auto' },
  professional: { keyboard: false, fKeys: false },
  orderNumber: { atOpen: false, prefix: '' },
};

/* ----------------------------------------------- what each template is */

export type BillStyle = 'lines' | 'cards' | 'seats' | 'compact' | 'courses';
export type Feature =
  | 'searchField'
  | 'seatCards'
  | 'quantityPresets'
  | 'favorites'
  | 'seatPicker'
  | 'courseLanes'
  | 'payDock'
  | 'selectedLine'
  | 'quickAddons'
  | 'thumbs'
  | 'dishCards';
/** A bill position once resolved ("auto" settled; a template's own "drawer" included). */
export type ResolvedBillPosition = Exclude<BillPosition, 'auto'> | (typeof TEMPLATE_BILL_POSITIONS)[number];

export interface TemplateDefaults {
  tileStyle: ResolvedTileStyle;
  billStyle: BillStyle;
  billPosition: Record<Mode, Record<Profile, ResolvedBillPosition>>;
  tableActions: ActionId[];
  /** A quick order's "auto" bar when the template has its own (payDock); [] = the till parameters'. */
  quickActions: ActionId[];
  features: Feature[];
  summaryCollapsible: boolean;
  /** What the template sets whatever the config says (night: no images, large text). */
  fixed: { images?: ImagesMode; textSize?: TextSize };
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

/** The shared template table (docs/SPEC_TILL_DESIGN.md §4, phase 2 §6.1), as TEMPLATE_DEFAULTS in Python. */
export const TEMPLATE_DEFAULTS: Record<Template, TemplateDefaults> = {
  clean: {
    tileStyle: 'card',
    billStyle: 'lines',
    billPosition: {
      table: allProfiles('sheet'),
      quick: { handheld: 'sheet', tabletLandscape: 'end', tabletPortrait: 'bottom', ipadPortrait: 'bottom', ipadLandscape: 'end' },
    },
    tableActions: ['send'],
    quickActions: [],
    features: [],
    summaryCollapsible: false,
    fixed: {},
  },
  touch: {
    tileStyle: 'photo',
    billStyle: 'cards',
    billPosition: both(SIDE),
    tableActions: ['send', 'bill'],
    quickActions: [],
    features: [],
    summaryCollapsible: false,
    fixed: {},
  },
  professional: {
    tileStyle: 'row',
    billStyle: 'lines',
    billPosition: both({ handheld: 'sheet', tabletLandscape: 'end', tabletPortrait: 'end', ipadPortrait: 'end', ipadLandscape: 'end' }),
    tableActions: ['send', 'bill'],
    quickActions: [],
    features: ['searchField'],
    summaryCollapsible: false,
    fixed: {},
  },
  seated: {
    tileStyle: 'card',
    billStyle: 'seats',
    billPosition: both(SIDE),
    tableActions: ['send', 'bill', 'split'],
    quickActions: [],
    features: ['seatCards'],
    summaryCollapsible: false,
    fixed: {},
  },
  fast: {
    tileStyle: 'key',
    billStyle: 'compact',
    billPosition: both(SIDE),
    tableActions: ['send', 'repeatRound', 'bill'],
    quickActions: [],
    features: ['quantityPresets', 'favorites'],
    summaryCollapsible: false,
    fixed: {},
  },
  mobile: {
    tileStyle: 'card',
    billStyle: 'lines',
    billPosition: both(allProfiles('bottom')),
    tableActions: ['send', 'bill'],
    quickActions: [],
    features: ['seatPicker'],
    summaryCollapsible: true,
    fixed: {},
  },
  // "לוח מנות": a lane per course; a quick order, or "מנות בשולחן" off, shows clean on the till.
  courses: {
    tileStyle: 'card',
    billStyle: 'courses',
    billPosition: both(SIDE),
    tableActions: ['send', 'fire', 'bill'],
    quickActions: [],
    features: ['courseLanes'],
    summaryCollapsible: false,
    fixed: {},
  },
  // "עגינת תשלום": the fixed payment dock and the bill's selected line.
  payDock: {
    tileStyle: 'card',
    billStyle: 'lines',
    billPosition: both(SIDE),
    tableActions: ['send', 'bill', 'pay'],
    quickActions: ['fastCard', 'fastCash', 'cashNotes', 'pay'],
    features: ['payDock', 'selectedLine'],
    summaryCollapsible: false,
    fixed: {},
  },
  // "לילה": dark, large text, no images whatever the config says; for the thumbs.
  night: {
    tileStyle: 'key',
    billStyle: 'compact',
    billPosition: both(SIDE),
    tableActions: ['send', 'repeatRound', 'bill'],
    quickActions: [],
    features: ['quantityPresets', 'favorites', 'quickAddons', 'thumbs'],
    summaryCollapsible: false,
    fixed: { images: 'hide', textSize: 'large' },
  },
  // "תפריט ויזואלי": dish cards and a floating drawer; the handheld keeps its summary bar.
  visual: {
    tileStyle: 'dish',
    billStyle: 'lines',
    billPosition: both({ handheld: 'bottom', tabletLandscape: 'drawer', tabletPortrait: 'drawer', ipadPortrait: 'drawer', ipadLandscape: 'drawer' }),
    tableActions: ['send', 'bill'],
    quickActions: [],
    features: ['dishCards'],
    summaryCollapsible: false,
    fixed: {},
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
  courses: ['coursesEnabled'],
  'visual.dietary': ['showDietaryMarks'],
};

/** The vocabularies and the template table, as `GET /till-design/defaults` sends them. */
export function tillDesignCatalog() {
  return {
    schemaVersion: SCHEMA_VERSION,
    templates: [...TEMPLATES],
    phase2Templates: [...PHASE2_TEMPLATES],
    asBase: AS_BASE,
    accentBrand: ACCENT_BRAND,
    templateTileStyles: [...TEMPLATE_TILE_STYLES],
    templateBillPositions: [...TEMPLATE_BILL_POSITIONS],
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
      nightHand: [...NIGHT_HANDS],
      descriptionLines: [...DESCRIPTION_LINES],
      visualDietary: [...DIETARY_MODES],
    },
    fireGapMinutes: { min: FIRE_GAP_MIN, max: FIRE_GAP_MAX },
    orderPrefixMax: ORDER_PREFIX_MAX,
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
  constructor(
    readonly maxLen: number,
    readonly minLen = 0,
    readonly pattern: RegExp | null = null,
    readonly patternMessage = 'invalid format',
  ) {
    super();
  }
  check(value: unknown, path: string, errors: TillDesignIssue[]): Checked {
    if (typeof value !== 'string') return fail(errors, path, 'invalid_type', 'must be a string');
    if (value.length > this.maxLen) return fail(errors, path, 'too_long', `at most ${this.maxLen} characters`);
    if (value.length < this.minLen) return fail(errors, path, 'required', `at least ${this.minLen} characters`);
    if (this.pattern && !this.pattern.test(value)) return fail(errors, path, 'invalid_format', this.patternMessage);
    return value;
  }
}

/** `node`'s values, or one literal word ("base" in a profile's fields, "brand" in the accent). */
class OrLiteralNode extends SchemaNode {
  constructor(
    readonly node: SchemaNode,
    readonly literal: string,
  ) {
    super();
    this.nullable = node.nullable;
  }
  check(value: unknown, path: string, errors: TillDesignIssue[]): Checked {
    if (value === this.literal) return value;
    return this.node.check(value, path, errors);
  }
}

/** 0 (off) or a whole number in [lo, hi] (`courses.fireGapMinutes`). */
class IntOrOffNode extends SchemaNode {
  constructor(
    readonly lo: number,
    readonly hi: number,
  ) {
    super();
  }
  check(value: unknown, path: string, errors: TillDesignIssue[]): Checked {
    if (!isInt(value)) return fail(errors, path, 'invalid_type', 'must be an integer');
    if (value !== 0 && (value < this.lo || value > this.hi)) {
      return fail(errors, path, 'out_of_range', `must be 0 (off) or between ${this.lo} and ${this.hi}`);
    }
    return value;
  }
}

/** A list that may be null (a profile's bar: null = the base's). */
class NullableNode extends SchemaNode {
  constructor(readonly node: SchemaNode) {
    super();
    this.nullable = true;
  }
  check(value: unknown, path: string, errors: TillDesignIssue[]): Checked {
    if (value === null) return null;
    return this.node.check(value, path, errors);
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

/** A number (never a bool) in [lo, hi] (`motion.speedMultiplier`, an event's scales). */
class NumNode extends SchemaNode {
  constructor(
    readonly lo: number,
    readonly hi: number,
  ) {
    super();
  }
  check(value: unknown, path: string, errors: TillDesignIssue[]): Checked {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fail(errors, path, 'invalid_type', 'must be a number');
    if (value < this.lo || value > this.hi) return fail(errors, path, 'out_of_range', `must be between ${this.lo} and ${this.hi}`);
    return value;
  }
}

/** An object whose layer drops a child object it leaves empty (`{"events": {"addToCart": {}}}` sets nothing). */
class PrunedObjNode extends ObjNode {
  checkLayer(value: unknown, path: string, errors: TillDesignIssue[]): Checked {
    const out = super.checkLayer(value, path, errors);
    if (!isDict(out)) return out;
    return Object.fromEntries(Object.entries(out).filter(([k, v]) => !(isDict(v) && Object.keys(v).length === 0 && this.fields[k] instanceof ObjNode)));
  }
}

/** An object every key of which is optional, also when complete (`motion`, an event's own values). */
class PartialObjNode extends PrunedObjNode {
  check(value: unknown, path: string, errors: TillDesignIssue[]): Checked {
    if (!isDict(value)) return fail(errors, path, 'invalid_type', 'must be an object');
    const before = errors.length;
    const out: Dict = {};
    for (const [key, raw] of Object.entries(value)) {
      const node = this.fields[key];
      if (!node) {
        fail(errors, join(path, key), 'unknown_key', 'unknown key');
        continue;
      }
      if (raw === null || raw === undefined) continue;
      const cleaned = node.check(raw, join(path, key), errors);
      if (cleaned !== INVALID) out[key] = cleaned;
    }
    if (errors.length > before) return INVALID;
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

function actionBar(actions: readonly string[]): ListNode {
  return new ListNode(actionItem(actions), { maxLen: ACTION_BAR_MAX });
}

/** A profile field: its values, null (inherit) or "base" (as the base, over a parent's value). */
function asBase(node: SchemaNode): SchemaNode {
  return new OrLiteralNode(node, AS_BASE);
}

/** `profiles.<p>.actionBar` (phase 2 §3.4): null or "base" = the base's bar, [] = auto, a list = the profile's. */
const PROFILE_ACTION_BAR = new ObjNode(
  {
    table: asBase(new NullableNode(actionBar(TABLE_ACTIONS))),
    quick: asBase(new NullableNode(actionBar(QUICK_ACTIONS))),
  },
  { table: null, quick: null },
);

const PROFILE_OVERRIDE = new ObjNode(
  {
    template: asBase(new TemplateNode(true)),
    tileSize: asBase(new EnumNode(TILE_SIZES, true)),
    tileStyle: asBase(new EnumNode(TILE_STYLES, true)),
    density: asBase(new EnumNode(DENSITIES, true)),
    billPosition: asBase(new EnumNode(BILL_POSITIONS, true)),
    categoryBar: asBase(new EnumNode(CATEGORY_BARS, true)),
    columns: asBase(new IntChoiceNode(COLUMNS_CHOICES, true)),
    actionBar: PROFILE_ACTION_BAR,
  },
  {
    template: null,
    tileSize: null,
    tileStyle: null,
    density: null,
    billPosition: null,
    categoryBar: null,
    columns: null,
    actionBar: { table: null, quick: null },
  },
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
    table: actionBar(TABLE_ACTIONS),
    quick: actionBar(QUICK_ACTIONS),
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
    openTabs: new BoolNode(),
  }),
  menu: new ObjNode({
    categoryOrder: new ListNode(ID, { maxLen: MENU_IDS_MAX, unique: true }),
    productOrder: new ListNode(ID, { maxLen: MENU_IDS_MAX, unique: true }),
    hiddenCategories: new ListNode(ID, { maxLen: MENU_IDS_MAX, unique: true }),
  }),
  colors: new ObjNode({ accent: new OrLiteralNode(new ColorNode(true), ACCENT_BRAND), mode: new EnumNode(COLOR_MODES) }),
  texts: new MapNode(new StrNode(TEXT_MAX), TEXT_KEYS),
  fields: new ObjNode(Object.fromEntries(FIELD_KEYS.map((k) => [k, new EnumNode(FIELD_MODES)]))),
  behavior: new ObjNode({ summary: new EnumNode(SUMMARY_STATES), lineStatus: new BoolNode() }),
  tables: new ObjNode({ mapStyle: new EnumNode(MAP_STYLES), showChairs: new EnumNode(SHOW_HIDE) }),
  // Phase 2's sections.
  courses: new ObjNode({ fireGapMinutes: new IntOrOffNode(FIRE_GAP_MIN, FIRE_GAP_MAX), autoFireFirst: new BoolNode() }),
  payDock: new ObjNode({ savings: new BoolNode() }),
  night: new ObjNode({ hand: new EnumNode(NIGHT_HANDS), quickAddons: new BoolNode() }),
  visual: new ObjNode({ descriptionLines: new IntChoiceNode(DESCRIPTION_LINES), dietary: new EnumNode(DIETARY_MODES) }),
  professional: new ObjNode({ keyboard: new BoolNode(), fKeys: new BoolNode() }),
  orderNumber: new ObjNode({
    atOpen: new BoolNode(),
    prefix: new StrNode(ORDER_PREFIX_MAX, 0, ORDER_PREFIX, 'letters and digits only'),
  }),
});

/** `motion.events.<event>` on the till: the engine's parameters, the event's own kinds and ranges. */
function motionEventNode(event: MotionEventKey): PartialObjNode {
  const fields: Record<string, SchemaNode> = {};
  for (const [name, spec] of Object.entries(MOTION_PARAMS)) {
    const range = motionParamRange(event, name as MotionParam);
    if (spec.kind === 'bool') fields[name] = new BoolNode();
    else if (spec.kind === 'type') fields[name] = new EnumNode(motionEventTypesOf(event, 'till'));
    else if (spec.kind === 'enum') fields[name] = new EnumNode(spec.values ?? []);
    else if (spec.kind === 'int') fields[name] = new IntNode(range?.min ?? 0, range?.max ?? 0);
    else fields[name] = new NumNode(range?.min ?? 0, range?.max ?? 0);
  }
  return new PartialObjNode(fields);
}

/** "הנפשות" (the server's `motion_engine_fields("till")`): the till's presets, events and kinds. */
const MOTION_NODE = new PartialObjNode({
  preset: new EnumNode(TILL_MOTION_PRESETS),
  globalSpeed: new EnumNode(MOTION_GLOBAL_SPEEDS, true),
  speedMultiplier: new NumNode(MOTION_MULTIPLIER_MIN, MOTION_MULTIPLIER_MAX),
  events: new PrunedObjNode(
    Object.fromEntries(TILL_MOTION_EVENTS.map((e) => [e, motionEventNode(e)])),
    Object.fromEntries(TILL_MOTION_EVENTS.map((e) => [e, {}])),
  ),
});
SCHEMA.fields.motion = MOTION_NODE;
SCHEMA.fill.motion = {};

/** "מראה" — "שם פריט מלא ותג i" (the server's `LOOK`): each key its codes, or "base". */
const LOOK_NODE = new PartialObjNode({
  productNameFit: asBase(new EnumNode(NAME_FITS)),
  productNameMaxLines: asBase(new IntNode(NAME_MAX_LINES_MIN, NAME_MAX_LINES_MAX)),
  productNameMinTextSize: asBase(new EnumNode(MIN_TEXT_SIZES)),
  productInfoBadge: asBase(new EnumNode(INFO_BADGES)),
});
SCHEMA.fields.look = LOOK_NODE;
SCHEMA.fill.look = {};
/** "הסבר לעובד" (the server's `hints`): optional, like `look`. */
SCHEMA.fields.hints = new PartialObjNode({ fireHints: new EnumNode(FIRE_HINTS) });
SCHEMA.fill.hints = {};
/** "זרימה" (the server's `FLOW`): every key optional; a profile's value classic / flow / "base". */
const FLOW_NODE = new PartialObjNode({
  shell: new EnumNode(FLOW_SHELLS),
  profiles: new PartialObjNode(Object.fromEntries(PROFILES.map((p) => [p, asBase(new EnumNode(FLOW_SHELLS))]))),
  home: new EnumNode(FLOW_HOMES),
  firstStep: new EnumNode(FLOW_FIRST_STEPS),
  askGuests: new EnumNode(FLOW_ASK_GUESTS),
  notes: new BoolNode(),
  pickupName: new EnumNode(FLOW_PICKUP_NAMES),
  background: asBase(new ColorNode(true)),
});
SCHEMA.fields[FLOW_SECTION] = FLOW_NODE;
SCHEMA.fill[FLOW_SECTION] = {};

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

/** One `{table, quick}` pair of bars at `prefix`: each set list keeps its required button once. */
function checkBars(bars: unknown, prefix: string, errors: TillDesignIssue[]): void {
  if (!isDict(bars)) return;
  for (const mode of MODES) {
    const items = bars[mode];
    if (!Array.isArray(items) || items.length === 0) continue;
    const actions = items.filter(isDict).map((i) => i.action);
    const seen = new Set<unknown>();
    actions.forEach((action, i) => {
      if (seen.has(action)) errors.push({ path: `${prefix}.${mode}[${i}]`, code: 'duplicate', message: 'this button is already on the bar' });
      seen.add(action);
    });
    const required = REQUIRED_ACTION[mode];
    if (!actions.includes(required)) {
      errors.push({ path: `${prefix}.${mode}`, code: `action_bar_missing_${required}`, message: `the bar must keep the '${required}' button` });
    }
  }
}

/** The rules one node cannot see: the bars' (a profile's too) required button and duplicates; a preset of 1. */
function crossField(cfg: Dict, errors: TillDesignIssue[]): void {
  checkBars(cfg.actionBar, 'actionBar', errors);
  const profiles = isDict(cfg.profiles) ? cfg.profiles : {};
  for (const profile of PROFILES) {
    const over = profiles[profile];
    if (isDict(over)) checkBars(over.actionBar, `profiles.${profile}.actionBar`, errors);
  }
  const bar = isDict(cfg.bar) ? cfg.bar : {};
  const presets = bar.quantityPresets;
  if (Array.isArray(presets) && presets.length > 0 && !presets.includes(1)) {
    errors.push({ path: 'bar.quantityPresets', code: 'quantity_presets_need_one', message: 'the presets must include 1' });
  }
}

/** A profile's layer without an empty `actionBar`. */
function pruneProfile(value: unknown): unknown {
  if (!isDict(value)) return value;
  const out: Dict = { ...value };
  if (isDict(out.actionBar) && Object.keys(out.actionBar).length === 0) delete out.actionBar;
  return out;
}

/** Drop objects a layer left empty (`{"layout": {}}`, a profile with nothing set). */
function pruneEmpty(layer: Dict): Dict {
  const out: Dict = {};
  for (const [key, raw] of Object.entries(layer)) {
    let value = raw;
    const node = SCHEMA.fields[key];
    if (key === 'profiles' && isDict(value)) {
      value = Object.fromEntries(
        Object.entries(value)
          .map(([p, v]) => [p, pruneProfile(v)] as const)
          .filter(([, v]) => isDict(v) && Object.keys(v).length > 0),
      );
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
    // A bar that lost its required button: back to "auto" (a profile's: to the base's bar).
    if (e.code.startsWith('action_bar_missing')) {
      const parts = e.path.split('.');
      const mode = parts.pop() as string;
      let holder: unknown = cleaned;
      for (const part of parts) holder = isDict(holder) ? holder[part] : undefined;
      if (isDict(holder)) delete holder[mode];
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

/**
 * The config without the empty objects an edit of `motion` leaves behind (an event reset where nothing is
 * inherited, its last value cleared): `{"motion": {"events": {}}}` is no motion at all, as the server prunes it.
 */
export function pruneEmptyMotion<T>(cfg: T): T {
  if (!isDict(cfg) || !isDict(cfg.motion)) return cfg;
  const motion: Dict = {};
  for (const [k, v] of Object.entries(cfg.motion)) if (v !== undefined) motion[k] = v;
  if (isDict(motion.events)) {
    const events = Object.fromEntries(Object.entries(motion.events).filter(([, v]) => v !== undefined && !(isDict(v) && Object.keys(v).length === 0)));
    if (Object.keys(events).length === 0) delete motion.events;
    else motion.events = events;
  }
  const out: Dict = { ...cfg };
  if (Object.keys(motion).length === 0) delete out.motion;
  else out.motion = motion;
  return out as T;
}

/**
 * The config without a `look` an edit left empty or with keys cleared to inherit (`{}` sets nothing —
 * the server prunes it), so a field set and set back is no change.
 */
export function pruneEmptyLook<T>(cfg: T): T {
  if (!isDict(cfg) || !('look' in cfg)) return cfg;
  const own = isDict(cfg.look) ? cfg.look : {};
  const kept = Object.fromEntries(Object.entries(own).filter(([, v]) => v !== undefined && v !== null));
  const out: Dict = { ...cfg };
  if (Object.keys(kept).length === 0) delete out.look;
  else out.look = kept;
  return out as T;
}

/**
 * What "לפי פרמטרי הקופה" saves at this level for a `look` key: "base" when the level above set a value
 * itself (so it is undone, as "כמו הבסיס"), else nothing (inherit — the parameters already).
 */
export function lookBaseValue(key: ProductTextKey, inherited: unknown): AsBase | undefined {
  return isProductTextCode(key, inherited) ? AS_BASE : undefined;
}

/* ------------------------------------------------------------ "זרימה" */

/**
 * The config without a `flow` an edit left empty or with keys cleared to inherit (`{}`, `profiles: {}` set
 * nothing — the server prunes them), so a choice set and set back is no change.
 */
export function pruneEmptyFlow<T>(cfg: T): T {
  if (!isDict(cfg) || !(FLOW_SECTION in cfg)) return cfg;
  const own = isDict(cfg[FLOW_SECTION]) ? (cfg[FLOW_SECTION] as Dict) : {};
  const kept: Dict = {};
  for (const [k, v] of Object.entries(own)) {
    if (v === undefined || v === null) continue;
    if (k === 'profiles') {
      const profiles = isDict(v) ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined && x !== null)) : {};
      if (Object.keys(profiles).length > 0) kept.profiles = profiles;
      continue;
    }
    kept[k] = v;
  }
  const out: Dict = { ...cfg };
  if (Object.keys(kept).length === 0) delete out[FLOW_SECTION];
  else out[FLOW_SECTION] = kept;
  return out as T;
}

/** The `flow` section of a config, or the section itself (a dict with none of the config's other keys). */
function flowSection(cfgOrFlow: unknown): Dict {
  if (!isDict(cfgOrFlow)) return {};
  if (FLOW_SECTION in cfgOrFlow) return isDict(cfgOrFlow[FLOW_SECTION]) ? (cfgOrFlow[FLOW_SECTION] as Dict) : {};
  if (Object.keys(cfgOrFlow).some((k) => k in SCHEMA.fields && !(k in FLOW_NODE.fields))) return {};
  return cfgOrFlow;
}

function shellOf(flow: Dict, profile: string): FlowShell {
  const profiles = isDict(flow.profiles) ? flow.profiles : {};
  const own = profiles[profile];
  if (typeof own === 'string' && (FLOW_SHELLS as readonly string[]).includes(own)) return own as FlowShell;
  const shell = flow.shell;
  if (typeof shell === 'string' && (FLOW_SHELLS as readonly string[]).includes(shell)) return shell as FlowShell;
  return 'classic';
}

/** The shell a profile shows (Python `flow_shell`): `profiles[p]` when classic / flow, else `shell`, else classic. */
export function flowShell(cfgOrFlow: unknown, profile: string): FlowShell {
  return shellOf(flowSection(cfgOrFlow), profile);
}

/**
 * `flow` with every key settled (Python `flow_view`, the shared fixture's "expect"): the shell per profile,
 * every option its value or its default. Read tolerantly, as the till: a word not of its vocabulary is the default
 * (a background "base", or anything not #RRGGBB, is null — our palette).
 */
export function flowView(cfgOrFlow: unknown): FlowView {
  const flow = flowSection(cfgOrFlow);
  const word = <V extends string>(key: keyof typeof FLOW_DEFAULTS, vocabulary: readonly V[]): V => {
    const v = flow[key];
    return typeof v === 'string' && (vocabulary as readonly string[]).includes(v) ? (v as V) : (FLOW_DEFAULTS[key] as V);
  };
  const bg = flow.background;
  return {
    shell: Object.fromEntries(PROFILES.map((p) => [p, shellOf(flow, p)])) as Record<Profile, FlowShell>,
    home: word('home', FLOW_HOMES),
    firstStep: word('firstStep', FLOW_FIRST_STEPS),
    askGuests: word('askGuests', FLOW_ASK_GUESTS),
    notes: typeof flow.notes === 'boolean' ? flow.notes : FLOW_DEFAULTS.notes,
    pickupName: word('pickupName', FLOW_PICKUP_NAMES),
    background: typeof bg === 'string' && HEX.test(bg) ? bg : null,
  };
}

/** `flowView` as one profile shows it (Python `flow_for_profile`): `shell` is that profile's; an unknown one is the handheld. */
export function flowForProfile(cfgOrFlow: unknown, rawProfile: string): Omit<FlowView, 'shell'> & { shell: FlowShell } {
  const profile: Profile = (PROFILES as readonly string[]).includes(rawProfile) ? (rawProfile as Profile) : 'handheld';
  const view = flowView(cfgOrFlow);
  return { ...view, shell: view.shell[profile] };
}

/** The vocabularies and defaults of `flow` (Python `flow_catalog`, the shared fixture's `catalog`). */
export function flowCatalog() {
  return {
    shells: [...FLOW_SHELLS],
    profileValues: [...FLOW_PROFILE_VALUES],
    profiles: [...PROFILES],
    homes: [...FLOW_HOMES],
    firstSteps: [...FLOW_FIRST_STEPS],
    askGuests: [...FLOW_ASK_GUESTS],
    pickupNames: [...FLOW_PICKUP_NAMES],
    defaults: { ...FLOW_DEFAULTS },
  };
}

/** The Android profiles that show "זרימה" (the review's "גרסה ישנה" warning: an older till shows "רגיל"). */
export function flowOnProfiles(cfg: unknown): Profile[] {
  return ANDROID_PROFILES.filter((p) => flowShell(cfg, p) === 'flow');
}

export interface ConfigChange {
  path: string;
  before: unknown;
  after: unknown;
}

/**
 * Every leaf (scalar or list) that differs between two configs, by dotted path. A section one side
 * does not have at all (an optional one — `motion`, `look` — or any section of an empty layer)
 * is compared as an empty one, leaf by leaf.
 */
export function diffConfigs(before: unknown, after: unknown, prefix = ''): ConfigChange[] {
  const out: ConfigChange[] = [];
  if (before === undefined && isDict(after)) before = {};
  if (after === undefined && isDict(before)) after = {};
  if (isDict(before) && isDict(after)) {
    const keys = Array.from(new Set([...Object.keys(before), ...Object.keys(after)]));
    for (const key of keys) out.push(...diffConfigs(before[key], after[key], prefix ? `${prefix}.${key}` : key));
    return out;
  }
  const norm = (v: unknown) => (v === undefined ? null : v);
  if (!jsonEqual(norm(before), norm(after))) out.push({ path: prefix, before: norm(before), after: norm(after) });
  return out;
}

/** A template id as stored or as an older name; anything else (unknown, "base") is clean. */
export function canonicalTemplate(value: unknown): Template {
  if (typeof value === 'string') {
    const v = TEMPLATE_ALIASES[value] ?? value;
    if ((TEMPLATES as readonly string[]).includes(v)) return v as Template;
  }
  return 'clean';
}

/** A profile's value that overrides the base: neither null (inherit) nor "base". */
export function isSet(value: unknown): boolean {
  return value !== null && value !== undefined && value !== AS_BASE;
}

/**
 * What "כמו הבסיס" saves at this level: "base" when the level above set the value itself (so it
 * is undone), else null (inherit — the base already).
 */
export function asBaseValue(inherited: unknown): AsBase | null {
  return isSet(inherited) ? AS_BASE : null;
}

/** Every template the config uses: the base's and each profile's own (in TEMPLATES' order). */
export function templatesInUse(cfg: Pick<TillDesignConfig, 'template' | 'profiles'>): Template[] {
  const used = new Set<string>([canonicalTemplate(cfg.template)]);
  for (const p of PROFILES) {
    const own = cfg.profiles?.[p]?.template;
    if (isSet(own)) used.add(canonicalTemplate(own));
  }
  return TEMPLATES.filter((t) => used.has(t));
}

/** Whether a phase-2 template is chosen anywhere a till reads (the base or an Android profile). */
export function usesPhase2Template(cfg: Pick<TillDesignConfig, 'template' | 'profiles'>): Template[] {
  const used = new Set<Template>();
  if ((PHASE2_NEW_TEMPLATES as readonly string[]).includes(cfg.template)) used.add(cfg.template);
  for (const p of ANDROID_PROFILES) {
    const own = cfg.profiles?.[p]?.template;
    if (typeof own === 'string' && (PHASE2_NEW_TEMPLATES as readonly string[]).includes(own)) used.add(own as Template);
  }
  return [...used];
}

/* ----------------------------------------------- what one profile shows */

export interface ProfileView {
  profile: Profile;
  width: number;
  height: number;
  template: Template;
  /** "auto" stays: the till resolves it with its parameters (resolveTileSize). */
  tileSize: TileSize;
  tileStyle: ResolvedTileStyle;
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
  /** table: the profile's bar, else the base's, else the template's; quick: the same, or [] — the till's "auto". */
  actions: Record<Mode, ActionItem[]>;
}

/**
 * The config as one device profile shows it (Python `for_profile`): the profile's overrides
 * over the base ("base" and null read as not set), every "auto" the config itself can settle
 * settled (the bill position and the tile style from the template, the table's bar), what the
 * template fixes (night: no images, large text), and what only the till knows left "auto" (the
 * tile size, the quick order's buttons). On the handheld a side bill becomes "bottom" and the
 * category bar is always on top. A profile's own bar (a list, [] too) replaces the base's.
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
    if (isSet(value)) return value;
    return key in layout ? layout[key] : layoutDefaults[key];
  };
  const template = canonicalTemplate(isSet(over.template) && over.template ? over.template : c.template);
  const defaults = TEMPLATE_DEFAULTS[template];
  let tileStyle = pick('tileStyle') as ResolvedTileStyle | 'auto';
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
  const ownBars = isDict(over.actionBar) ? over.actionBar : {};
  const bar = (mode: Mode): ActionItem[] => {
    const own = ownBars[mode];
    const items = Array.isArray(own) ? own : bars[mode];
    return Array.isArray(items) ? (items as ActionItem[]).map((i) => ({ ...i })) : [];
  };
  const tableItems = bar('table');
  const tableActions = tableItems.length ? tableItems : defaults.tableActions.map((a) => ({ action: a, label: '' }));
  const columns = pick('columns');
  const [width, height] = PROFILE_SIZES[profile];
  return {
    profile,
    width,
    height,
    template,
    tileSize: pick('tileSize') as TileSize,
    tileStyle,
    density: pick('density') as Density,
    billPosition: bill,
    billStyle: defaults.billStyle,
    summaryCollapsible: defaults.summaryCollapsible,
    categoryBar: categoryBar as Exclude<CategoryBar, 'auto'>,
    columns: isInt(columns) ? columns : 0,
    images: (defaults.fixed.images ?? ('images' in layout ? layout.images : 'auto')) as ImagesMode,
    textSize: (defaults.fixed.textSize ?? ('textSize' in layout ? layout.textSize : 'normal')) as TextSize,
    features: [...defaults.features],
    actions: { table: tableActions, quick: bar('quick') },
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
  /** "מנות בשולחן": off — "לוח מנות" shows clean (phase 2; absent from an older server). */
  coursesEnabled?: boolean;
  /** "הצג סימוני תזונה בקופה": the visual menu's dietary words on "auto". */
  showDietaryMarks?: boolean;
  /** "שם פריט מלא ותג i": the four as the till parameters set them (absent from an older server). */
  productText?: ProductTextSettings;
}

/** Nothing set in the till parameters (the hints' fallback before the server answers). */
export const LEGACY_FALLBACK: TillDesignLegacy = {
  tileSize: { quick: 'm', quickTablet: 'm', table: 'm', tableTablet: 'm' },
  quickActions: legacyQuickActions({}),
  fields: { customerName: 'off', serviceType: 'off', guests: 'off' },
  tables: { mapStyle: 'classic', showChairs: 'show' },
  coursesEnabled: false,
  showDietaryMarks: false,
  productText: { ...PRODUCT_TEXT_DEFAULTS },
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

/**
 * The action bar a mode shows: the view's; a quick order's "auto" is the template's own
 * (payDock: אשראי מהיר, מזומן מדויק, שטרות, תשלום), else the till parameters'.
 */
export function actionsFor(
  view: Pick<ProfileView, 'actions'> & { template?: Template },
  mode: Mode,
  legacy: TillDesignLegacy | null | undefined,
): ActionItem[] {
  const list = view.actions[mode];
  if (list.length > 0 || mode === 'table') return list;
  const own = view.template ? TEMPLATE_DEFAULTS[view.template].quickActions : [];
  if (own.length > 0) return own.map((a) => ({ action: a, label: '' }));
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

/* ------------------------------------------- "תפריט ויזואלי": the photos */

export interface CoverageCategory {
  id: string;
  name: string;
  total: number;
  withImage: number;
}

export interface ImageCoverage {
  total: number;
  withImage: number;
  /** 0–100, rounded. */
  percent: number;
  /** The categories with fewer than half their products photographed: the till shows them as text cards. */
  textOnly: CoverageCategory[];
  /** The products without a photo, in the menu's order. */
  missing: Array<{ id: string; name: string; categoryId: string | null }>;
  /** Fewer than 30% of the catalogue photographed: "רוב המוצרים בלי תמונה — 'מגע גדול' יתאים יותר". */
  mostlyWithout: boolean;
}

/** Below this share of photographed products the dashboard warns before a save (§2.4). */
export const VISUAL_MIN_COVERAGE = 0.3;

/**
 * "תמונות: 41 מתוך 56 מוצרים (73%)" and, per category with fewer than half photographed,
 * "שתייה: 2 מתוך 14 — תוצג בלי תמונות" (phase 2 §2.4, decision 8).
 */
export function imageCoverage<C extends MenuCategoryIn, P extends MenuProductIn & { name: string; imageUrl: string | null }>(
  categories: readonly C[],
  products: readonly P[],
): ImageCoverage {
  const withImage = products.filter((p) => !!p.imageUrl).length;
  const textOnly: CoverageCategory[] = [];
  for (const c of categories) {
    const own = products.filter((p) => p.categoryId === c.id);
    const photographed = own.filter((p) => !!p.imageUrl).length;
    if (own.length > 0 && photographed * 2 < own.length) textOnly.push({ id: c.id, name: c.name, total: own.length, withImage: photographed });
  }
  return {
    total: products.length,
    withImage,
    percent: products.length ? Math.round((withImage / products.length) * 100) : 0,
    textOnly,
    missing: products.filter((p) => !p.imageUrl).map((p) => ({ id: p.id, name: p.name, categoryId: p.categoryId })),
    mostlyWithout: products.length > 0 && withImage / products.length < VISUAL_MIN_COVERAGE,
  };
}

/* ------------------------------------------------- the preview's geometry */

/** Tile heights (dp) by tile size — the till's TileSize — and the density factor. */
export const TILE_HEIGHT_DP: Record<Exclude<TileSize, 'auto'>, number> = { xs: 92, s: 112, m: 150, l: 196 };
export const DENSITY_FACTOR: Record<Density, number> = { compact: 0.85, comfortable: 1, spacious: 1.15 };
/** `textSize: large` multiplies every type size. */
export const LARGE_TEXT_FACTOR = 1.15;

/**
 * The side bill's width (dp): 36% of the screen, 340–460 (professional: 40%, at least 300).
 * Phase 2: "לוח מנות" — the lanes board, about half the screen (§2.1); "לילה" — the order on the
 * other side, 34% (§2.3); "תפריט ויזואלי" — the open drawer, 40% (§2.4).
 */
export function sideBillWidth(template: Template, screenWidth: number): number {
  if (template === 'professional') return Math.round(Math.max(300, Math.min(520, screenWidth * 0.4)));
  if (template === 'courses') return Math.round(Math.max(480, screenWidth * (screenWidth >= 1600 ? 0.55 : 0.5)));
  if (template === 'night') return Math.round(Math.max(320, Math.min(520, screenWidth * 0.34)));
  if (template === 'visual') return Math.round(Math.max(340, Math.min(560, screenWidth * 0.4)));
  return Math.round(Math.max(340, Math.min(460, screenWidth * 0.36)));
}

/**
 * How many columns a product grid shows on a pane `paneWidth` dp wide (its padding taken off):
 * `columns` when set, else by the tile style and size. Mirrors the till's rules (TillDesign.kt).
 */
export function gridColumns(opts: {
  style: ResolvedTileStyle;
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
    case 'dish':
      // "תפריט ויזואלי": 3 across sideways, 2 upright, 4 on a 15.6″, one per row on the handheld.
      if (handheld) return 1;
      return fit(380, 2, 4);
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
  style: ResolvedTileStyle;
  size: Exclude<TileSize, 'auto'>;
  density: Density;
  tileWidth: number;
  withPhoto: boolean;
}): number {
  const f = DENSITY_FACTOR[opts.density] ?? 1;
  switch (opts.style) {
    case 'row':
      return opts.density === 'compact' ? 48 : opts.density === 'spacious' ? 64 : 56;
    case 'dish':
      // A 16:10 photo over the name, two lines of description and the price (the handheld's rows: the preview's own).
      return Math.round(((opts.withPhoto ? (opts.tileWidth * 10) / 16 : 0) + 112) * f);
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
