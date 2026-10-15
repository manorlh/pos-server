/**
 * The Windows till brought up to the Android till's features (17.10 parity pass): payment integration "none", the menu
 * items a business hides (`hiddenMenuItems`, keys pinned to the Android golden), and the product tile's text and "i"
 * (P:/specs/product-tile-text.md). The engine runs over a real KioskService with a fake cloud and terminal.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MENU_ITEM_KEYS, parseHiddenMenu } from '../src/core/till/menuHide';
import { linesAt, nameLayout, priceLayout, showsInfo, TILE_TEXT_DEFAULTS, tileTextOf } from '../src/core/till/tileText';
import type { Catalog, TillState } from '../src/shared/till/protocol';
import { ItemInfo } from '../src/renderer/roles/till/screens/SellScreen';
import { readyTill } from './tillEngineHarness';

const here = path.dirname(fileURLToPath(import.meta.url));

describe('"ללא אשראי" — payment integration none on the till (P:/specs/payment-integration-none.md)', () => {
  it('no card at all: the state says so, a card is refused in the till’s words, cash sells as always', async () => {
    const h = await readyTill({ settings: { paymentIntegration: 'none' } });
    try {
      expect(h.state().health.noCard).toBe(true);
      await h.ok('sell.add', { productId: 'p-cola' });
      await h.ok('checkout.start');
      const refused = await h.fail('checkout.card');
      expect(refused.message).toBe('הקופה מוגדרת ללא אשראי');
      expect(h.terminal.sales).toHaveLength(0);
      await h.ok('checkout.cash', { amountAgorot: 1_250 });
      expect(h.state().checkout.phase).toBe('done');
    } finally {
      h.stop();
    }
  });

  it('a till with a terminal: no such flag', async () => {
    const h = await readyTill();
    try {
      expect(h.state().health.noCard).toBeUndefined();
    } finally {
      h.stop();
    }
  });
});

describe('"הסתרת פריטים בתפריט הקופה" — hiddenMenuItems (the Android MenuHide)', () => {
  it('the keys are the Android till’s, in its order (till_menu_items_golden.json, a byte copy)', () => {
    const golden = JSON.parse(readFileSync(path.join(here, 'fixtures', 'till_menu_items_golden.json'), 'utf8')) as Array<{ key: string }>;
    expect([...MENU_ITEM_KEYS]).toEqual(golden.map((g) => g.key));
  });

  it('CSV or a JSON array, any case and spacing; unknown keys skipped; blank — nothing', () => {
    expect(parseHiddenMenu('till_z, Catalog_Admin ;history')).toEqual(['catalog_admin', 'till_z', 'history']);
    expect(parseHiddenMenu('["shift_close","refund"]')).toEqual(['shift_close', 'refund']);
    expect(parseHiddenMenu(['kiosk_mode', 'not_a_key'])).toEqual(['kiosk_mode']);
    expect(parseHiddenMenu('')).toEqual([]);
    expect(parseHiddenMenu(null)).toEqual([]);
    expect(parseHiddenMenu(7)).toEqual([]);
  });

  it('`quick_order` is a tables-only device’s: the Windows till has no tables — never left with no way to sell', () => {
    expect(parseHiddenMenu('quick_order,tables')).toEqual(['tables']);
  });

  it('the engine’s state carries what the till’s parameter hides', async () => {
    const h = await readyTill({ parameters: { hiddenMenuItems: 'till_z,switch_user' } });
    try {
      expect(h.state().menuHidden).toEqual(['till_z', 'switch_user']);
    } finally {
      h.stop();
    }
  });
});

describe('the product tile: the whole name, the price never cut, the "i" (P:/specs/product-tile-text.md)', () => {
  it('the parameters, with their defaults (fit, 3 lines, s, auto) for anything missing or wrong', () => {
    expect(tileTextOf({})).toEqual(TILE_TEXT_DEFAULTS);
    expect(tileTextOf({ productNameFit: 'WRAP', productNameMaxLines: '4', productNameMinTextSize: 'l', productInfoBadge: 'off' })).toEqual({ fit: 'wrap', maxLines: 4, minSize: 'l', infoBadge: 'off' });
    expect(tileTextOf({ productNameFit: 'squeeze', productNameMaxLines: 9, productNameMinTextSize: 'xl', productInfoBadge: 1 })).toEqual(TILE_TEXT_DEFAULTS);
  });

  it('fit (the Android fitProductName): a short name as it is; a long one first shrinks on the tile’s own two lines, then the minimum takes more lines; "…" only past those', () => {
    const s = TILE_TEXT_DEFAULTS;
    expect(nameLayout('קולה', 120, 80, s)).toEqual({ px: 16, lines: 2, whole: true });
    const long = nameLayout('פלטת גבינות זיתים ולחם הבית', 120, 80, s);
    expect(long).toMatchObject({ lines: 2, whole: true });
    expect(long.px).toBeLessThan(16);
    expect(linesAt('פלטת גבינות זיתים ולחם הבית', long.px, 120)).toBeLessThanOrEqual(2);
    // Too long for two lines even at the minimum (10 px): the minimum on up to three.
    const longer = nameLayout('מגש אירוח גדול עם גבינות קשות ורכות ופירות העונה', 100, 80, s);
    expect(longer).toMatchObject({ px: 10, lines: 3 });
    const huge = nameLayout('מגש אירוח גדול במיוחד עם גבינות קשות ורכות פירות העונה קרקרים ולחמניות טריות מהמאפייה ועוד הרבה מאוד דברים', 100, 80, s);
    expect(huge).toMatchObject({ px: 10, lines: 3, whole: false });
    // "l" never goes below 14.
    expect(nameLayout('מגש אירוח גדול עם גבינות קשות ורכות ופירות העונה', 100, 80, { ...s, minSize: 'l' }).px).toBe(14);
  });

  it('wrap keeps the size over up to the lines; clip keeps today’s two lines', () => {
    expect(nameLayout('פלטת גבינות זיתים ולחם הבית', 120, 80, { ...TILE_TEXT_DEFAULTS, fit: 'wrap', maxLines: 4 })).toMatchObject({ px: 16, lines: 4 });
    expect(nameLayout('פלטת גבינות זיתים ולחם הבית', 120, 80, { ...TILE_TEXT_DEFAULTS, fit: 'clip' })).toMatchObject({ px: 16, lines: 2, whole: false });
  });

  it('the "i": auto — a description or a name that did not fit; always; off', () => {
    expect(showsInfo('auto', false, true)).toBe(false);
    expect(showsInfo('auto', true, true)).toBe(true);
    expect(showsInfo('auto', false, false)).toBe(true);
    expect(showsInfo('always', false, true)).toBe(true);
    expect(showsInfo('off', true, false)).toBe(false);
  });

  it('the price is never cut: its type shrinks, then ".00" goes — the amount stays whole', () => {
    expect(priceLayout('₪12.50', 200)).toEqual({ text: '₪12.50', px: 15 });
    expect(priceLayout('₪168.00', 40)).toEqual({ text: '₪168', px: 15 });
    // Agorot that are not zero stay: the type goes down to the floor rather than lose a digit.
    expect(priceLayout('₪1,168.50', 30)).toEqual({ text: '₪1,168.50', px: 6 });
  });

  it('the engine sends the tile’s settings in its state, and the item’s description and allergens with the catalog', async () => {
    const h = await readyTill({
      parameters: { productInfoBadge: 'always', productNameMaxLines: 2 },
      products: [{ id: 'p-plate', name: 'פלטת גבינות', price: 168, categoryId: 'c-main', inStock: true, isAvailable: true, description: 'גבינות קשות ורכות, זיתים ולחם', allergens: ['milk', 'gluten'], dietaryTags: ['vegetarian'] }],
    });
    try {
      expect(h.state().tileText).toMatchObject({ fit: 'fit', maxLines: 2, infoBadge: 'always' });
      const cat = await h.ok<Catalog>('catalog.snapshot');
      expect(cat.products[0]).toMatchObject({ id: 'p-plate', description: 'גבינות קשות ורכות, זיתים ולחם', allergens: ['חלב', 'גלוטן'] });
    } finally {
      h.stop();
    }
  });

  it('the "i" window: the full name, the department, the description, the price, allergens, the state and "הוסף לסל"', () => {
    const html = renderToStaticMarkup(
      createElement(ItemInfo, {
        product: { id: 'p', departmentId: 'c', name: 'פלטת גבינות', priceAgorot: 16_800, description: 'גבינות וזיתים', allergens: ['חלב'], sale: 'blocked', saleReason: 'נגמר בצק' },
        department: 'מנות',
        onAdd: () => undefined,
        onClose: () => undefined,
      }),
    );
    for (const text of ['פלטת גבינות', 'מנות', 'גבינות וזיתים', '168.00', 'חלב', 'חסום', 'נגמר בצק', 'הוסף לסל']) expect(html).toContain(text);
  });
});

// The state type is part of the screens' contract: these fields are optional (an older engine sends none).
const _optional: Pick<TillState, 'menuHidden' | 'tileText'> = {};
void _optional;
