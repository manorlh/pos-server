/**
 * Run with `npm test`. "שם פריט מלא על הכפתור, ותג i" (lib/productTileText.ts, P:/specs/product-tile-text.md §6):
 * the four settings and the design over the parameter (as pos-server tests/test_product_tile_text.py), the
 * name's fit / wrap / clip with long Hebrew and English names at every tile width, the price never cut, the
 * badge by auto / always / off, and the cache — once per product and tile width.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  INFO_BADGE_TOUCH,
  MIN_TEXT_SP,
  NAME_FITS,
  PRICE_MIN_SP,
  PRODUCT_TEXT_DEFAULTS,
  PRODUCT_TEXT_KEYS,
  PRODUCT_TEXT_PARAMS,
  TileTextCache,
  dropZeroAgorot,
  ellipsize,
  estimateTextWidth,
  fitName,
  fitPrice,
  isProductTextCode,
  layoutTileText,
  nameHeight,
  priceRangeText,
  productTextFromParameters,
  resolveProductText,
  showInfoBadge,
  wrapWords,
  type MeasureText,
  type NameFit,
  type ProductTextSettings,
} from './productTileText';

/** Half an em a character: exact arithmetic for the cases below. */
const mono: MeasureText = (text, size) => Array.from(text).length * size * 0.5;

const LONG_HE = 'פלטת גבינות זהב עם ירקות טריים ולחם הבית';
const LONG_EN = 'Golden cheese platter with fresh vegetables and house bread';
const VERY_LONG_HE = 'מגש אירוח משפחתי גדול במיוחד עם מבחר סלטים, גבינות, דגים מעושנים, לחמים ומטבלים של הבית';
const ONE_WORD = 'Supercalifragilisticexpialidocious';

const settings = (over: Partial<ProductTextSettings> = {}): ProductTextSettings => ({ ...PRODUCT_TEXT_DEFAULTS, ...over });

describe('the four settings, as the cloud has them', () => {
  it('has the server\'s keys, codes and defaults', () => {
    assert.deepEqual([...PRODUCT_TEXT_KEYS], ['productNameFit', 'productNameMaxLines', 'productNameMinTextSize', 'productInfoBadge']);
    assert.deepEqual(PRODUCT_TEXT_DEFAULTS, { productNameFit: 'fit', productNameMaxLines: 3, productNameMinTextSize: 's', productInfoBadge: 'auto' });
    assert.deepEqual([...NAME_FITS], ['fit', 'wrap', 'clip']);
    assert.deepEqual(MIN_TEXT_SP, { s: 11, m: 13, l: 15 });
    assert.equal(PRICE_MIN_SP, 11);
    assert.ok(INFO_BADGE_TOUCH >= 32);
    assert.equal(PRODUCT_TEXT_PARAMS, 'params');
  });

  it('knows its codes and nothing else', () => {
    assert.ok(isProductTextCode('productNameFit', 'wrap'));
    assert.ok(!isProductTextCode('productNameFit', 'params'));
    assert.ok(!isProductTextCode('productNameFit', 'Fit'));
    for (const n of [1, 2, 3, 4]) assert.ok(isProductTextCode('productNameMaxLines', n));
    for (const n of [0, 5, 2.5, '3', true, null]) assert.ok(!isProductTextCode('productNameMaxLines', n));
    assert.ok(isProductTextCode('productNameMinTextSize', 'l') && !isProductTextCode('productNameMinTextSize', 'xl'));
    assert.ok(isProductTextCode('productInfoBadge', 'off') && !isProductTextCode('productInfoBadge', 'hover'));
  });

  it('the design wins; "params", null and an unknown value follow the parameter (§5)', () => {
    const params = { productNameFit: 'clip', productNameMaxLines: 2, productNameMinTextSize: 'm', productInfoBadge: 'off' };
    assert.deepEqual(resolveProductText(null, null), PRODUCT_TEXT_DEFAULTS);
    assert.deepEqual(resolveProductText({}, params), params);
    assert.deepEqual(resolveProductText({ productNameFit: 'wrap', productNameMaxLines: 4 }, params), { ...params, productNameFit: 'wrap', productNameMaxLines: 4 });
    assert.deepEqual(
      resolveProductText({ productNameFit: 'params', productNameMaxLines: null, productNameMinTextSize: 'xl', productInfoBadge: PRODUCT_TEXT_PARAMS }, params),
      params,
    );
    assert.deepEqual(productTextFromParameters({ productNameFit: 'shrink', productNameMaxLines: 9 }), PRODUCT_TEXT_DEFAULTS);
  });
});

