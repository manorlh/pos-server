/**
 * "בונים" from this Windows device — the kiosk's and the till's kitchen tickets to the shop's kitchen printers, as the
 * Android till's hardware/kitchen/KitchenPrintService.kt sends them (pos-server docs/SPEC_PROMOTIONS_TABLES_SHOPZ.md
 * §4, SPEC_KIOSK.md §16.9, P:/specs/kitchen-ticket-designs.md, P:/specs/bill-print-other-till.md §10):
 *
 *  - the printers' settings (`GET /sync/{m}/printers`, ETag) kept for the days the cloud is away; the shop's print
 *    secret sealed apart (the machine's DPAPI box);
 *  - a ticket is routed by product / category (core/kitchen/routing.ts) and written to the durable queue — one job
 *    per printer — BEFORE anything is sent (main/kitchen/kitchenStore.ts);
 *  - each job leaves by its printer's way: printed here (a network printer on TCP 9100 with the status read before
 *    and after, or this device's own receipt printer), handed to the shop's print server over the LAN (the shop's
 *    print secret as the bearer), or relayed through the cloud — with the LAN's fallbacks (the printer itself, then
 *    the cloud) — always under its one id, so a host that gets it twice prints it once;
 *  - no cloud: what the LAN reaches prints; what only the cloud reaches waits (retried with backoff) and goes, with
 *    the same id, once the cloud is back;
 *  - one lane per physical printer (or per hand-over target): a printer that is off never holds another's ticket,
 *    and a printer's tickets go strictly in order;
 *  - a ticket that may already be on paper is never sent again by the machine; a person decides
 *    (core/kitchen/queue.ts).
 *
 * The tickets are drawn by the hidden print window with the design engine shared with the dashboard and the Android
 * till (core/kitchenTicketStyle.ts), in the printer's design (core/kitchen/style.ts).
 */

import { printerKey, withPrinter } from '../printer/printerLock';
import { randomUUID } from 'node:crypto';
import type { Api } from '../sync/api';
import type { Kv } from '../db/schema';
import type { Db } from '../db/sqlite';
import { PLAIN_BOX, type SecretBox } from '../sync/cloud';
import type { PageRenderer } from '../printer/printQueue';
import type { JobOutcome } from '../printer/printJobsHost';
import type { PrinterTarget, Transport } from '../printer/transports';
import { concat, toMono } from '../../core/escpos';
import { DEFAULT_PRINTER_PORT, EMPTY_KITCHEN_CONFIG, parseKitchenConfig, parsePrinter, withoutSecret, type KitchenConfig, type KitchenPrinter } from '../../core/kitchen/config';
import { contentWidthOf, paperOf, rasterWidthOf, ticketJobBytes } from '../../core/kitchen/bytes';
import { printDirect, PrinterStatusMemory, rememberingLink, writeOnlyLink, type PrinterLink } from '../../core/kitchen/delivery';
import type { KitchenDoc } from '../../core/kitchen/doc';
import {
  afterFailure,
  discarded as discardedJob,
  formerHostVerdict,
  heldForOthers,
  HOST_MOVED,
  JITTER_MS,
  KEEP_FINISHED_MS,
  KitchenJobRefused,
  LanAnswerLost,
  needsAttention,
  printed,
  printing,
  PrintUncertain,
  purgeable,
  recovered,
  relayAskOrder,
  relayed,
  relayedAgain,
  relayHostOf,
  relayStatus,
  relayTargetOf,
  released,
  resentAfterHostLoss,
  retryNow,
  mayBeOnPaper,
  sending,
  surfaced,
  takenBackAsHost,
  timingLine,
  type JobKind,
  type KitchenJob,
} from '../../core/kitchen/queue';
import {
  connectionOf,
  handOverSteps,
  lanIntake,
  lanTargetOf,
  NOT_PRINT_SERVER,
  printsForOthers,
  routeOf,
  split,
  takesRelayedJobs,
  TILL_PRINTER_ID,
  tillPrinter,
  unrouted as unroutedLines,
  withoutOwnShare,
  type RoutedTicket,
} from '../../core/kitchen/routing';
import { styleForPrinter } from '../../core/kitchen/style';
import { LABELS, redirectNotice, wireLine, withNotice, type KitchenLine, type WireTicket } from '../../core/kitchen/tickets';
import { RECHECK_MS, TEMP_REDIRECT_MS, activeRedirects, clearedRedirects, mayRedirect, redirectFor, redirectLog, ticketTitleOf, withRedirect, type TempRedirect } from '../../core/kitchen/failover';
import { bonAlerts, LAN_UNREACHABLE } from '../../core/kitchen/alerts';
import type { CategoryRef, CourseRef } from '../../core/kitchenTicketStyle';
import { nameUuid } from '../kiosk/kdsRelease';
import { KitchenStore } from './kitchenStore';
import { lanCall as defaultLanCall, LanNotReached, probePrinter, tcpPrinterLink, type LanCall } from './kitchenNet';

const CONFIG_KEY = 'kitchen.config';
const SECRET_KEY = 'kitchen.secret';
/** The printers' settings are asked again at most this often (an unchanged answer is a few bytes). */
export const CONFIG_PULL_MS = 60_000;
/** A relayed job in this queue: answered to the cloud by `sendAcks` once printed. */
const TAKEN: JobOutcome = { status: 'taken' };
/** A "not the print server" answer pulls the settings again at most this often. */
const STALE_REFRESH_MS = 30_000;
/** One call to the cloud from the relay loop waits at most this long. */
const RELAY_CALL_MS = 5_000;
const LAN_STATUS_CONNECT_MS = 1_500;
const LAN_STATUS_READ_MS = 4_000;
const IDLE_MS = 60_000;
const MIN_WAIT_MS = 500;
const PURGE_EVERY_MS = 60 * 60_000;
const BON_ALERTS_RETRY_MS = 60 * 60_000;

export interface KitchenServiceDeps {
  db: Db;
  kv: Kv;
  api: Api;
  machineId(): string | null;
  secretBox?: SecretBox;
  /** The till parameters (the cloud's, as kept). */
  params(): Record<string, unknown>;
  /** This device as a ticket names it ("2 · בר"). */
  tillName(): string | null;
  /** This device's own printer — its receipt printer. */
  ownTarget(): PrinterTarget;
  /** The spooler / TCP transport the receipts use (its own printer through the Windows queue). */
  transport: Transport;
  /** The hidden print window's drawing; null until it is up. */
  renderer(): PageRenderer | null;
  /** This device is on a LAN (a private IPv4 address): the print server may be reached. Default yes. */
  onLan?(): boolean;
  /** §9: this device's menu courses and catalog categories (a ticket ordered by course / category). */
  orderData?(): { courses: CourseRef[]; categories: CategoryRef[] };
  /** The cloud's "בון לא הודפס" alerts are this device's to send (a till; a kiosk says its bons in its own alerts). */
  reportsBonAlerts?(): boolean;
  log(m: string): void;
  now?(): number;
  random?(): number;
  /** Tests: the wires. */
  printerLink?(host: string, port: number): PrinterLink;
  lanCall?: LanCall;
}

export interface EnqueueOptions {
  /** Lines routed nowhere print on this device's own printer (a counter sale, tables off). */
  unroutedToTill?: boolean;
  /** Every line to that one printer, past the routing (a kiosk's "מדפסת בונים"); one the config lacks queues nothing. */
  onlyPrinterId?: string | null;
  /** False: this device's own share (lines routed nowhere, the till copy) is left out (a kiosk with "בון מטבח במדפסת הקיוסק" off). */
  ownPrinter?: boolean;
  /** Written HELD under this ("hold:kds:<release>"): printed only once released. */
  hold?: string | null;
  /** The jobs' ids derive from it — one per printer and kind, the same however often the same ticket is asked for. */
  idSeed?: string | null;
  /** What the jobs belong to (the kiosk order, the till document). */
  refId?: string | null;
}

