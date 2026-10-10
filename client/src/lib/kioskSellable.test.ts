/**
 * Run with `npm test`. What a kiosk sells at all (lib/kioskSellable.ts) — ONE rule for the Windows and the browser kiosk,
 * the Android kiosk's (pos-android domain/KioskCatalogView.kt `build`: `!isGeneral && !isOpenPrice && !isWeighed`): a customer
 * keys no price and weighs nothing, so the general item, an open-price product and a weighed one are never on a kiosk —
 * whatever the machine's list says, whatever a menu lists, and never kept for an open basket either.
 *
 * Here: the rule itself, and the browser kiosk's catalog (lib/kioskWebCatalog.ts buildWebCatalog) under no menu, a menu that
 * LISTS them and "לא למכור". kiosk-desktop/test/kioskSellable.test.ts runs the same table through the Windows kiosk's.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { neverOnKiosk, sellableOnKiosk } from './kioskSellable';
import { buildWebCatalog, sellableOnKiosk as exportedByTheCatalog } from './kioskWebCatalog';
import type { MenuBlock } from './menuSchedule';

type Row = Record<string, unknown>;

/** The products no kiosk sells, each as the catalog row carries them. */
const NEVER: Array<[string, Row]> = [
  ['the general item', { isGeneral: true }],
  ['an open-price product', { isOpenPrice: true }],
  ['a weighed product', { isWeighed: true }],
  ['all three flags', { isGeneral: true, isOpenPrice: true, isWeighed: true }],
];

describe('what a kiosk sells at all (lib/kioskSellable.ts)', () => {
  it('is one function: the browser kiosk\'s catalog exports the shared one', () => {
    assert.equal(exportedByTheCatalog, sellableOnKiosk);
  });

  it('an ordinary product is sold; a flag that is off, absent or null changes nothing (an older server sends none)', () => {
    for (const flags of [{}, { isGeneral: false, isOpenPrice: false, isWeighed: false }, { isGeneral: null, isOpenPrice: undefined }]) {
      const row = { id: 'p', ...flags };
      assert.equal(neverOnKiosk(row), false, JSON.stringify(flags));
      assert.equal(sellableOnKiosk(row, 'all'), true, JSON.stringify(flags));
    }
  });

  for (const [name, flags] of NEVER) {
    it(`${name} is never on a kiosk — under any machine list, with or without a menu placing it`, () => {
      const row: Row = { id: 'p', inMachineCatalog: true, inStock: true, ...flags };
      assert.equal(neverOnKiosk(row), true);
      for (const mode of [undefined, null, 'all', 'selected']) {
        assert.equal(sellableOnKiosk(row, mode), false, `mode ${String(mode)}`);
        assert.equal(sellableOnKiosk(row, mode, true), false, `mode ${String(mode)}, a menu places it`);
      }
    });
  }

  it('the other reasons stay: deleted, delisted, "קופות בלבד", a manager\'s code — and a menu lifts only the machine\'s list', () => {
    assert.equal(sellableOnKiosk({ deleted: true }, 'all'), false);
    assert.equal(sellableOnKiosk({ inStock: false }, 'all'), false);
    assert.equal(sellableOnKiosk({ salesChannel: 'pos_only' }, 'all', true), false);
    assert.equal(sellableOnKiosk({ salesChannel: 'kiosk' }, 'all'), true);
    assert.equal(sellableOnKiosk({ requiresManagerApproval: true }, 'all', true), false);
    assert.equal(sellableOnKiosk({ inMachineCatalog: false }, 'selected'), false);
    assert.equal(sellableOnKiosk({ inMachineCatalog: false }, 'selected', true), true);
    assert.equal(sellableOnKiosk({ inMachineCatalog: false }, 'all'), true);
  });
});

describe('the browser kiosk\'s catalog never carries them (buildWebCatalog)', () => {
  const products: Row[] = [
    { id: 'dish', categoryId: 'food', name: 'מנה', price: 30 },
    { id: 'general', categoryId: 'food', name: 'פריט כללי', price: 0, isGeneral: true },
    { id: 'open', categoryId: 'food', name: 'מחיר פתוח', price: 0, isOpenPrice: true },
    { id: 'weighed', categoryId: 'food', name: 'לפי משקל', price: 90, isWeighed: true },
    { id: 'drink', categoryId: 'drinks', name: 'שתייה', price: 8 },
  ];
  const categories: Row[] = [
    { id: 'food', name: 'אוכל', isActive: true },
    { id: 'drinks', name: 'שתייה', isActive: true },
  ];
  const ids = (list: Array<{ id: string }>) => list.map((p) => p.id).sort();

  /** An always-on kiosk menu that LISTS the three by name, and every product of "food". */
  const listsThem: MenuBlock = {
    fallback: 'catalog',
    menus: [
      {
        id: 'all-day',
        name: 'כל היום',
        channel: 'kiosk',
        schedule: { always: true, days: null, ranges: [], from: null, to: null },
        categories: [{ id: 'food', all: true }],
        products: [{ id: 'open', price: 5 }, { id: 'weighed' }, { id: 'general', price: 1 }],
      },
    ],
    assignments: [{ menuId: 'all-day', level: 'shop', depth: 0, priority: 0 }],
  };

  it('no menu: the dish and the drink — not the general item, the open-price or the weighed one — and nothing held', () => {
    const cat = buildWebCatalog({ products, categories, menu: null, machineCatalog: { mode: 'all' } }, {});
    assert.deepEqual(ids(cat.products), ['dish', 'drink']);
    assert.deepEqual(cat.held, []);
  });

  it('under the machine\'s "selected" list too, though the list names them', () => {
    const named = products.map((p) => ({ ...p, inMachineCatalog: true }));
    const cat = buildWebCatalog({ products: named, categories, menu: null, machineCatalog: { mode: 'selected' } }, {});
    assert.deepEqual(ids(cat.products), ['dish', 'drink']);
  });

  it('a menu that lists them places none of them, at no price; what it does not place is held without them', () => {
    const cat = buildWebCatalog({ products, categories, menu: null, machineCatalog: { mode: 'all' }, catalogMenus: listsThem }, {}, { stock: {}, nowMs: Date.UTC(2026, 9, 7, 9, 0, 0) });
    assert.equal(cat.menu.mode, 'menu');
    assert.deepEqual(ids(cat.products), ['dish']);
    assert.deepEqual(ids(cat.held), ['drink']);
    assert.deepEqual(cat.products.map((p) => p.priceSource), ['catalog']);
  });

  it('"לא למכור": nothing on the screens, and what is held for a basket is the dish and the drink only', () => {
    const none: MenuBlock = { fallback: 'none', menus: [], assignments: [] };
    const cat = buildWebCatalog({ products, categories, menu: null, machineCatalog: { mode: 'all' }, catalogMenus: none }, {});
    assert.equal(cat.menu.mode, 'none');
    assert.deepEqual(cat.products, []);
    assert.deepEqual(ids(cat.held), ['dish', 'drink']);
  });
});
