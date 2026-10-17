/**
 * The R2M POS look, once for every screen that is not the Android app itself: the Windows till (kiosk-desktop
 * roles/till), the kiosk's web screens and the dashboard's previews read their colours, type and shapes from here,
 * so they draw what the Android till draws (P:/specs/till-visual-parity).
 *
 * Every value is the Android app's own:
 *  - the scheme: pos-android ui/theme/Theme.kt (lightSchemeFor / darkSchemeFor — iOS's neutrals, one brand colour,
 *    `brandPrimaryColor`, iOS blue when none);
 *  - the designed templates' neutrals and type: ui/sell/design/TillDesignLocal.kt (DesignColors, DesignType);
 *  - the night template: domain/TillDesignPhase2.kt NightPalette;
 *  - the shapes: Theme.kt PosShapes; the typeface: Heebo (res/font, SIL OFL 1.1).
 *
 * Compose mixes colours (`lerp`) in Oklab, so this does too — a hex from here is the hex the tablet paints.
 * Plain ES2020 and no DOM: it runs in the dashboard, in the kiosk-desktop main process and on Chromium 108.
 */

export type Hex = string;

// ── colour maths (Compose's: lerp in Oklab, luminance per sRGB, compositeOver in sRGB) ─────────

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function parseHex(hex: Hex): Rgb {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.slice(-6);
  const n = parseInt(full, 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

function toHex(c: Rgb): Hex {
  const byte = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);
  return `#${[c.r, c.g, c.b].map((v) => byte(v).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
const toGamma = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);

function toOklab(c: Rgb): [number, number, number] {
  const r = toLinear(c.r);
  const g = toLinear(c.g);
  const b = toLinear(c.b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function fromOklab([L, a, b]: [number, number, number]): Rgb {
  const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
  const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
  const s = Math.pow(L - 0.0894841775 * a - 1.291485548 * b, 3);
  return {
    r: toGamma(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: toGamma(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: toGamma(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  };
}

/** Compose's `lerp(start, stop, fraction)` for two opaque colours: in Oklab. */
export function mix(start: Hex, stop: Hex, fraction: number): Hex {
  const a = toOklab(parseHex(start));
  const b = toOklab(parseHex(stop));
  const t = Math.min(1, Math.max(0, fraction));
  return toHex(fromOklab([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]));
}

/** Compose's `Color.luminance()`: relative luminance, 0 (black) – 1 (white). */
export function luminance(hex: Hex): number {
  const c = parseHex(hex);
  return 0.2126 * toLinear(c.r) + 0.7152 * toLinear(c.g) + 0.0722 * toLinear(c.b);
}

/** `color.copy(alpha = a).compositeOver(under)`: plain alpha over an opaque colour, in sRGB. */
export function over(color: Hex, alpha: number, under: Hex): Hex {
  const c = parseHex(color);
  const u = parseHex(under);
  return toHex({ r: c.r * alpha + u.r * (1 - alpha), g: c.g * alpha + u.g * (1 - alpha), b: c.b * alpha + u.b * (1 - alpha) });
}

/** WCAG contrast ratio of two colours (1 – 21). */
export function contrast(a: Hex, b: Hex): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** `#RRGGBB` (any case, with or without #) → `#RRGGBB`; anything else → null. */
export function normalizeHex(value: unknown): Hex | null {
  if (typeof value !== 'string') return null;
  const m = /^#?([0-9a-fA-F]{6})$/.exec(value.trim());
  return m ? `#${m[1].toUpperCase()}` : null;
}

// ── the scheme (Theme.kt) ───────────────────────────────────────────────────────────────

/** iOS system blue — the owner's choice ("בצבעים לפי IOS"), the till's colour when the cloud sends none. */
export const DEFAULT_BRAND: Hex = '#007AFF';
const INK: Hex = '#111827';
const NIGHT_BASE: Hex = '#0B0E14';

/** Material 3's roles the till uses, as Theme.kt fills them. */
export interface PosScheme {
  dark: boolean;
  primary: Hex;
  onPrimary: Hex;
  primaryContainer: Hex;
  onPrimaryContainer: Hex;
  secondary: Hex;
  onSecondary: Hex;
  secondaryContainer: Hex;
  onSecondaryContainer: Hex;
  tertiary: Hex;
  background: Hex;
  onBackground: Hex;
  surface: Hex;
  onSurface: Hex;
  surfaceVariant: Hex;
  onSurfaceVariant: Hex;
  surfaceContainerLowest: Hex;
  surfaceContainerLow: Hex;
  surfaceContainer: Hex;
  surfaceContainerHigh: Hex;
  surfaceContainerHighest: Hex;
  outline: Hex;
  outlineVariant: Hex;
  error: Hex;
  onError: Hex;
  errorContainer: Hex;
  onErrorContainer: Hex;
}

/** White or ink, whichever reads on [c] (Theme.kt onColor). */
export function onColor(c: Hex): Hex {
  return luminance(c) > 0.45 ? INK : '#FFFFFF';
}

export function lightScheme(brand: Hex = DEFAULT_BRAND): PosScheme {
  const deep = mix(brand, '#000000', 0.35);
  return {
    dark: false,
    primary: brand,
    onPrimary: onColor(brand),
    primaryContainer: mix('#FFFFFF', brand, 0.12),
    onPrimaryContainer: deep,
    secondary: '#4B5563',
    onSecondary: '#FFFFFF',
    secondaryContainer: mix('#FFFFFF', brand, 0.16),
    onSecondaryContainer: deep,
    tertiary: deep,
    background: '#F2F2F7',
    onBackground: '#000000',
    surface: '#FFFFFF',
    onSurface: '#000000',
    surfaceVariant: '#F2F2F7',
    onSurfaceVariant: '#6C6C70',
    surfaceContainerLowest: '#FFFFFF',
    surfaceContainerLow: '#F9F9FB',
    surfaceContainer: '#F2F2F7',
    surfaceContainerHigh: '#E5E5EA',
    surfaceContainerHighest: '#D1D1D6',
    outline: '#C6C6C8',
    outlineVariant: '#E5E5EA',
    error: '#C0262D',
    onError: '#FFFFFF',
    errorContainer: '#FDECEC',
    onErrorContainer: '#8C1D22',
  };
}

export function darkScheme(brand: Hex = DEFAULT_BRAND): PosScheme {
  // The accent lifts toward white at night instead of dimming (Theme.kt).
  const lifted = mix(brand, '#FFFFFF', 0.35);
  return {
    dark: true,
    primary: lifted,
    onPrimary: onColor(lifted),
    primaryContainer: mix(NIGHT_BASE, brand, 0.28),
    onPrimaryContainer: mix(brand, '#FFFFFF', 0.7),
    secondary: '#9AA3B2',
    onSecondary: NIGHT_BASE,
    secondaryContainer: mix(NIGHT_BASE, brand, 0.32),
    onSecondaryContainer: mix(brand, '#FFFFFF', 0.75),
    tertiary: mix(brand, '#FFFFFF', 0.55),
    background: '#000000',
    onBackground: '#FFFFFF',
    surface: '#1C1C1E',
    onSurface: '#FFFFFF',
    surfaceVariant: '#2C2C2E',
    onSurfaceVariant: '#98989F',
    surfaceContainerLowest: '#000000',
    surfaceContainerLow: '#151517',
    surfaceContainer: '#1C1C1E',
    surfaceContainerHigh: '#2C2C2E',
    surfaceContainerHighest: '#3A3A3C',
    outline: '#38383A',
    outlineVariant: '#2C2C2E',
    error: '#F4A6A6',
    onError: '#3B0908',
    errorContainer: '#4A1416',
    onErrorContainer: '#FAD4D4',
  };
}

export type ThemeMode = 'system' | 'light' | 'dark';

/** The till parameter "ערכת צבע" (themeMode): "כהה"/"dark", "בהיר"/"light"; anything else follows the device. */
export function themeModeOfParam(value: unknown): ThemeMode {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (v === 'כהה' || v === 'dark') return 'dark';
  if (v === 'בהיר' || v === 'light') return 'light';
  return 'system';
}

/** The till parameter "צבע גופן" (textColor) as a colour — the light theme only; null: the theme's own. */
export function textColorOfParam(value: unknown): Hex | null {
  switch (typeof value === 'string' ? value.trim() : '') {
    case 'שחור':
    case 'black':
      return '#000000';
    case 'אפור כהה':
    case 'dark gray':
      return '#374151';
    case 'כחול כהה':
    case 'navy':
      return '#0B2545';
    case 'ירוק כהה':
    case 'dark green':
      return '#14532D';
    case 'חום כהה':
    case 'dark brown':
      return '#3E2723';
    case 'סגול כהה':
    case 'dark purple':
      return '#3B0764';
    default:
      return null;
  }
}

/**
 * The scheme the till paints (PosTheme): the brand (cloud `brandPrimaryColor`, or the design's colors.accent —
 * TillDesignOverlay maps it onto the brand), the mode, and "צבע גופן" over the light theme's text.
 */
export function posScheme(opts: { brand?: Hex | null; dark: boolean; text?: Hex | null }): PosScheme {
  const brand = normalizeHex(opts.brand) ?? DEFAULT_BRAND;
  const base = opts.dark ? darkScheme(brand) : lightScheme(brand);
  const text = normalizeHex(opts.text);
  return text && !opts.dark ? { ...base, onBackground: text, onSurface: text } : base;
}

// ── the designed templates (TillDesignLocal.kt, TillDesignPhase2.kt) ──────────────────────────

export interface DesignColors {
  page: Hex;
  surface: Hex;
  border: Hex;
  text: Hex;
  secondary: Hex;
  accent: Hex;
  onAccent: Hex;
  accentTint: Hex;
  amberText: Hex;
  amberFill: Hex;
  red: Hex;
  dark: boolean;
}

/** rememberDesignColors(): the designed screens' own neutrals around the scheme's accent. */
export function designColors(scheme: PosScheme): DesignColors {
  const dark = luminance(scheme.background) < 0.5;
  const surface = dark ? '#171A20' : '#FFFFFF';
  return {
    page: dark ? '#0E1014' : '#F3F5F8',
    surface,
    border: dark ? '#2A2F38' : '#E2E6EC',
    text: dark ? '#F2F4F7' : '#111827',
    secondary: dark ? '#9AA3AF' : '#6B7280',
    accent: scheme.primary,
    onAccent: scheme.onPrimary,
    accentTint: over(scheme.primary, dark ? 0.18 : 0.1, surface),
    amberText: dark ? '#FBBF24' : '#B45309',
    amberFill: dark ? '#3A2A0A' : '#FEF3C7',
    red: dark ? '#F87171' : '#B91C1C',
    dark,
  };
}

/** "לילה" (night): black, a lifted surface, the accent lightened until it reads at 4.5:1 (NightPalette). */
export const NIGHT = { background: '#000000', surface: '#121418', border: '#3A3F47', text: '#FFFFFF', secondary: '#C9CED6' } as const;

export function nightAccent(brand: Hex): Hex {
  let c = brand;
  for (let step = 1; contrast(c, NIGHT.surface) < 4.5 && step <= 20; step++) {
    const base = parseHex(brand);
    const t = step * 0.05;
    c = toHex({ r: base.r + (1 - base.r) * t, g: base.g + (1 - base.g) * t, b: base.b + (1 - base.b) * t });
  }
  return c;
}

export function nightOnAccent(accent: Hex): Hex {
  return contrast(accent, NIGHT.background) >= contrast(accent, NIGHT.text) ? NIGHT.background : NIGHT.text;
}

export function nightColors(brand: Hex): DesignColors {
  const accent = nightAccent(normalizeHex(brand) ?? DEFAULT_BRAND);
  return {
    page: NIGHT.background,
    surface: NIGHT.surface,
    border: NIGHT.border,
    text: NIGHT.text,
    secondary: NIGHT.secondary,
    accent,
    onAccent: nightOnAccent(accent),
    accentTint: over(accent, 0.18, NIGHT.surface),
    amberText: '#FBBF24',
    amberFill: '#3A2A0A',
    red: '#F87171',
    dark: true,
  };
}

// ── type and shapes ──────────────────────────────────────────────────────────────────

/** The typeface: Heebo, four weights (Android res/font heebo_*.ttf = Google Fonts' Heebo). */
export const FONT_FAMILY = "'Heebo', 'Noto Sans Hebrew', Arial, sans-serif";

export interface TypeStyle {
  /** sp on Android = CSS px here (a dp is a CSS px on the Windows till). */
  size: number;
  weight: 400 | 500 | 600 | 700;
  /** Line height in em. */
  line: number;
  /** Letter spacing in px (sp), 0 for none. */
  tracking: number;
}

const t = (size: number, weight: TypeStyle['weight'], line: number, tracking = 0): TypeStyle => ({ size, weight, line, tracking });

/** Theme.kt PosTypography. display* are Material's defaults (57/45/36, 400) in Heebo. */
export const TYPE = {
  displayLarge: t(57, 400, 1.12, -0.25),
  displayMedium: t(45, 400, 1.16),
  displaySmall: t(36, 400, 1.22),
  headlineLarge: t(30, 700, 1.2, -0.5),
  headlineMedium: t(25, 700, 1.2, -0.3),
  headlineSmall: t(21, 700, 1.2, -0.2),
  titleLarge: t(19, 600, 1.25),
  titleMedium: t(15, 600, 1.25, 0.1),
  titleSmall: t(14, 600, 1.25),
  bodyLarge: t(15, 400, 1.35),
  bodyMedium: t(14, 400, 1.35),
  bodySmall: t(12, 400, 1.35),
  labelLarge: t(14, 600, 1.25, 0.2),
  labelMedium: t(12, 600, 1.25),
  labelSmall: t(11, 500, 1.25),
} as const;

export type TypeRole = keyof typeof TYPE;

/** DesignType: the designed templates' sizes, day / night; ×1.15 with textSize "large". Line 1.25 em. */
export const DESIGN_TYPE = {
  title: { day: 22, night: 24, weight: 700 },
  name: { day: 16, night: 20, weight: 600 },
  touchName: { day: 18, night: 20, weight: 600 },
  price: { day: 15, night: 18, weight: 400 },
  secondary: { day: 13, night: 15, weight: 400 },
  chip: { day: 12, night: 14, weight: 600 },
  total: { day: 28, night: 27, weight: 700 },
  button: { day: 16, night: 20, weight: 600 },
  body: { day: 15, night: 17, weight: 400 },
  large: { day: 20, night: 22, weight: 700 },
} as const;

export type DesignTypeRole = keyof typeof DESIGN_TYPE;

export const LARGE_TEXT_SCALE = 1.15;

/** PosShapes (dp): extraSmall 8 · small 12 · medium 16 · large 22 · extraLarge 28; the designed screens 10 / 8. */
export const RADIUS = { xs: 8, sm: 12, md: 16, lg: 22, xl: 28, design: 10, designSmall: 8, pill: 999 } as const;

/** The finger's minimum (Theme.kt TapTarget) and the designed screens' metrics (DesignMetrics, night's). */
export const METRICS = {
  tap: 48,
  design: { stroke: 1, selectedStroke: 2, target: 44, barPrimary: 56, barSecondary: 52, railWidth: 120 },
  night: { stroke: 2, selectedStroke: 3, target: 64, barPrimary: 92, keyHeight: 96, railWidth: 150 },
} as const;

/** The fixed colours of today's (clean) screens: the kitchen's green, the quick-pay tenders, the badge red. */
export const FIXED = {
  sendGreen: '#34C759',
  cardBlue: '#2563EB',
  cashGreen: '#16A34A',
  cashDark: '#15803D',
  badgeRed: '#FF3B30',
  iosGreen: '#34C759',
  iosOrange: '#FF9500',
} as const;

/**
 * The scheme as CSS custom properties (`--pos-*`), for a page that paints with variables. Elevation is drawn as a
 * hairline border plus at most one small shadow — cheap on a J1900 rendering in software.
 */
export function schemeVars(s: PosScheme): Record<string, string> {
  const d = designColors(s);
  return {
    '--pos-primary': s.primary,
    '--pos-on-primary': s.onPrimary,
    '--pos-primary-container': s.primaryContainer,
    '--pos-on-primary-container': s.onPrimaryContainer,
    '--pos-secondary': s.secondary,
    '--pos-secondary-container': s.secondaryContainer,
    '--pos-on-secondary-container': s.onSecondaryContainer,
    '--pos-background': s.background,
    '--pos-on-background': s.onBackground,
    '--pos-surface': s.surface,
    '--pos-on-surface': s.onSurface,
    '--pos-on-surface-variant': s.onSurfaceVariant,
    '--pos-container-lowest': s.surfaceContainerLowest,
    '--pos-container-low': s.surfaceContainerLow,
    '--pos-container': s.surfaceContainer,
    '--pos-container-high': s.surfaceContainerHigh,
    '--pos-container-highest': s.surfaceContainerHighest,
    '--pos-outline': s.outline,
    '--pos-outline-variant': s.outlineVariant,
    '--pos-error': s.error,
    '--pos-on-error': s.onError,
    '--pos-error-container': s.errorContainer,
    '--pos-on-error-container': s.onErrorContainer,
    '--pos-d-page': d.page,
    '--pos-d-surface': d.surface,
    '--pos-d-border': d.border,
    '--pos-d-text': d.text,
    '--pos-d-secondary': d.secondary,
    '--pos-d-accent-tint': d.accentTint,
    '--pos-d-amber-text': d.amberText,
    '--pos-d-amber-fill': d.amberFill,
    '--pos-d-red': d.red,
  };
}