describe('the name on the tile', () => {
  const widths = [60, 72, 90, 110, 140, 180, 240, 320];
  const names = [LONG_HE, LONG_EN, VERY_LONG_HE, 'קולה', 'Cola', ONE_WORD];

  it('never draws a line wider than the tile, nor more lines than allowed — every mode, every width', () => {
    for (const mode of NAME_FITS) {
      for (const maxLines of [1, 2, 3, 4]) {
        for (const width of widths) {
          for (const name of names) {
            for (const measure of [mono, estimateTextWidth]) {
              const fit = fitName({ name, width, height: 80, size: 16, settings: settings({ productNameFit: mode, productNameMaxLines: maxLines }) }, measure);
              assert.ok(fit.lines.length >= 1 && fit.lines.length <= maxLines, `${mode} ${maxLines} ${width} ${name}`);
              for (const line of fit.lines) assert.ok(measure(line, fit.size) <= width, `${mode} ${width} "${line}"`);
              // Every letter shown (a word wider than the line broken inside it), else "…" at the end.
              if (!fit.cut) assert.equal(fit.lines.join('').replace(/ /g, ''), name.replace(/ /g, ''));
              else assert.ok(fit.lines[fit.lines.length - 1].endsWith('…'));
            }
          }
        }
      }
    }
  });

  it('fit: the largest size that holds the whole name, down to the floor; "…" only past it', () => {
    const s = settings();
    const short = fitName({ name: 'קולה', width: 120, height: 60, size: 18, settings: s }, mono);
    assert.deepEqual(short, { size: 18, lines: ['קולה'], cut: false });

    // 40 characters in 120 px, three lines of 60 px: whole at 13 (18 chars a line), not at 13.5.
    const fit = fitName({ name: LONG_HE, width: 120, height: 60, size: 18, settings: s }, mono);
    assert.equal(fit.cut, false);
    assert.equal(fit.lines.join(' '), LONG_HE);
    assert.ok(fit.size < 18 && fit.size >= MIN_TEXT_SP.s);
    const bigger = fitName({ name: LONG_HE, width: 120, height: 60, size: fit.size + 0.5, settings: { ...s, productNameMinTextSize: 'l' } }, mono);
    assert.ok(bigger.cut || bigger.size < fit.size + 0.5, 'nothing larger holds it');

    // The floor: "l" never goes under 15; a name that does not fit there is cut with "…".
    const floorL = fitName({ name: VERY_LONG_HE, width: 120, height: 60, size: 18, settings: settings({ productNameMinTextSize: 'l' }) }, mono);
    assert.equal(floorL.size, 15);
    assert.equal(floorL.cut, true);
    assert.ok(floorL.lines[floorL.lines.length - 1].endsWith('…'));
    // A tile whose own size is under the floor is not grown.
    assert.equal(fitName({ name: 'קולה', width: 120, size: 10, settings: settings({ productNameMinTextSize: 'l' }) }, mono).size, 10);
  });

  it('fit: the tile\'s height limits the lines; a low tile shrinks the name more', () => {
    const tall = fitName({ name: LONG_EN, width: 120, height: 90, size: 18, settings: settings() }, mono);
    const low = fitName({ name: LONG_EN, width: 120, height: 30, size: 18, settings: settings() }, mono);
    assert.ok(low.lines.length * low.size * 1.2 <= 30 + 0.5 || low.cut);
    assert.ok(low.size <= tall.size);
  });

  it('wrap: the tile\'s own size, up to maxLines lines, and the tile grows by them', () => {
    const one = fitName({ name: LONG_HE, width: 120, size: 16, settings: settings({ productNameFit: 'wrap', productNameMaxLines: 1 }) }, mono);
    const four = fitName({ name: LONG_HE, width: 120, size: 16, settings: settings({ productNameFit: 'wrap', productNameMaxLines: 4 }) }, mono);
    assert.equal(one.size, 16);
    assert.equal(four.size, 16);
    assert.equal(one.lines.length, 1);
    assert.equal(one.cut, true);
    assert.ok(four.lines.length > 1);
    assert.ok(nameHeight(four) > nameHeight(one));
    // The height of the box does not cut a wrap: the tile grows.
    const boxed = fitName({ name: LONG_HE, width: 120, height: 20, size: 16, settings: settings({ productNameFit: 'wrap', productNameMaxLines: 4 }) }, mono);
    assert.deepEqual(boxed, four);
  });

  it('clip: as today — the tile\'s own size, its lines, "…"', () => {
    const clip = fitName({ name: LONG_HE, width: 120, height: 40, size: 16, settings: settings({ productNameFit: 'clip', productNameMaxLines: 3 }) }, mono);
    assert.equal(clip.size, 16);
    assert.equal(clip.lines.length, 2); // 40 px holds two lines of 19.2
    assert.equal(clip.cut, true);
    assert.ok(clip.lines[1].endsWith('…'));
  });

  it('wraps at words and cuts only a word wider than the line', () => {
    assert.deepEqual(wrapWords('a bb ccc', 25, 10, mono), ['a bb', 'ccc']);
    const pieces = wrapWords(ONE_WORD, 50, 10, mono);
    assert.ok(pieces.length > 1 && pieces.join('') === ONE_WORD);
    assert.equal(ellipsize('קולה', 100, 10, mono), 'קולה');
    assert.equal(ellipsize('abcdefghij', 30, 10, mono), 'abcde…');
  });

  it('the fit is the same for Hebrew and English of the same length (no script is favoured)', () => {
    const he = 'אבגדה וזחטי כלמנס עפצקר';
    const en = 'abcde fghij klmno pqrst';
    assert.equal(Array.from(he).length, Array.from(en).length);
    for (const mode of NAME_FITS as readonly NameFit[]) {
      const a = fitName({ name: he, width: 90, height: 50, size: 16, settings: settings({ productNameFit: mode }) }, mono);
      const b = fitName({ name: en, width: 90, height: 50, size: 16, settings: settings({ productNameFit: mode }) }, mono);
      assert.equal(a.size, b.size);
      assert.equal(a.lines.length, b.lines.length);
      assert.equal(a.cut, b.cut);
    }
  });
});

