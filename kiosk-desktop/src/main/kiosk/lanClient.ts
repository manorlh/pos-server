/**
 * One request to the shop's LAN host (the print server's tiny HTTP/1.1 server, pos-android
 * hardware/kitchen/KitchenLan.kt): plain HTTP on the LAN, the shop's print secret as the bearer,
 * one connection per request (`Connection: close`, no agent), a body with its length (never chunked
 * — the host reads `Content-Length`), short timeouts. Never throws: null when nothing came back.
 */

import http from 'node:http';
import { LAN_CONNECT_MS, LAN_READ_MS, type LanTarget } from '../../core/lanOpenOrders';

export interface LanAnswer {
  status: number;
  body: unknown;
}

export type LanPost = (target: LanTarget, path: string, body: unknown, opts?: { connectMs?: number; readMs?: number }) => Promise<LanAnswer | null>;

export const lanPost: LanPost = (target, path, body, opts = {}) =>
  new Promise<LanAnswer | null>((resolve) => {
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    let settled = false;
    let connectTimer: NodeJS.Timeout | null = null;
    let readTimer: NodeJS.Timeout | null = null;
    const done = (v: LanAnswer | null) => {
      if (settled) return;
      settled = true;
      if (connectTimer) clearTimeout(connectTimer);
      if (readTimer) clearTimeout(readTimer);
      resolve(v);
    };
    let req: http.ClientRequest;
    try {
      req = http.request(
        {
          host: target.address,
          port: target.port,
          path,
          method: 'POST',
          agent: false,
          headers: {
            Authorization: `Bearer ${target.secret}`,
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': payload.length,
            Connection: 'close',
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('error', () => done(null));
          res.on('end', () => {
            let parsed: unknown = null;
            try {
              parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            } catch {
              parsed = null;
            }
            done({ status: res.statusCode ?? 0, body: parsed });
          });
        },
      );
    } catch {
      done(null);
      return;
    }
    req.on('error', () => done(null));
    connectTimer = setTimeout(() => req.destroy(new Error('LAN host: no connection')), opts.connectMs ?? LAN_CONNECT_MS);
    req.on('socket', (socket) => {
      const connected = () => {
        if (connectTimer) clearTimeout(connectTimer);
        connectTimer = null;
        readTimer = setTimeout(() => req.destroy(new Error('LAN host: no answer')), opts.readMs ?? LAN_READ_MS);
      };
      if (!socket.connecting) connected();
      else socket.once('connect', connected);
    });
    req.end(payload);
  });
