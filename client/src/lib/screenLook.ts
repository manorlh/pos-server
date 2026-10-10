/**
 * "עיצוב המסך" — the look of a kitchen screen (KDS) and of the "מוכן / לא מוכן" board, read from
 * the cloud's `device.display` (`kds_devices.display` v2 — server app/services/kds_display.py,
 * docs/SPEC_KDS.md §14) and cleaned: an unknown or missing value is its default, and every default
 * is the screen's look before the designs (the "tickets" kitchen screen, the two-column board).
 *
 * Also the demo's address switches (`/kds?demo=1&layout=list&theme=light…`, `/board?demo=1&layout=
 * spotlight…`) and the other way round — the address of a look (the dashboard's preview links, the
 * screenshots).
 *
 * Shared by the Windows app and the browser screens; self-contained (no `@/` imports): the node tests
 * and kiosk-desktop compile it as is.
 */

import type {
  BoardDisplay,
  BoardLayout,
  BoardMedia,
  KdsColumnsBy,
  KdsDensity,
  KdsDisplay,
  KdsField,
  KdsLayout,
  KdsSoundEvent,
  KdsSoundTone,
  ScreenDisplay,
  ScreenThemeName,
} from './kdsScreenTypes';

export const SCREEN_THEMES: readonly ScreenThemeName[] = ['dark', 'light', 'contrast', 'brand'];
export const KDS_LAYOUTS: readonly KdsLayout[] = ['tickets', 'columns', 'rail', 'list', 'big'];
export const BOARD_LAYOUTS: readonly BoardLayout[] = ['columns', 'spotlight', 'grid', 'split', 'ticker'];
export const KDS_COLUMNS_BY: readonly KdsColumnsBy[] = ['station', 'course'];
export const KDS_DENSITIES: readonly KdsDensity[] = ['compact', 'normal', 'large'];
export const KDS_SOUND_TONES: readonly KdsSoundTone[] = ['chime', 'bell', 'knock', 'beep', 'off'];
export const KDS_SOUND_EVENTS: readonly KdsSoundEvent[] = ['new', 'change', 'late'];
export const KDS_FIELDS: readonly KdsField[] = ['table', 'name', 'waiter', 'guests', 'course', 'notes', 'allergens', 'modifiers'];

export const FONT_SCALE_MIN = 0.8;
export const FONT_SCALE_MAX = 1.6;
export const WARN_MAX = 240;
export const LATE_MAX = 480;
export const READY_MINUTES_MAX = 240;
export const MEDIA_MAX = 12;
export const MEDIA_SECONDS_MIN = 3;
export const MEDIA_SECONDS_MAX = 300;
export const MEDIA_SECONDS_DEFAULT = 8;
export const TITLE_MAX = 60;
export const PROMO_MAX = 140;

/** Today's sounds: a new order chimes, a cancellation / note knocks, nothing when a card turns late. */
export const DEFAULT_SOUNDS: Readonly<Record<KdsSoundEvent, KdsSoundTone>> = { new: 'chime', change: 'knock', late: 'off' };

export const DEFAULT_KDS_DISPLAY: KdsDisplay = {
  theme: 'dark',
  accent: null,
  layout: 'tickets',
  columnsBy: 'station',
  density: 'normal',
  fontScale: 1,
  ageColors: true,
  warnMinutes: null,
  lateMinutes: null,
  fields: { table: true, name: true, waiter: true, guests: true, course: true, notes: true, allergens: true, modifiers: true },
  sounds: { ...DEFAULT_SOUNDS },
  clock: true,
  counts: true,
};

export const DEFAULT_BOARD_DISPLAY: BoardDisplay = {
  theme: 'dark',
  accent: null,
  sound: true,
  showPreparing: true,
  title: null,
  boardLayout: 'columns',
  readyMinutes: null,
  media: [],
  promoText: null,
};

