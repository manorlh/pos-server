/**
 * "תפריטים" on the Windows till — the pure rules (src/core/till/menus.ts), pinned to the answers the cloud and the Android
 * till give (the shared golden: test/fixtures/catalog_menus_golden.json = pos-server tests/fixtures/catalog_menus_golden.json),
 * plus the till's own cases: the Date → local wall clock, a night crossing midnight, device groups at one priority, the
 * fallbacks, listed prices as the cloud writes them, and what the active menu does to the till's catalog.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolve as resolveBlock, weekdayOfDay, type MenuBlock, type MenuSurface } from '@dash-lib/menuSchedule';
import { ofShekels } from '../src/core/money';
import {
  appliedFor,
  applyMenu,
  lineMenuFacts,
  listedPriceAgorot,
  localMomentOf,
  menuKey,
  presentTillCatalog,
  resolveTillMenu,
  sellableAt,
  type MenuApplied,
  type MenuCatalogProduct,
  type MenuInput,
} from '../src/core/till/menus';

const here = __dirname;
const GOLDEN = path.join(here, 'fixtures', 'catalog_menus_golden.json');

interface GoldenCase {
  name: string;
  at: string;
  surface: MenuSurface;
  block: string;
  expected: {
    resolution: { mode: string; menuId: string | null; menuName: string | null; level: string | null; depth: number | null; priority: number | null };
    applied: { categories: string[]; products: Array<{ id: string; categoryId: string; price: string; priceSource: string }> } | null;
  };
}
interface Golden {
  products: Array<{ id: string; categoryId: string; price: number }>;
  blocks: Record<string, MenuBlock>;
  cases: GoldenCase[];
}
const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Golden;

/** "2026-10-06T08:00" as the till's local clock (a Date in this machine's zone). */
function local(at: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(at)!;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
}

const inputs: MenuInput[] = golden.products.map((p) => ({ id: p.id, categoryId: p.categoryId, priceAgorot: ofShekels(p.price) }));

/** The applied menu as the golden writes it. */
function wire(a: MenuApplied | null) {
  return a === null ? null : { categories: a.categories, products: a.products.map((p) => ({ id: p.id, categoryId: p.categoryId, price: (p.priceAgorot / 100).toFixed(2), priceSource: p.source })) };
}

describe('the golden fixtures (the cloud, the Android till and this till agree)', () => {
  it('has the cases, and the same bytes as the server’s', () => {
    expect(golden.cases.length).toBeGreaterThanOrEqual(30);
    const server = path.join(here, '..', '..', 'server', 'tests', 'fixtures', 'catalog_menus_golden.json');
    if (existsSync(server)) expect(readFileSync(server, 'utf8').replace(/\r\n/g, '\n')).toBe(readFileSync(GOLDEN, 'utf8').replace(/\r\n/g, '\n'));
  });

  for (const c of golden.cases) {
    // The till's own surface is 'pos' (sellableAt); the kiosk cases run the same rules on their surface.
    it(`${c.block} ${c.at} ${c.surface}: ${c.name}`, () => {
      const block = golden.blocks[c.block];
      const at = local(c.at);
      if (c.surface === 'pos') {
        const got = sellableAt(block, at, inputs);
        expect({ mode: got.resolution.mode, menuId: got.resolution.menuId, menuName: got.resolution.menuName, level: got.resolution.level, depth: got.resolution.depth, priority: got.resolution.priority }).toEqual(c.expected.resolution);
        expect(wire(got.applied)).toEqual(c.expected.applied);
      } else {
        const resolution = resolveBlock(block, localMomentOf(at), 'kiosk');
        expect({ mode: resolution.mode, menuId: resolution.menuId, menuName: resolution.menuName, level: resolution.level, depth: resolution.depth, priority: resolution.priority }).toEqual(c.expected.resolution);
        expect(wire(appliedFor(block, resolution, inputs))).toEqual(c.expected.applied);
      }
    });
  }
});

