/**
 * The kitchen's wires, as the Android till's (pos-android hardware/kitchen/KitchenTransports.kt `NetworkTransport.link`,
 * KitchenLan.kt `KitchenLanClient`):
 *
 *  - a network kitchen printer on TCP 9100: one connection for the status read, the ticket and the status after it
 *    (core/kitchen/delivery.ts) — connect 3 s (a refused connect tried 3 times), a status byte 300 ms before the
 *    ticket and 800 ms after it, 4 KB writes counted (a write cut short says how much left);
 *  - the shop's print server ("שרת הדפסות") on the LAN: plain HTTP/1.1, one request per connection, the shop's print
 *    secret as the bearer (`Authorization: Bearer …`), short timeouts. A request that never connected sent nothing
 *    ([LanNotReached]: another way may be tried); one whose answer was lost may have been taken ([LanAnswerLost]: only
 *    the cloud may carry it on, by the same id).
 */

import net from 'node:net';
import { LanAnswerLost } from '../../core/kitchen/queue';
import { isStatusByte, PartialWrite, readiness, type PrinterLink, type PrinterReadiness } from '../../core/kitchen/delivery';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const CONNECT_TIMEOUT_MS = 3_000;
export const STATUS_READ_MS = 300;
export const AFTER_READ_MS = 800;
export const SETTLE_MS = 400;
export const DRAIN_MS = 150;
const CHUNK = 4_096;
const STATUS_READS = 6;

/** Connect, a refused / timed-out connect tried again (a printer busy with another device's ticket). */
async function connect(host: string, port: number, timeoutMs: number, tries = 3): Promise<net.Socket> {
  let last: unknown = null;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      return await new Promise<net.Socket>((resolve, reject) => {
        const s = net.connect({ host, port });
        s.setNoDelay(true);
        const timer = setTimeout(() => s.destroy(new Error(`${host}:${port} — no answer in ${timeoutMs / 1000}s`)), timeoutMs);
        s.once('connect', () => {
          clearTimeout(timer);
          resolve(s);
        });
        s.once('error', (e) => {
          clearTimeout(timer);
          reject(e);
        });
      });
    } catch (e) {
      last = e;
      const code = (e as { code?: string }).code;
      if (code !== 'ECONNREFUSED' && !/no answer/.test(String(e))) break;
      if (attempt < tries - 1) await sleep(400 + Math.random() * 600);
    }
  }
  const msg = last instanceof Error ? last.message : String(last);
  throw new Error(msg.includes(`${host}`) ? msg : `${host}:${port} — ${msg}`);
}

/** A network kitchen printer as a [PrinterLink]: one connection for one ticket. */
export function tcpPrinterLink(host: string, port: number, opts: { connectMs?: number; statusMs?: number; afterMs?: number; settleMs?: number; drainMs?: number } = {}): PrinterLink {
  let socket: net.Socket | null = null;
  let reads = 0;
  const inbox: number[] = [];
  let waiter: (() => void) | null = null;
  let closed = false;

  const nextByte = (timeoutMs: number): Promise<number | null> =>
    new Promise((resolve) => {
      if (inbox.length > 0) return resolve(inbox.shift()!);
      if (closed) return resolve(null);
      const timer = setTimeout(() => {
        waiter = null;
        resolve(null);
      }, timeoutMs);
      waiter = () => {
        clearTimeout(timer);
        waiter = null;
        resolve(inbox.length > 0 ? inbox.shift()! : null);
      };
    });

  const ask = async (query: number, timeoutMs: number): Promise<number | null> => {
    const s = socket;
    if (!s) return null;
    s.write(Uint8Array.of(0x10, 0x04, query));
    for (let i = 0; i < STATUS_READS; i++) {
      const b = await nextByte(timeoutMs);
      if (b === null) return null;
      if (isStatusByte(b)) return b;
    }
    return null;
  };

  return {
    async open() {
      socket = await connect(host, port, opts.connectMs ?? CONNECT_TIMEOUT_MS);
      socket.on('data', (d: Buffer) => {
        inbox.push(...d);
        waiter?.();
      });
      socket.on('close', () => {
        closed = true;
        waiter?.();
      });
      socket.on('error', () => {
        closed = true;
        waiter?.();
      });
    },
    async status(): Promise<PrinterReadiness | null> {
      const ms = reads++ === 0 ? (opts.statusMs ?? STATUS_READ_MS) : (opts.afterMs ?? AFTER_READ_MS);
      // Whatever the printer sent unasked (an Automatic Status Back block) is not an answer.
      inbox.length = 0;
      const printer = await ask(1, ms);
      if (printer === null) return null;
      const cause = await ask(2, ms);
      const paper = await ask(4, ms);
      return readiness(printer, cause, paper);
    },
    async write(bytes: Uint8Array) {
      const s = socket;
      if (!s || closed) throw new PartialWrite(0, new Error('connection reset by the printer'));
      let offset = 0;
      try {
        while (offset < bytes.length) {
          const n = Math.min(CHUNK, bytes.length - offset);
          const chunk = bytes.subarray(offset, offset + n);
          await new Promise<void>((resolve, reject) => {
            const onError = (e: Error) => reject(e);
            s.once('error', onError);
            const ok = s.write(chunk, (e) => {
              s.off('error', onError);
              if (e) reject(e);
              else resolve();
            });
            void ok;
          });
          if (closed) throw new Error('the printer closed the connection');
          offset += n;
        }
      } catch (e) {
        throw new PartialWrite(offset, e);
      }
    },
    settle: () => sleep(opts.settleMs ?? SETTLE_MS),
    drain: () => sleep(opts.drainMs ?? DRAIN_MS),
    close() {
      closed = true;
      socket?.end();
      const s = socket;
      setTimeout(() => s?.destroy(), 1_000).unref?.();
      socket = null;
    },
  };
}

