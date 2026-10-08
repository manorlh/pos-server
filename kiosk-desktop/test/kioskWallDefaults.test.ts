/**
 * "קיר כפתורים" (layout.quickAdd = always) on the Windows kiosk, as on the Android one: a dish whose
 * required choices are all answered by their defaults goes in with one tap, on those defaults; one
 * whose required choice has no default opens the small window. Through the kiosk's own path: the
 * menu as the till's pull sends it (every option says whether it is the default) → its catalog
 * (buildKioskCatalog) → the shared rule (defaultsLine, tapPathOf).
 */
import { describe, expect, it } from 'vitest';
import { tapPathOf } from '@dash-lib/kioskLayout';
import { defaultsLine } from '@kiosk-shared/index';
import { buildKioskCatalog } from '../src/main/kiosk/catalog';

const menu = {
  groups: [
    {
      id: 'g-done', name: 'מידת עשייה', kind: 'choice', minSelect: 1, maxSelect: 1, isActive: true,
      options: [
        { id: 'o-rare', name: 'נא', price: 0, isDefault: false },
        { id: 'o-medium', name: 'מדיום', price: 2, isDefault: true },
      ],
    },
    {
      id: 'g-extra', name: 'תוספות', kind: 'addon', minSelect: 0, maxSelect: 3, freeCount: 1, isActive: true,
      options: [
        { id: 'o-cheese', name: 'גבינה', price: 5, isDefault: true },
        { id: 'o-egg', name: 'ביצה', price: 4, isDefault: false },
      ],
    },
    {
      id: 'g-sauce', name: 'רוטב', kind: 'choice', minSelect: 1, maxSelect: 1, isActive: true,
      options: [
        { id: 'o-bbq', name: 'ברביקיו', price: 0, isDefault: false },
        { id: 'o-garlic', name: 'שום', price: 0, isDefault: false },
      ],
    },
  ],
  links: { categories: {}, products: { burger: ['g-done', 'g-extra'], wrap: ['g-sauce'], cola: [] } },
};

const catalog = buildKioskCatalog(
  {
    categories: [{ id: 'c1', name: 'המבורגרים', isActive: true }],
    products: [
      { id: 'burger', name: 'המבורגר', price: 52, categoryId: 'c1' },
      { id: 'wrap', name: 'לאפה', price: 44, categoryId: 'c1' },
      { id: 'cola', name: 'קולה', price: 12, categoryId: 'c1' },
    ],
    menu,
    machineCatalog: null,
  },
  {},
  () => null,
);
const product = (id: string) => catalog.products.find((p) => p.id === id)!;

describe('the wall of buttons adds on the defaults (quickAdd always)', () => {
  it('carries every option\'s default from the till\'s menu into the kiosk\'s catalog', () => {
    expect(catalog.groups.burger.map((g) => g.options.map((o) => o.isDefault))).toEqual([[false, true], [true, false]]);
  });

  it('puts a dish its defaults answer in on them, priced as the window prices it', () => {
    const line = defaultsLine(product('burger'), catalog.groups.burger);
    expect(line).not.toBeNull();
    expect(line!.options.map((o) => [o.optionId, o.chargedAgorot])).toEqual([['o-medium', 200], ['o-cheese', 0]]);
    expect(line!.unitAgorot).toBe(5400);
    expect(line!.texts).toEqual(['מדיום', 'גבינה']);
    expect(tapPathOf({ addPath: 'sheet', defaultsAnswer: true }, 'always', false, false)).toBe('direct');
  });

  it('opens the window for a required choice with no default, and never adds a meal on a tap', () => {
    expect(defaultsLine(product('wrap'), catalog.groups.wrap)).toBeNull();
    expect(tapPathOf({ addPath: 'sheet', defaultsAnswer: false }, 'always', false, false)).toBe('sheet');
    expect(tapPathOf({ addPath: 'sheet', defaultsAnswer: true }, 'always', false, true)).toBe('sheet');
    // "כשאין חובה לבחור": only what needs no choice goes in on a tap.
    expect(tapPathOf({ addPath: 'sheet', defaultsAnswer: true }, 'no_required', false, false)).toBe('sheet');
    expect(tapPathOf({ addPath: 'direct' }, 'no_required', false, false)).toBe('direct');
  });

  it('a dish with nothing to choose stays the plain line of today', () => {
    expect(catalog.groups.cola).toBeUndefined();
    expect(defaultsLine(product('cola'), [])).toEqual({ unitAgorot: 1200, options: [], texts: [] });
  });
});
