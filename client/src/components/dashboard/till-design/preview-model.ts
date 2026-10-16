/**
 * The live preview's model: what one till screen shows for the draft config, one profile and
 * one mode — the view (`forProfile`), the colours (the brief's tokens, one accent), the menu in
 * the menu's order, the order (the owner's sample, or the first products of the real catalog),
 * the header, the fields, the action bar with its labels. Pure: the editor's preview, the
 * template thumbnails and the screenshot page all build it here.
 */

import {
  LARGE_TEXT_FACTOR,
  TEMPLATE_DEFAULTS,
  actionLabelOf,
  actionsFor,
  forProfile,
  formatShekels,
  menuView,
  quickCashNotes,
  resolveFieldMode,
  resolveTileSize,
  textOf,
  type ActionId,
  type Mode,
  type Profile,
  type ProfileView,
  type TextKey,
  type TillDesignConfig,
  type TillDesignLegacy,
  type TileSize,
} from '@/lib/tillDesign';
import type { KioskSourceCatalog } from '@/lib/kioskApi';
import { resolveProductText, type ProductTextSettings } from '@/lib/productTileText';

/* ------------------------------------------------------------ the colours */

export interface Tokens {
  dark: boolean;
  bg: string;
  surface: string;
  border: string;
  ink: string;
  ink2: string;
  accent: string;
  onAccent: string;
  tint: string;
  amberInk: string;
  amberBg: string;
  red: string;
  redBg: string;
}

/** Today's brand colour when none is set (brandPrimaryColor's default). */
export const DEFAULT_ACCENT = '#007AFF';

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** `a` over `b` at `t` (0..1): the accent's tint over a surface. */
export function mixHex(a: string, b: string, t: number): string {
  const [r1, g1, b1] = hexToRgb(a);
  const [r2, g2, b2] = hexToRgb(b);
  const mix = (x: number, y: number) => Math.round(x * t + y * (1 - t)).toString(16).padStart(2, '0');
  return `#${mix(r1, r2)}${mix(g1, g2)}${mix(b1, b2)}`.toUpperCase();
}

