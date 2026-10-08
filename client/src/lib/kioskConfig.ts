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

import {
  KIOSK_LAYOUT_DEFAULTS,
  KIOSK_WELCOME_DEFAULTS,
  layoutTemplateLayer,
  repairLayout,
  templateOf,
  validateLayout,
  type KioskLayout,
  type KioskWelcome,
} from './kioskLayout';
import { validateKioskTexts, isKioskTextKey, type KioskTextsByLang } from './kioskTexts';
import { validateCategoryIconIds } from './kioskIcons';

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
/** The Android kiosk's screens: the APK's built-in ones, or the web screens bundle (updated from the cloud). */
export type KioskRenderer = 'native' | 'web';
export const KIOSK_RENDERERS: readonly KioskRenderer[] = ['native', 'web'];

export interface KioskGeneral {
  fulfillmentMode: FulfillmentMode;
  serviceTypes: ServiceType[];
  /**
   * "סוג שירות": `types` (default) — as `serviceTypes` says: asked with two, else every order is
   * the one; `none` — "ללא סוג שירות": never asked, and no service word anywhere for the order
   * (screens, slip, bon, receipt, KDS); `serviceTypes` stays as it was, for the day it is back.
   */
  serviceMode: ServiceMode;
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
  /**
   * "מנוע תצוגה בקיוסק אנדרואיד": the built-in screens ("native", default) or the web screens
   * bundle ("web") — admin, payments and printing stay native; the kiosk falls back by itself.
   */
  renderer: KioskRenderer;
  /** "לקחת / לשבת": after "הזמינו כאן" (default) or two big buttons on the attract screen. */
  servicePlacement: ServicePlacement;
  /** "לאכול כאן או לקחת?": a tap picks and "להמשך" goes on (default), or a tap goes on at once. */
  serviceSelect: ServiceSelect;
}

export type ServiceMode = 'types' | 'none';
export const SERVICE_MODES: ServiceMode[] = ['types', 'none'];
export type ServicePlacement = 'after_start' | 'attract';
export const SERVICE_PLACEMENTS: ServicePlacement[] = ['after_start', 'attract'];
export type ServiceSelect = 'confirm' | 'instant';
export const SERVICE_SELECTS: ServiceSelect[] = ['confirm', 'instant'];
export type DetailsStep = 'after_service' | 'before_cart' | 'before_pay' | 'after_pay';
export const DETAILS_STEPS: DetailsStep[] = ['after_service', 'before_cart', 'before_pay', 'after_pay'];
/**
 * "סדר השלבים לפני התשלום": the steps between the basket's review and the payment — the tip and
 * the customer's details (the name / phone window, when `detailsStep` is before_pay). Only their
 * order: each is on by its own settings (`tipEnabled`; the customer fields).
 */
export type CheckoutStep = 'tip' | 'details' | 'payMethod';
/** "payMethod" ("איך תרצו לשלם?") is always the last, right before the payment (checkoutStepOrder). */
export const CHECKOUT_STEPS: CheckoutStep[] = ['tip', 'details', 'payMethod'];
/**
 * "איך תרצו לשלם?" (docs/SPEC_KIOSK.md §23): the card on the external pinpad; a prepaid voucher
 * (redeemed online, the rest by another method); cash at the till (no document on the kiosk — a
 * slip, and a till takes the money). Bare "cash" is refused (`cash_not_supported`).
 */
export type PaymentMethod = 'card' | 'voucher' | 'cash_at_till';
export const PAYMENT_METHODS: PaymentMethod[] = ['card', 'voucher', 'cash_at_till'];
/** What can pay what a voucher leaves: a voucher is never the only method. */
export const REMAINDER_METHODS: PaymentMethod[] = ['card', 'cash_at_till'];
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
/** "סגנון ממשק" — see KIOSK_UI_PRESETS ("tech": "טכנולוגי", its chrome in kioskChrome). */
export type UiStyle = 'ios' | 'wolt' | 'classic' | 'minimal_dark' | 'tech';
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
  /** "רוצים להוסיף טיפ לצוות?" — the tip step before the payment, and its step bar. */
  'tipCaption',
  'tipTitle',
  'tipSubtitle',
  'tipOtherLabel',
  'tipOtherHint',
  'tipOrderTotal',
  'tipLine',
  'tipTotal',
  'tipContinue',
  'tipSkip',
  'stepReview',
  'stepTip',
  'stepDetails',
  'stepPay',
  'tipOtherError',
  /** "לאכול כאן או לקחת?" — the service window (serviceTitle, takeAwayLabel, eatInLabel above). */
  'serviceCaption',
  'serviceSubtitle',
  'takeAwaySub',
  'eatInSub',
  'serviceContinue',
  'serviceHint',
  /** "איך לקרוא לכם?" — the details window (the name, the phone, the table). */
  'detailsCaption',
  'nameTitle',
  'nameSubtitle',
  'nameLabel',
  'nameHint',
  'nameConfirm',
  'nameSkip',
  'phoneTitle',
  'phoneHint',
  'tableTitle',
  'entryContinue',
  'entrySkip',
  'fieldRequired',
  'phoneInvalid',
  /** The kiosk's own keyboard. */
  'kbSpace',
  'kbToEnglish',
  'kbToHebrew',
  'kbNumbers',
  'kbLettersHe',
  'kbLettersEn',
  /** "ההזמנה שלי" — the review before the payment ({n}: the number of items). */
  'reviewHint',
  'reviewItems',
  'reviewItemsOne',
  'reviewSubtotal',
  'reviewTotal',
  'addMoreCta',
  /** The search and the dish's note, typed in the same window. */
  'searchTitle',
  'searchHint',
  'noteTitle',
  'noteHint',
  'noteSave',
  /** Barcode scans on the kiosk: "המוצר לא נמצא", and a prepaid voucher scanned (sent to the counter). */
  'scanNotFound',
  'scanVoucherAtTill',
  /** "איך תרצו לשלם?": the method choice, the voucher, paying at the till — its slip and its screen ({amount}, {number}). */
  'stepPayMethod',
  'payMethodTitle',
  'payMethodSubtitle',
  'payCardLabel',
  'payCardSub',
  'payVoucherLabel',
  'payVoucherSub',
  'payCashLabel',
  'payCashSub',
  'remainingToPay',
  'voucherTitle',
  'voucherHint',
  'voucherApply',
  'voucherOffline',
  'voucherApplied',
  'voucherNoMatch',
  'voucherForfeit',
  'cashSlipTitle',
  'cashSlipFooter',
  'cashSlipPending',
  'cashDoneTitle',
  'cashDoneBody',
  /** The attract screen with its button hidden: the line in its place. */
  'attractTouchHint',
] as const;
export type KioskTextKey = (typeof TEXT_KEYS)[number];
export type KioskTexts = Partial<Record<KioskTextKey, string>>;

export const SCREEN_IMAGE_KEYS = ['service', 'catalogHeader', 'cart', 'pay', 'success', 'paused'] as const;
export type ScreenImageKey = (typeof SCREEN_IMAGE_KEYS)[number];
export type KioskScreenImages = Partial<Record<ScreenImageKey, MediaRef | null>>;

/** `welcome` ("ברוכים הבאים"): its place among the blocks; a list without it shows it first, as before. */
export const ATTRACT_SECTIONS = ['hero', 'promos', 'categories', 'club', 'welcome'] as const;
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
  /** The button is drawn (default). Hidden, the whole screen starts an order (`tapAnywhere` must be on). */
  visible: boolean;
  /** Hidden button only: a small line in its place (texts.attractTouchHint, "געו במסך כדי להזמין"). */
  touchHint: boolean;
}

/** A tap anywhere starts an order: when set, and always when the button is hidden. */
export function attractTapAnywhere(cta: Pick<KioskCta, 'tapAnywhere' | 'visible'>): boolean {
  return cta.tapAnywhere || cta.visible === false;
}

export interface KioskAttract {
  sections: AttractSection[];
  playlist: PlaylistItem[];
  videoMuted: boolean;
  showHelp: boolean;
  cta: KioskCta;
  /** "ברוכים הבאים": where and how the title block shows (kioskLayout.ts; its place in `sections` is `welcome`). */
  welcome: KioskWelcome;
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
  /** A category's icon from the built-in set (kioskIcons.ts), by category id; none — suggested by its name. */
  categoryIconIds: Record<string, string>;
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
  /** "סכום אחר": the customer may give a tip of their own, in shekels, besides the presets. */
  tipOther: boolean;
  /** The order of the steps between the basket and the payment (CHECKOUT_STEPS; checkoutStepOrder). */
  checkoutSteps: CheckoutStep[];
  /** "תשלום בקופה": an open order not paid at a till within this many minutes expires (5–240). */
  cashAtTillExpiryMin: number;
  /** "שלח למטבח לפני תשלום": the bon of an order to pay at the till prints at once (off: once paid). */
  cashAtTillKitchenBeforePay: boolean;
  /**
   * "לוגו במסך התשלום": its own picture (POST /kiosks/media), at the top of the screens that wait
   * for the payment — as it is ("plain", a transparent PNG) or on a rounded light plate ("plate").
   * No picture: nothing shows. Optional on the wire: a server before it sends none.
   */
  waitLogo?: KioskWaitLogo;
  /**
   * "חובה / רשות / כבוי" for the steps that are not a customer field (STEP_MODE_KEYS; `stepMode`
   * gives the effective one). Optional on the wire: a server before it sends none — the defaults.
   */
  stepModes?: Partial<Record<StepModeKey, CustomerFieldMode>>;
}

/**
 * "חובה / רשות / כבוי" per step (pos-server docs/SPEC_KIOSK_INSIGHTS.md §4): the customer fields'
 * modes extended to the service choice, the tip, "איך תרצו לשלם?" and the upsell windows at each
 * moment (after an item is added, at a step before the basket, before the payment). required — shown,
 * the customer must answer; optional — shown, may be passed with the default answer; off — never
 * shown. The server's kiosk_config.STEP_MODE_KEYS / step_mode and the till's KioskStepModes.kt.
 */
export type StepModeKey = 'service' | 'tip' | 'payMethod' | 'upsellItem' | 'upsellSteps' | 'upsellCheckout';
export const STEP_MODE_KEYS: StepModeKey[] = ['service', 'tip', 'payMethod', 'upsellItem', 'upsellSteps', 'upsellCheckout'];
export const STEP_MODE_DEFAULTS: Record<StepModeKey, CustomerFieldMode> = {
  service: 'required',
  tip: 'optional',
  payMethod: 'required',
  upsellItem: 'optional',
  upsellSteps: 'optional',
  upsellCheckout: 'optional',
};

export type WaitLogoStyle = 'plain' | 'plate';
export const WAIT_LOGO_STYLES: WaitLogoStyle[] = ['plain', 'plate'];
export interface KioskWaitLogo {
  media: MediaRef | null;
  style: WaitLogoStyle;
}

