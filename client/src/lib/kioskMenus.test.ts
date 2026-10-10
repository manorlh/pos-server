/**
 * Run with `npm test`. "תפריטים" on the Windows and the browser kiosk (lib/kioskMenus.ts, kioskWebCatalog.ts —
 * the Android kiosk's CatalogMenus.kt / KioskCatalogView.kt, ported once), pinned to the shared golden
 * server/tests/fixtures/catalog_menus_golden.json the cloud, the Android till and the Android kiosk run too:
 *
 *  - the file is the pinned one (its SHA-256, line endings as LF — the same constant in the cloud's
 *    test_catalog_menus.py and in pos-android's CatalogMenusTest);
 *  - every case: the resolution AND the menu applied, prices to the agora;
 *  - every KIOSK case through the whole kiosk path — the catalog the browser kiosk builds from the pull
 *    (`buildWebCatalog`), the kiosk's own order rules over it (`kioskCatalogView` with `withMenuOrder`) —
 *    gives the golden's categories, products, order and prices (the Windows kiosk's builder runs the same
 *    cases in kiosk-desktop/test/kioskMenus.test.ts);
 *  - the kiosk's own rules inside a menu: "אזל" and blocks stay in force, the channel of the product, the
 *    machine's list gives way, the clock ticks at the minute, an open basket keeps its prices.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { kioskCatalogView, resolveKioskConfig } from './kioskConfig';
import {
  agorotText,
  applyMenu,
  basePriceOf,
  keptListPrice,
  layMenu,
  lineMenuFields,
  localMomentOfMs,
  menuInputsOf,
  menuKeyAt,
  menuPriceSets,
  msToNextMinute,
  pricesNow,
  sellableMenu,
  titleWithMenu,
  withMenuOrder,
} from './kioskMenus';
import { applyCatalogPull, buildWebCatalog, type CatalogIn } from './kioskWebCatalog';
import type { MenuBlock } from './menuSchedule';

/** The pinned golden: the cloud's test_catalog_menus.py and pos-android's CatalogMenusTest hold the same constant. */
const GOLDEN_SHA256 = '700bf232905063013a6adb1ad9f74383b9d3621bf8fad3fbe1342e10f8ed2395';

type Row = Record<string, unknown>;

interface Golden {
  products: Array<{ id: string; categoryId: string; price: number }>;
  blocks: Record<string, MenuBlock>;
  cases: Array<{
    name: string;
    at: string;
    surface: 'pos' | 'kiosk';
    block: string;
    expected: {
      resolution: { mode: string; menuId: string | null; menuName: string | null; level: string | null; depth: number | null; priority: number | null };
      applied: { categories: string[]; products: Array<{ id: string; categoryId: string; price: string; priceSource: string }> } | null;
    };
  }>;
}

function goldenText(): string {
  const candidates = [
    join(process.cwd(), '..', 'server', 'tests', 'fixtures', 'catalog_menus_golden.json'),
    join(__dirname, '..', '..', '..', 'server', 'tests', 'fixtures', 'catalog_menus_golden.json'),
    join(__dirname, '..', '..', 'server', 'tests', 'fixtures', 'catalog_menus_golden.json'),
  ];
  const found = candidates.find((p) => existsSync(p));
  assert.ok(found, 'catalog_menus_golden.json not found');
  return readFileSync(found, 'utf8').replace(/\r\n/g, '\n');
}

const golden = JSON.parse(goldenText()) as Golden;

/** The epoch ms whose LOCAL wall clock reads `at` ("YYYY-MM-DDTHH:MM") — the kiosk's own clock. */
function localMs(at: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(at);
  assert.ok(m, at);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])).getTime();
}

describe('the golden (catalog_menus_golden.json)', () => {
  it('is the pinned one — the same bytes in the cloud, the Android till and kiosk, and here', () => {
    assert.equal(createHash('sha256').update(goldenText(), 'utf8').digest('hex'), GOLDEN_SHA256);
  });

  it('has the kiosk cases', () => {
    assert.ok(golden.cases.length >= 41);
    assert.ok(golden.cases.filter((c) => c.surface === 'kiosk').length >= 13);
  });

  const products = golden.products.map((p) => ({ id: p.id, categoryId: p.categoryId, priceAgorot: Math.round(p.price * 100) }));
  for (const c of golden.cases) {
    it(`${c.block} ${c.at} ${c.surface}: ${c.name}`, () => {
      const block = golden.blocks[c.block];
      const got = sellableMenu(block, c.at, c.surface, products);
      const want = c.expected;
      assert.deepEqual(
        { mode: got.resolution.mode, menuId: got.resolution.menuId, menuName: got.resolution.menuName, level: got.resolution.level, depth: got.resolution.depth, priority: got.resolution.priority },
        want.resolution,
      );
      assert.deepEqual(
        got.applied && {
          categories: got.applied.categories,
          products: got.applied.products.map((p) => ({ id: p.id, categoryId: p.categoryId, price: agorotText(p.priceAgorot), priceSource: p.source })),
        },
        want.applied,
      );
    });
  }
});