export interface Queued {
  jobIds: string[];
  /** The lines no kitchen printer takes, by name ("פריטים שלא נותבו למדפסת"). */
  unrouted: string[];
  /** Each job's printer, by name. */
  printers: string[];
}

type Delivered = { kind: 'here'; confirmed: boolean } | { kind: 'via'; via: 'lan' | 'cloud'; host: string | null };

/** A job's id from a seed: one per printer and kind (SendIntents.jobIdOf). */
export function jobIdOf(seed: string, printerId: string, kind: string): string {
  return nameUuid(`bon|${seed}|${printerId}|${kind}`);
}

export class KitchenService {
  private readonly store: KitchenStore;
  private readonly box: SecretBox;
  private cached: KitchenConfig | null = null;
  private lastPullAt = 0;
  private lastStaleRefresh = 0;
  private readonly running = new Map<string, Promise<void>>();
  private wakeTimer: NodeJS.Timeout | null = null;
  private relayTimer: NodeJS.Timeout | null = null;
  private relayRunning: Promise<void> | null = null;
  private workRunning: Promise<void> | null = null;
  private workAgain = false;
  /** Timers run (start); a stopped service never touches the database again (it closes with the app). */
  private stopped = true;
  private closed = false;
  private readonly startedAt: number;
  private lastPurge = 0;
  private readonly statusMemory = new PrinterStatusMemory();
  private readonly listeners = new Set<() => void>();
  /** Jobs a person handled since the last report to the cloud: id → who. */
  private readonly handled = new Map<string, string>();
  private lastReported: string | null = null;
  private bonAlertsOffUntil = 0;
  private readonly lanCall: LanCall;
  /** Jobs taken for the others before this process: held until this device knows it is still their host. */
  private readonly awaitingRole = new Set<string>();
  /** The settings answered since this process started (the role is known). */
  private roleKnown = false;
  /** One lock per physical printer: its tickets never overlap on this device (a lane and a hand-over's fallback). */
  /** "לשלוח לשם גם את הבאים": the temporary redirects (core/kitchen/failover.ts) — in memory, as on Android. */
  private tempRedirects: TempRedirect[] = [];
  private redirectWatch: NodeJS.Timeout | null = null;

  constructor(private readonly d: KitchenServiceDeps) {
    this.store = new KitchenStore(d.db);
    this.box = d.secretBox ?? PLAIN_BOX;
    this.lanCall = d.lanCall ?? defaultLanCall;
    this.startedAt = this.now();
  }

