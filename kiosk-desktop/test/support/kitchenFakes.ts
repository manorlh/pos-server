/**
 * Fakes for the kitchen tests (main/kitchen): a network kitchen printer on TCP (answers `DLE EOT`, records every
 * ticket), the shop's print server on the LAN (an Android till's `/kitchen/jobs`, with the shop's secret), the cloud
 * (a fetch that can be switched off) and the print window (a white page per ticket). Nothing here reaches a real
 * printer, a real till or the real cloud — everything listens on 127.0.0.1.
 */

import http from 'node:http';
import net from 'node:net';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, type Db } from '../../src/main/db/sqlite';
import { Kv, migrate } from '../../src/main/db/schema';
import { Api } from '../../src/main/sync/api';
import type { PrintDoc } from '../../src/core/printDocs';
import type { DrawnPage, PageRenderer } from '../../src/main/printer/printQueue';
import { lanCall, tcpPrinterLink, type LanCall } from '../../src/main/kitchen/kitchenNet';

export const MACHINE = 'aaaaaaaa-1111-4222-8333-444444444444';
export const PRINT_KEY = 'test-shop-print-key-0123456789';

/* ------------------------------------------------------------------ a kitchen printer on TCP 9100 */

/** `off`: the connection is dropped at once (a printer that is off / unplugged, without waiting out a dead address). */
export type PrinterMood = 'ready' | 'no_paper' | 'cover_open' | 'silent' | 'paper_out_after' | 'off';

/** A raw network printer: answers `DLE EOT 1/2/4` by its mood, records each ticket (INIT … the next INIT / the close). */
export class FakeNetPrinter {
  readonly server: net.Server;
  port = 0;
  mood: PrinterMood = 'ready';
  /** Every connection's bytes (status queries left out), one entry per connection that sent a ticket. */
  readonly received: Buffer[] = [];
  connections = 0;
  queries = 0;
  /** After a ticket: the mood to switch to (paper ran out on it). */
  private printedOne = false;

  constructor() {
    this.server = net.createServer((sock) => this.serve(sock));
  }

  async listen(): Promise<this> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', () => r()));
    this.port = (this.server.address() as net.AddressInfo).port;
    return this;
  }

  close(): Promise<void> {
    return new Promise((r) => this.server.close(() => r()));
  }

  /** The tickets printed (each starts with ESC @). */
  tickets(): Buffer[] {
    const out: Buffer[] = [];
    for (const b of this.received) {
      let at = b.indexOf(Buffer.from([0x1b, 0x40]));
      while (at >= 0) {
        const next = b.indexOf(Buffer.from([0x1b, 0x40]), at + 2);
        out.push(b.subarray(at, next < 0 ? b.length : next));
        at = next;
      }
    }
    return out;
  }

  private statusByte(n: number): number {
    const mood = this.mood === 'paper_out_after' ? (this.printedOne ? 'no_paper' : 'ready') : this.mood;
    if (n === 1) return 0x12;
    if (n === 2) return mood === 'no_paper' ? 0x32 : mood === 'cover_open' ? 0x16 : 0x12;
    return mood === 'no_paper' ? 0x72 : 0x12;
  }

  private serve(sock: net.Socket) {
    this.connections++;
    if (this.mood === 'off') {
      sock.on('error', () => undefined);
      sock.destroy();
      return;
    }
    const data: number[] = [];
    let buf = Buffer.alloc(0);
    let inJob = false;
    let rasterLeft = 0;
    sock.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      let i = 0;
      while (i < buf.length) {
        if (rasterLeft > 0) {
          const n = Math.min(rasterLeft, buf.length - i);
          for (let k = 0; k < n; k++) data.push(buf[i + k]);
          rasterLeft -= n;
          i += n;
          continue;
        }
        const b = buf[i];
        if (b === 0x10) {
          if (buf.length - i < 3) break;
          if (buf[i + 1] === 0x04) {
            this.queries++;
            if (this.mood !== 'silent') sock.write(Buffer.from([this.statusByte(buf[i + 2])]));
            i += 3;
            continue;
          }
        }
        if (b === 0x1d && buf[i + 1] === 0x76) {
          if (buf.length - i < 8) break;
          const x = buf[i + 4] | (buf[i + 5] << 8);
          const y = buf[i + 6] | (buf[i + 7] << 8);
          for (let k = 0; k < 8; k++) data.push(buf[i + k]);
          rasterLeft = x * y;
          i += 8;
          continue;
        }
        if (b === 0x1b && buf[i + 1] === 0x40) inJob = true;
        if (b === 0x1d && buf[i + 1] === 0x56) this.printedOne = true;
        data.push(b);
        i++;
      }
      buf = buf.subarray(i);
    });
    sock.on('close', () => {
      if (inJob) {
        this.received.push(Buffer.from(data));
        this.printedOne = true;
      }
    });
    sock.on('error', () => undefined);
  }
}

/* ------------------------------------------------------------------ the shop's print server (an Android till) */

export type HostMood = 'ok' | 'lose_answer' | 'not_print_server' | 'busy';

export class FakeLanHost {
  readonly server: http.Server;
  port = 0;
  mood: HostMood = 'ok';
  /** Jobs taken, by id (a retried send is the same id: taken once). */
  readonly jobs = new Map<string, { body: Record<string, unknown>; status: string; times: number }>();
  readonly unauthorized: string[] = [];
  readonly requests: Array<{ method: string; path: string; caller: string | null }> = [];

  constructor(private readonly secret = PRINT_KEY) {
    this.server = http.createServer((req, res) => void this.handle(req, res));
  }