/** The catalog pull of a kiosk selling the golden's products, in the till's own order, under `block`. */
function goldenCatalog(block: MenuBlock | null, extra: (rows: Row[]) => Row[] = (r) => r): { catalog: CatalogIn; settings: Record<string, unknown> } {
  const categoryIds = [...new Set(golden.products.map((p) => p.categoryId))];
  // c-empty is a category the edges block names: it exists, with nothing of the till's in it.
  for (const id of ['c-empty']) if (!categoryIds.includes(id)) categoryIds.push(id);
  const rows: Row[] = golden.products.map((p) => ({ id: p.id, name: p.id, categoryId: p.categoryId, price: p.price, inStock: true, isAvailable: true }));
  return {
    catalog: {
      products: extra(rows),
      categories: categoryIds.map((id, i) => ({ id, name: id, isActive: true, sortOrder: i })),
      menu: null,
      machineCatalog: null,
      catalogMenus: block,
    },
    // The till's own order: the golden's products as listed, its categories as they first appear.
    settings: { productOrder: golden.products.map((p) => p.id), categoryOrder: categoryIds },
  };
}

/** What the kiosk's screens show of a catalog build: categories and their products in order, priced. */
function shown(catalog: CatalogIn, settings: Record<string, unknown>, at: string, stock: Record<string, number> = {}) {
  const built = buildWebCatalog(catalog, settings, { stock, nowMs: localMs(at) });
  const cfg = withMenuOrder(resolveKioskConfig(null), built.menu);
  const view = kioskCatalogView(built.categories, built.products, cfg);
  return {
    built,
    categories: view.categories.map((c) => c.category.id),
    products: view.categories.flatMap((c) => c.products.map((x) => x.product)),
  };
}

describe('the browser kiosk, case by case (buildWebCatalog + kioskCatalogView + withMenuOrder)', () => {
  const tillOrder = golden.products.map((p) => p.id);
  for (const c of golden.cases.filter((x) => x.surface === 'kiosk')) {
    it(`${c.block} ${c.at}: ${c.name}`, () => {
      const { catalog, settings } = goldenCatalog(golden.blocks[c.block]);
      const s = shown(catalog, settings, c.at);
      const want = c.expected;
      assert.deepEqual(
        { mode: s.built.menu.mode, menuId: s.built.menu.menuId, menuName: s.built.menu.menuName, level: s.built.menu.level },
        { mode: want.resolution.mode, menuId: want.resolution.menuId, menuName: want.resolution.menuName, level: want.resolution.level },
      );
      if (want.applied === null) {
        // No menu: the catalog as it is — every product, the till's own order.
        assert.deepEqual(s.products.map((p) => p.id), tillOrder);
        assert.ok(s.products.every((p) => p.menuId === undefined && p.catalogPriceAgorot === undefined));
        assert.deepEqual(s.built.held, []);
        return;
      }
      assert.deepEqual(s.categories, want.applied.categories);
      assert.deepEqual(
        s.products.map((p) => ({ id: p.id, categoryId: p.categoryId, price: agorotText(p.priceAgorot), priceSource: p.priceSource })),
        want.applied.products,
      );
    });
  }
});

