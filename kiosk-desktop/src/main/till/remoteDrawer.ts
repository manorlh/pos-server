/**
 * Another till's drawer, both ways (P:/specs/bill-print-other-till.md §9ב–§9ג, §10.9 — pos-android AppContainer
 * `openRemoteDrawer`, `remoteDrawerDestinations`, hardware/kitchen/KitchenPrintService's host side):
 *
 *  - from here: "פתיחת מגירה ב<קופה>" and a cash payment away from the drawer (drawer-away §5.3) — a `drawer` job through the
 *    cloud (`POST /sync/{m}/print-jobs`, the id = the drawer log's event id), its answer waited for `remotePrintTimeoutSec`,
 *    taken back when none came;
 *  - here, as the host: the jobs the cloud hands this till (`GET /sync/{m}/print-jobs/pending`, through the device's one
 *    print-jobs poller, main/printer/printJobsHost.ts) — a `drawer` job opens this till's drawer once per id, only with a
 *    drawer, never past its time, never in a payment of its own; a `document` job (a bill or a receipt another till sent)
 *    prints as it is on the receipt printer, once per id; each answered (`…/ack`).
 *
 * The cloud lists drawer hosts — and hands documents — only to a build that says `document_relay_v1` on its heartbeat; the
 * Windows till says it. The senders reach it through the cloud: the Windows print host on the LAN (main/kitchen/kitchenHost.ts)
 * takes kitchen tickets only and refuses a document or a drawer (404), so the sender goes on to the cloud by the same id. The
 * poll is every few seconds (no realtime channel on Windows); a kitchen ticket relayed to this device is the kitchen's.
 */

import type { MonoBitmap } from '../../core/escpos';
import { DOCUMENT_RELAY, drawerHostsHere, jobExpired, parseDrawerHosts, rasterOfGzip, remotePrintSettingsOf, remoteWhy, type DrawerHost } from '../../core/till/remotePrint';
import type { Api } from '../sync/api';
import type { JobAnswer, PendingJob } from '../printer/printJobsHost';
import type { DrawerJob } from './drawerService';

export { DOCUMENT_RELAY };
// The host's side is the device's one print-jobs poller (main/printer/printJobsHost.ts): this module's kinds are registered
// on it by main/till/tillDrawer.ts.
export { PrintJobsHost, type JobAnswer, type PendingJob } from '../printer/printJobsHost';

const PRINTERS_EVERY_MS = 5 * 60_000;
const STATUS_EVERY_MS = 1_000;

export class RemoteDrawers {
  private hosts: DrawerHost[] = [];
  private etag: string | null = null;
  private pulledAt = 0;

  constructor(
    private readonly d: {
      api: Api;
      machineId(): string | null;
      params(): Record<string, unknown>;
      now?: () => number;
      sleep?: (ms: number) => Promise<void>;
      log?: (m: string) => void;
    },
  ) {}

  private now() {
    return this.d.now?.() ?? Date.now();
  }

  /** The cloud's `drawerHosts` (ETag): every five minutes, or now. */
  async pull(force = false): Promise<void> {
    const m = this.d.machineId();
    if (!m) return;
    if (!force && this.now() - this.pulledAt < PRINTERS_EVERY_MS) return;
    this.pulledAt = this.now();
    const r = await this.d.api.get<Record<string, unknown>>(`sync/${m}/printers${this.etag ? `?etag=${encodeURIComponent(this.etag)}` : ''}`, { timeoutMs: 15_000 });
    if (r.kind !== 'ok' || !r.body || typeof r.body !== 'object' || r.body.syncType === 'unchanged') return;
    const hosts = parseDrawerHosts(r.body);
    if (hosts) this.hosts = hosts;
    this.etag = typeof r.body.etag === 'string' ? r.body.etag : null;
  }

  /** The tills whose drawer may be opened from here now. */
  here(): DrawerHost[] {
    return drawerHostsHere(this.hosts, remotePrintSettingsOf(this.d.params()), this.d.machineId());
  }

  /** Tests and the technician: the hosts as given. */
  setHosts(hosts: DrawerHost[]) {
    this.hosts = hosts;
  }

