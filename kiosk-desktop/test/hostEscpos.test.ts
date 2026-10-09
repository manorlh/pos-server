/**
 * S0-5: the host layer's ESC/POS helpers (src/renderer/host/escpos.ts) are a PORT of the Windows
 * kiosk's (src/core/escpos.ts, which follows the APK's EscPos.kt). They must give the same bytes,
 * byte for byte, for the same input — pinned here over a seeded corpus until W/core's copy moves
 * to the engine (spec decision 8).
 */
import { describe, expect, it } from 'vitest';
import * as core from '../src/core/escpos';
import * as host from '../src/renderer/host/escpos';

/** A small deterministic PRNG (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rgbaPage(w: number, h: number, r: () => number): Uint8Array {
  const a = new Uint8Array(w * h * 4);
  for (let i = 0; i < a.length; i++) a[i] = Math.floor(r() * 256);
  return a;
}

const SIZES: Array<[number, number]> = [
  [1, 1],
  [7, 3],
  [8, 8],
  [9, 300],
  [384, 40],
  [540, 513],
  [576, 256],
  [576, 257],
  [600, 20],
];

describe('host ESC/POS = W/core ESC/POS (byte parity)', () => {
  it('has the same commands and constants', () => {
    expect(host.INIT).toEqual(core.INIT);
    expect(host.CUT).toEqual(core.CUT);
    expect(host.BEEP).toEqual(core.BEEP);
    expect(host.DRAWER_KICK).toEqual(core.DRAWER_KICK);
    expect(host.RASTER_80MM).toBe(core.RASTER_80MM);
    expect(host.BAND_ROWS).toBe(core.BAND_ROWS);
    expect([host.STATUS_PRINTER, host.STATUS_OFFLINE, host.STATUS_ERROR, host.STATUS_PAPER]).toEqual([core.STATUS_PRINTER, core.STATUS_OFFLINE, core.STATUS_ERROR, core.STATUS_PAPER]);
    for (const n of [-5, 0, 1, 3, 6, 255, 256, 2.7]) expect(host.feed(n)).toEqual(core.feed(n));
  });

  it('thresholds every pixel the same way', () => {
    const r = rng(1);
    for (let i = 0; i < 20_000; i++) {
      const [R, G, B, A] = [0, 0, 0, 0].map(() => Math.floor(r() * 256));
      expect(host.isBlack(R, G, B, A)).toBe(core.isBlack(R, G, B, A));
    }
  });

  it('gives the same picture, bands, job and trims over a seeded corpus', () => {
    const r = rng(42);
    for (const [w, h] of SIZES) {
      const rgba = rgbaPage(w, h, r);
      const a = core.toMono(rgba, w, h);
      const b = host.toMono(rgba, w, h);
      expect(b).toEqual(a);
      for (const raster of [384, 576, 580]) expect(host.centreOn(b, raster)).toEqual(core.centreOn(a, raster));
      expect(host.rasterBands(b)).toEqual(core.rasterBands(a));
      expect(host.rasterBands(b, 64)).toEqual(core.rasterBands(a, 64));
      for (const opts of [{}, { cut: false }, { beep: true }, { cut: false, beep: true }]) expect(host.job(b, opts)).toEqual(core.job(a, opts));
      expect(host.trimBottom(b)).toEqual(core.trimBottom(a));
      expect(host.trimBottom(b, 0)).toEqual(core.trimBottom(a, 0));
    }
  });

  it('trims a page with a white bottom the same way', () => {
    const w = 64;
    const h = 100;
    const rgba = new Uint8Array(w * h * 4).fill(255);
    for (let y = 10; y < 20; y++) for (let x = 0; x < w; x++) rgba.fill(0, (y * w + x) * 4, (y * w + x) * 4 + 3);
    const a = core.trimBottom(core.toMono(rgba, w, h));
    expect(host.trimBottom(host.toMono(rgba, w, h))).toEqual(a);
    expect(a.height).toBe(28);
  });

  it('reads printer status the same way, for every byte', () => {
    const vals: Array<number | null> = [null, 0x12, 0x16, 0x1a, 0x1e, 0x32, 0x52, 0x72, 0x7e, 0x93, 0xff];
    for (let b = 0; b < 256; b++) expect(host.validStatusByte(b)).toBe(core.validStatusByte(b));
    for (const p of vals) for (const o of vals) for (const q of vals) expect(host.parseStatus(p, o, q)).toEqual(core.parseStatus(p, o, q));
    for (let b = 0; b < 256; b++) expect(host.parseStatus(null, null, b)).toEqual(core.parseStatus(null, null, b));
  });

  it('keeps the content width', () => {
    for (const w of [384, 576, 832]) expect(host.receiptContentWidth(w)).toBe(core.receiptContentWidth(w));
  });
});

describe('host-only helpers', () => {
  it('drawerKick: pin and timing in 2 ms steps; the default is the kiosk\'s kick', () => {
    expect(host.drawerKick()).toEqual(Uint8Array.of(0x1b, 0x70, 0, 25, 250));
    expect(host.drawerKick(1, 100, 100)).toEqual(Uint8Array.of(0x1b, 0x70, 1, 50, 50));
    expect(host.drawerKick(0, 0, 9_999)).toEqual(Uint8Array.of(0x1b, 0x70, 0, 1, 255));
  });

  it('chunk: the same bytes in the same order, never over the size', () => {
    const bytes = Uint8Array.from({ length: 40_001 }, (_, i) => i & 0xff);
    const parts = host.chunk(bytes, 16_384);
    expect(parts.map((p) => p.length)).toEqual([16_384, 16_384, 7_233]);
    expect(host.concat(parts)).toEqual(bytes);
    expect(host.chunk(new Uint8Array(0))).toEqual([]);
    expect(() => host.chunk(bytes, 0)).toThrow();
  });
});
