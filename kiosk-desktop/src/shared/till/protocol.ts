/**
 * The till's screen ↔ engine contract, as a LOCAL TYPED MOCK of `till_web_protocol.json` v0
 * (P:/specs/web-till-spec-v2.md §3.3). The golden file is S0-1's (another agent, branch
 * feat/web-till-s0); until it lands in `kiosk-desktop/protocol/till_web_protocol.json` the
 * screens are written against these types, and test/tillProtocolMock.test.ts checks every op
 * and error named here against the golden file as soon as it is there (it skips until then).
 *
 *  - envelopes: call `{id, op, args, clientOpId}`, reply `{id, ok, value | error}`, event
 *    `{ev, seq, data}`;
 *  - the state comes from the engine (a full `state` on connect, then each change with a higher
 *    `seq`); the screen shows only what the engine said;
 *  - every op that changes something carries a `clientOpId`: sent twice (a reconnect) it is the
 *    same op, never applied twice;
 *  - `hw.*` go from the ENGINE to the host (print bytes, drawer, byte channels); the host answers
 *    with `hw.result`. The screen never asks for hardware itself (§3.1, §9.5).
 *
 * Money is in agorot (integers), as on the APK.
 */

export const TILL_PROTOCOL = 1;
/** Where these names come from until the golden file lands (S0-1). */
export const PROTOCOL_SOURCE = 'local-mock-v0';

/* ----------------------------------------------------------------- envelopes */

export interface EngineCall {
  id: number;
  op: TillOp;
  args?: unknown;
  clientOpId?: string;
}

export interface EngineError {
  code: TillErrorCode;
  /** Hebrew, shown as is. */
  message: string;
  details?: Record<string, unknown>;
}

export type EngineReply = { id: number; ok: true; value?: unknown } | { id: number; ok: false; error: EngineError };

export interface EngineEvent<D = unknown> {
  ev: TillEventName;
  seq: number;
  data: D;
}

export type TillEventName = 'state' | 'hw' | 'toast';

/* --------------------------------------------------------------------- ops */

export const TILL_OPS = [
  'session.hello',
  'session.login',
  'session.logout',
  'catalog.snapshot',
  'sell.add',
  'sell.setQty',
  'sell.remove',
  'sell.discount',
  'sell.clear',
  'sell.department',
  'sell.search',
  'checkout.start',
  'checkout.cash',
  'checkout.card',
  'checkout.cancel',
  'checkout.finish',
  'dialog.answer',
  'doc.history',
  'doc.reprint',
  'doc.refund',
  'shift.open',
  'shift.close',
  'report.x',
  'z.produce',
  'mode.switch',
  'host.idle',
  'hw.result',
  // The real engine's additions (main/till/engine.ts): a touch (the idle return, the update), the receipt question.
  'session.activity',
  'checkout.print',
  // A card whose answer is not known (never a second charge): ask the terminal again; or a manager marks it not approved.
  'checkout.recheckCard',
  'checkout.markNotApproved',
  // "דוח X סניפי" (core/till/shopX.ts): the cloud's interim report of the shop — `refresh` asks the other tills first,
  // `print` prints the one on screen. Nothing changes: not a document.
  'report.shopX',
  // "הנחה לחשבון" (core/till/discounts.ts): what a keyed basket discount would do, applying it, taking it off.
  'discount.preview',
  'discount.apply',
  'discount.remove',
  // OTH ("על חשבון הבית"): lines given free with a reason; taken back.
  'oth.confirm',
  'oth.undo',
  // "זיכוי" on the sell screen (core/till/basket.ts): the button (the refund's authority, then the two ways in), the
  // catalog's refund mode, its end; "זיכוי מקבלה" — the recent receipts, a number looked up, a receipt's lines, the
  // picked lines into the cart as returns.
  'refund.button',
  'refund.catalog',
  'refund.end',
  'refund.recent',
  'refund.find',
  'refund.pick',
  'refund.add',
  // "זיכוי" from the history (DetailViewModel): a document's refundable lines, and the credit note for the picked ones.
  'doc.detail',
  // A basket with returns at the payment: who the money goes back to, an even exchange, the money back (cash / card).
  'checkout.returnCustomer',
  'checkout.exchange',
  'checkout.payout',
  // "מכירות בהמתנה" (core/till/heldSales.ts): park the basket, the list, pick one up, cancel one (with a reason).
  'held.hold',
  'held.list',
  'held.resume',
  'held.cancel',
  // "הבנתי" on the notice the shift opens with (the automatic close of the one before).
  'notice.ack',
  // "מגירת מזומן" (main/till/tillDrawer.ts): "פתח מגירה" with its reason, Cash In / Out / Deposit, a count, "הפקדת מזומן
  // מעובד", the shift's log and movements. Every opening goes through the drawer service's rules (a manager when they ask).
  'drawer.open',
  'drawer.openRemote',
  'drawer.movement',
  'drawer.count',
  'drawer.countSave',
  'drawer.countDone',
  'drawer.wallets',
  'drawer.walletDeposit',
  'drawer.log',
  // "עובד מחובר בקופה אחת בלבד" (main/till/userSessions.ts): "עובדים מחוברים" — the shop's signed-in employees, a manager's
  // release from here; and the banner about this till's own sign-in, dismissed.
  'users.open',
  'users.refresh',
  'users.release',
  'users.close',
  'session.dismissNotice',
  // The cash stations' side (main/till/tillCash.ts): "עודף חייב ללקוח" and "שולם ללקוח"; "זיכוי מזומן" (`CC:<code>`) at the payment.
  'owed.refresh',
  'owed.pay',
  'checkout.credit',
  'checkout.removeCredit',
] as const;

