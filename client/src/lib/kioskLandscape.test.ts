import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyLandscape,
  categoryColumnDp,
  categoryImageDp,
  categoryItemDp,
  LANDSCAPE_GAP_DP,
  LANDSCAPE_MIN_TILE_DP,
  LANDSCAPE_MIN_TOUCH_DP,
  LANDSCAPE_OVERRIDE_KEYS,
  LANDSCAPE_SIZE_DEFAULTS,
  LANDSCAPE_SIZE_SPECS,
  CATEGORY_COLUMN_MAX_SHARE,
  landscapeLook,
  landscapeProductColumns,
  landscapeTextScale,
  landscapeTileDp,
  lookCategoryImagePx,
  lookCategoryItemPx,
  lookColumns,
  productImageDp,
  resolveLandscapeSizes,
  validateLandscape,
  type LandscapeDisplay,
} from './kioskLandscape';

/**
 * "עיצוב לרוחב" against the shared golden fixture (server/tests/fixtures/kiosk_landscape_golden.json — the same bytes
 * as kiosk-desktop's and pos-android's KioskLandscapeTest): every rule, number for number with the server's reference.
 */

function fixture(): string {
  const name = 'kiosk_landscape_golden.json';
  const candidates = [join(process.cwd(), '..', 'server', 'tests', 'fixtures', name), join(__dirname, '..', '..', 'server', 'tests', 'fixtures', name)];
  const path = candidates.find((p) => existsSync(p));
  if (!path) throw new Error(`${name} not found`);
  return readFileSync(path, 'utf8');
}

const text = fixture();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const golden: any = JSON.parse(text);
const sized = (s: Record<string, number>) => resolveLandscapeSizes({ sizes: s });

test('the fixture is the same bytes as the server\'s and the till\'s', () => {
  const sha = createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
  assert.equal(sha, '4bb0c99e5398d36f5a6f46bcbc4c2ce8fddeeb4f6d3c7eb4ba64ed6f35a5fb3e');
});

test('the sizes, their ranges, the constants and the keys', () => {
  assert.deepEqual(golden.sizes.defaults, LANDSCAPE_SIZE_DEFAULTS);
  for (const [k, spec] of Object.entries(LANDSCAPE_SIZE_SPECS)) assert.deepEqual(golden.sizes.ranges[k], { min: spec.min, max: spec.max, step: spec.step });
  assert.deepEqual(golden.constants, { gapDp: LANDSCAPE_GAP_DP, minTileDp: LANDSCAPE_MIN_TILE_DP, categoryColumnMaxShare: CATEGORY_COLUMN_MAX_SHARE, minTouchDp: LANDSCAPE_MIN_TOUCH_DP });
  assert.deepEqual(golden.overrideKeys, LANDSCAPE_OVERRIDE_KEYS);
});

test('every golden rule', () => {
  for (const c of golden.resolveSizes) assert.deepEqual(resolveLandscapeSizes(c.block), c.expect, c.name);
  for (const c of golden.productColumns) assert.equal(landscapeProductColumns(c.columns, c.gridDp, sized(c.sizes)), c.expect, JSON.stringify(c));
  for (const c of golden.categoryColumn) assert.equal(categoryColumnDp(c.widthDp, sized(c.sizes)), c.expect, JSON.stringify(c));
  for (const c of golden.categoryItem) assert.equal(categoryItemDp(c.computedDp, sized(c.sizes)), c.expect, JSON.stringify(c));
  for (const c of golden.categoryImage) assert.equal(categoryImageDp(c.computedDp, sized(c.sizes)), c.expect, JSON.stringify(c));
  for (const c of golden.productImage) assert.equal(productImageDp(c.computedDp, sized(c.sizes)), c.expect, JSON.stringify(c));
  for (const c of golden.textScale) assert.equal(landscapeTextScale(c.displayScale, sized(c.sizes)), c.expect, JSON.stringify(c));
});

