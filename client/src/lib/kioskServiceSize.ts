/**
 * "גודל כרטיסי לקחת / לשבת" (P:/specs/kiosk-service-size.md): the size of the two choices of "לאכול כאן או לקחת?" —
 * on their own screen and, with `general.servicePlacement` = attract, as the attract screen's two buttons.
 *
 * `general.serviceCardSize` = auto (absent: auto) | small | medium | large, and the optional numeric overrides in dp
 * `serviceIconSize`, `serviceCardMaxWidth`, `serviceCardHeight`; the same keys in `landscape.general` win on a screen
 * on its side. "auto": portrait as today (every measure null — the screen's own), landscape capped so the two
 * cards, the question and "להמשך" fit with room to spare.
 *
 * The same rule as the server's reference (server/app/services/kiosk_service_size.py) and pos-android's
 * KioskServiceSize.kt, against the shared golden kiosk_service_size_golden.json. Integers only.
 */

export const SERVICE_CARD_SIZES = ['auto', 'small', 'medium', 'large'] as const;
export type ServiceCardSize = (typeof SERVICE_CARD_SIZES)[number];
export const DEFAULT_SERVICE_CARD_SIZE: ServiceCardSize = 'auto';

export const SERVICE_SIZE_NUMBER_KEYS = ['serviceIconSize', 'serviceCardMaxWidth', 'serviceCardHeight'] as const;
export type ServiceSizeNumberKey = (typeof SERVICE_SIZE_NUMBER_KEYS)[number];
/** Every key of the size, in `general` and in `landscape.general`. */
export const SERVICE_SIZE_KEYS = ['serviceCardSize', ...SERVICE_SIZE_NUMBER_KEYS] as const;
export type ServiceSizeKey = (typeof SERVICE_SIZE_KEYS)[number];

export const SERVICE_SIZE_NUMBER_SPECS: Record<ServiceSizeNumberKey, { min: number; max: number; step: number }> = {
  serviceIconSize: { min: 40, max: 160, step: 4 },
  serviceCardMaxWidth: { min: 160, max: 480, step: 4 },
  serviceCardHeight: { min: 100, max: 400, step: 4 },
};

export interface ServiceMeasures {
  /** One card's width at most (dp), or null: the screen's own. */
  cardMaxWidthDp: number | null;
  cardHeightDp: number | null;
  /** The icon's tinted square (dp). */
  iconDp: number | null;
}

export interface ServiceSizeResolved extends ServiceMeasures {
  size: ServiceCardSize;
}

export const SERVICE_SIZE_PRESETS: Record<Exclude<ServiceCardSize, 'auto'>, { cardMaxWidthDp: number; cardHeightDp: number; iconDp: number }> = {
  small: { cardMaxWidthDp: 220, cardHeightDp: 150, iconDp: 56 },
  medium: { cardMaxWidthDp: 280, cardHeightDp: 190, iconDp: 72 },
  large: { cardMaxWidthDp: 360, cardHeightDp: 250, iconDp: 96 },
};

export const SERVICE_SIZE_CONSTANTS = {
  autoHeightPct: 26,
  autoHeightMinDp: 120,
  autoHeightMaxDp: 220,
  autoIconPct: 42,
  autoIconMaxDp: 96,
  autoWidthPct: 145,
  autoWidthMaxDp: 320,
  landscapeHeightShareMaxPct: 45,
  iconShareMaxPct: 60,
  widthMarginDp: 96,
  minHeightDp: 96,
  minIconDp: 32,
  minWidthDp: 120,
  attractGapDp: 12,
} as const;
const K = SERVICE_SIZE_CONSTANTS;

type Dict = Record<string, unknown>;
const isDict = (v: unknown): v is Dict => typeof v === 'object' && v !== null && !Array.isArray(v);

/** round(n / d), half up, for n ≥ 0 — integers. */
const roundHalfUpDiv = (n: number, d: number) => Math.floor((2 * n + d) / (2 * d));

