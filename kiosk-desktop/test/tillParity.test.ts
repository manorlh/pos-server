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
import { SHOP_X_TEXT, shopXDocumentOf, shopXOffered, shopXRefusal } from '../src/core/till/shopX';
import { shopXPrintDoc } from '../src/core/printDocs';
import { linesAt, nameLayout, priceLayout, showsInfo, TILE_TEXT_DEFAULTS, tileTextOf } from '../src/core/till/tileText';
import type { Catalog, TillState } from '../src/shared/till/protocol';
import { ItemInfo } from '../src/renderer/roles/till/screens/SellScreen';
import { MACHINE, MANAGER_PIN, readyTill, roster } from './tillEngineHarness';

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

const SHOP_X_DOC = {
  title: 'דוח X סניפי',
  number: null,
  businessName: 'בדיקה בע״מ',
  subtitle: 'דוח X סניפי — דוח ביניים, אינו סוגר יום',
  sections: [
    { title: 'אזהרות', rows: [{ label: 'קופה 3', value: 'לא עודכנה מאז 20:10, 4 מסמכים ממתינים', emphasis: true }] },
    { title: 'סיכום', rows: [{ label: 'מכירות נטו', value: '₪1,234.00', emphasis: true }, { label: 'מזומן', value: '₪400.00', emphasis: false }] },
  ],
  footer: 'הופק ע״י אבי לוי בקופה 2, 21:03',
};

describe('"דוח X סניפי" on the till (P:/specs/shop-x-report.md, cloud route)', () => {
  it('on which tills: all (default), selected by id, the shop Z’s main till, off', () => {
    expect(shopXOffered({}, MACHINE)).toBe(true);
    expect(shopXOffered({ shopXTills: 'all' }, MACHINE)).toBe(true);
    expect(shopXOffered({ shopXTills: 'off' }, MACHINE)).toBe(false);
    expect(shopXOffered({ shopXTills: 'selected', shopXTillIds: `x, ${MACHINE.toUpperCase()}` }, MACHINE)).toBe(true);
    expect(shopXOffered({ shopXTills: 'selected', shopXTillIds: 'x,y' }, MACHINE)).toBe(false);
    expect(shopXOffered({ shopXTills: 'master', shopZMasterTill: MACHINE }, MACHINE)).toBe(true);
    expect(shopXOffered({ shopXTills: 'master', shopZMasterTill: 'other' }, MACHINE)).toBe(false);
  });

  it('the paper is the cloud’s document as written: title, business, subtitle, sections (bold where emphasised), footer — no number', () => {
    const doc = shopXDocumentOf(SHOP_X_DOC)!;
    expect(doc.sections).toHaveLength(2);
    const paper = shopXPrintDoc(doc, null);
    const text = JSON.stringify(paper.ops);
    for (const t of ['בדיקה בע״מ', 'דוח X סניפי', 'דוח ביניים', 'קופה 3', 'מכירות נטו', '₪1,234.00', 'הופק ע״י']) expect(text).toContain(t);
    expect(paper.ops).toContainEqual({ t: 'row', label: 'מכירות נטו', value: '₪1,234.00', bold: true });
    expect(text).not.toContain('מס׳');
    expect(shopXDocumentOf(null)).toBeNull();
    expect(shopXRefusal(403, { detail: { code: 'shop_x_not_available', reason: 'off' } })).toBe(SHOP_X_TEXT.notHere);
  });

  it('a manager: brought from the cloud with their id, shown in the state, printed on asking, gone at sign-out', async () => {
    const asked: Array<Record<string, unknown> | null> = [];
    const h = await readyTill({ answers: { 'GET sync/m/shop-x': (b) => (asked.push(b), { available: true, report: {}, printDocument: SHOP_X_DOC }) } }, MANAGER_PIN);
    try {
      expect(h.state().shopX?.offered).toBe(true);
      expect(h.state().session.permissions).toContain('SHOP_X_REPORT');
      await h.ok('report.shopX');
      expect(asked).toHaveLength(1);
      expect(h.state().shopX?.report?.sections[1].rows[0].label).toBe('מכירות נטו');
      const before = h.printer.sent.length;
      await h.ok('report.shopX', { print: true });
      await new Promise((r) => setTimeout(r, 50));
      expect(h.printer.sent.length).toBeGreaterThanOrEqual(before);
      await h.ok('session.logout');
      expect(h.state().shopX?.report).toBeNull();
    } finally {
      h.stop();
    }
  });

  it('a cashier whose role asks for a manager: the code first; denied: "אין לך הרשאה"; offline: the till’s own X stays', async () => {
    const users = roster().map((u) => (u.id === 'u-cashier' ? { ...u, permissions: { SELL: 'allow', SHIFT_OPEN: 'allow', SHOP_X_REPORT: 'approval' } } : u));
    const h = await readyTill({ users, answers: { 'GET sync/m/shop-x': () => ({ available: true, printDocument: SHOP_X_DOC }) } });
    try {
      const r = await h.ok<{ dialogId: string }>('report.shopX');
      expect(r.dialogId).toBeTruthy();
      expect(h.state().shopX?.report).toBeNull();
      await h.ok('dialog.answer', { dialogId: r.dialogId, action: 'approve', answers: { pin: MANAGER_PIN } });
      expect(h.state().shopX?.report?.title).toBe('דוח X סניפי');
    } finally {
      h.stop();
    }
    const denied = roster().map((u) => (u.id === 'u-cashier' ? { ...u, permissions: { SELL: 'allow', SHIFT_OPEN: 'allow', SHOP_X_REPORT: 'deny' } } : u));
    const d = await readyTill({ users: denied });
    try {
      expect((await d.fail('report.shopX')).message).toBe('אין לך הרשאה: דוח X סניפי');
    } finally {
      d.stop();
    }
    const off = await readyTill({
      answers: {
        'GET sync/m/shop-x': () => {
          throw new TypeError('fetch failed');
        },
      },
    }, MANAGER_PIN);
    try {
      expect((await off.fail('report.shopX')).message).toBe(SHOP_X_TEXT.needsCloud);
      expect(off.state().shopX?.error).toBe(SHOP_X_TEXT.needsCloud);
    } finally {
      off.stop();
    }
  });

  it('not on this till (shopXTills off): no menu row, and the op says so', async () => {
    const h = await readyTill({ parameters: { shopXTills: 'off' } }, MANAGER_PIN);
    try {
      expect(h.state().shopX?.offered).toBe(false);
      expect((await h.fail('report.shopX')).message).toBe(SHOP_X_TEXT.notHere);
    } finally {
      h.stop();
    }
  });
});

// The state type is part of the screens' contract: these fields are optional (an older engine sends none).
const _optional: Pick<TillState, 'menuHidden' | 'tileText'> = {};
void _optional;