/** The payment-wait logo to draw, or null: none uploaded (or a config from before it). */
export function waitLogoOf(payment: { waitLogo?: Partial<KioskWaitLogo> | null } | null | undefined): { url: string; plate: boolean } | null {
  const w = payment?.waitLogo;
  const url = w?.media?.url;
  if (!url) return null;
  return { url, plate: w?.style === 'plate' };
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
  /**
   * "בון מטבח במדפסת הקיוסק" (off by default, the server's kiosk_config.py): the kiosk's own printer
   * may take its kitchen bon — when it has no kitchen printer, or the one bon printer named is its
   * own. Off: the bon never prints on the kiosk (a kitchen printer that does not answer keeps it).
   */
  bonOnKiosk: boolean;
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
  /** "סוללה חלשה" of any device of the shop (pos-server app/services/battery_alerts.py); absent from an older server. */
  battery?: KioskAlertRoute;
}
export const ALERT_KINDS = ['printer', 'terminal', 'help', 'battery'] as const;
export type KioskAlertKind = (typeof ALERT_KINDS)[number];
export const ALERT_TILLS: KioskAlertTills[] = ['main', 'all', 'selected'];
export const ALERT_AUDIENCES: KioskAlertAudience[] = ['everyone', 'managers'];

/**
 * "הנפשות ומעברים" (config `motion`): one choice per transition, each style's preset choosing
 * (KIOSK_UI_PRESET_MOTION); `general.reduceMotion` turns all of them off (transitionSpec).
 * The server's MOTION_* (app/services/kiosk_config.py) and the till's KioskMotionConfig.
 */
export type CategorySwitchFx = 'slide' | 'fade' | 'fade_scale' | 'push' | 'none';
export type ItemsEnterFx = 'pop' | 'cascade' | 'rise' | 'flip' | 'none';
export type ScreenChangeFx = 'slide' | 'fade' | 'zoom' | 'none';
export type SheetFx = 'slide_up' | 'scale' | 'fade' | 'none';
export type AddToCartFx = 'fly' | 'bounce' | 'none';
export type MotionSpeed = 'fast' | 'normal' | 'relaxed';
export const CATEGORY_SWITCH_FX: CategorySwitchFx[] = ['slide', 'fade', 'fade_scale', 'push', 'none'];
export const ITEMS_ENTER_FX: ItemsEnterFx[] = ['pop', 'cascade', 'rise', 'flip', 'none'];
export const SCREEN_CHANGE_FX: ScreenChangeFx[] = ['slide', 'fade', 'zoom', 'none'];
export const SHEET_FX: SheetFx[] = ['slide_up', 'scale', 'fade', 'none'];
export const ADD_TO_CART_FX: AddToCartFx[] = ['fly', 'bounce', 'none'];
export const MOTION_SPEEDS: MotionSpeed[] = ['fast', 'normal', 'relaxed'];
/**
 * "אפקטים" (`motion.effects`; the server's MOTION_EFFECTS, the till's KioskPerfRules.EFFECTS):
 * "auto" — the device decides (the till by its strength; the web kiosks by prefers-reduced-motion
 * and a short slow-frame probe), "full" — every effect, "light" — the cheaper variant of each
 * (kioskRenderProfile, lightenMotion). Not a style's choice: no preset sets it.
 */
export type MotionEffects = 'auto' | 'full' | 'light';
export const MOTION_EFFECTS: MotionEffects[] = ['auto', 'full', 'light'];

export interface KioskMotionSettings {
  /** The dishes' grid when the customer picks another category (one category at a time). */
  categorySwitch: CategorySwitchFx;
  /** The cards of the category coming in. */
  itemsEnter: ItemsEnterFx;
  /** attract → service → catalog → basket → details → pay → done. */
  screenChange: ScreenChangeFx;
  /** The dish's window, the upsell window and the other dialogs. */
  sheet: SheetFx;
  /** "fly": the pop-and-fly into the basket; "bounce": only the basket button bounces. */
  addToCart: AddToCartFx;
  /** Scales every duration above (fast 0.75, normal 1, relaxed 1.35). */
  speed: MotionSpeed;
  /** "אפקטים": everything, the cheaper variant of each, or the device decides (MotionEffects). */
  effects: MotionEffects;
}

/**
 * "כיתוב רץ" (config `ticker`): a slim strip whose texts scroll without end, on the chosen
 * screens — under the header or above the basket / action bar. The server's TICKER_* and
 * KIOSK ticker schema (app/services/kiosk_config.py) and the till's domain/KioskTicker.kt.
 */
export const TICKER_SCREENS = ['attract', 'service', 'catalog', 'cart', 'details', 'pay', 'success'] as const;
export type TickerScreen = (typeof TICKER_SCREENS)[number];
export type TickerPosition = 'top' | 'bottom';
export const TICKER_POSITIONS: TickerPosition[] = ['top', 'bottom'];
export type TickerSpeed = 'slow' | 'normal' | 'fast';
export const TICKER_SPEEDS: TickerSpeed[] = ['slow', 'normal', 'fast'];
export type TickerSize = 's' | 'm' | 'l';
export const TICKER_SIZES: TickerSize[] = ['s', 'm', 'l'];

export interface KioskTickerItem {
  /** 1–40 of A-Z a-z 0-9 _ - ("t1", "t2", …). */
  id: string;
  text: string;
  enabled: boolean;
  /** "HH:MM": shown from this time of day; null — from midnight. A `to` before it runs past midnight. */
  from: string | null;
  /** "HH:MM": shown until this time of day; null — until midnight. */
  to: string | null;
  /** The days it shows (0 = Sunday … 6 = Saturday); a window past midnight belongs to the day it starts. */
  days: number[];
  /** ISO date-times, as a message's: shown from / until (null: no limit). */
  startsAt: string | null;
  endsAt: string | null;
}

export interface KioskTicker {
  enabled: boolean;
  /** The texts, in order, separated by a bullet on the strip. */
  items: KioskTickerItem[];
  screens: TickerScreen[];
  /** "top": under the screen's header; "bottom": above its basket / action bar. */
  position: TickerPosition;
  /** TICKER_SPEED_PX; slow by default, so it reads. */
  speed: TickerSpeed;
  /** null: the theme's (the button colour, its text colour on it). */
  backgroundColor: string | null;
  textColor: string | null;
  size: TickerSize;
  /** A finger on the strip holds it still until it lifts. */
  pauseOnTouch: boolean;
}

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
  motion: KioskMotionSettings;
  /** "כיתוב רץ". */
  ticker: KioskTicker;
  /** "מבנה הקיוסק" (kioskLayout.ts): where things sit and how the order goes; standard = today. */
  layout: KioskLayout;
  /**
   * Every customer text in the other languages (kioskTexts.ts): `textsByLang[lang][key]`; the
   * kiosk's first language keeps using the flat `texts` (an older kiosk reads only those).
   */
  textsByLang: KioskTextsByLang;
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
  tickerItemsMax: 20,
  tickerTextMax: 200,
} as const;

/** What a kiosk gets when no level sets anything — the server's defaults, key for key. */
export const KIOSK_DEFAULTS: KioskConfig = {
  general: {
    fulfillmentMode: 'BON',
    serviceTypes: ['take_away', 'eat_in'],
    serviceMode: 'types',
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
    renderer: 'native',
    servicePlacement: 'after_start',
    serviceSelect: 'confirm',
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
      visible: true,
      touchHint: true,
    },
    // "ברוכים הבאים": the block of today (bottom, start, l, black, on its scrim).
    welcome: { ...KIOSK_WELCOME_DEFAULTS },
  },
  catalog: {
    categoryOrder: [],
    hiddenCategories: [],
    productOrder: {},
    hiddenProducts: [],
    categoryImages: {},
    featuredProductIds: [],
    oneCategory: true,
    categoryIconIds: {},
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
    tipOther: true,
    checkoutSteps: ['tip', 'details', 'payMethod'],
    cashAtTillExpiryMin: 30,
    cashAtTillKitchenBeforePay: false,
    waitLogo: { media: null, style: 'plain' },
    stepModes: { ...STEP_MODE_DEFAULTS },
  },
  printing: {
    bonMode: 'routing',
    bonPrinterId: null,
    bonCopies: 1,
    receiptPrinterId: null,
    pickupSlip: true,
    bonAutoRetryMin: 10,
    bonOnKiosk: false,
  },
  pickup: { scope: 'kiosk', prefix: '', start: 1, max: 999 },
  timers: { inactivitySec: 60, warningSec: 20, successSec: 12, attractSlideSec: 8 },
  club: { enabled: false, joinUrl: '', title: '', body: '' },
  operations: { autoCloseAt: '', pausedTitle: '', pausedBody: '', closeWithShopZ: false },
  alerts: {
    printer: { tills: 'main', machineIds: [], audience: 'everyone' },
    terminal: { tills: 'main', machineIds: [], audience: 'everyone' },
    help: { tills: 'main', machineIds: [], audience: 'everyone', clearAfterMin: 10 },
    battery: { tills: 'main', machineIds: [], audience: 'everyone' },
  },
  upsell: { maxShown: 2 },
  success: { message: '', image: null },
  // The "wolt" style's (KIOSK_UI_PRESET_MOTION): the category slides in, its dishes pop in one after another.
  // "אפקטים": the device decides.
  motion: { categorySwitch: 'slide', itemsEnter: 'cascade', screenChange: 'slide', sheet: 'scale', addToCart: 'fly', speed: 'normal', effects: 'auto' },
  // "כיתוב רץ": off; once on, on the menu and the basket, under the header, slowly.
  ticker: {
    enabled: false,
    items: [],
    screens: ['catalog', 'cart'],
    position: 'top',
    speed: 'slow',
    backgroundColor: null,
    textColor: null,
    size: 'm',
    pauseOnTouch: false,
  },
  // "מבנה הקיוסק": standard — the layout of today (kioskLayout.ts).
  layout: { ...KIOSK_LAYOUT_DEFAULTS, nameAvatars: [] },
  // Every customer text in the other languages; the first language is `texts`.
  textsByLang: {},
};

const GF ='https://raw.githubusercontent.com/google/fonts/main/ofl';

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

export const UI_STYLES: UiStyle[] = ['ios', 'wolt', 'classic', 'minimal_dark', 'tech'];

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
  // "טכנולוגי": near-black, one electric accent (the brand colour; dark words on it everywhere),
  // a semi-tone surface for the panels, 1 dp outlines instead of shadows, sharp corners. Its grid,
  // status line, figures and micro-motion are its chrome (kioskChrome).
  tech: {
    mode: 'dark', font: 'heebo',
    primaryColor: '#22E1FF', accentColor: '#22E1FF',
    backgroundColor: '#0B0F14', surfaceColor: '#111821', textColor: '#E6EDF3',
    cornerRadius: 10, cardStyle: 'outlined', buttonShape: 'rounded',
    gridDensity: 'comfortable', imageRatio: '4:3',
    categoryStyle: 'tabs', categoryLayout: 'side',
    typeScale: 'normal', typeWeight: 'regular',
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
  // Crisp and still: the attract screen's idle motion is the style's scan line (kioskChrome).
  tech: {
    size: 'l', position: 'bottom_center', fontSize: 22, fontWeight: 'bold',
    shadow: false, icon: 'arrow', iconPosition: 'end', animation: 'none',
    borderColor: null, borderWidth: 0,
  },
};