/** One numeric override as a kiosk reads it: a number rounded half up to its step and clamped; anything else null. */
export function serviceNumberValue(key: ServiceSizeNumberKey, raw: unknown): number | null {
  const spec = SERVICE_SIZE_NUMBER_SPECS[key];
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  const stepped = Math.floor(raw / spec.step + 0.5) * spec.step;
  return Math.max(spec.min, Math.min(spec.max, stepped));
}

/** `serviceCardSize` as a kiosk reads it: one of the sizes, anything else "auto". */
export function serviceSizeName(raw: unknown): ServiceCardSize {
  return typeof raw === 'string' && (SERVICE_CARD_SIZES as readonly string[]).includes(raw) ? (raw as ServiceCardSize) : DEFAULT_SERVICE_CARD_SIZE;
}

/** The four keys in force: `general`'s, and in landscape the `landscape.general` ones that are set over them. */
export function serviceSettingsInForce(general: unknown, landscapeBlock: unknown, landscape: boolean): Record<ServiceSizeKey, unknown> {
  const g = isDict(general) ? general : {};
  const out = Object.fromEntries(SERVICE_SIZE_KEYS.map((k) => [k, g[k] === undefined ? null : g[k]])) as Record<ServiceSizeKey, unknown>;
  const lg = landscape && isDict(landscapeBlock) && isDict(landscapeBlock.general) ? landscapeBlock.general : null;
  if (lg) {
    for (const k of SERVICE_SIZE_KEYS) {
      if (lg[k] !== null && lg[k] !== undefined) out[k] = lg[k];
    }
  }
  return out;
}

/** "auto" on a screen on its side `heightDp` high. */
export function serviceAutoLandscape(heightDp: number): { cardMaxWidthDp: number; cardHeightDp: number; iconDp: number } {
  const h = Math.max(K.autoHeightMinDp, Math.min(K.autoHeightMaxDp, Math.floor((heightDp * K.autoHeightPct) / 100)));
  return {
    cardMaxWidthDp: Math.min(K.autoWidthMaxDp, roundHalfUpDiv(h * K.autoWidthPct, 100)),
    cardHeightDp: h,
    iconDp: Math.min(K.autoIconMaxDp, roundHalfUpDiv(h * K.autoIconPct, 100)),
  };
}

export interface ServiceSizeDisplay {
  landscape: boolean;
  widthDp?: number | null;
  heightDp?: number | null;
}

/**
 * The service cards' measures on this display: the preset ("auto": portrait — nothing; landscape — the auto rule),
 * the numeric overrides over it, the caps (landscape: 45% of the height; the icon ≤ 60% of its card; two cards
 * across the width), then the floors.
 */
export function resolveServiceSize(general: unknown, landscapeBlock: unknown, display: ServiceSizeDisplay): ServiceSizeResolved {
  const landscape = !!display.landscape;
  const width = Math.floor(display.widthDp || 0);
  const height = Math.floor(display.heightDp || 0);
  const s = serviceSettingsInForce(general, landscapeBlock, landscape);
  const size = serviceSizeName(s.serviceCardSize);
  const m: ServiceMeasures =
    size === 'auto'
      ? landscape && height > 0
        ? serviceAutoLandscape(height)
        : { cardMaxWidthDp: null, cardHeightDp: null, iconDp: null }
      : { ...SERVICE_SIZE_PRESETS[size] };
  const width0 = serviceNumberValue('serviceCardMaxWidth', s.serviceCardMaxWidth);
  const height0 = serviceNumberValue('serviceCardHeight', s.serviceCardHeight);
  const icon0 = serviceNumberValue('serviceIconSize', s.serviceIconSize);
  if (width0 !== null) m.cardMaxWidthDp = width0;
  if (height0 !== null) m.cardHeightDp = height0;
  if (icon0 !== null) m.iconDp = icon0;
  if (m.cardHeightDp !== null) {
    if (landscape && height > 0) m.cardHeightDp = Math.min(m.cardHeightDp, Math.floor((height * K.landscapeHeightShareMaxPct) / 100));
    m.cardHeightDp = Math.max(K.minHeightDp, m.cardHeightDp);
    if (m.iconDp !== null) m.iconDp = Math.min(m.iconDp, Math.floor((m.cardHeightDp * K.iconShareMaxPct) / 100));
  }
  if (m.iconDp !== null) m.iconDp = Math.max(K.minIconDp, m.iconDp);
  if (m.cardMaxWidthDp !== null) {
    if (width > 0) m.cardMaxWidthDp = Math.min(m.cardMaxWidthDp, Math.floor((width - K.widthMarginDp) / 2));
    m.cardMaxWidthDp = Math.max(K.minWidthDp, m.cardMaxWidthDp);
  }
  return { size, ...m };
}

