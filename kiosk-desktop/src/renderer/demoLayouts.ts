/**
 * The web demo's (`npm run dev:web`) layouts switch and its richer menu (docs/SPEC_KIOSK_LAYOUTS.md):
 *
 *   ?layout=standard|guided|tabs|landing|fastfood   the kiosk's `layout.template`
 *   &reach=low                                       the accessible mode (layout.reach)
 *   &toggle=1                                        the ♿ button (layout.reachToggle)
 *   &welcome=top|middle|bottom[&align=center]        "ברוכים הבאים" (attract.welcome)
 *   &rich=0                                          the small menu of before
 *
 * With `?layout=` the demo shows a fuller menu — eight categories, their dishes with pictures (an
 * emoji on its colour, drawn here, never fetched), a meal for the burgers — so each layout can be
 * looked at as a business would see it. Demo only: never in the kiosk itself.
 */

import { LAYOUT_TEMPLATES } from '@dash-lib/kioskLayout';
import type { KioskView } from '../shared/bridge';

type Catalog = KioskView['catalog'];

/** `?layout=…` as a config layer (or nothing). */
export function demoLayoutLayer(q: URLSearchParams): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const layout: Record<string, unknown> = {};
  const t = q.get('layout');
  if (t && (LAYOUT_TEMPLATES as string[]).includes(t)) layout.template = t;
  if (q.get('reach') === 'low') layout.reach = 'low';
  if (q.get('toggle') === '1') layout.reachToggle = true;
  if (Object.keys(layout).length > 0) out.layout = layout;
  const w = q.get('welcome');
  if (w === 'top' || w === 'middle' || w === 'bottom') {
    out.attract = { welcome: { position: w, align: q.get('align') === 'center' ? 'center' : 'start', size: w === 'top' ? 'xl' : 'l' } };
  }
  return out;
}

/** Whether the demo shows the fuller menu. */
export function demoRich(q: URLSearchParams): boolean {
  return q.has('layout') && q.get('rich') !== '0';
}

