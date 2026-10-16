/**
 * "עיצוב לרוחב" on the Windows kiosk (P:/specs/kiosk-landscape-design.md): the shared rules it draws with
 * (client/src/lib/kioskLandscape.ts through @dash-lib) against its own copy of the golden fixture — the same
 * bytes as pos-server's and pos-android's (SHA pinned in all three) — and its page zoom: the Windows kiosk's
 * 960 CSS px across a 1920 dip screen (×2) keeps the dp the golden pins.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyLandscape,
  categoryColumnDp,
  categoryImageDp,
  categoryItemDp,
  LANDSCAPE_SIZE_DEFAULTS,
  landscapeLook,
  landscapeProductColumns,
  landscapeTextScale,
  landscapeTileDp,
  lookColumns,
  productImageDp,
  resolveLandscapeSizes,
  type LandscapeDisplay,
} from '@dash-lib/kioskLandscape';

const text = readFileSync(path.join(__dirname, 'fixtures', 'kiosk_landscape_golden.json'), 'utf8');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const golden: any = JSON.parse(text);
const sized = (s: Record<string, number>) => resolveLandscapeSizes({ sizes: s });

describe('kiosk landscape design — the shared golden', () => {
  it("is the same bytes as the server's and the till's", () => {
    expect(createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex')).toBe(
      '4bb0c99e5398d36f5a6f46bcbc4c2ce8fddeeb4f6d3c7eb4ba64ed6f35a5fb3e',
    );
  });

  it('every rule', () => {
    expect(golden.sizes.defaults).toEqual(LANDSCAPE_SIZE_DEFAULTS);
    for (const c of golden.resolveSizes) expect(resolveLandscapeSizes(c.block), c.name).toEqual(c.expect);
    for (const c of golden.productColumns) expect(landscapeProductColumns(c.columns, c.gridDp, sized(c.sizes))).toBe(c.expect);
    for (const c of golden.categoryColumn) expect(categoryColumnDp(c.widthDp, sized(c.sizes))).toBe(c.expect);
    for (const c of golden.categoryItem) expect(categoryItemDp(c.computedDp, sized(c.sizes))).toBe(c.expect);
    for (const c of golden.categoryImage) expect(categoryImageDp(c.computedDp, sized(c.sizes))).toBe(c.expect);
    for (const c of golden.productImage) expect(productImageDp(c.computedDp, sized(c.sizes))).toBe(c.expect);
    for (const c of golden.textScale) expect(landscapeTextScale(c.displayScale, sized(c.sizes))).toBe(c.expect);
  });

  it('the design as drawn', () => {
    for (const c of golden.apply) {
      const out = applyLandscape(c.config, c.display as LandscapeDisplay);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cfg = out.config as any;
      expect({ theme: cfg.theme, layout: cfg.layout, attract: cfg.attract, explicit: out.explicit }, c.name).toEqual(c.expect);
    }
  });

  it("the owner's screens at the Windows kiosk's zoom: the golden's columns, tiles never over the cap", () => {
    for (const s of golden.screens) {
      // The Windows kiosk lays out ~960 CSS px across a landscape screen: cssPerDp = 960 / widthDp.
      const cssPerDp = 960 / s.widthDp;
      const display = { landscape: true, sideCart: s.expect.sideCart, rail: s.expect.rail };
      const look = landscapeLook({}, display, 960, cssPerDp)!;
      const gridPx = s.expect.gridDp * cssPerDp;
      const cols = lookColumns(look, s.layoutColumns, gridPx);
      expect(cols, s.name).toBe(s.expect.columns);
      expect(landscapeTileDp(cols, s.expect.gridDp)).toBeLessThanOrEqual(LANDSCAPE_SIZE_DEFAULTS.productTileMaxDp);
    }
  });
});
