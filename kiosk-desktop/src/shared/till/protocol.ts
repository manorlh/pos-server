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
  // "הנחות קבועות" (core/till/presetDiscounts.ts): a preset's one tap — replaces the basket discount; again takes it off.
  'discount.preset',
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
  // Vouchers (main/till/tillVouchers.ts): a voucher scanned at the payment, "הסר", "סיום בדיקה"; a voucher scanned on the sell
  // screen with items in the order goes to the payment and is applied there ("מימוש אוטומטי בסריקת שובר").
  'checkout.voucher',
  'checkout.removeVoucher',
  'checkout.finishTest',
  'sell.voucher',
  // "פרטי הזמנה" (core/till/orderDetails.ts): "לקחת / לשבת" and the customer's name given; the sheet closed; the strip's edit.
  'order.details',
  'order.dismiss',
  'order.edit',
  // "פעולות אשראי" (main/till/tillTransmission.ts): the screen opened (its view in the state), "שדר עסקאות עכשיו", the deferred
  // mode's switch and "אשר עסקאות ממתינות" (TRANSMIT), the terminal read again, the history's next page.
  'transmission.open',
  'transmission.now',
  'transmission.offline',
  'transmission.authorize',
  'transmission.read',
  'transmission.more',
  // "חסומים כעת" / "חסום / אזל" (main/till/tillItemBlocks.ts): the blocks in force, an item's sheet, a block, a release.
  'blocks.list',
  'blocks.sheet',
  'blocks.block',
  'blocks.release',
  // "תור הדפסה" / "מדפסת חלופית" (main/till/tillPrintQueue.ts): the tickets that need a person, where one may go, "הדפס שוב",
  // "העבר למדפסת אחרת", "סמן כטופל" (a manager's code), "בטל הפניה".
  'printQueue.list',
  'printQueue.choices',
  'printQueue.retry',
  'printQueue.move',
  'printQueue.handled',
  'printQueue.endRedirect',
  // "תפריט" as the Android drawer (core/till/tillMenu.ts, main/till/tillMenuService.ts): "סנכרון מול הענן", "עדכון גרסה",
  // "תמיכה מרחוק"; the local reports (24 hours, shifts, Zs, products, workers, tips) and a Z's copy.
  'menu.sync',
  'menu.update',
  'menu.support',
  'report.local',
  'report.reprintZ',
  // "קיוסקים" on a controlling till (main/till/tillKiosks.ts): the kiosks again, a command to one.
  'kiosks.refresh',
  'kiosks.command',
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
  'discount.preset',
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
  'checkout.voucher',
  'checkout.removeVoucher',
  'checkout.finishTest',
  'sell.voucher',
  'order.details',
  'order.dismiss',
  'order.edit',
  'transmission.now',
  'transmission.offline',
  'transmission.authorize',
  'blocks.block',
  'blocks.release',
  'printQueue.retry',
  'printQueue.move',
  'printQueue.handled',
  'printQueue.endRedirect',
  'menu.sync',
  'menu.update',
  'menu.support',
  'report.reprintZ',
  'kiosks.command',
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
  /** `hours`: the documents of the last so many hours ("24 השעות האחרונות"); absent — today's. */
  'doc.history': { limit?: number; hours?: number };
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
  /** A preset by its id; "עבור מי" when the preset asks it (a picked employee / the customer, or typed). */
  'discount.preset': { presetId: string; for?: string; forKind?: 'employee' | 'customer' | 'typed'; forRef?: string };
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
  /** A voucher's code as scanned or typed. */
  'checkout.voucher': { code: string };
  /** A voucher of `checkout.vouchers.items` (its id). */
  'checkout.removeVoucher': { id: string };
  'checkout.finishTest': Record<string, never>;
  /** A voucher scanned on the sell screen: the payment opens and the voucher is applied there. */
  'sell.voucher': { code: string };
  /** The order's details: each given one is kept (a missing one that is asked is refused). */
  'order.details': { dining?: 'take_away' | 'eat_in' | null; name?: string | null };
  'order.dismiss': Record<string, never>;
  'order.edit': Record<string, never>;
  'transmission.open': Record<string, never>;
  'transmission.now': Record<string, never>;
  'transmission.offline': { on: boolean };
  'transmission.authorize': Record<string, never>;
  'transmission.read': Record<string, never>;
  'transmission.more': Record<string, never>;
  'blocks.list': Record<string, never>;
  'blocks.sheet': { productId?: string; categoryId?: string };
  'blocks.block': {
    productId?: string | null;
    categoryId?: string | null;
    kind: 'sold_out' | 'blocked';
    channels: Array<'pos' | 'kiosk' | 'online' | 'menu'>;
    level: 'shop' | 'area' | 'machine' | 'event';
    levelId?: string | null;
    kioskDisplay?: 'hide' | 'grey' | null;
    note?: string | null;
    duration: { mode: 'minutes'; minutes: number } | { mode: 'time'; at: string } | { mode: 'end_of_day' } | { mode: 'none' };
  };
  'blocks.release': { ids: string[] };
  'printQueue.list': Record<string, never>;
  'printQueue.choices': { jobId: string };
  'printQueue.retry': { jobId: string };
  'printQueue.move': { jobId: string; toId: string; alsoNext?: boolean };
  'printQueue.handled': { jobId: string };
  'printQueue.endRedirect': { fromId: string };
  'menu.sync': Record<string, never>;
  /** "עדכון גרסה": install the release that is ready (the app restarts into it). */
  'menu.update': Record<string, never>;
  'menu.support': Record<string, never>;
  /** A local report; `preset`: the range of the products / workers / tips reports (absent: today). */
  'report.local': { kind: LocalReportKind; preset?: ReportPreset };
  /** "הדפס שוב" on a Z of "דוחות Z": a copy, marked so. */
  'report.reprintZ': { id: string };
  'kiosks.refresh': Record<string, never>;
  /** `minutes`: "נעילה למכירה" for so long (absent: until reopened by hand); `message`: to the customers. */
  'kiosks.command': { kioskId: string; action: 'pause' | 'resume' | 'close_shift' | 'till_z' | 'bon_print' | 'bon_handled' | 'reprint_bon' | 'reprint_receipt'; message?: string | null; minutes?: number | null };
}