  /**
   * The job to `host` and its answer: resolves when it opened there; throws with the reason ("busy_payment", "no_drawer",
   * "timeout", the cloud's refusal…) otherwise. Never past `remotePrintTimeoutSec`: then taken back.
   */
  async open(host: DrawerHost, job: DrawerJob): Promise<void> {
    const m = this.d.machineId();
    if (!m) throw new Error('not_sent');
    const sleep = this.d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const { id, ...drawer } = job;
    const r = await this.d.api.post(
      `sync/${m}/print-jobs`,
      { id, kind: 'drawer', printerId: host.printerId, targetMachineId: host.printerId ? null : host.machineId, drawer },
      { timeoutMs: 10_000 },
    );
    if (r.kind === 'offline') throw new Error('not_sent');
    if (r.kind === 'refused') {
      const detail = (r.body as { detail?: unknown } | null)?.detail;
      const code = detail && typeof detail === 'object' ? String((detail as { code?: unknown }).code ?? '') : typeof detail === 'string' ? detail : `HTTP ${r.status}`;
      throw new Error(code || `HTTP ${r.status}`);
    }
    const until = this.now() + remotePrintSettingsOf(this.d.params()).timeoutSec * 1000;
    while (this.now() < until) {
      await sleep(STATUS_EVERY_MS);
      const s = await this.d.api.get<{ jobs?: Array<{ id?: string; status?: string; error?: string | null }> }>(`sync/${m}/print-jobs/status?ids=${encodeURIComponent(id)}`, { timeoutMs: 8_000 });
      if (s.kind !== 'ok') continue;
      const j = s.body?.jobs?.find((x) => x.id === id);
      if (!j) continue;
      if (j.status === 'done') return;
      if (j.status === 'failed') throw new Error(j.error || 'failed');
      if (j.status === 'expired') throw new Error('expired');
    }
    // No answer in time: taken back (a till that took it may still open — the sender says "לא נפתחה" all the same).
    await this.d.api.post(`sync/${m}/print-jobs/${encodeURIComponent(id)}/cancel`, {}, { timeoutMs: 8_000 }).catch(() => undefined);
    throw new Error('timeout');
  }
}

/** A drawer job, decided here (§10.9): opened once per id, only with a drawer, not past its time, not in a payment here. */
export async function hostDrawerJob(
  job: PendingJob,
  here: { hasDrawer(): boolean; paying(): boolean; kick(): Promise<void>; now(): number; notice(text: string): void; log(m: string): void },
): Promise<JobAnswer> {
  if (jobExpired(job, here.now())) return { status: 'failed', error: 'expired' };
  if (!here.hasDrawer()) return { status: 'failed', error: 'no_drawer' };
  if (here.paying()) return { status: 'failed', error: 'busy_payment' };
  const d = job.drawer ?? {};
  const source = typeof d.sourceName === 'string' && d.sourceName ? d.sourceName : 'קופה אחרת';
  const by = d.requestedBy && typeof d.requestedBy === 'object' ? ((d.requestedBy as { name?: unknown }).name as string | undefined) ?? null : null;
  try {
    await here.kick();
  } catch (e) {
    return { status: 'failed', error: `printer_error: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200) };
  }
  here.log(`drawer: opened for ${source} (${by ?? '-'})`);
  here.notice(`המגירה נפתחה מ${source}${by ? ` (${by})` : ''}`);
  return { status: 'done' };
}

/**
 * A document job (a bill or a receipt another till sent, §10.4): its picture as it is — `raster_gzip` here, `png` decoded by
 * `decodePng` — on this till's receipt printer, once per id. Not past the sender's time (it printed itself by then).
 */
export async function hostDocumentJob(
  job: PendingJob,
  here: { print(bmp: MonoBitmap): Promise<void>; now(): number; decodePng(bytes: Buffer, widthDots: number, heightDots: number): Promise<MonoBitmap | null> },
): Promise<JobAnswer> {
  if (jobExpired(job, here.now())) return { status: 'failed', error: 'expired' };
  const doc = job.document ?? {};
  const w = typeof doc.widthDots === 'number' ? doc.widthDots : 0;
  const h = typeof doc.heightDots === 'number' ? doc.heightDots : 0;
  const image = typeof doc.image === 'string' ? doc.image : '';
  const enc = typeof doc.encoding === 'string' ? doc.encoding : 'png';
  const bmp = enc === 'raster_gzip' ? rasterOfGzip(image, w, h) : await here.decodePng(Buffer.from(image, 'base64'), w, h);
  if (!bmp) return { status: 'failed', error: 'document_image_invalid' };
  try {
    await here.print(bmp);
  } catch (e) {
    return { status: 'failed', error: `printer_error: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200) };
  }
  return { status: 'done' };
}

export { remoteWhy };
