/**
 * The contract between the kiosk's screens (renderer) and its local service (main process).
 * The screens never reach the network: everything they show comes from here, from local data.
 */

import type { KioskMenuState } from '@dash-lib/kioskMenus';
import type { KioskUpsellRule } from '@dash-lib/kioskUpsellRules';
import type { MealSlot } from '@dash-lib/kioskMoney';
import type { PaymentMethod } from '@dash-lib/kioskConfig';
import type { VoucherLeg } from '@dash-lib/kioskWebOrders';
import type { StartVouchers, VoucherResult } from '@dash-lib/kioskVoucherClient';
import type { AppliedDiscountVoucher } from '@dash-lib/kioskVouchers';
import type { KCategory, KGroup, KProduct } from '../main/kiosk/catalog';
import type { FunnelEvent } from '../core/kioskFunnel';
import type { BatteryAlertView } from '../core/batteryAlerts';
import type { CloseDayKind } from '@dash-lib/shopActive';

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
    /**
     * "תפריטים": the menu active now by this kiosk's own clock — the screens order by it and name it in the title
     * (client lib/kioskMenus.ts `withMenuOrder`, `titleWithMenu`). Absent (the Android bundle's bridge): no menu.
     */
    menu?: KioskMenuState;
    /** What the active menu holds back (still sold by the catalog): known to a basket line already in, and to a meal's components. */
    held?: KProduct[];
    groups: Record<string, KGroup[]>;
    quickNotes: Record<string, string[]>;
    /** "הערה עם תמונה": a note chip's picture (local) by its text; absent (the Android bundle's bridge): none. */
    noteImages?: Record<string, string>;
    upsells: Array<{ triggerType: string; triggerIds: string[]; productIds: string[]; categoryIds: string[]; prompt: string | null }>;
    /** "הגדלת מכירה": the menu's rules as the Android kiosk reads them (client lib/kioskUpsellRules.ts); absent: none. */
    upsellRules?: KioskUpsellRule[];
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
    /** Why there is no payment: offline with "חסימת הזמנות כשאין אינטרנט" on, or no terminal (null: there is). */
    noPaymentReason?: 'offline' | 'terminal' | null;
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
  pay: {
    methods: PaymentMethod[];
    usable: PaymentMethod[];
    cardOff: string | null;
    /** "מזומן" at the cash station: why its tile is off now (Hebrew), else null / absent. */
    cashOff?: string | null;
  };
  /**
   * "סניף לא פעיל" (client lib/shopActive.ts): false — the shop was turned off in the cloud; the
   * screens lock once the customer on them is done, until it is on again. Absent (the Android
   * bundle's bridge: the APK draws its own lock) is active.
   */
  shopActive?: boolean;
  /** "סגירת משמרת ו-Z" from that lock: what the kiosk's own close would be now; null — nothing to close. */
  closeDay?: CloseDayKind | null;
}

/** "סגירת משמרת ו-Z" on the shop's lock: done (or done later by itself), or why not, in Hebrew. `wrongCode`: the pad asks again. */
export interface ShopLockCloseDayOut {
  ok: boolean;
  message: string;
  wrongCode?: boolean;
}

/** "מזומן בקופה": the order to the tills, with the vouchers already redeemed towards it. */
export interface PlaceOrderIn extends Omit<StartPaymentIn, 'vouchers'> {
  vouchers: VoucherLeg[];
  /** Discount vouchers held for the order: it is paid here, never handed to a till (refused while one is on it). */
  discounts?: AppliedDiscountVoucher[];
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
  /**
   * "תפריטים" (client lib/kioskMenus.ts `menuMemoryOf`): the dish's own price as the line was added at — the active menu's
   * while one priced it — the catalog's price then, the menu and where the price came from. An open basket keeps its
   * prices when the menu changes under it: the check keeps `listAgorot` while the catalog's price has not moved.
   */
  listAgorot?: number;
  catalogAgorot?: number;
  menuId?: string;
  priceSource?: 'menu' | 'catalog';
  /**
   * A meal: the product chosen in each slot with its choices (its defaults, or a required choice answered in
   * the meal window; absent: its defaults) — priced here from the catalog.
   */
  meal?: { components: Array<{ slotId: string; productId: string; options?: Array<{ groupId: string; optionId: string; qty?: number; pre?: 'lite' | 'extra' | 'side' | null }> }> } | null;
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
  /** The goods' total the customer saw (agorot), after the promotions and the discount vouchers: never charged if it moved (core/basketCheck.ts). */
  expectedTotalAgorot?: number;
  /**
   * The vouchers of the order ("שוברי הנחה" held for it, goods vouchers as legs): the sale is priced with the first and
   * the second pay part of it — the card is charged what is left, and nothing at all when they pay it whole.
   */
  vouchers?: StartVouchers;
  /** How the rest is paid: the card (default) or "מזומן" at the shop's cash station (P:/specs/cash-paylink.md §11.6). */
  method?: 'card' | 'cash_device';
  /** Cash credits ("זיכוי להזמנה הבאה", P:/specs/cash-paylink.md §11.15א) redeemed for this order: legs towards the goods. */
  credits?: CashCreditLegIn[];
}