describe('the till’s clock', () => {
  it('reads a Date as the local wall clock: its weekday (0 = Sunday), its minute, never the zone’s offset', () => {
    const sunday = localMomentOf(new Date(2026, 9, 11, 0, 5));
    expect(weekdayOfDay(sunday.day)).toBe(0);
    expect(sunday.minute).toBe(5);
    const saturday = localMomentOf(new Date(2026, 9, 10, 23, 59, 59, 999));
    expect(weekdayOfDay(saturday.day)).toBe(6);
    expect(saturday.minute).toBe(23 * 60 + 59);
    expect(saturday.day + 1).toBe(sunday.day);
  });

  it('a night that crosses midnight belongs to the day it started: Thursday 22:00–02:00 is still on at Friday 01:59', () => {
    const block = golden.blocks.base;
    expect(resolveTillMenu(block, new Date(2026, 9, 8, 21, 59)).mode).toBe('catalog');
    expect(resolveTillMenu(block, new Date(2026, 9, 8, 22, 0)).menuId).toBe('m-night');
    expect(resolveTillMenu(block, new Date(2026, 9, 8, 23, 59)).menuId).toBe('m-night');
    expect(resolveTillMenu(block, new Date(2026, 9, 9, 0, 0)).menuId).toBe('m-night');
    expect(resolveTillMenu(block, new Date(2026, 9, 9, 1, 59)).menuId).toBe('m-night');
    // End exclusive; and Friday's own 22:00 night runs into Saturday, which has none after that.
    expect(resolveTillMenu(block, new Date(2026, 9, 9, 2, 0)).mode).toBe('catalog');
    expect(resolveTillMenu(block, new Date(2026, 9, 10, 1, 59)).menuId).toBe('m-night');
    expect(resolveTillMenu(block, new Date(2026, 9, 11, 0, 30)).mode).toBe('catalog');
  });

  it('start inclusive, end exclusive: breakfast 07:00–11:30 hands over to lunch at 11:30 sharp', () => {
    const block = golden.blocks.base;
    expect(resolveTillMenu(block, new Date(2026, 9, 6, 11, 29)).menuId).toBe('m-breakfast');
    expect(resolveTillMenu(block, new Date(2026, 9, 6, 11, 30)).menuId).toBe('m-lunch');
    expect(menuKey(resolveTillMenu(block, new Date(2026, 9, 6, 11, 29)))).toBe('menu|m-breakfast');
    expect(menuKey(resolveTillMenu(null, new Date(2026, 9, 6, 11, 29)))).toBe('catalog|');
  });

  it('the till is never given the kiosk-only menu, and no block at all reads as the catalog', () => {
    // m-kiosk is "always" on the kiosk channel: at 12:00 on a Saturday the till has no menu while the kiosk has.
    const saturday = new Date(2026, 9, 10, 12, 0);
    expect(resolveTillMenu(golden.blocks.base, saturday).mode).toBe('catalog');
    expect(resolveBlock(golden.blocks.base, localMomentOf(saturday), 'kiosk').menuId).toBe('m-kiosk');
    for (const nothing of [null, undefined, {}, [], 'x', 7]) expect(resolveTillMenu(nothing, saturday).mode).toBe('catalog');
  });
});

