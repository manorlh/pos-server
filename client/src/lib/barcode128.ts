/**
 * Code 128 (subset B) — the line barcode a prepaid voucher ("שובר הפקה") can carry instead of
 * its QR, for 1D laser scanners (pos-server docs/SPEC_VOUCHER_PRODUCTION.md).
 *
 * The same table as the server's `app/services/barcode128.py`; both are pinned by the same
 * expected widths in their tests, so a voucher printed from the browser and one drawn into
 * the server's PDF carry the same bars.
 */

/** Bar / space widths of the 107 symbols (values 0–105 and the stop), bar first. */
export const CODE128_PATTERNS: readonly string[] = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
];

const START_B = 104;
const STOP = 106;
/** The light margin each side, in modules. */
export const CODE128_QUIET_ZONE = 10;

/** Symbol values of [text] in subset B: start, data, checksum, stop. Throws outside printable ASCII. */
export function code128Values(text: string): number[] {
  if (!text) throw new Error('empty');
  const data: number[] = [];
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 32 || code > 126) throw new Error(`not in subset B: ${ch}`);
    data.push(code - 32);
  }
  const checksum = data.reduce((sum, v, i) => sum + (i + 1) * v, START_B) % 103;
  return [START_B, ...data, checksum, STOP];
}

/** Bar / space widths of the whole symbol, bar first, without the quiet zones. */
export function code128Widths(text: string): string {
  return code128Values(text).map((v) => CODE128_PATTERNS[v]).join('');
}

/** The bars as [x, width] in modules, quiet zone included at the left; and the total width. */
export function code128Bars(text: string): { bars: [number, number][]; width: number } {
  const bars: [number, number][] = [];
  let x = CODE128_QUIET_ZONE;
  let bar = true;
  for (const ch of code128Widths(text)) {
    const w = Number(ch);
    if (bar) bars.push([x, w]);
    x += w;
    bar = !bar;
  }
  return { bars, width: x + CODE128_QUIET_ZONE };
}
