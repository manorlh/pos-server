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
import type { UnpairCheck } from '../core/unpairGuard';
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
    /** "שובר פריט לא הודפס": today's item tickets the queue gave up on (core/kioskReprint.ts); absent from an older host. */
    unprintedTickets?: number;
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
    /**
     * "קיוסק — כשאין מסופון אשראי" (core/noTerminalFallback.ts): "תשלום בקופה" is among the methods only because the
     * terminal is not there (none set up, or not answering) and nothing else pays. Absent: not so.
     */
    tillFallback?: true;
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
  /**
   * `owed_choice`: the change owed — the customer chooses (§11.15א); `split_card`: the cash part paid, the card the rest (§11.15ב).
   * CashMag (P:/specs/cashmag-windows.md): `busy` — the machine is another client's ("…יש להמתין לסיום", going on by
   * itself once free); `question` — the server asks (`question`), answered with `cashQuestion`.
   */
  stage: 'connecting' | 'queued' | 'busy' | 'insert' | 'question' | 'settling' | 'change' | 'refunding' | 'done' | 'refunded' | 'fault' | 'owed_choice' | 'split_card';
  /** Which cash device: the shop's cash station (PayLink, absent) or a CashMag machine. */
  device?: 'paylink' | 'cashmag';
  /** question: the server's title and text. */
  question?: { title: string; text: string } | null;
  /** In the queue: the place (1 = next). */
  position: number | null;
  /** In the queue past `cashQueueTimeoutSec` ("ההמתנה ארוכה מהרגיל", P:/specs/cash-paylink.md §14.3). */
  longWait?: boolean;
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
  /**
   * "משמרת ו-Z" (core/kioskZ.ts): a fiscal kiosk working as one — its Z mode per device, the shift, a Z owed (own Z
   * only), a customer at it now. Absent / null elsewhere (a till by role, a KDS, a bridge, the Android bundle).
   */
  kioskZ?: { kind: 'shop' | 'independent' | 'own'; shiftOpen: boolean; owed: boolean; customerBusy: boolean } | null;
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
  /**
   * "מכשיר מזומן CashMag" (P:/specs/cashmag-windows.md §7): the settings in force and where each came from, the
   * server's state, and the payments the staff must look at ("טופל"). Absent / null: CashMag off and nothing left.
   */
  cashmag?: {
    address: string;
    protocol: string;
    terminal: string;
    userCodeSet: boolean;
    sources: Record<string, string>;
    usable: boolean;
    reason: string | null;
    connection: string | null;
    lastError: string | null;
    unresolved: Array<{ txId: string; txShort: string; amountAgorot: number; startedAt: number; outcome: string | null; heldAgorot: number; reason: string | null }>;
  } | null;
  /** "מצב עבודה: קיוסק / קופה" (core/workMode.ts): absent from a service that predates it. */
  workMode?: AdminWorkMode;
}

/** How one item ticket of a sale printed ("לא הודפס" per ticket, core/kioskReprint.ts ticketStates). */
export interface HistoryTicket {
  index: number;
  count: number;
  state: 'sent' | 'queued' | 'failed';
  /** The first print and every reprint of it. */
  prints: number;
}

/** "היסטוריית עסקאות" in the manager's menu (core/kioskReprint.ts): one paid sale. */
export interface HistoryRow {
  localId: string;
  /** ms; 0 when the cloud did not say. */
  at: number;
  businessDate: string;
  /** Its name on the screen: the pickup label, else the document number, else its id (labelOf). */
  label: string;
  pickupLabel: string | null;
  number: string | null;
  customerName: string | null;
  /** With the tip. */
  totalAgorot: number;
  /** "אשראי ···4242", "מזומן", "שובר"…; null when unknown. */
  payment: string | null;
  /** The receipt / the bon in words; `bonFailed` for the red. */
  receipt: string;
  bon: string;
  bonFailed: boolean;
  /** Its item tickets and how each printed; empty: none (or not known — an order the kiosk no longer keeps). */
  tickets: HistoryTicket[];
  /** What may print again (core/kioskReprint.ts kinds). */
  kinds: Array<'item_tickets' | 'invoice_copy' | 'kitchen_bon'>;
  /** Kept on the kiosk, or only the cloud's (older than the week it keeps). */
  source: 'kiosk' | 'cloud';
}

