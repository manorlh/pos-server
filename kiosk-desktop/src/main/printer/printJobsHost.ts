/**
 * The cloud's print jobs for this device (`GET /sync/{m}/print-jobs/pending`, answered `POST …/{id}/ack`) — ONE poller for
 * every kind this Windows build prints for the shop's other devices (P:/specs/bill-print-other-till.md §10, pos-android
 * KitchenPrintService's relay intake):
 *
 *  - the till's (main/till/tillDrawer.ts): another till's `drawer` and `document` (a bill or a receipt), while this device
 *    works as a till — every 4 s (no realtime channel on Windows);
 *  - the kitchen's (main/kitchen/kitchenHost.ts `kitchenJobsModule`): `ticket` / `test` for a kitchen printer this device
 *    hosts or as the shop's print server — every 10 s while it hosts, and after each beat.
 *
 * Each module registers its kinds and says when it wants the jobs looked for; the poller looks at the fastest pace any of
 * them wants, once at a time, and hands each job to the module of its kind — never two pollers taking each other's jobs (a
 * look by one never answers "failed" for a kind another prints). A job is handled once per id: an id handed out again (the
 * ack lost) is answered as it was, never printed or opened twice. A module with a durable queue of its own (the kitchen)
 * answers `taken` and acks itself once printed. A kind nobody here takes now is left alone (the cloud hands it out again
 * after its lease) — or, for the kinds in `decline`, answered "failed" at once so its sender falls back without waiting.
 */

import type { Api } from '../sync/api';

/** One pending job as the cloud hands it. */
export interface PendingJob {
  id: string;
  kind: string;
  printerId: string | null;
  createdAt: string | null;
  expiresAt: string | null;
  timeoutSec: number | null;
  drawer?: Record<string, unknown> | null;
  document?: Record<string, unknown> | null;
  /** The job as the cloud handed it (a ticket's `ticket`, `printer`, `ticketStyle`). */
  raw?: Record<string, unknown>;
}

export type JobAnswer = { status: 'done' } | { status: 'failed'; error: string };

/** `taken`: in its module's own durable queue — the module answers the cloud itself once it printed (the kitchen's acks). */
export type JobOutcome = JobAnswer | { status: 'taken' };

export type JobHandler = (job: PendingJob) => Promise<JobOutcome>;

/** A module's part of the one poller. */
export interface PrintJobsModule {
  /** Whether it wants the cloud's jobs looked for now; its handlers count only then. */
  wanted(): boolean;
  /** How often while it wants them. */
  everyMs: number;
  handlers: Partial<Record<string, JobHandler>>;
  /** After each look that reached the cloud: the answers its own queue owes. */
  afterPoll?(): Promise<void>;
}

/** Nobody wants the jobs: looked at again (no call to the cloud) this often. */
export const IDLE_RECHECK_MS = 5_000;
const DEFAULT_EVERY_MS = 4_000;
const REMEMBER = 500;

export class PrintJobsHost {
  private readonly answered = new Map<string, JobAnswer>();
  private readonly modules = new Map<string, PrintJobsModule>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private polling = false;

  constructor(
    private readonly d: {
      api: Api;
      machineId(): string | null;
      /** Whether to look at all now (the cloud reachable). Default: yes. */
      active?(): boolean;
      /** A module of its own from the start (tests, a till alone): always wanting, at `start`'s pace. */
      handlers?: Partial<Record<string, JobHandler>>;
      /** Kinds answered "failed" when no module takes them now (the sender falls back at once); others are left alone. */
      decline?: readonly string[];
      log?: (m: string) => void;
    },
  ) {
    if (d.handlers) this.modules.set('default', { wanted: () => true, everyMs: DEFAULT_EVERY_MS, handlers: d.handlers });
  }

  /**
   * A module's kinds in (replacing the owner's earlier one); a module that wants the jobs now has them looked for at once.
   * The answer takes this very module out again (never a newer one of the same owner).
   */
  register(owner: string, module: PrintJobsModule): () => void {
    this.modules.set(owner, module);
    if (wants(module)) this.kick();
    return () => {
      if (this.modules.get(owner) === module) this.modules.delete(owner);
    };
  }

