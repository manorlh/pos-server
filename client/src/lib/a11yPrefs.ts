/**
 * The optional accessibility toolbar's preferences (text size, high contrast, highlighted links,
 * stopped animations) — kept in the visitor's own browser (an essential, user-requested setting) and
 * applied as `data-a11y-*` attributes on the public page's root (styles in app/globals.css).
 *
 * The toolbar is an extra aid; it never replaces the page's own conformance (WCAG 2.2 AA).
 * Pure (no React): a11yPrefs.test.ts.
 */

export interface A11yPrefs {
  /** 0 = normal, 1–3 = larger text. */
  font: 0 | 1 | 2 | 3;
  contrast: boolean;
  links: boolean;
  still: boolean;
}

export const A11Y_PREFS_KEY = 'r2m.a11y.v1';
export const DEFAULT_A11Y_PREFS: A11yPrefs = { font: 0, contrast: false, links: false, still: false };
export const MAX_FONT_LEVEL = 3;

export function clampFont(n: unknown): A11yPrefs['font'] {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : 0;
  return Math.min(MAX_FONT_LEVEL, Math.max(0, v)) as A11yPrefs['font'];
}

export function readA11yPrefs(raw: string | null): A11yPrefs {
  if (!raw) return DEFAULT_A11Y_PREFS;
  try {
    const p = JSON.parse(raw) as Record<string, unknown>;
    return { font: clampFont(p.font), contrast: p.contrast === true, links: p.links === true, still: p.still === true };
  } catch {
    return DEFAULT_A11Y_PREFS;
  }
}

export function isDefaultA11y(p: A11yPrefs): boolean {
  return p.font === 0 && !p.contrast && !p.links && !p.still;
}

/** The root's attributes (only the active ones). */
export function a11yAttributes(p: A11yPrefs): Record<string, string> {
  const out: Record<string, string> = {};
  if (p.font) out['data-a11y-font'] = String(p.font);
  if (p.contrast) out['data-a11y-contrast'] = '';
  if (p.links) out['data-a11y-links'] = '';
  if (p.still) out['data-a11y-still'] = '';
  return out;
}

/** The document's root font size for a text level (rem-based layouts scale with it). */
export function rootFontSize(level: A11yPrefs['font']): string {
  return level ? `${100 + level * 12.5}%` : '';
}