/** The manager's "היסטוריית עסקאות" now: the rows asked for, the cloud's part, who may reprint, the day's log. */
export interface AdminHistory {
  /** 1 ("היום") or 7 ("7 ימים"); `older`: the cloud's days before the kept week ("ישנות יותר"). */
  days: number;
  older: boolean;
  query: string;
  rows: HistoryRow[];
  /** How many matched (the rows are the newest of them). */
  total: number;
  /** The cloud's part: not asked, answered, no answer (offline), or a server without the route. */
  cloud: 'off' | 'ok' | 'failed' | 'unsupported';
  /** The manager who opened the menu holds "הדפסה חוזרת": no second code. */
  alone: boolean;
  bonsOn: boolean;
  /** "הדפס שוב את הבון האחרון": the newest sale with a bon; null — none (or bons off). */
  lastBon: { localId: string; label: string } | null;
  /** Today's item tickets that did not print. */
  unprintedTickets: number;
  /** "הדפסות חוזרות היום", newest first. */
  log: Array<{ at: number; kind: 'item_tickets' | 'invoice_copy' | 'kitchen_bon'; label: string | null; by: string | null; tickets?: number[] | null; failed?: boolean }>;
}

/** The manager's "מצב עבודה" section: shown only where the owner allowed it (`enabled`). */
export interface AdminWorkMode {
  /** The owner's gate (`kioskTillModeEnabled`) is open for this device. */
  enabled: boolean;
  /** The mode now ("קיוסק" — this menu is the kiosk's; "קופה" is where the button leads). */
  mode: 'kiosk' | 'till';
  /** The "קופה" button exists: kiosk mode, the gate open. */
  toTill: boolean;
  /**
   * The "קיוסק" button exists: till mode (a kiosk by role always; a till by role where the owner allowed it) — the
   * manager's corner over the till opens this menu too (staff/ShellStaff.tsx). Absent from an older service: false.
   */
  toKiosk?: boolean;
  /** The manager who opened this menu holds KIOSK_TILL_MODE: their code counts, no second one is asked. */
  openerHolds: boolean;
  /** "מצב עבודה בהפעלה" (`kioskTillModeStartMode`): anything but `last` — a restart starts the device as it says. Absent: `last`. */
  startMode?: 'last' | 'home' | 'kiosk' | 'till';
}

export interface TechnicianInfo {
  machine: KioskView['machine'];
  /**
   * "רשומות מהמכשיר הקודם (N) — לא נשלחו, נשמרו בגיבוי": outbox rows made under another pairing (a forced unpair, then a
   * pairing to another machine) — held, never sent here; they go again only if the device is paired to their machine.
   */
  foreignRows?: { count: number; title: string; lines: string[]; machineIds: string[] } | null;
  deviceRole: string | null;
  /** "סוג רישיון" (core/deviceLicense.ts): the product, "סוג רישיון: …", and the mismatch warning; null — none said. */
  license?: { product: string; label: string | null; info: string | null; warning: string | null } | null;
  shopName: string | null;
  /** "נקודת מכירה" (machines/me `areaName`, P:/specs/area-gaps.md §1); null / absent — none. */
  areaName?: string | null;
  companyName: string | null;
  network: { online: boolean; lastBeatOkAt: number | null; serverUrl: string | null; interfaces: Array<{ name: string; address: string }> };
  printer: AdminInfo['printer'];
  terminal: AdminInfo['terminal'];
  /**
   * "מדפסת לקבלות ולמסמכים" (bill-print-other-till §3, §7א): where this till's pages go when another till's printer is offered
   * ("המדפסת של <שם הקופה>") — this till's own choice over the cloud's (null — the cloud's setting); absent: none offered.
   */
  receipts?: { choice: string | null; options: Array<{ id: string; label: string }>; scope: string | null };
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
  /** "גודל תצוגה" (P:/specs/display-scale.md): the window's size now, its source, the cloud's and the local choice. */
  displayScale?: DisplayScaleView;
  /**
   * The rest of the technician's screen (P:/specs/windows-setup-parity.md — the Android technician screens on Windows): the
   * same on a kiosk and a till. Absent from an older service (the screen shows what it has).
   */
  setup?: TechnicianSetupView;
}

