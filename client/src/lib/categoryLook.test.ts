/**
 * Run with `npm test`. "צבע ותמונה למחלקה" (lib/categoryLook.ts, P:/specs/category-color-image.md): the
 * palette, the chip's text — the same vector as pos-server tests/test_category_display_parameters.py
 * `TEXT_ON`, so the dashboard's preview, the cloud and the till agree — the three till parameters'
 * codes and defaults, and the square crop of the category dialog.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  BLACK,
  CATEGORY_DISPLAY_DEFAULTS,
  CATEGORY_PALETTE,
  CROP_OUTPUT_MAX,
  CROP_ZOOM_MAX,
  WHITE,
  categoryDisplayCodes,
  categoryInitial,
  changedCategoryDisplay,
  clampCrop,
  cropBox,
  cropLayout,
  cropOutputSide,
  initialCrop,
  normalizeHex,
  panCrop,
  readableTextOn,
  resolveCategoryDisplay,
  zoomCrop,
} from './categoryLook';

/** pos-server tests/test_category_display_parameters.py TEXT_ON — the same colours, the same text. */
const TEXT_ON: Array<[string, string]> = [
  ['#2563EB', '#FFFFFF'], // "שתייה" in blue: white text (§5.1)
  ['#1F6FEB', '#FFFFFF'],
  ['#FACC15', '#000000'],
  ['#FFFFFF', '#000000'],
  ['#000000', '#FFFFFF'],
  ['#EF4444', '#000000'],
  ['#DC2626', '#FFFFFF'],
  ['#22C55E', '#000000'],
  ['#15803D', '#FFFFFF'],
  ['#767676', '#000000'],
  ['#757575', '#FFFFFF'],
  ['#0f0', '#000000'],
  ['#00f', '#FFFFFF'],
];

describe('the chip\'s text', () => {
  for (const [color, text] of TEXT_ON) {
    it(`${color} → ${text}`, () => assert.equal(readableTextOn(color), text));
  }

  it('nothing for what is not a colour', () => {
    for (const bad of ['', 'blue', '#12345', '#GGGGGG', null, undefined]) assert.equal(readableTextOn(bad), null);
  });

  it('every palette colour is a colour, once, and readable one way or the other', () => {
    assert.equal(new Set(CATEGORY_PALETTE).size, CATEGORY_PALETTE.length);
    for (const c of CATEGORY_PALETTE) {
      assert.equal(normalizeHex(c), c);
      assert.ok([WHITE, BLACK].includes(readableTextOn(c)!), c);
    }
    // Both kinds are there: dark chips with white text, light ones with black.
    assert.ok(CATEGORY_PALETTE.some((c) => readableTextOn(c) === WHITE));
    assert.ok(CATEGORY_PALETTE.some((c) => readableTextOn(c) === BLACK));
  });
});

describe('a colour\'s normal form', () => {
  it('#RRGGBB in capitals', () => {
    assert.equal(normalizeHex('#abc'), '#AABBCC');
    assert.equal(normalizeHex('2563eb'), '#2563EB');
    assert.equal(normalizeHex(' #2563EB '), '#2563EB');
  });
  it('null for anything else', () => {
    for (const bad of ['', '#12', '#1234567', 'red', null, undefined]) assert.equal(normalizeHex(bad), null);
  });
});

describe('the first letter', () => {
  it('of the name, else a question mark', () => {
    assert.equal(categoryInitial('שתייה'), 'ש');
    assert.equal(categoryInitial('  drinks'), 'D');
    assert.equal(categoryInitial(''), '?');
    assert.equal(categoryInitial(null), '?');
  });
});

