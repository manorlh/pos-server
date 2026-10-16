/**
 * The layout audit (P:/specs/layout-audit-1610/README.md, scripts/layout-audit): the Windows kiosk's page zoom, the
 * matrix as each host sees it, and the checker's own rules — pinned, so a later change to any of them is a decision.
 */
import { describe, expect, it } from 'vitest';
import { KIOSK_LANDSCAPE_MIN_CSS_HEIGHT, kioskWindowZoom } from '../src/core/windowZoom';
// @ts-expect-error — plain .mjs tooling (no types)
import { blendOver, contrastRatio, gradientStops, inkBox, intersect, largeText, MIN_TARGET_MM, parseColor, targetDp, targetMm } from '../scripts/layout-audit/checker.mjs';
// @ts-expect-error — plain .mjs tooling (no types)
import { casesFor, distinctRenders, hostCase, loadMatrix, orientationsOf } from '../scripts/layout-audit/matrix.mjs';

describe('the Windows kiosk window zoom', () => {
  it('draws ~540 CSS px across the short side, upright and square as before', () => {
    expect(kioskWindowZoom(1080, 1920)).toBe(2);
    expect(kioskWindowZoom(1080, 1080)).toBe(2);
    expect(kioskWindowZoom(400, 700)).toBe(1); // never under 1
    expect(kioskWindowZoom(4000, 4000)).toBe(3); // never over 3
    expect(kioskWindowZoom(1920, 1080, 1.25)).toBe(1.25); // the technician's zoom wins
  });

  it('keeps a landscape window at least 600 CSS px tall (the owner\'s 14" laptop at 125%: 1536×864)', () => {
    const z = kioskWindowZoom(1536, 864);
    expect(z).toBeCloseTo(1.44, 5);
    expect(864 / z).toBeCloseTo(KIOSK_LANDSCAPE_MIN_CSS_HEIGHT, 5);
    // 1920×1080 at 100%: 1067×600 CSS px (was 960×540).
    expect(Math.round(1080 / kioskWindowZoom(1920, 1080))).toBe(600);
    // A short landscape window under 600 DIP stays at ×1.
    expect(kioskWindowZoom(1280, 533)).toBe(1);
  });
});

describe('the matrix as each host sees it', () => {
  const m = loadMatrix();

  it('has every panel the owner asked for, the squares and 720×1024, and the 14" laptop', () => {
    const ids = m.screens.map((s: { id: string }) => s.id);
    for (const id of ['10.1in-1280x800', '10.1in-1920x1200', '11in-2000x1200', '13.3in-1920x1080', '15.6in-1366x768', '15.6in-1920x1080', '17in-1280x1024', '21.5in-1920x1080', '24in-1920x1080', '27in-2560x1440', '27in-3840x2160', '32in-1920x1080', '32in-3840x2160', '1024x720', 'square-720', 'square-1024', 'square-1080', '14in-1920x1080']) {
      expect(ids).toContain(id);
    }
    expect(m.scales).toEqual([1, 1.25, 1.5]);
  });

  it('turns the kiosk either way, the till only where it turns, a square never', () => {
    const square = m.screens.find((s: { id: string }) => s.id === 'square-1080');
    const big = m.screens.find((s: { id: string }) => s.id === '24in-1920x1080');
    const tab = m.screens.find((s: { id: string }) => s.id === '10.1in-1280x800');
    expect(orientationsOf(square, 'win-kiosk').map((o: { orientation: string }) => o.orientation)).toEqual(['square']);
    expect(orientationsOf(big, 'win-kiosk')).toHaveLength(2);
    expect(orientationsOf(big, 'win-till')).toHaveLength(1);
    expect(orientationsOf(tab, 'win-till')).toHaveLength(2);
  });

  it('derives the 14" laptop at 125% exactly as the apps do', () => {
    const laptop = m.screens.find((s: { id: string }) => s.id === '14in-1920x1080');
    const land = orientationsOf(laptop, 'win-kiosk')[0];
    const kiosk = hostCase('win-kiosk', laptop, land, 1.25);
    expect([kiosk.outerWidth, kiosk.outerHeight]).toEqual([1536, 864]);
    expect([kiosk.cssWidth, kiosk.cssHeight]).toEqual([1067, 600]);
    expect(kiosk.display.sideCart).toBe(true);
    const till = hostCase('win-till', laptop, land, 1.25);
    expect([till.cssWidth, till.cssHeight, till.profileScale, till.tillLayout]).toEqual([1536, 864, 1, 'TABLET']);
  });

  it('renders each distinct layout once and keeps the cases it stands for', () => {
    const cases = casesFor('win-till');
    const renders = distinctRenders(cases);
    expect(renders.length).toBeLessThan(cases.length);
    expect(renders.reduce((n: number, r: { covers: string[] }) => n + r.covers.length, 0)).toBe(cases.length);
  });
});

describe("the checker's rules", () => {
  it('reads the colours Chromium gives, Tailwind 4\'s oklch too', () => {
    expect(parseColor('rgb(255, 255, 255)')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor('rgba(0, 0, 0, 0.5)')).toEqual({ r: 0, g: 0, b: 0, a: 0.5 });
    const red = parseColor('oklch(0.577 0.245 27.325)'); // Tailwind 4's red-600, #e7000b
    expect(Math.round(red.r)).toBe(231);
    expect(Math.round(red.g)).toBe(0);
    expect(gradientStops('linear-gradient(135deg, rgb(31, 111, 235), rgb(22, 163, 74))')).toHaveLength(2);
  });

  it('computes WCAG contrast over what is painted below', () => {
    expect(contrastRatio({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 })).toBeCloseTo(21, 5);
    // #6B7280 on #F5F6F8 — the kiosk's muted words before the audit: 4.47:1.
    expect(contrastRatio(parseColor('#6B7280'), parseColor('#F5F6F8'))).toBeLessThan(4.5);
    expect(contrastRatio(parseColor('#646B76'), parseColor('#F5F6F8'))).toBeGreaterThan(4.5);
    const half = blendOver({ r: 0, g: 0, b: 0, a: 0.5 }, { r: 255, g: 255, b: 255, a: 1 });
    expect(Math.round(half.r)).toBe(128);
    expect(largeText(24, 400)).toBe(true);
    expect(largeText(19, 700)).toBe(true);
    expect(largeText(18, 700)).toBe(false);
  });

  it('measures touch targets at the app scale and on the panel', () => {
    expect(targetDp(24, 2)).toBe(48);
    expect(MIN_TARGET_MM).toBeCloseTo(7.62, 2);
    // 10.1" 1280×800 at the kiosk's ×1.48: 0.2517 mm a CSS px — a 24 px option row was 6 mm.
    expect(targetMm(24, 0.2517)).toBeLessThan(MIN_TARGET_MM);
    expect(targetMm(34, 0.2517)).toBeGreaterThan(MIN_TARGET_MM);
  });

  it('compares the glyph bands of two lines, not their line boxes', () => {
    const a = { left: 0, right: 100, top: 0, bottom: 60, width: 100, height: 60 };
    const b = { left: 0, right: 100, top: 52, bottom: 70, width: 100, height: 18 };
    expect(intersect(a, b)).not.toBeNull();
    expect(intersect(inkBox(a), inkBox(b))).toBeNull();
  });
});