describe('which menu: device groups, levels, fallbacks', () => {
  const menu = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
    id,
    name,
    channel: 'both',
    schedule: { always: true, days: null, ranges: [], from: null, to: null },
    categories: [{ id: 'c-drinks', all: true }],
    products: [],
    ...extra,
  });
  const at = new Date(2026, 9, 6, 12, 0);

  it('two device groups at one priority: the assignment updated last wins, whatever the names', () => {
    const block = {
      fallback: 'catalog',
      menus: [menu('m-1', 'א'), menu('m-2', 'ת')],
      assignments: [
        { menuId: 'm-1', level: 'group', depth: 0, priority: 0, updatedAt: '2026-10-01T10:00:00+00:00' },
        { menuId: 'm-2', level: 'group', depth: 0, priority: 0, updatedAt: '2026-10-05T10:00:00+00:00' },
      ],
    };
    expect(resolveTillMenu(block, at).menuId).toBe('m-2');
    // Swap the stamps: the other.
    const swapped = { ...block, assignments: [{ ...block.assignments[0], updatedAt: '2026-10-09T10:00:00+00:00' }, block.assignments[1]] };
    expect(resolveTillMenu(swapped, at).menuId).toBe('m-1');
  });

  it('device groups at one priority and one stamp (or none): by name, then by id', () => {
    const block = {
      fallback: 'catalog',
      menus: [menu('m-b', 'ב'), menu('m-a', 'א'), menu('m-a2', 'א')],
      assignments: [
        { menuId: 'm-b', level: 'group', depth: 0, priority: 0 },
        { menuId: 'm-a2', level: 'group', depth: 0, priority: 0 },
        { menuId: 'm-a', level: 'group', depth: 0, priority: 0 },
      ],
    };
    expect(resolveTillMenu(block, at).menuId).toBe('m-a');
  });

  it('the till’s own menu beats its group, a group beats the point of sale, whatever the priorities', () => {
    const block = {
      fallback: 'catalog',
      menus: [menu('m-own', 'ב'), menu('m-group', 'ב'), menu('m-area', 'ב'), menu('m-shop', 'ב')],
      assignments: [
        { menuId: 'm-shop', level: 'shop', depth: 0, priority: 99 },
        { menuId: 'm-area', level: 'area', depth: 0, priority: 50 },
        { menuId: 'm-group', level: 'group', depth: 0, priority: -5 },
        { menuId: 'm-own', level: 'machine', depth: 0, priority: -9 },
      ],
    };
    expect(resolveTillMenu(block, at).menuId).toBe('m-own');
    expect(resolveTillMenu({ ...block, assignments: block.assignments.slice(0, 3) }, at).menuId).toBe('m-group');
    expect(resolveTillMenu({ ...block, assignments: block.assignments.slice(0, 2) }, at).menuId).toBe('m-area');
  });

  it('no menu active: the fallback — the catalog as it is, or nothing to sell', () => {
    const idle = menu('m-night', 'לילה', { schedule: { always: false, days: [4], ranges: [['22:00', '02:00']], from: null, to: null } });
    const assignments = [{ menuId: 'm-night', level: 'company', depth: 0, priority: 0 }];
    expect(resolveTillMenu({ fallback: 'catalog', menus: [idle], assignments }, at)).toMatchObject({ mode: 'catalog', menuId: null });
    expect(resolveTillMenu({ fallback: 'none', menus: [idle], assignments }, at)).toMatchObject({ mode: 'none', menuId: null });
    // An unknown fallback word is the catalog, as the Android codec reads it.
    expect(resolveTillMenu({ fallback: 'maybe', menus: [idle], assignments }, at).mode).toBe('catalog');
    // And nothing to sell sells nothing: no products, no categories.
    expect(appliedFor({ fallback: 'none' }, { mode: 'none', menuId: null }, inputs)).toEqual({ categories: [], products: [] });
    expect(appliedFor({}, { mode: 'catalog', menuId: null }, inputs)).toBeNull();
  });

  it('a menu of the kiosk channel is not the till’s; "both" and an empty channel are', () => {
    const block = {
      fallback: 'none',
      menus: [menu('m-k', 'קיוסק', { channel: 'kiosk' }), menu('m-e', 'ריק', { channel: '' }), menu('m-b', 'שניהם', { channel: 'both' }), menu('m-p', 'קופה', { channel: 'pos' })],
    };
    const only = (id: string) => ({ ...block, assignments: [{ menuId: id, level: 'company', depth: 0, priority: 0 }] });
    expect(resolveTillMenu(only('m-k'), at).mode).toBe('none');
    expect(resolveTillMenu(only('m-e'), at).menuId).toBe('m-e');
    expect(resolveTillMenu(only('m-b'), at).menuId).toBe('m-b');
    expect(resolveTillMenu(only('m-p'), at).menuId).toBe('m-p');
  });
});

