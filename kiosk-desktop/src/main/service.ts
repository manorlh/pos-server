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
import { kioskPayMethods, resolveKioskConfig, kioskOfflineBlocks, tsKioskPayMethods, voucherCanFinish, type PaymentMethod } from '@dash-lib/kioskConfig';
import { orderCode, orderDue, type OpenOrder, type VoucherLeg, type WebLineOption, type WebOrderLine } from '@dash-lib/kioskWebOrders';
import { catalogNextChangeMs } from '@dash-lib/kioskSoldOut';
import { chosenOptions, defaultPicks, localDateTimeOf, priceKioskBasket, promotionsOf, type OptionPick } from '@dash-lib/kioskMoney';
import { localDate, kioskOperator, closerName, bonStep, receiptAfterApproval, type KioskOrder, type PickupRules } from '../core/kioskOrders';
import { OfflineTracker } from '../core/kioskHealth';
import { formatDocNumber, prefixFor } from '../core/documentNumbers';
import { ofShekels } from '../core/money';
import { bonDoc, receiptDoc, slipDoc, ticketDoc, zDoc, type BusinessInfo, type PrintDoc, type ReceiptLine } from '../core/printDocs';
import { BON_NOT_ON_KIOSK, windowsBonRoute } from '../core/kioskBonRoute';
import { ITEM_TICKET_PARAM, itemTicketSetting, itemTicketsPrint, resolveTicketMode, splitItemTickets, ticketModeFor } from '../core/itemTickets';
import { DRAWER_KICK } from '../core/escpos';
import { kitchenOptions, kitchenOptionText, MAX_LINE_QTY, optionCharged, saleDocumentType, saleTotals, tipToCharge, unitAgorot, vatRateOf, type SaleLine, type SaleOption } from '../core/sale';
import { autoCloseMayRun, zModeOf } from '../core/tillZ';
import { attempt as techAttempt, codeMatches, NO_LOCK, type TechLock } from '../core/technician';
import {
  decideExit,
  displayName,
  exitEvent,
  exitGuard,
  findByPin,
  KIOSK_UNLOCK,
  KIOSK_UNLOCK_LABEL,
  NO_LOCK as NO_EXIT_LOCK,
  PERMISSION_LABEL,
  returnEvent,
  TEXT as EXIT_TEXT,
  userMayExit,
  usersAllowed,
  type DesktopExitEvent,
  type DesktopExitState,
  type ExitLock,
  type ReturnVia,
  type RosterUser,
} from '../core/desktopExit';
import { DESKTOP_IDLE_RETURN_KEY, idleReturnMinutesFor } from '@dash-lib/desktopIdleReturn';
import { pickVariant, type MediaRefIn } from '../core/mediaPlan';
import { paymentGuard, type Activity } from '../core/updatePolicy';
import { TERMINAL_CHECK_BYPASS_KEY } from '../core/terminalCheckBypass';
import type { DesktopExitResult, UpdateView } from '../shared/roles';
import { openDb, type Db } from './db/sqlite';
import { Kv, migrate } from './db/schema';
import { Api, type FetchFn } from './sync/api';
import { CloudStore, parameterOn, PLAIN_BOX, type Credentials, type SecretBox } from './sync/cloud';
import { Outbox, type OutboxRow } from './sync/outbox';
import { pair as pairRequest, SyncEngine } from './sync/syncEngine';
import { documentWire, Ledger, type AppliedPromotionRow, type DocDraft } from './fiscal/ledger';
import { TillZService } from './fiscal/tillZService';
import { FINAL_OUTCOMES, kioskSection, lanCloseReport, lanOutcomeMessage, planLanClose, type LanCloseOutcome, type LanCloseRequest } from './fiscal/shopZPart';
import { MediaStore, type Downloader, type VariantMaker } from './media/mediaStore';
import { NayaxUsbProvider } from './payment/nayaxUsb';
import { PayService } from './payment/payService';
import { identifyPinpad, localPrivateIpv4, PinpadRelocator, readArpTable, sweepPort } from './payment/pinpadRelocator';
import { pinpadAddressOf } from '../core/nayax';
import type { PinpadIdentity } from '../core/pinpadRelocation';
import { PROVIDERS } from './payment/registry';
import { mergeLocalKey, PAIRING_TEXT, PairingSession, uploadOutcome, type LocalSynqKey, type PairingUpload } from './payment/synqpay/pairing';
import type { SynqPayProvider } from './payment/synqpay/provider';
import type { PaymentProvider, ProviderContext, ProviderFactory } from './payment/provider';
import { PrintQueue, type PageRenderer } from './printer/printQueue';
import { DefaultTransport, type PrinterTarget, type Transport } from './printer/transports';
import { resolvePrinterTarget, targetText, usbStatusText, UsbPrinterWatch, type PrinterResolution } from './printer/usbPrinters';
import { allocatePickup, OrderStore } from './kiosk/orders';
import { PayAtTill, type VoucherResult } from './kiosk/payAtTill';
import { kdsSaleRelease, releasesToKds } from './kiosk/kdsRelease';
import { FunnelStore } from './kiosk/funnel';
import {
  basketChanges,
  checkedBasePrice,
  cloudCheckRequest,
  CLOUD_CHECK_TIMEOUT_MS,
  overridesLive,
  overridesOf,
  PRICE_CHANGED,
  priceChangesOf,
  PROMOTIONS_PULL_TIMEOUT_MS,
  type CloudOverrides,
  type CloudVerdict,
} from '../core/basketCheck';
import type { FunnelEvent } from '../core/kioskFunnel';
import { applyBatteryStep, batteryStep, isCritical, NO_CYCLE, parseThresholds, type BatteryAlertView, type BatteryCycle } from '../core/batteryAlerts';
import { buildKioskCatalog, catalogMedia, moneyGroupOf, type KGroup, type KProduct } from './kiosk/catalog';
import type {
  AdminAction,
  AdminInfo,
  BasketChange,
  KioskEvents,
  KioskView,
  PayProgress,
  PlaceOrderIn,
  PlaceOrderOut,
  StartPaymentIn,
  StartPaymentOut,
  TechnicianAction,
  TechnicianInfo,
  AdminActionResult,
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
  /** The updater's state, without asking the network (main/update/updater.ts). */
  updateStatus?(): UpdateView;
  /** "יציאה לשולחן העבודה": out of kiosk / full screen, minimised, the way back offered (main/index.ts). */
  exitToDesktop?(): Promise<{ ok: boolean; message?: string }>;
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
  /**
   * "גשר לדפדפן" (main/bridge): the kiosk's screens are a browser page that owns the kiosk's
   * `kiosk/sync` status (this service reports its part through the bridge, `bridgePart`), and shows
   * the cloud's media itself — only the receipt's logo is kept here.
   */
  bridge?: boolean;
  /**
   * The USB printers as last seen (printer/usbPrinters.ts) — the bridge's own, shared, so the
   * printers are looked at once; by default this service keeps its own.
   */
  usbWatch?: UsbPrinterWatch;
}

/** The kiosk's own local settings (not the cloud's): the printer (an empty Windows queue: "אוטומטי"), the zoom. */
export interface LocalSettings {
  printer: PrinterTarget;
  zoom: number | null;
}