export type TillOp = (typeof TILL_OPS)[number];

/** Ops that change something: each needs a clientOpId (the engine refuses one without). */
export const MUTATING_OPS: ReadonlySet<TillOp> = new Set<TillOp>([
  'session.login',
  'session.logout',
  'sell.add',
  'sell.setQty',
  'sell.remove',
  'sell.discount',
  'sell.clear',
  'checkout.start',
  'checkout.cash',
  'checkout.card',
  'checkout.cancel',
  'checkout.finish',
  'dialog.answer',
  'doc.reprint',
  'doc.refund',
  'shift.open',
  'shift.close',
  'z.produce',
  'mode.switch',
  'checkout.print',
  'checkout.recheckCard',
  'checkout.markNotApproved',
  'discount.apply',
  'discount.remove',
  'oth.confirm',
  'oth.undo',
  'refund.button',
  'refund.catalog',
  'refund.end',
  'refund.add',
  'checkout.returnCustomer',
  'checkout.exchange',
  'checkout.payout',
  'held.hold',
  'held.resume',
  'held.cancel',
  'notice.ack',
  'drawer.open',
  'drawer.openRemote',
  'drawer.movement',
  'drawer.count',
  'drawer.countSave',
  'drawer.countDone',
  'drawer.walletDeposit',
  'users.open',
  'users.release',
  'users.close',
  'session.dismissNotice',
  'owed.pay',
  'checkout.credit',
  'checkout.removeCredit',
]);