export type TechLightView = 'ok' | 'warn' | 'bad' | 'unknown';

/** One timed request on the technician's screen ("עונה · HTTP 200 · 85 ms"). */
export interface TechHttpCheck {
  url: string;
  ok: boolean;
  code: number | null;
  ms: number;
  error: string | null;
}

export interface TechnicianSetupView {
  /** The screen's title and what it offers: "בדיקות ומידע קיוסק" on a kiosk, "טכנאי" elsewhere. */
  role: 'kiosk' | 'till' | 'other';
  appVersion: string;
  lights: { cloud: TechLightView; pinpad: TechLightView; printer: TechLightView; media: TechLightView; mediaFiles: number; mediaMissing: number };
  /** "שיוך": what the device keeps (the cloud's answer, when it came, is the `identity` of `networkCheck`). */
  identity: {
    company: string | null;
    shop: string | null;
    machineName: string | null;
    machineId: string | null;
    posNumber: string | null;
    documentPrefix: string | null;
    role: string | null;
    zMode: string | null;
    lastSyncAt: number | null;
    configVersion: string | null;
    serverUrl: string | null;
    /** Android Settings' "ענן": "מוצרים", "קטלוג עודכן", "עובדים", "מכירות בתור". */
    products: number;
    catalogAt: number | null;
    staff: number;
  };
  /** "חיבור מרחוק": TeamViewer QuickSupport's path when installed. */
  quickSupportPath: string | null;
  /** "המחשב". */
  computer: { hostname: string; os: string; cpu: string; memoryGb: number; serial: string | null; clockSkewMs: number | null; battery: { percent: number | null; charging: boolean } | null };
  /** "הפעלה אוטומטית" with Windows (null: not known here — a dev build). */
  autostart: { enabled: boolean } | null;
  /** "מיסוי". */
  tax: { dealer: string; vatPercent: number };
  /** "בדיקת מדפסת": the paper and the last prints. */
  printer: { kind: 'usb' | 'network' | 'windows' | 'none'; branch: string | null; widthDots: number; cut: boolean; lastOkAt: number | null; lastFailure: string | null; port: number | null };
  /** "מגירת כסף" through the receipt printer. */
  drawer: { via: string; pin: 2 | 5; onMs: number; pulses: number[]; audited: boolean };
  /** "קישור מסופון מחדש" / "כתובת המסופון". */
  pinpad: {
    network: boolean;
    usb: boolean;
    cardless: boolean;
    host: string | null;
    port: number | null;
    expectedTerminal: string | null;
    auto: string;
    lastMove: string | null;
    /** "טביעת התעודה (SHA-256)" the pinpad's TLS certificate is pinned to (null: none yet — the first answer pins it). */
    certPin: string | null;
  };
  /** "מדפסות בונים". */
  kitchen: { printers: Array<{ id: string; name: string; where: string; network: { host: string; port: number } | null }>; hostsRelay: boolean };
  /** "מכשיר מזומן" / CashMag (the manager's menu's own views); null: none here. */
  cash: AdminInfo['cash'] | null;
  cashmag: AdminInfo['cashmag'] | null;
  /** "צימוד מסוף SynqPay" on an external SynqPay terminal; null elsewhere. */
  synqpay: SynqpayAdminInfo | null;
  /** "הפקת Z / סגירת משמרת" on a kiosk (core/kioskZ.ts); null elsewhere. */
  kioskZ: AdminInfo['kioskZ'] | null;
  /** "כניסות טכנאי": the last entries, newest first. */
  audit: Array<{ at: number; access: string }>;
  /** Unsent documents ("בטל שיוך" and another cloud wait for them). */
  outbox: number;
}