export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** The accent a config shows: its own colour, else ("brand" or none) the brand colour. */
export function accentOf(cfg: Pick<TillDesignConfig, 'colors'>, brandColor?: string | null): string {
  const own = cfg.colors?.accent;
  return (own && /^#[0-9A-Fa-f]{6}$/.test(own) ? own : brandColor || DEFAULT_ACCENT).toUpperCase();
}

/**
 * "לילה"'s own palette (phase 2 §2.3), whatever the colour mode: black, a #121418 surface, 2 dp
 * #3A3F47 borders, white text; the accent lightened until it reads 4.5:1 on the black.
 */
export function nightTokens(cfg: Pick<TillDesignConfig, 'colors'>, brandColor?: string | null): Tokens {
  let accent = accentOf(cfg, brandColor);
  for (let i = 0; i < 20 && contrast(accent, '#000000') < 4.5; i++) accent = mixHex('#FFFFFF', accent, 0.12);
  const surface = '#121418';
  return {
    dark: true,
    bg: '#000000',
    surface,
    border: '#3A3F47',
    ink: '#FFFFFF',
    ink2: '#C9CED6',
    accent,
    onAccent: luminance(accent) > 0.55 ? '#000000' : '#FFFFFF',
    tint: mixHex(accent, surface, 0.22),
    amberInk: '#FBBF24',
    amberBg: '#3A2A0A',
    red: '#F87171',
    redBg: mixHex('#F87171', surface, 0.16),
  };
}

/** The brief's tokens (§2) for a colour mode and an accent. */
export function tokensFor(cfg: Pick<TillDesignConfig, 'colors'>, brandColor?: string | null): Tokens {
  const accent = accentOf(cfg, brandColor);
  const dark = cfg.colors?.mode === 'dark';
  const onAccent = luminance(accent) > 0.55 ? '#111827' : '#FFFFFF';
  if (dark) {
    const surface = '#171A20';
    return {
      dark,
      bg: '#0E1014',
      surface,
      border: '#2A2F38',
      ink: '#F2F4F7',
      ink2: '#9AA3AF',
      accent,
      onAccent,
      tint: mixHex(accent, surface, 0.18),
      amberInk: '#FBBF24',
      amberBg: '#3A2A0A',
      red: '#F87171',
      redBg: mixHex('#F87171', surface, 0.16),
    };
  }
  const surface = '#FFFFFF';
  return {
    dark,
    bg: '#F3F5F8',
    surface,
    border: '#E2E6EC',
    ink: '#111827',
    ink2: '#6B7280',
    accent,
    onAccent,
    tint: mixHex(accent, surface, 0.1),
    amberInk: '#B45309',
    amberBg: '#FEF3C7',
    red: '#B91C1C',
    redBg: '#FEE2E2',
  };
}

/** `color` moved toward `toward` until it reads `min`:1 on `bg` (at most 20 steps). */
function untilContrast(color: string, bg: string, toward: string, min: number): string {
  let out = color;
  for (let i = 0; i < 20 && contrast(out, bg) < min; i++) out = mixHex(toward, out, 0.12);
  return out;
}

/** `color` darkened on a light `bg`, lightened on a dark one, until it reads `min`:1 (a state's word in its colour). */
export function readableOn(color: string, bg: string, min = 4.5): string {
  return untilContrast(color, bg, luminance(bg) < 0.4 ? '#FFFFFF' : '#000000', min);
}

/**
 * "זרימה"'s palette (P:/specs/flow-design.md §5.3): ours — the design's light / dark tokens, the accent the
 * design's `colors.accent` or the brand colour, lightened on dark until it reads 4.5:1 (no background, or "base")
 * — or, with a chosen `flow.background`, the surface, the border and the text derived from its luminance (text
 * always 4.5:1).
 * The text on the accent is white or ink, whichever reads better. Never the competitor's navy and yellow.
 */
export function flowTokens(cfg: Pick<TillDesignConfig, 'colors' | 'flow'>, brandColor?: string | null): Tokens {
  const base = tokensFor(cfg, brandColor);
  const own = cfg.flow?.background;
  const chosen = typeof own === 'string' && /^#[0-9A-Fa-f]{6}$/.test(own) ? own.toUpperCase() : null;
  const onAccentOf = (accent: string) => (contrast(accent, '#FFFFFF') >= contrast(accent, '#111827') ? '#FFFFFF' : '#111827');
  if (!chosen) {
    const accent = base.dark ? untilContrast(base.accent, base.bg, '#FFFFFF', 4.5) : base.accent;
    return { ...base, accent, onAccent: onAccentOf(accent), tint: mixHex(accent, base.surface, base.dark ? 0.18 : 0.1) };
  }
  const dark = contrast(chosen, '#FFFFFF') > contrast(chosen, '#111827');
  const ink = untilContrast(dark ? '#F2F4F7' : '#111827', chosen, dark ? '#FFFFFF' : '#000000', 4.5);
  const ink2 = untilContrast(mixHex(ink, chosen, 0.62), chosen, ink, 4.5);
  const surface = dark ? mixHex('#FFFFFF', chosen, 0.07) : mixHex('#FFFFFF', chosen, 0.7);
  const border = dark ? mixHex('#FFFFFF', chosen, 0.16) : mixHex('#000000', chosen, 0.1);
  const accent = untilContrast(base.accent, chosen, dark ? '#FFFFFF' : '#000000', 4.5);
  return {
    ...base,
    dark,
    bg: chosen,
    surface,
    border,
    ink,
    ink2,
    accent,
    onAccent: onAccentOf(accent),
    tint: mixHex(accent, surface, dark ? 0.2 : 0.1),
  };
}

/* ------------------------------------------------------------ the sample */

export interface PCategory {
  id: string;
  name: string;
}

export interface PProduct {
  id: string;
  name: string;
  /** Agorot. */
  price: number;
  categoryId: string | null;
  imageUrl: string | null;
  available: boolean;
  /** "תפריט ויזואלי": the dish card's description and dietary tags. */
  description?: string | null;
  dietary?: string[];
  /** "תג i" (P:/specs/product-tile-text.md §4): the item's sheet — its allergen codes, its sizes / variants
   * (agorot each), and why it is not on sale ("אזל" / "חסום" with the reason). */
  allergens?: string[];
  variants?: Array<{ name: string; price: number }>;
  status?: { kind: 'sold_out' | 'blocked'; reason: string | null } | null;
}

export type LineStatus = 'new' | 'sent' | 'pending' | 'failed';

export interface PLine {
  id: string;
  productId: string;
  name: string;
  qty: number;
  /** Agorot per unit. */
  unit: number;
  note: string | null;
  /** 0 = "כללי", else the seat's number. */
  seat: number;
  status: LineStatus;
  /** "לוח מנות": the line's course (an index into the course names; null = "ללא שלב"); absent = by its category. */
  course?: number | null;
  /** "לוח מנות": the kitchen said "מוכן" (a sent line). */
  ready?: boolean;
}

/** The owner's sample menu (brief §6) and a few more dishes, so a tablet's grid is not empty. */
export const SAMPLE_CATEGORIES: PCategory[] = [
  { id: 'c-main', name: 'עיקריות' },
  { id: 'c-side', name: 'תוספות' },
  { id: 'c-drink', name: 'שתייה' },
  { id: 'c-dessert', name: 'קינוחים' },
];

const sample = (
  id: string,
  name: string,
  shekels: number,
  categoryId: string,
  description: string | null = null,
  dietary: string[] = [],
  more: Partial<PProduct> = {},
): PProduct => ({
  id,
  name,
  price: Math.round(shekels * 100),
  categoryId,
  imageUrl: null,
  available: true,
  description,
  dietary,
  ...more,
});

export const SAMPLE_PRODUCTS: PProduct[] = [
  sample('p-burger', 'המבורגר', 64, 'c-main', 'קציצת בקר 220 גרם, חסה, עגבנייה ובצל סגול, בלחמנייה של המאפייה.', ['meat'], { allergens: ['gluten', 'sesame'] }),
  sample('p-schnitzel', 'שניצל בחלה', 54, 'c-main', 'שניצל עוף פריך בחלה טרייה, עם ירקות ורוטב הבית.', ['meat'], { allergens: ['gluten', 'eggs'] }),
  // "שם פריט מלא ותג i" (P:/specs/product-tile-text.md §5): long names, a long price, a blocked dish with its reason.
  sample(
    'p-platter',
    'פלטת גבינות זהב עם ירקות טריים ולחם הבית',
    168,
    'c-main',
    'מבחר גבינות קשות ורכות, ירקות עונה טריים, זיתים ולחם הבית החם. מתאים לשניים עד שלושה סועדים.',
    ['vegetarian', 'dairy'],
    { allergens: ['milk', 'gluten'] },
  ),
  sample('p-feast', 'מגש אירוח משפחתי גדול במיוחד', 1268.5, 'c-main', 'סלטים, גבינות, דגים מעושנים, לחמים ומטבלים של הבית — לעשרה סועדים. בהזמנה מראש.', [], {
    allergens: ['gluten', 'milk', 'fish', 'sesame'],
  }),
  sample('p-salmon', 'סלמון צלוי ברוטב לימון וחמאה', 92, 'c-main', 'נתח סלמון נורווגי על מצע פירה ואספרגוס.', ['gluten_free'], {
    allergens: ['fish', 'milk'],
    available: false,
    status: { kind: 'blocked', reason: 'המטבח: נגמר הדג להיום' },
  }),
  sample('p-fries', 'צ׳יפס', 16, 'c-side', 'תפוחי אדמה בחיתוך עבה, מלח ים.', ['vegan']),
  sample('p-cola', 'קולה', 14, 'c-drink'),
  sample('p-water', 'מים מינרליים', 10, 'c-drink'),
  sample('p-brownie', 'בראוני', 22, 'c-dessert', 'בראוני שוקולד חם עם כדור גלידת וניל.', ['dairy']),
  sample('p-caesar', 'סלט קיסר', 48, 'c-main', 'חסה רומית, קרוטונים, פרמזן ורוטב קיסר.', ['vegetarian']),
  sample('p-pasta', 'פסטה רוזה', 58, 'c-main', 'פנה ברוטב עגבניות ושמנת, בזיליקום טרי.', ['vegetarian', 'dairy']),
  sample('p-rings', 'טבעות בצל', 18, 'c-side', 'טבעות בצל בבלילת בירה, עם איולי חריף.', ['spicy']),
  sample('p-lemonade', 'לימונדה', 16, 'c-drink'),
  sample('p-beer', 'בירה מהחבית', 28, 'c-drink', null, [], {
    variants: [
      { name: 'שליש', price: 2800 },
      { name: 'חצי', price: 3400 },
    ],
  }),
  sample('p-cheesecake', 'עוגת גבינה', 26, 'c-dessert', 'עוגת גבינה אפויה על בסיס פירורים.', ['dairy']),
];

/** "לוח מנות" in the sample: the sample's categories as courses (drinks go with every send). */
export const SAMPLE_COURSE_OF_CATEGORY: Record<string, number | null> = { 'c-side': 0, 'c-main': 1, 'c-dessert': 2, 'c-drink': null };
/** The course names when the company has none ("ראשונות / עיקריות / קינוחים"). */
export const SAMPLE_COURSES = ['ראשונות', 'עיקריות', 'קינוחים'];

/**
 * "לוח מנות"'s sample (§2.1): one course fired at 19:44 with two of its three lines ready, the
 * next one waiting with "הוצא", the drinks with no course.
 */
const COURSES_ORDER: Array<{ id: string; qty: number; note: string | null; seat: number; status: LineStatus; course: number | null; ready?: boolean }> = [
  { id: 'p-cola', qty: 2, note: null, seat: 2, status: 'sent', course: null },
  { id: 'p-caesar', qty: 1, note: null, seat: 1, status: 'sent', course: 0, ready: true },
  { id: 'p-rings', qty: 1, note: null, seat: 2, status: 'sent', course: 0, ready: true },
  { id: 'p-fries', qty: 1, note: 'בלי מלח', seat: 0, status: 'sent', course: 0 },
  { id: 'p-burger', qty: 1, note: 'ללא בצל · עשוי היטב', seat: 1, status: 'new', course: 1 },
  { id: 'p-schnitzel', qty: 1, note: null, seat: 2, status: 'new', course: 1 },
];

function coursesSample(products: readonly PProduct[]): PLine[] {
  const byId = new Map(products.map((p) => [p.id, p]));
  const own = COURSES_ORDER.map((o) => byId.get(o.id));
  const picks = own.every((p) => !!p) ? (own as PProduct[]) : products.filter((p) => p.available).slice(0, COURSES_ORDER.length);
  return picks.map((p, i) => {
    const o = COURSES_ORDER[i];
    return { id: `c${i + 1}`, productId: p.id, name: p.name, qty: o.qty, unit: p.price, note: o.note, seat: o.seat, status: o.status, course: o.course, ready: o.ready };
  });
}

/** The order: המבורגר ×1 (seat 1, sent), קולה ×2 (seat 2, sent), צ׳יפס ×1 (seat 1, new) → ₪108. */
const SAMPLE_ORDER: Array<{ productId: string; qty: number; note: string | null; seat: number; status: LineStatus }> = [
  { productId: 'p-burger', qty: 1, note: 'ללא בצל · עשוי היטב', seat: 1, status: 'sent' },
  { productId: 'p-cola', qty: 2, note: null, seat: 2, status: 'sent' },
  { productId: 'p-fries', qty: 1, note: null, seat: 1, status: 'new' },
];

/** The order's starting lines on these products (the sample's dishes, else the first three on sale). */
export function sampleLines(products: readonly PProduct[], mode: Mode): PLine[] {
  const byId = new Map(products.map((p) => [p.id, p]));
  const owner = SAMPLE_ORDER.map((o) => byId.get(o.productId)).filter((p): p is PProduct => !!p);
  const picks = owner.length === SAMPLE_ORDER.length ? owner : products.filter((p) => p.available).slice(0, SAMPLE_ORDER.length);
  return picks.map((p, i) => {
    const o = SAMPLE_ORDER[i];
    return {
      id: `l${i + 1}`,
      productId: p.id,
      name: p.name,
      qty: o.qty,
      unit: p.price,
      note: o.note,
      seat: o.seat,
      status: mode === 'quick' ? 'new' : o.status,
    };
  });
}

/** The real catalog in the preview's shape (shekels → agorot). */
export function catalogProducts(catalog: KioskSourceCatalog | null | undefined): { categories: PCategory[]; products: PProduct[] } | null {
  if (!catalog || catalog.products.length === 0) return null;
  return {
    categories: catalog.categories.map((c) => ({ id: c.id, name: c.name })),
    products: catalog.products.map((p) => ({
      id: p.id,
      name: p.name,
      price: Math.round((Number(p.price) || 0) * 100),
      categoryId: p.categoryId,
      imageUrl: p.imageUrl,
      available: p.available,
      description: p.description ?? null,
      dietary: [...(p.dietaryTags ?? [])],
      allergens: [...(p.allergens ?? [])],
    })),
  };
}

/**
 * The product "פתח את חלון התיאור" shows (P:/specs/product-tile-text.md §5): the longest name, a
 * description first among equals — the case the sheet is for.
 */
export function showcaseProductId(products: readonly PProduct[]): string | null {
  let best: PProduct | null = null;
  const score = (p: PProduct) => p.name.length * 2 + (p.description?.trim() ? 1 : 0);
  for (const p of products) if (!best || score(p) > score(best)) best = p;
  return best?.id ?? null;
}

/* -------------------------------------------------------------- the model */

export interface PAction {
  key: string;
  action: ActionId | 'note' | 'more';
  label: string;
  /** The second line ("עודף ₪2.80"). */
  sub?: string;
  primary: boolean;
  disabled: boolean;
  icon?: 'send' | 'card' | 'cash';
}

export interface PreviewState {
  lines: PLine[];
  category: string | null;
  nextQty: number;
  seat: number;
  summaryOpen: boolean | null;
  serviceType: 'takeAway' | 'eatIn';
  /** "עגינת תשלום": the bill's selected line (its strip open). */
  selectedLine?: string | null;
  /** "לוח מנות": the fired courses (null: those with a sent line) and the held ones. */
  fired?: number[] | null;
  /** The courses fired in the preview itself ("הוצא עכשיו"). */
  firedNow?: number[];
  held?: number[];
  /** "תפריט ויזואלי": the order drawer open. */
  drawerOpen?: boolean;
  /** "לילה": the product just added (its quick add-ons row open). */
  lastAdded?: string | null;
  /** "תג i": the product whose sheet is open. */
  infoProduct?: string | null;
}

/** One lane of "לוח מנות": a course (null = "ללא שלב"), its lines and where it stands. */
export interface CourseLane {
  course: number | null;
  name: string;
  lines: PLine[];
  fired: boolean;
  held: boolean;
  /** Nothing of it went to the kitchen yet ("השהה" is possible). */
  unsent: boolean;
  ready: number;
  sent: number;
}

export interface PreviewModel {
  cfg: TillDesignConfig;
  view: ProfileView;
  mode: Mode;
  profile: Profile;
  handheld: boolean;
  W: number;
  H: number;
  t: Tokens;
  /** A type size (sp) with `textSize: large` applied. */
  fs: (sp: number) => number;
  text: (key: TextKey) => string;
  tileSize: Exclude<TileSize, 'auto'>;
  categories: PCategory[];
  /** The products the grid shows now (the chosen category's, or "הכל"). */
  products: PProduct[];
  allProducts: PProduct[];
  lines: PLine[];
  inOrder: Record<string, number>;
  total: number;
  units: number;
  toSend: number;
  title: string;
  subtitle: string;
  fields: { customerName: 'off' | 'optional' | 'required'; serviceType: 'off' | 'optional' | 'required'; guests: 'off' | 'optional' | 'required' };
  actions: PAction[];
  /** The products of `bar.favorites` that exist here. */
  favorites: PProduct[];
  presets: number[];
  seats: Array<{ seat: number; name: string; items: number; total: number }>;
  state: PreviewState;
  showImages: boolean;
  /** Line status chips on (behavior.lineStatus). */
  lineStatus: boolean;
  summaryOpen: boolean;
  /** "לוח מנות": the course names and the lanes (the courses with lines; "ללא שלב" first). */
  courseNames: string[];
  lanes: CourseLane[];
  /** "עגינת תשלום": the sample's promotion ("2 קולה ב-₪24") and what is left to pay. */
  savings: number;
  due: number;
  /** "תפריט ויזואלי": the dietary words shown (visual.dietary, "auto" = showDietaryMarks). */
  dietaryShown: boolean;
  /** Whether the products are the owner's sample (no photos there). */
  sample: boolean;
  /** "שם פריט מלא ותג i": the design's `look` over the till parameters' (legacy). */
  productText: ProductTextSettings;
  /** "תג i": the product whose sheet is open, and the name of its category. */
  infoProduct: PProduct | null;
  infoCategory: string | null;
}

export const SEAT_COUNT = 4;

export interface BuildOptions {
  cfg: TillDesignConfig;
  profile: Profile;
  mode: Mode;
  catalog?: KioskSourceCatalog | null;
  legacy?: TillDesignLegacy | null;
  brandColor?: string | null;
  state?: Partial<PreviewState>;
  /** Thumbnails: the template forced over the draft's own. */
  template?: string;
  /** "לוח מנות": the company's courses ("שלבי הגשה"); empty = the sample's names. */
  courseNames?: string[];
}

export function initialState(products: readonly PProduct[], mode: Mode, template?: string): PreviewState {
  const lines = template === 'courses' && mode === 'table' ? coursesSample(products) : sampleLines(products, mode);
  return { lines, category: null, nextQty: 1, seat: 1, summaryOpen: null, serviceType: 'takeAway' };
}

/** A line's course: its own, else its category's (the sample's map, else the categories' order). */
function courseOfLine(l: PLine, categoryOf: (productId: string) => string | null, categories: PCategory[], n: number): number | null {
  if (l.course !== undefined) return l.course;
  const cat = categoryOf(l.productId);
  if (cat && cat in SAMPLE_COURSE_OF_CATEGORY) return SAMPLE_COURSE_OF_CATEGORY[cat];
  const index = categories.findIndex((c) => c.id === cat);
  return index < 0 || n === 0 ? null : index % n;
}

/** The lanes: "ללא שלב" first, then each course with lines, in the courses' order. */
export function courseLanes(
  lines: readonly PLine[],
  names: readonly string[],
  state: Pick<PreviewState, 'fired' | 'held'>,
  courseOf: (l: PLine) => number | null,
): CourseLane[] {
  const firedNow = new Set(state.fired ?? lines.filter((l) => l.status !== 'new').map(courseOf).filter((c): c is number => c !== null));
  const held = new Set(state.held ?? []);
  const keys: Array<number | null> = [null, ...names.map((_, i) => i)];
  return keys
    .map((course) => {
      const own = lines.filter((l) => courseOf(l) === course);
      const sent = own.filter((l) => l.status !== 'new');
      return {
        course,
        name: course === null ? 'ללא שלב' : names[course],
        lines: own,
        fired: course === null || firedNow.has(course),
        held: course !== null && held.has(course),
        unsent: sent.length === 0,
        ready: sent.filter((l) => l.ready).length,
        sent: sent.length,
      };
    })
    .filter((lane) => lane.lines.length > 0);
}

export function buildPreviewModel(opts: BuildOptions): PreviewModel {
  const cfg = opts.template ? { ...opts.cfg, template: opts.template as TillDesignConfig['template'], profiles: clearProfileTemplates(opts.cfg) } : opts.cfg;
  const view = forProfile(cfg, opts.profile);
  const isSample = !catalogProducts(opts.catalog);
  const mode = opts.mode;
  const handheld = view.profile === 'handheld';
  const real = catalogProducts(opts.catalog);
  const baseCategories = real?.categories ?? SAMPLE_CATEGORIES;
  const baseProducts = real?.products ?? SAMPLE_PRODUCTS;
  const menu = menuView(baseCategories, baseProducts, cfg.menu);
  const state: PreviewState = { ...initialState(baseProducts, mode, view.template), ...(opts.state ?? {}) };
  const products = state.category ? menu.products.filter((p) => p.categoryId === state.category) : menu.products;
  const k = view.textSize === 'large' ? LARGE_TEXT_FACTOR : 1;
  const text = (key: TextKey) => textOf(cfg, key);
  const lines = state.lines;
  const inOrder: Record<string, number> = {};
  for (const l of lines) inOrder[l.productId] = (inOrder[l.productId] ?? 0) + l.qty;
  const total = lines.reduce((s, l) => s + l.qty * l.unit, 0);
  const units = lines.reduce((s, l) => s + l.qty, 0);
  const legacy = opts.legacy ?? null;
  // "לוח מנות": the lanes; "שגר" sends only the fired courses (and the lines with no course).
  const courseNames = opts.courseNames && opts.courseNames.length > 0 ? opts.courseNames : SAMPLE_COURSES;
  const catOf = new Map(baseProducts.map((p) => [p.id, p.categoryId]));
  const courseOf = (l: PLine) => courseOfLine(l, (id) => catOf.get(id) ?? null, menu.categories, courseNames.length);
  const lanes = view.template === 'courses' ? courseLanes(lines, courseNames, state, courseOf) : [];
  const firedLane = (l: PLine) => lanes.length === 0 || lanes.some((lane) => lane.fired && !lane.held && lane.lines.includes(l));
  const toSend = lines.filter((l) => l.status === 'new' && firedLane(l)).reduce((s, l) => s + l.qty, 0);
  // "עגינת תשלום": the sample's "2 קולה ב-₪24" — "חסכתם" shows when an order has a saving.
  const colaPairs = isSample && view.template === 'payDock' ? Math.floor(lines.filter((l) => l.productId === 'p-cola').reduce((s, l) => s + l.qty, 0) / 2) : 0;
  const savings = colaPairs * 400;
  const due = Math.max(0, total - savings);
  const fields = {
    customerName: resolveFieldMode(cfg.fields.customerName, legacy?.fields.customerName ?? null),
    // With no till parameters to read (a preview before the server answers), "auto" shows the
    // service type as optional: today's quick order asks it from the order's details.
    serviceType: resolveFieldMode(cfg.fields.serviceType, legacy ? legacy.fields.serviceType : 'optional'),
    guests: resolveFieldMode(cfg.fields.guests, legacy?.fields.guests ?? null),
  };
  const title = mode === 'table' ? 'שולחן 12' : `${text('orderTitle')} #184`;
  const service = state.serviceType === 'eatIn' ? text('eatIn') : text('takeAway');
  const subtitle =
    mode === 'table'
      ? `4 סועדים · מלצר רן · נפתח 19:42`
      : [fields.serviceType !== 'off' ? service : null, 'לקוח מזדמן', 'קופה 01'].filter(Boolean).join(' · ');

  const items = actionsFor(view, mode, legacy);
  const nextCourse = lanes.find((lane) => lane.course !== null && !lane.fired);
  const required = mode === 'table' ? 'send' : 'pay';
  const actions: PAction[] = [];
  for (const item of items) {
    const base = actionLabelOf(item, cfg);
    if (item.action === 'cashNotes') {
      const notes = quickCashNotes(due, cfg.quickCash.notes, cfg.quickCash.count);
      for (const note of notes) {
        actions.push({
          key: `note-${note}`,
          action: 'note',
          label: formatShekels(note * 100),
          sub: `עודף ${formatShekels(note * 100 - due)}`,
          primary: false,
          disabled: due <= 0,
        });
      }
      continue;
    }
    const primary = item.action === required;
    let label = base;
    let disabled = false;
    let icon: PAction['icon'];
    if (item.action === 'send') {
      icon = 'send';
      if (toSend > 0) label = `${base} · ${toSend} ${text('newSuffix')}`;
      else {
        label = lines.length ? text('allSent') : text('emptyOrder');
        disabled = true;
      }
    } else if (item.action === 'pay') {
      icon = 'card';
      if (mode === 'quick') label = `${base} · ${formatShekels(due)}`;
      disabled = due <= 0;
    } else if (item.action === 'fastCash') {
      icon = 'cash';
      label = `${base} · ${formatShekels(due)}`;
      disabled = due <= 0;
    } else if (item.action === 'fire') {
      // "הכפתור כותב את שם השלב הבא, למשל 'הוצא עיקריות', ומושבת כשאין שלב שממתין."
      if (nextCourse && !item.label?.trim()) label = `הוצא ${nextCourse.name}`;
      disabled = !nextCourse;
    } else if (item.action === 'fastCard') {
      icon = 'card';
      disabled = total <= 0;
    } else if (item.action === 'cashWithChange') {
      icon = 'cash';
      disabled = total <= 0;
    }
    actions.push({ key: item.action, action: item.action, label, primary, disabled, icon });
  }
  // The required button stands first (the start: the right, in Hebrew).
  actions.sort((a, b) => Number(b.primary) - Number(a.primary));

  const byId = new Map(menu.products.map((p) => [p.id, p]));
  const infoProduct = state.infoProduct ? (baseProducts.find((p) => p.id === state.infoProduct) ?? null) : null;
  const favorites = (cfg.bar.favorites ?? []).map((id) => byId.get(id)).filter((p): p is PProduct => !!p);
  const seats = [0, ...Array.from({ length: SEAT_COUNT }, (_, i) => i + 1)].map((seat) => {
    const own = lines.filter((l) => l.seat === seat);
    return {
      seat,
      name: seat === 0 ? text('seatGeneral') : `סועד ${seat}`,
      items: own.reduce((s, l) => s + l.qty, 0),
      total: own.reduce((s, l) => s + l.qty * l.unit, 0),
    };
  });
  const bill = view.billPosition[mode];
  const collapsible = bill === 'sheet' || bill === 'drawer' || (handheld ? bill === 'bottom' : view.summaryCollapsible);
  const summaryOpen =
    state.summaryOpen ?? (cfg.behavior.summary === 'open' ? true : cfg.behavior.summary === 'closed' ? false : !collapsible);

  return {
    cfg,
    view,
    mode,
    profile: view.profile,
    handheld,
    W: view.width,
    H: view.height,
    t: view.template === 'night' ? nightTokens(cfg, opts.brandColor) : tokensFor(cfg, opts.brandColor),
    fs: (sp: number) => Math.round(sp * k * 10) / 10,
    text,
    tileSize: resolveTileSize(view, mode, legacy),
    categories: menu.categories,
    products,
    allProducts: menu.products,
    lines,
    inOrder,
    total,
    units,
    toSend,
    title,
    subtitle,
    fields,
    actions,
    favorites,
    presets: cfg.bar.quantityPresets?.length ? cfg.bar.quantityPresets : [1, 2, 3, 5],
    seats,
    state,
    showImages: view.images !== 'hide',
    lineStatus: cfg.behavior.lineStatus !== false,
    summaryOpen,
    courseNames,
    lanes,
    savings: cfg.payDock?.savings === false ? 0 : savings,
    due,
    dietaryShown: cfg.visual?.dietary === 'show' || (cfg.visual?.dietary !== 'hide' && !!legacy?.showDietaryMarks),
    sample: isSample,
    productText: resolveProductText(cfg.look, legacy?.productText ?? null),
    infoProduct,
    infoCategory: infoProduct?.categoryId ? (baseCategories.find((c) => c.id === infoProduct.categoryId)?.name ?? null) : null,
  };
}

/** Whether a mode of this template has its own "auto" quick bar (payDock's): the till's quick-pay buttons are not it. */
export function templateQuickAuto(template: keyof typeof TEMPLATE_DEFAULTS): boolean {
  return TEMPLATE_DEFAULTS[template].quickActions.length > 0;
}

function clearProfileTemplates(cfg: TillDesignConfig): TillDesignConfig['profiles'] {
  const out = { ...cfg.profiles };
  for (const key of Object.keys(out) as Profile[]) out[key] = { ...out[key], template: null };
  return out;
}

/* -------------------------------------------------------- the order's state */

export type PreviewEvent =
  | { type: 'add'; product: PProduct }
  | { type: 'step'; lineId: string; delta: number }
  | { type: 'category'; id: string | null }
  | { type: 'qty'; n: number }
  | { type: 'seat'; seat: number }
  | { type: 'summary'; open: boolean }
  | { type: 'service'; value: 'takeAway' | 'eatIn' }
  | { type: 'select'; lineId: string }
  | { type: 'fire'; course: number; lineIds: string[]; fired: number[] }
  | { type: 'hold'; course: number }
  | { type: 'drawer'; open: boolean }
  | { type: 'addons'; productId: string | null }
  | { type: 'info'; productId: string | null }
  | { type: 'reset'; state: PreviewState };

/**
 * The preview's order as a small working till: a tap adds the next quantity (then back to 1),
 * to the chosen seat, as a new line; − / + change only new lines; an out-of-stock product adds
 * nothing.
 */
export function reducePreview(state: PreviewState, e: PreviewEvent): PreviewState {
  switch (e.type) {
    case 'add': {
      if (!e.product.available) return state;
      const qty = Math.max(1, state.nextQty);
      const hit = state.lines.find((l) => l.productId === e.product.id && l.status === 'new' && l.seat === state.seat);
      const lines = hit
        ? state.lines.map((l) => (l === hit ? { ...l, qty: l.qty + qty } : l))
        : [
            ...state.lines,
            {
              id: `n${state.lines.length + 1}-${e.product.id}`,
              productId: e.product.id,
              name: e.product.name,
              qty,
              unit: e.product.price,
              note: null,
              seat: state.seat,
              status: 'new' as const,
            },
          ];
      // A new product closes the selected line's strip and opens its quick add-ons ("לילה").
      return { ...state, lines, nextQty: 1, selectedLine: null, lastAdded: e.product.id };
    }
    case 'step': {
      const lines = state.lines
        .map((l) => (l.id === e.lineId && l.status === 'new' ? { ...l, qty: l.qty + e.delta } : l))
        .filter((l) => l.qty > 0);
      return { ...state, lines };
    }
    case 'category':
      return { ...state, category: e.id };
    case 'qty':
      return { ...state, nextQty: e.n };
    case 'seat':
      return { ...state, seat: e.seat };
    case 'summary':
      return { ...state, summaryOpen: e.open };
    case 'service':
      return { ...state, serviceType: e.value };
    case 'select':
      return { ...state, selectedLine: state.selectedLine === e.lineId ? null : e.lineId };
    case 'fire': {
      // "הוצא": the course goes out — its new lines are sent, it is no longer held.
      const ids = new Set(e.lineIds);
      const lines = state.lines.map((l) => (ids.has(l.id) && l.status === 'new' ? { ...l, status: 'sent' as const, ready: false } : l));
      return {
        ...state,
        lines,
        fired: Array.from(new Set([...e.fired, e.course])),
        firedNow: [...(state.firedNow ?? []), e.course],
        held: (state.held ?? []).filter((c) => c !== e.course),
      };
    }
    case 'hold':
      return { ...state, held: Array.from(new Set([...(state.held ?? []), e.course])) };
    case 'drawer':
      return { ...state, drawerOpen: e.open };
    case 'addons':
      return { ...state, lastAdded: e.productId };
    case 'info':
      return { ...state, infoProduct: e.productId };
    case 'reset':
      return e.state;
    default:
      return state;
  }
}
