/**
 * ESC/POS bytes for the host layer (S0-5), ported from W/core/escpos.ts — the Windows kiosk's —
 * which itself follows the Android till (pos-android hardware/kitchen/EscPos.kt): every page a
 * picture (`GS v 0` raster bands of 256 rows, MSB = leftmost dot), `ESC @` before, `ESC d 3` and
 * the partial cut `GS V 66 0` after (`ESC d 6` without a cutter), the drawer's kick
 * `ESC p 0 25 250`, the `DLE EOT n` status answers.
 *
 * Why a port and not an import: these files ship in the one app bundle (`r2m-app`) for every host,
 * while W/core belongs to the Windows kiosk's own ledger and printing, which move to the engine
 * later (spec decision 8). test/hostEscpos.test.ts pins both byte for byte until then.
 *
 * In the till the ENGINE draws and sends ready bytes (§3.5): the host needs these only for the
 * drawer, the status queries, a test page and splitting a job for WebUSB / Web Serial.
 * Pure; nothing newer than Chromium 108.
 */

export const ESC = 0x1b;
export const GS = 0x1d;
export const DLE = 0x10;
export const EOT = 0x04;

export const RASTER_80MM = 576;
export const RASTER_58MM = 384;
export const BAND_ROWS = 256;

export const INIT = Uint8Array.of(ESC, 0x40);
export const CUT = Uint8Array.of(GS, 0x56, 0x42, 0x00);
export const BEEP = Uint8Array.of(ESC, 0x42, 0x03, 0x02);

/** `ESC p m t1 t2`: the drawer's kick — `pin` 0 (pin 2) or 1 (pin 5), on/off in 2 ms steps. */
export function drawerKick(pin: 0 | 1 = 0, onMs = 50, offMs = 500): Uint8Array {
  const step = (ms: number) => Math.max(1, Math.min(255, Math.round(ms / 2)));
  return Uint8Array.of(ESC, 0x70, pin, step(onMs), step(offMs));
}

/** The kiosk's and the till's kick: pin 2, 50 ms on, 500 ms off (`ESC p 0 25 250`). */
export const DRAWER_KICK = drawerKick(0, 50, 500);

export function feed(lines: number): Uint8Array {
  return Uint8Array.of(ESC, 0x64, Math.max(0, Math.min(255, Math.trunc(lines))));
}

export interface MonoBitmap {
  width: number;
  height: number;
  rowBytes: number;
  data: Uint8Array;
}

export function isBlack(r: number, g: number, b: number, a: number): boolean {
  if (a < 128) return false;
  return Math.trunc((r * 299 + g * 587 + b * 114) / 1000) < 128;
}

export function toMono(rgba: ArrayLike<number>, width: number, height: number): MonoBitmap {
  if (width <= 0 || height <= 0) return { width: 0, height: 0, rowBytes: 0, data: new Uint8Array(0) };
  if (rgba.length < width * height * 4) throw new Error(`toMono: ${rgba.length} bytes for ${width}x${height}`);
  const rowBytes = Math.ceil(width / 8);
  const data = new Uint8Array(rowBytes * height);
  let i = 0;
  for (let y = 0; y < height; y++) {
    const row = y * rowBytes;
    for (let x = 0; x < width; x++, i += 4) {
      if (isBlack(rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3])) data[row + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return { width, height, rowBytes, data };
}

export function centreOn(bmp: MonoBitmap, rasterWidth: number = RASTER_80MM): MonoBitmap {
  const width = Math.floor(rasterWidth / 8) * 8;
  const rowBytes = width / 8;
  if (bmp.width === width && bmp.rowBytes === rowBytes) return bmp;
  const out = new Uint8Array(rowBytes * bmp.height);
  const offset = Math.max(0, Math.floor((width - bmp.width) / 2));
  const copyW = Math.min(bmp.width, width);
  for (let y = 0; y < bmp.height; y++) {
    const src = y * bmp.rowBytes;
    const dst = y * rowBytes;
    for (let x = 0; x < copyW; x++) {
      if (bmp.data[src + (x >> 3)] & (0x80 >> (x & 7))) {
        const tx = x + offset;
        out[dst + (tx >> 3)] |= 0x80 >> (tx & 7);
      }
    }
  }
  return { width, height: bmp.height, rowBytes, data: out };
}

function bandHeader(rowBytes: number, rows: number): Uint8Array {
  return Uint8Array.of(GS, 0x76, 0x30, 0x00, rowBytes & 0xff, (rowBytes >> 8) & 0xff, rows & 0xff, (rows >> 8) & 0xff);
}

export function rasterBands(bmp: MonoBitmap, bandRows: number = BAND_ROWS): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let top = 0; top < bmp.height; top += bandRows) {
    const rows = Math.min(bandRows, bmp.height - top);
    out.push(concat([bandHeader(bmp.rowBytes, rows), bmp.data.subarray(top * bmp.rowBytes, (top + rows) * bmp.rowBytes)]));
  }
  return out;
}