export interface OpArgs {
  'session.hello': { since?: number; protocol?: number };
  /** `pin` (the screens' word) or `code` (the golden protocol's): the engine reads either. */
  'session.login': { pin?: string; code?: string };
  'session.logout': Record<string, never>;
  'catalog.snapshot': Record<string, never>;
  'sell.add': { productId: string; qty?: number };
  'sell.setQty': { lineId: string; qty: number };
  'sell.remove': { lineId: string };
  /** A line's discount in whole percent (5 / 10 / 20; 0 takes it off). */
  'sell.discount': { lineId: string; pct: number };
  'sell.clear': Record<string, never>;
  'sell.department': { departmentId: string | null };
  'sell.search': { text: string };
  'checkout.start': Record<string, never>;
  'checkout.cash': { amountAgorot: number };
  'checkout.card': { amountAgorot?: number };
  'checkout.cancel': Record<string, never>;
  'checkout.finish': Record<string, never>;
  'dialog.answer': { dialogId: string; action: string; answers?: Record<string, string> };
  'doc.history': { limit?: number };
  'doc.reprint': { documentId: string };
  /** A credit note for [quantities] (original line id → quantity) of the document: cash or the original's card. */
  'doc.refund': { documentId: string; quantities?: Record<string, number> };
  /** [quantities]: what the screen picked — the answer says what crediting them gives back (`selectedAgorot`). */
  'doc.detail': { documentId: string; quantities?: Record<string, number> };
  'shift.open': { openingCashAgorot: number };
  /** `keepHeld`: "סגור והשאר מושהות" where the shop allows it (`allowCloseWithHeldSales`). */
  'shift.close': { countedCashAgorot: number; keepHeld?: boolean };
  'report.x': Record<string, never>;
  'report.shopX': { refresh?: boolean; print?: boolean };
  /** `countedCashAgorot`: the drawer's count when the shift is still open (it is closed first). */
  'z.produce': { countedCashAgorot?: number; keepHeld?: boolean };
  'discount.preview': { mode: BasketDiscountMode; input: string };
  'discount.apply': { mode: BasketDiscountMode; input: string };
  'discount.remove': Record<string, never>;
  'oth.confirm': { lineIds: string[]; reason: string };
  'oth.undo': { lineId: string };
  'refund.button': Record<string, never>;
  'refund.catalog': Record<string, never>;
  'refund.end': Record<string, never>;
  'refund.recent': Record<string, never>;
  /** A receipt's number as typed: `20000057`, `57`, `2-10000000`. */
  'refund.find': { query: string };
  'refund.pick': { transactionId: string };
  /** The lines picked off a receipt (its line id → quantity), into the cart as returns. */
  'refund.add': { transactionId: string; quantities: Record<string, number> };
  'checkout.returnCustomer': { name: string; phone?: string; address?: string };
  'checkout.exchange': Record<string, never>;
  'checkout.payout': { method: 'cash' | 'card' };
  'held.hold': { label?: string };
  'held.list': Record<string, never>;
  'held.resume': { id: string; parkLive?: boolean };
  /** "בטל" on a held sale: HELD_SALE_CANCEL, a reason, the `held_sale_cancelled` till event. */
  'held.cancel': { id: string; reason: string };
  'notice.ack': Record<string, never>;
  'mode.switch': { to: DeviceRoleName; managerCode?: string };
  'host.idle': { idle: boolean; busy: boolean };
  'hw.result': HwResult;
  'session.activity': Record<string, never>;
  /** The answer to "להדפיס חשבונית?" (`checkout.askPrint`). */
  'checkout.print': { print: boolean };
  'checkout.recheckCard': Record<string, never>;
  'checkout.markNotApproved': Record<string, never>;
  /** A reason code (core/till/drawer.ts DRAWER_REASONS, not a movement's), and its note ("אחר"). */
  'drawer.open': { reason?: string | null; note?: string | null };
  /** "פתיחת מגירה ב<קופה>" (bill-print-other-till §9ג): the host's machine id (`drawer.hosts`), and the reason as for "פתח מגירה". */
  'drawer.openRemote': { machineId: string; reason?: string | null; note?: string | null };
  'drawer.movement': { type: 'CASH_IN' | 'CASH_OUT' | 'DEPOSIT'; amountAgorot: number; reason?: string | null; note?: string | null; source?: string | null };
  'drawer.count': Record<string, never>;
  'drawer.countSave': { countedAgorot: number };
  'drawer.countDone': Record<string, never>;
  'drawer.wallets': Record<string, never>;
  /** An employee of the list `drawer.wallets` gave last, and what was counted into the drawer. */
  'drawer.walletDeposit': { employeeId: string; countedAgorot: number };
  'drawer.log': Record<string, never>;
  'users.open': Record<string, never>;
  'users.refresh': Record<string, never>;
  'users.release': { sessionId: string };
  'users.close': Record<string, never>;
  'session.dismissNotice': Record<string, never>;
  'owed.refresh': Record<string, never>;
  'owed.pay': { id: string };
  /** The code as scanned (`CC:C-K7Q3MX`) or typed. */
  'checkout.credit': { code: string };
  'checkout.removeCredit': { redemptionId: string };
}

/* ------------------------------------------------------------------- errors */