/** One kiosk as the panel shows it. */
export interface KioskControlRow {
  machineId: string;
  name: string;
  online: boolean;
  /** "פעיל" / "מושהה", the screen it is on, when last seen. */
  stateLine: string;
  ordersLine: string;
  printerLine: string;
  unprintedLine: string | null;
  alertsLine: string | null;
  unprintedOrders: Array<{ localId: string; text: string }>;
  locked: { by: string; until: string } | null;
  /** By its Z mode: "סגירת משמרת" (the shop's Z) or "הפקת Z" (its own); null with no shift open there. */
  z: { action: 'close_shift' | 'till_z'; label: string } | null;
  zNote: string | null;
}

/** "קיוסקים" (core/till/kioskControl.ts): the kiosks this till controls, a command on its way, how the last went. */
export interface KiosksState {
  rows: KioskControlRow[];
  busy: boolean;
  note: { text: string; ok: boolean } | null;
}

/** The reports of the menu's "דוחות" folder the till builds from its own records (core/till/localReports.ts). */
export type LocalReportKind = 'shifts' | 'tillZs' | 'products' | 'workers' | 'tips';

/** The range chips of the products / workers / tips reports (Android RangePreset, less "custom"). */
export type ReportPreset = 'today' | 'yesterday' | 'week' | 'morning' | 'evening';

/** A local report as the screen draws it: a title, its range, sections of rows; a Z row may be printed again. */
export interface LocalReportView {
  kind: LocalReportKind;
  title: string;
  subtitle: string | null;
  /** The range's chips (the products / workers / tips reports); null — none. */
  preset: ReportPreset | null;
  sections: Array<{
    title: string | null;
    rows: Array<{ label: string; value: string; sub?: string | null; emphasis?: boolean; tone?: 'ok' | 'warn' | 'error' | null; reprintZ?: string | null }>;
  }>;
  /** Nothing in the range: its sentence. */
  empty: string | null;
}