export interface JobOptions {
  cut?: boolean;
  beep?: boolean;
}

export function job(bmp: MonoBitmap, opts: JobOptions = {}): Uint8Array {
  const parts: Uint8Array[] = [INIT];
  for (const band of rasterBands(bmp)) parts.push(band);
  if (opts.cut ?? true) parts.push(feed(3), CUT);
  else parts.push(feed(6));
  if (opts.beep) parts.push(BEEP);
  return concat(parts);
}

export function concat(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function receiptContentWidth(rasterWidth: number = RASTER_80MM): number {
  return rasterWidth - 2 * Math.floor(rasterWidth / 32);
}

export function trimBottom(bmp: MonoBitmap, keep = 8): MonoBitmap {
  let last = bmp.height - 1;
  for (; last >= 0; last--) {
    const row = bmp.data.subarray(last * bmp.rowBytes, (last + 1) * bmp.rowBytes);
    if (row.some((b) => b !== 0)) break;
  }
  const height = Math.min(bmp.height, Math.max(0, last + 1 + keep));
  if (height === bmp.height) return bmp;
  return { ...bmp, height, data: bmp.data.slice(0, height * bmp.rowBytes) };
}

/**
 * A job split for a transport's write size (WebUSB bulk OUT, Web Serial): consecutive slices of
 * at most `max` bytes, the same bytes in the same order.
 */
export function chunk(bytes: Uint8Array, max = 16_384): Uint8Array[] {
  if (max <= 0) throw new Error('chunk size');
  const out: Uint8Array[] = [];
  for (let at = 0; at < bytes.length; at += max) out.push(bytes.subarray(at, Math.min(bytes.length, at + max)));
  return out;
}

/* ------------------------------------------------------------- status */

export const STATUS_PRINTER = Uint8Array.of(DLE, EOT, 1);
export const STATUS_OFFLINE = Uint8Array.of(DLE, EOT, 2);
export const STATUS_ERROR = Uint8Array.of(DLE, EOT, 3);
export const STATUS_PAPER = Uint8Array.of(DLE, EOT, 4);

export type PaperState = 'ok' | 'near_end' | 'out';

export interface PrinterStatusBits {
  valid: boolean;
  offline: boolean;
  paper: PaperState;
  coverOpen: boolean;
  error: boolean;
}

export function validStatusByte(b: number): boolean {
  return (b & 0x93) === 0x12;
}

export function parseStatus(printer: number | null, offline: number | null, paper: number | null): PrinterStatusBits {
  const ok = (b: number | null): b is number => b !== null && validStatusByte(b);
  let paperState: PaperState = 'ok';
  if (ok(paper)) paperState = (paper & 0x60) !== 0 ? 'out' : (paper & 0x0c) !== 0 ? 'near_end' : 'ok';
  else if (ok(offline) && (offline & 0x20) !== 0) paperState = 'out';
  return {
    valid: ok(printer) || ok(offline) || ok(paper),
    offline: ok(printer) ? (printer & 0x08) !== 0 : false,
    paper: paperState,
    coverOpen: ok(offline) ? (offline & 0x04) !== 0 : false,
    error: ok(offline) ? (offline & 0x40) !== 0 : false,
  };
}
