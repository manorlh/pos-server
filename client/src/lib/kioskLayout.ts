/**
 * "מבנה הקיוסק" (config `layout`, docs/SPEC_KIOSK_LAYOUTS.md): WHERE things sit and HOW the order
 * goes, beside "סגנון ממשק" (`theme.uiStyle`, how it LOOKS) — two independent axes, every layout in
 * every style. `standard` (the default) is the kiosk of today, key for key, so nothing changes until
 * a business picks another layout.
 *
 * Resolution, as the server's (app/services/kiosk_config.py) and the till's (domain/KioskLayout.kt):
 *
 *     DEFAULTS ⊕ presetLayer(uiStyle) ⊕ layoutTemplateLayer(template) ⊕ company ⊕ shop ⊕ kiosk
 *
 * The three tables (vocabulary, defaults, KIOSK_LAYOUT_TEMPLATES) are pinned by the shared golden
 * fixture `server/tests/fixtures/kiosk_layout_templates.json` (the same bytes in pos-android), which
 * kioskLayout.test.ts compares with these tables and whose cases it runs.
 *
 * Pure, no React; only TYPES from kioskConfig (no runtime cycle).
 */

import type { KioskConfig, KioskLayer } from './kioskConfig';

/* ------------------------------------------------------------ vocabulary */

export type LayoutTemplate = 'standard' | 'guided' | 'tabs' | 'landing' | 'fastfood' | 'cafe' | 'combo' | 'list' | 'magazine' | 'wall';
export type LayoutCatalog = 'rail' | 'top' | 'landing' | 'list' | 'shelves' | 'magazine' | 'wall';
export type LayoutCategoryIcons = 'photo' | 'line' | 'filled' | 'duotone' | 'emoji' | 'none';
export type LayoutRailSize = 's' | 'm' | 'l';
export type LayoutLandingColumns = 2 | 3 | 4;
/** "גודל מוצרים": the dishes' cards — s smaller (a column more), m as today, l larger (a column fewer). */
export type LayoutProductSize = 's' | 'm' | 'l';
export type LayoutHero = 'off' | 'manual' | 'auto';
export type LayoutCard = 'tile' | 'row' | 'plate' | 'bleed' | 'button' | 'outlined';
export type LayoutFlow = 'free' | 'guided';
export type LayoutItemView = 'sheet' | 'full' | 'modal' | 'inline' | 'steps' | 'popover';
export type LayoutQuickAdd = 'off' | 'no_required' | 'always';
export type LayoutMealView = 'sheet' | 'steps' | 'tray';
export type LayoutMealUpsell = 'off' | 'first' | 'after';
export type LayoutBasket = 'bar' | 'panel' | 'summary' | 'fab' | 'drawer' | 'receipt';
export type LayoutService = 'cards' | 'split' | 'rows' | 'sheet';
export type LayoutName = 'card' | 'dock' | 'avatar';
export type LayoutReach = 'normal' | 'low';

export const LAYOUT_TEMPLATES: LayoutTemplate[] = ['standard', 'guided', 'tabs', 'landing', 'fastfood', 'cafe', 'combo', 'list', 'magazine', 'wall'];
export const LAYOUT_CATALOGS: LayoutCatalog[] = ['rail', 'top', 'landing', 'list', 'shelves', 'magazine', 'wall'];
export const LAYOUT_CATEGORY_ICONS: LayoutCategoryIcons[] = ['photo', 'line', 'filled', 'duotone', 'emoji', 'none'];
export const LAYOUT_RAIL_SIZES: LayoutRailSize[] = ['s', 'm', 'l'];
export const LAYOUT_LANDING_COLUMNS: LayoutLandingColumns[] = [2, 3, 4];
export const LAYOUT_PRODUCT_SIZES: LayoutProductSize[] = ['s', 'm', 'l'];
export const LAYOUT_HEROES: LayoutHero[] = ['off', 'manual', 'auto'];
export const LAYOUT_CARDS: LayoutCard[] = ['tile', 'row', 'plate', 'bleed', 'button', 'outlined'];
export const LAYOUT_FLOWS: LayoutFlow[] = ['free', 'guided'];
export const LAYOUT_ITEM_VIEWS: LayoutItemView[] = ['sheet', 'full', 'modal', 'inline', 'steps', 'popover'];
export const LAYOUT_QUICK_ADDS: LayoutQuickAdd[] = ['off', 'no_required', 'always'];
export const LAYOUT_MEAL_VIEWS: LayoutMealView[] = ['sheet', 'steps', 'tray'];
export const LAYOUT_MEAL_UPSELLS: LayoutMealUpsell[] = ['off', 'first', 'after'];
export const LAYOUT_BASKETS: LayoutBasket[] = ['bar', 'panel', 'summary', 'fab', 'drawer', 'receipt'];
export const LAYOUT_SERVICES: LayoutService[] = ['cards', 'split', 'rows', 'sheet'];
export const LAYOUT_NAMES: LayoutName[] = ['card', 'dock', 'avatar'];
export const LAYOUT_REACHES: LayoutReach[] = ['normal', 'low'];