export const TILL_ERRORS = {
  // The spec's own (§3.3).
  not_engine_holder: 'המכשיר הזה אינו מחזיק את מנוע הקופה',
  till_in_use_elsewhere: 'הקופה פתוחה במכשיר אחר',
  protocol_mismatch: 'נדרש עדכון — המסך והמנוע בגרסאות שונות',
  engine_offline: 'מנוע הקופה לא זמין',
  manager_required: 'נדרש אישור מנהל',
  permission_denied: 'אין הרשאה לפעולה הזו',
  mode_switch_busy: 'אי אפשר לעבור באמצע הזמנה או תשלום',
  role_not_allowed: 'המעבר לא הותר למכשיר הזה',
  role_switch_open_shift: 'יש משמרת פתוחה — סגרו אותה לפני המעבר',
  // The skeleton's (named here until the golden file decides).
  invalid_args: 'בקשה לא תקינה',
  unknown_op: 'פעולה לא מוכרת',
  missing_client_op_id: 'פעולה בלי מזהה (clientOpId)',
  cart_empty: 'הסל ריק',
  shift_closed: 'יש לפתוח משמרת',
  shift_open: 'המשמרת כבר פתוחה',
  checkout_busy: 'יש תשלום פתוח',
  terminal_unavailable: 'אין מסופון זמין במכשיר הזה',
  card_in_flight: 'עסקת אשראי בתהליך — אי אפשר לבטל עכשיו',
  wrong_pin: 'קוד שגוי',
  not_implemented: 'עוד לא בשלד הזה',
  z_not_in_demo: 'Z לא מופק במצב הדגמה',
  // The real engine's (Android's own words come with each refusal as `message`).
  coming_soon: 'בקרוב',
  login_locked: 'יותר מדי ניסיונות. נסו שוב בעוד דקה.',
  not_logged_in: 'יש להתחבר לקופה',
  sell_refused: 'הפריט לא נוסף לסל',
  shift_not_open: 'אין משמרת פתוחה. לא ניתן למכור עד שתיפתח משמרת.',
  card_failed: 'התשלום בכרטיס לא הושלם',
  not_a_till: 'המכשיר הזה אינו קופה',
  // Refunds, discounts, held sales (the Android till's sentences come with each refusal as `message`).
  refund_refused: 'הזיכוי לא בוצע',
  held_sales: 'יש מכירות מושהות',
  basket_changed: 'הקבלה המקורית זוכתה בינתיים. יש לבחור את הפריטים מחדש.',
  discount_refused: 'ההנחה לא ניתנה',
} as const;

export type TillErrorCode = keyof typeof TILL_ERRORS;

export function engineError(code: TillErrorCode, details?: Record<string, unknown>): EngineError {
  return details ? { code, message: TILL_ERRORS[code], details } : { code, message: TILL_ERRORS[code] };
}

/** A refusal with the Android till's own Hebrew sentence (it names the product, the permission…). */
export function engineErrorText(code: TillErrorCode, message: string, details?: Record<string, unknown>): EngineError {
  return details ? { code, message, details } : { code, message };
}

/* -------------------------------------------------------------------- state */

export type DeviceRoleName = 'till' | 'kiosk' | 'kds' | 'board' | 'display';

export interface Cashier {
  id: string;
  name: string;
}

export interface SessionState {
  cashier: Cashier | null;
  locked: boolean;
  /** The effective permissions (the engine decides; the screen only hides what is not there). */
  permissions: string[];
  /** A demo engine: nothing it issues is a fiscal document. */
  demo: boolean;
  /**
   * "כשאין הרשאה" (core/till/permissions.ts): the codes whose options the screens leave out for this operator (`hide`, and
   * the older `permissionsDeniedUi` at the entries that always read it). Absent: none.
   */
  hidden?: string[];
}

export type BasketDiscountMode = 'percent' | 'fixed' | 'target';

export interface Department {
  id: string;
  name: string;
  color: string;
}