/** Only connecting to a printer, nothing printed (the "מדפסות" screen's light). */
export async function probePrinter(host: string, port: number, timeoutMs = CONNECT_TIMEOUT_MS): Promise<boolean> {
  try {
    const s = await connect(host, port, timeoutMs, 1);
    s.destroy();
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ the shop's print server on the LAN */

/** The request never connected: nothing was sent — another way may be tried. */
export class LanNotReached extends Error {
  constructor(message: string) {
    super(`print server not reached: ${message}`);
    this.name = 'LanNotReached';
  }
}

export interface LanReply {
  status: number;
  body: unknown;
}

export interface LanCallOptions {
  connectMs?: number;
  readMs?: number;
  /** Who asks (`x-till-id`, `x-till-name` URL-encoded): the local server's "connected tills". */
  caller?: { id: string; name: string | null } | null;
}

/** One request to a LAN host. Throws [LanNotReached] (nothing sent) or [LanAnswerLost] (sent, no answer). */
export type LanCall = (target: { address: string; port: number }, secret: string, method: 'GET' | 'POST', path: string, body: unknown, opts?: LanCallOptions) => Promise<LanReply>;

export const lanCall: LanCall = async (target, secret, method, path, body, opts = {}) => {
  let socket: net.Socket;
  try {
    socket = await connect(target.address, target.port, opts.connectMs ?? 1_500, 1);
  } catch (e) {
    throw new LanNotReached(e instanceof Error ? e.message : String(e));
  }
  const payload = body === undefined || body === null ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body), 'utf8');
  const head = [
    `${method} ${path} HTTP/1.1`,
    `Host: ${target.address}:${target.port}`,
    `Authorization: Bearer ${secret}`,
    ...(opts.caller ? [`x-till-id: ${encodeURIComponent(opts.caller.id)}`, ...(opts.caller.name ? [`x-till-name: ${encodeURIComponent(opts.caller.name)}`] : [])] : []),
    'Connection: close',
    ...(method === 'POST' ? ['Content-Type: application/json; charset=utf-8'] : []),
    `Content-Length: ${payload.length}`,
    '',
    '',
  ].join('\r\n');
  return new Promise<LanReply>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new LanAnswerLost(`no answer in ${(opts.readMs ?? 6_000) / 1000}s`))), opts.readMs ?? 6_000);
    const parse = (): LanReply | null => {
      const all = Buffer.concat(chunks);
      const end = all.indexOf('\r\n\r\n');
      if (end < 0) return null;
      const lines = all.subarray(0, end).toString('utf8').split('\r\n');
      const status = Number(lines[0]?.split(' ')[1]);
      if (!Number.isInteger(status)) return null;
      const length = Number(lines.find((l) => /^content-length:/i.test(l))?.split(':')[1]?.trim() ?? NaN);
      const rest = all.subarray(end + 4);
      if (Number.isFinite(length) && rest.length < length) return null;
      const text = (Number.isFinite(length) ? rest.subarray(0, length) : rest).toString('utf8');
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = text;
      }
      return { status, body: parsed };
    };
    socket.on('data', (d: Buffer) => {
      chunks.push(d);
      const r = parse();
      if (r) finish(() => resolve(r));
    });
    socket.on('end', () => {
      const r = parse();
      finish(() => (r ? resolve(r) : reject(new LanAnswerLost('the connection closed without an answer'))));
    });
    socket.on('error', (e) => finish(() => reject(new LanAnswerLost(e.message))));
    socket.write(Buffer.concat([Buffer.from(head, 'utf8'), payload]));
  });
};
