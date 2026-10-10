/**
 * How a TweezerComm JSON-RPC frame travels on the Nayax C4's own USB (CDC-ACM = a COM port on
 * Windows) — the same frames the kiosk sends the C4 over the LAN (`/SPICy`, core/nayax.ts),
 * wrapped for the serial line. The Android till's TcSerialFraming.kt, byte for byte.
 *
 * Read statically from Nayax SPI 01.2610.00's `libSPI.so` (nothing of the vendor's was run —
 * P:\specs\spi\PLAN.md §7): `SPIUtils::FrameMessage` / `FramedMessageIsValid`, used by all three
 * of its TweezerComm transports (NativeSerial, Serial, TCP):
 *
 *     0x02 | LEN_hi LEN_lo | payload (LEN bytes, UTF-8 JSON) | CRC_hi CRC_lo | 0x03
 *
 * - LEN: the payload's length, 2 bytes, big-endian.
 * - CRC: CRC-16/ARC (reflected polynomial 0xA001, initial 0, no final xor) over LEN and the
 *   payload — high byte first.
 * - A valid frame is at least 7 bytes, starts with 0x02 and ends with 0x03.
 *
 * Pure. Every choice is an option ([SPI_FRAMING]), so a correction after the first test on a
 * real C4 is a one-line change.
 */

export interface TcSerialFramingOptions {
  stx: number;
  etx: number;
  /** The length field's size in bytes (1, 2 or 4). */
  lengthBytes: 1 | 2 | 4;
  lengthBigEndian: boolean;
  /** The CRC's polynomial as the reflected table builds it (0xA001: CRC-16/ARC), its start value. */
  crcPolyReflected: number;
  crcInit: number;
  /** The CRC covers the length field too (else the payload only). */
  crcCoversLength: boolean;
  crcBigEndian: boolean;
  /** Refuse a frame whose CRC does not match (false: read it anyway, for a first test). */
  checkCrc: boolean;
}

/** As Nayax SPI 01.2610.00 frames TweezerComm on a serial line (see the module doc). */
export const SPI_FRAMING: TcSerialFramingOptions = Object.freeze({
  stx: 0x02,
  etx: 0x03,
  lengthBytes: 2,
  lengthBigEndian: true,
  crcPolyReflected: 0xa001,
  crcInit: 0x0000,
  crcCoversLength: true,
  crcBigEndian: true,
  checkCrc: true,
});

/** What one complete frame read off the line came to. */
export type TcSerialRead =
  | { kind: 'frame'; payload: Buffer; text: string }
  /** Bytes that are not a frame (dropped up to the next STX), or a frame whose CRC or ETX is wrong. */
  | { kind: 'garbage'; bytes: number; why: string };

const hex2 = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');
const hex4 = (n: number) => n.toString(16).toUpperCase().padStart(4, '0');

export class TcSerialFraming {
  readonly options: TcSerialFramingOptions;
  private readonly table: Uint16Array;

  constructor(options: Partial<TcSerialFramingOptions> = {}) {
    this.options = { ...SPI_FRAMING, ...options };
    if (![1, 2, 4].includes(this.options.lengthBytes)) throw new Error(`length field of ${this.options.lengthBytes} bytes`);
    this.table = new Uint16Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ this.options.crcPolyReflected : c >>> 1;
      this.table[i] = c & 0xffff;
    }
  }

  /** A copy with some choices changed. */
  with(options: Partial<TcSerialFramingOptions>): TcSerialFraming {
    return new TcSerialFraming({ ...this.options, ...options });
  }

  /** The CRC of [bytes] from [from] to [to] (exclusive). */
  crc(bytes: Uint8Array, from = 0, to = bytes.length): number {
    let crc = this.options.crcInit & 0xffff;
    for (let i = from; i < to; i++) crc = (crc >>> 8) ^ this.table[(crc ^ bytes[i]) & 0xff];
    return crc & 0xffff;
  }

  /** The largest payload the length field can say. */
  get maxPayload(): number {
    return this.options.lengthBytes === 4 ? 0xffffffff : 2 ** (8 * this.options.lengthBytes) - 1;
  }

  /** Header and trailer around a payload. */
  get overhead(): number {
    return 1 + this.options.lengthBytes + 2 + 1;
  }

  /** [payload] (a TweezerComm JSON string) framed for the line. */
  frame(payload: string | Uint8Array): Buffer {
    const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
    if (body.length > this.maxPayload) throw new Error(`payload of ${body.length} bytes`);
    const { stx, etx, lengthBytes, lengthBigEndian, crcCoversLength, crcBigEndian } = this.options;
    const out = Buffer.alloc(body.length + this.overhead);
    out[0] = stx;
    writeNumber(out, 1, lengthBytes, body.length, lengthBigEndian);
    body.copy(out, 1 + lengthBytes);
    const end = 1 + lengthBytes + body.length;
    writeNumber(out, end, 2, this.crc(out, crcCoversLength ? 1 : 1 + lengthBytes, end), crcBigEndian);
    out[out.length - 1] = etx;
    return out;
  }

  /** A reader of frames out of what the line delivers. */
  decoder(): TcSerialDecoder {
    return new TcSerialDecoder(this);
  }

  /** The length of a whole, valid frame starting at [at] in [buf], or null. */
  validAt(buf: Buffer, at: number): number | null {
    const { lengthBytes, lengthBigEndian, etx, crcCoversLength, crcBigEndian, checkCrc } = this.options;
    if (buf.length - at < 1 + lengthBytes) return null;
    const length = readNumber(buf, at + 1, lengthBytes, lengthBigEndian);
    if (length > this.maxPayload) return null;
    const total = length + this.overhead;
    if (buf.length - at < total) return null;
    const payloadEnd = at + 1 + lengthBytes + length;
    if (buf[at + total - 1] !== etx) return null;
    if (checkCrc && readNumber(buf, payloadEnd, 2, crcBigEndian) !== this.crc(buf, crcCoversLength ? at + 1 : at + 1 + lengthBytes, payloadEnd)) return null;
    return total;
  }

  /** "STX 02 · LEN 2 bytes big-endian · CRC poly A001 init 0000 over LEN+payload, high first · ETX 03" — for the technician. */
  describe(): string {
    const o = this.options;
    return (
      `STX ${hex2(o.stx)} · LEN ${o.lengthBytes} bytes ${o.lengthBigEndian ? 'big-endian' : 'little-endian'} · ` +
      `CRC poly ${hex4(o.crcPolyReflected)} init ${hex4(o.crcInit)} over ${o.crcCoversLength ? 'LEN+payload' : 'payload'}, ` +
      `${o.crcBigEndian ? 'high' : 'low'} first${o.checkCrc ? '' : ' (not checked)'} · ETX ${hex2(o.etx)}`
    );
  }
}

