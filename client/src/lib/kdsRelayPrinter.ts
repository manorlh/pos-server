/**
 * The browser screen's printing through a till of the shop (pos-server app/services/kds_print.py, docs/SPEC_KDS.md §17):
 * where its bons go (`GET sync/{m}/kds/print`), a bon sent (`POST sync/{m}/kds/print-jobs`, the screen's own id — a
 * retried upload is the same job) and followed (`GET sync/{m}/kds/print-jobs/status`) until the till answers.
 *
 * Never blocks the screen: a bon is a line in a small tray — "שולח להדפסה…", "ממתין למדפסת — <קופה>", "הודפס בקופה
 * <קופה>" (gone by itself), "לא הודפס — נסו שוב" (with "נסו שוב": a new job, the old one can no longer print). Without a
 * connection the upload is tried again with the same id until the screen's wait (`remotePrintTimeoutSec`) is over.
 *
 * Pure of React and the DOM (timers and ids come in through `deps`); no `@/` imports.
 */

import type { ApiReply } from './kioskWebApi';
import { uuid4 } from './kdsScreenEngine';
import { jobPhase, jobText, relayWhyText, type JobPhase, type KdsPrintJob, type KdsPrintStatus, type RelayTicket } from './kdsPrint';

export interface RelayApi {
  get(path: string, opts?: { timeoutMs?: number }): Promise<ApiReply<unknown>>;
  post(path: string, body: unknown, opts?: { timeoutMs?: number }): Promise<ApiReply<unknown>>;
}

export interface RelayTimers {
  set(fn: () => void, ms: number): unknown;
  clear(id: unknown): void;
}

export interface TrayItem {
  id: string;
  /** "שולחן 12", "#17", "הדפסת בדיקה". */
  title: string;
  phase: JobPhase;
  host: string | null;
  text: string;
  error: string | null;
  test: boolean;
  /** When it was first sent (ms). */
  at: number;
}

/** How often a bon waiting for its till is looked at. */
export const POLL_MS = 2_000;
/** A failed upload (no connection) is tried again this often, with the same id. */
export const RESEND_MS = 3_000;
/** A printed bon leaves the tray after this. */
export const DONE_SHOWN_MS = 8_000;
/** The status (where bons go) is read again this often. */
export const STATUS_MS = 60_000;
/** The tray holds at most this many. */
export const TRAY_MAX = 5;

interface Entry {
  item: TrayItem;
  ticket: RelayTicket | null;
  /** The upload reached the cloud (a job exists). */
  sent: boolean;
  deadline: number;
}

function refusalCode(reply: ApiReply<unknown>): string | null {
  if (reply.kind !== 'refused') return null;
  const body = reply.body as { detail?: unknown } | null;
  const d = body && typeof body === 'object' ? body.detail : null;
  if (d && typeof d === 'object' && typeof (d as { code?: unknown }).code === 'string') return (d as { code: string }).code;
  return reply.detail;
}

export class KdsRelayPrinter {
  private current: KdsPrintStatus | null = null;
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<() => void>();
  private pollTimer: unknown = null;
  private statusTimer: unknown = null;
  private stopped = false;
  private polling = false;

  constructor(
    private readonly deps: {
      api: RelayApi;
      machineId: () => string | null;
      now?: () => number;
      uuid?: () => string;
      timers?: RelayTimers;
      log?: (m: string) => void;
    },
  ) {}

  private now() {
    return this.deps.now?.() ?? Date.now();
  }

  private uuid() {
    return this.deps.uuid?.() ?? uuid4();
  }

  private set(fn: () => void, ms: number): unknown {
    return this.deps.timers ? this.deps.timers.set(fn, ms) : setTimeout(fn, ms);
  }