describe('what a menu does to the kiosk, and what it leaves alone', () => {
  const tue = (hhmm: string) => `2026-10-06T${hhmm}`;
  /**
   * The golden's company menus on the kiosk: breakfast, lunch (here on both channels), happy hour at the shop —
   * without the always-on kiosk menu, so that outside the menus' hours the kiosk has none.
   */
  const day: MenuBlock = (() => {
    const base = golden.blocks.base as { menus: Array<{ id: string; channel: string }>; assignments: Array<{ menuId: string }> };
    const keep = (id: string) => id !== 'm-kiosk' && id !== 'm-night';
    return {
      ...golden.blocks.base,
      menus: base.menus.filter((m) => keep(m.id)).map((m) => (m.id === 'm-lunch' ? { ...m, channel: 'both' } : m)),
      assignments: base.assignments.filter((a) => keep(a.menuId)),
    };
  })();

  it('the menu beats the machine list ("גובר על הכל"); without a menu the list is back', () => {
    const { catalog, settings } = goldenCatalog(day, (rows) => rows.map((r) => (r.id === 'p-coffee' ? { ...r, inMachineCatalog: false } : r)));
    catalog.machineCatalog = { mode: 'selected' };
    const at8 = shown(catalog, settings, tue('08:00')).products.map((p) => p.id);
    assert.ok(at8.includes('p-coffee'), 'breakfast lists coffee: a menu is over the machine list');
    // 19:00 — no menu: the kiosk's list applies as before (the coffee is not on it).
    const at19 = shown(catalog, settings, tue('19:00')).products.map((p) => p.id);
    assert.ok(!at19.includes('p-coffee'));
  });

  it('"אזל" and blocks stay in force inside a menu: still listed, greyed, and in the menu\'s order', () => {
    const lock = (rows: Row[]) =>
      rows.map((r) => {
        if (r.id === 'p-cola') return { ...r, isAvailable: false, lockAvailable: false };
        if (r.id === 'p-eggs') {
          return { ...r, blocks: [{ id: 'b1', scope: 'company', scopeId: 'c', kind: 'blocked', source: 'manual', until: null, channels: ['kiosk'], productId: 'p-eggs' }] };
        }
        return r;
      });
    const { catalog, settings } = goldenCatalog(day, lock);
    const s = shown(catalog, settings, tue('08:00'));
    const byId = new Map(s.products.map((p) => [p.id, p]));
    assert.equal(byId.get('p-cola')?.soldOut, true);
    assert.equal(byId.get('p-eggs')?.soldOut, true, 'a block in force by the kiosk clock');
    assert.equal(byId.get('p-coffee')?.soldOut, false);
    // The menu's price while it is sold out; the order is the menu's.
    assert.equal(byId.get('p-coffee')?.priceAgorot, 900);
    assert.deepEqual(s.categories, ['c-hot', 'c-drinks']);
    assert.deepEqual(s.products.map((p) => p.id), ['p-eggs', 'p-shakshuka', 'p-coffee', 'p-cola', 'p-water', 'p-beer']);
  });

  it('a product the kiosk never sells stays out of a menu that lists it ("קופות בלבד", "מחייב אישור מנהל", delisted)', () => {
    const rows = (all: Row[]) =>
      all.map((r) => {
        if (r.id === 'p-eggs') return { ...r, salesChannel: 'pos_only' };
        if (r.id === 'p-shakshuka') return { ...r, requiresManagerApproval: true };
        if (r.id === 'p-beer') return { ...r, inStock: false };
        return r;
      });
    const { catalog, settings } = goldenCatalog(day, rows);
    const ids = shown(catalog, settings, tue('08:00')).products.map((p) => p.id);
    assert.deepEqual(ids, ['p-coffee', 'p-cola', 'p-water']);
  });

  it('"לא למכור": nothing on the screens — and a line already in the basket is still known (held)', () => {
    const { catalog, settings } = goldenCatalog({ ...day, fallback: 'none' });
    const s = shown(catalog, settings, tue('19:30'));
    assert.equal(s.built.menu.mode, 'none');
    assert.deepEqual(s.built.categories, []);
    assert.deepEqual(s.built.products, []);
    assert.equal(s.built.held.length, golden.products.length);
    assert.equal(s.built.menu.hasMenus, true);
  });

  it('what the active menu does not place is held, at the catalog price, with its choices', () => {
    const { catalog, settings } = goldenCatalog(day);
    const built = buildWebCatalog(catalog, settings, { stock: {}, nowMs: localMs(tue('16:30')) });
    assert.equal(built.menu.menuId, 'm-happy');
    assert.deepEqual(built.products.map((p) => p.id), ['p-cola', 'p-beer'].sort((a, b) => golden.products.findIndex((p) => p.id === a) - golden.products.findIndex((p) => p.id === b)));
    const eggs = built.held.find((p) => p.id === 'p-eggs');
    assert.equal(eggs?.priceAgorot, 4200);
    assert.equal(eggs?.catalogPriceAgorot, undefined, 'held products carry no menu');
    assert.ok(!built.products.some((p) => p.id === 'p-eggs'));
  });

  it('a menu price carries its catalog price, the menu and where the price came from (what a line remembers)', () => {
    const { catalog, settings } = goldenCatalog(day);
    const built = buildWebCatalog(catalog, settings, { stock: {}, nowMs: localMs(tue('08:00')) });
    const coffee = built.products.find((p) => p.id === 'p-coffee')!;
    assert.deepEqual(
      { price: coffee.price, priceAgorot: coffee.priceAgorot, catalogPriceAgorot: coffee.catalogPriceAgorot, menuId: coffee.menuId, menuName: coffee.menuName, priceSource: coffee.priceSource },
      { price: 9, priceAgorot: 900, catalogPriceAgorot: 1200, menuId: 'm-breakfast', menuName: 'בוקר', priceSource: 'menu' },
    );
    const eggs = built.products.find((p) => p.id === 'p-eggs')!;
    assert.deepEqual({ priceAgorot: eggs.priceAgorot, catalogPriceAgorot: eggs.catalogPriceAgorot, priceSource: eggs.priceSource }, { priceAgorot: 4200, catalogPriceAgorot: 4200, priceSource: 'catalog' });
    assert.deepEqual(lineMenuFields(coffee), { menuId: 'm-breakfast', menuName: 'בוקר', priceSource: 'menu' });
    assert.deepEqual(lineMenuFields({}), { menuId: null, menuName: null, priceSource: null });
  });

  it('a kiosk without menus is the kiosk it was: nothing added, nothing held', () => {
    for (const block of [null, undefined, {}, { menus: [], assignments: [], fallback: 'catalog' }] as Array<MenuBlock | null | undefined>) {
      const { catalog, settings } = goldenCatalog(null);
      catalog.catalogMenus = block as MenuBlock | null;
      const built = buildWebCatalog(catalog, settings, { stock: {}, nowMs: localMs(tue('12:00')) });
      assert.equal(built.menu.mode, 'catalog');
      assert.equal(built.menu.hasMenus, false);
      assert.equal(built.products.length, golden.products.length);
      assert.deepEqual(built.held, []);
    }
  });

  it('the catalog title carries the menu\'s name, only while a menu is active', () => {
    const { catalog, settings } = goldenCatalog(day);
    const on = buildWebCatalog(catalog, settings, { stock: {}, nowMs: localMs(tue('08:00')) }).menu;
    const off = buildWebCatalog(catalog, settings, { stock: {}, nowMs: localMs(tue('19:00')) }).menu;
    assert.equal(titleWithMenu('התפריט', on), 'התפריט · בוקר');
    assert.equal(titleWithMenu('התפריט', off), 'התפריט');
    assert.equal(titleWithMenu('התפריט', null), 'התפריט');
  });

  it('the kiosk\'s own order gives way to the menu\'s, its hidden items stay hidden', () => {
    const { catalog, settings } = goldenCatalog(day);
    const built = buildWebCatalog(catalog, settings, { stock: {}, nowMs: localMs(tue('12:00')) });
    // The kiosk wants desserts first and the cola last: while lunch is on, lunch's order wins.
    const cfg = resolveKioskConfig({ catalog: { categoryOrder: ['c-dessert', 'c-drinks', 'c-mains'], productOrder: { 'c-drinks': ['p-beer'] }, hiddenProducts: ['p-water'] } } as never);
    const view = kioskCatalogView(built.categories, built.products, withMenuOrder(cfg, built.menu));
    assert.deepEqual(view.categories.map((c) => c.category.id), ['c-mains', 'c-drinks']);
    assert.deepEqual(view.categories[1].products.map((x) => x.product.id), ['p-cola', 'p-coffee', 'p-beer']);
    // Without a menu the kiosk's own order is in force.
    const plain = buildWebCatalog(catalog, settings, { stock: {}, nowMs: localMs(tue('19:00')) });
    const own = kioskCatalogView(plain.categories, plain.products, withMenuOrder(cfg, plain.menu));
    assert.deepEqual(own.categories.map((c) => c.category.id), ['c-dessert', 'c-drinks', 'c-mains', 'c-hot']);
    assert.deepEqual(own.categories.find((c) => c.category.id === 'c-drinks')!.products.map((x) => x.product.id), ['p-beer', 'p-coffee', 'p-cola']);
  });
});