describe('what a menu does to the products (CatalogMenus.apply)', () => {
  const cat = (id: string, categoryId: string | null, shekels: number): MenuInput => ({ id, categoryId, priceAgorot: ofShekels(shekels) });
  const catalog = [cat('a1', 'A', 10), cat('a2', 'A', 20), cat('a3', 'A', 30), cat('b1', 'B', 5), cat('b2', 'B', 6), cat('c1', 'C', 7)];

  it('categories in the menu’s order, the listed first in the menu’s order, then — for "all" — the rest in the till’s order', () => {
    const got = applyMenu(
      { categories: [{ id: 'B', all: true }, { id: 'A', all: true }], products: [{ id: 'a3' }, { id: 'a1', price: 9.5 }] },
      catalog,
    );
    expect(got.categories).toEqual(['B', 'A']);
    expect(got.products.map((p) => [p.id, p.categoryId, p.priceAgorot, p.source])).toEqual([
      ['b1', 'B', 500, 'catalog'],
      ['b2', 'B', 600, 'catalog'],
      ['a3', 'A', 3000, 'catalog'],
      ['a1', 'A', 950, 'menu'],
      ['a2', 'A', 2000, 'catalog'],
    ]);
  });

  it('a category "all: false" shows only what is listed; a listed product from an unnamed category brings its category, after; an empty one goes', () => {
    const got = applyMenu(
      { categories: [{ id: 'A', all: false }, { id: 'Z', all: true }], products: [{ id: 'a2' }, { id: 'c1', price: '6.50' }, { id: 'nope', price: 1 }] },
      catalog,
    );
    expect(got.categories).toEqual(['A', 'C']);
    expect(got.products.map((p) => [p.id, p.priceAgorot, p.source])).toEqual([
      ['a2', 2000, 'catalog'],
      ['c1', 650, 'menu'],
    ]);
  });

  it('the listed price replaces the catalog’s — HALF_UP to the agora, 0 is a price, junk is none (then the catalog’s)', () => {
    expect(listedPriceAgorot(12.345)).toBe(1235);
    expect(listedPriceAgorot(0)).toBe(0);
    expect(listedPriceAgorot('48.00')).toBe(4800);
    expect(listedPriceAgorot(' 9.5 ')).toBe(950);
    expect(listedPriceAgorot('1e1')).toBe(1000);
    for (const bad of [null, undefined, true, false, '', '  ', 'abc', '0x10', '12,5', [], {}, Number.NaN, Infinity]) expect(listedPriceAgorot(bad)).toBeNull();
    const got = applyMenu(
      { categories: [{ id: 'A', all: false }], products: [{ id: 'a1', price: 0 }, { id: 'a2', price: 'abc' }, { id: 'a3', price: true }] },
      catalog,
    );
    expect(got.products.map((p) => [p.id, p.priceAgorot, p.source])).toEqual([
      ['a1', 0, 'menu'],
      ['a2', 2000, 'catalog'],
      ['a3', 3000, 'catalog'],
    ]);
  });

  it('a duplicate category or product keeps its first place and price; unreadable ids and categories are skipped', () => {
    const got = applyMenu(
      {
        categories: [{ id: 'A', all: false }, { id: 'A', all: true }, { id: '' }, { all: true }, null, 'x', { id: 'B', all: 'false' }, { id: 'C', all: 'nonsense' }],
        products: [{ id: 'a2', price: 1 }, { id: 'a2', price: 99 }, { id: '' }, { id: 'a1' }, { id: 'b1', price: 2 }],
      },
      catalog,
    );
    expect(got.categories).toEqual(['A', 'B', 'C']);
    expect(got.products.map((p) => [p.id, p.priceAgorot, p.source])).toEqual([
      ['a2', 100, 'menu'],
      ['a1', 1000, 'catalog'],
      ['b1', 200, 'menu'],
      ['c1', 700, 'catalog'],
    ]);
  });

  it('a menu that is not there places nothing; a product with no category is never placed', () => {
    expect(applyMenu(null, catalog)).toEqual({ categories: [], products: [] });
    expect(applyMenu(undefined, catalog)).toEqual({ categories: [], products: [] });
    const got = applyMenu({ categories: [{ id: 'A', all: true }], products: [{ id: 'orphan' }] }, [...catalog, cat('orphan', null, 1)]);
    expect(got.products.map((p) => p.id)).toEqual(['a1', 'a2', 'a3']);
  });
});

