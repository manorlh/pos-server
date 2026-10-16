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
import { legMarks, openLines, orderCode, orderDue, recountLegs, type OpenOrder, type VoucherLeg, type WebLineOption, type WebOrderLine } from '@dash-lib/kioskWebOrders';
import { kioskTextOf } from '@dash-lib/kioskTexts';
import { DISCOUNT_PAY_HERE, startVouchersOf } from '@dash-lib/kioskVoucherClient';
import { voucherLabel, type AppliedDiscountVoucher, type VoucherOutcome } from '@dash-lib/kioskVouchers';
import { catalogNextChangeMs } from '@dash-lib/kioskSoldOut';
import { chosenOptions, defaultPicks, localDateTimeOf, priceKioskBasket, promotionsOf, type OptionPick } from '@dash-lib/kioskMoney';
import { localDate, kioskOperator, closerName, bonStep, receiptAfterApproval, type KioskOrder, type PickupRules } from '../core/kioskOrders';
import { OfflineTracker } from '../core/kioskHealth';
import { OFFLINE_BLOCK_CASH_KEY, OFFLINE_BLOCK_SCOPE_KEY, configOfflineBlockScope, offlineBlockCashOf, offlineBlockScopeOf, offlineRests, offlineUsable, type OfflineBlockScope } from '../core/offlineBlock';
import { lanTargetOf, type LanHost, type LanTarget } from '../core/lanOpenOrders';
import { CashPay, type CashOutcome, type CashProgress } from './kiosk/cashPay';
import { CashCredits } from './kiosk/cashCredits';
import { CashMagPay, CASHMAG_STATION_NAME, txViewOf as cashmagTxView, type CashMagEntry, type CashMagLocalConfig, type CashMagProgress } from './kiosk/cashmagPay';
import { CASHMAG_ERRORS, CASHMAG_HOST_ID, cashmagConfigText, type CashMagConfig } from '../core/cash/cashmag';
import type { CashMagDriverOptions } from './cash/cashmagDriver';
import type { CashRecyclerDriver } from './cash/recycler';
import type { CashMagFunctions } from '../core/cash/cashmagWire';
import type { SessionStore } from './cash/cashmagClient';
import { creditLegsOf } from '../core/cash/credit';
import { cashSlipDoc, payAtTillSlipDoc } from '../core/printDocs';
import { formatShekelSign, ltr } from '../core/money';
import { OWED_CHOICES, shortTx, type OwedChoice, type TxView } from '../core/cash/tx';
import { cashSettingsOf, shekelText, type CashSettings } from '../core/cash/settings';
import { cardPrincipalAgorot, legsOf, type DocCashLeg } from './fiscal/ledger';
import { formatDocNumber, prefixFor } from '../core/documentNumbers';
import type { PrintedPage } from '../core/till/remoteDocuments';
import { rowOf as transmissionRowOf, type TransmissionRow } from '../core/till/transmission';
import type { RemoteDocumentsRouter } from './till/tillRemotePrint';
import { isCreditType as isCreditDoc } from '../core/sale';
import { bonDoc, documentTitleFor, kioskBonStyle, receiptDoc, shopXPrintDoc, slipDoc, ticketDoc, xDoc, zDoc, type BusinessInfo, type PrintDoc, type ReceiptLine, type TicketDoc, type XInput } from '../core/printDocs';
import {
  appendLog,
  bonText,
  CLOUD_HISTORY_DAYS,
  decideApprover,
  eventDetails,
  failedTickets,
  HISTORY_DEFAULT_DAYS,
  HISTORY_KEEP_DAYS,
  HISTORY_SHOWN,
  kinds as reprintKinds,
  labelOf,
  lastBon,
  mayAlone as reprintAlone,
  mergeHistory,
  parseCloudOrders,
  parseLog,
  paymentText,
  receiptText,
  recent,
  REPRINT_TEXT,
  search as searchHistory,
  shiftDay,
  ticketStates,
  ticketsToReprint,
  type HistoryOrder,
  type ReprintKind,
  type TicketJob,
} from '../core/kioskReprint';
import { BON_NOT_ON_KIOSK, bonViaKitchen, windowsBonRouteFor, type KioskBonRoute } from '../core/kioskBonRoute';
import { ITEM_TICKET_PARAM, itemTicketSetting, itemTicketsPrint, resolveTicketMode, splitItemTickets, ticketModeFor } from '../core/itemTickets';
import { DRAWER_KICK } from '../core/escpos';
import { kitchenOptions, kitchenOptionText, MAX_LINE_QTY, optionCharged, saleDocumentType, saleTotals, tipToCharge, unitAgorot, vatRateOf, type SaleLine, type SaleOption } from '../core/sale';
import { autoCloseMayRun, zModeOf } from '../core/tillZ';
import { lineMenuFacts, menuKey, presentTillCatalog, resolveTillMenu } from '../core/till/menus';
import { offVoucherLineValues, voucherDeductionLabel, voucherLineMemo } from '../core/till/vouchers';
import { effectiveSnapshot, kioskFactsOf, rawFactsOf, REFUSAL_TEXT, WORK_TEXT, workModeEvent, type KioskSideFacts, type WorkModeEvent } from '../core/workMode';
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
import { kioskCloseDay, newSaleAllowed, SHOP_LOCK_FLOW, SHOP_LOCK_TEXT } from '@dash-lib/shopActive';
import { CLOSE_DAY_TEXT, closeDayCandidates, closeDayZText } from '../core/shopLock';
import { pickVariant, type MediaRefIn } from '../core/mediaPlan';
import { paymentGuard, type Activity } from '../core/updatePolicy';
import { TERMINAL_CHECK_BYPASS_KEY } from '../core/terminalCheckBypass';
import type { DesktopExitResult, UpdateView } from '../shared/roles';
import { openDb, type Db } from './db/sqlite';
import { Kv, migrate } from './db/schema';
import { Api, type FetchFn } from './sync/api';
import { CloudStore, parameterOn, PLAIN_BOX, type Credentials, type SecretBox } from './sync/cloud';
import { Outbox, type OutboxKind, type OutboxRow } from './sync/outbox';
import { pair as pairRequest, SyncEngine } from './sync/syncEngine';
import { docVoucherDiscounts, documentWire, Ledger, settled, tillManualDiscount, type AppliedPromotionRow, type DocDraft, type DocVoucherLeg } from './fiscal/ledger';
import { TillZService } from './fiscal/tillZService';
import { KioskZRunner, kioskZHold, kioskZKindOfDevice, kioskZOutcomeOk, kioskZOutcomeText, makesOwnZ, type KioskAdminZOutcome, type KioskZPort } from '../core/kioskZ';
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
import type { PaymentProvider, ProviderContext, ProviderFactory, TransmitResult } from './payment/provider';
import { PrintQueue, type JobKind, type PageRenderer } from './printer/printQueue';
import { DefaultTransport, type PrinterTarget, type Transport } from './printer/transports';
import { resolvePrinterTarget, targetText, usbStatusText, UsbPrinterWatch, type PrinterResolution } from './printer/usbPrinters';
import { allocatePickup, OrderStore } from './kiosk/orders';
import { PayAtTill, type VoucherResult } from './kiosk/payAtTill';
import { kdsSaleRelease, releasesToKds } from './kiosk/kdsRelease';
import { KitchenService } from './kitchen/kitchenService';
import { KdsOutbox } from './kitchen/kdsOutbox';
import { KitchenHost, TILL_ONLY_JOB_KINDS, kitchenJobsModule } from './kitchen/kitchenHost';
import { PrintJobsHost } from './printer/printJobsHost';
import { kioskBonToKitchen, tillSaleToKitchen } from './kitchen/kitchenFlows';
import type { LanCall } from './kitchen/kitchenNet';
import type { PrinterLink } from '../core/kitchen/delivery';
import { bonJobState } from '../core/kitchen/queue';
import { tillNameOf } from '../core/kitchen/tickets';
import { FunnelStore } from './kiosk/funnel';
import { WorkSessions, type WorkModeRuntime } from './workMode';
import {
  basketChanges,
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
import { applyBatteryStep, batteryMonitoredParam, batteryStep, isCritical, NO_CYCLE, parseThresholds, type BatteryAlertView, type BatteryCycle } from '../core/batteryAlerts';
import { buildKioskCatalog, catalogMedia, moneyGroupOf, type KGroup, type KProduct } from './kiosk/catalog';
import { basketSold, type BasketSold } from '@dash-lib/kioskBasketSold';
import { basePriceOf, hasMenus, keptListPrice, menuById, menuKeyAt, menuPriceSets, msToNextMinute, noMenuState, pricesNow } from '@dash-lib/kioskMenus';
import type { MenuBlock } from '@dash-lib/menuSchedule';
import type {
  AdminAction,
  AdminHistory,
  AdminInfo,
  BasketChange,
  HistoryRow,
  KioskEvents,
  KioskView,
  CashCreditResult,
  PayPhase,
  PayProgress,
  PlaceOrderIn,
  PlaceOrderOut,
  ShopLockCloseDayOut,
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
  /**
   * The screen it lays itself out on, for the cloud's fleet view (`status.display`, pos-server
   * kiosk_till_mode.clean_display): the primary display in DIPs and its scale (displayReport.ts).
   */
  displayInfo?: () => Record<string, unknown> | null;
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
  /**
   * CashMag (P:/specs/cashmag-windows.md): the kiosk's own settings from kiosk.json `cashmag` — the server's address,
   * the name, the user code (over the cloud's), and function names. Never synced.
   */
  cashmagLocal?: CashMagLocalConfig | null;
  /** Tests: the CashMag driver (a fake, or the real one against a fake server) and its options. */
  cashmagDriver?: (cfg: CashMagConfig, functions: CashMagFunctions, session: SessionStore) => CashRecyclerDriver;
  cashmagDriverOptions?: CashMagDriverOptions;
  cashmagPollMs?: number;
  /** Tests: the kiosk admin's Z waits between its looks for the close in the cloud (core/kioskZ.ts KioskZRunner). */
  kioskZPause?: (ms: number) => Promise<void>;
  /**
   * Tests: the kitchen's wires (main/kitchen) — a network printer's link, the LAN print server's request, whether this
   * PC is on a LAN, the kitchen's clock — and the LAN print host's port (0: any) and address.
   */
  kitchen?: { printerLink?: (host: string, port: number) => PrinterLink; lanCall?: LanCall; onLan?: () => boolean; now?: () => number; hostPort?: number; hostName?: string };
}

/** The kiosk's own local settings (not the cloud's): the printer (an empty Windows queue: "אוטומטי"), the zoom. */
export interface LocalSettings {
  printer: PrinterTarget;
  zoom: number | null;
}

const LOCAL_SETTINGS = 'local.settings';
const LOCAL_PAUSE = 'local.pause';
const TECH_LOCK = 'technician.lock';
/** Why there is no card on a kiosk set "ללא אשראי" (`paymentIntegration` = `none`): staff and the bridge's tile. */
const NO_CARD_TEXT = 'הקיוסק מוגדר ללא אשראי';
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
/** "מצב עבודה: קיוסק / קופה": the device's own log of its mode switches. */
const WORK_MODE_LOG = 'workMode.log';
/** "הדפסה חוזרת" in the manager's menu (core/kioskReprint.ts): the device's log of its reprints, the second code's lock. */
const REPRINT_LOG = 'kiosk.reprintLog';
const REPRINT_LOCK = 'kiosk.reprintLock';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A till event of the device's (`POST /sync/{m}/events`, pos-server TillEventIn): a desktop exit or a mode switch. */
type TillEventRecord = DesktopExitEvent | WorkModeEvent;

/**
 * A till's lines (main/till/engine.ts), for the pricing: `promo` — `exclude`: an OTH line, not counted by the promotions at
 * all; `handDiscountAgorot`: the cashier's line discount (never discounted by a promotion, counted after it); null: as rung
 * up. `listPrice` — a price the line keeps whatever the catalog says now.
 */
export interface TillLineHooks {
  promo?: (key: string, grossAgorot: number) => { exclude?: boolean; handDiscountAgorot?: number } | null;
  /** A held sale's line: the price it was parked at (HeldSaleCodec: a parked basket keeps the price it was quoted). */
  listPrice?: (key: string) => number | null;
}

/** A till event the till's engine records (held sales, line voids, the automatic close): kept and sent like the others. */
export interface TillEngineEvent {
  id: string;
  type: string;
  occurredAt: string;
  shiftId: string | null;
  posUserId: string | null;
  amount?: number;
  /** The document it concerns (a reprint's), when it is one of this device's (a UUID). */
  transactionId?: string;
  details: Record<string, unknown>;
}

/** "ניהול הקיוסק" on a device with no staff synced yet (the manager's code is checked on the device, never online). */
export const NO_ROSTER_TEXT = 'אין עדיין עובדים במכשיר — נדרש חיבור לענן פעם אחת. כניסת טכנאי: 6 הקשות בפינה השמאלית העליונה';
/**
 * "תשלום בקופה" with no cloud (core/lanOpenOrders.ts): the shop's LAN host — its print server — and the shop's print secret
 * (sealed), as `GET /sync/{m}/printers` last gave them, with its ETag. Read only by a kiosk that offers the till.
 */
const LAN_HOST = 'lan.host';
const LAN_HOST_PULL_MS = 5 * 60_000;
type KeptLanHost = { etag: string | null; host: LanHost | null; secret: string | null; sealed: boolean };

export class KioskService extends EventEmitter {
  readonly db: Db;
  readonly kv: Kv;
  /** "מצב עבודה": the till session / the away-in-kiosk session, kept in the kv (main/workMode.ts). */
  readonly workSessions: WorkSessions;
  /** The work mode's runtime (built by main/index.ts after the role manager); null until then and in tests that do not need it. */
  workMode: WorkModeRuntime | null = null;
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
  /** "מזומן" at the shop's cash station (kiosk/cashPay.ts, P:/specs/cash-paylink.md §11.6). */
  readonly cashPay: CashPay;
  /**
   * "מזומן" at a CashMag machine (kiosk/cashmagPay.ts, P:/specs/cashmag-windows.md): the kiosk's cash device instead of
   * the cash station when the cloud turns `cashmagEnabled` on — off by default (nothing of it runs).
   */
  readonly cashMag: CashMagPay;
  /** "בונים": the kitchen tickets to the shop's kitchen printers / print server / the cloud relay (main/kitchen). */
  readonly kitchen: KitchenService;
  /** A till's paid counter sales to the cloud's KDS (main/kitchen/kdsOutbox.ts). */
  readonly kitchenKds: KdsOutbox;
  /** This device printing for the shop's others when the cloud names it (main/kitchen/kitchenHost.ts). */
  readonly kitchenHost: KitchenHost;
  /**
   * The cloud's print jobs for this device (`GET /sync/{m}/print-jobs/pending`) — ONE poller (main/printer/printJobsHost.ts):
   * the kitchen's tickets while it hosts (main/kitchen/kitchenHost.ts), the till's drawers and documents while it works as
   * a till (main/till/tillDrawer.ts). A document or a drawer nobody here takes is answered "failed" at once.
   */
  readonly printJobs: PrintJobsHost;
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
  /** "חסר עודף" (P:/specs/cash-paylink.md §11.15א): the customer's choice the pay screen waits for. */
  private owedChoiceWait: { resolve: (c: OwedChoice) => void; choices: OwedChoice[] } | null = null;
  /** Cash + card (§11.15ב): the card's word on the rest, by document, until the station's part is settled. */
  private splitCards = new Map<
    string,
    { kind: 'approved'; card: NonNullable<DocDraft['card']> } | { kind: 'unknown'; message: string } | { kind: 'declined'; message: string; voidMeta: Record<string, unknown> | null }
  >();
  /** Cash credits taken for orders (§11.15א). */
  readonly cashCredits: CashCredits;
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
  /** Role modules' own heartbeat blocks (the cash host's `cash`, contract §11.9). */
  private readonly heartbeatParts = new Map<string, () => unknown>();
  /** "הדפסה בקופה אחרת" (main/till/tillRemotePrint.ts): where the till's pages go — null (a kiosk, no till): here, as before. */
  private remoteDocs: RemoteDocumentsRouter | null = null;

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
    this.workSessions = new WorkSessions(this.kv);
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
    const kitchenOpts = opts.kitchen ?? {};
    this.printJobs = new PrintJobsHost({ api: this.api, machineId: () => this.machineId, active: () => !this.isOffline, decline: TILL_ONLY_JOB_KINDS, log: this.log });
    this.kitchen = new KitchenService({
      db: this.db,
      kv: this.kv,
      api: this.api,
      machineId: () => this.machineId,
      secretBox: opts.secretBox,
      params: () => this.cloud.parameters(),
      tillName: () => tillNameOf(this.cloud.machine()?.posNumber, this.cloud.machine()?.machineName),
      ownTarget: () => this.printerResolution().target,
      transport: this.transport,
      renderer: () => this.printQueue.pageRenderer,
      onLan: kitchenOpts.onLan ?? (() => localPrivateIpv4() !== null),
      orderData: () => ({ courses: [], categories: this.kitchenCategories() }),
      // A kiosk says its unprinted bons in its own alerts (the order's bon status): the cloud's list is a till's.
      reportsBonAlerts: () => !this.isKiosk(),
      log: this.log,
      now: kitchenOpts.now,
      printerLink: kitchenOpts.printerLink,
      lanCall: kitchenOpts.lanCall,
    });
    this.kitchen.onChange(() => {
      this.refreshBonStates();
      this.dirty();
    });
    this.kitchenKds = new KdsOutbox({ kv: this.kv, api: this.api, machineId: () => this.machineId, kitchen: this.kitchen, log: this.log, now: kitchenOpts.now });
    this.kitchenHost = new KitchenHost({
      kitchen: this.kitchen,
      api: this.api,
      machineId: () => this.machineId,
      lanAddress: () => localPrivateIpv4(),
      log: this.log,
      portOverride: kitchenOpts.hostPort,
      hostname: kitchenOpts.hostName,
      printJobs: this.printJobs,
    });
    this.printJobs.register('kitchen', kitchenJobsModule(this.kitchen));
    this.payAtTill = new PayAtTill({
      kv: this.kv,
      api: this.api,
      machineId: () => this.machineId,
      operator: () => this.operator(),
      log: this.log,
      // The cloud away: the shop's LAN host takes the orders (its print server; never for an independent kiosk).
      lanTarget: () => this.lanTarget(),
      kioskName: () => this.operator().name,
    });
    this.cashPay = new CashPay({ api: this.api, kv: this.kv, machineId: () => this.machineId, log: this.log, fetch: opts.fetch });
    this.cashCredits = new CashCredits({ api: this.api, kv: this.kv, machineId: () => this.machineId, log: this.log });
    this.cashPay.onChange(() => this.dirty());
    this.cashMag = new CashMagPay({
      kv: this.kv,
      params: () => this.cloud.parameters(),
      local: () => opts.cashmagLocal ?? null,
      kioskName: () => this.cloud.machine()?.machineName ?? null,
      log: this.log,
      driverFor: opts.cashmagDriver,
      driverOptions: opts.cashmagDriverOptions,
      pollMs: opts.cashmagPollMs,
    });
    this.cashMag.onChange(() => this.dirty());
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
      online: () => !this.isOffline,
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

  /** A role module's block on every heartbeat (null removes it). `capabilities` is merged across the modules that say them. */
  setHeartbeatPart(key: string, part: (() => unknown) | null): void {
    if (key === 'capabilities') {
      this.setCapabilities('heartbeatPart', part ? () => (Array.isArray(part()) ? (part() as unknown[]).filter((w): w is string => typeof w === 'string') : []) : null);
      return;
    }
    if (part) this.heartbeatParts.set(key, part);
    else this.heartbeatParts.delete(key);
  }

  private readonly capabilityOwners = new Map<string, () => string[]>();

  /**
   * A module's words in the heartbeat's `capabilities` (the cash host's device logs, the till's `document_relay_v1` —
   * main/till/remoteDrawer.ts): the union of every owner's; none at all — no key (a heartbeat as before).
   */
  setCapabilities(owner: string, words: (() => string[]) | null): void {
    if (words) this.capabilityOwners.set(owner, words);
    else this.capabilityOwners.delete(owner);
    if (this.capabilityOwners.size === 0) {
      this.heartbeatParts.delete('capabilities');
      return;
    }
    this.heartbeatParts.set('capabilities', () => {
      const all = [...new Set([...this.capabilityOwners.values()].flatMap((f) => f()))];
      return all.length > 0 ? all : undefined;
    });
  }

  /** The cloud answered a heartbeat lately (90 s). */
  cloudOnline(): boolean {
    const at = this.sync.status.lastBeatOkAt;
    return at !== null && Date.now() - at < 90_000;
  }

  /** This PC's IPv4 addresses on its networks (the platform's; none in tools). */
  lanInterfaces(): Array<{ name: string; address: string }> {
    return this.platform.interfaces();
  }

  get dataDir(): string {
    return this.opts.dataDir;
  }

  get appVersion(): string {
    return this.opts.appVersion;
  }

  /** The kiosk's Nayax LAN pinpad as the cloud settings place it; null on any other terminal. */
  private pinpadHere(): { host: string; port: number; path: string } | null {
    // "ללא אשראי": no pinpad to look for or move (a terminal kept for an unresolved card included).
    if (this.pay.noCard || this.pay.describe().kind !== 'nayax_lan') return null;
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
    // "בונים": what a restart left in flight recovered, the queue running (offline too: the LAN and the printers).
    this.kitchen.start();
    this.kitchenKds.start();
    void this.kitchenHost.apply();
    // The cloud's print jobs for this device: one poller, at the pace its modules want (none: no call at all).
    this.printJobs.start();
    this.orders.prune();
    if (this.paired) {
      this.sync.start();
      void this.settleOrphans();
      void this.syncMedia();
      // "מזומן" at the cash station: its status for the tile, and payments a restart left open.
      this.cashPay.start();
      void this.settleCash();
      // CashMag (off by default: no probe, no connection): its port knocked on, and what a restart left.
      if (this.cashMag.enabled()) this.log(cashmagConfigText(this.cashMag.config()));
      this.cashMag.start();
      void this.settleCashMag();
    }
    this.timers.push(setInterval(() => void this.tick10(), 10_000));
    this.timers.push(setInterval(() => void this.tick30(), 30_000));
    this.timers.push(setInterval(() => this.tick5(), 5_000));
    // The USB printer plugged in, looked at now and every 15 s ("אוטומטי").
    if (this.ownsUsbWatch) this.usbWatch.start();
    void this.printQueue.work();
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.cashPay.stop();
    this.cashMag.stop();
    if (this.emitTimer) clearTimeout(this.emitTimer);
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    if (this.menuTimer) clearTimeout(this.menuTimer);
    this.menuTimer = null;
    this.offUsbWatch();
    if (this.ownsUsbWatch) this.usbWatch.stop();
    this.sync.stop();
    this.printJobs.stop();
    this.kitchen.stop();
    this.kitchenKds.stop();
    void this.kitchenHost.stop();
    this.transport.dispose();
    this.db.close();
  }

  private dirty() {
    this.viewDirty = true;
    this.catalogRev += 1;
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
  /** Moves with every change of what the catalog is built from (the cloud's catalog, stock, settings, media): the till's catalog is built again then. */
  private catalogRev = 0;
  private tillCatalogMemo: { rev: number; until: number | null; data: ReturnType<typeof buildKioskCatalog>; version: number; menu: string; block: unknown } | null = null;
  private tillCatalogBuilds = 0;

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
      // The cloud's "מדפסת חשבוניות — כתובת": a network address (IP[:port]); a Windows printer's NAME (a till has no technician
      // corner to choose one on the device — a MAC, which Android's Bluetooth printer uses, is not a name); else the spooler's automatic choice.
      const m = /^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d+))?$/.exec(addr);
      const mac = /^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i.test(addr);
      printer = m ? { transport: 'tcp', host: m[1], port: m[2] ? Number(m[2]) : 9100 } : { transport: 'spooler', queueName: addr && !mac ? addr : null };
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

  settingsMap(): Record<string, unknown> {
    const cloud = this.cloud.settings().settings ?? {};
    // A SynqPay key paired here that the cloud does not have yet wins over the sync's (pairing.ts).
    const local = this.localSynqKey();
    const merged = mergeLocalKey(cloud, local);
    if (merged.settled && local) this.setLocalSynqKey({ ...local, pending: false });
    return merged.settings;
  }

  business(): BusinessInfo {
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

  vatRate(): number {
    return vatRateOf(this.settingsMap().globalTaxRate, this.business().dealerType);
  }

  /**
   * The kiosk snapshot as the rest of the app reads it — the EFFECTIVE one (Android KioskHomeRole.effective):
   * a till by role at home, whose kiosk-mode row says `kiosk: true, homeRole: "till"`, reads `kiosk: false`, so a
   * till is a till exactly as before and only works as a kiosk while it is away in its kiosk mode.
   */
  private snapshot(): Record<string, unknown> | null {
    return effectiveSnapshot(this.cloud.kioskSnapshot(), this.workSessions.away() !== null);
  }

  /** The cloud's word as it said it — for the work mode's own decisions and for what a kiosk row's data needs. */
  rawKioskSnapshot(): Record<string, unknown> | null {
    return this.cloud.kioskSnapshot();
  }

  /** A kiosk row exists and is on (a kiosk by role, or a till's kiosk mode — at home or away). */
  hasKioskRow(): boolean {
    return rawFactsOf(this.cloud.kioskSnapshot()).kiosk;
  }

  /**
   * A kiosk to the rest of the app: the effective word. A kiosk by role in its till session still IS a kiosk row
   * (its orders, funnel, status and the dashboard's commands carry on); `isKioskMode` says whether its screens are
   * what the device shows. A till by role at home is not a kiosk.
   */
  isKiosk(): boolean {
    return this.snapshot()?.kiosk === true;
  }

  /** A kiosk by role working as a till today (its till session): the till rules apply, the kiosk's own Z and shift logic wait. */
  inTillSession(): boolean {
    return this.workSessions.till() !== null && this.isKiosk() && !rawFactsOf(this.cloud.kioskSnapshot()).homeTill;
  }

  /** The kiosk's screens are what this device shows (Android `isActive`): a kiosk, and not in its till session. */
  isKioskMode(): boolean {
    return this.isKiosk() && !this.inTillSession();
  }

  /** The kiosk side at the moment of a switch to the till (core/workMode.ts): a customer paying or ordering, a card at the terminal. */
  kioskSideFacts(): KioskSideFacts {
    const phase = this.payProgress?.phase;
    return kioskFactsOf({ flowState: this.flow.flowState, busy: this.flow.busy || phase === 'starting' || phase === 'charging' }, this.pay.cardInFlight);
  }

  /** The work mode's runtime, kept for the kiosk status and the admin (main/index.ts builds it after the role manager). */
  attachWorkMode(runtime: WorkModeRuntime | null) {
    this.workMode = runtime;
  }

  /** The mode (or what the screens show of it) changed: the view, and through it the role (main/roles/manager.ts). */
  workModeChanged() {
    this.dirty();
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

  /** "תפריטים": the block the view was built from, the menu it was built for, and the timer that looks at the clock at each minute. */
  private menuBlock: MenuBlock | null = null;
  private menuKey = '';
  private menuTimer: NodeJS.Timeout | null = null;

  /**
   * "תפריטים": the menu active now by the kiosk's OWN clock — offline too — looked at once per minute boundary (a handful of
   * comparisons, no call, no catalog read). The view is built again only when the answer changes: a menu starts, ends, or
   * yields to another (the Android kiosk's minute ticks, CatalogMenuRepository.minuteTicks).
   */
  private armMenuClock() {
    if (this.menuTimer) clearTimeout(this.menuTimer);
    this.menuTimer = null;
    if (this.stopped || !hasMenus(this.menuBlock)) return;
    this.menuTimer = setTimeout(() => {
      this.menuTimer = null;
      if (menuKeyAt(this.menuBlock, Date.now()) !== this.menuKey) this.dirty();
      else this.armMenuClock();
    }, msToNextMinute(Date.now()));
    this.menuTimer.unref?.();
  }

  private catalogData() {
    const now = Date.now();
    const catalog = this.cloud.catalog();
    this.saleChangeAt = catalogNextChangeMs(catalog.products, now);
    this.menuBlock = (catalog.catalogMenus as MenuBlock | null | undefined) ?? null;
    return buildKioskCatalog(catalog, this.settingsMap(), (url, size) => this.localMediaUrl(url, size), { stock: this.cloud.stockLevels(), nowMs: now });
  }

  /**
   * The till's catalog (the till role, main/till/engine.ts): what a till sells — not "קיוסק בלבד", the items that
   * need a manager's approval included and flagged — with each product's sale state decided by the shared rules
   * (lib/kioskSoldOut.ts) for the till to gate (blocked / sold out / out of stock).
   *
   * "תפריטים" (core/till/menus.ts): the menu active on the till's own clock `nowMs` (the machine's wall clock; the caller's, for a
   * test or a priced basket) is laid over it — a menu: only what it places, in its order, at its listed prices, each product
   * carrying the menu it is offered under; the fallback "לא למכור": nothing; none active / none assigned: as without menus.
   */
  tillCatalogData(nowMs: number = Date.now()) {
    const memo = this.tillCatalogMemo;
    // Which menu is active is a handful of comparisons, worked out at each call: the catalog is laid out again only when that
    // answer (a schedule boundary passed — offline too) or the block itself changes, never per call.
    const block = this.cloud.catalogMenus();
    const resolution = resolveTillMenu(block, new Date(nowMs));
    const menu = menuKey(resolution);
    // Built again when something it is made of moved, when a block ends by the clock alone, or when the menu switches.
    if (memo && memo.rev === this.catalogRev && memo.block === block && memo.menu === menu && (memo.until === null || nowMs < memo.until)) return memo.data;
    const catalog = this.cloud.catalog();
    const built = buildKioskCatalog(catalog, this.settingsMap(), (url, size) => this.localMediaUrl(url, size), { stock: this.cloud.stockLevels(), nowMs }, { channel: 'till' });
    const data = resolution.mode === 'catalog' ? built : { ...built, ...presentTillCatalog(built, block, resolution) };
    this.tillCatalogBuilds += 1;
    this.tillCatalogMemo = { rev: this.catalogRev, until: catalogNextChangeMs(catalog.products, nowMs), data, version: this.tillCatalogBuilds, menu, block };
    return data;
  }

  /** The till catalog's version: moves each time it is built again (the screens fetch it when it moves). */
  tillCatalogVersion(nowMs?: number): number {
    this.tillCatalogData(nowMs);
    return this.tillCatalogMemo?.version ?? 0;
  }

  /** Counts as offline now (the cloud silent, or no network). */
  get isOffline(): boolean {
    return this.offlineNow;
  }

  /** The basket priced for the till: the same engine as the kiosk's (priceBasket — choices, meals, promotions by the clock), from the till's catalog. */
  priceTillBasket(input: StartPaymentIn, now = new Date(), hooks?: TillLineHooks) {
    return this.priceBasket(input, now, 'till', hooks);
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
    const cat = phase === 'kiosk' ? this.catalogData() : { categories: [], products: [], menu: noMenuState(), held: [], groups: {}, meals: {}, quickNotes: {}, noteImages: {}, upsells: [], upsellRules: [] };
    // "תפריטים": the menu the screens were built for; the clock looks again at the next minute boundary. Only a view build
    // sets it — a basket priced in between does not hide a menu change from the screens.
    this.menuKey = `${cat.menu.mode}:${cat.menu.menuId ?? ''}`;
    if (phase === 'kiosk') this.armMenuClock();
    const categoryImages: Record<string, string> = {};
    if (cfg) for (const [id, ref] of Object.entries(cfg.catalog.categoryImages ?? {})) {
      const local = this.localMediaUrl(ref?.url ?? null, 'card');
      if (local) categoryImages[id] = local;
    }
    const paused = this.pausedState();
    const media = this.media.getStatus();
    const today = this.orders.todays();
    const pay = this.payView(phase === 'kiosk');
    // "חסימת הזמנות כשאין אינטרנט": the "offline" rest — always with `kioskOfflineBlockScope` = all, with
    // pay_at_till only when the till was all there was (core/offlineBlock.ts).
    const offlineRest = offlineRests(this.offlineBlocked(cfg), this.offlineScope(), pay.usable);
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
        // "ללא אשראי" is no terminal fault: the kiosk takes what it is set to besides the card (`pay.usable`).
        // A kiosk that takes cash at the station has a way to pay without a terminal (P:/specs/cash-paylink.md §11.6).
        noPayment: (!this.pay.configured && !this.pay.noCard && !pay.usable.includes('cash_device')) || offlineRest,
        noPaymentReason: offlineRest ? 'offline' : !this.pay.configured && !this.pay.noCard && !pay.usable.includes('cash_device') ? 'terminal' : null,
        terminal: this.pay.monitor.state,
        offline: this.offlineNow,
        offlineSince: this.offline.since,
        cardBlocked: this.pay.blocked(),
      },
      staff: {
        unprintedBons: today.filter((o) => o.bonStatus === 'failed' || o.bonStatus === 'queued').length,
        // "שובר פריט לא הודפס": as the bons', a red word in the corner — the reprint is the manager's, in the history.
        unprintedTickets: this.unprintedTicketsOf(today),
        printer: this.printQueue.health(),
        pendingUploads: this.outbox.count() + this.payAtTill.pending(),
        mediaMissing: media.missing,
      },
      pay,
      // "סניף לא פעיל" (client lib/shopActive.ts): the screens lock once the customer is done; the
      // lock offers the kiosk's own close of the day ("סגירת משמרת ו-Z", shopLockCloseDay).
      shopActive: this.cloud.shopActive(),
      closeDay: phase === 'kiosk' && this.fiscalRole ? kioskCloseDay({ zMode: zModeOf(this.cloud.heartbeat().zMode), shiftOpen: !!this.ledger.currentShift() }) : null,
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
          // "סוללה חלשה" (pos-server battery_alerts.py): the cloud tells the tills `alerts.battery` names
          // (by default none: "רק המכשיר עצמו" — this kiosk's own strip and alarm only).
          ...(this.batteryNow && this.batteryNow.percent !== null
            ? { batteryPercent: this.batteryNow.percent, batteryStatus: this.batteryNow.charging ? 'charging' : 'discharging' }
            : {}),
          ...(this.fiscalRole ? { offlineTillZ: { pending: 0, conflict: false, lastNumber, epoch: beat.tillZEpoch } } : {}),
          ...Object.fromEntries([...this.heartbeatParts].map(([key, part]) => [key, part()])),
          printer: {
            status: health === 'no_paper' ? 'no_paper' : health === 'ok' ? 'ok' : health === 'unknown' ? 'unknown' : health === 'unavailable' ? 'unavailable' : 'error',
            ...(failure ? { message: failure.error, at: new Date(failure.at).toISOString() } : {}),
            ...(this.printQueue.lastOkAt ? { lastPrintOkAt: new Date(this.printQueue.lastOkAt).toISOString() } : {}),
          },
        };
      },
      // Bridge mode: the browser page reports the kiosk's status (with this service's part, bridgePart).
      kioskStatus: () => this.kioskSyncStatus(),
      onKioskSnapshot: (next: Record<string, unknown>, prev: Record<string, unknown> | null) => {
        if (next.kiosk && next.configVersion !== prev?.configVersion) this.log(`kiosk config ${String(next.configVersion)}`);
        // "מצב עבודה": the sessions follow the cloud's word, and the dashboard's `enter_till` / `return_kiosk` is taken up.
        this.workMode?.onKioskReply(next, prev);
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
      // "סניף לא פעיל": the screens lock (once the customer is done) or are released at once.
      onShopActive: () => this.dirty(),
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
        // What the kiosk made is delivered whatever mode the device works in now (a kiosk row, not the effective
        // word): a till by role at home still sends the orders it took while away, a kiosk by role in its till
        // session the ones its customers placed before (Android syncNow: `if (next.kiosk)` on the cloud's own word).
        if (id && this.hasKioskRow()) await this.orders.push(this.api, id);
        // "ביצועי קיוסקים": the funnel's events, after the orders.
        if (id && this.hasKioskRow()) await this.funnel.push(this.api, id).catch(() => false);
        // "בונים": the printers' settings (ETag), the jobs handed over asked about; hosting for the others when named.
        if (id && this.fiscalRole) {
          await this.kitchen.afterBeat().catch((e) => this.log(`kitchen: ${String(e)}`));
          await this.kitchenHost.afterBeat().catch((e) => this.log(`kitchen host: ${String(e)}`));
        }
        // "מזומן בקופה": where the shop's LAN host is (for the offline days), then the open orders the cloud has not
        // taken — with what a LAN till did with them — and the vouchers to give back.
        if (id && this.hasKioskRow()) await this.pullLanHost().catch((e) => this.log(`LAN host: ${String(e)}`));
        if (id && this.hasKioskRow()) await this.payAtTill.flush().catch((e) => this.log(`pay at till: ${String(e)}`));
        // "מזומן" at the cash station: which station and its secret (ETag), and payments still to settle.
        if (id && this.isKiosk()) {
          await this.cashPay.pull().catch((e) => this.log(`cash: ${String(e)}`));
          if (!this.cashPay.inFlight && this.cashPay.pending().length > 0) await this.settleCash();
          // Cash credits taken for orders that were not paid: back on the credit.
          await this.cashCredits.flush().catch((e) => this.log(`cash credits: ${String(e)}`));
          if (!this.cashMag.inFlight && this.cashMag.journal().length > 0) await this.settleCashMag();
        }
      },
      sideRequest: (row: OutboxRow) => this.sideRequest(row),
      onRevoked: () => {
        this.log('machine token revoked: back to pairing');
        this.sync.stop();
        this.cloud.forget();
        this.workSessions.clear();
        this.dirty();
      },
      log: this.log,
    };
  }

  /**
   * What `kiosk/sync` reports: a kiosk row's status — a kiosk by role in either mode, a till by role from its kiosk-mode
   * row on (Android `if (_raw.value.kiosk) statusJson()`) — and, from a till by role that wants its first kiosk mode,
   * `requestKioskMode` (the cloud makes the row where the owner allowed it). A plain till reports nothing.
   */
  private kioskSyncStatus(): Record<string, unknown> | null {
    if (this.opts.bridge) return null;
    const asking = this.workMode?.kioskModeRequested() === true;
    const row = this.hasKioskRow();
    if (!row && !asking) return null;
    const status = row ? this.kioskStatus() : {};
    return asking ? { ...status, requestKioskMode: true } : status;
  }

  private kioskStatus(): Record<string, unknown> {
    // "מצב עבודה": `flowState: till_mode` + `tillMode` while it works as a till, the dashboard's commands done (`commandsDone`).
    const work = this.workMode?.statusFields() ?? {};
    const today = this.orders.todays();
    const media = this.media.getStatus();
    const alerts: Array<Record<string, unknown>> = [];
    const health = this.printQueue.health();
    if (health !== 'ok' && health !== 'unknown') alerts.push({ kind: 'printer', key: 'printer:receipt', reason: health === 'no_paper' ? 'no_paper' : health === 'offline' || health === 'unavailable' ? 'offline' : 'error' });
    const bonsFailed = today.filter((o) => o.bonStatus === 'failed').length;
    if (bonsFailed > 0) alerts.push({ kind: 'printer', key: 'printer:bon', reason: 'bon_failed', detail: { failed: bonsFailed } });
    // "ללא אשראי" (state no_card) raises neither: there is no terminal. A card left unresolved still does.
    if (this.pay.monitor.state === 'unreachable') alerts.push({ kind: 'terminal', key: 'terminal', reason: 'unreachable', detail: { address: this.pay.describe().address } });
    else if (this.pay.monitor.state === 'unconfigured') alerts.push({ kind: 'terminal', key: 'terminal', reason: 'not_configured' });
    if (this.pay.unresolved()) alerts.push({ kind: 'terminal', key: 'terminal:card', reason: 'card_unknown' });
    // "אין קשר לעמדת המזומן" (§11.15ג): its station silent on the LAN a minute — the cloud routes it as a cash alert.
    const cashSilent = this.cashMag.enabled() ? this.cashMag.unreachableAlert() : this.cashPay.unreachableAlert();
    if (cashSilent) alerts.push(cashSilent);
    const help = this.kv.getJson<{ requestId: string; at: number; screen: string }>(HELP);
    if (help && Date.now() - help.at < 10 * 60_000) alerts.push({ kind: 'help', key: 'help', reason: 'help', requestId: help.requestId, detail: { screen: help.screen } });
    return {
      flowState: work.flowState ?? this.flow.flowState,
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
      ...(this.opts.displayInfo ? { display: this.opts.displayInfo() ?? undefined } : {}),
      ...(work.tillMode ? { tillMode: work.tillMode } : {}),
      ...(work.commandsDone ? { commandsDone: work.commandsDone } : {}),
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
        // "ללא אשראי" reads as no terminal ("none"); the cloud shows it as such (kiosk_health `no_card`).
        state:
          terminal.state === 'unconfigured'
            ? 'not_configured'
            : terminal.state === 'not_external' || terminal.state === 'no_card'
              ? 'none'
              : terminal.state,
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
    // "ניטור סוללה" off for this device: no strip, no alarm; a cycle that was open ends quietly.
    if (!batteryMonitoredParam(params.batteryMonitoring)) {
      if (kept.cycle.open) this.kv.setJson('battery.cycle', { cycle: NO_CYCLE, seq: kept.seq });
      return { level: null, percent, charging, critical: false, alarmSeq: kept.seq, sound: false };
    }
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
    const byId = new Map<string, KProduct>([...cat.products, ...cat.held].map((p) => [p.id, p]));
    // The base price each line remembers, without any menu: the cloud's word is about the catalog's price the customer saw
    // (KioskPriceCheck.request: `line.product.basePrice`); the catalog held now only stands in for a line of an older screen.
    const body = cloudCheckRequest(input.lines, (pid) => {
      const p = byId.get(pid);
      return p ? basePriceOf(p) : undefined;
    }, this.cloud.promotionsEtag());
    const reply = await this.api.post<CloudVerdict>(`sync/${id}/kiosk/basket-check`, body, { timeoutMs: CLOUD_CHECK_TIMEOUT_MS });
    if (reply.kind !== 'ok' || !reply.body || !Array.isArray(reply.body.lines)) return;
    const o = overridesOf(reply.body, Date.now());
    this.cloudBasket = o.gone.size > 0 || o.prices.size > 0 ? o : null;
    if (!reply.body.ok) void this.sync.pullCatalog(false).then(() => this.dirty()).catch(() => undefined);
    if (reply.body.promotions?.changed) await within(this.sync.pullPromotions(), PROMOTIONS_PULL_TIMEOUT_MS);
  }

  /** Side rows a module sends itself (the till's drawer audit and cash movements, main/till/drawerService.ts). */
  private readonly sideRequesters = new Map<OutboxKind, (row: OutboxRow) => { path: string; body: unknown } | null>();

  /** A module's own side kind: its request for each row (null drops the row). */
  registerSideKind(kind: OutboxKind, request: (row: OutboxRow) => { path: string; body: unknown } | null): void {
    this.sideRequesters.set(kind, request);
  }

  private sideRequest(row: OutboxRow): { path: string; body: unknown } | null {
    const own = this.sideRequesters.get(row.kind);
    if (own) return own(row);
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
      const e = this.kv.getJson<TillEventRecord>(`tillEvent:${row.ref_id}`);
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
    // The kiosk row's own word: a till by role keeps its kiosk mode's media ready while at home (Android syncMedia on `next.kiosk`).
    const snap = this.rawKioskSnapshot();
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
  async settleOrphans() {
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
    // A split sale's card settled (§11.15ב): the cash station told — its part paid with the document, or held (voided).
    if (this.cashPay.pending().length > 0 && !this.cashPay.inFlight) await this.settleCash();
    this.dirty();
  }

  /** Re-price the basket from the local catalog (the screens' prices are never trusted). */
  /**
   * The basket priced from the kiosk's own catalog with the shared money rules (client/src/lib/kioskMoney.ts,
   * the Android till's, ported once): each choice charged as its group says (free choices, quantities,
   * "הרבה"), a meal's components on their defaults with their upcharges, then the promotions — each
   * line's share is the document's discount. The screen's figures are only compared, never trusted.
   */
  private priceBasket(
    input: StartPaymentIn,
    now = new Date(),
    channel: 'kiosk' | 'till' = 'kiosk',
    hooks?: TillLineHooks,
  ): { lines: SaleLine[]; changes: BasketChange[]; tracked: string[]; promotions: AppliedPromotionRow[]; voucherOutcomes: VoucherOutcome[] } {
    // The till's catalog is the one in force at `now` — its menu ("תפריטים") included, so the price is the menu's while it is active.
    const cat = channel === 'till' ? this.tillCatalogData(now.getTime()) : this.catalogData();
    const byId = new Map<string, KProduct>(cat.products.map((p) => [p.id, p]));
    // "תפריטים" (docs/SPEC_MENUS.md §5.1): what the active menu does not place is held, not gone — a line added under a menu
    // stays across a switch only while its product is still sold here: the kiosk's own catalog rules (`held` / `products`:
    // channel, manager's code, category, delisting, the products no kiosk sells), its hidden-product settings, blocks and
    // "אזל", and the cloud's word all win. The Android kiosk's KioskBasketLookup is the same rule; pinned in test/kioskMenus.test.ts.
    const heldById = new Map<string, KProduct>(cat.held.map((p) => [p.id, p]));
    const block = this.menuBlock;
    const menuPrices = menuPriceSets(block);
    const lines: SaleLine[] = [];
    const changes: BasketChange[] = [];
    const tracked = new Set<string>();
    // What the cloud said a moment ago wins over a catalog that has not caught up yet.
    // A till's basket is gated at the door (the engine's sold-out / blocked rules, with a manager's approval): pricing keeps
    // what is in it, and the cloud's word of a moment ago is the kiosk's.
    const cloud = channel === 'till' ? null : overridesLive(this.cloudBasket, Date.now());
    // A dish: on the kiosk's screens now — through its own settings: hidden products and categories included — or, only for a
    // line added under a menu, held and shown by the same rules (client lib/kioskBasketSold.ts, the Android kiosk's
    // KioskBasketLookup). A meal's component: found even when no screen shows it (hidden, not placed), but never blocked,
    // sold out or gone. The till: what its catalog sells now.
    const lookup: Pick<BasketSold<KProduct>, 'dish' | 'component'> =
      channel === 'till'
        ? { dish: (id) => byId.get(id) ?? null, component: (id) => byId.get(id) ?? null }
        : basketSold({ products: cat.products, categories: cat.categories, held: cat.held, cfg: this.config(), gone: cloud?.gone });
    for (const l of input.lines) {
      const p = lookup.dish(l.productId, !!l.menuId);
      // A meal whose chosen component is no longer sold goes as a whole: the customer chooses again.
      const parts = l.meal?.components ?? [];
      const slots = cat.meals[l.productId] ?? [];
      const brokenMeal = parts.some((c) => {
        const slot = slots.find((s) => s.id === c.slotId);
        return !slot || !slot.choices.some((x) => x.productId === c.productId) || !lookup.component(c.productId);
      });
      if (!p || brokenMeal) {
        changes.push({ kind: 'removed', productId: l.productId, name: (byId.get(l.productId) ?? heldById.get(l.productId))?.name ?? '', key: l.key });
        continue;
      }
      // The dish's own price: as the line was added while the catalog's price has not moved (a menu switching under the basket is
      // no price change), else what the kiosk sells it at now; the cloud's word moves a catalog-priced dish only.
      const kept = channel === 'till' ? (hooks?.listPrice?.(l.key) ?? null) : null;
      const own = kept ?? keptListPrice({ listAgorot: l.listAgorot, catalogAgorot: l.catalogAgorot }, pricesNow(p, cloud?.prices.get(p.id)), channel === 'till' ? undefined : menuPrices.get(p.id));
      // The menu the line says it was added under: only one this kiosk's block holds is recorded on the document.
      // (A till's lines carry the till's own menu facts — lineMenuFacts — never the kiosk's.)
      const under = channel === 'kiosk' && l.menuId ? menuById(block, l.menuId) : null;
      const options = this.chargedOptions(cat.groups[p.id] ?? [], l.options);
      const components = parts.map((c) => {
        const slot = slots.find((s) => s.id === c.slotId)!;
        const cp = (byId.get(c.productId) ?? heldById.get(c.productId))!;
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
          listPriceAgorot: pricesNow(cp, cloud?.prices.get(cp.id)).listAgorot,
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
        basePriceAgorot: own,
        options,
        notes: l.notes.filter((n) => n.trim()),
        qty: Math.min(MAX_LINE_QTY, Math.max(1, Math.trunc(l.qty))),
        meal: components.length > 0 ? { productId: p.id, name: p.name, components } : null,
        categoryId: p.categoryId,
        noDiscount: p.noDiscount,
        ...(under
          ? {
              menuId: l.menuId,
              menuName: typeof under.name === 'string' ? under.name : null,
              priceSource: l.priceSource === 'menu' ? ('menu' as const) : ('catalog' as const),
              catalogPriceAgorot: pricesNow(p, cloud?.prices.get(p.id)).catalogAgorot,
            }
          : {}),
        // "תפריטים" on the till: the menu this line was priced under and where its price came from; none with no menu active.
        ...(channel === 'till' ? lineMenuFacts(p) : null),
      });
    }
    // A price that moved since the screen showed it: shown to the customer, never charged as is.
    const priced = new Map(lines.map((x) => [x.key, { name: x.name, unitAgorot: unitAgorot(x) }] as const));
    for (const c of basketChanges(input.lines.filter((l) => priced.has(l.key)), priced)) if (c.kind === 'repriced') changes.push(c);
    // "מבצעים": the promotions on this basket now, by the kiosk's clock (KioskViewModel.price) — then the discount
    // vouchers held for the order ("שוברי הנחה"), in the order applied (`withPromotions(...).withVoucherDiscounts()`).
    // A till's line by hand (core/till/discounts.ts): an OTH line is not counted by promotions at all; a hand-discounted one
    // is never discounted by one and counts towards a threshold at what it costs after it (Promotions.kt basketOf).
    const hands = new Map(lines.map((x) => [x.key, hooks?.promo?.(x.key, unitAgorot(x) * x.qty) ?? null] as const));
    const promo = priceKioskBasket(
      lines
        .filter((x) => hands.get(x.key)?.exclude !== true)
        .map((x) => ({ id: x.key, productIds: [x.productId], categoryId: x.categoryId ?? null, unitAgorot: unitAgorot(x), qty: x.qty, noDiscount: x.noDiscount === true, handDiscountAgorot: hands.get(x.key)?.handDiscountAgorot ?? 0 })),
      promotionsOf(this.cloud.promotions()),
      localDateTimeOf(now),
      input.vouchers?.discounts ?? [],
    );
    const shares = new Map(promo.lines.map((x) => [x.id, x] as const));
    for (const x of lines) {
      const share = shares.get(x.key);
      if (share && share.promotionAgorot > 0) {
        x.promotionAgorot = share.promotionAgorot;
        x.promotionId = share.promotionId;
        x.promotionName = share.promotionName;
      }
      if (share && share.voucherAgorot > 0) x.voucherAgorot = share.voucherAgorot;
      if (share && share.promotionYieldedAgorot > 0) x.promotionYieldedAgorot = share.promotionYieldedAgorot;
    }
    const promotions = promo.applied.map((a) => ({ promotionId: a.promotionId, name: a.name, type: a.type, applications: a.applications, discountAgorot: a.discountAgorot }));
    return { lines, changes, tracked: [...tracked], promotions, voucherOutcomes: promo.voucherOutcomes };
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
    if (!this.newSaleAllowed()) return { ok: false, reason: 'error', message: SHOP_LOCK_TEXT.title };
    if (this.pay.cardInFlight || this.cashPay.inFlight || this.cashMag.inFlight) return { ok: false, reason: 'busy', message: 'תשלום כבר בתהליך' };
    const byCash = input.method === 'cash_device';
    // The vouchers of the order (goods ones as legs, discount ones held for it), read field by field: the
    // browser kiosk's bridge sends them over HTTP.
    const vouchers = input.vouchers === undefined ? null : startVouchersOf(input.vouchers);
    if (input.vouchers !== undefined && !vouchers) return { ok: false, reason: 'error', message: 'השוברים של ההזמנה אינם תקינים' };
    // Cash credits ("זיכוי להזמנה הבאה", §11.15א) taken for the order: legs towards the goods, like the goods vouchers.
    const credits = creditLegsOf(input.credits);
    if (!credits) return { ok: false, reason: 'error', message: 'הזיכויים של ההזמנה אינם תקינים' };
    const withVouchers = (!!vouchers && vouchers.legs.length + vouchers.discounts.length > 0) || credits.length > 0;
    const terminalRefusal = (): StartPaymentOut | null => {
      // "מזומן" at the cash station: the station must be there (its own refusal); the card's terminal is not asked.
      if (byCash && this.cashMag.enabled()) {
        // CashMag: configured, nothing left for the staff; the server itself is asked when the payment starts.
        const refused = this.cashMag.refusal();
        return refused ? { ok: false, reason: 'terminal', message: refused } : null;
      }
      if (byCash) return this.cashPay.configured() ? null : { ok: false, reason: 'terminal', message: this.cashPay.offReason() ?? 'מכשיר המזומן לא זמין' };
      // No terminal set up: refused. One whose last check did not answer is tried now — its error said if it fails.
      if (!this.pay.configured) return { ok: false, reason: 'terminal', message: 'לא הוגדר מסופון אשראי לקיוסק. אנא פנו לצוות.' };
      if (this.pay.blocked()) return { ok: false, reason: 'unresolved', message: 'תשלום קודם ממתין לבירור. אנא פנו לצוות.' };
      return null;
    };
    // The card is asked for what the vouchers do not pay: with none on the order, before anything else (as always);
    // with some, once the order is priced — a sale they pay whole touches no terminal.
    if (!withVouchers) {
      const refused = terminalRefusal();
      if (refused) return refused;
    }
    // The cloud's word first, when it answers in time (core/basketCheck.ts).
    await this.cloudBasketCheck(input).catch(() => undefined);
    const { lines, changes, tracked, promotions, voucherOutcomes } = this.priceBasket({ ...input, vouchers: vouchers ?? undefined });
    const nowTotal = saleTotals(lines, this.vatRate()).totalAgorot;
    if (changes.length > 0) return { ok: false, reason: 'changed', changes, totalAgorot: nowTotal };
    // The total the customer saw (after the promotions and the discount vouchers): never a different one charged.
    const shownTotal = input.expectedTotalAgorot;
    if (typeof shownTotal === 'number' && Number.isFinite(shownTotal) && Math.round(shownTotal) !== nowTotal) {
      return { ok: false, reason: 'changed', changes: [], totalAgorot: nowTotal };
    }
    if (lines.length === 0) return { ok: false, reason: 'empty', message: 'הסל ריק' };
    const cfg = this.config();
    const operator = this.operator();
    const goods = saleTotals(lines, this.vatRate()).totalAgorot;
    const tip = tipToCharge(cfg.payment, goods, input.tipPct, input.tipAgorot);
    // The goods vouchers' legs, worked out again from the basket as it stands now (CheckoutViewModel.applyVoucher): the
    // card pays the rest of the goods and the tip; the vouchers never pay the tip.
    const { legs, marks } = this.legsOf(lines, vouchers?.legs ?? []);
    // "כלול בשובר #N": each line a goods voucher paid for carries its mark on the document (coverByVoucher).
    for (const l of lines) {
      const mark = marks.get(l.key);
      if (mark) l.voucherMark = mark;
    }
    const totals = saleTotals(lines, this.vatRate(), tip);
    const afterVouchers = Math.max(0, goods - legs.reduce((s, l) => s + l.amountAgorot, 0));
    const creditSum = credits.reduce((s, c) => s + c.amountAgorot, 0);
    if (creditSum > afterVouchers) return { ok: false, reason: 'error', message: 'הזיכויים עולים על ההזמנה' };
    const principal = afterVouchers - creditSum;
    const chargeAgorot = principal + tip;
    if (goods + tip < 1) return { ok: false, reason: 'empty', message: 'אין מה לחייב' };
    if (withVouchers && chargeAgorot > 0) {
      const refused = terminalRefusal();
      if (refused) return refused;
    }
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
      voucherDiscounts: docVoucherDiscounts(voucherOutcomes),
      // A discount voucher that took nothing off this basket (it fell under its minimum): held, and given back once the sale is written.
      voucherReleases: voucherOutcomes.filter((o) => o.amountAgorot <= 0).map((o) => o.voucher.reservationId),
      voucherLegs: legs,
      creditLegs: credits,
    });
    if (!doc) return { ok: false, reason: 'no_shift', message: 'אין משמרת פתוחה' };
    this.orders.update(order.localId, (o) => ({ ...o, transactionId: doc.id }));
    if (chargeAgorot < 1) {
      // The vouchers paid it all: the document is complete at once, with their legs and no card (the till's confirmCash with legs).
      const done = this.ledger.completeCardSale(doc.id, null);
      if (!done) return { ok: false, reason: 'error', message: 'המסמך לא נשמר' };
      void this.afterApproval(order.localId, done, false);
      return { ok: true, orderId: order.localId, amountAgorot: 0 };
    }
    if (byCash && this.cashMag.enabled()) {
      this.progress({ orderId: order.localId, phase: 'starting', message: 'מתחבר למכשיר המזומן…', amountAgorot: chargeAgorot, canCancel: true, cancelling: false, cash: this.cashMagView(null, chargeAgorot) });
      void this.runCashMag(order.localId, doc, chargeAgorot);
      return { ok: true, orderId: order.localId, amountAgorot: chargeAgorot };
    }
    if (byCash) {
      this.progress({ orderId: order.localId, phase: 'starting', message: 'מתחבר למכשיר המזומן…', amountAgorot: chargeAgorot, canCancel: true, cancelling: false, cash: this.cashView(null, chargeAgorot, 'connecting') });
      void this.runCash(order.localId, doc, chargeAgorot);
      return { ok: true, orderId: order.localId, amountAgorot: chargeAgorot };
    }
    this.progress({ orderId: order.localId, phase: 'starting', message: null, amountAgorot: chargeAgorot, canCancel: true, cancelling: false });
    void this.runCharge(order.localId, doc, chargeAgorot, tip);
    return { ok: true, orderId: order.localId, amountAgorot: chargeAgorot };
  }

  /**
   * The goods vouchers' legs as this basket pays them: each voucher worth what it covers of the lines as they stand now
   * (the promotions' and the discount vouchers' shares out), in the order taken, never more than the goods still owed —
   * what the Android payment works out again at its start (CheckoutViewModel.applyVoucher). A voucher that covers
   * nothing any more goes back on itself.
   */
  private legsOf(lines: SaleLine[], taken: readonly VoucherLeg[]): { legs: DocVoucherLeg[]; marks: Map<string, string> } {
    if (taken.length === 0) return { legs: [], marks: new Map() };
    const basket = this.webLines(lines);
    const done = recountLegs(basket, taken);
    for (const v of done) if (v.amountAgorot <= 0) void this.payAtTill.reverse(v.redemptionId);
    const paid = done.filter((v) => v.amountAgorot > 0);
    return {
      legs: paid.map((v) => ({ redemptionId: v.redemptionId, serial: v.serial, amountAgorot: v.amountAgorot })),
      marks: legMarks(basket, paid),
    };
  }

  /**
   * The sale was written: its discount vouchers confirmed (their uses taken) — or given back when the basket
   * ended up taking nothing off by them —, its goods vouchers linked to its document. Best effort, retried; the
   * document itself confirms the vouchers in the cloud as well, through the outbox, if this never lands.
   */
  private settleVouchers(doc: DocDraft): void {
    const discounts = doc.voucherDiscounts ?? [];
    const releases = doc.voucherReleases ?? [];
    const legs = doc.voucherLegs ?? [];
    if (discounts.length + releases.length + legs.length === 0) return;
    void this.payAtTill.settle(doc.id, discounts, releases, legs).catch((e: unknown) => this.log(`vouchers of ${doc.id}: ${e instanceof Error ? e.message : String(e)}`));
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

  /* ------------------------------------------------ "מזומן" at the cash station (§11.6) */

  private cashView(tx: CashProgress['tx'], amountAgorot: number, stage: NonNullable<PayProgress['cash']>['stage'], position: number | null = null): NonNullable<PayProgress['cash']> {
    return {
      stage,
      position,
      stationName: this.cashPay.station()?.name ?? null,
      insertedAgorot: tx?.insertedAgorot ?? 0,
      dueAgorot: tx?.dueAgorot ?? amountAgorot,
      changeAgorot: tx?.changePaidAgorot ?? 0,
      changeOwedAgorot: tx?.changeOwedAgorot ?? 0,
      exactOnly: tx?.exactOnly ?? false,
      escrowAgorot: tx?.escrowAgorot ?? 0,
      accepts: tx ? tx.accepting : null,
      slipCode: tx?.slipCode ?? null,
      txShort: tx ? shortTx(tx.txId) : null,
    };
  }

  /** The cash leg of a paid transaction (the document's, §11.7; a split's cash part, §11.15ב). */
  private cashLegOf(tx: NonNullable<CashProgress['tx']>, changeOwedAs: OwedChoice | null = null): DocCashLeg {
    return {
      txId: tx.txId,
      stationId: tx.stationId,
      hostId: tx.hostId,
      receivedAgorot: tx.insertedAgorot,
      changeAgorot: tx.changePaidAgorot,
      changeOwedAgorot: tx.changeOwedAgorot,
      roundingAgorot: tx.roundingAgorot,
      slipCode: tx.slipCode,
      ...(changeOwedAs ? { changeOwedAs } : {}),
      ...((tx.splitAgorot ?? 0) > 0 ? { splitAgorot: tx.splitAgorot } : {}),
    };
  }

  /** "להשלים באשראי" may be offered (§11.15ב): the kiosk's parameter, a terminal that can charge, something in, the goods not yet. */
  private splitOffered(doc: DocDraft, tx: TxView | null): boolean {
    if (!tx || tx.state !== 'ACCEPTING' || tx.insertedAgorot <= 0) return false;
    if (!this.cashPay.settings().splitWithCard || !this.pay.configured || this.pay.noCard || this.pay.blocked()) return false;
    return tx.insertedAgorot < cardPrincipalAgorot(doc);
  }

  /** "חסר עודף במכשיר" (§11.15א): what the customer may choose — a slip always, a credit online, a tip where tips are on. */
  private owedChoices(tx?: TxView): OwedChoice[] {
    // A credit online only: the cloud keeps it — from the station's journal, or (CashMag, P:/specs/cashmag-windows.md §6)
    // from this document's cash leg (`changeOwedAs` "credit") once it reaches the cloud, while `cashmagOwedCredit` is on
    // (the Android till reads the same key).
    const credit = this.cloudOnline() && (tx?.hostId !== CASHMAG_HOST_ID || this.cashMag.config().owedCredit);
    return OWED_CHOICES.filter((c) => c === 'slip' || (c === 'credit' && credit) || (c === 'tip' && this.config().payment.tipEnabled === true));
  }

  /** The cash settings of the device paying now: CashMag reads the till parameters themselves (`cashOwedChoiceSec`, `cashReceiptLines`). */
  private cashSettings(): CashSettings {
    return this.cashMag.enabled() ? cashSettingsOf(this.cloud.parameters()) : this.cashPay.settings();
  }

  private cashStationName(): string | null {
    return this.cashMag.enabled() ? CASHMAG_STATION_NAME : (this.cashPay.station()?.name ?? null);
  }

  /** The cash device's tile may be offered: CashMag's when the cloud turned it on, else the cash station's. */
  private cashDeviceUsable(): boolean {
    return this.cashMag.enabled() ? this.cashMag.usable() : this.cashPay.usable();
  }

  /** The device's acknowledgement once the document is written (or the failure handled): CashMag's or the station's. */
  private async cashAck(tx: TxView, documentId: string | null, documentNumber: string | null, orderLabel: string | null = null, extra: { changeOwedAs?: OwedChoice | null; void?: boolean } = {}): Promise<boolean> {
    if (tx.hostId === CASHMAG_HOST_ID) return this.cashMag.ack(tx.txId, documentId);
    return this.cashPay.ack(tx.txId, documentId, documentNumber, orderLabel, extra);
  }

  /** The pay screen asks what to do with the change owed; a slip when nobody chooses in `cashOwedChoiceSec`. */
  private askOwedChoice(orderId: string, tx: TxView, amount: number): Promise<OwedChoice> {
    const choices = this.owedChoices(tx);
    const cur = this.payProgress;
    if (choices.length < 2 || !cur || cur.orderId !== orderId) return Promise.resolve('slip');
    const ms = this.cashSettings().owedChoiceSec * 1000;
    return new Promise<OwedChoice>((resolve) => {
      let timer: NodeJS.Timeout | null = null;
      const done = (c: OwedChoice) => {
        if (timer) clearTimeout(timer);
        if (this.owedChoiceWait?.resolve === done) this.owedChoiceWait = null;
        resolve(c);
      };
      timer = setTimeout(() => done('slip'), ms);
      this.owedChoiceWait = { resolve: done, choices };
      this.progress({
        ...cur,
        phase: 'charging',
        message: `חסר עודף במכשיר: ${shekelText(tx.changeOwedAgorot)}`,
        canCancel: false,
        cancelling: false,
        cash: { ...this.cashView(tx, amount, 'owed_choice'), ...(tx.hostId === CASHMAG_HOST_ID ? { device: 'cashmag' as const, stationName: CASHMAG_STATION_NAME } : {}), owedChoices: choices, owedDeadlineAt: Date.now() + ms },
      });
    });
  }

  /** The customer's choice on "חסר עודף" (the screen's button). */
  async cashOwedChoice(raw: unknown): Promise<void> {
    const w = this.owedChoiceWait;
    if (!w || typeof raw !== 'string' || !(w.choices as string[]).includes(raw)) return;
    w.resolve(raw as OwedChoice);
  }

  /** "להשלים באשראי" (the screen's button, §11.15ב): the station is asked for its part so far. */
  async cashSplit(): Promise<{ ok: boolean; message?: string }> {
    const p = this.payProgress;
    if (!p?.cash?.canSplit) return { ok: false, message: 'אי אפשר להשלים באשראי כעת' };
    if (!this.cashPay.requestSplit()) return { ok: false, message: 'אין תשלום מזומן פעיל' };
    this.progress({ ...p, canCancel: false, message: 'רגע…', cash: { ...p.cash, canSplit: false, stage: 'settling' } });
    return { ok: true };
  }

  /** A cash credit taken for this order (§11.15א): the screen holds it as a leg and sends it with the payment. */
  async redeemCashCredit(input: unknown): Promise<CashCreditResult> {
    if (!this.fiscalRole || !this.isKiosk()) return { ok: false, error: 'המכשיר אינו קיוסק פעיל' };
    return this.cashCredits.redeem(input);
  }

  async releaseCashCredit(redemptionId: string): Promise<void> {
    this.cashCredits.release(redemptionId);
  }

  /**
   * The station holds the cash part (PARTIAL, §11.15ב): kept on the pending document, the card charged for the rest
   * and the tip. Its word decides the cash part: approved / unknown → `finish` (kept; an unknown card decides the
   * document later), declined / refused → `cancel` (all of it back at the station).
   */
  private async chargeRest(orderId: string, doc: DocDraft, amountAgorot: number, tx: TxView): Promise<'finish' | 'cancel'> {
    const rest = Math.max(0, amountAgorot - tx.splitAgorot);
    this.ledger.attachCashPart(doc.id, { ...this.cashLegOf(tx), changeAgorot: 0, roundingAgorot: 0, splitAgorot: tx.splitAgorot });
    const view = { ...this.cashView(tx, amountAgorot, 'split_card'), splitAgorot: tx.splitAgorot, cardRestAgorot: rest };
    const say = (message: string | null, phase: PayPhase, canCancel: boolean) => {
      const cur = this.payProgress;
      if (cur && cur.orderId === orderId) this.progress({ ...cur, phase, message, canCancel, cancelling: false, cash: view });
    };
    const headline = `שולם במזומן ${shekelText(tx.splitAgorot)} · השלימו ${shekelText(rest)} באשראי`;
    say(headline, 'charging', true);
    const outcome = await this.pay.charge({
      transactionId: doc.id,
      orderId,
      amountAgorot: rest,
      tipAgorot: doc.totals.tipAgorot,
      onSent: () => say(headline, 'charging', true),
      onProgress: (message) => say(message ?? headline, 'charging', true),
    });
    if (outcome.kind === 'approved') {
      this.splitCards.set(doc.id, { kind: 'approved', card: outcome.card });
      return 'finish';
    }
    if (outcome.kind === 'unknown') {
      this.splitCards.set(doc.id, { kind: 'unknown', message: outcome.message });
      return 'finish';
    }
    if (outcome.kind === 'declined') this.pay.forgetAttempt(this.lastReferenceOf(doc.id) ?? '');
    this.splitCards.set(doc.id, {
      kind: 'declined',
      message: outcome.kind === 'declined' ? outcome.message : 'מסופון האשראי לא זמין כרגע.',
      voidMeta: outcome.kind === 'declined' ? (outcome.voidMeta as Record<string, unknown> | null) : null,
    });
    say('האשראי לא אושר — מחזיר את המזומן…', 'charging', false);
    return 'cancel';
  }

  /** A cash slip ("עודף חייב" / "זיכוי להזמנה הבאה" / the fault slip) on the receipt printer. */
  private printCashSlip(kind: 'change_owed' | 'credit' | 'fault', orderId: string, amountAgorot: number, slipCode: string | null, txId: string) {
    const o = this.orders.get(orderId);
    this.printQueue.enqueue(
      'slip',
      orderId,
      cashSlipDoc({
        kind,
        businessName: this.business().companyName,
        amountAgorot,
        orderLabel: o?.pickupLabel ?? null,
        slipCode,
        txShort: shortTx(txId),
        stationName: this.cashStationName(),
        at: new Date(),
      }),
    );
  }

  /** The payment at the cash station, to its end: the document on DONE+paid only, never twice for one transaction. */
  private async runCash(orderId: string, doc: DocDraft, amountAgorot: number) {
    let outcome: CashOutcome;
    try {
      outcome = await this.cashPay.pay({ orderId, docId: doc.id, amountAgorot, orderLabel: this.orders.get(orderId)?.pickupLabel ?? null }, (p) => {
        const cur = this.payProgress;
        if (!cur || cur.orderId !== orderId) return;
        const insertPhase = p.stage === 'insert' || p.stage === 'settling' || p.stage === 'change' || p.stage === 'refunding';
        if (p.stage === 'split_card') return; // the card's own progress (chargeRest)
        this.progress({
          ...cur,
          phase: insertPhase ? 'charging' : 'starting',
          message: p.message,
          canCancel: p.stage === 'connecting' || p.stage === 'queued' || (p.stage === 'insert' && (p.tx?.remainingAgorot ?? 1) > 0),
          cash: (() => {
            const canSplit = p.stage === 'insert' && this.splitOffered(doc, p.tx);
            return {
              ...this.cashView(p.tx, amountAgorot, p.stage, p.position),
              canSplit,
              ...(canSplit ? { splitRestAgorot: amountAgorot - (p.tx?.insertedAgorot ?? 0) } : {}),
              ...(p.stage === 'queued' ? { longWait: p.longWait === true } : {}),
            };
          })(),
        });
      }, { partial: (tx) => this.chargeRest(orderId, doc, amountAgorot, tx) });
    } catch (e) {
      this.log(`cash payment: ${e instanceof Error ? e.message : String(e)}`);
      outcome = { kind: 'lost', txId: this.cashPay.pending().find((x) => x.docId === doc.id)?.txId ?? '', insertedAgorot: 0 };
    }
    await this.applyCashOutcome(orderId, doc.id, outcome, false);
  }

  /* ------------------------------------------------ "מזומן" at a CashMag machine (P:/specs/cashmag-windows.md) */

  /** The pay screen's cash look for a CashMag payment ("הכנס מזומן", the busy wait, the server's question). */
  private cashMagView(p: CashMagProgress | null, amountAgorot: number): NonNullable<PayProgress['cash']> {
    return {
      stage: p?.stage ?? 'connecting',
      device: 'cashmag',
      position: null,
      stationName: CASHMAG_STATION_NAME,
      insertedAgorot: p?.insertedAgorot ?? 0,
      dueAgorot: p?.dueAgorot ?? amountAgorot,
      changeAgorot: 0,
      changeOwedAgorot: 0,
      exactOnly: false,
      escrowAgorot: 0,
      accepts: null,
      slipCode: null,
      txShort: null,
      question: p?.question ?? null,
      canSplit: false,
    };
  }

  /** The payment at the CashMag machine, to its end: the document on a plain "paid" only (kiosk/cashmagPay.ts). */
  private async runCashMag(orderId: string, doc: DocDraft, amountAgorot: number) {
    let outcome: CashOutcome;
    try {
      outcome = await this.cashMag.pay({ orderId, docId: doc.id, amountAgorot }, (p) => {
        const cur = this.payProgress;
        if (!cur || cur.orderId !== orderId) return;
        const waiting = p.stage === 'connecting' || p.stage === 'busy';
        this.progress({ ...cur, phase: waiting ? 'starting' : 'charging', message: p.message, canCancel: p.canCancel && !cur.cancelling, cash: this.cashMagView(p, amountAgorot) });
      });
    } catch (e) {
      // Never "nothing happened" on a guess: journaled → the staff's (no document); never journaled → nothing was sent.
      this.log(`cashmag payment: ${e instanceof Error ? e.message : String(e)}`);
      const entry = this.cashMag.journal().find((x) => x.docId === doc.id);
      outcome = entry ? { kind: 'held', tx: cashmagTxView(entry, { state: 'HELD', outcome: null, inserted: 0, held: 0, message: CASHMAG_ERRORS.EXCEPTION }) } : { kind: 'refunded', tx: null, message: 'מכשיר המזומן לא זמין' };
    }
    await this.applyCashOutcome(orderId, doc.id, outcome, false);
  }

  /**
   * What a restart (or a fault) left at CashMag: answered paid → the document now (no paper: the customer is gone);
   * sent and never answered → the staff's, the document voided — never one without a clear answer.
   */
  async settleCashMag(): Promise<void> {
    await this.cashMag.settle({
      // A sale a till credited since is still a paid one here.
      docStatus: (id) => {
        const s = this.ledger.doc(id)?.status ?? null;
        return s === 'refunded' || s === 'partial_refund' ? 'completed' : s;
      },
      writePaid: async (e: CashMagEntry, tx: TxView) => {
        const done = this.ledger.completeCashSale(e.docId, this.cashLegOf(tx, tx.changeOwedAgorot > 0 ? 'slip' : null));
        if (!done || done.status !== 'completed') return false;
        this.log(`cashmag tx ${e.txId.slice(0, 8)}: paid before the restart — its document written now`);
        await this.afterApproval(e.orderId, done, true);
        void this.sync.flush();
        return true;
      },
      voidDoc: (e: CashMagEntry, outcome: string) => {
        this.ledger.voidCardSale(e.docId, { cashTxId: e.txId, device: 'cashmag', outcome });
        void this.sync.flush();
      },
      // The pay screen still finishing it (the change-owed choice): its own path writes the document.
      live: (e: CashMagEntry) => this.payProgress?.orderId === e.orderId && (this.payProgress.phase === 'starting' || this.payProgress.phase === 'charging'),
    });
    this.dirty();
  }

  /** CashMag's question on the pay screen: the customer's answer (dialogValid / dialogCancel). */
  async cashQuestion(raw: unknown): Promise<void> {
    if (typeof raw !== 'boolean') return;
    await this.cashMag.answerQuestion(raw);
  }

  /** What the station's word means for the order and its document (a live payment, or a recovery). */
  private async applyCashOutcome(orderId: string, docId: string, outcome: CashOutcome, recovered: boolean) {
    // Stopped meanwhile (the app quits): the station's word is settled at the next start (settleCash).
    if (this.stopped) return;
    const live = !recovered && this.payProgress?.orderId === orderId;
    const amount = this.payProgress?.amountAgorot ?? 0;
    if (outcome.kind === 'paid' && (outcome.tx.splitAgorot ?? 0) > 0) return this.applySplitPaid(orderId, docId, outcome.tx, recovered, live, amount);
    if (outcome.kind === 'paid') {
      const tx = outcome.tx;
      // "חסר עודף" (§11.15א): the customer's choice — asked now (`ask`, live), the station's word, or a slip.
      const owed = tx.changeOwedAgorot > 0;
      let owedAs: OwedChoice | null = owed ? (tx.changeOwedAs ?? null) : null;
      if (owed && !owedAs) owedAs = tx.changeOwedAsk && live ? await this.askOwedChoice(orderId, tx, amount) : 'slip';
      if (this.stopped) return;
      const done = this.ledger.completeCashSale(docId, this.cashLegOf(tx, owedAs), new Date(), owedAs === 'tip' ? tx.changeOwedAgorot : 0);
      if (done && done.status === 'completed') {
        const doneView =
          tx.hostId === CASHMAG_HOST_ID
            ? { ...this.cashMagView(null, amount), stage: 'done' as const, insertedAgorot: tx.insertedAgorot, changeAgorot: tx.changePaidAgorot, changeOwedAgorot: tx.changeOwedAgorot }
            : this.cashView(tx, amount, 'done');
        if (live) this.progress({ ...this.payProgress!, phase: 'charging', canCancel: false, cash: doneView });
        await this.afterApproval(orderId, done, recovered);
        if (owed && !recovered && owedAs !== 'tip') this.printCashSlip(owedAs === 'credit' ? 'credit' : 'change_owed', orderId, tx.changeOwedAgorot, tx.slipCode, tx.txId);
        if (!recovered && this.cashSettings().receiptLines && this.config().payment.receiptPolicy !== 'always' && owed && owedAs !== 'tip') {
          // The receipt carries the change owed (or the credit) and its code: printed whatever the policy when something is owed.
          this.printReceipt(orderId, false);
        }
      }
      await this.cashAck(tx, done?.status === 'completed' ? docId : null, done ? formatDocNumber(done.prefix, String(done.number)) : null, this.orders.get(orderId)?.pickupLabel ?? null, { changeOwedAs: owedAs });
      void this.sync.flush();
      return;
    }
    if (outcome.kind === 'refunded') {
      // A split whose card was not approved: its words, and the card's evidence on the voided document.
      const card = this.splitCards.get(docId);
      this.splitCards.delete(docId);
      const declined = card?.kind === 'declined' ? card : null;
      this.ledger.voidCardSale(docId, { ...(declined?.voidMeta ?? {}), cashTxId: outcome.tx?.txId ?? null, outcome: outcome.tx?.outcome ?? 'cancelled' });
      const message = declined ? `${declined.message} — ${outcome.message}` : outcome.message;
      const refundedView =
        outcome.tx?.hostId === CASHMAG_HOST_ID || (!outcome.tx && this.cashMag.enabled())
          ? { ...this.cashMagView(null, amount), stage: 'refunded' as const, insertedAgorot: outcome.tx?.insertedAgorot ?? 0 }
          : this.cashView(outcome.tx, amount, 'refunded');
      if (live) this.progress({ ...this.payProgress!, phase: 'declined', message, canCancel: false, cancelling: false, cash: refundedView });
      if (outcome.tx) await this.cashAck(outcome.tx, null, null);
      void this.sync.flush();
      return;
    }
    if (outcome.kind === 'held') {
      const tx = outcome.tx;
      this.ledger.voidCardSale(docId, { cashTxId: tx.txId, outcome: 'held', heldAgorot: tx.heldAgorot });
      if (live) {
        const view = tx.hostId === CASHMAG_HOST_ID ? { ...this.cashMagView(null, amount), stage: 'fault' as const, insertedAgorot: tx.heldAgorot, txShort: shortTx(tx.txId), slipCode: tx.slipCode } : this.cashView(tx, amount, 'fault');
        this.progress({ ...this.payProgress!, phase: 'unknown', message: 'תקלה — פנה לצוות', canCancel: false, cancelling: false, cash: view });
        this.printCashSlip('fault', orderId, tx.heldAgorot, tx.slipCode, tx.txId);
      }
      await this.cashAck(tx, null, null);
      void this.sync.flush();
      return;
    }
    // Lost: the station went silent — unknown. The document waits (pending); settled when the station answers.
    if (live) {
      this.progress({ ...this.payProgress!, phase: 'unknown', message: 'תקלה — פנה לצוות', canCancel: false, cancelling: false, cash: { ...(this.payProgress!.cash ?? this.cashView(null, amount, 'fault')), stage: 'fault', txShort: outcome.txId ? shortTx(outcome.txId) : null } });
      if (outcome.txId) this.printCashSlip('fault', orderId, outcome.insertedAgorot, null, outcome.txId);
    }
    this.dirty();
  }

  /**
   * A split's cash part paid (§11.15ב): with the card approved — the document with both legs (the cash part was kept on
   * it), then the station's acknowledgement. The card's word not known (unknown, a restart): the document waits for it
   * (settleOrphans), the station keeps its part until then (settleCash acknowledges or voids).
   */
  private async applySplitPaid(orderId: string, docId: string, tx: TxView, recovered: boolean, live: boolean, amount: number) {
    const card = this.splitCards.get(docId);
    this.splitCards.delete(docId);
    const label = this.orders.get(orderId)?.pickupLabel ?? null;
    this.ledger.attachCashPart(docId, { ...this.cashLegOf(tx), changeAgorot: 0, roundingAgorot: 0 });
    const view = { ...this.cashView(tx, amount, 'split_card'), splitAgorot: tx.splitAgorot, cardRestAgorot: Math.max(0, amount - tx.splitAgorot) };
    if (card?.kind === 'approved') {
      const done = this.ledger.completeCardSale(docId, card.card);
      const ref = this.lastReferenceOf(docId);
      if (ref) this.pay.forgetAttempt(ref);
      if (done && done.status === 'completed') {
        if (live) this.progress({ ...this.payProgress!, cash: { ...view, stage: 'done' } });
        await this.afterApproval(orderId, done, recovered);
      }
      await this.cashPay.ack(tx.txId, docId, done ? formatDocNumber(done.prefix, String(done.number)) : null, label);
      void this.sync.flush();
      return;
    }
    const doc = this.ledger.doc(docId);
    if (doc?.status === 'completed') {
      await this.cashPay.ack(tx.txId, docId, formatDocNumber(doc.prefix, String(doc.number)), label);
      return;
    }
    if (doc?.status === 'cancelled') {
      await this.cashPay.ack(tx.txId, null, null, null, { void: true });
      return;
    }
    if (live) {
      this.progress({
        ...this.payProgress!,
        phase: 'unknown',
        message: card?.kind === 'unknown' ? card.message : 'התשלום באשראי לא הוכרע. אנא פנו לצוות.',
        canCancel: false,
        cancelling: false,
        cash: view,
      });
    }
    this.dirty();
  }

  /**
   * Payments the station never finished telling (a restart, a lost station): its word now — paid →
   * the document (no paper: the customer is gone), refunded / held → the document voided; still open
   * → cancelled there (refunded at the device); silent → next time.
   */
  async settleCash(): Promise<void> {
    for (const p of this.cashPay.pending()) {
      if (this.cashPay.inFlight && this.payProgress?.orderId === p.orderId) continue;
      const doc = this.ledger.doc(p.docId);
      const r = await this.cashPay.lookUp(p.txId);
      if (r.kind === 'offline') continue;
      if (r.kind === 'none') {
        if (doc?.status === 'pending') this.ledger.voidCardSale(p.docId, { cashTxId: p.txId, outcome: 'not_started' });
        this.cashPay.forget(p.txId);
        continue;
      }
      const tx = r.tx;
      const split = (tx.splitAgorot ?? 0) > 0;
      if (tx.state === 'PARTIAL') {
        // Cash + card left mid-way (§11.15ב): a card that decided (or may have) keeps the cash part; else it goes back.
        const decision = this.cashPay.splitOf(tx.txId)?.decision ?? null;
        const carded = this.pay.attempts().some((a) => a.transactionId === p.docId);
        if (decision === 'finish' || (decision === null && carded)) await this.cashPay.finishAt(tx.txId);
        else await this.cashPay.cancelAt(tx.txId);
        continue;
      }
      if (tx.state !== 'DONE' && tx.state !== 'HELD') {
        await this.cashPay.cancelAt(tx.txId);
        continue;
      }
      if (doc?.status !== 'pending') {
        // Already written (or voided): only the acknowledgement was left. A split whose document was voided — the card
        // was not charged — leaves its cash part held for the customer (§11.15ב).
        const voided = split && tx.state === 'DONE' && tx.outcome === 'paid' && doc?.status === 'cancelled';
        await this.cashPay.ack(tx.txId, doc?.status === 'completed' ? doc.id : null, doc?.status === 'completed' ? formatDocNumber(doc.prefix, String(doc.number)) : null, null, voided ? { void: true } : {});
        continue;
      }
      if (split && tx.state === 'DONE' && tx.outcome === 'paid') {
        // The card decides the document (its unknown is settled by settleOrphans); with no card at all, it is voided.
        if (this.pay.attempts().some((a) => a.transactionId === p.docId)) continue;
        this.ledger.voidCardSale(p.docId, { cashTxId: tx.txId, outcome: 'split_without_card' });
        await this.cashPay.ack(tx.txId, null, null, null, { void: true });
        continue;
      }
      const outcome: CashOutcome =
        tx.state === 'HELD' ? { kind: 'held', tx } : tx.outcome === 'paid' ? { kind: 'paid', tx } : { kind: 'refunded', tx, message: 'הכסף הוחזר' };
      await this.applyCashOutcome(p.orderId, p.docId, outcome, true);
    }
    this.dirty();
  }

  private lastReferenceOf(transactionId: string): string | null {
    return this.pay.attempts().find((a) => a.transactionId === transactionId)?.vuid ?? null;
  }

  /** Money taken: the order paid, its pickup number, the bon (once), the slip, the receipt by policy. */
  private async afterApproval(orderId: string, doc: DocDraft, recovered: boolean) {
    // Its vouchers: confirmed with this document (a sale recovered after a restart too).
    this.settleVouchers(doc);
    const me = this.cloud.machine();
    const number = formatDocNumber(doc.prefix, String(doc.number));
    let order = this.orders.update(orderId, (o) => ({ ...o, paid: true, paidAt: doc.updatedAt, transactionId: doc.id, transactionNumber: number, recovered }));
    if (!order) return;
    const cfg = this.config();
    const rules: PickupRules = { scope: cfg.pickup.scope, prefix: cfg.pickup.prefix, start: cfg.pickup.start, max: cfg.pickup.max, labelFormat: cfg.pickup.labelFormat };
    const pickup = order.pickupNumber
      ? { number: order.pickupNumber, label: order.pickupLabel ?? String(order.pickupNumber) }
      : await allocatePickup(this.kv, this.api, this.machineId, order, rules, { offline: this.offlineNow });
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
  /** Offline with "חסימת הזמנות כשאין אינטרנט" on: what it blocks is [offlineScope]'s. */
  private offlineBlocked(cfg: { general?: { blockWhenOffline?: boolean } } | null): boolean {
    return !!cfg && kioskOfflineBlocks(cfg.general, this.offlineNow);
  }

  /** The shop's LAN host for "תשלום בקופה" with no cloud, as last kept (the secret opened); null: none known. */
  lanTarget(): LanTarget | null {
    const kept = this.kv.getJson<KeptLanHost>(LAN_HOST);
    if (!kept?.host || !kept.secret) return null;
    try {
      return { ...kept.host, secret: kept.sealed ? (this.opts.secretBox ?? PLAIN_BOX).open(kept.secret) : kept.secret };
    } catch {
      return null;
    }
  }

  private lanHostPulledAt = 0;

  /**
   * Where the shop's LAN host is and the shop's print secret (`GET /sync/{m}/printers`, ETag), kept for the days the
   * cloud is away — every 5 minutes after a good beat, only on a kiosk that offers "תשלום בקופה" (the browser kiosk's
   * bridge: the page hands its orders over itself). An independent kiosk is given no LAN address: none kept.
   */
  async pullLanHost(force = false): Promise<void> {
    const id = this.machineId;
    if (!id || !this.fiscalRole || this.opts.bridge || !this.isKiosk()) return;
    if (!kioskPayMethods(this.config().payment.methods).includes('cash_at_till')) return;
    if (!force && Date.now() - this.lanHostPulledAt < LAN_HOST_PULL_MS) return;
    this.lanHostPulledAt = Date.now();
    const kept = this.kv.getJson<KeptLanHost>(LAN_HOST);
    // The ETag only while what it stands for is still readable here (a secret that no longer opens is asked again).
    const etag = kept?.etag && (kept.host === null || this.lanTarget() !== null) ? kept.etag : null;
    const r = await this.api.get<Record<string, unknown>>(`sync/${id}/printers${etag ? `?etag=${encodeURIComponent(etag)}` : ''}`, { timeoutMs: 20_000 });
    if (r.kind !== 'ok' || !r.body || typeof r.body !== 'object' || r.body.syncType === 'unchanged') return;
    const t = lanTargetOf(r.body);
    const box = this.opts.secretBox ?? PLAIN_BOX;
    const host: LanHost | null = t ? { address: t.address, port: t.port, machineId: t.machineId, name: t.name } : null;
    if (JSON.stringify(host) !== JSON.stringify(kept?.host ?? null)) {
      this.log(host ? `pay at till: the shop's LAN host is ${host.name ?? host.machineId ?? '?'} at ${host.address}:${host.port}` : 'pay at till: no LAN host for this kiosk');
    }
    this.kv.setJson(LAN_HOST, { etag: typeof r.body.etag === 'string' ? r.body.etag : null, host, secret: t ? box.seal(t.secret) : null, sealed: box !== PLAIN_BOX } satisfies KeptLanHost);
  }

  /** "קיוסק — מה נחסם כשאין אינטרנט" (`kioskOfflineBlockScope`): the parameter, else the config's, else `all`. */
  private offlineScope(): OfflineBlockScope {
    return offlineBlockScopeOf(this.cloud.parameters()[OFFLINE_BLOCK_SCOPE_KEY], configOfflineBlockScope(this.snapshot()?.config));
  }

  private payView(kiosk: boolean): KioskView['pay'] {
    const set = kiosk ? tsKioskPayMethods(this.config().payment.methods) : (['card'] as PaymentMethod[]);
    // "ללא אשראי": no card tile at all (not one shown off) — cash at the till and the voucher stay.
    const methods = this.pay.noCard ? set.filter((m) => m !== 'card' && m !== 'split_card') : set;
    const state = this.pay.monitor.state;
    // Off in advance only with no terminal set up (or the cloud's lock on an unresolved card):
    // a terminal that did not answer its check is tried on the press.
    const cardOff = this.pay.noCard
      ? NO_CARD_TEXT
      : this.pay.blocked()
        ? 'תשלום קודם ממתין לבירור. אנא פנו לצוות.'
        : this.pay.configured
          ? null
          : state === 'unconfigured'
            ? 'לא הוגדר מסופון אשראי לקיוסק'
            : 'מסופון האשראי לא זמין כרגע';
    const usable = methods.filter((m) =>
      // A voucher only where its order can be finished: by the card (the vouchers are legs of the document) or at the till
      // (voucherCanFinish) — never a dead end.
      m === 'card'
        ? this.fiscalRole && cardOff === null
        : m === 'voucher'
          ? !this.offlineNow && voucherCanFinish(methods, (this.fiscalRole && cardOff === null) || (this.fiscalRole && this.cashDeviceUsable()))
          : m === 'cash_at_till'
            ? this.fiscalRole
            : m === 'cash_device'
              ? this.fiscalRole && this.cashDeviceUsable()
              : false,
    );
    // Offline with "חסימת הזמנות כשאין אינטרנט" on: nothing to take (the rest screen says why), or — with
    // `kioskOfflineBlockScope` = pay_at_till — everything but the till. The cash station is local: it stays (§13).
    const blockCash = offlineBlockCashOf(this.cloud.parameters()[OFFLINE_BLOCK_CASH_KEY], this.snapshot()?.config);
    return {
      methods,
      usable: kiosk ? offlineUsable(usable, this.offlineBlocked(this.config()), this.offlineScope(), blockCash) : usable,
      cardOff,
      cashOff: methods.includes('cash_device') ? (this.cashMag.enabled() ? this.cashMag.offReason() : this.cashPay.offReason()) : null,
    };
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
        ...(l.menuId
          ? { menuId: l.menuId, menuName: l.menuName ?? null, priceSource: l.priceSource ?? 'catalog', ...(typeof l.catalogPriceAgorot === 'number' ? { catalogAgorot: l.catalogPriceAgorot } : {}) }
          : {}),
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
        ...((l.voucherAgorot ?? 0) > 0 ? { voucherAgorot: l.voucherAgorot } : {}),
        // The promotion's share that gave way to a voucher: the rules read the basket as the promotions priced it.
        ...((l.promotionYieldedAgorot ?? 0) > 0 ? { promotionYieldedAgorot: l.promotionYieldedAgorot, promotionId: l.promotionId ?? null } : {}),
      };
    });
  }

  /**
   * A voucher for this basket (kiosk/payAtTill.ts; the basket priced here with the discount vouchers already on the order):
   * goods redeemed online, or a discount voucher held in the cloud for this order.
   */
  async redeemVoucher(input: {
    code: string;
    basket: StartPaymentIn;
    earlier: VoucherLeg[];
    discounts?: AppliedDiscountVoucher[];
    forfeitRest?: boolean;
    clientRequestId: string;
    saleRef?: string;
  }): Promise<VoucherResult> {
    if (!this.fiscalRole || !this.isKiosk()) return { kind: 'refused', reason: 'not_a_kiosk' };
    const discounts = input.discounts ?? [];
    const { lines } = this.priceBasket({ ...input.basket, vouchers: { legs: [], discounts, saleRef: input.saleRef ?? input.clientRequestId } });
    return this.payAtTill.redeem({
      code: input.code,
      lines: this.webLines(lines),
      earlier: input.earlier ?? [],
      discounts,
      forfeitRest: input.forfeitRest,
      clientRequestId: input.clientRequestId,
      saleRef: input.saleRef,
    });
  }

  async reverseVoucher(redemptionId: string): Promise<void> {
    if (typeof redemptionId === 'string' && redemptionId) await this.payAtTill.reverse(redemptionId);
  }

  /** Discount vouchers given back (removed from the order, the order left): the cloud lets the hold go. */
  async releaseDiscounts(vouchers: Array<{ reservationId: string }>): Promise<void> {
    this.payAtTill.releaseDiscounts((Array.isArray(vouchers) ? vouchers : []).filter((v) => v && typeof v.reservationId === 'string' && v.reservationId));
  }

  /**
   * "מזומן בקופה": the basket checked and priced here as for the card (never a total the customer did
   * not see), its number, then the open order to the shop's tills — no document here: the till that
   * takes the money writes it. With "שלח למטבח לפני תשלום" the bon is printed now, else the till's.
   */
  async placeOpenOrder(input: PlaceOrderIn): Promise<PlaceOrderOut> {
    if (!this.fiscalRole || !this.isKiosk()) return { ok: false, reason: 'error', message: 'המכשיר אינו קיוסק פעיל' };
    if (!this.newSaleAllowed()) return { ok: false, reason: 'error', message: SHOP_LOCK_TEXT.title };
    const cfg = this.config();
    if (!kioskPayMethods(cfg.payment.methods).includes('cash_at_till')) return { ok: false, reason: 'error', message: 'תשלום בקופה אינו מוגדר לקיוסק' };
    // A discount voucher is held for this kiosk's own payment: never taken to a till (removed first).
    if ((input.discounts?.length ?? 0) > 0) return { ok: false, reason: 'error', message: DISCOUNT_PAY_HERE };
    const basket: StartPaymentIn = { ...input, vouchers: undefined };
    await this.cloudBasketCheck(basket).catch(() => undefined);
    const { lines, changes } = this.priceBasket(basket);
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
    // The cloud known to be away: nothing waited for — the local number (tagged L), the LAN host at once.
    const offline = this.offlineNow;
    const pickup = await allocatePickup(
      this.kv,
      this.api,
      this.machineId,
      { localId, businessDate },
      { scope: cfg.pickup.scope, prefix: cfg.pickup.prefix, start: cfg.pickup.start, max: cfg.pickup.max, labelFormat: cfg.pickup.labelFormat },
      { offline },
    );
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
    // "שלח למטבח לפני תשלום": the bon ("ממתין לתשלום בקופה") goes now — to the shop's kitchen printers by the routing
    // (main/kitchen, as the Android kiosk's bonBeforePay), or on this kiosk's own printer — once the cloud has not refused
    // the order (it may be offline: the bon prints all the same). No kitchen printer and "בון מטבח במדפסת הקיוסק" off:
    // never here — the till that takes the money prints it.
    const kitchenConfig = this.kitchen.known() ? this.kitchen.config() : null;
    const bonRoute: KioskBonRoute = windowsBonRouteFor(cfg.printing, kitchenConfig);
    const kitchenFirst = cfg.payment.cashAtTillKitchenBeforePay && order.fulfillmentMode === 'BON' && bonRoute !== 'none';
    order.kitchenSent = kitchenFirst;
    const placed = await this.payAtTill.place(order, { offline });
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
    if (kitchenFirst && bonViaKitchen(bonRoute, cfg.printing, kitchenConfig)) {
      // The shop's kitchen printers (or the bon printer it names): the bon marked unpaid, so the till never prints it again.
      kioskBonToKitchen(
        this.kitchen,
        bonRoute,
        cfg.printing,
        {
          orderId: localId,
          pickupLabel: pickup.label,
          customerName: order.customerName,
          tableRef: order.tableRef,
          transactionNumber: pickup.label,
          service: order.serviceType,
          createdAt: new Date(now).toISOString(),
          kioskName: this.operator().name,
          lines,
          copies: 1,
          notice: 'ממתין לתשלום בקופה',
        },
        this.productCategoryOf(),
      );
    } else if (kitchenFirst) {
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
        }, kioskBonStyle(this.cloud.parameters())),
      );
    }
    // "הזמנה ממתינה לסנכרון" only while no till can see it: neither the cloud nor the shop's LAN host has it.
    const pending = placed.cloudState === null && !this.payAtTill.lanDelivered(localId);
    if (pending) {
      // No till can find it by its number or QR yet: the customer takes it to the till on paper — the Android kiosk's
      // cash slip (the number, what to pay, the items, the QR, "ממתינה לסנכרון"), in place of the pickup slip.
      this.printQueue.enqueue('slip', localId, this.payAtTillSlip(placed, cfg, now, true));
    } else if (cfg.printing.pickupSlip) {
      this.printQueue.enqueue('slip', localId, slipDoc({ businessName: this.business().companyName, pickupLabel: pickup.label, service: order.serviceType, itemCount: lines.reduce((n, l) => n + l.qty, 0), totalAgorot: orderDue(placed) }));
    }
    this.dirty();
    return { ok: true, localId, pickupLabel: pickup.label, vouchers, dueAgorot: orderDue(placed), pending, code: orderCode(localId) };
  }

  /** "לתשלום בקופה" on paper (core/printDocs.ts payAtTillSlipDoc), in the kiosk's own words (its texts, else the defaults). */
  private payAtTillSlip(o: OpenOrder, cfg: ReturnType<typeof resolveKioskConfig>, at: number, pending: boolean): PrintDoc {
    const text = (key: string, values?: Record<string, string | number>) => kioskTextOf(cfg, 'he', key, values);
    const notes = [
      ...o.vouchers.map((v) => `${text('paySlipVoucher', { number: v.serial })} — ${ltr(formatShekelSign(v.amountAgorot))}`),
      ...(o.tipAgorot > 0 ? [`${text('paySlipTip')} ${ltr(formatShekelSign(o.tipAgorot))}`] : []),
    ];
    return payAtTillSlipDoc({
      businessName: this.business().companyName,
      title: text('cashSlipTitle'),
      label: o.pickupLabel,
      amountLabel: text('paySlipAmount'),
      dueAgorot: orderDue(o),
      lines: openLines(o.lines),
      notes,
      code: orderCode(o.localId),
      at: new Date(at),
      footer: text('cashSlipFooter'),
      pending: pending ? text('cashSlipPending') : null,
    });
  }

  async cancelPayment(): Promise<void> {
    const p = this.payProgress;
    if (!p || (p.phase !== 'starting' && p.phase !== 'charging')) return;
    this.progress({ ...p, cancelling: true, message: 'מבטלים…' });
    // Cash + card: the card's charge is cancelled — then the station gives the cash part back (§11.15ב).
    if (p.cash?.stage === 'split_card') {
      await this.pay.cancel();
      return;
    }
    // CashMag: the wait left ("חזרה"), or dialogCancel — the machine gives back what went in.
    if (p.cash && this.cashMag.inFlight) {
      this.cashMag.cancel();
      return;
    }
    // "מזומן": the station gives back what went in (or the queue is left).
    if (p.cash) {
      this.cashPay.cancel();
      return;
    }
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
    if (this.pay.noCard) return { ready: false, state, blocked, reason: NO_CARD_TEXT };
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
    // Kiosk mode only, at rest (a browser kiosk's bridge is never a till by role: its work mode is not attached).
    const key = `bridge.shopZClose:${requestId}`;
    const kept = this.kv.getJson<{ state: 'done' | 'failed'; shiftId: string | null; zNumber: number | null; detail: string | null }>(key);
    if (kept) return kept;
    const mayRun = autoCloseMayRun({ kiosk: this.fiscalRole && this.isKioskMode(), flowIdle: this.flow.idle, flowBusy: this.flow.busy, cardInFlight: this.pay.cardInFlight });
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

  /** The till's router of its pages to another till's printer (main/till/tillRemotePrint.ts); null — every page prints here. */
  setRemoteDocuments(r: RemoteDocumentsRouter | null): void {
    this.remoteDocs = r;
  }

  /** This device has a receipt printer of its own set (a Windows queue or a network printer) — "להדפיס כאן" is possible. */
  hasOwnReceiptPrinter(): boolean {
    const t = this.printerResolution().target;
    if (t.transport === 'tcp') return !!t.host;
    if (t.transport === 'spooler') return !!t.queueName;
    return false;
  }

  /**
   * A page of the till (a receipt, a copy, a credit note, X / Z): where `remotePrintDocuments` and the cloud's printers send
   * it (another till's printer, P:/specs/bill-print-other-till.md), else here, as before. Returns the local print job's id,
   * or null when it went elsewhere (said on the screen) or was asked about.
   */
  private pagePrint(kind: JobKind, refId: string | null, doc: PrintDoc, page: PrintedPage): string | null {
    const local = () => this.printQueue.enqueue(kind, refId, doc);
    if (!this.remoteDocs) return local();
    try {
      return this.remoteDocs.print(page, doc, local);
    } catch (e) {
      this.log(`remote print: ${String(e)} — printed here`);
      return local();
    }
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

  /** Raw ESC/POS bytes to the receipt printer now (a document another till sent to print here, main/till/remoteDrawer.ts). */
  async sendToReceiptPrinter(bytes: Uint8Array): Promise<void> {
    await this.transport.send(this.printerResolution().target, bytes);
  }

  /* ------------------------------------------------------------- printing */

  receiptLines(doc: DocDraft): ReceiptLine[] {
    // A ₪0 voucher line's value (core/till/vouchers.ts): printed under it, outside every total.
    const memo = offVoucherLineValues(doc.prepaidVouchers ?? []);
    return doc.lines.map((l) => {
      const unit = unitAgorot(l);
      return {
        name: l.name,
        qty: l.qty,
        unitAgorot: unit,
        // A credit-note line prints what it credits (net of its discount share), as the till's credit notes do.
        totalAgorot: typeof l.creditAgorot === 'number' ? l.creditAgorot : unit * l.qty,
        ...(l.oth ? { oth: l.oth.reason } : {}),
        ...(memo.has(l.key) ? { memo: voucherLineMemo(memo.get(l.key)!, l.voucherMark) } : l.voucherMark ? { voucher: l.voucherMark } : {}),
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
    // "מספר הזמנה A-1" on the receipt (`printing.orderNumberOnReceipt`, on by default): one paper.
    this.printQueue.enqueue('receipt', orderId, this.receiptDocFor(doc, copy, this.config().printing.orderNumberOnReceipt ? o.pickupLabel ?? null : null));
  }

  /**
   * A till's receipt (the till role, main/till/engine.ts) for a completed document — the same drawing and the same
   * footer / logo / place rules as the kiosk's, with the tenders and the change; a copy says "העתק". Queued like any
   * page: a failure is the printer's light and a retry, never the sale's. Returns the print job's id.
   */
  printDocReceipt(doc: DocDraft, copy: boolean, merchantCopy = false): string | null {
    if (!settled(doc)) return null;
    const isCopy = copy || merchantCopy;
    const number = formatDocNumber(doc.prefix, String(doc.number));
    const cash = legsOf(doc)
      .filter((l) => l.method === 'cash')
      .reduce((sum, l) => sum + l.amountAgorot, 0);
    const credit = isCreditDoc(doc.documentType);
    return this.pagePrint('receipt', merchantCopy ? `${doc.id}:merchant` : doc.id, this.receiptDocFor(doc, isCopy, null, merchantCopy), {
      kind: credit ? 'credit' : 'receipt',
      number,
      copy: isCopy,
      title: `${documentTitleFor(doc.documentType)} ${number}`.trim(),
      ...(credit || isCopy ? {} : { saleId: doc.id, cashAgorot: cash > 0 ? cash : null, documentType: doc.documentType, documentNumber: doc.number }),
    });
  }

  private receiptDocFor(doc: DocDraft, copy: boolean, orderNumber: string | null, merchantCopy = false): PrintDoc {
    const params = this.cloud.parameters();
    const footer: [string | null, string | null] = [
      typeof params['receipt.footer.line1'] === 'string' ? (params['receipt.footer.line1'] as string) : null,
      typeof params['receipt.footer.line2'] === 'string' ? (params['receipt.footer.line2'] as string) : null,
    ];
    const logo = this.settingsMap().brandReceiptLogoUrl;
    return (
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
        // "שובר #12 — פסטיבל הקיץ" under the items (a discount) and "שובר הפקה" among the payments (the goods vouchers' legs).
        voucherDiscounts: (doc.voucherDiscounts ?? []).map((v) => ({ label: voucherLabel(v.serial, v.batchName), amountAgorot: v.amountAgorot })),
        // A till sale's "שוברי הפקה" legs too (core/till/vouchers.ts), and its production vouchers' deductions and ₪0 goods.
        voucherLegs: [...(doc.voucherLegs ?? []), ...(doc.payments ?? []).filter((l) => l.method === 'production_voucher')].map((l) => ({ amountAgorot: l.amountAgorot })),
        prepaidDeductions: (doc.prepaidVouchers ?? []).filter((v) => v.accounting === 'discount' && v.amountAgorot > 0).map((v) => ({ label: voucherDeductionLabel(v.serial), amountAgorot: v.amountAgorot })),
        voucherGoodsValueAgorot: [...offVoucherLineValues(doc.prepaidVouchers ?? []).values()].reduce((s, x) => s + x, 0),
        card: doc.card ? { brand: doc.card.brand, last4: doc.card.last4, authNum: doc.card.authNum, payments: doc.card.payments, firstPaymentAgorot: doc.card.firstPaymentAgorot } : null,
        // "מזומן" at the cash station: שולם / עודף (`cashReceiptLines`), what is owed and its code.
        cash: doc.cash
          ? {
              receivedAgorot: doc.cash.receivedAgorot,
              changeAgorot: doc.cash.changeAgorot,
              changeOwedAgorot: doc.cash.changeOwedAgorot,
              roundingAgorot: doc.cash.roundingAgorot,
              slipCode: doc.cash.slipCode,
              lines: this.cashSettings().receiptLines,
              changeOwedAs: doc.cash.changeOwedAs ?? null,
              splitAgorot: doc.cash.splitAgorot ?? 0,
            }
          : null,
        // "זיכוי מזומן C-K7Q3MX" among the payments (§11.15א).
        creditLegs: (doc.creditLegs ?? []).map((l) => ({ code: l.code, amountAgorot: l.amountAgorot })),
        // A till sale: every tender, the cash handed over and the change.
        // (A cash credit's leg is "זיכוי מזומן" above, never a tender here.)
        ...(doc.payments && doc.payments.length > 0
          ? {
              tenders: doc.payments.filter((l): l is { method: 'cash' | 'card' | 'exchange'; amountAgorot: number } => l.method !== 'cash_credit' && l.method !== 'production_voucher'),
              tenderedAgorot: doc.tenderedAgorot ?? null,
              changeAgorot: doc.changeAgorot ?? null,
            }
          : {}),
        // The till's discounts by hand (OTH lines print at ₪0 on their own), a credit note's original and customer.
        ...(tillManualDiscount(doc) > 0 ? { manualDiscountAgorot: tillManualDiscount(doc) } : {}),
        ...(doc.refundOfTransactionId ? { refundOfNumber: this.docNumberOf(doc.refundOfTransactionId) } : {}),
        ...(doc.customer ? { customer: doc.customer } : {}),
        ...(merchantCopy ? { merchantCopy: true } : {}),
        footer,
        logoUrl: typeof logo === 'string' ? this.localMediaUrl(logo) : null,
        // "סניף הרצליה · קופה 3 · קיוסק רויאל": the machine as the cloud names it (machines/me).
        place: this.placeOfMachine(),
        orderNumber,
      })
    );
  }

  /** A document of this till as printed ("20000057"), or null when it is not here. */
  docNumberOf(id: string): string | null {
    const d = this.ledger.doc(id);
    return d ? formatDocNumber(d.prefix, String(d.number)) : null;
  }

  /** The shop, the till's number and name, as `machines/me` says them (the documents' place line). */
  placeOfMachine(): { shopName: string | null; posNumber: string | null; deviceName: string | null } {
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
    const pages = this.itemTicketDocs(doc, o.transactionNumber, null);
    for (const page of pages) this.printQueue.enqueue('ticket', orderId, page);
    return pages.length;
  }

  /**
   * The item tickets [doc] earns now, as pages (the catalog's modes, "שוברי פריט"; none for a credit note) — each with
   * its place among them, and [notice] ("הדפסה חוזרת") on a person's reprint.
   */
  private itemTicketDocs(doc: DocDraft, transactionNumber: string | null, notice: string | null): TicketDoc[] {
    if (doc.status !== 'completed') return [];
    const setting = itemTicketSetting(this.cloud.parameters()[ITEM_TICKET_PARAM]);
    if (!itemTicketsPrint(doc.documentType, true, setting)) return [];
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
    return tickets.map((items, i) =>
      ticketDoc({
        businessName: this.business().companyName,
        shopName: place.shopName,
        machineName: place.deviceName,
        posNumber: place.posNumber,
        transactionNumber,
        issuedAt: new Date(doc.createdAt),
        items,
        index: i + 1,
        count: tickets.length,
        notice,
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
      const found = [...this.printQueue.jobsFor(orderId, 'bon').map((j) => j.id), ...this.kitchen.jobsFor(orderId).map((j) => j.id)];
      if (found.length > 0) {
        this.orders.update(orderId, (x) => ({ ...x, bonJobIds: found }));
        return;
      }
    }
    const doc = o.transactionId ? this.ledger.doc(o.transactionId) : null;
    if (!doc) return;
    const cfg = this.config();
    // "בון מטבח במדפסת הקיוסק" (off by default) and the shop's kitchen printers (core/kioskBonRoute.ts): the Android
    // kiosk's route — the kitchen printers by the routing, the one bon printer it names, its own printer, or none.
    const kitchenConfig = this.kitchen.known() ? this.kitchen.config() : null;
    const route = windowsBonRouteFor(cfg.printing, kitchenConfig);
    if (route === 'none') {
      this.orders.update(orderId, (x) => ({ ...x, bonStatus: 'none', bonDetail: BON_NOT_ON_KIOSK }));
      return;
    }
    this.orders.update(orderId, (x) => ({ ...x, bonRequestedAtMs: x.bonRequestedAtMs ?? Date.now(), bonStatus: 'queued' })); // write-ahead
    const copies = Math.max(1, Math.min(3, cfg.printing.bonCopies || 1));
    if (bonViaKitchen(route, cfg.printing, kitchenConfig)) {
      // Through the kitchen queue (main/kitchen): once — its job ids derive from the order (a reprint: fresh ones).
      const q = kioskBonToKitchen(
        this.kitchen,
        route,
        cfg.printing,
        {
          orderId,
          pickupLabel: o.pickupLabel ?? String(o.pickupNumber ?? '?'),
          customerName: o.customerName,
          tableRef: o.tableRef,
          transactionNumber: o.transactionNumber,
          service: o.serviceType,
          createdAt: doc.createdAt,
          kioskName: this.operator().name,
          lines: doc.lines,
          copies,
          notice: reprint ? 'הדפסה חוזרת' : null,
          nonce: reprint ? String(Date.now()) : null,
        },
        this.productCategoryOf(),
      );
      if (q.jobIds.length === 0) {
        // Asked, and no printer takes any of it: a staff alert, never "printed".
        this.orders.update(orderId, (x) => ({ ...x, bonStatus: 'failed', bonDetail: q.detail ?? 'אין מדפסת בונים למוצרי ההזמנה' }));
        return;
      }
      this.orders.update(orderId, (x) => ({ ...x, bonJobIds: reprint ? [...x.bonJobIds, ...q.jobIds] : q.jobIds, bonDetail: q.detail }));
      this.refreshBonStates();
      return;
    }
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
          }, kioskBonStyle(this.cloud.parameters())),
        ),
      );
    }
    this.orders.update(orderId, (x) => ({ ...x, bonJobIds: reprint ? [...x.bonJobIds, ...ids] : ids }));
  }

  /** The product's category now, from the catalog (printers hang on categories). */
  private productCategoryOf(): (productId: string) => string | null {
    const categories = new Map<string, string>();
    for (const p of this.cloud.catalog().products) {
      if (typeof p.id === 'string' && typeof p.categoryId === 'string') categories.set(p.id, p.categoryId);
    }
    return (id) => categories.get(id) ?? null;
  }

  /** The catalog's categories, for a ticket ordered by category ("סדר הפריטים בבון", §9). */
  private kitchenCategories(): Array<{ id: string; name: string | null; parentId: string | null; sortOrder: number | null }> {
    return this.cloud
      .catalog()
      .categories.filter((c) => typeof c.id === 'string')
      .map((c) => ({
        id: c.id as string,
        name: typeof c.name === 'string' ? c.name : null,
        parentId: typeof c.parentId === 'string' ? c.parentId : null,
        sortOrder: typeof c.sortOrder === 'number' ? c.sortOrder : null,
      }));
  }

  /**
   * A till's completed counter sale to the kitchen (main/kitchen/kitchenFlows.ts): its tickets when "בונים במכירה" is on,
   * its KDS release when the shop runs the KDS — queued durably, never holding the cashier. Not for a kiosk's sale (its
   * bon is `printBon`). The lines no kitchen printer takes, by name.
   */
  tillKitchen(doc: DocDraft, order: { orderName?: string | null; dining?: 'take_away' | 'eat_in' | null } = {}): string[] {
    try {
      const r = tillSaleToKitchen(
        { kitchen: this.kitchen, kds: this.kitchenKds, params: this.cloud.parameters(), categoryOf: this.productCategoryOf(), log: this.log },
        {
          transactionId: doc.id,
          documentType: doc.documentType,
          documentNumber: formatDocNumber(doc.prefix, String(doc.number)),
          lines: doc.lines,
          cashierName: doc.cashierName || null,
          createdAt: doc.createdAt,
          // "פרטי הזמנה": the name as the ticket's headline, take-away / eat-in as its band.
          orderName: order.orderName ?? null,
          dining: order.dining ?? null,
        },
      );
      return r.unrouted;
    } catch (e) {
      this.log(`kitchen tickets for sale ${doc.id}: ${String(e)}`);
      return [];
    }
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
      // "printed" is final (every printer confirmed it); "none" has no jobs.
      if (o.bonJobIds.length === 0 || o.bonStatus === 'printed' || o.bonStatus === 'none') continue;
      // A page on its own printer (print_jobs), or a kitchen job (main/kitchen): "printed" only when every printer confirmed.
      const jobs = o.bonJobIds.map((id) => this.printQueue.job(id)?.status ?? bonJobState(this.kitchen.job(id)));
      const status = jobs.some((s) => s === 'failed') ? 'failed' : jobs.every((s) => s === 'printed') ? 'printed' : jobs.every((s) => s === 'sent' || s === 'printed') ? 'sent' : 'queued';
      if (status === o.bonStatus) continue;
      // A kitchen job's own words when it failed ("no_paper: …"); the lines no printer takes stay said.
      const kitchenError = status === 'failed' ? (this.kitchen.jobs(o.bonJobIds).find((j) => j.state === 'failed')?.lastError ?? null) : null;
      this.orders.update(o.localId, (x) => ({
        ...x,
        bonStatus: status,
        bonDetail: status === 'failed' ? (kitchenError ? `לא הודפס — ${kitchenError.slice(0, 120)}` : 'לא הודפס') : x.bonDetail?.startsWith('פריטים שלא נותבו') ? x.bonDetail : null,
      }));
    }
  }

  /**
   * The X report on paper (the till role: an interim X, and the X of a shift's close): the Android till's report drawn in the
   * Z's own ops (core/printDocs.ts xDoc), queued like any page. Returns the print job's id.
   */
  /** "דוח X סניפי" (core/till/shopX.ts): the cloud's paper on the receipt printer, as the till's X. */
  printShopX(doc: Parameters<typeof shopXPrintDoc>[0], refId: string): string {
    return (
      this.pagePrint('z', refId, shopXPrintDoc(doc, (this.settingsMap().brandReceiptLogoUrl as string | null | undefined) ?? null), { kind: 'report', code: 'x', title: doc.title }) ?? ''
    );
  }

  printX(i: Pick<XInput, 'cashierName' | 'shiftNumber' | 'businessDate' | 'openedAt' | 'closedAt' | 'till' | 'countedCash' | 'blindCount'> & { refId: string }): string {
    const me = this.cloud.machine();
    const logo = this.settingsMap().brandReceiptLogoUrl;
    return this.pagePrint(
      'z',
      i.refId,
      xDoc({
        business: this.business(),
        shopName: me?.shopName ?? null,
        posNumber: me?.posNumber ?? null,
        machineName: me?.machineName ?? null,
        cashierName: i.cashierName,
        shiftNumber: i.shiftNumber,
        businessDate: i.businessDate,
        openedAt: i.openedAt,
        closedAt: i.closedAt,
        printedAt: new Date(),
        copy: false,
        logoUrl: typeof logo === 'string' ? this.localMediaUrl(logo) : null,
        till: i.till,
        countedCash: i.countedCash,
        ...(i.blindCount ? { blindCount: true } : {}),
      }),
      { kind: 'report', code: 'x', number: i.shiftNumber !== null && i.shiftNumber !== undefined ? String(i.shiftNumber) : null, title: 'דוח X' },
    ) ?? '';
  }

  private printZ(z: Record<string, unknown>) {
    const me = this.cloud.machine();
    const logo = this.settingsMap().brandReceiptLogoUrl;
    const zNumber = z.zNumber ?? z.number ?? null;
    this.pagePrint('z', String(z.id ?? ''), zDoc(z, { business: this.business(), shopName: me?.shopName ?? null, posNumber: me?.posNumber ?? null, machineName: me?.machineName ?? null, copy: false, logoUrl: typeof logo === 'string' ? this.localMediaUrl(logo) : null, printedAt: new Date() }), {
      kind: 'report',
      code: 'z',
      number: zNumber !== null && zNumber !== undefined ? String(zNumber) : null,
      title: zNumber !== null && zNumber !== undefined ? `דוח Z ${String(zNumber)}` : 'דוח Z',
    });
  }

  /* ---------------------------------------------------------------- ticks */

  /** The flow as the screens report it (for the status, the automatic close and the shift opening). */
  reportFlow(f: { flowState: string; screen: string; busy: boolean; idle: boolean }) {
    const prev = this.lastFlowScreen;
    this.flow = f;
    this.lastFlowScreen = f.screen;
    this.flowChangedAt = Date.now();
    // Trading starts again (opening hours, a lock lifted — the shop's too): the next shift opens as the kiosk itself — in kiosk
    // mode only (a kiosk by role working as a till opens its shifts by the employee, never as the kiosk).
    if (f.screen === 'attract' && ['closed', 'paused', 'no_payment', SHOP_LOCK_FLOW.screen].includes(prev) && this.fiscalRole && this.isKioskMode() && !this.tillZ.owed && !this.ledger.currentShift()) {
      this.ledger.openShift(this.operator());
    }
  }

  /** What the kiosk is doing, for the updater (core/updatePolicy.ts): never under an order or a payment. */
  activity(): Activity {
    return {
      role: this.isKiosk() ? 'kiosk' : null,
      screen: this.flow.screen,
      busy: this.flow.busy || this.payProgress?.phase === 'starting' || this.payProgress?.phase === 'charging' || this.cashPay.inFlight || this.cashMag.inFlight,
      idle: this.flow.idle,
      cardInFlight: this.pay.cardInFlight,
      cardBlocked: this.pay.blocked(),
      lastActivityAt: this.flowChangedAt,
    };
  }

  /* --------------------------------------------------- "סניף לא פעיל" */

  /**
   * A new sale may start: not once the shop's lock screen is up (the screens report it as their
   * flow, SHOP_LOCK_FLOW) — the sale it waited for was finished before it went up.
   */
  private newSaleAllowed(): boolean {
    const active = this.cloud.shopActive();
    return newSaleAllowed(active, !active && this.flow.screen === SHOP_LOCK_FLOW.screen);
  }

  private closingDay = false;

  /**
   * "סגירת משמרת ו-Z" from the shop's lock (core/shopLock.ts): a manager's code, then the kiosk's own
   * close for its Z mode at once — the open shift closed with the manager named, and in zMode = till
   * the Z produced (owed first, so the tick makes it later if the cloud cannot now). Never under a
   * payment; the code opens nothing — the lock stays until the shop is active again.
   */
  async shopLockCloseDay(pin: string): Promise<ShopLockCloseDayOut> {
    if (this.cloud.shopActive()) return { ok: false, message: CLOSE_DAY_TEXT.active };
    const kind = this.fiscalRole && this.isKiosk() ? kioskCloseDay({ zMode: zModeOf(this.cloud.heartbeat().zMode), shiftOpen: !!this.ledger.currentShift() }) : null;
    if (!kind) return { ok: false, message: SHOP_LOCK_TEXT.nothingToClose };
    const guard = paymentGuard(this.activity());
    if (guard) return { ok: false, message: guard };
    const candidates = closeDayCandidates(this.cloud.posUsers(), this.shopIdHere(), kind);
    if (candidates.length === 0) return { ok: false, message: CLOSE_DAY_TEXT.noManager(kind) };
    const u = await findByPin(candidates, typeof pin === 'string' ? pin : '', (p, h) => bcrypt.compare(p, h));
    if (!u) return { ok: false, message: CLOSE_DAY_TEXT.wrongCode, wrongCode: true };
    if (this.closingDay) return { ok: false, message: CLOSE_DAY_TEXT.running };
    this.closingDay = true;
    try {
      const closer = `${closerName(this.operator())} · ${displayName(u)}`;
      if (this.ledger.currentShift()) {
        const r = this.ledger.closeShift({ closedByName: closer, closedByUserId: u.id, vatRate: this.vatRate() });
        if (r.kind === 'pending') return { ok: false, message: CLOSE_DAY_TEXT.pending };
        if (r.kind === 'closed') this.log(`shop lock: shift ${r.shift.id} closed by ${displayName(u)} (${u.id})`);
      }
      await this.sync.flush();
      if (kind === 'shift_close') return { ok: true, message: CLOSE_DAY_TEXT.shiftClosed };
      const z = await this.tillZ.produceOwed(closer);
      this.log(`shop lock: Z asked by ${displayName(u)} (${u.id}): ${z?.kind ?? 'already running'}`);
      return closeDayZText(z);
    } finally {
      this.closingDay = false;
      this.dirty();
    }
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
    // The kiosk's own closes (the shop Z's request, the cloud's close / Z / transmit, the automatic Z) run in kiosk mode only,
    // at rest: while a kiosk by role works as a till the till rules apply and nothing fiscal moves under the till's feet
    // (spec §5.5; Android KioskZHold is null in till mode); a till by role at home was never a kiosk here.
    const mayRun = autoCloseMayRun({ kiosk: this.fiscalRole && this.isKioskMode(), flowIdle: this.flow.idle, flowBusy: this.flow.busy, cardInFlight: this.pay.cardInFlight });
    const cfg = this.isKiosk() ? this.config() : null;
    const op = this.operator();
    // The main till's shop Z part: a payment waited out, an answer the cloud did not take yet.
    if (this.shopZPart) await this.runShopZPart();
    // "תשלום בקופה" with the cloud away: the orders it has not taken handed to the shop's LAN host (again), and what its
    // till did with them asked (the Android kiosk's 15 s loop; the cloud's own turn is the next good beat).
    if (this.offlineNow && this.fiscalRole && !this.opts.bridge && this.isKiosk() && this.payAtTill.pending() > 0) {
      await this.payAtTill.lanRetry().catch((e) => this.log(`pay at till (LAN): ${String(e)}`));
    }
    // The pinpad that moved (a DHCP change): looked for by who it is, "לפי המאק" first (PinpadRelocator).
    if (this.fiscalRole && !this.opts.bridge) await this.relocateTick().catch(() => undefined);
    // "סגירה יחד עם ה-Z הסניפי": carried out first, on an idle tick (KioskRepository.autoCloseTick).
    const closeRequest = this.kv.get(SHOP_Z_CLOSE_REQUEST);
    if (mayRun && closeRequest && !this.opts.bridge) {
      await this.runShopZClose(closeRequest);
      this.dirty();
      return;
    }
    // A close or a Z asked from afar waits while a customer orders or pays (KioskZHold): said once per request and reason.
    if (!mayRun) this.deferRemoteForCustomer();
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
    // A till by role: its own automatic close, with what is open on it (the till's engine decides).
    if (this.fiscalRole && !this.isKiosk() && this.tillAutoClose) await this.tillAutoClose().catch((e: unknown) => this.log(`till automatic close: ${String(e)}`));
    this.dirty();
  }

  /** The last `deferred` ack sent per request (KioskZHold's code): each reason said once, not every tick. */
  private readonly deferredSaid = new Map<string, string>();

  /**
   * "ממתין לסיום תשלום בקיוסק" / "לקוח באמצע הזמנה" (pos-server docs/SPEC_KIOSK.md §25, Android CloseShiftCoordinator /
   * TillZCoordinator `deferred`): the cloud's close or Z asked of this kiosk is held while a customer is at it — acked
   * `deferred` with `kiosk_paying` / `kiosk_ordering`, then run on the first idle tick.
   */
  private deferRemoteForCustomer() {
    const f = this.kioskSideFacts();
    const hold = kioskZHold(this.fiscalRole && this.isKioskMode(), f.paying ? 'paying' : f.ordering ? 'ordering' : this.flow.flowState);
    if (!hold) return;
    const say = (kind: 'close' | 'z', requestId: string) => {
      const key = `${kind}:${requestId}`;
      if (this.deferredSaid.get(key) === hold) return;
      this.deferredSaid.set(key, hold);
      while (this.deferredSaid.size > 50) this.deferredSaid.delete(this.deferredSaid.keys().next().value as string);
      this.ack(kind, requestId, 'deferred', { errorCode: hold });
    };
    if (this.pendingClose) say('close', this.pendingClose.requestId);
    if (this.pendingZ && zModeOf(this.cloud.heartbeat().zMode) === 'till') say('z', this.pendingZ.requestId);
  }

  /** "שדר עסקאות עכשיו" ("פעולות אשראי", main/till/tillTransmission.ts): the batch now, its row to the cloud as always. */
  transmitNow(trigger: 'manual' | 'remote' = 'manual'): Promise<TransmitResult | null> {
    return this.transmitBatch(trigger);
  }

  /** This device's transmissions as kept (the newest first), each with whether the cloud has it yet. */
  localTransmissions(limit = 200): Array<TransmissionRow & { synced: boolean }> {
    const rows = this.db.all<{ key: string; value: string }>("SELECT key, value FROM kv WHERE key LIKE 'transmission:%' ORDER BY updated_at DESC LIMIT ?", limit);
    const out: Array<TransmissionRow & { synced: boolean }> = [];
    for (const r of rows) {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(r.value);
      } catch {
        continue;
      }
      const row = transmissionRowOf(parsed);
      if (!row) continue;
      const pending = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM outbox WHERE kind = 'transmission' AND ref_id = ?", row.id)?.n ?? 0;
      out.push({ ...row, synced: pending === 0 });
    }
    return out;
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
    // A device that never synced its staff (pairing, the first start offline): no manager can be checked here yet.
    if (this.cloud.posUsers().length === 0) return { ok: false, error: NO_ROSTER_TEXT };
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
  shopIdHere(): string | null {
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
      kioskZ: this.kioskZInfo(),
      offlineSince: this.offline.since,
      desktopExit: this.adminExitUser()
        ? { allowed: true, reason: null }
        : { allowed: false, reason: this.adminUserId ? `אין לך הרשאה: ${PERMISSION_LABEL}` : `נדרש מנהל עם הרשאת "${PERMISSION_LABEL}"` },
      cash: this.cashPay.configured() || this.cashPay.pending().length > 0
        ? {
            station: this.cashPay.station()?.name ?? null,
            address: this.cashPay.station()?.lanAddress ? `${this.cashPay.station()!.lanAddress}:${this.cashPay.station()!.port}` : null,
            usable: this.cashPay.usable(),
            reason: this.cashPay.offReason(),
            pending: this.cashPay.pending().map((p) => ({ txShort: shortTx(p.txId), amountAgorot: p.amountAgorot, startedAt: p.startedAt, final: p.finalState })),
          }
        : null,
      cashmag: this.cashmagAdmin(),
      // "מצב עבודה: קיוסק / קופה": the section exists only where the owner allowed it.
      workMode: this.workMode
        ? {
            enabled: this.workMode.view().enabled,
            mode: this.workMode.mode(),
            toTill: this.workMode.offered().toTill,
            toKiosk: this.workMode.offered().toKiosk,
            openerHolds: this.workMode.holds(this.adminUserId),
          }
        : undefined,
    };
  }

  /** "מכשיר מזומן CashMag" on the manager's screen: the settings in force and their source, what the staff must look at. */
  private cashmagAdmin(): AdminInfo['cashmag'] {
    if (!this.cashMag.enabled() && this.cashMag.journal().length === 0) return null;
    const cfg = this.cashMag.config();
    const st = this.cashMag.driverState();
    return {
      address: `${cfg.host || '—'}:${cfg.port || '—'}`,
      protocol: cfg.protocol === cfg.wire ? cfg.wire : `${cfg.wire} (מהענן: ${cfg.protocol})`,
      terminal: cfg.terminal,
      userCodeSet: cfg.userCode !== '',
      sources: cfg.sources,
      usable: this.cashMag.usable(),
      reason: this.cashMag.offReason(),
      connection: st?.connection ?? null,
      lastError: st?.lastError ?? null,
      unresolved: this.cashMag.unresolved().map((e) => ({
        txId: e.txId,
        txShort: shortTx(e.txId),
        amountAgorot: e.amountAgorot,
        startedAt: e.startedAt,
        outcome: e.outcome,
        heldAgorot: e.heldAgorot,
        reason: e.reason,
      })),
    };
  }

  /** The kiosk's Z mode on this device (core/kioskZ.ts): the shop's Z mode, the heartbeat's `independentTill` first. */
  private kioskZKind() {
    const beat = this.cloud.heartbeat();
    return kioskZKindOfDevice(beat.zMode, beat.independentTill === true);
  }

  /** A customer ordering or paying on the kiosk's screens (the kiosk side of the work mode's facts). */
  private kioskCustomerBusy(): boolean {
    const f = this.kioskSideFacts();
    return f.paying || f.ordering;
  }

  /**
   * "משמרת ו-Z" in the kiosk admin (pos-android ui/kiosk/KioskZPanel.kt KioskZAdminSection): a fiscal kiosk working as one
   * — its mode, the shift, an owed Z, and whether a customer holds it. Absent elsewhere (a till by role, a KDS, a bridge).
   */
  private kioskZInfo(): AdminInfo['kioskZ'] {
    if (!this.fiscalRole || !this.isKioskMode() || this.opts.bridge) return null;
    const kind = this.kioskZKind();
    return { kind, shiftOpen: !!this.ledger.currentShift(), owed: this.tillZ.owed && makesOwnZ(kind), customerBusy: this.kioskCustomerBusy() };
  }

  /** The device's side of the kiosk admin's close / Z (core/kioskZ.ts KioskZPort; Android ContainerKioskZPort). */
  private kioskZPort(): KioskZPort {
    return {
      cardInFlight: () => this.pay.cardInFlight,
      openShiftId: () => this.ledger.currentShift()?.id ?? null,
      pendingDocuments: (shiftId) => this.ledger.pendingInShift(shiftId),
      closeShift: async (shiftId, closedByName) => {
        if (this.ledger.currentShift()?.id !== shiftId) return { kind: 'changed' };
        // As the kiosk's own daily close: nobody counted a drawer it does not have (counted = expected).
        const r = this.ledger.closeShift({ closedByName, closedByUserId: this.adminUserId, vatRate: this.vatRate() });
        if (r.kind === 'pending') return { kind: 'pending', count: r.count };
        if (r.kind === 'none') return { kind: 'no_shift' };
        this.log(`kiosk admin: shift ${r.shift.id} closed by ${this.adminName ?? '-'} (${this.adminUserId ?? '-'})`);
        await this.sync.flush().catch(() => undefined);
        return { kind: 'closed', shiftId: r.shift.id };
      },
      transmit: async () => this.tillZ.setCardTransmission(await this.transmitBatch('z_close')),
      prepare: () => this.tillZ.prepare(),
      requestAndPrint: async (userId, userName) => {
        const z = await this.tillZ.produce(this.kioskZCloser(userName), false, null, userId);
        switch (z.kind) {
          case 'produced': {
            const n = Number(z.z.machineSequenceNumber ?? z.z.zNumber);
            return { kind: 'produced', number: Number.isFinite(n) ? n : 0, printError: null, printedHere: z.printedHere !== false };
          }
          case 'offline':
            return { kind: 'offline' };
          case 'waiting':
            return { kind: 'waiting', closing: this.ledger.closingCount() };
          case 'refused':
            if (z.refusal === 'nothing_to_report') return { kind: 'nothing' };
            // "אין מסמכים — אין צורך ב-Z": said in words, never the wire code.
            if (z.refusal === 'empty_z') return { kind: 'refused', detail: 'אין מסמכים — אין צורך ב-Z' };
            return { kind: 'refused', detail: z.refusal };
          case 'failed':
            return { kind: 'failed', detail: z.detail ?? `HTTP ${z.status}` };
        }
      },
      oweZ: () => this.tillZ.markOwed(),
    };
  }

  /** Who closed it, as the shop lock names it: the kiosk, then the manager who opened the admin. */
  private kioskZCloser(manager: string | null = this.adminName): string {
    return [closerName(this.operator()), manager].filter(Boolean).join(' · ');
  }

  /**
   * The kiosk admin's "סגירת משמרת" / "הפקת Z" by the kiosk's Z mode (KioskZRunner): never over a customer ordering or
   * paying, a card on the terminal or a pending payment; one at a time with the automatic close's own Z.
   */
  async kioskAdminZ(): Promise<KioskAdminZOutcome> {
    if (!this.kioskZInfo()) return { kind: 'failed', detail: 'הפעולה זמינה בקיוסק בלבד' };
    const kind = this.kioskZKind();
    const runner = new KioskZRunner(this.kioskZPort(), this.opts.kioskZPause, this.log);
    const busy = this.kioskCustomerBusy();
    const out = await this.tillZ.exclusive(() =>
      makesOwnZ(kind) ? runner.produceZ(busy, this.kioskZCloser(), this.adminUserId, this.adminName) : runner.closeShift(busy, this.kioskZCloser()),
    );
    void this.sync.kioskSync().catch(() => undefined);
    return out ?? { kind: 'blocked', block: 'running' };
  }

  /* ------------------------------------------------ "היסטוריית עסקאות" and "הדפסה חוזרת" */

  /** The cloud's rows of the last "ישנות יותר" asked, by local id: a reprint of one finds its document. */
  private cloudHistoryRows = new Map<string, HistoryOrder>();

  /** Bons print on this kiosk at all: its bon route is not "none" (core/kioskBonRoute.ts — "בון מטבח במדפסת הקיוסק"). */
  private bonsOn(): boolean {
    const kitchenConfig = this.kitchen.known() ? this.kitchen.config() : null;
    return windowsBonRouteFor(this.config().printing, kitchenConfig) !== 'none';
  }

  /** An order's item-ticket jobs as the history reads them: which ticket each printed, how it went, the page itself. */
  private ticketJobsOf(orderId: string): Array<TicketJob & { doc: TicketDoc }> {
    const out: Array<TicketJob & { doc: TicketDoc }> = [];
    for (const j of this.printQueue.jobsFor(orderId, 'ticket')) {
      try {
        const doc = JSON.parse(j.doc) as TicketDoc;
        out.push({ index: typeof doc.index === 'number' ? doc.index : null, count: typeof doc.count === 'number' ? doc.count : null, status: j.status, createdAt: j.created_at, doc });
      } catch {
        /* an unreadable page is no ticket */
      }
    }
    return out;
  }

  /**
   * An order's tickets and how each printed. A sale settled after a restart printed none on purpose ("שוחזר — הדפסה
   * חוזרת מהניהול"): its tickets, as its document earns them now, are all "לא הודפס".
   */
  private ticketStatusOf(o: HistoryOrder, doc: DocDraft | null): HistoryRow['tickets'] {
    const jobs = this.ticketJobsOf(o.localId);
    if (jobs.length > 0) return ticketStates(jobs);
    if (o.recovered && doc) {
      const n = this.itemTicketDocs(doc, o.transactionNumber, null).length;
      return Array.from({ length: n }, (_, i) => ({ index: i + 1, count: n, state: 'failed' as const, prints: 0 }));
    }
    return [];
  }

  /** "שובר פריט לא הודפס": [today]'s item tickets whose newest print the queue gave up on (looked at only when one failed). */
  private unprintedTicketsOf(today: readonly KioskOrder[]): number {
    if (today.length === 0 || this.printQueue.failedCountOf('ticket', Date.now() - 2 * 86_400_000) === 0) return 0;
    return today.reduce((n, o) => n + failedTickets(ticketStates(this.ticketJobsOf(o.localId))).length, 0);
  }

  /** The cloud's orders of this kiosk (`GET /sync/{m}/kiosk/orders`): the days before the week it keeps. */
  private async cloudHistory(until: string, days: number, query: string): Promise<{ state: AdminHistory['cloud']; orders: HistoryOrder[] }> {
    if (!this.machineId || !this.paired) return { state: 'failed', orders: [] };
    if (this.offlineNow) return { state: 'failed', orders: [] };
    const params = new URLSearchParams({ until, days: String(days) });
    if (query.trim()) params.set('q', query.trim().slice(0, 40));
    const reply = await this.api.get<unknown>(`sync/${this.machineId}/kiosk/orders?${params.toString()}`, { timeoutMs: 10_000 });
    if (reply.kind === 'offline') return { state: 'failed', orders: [] };
    // A server from before the route: 405 (the path takes POST only) or 404.
    if (reply.kind === 'refused') return { state: reply.status === 404 || reply.status === 405 ? 'unsupported' : 'failed', orders: [] };
    const orders = parseCloudOrders(reply.body);
    // The last answer only (at most the route's 500): what the screen lists now.
    this.cloudHistoryRows = new Map(orders.map((o) => [o.localId, o] as const));
    return { state: 'ok', orders };
  }

  /** One history row: the sale, how it was paid, how its receipt, bon and item tickets printed, what may print again. */
  private historyRow(o: HistoryOrder, kept: boolean, bonsOn: boolean): HistoryRow {
    const doc = o.transactionId ? this.ledger.doc(o.transactionId) : null;
    const receiptJobs = kept ? this.printQueue.jobsFor(o.localId, 'receipt').map((j) => ({ status: j.status, createdAt: j.created_at })) : [];
    return {
      localId: o.localId,
      at: o.createdAtMs,
      businessDate: o.businessDate,
      label: labelOf(o),
      pickupLabel: o.pickupLabel,
      number: o.transactionNumber,
      customerName: o.customerName,
      totalAgorot: o.totalAgorot + o.tipAgorot,
      payment: paymentText(doc, o),
      receipt: receiptText(receiptJobs, o.receiptStatus),
      bon: bonText(o),
      bonFailed: o.fulfillmentMode === 'BON' && o.bonStatus === 'failed',
      tickets: this.ticketStatusOf(o, doc),
      kinds: reprintKinds(o, bonsOn, { hasDocument: doc !== null && settled(doc), kept }),
      source: kept ? 'kiosk' : 'cloud',
    };
  }

  /**
   * "היסטוריית עסקאות" in the manager's menu: today (the default) or the week the kiosk keeps, or — "ישנות יותר" — the
   * cloud's month before it when it answers; one search for all (core/kioskReprint.ts search); the newest HISTORY_SHOWN.
   */
  async adminHistory(input: { days?: number; query?: string; older?: boolean }): Promise<AdminHistory> {
    if (!this.adminOk()) throw new Error('נדרש קוד מנהל');
    this.adminUntil = Date.now() + 5 * 60_000;
    const now = Date.now();
    const today = localDate(now);
    const older = input?.older === true;
    const days = older ? HISTORY_KEEP_DAYS : Number(input?.days) >= HISTORY_KEEP_DAYS ? HISTORY_KEEP_DAYS : HISTORY_DEFAULT_DAYS;
    const query = typeof input?.query === 'string' ? input.query.slice(0, 40) : '';
    const local = this.orders.all();
    const bonsOn = this.bonsOn();
    let found: HistoryOrder[];
    let cloud: AdminHistory['cloud'] = 'off';
    if (older) {
      // What the kiosk still keeps of those days (its own, with how each page printed), and the cloud's.
      const week = new Set(recent(local, today, HISTORY_KEEP_DAYS).map((o) => o.localId));
      const keptOlder = local.filter((o) => o.paid && !week.has(o.localId));
      const fetched = await this.cloudHistory(shiftDay(today, -HISTORY_KEEP_DAYS), CLOUD_HISTORY_DAYS, query);
      cloud = fetched.state;
      found = searchHistory(mergeHistory(keptOlder, fetched.orders.filter((o) => !week.has(o.localId))), query);
    } else {
      found = searchHistory(recent(local, today, days), query);
    }
    const keptIds = new Set(local.map((o) => o.localId));
    const lb = lastBon(local, bonsOn);
    return {
      days,
      older,
      query,
      rows: found.slice(0, HISTORY_SHOWN).map((o) => this.historyRow(o, keptIds.has(o.localId), bonsOn)),
      total: found.length,
      cloud,
      alone: reprintAlone(this.cloud.posUsers(), this.shopIdHere(), this.adminUserId),
      bonsOn,
      lastBon: lb ? { localId: lb.localId, label: labelOf(lb) } : null,
      unprintedTickets: this.unprintedTicketsOf(this.orders.todays(today)),
      log: parseLog(this.kv.get(REPRINT_LOG))
        .filter((e) => e.businessDate === today)
        .reverse()
        .slice(0, 30)
        .map((e) => ({ at: e.atMs, kind: e.kind, label: e.pickupLabel ?? (e.documentNumber ? `#${e.documentNumber}` : null), by: e.by, tickets: e.tickets ?? null, ...(e.failed ? { failed: true } : {}) })),
    };
  }

  /**
   * Who reprints (KioskReprintPanel `alone` / LocalManagerSheet): the manager who opened the menu when their role allows
   * "הדפסה חוזרת", else another manager's code with it ([code]; none yet → `needsCode`). Checked on the device.
   */
  private async reprintApprover(code?: string): Promise<{ ok: true; by: string | null; byId: string | null } | { ok: false; result: AdminActionResult }> {
    const roster = this.cloud.posUsers();
    if (reprintAlone(roster, this.shopIdHere(), this.adminUserId)) return { ok: true, by: this.adminName, byId: this.adminUserId };
    if (typeof code !== 'string' || code.trim() === '') return { ok: false, result: { ok: false, needsCode: true, message: REPRINT_TEXT.needsManager } };
    const d = await decideApprover({
      users: roster,
      shopId: this.shopIdHere(),
      code,
      lock: this.kv.getJson<ExitLock>(REPRINT_LOCK),
      nowMs: Date.now(),
      compare: (p, h) => bcrypt.compare(p, h),
    });
    this.kv.setJson(REPRINT_LOCK, d.lock);
    if (d.outcome === 'granted' && d.user) return { ok: true, by: displayName(d.user), byId: d.user.id };
    return { ok: false, result: { ok: false, needsCode: true, message: d.message ?? REPRINT_TEXT.needsManager } };
  }

  /** The cloud's "הדפסה חוזרת" event (`reprint`) and the day's log — whether or not the paper came out: it was asked for. */
  private recordReprint(
    kind: ReprintKind,
    order: Pick<HistoryOrder, 'localId' | 'pickupLabel' | 'transactionNumber' | 'transactionId'>,
    who: { by: string | null; byId: string | null },
    extra: { failed?: boolean; tickets?: number[] | null; only?: 'all' | 'failed'; last?: boolean } = {},
  ) {
    const now = Date.now();
    const details = eventDetails(kind, order, who.by, who.byId, this.adminName, {
      failed: extra.failed === true,
      ...(extra.tickets ? { tickets: extra.tickets } : {}),
      ...(extra.only ? { only: extra.only } : {}),
      ...(extra.last ? { last: true } : {}),
    });
    this.recordTillEvent({
      id: randomUUID(),
      type: 'reprint',
      occurredAt: new Date(now).toISOString(),
      shiftId: this.ledger.currentShift()?.id ?? null,
      posUserId: who.byId,
      ...(order.transactionId && UUID_RE.test(order.transactionId) ? { transactionId: order.transactionId } : {}),
      details,
    });
    this.kv.set(
      REPRINT_LOG,
      appendLog(parseLog(this.kv.get(REPRINT_LOG)), {
        atMs: now,
        businessDate: localDate(now),
        kind,
        orderId: order.localId,
        pickupLabel: order.pickupLabel,
        documentNumber: order.transactionNumber,
        by: who.by,
        ...(extra.tickets ? { tickets: extra.tickets } : {}),
        ...(extra.failed ? { failed: true } : {}),
      }),
    );
    this.log(`kiosk reprint: ${kind} of ${order.localId} by ${who.by ?? '?'}${extra.failed ? ' — nothing printed' : ''}`);
  }

  /**
   * "הדפסה חוזרת" of one sale from the history: the item tickets (the very pages, each "הדפסה חוזרת" — all of them, or
   * only those that did not print; a sale with no ticket printed here: drawn from its document), the invoice's copy
   * ("העתק"), the kitchen bon ("הדפסה חוזרת"). What cannot print is said before any code is asked.
   */
  private async adminReprint(kind: ReprintKind, orderId: string, only: 'all' | 'failed', code?: string): Promise<AdminActionResult> {
    const kept = this.orders.get(orderId);
    const order: HistoryOrder | null = kept ?? this.cloudHistoryRows.get(orderId) ?? null;
    if (!order || !order.paid) return { ok: false, message: 'ההזמנה לא נמצאה' };
    const doc = order.transactionId ? this.ledger.doc(order.transactionId) : null;
    const hasDoc = doc !== null && settled(doc);
    if ((kind === 'item_tickets' || kind === 'invoice_copy') && !hasDoc) return { ok: false, message: REPRINT_TEXT.noDocument };
    if (kind === 'kitchen_bon' && !kept) return { ok: false, message: REPRINT_TEXT.notOnKiosk };
    if (kind === 'kitchen_bon' && order.fulfillmentMode !== 'BON') return { ok: false, message: 'ההזמנה הלכה למסך המטבח — אין לה בון' };
    const jobs = kind === 'item_tickets' ? this.ticketJobsOf(orderId) : [];
    if (kind === 'item_tickets' && only === 'failed' && !(jobs.length === 0 && order.recovered) && ticketsToReprint(jobs, 'failed').length === 0) {
      return { ok: false, message: REPRINT_TEXT.noFailedTickets };
    }
    const who = await this.reprintApprover(code);
    if (!who.ok) return who.result;
    let failure: string | null = null;
    let tickets: number[] | null = null;
    if (kind === 'item_tickets') {
      if (jobs.length > 0) {
        const slots = ticketsToReprint(jobs, only);
        for (const s of slots) this.printQueue.enqueue('ticket', orderId, { ...s.latest.doc, index: s.index, count: s.count, notice: REPRINT_TEXT.notice });
        tickets = slots.map((s) => s.index);
      } else {
        // None printed here (a sale settled after a restart, or before the jobs kept): drawn again from its document.
        const pages = this.itemTicketDocs(doc!, order.transactionNumber, REPRINT_TEXT.notice);
        for (const page of pages) this.printQueue.enqueue('ticket', orderId, page);
        tickets = pages.map((_, i) => i + 1);
      }
      if (tickets.length === 0) failure = REPRINT_TEXT.noTickets;
    } else if (kind === 'invoice_copy') {
      if (kept) this.printReceipt(orderId, true);
      else this.printQueue.enqueue('receipt', orderId, this.receiptDocFor(doc!, true, this.config().printing.orderNumberOnReceipt ? order.pickupLabel : null));
    } else {
      this.printBon(orderId, true);
      const after = this.orders.get(orderId);
      // Not on this kiosk ("בון מטבח במדפסת הקיוסק" off), or no printer takes it: said, not "sent".
      if (!this.bonsOn()) failure = BON_NOT_ON_KIOSK;
      else if (after?.bonStatus === 'failed') failure = after.bonDetail ?? 'הבון לא הודפס';
    }
    this.recordReprint(kind, order, who, { failed: failure !== null, tickets, ...(kind === 'item_tickets' ? { only } : {}) });
    if (kept && kind === 'kitchen_bon' && this.machineId) void this.orders.push(this.api, this.machineId);
    this.dirty();
    return { ok: failure === null, message: failure ?? REPRINT_TEXT.done };
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
      // Every reprint is "הדפסה חוזרת" (core/kioskReprint.ts): under REPRINT, recorded — the old buttons too.
      case 'reprint':
        return this.adminReprint(a.kind, a.orderId, a.only === 'failed' ? 'failed' : 'all', a.code);
      case 'reprintBon':
        return this.adminReprint('kitchen_bon', a.orderId, 'all', a.code);
      case 'reprintReceipt':
        return this.adminReprint('invoice_copy', a.orderId, 'all', a.code);
      case 'reprintLastBon': {
        // "הדפס שוב את הבון האחרון": the newest sale's bon — failed, or out and torn — marked "הדפסה חוזרת".
        const o = lastBon(this.orders.all(), this.bonsOn());
        if (!o) return { ok: false, message: REPRINT_TEXT.noLastBon };
        const r = await this.adminReprint('kitchen_bon', o.localId, 'all', a.code);
        return r.ok ? { ...r, message: REPRINT_TEXT.lastBonDone(labelOf(o)) } : r;
      }
      case 'reprintLast': {
        // Today's last document — a kiosk order's or a till sale's — on paper again, marked "העתק" (never a new number).
        const last = this.ledger.todaysDocs(localDate(Date.now()))[0];
        if (!last) return { ok: false, message: 'אין עסקאות היום' };
        const who = await this.reprintApprover(a.code);
        if (!who.ok) return who.result;
        this.printDocReceipt(last, true);
        const number = formatDocNumber(last.prefix, String(last.number));
        const order = last.orderId ? this.orders.get(last.orderId) : null;
        this.recordReprint('invoice_copy', { localId: order?.localId ?? last.orderId ?? last.id, pickupLabel: order?.pickupLabel ?? null, transactionNumber: number, transactionId: last.id }, who, { last: true });
        return { ok: true, message: `נשלח להדפסה: ${number} (העתק)` };
      }
      case 'testPrint':
        await this.lookForPrinter();
        this.printQueue.enqueue('test', null, slipDoc({ businessName: 'בדיקת מדפסת', pickupLabel: 'TEST', service: 'take_away', itemCount: 0, totalAgorot: 0 }));
        return { ok: true };
      case 'retryPrints':
        // An item ticket is exchanged for goods: it prints again only as its order's reprint ("שובר פריט", marked).
        this.printQueue.retryFailed(undefined, ['ticket']);
        // The kitchen's too (main/kitchen): a person's "נסה שוב" — a ticket that may be on paper goes marked.
        this.kitchen.retryAll();
        return { ok: true };
      case 'kioskZ': {
        const out = await this.kioskAdminZ();
        this.dirty();
        return { ok: kioskZOutcomeOk(out), message: kioskZOutcomeText(out) };
      }
      case 'cashmagAcknowledge': {
        const ok = this.cashMag.acknowledge(a.txId, this.adminName ?? 'מנהל');
        this.dirty();
        return { ok, message: ok ? 'סומן כטופל' : 'העסקה לא נמצאה' };
      }
      case 'cashmagCheck':
        await this.cashMag.probe();
        await this.settleCashMag();
        return { ok: this.cashMag.usable(), message: this.cashMag.offReason() ?? 'שרת CashMag זמין' };
      case 'cashRecheck':
        if (this.cashMag.enabled()) {
          await this.cashMag.probe();
          await this.settleCashMag();
        }
        await this.cashPay.refreshStatus();
        await this.settleCash();
        return { ok: this.cashPay.pending().length === 0, message: this.cashPay.pending().length === 0 ? 'אין תשלומי מזומן פתוחים' : 'מכשיר המזומן לא ענה — ננסה שוב' };
      case 'checkTerminal':
        if (this.pay.noCard) return { ok: false, message: NO_CARD_TEXT };
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
      // "מצב עבודה": to the till — the kiosk side first (never over a customer's order or payment), then always a manager's
      // code with KIOSK_TILL_MODE: the one that opened this menu counts when it holds it, else the code typed on the pad.
      case 'workMode': {
        const wm = this.workMode;
        // Back to the kiosk from the corner over the till: the till side's checks (an open sale, a payment), the same code.
        if (a.mode === 'kiosk') {
          if (!wm || !wm.offered().toKiosk) return { ok: false, refusal: 'disabled', message: REFUSAL_TEXT.disabled };
          const back = wm.mayReturn();
          if (back) return { ok: false, refusal: back.wire, message: back.text };
          let who: string | null = this.adminName;
          let whoId: string | null = this.adminUserId;
          if (!wm.holds(this.adminUserId)) {
            if (typeof a.code !== 'string' || a.code.trim() === '') return { ok: false, needsCode: true, message: WORK_TEXT.needsManagerToKiosk };
            const c = await wm.checkManagerCode(a.code);
            if (!c.ok) return { ok: false, needsCode: true, message: c.message };
            who = c.name;
            whoId = c.id;
          }
          const refusedBack = await wm.returnToKiosk('manual', who, whoId);
          if (refusedBack) return { ok: false, refusal: refusedBack.wire, message: refusedBack.text };
          return { ok: true };
        }
        if (!wm || !wm.offered().toTill) return { ok: false, refusal: 'disabled', message: REFUSAL_TEXT.disabled };
        const refusal = wm.mayEnter();
        if (refusal) return { ok: false, refusal: refusal.wire, message: refusal.text };
        let by: string | null = this.adminName;
        let byId: string | null = this.adminUserId;
        if (!wm.holds(this.adminUserId)) {
          if (typeof a.code !== 'string' || a.code.trim() === '') return { ok: false, needsCode: true, message: WORK_TEXT.needsManager };
          const c = await wm.checkManagerCode(a.code);
          if (!c.ok) return { ok: false, needsCode: true, message: c.message };
          by = c.name;
          byId = c.id;
        }
        const refused = await wm.enterTill(by, byId, 'manual');
        if (refused) return { ok: false, refusal: refused.wire, message: refused.text };
        // The admin was the kiosk's: it does not outlive the switch.
        this.adminUntil = 0;
        return { ok: true };
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

  /**
   * A till event: kept here, and to the cloud through the outbox (`POST /sync/{m}/events`). The desktop exits also
   * go into the device's own log; "מצב עבודה" switches (`kiosk_till_mode`, recordWorkModeEvent) keep their own.
   */
  private recordTillEvent(e: TillEventRecord | TillEngineEvent) {
    this.kv.setJson(`tillEvent:${e.id}`, e);
    if (e.type === 'desktop_exit') this.kv.setJson(DESKTOP_LOG, [...this.desktopExitLog(), e].slice(-100));
    if (this.paired) this.outbox.enqueue('till_event', e.id);
  }

  /** A till event of the till's engine (`POST /sync/{m}/events`): `held_sale_cancelled`, `line_void`, `shift_auto_closed`… */
  recordEngineEvent(e: TillEngineEvent) {
    this.recordTillEvent(e);
  }

  /**
   * "סגירת משמרת אוטומטית גם עם עגלה פתוחה" (core/till/autoCloseCart.ts): the till's engine registers its tick; the
   * half-minute tick runs it on a till by role (a kiosk's own automatic close is tillZService.tick).
   */
  private tillAutoClose: (() => Promise<unknown>) | null = null;

  attachTillAutoClose(fn: (() => Promise<unknown>) | null) {
    this.tillAutoClose = fn;
  }

  /**
   * "מצב עבודה: קיוסק / קופה": one switch as the till event `kiosk_till_mode` (core/workMode.ts eventDetails) — the
   * user who switched it, the open shift, kept on the device (the last 100) and sent to the cloud with the outbox.
   */
  recordWorkModeEvent(details: Record<string, unknown>, posUserId: string | null): WorkModeEvent {
    const e = workModeEvent({ id: randomUUID(), atMs: Date.now(), shiftId: this.ledger.currentShift()?.id ?? null, posUserId, details });
    this.recordTillEvent(e);
    this.kv.setJson(WORK_MODE_LOG, [...this.workModeLog(), e].slice(-100));
    return e;
  }

  /** The device's own log of the last mode switches. */
  workModeLog(): WorkModeEvent[] {
    return this.kv.getJson<WorkModeEvent[]>(WORK_MODE_LOG) ?? [];
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
        if (this.pay.noCard) return { ok: false, message: NO_CARD_TEXT };
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
        this.workSessions.clear();
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