describe('the clock: a menu switches at the minute, on the kiosk\'s own time', () => {
  it('reads the local date and minute (no seconds)', () => {
    const at = localMomentOfMs(localMs('2026-10-06T11:29') + 59_999);
    assert.equal(at.minute, 11 * 60 + 29);
  });

  it('the menu key changes at the boundary of the range, never before', () => {
    const block = golden.blocks.kioskHours;
    const key = (hhmm: string) => menuKeyAt(block, localMs(`2026-10-06T${hhmm}`) + 30_000);
    assert.equal(key('10:59'), 'catalog:');
    assert.equal(key('11:00'), 'menu:m-kiosk-lunch');
    assert.equal(key('13:59'), 'menu:m-kiosk-lunch');
    assert.equal(key('14:00'), 'catalog:');
  });

  it('the next look is on the far side of the next minute boundary', () => {
    const t = localMs('2026-10-06T11:29') + 41_000;
    const wait = msToNextMinute(t);
    assert.ok(wait > 19_000 && wait <= 19_025 + 1, String(wait));
    assert.equal(localMomentOfMs(t + wait).minute, 11 * 60 + 30);
  });

  it('the golden is read on the minute: the very same block, two minutes of one range', () => {
    const { catalog, settings } = goldenCatalog(golden.blocks.kioskHours);
    const before = buildWebCatalog(catalog, settings, { stock: {}, nowMs: localMs('2026-10-06T10:59') + 59_000 });
    const after = buildWebCatalog(catalog, settings, { stock: {}, nowMs: localMs('2026-10-06T11:00') });
    assert.equal(before.menu.mode, 'catalog');
    assert.equal(after.menu.menuId, 'm-kiosk-lunch');
    assert.equal(after.products.find((p) => p.id === 'p-pasta')?.priceAgorot, 3990);
  });
});