/** A cash credit redeemed towards the order (the cloud's redemption): its code and what it pays. */
export interface CashCreditLegIn {
  redemptionId: string;
  code: string;
  amountAgorot: number;
}

/** `redeemCashCredit`: the credit taken for this order, or why not (Hebrew). */
export type CashCreditResult = { ok: true; credit: CashCreditLegIn & { remainingAgorot: number } } | { ok: false; error: string };

/** §11.15א: what the customer does with change the cash station could not pay. */
export type CashOwedChoice = 'slip' | 'credit' | 'tip';

/** "voucherApply" (Android, pos-android KioskWebProtocol.parseVoucher): the code scanned or typed, and the basket as "לתשלום" sends it. */
export interface VoucherApplyIn {
  code: string;
  payment: StartPaymentIn;
}

/** One voucher on the order as the APK words it: "שובר מס׳ 0008 · ארוחה", its amount, what it covered. */
export interface AppliedVoucher {
  serial: number;
  title: string;
  /** How the order books it: `discount` (a deduction), `payment` (a tender) or `zero`. */
  mode: string;
  amountAgorot: number;
  /** What it covered ("מנה: נקניקייה ×1"); empty for a plain amount. */
  lines: string[];
}

/**
 * The APK's answer to voucherApply / voucherRemove — the order's vouchers as they stand: "סה״כ"
 * (`totalAgorot`; null with no production voucher on it), "קיזוז שוברי הפקה" (`deductionAgorot`),
 * each voucher, and "סה״כ לתשלום" (`dueAgorot`, the tip included). `error`: why this code was not
 * taken, `note`: what to tell the customer — both Hebrew, as the APK words them.
 */
export interface VoucherAnswer {
  ok: boolean;
  error: string | null;
  note: string | null;
  totalAgorot: number | null;
  deductionAgorot: number;
  dueAgorot: number;
  vouchers: AppliedVoucher[];
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
  /**
   * The terminal is in offline (deferred) mode (P:/specs/nayax-deferred-all.md §13): "כרטיסי תייר, דיירקט
   * ודביט לא יעברו" on the card screen, before the card is presented. Absent or null: nothing to say.
   */
  notice?: string | null;
  /** On approval. */
  pickupLabel?: string;
  documentNumber?: string;
  receipt?: 'ask' | 'printing' | 'printed' | 'declined' | 'none' | 'failed';
  /** "מזומן" at the cash station: where it stands (the pay screen's cash look). */
  cash?: CashPayView | null;
}

