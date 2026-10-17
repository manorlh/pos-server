/**
 * "מדפסות" on the Windows till (core/till/printersView.ts has the rules; pos-android ui/kitchen/PrintersScreen.kt and what
 * it calls). Nothing here configures a printer: the receipt printer stays the technician's (main/service.ts
 * `printerResolution`, the USB watch), the kitchen's printers the cloud's (main/kitchen/kitchenService.ts) — this module
 * reads them, tests them, and hands the actions to the services that own them:
 *
 *  - the light of each printer (its own and the kitchen's) and of the shop's print server, every 30 s while the screen is
 *    open and on "בדיקת תקשורת" — a connect / the printer's status / the print server's `/kitchen/ping` / the cloud;
 *    the own printer's test looks for the USB printer again first (the "re-detect");
 *  - "בון בדיקה" (`KitchenService.testPrint`, through the same queue as a ticket), "הדפסת ניסיון בעיצוב הזה" (the design's
 *    sample ticket), "בדיקת רוחב" (frames of 384…576 dots, straight to a network printer);
 *  - "בונים שממתינים לטיפול": "נסה שוב" / "בטל בון" are the engine's own `printQueue.retry` / `printQueue.handled` (its
 *    manager's code), "מדפסת אחרת" / "הדפס בקופה" go through `printQueue.choices` / `printQueue.move`;
 *  - "הודפסו לאחרונה (24 שעות)" with "הדפס שוב" (a new job marked "הדפסה חוזרת");
 *  - "מדפסת לקבלות ולמסמכים" (this till's choice among another till's printers, the key tillRemotePrint.ts reads) — a
 *    manager's (CATALOG_WRITE, Android TILL_SETUP_SCOPE);
 *  - "חיפוש מדפסות ברשת" (the technician's scan, read only) and "הוספה" to the shop with a manager's code checked by the cloud
 *    (`POST /sync/{m}/printers`, `X-Elevation-Token` for `catalog:write`).
 *
 * Electron-free; the wires (connect, status, LAN, scan, raw send, the grant) are dependencies (the tests).
 */

import { centreOn, job as escposJob } from '../../core/escpos';
import type { KitchenPrinter } from '../../core/kitchen/config';
import { mayRedirect } from '../../core/kitchen/failover';
import type { KitchenJob } from '../../core/kitchen/queue';
import { lanTargetOf, tillPrinter, TILL_PRINTER_ID } from '../../core/kitchen/routing';
import { LABELS, withNotice, type KitchenLine, type WireTicket } from '../../core/kitchen/tickets';
import { SAMPLE_TICKET, TEST_PRINT_NOTICE } from '../../core/kitchenTicketStyle';
import { widthTestBitmap } from '../../core/technicianSetup';
import { displayName } from '../../core/till/staff';
import {
  addRefusalText,
  describePrinter,
  designNameOf,
  foundPrinterView,
  historyRowsOf,
  LAN_DOWN_DIRECT,
  LAN_DOWN_VIA_CLOUD,
  lightOf,
  ownHealthOf,
  PRINTERS_LABELS,
  PRINTERS_SETUP_PERMISSION,
  PRINTERS_TEXT,
  printServerView,
  probePlanOf,
  PROBE_EVERY_MS,
  queueRowsOf,
  statusTextOf,
  tillPrinters,
  VIA_CLOUD,
  VIA_LAN,
  waitingByPrinter,
  widthTestOffered,
  type FoundPrinterFacts,
  type PrinterHealthRec,
  type PrintersState,
  type PrintServerFacts,
  type ReceiptChoiceView,
} from '../../core/till/printersView';
import { LOCAL_DESTINATION, remoteAllows, remoteDestinationsOf, remoteDocSettingsOf, remoteRouteOf, TILL_CHOICE_ASK } from '../../core/till/remoteDocuments';
import { KitchenStore } from '../kitchen/kitchenStore';
import { lanCall as defaultLanCall, probePrinter, type LanCall } from '../kitchen/kitchenNet';
import { localPrivateIpv4 } from '../payment/pinpadRelocator';
import { healthOfBits, tcpSend, tcpStatus } from '../printer/transports';
import { targetText, usbStatusText } from '../printer/usbPrinters';
import { scanLanPrinters } from '../technician/technicianTools';
import type { TillContext, TillFeature } from './tillContext';
import { DEFAULT_PRINTER_KEY, TILL_PRINTER_KEY } from './tillRemotePrint';

