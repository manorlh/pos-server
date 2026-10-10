import { describe, expect, it } from 'vitest';
import {
  BAND_ROWS,
  centreOn,
  CUT,
  INIT,
  isBlack,
  job,
  parseStatus,
  rasterBands,
  receiptContentWidth,
  toMono,
  trimBottom,
  validStatusByte,
} from '../src/core/escpos';

/** An RGBA page `w`×`h` filled white with black pixels where `black(x, y)`. */
function page(w: number, h: number, black: (x: number, y: number) => boolean): Uint8Array {
  const a = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const v = black(x, y) ? 0 : 255;
      a[i] = a[i + 1] = a[i + 2] = v;
      a[i + 3] = 255;
    }
  return a;
}

describe('the till threshold (EscPos.isBlack)', () => {
  it('is black only when opaque enough and darker than mid-grey', () => {
    expect(isBlack(0, 0, 0, 255)).toBe(true);
    expect(isBlack(255, 255, 255, 255)).toBe(false);
    expect(isBlack(0, 0, 0, 127)).toBe(false); // transparent is paper
    expect(isBlack(127, 127, 127, 255)).toBe(true);
    expect(isBlack(128, 128, 128, 255)).toBe(false);
    // Luminance weights 299/587/114: pure red is dark enough, pure green is not.
    expect(isBlack(255, 0, 0, 255)).toBe(true);
    expect(isBlack(0, 255, 0, 255)).toBe(false);
  });
});

describe('toMono', () => {
  it('packs rows MSB-first, 1 = print', () => {
    const m = toMono(page(10, 2, (x, y) => (y === 0 ? x === 0 || x === 9 : x === 8)), 10, 2);
    expect(m.rowBytes).toBe(2);
    expect([...m.data]).toEqual([0b10000000, 0b01000000, 0b00000000, 0b10000000]);
  });

  it('refuses a short buffer', () => {
    expect(() => toMono(new Uint8Array(4), 2, 2)).toThrow();
  });
});

describe('centreOn', () => {
  it('centres the 540-dot receipt on the 576-dot raster (18 white dots each side)', () => {
    expect(receiptContentWidth(576)).toBe(540);
    const m = centreOn(toMono(page(540, 1, (x) => x === 0 || x === 539), 540, 1), 576);
    expect(m.width).toBe(576);
    expect(m.rowBytes).toBe(72);
    const on = (x: number) => (m.data[x >> 3] & (0x80 >> (x & 7))) !== 0;
    expect(on(17)).toBe(false);
    expect(on(18)).toBe(true);
    expect(on(18 + 539)).toBe(true);
    expect(on(575)).toBe(false);
  });
});

describe('GS v 0 bands', () => {
  it('splits a page into bands of 256 rows with the right headers', () => {
    const m = centreOn(toMono(page(576, 600, () => false), 576, 600));
    const bands = rasterBands(m);
    expect(bands.map((b) => b.length)).toEqual([8 + 256 * 72, 8 + 256 * 72, 8 + 88 * 72]);
    expect([...bands[0].subarray(0, 8)]).toEqual([0x1d, 0x76, 0x30, 0x00, 72, 0, 0, 1]);
    expect([...bands[2].subarray(0, 8)]).toEqual([0x1d, 0x76, 0x30, 0x00, 72, 0, 88, 0]);
    expect(BAND_ROWS).toBe(256);
  });
});

describe('a job', () => {
  it('is INIT, the raster, ESC d 3 and the partial cut GS V 66 0', () => {
    const m = centreOn(toMono(page(8, 1, () => true), 8, 1));
    const bytes = job(m);
    expect([...bytes.subarray(0, 2)]).toEqual([...INIT]);
    expect([...bytes.subarray(2, 10)]).toEqual([0x1d, 0x76, 0x30, 0x00, 72, 0, 1, 0]);
    expect([...bytes.subarray(bytes.length - 7)]).toEqual([0x1b, 0x64, 3, ...CUT]);
  });

  it('feeds 6 lines and does not cut without a cutter', () => {
    const bytes = job(centreOn(toMono(page(8, 1, () => false), 8, 1)), { cut: false });
    expect([...bytes.subarray(bytes.length - 3)]).toEqual([0x1b, 0x64, 6]);
  });

  it('drops white rows at the bottom, never a row with ink', () => {
    const m = toMono(page(8, 100, (_x, y) => y === 10), 8, 100);
    expect(trimBottom(m, 5).height).toBe(16);
    expect(trimBottom(m, 0).height).toBe(11);
  });
});

describe('DLE EOT status', () => {
  it('reads the fixed bits, paper out / near end, offline and cover', () => {
    expect(validStatusByte(0x12)).toBe(true);
    expect(validStatusByte(0x00)).toBe(false);
    expect(parseStatus(0x12, 0x12, 0x12)).toMatchObject({ valid: true, offline: false, paper: 'ok', coverOpen: false });
    expect(parseStatus(0x1a, null, null).offline).toBe(true);
    expect(parseStatus(null, null, 0x72).paper).toBe('out');
    expect(parseStatus(null, null, 0x1e).paper).toBe('near_end');
    expect(parseStatus(null, 0x16, null).coverOpen).toBe(true);
    expect(parseStatus(null, null, null).valid).toBe(false);
  });
});
