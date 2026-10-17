/**
 * "שיתאים את עצמו" (P:/specs/kiosk-landscape-till-mode.md §2): the one display profile every screen
 * lays itself out by — the Android kiosk and till (pos-android domain/DisplayProfile.kt), the web
 * kiosk bundle, the Windows app and the web till (P:/specs/web-till-spec-v2.md §6.10). The same
 * rules, number for number, pinned by the shared golden fixture
 * server/tests/fixtures/display_profiles_golden.json (the same bytes in pos-android).
 *
 * In a browser (Electron, WKWebView too) a CSS pixel is a dp: `densityDpi = 160 × devicePixelRatio`,
 * and the physical size is never known — the dp buckets decide (a 4K screen at ratio 1 is scaled).
 */

export interface DisplayFacts {
  widthPx: number;
  heightPx: number;
  densityDpi: number;
  /** The vendor's physical claim (0 when unknown — always, in a browser). */
  xdpi: number;
  ydpi: number;
}

export type DisplaySizeClass = 'handheld' | '11' | '13' | '15' | '21' | '27' | '32';

export interface DisplayProfile {
  landscape: boolean;
  sizeClass: DisplaySizeClass;
  diagonalInches: number;
  physicalTrusted: boolean;
  scale: number;
  widthDp: number;
  heightDp: number;
  kioskTypeScale: number;
}

export interface KioskDisplayDecisions {
  landscape: boolean;
  sideCart: boolean;
  panelWidthDp: number;
  /** The categories on the rail (else the top tabs); null: as configured (portrait). */
  rail: boolean | null;
  contentMaxWidthDp: number | null;
  twoColumns: boolean;
  typeScale: number;
}

export type TillLayoutClass = 'HANDHELD' | 'TABLET' | 'BIG';

const CLASSES: ReadonlyArray<[DisplaySizeClass, number]> = [
  ['handheld', 9.0],
  ['11', 12.0],
  ['13', 14.5],
  ['15', 18.5],
  ['21', 24.5],
  ['27', 29.5],
  ['32', Number.MAX_VALUE],
];
const ORDER: DisplaySizeClass[] = CLASSES.map(([c]) => c);

export const DENSITY_BUCKETS = [120, 160, 213, 240, 280, 320, 360, 400, 420, 480, 560, 640];
export const HANDHELD_MAX_SMALLEST_DP = 600;
/** A believable diagonal from this many inches is never a handheld (§2.3: "פחות מ-9"" — pos-android DisplayProfiles). */
export const HANDHELD_MAX_TRUSTED_IN = 9.0;
const HIRES_SMALLEST_DP = 1440;
const HIRES_TARGET_SMALLEST_DP = 1080;
const MIN_SCALE = 0.75;
const MAX_SCALE = 2.5;

/** The allowed physical size of one dp (mm) per class: [min, max] (§2.5). */
export const BANDS: Record<Exclude<DisplaySizeClass, 'handheld'>, [number, number]> = {
  '11': [0.14, 0.22],
  '13': [0.15, 0.24],
  '15': [0.16, 0.26],
  '21': [0.2, 0.32],
  '27': [0.22, 0.36],
  '32': [0.24, 0.4],
};

/** The kiosk's text scale in landscape (§2.6) — easy to tune after a calibration on a real 32". */
export const KIOSK_TYPE_SCALE: Record<DisplaySizeClass, number> = {
  handheld: 1.0,
  '11': 1.0,
  '13': 1.0,
  '15': 1.04,
  '21': 1.1,
  '27': 1.16,
  '32': 1.22,
};

/** The same rounding as Kotlin's Math.round / floor(x + 0.5). */
const roundHalfUp = (v: number) => Math.floor(v + 0.5);
const round2 = (v: number) => Math.floor(v * 100 + 0.5) / 100;
const round1 = (v: number) => Math.floor(v * 10 + 0.5) / 10;
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

