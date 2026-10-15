/**
 * "תפריטים" at the Windows till — sales menus by schedule, through a REAL KioskService behind the till engine (the Android
 * till's CatalogMenus / CatalogMenuRepository): the catalog pull's `catalogMenus` block is kept; the menu active on the
 * till's own clock decides what the till sells, in what order, at what price; a sold line records the menu and where its price
 * came from, and the document carries them to the cloud. Tests only: no real server, terminal or printer.
 *
 * The clock is the machine's wall clock (the engine and the service both read Date), set here with fake Dates.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { saleTotals, type SaleLine } from '../src/core/sale';
import { documentWire } from '../src/main/fiscal/ledger';
import { readyTill, type Harness, type HarnessOptions } from './tillEngineHarness';

const open: Harness[] = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
});
afterEach(() => {
  for (const h of open.splice(0)) h.stop();
  vi.useRealTimers();
});

/** Tuesday 2026-10-06 (weekday 2) at hh:mm, the till's local wall clock. */
const TUE = (hh: number, mm = 0) => new Date(2026, 9, 6, hh, mm);
const at = (d: Date) => vi.setSystemTime(d);

const PRODUCTS: Array<Record<string, unknown>> = [
  { id: 'p-eggs', name: 'ביצים', price: 42, categoryId: 'c-hot', inStock: true, isAvailable: true, trackStock: false, salesChannel: 'all' },
  { id: 'p-shak', name: 'שקשוקה', price: 48, categoryId: 'c-hot', inStock: true, isAvailable: true, trackStock: false, salesChannel: 'all' },
  { id: 'p-burger', name: 'המבורגר', price: 52, categoryId: 'c-mains', inStock: true, isAvailable: true, trackStock: false, salesChannel: 'all' },
  { id: 'p-schnitzel', name: 'שניצל', price: 58, categoryId: 'c-mains', inStock: true, isAvailable: true, trackStock: false, salesChannel: 'all' },
  { id: 'p-coffee', name: 'קפה', price: 12, categoryId: 'c-drinks', inStock: true, isAvailable: true, trackStock: false, salesChannel: 'all' },
  { id: 'p-cola', name: 'קולה', price: 12, categoryId: 'c-drinks', inStock: true, isAvailable: true, trackStock: false, salesChannel: 'all' },
  // Locked ("נעילת מוצר"): a menu does not unlock it.
  { id: 'p-water', name: 'מים', price: 8, categoryId: 'c-drinks', inStock: true, isAvailable: false, trackStock: false, salesChannel: 'all' },
  { id: 'p-beer', name: 'בירה', price: 28, categoryId: 'c-drinks', inStock: true, isAvailable: true, trackStock: false, salesChannel: 'all' },
];
const CATEGORIES = [
  { id: 'c-hot', name: 'חמים', isActive: true },
  { id: 'c-mains', name: 'עיקריות', isActive: true },
  { id: 'c-drinks', name: 'שתייה', isActive: true },
];
const ORDER = {
  categoryOrder: ['c-hot', 'c-mains', 'c-drinks'],
  productOrder: ['p-eggs', 'p-shak', 'p-burger', 'p-schnitzel', 'p-coffee', 'p-cola', 'p-water', 'p-beer'],
};

const sched = (days: number[] | null, start: string, end: string) => ({ always: false, days, ranges: [[start, end]], from: null, to: null });
/** The block as the cloud sends it to this till (docs/SPEC_MENUS.md): the assignments along its chain, each with level and depth. */
const BLOCK = {
  updatedAt: '2026-10-06T08:00:00+00:00',
  fallback: 'catalog',
  menus: [
    { id: 'm-breakfast', name: 'בוקר', channel: 'both', schedule: sched(null, '07:00', '11:30'), categories: [{ id: 'c-hot', all: true }, { id: 'c-drinks', all: true }], products: [{ id: 'p-coffee', price: 9 }] },
    {
      id: 'm-lunch',
      name: 'צהריים',
      channel: 'pos',
      schedule: sched([0, 1, 2, 3, 4], '11:30', '17:00'),
      categories: [{ id: 'c-mains', all: false }, { id: 'c-drinks', all: true }],
      products: [{ id: 'p-burger', price: 48 }, { id: 'p-schnitzel' }, { id: 'p-cola' }],
    },
    { id: 'm-night', name: 'לילה', channel: 'pos', schedule: sched([4, 5], '22:00', '02:00'), categories: [{ id: 'c-drinks', all: false }], products: [{ id: 'p-beer', price: 20 }] },
    // The kiosk's own: never the till's.
    { id: 'm-kiosk', name: 'קיוסק', channel: 'kiosk', schedule: { always: true, days: null, ranges: [], from: null, to: null }, categories: [{ id: 'c-hot', all: true }], products: [] },
  ],
  assignments: [
    { menuId: 'm-breakfast', level: 'company', depth: 0, priority: 0 },
    { menuId: 'm-lunch', level: 'company', depth: 0, priority: 0 },
    { menuId: 'm-night', level: 'shop', depth: 0, priority: 0 },
    { menuId: 'm-kiosk', level: 'company', depth: 1, priority: 0 },
  ],
};