export const PRINTERS_OPS = [
  'printers.open',
  'printers.close',
  'printers.check',
  'printers.test',
  'printers.designTest',
  'printers.widthTest',
  'printers.reprint',
  'printers.move',
  'printers.toTill',
  'printers.receipt',
  'printers.scan',
  'printers.scanStop',
  'printers.add',
] as const;

export const PRINTERS_MUTATING = [
  'printers.test',
  'printers.designTest',
  'printers.widthTest',
  'printers.reprint',
  'printers.move',
  'printers.toTill',
  'printers.receipt',
  'printers.add',
] as const;

type ScanResult = { ok: true; subnet: string; printers: Array<{ host: string; port: number; health: string }> } | { ok: false; error: 'not_on_lan' };
type Grant = { ok: true; token: string; name: string } | { ok: false; message: string };

export interface TillPrintersDeps {
  /** A TCP connect to a printer, nothing printed. */
  probeTcp?(host: string, port: number): Promise<boolean>;
  /** This till's own receipt printer: its health and whether there is one at all (looked for again first). */
  ownStatus?(): Promise<{ health: string; found: boolean }>;
  lanCall?: LanCall;
  /** "חיפוש מדפסות ברשת" (the technician's sweep of the /24, port 9100). */
  scan?(): Promise<ScanResult>;
  localIpv4?(): string | null;
  /** Bytes straight to a network printer ("בדיקת רוחב"). */
  sendRaw?(host: string, port: number, bytes: Uint8Array): Promise<void>;
  /** A typed code's grant for a cloud write (the technician's `managerGrant`). */
  grant?(pin: string, scope: string): Promise<Grant>;
  pollMs?: number;
}

export class TillPrinters implements TillFeature {
  readonly key = 'printers';
  readonly ops = PRINTERS_OPS;
  readonly mutating = PRINTERS_MUTATING;

  private openedBy: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private offKitchen: (() => void) | null = null;
  private readonly health = new Map<string, PrinterHealthRec>();
  private readonly checking = new Set<string>();
  private server: PrintServerFacts | null = null;
  private message: string | null = null;
  /* What the queue and the settings said at the last look (state() reads no database). */
  private attention: KitchenJob[] = [];
  private recent: KitchenJob[] = [];
  private waiting = new Map<string, number>();
  private receipt: ReceiptChoiceView | null = null;
  private receiptIds: Array<string | null> = [];
  private store: KitchenStore | null = null;
  private discovery: { scanning: boolean; text: string | null; found: FoundPrinterFacts[] } | null = null;
  private scanGen = 0;
  private probeGen = 0;

  constructor(
    private readonly c: TillContext,
    private readonly deps: TillPrintersDeps = {},
  ) {}

  /* ------------------------------------------------------------------ the state */

