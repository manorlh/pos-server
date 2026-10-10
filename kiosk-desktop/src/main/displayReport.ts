/**
 * "שיתאים את עצמו" (P:/specs/kiosk-landscape-till-mode.md §2): the Windows screen as the cloud's fleet view hears
 * it (`status.display`). The primary display's size in device-independent pixels is read as dp and its scale
 * gives the pixels; Windows never reports a believable physical size, so the dp buckets decide — the same
 * rules as the Android kiosk and the web (client/src/lib/displayProfile.ts).
 */
import { browserFacts, displayProfile } from '@dash-lib/displayProfile';

export function windowsDisplayReport(dipWidth: number, dipHeight: number, scaleFactor: number): Record<string, unknown> | null {
  if (!(dipWidth > 0) || !(dipHeight > 0)) return null;
  const p = displayProfile(browserFacts(dipWidth, dipHeight, scaleFactor > 0 ? scaleFactor : 1));
  return {
    orientation: p.landscape ? 'landscape' : 'portrait',
    sizeClass: p.sizeClass,
    diagonalInches: p.diagonalInches,
    physical: false,
    scale: p.scale,
    widthDp: p.widthDp,
    heightDp: p.heightDp,
  };
}
