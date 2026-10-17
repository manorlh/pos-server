/**
 * The designed order screen's measures and rules on the Windows till (src/renderer/roles/till/design/designLayout.ts),
 * mirrored from pos-android ui/sell/design/DesignLayout.kt, domain/TillDesignNight.kt, domain/TillDesignPhase2.kt,
 * domain/TillDesignKeyboard.kt and domain/FlowDesign.kt FlowColors — the same numbers for the same window.
 */
import { describe, expect, it } from 'vitest';
import {
  barArrangement,
  barButtons,
  contrast,
  densityFactor,
  designBillCollapsible,
  designColumns,
  designTileHeightDp,
  designWindow,
  dishCardHeightDp,
  dishColumns,
  dishNameLines,
  drawerFraction,
  fKeyAction,
  flowPalette,
  flowPickupAsks,
  keyboardTyped,
  nightBillPosition,
  nightBillWidthDp,
  nightColumns,
  orderedCatalog,
  payDockPlan,
  payDockPrimary,
  pluLookup,
  quantityKeypadTyped,
  shownProducts,
  sideBillWidthDp,
} from '../src/renderer/roles/till/design/designLayout';
import type { Catalog, Product } from '../src/shared/till/protocol';

describe('the grid (DesignLayout.kt designColumns / designTileHeightDp)', () => {
  it('density: compact 0.85, comfortable 1, spacious 1.15', () => {
    expect(densityFactor('compact')).toBe(0.85);
    expect(densityFactor('comfortable')).toBe(1);
    expect(densityFactor('spacious')).toBe(1.15);
  });

  it('card: ~240 dp on a tablet, a set size its own target, two on the handheld', () => {
    // A 1920 window with a 460 side bill: a 1459 dp pane → (1435 + 8) / 248 = 5.
    expect(designColumns('card', 1459, false, 0, null)).toBe(5);
    expect(designColumns('card', 1459, false, 0, 'xs')).toBe(8);
    expect(designColumns('card', 1459, false, 0, 'l')).toBe(5);
    expect(designColumns('card', 400, true, 0, null)).toBe(2);
    expect(designColumns('card', 400, true, 0, 'xs')).toBe(4);
    expect(designColumns('card', 300, false, 0, null)).toBe(2);
  });

  it('photo ~240 (2–6), key ~140 (3–8), row one list (two past 900)', () => {
    expect(designColumns('photo', 1459, false, 0, null)).toBe(5);
    expect(designColumns('photo', 400, true, 0, null)).toBe(2);
    expect(designColumns('key', 1459, false, 0, null)).toBe(8);
    expect(designColumns('key', 900, false, 0, null)).toBe(5);
    expect(designColumns('key', 400, true, 0, null)).toBe(3);
    expect(designColumns('row', 901, false, 0, null)).toBe(2);
    expect(designColumns('row', 900, false, 0, null)).toBe(1);
  });

  it('layout.columns wins (2–8; a row list 1–2)', () => {
    expect(designColumns('card', 1459, false, 3, null)).toBe(3);
    expect(designColumns('card', 1459, false, 12, null)).toBe(8);
    expect(designColumns('card', 1459, false, 1, null)).toBe(2);
    expect(designColumns('row', 1459, false, 5, null)).toBe(2);
  });

  it('heights: cards by the size × density, rows 56 / 48, keys 72 / 60, a photo 16:10 + 64', () => {
    expect(designTileHeightDp('card', 'm', 'comfortable', 200)).toBe(150);
    expect(designTileHeightDp('card', 'l', 'spacious', 200)).toBe(Math.round(196 * 1.15));
    expect(designTileHeightDp('card', 'xs', 'compact', 200)).toBe(Math.round(92 * 0.85));
    expect(designTileHeightDp('row', 'm', 'compact', 200)).toBe(48);
    expect(designTileHeightDp('row', 'm', 'spacious', 200)).toBe(64);
    expect(designTileHeightDp('key', 'm', 'compact', 200)).toBe(60);
    expect(designTileHeightDp('key', 'm', 'comfortable', 200)).toBe(72);
    expect(designTileHeightDp('photo', 'm', 'comfortable', 240)).toBe(214);
  });

  it('לילה: two on the handheld, three upright, ~180 dp sideways (3–6)', () => {
    expect(nightColumns(400, true, false, 0)).toBe(2);
    expect(nightColumns(800, false, true, 0)).toBe(3);
    expect(nightColumns(1205, false, false, 0)).toBe(6);
    expect(nightColumns(600, false, false, 0)).toBe(3);
    expect(nightColumns(1205, false, false, 4)).toBe(4);
  });

  it('תפריט ויזואלי: one row-card on the handheld, ~280 dp (2–4), a set count 1–6', () => {
    expect(dishColumns(400, true, 0)).toBe(1);
    expect(dishColumns(1920, false, 0)).toBe(4);
    expect(dishColumns(1366, false, 0)).toBe(4);
    expect(dishColumns(700, false, 0)).toBe(2);
    expect(dishColumns(1920, false, 6)).toBe(6);
    expect(dishNameLines('תיאור', 2)).toBe(1);
    expect(dishNameLines(null, 2)).toBe(2);
    expect(dishNameLines('תיאור', 0)).toBe(2);
    // A text card grows with its description's lines and the dietary line.
    expect(dishCardHeightDp(2, false)).toBeGreaterThan(dishCardHeightDp(0, false));
    expect(dishCardHeightDp(2, true)).toBeGreaterThan(dishCardHeightDp(2, false));
    expect(dishCardHeightDp(0, false, 1, 1)).toBeLessThan(dishCardHeightDp(0, false, 1, 2));
  });

  it('the virtualised window: the rows on screen and three around', () => {
    expect(designWindow(0, 100, 8, 0, 500)).toEqual({ first: 0, last: -1, padTop: 0, padBottom: 0 });
    const w = designWindow(100, 100, 8, 1080, 540);
    expect(w.first).toBe(7);
    expect(w.last).toBe(18);
    expect(w.padTop).toBe(7 * 108);
    expect(w.padBottom).toBe((99 - 18) * 108);
  });
});