const LOCAL_SETTINGS = 'local.settings';
const LOCAL_PAUSE = 'local.pause';
const TECH_LOCK = 'technician.lock';
const HELP = 'kiosk.helpRequest';
/** A SynqPay key paired at this kiosk (sealed), until and after the cloud has it (pairing.ts). */
const SYNQ_LOCAL_KEY = 'synqpay.localKey';
/** The main till's shop Z part: the answer kept for its request, so a retry sends the same one. */
const SHOP_Z_PART = 'shopZPart.answer';
/** "סגירה יחד עם ה-Z הסניפי" (kiosk/sync `closeRequest`): the request to carry out, and its result until the cloud takes it. */
const SHOP_Z_CLOSE_REQUEST = 'shopZClose.request';
const SHOP_Z_CLOSE_RESULT = 'shopZClose.result';
/** "יציאה לשולחן העבודה" (core/desktopExit.ts): the pad's lock, the exit in progress, the device's own log. */
const DESKTOP_LOCK = 'desktopExit.lock';
const DESKTOP_STATE = 'desktopExit.state';
const DESKTOP_LOG = 'desktopExit.log';

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
  /** "ביצועי קיוסקים": the funnel's events waiting for the cloud (kiosk/funnel.ts). */
  readonly funnel: FunnelStore;
  /** "מזומן בקופה" and vouchers (kiosk/payAtTill.ts). */
  readonly payAtTill: PayAtTill;
  readonly sync: SyncEngine;
  /** The pinpad that moved (a DHCP change), found again by its identity — ARP first (payment/pinpadRelocator.ts). */
  readonly relocator: PinpadRelocator;
  /** The cloud's word on the basket a moment ago (core/basketCheck.ts), until the catalog catches up. */
  private cloudBasket: CloudOverrides | null = null;
  /** "סוללה חלשה": the battery as the screen last read it (null: never — a PC on mains reports none). */
  private batteryNow: { percent: number | null; charging: boolean } | null = null;
  private readonly transport: Transport;
  /** The USB printer plugged in, for "אוטומטי" (printer/usbPrinters.ts). */
  readonly usbWatch: UsbPrinterWatch;
  private readonly ownsUsbWatch: boolean;
  private readonly offUsbWatch: () => void;
  private readonly log: (m: string) => void;
  private readonly platform: PlatformHooks;
  private readonly providers: ProviderFactory[];
  private readonly offline = new OfflineTracker();
  private offlineNow = false;
  private readonly startedAt = Date.now();
  private timers: NodeJS.Timeout[] = [];
  private flow = { flowState: 'attract', screen: 'attract', busy: false, idle: true };
  private lastFlowScreen = 'attract';
  /** When the kiosk's screen last changed (the updater waits for a quiet kiosk). */
  private flowChangedAt = Date.now();
  /** The shell's role is a fiscal one (kiosk / till); a KDS or board screen reports no till facts. */
  private fiscalRole = true;
  private viewCache: KioskView | null = null;
  private viewDirty = true;
  private payProgress: PayProgress | null = null;
  private adminUntil = 0;
  private adminName: string | null = null;
  /** The shop manager who opened the admin (their till user id): the authority of a SynqPay pairing. */
  private adminUserId: string | null = null;
  private readonly synqPairing = new PairingSession();
  private synqUploading = false;
  /** The key last reported refused (a hash): one report per key. */
  private synqReportedFor: string | null = null;
  private pendingClose: { requestId: string } | null = null;
  private pendingZ: { requestId: string } | null = null;
  private pendingTransmit: { requestId: string } | null = null;
  /** The main till's local shop Z asks for this kiosk's part (heartbeat `pendingShopZPart`), until answered. */
  private shopZPart: (LanCloseRequest & { payingSinceMs: number | null }) | null = null;
  private shopZPartBusy = false;

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
    // "חסימת אשראי כשיש תשלום לא מוכרע" (till parameter, off unless the cloud sets it).
    this.pay.setLockOnUnresolved(() => this.parameterOn('cardLockOnUnresolved'));
    this.transport = opts.transport ?? new DefaultTransport(this.log);
    this.ownsUsbWatch = !opts.usbWatch;
    this.usbWatch = opts.usbWatch ?? new UsbPrinterWatch(this.transport, this.log, () => this.printQueue.busy);
    this.offUsbWatch = this.usbWatch.onChange(() => this.dirty());
    this.printQueue = new PrintQueue(this.db, this.transport, () => this.printerResolution().target, opts.renderer ?? null, this.log);
    this.orders = new OrderStore(this.db);
    this.funnel = new FunnelStore(this.kv);
    this.payAtTill = new PayAtTill({ kv: this.kv, api: this.api, machineId: () => this.machineId, operator: () => this.operator(), log: this.log });
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
    this.relocator = new PinpadRelocator({
      now: () => Date.now(),
      kvGet: (k) => this.kv.get(k),
      kvSet: (k, v) => (v === null ? this.kv.delete(k) : this.kv.set(k, v)),
      readArp: readArpTable,
      localIpv4: localPrivateIpv4,
      sweep: sweepPort,
      identify: (host, port) => identifyPinpad(host, port, this.pinpadHere()?.path ?? '/SPICy'),
      save: (host, port, id, previous) => this.savePinpadHost(host, port, id, previous),
      log: this.log,
    });
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

  /** The kiosk's Nayax LAN pinpad as the cloud settings place it; null on any other terminal. */
  private pinpadHere(): { host: string; port: number; path: string } | null {
    if (this.pay.describe().kind !== 'nayax_lan') return null;
    const s = (this.cloud.settings().settings ?? {}) as Record<string, unknown>;
    const port = s.nayaxDevicePort === undefined || s.nayaxDevicePort === null ? null : String(s.nayaxDevicePort);
    const a = pinpadAddressOf(s.nayaxDeviceHost as string | null, port, s.nayaxSpicyPath as string | null);
    return a ? { host: a.host, port: a.port, path: a.path } : null;
  }

  /**
   * The pinpad found at a new address: saved in the cloud (`PUT /sync/{id}/pinpad-host` — this
   * machine's host only, the same terminal), then the settings pulled so the provider follows.
   */
  private async savePinpadHost(host: string, port: number, id: PinpadIdentity, previous: string): Promise<'ok' | 'offline' | 'refused'> {
    const mid = this.machineId;
    if (!mid) return 'offline';
    const here = this.pinpadHere();
    const r = await this.api.put(`sync/${mid}/pinpad-host`, {
      host,
      port: here && here.port === port ? undefined : port,
      reason: 'relocated',
      terminalNumber: id.terminal ?? undefined,
      serial: id.serial ?? undefined,
      previousHost: previous,
      mac: id.mac ?? id.arpMac ?? undefined,
    });
    if (r.kind === 'offline') return 'offline';
    if (r.kind === 'refused') {
      this.log(`pinpad-host refused: ${r.status} ${r.detail ?? ''}`);
      return 'refused';
    }
    await this.sync.pullSettings().catch(() => undefined);
    this.applyProvider();
    this.dirty();
    return 'ok';
  }

  /** The relocator's look, on the 30-second tick: never during a payment (it asks again before moving). */
  private async relocateTick(): Promise<void> {
    const here = this.pinpadHere();
    const m = this.pay.monitor;
    const answering = m.state === 'unreachable' ? false : m.state === 'ready' && m.lastOkAtMs !== null ? true : null;
    const s = (this.cloud.settings().settings ?? {}) as Record<string, unknown>;
    const expected = typeof s.expectedTerminalNumber === 'string' && s.expectedTerminalNumber.trim() ? s.expectedTerminalNumber.trim() : null;
    await this.relocator.tick({
      configured: here ? { host: here.host, port: here.port } : null,
      answering: here ? answering : null,
      lastOkAtMs: m.lastOkAtMs,
      inPayment: () => this.flow.busy || this.pay.cardInFlight,
      online: !this.offlineNow,
      expectedTerminal: expected,
    });
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
    // The USB printer plugged in, looked at now and every 15 s ("אוטומטי").
    if (this.ownsUsbWatch) this.usbWatch.start();
    void this.printQueue.work();
  }

  stop() {
    this.stopped = true;
    if (this.emitTimer) clearTimeout(this.emitTimer);
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.offUsbWatch();
    if (this.ownsUsbWatch) this.usbWatch.stop();
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

  /**
   * Where a page goes now: the printer set wins; "אוטומטי" (no Windows queue named) — the USB printer
   * plugged in, else a queue guessed by name (SNBC / BTP, then Generic / Text Only). Never saved:
   * the next printer plugged in is found again.
   */
  printerResolution(): PrinterResolution {
    return resolvePrinterTarget(this.localSettings().printer, this.usbWatch.current());
  }

  /** Look at the printers now (a test page, the technician's screen), not 15 s later. */
  private async lookForPrinter() {
    await this.usbWatch.refresh();
  }

  /* ---------------------------------------------------------------- views */

  private settingsMap(): Record<string, unknown> {
    const cloud = this.cloud.settings().settings ?? {};
    // A SynqPay key paired here that the cloud does not have yet wins over the sync's (pairing.ts).
    const local = this.localSynqKey();
    const merged = mergeLocalKey(cloud, local);
    if (merged.settled && local) this.setLocalSynqKey({ ...local, pending: false });
    return merged.settings;
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

  /** When the catalog's sale states change next by the clock alone (a block's end): the view is built again then. */
  private saleChangeAt: number | null = null;

  private catalogData() {
    const now = Date.now();
    const catalog = this.cloud.catalog();
    this.saleChangeAt = catalogNextChangeMs(catalog.products, now);
    return buildKioskCatalog(catalog, this.settingsMap(), (url, size) => this.localMediaUrl(url, size), { stock: this.cloud.stockLevels(), nowMs: now });
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
    const cat = phase === 'kiosk' ? this.catalogData() : { categories: [], products: [], groups: {}, meals: {}, quickNotes: {}, upsells: [], upsellRules: [] };
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
      catalog: { ...cat, categoryImages, promotions: phase === 'kiosk' ? this.cloud.promotions() : [] },
      state: {
        paused: paused.paused,
        pausedMessage: paused.message,
        pausedUntil: paused.until,
        // No terminal set up at all (a health check that did not answer is tried on the press), or offline with
        // "חסימת הזמנות כשאין אינטרנט" on (kioskOfflineBlocks — the Android kiosk's KioskPayBlock.OFFLINE).
        noPayment: !this.pay.configured || this.offlineBlocked(cfg),
        noPaymentReason: this.offlineBlocked(cfg) ? 'offline' : !this.pay.configured ? 'terminal' : null,
        terminal: this.pay.monitor.state,
        offline: this.offlineNow,
        offlineSince: this.offline.since,
        cardBlocked: this.pay.blocked(),
      },
      staff: {
        unprintedBons: today.filter((o) => o.bonStatus === 'failed' || o.bonStatus === 'queued').length,
        printer: this.printQueue.health(),
        pendingUploads: this.outbox.count() + this.payAtTill.pending(),
        mediaMissing: media.missing,
      },
      pay: this.payView(phase === 'kiosk'),
    };
    this.viewDirty = false;
    return this.viewCache;
  }

  /* ------------------------------------------------------------- pairing */

  async pair(input: { serverUrl: string; code: string; machineName: string }): Promise<{ ok: true } | { ok: false; error: string }> {
    if (this.paired) return { ok: false, error: 'הקיוסק כבר מצומד' };
    const r = await pairRequest(this.api, { ...input, deviceInfo: this.opts.deviceInfo });
    if (!r.ok) return { ok: false, error: r.error };
    await this.adopt(r.credentials);
    return { ok: true };
  }

  /**
   * A machine's credentials taken as this device's (after pairing/validate, or handed over by the
   * browser kiosk the bridge serves): machines/me, the counters and the shift number never below
   * the cloud's, a full sync, the terminal, the sync loop.
   */
  async adopt(credentials: Credentials): Promise<void> {
    const r = { credentials };
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
          // "עקיפת בדיקת מספר מסוף" as this kiosk applies it (core/terminalCheckBypass.ts).
          terminalNumberCheckBypass: this.parameterOn(TERMINAL_CHECK_BYPASS_KEY),
          // "סוללה חלשה" (pos-server battery_alerts.py): the cloud tells the tills.
          ...(this.batteryNow && this.batteryNow.percent !== null
            ? { batteryPercent: this.batteryNow.percent, batteryStatus: this.batteryNow.charging ? 'charging' : 'discharging' }
            : {}),
          ...(this.fiscalRole ? { offlineTillZ: { pending: 0, conflict: false, lastNumber, epoch: beat.tillZEpoch } } : {}),
          printer: {
            status: health === 'no_paper' ? 'no_paper' : health === 'ok' ? 'ok' : health === 'unknown' ? 'unknown' : health === 'unavailable' ? 'unavailable' : 'error',
            ...(failure ? { message: failure.error, at: new Date(failure.at).toISOString() } : {}),
            ...(this.printQueue.lastOkAt ? { lastPrintOkAt: new Date(this.printQueue.lastOkAt).toISOString() } : {}),
          },
        };
      },
      // Bridge mode: the browser page reports the kiosk's status (with this service's part, bridgePart).
      kioskStatus: () => (this.isKiosk() && !this.opts.bridge ? this.kioskStatus() : null),
      onKioskSnapshot: (next: Record<string, unknown>, prev: Record<string, unknown> | null) => {
        if (next.kiosk && next.configVersion !== prev?.configVersion) this.log(`kiosk config ${String(next.configVersion)}`);
        // Bridge mode: the browser page carries the close out (closeForShopZ) and reports it.
        if (!this.opts.bridge) this.onCloseRequest(next.closeRequest);
        this.applyProvider();
        void this.syncMedia();
        this.dirty();
      },
      onCatalog: () => {
        void this.syncMedia();
        this.dirty();
      },
      onPromotions: () => this.dirty(),
      onStock: () => this.dirty(),
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
      onPendingShopZPart: (r: LanCloseRequest) => {
        if (!this.fiscalRole) return;
        if (this.shopZPart?.requestId !== r.requestId) this.shopZPart = { ...r, payingSinceMs: null };
        void this.runShopZPart();
      },
      afterBeat: async () => {
        const id = this.machineId;
        if (id && this.isKiosk()) await this.orders.push(this.api, id);
        // "ביצועי קיוסקים": the funnel's events, after the orders.
        if (id && this.isKiosk()) await this.funnel.push(this.api, id).catch(() => false);
        // "מזומן בקופה": the open orders the cloud has not taken, the vouchers to give back.
        if (id && this.isKiosk()) await this.payAtTill.flush().catch((e) => this.log(`pay at till: ${String(e)}`));
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
    if (this.pay.unresolved()) alerts.push({ kind: 'terminal', key: 'terminal:card', reason: 'card_unknown' });
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
      // "סגירה יחד עם ה-Z הסניפי": what the shop Z's close came to, until the cloud takes it.
      ...(this.kv.getJson(SHOP_Z_CLOSE_RESULT) ? { closeResult: this.kv.getJson(SHOP_Z_CLOSE_RESULT) } : {}),
      // "תקינות מכשירים" (pos-server kiosk_health.clean_health): what only the kiosk sees.
      health: this.healthReport(health),
    };
  }

  /** `status.health`: the screen, the terminal, the printer, the link to the cloud, what waits to upload. */
  private healthReport(printer: string): Record<string, unknown> {
    const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : undefined);
    const terminal = this.pay.monitor;
    const pendingOrders = this.orders.all().filter((o) => o.paid && o.syncedHash === null).length;
    const outbox = this.outbox.all();
    const funnelOldest = this.funnel.oldestAt();
    const oldest = [outbox[0]?.created_at, funnelOldest].filter((x): x is string => !!x).sort()[0];
    return {
      platform: 'windows',
      screen: this.flow.screen,
      terminal: {
        state: terminal.state === 'unconfigured' ? 'not_configured' : terminal.state === 'not_external' ? 'none' : terminal.state,
        checkedAt: iso(terminal.lastCheckAtMs),
        address: this.pay.describe().address ?? undefined,
      },
      printer: { state: printer === 'paper_low' || printer === 'cover_open' ? 'error' : printer },
      // No till on the LAN here: the kiosk talks to the cloud only.
      tillLink: { mode: 'cloud', ok: !this.offlineNow, at: iso(this.sync.status.lastBeatOkAt) },
      network: { online: !this.offlineNow, since: this.offline.since ? new Date(this.offline.since).toISOString() : undefined },
      pending: {
        orders: pendingOrders,
        documents: outbox.length,
        events: this.funnel.count(),
        oldestAt: oldest,
      },
    };
  }

  /**
   * "סוללה חלשה" (core/batteryAlerts.ts): the screen's reading of the battery (navigator.getBattery)
   * through the rule — thresholds and the alarm from the till parameters `lowBatteryThresholds` /
   * `lowBatterySound` — kept across restarts; what the screen shows and whether to sound the alarm.
   */
  battery(reading: unknown): BatteryAlertView {
    const r = reading && typeof reading === 'object' ? (reading as { percent?: unknown; charging?: unknown }) : {};
    const percent = typeof r.percent === 'number' && Number.isFinite(r.percent) ? Math.max(0, Math.min(100, Math.round(r.percent))) : null;
    const charging = r.charging === true;
    this.batteryNow = { percent, charging };
    const params = this.cloud.parameters();
    const thresholds = parseThresholds(params.lowBatteryThresholds);
    const sound = params.lowBatterySound === undefined || params.lowBatterySound === null ? true : parameterOn(params.lowBatterySound);
    const kept = this.kv.getJson<{ cycle: BatteryCycle; seq: number }>('battery.cycle') ?? { cycle: NO_CYCLE, seq: 0 };
    const step = batteryStep(kept.cycle, percent, charging, thresholds);
    const cycle = applyBatteryStep(kept.cycle, step);
    const seq = kept.seq + (step.fire !== null ? 1 : 0);
    if (step.fire !== null || step.clear || step.endCycle) {
      this.kv.setJson('battery.cycle', { cycle, seq });
      if (step.fire !== null) this.log(`battery low: ${percent}% (threshold ${step.fire})`);
    }
    return {
      level: cycle.openLevel,
      percent,
      charging,
      critical: cycle.openLevel !== null && isCritical(cycle.openLevel, thresholds),
      alarmSeq: seq,
      sound,
    };
  }

  /** The screens' funnel events (core/kioskFunnel.ts): kept, sent on the next sync. */
  funnelEvents(events: unknown): void {
    if (!Array.isArray(events) || !this.isKiosk()) return;
    this.funnel.add(events.slice(0, 200) as FunnelEvent[]);
  }

  /**
   * The cloud's word on the basket before the charge (`POST /sync/{m}/kiosk/basket-check`, ≤ 3 s):
   * what is no longer sold here and the base prices now. A difference pulls the catalog at once; a
   * changed set of promotions is pulled before the basket is priced (as the Android kiosk).
   * No answer (offline, slow): the local catalog decides, as before.
   */
  private async cloudBasketCheck(input: StartPaymentIn): Promise<void> {
    const id = this.machineId;
    if (!id || this.offlineNow || input.lines.length === 0) return;
    const cat = this.catalogData();
    const byId = new Map<string, KProduct>(cat.products.map((p) => [p.id, p]));
    const body = cloudCheckRequest(input.lines, (pid) => {
      const p = byId.get(pid);
      return p ? ofShekels(p.price) : undefined;
    }, this.cloud.promotionsEtag());
    const reply = await this.api.post<CloudVerdict>(`sync/${id}/kiosk/basket-check`, body, { timeoutMs: CLOUD_CHECK_TIMEOUT_MS });
    if (reply.kind !== 'ok' || !reply.body || !Array.isArray(reply.body.lines)) return;
    const o = overridesOf(reply.body, Date.now());
    this.cloudBasket = o.gone.size > 0 || o.prices.size > 0 ? o : null;
    if (!reply.body.ok) void this.sync.pullCatalog(false).then(() => this.dirty()).catch(() => undefined);
    if (reply.body.promotions?.changed) await within(this.sync.pullPromotions(), PROMOTIONS_PULL_TIMEOUT_MS);
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
    if (row.kind === 'kds_release') {
      const r = this.kv.getJson<Record<string, unknown>>(`kds:${row.ref_id}`);
      return r ? { path: 'kds/release', body: r } : null;
    }
    if (row.kind === 'till_event') {
      const e = this.kv.getJson<DesktopExitEvent>(`tillEvent:${row.ref_id}`);
      return e ? { path: 'events', body: e } : null;
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
    // Bridge mode: the browser shows the cloud's media itself; only the receipt's logo is kept here.
    if (!this.opts.bridge && snap?.kiosk === true && Array.isArray(snap.media)) {
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
    // A "מוכן / לא מוכן" board's media (its split / ticker layouts — core/screenMedia.ts).
    if (!this.opts.bridge) list.push(...this.screenMedia);
    return list;
  }

  private screenMedia: MediaRefIn[] = [];
  private screenMediaKey = '[]';

  /** The board's media to keep on the disk (main/roles/manager.ts); a change syncs the store. */
  setScreenMedia(refs: MediaRefIn[]): void {
    const key = JSON.stringify(refs.map((r) => [r.url, r.sha256]));
    if (key === this.screenMediaKey) return;
    this.screenMediaKey = key;
    this.screenMedia = refs;
    void this.syncMedia();
  }

  /** `kiosk://media/<file>` for a board's media file on the disk, or null while it is not. */
  screenMediaUrl(url: string): string | null {
    return this.localMediaUrl(url);
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
      onKeyRejected: (detail) => void this.reportSynqKeyRejected(detail),
    };
  }

  /** The terminal from the cloud settings: the first provider that is configured. */
  applyProvider() {
    const settings = this.settingsMap();
    let provider: PaymentProvider | null = null;
    // A screen (KDS, order status board) never takes a payment: no terminal at all.
    for (const f of this.fiscalRole ? this.providers : []) {
      try {
        provider = f(settings, this.providerContext());
      } catch (e) {
        this.log(`payment provider: ${String(e)}`);
      }
      if (provider) break;
    }
    this.pay.setProvider(provider, typeof settings.paymentIntegration === 'string' ? settings.paymentIntegration : null);
    // A paired key the cloud does not have yet: sent again (on the approving manager's authority).
    if (this.localSynqKey()?.pending) void this.uploadSynqKey();
  }

  /* ----------------------------------------------------- SynqPay pairing */

  private localSynqKey(): LocalSynqKey | null {
    const stored = this.kv.getJson<LocalSynqKey & { sealed?: boolean }>(SYNQ_LOCAL_KEY);
    if (!stored || typeof stored.apiKey !== 'string') return null;
    if (!stored.sealed) return stored;
    try {
      return { ...stored, apiKey: (this.opts.secretBox ?? PLAIN_BOX).open(stored.apiKey) };
    } catch {
      return null;
    }
  }

  private setLocalSynqKey(k: LocalSynqKey) {
    const box = this.opts.secretBox ?? PLAIN_BOX;
    this.kv.setJson(SYNQ_LOCAL_KEY, { ...k, apiKey: box.seal(k.apiKey), sealed: box !== PLAIN_BOX });
  }

  private synqProvider(): SynqPayProvider | null {
    const p = this.pay.current;
    return p && p.kind === 'synqpay' ? (p as SynqPayProvider) : null;
  }

  /** For the admin screen: the SynqPay terminal's pairing (null on any other terminal). */
  private synqpayInfo(): AdminInfo['terminal']['synqpay'] {
    const p = this.synqProvider();
    if (!p) return null;
    const local = this.localSynqKey();
    const status = this.synqPairing.expireIfDue();
    return {
      paired: p.settings.paired,
      needsPairing: !p.settings.paired || this.pay.monitor.lastError?.startsWith('המסוף דורש צימוד') === true,
      pendingUpload: local?.pending === true && local.apiKey === p.settings.apiKey,
      serialNumber: p.settings.serialNumber,
      pairing: status,
    };
  }

  /** "צימוד מסוף SynqPay": `pair` (the first code, or a new one). Never during a payment. */
  private async synqpayPair(serial: string | null): Promise<AdminActionResult> {
    const p = this.synqProvider();
    if (!p) return { ok: false, message: PAIRING_TEXT.notSynqPay };
    if (this.pay.cardInFlight || this.flow.busy || this.flow.screen === 'pay') return { ok: false, message: PAIRING_TEXT.tillBusy };
    const status = await this.synqPairing.start(p.pairing(), serial ?? this.synqPairing.status.serial ?? p.settings.serialNumber);
    return { ok: status.phase === 'awaiting_code', message: status.error ?? undefined, pairing: status };
  }

  /** The code from the terminal's screen: the key kept here, used at once, sent to the cloud. */
  private async synqpayCode(otp: string): Promise<AdminActionResult> {
    const p = this.synqProvider();
    if (!p) return { ok: false, message: PAIRING_TEXT.notSynqPay };
    if (this.pay.cardInFlight) return { ok: false, message: PAIRING_TEXT.tillBusy };
    const { status, apiKey } = await this.synqPairing.code(p.pairing(), otp);
    if (!apiKey) return { ok: false, message: status.error ?? undefined, pairing: status };
    this.setLocalSynqKey({ apiKey, pending: true, approver: this.adminUserId, serial: status.serial });
    this.synqReportedFor = null;
    this.log(`synqpay: paired with the terminal ${status.serial ?? '?'}; the key is kept here`);
    // The terminal with its key, now (the provider is rebuilt from the merged settings).
    this.applyProvider();
    const upload = await this.uploadSynqKey();
    if (upload) this.synqPairing.uploaded(upload);
    await this.pay.monitorTick({ busy: this.flow.busy, screen: this.flow.screen }, true).catch(() => undefined);
    this.dirty();
    return { ok: true, pairing: this.synqPairing.status };
  }

  /** The pending key to the cloud (`POST /sync/{m}/synqpay/pairing`); null when nothing to send. */
  private async uploadSynqKey(): Promise<PairingUpload | null> {
    const local = this.localSynqKey();
    if (!local?.pending || !this.machineId || this.synqUploading) return null;
    this.synqUploading = true;
    try {
      const approver = this.adminOk() ? this.adminUserId : local.approver;
      const reply = await this.api.post(
        `sync/${this.machineId}/synqpay/pairing`,
        { synqpayApiKey: local.apiKey, serialNumber: local.serial },
        approver ? { headers: { 'X-Pos-User-Id': approver } } : undefined,
      );
      const outcome = uploadOutcome(reply);
      if (outcome === 'uploaded') this.setLocalSynqKey({ ...local, pending: false });
      this.log(`synqpay: the paired key ${outcome === 'uploaded' ? 'is in the cloud' : `not sent (${outcome})`}`);
      return outcome;
    } finally {
      this.synqUploading = false;
    }
  }

  /** The terminal refused the key: told to the cloud once per key. */
  private async reportSynqKeyRejected(detail: string | null) {
    const key = this.synqProvider()?.settings.apiKey;
    if (!key || !this.machineId) return;
    const hash = createHash('sha256').update(key).digest('hex');
    if (this.synqReportedFor === hash) return;
    this.synqReportedFor = hash;
    const reply = await this.api.post(`sync/${this.machineId}/synqpay/key-rejected`, { detail: detail?.slice(0, 200) ?? null });
    if (reply.kind !== 'ok') this.synqReportedFor = null;
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
  /**
   * The basket priced from the kiosk's own catalog with the shared money rules (client/src/lib/kioskMoney.ts,
   * the Android till's, ported once): each choice charged as its group says (free choices, quantities,
   * "הרבה"), a meal's components on their defaults with their upcharges, then the promotions — each
   * line's share is the document's discount. The screen's figures are only compared, never trusted.
   */
  private priceBasket(input: StartPaymentIn, now = new Date()): { lines: SaleLine[]; changes: BasketChange[]; tracked: string[]; promotions: AppliedPromotionRow[] } {
    const cat = this.catalogData();
    const byId = new Map<string, KProduct>(cat.products.map((p) => [p.id, p]));
    const lines: SaleLine[] = [];
    const changes: BasketChange[] = [];
    const tracked = new Set<string>();
    // What the cloud said a moment ago wins over a catalog that has not caught up yet.
    const cloud = overridesLive(this.cloudBasket, Date.now());
    const gone = (id: string, p: KProduct | undefined) => !p || p.soldOut || !!cloud?.gone.has(id);
    for (const l of input.lines) {
      const p = byId.get(l.productId);
      // A meal whose chosen component is no longer sold goes as a whole: the customer chooses again.
      const parts = l.meal?.components ?? [];
      const slots = cat.meals[l.productId] ?? [];
      const brokenMeal = parts.some((c) => {
        const slot = slots.find((s) => s.id === c.slotId);
        return !slot || !slot.choices.some((x) => x.productId === c.productId) || gone(c.productId, byId.get(c.productId));
      });
      if (!p || gone(l.productId, p) || brokenMeal) {
        changes.push({ kind: 'removed', productId: l.productId, name: p?.name ?? '', key: l.key });
        continue;
      }
      const options = this.chargedOptions(cat.groups[p.id] ?? [], l.options);
      const components = parts.map((c) => {
        const slot = slots.find((s) => s.id === c.slotId)!;
        const cp = byId.get(c.productId)!;
        const groups = (cat.groups[cp.id] ?? []).map(moneyGroupOf);
        // The kiosk's meal: each component on its own defaults (MealDraft.start), or with the required choice the
        // customer answered in the meal window (MealDraft.updateDish) — priced by its groups here.
        const own = c.options && c.options.length > 0 ? this.chargedOptions(cat.groups[cp.id] ?? [], c.options) : null;
        const chosen = own ?? chosenOptions(groups, Object.fromEntries(groups.map((g) => [g.id, defaultPicks(g)])));
        if (cp.trackStock) tracked.add(cp.id);
        return {
          slotId: slot.id,
          slotName: slot.name,
          productId: cp.id,
          name: cp.name,
          categoryId: cp.categoryId,
          listPriceAgorot: checkedBasePrice(cp.id, cp.priceAgorot, cloud),
          upchargeAgorot: slot.choices.find((x) => x.productId === cp.id)!.upchargeAgorot,
          options: chosen.map((o): SaleOption => ({ groupId: o.groupId, groupName: o.groupName, kind: o.kind, optionId: o.optionId, name: o.name, priceAgorot: o.priceAgorot, qty: o.qty, pre: o.pre ?? null, chargedAgorot: o.chargedAgorot })),
        };
      });
      if (p.trackStock) tracked.add(p.id);
      lines.push({
        key: l.key,
        productId: p.id,
        name: p.name,
        sku: p.sku,
        basePriceAgorot: checkedBasePrice(p.id, p.priceAgorot, cloud),
        options,
        notes: l.notes.filter((n) => n.trim()),
        qty: Math.min(MAX_LINE_QTY, Math.max(1, Math.trunc(l.qty))),
        meal: components.length > 0 ? { productId: p.id, name: p.name, components } : null,
        categoryId: p.categoryId,
        noDiscount: p.noDiscount,
      });
    }
    // A price that moved since the screen showed it: shown to the customer, never charged as is.
    const priced = new Map(lines.map((x) => [x.key, { name: x.name, unitAgorot: unitAgorot(x) }] as const));
    for (const c of basketChanges(input.lines.filter((l) => priced.has(l.key)), priced)) if (c.kind === 'repriced') changes.push(c);
    // "מבצעים": the promotions on this basket now, by the kiosk's clock (KioskViewModel.price).
    const promo = priceKioskBasket(
      lines.map((x) => ({ id: x.key, productIds: [x.productId], categoryId: x.categoryId ?? null, unitAgorot: unitAgorot(x), qty: x.qty, noDiscount: x.noDiscount === true })),
      promotionsOf(this.cloud.promotions()),
      localDateTimeOf(now),
    );
    const shares = new Map(promo.lines.map((x) => [x.id, x] as const));
    for (const x of lines) {
      const share = shares.get(x.key);
      if (share && share.promotionAgorot > 0) {
        x.promotionAgorot = share.promotionAgorot;
        x.promotionId = share.promotionId;
        x.promotionName = share.promotionName;
      }
    }
    const promotions = promo.applied.map((a) => ({ promotionId: a.promotionId, name: a.name, type: a.type, applications: a.applications, discountAgorot: a.discountAgorot }));
    return { lines, changes, tracked: [...tracked], promotions };
  }

  /** A dish's choices from its catalog groups, priced per unit of the dish (kioskMoney.ts pickCharges); unknown ones dropped. */
  private chargedOptions(groups: KGroup[], picked: StartPaymentIn['lines'][number]['options']): SaleOption[] {
    const money = groups.map(moneyGroupOf);
    const picks: Record<string, OptionPick[]> = {};
    for (const o of picked) {
      const g = money.find((x) => x.id === o.groupId);
      if (!g || !g.options.some((x) => x.id === o.optionId)) continue;
      const pre = o.pre === 'lite' || o.pre === 'extra' || o.pre === 'side' ? o.pre : null;
      (picks[g.id] ??= []).push({ optionId: o.optionId, qty: Math.max(1, Math.trunc(o.qty ?? 1)), pre: g.allowPre ? pre : null });
    }
    return chosenOptions(money, picks).map((o) => ({ groupId: o.groupId, groupName: o.groupName, kind: o.kind, optionId: o.optionId, name: o.name, priceAgorot: o.priceAgorot, qty: o.qty, pre: o.pre, chargedAgorot: o.chargedAgorot }));
  }

  /**
   * "לתשלום": checked, a shift open, the order and the pending document written, then the charge.
   * Refused before anything is sent when the terminal cannot charge or an earlier one is unresolved.
   */
  async startPayment(input: StartPaymentIn): Promise<StartPaymentOut> {
    // A screen (KDS, order status board) is not a till: it never sells.
    if (!this.fiscalRole) return { ok: false, reason: 'error', message: 'מכשיר תצוגה אינו קופה' };
    if (this.pay.cardInFlight) return { ok: false, reason: 'busy', message: 'תשלום כבר בתהליך' };
    // No terminal set up: refused. One whose last check did not answer is tried now — its error said if it fails.
    if (!this.pay.configured) return { ok: false, reason: 'terminal', message: 'לא הוגדר מסופון אשראי לקיוסק. אנא פנו לצוות.' };
    if (this.pay.blocked()) return { ok: false, reason: 'unresolved', message: 'תשלום קודם ממתין לבירור. אנא פנו לצוות.' };
    // The cloud's word first, when it answers in time (core/basketCheck.ts).
    await this.cloudBasketCheck(input).catch(() => undefined);
    const { lines, changes, tracked, promotions } = this.priceBasket(input);
    const nowTotal = saleTotals(lines, this.vatRate()).totalAgorot;
    if (changes.length > 0) return { ok: false, reason: 'changed', changes, totalAgorot: nowTotal };
    // The total the customer saw: never a different one charged.
    const shownTotal = input.expectedTotalAgorot;
    if (typeof shownTotal === 'number' && Number.isFinite(shownTotal) && Math.round(shownTotal) !== nowTotal) {
      return { ok: false, reason: 'changed', changes: [], totalAgorot: nowTotal };
    }
    if (lines.length === 0) return { ok: false, reason: 'empty', message: 'הסל ריק' };
    const cfg = this.config();
    const operator = this.operator();
    const goods = saleTotals(lines, this.vatRate()).totalAgorot;
    const tip = tipToCharge(cfg.payment, goods, input.tipPct, input.tipAgorot);
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
      receiptStatus: 'pending',
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
      promotions,
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
    const rules: PickupRules = { scope: cfg.pickup.scope, prefix: cfg.pickup.prefix, start: cfg.pickup.start, max: cfg.pickup.max, labelFormat: cfg.pickup.labelFormat };
    const pickup = order.pickupNumber ? { number: order.pickupNumber, label: order.pickupLabel ?? String(order.pickupNumber) } : await allocatePickup(this.kv, this.api, this.machineId, order, rules);
    order = this.orders.update(orderId, (o) => ({ ...o, pickupNumber: pickup.number, pickupLabel: pickup.label }))!;
    const policy = cfg.payment.receiptPolicy;
    const receipt: PayProgress['receipt'] = policy === 'always' ? 'printing' : policy === 'ask' ? 'ask' : 'none';
    if (!recovered) {
      this.progress({ orderId, phase: 'approved', message: null, amountAgorot: doc.totals.chargeAgorot, canCancel: false, cancelling: false, pickupLabel: pickup.label, documentNumber: number, receipt });
    }
    if (recovered) {
      // Settled after the fact (a restart in between): no paper now — the customer is gone; staff re-print.
      this.orders.update(orderId, (o) => ({ ...o, receiptStatus: receiptAfterApproval(policy, true), bonDetail: 'שוחזר — הדפסה חוזרת מהניהול' }));
      void this.sync.flush();
      if (this.machineId) void this.orders.push(this.api, this.machineId);
      this.dirty();
      return;
    }
    this.printBon(orderId, false);
    // A KDS order: to the kitchen screens instead of the bon (`bonStep` prints none for it).
    this.releaseToKds(orderId);
    if (cfg.printing.pickupSlip) {
      this.printQueue.enqueue('slip', orderId, slipDoc({ businessName: this.business().companyName, pickupLabel: pickup.label, service: order.serviceType, itemCount: order.itemCount, totalAgorot: order.totalAgorot + order.tipAgorot }));
    }
    if (policy === 'always') this.printReceipt(orderId, false);
    // "שוברים": the sale's item tickets right after the slip and the receipt, on the same printer.
    this.printItemTickets(orderId);
    this.orders.update(orderId, (o) => ({ ...o, receiptStatus: receiptAfterApproval(policy, false) }));
    void me;
    void this.sync.flush();
    if (this.machineId) void this.orders.push(this.api, this.machineId);
    this.dirty();
  }

  /* ------------------------------------------------ "מזומן בקופה" and vouchers */

  /**
   * What this kiosk can take now, of the methods configured (payment.methods). One card per
   * document here (DocDraft.card): "פיצול תשלום בכרטיסים" (split_card) is never offered
   * (singleCardPayMethods) — and never usable.
   */
  /** Offline with "חסימת הזמנות כשאין אינטרנט" on: no orders at all. */
  private offlineBlocked(cfg: { general?: { blockWhenOffline?: boolean } } | null): boolean {
    return !!cfg && kioskOfflineBlocks(cfg.general, this.offlineNow);
  }

  private payView(kiosk: boolean): KioskView['pay'] {
    const methods = kiosk ? tsKioskPayMethods(this.config().payment.methods) : (['card'] as PaymentMethod[]);
    const state = this.pay.monitor.state;
    // Off in advance only with no terminal set up (or the cloud's lock on an unresolved card):
    // a terminal that did not answer its check is tried on the press.
    const cardOff = this.pay.blocked()
      ? 'תשלום קודם ממתין לבירור. אנא פנו לצוות.'
      : this.pay.configured
        ? null
        : state === 'unconfigured'
          ? 'לא הוגדר מסופון אשראי לקיוסק'
          : 'מסופון האשראי לא זמין כרגע';
    const usable = methods.filter((m) =>
      // A voucher only where its order can be finished: at the till (voucherCanFinish) — never a dead end.
      m === 'card' ? this.fiscalRole && cardOff === null : m === 'voucher' ? !this.offlineNow && voucherCanFinish(methods) : m === 'cash_at_till' ? this.fiscalRole : false,
    );
    // Offline with "חסימת הזמנות כשאין אינטרנט" on: nothing to take (the rest screen says why).
    return { methods, usable: kiosk && this.offlineBlocked(this.config()) ? [] : usable, cardOff };
  }

  /** The basket priced here (priceBasket) as the till's held sale carries it (client lib/kioskWebOrders.ts WebOrderLine). */
  private webLines(lines: SaleLine[]): WebOrderLine[] {
    const raw = new Map(this.cloud.catalog().products.map((p) => [String(p.id), p] as const));
    const option = (o: SaleOption): WebLineOption => ({
      groupId: o.groupId,
      groupName: o.groupName ?? null,
      kind: o.kind ?? 'addon',
      optionId: o.optionId,
      name: o.name,
      priceAgorot: o.priceAgorot,
      qty: o.qty,
      pre: o.pre ?? null,
      chargedAgorot: optionCharged(o),
    });
    return lines.map((l) => {
      const row = raw.get(l.productId) ?? {};
      return {
        key: l.key,
        productId: l.productId,
        name: l.name,
        qty: l.qty,
        baseAgorot: l.basePriceAgorot,
        unitAgorot: unitAgorot(l),
        options: l.options.map(option),
        note: l.notes.join(' · ') || null,
        categoryId: l.categoryId ?? null,
        sku: l.sku,
        barcode: typeof row.barcode === 'string' ? row.barcode : null,
        imageUrl: typeof row.imageUrl === 'string' ? row.imageUrl : null,
        allergens: Array.isArray(row.allergens) ? (row.allergens as unknown[]).filter((a): a is string => typeof a === 'string') : [],
        meal: l.meal
          ? { components: l.meal.components.map((c) => ({ slotId: c.slotId, slotName: c.slotName, productId: c.productId, name: c.name, categoryId: c.categoryId, listPriceAgorot: c.listPriceAgorot, upchargeAgorot: c.upchargeAgorot, options: c.options.map(option) })) }
          : null,
        noDiscount: l.noDiscount === true,
        ...((l.promotionAgorot ?? 0) > 0 ? { promotionAgorot: l.promotionAgorot, promotionId: l.promotionId ?? null, promotionName: l.promotionName ?? null } : {}),
      };
    });
  }

  /** A voucher for this basket, redeemed online (kiosk/payAtTill.ts); the basket priced here. */
  async redeemVoucher(input: { code: string; basket: StartPaymentIn; earlier: VoucherLeg[]; forfeitRest?: boolean; clientRequestId: string }): Promise<VoucherResult> {
    if (!this.fiscalRole || !this.isKiosk()) return { kind: 'refused', reason: 'not_a_kiosk' };
    const { lines } = this.priceBasket(input.basket);
    return this.payAtTill.redeem({ code: input.code, lines: this.webLines(lines), earlier: input.earlier ?? [], forfeitRest: input.forfeitRest, clientRequestId: input.clientRequestId });
  }

  async reverseVoucher(redemptionId: string): Promise<void> {
    if (typeof redemptionId === 'string' && redemptionId) await this.payAtTill.reverse(redemptionId);
  }

  /**
   * "מזומן בקופה": the basket checked and priced here as for the card (never a total the customer did
   * not see), its number, then the open order to the shop's tills — no document here: the till that
   * takes the money writes it. With "שלח למטבח לפני תשלום" the bon is printed now, else the till's.
   */
  async placeOpenOrder(input: PlaceOrderIn): Promise<PlaceOrderOut> {
    if (!this.fiscalRole || !this.isKiosk()) return { ok: false, reason: 'error', message: 'המכשיר אינו קיוסק פעיל' };
    const cfg = this.config();
    if (!kioskPayMethods(cfg.payment.methods).includes('cash_at_till')) return { ok: false, reason: 'error', message: 'תשלום בקופה אינו מוגדר לקיוסק' };
    await this.cloudBasketCheck(input).catch(() => undefined);
    const { lines, changes } = this.priceBasket(input);
    const goods = saleTotals(lines, this.vatRate()).totalAgorot;
    if (changes.length > 0) return { ok: false, reason: 'changed', changes, totalAgorot: goods };
    if (typeof input.expectedTotalAgorot === 'number' && Number.isFinite(input.expectedTotalAgorot) && Math.round(input.expectedTotalAgorot) !== goods) {
      return { ok: false, reason: 'changed', changes: [], totalAgorot: goods };
    }
    if (lines.length === 0) return { ok: false, reason: 'empty', message: 'הסל ריק' };
    const tip = tipToCharge(cfg.payment, goods, input.tipPct, input.tipAgorot);
    const vouchers = (Array.isArray(input.vouchers) ? input.vouchers : []).filter((v) => v && typeof v.redemptionId === 'string' && Number.isInteger(v.amountAgorot) && v.amountAgorot >= 0);
    if (vouchers.reduce((s, v) => s + v.amountAgorot, 0) > goods + tip) return { ok: false, reason: 'error', message: 'השוברים עולים על ההזמנה' };
    const now = Date.now();
    const localId = randomUUID();
    const businessDate = localDate(now);
    const pickup = await allocatePickup(this.kv, this.api, this.machineId, { localId, businessDate }, { scope: cfg.pickup.scope, prefix: cfg.pickup.prefix, start: cfg.pickup.start, max: cfg.pickup.max, labelFormat: cfg.pickup.labelFormat });
    const order: OpenOrder = {
      localId,
      createdAtMs: now,
      businessDate,
      serviceType: input.service,
      tableRef: input.tableRef?.trim() || null,
      fulfillmentMode: cfg.general.fulfillmentMode === 'KDS' ? 'KDS' : 'BON',
      configVersion: (this.snapshot()?.configVersion as string) ?? null,
      customerName: input.customerName?.trim() || null,
      customerPhone: input.customerPhone?.trim() || null,
      lines: this.webLines(lines),
      tipAgorot: tip,
      vouchers,
      pickupNumber: pickup.number,
      pickupLabel: pickup.label,
      bon: { mode: cfg.printing.bonMode === 'single' ? 'single' : 'routing', printerId: cfg.printing.bonPrinterId ?? null, copies: Math.max(1, Math.min(5, cfg.printing.bonCopies || 1)) },
      kitchenSent: false,
      cloudState: null,
      rejected: null,
    };
    // "שלח למטבח לפני תשלום": this kiosk's own printer has the bon ("ממתין לתשלום בקופה") — once the
    // cloud has not refused the order (it may be offline: the bon prints all the same). With "בון מטבח
    // במדפסת הקיוסק" off it never prints here: the till that takes the money prints it.
    const kitchenFirst = cfg.payment.cashAtTillKitchenBeforePay && order.fulfillmentMode === 'BON' && windowsBonRoute(cfg.printing) !== 'none';
    order.kitchenSent = kitchenFirst;
    const placed = await this.payAtTill.place(order);
    if (placed.rejected === PRICE_CHANGED) {
      // The cloud prices it otherwise: never placed. The catalog caught up, the customer shown the change.
      this.payAtTill.forget(localId);
      await within(this.sync.pullCatalog(false), CATALOG_CATCH_UP_MS);
      this.dirty();
      return { ok: false, reason: 'changed', changes: priceChangesOf(placed.refusedLines) };
    }
    if (placed.rejected) {
      this.dirty();
      return { ok: false, reason: 'rejected', message: `ההזמנה לא נקלטה (${placed.rejected}). אנא פנו לצוות.` };
    }
    if (kitchenFirst) {
      this.printQueue.enqueue(
        'bon',
        localId,
        bonDoc({
          pickupLabel: pickup.label,
          customerName: order.customerName,
          tableRef: order.tableRef,
          documentNumber: pickup.label,
          sub: 'ממתין לתשלום בקופה',
          service: order.serviceType,
          createdAt: new Date(now),
          kioskName: this.operator().name,
          posNumber: this.cloud.machine()?.posNumber ?? null,
          machineName: this.cloud.machine()?.machineName ?? null,
          lines: lines.map((l) => ({ qty: l.qty, name: l.name, options: kitchenOptions(l), notes: l.notes.join(' · ') || null })),
          reprint: false,
          copy: 1,
          printerName: null,
        }),
      );
    }
    if (cfg.printing.pickupSlip) {
      this.printQueue.enqueue('slip', localId, slipDoc({ businessName: this.business().companyName, pickupLabel: pickup.label, service: order.serviceType, itemCount: lines.reduce((n, l) => n + l.qty, 0), totalAgorot: orderDue(placed) }));
    }
    this.dirty();
    return { ok: true, localId, pickupLabel: pickup.label, vouchers, dueAgorot: orderDue(placed), pending: placed.cloudState === null, code: orderCode(localId) };
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

  /* ------------------------------------------- "גשר לדפדפן" (main/bridge) */

  /** The payment the screen follows now (the bridge's `GET /pay/status`), or null. */
  currentPay(): PayProgress | null {
    return this.payProgress;
  }

  /** Whether a card can be taken now, and why not (in Hebrew, for the browser's card tile). */
  cardReadiness(): { ready: boolean; state: string; blocked: boolean; reason: string | null } {
    const state = this.pay.monitor.state;
    const blocked = this.pay.blocked();
    if (!this.fiscalRole || !this.paired) return { ready: false, state, blocked, reason: 'הגשר אינו מקושר לקיוסק' };
    if (!this.isKiosk()) return { ready: false, state, blocked, reason: 'המכשיר אינו קיוסק פעיל בענן' };
    if (blocked) return { ready: false, state, blocked, reason: 'תשלום קודם ממתין לבירור. אנא פנו לצוות.' };
    if (!this.pay.configured) return { ready: false, state, blocked, reason: state === 'unconfigured' ? 'לא הוגדר מסופון אשראי לקיוסק' : 'מסופון האשראי לא זמין כרגע' };
    return { ready: true, state, blocked, reason: null };
  }

  /**
   * This service's part of the kiosk's `kiosk/sync` status, for the browser page that reports it:
   * the shift, the printer and terminal (as alerts and health), the card orders of today, the
   * documents waiting to upload. The help request and the flow stay the page's.
   */
  bridgePart(): Record<string, unknown> | null {
    if (!this.paired || !this.isKiosk()) return null;
    const s = this.kioskStatus();
    const health = (s.health ?? {}) as Record<string, unknown>;
    const pending = (health.pending ?? {}) as Record<string, unknown>;
    return {
      shiftOpen: s.shiftOpen,
      bonPrinter: s.bonPrinter,
      receiptPrinter: s.receiptPrinter,
      unprintedBons: s.unprintedBons,
      ordersToday: s.ordersToday,
      salesTodayAgorot: s.salesTodayAgorot,
      lastOrderAt: s.lastOrderAt,
      pendingOrders: s.pendingOrders,
      alerts: ((s.alerts ?? []) as Array<Record<string, unknown>>).filter((a) => a.kind !== 'help'),
      health: { terminal: health.terminal, printer: health.printer, pending: { documents: pending.documents ?? 0, orders: pending.orders ?? 0, oldestAt: pending.oldestAt } },
    };
  }

  /**
   * "סגירה יחד עם ה-Z הסניפי" for a browser kiosk with a bridge (its `kiosk/sync` closeRequest,
   * forwarded by the page): the shift closed once the kiosk is idle — never over a payment — and,
   * in zMode = till, the Z produced. Answered once per request (kept), `pending` until it can run.
   */
  async closeForShopZ(requestId: string): Promise<{ state: 'done' | 'failed' | 'pending'; shiftId: string | null; zNumber: number | null; detail: string | null }> {
    const key = `bridge.shopZClose:${requestId}`;
    const kept = this.kv.getJson<{ state: 'done' | 'failed'; shiftId: string | null; zNumber: number | null; detail: string | null }>(key);
    if (kept) return kept;
    const mayRun = autoCloseMayRun({ kiosk: this.fiscalRole && this.isKiosk(), flowIdle: this.flow.idle, flowBusy: this.flow.busy, cardInFlight: this.pay.cardInFlight });
    if (!mayRun) return { state: 'pending', shiftId: null, zNumber: null, detail: 'לקוח באמצע הזמנה או תשלום' };
    const op = this.operator();
    const r = this.ledger.closeShift({ closedByName: closerName(op), unattended: true, vatRate: this.vatRate() });
    if (r.kind === 'pending') return { state: 'pending', shiftId: null, zNumber: null, detail: 'תשלום ממתין לבירור' };
    let result: { state: 'done' | 'failed'; shiftId: string | null; zNumber: number | null; detail: string | null };
    if (r.kind === 'none') result = { state: 'done', shiftId: null, zNumber: null, detail: 'אין משמרת פתוחה' };
    else {
      await this.sync.flush();
      let zNumber: number | null = null;
      let detail: string | null = null;
      if (zModeOf(this.cloud.heartbeat().zMode) === 'till') {
        const z = await this.tillZ.produce(closerName(op), true);
        if (z.kind === 'produced' && typeof z.z.number === 'number') zNumber = z.z.number;
        else detail = 'המשמרת נסגרה; ה-Z יופק כשהענן יענה';
      }
      result = { state: 'done', shiftId: r.shift.id, zNumber, detail };
    }
    this.kv.setJson(key, result);
    this.dirty();
    return result;
  }

  /**
   * The cloud's `closeRequest` on `kiosk/sync` (KioskRepository.onOpsReply): kept until carried out;
   * the result is reported with every status until the cloud stops asking, then forgotten.
   */
  private onCloseRequest(raw: unknown) {
    const req = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
    const reported = this.kv.getJson<{ id: string }>(SHOP_Z_CLOSE_RESULT);
    if (!req) {
      // The cloud took the result (it no longer asks): nothing more to report.
      if (reported) this.kv.delete(SHOP_Z_CLOSE_RESULT);
      return;
    }
    const id = typeof req.id === 'string' && req.id.trim() ? req.id : null;
    if (!id || reported?.id === id) return;
    if (this.kv.get(SHOP_Z_CLOSE_REQUEST) !== id) {
      this.log(`kiosk: the shop's Z asks for a close (${String(req.source ?? '')}) — once idle`);
      this.kv.set(SHOP_Z_CLOSE_REQUEST, id);
    }
  }

  /**
   * "סגירה יחד עם ה-Z הסניפי", on an idle kiosk (KioskRepository.runShopZClose): the shift closed — a
   * payment still pending holds it, never cut — then, in zMode = till, this kiosk's own Z (owed on
   * disk first, the number the cloud's next). Done only once the Z is produced; the result goes up
   * with the next status.
   */
  private async runShopZClose(requestId: string): Promise<boolean> {
    const op = this.operator();
    let shiftId: string | null = null;
    if (this.ledger.currentShift()) {
      const r = this.ledger.closeShift({ closedByName: closerName(op), unattended: true, vatRate: this.vatRate() });
      // A payment's document still pending: the next tick.
      if (r.kind === 'pending') return false;
      if (r.kind === 'closed') {
        shiftId = r.shift.id;
        this.log(`kiosk: shift ${shiftId} closed with the shop's Z`);
        await this.sync.flush();
      }
    }
    let zNumber: number | null = null;
    if (zModeOf(this.cloud.heartbeat().zMode) === 'till') {
      this.tillZ.markOwed();
      const z = await this.tillZ.produce(closerName(op), true);
      if (z.kind === 'produced' && typeof z.z.machineSequenceNumber === 'number') zNumber = z.z.machineSequenceNumber;
      else if (z.kind === 'produced' && typeof z.z.zNumber === 'number') zNumber = z.z.zNumber;
      // No answer from the cloud yet: the Z stays owed and is asked again next tick.
      if (this.tillZ.owed) return false;
    }
    this.kv.setJson(SHOP_Z_CLOSE_RESULT, { id: requestId, state: 'done', shiftId, zNumber });
    this.kv.delete(SHOP_Z_CLOSE_REQUEST);
    void this.sync.kioskSync();
    return true;
  }

  /**
   * The main till's local shop Z asks for this kiosk's part through the cloud (main/fiscal/shopZPart.ts):
   * closed as over the LAN — a customer paying waited out, a pending payment refusing it, never twice
   * for one request — and answered with the kiosk's section and manifest. The answer is kept before
   * it is sent, so a retry (offline, a restart) sends the same one.
   */
  private async runShopZPart(): Promise<void> {
    const req = this.shopZPart;
    const me = this.machineId;
    if (!req || !me || this.shopZPartBusy) return;
    this.shopZPartBusy = true;
    try {
      const kept = this.kv.getJson<{ requestId: string; report: Record<string, unknown> }>(SHOP_Z_PART);
      let report = kept?.requestId === req.requestId ? kept.report : null;
      if (!report) {
        const open = this.ledger.currentShift();
        const plan = planLanClose({
          closedForRequest: this.ledger.shiftByCloseRequest(req.requestId)?.id ?? null,
          openShiftId: open?.id ?? null,
          devicePaying: this.pay.cardInFlight,
          payingSinceMs: req.payingSinceMs,
          nowMs: Date.now(),
          pendingDocuments: open ? this.ledger.pendingInShift(open.id) : 0,
        });
        if (plan.kind === 'wait') {
          if (req.payingSinceMs === null) {
            req.payingSinceMs = Date.now();
            await this.postShopZPart(lanCloseReport(req, me, 'waiting_card', null, lanOutcomeMessage('waiting_card'), null));
          }
          return;
        }
        let outcome: LanCloseOutcome;
        let shiftId: string | null;
        if (plan.kind === 'close') {
          const op = this.operator();
          const r = this.ledger.closeShift({ closedByName: closerName(op), unattended: true, closeRequestId: req.requestId, vatRate: this.vatRate() });
          outcome = r.kind === 'closed' ? 'closed' : r.kind === 'none' ? 'no_open_shift' : 'blocked_payment';
          shiftId = r.kind === 'closed' ? r.shift.id : r.kind === 'none' ? null : plan.shiftId;
          if (r.kind === 'closed') {
            this.log(`shop Z part ${req.requestId}: shift ${r.shift.id} closed for the main till`);
            void this.sync.flush();
          }
        } else {
          outcome = plan.outcome;
          shiftId = plan.shiftId;
        }
        if (outcome === 'closed' || outcome === 'no_open_shift') {
          const m = this.cloud.machine();
          const op = this.operator();
          const built = kioskSection(
            { machineId: me, posNumber: m?.posNumber?.trim() || null, machineName: m?.machineName?.trim() || null, operator: op },
            this.ledger.unreportedShifts(),
            (id) => this.ledger.docsOfShift(id),
          );
          report =
            built.kind === 'ok'
              ? lanCloseReport(req, me, outcome, shiftId, lanOutcomeMessage(outcome), built.section)
              : lanCloseReport(req, me, 'failed', shiftId, lanOutcomeMessage('failed', `סגירת משמרת ${built.shiftId.slice(0, 8)} לא קריאה`), null);
        } else {
          report = lanCloseReport(req, me, outcome, shiftId, lanOutcomeMessage(outcome), null);
        }
        this.kv.setJson(SHOP_Z_PART, { requestId: req.requestId, report });
      }
      if ((await this.postShopZPart(report)) && FINAL_OUTCOMES.has(report.outcome as LanCloseOutcome)) this.shopZPart = null;
    } finally {
      this.shopZPartBusy = false;
      this.dirty();
    }
  }

  /** `POST shop-z/remote-part`: true when the cloud answered (taken, or a request it no longer holds). */
  private async postShopZPart(report: Record<string, unknown>): Promise<boolean> {
    const me = this.machineId;
    if (!me) return false;
    const reply = await this.api.post(`sync/${me}/shop-z/remote-part`, report, { timeoutMs: 20_000 });
    if (reply.kind === 'offline') return false;
    if (reply.kind === 'refused') this.log(`shop Z part refused: HTTP ${reply.status} ${reply.detail ?? ''}`);
    return true;
  }

  /** A non-fiscal page drawn by the browser's role (a bon, a slip) — never a receipt (those come from the ledger). */
  printPage(kind: 'bon' | 'slip', refId: string | null, doc: PrintDoc): string {
    return this.printQueue.enqueue(kind, refId, doc);
  }

  /** "הדפסת בדיקה". */
  async printTest(): Promise<string> {
    await this.lookForPrinter();
    return this.printQueue.enqueue('test', null, slipDoc({ businessName: 'בדיקת מדפסת', pickupLabel: 'TEST', service: 'take_away', itemCount: 0, totalAgorot: 0 }));
  }

  /** The cash drawer's kick through the receipt printer (its RJ11 port). */
  async openDrawer(): Promise<void> {
    await this.transport.send(this.printerResolution().target, DRAWER_KICK);
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
        // What was charged (free choices are not printed), a meal's components with their upcharge (LineText.receiptSubLines).
        paid: [
          ...l.options.filter((o) => optionCharged(o) > 0).map((o) => ({ text: kitchenOptionText(o), priceAgorot: optionCharged(o) })),
          ...(l.meal?.components ?? []).flatMap((c) => [
            { text: c.name, priceAgorot: c.upchargeAgorot },
            ...c.options.filter((o) => optionCharged(o) > 0).map((o) => ({ text: `  ${kitchenOptionText(o)}`, priceAgorot: optionCharged(o) })),
          ]),
        ],
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
        // "הנחת מבצע: <שם>" — the promotions the sale was priced with.
        promotions: (doc.promotions ?? []).map((p) => ({ name: p.name, discountAgorot: p.discountAgorot })),
        card: doc.card ? { brand: doc.card.brand, last4: doc.card.last4, authNum: doc.card.authNum, payments: doc.card.payments, firstPaymentAgorot: doc.card.firstPaymentAgorot } : null,
        footer,
        logoUrl: typeof logo === 'string' ? this.localMediaUrl(logo) : null,
        // "סניף הרצליה · קופה 3 · קיוסק רויאל": the machine as the cloud names it (machines/me).
        place: this.placeOfMachine(),
        // "מספר הזמנה A-1" on the receipt (`printing.orderNumberOnReceipt`, on by default): one paper.
        orderNumber: this.config().printing.orderNumberOnReceipt ? o.pickupLabel ?? null : null,
      }),
    );
  }

  /** The shop, the till's number and name, as `machines/me` says them (the documents' place line). */
  private placeOfMachine(): { shopName: string | null; posNumber: string | null; deviceName: string | null } {
    const me = this.cloud.machine();
    return { shopName: me?.shopName ?? null, posNumber: me?.posNumber ?? null, deviceName: me?.machineName ?? null };
  }

  /**
   * "שוברים" — the sale's item tickets on this kiosk's printer, by the till's rules
   * (core/itemTickets.ts): each product's ticket mode from the catalog it syncs, "שוברי פריט" from
   * its parameters; not for a credit note. Queued like any page: a failure is the printer's light
   * and a retry, never the payment's.
   */
  printItemTickets(orderId: string): number {
    const o = this.orders.get(orderId);
    const doc = o?.transactionId ? this.ledger.doc(o.transactionId) : null;
    if (!o || !doc || doc.status !== 'completed') return 0;
    const setting = itemTicketSetting(this.cloud.parameters()[ITEM_TICKET_PARAM]);
    if (!itemTicketsPrint(doc.documentType, true, setting)) return 0;
    const catalog = this.cloud.catalog();
    const products = new Map(catalog.products.map((p) => [String(p.id), p] as const));
    const categories = new Map(catalog.categories.map((c) => [String(c.id), c] as const));
    const tickets = splitItemTickets(
      doc.lines.map((l) => {
        const p = products.get(l.productId) ?? {};
        const category = typeof p.categoryId === 'string' ? categories.get(p.categoryId) : undefined;
        const entries = typeof p.ticketEntries === 'number' && p.ticketEntries > 1 ? p.ticketEntries : 1;
        return {
          productId: l.productId,
          name: l.name,
          quantity: l.qty,
          unitLabel: p.isWeighed === true && typeof p.unitLabel === 'string' ? p.unitLabel : null,
          mode: ticketModeFor(resolveTicketMode(p.ticketMode, category?.ticketMode), setting),
          entries,
        };
      }),
    );
    const place = this.placeOfMachine();
    tickets.forEach((items, i) => {
      this.printQueue.enqueue(
        'ticket',
        orderId,
        ticketDoc({
          businessName: this.business().companyName,
          shopName: place.shopName,
          machineName: place.deviceName,
          posNumber: place.posNumber,
          transactionNumber: o.transactionNumber,
          issuedAt: new Date(doc.createdAt),
          items,
          index: i + 1,
          count: tickets.length,
        }),
      );
    });
    return tickets.length;
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
    const cfg = this.config();
    // "בון מטבח במדפסת הקיוסק" (off by default): every page this kiosk prints is on its own printer,
    // so off it prints no bon — said on the order, never a staff alert (core/kioskBonRoute.ts).
    if (windowsBonRoute(cfg.printing) === 'none') {
      this.orders.update(orderId, (x) => ({ ...x, bonStatus: 'none', bonDetail: BON_NOT_ON_KIOSK }));
      return;
    }
    this.orders.update(orderId, (x) => ({ ...x, bonRequestedAtMs: x.bonRequestedAtMs ?? Date.now(), bonStatus: 'queued' })); // write-ahead
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
            lines: doc.lines.map((l) => ({ qty: l.qty, name: l.name, options: kitchenOptions(l), notes: l.notes.join(' · ') || null })),
            reprint,
            copy: c,
            printerName: null,
          }),
        ),
      );
    }
    this.orders.update(orderId, (x) => ({ ...x, bonJobIds: reprint ? [...x.bonJobIds, ...ids] : ids }));
  }

  /**
   * A paid KDS-mode order to the cloud's kitchen engine — the release the Android kiosk sends
   * (kiosk/kdsRelease.ts), behind the same switch (`kdsEnabled`). Durable: the body is kept and
   * a side row of the outbox carries it (one per document — the release id is the document's),
   * sent with the documents' flush and again until the cloud answers.
   */
  releaseToKds(orderId: string): boolean {
    const o = this.orders.get(orderId);
    if (!o || !o.paid || !o.transactionId) return false;
    if (!releasesToKds(o, this.parameterOn('kdsEnabled'))) return false;
    const doc = this.ledger.doc(o.transactionId);
    if (!doc) return false;
    const categories = new Map<string, string>();
    for (const p of this.cloud.catalog().products) {
      if (typeof p.id === 'string' && typeof p.categoryId === 'string') categories.set(p.id, p.categoryId);
    }
    const body = kdsSaleRelease({
      transactionId: doc.id,
      transactionNumber: o.transactionNumber,
      order: o,
      lines: doc.lines,
      categoryOf: (id) => categories.get(id) ?? null,
      actorName: this.operator().name,
      occurredAt: doc.updatedAt,
    });
    this.kv.setJson(`kds:${doc.id}`, body);
    this.outbox.enqueue('kds_release', doc.id);
    return true;
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
    this.flowChangedAt = Date.now();
    // Trading starts again (opening hours, a lock lifted): the next shift opens as the kiosk itself.
    if (f.screen === 'attract' && ['closed', 'paused', 'no_payment'].includes(prev) && this.fiscalRole && this.isKiosk() && !this.tillZ.owed && !this.ledger.currentShift()) {
      this.ledger.openShift(this.operator());
    }
  }

  /** What the kiosk is doing, for the updater (core/updatePolicy.ts): never under an order or a payment. */
  activity(): Activity {
    return {
      role: this.isKiosk() ? 'kiosk' : null,
      screen: this.flow.screen,
      busy: this.flow.busy || this.payProgress?.phase === 'starting' || this.payProgress?.phase === 'charging',
      idle: this.flow.idle,
      cardInFlight: this.pay.cardInFlight,
      cardBlocked: this.pay.blocked(),
      lastActivityAt: this.flowChangedAt,
    };
  }

  /** The shell's role (main/roles/manager.ts): a KDS / board screen reports no till facts. */
  setFiscalRole(fiscal: boolean) {
    if (fiscal === this.fiscalRole) return;
    this.fiscalRole = fiscal;
    this.applyProvider();
  }

  /** Whether this device may ever open a shift, issue a document or charge (false for a KDS / board screen). */
  get fiscal(): boolean {
    return this.fiscalRole;
  }

  private tick5() {
    const was = this.offlineNow;
    this.offlineNow = this.paired && this.offline.update({ networkUp: this.platform.networkUp(), lastCloudOkAtMs: this.sync.status.lastBeatOkAt, startedAtMs: this.startedAt, nowMs: Date.now() });
    if (was !== this.offlineNow) this.dirty();
    // "אזל" / "חסום" until a time: lifted here at its time, offline too (KioskCatalogView by the kiosk's clock).
    if (this.saleChangeAt !== null && Date.now() >= this.saleChangeAt) {
      this.saleChangeAt = null;
      this.dirty();
    }
    this.refreshBonStates();
  }

  private async tick10() {
    await this.pay.monitorTick({ busy: this.flow.busy, screen: this.flow.screen });
  }

  private async tick30() {
    if (!this.paired) return;
    const mayRun = autoCloseMayRun({ kiosk: this.fiscalRole && this.isKiosk(), flowIdle: this.flow.idle, flowBusy: this.flow.busy, cardInFlight: this.pay.cardInFlight });
    const cfg = this.isKiosk() ? this.config() : null;
    const op = this.operator();
    // The main till's shop Z part: a payment waited out, an answer the cloud did not take yet.
    if (this.shopZPart) await this.runShopZPart();
    // The pinpad that moved (a DHCP change): looked for by who it is, "לפי המאק" first (PinpadRelocator).
    if (this.fiscalRole && !this.opts.bridge) await this.relocateTick().catch(() => undefined);
    // "סגירה יחד עם ה-Z הסניפי": carried out first, on an idle tick (KioskRepository.autoCloseTick).
    const closeRequest = this.kv.get(SHOP_Z_CLOSE_REQUEST);
    if (mayRun && closeRequest && !this.opts.bridge) {
      await this.runShopZClose(closeRequest);
      this.dirty();
      return;
    }
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

  /**
   * "ניהול הקיוסק" opens for 5 minutes to an active user of this shop whose role allows
   * `KIOSK_UNLOCK` ("יציאה מנעילת קופה (קיוסק)" — the Android kiosk's manager corner asks the same),
   * checked offline against the synced roster (bcrypt). A roster from a server before roles answers
   * by the legacy role: a shop manager, as before.
   */
  async adminUnlock(pin: string): Promise<{ ok: true; name: string } | { ok: false; error: string }> {
    const candidates = usersAllowed(this.cloud.posUsers(), this.shopIdHere(), KIOSK_UNLOCK);
    if (candidates.length === 0) return { ok: false, error: `אין בסניף מנהל עם הרשאת "${KIOSK_UNLOCK_LABEL}"` };
    const u = await findByPin(candidates, typeof pin === 'string' ? pin : '', (p, h) => bcrypt.compare(p, h));
    if (!u) return { ok: false, error: 'קוד שגוי' };
    this.adminUntil = Date.now() + 5 * 60_000;
    this.adminName = displayName(u);
    this.adminUserId = u.id;
    return { ok: true, name: this.adminName };
  }

  private adminOk(): boolean {
    return Date.now() < this.adminUntil;
  }

  /** The machine's shop (the roster's users must be of it). */
  private shopIdHere(): string | null {
    const me = this.cloud.machine()?.shopId;
    return this.cloud.credentials()?.shopId ?? (typeof me === 'string' ? me : null);
  }

  /** Whoever opened the admin, if their role (read again now) allows leaving the kiosk (`DESKTOP_EXIT`). */
  private adminExitUser() {
    return userMayExit(this.cloud.posUsers(), this.shopIdHere(), this.adminUserId);
  }

  adminInfo(): AdminInfo {
    const shift = this.ledger.currentShift();
    const media = this.media.getStatus();
    const printer = this.printerResolution();
    return {
      operator: this.paired ? this.operator() : null,
      shift: { open: !!shift, number: shift?.sequence_number ?? null, openedAt: shift?.opened_at ?? null },
      terminal: {
        ...this.pay.describe(),
        synqpay: this.synqpayInfo(),
        state: this.pay.monitor.state,
        lastOkAt: this.pay.monitor.lastOkAtMs,
        lastError: this.pay.monitor.lastError,
        unresolved: this.pay.attempts().map((a) => ({ reference: a.vuid, amountAgorot: a.amountAgorot, startedAt: a.startedAt, note: a.note })),
        // "בדיקת מספר מסוף מושבתת" (core/terminalCheckBypass.ts): the technician and admin screens say so.
        numberCheckBypass: this.parameterOn(TERMINAL_CHECK_BYPASS_KEY),
      },
      printer: {
        target: targetText(printer),
        health: this.printQueue.health(),
        lastError: this.printQueue.lastFailure?.error ?? null,
        queues: [],
        usb: usbStatusText(this.usbWatch.pick()),
        auto: printer.auto,
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
      desktopExit: this.adminExitUser()
        ? { allowed: true, reason: null }
        : { allowed: false, reason: this.adminUserId ? `אין לך הרשאה: ${PERMISSION_LABEL}` : `נדרש מנהל עם הרשאת "${PERMISSION_LABEL}"` },
    };
  }

  async adminAction(a: AdminAction): Promise<AdminActionResult> {
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
        await this.lookForPrinter();
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
        return { ok: !this.pay.unresolved() };
      case 'markNotApproved': {
        const ok = this.pay.markNotApproved(a.reference, { id: 'admin', name: this.adminName ?? 'מנהל' }, (att, meta) => {
          this.ledger.voidCardSale(att.transactionId, meta);
          if (this.liveUnknown(att.orderId)) this.progress({ ...this.payProgress!, phase: 'declined', message: 'סומן כלא אושר' });
        });
        this.dirty();
        return { ok };
      }
      // "יציאה לשולחן העבודה" / "יציאה מהתוכנה" from the manager's menu: the manager who opened it
      // must hold DESKTOP_EXIT (no second code), and never during an order or a payment.
      case 'desktopExit': {
        const user = this.adminExitUser();
        if (!user) return { ok: false, message: `אין הרשאה: ${PERMISSION_LABEL}` };
        const r = await this.exitAs(user, this.activity(), 'admin');
        return { ok: r.ok, message: r.message ?? undefined };
      }
      case 'exitKiosk': {
        const user = this.adminExitUser();
        if (!user) return { ok: false, message: `אין הרשאה: ${PERMISSION_LABEL}` };
        const activity = this.activity();
        const guard = exitGuard(activity);
        if (guard) return { ok: false, message: EXIT_TEXT.busy(guard) };
        this.recordTillEvent(exitEvent({ ...this.exitEventBase(user, activity), action: 'quit', via: 'admin' }));
        this.log(`app closed from the admin by ${displayName(user)} (${user.id})`);
        this.platform.quit();
        return { ok: true };
      }
      case 'synqpayPair':
        return this.synqpayPair(a.serialNumber?.trim() || null);
      case 'synqpayCode':
        return this.synqpayCode(a.otp);
      case 'synqpayRetryUpload': {
        const outcome = await this.uploadSynqKey();
        if (outcome) this.synqPairing.uploaded(outcome);
        return { ok: outcome === 'uploaded', pairing: this.synqPairing.status };
      }
    }
  }

  /* ---------------------------------------------------- the Windows desktop */

  /**
   * "יציאה לשולחן העבודה" (core/desktopExit.ts): a manager's PIN, checked here and offline against the
   * synced roster (active, this shop, `DESKTOP_EXIT` allowed, bcrypt); never during an order or a
   * payment (`activity`: the shell's, main/roles/manager.ts — the kiosk's flow, or a screen's); five
   * wrong codes lock the pad for a minute. Granted: the window leaves full screen
   * (`platform.exitToDesktop`) and the exit is recorded — on the device and to the cloud.
   */
  async desktopExit(pin: string, activity: Activity = this.activity()): Promise<DesktopExitResult> {
    const d = await decideExit({
      users: this.cloud.posUsers(),
      shopId: this.shopIdHere(),
      pin: typeof pin === 'string' ? pin : '',
      lock: this.kv.getJson<ExitLock>(DESKTOP_LOCK) ?? NO_EXIT_LOCK,
      nowMs: Date.now(),
      activity,
      // Asynchronous: bcrypt at the cloud's cost 12 takes a while in JS — the main process keeps going.
      compare: (p, h) => bcrypt.compare(p, h),
    });
    this.kv.setJson(DESKTOP_LOCK, d.lock);
    if (d.outcome !== 'granted' || !d.user) {
      if (d.outcome === 'locked_out') this.log('desktop exit: five wrong codes — the pad is locked for a minute');
      return { ok: false, outcome: d.outcome, message: d.message, triesLeft: d.triesLeft, lockedForMs: d.lockedForMs };
    }
    return this.exitAs(d.user, activity);
  }

  /** `user` may leave (checked by the caller): out of full screen, then the exit recorded. */
  private async exitAs(user: RosterUser, activity: Activity, via?: 'admin'): Promise<DesktopExitResult> {
    const guard = exitGuard(activity);
    if (guard) return { ok: false, outcome: 'busy', message: EXIT_TEXT.busy(guard) };
    const nowMs = Date.now();
    const out = this.platform.exitToDesktop ? await this.platform.exitToDesktop().catch((e: unknown) => ({ ok: false, message: String(e) })) : { ok: false, message: 'לא נתמך במכשיר הזה' };
    if (!out.ok) return { ok: false, outcome: 'failed', message: out.message ?? 'היציאה לשולחן העבודה נכשלה' };
    const event = exitEvent({ ...this.exitEventBase(user, activity), ...(via ? { via } : {}) });
    const name = displayName(user);
    this.kv.setJson(DESKTOP_STATE, { eventId: event.id, userId: user.id, userName: name, atMs: nowMs } satisfies DesktopExitState);
    this.recordTillEvent(event);
    this.log(`desktop exit by ${name} (${user.id})${via ? ` from the ${via}` : ''}`);
    return { ok: true, outcome: 'granted', message: null, name };
  }

  private exitEventBase(user: RosterUser, activity: Activity) {
    return {
      id: randomUUID(),
      atMs: Date.now(),
      user,
      shiftId: this.ledger.currentShift()?.id ?? null,
      screen: activity.screen || (activity.role ?? ''),
      deviceRole: activity.role ?? this.cloud.machine()?.deviceRole ?? null,
      appVersion: this.opts.appVersion,
    };
  }

  /**
   * "חזרה אוטומטית לקיוסק": the idle minutes on the desktop before full screen comes back — the
   * cloud's setting `desktopIdleReturnMinutes`, else the device's kiosk.json, else 10 (0 = never).
   */
  desktopIdleReturnMinutes(local?: unknown): number {
    const settings = this.cloud.settings().settings ?? {};
    return idleReturnMinutesFor({ cloud: (settings as Record<string, unknown>)[DESKTOP_IDLE_RETURN_KEY], local });
  }

  /** The exit in progress (null: in full screen). */
  desktopExitState(): DesktopExitState | null {
    return this.kv.getJson<DesktopExitState>(DESKTOP_STATE);
  }

  /** Back in full screen (the tray, the shortcut, the taskbar, idle, a restart): recorded once per exit. */
  desktopReturned(via: ReturnVia): void {
    const exit = this.desktopExitState();
    if (!exit) return;
    this.kv.delete(DESKTOP_STATE);
    this.recordTillEvent(returnEvent({ id: randomUUID(), atMs: Date.now(), exit, via, shiftId: this.ledger.currentShift()?.id ?? null }));
    this.log(`back from the desktop (${via})`);
  }

  /** The device's own log of the last exits and returns (also kept when the cloud is out of reach or refuses). */
  desktopExitLog(): DesktopExitEvent[] {
    return this.kv.getJson<DesktopExitEvent[]>(DESKTOP_LOG) ?? [];
  }

  /** A till event: kept here, and to the cloud through the outbox (`POST /sync/{m}/events`). */
  private recordTillEvent(e: DesktopExitEvent) {
    this.kv.setJson(`tillEvent:${e.id}`, e);
    this.kv.setJson(DESKTOP_LOG, [...this.desktopExitLog(), e].slice(-100));
    if (this.paired) this.outbox.enqueue('till_event', e.id);
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
    if (r.outcome === 'granted') {
      this.adminUntil = Date.now() + 5 * 60_000;
      // The technician's code is nobody's: no manager's name or rights carry over into this session.
      this.adminUserId = null;
      this.adminName = null;
    }
    return { outcome: r.outcome, triesLeft: r.triesLeft, lockedForMs: Math.max(0, r.lock.lockedUntilMs - Date.now()) };
  }

  async technicianInfo(): Promise<TechnicianInfo> {
    const scan = await this.usbWatch.refresh();
    const admin = this.adminInfo();
    const queues = scan?.queues ?? (await this.transport.list().catch(() => []));
    const me = this.cloud.machine();
    // The updater's own state — opening the screen never starts a download ("בדוק עכשיו" does).
    const u = this.platform.updateStatus?.() ?? null;
    const update = u
      ? { current: u.current, available: u.available, status: u.phase, message: u.message, progress: u.progress, lastCheckAt: u.lastCheckAt, autoInstall: u.autoInstall, installWindow: u.installWindow }
      : { current: this.opts.appVersion, available: null, status: 'not_checked' };
    return {
      machine: this.view().machine,
      deviceRole: me?.deviceRole ?? null,
      shopName: me?.shopName ?? null,
      companyName: me?.companyName ?? null,
      network: { online: !this.offlineNow, lastBeatOkAt: this.sync.status.lastBeatOkAt, serverUrl: this.cloud.credentials()?.serverUrl ?? null, interfaces: this.platform.interfaces() },
      printer: { ...admin.printer, queues: queues.map((q) => `${q.name} (${q.health})`) },
      terminal: admin.terminal,
      update,
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
        // A Windows queue with no name: "אוטומטי" — the USB printer plugged in (printer/usbPrinters.ts).
        this.setLocalSettings({ printer: a.transport === 'tcp' ? { transport: 'tcp', host: a.host ?? null, port: a.port ?? 9100 } : { transport: 'spooler', queueName: a.queueName?.trim() || null } });
        void this.usbWatch.refresh();
        return { ok: true };
      case 'pinpadCheck': {
        // Read-only: getStatus, never a charge.
        const p = this.pay.current;
        if (!p) return { ok: false, message: 'לא הוגדר מסופון' };
        // "בדיקת מסופון USB": getStatus + getRetailerInfo, the raw replies and the framing (nayaxUsb.ts).
        if (p instanceof NayaxUsbProvider) {
          if (this.pay.cardInFlight) return { ok: false, message: 'עסקה במסופון — נסו שוב בסיומה' };
          const c = await p.diagnose();
          const raw = c.replies.map((x) => `${x.method}: ${x.raw.slice(0, 2_000)}`).join('\n');
          return { ok: c.answered, message: `${c.answered ? 'המסופון ענה על הכבל' : 'המסופון לא ענה על הכבל'}\nFraming: ${c.framing}\n${raw}` };
        }
        const r = await p.check();
        return { ok: r.ok, message: r.ok ? 'המסופון עונה' : (r.detail ?? 'אין תשובה') };
      }
      case 'updateCheck': {
        const r = this.platform.checkUpdate ? await this.platform.checkUpdate() : { available: null, status: 'unsupported' };
        if (r.status === 'offline' || r.status === 'failed') return { ok: false, message: this.platform.updateStatus?.().message ?? 'הבדיקה נכשלה' };
        return { ok: true, message: r.available ? (r.status === 'ready' ? `גרסה ${r.available} הורדה ונבדקה — מוכנה להתקנה` : `גרסה ${r.available} זמינה`) : 'הגרסה עדכנית' };
      }
      case 'updateInstall': {
        // Never during an order or a payment (the updater checks the same rule again).
        const guard = paymentGuard(this.activity());
        if (guard) return { ok: false, message: guard };
        return this.platform.installUpdate ? this.platform.installUpdate() : { ok: false, message: 'לא נתמך' };
      }
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

/** After the cloud refused an order's prices, the catalog is pulled for at most this long before the customer is asked again. */
const CATALOG_CATCH_UP_MS = 8_000;

/** [p], waited for at most [ms] (it goes on by itself after). */
function within(p: Promise<unknown>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const id = setTimeout(resolve, ms);
    void p.catch(() => undefined).then(() => {
      clearTimeout(id);
      resolve();
    });
  });
}