describe('the till parameters', () => {
  it('nothing set is today: off, off, m', () => {
    assert.deepEqual(CATEGORY_DISPLAY_DEFAULTS, { categoryColors: 'off', categoryImages: 'off', categoryImageSize: 'm' });
    assert.deepEqual(resolveCategoryDisplay({}), CATEGORY_DISPLAY_DEFAULTS);
    assert.deepEqual(resolveCategoryDisplay(null), CATEGORY_DISPLAY_DEFAULTS);
  });

  it('the codes the cloud keeps (pos-server app/services/category_display.py CODES)', () => {
    assert.deepEqual(categoryDisplayCodes('categoryColors'), ['off', 'chip', 'accent']);
    assert.deepEqual(categoryDisplayCodes('categoryImages'), ['off', 'bar', 'landing']);
    assert.deepEqual(categoryDisplayCodes('categoryImageSize'), ['s', 'm', 'l']);
  });

  it('a code it does not know reads as the default', () => {
    assert.deepEqual(resolveCategoryDisplay({ categoryColors: 'chip', categoryImages: 'grid', categoryImageSize: 3 }), {
      categoryColors: 'chip', categoryImages: 'off', categoryImageSize: 'm',
    });
  });

  it('sends only what changed, null to inherit', () => {
    const own = { categoryColors: 'chip', categoryImageSize: 'l' };
    assert.deepEqual(changedCategoryDisplay(own, {}), {});
    assert.deepEqual(changedCategoryDisplay(own, { categoryColors: 'chip' }), {});
    assert.deepEqual(changedCategoryDisplay(own, { categoryColors: 'accent', categoryImages: 'landing' }), {
      categoryColors: 'accent', categoryImages: 'landing',
    });
    assert.deepEqual(changedCategoryDisplay(own, { categoryImageSize: '' }), { categoryImageSize: null });
    assert.deepEqual(changedCategoryDisplay(own, { categoryImages: '' }), {});
  });
});

describe('the square crop', () => {
  const wide = { width: 1200, height: 800 };
  const tall = { width: 600, height: 900 };

  it('starts on the largest centred square', () => {
    assert.deepEqual(cropBox(wide, initialCrop(wide)), { sx: 200, sy: 0, side: 800 });
    assert.deepEqual(cropBox(tall, initialCrop(tall)), { sx: 0, sy: 150, side: 600 });
  });

  it('never leaves the picture, however far it is dragged', () => {
    const left = panCrop(wide, initialCrop(wide), 10_000, 0, 200);
    assert.deepEqual(cropBox(wide, left), { sx: 0, sy: 0, side: 800 });
    const right = panCrop(wide, initialCrop(wide), -10_000, -10_000, 200);
    assert.deepEqual(cropBox(wide, right), { sx: 400, sy: 0, side: 800 });
  });

  it('a drag moves the picture under the frame by the same screen distance', () => {
    // 800 px of picture in a 200 px frame: 1 screen px is 4 picture px.
    const moved = panCrop(wide, initialCrop(wide), 25, 0, 200);
    assert.equal(moved.cx, 600 - 100);
    const box = cropLayout(wide, moved, 200);
    assert.equal(box.width, 300);
    assert.equal(box.left, 100 - 500 / 4);
  });

  it('zooms in about its centre, up to the most', () => {
    const z = zoomCrop(wide, initialCrop(wide), 2);
    assert.deepEqual(cropBox(wide, z), { sx: 400, sy: 200, side: 400 });
    assert.equal(zoomCrop(wide, initialCrop(wide), 99).zoom, CROP_ZOOM_MAX);
    assert.equal(zoomCrop(wide, initialCrop(wide), 0.2).zoom, 1);
    // Zooming out near an edge pulls the square back inside.
    const corner = clampCrop(wide, { cx: 0, cy: 0, zoom: 4 });
    assert.deepEqual(cropBox(wide, corner), { sx: 0, sy: 0, side: 200 });
    assert.deepEqual(cropBox(wide, zoomCrop(wide, corner, 1)), { sx: 0, sy: 0, side: 800 });
  });

  it('a bad crop reads as the centred square', () => {
    assert.deepEqual(clampCrop(wide, { cx: NaN, cy: NaN, zoom: NaN }), { cx: 600, cy: 400, zoom: 1 });
  });

  it('uploads at most the product cap', () => {
    const huge = { width: 4000, height: 3000 };
    assert.equal(cropOutputSide(huge, initialCrop(huge)), CROP_OUTPUT_MAX);
    assert.equal(cropOutputSide(wide, zoomCrop(wide, initialCrop(wide), 2)), 400);
  });
});