describe('the pull: the block is whole when sent, kept when a delta carries none', () => {
  const base = { products: [], categories: [], menu: null, machineCatalog: null, serverTime: null } as CatalogIn & { serverTime: string | null };
  const block = golden.blocks.base;

  it('a full pull replaces it — an empty one too, so the kiosk clears', () => {
    const had = applyCatalogPull(base, { syncType: 'full', catalogMenus: block });
    assert.equal(had.catalogMenus, block);
    const cleared = applyCatalogPull(had, { syncType: 'full', catalogMenus: { updatedAt: 'x', fallback: 'catalog', menus: [], assignments: [] } });
    assert.deepEqual(cleared.catalogMenus?.menus, []);
  });

  it('a delta that carries none keeps what the kiosk has; one that carries it replaces', () => {
    const had = applyCatalogPull(base, { syncType: 'full', catalogMenus: block });
    assert.equal(applyCatalogPull(had, { syncType: 'delta', products: [] }).catalogMenus, block);
    const next = golden.blocks.noSale;
    assert.equal(applyCatalogPull(had, { syncType: 'delta', catalogMenus: next }).catalogMenus, next);
  });

  it('an older cloud that never sends it leaves the kiosk with none (null, not undefined)', () => {
    assert.equal(applyCatalogPull(base, { syncType: 'full' }).catalogMenus, null);
  });
});