/** The vocabulary per key, as the fixture's `vocabulary` (validation, the editor's choices). */
export const LAYOUT_VOCABULARY = {
  template: LAYOUT_TEMPLATES,
  catalog: LAYOUT_CATALOGS,
  categoryIcons: LAYOUT_CATEGORY_ICONS,
  railSize: LAYOUT_RAIL_SIZES,
  landingColumns: LAYOUT_LANDING_COLUMNS,
  productSize: LAYOUT_PRODUCT_SIZES,
  hero: LAYOUT_HEROES,
  card: LAYOUT_CARDS,
  flow: LAYOUT_FLOWS,
  itemView: LAYOUT_ITEM_VIEWS,
  quickAdd: LAYOUT_QUICK_ADDS,
  mealView: LAYOUT_MEAL_VIEWS,
  mealUpsell: LAYOUT_MEAL_UPSELLS,
  basket: LAYOUT_BASKETS,
  service: LAYOUT_SERVICES,
  name: LAYOUT_NAMES,
  reach: LAYOUT_REACHES,
} as const;

export interface KioskLayout {
  /** The layout's template (as uiStyle for the look): fills the other keys; a value set in a layer wins. */
  template: LayoutTemplate;
  /** Where the categories are; null — as today, by theme.categoryLayout (side → the rail, top → the strip). */
  catalog: LayoutCatalog | null;
  /** The category's icon; null — as today (its picture, else its initial). */
  categoryIcons: LayoutCategoryIcons | null;
  /** rail: 12 / 8 / 6 categories on the screen. */
  railSize: LayoutRailSize;
  /** landing: the tiles' columns. */
  landingColumns: LayoutLandingColumns;
  /** "גודל מוצרים": the dishes' cards in every catalog (productColumns) — m as today. */
  productSize: LayoutProductSize;
  /** landing: "8 מנות" under each tile. */
  landingShowCounts: boolean;
  /** shelves / top: a banner of catalog.featuredProductIds (manual — it never turns by itself). */
  hero: LayoutHero;
  /** magazine: dish after dish, scrolling. */
  magazineFeed: boolean;
  /** A dish's card; null — as today (a tile). */
  card: LayoutCard | null;
  /** guided: one decision per screen, a step bar. */
  flow: LayoutFlow;
  /** The dish's window; sheet — as today. */
  itemView: LayoutItemView;
  /** A tap on a dish with nothing required adds it (wall: always). */
  quickAdd: LayoutQuickAdd;
  /** A meal: its steps in the sheet (today), or a tray filling up. */
  mealView: LayoutMealView;
  /** "רוצים להפוך לארוחה?" before the customisation (first), after it (after), or not. */
  mealUpsell: LayoutMealUpsell;
  /** The basket while ordering; null — as today, by theme.cartStyle (bar | panel). */
  basket: LayoutBasket | null;
  /** "לקחת / לשבת" as its own screen. */
  service: LayoutService;
  /** The name's screen. */
  name: LayoutName;
  /** avatar: the nicknames offered (emoji + a name); empty — the built-in six. */
  nameAvatars: string[];
  /** Accessibility: low — every control in the bottom half, the top half display only. */
  reach: LayoutReach;
  /** A ♿ button that turns `reach` over for the current customer (back as configured at the end of the order). */
  reachToggle: boolean;
}

/** What a kiosk gets when no level sets anything: the layout of today (template standard). */
export const KIOSK_LAYOUT_DEFAULTS: KioskLayout = {
  template: 'standard',
  catalog: null,
  categoryIcons: null,
  railSize: 'm',
  landingColumns: 3,
  productSize: 'm',
  landingShowCounts: true,
  hero: 'off',
  magazineFeed: false,
  card: null,
  flow: 'free',
  itemView: 'sheet',
  quickAdd: 'off',
  mealView: 'sheet',
  mealUpsell: 'off',
  basket: null,
  service: 'cards',
  name: 'card',
  nameAvatars: [],
  reach: 'normal',
  reachToggle: false,
};

/** The keys a template decides (every layout key but the template itself). */
export const LAYOUT_TEMPLATE_KEYS = (Object.keys(KIOSK_LAYOUT_DEFAULTS) as Array<keyof KioskLayout>).filter((k) => k !== 'template');

/**
 * KIOSK_LAYOUT_TEMPLATES — the server's LAYOUT_TEMPLATES and the till's KioskLayoutTemplates, key
 * for key: each a layer between the style's preset and the stored layers. A template may also set
 * a key of another section (tabs: one scrolling menu; list: the search).
 */
