/**
 * Run with `npm test`. "שם פריט מלא על הכפתור, ותג i" (lib/productTileText.ts, P:/specs/product-tile-text.md §6):
 * the four settings and the design's `look` over the parameters (as pos-server tests/test_product_tile_text.py),
 * the name's fit / wrap / clip with long Hebrew and English names at every tile width against the spec step by
 * step (as the APK's ProductTileTextTest `reference`), the price never cut, the badge by auto / always / off, and
 * the cache — once per product and tile width.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  INFO_BADGE_TOUCH,
  MIN_TEXT_SIZES,
  MIN_TEXT_SP,
  NAME_FITS,
  NAME_FIT_STEP,
  PRICE_FLOOR_SP,
  PRICE_MIN_SP,
  PRODUCT_TEXT_DEFAULTS,
  PRODUCT_TEXT_KEYS,
  PRODUCT_TEXT_SECTION,
  TileTextCache,
  dropZeroAgorot,
  ellipsize,
  estimateTextWidth,
  fitName,
  fitPrice,
  fitSizes,
  isProductTextCode,
  layoutTileText,
  nameHeight,
  priceRangeText,
  productTextFromParameters,
  resolveProductText,
  showInfoBadge,
  wrapWords,
  type MeasureText,
  type NameFitRequest,
  type ProductTextSettings,
} from './productTileText';

/** Half an em a character: exact arithmetic for the cases below. */
const mono: MeasureText = (text, size) => Array.from(text).length * size * 0.5;

const LONG_HE = 'פלטת גבינות זהב עם ירקות טריים ולחם הבית';
const LONG_EN = 'Golden cheese platter with fresh vegetables and house bread';
const VERY_LONG_HE = 'מגש אירוח משפחתי גדול במיוחד עם מבחר סלטים, גבינות, דגים מעושנים, לחמים ומטבלים של הבית';
const ONE_WORD = 'Supercalifragilisticexpialidocious';

const settings = (over: Partial<ProductTextSettings> = {}): ProductTextSettings => ({ ...PRODUCT_TEXT_DEFAULTS, ...over });

/** The spec (§3), step by step at every size — what `fitName` must agree with (the APK's test does the same). */
function reference(req: NameFitRequest, measure: MeasureText): { size: number; count: number; cut: boolean } {
  const lh = req.lineHeight ?? 1.2;
  const width = Math.max(1, req.width - 0.5);
  const room = (s: number) => (req.height && req.height > 0 ? Math.max(1, Math.floor((req.height + 0.5) / (s * lh))) : Number.POSITIVE_INFINITY);
  const lines = (s: number) => wrapWords(req.name, width, s, measure).length;
  const most = req.settings.productNameMaxLines;
  const own = req.tileLines;
  const shown = (s: number, allowed: number) => ({ size: s, count: Math.min(lines(s), Math.max(1, allowed)), cut: lines(s) > Math.max(1, allowed) });
  if (req.settings.productNameFit === 'clip') return shown(req.size, Math.min(own, room(req.size)));
  if (req.settings.productNameFit === 'wrap') return shown(req.size, Math.min(most, room(req.size)));
  const first = Math.min(own, most);
  const floor = Math.min(MIN_TEXT_SP[req.settings.productNameMinTextSize], req.size);
  // First the size steps down on the tile's own lines…
  for (let s = req.size; s > floor + 0.001; s -= NAME_FIT_STEP) if (lines(s) <= Math.min(first, room(s))) return { size: s, count: lines(s), cut: false };
  if (lines(floor) <= Math.min(first, room(floor))) return { size: floor, count: lines(floor), cut: false };
  // …then the floor takes up to the most lines the box holds; "…" past those.
  return shown(floor, Math.min(most, room(floor)));
}

