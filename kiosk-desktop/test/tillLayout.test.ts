/**
 * S0-2: the till's layout from the display profile (kiosk-landscape spec §2, §6; web-till spec
 * §6.10). The adapter rows are the browser cases of display_profiles_golden.json (§2.7: in a
 * browser the physical size is never known) — TODO(kiosk-landscape): drop them when the shared
 * golden file lands.
 */
import { describe, expect, it } from 'vitest';
import { bigBasketWidthDp, browserFacts, displayProfile, tillLayoutOf } from '../src/renderer/roles/till/layout/displayProfileAdapter';
import { productColumnsFor, sideBasketWidthDp, tillLayout } from '../src/renderer/roles/till/layout/tillLayout';
import { gridWindow } from '../src/renderer/roles/till/parts/ProductGrid';
import { money, quickCash } from '../src/renderer/roles/till/text';
import { parseAmount } from '../src/renderer/roles/till/screens/ShiftScreen';

const p = (w: number, h: number, dpr = 1) => displayProfile(browserFacts(w, h, dpr));

describe('the display profile adapter (browser facts)', () => {
  it('HDMI 1920×1080 at ratio 1: S13, scale 1, a tablet till', () => {
    const d = p(1920, 1080);
    expect(d).toMatchObject({ sizeClass: '13', scale: 1, widthDp: 1920, heightDp: 1080, physicalTrusted: false, landscape: true });
    expect(tillLayoutOf(d)).toBe('TABLET');
  });

  it('4K at ratio 1: S27, scaled ×2 to 1920×1080 dp, a big till', () => {
    const d = p(3840, 2160);
    expect(d).toMatchObject({ sizeClass: '27', scale: 2, widthDp: 1920, heightDp: 1080 });
    expect(tillLayoutOf(d)).toBe('BIG');
  });

  it('1280×800: S11, a tablet', () => {
    expect(p(1280, 800)).toMatchObject({ sizeClass: '11', scale: 1 });
    expect(tillLayoutOf(p(1280, 800))).toBe('TABLET');
  });

  it('a phone (390×844 at ×3): handheld', () => {
    const d = p(390, 844, 3);
    expect(d).toMatchObject({ sizeClass: 'handheld', widthDp: 390, heightDp: 844 });
    expect(tillLayoutOf(d)).toBe('HANDHELD');
  });

  it('4K at ratio 1.5 (2560×1440 CSS px): S15, scaled to behave like FHD, a big till', () => {
    const d = p(2560, 1440, 1.5);
    expect(d).toMatchObject({ sizeClass: '15', scale: 1.33, widthDp: 1924, heightDp: 1082 });
    expect(tillLayoutOf(d)).toBe('BIG');
  });

  it('the big basket: clamp(0.28 × w, 420, 560)', () => {
    expect(bigBasketWidthDp(1400)).toBe(420);
    expect(bigBasketWidthDp(1920)).toBe(538);
    expect(bigBasketWidthDp(2600)).toBe(560);
  });
});

describe('the till layout', () => {
  it('a phone: one pane, the cart behind a bar, 3 columns of the medium tile', () => {
    const l = tillLayout(p(390, 844, 3));
    expect(l).toMatchObject({ cls: 'HANDHELD', panes: 'single', cartWidthDp: 0, columns: 3, checkoutMaxWidthDp: null });
  });

  it('a tablet landscape: side by side, the cart 30% within 340–440', () => {
    const l = tillLayout(p(1280, 800));
    expect(l.panes).toBe('side');
    expect(l.cartWidthDp).toBe(sideBasketWidthDp(1280));
    expect(l.cartWidthDp).toBe(384);
    expect(l.columns).toBe(productColumnsFor(1280 - 384, 200));
    expect(l.checkoutMaxWidthDp).toBe(720);
  });

  it('a tablet upright 800×1280: the cart under the products (38%)', () => {
    const l = tillLayout(p(800, 1280));
    expect(l).toMatchObject({ cls: 'TABLET', panes: 'stacked', cartWidthDp: 0, cartHeightFraction: 0.38 });
  });

  it('a small tablet 600×800: one pane', () => {
    expect(tillLayout(p(600, 800)).panes).toBe('single');
  });

  it('big: the wider cart, larger tiles, payment centred to 1100, reports to 960 in two columns from 1400', () => {
    const l = tillLayout(p(3840, 2160));
    expect(l).toMatchObject({ cls: 'BIG', panes: 'side', cartWidthDp: 538, checkoutMaxWidthDp: 1100, reportMaxWidthDp: 960, reportTwoColumns: true });
    expect(l.columns).toBe(productColumnsFor(1920 - 538, 240));
    expect(l.touchMinDp).toBe(48);
  });

  it('big upright: stacked, the cart 34%', () => {
    const l = tillLayout(p(2160, 3840));
    expect(l).toMatchObject({ cls: 'BIG', panes: 'stacked', cartHeightFraction: 0.34 });
  });

  it('columns stay 2..8', () => {
    expect(productColumnsFor(700, 270)).toBe(2);
    expect(productColumnsFor(4000, 110)).toBe(8);
  });
});

describe('the virtualised grid', () => {
  it('draws only the rows on screen and a few around', () => {
    const w = gridWindow(100, 94, 0, 600);
    expect(w.first).toBe(0);
    expect(w.last).toBe(9);
    expect(w.padTop).toBe(0);
    expect(w.padBottom).toBe((99 - 9) * 100);
    const mid = gridWindow(100, 94, 5000, 600);
    expect(mid.first).toBe(47);
    expect(mid.last).toBe(59);
    expect(mid.padTop).toBe(4700);
    expect(gridWindow(0, 94, 0, 600)).toEqual({ first: 0, last: -1, padTop: 0, padBottom: 0 });
  });
});

describe('money and amounts', () => {
  it('formats agorot', () => {
    expect(money(0)).toBe('₪0.00');
    expect(money(1290)).toBe('₪12.90');
    expect(money(123456789)).toBe('₪1,234,567.89');
    expect(money(-505)).toBe('-₪5.05');
  });

  it('offers the likely notes above the amount due', () => {
    expect(quickCash(1290)).toEqual([2000, 5000, 10000]);
    expect(quickCash(5000)).toEqual([6000, 10000, 20000]);
    expect(quickCash(0)).toEqual([]);
  });

  it('parses a typed amount', () => {
    expect(parseAmount('123.4')).toBe(12340);
    expect(parseAmount('₪1,200')).toBe(120000);
    expect(parseAmount('0')).toBe(0);
    expect(parseAmount('1.234')).toBeNull();
    expect(parseAmount('abc')).toBeNull();
  });
});