function isBucket(v: number): boolean {
  return DENSITY_BUCKETS.some((b) => Math.abs(v - b) < 0.01);
}

export function mmPerDp(f: DisplayFacts): number {
  return (25.4 * (f.densityDpi / 160)) / ((f.xdpi + f.ydpi) / 2);
}

/** Whether the vendor's physical claim is believable (§2.2). */
export function physicalTrusted(f: DisplayFacts): boolean {
  const { xdpi: x, ydpi: y } = f;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  if (x < 40 || y < 40 || x > 640 || y > 640) return false;
  if (Math.abs(x - y) / Math.max(x, y) > 0.1) return false;
  if (isBucket(x) && isBucket(y)) return false;
  if (f.widthPx <= 0 || f.heightPx <= 0 || f.densityDpi <= 0) return false;
  const diag = Math.hypot(f.widthPx / x, f.heightPx / y);
  if (diag < 3 || diag > 100) return false;
  const mm = mmPerDp(f);
  return mm >= 0.06 && mm <= 0.8;
}

export function displayProfile(f: DisplayFacts): DisplayProfile {
  const density = (f.densityDpi > 0 ? f.densityDpi : 160) / 160;
  const wNative = f.widthPx / density;
  const hNative = f.heightPx / density;
  const swNative = Math.min(wNative, hNative);
  const landscape = f.widthPx > f.heightPx;
  const trusted = physicalTrusted(f);
  const diagonal = trusted ? Math.hypot(f.widthPx / f.xdpi, f.heightPx / f.ydpi) : Math.hypot(wNative, hNative) / 160;
  let sizeClass: DisplaySizeClass;
  // A believable 9" or more is never a handheld, however large its density makes the dp (layout audit 16.10: a 15.6"
  // 1366×768 at 150% read 910×512 dp — the handheld's layout on a counter screen); its class is its inches, and the band
  // below corrects the density. A browser is never believable: unchanged there.
  const handheld = swNative < HANDHELD_MAX_SMALLEST_DP && !(trusted && diagonal >= HANDHELD_MAX_TRUSTED_IN);
  if (handheld) sizeClass = 'handheld';
  else {
    const byInches = CLASSES.find(([, upTo]) => diagonal < upTo)![0];
    sizeClass = byInches === 'handheld' ? '11' : byInches;
  }
  let raw: number;
  if (sizeClass === 'handheld') raw = 1;
  else if (trusted) {
    const mm = mmPerDp(f);
    const [lo, hi] = BANDS[sizeClass];
    // Upright: only a panel too dense is corrected — today's portrait kiosk stays as it is. A square is not today's portrait
    // kiosk: both ends, as on its side (layout audit 16.10, the same as pos-android).
    const upright = f.heightPx > f.widthPx;
    const target = upright ? Math.max(mm, lo) : clamp(mm, lo, hi);
    raw = target / mm;
  } else if (swNative >= HIRES_SMALLEST_DP) raw = swNative / HIRES_TARGET_SMALLEST_DP;
  else raw = 1;
  const scale = round2(clamp(raw, MIN_SCALE, MAX_SCALE));
  const effective = density * scale;
  return {
    landscape,
    sizeClass,
    diagonalInches: round1(diagonal),
    physicalTrusted: trusted,
    scale,
    widthDp: Math.floor(f.widthPx / effective),
    heightDp: Math.floor(f.heightPx / effective),
    kioskTypeScale: landscape && trusted ? KIOSK_TYPE_SCALE[sizeClass] : 1,
  };
}

/** A browser window's facts: CSS pixels are dp; no physical claim. */
export function browserFacts(innerWidth: number, innerHeight: number, devicePixelRatio = 1): DisplayFacts {
  const ratio = devicePixelRatio > 0 ? devicePixelRatio : 1;
  return {
    widthPx: Math.round(innerWidth * ratio),
    heightPx: Math.round(innerHeight * ratio),
    densityDpi: Math.round(160 * ratio),
    xdpi: 0,
    ydpi: 0,
  };
}