/** The attract screen's two buttons in the start button's box: never higher / wider than the cards. */
export function serviceAttractButtons(boxWDp: number, boxHDp: number, m: ServiceMeasures): { buttonWidthDp: number; buttonHeightDp: number } {
  const h = m.cardHeightDp === null ? boxHDp : Math.min(boxHDp, m.cardHeightDp);
  const each = Math.max(0, Math.floor((boxWDp - K.attractGapDp) / 2));
  const w = m.cardMaxWidthDp === null ? each : Math.min(each, m.cardMaxWidthDp);
  return { buttonWidthDp: w, buttonHeightDp: h };
}

/* --------------------------------------------------- the screens' measures */

/** The service cards in the CSS px a kiosk's screens are drawn in (`cssPerDp` CSS px make one dp); null: the screen's own. */
export interface ServiceSizeLook {
  cssPerDp: number;
  size: ServiceCardSize;
  cardMaxWidthPx: number | null;
  cardHeightPx: number | null;
  iconPx: number | null;
}

/**
 * The look for a screen `screenWPx` × `screenHPx` CSS px (cfg: the config as drawn — applyLandscape's — whose
 * `landscape.general` wins on a screen on its side). Null when nothing is set and the screen is upright: today's.
 */
export function serviceSizeLook(cfg: unknown, landscape: boolean, screenWPx: number, screenHPx: number, cssPerDp: number): ServiceSizeLook | null {
  const k = Number.isFinite(cssPerDp) && cssPerDp > 0 ? cssPerDp : 1;
  const c = isDict(cfg) ? cfg : {};
  const r = resolveServiceSize(c.general, c.landscape, { landscape, widthDp: screenWPx / k, heightDp: screenHPx / k });
  if (r.cardMaxWidthDp === null && r.cardHeightDp === null && r.iconDp === null) return null;
  const px = (dp: number | null) => (dp === null ? null : Math.round(dp * k));
  return { cssPerDp: k, size: r.size, cardMaxWidthPx: px(r.cardMaxWidthDp), cardHeightPx: px(r.cardHeightDp), iconPx: px(r.iconDp) };
}

/* ---------------------------------------------------------------- validation */

export interface ServiceSizeIssue {
  path: string;
  code: string;
  params?: Record<string, string | number>;
}

/** The keys' own rules at `prefix` (`general` or `landscape.general`), in the dashboard's codes (enum, range). */
export function validateServiceSize(part: unknown, prefix: string): ServiceSizeIssue[] {
  const out: ServiceSizeIssue[] = [];
  if (!isDict(part)) return out;
  const size = part.serviceCardSize;
  if (size !== undefined && size !== null && !(SERVICE_CARD_SIZES as readonly unknown[]).includes(size)) out.push({ path: `${prefix}.serviceCardSize`, code: 'enum' });
  for (const key of SERVICE_SIZE_NUMBER_KEYS) {
    const v = part[key];
    if (v === undefined || v === null) continue;
    const spec = SERVICE_SIZE_NUMBER_SPECS[key];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < spec.min || v > spec.max || (v - spec.min) % spec.step !== 0) {
      out.push({ path: `${prefix}.${key}`, code: 'range', params: { min: spec.min, max: spec.max } });
    }
  }
  return out;
}
