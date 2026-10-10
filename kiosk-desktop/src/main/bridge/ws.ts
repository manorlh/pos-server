/**
 * Just enough WebSocket (RFC 6455) for the bridge's event stream: the handshake, text frames from
 * the bridge to the page, and the page's ping / close (its frames are masked and tiny). No
 * extensions, no fragmentation on the way out; anything else from the page closes the socket.
 */

import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_IN = 64 * 1024;

export function acceptKey(key: string): string {
  return createHash('sha1').update(key + GUID).digest('base64');
}

/** One unmasked frame (server → client). */
export function encodeFrame(opcode: number, payload: Uint8Array): Buffer {
  const len = payload.length;
  let head: Buffer;
  if (len < 126) head = Buffer.from([0x80 | opcode, len]);
  else if (len < 65_536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode;
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, Buffer.from(payload)]);
}

export interface InFrame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
}

/** The complete frames at the start of `buf` (masked or not), and what is left. */
export function decodeFrames(buf: Buffer): { frames: InFrame[]; rest: Buffer; error?: string } {
  const frames: InFrame[] = [];
  let at = 0;
  while (buf.length - at >= 2) {
    const b0 = buf[at];
    const b1 = buf[at + 1];
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let off = at + 2;
    if (len === 126) {
      if (buf.length - off < 2) break;
      len = buf.readUInt16BE(off);
      off += 2;
    } else if (len === 127) {
      if (buf.length - off < 8) break;
      const big = buf.readBigUInt64BE(off);
      if (big > BigInt(MAX_IN)) return { frames, rest: Buffer.alloc(0), error: 'frame too big' };
      len = Number(big);
      off += 8;
    }
    if (len > MAX_IN) return { frames, rest: Buffer.alloc(0), error: 'frame too big' };
    const maskLen = masked ? 4 : 0;
    if (buf.length - off < maskLen + len) break;
    const mask = masked ? buf.subarray(off, off + 4) : null;
    off += maskLen;
    const payload = Buffer.from(buf.subarray(off, off + len));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    frames.push({ fin: (b0 & 0x80) !== 0, opcode: b0 & 0x0f, payload });
    at = off + len;
  }
  return { frames, rest: buf.subarray(at) };
}

export class WsConnection {
  private buf: Buffer = Buffer.alloc(0);
  private closed = false;
  private closeFns = new Set<() => void>();
  private pingTimer: NodeJS.Timeout;

  constructor(private readonly socket: Duplex) {
    socket.on('data', (d: Buffer) => this.onData(d));
    socket.on('close', () => this.finish());
    socket.on('error', () => this.finish());
    // A ping every 25 s keeps the socket (and anything between) awake.
    this.pingTimer = setInterval(() => this.write(encodeFrame(0x9, Buffer.alloc(0))), 25_000);
    this.pingTimer.unref?.();
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  send(message: unknown) {
    this.write(encodeFrame(0x1, Buffer.from(JSON.stringify(message), 'utf8')));
  }

  close(code = 1000) {
    if (this.closed) return;
    const body = Buffer.alloc(2);
    body.writeUInt16BE(code, 0);
    this.write(encodeFrame(0x8, body));
    this.socket.end();
    this.finish();
  }

  onClose(fn: () => void): () => void {
    this.closeFns.add(fn);
    return () => this.closeFns.delete(fn);
  }

  private write(b: Buffer) {
    if (this.closed) return;
    try {
      this.socket.write(b);
    } catch {
      this.finish();
    }
  }

  private onData(d: Buffer) {
    this.buf = Buffer.concat([this.buf, d]);
    const r = decodeFrames(this.buf);
    this.buf = r.rest;
    if (r.error) return this.close(1009);
    for (const f of r.frames) {
      if (f.opcode === 0x8) return this.close(1000);
      if (f.opcode === 0x9) this.write(encodeFrame(0xa, f.payload));
      // Text / binary / pong from the page: nothing to do (the page only listens).
    }
  }

  private finish() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.pingTimer);
    for (const fn of this.closeFns) fn();
    this.closeFns.clear();
    this.socket.destroy();
  }
}

/** Completes the handshake (the caller checked the origin and the signature); null when it is no WebSocket request. */
export function acceptUpgrade(req: IncomingMessage, socket: Duplex, extraHeaders: Record<string, string> = {}): WsConnection | null {
  const key = req.headers['sec-websocket-key'];
  const upgrade = String(req.headers.upgrade ?? '').toLowerCase();
  if (upgrade !== 'websocket' || typeof key !== 'string' || !key) return null;
  const lines = ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${acceptKey(key)}`];
  for (const [k, v] of Object.entries(extraHeaders)) lines.push(`${k}: ${v}`);
  socket.write(`${lines.join('\r\n')}\r\n\r\n`);
  return new WsConnection(socket);
}

/** A refusal before the handshake. */
export function refuseUpgrade(socket: Duplex, status: number, text: string) {
  try {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } finally {
    socket.destroy();
  }
}
