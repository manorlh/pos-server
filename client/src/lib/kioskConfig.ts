/**
 * The customer self-order kiosk's configuration ("קיוסקים") — the dashboard's copy of the
 * contract the server (app/services/kiosk_config.py) and the till render from.
 *
 * Stored as partial override layers: company → shop → machine (the kiosk). The kiosk gets
 * DEFAULTS ⊕ company ⊕ shop ⊕ machine. Merge: dicts deep-merge; lists, MediaRefs and
 * scalars replace; in a layer a `null` means "inherit" and is dropped.
 *
 * Pure: no React, no `@/` alias, so `npm test` compiles and runs it on its own
 * (kioskConfig.test.ts). The only browser API is `sha256Hex` (crypto.subtle), which the
 * node test does not call.
 */

/* ------------------------------------------------------------------ types */

export type MediaKind = 'image' | 'video' | 'font';

/** A file the kiosk downloads to its cache and checks by its SHA-256. */
export interface MediaRef {
  url: string;
  kind: MediaKind;
  /** 64 lowercase hex, or null when unknown. */
  sha256: string | null;
  bytes: number | null;
}

export type FulfillmentMode = 'BON' | 'KDS';
export type ServiceType = 'take_away' | 'eat_in';
export type KioskLanguage = 'he' | 'en' | 'ar' | 'ru';
export type SkipCartMode = 'off' | 'direct' | 'confirm';
export type SoldOutMode = 'disable' | 'hide';

export interface KioskGeneral {
  fulfillmentMode: FulfillmentMode;
  serviceTypes: ServiceType[];
  askTableNumber: boolean;
  languages: KioskLanguage[];
  skipCart: SkipCartMode;
  upsellEnabled: boolean;
  searchEnabled: boolean;
  notesEnabled: boolean;
  quickNotesEnabled: boolean;
  showAllergens: boolean;
  /** "הצג סימוני תזונה ואלרגנים": the dietary badges and (with showAllergens) the allergens chip. */
  showDietary: boolean;
  /** Accessibility: no add-to-cart flight, no bounces, no counting up. */
  reduceMotion: boolean;
  /** "צליל התראה כשאין אינטרנט": a sound on the kiosk when it loses the internet. */
  offlineSound: boolean;
  /** "חסימת הזמנות כשאין אינטרנט": the old rule — no orders while offline (docs/SPEC_KIOSK.md §17); off. */
  blockWhenOffline: boolean;
  /** "הודעה ללקוח כשאין אינטרנט": a quiet line to the customer while offline and still selling; off. */
  offlineNotice: boolean;
  soldOutMode: SoldOutMode;
  /** "לקחת / לשבת": after "הזמינו כאן" (default) or two big buttons on the attract screen. */
  servicePlacement: ServicePlacement;
}

export type ServicePlacement = 'after_start' | 'attract';
export const SERVICE_PLACEMENTS: ServicePlacement[] = ['after_start', 'attract'];
export type DetailsStep = 'after_service' | 'before_cart' | 'before_pay' | 'after_pay';
export const DETAILS_STEPS: DetailsStep[] = ['after_service', 'before_cart', 'before_pay', 'after_pay'];
/**
 * "הגדלת מכירה" on the kiosk: the rules are the menu's (place "kiosk", lib/kioskUpsell.ts,
 * docs/SPEC_KIOSK.md §21); the kiosk keeps only its cap — the windows in one order.
 */
export interface KioskUpsell {
  maxShown: number;
}

export const UPSELL_MAX_SHOWN = 5;

/** Keys a kiosk layer no longer has (the kiosk's own rules of the first round): dropped, never refused. */
export const RETIRED_KIOSK_KEYS: Array<[string, string]> = [['upsell', 'rules'], ['upsell', 'when']];

/** "הודעת סיום": on the success screen for `timers.successSec`. */
export interface KioskSuccess {
  message: string;
  image: MediaRef | null;
}

export type ThemeMode = 'light' | 'dark';
export type CardStyle = 'elevated' | 'outlined' | 'flat';
export type ButtonShape = 'pill' | 'rounded' | 'square';
export type GridDensity = 'compact' | 'comfortable' | 'large';
export type ImageRatio = '1:1' | '4:3' | '16:9';
export type CategoryStyle = 'chips' | 'tabs' | 'images';
/** The categories: a rail on the start side (right in RTL), or the strip across the top. */
export type CategoryLayout = 'side' | 'top';
/** "סגנון ממשק" — see KIOSK_UI_PRESETS. */
export type UiStyle = 'ios' | 'wolt' | 'classic' | 'minimal_dark';
export type TypeScale = 'normal' | 'large' | 'xlarge';
export type TypeWeight = 'light' | 'regular' | 'bold';
/** The basket while ordering: the floating bar, or a side panel on a wide screen. */
export type CartStyle = 'bar' | 'panel';
export type AnimationLevel = 'subtle' | 'lively';

export interface KioskTheme {
  mode: ThemeMode;
  font: string;
  primaryColor: string;
  accentColor: string;
  backgroundColor: string | null;
  surfaceColor: string | null;
  textColor: string | null;
  buttonColor: string | null;
  buttonTextColor: string | null;
  backgroundImage: MediaRef | null;
  logo: MediaRef | null;
  cornerRadius: number;
  cardStyle: CardStyle;
  buttonShape: ButtonShape;
  gridDensity: GridDensity;
  imageRatio: ImageRatio;
  categoryStyle: CategoryStyle;
  categoryLayout: CategoryLayout;
  uiStyle: UiStyle;
  typeScale: TypeScale;
  typeWeight: TypeWeight;
  cartStyle: CartStyle;
  animation: AnimationLevel;
  showDescriptions: boolean;
}

export const TEXT_KEYS = [
  'attractTitle',
  'attractSubtitle',
  'attractCta',
  'serviceTitle',
  'takeAwayLabel',
  'eatInLabel',
  'catalogTitle',
  'cartTitle',
  'checkoutCta',
  'payTitle',
  'payInstruction',
  'successTitle',
  'successBody',
  'pickupLabel',
  'customerTitle',
  'customerExplain',
  'pausedTitle',
  'pausedBody',
  'closedTitle',
  'closedBody',
  'helpText',
  'upsellTitle',
  /** The screen shown while the external pinpad is not configured or not reachable. */
  'noPaymentTitle',
  'noPaymentBody',
  /** The screen shown while the kiosk has no internet (card payment unavailable). */
  'offlineTitle',
  'offlineBody',
] as const;
export type KioskTextKey = (typeof TEXT_KEYS)[number];
export type KioskTexts = Partial<Record<KioskTextKey, string>>;

export const SCREEN_IMAGE_KEYS = ['service', 'catalogHeader', 'cart', 'pay', 'success', 'paused'] as const;
export type ScreenImageKey = (typeof SCREEN_IMAGE_KEYS)[number];
export type KioskScreenImages = Partial<Record<ScreenImageKey, MediaRef | null>>;

export const ATTRACT_SECTIONS = ['hero', 'promos', 'categories', 'club'] as const;
export type AttractSection = (typeof ATTRACT_SECTIONS)[number];

export interface PlaylistItem {
  media: MediaRef;
  durationSec: number;
}

export type CtaSize = 's' | 'm' | 'l' | 'xl' | 'custom';
/** Physical places: "right" is the screen's right in every language. */
export type CtaPosition =
  | 'top_right'
  | 'top_center'
  | 'top_left'
  | 'middle_right'
  | 'middle_center'
  | 'middle_left'
  | 'bottom_right'
  | 'bottom_center'
  | 'bottom_left'
  | 'bottom_full'
  | 'custom';
export type CtaWeight = 'regular' | 'bold' | 'black';
export type CtaIcon = 'none' | 'cart' | 'arrow' | 'hand' | 'star';
export type CtaIconPosition = 'start' | 'end';
export type CtaAnimation = 'none' | 'pulse' | 'glow' | 'bounce';

export const CTA_SIZES: CtaSize[] = ['s', 'm', 'l', 'xl', 'custom'];
export const CTA_POSITIONS: CtaPosition[] = [
  'top_right',
  'top_center',
  'top_left',
  'middle_right',
  'middle_center',
  'middle_left',
  'bottom_right',
  'bottom_center',
  'bottom_left',
  'bottom_full',
  'custom',
];
export const CTA_WEIGHTS: CtaWeight[] = ['regular', 'bold', 'black'];
export const CTA_ICONS: CtaIcon[] = ['none', 'cart', 'arrow', 'hand', 'star'];
export const CTA_ANIMATIONS: CtaAnimation[] = ['none', 'pulse', 'glow', 'bounce'];

/** "כפתור מסך הפתיחה" — the attract screen's call to action; its label is texts.attractCta. */
export interface KioskCta {
  size: CtaSize;
  /** custom size only: width as a percent of the screen (20–100) × height in dp (56–200). */
  widthPct: number;
  heightDp: number;
  position: CtaPosition;
  /** custom position only: the button's centre, in percent of the screen (0–100). */
  x: number;
  y: number;
  /** null: the theme's button colour. */
  fillColor: string | null;
  /** null: the theme's button text colour. */
  textColor: string | null;
  /** sp, 14–64 (fitted to the button: ctaFontSp). */
  fontSize: number;
  fontWeight: CtaWeight;
  /** 0 square … 100 pill (percent of half the height); null: the theme's button shape. */
  radius: number | null;
  /** null: the label's colour. */
  borderColor: string | null;
  borderWidth: number;
  shadow: boolean;
  icon: CtaIcon;
  iconPosition: CtaIconPosition;
  /** "none" whenever general.reduceMotion is on (ctaAnimation). */
  animation: CtaAnimation;
  /** An optional second, smaller line (≤ 80). */
  subtitle: string;
  /** "כל המסך פותח הזמנה": a tap anywhere on the attract screen starts an order. */
  tapAnywhere: boolean;
}

export interface KioskAttract {
  sections: AttractSection[];
  playlist: PlaylistItem[];
  videoMuted: boolean;
  showHelp: boolean;
  cta: KioskCta;
}

export interface KioskCatalog {
  categoryOrder: string[];
  hiddenCategories: string[];
  productOrder: Record<string, string[]>;
  hiddenProducts: string[];
  categoryImages: Record<string, MediaRef>;
  featuredProductIds: string[];
  /** "הצג כל מחלקה בנפרד": one category at a time, chosen from the rail. */
  oneCategory: boolean;
}

export type MessageKind = 'banner' | 'notice' | 'closed';
export const MESSAGE_KINDS: MessageKind[] = ['banner', 'notice', 'closed'];
export const MESSAGE_SCREENS = ['attract', 'service', 'catalog', 'cart', 'pay', 'success', 'paused'] as const;
export type MessageScreen = (typeof MESSAGE_SCREENS)[number];
export type MessageStyle = 'info' | 'promo' | 'warning' | 'success';
export const MESSAGE_STYLES: MessageStyle[] = ['info', 'promo', 'warning', 'success'];

export interface KioskMessage {
  id: string;
  kind: MessageKind;
  enabled: boolean;
  title: string;
  body: string;
  image: MediaRef | null;
  screens: MessageScreen[];
  style: MessageStyle;
  productId: string | null;
  startsAt: string | null;
  endsAt: string | null;
}

export interface HoursRange {
  /** 0 = Sunday … 6 = Saturday. */
  days: number[];
  open: string;
  /** Before `open` = past midnight. null: "פתיחה אוטומטית" only — it opens, and never closes by itself. */
  close: string | null;
}

export interface KioskHours {
  enabled: boolean;
  ranges: HoursRange[];
}

export type ReceiptPolicy = 'always' | 'ask' | 'never';
export type CustomerFieldMode = 'off' | 'optional' | 'required';

