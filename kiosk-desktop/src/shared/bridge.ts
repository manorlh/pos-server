/**
 * The contract between the kiosk's screens (renderer) and its local service (main process).
 * The screens never reach the network: everything they show comes from here, from local data.
 */

import type { MealSlot } from '@dash-lib/kioskMoney';
import type { PaymentMethod } from '@dash-lib/kioskConfig';
import type { VoucherLeg } from '@dash-lib/kioskWebOrders';
import type { VoucherResult } from '../main/kiosk/payAtTill';
import type { KCategory, KGroup, KProduct } from '../main/kiosk/catalog';
import type { FunnelEvent } from '../core/kioskFunnel';
import type { BatteryAlertView } from '../core/batteryAlerts';

export type KioskPhase = 'unpaired' | 'waiting' | 'kiosk';

export interface KioskView {
  phase: KioskPhase;
  /** The kiosk's own build. */
  appVersion: string;
  machine: {
    machineId: string;
    name: string | null;
    shopName: string | null;
    companyName: string | null;
    posNumber: string | null;
    serverUrl: string | null;
  } | null;
  /** The effective config as the cloud resolved it; every MediaRef pointing at the local copy (or null). */
  config: Record<string, unknown> | null;
  configVersion: string | null;
  /** @font-face for the theme's font, from the local file (or null: the device font). */
  fontFace: string | null;
  fontFamily: string | null;
  brandName: string;
  catalog: {
    categories: KCategory[];
    products: KProduct[];
    groups: Record<string, KGroup[]>;
    quickNotes: Record<string, string[]>;
    upsells: Array<{ triggerType: string; triggerIds: string[]; productIds: string[]; categoryIds: string[]; prompt: string | null }>;
    /** Kiosk category pictures (local) by category id. */
    categoryImages: Record<string, string>;
    /** The meals' slots by meal product id (client/src/lib/kioskMoney.ts MealSlot). */
    meals: Record<string, MealSlot[]>;
    /** The promotions as the cloud sent them (kioskMoney.ts promotionsOf reads them): the basket is priced with them. */
    promotions: Array<Record<string, unknown>>;
  };
  state: {
    paused: boolean;
    pausedMessage: string | null;
    pausedUntil: string | null;
    /** The kiosk's terminal cannot charge (none / unreachable). */
    noPayment: boolean;
    terminal: string;
    offline: boolean;
    offlineSince: number | null;
    /** A payment's outcome is unknown: every card blocked until staff settle it. */
    cardBlocked: boolean;
  };
  staff: {
    unprintedBons: number;
    printer: string;
    pendingUploads: number;
    mediaMissing: number;
  };
  /**
   * "איך תרצו לשלם?" (payment.methods, SPEC_KIOSK §23): the methods configured, what this kiosk can take
   * now (the card through its terminal, a voucher online, cash at the till always), and why the card
   * cannot (Hebrew), else null.
   */
  pay: { methods: PaymentMethod[]; usable: PaymentMethod[]; cardOff: string | null };
}

/** "מזומן בקופה": the order to the tills, with the vouchers already redeemed towards it. */
export interface PlaceOrderIn extends StartPaymentIn {
  vouchers: VoucherLeg[];
}

export type PlaceOrderOut =
  | { ok: true; localId: string; pickupLabel: string; vouchers: VoucherLeg[]; dueAgorot: number; pending: boolean; code: string }
  | { ok: false; reason: 'changed'; changes: BasketChange[]; totalAgorot?: number }
  | { ok: false; reason: 'empty' | 'rejected' | 'error'; message: string };

export type { VoucherResult };

export interface OrderLineIn {
  key: string;
  productId: string;
  qty: number;
  /** The choices, in the order picked: a quantity and "מעט / הרבה / בצד" where the group allows them. */
  options: Array<{ groupId: string; optionId: string; qty?: number; pre?: 'lite' | 'extra' | 'side' | null }>;
  notes: string[];
  /** The unit price (with its options, agorot) the screen showed: the pre-payment check compares it (core/basketCheck.ts). */
  unitAgorot?: number;
  /** A meal: the product chosen in each slot (each on its own defaults) — priced here from the catalog. */
  meal?: { components: Array<{ slotId: string; productId: string }> } | null;
}