describe('the four settings, as the cloud and the APK have them', () => {
  it('has the keys, codes, defaults and floors', () => {
    assert.deepEqual([...PRODUCT_TEXT_KEYS], ['productNameFit', 'productNameMaxLines', 'productNameMinTextSize', 'productInfoBadge']);
    assert.deepEqual(PRODUCT_TEXT_DEFAULTS, { productNameFit: 'fit', productNameMaxLines: 3, productNameMinTextSize: 's', productInfoBadge: 'auto' });
    assert.deepEqual([...NAME_FITS], ['fit', 'wrap', 'clip']);
    assert.deepEqual(MIN_TEXT_SP, { s: 10, m: 12, l: 14 });
    assert.equal(NAME_FIT_STEP, 1);
    assert.equal(PRICE_MIN_SP, 10);
    assert.equal(PRICE_FLOOR_SP, 6);
    assert.ok(INFO_BADGE_TOUCH >= 32);
    assert.equal(PRODUCT_TEXT_SECTION, 'look');
  });

  it('knows its codes and nothing else', () => {
    assert.ok(isProductTextCode('productNameFit', 'wrap'));
    assert.ok(!isProductTextCode('productNameFit', 'base'));
    assert.ok(!isProductTextCode('productNameFit', 'Fit'));
    for (const n of [1, 2, 3, 4]) assert.ok(isProductTextCode('productNameMaxLines', n));
    for (const n of [0, 5, 2.5, '3', true, null]) assert.ok(!isProductTextCode('productNameMaxLines', n));
    assert.ok(isProductTextCode('productNameMinTextSize', 'l') && !isProductTextCode('productNameMinTextSize', 'xl'));
    assert.ok(isProductTextCode('productInfoBadge', 'off') && !isProductTextCode('productInfoBadge', 'hover'));
  });

  it('the design wins; "base", null and a value not of the vocabulary follow the parameter (§5)', () => {
    const params = { productNameFit: 'clip', productNameMaxLines: 2, productNameMinTextSize: 'm', productInfoBadge: 'off' };
    assert.deepEqual(resolveProductText(null, null), PRODUCT_TEXT_DEFAULTS);
    assert.deepEqual(resolveProductText({}, params), params);
    assert.deepEqual(resolveProductText({ productNameFit: 'wrap', productNameMaxLines: 4 }, params), { ...params, productNameFit: 'wrap', productNameMaxLines: 4 });
    assert.deepEqual(resolveProductText({ productNameFit: 'base', productNameMaxLines: null, productNameMinTextSize: 'xl', productInfoBadge: 'base' }, params), params);
    assert.deepEqual(productTextFromParameters({ productNameFit: 'shrink', productNameMaxLines: 9 }), PRODUCT_TEXT_DEFAULTS);
  });
});

