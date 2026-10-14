/**
 * "תמונת מחלקה מהקטלוג" (P:/specs/category-color-image.md §3) on the Windows kiosk: the catalog it builds carries
 * each category's own picture (kept locally) and colour, and the screens take them through the shared rules —
 * the kiosk's own picture first, else the catalog's, else the initial on the catalog's colour; with
 * `catalog.categoryImagesFromCatalog` off, the kiosk's own pictures only and the initial on the theme colour.
 */

import { describe, expect, it } from 'vitest';
import { categoryRailColor, categoryRailImage, KIOSK_DEFAULTS, resolveKioskConfig } from '@dash-lib/kioskConfig';
import { buildKioskCatalog } from '../src/main/kiosk/catalog';

const catalog = {
  products: [
    { id: 'p1', name: 'קולה', price: 10, categoryId: 'drinks', inStock: true },
    { id: 'p2', name: 'צ׳יפס', price: 15, categoryId: 'sides', inStock: true },
  ],
  categories: [
    { id: 'drinks', name: 'שתייה', color: '#2563EB', imageUrl: 'https://res.cloudinary.com/demo/image/upload/v1/pos/t/categories/a.png', sortOrder: 0 },
    { id: 'sides', name: 'תוספות', color: null, imageUrl: null, sortOrder: 1 },
  ],
  menu: null,
  machineCatalog: { mode: 'all' },
};

const local = (url: string | null) => (url ? `file:///cache/${url.split('/').pop()}` : null);

describe('the catalog the Windows kiosk builds', () => {
  it('carries each category\'s picture (local) and colour', () => {
    const built = buildKioskCatalog(catalog, {}, local);
    expect(built.categories).toEqual([
      { id: 'drinks', name: 'שתייה', imageUrl: 'file:///cache/a.png', color: '#2563EB' },
      { id: 'sides', name: 'תוספות', imageUrl: null, color: null },
    ]);
  });
});

describe('what the screens show for a category', () => {
  const built = buildKioskCatalog(catalog, {}, local);
  const images = Object.fromEntries(built.categories.map((c) => [c.id, c.imageUrl]));
  const colors = Object.fromEntries(built.categories.map((c) => [c.id, c.color ?? null]));

  it('on by default: the catalog\'s picture, else the initial on the catalog\'s colour', () => {
    const cfg = resolveKioskConfig({});
    expect(cfg.catalog.categoryImagesFromCatalog).toBe(true);
    expect(categoryRailImage('drinks', cfg.catalog, images)).toBe('file:///cache/a.png');
    expect(categoryRailImage('sides', cfg.catalog, images)).toBeNull();
    expect(categoryRailColor('drinks', cfg.catalog, colors)).toBe('#2563EB');
    expect(categoryRailColor('sides', cfg.catalog, colors)).toBeNull();
  });

  it('the kiosk\'s own picture wins; off — the kiosk\'s own only, the initial on the theme colour', () => {
    const own = { url: 'file:///cache/kiosk-drinks.png', kind: 'image' as const, sha256: null, bytes: null };
    const cfg = resolveKioskConfig({ catalog: { ...KIOSK_DEFAULTS.catalog, categoryImages: { drinks: own }, categoryImagesFromCatalog: false } });
    expect(categoryRailImage('drinks', cfg.catalog, images)).toBe(own.url);
    expect(categoryRailImage('sides', cfg.catalog, images)).toBeNull();
    expect(categoryRailColor('drinks', cfg.catalog, colors)).toBeNull();
  });
});
