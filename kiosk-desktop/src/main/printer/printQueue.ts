/**
 * The kiosk's print queue (SQLite `print_jobs`): receipts, bons, pickup slips and Zs, printed
 * automatically, one at a time, never with a dialog. A job is drawn (renderer: the hidden print
 * window's canvas, as the till draws its bitmaps), turned into a 1-bit raster and ESC/POS
 * (core/escpos.ts), and sent through the transport. A job that fails is tried again a few times;
 * the payment never waits for paper (a bon that does not print is a staff alert, never a second
 * charge).
 */

import { currentLook, type PrinterSeen } from '../../core/printerPaper';
import { randomUUID } from 'node:crypto';
import { centreOn, job, receiptContentWidth, RASTER_80MM, toMono, trimBottom, type MonoBitmap } from '../../core/escpos';
import type { PrintDoc } from '../../core/printDocs';
import type { Db } from '../db/sqlite';
import type { PrinterHealth, PrinterTarget, Transport } from './transports';

export type JobStatus = 'queued' | 'sending' | 'sent' | 'failed';
export type JobKind = 'receipt' | 'bon' | 'slip' | 'z' | 'test' | 'ticket';

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
  /** The last status probe (`probe`): what the printer said of itself with nothing printing. */
  probed: PrinterSeen | null = null;

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

  /** The hidden print window's drawing, as set (the kitchen tickets draw with it too: main/kitchen). */
  get pageRenderer(): PageRenderer | null {
    return this.renderer;
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

  /** The jobs of one kind that failed since then ("שובר פריט לא הודפס" looks closer only when there are any). */
  failedCountOf(kind: JobKind, sinceMs: number): number {
    return this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM print_jobs WHERE kind = ? AND status = 'failed' AND created_at >= ?", kind, sinceMs)?.n ?? 0;
  }

  /** Jobs left half-way by a crash are queued again; old ones are dropped (a week). */
  recover() {
    this.db.run("UPDATE print_jobs SET status = 'queued' WHERE status = 'sending'");
    this.db.run('DELETE FROM print_jobs WHERE created_at < ?', Date.now() - 7 * 86_400_000);
  }

  /**
   * The failed jobs queued again ("הדפסה חוזרת של מה שנכשל"), but for [except]: an item ticket is exchanged for goods, so
   * it prints again only as a person's reprint of its order, marked "הדפסה חוזרת" (core/kioskReprint.ts).
   */
  retryFailed(refId?: string, except: readonly JobKind[] = []) {
    const skip = except.length > 0 ? ` AND kind NOT IN (${except.map(() => '?').join(', ')})` : '';
    if (refId) this.db.run(`UPDATE print_jobs SET status = 'queued', attempts = 0 WHERE status = 'failed' AND ref_id = ?${skip}`, refId, ...except);
    else this.db.run(`UPDATE print_jobs SET status = 'queued', attempts = 0 WHERE status = 'failed'${skip}`, ...except);
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

  /**
   * The printer as last seen (core/printerPaper.ts `currentLook`): the newest of the last print that went through,
   * the last that failed and the last idle probe — never a query over a payment.
   */
  health(): 'ok' | 'unknown' | PrinterHealth {
    return currentLook([
      this.lastOkAt ? { at: this.lastOkAt, look: 'ok' } : null,
      this.lastFailure ? { at: this.lastFailure.at, look: this.lastFailure.health } : null,
      this.probed,
    ]);
  }

  /**
   * Asks the receipt printer how it is (`DLE EOT` on a network or a COM-port printer, the spooler's word on a USB one) — only with a
   * printer configured and nothing printing, so a roll that ran out is known (and reported, and shown) before the next
   * receipt fails. A probe that cannot tell changes nothing.
   */
  async probe(): Promise<void> {
    const target = this.target();
    const configured =
      (target.transport === 'tcp' && !!target.host) || (target.transport === 'spooler' && !!target.queueName) || (target.transport === 'serial' && !!target.comPort);
    if (!configured || this.working) return;
    const before = this.health();
    try {
      const { health } = await this.transport.status(target);
      if (this.working) return;
      this.probed = { at: Date.now(), look: health };
    } catch {
      return;
    }
    if (this.health() !== before) this.emit();
  }
}
