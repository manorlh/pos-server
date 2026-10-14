/**
 * "שם פריט מלא על הכפתור, ותג i" on the web till (P:/specs/product-tile-text.md §6; the web till matches the
 * APK): the grid's tiles through the shared rules — the name's fit / wrap / clip with long Hebrew and
 * English names at every tile width, the price never cut, the "i" by auto / always / off and never inside
 * the tile's button (a tap on it adds nothing), wrap growing a row to its tallest in the virtualised grid,
 * the item's details with every field, "הוסף לסל" through the tile's own `sell.add` (a blocked item
 * refused by the engine, as for a tap), and the answers worked out once per product and tile width.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PRODUCT_TEXT_DEFAULTS, TileTextCache, estimateTextWidth, type ProductTextSettings } from '@dash-lib/productTileText';
import { demoCatalog } from '../src/shared/till/catalogDemo';
import { initialState, MockTillEngine } from '../src/shared/till/mockEngine';
import { MUTATING_OPS, TILL_ERRORS, type Product, type TillState } from '../src/shared/till/protocol';
import { ProductGrid, gridWindow, gridWindowOf, tileWidthOf } from '../src/renderer/roles/till/parts/ProductGrid';
import { ProductInfo } from '../src/renderer/roles/till/parts/ProductInfo';
import { displayProductText, layoutTile, nameBox, rowHeights, TILE_NAME_PX, TILE_OWN_LINES } from '../src/renderer/roles/till/parts/tileText';
import { SellScreen } from '../src/renderer/roles/till/screens/SellScreen';
import { browserFacts, displayProfile } from '../src/renderer/roles/till/layout/displayProfileAdapter';
import { tillLayout } from '../src/renderer/roles/till/layout/tillLayout';
import { money } from '../src/renderer/roles/till/text';

const settings = (over: Partial<ProductTextSettings> = {}): ProductTextSettings => ({ ...PRODUCT_TEXT_DEFAULTS, ...over });
const catalog = demoCatalog();
const byName = (name: string) => catalog.products.find((p) => p.name === name) as Product;
const PLATTER = 'פלטת גבינות זהב עם ירקות טריים ולחם הבית';
const FEAST = 'מגש אירוח משפחתי גדול במיוחד';
const LONG_EN: Product = { id: 'en', departmentId: 'sandwich', name: 'Golden cheese platter with fresh vegetables and house bread', priceAgorot: 16800 };
const noop = () => undefined;
const cache = () => new TileTextCache(estimateTextWidth);

describe('the tiles', () => {
  it('the demo catalog has the long names, the long price, the sizes and a blocked item with its reason', () => {
    expect(byName(PLATTER).priceAgorot).toBe(16800);
    expect(byName(FEAST).priceAgorot).toBe(126850);
    expect(byName('הפוך גדול').variants?.length).toBe(2);
    expect(byName('בייגל סלמון').blocked).toEqual({ kind: 'sold_out', reason: 'נגמר הסלמון להיום' });
  });

  it('fit / wrap / clip: never wider than the tile, the lines each mode allows, "…" only when cut — at every width', () => {
    for (const productNameFit of ['fit', 'wrap', 'clip'] as const) {
      for (const productNameMaxLines of [1, 2, 3, 4]) {
        for (const tileWidth of [90, 110, 140, 180, 220, 300]) {
          for (const p of [byName(PLATTER), byName(FEAST), LONG_EN, byName('תה')]) {
            const s = settings({ productNameFit, productNameMaxLines });
            const tile = layoutTile(p, tileWidth, 96, s, cache());
            const box = nameBox(tileWidth, 96);
            const room = tile.badge ? box.width - 26 : box.width;
            for (const line of tile.name.lines) expect(estimateTextWidth(line, tile.name.size)).toBeLessThanOrEqual(room);
            const most = productNameFit === 'clip' ? TILE_OWN_LINES : Math.max(TILE_OWN_LINES, productNameMaxLines);
            expect(tile.name.lines.length).toBeLessThanOrEqual(most);
            if (productNameFit !== 'fit') expect(tile.name.size).toBe(TILE_NAME_PX);
            if (!tile.name.cut) expect(tile.name.lines.join('').replace(/ /g, '')).toBe(p.name.replace(/ /g, ''));
            else expect(tile.name.lines[tile.name.lines.length - 1].endsWith('…')).toBe(true);
            // The price: whole, at most the tile's size.
            expect(tile.price.size).toBeLessThanOrEqual(16);
            expect(tile.price.text.replace(/\.00$/, '')).toBe(money(p.priceAgorot).replace(/\.00$/, ''));
          }
        }
      }
    }
  });

  it('fit shows the whole long name where clip cuts it', () => {
    const fit = layoutTile(byName(PLATTER), 160, 120, settings(), cache());
    const clip = layoutTile(byName(PLATTER), 160, 120, settings({ productNameFit: 'clip' }), cache());
    expect(fit.name.cut).toBe(false);
    expect(fit.name.size).toBeLessThan(TILE_NAME_PX);
    expect(clip.name.cut).toBe(true);
    expect(clip.name.size).toBe(TILE_NAME_PX);
  });

  it('the price is never cut: ₪1,268.50 on a narrow tile is smaller, whole', () => {
    const tile = layoutTile(byName(FEAST), 70, 96, settings(), cache());
    expect(tile.price.text).toBe('₪1,268.50');
    expect(tile.price.size).toBeLessThan(16);
    // A whole amount drops its ".00" before it gets smaller still.
    const whole = layoutTile({ ...byName(FEAST), priceAgorot: 126800 }, 66, 96, settings(), cache());
    expect(['₪1,268.00', '₪1,268']).toContain(whole.price.text);
  });

  it('the "i": auto on a description or a cut name, always, off — never while the screen is arranged', () => {
    const tea = byName('תה');
    expect(layoutTile(tea, 200, 96, settings(), cache()).badge).toBe(false);
    expect(layoutTile(byName('קרואסון שקדים'), 200, 96, settings(), cache()).badge).toBe(true);
    expect(layoutTile(LONG_EN, 90, 60, settings({ productNameFit: 'clip' }), cache()).badge).toBe(true);
    expect(layoutTile(tea, 200, 96, settings({ productInfoBadge: 'always' }), cache()).badge).toBe(true);
    expect(layoutTile(byName('קרואסון שקדים'), 200, 96, settings({ productInfoBadge: 'off' }), cache()).badge).toBe(false);
    expect(layoutTile(tea, 200, 96, settings({ productInfoBadge: 'always' }), cache(), cache(), true).badge).toBe(false);
  });

  it('worked out once per product and tile width', () => {
    const names = cache();
    const p = byName(PLATTER);
    for (let i = 0; i < 20; i++) layoutTile(p, 150, 96, settings(), names);
    expect(names.computed).toBe(2); // the name, the price
    layoutTile(p, 151, 96, settings(), names);
    expect(names.computed).toBe(4);
  });

  it('wrap grows a row to its tallest; the other modes keep the layout\'s height', () => {
    const rows = [[byName('תה'), byName(PLATTER), byName('סודה')], [byName('תה'), byName('סודה'), byName('אספרסו')]];
    const wrap = rowHeights(rows, 110, 96, settings({ productNameFit: 'wrap', productNameMaxLines: 4 }), cache());
    expect(wrap[0]).toBeGreaterThan(96);
    expect(wrap[1]).toBe(96);
    expect(rowHeights(rows, 110, 96, settings(), cache())).toEqual([96, 96]);
  });

  it('the virtualised grid with rows of their own heights', () => {
    // Rows of one height: the rows the viewport meets (530–830: rows 5–7) and one around them —
    // within what the fixed window draws.
    const same = gridWindowOf([100, 100, 100, 100, 100, 100, 100, 100, 100, 100], 530, 300, 1);
    expect(same).toEqual({ first: 4, last: 8, padTop: 424, padBottom: 106 });
    const fixed = gridWindow(10, 100, 530, 300, 1);
    expect(same.first).toBe(fixed.first);
    expect(same.last).toBeLessThanOrEqual(fixed.last);
    // Mixed heights (gap 6): rows start at 0, 106, 312, 418, 524, 830; 250–400 meets rows 1 and 2.
    const mixed = gridWindowOf([100, 200, 100, 100, 300, 100], 250, 150, 0);
    expect(mixed).toEqual({ first: 1, last: 2, padTop: 106, padBottom: 936 - 418 });
    expect(gridWindowOf([], 0, 100)).toEqual({ first: 0, last: -1, padTop: 0, padBottom: 0 });
    expect(tileWidthOf(1000, 4)).toBeCloseTo((1000 - 16 - 18) / 4);
  });
});

describe('the grid on the screen', () => {
  const render = (productText: ProductTextSettings, columns = 4, tileHeight = 120) =>
    renderToStaticMarkup(
      createElement(ProductGrid, { products: catalog.products, departments: catalog.departments, columns, tileHeight, productText, onAdd: noop, onInfo: noop, initialWidth: 900 }),
    );

  it('the "i" is a button of its own beside the tile\'s — never inside it — and the long name is whole', () => {
    const html = render(settings());
    expect(html).toContain('class="t-tile-info"');
    expect(html).not.toMatch(/<button[^>]*class="t-tile"[^>]*>(?:(?!<\/button>).)*<button/);
    expect(html).toMatch(/<\/button><button type="button" class="t-tile-info" aria-label="פרטי הפריט: פלטת גבינות זהב/);
    expect(html).toContain('₪1,268.50');
    expect(html).not.toContain('…');
    expect(html).toContain('t-tile-blocked');
    expect(html).toContain('>אזל<');
  });

  it('off: no "i" anywhere; wrap: taller rows', () => {
    expect(render(settings({ productInfoBadge: 'off' }))).not.toContain('t-tile-info');
    const wrap = render(settings({ productNameFit: 'wrap', productNameMaxLines: 4 }), 6, 96);
    const heights = [...wrap.matchAll(/class="t-grid-row" style="[^"]*height:(\d+)px/g)].map((m) => Number(m[1]));
    expect(Math.min(...heights)).toBe(96);
    expect(Math.max(...heights)).toBeGreaterThan(96);
  });

  it('the sell screen draws the engine\'s settings (an older engine without them: the defaults)', () => {
    const layout = tillLayout(displayProfile(browserFacts(1280, 800, 1)));
    const base = initialState({ role: 'till', rolesAllowed: [], terminal: false, printer: false, catalogVersion: 1, nowIso: '2026-10-14T12:00:00.000Z' });
    expect(base.display?.productText).toEqual(PRODUCT_TEXT_DEFAULTS);
    const older: TillState = { ...base, display: undefined };
    expect(displayProductText(older.display)).toEqual(PRODUCT_TEXT_DEFAULTS);
    const html = renderToStaticMarkup(
      createElement(SellScreen, { state: older, catalog, layout, onAdd: noop, onDepartment: noop, onSearch: noop, cart: { setQty: noop, discount: noop, remove: noop, clear: noop, pay: noop } }),
    );
    expect(html).toContain('t-tile');
  });
});

describe('the item\'s details', () => {
  const render = (p: Product, sheet = false) =>
    renderToStaticMarkup(createElement(ProductInfo, { product: p, department: catalog.departments.find((d) => d.id === p.departmentId) ?? null, sheet, onAdd: noop, onClose: noop }));

  it('show the full name, the department, the description, the price range and sizes, the dietary words, the allergens and "הוסף לסל"', () => {
    const html = render(byName('הפוך גדול'));
    expect(html).toContain('הפוך גדול');
    expect(html).toContain('שתייה חמה');
    expect(html).toContain('אספרסו כפול עם חלב מוקצף');
    expect(html).toContain('טווח מחירים');
    expect(html).toContain('₪16.00–₪19.00');
    expect(html).toContain('חלב שקדים');
    expect(html).toContain('צמחוני');
    expect(html).toContain('חלבי');
    expect(html).toContain('אלרגנים');
    expect(html).toContain('הוסף לסל');
    expect(html).toContain('t-info-window');
  });

  it('a blocked item says why; no description says so; a phone gets a bottom sheet', () => {
    const blocked = render(byName('בייגל סלמון'), true);
    expect(blocked).toContain('אזל · נגמר הסלמון להיום');
    expect(blocked).toContain('t-info-sheet');
    expect(blocked).toContain('דגים');
    expect(render(byName('תה'))).toContain('אין תיאור לפריט.');
    expect(render(byName(PLATTER))).toContain(PLATTER);
  });
});

describe('"הוסף לסל" is the tile\'s own tap', () => {
  it('sell.add from the details adds, and a blocked item is refused by the engine as for a tap', async () => {
    const engine = new MockTillEngine({ now: () => Date.UTC(2026, 9, 14, 12), schedule: () => undefined });
    let id = 0;
    const call = (op: 'sell.add', args: unknown) => {
      id += 1;
      return engine.call({ id, op, args, clientOpId: MUTATING_OPS.has(op) ? `op-${id}` : undefined });
    };
    const ok = await call('sell.add', { productId: byName(PLATTER).id });
    expect(ok.ok).toBe(true);
    const refused = await call('sell.add', { productId: byName('בייגל סלמון').id });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe('product_unavailable');
      expect(refused.error.message).toBe(TILL_ERRORS.product_unavailable);
    }
    expect((engine.snapshot() as TillState).sell.lines.map((l) => l.name)).toEqual([PLATTER]);
  });

  it('the engine sends the four it was given (the design\'s `look` over the till parameters)', () => {
    const engine = new MockTillEngine({ productText: { productNameFit: 'wrap', productInfoBadge: 'always' } });
    expect((engine.snapshot() as TillState).display?.productText).toEqual({ ...PRODUCT_TEXT_DEFAULTS, productNameFit: 'wrap', productInfoBadge: 'always' });
  });
});