export interface Product {
  id: string;
  departmentId: string;
  name: string;
  priceAgorot: number;
  /** Short label for a tile without a picture. */
  short?: string;
  /** What a scanner types (`sell.search` + Enter finds it): the barcode, then the SKU (core/kioskScan.ts). */
  barcode?: string;
  sku?: string;
  /** "אזל" / "חסום" now (the shared sale rules): the tile says so; the engine decides what a tap does. */
  sale?: 'sold_out' | 'blocked' | 'unavailable';
  /** "מחייב אישור מנהל במכירה": a manager's code on the sale unless the user holds the right. */
  restricted?: boolean;
  /** The item's description, its allergens and dietary tags (the "i" window, P:/specs/product-tile-text.md §4). */
  description?: string;
  allergens?: string[];
  dietary?: string[];
  /** Why it is "חסום" / "אזל" now, when the rules say. */
  saleReason?: string;
}

export interface Catalog {
  version: number;
  departments: Department[];
  products: Product[];
}

/**
 * "שם פריט מלא על הכפתור, ותג i" (core/till/tileText.ts): `productNameFit`, `productNameMaxLines`, `productNameMinTextSize`,
 * `productInfoBadge` from the till's parameters.
 */
export interface TileTextState {
  fit: 'fit' | 'wrap' | 'clip';
  maxLines: number;
  minSize: 's' | 'm' | 'l';
  infoBadge: 'auto' | 'always' | 'off';
}

export interface CartLine {
  lineId: string;
  productId: string;
  name: string;
  qty: number;
  unitAgorot: number;
  discountPct: number;
  totalAgorot: number;
  /** A line coming back ("זיכוי"): its money goes the other way; shown red. */
  refund?: boolean;
  /** A return picked off a receipt: that receipt's number. */
  fromReceipt?: string | null;
  /** The cashier's discount on the line (OTH's included), agorot. */
  discountAgorot?: number;
  /** OTH ("על חשבון הבית"): the reason. */
  oth?: string | null;
  /** "לא מקבל הנחות". */
  noDiscount?: boolean;
}

export interface SellState {
  catalogVersion: number;
  departmentId: string | null;
  search: string;
  lines: CartLine[];
  itemCount: number;
  /** What the basket comes to: the sale lines after every discount, less the returns (negative: money back). */
  totalAgorot: number;
  /** The VAT inside the total. */
  vatAgorot: number;
  /** "מבצעים": what the promotions took off the lines (the total is after it). */
  promotionsAgorot?: number;
  /** "מצב זיכוי": every catalog tap takes a unit back. */
  refundMode?: boolean;
  /** The refund's authority given: "זיכוי פריט מהקטלוג" / "זיכוי מקבלה" on screen. */
  refundChooser?: boolean;
  /** The sale lines after every discount, and the returns (positive) — a basket with returns shows both. */
  saleTotalAgorot?: number;
  refundTotalAgorot?: number;
  /** "הנחה לחשבון": what it takes off now, and how it was given (null: none). */
  basketDiscount?: { amountAgorot: number; type: 'percentage' | 'fixed'; value: number } | null;
  /** The cashier's line discounts (OTH's apart), agorot. */
  lineDiscountsAgorot?: number;
  /** What the OTH lines were worth. */
  othAgorot?: number;
  /** What the lines that take no discount come to (out of the basket discount's base). */
  nonDiscountableAgorot?: number;
}

/** "מכירות בהמתנה" on this till. */
export interface HeldState {
  count: number;
  sales: Array<{ id: string; label: string | null; at: string; cashier: string | null; itemCount: number; totalAgorot: number; items: Array<{ name: string; quantity: number }> }>;
  /** "סגור והשאר מושהות" is offered at a close (`allowCloseWithHeldSales`). */
  keepAllowed: boolean;
}

/** OTH as the till's parameters set it. */
export interface OthState {
  enabled: boolean;
  requiresManager: boolean;
  reasons: string[];
}

/** One line of a document as "זיכוי" offers it (the history's detail, a receipt picked). */
export interface RefundableLine {
  itemId: string;
  productId: string;
  name: string;
  originalQty: number;
  remainingQty: number;
  /** What the customer paid per unit (display; the money is the credit's). */
  unitNetAgorot: number;
  /** Already in this cart (a receipt's lines). */
  inCart?: number;
}