/** The "הנפשות ומעברים" keys a style decides (unless a layer sets them): all but "אפקטים" (the device's). */
export const PRESET_MOTION_KEYS = ['categorySwitch', 'itemsEnter', 'screenChange', 'sheet', 'addToCart', 'speed'] as const;
export type PresetMotionKey = (typeof PRESET_MOTION_KEYS)[number];
export type UiPresetMotion = Pick<KioskMotionSettings, PresetMotionKey>;

/**
 * Each style's transitions — the server's UI_PRESET_MOTION and the till's KioskMotionConfig.PRESETS.
 * In every style the category's grid moves and its dishes pop in (the owner's request); the
 * add-to-cart stays the pop-and-fly everywhere (docs/SPEC_KIOSK.md §18), at normal speed (the owner: slow
 * enough to see the motion).
 */
export const KIOSK_UI_PRESET_MOTION: Record<UiStyle, UiPresetMotion> = {
  ios: { categorySwitch: 'slide', itemsEnter: 'pop', screenChange: 'slide', sheet: 'slide_up', addToCart: 'fly', speed: 'normal' },
  wolt: { categorySwitch: 'slide', itemsEnter: 'cascade', screenChange: 'slide', sheet: 'scale', addToCart: 'fly', speed: 'normal' },
  classic: { categorySwitch: 'push', itemsEnter: 'pop', screenChange: 'fade', sheet: 'scale', addToCart: 'fly', speed: 'normal' },
  minimal_dark: { categorySwitch: 'fade_scale', itemsEnter: 'cascade', screenChange: 'fade', sheet: 'fade', addToCart: 'fly', speed: 'normal' },
  // Crisp and cheap: opacity for the screens and the category, the cards in one after another.
  tech: { categorySwitch: 'fade', itemsEnter: 'cascade', screenChange: 'fade', sheet: 'scale', addToCart: 'fly', speed: 'normal' },
};

