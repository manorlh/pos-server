/**
 * WCAG 2.x contrast of a public theme — the dashboard's twin of the server's
 * app/services/digital_legal/contrast.py. Both are pinned by the shared golden fixture
 * server/tests/fixtures/contrast_golden.json (contrast.test.ts reads the same file), so the editor's
 * `ContrastValidator` and the server's publication gate never disagree.
 *
 * A theme is the kiosk-style token set (`backgroundColor`, `surfaceColor`, `textColor`,
 * `primaryColor`, `accentColor`, `buttonColor`, `buttonTextColor`, optional `mutedTextColor`,
 * `linkColor`, `focusColor`) plus optional template `pairs`. Minimums (AA): text 4.5:1, large text
 * 3:1, UI (focus ring, icons, borders) 3:1. A ratio is never rounded up: 4.48 fails 4.5.
 *
 * Pure (no React).
 */

export type ContrastKind = 'text' | 'large' | 'ui';

export const AA_MIN: Record<ContrastKind, number> = { text: 4.5, large: 3, ui: 3 };

export interface ThemeTokens {
  backgroundColor?: string | null;
  surfaceColor?: string | null;
  textColor?: string | null;
  mutedTextColor?: string | null;
  primaryColor?: string | null;
  accentColor?: string | null;
  buttonColor?: string | null;
  buttonTextColor?: string | null;
  linkColor?: string | null;
  focusColor?: string | null;
  pairs?: Array<{ id: string; fg: string | null | undefined; bg: string | null | undefined; kind?: ContrastKind }>;
}

export interface ContrastPair {
  id: string;
  fg: string | null | undefined;
  bg: string | null | undefined;
  kind: ContrastKind;
}

export interface ContrastPairResult extends ContrastPair {
  /** Rounded to 2 decimals for display; null when a colour is not readable. */
  ratio: number | null;
  min: number;
  ok: boolean;
}

export interface ContrastResult {
  ok: boolean;
  pairs: ContrastPairResult[];
  failures: string[];
}

const DEFAULTS = {
  backgroundColor: '#FFFFFF',
  textColor: '#111827',
  primaryColor: '#1F6FEB',
  buttonTextColor: '#FFFFFF',
} as const;

type Rgba = [number, number, number, number];

const HEX = /^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const RGB = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*(0|1|0?\.\d+)\s*)?\)$/;

/** `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()` / `rgba()` → [r, g, b, a]; else null. */
export function parseColor(value: unknown): Rgba | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  const hex = HEX.exec(text);
  if (hex) {
    let h = hex[1];
    if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return [r, g, b, a];
  }
  const rgb = RGB.exec(text.toLowerCase());
  if (rgb) {
    const r = Number(rgb[1]);
    const g = Number(rgb[2]);
    const b = Number(rgb[3]);
    if (Math.max(r, g, b) > 255) return null;
    const a = rgb[4] !== undefined ? Number(rgb[4]) : 1;
    return [r, g, b, a];
  }
  return null;
}

function over(fg: Rgba, bg: Rgba): Rgba {
  const a = fg[3];
  return [fg[0] * a + bg[0] * (1 - a), fg[1] * a + bg[1] * (1 - a), fg[2] * a + bg[2] * (1 - a), 1];
}

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

export function luminance(rgb: Rgba): number {
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}

/** The ratio of `fg` over `bg` (a translucent background sits on white; a translucent fg on bg). */
export function contrastRatio(fg: unknown, bg: unknown): number | null {
  const f0 = parseColor(fg);
  const b0 = parseColor(bg);
  if (!f0 || !b0) return null;
  const b = over(b0, [255, 255, 255, 1]);
  const f = over(f0, b);
  const l1 = luminance(f);
  const l2 = luminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

function present(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

/** Python's round(x, 2) for the values here (half-to-even never matters at this precision). */
function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

export function themePairs(theme: ThemeTokens): ContrastPair[] {
  const t: Record<string, string> = {};
  for (const [k, v] of Object.entries(theme ?? {})) if (present(v)) t[k] = v;
  for (const [k, v] of Object.entries(DEFAULTS)) if (!(k in t)) t[k] = v;
  if (!('surfaceColor' in t)) t.surfaceColor = t.backgroundColor;
  if (!('buttonColor' in t)) t.buttonColor = t.primaryColor;
  if (!('linkColor' in t)) t.linkColor = t.primaryColor;
  if (!('focusColor' in t)) t.focusColor = t.primaryColor;
  const pairs: ContrastPair[] = [
    { id: 'text_on_background', fg: t.textColor, bg: t.backgroundColor, kind: 'text' },
    { id: 'text_on_surface', fg: t.textColor, bg: t.surfaceColor, kind: 'text' },
    { id: 'button_text', fg: t.buttonTextColor, bg: t.buttonColor, kind: 'text' },
    { id: 'link_on_background', fg: t.linkColor, bg: t.backgroundColor, kind: 'text' },
    { id: 'focus_on_background', fg: t.focusColor, bg: t.backgroundColor, kind: 'ui' },
  ];
  if (t.mutedTextColor) pairs.push({ id: 'muted_text_on_background', fg: t.mutedTextColor, bg: t.backgroundColor, kind: 'text' });
  if (t.accentColor) pairs.push({ id: 'accent_on_background', fg: t.accentColor, bg: t.backgroundColor, kind: 'ui' });
  for (const extra of theme?.pairs ?? []) {
    if (extra && typeof extra === 'object' && extra.id) {
      const kind: ContrastKind = extra.kind && extra.kind in AA_MIN ? extra.kind : 'text';
      pairs.push({ id: String(extra.id).slice(0, 60), fg: extra.fg, bg: extra.bg, kind });
    }
  }
  return pairs;
}

/** Every pair at AA — `ok` false blocks publication (the server's gate checks the same). */
export function checkThemeContrast(theme: ThemeTokens): ContrastResult {
  const pairs = themePairs(theme).map((p) => {
    const ratio = contrastRatio(p.fg, p.bg);
    const min = AA_MIN[p.kind];
    return { ...p, ratio: ratio === null ? null : round2(ratio), min, ok: ratio !== null && ratio + 1e-9 >= min };
  });
  const failures = pairs.filter((p) => !p.ok).map((p) => p.id);
  return { ok: failures.length === 0, pairs, failures };
}