export const DEFAULT_SCREEN_DISPLAY: ScreenDisplay = { ...DEFAULT_BOARD_DISPLAY, ...DEFAULT_KDS_DISPLAY, fields: { ...DEFAULT_KDS_DISPLAY.fields }, sounds: { ...DEFAULT_SOUNDS } };

/** How dense the tickets are: a card's least width and the gaps (px, before the font scale). */
export const DENSITY_SPEC: Readonly<Record<KdsDensity, { minWidth: number; gap: number }>> = {
  compact: { minWidth: 270, gap: 8 },
  normal: { minWidth: 330, gap: 12 },
  large: { minWidth: 420, gap: 16 },
};

const HEX = /^#[0-9a-f]{6}$/i;
const URL_RE = /^https?:\/\/\S+$/;
const DATA_IMAGE = /^data:image\/(svg\+xml|png|jpeg|webp)[;,]\S+$/;
const SHA = /^[0-9a-f]{64}$/i;

type Raw = Record<string, unknown>;
const rec = (v: unknown): Raw => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : {});
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => (typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback);
const flag = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);
const text = (v: unknown, max: number): string | null => (typeof v === 'string' ? v.split(/\s+/).filter(Boolean).join(' ').slice(0, max) || null : null);

function intIn(v: unknown, lo: number, hi: number): number | null {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || !Number.isInteger(n)) return null;
  return n >= lo && n <= hi ? n : null;
}

function accentOf(v: unknown): string | null {
  return typeof v === 'string' && HEX.test(v.trim()) ? v.trim().toLowerCase() : null;
}

function fontScaleOf(v: unknown): number {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) return 1;
  return Math.round(Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, n)) * 100) / 100;
}

/** Both or neither, the late one after the warning; otherwise the stations' thresholds. */
function thresholdsOf(r: Raw): { warnMinutes: number | null; lateMinutes: number | null } {
  const warn = intIn(r.warnMinutes, 1, WARN_MAX);
  const late = intIn(r.lateMinutes, 1, LATE_MAX);
  if (warn === null || late === null || late <= warn) return { warnMinutes: null, lateMinutes: null };
  return { warnMinutes: warn, lateMinutes: late };
}

function mediaOf(v: unknown): BoardMedia[] {
  if (!Array.isArray(v)) return [];
  const out: BoardMedia[] = [];
  for (const x of v) {
    const m = rec(x);
    // The cloud sends http(s) only; a picture made in the page (the demo's) is a data URL.
    const ok = typeof m.url === 'string' && ((m.url.length <= 1000 && URL_RE.test(m.url)) || DATA_IMAGE.test(m.url));
    if (!ok || typeof m.url !== 'string') continue;
    out.push({
      url: m.url,
      kind: m.kind === 'video' ? 'video' : 'image',
      sha256: typeof m.sha256 === 'string' && SHA.test(m.sha256) ? m.sha256.toLowerCase() : null,
      bytes: typeof m.bytes === 'number' && Number.isInteger(m.bytes) && m.bytes >= 0 ? m.bytes : null,
      durationSec: intIn(m.durationSec, MEDIA_SECONDS_MIN, MEDIA_SECONDS_MAX) ?? MEDIA_SECONDS_DEFAULT,
    });
    if (out.length >= MEDIA_MAX) break;
  }
  return out;
}

/** The board's keys of a stored look (v1 or v2), cleaned; null / not an object = the defaults. */
export function boardDisplayOf(raw: unknown): BoardDisplay {
  const r = rec(raw);
  return {
    theme: oneOf(r.theme, SCREEN_THEMES, DEFAULT_BOARD_DISPLAY.theme),
    accent: accentOf(r.accent),
    sound: r.sound !== false,
    showPreparing: r.showPreparing !== false,
    title: text(r.title, TITLE_MAX),
    boardLayout: oneOf(r.boardLayout, BOARD_LAYOUTS, DEFAULT_BOARD_DISPLAY.boardLayout),
    readyMinutes: intIn(r.readyMinutes, 1, READY_MINUTES_MAX),
    media: mediaOf(r.media),
    promoText: text(r.promoText, PROMO_MAX),
  };
}

