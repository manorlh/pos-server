/**
 * The designed order screen's measures and rules (pos-android ui/sell/design/DesignLayout.kt, domain/TillDesignNight.kt,
 * domain/TillDesignPhase2.kt, domain/TillDesignKeyboard.kt, domain/FlowDesign.kt FlowColors), pure so the template ×
 * window table is tested (test/tillDesignLayout.test.ts): how many columns a pane holds per tile style, how tall a tile
 * is, how wide the side bill is, where the night's bill stands, what the payment dock keeps, the bar's buttons as drawn,
 * the menu's order, the in-screen keyboard and the flow's palette. CSS px = Android dp.
 */

import type { Catalog, Department, Product, TillDesignAction } from '../../../../shared/till/protocol';
import type { TillDesignView } from '../../../../core/till/tillDesign';
import { menuView } from '@dash-lib/tillDesign';

/* ------------------------------------------------------------ the grid */

export type TileSizeCode = 'xs' | 's' | 'm' | 'l';
export type TileStyle = 'card' | 'photo' | 'row' | 'key' | 'dish';
export type Density = 'compact' | 'comfortable' | 'spacious';

/** Android TileSize: the phone's columns and a tile's height (dp). */
export const TILE_SIZES: Record<TileSizeCode, { columns: number; heightDp: number }> = {
  xs: { columns: 5, heightDp: 92 },
  s: { columns: 4, heightDp: 112 },
  m: { columns: 3, heightDp: 150 },
  l: { columns: 2, heightDp: 196 },
};