describe('the till’s catalog under the active menu', () => {
  interface P extends MenuCatalogProduct {
    name: string;
    sale: { state: string };
    restricted: boolean;
  }
  const product = (id: string, categoryId: string, priceAgorot: number, over: Partial<P> = {}): P => ({ id, name: id, categoryId, priceAgorot, price: priceAgorot / 100, sale: { state: 'available' }, restricted: false, ...over });
  const categories = [{ id: 'A', name: 'א' }, { id: 'B', name: 'ב' }, { id: 'D', name: 'ד' }];
  const products = [product('a1', 'A', 1000), product('a2', 'A', 2000, { sale: { state: 'sold_out' } }), product('b1', 'B', 500, { restricted: true }), product('d1', 'D', 700)];
  const block = {
    fallback: 'catalog',
    menus: [{ id: 'm-1', name: 'צהריים', channel: 'pos', schedule: { always: true }, categories: [{ id: 'B', all: true }, { id: 'A', all: true }], products: [{ id: 'a2', price: 15 }] }],
    assignments: [{ menuId: 'm-1', level: 'company', depth: 0, priority: 0 }],
  };

  it('a menu: only what it places, in its order, at its prices, carrying the menu — availability untouched', () => {
    const r = resolveTillMenu(block, new Date(2026, 9, 6, 12, 0));
    const got = presentTillCatalog({ categories, products }, block, r);
    expect(got.categories.map((c) => c.id)).toEqual(['B', 'A']);
    expect(got.products.map((p) => [p.id, p.priceAgorot, p.price, p.priceSource, p.menuId, p.menuName])).toEqual([
      ['b1', 500, 5, 'catalog', 'm-1', 'צהריים'],
      ['a2', 1500, 15, 'menu', 'm-1', 'צהריים'],
      ['a1', 1000, 10, 'catalog', 'm-1', 'צהריים'],
    ]);
    // The sold-out stays sold out, the restricted restricted; the unlisted category D is not on this till.
    expect(got.products.find((p) => p.id === 'a2')!.sale.state).toBe('sold_out');
    expect(got.products.find((p) => p.id === 'b1')!.restricted).toBe(true);
    // The input is never mutated.
    expect(products[1].priceAgorot).toBe(2000);
    expect(products[1].menuId).toBeUndefined();
  });

  it('the catalog mode gives the same object back; nothing to sell gives nothing', () => {
    const catalogMode = presentTillCatalog({ categories, products }, null, { mode: 'catalog', menuId: null, menuName: null });
    expect(catalogMode.products).toBe(products);
    expect(catalogMode.categories).toBe(categories);
    expect(presentTillCatalog({ categories, products }, { fallback: 'none' }, { mode: 'none', menuId: null, menuName: null })).toEqual({ categories: [], products: [] });
  });

  it('what a sold line records: nothing without a menu, else its id, name and price source', () => {
    expect(lineMenuFacts({})).toBeNull();
    expect(lineMenuFacts({ menuId: null, priceSource: 'menu' })).toBeNull();
    expect(lineMenuFacts({ menuId: 'm-1', menuName: 'צהריים', priceSource: 'menu' })).toEqual({ menuId: 'm-1', menuName: 'צהריים', priceSource: 'menu' });
    expect(lineMenuFacts({ menuId: 'm-1' })).toEqual({ menuId: 'm-1', menuName: null, priceSource: 'catalog' });
  });
});
