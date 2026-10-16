/**
 * A page as another till's printer gets it (P:/specs/bill-print-other-till.md §10.3, pos-android hardware/printer/MonoPng.kt):
 * a PNG of one bit a dot — grey, bit depth 1, no interlace — of a [MonoBitmap] (rows of ceil(width / 8) bytes, the leftmost
 * dot in the high bit, 1 = black). In a grey PNG 0 is black, so the bits are inverted on the way in and out; padding bits
 * past the width are white. Pure (node:zlib only), so the size and the round trip are unit-tested.
 */

import { deflateSync, inflateSync } from 'node:zlib';
import type { MonoBitmap } from './escpos';

const SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10);
/** A page taller than this is refused (about 4 m of paper). */
export const MONO_PNG_MAX_HEIGHT = 32_000;

let crcTable: Uint32Array | null = null;
function crc32(parts: readonly Uint8Array[]): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const p of parts) for (let i = 0; i < p.length; i++) crc = crcTable[(crc ^ p[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function u32(n: number): Uint8Array {
  return Uint8Array.of((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
}

function chunk(type: string, body: Uint8Array): Uint8Array[] {
  const t = Uint8Array.from(type, (c) => c.charCodeAt(0));
  return [u32(body.length), t, body, u32(crc32([t, body]))];
}

/** [bmp] as a 1-bit grey PNG. */
export function encodeMonoPng(bmp: MonoBitmap): Buffer {
  if (bmp.width <= 0 || bmp.height <= 0) throw new Error('empty image');
  const stride = Math.ceil(bmp.width / 8);
  const raw = new Uint8Array((stride + 1) * bmp.height);
  const pad = stride * 8 - bmp.width;
  for (let y = 0; y < bmp.height; y++) {
    const o = y * (stride + 1);
    raw[o] = 0; // filter: none
    for (let i = 0; i < stride; i++) raw[o + 1 + i] = (bmp.data[y * bmp.rowBytes + i] ?? 0) ^ 0xff;
    if (pad > 0) raw[o + stride] |= (1 << pad) - 1;
  }
  const header = new Uint8Array(13);
  header.set(u32(bmp.width), 0);
  header.set(u32(bmp.height), 4);
  header[8] = 1; // bit depth
  header[9] = 0; // grey
  header[10] = 0; // deflate
  header[11] = 0; // adaptive filtering
  header[12] = 0; // not interlaced
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([SIGNATURE, ...chunk('IHDR', header), ...chunk('IDAT', new Uint8Array(idat)), ...chunk('IEND', new Uint8Array(0))]);
}

/** A 1-bit grey PNG (what a till sends) back to its dots; any other kind of PNG throws. */
export function decodeMonoPng(png: Uint8Array): MonoBitmap {
  const buf = Buffer.from(png);
  if (buf.length < 8 || !SIGNATURE.every((b, i) => buf[i] === b)) throw new Error('not a PNG');
  let at = 8;
  let width = 0;
  let height = 0;
  const data: Buffer[] = [];
  for (;;) {
    if (at + 8 > buf.length) throw new Error('PNG cut short');
    const length = buf.readUInt32BE(at);
    const type = buf.toString('latin1', at + 4, at + 8);
    if (length > buf.length - at - 12) throw new Error('bad chunk');
    const body = buf.subarray(at + 8, at + 8 + length);
    at += 12 + length;
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      if (body[8] !== 1 || body[9] !== 0 || body[12] !== 0) throw new Error('only 1-bit grey PNG');
      if (width <= 0 || height <= 0 || height > MONO_PNG_MAX_HEIGHT || width > 4096) throw new Error(`bad size ${width}x${height}`);
    } else if (type === 'IDAT') data.push(body);
    else if (type === 'IEND') break;
  }
  if (width === 0) throw new Error('no header');
  const stride = Math.ceil(width / 8);
  const raw = inflateSync(Buffer.concat(data));
  if (raw.length < (stride + 1) * height) throw new Error('image data cut short');
  const rows = new Uint8Array(stride * height);
  let prior = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const o = y * (stride + 1);
    const filter = raw[o];
    const line = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const x = raw[o + 1 + i];
      const a = i > 0 ? line[i - 1] : 0;
      const b = prior[i];
      const c = i > 0 ? prior[i - 1] : 0;
      let v: number;
      switch (filter) {
        case 0:
          v = x;
          break;
        case 1:
          v = x + a;
          break;
        case 2:
          v = x + b;
          break;
        case 3:
          v = x + ((a + b) >> 1);
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          throw new Error(`bad filter ${filter}`);
      }
      line[i] = v & 0xff;
    }
    for (let i = 0; i < stride; i++) rows[y * stride + i] = line[i] ^ 0xff;
    // Padding bits past the width are not dots.
    const pad = stride * 8 - width;
    if (pad > 0) rows[y * stride + stride - 1] &= 0xff << pad;
    prior = line;
  }
  return { width, height, rowBytes: stride, data: rows };
}