export interface StartPaymentIn {
  lines: OrderLineIn[];
  /** Null: "ללא סוג שירות" — the order has none. */
  service: 'take_away' | 'eat_in' | null;
  customerName: string | null;
  customerPhone: string | null;
  tableRef: string | null;
  tipPct: number | null;
  /** "סכום אחר": the customer's own tip in agorot (whole shekels, up to the order's total); wins over tipPct. */
  tipAgorot: number | null;
  /** The goods' total the customer saw (agorot), after the promotions: never charged if it moved (core/basketCheck.ts). */
  expectedTotalAgorot?: number;
}

/** `key`: the basket line; `from` / `to`: its unit price, agorot (core/basketCheck.ts). */
export type BasketChange =
  | { kind: 'removed'; productId: string; name: string; key?: string }
  | { kind: 'repriced'; productId: string; name: string; key?: string; from: number; to: number };

export type StartPaymentOut =
  | { ok: true; orderId: string; amountAgorot: number }
  /** `totalAgorot`: the goods' total now — shown to the customer, who confirms before anything is charged. */
  | { ok: false; reason: 'changed'; changes: BasketChange[]; totalAgorot?: number }
  | { ok: false; reason: 'terminal' | 'unresolved' | 'busy' | 'empty' | 'no_shift' | 'error'; message: string };

export type PayPhase = 'starting' | 'charging' | 'approved' | 'declined' | 'unknown';

export interface PayProgress {
  orderId: string;
  phase: PayPhase;
  message: string | null;
  amountAgorot: number;
  canCancel: boolean;
  cancelling: boolean;
  /** On approval. */
  pickupLabel?: string;
  documentNumber?: string;
  receipt?: 'ask' | 'printing' | 'printed' | 'declined' | 'none' | 'failed';
}

/** "צימוד מסוף SynqPay" (pos-server docs/SPEC_SYNQPAY.md §2.2): where the pairing stands. */
export interface SynqpayPairingView {
  phase: 'idle' | 'need_serial' | 'awaiting_code' | 'expired' | 'paired' | 'failed';
  serial: string | null;
  /** awaiting_code: when the code on the terminal runs out (epoch ms). */
  expiresAtMs: number;
  error: string | null;
  upload: 'uploaded' | 'needs_approval' | 'offline' | 'refused' | null;
}

/** The kiosk's SynqPay terminal and its key (never the key itself). */
export interface SynqpayAdminInfo {
  paired: boolean;
  /** No key, or the terminal refused it: "המסוף דורש צימוד". */
  needsPairing: boolean;
  /** Paired here, not in the cloud yet. */
  pendingUpload: boolean;
  serialNumber: string | null;
  pairing: SynqpayPairingView;
}

export interface AdminInfo {
  operator: { id: string; name: string } | null;
  shift: { open: boolean; number: number | null; openedAt: string | null };
  terminal: {
    kind: string | null;
    address: string | null;
    state: string;
    lastOkAt: number | null;
    lastError: string | null;
    unresolved: Array<{ reference: string; amountAgorot: number; startedAt: string; note: string | null }>;
    /** Only on an external SynqPay terminal. */
    synqpay?: SynqpayAdminInfo | null;
    /** "עקיפת בדיקת מספר מסוף" is on for this kiosk: the card lock's number check is off. */
    numberCheckBypass?: boolean;
  };
  printer: {
    target: string;
    health: string;
    lastError: string | null;
    queues: string[];
    /** "מדפסת USB: <name> מחוברת / לא נמצאה / נמצא מכשיר בלי דרייבר — …" (main/printer/usbPrinters.ts). */
    usb?: string | null;
    /** The target is found by itself ("אוטומטי": no Windows queue set). */
    auto?: boolean;
  };
  sync: { lastBeatOkAt: number | null; lastKioskSyncAt: number | null; lastError: string | null; outbox: number; configVersion: string | null };
  media: { files: number; bytes: number; missing: number };
  orders: Array<{ localId: string; label: string | null; at: number; totalAgorot: number; bon: string; receipt: string; number: string | null }>;
  zs: Array<{ number: number; closedAt: string; state: string }>;
  zOwed: boolean;
  zMode: string;
  offlineSince: number | null;
}

export interface TechnicianInfo {
  machine: KioskView['machine'];
  deviceRole: string | null;
  shopName: string | null;
  companyName: string | null;
  network: { online: boolean; lastBeatOkAt: number | null; serverUrl: string | null; interfaces: Array<{ name: string; address: string }> };
  printer: AdminInfo['printer'];
  terminal: AdminInfo['terminal'];
  /** The updater (main/update/updater.ts); `status` is its phase (shared/roles.ts UpdatePhase). */
  update: {
    current: string;
    available: string | null;
    status: string;
    message?: string | null;
    progress?: number | null;
    lastCheckAt?: number | null;
    autoInstall?: boolean;
    installWindow?: { start: string; end: string } | null;
  };
  quickSupport: string | null;
}