/** The cash station's side of a payment, as the pay screen draws it (§11.6). */
export interface CashPayView {
  /** `owed_choice`: the change owed — the customer chooses (§11.15א); `split_card`: the cash part paid, the card the rest (§11.15ב). */
  stage: 'connecting' | 'queued' | 'insert' | 'settling' | 'change' | 'refunding' | 'done' | 'refunded' | 'fault' | 'owed_choice' | 'split_card';
  /** In the queue: the place (1 = next). */
  position: number | null;
  stationName: string | null;
  insertedAgorot: number;
  dueAgorot: number;
  changeAgorot: number;
  changeOwedAgorot: number;
  exactOnly: boolean;
  /** A note being checked in escrow. */
  escrowAgorot: number;
  accepts: { coins: number[]; notes: number[] } | null;
  slipCode: string | null;
  txShort: string | null;
  /** owed_choice: what may be chosen, and when a slip is taken by itself (epoch ms). */
  owedChoices?: CashOwedChoice[];
  owedDeadlineAt?: number | null;
  /** "להשלים באשראי (נותרו X ₪)" may be offered now (§11.15ב), and what the card would be charged (the rest and the tip). */
  canSplit?: boolean;
  splitRestAgorot?: number;
  /** split_card: the cash part, and what the card is charged (the rest and the tip). */
  splitAgorot?: number;
  cardRestAgorot?: number;
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
  /**
   * "יציאה לשולחן העבודה" / "יציאה מהתוכנה" from this menu: whether the manager who opened it holds
   * DESKTOP_EXIT (else why not, Hebrew). Absent from a service that predates it.
   */
  desktopExit?: { allowed: boolean; reason: string | null };
  /** "מכשיר מזומן" (P:/specs/cash-paylink.md §11.6): the station, its state, payments still to settle. */
  cash?: {
    station: string | null;
    address: string | null;
    usable: boolean;
    reason: string | null;
    pending: Array<{ txShort: string; amountAgorot: number; startedAt: number; final: string | null }>;
  } | null;
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
  /**
   * A voucher scanned or typed: a goods voucher redeemed online for the basket's goods (`clientRequestId`: a retry never
   * redeems twice), or a discount voucher held for the order (`discounts`: those already on it; `saleRef`: this order).
   */
  redeemVoucher?(input: {
    code: string;
    basket: StartPaymentIn;
    earlier: VoucherLeg[];
    discounts?: AppliedDiscountVoucher[];
    forfeitRest?: boolean;
    clientRequestId: string;
    saleRef?: string;
  }): Promise<VoucherResult>;
  /** A redeemed voucher back on itself (kept and retried until the cloud answers). */
  reverseVoucher?(redemptionId: string): Promise<void>;
  /** Discount vouchers given back (removed, the order left): the cloud lets the hold go. */
  releaseDiscounts?(vouchers: Array<{ reservationId: string }>): Promise<void>;
  /**
   * Android: the APK holds this order's vouchers itself (its own redemption path, the payment books
   * them) — a code applied to the basket (staged as the order at the checkout, with no charge yet),
   * and a voucher taken off. Never a rejection: null is no answer (the order's vouchers as they were).
   * The APK keeps them while the screens report "details" or "pay"; any other screen gives them back.
   */
  voucherApply?(input: VoucherApplyIn): Promise<VoucherAnswer | null>;
  voucherRemove?(serial: number): Promise<VoucherAnswer | null>;
  cancelPayment(): Promise<void>;
  /** "חסר עודף": the customer's choice (§11.15א); absent where the host has no cash station. */
  cashOwedChoice?(choice: CashOwedChoice): Promise<void>;
  /** "להשלים באשראי": the cash part so far, the rest by card (§11.15ב). */
  cashSplit?(): Promise<{ ok: boolean; message?: string }>;
  /** A cash credit's code (scanned "CC:…" or typed) taken for this order — up to [dueAgorot] of the goods. */
  redeemCashCredit?(input: { code: string; dueAgorot: number; clientRequestId: string }): Promise<CashCreditResult>;
  /** A credit taken for an order that was not paid: back on the credit (kept and retried until the cloud answers). */
  releaseCashCredit?(redemptionId: string): Promise<void>;
  receiptChoice(orderId: string, print: boolean): Promise<void>;
  /** "עזרה": a help request to the tills (an alert on the next sync). */
  helpRequest(): Promise<void>;
  adminUnlock(pin: string): Promise<{ ok: true; name: string } | { ok: false; error: string }>;
  adminInfo(): Promise<AdminInfo>;
  adminAction(action: AdminAction): Promise<AdminActionResult>;
  technicianUnlock(code: string): Promise<{ outcome: 'granted' | 'wrong' | 'locked_out' | 'locked'; triesLeft: number; lockedForMs: number }>;
  technicianInfo(): Promise<TechnicianInfo>;
  technicianAction(action: TechnicianAction): Promise<{ ok: boolean; message?: string }>;
  /**
   * "סגירת משמרת ו-Z" on the shop's lock ("סניף לא פעיל"): a manager's code, then the kiosk's own
   * close for its Z mode; the lock stays. Absent where the host has none (the Android bundle, a demo).
   */
  shopLockCloseDay?(pin: string): Promise<ShopLockCloseDayOut>;
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
  /** "יציאה מהתוכנה": the manager who opened the menu must hold DESKTOP_EXIT. */
  | { type: 'exitKiosk' }
  /** "יציאה לשולחן העבודה" from the menu: the same manager's DESKTOP_EXIT, no second code. */
  | { type: 'desktopExit' }
  /** "צימוד מסוף SynqPay": `pair` (the first code, or "שלח קוד חדש"); the serial when the kiosk cannot tell it. */
  | { type: 'synqpayPair'; serialNumber?: string | null }
  /** The 6 digits from the terminal's screen. */
  | { type: 'synqpayCode'; otp: string }
  /** The paired key to the cloud again. */
  | { type: 'synqpayRetryUpload' }
  /** "מכשיר מזומן": ask the cash station again about payments it has not finished telling (settleCash). */
  | { type: 'cashRecheck' };

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
