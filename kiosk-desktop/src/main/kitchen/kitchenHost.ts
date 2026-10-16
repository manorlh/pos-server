/**
 * This Windows device as a print host — the host's side of pos-android hardware/kitchen/KitchenLan.kt
 * (`KitchenLanServer`) and KitchenPrintService's relay intake, so the shop's other devices (Android tills and kiosks,
 * other Windows ones) get their tickets printed here when the cloud names this device:
 *
 *  - the shop's print server ("שרת הדפסות", `printHost.isSelf` with `hostsLan`), or the host of a cloud kitchen printer
 *    (its own receipt printer offered to the others): the LAN server on the cloud's port (8399), every request with the
 *    shop's print secret as the bearer —
 *      GET  /kitchen/ping                     → {"ok":true,"machineId":"…"}
 *      POST /kitchen/jobs {id, printerId, ticket, printer?} → {id, status}   (idempotent by id)
 *      GET  /kitchen/jobs/status?ids=a,b      → {"jobs":[{id, status, error}]}
 *      POST /kitchen/jobs/cancel?ids=a        → {"jobs":[{id, status}]}     (no documents here: "unknown")
 *    — and where it listens told to the cloud (`POST /sync/{m}/print-host`);
 *  - the cloud's relayed jobs for it (`GET /sync/{m}/print-jobs/pending`): the kitchen's kinds on the device's ONE
 *    print-jobs poller (main/printer/printJobsHost.ts, `kitchenJobsModule` — every 10 s while it hosts, and on each beat),
 *    printed in its own queue (one id once, whichever way it came) and answered (`…/ack`).
 *
 * Another till's bills and receipts (`document`) and its drawer are never taken over the LAN here: refused (404), so the
 * sender goes on to the cloud by the same id (P:/specs/bill-print-other-till.md §6 — LAN first, then the cloud). There
 * the same poller hands them to the Windows till's own module (main/till/tillDrawer.ts, a till that says
 * `document_relay_v1`); a device that is not working as a till answers them "failed" at once, so the sender falls back.
 */

import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { Api } from '../sync/api';
import { DEFAULT_LAN_PORT } from '../../core/kitchen/config';
import { hostsOwnPrinter, takesRelayedJobs } from '../../core/kitchen/routing';
import type { PrintJobsModule } from '../printer/printJobsHost';
import type { KitchenService } from './kitchenService';

const MAX_BODY = 512 * 1024;
/** While hosting, the cloud's relayed jobs are looked for this often (besides each beat). */
export const RELAY_HOST_POLL_MS = 10_000;

/** The kinds the cloud relays to a device that only a working till prints (another till's bill / receipt, its drawer). */
export const TILL_ONLY_JOB_KINDS = ['document', 'drawer'] as const;

/**
 * The kitchen's part of the device's one print-jobs poller: `ticket` / `test` into the kitchen queue, while this device
 * takes the cloud's relayed jobs (it hosts a cloud printer, or it is the shop's print server); the answers the queue owes
 * after each look.
 */
export function kitchenJobsModule(kitchen: KitchenService): PrintJobsModule {
  return {
    wanted: () => kitchen.hostsRelay(),
    everyMs: RELAY_HOST_POLL_MS,
    handlers: {
      ticket: (job) => kitchen.takeRelayedJob(job),
      test: (job) => kitchen.takeRelayedJob(job),
    },
    afterPoll: () => kitchen.sendAcks(),
  };
}

export interface KitchenHostDeps {
  kitchen: KitchenService;
  api: Api;
  machineId(): string | null;
  /** This PC's address on the shop's LAN (a private IPv4); null off any LAN. */
  lanAddress(): string | null;
  log(m: string): void;
  /** Tests: listen on this host (default every interface). */
  hostname?: string;
  /** Tests: the port to listen on instead of the cloud's (0 = any). */
  portOverride?: number;
  /** The device's one print-jobs poller (main/printer/printJobsHost.ts): looked at now when hosting begins, and on a beat. */
  printJobs?: { kick(): void; poll(): Promise<number> };
}

