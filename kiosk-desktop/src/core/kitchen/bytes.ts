/**
 * A kitchen ticket's ESC/POS, as the Android till sends it to a kitchen printer (pos-android hardware/kitchen/EscPos.kt
 * `rasterWidthOf` / `contentWidthOf` / `centred`, KitchenTicketJob.kt): the ticket is one picture — Hebrew prints right
 * on any ESC/POS printer whatever its code pages.
 *
 *  - the raster is exactly what the head prints across ("רוחב הדפסה", else by the paper: 58 → 384, 80 → 576 dots);
 *  - the ticket is drawn at the paper's width at most, and centred on the raster;
 *  - INIT, the picture in short `GS v 0` bands (64 rows: the paper moves as soon as the first is in), the design's feed
 *    lines before the cut ("שורות הזנה לפני החיתוך", 0–6) and the cut — or 3 lines more past the tear bar without a
 *    cutter — then the buzzer when the printer asks for it.
 *
 * Pure.
 */

import { BEEP, centreOn, concat, CUT, feed, INIT, rasterBands, type MonoBitmap } from '../escpos';

/** The print widths a printer can be set to ("רוחב הדפסה"), widest first. */
export const PRINT_WIDTHS = [576, 512, 432, 384] as const;
/** Bands for a printer of its own: a short first band starts the paper at once (fix/print-latency). */
export const STREAM_BAND_ROWS = 64;
/** What the old ticket fed before the cut (EscPos.job). */
export const DEFAULT_FEED_LINES = 3;
const TEAR_EXTRA = 3;

export function dotsForPaper(paperWidthMm: number): number {
  return paperWidthMm >= 80 ? 576 : 384;
}

/** The raster's width: the printer's "רוחב הדפסה" when set, else by the paper. Whole bytes, 8..576. */
export function rasterWidthOf(paperWidthMm: number, printWidthDots: number | null | undefined): number {
  const dots = printWidthDots && printWidthDots > 0 ? printWidthDots : dotsForPaper(paperWidthMm);
  return Math.floor(Math.max(8, Math.min(576, dots)) / 8) * 8;
}

/** How wide the ticket is drawn: the raster, never wider than the paper (58 mm paper in an 80 mm printer: 384). */
export function contentWidthOf(paperWidthMm: number, printWidthDots: number | null | undefined): number {
  return Math.min(rasterWidthOf(paperWidthMm, printWidthDots), dotsForPaper(paperWidthMm));
}

/** The design engine's paper: 58 or 80 mm. */
export function paperOf(paperWidthMm: number): 58 | 80 {
  return paperWidthMm >= 80 ? 80 : 58;
}

export interface TicketJobOptions {
  cut: boolean;
  beep: boolean;
  /** The design's feed before the cut (0–6). */
  feedLines: number;
  bandRows?: number;
}

/** One printed copy's bytes (KitchenTicketJob.bytes): INIT, the bands, the feed and the cut, the buzzer. */
export function ticketJobBytes(page: MonoBitmap, rasterWidth: number, o: TicketJobOptions): Uint8Array {
  const centred = centreOn(page, rasterWidth);
  const n = Math.max(0, Math.min(6, Math.trunc(o.feedLines)));
  const parts: Uint8Array[] = [INIT, ...rasterBands(centred, o.bandRows ?? STREAM_BAND_ROWS)];
  if (o.cut) parts.push(feed(n), CUT);
  else parts.push(feed(n + TEAR_EXTRA));
  if (o.beep) parts.push(BEEP);
  return concat(parts);
}