  private clear(id: unknown) {
    if (id === null) return;
    if (this.deps.timers) this.deps.timers.clear(id);
    else clearTimeout(id as ReturnType<typeof setTimeout>);
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  private changed() {
    for (const fn of this.listeners) fn();
  }

  /* ------------------------------------------------------------------ status */

  status(): KdsPrintStatus | null {
    return this.current;
  }

  /** The screen prints through a till now: its path is the relay and a till is there to take it. */
  canPrint(): boolean {
    return this.current?.effectivePath === 'relay';
  }

  /** Reads where the bons go (and again every minute while started). */
  async refresh(): Promise<KdsPrintStatus | null> {
    const m = this.deps.machineId();
    if (!m) return this.current;
    const r = await this.deps.api.get(`sync/${m}/kds/print`, { timeoutMs: 15_000 });
    if (r.kind === 'ok' && r.body && typeof r.body === 'object') {
      this.current = r.body as KdsPrintStatus;
      this.changed();
    }
    return this.current;
  }

  start() {
    this.stopped = false;
    const loop = () => {
      void this.refresh().finally(() => {
        if (!this.stopped) this.statusTimer = this.set(loop, STATUS_MS);
      });
    };
    loop();
  }

  stop() {
    this.stopped = true;
    this.clear(this.pollTimer);
    this.clear(this.statusTimer);
    this.pollTimer = null;
    this.statusTimer = null;
  }

  /* -------------------------------------------------------------------- tray */

  items(): TrayItem[] {
    return [...this.entries.values()].map((e) => e.item).sort((a, b) => b.at - a.at);
  }

  dismiss(id: string) {
    if (this.entries.delete(id)) this.changed();
  }

  /** "נסו שוב": the same bon as a new job (the old one can no longer print). */
  async retry(id: string): Promise<{ ok: boolean; message?: string }> {
    const e = this.entries.get(id);
    if (!e || e.item.phase !== 'failed') return { ok: false };
    this.entries.delete(id);
    return this.print(e.ticket, e.item.title, { test: e.item.test });
  }

  /** Sends a bon (or a test: `ticket` null). Answers at once; the tray follows it. */
  async print(ticket: RelayTicket | null, title: string, opts: { test?: boolean } = {}): Promise<{ ok: boolean; message?: string }> {
    const test = !!opts.test || ticket === null;
    const id = this.uuid();
    const wait = Math.max(20, this.current?.timeoutSec ?? 20) * 1000;
    const item: TrayItem = { id, title, phase: 'sending', host: this.current?.relay?.hostName ?? null, text: jobText('sending', null), error: null, test, at: this.now() };
    this.entries.set(id, { item, ticket, sent: false, deadline: this.now() + wait });
    for (const old of this.items().slice(TRAY_MAX)) this.entries.delete(old.id);
    this.changed();
    return this.upload(id);
  }

  private update(id: string, patch: Partial<TrayItem>) {
    const e = this.entries.get(id);
    if (!e) return;
    const item = { ...e.item, ...patch };
    item.text = jobText(item.phase, item.phase === 'sending' ? null : item.host, item.error);
    e.item = item;
    this.changed();
  }

  private async upload(id: string): Promise<{ ok: boolean; message?: string }> {
    const e = this.entries.get(id);
    const m = this.deps.machineId();
    if (!e || !m) return { ok: false, message: 'המסך לא מצומד' };
    const body = e.ticket ? { id, ticket: e.ticket } : { id, test: true };
    const r = await this.deps.api.post(`sync/${m}/kds/print-jobs`, body, { timeoutMs: 15_000 });
    if (r.kind === 'ok') {
      e.sent = true;
      this.apply(r.body as KdsPrintJob);
      this.schedulePoll();
      return { ok: true };
    }
    if (r.kind === 'refused') {
      const code = refusalCode(r);
      const message = relayWhyText(code);
      this.update(id, { phase: 'failed', error: message });
      this.deps.log?.(`kds print refused: ${code ?? r.status}`);
      // The path or the till changed in the dashboard: read where bons go now.
      void this.refresh();
      return { ok: false, message };
    }
    // No connection: the same id again until the screen's wait is over.
    if (this.now() >= e.deadline) {
      this.update(id, { phase: 'failed', error: 'אין חיבור' });
      return { ok: false, message: 'אין חיבור' };
    }
    this.set(() => void this.upload(id), RESEND_MS);
    return { ok: true };
  }

  private apply(job: KdsPrintJob | null | undefined) {
    if (!job || !this.entries.has(job.id)) return;
    const phase = jobPhase(job);
    const error = phase === 'failed' ? job.error : null;
    this.update(job.id, { phase, host: job.targetMachineName ?? this.entries.get(job.id)!.item.host, error });
    if (phase === 'done') this.set(() => this.dismiss(job.id), DONE_SHOWN_MS);
  }

  private schedulePoll() {
    if (this.pollTimer !== null || this.stopped) return;
    this.pollTimer = this.set(() => {
      this.pollTimer = null;
      void this.poll();
    }, POLL_MS);
  }

  /** Looks at the bons that wait for their till. */
  async poll(): Promise<void> {
    if (this.polling) return;
    const m = this.deps.machineId();
    const waiting = [...this.entries.values()].filter((e) => e.sent && e.item.phase === 'waiting').map((e) => e.item.id);
    if (!m || waiting.length === 0) return;
    this.polling = true;
    try {
      const r = await this.deps.api.get(`sync/${m}/kds/print-jobs/status?ids=${waiting.join(',')}`, { timeoutMs: 15_000 });
      if (r.kind === 'ok') for (const j of (r.body as { jobs?: KdsPrintJob[] } | null)?.jobs ?? []) this.apply(j);
    } finally {
      this.polling = false;
    }
    if ([...this.entries.values()].some((e) => e.sent && e.item.phase === 'waiting')) this.schedulePoll();
  }
}