describe('the bill (DesignLayout.kt, TillDesignNight.kt)', () => {
  it('the side bill: 36% (340–460), professional 40% (300–520), courses half (55% past 1500, ≥ 400)', () => {
    expect(sideBillWidthDp(1920, 'touch')).toBe(460);
    expect(sideBillWidthDp(1366, 'touch')).toBe(460);
    expect(sideBillWidthDp(1100, 'touch')).toBe(396);
    expect(sideBillWidthDp(800, 'touch')).toBe(340);
    expect(sideBillWidthDp(1920, 'professional')).toBe(520);
    expect(sideBillWidthDp(1366, 'professional')).toBe(520);
    expect(sideBillWidthDp(1000, 'professional')).toBe(400);
    expect(sideBillWidthDp(1920, 'courses')).toBe(Math.round(1920 * 0.55));
    expect(sideBillWidthDp(700, 'courses')).toBe(400);
  });

  it('the night bill: 34% (340–520); "left" puts it at the start, a bill not at a side stays', () => {
    expect(nightBillWidthDp(1920)).toBe(520);
    expect(nightBillWidthDp(1366)).toBe(464);
    expect(nightBillWidthDp(800)).toBe(340);
    expect(nightBillPosition('end', 'left')).toBe('start');
    expect(nightBillPosition('start', 'right')).toBe('end');
    expect(nightBillPosition('bottom', 'left')).toBe('bottom');
  });

  it('collapsible: the handheld, the template\'s own, an upright screen under 900 — only at the bottom', () => {
    expect(designBillCollapsible('bottom', true, false, 400, 800)).toBe(true);
    expect(designBillCollapsible('bottom', false, true, 1920, 1080)).toBe(true);
    expect(designBillCollapsible('bottom', false, false, 720, 720)).toBe(true);
    expect(designBillCollapsible('bottom', false, false, 800, 1280)).toBe(false);
    expect(designBillCollapsible('bottom', false, false, 1920, 1080)).toBe(false);
    expect(designBillCollapsible('end', true, true, 400, 800)).toBe(false);
  });

  it('the visual drawer: 34% of a wide screen, else 40%', () => {
    expect(drawerFraction(1920)).toBe(0.34);
    expect(drawerFraction(1366)).toBe(0.4);
  });
});