/**
 * Reads frames out of what the line delivers, a USB packet at a time: bytes before an STX are
 * dropped (and said), a bad CRC or a missing ETX drops that frame and looks for the next STX.
 */
export class TcSerialDecoder {
  private buf: Buffer = Buffer.alloc(0);

  constructor(private readonly f: TcSerialFraming) {}

  /** Bytes held for a frame not complete yet. */
  get pending(): number {
    return this.buf.length;
  }

  reset(): void {
    this.buf = Buffer.alloc(0);
  }

  feed(bytes: Uint8Array): TcSerialRead[] {
    if (bytes.length > 0) this.buf = Buffer.concat([this.buf, Buffer.from(bytes)]);
    const { stx, etx, lengthBytes, lengthBigEndian, crcCoversLength, crcBigEndian, checkCrc } = this.f.options;
    const out: TcSerialRead[] = [];
    for (;;) {
      if (this.buf.length === 0) break;
      const start = this.buf.indexOf(stx);
      if (start < 0) {
        out.push({ kind: 'garbage', bytes: this.buf.length, why: 'no STX' });
        this.buf = Buffer.alloc(0);
        break;
      }
      if (start > 0) {
        out.push({ kind: 'garbage', bytes: start, why: 'bytes before STX' });
        this.buf = this.buf.subarray(start);
      }
      if (this.buf.length < 1 + lengthBytes) break;
      const length = readNumber(this.buf, 1, lengthBytes, lengthBigEndian);
      if (length > this.f.maxPayload) {
        out.push({ kind: 'garbage', bytes: 1, why: `length ${length}` });
        this.buf = this.buf.subarray(1);
        continue;
      }
      const total = length + this.f.overhead;
      if (this.buf.length < total) {
        // A false STX (a CRC byte of a frame lost before it) may claim a length the line never
        // sends: a whole valid frame further on wins over the wait.
        let next = -1;
        for (let at = 1; at < this.buf.length; at++) {
          if (this.buf[at] === stx && this.f.validAt(this.buf, at) !== null) {
            next = at;
            break;
          }
        }
        if (next < 0) break;
        out.push({ kind: 'garbage', bytes: next, why: 'false STX' });
        this.buf = this.buf.subarray(next);
        continue;
      }
      const payloadEnd = 1 + lengthBytes + length;
      const etxOk = this.buf[total - 1] === etx;
      const crcOk = !checkCrc || readNumber(this.buf, payloadEnd, 2, crcBigEndian) === this.f.crc(this.buf, crcCoversLength ? 1 : 1 + lengthBytes, payloadEnd);
      if (etxOk && crcOk) {
        const payload = Buffer.from(this.buf.subarray(1 + lengthBytes, payloadEnd));
        out.push({ kind: 'frame', payload, text: payload.toString('utf8') });
        this.buf = this.buf.subarray(total);
      } else {
        // Not a frame after all: the next STX may begin one.
        out.push({ kind: 'garbage', bytes: 1, why: etxOk ? 'CRC' : 'no ETX' });
        this.buf = this.buf.subarray(1);
      }
    }
    // Own the remainder (a subarray would pin the whole old buffer).
    this.buf = Buffer.from(this.buf);
    return out;
  }
}

/** The framing Nayax SPI uses (see the module doc). */
export const SPI = new TcSerialFraming();

function writeNumber(out: Buffer, at: number, size: number, value: number, bigEndian: boolean): void {
  for (let i = 0; i < size; i++) {
    const shift = 8 * (bigEndian ? size - 1 - i : i);
    out[at + i] = Math.floor(value / 2 ** shift) & 0xff;
  }
}

function readNumber(buf: Uint8Array, at: number, size: number, bigEndian: boolean): number {
  let v = 0;
  for (let i = 0; i < size; i++) {
    const b = buf[at + i];
    v = bigEndian ? v * 256 + b : v + b * 2 ** (8 * i);
  }
  return v;
}