export interface KioskPayment {
  methods: string[];
  tipEnabled: boolean;
  tipPresets: number[];
  receiptPolicy: ReceiptPolicy;
  customerName: CustomerFieldMode;
  customerPhone: CustomerFieldMode;
  minOrderAgorot: number;
  /** The table number (eat-in only). */
  tableNumber: CustomerFieldMode;
  /** When name / phone / table are asked. */
  detailsStep: DetailsStep;
}

export type BonMode = 'routing' | 'single';

export interface KioskPrinting {
  bonMode: BonMode;
  bonPrinterId: string | null;
  bonCopies: number;
  receiptPrinterId: string | null;
  /** A small customer slip with the pickup number on the receipt printer (whatever receiptPolicy says). */
  pickupSlip: boolean;
  /** An unprinted bon prints again by itself when the printer comes back, if younger than this (min); 0: never. */
  bonAutoRetryMin: number;
}

export type PickupScope = 'kiosk' | 'shop';

export interface KioskPickup {
  scope: PickupScope;
  prefix: string;
  start: number;
  max: number;
}

export interface KioskTimers {
  inactivitySec: number;
  warningSec: number;
  successSec: number;
  attractSlideSec: number;
}

export interface KioskClub {
  enabled: boolean;
  joinUrl: string;
  title: string;
  body: string;
}

export interface KioskOperations {
  autoCloseAt: string;
  pausedTitle: string;
  pausedBody: string;
  /** "סגירה יחד עם ה-Z הסניפי": the shop's Z closes the kiosk's shift and makes its own Z. */
  closeWithShopZ: boolean;
}

/** "התראות לקופות" (docs/SPEC_KIOSK.md §16): which tills, and who on them. */
export type KioskAlertTills = 'main' | 'all' | 'selected';
export type KioskAlertAudience = 'everyone' | 'managers';
export interface KioskAlertRoute {
  tills: KioskAlertTills;
  machineIds: string[];
  audience: KioskAlertAudience;
}
export interface KioskAlerts {
  printer: KioskAlertRoute;
  terminal: KioskAlertRoute;
  help: KioskAlertRoute & { clearAfterMin: number };
}
export const ALERT_KINDS = ['printer', 'terminal', 'help'] as const;
export type KioskAlertKind = (typeof ALERT_KINDS)[number];
export const ALERT_TILLS: KioskAlertTills[] = ['main', 'all', 'selected'];
export const ALERT_AUDIENCES: KioskAlertAudience[] = ['everyone', 'managers'];

export interface KioskConfig {
  general: KioskGeneral;
  theme: KioskTheme;
  texts: KioskTexts;
  screenImages: KioskScreenImages;
  attract: KioskAttract;
  catalog: KioskCatalog;
  messages: KioskMessage[];
  hours: KioskHours;
  payment: KioskPayment;
  printing: KioskPrinting;
  pickup: KioskPickup;
  timers: KioskTimers;
  club: KioskClub;
  operations: KioskOperations;
  alerts: KioskAlerts;
  upsell: KioskUpsell;
  success: KioskSuccess;
}

export type KioskSectionKey = keyof KioskConfig;

/** A partial layer as stored per level: any subset, `null` = inherit. */
export type KioskLayer = { [key: string]: unknown };

/** One font of the curated catalog (contract §1.2). */
export interface KioskFont {
  id: string;
  label: string;
  cssFamily: string;
  regular: string | null;
  bold: string | null;
  variable: boolean;
}

/* --------------------------------------------------------------- constants */

export const SERVICE_TYPES: ServiceType[] = ['take_away', 'eat_in'];
export const LANGUAGES: KioskLanguage[] = ['he', 'en', 'ar', 'ru'];

/** The ranges validation enforces — the server's own (GET /kiosks/defaults → limits). */
export const KIOSK_LIMITS = {
  cornerRadius: { min: 0, max: 40 },
  textMax: 200,
  playlistMax: 20,
  playlistDuration: { min: 2, max: 120 },
  featuredMax: 12,
  messagesMax: 30,
  messageTitleMax: 80,
  messageBodyMax: 300,
  hoursRangesMax: 14,
  tipPresetsMax: 4,
  tipPreset: { min: 1, max: 50 },
  bonCopies: { min: 1, max: 3 },
  pickupPrefixMax: 3,
  pickupMax: 9999,
  inactivitySec: { min: 15, max: 600 },
  warningSec: { min: 5, max: 120 },
  successSec: { min: 4, max: 120 },
  attractSlideSec: { min: 3, max: 60 },
  pausedTitleMax: 80,
  pausedBodyMax: 300,
  mediaUrlMax: 1000,
  messageIdMax: 40,
  ctaWidthPct: { min: 20, max: 100 },
  ctaHeightDp: { min: 56, max: 200 },
  ctaXY: { min: 0, max: 100 },
  ctaFontSize: { min: 14, max: 64 },
  ctaRadius: { min: 0, max: 100 },
  ctaBorderWidth: { min: 0, max: 8 },
  ctaSubtitleMax: 80,
  alertMachinesMax: 50,
  helpClearAfterMin: { min: 1, max: 120 },
} as const;

/** What a kiosk gets when no level sets anything — the server's defaults, key for key. */
export const KIOSK_DEFAULTS: KioskConfig = {
  general: {
    fulfillmentMode: 'BON',
    serviceTypes: ['take_away', 'eat_in'],
    askTableNumber: false,
    languages: ['he'],
    skipCart: 'off',
    upsellEnabled: true,
    searchEnabled: false,
    notesEnabled: true,
    quickNotesEnabled: true,
    showAllergens: true,
    showDietary: true,
    reduceMotion: false,
    offlineSound: false,
    blockWhenOffline: false,
    offlineNotice: false,
    soldOutMode: 'disable',
    servicePlacement: 'after_start',
  },
  theme: {
    mode: 'light',
    font: 'system',
    primaryColor: '#1F6FEB',
    accentColor: '#16A34A',
    backgroundColor: null,
    surfaceColor: null,
    textColor: null,
    buttonColor: null,
    buttonTextColor: null,
    backgroundImage: null,
    logo: null,
    cornerRadius: 20,
    cardStyle: 'elevated',
    buttonShape: 'pill',
    gridDensity: 'comfortable',
    imageRatio: '4:3',
    categoryStyle: 'chips',
    categoryLayout: 'side',
    uiStyle: 'wolt',
    typeScale: 'normal',
    typeWeight: 'bold',
    cartStyle: 'bar',
    animation: 'lively',
    showDescriptions: true,
  },
  texts: {},
  screenImages: {},
  attract: {
    sections: ['hero', 'promos', 'categories'],
    playlist: [],
    videoMuted: true,
    showHelp: true,
    // The "wolt" style's button: the look it had before it was configurable.
    cta: {
      size: 'l',
      widthPct: 80,
      heightDp: 88,
      position: 'bottom_center',
      x: 50,
      y: 85,
      fillColor: null,
      textColor: null,
      fontSize: 24,
      fontWeight: 'bold',
      radius: null,
      borderColor: null,
      borderWidth: 0,
      shadow: true,
      icon: 'none',
      iconPosition: 'end',
      animation: 'pulse',
      subtitle: '',
      tapAnywhere: true,
    },
  },
  catalog: {
    categoryOrder: [],
    hiddenCategories: [],
    productOrder: {},
    hiddenProducts: [],
    categoryImages: {},
    featuredProductIds: [],
    oneCategory: true,
  },
  messages: [],
  hours: {
    enabled: false,
    ranges: [{ days: [0, 1, 2, 3, 4, 5, 6], open: '08:00', close: '23:00' }],
  },
  payment: {
    methods: ['card'],
    tipEnabled: false,
    tipPresets: [10, 12, 15],
    receiptPolicy: 'ask',
    customerName: 'optional',
    customerPhone: 'off',
    minOrderAgorot: 0,
    tableNumber: 'off',
    detailsStep: 'before_pay',
  },
  printing: {
    bonMode: 'routing',
    bonPrinterId: null,
    bonCopies: 1,
    receiptPrinterId: null,
    pickupSlip: true,
    bonAutoRetryMin: 10,
  },
  pickup: { scope: 'kiosk', prefix: '', start: 1, max: 999 },
  timers: { inactivitySec: 60, warningSec: 20, successSec: 12, attractSlideSec: 8 },
  club: { enabled: false, joinUrl: '', title: '', body: '' },
  operations: { autoCloseAt: '', pausedTitle: '', pausedBody: '', closeWithShopZ: false },
  alerts: {
    printer: { tills: 'main', machineIds: [], audience: 'everyone' },
    terminal: { tills: 'main', machineIds: [], audience: 'everyone' },
    help: { tills: 'main', machineIds: [], audience: 'everyone', clearAfterMin: 10 },
  },
  upsell: { maxShown: 2 },
  success: { message: '', image: null },
};

const GF = 'https://raw.githubusercontent.com/google/fonts/main/ofl';

/** The curated fonts (contract §1.2); the server returns the same list from GET /kiosks/defaults. */
export const FONT_CATALOG: KioskFont[] = [
  { id: 'system', label: 'ברירת מחדל של המכשיר', cssFamily: 'system-ui', regular: null, bold: null, variable: false },
  { id: 'rubik', label: 'Rubik', cssFamily: 'Rubik', regular: `${GF}/rubik/Rubik%5Bwght%5D.ttf`, bold: null, variable: true },
  { id: 'heebo', label: 'Heebo', cssFamily: 'Heebo', regular: `${GF}/heebo/Heebo%5Bwght%5D.ttf`, bold: null, variable: true },
  {
    id: 'assistant',
    label: 'Assistant',
    cssFamily: 'Assistant',
    regular: `${GF}/assistant/Assistant%5Bwght%5D.ttf`,
    bold: null,
    variable: true,
  },
  {
    id: 'noto_sans_hebrew',
    label: 'Noto Sans Hebrew',
    cssFamily: 'Noto Sans Hebrew',
    regular: `${GF}/notosanshebrew/NotoSansHebrew%5Bwdth%2Cwght%5D.ttf`,
    bold: null,
    variable: true,
  },
  {
    id: 'alef',
    label: 'Alef',
    cssFamily: 'Alef',
    regular: `${GF}/alef/Alef-Regular.ttf`,
    bold: `${GF}/alef/Alef-Bold.ttf`,
    variable: false,
  },
  {
    id: 'varela_round',
    label: 'Varela Round',
    cssFamily: 'Varela Round',
    regular: `${GF}/varelaround/VarelaRound-Regular.ttf`,
    bold: null,
    variable: false,
  },
  {
    id: 'secular_one',
    label: 'Secular One',
    cssFamily: 'Secular One',
    regular: `${GF}/secularone/SecularOne-Regular.ttf`,
    bold: null,
    variable: false,
  },
  {
    id: 'suez_one',
    label: 'Suez One',
    cssFamily: 'Suez One',
    regular: `${GF}/suezone/SuezOne-Regular.ttf`,
    bold: null,
    variable: false,
  },
  {
    id: 'frank_ruhl_libre',
    label: 'Frank Ruhl Libre',
    cssFamily: 'Frank Ruhl Libre',
    regular: `${GF}/frankruhllibre/FrankRuhlLibre%5Bwght%5D.ttf`,
    bold: null,
    variable: true,
  },
];

/**
 * The Google Fonts CSS2 stylesheet for some catalog fonts (the preview loads it); null
 * when none of them needs one (the device font).
 */
