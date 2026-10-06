/**
 * ESC/POS for an 80 mm kiosk printer (SNBC BTP-880, 576 dots), as the Android till prints
 * (pos-android hardware/kitchen/EscPos.kt): every page is a picture — no codepage, no text
 * commands — so Hebrew prints exactly as drawn.
 *
 *  - INIT `ESC @`, then the page as `GS v 0` raster bands of 256 rows, then `ESC d 3` and the
 *    partial cut `GS V 66 0` (or `ESC d 6` without a cutter);
 *  - each raster row is ceil(w/8) bytes, the most significant bit the leftmost dot, 1 = print;
 *  - 1-bit by a plain threshold, no dithering: a pixel is black when it is opaque enough
 *    (alpha ≥ 128) and its luminance (r·299 + g·587 + b·114)/1000 is below 128.
 *
 * Pure: the bytes for a bitmap; transports (spooler, TCP 9100) are elsewhere.
 */

export const ESC = 0x1b;
export const GS = 0x1d;
export const DLE = 0x10;
export const EOT = 0x04;

/** The 80 mm printers' raster width (dots). */
export const RASTER_80MM = 576;
/** Rows per `GS v 0` command (the till's BAND_ROWS). */
export const BAND_ROWS = 256;

export const INIT = Uint8Array.of(ESC, 0x40);
/** `GS V 66 0`: feed to the cutter and partial cut (function B). */
export const CUT = Uint8Array.of(GS, 0x56, 0x42, 0x00);
/** `ESC B 3 2`: the buzzer (kitchen printers that ask for it; never on receipts). */
export const BEEP = Uint8Array.of(ESC, 0x42, 0x03, 0x02);

export function feed(lines: number): Uint8Array {
  return Uint8Array.of(ESC, 0x64, Math.max(0, Math.min(255, Math.trunc(lines))));
}

/** A 1-bit picture: `rowBytes` bytes per row, MSB = leftmost dot, 1 = black. */
export interface MonoBitmap {
  width: number;
  height: number;
  rowBytes: number;
  data: Uint8Array;
}

/** The till's isBlack: opaque enough and darker than mid-grey. */
export function isBlack(r: number, g: number, b: number, a: number): boolean {
  if (a < 128) return false;
  return Math.trunc((r * 299 + g * 587 + b * 114) / 1000) < 128;
}

/** RGBA pixels (canvas ImageData order) → a 1-bit picture of the same size. */
export function toMono(rgba: ArrayLike<number>, width: number, height: number): MonoBitmap {
  if (width <= 0 || height <= 0) return { width: 0, height: 0, rowBytes: 0, data: new Uint8Array(0) };
  if (rgba.length < width * height * 4) throw new Error(`toMono: ${rgba.length} bytes for ${width}x${height}`);
  const rowBytes = Math.ceil(width / 8);
  const data = new Uint8Array(rowBytes * height);
  for (let y = 0; y < height; y++) {
    const row = y * rowBytes;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (isBlack(rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3])) data[row + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return { width, height, rowBytes, data };
}

/**
 * `bmp` centred on a raster `rasterWidth` dots wide (whole bytes): white margins on both sides,
 * as EscPos.centred. Wider pictures are cut to the raster (never happens with the renderers).
 */
export function centreOn(bmp: MonoBitmap, rasterWidth: number = RASTER_80MM): MonoBitmap {
  const width = Math.floor(rasterWidth / 8) * 8;
  const rowBytes = width / 8;
  if (bmp.width === width && bmp.rowBytes === rowBytes) return bmp;
  const out = new Uint8Array(rowBytes * bmp.height);
  const offset = Math.max(0, Math.floor((width - bmp.width) / 2));
  const copyW = Math.min(bmp.width, width);
  for (let y = 0; y < bmp.height; y++) {
    for (let x = 0; x < copyW; x++) {
      const on = bmp.data[y * bmp.rowBytes + (x >> 3)] & (0x80 >> (x & 7));
      if (on) {
        const tx = x + offset;
        out[y * rowBytes + (tx >> 3)] |= 0x80 >> (tx & 7);
      }
    }
  }
  return { width, height: bmp.height, rowBytes, data: out };
}

/** `GS v 0` bands of at most [BAND_ROWS] rows. */
export function rasterBands(bmp: MonoBitmap, bandRows: number = BAND_ROWS): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let top = 0; top < bmp.height; top += bandRows) {
    const rows = Math.min(bandRows, bmp.height - top);
    const head = Uint8Array.of(
      GS, 0x76, 0x30, 0x00,
      bmp.rowBytes & 0xff, (bmp.rowBytes >> 8) & 0xff,
      rows & 0xff, (rows >> 8) & 0xff,
    );
    const band = new Uint8Array(head.length + rows * bmp.rowBytes);
    band.set(head, 0);
    band.set(bmp.data.subarray(top * bmp.rowBytes, (top + rows) * bmp.rowBytes), head.length);
    out.push(band);
  }
  return out;
}