interface Snap {
  version: number;
  departments: Array<{ id: string }>;
  products: Array<{ id: string; departmentId: string; priceAgorot: number; sale?: string }>;
}

/** A till with a shift open at `now`, the catalog and the menus block as the cloud sent them. */
async function till(now: Date, block: Record<string, unknown> | null = BLOCK, over: HarnessOptions = {}): Promise<Harness> {
  at(now);
  const h = await readyTill({ catalog: { products: PRODUCTS, categories: CATEGORIES, menu: null }, settings: ORDER, ...over });
  open.push(h);
  if (block) h.svc.cloud.applyCatalog({ syncType: 'delta', catalogMenus: block, serverTime: 'y' });
  return h;
}
const snapshot = (h: Harness) => h.ok<Snap>('catalog.snapshot');
const shown = (s: Snap) => s.products.map((p) => [p.id, p.priceAgorot]);

describe('the till sells the active menu', () => {
  it('breakfast on a Tuesday morning: its categories in its order, its coffee at the menu price, the rest at the catalog’s', async () => {
    const h = await till(TUE(8));
    const s = await snapshot(h);
    expect(s.departments.map((d) => d.id)).toEqual(['c-hot', 'c-drinks']);
    expect(shown(s)).toEqual([
      ['p-eggs', 4200],
      ['p-shak', 4800],
      ['p-coffee', 900],
      ['p-cola', 1200],
      ['p-water', 800],
      ['p-beer', 2800],
    ]);
  });

  it('lunch at 12:00: only the listed mains, then the drinks — the listed first, the rest in the till’s order; the burger at 48', async () => {
    const h = await till(TUE(12));
    const s = await snapshot(h);
    expect(s.departments.map((d) => d.id)).toEqual(['c-mains', 'c-drinks']);
    expect(shown(s)).toEqual([
      ['p-burger', 4800],
      ['p-schnitzel', 5800],
      ['p-cola', 1200],
      ['p-coffee', 1200],
      ['p-water', 800],
      ['p-beer', 2800],
    ]);
    // Availability is not touched: the locked product is still locked, on the menu too.
    expect(s.products.find((p) => p.id === 'p-water')!.sale).toBe('unavailable');
    expect((await h.fail('sell.add', { productId: 'p-water' })).code).toBe('sell_refused');
    // What the menu does not place is not on this till: no tile, no sale.
    expect((await h.fail('sell.add', { productId: 'p-eggs' })).code).toBe('invalid_args');
  });

  it('the cart and the document are priced from the menu: 2 burgers at 48 and a cola, to the agora, and the document says so', async () => {
    const h = await till(TUE(12));
    await h.ok('sell.add', { productId: 'p-burger', qty: 2 });
    await h.ok('sell.add', { productId: 'p-cola' });
    const s = h.state().sell;
    expect(s.lines.map((l) => [l.productId, l.qty, l.unitAgorot, l.totalAgorot])).toEqual([
      ['p-burger', 2, 4800, 9600],
      ['p-cola', 1, 1200, 1200],
    ]);
    // The Android rule: gross is the sum of the lines at the menu's prices; the VAT is worked out once, on the document.
    expect(s.totalAgorot).toBe(10_800);
    const lines: SaleLine[] = [
      { key: 'a', productId: 'p-burger', name: '', sku: null, basePriceAgorot: 4800, options: [], notes: [], qty: 2 },
      { key: 'b', productId: 'p-cola', name: '', sku: null, basePriceAgorot: 1200, options: [], notes: [], qty: 1 },
    ];
    const t = saleTotals(lines, 0.18);
    expect(s.vatAgorot).toBe(t.vatAgorot);
    expect(t.netAgorot).toBe(9153);

    await h.ok('checkout.start');
    expect(h.state().checkout).toMatchObject({ phase: 'tender', totalAgorot: 10_800 });
    await h.ok('checkout.cash', { amountAgorot: 10_800 });
    const [d] = h.svc.ledger.docsOfShift(h.svc.ledger.currentShift()!.id);
    // The lines record the menu active when they were priced and where each price came from.
    expect(d.lines.map((l) => [l.productId, l.menuId, l.menuName, l.priceSource])).toEqual([
      ['p-burger', 'm-lunch', 'צהריים', 'menu'],
      ['p-cola', 'm-lunch', 'צהריים', 'catalog'],
    ]);
    const w = documentWire(d) as { totalAmount: number; netAmount: number; vatAmount: number; items: Array<Record<string, unknown>> };
    expect(w).toMatchObject({ totalAmount: 108, netAmount: 91.53, vatAmount: 16.47 });
    expect(w.items).toHaveLength(2);
    expect(w.items[0]).toMatchObject({ productName: 'המבורגר', quantity: 2, unitPrice: 48, totalPrice: 96, menuId: 'm-lunch', menuName: 'צהריים', priceSource: 'menu' });
    expect(w.items[1]).toMatchObject({ productName: 'קולה', quantity: 1, unitPrice: 12, totalPrice: 12, menuId: 'm-lunch', menuName: 'צהריים', priceSource: 'catalog' });
  });

  it('after the end of the menu the till falls back to the catalog, and a line then records no menu at all', async () => {
    const h = await till(TUE(16, 59));
    expect(shown(await snapshot(h)).slice(0, 2)).toEqual([
      ['p-burger', 4800],
      ['p-schnitzel', 5800],
    ]);
    at(TUE(17));
    const after = await snapshot(h);
    expect(after.departments.map((d) => d.id)).toEqual(['c-hot', 'c-mains', 'c-drinks']);
    expect(shown(after)).toEqual([
      ['p-eggs', 4200],
      ['p-shak', 4800],
      ['p-burger', 5200],
      ['p-schnitzel', 5800],
      ['p-coffee', 1200],
      ['p-cola', 1200],
      ['p-water', 800],
      ['p-beer', 2800],
    ]);
    await h.ok('sell.add', { productId: 'p-burger' });
    await h.ok('checkout.start');
    await h.ok('checkout.cash', { amountAgorot: 5200 });
    const [d] = h.svc.ledger.docsOfShift(h.svc.ledger.currentShift()!.id);
    expect('menuId' in d.lines[0] || 'priceSource' in d.lines[0] || 'menuName' in d.lines[0]).toBe(false);
    const item = (documentWire(d) as { items: Array<Record<string, unknown>> }).items[0];
    expect(item).toMatchObject({ unitPrice: 52 });
    expect('menuId' in item || 'menuName' in item || 'priceSource' in item).toBe(false);
  });

  it('nothing is cached across a schedule boundary: the catalog is laid out again exactly when the menu switches, by the clock', async () => {
    const h = await till(TUE(11, 29));
    const breakfast = await snapshot(h);
    expect(shown(breakfast)[2]).toEqual(['p-coffee', 900]);
    // The same minute, the same hour: the same catalog (the screens do not refetch it).
    at(TUE(11, 29));
    expect((await snapshot(h)).version).toBe(breakfast.version);
    // 11:30 sharp: breakfast ends (end exclusive), lunch starts.
    at(TUE(11, 30));
    const lunch = await snapshot(h);
    expect(lunch.version).not.toBe(breakfast.version);
    expect(lunch.departments.map((d) => d.id)).toEqual(['c-mains', 'c-drinks']);
    at(TUE(16, 59));
    expect((await snapshot(h)).version).toBe(lunch.version);
    at(TUE(17));
    const none = await snapshot(h);
    expect(none.version).not.toBe(lunch.version);
    expect(none.departments).toHaveLength(3);
    // The version is a pure function of the moment: back to lunch time, lunch again (a clock set back by hand).
    at(TUE(13));
    expect((await snapshot(h)).departments.map((d) => d.id)).toEqual(['c-mains', 'c-drinks']);
  });

  it('a night that crosses midnight: Thursday 22:00 until Friday 02:00, the beer at 20', async () => {
    const h = await till(new Date(2026, 9, 8, 21, 59));
    expect((await snapshot(h)).departments).toHaveLength(3);
    at(new Date(2026, 9, 8, 22, 0));
    expect(shown(await snapshot(h))).toEqual([['p-beer', 2000]]);
    at(new Date(2026, 9, 9, 1, 59));
    expect(shown(await snapshot(h))).toEqual([['p-beer', 2000]]);
    at(new Date(2026, 9, 9, 2, 0));
    expect((await snapshot(h)).departments).toHaveLength(3);
  });

  it('fallback "לא למכור": between menus the till sells nothing (the engine shows "אין מוצרים")', async () => {
    const h = await till(TUE(19, 30), { ...BLOCK, fallback: 'none' });
    const s = await snapshot(h);
    expect(s.departments).toEqual([]);
    expect(s.products).toEqual([]);
    expect((await h.fail('sell.add', { productId: 'p-burger' })).code).toBe('invalid_args');
    expect(h.svc.tillCatalogData().products).toEqual([]);
    // A menu active: the menu.
    at(TUE(9));
    expect((await snapshot(h)).departments.map((d) => d.id)).toEqual(['c-hot', 'c-drinks']);
  });

  it('the cloud\'s block replaced or removed is seen at once; a till with no menus sells the catalog as before', async () => {
    const h = await till(TUE(12), null);
    expect((await snapshot(h)).departments).toHaveLength(3);
    expect(h.svc.cloud.catalogMenus()).toBeNull();
    h.svc.cloud.applyCatalog({ syncType: 'delta', catalogMenus: BLOCK, serverTime: 'y' });
    expect((await snapshot(h)).departments.map((d) => d.id)).toEqual(['c-mains', 'c-drinks']);
    h.svc.cloud.applyCatalog({ syncType: 'delta', catalogMenus: { ...BLOCK, fallback: 'none', assignments: [] }, serverTime: 'z' });
    expect((await snapshot(h)).products).toEqual([]);
    // A full pull that says nothing about menus: they are gone.
    h.svc.cloud.applyCatalog({ syncType: 'full', products: PRODUCTS, categories: CATEGORIES, menu: null, machineCatalog: { mode: 'all' }, serverTime: 'w' });
    expect((await snapshot(h)).departments).toHaveLength(3);
  });
});