describe('the price is never cut (§2)', () => {
  it('keeps its size when it fits, shrinks to the floor, then drops ".00", else writes it whole', () => {
    assert.deepEqual(fitPrice('₪168.00', 200, 15, mono), { text: '₪168.00', size: 15, dropped: false, overflow: false });
    const smaller = fitPrice('₪168.00', 50, 15, mono); // 7 chars: 14.2 px a char at most
    assert.equal(smaller.text, '₪168.00');
    assert.ok(smaller.size < 15 && smaller.size >= PRICE_MIN_SP && !smaller.overflow);
    assert.deepEqual(fitPrice('₪168.00', 30, 15, mono), { text: '₪168', size: 11, dropped: true, overflow: false });
    assert.deepEqual(fitPrice('₪1,268.00', 20, 15, mono), { text: '₪1,268', size: 11, dropped: true, overflow: true });
    // Agorot that are not ".00" are never dropped; the amount stays whole.
    assert.deepEqual(fitPrice('₪168.50', 30, 15, mono), { text: '₪168.50', size: 11, dropped: false, overflow: true });
  });

  it('drops only a trailing ".00"', () => {
    assert.equal(dropZeroAgorot('₪168.00'), '₪168');
    assert.equal(dropZeroAgorot('168.00 ₪'), '168 ₪');
    assert.equal(dropZeroAgorot('₪1,268.00'), '₪1,268');
    assert.equal(dropZeroAgorot('₪168.50'), '₪168.50');
    assert.equal(dropZeroAgorot('₪100'), '₪100');
    assert.equal(dropZeroAgorot('₪1,000'), '₪1,000');
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
  const fit = (req: Parameters<typeof fitName>[0]) => fitName(req, mono);
  const req = { name: LONG_HE, width: 120, height: 60, size: 18, settings: settings({ productNameMinTextSize: 'l' as const }) };

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
    const tall = { ...req, name: LONG_HE, width: 120, height: 90, size: 18 };
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
    const req = { name: LONG_HE, width: 120, height: 60, size: 18, settings: settings() };
    const first = cache.name(req);
    for (let i = 0; i < 50; i++) assert.equal(cache.name({ ...req }), first);
    assert.equal(cache.computed, 1);
    cache.name({ ...req, width: 140 });
    cache.name({ ...req, settings: settings({ productNameFit: 'clip' }) });
    assert.equal(cache.computed, 3);
    const price = cache.price('₪168.00', 50, 15);
    assert.equal(cache.price('₪168.00', 50, 15), price);
    assert.equal(cache.computed, 4);
  });

  it('stays bounded', () => {
    const cache = new TileTextCache(mono, 10);
    for (let i = 0; i < 25; i++) cache.name({ name: `פריט ${i}`, width: 100, size: 16, settings: settings() });
    assert.equal(cache.computed, 25);
    cache.name({ name: 'פריט 24', width: 100, size: 16, settings: settings() });
    assert.equal(cache.computed, 25);
  });
});
