/**
 * The kiosk's local service: everything behind the screens, in the main process, with no Electron
 * import (so tools and tests run it under plain Node). It owns the database, the cloud copies, the
 * sync engine, the media store, the payment, the printer, the shifts and the Z, and answers the
 * screens (shared/bridge.ts) from local data only.
 */

import { createHash, pbkdf2Sync, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { resolveKioskConfig } from '@dash-lib/kioskConfig';
import { localDate, kioskOperator, closerName, bonStep, type KioskOrder, type PickupRules } from '../core/kioskOrders';
import { OfflineTracker } from '../core/kioskHealth';
import { formatDocNumber, prefixFor } from '../core/documentNumbers';
import { ofShekels } from '../core/money';
import { bonDoc, receiptDoc, slipDoc, zDoc, type BusinessInfo, type ReceiptLine } from '../core/printDocs';
import { saleDocumentType, saleTotals, tipOf, unitAgorot, vatRateOf, type SaleLine } from '../core/sale';
import { autoCloseMayRun, zModeOf } from '../core/tillZ';
import { attempt as techAttempt, codeMatches, NO_LOCK, type TechLock } from '../core/technician';
import { pickVariant, type MediaRefIn } from '../core/mediaPlan';
import { openDb, type Db } from './db/sqlite';
import { Kv, migrate } from './db/schema';
import { Api, type FetchFn } from './sync/api';
import { CloudStore, parameterOn, PLAIN_BOX, type SecretBox } from './sync/cloud';
import { Outbox, type OutboxRow } from './sync/outbox';
import { pair as pairRequest, SyncEngine } from './sync/syncEngine';
import { documentWire, Ledger, type DocDraft } from './fiscal/ledger';
import { TillZService } from './fiscal/tillZService';
import { MediaStore, type Downloader, type VariantMaker } from './media/mediaStore';
import { PayService } from './payment/payService';
import { PROVIDERS } from './payment/registry';
import type { PaymentProvider, ProviderContext, ProviderFactory } from './payment/provider';
import { PrintQueue, type PageRenderer } from './printer/printQueue';
import { DefaultTransport, guessQueue, type PrinterTarget, type Transport } from './printer/transports';
import { allocatePickup, OrderStore } from './kiosk/orders';
import { buildKioskCatalog, catalogMedia, type KProduct } from './kiosk/catalog';
import type {
  AdminAction,
  AdminInfo,
  BasketChange,
  KioskEvents,
  KioskView,
  PayProgress,
  StartPaymentIn,
  StartPaymentOut,
  TechnicianAction,
  TechnicianInfo,
} from '../shared/bridge';

export interface PlatformHooks {
  quit(): void;
  /** Open TeamViewer QuickSupport when installed; the path launched, or null. */
  launchQuickSupport(): Promise<string | null>;
  networkUp(): boolean;
  interfaces(): Array<{ name: string; address: string }>;
  setZoom?(zoom: number): void;
  checkUpdate?(): Promise<{ available: string | null; status: string }>;
  installUpdate?(): Promise<{ ok: boolean; message?: string }>;
}

export interface ServiceOptions {
  dataDir: string;
  appVersion: string;
  deviceInfo: Record<string, string>;
  secretBox?: SecretBox;
  renderer?: PageRenderer | null;
  transport?: Transport;
  downloader?: Downloader;
  variantMaker?: VariantMaker;
  /** The payment terminals, in order (default: payment/registry.ts — the Nayax LAN pinpad, SynqPay…). */
  providers?: ProviderFactory[];
  platform?: Partial<PlatformHooks>;
  /** The HTTP client (tests and the smoke tool record or fake it). */
  fetch?: FetchFn;
  log?: (m: string) => void;
}

/** The kiosk's own local settings (not the cloud's): the printer, the zoom. */
export interface LocalSettings {
  printer: PrinterTarget;
  zoom: number | null;
}

const LOCAL_SETTINGS = 'local.settings';
const LOCAL_PAUSE = 'local.pause';
const TECH_LOCK = 'technician.lock';
const HELP = 'kiosk.helpRequest';

export class KioskService extends EventEmitter {
  readonly db: Db;
  readonly kv: Kv;
  readonly cloud: CloudStore;
  readonly api: Api;
  readonly outbox: Outbox;
  readonly ledger: Ledger;
  readonly media: MediaStore;
  readonly pay: PayService;
  readonly printQueue: PrintQueue;
  readonly tillZ: TillZService;
  readonly orders: OrderStore;
  readonly sync: SyncEngine;
  private readonly transport: Transport;
  private readonly log: (m: string) => void;
  private readonly platform: PlatformHooks;
  private readonly providers: ProviderFactory[];
  private readonly offline = new OfflineTracker();
  private offlineNow = false;
  private readonly startedAt = Date.now();
  private timers: NodeJS.Timeout[] = [];
  private flow = { flowState: 'attract', screen: 'attract', busy: false, idle: true };
  private lastFlowScreen = 'attract';
  private viewCache: KioskView | null = null;
  private viewDirty = true;
  private payProgress: PayProgress | null = null;
  private adminUntil = 0;
  private adminName: string | null = null;
  private pendingClose: { requestId: string } | null = null;
  private pendingZ: { requestId: string } | null = null;
  private pendingTransmit: { requestId: string } | null = null;

  constructor(private readonly opts: ServiceOptions) {
    super();
    this.log = opts.log ?? (() => undefined);
    this.platform = {
      quit: () => undefined,
      launchQuickSupport: async () => null,
      networkUp: () => true,
      interfaces: () => [],
      ...opts.platform,
    };
    mkdirSync(opts.dataDir, { recursive: true });
    this.db = openDb(path.join(opts.dataDir, 'kiosk.db'));
    migrate(this.db);
    this.kv = new Kv(this.db);
    this.cloud = new CloudStore(this.kv, opts.secretBox ?? PLAIN_BOX);
    const creds = this.cloud.credentials();
    this.api = new Api(creds?.serverUrl ?? 'http://localhost/', () => this.cloud.credentials()?.accessToken ?? null, opts.fetch, `R2M-Kiosk-Windows/${opts.appVersion}`);
    this.outbox = new Outbox(this.db);
    this.ledger = new Ledger(this.db, this.kv, this.outbox);
    this.media = new MediaStore(this.db, path.join(opts.dataDir, 'media'), opts.downloader, opts.variantMaker, this.log);
    this.pay = new PayService(this.db, this.log);
    this.transport = opts.transport ?? new DefaultTransport(this.log);
    this.printQueue = new PrintQueue(this.db, this.transport, () => this.localSettings().printer, opts.renderer ?? null, this.log);
    this.orders = new OrderStore(this.db);
    this.providers = opts.providers ?? PROVIDERS;
    this.tillZ = new TillZService({
      db: this.db,
      kv: this.kv,
      api: this.api,
      ledger: this.ledger,
      machineId: () => this.machineId,
      zMode: () => this.cloud.heartbeat().zMode,
      flush: () => this.sync.flush(),
      transmit: () => this.transmitBatch('z_close'),
      print: (z) => this.printZ(z),
      log: this.log,
    });
    this.sync = new SyncEngine(this.api, this.cloud, this.ledger, this.outbox, this.remoteHooks(), opts.appVersion);
    this.media.onChange(() => this.dirty());
    this.pay.onChange(() => this.dirty());
    this.printQueue.onChange(() => this.dirty());
    this.outbox.onEnqueue(() => {
      void this.sync.flush();
    });
    this.applyProvider();
  }

  get machineId(): string | null {
    return this.cloud.credentials()?.machineId ?? null;
  }

  get paired(): boolean {
    return !!this.cloud.credentials();
  }

  /* ------------------------------------------------------------ lifecycle */

  async start(): Promise<void> {
    this.printQueue.recover();
    this.orders.prune();
    if (this.paired) {
      this.sync.start();
      void this.settleOrphans();
      void this.syncMedia();
    }
    this.timers.push(setInterval(() => void this.tick10(), 10_000));
    this.timers.push(setInterval(() => void this.tick30(), 30_000));
    this.timers.push(setInterval(() => this.tick5(), 5_000));
    void this.printQueue.work();
  }

  stop() {
    this.stopped = true;
    if (this.emitTimer) clearTimeout(this.emitTimer);
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.sync.stop();
    this.transport.dispose();
    this.db.close();
  }

  private dirty() {
    this.viewDirty = true;
    // Coalesced: one view per tick at most.
    if (!this.emitTimer && !this.stopped) {
      this.emitTimer = setTimeout(() => {
        this.emitTimer = null;
        if (!this.stopped) this.emitEvent('view', this.view());
      }, 50);
    }
  }
  private emitTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  emitEvent<K extends keyof KioskEvents>(name: K, payload: KioskEvents[K]) {
    this.emit(name, payload);
  }

  /* --------------------------------------------------------- local settings */

  localSettings(): LocalSettings {
    const s = this.kv.getJson<Partial<LocalSettings>>(LOCAL_SETTINGS) ?? {};
    const params = this.cloud.parameters();
    const addr = typeof params.receiptPrinterAddress === 'string' ? params.receiptPrinterAddress.trim() : '';
    let printer = s.printer ?? null;
    if (!printer) {
      // The cloud's "מדפסת חשבוניות — כתובת" when it is a network address, else the spooler.
      const m = /^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d+))?$/.exec(addr);
      printer = m ? { transport: 'tcp', host: m[1], port: m[2] ? Number(m[2]) : 9100 } : { transport: 'spooler', queueName: null };
    }
    return { printer, zoom: s.zoom ?? null };
  }

  setLocalSettings(patch: Partial<LocalSettings>) {
    this.kv.setJson(LOCAL_SETTINGS, { ...this.localSettings(), ...patch });
    this.dirty();
  }

  /** The spooler queue, found once when none is chosen (SNBC / BTP, else Generic / Text Only). */
  private async ensurePrinterQueue() {
    const s = this.localSettings();
    if (s.printer.transport !== 'spooler' || s.printer.queueName) return;
    const list = await this.transport.list().catch(() => []);
    const name = guessQueue(list.map((p) => p.name));
    if (name) this.setLocalSettings({ printer: { transport: 'spooler', queueName: name } });
  }

  /* ---------------------------------------------------------------- views */

  private settingsMap(): Record<string, unknown> {
    return this.cloud.settings().settings ?? {};
  }

  private business(): BusinessInfo {
    const b = (this.cloud.settings().businessInfo ?? {}) as Record<string, unknown>;
    const s = (v: unknown) => (typeof v === 'string' ? v : null);
    return {
      companyName: s(b.companyName) ?? this.cloud.machine()?.companyName ?? null,
      vatNumber: s(b.vatNumber),
      companyRegNumber: s(b.companyRegNumber),
      companyAddress: s(b.companyAddress),
      companyAddressNumber: s(b.companyAddressNumber),
      companyCity: s(b.companyCity),
      companyZip: s(b.companyZip),
      phone: s(b.phone),
      dealerType: s(b.dealerType) ?? s(this.settingsMap().dealerType),
      branchId: s(b.branchId),
    };
  }

  private vatRate(): number {
    return vatRateOf(this.settingsMap().globalTaxRate, this.business().dealerType);
  }

  private snapshot(): Record<string, unknown> | null {
    return this.cloud.kioskSnapshot();
  }

  isKiosk(): boolean {
    return this.snapshot()?.kiosk === true;
  }

  operator() {
    const snap = this.snapshot();
    return kioskOperator((snap?.operator as { id?: unknown; name?: unknown }) ?? null, this.machineId ?? 'unpaired', (snap?.name as string) ?? this.cloud.machine()?.machineName ?? null);
  }

  /** The effective config (the cloud's, completed by the defaults), as the screens and rules read it. */
  config(): ReturnType<typeof resolveKioskConfig> {
    const raw = this.snapshot()?.config;
    return resolveKioskConfig(raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null);
  }

  private localMediaUrl(url: string | null | undefined, size: 'card' | 'large' | 'full' = 'full'): string | null {
    const e = this.media.entry(url ?? null);
    if (!e) return null;
    const file = size === 'card' ? pickVariant(e, 240, 2) : size === 'large' ? pickVariant(e, 480, 2) : `${e.sha256}.${e.ext}`;
    return `kiosk://media/${file}`;
  }

  /** Every MediaRef in the config pointed at its local copy; one not on disk becomes null (or drops out of a list). */
  private localizeConfig(cfg: unknown): unknown {
    const walk = (v: unknown): unknown => {
      if (Array.isArray(v)) {
        return v
          .map(walk)
          .filter((x) => !(x && typeof x === 'object' && 'media' in (x as object) && (x as { media: unknown }).media === null));
      }
      if (v && typeof v === 'object') {
        const o = v as Record<string, unknown>;
        if (typeof o.url === 'string' && (o.kind === 'image' || o.kind === 'video' || o.kind === 'font')) {
          const local = this.localMediaUrl(o.url);
          return local ? { ...o, url: local } : null;
        }
        const out: Record<string, unknown> = {};
        for (const [k, x] of Object.entries(o)) out[k] = walk(x);
        if (o.categoryImages && typeof o.categoryImages === 'object') {
          const ci: Record<string, unknown> = {};
          for (const [k, x] of Object.entries(out.categoryImages as Record<string, unknown>)) if (x) ci[k] = x;
          out.categoryImages = ci;
        }
        return out;
      }
      return v;
    };
    return walk(cfg);
  }

  private fontFace(): { css: string | null; family: string | null } {
    const font = this.snapshot()?.font as { cssFamily?: string; regular?: string | null; bold?: string | null; variable?: boolean } | undefined;
    if (!font?.cssFamily || font.cssFamily === 'system-ui') return { css: null, family: null };
    const regular = this.localMediaUrl(font.regular ?? null);
    if (!regular) return { css: null, family: null };
    const bold = this.localMediaUrl(font.bold ?? null);
    const fam = font.cssFamily.replace(/"/g, '');
    const css = font.variable
      ? `@font-face{font-family:"${fam}";src:url("${regular}");font-weight:100 900;font-display:block;}`
      : `@font-face{font-family:"${fam}";src:url("${regular}");font-weight:400;font-display:block;}${bold ? `@font-face{font-family:"${fam}";src:url("${bold}");font-weight:700;font-display:block;}` : ''}`;
    return { css, family: fam };
  }

  private catalogData() {
    return buildKioskCatalog(this.cloud.catalog(), this.settingsMap(), (url, size) => this.localMediaUrl(url, size));
  }

  private pausedState(): { paused: boolean; message: string | null; until: string | null } {
    const st = (this.snapshot()?.state ?? {}) as { paused?: boolean; message?: string | null; until?: string | null };
    const local = this.kv.get(LOCAL_PAUSE) === '1';
    let remote = st.paused === true;
    // A timed lock is lifted here at its time, without waiting for the cloud.
    if (remote && st.until && Date.parse(st.until) <= Date.now()) remote = false;
    return { paused: remote || local, message: remote ? (st.message ?? null) : null, until: remote ? (st.until ?? null) : null };
  }

  view(): KioskView {
    if (!this.viewDirty && this.viewCache) return this.viewCache;
    const creds = this.cloud.credentials();
    const me = this.cloud.machine();
    const snap = this.snapshot();
    const phase: KioskView['phase'] = !creds ? 'unpaired' : snap?.kiosk === true ? 'kiosk' : 'waiting';
    const cfg = phase === 'kiosk' ? this.config() : null;
    const font = this.fontFace();
    const cat = phase === 'kiosk' ? this.catalogData() : { categories: [], products: [], groups: {}, quickNotes: {}, upsells: [] };
    const categoryImages: Record<string, string> = {};
    if (cfg) for (const [id, ref] of Object.entries(cfg.catalog.categoryImages ?? {})) {
      const local = this.localMediaUrl(ref?.url ?? null, 'card');
      if (local) categoryImages[id] = local;
    }
    const paused = this.pausedState();
    const media = this.media.getStatus();
    const today = this.orders.todays();
    this.viewCache = {
      phase,
      appVersion: this.opts.appVersion,
      machine: creds
        ? {
            machineId: creds.machineId,
            name: (snap?.name as string) ?? me?.machineName ?? null,
            shopName: me?.shopName ?? null,
            companyName: me?.companyName ?? null,
            posNumber: me?.posNumber ?? null,
            serverUrl: creds.serverUrl,
          }
        : null,
      config: cfg ? (this.localizeConfig(cfg) as Record<string, unknown>) : null,
      configVersion: (snap?.configVersion as string) ?? null,
      fontFace: font.css,
      fontFamily: font.family,
      brandName: this.business().companyName ?? me?.companyName ?? 'R2M',
      catalog: { ...cat, categoryImages },
      state: {
        paused: paused.paused,
        pausedMessage: paused.message,
        pausedUntil: paused.until,
        noPayment: this.pay.monitor.state !== 'ready',
        terminal: this.pay.monitor.state,
        offline: this.offlineNow,
        offlineSince: this.offline.since,
        cardBlocked: this.pay.blocked(),
      },
      staff: {
        unprintedBons: today.filter((o) => o.bonStatus === 'failed' || o.bonStatus === 'queued').length,
        printer: this.printQueue.health(),
        pendingUploads: this.outbox.count(),
        mediaMissing: media.missing,
      },
    };
    this.viewDirty = false;
    return this.viewCache;
  }

  /* ------------------------------------------------------------- pairing */

  async pair(input: { serverUrl: string; code: string; machineName: string }): Promise<{ ok: true } | { ok: false; error: string }> {
    if (this.paired) return { ok: false, error: 'הקיוסק כבר מצומד' };
    const r = await pairRequest(this.api, { ...input, deviceInfo: this.opts.deviceInfo });
    if (!r.ok) return { ok: false, error: r.error };
    this.cloud.setCredentials(r.credentials);
    this.api.setBase(r.credentials.serverUrl);
    await this.sync.pullMachine();
    // The counters and the shift number never below the cloud's (a replacement device continues).
    const last = await this.api.get<Record<string, unknown>>(`sync/${r.credentials.machineId}/shifts/last-closed`);
    if (last.kind === 'ok' && last.body) {
      const per = (last.body.highestTransactionNumbers ?? {}) as Record<string, number>;
      this.ledger.counters.raise(per, typeof last.body.highestTransactionNumber === 'number' ? last.body.highestTransactionNumber : null);
      if (typeof last.body.sequenceNumber === 'number') this.ledger.raiseShiftSequence(last.body.sequenceNumber);
    }
    await this.sync.fullSync();
    this.applyProvider();
    this.sync.start();
    void this.syncMedia();
    this.dirty();
    return { ok: true };
  }

  /* ---------------------------------------------------------- remote hooks */

  private remoteHooks() {
    return {
      heartbeatExtras: () => {
        const beat = this.cloud.heartbeat();
        const machine = this.machineId;
        const lastLocal = machine ? this.tillZ.lastLocalNumber(machine) : null;
        const lastNumber = Math.max(lastLocal ?? 0, beat.lastTillZNumber ?? 0);
        const failure = this.printQueue.lastFailure;
        const health = this.printQueue.health();
        return {
          ...(this.opts.deviceInfo.serial ? { serialNumber: this.opts.deviceInfo.serial } : {}),
          offlineTillZ: { pending: 0, conflict: false, lastNumber, epoch: beat.tillZEpoch },
          printer: {
            status: health === 'no_paper' ? 'no_paper' : health === 'ok' ? 'ok' : health === 'unknown' ? 'unknown' : health === 'unavailable' ? 'unavailable' : 'error',
            ...(failure ? { message: failure.error, at: new Date(failure.at).toISOString() } : {}),
            ...(this.printQueue.lastOkAt ? { lastPrintOkAt: new Date(this.printQueue.lastOkAt).toISOString() } : {}),
          },
        };
      },
      kioskStatus: () => (this.isKiosk() ? this.kioskStatus() : null),
      onKioskSnapshot: (next: Record<string, unknown>, prev: Record<string, unknown> | null) => {
        if (next.kiosk && next.configVersion !== prev?.configVersion) this.log(`kiosk config ${String(next.configVersion)}`);
        this.applyProvider();
        void this.syncMedia();
        this.dirty();
      },
      onCatalog: () => {
        void this.syncMedia();
        this.dirty();
      },
      onSettings: () => {
        this.applyProvider();
        this.dirty();
      },
      onParameters: () => this.dirty(),
      onPendingCloseShift: (r: { requestId: string }) => {
        this.pendingClose = { requestId: r.requestId };
      },
      onPendingTillZ: (r: { requestId: string }) => {
        this.pendingZ = { requestId: r.requestId };
      },
      onPendingTransmit: (r: { requestId: string }) => {
        this.pendingTransmit = { requestId: r.requestId };
      },
      onPendingReset: (r: { commandId: string; kind: string }) => void this.handleReset(r),
      afterBeat: async () => {
        const id = this.machineId;
        if (id && this.isKiosk()) await this.orders.push(this.api, id);
      },
      sideRequest: (row: OutboxRow) => this.sideRequest(row),
      onRevoked: () => {
        this.log('machine token revoked: back to pairing');
        this.sync.stop();
        this.cloud.forget();
        this.dirty();
      },
      log: this.log,
    };
  }

  private kioskStatus(): Record<string, unknown> {
    const today = this.orders.todays();
    const media = this.media.getStatus();
    const alerts: Array<Record<string, unknown>> = [];
    const health = this.printQueue.health();
    if (health !== 'ok' && health !== 'unknown') alerts.push({ kind: 'printer', key: 'printer:receipt', reason: health === 'no_paper' ? 'no_paper' : health === 'offline' || health === 'unavailable' ? 'offline' : 'error' });
    const bonsFailed = today.filter((o) => o.bonStatus === 'failed').length;
    if (bonsFailed > 0) alerts.push({ kind: 'printer', key: 'printer:bon', reason: 'bon_failed', detail: { failed: bonsFailed } });
    if (this.pay.monitor.state === 'unreachable') alerts.push({ kind: 'terminal', key: 'terminal', reason: 'unreachable', detail: { address: this.pay.describe().address } });
    else if (this.pay.monitor.state === 'unconfigured') alerts.push({ kind: 'terminal', key: 'terminal', reason: 'not_configured' });
    if (this.pay.blocked()) alerts.push({ kind: 'terminal', key: 'terminal:card', reason: 'card_unknown' });
    const help = this.kv.getJson<{ requestId: string; at: number; screen: string }>(HELP);
    if (help && Date.now() - help.at < 10 * 60_000) alerts.push({ kind: 'help', key: 'help', reason: 'help', requestId: help.requestId, detail: { screen: help.screen } });
    return {
      flowState: this.flow.flowState,
      shiftOpen: this.ledger.currentShift() !== null,
      appliedConfigVersion: (this.snapshot()?.configVersion as string) ?? undefined,
      mediaReady: media.ready,
      mediaMissing: media.missing,
      mediaBytes: media.bytes,
      bonPrinter: bonsFailed > 0 ? 'error' : health === 'ok' ? 'ok' : health === 'unknown' ? 'none' : 'warn',
      receiptPrinter: health,
      ordersToday: today.length,
      salesTodayAgorot: today.reduce((s, o) => s + o.totalAgorot + o.tipAgorot, 0),
      lastOrderAt: today.length > 0 ? today[today.length - 1].paidAt : undefined,
      pendingOrders: this.orders.all().filter((o) => o.paid && o.syncedHash === null).length,
      unprintedBons: today.filter((o) => o.bonStatus === 'failed' || o.bonStatus === 'queued').length,
      appVersion: this.opts.appVersion,
      alerts,
    };
  }

  private sideRequest(row: OutboxRow): { path: string; body: unknown } | null {
    if (row.kind === 'transmission') {
      const t = this.kv.getJson<Record<string, unknown>>(`transmission:${row.ref_id}`);
      return t ? { path: 'transmissions', body: t } : null;
    }
    if (row.kind === 'shift_close_ack') {
      const a = this.kv.getJson<Record<string, unknown>>(`ack:close:${row.ref_id}`);
      return a ? { path: 'shift-close/ack', body: a } : null;
    }
    if (row.kind === 'till_z_ack') {
      const a = this.kv.getJson<Record<string, unknown>>(`ack:z:${row.ref_id}`);
      return a ? { path: 'till-z/ack', body: a } : null;
    }
    return null;
  }

  private ack(kind: 'close' | 'z', requestId: string, phase: string, extra: Record<string, unknown> = {}) {
    const key = `${requestId}:${phase}`;
    this.kv.setJson(`ack:${kind}:${key}`, { requestId, phase, ...extra });
    this.outbox.enqueue(kind === 'close' ? 'shift_close_ack' : 'till_z_ack', key);
  }

  /* --------------------------------------------------------------- media */

  private mediaWanted(): MediaRefIn[] {
    const snap = this.snapshot();
    const list: MediaRefIn[] = [];
    if (snap?.kiosk === true && Array.isArray(snap.media)) {
      for (const m of snap.media as Array<Record<string, unknown>>) {
        if (typeof m.url !== 'string') continue;
        const kind = m.kind === 'video' || m.kind === 'font' ? m.kind : 'image';
        list.push({ url: m.url, kind, sha256: typeof m.sha256 === 'string' ? m.sha256.toLowerCase() : null, bytes: typeof m.bytes === 'number' ? m.bytes : null });
      }
      const cfg = this.config();
      list.push(...catalogMedia(this.cloud.catalog(), { categories: cfg.catalog.hiddenCategories ?? [], products: cfg.catalog.hiddenProducts ?? [] }));
    }
    const logo = this.settingsMap().brandReceiptLogoUrl;
    if (typeof logo === 'string' && /^https?:\/\//.test(logo)) list.push({ url: logo, kind: 'image', sha256: null, bytes: null });
    return list;
  }

  async syncMedia(): Promise<void> {
    if (!this.paired) return;
    await this.media.sync(this.mediaWanted());
    this.dirty();
  }

  /* -------------------------------------------------------------- payment */

  private providerContext(): ProviderContext {
    return {
      machineId: this.machineId,
      nextSequence: (name) => {
        const key = `seq.${name}`;
        const n = (this.kv.getNumber(key) ?? 0) + 1;
        this.kv.setNumber(key, n); // saved before use
        return n;
      },
      getValue: (k) => this.kv.get(`provider.${k}`),
      setValue: (k, v) => this.kv.set(`provider.${k}`, v),
      parameter: (k) => this.cloud.parameters()[k],
      log: this.log,
    };
  }

  /** The terminal from the cloud settings: the first provider that is configured. */
  applyProvider() {
    const settings = this.settingsMap();
    let provider: PaymentProvider | null = null;
    for (const f of this.providers) {
      try {
        provider = f(settings, this.providerContext());
      } catch (e) {
        this.log(`payment provider: ${String(e)}`);
      }
      if (provider) break;
    }
    this.pay.setProvider(provider, typeof settings.paymentIntegration === 'string' ? settings.paymentIntegration : null);
  }

  /** The customer still on the pay screen waiting on this order's unknown outcome. */
  private liveUnknown(orderId: string | null): boolean {
    return !!orderId && this.payProgress?.orderId === orderId && this.payProgress.phase === 'unknown';
  }

  /**
   * Every unresolved charge settled by its reference (start, and the admin's "בדוק שוב"). The one
   * the customer is still waiting on goes on as a live payment (success, bon); an older one is
   * completed without printing (as the till's recovery) — staff re-print its bon from the admin.
   */
  private async settleOrphans() {
    await this.pay.resolveOrphans({
      isPending: (id) => this.ledger.doc(id)?.status === 'pending',
      complete: (a, card) => {
        const d = this.ledger.completeCardSale(a.transactionId, card);
        if (d && a.orderId) void this.afterApproval(a.orderId, d, !this.liveUnknown(a.orderId));
      },
      void: (a, meta) => {
        this.ledger.voidCardSale(a.transactionId, meta);
        if (this.liveUnknown(a.orderId)) this.progress({ ...this.payProgress!, phase: 'declined', message: 'העסקה לא חויבה' });
      },
    });
    this.dirty();
  }

  /** Re-price the basket from the local catalog (the screens' prices are never trusted). */
  private priceBasket(input: StartPaymentIn): { lines: SaleLine[]; changes: BasketChange[]; tracked: string[] } {
    const cat = this.catalogData();
    const byId = new Map<string, KProduct>(cat.products.map((p) => [p.id, p]));
    const lines: SaleLine[] = [];
    const changes: BasketChange[] = [];
    const tracked = new Set<string>();
    for (const l of input.lines) {
      const p = byId.get(l.productId);
      if (!p || p.soldOut) {
        changes.push({ kind: 'removed', productId: l.productId, name: p?.name ?? '' });
        continue;
      }
      const groups = cat.groups[p.id] ?? [];
      const options = l.options
        .map((o) => {
          const g = groups.find((x) => x.id === o.groupId);
          const opt = g?.options.find((x) => x.id === o.optionId);
          return g && opt ? { groupId: g.id, optionId: opt.id, name: opt.name, priceAgorot: ofShekels(opt.price), qty: 1 } : null;
        })
        .filter((x): x is NonNullable<typeof x> => !!x);
      if (p.trackStock) tracked.add(p.id);
      lines.push({ key: l.key, productId: p.id, name: p.name, sku: p.sku, basePriceAgorot: ofShekels(p.price), options, notes: l.notes.filter((n) => n.trim()), qty: Math.max(1, Math.trunc(l.qty)) });
    }
    return { lines, changes, tracked: [...tracked] };
  }

  /**
   * "לתשלום": checked, a shift open, the order and the pending document written, then the charge.
   * Refused before anything is sent when the terminal cannot charge or an earlier one is unresolved.
   */
  async startPayment(input: StartPaymentIn): Promise<StartPaymentOut> {
    if (this.pay.cardInFlight) return { ok: false, reason: 'busy', message: 'תשלום כבר בתהליך' };
    if (this.pay.monitor.state !== 'ready') return { ok: false, reason: 'terminal', message: 'מסופון האשראי לא זמין כרגע. אנא פנו לצוות.' };
    if (this.pay.blocked()) return { ok: false, reason: 'unresolved', message: 'תשלום קודם ממתין לבירור. אנא פנו לצוות.' };
    const { lines, changes, tracked } = this.priceBasket(input);
    if (changes.length > 0) return { ok: false, reason: 'changed', changes };
    if (lines.length === 0) return { ok: false, reason: 'empty', message: 'הסל ריק' };
    const cfg = this.config();
    const operator = this.operator();
    const goods = saleTotals(lines, this.vatRate()).totalAgorot;
    const tip = cfg.payment.tipEnabled ? tipOf(goods, input.tipPct) : 0;
    const totals = saleTotals(lines, this.vatRate(), tip);
    if (totals.chargeAgorot < 1) return { ok: false, reason: 'empty', message: 'אין מה לחייב' };
    this.ledger.openShift(operator);
    const now = Date.now();
    const order: KioskOrder = {
      localId: randomUUID(),
      createdAtMs: now,
      businessDate: localDate(now),
      serviceType: input.service,
      tableRef: input.tableRef?.trim() || null,
      fulfillmentMode: cfg.general.fulfillmentMode === 'KDS' ? 'KDS' : 'BON',
      configVersion: (this.snapshot()?.configVersion as string) ?? null,
      customerName: input.customerName?.trim() || null,
      customerPhone: input.customerPhone?.trim() || null,
      itemCount: lines.reduce((s, l) => s + l.qty, 0),
      totalAgorot: totals.totalAgorot,
      tipAgorot: tip,
      paid: false,
      paidAt: null,
      transactionId: null,
      transactionNumber: null,
      pickupNumber: null,
      pickupLabel: null,
      bonRequestedAtMs: null,
      bonJobIds: [],
      bonStatus: 'none',
      bonDetail: null,
      receiptStatus: 'none',
      recovered: false,
      syncedHash: null,
    };
    this.orders.put(order);
    const me = this.cloud.machine();
    const doc = this.ledger.openCardSale({
      documentType: saleDocumentType(this.business().dealerType),
      prefix: prefixFor(me?.documentPrefix ?? null, me?.posNumber ?? null),
      branchId: this.business().branchId,
      operator,
      orderId: order.localId,
      lines,
      tracked,
      totals,
    });
    if (!doc) return { ok: false, reason: 'no_shift', message: 'אין משמרת פתוחה' };
    this.orders.update(order.localId, (o) => ({ ...o, transactionId: doc.id }));
    this.progress({ orderId: order.localId, phase: 'starting', message: null, amountAgorot: totals.chargeAgorot, canCancel: true, cancelling: false });
    void this.runCharge(order.localId, doc, totals.chargeAgorot, tip);
    return { ok: true, orderId: order.localId, amountAgorot: totals.chargeAgorot };
  }

  private progress(p: PayProgress) {
    this.payProgress = p;
    this.emitEvent('pay', p);
  }

  private async runCharge(orderId: string, doc: DocDraft, amountAgorot: number, tipAgorot: number) {
    const outcome = await this.pay.charge({
      transactionId: doc.id,
      orderId,
      amountAgorot,
      tipAgorot,
      onSent: () => this.progress({ orderId, phase: 'charging', message: null, amountAgorot, canCancel: true, cancelling: false }),
      onProgress: (message) => {
        const cur = this.payProgress;
        if (cur && cur.orderId === orderId && (cur.phase === 'charging' || cur.phase === 'starting')) this.progress({ ...cur, phase: 'charging', message });
      },
    });
    if (outcome.kind === 'refused') {
      this.ledger.voidCardSale(doc.id, null);
      this.progress({ orderId, phase: 'declined', message: 'מסופון האשראי לא זמין כרגע. אנא פנו לצוות.', amountAgorot, canCancel: false, cancelling: false });
      return;
    }
    if (outcome.kind === 'declined') {
      this.ledger.voidCardSale(doc.id, outcome.voidMeta);
      this.pay.forgetAttempt(this.lastReferenceOf(doc.id) ?? '');
      this.progress({ orderId, phase: 'declined', message: outcome.message, amountAgorot, canCancel: false, cancelling: false });
      void this.sync.flush();
      return;
    }
    if (outcome.kind === 'unknown') {
      this.progress({ orderId, phase: 'unknown', message: outcome.message, amountAgorot, canCancel: false, cancelling: false });
      this.dirty();
      return;
    }
    const done = this.ledger.completeCardSale(doc.id, outcome.card);
    const ref = this.lastReferenceOf(doc.id);
    if (ref) this.pay.forgetAttempt(ref);
    if (done) await this.afterApproval(orderId, done, false);
  }

  private lastReferenceOf(transactionId: string): string | null {
    return this.pay.attempts().find((a) => a.transactionId === transactionId)?.vuid ?? null;
  }

  /** Money taken: the order paid, its pickup number, the bon (once), the slip, the receipt by policy. */
  private async afterApproval(orderId: string, doc: DocDraft, recovered: boolean) {
    const me = this.cloud.machine();
    const number = formatDocNumber(doc.prefix, String(doc.number));
    let order = this.orders.update(orderId, (o) => ({ ...o, paid: true, paidAt: doc.updatedAt, transactionId: doc.id, transactionNumber: number, recovered }));
    if (!order) return;
    const cfg = this.config();
    const rules: PickupRules = { scope: cfg.pickup.scope, prefix: cfg.pickup.prefix, start: cfg.pickup.start, max: cfg.pickup.max };
    const pickup = order.pickupNumber ? { number: order.pickupNumber, label: order.pickupLabel ?? String(order.pickupNumber) } : await allocatePickup(this.kv, this.api, this.machineId, order, rules);
    order = this.orders.update(orderId, (o) => ({ ...o, pickupNumber: pickup.number, pickupLabel: pickup.label }))!;
    const policy = cfg.payment.receiptPolicy;
    const receipt: PayProgress['receipt'] = policy === 'always' ? 'printing' : policy === 'ask' ? 'ask' : 'none';
    if (!recovered) {
      this.progress({ orderId, phase: 'approved', message: null, amountAgorot: doc.totals.chargeAgorot, canCancel: false, cancelling: false, pickupLabel: pickup.label, documentNumber: number, receipt });
    }
    if (recovered) {
      // Settled after the fact (a restart in between): no paper now — the customer is gone; staff re-print.
      this.orders.update(orderId, (o) => ({ ...o, receiptStatus: 'none', bonDetail: 'שוחזר — הדפסה חוזרת מהניהול' }));
      void this.sync.flush();
      if (this.machineId) void this.orders.push(this.api, this.machineId);
      this.dirty();
      return;
    }
    this.printBon(orderId, false);
    if (cfg.printing.pickupSlip) {
      this.printQueue.enqueue('slip', orderId, slipDoc({ businessName: this.business().companyName, pickupLabel: pickup.label, service: order.serviceType, itemCount: order.itemCount, totalAgorot: order.totalAgorot + order.tipAgorot }));
    }
    if (policy === 'always') this.printReceipt(orderId, false);
    this.orders.update(orderId, (o) => ({ ...o, receiptStatus: policy === 'always' ? 'printed' : 'none' }));
    void me;
    void this.sync.flush();
    if (this.machineId) void this.orders.push(this.api, this.machineId);
    this.dirty();
  }

  async cancelPayment(): Promise<void> {
    const p = this.payProgress;
    if (!p || (p.phase !== 'starting' && p.phase !== 'charging')) return;
    this.progress({ ...p, cancelling: true, message: 'מבטלים…' });
    await this.pay.cancel();
  }

  async receiptChoice(orderId: string, print: boolean): Promise<void> {
    const o = this.orders.get(orderId);
    if (!o || !o.paid) return;
    if (print) this.printReceipt(orderId, false);
    this.orders.update(orderId, (x) => ({ ...x, receiptStatus: print ? 'printed' : 'declined' }));
    const p = this.payProgress;
    if (p && p.orderId === orderId) this.progress({ ...p, receipt: print ? 'printing' : 'declined' });
    if (this.machineId) void this.orders.push(this.api, this.machineId);
  }

  /* ------------------------------------------------------------- printing */

  private receiptLines(doc: DocDraft): ReceiptLine[] {
    return doc.lines.map((l) => {
      const unit = unitAgorot(l);
      return {
        name: l.name,
        qty: l.qty,
        unitAgorot: unit,
        totalAgorot: unit * l.qty,
        paid: l.options.filter((o) => o.priceAgorot > 0).map((o) => ({ text: o.qty > 1 ? `${o.name} ×${o.qty}` : o.name, priceAgorot: o.priceAgorot })),
      };
    });
  }

  printReceipt(orderId: string, copy: boolean) {
    const o = this.orders.get(orderId);
    const doc = o?.transactionId ? this.ledger.doc(o.transactionId) : null;
    if (!o || !doc || doc.status !== 'completed') return;
    const params = this.cloud.parameters();
    const footer: [string | null, string | null] = [
      typeof params['receipt.footer.line1'] === 'string' ? (params['receipt.footer.line1'] as string) : null,
      typeof params['receipt.footer.line2'] === 'string' ? (params['receipt.footer.line2'] as string) : null,
    ];
    const logo = this.settingsMap().brandReceiptLogoUrl;
    this.printQueue.enqueue(
      'receipt',
      orderId,
      receiptDoc({
        documentType: doc.documentType,
        number: formatDocNumber(doc.prefix, String(doc.number)),
        copy: copy ? 'copy' : 'original',
        issuedAt: new Date(doc.createdAt),
        printedAt: new Date(),
        cashierName: doc.cashierName,
        business: this.business(),
        lines: this.receiptLines(doc),
        totalAgorot: doc.totals.totalAgorot,
        netAgorot: doc.totals.netAgorot,
        vatAgorot: doc.totals.vatAgorot,
        vatRate: doc.totals.vatRate,
        tipAgorot: doc.totals.tipAgorot,
        card: doc.card ? { brand: doc.card.brand, last4: doc.card.last4, authNum: doc.card.authNum, payments: doc.card.payments, firstPaymentAgorot: doc.card.firstPaymentAgorot } : null,
        footer,
        logoUrl: typeof logo === 'string' ? this.localMediaUrl(logo) : null,
      }),
    );
  }

  /**
   * The bon, once: "requested" written BEFORE the jobs are queued, the job ids after; a retry or a
   * restart only tracks; a crash in between finds the queued jobs of the order, else enqueues.
   */
  printBon(orderId: string, reprint: boolean) {
    const o = this.orders.get(orderId);
    if (!o || !o.paid) return;
    const step = reprint ? 'enqueue' : bonStep({ fulfillmentMode: o.fulfillmentMode, paid: o.paid, bonRequestedAtMs: o.bonRequestedAtMs, jobIds: o.bonJobIds });
    if (step === 'none' || step === 'wait' || step === 'track') return;
    if (step === 'recover') {
      const found = this.printQueue.jobsFor(orderId, 'bon').map((j) => j.id);
      if (found.length > 0) {
        this.orders.update(orderId, (x) => ({ ...x, bonJobIds: found }));
        return;
      }
    }
    const doc = o.transactionId ? this.ledger.doc(o.transactionId) : null;
    if (!doc) return;
    this.orders.update(orderId, (x) => ({ ...x, bonRequestedAtMs: x.bonRequestedAtMs ?? Date.now(), bonStatus: 'queued' })); // write-ahead
    const cfg = this.config();
    const copies = Math.max(1, Math.min(3, cfg.printing.bonCopies || 1));
    const me = this.cloud.machine();
    const ids: string[] = [];
    for (let c = 1; c <= copies; c++) {
      ids.push(
        this.printQueue.enqueue(
          'bon',
          orderId,
          bonDoc({
            pickupLabel: o.pickupLabel ?? String(o.pickupNumber ?? '?'),
            customerName: o.customerName,
            tableRef: o.tableRef,
            documentNumber: o.transactionNumber ?? '',
            service: o.serviceType,
            createdAt: new Date(doc.createdAt),
            kioskName: this.operator().name,
            posNumber: me?.posNumber ?? null,
            machineName: me?.machineName ?? null,
            lines: doc.lines.map((l) => ({ qty: l.qty, name: l.name, options: l.options.map((x) => x.name), notes: l.notes.join(' · ') || null })),
            reprint,
            copy: c,
            printerName: null,
          }),
        ),
      );
    }
    this.orders.update(orderId, (x) => ({ ...x, bonJobIds: reprint ? [...x.bonJobIds, ...ids] : ids }));
  }

  /** The bon's state from its jobs ("sent" is never reported as "printed"). */
  private refreshBonStates() {
    for (const o of this.orders.todays()) {
      if (o.bonJobIds.length === 0) continue;
      const jobs = o.bonJobIds.map((id) => this.printQueue.job(id)?.status ?? 'failed');
      const status = jobs.some((s) => s === 'failed') ? 'failed' : jobs.every((s) => s === 'sent') ? 'sent' : 'queued';
      if (status !== o.bonStatus) this.orders.update(o.localId, (x) => ({ ...x, bonStatus: status, bonDetail: status === 'failed' ? 'לא הודפס' : null }));
    }
  }

  private printZ(z: Record<string, unknown>) {
    const me = this.cloud.machine();
    const logo = this.settingsMap().brandReceiptLogoUrl;
    this.printQueue.enqueue('z', String(z.id ?? ''), zDoc(z, { business: this.business(), shopName: me?.shopName ?? null, posNumber: me?.posNumber ?? null, machineName: me?.machineName ?? null, copy: false, logoUrl: typeof logo === 'string' ? this.localMediaUrl(logo) : null, printedAt: new Date() }));
  }

  /* ---------------------------------------------------------------- ticks */

  /** The flow as the screens report it (for the status, the automatic close and the shift opening). */
  reportFlow(f: { flowState: string; screen: string; busy: boolean; idle: boolean }) {
    const prev = this.lastFlowScreen;
    this.flow = f;
    this.lastFlowScreen = f.screen;
    // Trading starts again (opening hours, a lock lifted): the next shift opens as the kiosk itself.
    if (f.screen === 'attract' && ['closed', 'paused', 'no_payment'].includes(prev) && this.isKiosk() && !this.tillZ.owed && !this.ledger.currentShift()) {
      this.ledger.openShift(this.operator());
    }
  }

  private tick5() {
    const was = this.offlineNow;
    this.offlineNow = this.paired && this.offline.update({ networkUp: this.platform.networkUp(), lastCloudOkAtMs: this.sync.status.lastBeatOkAt, startedAtMs: this.startedAt, nowMs: Date.now() });
    if (was !== this.offlineNow) this.dirty();
    this.refreshBonStates();
  }

  private async tick10() {
    await this.pay.monitorTick({ busy: this.flow.busy, screen: this.flow.screen });
  }

  private async tick30() {
    if (!this.paired) return;
    const mayRun = autoCloseMayRun({ kiosk: this.isKiosk(), flowIdle: this.flow.idle, flowBusy: this.flow.busy, cardInFlight: this.pay.cardInFlight });
    const cfg = this.isKiosk() ? this.config() : null;
    const op = this.operator();
    if (mayRun && this.pendingClose) {
      const req = this.pendingClose;
      this.pendingClose = null;
      this.ack('close', req.requestId, 'received');
      const r = this.tillZ.closeForCloud({ requestId: req.requestId, closerName: closerName(op), vatRate: this.vatRate() });
      if (r.kind === 'pending') this.ack('close', req.requestId, 'deferred', { errorCode: 'card_in_flight' });
      void this.sync.flush();
    }
    if (mayRun && this.pendingTransmit) {
      const req = this.pendingTransmit;
      this.pendingTransmit = null;
      await this.transmitBatch('remote', req.requestId);
    }
    if (mayRun && this.pendingZ && zModeOf(this.cloud.heartbeat().zMode) === 'till') {
      const req = this.pendingZ;
      this.pendingZ = null;
      this.ack('z', req.requestId, 'received');
      if (this.ledger.currentShift()) this.ledger.closeShift({ closedByName: closerName(op), vatRate: this.vatRate() });
      const r = await this.tillZ.produce(closerName(op), true, req.requestId);
      if (r.kind === 'refused' && r.refusal === 'nothing_to_report') this.ack('z', req.requestId, 'failed', { errorCode: 'nothing_to_report' });
    }
    await this.tillZ.tick({ mayRun, kioskAt: cfg?.operations.autoCloseAt, paramAt: this.cloud.parameters().autoCloseShiftAt, closerName: closerName(op), vatRate: this.vatRate() });
    this.dirty();
  }

  /** The card batch (doPeriodic), reported to the cloud (POST /transmissions, via the outbox). */
  private async transmitBatch(trigger: 'z_close' | 'remote' | 'manual', requestId?: string) {
    const startedAt = new Date().toISOString();
    const t = await this.pay.transmit().catch(() => null);
    if (!t) return null;
    if (t.outcome === 'skipped') return t;
    const id = randomUUID();
    this.kv.setJson(`transmission:${id}`, {
      id,
      trigger,
      ...(requestId ? { requestId } : {}),
      startedAt,
      finishedAt: new Date().toISOString(),
      status: t.outcome === 'success' ? 'success' : t.outcome === 'failed' ? 'failed' : 'unknown',
      ...(t.statusCode !== null ? { statusCode: t.statusCode } : {}),
      ...(t.statusMessage ? { statusMessage: t.statusMessage } : {}),
      ...(t.batchNumber ? { batchNumber: t.batchNumber } : {}),
      ...(t.transactionCount !== null ? { transactionCount: t.transactionCount } : {}),
      ...(t.amountAgorot !== null ? { amount: t.amountAgorot / 100 } : {}),
      ...(t.error ? { error: t.error } : {}),
    });
    this.outbox.enqueue('transmission', id);
    return t;
  }

  /** A reset only by the cloud's command (pendingReset), once per command; never with unsent data. */
  private async handleReset(r: { commandId: string; kind: string }) {
    const done = this.kv.getJson<Record<string, unknown>>(`reset:${r.commandId}`);
    let result = done;
    if (!result) {
      const counters = { ...this.ledger.counters.report() };
      if (r.kind !== 'transactions' && r.kind !== 'full') result = { commandId: r.commandId, status: 'refused', code: 'unknown_kind' };
      else if (this.outbox.count('transaction') > 0 || this.outbox.count('shift_close') > 0 || this.outbox.count('shift_open') > 0) {
        result = { commandId: r.commandId, status: 'refused', code: 'outbox_not_empty', outboxPending: this.outbox.count() };
      } else {
        const deleted = this.db.run("DELETE FROM documents WHERE synced_at IS NOT NULL AND status != 'pending'").changes;
        if (r.kind === 'full') {
          this.kv.delete('cloud.catalog');
          this.kv.delete('cloud.settings');
        }
        result = {
          commandId: r.commandId,
          status: 'done',
          executedAt: new Date().toISOString(),
          transactionsDeleted: deleted,
          keptZs: this.tillZ.list(400).length,
          counters: { before: counters, after: this.ledger.counters.report() },
          appVersion: this.opts.appVersion,
        };
      }
      this.kv.setJson(`reset:${r.commandId}`, result);
    }
    if (this.machineId) await this.api.post(`sync/${this.machineId}/till-reset/result`, result);
  }

  /* ---------------------------------------------------------------- staff */

  helpRequest() {
    this.kv.setJson(HELP, { requestId: randomUUID(), at: Date.now(), screen: this.flow.screen });
    void this.sync.kioskSync();
  }

  /** A shop manager's PIN (bcrypt, offline, from the synced POS users) opens the admin for 5 minutes. */
  adminUnlock(pin: string): { ok: true; name: string } | { ok: false; error: string } {
    const users = this.cloud.posUsers().filter((u) => u.isActive && u.role === 'shop_manager' && u.pinHash);
    for (const u of users) {
      try {
        if (bcrypt.compareSync(pin, u.pinHash)) {
          this.adminUntil = Date.now() + 5 * 60_000;
          this.adminName = [u.firstName, u.lastName].filter(Boolean).join(' ') || u.username;
          return { ok: true, name: this.adminName };
        }
      } catch {
        /* a hash this build cannot read */
      }
    }
    return { ok: false, error: users.length === 0 ? 'אין מנהלי סניף מסונכרנים לקיוסק' : 'קוד שגוי' };
  }

  private adminOk(): boolean {
    return Date.now() < this.adminUntil;
  }

  adminInfo(): AdminInfo {
    const shift = this.ledger.currentShift();
    const media = this.media.getStatus();
    const s = this.localSettings();
    return {
      operator: this.paired ? this.operator() : null,
      shift: { open: !!shift, number: shift?.sequence_number ?? null, openedAt: shift?.opened_at ?? null },
      terminal: {
        ...this.pay.describe(),
        state: this.pay.monitor.state,
        lastOkAt: this.pay.monitor.lastOkAtMs,
        lastError: this.pay.monitor.lastError,
        unresolved: this.pay.attempts().map((a) => ({ reference: a.vuid, amountAgorot: a.amountAgorot, startedAt: a.startedAt, note: a.note })),
      },
      printer: {
        target: s.printer.transport === 'tcp' ? `TCP ${s.printer.host}:${s.printer.port ?? 9100}` : s.printer.transport === 'spooler' ? `Windows: ${s.printer.queueName ?? '—'}` : '—',
        health: this.printQueue.health(),
        lastError: this.printQueue.lastFailure?.error ?? null,
        queues: [],
      },
      sync: {
        lastBeatOkAt: this.sync.status.lastBeatOkAt,
        lastKioskSyncAt: this.sync.status.lastKioskSyncAt,
        lastError: this.sync.status.lastFlushError ?? this.sync.status.lastBeatError,
        outbox: this.outbox.count(),
        configVersion: (this.snapshot()?.configVersion as string) ?? null,
      },
      media: { files: media.files, bytes: media.bytes, missing: media.missing },
      orders: this.orders
        .todays()
        .slice(-50)
        .reverse()
        .map((o) => ({ localId: o.localId, label: o.pickupLabel, at: o.createdAtMs, totalAgorot: o.totalAgorot + o.tipAgorot, bon: o.bonStatus, receipt: o.receiptStatus, number: o.transactionNumber })),
      zs: this.tillZ.list(10),
      zOwed: this.tillZ.owed,
      zMode: this.cloud.heartbeat().zMode,
      offlineSince: this.offline.since,
    };
  }

  async adminAction(a: AdminAction): Promise<{ ok: boolean; message?: string }> {
    if (!this.adminOk()) return { ok: false, message: 'נדרש קוד מנהל' };
    this.adminUntil = Date.now() + 5 * 60_000;
    switch (a.type) {
      case 'syncNow':
        await this.sync.syncNow();
        await this.syncMedia();
        return { ok: true };
      case 'pause':
        this.kv.set(LOCAL_PAUSE, a.paused ? '1' : '0');
        this.dirty();
        return { ok: true };
      case 'reprintBon':
        this.printBon(a.orderId, true);
        return { ok: true };
      case 'reprintReceipt':
        this.printReceipt(a.orderId, true);
        return { ok: true };
      case 'testPrint':
        await this.ensurePrinterQueue();
        this.printQueue.enqueue('test', null, slipDoc({ businessName: 'בדיקת מדפסת', pickupLabel: 'TEST', service: 'take_away', itemCount: 0, totalAgorot: 0 }));
        return { ok: true };
      case 'retryPrints':
        this.printQueue.retryFailed();
        return { ok: true };
      case 'checkTerminal':
        await this.pay.monitorTick({ busy: this.flow.busy, screen: this.flow.screen }, true);
        return { ok: this.pay.monitor.state === 'ready', message: this.pay.monitor.lastError ?? undefined };
      case 'recheckPayment':
        await this.settleOrphans();
        return { ok: !this.pay.blocked() };
      case 'markNotApproved': {
        const ok = this.pay.markNotApproved(a.reference, { id: 'admin', name: this.adminName ?? 'מנהל' }, (att, meta) => {
          this.ledger.voidCardSale(att.transactionId, meta);
          if (this.liveUnknown(att.orderId)) this.progress({ ...this.payProgress!, phase: 'declined', message: 'סומן כלא אושר' });
        });
        this.dirty();
        return { ok };
      }
      case 'exitKiosk':
        this.platform.quit();
        return { ok: true };
    }
  }

  /* ------------------------------------------------------------ technician */

  technicianUnlock(code: string): { outcome: 'granted' | 'wrong' | 'locked_out' | 'locked'; triesLeft: number; lockedForMs: number } {
    const lock = this.kv.getJson<TechLock>(TECH_LOCK) ?? NO_LOCK;
    const stored = this.cloud.parameters().technicianCode;
    const r = techAttempt(lock, Date.now(), () =>
      codeMatches(code, typeof stored === 'string' ? stored : null, this.machineId ?? 'unpaired', (p, s, it, len) => pbkdf2Sync(p, s, it, len, 'sha256')),
    );
    this.kv.setJson(TECH_LOCK, r.lock);
    const audit = this.kv.getJson<Array<{ at: number; access: string }>>('technician.audit') ?? [];
    this.kv.setJson('technician.audit', [...audit, { at: Date.now(), access: r.outcome }].slice(-50));
    if (r.outcome === 'granted') this.adminUntil = Date.now() + 5 * 60_000;
    return { outcome: r.outcome, triesLeft: r.triesLeft, lockedForMs: Math.max(0, r.lock.lockedUntilMs - Date.now()) };
  }

  async technicianInfo(): Promise<TechnicianInfo> {
    const admin = this.adminInfo();
    const queues = await this.transport.list().catch(() => []);
    const me = this.cloud.machine();
    const update = this.platform.checkUpdate ? await this.platform.checkUpdate().catch(() => ({ available: null, status: 'failed' })) : { available: null, status: 'not_checked' };
    return {
      machine: this.view().machine,
      deviceRole: me?.deviceRole ?? null,
      shopName: me?.shopName ?? null,
      companyName: me?.companyName ?? null,
      network: { online: !this.offlineNow, lastBeatOkAt: this.sync.status.lastBeatOkAt, serverUrl: this.cloud.credentials()?.serverUrl ?? null, interfaces: this.platform.interfaces() },
      printer: { ...admin.printer, queues: queues.map((q) => `${q.name} (${q.health})`) },
      terminal: admin.terminal,
      update: { current: this.opts.appVersion, available: update.available, status: update.status },
      quickSupport: null,
    };
  }

  async technicianAction(a: TechnicianAction): Promise<{ ok: boolean; message?: string }> {
    if (!this.adminOk()) return { ok: false, message: 'נדרש קוד טכנאי' };
    this.adminUntil = Date.now() + 5 * 60_000;
    switch (a.type) {
      case 'printerTest':
        return this.adminAction({ type: 'testPrint' });
      case 'setPrinter':
        this.setLocalSettings({ printer: a.transport === 'tcp' ? { transport: 'tcp', host: a.host ?? null, port: a.port ?? 9100 } : { transport: 'spooler', queueName: a.queueName ?? null } });
        return { ok: true };
      case 'pinpadCheck': {
        // Read-only: getStatus, never a charge.
        const p = this.pay.current;
        if (!p) return { ok: false, message: 'לא הוגדר מסופון' };
        const r = await p.check();
        return { ok: r.ok, message: r.ok ? 'המסופון עונה' : (r.detail ?? 'אין תשובה') };
      }
      case 'updateCheck': {
        const r = this.platform.checkUpdate ? await this.platform.checkUpdate() : { available: null, status: 'unsupported' };
        return { ok: true, message: r.available ? `גרסה ${r.available} זמינה` : 'הגרסה עדכנית' };
      }
      case 'updateInstall':
        if (this.flow.busy || this.pay.cardInFlight || this.flow.screen === 'pay' || this.flow.screen === 'success') return { ok: false, message: 'לא בזמן תשלום' };
        return this.platform.installUpdate ? this.platform.installUpdate() : { ok: false, message: 'לא נתמך' };
      case 'quickSupport': {
        const launched = await this.platform.launchQuickSupport();
        return launched ? { ok: true, message: launched } : { ok: false, message: 'TeamViewer QuickSupport לא מותקן במחשב' };
      }
      case 'setZoom':
        this.setLocalSettings({ zoom: a.zoom });
        this.platform.setZoom?.(a.zoom);
        return { ok: true };
      case 'unpair':
        if (this.outbox.count() > 0) return { ok: false, message: 'יש נתונים שטרם נשלחו לענן — לא ניתן לנתק' };
        this.sync.stop();
        this.cloud.forget();
        this.dirty();
        return { ok: true };
    }
  }

  /** For tools and tests: the wire of a document as it goes to the cloud. */
  documentWire(id: string) {
    const d = this.ledger.doc(id);
    return d ? documentWire(d) : null;
  }

  /** A stable short id of the device (heartbeat serial), from the machine's own facts. */
  static deviceSerial(seed: string): string {
    return createHash('sha256').update(seed).digest('hex').slice(0, 16).toUpperCase();
  }

  parameterOn(key: string): boolean {
    return parameterOn(this.cloud.parameters()[key]);
  }
}
