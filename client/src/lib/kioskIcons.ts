/**
 * The kiosk's category icons (docs/SPEC_KIOSK_LAYOUTS.md §icons): one set of SVG paths
 * (`kioskIconData.ts`, generated from the shared fixture server/tests/fixtures/kiosk_category_icons.json;
 * the Android kiosk builds its ImageVectors from the same paths), drawn three ways — line, filled,
 * duotone — plus the emoji and the photo-style tile. `catalog.categoryIconIds` picks one per category;
 * a category without one gets the icon its name suggests ("המבורגרים" → burger).
 *
 * Each icon: `b` closed body shapes, `i` details on the body, `o` strokes outside it.
 * Pure, no React.
 */

import { KIOSK_ICON_DATA } from './kioskIconData';

export interface KioskIconDef {
  id: string;
  label: { he: string; en: string };
  emoji: string;
  /** The photo-style tile's hue (0–359). */
  hue: number;
  b: string[];
  i: string[];
  o: string[];
  keywords: { he: string[]; en: string[] };
}

export interface KioskIconSet {
  version: number;
  viewBox: number;
  icons: KioskIconDef[];
  cases: Array<{ name: string; id: string | null }>;
  render?: unknown;
}

export type KioskIconStyle = 'line' | 'filled' | 'duotone';

export const KIOSK_ICON_SET: KioskIconSet = KIOSK_ICON_DATA;
export const KIOSK_ICONS: KioskIconDef[] = KIOSK_ICON_SET.icons;
export const KIOSK_ICON_IDS: string[] = KIOSK_ICONS.map((i) => i.id);

const BY_ID = new Map(KIOSK_ICONS.map((i) => [i.id, i] as const));

/** The icon drawn when nothing is set and nothing is suggested. */
export const FALLBACK_ICON = 'dine';

export function kioskIcon(id: string | null | undefined): KioskIconDef | null {
  return (id && BY_ID.get(id)) || null;
}

/** One path as drawn: filled (opacity) and / or stroked with the colour or the knock-out colour. */
export interface IconPathSpec {
  d: string;
  fill: boolean;
  fillOpacity: number;
  stroke: 'color' | 'knock';
  width: number;
}

/** The render rules (the fixture's `render`): line, filled (details knocked out), duotone. */
export function iconPaths(icon: KioskIconDef, style: KioskIconStyle): IconPathSpec[] {
  const out: IconPathSpec[] = [];
  if (style === 'line') {
    for (const d of [...icon.b, ...icon.i]) out.push({ d, fill: false, fillOpacity: 0, stroke: 'color', width: 1.7 });
  } else if (style === 'filled') {
    for (const d of icon.b) out.push({ d, fill: true, fillOpacity: 1, stroke: 'color', width: 1 });
    for (const d of icon.i) out.push({ d, fill: false, fillOpacity: 0, stroke: 'knock', width: 1.9 });
  } else {
    for (const d of icon.b) out.push({ d, fill: true, fillOpacity: 0.28, stroke: 'color', width: 1.6 });
    for (const d of icon.i) out.push({ d, fill: false, fillOpacity: 0, stroke: 'color', width: 1.6 });
  }
  for (const d of icon.o) out.push({ d, fill: false, fillOpacity: 0, stroke: 'color', width: style === 'filled' ? 2.1 : 1.7 });
  return out;
}

/** Anything but a letter or a digit, in any script (built at run time: the dashboard targets ES2017). */
const NOT_LETTER_OR_DIGIT = new RegExp('[^\\p{L}\\p{N}]+', 'gu');

/**
 * A name as the suggestion compares it: lower case, no niqqud, no geresh / quotes, the final
 * letters as the others, everything but letters and digits a space.
 */
export function normalizeCategoryName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[֑-ׇ]/g, '')
    .replace(/[׳״'"`’‘“”]/g, '')
    .replace(/ך/g, 'כ')
    .replace(/ם/g, 'מ')
    .replace(/ן/g, 'נ')
    .replace(/ף/g, 'פ')
    .replace(/ץ/g, 'צ')
    .replace(NOT_LETTER_OR_DIGIT, ' ')
    .trim();
}

/**
 * The icon a category's name suggests: the icon whose keyword matches longest (a keyword of up to
 * three letters only as a whole word, a longer one anywhere in the name), the earlier icon on a tie;
 * null when none matches. The till's KioskCategoryIcons.suggest, case for case (the fixture's `cases`).
 */
export function suggestCategoryIcon(name: string | null | undefined): string | null {
  const n = normalizeCategoryName(name ?? '');
  if (!n) return null;
  const tokens = new Set(n.split(' '));
  let best: string | null = null;
  let score = 0;
  for (const icon of KIOSK_ICONS) {
    for (const raw of [...icon.keywords.he, ...icon.keywords.en]) {
      const k = normalizeCategoryName(raw);
      if (!k) continue;
      const hit = k.length <= 3 ? tokens.has(k) : n.includes(k);
      if (hit && k.length > score) {
        score = k.length;
        best = icon.id;
      }
    }
  }
  return best;
}

/** A category's icon: the one set for it (a known id), else its name's suggestion, else the plate. */
export function categoryIconOf(categoryId: string, name: string, iconIds: Record<string, string> | null | undefined): string {
  const own = iconIds?.[categoryId];
  if (own && BY_ID.has(own)) return own;
  return suggestCategoryIcon(name) ?? FALLBACK_ICON;
}

/** The photo-style tile behind an emoji, from the icon's hue (the gallery's look). */
export function photoTileGradient(hue: number, dark = false): string {
  if (dark) return `radial-gradient(75% 70% at 50% 45%, hsl(${hue} 45% 30%), hsl(${hue} 30% 11%) 72%, #0b0a09)`;
  return `radial-gradient(110% 90% at 50% 25%, hsl(${hue} 95% 94%), hsl(${hue} 75% 80%) 55%, hsl(${hue} 55% 62%))`;
}

/** `catalog.categoryIconIds`: category ids to known icon ids. */
export function validateCategoryIconIds(map: unknown): Array<{ path: string; code: string; params?: Record<string, string | number> }> {
  if (map === undefined || map === null) return [];
  if (typeof map !== 'object' || Array.isArray(map)) return [{ path: 'catalog.categoryIconIds', code: 'enum' }];
  const out: Array<{ path: string; code: string; params?: Record<string, string | number> }> = [];
  for (const [catId, iconId] of Object.entries(map as Record<string, unknown>)) {
    if (iconId === null || iconId === undefined) continue;
    if (typeof iconId !== 'string' || !BY_ID.has(iconId)) out.push({ path: `catalog.categoryIconIds.${catId}`, code: 'unknownIcon', params: { key: String(iconId) } });
  }
  return out;
}