export function googleFontsCssUrl(fonts: ReadonlyArray<Pick<KioskFont, 'cssFamily' | 'variable' | 'bold'>>): string | null {
  const families = fonts
    .filter((f) => f.cssFamily && f.cssFamily !== 'system-ui')
    .map((f) => {
      const name = f.cssFamily.trim().replace(/\s+/g, '+');
      // Variable fonts take a range; static ones only the weights they ship.
      return f.variable ? `family=${name}:wght@400..800` : f.bold ? `family=${name}:wght@400;700` : `family=${name}`;
    });
  if (families.length === 0) return null;
  return `https://fonts.googleapis.com/css2?${Array.from(new Set(families)).join('&')}&display=swap`;
}

/** The CSS font-family stack for a catalog font id (unknown → the device font). */
export function fontStack(fontId: string, catalog: ReadonlyArray<KioskFont> = FONT_CATALOG): string {
  const f = catalog.find((x) => x.id === fontId);
  if (!f || f.cssFamily === 'system-ui') return 'system-ui, -apple-system, "Segoe UI", Arial, sans-serif';
  return `"${f.cssFamily}", system-ui, sans-serif`;
}

/* ------------------------------------------------------------ the merge */

type Dict = { [key: string]: unknown };

function isDict(v: unknown): v is Dict {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A MediaRef is a leaf: it replaces, it never merges key by key. */
export function isMediaRef(v: unknown): v is MediaRef {
  return isDict(v) && typeof v.url === 'string' && (v.kind === 'image' || v.kind === 'video' || v.kind === 'font');
}

function isMergeable(v: unknown): v is Dict {
  return isDict(v) && !isMediaRef(v);
}

/** A deep copy of JSON-shaped data. */
export function cloneJson<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

function mergeInto(target: Dict, layer: Dict): void {
  for (const [key, value] of Object.entries(layer)) {
    if (value === null || value === undefined) continue; // null = inherit
    if (isMergeable(value)) {
      const base = isMergeable(target[key]) ? (target[key] as Dict) : {};
      target[key] = base;
      mergeInto(base, value);
    } else {
      target[key] = cloneJson(value);
    }
  }
}

/**
 * `base` ⊕ each layer in turn, as the server merges: dicts deep-merge; lists, MediaRefs
 * and scalars replace; a `null` (or absent) value inherits. Inputs are not mutated.
 */
/** A layer without RETIRED_KIOSK_KEYS (a copy; as the server drops them). */
export function withoutRetired(layer: KioskLayer | null | undefined): KioskLayer | null | undefined {
  if (!layer || typeof layer !== 'object') return layer;
  let out: KioskLayer = layer;
  for (const [section, key] of RETIRED_KIOSK_KEYS) {
    const part = out[section];
    if (part && typeof part === 'object' && !Array.isArray(part) && key in (part as object)) {
      const rest = { ...(part as Record<string, unknown>) };
      delete rest[key];
      out = { ...out, [section]: rest };
    }
  }
  return out;
}

export function deepMergeKiosk<T extends object>(base: T, ...layers: Array<KioskLayer | null | undefined>): T {
  const out = cloneJson(base) as unknown as Dict;
  for (const layer of layers) {
    if (isDict(layer)) mergeInto(out, layer);
  }
  return out as unknown as T;
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
 * The minimal layer that, merged over `parent` (what this level inherits), yields
 * `edited`: only the keys whose value differs from the inherited one, dicts walked key by
 * key. A `null` cannot be saved (it means "inherit"), so a value cleared to null over a
 * non-null parent falls back to inheriting; an empty text over no parent text is nothing.
 */
export function pruneOverrides(parent: unknown, edited: unknown): KioskLayer {
  const out: KioskLayer = {};
  if (!isDict(edited)) return out;
  const p = isDict(parent) ? parent : {};
  for (const [key, value] of Object.entries(edited)) {
    if (value === undefined || value === null) continue;
    const inherited = p[key];
    if (jsonEqual(value, inherited)) continue;
    if (inherited === undefined && value === '') continue;
    if (isMergeable(value) && (isMergeable(inherited) || inherited === undefined || inherited === null)) {
      const sub = pruneOverrides(inherited, value);
      if (Object.keys(sub).length > 0) out[key] = sub;
      continue;
    }
    out[key] = cloneJson(value);
  }
  return out;
}

/** The layer with its `null`s (inherit) dropped, as the server stores it. */
export function stripNulls(layer: unknown): KioskLayer {
  const out: KioskLayer = {};
  if (!isDict(layer)) return out;
  for (const [key, value] of Object.entries(layer)) {
    if (value === null || value === undefined) continue;
    if (isMergeable(value)) {
      const sub = stripNulls(value);
      if (Object.keys(sub).length > 0) out[key] = sub;
    } else out[key] = cloneJson(value);
  }
  return out;
}

/* ------------------------------------------------------- "סגנון ממשק" */

export const UI_STYLES: UiStyle[] = ['ios', 'wolt', 'classic', 'minimal_dark'];

/** The theme keys a preset decides (unless a layer sets them). */
export const PRESET_THEME_KEYS = [
  'mode',
  'font',
  'primaryColor',
  'accentColor',
  'backgroundColor',
  'surfaceColor',
  'textColor',
  'cornerRadius',
  'cardStyle',
  'buttonShape',
  'gridDensity',
  'imageRatio',
  'categoryStyle',
  'categoryLayout',
  'typeScale',
  'typeWeight',
  'cartStyle',
  'animation',
  'showDescriptions',
] as const;
export type PresetThemeKey = (typeof PRESET_THEME_KEYS)[number];
export type UiPreset = Pick<KioskTheme, PresetThemeKey>;

/**
 * The "סגנון ממשק" presets — the server's UI_PRESETS (app/services/kiosk_config.py) key for
 * key, and the till's KioskUiPresets. "wolt" is the look kiosks had before presets.
 */
export const KIOSK_UI_PRESETS: Record<UiStyle, UiPreset> = {
  ios: {
    mode: 'light', font: 'system',
    primaryColor: '#0A84FF', accentColor: '#34C759',
    backgroundColor: '#F2F2F7', surfaceColor: '#FFFFFF', textColor: null,
    cornerRadius: 16, cardStyle: 'elevated', buttonShape: 'rounded',
    gridDensity: 'comfortable', imageRatio: '4:3',
    categoryStyle: 'tabs', categoryLayout: 'side',
    typeScale: 'large', typeWeight: 'regular',
    cartStyle: 'bar', animation: 'subtle', showDescriptions: true,
  },
  wolt: {
    mode: 'light', font: 'system',
    primaryColor: '#1F6FEB', accentColor: '#16A34A',
    backgroundColor: null, surfaceColor: null, textColor: null,
    cornerRadius: 20, cardStyle: 'elevated', buttonShape: 'pill',
    gridDensity: 'comfortable', imageRatio: '4:3',
    categoryStyle: 'chips', categoryLayout: 'side',
    typeScale: 'normal', typeWeight: 'bold',
    cartStyle: 'bar', animation: 'lively', showDescriptions: true,
  },
  classic: {
    mode: 'light', font: 'heebo',
    primaryColor: '#E11D48', accentColor: '#F59E0B',
    backgroundColor: '#FFFFFF', surfaceColor: '#FFFFFF', textColor: '#000000',
    cornerRadius: 6, cardStyle: 'outlined', buttonShape: 'square',
    gridDensity: 'large', imageRatio: '1:1',
    categoryStyle: 'images', categoryLayout: 'side',
    typeScale: 'xlarge', typeWeight: 'bold',
    cartStyle: 'panel', animation: 'subtle', showDescriptions: false,
  },
  minimal_dark: {
    mode: 'dark', font: 'assistant',
    primaryColor: '#C9A227', accentColor: '#C9A227',
    backgroundColor: '#0B0B0D', surfaceColor: '#16161A', textColor: '#F5F5F4',
    cornerRadius: 8, cardStyle: 'flat', buttonShape: 'rounded',
    gridDensity: 'comfortable', imageRatio: '4:3',
    categoryStyle: 'tabs', categoryLayout: 'side',
    typeScale: 'normal', typeWeight: 'light',
    cartStyle: 'bar', animation: 'subtle', showDescriptions: true,
  },
};

/** The attract button keys a style decides (unless a layer sets them). */
export const PRESET_CTA_KEYS = [
  'size',
  'position',
  'fontSize',
  'fontWeight',
  'shadow',
  'icon',
  'iconPosition',
  'animation',
  'borderColor',
  'borderWidth',
] as const;
export type PresetCtaKey = (typeof PRESET_CTA_KEYS)[number];
export type UiPresetCta = Pick<KioskCta, PresetCtaKey>;

/** Each style's attract button — the server's UI_PRESET_CTA and the till's KioskCta.PRESETS. */
export const KIOSK_UI_PRESET_CTA: Record<UiStyle, UiPresetCta> = {
  ios: {
    size: 'l', position: 'bottom_center', fontSize: 22, fontWeight: 'bold',
    shadow: false, icon: 'none', iconPosition: 'end', animation: 'none',
    borderColor: null, borderWidth: 0,
  },
  wolt: {
    size: 'l', position: 'bottom_center', fontSize: 24, fontWeight: 'bold',
    shadow: true, icon: 'none', iconPosition: 'end', animation: 'pulse',
    borderColor: null, borderWidth: 0,
  },
  classic: {
    size: 'xl', position: 'bottom_center', fontSize: 34, fontWeight: 'black',
    shadow: true, icon: 'cart', iconPosition: 'start', animation: 'bounce',
    borderColor: null, borderWidth: 0,
  },
  minimal_dark: {
    size: 'm', position: 'bottom_center', fontSize: 22, fontWeight: 'regular',
    shadow: false, icon: 'arrow', iconPosition: 'end', animation: 'glow',
    borderColor: '#C9A227', borderWidth: 1,
  },
};

/** Where a style decides values: the theme's keys, and the attract button's. */
const PRESET_SECTIONS: Array<{
  path: 'theme' | 'attract.cta';
  keys: readonly string[];
  table: Record<UiStyle, Record<string, unknown>>;
  defaults: Record<string, unknown>;
}> = [
  {
    path: 'theme',
    keys: PRESET_THEME_KEYS,
    table: KIOSK_UI_PRESETS as unknown as Record<UiStyle, Record<string, unknown>>,
    defaults: KIOSK_DEFAULTS.theme as unknown as Record<string, unknown>,
  },
  {
    path: 'attract.cta',
    keys: PRESET_CTA_KEYS,
    table: KIOSK_UI_PRESET_CTA as unknown as Record<UiStyle, Record<string, unknown>>,
    defaults: KIOSK_DEFAULTS.attract.cta as unknown as Record<string, unknown>,
  },
];

function isUiStyle(v: unknown): v is UiStyle {
  return typeof v === 'string' && (UI_STYLES as string[]).includes(v);
}

/** The style the layers pick: the last that sets `theme.uiStyle`, else the default (wolt). */
export function styleOf(...layers: Array<KioskLayer | null | undefined>): UiStyle {
  let style: UiStyle = KIOSK_DEFAULTS.theme.uiStyle;
  for (const layer of layers) {
    const picked = getPath(layer, 'theme.uiStyle');
    if (isUiStyle(picked)) style = picked;
  }
  return style;
}

/** A style's preset as a layer: its theme keys and its attract button (a null leaves the default). */
export function presetLayer(style: UiStyle): KioskLayer {
  return {
    theme: cloneJson(KIOSK_UI_PRESETS[style] ?? KIOSK_UI_PRESETS.wolt),
    attract: { cta: cloneJson(KIOSK_UI_PRESET_CTA[style] ?? KIOSK_UI_PRESET_CTA.wolt) },
  };
}

/**
 * The server's `repair`: fixes the cross-field rules a parent's later change can break below
 * it, so what a kiosk receives always validates.
 */
export function repairKioskConfig(cfg: KioskConfig, opts: { kdsAvailable?: boolean } = {}): KioskConfig {
  const out = cloneJson(cfg);
  const { general, timers, pickup, printing, club, payment, hours } = out;
  if (general.fulfillmentMode === 'KDS' && !opts.kdsAvailable) general.fulfillmentMode = 'BON';
  if (timers.warningSec >= timers.inactivitySec) timers.warningSec = Math.max(5, timers.inactivitySec - 1);
  if (pickup.start >= pickup.max) {
    pickup.start = KIOSK_DEFAULTS.pickup.start;
    pickup.max = KIOSK_DEFAULTS.pickup.max;
  }
  if (printing.bonMode === 'single' && !printing.bonPrinterId) printing.bonMode = 'routing';
  if (club.enabled && !/^https?:\/\/\S+$/i.test(club.joinUrl || '')) club.enabled = false;
  const methods = (payment.methods ?? []).filter((m) => m === 'card');
  payment.methods = methods.length > 0 ? methods : ['card'];
  if (payment.tipEnabled && (payment.tipPresets ?? []).length === 0) payment.tipPresets = [...KIOSK_DEFAULTS.payment.tipPresets];
  if (hours.enabled && (hours.ranges ?? []).length === 0) hours.enabled = false;
  // "התראות לקופות": a chosen list left empty by a parent's change goes to the main till.
  for (const kind of ALERT_KINDS) {
    const route = out.alerts?.[kind];
    if (route && route.tills === 'selected' && (route.machineIds ?? []).length === 0) route.tills = 'main';
  }
  return out;
}

/**
 * What a kiosk gets from stored layers, as the server resolves it: DEFAULTS ⊕ the style's
 * preset ⊕ the layers (company → shop → kiosk), repaired. Explicit values beat the preset.
 */
export function resolveKioskConfig(...layers: Array<KioskLayer | null | undefined>): KioskConfig {
  const current = layers.map(withoutRetired);
  return repairKioskConfig(deepMergeKiosk(KIOSK_DEFAULTS, presetLayer(styleOf(...current)), ...current));
}

/**
 * What a level inherits once it picks `style`: the parents' resolved config, with every
 * preset key the parents do not set explicitly taken from `style`'s preset instead.
 * `inheritedLayers` is what the parents set explicitly (`GET /kiosks/settings`); without it
 * (an older server) a value counts as explicit when it differs from the parents' own preset.
 * The editor compares against this, prunes against it and resets to it, so a value that
 * only follows the preset is never saved as an override.
 */
export function rebaseInherited(
  inherited: KioskConfig,
  inheritedLayers: KioskLayer | null | undefined,
  style: UiStyle,
): KioskConfig {
  const out = cloneJson(inherited);
  const parentStyle: UiStyle = isUiStyle(inherited.theme.uiStyle) ? inherited.theme.uiStyle : 'wolt';
  const targetStyle: UiStyle = isUiStyle(style) ? style : 'wolt';
  for (const section of PRESET_SECTIONS) {
    const explicit = inheritedLayers ? getPath(inheritedLayers, section.path) : null;
    const now = getPath(inherited, section.path);
    const into = getPath(out, section.path);
    if (!isDict(now) || !isDict(into)) continue;
    const presetOrDefault = (s: UiStyle, key: string) => section.table[s][key] ?? section.defaults[key];
    for (const key of section.keys) {
      const keep = inheritedLayers
        ? isDict(explicit) && explicit[key] !== undefined && explicit[key] !== null
        : !jsonEqual(now[key], presetOrDefault(parentStyle, key));
      if (!keep) into[key] = cloneJson(presetOrDefault(targetStyle, key));
    }
  }
  return out;
}

/**
 * Switch the draft to another style: `theme.uiStyle` = `style`, and every preset key that
 * was following the old base (equal to it) moves to the new base's value. A value chosen
 * at this level stays.
 */
export function switchUiStyle(draft: KioskConfig, oldBase: KioskConfig, newBase: KioskConfig, style: UiStyle): KioskConfig {
  const out = cloneJson(draft);
  out.theme.uiStyle = style;
  for (const section of PRESET_SECTIONS) {
    const was = getPath(draft, section.path);
    const oldB = getPath(oldBase, section.path);
    const newB = getPath(newBase, section.path);
    const into = getPath(out, section.path);
    if (!isDict(was) || !isDict(oldB) || !isDict(newB) || !isDict(into)) continue;
    for (const key of section.keys) {
      if (jsonEqual(was[key], oldB[key])) into[key] = cloneJson(newB[key]);
    }
  }
  return out;
}

/* ------------------------------------------------------------- paths */

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

/** Whether `path` (or anything under it) is set in a layer. */
export function layerHas(layer: unknown, path: string): boolean {
  const v = getPath(layer, path);
  if (v === undefined || v === null) return false;
  if (isMergeable(v)) return Object.keys(stripNulls(v)).length > 0;
  return true;
}

export interface ConfigChange {
  path: string;
  before: unknown;
  after: unknown;
}

/** Every leaf (scalar, list, MediaRef) that differs between two configs, by dotted path. */
export function diffKioskConfigs(before: unknown, after: unknown, prefix = ''): ConfigChange[] {
  const out: ConfigChange[] = [];
  if (isMergeable(before) && isMergeable(after)) {
    const keys = Array.from(new Set([...Object.keys(before), ...Object.keys(after)]));
    for (const key of keys) {
      out.push(...diffKioskConfigs(before[key], after[key], prefix ? `${prefix}.${key}` : key));
    }
    return out;
  }
  const norm = (v: unknown) => (v === undefined ? null : v);
  if (!jsonEqual(norm(before), norm(after))) out.push({ path: prefix, before: norm(before), after: norm(after) });
  return out;
}

/* ------------------------------------------------------------ validation */

export interface KioskValidationError {
  /** Dotted path, as the server reports it ("theme.cornerRadius", "messages.2.title"). */
  path: string;
  /** An i18n key under `kiosks.validation`. */
  code: string;
  params?: Record<string, string | number>;
}

const HEX = /^#[0-9A-Fa-f]{6}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const SHA = /^[0-9a-f]{64}$/;
const MSG_ID = /^[A-Za-z0-9_-]{1,40}$/;
const PREFIX = /^[A-Za-z0-9א-ת-]*$/;

export function isHexColor(v: unknown): v is string {
  return typeof v === 'string' && HEX.test(v);
}

export function isHhMm(v: unknown): v is string {
  return typeof v === 'string' && HHMM.test(v);
}

function isHttpUrl(v: unknown): boolean {
  if (typeof v !== 'string' || v.length === 0) return false;
  return /^https?:\/\/[^\s]+$/i.test(v);
}

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

function uniq<T>(list: T[]): boolean {
  return new Set(list).size === list.length;
}

function checkMedia(
  errors: KioskValidationError[],
  path: string,
  v: unknown,
  kinds: MediaKind[],
  nullable = true,
): void {
  if (v === null || v === undefined) {
    if (!nullable) errors.push({ path, code: 'required' });
    return;
  }
  if (!isMediaRef(v) || !kinds.includes(v.kind)) {
    errors.push({ path, code: 'mediaKind' });
    return;
  }
  if (!isHttpUrl(v.url) || v.url.length > KIOSK_LIMITS.mediaUrlMax) errors.push({ path: `${path}.url`, code: 'mediaUrl' });
  if (v.sha256 !== null && v.sha256 !== undefined && !SHA.test(v.sha256)) {
    errors.push({ path: `${path}.sha256`, code: 'mediaSha' });
  }
}

function checkRange(
  errors: KioskValidationError[],
  path: string,
  v: unknown,
  range: { min: number; max: number },
): void {
  if (!isInt(v) || v < range.min || v > range.max) {
    errors.push({ path, code: 'range', params: { min: range.min, max: range.max } });
  }
}

function checkEnum(errors: KioskValidationError[], path: string, v: unknown, allowed: readonly string[]): void {
  if (typeof v !== 'string' || !allowed.includes(v)) errors.push({ path, code: 'enum' });
}

function checkLength(errors: KioskValidationError[], path: string, v: unknown, max: number): void {
  if (typeof v !== 'string') errors.push({ path, code: 'enum' });
  else if (v.length > max) errors.push({ path, code: 'tooLong', params: { max } });
}

/**
 * The server's main rules, run on the effective config the kiosk would get, so a save
 * that would be refused (422 invalid_kiosk_config) says so before it is sent.
 */
export function validateKioskConfig(
  cfg: KioskConfig,
  opts: { kdsAvailable?: boolean; fonts?: ReadonlyArray<{ id: string }> } = {},
): KioskValidationError[] {
  const e: KioskValidationError[] = [];
  const L = KIOSK_LIMITS;
  const g = cfg.general;

  checkEnum(e, 'general.fulfillmentMode', g.fulfillmentMode, ['BON', 'KDS']);
  if (g.fulfillmentMode === 'KDS' && !opts.kdsAvailable) {
    e.push({ path: 'general.fulfillmentMode', code: 'kds_not_available' });
  }
  if (!Array.isArray(g.serviceTypes) || g.serviceTypes.length === 0) {
    e.push({ path: 'general.serviceTypes', code: 'atLeastOne' });
  } else if (!uniq(g.serviceTypes) || g.serviceTypes.some((s) => !SERVICE_TYPES.includes(s))) {
    e.push({ path: 'general.serviceTypes', code: 'enum' });
  }
  if (!Array.isArray(g.languages) || g.languages.length === 0) {
    e.push({ path: 'general.languages', code: 'atLeastOne' });
  } else if (!uniq(g.languages) || g.languages.some((s) => !LANGUAGES.includes(s))) {
    e.push({ path: 'general.languages', code: 'enum' });
  }
  checkEnum(e, 'general.skipCart', g.skipCart, ['off', 'direct', 'confirm']);
  checkEnum(e, 'general.soldOutMode', g.soldOutMode, ['disable', 'hide']);
  checkEnum(e, 'general.servicePlacement', g.servicePlacement, SERVICE_PLACEMENTS);
  for (const key of ['askTableNumber', 'upsellEnabled', 'searchEnabled', 'notesEnabled', 'quickNotesEnabled', 'showAllergens', 'showDietary', 'reduceMotion', 'offlineSound', 'blockWhenOffline', 'offlineNotice'] as const) {
    if (typeof g[key] !== 'boolean') e.push({ path: `general.${key}`, code: 'enum' });
  }

  const th = cfg.theme;
  checkEnum(e, 'theme.mode', th.mode, ['light', 'dark']);
  const fonts = opts.fonts ?? FONT_CATALOG;
  if (!fonts.some((f) => f.id === th.font)) e.push({ path: 'theme.font', code: 'unknownFont' });
  for (const key of ['primaryColor', 'accentColor'] as const) {
    if (!isHexColor(th[key])) e.push({ path: `theme.${key}`, code: 'color' });
  }
  for (const key of ['backgroundColor', 'surfaceColor', 'textColor', 'buttonColor', 'buttonTextColor'] as const) {
    if (th[key] !== null && !isHexColor(th[key])) e.push({ path: `theme.${key}`, code: 'color' });
  }
  checkMedia(e, 'theme.backgroundImage', th.backgroundImage, ['image']);
  checkMedia(e, 'theme.logo', th.logo, ['image']);
  checkRange(e, 'theme.cornerRadius', th.cornerRadius, L.cornerRadius);
  checkEnum(e, 'theme.cardStyle', th.cardStyle, ['elevated', 'outlined', 'flat']);
  checkEnum(e, 'theme.buttonShape', th.buttonShape, ['pill', 'rounded', 'square']);
  checkEnum(e, 'theme.gridDensity', th.gridDensity, ['compact', 'comfortable', 'large']);
  checkEnum(e, 'theme.imageRatio', th.imageRatio, ['1:1', '4:3', '16:9']);
  checkEnum(e, 'theme.categoryStyle', th.categoryStyle, ['chips', 'tabs', 'images']);
  checkEnum(e, 'theme.categoryLayout', th.categoryLayout, ['side', 'top']);
  checkEnum(e, 'theme.uiStyle', th.uiStyle, UI_STYLES);
  checkEnum(e, 'theme.typeScale', th.typeScale, ['normal', 'large', 'xlarge']);
  checkEnum(e, 'theme.typeWeight', th.typeWeight, ['light', 'regular', 'bold']);
  checkEnum(e, 'theme.cartStyle', th.cartStyle, ['bar', 'panel']);
  checkEnum(e, 'theme.animation', th.animation, ['subtle', 'lively']);
  if (typeof th.showDescriptions !== 'boolean') e.push({ path: 'theme.showDescriptions', code: 'enum' });

  for (const [key, value] of Object.entries(cfg.texts ?? {})) {
    if (!(TEXT_KEYS as readonly string[]).includes(key)) {
      e.push({ path: `texts.${key}`, code: 'unknownTextKey', params: { key } });
    } else if (value !== null && value !== undefined) {
      checkLength(e, `texts.${key}`, value, L.textMax);
    }
  }
  for (const [key, value] of Object.entries(cfg.screenImages ?? {})) {
    if (!(SCREEN_IMAGE_KEYS as readonly string[]).includes(key)) {
      e.push({ path: `screenImages.${key}`, code: 'unknownKey', params: { key } });
    } else checkMedia(e, `screenImages.${key}`, value, ['image']);
  }

  const a = cfg.attract;
  if (!uniq(a.sections) || a.sections.some((s) => !(ATTRACT_SECTIONS as readonly string[]).includes(s))) {
    e.push({ path: 'attract.sections', code: 'enum' });
  }
  if (a.playlist.length > L.playlistMax) e.push({ path: 'attract.playlist', code: 'tooMany', params: { max: L.playlistMax } });
  a.playlist.forEach((item, i) => {
    checkMedia(e, `attract.playlist.${i}.media`, item.media, ['image', 'video'], false);
    checkRange(e, `attract.playlist.${i}.durationSec`, item.durationSec, L.playlistDuration);
  });
  const cta = a.cta;
  if (!isDict(cta)) {
    e.push({ path: 'attract.cta', code: 'enum' });
  } else {
    const p = 'attract.cta';
    checkEnum(e, `${p}.size`, cta.size, CTA_SIZES);
    checkRange(e, `${p}.widthPct`, cta.widthPct, L.ctaWidthPct);
    checkRange(e, `${p}.heightDp`, cta.heightDp, L.ctaHeightDp);
    checkEnum(e, `${p}.position`, cta.position, CTA_POSITIONS);
    checkRange(e, `${p}.x`, cta.x, L.ctaXY);
    checkRange(e, `${p}.y`, cta.y, L.ctaXY);
    for (const key of ['fillColor', 'textColor', 'borderColor'] as const) {
      if (cta[key] !== null && !isHexColor(cta[key])) e.push({ path: `${p}.${key}`, code: 'color' });
    }
    checkRange(e, `${p}.fontSize`, cta.fontSize, L.ctaFontSize);
    checkEnum(e, `${p}.fontWeight`, cta.fontWeight, CTA_WEIGHTS);
    if (cta.radius !== null) checkRange(e, `${p}.radius`, cta.radius, L.ctaRadius);
    checkRange(e, `${p}.borderWidth`, cta.borderWidth, L.ctaBorderWidth);
    if (typeof cta.shadow !== 'boolean') e.push({ path: `${p}.shadow`, code: 'enum' });
    checkEnum(e, `${p}.icon`, cta.icon, CTA_ICONS);
    checkEnum(e, `${p}.iconPosition`, cta.iconPosition, ['start', 'end']);
    checkEnum(e, `${p}.animation`, cta.animation, CTA_ANIMATIONS);
    checkLength(e, `${p}.subtitle`, cta.subtitle, L.ctaSubtitleMax);
    if (typeof cta.tapAnywhere !== 'boolean') e.push({ path: `${p}.tapAnywhere`, code: 'enum' });
  }

  const c = cfg.catalog;
  if (c.featuredProductIds.length > L.featuredMax) {
    e.push({ path: 'catalog.featuredProductIds', code: 'tooMany', params: { max: L.featuredMax } });
  }
  if (!uniq(c.featuredProductIds)) e.push({ path: 'catalog.featuredProductIds', code: 'duplicate' });
  if (typeof c.oneCategory !== 'boolean') e.push({ path: 'catalog.oneCategory', code: 'enum' });
  for (const [catId, ref] of Object.entries(c.categoryImages ?? {})) {
    checkMedia(e, `catalog.categoryImages.${catId}`, ref, ['image'], false);
  }

  if (cfg.messages.length > L.messagesMax) e.push({ path: 'messages', code: 'tooMany', params: { max: L.messagesMax } });
  const ids = new Set<string>();
  cfg.messages.forEach((m, i) => {
    const p = `messages.${i}`;
    if (!MSG_ID.test(m.id)) e.push({ path: `${p}.id`, code: 'messageId' });
    else if (ids.has(m.id)) e.push({ path: `${p}.id`, code: 'duplicate' });
    ids.add(m.id);
    checkEnum(e, `${p}.kind`, m.kind, MESSAGE_KINDS);
    checkLength(e, `${p}.title`, m.title, L.messageTitleMax);
    checkLength(e, `${p}.body`, m.body, L.messageBodyMax);
    checkMedia(e, `${p}.image`, m.image, ['image']);
    if (!uniq(m.screens) || m.screens.some((s) => !(MESSAGE_SCREENS as readonly string[]).includes(s))) {
      e.push({ path: `${p}.screens`, code: 'enum' });
    }
    checkEnum(e, `${p}.style`, m.style, MESSAGE_STYLES);
    if (m.productId !== null && m.productId !== undefined && m.kind !== 'banner') {
      e.push({ path: `${p}.productId`, code: 'bannerOnly' });
    }
    const starts = m.startsAt ? Date.parse(m.startsAt) : null;
    const ends = m.endsAt ? Date.parse(m.endsAt) : null;
    if (m.startsAt && Number.isNaN(starts)) e.push({ path: `${p}.startsAt`, code: 'date' });
    if (m.endsAt && Number.isNaN(ends)) e.push({ path: `${p}.endsAt`, code: 'date' });
    if (starts !== null && ends !== null && !Number.isNaN(starts) && !Number.isNaN(ends) && ends <= starts) {
      e.push({ path: `${p}.endsAt`, code: 'endsBeforeStarts' });
    }
  });

  if (cfg.hours.ranges.length > L.hoursRangesMax) {
    e.push({ path: 'hours.ranges', code: 'tooMany', params: { max: L.hoursRangesMax } });
  }
  if (cfg.hours.enabled && cfg.hours.ranges.length === 0) e.push({ path: 'hours.ranges', code: 'atLeastOne' });
  cfg.hours.ranges.forEach((r, i) => {
    const p = `hours.ranges.${i}`;
    if (r.days.length === 0) e.push({ path: `${p}.days`, code: 'atLeastOne' });
    else if (!uniq(r.days) || r.days.some((d) => !isInt(d) || d < 0 || d > 6)) e.push({ path: `${p}.days`, code: 'enum' });
    if (!isHhMm(r.open)) e.push({ path: `${p}.open`, code: 'time' });
    if (r.close === null) {
      // No closing time: allowed (it opens, and never closes by itself).
    } else if (!isHhMm(r.close)) e.push({ path: `${p}.close`, code: 'time' });
    else if (r.close === r.open) e.push({ path: `${p}.close`, code: 'sameTimes' });
  });

  const pay = cfg.payment;
  if (pay.methods.length === 0) e.push({ path: 'payment.methods', code: 'atLeastOne' });
  if (pay.methods.includes('cash')) e.push({ path: 'payment.methods', code: 'cash_not_supported' });
  else if (pay.methods.some((m) => m !== 'card')) e.push({ path: 'payment.methods', code: 'enum' });
  if (pay.tipPresets.length > L.tipPresetsMax) {
    e.push({ path: 'payment.tipPresets', code: 'tooMany', params: { max: L.tipPresetsMax } });
  }
  if (!uniq(pay.tipPresets)) e.push({ path: 'payment.tipPresets', code: 'duplicate' });
  if (pay.tipEnabled && pay.tipPresets.length === 0) e.push({ path: 'payment.tipPresets', code: 'tipPresetsRequired' });
  if (pay.tipPresets.some((t) => !isInt(t) || t < L.tipPreset.min || t > L.tipPreset.max)) {
    e.push({ path: 'payment.tipPresets', code: 'range', params: { min: L.tipPreset.min, max: L.tipPreset.max } });
  }
  checkEnum(e, 'payment.receiptPolicy', pay.receiptPolicy, ['always', 'ask', 'never']);
  checkEnum(e, 'payment.customerName', pay.customerName, ['off', 'optional', 'required']);
  checkEnum(e, 'payment.customerPhone', pay.customerPhone, ['off', 'optional', 'required']);
  if (!isInt(pay.minOrderAgorot) || pay.minOrderAgorot < 0) e.push({ path: 'payment.minOrderAgorot', code: 'nonNegative' });
  checkEnum(e, 'payment.tableNumber', pay.tableNumber, ['off', 'optional', 'required']);
  checkEnum(e, 'payment.detailsStep', pay.detailsStep, DETAILS_STEPS);

  // "הגדלת מכירה": the kiosk's cap (the rules are the menu's).
  const up = cfg.upsell;
  if (!isInt(up.maxShown) || up.maxShown < 1 || up.maxShown > UPSELL_MAX_SHOWN) {
    e.push({ path: 'upsell.maxShown', code: 'range', params: { min: 1, max: UPSELL_MAX_SHOWN } });
  }
  if (cfg.success.message.length > 300) e.push({ path: 'success.message', code: 'tooLong', params: { max: 300 } });
  checkMedia(e, 'success.image', cfg.success.image, ['image']);

  const pr = cfg.printing;
  checkEnum(e, 'printing.bonMode', pr.bonMode, ['routing', 'single']);
  if (pr.bonMode === 'single' && !pr.bonPrinterId) e.push({ path: 'printing.bonPrinterId', code: 'bonPrinterRequired' });
  checkRange(e, 'printing.bonCopies', pr.bonCopies, L.bonCopies);
  if (typeof pr.pickupSlip !== 'boolean') e.push({ path: 'printing.pickupSlip', code: 'enum' });
  checkRange(e, 'printing.bonAutoRetryMin', pr.bonAutoRetryMin, { min: 0, max: 120 });

  const pk = cfg.pickup;
  checkEnum(e, 'pickup.scope', pk.scope, ['kiosk', 'shop']);
  if (typeof pk.prefix !== 'string' || pk.prefix.length > L.pickupPrefixMax || !PREFIX.test(pk.prefix)) {
    e.push({ path: 'pickup.prefix', code: 'pickupPrefix', params: { max: L.pickupPrefixMax } });
  }
  if (!isInt(pk.start) || pk.start < 1 || pk.start > L.pickupMax - 1) {
    e.push({ path: 'pickup.start', code: 'range', params: { min: 1, max: L.pickupMax - 1 } });
  }
  if (!isInt(pk.max) || pk.max < 2 || pk.max > L.pickupMax) {
    e.push({ path: 'pickup.max', code: 'range', params: { min: 2, max: L.pickupMax } });
  } else if (isInt(pk.start) && pk.start >= pk.max) {
    // Where the server reports it: on `pickup.start`.
    e.push({ path: 'pickup.start', code: 'startBelowMax' });
  }

  const tm = cfg.timers;
  checkRange(e, 'timers.inactivitySec', tm.inactivitySec, L.inactivitySec);
  checkRange(e, 'timers.warningSec', tm.warningSec, L.warningSec);
  if (isInt(tm.warningSec) && isInt(tm.inactivitySec) && tm.warningSec >= tm.inactivitySec) {
    e.push({ path: 'timers.warningSec', code: 'warningBelowInactivity' });
  }
  checkRange(e, 'timers.successSec', tm.successSec, L.successSec);
  checkRange(e, 'timers.attractSlideSec', tm.attractSlideSec, L.attractSlideSec);

  if (cfg.club.enabled && !isHttpUrl(cfg.club.joinUrl)) e.push({ path: 'club.joinUrl', code: 'url' });

  const ops = cfg.operations;
  if (ops.autoCloseAt !== '' && !isHhMm(ops.autoCloseAt)) e.push({ path: 'operations.autoCloseAt', code: 'time' });
  checkLength(e, 'operations.pausedTitle', ops.pausedTitle, L.pausedTitleMax);
  checkLength(e, 'operations.pausedBody', ops.pausedBody, L.pausedBodyMax);
  if (typeof ops.closeWithShopZ !== 'boolean') e.push({ path: 'operations.closeWithShopZ', code: 'enum' });

  // "התראות לקופות": which tills (a chosen list names at least one), who, help's minutes.
  for (const kind of ALERT_KINDS) {
    const route = cfg.alerts?.[kind];
    if (!route) continue;
    const p = `alerts.${kind}`;
    checkEnum(e, `${p}.tills`, route.tills, ALERT_TILLS);
    checkEnum(e, `${p}.audience`, route.audience, ALERT_AUDIENCES);
    const ids = Array.isArray(route.machineIds) ? route.machineIds : [];
    if (!Array.isArray(route.machineIds) || !uniq(ids)) e.push({ path: `${p}.machineIds`, code: 'enum' });
    if (ids.length > L.alertMachinesMax) e.push({ path: `${p}.machineIds`, code: 'tooMany', params: { max: L.alertMachinesMax } });
    if (route.tills === 'selected' && ids.length === 0) e.push({ path: `${p}.machineIds`, code: 'atLeastOne' });
  }
  if (cfg.alerts?.help) checkRange(e, 'alerts.help.clearAfterMin', cfg.alerts.help.clearAfterMin, L.helpClearAfterMin);

  return e;
}

/* --------------------------------------------------------------- helpers */

/** The pickup number as printed: "A-17" with prefix "A", "17" without. */
export function pickupLabel(prefix: string | null | undefined, n: number): string {
  const p = (prefix ?? '').trim();
  return p ? `${p}-${n}` : String(n);
}

/** A copy of `list` with the item at `index` moved by `delta` (clamped; out of range → unchanged). */
export function moveItem<T>(list: readonly T[], index: number, delta: number): T[] {
  const out = list.slice();
  if (index < 0 || index >= out.length) return out;
  const to = Math.max(0, Math.min(out.length - 1, index + delta));
  if (to === index) return out;
  const [item] = out.splice(index, 1);
  out.splice(to, 0, item);
  return out;
}

/** Add `id` when absent, remove it when present. */
export function toggleInList<T>(list: readonly T[], id: T): T[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}

/** A message id that is not taken yet ("m1", "m2", …). */
export function nextMessageId(messages: ReadonlyArray<{ id: string }>): string {
  const taken = new Set(messages.map((m) => m.id));
  let n = messages.length + 1;
  while (taken.has(`m${n}`)) n++;
  return `m${n}`;
}

/** SHA-256 of a file's bytes as 64 lowercase hex (browser: crypto.subtle). */
export async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/* -------------------------------------------------------- catalog view */

export interface CatalogCategoryIn {
  id: string;
}

export interface CatalogProductIn {
  id: string;
  categoryId: string | null;
  /** False = sold out ("אזל") at this kiosk. */
  available?: boolean;
}

export interface CatalogViewProduct<P> {
  product: P;
  hidden: boolean;
  soldOut: boolean;
  featured: boolean;
}

export interface CatalogViewCategory<C, P> {
  category: C;
  hidden: boolean;
  products: CatalogViewProduct<P>[];
}

export interface CatalogView<C, P> {
  categories: CatalogViewCategory<C, P>[];
  featured: CatalogViewProduct<P>[];
}

/** `items` with the ids in `order` first (in that order), then the rest as they came. */
function orderBy<T extends { id: string }>(items: readonly T[], order: readonly string[] | undefined): T[] {
  if (!order || order.length === 0) return items.slice();
  const byId = new Map(items.map((x) => [x.id, x]));
  const first: T[] = [];
  const seen = new Set<string>();
  for (const id of order) {
    const item = byId.get(id);
    if (item && !seen.has(id)) {
      first.push(item);
      seen.add(id);
    }
  }
  return [...first, ...items.filter((x) => !seen.has(x.id))];
}

/**
 * What the kiosk shows, from the till's catalog (categories and products in the till's
 * order) and the kiosk's `catalog` settings:
 * - categories in `categoryOrder` first, the rest after them in the till's order;
 * - in each category, `productOrder[categoryId]` first, the rest in the till's order;
 * - hidden categories / products left out, and sold-out products left out when
 *   `soldOutMode` is "hide" (else kept, marked sold out);
 * - a category with no product left to show is left out;
 * - `featured` = `featuredProductIds` in order, among the products that are shown.
 * `includeHidden` keeps everything (the editor), marked `hidden`.
 */
export function kioskCatalogView<C extends CatalogCategoryIn, P extends CatalogProductIn>(
  categories: readonly C[],
  products: readonly P[],
  cfg: { catalog: KioskCatalog; general?: Pick<KioskGeneral, 'soldOutMode'> },
  opts: { includeHidden?: boolean } = {},
): CatalogView<C, P> {
  const cat = cfg.catalog;
  const hideSoldOut = cfg.general?.soldOutMode === 'hide';
  const hiddenCats = new Set(cat.hiddenCategories);
  const hiddenProducts = new Set(cat.hiddenProducts);
  const featuredIds = new Set(cat.featuredProductIds);
  const includeHidden = opts.includeHidden === true;

  const byCategory = new Map<string, P[]>();
  for (const p of products) {
    if (!p.categoryId) continue;
    const list = byCategory.get(p.categoryId) ?? [];
    list.push(p);
    byCategory.set(p.categoryId, list);
  }

  const shown = new Map<string, CatalogViewProduct<P>>();
  const out: CatalogViewCategory<C, P>[] = [];
  for (const c of orderBy(categories, cat.categoryOrder)) {
    const catHidden = hiddenCats.has(c.id);
    if (catHidden && !includeHidden) continue;
    const rows: CatalogViewProduct<P>[] = [];
    for (const p of orderBy(byCategory.get(c.id) ?? [], cat.productOrder?.[c.id])) {
      const soldOut = p.available === false;
      const hidden = hiddenProducts.has(p.id) || (soldOut && hideSoldOut);
      if (hidden && !includeHidden) continue;
      const row = { product: p, hidden, soldOut, featured: featuredIds.has(p.id) };
      rows.push(row);
      if (!hidden && !catHidden && !shown.has(p.id)) shown.set(p.id, row);
    }
    if (rows.length === 0 && !includeHidden) continue;
    out.push({ category: c, hidden: catHidden, products: rows });
  }

  const featured: CatalogViewProduct<P>[] = [];
  for (const id of cat.featuredProductIds) {
    const row = shown.get(id);
    if (row) featured.push(row);
  }
  return { categories: out, featured };
}

/**
 * The full kiosk order of one category's products as ids — what the editor saves into
 * `productOrder[categoryId]` after a move.
 */
export function categoryProductIds<P extends CatalogProductIn>(
  products: readonly P[],
  categoryId: string,
  productOrder: Record<string, string[]> | undefined,
): string[] {
  return orderBy(
    products.filter((p) => p.categoryId === categoryId),
    productOrder?.[categoryId],
  ).map((p) => p.id);
}

/* ------------------------------------------------------- theme helpers */

/** Relative luminance of "#RRGGBB" (WCAG). */
export function luminance(hex: string): number {
  if (!isHexColor(hex)) return 0;
  const ch = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = ch.map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

/** White or near-black text on `bg`, whichever reads better (automatic contrast). */
export function contrastText(bg: string): string {
  const l = luminance(bg);
  // Contrast against white vs. against #111111 (luminance ≈ 0.0056).
  const onWhite = 1.05 / (l + 0.05);
  const onDark = (l + 0.05) / (0.0056 + 0.05);
  return onWhite >= onDark ? '#FFFFFF' : '#111111';
}

export interface ResolvedThemeColors {
  background: string;
  surface: string;
  text: string;
  mutedText: string;
  border: string;
  primary: string;
  accent: string;
  button: string;
  buttonText: string;
}

/** The colours a kiosk paints with: the theme's, or the mode's default where null. */
export function resolveThemeColors(theme: KioskTheme): ResolvedThemeColors {
  const dark = theme.mode === 'dark';
  const background = theme.backgroundColor ?? (dark ? '#0E1116' : '#F5F6F8');
  const surface = theme.surfaceColor ?? (dark ? '#1A1E26' : '#FFFFFF');
  const text = theme.textColor ?? (dark ? '#F3F4F6' : '#111827');
  const button = theme.buttonColor ?? theme.primaryColor;
  return {
    background,
    surface,
    text,
    mutedText: dark ? '#9CA3AF' : '#6B7280',
    border: dark ? '#2A303B' : '#E5E7EB',
    primary: theme.primaryColor,
    accent: theme.accentColor,
    button,
    buttonText: theme.buttonTextColor ?? contrastText(button),
  };
}

/** The button corner radius in px for a shape (pill = fully round). */
export function buttonRadius(theme: Pick<KioskTheme, 'buttonShape' | 'cornerRadius'>): number {
  if (theme.buttonShape === 'pill') return 999;
  if (theme.buttonShape === 'square') return 4;
  return Math.max(6, Math.round(theme.cornerRadius * 0.6));
}

/** Grid columns for a density, on a phone-width or a tablet-width kiosk. */
export function gridColumns(density: GridDensity, wide: boolean): number {
  if (density === 'compact') return wide ? 4 : 3;
  if (density === 'large') return wide ? 2 : 1;
  return wide ? 3 : 2;
}

/**
 * The catalog grid's columns: the density's count, one fewer beside the cart panel (and, for
 * compact, beside a side rail on a narrow screen), but never one column on a wide screen: a
 * single card across a kiosk shows two products a page (the classic style beside its panel).
 */
export function catalogColumns(density: GridDensity, wide: boolean, panel: boolean, side: boolean): number {
  const n = gridColumns(density, wide) - (panel ? 1 : 0) - (side && !wide && density === 'compact' ? 1 : 0);
  return Math.max(wide ? 2 : 1, n);
}

/** CSS aspect-ratio for an image ratio ("4:3" → "4 / 3"). */
export function aspectRatioCss(ratio: ImageRatio): string {
  return ratio.replace(':', ' / ');
}

/* ------------------------------------------- the attract button's layout */
/*
 * The till's KioskCtaLayout (domain/KioskCta.kt), number for number: dp, origin top-left,
 * PHYSICAL left/right (the preview positions it with `left`, never inset-inline-start).
 */

export const CTA_LAYOUT = {
  MARGIN: 28,
  TOP: 150,
  BOTTOM: 28,
  BOTTOM_WITH_HINT: 60,
  MIN_H: 56,
  MAX_H: 200,
  MIN_W: 160,
  CYCLE_MS: 1800,
  PULSE_MS: 1100,
} as const;

/** The widest a preset size gets on a big screen (KioskCtaLayout.WIDTH_CAPS). */
const CTA_WIDTH_CAPS: Record<Exclude<CtaSize, 'custom'>, number> = { s: 320, m: 420, l: 520, xl: 640 };

const CTA_PRESET_SIZES: Record<Exclude<CtaSize, 'custom'>, [number, number]> = {
  s: [0.4, 64],
  m: [0.55, 72],
  l: [0.7, 84],
  xl: [0.85, 112],
};

export interface CtaBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

type CtaLayoutIn = Pick<KioskCta, 'size' | 'widthPct' | 'heightDp' | 'position' | 'x' | 'y' | 'tapAnywhere'>;

const clampInt = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** The grid row of a position ("top" | "middle" | "bottom"); null for a custom place. */
export function ctaRow(position: CtaPosition): 'top' | 'middle' | 'bottom' | null {
  if (position === 'bottom_full') return 'bottom';
  if (position === 'custom') return null;
  return position.split('_')[0] as 'top' | 'middle' | 'bottom';
}

function ctaColumn(position: CtaPosition): string {
  const i = position.indexOf('_');
  return i < 0 ? 'center' : position.slice(i + 1);
}

/** Width × height in dp: the size's, kept on the screen and never below a finger's size. */
export function ctaSize(cta: CtaLayoutIn, screenW: number, screenH: number): { w: number; h: number } {
  const L = CTA_LAYOUT;
  const avail = Math.max(0, screenW - 2 * L.MARGIN);
  const [share, presetH] = cta.size === 'custom' ? [cta.widthPct / 100, cta.heightDp] : CTA_PRESET_SIZES[cta.size] ?? CTA_PRESET_SIZES.l;
  const capped = Math.round(screenW * share);
  const cap = cta.size === 'custom' ? undefined : CTA_WIDTH_CAPS[cta.size];
  const wantW = cta.position === 'bottom_full' ? avail : cap !== undefined ? Math.min(capped, cap) : capped;
  const lo = Math.min(L.MIN_W, avail);
  const w = clampInt(wantW, lo, Math.max(avail, lo));
  const maxH = Math.max(L.MIN_H, Math.min(L.MAX_H, Math.round(screenH * 0.3)));
  const h = clampInt(presetH, L.MIN_H, maxH);
  return { w, h };
}

function clampInScreen(v: number, lo: number, hi: number, screen: number, size: number): number {
  return hi < lo ? Math.max(0, Math.trunc((screen - size) / 2)) : clampInt(v, lo, hi);
}

/** The button's box on a screen of screenW × screenH dp: its top-left corner and size. */
export function ctaBox(cta: CtaLayoutIn, screenW: number, screenH: number): CtaBox {
  const L = CTA_LAYOUT;
  const { w, h } = ctaSize(cta, screenW, screenH);
  if (cta.position === 'custom') {
    const x = clampInScreen(Math.round((screenW * cta.x) / 100 - w / 2), L.MARGIN, screenW - L.MARGIN - w, screenW, w);
    const y = clampInScreen(Math.round((screenH * cta.y) / 100 - h / 2), L.MARGIN, screenH - L.MARGIN - h, screenH, h);
    return { x, y, w, h };
  }
  const column = cta.position === 'bottom_full' ? 'center' : ctaColumn(cta.position);
  const x = Math.max(0, column === 'left' ? L.MARGIN : column === 'right' ? screenW - L.MARGIN - w : Math.trunc((screenW - w) / 2));
  const bottom = screenH - (cta.tapAnywhere ? L.BOTTOM_WITH_HINT : L.BOTTOM) - h;
  const row = ctaRow(cta.position);
  const y = Math.max(0, row === 'top' ? Math.min(L.TOP, bottom) : row === 'middle' ? Math.trunc((screenH - h) / 2) : bottom);
  return { x, y, w, h };
}

/** The label's size in sp: the configured one, made to fit the button (with its second line). */
export function ctaFontSp(cta: Pick<KioskCta, 'fontSize' | 'subtitle'>, heightDp: number): number {
  const share = cta.subtitle.trim() ? 0.34 : 0.45;
  return Math.min(cta.fontSize, Math.max(14, Math.trunc(heightDp * share)));
}

export function ctaSubtitleSp(cta: Pick<KioskCta, 'fontSize' | 'subtitle'>, heightDp: number): number {
  return Math.max(13, Math.round(ctaFontSp(cta, heightDp) * 0.55));
}

/* The content around the button (KioskCtaLayout.spans / fittingCount on the till). */

/** Between the screen's content and the button (or its hint): nothing comes closer. */
export const ATTRACT_CONTENT_GAP = 20;
/** The "גע במסך כדי להתחיל" hint under the button: a 10 dp gap and one line. */
export const CTA_HINT_GAP = 10;
export const CTA_HINT_BLOCK = 30;

/** Where the attract content goes: the messages' span, the stack's (bottom-aligned), shared or not. */
export interface AttractSpans {
  messagesTop: number;
  messagesBottom: number;
  stackTop: number;
  stackBottom: number;
  /** One span for both: the messages take what the stack leaves. */
  shared: boolean;
  /** The hint shows under the button. */
  hint: boolean;
}

/** The hint shows under the button with tap-anywhere on, when there is room for it. */
export function ctaHintShown(cta: Pick<KioskCta, 'tapAnywhere'>, box: CtaBox, screenH: number): boolean {
  return cta.tapAnywhere && box.y + box.h + CTA_HINT_BLOCK <= screenH;
}

/** The row the content arranges itself around: the position's own, or a custom place's by its centre. */
export function ctaEffectiveRow(cta: Pick<KioskCta, 'position'>, box: CtaBox, screenH: number): 'top' | 'middle' | 'bottom' {
  const row = ctaRow(cta.position);
  if (row) return row;
  const centre = box.y + Math.trunc(box.h / 2);
  return centre * 3 < screenH ? 'top' : centre * 3 < screenH * 2 ? 'middle' : 'bottom';
}

/**
 * Where the attract screen's content goes on a screen `screenH` tall whose header ends at
 * `headerBottom`, so that nothing is ever under the button or its hint: above a bottom-row
 * button, below a top-row one, around a middle-row one (messages above, the rest below).
 */
export function attractSpans(cta: Pick<KioskCta, 'position' | 'tapAnywhere'>, box: CtaBox, screenH: number, headerBottom: number): AttractSpans {
  const hint = ctaHintShown(cta, box, screenH);
  const bottom = Math.max(headerBottom, screenH - CTA_LAYOUT.MARGIN);
  const above = clampInt(box.y - ATTRACT_CONTENT_GAP, headerBottom, bottom);
  const below = clampInt(box.y + box.h + (hint ? CTA_HINT_BLOCK : 0) + ATTRACT_CONTENT_GAP, headerBottom, bottom);
  const row = ctaEffectiveRow(cta, box, screenH);
  if (row === 'bottom') return { messagesTop: headerBottom, messagesBottom: above, stackTop: headerBottom, stackBottom: above, shared: true, hint };
  if (row === 'top') return { messagesTop: below, messagesBottom: bottom, stackTop: below, stackBottom: bottom, shared: true, hint };
  return { messagesTop: headerBottom, messagesBottom: above, stackTop: below, stackBottom: bottom, shared: false, hint };
}

/**
 * How many stacked items (title, then the sections in order) fit in `available` with `gap`
 * between them: the longest prefix that fits, never fewer than `required`. The rest is hidden —
 * it never slides under the button.
 */
export function fittingCount(available: number, heights: number[], gap: number, required: number): number {
  let used = 0;
  let count = 0;
  for (let i = 0; i < heights.length; i++) {
    const next = used + (i > 0 ? gap : 0) + heights[i];
    if (next > available && i >= required) break;
    used = next;
    count++;
  }
  return count;
}

/** The side order panel (cartStyle = panel) only on a screen this wide (KioskCategoryLayout.PANEL_MIN_SCREEN_DP). */
export const PANEL_MIN_SCREEN_DP = 900;

export function cartPanelShown(theme: Pick<KioskTheme, 'cartStyle'>, screenWidthDp: number): boolean {
  return theme.cartStyle === 'panel' && screenWidthDp >= PANEL_MIN_SCREEN_DP;
}

/** The button's animation: none whenever general.reduceMotion is on. */
export function ctaAnimation(cta: Pick<KioskCta, 'animation'>, general: Pick<KioskGeneral, 'reduceMotion'>): CtaAnimation {
  return general.reduceMotion ? 'none' : cta.animation;
}

/** The corner radius in px: a percent of half the height, or the theme's button shape. */
export function ctaRadiusPx(cta: Pick<KioskCta, 'radius'>, h: number, theme: Pick<KioskTheme, 'buttonShape' | 'cornerRadius'>): number {
  if (cta.radius === null || cta.radius === undefined) return Math.min(buttonRadius(theme), Math.round(h / 2));
  return Math.round(((h / 2) * clampInt(cta.radius, 0, 100)) / 100);
}

/** The bounce's lift (0…1 of its 14 dp) at t (0…1) of its 1.8 s cycle: a hop, a small one, a rest. */
export function ctaBounceLift(t: number): number {
  const ease = (f: number) => 1 - (1 - f) * (1 - f);
  if (t < 0 || t >= 0.32) return 0;
  if (t < 0.1) return ease(t / 0.1);
  if (t < 0.2) return 1 - ease((t - 0.1) / 0.1);
  if (t < 0.26) return 0.35 * ease((t - 0.2) / 0.06);
  return 0.35 * (1 - ease((t - 0.26) / 0.06));
}

/** The text size factor of `theme.typeScale`. */
export function typeScaleFactor(scale: TypeScale): number {
  return scale === 'xlarge' ? 1.25 : scale === 'large' ? 1.12 : 1;
}

export interface TypeWeights {
  body: number;
  medium: number;
  semibold: number;
  bold: number;
  extrabold: number;
  black: number;
}

/** The font weights of `theme.typeWeight`, from body text up to the heaviest titles. */
export function typeWeights(weight: TypeWeight): TypeWeights {
  if (weight === 'light') return { body: 300, medium: 400, semibold: 500, bold: 500, extrabold: 600, black: 700 };
  if (weight === 'regular') return { body: 400, medium: 500, semibold: 600, bold: 600, extrabold: 700, black: 800 };
  return { body: 400, medium: 500, semibold: 600, bold: 700, extrabold: 800, black: 900 };
}

/**
 * The picture of a category in the rail / strip: the kiosk's own category image, else the
 * catalog's (the till's) category image, else null (the kiosk draws its initial on the
 * theme colour).
 */
export function categoryRailImage(
  categoryId: string,
  catalog: Pick<KioskCatalog, 'categoryImages'>,
  catalogImageUrls: Record<string, string | null | undefined>,
): string | null {
  return catalog.categoryImages?.[categoryId]?.url || catalogImageUrls[categoryId] || null;
}

export type MessagePlacement = 'inline-center' | 'overlay-center' | 'none';

/**
 * Where a message shows on a screen. The calm screens (attract, success, paused, closed)
 * put it as a centred block in the vertical middle; the ordering screens (service, catalog,
 * cart) as a centred overlay card the customer closes (or that hides itself), at most one
 * per visit; never over the payment, nor over an open product sheet.
 */
export function messagePlacement(screen: string): MessagePlacement {
  if (screen === 'attract' || screen === 'success' || screen === 'paused' || screen === 'closed') return 'inline-center';
  if (screen === 'service' || screen === 'catalog' || screen === 'cart') return 'overlay-center';
  return 'none';
}

/** How long an overlay message stays before it hides itself. */
export const MESSAGE_OVERLAY_MS = 8000;

export interface MotionSpec {
  /** The pop: the dish's picture and name lift out of the card and grow to `popScale`, ms (0 with reduce motion). */
  popMs: number;
  popScale: number;
  /** The add-to-cart flight after the pop, on an arc `arcDp` high, ms (0 = none: only the fade). */
  flyMs: number;
  arcDp: number;
  /** Reduce motion's add: the copy fades out where the dish was, ms. */
  fadeMs: number;
  /** The count badge's bounce scale (0 = none). */
  bounce: number;
  /** The total counting up to its new value, ms (0 = jumps). */
  countUpMs: number;
}

/** The add never takes longer (the till's KioskMotion.ADD_MAX_MS). */
export const ADD_MAX_MS = 700;
export const ADD_POP_LIFT_DP = 18;
export const ADD_END_SCALE = 0.25;
export const ADD_END_ALPHA = 0.15;
const ADD_FADE_FROM = 0.55;

/**
 * The add-to-cart motion by `theme.animation` (the till's KioskMotion, docs/SPEC_KIOSK.md §18):
 * the same pop-and-fly in every UI style — the style sets only how big the pop and how high the
 * arc; `general.reduceMotion` turns it into a short fade, with no bounce and no counting.
 */
export function motionSpec(
  theme: Pick<KioskTheme, 'animation'>,
  general: Pick<KioskGeneral, 'reduceMotion'>,
): MotionSpec {
  if (general.reduceMotion) return { popMs: 0, popScale: 1, flyMs: 0, arcDp: 0, fadeMs: 280, bounce: 0, countUpMs: 0 };
  if (theme.animation === 'lively') return { popMs: 190, popScale: 1.45, flyMs: 430, arcDp: 170, fadeMs: 0, bounce: 1.25, countUpMs: 380 };
  return { popMs: 170, popScale: 1.3, flyMs: 380, arcDp: 110, fadeMs: 0, bounce: 1.12, countUpMs: 260 };
}

/** The whole add: pop and flight, or the fade. */
export function addMs(m: MotionSpec): number {
  return m.flyMs > 0 ? m.popMs + m.flyMs : m.fadeMs;
}

export interface AddFrame {
  x: number;
  y: number;
  scale: number;
  alpha: number;
  /** 0…1. */
  shadow: number;
}

const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;
const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);
const clamp01 = (t: number) => Math.min(1, Math.max(0, t));

/**
 * The flying copy `ms` into the add, from the dish's picture to the cart's badge (px, `dp` px to
 * a dp) — the till's KioskMotion.addFrame, so the preview and the Windows kiosk move the same.
 */
export function addFrame(m: MotionSpec, ms: number, from: { x: number; y: number }, to: { x: number; y: number }, dp = 1): AddFrame {
  if (m.flyMs <= 0) {
    const t = m.fadeMs <= 0 ? 1 : clamp01(ms / m.fadeMs);
    return { x: from.x, y: from.y, scale: 1, alpha: 1 - t, shadow: 0 };
  }
  const lift = ADD_POP_LIFT_DP * dp;
  if (ms < m.popMs) {
    const p = easeOutCubic(clamp01(ms / m.popMs));
    return { x: from.x, y: from.y - lift * p, scale: 1 + (m.popScale - 1) * p, alpha: 1, shadow: p };
  }
  const q = clamp01((ms - m.popMs) / m.flyMs);
  const e = easeInOutCubic(q);
  const sx = from.x;
  const sy = from.y - lift;
  const cx = (sx + to.x) / 2;
  const cy = Math.min(sy, to.y) - m.arcDp * dp;
  const u = 1 - e;
  const alpha = q <= ADD_FADE_FROM ? 1 : 1 - ((1 - ADD_END_ALPHA) * (q - ADD_FADE_FROM)) / (1 - ADD_FADE_FROM);
  return {
    x: u * u * sx + 2 * u * e * cx + e * e * to.x,
    y: u * u * sy + 2 * u * e * cy + e * e * to.y,
    scale: m.popScale + (ADD_END_SCALE - m.popScale) * e,
    alpha,
    shadow: 1 - e,
  };
}

/**
 * What the card's "+" does (the till's KioskAddPath): straight in with the pop-and-fly when
 * nothing must be chosen; a meal or a required choice opens the dish's window; sold out: nothing.
 */
export type AddPath = 'direct' | 'sheet' | 'none';
export function kioskAddPath(soldOut: boolean, meal: boolean, requiredChoice: boolean): AddPath {
  if (soldOut) return 'none';
  return meal || requiredChoice ? 'sheet' : 'direct';
}

export const DIETARY_TAGS = ['vegan', 'vegetarian', 'dairy', 'meat', 'gluten_free', 'spicy'] as const;
export type DietaryTag = (typeof DIETARY_TAGS)[number];
export const DIETARY_EMOJI: Record<DietaryTag, string> = {
  vegan: '🌱',
  vegetarian: '🥕',
  dairy: '🧀',
  meat: '🥩',
  gluten_free: '🌾',
  spicy: '🌶️',
};

/** A product's dietary tags from the catalog: the known ones, once each, in the fixed order. */
export function dietaryTagsOf(raw: unknown): DietaryTag[] {
  if (!Array.isArray(raw)) return [];
  const set = new Set(raw.filter((x): x is string => typeof x === 'string'));
  return DIETARY_TAGS.filter((t) => set.has(t));
}

/* ------------------------------------------------------- status helpers */

export type KioskConnection = 'online' | 'stale' | 'offline' | 'never';

/**
 * "לא מחובר": the server says it is not online, it was never seen, or it was last seen more
 * than `thresholdMs` ago (2 minutes). Its numbers are then its last report, not proof of an
 * idle kiosk.
 */
export function kioskOffline(
  k: { online: boolean; lastSeenAt: string | null },
  nowMs: number,
  thresholdMs = 120_000,
): boolean {
  if (!k.online || !k.lastSeenAt) return true;
  const at = Date.parse(k.lastSeenAt);
  if (Number.isNaN(at)) return true;
  return nowMs - at > thresholdMs;
}

/**
 * How fresh a kiosk's numbers are: online (the server says so), stale (offline but its
 * kiosk sync is recent — the numbers are the last ones it reported), offline, or never
 * synced. An offline kiosk's "0 orders" is never read as "inactive".
 */
export function kioskConnection(
  k: { online: boolean; lastKioskSyncAt: string | null; lastSeenAt: string | null },
  nowMs: number,
  staleWindowMs = 10 * 60 * 1000,
): KioskConnection {
  if (!kioskOffline(k, nowMs)) return 'online';
  const last = k.lastKioskSyncAt ?? k.lastSeenAt;
  if (!last) return 'never';
  const at = Date.parse(last);
  if (Number.isNaN(at)) return 'never';
  return nowMs - at <= staleWindowMs ? 'stale' : 'offline';
}

export type BonStatus = 'none' | 'queued' | 'sent' | 'printed' | 'failed';

/**
 * Only "printed" is a printed bon. "sent" means handed to the printer with no confirmation
 * it came out, and "queued" not even that — neither may read as "הודפס".
 */
export function bonPrinted(status: string | null | undefined): boolean {
  return status === 'printed';
}

/** Agorot (integer) → shekels for display. */
export function agorotToShekels(agorot: number | null | undefined): number | null {
  if (agorot === null || agorot === undefined || !Number.isFinite(agorot)) return null;
  return agorot / 100;
}

/** "YYYY-MM-DD" of `date` in an IANA time zone (the business date's calendar day). */
export function isoDayInZone(date: Date, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

/* ------------------------------------- "נעילה למכירה" and "פתיחה אוטומטית" */
/*
 * The server's app/services/kiosk_schedule.py and the kiosk's domain/KioskSchedule.kt, rule
 * for rule (docs/SPEC_KIOSK.md §15). Days: 0 = Sunday.
 */

export type KioskLockMode = 'manual' | 'time' | 'minutes' | 'next_open';
export const KIOSK_LOCK_MODES: KioskLockMode[] = ['manual', 'time', 'minutes', 'next_open'];

function hhmmMinutes(v: string | null | undefined): number | null {
  if (typeof v !== 'string' || !/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(v)) return null;
  return Number(v.slice(0, 2)) * 60 + Number(v.slice(3));
}

/** Whether the hours let the kiosk take orders on `day` (0 = Sunday) at `minute` of the day. */
export function kioskOpenAt(hours: Pick<KioskHours, 'enabled' | 'ranges'>, day: number, minute: number): boolean {
  if (!hours.enabled) return true;
  const ranges = (hours.ranges ?? []).filter((r) => hhmmMinutes(r.open) !== null);
  if (ranges.length === 0) return true;
  if (ranges.some((r) => r.close === null)) return true; // a range that never closes by itself
  const yesterday = (day + 6) % 7;
  return ranges.some((r) => {
    const start = hhmmMinutes(r.open)!;
    const end = hhmmMinutes(r.close);
    if (end === null) return false;
    if (start < end) return r.days.includes(day) && minute >= start && minute < end;
    return (r.days.includes(day) && minute >= start) || (r.days.includes(yesterday) && minute < end);
  });
}

export interface ScheduleIssue {
  code: 'auto_z_while_open' | 'auto_z_at_opening';
  time: string;
}

/** Close → automatic Z → open: the Z never while open by the hours, nor at an opening. */
export function kioskScheduleIssues(hours: Pick<KioskHours, 'enabled' | 'ranges'>, autoCloseAt: string | null | undefined): ScheduleIssue[] {
  if (!hours.enabled) return [];
  const z = hhmmMinutes(autoCloseAt);
  const ranges = (hours.ranges ?? []).filter((r) => hhmmMinutes(r.open) !== null);
  if (z === null || ranges.length === 0) return [];
  const time = autoCloseAt as string;
  if (ranges.some((r) => r.days.length > 0 && hhmmMinutes(r.open) === z)) return [{ code: 'auto_z_at_opening', time }];
  if (ranges.some((r) => r.close === null)) return [];
  for (let day = 0; day < 7; day++) if (kioskOpenAt(hours, day, z)) return [{ code: 'auto_z_while_open', time }];
  return [];
}

/** The simple "פתיחה אוטומטית" form → its command body (the server writes the kiosk's own level). */
export interface KioskScheduleForm {
  enabled: boolean;
  days: number[];
  open: string;
  close: string | null;
  /** null: unchanged; "": inherit; with a close and nothing given, the server puts the Z at the close. */
  autoCloseAt?: string | null;
}

export function scheduleFormOf(s: { enabled: boolean; days?: number[] | null; open?: string | null; close?: string | null; autoCloseAt?: string | null } | null | undefined): KioskScheduleForm {
  return {
    enabled: !!s?.enabled,
    days: Array.isArray(s?.days) && s!.days!.length ? [...s!.days!].sort((a, b) => a - b) : [0, 1, 2, 3, 4, 5, 6],
    open: s?.open || '07:00',
    close: s?.close ?? null,
    autoCloseAt: s?.autoCloseAt ?? null,
  };
}

/** The hours a form makes, for previewing its issues before it is sent. */
export function scheduleFormHours(f: KioskScheduleForm): Pick<KioskHours, 'enabled' | 'ranges'> {
  return { enabled: f.enabled, ranges: [{ days: f.days, open: f.open, close: f.close || null }] };
}

/** The automatic Z a form ends up with: its own, else the close (close → Z → open). */
export function scheduleFormAutoClose(f: KioskScheduleForm, current: string | null | undefined): string | null {
  if (f.autoCloseAt !== null && f.autoCloseAt !== undefined) return f.autoCloseAt;
  if (f.enabled && f.close) return f.close;
  return current ?? null;
}