export const KIOSK_LAYOUT_TEMPLATES: Record<LayoutTemplate, KioskLayer> = {
  standard: { layout: {} },
  guided: {
    layout: { catalog: 'landing', categoryIcons: 'line', flow: 'guided', itemView: 'steps', basket: 'bar', service: 'cards', name: 'card', card: 'row', landingColumns: 2 },
  },
  tabs: {
    layout: { catalog: 'top', categoryIcons: 'filled', itemView: 'full', basket: 'bar', service: 'sheet', name: 'card' },
    catalog: { oneCategory: false },
  },
  landing: {
    layout: { catalog: 'landing', categoryIcons: 'duotone', itemView: 'modal', basket: 'summary', service: 'cards', name: 'card', landingColumns: 3 },
  },
  fastfood: {
    layout: { catalog: 'rail', categoryIcons: 'photo', itemView: 'sheet', basket: 'summary', service: 'split', name: 'card', railSize: 'l', mealUpsell: 'first', card: 'plate' },
  },
  cafe: {
    layout: { catalog: 'shelves', categoryIcons: 'emoji', itemView: 'full', basket: 'fab', service: 'rows', name: 'avatar', hero: 'manual' },
  },
  combo: {
    layout: { catalog: 'top', categoryIcons: 'filled', itemView: 'sheet', basket: 'summary', service: 'cards', name: 'card', mealView: 'tray' },
  },
  list: {
    layout: { catalog: 'list', categoryIcons: 'none', itemView: 'inline', basket: 'drawer', service: 'cards', name: 'dock' },
    general: { searchEnabled: true },
  },
  magazine: {
    layout: { catalog: 'magazine', categoryIcons: 'none', itemView: 'full', basket: 'bar', service: 'rows', name: 'card', magazineFeed: true },
  },
  wall: {
    layout: { catalog: 'wall', categoryIcons: 'emoji', itemView: 'popover', basket: 'receipt', name: 'avatar', quickAdd: 'always' },
  },
};

/**
 * The templates this build draws (the dashboard offers only these): all ten — phase 2 added cafe,
 * combo, list, magazine and wall. A config naming one a kiosk does not draw falls back to the
 * categories as theme.categoryLayout says (what an older kiosk shows).
 */
export const LAYOUT_TEMPLATES_READY: LayoutTemplate[] = ['standard', 'guided', 'tabs', 'landing', 'fastfood', 'cafe', 'combo', 'list', 'magazine', 'wall'];

/** What an older kiosk (no `layout`) reads: theme.categoryLayout / theme.cartStyle from the layout. */
export const LAYOUT_BACK_COMPAT: {
  categoryLayout: Record<LayoutCatalog, 'side' | 'top'>;
  cartStyle: Record<LayoutBasket, 'bar' | 'panel'>;
} = {
  categoryLayout: { rail: 'side', top: 'top', landing: 'side', list: 'side', shelves: 'top', magazine: 'side', wall: 'side' },
  cartStyle: { bar: 'bar', panel: 'panel', summary: 'bar', fab: 'bar', drawer: 'bar', receipt: 'bar' },
};

export const LAYOUT_LIMITS = { nameAvatarsMax: 12, nameAvatarMax: 24 } as const;

/* ------------------------------------------------------------ "ברוכים הבאים" */

export type WelcomePosition = 'top' | 'middle' | 'bottom';
export type WelcomeAlign = 'start' | 'center' | 'end';
export type WelcomeSize = 's' | 'm' | 'l' | 'xl';
export type WelcomeWeight = 'regular' | 'bold' | 'black';
export type WelcomeBackdrop = 'scrim' | 'card' | 'blur' | 'none';

export const WELCOME_POSITIONS: WelcomePosition[] = ['top', 'middle', 'bottom'];
export const WELCOME_ALIGNS: WelcomeAlign[] = ['start', 'center', 'end'];
export const WELCOME_SIZES: WelcomeSize[] = ['s', 'm', 'l', 'xl'];
export const WELCOME_WEIGHTS: WelcomeWeight[] = ['regular', 'bold', 'black'];
export const WELCOME_BACKDROPS: WelcomeBackdrop[] = ['scrim', 'card', 'blur', 'none'];

/** The attract screen's "ברוכים הבאים" block (texts.attractTitle / attractSubtitle). */
export interface KioskWelcome {
  enabled: boolean;
  /** bottom: in the stack above the button (today); top: under the header; middle: in the middle. */
  position: WelcomePosition;
  /** start: right in Hebrew. */
  align: WelcomeAlign;
  /** l: displayMedium of today. */
  size: WelcomeSize;
  /** black: ExtraBold of today. */
  weight: WelcomeWeight;
  /** null: white over the media (today). */
  titleColor: string | null;
  /** null: the title's colour at 90%. */
  subtitleColor: string | null;
  backdrop: WelcomeBackdrop;
  showSubtitle: boolean;
  /** 40–100: the block's width, a percent of the screen's content width. */
  maxWidthPct: number;
}

