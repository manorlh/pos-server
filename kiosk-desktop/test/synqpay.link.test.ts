/**
 * SynqPay's link frames (src/main/payment/synqpay/link.ts), byte by byte — the same vectors as the
 * Android till's SynqPayLinkTest: the docs' example frame, CRC-16/MODBUS over Length + Payload,
 * the key as 4 bytes, and a decoder that survives split, joined and broken frames.
 */
import { describe, expect, it } from 'vitest';
import {
  FrameDecoder,
  PAIRING_KEY,
  TYPE,
  LINK_ERROR,
  ackFrame,
  apiKeyBytes,
  crc16,
  errorFrame,
  keepAliveFrame,
  linkErrorName,
  payloadFrame,
  requestFrame,
} from '../src/main/payment/synqpay/link';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex').toUpperCase().match(/.{2}/g)!.join(' ');
const docsPayload = '{"jsonrpc":"2.0","method":"getDeviceInfo","id":"1234","params":null}';

describe('SynqPay link frames', () => {
  it('CRC is MODBUS (the standard check value)', () => {
    expect(crc16(Buffer.from('123456789'))).toBe(0x4b37);
  });

  it('lays a request out as the docs example', () => {
    const frame = requestFrame(apiKeyBytes('1234abcd')!, docsPayload);
    expect(Buffer.byteLength(docsPayload)).toBe(68);
    expect(frame.length).toBe(81);
    expect(hex(frame.subarray(0, 10))).toBe('02 01 12 34 AB CD 00 00 00 44');
    expect(frame.subarray(10, 78).toString('utf8')).toBe(docsPayload);
    expect(frame[80]).toBe(0x03);
    // The documented algorithm gives 33 3B; the docs' dump prints 40 A2 (SPEC_SYNQPAY §1.2).
    expect(hex(frame.subarray(78, 80))).toBe('33 3B');
    expect(hex(requestFrame(apiKeyBytes('1234abcd')!, docsPayload, true).subarray(78, 80))).toBe('3B 33');
  });

  it('carries the key as 4 bytes, and zeros for pairing', () => {
    expect(hex(apiKeyBytes('1234abcd')!)).toBe('12 34 AB CD');
    expect(apiKeyBytes('1234abcg')).toBeNull();
    expect(apiKeyBytes('123456')).toBeNull();
    expect(apiKeyBytes(null)).toBeNull();
    expect(hex(requestFrame(PAIRING_KEY, '{}').subarray(0, 6))).toBe('02 01 00 00 00 00');
  });

  it('control frames', () => {
    expect(hex(keepAliveFrame())).toBe('02 04 03');
    expect(hex(ackFrame())).toBe('02 05 03');
    expect(hex(errorFrame(LINK_ERROR.NOT_AUTHENTICATED))).toBe('02 06 05 03');
    expect(linkErrorName(LINK_ERROR.CRC_ERROR)).toBe('CRC_ERROR');
  });

  it('decodes whole, byte by byte, and joined', () => {
    const json = '{"jsonrpc":"2.0","id":"7","result":{"deviceStatus":"IDLE"}}';
    const frame = payloadFrame(TYPE.RESPONSE, json);
    expect(new FrameDecoder().feed(frame)).toEqual([{ kind: 'response', json, crcLittleEndian: false }]);
    const d = new FrameDecoder();
    const out = [...frame].flatMap((b) => d.feed(Buffer.from([b])));
    expect(out).toEqual([{ kind: 'response', json, crcLittleEndian: false }]);
    const event = payloadFrame(TYPE.EVENT, '{"jsonrpc":"2.0","method":"transactionEvent","params":{"type":"WAITING_FOR_CARD"}}');
    const frames = new FrameDecoder().feed(Buffer.concat([keepAliveFrame(), event, frame, ackFrame(), errorFrame(LINK_ERROR.CRC_ERROR)]));
    expect(frames.map((f) => f.kind)).toEqual(['keepalive', 'event', 'response', 'ack', 'error']);
  });

  it('counts bytes, not characters, in a Hebrew payload', () => {
    const json = '{"id":"1","result":{"cardName":"ויזה רגיל"}}';
    const frame = payloadFrame(TYPE.RESPONSE, json);
    expect(frame.readUInt32BE(2)).toBe(Buffer.byteLength(json));
    expect(new FrameDecoder().feed(frame)).toEqual([{ kind: 'response', json, crcLittleEndian: false }]);
  });

  it("accepts the terminal's CRC in either byte order", () => {
    const json = '{"id":"1","result":null}';
    expect(new FrameDecoder().feed(payloadFrame(TYPE.RESPONSE, json, true))).toEqual([{ kind: 'response', json, crcLittleEndian: true }]);
  });

  it('skips a broken frame and reads the next', () => {
    const good = payloadFrame(TYPE.RESPONSE, '{"id":"2","result":null}');
    const bad = payloadFrame(TYPE.RESPONSE, '{"id":"1","result":null}');
    bad[10] = 'X'.charCodeAt(0);
    const frames = new FrameDecoder().feed(Buffer.concat([Buffer.from([0xff, 0x00]), bad, good]));
    expect(frames[0]).toMatchObject({ kind: 'garbage', reason: 'bytes before STX' });
    expect(frames.some((f) => f.kind === 'garbage' && f.reason === 'CRC mismatch')).toBe(true);
    expect(frames.at(-1)).toEqual({ kind: 'response', json: '{"id":"2","result":null}', crcLittleEndian: false });
  });

  it('reads a request frame with its key (a simulated terminal reads ours)', () => {
    const key = apiKeyBytes('0a0b0c0d')!;
    const [f] = new FrameDecoder().feed(requestFrame(key, docsPayload));
    expect(f).toMatchObject({ kind: 'request', json: docsPayload });
    expect(f.kind === 'request' && hex(f.apiKey)).toBe('0A 0B 0C 0D');
  });
});