describe('the bar and the dock (designBarButtons, payDockPlan)', () => {
  const bar = [
    { action: 'fastCard', label: 'אשראי', primary: false },
    { action: 'fastCash', label: 'מזומן מהיר', primary: false },
    { action: 'cashNotes', label: 'שטרות', primary: false },
    { action: 'customer', label: 'לקוח', primary: false },
    { action: 'repeatRound', label: 'שוב', primary: false },
    { action: 'discount', label: 'עובדים', primary: false, presetId: 'p1' },
    { action: 'pay', label: 'תשלום', primary: true },
  ];

  it('"שטרות" a button per note offered; what the till has no flow for left off', () => {
    const out = barButtons(bar, [50, 100]);
    expect(out.map((b) => b.action)).toEqual(['fastCard', 'fastCash', 'cashNotes', 'cashNotes', 'discount', 'pay']);
    expect(out.filter((b) => b.action === 'cashNotes').map((b) => b.noteShekels)).toEqual([50, 100]);
    expect(out.find((b) => b.action === 'discount')?.presetId).toBe('p1');
    expect(out.find((b) => b.action === 'pay')?.primary).toBe(true);
  });

  it('the arrangement: a side panel stacks, three in a row, more scroll', () => {
    expect(barArrangement(5, true)).toBe('stacked');
    expect(barArrangement(3, false)).toBe('row');
    expect(barArrangement(4, false)).toBe('scroll');
  });

  it('the dock\'s primary: the fast card, else pay', () => {
    expect(payDockPrimary(barButtons(bar, []))).toBe('fastCard');
    expect(payDockPrimary([{ action: 'fastCash' }, { action: 'pay' }])).toBe('pay');
    expect(payDockPrimary([{ action: 'hold' }])).toBeNull();
  });

  it('the dock drops the banknotes first (the highest), then from the end — never the primary or pay', () => {
    const buttons = barButtons(bar, [50, 100, 200]);
    const wide = payDockPlan(buttons, 1920, false, 'fastCard');
    expect(wide.overflow).toEqual([]);
    const narrow = payDockPlan(buttons, 1000, false, 'fastCard');
    expect(narrow.shown.some((b) => b.action === 'fastCard')).toBe(true);
    expect(narrow.shown.some((b) => b.action === 'pay')).toBe(true);
    // 200 goes first, then 100 — and then it fits: 50 stays.
    expect(narrow.overflow.map((b) => b.noteShekels)).toEqual([100, 200]);
    expect(narrow.shown.some((b) => b.noteShekels === 50)).toBe(true);
    const handheld = payDockPlan(buttons, 400, true, 'fastCard');
    expect(handheld.shown.map((b) => b.action)).toEqual(['fastCard', 'fastCash']);
  });
});

describe('the menu (menu.categoryOrder / productOrder / hiddenCategories)', () => {
  const catalog: Catalog = {
    version: 1,
    departments: [
      { id: 'a', name: 'א', color: '#000000' },
      { id: 'b', name: 'ב', color: '#000000' },
      { id: 'c', name: 'ג', color: '#000000' },
    ],
    products: [
      { id: 'p1', departmentId: 'a', name: 'אחד', priceAgorot: 100 },
      { id: 'p2', departmentId: 'b', name: 'שתיים', priceAgorot: 100 },
      { id: 'p3', departmentId: 'a', name: 'שלוש', priceAgorot: 100, barcode: '729' },
      { id: 'p4', departmentId: 'c', name: 'ארבע', priceAgorot: 100 },
    ],
  };

  it('the default design: the catalogue as it is', () => {
    const o = orderedCatalog(catalog, { categoryOrder: [], productOrder: [], hiddenCategories: [] });
    expect(o.departments).toBe(catalog.departments);
    expect(o.products).toBe(catalog.products);
  });

  it('the departments in order, a hidden one off the tabs and "הכל", the products in order inside their place', () => {
    const o = orderedCatalog(catalog, { categoryOrder: ['b', 'a'], productOrder: ['p3', 'p1'], hiddenCategories: ['c'] });
    expect(o.departments.map((d) => d.id)).toEqual(['b', 'a']);
    expect(o.products.map((p) => p.id)).toEqual(['p2', 'p3', 'p1']);
    expect(shownProducts(catalog.products, o.products, 'a', '').map((p) => p.id)).toEqual(['p3', 'p1']);
    // A search still finds the hidden department's product.
    expect(shownProducts(catalog.products, o.products, null, 'ארבע').map((p) => p.id)).toEqual(['p4']);
    expect(shownProducts(catalog.products, o.products, null, '729').map((p) => p.id)).toEqual(['p3']);
  });
});