/** The block of today: under it nothing changes until a business moves it. */
export const KIOSK_WELCOME_DEFAULTS: KioskWelcome = {
  enabled: true,
  position: 'bottom',
  align: 'start',
  size: 'l',
  weight: 'black',
  titleColor: null,
  subtitleColor: null,
  backdrop: 'scrim',
  showSubtitle: true,
  maxWidthPct: 100,
};

/** The title's size per `size`, in sp (the subtitle's beside it): l = displayMedium (42 / 22). */
export const WELCOME_SIZE_SP: Record<WelcomeSize, { title: number; subtitle: number }> = {
  s: { title: 28, subtitle: 16 },
  m: { title: 34, subtitle: 18 },
  l: { title: 42, subtitle: 22 },
  xl: { title: 54, subtitle: 26 },
};

export const WELCOME_WEIGHT_CSS: Record<WelcomeWeight, number> = { regular: 400, bold: 700, black: 800 };

/**
 * Where the block goes among the attract sections: in `position`'s area, at the place `welcome`
 * has in `attract.sections` (a list from before `welcome` existed: first, as today); null — hidden.
 */
export function welcomePlacement(
  welcome: Pick<KioskWelcome, 'enabled' | 'position'> | undefined,
  sections: readonly string[],
): { position: WelcomePosition; index: number } | null {
  const w = welcome ?? KIOSK_WELCOME_DEFAULTS;
  if (!w.enabled) return null;
  const stack = sections.filter((s) => s === 'welcome' || s === 'categories' || s === 'club');
  const at = stack.indexOf('welcome');
  return { position: w.position, index: at < 0 ? 0 : at };
}

/**
 * The attract screen's stacked blocks (categories, club and — when it goes at the bottom — welcome)
 * in their order: "welcome" where it is in attract.sections, first when the list has none of it.
 */
export function attractStackOrderIds(sections: readonly string[], welcome: Pick<KioskWelcome, 'enabled' | 'position'> | undefined): string[] {
  const stack: string[] = sections.filter((s) => s === 'categories' || s === 'club');
  const place = welcomePlacement(welcome, sections);
  if (!place || place.position !== 'bottom') return stack;
  const out = stack.slice();
  out.splice(Math.min(place.index, out.length), 0, 'welcome');
  return out;
}

/* ------------------------------------------------------------ resolution */

type Dict = { [key: string]: unknown };