export interface DocumentDetail {
  id: string;
  ref: string;
  documentType: number;
  status: string;
  totalAgorot: number;
  cashier: string;
  at: string;
  methods: string[];
  lines: RefundableLine[];
  isRefundDocument: boolean;
  anythingRefundable: boolean;
  /** How the money goes back: the original's tender (a card sale on a till "ללא אשראי": cash). */
  refundMethod: 'cash' | 'card';
  /** What crediting every remaining line gives back. */
  refundAllAgorot: number;
  /** What crediting the picked quantities gives back (RefundMath.refundTotal), when the screen sent them. */
  selectedAgorot?: number;
}

export type CheckoutPhase = 'idle' | 'tender' | 'card_waiting' | 'done';

export interface CheckoutLeg {
  /** `cash_credit`: "זיכוי מזומן" (a station's credit, `CC:` code) towards the goods. */
  method: 'cash' | 'card' | 'cash_credit';
  amountAgorot: number;
  status: 'approved' | 'pending';
  /** A cash credit's code and redemption ("הסרת הזיכוי" names it). */
  credit?: { code: string; redemptionId: string };
}

/** A basket with returns at the payment (core/till/basket.ts). */
export interface CheckoutBasket {
  saleAgorot: number;
  refundAgorot: number;
  /** Sale less refund: positive paid, negative paid out. */
  netAgorot: number;
  payoutAgorot: number;
  /** Some of what comes back came with no receipt. */
  hasUnlinked: boolean;
  /** `return_customer` (who the money goes back to), `tender` (a positive net), `exchange` (zero), `payout` (money back). */
  step: 'return_customer' | 'tender' | 'exchange' | 'payout';
  customer: { name: string; phone: string; address: string; required: boolean };
  /** How a card payout would go; `unavailable`: cash only. */
  payoutRoute: 'linked' | 'unlinked' | 'unavailable';
  /** What went back to the customer, once done. */
  handedBackAgorot?: number;
}

export interface CheckoutState {
  phase: CheckoutPhase;
  totalAgorot: number;
  paidAgorot: number;
  dueAgorot: number;
  changeAgorot: number;
  legs: CheckoutLeg[];
  /** The engine's reference of the issued document (a demo one says so). */
  documentRef: string | null;
  /** The issued document's id (a copy of it is `doc.reprint`), once the sale is done. */
  documentId?: string | null;
  /** Cash handed over so far (all cash legs' notes), for the change line. */
  tenderedAgorot?: number;
  /** "להדפיס חשבונית?" — the receipt waits for the cashier's answer (`checkout.print`). */
  askPrint?: boolean;
  /** The receipt's problem in words ("קבלה: …"), or "לא הוגדרה מדפסת לקבלות"; the sale stands. */
  printWarning?: string | null;
  /** "פריטים שלא נותבו למדפסת: …" — lines of the sale no kitchen printer takes; said, the sale stands. */
  kitchenWarning?: string | null;
  /** The card terminal's line while it waits ("הצמד, הכנס או העבר את הכרטיס"). */
  cardStatus?: string | null;
  /** A card that did not go through: its words; the sale is still open for another tender. */
  cardError?: string | null;
  /** The card's answer is not known (never charged twice): tenders wait for "בדוק שוב" / a manager's "סמן כלא אושר". */
  cardUnknown?: boolean;
  /** A basket with returns: its figures and its step. Absent: a plain sale. */
  basket?: CheckoutBasket | null;
  /** Every document the payment wrote (a basket: the sale and its credit notes), as printed. */
  documentRefs?: string[];
}

export interface ShiftState {
  /**
   * "קופה עצמאית" (independent till, Z on the till): NO shifts in the UI — the shift opens silently on the first sale (float 0)
   * and closes inside "הפק Z". The screens show no "פתיחת / סגירת משמרת" and no X; only "הפק Z".
   */
  hidden?: boolean;
  open: boolean;
  number: number | null;
  openedAt: string | null;
  openingCashAgorot: number;
  salesCount: number;
  salesAgorot: number;
  cashAgorot: number;
  cardAgorot: number;
}

export interface ZState {
  lastNumber: number | null;
  canProduce: boolean;
  /** Why not (Hebrew), when it cannot. */
  reason: string | null;
  /** `till`: this till makes its own Z ("הפק Z"); `shop`: the shop's Z (closing the shift is all this till does). */
  zMode?: 'till' | 'shop';
}

