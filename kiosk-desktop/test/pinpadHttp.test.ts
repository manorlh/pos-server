import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { certFingerprint, postFrame, tlsRefused, tryParse } from '../src/main/payment/pinpadHttp';
import { saleFrame, statusFrame } from '../src/core/nayax';

let server: http.Server;
let port = 0;
const seen: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders; body: string }> = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      if (req.url === '/chunked') {
        res.setHeader('Content-Type', 'application/json');
        res.write('{"jsonrpc":"2.0","id":"1",');
        res.end('"result":{"statusCode":0}}');
        return;
      }
      if (req.url === '/err') {
        res.statusCode = 500;
        return res.end('boom');
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: '1', result: { statusCode: 0, echo: JSON.parse(body).method } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => server.close());

describe('the pinpad’s HTTP transport (one POST per frame, Connection: close)', () => {
  it('posts the frame as JSON and reads a Content-Length reply', async () => {
    const r = await postFrame({ host: '127.0.0.1', port, path: '/SPICy', tls: false }, statusFrame(), 3_000, null);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body).result.echo).toBe('getStatus');
    const last = seen[seen.length - 1];
    expect(last).toMatchObject({ method: 'POST', url: '/SPICy' });
    expect(last.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(last.headers.connection).toBe('close');
  });

  it('reads a chunked reply', async () => {
    const r = await postFrame({ host: '127.0.0.1', port, path: '/chunked', tls: false }, saleFrame(100, 'v'), 3_000, null);
    expect(JSON.parse(r.body).result.statusCode).toBe(0);
  });

  it('answers any status (the caller decides), fails on no connection', async () => {
    expect((await postFrame({ host: '127.0.0.1', port, path: '/err', tls: false }, statusFrame(), 3_000, null)).status).toBe(500);
    await expect(postFrame({ host: '127.0.0.1', port: 1, path: '/', tls: false }, statusFrame(), 2_000, null)).rejects.toThrow();
  });

  it('a TLS handshake against an HTTP-only pinpad reads as "TLS refused"', async () => {
    const e = await postFrame({ host: '127.0.0.1', port, path: '/SPICy', tls: true }, statusFrame(), 3_000, null).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Error);
    expect(tlsRefused(e)).toBe(true);
  });
});

describe('helpers', () => {
  it('fingerprints a certificate as the till pins it (SHA-256 of the DER, "AB:CD:…")', () => {
    expect(certFingerprint(Buffer.from('x'))).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  });

  it('parses a complete response only', () => {
    expect(tryParse(Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhel'))).toBe(null);
    expect(tryParse(Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello'))).toEqual({ status: 200, body: 'hello' });
    expect(tryParse(Buffer.from('HTTP/1.1 200 OK\r\n\r\nto the end'), true)).toEqual({ status: 200, body: 'to the end' });
  });
});