  state(): PrintersState | undefined {
    const op = this.c.operator();
    if (!op || this.openedBy !== op.id) return undefined;
    const svc = this.c.svc;
    const config = svc.kitchen.config();
    const own = tillPrinter(LABELS.till);
    const printers = tillPrinters(config, own);
    const res = svc.printerResolution();
    const ownWhere = `${PRINTERS_TEXT.own} · ${targetText(res)}`;
    const rows = printers.map((p) => {
      const queued = this.waiting.get(p.id) ?? 0;
      const h = this.health.get(p.id) ?? null;
      const isOwn = p.id === TILL_PRINTER_ID;
      return {
        id: p.id,
        name: p.name,
        light: lightOf(h, queued),
        where: isOwn ? ownWhere : describePrinter(p, config.printHost),
        usb: isOwn && res.target.transport === 'spooler' ? usbStatusText(svc.usbWatch.pick()) : null,
        design: !isOwn && p.purpose !== 'receipt' ? PRINTERS_TEXT.design(designNameOf(p)) : null,
        status: statusTextOf(h, queued),
        checking: this.checking.has(p.id),
        widthTest: widthTestOffered(p),
        designTest: !isOwn && p.purpose !== 'receipt',
      };
    });
    const history = historyRowsOf(this.recent, this.c.now());
    const queue = queueRowsOf(this.attention, mayRedirect);
    return {
      title: PRINTERS_TEXT.title,
      queue: queue.length > 0 ? { title: PRINTERS_TEXT.queueTitle, rows: queue } : null,
      server: this.server ? printServerView(this.server) : null,
      receipt: this.receipt ?? this.receiptView(),
      listTitle: PRINTERS_TEXT.listTitle,
      rows,
      none: printers.some((p) => p.id !== TILL_PRINTER_ID) ? null : PRINTERS_TEXT.none,
      message: this.message,
      history: history.length > 0 ? { title: PRINTERS_TEXT.historyTitle, rows: history } : null,
      discovery: {
        title: PRINTERS_TEXT.discoveryTitle,
        hint: PRINTERS_TEXT.discoveryHint,
        scanning: this.discovery?.scanning === true,
        startLabel: this.discovery && !this.discovery.scanning ? PRINTERS_TEXT.discoveryAgain : PRINTERS_TEXT.discoveryTitle,
        stopLabel: PRINTERS_TEXT.discoveryStop,
        text: this.discovery?.text ?? null,
        found: (this.discovery?.found ?? []).map(foundPrinterView),
        add: {
          label: PRINTERS_TEXT.discoveryAdd,
          name: PRINTERS_TEXT.discoveryAddName,
          purpose: PRINTERS_TEXT.discoveryAddPurpose,
          kitchen: PRINTERS_TEXT.discoveryPurposeKitchen,
          receipt: PRINTERS_TEXT.discoveryPurposeReceipt,
          hint: PRINTERS_TEXT.discoveryAddHint,
          cancel: PRINTERS_TEXT.cancel,
        },
      },
      labels: PRINTERS_LABELS,
    };
  }

  stop(): void {
    this.stopLoop();
  }

  /* ------------------------------------------------------------------ the ops */

  async apply(op: string, a: Record<string, unknown>): Promise<unknown> {
    switch (op) {
      case 'printers.open':
        return this.open();
      case 'printers.close':
        this.openedBy = null;
        this.stopLoop();
        return undefined;
      case 'printers.check': {
        const p = this.printer(a);
        void this.probeOne(p);
        return undefined;
      }
      case 'printers.test':
        return this.testTicket(this.printer(a));
      case 'printers.designTest':
        return this.designTest(this.printer(a));
      case 'printers.widthTest':
        return this.widthTest(this.printer(a));
      case 'printers.reprint':
        return this.reprint(this.jobArg(a));
      case 'printers.move':
        return this.move(this.jobArg(a));
      case 'printers.toTill': {
        const id = this.jobArg(a);
        return this.c.run('printQueue.move', { jobId: id, toId: TILL_PRINTER_ID });
      }
      case 'printers.receipt':
        return this.setReceipt(a.choice);
      case 'printers.scan':
        return this.scan();
      case 'printers.scanStop':
        this.mine();
        if (this.discovery?.scanning) {
          this.scanGen += 1;
          this.discovery = { scanning: false, text: PRINTERS_TEXT.discoveryCancelled, found: [] };
        }
        return undefined;
      case 'printers.add':
        return this.add(a);
      default:
        return this.c.refuse('unknown_op');
    }
  }

  private mine() {
    const user = this.c.signedIn();
    if (this.openedBy !== user.id) return this.c.refuse('permission_denied');
    return user;
  }

  private printer(a: Record<string, unknown>): KitchenPrinter {
    this.mine();
    const id = a.printerId;
    if (typeof id !== 'string' || !id) return this.c.refuse('invalid_args');
    const p = tillPrinters(this.c.svc.kitchen.config(), tillPrinter(LABELS.till)).find((x) => x.id === id);
    if (!p) return this.c.refuse('invalid_args');
    return p;
  }

  private jobArg(a: Record<string, unknown>): string {
    this.mine();
    const id = a.jobId;
    if (typeof id !== 'string' || !id || !this.c.svc.kitchen.job(id)) return this.c.refuse('invalid_args');
    return id;
  }

  /* ------------------------------------------------------------------ opening, the live light */

