/**
 * What a kiosk sells at all (client lib/kioskSellable.ts) through the Windows kiosk — the Android kiosk's rule (pos-android
 * KioskCatalogView.kt `build`: `!isGeneral && !isOpenPrice && !isWeighed`) that the browser kiosk runs too: a customer keys no
 * price and weighs nothing, so the general item, an open-price product and a weighed one are never on a kiosk — whatever the
 * machine's list says, whatever a menu lists, never kept for an open basket and never a picture the kiosk keeps.
 *
 *  - the shared function, and that this kiosk's `sellableOnKiosk` IS it;
 *  - the catalog this kiosk builds (`buildKioskCatalog`) under no menu, "selected", a menu that LISTS them and "לא למכור";
 *  - the pictures it keeps (`catalogMedia`);
 *  - the basket: a line whose product turned into one of them is removed at the check, one added under a menu too.
 */

import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { neverOnKiosk, sellableOnKiosk as shared } from '@dash-lib/kioskSellable';
import type { MenuBlock } from '@dash-lib/menuSchedule';
import { buildKioskCatalog, catalogMedia, sellableOnKiosk } from '../src/main/kiosk/catalog';
import { KioskService } from '../src/main/service';
import type { BasketChange, StartPaymentIn } from '../src/shared/bridge';
import type { Transport } from '../src/main/printer/transports';

type Row = Record<string, unknown>;

/** The products no kiosk sells, each as the catalog row carries them. */
const NEVER: Array<[string, Row]> = [
  ['the general item', { isGeneral: true }],
  ['an open-price product', { isOpenPrice: true }],
  ['a weighed product', { isWeighed: true }],
  ['all three flags', { isGeneral: true, isOpenPrice: true, isWeighed: true }],
];

describe('what a kiosk sells at all — the shared rule', () => {
  it('is one function: the Windows kiosk\'s catalog exports the shared one', () => {
    expect(sellableOnKiosk).toBe(shared);
  });

  it('an ordinary product is sold; a flag that is off, absent or null changes nothing (an older server sends none)', () => {
    for (const flags of [{}, { isGeneral: false, isOpenPrice: false, isWeighed: false }, { isGeneral: null, isOpenPrice: undefined }]) {
      const row = { id: 'p', ...flags };
      expect(neverOnKiosk(row)).toBe(false);
      expect(sellableOnKiosk(row, 'all')).toBe(true);
    }
  });

  for (const [name, flags] of NEVER) {
    it(`${name} is never on a kiosk — under any machine list, with or without a menu placing it`, () => {
      const row: Row = { id: 'p', inMachineCatalog: true, inStock: true, ...flags };
      for (const mode of [undefined, null, 'all', 'selected']) {
        expect(sellableOnKiosk(row, mode), `mode ${String(mode)}`).toBe(false);
        expect(sellableOnKiosk(row, mode, true), `mode ${String(mode)}, a menu places it`).toBe(false);
      }
    });
  }

  it('the other reasons stay: deleted, delisted, "קופות בלבד", a manager\'s code — and a menu lifts only the machine\'s list', () => {
    expect(sellableOnKiosk({ deleted: true }, 'all')).toBe(false);
    expect(sellableOnKiosk({ inStock: false }, 'all')).toBe(false);
    expect(sellableOnKiosk({ salesChannel: 'pos_only' }, 'all', true)).toBe(false);
    expect(sellableOnKiosk({ requiresManagerApproval: true }, 'all', true)).toBe(false);
    expect(sellableOnKiosk({ inMachineCatalog: false }, 'selected')).toBe(false);
    expect(sellableOnKiosk({ inMachineCatalog: false }, 'selected', true)).toBe(true);
  });
});

describe('the Windows kiosk\'s catalog never carries them (buildKioskCatalog)', () => {
  const products: Row[] = [
    { id: 'dish', categoryId: 'food', name: 'מנה', price: 30, imageUrl: 'https://img.test/dish.jpg' },
    { id: 'general', categoryId: 'food', name: 'פריט כללי', price: 0, isGeneral: true, imageUrl: 'https://img.test/general.jpg' },
    { id: 'open', categoryId: 'food', name: 'מחיר פתוח', price: 0, isOpenPrice: true, imageUrl: 'https://img.test/open.jpg' },
    { id: 'weighed', categoryId: 'food', name: 'לפי משקל', price: 90, isWeighed: true, imageUrl: 'https://img.test/weighed.jpg' },
    { id: 'drink', categoryId: 'drinks', name: 'שתייה', price: 8, imageUrl: 'https://img.test/drink.jpg' },
  ];
  const categories: Row[] = [
    { id: 'food', name: 'אוכל', isActive: true },
    { id: 'drinks', name: 'שתייה', isActive: true },
  ];
  const ids = (list: Array<{ id: string }>) => list.map((p) => p.id).sort();
  const noImage = () => null;
  const at = { stock: {}, nowMs: Date.UTC(2026, 9, 7, 9, 0, 0) };

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
    const cat = buildKioskCatalog({ products, categories, menu: null, machineCatalog: { mode: 'all' } }, {}, noImage, at);
    expect(ids(cat.products)).toEqual(['dish', 'drink']);
    expect(cat.held).toEqual([]);
  });

  it('under the machine\'s "selected" list too, though the list names them', () => {
    const named = products.map((p) => ({ ...p, inMachineCatalog: true }));
    const cat = buildKioskCatalog({ products: named, categories, menu: null, machineCatalog: { mode: 'selected' } }, {}, noImage, at);
    expect(ids(cat.products)).toEqual(['dish', 'drink']);
  });

  it('a menu that lists them places none of them, at no price; what it does not place is held without them', () => {
    const cat = buildKioskCatalog({ products, categories, menu: null, machineCatalog: { mode: 'all' }, catalogMenus: listsThem }, {}, noImage, at);
    expect(cat.menu.mode).toBe('menu');
    expect(ids(cat.products)).toEqual(['dish']);
    expect(ids(cat.held)).toEqual(['drink']);
    expect(cat.products.map((p) => p.priceSource)).toEqual(['catalog']);
  });

  it('"לא למכור": nothing on the screens, and what is held for a basket is the dish and the drink only', () => {
    const none: MenuBlock = { fallback: 'none', menus: [], assignments: [] };
    const cat = buildKioskCatalog({ products, categories, menu: null, machineCatalog: { mode: 'all' }, catalogMenus: none }, {}, noImage, at);
    expect(cat.menu.mode).toBe('none');
    expect(cat.products).toEqual([]);
    expect(ids(cat.held)).toEqual(['dish', 'drink']);
  });

  it('keeps no picture of them — with or without menus', () => {
    const urls = (block: MenuBlock | null) =>
      catalogMedia({ products, categories, machineCatalog: { mode: 'all' }, catalogMenus: block }, { categories: [], products: [] })
        .map((m) => m.url)
        .sort();
    expect(urls(null)).toEqual(['https://img.test/dish.jpg', 'https://img.test/drink.jpg']);
    expect(urls(listsThem)).toEqual(['https://img.test/dish.jpg', 'https://img.test/drink.jpg']);
  });
});

