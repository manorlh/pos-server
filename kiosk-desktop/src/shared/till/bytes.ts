/**
 * Bytes on a JSON wire (the till protocol's `hw.*` and channel frames): standard base64, no
 * Buffer and no btoa, so the same code runs in the main process, a browser and Chromium 108.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const LOOKUP: Record<string, number> = {};
for (let i = 0; i < ALPHABET.length; i++) LOOKUP[ALPHABET[i]] = i;

export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63] + ALPHABET[(n >> 6) & 63] + ALPHABET[n & 63];
  }
  if (i < bytes.length) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8);
    out += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63];
    out += i + 1 < bytes.length ? ALPHABET[(n >> 6) & 63] : '=';
    out += '=';
  }
  return out;
}

export function base64ToBytes(text: string): Uint8Array {
  const clean = text.replace(/[\s=]+/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 6) / 8));
  let buf = 0;
  let bits = 0;
  let at = 0;
  for (let i = 0; i < clean.length; i++) {
    const v = LOOKUP[clean[i]];
    if (v === undefined) throw new Error('not base64');
    buf = ((buf << 6) | v) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (buf >> bits) & 0xff;
    }
  }
  return out.subarray(0, at);
}
