/**
 * A fake ESC/POS printer for the tests and the print smoke runs (scripts/print-e2e.ts) — nothing here talks to a real
 * printer:
 *
 *  - `FakePrinter`: a TCP server (port 9100 style, loopback by default) that keeps every byte each connection sent,
 *    answers `DLE EOT 1 / 2 / 4` at once as a real head does (paper ok / near end / out, cover open, offline — set by the
 *    test), and can refuse or hang a connection;
 *  - `parseEscPos`: the bytes read back as the head would — INIT, `GS v 0` raster bands joined into pages, feeds, cuts,
 *    the drawer's `ESC p` pulses, the buzzer, the status questions — and whatever it did not understand;
 *  - `pagePng` / `writePagePngs`: a page as a 1-bit PNG (core/monoPng.ts) to look at: Hebrew, width, logo, cut.
 *
 * A "job" is one connection that carried more than status questions: what `tcpSend` sends for one print.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { MonoBitmap } from '../src/core/escpos';
import { encodeMonoPng } from '../src/core/monoPng';

export type FakePaper = 'ok' | 'near_end' | 'out';

export interface FakePrinterState {
  paper: FakePaper;
  coverOpen: boolean;
  offline: boolean;
  /** The head's width in dots: a raster row wider than this is "cut" (recorded in `overflow`). */
  widthDots: number;
  /** Connections refused (closed at once) while true — a printer that is off. */
  refuse: boolean;
  /** Status questions left unanswered (an old printer, or one that does not speak DLE EOT). */
  mute: boolean;
  /** The roll ends on the n-th picture this printer gets (1 = the first): paper `out` from its raster on. */
  runOutOnPage: number | null;
}

export interface DrawerPulse {
  pin: 2 | 5;
  onMs: number;
  offMs: number;
}

export type EscPosEvent =
  | { op: 'init' }
  | { op: 'raster'; widthDots: number; rows: number }
  | { op: 'feed'; lines: number }
  | { op: 'cut'; partial: boolean }
  | { op: 'kick'; pulse: DrawerPulse }
  | { op: 'beep'; times: number; ms: number }
  | { op: 'status'; n: number }
  | { op: 'unknown'; byte: number; at: number };

export interface ParsedEscPos {
  events: EscPosEvent[];
  /** The pictures: the raster bands from one INIT / cut to the next joined. */
  pages: MonoBitmap[];
  cuts: number;
  kicks: DrawerPulse[];
  beeps: number;
  statusQueries: number;
  /** Bytes that were no command this printer knows (a text job, garbage). */
  unknown: number;
  /** Rows wider than the head ([FakePrinterState.widthDots]): printed cut. */
  overflow: boolean;
}

export interface CapturedJob {
  /** 1, 2, … in the order the connections opened. */
  seq: number;
  bytes: Uint8Array;
  parsed: ParsedEscPos;
  /** What the printer looked like when the job came: with no paper or the cover open nothing reaches the paper. */
  printed: boolean;
  at: number;
}

const ESC = 0x1b;
const GS = 0x1d;
const DLE = 0x10;
const EOT = 0x04;

/** The answer to `DLE EOT n` for a state (fixed bits 0x12, as validStatusByte expects). */
export function statusByte(n: number, s: Pick<FakePrinterState, 'paper' | 'coverOpen' | 'offline'>): number {
  let b = 0x12;
  if (n === 1) {
    if (s.offline || s.coverOpen || s.paper === 'out') b |= 0x08;
  } else if (n === 2) {
    if (s.coverOpen) b |= 0x04;
    if (s.paper === 'out') b |= 0x20;
  } else if (n === 4) {
    if (s.paper === 'near_end') b |= 0x0c;
    if (s.paper === 'out') b |= 0x6c;
  }
  return b;
}

function joinPage(bands: Array<{ widthBytes: number; rows: number; data: Uint8Array }>): MonoBitmap {
  const rowBytes = Math.max(...bands.map((b) => b.widthBytes));
  const height = bands.reduce((n, b) => n + b.rows, 0);
  const data = new Uint8Array(rowBytes * height);
  let y = 0;
  for (const b of bands) {
    for (let r = 0; r < b.rows; r++) data.set(b.data.subarray(r * b.widthBytes, (r + 1) * b.widthBytes), (y + r) * rowBytes);
    y += b.rows;
  }
  return { width: rowBytes * 8, height, rowBytes, data };
}