  async listen(): Promise<this> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', () => r()));
    this.port = (this.server.address() as net.AddressInfo).port;
    return this;
  }

  close(): Promise<void> {
    this.server.closeAllConnections?.();
    return new Promise((r) => this.server.close(() => r()));
  }

  /** The host printed it (its own queue): status done from now on. */
  print(id: string) {
    const j = this.jobs.get(id);
    if (j) j.status = 'done';
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://x');
    this.requests.push({ method: req.method ?? '', path: url.pathname, caller: (req.headers['x-till-id'] as string | undefined) ?? null });
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const answer = (status: number, body: unknown) => {
      const text = JSON.stringify(body);
      res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), Connection: 'close' });
      res.end(text);
    };
    if (req.headers.authorization !== `Bearer ${this.secret}`) {
      this.unauthorized.push(url.pathname);
      return answer(401, { detail: 'unauthorized' });
    }
    if (req.method === 'POST' && url.pathname === '/kitchen/jobs') {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      if (this.mood === 'not_print_server') return answer(409, { detail: 'not_the_print_server' });
      if (this.mood === 'busy') return answer(503, { detail: 'busy' });
      const id = String(body.id);
      const prev = this.jobs.get(id);
      this.jobs.set(id, { body, status: prev?.status ?? 'pending', times: (prev?.times ?? 0) + 1 });
      // Taken, and the answer lost on the way back: the sender cannot know.
      if (this.mood === 'lose_answer') {
        req.socket.destroy();
        return;
      }
      return answer(200, { id, status: this.jobs.get(id)!.status });
    }
    if (req.method === 'GET' && url.pathname === '/kitchen/jobs/status') {
      const ids = (url.searchParams.get('ids') ?? '').split(',').filter(Boolean);
      return answer(200, { jobs: ids.map((id) => ({ id, status: this.jobs.get(id)?.status ?? 'unknown', error: null })) });
    }
    return answer(404, { detail: 'not found' });
  }
}

/* ------------------------------------------------------------------ the cloud */

export interface CloudCall {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

/** The cloud as a fetch: answers by `METHOD path` (a `…*` key matches a prefix); `online = false` — no network. */
export class FakeCloud {
  online = true;
  readonly calls: CloudCall[] = [];
  readonly answers = new Map<string, (body: Record<string, unknown> | null, url: URL) => { status: number; body: unknown }>();

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const p = url.pathname.replace(/^\/(api\/v1\/)?/, '').replace(MACHINE, 'm');
    if (!this.online) throw new TypeError('fetch failed');
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    this.calls.push({ method, path: p, body });
    const key = `${method} ${p}`;
    const a = this.answers.get(key) ?? [...this.answers.entries()].find(([k]) => k.endsWith('*') && key.startsWith(k.slice(0, -1)))?.[1];
    const r = a ? a(body, url) : { status: 404, body: { detail: 'Not Found' } };
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } });
  };

  on(key: string, fn: (body: Record<string, unknown> | null, url: URL) => { status: number; body: unknown }) {
    this.answers.set(key, fn);
  }

  called(key: string): CloudCall[] {
    return this.calls.filter((c) => `${c.method} ${c.path}` === key || (key.endsWith('*') && `${c.method} ${c.path}`.startsWith(key.slice(0, -1))));
  }
}

/* ------------------------------------------------------------------ the print window, the database */

/** A page per document: white, [height] rows; every document drawn kept. */
export function fakeRenderer(height = 48): PageRenderer & { docs: Array<{ doc: PrintDoc; width: number }> } {
  const docs: Array<{ doc: PrintDoc; width: number }> = [];
  const fn = (async (doc: PrintDoc, width: number): Promise<DrawnPage> => {
    docs.push({ doc, width });
    const rgba = new Uint8Array(width * height * 4).fill(255);
    // A black bar on the first row: the ticket has ink.
    for (let x = 0; x < width; x++) rgba[x * 4] = rgba[x * 4 + 1] = rgba[x * 4 + 2] = 0;
    return { width, height, rgba };
  }) as PageRenderer & { docs: typeof docs };
  fn.docs = docs;
  return fn;
}

export function tempDb(): { db: Db; kv: Kv; dir: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kd-kitchen-'));
  const db = openDb(path.join(dir, 'kiosk.db'));
  migrate(db);
  return { db, kv: new Kv(db), dir };
}

/**
 * The LAN request with waits a busy test machine cannot run out of (the production ones are the Android till's: 1.5 s to
 * connect, 6 s to answer) — every fake answers at once; the full suite starts a hundred processes together.
 */
export const patientLanCall: LanCall = (target, secret, method, p, body, opts = {}) => lanCall(target, secret, method, p, body, { ...opts, connectMs: 5_000, readMs: 10_000 });

/** A printer link with the same patience (a fake printer answers its status at once). */
export const patientPrinterLink = (h: string, p: number) => tcpPrinterLink(h, p, { statusMs: 1_500, afterMs: 1_500, settleMs: 10, drainMs: 10, connectMs: 3_000 });

export function cloudApi(cloud: FakeCloud): Api {
  return new Api('http://cloud.test/api/v1/', () => 'machine-token', cloud.fetch);
}

/** A kitchen printer as the cloud sends it (`GET /sync/{m}/printers`). */
export function printer(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'p-kitchen',
    name: 'מטבח',
    purpose: 'kitchen',
    type: 'network',
    host: '127.0.0.1',
    port: 9100,
    isHost: false,
    inScope: true,
    paperWidth: 80,
    printWidthDots: null,
    copies: 1,
    cutPaper: true,
    beep: false,
    scope: 'shop',
    ticketStyle: null,
    ...over,
  };
}

/** Wait until [check] holds (polling), at most [ms]. */
export async function until(check: () => boolean | Promise<boolean>, ms = 4_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error('timed out waiting');
}