describe('the professional keyboard (TillDesignKeyboard.kt)', () => {
  it('a quantity: digits, no leading 0, at most 99', () => {
    expect(keyboardTyped('', '0', 'quantity')).toBe('');
    expect(keyboardTyped('', '4', 'quantity')).toBe('4');
    expect(keyboardTyped('4', '2', 'quantity')).toBe('42');
    expect(keyboardTyped('42', '1', 'quantity')).toBe('42');
    expect(keyboardTyped('4', 'א', 'quantity')).toBe('4');
    expect(quantityKeypadTyped('', '0')).toBe('');
    expect(quantityKeypadTyped('9', '9')).toBe('99');
  });

  it('a price: one point, two decimals; a search anything', () => {
    expect(keyboardTyped('', '.', 'price')).toBe('0.');
    expect(keyboardTyped('0', '5', 'price')).toBe('5');
    expect(keyboardTyped('12.5', '0', 'price')).toBe('12.50');
    expect(keyboardTyped('12.50', '1', 'price')).toBe('12.50');
    expect(keyboardTyped('12.', '.', 'price')).toBe('12.');
    expect(keyboardTyped('קפ', 'ה', 'search')).toBe('קפה');
  });

  it('PLU: the SKU (any case), else the barcode', () => {
    const products: Product[] = [
      { id: 'a', departmentId: 'd', name: 'א', priceAgorot: 1, sku: 'AB1' },
      { id: 'b', departmentId: 'd', name: 'ב', priceAgorot: 1, barcode: 'ab1' },
    ];
    expect(pluLookup('ab1', products)?.id).toBe('a');
    expect(pluLookup('  ', products)).toBeNull();
    expect(pluLookup('nope', products)).toBeNull();
  });

  it('the F keys', () => {
    expect(fKeyAction('F1')).toBe('search');
    expect(fKeyAction('F2')).toBe('code');
    expect(fKeyAction('F3')).toBe('quantity');
    expect(fKeyAction('F4')).toBe('price');
    expect(fKeyAction('F9')).toBe('pay');
    expect(fKeyAction('F10')).toBe('exactCash');
    expect(fKeyAction('Escape')).toBe('clear');
    expect(fKeyAction('F5')).toBeNull();
  });
});

describe('"הדבורה" (FlowColors.palette)', () => {
  it('ours without a background: the designed neutrals, light or dark', () => {
    const light = flowPalette(null, '#007AFF', false);
    expect(light.page).toBe('#F3F5F8');
    expect(light.surface).toBe('#FFFFFF');
    expect(light.dark).toBe(false);
    const dark = flowPalette(null, null, true);
    expect(dark.page).toBe('#0E1014');
    expect(dark.dark).toBe(true);
  });

  it('a chosen background: dark below 0.18, every text 4.5:1 on what it is drawn on', () => {
    for (const bg of ['#1B2A4A', '#FFE08A', '#7A1F3D', '#E6F4EA', '#808080']) {
      for (const accent of ['#E11D48', '#FACC15', '#007AFF']) {
        const p = flowPalette(bg, accent, false);
        expect(p.page).toBe(bg);
        expect(contrast(p.text, p.page)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(p.text, p.surface)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(p.secondary, p.page)).toBeGreaterThanOrEqual(4.5 - 1e-9);
        expect(contrast(p.onAccent, p.accent)).toBeGreaterThanOrEqual(4.5 - 1e-9);
      }
    }
    expect(flowPalette('#1B2A4A', null, false).dark).toBe(true);
    expect(flowPalette('#FFE08A', null, true).dark).toBe(false);
  });

  it('a light brand carries ink, a deep one white', () => {
    expect(flowPalette(null, '#FACC15', false).onAccent).toBe('#111827');
    expect(flowPalette(null, '#1E3A8A', false).onAccent).toBe('#FFFFFF');
  });

  it('pickupName: "ask" and "required" ask, "auto" and "off" do not', () => {
    expect(flowPickupAsks('ask')).toBe('ask');
    expect(flowPickupAsks('required')).toBe('required');
    expect(flowPickupAsks('auto')).toBe('off');
    expect(flowPickupAsks('off')).toBe('off');
  });
});