/** The bytes as the head reads them (the commands the app sends; see core/escpos.ts). */
export function parseEscPos(bytes: Uint8Array, widthDots = 576): ParsedEscPos {
  const events: EscPosEvent[] = [];
  const pages: MonoBitmap[] = [];
  let bands: Array<{ widthBytes: number; rows: number; data: Uint8Array }> = [];
  const out: ParsedEscPos = { events, pages, cuts: 0, kicks: [], beeps: 0, statusQueries: 0, unknown: 0, overflow: false };
  const flush = () => {
    if (bands.length > 0) pages.push(joinPage(bands));
    bands = [];
  };
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    const n1 = bytes[i + 1];
    if (b === ESC && n1 === 0x40) {
      events.push({ op: 'init' });
      i += 2;
    } else if (b === ESC && n1 === 0x64 && i + 2 < bytes.length) {
      events.push({ op: 'feed', lines: bytes[i + 2] });
      i += 3;
    } else if (b === ESC && n1 === 0x70 && i + 4 < bytes.length) {
      const pulse: DrawerPulse = { pin: bytes[i + 2] === 1 || bytes[i + 2] === 0x31 ? 5 : 2, onMs: bytes[i + 3] * 2, offMs: bytes[i + 4] * 2 };
      events.push({ op: 'kick', pulse });
      out.kicks.push(pulse);
      i += 5;
    } else if (b === ESC && n1 === 0x42 && i + 3 < bytes.length) {
      events.push({ op: 'beep', times: bytes[i + 2], ms: bytes[i + 3] * 100 });
      out.beeps += 1;
      i += 4;
    } else if (b === GS && n1 === 0x76 && bytes[i + 2] === 0x30 && i + 7 < bytes.length) {
      const widthBytes = bytes[i + 4] | (bytes[i + 5] << 8);
      const rows = bytes[i + 6] | (bytes[i + 7] << 8);
      const len = widthBytes * rows;
      const data = bytes.slice(i + 8, i + 8 + len);
      if (widthBytes * 8 > widthDots) out.overflow = true;
      bands.push({ widthBytes, rows, data });
      events.push({ op: 'raster', widthDots: widthBytes * 8, rows });
      i += 8 + len;
    } else if (b === GS && n1 === 0x56 && i + 2 < bytes.length) {
      const m = bytes[i + 2];
      // GS V 65/66 n (function B, with a feed), GS V 0/1/48/49 (function A).
      const withN = m === 65 || m === 66;
      events.push({ op: 'cut', partial: m === 1 || m === 49 || m === 66 });
      out.cuts += 1;
      flush();
      i += withN ? 4 : 3;
    } else if (b === DLE && n1 === EOT && i + 2 < bytes.length) {
      events.push({ op: 'status', n: bytes[i + 2] });
      out.statusQueries += 1;
      i += 3;
    } else {
      events.push({ op: 'unknown', byte: b, at: i });
      out.unknown += 1;
      i += 1;
    }
  }
  flush();
  return out;
}

/** A page as a PNG (black on white, 1 bit a dot). */
export function pagePng(page: MonoBitmap): Buffer {
  return encodeMonoPng(page);
}

/** Every page of [jobs] as `<dir>/<prefix>-<n>.png`; the files written. */
export function writePagePngs(dir: string, prefix: string, jobs: readonly CapturedJob[]): string[] {
  mkdirSync(dir, { recursive: true });
  const files: string[] = [];
  let n = 0;
  for (const j of jobs) {
    for (const p of j.parsed.pages) {
      n += 1;
      const f = path.join(dir, `${prefix}${jobs.length > 1 || j.parsed.pages.length > 1 ? `-${n}` : ''}.png`);
      writeFileSync(f, pagePng(p));
      files.push(f);
    }
  }
  return files;
}

/**
 * The printer: listens on [host]:[port] (0 — any free port), one job per connection that sent more than status
 * questions. `wait(n)` resolves once [n] jobs came (or throws after the timeout).
 */