  /** The looks begin (`everyMs`: the pace of the module given to the constructor). */
  start(everyMs = DEFAULT_EVERY_MS): void {
    this.stop();
    const own = this.modules.get('default');
    if (own) own.everyMs = everyMs;
    this.running = true;
    this.schedule(this.pace());
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Look now (a module began to want the jobs, a good beat); the pace goes on from there. */
  kick(): void {
    if (this.running) this.schedule(0);
  }

  private schedule(ms: number): void {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.poll()
        .catch((e: unknown) => this.d.log?.(`print jobs: ${String(e)}`))
        .finally(() => this.schedule(this.pace()));
    }, ms);
    this.timer.unref?.();
  }

  /** The next look's delay: the fastest pace of the modules that want the jobs now (none: only a look at who wants them). */
  pace(): number {
    let ms = Infinity;
    for (const m of this.modules.values()) if (wants(m)) ms = Math.min(ms, m.everyMs);
    return Number.isFinite(ms) ? ms : IDLE_RECHECK_MS;
  }

  /** One look: every pending job to its module (or declined, or left alone), answered. The jobs handled or taken. */
  async poll(): Promise<number> {
    const m = this.d.machineId();
    if (!m || this.polling || !(this.d.active?.() ?? true)) return 0;
    const wanting = [...this.modules.values()].filter(wants);
    if (wanting.length === 0) return 0;
    this.polling = true;
    let n = 0;
    try {
      const r = await this.d.api.get<{ jobs?: unknown[] }>(`sync/${m}/print-jobs/pending`, { timeoutMs: 15_000 });
      if (r.kind !== 'ok' || !Array.isArray(r.body?.jobs)) return 0;
      for (const raw of r.body.jobs) {
        const j = raw as Record<string, unknown>;
        if (!j || typeof j.id !== 'string' || typeof j.kind !== 'string') continue;
        const job: PendingJob = {
          id: j.id,
          kind: j.kind,
          printerId: typeof j.printerId === 'string' ? j.printerId : null,
          createdAt: typeof j.createdAt === 'string' ? j.createdAt : null,
          expiresAt: typeof j.expiresAt === 'string' ? j.expiresAt : null,
          timeoutSec: typeof j.timeoutSec === 'number' ? j.timeoutSec : null,
          drawer: j.drawer && typeof j.drawer === 'object' ? (j.drawer as Record<string, unknown>) : null,
          document: j.document && typeof j.document === 'object' ? (j.document as Record<string, unknown>) : null,
          raw: j,
        };
        let answer = this.answered.get(job.id);
        if (!answer) {
          const handler = wanting.find((x) => x.handlers[job.kind])?.handlers[job.kind];
          if (!handler) {
            // Nobody here takes it now: left for its lease — or refused at once, so its sender falls back.
            if (!(this.d.decline ?? []).includes(job.kind)) continue;
            answer = { status: 'failed', error: `${job.kind} not printed by this device` };
          } else {
            let out: JobOutcome;
            try {
              out = await handler(job);
            } catch (e) {
              out = { status: 'failed', error: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
            }
            if (out.status === 'taken') {
              n += 1;
              continue;
            }
            answer = out;
            this.answered.set(job.id, answer);
            while (this.answered.size > REMEMBER) this.answered.delete(this.answered.keys().next().value as string);
          }
        }
        await this.d.api.post(`sync/${m}/print-jobs/${encodeURIComponent(job.id)}/ack`, answer, { timeoutMs: 10_000 });
        n += 1;
      }
      for (const x of wanting) {
        if (x.afterPoll) await x.afterPoll().catch((e: unknown) => this.d.log?.(`print jobs: ${String(e)}`));
      }
    } finally {
      this.polling = false;
    }
    return n;
  }
}

function wants(m: PrintJobsModule): boolean {
  try {
    return m.wanted();
  } catch {
    return false;
  }
}