export interface KioskEvents {
  view: KioskView;
  pay: PayProgress;
  toast: { text: string; tone: 'info' | 'warn' | 'error' };
}

/** What the screens may ask (ipcRenderer.invoke under the hood). */
export interface KioskBridge {
  bootstrap(): Promise<KioskView>;
  pair(input: { serverUrl: string; code: string; machineName: string }): Promise<{ ok: true } | { ok: false; error: string }>;
  reportFlow(input: { flowState: string; screen: string; busy: boolean; idle: boolean }): void;
  /** "ביצועי קיוסקים": the funnel's events (core/kioskFunnel.ts), kept and sent to the cloud by the service. */
  funnel?(events: FunnelEvent[]): void;
  /** "סוללה חלשה": the battery as the screen reads it → what to show and whether to sound the alarm (core/batteryAlerts.ts). */
  battery?(reading: { percent: number | null; charging: boolean }): Promise<BatteryAlertView>;
  startPayment(input: StartPaymentIn): Promise<StartPaymentOut>;
  /** "מזומן בקופה": the order to the shop's tills (no document here); absent where the kiosk cannot. */
  placeOpenOrder?(input: PlaceOrderIn): Promise<PlaceOrderOut>;
  /** A prepaid voucher redeemed online for the basket's goods (`clientRequestId`: a retry never redeems twice). */
  redeemVoucher?(input: { code: string; basket: StartPaymentIn; earlier: VoucherLeg[]; forfeitRest?: boolean; clientRequestId: string }): Promise<VoucherResult>;
  /** A redeemed voucher back on itself (kept and retried until the cloud answers). */
  reverseVoucher?(redemptionId: string): Promise<void>;
  cancelPayment(): Promise<void>;
  receiptChoice(orderId: string, print: boolean): Promise<void>;
  /** "עזרה": a help request to the tills (an alert on the next sync). */
  helpRequest(): Promise<void>;
  adminUnlock(pin: string): Promise<{ ok: true; name: string } | { ok: false; error: string }>;
  adminInfo(): Promise<AdminInfo>;
  adminAction(action: AdminAction): Promise<AdminActionResult>;
  technicianUnlock(code: string): Promise<{ outcome: 'granted' | 'wrong' | 'locked_out' | 'locked'; triesLeft: number; lockedForMs: number }>;
  technicianInfo(): Promise<TechnicianInfo>;
  technicianAction(action: TechnicianAction): Promise<{ ok: boolean; message?: string }>;
  on<K extends keyof KioskEvents>(event: K, fn: (payload: KioskEvents[K]) => void): () => void;
}

export type AdminAction =
  | { type: 'syncNow' }
  | { type: 'pause'; paused: boolean }
  | { type: 'reprintBon'; orderId: string }
  | { type: 'reprintReceipt'; orderId: string }
  | { type: 'testPrint' }
  | { type: 'checkTerminal' }
  | { type: 'recheckPayment'; reference: string }
  | { type: 'markNotApproved'; reference: string }
  | { type: 'retryPrints' }
  | { type: 'exitKiosk' }
  /** "צימוד מסוף SynqPay": `pair` (the first code, or "שלח קוד חדש"); the serial when the kiosk cannot tell it. */
  | { type: 'synqpayPair'; serialNumber?: string | null }
  /** The 6 digits from the terminal's screen. */
  | { type: 'synqpayCode'; otp: string }
  /** The paired key to the cloud again. */
  | { type: 'synqpayRetryUpload' };

export interface AdminActionResult {
  ok: boolean;
  message?: string;
  /** SynqPay's pairing actions: where it stands now. */
  pairing?: SynqpayPairingView;
}

export type TechnicianAction =
  | { type: 'printerTest' }
  | { type: 'setPrinter'; transport: 'spooler' | 'tcp'; queueName?: string; host?: string; port?: number }
  | { type: 'pinpadCheck' }
  | { type: 'updateCheck' }
  | { type: 'updateInstall' }
  | { type: 'quickSupport' }
  | { type: 'setZoom'; zoom: number }
  | { type: 'unpair' };