  /** "מדפסות": the queue, the settings, every printer tested now and every 30 s while open. */
  private open() {
    const user = this.c.signedIn();
    if (this.openedBy !== user.id) {
      this.health.clear();
      this.message = null;
      this.discovery = null;
    }
    this.openedBy = user.id;
    this.reload();
    this.startLoop();
    void this.probeAll();
    return undefined;
  }

  private startLoop() {
    if (!this.offKitchen) {
      this.offKitchen = this.c.svc.kitchen.onChange(() => {
        if (!this.openedBy) return;
        this.reload();
        this.c.changed();
      });
    }
    if (this.timer) return;
    this.timer = setInterval(() => {
      const op = this.c.operator();
      if (!op || op.id !== this.openedBy) {
        this.openedBy = null;
        this.stopLoop();
        return;
      }
      this.reload();
      void this.probeAll();
    }, this.deps.pollMs ?? PROBE_EVERY_MS);
    this.timer.unref?.();
  }

  private stopLoop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.offKitchen?.();
    this.offKitchen = null;
    this.probeGen += 1;
    this.checking.clear();
  }

  /** The queue, the history, the receipt choice — read once here, not on every state. */
  private reload() {
    const svc = this.c.svc;
    try {
      this.store ??= new KitchenStore(svc.db);
      this.attention = svc.kitchen.attention();
      this.recent = this.store.recent(200);
      this.waiting = waitingByPrinter(this.store.open());
    } catch (e) {
      this.c.log(`printers: the kitchen queue not read (${String(e)})`);
    }
    this.receipt = this.receiptView();
  }

  private async probeAll(): Promise<void> {
    const printers = tillPrinters(this.c.svc.kitchen.config(), tillPrinter(LABELS.till));
    await Promise.all([this.probeServer(), ...printers.map((p) => this.probeOne(p))]);
  }

  /** "בדיקת תקשורת": the printer reached the way a job would go, nothing printed. */
  private async probeOne(p: KitchenPrinter): Promise<void> {
    if (this.checking.has(p.id)) return;
    const gen = this.probeGen;
    this.checking.add(p.id);
    this.c.changed();
    let rec: PrinterHealthRec;
    try {
      rec = await this.probe(p);
    } catch (e) {
      rec = { level: 'error', at: this.c.now(), detail: e instanceof Error ? e.message : String(e) };
    }
    if (gen !== this.probeGen) return;
    this.checking.delete(p.id);
    this.health.set(p.id, rec);
    // It answers again: a temporary "מדפסת חלופית" redirect of it ends (KitchenPrintService.record).
    if (rec.level === 'ok' && this.c.svc.kitchen.redirects().some((r) => r.fromId === p.id)) this.c.svc.kitchen.endRedirect(p.id);
    this.c.changed();
  }

  private async probe(p: KitchenPrinter): Promise<PrinterHealthRec> {
    const now = () => this.c.now();
    const config = this.c.svc.kitchen.config();
    const plan = probePlanOf(p, config.printHost);
    switch (plan.kind) {
      case 'own': {
        const s = await this.ownStatus();
        const h = ownHealthOf(s.health, s.found);
        return { ...h, at: now() };
      }
      case 'cloud':
        await this.cloudReachable();
        return { level: 'ok', at: now(), detail: VIA_CLOUD };
      case 'lan': {
        if (await this.pingLan(p)) return { level: 'ok', at: now(), detail: VIA_LAN };
        if (plan.directHost && (await this.probeTcp(plan.directHost.host, plan.directHost.port))) return { level: 'warn', at: now(), detail: LAN_DOWN_DIRECT };
        await this.cloudReachable();
        return { level: 'warn', at: now(), detail: LAN_DOWN_VIA_CLOUD };
      }
      case 'tcp':
        return (await this.probeTcp(plan.host, plan.port)) ? { level: 'ok', at: now(), detail: null } : { level: 'error', at: now(), detail: null };
      case 'unreachable':
        return { level: 'error', at: now(), detail: plan.why };
    }
  }

  private probeTcp(host: string, port: number): Promise<boolean> {
    return (this.deps.probeTcp ?? probePrinter)(host, port).catch(() => false);
  }

  /** This till's own printer: the USB printer looked for again, then its status (a network one: a connect, then DLE EOT). */
  private async ownStatus(): Promise<{ health: string; found: boolean }> {
    if (this.deps.ownStatus) return this.deps.ownStatus();
    const svc = this.c.svc;
    const t0 = svc.printerResolution().target;
    if (t0.transport === 'serial') {
      // A COM port: DLE EOT over the line (after any job on it — main/printer/serialPrinter.ts); no answer — off / unplugged.
      if (!t0.comPort) return { health: 'unknown', found: false };
      const st = await svc.receiptPrinterStatus();
      return { health: st.health === 'unavailable' ? 'offline' : st.health, found: true };
    }
    if (t0.transport === 'tcp') {
      if (!t0.host) return { health: 'unknown', found: false };
      const port = t0.port ?? 9100;
      if (!(await this.probeTcp(t0.host, port))) return { health: 'offline', found: true };
      return { health: healthOfBits(await tcpStatus(t0.host, port).catch(() => null)), found: true };
    }
    await svc.usbWatch.refresh().catch(() => null);
    const t = svc.printerResolution().target;
    if (t.transport !== 'spooler' || !t.queueName) return { health: 'unknown', found: false };
    const q = svc.usbWatch.current()?.queues.find((x) => x.name === t.queueName);
    return { health: q?.health ?? 'unknown', found: true };
  }

  /** The cloud answers this till (the printers' route, its ETag — nothing changes). Throws why not. */
  private async cloudReachable(): Promise<void> {
    const svc = this.c.svc;
    const m = svc.machineId;
    if (!m) throw new Error(PRINTERS_TEXT.discoveryAddOffline);
    const etag = svc.kitchen.config().etag;
    const r = await svc.api.get(`sync/${m}/printers${etag ? `?etag=${encodeURIComponent(etag)}` : ''}`, { timeoutMs: 10_000 });
    if (r.kind === 'offline') throw new Error('אין חיבור לענן');
    if (r.kind === 'refused') throw new Error(`cloud HTTP ${r.status}`);
  }

  private lan(): LanCall {
    return this.deps.lanCall ?? defaultLanCall;
  }

  /** The till that takes [p]'s jobs on the LAN answers `/kitchen/ping`, from here, now. */
  private async pingLan(p: KitchenPrinter): Promise<boolean> {
    const config = this.c.svc.kitchen.config();
    const target = lanTargetOf(p, config.printHost);
    if (!target || !config.printSecret || !this.c.svc.kitchen.lanReachable()) return false;
    try {
      const r = await this.lan()(target, config.printSecret, 'GET', '/kitchen/ping', null, { connectMs: 1_500, readMs: 4_000 });
      return r.status === 200;
    } catch {
      return false;
    }
  }

  /** The shop's print server, seen from this till (KitchenPrintService.printServerStatus). */
  private async probeServer(): Promise<void> {
    const svc = this.c.svc;
    const config = svc.kitchen.config();
    const host = config.printHost;
    if (!host) {
      this.server = null;
      return;
    }
    const onLan = svc.kitchen.lanReachable() && !host.offLan;
    let facts: PrintServerFacts;
    if (host.isSelf) {
      const ip = (this.deps.localIpv4 ?? localPrivateIpv4)();
      const port = svc.kitchenHost.listening() ?? host.port;
      facts = { name: host.name, self: true, address: ip ? `${ip}:${port}` : null, onLan, reachable: svc.kitchenHost.listening() !== null && onLan };
    } else {
      const address = host.lanAddress ? `${host.lanAddress}:${host.port}` : null;
      let reachable = false;
      if (onLan && host.lanAddress && config.printSecret) {
        try {
          reachable = (await this.lan()({ address: host.lanAddress, port: host.port }, config.printSecret, 'GET', '/kitchen/ping', null, { connectMs: 1_500, readMs: 4_000 })).status === 200;
        } catch {
          reachable = false;
        }
      }
      facts = { name: host.name, self: false, address, onLan, reachable };
    }
    this.server = facts;
    this.c.changed();
  }

  /* ------------------------------------------------------------------ test prints */

  private by(): string | null {
    const op = this.c.operator();
    return op ? displayName(op) : null;
  }

  private say(text: string) {
    this.message = text;
    this.c.changed();
  }

  /** "בון בדיקה" — through the same queue as a ticket (and the print server / the cloud when that is the way). */
  private testTicket(p: KitchenPrinter) {
    try {
      this.c.svc.kitchen.testPrint(p.id, this.by());
      this.say(PRINTERS_TEXT.testSent(p.name));
    } catch (e) {
      this.say(e instanceof Error ? e.message : String(e));
    }
    this.reload();
    return undefined;
  }

  /** "הדפסת ניסיון בעיצוב הזה": the design's sample ticket (now, by the operator, "הדפסת ניסיון — לא להכנה" first). */
  private designTest(p: KitchenPrinter) {
    if (p.id === TILL_PRINTER_ID || p.purpose === 'receipt') return this.c.refuse('invalid_args');
    const now = this.c.now();
    const ticket: WireTicket = {
      ...SAMPLE_TICKET,
      createdAt: new Date(now).toISOString(),
      openedAt: new Date(now - 25 * 60_000).toISOString(),
      waiterName: this.by() ?? SAMPLE_TICKET.waiterName,
      // The kitchen names this device itself (KitchenService.enqueue: `tillName`).
      sourceName: null,
      notice: [TEST_PRINT_NOTICE, SAMPLE_TICKET.notice].filter(Boolean).join(' · '),
    };
    const lines: KitchenLine[] = SAMPLE_TICKET.lines.map((l) => ({ ...l, productId: l.productId ?? '', categoryId: l.categoryId ?? null }));
    const q = this.c.svc.kitchen.enqueue(ticket, lines, { onlyPrinterId: p.id });
    this.say(q.jobIds.length > 0 ? PRINTERS_TEXT.testDesignSent(p.name) : PRINTERS_TEXT.notReachable);
    this.reload();
    return undefined;
  }

  /** "בדיקת רוחב": frames at 384 / 432 / 512 / 576 dots, straight to a network printer this till reaches. */
  private widthTest(p: KitchenPrinter) {
    if (!widthTestOffered(p) || !p.host) return this.c.refuse('invalid_args');
    const host = p.host;
    const port = p.port ?? 9100;
    const bytes = escposJob(centreOn(widthTestBitmap(), 576), { cut: true });
    void this.c.later(async () => {
      try {
        await (this.deps.sendRaw ?? tcpSend)(host, port, bytes);
        this.say(PRINTERS_TEXT.widthTestSent(p.name));
      } catch (e) {
        this.say(PRINTERS_TEXT.statusFault(e instanceof Error ? e.message : String(e)));
      }
    });
    return undefined;
  }

  /** "הדפס שוב" — a printed ticket again, a new job marked "הדפסה חוזרת" (the printed one stays in the history). */
  private reprint(jobId: string) {
    const job = this.c.svc.kitchen.job(jobId)!;
    if (job.state !== 'done') return this.c.refuse('invalid_args');
    let ticket: WireTicket;
    try {
      ticket = JSON.parse(job.ticketJson) as WireTicket;
    } catch {
      return this.c.refuse('invalid_args');
    }
    const lines: KitchenLine[] = [
      ...(ticket.lines ?? []).map((l) => ({ ...l, productId: l.productId ?? '', categoryId: l.categoryId ?? null })),
      ...(ticket.waiting ?? []).map((l) => ({ ...l, productId: l.productId ?? '', categoryId: l.categoryId ?? null, waiting: true })),
    ];
    const { waiting: _held, ...rest } = ticket;
    void _held;
    const q = this.c.svc.kitchen.enqueue({ ...rest, notice: withNotice(ticket.notice, LABELS.reprint) }, lines, { onlyPrinterId: job.printerId });
    // Android says nothing on a reprint (the history and the queue show it); a printer gone from the settings — said.
    if (q.jobIds.length === 0) this.say(PRINTERS_TEXT.notReachable);
    this.reload();
    return undefined;
  }

  /* ------------------------------------------------------------------ the queue */

  /** "מדפסת אחרת": "בחרו מדפסת" among those the engine's queue offers (each with its light), moved by the engine. */
  private async move(jobId: string) {
    const choices = ((await this.c.run('printQueue.choices', { jobId })) ?? []) as Array<{ id: string; label: string }>;
    this.c.ask({
      kind: 'confirm',
      title: PRINTERS_TEXT.pickPrinter,
      body: choices.length > 0 ? '' : PRINTERS_TEXT.noOtherPrinter,
      fields: [],
      actions: [...choices.filter((ch) => ch.id !== TILL_PRINTER_ID).map((ch) => ({ id: `to:${ch.id}`, label: ch.label })), { id: 'cancel', label: PRINTERS_TEXT.close }],
      onAction: (action) => this.c.run('printQueue.move', { jobId, toId: action.replace(/^to:/, '') }),
      onCancel: () => undefined,
    });
    return undefined;
  }

  /* ------------------------------------------------------------------ "מדפסת לקבלות ולמסמכים" */

  private receiptView(): ReceiptChoiceView {
    const svc = this.c.svc;
    const T = PRINTERS_TEXT;
    const s = remoteDocSettingsOf(svc.cloud.parameters());
    const dests = remoteDestinationsOf(svc.kitchen.config().printers, s, svc.machineId);
    const hasOwn = svc.hasOwnReceiptPrinter();
    const tillChoice = svc.kv.get(TILL_PRINTER_KEY)?.trim() || null;
    const defaultId = svc.kv.get(DEFAULT_PRINTER_KEY);
    const route = remoteRouteOf({ hasOwn, destinations: dests, eligible: remoteAllows(s, 'receipt'), tillChoice, defaultId });
    const now = route.kind === 'remote' ? route.destination.name : route.kind === 'ask' ? T.receiptAsk : hasOwn ? T.own : T.noReceiptPrinter;
    const options: Array<{ id: string; label: string }> =
      dests.length === 0 ? [] : [...(hasOwn ? [{ id: LOCAL_DESTINATION, label: T.own }] : []), ...dests.map((d) => ({ id: d.id, label: d.name })), { id: TILL_CHOICE_ASK, label: T.receiptAsk }];
    this.receiptIds = [null, ...options.map((o) => o.id)];
    return {
      title: T.receiptTitle,
      hint: T.receiptHint,
      now: T.receiptNow(now),
      override: tillChoice ? T.receiptOverride : null,
      followsCloud: tillChoice ? null : T.receiptFollowsCloud,
      backLabel: T.receiptBackToCloud,
      gone: tillChoice && !options.some((o) => o.id === tillChoice) ? T.receiptGone : null,
      options: options.map((o) => ({ ...o, on: o.id === tillChoice })),
    };
  }

  /** This till's choice (null: back to the cloud's) — a manager's, as on Android; logged. */
  private setReceipt(raw: unknown) {
    const user = this.mine();
    if (raw !== null && typeof raw !== 'string') return this.c.refuse('invalid_args');
    const choice = raw === null || raw === '' ? null : raw;
    this.receipt = this.receiptView();
    if (!this.receiptIds.includes(choice)) return this.c.refuse('invalid_args');
    const kv = this.c.svc.kv;
    const before = kv.get(TILL_PRINTER_KEY)?.trim() || null;
    if (choice === before) return undefined;
    const name = choice === null ? PRINTERS_TEXT.receiptFollowsCloud : (this.receipt.options.find((o) => o.id === choice)?.label ?? choice);
    return this.c.gate(
      PRINTERS_SETUP_PERMISSION,
      (approver) => {
        if (choice === null) kv.delete(TILL_PRINTER_KEY);
        else kv.set(TILL_PRINTER_KEY, choice);
        // A new choice: the question's memory starts again (as the technician's).
        kv.delete(DEFAULT_PRINTER_KEY);
        this.c.log(`receipt printer: this till's choice ${before ?? 'cloud'} -> ${choice ?? 'cloud'} (${name}) by ${displayName(user)}, approved by ${approver?.name ?? '-'}`);
        this.reload();
        return undefined;
      },
      { askOnDeny: true, body: PRINTERS_TEXT.receiptChangeApproval(name) },
    );
  }

  /* ------------------------------------------------------------------ "חיפוש מדפסות ברשת" */

  private scan() {
    this.mine();
    if (this.discovery?.scanning) return undefined;
    const gen = ++this.scanGen;
    const t0 = this.c.now();
    this.discovery = { scanning: true, text: PRINTERS_TEXT.discoveryScanningStart, found: [] };
    void (async () => {
      let r: ScanResult | null = null;
      let failure: string | null = null;
      try {
        r = await (this.deps.scan ?? scanLanPrinters)();
      } catch (e) {
        failure = e instanceof Error ? e.message : String(e);
      }
      await this.c.later(() => {
        if (gen !== this.scanGen) return;
        const svc = this.c.svc;
        if (!r || failure) {
          this.discovery = { scanning: false, text: PRINTERS_TEXT.discoveryFailed(failure ?? '?'), found: [] };
        } else if (!r.ok) {
          this.discovery = { scanning: false, text: PRINTERS_TEXT.discoveryNotOnLan, found: [] };
        } else {
          const known = svc.kitchen.config().printers;
          const own = svc.printerResolution().target;
          const found: FoundPrinterFacts[] = r.printers.map((p) => ({
            host: p.host,
            port: p.port,
            health: p.health,
            known: known.find((k) => k.host === p.host && (k.port ?? 9100) === p.port)?.name ?? (own.transport === 'tcp' && own.host === p.host ? PRINTERS_TEXT.own : null),
          }));
          const sec = Math.max(0, Math.round((this.c.now() - t0) / 1000));
          this.discovery = { scanning: false, text: found.length === 0 ? PRINTERS_TEXT.discoveryNone(r.subnet) : PRINTERS_TEXT.discoveryDone(found.length, r.subnet, sec), found };
        }
        this.c.changed();
      });
    })().catch((e: unknown) => this.c.log(`printers scan: ${String(e)}`));
    return undefined;
  }

  /** "הוספה": the printer found, to the shop — a code the cloud checks for `catalog:write`, then the printers pulled again. */
  private add(a: Record<string, unknown>) {
    this.mine();
    const host = typeof a.host === 'string' ? a.host.trim() : '';
    const port = typeof a.port === 'number' && Number.isInteger(a.port) && a.port > 0 && a.port < 65536 ? a.port : 9100;
    const purpose = a.purpose === 'receipt' ? 'receipt' : a.purpose === 'kitchen' ? 'kitchen' : null;
    const name = typeof a.name === 'string' ? a.name.trim().slice(0, 80) : '';
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || !purpose) return this.c.refuse('invalid_args');
    if (!this.discovery?.found.some((f) => f.host === host && f.port === port)) return this.c.refuse('invalid_args');
    const svc = this.c.svc;
    const grant = this.deps.grant ?? ((pin: string, scope: string) => svc.techSetup.managerGrant(pin, scope));
    let token: string | null = null;
    const label = name || `${PRINTERS_TEXT.discoveryUnnamed} ${host}`;
    this.c.ask({
      kind: 'manager_approval',
      title: PRINTERS_TEXT.discoveryAddTitle(host),
      body: PRINTERS_TEXT.discoveryAddReason,
      fields: [{ name: 'pin', label: PRINTERS_TEXT.managerCode, kind: 'pin' }],
      actions: [
        { id: 'approve', label: PRINTERS_TEXT.approve, primary: true },
        { id: 'cancel', label: PRINTERS_TEXT.cancel },
      ],
      verify: async (pin) => {
        const g = await grant(pin, 'catalog:write');
        if (!g.ok) return { ok: false, message: g.message };
        token = g.token;
        return { ok: true, by: { id: '', name: g.name } };
      },
      resume: (by) => {
        const t = token;
        if (!t) return undefined;
        void this.c.later(async () => {
          const m = svc.machineId;
          if (!m) return this.say(PRINTERS_TEXT.discoveryAddOffline);
          const r = await svc.api.post(`sync/${m}/printers`, { name: label, host, port, purpose }, { headers: { 'X-Elevation-Token': t }, timeoutMs: 20_000 });
          if (r.kind === 'ok') {
            this.c.log(`printers: ${host}:${port} added to the shop (${purpose}) by ${by?.name ?? '-'}`);
            await svc.kitchen.pull(true).catch(() => false);
            if (this.discovery) this.discovery = { ...this.discovery, found: this.discovery.found.map((f) => (f.host === host && f.port === port ? { ...f, known: label } : f)) };
            this.reload();
            return this.say(PRINTERS_TEXT.discoveryAdded(label));
          }
          return this.say(addRefusalText(r.kind === 'offline' ? null : r.status, r.kind === 'refused' ? (typeof r.detail === 'string' ? r.detail : null) : null));
        });
        return undefined;
      },
      onCancel: () => undefined,
    });
    return undefined;
  }
}