function isDict(v: unknown): v is Dict {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

function at(obj: unknown, path: string): unknown {
  let cur = obj;
  for (const part of path.split('.')) {
    if (!isDict(cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

export function isLayoutTemplate(v: unknown): v is LayoutTemplate {
  return typeof v === 'string' && (LAYOUT_TEMPLATES as string[]).includes(v);
}

/** The template the layers pick: the last that sets `layout.template` (a known one), else standard. */
export function templateOf(...layers: Array<KioskLayer | null | undefined>): LayoutTemplate {
  let t: LayoutTemplate = KIOSK_LAYOUT_DEFAULTS.template;
  for (const layer of layers) {
    const picked = at(layer, 'layout.template');
    if (isLayoutTemplate(picked)) t = picked;
  }
  return t;
}

/** A template as a layer (a copy): its layout keys and the few keys of other sections it sets. */
export function layoutTemplateLayer(template: LayoutTemplate): KioskLayer {
  return clone(KIOSK_LAYOUT_TEMPLATES[template] ?? KIOSK_LAYOUT_TEMPLATES.standard);
}

/**
 * The cross-field rules (`repairKioskConfig` calls this on its copy): a known template; guided
 * never with an inline / popover dish; a wall adds on a tap; reach low makes the add-to-cart a
 * bounce (a flight would cross the display half). And what an older kiosk reads — the categories'
 * place and the basket — written from the layout when the layout says.
 */
export function repairLayout(cfg: KioskConfig): void {
  const l = cfg.layout;
  if (!isDict(l)) return;
  if (!isLayoutTemplate(l.template)) l.template = 'standard';
  if (l.flow === 'guided' && (l.itemView === 'inline' || l.itemView === 'popover')) l.itemView = 'steps';
  if (l.catalog === 'wall' && l.quickAdd === 'off') l.quickAdd = 'no_required';
  if (l.reach === 'low' && cfg.motion && cfg.motion.addToCart === 'fly') cfg.motion.addToCart = 'bounce';
  if (l.catalog && LAYOUT_BACK_COMPAT.categoryLayout[l.catalog]) cfg.theme.categoryLayout = LAYOUT_BACK_COMPAT.categoryLayout[l.catalog];
  if (l.basket && LAYOUT_BACK_COMPAT.cartStyle[l.basket]) cfg.theme.cartStyle = LAYOUT_BACK_COMPAT.cartStyle[l.basket];
}

/** Where a template decides values (rebase / switch, as the style's PRESET_SECTIONS). */
const TEMPLATE_SECTIONS: Array<{ path: string; keys: readonly string[] }> = [
  { path: 'layout', keys: LAYOUT_TEMPLATE_KEYS as readonly string[] },
  { path: 'catalog', keys: ['oneCategory'] },
  { path: 'general', keys: ['searchEnabled'] },
];

function templateValue(template: LayoutTemplate, path: string, key: string, defaults: Dict): unknown {
  const fromTemplate = at(KIOSK_LAYOUT_TEMPLATES[template] ?? {}, `${path}.${key}`);
  return fromTemplate !== undefined ? fromTemplate : at(defaults, `${path}.${key}`);
}

/**
 * What a level inherits once it picks `template` (after `rebaseInherited` for the style): every key
 * a template decides that the parents do not set explicitly follows `template`. `defaults` is
 * KIOSK_DEFAULTS (passed in: no runtime import of kioskConfig).
 */
export function rebaseLayout(
  inherited: KioskConfig,
  inheritedLayers: KioskLayer | null | undefined,
  template: LayoutTemplate,
  defaults: KioskConfig,
): KioskConfig {
  const out = clone(inherited);
  const parent: LayoutTemplate = isLayoutTemplate(inherited.layout?.template) ? inherited.layout.template : 'standard';
  const target: LayoutTemplate = isLayoutTemplate(template) ? template : 'standard';
  for (const section of TEMPLATE_SECTIONS) {
    const now = at(inherited, section.path);
    const into = at(out, section.path);
    if (!isDict(now) || !isDict(into)) continue;
    const explicit = inheritedLayers ? at(inheritedLayers, section.path) : null;
    for (const key of section.keys) {
      const keep = inheritedLayers
        ? isDict(explicit) && explicit[key] !== undefined && explicit[key] !== null
        : JSON.stringify(now[key] ?? null) !== JSON.stringify(templateValue(parent, section.path, key, defaults as unknown as Dict) ?? null);
      if (!keep) into[key] = clone(templateValue(target, section.path, key, defaults as unknown as Dict));
    }
  }
  return out;
}

/** Switch the draft to another template: every template key that followed the old base moves to the new base's. */
export function switchLayoutTemplate(draft: KioskConfig, oldBase: KioskConfig, newBase: KioskConfig, template: LayoutTemplate): KioskConfig {
  const out = clone(draft);
  if (!isDict(out.layout)) (out as unknown as Dict).layout = clone(KIOSK_LAYOUT_DEFAULTS);
  out.layout.template = template;
  for (const section of TEMPLATE_SECTIONS) {
    const was = at(draft, section.path);
    const oldB = at(oldBase, section.path);
    const newB = at(newBase, section.path);
    const into = at(out, section.path);
    if (!isDict(oldB) || !isDict(newB) || !isDict(into)) continue;
    for (const key of section.keys) {
      const current = isDict(was) ? was[key] : undefined;
      if (JSON.stringify(current ?? null) === JSON.stringify(oldB[key] ?? null)) into[key] = clone(newB[key]);
    }
  }
  return out;
}

/* ------------------------------------------------------------ validation */

export interface LayoutIssue {
  path: string;
  code: string;
  params?: Record<string, string | number>;
}

function checkIn(out: LayoutIssue[], path: string, v: unknown, allowed: readonly unknown[], nullable = false): void {
  if (v === null && nullable) return;
  if (!allowed.includes(v as never)) out.push({ path, code: 'enum' });
}

const HEX = /^#[0-9A-Fa-f]{6}$/;

/** The layout's and the welcome block's own rules (validateKioskConfig adds them). */
export function validateLayout(cfg: Pick<KioskConfig, 'layout' | 'attract'>): LayoutIssue[] {
  const out: LayoutIssue[] = [];
  const l = cfg.layout;
  if (l !== undefined) {
    if (!isDict(l)) out.push({ path: 'layout', code: 'enum' });
    else {
      const p = (k: string) => `layout.${k}`;
      checkIn(out, p('template'), l.template, LAYOUT_TEMPLATES);
      checkIn(out, p('catalog'), l.catalog, LAYOUT_CATALOGS, true);
      checkIn(out, p('categoryIcons'), l.categoryIcons, LAYOUT_CATEGORY_ICONS, true);
      checkIn(out, p('railSize'), l.railSize, LAYOUT_RAIL_SIZES);
      checkIn(out, p('landingColumns'), l.landingColumns, LAYOUT_LANDING_COLUMNS);
      checkIn(out, p('productSize'), l.productSize, LAYOUT_PRODUCT_SIZES);
      checkIn(out, p('hero'), l.hero, LAYOUT_HEROES);
      checkIn(out, p('card'), l.card, LAYOUT_CARDS, true);
      checkIn(out, p('flow'), l.flow, LAYOUT_FLOWS);
      checkIn(out, p('itemView'), l.itemView, LAYOUT_ITEM_VIEWS);
      checkIn(out, p('quickAdd'), l.quickAdd, LAYOUT_QUICK_ADDS);
      checkIn(out, p('mealView'), l.mealView, LAYOUT_MEAL_VIEWS);
      checkIn(out, p('mealUpsell'), l.mealUpsell, LAYOUT_MEAL_UPSELLS);
      checkIn(out, p('basket'), l.basket, LAYOUT_BASKETS, true);
      checkIn(out, p('service'), l.service, LAYOUT_SERVICES);
      checkIn(out, p('name'), l.name, LAYOUT_NAMES);
      checkIn(out, p('reach'), l.reach, LAYOUT_REACHES);
      for (const k of ['landingShowCounts', 'magazineFeed', 'reachToggle'] as const) {
        if (typeof l[k] !== 'boolean') out.push({ path: p(k), code: 'enum' });
      }
      const avatars = l.nameAvatars;
      if (!Array.isArray(avatars) || avatars.some((a) => typeof a !== 'string' || a.trim() === '')) out.push({ path: p('nameAvatars'), code: 'enum' });
      else if (avatars.length > LAYOUT_LIMITS.nameAvatarsMax) out.push({ path: p('nameAvatars'), code: 'tooMany', params: { max: LAYOUT_LIMITS.nameAvatarsMax } });
      else if (avatars.some((a) => a.length > LAYOUT_LIMITS.nameAvatarMax)) out.push({ path: p('nameAvatars'), code: 'tooLong', params: { max: LAYOUT_LIMITS.nameAvatarMax } });
      else if (new Set(avatars).size !== avatars.length) out.push({ path: p('nameAvatars'), code: 'duplicate' });
    }
  }
  const w = (cfg.attract as unknown as Dict | undefined)?.welcome;
  if (w !== undefined) {
    if (!isDict(w)) out.push({ path: 'attract.welcome', code: 'enum' });
    else {
      const p = (k: string) => `attract.welcome.${k}`;
      checkIn(out, p('position'), w.position, WELCOME_POSITIONS);
      checkIn(out, p('align'), w.align, WELCOME_ALIGNS);
      checkIn(out, p('size'), w.size, WELCOME_SIZES);
      checkIn(out, p('weight'), w.weight, WELCOME_WEIGHTS);
      checkIn(out, p('backdrop'), w.backdrop, WELCOME_BACKDROPS);
      for (const k of ['enabled', 'showSubtitle'] as const) if (typeof w[k] !== 'boolean') out.push({ path: p(k), code: 'enum' });
      for (const k of ['titleColor', 'subtitleColor'] as const) {
        if (w[k] !== null && !(typeof w[k] === 'string' && HEX.test(w[k] as string))) out.push({ path: p(k), code: 'color' });
      }
      const pct = w.maxWidthPct;
      if (typeof pct !== 'number' || !Number.isInteger(pct) || pct < 40 || pct > 100) out.push({ path: p('maxWidthPct'), code: 'range', params: { min: 40, max: 100 } });
    }
  }
  return out;
}

/* ------------------------------------------------------------ what the screens draw */

/** A layout as the screens use it: a config from before `layout` existed is today's. */
export function layoutOf(cfg: Pick<KioskConfig, 'layout'> | null | undefined): KioskLayout {
  const l = (cfg?.layout ?? null) as Partial<KioskLayout> | null;
  return l ? { ...KIOSK_LAYOUT_DEFAULTS, ...l } : KIOSK_LAYOUT_DEFAULTS;
}

/** The catalogs this build draws itself: all of them since phase 2 (null is today's screen). */
export const LAYOUT_CATALOGS_READY: LayoutCatalog[] = ['rail', 'top', 'landing', 'list', 'shelves', 'magazine', 'wall'];

/**
 * The values of each key this build draws (the editor offers the others as "בקרוב"); a key not
 * listed — every value. Still to come: the cards bleed / button / outlined, the meal's own steps,
 * "להפוך לארוחה?" after the add, and the service / name screens' variants (today's screens).
 */
export const LAYOUT_VALUES_READY: Partial<Record<keyof KioskLayout, readonly unknown[]>> = {
  template: LAYOUT_TEMPLATES_READY,
  catalog: [null, ...LAYOUT_CATALOGS_READY],
  card: [null, 'tile', 'row', 'plate'],
  mealView: ['sheet', 'tray'],
  mealUpsell: ['off', 'first'],
  service: ['cards'],
  name: ['card'],
};

/** Whether this build draws `value` for `key`. */
export function layoutValueReady(key: keyof KioskLayout, value: unknown): boolean {
  const ready = LAYOUT_VALUES_READY[key];
  return !ready || ready.includes(value);
}

/**
 * The catalog to draw: null — today's screen (the rail or the strip of theme.categoryLayout); else
 * the layout's own, when this build draws it.
 */
export function catalogKindOf(cfg: Pick<KioskConfig, 'layout'>): LayoutCatalog | null {
  const c = layoutOf(cfg).catalog;
  return c && LAYOUT_CATALOGS_READY.includes(c) ? c : null;
}

/** The side panel needs this much width (as cartPanelShown / the till's KioskCategoryLayout.cartPanel). */
const PANEL_MIN_DP = 900;

export type BasketKind = 'bar' | 'panel' | 'summary' | 'fab' | 'drawer' | 'receipt';

/**
 * The basket while ordering on a screen `widthDp` wide: null — as today (theme.cartStyle); a panel
 * on a narrow screen — the summary bar; fab (a round button at the end corner), drawer (the bar
 * opens the order from the side) and receipt (the lines docked under the menu) as they are.
 */
export function basketKindOf(cfg: Pick<KioskConfig, 'layout' | 'theme'>, widthDp: number): BasketKind {
  const b = layoutOf(cfg).basket;
  if (b === null) return cfg.theme.cartStyle === 'panel' && widthDp >= PANEL_MIN_DP ? 'panel' : 'bar';
  if (b === 'panel') return widthDp >= PANEL_MIN_DP ? 'panel' : 'summary';
  if (b === 'summary' || b === 'fab' || b === 'drawer' || b === 'receipt') return b;
  return 'bar';
}

/** A basket docked under the menu (the screen's column ends on it): the order bar, the receipt. */
export function basketDocked(kind: string): boolean {
  return kind === 'summary' || kind === 'receipt';
}

/** A basket floating over the dishes' bottom: the bar, the round button, the drawer's bar. */
export function basketFloats(kind: string): boolean {
  return kind === 'bar' || kind === 'fab' || kind === 'drawer';
}

/**
 * The dish's window: sheet (today) / modal / full / steps, and the compact window — inline (the list)
 * and popover (the wall): the choices and the add, without the big picture.
 */
export function itemViewOf(cfg: Pick<KioskConfig, 'layout'>): 'sheet' | 'modal' | 'full' | 'steps' | 'inline' | 'popover' {
  const v = layoutOf(cfg).itemView;
  return v === 'modal' || v === 'full' || v === 'steps' || v === 'inline' || v === 'popover' ? v : 'sheet';
}

/** A meal's window: its slots in the window of today, or the tray filling up a slot at a time (combo). */
export function mealViewOf(cfg: Pick<KioskConfig, 'layout'>): 'sheet' | 'tray' {
  return layoutOf(cfg).mealView === 'tray' ? 'tray' : 'sheet';
}

/** The catalogs that carry "באנר מומלצים" (layout.hero): the shelves and the tabs' one menu. */
export const HERO_CATALOGS: LayoutCatalog[] = ['shelves', 'top'];

/** "באנר מומלצים" on screen: on (manual — still; auto — turning by itself), the catalog carries it, something featured. */
export function heroShown(cfg: Pick<KioskConfig, 'layout'>, featured: number): boolean {
  const l = layoutOf(cfg);
  const kind = catalogKindOf(cfg);
  return l.hero !== 'off' && featured > 0 && kind !== null && HERO_CATALOGS.includes(kind);
}

/** hero = auto: the banner turns to its next dish this often (never while it is touched). */
export const HERO_TURN_MS = 5000;

/**
 * A tap on a dish where the layout adds on a tap: quickAdd "always" puts in a dish whose required
 * choices its defaults answer; a meal and a choice with no default still open their window (the
 * Android kiosk's KioskLayouts.addPathOnTap).
 */
export function addPathOnTap(path: 'direct' | 'sheet' | 'none', quickAdd: LayoutQuickAdd, meal: boolean, defaultsComplete: boolean): 'direct' | 'sheet' | 'none' {
  return path === 'sheet' && quickAdd === 'always' && !meal && defaultsComplete ? 'direct' : path;
}

/** shelves: a card's width (dp) so a shelf shows about 2.4 of them at "m" — the till's KioskLayouts.shelfCardDp. */
export function shelfCardDp(widthDp: number, size: LayoutProductSize | null | undefined): number {
  const acrossTenths = size === 's' ? 33 : size === 'l' ? 17 : 24;
  return Math.min(460, Math.max(150, Math.floor(((widthDp - 20) * 10) / acrossTenths) - 14));
}

/** list: one column on a portrait kiosk, two from 1000 dp. */
export function listColumns(widthDp: number): number {
  return widthDp >= 1000 ? 2 : 1;
}

/** magazine: a dish's page in a feed `heightDp` tall — most of it, the next one peeking. */
export function storyHeightDp(heightDp: number, size: LayoutProductSize | null | undefined): number {
  const percent = size === 's' ? 62 : size === 'l' ? 90 : 78;
  return Math.min(1400, Math.max(320, Math.floor((heightDp * percent) / 100)));
}

/** wall: the buttons across a screen `widthDp` wide — three on a portrait kiosk — moved by "גודל מוצרים". */
export function wallColumns(widthDp: number, size: LayoutProductSize | null | undefined): number {
  return productColumns(widthDp >= 1100 ? 5 : widthDp >= 600 ? 3 : 2, size, widthDp);
}

/** receipt: the lines it shows before it scrolls. */
export const RECEIPT_LINES = 4;

/** A dish's card: tile (today), row, plate; the others (phase 2) — a tile. */
export function cardKindOf(cfg: Pick<KioskConfig, 'layout'>): 'tile' | 'row' | 'plate' {
  const c = layoutOf(cfg).card;
  return c === 'row' || c === 'plate' ? c : 'tile';
}

/** The accessible mode now: as configured, turned over by the customer's ♿ (only where the toggle is on). */
export function reachLow(cfg: Pick<KioskConfig, 'layout'>, toggled: boolean): boolean {
  const l = layoutOf(cfg);
  const low = l.reach === 'low';
  return l.reachToggle && toggled ? !low : low;
}

/** The share of the screen's height kept for display only in the accessible mode (the top half). */
export const REACH_DISPLAY_SHARE = 0.5;

/** rail: how many categories one screen shows (s 12, m 8, l 6). */
export const RAIL_COUNT: Record<LayoutRailSize, number> = { s: 12, m: 8, l: 6 };

/**
 * The photo rail's measures on a screen `widthDp` × `heightDp`, the rail `availableDp` tall: each
 * item's height (count per screen), the rail's width (wider for a bigger size, never more than 30%
 * of the screen), and the picture inside.
 */
export function railMeasures(size: LayoutRailSize, widthDp: number, availableDp: number): { itemDp: number; widthDp: number; imageDp: number } {
  const count = RAIL_COUNT[size] ?? RAIL_COUNT.m;
  const itemDp = Math.max(64, Math.floor(availableDp / count));
  const share = size === 'l' ? 0.27 : size === 'm' ? 0.22 : 0.17;
  const width = Math.round(Math.min(Math.max(widthDp * share, 84), widthDp * 0.3));
  const imageDp = Math.max(36, Math.min(width - 20, itemDp - 40));
  return { itemDp, widthDp: width, imageDp };
}

/**
 * "גודל מוצרים" on a catalog's dish grid: `base` — the columns the layout gives at "m" (today) —
 * moved by the size: s a column more (smaller cards), l a column fewer (larger) but never under two
 * tiles across from a 400 dp grid (one under it); rows (`row` cards) keep theirs. The Android
 * kiosk's KioskLayouts.productColumns, number for number.
 */
export function productColumns(base: number, size: LayoutProductSize | null | undefined, widthDp: number, rows = false): number {
  if (rows) return base;
  if (size === 's') return base + 1;
  if (size === 'l') return Math.max(Math.min(base, widthDp >= 400 ? 2 : 1), base - 1);
  return base;
}

/** landing: the tiles' columns on a screen `widthDp` wide (never more than fit 120 dp tiles). */
export function landingColumnsFor(cfg: Pick<KioskConfig, 'layout'>, widthDp: number): number {
  const want = layoutOf(cfg).landingColumns;
  return Math.max(2, Math.min(want, Math.floor(widthDp / 120)));
}

/* ------------------------------------------------------------ the guided steps */

export type GuidedStep = 'service' | 'menu' | 'basket' | 'tip' | 'details' | 'payMethod' | 'pay';

export interface GuidedBarItem {
  key: GuidedStep;
  /** The registry's text key (kioskTexts.ts). */
  textKey: string;
  state: 'done' | 'current' | 'next';
}

/** The words of each guided step (kiosk texts). */
export const GUIDED_STEP_TEXT: Record<GuidedStep, string> = {
  service: 'stepService',
  menu: 'stepMenu',
  basket: 'stepBasket',
  tip: 'stepTipShort',
  details: 'stepDetails',
  payMethod: 'stepPayMethod',
  pay: 'stepPayGuided',
};

/**
 * The guided flow's step bar ("שירות ✓ · תפריט · סל · טיפ · תשלום"): the service when it is its own
 * screen, the menu, the basket, this order's checkout steps (`checkout`, in their order), the payment.
 */
export function guidedBar(
  serviceStep: boolean,
  checkout: ReadonlyArray<'tip' | 'details' | 'payMethod'>,
  current: GuidedStep,
): GuidedBarItem[] {
  const steps: GuidedStep[] = [...(serviceStep ? (['service'] as GuidedStep[]) : []), 'menu', 'basket', ...checkout, 'pay'];
  const i = steps.indexOf(current);
  return steps.map((key, j) => ({ key, textKey: GUIDED_STEP_TEXT[key], state: i < 0 ? 'next' : j < i ? 'done' : j === i ? 'current' : 'next' }));
}
