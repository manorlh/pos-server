/**
 * The live preview's model: what one till screen shows for the draft config, one profile and
 * one mode — the view (`forProfile`), the colours (the brief's tokens, one accent), the menu in
 * the menu's order, the order (the owner's sample, or the first products of the real catalog),
 * the header, the fields, the action bar with its labels. Pure: the editor's preview, the
 * template thumbnails and the screenshot page all build it here.
 */

import {
  LARGE_TEXT_FACTOR,
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

function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The brief's tokens (§2) for a colour mode and an accent. */
export function tokensFor(cfg: Pick<TillDesignConfig, 'colors'>, brandColor?: string | null): Tokens {
  const accent = (cfg.colors?.accent && /^#[0-9A-Fa-f]{6}$/.test(cfg.colors.accent) ? cfg.colors.accent : brandColor || DEFAULT_ACCENT).toUpperCase();
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
}

/** The owner's sample menu (brief §6) and a few more dishes, so a tablet's grid is not empty. */
export const SAMPLE_CATEGORIES: PCategory[] = [
  { id: 'c-main', name: 'עיקריות' },
  { id: 'c-side', name: 'תוספות' },
  { id: 'c-drink', name: 'שתייה' },
  { id: 'c-dessert', name: 'קינוחים' },
];

const sample = (id: string, name: string, shekels: number, categoryId: string): PProduct => ({
  id,
  name,
  price: shekels * 100,
  categoryId,
  imageUrl: null,
  available: true,
});

export const SAMPLE_PRODUCTS: PProduct[] = [
  sample('p-burger', 'המבורגר', 64, 'c-main'),
  sample('p-schnitzel', 'שניצל בחלה', 54, 'c-main'),
  sample('p-fries', 'צ׳יפס', 16, 'c-side'),
  sample('p-cola', 'קולה', 14, 'c-drink'),
  sample('p-water', 'מים מינרליים', 10, 'c-drink'),
  sample('p-brownie', 'בראוני', 22, 'c-dessert'),
  sample('p-caesar', 'סלט קיסר', 48, 'c-main'),
  sample('p-pasta', 'פסטה רוזה', 58, 'c-main'),
  sample('p-rings', 'טבעות בצל', 18, 'c-side'),
  sample('p-lemonade', 'לימונדה', 16, 'c-drink'),
  sample('p-beer', 'בירה מהחבית', 28, 'c-drink'),
  sample('p-cheesecake', 'עוגת גבינה', 26, 'c-dessert'),
];

/** The order: המבורגר ×1 (seat 1, sent), קולה ×2 (seat 2, sent), צ׳יפס ×1 (seat 1, new) → ₪108. */
const SAMPLE_ORDER: Array<{ productIndex: number; qty: number; note: string | null; seat: number; status: LineStatus }> = [
  { productIndex: 0, qty: 1, note: 'ללא בצל · עשוי היטב', seat: 1, status: 'sent' },
  { productIndex: 3, qty: 2, note: null, seat: 2, status: 'sent' },
  { productIndex: 2, qty: 1, note: null, seat: 1, status: 'new' },
];

/** The order's starting lines on these products (the sample's dishes, else the first three on sale). */
export function sampleLines(products: readonly PProduct[], mode: Mode): PLine[] {
  const byId = new Map(products.map((p) => [p.id, p]));
  const owner = SAMPLE_ORDER.map((o) => byId.get(SAMPLE_PRODUCTS[o.productIndex].id)).filter((p): p is PProduct => !!p);
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
    })),
  };
}

/* -------------------------------------------------------------- the model */

export interface PAction {
  key: string;
  action: ActionId | 'note';
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
}

export function initialState(products: readonly PProduct[], mode: Mode): PreviewState {
  return { lines: sampleLines(products, mode), category: null, nextQty: 1, seat: 1, summaryOpen: null, serviceType: 'takeAway' };
}

export function buildPreviewModel(opts: BuildOptions): PreviewModel {
  const cfg = opts.template ? { ...opts.cfg, template: opts.template as TillDesignConfig['template'], profiles: clearProfileTemplates(opts.cfg) } : opts.cfg;
  const view = forProfile(cfg, opts.profile);
  const mode = opts.mode;
  const handheld = view.profile === 'handheld';
  const real = catalogProducts(opts.catalog);
  const baseCategories = real?.categories ?? SAMPLE_CATEGORIES;
  const baseProducts = real?.products ?? SAMPLE_PRODUCTS;
  const menu = menuView(baseCategories, baseProducts, cfg.menu);
  const state: PreviewState = { ...initialState(baseProducts, mode), ...(opts.state ?? {}) };
  const products = state.category ? menu.products.filter((p) => p.categoryId === state.category) : menu.products;
  const k = view.textSize === 'large' ? LARGE_TEXT_FACTOR : 1;
  const text = (key: TextKey) => textOf(cfg, key);
  const lines = state.lines;
  const inOrder: Record<string, number> = {};
  for (const l of lines) inOrder[l.productId] = (inOrder[l.productId] ?? 0) + l.qty;
  const total = lines.reduce((s, l) => s + l.qty * l.unit, 0);
  const units = lines.reduce((s, l) => s + l.qty, 0);
  const toSend = lines.filter((l) => l.status === 'new').reduce((s, l) => s + l.qty, 0);
  const legacy = opts.legacy ?? null;
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
  const required = mode === 'table' ? 'send' : 'pay';
  const actions: PAction[] = [];
  for (const item of items) {
    const base = actionLabelOf(item, cfg);
    if (item.action === 'cashNotes') {
      const notes = quickCashNotes(total, cfg.quickCash.notes, cfg.quickCash.count);
      for (const note of notes) {
        actions.push({
          key: `note-${note}`,
          action: 'note',
          label: formatShekels(note * 100),
          sub: `עודף ${formatShekels(note * 100 - total)}`,
          primary: false,
          disabled: total <= 0,
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
      if (mode === 'quick') label = `${base} · ${formatShekels(total)}`;
      disabled = total <= 0;
    } else if (item.action === 'fastCash') {
      icon = 'cash';
      label = `${base} · ${formatShekels(total)}`;
      disabled = total <= 0;
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
  const collapsible = bill === 'sheet' || (handheld ? bill === 'bottom' : view.summaryCollapsible);
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
    t: tokensFor(cfg, opts.brandColor),
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
  };
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
      return { ...state, lines, nextQty: 1 };
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
    case 'reset':
      return e.state;
    default:
      return state;
  }
}