describe('an open basket keeps its prices', () => {
  const block = golden.blocks.base;
  const prices = menuPriceSets(block);

  it('knows every price a menu sets for a product', () => {
    assert.deepEqual([...(prices.get('p-coffee') ?? [])], [900]);
    assert.deepEqual([...(prices.get('p-cola') ?? [])].sort(), [850]);
    assert.equal(prices.get('p-eggs'), undefined);
  });

  it('breakfast ends under a coffee at 9: the line stays at 9, the catalog says 12 now', () => {
    // The check compares CATALOG prices: it is 12 for the line (added under a menu) and 12 now — nothing moved.
    const now = pricesNow({ priceAgorot: 1200 });
    assert.equal(keptListPrice({ listAgorot: 900, catalogAgorot: 1200 }, now, prices.get('p-coffee')), 900);
  });

  it('a line added with no menu stays at the catalog price when a menu now offers it cheaper', () => {
    const now = pricesNow({ priceAgorot: 900, catalogPriceAgorot: 1200 });
    assert.equal(keptListPrice({ listAgorot: 1200 }, now, prices.get('p-coffee')), 1200);
    assert.equal(basePriceOf({ priceAgorot: 900, catalogPriceAgorot: 1200 }), 1200);
    assert.equal(basePriceOf({ priceAgorot: 1200 }), 1200);
  });

  it('a real change of the catalog\'s price reprices the line to what the kiosk sells it at now', () => {
    // Added at 9 under breakfast (catalog 12); the shop raised the catalog to 14; breakfast ended: now 14.
    assert.equal(keptListPrice({ listAgorot: 900, catalogAgorot: 1200 }, pricesNow({ priceAgorot: 1400 }), prices.get('p-coffee')), 1400);
    // ... and while the menu is still on, at the menu's price.
    assert.equal(keptListPrice({ listAgorot: 900, catalogAgorot: 1200 }, pricesNow({ priceAgorot: 900, catalogPriceAgorot: 1400 }), prices.get('p-coffee')), 900);
  });

  it('a price nobody sets is not kept; a line without its own price (an older screen) is sold at now', () => {
    assert.equal(keptListPrice({ listAgorot: 1, catalogAgorot: 1200 }, pricesNow({ priceAgorot: 1200 }), prices.get('p-coffee')), 1200);
    assert.equal(keptListPrice({}, pricesNow({ priceAgorot: 900, catalogPriceAgorot: 1200 }), undefined), 900);
  });

  it('the cloud\'s word on a catalog-priced product moves it; a menu-priced product stays the menu\'s', () => {
    assert.deepEqual(pricesNow({ priceAgorot: 1200 }, 1300), { catalogAgorot: 1300, listAgorot: 1300 });
    assert.deepEqual(pricesNow({ priceAgorot: 900, catalogPriceAgorot: 1200 }, 1300), { catalogAgorot: 1200, listAgorot: 900 });
  });
});

describe('the pieces', () => {
  it('applyMenu: a listed price rounds half up to the agora; an empty category goes', () => {
    const menu = { categories: [{ id: 'a', all: true }, { id: 'gone', all: true }], products: [{ id: 'x', price: 24.505 }, { id: 'y', price: '3.1' }, { id: 'z', price: null }] };
    const out = applyMenu(menu, [
      { id: 'x', categoryId: 'a', priceAgorot: 100 },
      { id: 'y', categoryId: 'a', priceAgorot: 100 },
      { id: 'z', categoryId: 'a', priceAgorot: 777 },
      { id: 'w', categoryId: 'a', priceAgorot: 5 },
    ]);
    assert.deepEqual(out.categories, ['a']);
    assert.deepEqual(out.products.map((p) => [p.id, p.priceAgorot, p.source]), [['x', 2451, 'menu'], ['y', 310, 'menu'], ['z', 777, 'catalog'], ['w', 5, 'catalog']]);
  });

  it('layMenu orders the kiosk by the menu: its categories, then the listed products by category and by list', () => {
    const lay = layMenu(
      {
        fallback: 'catalog',
        menus: [{ id: 'm', name: 'M', channel: 'kiosk', schedule: { always: true }, categories: [{ id: 'b', all: true }, { id: 'a', all: false }], products: [{ id: 'a2' }, { id: 'b1' }, { id: 'a1' }] }],
        assignments: [{ menuId: 'm', level: 'machine', depth: 0, priority: 0 }],
      },
      localMs('2026-10-06T12:00'),
      [
        { id: 'a1', categoryId: 'a', priceAgorot: 100 },
        { id: 'a2', categoryId: 'a', priceAgorot: 100 },
        { id: 'b1', categoryId: 'b', priceAgorot: 100 },
        { id: 'b2', categoryId: 'b', priceAgorot: 100 },
      ],
    );
    assert.deepEqual(lay.state.categoryOrder, ['b', 'a']);
    assert.deepEqual(lay.state.productOrder, ['b1', 'a2', 'a1']);
    assert.ok(lay.placed?.has('b2') && !lay.placed.has('zzz'));
  });

  it('menuInputsOf leaves out a deleted row, the general item and what the shop does not list', () => {
    const rows = menuInputsOf([
      { id: 'a', categoryId: 'c', price: 1.5 },
      { id: 'b', categoryId: 'c', price: 2, deleted: true },
      { id: 'c', categoryId: 'c', price: 2, isGeneral: true },
      { id: 'd', categoryId: 'c', price: 2, shopListed: false },
      { id: 'e', categoryId: '', price: '2.25' },
    ]);
    assert.deepEqual(rows, [
      { id: 'a', categoryId: 'c', priceAgorot: 150 },
      { id: 'e', categoryId: null, priceAgorot: 225 },
    ]);
  });
});