function sameSecret(expected: string, given: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(given, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export class KitchenHost {
  private server: http.Server | null = null;
  private port: number | null = null;
  private stopped = false;

  constructor(private readonly d: KitchenHostDeps) {}

  /** The LAN server runs: the port it listens on. */
  listening(): number | null {
    return this.server ? this.port : null;
  }

  /** This device prints for the others now (per the settings). */
  hosting(): boolean {
    const c = this.d.kitchen.config();
    return ((c.hostsLan && c.printHost?.isSelf === true) || hostsOwnPrinter(c)) && !!c.printSecret;
  }

  /** Run the LAN server while the settings say this device hosts, stop it otherwise; the relay looked at now when it takes it. */
  async apply(): Promise<void> {
    if (this.stopped) return;
    const c = this.d.kitchen.config();
    const want = this.hosting();
    const port = this.d.portOverride ?? c.printHost?.port ?? DEFAULT_LAN_PORT;
    if (!want) await this.close();
    else if (!this.server || (this.d.portOverride === undefined && this.port !== port)) {
      await this.close();
      await this.listen(port);
    }
    if (takesRelayedJobs(c)) this.d.printJobs?.kick();
  }

  private listen(port: number): Promise<void> {
    return new Promise((resolve) => {
      const server = http.createServer((req, res) => void this.handle(req, res));
      server.on('error', (e) => {
        this.d.log(`kitchen LAN print host could not start on ${port}: ${e.message}`);
        this.server = null;
        this.port = null;
        resolve();
      });
      server.listen(port, this.d.hostname ?? '0.0.0.0', () => {
        const addr = server.address();
        this.server = server;
        this.port = typeof addr === 'object' && addr ? addr.port : port;
        this.d.log(`kitchen LAN print host listening on ${this.port}`);
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    const s = this.server;
    this.server = null;
    this.port = null;
    if (s) await new Promise<void>((r) => s.close(() => r()));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.close();
  }

  /** After a good beat: where this device listens told to the cloud (when it hosts), the relay looked at, the answers sent. */
  async afterBeat(): Promise<void> {
    await this.apply();
    const id = this.d.machineId();
    if (!id) return;
    if (this.hosting()) {
      const port = this.listening() ?? this.d.kitchen.config().printHost?.port ?? DEFAULT_LAN_PORT;
      await this.d.api.post(`sync/${id}/print-host`, { lanAddress: this.d.lanAddress(), port }, { timeoutMs: 10_000 });
    }
    // The relay through the one poller (its look sends the answers owed); not taking it any more: the answers still owed.
    if (takesRelayedJobs(this.d.kitchen.config()) && this.d.printJobs) await this.d.printJobs.poll().catch((e) => this.d.log(`kitchen relay: ${String(e)}`));
    else await this.d.kitchen.sendAcks().catch(() => undefined);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const answer = (status: number, body: unknown) => {
      const text = JSON.stringify(body);
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text), Connection: 'close' });
      res.end(text);
    };
    try {
      const secret = this.d.kitchen.config().printSecret;
      const given = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
      if (!secret || !given || !sameSecret(secret, given)) return answer(401, { detail: 'unauthorized' });
      const url = new URL(req.url ?? '/', 'http://lan');
      const ids = (url.searchParams.get('ids') ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 200);
      if (req.method === 'GET' && url.pathname === '/kitchen/ping') return answer(200, { ok: true, machineId: this.d.machineId() });
      if (req.method === 'GET' && url.pathname === '/kitchen/jobs/status') return answer(200, this.d.kitchen.lanStatuses(ids));
      if (req.method === 'POST' && url.pathname === '/kitchen/jobs/cancel') return answer(200, { jobs: ids.map((id) => ({ id, status: 'unknown' })) });
      if (req.method === 'POST' && url.pathname === '/kitchen/jobs') {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const c of req) {
          size += (c as Buffer).length;
          if (size > MAX_BODY) return answer(400, { detail: 'body too large' });
          chunks.push(c as Buffer);
        }
        let body: unknown = null;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          return answer(400, { detail: 'bad job' });
        }
        const r = this.d.kitchen.acceptLan(body);
        return answer(r.status, r.body);
      }
      return answer(404, { detail: 'not found' });
    } catch (e) {
      this.d.log(`kitchen LAN request: ${String(e)}`);
      if (!res.headersSent) answer(500, { detail: 'error' });
    }
  }
}