/** Where a style decides values: the theme's keys, the attract button's and the transitions. */
const PRESET_SECTIONS: Array<{
  path: 'theme' | 'attract.cta' | 'motion';
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
  {
    path: 'motion',
    keys: PRESET_MOTION_KEYS,
    table: KIOSK_UI_PRESET_MOTION as unknown as Record<UiStyle, Record<string, unknown>>,
    defaults: KIOSK_DEFAULTS.motion as unknown as Record<string, unknown>,
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

/** A style's preset as a layer: its theme keys, its attract button and its transitions (a null leaves the default). */
export function presetLayer(style: UiStyle): KioskLayer {
  return {
    theme: cloneJson(KIOSK_UI_PRESETS[style] ?? KIOSK_UI_PRESETS.wolt),
    attract: { cta: cloneJson(KIOSK_UI_PRESET_CTA[style] ?? KIOSK_UI_PRESET_CTA.wolt) },
    motion: cloneJson(KIOSK_UI_PRESET_MOTION[style] ?? KIOSK_UI_PRESET_MOTION.wolt),
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
  payment.methods = kioskPayMethods(payment.methods);
  // "איך תרצו לשלם?" is always the last step, right before the payment.
  payment.checkoutSteps = [...(payment.checkoutSteps ?? []).filter((st) => st !== 'payMethod'), 'payMethod'];
  if (payment.tipEnabled && (payment.tipPresets ?? []).length === 0) payment.tipPresets = [...KIOSK_DEFAULTS.payment.tipPresets];
  if (hours.enabled && (hours.ranges ?? []).length === 0) hours.enabled = false;
  // "התראות לקופות": a chosen list left empty by a parent's change goes to the main till.
  for (const kind of ALERT_KINDS) {
    const route = out.alerts?.[kind];
    if (route && route.tills === 'selected' && (route.machineIds ?? []).length === 0) route.tills = 'main';
  }
  // "מבנה הקיוסק": its cross-field rules, and theme.categoryLayout / cartStyle for an older kiosk.
  if (out.layout) repairLayout(out);
  return out;
}

/**
 * What a kiosk gets from stored layers, as the server resolves it: DEFAULTS ⊕ the style's
 * preset ⊕ the layout's template (kioskLayout.ts) ⊕ the layers (company → shop → kiosk),
 * repaired. Explicit values beat the preset and the template.
 */
export function resolveKioskConfig(...layers: Array<KioskLayer | null | undefined>): KioskConfig {
  const current = layers.map(withoutRetired);
  return repairKioskConfig(deepMergeKiosk(KIOSK_DEFAULTS, presetLayer(styleOf(...current)), layoutTemplateLayer(templateOf(...current)), ...current));
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
  checkEnum(e, 'general.renderer', g.renderer, KIOSK_RENDERERS);
  checkEnum(e, 'general.serviceMode', g.serviceMode, SERVICE_MODES);
  checkEnum(e, 'general.servicePlacement', g.servicePlacement, SERVICE_PLACEMENTS);
  checkEnum(e, 'general.serviceSelect', g.serviceSelect, SERVICE_SELECTS);
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
    // Any text of the registry (kioskTexts.ts) may be set for the first language too.
    if (!(TEXT_KEYS as readonly string[]).includes(key) && !isKioskTextKey(key)) {
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
    if (typeof cta.visible !== 'boolean') e.push({ path: `${p}.visible`, code: 'enum' });
    if (typeof cta.touchHint !== 'boolean') e.push({ path: `${p}.touchHint`, code: 'enum' });
    // A hidden button: only the whole screen can start an order.
    if (cta.visible === false && cta.tapAnywhere !== true) e.push({ path: `${p}.tapAnywhere`, code: 'tapAnywhereRequired' });
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
  // A category's icon from the built-in set (kioskIcons.ts).
  e.push(...validateCategoryIconIds(c.categoryIconIds));

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
  else if (pay.methods.some((m) => !(PAYMENT_METHODS as readonly string[]).includes(m))) e.push({ path: 'payment.methods', code: 'enum' });
  else if (!uniq(pay.methods)) e.push({ path: 'payment.methods', code: 'duplicate' });
  else if (pay.methods.includes('voucher') && !pay.methods.some((m) => (REMAINDER_METHODS as readonly string[]).includes(m))) {
    e.push({ path: 'payment.methods', code: 'voucher_needs_method' });
  }
  if (pay.cashAtTillExpiryMin !== undefined && (!isInt(pay.cashAtTillExpiryMin) || pay.cashAtTillExpiryMin < 5 || pay.cashAtTillExpiryMin > 240)) {
    e.push({ path: 'payment.cashAtTillExpiryMin', code: 'range', params: { min: 5, max: 240 } });
  }
  if (pay.tipPresets.length > L.tipPresetsMax) {
    e.push({ path: 'payment.tipPresets', code: 'tooMany', params: { max: L.tipPresetsMax } });
  }
  if (!uniq(pay.tipPresets)) e.push({ path: 'payment.tipPresets', code: 'duplicate' });
  if (pay.tipEnabled && pay.tipPresets.length === 0) e.push({ path: 'payment.tipPresets', code: 'tipPresetsRequired' });
  if (pay.tipPresets.some((t) => !isInt(t) || t < L.tipPreset.min || t > L.tipPreset.max)) {
    e.push({ path: 'payment.tipPresets', code: 'range', params: { min: L.tipPreset.min, max: L.tipPreset.max } });
  }
  checkEnum(e, 'payment.receiptPolicy', pay.receiptPolicy, ['always', 'ask', 'never']);
  if (pay.waitLogo !== undefined) {
    checkMedia(e, 'payment.waitLogo.media', pay.waitLogo?.media ?? null, ['image']);
    checkEnum(e, 'payment.waitLogo.style', pay.waitLogo?.style, WAIT_LOGO_STYLES);
  }
  checkEnum(e, 'payment.customerName', pay.customerName, ['off', 'optional', 'required']);
  checkEnum(e, 'payment.customerPhone', pay.customerPhone, ['off', 'optional', 'required']);
  if (!isInt(pay.minOrderAgorot) || pay.minOrderAgorot < 0) e.push({ path: 'payment.minOrderAgorot', code: 'nonNegative' });
  checkEnum(e, 'payment.tableNumber', pay.tableNumber, ['off', 'optional', 'required']);
  checkEnum(e, 'payment.detailsStep', pay.detailsStep, DETAILS_STEPS);
  if (!Array.isArray(pay.checkoutSteps) || pay.checkoutSteps.some((s) => !(CHECKOUT_STEPS as readonly string[]).includes(s))) {
    e.push({ path: 'payment.checkoutSteps', code: 'enum' });
  } else if (!uniq(pay.checkoutSteps)) e.push({ path: 'payment.checkoutSteps', code: 'duplicate' });
  // "חובה / רשות / כבוי" per step (STEP_MODE_KEYS), as the server's schema checks it.
  if (pay.stepModes !== undefined) {
    if (!isDict(pay.stepModes)) e.push({ path: 'payment.stepModes', code: 'enum' });
    else {
      for (const [key, mode] of Object.entries(pay.stepModes)) {
        if (!(STEP_MODE_KEYS as readonly string[]).includes(key)) e.push({ path: `payment.stepModes.${key}`, code: 'enum' });
        else checkEnum(e, `payment.stepModes.${key}`, mode, ['off', 'optional', 'required']);
      }
    }
  }

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
  if (typeof pr.bonOnKiosk !== 'boolean') e.push({ path: 'printing.bonOnKiosk', code: 'enum' });

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

  // "הנפשות ומעברים": one known choice per transition.
  const mo = cfg.motion;
  if (mo !== undefined) {
    if (!isDict(mo)) e.push({ path: 'motion', code: 'enum' });
    else {
      checkEnum(e, 'motion.categorySwitch', mo.categorySwitch, CATEGORY_SWITCH_FX);
      checkEnum(e, 'motion.itemsEnter', mo.itemsEnter, ITEMS_ENTER_FX);
      checkEnum(e, 'motion.screenChange', mo.screenChange, SCREEN_CHANGE_FX);
      checkEnum(e, 'motion.sheet', mo.sheet, SHEET_FX);
      checkEnum(e, 'motion.addToCart', mo.addToCart, ADD_TO_CART_FX);
      checkEnum(e, 'motion.speed', mo.speed, MOTION_SPEEDS);
      checkEnum(e, 'motion.effects', mo.effects, MOTION_EFFECTS);
    }
  }

  // "כיתוב רץ": its texts, their days and hours, the screens and the look.
  if (cfg.ticker !== undefined) validateTicker(e, cfg.ticker);

  // "מבנה הקיוסק" and "ברוכים הבאים" (kioskLayout.ts); every text in every language (kioskTexts.ts).
  e.push(...validateLayout(cfg));
  e.push(...validateKioskTexts(cfg));

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

/* ------------------------------------------ the steps before the payment */
// The till's domain/KioskCheckoutSteps.kt and KioskServiceLook.kt, the same rules and numbers.

/**
 * The configured order of the checkout steps: the known ones as given (each once), then the missing
 * ones in the default order — "איך תרצו לשלם?" (payMethod) always last, right before the payment.
 */
export function checkoutStepOrder(steps: readonly unknown[] | null | undefined): CheckoutStep[] {
  const out: CheckoutStep[] = [];
  for (const s of Array.isArray(steps) ? steps : []) {
    if ((CHECKOUT_STEPS as readonly unknown[]).includes(s) && !out.includes(s as CheckoutStep)) out.push(s as CheckoutStep);
  }
  for (const s of CHECKOUT_STEPS) if (!out.includes(s)) out.push(s);
  return [...out.filter((s) => s !== 'payMethod'), 'payMethod'];
}

/**
 * `payment.methods` as a kiosk takes it (the till's KioskPayMethod.parseList, the cloud's repair):
 * the known ones in order, each once; a voucher never alone (the card beside it); none → the card.
 */
export function kioskPayMethods(methods: readonly unknown[] | null | undefined): PaymentMethod[] {
  const out: PaymentMethod[] = [];
  for (const m of Array.isArray(methods) ? methods : []) {
    if ((PAYMENT_METHODS as readonly unknown[]).includes(m) && !out.includes(m as PaymentMethod)) out.push(m as PaymentMethod);
  }
  return out.some((m) => (REMAINDER_METHODS as readonly string[]).includes(m)) ? out : ['card', ...out];
}

/** "איך תרצו לשלם?" is asked: more than one method — or the only one is not the card (cash at the till alone). */
export function kioskAsksPayMethod(methods: readonly unknown[] | null | undefined): boolean {
  const m = kioskPayMethods(methods);
  return m.length > 1 || m[0] !== 'card';
}

/** "איך תרצו לשלם?" on one device: asked, passable ("רשות"), and the method taken when it is not asked or passed. */
export interface PayMethodAsk {
  asks: boolean;
  /** "רשות": the step has "המשך" that takes `fallback`. */
  optional: boolean;
  /** The method of an order whose step is not asked (or passed): the card when this device can charge it, else the first that pays. */
  fallback: PaymentMethod | null;
}

/**
 * "איך תרצו לשלם?" on a device that can take `usable` of the configured `methods` now (the card through
 * its terminal, a voucher online, cash at the till), by the step's mode (`stepMode(cfg, 'payMethod')`;
 * the Android kiosk's KioskCheckoutSteps.asksPayMethod):
 *  - nothing it can sell with (a voucher never pays for sure): not asked;
 *  - the card the only method configured, and usable: straight to the pinpad;
 *  - "כבוי": the card charged without asking when it is offered and usable — else there is nothing to
 *    charge without asking, and the step is asked as "חובה";
 *  - "רשות": asked, and may be passed with the fallback; "חובה": asked, a choice made.
 */
export function payMethodAsk(methods: readonly PaymentMethod[], usable: readonly PaymentMethod[], mode: CustomerFieldMode): PayMethodAsk {
  const card = methods.includes('card') && usable.includes('card');
  const pays = usable.filter((m) => m !== 'voucher' && methods.includes(m));
  const fallback: PaymentMethod | null = card ? 'card' : (pays[0] ?? null);
  if (fallback === null) return { asks: false, optional: false, fallback: null };
  if (card && methods.length === 1) return { asks: false, optional: false, fallback };
  if (mode === 'off') return card ? { asks: false, optional: false, fallback } : { asks: true, optional: false, fallback };
  return { asks: true, optional: mode === 'optional', fallback };
}

/** Left to pay after the vouchers, in agorot: the order and its tip less them, never below zero. */
export function kioskRemainderAgorot(goodsAgorot: number, tipAgorot: number, voucherAgorot: readonly number[]): number {
  const vouchers = voucherAgorot.reduce((sum, v) => sum + Math.max(0, Math.trunc(v)), 0);
  return Math.max(0, Math.trunc(goodsAgorot) + Math.trunc(tipAgorot) - vouchers);
}

/** The tip is asked before the payment: on, with something to choose (a preset, or "סכום אחר"). */
export function kioskTipAsked(payment: Pick<KioskPayment, 'tipEnabled' | 'tipPresets' | 'tipOther'>): boolean {
  return !!payment.tipEnabled && ((payment.tipPresets?.length ?? 0) > 0 || payment.tipOther !== false);
}

export interface StepModeConfigIn {
  general: Partial<Pick<KioskGeneral, 'serviceTypes' | 'serviceMode' | 'upsellEnabled'>>;
  payment: Partial<Pick<KioskPayment, 'tipEnabled' | 'tipPresets' | 'tipOther' | 'methods' | 'stepModes' | 'customerName' | 'customerPhone' | 'tableNumber'>>;
}

/**
 * A step's effective "חובה / רשות / כבוי": its own switch first — one service type, tips off, the
 * card alone, upsell off → off — then its mode (`payment.stepModes`, or the customer field's own).
 * The server's kiosk_config.step_mode and the till's KioskStepModes.of, the same rule.
 */
export function stepMode(cfg: StepModeConfigIn, key: StepModeKey | 'customerName' | 'customerPhone' | 'tableNumber'): CustomerFieldMode {
  const pay = cfg.payment ?? {};
  const valid = (m: unknown): m is CustomerFieldMode => m === 'off' || m === 'optional' || m === 'required';
  if (key === 'customerName' || key === 'customerPhone' || key === 'tableNumber') {
    const m = pay[key];
    return valid(m) ? m : 'off';
  }
  const own = pay.stepModes?.[key];
  const mode = valid(own) ? own : STEP_MODE_DEFAULTS[key];
  if (key === 'service' && ((cfg.general?.serviceTypes?.length ?? 2) <= 1 || cfg.general?.serviceMode === 'none')) return 'off';
  if (key === 'tip' && !kioskTipAsked({ tipEnabled: !!pay.tipEnabled, tipPresets: pay.tipPresets ?? [], tipOther: pay.tipOther !== false })) return 'off';
  if (key === 'payMethod' && !kioskAsksPayMethod(pay.methods)) return 'off';
  if (key.startsWith('upsell') && cfg.general?.upsellEnabled === false) return 'off';
  return mode;
}

/**
 * The designer's "סוג שירות" (4 choices): "שואלים" (both types — their order is the buttons'),
 * "תמיד טייק אווי" / "תמיד ישיבה במקום" (one type: never asked, every order is it — and says it),
 * "ללא" (serviceMode none: never asked, no service at all).
 */
export type ServiceChoice = 'ask' | 'take_away' | 'eat_in' | 'none';
export const SERVICE_CHOICES: ServiceChoice[] = ['ask', 'take_away', 'eat_in', 'none'];

/** The choice a config's `serviceTypes` / `serviceMode` make. */
export function serviceChoiceOf(g: Partial<Pick<KioskGeneral, 'serviceTypes' | 'serviceMode'>> | null | undefined): ServiceChoice {
  if (g?.serviceMode === 'none') return 'none';
  const list = (Array.isArray(g?.serviceTypes) ? g.serviceTypes : []).filter((v) => SERVICE_TYPES.includes(v));
  if (list.length > 1) return 'ask';
  return list[0] === 'eat_in' ? 'eat_in' : 'take_away';
}

/**
 * The fields a choice writes. "ללא" keeps `serviceTypes` as it was (back to "שואלים" finds the
 * buttons' order again); "שואלים" keeps the order it had, else the one type first.
 */
export function serviceChoicePatch(
  g: Partial<Pick<KioskGeneral, 'serviceTypes' | 'serviceMode'>> | null | undefined,
  choice: ServiceChoice,
): Pick<KioskGeneral, 'serviceTypes' | 'serviceMode'> {
  const list = (Array.isArray(g?.serviceTypes) ? g.serviceTypes : []).filter((v) => SERVICE_TYPES.includes(v));
  if (choice === 'none') return { serviceTypes: list.length > 0 ? list : ['take_away'], serviceMode: 'none' };
  if (choice === 'ask') {
    const first = list[0] ?? 'take_away';
    return { serviceTypes: list.length > 1 ? list : [first, ...SERVICE_TYPES.filter((x) => x !== first)], serviceMode: 'types' };
  }
  return { serviceTypes: [choice], serviceMode: 'types' };
}

/** The step's default answer when it is passed ("optional") or off: the first service type, no tip, the first method that pays. */
export function stepDefaultService(serviceTypes: readonly string[] | null | undefined): 'take_away' | 'eat_in' {
  const first = (serviceTypes ?? [])[0];
  return first === 'eat_in' ? 'eat_in' : 'take_away';
}

/**
 * The step mode an upsell window answers to, by its moment: an item just added → upsellItem; the
 * way to payment ("to_pay", the menu's "בכל הזמנה") → upsellCheckout; any other step → upsellSteps.
 */
export function upsellStepModeKey(moment: { kind: string; code?: string }): StepModeKey {
  if (moment.kind === 'step') return moment.code === 'to_pay' ? 'upsellCheckout' : 'upsellSteps';
  return 'upsellItem';
}

/**
 * The steps between the basket and the payment for this order, in the configured order: the tip
 * when it is asked; the details when they are asked (`detailsAsked`) before the payment — or, set
 * for an earlier step, not given yet (`detailsDone`). Details asked after the payment never come here.
 */
export function checkoutStepsNow(
  payment: Pick<KioskPayment, 'tipEnabled' | 'tipPresets' | 'tipOther' | 'detailsStep' | 'checkoutSteps'> & { methods?: readonly string[]; stepModes?: KioskPayment['stepModes'] },
  detailsAsked: boolean,
  detailsDone: boolean,
): CheckoutStep[] {
  const details = detailsAsked && (payment.detailsStep === 'before_pay' || (payment.detailsStep !== 'after_pay' && !detailsDone));
  // "חובה / רשות / כבוי": a step set off is never asked (stepMode).
  const tip = kioskTipAsked(payment) && payment.stepModes?.tip !== 'off';
  const method = kioskAsksPayMethod(payment.methods) && payment.stepModes?.payMethod !== 'off';
  return checkoutStepOrder(payment.checkoutSteps).filter((s) => (s === 'tip' ? tip : s === 'details' ? details : method));
}

export type CheckoutBarKey = 'review' | CheckoutStep | 'pay';
export interface CheckoutBarItem {
  key: CheckoutBarKey;
  /** Its words: texts.stepReview / stepTip / stepDetails / stepPay. */
  textKey: KioskTextKey;
  state: 'done' | 'current' | 'next';
}

const CHECKOUT_BAR_TEXT: Record<CheckoutBarKey, KioskTextKey> = {
  review: 'stepReview', tip: 'stepTip', details: 'stepDetails', payMethod: 'stepPayMethod', pay: 'stepPay',
};

/** The step bar ("ההזמנה שלכם ✓ · טיפ לצוות · תשלום"): the review done, this order's steps, the payment. */
export function checkoutBar(steps: readonly CheckoutStep[], current: CheckoutStep): CheckoutBarItem[] {
  const at = steps.indexOf(current);
  return [
    { key: 'review', textKey: CHECKOUT_BAR_TEXT.review, state: 'done' },
    ...steps.map((s, i): CheckoutBarItem => ({ key: s, textKey: CHECKOUT_BAR_TEXT[s], state: i < at ? 'done' : i === at ? 'current' : 'next' })),
    { key: 'pay', textKey: CHECKOUT_BAR_TEXT.pay, state: 'next' },
  ];
}

/** A preset's tip on the order's total: the percent, rounded to the agora, half up (the till's KioskCustomer.tipOf). */
export function tipPercentAgorot(goodsAgorot: number, percent: number | null | undefined): number {
  if (!percent || percent <= 0 || !(goodsAgorot > 0)) return 0;
  return Math.floor((goodsAgorot * percent + 50) / 100);
}

/** "סכום אחר": at most this many shekels (and never more than the order). */
export const TIP_OTHER_MAX_SHEKELS = 999;

/** "סכום אחר" as typed on the digits pad: whole shekels, 1 … the order's total; null when it is not one. */
export function tipOtherAgorot(typed: string, goodsAgorot: number): number | null {
  const s = typed.trim();
  if (!/^\d{1,4}$/.test(s)) return null;
  const shekels = Number(s);
  if (shekels < 1 || shekels > TIP_OTHER_MAX_SHEKELS || shekels * 100 > goodsAgorot) return null;
  return shekels * 100;
}

export interface KioskServiceLook {
  /** The fill from the top (wolt: the top-left corner) to the bottom; equal for a flat one. */
  from: string;
  to: string;
  diagonal: boolean;
  /** The label. */
  ink: string;
  /** The round badge behind the icon ("#RRGGBBAA" where translucent). */
  badge: string;
  icon: string;
  /** minimal_dark: a ring in the brand colour. */
  border: string | null;
}

/**
 * "איך תרצו לקבל את ההזמנה?": the two choices' colours by UI style (the till's KioskServiceLook):
 * ios a soft tint with the icon on a brand badge; wolt the brand-to-accent sweep; classic a flat
 * bold fill; minimal_dark its own surface ringed in the brand colour; tech its semi-tone panel
 * outlined in the accent, the icon on a faint accent badge. The words always read (3:1).
 */
export function kioskServiceLook(
  theme: Pick<KioskTheme, 'uiStyle' | 'primaryColor' | 'accentColor'>,
  colors: Pick<ResolvedThemeColors, 'surface' | 'text'>,
): KioskServiceLook {
  const p = mixHex(theme.primaryColor, theme.primaryColor, 0);
  const surface = mixHex(colors.surface, colors.surface, 0);
  const text = mixHex(colors.text, colors.text, 0);
  const inkOn = (from: string, to: string) =>
    Math.min(contrastRatio('#FFFFFF', from), contrastRatio('#FFFFFF', to)) >= REST_LARGE_TEXT_CONTRAST ? '#FFFFFF' : REST_DARK_INK;
  const alpha = (hex: string, a: number) => hex + a.toString(16).padStart(2, '0').toUpperCase();
  const filled = (from: string, to: string, diagonal: boolean): KioskServiceLook => {
    const ink = inkOn(from, to);
    return { from, to, diagonal, ink, badge: alpha(ink, 0x33), icon: ink, border: null };
  };
  switch (theme.uiStyle) {
    case 'ios': {
      const tint = mixHex(surface, p, 0.12);
      return { from: tint, to: tint, diagonal: false, ink: text, badge: p, icon: inkOn(p, p), border: null };
    }
    case 'classic':
      return filled(p, p, false);
    case 'minimal_dark':
      return { from: surface, to: surface, diagonal: false, ink: text, badge: alpha(p, 0x2e), icon: contrastRatio(p, surface) >= REST_LARGE_TEXT_CONTRAST ? p : text, border: p };
    case 'tech':
      return { from: surface, to: surface, diagonal: false, ink: text, badge: alpha(p, 0x1f), icon: contrastRatio(p, surface) >= REST_LARGE_TEXT_CONTRAST ? p : text, border: p };
    default:
      return filled(p, mixHex(mixHex(p, theme.accentColor, 0.5), '#000000', 0.18), true);
  }
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

/**
 * The add never takes longer (the till's KioskMotion.ADD_MAX_MS): ~560 ms at normal speed (the
 * owner, 07.10.2026: seen, but never slow), under a second at "relaxed".
 */
export const ADD_MAX_MS = 1000;
export const ADD_POP_LIFT_DP = 18;
export const ADD_END_SCALE = 0.25;
export const ADD_END_ALPHA = 0.15;
const ADD_FADE_FROM = 0.55;
/** The pop-and-fly at normal speed (the till's KioskMotion.of; kiosk_motion_timings.json "add"): ~560 ms, the total counting in 360. */
export const ADD_LIVELY: MotionSpec = { popMs: 160, popScale: 1.45, flyMs: 400, arcDp: 170, fadeMs: 0, bounce: 1.25, countUpMs: 360 };
export const ADD_SUBTLE: MotionSpec = { popMs: 150, popScale: 1.3, flyMs: 380, arcDp: 110, fadeMs: 0, bounce: 1.12, countUpMs: 300 };

/**
 * The add-to-cart motion by `theme.animation` (the till's KioskMotion, docs/SPEC_KIOSK.md §18):
 * the same pop-and-fly in every UI style — the style sets only how big the pop and how high the
 * arc; `general.reduceMotion` turns it into a short fade, with no bounce and no counting.
 * `motion.addToCart` ("הוספה לסל"): "fly" as above, "bounce" only the basket button, "none"
 * nothing; `motion.speed` scales it (the flight still under ADD_MAX_MS).
 */
export function motionSpec(
  theme: Pick<KioskTheme, 'animation'>,
  general: Pick<KioskGeneral, 'reduceMotion'>,
  motion?: Partial<Pick<KioskMotionSettings, 'addToCart' | 'speed'>> | null,
): MotionSpec {
  const add = pickFx(motion?.addToCart, ADD_TO_CART_FX, 'fly');
  // "ללא": the basket just changes (with reduce motion too).
  if (add === 'none') return { popMs: 0, popScale: 1, flyMs: 0, arcDp: 0, fadeMs: 0, bounce: 0, countUpMs: 0 };
  if (general.reduceMotion) return { popMs: 0, popScale: 1, flyMs: 0, arcDp: 0, fadeMs: 280, bounce: 0, countUpMs: 0 };
  const lively = theme.animation === 'lively';
  const base: MotionSpec = lively ? { ...ADD_LIVELY } : { ...ADD_SUBTLE };
  const k = speedFactor(motion?.speed);
  // "קפיצה": no copy flies, the basket button bounces (harder) and the total counts up.
  const countUpMs = Math.round(base.countUpMs * k);
  if (add === 'bounce') return { popMs: 0, popScale: 1, flyMs: 0, arcDp: 0, fadeMs: 0, bounce: lively ? 1.4 : 1.28, countUpMs };
  // The flight keeps under ADD_MAX_MS whatever the speed.
  const f = Math.min(k, (ADD_MAX_MS - 20) / (base.popMs + base.flyMs));
  return { ...base, popMs: Math.round(base.popMs * f), flyMs: Math.round(base.flyMs * f), countUpMs };
}

/* ------------------------------------------------- "הנפשות ומעברים" */

/**
 * "מהירות": every transition's duration times this — the till's KioskTransitions.speedFactor: fast
 * three quarters of normal, relaxed a third longer (calm, never dragging).
 */
export const MOTION_SPEED_FACTOR: Record<MotionSpeed, number> = { fast: 0.75, normal: 1, relaxed: 1.35 };
/** The cascade at normal speed: the last visible card starts at most this long after the first (× the speed). */
export const STAGGER_CAP_MS = 200;
/** Only the first cards (about a screenful) are staggered; the rest come with the last of them. */
export const STAGGER_MAX_CARDS = 12;

function speedFactor(speed: unknown): number {
  return typeof speed === 'string' && speed in MOTION_SPEED_FACTOR ? MOTION_SPEED_FACTOR[speed as MotionSpeed] : 1;
}

/**
 * Each transition's own duration at normal speed (ms), the till's KioskTransitions key for key —
 * snappy (the owner, 07.10.2026: "המעברים עוברים מאוד לאט, נותנים הרגשה של איטיות"): a screen
 * ≤ 220, a category ~240 (a push 280: both screens as one strip), each card ~260 with 16–32 between
 * cards and the last one starting by 200 ms, a window ~220. The shared golden is
 * server/tests/fixtures/kiosk_motion_timings.json.
 */
export const TRANSITION_BASE_MS = {
  categorySwitch: { slide: 240, fade: 200, fade_scale: 220, push: 280, none: 0 },
  itemsEnter: { pop: 260, cascade: 260, rise: 280, flip: 300, none: 0 },
  /** The gap between one card's start and the next one's. */
  stagger: { pop: 16, cascade: 32, rise: 24, flip: 28, none: 0 },
  screenChange: { slide: 220, fade: 180, zoom: 200, none: 0 },
  sheet: { slide_up: 260, scale: 220, fade: 180, none: 0 },
} as const;

/**
 * The curves (CSS; the till's KioskEase): arrivals decelerate — off the mark at once, a short soft
 * landing (no long crawl at the end, which read as lag); leaving accelerates away and is gone by
 * the end; a push moves both screens on one curve, as a strip. The pop's rise and settle are its
 * own (kItemPop). Never linear.
 */
export const EASE_ENTER = 'cubic-bezier(.2,.7,.2,1)';
export const EASE_EXIT = 'cubic-bezier(.4,0,1,1)';
export const EASE_STRIP = 'cubic-bezier(.3,0,.2,1)';
export const EASE_POP_RISE = 'cubic-bezier(.22,1,.36,1)';
export const EASE_POP_SETTLE = 'cubic-bezier(.45,0,.55,1)';

/* -------------------------------------------- "אפקטים": the render profile */
// The till's domain/KioskPerf.kt (KioskMotionConfig.lightened, KioskFrameVerdict), the same rules.

export type KioskRenderProfile = 'full' | 'light';

/**
 * The light profile's transitions (the till's KioskMotionConfig.lightened): every screen, category
 * and window fades ("none" stays none), no cascade of cards, at the fast pace. The add keeps its kind.
 */
export function lightenMotion<T extends Partial<KioskMotionSettings>>(motion: T): T {
  const fade = <F extends string>(v: F | undefined): F | 'fade' | undefined => (v === 'none' ? v : 'fade');
  return {
    ...motion,
    categorySwitch: fade(motion.categorySwitch),
    itemsEnter: 'none',
    screenChange: fade(motion.screenChange),
    sheet: fade(motion.sheet),
    speed: 'fast',
  } as T;
}

/** A web kiosk's first frames, as measured (rAF intervals) — the till's KioskFrameVerdict. */
export interface FrameVerdict {
  frames: number;
  p50Ms: number;
  p90Ms: number;
  /** The share of frames longer than FRAME_SLOW_FACTOR frame budgets. */
  slowShare: number;
  budgetMs: number;
  /** Too slow for everything: enough frames, and a quarter of them late or the slowest tenth at two budgets. */
  slow: boolean;
}

/** The probe: frames measured after a short warm-up; fewer than FRAME_MIN judge nothing. */
export const FRAME_WARMUP = 20;
export const FRAME_SAMPLE = 150;
export const FRAME_MIN = 120;
export const FRAME_SLOW_FACTOR = 1.25;
export const FRAME_SLOW_SHARE = 0.25;
export const FRAME_P90_BUDGETS = 2;

export function frameVerdict(durationsMs: readonly number[], refreshHz = 60): FrameVerdict {
  const budgetMs = 1000 / (refreshHz >= 20 && refreshHz <= 240 ? refreshHz : 60);
  const sorted = durationsMs.filter((d) => Number.isFinite(d) && d >= 0).sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return { frames: 0, p50Ms: 0, p90Ms: 0, slowShare: 0, budgetMs, slow: false };
  const p50Ms = sorted[Math.round((n - 1) * 0.5)];
  const p90Ms = sorted[Math.min(n - 1, Math.max(0, Math.ceil(n * 0.9) - 1))];
  const slowShare = sorted.filter((d) => d > budgetMs * FRAME_SLOW_FACTOR).length / n;
  const slow = n >= FRAME_MIN && (slowShare >= FRAME_SLOW_SHARE || p90Ms >= budgetMs * FRAME_P90_BUDGETS);
  return { frames: n, p50Ms, p90Ms, slowShare, budgetMs, slow };
}

/**
 * How a web kiosk draws: the config's explicit choice first ("full" / "light"); with "auto" the
 * device's prefers-reduced-motion or a slow first-frames probe make it light, else full. (The
 * dashboard's preview passes no device: "auto" previews the full look.)
 */
export function kioskRenderProfile(
  effects: unknown,
  device: { reducedMotion?: boolean; slow?: boolean | null } = {},
): KioskRenderProfile {
  if (effects === 'full') return 'full';
  if (effects === 'light') return 'light';
  return device.reducedMotion || device.slow ? 'light' : 'full';
}

/** The transitions as a profile plays them: the light one's cheaper variants (lightenMotion). */
export function profileMotion<T extends Partial<KioskMotionSettings>>(motion: T, profile: KioskRenderProfile): T {
  return profile === 'light' ? lightenMotion(motion) : motion;
}

/** The transitions as the screens play them: each effect and its duration (ms, speed applied). */
export interface TransitionSpec {
  categorySwitch: CategorySwitchFx;
  categoryMs: number;
  itemsEnter: ItemsEnterFx;
  itemMs: number;
  staggerMs: number;
  /** The last staggered card starts no later than this. */
  staggerCapMs: number;
  screenChange: ScreenChangeFx;
  screenMs: number;
  sheet: SheetFx;
  sheetMs: number;
  /** The add's kind as played (reduce motion: "none" — motionSpec then gives the short fade). */
  addToCart: AddToCartFx;
}

export const NO_TRANSITIONS: TransitionSpec = {
  categorySwitch: 'none', categoryMs: 0, itemsEnter: 'none', itemMs: 0, staggerMs: 0, staggerCapMs: 0,
  screenChange: 'none', screenMs: 0, sheet: 'none', sheetMs: 0, addToCart: 'none',
};

function pickFx<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

/**
 * "הנפשות ומעברים" resolved: `general.reduceMotion` turns every transition off; otherwise each
 * configured effect with its duration times the speed. A missing or unknown value is the default
 * style's. The till's KioskTransitions.of.
 */
export function transitionSpec(
  motion: Partial<KioskMotionSettings> | null | undefined,
  general: Pick<KioskGeneral, 'reduceMotion'>,
): TransitionSpec {
  if (general.reduceMotion) return { ...NO_TRANSITIONS };
  const d = KIOSK_DEFAULTS.motion;
  const k = speedFactor(motion?.speed);
  const ms = (n: number) => Math.round(n * k);
  const categorySwitch = pickFx(motion?.categorySwitch, CATEGORY_SWITCH_FX, d.categorySwitch);
  const itemsEnter = pickFx(motion?.itemsEnter, ITEMS_ENTER_FX, d.itemsEnter);
  const screenChange = pickFx(motion?.screenChange, SCREEN_CHANGE_FX, d.screenChange);
  const sheet = pickFx(motion?.sheet, SHEET_FX, d.sheet);
  const B = TRANSITION_BASE_MS;
  return {
    categorySwitch,
    categoryMs: ms(B.categorySwitch[categorySwitch]),
    itemsEnter,
    itemMs: ms(B.itemsEnter[itemsEnter]),
    staggerMs: ms(B.stagger[itemsEnter]),
    staggerCapMs: itemsEnter === 'none' ? 0 : ms(STAGGER_CAP_MS),
    screenChange,
    screenMs: ms(B.screenChange[screenChange]),
    sheet,
    sheetMs: ms(B.sheet[sheet]),
    addToCart: pickFx(motion?.addToCart, ADD_TO_CART_FX, d.addToCart),
  };
}

/**
 * When the card at `index` (reading order) starts entering: one stagger step after the previous,
 * the last within `staggerCapMs`; past STAGGER_MAX_CARDS (off screen) with the last one.
 */
export function staggerDelayMs(spec: Pick<TransitionSpec, 'staggerMs' | 'itemsEnter' | 'staggerCapMs'>, index: number): number {
  if (spec.itemsEnter === 'none' || spec.staggerMs <= 0 || index <= 0) return 0;
  return Math.min(Math.min(index, STAGGER_MAX_CARDS - 1) * spec.staggerMs, spec.staggerCapMs);
}

/** The whole entrance of a grid (the last card's delay and its own time). */
export function gridEnterMs(spec: Pick<TransitionSpec, 'staggerMs' | 'itemsEnter' | 'itemMs' | 'staggerCapMs'>): number {
  return spec.itemsEnter === 'none' ? 0 : staggerDelayMs(spec, STAGGER_MAX_CARDS - 1) + spec.itemMs;
}

/**
 * The side a new grid or screen comes from: +1 from the physical right, -1 from the left. Forward
 * (a later category on the rail / strip, the next screen) moves the way the customer reads —
 * from the left in Hebrew, from the right in English — backward the other way.
 */
export function swapSide(forward: boolean, rtl: boolean): 1 | -1 {
  return forward !== rtl ? 1 : -1;
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

/**
 * The next automatic opening strictly after `now`, in local time; null with no hours (the
 * till's KioskSchedule.nextOpening).
 */
export function kioskNextOpening(hours: Pick<KioskHours, 'enabled' | 'ranges'>, now: Date): Date | null {
  if (!hours.enabled) return null;
  const ranges = (hours.ranges ?? []).filter((r) => hhmmMinutes(r.open) !== null);
  if (ranges.length === 0) return null;
  for (let offset = 0; offset <= 7; offset++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
    let best: Date | null = null;
    for (const r of ranges) {
      if (!r.days.includes(day.getDay())) continue;
      const m = hhmmMinutes(r.open)!;
      const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(m / 60), m % 60);
      if (at.getTime() > now.getTime() && (best === null || at.getTime() < best.getTime())) best = at;
    }
    if (best) return best;
  }
  return null;
}

/* ------------------------------------------------ "יצאתי לנוח… תכף אשוב" */
/*
 * The kiosk's closed screen (the owner, 2026-10-07: like the till's closed-shift screen, in
 * colour, centred) — the till's domain/KioskRestText.kt, rule for rule: one screen for a pause
 * and outside the hours alike. The title: the configured one (a pause: operations.pausedTitle,
 * then texts.pausedTitle; outside the hours: texts.closedTitle), else "יצאתי לנוח…". The
 * subtitle: the message whoever paused it typed, else the configured body, else "תכף אשוב" —
 * or, outside the hours, their own "הקיוסק יחזור לפעול בשעות הפעילות.". When it is back: a
 * pause's end while still ahead; outside the hours, their next opening.
 */

export type KioskRestReason = 'paused' | 'closed';
export type KioskRestTextKey = 'pausedTitle' | 'pausedBody' | 'closedTitle' | 'closedBody';

export interface KioskRestWords {
  title: string;
  subtitle: string;
  /** When the kiosk takes orders again; null when nobody knows (a pause by hand). */
  backAt: Date | null;
  /** "HH:MM" of `backAt`, local time. */
  backClock: string | null;
  /** Calendar days from today to `backAt`: 0 today, 1 tomorrow. */
  backInDays: number | null;
  /** `backAt`'s weekday, 0 = Sunday. */
  backWeekday: number | null;
}

function cleanText(v: string | null | undefined): string | null {
  const s = typeof v === 'string' ? v.trim() : '';
  return s ? s : null;
}

/**
 * The closed screen's words. `txt`: a screen text — the configured one, else the built-in
 * (PreviewModel.txt, the kiosk's txtOf). `pause`: the cloud's pause as the kiosk has it — its
 * message and end, only while it holds (an end already past lifts it).
 */
export function kioskRestText(
  reason: KioskRestReason,
  cfg: { operations?: Partial<Pick<KioskOperations, 'pausedTitle' | 'pausedBody'>> | null; hours: Pick<KioskHours, 'enabled' | 'ranges'> },
  pause: { message?: string | null; until?: string | null },
  txt: (key: KioskRestTextKey) => string,
  now: Date,
): KioskRestWords {
  const word = (key: KioskRestTextKey) => cleanText(txt(key)) ?? '';
  let title: string;
  let subtitle: string;
  let backAt: Date | null;
  if (reason === 'paused') {
    const untilMs = pause.until ? Date.parse(pause.until) : NaN;
    const lifted = Number.isFinite(untilMs) && untilMs <= now.getTime();
    title = cleanText(cfg.operations?.pausedTitle) ?? word('pausedTitle');
    subtitle = (lifted ? null : cleanText(pause.message)) ?? cleanText(cfg.operations?.pausedBody) ?? word('pausedBody');
    backAt = Number.isFinite(untilMs) && !lifted ? new Date(untilMs) : null;
  } else {
    title = word('closedTitle');
    subtitle = word('closedBody');
    backAt = kioskNextOpening(cfg.hours, now);
  }
  if (!backAt) return { title, subtitle, backAt: null, backClock: null, backInDays: null, backWeekday: null };
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const thatDay = new Date(backAt.getFullYear(), backAt.getMonth(), backAt.getDate());
  return {
    title,
    subtitle,
    backAt,
    backClock: `${String(backAt.getHours()).padStart(2, '0')}:${String(backAt.getMinutes()).padStart(2, '0')}`,
    backInDays: Math.round((thatDay.getTime() - today.getTime()) / 86_400_000),
    backWeekday: backAt.getDay(),
  };
}

/** "#RRGGBB" from `a` towards `b` by `t`, channel by channel. */
export function mixHex(a: string, b: string, t: number): string {
  const ch = (h: string, i: number) => (isHexColor(h) ? parseInt(h.slice(i, i + 2), 16) : 0);
  return (
    '#' +
    [1, 3, 5]
      .map((i) => Math.min(255, Math.max(0, Math.round(ch(a, i) + (ch(b, i) - ch(a, i)) * t))).toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase()
  );
}

/** WCAG contrast ratio of two "#RRGGBB" colours (1…21). */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** WCAG's large-text minimum: the closed screen's title, subtitle and clock are all large. */
export const REST_LARGE_TEXT_CONTRAST = 3;
export const REST_DARK_INK = '#111111';

export interface KioskRestLook {
  /** The fill from the top (wolt: the top-left corner) to the bottom; equal for a flat one. */
  from: string;
  to: string;
  /** 135°, top-left to bottom-right (wolt), rather than top to bottom. */
  diagonal: boolean;
  /** minimal_dark: the brand colour glowing behind the cup. */
  glow: string | null;
  /** The words and the cup: white where it reads as large text on the whole fill, else near-black. */
  ink: string;
  /** The title: the ink, or minimal_dark's brand colour where that reads. */
  title: string;
  /** wolt's two soft spots of light and shade, as on its hero. */
  spots: boolean;
}

/**
 * The closed screen's colours by UI style, as its attract screen colours it (the till's
 * KioskRestLook, the same numbers): ios a soft fall of the brand colour; wolt the
 * brand-to-accent sweep of its hero; classic a flat bold fill; minimal_dark its near-black with
 * the brand colour glowing, the title in it; tech its near-black with no glow (its grid shows
 * through — kioskChrome), the title in the accent.
 */
export function kioskRestLook(
  theme: Pick<KioskTheme, 'uiStyle' | 'primaryColor' | 'accentColor'>,
  colors: Pick<ResolvedThemeColors, 'background' | 'text'>,
): KioskRestLook {
  const p = mixHex(theme.primaryColor, theme.primaryColor, 0);
  const fill = (from: string, to: string, diagonal: boolean, spots: boolean): KioskRestLook => {
    const white = Math.min(contrastRatio('#FFFFFF', from), contrastRatio('#FFFFFF', to)) >= REST_LARGE_TEXT_CONTRAST;
    const ink = white ? '#FFFFFF' : REST_DARK_INK;
    return { from, to, diagonal, glow: null, ink, title: ink, spots };
  };
  switch (theme.uiStyle) {
    case 'ios':
      return fill(mixHex(p, '#FFFFFF', 0.1), mixHex(p, '#000000', 0.3), false, false);
    case 'classic':
      return fill(p, p, false, false);
    case 'minimal_dark': {
      const bg = mixHex(colors.background, colors.background, 0);
      const text = mixHex(colors.text, colors.text, 0);
      return { from: bg, to: bg, diagonal: false, glow: p, ink: text, title: contrastRatio(p, bg) >= REST_LARGE_TEXT_CONTRAST ? p : text, spots: false };
    }
    case 'tech': {
      const bg = mixHex(colors.background, colors.background, 0);
      const text = mixHex(colors.text, colors.text, 0);
      return { from: bg, to: bg, diagonal: false, glow: null, ink: text, title: contrastRatio(p, bg) >= REST_LARGE_TEXT_CONTRAST ? p : text, spots: false };
    }
    default:
      return fill(p, mixHex(mixHex(p, theme.accentColor, 0.5), '#000000', 0.18), true, true);
  }
}

/* ------------------------------------------------ "טכנולוגי": the chrome */
// The till's domain/KioskChrome.kt — the same rules and numbers (both repos' tests pin them).

/** The screens' backdrop pattern: none, thin grid lines, or a dot matrix. */
export type KioskBackdrop = 'none' | 'grid' | 'dots';

/**
 * A style's chrome — what it draws around the content, the same on every screen and layout:
 * the backdrop pattern, the outline that replaces shadows, the status line, the figures, the press,
 * the add-to-cart glow and the attract screen's scan line. Only "tech" has any of it; the other
 * styles draw exactly as before. Nothing here costs a frame while idle except the scan line, and
 * `general.reduceMotion` turns the moving parts off (0 ms: not even mounted).
 */
export interface KioskChrome {
  backdrop: KioskBackdrop;
  /** The pattern's step (dp) and its ink ("#RRGGBBAA": the text colour, faint). */
  backdropStep: number;
  backdropInk: string;
  /** Cards and panels: a 1 dp outline in this colour and no shadow; null — the card style's own. */
  outline: string | null;
  /** "שורת מצב": the time · the order's number · the kiosk's state, along the top of every screen. */
  statusBar: boolean;
  /** Prices, totals and counts in tabular figures (every digit as wide, columns that line up). */
  tabularFigures: boolean;
  /** The order's number and the status line's figures in a monospaced face. */
  monoFigures: boolean;
  /** The press: the element's scale while held; null — the style's own press. */
  pressScale: number | null;
  /** A short glow of the accent on the basket as a dish lands (ms; 0: none). */
  addGlowMs: number;
  /** The attract screen's idle scan line, one sweep top to bottom (ms; 0: none — nothing drawn). */
  scanMs: number;
  /** The accent the glow, the scan line and the status line's dot are drawn in. */
  accent: string;
}

/** The chrome of a style that has none. */
export const NO_CHROME: Omit<KioskChrome, 'accent'> = {
  backdrop: 'none',
  backdropStep: 0,
  backdropInk: '#00000000',
  outline: null,
  statusBar: false,
  tabularFigures: false,
  monoFigures: false,
  pressScale: null,
  addGlowMs: 0,
  scanMs: 0,
};

/** "טכנולוגי"'s numbers: a 32 dp grid at 6 % of the text, 0.98 on press, a 150 ms glow, a 7 s sweep. */
export const TECH_GRID_STEP = 32;
export const TECH_GRID_ALPHA = 0x0f;
export const TECH_OUTLINE_MIX = 0.14;
export const TECH_PRESS_SCALE = 0.98;
export const TECH_ADD_GLOW_MS = 150;
export const TECH_SCAN_MS = 7000;
/** The status line's height (dp, at type scale 1) and its warning dot (paused, closed, no payment). */
export const STATUS_LINE_DP = 28;
export const STATUS_WARN = '#F5A524';
/** The monospaced face of the figures (web; the till uses the device's monospace). */
export const MONO_FIGURES_STACK = 'ui-monospace, "SF Mono", "Cascadia Mono", "JetBrains Mono", "Roboto Mono", Consolas, "Droid Sans Mono", monospace';

export function kioskChrome(
  theme: Pick<KioskTheme, 'uiStyle' | 'primaryColor'>,
  colors: Pick<ResolvedThemeColors, 'surface' | 'text'>,
  general: Pick<KioskGeneral, 'reduceMotion'>,
  profile: KioskRenderProfile = 'full',
): KioskChrome {
  const accent = mixHex(theme.primaryColor, theme.primaryColor, 0);
  switch (theme.uiStyle) {
    case 'tech': {
      const text = mixHex(colors.text, colors.text, 0);
      // Reduce motion and the light profile ("אפקטים"): no add glow, no scan line.
      const still = !!general.reduceMotion || profile === 'light';
      return {
        backdrop: 'grid',
        backdropStep: TECH_GRID_STEP,
        backdropInk: text + TECH_GRID_ALPHA.toString(16).padStart(2, '0').toUpperCase(),
        outline: mixHex(colors.surface, text, TECH_OUTLINE_MIX),
        statusBar: true,
        tabularFigures: true,
        monoFigures: true,
        pressScale: TECH_PRESS_SCALE,
        addGlowMs: still ? 0 : TECH_ADD_GLOW_MS,
        scanMs: still ? 0 : TECH_SCAN_MS,
        accent,
      };
    }
    default:
      return { ...NO_CHROME, accent };
  }
}

/** What the status line says: the state (its words: kiosks.preview.status.<key>), its tone, the order's number. */
export type KioskStatusKey = 'ready' | 'ordering' | 'paying' | 'done' | 'paused' | 'closed' | 'noPayment' | 'offline' | 'setup';
export interface KioskStatusLine {
  key: KioskStatusKey;
  /** ok: the accent dot; warn: the amber one (the kiosk does not take orders now). */
  tone: 'ok' | 'warn';
  /** The order's number (its pickup label) once it has one; null before. */
  order: string | null;
}

const STATUS_OF: Record<string, KioskStatusKey> = {
  attract: 'ready',
  service: 'ordering',
  catalog: 'ordering',
  product: 'ordering',
  confirm: 'ordering',
  cart: 'ordering',
  tip: 'ordering',
  details: 'ordering',
  pay: 'paying',
  success: 'done',
  paused: 'paused',
  closed: 'closed',
  no_payment: 'noPayment',
  noPayment: 'noPayment',
  offline: 'offline',
  setup: 'setup',
};
const STATUS_WARN_KEYS: KioskStatusKey[] = ['paused', 'closed', 'noPayment', 'offline', 'setup'];

/**
 * The status line of `screen` (the screens' names, the till's KioskScreen wire names, and the rest
 * screens' variants): "מוכן לקבל הזמנה" at rest, "הזמנה בתהליך" while ordering… — and the order's
 * number once the payment gave it one (`pickup`).
 */
export function kioskStatusLine(screen: string, pickup?: string | null): KioskStatusLine {
  const key = STATUS_OF[screen] ?? 'ready';
  const order = (pickup ?? '').trim();
  return { key, tone: STATUS_WARN_KEYS.includes(key) ? 'warn' : 'ok', order: order ? order : null };
}

/** The status line's clock: "HH:MM", 24 hours, the device's local time. */
export function statusClock(at: Date): string {
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}

/* -------------------------------------------------------------- "כיתוב רץ" */

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

/** The scroll speeds, in px (dp) per second — the till's KioskTickerSpeed. Slow, the default, reads easily. */
export const TICKER_SPEED_PX: Record<TickerSpeed, number> = { slow: 45, normal: 75, fast: 120 };

/** Reduce motion: the strip stands still and shows one text at a time, each this long. */
export const TICKER_STATIC_MS = 5000;

/** The web screens' strip per size: its text and its height, in px (the till's are KioskTickerSize). */
export const TICKER_SIZE_PX: Record<TickerSize, { font: number; height: number }> = {
  s: { font: 12, height: 26 },
  m: { font: 14, height: 32 },
  l: { font: 17, height: 40 },
};

function validateTicker(e: KioskValidationError[], tk: unknown): void {
  if (!isDict(tk)) {
    e.push({ path: 'ticker', code: 'enum' });
    return;
  }
  const L = KIOSK_LIMITS;
  for (const key of ['enabled', 'pauseOnTouch'] as const) {
    if (typeof tk[key] !== 'boolean') e.push({ path: `ticker.${key}`, code: 'enum' });
  }
  const screens = tk.screens;
  if (!Array.isArray(screens) || !uniq(screens) || screens.some((s) => !(TICKER_SCREENS as readonly unknown[]).includes(s))) {
    e.push({ path: 'ticker.screens', code: 'enum' });
  }
  checkEnum(e, 'ticker.position', tk.position, TICKER_POSITIONS);
  checkEnum(e, 'ticker.speed', tk.speed, TICKER_SPEEDS);
  checkEnum(e, 'ticker.size', tk.size, TICKER_SIZES);
  for (const key of ['backgroundColor', 'textColor'] as const) {
    if (tk[key] !== null && !isHexColor(tk[key])) e.push({ path: `ticker.${key}`, code: 'color' });
  }
  const items = Array.isArray(tk.items) ? (tk.items as unknown[]) : null;
  if (!items) {
    e.push({ path: 'ticker.items', code: 'enum' });
    return;
  }
  if (items.length > L.tickerItemsMax) e.push({ path: 'ticker.items', code: 'tooMany', params: { max: L.tickerItemsMax } });
  const ids = new Set<string>();
  items.forEach((raw, i) => {
    const p = `ticker.items.${i}`;
    if (!isDict(raw)) {
      e.push({ path: p, code: 'enum' });
      return;
    }
    const it = raw as Partial<KioskTickerItem>;
    if (typeof it.id !== 'string' || !MSG_ID.test(it.id)) e.push({ path: `${p}.id`, code: 'messageId' });
    else if (ids.has(it.id)) e.push({ path: `${p}.id`, code: 'duplicate' });
    if (typeof it.id === 'string') ids.add(it.id);
    checkLength(e, `${p}.text`, it.text, L.tickerTextMax);
    if (typeof it.enabled !== 'boolean') e.push({ path: `${p}.enabled`, code: 'enum' });
    if (it.from !== null && !isHhMm(it.from)) e.push({ path: `${p}.from`, code: 'time' });
    if (it.to !== null && !isHhMm(it.to)) e.push({ path: `${p}.to`, code: 'time' });
    if (isHhMm(it.from) && it.from === it.to) e.push({ path: `${p}.to`, code: 'sameTimes' });
    const days = it.days;
    if (!Array.isArray(days) || days.length === 0) e.push({ path: `${p}.days`, code: 'atLeastOne' });
    else if (!uniq(days) || days.some((d) => !isInt(d) || d < 0 || d > 6)) e.push({ path: `${p}.days`, code: 'enum' });
    const starts = it.startsAt ? Date.parse(it.startsAt) : null;
    const ends = it.endsAt ? Date.parse(it.endsAt) : null;
    if (it.startsAt && Number.isNaN(starts)) e.push({ path: `${p}.startsAt`, code: 'date' });
    if (it.endsAt && Number.isNaN(ends)) e.push({ path: `${p}.endsAt`, code: 'date' });
    if (starts !== null && ends !== null && !Number.isNaN(starts) && !Number.isNaN(ends) && ends <= starts) {
      e.push({ path: `${p}.endsAt`, code: 'endsBeforeStarts' });
    }
  });
}

/**
 * Whether a text's hours hold on `day` (0 = Sunday) at `minute` of the day: no hours — all day;
 * only `from` — until midnight; only `to` — from midnight; a `to` before `from` runs past
 * midnight, its small hours belonging to the day it started (as the opening hours). No days
 * given counts as every day.
 */
export function tickerWindowOpen(item: Pick<KioskTickerItem, 'from' | 'to' | 'days'>, day: number, minute: number): boolean {
  const days = Array.isArray(item.days) && item.days.length > 0 ? item.days : ALL_DAYS;
  const from = hhmmMinutes(item.from);
  const to = hhmmMinutes(item.to);
  if (from !== null && to !== null && from > to) {
    return (days.includes(day) && minute >= from) || (days.includes((day + 6) % 7) && minute < to);
  }
  if (!days.includes(day)) return false;
  if (from !== null && to !== null && from === to) return true;
  return (from === null || minute >= from) && (to === null || minute < to);
}

/** A text's turn at `now`, in the kiosk's own time: on, not blank, within its dates, its days and its hours. */
export function tickerItemLive(item: KioskTickerItem, now: Date): boolean {
  if (!item || item.enabled === false || typeof item.text !== 'string' || item.text.trim() === '') return false;
  const ms = now.getTime();
  if (item.startsAt && Date.parse(item.startsAt) > ms) return false;
  if (item.endsAt && Date.parse(item.endsAt) <= ms) return false;
  return tickerWindowOpen(item, now.getDay(), now.getHours() * 60 + now.getMinutes());
}

/** The ticker's screen for a kiosk screen: the tip is a "details" step, the product sheet the menu's; null where it never runs. */
export function tickerScreenOf(screen: string): TickerScreen | null {
  if (screen === 'tip') return 'details';
  if (screen === 'product') return 'catalog';
  if (screen === 'confirm') return 'cart';
  return (TICKER_SCREENS as readonly string[]).includes(screen) ? (screen as TickerScreen) : null;
}

/** Whether the strip runs on `screen` (whatever its texts are right now). */
export function tickerOnScreen(ticker: KioskTicker | null | undefined, screen: string): boolean {
  const s = tickerScreenOf(screen);
  return !!ticker && ticker.enabled === true && !!s && Array.isArray(ticker.screens) && ticker.screens.includes(s);
}

/** Whether the strip runs on `screen` at `position`. */
export function tickerAt(ticker: KioskTicker | null | undefined, screen: string, position: TickerPosition): boolean {
  return tickerOnScreen(ticker, screen) && (ticker?.position ?? 'top') === position;
}

/** The texts the strip runs on `screen` at `now`, in order (trimmed); none when it is off or not on that screen. */
export function tickerTextsNow(ticker: KioskTicker | null | undefined, screen: string, now: Date): string[] {
  if (!ticker || !tickerOnScreen(ticker, screen)) return [];
  return (ticker.items ?? []).filter((it) => tickerItemLive(it, now)).map((it) => it.text.trim());
}

const RTL_LETTER = /[֐-׿؀-ۿ܀-ࣿיִ-﷿ﹰ-﻿]/;
const LTR_LETTER = /[A-Za-zÀ-ɏͰ-ϿЀ-ӿ]/;

/** A text's direction by its first strong letter: Hebrew / Arabic "rtl", Latin / Greek / Cyrillic "ltr"; null with none. */
export function textDirection(text: string): 'rtl' | 'ltr' | null {
  for (const ch of text) {
    if (RTL_LETTER.test(ch)) return 'rtl';
    if (LTR_LETTER.test(ch)) return 'ltr';
  }
  return null;
}

/**
 * The strip's direction: its first text's with a letter, else the kiosk's. It moves the way it
 * reads: a Hebrew strip comes in from the left and moves right; an English one the other way.
 */
export function tickerDirection(texts: readonly string[], fallback: 'rtl' | 'ltr'): 'rtl' | 'ltr' {
  for (const t of texts) {
    const d = textDirection(t);
    if (d) return d;
  }
  return fallback;
}

/** Copies of one loop (every text and its bullet) that fill the strip with one to spare, so the wrap never shows. */
export function tickerCopies(stripPx: number, loopPx: number): number {
  if (!(loopPx > 0) || !(stripPx > 0)) return 2;
  return Math.max(2, Math.ceil(stripPx / loopPx) + 1);
}

/** One loop's time at `speed`: its width at the speed's px per second (at least a second). */
export function tickerLoopMs(loopPx: number, speed: TickerSpeed): number {
  const pps = TICKER_SPEED_PX[speed] ?? TICKER_SPEED_PX.slow;
  return Math.max(1000, Math.round((Math.max(0, loopPx) / pps) * 1000));
}

/** Reduce motion: which text stands `elapsedMs` after the strip appeared (each for TICKER_STATIC_MS). */
export function tickerStaticIndex(count: number, elapsedMs: number): number {
  if (count <= 0) return 0;
  return Math.floor(Math.max(0, elapsedMs) / TICKER_STATIC_MS) % count;
}

/** The strip's colours: the configured ones, else the theme's button and its text (a custom background gets readable text). */
export function tickerColors(
  ticker: Pick<KioskTicker, 'backgroundColor' | 'textColor'>,
  c: Pick<ResolvedThemeColors, 'button' | 'buttonText'>,
): { bg: string; fg: string } {
  const bg = isHexColor(ticker.backgroundColor) ? ticker.backgroundColor : c.button;
  const fg = isHexColor(ticker.textColor) ? ticker.textColor : isHexColor(ticker.backgroundColor) ? contrastText(ticker.backgroundColor) : c.buttonText;
  return { bg, fg };
}

/** A ticker text id not taken yet ("t1", "t2", …). */
export function nextTickerItemId(items: ReadonlyArray<{ id: string }>): string {
  const taken = new Set(items.map((x) => x.id));
  let n = items.length + 1;
  while (taken.has(`t${n}`)) n++;
  return `t${n}`;
}

/**
 * The room the strip takes on a web screen at `now`, in px: its height (× the theme's type
 * scale) at its edge, and `gapBelow` under a bottom one; nothing when it does not run there now.
 * The hosts lay the full-bleed attract screen out on what is left (its start button, its hint),
 * as the till's attract screen does in its own box.
 */
export function tickerBandPx(
  cfg: { ticker?: KioskTicker | null; theme: Pick<KioskTheme, 'typeScale'> },
  screen: string,
  now: Date,
  gapBelow = 0,
): { top: number; bottom: number } {
  const t = cfg.ticker;
  if (!t || tickerTextsNow(t, screen, now).length === 0) return { top: 0, bottom: 0 };
  const h = (TICKER_SIZE_PX[t.size] ?? TICKER_SIZE_PX.m).height * typeScaleFactor(cfg.theme.typeScale);
  return t.position === 'bottom' ? { top: 0, bottom: h + gapBelow } : { top: h, bottom: 0 };
}