describe('the name on the tile (§3)', () => {
  const widths = [60, 72, 90, 110, 140, 180, 240, 320];
  const names = [LONG_HE, LONG_EN, VERY_LONG_HE, 'קולה', 'Cola', ONE_WORD];

  it("agrees with the spec step by step — every mode, lines, floor, width, height and the tile's own lines", () => {
    let cases = 0;
    for (const productNameFit of NAME_FITS) {
      for (const productNameMaxLines of [1, 2, 3, 4]) {
        for (const productNameMinTextSize of MIN_TEXT_SIZES) {
          for (const width of widths) {
            for (const height of [0, 30, 60, 90]) {
              for (const tileLines of [1, 2, 3]) {
                for (const name of names) {
                  for (const measure of [mono, estimateTextWidth]) {
                    const req: NameFitRequest = { name, width, height, size: 18, tileLines, settings: { productNameFit, productNameMaxLines, productNameMinTextSize } };
                    const got = fitName(req, measure);
                    const want = reference(req, measure);
                    const label = `${productNameFit} ${productNameMaxLines} ${productNameMinTextSize} ${width}x${height} own ${tileLines} "${name}"`;
                    assert.equal(got.size, want.size, label);
                    assert.equal(got.lines.length, want.count, label);
                    assert.equal(got.cut, want.cut, label);
                    for (const line of got.lines) assert.ok(measure(line, got.size) <= width, `${label}: "${line}"`);
                    // Every letter shown (a word wider than the line broken inside it), else "…" at the end.
                    if (!got.cut) assert.equal(got.lines.join('').replace(/ /g, ''), name.replace(/ /g, ''), label);
                    else assert.ok(got.lines[got.lines.length - 1].endsWith('…'), label);
                    cases += 1;
                  }
                }
              }
            }
          }
        }
      }
    }
    assert.ok(cases > 10000);
  });

  it("fit: the tile's own size and lines when the name fits them; smaller on them; then the floor on more lines", () => {
    const s = settings();
    assert.deepEqual(fitName({ name: 'קולה', width: 120, height: 60, size: 18, tileLines: 2, settings: s }, mono), { size: 18, lines: ['קולה'], cut: false });
    // 40 characters in 119.5 px on two own lines: smaller until two hold it (at the floor a line holds 23).
    const two = fitName({ name: LONG_HE, width: 120, height: 90, size: 18, tileLines: 2, settings: s }, mono);
    assert.equal(two.lines.length, 2);
    assert.equal(two.cut, false);
    assert.ok(two.size < 18 && two.size >= MIN_TEXT_SP.s);
    // On one own line it fits at no size: the floor takes more lines (up to three).
    const one = fitName({ name: LONG_HE, width: 120, height: 90, size: 18, tileLines: 1, settings: s }, mono);
    assert.equal(one.size, MIN_TEXT_SP.s);
    assert.equal(one.cut, false);
    assert.ok(one.lines.length >= 2 && one.lines.length <= 3);
    // "l" never goes under 14; a name too long there gets "…" past the lines.
    const floorL = fitName({ name: VERY_LONG_HE, width: 120, height: 60, size: 18, tileLines: 2, settings: settings({ productNameMinTextSize: 'l' }) }, mono);
    assert.equal(floorL.size, 14);
    assert.equal(floorL.cut, true);
    assert.ok(floorL.lines[floorL.lines.length - 1].endsWith('…'));
    // A tile whose own size is under the floor is not grown.
    assert.equal(fitName({ name: 'קולה', width: 120, size: 9, tileLines: 1, settings: settings({ productNameMinTextSize: 'l' }) }, mono).size, 9);
  });

  it("wrap: the tile's own size, up to maxLines lines, and the tile grows by them", () => {
    const one = fitName({ name: LONG_HE, width: 120, size: 16, tileLines: 2, settings: settings({ productNameFit: 'wrap', productNameMaxLines: 1 }) }, mono);
    const four = fitName({ name: LONG_HE, width: 120, size: 16, tileLines: 2, settings: settings({ productNameFit: 'wrap', productNameMaxLines: 4 }) }, mono);
    assert.equal(one.size, 16);
    assert.equal(four.size, 16);
    assert.equal(one.lines.length, 1);
    assert.equal(one.cut, true);
    assert.ok(four.lines.length > 2);
    assert.ok(nameHeight(four) > nameHeight(one));
  });

  it('clip: as before — the tile\'s own size and lines, "…"', () => {
    const clip = fitName({ name: LONG_HE, width: 120, height: 90, size: 16, tileLines: 2, settings: settings({ productNameFit: 'clip', productNameMaxLines: 4 }) }, mono);
    assert.equal(clip.size, 16);
    assert.equal(clip.lines.length, 2);
    assert.equal(clip.cut, true);
    assert.ok(clip.lines[1].endsWith('…'));
  });

  it('wraps at words and cuts only a word wider than the line', () => {
    assert.deepEqual(wrapWords('a bb ccc', 25, 10, mono), ['a bb', 'ccc']);
    const pieces = wrapWords(ONE_WORD, 50, 10, mono);
    assert.ok(pieces.length > 1 && pieces.join('') === ONE_WORD);
    assert.equal(ellipsize('קולה', 100, 10, mono), 'קולה');
    assert.equal(ellipsize('abcdefghij', 30, 10, mono), 'abcde…');
    assert.deepEqual(fitSizes(18, 10), [18, 17, 16, 15, 14, 13, 12, 11, 10]);
    assert.deepEqual(fitSizes(15.5, 14), [15.5, 14.5, 14]);
    assert.deepEqual(fitSizes(9, 10), [9]);
  });

  it('the fit is the same for Hebrew and English of the same length (no script is favoured)', () => {
    const he = 'אבגדה וזחטי כלמנס עפצקר';
    const en = 'abcde fghij klmno pqrst';
    assert.equal(Array.from(he).length, Array.from(en).length);
    for (const productNameFit of NAME_FITS) {
      const a = fitName({ name: he, width: 90, height: 50, size: 16, tileLines: 2, settings: settings({ productNameFit }) }, mono);
      const b = fitName({ name: en, width: 90, height: 50, size: 16, tileLines: 2, settings: settings({ productNameFit }) }, mono);
      assert.equal(a.size, b.size);
      assert.equal(a.lines.length, b.lines.length);
      assert.equal(a.cut, b.cut);
    }
  });
});