/** What one technician action came to — its words, and for the checks their facts. */
export interface TechnicianActionResult {
  ok: boolean;
  message?: string;
  /** A second press is asked ("נתק ועבור לענן החדש", "לחצו שוב"): its label. */
  confirm?: string;
  /** "מידע רשת" and "שיוך" from the cloud. */
  network?: {
    connection: 'wifi' | 'ethernet' | 'other' | 'none';
    ssid: string | null;
    signal: number | null;
    adapters: Array<{ name: string; addresses: string[]; gateways: string[]; dns: string[] }>;
    internet: TechHttpCheck | null;
    api: TechHttpCheck | null;
    lan: { label: string; check: TechHttpCheck | null } | null;
    identity: {
      tenant: string | null;
      company: string | null;
      shop: string | null;
      branchCode: string | null;
      area: string | null;
      machineName: string | null;
      posNumber: string | null;
      documentPrefix: string | null;
      role: string | null;
      zRole: string | null;
      controllers: string[] | null;
    } | null;
  };
  /** "בדיקת חיבור" of a new server address. */
  server?: { url: string; health: TechHttpCheck; same: TechHttpCheck | null; sameCloud: boolean };
  /** "בדיקת מסופון / תקשורת". */
  pinpad?: {
    kind: string | null;
    address: string | null;
    tcp: { ok: boolean; ms: number; error: string | null } | null;
    status: { ok: boolean; ms: number; detail: string | null } | null;
    terminal: string | null;
    merchant: string | null;
    serial: string | null;
    skipped: string | null;
  };
  /** "חיפוש מסופון ברשת". */
  pinpads?: Array<{ host: string; port: number; terminal: string | null; merchant: string | null; serial: string | null; match: 'same' | 'other' | 'unknown' }>;
  /** "חיפוש מדפסות ברשת". */
  printers?: { subnet: string; found: Array<{ host: string; port: number; health: string; known: string | null }> };
  /** "יומן אפליקציה". */
  log?: string[];
  /** An unpair that was refused: what waits, and whether it may be forced (core/unpairGuard.ts). */
  unpair?: UnpairCheck;
}

/** "גודל תצוגה" on the technician's screen (core/displayScale.ts). */
export interface DisplayScaleView {
  /** The size now, in percent of the automatic size (an old "זום": its share of it). */
  percent: number;
  setting: 'auto' | number;
  source: 'local' | 'cloud' | 'auto';
  /** The cloud's value as it resolved for this device ("auto", "85"; null: none). */
  cloud: string | null;
  /** The saved local choice ("auto", "85"; null: follow the cloud). */
  local: string | null;
  /** An unsaved choice is being previewed (`displayScalePreview`): its value (null: follow the cloud). */
  preview?: { local: string | null };
  /** The old absolute "זום" still in force (no new choice saved over it). */
  legacyZoom: number | null;
  /** The window's page zoom now, and the automatic one. */
  zoom: number;
  autoZoom: number;
}

/**
 * The pairing's answer: done — with "המכשיר הוגדר: קיוסק · סוג רישיון: קיוסק בלבד" (`notice`) and, when the license does
 * not fit the role it opened in, its warning (core/deviceLicense.ts) — or the cloud's refusal in Hebrew.
 */
export type PairOutcome = { ok: true; notice?: string | null; warning?: string | null } | { ok: false; error: string };

export interface KioskEvents {
  view: KioskView;
  pay: PayProgress;
  toast: { text: string; tone: 'info' | 'warn' | 'error' };
}

