/**
 * The kiosk's print queue (SQLite `print_jobs`): receipts, bons, pickup slips and Zs, printed
 * automatically, one at a time, never with a dialog. A job is drawn (renderer: the hidden print
 * window's canvas, as the till draws its bitmaps), turned into a 1-bit raster and ESC/POS
 * (core/escpos.ts), and sent through the transport. A job that fails is tried again a few times;
 * the payment never waits for paper (a bon that does not print is a staff alert, never a second
 * charge).
 */

import { randomUUID } from 'node:crypto';
import { centreOn, job, receiptContentWidth, RASTER_80MM, toMono, trimBottom, type MonoBitmap } from '../../core/escpos';
import type { PrintDoc } from '../../core/printDocs';
import type { Db } from '../db/sqlite';
import type { PrinterHealth, PrinterTarget, Transport } from './transports';

export type JobStatus = 'queued' | 'sending' | 'sent' | 'failed';
export type JobKind = 'receipt' | 'bon' | 'slip' | 'z' | 'test';

export interface PrintJob {
  id: string;
  kind: JobKind;
  ref_id: string | null;
  target: string;
  doc: string;
  status: JobStatus;
  attempts: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

/** A drawn page: RGBA pixels (canvas order). */
export interface DrawnPage {
  width: number;
  height: number;
  rgba: Uint8Array;
}

/** Draws a document at its print width (the receipt at 540 = 384 scaled, the bon natively at 576). */
export type PageRenderer = (doc: PrintDoc, widthDots: number) => Promise<DrawnPage>;

const MAX_ATTEMPTS = 3;

export class PrintQueue {
  private working = false;
  private listeners = new Set<() => void>();
  lastOkAt: number | null = null;
  lastFailure: { at: number; error: string; health: PrinterHealth } | null = null;

  constructor(
    private readonly db: Db,
    private readonly transport: Transport,
    private readonly target: () => PrinterTarget,
    private renderer: PageRenderer | null,
    private readonly log: (m: string) => void = () => undefined,
  ) {}

  /** A page is on its way (the USB look waits: both go through the one spooler helper). */
  get busy(): boolean {
    return this.working;
  }

  setRenderer(r: PageRenderer | null) {
    this.renderer = r;
    void this.work();
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }

  /** Queue a page; returns the job id (written before anything is printed). */
  enqueue(kind: JobKind, refId: string | null, doc: PrintDoc): string {
    const id = randomUUID();
    const now = Date.now();
    this.db.run(
      'INSERT INTO print_jobs (id, kind, ref_id, target, doc, status, attempts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)',
      id,
      kind,
      refId,
      'receipt',
      JSON.stringify(doc),
      'queued',
      now,
      now,
    );
    queueMicrotask(() => void this.work());
    return id;
  }

  job(id: string): PrintJob | null {
    return this.db.get<PrintJob>('SELECT * FROM print_jobs WHERE id = ?', id) ?? null;
  }

  jobsFor(refId: string, kind?: JobKind): PrintJob[] {
    return kind
      ? this.db.all<PrintJob>('SELECT * FROM print_jobs WHERE ref_id = ? AND kind = ? ORDER BY created_at', refId, kind)
      : this.db.all<PrintJob>('SELECT * FROM print_jobs WHERE ref_id = ? ORDER BY created_at', refId);
  }

  failedCount(sinceMs: number): number {
    return this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM print_jobs WHERE status = 'failed' AND created_at >= ?", sinceMs)?.n ?? 0;
  }

  /** Jobs left half-way by a crash are queued again; old ones are dropped (a week). */
  recover() {
    this.db.run("UPDATE print_jobs SET status = 'queued' WHERE status = 'sending'");
    this.db.run('DELETE FROM print_jobs WHERE created_at < ?', Date.now() - 7 * 86_400_000);
  }

  retryFailed(refId?: string) {
    if (refId) this.db.run("UPDATE print_jobs SET status = 'queued', attempts = 0 WHERE status = 'failed' AND ref_id = ?", refId);
    else this.db.run("UPDATE print_jobs SET status = 'queued', attempts = 0 WHERE status = 'failed'");
    void this.work();
  }

  async work(): Promise<void> {
    if (this.working || !this.renderer) return;
    this.working = true;
    try {
      for (;;) {
        const next = this.db.get<PrintJob>("SELECT * FROM print_jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1");
        if (!next) break;
        this.db.run("UPDATE print_jobs SET status = 'sending', attempts = attempts + 1, updated_at = ? WHERE id = ?", Date.now(), next.id);
        this.emit();
        try {
          const bytes = await this.bytesOf(JSON.parse(next.doc) as PrintDoc);
          await this.transport.send(this.target(), bytes);
          this.db.run("UPDATE print_jobs SET status = 'sent', last_error = NULL, updated_at = ? WHERE id = ?", Date.now(), next.id);
          this.lastOkAt = Date.now();
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          this.log(`print ${next.kind}: ${msg}`);
          const attempts = next.attempts + 1;
          const health = await this.transport
            .status(this.target())
            .then((s) => s.health)
            .catch(() => 'unknown' as PrinterHealth);
          this.lastFailure = { at: Date.now(), error: msg, health: health === 'ok' ? 'error' : health };
          this.db.run('UPDATE print_jobs SET status = ?, last_error = ?, updated_at = ? WHERE id = ?', attempts >= MAX_ATTEMPTS ? 'failed' : 'queued', msg.slice(0, 500), Date.now(), next.id);
          if (attempts < MAX_ATTEMPTS) {
            this.emit();
            await new Promise((r) => setTimeout(r, 1_500 * attempts));
          }
        }
        this.emit();
      }
    } finally {
      this.working = false;
    }
  }

  /** A document → ESC/POS: drawn, 1-bit by the till's threshold, centred on 576, cut. */
  async bytesOf(doc: PrintDoc): Promise<Uint8Array> {
    if (!this.renderer) throw new Error('no renderer');
    const width = doc.kind === 'bon' ? RASTER_80MM : receiptContentWidth(RASTER_80MM);
    const page = await this.renderer(doc, width);
    const mono: MonoBitmap = trimBottom(toMono(page.rgba, page.width, page.height), 24);
    return job(centreOn(mono, RASTER_80MM), { cut: true });
  }

  /** The printer as the last print left it (never a query over a payment). */
  health(): 'ok' | 'unknown' | PrinterHealth {
    if (!this.lastFailure) return this.lastOkAt ? 'ok' : 'unknown';
    if (this.lastOkAt && this.lastOkAt > this.lastFailure.at) return 'ok';
    return this.lastFailure.health;
  }
}