/** The kitchen screen's keys of a stored look, cleaned; null / not an object = today's look. */
export function kdsDisplayOf(raw: unknown): KdsDisplay {
  const r = rec(raw);
  const fields = rec(r.fields);
  const sounds = rec(r.sounds);
  return {
    theme: oneOf(r.theme, SCREEN_THEMES, DEFAULT_KDS_DISPLAY.theme),
    accent: accentOf(r.accent),
    layout: oneOf(r.layout, KDS_LAYOUTS, DEFAULT_KDS_DISPLAY.layout),
    columnsBy: oneOf(r.columnsBy, KDS_COLUMNS_BY, DEFAULT_KDS_DISPLAY.columnsBy),
    density: oneOf(r.density, KDS_DENSITIES, DEFAULT_KDS_DISPLAY.density),
    fontScale: fontScaleOf(r.fontScale),
    ageColors: flag(r.ageColors, true),
    ...thresholdsOf(r),
    fields: Object.fromEntries(KDS_FIELDS.map((f) => [f, flag(fields[f], true)])) as Record<KdsField, boolean>,
    sounds: Object.fromEntries(KDS_SOUND_EVENTS.map((e) => [e, oneOf(sounds[e], KDS_SOUND_TONES, DEFAULT_SOUNDS[e])])) as Record<KdsSoundEvent, KdsSoundTone>,
    clock: flag(r.clock, true),
    counts: flag(r.counts, true),
  };
}

/** The whole look (both groups) — the dashboard's editor. */
export function screenDisplayOf(raw: unknown): ScreenDisplay {
  return { ...boardDisplayOf(raw), ...kdsDisplayOf(raw) };
}

/** The body the cloud takes (`KdsDisplayIn`): the look, its texts trimmed. */
export function screenDisplayInput(d: ScreenDisplay): ScreenDisplay {
  const clean = screenDisplayOf(d);
  return { ...clean, title: text(d.title, TITLE_MAX), promoText: text(d.promoText, PROMO_MAX) };
}

/** The age thresholds a card uses: the screen's own, else null (its stations'). */
export function screenThresholds(d: Pick<KdsDisplay, 'warnMinutes' | 'lateMinutes'> | null | undefined): { warn: number; late: number } | null {
  if (!d || d.warnMinutes === null || d.lateMinutes === null || d.lateMinutes <= d.warnMinutes) return null;
  return { warn: d.warnMinutes, late: d.lateMinutes };
}

/* ------------------------------------------------------------- the address */

/**
 * A look from the demo's address. KDS: `layout`, `by` (station | course), `theme`, `accent`, `density`,
 * `font` (0.8–1.6), `age` ("8-12" = the screen's thresholds; "off" = no colours), `hide` (fields,
 * comma separated), `clock=0`, `counts=0`, `sound` ("new:bell,late:beep"). Board: `layout`, `theme`,
 * `accent`, `prep=0`, `sound=0`, `title`, `ready` (minutes), `promo`, `media` (URLs, comma separated,
 * or "demo"). Anything not given is the default.
 */