describe('the price is never cut (§2)', () => {
  it('its own size when it fits; smaller to 10; then without ".00"; then smaller still to 6', () => {
    assert.deepEqual(fitPrice('₪168.00', 200, 15, mono), { text: '₪168.00', size: 15, dropped: false, overflow: false });
    // 7 characters in 49.5 px: 14 holds them.
    assert.deepEqual(fitPrice('₪168.00', 50, 15, mono), { text: '₪168.00', size: 14, dropped: false, overflow: false });
    // Not even at 10: without its ".00", at the largest size that holds it.
    assert.deepEqual(fitPrice('₪168.00', 30, 15, mono), { text: '₪168', size: 14, dropped: true, overflow: false });
    // Without ".00" and still too wide at 10: smaller still, the number whole.
    assert.deepEqual(fitPrice('₪1,268.00', 20, 15, mono), { text: '₪1,268', size: 6, dropped: true, overflow: false });
    // Agorot that are not ".00" are never dropped: smaller.
    assert.deepEqual(fitPrice('₪168.50', 30, 15, mono), { text: '₪168.50', size: 8, dropped: false, overflow: false });
    // Past the floor: whole all the same.
    assert.deepEqual(fitPrice('₪1,268.50', 10, 15, mono), { text: '₪1,268.50', size: 6, dropped: false, overflow: true });
    // A tile's size under the minimum stays.
    assert.deepEqual(fitPrice('₪5', 100, 9, mono), { text: '₪5', size: 9, dropped: false, overflow: false });
  });

  it('drops ".00" and only ".00"', () => {
    assert.equal(dropZeroAgorot('₪168.00'), '₪168');
    assert.equal(dropZeroAgorot('168.00 ₪'), '168 ₪');
    assert.equal(dropZeroAgorot('₪1,268.00'), '₪1,268');
    assert.equal(dropZeroAgorot('₪24.00 לק"ג'), '₪24 לק"ג');
    assert.equal(dropZeroAgorot('₪10.00–₪20.00'), '₪10–₪20');
    assert.equal(dropZeroAgorot('₪168.50'), '₪168.50');
    assert.equal(dropZeroAgorot('₪100'), '₪100');
    assert.equal(dropZeroAgorot('₪1,000'), '₪1,000');
    assert.equal(dropZeroAgorot('₪1.005'), '₪1.005');
  });

  it('a range for sizes and variants', () => {
    const f = (a: number) => `₪${a / 100}`;
    assert.equal(priceRangeText([2800, 3400, 3100], f), '₪28–₪34');
    assert.equal(priceRangeText([2800, 2800], f), '₪28');
    assert.equal(priceRangeText([], f), '');
  });
});