/**
 * The ☰ menu's facts the screens cannot know (core/till/tillMenu.ts builds the rows): who the till is (the profile card and
 * its details), the sync on demand, the release the cloud assigned, what the engine offers.
 */
export interface TillMenuState {
  /** The profile card: the role's name, the till's place; the details a tap shows (support asks "which till?"). */
  roleName: string | null;
  shopName: string | null;
  posNumber: string | null;
  identity: Array<{ label: string; value: string }>;
  sync: { running: boolean; lastAt: string | null; error: string | null; waiting: number };
  update: { version: string; phase: 'available' | 'downloading' | 'ready' | 'installing' | 'failed'; message: string | null } | null;
  /** "דוחות Z": this till makes its Zs or holds some. */
  showTillZHistory: boolean;
  /** "תמיכה מרחוק" can be asked here (a Windows shell). */
  support: boolean;
  /** The local report last brought (`report.local`, after "דוחות בקופה"); null — none asked yet. */
  report: LocalReportView | null;
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
  voucher_refused: 'השובר לא מומש',
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
  /** The product is a voucher (the catalog's `voucherId`): credited from its receipt only. */
  voucher?: boolean;
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

/**
 * "עיצוב קופה" (pos-server docs/SPEC_TILL_DESIGN.md; core/till/tillDesign.ts builds it with client/src/lib/tillDesign.ts):
 * the cloud's design for this till, resolved for each device profile. The window's size is the screens' to know, so
 * the state carries a view per profile and the screens pick one — `designFor(design, tillDesignProfileOf(w, h))`
 * (core/till/tillDesign.ts; Android `deviceProfileOf`: a short side under 600 dp — handheld, else sideways / upright).
 */
export type TillDesignProfileName = 'handheld' | 'tabletLandscape' | 'tabletPortrait';
export type TillDesignTemplate = 'clean' | 'touch' | 'professional' | 'seated' | 'fast' | 'mobile' | 'courses' | 'payDock' | 'night' | 'visual';

/** One button of the quick order's bar, as drawn. */
export interface TillDesignAction {
  /** pay | fastCard | cashWithChange | fastCash | cashNotes | hold | discount | customer | orderDetails | clear | repeatRound. */
  action: string;
  /** Its own label, else the design's text (pay), else the default — a preset's: its own, else the preset's name. */
  label: string;
  /** The bar's required button ("pay"): the accent-filled one. */
  primary: boolean;
  /** "הנחות קבועות": a `discount` button that applies this preset (one this till has) in one tap. */
  presetId?: string;
}

/** What one device profile shows (the profile's overrides over the base, every "auto" settled for a quick order). */
export interface TillDesignProfileState {
  profile: TillDesignProfileName;
  /** The template the cloud chose for this profile. */
  template: TillDesignTemplate;
  /** The one this till draws: "courses" is "clean" on a quick order (Android templateDrawn) — the Windows till has no tables. */
  drawn: TillDesignTemplate;
  /** "auto" settled by the till parameters (productTileSize / productTileSizeTablet). */
  tileSize: 'xs' | 's' | 'm' | 'l';
  tileStyle: 'card' | 'photo' | 'row' | 'key' | 'dish';
  density: 'compact' | 'comfortable' | 'spacious';
  /** The quick order's bill: beside (end / start), under the menu, a sheet, or "תפריט ויזואלי"'s drawer. */
  billPosition: 'end' | 'start' | 'bottom' | 'sheet' | 'drawer';
  billStyle: 'lines' | 'cards' | 'seats' | 'compact' | 'courses';
  summaryCollapsible: boolean;
  categoryBar: 'top' | 'side';
  /** 0 — by the tile style and size over the pane's width (client lib `gridColumns`). */
  columns: number;
  images: 'auto' | 'show' | 'hide';
  textSize: 'normal' | 'large';
  /** The template's features a quick order has (searchField, quantityPresets, favorites, payDock, selectedLine, quickAddons, thumbs, dishCards). */
  features: string[];
  /** The quick order's bar. */
  actionBar: TillDesignAction[];
  /** "זרימה": this profile's shell. */
  shell: 'classic' | 'flow';
}

/** The screen texts, each the business's wording or the default (client lib TEXT_DEFAULTS). */
export type TillDesignTexts = Record<
  | 'sendToKitchen'
  | 'newSuffix'
  | 'allSent'
  | 'goToBill'
  | 'pay'
  | 'orderTitle'
  | 'summary'
  | 'emptyOrder'
  | 'serviceType'
  | 'takeAway'
  | 'eatIn'
  | 'customerName'
  | 'addToSeat'
  | 'seatGeneral'
  | 'nextQuantity'
  | 'otherQuantity'
  | 'favorites'
  | 'repeatRound',
  string
>;

export interface TillDesignState {
  /** The cloud's `configVersion` of the design held; null — none pulled yet (the defaults: today's screens). */
  configVersion: string | null;
  profiles: Record<TillDesignProfileName, TillDesignProfileState>;
  /** accent: #RRGGBB, or null — the brand colour (brandPrimaryColor). mode: auto leaves the till's own theme. */
  colors: { accent: string | null; mode: 'auto' | 'light' | 'dark' };
  /** "שטרות": the chosen notes ([] — the next round amounts), how many, and the ones offered over the order's total now. */
  quickCash: { notes: number[]; count: number; offered: number[] };
  bar: { quantityPresets: number[]; favorites: string[]; repeatRound: boolean; openTabs: boolean };
  /** Ids in order ([] — the catalog's); hidden categories leave the tabs only (search still finds them). */
  menu: { categoryOrder: string[]; productOrder: string[]; hiddenCategories: string[] };
  texts: TillDesignTexts;
  /** "auto" settled by the parameters (askOrderName / askEatInTakeAway / tablesAskGuests: required, else off). */
  fields: { customerName: 'off' | 'optional' | 'required'; serviceType: 'off' | 'optional' | 'required'; guests: 'off' | 'optional' | 'required' };
  behavior: { summary: 'auto' | 'open' | 'closed'; lineStatus: boolean };
  payDock: { savings: boolean };
  night: { hand: 'right' | 'left'; quickAddons: boolean };
  /** dietary: "auto" settled by showDietaryMarks. */
  visual: { descriptionLines: number; dietary: 'show' | 'hide' };
  professional: { keyboard: boolean; fKeys: boolean };
  /** prefix: this till's (the cloud's `orderNumberPrefix`), "" while atOpen is off. */
  orderNumber: { atOpen: boolean; prefix: string };
  /** The tiles' text: the design's `look` over the parameters (the same as `TillState.tileText`). */
  look: TileTextState;
  /** "זרימה"'s options (the shell is per profile). background: #RRGGBB, or null — our palette. */
  flow: {
    home: 'auto' | 'orders' | 'tables';
    firstStep: 'type' | 'table' | 'pickup';
    askGuests: 'auto' | 'always' | 'never';
    notes: boolean;
    pickupName: 'auto' | 'off' | 'ask' | 'required';
    background: string | null;
  };
  /** What the design sets that this till does not honour yet, by path (core/till/tillDesign.ts `unsupportedOf`). */
  unsupported: string[];
}

/**
 * The till's colours as Android settles them (domain/TillDesignOverlay.kt applyTillDesign; core/till/tillDesign.ts
 * `themeOf`): the brand colour — the design's accent over the settings' `brandPrimaryColor`; the theme — the design's
 * light / dark over the till parameter `themeMode`; the parameter `textColor` as a colour.
 */
export interface TillThemeState {
  /** #RRGGBB, or null — none set (client lib posLook DEFAULT_BRAND, iOS blue). */
  brand: string | null;
  mode: 'system' | 'light' | 'dark';
  /** "צבע גופן" (posLook textColorOfParam): #RRGGBB for the light theme, or null — the theme's own. */
  textColor: string | null;
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
  /** "כלול בשובר #12 · שובר ארוחה": a production voucher covers it (core/till/vouchers.ts). */
  voucher?: string | null;
  /** A ₪0 voucher line: what its goods were worth ("שווי"), outside every total. */
  voucherValueAgorot?: number;
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
  basketDiscount?: {
    amountAgorot: number;
    type: 'percentage' | 'fixed';
    value: number;
    /** "הנחות קבועות": the preset it is, and whom for. */
    preset?: { id: string; name: string; for: string | null };
  } | null;
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

/** "הנחות קבועות" (core/till/presetDiscounts.ts): the presets in order, the one-tap ones, and the employees "עבור מי" picks from. */
export interface PresetDiscountsState {
  items: Array<{
    id: string;
    name: string;
    kind: 'percent' | 'amount';
    value: number;
    color: string | null;
    requiresManager: boolean;
    forWhom: 'none' | 'optional' | 'required';
    forWhomSource: 'free' | 'employees' | 'club';
  }>;
  buttons: string[];
  employees?: Array<{ id: string; name: string }>;
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
  /** `cash_credit`: "זיכוי מזומן" (a station's credit, `CC:` code) towards the goods. `production_voucher`: "שוברי הפקה". */
  method: 'cash' | 'card' | 'cash_credit' | 'production_voucher';
  amountAgorot: number;
  status: 'approved' | 'pending';
  /** A cash credit's code and redemption ("הסרת הזיכוי" names it). */
  credit?: { code: string; redemptionId: string };
  /** A production voucher's leg: its number ("שובר #12"). */
  voucher?: { serial: number };
}

/** The payment's vouchers (main/till/tillVouchers.ts). */
export interface CheckoutVouchers {
  /** Each voucher of the sale: "הסר" takes it off (`checkout.removeVoucher`). */
  items: Array<{ id: string; kind: 'production' | 'discount'; label: string; what: string; amountAgorot: number; test: boolean }>;
  /** "מצב בדיקה — השובר לא ימומש ושום דבר לא יירשם": the orange bar; null — a real sale. */
  testBar: string | null;
  testDue: string | null;
  /** "הלקוח זכאי לעוד פריט מהשובר: …" — the orange alert. */
  entitlement: string | null;
  /** A voucher is being checked with the cloud. */
  busy: boolean;
  /** "השובר הוחל: …" (green) / the refusal (red) of the last scan. */
  applied: string | null;
  error: string | null;
  /** "מימוש אוטומטי בסריקת שובר". */
  autoApply: boolean;
  /** The production vouchers' deductions ("קיזוז שוברי הפקה") inside the total; and the total before them. */
  deductionAgorot: number;
  /** "שווי הפריטים בשובר": the ₪0 vouchers' goods, outside every total. */
  goodsValueAgorot: number;
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
  /** §13 (nayax-deferred-all): the terminal works deferred — the amber warning above the tenders. Absent: online. */
  deferredNotice?: string | null;
  /** A basket with returns: its figures and its step. Absent: a plain sale. */
  basket?: CheckoutBasket | null;
  /** Every document the payment wrote (a basket: the sale and its credit notes), as printed. */
  documentRefs?: string[];
  /** The payment's vouchers; absent — none, and none can be scanned here. */
  vouchers?: CheckoutVouchers | null;
  /** "סיום בדיקה": the simulation's end — what would have been covered and left to pay; nothing was written. */
  testEnd?: string[] | null;
  /**
   * "מסך הצלחה במימוש שובר" (`voucherSuccessScreen`): the sale redeemed vouchers — "השובר מומש בהצלחה", what was redeemed,
   * and (amber) what the customer did not take.
   */
  voucherSuccess?: { title: string; detail: string | null; notTaken: string | null; note: string | null } | null;
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
  /** `check`: a box, unticked; its answer is "true" / "false" with whichever action is chosen. */
  kind: 'pin' | 'text' | 'check';
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
  /** The ☰ menu's own facts (TillMenuState); absent (the demo): the menu shows what the rest of the state allows. */
  menu?: TillMenuState;
  /** "קיוסקים": only on a till that controls kiosks. */
  kiosks?: KiosksState;
  /** The tiles' text (TileTextState; the design's `look` over the parameters); absent: the defaults (fit, 3 lines, s, auto). */
  tileText?: TileTextState;
  /** "הכל" among the order's categories (core/till/sellAllTab.ts, the parameter `sellAllTab`); absent: hidden, Android's default. */
  sellAllTab?: 'first' | 'last' | 'hidden';
  /**
   * "עיצוב קופה" (TillDesignState), kept offline from the last pull. Optional: an engine from before it (an older shell
   * or APK host behind a newer bundle) sends none — the screens then draw today's (clean) screens.
   */
  design?: TillDesignState;
  /** The colours (TillThemeState). Optional for the same reason: absent — the defaults (iOS blue, the system's theme). */
  theme?: TillThemeState;
  /** "דוח X סניפי" (core/till/shopX.ts): offered on this till, and the report last brought (until sign-out). */
  shopX?: ShopXState;
  /** "מכירות בהמתנה" (core/till/heldSales.ts). */
  held?: HeldState;
  /** OTH ("על חשבון הבית"), as the parameters set it. */
  oth?: OthState;
  /** "הנחות קבועות" as the settings set them; absent: none (nothing shows). */
  presetDiscounts?: PresetDiscountsState;
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
  /**
   * "פרטי הזמנה" of a quick order (core/till/orderDetails.ts — `askEatInTakeAway`, `askOrderName`, `orderDetailsAt`): the
   * answers, the strip's words ("לקחת  ·  דני"), and the sheet the engine asks for now. Absent: none asked, none given.
   */
  /** "פעולות אשראי" once opened (main/till/tillTransmission.ts TransmissionView). */
  transmission?: TransmissionState;
  /** The sell screen's amber banner: the terminal works deferred, or deferred sales wait for the card company. */
  terminalOffline?: { text: string; tone: 'amber' };
  /** "בון לא הודפס במדפסת מטבח": the red strip, how many, and the redirects in force ("«בר» נשלחת ל«מטבח» עד 14:20"). */
  printQueue?: { banner: string | null; count: number; redirects: Array<{ fromId: string; text: string }> };
  order?: {
    dining: 'take_away' | 'eat_in' | null;
    name: string | null;
    strip: string | null;
    /** Some question is switched on (the strip's ✎ opens them). */
    configured: boolean;
    ask: OrderAsk | null;
  };
}

/** "פעולות אשראי" as the screen shows it. */
export interface TransmissionState {
  supported: boolean;
  deferredSupported: boolean;
  offline: {
    reading: boolean;
    failed: boolean;
    status: { allowed: boolean; working: boolean; readAt: number } | null;
    stateLine: string | null;
    limitsLine: string | null;
    switching: boolean;
  };
  pendingLine: string | null;
  neverTransmitted: boolean;
  lastFailed: string | null;
  running: boolean;
  message: string | null;
  history: {
    rows: Array<{ id: string; at: string | null; status: string; tone: 'ok' | 'error' | 'muted'; trigger: string; facts: string[]; detail: string | null; unsynced: boolean }>;
    total: number | null;
    error: string | null;
    loading: boolean;
    more: boolean;
  };
}

/** The order's details sheet: why it is up, what it asks (mandatory), its button's words. */
export interface OrderAsk {
  /** `start` — a new order opens with them; `open` — its first item waits; `payment` — before paying; `edit` — the strip's. */
  purpose: 'start' | 'open' | 'payment' | 'edit';
  dining: boolean;
  name: boolean;
  confirmLabel: string;
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
  /** "שוברי הפקה": what production vouchers paid as a tender; and the vouchers' sections (information, in no figure above). */
  vouchersAgorot?: number;
  voucherInfo?: Array<{ label: string; value: string; title?: boolean }>;
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
