/**
 * SynqPay's link layer (https://docs.synqpay.com/api/transport/link/): the frames that carry
 * JSON-RPC over TCP (9000 / 9443) and the serial (UART) link — the same bytes as the Android till
 * (pos-android hardware/payment/synqpay/SynqPayLink.kt). Pure; pinned by test/synqpay.link.test.ts.
 *
 *   STX(0x02) | Type(1) | Body | ETX(0x03)
 *   Request 0x01:  ApiKey(4) | Length(4, BE) | Payload (UTF-8 JSON) | CRC16(2)
 *   Response 0x02 / Event 0x03: Length(4) | Payload | CRC16(2)
 *   KeepAlive 0x04, ACK 0x05: no body. Error 0x06: one code byte.
 *   CRC16 = CRC-16/MODBUS (poly 0xA001 reflected, init 0xFFFF) over Length + Payload.
 *
 * Unverified (pos-server docs/SPEC_SYNQPAY.md §1.2): the docs' own hex example has a CRC that the
 * documented algorithm does not give; frames are SENT big-endian as the text says and RECEIVED
 * in either byte order (the decoder says which).
 */

export const STX = 0x02;
export const ETX = 0x03;

export const TYPE = { REQUEST: 0x01, RESPONSE: 0x02, EVENT: 0x03, KEEPALIVE: 0x04, ACK: 0x05, ERROR: 0x06 } as const;

export const LINK_ERROR = {
  INVALID_MESSAGE: 0x01,
  INVALID_MSG_TYPE: 0x02,
  CRC_ERROR: 0x03,
  LEN_ERROR: 0x04,
  NOT_AUTHENTICATED: 0x05,
} as const;

export const MAX_PAYLOAD = 4 * 1024 * 1024;

export function linkErrorName(code: number): string {
  const hit = Object.entries(LINK_ERROR).find(([, v]) => v === code);
  return hit ? hit[0] : `ERROR_0x${code.toString(16).padStart(2, '0').toUpperCase()}`;
}

/** CRC-16/MODBUS over bytes [from, to). */
export function crc16(data: Uint8Array, from = 0, to = data.length): number {
  let crc = 0xffff;
  for (let i = from; i < to; i++) {
    crc ^= data[i];
    for (let b = 0; b < 8; b++) crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
  }
  return crc & 0xffff;
}

/** Zeros: what `pair` / `authenticate` carry in place of a key. */
export const PAIRING_KEY = Buffer.alloc(4);

/** The pairing's key ("1234abcd") as the frame's 4 bytes (12 34 AB CD); null when not 8 hex characters. */
export function apiKeyBytes(apiKey: string | null | undefined): Buffer | null {
  const t = (apiKey ?? '').trim();
  return /^[0-9a-fA-F]{8}$/.test(t) ? Buffer.from(t, 'hex') : null;
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}

function crcBytes(crc: number, littleEndian: boolean): Buffer {
  const b = Buffer.alloc(2);
  if (littleEndian) b.writeUInt16LE(crc, 0);
  else b.writeUInt16BE(crc, 0);
  return b;
}

export function requestFrame(apiKey: Uint8Array, payload: string, crcLittleEndian = false): Buffer {
  if (apiKey.length !== 4) throw new Error('the API key is 4 bytes on the link');
  const body = Buffer.from(payload, 'utf8');
  if (body.length > MAX_PAYLOAD) throw new Error('payload too large');
  const lenAndBody = Buffer.concat([u32(body.length), body]);
  return Buffer.concat([Buffer.from([STX, TYPE.REQUEST]), Buffer.from(apiKey), lenAndBody, crcBytes(crc16(lenAndBody), crcLittleEndian), Buffer.from([ETX])]);
}

/** A Response / Event frame — what the terminal sends; for tests and a simulated terminal. */
export function payloadFrame(type: number, payload: string, crcLittleEndian = false): Buffer {
  const body = Buffer.from(payload, 'utf8');
  const lenAndBody = Buffer.concat([u32(body.length), body]);
  return Buffer.concat([Buffer.from([STX, type]), lenAndBody, crcBytes(crc16(lenAndBody), crcLittleEndian), Buffer.from([ETX])]);
}