test('the screens the owner checks', () => {
  for (const s of golden.screens) {
    const side = s.widthDp >= 1300;
    const panel = side ? Math.max(340, Math.min(480, Math.floor(s.widthDp * 0.26 + 0.5))) : 0;
    const rail = s.widthDp - panel >= 900;
    const col = rail ? categoryColumnDp(s.widthDp, LANDSCAPE_SIZE_DEFAULTS) : 0;
    const grid = s.widthDp - panel - col;
    const cols = landscapeProductColumns(s.layoutColumns, grid, LANDSCAPE_SIZE_DEFAULTS);
    const tile = landscapeTileDp(cols, grid);
    assert.deepEqual(
      { sideCart: side, panelDp: panel, rail, categoryColumnDp: col, gridDp: grid, columns: cols, tileDp: Math.round(tile * 100) / 100, imageDp43: productImageDp(tile * 0.75, LANDSCAPE_SIZE_DEFAULTS) },
      s.expect,
      s.name,
    );
  }
});

test('the design as drawn: every golden case', () => {
  for (const c of golden.apply) {
    const out = applyLandscape(c.config, c.display as LandscapeDisplay);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cfg = out.config as any;
    assert.deepEqual({ theme: cfg.theme, layout: cfg.layout, attract: cfg.attract, explicit: out.explicit }, c.expect, c.name);
  }
});

test('portrait and an unchanged landscape keep the very same object', () => {
  const cfg = { theme: { categoryLayout: 'side', cartStyle: 'panel' }, layout: { catalog: null, quickAdd: 'off', basket: 'panel' }, landscape: { layout: { basket: 'panel' } } };
  assert.equal(applyLandscape(cfg, { landscape: false, sideCart: true, rail: true }).config, cfg);
  assert.equal(applyLandscape(cfg, { landscape: true, sideCart: true, rail: true }).config, cfg);
});

test('the look in CSS px: the Windows kiosk at ×2, a browser at 1, portrait none', () => {
  const display = { landscape: true, sideCart: true, rail: true };
  assert.equal(landscapeLook({}, { ...display, landscape: false }, 1920, 1), null);
  const win = landscapeLook({}, display, 960, 0.5)!;
  assert.equal(win.columnPx, 116);
  assert.equal(win.categoryItemMaxPx, 48);
  assert.equal(win.productImageMaxPx, 80);
  // 604 CSS px of grid at ×2 = 1208 dp: 5 columns, as the golden's 1920×1080.
  assert.equal(lookColumns(win, 4, 604), 5);
  assert.equal(lookColumns(null, 4, 604), 4);
  assert.equal(lookCategoryItemPx(win, 80), 48);
  assert.equal(lookCategoryImagePx(win, 50), 32);
  const web = landscapeLook({ landscape: { sizes: { categoryColumnDp: 200, textScalePct: 90 } } }, display, 1920, 1)!;
  assert.equal(web.columnPx, 200);
  assert.equal(web.textFactor, 0.9);
});

test('validation: the vocabularies, the ranges, the steps', () => {
  const vocab = { 'theme.cartStyle': ['bar', 'panel'], 'layout.catalog': ['rail', 'wall'] };
  assert.deepEqual(validateLandscape(undefined, vocab), []);
  assert.deepEqual(validateLandscape({ theme: { cartStyle: 'bar' }, sizes: { categoryColumnDp: 240 } }, vocab), []);
  const codes = validateLandscape(
    { theme: { cartStyle: 'drawer', primaryColor: '#000' }, layout: { catalog: 'carousel' }, sizes: { categoryColumnDp: 230, productTileMaxDp: 999, productMinColumns: 2.5 }, texts: {} },
    vocab,
  ).map((e) => `${e.path}:${e.code}`);
  assert.deepEqual(codes.sort(), [
    'landscape.layout.catalog:enum',
    'landscape.sizes.categoryColumnDp:range',
    'landscape.sizes.productMinColumns:range',
    'landscape.sizes.productTileMaxDp:range',
    'landscape.texts:unknownKey',
    'landscape.theme.cartStyle:enum',
    'landscape.theme.primaryColor:unknownKey',
  ]);
});