export function lookFromQuery(q: URLSearchParams, route: 'kds' | 'board', demoMedia: BoardMedia[] = []): ScreenDisplay {
  const raw: Raw = {
    theme: q.get('theme') ?? undefined,
    accent: q.get('accent') ?? undefined,
    title: q.get('title') ?? undefined,
  };
  if (route === 'board') {
    raw.boardLayout = q.get('layout') ?? undefined;
    raw.showPreparing = q.get('prep') !== '0';
    raw.sound = q.get('sound') !== '0';
    raw.readyMinutes = q.get('ready') ?? undefined;
    raw.promoText = q.get('promo') ?? undefined;
    const media = q.get('media');
    raw.media =
      media === 'demo'
        ? demoMedia
        : (media ?? '')
            .split(',')
            .map((url) => url.trim())
            .filter(Boolean)
            .map((url) => ({ url, kind: /\.(mp4|webm)(\?|$)/i.test(url) ? 'video' : 'image' }));
  } else {
    raw.layout = q.get('layout') ?? undefined;
    raw.columnsBy = q.get('by') ?? undefined;
    raw.density = q.get('density') ?? undefined;
    raw.fontScale = q.get('font') ?? undefined;
    const age = q.get('age');
    if (age === 'off') raw.ageColors = false;
    const m = /^(\d+)-(\d+)$/.exec(age ?? '');
    if (m) Object.assign(raw, { warnMinutes: Number(m[1]), lateMinutes: Number(m[2]) });
    const hidden = new Set((q.get('hide') ?? '').split(',').map((s) => s.trim()));
    raw.fields = Object.fromEntries(KDS_FIELDS.map((f) => [f, !hidden.has(f)]));
    raw.clock = q.get('clock') !== '0';
    raw.counts = q.get('counts') !== '0';
    raw.sounds = Object.fromEntries(
      (q.get('sound') ?? '')
        .split(',')
        .map((p) => p.split(':'))
        .filter((p) => p.length === 2),
    );
  }
  return screenDisplayOf(raw);
}

/** The demo address of a look (only what differs from the defaults): `/kds?demo=1&…` / `/board?demo=1&…`. */
export function lookQuery(d: ScreenDisplay, route: 'kds' | 'board'): string {
  const q = new URLSearchParams({ demo: '1' });
  const base = DEFAULT_SCREEN_DISPLAY;
  if (d.theme !== base.theme) q.set('theme', d.theme);
  if (d.accent) q.set('accent', d.accent);
  if (route === 'board') {
    if (d.boardLayout !== base.boardLayout) q.set('layout', d.boardLayout);
    if (!d.showPreparing) q.set('prep', '0');
    if (!d.sound) q.set('sound', '0');
    if (d.title) q.set('title', d.title);
    if (d.readyMinutes) q.set('ready', String(d.readyMinutes));
    if (d.promoText) q.set('promo', d.promoText);
    if (d.media.length) q.set('media', d.media.map((m) => m.url).join(','));
  } else {
    if (d.layout !== base.layout) q.set('layout', d.layout);
    if (d.columnsBy !== base.columnsBy) q.set('by', d.columnsBy);
    if (d.density !== base.density) q.set('density', d.density);
    if (d.fontScale !== 1) q.set('font', String(d.fontScale));
    if (!d.ageColors) q.set('age', 'off');
    else if (d.warnMinutes !== null && d.lateMinutes !== null) q.set('age', `${d.warnMinutes}-${d.lateMinutes}`);
    const hidden = KDS_FIELDS.filter((f) => !d.fields[f]);
    if (hidden.length) q.set('hide', hidden.join(','));
    if (!d.clock) q.set('clock', '0');
    if (!d.counts) q.set('counts', '0');
    const sounds = KDS_SOUND_EVENTS.filter((e) => d.sounds[e] !== DEFAULT_SOUNDS[e]).map((e) => `${e}:${d.sounds[e]}`);
    if (sounds.length) q.set('sound', sounds.join(','));
  }
  return `/${route}?${q.toString()}`;
}

/** Black or white text on a "#rrggbb" background (WCAG relative luminance). */
export function textOn(hex: string): '#000000' | '#ffffff' {
  if (!HEX.test(hex)) return '#ffffff';
  const ch = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const l = 0.2126 * ch(1) + 0.7152 * ch(3) + 0.0722 * ch(5);
  // The colour where black and white text have the same contrast ratio.
  return l > 0.179 ? '#000000' : '#ffffff';
}
