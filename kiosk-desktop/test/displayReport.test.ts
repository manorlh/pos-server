import { describe, expect, it } from 'vitest';
import { windowsDisplayReport } from '../src/main/displayReport';

/**
 * "שיתאים את עצמו" (P:/specs/kiosk-landscape-till-mode.md §2): the Windows screen as the cloud's fleet view
 * hears it — the primary display's DIPs as dp, its scale for the pixels, never a physical claim.
 */
describe('the Windows display report', () => {
  it('a full-HD screen at 100%: landscape, as its DIPs say', () => {
    expect(windowsDisplayReport(1920, 1080, 1)).toEqual({
      orientation: 'landscape', sizeClass: '13', diagonalInches: 13.8, physical: false, scale: 1, widthDp: 1920, heightDp: 1080,
    });
  });

  it('a 4K screen at 150% (2560×1440 DIPs): never a guess at its inches, laid out about full HD', () => {
    const r = windowsDisplayReport(2560, 1440, 1.5)!;
    expect(r.physical).toBe(false);
    // A shorter side of 1440 dp or more is a hi-res screen: the dp buckets scale it to 1080 (§2.4).
    expect([r.widthDp, r.heightDp, r.scale]).toEqual([1924, 1082, 1.33]);
  });

  it('a portrait kiosk screen, and nothing for a display that reports no size', () => {
    expect(windowsDisplayReport(1080, 1920, 1)!.orientation).toBe('portrait');
    expect(windowsDisplayReport(0, 0, 1)).toBeNull();
  });
});
