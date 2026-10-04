/**
 * Writes the PWA icons into public/icons: a dark square with "R2M" in white.
 *
 * Built-in modules only (zlib for the PNG's deflate), so it needs no image library.
 * The letters are a 5×7 bitmap scaled up — crude, but crisp at every size and enough
 * for a home-screen icon until there is a real logo. Run: `node scripts/generate-pwa-icons.mjs`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

/** --primary of the light theme, oklch(0.205 0 0). */
const BG = [0x17, 0x17, 0x17];
const FG = [0xff, 0xff, 0xff];

const GLYPHS = {
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
};
const TEXT = 'R2M';
const COLS = TEXT.length * 5 + (TEXT.length - 1);
const ROWS = 7;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** `textWidth`: the share of the icon's width the text spans. */
function icon(size, textWidth) {
  const scale = Math.max(1, Math.floor((size * textWidth) / COLS));
  const x0 = Math.floor((size - COLS * scale) / 2);
  const y0 = Math.floor((size - ROWS * scale) / 2);
  const lit = (x, y) => {
    const col = Math.floor((x - x0) / scale);
    const row = Math.floor((y - y0) / scale);
    if (col < 0 || row < 0 || col >= COLS || row >= ROWS) return false;
    const glyph = Math.floor(col / 6);
    const gx = col % 6;
    return gx < 5 && GLYPHS[TEXT[glyph]][row][gx] === '1';
  };

  // One filter byte (0 = none) per scanline, then RGB.
  const raw = Buffer.alloc(size * (size * 3 + 1));
  let i = 0;
  for (let y = 0; y < size; y++) {
    raw[i++] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b] = lit(x, y) ? FG : BG;
      raw[i++] = r;
      raw[i++] = g;
      raw[i++] = b;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
mkdirSync(out, { recursive: true });
// A maskable icon is cropped to as little as a centred circle of 80%: its text is kept
// well inside that. iOS rounds the apple-touch icon itself and wants no transparency.
const files = {
  'icon-192.png': icon(192, 0.62),
  'icon-512.png': icon(512, 0.62),
  'maskable-192.png': icon(192, 0.5),
  'maskable-512.png': icon(512, 0.5),
  'apple-touch-icon.png': icon(180, 0.6),
};
for (const [name, png] of Object.entries(files)) {
  writeFileSync(join(out, name), png);
  console.log(`${name}: ${png.length} bytes`);
}