/** Density's factor on a tile's height (compact 0.85, comfortable 1, spacious 1.15). */
export function densityFactor(density: string): number {
  return density === 'compact' ? 0.85 : density === 'spacious' ? 1.15 : 1;
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/**
 * The tiles' columns on a pane `paneWidthDp` wide (Android designColumns): layout.columns when set, else by the style —
 * card: two on the handheld (the set size's own count), else cards of ~240 dp (a set size 140 / 170 / 220 / 280);
 * photo: two / ~240; row: one list, two past 900 dp; key: three / ~140.
 */
export function designColumns(style: string, paneWidthDp: number, handheld: boolean, fixed: number, explicitSize: TileSizeCode | null): number {
  if (style === 'row') return fixed > 0 ? clamp(fixed, 1, 2) : paneWidthDp > 900 ? 2 : 1;
  if (fixed > 0) return clamp(fixed, 2, 8);
  const usable = paneWidthDp - 24;
  const fit = (target: number, min: number, max: number) => clamp(Math.floor((usable + 8) / (target + 8)), min, max);
  if (style === 'photo') return handheld ? 2 : fit(240, 2, 6);
  if (style === 'key') return handheld ? 3 : fit(140, 3, 8);
  if (handheld) return explicitSize ? clamp(TILE_SIZES[explicitSize].columns, 2, 4) : 2;
  const target = explicitSize === 'xs' ? 140 : explicitSize === 's' ? 170 : explicitSize === 'm' ? 220 : explicitSize === 'l' ? 280 : 240;
  return fit(target, 2, 8);
}

/** A tile's height (dp, Android designTileHeightDp): cards by the tile size, rows 56 (48 compact), keys 72 (60 compact), a photo 16:10 + 64. */
export function designTileHeightDp(style: string, size: TileSizeCode, density: string, tileWidthDp: number): number {
  const f = densityFactor(density);
  if (style === 'row') return density === 'compact' ? 48 : Math.round(56 * f);
  if (style === 'key') return density === 'compact' ? 60 : Math.round(72 * f);
  if (style === 'photo') return Math.round((tileWidthDp * 10) / 16 + 64 * f);
  return Math.round(TILE_SIZES[size].heightDp * f);
}

/** לילה's keys (domain nightColumns): two on the handheld, three upright, else ~180 dp (3–6); a set layout.columns wins. */
export function nightColumns(paneWidthDp: number, handheld: boolean, portrait: boolean, fixed: number): number {
  if (fixed > 0) return clamp(fixed, 2, 8);
  if (handheld) return 2;
  if (portrait) return 3;
  return clamp(Math.floor((paneWidthDp - 24 + 8) / (180 + 8)), 3, 6);
}

/** תפריט ויזואלי's dish cards (domain dishColumns): one row-card on the handheld, else ~280 dp (2–4); layout.columns 1–6. */
export function dishColumns(paneWidthDp: number, handheld: boolean, fixed: number): number {
  if (handheld) return 1;
  if (fixed > 0) return clamp(fixed, 1, 6);
  return clamp(Math.floor((paneWidthDp - 24 + 12) / (280 + 12)), 2, 4);
}

/** A dish card's name lines (domain dishNameLines): one beside a description, else two. */
export function dishNameLines(description: string | null | undefined, descriptionLines: number): number {
  return !description || !description.trim() || descriptionLines === 0 ? 2 : 1;
}

/**
 * A text dish card's height (the Windows till has no photos: every category is "text cards", Android decision 8) — the
 * padding, the name (18 px × 1.25, two lines), the description's lines (13 × 1.25), the dietary line and the price row
 * with its 44 px "+", 4 px apart. Fixed per grid, so the virtualised rows stay one height.
 */
export function dishCardHeightDp(descriptionLines: number, dietary: boolean, scale = 1, nameLines = 2): number {
  const name = Math.max(1, nameLines) * 18 * 1.25 * scale;
  const desc = Math.max(0, descriptionLines) * 13 * 1.25 * scale;
  const diet = dietary ? 12 * 1.25 * scale + 4 : 0;
  return Math.ceil(12 + name + 4 + (desc > 0 ? desc + 4 : 0) + diet + 44 + 12);
}

/** The grid's padding and gaps (DesignProductGrid: 12 at the sides, 8 on top, 8 between; rows 0 apart, 12 across). */
export function gridGaps(style: string, dish: boolean): { side: number; top: number; row: number; column: number } {
  if (dish) return { side: 12, top: 8, row: 12, column: 12 };
  if (style === 'row') return { side: 12, top: 8, row: 0, column: 12 };
  return { side: 12, top: 8, row: 8, column: 8 };
}

/** A tile's width in a pane (the grid's padding and its gaps out). */
export function tileWidthDp(paneWidthDp: number, columns: number, side: number, gap: number): number {
  const c = Math.max(1, columns);
  return (paneWidthDp - 2 * side - (c - 1) * gap) / c;
}

/** The rows of a virtualised grid on screen (and `overscan` around): parts/ProductGrid.tsx gridWindow with this grid's own step. */
export function designWindow(rows: number, rowHeight: number, gap: number, scrollTop: number, viewHeight: number, overscan = 3) {
  if (rows <= 0) return { first: 0, last: -1, padTop: 0, padBottom: 0 };
  const step = rowHeight + gap;
  const first = Math.max(0, Math.floor(scrollTop / step) - overscan);
  const last = Math.min(rows - 1, Math.ceil((scrollTop + viewHeight) / step) + overscan);
  return { first, last, padTop: first * step, padBottom: (rows - 1 - last) * step };
}

/* ------------------------------------------------------------ the bill */

/** Android STACKED_MIN_HEIGHT_DP: an upright screen shorter than this keeps the bill as a summary bar. */
export const STACKED_MIN_HEIGHT_DP = 900;

/**
 * The bill at the bottom as a summary bar that opens upward (Android designBillCollapsible): the handheld's, the
 * template's own (mobile), and an upright or square screen shorter than 900 dp.
 */
export function designBillCollapsible(position: string, handheld: boolean, summaryCollapsible: boolean, widthDp: number, heightDp: number): boolean {
  return position === 'bottom' && (handheld || summaryCollapsible || (heightDp >= widthDp && heightDp < STACKED_MIN_HEIGHT_DP));
}

/** The side bill (Android sideBillWidthDp): 36% of the width, 340–460; professional's 40%, 300–520; לוח מנות half (55% past 1500), ≥ 400. */
export function sideBillWidthDp(widthDp: number, template: string): number {
  if (template === 'professional') return clamp(Math.round(widthDp * 0.4), 300, 520);
  if (template === 'courses') return Math.max(400, Math.round(widthDp * (widthDp >= 1500 ? 0.55 : 0.5)));
  return clamp(Math.round(widthDp * 0.36), 340, 460);
}

/** The night's order panel (domain nightBillWidthDp): 34% of the width, 340–520. */
export function nightBillWidthDp(widthDp: number): number {
  return clamp(Math.round(widthDp * 0.34), 340, 520);
}

/** Where the night's bill stands (domain nightBillPosition): "left" — at the start; else at the end; not at a side — as resolved. */
export function nightBillPosition(resolved: string, hand: string): string {
  if (resolved !== 'end' && resolved !== 'start') return resolved;
  return hand === 'left' ? 'start' : 'end';
}

/** תפריט ויזואלי's drawer: 34% of a wide screen (≥ 1500), else 40%. */
export function drawerFraction(widthDp: number): number {
  return widthDp >= 1500 ? 0.34 : 0.4;
}

/* ------------------------------------------------------------ the bar */

/** One button of the bar as drawn: the design's action, a banknote's value for "שטרות" (CartPane's QuickButton and more). */
export interface BarButton {
  action: string;
  label: string;
  primary: boolean;
  presetId?: string;
  noteShekels?: number;
}

/**
 * What the Windows till cannot do on its quick bar yet: "לקוח" (no club screen) and "חזור על סבב" (the engine keeps no
 * customer's last order) — left off, as Android leaves off a button whose flow is not there.
 */
export const BAR_ACTIONS_NOT_HERE: readonly string[] = ['customer', 'repeatRound'];

/** The bar's buttons (Android designBarButtons): "שטרות" one button per banknote offered, the unsupported left off. */
export function barButtons(bar: ReadonlyArray<TillDesignAction>, offered: readonly number[]): BarButton[] {
  const out: BarButton[] = [];
  for (const b of bar) {
    if (BAR_ACTIONS_NOT_HERE.includes(b.action)) continue;
    if (b.action === 'cashNotes') {
      for (const n of offered) out.push({ action: 'cashNotes', label: b.label, primary: false, noteShekels: n });
      continue;
    }
    out.push({ action: b.action, label: b.label, primary: b.primary, ...(b.presetId ? { presetId: b.presetId } : {}) });
  }
  return out;
}

/** The action bar's arrangement (DesignActionBar): a side panel stacks; three or fewer in one row; more scroll over the primary. */
export function barArrangement(count: number, stacked: boolean): 'stacked' | 'row' | 'scroll' {
  if (stacked) return 'stacked';
  return count <= 3 ? 'row' : 'scroll';
}

/** The payment dock's measures (domain DockMeasures, dp). */
export const DOCK = { height: 128, buttonHeight: 96, amount: 220, buttonMin: 104, buttonMax: 140, primaryMin: 160, gap: 8, padding: 12 } as const;

/** The dock's primary (domain payDockPrimary, a quick order): "אשראי מהיר" when the dock has it, else "pay". */
export function payDockPrimary(buttons: ReadonlyArray<Pick<BarButton, 'action'>>): string | null {
  return buttons.find((b) => b.action === 'fastCard')?.action ?? buttons.find((b) => b.action === 'pay')?.action ?? null;
}

/**
 * Which buttons stand on the dock `widthDp` wide and which go to "עוד" (domain payDockPlan): each at its narrowest while
 * they fit — the banknotes first to go (the highest first), then the others from the end; the primary and "pay" never.
 * The handheld: the primary and the next that is not a note.
 */
export function payDockPlan<B extends Pick<BarButton, 'action'>>(buttons: readonly B[], widthDp: number, handheld: boolean, primary: string | null): { shown: B[]; overflow: B[] } {
  if (handheld) {
    const keep = [...buttons.filter((b) => b.action === primary).slice(0, 1), ...buttons.filter((b) => b.action !== primary && b.action !== 'cashNotes').slice(0, 1)];
    return { shown: buttons.filter((b) => keep.includes(b)), overflow: buttons.filter((b) => !keep.includes(b)) };
  }
  const width = (list: readonly B[]) => {
    const sum = list.reduce((s, b) => s + (b.action === primary ? DOCK.primaryMin : DOCK.buttonMin), 0);
    return 2 * DOCK.padding + DOCK.amount + DOCK.gap + sum + (list.length + 1) * DOCK.gap + DOCK.buttonMin;
  };
  const shown = buttons.slice();
  while (shown.length > 0 && width(shown) > widthDp) {
    let at = -1;
    for (let i = shown.length - 1; i >= 0; i--) if (shown[i].action === 'cashNotes') { at = i; break; }
    if (at < 0) for (let i = shown.length - 1; i >= 0; i--) if (shown[i].action !== primary && shown[i].action !== 'pay') { at = i; break; }
    if (at < 0) break;
    shown.splice(at, 1);
  }
  return { shown, overflow: buttons.filter((b) => !shown.includes(b)) };
}

/* ------------------------------------------------------------ the menu */

/**
 * The catalogue as the design's `menu` orders it (client lib menuView — the Android till's MenuOrder): the departments
 * in `categoryOrder` without the hidden ones, the products in `productOrder` within their department's place, those of a
 * hidden department left out of the tabs and "הכל" (a search still finds them). The default design returns the catalogue.
 */
export function orderedCatalog(catalog: Catalog, menu: TillDesignView['menu'] | null | undefined): { departments: Department[]; products: Product[] } {
  if (!menu || (menu.categoryOrder.length === 0 && menu.productOrder.length === 0 && menu.hiddenCategories.length === 0)) {
    return { departments: catalog.departments, products: catalog.products };
  }
  const cats = catalog.departments.map((d) => ({ ...d }));
  const prods = catalog.products.map((p) => ({ p, id: p.id, categoryId: p.departmentId as string | null }));
  const view = menuView(cats, prods, menu);
  return { departments: view.categories, products: view.products.map((x) => x.p) };
}

/** The products a tab shows: the department's, or "הכל" (the ordered list), a search over the whole catalogue (hidden ones too). */
export function shownProducts(all: readonly Product[], ordered: readonly Product[], departmentId: string | null, search: string): Product[] {
  const q = search.trim();
  if (q !== '') {
    // A search reaches every product whatever the category (Android SellUiState.visibleProducts), in the menu's order
    // first (the hidden after).
    const seen = new Set(ordered.map((p) => p.id));
    const pool = [...ordered, ...all.filter((p) => !seen.has(p.id))];
    return pool.filter((p) => p.name.includes(q) || p.barcode === q || p.sku === q);
  }
  return ordered.filter((p) => departmentId === null || p.departmentId === departmentId);
}

/* ------------------------------------------------------------ the keyboard */

export type KeyboardMode = 'search' | 'code' | 'quantity' | 'price';

/** The Hebrew rows (SI 1452), the digits above them; the number pad. */
export const HEBREW_ROWS = ['1234567890', 'קראטוןםפ', 'שדגכעיחלךף', 'זסבהנמצתץ'] as const;
export const NUMPAD_ROWS = ['123', '456', '789', '.0'] as const;
export const KEYBOARD_INPUT_MAX = 40;

/** A key typed (domain keyboardTyped): a quantity takes digits (no leading 0, at most 99), a price one point and two decimals. */
export function keyboardTyped(current: string, key: string, mode: KeyboardMode): string {
  if (current.length >= KEYBOARD_INPUT_MAX) return current;
  const digit = /^[0-9]$/.test(key);
  if (mode === 'quantity') return !digit || current.length >= 2 || (current === '' && key === '0') ? current : current + key;
  if (mode === 'price') {
    if (key === '.') return current.includes('.') ? current : (current || '0') + '.';
    if (!digit) return current;
    if (current.includes('.') && current.split('.')[1].length >= 2) return current;
    if (current === '0') return key;
    return current + key;
  }
  return current + key;
}

/** PLU (domain pluLookup): the product whose SKU is the code (any case), else the one whose barcode is. */
export function pluLookup(code: string, products: readonly Product[]): Product | null {
  const c = code.trim();
  if (!c) return null;
  return products.find((p) => (p.sku ?? '').toLowerCase() === c.toLowerCase() && !!p.sku) ?? products.find((p) => p.barcode === c) ?? null;
}

export type FKeyAction = 'search' | 'code' | 'quantity' | 'price' | 'pay' | 'exactCash' | 'clear';

/** F1 search, F2 code, F3 quantity, F4 price, F9 pay, F10 exact cash, Esc clears (domain fKeyAction). */
export function fKeyAction(key: string): FKeyAction | null {
  switch (key.toUpperCase()) {
    case 'F1':
      return 'search';
    case 'F2':
      return 'code';
    case 'F3':
      return 'quantity';
    case 'F4':
      return 'price';
    case 'F9':
      return 'pay';
    case 'F10':
      return 'exactCash';
    case 'ESC':
    case 'ESCAPE':
      return 'clear';
    default:
      return null;
  }
}

/** "כמות אחרת" typed on its pad (domain quantityKeypadTyped): digits, no leading 0, 1–99. */
export function quantityKeypadTyped(current: string, d: string): string {
  if (!/^[0-9]$/.test(d) || current.length >= 2 || (current === '' && d === '0')) return current;
  return current + d;
}

/* ------------------------------------------------------------ "זרימה" */

export interface FlowPalette {
  page: string;
  surface: string;
  border: string;
  text: string;
  secondary: string;
  accent: string;
  onAccent: string;
  accentText: string;
  accentTint: string;
  muted: string;
  onMuted: string;
  dark: boolean;
}

const LIGHT = { page: '#F3F5F8', surface: '#FFFFFF', border: '#E2E6EC', text: '#111827', secondary: '#6B7280' };
const DARK = { page: '#0E1014', surface: '#171A20', border: '#2A2F38', text: '#F2F4F7', secondary: '#9AA3AF' };
const INK = '#111827';
const WHITE = '#FFFFFF';
const BLACK = '#000000';
export const FLOW_DEFAULT_ACCENT = '#007AFF';

function rgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** WCAG relative luminance (FlowColors.luminance). */
export function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** `a` to `b` by `t` (FlowColors.mix: 0 — a, 1 — b), channel by channel. */
export function mix(a: string, b: string, t: number): string {
  const x = rgb(a);
  const y = rgb(b);
  const k = clamp(t, 0, 1);
  return `#${x.map((v, i) => clamp(Math.round(v + (y[i] - v) * k), 0, 255).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

function toward(color: string, target: string, ok: (c: string) => boolean): string {
  if (ok(color)) return color;
  for (let i = 1; i <= 19; i++) {
    const c = mix(color, target, i * 0.05);
    if (ok(c)) return c;
  }
  return target;
}

const HEX = /^#[0-9A-Fa-f]{6}$/;

/**
 * "זרימה"'s palette (domain/FlowDesign.kt FlowColors.palette): ours, light or dark, without a chosen `flow.background`;
 * else the page in that colour and the rest derived from it — every text 4.5:1 on what it is drawn on, the accent's fill
 * keeping its own pairing (white on a deep colour, ink on a light one).
 */
export function flowPalette(background: string | null | undefined, accent: string | null | undefined, darkTheme: boolean): FlowPalette {
  const bg = background && HEX.test(background) ? background.toUpperCase() : null;
  const dark = bg === null ? darkTheme : luminance(bg) < 0.18;
  const page = bg ?? (dark ? DARK.page : LIGHT.page);
  const away = dark ? WHITE : BLACK;
  const text = toward(dark ? DARK.text : LIGHT.text, away, (c) => contrast(c, page) >= 4.5);
  const surface0 = bg === null ? (dark ? DARK.surface : LIGHT.surface) : dark ? mix(bg, WHITE, 0.08) : mix(bg, WHITE, 0.85);
  const surface = toward(surface0, dark ? BLACK : WHITE, (c) => contrast(text, c) >= 4.5);
  const border = bg === null ? (dark ? DARK.border : LIGHT.border) : dark ? mix(bg, WHITE, 0.2) : mix(bg, BLACK, 0.12);
  const secondary0 = bg === null ? (dark ? DARK.secondary : LIGHT.secondary) : mix(text, page, 0.4);
  const secondary = toward(secondary0, text, (c) => contrast(c, page) >= 4.5 && contrast(c, surface) >= 4.5);
  const brand = accent && HEX.test(accent) ? accent.toUpperCase() : FLOW_DEFAULT_ACCENT;
  const whiteOn = luminance(brand) < 0.4;
  const onAccent = whiteOn ? WHITE : INK;
  const fill = toward(brand, whiteOn ? BLACK : WHITE, (c) => contrast(onAccent, c) >= 4.5);
  const accentText = toward(brand, away, (c) => contrast(c, page) >= 4.5 && contrast(c, surface) >= 4.5);
  const muted = mix(surface, text, dark ? 0.18 : 0.1);
  return {
    page,
    surface,
    border,
    text,
    secondary,
    accent: fill,
    onAccent,
    accentText,
    accentTint: mix(surface, fill, dark ? 0.22 : 0.12),
    muted,
    onMuted: mix(muted, text, 0.55),
    dark,
  };
}

/** The flow's colours as the home's CSS variables (`--f-*`, design.css). */
export function flowVars(p: FlowPalette): Record<string, string> {
  return {
    '--f-page': p.page,
    '--f-surface': p.surface,
    '--f-border': p.border,
    '--f-text': p.text,
    '--f-secondary': p.secondary,
    '--f-accent': p.accent,
    '--f-on-accent': p.onAccent,
    '--f-accent-text': p.accentText,
    '--f-accent-tint': p.accentTint,
    '--f-muted': p.muted,
    '--f-on-muted': p.onMuted,
  };
}

/** `pickupName` (domain flowPickupName): "ask" and "required" ask a name; "auto" and "off" open the order at once. */
export function flowPickupAsks(setting: string): 'off' | 'ask' | 'required' {
  return setting === 'ask' ? 'ask' : setting === 'required' ? 'required' : 'off';
}