// ── The kiosk's landscape decisions (§4) ───────────────────────────────────

export const SIDE_CART_MIN_DP = 1300;
export const PANEL_WIDTH_DP = 340;
const RAIL_MIN_REMAINING_DP = 900;
const TWO_COLUMNS_MIN_DP = 1100;
export const MIN_TOUCH_DP = 48;

/**
 * The smallest control (§2.9: 48 dp at the app's scale) in the CSS px a kiosk's screens are drawn in — the root's
 * `--k-target` (kiosk-shared `.k-hit`, `min-h-[var(--k-target)]`): `cssPerDp` CSS px make one dp (the Windows kiosk's
 * page zoom ×2 → 0.5: 24 px; the WebView and the browser at ratio 1 → 48 px; a 4K root zoomed ×2 → 24 px).
 * Layout audit 16.10: on a 10" tablet the screens' 24–36 px controls were 4–6 mm.
 */
export function kioskTargetCssPx(cssPerDp: number): number {
  const k = Number.isFinite(cssPerDp) && cssPerDp > 0 ? cssPerDp : 1;
  return Math.round(MIN_TOUCH_DP * k * 10) / 10;
}

export const AS_TODAY: KioskDisplayDecisions = {
  landscape: false,
  sideCart: false,
  panelWidthDp: PANEL_WIDTH_DP,
  rail: null,
  contentMaxWidthDp: null,
  twoColumns: false,
  typeScale: 1,
};

export function sideCartWidthDp(widthDp: number): number {
  return clamp(roundHalfUp(widthDp * 0.26), 340, 480);
}

export function kioskDisplay(p: DisplayProfile): KioskDisplayDecisions {
  if (!p.landscape) return AS_TODAY;
  const side = p.widthDp >= SIDE_CART_MIN_DP;
  const panel = side ? sideCartWidthDp(p.widthDp) : PANEL_WIDTH_DP;
  return {
    landscape: true,
    sideCart: side,
    panelWidthDp: panel,
    rail: p.widthDp - (side ? panel : 0) >= RAIL_MIN_REMAINING_DP,
    contentMaxWidthDp: clamp(roundHalfUp(p.widthDp * 0.62), 720, 1200),
    twoColumns: p.widthDp >= TWO_COLUMNS_MIN_DP,
    typeScale: p.kioskTypeScale,
  };
}

/**
 * The theme's cart and categories as the screens draw them: in landscape the side cart where
 * there is room, the rail or the top tabs; "top" chosen stays "top"; portrait as configured.
 */
export function kioskDisplayTheme<T extends { cartStyle?: string; categoryLayout?: string }>(theme: T, d: KioskDisplayDecisions): T {
  if (!d.landscape) return theme;
  const categories = theme.categoryLayout !== 'side' && theme.categoryLayout !== undefined ? theme.categoryLayout : d.rail === false ? 'top' : theme.categoryLayout;
  const cart = d.sideCart ? 'panel' : theme.cartStyle;
  if (categories === theme.categoryLayout && cart === theme.cartStyle) return theme;
  return { ...theme, categoryLayout: categories, cartStyle: cart };
}

// ── The till's layout (§6) ─────────────────────────────────────────────────

export function tillLayoutOf(p: DisplayProfile): TillLayoutClass {
  if (Math.min(p.widthDp, p.heightDp) < HANDHELD_MAX_SMALLEST_DP) return 'HANDHELD';
  const bigClass = ORDER.indexOf(p.sizeClass) >= ORDER.indexOf('15');
  const fits = p.landscape ? p.widthDp >= 1400 && p.heightDp >= 800 : p.heightDp >= 1400 && p.widthDp >= 800;
  return bigClass && fits ? 'BIG' : 'TABLET';
}

export function bigBasketWidthDp(widthDp: number): number {
  return clamp(roundHalfUp(widthDp * 0.28), 420, 560);
}
