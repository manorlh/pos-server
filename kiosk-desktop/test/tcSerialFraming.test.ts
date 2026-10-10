/**
 * TweezerComm on the C4's USB, as Nayax SPI frames it (libSPI.so SPIUtils::FrameMessage, read
 * statically — P:\specs\spi\PLAN.md §7): 02 | LEN (2, big-endian) | payload | CRC-16/ARC over
 * LEN+payload (high first) | 03. The same golden bytes as the Android till's TcSerialFramingTest,
 * so a correction after the first real C4 shows on both.
 */
import { describe, expect, it } from 'vitest';
import { SPI, type TcSerialRead } from '../src/core/tcSerialFraming';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const frames = (reads: TcSerialRead[]) => reads.flatMap((r) => (r.kind === 'frame' ? [r.text] : []));

describe('TweezerComm serial framing (SPI)', () => {
  it('the CRC is CRC-16/ARC (its check value)', () => {
    expect(SPI.crc(Buffer.from('123456789'))).toBe(0xbb3d);
    expect(SPI.crc(Buffer.alloc(0))).toBe(0);
  });

  it('a frame: STX, the length big-endian, the payload, the CRC high first, ETX', () => {
    expect(hex(SPI.frame('{"a":1}'))).toBe('0200077b2261223a317d6fce03');
    const status = '{"jsonrpc":"2.0","method":"getInternalStatus","params":["ashrait",{}],"id":"1"}';
    const framed = SPI.frame(status);
    expect(framed.length).toBe(status.length + 6);
    expect(hex(framed.subarray(0, 3))).toBe('02004f');
    expect(hex(framed.subarray(framed.length - 3))).toBe('1d4c03');
  });

  it('round trip, whole or a 64-byte USB packet at a time', () => {
    const payload = '{"jsonrpc":"2.0","result":{"statusCode":0,"vuid":"9970000000020","statusMessage":"עסקה אושרה"},"id":"7"}';
    const framed = SPI.frame(payload);
    expect(frames(SPI.decoder().feed(framed))).toEqual([payload]);
    const d = SPI.decoder();
    const got: TcSerialRead[] = [];
    for (let i = 0; i < framed.length; i += 64) got.push(...d.feed(framed.subarray(i, i + 64)));
    expect(frames(got)).toEqual([payload]);
    expect(d.pending).toBe(0);
  });

  it('garbage before a frame, a bad CRC and two frames in one packet', () => {
    const a = SPI.frame('{"id":"1"}');
    const b = SPI.frame('{"id":"2"}');
    const bad = Buffer.from(a);
    bad[5] = (bad[5] + 1) & 0xff;
    const reads = SPI.decoder().feed(Buffer.concat([Buffer.from('ff00', 'hex'), bad, a, b]));
    expect(frames(reads)).toEqual(['{"id":"1"}', '{"id":"2"}']);
    expect(reads.some((r) => r.kind === 'garbage' && r.why === 'bytes before STX')).toBe(true);
    expect(reads.some((r) => r.kind === 'garbage' && r.why === 'CRC')).toBe(true);
  });

  it('a false STX claiming a long frame never stalls a whole frame behind it', () => {
    const a = SPI.frame('{"id":"3"}');
    // 02 FF FF: "65535 bytes follow", then a real frame.
    const reads = SPI.decoder().feed(Buffer.concat([Buffer.from('02ffff', 'hex'), a]));
    expect(frames(reads)).toEqual(['{"id":"3"}']);
  });

  it('every choice is one option: a correction is one line', () => {
    const little = SPI.with({ lengthBigEndian: false, crcBigEndian: false });
    expect(hex(little.frame('{"a":1}'))).toBe('0207007b2261223a317da9b903');
    const payloadOnly = SPI.with({ crcCoversLength: false });
    const framed = payloadOnly.frame('{"a":1}');
    expect((framed[10] << 8) | framed[11]).toBe(payloadOnly.crc(Buffer.from('{"a":1}')));
    expect(frames(payloadOnly.decoder().feed(framed))).toEqual(['{"a":1}']);
    expect(SPI.describe()).toContain('CRC poly A001 init 0000 over LEN+payload, high first');
  });
});