export interface HealthState {
  cloud: 'online' | 'offline' | 'demo';
  /** The receipt printer as the print queue last saw it. */
  printer: 'ok' | 'none' | 'error';
  terminal: 'ok' | 'none' | 'busy';
  /**
   * "ללא אשראי" — the business's payment integration is "none" (P:/specs/payment-integration-none.md, the Android
   * PaymentIntegration.NONE): the till takes no card at all — no card tender, no terminal check. Absent: false.
   */
  noCard?: boolean;
  outbox: number;
}

export interface DialogField {
  name: string;
  label: string;
  kind: 'pin' | 'text';
}

export interface EngineDialog {
  id: string;
  kind: 'manager_approval' | 'confirm';
  title: string;
  body: string;
  fields: DialogField[];
  actions: Array<{ id: string; label: string; primary?: boolean }>;
  /** Unanswered until then (epoch ms) the engine answers itself ("לפתוח מגירה?" — `cashDrawerAskTimeoutSec`): a countdown. */
  expiresAt?: number;
}

export interface ModeState {
  role: DeviceRoleName;
  current: DeviceRoleName;
  /** Empty: no switch button, no menu (owner's rule, §6.2). */
  rolesAllowed: DeviceRoleName[];
  /** The menu row's words ("מעבר לקיוסק" on a till by role, "חזרה למצב קיוסק" on a kiosk working as a till). */
  switchLabel?: string;
  /** "חוזר לקיוסק בעוד N שניות": the idle return's notice, while within it. */
  countdownSec?: number | null;
}

export interface TillState {
  protocol: number;
  session: SessionState;
  sell: SellState;
  checkout: CheckoutState;
  shift: ShiftState;
  z: ZState;
  health: HealthState;
  dialog: EngineDialog | null;
  mode: ModeState;
  /**
   * "הסתרת פריטים בתפריט הקופה" (`hiddenMenuItems`, core/till/menuHide.ts — the Android MenuHide keys): the menu items
   * this till does not show. Hiding only hides — the engine's rules are untouched. Absent: none.
   */
  menuHidden?: string[];
  /** The tiles' text (TileTextState); absent: the defaults (fit, 3 lines, s, auto). */
  tileText?: TileTextState;
  /** "דוח X סניפי" (core/till/shopX.ts): offered on this till, and the report last brought (until sign-out). */
  shopX?: ShopXState;
  /** "מכירות בהמתנה" (core/till/heldSales.ts). */
  held?: HeldState;
  /** OTH ("על חשבון הבית"), as the parameters set it. */
  oth?: OthState;
  /**
   * "סגירה אוטומטית במשמרת הקודמת" (core/till/autoCloseCart.ts): what the next shift is told, once (a basket held or voided,
   * held sales cancelled) — until the cashier says "הבנתי" (`session.activity` with `ack`). Absent: nothing to tell.
   */
  notice?: { title: string; text: string } | null;
  /** "מגירת מזומן" (main/till/tillDrawer.ts): the menu's drawer rows, the reasons, a count in progress. */
  drawer?: DrawerState;
  /** "עובד מחובר בקופה אחת בלבד" (main/till/userSessions.ts): the banner, and "עובדים מחוברים". */
  users?: UsersState;
  /** "עודף חייב ללקוח" / "זיכוי מוחזק" the cloud routes to this till (main/till/tillCash.ts), "שולם ללקוח" on each. */
  owed?: { items: Array<{ id: string; line: string; amountAgorot: number }> };
}

export interface SignedInSession {
  id: string;
  posUserId: string;
  posUserName: string | null;
  machineName: string | null;
  posNumber: string | null;
  startedAt: string | null;
  lastSeenAt: string | null;
  silentSince: string | null;
  openTables: number;
  here: boolean;
}

export interface UsersState {
  notice: string | null;
  offered: boolean;
  list: { sessions: SignedInSession[]; at: number } | null;
  busy: boolean;
  error: string | null;
}