const noPrinter: Transport = { send: async () => undefined, status: async () => ({ health: 'ok', detail: null }), list: async () => [], dispose: () => undefined };

/** A kiosk with a cloud catalog of two dishes (30 and 12), under an always-on menu that places the first and holds the second. */
function kiosk(block: MenuBlock | null = null) {
  const svc = new KioskService({ dataDir: mkdtempSync(path.join(os.tmpdir(), 'kd-never-')), appVersion: '0.4.1', deviceInfo: {}, transport: noPrinter, downloader: async () => { throw new Error('no media'); } });
  const body: Record<string, unknown> = {
    syncType: 'full',
    serverTime: 'x',
    categories: [{ id: 'food', name: 'אוכל', isActive: true }],
    products: [
      { id: 'dish', categoryId: 'food', name: 'מנה', price: 30 },
      { id: 'other', categoryId: 'food', name: 'אחרת', price: 12 },
    ],
    menu: null,
    machineCatalog: { mode: 'all' },
  };
  if (block) body.catalogMenus = block;
  svc.cloud.applyCatalog(body);
  return svc;
}

const alwaysOn: MenuBlock = {
  fallback: 'catalog',
  menus: [
    {
      id: 'all-day',
      name: 'כל היום',
      channel: 'kiosk',
      schedule: { always: true, days: null, ranges: [], from: null, to: null },
      categories: [{ id: 'food', all: false }],
      products: [{ id: 'dish' }],
    },
  ],
  assignments: [{ menuId: 'all-day', level: 'shop', depth: 0, priority: 0 }],
};

type Priced = { lines: Array<{ key: string }>; changes: BasketChange[] };
const priceOf = (svc: KioskService, lines: StartPaymentIn['lines']) =>
  (svc as unknown as { priceBasket(i: StartPaymentIn): Priced }).priceBasket({ lines, service: 'take_away', customerName: null, customerPhone: null, tableRef: null, tipPct: null, tipAgorot: null });
const line = (over: Partial<StartPaymentIn['lines'][number]>): StartPaymentIn['lines'][number] => ({ key: 'a', productId: 'dish', qty: 1, options: [], notes: [], ...over });

describe('the basket of the Windows kiosk — a line whose product no kiosk sells any more is removed at the check', () => {
  for (const [name, flags] of NEVER) {
    it(`${name}: a line added with no menu, and one added under a menu`, () => {
      const svc = kiosk(alwaysOn);
      try {
        // Control: the dish and the other one (held by the menu) are sold.
        const ok = priceOf(svc, [line({ key: 'a', productId: 'dish', menuId: 'all-day', listAgorot: 3000, catalogAgorot: 3000 }), line({ key: 'b', productId: 'other', menuId: 'all-day', listAgorot: 1200, catalogAgorot: 1200 })]);
        expect(ok.changes).toEqual([]);
        // The shop turned them into a product no kiosk sells.
        svc.cloud.applyCatalog({ syncType: 'delta', products: [{ id: 'dish', categoryId: 'food', name: 'מנה', price: 30, ...flags }, { id: 'other', categoryId: 'food', name: 'אחרת', price: 12, ...flags }], categories: [] });
        const r = priceOf(svc, [line({ key: 'a', productId: 'dish', menuId: 'all-day', listAgorot: 3000, catalogAgorot: 3000 }), line({ key: 'b', productId: 'other' }), line({ key: 'c', productId: 'other', menuId: 'all-day', listAgorot: 1200, catalogAgorot: 1200 })]);
        expect(r.changes.map((c) => [c.kind, c.key])).toEqual([['removed', 'a'], ['removed', 'b'], ['removed', 'c']]);
        expect(r.lines).toEqual([]);
      } finally {
        svc.stop();
      }
    });
  }
});