export class FakePrinter {
  readonly state: FakePrinterState;
  readonly jobs: CapturedJob[] = [];
  /** Connections that only asked for the status (`tcpStatus`, the scan, the pre-print check). */
  statusConnections = 0;
  connections = 0;
  private server: net.Server | null = null;
  private seq = 0;
  private rasters = 0;
  private sockets = new Set<net.Socket>();
  private waiters: Array<{ n: number; resolve: () => void }> = [];
  address: { host: string; port: number } | null = null;

  constructor(
    state: Partial<FakePrinterState> = {},
    private readonly host = '127.0.0.1',
    private readonly port = 0,
  ) {
    this.state = { paper: 'ok', coverOpen: false, offline: false, widthDots: 576, refuse: false, mute: false, runOutOnPage: null, ...state };
  }

  start(): Promise<{ host: string; port: number }> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((s) => this.accept(s));
      server.once('error', reject);
      server.listen(this.port, this.host, () => {
        const a = server.address() as net.AddressInfo;
        this.address = { host: this.host, port: a.port };
        resolve(this.address);
      });
      this.server = server;
    });
  }

  private accept(s: net.Socket) {
    this.connections += 1;
    if (this.state.refuse) {
      s.destroy();
      return;
    }
    this.sockets.add(s);
    const chunks: Buffer[] = [];
    const at = Date.now();
    // Answers DLE EOT at once (real-time commands), even mid-job.
    let tail = Buffer.alloc(0);
    let sawRaster = false;
    s.on('data', (d: Buffer) => {
      chunks.push(d);
      const buf = Buffer.concat([tail, d]);
      if (this.state.runOutOnPage !== null && !sawRaster) {
        for (let i = 0; i + 2 < buf.length; i++) {
          if (buf[i] === GS && buf[i + 1] === 0x76 && buf[i + 2] === 0x30) {
            sawRaster = true;
            this.rasters += 1;
            if (this.rasters >= this.state.runOutOnPage) this.state.paper = 'out';
            break;
          }
        }
      }
      for (let i = 0; i + 2 < buf.length; i++) {
        if (buf[i] === DLE && buf[i + 1] === EOT && !this.state.mute) s.write(Buffer.of(statusByte(buf[i + 2], this.state)));
      }
      tail = buf.subarray(Math.max(0, buf.length - 2));
    });
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      this.sockets.delete(s);
      const bytes = new Uint8Array(Buffer.concat(chunks));
      if (bytes.length === 0) return;
      const parsed = parseEscPos(bytes, this.state.widthDots);
      const onlyStatus = parsed.events.every((e) => e.op === 'status');
      if (onlyStatus) {
        this.statusConnections += 1;
        return;
      }
      this.seq += 1;
      this.jobs.push({ seq: this.seq, bytes, parsed, printed: this.state.paper !== 'out' && !this.state.coverOpen && !this.state.offline, at });
      this.waiters = this.waiters.filter((w) => {
        if (this.jobs.length >= w.n) {
          w.resolve();
          return false;
        }
        return true;
      });
    };
    s.on('end', () => {
      s.end();
      done();
    });
    s.on('error', () => done());
    s.on('close', () => done());
  }

  /** Resolves once [n] jobs in all came. */
  wait(n: number, timeoutMs = 10_000): Promise<void> {
    if (this.jobs.length >= n) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`fake printer: ${this.jobs.length} of ${n} jobs after ${timeoutMs} ms`)), timeoutMs);
      this.waiters.push({
        n,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
      });
    });
  }

  /** Every drawer pulse of every job. */
  kicks(): DrawerPulse[] {
    return this.jobs.flatMap((j) => j.parsed.kicks);
  }

  /** The jobs that drew a page (receipts, tickets…), not a bare drawer pulse. */
  pageJobs(): CapturedJob[] {
    return this.jobs.filter((j) => j.parsed.pages.length > 0);
  }

  reset() {
    this.jobs.length = 0;
    this.statusConnections = 0;
    this.connections = 0;
    this.seq = 0;
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    this.server = null;
  }
}