export interface DrawerState {
  offered: { open: boolean; cashIn: boolean; cashOut: boolean; deposit: boolean; count: boolean; walletDeposit: boolean; log: boolean; remote: boolean };
  /** "פתיחת מגירה ב<קופה>": the tills whose drawer may be opened from here. */
  hosts: Array<{ id: string; label: string }>;
  requireReason: boolean;
  requireNoteForOther: boolean;
  movementsEnabled: boolean;
  blindCount: boolean;
  reasons: Array<{ code: string; label: string }>;
  count: { blind: boolean; expectedAgorot: number | null; result: { countedAgorot: number; expectedAgorot: number | null; varianceAgorot: number | null } | null } | null;
}

export interface ShopXState {
  /** The till's parameters put it on this till (`shopXTills`); the user's right is in `session.permissions`. */
  offered: boolean;
  report: {
    title: string;
    businessName: string | null;
    subtitle: string | null;
    sections: Array<{ title: string | null; rows: Array<{ label: string; value: string; emphasis: boolean }> }>;
    footer: string | null;
  } | null;
  /** When it was brought (epoch ms). */
  at: number | null;
  busy: boolean;
  error: string | null;
}

export interface XReport {
  shiftNumber: number | null;
  salesCount: number;
  salesAgorot: number;
  cashAgorot: number;
  cardAgorot: number;
  expectedCashAgorot: number;
  demo: boolean;
  /** The real engine's X (core/sale.ts buildXTill): the rest of the paper's figures. */
  openingCashAgorot?: number;
  discountsAgorot?: number;
  refundsAgorot?: number;
  vatAgorot?: number;
  tipsAgorot?: number;
  itemsCount?: number;
  /** "מגירת מזומן": the shift's Cash In / Cash Out / deposits, and the wallets (drawer-away §5.6) — in the expected cash. */
  cashInAgorot?: number;
  cashOutAgorot?: number;
  depositsAgorot?: number;
  walletInAgorot?: number;
  walletDepositsAgorot?: number;
  /** The paper went to the printer. */
  printed?: boolean;
}

/** The engine's answer to `session.hello`: the protocol it speaks, and the state (full, or since). */
export interface HelloReply {
  protocol: number;
  seq: number;
  state: TillState;
}

/**
 * One engine as a transport sees it: the mock in this tree, the IPC door of the Windows shell
 * (main/roles/till.ts), and later the JVM over stdio, the cloud over WebSocket, the APK in-process.
 */
export interface EngineEndpoint {
  hello(since?: number): HelloReply | Promise<HelloReply>;
  call(call: EngineCall): Promise<EngineReply>;
  on(fn: (event: EngineEvent) => void): () => void;
}

/**
 * Whether the till is in the middle of something — the update and the role switch wait for it
 * (§6.3, §8.2): a cart, a payment, an engine dialog, a card in the terminal.
 */
export function tillBusy(s: TillState): boolean {
  return s.sell.lines.length > 0 || s.checkout.phase !== 'idle' || s.dialog !== null || s.health.terminal === 'busy';
}

/* -------------------------------------------------------- hw.* (engine → host) */

export type HwJobKind = 'receipt' | 'bon' | 'report' | 'test' | 'drawer';

export type HwRequest =
  | { type: 'hw.print'; requestId: string; jobId: string; target: string; bytesB64: string; kind: HwJobKind; ticket?: string }
  | { type: 'hw.drawer'; requestId: string; target: string; ticket?: string }
  | {
      type: 'hw.channel.open';
      requestId: string;
      kind: 'tcp' | 'tls' | 'https-request' | 'serial';
      address: string;
      tls?: { pinSha256?: string };
      serial?: { baudRate: number };
      ticket?: string;
    }
  | { type: 'hw.channel.write'; requestId: string; channelId: string; bytesB64: string }
  | { type: 'hw.channel.read'; requestId: string; channelId: string; max?: number; timeoutMs?: number }
  | { type: 'hw.channel.close'; requestId: string; channelId: string }
  | { type: 'hw.systemPrint'; requestId: string; pngB64?: string; pdfB64?: string };

export type HwErrorCode = 'unsupported' | 'no_device' | 'offline' | 'refused' | 'timeout' | 'io' | 'unknown_channel' | 'not_permitted';

export interface HwResult {
  requestId: string;
  ok: boolean;
  code?: HwErrorCode;
  message?: string;
  channelId?: string;
  bytesB64?: string;
}
