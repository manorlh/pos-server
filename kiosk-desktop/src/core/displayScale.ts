/**
 * "גודל תצוגה" (P:/specs/display-scale.md; the owner 16.10.2026: "אפשר בענן להגדיר וגם בקיוסק עצמו בהגדרות ולשמור"):
 * the size of everything on the kiosk's / the till's window. The cloud's till parameter `displayScale` (company → shop →
 * point of sale → till, resolved by the cloud: `GET /sync/{m}/parameters`) is "auto" (today) or a percent 70–150 in
 * steps of 5; the technician's local choice (kiosk.json `displayScale`) wins over it. The percent multiplies the
 * window's automatic page zoom (core/windowZoom.ts).
 *
 * ONE rule with pos-server app/services/display_scale.py and pos-android domain/DisplayScale.kt, pinned by the shared
 * golden display_scale_golden.json (test/fixtures; the same bytes in server/tests/fixtures and the Android test
 * resources).
 */

export const DISPLAY_SCALE_PARAM = 'displayScale';
export const DISPLAY_SCALE_AUTO = 'auto';
export const DISPLAY_SCALE_MIN = 70;
export const DISPLAY_SCALE_MAX = 150;
export const DISPLAY_SCALE_STEP = 5;
/** Below this a number is not a percent at all (a factor such as 1.5, a slip) — not set. */
export const DISPLAY_SCALE_MIN_READ = 10;
/** The cloud's levels, the most specific first (the device's own local choice is above them all). */
export const DISPLAY_SCALE_LEVELS = ['device', 'area', 'shop', 'company'] as const;

export type DisplayScaleLevel = (typeof DISPLAY_SCALE_LEVELS)[number];
/** "auto", or a percent 70–150 in steps of 5. */
export type DisplayScaleSetting = 'auto' | number;
export type DisplayScaleSource = 'local' | 'cloud' | 'auto';

export interface DisplayScaleEffective {
  setting: DisplayScaleSetting;
  percent: number;
  factor: number;
  source: DisplayScaleSource;
  /** 'local' or the cloud level the value came from; null: nothing set anywhere. */
  level: 'local' | DisplayScaleLevel | null;
}

const NUMBER = /^-?\d+(?:\.\d+)?%?$/;
const AUTO_WORDS = new Set(['auto', 'אוטומטי']);

/** A level's (or the local) value as a setting, or null (not set / not valid). Numbers are stepped to 5 and clamped. */
export function parseDisplayScale(value: unknown): DisplayScaleSetting | null {
  let n: number;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string') {
    const text = value.trim();
    if (AUTO_WORDS.has(text.toLowerCase())) return DISPLAY_SCALE_AUTO;
    if (!NUMBER.test(text)) return null;
    n = Number(text.replace(/%$/, ''));
  } else return null;
  if (!Number.isFinite(n) || n < DISPLAY_SCALE_MIN_READ) return null;
  const stepped = Math.floor(n / DISPLAY_SCALE_STEP + 0.5) * DISPLAY_SCALE_STEP;
  return Math.max(DISPLAY_SCALE_MIN, Math.min(DISPLAY_SCALE_MAX, stepped));
}

export function percentOf(setting: DisplayScaleSetting | null): number {
  return typeof setting === 'number' ? setting : 100;
}

/** The local choice when there is one; else the most specific level with a valid value; else automatic. */
export function effectiveDisplayScale(
  levels: Partial<Record<DisplayScaleLevel, unknown>>,
  local?: unknown,
): DisplayScaleEffective {
  const mine = parseDisplayScale(local);
  let setting: DisplayScaleSetting = DISPLAY_SCALE_AUTO;
  let level: DisplayScaleEffective['level'] = null;
  let source: DisplayScaleSource;
  if (mine !== null) {
    setting = mine;
    level = 'local';
    source = 'local';
  } else {
    for (const name of DISPLAY_SCALE_LEVELS) {
      const parsed = parseDisplayScale(levels[name]);
      if (parsed !== null) {
        setting = parsed;
        level = name;
        break;
      }
    }
    source = typeof setting === 'number' ? 'cloud' : 'auto';
  }
  const percent = percentOf(setting);
  return { setting, percent, factor: percent / 100, source, level };
}

/** On a device: the cloud's value as it resolved for this kiosk / till, under the local choice. */
export function deviceDisplayScale(cloud: unknown, local: unknown): DisplayScaleEffective {
  return effectiveDisplayScale({ device: cloud }, local);
}

/** "−" / "+" in the technician's control: 5% down or up, within 70–150. */
export function steppedDisplayScale(percent: number, up: boolean): number {
  return Math.max(DISPLAY_SCALE_MIN, Math.min(DISPLAY_SCALE_MAX, percent + (up ? DISPLAY_SCALE_STEP : -DISPLAY_SCALE_STEP)));
}

/** The stored form: "auto" or "85". */
export function displayScaleWire(setting: DisplayScaleSetting): string {
  return typeof setting === 'number' ? String(setting) : DISPLAY_SCALE_AUTO;
}

/** What the technician's screen shows as the source. */
export const DISPLAY_SCALE_SOURCE_LABELS: Record<DisplayScaleSource, string> = {
  local: 'מקומי',
  cloud: 'ענן',
  auto: 'אוטומטי',
};

// ── The window's zoom (Windows) ──────────────────────────────────────────────

/** The technician's old local "זום" (kiosk.json `zoom`, ×1 / ×1.5 / ×2 …: an absolute page zoom) — read while no new choice is saved. */
export function legacyZoomOf(zoom: unknown): number | null {
  return typeof zoom === 'number' && zoom > 0.5 && zoom < 4 ? zoom : null;
}

export interface WindowZoomPlan {
  /** The page zoom the window is given. */
  zoom: number;
  /** The automatic zoom (core/windowZoom.ts kioskWindowZoom, without any local choice). */
  autoZoom: number;
  effective: DisplayScaleEffective;
  /** The old absolute "זום" still in force (no new choice saved over it): its value. */
  legacyZoom: number | null;
}

/**
 * The window's zoom: the automatic one × "גודל תצוגה". The local choice (`local`, kiosk.json `displayScale`) wins;
 * without one, an old absolute "זום" still saved keeps working exactly as before (shown as local, its share of the
 * automatic zoom as the percent); else the cloud's value (`cloud`, the parameter as resolved for this device).
 */
export function windowZoomPlan(autoZoom: number, cloud: unknown, local: unknown, legacyZoom?: unknown): WindowZoomPlan {
  const effective = deviceDisplayScale(cloud, local);
  const legacy = legacyZoomOf(legacyZoom);
  if (effective.source !== 'local' && legacy !== null) {
    const percent = Math.round((legacy / autoZoom) * 100);
    return {
      zoom: legacy,
      autoZoom,
      effective: { setting: percent, percent, factor: legacy / autoZoom, source: 'local', level: 'local' },
      legacyZoom: legacy,
    };
  }
  return { zoom: autoZoom * effective.factor, autoZoom, effective, legacyZoom: null };
}