describe('the "i" badge (§4)', () => {
  it('auto: a description or a cut name; always; off; never while arranging', () => {
    assert.equal(showInfoBadge('auto', { description: 'קציצת בקר', nameCut: false }), true);
    assert.equal(showInfoBadge('auto', { description: '   ', nameCut: false }), false);
    assert.equal(showInfoBadge('auto', { description: null, nameCut: true }), true);
    assert.equal(showInfoBadge('auto', { nameCut: false }), false);
    assert.equal(showInfoBadge('always', { nameCut: false }), true);
    assert.equal(showInfoBadge('off', { description: 'x', nameCut: true }), false);
    assert.equal(showInfoBadge('always', { nameCut: true, arranging: true }), false);
  });
});

describe('the name beside its badge', () => {
  const fit = (req: NameFitRequest) => fitName(req, mono);
  const req: NameFitRequest = { name: LONG_HE, width: 120, height: 60, size: 18, tileLines: 2, settings: settings({ productNameMinTextSize: 'l' }) };

  it("a description takes the badge's room first; a cut name gets the badge and is laid out beside it", () => {
    const withDescription = layoutTileText(fit, req, { mode: 'auto', description: 'גבינות' }, 26);
    assert.equal(withDescription.badge, true);
    assert.deepEqual(withDescription.name, fit({ ...req, width: 94 }));
    const cut = layoutTileText(fit, { ...req, name: VERY_LONG_HE }, { mode: 'auto' }, 26);
    assert.equal(cut.badge, true);
    assert.equal(cut.name.cut, true);
    assert.deepEqual(cut.name, fit({ ...req, name: VERY_LONG_HE, width: 94 }));
    const whole = layoutTileText(fit, { ...req, name: 'קולה' }, { mode: 'auto' }, 26);
    assert.deepEqual(whole, { name: fit({ ...req, name: 'קולה' }), badge: false });
  });

  it('a badge above the name takes its room from the height', () => {
    const tall = { ...req, height: 90 };
    const above = layoutTileText(fit, tall, { mode: 'auto', description: 'x' }, 26, 'height');
    assert.equal(above.badge, true);
    assert.deepEqual(above.name, fit({ ...tall, height: 64 }));
    // wrap: no height to take from.
    const wrapReq = { ...tall, height: 0, settings: settings({ productNameFit: 'wrap' }) };
    assert.deepEqual(layoutTileText(fit, wrapReq, { mode: 'always' }, 26, 'height').name, fit(wrapReq));
  });

  it('always / off / arranging', () => {
    assert.equal(layoutTileText(fit, { ...req, name: 'קולה' }, { mode: 'always' }, 26).badge, true);
    const off = layoutTileText(fit, { ...req, name: VERY_LONG_HE }, { mode: 'off', description: 'x' }, 26);
    assert.deepEqual(off, { name: fit({ ...req, name: VERY_LONG_HE }), badge: false });
    assert.equal(layoutTileText(fit, req, { mode: 'always', arranging: true }, 26).badge, false);
  });
});

describe('worked out once per product and tile width (§3, §6)', () => {
  it('reads a drawn tile back from the cache', () => {
    const cache = new TileTextCache(mono);
    const req: NameFitRequest = { name: LONG_HE, width: 120, height: 60, size: 18, tileLines: 2, settings: settings() };
    const first = cache.name(req);
    for (let i = 0; i < 50; i++) assert.equal(cache.name({ ...req }), first);
    assert.equal(cache.computed, 1);
    cache.name({ ...req, width: 140 });
    cache.name({ ...req, settings: settings({ productNameFit: 'clip' }) });
    cache.name({ ...req, tileLines: 3 });
    assert.equal(cache.computed, 4);
    const price = cache.price('₪168.00', 50, 15);
    assert.equal(cache.price('₪168.00', 50, 15), price);
    assert.equal(cache.computed, 5);
  });

  it('stays bounded', () => {
    const cache = new TileTextCache(mono, 10);
    for (let i = 0; i < 25; i++) cache.name({ name: `פריט ${i}`, width: 100, size: 16, tileLines: 2, settings: settings() });
    assert.equal(cache.computed, 25);
    cache.name({ name: 'פריט 24', width: 100, size: 16, tileLines: 2, settings: settings() });
    assert.equal(cache.computed, 25);
  });
});