export interface JobOptions {
  cut?: boolean;
  beep?: boolean;
}

/** One print job: INIT, the picture, feed and cut (EscPos.job). */
export function job(bmp: MonoBitmap, opts: JobOptions = {}): Uint8Array {
  const cut = opts.cut ?? true;
  const parts: Uint8Array[] = [INIT, ...rasterBands(bmp)];
  if (cut) parts.push(feed(3), CUT);
  else parts.push(feed(6));
  if (opts.beep) parts.push(BEEP);
  return concat(parts);
}

export function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** The receipt's content width on a raster: 1/32 of it white on each side (540 of 576). */
export function receiptContentWidth(rasterWidth: number = RASTER_80MM): number {
  return rasterWidth - 2 * Math.floor(rasterWidth / 32);
}

/** Rows that are entirely white at the bottom, dropped (less paper; never a row with ink). */
export function trimBottom(bmp: MonoBitmap, keep = 8): MonoBitmap {
  let last = bmp.height - 1;
  outer: for (; last >= 0; last--) {
    const row = last * bmp.rowBytes;
    for (let i = 0; i < bmp.rowBytes; i++) if (bmp.data[row + i] !== 0) break outer;
  }
  const height = Math.min(bmp.height, Math.max(0, last + 1 + keep));
  if (height === bmp.height) return bmp;
  return { ...bmp, height, data: bmp.data.slice(0, height * bmp.rowBytes) };
}

/* ------------------------------------------------------------- status */

/** `DLE EOT n` real-time status requests (answered at once, even mid-job). */
export const STATUS_PRINTER = Uint8Array.of(DLE, EOT, 1);
export const STATUS_OFFLINE = Uint8Array.of(DLE, EOT, 2);
export const STATUS_ERROR = Uint8Array.of(DLE, EOT, 3);
export const STATUS_PAPER = Uint8Array.of(DLE, EOT, 4);

export type PaperState = 'ok' | 'near_end' | 'out';

export interface PrinterStatusBits {
  /** The answer is a status byte at all ((b & 0x93) == 0x12). */
  valid: boolean;
  offline: boolean;
  paper: PaperState;
  coverOpen: boolean;
  error: boolean;
}

/** A status byte is one when its fixed bits are right (bit 1 and 4 set, bits 0 and 7 clear). */
export function validStatusByte(b: number): boolean {
  return (b & 0x93) === 0x12;
}

/**
 * The answers to `DLE EOT 1` (printer), `DLE EOT 2` (offline cause) and `DLE EOT 4` (paper roll
 * sensor), any of which may be missing (null). Paper out is bits 5–6 of the paper byte; near
 * end bits 2–3; offline bit 3 of the printer byte; cover open bit 2 of the offline byte; an
 * error bit 6 of the offline byte (or 5: paper ended the printing).
 */
export function parseStatus(printer: number | null, offline: number | null, paper: number | null): PrinterStatusBits {
  const ok = (b: number | null): b is number => b !== null && validStatusByte(b);
  const valid = ok(printer) || ok(offline) || ok(paper);
  const paperState: PaperState = ok(paper) ? ((paper & 0x60) !== 0 ? 'out' : (paper & 0x0c) !== 0 ? 'near_end' : 'ok') : ok(offline) && (offline & 0x20) !== 0 ? 'out' : 'ok';
  return {
    valid,
    offline: ok(printer) ? (printer & 0x08) !== 0 : false,
    paper: paperState,
    coverOpen: ok(offline) ? (offline & 0x04) !== 0 : false,
    error: ok(offline) ? (offline & 0x40) !== 0 : false,
  };
}
