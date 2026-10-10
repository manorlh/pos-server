/**
 * "מחייב אישור מנהל במכירה" on the Windows kiosk, as on the Android one: a product flagged itself,
 * or under a flagged category (at any depth), is not on the kiosk — nobody there can type a
 * manager's code — and a flagged category disappears with everything beneath it. Through the
 * kiosk's own path: the till's pull (each row's own flag) → its catalog (buildKioskCatalog) and the
 * pictures it keeps (catalogMedia).
 */
import { describe, expect, it } from 'vitest';
import { buildKioskCatalog, catalogMedia, sellableOnKiosk } from '../src/main/kiosk/catalog';

const pull = {
  categories: [
    { id: 'drinks', name: 'שתייה', isActive: true, imageUrl: 'https://x/drinks.png' },
    { id: 'alcohol', name: 'אלכוהול', parentId: 'drinks', isActive: true, requiresManagerApproval: true, imageUrl: 'https://x/alcohol.png' },
    { id: 'wine', name: 'יין', parentId: 'alcohol', isActive: true, imageUrl: 'https://x/wine.png' },
  ],
  products: [
    { id: 'cola', name: 'קולה', price: 8, categoryId: 'drinks', imageUrl: 'https://x/cola.png' },
    { id: 'cigars', name: 'סיגרים', price: 90, categoryId: 'drinks', requiresManagerApproval: true, imageUrl: 'https://x/cigars.png' },
    { id: 'beer', name: 'בירה', price: 25, categoryId: 'alcohol', imageUrl: 'https://x/beer.png' },
    { id: 'merlot', name: 'מרלו', price: 120, categoryId: 'wine', imageUrl: 'https://x/merlot.png' },
  ],
  menu: null,
  machineCatalog: null,
};

describe('"מחייב אישור מנהל במכירה" on the Windows kiosk', () => {
  it('a product flagged itself is not sold on a kiosk', () => {
    expect(sellableOnKiosk(pull.products[1], 'all')).toBe(false);
    expect(sellableOnKiosk(pull.products[0], 'all')).toBe(true);
  });

  it('a flagged category goes with everything beneath it', () => {
    const catalog = buildKioskCatalog(pull, {}, () => null);
    expect(catalog.products.map((p) => p.id)).toEqual(['cola']);
    expect(catalog.categories.map((c) => c.id)).toEqual(['drinks']);
  });

  it('keeps no picture of what it does not show', () => {
    const urls = catalogMedia(pull, { categories: [], products: [] }).map((m) => m.url);
    expect(urls.sort()).toEqual(['https://x/cola.png', 'https://x/drinks.png']);
  });
});