export const keepAliveFrame = () => Buffer.from([STX, TYPE.KEEPALIVE, ETX]);
export const ackFrame = () => Buffer.from([STX, TYPE.ACK, ETX]);
export const errorFrame = (code: number) => Buffer.from([STX, TYPE.ERROR, code, ETX]);

export type Frame =
  | { kind: 'response'; json: string; crcLittleEndian: boolean }
  | { kind: 'event'; json: string; crcLittleEndian: boolean }
  | { kind: 'request'; apiKey: Buffer; json: string; crcLittleEndian: boolean }
  | { kind: 'keepalive' }
  | { kind: 'ack' }
  | { kind: 'error'; code: number }
  | { kind: 'garbage'; reason: string; bytes: number };

/**
 * Bytes of a link (which may split or join frames anywhere) into frames. Bytes before an STX and a
 * frame that does not hold together are reported as garbage and skipped (resync on the next STX).
 */
export class FrameDecoder {
  private buf = Buffer.alloc(0);

  constructor(private readonly maxPayload = MAX_PAYLOAD) {}

  feed(chunk: Uint8Array): Frame[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, Buffer.from(chunk)]) : Buffer.from(chunk);
    const out: Frame[] = [];
    for (;;) {
      const f = this.parseOne();
      if (!f) break;
      out.push(f);
    }
    return out;
  }

  private consume(n: number) {
    this.buf = this.buf.subarray(n);
  }

  private nextStx(): number {
    const i = this.buf.indexOf(STX, 1);
    return i < 0 ? this.buf.length : i;
  }

  private bad(reason: string): Frame {
    const n = this.nextStx();
    this.consume(n);
    return { kind: 'garbage', reason, bytes: n };
  }

  private parseOne(): Frame | null {
    const b = this.buf;
    if (b.length === 0) return null;
    if (b[0] !== STX) {
      const i = b.indexOf(STX);
      const n = i < 0 ? b.length : i;
      this.consume(n);
      return { kind: 'garbage', reason: 'bytes before STX', bytes: n };
    }
    if (b.length < 2) return null;
    const type = b[1];
    switch (type) {
      case TYPE.KEEPALIVE:
      case TYPE.ACK:
        if (b.length < 3) return null;
        if (b[2] !== ETX) return this.bad(`no ETX after type ${type}`);
        this.consume(3);
        return { kind: type === TYPE.ACK ? 'ack' : 'keepalive' };
      case TYPE.ERROR: {
        if (b.length < 4) return null;
        if (b[3] !== ETX) return this.bad('no ETX after an error frame');
        const code = b[2];
        this.consume(4);
        return { kind: 'error', code };
      }
      case TYPE.RESPONSE:
      case TYPE.EVENT:
        return this.payload(type, 2);
      case TYPE.REQUEST:
        return this.payload(type, 6);
      default:
        return this.bad(`unknown frame type ${type}`);
    }
  }

  private payload(type: number, lengthAt: number): Frame | null {
    const b = this.buf;
    if (b.length < lengthAt + 4) return null;
    const n = b.readUInt32BE(lengthAt);
    if (n > this.maxPayload) return this.bad(`length ${n} out of range`);
    const crcAt = lengthAt + 4 + n;
    const total = crcAt + 3;
    if (b.length < total) return null;
    if (b[crcAt + 2] !== ETX) return this.bad('no ETX after the payload');
    const crc = crc16(b, lengthAt, crcAt);
    let littleEndian: boolean;
    if (crc === b.readUInt16BE(crcAt)) littleEndian = false;
    else if (crc === b.readUInt16LE(crcAt)) littleEndian = true;
    else return this.bad('CRC mismatch');
    const json = b.subarray(lengthAt + 4, crcAt).toString('utf8');
    const apiKey = type === TYPE.REQUEST ? Buffer.from(b.subarray(2, 6)) : null;
    this.consume(total);
    if (type === TYPE.RESPONSE) return { kind: 'response', json, crcLittleEndian: littleEndian };
    if (type === TYPE.EVENT) return { kind: 'event', json, crcLittleEndian: littleEndian };
    return { kind: 'request', apiKey: apiKey!, json, crcLittleEndian: littleEndian };
  }
}