  private now(): number {
    return this.d.now ? this.d.now() : Date.now();
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch {
        /* a listener's own trouble */
      }
    }
  }

  /* ------------------------------------------------------------------ the printers' settings */

  /** The last synced settings (empty until the first pull), the shop's secret opened. */
  config(): KitchenConfig {
    if (this.cached) return this.cached;
    const kept = this.d.kv.getJson<unknown>(CONFIG_KEY);
    const base = kept ? parseKitchenConfig(kept) : { ...EMPTY_KITCHEN_CONFIG };
    let secret: string | null = null;
    const sealed = this.d.kv.get(SECRET_KEY);
    if (sealed) {
      try {
        secret = this.box.open(sealed) || null;
      } catch {
        secret = null;
      }
    }
    this.cached = { ...base, printSecret: secret };
    return this.cached;
  }

  /** Settings were ever pulled on this device. */
  known(): boolean {
    return this.d.kv.get(CONFIG_KEY) !== null;
  }

  /**
   * `GET /sync/{m}/printers` (ETag) — kept for the offline days. A cloud without the module (404): what was kept stays.
   * [force]: now, whatever the last pull was. True when the settings are fresh from the cloud (changed or not).
   */
  async pull(force = false): Promise<boolean> {
    const id = this.d.machineId();
    if (!id) return false;
    if (!force && this.now() - this.lastPullAt < CONFIG_PULL_MS) return false;
    this.lastPullAt = this.now();
    const kept = this.known() ? this.config() : null;
    // The ETag only while the secret it stands with is still readable here (a secret that no longer opens is asked again).
    const etag = kept?.etag && (kept.printSecret !== null || this.d.kv.get(SECRET_KEY) === null) ? kept.etag : null;
    const r = await this.d.api.get<Record<string, unknown>>(`sync/${id}/printers${etag ? `?etag=${encodeURIComponent(etag)}` : ''}`, { timeoutMs: 20_000 });
    if (r.kind !== 'ok' || !r.body || typeof r.body !== 'object') return false;
    this.roleKnown = true;
    if (r.body.syncType === 'unchanged') {
      if (this.awaitingRole.size > 0) this.wake();
      return true;
    }
    const next = parseKitchenConfig(r.body);
    this.d.kv.setJson(CONFIG_KEY, withoutSecret(next));
    if (next.printSecret) this.d.kv.set(SECRET_KEY, this.box.seal(next.printSecret));
    else this.d.kv.delete(SECRET_KEY);
    const before = this.cached;
    this.cached = next;
    if (JSON.stringify(before?.printHost ?? null) !== JSON.stringify(next.printHost)) {
      const h = next.printHost;
      this.d.log(h ? `kitchen: the shop's print server is ${h.name ?? h.machineId}${h.isSelf ? ' (this device)' : h.lanAddress ? ` at ${h.lanAddress}:${h.port}` : ' (no LAN address)'}` : 'kitchen: the shop has no print server');
    }
    this.d.log(`kitchen: ${next.printers.length} printer(s) in the settings (${next.printers.filter((p) => p.inScope && p.purpose !== 'receipt').length} kitchen in scope)`);
    this.wake();
    return true;
  }

  /** A device taken for the print server said it is not (any more): the settings again, soon. */
  private refreshSoon() {
    if (this.now() - this.lastStaleRefresh < STALE_REFRESH_MS) return;
    this.lastStaleRefresh = this.now();
    void this.pull(true).catch((e) => this.d.log(`kitchen printers pull: ${String(e)}`));
  }

  private printerById(id: string): KitchenPrinter | null {
    return this.config().printers.find((p) => p.id === id) ?? null;
  }

  /** The printer for an id: this device's own ([TILL_PRINTER_ID]), else the settings'. */
  private printerOrTill(id: string): KitchenPrinter | null {
    if (id === TILL_PRINTER_ID) return tillPrinter(LABELS.till);
    return this.printerById(id);
  }

  private onLan(): boolean {
    return this.d.onLan ? this.d.onLan() : true;
  }

  /** This device is on a LAN (the print server, another till's print port may be reached) — the till's remote documents. */
  lanReachable(): boolean {
    return this.onLan();
  }

  /* ------------------------------------------------------------------ queueing */

  /**
   * Route [ticket]'s [lines] and write a job per printer — durable before anything is sent. Lines no printer takes
   * are answered by name (never silently left out), unless they print on this device anyway.
   */
  enqueue(ticket: WireTicket, lines: readonly KitchenLine[], o: EnqueueOptions = {}): Queued {
    const config = this.config();
    const live = lines.filter((l) => l.quantity > 0);
    let routed: RoutedTicket[];
    if (o.onlyPrinterId) {
      const p = this.printerOrTill(o.onlyPrinterId);
      routed = p && live.length > 0 ? [{ printer: p, lines: [...live], isTillCopy: false }] : [];
    } else {
      routed = split(live, config, LABELS.till, o.unroutedToTill === true);
      if (o.ownPrinter === false) routed = withoutOwnShare(routed);
    }
    const unrouted = o.onlyPrinterId || o.unroutedToTill ? [] : [...new Set(unroutedLines(live.filter((l) => !l.waiting), config).map((l) => l.name))];
    if (routed.length === 0) return { jobIds: [], unrouted, printers: [] };
    const now = this.now();
    const base: WireTicket = { ...ticket, sourceName: ticket.sourceName ?? this.d.tillName() };
    const jobs: KitchenJob[] = routed.map((r) => {
      const its: WireTicket = {
        ...base,
        lines: r.lines.filter((l) => !l.waiting).map(wireLine),
        ...(r.lines.some((l) => l.waiting) ? { waiting: r.lines.filter((l) => l.waiting).map(wireLine) } : {}),
      };
      const kind: JobKind = r.isTillCopy ? 'copy' : 'ticket';
      // "the next ones too": a printer redirected for a while — its tickets to the other, marked "הופנה מ: …" (one hop).
      const temp = o.onlyPrinterId ? null : redirectFor(r.printer.id, this.tempRedirects, now);
      const target = temp ? this.printerOrTill(temp.toId) : null;
      const job = target ? this.newJob(target, { ...its, notice: redirectNotice(r.printer.name, its.notice) }, kind, now, o.refId ?? null) : this.newJob(r.printer, its, kind, now, o.refId ?? null);
      const withHold = o.hold ? { ...job, state: 'held' as const, lastError: o.hold } : job;
      return o.idSeed ? { ...withHold, id: jobIdOf(o.idSeed, withHold.printerId, kind) } : withHold;
    });
    this.store.insertAll(jobs);
    if (!o.hold) this.wake();
    this.emit();
    return { jobIds: jobs.map((j) => j.id), unrouted, printers: jobs.map((j) => j.printerName) };
  }

  /** The lines of a ticket no kitchen printer takes on this device now (not "ללא בון"), by name. */
  unroutedOf(lines: readonly KitchenLine[]): string[] {
    return [...new Set(unroutedLines(lines, this.config()).map((l) => l.name))];
  }

  private newJob(printer: KitchenPrinter, ticket: WireTicket, kind: JobKind, now: number, refId: string | null): KitchenJob {
    return {
      id: randomUUID(),
      printerId: printer.id,
      printerName: printer.name,
      printerJson: JSON.stringify(printer),
      ticketJson: JSON.stringify(ticket),
      route: routeOf(printer, this.config().printHost),
      kind,
      state: 'pending',
      attempts: 0,
      lastError: null,
      queuedAt: now,
      createdAt: now,
      updatedAt: now,
      nextAttemptAt: now,
      finishedAt: null,
      relayVia: null,
      relayHost: null,
      relayJobId: null,
      ackStatus: null,
      lanOrigin: 0,
      dismissed: 0,
      discardReason: null,
      refId,
    };
  }

  /** "בון בדיקה" — through the same queue, and the print server / the cloud when that is the way. */
  testPrint(printerId: string, by: string | null): string {
    const printer = this.printerOrTill(printerId);
    if (!printer) throw new KitchenJobRefused('printer not in this device’s settings');
    const now = this.now();
    const ticket: WireTicket = { source: 'test', createdAt: new Date(now).toISOString(), waiterName: by, sourceName: this.d.tillName(), lines: [] };
    const job = this.newJob(printer, ticket, 'test', now, null);
    this.store.insertAll([job]);
    this.wake();
    return job.id;
  }

  /** The jobs held under [hold] print now. */
  releaseHeld(hold: string): number {
    const held = this.store.heldFor(hold);
    const now = this.now();
    for (const j of held) this.store.update(released(j, now));
    if (held.length > 0) {
      this.wake();
      this.emit();
    }
    return held.length;
  }

  /** The jobs held under [hold] are not wanted (the KDS took the order). */
  dropHeld(hold: string): number {
    const held = this.store.heldFor(hold);
    for (const j of held) this.store.delete(j.id);
    return held.length;
  }

  /** The jobs held under [hold] need a person now ([code]): shown, printed only by a person. */
  surfaceHeld(hold: string, code: string, detail: string | null): number {
    const held = this.store.heldFor(hold);
    const now = this.now();
    for (const j of held) this.store.update(surfaced(j, now, code, detail));
    if (held.length > 0) this.emit();
    return held.length;
  }

  /** Jobs surfaced as [reason] that are settled now: [print] — they go as themselves; else handled with [why]. */
  settleSurfaced(reason: string, print: boolean, why: string): number {
    const rows = this.store.surfacedFor(reason);
    const now = this.now();
    for (const j of rows) this.store.update(print ? retryNow(j, now) : discardedJob(j, now, why));
    if (rows.length > 0) {
      if (print) this.wake();
      this.emit();
    }
    return rows.length;
  }

  /* ------------------------------------------------------------------ what the staff see and do */

  job(id: string): KitchenJob | null {
    return this.store.byId(id);
  }

  jobs(ids: readonly string[]): KitchenJob[] {
    return this.store.byIds(ids);
  }

  jobsFor(refId: string): KitchenJob[] {
    return this.store.byRef(refId);
  }

  /** The tickets that need a person: waiting after a failure, failed, or at a host that stopped answering. */
  attention(): KitchenJob[] {
    return this.store.open().filter(needsAttention);
  }

  /* ------------------------------------------------------------------ "מדפסת חלופית" */

  /** The printers a ticket may be moved to: this device's own (when it has one), the kitchen's it reaches, the receipt printers. */
  failoverPrinters(ownPrinter: boolean): KitchenPrinter[] {
    const config = this.config();
    return [
      ...(ownPrinter ? [tillPrinter(LABELS.till)] : []),
      ...config.printers.filter((p) => !(p.purpose === 'receipt' && p.type === 'cloud') && (p.purpose === 'receipt' || p.inScope || p.isHost)),
    ];
  }

  /** The printer a job is on (the config's, else as it was when the job was made). */
  printerOfJob(job: KitchenJob): KitchenPrinter | null {
    return this.printerOrTill(job.printerId) ?? this.snapshotOf(job);
  }

  /** The temporary redirects in force. */
  redirects(): TempRedirect[] {
    return activeRedirects(this.tempRedirects, this.now());
  }

  /** "בטל הפניה". */
  endRedirect(fromId: string): void {
    this.tempRedirects = clearedRedirects(this.tempRedirects, fromId);
    this.emit();
  }

  /**
   * A ticket moved to another printer (KitchenPrintService.moveToPrinter): a new job there by a new id, marked "הופנה מ: …"
   * (and "ייתכן שכבר הודפס" when it may be on paper) — the old one out of its printer's queue; [alsoNext] — that printer's
   * other waiting tickets too, and its next ones for 15 minutes. Each move to the cloud's log. A ticket printing right now: busy.
   */
  moveToPrinter(jobId: string, toId: string, alsoNext: boolean, by: { id: string; name: string } | null): 'moved' | 'busy' | 'gone' {
    const target = this.printerOrTill(toId);
    const job = this.store.byId(jobId);
    if (!target || !job) return 'gone';
    if (!mayRedirect(job)) return job.state === 'printing' || job.state === 'sending' ? 'busy' : 'gone';
    const now = this.now();
    const others = alsoNext ? this.store.pending().filter((j) => j.id !== job.id && j.printerId === job.printerId && mayRedirect(j)) : [];
    const moved: Array<{ old: KitchenJob; next: KitchenJob }> = [];
    for (const old of [job, ...others]) {
      let ticket: WireTicket;
      try {
        ticket = JSON.parse(old.ticketJson) as WireTicket;
      } catch {
        continue;
      }
      let notice = redirectNotice(old.printerName, ticket.notice);
      if (mayBeOnPaper(old)) notice = withNotice(notice, LABELS.resent);
      const fresh = retryNow(old, now);
      const next: KitchenJob = {
        ...fresh,
        id: randomUUID(),
        printerId: target.id,
        printerName: target.name,
        printerJson: JSON.stringify(target),
        route: routeOf(target, this.config().printHost),
        ticketJson: JSON.stringify({ ...ticket, notice }),
        createdAt: now,
      };
      this.store.delete(old.id);
      this.store.insertAll([next]);
      this.handled.delete(old.id);
      moved.push({ old, next });
    }
    if (alsoNext) {
      this.tempRedirects = withRedirect(this.tempRedirects, { fromId: job.printerId, fromName: job.printerName, toId: target.id, toName: target.name, until: now + TEMP_REDIRECT_MS }, now);
      this.watchRedirects();
    }
    for (const { old } of moved) {
      void this.logRedirect(
        redirectLog({
          id: randomUUID(),
          kind: 'kitchen',
          from: { id: old.printerId, name: old.printerName },
          to: { id: target.id, name: target.name },
          ticket: ticketTitleOf(old),
          error: old.lastError,
          temporaryUntil: alsoNext ? now + TEMP_REDIRECT_MS : null,
          user: by,
          at: now,
        }),
      );
    }
    this.wake();
    this.emit();
    return 'moved';
  }

  /** `POST /sync/{m}/print-redirects` — best effort: six tries, 20 s more each time; a 2xx or a 4xx is done. */
  private async logRedirect(body: Record<string, unknown>, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<void> {
    const m = this.d.machineId();
    if (!m) return;
    for (let attempt = 0; attempt < 6 && !this.closed; attempt++) {
      const r = await this.d.api.post(`sync/${m}/print-redirects`, body, { timeoutMs: 15_000 });
      if (r.kind === 'ok' || (r.kind === 'refused' && r.status >= 400 && r.status < 500)) return;
      await sleep(20_000 * (attempt + 1));
    }
    this.d.log('kitchen: print redirect log not sent');
  }

  /** While a redirect runs, its printer is knocked on every 30 s; its answer ends the redirect (a network printer). */
  private watchRedirects() {
    if (this.redirectWatch || this.stopped) return;
    this.redirectWatch = setInterval(() => void this.checkRedirects(), RECHECK_MS);
    this.redirectWatch.unref?.();
  }

  async checkRedirects(): Promise<void> {
    const now = this.now();
    this.tempRedirects = activeRedirects(this.tempRedirects, now);
    for (const r of [...this.tempRedirects]) {
      const p = this.printerById(r.fromId);
      if (!p || p.type !== 'network' || !p.host) continue;
      if (await probePrinter(p.host, p.port ?? DEFAULT_PRINTER_PORT, 2_000)) {
        this.tempRedirects = clearedRedirects(this.tempRedirects, r.fromId);
        this.d.log(`kitchen: ${p.name} answers again — its redirect ended`);
        this.emit();
      }
    }
    if (this.tempRedirects.length === 0 && this.redirectWatch) {
      clearInterval(this.redirectWatch);
      this.redirectWatch = null;
    }
  }

  /** "נסה שוב": a fresh start — marked "ייתכן שכבר הודפס" when it may be on paper. Never a job handed to a host. */
  retry(jobId: string): boolean {
    const j = this.store.byId(jobId);
    if (!j || j.state === 'relayed' || j.state === 'printing' || j.state === 'sending' || j.state === 'done') return false;
    const maybe = j.state === 'failed' && j.lastError?.startsWith('uncertain');
    const next = retryNow(maybe ? this.marked(j, LABELS.resent) : j, this.now());
    this.store.update(next);
    this.handled.delete(jobId);
    this.wake();
    this.emit();
    return true;
  }

  /**
   * "נסה שוב" for every ticket that needs a person (the admin's "הדפסות שנכשלו"): each as [retry] — one that may be on
   * paper goes marked. How many.
   */
  retryAll(): number {
    let n = 0;
    for (const j of this.attention()) if (j.state !== 'relayed' && this.retry(j.id)) n++;
    return n;
  }

  /** "סמן כטופל" / "בטל בון" — a person, with why. A job printed here for another device owes it a "failed". */
  discard(jobId: string, why: string, by: string | null = null): void {
    const j = this.store.byId(jobId);
    if (!j || j.state === 'printing' || j.state === 'sending') return;
    const discarded = discardedJob(j, this.now(), why);
    // Why, for whoever asks about it (a sender over the LAN, the cloud for a relayed one).
    const next = discarded.state === 'failed' && discarded.lastError === null ? { ...discarded, lastError: why.slice(0, 300) } : discarded;
    this.store.update(next.relayJobId && next.state === 'failed' && j.ackStatus === null ? { ...next, ackStatus: 'failed' } : next);
    if (by) this.handled.set(jobId, by);
    this.emit();
  }

  /** Take back a job handed to the cloud that no device took yet: true — it can no longer print (discarded here too). */
  async withdrawRelayed(jobId: string, why: string): Promise<boolean> {
    const j = this.store.byId(jobId);
    if (!j) return true;
    if (j.state !== 'relayed' || j.relayVia !== 'cloud') return false;
    const id = this.d.machineId();
    if (!id) return false;
    const r = await this.d.api.post<{ cancelled?: boolean }>(`sync/${id}/print-jobs/${encodeURIComponent(j.id)}/cancel`, {}, { timeoutMs: RELAY_CALL_MS });
    const taken = r.kind === 'ok' && r.body?.cancelled === true;
    if (taken) this.store.update(discardedJob({ ...j, lastError: j.lastError ?? 'cancelled' }, this.now(), why));
    return taken;
  }

  private marked(j: KitchenJob, notice: string): KitchenJob {
    try {
      const t = JSON.parse(j.ticketJson) as WireTicket;
      return { ...j, ticketJson: JSON.stringify({ ...t, notice: withNotice(t.notice, notice) }) };
    } catch {
      return j;
    }
  }

  /* ------------------------------------------------------------------ the worker */

  start(): void {
    if (!this.stopped || this.closed) return;
    this.stopped = false;
    this.recover();
    this.wake();
    this.scheduleRelay(0);
  }

  stop(): void {
    if (this.redirectWatch) clearInterval(this.redirectWatch);
    this.redirectWatch = null;
    this.stopped = true;
    this.closed = true;
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    if (this.relayTimer) clearTimeout(this.relayTimer);
    this.wakeTimer = null;
    this.relayTimer = null;
  }

  /** Jobs a dead process left in flight: a claimed one goes again, one whose bytes were going out is "uncertain". */
  recover(): void {
    const now = this.now();
    for (const j of this.store.open()) {
      if (j.state !== 'printing' && j.state !== 'sending') continue;
      if (j.updatedAt >= this.startedAt) continue;
      const next = recovered(j, now);
      this.store.update(next);
      if (next.state === 'failed') this.d.log(`kitchen job ${j.id} (${j.printerName}): ${next.lastError}`);
    }
    // What this device took for the others before it stopped waits until it knows it is still their print host: the
    // server may have moved while it was down — its senders sent it again to the new one, marked.
    for (const j of this.store.pending()) if (heldForOthers(j, this.startedAt)) this.awaitingRole.add(j.id);
  }

  /** The held jobs of the others, decided once the role is known (or after the wait without a cloud). */
  private confirmRole(): void {
    if (this.awaitingRole.size === 0) return;
    const waited = this.now() - this.startedAt;
    const config = this.config();
    const me = this.d.machineId();
    for (const id of [...this.awaitingRole]) {
      const job = this.store.byId(id);
      if (!job || job.state !== 'pending') {
        this.awaitingRole.delete(id);
        continue;
      }
      const stillHost = this.roleKnown ? printsForOthers(job.printerId, this.snapshotOf(job), config, me) : null;
      const verdict = formerHostVerdict(job, stillHost, waited);
      if (verdict === 'wait') continue;
      if (verdict === 'drop') {
        this.d.log(`kitchen job ${job.id} (${job.printerName}): ${HOST_MOVED}`);
        this.discard(job.id, HOST_MOVED);
      }
      this.awaitingRole.delete(id);
    }
  }

  /** Something to print: the worker runs now (once at a time; a wake while it runs runs it again after). */
  wake(): void {
    if (this.stopped) return;
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null;
      void this.work();
    }, 0);
    this.wakeTimer.unref?.();
  }

  /** Every lane whose oldest ticket is due prints now (lanes side by side); resolves when they are done. */
  async work(): Promise<void> {
    if (this.closed) return;
    if (this.workRunning) {
      this.workAgain = true;
      return this.workRunning;
    }
    this.workRunning = (async () => {
      do {
        this.workAgain = false;
        await this.dispatch();
      } while (this.workAgain);
    })().finally(() => {
      this.workRunning = null;
      this.scheduleNext();
    });
    return this.workRunning;
  }

  private laneOf(job: KitchenJob): string {
    if (job.route !== 'DIRECT') return `${job.route.toLowerCase()}:${job.printerId}`;
    const printer = (job.printerId === TILL_PRINTER_ID ? null : this.printerById(job.printerId)) ?? this.snapshotOf(job);
    const connection = printer ? connectionOf(printer) : null;
    if (connection === 'network') return `net:${printer!.host}:${printer!.port ?? DEFAULT_PRINTER_PORT}`;
    if (connection === 'till' || connection === 'usb') return 'own';
    return `printer:${job.printerId}`;
  }

  private snapshotOf(job: KitchenJob): KitchenPrinter | null {
    try {
      return parsePrinter(JSON.parse(job.printerJson));
    } catch {
      return null;
    }
  }

  private async dispatch(): Promise<void> {
    const now = this.now();
    if (now - this.lastPurge > PURGE_EVERY_MS) {
      this.lastPurge = now;
      for (const j of this.store.all()) if (purgeable(j, now) || (j.finishedAt !== null && now - j.finishedAt > 7 * KEEP_FINISHED_MS)) this.store.delete(j.id);
    }
    this.confirmRole();
    const byLane = new Map<string, KitchenJob[]>();
    for (const j of this.store.pending()) {
      if (this.awaitingRole.has(j.id)) continue;
      const lane = this.laneOf(j);
      const list = byLane.get(lane) ?? [];
      list.push(j);
      byLane.set(lane, list);
    }
    const lanes: Promise<void>[] = [];
    for (const [lane, jobs] of byLane) {
      const busy = this.running.get(lane);
      if (busy) {
        lanes.push(busy);
        continue;
      }
      if (headOf(jobs).nextAttemptAt > now) continue;
      const p = this.runLane(lane).finally(() => this.running.delete(lane));
      this.running.set(lane, p);
      lanes.push(p);
    }
    await Promise.all(lanes);
  }

  /** A lane's tickets one at a time, oldest first; a later one never before an earlier one waiting for its retry. */
  private async runLane(lane: string): Promise<void> {
    let last: string | null = null;
    for (;;) {
      if (this.closed) return;
      const jobs = this.store.pending().filter((j) => !this.awaitingRole.has(j.id) && this.laneOf(j) === lane);
      if (jobs.length === 0) return;
      const head = headOf(jobs);
      if (head.nextAttemptAt > this.now()) return;
      if (head.id === last) return;
      last = head.id;
      const failure = await this.printOne(head);
      if (failure === null) continue;
      // The rest were never sent: they wait with it (retried), never "uncertain" like the one cut short.
      const t = this.now();
      for (const j of jobs) {
        if (j.id === head.id || j.nextAttemptAt > t) continue;
        const current = this.store.byId(j.id);
        if (current?.state !== 'pending') continue;
        this.finish(current, failure instanceof PrintUncertain ? new Error('an earlier ticket on this printer was cut short — waiting') : failure);
      }
      return;
    }
  }

  /** One ticket, claimed and tried: its failure, or null (printed, handed over, or no longer to print). */
  private async printOne(job: KitchenJob): Promise<unknown | null> {
    const current = this.store.byId(job.id);
    if (current?.state !== 'pending') return null;
    const claimed = printing(current, this.now());
    this.store.update(claimed);
    let outcome: Delivered;
    try {
      if (claimed.route === 'RELAY') {
        await this.upload(claimed);
        outcome = { kind: 'via', via: 'cloud', host: null };
      } else if (claimed.route === 'LAN') outcome = await this.handOver(claimed);
      else outcome = await this.printHere(claimed);
    } catch (e) {
      const now = this.store.byId(job.id) ?? claimed;
      this.finish({ ...now, state: 'pending' }, e);
      return e;
    }
    const after = this.now();
    const fresh = this.store.byId(job.id) ?? claimed;
    const done = outcome.kind === 'via' ? relayed(fresh, after, outcome.via, outcome.host) : printed(fresh, after, outcome.confirmed);
    this.store.update(done.relayJobId && done.state === 'done' ? { ...done, ackStatus: 'done' } : done);
    const line = timingLine(done);
    if (line) this.d.log(line);
    if (outcome.kind === 'via') this.scheduleRelay(RELAY_POLL);
    this.emit();
    return null;
  }

  private finish(job: KitchenJob, error: unknown): void {
    const jitter = Math.floor((this.d.random ? this.d.random() : Math.random()) * (JITTER_MS + 1));
    const failed = afterFailure(job, this.now(), error, jitter);
    const ack = failed.relayJobId === null ? failed.ackStatus : failed.state === 'failed' ? 'failed' : (failed.ackStatus ?? 'printing');
    this.store.update({ ...failed, ackStatus: ack });
    const line = timingLine(failed);
    if (line) this.d.log(line);
    this.d.log(`kitchen print ${job.printerName}: ${failed.lastError}`);
    this.emit();
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    const pending = this.store.pending().filter((j) => !this.awaitingRole.has(j.id));
    if (pending.length === 0 && this.awaitingRole.size === 0) return;
    const next = pending.length > 0 ? Math.min(...pending.map((j) => j.nextAttemptAt)) : this.startedAt + 90_000;
    const wait = Math.max(MIN_WAIT_MS, Math.min(IDLE_MS, next - this.now()));
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null;
      void this.work();
    }, wait);
    this.wakeTimer.unref?.();
  }

  /* ------------------------------------------------------------------ printing here */

  /** The page for [printer]: each copy drawn, 1-bit, centred on the head's raster, its feed and cut. */
  private async bytesFor(printer: KitchenPrinter, ticket: WireTicket, kind: JobKind): Promise<Uint8Array> {
    const renderer = this.d.renderer();
    if (!renderer) throw new Error('the print window is not ready');
    const style = styleForPrinter(printer, this.d.params(), ticket.style ?? null);
    // This device's own printer ("קופה"): the width its technician set for the receipt printer ("רוחב הדפסה").
    const dots = printer.printWidthDots ?? (printer.type === 'till' ? (this.d.ownTarget().widthDots ?? null) : null);
    const raster = rasterWidthOf(printer.paperWidth, dots);
    const width = contentWidthOf(printer.paperWidth, dots);
    const copies = Math.max(1, Math.min(5, printer.copies));
    const drawn: WireTicket = kind === 'copy' ? { ...ticket, notice: withNotice(ticket.notice, LABELS.tillCopy) } : ticket;
    const { style: _s, waiting: _w, ...plain } = drawn;
    const order = style.order.by === 'added' ? null : (this.d.orderData?.() ?? null);
    const parts: Uint8Array[] = [];
    for (let copy = 1; copy <= copies; copy++) {
      const doc: KitchenDoc = {
        kind: 'kitchen',
        ticket: plain,
        style,
        paper: paperOf(printer.paperWidth),
        printerName: printer.name,
        copy,
        copies,
        cutPaper: printer.cutPaper,
        ...(order ? { courses: order.courses, categories: order.categories } : {}),
      };
      const page = await renderer(doc, width);
      parts.push(ticketJobBytes(toMono(page.rgba, page.width, page.height), raster, { cut: printer.cutPaper, beep: printer.beep, feedLines: style.feedLines }));
    }
    return concat(parts);
  }

  /** One page at a time per printer — shared with the receipt queue and the drawer (main/printer/printerLock.ts). */
  private async locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
    return withPrinter(key, fn);
  }

  private statusCheckOn(): boolean {
    const v = this.d.params().kitchenPrinterStatusCheck;
    if (v === undefined || v === null) return true;
    return !['false', '0', 'off', 'no'].includes(String(v).trim().toLowerCase());
  }

  private link(host: string, port: number): PrinterLink {
    const raw = this.d.printerLink ? this.d.printerLink(host, port) : tcpPrinterLink(host, port);
    return this.statusCheckOn() ? rememberingLink(raw, this.statusMemory, `net:${host}:${port}`, () => this.now()) : writeOnlyLink(raw);
  }

  private async printHere(job: KitchenJob): Promise<Delivered> {
    const snapshot = this.snapshotOf(job);
    if (!snapshot) throw new KitchenJobRefused('printer unreadable');
    // The settings as they are now win (a corrected address); the snapshot covers a printer they have since lost.
    const printer = job.printerId === TILL_PRINTER_ID ? snapshot : (this.printerById(job.printerId) ?? snapshot);
    let ticket: WireTicket;
    try {
      ticket = JSON.parse(job.ticketJson) as WireTicket;
    } catch {
      throw new KitchenJobRefused('ticket unreadable');
    }
    const markSending = () => this.store.update(sending(this.store.byId(job.id) ?? job, this.now()));
    const connection = connectionOf(printer);
    if (connection === 'network') {
      if (!printer.host) throw new KitchenJobRefused('printer has no address');
      const bytes = await this.bytesFor(printer, ticket, job.kind);
      const port = printer.port ?? DEFAULT_PRINTER_PORT;
      const host = printer.host;
      const r = await this.locked(`net:${host}:${port}`, () => printDirect(this.link(host, port), bytes, `${printer.name} (${host})`, markSending));
      return { kind: 'here', confirmed: r.confirmed };
    }
    if (connection === 'till' || connection === 'usb') {
      const target = this.d.ownTarget();
      const bytes = await this.bytesFor(printer, ticket, job.kind);
      if (target.transport === 'tcp' && target.host) {
        const host = target.host;
        const port = target.port ?? DEFAULT_PRINTER_PORT;
        const r = await this.locked(`net:${host}:${port}`, () => printDirect(this.link(host, port), bytes, `${printer.name} (${host})`, markSending));
        return { kind: 'here', confirmed: r.confirmed };
      }
      if ((target.transport === 'spooler' && target.queueName) || (target.transport === 'serial' && target.comPort)) {
        // The Windows queue, or a COM port (an all-in-one's built-in printer): a "write:" failure may have reached the paper.
        await this.locked(printerKey(target) ?? 'own', async () => {
          markSending();
          try {
            await this.d.transport.send(target, bytes);
          } catch (e) {
            // The spooler wrote part of it: it may be on paper. Anything before the write: nothing printed.
            if (/write:/.test(String(e))) throw new PrintUncertain(`${printer.name} — ${e instanceof Error ? e.message : String(e)}`);
            throw e;
          }
        });
        return { kind: 'here', confirmed: false };
      }
      throw new Error('this device’s printer is not set up or not plugged in');
    }
    // Bluetooth, or a cloud printer another device hosts: never reached from this device.
    throw new KitchenJobRefused('printer is not reachable from this device');
  }

  /** This device can print on [printer] itself (the print server's fallback): a network printer. */
  private reachableHere(printer: KitchenPrinter): boolean {
    return printer.type === 'network' && !!printer.host;
  }

  /* ------------------------------------------------------------------ the shop's print server, the cloud */

  private caller() {
    const id = this.d.machineId();
    return id ? { id, name: this.d.tillName() } : null;
  }

  /**
   * Over the LAN to the device that prints it — the shop's print server, or the device a cloud printer hangs on. When
   * it is not there: printed here if this device reaches the printer itself, else through the cloud. Never two: a
   * request the host may have taken (its answer lost) is never printed here as well, and the cloud carries it by the
   * same id, which the host prints once.
   */
  private async handOver(job: KitchenJob): Promise<Delivered> {
    const config = this.config();
    const printer = this.printerById(job.printerId) ?? this.snapshotOf(job);
    if (!printer) throw new KitchenJobRefused('printer unreadable');
    let ticket: WireTicket;
    try {
      ticket = JSON.parse(job.ticketJson) as WireTicket;
    } catch {
      throw new KitchenJobRefused('ticket unreadable');
    }
    const steps = handOverSteps(printer, config.printHost, this.onLan(), this.reachableHere(printer));
    let hostMayHaveIt = false;
    for (const step of steps) {
      if (step === 'LAN') {
        const target = lanTargetOf(printer, config.printHost);
        const secret = config.printSecret;
        if (!target || !secret) continue;
        try {
          const reply = await this.lanCall(target, secret, 'POST', '/kitchen/jobs', { id: job.id, printerId: job.printerId, ticket, printer }, { caller: this.caller() });
          if (reply.status >= 200 && reply.status < 300) return { kind: 'via', via: 'lan', host: relayHostOf(target) };
          const detail = reply.body && typeof reply.body === 'object' ? (reply.body as { detail?: unknown }).detail : null;
          // "Not the print server" (any more): the settings are stale — pulled again; the job goes on by the next way.
          if (reply.status === 409 && detail === NOT_PRINT_SERVER) this.refreshSoon();
          this.d.log(`kitchen: the print server answered HTTP ${reply.status}${typeof detail === 'string' ? ` ${detail}` : ''}`);
        } catch (e) {
          if (e instanceof LanAnswerLost) hostMayHaveIt = true;
          this.d.log(`kitchen: the print server not reached (${e instanceof Error ? e.message : String(e)})`);
        }
        continue;
      }
      if (step === 'DIRECT') {
        if (hostMayHaveIt) continue;
        try {
          return await this.printHere(job);
        } catch (e) {
          // It may be on paper already: never on to the cloud as well (a second ticket).
          if (e instanceof PrintUncertain) throw e;
          this.d.log(`kitchen: direct fallback to ${printer.name} failed (${e instanceof Error ? e.message : String(e)}) — via the cloud`);
        }
        continue;
      }
      break;
    }
    await this.upload(job, hostMayHaveIt);
    return { kind: 'via', via: 'cloud', host: null };
  }

  /** `POST /sync/{m}/print-jobs` — the cloud relay, idempotent by the job's id. */
  private async upload(job: KitchenJob, mayHavePrinted = false): Promise<void> {
    const id = this.d.machineId();
    if (!id) throw new Error('not paired');
    let ticket: WireTicket;
    try {
      ticket = JSON.parse(job.ticketJson) as WireTicket;
    } catch {
      throw new KitchenJobRefused('ticket unreadable');
    }
    const { style: _style, ...sent } = ticket;
    const body = { id: job.id, printerId: job.printerId, ticket: mayHavePrinted ? { ...sent, notice: withNotice(sent.notice, LABELS.resent) } : sent };
    const r = await this.d.api.post(`sync/${id}/print-jobs`, body, { timeoutMs: 15_000 });
    if (r.kind === 'ok') return;
    if (r.kind === 'offline') throw new Error(`the cloud is not reached (${r.reason})`);
    if (r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429) throw new KitchenJobRefused(r.detail ?? `HTTP ${r.status}`);
    throw new Error(`HTTP ${r.status}`);
  }

  /* ------------------------------------------------------------------ what became of the jobs handed over */

  private scheduleRelay(ms: number): void {
    if (this.stopped) return;
    if (this.relayTimer) clearTimeout(this.relayTimer);
    this.relayTimer = setTimeout(() => {
      this.relayTimer = null;
      void this.pollRelayed().finally(() => {
        const next = this.store.nextRelayedAt();
        if (next !== null) this.scheduleRelay(Math.max(MIN_WAIT_MS, Math.min(IDLE_MS, next - this.now())));
      });
    }, ms);
    this.relayTimer.unref?.();
  }

  /** The sender's side: asks the hosts (LAN, cloud) about the jobs handed to them that are due a question. */
  async pollRelayed(): Promise<void> {
    if (this.relayRunning) return this.relayRunning;
    this.relayRunning = this.pollRelayedNow().finally(() => {
      this.relayRunning = null;
    });
    return this.relayRunning;
  }

  private async pollRelayedNow(): Promise<void> {
    if (this.closed) return;
    const now = this.now();
    const due = this.store.dueRelayed(now);
    if (due.length === 0) return;
    const viaCloud = due.filter((j) => j.relayVia !== 'lan');
    const viaLan = due.filter((j) => j.relayVia === 'lan');
    let again = false;
    if (viaCloud.length > 0) {
      let answer: Map<string, { status: string; error: string | null }> | null = null;
      const id = this.d.machineId();
      if (id) {
        answer = new Map();
        for (let i = 0; i < viaCloud.length && answer; i += 200) {
          const ids = viaCloud.slice(i, i + 200).map((j) => j.id);
          const r = await this.d.api.get<{ jobs?: Array<{ id?: unknown; status?: unknown; error?: unknown }> }>(`sync/${id}/print-jobs/status?ids=${ids.map(encodeURIComponent).join(',')}`, { timeoutMs: RELAY_CALL_MS });
          if (r.kind !== 'ok') {
            answer = null;
            break;
          }
          for (const s of r.body?.jobs ?? []) if (typeof s.id === 'string' && typeof s.status === 'string') answer.set(s.id, { status: s.status, error: typeof s.error === 'string' ? s.error : null });
        }
      }
      for (const j of viaCloud) {
        const s = answer?.get(j.id) ?? null;
        const next = this.markedIfResent(j, relayStatus(j, now, s?.status ?? null, s?.error ?? null));
        this.note(j, next);
        if (next.state === 'pending') again = true;
      }
    }
    const groups = new Map<string, KitchenJob[]>();
    for (const j of viaLan) {
      const key = `${j.printerId}\u0000${j.relayHost ?? ''}`;
      const list = groups.get(key) ?? [];
      list.push(j);
      groups.set(key, list);
    }
    const config = this.config();
    for (const its of groups.values()) {
      const first = its[0];
      const printer = this.printerById(first.printerId) ?? this.snapshotOf(first);
      const secret = config.printSecret;
      const current = printer ? lanTargetOf(printer, config.printHost) : null;
      const targets = secret && this.onLan() ? relayAskOrder(relayTargetOf(first.relayHost), current) : [];
      let answer: Map<string, { status: string; error: string | null }> | null = null;
      for (const target of targets) {
        try {
          const r = await this.lanCall(target, secret!, 'GET', `/kitchen/jobs/status?ids=${its.map((j) => encodeURIComponent(j.id)).join(',')}`, null, {
            connectMs: LAN_STATUS_CONNECT_MS,
            readMs: LAN_STATUS_READ_MS,
            caller: this.caller(),
          });
          if (r.status === 200) {
            answer = new Map();
            const list = r.body && typeof r.body === 'object' ? (r.body as { jobs?: unknown }).jobs : null;
            for (const s of Array.isArray(list) ? (list as Array<Record<string, unknown>>) : []) {
              if (typeof s.id === 'string' && typeof s.status === 'string') answer.set(s.id, { status: s.status, error: typeof s.error === 'string' ? s.error : null });
            }
          }
          break;
        } catch (e) {
          // Not reached at all (nothing connected): the next may answer. Reached and its answer lost: it is there.
          if (e instanceof LanNotReached) continue;
          break;
        }
      }
      for (const j of its) {
        const status = answer ? (answer.get(j.id)?.status ?? 'unknown') : null;
        const error = answer ? (answer.get(j.id)?.error ?? null) : LAN_UNREACHABLE;
        const next = this.markedIfResent(j, relayStatus(j, now, status, error));
        this.note(j, next);
        if (next.state === 'pending') again = true;
      }
    }
    if (again) this.wake();
  }

  /** Sent again because the host it went to does not have it: marked "הדפסה חוזרת — ייתכן שכבר הודפס". */
  private markedIfResent(old: KitchenJob, next: KitchenJob): KitchenJob {
    return resentAfterHostLoss(old, next) ? this.marked(next, LABELS.resent) : next;
  }

  private note(old: KitchenJob, next: KitchenJob): void {
    this.store.update(next);
    if (next.state !== old.state) {
      const line = timingLine(next);
      if (line) this.d.log(line);
      this.emit();
    }
  }

  /* ------------------------------------------------------------------ the heartbeat's turn */

  /**
   * After a good beat: the settings (ETag, at most every minute), the jobs handed over asked about, the cloud's
   * "בון לא הודפס" kept in step (a till), the queue woken (the cloud may be back).
   */
  async afterBeat(): Promise<void> {
    await this.pull().catch((e) => this.d.log(`kitchen printers: ${String(e)}`));
    await this.pollRelayed().catch((e) => this.d.log(`kitchen relay: ${String(e)}`));
    if (this.d.reportsBonAlerts?.() !== false) await this.reportBons().catch((e) => this.d.log(`bon alerts: ${String(e)}`));
    this.wake();
  }

  /** The tickets that need a person, as one list, to the cloud (`POST /sync/{m}/kitchen/bon-alerts`). */
  async reportBons(force = false): Promise<void> {
    const id = this.d.machineId();
    if (!id || this.now() < this.bonAlertsOffUntil) return;
    const handled = new Map<string, { job: KitchenJob; by: string }>();
    for (const [jobId, by] of this.handled) {
      const job = this.store.byId(jobId);
      if (job) handled.set(jobId, { job, by });
    }
    const bons = bonAlerts(this.attention(), handled).slice(0, 100);
    const key = JSON.stringify(bons.map((b) => [b.id, b.state, b.reason]));
    if (!force && handled.size === 0 && key === this.lastReported) return;
    if (this.lastReported === null && bons.length === 0 && !force) {
      this.lastReported = key;
      return;
    }
    const r = await this.d.api.post(`sync/${id}/kitchen/bon-alerts`, { bons, complete: true }, { timeoutMs: RELAY_CALL_MS * 2 });
    if (r.kind === 'ok') {
      this.lastReported = key;
      for (const k of handled.keys()) this.handled.delete(k);
    } else if (r.kind === 'refused' && r.status === 404) this.bonAlertsOffUntil = this.now() + BON_ALERTS_RETRY_MS;
  }

  /* ------------------------------------------------------------------ hosting: jobs other devices send here */

  /**
   * A job that came over the LAN from another device (`POST /kitchen/jobs`), for the LAN host (main/kitchen/lanHost.ts):
   * queued here when this device prints its printer (idempotent by id), else refused so the sender goes on its way.
   */
  acceptLan(body: unknown): { status: number; body: unknown } {
    const b = body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
    const id = b && typeof b.id === 'string' && b.id.length > 0 && b.id.length <= 64 ? b.id : null;
    const printerId = b && typeof b.printerId === 'string' ? b.printerId : null;
    const ticket = b && b.ticket && typeof b.ticket === 'object' ? (b.ticket as WireTicket) : null;
    if (b && typeof b.kind === 'string' && b.kind !== 'ticket' && b.kind !== 'test') return { status: 404, body: { detail: 'not printed here' } };
    if (!id || !printerId || !ticket || !Array.isArray(ticket.lines)) return { status: 400, body: { detail: 'bad job' } };
    const intake = lanIntake(printerId, parsePrinter(b!.printer), this.config(), this.d.machineId());
    if (intake.kind !== 'accepted') {
      const known = this.store.byId(id);
      if (known) return { status: 200, body: this.lanStatusOf(id, known) };
      return intake.kind === 'not_print_server' ? { status: 409, body: { detail: NOT_PRINT_SERVER } } : { status: 404, body: { detail: 'printer not printed here' } };
    }
    if (!this.store.byId(id)) {
      const job = this.newJob(intake.printer, ticket, ticket.source === 'test' ? 'test' : 'ticket', this.now(), null);
      this.store.insertAll([{ ...job, id, route: 'DIRECT', lanOrigin: 1 }]);
      this.wake();
      this.emit();
    }
    return { status: 200, body: this.lanStatusOf(id, this.store.byId(id)) };
  }

  /** `GET /kitchen/jobs/status?ids=` — what became of jobs taken here. */
  lanStatuses(ids: readonly string[]): { jobs: Array<{ id: string; status: string; error: string | null }> } {
    const known = new Map(this.store.byIds(ids.slice(0, 200)).map((j) => [j.id, j]));
    return { jobs: ids.slice(0, 200).map((id) => this.lanStatusOf(id, known.get(id) ?? null)) };
  }

  private lanStatusOf(id: string, job: KitchenJob | null): { id: string; status: string; error: string | null } {
    if (!job) return { id, status: 'unknown', error: null };
    if (job.state === 'done') return { id, status: 'done', error: null };
    if (job.state === 'failed') return { id, status: 'failed', error: job.lastError };
    if (job.state === 'printing' || job.state === 'sending') return { id, status: 'printing', error: null };
    return { id, status: 'pending', error: job.lastError };
  }

  /** This device takes the cloud's relayed jobs (it hosts a cloud printer, or it is the shop's print server). */
  hostsRelay(): boolean {
    return takesRelayedJobs(this.config());
  }

  /**
   * The host's side of the cloud relay, one job the device's print-jobs poller (main/printer/printJobsHost.ts) hands over: a
   * `ticket` / `test` for a printer this device prints, into the queue under the cloud's id — `taken`: this queue answers the
   * cloud itself once it printed (`sendAcks`). A job it already has (printed, the ack lost; or it came over the LAN first)
   * is never printed twice — its answer goes to the cloud again. A printer it does not know, or no ticket: "failed" at once.
   */
  async takeRelayedJob(remote: { id: string; kind: string; printerId?: string | null; raw?: Record<string, unknown> }): Promise<JobOutcome> {
    const rid = remote.id;
    const kind = remote.kind;
    const body = remote.raw ?? {};
    const ticket = body.ticket && typeof body.ticket === 'object' ? (body.ticket as WireTicket) : null;
    if ((kind !== 'ticket' && kind !== 'test') || !ticket) return { status: 'failed', error: kind === 'ticket' || kind === 'test' ? 'ticket missing' : `${kind} not printed by this device` };
    const now = this.now();
    const existing = this.store.byRelayJobId(rid) ?? this.store.byId(rid);
    if (existing) {
      const back = takenBackAsHost(existing, rid, now, JSON.stringify(ticket));
      if (back) {
        this.store.update(back);
        this.wake();
        return TAKEN;
      }
      const tied = relayedAgain(existing, rid);
      if (tied) this.store.update(tied);
      return TAKEN;
    }
    const printerId = remote.printerId ?? (typeof body.printerId === 'string' ? body.printerId : null);
    const printer = (printerId ? this.printerById(printerId) : null) ?? this.hostedPrinterOf(body.printer);
    if (!printer) return { status: 'failed', error: 'printer unknown on host' };
    const style = kind === 'test' && body.ticketStyle && typeof body.ticketStyle === 'object' ? (body.ticketStyle as Record<string, unknown>) : null;
    const job = this.newJob(printer, style ? { ...ticket, style } : ticket, kind === 'test' ? 'test' : 'ticket', now, null);
    this.store.insertAll([{ ...job, id: rid, relayJobId: rid, route: 'DIRECT' }]);
    this.wake();
    return TAKEN;
  }

  private hostedPrinterOf(raw: unknown): KitchenPrinter | null {
    const p = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
    if (!p) return null;
    const parsed = parsePrinter({ ...p, type: p.connection ?? p.type, inScope: false });
    return parsed;
  }

  /** The answers owed to the cloud for jobs printed here for others. */
  async sendAcks(): Promise<void> {
    const id = this.d.machineId();
    if (!id) return;
    for (const j of this.store.pendingAcks()) {
      const status = j.ackStatus!;
      const r = await this.d.api.post(`sync/${id}/print-jobs/${encodeURIComponent(j.relayJobId!)}/ack`, { status, error: j.lastError?.slice(0, 500) ?? null }, { timeoutMs: RELAY_CALL_MS });
      if (r.kind === 'offline') return;
      const settled = r.kind === 'ok' || (r.kind === 'refused' && (r.status === 404 || (status === 'printing' && r.status === 422)));
      if (!settled) continue;
      const now = this.store.byId(j.id);
      if (now && now.ackStatus === status) this.store.update({ ...now, ackStatus: null });
    }
  }
}

/** A lane's next ticket: its oldest (by when it was made). */
function headOf(jobs: readonly KitchenJob[]): KitchenJob {
  return [...jobs].sort((a, b) => a.createdAt - b.createdAt || a.queuedAt - b.queuedAt)[0];
}

const RELAY_POLL = 5_000;