/** A dish's picture for the demo: its emoji on a soft tile of its colour (an SVG data URL). */
function art(emoji: string, hue: number): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400">` +
    `<defs><radialGradient id="g" cx="50%" cy="30%" r="80%"><stop offset="0" stop-color="hsl(${hue} 95% 95%)"/>` +
    `<stop offset="0.55" stop-color="hsl(${hue} 75% 82%)"/><stop offset="1" stop-color="hsl(${hue} 55% 66%)"/></radialGradient></defs>` +
    `<rect width="400" height="400" fill="url(#g)"/>` +
    `<text x="200" y="250" font-size="190" text-anchor="middle" font-family="Segoe UI Emoji, Apple Color Emoji, Noto Color Emoji">${emoji}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** The fuller demo menu. */
export function richCatalog(): Catalog {
  const cats = [
    { id: 'k-deals', name: 'מבצעים' },
    { id: 'k-burgers', name: 'המבורגרים' },
    { id: 'k-pita', name: 'פיתות' },
    { id: 'k-salads', name: 'סלטים' },
    { id: 'k-sides', name: 'תוספות' },
    { id: 'k-drinks', name: 'שתייה' },
    { id: 'k-desserts', name: 'קינוחים' },
    { id: 'k-kids', name: 'ילדים' },
  ].map((c) => ({ ...c, imageUrl: null }));
  const products: Catalog['products'] = [];
  const p = (id: string, categoryId: string, name: string, price: number, emoji: string, hue: number, description: string | null = null, extra: Partial<Catalog['products'][number]> = {}) =>
    products.push({
      id,
      name,
      price,
      imageUrl: art(emoji, hue),
      imageLarge: null,
      soldOut: false,
      available: true,
      description,
      categoryId,
      dietaryTags: [] as never[],
      allergens: [],
      sku: null,
      trackStock: false,
      meal: false,
      ...extra,
    } as Catalog['products'][number]);
  p('d1', 'k-deals', 'ארוחת סמאש', 72, '🍔', 8, 'בורגר + צ׳יפס + שתייה — רק השבוע', { meal: true });
  p('d2', 'k-deals', 'דיל צהריים', 62, '🥙', 32, 'פיתה + סלט + שתייה עד 16:00');
  p('b1', 'k-burgers', 'המבורגר קלאסי', 58, '🍔', 30, '220 גרם בקר, חסה, עגבנייה, בצל סגול');
  p('b2', 'k-burgers', 'סמאש כפול', 68, '🍔', 18, '2 קציצות, צ׳דר, בצל מקורמל');
  p('b3', 'k-burgers', 'צ׳יזבורגר', 62, '🍔', 40, 'צ׳דר מותך, חמוצים, רוטב הבית');
  p('b4', 'k-burgers', 'בורגר טבעוני', 54, '🍔', 100, 'קציצת עדשים ופטריות');
  p('b5', 'k-burgers', 'ארוחת המבורגר', 82, '🍟', 45, 'המבורגר, צ׳יפס ושתייה', { meal: true });
  p('b6', 'k-burgers', 'ארוחה גדולה', 87, '🍟', 50, 'המבורגר, צ׳יפס גדול ושתייה גדולה', { meal: true });
  p('p1', 'k-pita', 'פיתה שווארמה', 46, '🥙', 34, 'פרגית על האש, טחינה, סלט');
  p('p2', 'k-pita', 'פיתה פלאפל', 28, '🧆', 90, 'פלאפל טרי, חומוס, חמוצים');
  p('p3', 'k-pita', 'לאפה מעורב', 52, '🌯', 28);
  p('s1', 'k-salads', 'סלט קיסר', 44, '🥗', 105, 'חסה, קרוטונים, פרמזן');
  p('s2', 'k-salads', 'סלט ישראלי', 32, '🥗', 120);
  p('t1', 'k-sides', 'צ׳יפס', 18, '🍟', 45);
  p('t2', 'k-sides', 'טבעות בצל', 22, '🧅', 38);
  p('t3', 'k-sides', 'כנפיים', 36, '🍗', 22, 'ברביקיו');
  p('r1', 'k-drinks', 'קולה', 12, '🥤', 0);
  p('r2', 'k-drinks', 'לימונדה', 16, '🍋', 55);
  p('r3', 'k-drinks', 'בירה', 26, '🍺', 42);
  p('r4', 'k-drinks', 'אספרסו', 11, '☕', 28);
  p('q1', 'k-desserts', 'גלידה', 18, '🍦', 330);
  p('q2', 'k-desserts', 'עוגת שוקולד', 28, '🍰', 340);
  p('q3', 'k-desserts', 'סופגנייה', 14, '🍩', 20);
  p('k1', 'k-kids', 'ארוחת ילדים', 39, '🧒', 200, 'מיני בורגר, צ׳יפס ומיץ');
  p('k2', 'k-kids', 'שניצלונים', 34, '🍗', 32);
  return {
    categories: cats,
    products,
    groups: {
      b1: [
        { id: 'g1', name: 'מידת עשייה', kind: 'choice', min: 1, max: 1, options: [{ id: 'o1', name: 'מדיום', price: 0, isDefault: true }, { id: 'o2', name: 'מדיום־וול', price: 0, isDefault: false }, { id: 'o3', name: 'וול דאן', price: 0, isDefault: false }] },
        { id: 'g2', name: 'תוספות', kind: 'addon', min: 0, max: 3, options: [{ id: 'o4', name: 'ביצת עין', price: 6, isDefault: false }, { id: 'o5', name: 'פטריות', price: 5, isDefault: false }, { id: 'o6', name: 'חלפיניו', price: 4, isDefault: false }] },
      ],
      b2: [
        { id: 'g3', name: 'גודל', kind: 'choice', min: 1, max: 1, options: [{ id: 'o7', name: 'רגיל', price: 0, isDefault: true }, { id: 'o8', name: 'כפול', price: 10, isDefault: false }] },
        { id: 'g4', name: 'בלי…', kind: 'removal', min: 0, max: 4, options: [{ id: 'o9', name: 'בצל', price: 0, isDefault: false }, { id: 'o10', name: 'עגבנייה', price: 0, isDefault: false }, { id: 'o11', name: 'חסה', price: 0, isDefault: false }] },
      ],
    } as unknown as Catalog['groups'],
    quickNotes: { b1: ['בלי בצל', 'רוטב בצד'] },
    // "להפוך לארוחה?": the burgers' upgrade to the meals.
    upsells: [
      { triggerType: 'product', triggerIds: ['b1', 'b2', 'b3'], productIds: ['b5', 'b6'], categoryIds: [], prompt: 'רוצים להפוך לארוחה?' },
    ],
    categoryImages: {},
  };
}