describe('the block is kept like the Android till keeps it', () => {
  it('whole when sent; a delta without it keeps the last; a full pull without it clears it; unpairing forgets it', async () => {
    const h = await till(TUE(12), null);
    const cloud = h.svc.cloud;
    expect(cloud.catalogMenus()).toBeNull();
    cloud.applyCatalog({ syncType: 'delta', catalogMenus: BLOCK, serverTime: 'a' });
    expect(cloud.catalogMenus()).toEqual(BLOCK);
    // A delta pull that carries products only: the block is kept.
    cloud.applyCatalog({ syncType: 'delta', products: [{ ...PRODUCTS[0], price: 43 }], serverTime: 'b' });
    expect(cloud.catalogMenus()).toEqual(BLOCK);
    // null, a list, a scalar: not a block (the last stays on a delta).
    for (const junk of [null, [], 'x', 7]) {
      cloud.applyCatalog({ syncType: 'delta', catalogMenus: junk, serverTime: 'c' });
      expect(cloud.catalogMenus()).toEqual(BLOCK);
    }
    // Replaced whole, not merged.
    const smaller = { ...BLOCK, menus: [BLOCK.menus[1]], assignments: [BLOCK.assignments[1]] };
    cloud.applyCatalog({ syncType: 'delta', catalogMenus: smaller, serverTime: 'd' });
    expect(cloud.catalogMenus()).toEqual(smaller);
    // The same after a restart: it is in the kv, not only in memory.
    expect(h.svc.kv.getJson('cloud.catalogMenus')).toEqual(smaller);
    cloud.applyCatalog({ syncType: 'full', products: PRODUCTS, categories: CATEGORIES, serverTime: 'e' });
    expect(cloud.catalogMenus()).toBeNull();
    expect(h.svc.kv.getJson('cloud.catalogMenus')).toBeNull();
    cloud.applyCatalog({ syncType: 'full', products: PRODUCTS, categories: CATEGORIES, catalogMenus: BLOCK, serverTime: 'f' });
    expect(cloud.catalogMenus()).toEqual(BLOCK);
    cloud.forget();
    expect(cloud.catalogMenus()).toBeNull();
  });

  it('a delta pull that carries only the menus is a catalog change (the screens are told); one with nothing is not', async () => {
    let body: Record<string, unknown> = { syncType: 'delta', catalogMenus: BLOCK, serverTime: 'z' };
    const h = await till(TUE(12), null, { answers: { 'GET sync/m/catalog': () => body } });
    const rev = () => (h.svc as unknown as { catalogRev: number }).catalogRev;
    const before = rev();
    await h.svc.sync.pullCatalog(false);
    expect(h.svc.cloud.catalogMenus()).toEqual(BLOCK);
    expect(rev()).toBeGreaterThan(before);
    expect((await snapshot(h)).departments.map((d) => d.id)).toEqual(['c-mains', 'c-drinks']);
    // A delta with nothing in it changes nothing.
    body = { syncType: 'delta', serverTime: 'z2' };
    const quiet = rev();
    await h.svc.sync.pullCatalog(false);
    expect(rev()).toBe(quiet);
    expect(h.svc.cloud.catalogMenus()).toEqual(BLOCK);
  });
});