/** What the screens may ask (ipcRenderer.invoke under the hood). */
export interface KioskBridge {
  bootstrap(): Promise<KioskView>;
  pair(input: { serverUrl: string; code: string; machineName: string }): Promise<PairOutcome>;
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
  /** CashMag: the customer's answer to the server's question (confirm: dialogValid, else dialogCancel). */
  cashQuestion?(confirm: boolean): Promise<void>;
  /** A cash credit's code (scanned "CC:…" or typed) taken for this order — up to [dueAgorot] of the goods. */
  redeemCashCredit?(input: { code: string; dueAgorot: number; clientRequestId: string }): Promise<CashCreditResult>;
  /** A credit taken for an order that was not paid: back on the credit (kept and retried until the cloud answers). */
  releaseCashCredit?(redemptionId: string): Promise<void>;
  receiptChoice(orderId: string, print: boolean): Promise<void>;
  /** "עזרה": a help request to the tills (an alert on the next sync). */
  helpRequest(): Promise<void>;
  adminUnlock(pin: string): Promise<{ ok: true; name: string } | { ok: false; error: string }>;
  adminInfo(): Promise<AdminInfo>;
  /** "היסטוריית עסקאות" (core/kioskReprint.ts); absent where the host has none (the Android bundle: its own native menu). */
  adminHistory?(input: { days: number; query: string; older?: boolean }): Promise<AdminHistory>;
  adminAction(action: AdminAction): Promise<AdminActionResult>;
  technicianUnlock(code: string): Promise<{ outcome: 'granted' | 'wrong' | 'locked_out' | 'locked'; triesLeft: number; lockedForMs: number }>;
  technicianInfo(): Promise<TechnicianInfo>;
  technicianAction(action: TechnicianAction): Promise<TechnicianActionResult>;
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
  /** The bon / the receipt of an order again: `reprint` of `kitchen_bon` / `invoice_copy` (under REPRINT, recorded). */
  | { type: 'reprintBon'; orderId: string; code?: string }
  | { type: 'reprintReceipt'; orderId: string; code?: string }
  /** "הדפס עסקה אחרונה" (the Android admin's quick reprint): today's last document, kiosk or till, as a copy. */
  | { type: 'reprintLast'; code?: string }
  /** "הדפס שוב את הבון האחרון": the newest sale's kitchen bon, marked "הדפסה חוזרת". */
  | { type: 'reprintLastBon'; code?: string }
  /**
   * "הדפסה חוזרת" of one sale (core/kioskReprint.ts): its item tickets ("שובר פריט" — all of them, or `only: 'failed'`
   * those that did not print), its invoice's copy, its kitchen bon. Under REPRINT: the menu's manager alone when the role
   * allows it, else `needsCode` asks for another manager's (`code`); recorded (the cloud's `reprint` event, the day's log).
   */
  | { type: 'reprint'; kind: 'item_tickets' | 'invoice_copy' | 'kitchen_bon'; orderId: string; only?: 'all' | 'failed'; code?: string }
  | { type: 'testPrint' }
  | { type: 'checkTerminal' }
  | { type: 'recheckPayment'; reference: string }
  | { type: 'markNotApproved'; reference: string }
  | { type: 'retryPrints' }
  /** "יציאה מהתוכנה": the manager who opened the menu must hold DESKTOP_EXIT. */
  | { type: 'exitKiosk' }
  /** "יציאה לשולחן העבודה" from the menu: the same manager's DESKTOP_EXIT, no second code. */
  | { type: 'desktopExit' }
  /**
   * "מצב עבודה": to the till. Refused (`refusal`) over a customer's order or payment; always a manager's code with
   * KIOSK_TILL_MODE — the one that opened this menu counts when it holds it, else `needsCode` asks for another (`code`).
   */
  | { type: 'workMode'; mode: 'till' | 'kiosk'; code?: string }
  /** "צימוד מסוף SynqPay": `pair` (the first code, or "שלח קוד חדש"); the serial when the kiosk cannot tell it. */
  | { type: 'synqpayPair'; serialNumber?: string | null }
  /** The 6 digits from the terminal's screen. */
  | { type: 'synqpayCode'; otp: string }
  /** The paired key to the cloud again. */
  | { type: 'synqpayRetryUpload' }
  /** "מכשיר מזומן": ask the cash station again about payments it has not finished telling (settleCash). */
  | { type: 'cashRecheck' }
  /** CashMag: a manager dealt with an unclear payment at the machine ("טופל"). */
  | { type: 'cashmagAcknowledge'; txId: string }
  /** CashMag: is the server there now (a knock on its port, the machine not taken). */
  | { type: 'cashmagCheck' }
  /**
   * "משמרת ו-Z" (core/kioskZ.ts): the kiosk's one action by its Z mode — "סגירת משמרת" in the shop Z, "הפקת Z" with its own
   * Z — run by the manager who opened this menu; refused (with why) over a customer, a card or a pending payment.
   */
  | { type: 'kioskZ' };

export interface AdminActionResult {
  ok: boolean;
  message?: string;
  /** "מצב עבודה": why the switch is refused now (core/workMode.ts `TillModeRefusal`). */
  refusal?: string;
  /**
   * "מצב עבודה": a manager's code with KIOSK_TILL_MODE is needed; "הדפסה חוזרת": one with REPRINT (or the one typed was
   * refused: `message` says why).
   */
  needsCode?: boolean;
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
  /**
   * "גודל תצוגה": `displayScalePreview` shows a choice at once without saving it ("auto", "85", or null — follow the
   * cloud); `displayScaleEnd` drops the preview; `displayScaleSave` saves it on the device (over the cloud) and drops
   * the old "זום". Replaces the old ×1 / ×1.5 / ×2 "זום" buttons (`setZoom`).
   */
  | { type: 'displayScalePreview'; local: string | null }
  | { type: 'displayScaleEnd' }
  | { type: 'displayScaleSave'; local: string | null }
  /** "מדפסת לקבלות ולמסמכים": a destination's id, `local`, `ask` — or null, "חזור להגדרת הענן". */
  | { type: 'setReceiptPrinter'; id: string | null }
  /**
   * "ניתוק המכשיר מהענן" (core/unpairGuard.ts): refused while rows wait for the cloud (`unpair` in the answer says what
   * and whether "ניתוק בכל זאת" may go); `force` with the technician's `code` again and `confirm` (and `confirmMoney`
   * when money records wait) exports everything pending to a backup, then unpairs.
   */
  | { type: 'unpair'; force?: boolean; code?: string; confirm?: boolean; confirmMoney?: boolean }
  /* --- the Android technician screens' setup (P:/specs/windows-setup-parity.md) --- */
  /** "סנכרון עכשיו". */
  | { type: 'syncNow' }
  /** "הפעלה מחדש של האפליקציה" — never over an order or a payment. */
  | { type: 'restart' }
  /** "מידע רשת" + "שיוך" from the cloud: the adapters, Wi-Fi, `/health`, the cloud API (its answer is the identity), the LAN host. */
  | { type: 'networkCheck' }
  /** "כתובת שרת": "בדיקת חיבור" of a new address, then "שמירה" (`confirm`: "נתק ועבור לענן החדש"). */
  | { type: 'serverTest'; url: string }
  | { type: 'serverSave'; url: string; confirm?: boolean }
  /** "בדיקת רוחב": frames of 384 / 432 / 512 / 576 dots on the receipt printer (or a kitchen printer on the network). */
  | { type: 'printerWidthTest'; printerId?: string | null }
  /** "חיפוש מדפסות ברשת" (port 9100, status only), then a printer found added to the shop (a manager's code). */
  | { type: 'printerScan' }
  | { type: 'printerAdd'; host: string; port: number; name: string; purpose: 'kitchen' | 'receipt'; code: string }
  /** "מגירת כסף": its pin (2 / 5) and pulse, and "פתח מגירה (בדיקה)". */
  | { type: 'drawerSet'; pin: 2 | 5; onMs: number }
  | { type: 'drawerTest' }
  /** "בדיקת מסופון / תקשורת" (reads only). */
  | { type: 'pinpadProbe' }
  /** "קישור מסופון מחדש": search the LAN, link the one picked. */
  | { type: 'pinpadSearch' }
  | { type: 'pinpadLink'; host: string; port: number }
  /** "איפוס הצמדת התעודה": the pinpad's pinned certificate forgotten (the next answer is pinned again). */
  | { type: 'pinpadPinReset' }
  /** "כתובת המסופון" — a manager's code: the address on the network, or "חיבור USB". */
  | { type: 'pinpadSetup'; connection: 'lan'; host: string; port: number | null; code: string }
  | { type: 'pinpadSetup'; connection: 'usb'; code: string }
  /** "מדפסות בונים": a test ticket, "רענן מהענן". */
  | { type: 'kitchenTest'; printerId: string }
  | { type: 'kitchenSync' }
  /** "שלח לוגים לתמיכה" (`range`: hour / three / today). */
  | { type: 'sendLogs'; range: 'hour' | 'three' | 'today'; note?: string | null }
  /** "יומן אפליקציה": the last lines. */
  | { type: 'appLog' }
  /** "הפעלה אוטומטית": on again with Windows. */
  | { type: 'autostartOn' }
  /** The manager's menu's checks, from here too: "בדיקה מול מכשיר המזומן", "בדיקת חיבור לשרת CashMag", "הפקת Z / סגירת משמרת". */
  | { type: 'cashRecheck' }
  | { type: 'cashmagCheck' }
  | { type: 'kioskZ' }
  /** "ייצוא לקובץ": the rows of the previous pairing (held, never sent under this one) to unpair-backups. */
  | { type: 'exportForeign' };
