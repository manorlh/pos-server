/**
 * The till's engine on the Windows kiosk core (the owner, 10.10.2026: the installed Windows app is a till too).
 *
 * The till screens (renderer/roles/till — the one app bundle) talk to an `EngineEndpoint` (shared/till/protocol.ts):
 * envelopes in, a state with a rising `seq` out. Until now that was the demo mock; this is the REAL one, a thin adapter
 * over what the kiosk already is — nothing fiscal is invented here:
 *
 *  - the catalog, prices, promotions, blocks, sold-out and the VAT are the kiosk's own shared code
 *    (service.tillCatalogData / priceTillBasket → client/src/lib/kioskMoney.ts, kioskSoldOut.ts), on the till channel;
 *  - a document is the same 320/400 the kiosk writes (main/fiscal/ledger.ts — counters saved before use, one series per
 *    machine, never renumbered), with `payments` legs (cash / card), the cash handed over and the change, and the
 *    employee signed in as its cashier; it goes to the cloud through the same outbox;
 *  - a card goes through the configured terminal's provider and the card-recovery rules (payment/payService.ts) —
 *    the pending document is written BEFORE the frame leaves, and an unknown answer blocks until it is resolved;
 *  - shifts open with the float counted into the drawer and close with the counted cash (X frozen into the close);
 *    the Z is the machine's own (fiscal/tillZService.ts) only in zMode = till — otherwise closing the shift is all this
 *    till does, exactly as the kiosk's own Z today;
 *  - staff sign in with their PIN from the synced roster, with the cloud's permissions and limits (core/till/staff.ts,
 *    core/till/permissions.ts — "כשאין הרשאה" included), offline;
 *  - "זיכוי" (core/till/refundMath.ts, core/till/basket.ts): from the history (a credit note for the picked lines of a
 *    document — cash from the drawer, or the original's card at the terminal) and on the sell screen (a catalog return or
 *    lines picked off a receipt, in a mixed basket with the sale: a 320 and its 330s, exchange legs, one payout); a credit
 *    note is a 330 (−400 for a receipt or an exempt dealer) in its own series, linked to its original;
 *  - "הנחה" on a line and on the basket, OTH ("על חשבון הבית"), with the role's ceilings (core/till/discounts.ts);
 *  - "מכירות בהמתנה" (core/till/heldSales.ts, main/till/heldStore.ts), and every close asking about them;
 *  - the automatic close of a shift with a basket open (core/till/autoCloseCart.ts) — `autoCloseTick`, from the service.
 *
 * Android is the reference: the flows and the Hebrew sentences are copied from pos-android (ui/sell, ui/checkout,
 * ui/history, res/values/strings*.xml). Out of today's scope, the screens say "בקרוב": tables, vouchers and club,
 * attendance, the customer display.
 *
 * The state is the engine's alone (§3.3): the screens show what it says. Every changing op carries a `clientOpId` and is
 * never applied twice. Electron-free: tests drive it over a real KioskService with a fake terminal and printer.
 */

import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { formatShekelSign, ofShekels, times } from '../../core/money';
import { docQueryMatches, docQueryNumbers, formatDocNumber, parseDocQuery, prefixFor } from '../../core/documentNumbers';
import { localDate } from '../../core/kioskOrders';
import { acquirerTransactionIdOf } from '../../core/nayax';
import {
  buildXTill,
  creditDocumentType,
  creditTotals,
  isCreditType,
  isSaleType,
  lineGross,
  saleDocumentType,
  saleTotals,
  unitAgorot,
  vatRateForType,
  type SaleLine,
  type SaleTotals,
} from '../../core/sale';
import { vatNet } from '../../core/money';
import { zModeOf } from '../../core/tillZ';
import { parameterOn } from '../sync/cloud';
import { CODES, NO_LOCK, type BcryptCompare, type ExitLock } from '../../core/desktopExit';
import { PERM, TEXT, displayName, loginCandidates, permLabel, stateOf, tryLogin, type RosterUser } from '../../core/till/staff';
import {
  actingProfile,
  approvalText,
  approveWithin,
  decide,
  deniedText,
  deniedUiSettingsOf,
  mayApprove,
  profileOf,
  shows,
  type Decision,
  type EntryKind,
  type PermissionProfile,
  type ProfileUser,
} from '../../core/till/permissions';
import {
  alreadyRefunded,
  collectedPerLine,
  creditFor,
  creditedShekels,
  refundLines,
  remainingQuantities,
  type RefundItem,
} from '../../core/till/refundMath';
import {
  BasketMismatch,
  EXCHANGE,
  REFUND_CUSTOMER_DETAILS_PARAM,
  UNLINKED_CARD_CREDIT_PARAM,
  basketCreditsOf,
  basketNextStep,
  cardPayoutRoute,
  creditTotal,
  onUnlessFalse,
  planBasketTenders,
  returnCustomerComplete,
  returnCustomerRequired,
  type BasketCredit,
  type CardPayoutRoute,
  type LinkCandidate,
  type Tender,
} from '../../core/till/basket';
import {
  OTH_PERCENT,
  basketDiscountKindOf,
  basketDiscountPercentOf,
  basketDiscountPreview,
  basketDiscountRate,
  committedBasketDiscount,
  documentDiscountAmount,
  lineDiscountAmount,
  othDecide,
  othNeed,
  othRefusal,
  othSettingsOf,
  type BasketDiscountPreview,
  type DiscountType,
  type OthMark,
} from '../../core/till/discounts';
import {
  KIND_PRESET,
  PRESET_DISCOUNTS_KEY,
  PRESET_DISCOUNT_BUTTONS_KEY,
  PRESET_ID_MAX,
  applyPreset,
  presetCartDiscount,
  presetForOf,
  resolvePresetDiscounts,
  type PresetMark,
  type ResolvedPresets,
} from '../../core/till/presetDiscounts';
import {
  HELD_CANCEL_AUTO_CLOSE,
  HELD_CANCEL_LOCAL,
  HELD_TEXT,
  TILL_EVENT_HELD_SALE_CANCELLED,
  allowCloseWithHeldSales,
  heldSaleCancelDetails,
  heldSalesGate,
  holdLabelOf,
  holdRefusal,
  summaryOf,
  type HeldLine,
  type HeldSaleSummary,
} from '../../core/till/heldSales';
import {
  AUTO_CLOSE_PARK_LABEL,
  TILL_EVENT_AUTO_CLOSE_HELD_CANCELLED,
  TILL_EVENT_SHIFT_AUTO_CLOSED,
  autoCloseCartDetails,
  autoCloseCartEventType,
  autoCloseDecision,
  autoCloseHeldCancelledDetails,
  autoCloseRulesOf,
  autoCloseNextShiftNotice,
  shiftAutoClosedDetails,
  worthNotice,
  type AutoCloseCart,
  type AutoCloseRecord,
  type AutoCloseSaleLook,
} from '../../core/till/autoCloseCart';
import { autoCloseDue, autoCloseTimeOf } from '../../core/tillZ';
import { cardLast, dueOf, handedTotal, paidOf, quickNotes, takeCash, validCashAmount, type TenderLeg } from '../../core/till/tender';
import { HIDDEN_MENU_PARAM, parseHiddenMenu } from '../../core/till/menuHide';
import { tileTextOf } from '../../core/till/tileText';
import { PARAM_SELL_ALL_TAB, parseSellAllTab } from '../../core/till/sellAllTab';
import { designParameters, tendersOf, themeOf } from '../../core/till/tillDesign';
import { SHOP_X_TEXT, shopXDocumentOf, shopXOffered, shopXRefusal, type ShopXDocument } from '../../core/till/shopX';
import type { StartPaymentIn } from '../../shared/bridge';
import {
  MUTATING_OPS,
  TILL_OPS,
  TILL_PROTOCOL,
  engineError,
  engineErrorText,
  type BasketDiscountMode,
  type Catalog,
  type CartLine,
  type CheckoutBasket,
  type CheckoutState,
  type DeviceRoleName,
  type DocumentDetail,
  type EngineCall,
  type EngineDialog,
  type EngineEndpoint,
  type EngineError,
  type EngineEvent,
  type EngineReply,
  type HelloReply,
  type Product,
  type RefundableLine,
  type TillErrorCode,
  type TillOp,
  type TillState,
  type XReport,
} from '../../shared/till/protocol';
import { docVoucherDiscounts, legsOf, settled, xDocOf, type AppliedPromotionRow, type BasketDocInput, type DocDraft, type DocLeg } from '../fiscal/ledger';
import type { VoucherOutcome } from '@dash-lib/kioskVouchers';
import {
  VOUCHER_TEST_TEXT,
  VOUCHER_TEXT,
  bookProductionVouchers,
  lineNet,
  offVoucherLineValues,
  voucherInfoEmpty,
  voucherInfoFromJson,
  voucherInfoJson,
  voucherInfoLines,
  voucherInfoOf,
  voucherCloseMessages,
  voucherLeaveText,
  voucherLeftOf,
  voucherRefundRefusal,
  voucherSuccessModeOf,
  voucherSuccessOf,
  voucherSuccessShows,
  VOUCHER_LEAVE_TEXT,
  type VoucherCloseKind,
  type DocPrepaidRedemption,
  type VoucherInfoTotals,
} from '../../core/till/vouchers';
import { TillVouchers } from './tillVouchers';
import type { KioskService } from '../service';
import { HeldStore } from './heldStore';
import { tillWithDrawer, type CashMovementTotals, type WalletTotals } from '../../core/till/drawer';
import { DRAWER_PERM } from '../../core/till/drawer';
import { TillDrawer } from './tillDrawer';
import { TillRemotePrint, type TillRemotePrintOptions } from './tillRemotePrint';
import { TillTransmission } from './tillTransmission';
import { TillShopXLan } from './tillShopXLan';
import { TillItemBlocks } from './tillItemBlocks';
import { TillPrintQueue } from './tillPrintQueue';
import { TillCustomerDisplay } from './tillCustomerDisplay';
import { TillMenuService } from './tillMenuService';
import { TillDesignService } from './tillDesign';
import { TillKiosks } from './tillKiosks';
import { KIOSK_CONTROL_TEXT } from '../../core/till/kioskControl';
import { TillKioskOrders } from './tillKioskOrders';
import { TillCatalogAdmin } from './tillCatalogAdmin';
import { TillShopZ } from './tillShopZ';
import { TillAttendance } from './tillAttendance';
import { TillReadyOrders } from './tillReadyOrders';
import { TillAlertsService } from './tillAlertsService';
import { TillVoucherBalance } from './tillVoucherBalance';
import { TillVoucherStation } from './tillVoucherStation';
import { TillCloudZ } from './tillCloudZ';
import { TillPrinters } from './tillPrinters';
import { TillScreenEdit } from './tillScreenEdit';
import { arrangeCatalog } from '../../core/till/screenEdit';
import { KPAY_TEXT, orderNameOf, type KioskBasketLine, type KioskOpenOrder } from '../../core/till/kioskOrders';
import { FAILOVER_TEXT, ticketTitleOf } from '../../core/kitchen/failover';
import { IB_TEXT } from '../../core/till/itemBlocks';
import type { LanCall } from '../kitchen/kitchenNet';
import { REFUSED_OFFLINE_TEXT, TX_TEXT, offlineRefusedCard } from '../../core/till/transmission';
import { TillSessions } from './userSessions';
import { CREDIT_TEXT, TillCash, redeemCredit } from './tillCash';
import { DeviceGate, TillDeviceCash, type TillDeviceCashDeps } from './tillDeviceCash';
import { DEVICE_CASH_TEXT, deviceSettle, type DeviceLegMeta } from '../../core/till/deviceCash';
import type { DialogSpec, TillContext, TillFeature } from './tillContext';
import {
  ORDER_TEXT,
  anyQuestion,
  cleanOrderName,
  diningOf,
  missingOrderDetails,
  orderDetailsStrip,
  orderQuestionsOf,
  startDetailsDue,
  type Dining,
  type OrderFacts,
  type OrderQuestions,
} from '../../core/till/orderDetails';
import type { OrderAsk, PresetDiscountsState } from '../../shared/till/protocol';
import {
  NO_CHOICES,
  PARAM_MODIFIERS_AUTO_OPEN,
  PARAM_NOTES_AUTO_OPEN,
  SHEET_QTY_MAX,
  cleanAllergies,
  cleanMeal,
  cleanNotes,
  cleanOptions,
  defaultOptions,
  lineWords,
  mealRefusal,
  needsSheet,
  optionsRefusal,
  paramOn,
  sameChoices,
  type ChoiceGroupView,
  type LineChoices,
  type MealSlotView,
} from '../../core/till/choices';
import { moneyGroupOf } from '../kiosk/catalog';
import { CARD_TIPS_ASK_TEXT, amountText, cardTipsFromDrawerOn, cardTipsShortfallOf, withCashWithTips, xCashBlock, type CardTipsChoice } from '../../core/till/cashWithTips';

/** The parts of the work-mode runtime (main/workMode.ts) the till asks of; null until it is wired. */
export interface TillWorkMode {
  mode(): 'kiosk' | 'till';
  homeTill(): boolean;
  offered(): { toTill: boolean; toKiosk: boolean };
  mayReturn(): { wire: string; text: string } | null;
  countdownSec(): number | null;
  checkManagerCode(code: string): Promise<{ ok: true; id: string; name: string } | { ok: false; reason: string; message: string }>;
  returnToKiosk(source: 'manual' | 'idle' | 'remote' | 'cloud', by?: string | null, byId?: string | null): Promise<{ wire: string; text: string } | null>;
  setTillFacts(
    fn: () => {
      basketOpen: boolean;
      checkoutOpen: boolean;
      holdsTender: boolean;
      cardInFlight: boolean;
      tableOpen: boolean;
      heldSales: number;
      employee: { id: string; name: string } | null;
      lastActivityAtMs: number | null;
    },
  ): void;
  onChange(fn: () => void): () => void;
}

export interface TillEngineOptions {
  svc: KioskService;
  /** bcrypt, injected for tests (the roster's PIN hashes are bcrypt only). */
  compare?: BcryptCompare;
  now?: () => number;
  workMode?: () => TillWorkMode | null;
  log?: (m: string) => void;
  /** "הדפסה בקופה אחרת": the transport, the clock and the drawing (tests). */
  remotePrint?: TillRemotePrintOptions;
  /** "דוח X סניפי" over the LAN: the LAN call, the clock; `manual` — no poll timer (tests drive it). */
  shopXLan?: { lanCall?: LanCall; sleep?: (ms: number) => Promise<void>; manual?: boolean };
  /** Vouchers through the shop's LAN host: the LAN call (tests). */
  voucherLan?: LanCall;
  /** "מזומן במכשיר": the CashMag / cash station clients (tests: fakes); absent — the device's own (svc.cashMag, svc.cashPay). */
  deviceCash?: TillDeviceCashDeps;
}

class Refusal extends Error {
  constructor(readonly error: EngineError) {
    super(error.code);
  }
}

const refuse = (code: TillErrorCode, message?: string, details?: Record<string, unknown>): never => {
  throw new Refusal(message ? engineErrorText(code, message, details) : engineError(code, details));
};

const REMEMBER_OPS = 500;
const MAX_QTY = 999;
const PALETTE = ['#2563eb', '#16a34a', '#d97706', '#dc2626', '#7c3aed', '#0891b2', '#be185d', '#4d7c0f', '#b45309', '#475569'];
const LOGIN_LOCK = 'till.loginLock';
const APPROVAL_LOCK = 'till.approvalLock';
const AUTO_CLOSE_NOTICE = 'till.autoCloseNotice';
const AUTO_CLOSE_RECORDS = 'till.autoCloseRecords';
/** The codes the screens show or hide by. */
const SESSION_CODES = [
  PERM.SELL,
  PERM.SHIFT_OPEN,
  PERM.SHIFT_CLOSE,
  PERM.X,
  PERM.Z,
  PERM.REPRINT,
  PERM.DRAWER_ON_CASH_SALE,
  PERM.KIOSK_TILL_MODE,
  PERM.SHOP_X,
  PERM.REFUND,
  PERM.DISCOUNT,
  PERM.OTH,
  PERM.LINE_VOID,
  PERM.HELD_SALE_CANCEL,
  // "מגירת מזומן" (tillDrawer.ts): the screens' drawer rows.
  DRAWER_PERM.MANUAL,
  DRAWER_PERM.CHANGE,
  DRAWER_PERM.CASH_IN,
  DRAWER_PERM.CASH_OUT,
  DRAWER_PERM.DEPOSIT,
  DRAWER_PERM.COUNT,
  DRAWER_PERM.BLIND_COUNT,
  DRAWER_PERM.WALLET_DEPOSIT,
  DRAWER_PERM.VIEW_LOG,
  DRAWER_PERM.VIEW_MOVEMENTS,
];
/**
 * The entries the screens have, by the code they are offered by and what they are ("כשאין הרשאה", spec §3): the ones that
 * always read `permissionsDeniedUi` are `legacy`; SHIFT_OPEN is never hidden (core/till/permissions.ts NEVER_HIDDEN).
 */
const ENTRIES: ReadonlyArray<readonly [string, EntryKind]> = [
  [PERM.SHIFT_OPEN, 'option'],
  [PERM.SHIFT_CLOSE, 'option'],
  [PERM.X, 'option'],
  [PERM.Z, 'option'],
  [PERM.REFUND, 'option'],
  [PERM.DISCOUNT, 'option'],
  [PERM.OTH, 'option'],
  [PERM.LINE_VOID, 'option'],
  [PERM.HELD_SALE_CANCEL, 'option'],
  [PERM.REPRINT, 'option'],
  [PERM.SHOP_X, 'legacy'],
  ['VIEW_REPORTS', 'legacy'],
  ['KIOSK_CONTROL', 'option'],
];
/** The most recent receipts "זיכוי מקבלה" lists (RecentReceiptCount). */
const RECENT_RECEIPTS = 8;

const sh = (agorot: number) => formatShekelSign(agorot);
/** A gate's sum (₪, as the limits read it) in agorot for the drawer's audit; null when there is none. */
const agorotOf = (shekels: number | null | undefined): number | null => (shekels === null || shekels === undefined ? null : ofShekels(shekels));

/** "זיכוי מזומן" refused in a basket with returns (kcash_credit_failed). */
const CREDIT_IN_BASKET = 'לא ניתן לממש את הזיכוי כרגע';

/** "ההנחה לא ניתנה": a basket discount that is not one (nothing keyed). */
const TILL_ERROR_DISCOUNT = 'ההנחה לא ניתנה';

/** Android's words (res/values/strings*.xml), one place. */
const WORDS = {
  noShiftBlocksSale: 'לא ניתן לגבות לפני פתיחת משמרת.',
  shiftNone: 'אין משמרת פתוחה. לא ניתן למכור עד שתיפתח משמרת.',
  notSellable: (n: string) => `${n} אינו זמין למכירה`,
  blocked: (n: string, why?: string | null) => (why ? `${n} חסום למכירה: ${why}` : `${n} חסום למכירה`),
  soldOutTitle: 'אזל',
  soldOutMessage: (n: string, until: string) => `${n} סומן „אזל“${until}. אפשר למכור רק באישור מנהל.`,
  soldOutMessageStock: (n: string) => `${n} — אין במלאי. אפשר למכור רק באישור מנהל.`,
  soldOutUntil: (d: string) => ` עד ${d}`,
  soldOutApprove: 'מכירה באישור מנהל',
  soldOutApproveSelf: 'מכור בכל זאת',
  soldOutManager: (n: string) => `מכירת פריט שאזל — ${n}`,
  stockBlocked: (n: string) => `${n} אינו במלאי`,
  stockWarnTitle: 'אין במלאי',
  stockWarnMessage: (n: string) => `${n} אינו במלאי. למכור בכל זאת?`,
  cancel: 'ביטול',
  insufficient: 'הסכום שהתקבל קטן מהסכום לתשלום',
  noPaymentOptions: 'אין אמצעי תשלום זמינים – פנו למנהל',
  noCard: 'הקופה מוגדרת ללא אשראי',
  cardPending: 'תשלום קודם ממתין לבירור. אנא פנו לצוות.',
  presentCard: 'הצמד, הכנס או העבר את הכרטיס',
  cancelling: 'מבטל… ממתין לתשובת המסוף',
  returnCashTitle: 'החזר מזומן ללקוח',
  returnCashBody: 'המכירה לא הושלמה ולא נרשם מסמך. החזר את המזומן שהתקבל.',
  returnCashDone: 'החזרתי את המזומן',
  receiptProblem: (why: string) => `קבלה: ${why}`,
  noReceiptPrinter: 'לא הוגדרה מדפסת לקבלות',
  pendingBlocksClose: (n: number) => `${n} מכירות בהמתנה במשמרת זו. יש לברר את תוצאתן לפני סגירת המשמרת.`,
  zDisabled: 'הקופה מוגדרת כך שדו״ח Z מופק בענן ולא בקופה. אין צורך להפיק כאן.',
  zNeedsConnection: 'נדרש חיבור לאינטרנט להפקת דו״ח Z',
  zNotAccepted: 'סגירת המשמרת עדיין לא נקלטה בענן, ולכן אי אפשר להפיק דו״ח Z. נסו שוב בעוד רגע.',
  zNothing: 'אין משמרות סגורות שעוד לא נכללו בדו״ח Z',
  zCloudError: 'הענן לא הפיק את דו״ח Z. נסו שוב.',
  zDone: (n: number) => `דו״ח Z מס׳ ${n} הופק`,
  zConfirmOpenShift: (n: number | string) => `משמרת #${n} פתוחה. היא תיסגר קודם: ספירת הקופה והדפסת דו״ח X, ואז יופק דו״ח Z.`,
  shiftClosedSynced: 'המשמרת נסגרה ונקלטה בענן.',
  shiftClosedQueued: 'המשמרת נסגרה. היא תישלח לענן ברגע שיהיה חיבור.',
  comingSoon: (what: string) => `${what} — בקרוב`,
  workModeApproveBack: 'חזרה למצב קיוסק',
  workModeApproveToKiosk: 'מעבר למצב קיוסק',
  workModeMenuBack: 'חזרה למצב קיוסק',
  workModeMenuToKiosk: 'מעבר לקיוסק',
  modeBusy: 'אי אפשר לעבור עכשיו: יש הזמנה או תשלום פתוחים.',
  managerCode: 'קוד מנהל',
  approve: 'אישור',
  wrongPin: 'קוד שגוי',
  managerApprovalTitle: 'אישור מנהל',
  // ── refunds ("זיכוי") ──
  refundDone: 'הזיכוי בוצע',
  refundNoShift: 'לא ניתן לבצע זיכוי לפני פתיחת משמרת.',
  refundSelectItems: 'בחר לפחות פריט אחד לזיכוי',
  refundNothingLeft: 'כל הפריטים במסמך זוכו',
  refundCardMissingOriginal: 'לא נמצאה הפניה לעסקה המקורית במכשיר. לא ניתן לבצע זיכוי מקושר.',
  refundModeBanner: 'מצב זיכוי: כל הקשה מחזירה פריט',
  receiptNotFound: (n: string) => `לא נמצאה קבלה ${n} לזיכוי`,
  receiptMatches: 'במספר הזה יש כמה מסמכים — בחרו את המסמך',
  refundNotSupported: 'המסופון במכשיר הזה אינו מבצע זיכוי לכרטיס. אפשר לזכות במזומן.',
  checkoutRefundDone: (s: string) => `הזיכוי הושלם — הוחזרו ${s}`,
  basketCustomerRequired: 'חובה בזיכוי ללא קבלה: שם, וטלפון או כתובת.',
  basketOriginalChanged: 'הקבלה המקורית זוכתה בינתיים. יש לבחור את הפריטים מחדש.',
  basketPayoutUnavailable: 'זיכוי לכרטיס אינו זמין',
  basketUnlinkedDeclined: (why: string) => `הזיכוי לכרטיס נדחה: ${why}. אפשר להחזיר במזומן.`,
  tablesRefundBlocked: 'לא ניתן לבצע זיכוי בתוך שולחן. צאו מהשולחן כדי לזכות.',
  // ── discounts, OTH ──
  noDiscountTitle: 'לא מקבל הנחות',
  lineNoDiscount: 'הפריט לא מקבל הנחות.',
  basketDiscountExceeds: 'ההנחה גדולה מהסכום לתשלום',
  // ── "הנחות קבועות" (core/till/presetDiscounts.ts) ──
  presetGone: 'ההנחה הזו אינה מוגדרת בקופה',
  presetForRequired: 'יש לבחור עבור מי ההנחה',
  presetNothingToDiscount: 'אין בהזמנה פריטים שמקבלים הנחה',
  othNoneEligible: 'אין בהזמנה פריטים שאפשר לתת על חשבון הבית.',
  othRefusedNoDiscount: (n: string) => `${n} לא מקבל הנחות — אי אפשר לתת אותו על חשבון הבית.`,
  othRefusedLineDiscount: 'הפריט על חשבון הבית (OTH). כדי לתת עליו הנחה אחרת — קודם בטלו את ה-OTH.',
  othDisabled: 'OTH — על חשבון הבית אינו פעיל בקופה הזו',
  othTitle: 'OTH — על חשבון הבית',
  othUndoTitle: 'ביטול OTH',
  othOver: (s: string) => `על חשבון הבית (OTH) · ${s} — מעל התקרה שלך`,
  // ── held sales ──
  heldCancelReasonRequired: 'יש לכתוב סיבת ביטול',
  heldCloseNoneLeft: 'אין מכירות מושהות — אפשר להמשיך בסגירה.',
  autoCloseNoticeTitle: 'סגירה אוטומטית במשמרת הקודמת',
} as const;

/** A line of a document a receipt return credits ("מקבלה", RefundSource). */
interface ReceiptSource {
  transactionId: string;
  itemId: string;
  documentNumber: string;
  originalQty: number;
  alreadyRefunded: number;
  collectedAgorot: number;
  unitAgorot: number;
  /** The original line as sold (its options and meal), carried to the credit line. */
  line: SaleLine;
  tracked: boolean;
}

interface CartRec {
  lineId: string;
  productId: string;
  qty: number;
  /** A line coming back ("זיכוי"): from the catalog, or picked off a receipt ([receipt]). */
  refund?: boolean;
  receipt?: ReceiptSource | null;
  /** The cashier's line discount (percentage in hundredths, or a fixed sum); OTH's is its own 100%. */
  discount?: { type: DiscountType; value: number } | null;
  oth?: OthMark | null;
  /** A held sale's line: the price it was parked at. */
  keptUnitAgorot?: number | null;
  /** The name it was parked under / sold under (a product the catalog lost since still shows). */
  name?: string;
  /** "תוספות / ארוחה / הערות" (core/till/choices.ts): what the line was ordered with; absent — a plain line. */
  choices?: LineChoices | null;
}

/** Who approved: a manager by their code, or nobody (the user's own right, a confirmation). */
interface Approver {
  id: string;
  name: string;
}

interface PendingDialog {
  dialog: EngineDialog;
  /** The permission a manager's code must hold; null = a confirmation (no code). */
  code: string | null;
  /** The sum / rate the approver's own ceiling must cover. */
  amount?: number | null;
  percent?: number | null;
  /** A check of the typed code of its own (the work mode's, against KIOSK_TILL_MODE in the runtime); else `code` against the roster. */
  verify?: (pin: string) => Promise<{ ok: true; by: Approver } | { ok: false; message: string }>;
  /** Free text the dialog asks for (a reason), passed to `resume` with the approver. */
  resume(approver: Approver | null, answers: Record<string, string>): Promise<unknown> | unknown;
  /** A choice (a module's question, tillContext.ts): every action but "cancel" comes here. */
  onAction?: (action: string, answers: Record<string, string>) => unknown;
  onCancel?: () => unknown;
  /** Unanswered until then: closed, and `onTimeout` runs ("לפתוח מגירה?" after `cashDrawerAskTimeoutSec`). */
  timer?: NodeJS.Timeout;
  onTimeout?: () => unknown;
}

/** A mixed basket at the payment: its figures, its step, the customer, the route of a card payout. */
interface BasketRec {
  saleAgorot: number;
  refundAgorot: number;
  netAgorot: number;
  hasUnlinked: boolean;
  step: CheckoutBasket['step'];
  customer: { name: string; phone: string; address: string };
  customerRequired: boolean;
  route: CardPayoutRoute;
  handedBackAgorot: number;
}

interface CheckoutRec {
  /** `device_waiting`: the cash device takes the money ("מזומן במכשיר"); `device_unknown`: its answer was lost. */
  phase: CheckoutState['phase'] | 'card_unknown' | 'device_waiting' | 'device_unknown';
  totalAgorot: number;
  legs: Array<TenderLeg & { status: 'approved' | 'pending' }>;
  docId: string | null;
  documentRef: string | null;
  changeAgorot: number;
  /** The cash handed over, on the done screen ("התקבל"): the document's `amountTendered`. */
  tenderedAgorot: number;
  askPrint: boolean;
  printWarning: string | null;
  /** "פריטים שלא נותבו למדפסת: …" — the sale's lines no kitchen printer takes (main/kitchen); the sale stands. */
  kitchenWarning: string | null;
  cardStatus: string | null;
  cardError: string | null;
  /** The cart as priced when the payment opened: what the document is written from. */
  frozen: Frozen | null;
  /** The receipt (print job) of the finished sale, until the cashier is done. */
  receiptJob: string | null;
  /** A basket with returns. */
  basket: BasketRec | null;
  /** Every document the payment wrote (a basket's sale and credit notes). */
  docIds: string[];
  /** This payment's own id: a voucher's answer that comes back to another payment is given back (tillVouchers.ts). */
  token: string;
  /** "סיום בדיקה": the simulation's end (a test voucher's sale) — nothing was written. */
  testEnd: string[] | null;
  /** "מסך הצלחה במימוש שובר": the sale redeemed vouchers. */
  voucherSuccess: NonNullable<CheckoutState['voucherSuccess']> | null;
  /** "הזמנות קיוסק לתשלום": the kiosk order this payment takes the money for (its basket is never edited). */
  kioskOrder: KioskOpenOrder | null;
}

/** A credit line as priced from the cart. */
interface PricedRefund {
  rec: CartRec;
  line: SaleLine;
  totalAgorot: number;
  tracked: boolean;
}

/** "הנחה לחשבון" on the cart; a preset's ("הנחות קבועות") carries its mark (kept on a held sale with it). */
type CartDiscount = { type: DiscountType; value: number; preset?: PresetMark };

interface Frozen {
  lines: SaleLine[];
  tracked: string[];
  promotions: AppliedPromotionRow[];
  totals: SaleTotals;
  /** The basket discount in money, its kind and rate (on the 320). */
  basketDiscountAgorot?: number;
  basketDiscount?: CartDiscount | null;
  /** The returns of a mixed basket. */
  refunds?: PricedRefund[];
  /** "שוברי הנחה": what each discount voucher took (tillVouchers.ts) — the document's `voucherDiscounts`, the holds it confirms. */
  voucherOutcomes?: VoucherOutcome[];
  /** "שוברי הפקה": the production vouchers as booked, and the legs the payment ones pay (in order). */
  prepaid?: DocPrepaidRedemption[];
  voucherLegs?: Array<{ amountAgorot: number; voucher: { redemptionId: string; reservationId: string | null; serial: number } }>;
  /** A payment restored after a restart: the document's own voucher fields, written again as they were. */
  restoredVouchers?: Pick<DocDraft, 'voucherDiscounts' | 'voucherReleases' | 'prepaidVouchers'>;
}

interface Priced extends Frozen {
  gone: string[];
  refunds: PricedRefund[];
  saleTotalAgorot: number;
  refundTotalAgorot: number;
  netAgorot: number;
  lineDiscountsAgorot: number;
  othAgorot: number;
  nonDiscountableAgorot: number;
}

const idleCheckout = (): CheckoutRec => ({
  phase: 'idle',
  totalAgorot: 0,
  legs: [],
  docId: null,
  documentRef: null,
  changeAgorot: 0,
  tenderedAgorot: 0,
  askPrint: false,
  printWarning: null,
  kitchenWarning: null,
  cardStatus: null,
  cardError: null,
  frozen: null,
  receiptJob: null,
  basket: null,
  docIds: [],
  token: '',
  testEnd: null,
  voucherSuccess: null,
  kioskOrder: null,
});

function isInt(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
}

/** A document's lines as the refund reads them (RefundMath's TransactionItemEntity view). */
function refundItemsOf(d: DocDraft): RefundItem[] {
  return d.lines.map((l, i) => ({
    id: d.itemIds[i],
    productId: l.productId,
    quantity: l.qty,
    unitAgorot: unitAgorot(l),
    discountAgorot: l.discountAgorot ?? 0,
    promotionAgorot: l.promotionAgorot ?? 0,
    voucherAgorot: l.voucherAgorot ?? 0,
    noDiscount: l.noDiscount === true,
    refundOfItemId: l.refundOfItemId ?? null,
  }));
}

export class KioskCoreTillEngine implements EngineEndpoint {
  private seq = 1;
  private dirty = true;
  private readonly listeners = new Set<(e: EngineEvent) => void>();
  private readonly applied = new Map<string, EngineReply>();
  private chain: Promise<unknown> = Promise.resolve();
  private readonly svc: KioskService;
  private readonly compare: BcryptCompare;
  private readonly nowFn: () => number;
  private readonly log: (m: string) => void;
  private readonly held: HeldStore;

  private cashier: RosterUser | null = null;
  private locked = true;
  private cart: CartRec[] = [];
  private lineSeq = 0;
  private department: string | null = null;
  private search = '';
  private checkout: CheckoutRec = idleCheckout();
  private pending: PendingDialog | null = null;
  private dialogSeq = 0;
  /** "SELL" approved by a manager for this basket (asked once per basket, Android sellGate). */
  private sellApprovedFor: string | null = null;
  private basketId = randomUUID();
  /** "הנחה לחשבון" on this basket, and who authorised the discounts (named on the 320). */
  private cartDiscount: CartDiscount | null = null;
  private discountApprover: string | null = null;
  /** "מצב זיכוי" and the chooser; the manager who authorised the returns of this basket (a grant, spent at the commit). */
  private refundMode = false;
  private refundChooser = false;
  private refundGrant: { approverId: string; profile: PermissionProfile } | null = null;
  /** A held sale's basket discount and approver, kept in memory while it is parked (Android parkedExtras). */
  private readonly parkedExtras = new Map<string, { discount: CartDiscount | null; approver: string | null; dining?: Dining | null; orderName?: string | null }>();
  /**
   * "פרטי הזמנה" (core/till/orderDetails.ts): the quick order's take-away / eat-in and name, the first item held for them
   * ("בפתיחת הזמנה"), the sheet the engine asks for now, and the basket whose opening questions were closed unanswered.
   */
  private orderDining: Dining | null = null;
  private orderName: string | null = null;
  private orderStart: { productId: string; qty: number; choices: LineChoices | null } | null = null;
  private orderAsk: 'open' | 'payment' | 'edit' | null = null;
  /** "פעולות אשראי" was opened since the sign-in: its view goes in the state. */
  private transmissionShown = false;
  private diningFirstDismissedFor: string | null = null;
  private hostIdle = { idle: true, busy: false };
  private lastActivityAt: number;
  private lastZNumber: number | null = null;
  private toasts: Array<{ tone: 'info' | 'error' | 'ok'; text: string }> = [];
  /** "דוח X סניפי": the report last brought, while the user who asked is signed in. */
  private shopXDoc: { doc: ShopXDocument; at: number } | null = null;
  /** What the shop X asked last covers: the whole shop, or this till's point of sale (`scope=area`). */
  private shopXScope: 'shop' | 'area' = 'shop';
  private shopXBusy = false;
  private shopXError: string | null = null;
  private offView: (() => void) | null = null;
  private offMode: (() => void) | null = null;
  private tick: NodeJS.Timeout | null = null;
  private stopped = false;
  private lastState = '';
  /** The automatic close: since when a payment has held it (that shift's id, the clock). */
  private autoPaymentWait: { shiftId: string; since: number } | null = null;
  private autoCloseBusy = false;
  /** What the modules that add a feature to the till are handed (tillContext.ts). */
  readonly ctx: TillContext;
  /** "מגירת מזומן": the drawer's flows, its audit and movements (tillDrawer.ts). */
  readonly drawer: TillDrawer;
  /** "עובד מחובר בקופה אחת בלבד", "עובדים מחוברים", "נעילה בחוסר שימוש" (userSessions.ts). */
  readonly sessions: TillSessions;
  /** "עודף חייב ללקוח" / "שולם ללקוח", "זיכוי מזומן" (tillCash.ts). */
  readonly cash: TillCash;
  /** "מזומן במכשיר": CashMag / the shop's cash station at the payment (tillDeviceCash.ts). */
  readonly deviceCash: TillDeviceCash;
  /** Vouchers at the payment: discount and production vouchers, "מצב בדיקה" (tillVouchers.ts). */
  readonly vouchers: TillVouchers;
  /** "הדפסה בקופה אחרת" (tillRemotePrint.ts). */
  readonly remotePrint: TillRemotePrint;
  /** "פעולות אשראי": the transmission, the terminal's deferred mode, the §13 warning (tillTransmission.ts). */
  readonly transmission: TillTransmission;
  /** "דוח X סניפי" over the LAN: this till's part in the main till's report (tillShopXLan.ts). */
  readonly shopXLan: TillShopXLan;
  /** "חסומים כעת" / "חסום / אזל" (tillItemBlocks.ts). */
  readonly itemBlocks: TillItemBlocks;
  /** "תור הדפסה" and "מדפסת חלופית" for the kitchen tickets (tillPrintQueue.ts). */
  readonly printQueue: TillPrintQueue;
  /** "מסך לקוח": the second screen's settings and state (tillCustomerDisplay.ts). */
  readonly customerDisplay: TillCustomerDisplay;
  /** "תפריט" as the Android drawer: the profile card, the sync, the update, support, the local reports (tillMenuService.ts). */
  readonly menu: TillMenuService;
  /** "קיוסקים": a controlling till's kiosks (tillKiosks.ts). */
  readonly kiosks: TillKiosks;
  /** "עיצוב קופה": the cloud's design, pulled with the parameters and kept offline (tillDesign.ts). */
  readonly design: TillDesignService;
  /** "הזמנות קיוסק לתשלום": the kiosks' orders paid at this till (tillKioskOrders.ts) — `kioskOrders` below. */
  /*
   * Phase 2 (P:/specs/windows-till-menu-parity.md §7): the Android menu's features, each its own module registered with the
   * engine (tillContext.ts TillFeature) — its ops routed to it, its slice in the state.
   */
  get catalogAdmin(): TillCatalogAdmin {
    return this.feature('catalogAdmin');
  }
  get shopZ(): TillShopZ {
    return this.feature('shopZ');
  }
  get attendance(): TillAttendance {
    return this.feature('attendance');
  }
  get readyOrders(): TillReadyOrders {
    return this.feature('readyOrders');
  }
  get alerts(): TillAlertsService {
    return this.feature('alerts');
  }
  get voucherBalance(): TillVoucherBalance {
    return this.feature('voucherBalance');
  }
  get voucherStation(): TillVoucherStation {
    return this.feature('voucherStation');
  }
  get cloudZ(): TillCloudZ {
    return this.feature('cloudZ');
  }
  get printers(): TillPrinters {
    return this.feature('printers');
  }
  get screenEdit(): TillScreenEdit {
    return this.feature('screenEdit');
  }
  get kioskOrders(): TillKioskOrders {
    return this.feature('kioskOrders');
  }
  /** The last op from the screens (a touch, a key): the idle lock counts from it too. */
  private lastTouchAt: number;
  /** The feature modules registered (tillContext.ts TillFeature): their ops and their slices of the state. */
  private readonly features: TillFeature[] = [];
  private readonly featureOps = new Map<string, TillFeature>();

  constructor(private readonly o: TillEngineOptions) {
    this.svc = o.svc;
    this.compare = o.compare ?? ((p, h) => bcrypt.compare(p, h));
    this.nowFn = o.now ?? (() => Date.now());
    this.log = o.log ?? (() => undefined);
    this.held = new HeldStore(this.svc.kv, this.nowFn);
    this.lastActivityAt = this.nowFn();
    this.ctx = this.makeContext();
    this.drawer = new TillDrawer(this.ctx, { expectedBalance: () => this.expectedNow() });
    this.drawer.start();
    // "הדפסה בקופה אחרת": the till's pages to another till's printer, as the cloud lets them (tillRemotePrint.ts).
    this.remotePrint = new TillRemotePrint(this.ctx, { ...(o.remotePrint ?? {}), remoteAfterCash: (host, page) => void this.later(() => this.drawer.remoteAfterCash(host, page)) });
    this.remotePrint.start();
    this.transmission = new TillTransmission(this.ctx);
    this.transmission.start();
    this.shopXLan = new TillShopXLan(this.ctx, {
      openShiftTill: () => {
        const s = this.svc.ledger.currentShift();
        if (!s) return null;
        return { id: s.id, businessDate: s.business_date, till: this.xFigures(s.id).till };
      },
      lanCall: o.shopXLan?.lanCall,
      sleep: o.shopXLan?.sleep,
    });
    if (o.shopXLan?.manual !== true) this.shopXLan.start();
    this.itemBlocks = new TillItemBlocks(this.ctx, {
      wide: () => {
        const d = decide(this.profile(), PERM.ITEM_BLOCK_WIDE);
        return d.kind === 'allowed' ? 'allow' : d.kind === 'approval' ? 'approval' : 'deny';
      },
      // "permissionsDeniedUi": a locked option is left out unless the till shows it greyed with why.
      deniedHidden: () => String(this.svc.cloud.parameters().permissionsDeniedUi ?? '').trim() !== 'הצג מושבת עם הסבר',
    });
    this.itemBlocks.start();
    this.printQueue = new TillPrintQueue(this.ctx);
    this.customerDisplay = new TillCustomerDisplay(this.ctx);
    this.customerDisplay.start();
    this.kiosks = new TillKiosks(this.ctx);
    this.design = new TillDesignService({
      api: this.svc.api,
      machineId: () => this.svc.machineId,
      read: () => this.svc.cloud.tillDesign(),
      write: (v) => this.svc.cloud.setTillDesign(v),
      changed: () => this.ctx.changed(),
      log: (m) => this.log(m),
    });
    // Pulled on the parameters' cadence (the service's sync), as the Android till pulls it with them.
    this.svc.attachTillPull?.(() => this.design.pull());
    this.menu = new TillMenuService(this.ctx, {
      zOnly: () => this.shiftsHidden(),
      tillZMode: () => zModeOf(this.svc.cloud.heartbeat().zMode) === 'till',
      openShiftFigures: (shiftId) => {
        const x = this.xFigures(shiftId).till;
        return { netAgorot: ofShekels(x.totalSales - x.totalDiscounts - x.totalRefunds), transactions: x.transactionsCount };
      },
    });
    this.lastTouchAt = this.lastActivityAt;
    this.sessions = new TillSessions(this.ctx, {
      completeSignIn: (user) => this.completeSignIn(user),
      signOut: (reason) => this.forceSignOut(reason),
      lastActivity: () => Math.max(this.lastActivityAt, this.lastTouchAt),
      canSignOutNow: () => this.checkout.phase === 'idle' && !this.svc.pay.cardInFlight,
    });
    this.sessions.start();
    this.cash = new TillCash(this.ctx, this.drawer);
    this.cash.start();
    this.vouchers = new TillVouchers(this.ctx, {
      payment: () => this.voucherPayment(),
      reprice: () => this.repriceForVouchers(),
      afterApply: () => this.afterVoucher(),
      mayAlone: (code) => decide(this.profile(), code).kind === 'allowed',
      setting: (key) => this.svc.cloud.parameters()[key] ?? this.svc.settingsMap()[key],
    }, undefined, { lanCall: o.voucherLan });
    this.register(
      new TillKioskOrders(this.ctx, {
        basketBusy: () => this.cart.length > 0 || this.checkout.phase !== 'idle',
        load: (order, lines) => this.loadKioskOrder(order, lines),
      }),
    );
    // "ניהול קטלוג": open with a shift (or no shifts here); a manager's without one (catalogWithoutShift).
    this.register(new TillCatalogAdmin(this.ctx, { shiftOpen: () => !!this.svc.ledger.currentShift() || this.shiftsHidden() }));
    // "סגירת Z סניפי": this till's own close is the engine's (the drawer and the vouchers on its X), its held sales asked first.
    this.register(
      new TillShopZ(this.ctx, {
        closeOwnShift: ({ requestId, closer }) => {
          if (this.svc.ledger.shiftByCloseRequest(requestId)) return 'already';
          if (this.paying()) return 'pending';
          const closed = this.svc.ledger.closeShift({
            closedByName: closer.name,
            closedByUserId: closer.id || null,
            unattended: true,
            closeRequestId: requestId,
            vatRate: this.svc.vatRate(),
            now: new Date(this.nowFn()),
            tillExtra: (till, shiftId) => this.withTipsChoice('partial', () => this.tillFigures(till, shiftId)),
          });
          if (closed.kind === 'pending') return 'pending';
          if (closed.kind === 'none') return 'none';
          void this.svc.sync.flush();
          return 'closed';
        },
        heldGate: (keepHeld) => this.heldGate(keepHeld),
        print: (doc, refId, title) => this.svc.printReport(doc, refId, title),
      }),
    );
    // "נוכחות": "הכסף אצלי" from the drawer's wallets.
    this.register(
      new TillAttendance(this.ctx, {
        walletAgorot: async (u) => {
          const r = await this.drawer.listWallets();
          return r.offline ? null : (r.wallets.find((w) => w.employeeId === u.id)?.balanceAgorot ?? null);
        },
      }),
    );
    this.register(new TillReadyOrders(this.ctx));
    // "התראות": the change owed from the cash stations' (tillCash.ts), the kitchen queue, the kiosks.
    this.register(new TillAlertsService(this.ctx, { owed: () => ({ items: this.cash.owed.items, loaded: this.cash.owed.loaded }) }));
    this.register(new TillVoucherBalance(this.ctx));
    // "עמדת שובר": the sale built through the engine's own ops (ctx.run); the payment's voucher flow paces it.
    this.register(
      new TillVoucherStation(this.ctx, {
        sale: () => ({
          ref: this.basketId,
          lines: this.cart.map((l) => ({ lineId: l.lineId, productId: l.productId, qty: l.qty, refund: l.refund === true, name: l.name })),
          phase: this.checkout.phase,
          dueAgorot: this.checkout.phase === 'tender' ? dueOf(this.checkout.totalAgorot, this.approvedLegs()) : 0,
        }),
        scanDone: () => this.vouchers.lastScan,
        lanCall: o.voucherLan,
      }),
    );
    this.register(new TillCloudZ(this.ctx, { print: (doc, refId, title) => this.svc.printReport(doc, refId, title) }));
    this.register(new TillPrinters(this.ctx));
    this.register(new TillScreenEdit(this.ctx));
    // "מזומן במכשיר" (tillDeviceCash.ts): its documents are its own to settle after a restart — never a card's recovery.
    this.deviceCash = this.register(
      new TillDeviceCash(
        this.ctx,
        {
          begin: () => this.deviceBegin(),
          complete: (docId, meta) => this.deviceComplete(docId, meta),
          void: (docId, meta) => {
            this.svc.ledger.voidCardSale(docId, meta);
            void this.svc.sync.flush();
          },
          done: (doc) => this.deviceDone(doc),
          failed: (message) => this.deviceFailed(message),
          unknown: (message) => {
            this.checkout.phase = 'device_unknown';
            this.checkout.cardStatus = null;
            this.checkout.cardError = message;
          },
          liveDocId: () => (this.checkout.phase === 'device_waiting' || this.checkout.phase === 'device_unknown' ? this.checkout.docId : null),
          // The Windows till takes no tip of its own (a kiosk order's tip is the kiosk's): the change owed is never one.
          tipOk: () => false,
        },
        o.deviceCash,
      ),
    );
    this.deviceCash.start();
    this.restorePending();
    // A kiosk order this till was paying when it stopped, with no document of it pending: back to the list.
    if (this.kioskOrders.current() && !this.checkout.kioskOrder) this.kioskOrders.abandoned();
    this.kioskOrders.start();
    this.alerts.start();
    // What the kiosk learns (catalog, stock, settings, the shift closed by the cloud…) reaches the screens.
    const onView = () => this.refresh();
    this.svc.on('view', onView);
    this.offView = () => this.svc.off('view', onView);
    this.tick = setInterval(() => {
      this.refresh();
      // "מדפסת חלופית": the question about a kitchen ticket that did not print, when it is due.
      if (!this.stopped) void this.later(() => this.printQueue.prompt()).then(() => this.refresh());
    }, 5_000);
    this.attachWorkMode();
    // "סגירת משמרת אוטומטית גם עם עגלה פתוחה": the service's half-minute tick asks the till (a till by role only).
    this.svc.attachTillAutoClose?.(() => this.later(() => this.autoCloseTick()));
    // The cloud's close of this shift (a shop Z run, the dashboard): the till's own close, never over a card.
    this.svc.attachTillRemoteClose?.((requestId) => this.later(() => this.remoteClose(requestId)));
  }

  private makeContext(): TillContext {
    return {
      svc: this.svc,
      compare: this.compare,
      now: () => this.nowFn(),
      log: (m) => this.log(m),
      operator: () => (this.cashier && !this.locked ? this.cashier : null),
      signedIn: () => this.signedIn(),
      roster: () => this.roster(),
      shopId: () => this.shop(),
      refuse: (code, message, details) => refuse(code, message, details),
      ask: (d) => this.ask(d),
      toast: (text, tone = 'info') => this.toast(text, tone),
      changed: () => {
        // A module's answer arriving after the till stopped (its timers, a cloud reply): nothing to show any more.
        if (this.stopped) return;
        this.dirty = true;
        this.commit();
      },
      later: (fn) => this.later(fn),
      paying: () => this.paying(),
      dialogOpen: () => this.pending !== null,
      gate: (code, resume, opts = {}) => this.gate(code, resume, opts),
      decide: (code, opts = {}) => decide(this.profile(), code, opts).kind,
      hiddenCodes: () => this.sessionHidden(),
      run: async (op, args = {}) => this.apply(op as TillOp, args),
    };
  }

  /** A module's question (tillContext.ts `DialogSpec`): the engine's dialog, with its choices and its time. */
  private ask(d: DialogSpec): { dialogId: string } {
    this.openDialog({
      kind: d.kind,
      title: d.title,
      body: d.body,
      fields: d.fields,
      actions: d.actions,
      code: d.code ?? null,
      verify: d.verify,
      resume: d.resume ?? (() => undefined),
      onAction: d.onAction,
      onCancel: d.onCancel,
      expiresInMs: d.expiresInMs,
      onTimeout: d.onTimeout,
    });
    return { dialogId: this.pending!.dialog.id };
  }

  /** A feature module joins the engine: its ops go to it, its slice goes into the state. */
  register<F extends TillFeature>(f: F): F {
    // The same key again (a test's own configured module): the one before stops and leaves, its ops with it.
    const before = this.features.find((x) => x.key === f.key);
    if (before) {
      before.stop?.();
      this.features.splice(this.features.indexOf(before), 1);
      for (const op of before.ops) this.featureOps.delete(op);
    }
    for (const op of f.ops) {
      if ((TILL_OPS as readonly string[]).includes(op) || this.featureOps.has(op)) throw new Error(`till op ${op} is taken`);
      this.featureOps.set(op, f);
    }
    this.features.push(f);
    this.dirty = true;
    return f;
  }

  /** The feature module registered under [key] (the engine's own hooks reach the one on duty). */
  private feature<F extends TillFeature>(key: string): F {
    const f = this.features.find((x) => x.key === key);
    if (!f) throw new Error(`till feature ${key} is not registered`);
    return f as F;
  }

  stop() {
    this.stopped = true;
    for (const f of this.features) f.stop?.();
    this.sessions.stop();
    this.cash.stop();
    this.drawer.stop();
    this.remotePrint.stop();
    this.transmission.stop();
    this.shopXLan.stop();
    this.itemBlocks.stop();
    this.customerDisplay.stop();
    if (this.pending?.timer) clearTimeout(this.pending.timer);
    this.offView?.();
    this.offMode?.();
    if (this.tick) clearInterval(this.tick);
    this.tick = null;
    this.svc.attachTillAutoClose?.(null);
    this.svc.attachTillPull?.(null);
    this.svc.attachTillRemoteClose?.(null);
  }

  /** The work mode runtime exists after the engine in the shell's start: tried again until it is there. */
  private attachedMode: TillWorkMode | null = null;
  attachWorkMode() {
    const wm = this.o.workMode?.() ?? null;
    if (!wm || wm === this.attachedMode) return;
    this.attachedMode = wm;
    this.offMode?.();
    this.offMode = wm.onChange(() => this.refresh());
    wm.setTillFacts(() => ({
      basketOpen: this.cart.length > 0,
      checkoutOpen: this.checkout.phase !== 'idle',
      holdsTender: this.checkout.legs.length > 0,
      cardInFlight: this.svc.pay.cardInFlight,
      tableOpen: false,
      heldSales: this.held.count(),
      employee: this.cashier ? { id: this.cashier.id, name: displayName(this.cashier) } : null,
      lastActivityAtMs: this.lastActivityAt,
    }));
  }

  /* -------------------------------------------------------------- the endpoint */

  hello(_since?: number): HelloReply {
    return { protocol: TILL_PROTOCOL, seq: this.seq, state: this.snapshot() };
  }

  snapshot(): TillState {
    return this.buildState();
  }

  /**
   * A payment is on — the checkout taking tenders or waiting on the card, or a card at the terminal: the manager's corner
   * ("ניהול הקיוסק", main/roles/tillElectron.ts) waits, as the kiosk's does on its pay screen.
   */
  paying(): boolean {
    const ph = this.checkout.phase;
    return ph === 'tender' || ph === 'card_waiting' || ph === 'device_waiting' || ph === 'device_unknown' || this.svc.pay.cardInFlight;
  }

  get currentSeq(): number {
    return this.seq;
  }

  on(fn: (e: EngineEvent) => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  private emit(ev: EngineEvent['ev'], data: unknown) {
    const e: EngineEvent = { ev, seq: this.seq, data };
    for (const fn of Array.from(this.listeners)) fn(e);
  }

  /** The state, when it changed (a coalesced look: each op, the kiosk's views, the 5 s tick). */
  private refresh() {
    if (this.stopped) return;
    this.attachWorkMode();
    this.commit(true);
  }

  private commit(always = false) {
    if (!this.dirty && !always) return;
    const state = this.buildState();
    const json = JSON.stringify(state);
    this.dirty = false;
    if (json === this.lastState) {
      // A module's word with nothing else changed ("נשלח להדפסה ב…"): said all the same.
      this.drainToasts();
      return;
    }
    this.lastState = json;
    this.seq += 1;
    this.emit('state', state);
    // "מסך לקוח": the second screen follows what the till shows (filtered, the thanks held — tillCustomerDisplay.ts).
    this.customerDisplay?.publish(state, this.transmission?.notices().customer ?? null);
    // The updater and the pay monitor see a till as a quiet or busy device (never an update mid-sale).
    const busy = state.sell.lines.length > 0 || state.checkout.phase !== 'idle' || state.dialog !== null;
    this.svc.reportFlow({ flowState: busy ? 'paying' : 'attract', screen: state.checkout.phase !== 'idle' ? 'pay' : 'attract', busy, idle: !busy && this.nowFn() - this.lastActivityAt > 60_000 });
    this.drainToasts();
  }

  private drainToasts() {
    const t = this.toasts;
    this.toasts = [];
    for (const x of t) this.emit('toast', x);
  }

  private toast(text: string, tone: 'info' | 'error' | 'ok' = 'info') {
    this.toasts.push({ tone, text });
  }

  /* ------------------------------------------------------------------- calls */

  call(c: EngineCall): Promise<EngineReply> {
    const run = this.chain.then(() => this.exec(c));
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Serialises work that continues after an op returned (a card's answer): never between two steps of another op. */
  private later<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = this.chain.then(fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async exec(c: EngineCall): Promise<EngineReply> {
    const feature = this.featureOps.get(c.op) ?? null;
    if (!feature && !(TILL_OPS as readonly string[]).includes(c.op)) return { id: c.id, ok: false, error: engineError('unknown_op') };
    const mutating = feature ? feature.mutating.includes(c.op) : MUTATING_OPS.has(c.op);
    if (mutating) {
      if (!c.clientOpId) return { id: c.id, ok: false, error: engineError('missing_client_op_id') };
      const before = this.applied.get(c.clientOpId);
      if (before) return { ...before, id: c.id };
    }
    // A touch: every op from the screens but the host's own and the catalog's read (the idle lock counts from it).
    if (c.op !== 'host.idle' && c.op !== 'hw.result' && c.op !== 'session.hello' && c.op !== 'catalog.snapshot') this.lastTouchAt = this.nowFn();
    let reply: EngineReply;
    try {
      if (!this.svc.fiscal && c.op !== 'session.hello' && c.op !== 'host.idle' && c.op !== 'session.activity') refuse('not_a_till');
      const value = await this.apply(c.op, (c.args ?? {}) as Record<string, unknown>);
      reply = value === undefined ? { id: c.id, ok: true } : { id: c.id, ok: true, value };
    } catch (e) {
      if (e instanceof Refusal) reply = { id: c.id, ok: false, error: e.error };
      else {
        this.log(`till engine ${c.op}: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
        reply = { id: c.id, ok: false, error: engineError('invalid_args') };
      }
    }
    if (mutating && c.clientOpId) {
      this.applied.set(c.clientOpId, reply);
      if (this.applied.size > REMEMBER_OPS) this.applied.delete(this.applied.keys().next().value as string);
    }
    this.dirty = true;
    this.commit();
    return reply;
  }

  private async apply(op: TillOp, a: Record<string, unknown>): Promise<unknown> {
    // A feature module's op (register).
    const feature = this.featureOps.get(op);
    if (feature) return feature.apply(op, a);
    switch (op) {
      case 'session.hello':
        return this.hello();
      case 'session.login':
        return this.login(String(a.pin ?? a.code ?? ''));
      case 'session.logout':
        return this.logout();
      case 'session.activity':
        this.lastActivityAt = this.nowFn();
        return undefined;
      case 'catalog.snapshot':
        return this.catalogSnapshot();
      case 'sell.add': {
        const configured = a.configured === true ? this.choicesArg(a) : null;
        return this.add(String(a.productId ?? ''), a.qty === undefined ? 1 : (a.qty as number), configured ? { choices: configured } : {});
      }
      case 'sell.configure':
        return this.configureLine(String(a.lineId ?? ''), a.qty, this.choicesArg(a));
      case 'sell.setQty':
        return this.setQty(String(a.lineId ?? ''), a.qty as number);
      case 'sell.remove':
        return this.remove(String(a.lineId ?? ''));
      case 'sell.discount':
        return this.lineDiscount(String(a.lineId ?? ''), a.pct);
      case 'sell.clear':
        this.editable();
        this.clearBasket();
        return undefined;
      case 'sell.department': {
        const id = (a.departmentId as string | null) ?? null;
        if (id !== null && !this.svc.tillCatalogData().categories.some((c) => c.id === id)) refuse('invalid_args');
        this.department = id;
        return undefined;
      }
      case 'sell.search':
        if (typeof a.text !== 'string' || a.text.length > 60) refuse('invalid_args');
        this.search = a.text as string;
        return undefined;
      case 'checkout.start':
        return this.checkoutStart();
      case 'checkout.cash':
        return this.cashTender(a.amountAgorot);
      case 'checkout.card':
        return this.cardTender();
      case 'checkout.cancel':
        return this.checkoutCancel();
      case 'checkout.finish':
        return this.checkoutFinish();
      case 'checkout.print':
        return this.answerPrint(a.print === true);
      case 'checkout.recheckCard':
        return this.recheckCard();
      case 'checkout.markNotApproved':
        return this.markNotApproved();
      case 'checkout.returnCustomer':
        return this.confirmReturnCustomer(a);
      case 'checkout.exchange':
        return this.confirmExchange();
      case 'checkout.payout':
        return this.payout(a.method === 'card' ? 'card' : a.method === 'cash' ? 'cash' : refuse('invalid_args'));
      case 'dialog.answer':
        return this.answerDialog(String(a.dialogId ?? ''), String(a.action ?? ''), (a.answers ?? {}) as Record<string, string>);
      case 'doc.history':
        return this.history(typeof a.hours === 'number' && a.hours > 0 ? a.hours : null);
      case 'doc.reprint':
        return this.reprint(String(a.documentId ?? ''));
      case 'doc.detail':
        return this.documentDetail(String(a.documentId ?? ''), a.quantities);
      case 'doc.refund':
        return this.historyRefund(String(a.documentId ?? ''), a.quantities);
      case 'shift.open':
        return this.shiftOpen(a.openingCashAgorot);
      case 'shift.close':
        return this.shiftClose(a.countedCashAgorot, a.keepHeld === true, tipsChoiceOf(a.cardTipsChoice));
      case 'report.x':
        return this.reportX();
      case 'report.shopX':
        return this.shopX(a.refresh === true, a.print === true, a.scope === 'area' ? 'area' : undefined);
      case 'z.produce':
        return this.zProduce(a.countedCashAgorot, a.keepHeld === true, tipsChoiceOf(a.cardTipsChoice));
      case 'mode.switch':
        return this.modeSwitch(a.to as DeviceRoleName, typeof a.managerCode === 'string' ? a.managerCode : null);
      case 'host.idle':
        this.hostIdle = { idle: a.idle === true, busy: a.busy === true };
        return undefined;
      case 'hw.result':
        // The real engine carries out its own hardware: nothing arrives from a page (the role refuses it too).
        return undefined;
      case 'discount.preview':
        return this.discountPreview(a.mode, a.input);
      case 'discount.apply':
        return this.applyBasketDiscount(a.mode, a.input);
      case 'discount.preset':
        return this.applyPresetDiscount(a);
      case 'discount.remove':
        this.editable();
        // One action, no confirm: removing a discount only ever raises what is owed.
        this.cartDiscount = null;
        return undefined;
      case 'oth.confirm':
        return this.othConfirm(a.lineIds, a.reason);
      case 'oth.undo':
        return this.othUndo(String(a.lineId ?? ''));
      case 'refund.button':
        return this.refundButton();
      case 'refund.catalog':
        this.signedIn();
        if (!this.refundChooser) return refuse('invalid_args');
        this.refundChooser = false;
        this.refundMode = true;
        return undefined;
      case 'refund.end':
        // "סיום זיכוי": stops adding returns; the ones in the cart stay.
        this.refundMode = false;
        this.refundChooser = false;
        return undefined;
      case 'refund.recent':
        return this.recentReceipts();
      case 'refund.find':
        return this.findReceipt(a.query);
      case 'refund.pick':
        return this.pickReceipt(String(a.transactionId ?? ''));
      case 'refund.add':
        return this.addFromReceipt(String(a.transactionId ?? ''), a.quantities);
      case 'held.hold':
        return this.hold(a.label);
      case 'held.list':
        this.signedIn();
        return this.held.summaries();
      case 'held.resume':
        return this.resumeHeld(String(a.id ?? ''), a.parkLive === true);
      case 'held.cancel':
        return this.cancelHeld(String(a.id ?? ''), a.reason);
      case 'notice.ack':
        this.svc.kv.delete(AUTO_CLOSE_NOTICE);
        return undefined;
      // "מגירת מזומן" (tillDrawer.ts).
      case 'drawer.open':
        return this.drawer.openManual(typeof a.reason === 'string' ? a.reason : null, typeof a.note === 'string' ? a.note : null);
      case 'drawer.openRemote':
        return this.drawer.openOnHost(a.machineId, typeof a.reason === 'string' ? a.reason : null, typeof a.note === 'string' ? a.note : null);
      case 'drawer.movement':
        return this.drawer.movement(a.type, a.amountAgorot, a.reason, a.note, a.source);
      case 'drawer.count':
        return this.drawer.startCount();
      case 'drawer.countSave':
        return this.drawer.saveCount(a.countedAgorot);
      case 'drawer.countDone':
        return this.drawer.closeCount();
      case 'drawer.wallets':
        return this.drawer.listWallets();
      case 'drawer.walletDeposit':
        return this.drawer.deposit(a.employeeId, a.countedAgorot);
      case 'drawer.log':
        return this.drawer.log();
      // "עובדים מחוברים" (userSessions.ts).
      case 'users.open':
        return this.sessions.open();
      case 'users.refresh':
        this.signedIn();
        return this.sessions.load();
      case 'users.release':
        return this.sessions.release(a.sessionId);
      case 'users.close':
        return this.sessions.closeList();
      case 'session.dismissNotice':
        return this.sessions.dismissNotice();
      // "עודף חייב ללקוח" — "שולם ללקוח" (tillCash.ts), and "זיכוי מזומן" at the payment.
      case 'owed.refresh':
        return this.cash.refresh();
      case 'owed.pay':
        return this.cash.pay(a.id);
      case 'checkout.credit':
        return this.creditTender(a.code);
      case 'checkout.removeCredit':
        return this.removeCredit(a.redemptionId);
      // Vouchers (tillVouchers.ts).
      case 'checkout.voucher':
        return this.vouchers.scan(a.code);
      case 'checkout.removeVoucher':
        return this.vouchers.remove(a.id);
      case 'checkout.finishTest':
        return this.finishTest();
      case 'printQueue.list':
        this.signedIn();
        return { rows: this.printQueue.rows(), view: this.printQueue.view() ?? null };
      case 'printQueue.choices':
        this.signedIn();
        return this.printQueue.choices(String(a.jobId ?? ''));
      case 'printQueue.retry':
        this.signedIn();
        if (!this.printQueue.retry(String(a.jobId ?? ''))) return refuse('invalid_args', FAILOVER_TEXT.busy);
        this.toast(FAILOVER_TEXT.sentAgain, 'ok');
        return undefined;
      case 'printQueue.move': {
        this.signedIn();
        const text = this.printQueue.move(String(a.jobId ?? ''), String(a.toId ?? ''), a.alsoNext === true);
        this.toast(text, text === FAILOVER_TEXT.busy || text === FAILOVER_TEXT.noOther ? 'error' : 'ok');
        return { text };
      }
      case 'printQueue.handled': {
        const job = this.svc.kitchen.job(String(a.jobId ?? ''));
        if (!job) return refuse('invalid_args');
        // "סמן כטופל": a manager's code, always (Android's elevation `table:reprint`).
        return this.gate(
          PERM.REPRINT,
          (approver) => {
            const by = approver ?? { id: this.signedIn().id, name: displayName(this.signedIn()) };
            this.svc.kitchen.discard(job.id, `handled by ${by.name}`, by.name);
            return undefined;
          },
          { force: true, body: FAILOVER_TEXT.handledBody(ticketTitleOf(job), job.printerName) },
        );
      }
      case 'printQueue.endRedirect':
        this.signedIn();
        this.svc.kitchen.endRedirect(String(a.fromId ?? ''));
        return undefined;
      case 'menu.sync':
        this.menu.sync();
        return undefined;
      case 'menu.update':
        return this.menu.update();
      case 'menu.support':
        return this.menu.support();
      // The folder's reports: "דוחות בקופה" (VIEW_REPORTS) — a manager's code where the role asks one.
      case 'report.local': {
        const kind = (['shifts', 'tillZs', 'products', 'workers', 'tips'] as const).find((k) => k === a.kind);
        if (!kind) return refuse('invalid_args');
        this.menu.clearReport();
        return this.gate('VIEW_REPORTS', () => this.menu.open(kind, a.preset));
      }
      case 'report.reprintZ':
        this.menu.reprintZ(String(a.id ?? ''));
        return undefined;
      case 'kiosks.refresh':
        this.kiosks.refresh();
        return undefined;
      case 'kiosks.command': {
        const action = (['pause', 'resume', 'close_shift', 'till_z', 'bon_print', 'bon_handled', 'reprint_bon', 'reprint_receipt', 'enter_till', 'return_kiosk'] as const).find((x) => x === a.action);
        if (!action) return refuse('invalid_args');
        const kioskId = String(a.kioskId ?? '');
        const extra = { message: typeof a.message === 'string' ? a.message : null, minutes: typeof a.minutes === 'number' ? a.minutes : null };
        // "שליטה בקיוסק" (KIOSK_CONTROL): the lock, the reopening and a kiosk's own Z — a manager's code where the role asks.
        if (action === 'pause' || action === 'resume' || action === 'till_z') return this.gate('KIOSK_CONTROL', (by) => this.kiosks.command(kioskId, action, extra, by), { relax: false });
        // "מצב עבודה" (area-gaps §3): an employee whose code holds KIOSK_TILL_MODE — the one signed in when they hold it.
        if (action === 'enter_till' || action === 'return_kiosk') {
          return this.gate(PERM.KIOSK_TILL_MODE, (by) => this.kiosks.command(kioskId, action, extra, by), { askOnDeny: true, title: KIOSK_CONTROL_TEXT.workModeTitle, body: KIOSK_CONTROL_TEXT.workModeApprove });
        }
        this.kiosks.command(kioskId, action, extra, null);
        return undefined;
      }
      case 'blocks.list':
        return this.itemBlocks.list();
      case 'blocks.sheet':
        return this.itemBlocks.sheet(typeof a.productId === 'string' ? a.productId : null, typeof a.categoryId === 'string' ? a.categoryId : null);
      case 'blocks.block':
        return this.blockItem(a);
      case 'blocks.release':
        return this.releaseBlocks(a.ids);
      case 'transmission.open':
        return this.transmissionOpen();
      case 'transmission.now':
        return this.gate(PERM.TRANSMIT, () => this.transmissionAction(() => this.transmission.transmitNow()), { body: TX_TEXT.reasonTransmit });
      case 'transmission.offline':
        return this.transmissionSwitch(a.on === true);
      case 'transmission.authorize':
        return this.gate(PERM.TRANSMIT, () => this.transmissionAction(() => this.transmission.authorizePending()), { body: TX_TEXT.reasonOffline });
      case 'transmission.read':
        this.signedIn();
        void this.transmission.readOffline(true).catch(() => undefined);
        return undefined;
      case 'transmission.more':
        this.signedIn();
        void this.transmission.more().catch(() => undefined);
        return undefined;
      case 'order.details':
        return this.setOrderDetails(a.dining, a.name);
      case 'order.dismiss':
        return this.dismissOrderDetails();
      case 'order.edit':
        return this.editOrderDetails();
      case 'sell.voucher':
        return this.sellVoucher(a.code);
    }
    return refuse('unknown_op');
  }

  /* ------------------------------------------------------------------ staff */

  private roster(): Array<RosterUser & ProfileUser> {
    return this.svc.cloud.posUsers() as Array<RosterUser & ProfileUser>;
  }

  private shop(): string | null {
    return this.svc.shopIdHere();
  }

  private signedIn(): RosterUser {
    if (!this.cashier || this.locked) return refuse('not_logged_in', TEXT.notSignedIn);
    return this.cashier;
  }

  private operator() {
    const u = this.signedIn();
    return { id: u.id, name: displayName(u) };
  }

  /** The operator's role profile — the roster's states, limits and "כשאין הרשאה" (re-read: a roster pull may change it). */
  private roleProfile(): PermissionProfile | null {
    const u = this.cashier;
    if (!u || this.locked) return null;
    const fresh = this.roster().find((x) => x.id === u.id) ?? (u as RosterUser & ProfileUser);
    return profileOf(fresh);
  }

  private deniedSettings() {
    return deniedUiSettingsOf(this.svc.cloud.parameters());
  }

  /** The profile the till acts on: under "כשאין הרשאה" = לבקש קוד מנהל, a role's DENY asks a manager's code. */
  private profile(): PermissionProfile | null {
    return actingProfile(this.roleProfile(), this.deniedSettings(), CODES);
  }

  private async login(pin: string) {
    const d = await tryLogin({
      users: this.roster(),
      shopId: this.shop(),
      areaId: this.svc.areaIdHere(),
      pin,
      lock: this.svc.kv.getJson<ExitLock>(LOGIN_LOCK) ?? NO_LOCK,
      nowMs: this.nowFn(),
      compare: this.compare,
    });
    this.svc.kv.setJson(LOGIN_LOCK, d.lock);
    if (d.outcome !== 'granted' || !d.user) {
      const code: TillErrorCode = d.outcome === 'locked' || d.outcome === 'locked_out' ? 'login_locked' : 'wrong_pin';
      return refuse(code, d.message ?? TEXT.loginBad, { triesLeft: d.triesLeft });
    }
    // "עובד מחובר בקופה אחת בלבד": signed in at another till → not here (unless a manager releases it); no answer — as
    // the shop chose (exclusiveUserLoginOffline). The question's answer completes the sign-in itself.
    const check = await this.sessions.afterPin(d.user);
    if (check !== 'in') return check;
    return this.completeSignIn(d.user);
  }

  /** The employee is in: the operator, the activity's clock, the guard told. */
  private completeSignIn(user: RosterUser) {
    const before = this.cashier;
    if (before && before.id !== user.id) this.sessions.left(before);
    this.cashier = user;
    this.locked = false;
    this.lastActivityAt = this.nowFn();
    this.lastTouchAt = this.lastActivityAt;
    this.sessions.signedIn(user);
    // "נוכחות": the employee's card (clock in first / on a break) — never a refused sign-in (Android).
    this.attendance?.signedIn(user);
    return { cashier: { id: user.id, name: displayName(user) } };
  }

  private logout() {
    if (this.checkout.phase !== 'idle') refuse('checkout_busy');
    this.signOutNow();
    return undefined;
  }

  /** The operator leaves (sign-out, the idle lock, a manager's release, the work mode): the guard owes their release. */
  private signOutNow() {
    const user = this.cashier;
    this.cashier = null;
    this.locked = true;
    if (this.pending?.timer) clearTimeout(this.pending.timer);
    this.pending = null;
    this.drawer.reset();
    // The shop's figures were for the user who asked: gone with them; so is a refund's authority.
    this.shopXDoc = null;
    this.shopXError = null;
    this.shopXScope = 'shop';
    this.refundGrant = null;
    this.refundChooser = false;
    if (user) this.sessions.left(user);
  }

  /** "נעילה בחוסר שימוש" / a manager's release (userSessions.ts): never over a payment — the caller checked. */
  private forceSignOut(reason: 'idle' | 'released') {
    if (!this.cashier || this.checkout.phase !== 'idle') return;
    this.log(`till: ${displayName(this.cashier)} signed out (${reason})`);
    this.signOutNow();
  }

  /**
   * The Android PermissionGate on PermissionService.decide: the operator's own answer for `code` (at `amount` ₪ /
   * `percent`, held to the role's limits) — `allowed` runs `resume` at once (no approver: the operator's own right);
   * `approval` asks a manager's code — only someone allowed it alone within THEIR OWN limits may give it; `denied` is
   * "אין לך הרשאה" — or, with `askOnDeny`, asks a manager too. Under "כשאין הרשאה" = לבקש קוד מנהל, a role's DENY is an
   * approval already (the acting profile).
   */
  private gate(
    code: string,
    resume: (approver: Approver | null) => Promise<unknown> | unknown,
    opts: { askOnDeny?: boolean; title?: string; body?: string; amount?: number | null; percent?: number | null; relax?: boolean; force?: boolean; decision?: Decision; approveCode?: string } = {},
  ): Promise<unknown> | unknown {
    this.signedIn();
    const d = opts.decision ?? decide(this.profile(), code, { amount: opts.amount, percent: opts.percent, relaxApproval: opts.relax, forceApproval: opts.force });
    if (d.kind === 'allowed') return resume(null);
    if (d.kind === 'denied' && !opts.askOnDeny) {
      const text = deniedText(code, d.why);
      // Every refusal of a gated action, in the drawer's audit (Android PermissionGate.onDecision).
      this.drawer.service.recordPermission(code, 'deny', null, text, agorotOf(opts.amount));
      return refuse('permission_denied', text);
    }
    this.openDialog({
      kind: 'manager_approval',
      title: opts.title ?? WORDS.managerApprovalTitle,
      body: opts.body ?? (d.kind === 'approval' ? approvalText(d) : TEXT.approval(code)),
      fields: [{ name: 'pin', label: WORDS.managerCode, kind: 'pin' }],
      actions: [
        { id: 'approve', label: WORDS.approve, primary: true },
        { id: 'cancel', label: WORDS.cancel },
      ],
      code: opts.approveCode ?? code,
      amount: opts.amount ?? null,
      percent: opts.percent ?? null,
      // Every manager override: both names, in the drawer's audit.
      resume: (by) => {
        if (by) this.drawer.service.recordPermission(opts.approveCode ?? code, 'approval', by, null, agorotOf(opts.amount));
        return resume(by);
      },
    });
    return { dialogId: this.pending!.dialog.id };
  }

  private openDialog(d: {
    kind: EngineDialog['kind'];
    title: string;
    body: string;
    fields: EngineDialog['fields'];
    actions: EngineDialog['actions'];
    code: string | null;
    amount?: number | null;
    percent?: number | null;
    resume: PendingDialog['resume'];
    verify?: PendingDialog['verify'];
    onAction?: PendingDialog['onAction'];
    onCancel?: PendingDialog['onCancel'];
    expiresInMs?: number;
    onTimeout?: PendingDialog['onTimeout'];
  }) {
    if (this.pending?.timer) clearTimeout(this.pending.timer);
    this.dialogSeq += 1;
    const id = `d${this.dialogSeq}`;
    const expiresAt = d.expiresInMs && d.expiresInMs > 0 ? this.nowFn() + d.expiresInMs : undefined;
    this.pending = {
      dialog: { id, kind: d.kind, title: d.title, body: d.body, fields: d.fields, actions: d.actions, ...(expiresAt ? { expiresAt } : {}) },
      code: d.code,
      amount: d.amount ?? null,
      percent: d.percent ?? null,
      verify: d.verify,
      resume: d.resume,
      onAction: d.onAction,
      onCancel: d.onCancel,
      onTimeout: d.onTimeout,
    };
    if (expiresAt) {
      const p = this.pending;
      p.timer = setTimeout(() => {
        void this.later(async () => {
          if (this.pending !== p || this.stopped) return;
          this.pending = null;
          try {
            await p.onTimeout?.();
          } catch (e) {
            this.log(`till dialog timeout: ${String(e)}`);
          }
          this.dirty = true;
          this.commit();
        });
      }, d.expiresInMs);
      p.timer.unref?.();
    }
  }

  private async answerDialog(id: string, action: string, answers: Record<string, string>) {
    const p = this.pending;
    if (!p || p.dialog.id !== id) return refuse('invalid_args');
    if (action === 'cancel') {
      if (p.timer) clearTimeout(p.timer);
      this.pending = null;
      const v = await p.onCancel?.();
      return v === undefined ? undefined : v;
    }
    // A choice: its actions are the answers (the drawers, "הכסף אצלי", "פתח" / "לא").
    if (p.onAction && !p.verify && !p.code) {
      if (!p.dialog.actions.some((a) => a.id === action)) return refuse('invalid_args');
      if (p.timer) clearTimeout(p.timer);
      this.pending = null;
      const v = await p.onAction(action, answers);
      return v === undefined ? undefined : v;
    }
    if (action !== 'approve') return refuse('invalid_args');
    let approver: Approver | null = null;
    if (p.verify) {
      const v = await p.verify(String(answers.pin ?? ''));
      if (!v.ok) return refuse('wrong_pin', v.message);
      approver = v.by;
    } else if (p.code) {
      const out = await approveWithin({
        users: this.roster(),
        shopId: this.shop(),
        code: p.code,
        pin: String(answers.pin ?? ''),
        lock: this.svc.kv.getJson<ExitLock>(APPROVAL_LOCK) ?? NO_LOCK,
        nowMs: this.nowFn(),
        compare: this.compare,
        amount: p.amount,
        percent: p.percent,
      });
      if (!out.ok) {
        this.svc.kv.setJson(APPROVAL_LOCK, out.lock);
        const code: TillErrorCode = out.reason === 'locked' ? 'login_locked' : out.reason === 'no_approver' || out.reason === 'over_limit' ? 'manager_required' : 'wrong_pin';
        return refuse(code, out.message);
      }
      this.svc.kv.setJson(APPROVAL_LOCK, NO_LOCK);
      approver = { id: out.user.id, name: displayName(out.user) };
    }
    if (p.timer) clearTimeout(p.timer);
    this.pending = null;
    const value = await p.resume(approver, answers);
    return value === undefined ? undefined : value;
  }

  /* ----------------------------------------------------------------- catalog */

  /** The kiosk catalog's version, and whether this user sees manager-approval items (another sign-in may see another list). */
  private catalogVersion(): number {
    const user = this.cashier;
    // "עריכת מסך": the arrangement on show (being made, or just saved) moves the version too.
    return (this.svc.tillCatalogVersion() * 2 + (user && stateOf(user, PERM.SELL_RESTRICTED) !== 'deny' ? 1 : 0)) * 4096 + ((this.screenEdit?.rev() ?? 0) % 4096);
  }

  private catalogSnapshot(): Catalog {
    const cat = this.svc.tillCatalogData();
    const user = this.cashier;
    const mayRestricted = !!user && stateOf(user, PERM.SELL_RESTRICTED) !== 'deny';
    const ids = new Map(cat.categories.map((c, i) => [c.id, i] as const));
    // "תוספות / ארוחה": the groups the sheets use (once, by id), and what each product may be chosen with.
    const choiceGroups: Record<string, ChoiceGroupView> = {};
    for (const list of Object.values(cat.groups)) {
      for (const g of list) {
        choiceGroups[g.id] ??= {
          id: g.id,
          name: g.name,
          kind: g.kind,
          min: g.min,
          max: g.max,
          freeCount: g.freeCount,
          allowQuantity: g.allowQuantity,
          allowPre: g.allowPre,
          options: g.options.map((o) => ({ id: o.id, name: o.name, priceAgorot: o.priceAgorot, isDefault: o.isDefault, maxQty: o.maxQty })),
        };
      }
    }
    const choicesOf = (pid: string): Product['choices'] => {
      const groups = cat.groups[pid] ?? [];
      const meal = (cat.meals[pid] ?? []).length > 0 ? this.mealSlotViews(pid) : null;
      const notes = cat.quickNotes[pid] ?? [];
      if (groups.length === 0 && !meal && notes.length === 0) return undefined;
      return { groupIds: groups.map((g) => g.id), ...(meal ? { meal } : {}), notes, ownNotes: cat.ownNotes?.[pid] === true, needsSheet: needsSheet(groups, meal) };
    };
    return arrangeCatalog({
      version: this.catalogVersion(),
      ...(Object.keys(choiceGroups).length > 0 ? { choiceGroups } : {}),
      departments: cat.categories.map((c, i) => ({ id: c.id, name: c.name, color: PALETTE[i % PALETTE.length] })),
      products: cat.products
        .filter((p) => p.categoryId !== null && ids.has(p.categoryId) && (!p.restricted || mayRestricted))
        .map((p): Product => {
          const sale = !p.available ? 'unavailable' : p.sale?.state === 'blocked' ? 'blocked' : p.sale?.state === 'sold_out' ? 'sold_out' : undefined;
          return {
            id: p.id,
            departmentId: p.categoryId as string,
            name: p.name,
            priceAgorot: p.priceAgorot,
            ...(p.barcode ? { barcode: p.barcode } : {}),
            ...(p.sku ? { sku: p.sku } : {}),
            ...(sale ? { sale } : {}),
            ...(sale && p.sale?.reason ? { saleReason: p.sale.reason } : {}),
            ...(p.restricted ? { restricted: true } : {}),
            ...(p.voucherId ? { voucher: true } : {}),
            // The "i" window's (P:/specs/product-tile-text.md §4): the description, allergens, dietary tags.
            ...(p.description ? { description: p.description } : {}),
            ...(p.allergens.length > 0 ? { allergens: p.allergens } : {}),
            ...(p.dietaryTags.length > 0 ? { dietary: [...p.dietaryTags] } : {}),
            ...(() => {
              const choices = choicesOf(p.id);
              return choices ? { choices } : {};
            })(),
          };
        }),
    }, this.screenEdit?.overlay() ?? null);
  }

  /* -------------------------------------------------------------------- cart */

  private comingSoon(what: string): never {
    return refuse('coming_soon', WORDS.comingSoon(what));
  }

  /** The cart may change: signed in, no payment open. */
  private editable() {
    this.signedIn();
    if (this.checkout.phase !== 'idle') refuse('checkout_busy');
  }

  /** The basket and everything that goes with it: the next customer starts by selling. */
  private clearBasket() {
    this.cart = [];
    this.sellApprovedFor = null;
    this.cartDiscount = null;
    this.discountApprover = null;
    this.refundMode = false;
    this.refundChooser = false;
    this.refundGrant = null;
    this.orderDining = null;
    this.orderName = null;
    this.orderStart = null;
    this.orderAsk = null;
    this.basketId = randomUUID();
  }

  /* ------------------------------------------------------------- the order's details */

  private orderQuestions(): OrderQuestions {
    // "עיצוב קופה": fields.customerName / serviceType over askOrderName / askEatInTakeAway (Android applyTillDesign).
    return orderQuestionsOf(designParameters(this.svc.cloud.parameters(), this.design.config()));
  }

  private orderFacts(): OrderFacts {
    return { hasLines: this.cart.length > 0, hasRefundLines: this.cart.some((l) => l.refund), dining: this.orderDining, name: this.orderName };
  }

  /** What this quick order still has to answer (null: nothing, or nothing asked). */
  private orderDetailsMissing(): OrderQuestions | null {
    return missingOrderDetails(this.orderQuestions(), this.orderFacts());
  }

  /**
   * The details given ("לקחת" / "לשבת", the name), each kept when not given; then what waited for them: the held first item
   * ("בפתיחת הזמנה"), the payment. Mandatory: what is asked and still missing is refused.
   */
  private setOrderDetails(diningRaw: unknown, nameRaw: unknown) {
    this.signedIn();
    if (this.checkout.phase !== 'idle') return refuse('checkout_busy');
    const dining = diningOf(diningRaw);
    const name = cleanOrderName(nameRaw);
    if (diningRaw !== undefined && diningRaw !== null && !dining) return refuse('invalid_args');
    const q = this.orderQuestions();
    const next: OrderFacts = { ...this.orderFacts(), dining: dining ?? this.orderDining, name: name ?? this.orderName };
    const still = missingOrderDetails(q, next);
    if (still?.dining) return refuse('invalid_args', ORDER_TEXT.diningQuestion);
    if (still?.name) return refuse('invalid_args', ORDER_TEXT.nameRequired);
    this.orderDining = next.dining;
    this.orderName = next.name;
    const ask = this.orderAsk;
    this.orderAsk = null;
    if (ask === 'open' && this.orderStart) {
      const start = this.orderStart;
      this.orderStart = null;
      return this.add(start.productId, start.qty, start.choices ? { choices: start.choices } : {});
    }
    if (ask === 'payment') return this.checkoutStart();
    return undefined;
  }

  /** The sheet closed unanswered: the held first item dropped; the opening questions not again for this order (the payment asks). */
  private dismissOrderDetails() {
    this.signedIn();
    const ask = this.orderAsk;
    this.orderAsk = null;
    if (ask === 'open') this.orderStart = null;
    if (ask === null) this.diningFirstDismissedFor = this.basketId;
    return undefined;
  }

  /** "פרטי הזמנה" from the strip on the sell screen: the configured questions, the answers shown. */
  private editOrderDetails() {
    this.signedIn();
    if (this.checkout.phase !== 'idle') return refuse('checkout_busy');
    if (!anyQuestion(this.orderQuestions())) return refuse('invalid_args');
    this.orderAsk = 'edit';
    return undefined;
  }

  /** What the screens show of the order's details, and the sheet the engine asks for now. */
  private orderView(): TillState['order'] {
    const q = this.orderQuestions();
    const strip = orderDetailsStrip(this.orderDining, this.orderName) || null;
    if (!anyQuestion(q) && !strip) return undefined;
    let ask: OrderAsk | null = null;
    const user = this.cashier && !this.locked;
    if (user && this.checkout.phase === 'idle') {
      if (this.orderAsk === 'edit') ask = { purpose: 'edit', dining: q.dining, name: q.name, confirmLabel: ORDER_TEXT.save };
      else if (this.orderAsk === 'open' || this.orderAsk === 'payment') {
        const m = this.orderDetailsMissing();
        if (m) ask = { purpose: this.orderAsk, dining: m.dining, name: m.name, confirmLabel: this.orderAsk === 'open' ? ORDER_TEXT.start : ORDER_TEXT.continue };
      } else if (!this.refundMode && !this.refundChooser && this.diningFirstDismissedFor !== this.basketId && (this.svc.ledger.currentShift() || this.shiftsHidden())) {
        const due = startDetailsDue(q, this.orderFacts());
        if (due) ask = { purpose: 'start', dining: due.dining, name: due.name, confirmLabel: ORDER_TEXT.start };
      }
    }
    return { dining: this.orderDining, name: this.orderName, strip, configured: anyQuestion(q), ask };
  }

  /**
   * A product into the cart (`sell.add`). `choices`: from its sheet ("הוסף") — checked against the catalog's groups / meal
   * slots before any gate; none: a plain tap — a meal or a dish with a required group answers `{choices: true}` (the screen
   * opens the sheet, nothing is added), any other dish goes in on its options' defaults (DishDraft.start). `onProceed`: what
   * passing every gate does instead of a new line (a configured line grown from its sheet).
   */
  private add(productId: string, qty: number, o: { choices?: LineChoices; onProceed?: () => unknown } = {}) {
    this.editable();
    this.attendanceGate();
    if (!isInt(qty, 1, MAX_QTY)) refuse('invalid_args');
    const cat = this.svc.tillCatalogData();
    const p = cat.products.find((x) => x.id === productId);
    if (!p) return refuse('invalid_args');
    const groups = cat.groups[p.id] ?? [];
    const slots = cat.meals[p.id] ?? [];
    let choices: LineChoices | null = null;
    if (!this.refundMode) {
      if (o.choices) {
        const why = this.choicesRefusal(p.id, o.choices);
        if (why) return refuse('sell_refused', why);
        choices = o.choices;
      } else if (needsSheet(groups, slots)) {
        // Menu.needsSheet: the sheet first — nothing in the cart until it is confirmed.
        return { choices: true };
      } else if (groups.length > 0) {
        choices = { ...NO_CHOICES, options: defaultOptions(groups.map(moneyGroupOf)) };
      }
    }
    // "מצב זיכוי": a tap takes one unit back (addReturn) — not behind the sale's gates: its own authority was asked.
    if (this.refundMode) {
      // A voucher is credited from its receipt only (SellViewModel.refundRefusal).
      const voucher = voucherRefundRefusal(p);
      if (voucher) return refuse('refund_refused', voucher);
      this.putRefund(p.id, qty, p.name);
      return undefined;
    }
    // "בפתיחת הזמנה": the first item of a new quick order waits for the order's details.
    if (!o.onProceed && this.cart.length === 0 && !this.orderStart && this.orderQuestions().atOpen && this.orderDetailsMissing()) {
      this.orderStart = { productId: p.id, qty, choices: o.choices ?? null };
      this.orderAsk = 'open';
      return { orderDetails: true };
    }
    const settings = this.svc.settingsMap();
    const user = this.signedIn();
    const proceed = (soldOutApproved: boolean) => {
      void soldOutApproved;
      if (o.onProceed) return o.onProceed();
      this.putLine(p.id, qty, choices);
      return undefined;
    };
    const afterSellGate = (): unknown => {
      // "לא זמין" — the product's own lock ("נעילת מוצר").
      if (!p.available) return refuse('sell_refused', WORDS.notSellable(p.name));
      const restricted = () =>
        p.restricted
          ? this.gate(PERM.SELL_RESTRICTED, () => afterRestricted(), { body: TEXT.approval(PERM.SELL_RESTRICTED) })
          : afterRestricted();
      return restricted();
    };
    const afterRestricted = (): unknown => {
      const sale = p.sale;
      if (!sale || sale.state === 'available') return proceed(false);
      if (sale.state === 'blocked') return refuse('sell_refused', WORDS.blocked(p.name, sale.note));
      // "אזל": a hand-set one asks a manager; an automatic one (the stock ran out) follows the shop's out-of-stock policy.
      const policy = String(settings.outOfStockPolicy ?? '').trim().toLowerCase();
      const policyBlocks = policy === 'block';
      const manual = sale.reason === 'manual';
      if (!manual && !policyBlocks) {
        if (policy === 'warn') {
          this.openDialog({
            kind: 'confirm',
            title: WORDS.stockWarnTitle,
            body: WORDS.stockWarnMessage(p.name),
            fields: [],
            actions: [
              { id: 'approve', label: 'המשך', primary: true },
              { id: 'cancel', label: WORDS.cancel },
            ],
            code: null,
            resume: () => proceed(true),
          });
          return { dialogId: this.pending!.dialog.id };
        }
        return proceed(false);
      }
      const until = sale.untilMs ? WORDS.soldOutUntil(new Date(sale.untilMs).toLocaleString('he-IL')) : '';
      const body = sale.reason === 'stock' ? WORDS.soldOutMessageStock(p.name) : WORDS.soldOutMessage(p.name, until);
      // The Android dialog: a user who may edit the catalog sells it anyway; any other asks a manager's code.
      if (stateOf(user, PERM.CATALOG_WRITE) === 'allow') {
        this.openDialog({
          kind: 'confirm',
          title: WORDS.soldOutTitle,
          body,
          fields: [],
          actions: [
            { id: 'approve', label: WORDS.soldOutApproveSelf, primary: true },
            { id: 'cancel', label: WORDS.cancel },
          ],
          code: null,
          resume: () => proceed(true),
        });
      } else {
        this.openDialog({
          kind: 'manager_approval',
          title: WORDS.soldOutTitle,
          body: `${body}\n${WORDS.soldOutManager(p.name)}`,
          fields: [{ name: 'pin', label: WORDS.managerCode, kind: 'pin' }],
          actions: [
            { id: 'approve', label: WORDS.soldOutApprove, primary: true },
            { id: 'cancel', label: WORDS.cancel },
          ],
          code: PERM.CATALOG_WRITE,
          resume: () => proceed(true),
        });
      }
      return { dialogId: this.pending!.dialog.id };
    };
    // SELL: asked once per basket when the user needs a manager for it (Android sellGate).
    if (this.sellApprovedFor === this.basketId) return afterSellGate();
    return this.gate(PERM.SELL, (approver) => {
      if (approver) this.sellApprovedFor = this.basketId;
      return afterSellGate();
    });
  }

  /**
   * A sale line: grows the plain line of the product (never a discounted, OTH, held-price or returned one) — a dish on the same
   * choices with no notes counts as plain; a meal, notes, "חשוב" or an allergy always make a line of their own.
   */
  private putLine(productId: string, qty: number, choices: LineChoices | null = null) {
    const same = this.cart.find(
      (l) => l.productId === productId && !l.refund && !l.discount && !l.oth && (l.keptUnitAgorot ?? null) === null && sameChoices(l.choices ?? NO_CHOICES, choices ?? NO_CHOICES),
    );
    if (same) same.qty = Math.min(MAX_QTY, same.qty + qty);
    else {
      this.lineSeq += 1;
      this.cart.push({ lineId: `l${this.lineSeq}`, productId, qty, ...(choices ? { choices } : {}) });
    }
  }

  /**
   * "הזמנות קיוסק לתשלום" (tillKioskOrders.ts): the kiosk order's basket into the cart line for line — each dish at its own
   * price as the kiosk took it, its choices priced by the till's rules, as a held sale comes back — the order's name ("A-17 ·
   * דנה") and service for the kitchen, then the payment: the kiosk's vouchers as legs taken first (never more than the
   * order), its tip on top. Not behind the sale's gates: the kiosk sold it; the till takes the money. The refusal's words, or null.
   */
  private loadKioskOrder(order: KioskOpenOrder, lines: KioskBasketLine[]): string | null {
    if (!this.cashier || this.locked) return TEXT.notSignedIn;
    if (this.cart.length > 0 || this.checkout.phase !== 'idle') return KPAY_TEXT.basketBusy;
    if (!this.svc.ledger.currentShift() && !this.shiftsHidden()) return WORDS.noShiftBlocksSale;
    this.clearBasket();
    for (const l of lines) {
      this.lineSeq += 1;
      this.cart.push({ lineId: `l${this.lineSeq}`, productId: l.productId, qty: l.qty, keptUnitAgorot: l.baseAgorot, name: l.name, ...(l.choices ? { choices: l.choices } : {}) });
    }
    this.orderName = orderNameOf(order);
    this.orderDining = order.service;
    const p = this.priced();
    if (p.gone.length > 0) {
      const names = this.cart.filter((r) => p.gone.includes(r.lineId)).map((r) => r.name ?? r.productId);
      this.clearBasket();
      return KPAY_TEXT.notSoldHere(names.join(', '));
    }
    const tip = Math.max(0, order.tipAgorot);
    const totals = tip > 0 ? { ...p.totals, tipAgorot: tip, chargeAgorot: p.totals.totalAgorot + tip } : p.totals;
    let left = totals.chargeAgorot;
    const legs = order.vouchers.flatMap((v) => {
      const amount = Math.min(v.amountAgorot, left);
      left -= amount;
      return amount > 0
        ? [{ method: 'production_voucher' as const, amountAgorot: amount, handedAgorot: 0, voucher: { redemptionId: v.redemptionId, reservationId: null, serial: v.serial }, status: 'approved' as const, external: true }]
        : [];
    });
    this.vouchers.clear();
    this.checkout = {
      ...idleCheckout(),
      phase: 'tender',
      totalAgorot: totals.chargeAgorot,
      frozen: { lines: p.lines, tracked: p.tracked, promotions: p.promotions, totals, basketDiscountAgorot: p.basketDiscountAgorot, basketDiscount: null, refunds: [] },
      legs,
      token: randomUUID(),
      kioskOrder: order,
    };
    return null;
  }

  /** A line's choices as an op sent them (shape only — the catalog's groups decide the rest); refused when malformed. */
  private choicesArg(a: Record<string, unknown>): LineChoices {
    const options = cleanOptions(a.options);
    const meal = cleanMeal(a.meal);
    if (options === null || meal === undefined) return refuse('invalid_args');
    return { options, notes: cleanNotes(a.notes), meal, important: a.important === true, allergies: cleanAllergies(a.allergies) };
  }

  /** Why [choices] do not answer the product's groups / meal slots now (Android's words), or null. */
  private choicesRefusal(productId: string, choices: LineChoices): string | null {
    const cat = this.svc.tillCatalogData();
    const slots = cat.meals[productId] ?? [];
    const groupsOf = (id: string) => (cat.groups[id] ?? []).map(moneyGroupOf);
    if (slots.length > 0) {
      if (choices.options.length > 0) return 'בחירה לא מוכרת';
      return mealRefusal(this.mealSlotViews(productId), choices.meal ?? { components: [] }, groupsOf);
    }
    if (choices.meal) return 'בחירה לא מוכרת';
    return optionsRefusal(groupsOf(productId), choices.options);
  }

  /** A meal's slots as the sheets read them: each choice named, with its own groups. */
  private mealSlotViews(productId: string): MealSlotView[] {
    const cat = this.svc.tillCatalogData();
    const names = new Map([...cat.products, ...cat.held].map((p) => [p.id, p.name] as const));
    return (cat.meals[productId] ?? []).map((s) => ({
      id: s.id,
      name: s.name,
      minSelect: s.minSelect,
      maxSelect: s.maxSelect,
      quantity: s.quantity,
      allowRepeat: s.allowRepeat,
      choices: s.choices.map((c) => ({ productId: c.productId, name: names.get(c.productId) ?? c.productId, upchargeAgorot: c.upchargeAgorot, isDefault: c.isDefault, groupIds: (cat.groups[c.productId] ?? []).map((g) => g.id) })),
    }));
  }

  /**
   * "עדכן" on a configured line (Android editLine → confirmDish): its new choices and quantity, checked as a new line's; more
   * units than before go through the sale's gates as a tap would (a block or "אזל" that arrived since refuses them).
   */
  private configureLine(lineId: string, qtyRaw: unknown, choices: LineChoices) {
    this.editable();
    if (!isInt(qtyRaw, 1, SHEET_QTY_MAX)) return refuse('invalid_args');
    const qty = qtyRaw as number;
    const line = this.cart.find((l) => l.lineId === lineId);
    if (!line || line.refund || line.receipt) return refuse('invalid_args');
    const why = this.choicesRefusal(line.productId, choices);
    if (why) return refuse('sell_refused', why);
    const apply = () => {
      const current = this.cart.find((l) => l.lineId === lineId);
      if (!current) return refuse('invalid_args');
      current.choices = choices;
      current.qty = qty;
      return undefined;
    };
    if (qty > line.qty) return this.add(line.productId, qty - line.qty, { choices, onProceed: apply });
    return apply();
  }

  /** A catalog return: one more unit of the product's own return line (never folded into a sale or a receipt line). */
  private putRefund(productId: string, qty: number, name: string) {
    const same = this.cart.find((l) => l.productId === productId && l.refund && !l.receipt);
    if (same) same.qty = Math.min(MAX_QTY, same.qty + qty);
    else {
      this.lineSeq += 1;
      this.cart.push({ lineId: `l${this.lineSeq}`, productId, qty, refund: true, receipt: null, name });
    }
  }

  private setQty(lineId: string, qty: number) {
    this.editable();
    if (!isInt(qty, 0, MAX_QTY)) refuse('invalid_args');
    const line = this.cart.find((l) => l.lineId === lineId);
    if (!line) return refuse('invalid_args');
    if (qty === 0) return this.remove(lineId);
    if (line.refund) {
      // A line from a receipt never takes back more than is left on it.
      line.qty = line.receipt ? Math.min(qty, Math.max(0, line.receipt.originalQty - line.receipt.alreadyRefunded)) : qty;
      return undefined;
    }
    if (qty > line.qty) {
      // More of an OTH line: the extra units are paid, on a line of their own right under it (othGrowth).
      if (line.oth) {
        this.lineSeq += 1;
        const at = this.cart.indexOf(line);
        this.cart.splice(at + 1, 0, { lineId: `l${this.lineSeq}`, productId: line.productId, qty: qty - line.qty });
        return undefined;
      }
      // More of a product is a line coming in again: the gate asks about it as for a tap (a block that arrived since refuses).
      // A configured line grows itself (its choices kept), through the same gates.
      if (line.choices && !line.discount && (line.keptUnitAgorot ?? null) === null) {
        const grow = () => {
          const current = this.cart.find((l) => l.lineId === lineId);
          if (current) current.qty = qty;
          return undefined;
        };
        return this.add(line.productId, qty - line.qty, { choices: line.choices, onProceed: grow });
      }
      if (!line.discount && (line.keptUnitAgorot ?? null) === null) return this.add(line.productId, qty - line.qty);
    }
    line.qty = qty;
    return undefined;
  }

  /** "הסר": LINE_VOID for a sale line (a manager's code where the role asks it); a return line goes without it. */
  private remove(lineId: string) {
    this.editable();
    const line = this.cart.find((l) => l.lineId === lineId);
    if (!line) return undefined;
    const drop = (approver: Approver | null) => {
      this.cart = this.cart.filter((l) => l.lineId !== lineId);
      if (!line.refund) this.recordVoid(line, approver);
      if (this.cart.length === 0) this.cartDiscount = null;
      return undefined;
    };
    if (line.refund) return drop(null);
    return this.gate(PERM.LINE_VOID, drop);
  }

  /** "ביטול שורה": the till event `line_void` (what was taken off, by whom, who approved it). */
  private recordVoid(line: CartRec, approver: Approver | null) {
    const p = this.svc.tillCatalogData().products.find((x) => x.id === line.productId);
    const unit = line.keptUnitAgorot ?? p?.priceAgorot ?? 0;
    const op = this.cashier;
    this.svc.recordEngineEvent?.({
      id: randomUUID(),
      type: 'line_void',
      occurredAt: new Date(this.nowFn()).toISOString(),
      shiftId: this.svc.ledger.currentShift()?.id ?? null,
      posUserId: op?.id ?? null,
      amount: (unit * line.qty) / 100,
      details: {
        productName: line.name ?? p?.name ?? line.productId,
        productId: line.productId,
        quantity: line.qty,
        unitPrice: unit / 100,
        ...(approver ? { approvedBy: approver.id, approvedByName: approver.name } : {}),
      },
    });
  }

  /** The cart priced: the sale lines by the kiosk's own engine on the till channel (promotions by the clock), the returns. */
  private priced(now = new Date(this.nowFn())): Priced {
    const sales = this.cart.filter((l) => !l.refund);
    const lines = sales.map((l) => ({
      key: l.lineId,
      productId: l.productId,
      qty: l.qty,
      notes: l.choices?.notes ?? [],
      options: l.choices?.options ?? [],
      ...(l.choices?.meal ? { meal: l.choices.meal } : {}),
    }));
    // The payment's vouchers (tillVouchers.ts): the discount ones priced with the promotions, the production ones booked after.
    const withVouchers = this.checkout.phase !== 'idle' && !this.checkout.basket;
    const discounts = withVouchers ? this.vouchers.discounts : [];
    const production = withVouchers ? this.vouchers.production : [];
    const input = {
      lines,
      service: null,
      customerName: null,
      customerPhone: null,
      tableRef: null,
      tipPct: null,
      tipAgorot: null,
      ...(discounts.length > 0 ? { vouchers: { legs: [], discounts, saleRef: this.basketId } } : {}),
    } as unknown as StartPaymentIn;
    const byKey = new Map(sales.map((l) => [l.lineId, l] as const));
    const handOf = (rec: CartRec | undefined, gross: number, noDiscount: boolean) =>
      rec?.oth ? lineDiscountAmount(gross, { type: 'percentage', value: OTH_PERCENT }) : lineDiscountAmount(gross, rec?.discount ?? null, false, noDiscount);
    const r =
      sales.length === 0
        ? { lines: [] as SaleLine[], changes: [] as Array<{ kind: string; key?: string }>, tracked: [] as string[], promotions: [] as AppliedPromotionRow[], voucherOutcomes: [] as VoucherOutcome[] }
        : this.svc.priceTillBasket(input, now, {
            promo: (key, gross) => {
              const rec = byKey.get(key);
              if (!rec) return null;
              if (rec.oth) return { exclude: true };
              const hand = rec.discount ? lineDiscountAmount(gross, rec.discount) : 0;
              return hand > 0 ? { handDiscountAgorot: hand } : null;
            },
            listPrice: (key) => byKey.get(key)?.keptUnitAgorot ?? null,
          });
    const gone = r.changes.filter((c) => c.kind === 'removed').map((c) => c.key ?? '');
    // The cashier's discount and OTH on each line (Cart.discountAmount): in the document's discount, never its gross.
    const handLines: SaleLine[] = r.lines.map((l) => {
      const rec = byKey.get(l.key);
      const gross = lineGross(l);
      const hand = handOf(rec, gross, l.noDiscount === true);
      return {
        ...l,
        ...(hand > 0 ? { discountAgorot: hand } : {}),
        ...(rec?.oth ? { oth: { reason: rec.oth.reason, by: rec.oth.by, approvedBy: rec.oth.approvedBy } } : {}),
        // "חשוב" and the diner's allergies: the kitchen ticket's (KitchenTicketDesigns), never a price.
        ...(rec?.choices?.important ? { important: true } : {}),
        ...(rec?.choices && rec.choices.allergies.length > 0 ? { allergies: [...rec.choices.allergies] } : {}),
      };
    });
    // "שוברי הפקה" (core/till/vouchers.ts): each production voucher of the payment booked on the lines, in order.
    let saleLines = handLines;
    let promotions = r.promotions;
    let prepaid: DocPrepaidRedemption[] = [];
    let voucherLegs: NonNullable<Frozen['voucherLegs']> = [];
    if (production.length > 0) {
      const booked = bookProductionVouchers(handLines, production, (ls) => this.totalsOf(ls).totals.totalAgorot);
      saleLines = booked.lines;
      prepaid = booked.redemptions;
      voucherLegs = booked.legs.map((l) => ({ amountAgorot: l.amountAgorot, voucher: { redemptionId: l.applied.redemptionId, reservationId: l.applied.reservationId, serial: l.applied.serial } }));
      // The promotions lose what the covered units had of them.
      promotions = promotions.flatMap((pr) => {
        const lost = booked.promotionsLost.get(pr.promotionId ?? '') ?? 0;
        const left = pr.discountAgorot - lost;
        return lost <= 0 ? [pr] : left > 0 ? [{ ...pr, discountAgorot: left }] : [];
      });
    }
    const t = this.totalsOf(saleLines);
    const refunds = this.pricedRefunds();
    const refundTotal = refunds.reduce((s, x) => s + x.totalAgorot, 0);
    const saleTotal = sales.length > 0 ? t.totals.totalAgorot : 0;
    return {
      lines: saleLines,
      tracked: r.tracked,
      promotions,
      totals: t.totals,
      basketDiscountAgorot: t.basketDiscountAgorot,
      basketDiscount: this.cartDiscount,
      refunds,
      gone,
      saleTotalAgorot: saleTotal,
      refundTotalAgorot: refundTotal,
      netAgorot: saleTotal - refundTotal,
      lineDiscountsAgorot: t.hand - t.oth,
      othAgorot: t.oth,
      nonDiscountableAgorot: t.nonDiscountable,
      ...(r.voucherOutcomes && r.voucherOutcomes.length > 0 ? { voucherOutcomes: r.voucherOutcomes } : {}),
      ...(prepaid.length > 0 ? { prepaid, voucherLegs } : {}),
    };
  }

  /**
   * The sale lines' totals (Cart.totals): the cashier's discounts, the promotions, the discount vouchers and the production
   * vouchers' deductions first, then the basket discount over what is left of the lines that take discounts.
   */
  private totalsOf(lines: readonly SaleLine[]) {
    const gross = lines.reduce((s, l) => s + lineGross(l), 0);
    const hand = lines.reduce((s, l) => s + (l.discountAgorot ?? 0), 0);
    const oth = lines.filter((l) => l.oth).reduce((s, l) => s + (l.discountAgorot ?? 0), 0);
    const promotion = lines.reduce((s, l) => s + (l.promotionAgorot ?? 0), 0);
    const voucher = lines.reduce((s, l) => s + Math.max(0, l.voucherAgorot ?? 0), 0);
    const deduction = lines.reduce((s, l) => s + Math.max(0, l.prepaidDeductionAgorot ?? 0), 0);
    const afterLines = gross - hand - promotion - voucher - deduction;
    // A product that takes no discount keeps its full price (a voucher's own price too): the basket discount over the others.
    const nonDiscountable = lines.filter((l) => l.noDiscount).reduce((s, l) => s + lineNet(l), 0);
    const basketDiscountAgorot = documentDiscountAmount(afterLines - nonDiscountable, this.cartDiscount);
    return { totals: saleTotals(lines, this.svc.vatRate(), 0, basketDiscountAgorot), basketDiscountAgorot, hand, oth, nonDiscountable };
  }

  /** The return lines: a catalog return at the catalog's price now, a receipt line at what the customer paid for it. */
  private pricedRefunds(): PricedRefund[] {
    const recs = this.cart.filter((l) => l.refund);
    if (recs.length === 0) return [];
    const cat = this.svc.tillCatalogData();
    const out: PricedRefund[] = [];
    for (const rec of recs) {
      const src = rec.receipt;
      if (src) {
        const total = creditFor(src.collectedAgorot, src.originalQty, src.alreadyRefunded, rec.qty);
        out.push({
          rec,
          totalAgorot: total,
          tracked: src.tracked,
          line: { ...src.line, key: rec.lineId, qty: rec.qty, creditAgorot: total, refundOfItemId: src.itemId, promotionAgorot: undefined, voucherAgorot: undefined, discountAgorot: undefined, oth: undefined },
        });
        continue;
      }
      const p = cat.products.find((x) => x.id === rec.productId);
      const unit = p?.priceAgorot ?? 0;
      const total = times(unit, rec.qty);
      out.push({
        rec,
        totalAgorot: total,
        tracked: p?.trackStock === true,
        line: { key: rec.lineId, productId: rec.productId, name: rec.name ?? p?.name ?? rec.productId, sku: p?.sku ?? null, basePriceAgorot: unit, options: [], notes: [], qty: rec.qty, categoryId: p?.categoryId ?? null, creditAgorot: total, refundOfItemId: null },
      });
    }
    return out;
  }

  /* --------------------------------------------------------------- discounts */

  /** "הנחה" on a line, in whole percent (0 takes it off — nobody is asked for that). */
  private lineDiscount(lineId: string, pctRaw: unknown) {
    this.editable();
    if (!isInt(pctRaw, 0, 100)) return refuse('invalid_args');
    const pct = pctRaw as number;
    const line = this.cart.find((l) => l.lineId === lineId);
    if (!line) return refuse('invalid_args');
    // An OTH line takes no other discount: said, and nobody is asked.
    if (line.oth) return refuse('discount_refused', WORDS.othRefusedLineDiscount);
    // Clearing one needs nobody: it only ever raises what is owed.
    if (pct <= 0) {
      line.discount = null;
      return undefined;
    }
    // A refund line: what goes back is what was paid, not a negotiated figure.
    if (line.refund) return refuse('discount_refused', WORDS.lineNoDiscount);
    const p = this.svc.tillCatalogData().products.find((x) => x.id === line.productId);
    // "לא מקבל הנחות": said, not silently ignored — and no manager is asked for.
    if (p?.noDiscount) return refuse('discount_refused', WORDS.lineNoDiscount, { title: WORDS.noDiscountTitle });
    return this.withDiscountAuthority(pct, () => {
      line.discount = { type: 'percentage', value: pct * 100 };
      return undefined;
    });
  }

  /**
   * Give a discount if this operator may, and otherwise ask a manager first (withDiscountAuthority): DISCOUNT at the rate —
   * a role allowed up to X% acts alone only within it; only an approver whose own ceiling covers the rate may approve. Named
   * on the sale document: the operator acting alone, or the manager whose code was typed.
   */
  private withDiscountAuthority(percent: number | null, apply: () => unknown, force = false) {
    return this.gate(
      PERM.DISCOUNT,
      (approver) => {
        const value = apply();
        this.discountApprover = approver ? approver.id : this.cashier!.id;
        return value;
      },
      { percent, ...(force ? { force: true } : {}) },
    );
  }

  private basketDiscountInput(modeRaw: unknown, inputRaw: unknown): { mode: BasketDiscountMode; input: string } {
    const mode = modeRaw === 'percent' || modeRaw === 'fixed' || modeRaw === 'target' ? modeRaw : refuse('invalid_args');
    if (typeof inputRaw !== 'string' || inputRaw.length > 12) return refuse('invalid_args');
    return { mode, input: inputRaw };
  }

  /** What a keyed basket discount would do, the way the cart will compute it. */
  private basketPreview(mode: BasketDiscountMode, input: string): BasketDiscountPreview {
    const p = this.priced();
    // payableBeforeBasketDiscount: what the basket comes to with its current basket discount taken back.
    return basketDiscountPreview(mode, input, p.netAgorot + (p.basketDiscountAgorot ?? 0), p.nonDiscountableAgorot);
  }

  private discountPreview(modeRaw: unknown, inputRaw: unknown) {
    this.signedIn();
    const { mode, input } = this.basketDiscountInput(modeRaw, inputRaw);
    return this.basketPreview(mode, input);
  }

  /**
   * "הנחה לחשבון" (applyBasketDiscount): a fixed amount over what is owed is refused, never clamped in silence; the rate
   * (as keyed, or the amount over the basket) is what DISCOUNT's ceiling is held to.
   */
  private applyBasketDiscount(modeRaw: unknown, inputRaw: unknown) {
    this.editable();
    const { mode, input } = this.basketDiscountInput(modeRaw, inputRaw);
    if (this.cart.filter((l) => !l.refund).length === 0) return refuse('cart_empty');
    const preview = this.basketPreview(mode, input);
    if (!preview.canApply) return refuse('discount_refused', preview.exceedsBasket ? WORDS.basketDiscountExceeds : TILL_ERROR_DISCOUNT);
    const rate = basketDiscountRate(mode, input, preview);
    const committed = committedBasketDiscount(mode, input, preview);
    if (!committed) return refuse('discount_refused', TILL_ERROR_DISCOUNT);
    return this.withDiscountAuthority(rate, () => {
      this.cartDiscount = committed;
      return undefined;
    });
  }

  /* ---------------------------------------------------------- preset discounts */

  /**
   * "הנחות קבועות" as this till's merged settings set them (cached with the settings: offline too). None configured — none
   * offered, as before.
   */
  private presetDiscounts(): ResolvedPresets {
    const s = this.svc.settingsMap();
    return resolvePresetDiscounts(s[PRESET_DISCOUNTS_KEY], s[PRESET_DISCOUNT_BUTTONS_KEY]);
  }

  /**
   * A preset's one tap (P:/specs/preset-discounts.md §3): it REPLACES whatever basket discount there is (the tap is the
   * decision); the same preset again takes it off. Held to DISCOUNT at its rate like the keyed basket discount — the same
   * manager approval — and `requiresManager` always asks one. Over the lines that take discounts only; an amount larger than
   * they come to is capped, never refused.
   */
  private applyPresetDiscount(a: Record<string, unknown>) {
    this.editable();
    const id = typeof a.presetId === 'string' && a.presetId.trim() && a.presetId.length <= PRESET_ID_MAX ? a.presetId.trim() : refuse('invalid_args');
    if (this.cartDiscount?.preset?.id === id) {
      // Taking it off only ever raises what is owed: nobody is asked.
      this.cartDiscount = null;
      return undefined;
    }
    const preset = this.presetDiscounts().presets.find((p) => p.id === id);
    if (!preset) return refuse('discount_refused', WORDS.presetGone);
    if (this.cart.filter((l) => !l.refund).length === 0) return refuse('cart_empty');
    const whom = presetForOf(preset, { for: a.for, forKind: a.forKind, forRef: a.forRef });
    if (whom === 'required') return refuse('invalid_args', WORDS.presetForRequired);
    const p = this.priced();
    // The sale lines after their own discounts, with no basket discount (what the cart takes it over).
    const payable = p.totals.totalAgorot + (p.basketDiscountAgorot ?? 0);
    const r = applyPreset(payable, p.nonDiscountableAgorot, preset.kind, preset.value);
    const committed = presetCartDiscount(preset);
    if (!r.canApply || !committed) return refuse('discount_refused', WORDS.presetNothingToDiscount);
    const mark: PresetMark = { id: preset.id, name: preset.name, kind: preset.kind, ...whom };
    return this.withDiscountAuthority(
      r.ratePercent,
      () => {
        this.cartDiscount = { ...committed, preset: mark };
        return undefined;
      },
      preset.requiresManager,
    );
  }

  /** The presets the screens offer (absent: none configured — nothing shows); the employees when one picks from them. */
  private presetDiscountsView(): PresetDiscountsState | null {
    const r = this.presetDiscounts();
    if (r.presets.length === 0) return null;
    const employees = r.presets.some((p) => p.forWhom !== 'none' && p.forWhomSource === 'employees')
      ? loginCandidates(this.roster(), this.shop()).map((u) => ({ id: u.id, name: displayName(u) }))
      : [];
    return {
      items: r.presets.map((p) => ({ id: p.id, name: p.name, kind: p.kind, value: p.value, color: p.color, requiresManager: p.requiresManager, forWhom: p.forWhom, forWhomSource: p.forWhomSource })),
      buttons: r.buttons,
      ...(employees.length > 0 ? { employees } : {}),
    };
  }

  /** The sale document's basket discount: its money, rate and kind ("preset" with the preset's mark). */
  private basketDocField(f: { basketDiscountAgorot?: number; basketDiscount?: CartDiscount | null }) {
    const kind = basketDiscountKindOf(f.basketDiscountAgorot ?? 0);
    if (!kind) return {};
    const preset = f.basketDiscount?.preset ?? null;
    return { basketDiscount: { agorot: f.basketDiscountAgorot!, percent: basketDiscountPercentOf(f.basketDiscountAgorot ?? 0, f.basketDiscount), kind: preset ? KIND_PRESET : kind, ...(preset ? { preset } : {}) } };
  }

  /* --------------------------------------------------------------------- OTH */

  /** "OTH": the lines picked given free with the reason — after a manager's code when one is needed (OthAuthority). */
  private othConfirm(idsRaw: unknown, reasonRaw: unknown) {
    this.editable();
    const settings = othSettingsOf(this.svc.cloud.parameters());
    if (!settings.enabled) return refuse('permission_denied', WORDS.othDisabled);
    if (!Array.isArray(idsRaw) || idsRaw.length === 0 || idsRaw.some((x) => typeof x !== 'string')) return refuse('invalid_args');
    const reason = typeof reasonRaw === 'string' ? reasonRaw.trim().slice(0, 100) : '';
    if (!reason) return refuse('invalid_args');
    const products = new Map(this.svc.tillCatalogData().products.map((p) => [p.id, p] as const));
    const picked = (idsRaw as string[]).map((id) => this.cart.find((l) => l.lineId === id)).filter((l): l is CartRec => !!l);
    for (const l of picked) {
      const refusal = othRefusal({ refund: !!l.refund, noDiscount: products.get(l.productId)?.noDiscount === true, oth: l.oth ?? null });
      if (refusal === 'no_discount') return refuse('discount_refused', WORDS.othRefusedNoDiscount(products.get(l.productId)?.name ?? l.name ?? ''));
    }
    const lines = picked.filter((l) => othRefusal({ refund: !!l.refund, noDiscount: products.get(l.productId)?.noDiscount === true, oth: l.oth ?? null }) === null);
    if (lines.length === 0) return refuse('discount_refused', WORDS.othNoneEligible);
    // What the lines are worth (their full price): OTH's ceiling holds to it.
    const view = this.priced();
    const worth = lines.reduce((s, l) => {
      const sl = view.lines.find((x) => x.key === l.lineId);
      return s + (sl ? lineGross(sl) : 0);
    }, 0);
    const decision = othDecide(this.profile(), settings.requiresManager, worth / 100);
    const give = (approver: Approver | null) => {
      const op = this.cashier!;
      const mark: OthMark = approver
        ? { reason, by: op.id, approvedBy: approver.id, approverName: approver.name }
        : settings.requiresManager
          ? // A manager at the till approves themselves.
            { reason, by: op.id, approvedBy: op.id, approverName: displayName(op) }
          : { reason, by: op.id, approvedBy: null, approverName: null };
      for (const l of lines) {
        l.oth = mark;
        l.discount = null;
      }
      if (mark.approvedBy) this.discountApprover = mark.approvedBy;
      return undefined;
    };
    if (decision.kind === 'denied') return refuse('permission_denied', deniedText('OTH', decision.why));
    if (decision.kind === 'allowed') return give(null);
    const need = othNeed(decision);
    return this.gate('OTH', give, {
      decision,
      amount: need.amount,
      approveCode: need.code,
      title: WORDS.othTitle,
      body: decision.why === 'over_limit' ? WORDS.othOver(sh(worth)) : approvalText(decision),
    });
  }

  /** "בטל OTH": the line back at its price — approved like the OTH was (on the discount, no amount). */
  private othUndo(lineId: string) {
    this.editable();
    const line = this.cart.find((l) => l.lineId === lineId);
    if (!line || !line.oth) return refuse('invalid_args');
    const settings = othSettingsOf(this.svc.cloud.parameters());
    const decision = othDecide(this.profile(), settings.requiresManager, null);
    const undo = () => {
      line.oth = null;
      line.discount = null;
      return undefined;
    };
    if (decision.kind === 'denied') return refuse('permission_denied', deniedText('OTH', decision.why));
    if (decision.kind === 'allowed') return undo();
    const need = othNeed(decision);
    return this.gate('OTH', undo, { decision, approveCode: need.code, title: WORDS.othUndoTitle });
  }

  /* ----------------------------------------------------- refunds: the sell screen */

  /**
   * The one "זיכוי" button (refundButton → withRefundAuthority): REFUND — the operator's own, or a manager's code; the
   * approval is HELD for the basket and spent when it is paid. Then the two ways in ("זיכוי פריט מהקטלוג" / "זיכוי מקבלה").
   * On: "סיום זיכוי".
   */
  private refundButton() {
    this.editable();
    if (this.refundMode) {
      this.refundMode = false;
      this.refundChooser = false;
      return undefined;
    }
    const decision = decide(this.profile(), PERM.REFUND);
    if (decision.kind === 'allowed' || this.refundGrant) {
      this.refundChooser = true;
      return undefined;
    }
    return this.gate(PERM.REFUND, (approver) => {
      if (approver) {
        const u = this.roster().find((x) => x.id === approver.id);
        if (u) this.refundGrant = { approverId: approver.id, profile: profileOf(u) };
      }
      this.refundChooser = true;
      return undefined;
    });
  }

  /** "קבלות אחרונות": the most recent sales that may still have something to credit. */
  private recentReceipts() {
    this.signedIn();
    return this.svc.ledger.recentRefundable(RECENT_RECEIPTS).map((d) => this.receiptRow(d));
  }

  private receiptRow(d: DocDraft) {
    return { transactionId: d.id, number: formatDocNumber(d.prefix, String(d.number)), at: d.createdAt, documentType: d.documentType, totalAgorot: d.totals.totalAgorot };
  }

  /**
   * The receipt the customer brought (findReceipt): the full number (`20000057`) or a short one (`57`). Each type has its
   * own series, so a number may name more than one sale: then they are listed and the cashier picks — never the first.
   */
  private findReceipt(queryRaw: unknown) {
    this.signedIn();
    const text = typeof queryRaw === 'string' ? queryRaw.replace(/[\u2013\u2014\u05BE]/g, '-').replace(/[^0-9-]/g, '').slice(0, 16) : '';
    const q = parseDocQuery(text);
    if (!q) return { notFound: true, message: WORDS.receiptNotFound(text) };
    const found = this.svc.ledger.refundableByNumbers(docQueryNumbers(q)).filter((d) => docQueryMatches(q, d.number, d.prefix));
    if (found.length === 0) return { notFound: true, message: WORDS.receiptNotFound(text) };
    if (found.length > 1) return { notFound: false, message: WORDS.receiptMatches, matches: found.map((d) => this.receiptRow(d)) };
    return { notFound: false, ...this.pickReceipt(found[0].id) };
  }

  /** A receipt's lines: what is left on each (this cart's own picks included) and what the customer paid per unit. */
  private pickReceipt(transactionId: string) {
    this.signedIn();
    const tx = this.svc.ledger.doc(transactionId);
    if (!tx || !isSaleType(tx.documentType) || !settled(tx)) return refuse('invalid_args');
    const items = refundItemsOf(tx);
    const prior = this.priorRefundItems(tx.id);
    const already = alreadyRefunded(items, prior);
    const collected = collectedPerLine(items, tx.totals.discountAgorot);
    const lines: RefundableLine[] = items.map((it, i) => {
      const inCart = this.cart.filter((l) => l.receipt?.itemId === it.id).reduce((s, l) => s + l.qty, 0);
      return {
        itemId: it.id,
        productId: it.productId,
        name: tx.lines[i].name,
        originalQty: it.quantity,
        remainingQty: Math.max(0, it.quantity - (already.get(it.id) ?? 0) - inCart),
        unitNetAgorot: it.quantity > 0 ? Math.round((collected.get(it.id) ?? 0) / it.quantity) : 0,
        inCart,
      };
    });
    return { document: this.receiptRow(tx), lines };
  }

  /**
   * The receipt picker's "הוסף": the picked lines go in as returns (addFromReceipt) — capped by what is left on each line,
   * this cart's own picks included. Not behind the sale's gates: the picker opens only behind the refund's own authority.
   */
  private addFromReceipt(transactionId: string, quantitiesRaw: unknown) {
    this.editable();
    if (!this.refundChooser && !this.refundMode && !this.refundGrant && decide(this.profile(), PERM.REFUND).kind !== 'allowed') return refuse('permission_denied', TEXT.denied(PERM.REFUND));
    const tx = this.svc.ledger.doc(transactionId);
    if (!tx || !isSaleType(tx.documentType) || !settled(tx)) return refuse('invalid_args');
    if (!quantitiesRaw || typeof quantitiesRaw !== 'object' || Array.isArray(quantitiesRaw)) return refuse('invalid_args');
    const items = refundItemsOf(tx);
    const prior = this.priorRefundItems(tx.id);
    const already = alreadyRefunded(items, prior);
    const collected = collectedPerLine(items, tx.totals.discountAgorot);
    const number = formatDocNumber(tx.prefix, String(tx.number));
    let added = 0;
    for (const [itemId, q] of Object.entries(quantitiesRaw as Record<string, unknown>)) {
      if (!isInt(q, 0, MAX_QTY)) return refuse('invalid_args');
      if ((q as number) <= 0) continue;
      const i = items.findIndex((x) => x.id === itemId);
      if (i < 0) return refuse('invalid_args');
      const item = items[i];
      const maxQty = Math.max(0, item.quantity - (already.get(item.id) ?? 0));
      const existing = this.cart.find((l) => l.receipt?.itemId === item.id);
      if (existing) {
        const capped = Math.min(existing.qty + (q as number), maxQty);
        if (capped > existing.qty) {
          existing.qty = capped;
          added += 1;
        }
        continue;
      }
      const capped = Math.min(q as number, maxQty);
      if (capped <= 0) continue;
      this.lineSeq += 1;
      this.cart.push({
        lineId: `l${this.lineSeq}`,
        productId: item.productId,
        qty: capped,
        refund: true,
        name: tx.lines[i].name,
        receipt: {
          transactionId: tx.id,
          itemId: item.id,
          documentNumber: number,
          originalQty: item.quantity,
          alreadyRefunded: already.get(item.id) ?? 0,
          collectedAgorot: collected.get(item.id) ?? 0,
          unitAgorot: item.unitAgorot,
          line: tx.lines[i],
          tracked: tx.tracked.includes(item.productId),
        },
      });
      added += 1;
    }
    if (added === 0) return refuse('refund_refused', WORDS.refundNothingLeft);
    // A receipt pick is a one-off: the next catalog tap is still a sale (the refund mode stays as it was).
    this.refundChooser = false;
    return undefined;
  }

  /** Line items across every credit note already issued against [originalId] (cancelled ones are not). */
  private priorRefundItems(originalId: string): RefundItem[] {
    return this.svc.ledger
      .refundsOf(originalId)
      .filter((d) => d.status !== 'cancelled')
      .flatMap((d) =>
        d.lines.map((l, i) => ({
          id: d.itemIds[i],
          productId: l.productId,
          quantity: l.qty,
          unitAgorot: unitAgorot(l),
          refundOfItemId: l.refundOfItemId ?? null,
        })),
      );
  }

  /* ------------------------------------------------------- refunds: the history */

  /** "זיכוי" from the history (DetailViewModel.reload): the document's lines, what is left on each, how the money goes back. */
  private documentDetail(documentId: string, quantitiesRaw?: unknown): DocumentDetail {
    this.signedIn();
    const tx = this.svc.ledger.doc(documentId);
    if (!tx) return refuse('invalid_args');
    const items = refundItemsOf(tx);
    const prior = isSaleType(tx.documentType) ? this.priorRefundItems(tx.id) : [];
    const remaining = remainingQuantities(items, prior);
    const already = alreadyRefunded(items, prior);
    const collected = collectedPerLine(items, tx.totals.discountAgorot);
    const credit = isCreditType(tx.documentType);
    const lines: RefundableLine[] = items.map((it, i) => ({
      itemId: it.id,
      productId: it.productId,
      name: tx.lines[i].name,
      originalQty: it.quantity,
      remainingQty: credit ? 0 : (remaining.get(it.id) ?? 0),
      unitNetAgorot: it.quantity > 0 ? Math.round((collected.get(it.id) ?? 0) / it.quantity) : 0,
    }));
    const all = credit ? 0 : refundLines(items, remaining, tx.totals.discountAgorot, already).reduce((s, l) => s + l.totalAgorot, 0);
    let selected: number | undefined;
    if (!credit && quantitiesRaw && typeof quantitiesRaw === 'object' && !Array.isArray(quantitiesRaw)) {
      const picks = new Map<string, number>();
      for (const [id, q] of Object.entries(quantitiesRaw as Record<string, unknown>)) if (isInt(q, 0, MAX_QTY) && remaining.has(id)) picks.set(id, Math.min(q as number, remaining.get(id) ?? 0));
      selected = refundLines(items, picks, tx.totals.discountAgorot, already).reduce((s, l) => s + l.totalAgorot, 0);
    }
    return {
      id: tx.id,
      ref: formatDocNumber(tx.prefix, String(tx.number)),
      documentType: tx.documentType,
      status: tx.status,
      totalAgorot: tx.totals.totalAgorot,
      cashier: tx.cashierName,
      at: tx.createdAt,
      methods: legsOf(tx).map((l) => l.method),
      lines,
      isRefundDocument: credit,
      anythingRefundable: !credit && settled(tx) && lines.some((l) => l.remainingQty > 0),
      refundMethod: this.historyRefundMethod(tx),
      refundAllAgorot: all,
      ...(selected !== undefined ? { selectedAgorot: selected } : {}),
    };
  }

  /**
   * The tender a credit from the history gives back (historyRefundTender): the original sale's (its last real leg; none:
   * cash). A card sale on a till "ללא אשראי" is credited in cash — never to the card here.
   */
  private historyRefundMethod(tx: DocDraft): 'cash' | 'card' {
    const legs = legsOf(tx).filter((l) => l.method !== EXCHANGE);
    const method = legs.length > 0 ? legs[legs.length - 1].method : tx.card ? 'card' : 'cash';
    return method === 'card' && !this.svc.pay.noCard ? 'card' : 'cash';
  }

  /**
   * "בצע זיכוי" (DetailViewModel.refund): a credit note — a NEW document (330, or −400), linked to the original — for the
   * picked quantities, the original never rewritten. In the Android order: nothing picked, no shift, then the refund gate
   * (a card refund with no acquirer reference refused before any approval is spent; REFUND at the credited sum — a manager
   * whose own refund limit covers it), then the money: a card refund is written PENDING before the terminal is asked (a
   * decline voids it), a cash one completed and the drawer opened.
   */
  private historyRefund(documentId: string, quantitiesRaw: unknown) {
    this.editable();
    const tx = this.svc.ledger.doc(documentId);
    if (!tx || isCreditType(tx.documentType) || !isSaleType(tx.documentType) || !settled(tx)) return refuse('refund_refused', WORDS.refundNothingLeft);
    const items = refundItemsOf(tx);
    const prior = this.priorRefundItems(tx.id);
    const remaining = remainingQuantities(items, prior);
    const already = alreadyRefunded(items, prior);
    // The screen's picks, clamped to what is still refundable; absent: everything that is left (the common case).
    const picks = new Map<string, number>();
    if (quantitiesRaw === undefined) for (const [id, q] of remaining) picks.set(id, q);
    else {
      if (!quantitiesRaw || typeof quantitiesRaw !== 'object' || Array.isArray(quantitiesRaw)) return refuse('invalid_args');
      for (const [id, q] of Object.entries(quantitiesRaw as Record<string, unknown>)) {
        if (!isInt(q, 0, MAX_QTY) || !remaining.has(id)) return refuse('invalid_args');
        picks.set(id, Math.min(q as number, remaining.get(id) ?? 0));
      }
    }
    const lines = refundLines(items, picks, tx.totals.discountAgorot, already);
    if (lines.length === 0) return refuse('refund_refused', WORDS.refundSelectItems);
    const shift = this.svc.ledger.currentShift();
    if (!shift && !this.shiftsHidden()) return refuse('shift_not_open', WORDS.refundNoShift);
    const method = this.historyRefundMethod(tx);
    const credited = creditedShekels(lines);
    const originalTxnId = method === 'card' ? acquirerTransactionIdOf(tx.card?.meta ?? null) : null;
    // RefundGate.MISSING_CARD_REFERENCE: before the approval is spent.
    if (method === 'card' && !originalTxnId) return refuse('refund_refused', WORDS.refundCardMissingOriginal);
    if (method === 'card' && !this.svc.pay.refundsSupported) return refuse('terminal_unavailable', WORDS.refundNotSupported);
    const fullyRefunded = items.every((it) => (remaining.get(it.id) ?? 0) - (picks.get(it.id) ?? 0) <= 1e-9);
    return this.gate(
      PERM.REFUND,
      (approver) => {
        if (!this.ensureShift()) return refuse('shift_not_open', WORDS.refundNoShift);
        const creditLines: SaleLine[] = lines.map((rl) => {
          const i = items.findIndex((x) => x.id === rl.sourceItemId);
          return { ...tx.lines[i], key: randomUUID(), qty: rl.quantity, creditAgorot: rl.totalAgorot, refundOfItemId: rl.sourceItemId, promotionAgorot: undefined, voucherAgorot: undefined, discountAgorot: undefined, oth: undefined, voucherMark: undefined };
        });
        const amount = lines.reduce((s, l) => s + l.totalAgorot, 0);
        const docType = creditDocumentType(this.svc.business().dealerType, tx.documentType);
        const doc: BasketDocInput = {
          documentType: docType,
          lines: creditLines,
          tracked: creditLines.filter((l) => tx.tracked.includes(l.productId)).map((l) => l.productId),
          totals: creditTotals(creditLines, vatRateForType(docType, this.svc.vatRate())),
          payments: [{ method, amountAgorot: amount }],
          // What went back to the customer: recorded like a sale's tender; a refund gives no change.
          tenderedAgorot: amount,
          changeAgorot: 0,
          refundOfTransactionId: tx.id,
          fullyRefunded,
          approvedByPosUserId: approver ? approver.id : this.cashier!.id,
        };
        const written = this.svc.ledger.recordBasket(
          { prefix: this.prefix(), branchId: this.svc.business().branchId, operator: this.operator(), basketId: null, documents: [doc] },
          method === 'card' ? 'pending' : 'completed',
        );
        if (!written) return refuse('shift_not_open', WORDS.refundNoShift);
        if (!Array.isArray(written)) return refuse('basket_changed', written.refused);
        const creditDoc = written[0];
        if (method === 'cash') {
          this.refundDrawer(creditDoc);
          this.svc.printDocReceipt(creditDoc, false);
          void this.svc.sync.flush();
          this.toast(WORDS.refundDone, 'ok');
          return { documentId: creditDoc.id, ref: formatDocNumber(creditDoc.prefix, String(creditDoc.number)) };
        }
        void this.runHistoryCardRefund(creditDoc, amount, originalTxnId!);
        return { documentId: creditDoc.id, ref: formatDocNumber(creditDoc.prefix, String(creditDoc.number)), pending: true };
      },
      { amount: credited },
    );
  }

  /** runCardRefund: one frame; approved completes the pending credit note, anything else voids it (nothing went back). */
  private async runHistoryCardRefund(creditDoc: DocDraft, amount: number, originalTxnId: string) {
    const outcome = await this.svc.pay.refund({ transactionId: creditDoc.id, amountAgorot: amount, originalTransactionId: originalTxnId, record: false });
    await this.later(() => {
      if (outcome.kind === 'approved') {
        const done = this.svc.ledger.completeCardSale(creditDoc.id, outcome.card);
        if (done) this.svc.printDocReceipt(done, false);
        this.toast(WORDS.refundDone, 'ok');
      } else {
        this.svc.ledger.voidCardSale(creditDoc.id, null);
        this.toast(outcome.kind === 'declined' || outcome.kind === 'unknown' ? outcome.message : WORDS.noPaymentOptions, 'error');
      }
      void this.svc.sync.flush();
      this.dirty = true;
      this.commit();
    });
  }

  /**
   * "מגירת מזומן": cash handed back on a credit note opens the drawer — through the drawer service only (spec §13: its rules,
   * its audit, `cashDrawer` off opens nothing), under the refund's own approval: the manager who approved the refund is not
   * asked again, and is named in the drawer's log.
   */
  private refundDrawer(...credits: DocDraft[]) {
    const cashOf = (d: DocDraft) =>
      legsOf(d)
        .filter((l) => l.method === 'cash')
        .reduce((sum, l) => sum + l.amountAgorot, 0);
    const credit = credits.find((d) => cashOf(d) > 0);
    const cash = credits.reduce((sum, d) => sum + cashOf(d), 0);
    if (!credit || cash <= 0) return;
    const by = credit.approvedByPosUserId && credit.approvedByPosUserId !== this.cashier?.id ? credit.approvedByPosUserId : null;
    void Promise.resolve(this.drawer.afterRefund({ id: credit.id, documentType: credit.documentType, number: credit.number }, cash, by)).catch((e: unknown) => this.log(`cash drawer: ${String(e)}`));
  }

  /* ---------------------------------------------------------------- checkout */

  /** "נוכחות": selling waits for the clock-in / the end of the break (Android blocks the sale behind its card). */
  private attendanceGate() {
    const why = this.attendance?.sellRefusal();
    if (why) refuse('attendance_required', why);
  }

  private checkoutStart() {
    this.signedIn();
    this.attendanceGate();
    if (this.cart.length === 0) refuse('cart_empty');
    if (this.checkout.phase !== 'idle') refuse('checkout_busy');
    if (!this.svc.ledger.currentShift() && !this.shiftsHidden()) refuse('shift_not_open', WORDS.noShiftBlocksSale);
    // "פרטי הזמנה": an order reaching the payment without them is asked first, whatever "מתי לשאול" says.
    if (this.orderDetailsMissing()) {
      this.orderAsk = 'payment';
      return { orderDetails: true };
    }
    const p = this.priced();
    if (p.gone.length > 0) {
      // What the catalog no longer sells leaves the cart; the cashier looks again.
      this.cart = this.cart.filter((l) => !p.gone.includes(l.lineId));
      this.toast('חלק מהפריטים כבר לא נמכרים והוסרו מהסל', 'error');
      return undefined;
    }
    const frozen: Frozen = { lines: p.lines, tracked: p.tracked, promotions: p.promotions, totals: p.totals, basketDiscountAgorot: p.basketDiscountAgorot, basketDiscount: p.basketDiscount, refunds: p.refunds };
    // A payment starts with no voucher (an earlier one's were given back or confirmed).
    this.vouchers.clear();
    if (p.refunds.length > 0) {
      // A basket with returns: who the money goes back to first (RETURN_CUSTOMER), then by the net.
      const hasUnlinked = p.refunds.some((r) => !r.rec.receipt);
      const params = this.svc.cloud.parameters();
      const basket: BasketRec = {
        saleAgorot: p.saleTotalAgorot,
        refundAgorot: p.refundTotalAgorot,
        netAgorot: p.netAgorot,
        hasUnlinked,
        step: 'return_customer',
        customer: { name: '', phone: '', address: '' },
        customerRequired: returnCustomerRequired(hasUnlinked, onUnlessFalse(params[REFUND_CUSTOMER_DETAILS_PARAM])),
        route: p.netAgorot < 0 ? this.payoutRouteOf(-p.netAgorot, p.refunds) : { kind: 'unavailable' },
        handedBackAgorot: 0,
      };
      this.checkout = { ...idleCheckout(), phase: 'tender', totalAgorot: Math.max(0, p.netAgorot), frozen, basket, token: randomUUID() };
      return undefined;
    }
    if (p.totals.totalAgorot < 1 && !p.lines.some((l) => l.oth)) return refuse('cart_empty');
    this.checkout = { ...idleCheckout(), phase: 'tender', totalAgorot: p.totals.totalAgorot, frozen, token: randomUUID() };
    return undefined;
  }

  /* ---------------------------------------------------------------- vouchers */

  /** The payment open for vouchers (tillVouchers.ts), or why not: before any money was taken, never in a basket with returns. */
  private voucherPayment() {
    const c = this.checkout;
    if (c.phase !== 'tender' || !c.frozen) return { refused: VOUCHER_TEXT.addItemsFirst };
    if (c.basket) return { refused: VOUCHER_TEXT.inBasket };
    if (this.svc.pay.cardInFlight || c.legs.some((l) => l.method !== 'production_voucher')) return { refused: VOUCHER_TEXT.afterTender };
    return { token: c.token, lines: c.frozen.lines, prepaid: c.frozen.prepaid ?? [], saleRef: this.basketId };
  }

  /** The payment priced again with its vouchers as they stand: its lines, its total, the "שוברי הפקה" legs first. */
  private repriceForVouchers(): string | null {
    const c = this.checkout;
    if (c.phase !== 'tender' || !c.frozen || c.basket) return VOUCHER_TEXT.addItemsFirst;
    const p = this.priced();
    if (p.gone.length > 0) return 'חלק מהפריטים כבר לא נמכרים — חזרו לסל';
    // A kiosk order's tip stays on top of the goods whatever the vouchers do.
    const tip = Math.max(0, c.kioskOrder?.tipAgorot ?? 0);
    const totals = tip > 0 ? { ...p.totals, tipAgorot: tip, chargeAgorot: p.totals.totalAgorot + tip } : p.totals;
    c.frozen = {
      lines: p.lines,
      tracked: p.tracked,
      promotions: p.promotions,
      totals,
      basketDiscountAgorot: p.basketDiscountAgorot,
      basketDiscount: p.basketDiscount,
      refunds: p.refunds,
      ...(p.voucherOutcomes ? { voucherOutcomes: p.voucherOutcomes } : {}),
      ...(p.prepaid ? { prepaid: p.prepaid, voucherLegs: p.voucherLegs } : {}),
    };
    c.totalAgorot = totals.chargeAgorot;
    c.legs = [
      ...c.legs.filter((l) => l.external),
      ...(p.voucherLegs ?? []).filter((l) => l.amountAgorot > 0).map((l) => ({ method: 'production_voucher' as const, amountAgorot: l.amountAgorot, handedAgorot: 0, voucher: l.voucher, status: 'approved' as const })),
      ...c.legs.filter((l) => l.method !== 'production_voucher'),
    ];
    this.dirty = true;
    return null;
  }

  /**
   * A voucher applied and nothing left to pay: the sale closes by itself (`voucherAutoClose`, on unless said off) — never a
   * simulation, and never while a voucher still gives the customer something (the cashier offers it first).
   */
  private afterVoucher() {
    const c = this.checkout;
    if (c.phase !== 'tender' || dueOf(c.totalAgorot, this.approvedLegs()) > 0) return;
    if (this.vouchers.simulation()) return;
    const raw = String(this.svc.cloud.parameters().voucherAutoClose ?? this.svc.settingsMap().voucherAutoClose ?? '').trim().toLowerCase();
    if (['off', 'false', '0', 'no'].includes(raw)) return;
    if (this.vouchers.production.some((a) => a.entitlement)) return;
    try {
      this.closeKind = 'auto';
      this.closeSettled();
    } catch (e) {
      this.log(`voucher auto close: ${String(e)}`);
    } finally {
      this.closeKind = null;
    }
  }

  /** How the sale being closed now was closed (the success screen's rule): by itself, the cashier's tap, or with money. */
  private closeKind: VoucherCloseKind | null = null;

  /**
   * "מסך הצלחה במימוש שובר" (`voucherSuccessScreen`, voucherSuccessFor): a sale that redeemed vouchers — what was redeemed, and
   * what the customer did not take (the close's words). Read before the vouchers are let go.
   */
  private voucherSuccessNow(kind: VoucherCloseKind): CheckoutRec['voucherSuccess'] {
    const v = this.vouchers;
    const f = this.checkout.frozen;
    const discounts = (f?.voucherOutcomes ?? []).filter((o) => o.amountAgorot > 0);
    const count = v.production.filter((a) => !a.testMode).length + discounts.length;
    const mode = voucherSuccessModeOf(this.svc.cloud.parameters().voucherSuccessScreen ?? this.svc.settingsMap().voucherSuccessScreen);
    if (!voucherSuccessShows(mode, count > 0, kind)) return null;
    const items = v.production.reduce((s, a) => s + a.units.length, 0);
    const off = discounts.reduce((s, o) => s + o.amountAgorot, 0);
    const success = voucherSuccessOf(count, items, off);
    const left = v.production.map((a) => voucherLeftOf(a)).filter((x): x is NonNullable<typeof x> => !!x);
    const close = voucherCloseMessages(left, new Date(this.nowFn()));
    return { ...success, notTaken: close?.notTaken ?? null, note: close?.note ?? null };
  }

  /** The vouchers (and cash credits) paid it all: the document now — no cash handed over, no change, no drawer. */
  private closeSettled() {
    const f = this.checkout.frozen!;
    if (!this.ensureShift()) return refuse('shift_not_open', WORDS.shiftNone);
    // No leg at all (a ₪0 voucher sale, a deduction of everything): one ₪0 cash leg, as "סגור עסקה" of a ₪0 sale writes.
    const approved = this.approvedLegs();
    const legs: TenderLeg[] = approved.length > 0 ? approved : [{ method: 'cash', amountAgorot: 0, handedAgorot: 0 }];
    const doc = this.svc.ledger.recordCashSale({
      documentType: saleDocumentType(this.svc.business().dealerType),
      prefix: this.prefix(),
      branchId: this.svc.business().branchId,
      operator: this.operator(),
      orderId: null,
      lines: f.lines,
      tracked: f.tracked,
      totals: f.totals,
      promotions: f.promotions,
      payments: docLegs(legs),
      creditLegs: creditLegsOf(legs),
      tenderedAgorot: 0,
      changeAgorot: 0,
      channel: 'till',
      ...this.voucherDocFields(f),
      ...(this.discountApprover && f.totals.discountAgorot > 0 ? { approvedByPosUserId: this.discountApprover } : {}),
    });
    if (!doc) return refuse('shift_not_open', WORDS.shiftNone);
    this.finalize(doc);
    return undefined;
  }

  /** What the document keeps of the payment's vouchers: the discount ones (and the holds given back), the production ones. */
  private voucherDocFields(f: Frozen): Pick<DocDraft, 'voucherDiscounts' | 'voucherReleases' | 'prepaidVouchers'> {
    if (f.restoredVouchers) return f.restoredVouchers;
    const outcomes = f.voucherOutcomes ?? [];
    const taken = docVoucherDiscounts(outcomes);
    const released = outcomes.filter((o) => o.amountAgorot <= 0).map((o) => o.voucher.reservationId);
    return {
      ...(taken.length > 0 ? { voucherDiscounts: taken } : {}),
      ...(released.length > 0 ? { voucherReleases: released } : {}),
      ...(f.prepaid && f.prepaid.length > 0 ? { prepaidVouchers: f.prepaid } : {}),
    };
  }

  /** "מצב בדיקה": no real money in a test voucher's sale. */
  private noRealMoneyInTest() {
    if (this.vouchers.simulation()) refuse('voucher_refused', VOUCHER_TEST_TEXT.mixed);
  }

  /**
   * "סגירה עכשיו — מה שלא מומש מהשובר יאבד (…)": the one confirmation before a close that gives up what a one-sale voucher
   * still gives (VoucherCloseMessages) — then [go] again. Null: nothing to confirm.
   */
  private voucherCloseGate(go: () => unknown): { dialogId: string } | null {
    const text = this.vouchers.closeConfirm(new Date(this.nowFn()));
    if (!text) return null;
    this.openDialog({
      kind: 'confirm',
      title: VOUCHER_TEXT.closeTitle,
      body: text,
      fields: [],
      actions: [
        { id: 'approve', label: VOUCHER_TEXT.close, primary: true },
        { id: 'cancel', label: VOUCHER_TEXT.addItem },
      ],
      code: null,
      resume: () => {
        this.vouchers.closeConfirmed = true;
        return go();
      },
    });
    return { dialogId: this.pending!.dialog.id };
  }

  /** "סיום בדיקה" (CheckoutViewModel.finishTest): what the vouchers would have covered and left to pay — nothing written. */
  private finishTest() {
    this.signedIn();
    const c = this.checkout;
    if (c.phase !== 'tender' || !this.vouchers.simulation()) return refuse('invalid_args');
    const due = dueOf(c.totalAgorot, this.approvedLegs());
    const discount = (c.frozen?.voucherOutcomes ?? []).reduce((s, o) => s + Math.max(0, o.amountAgorot), 0);
    const lines = this.vouchers.testEnd(due, discount);
    // Nothing is confirmed or given back: the cloud consumed nothing (its test answers).
    this.vouchers.clear();
    this.log('voucher test: finished, nothing written');
    this.checkout = { ...idleCheckout(), phase: 'done', totalAgorot: c.totalAgorot, testEnd: lines };
    this.clearBasket();
    return { lines };
  }

  /**
   * A voucher scanned on the sell screen with items in the order: to the payment, where it is applied ("ברגע שהתחיל מימוש,
   * תעביר אותו למסך התשלום") — the payment's own scan.
   */
  private sellVoucher(code: unknown) {
    this.signedIn();
    if (this.checkout.phase === 'tender') return this.vouchers.scan(code);
    if (!this.cart.some((l) => !l.refund)) return refuse('voucher_refused', VOUCHER_TEXT.addItemsFirst);
    if (this.cart.some((l) => l.refund)) return refuse('voucher_refused', VOUCHER_TEXT.inBasket);
    this.checkoutStart();
    // A basket the catalog changed under goes back to the cart (said); else the payment is open now.
    if ((this.checkout.phase as CheckoutRec['phase']) !== 'tender') return undefined;
    return this.vouchers.scan(code);
  }

  /**
   * How a card payout would go (resolvePayoutRoute): linked to the one card original that can take it all — what this
   * basket credits against it, and what that card was charged less its card refunds — else unlinked if the merchant allows.
   */
  private payoutRouteOf(payout: number, refunds: PricedRefund[]): CardPayoutRoute {
    if (this.svc.pay.noCard || !this.svc.pay.refundsSupported) return { kind: 'unavailable' };
    const candidates: LinkCandidate[] = [];
    const originals = [...new Set(refunds.map((r) => r.rec.receipt?.transactionId).filter((x): x is string => !!x))];
    for (const id of originals) {
      const original = this.svc.ledger.doc(id);
      if (!original) continue;
      const credited = refunds.filter((r) => r.rec.receipt?.transactionId === id).reduce((s, r) => s + r.totalAgorot, 0);
      const charged = legsOf(original).filter((l) => l.method === 'card').reduce((s, l) => s + l.amountAgorot, 0);
      const refundedByCard = this.svc.ledger
        .refundsOf(id)
        .filter((d) => d.status !== 'cancelled')
        .flatMap((d) => legsOf(d))
        .filter((l) => l.method === 'card')
        .reduce((s, l) => s + l.amountAgorot, 0);
      candidates.push({ originalId: id, creditedAgorot: credited, cardAgorot: charged - refundedByCard, acquirerTransactionId: acquirerTransactionIdOf(original.card?.meta ?? null) });
    }
    return cardPayoutRoute(payout, candidates, onUnlessFalse(this.svc.cloud.parameters()[UNLINKED_CARD_CREDIT_PARAM]));
  }

  private tenderOpen() {
    if (this.checkout.phase !== 'tender') refuse('invalid_args');
    const b = this.checkout.basket;
    // A basket: the tenders only for a positive net, once its customer is taken down.
    if (b && b.step !== 'tender') refuse('invalid_args');
  }

  private approvedLegs(): TenderLeg[] {
    return this.checkout.legs.filter((l) => l.status === 'approved');
  }

  /** "פרטי הלקוח לזיכוי" (confirmReturnCustomer): required for returns with no receipt, unless the merchant relaxed it. */
  private confirmReturnCustomer(a: Record<string, unknown>) {
    this.signedIn();
    const b = this.checkout.basket;
    if (this.checkout.phase !== 'tender' || !b || b.step !== 'return_customer') return refuse('invalid_args');
    const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
    const name = text(a.name, 255);
    const phone = text(a.phone, 30);
    const address = text(a.address, 500);
    if (b.customerRequired && !returnCustomerComplete(name, phone, address)) return refuse('invalid_args', WORDS.basketCustomerRequired);
    b.customer = { name, phone, address };
    b.step = basketNextStep(b.netAgorot);
    return undefined;
  }

  /**
   * Whether this basket's returns may be issued now, and on whose authority (refundAuthorised): REFUND at what the basket
   * gives back — the operator alone within their limit; a manager's approval held from the refund button while ITS
   * approver's own limit covers the sum; else a manager's code now, for this sum.
   */
  private withRefundAuthority(go: (approverId: string) => unknown) {
    const b = this.checkout.basket;
    if (!b) return go(this.cashier!.id);
    const amount = Math.abs(b.refundAgorot) / 100;
    const own = decide(this.profile(), PERM.REFUND, { amount });
    if (own.kind === 'allowed') return go(this.cashier!.id);
    const grant = this.refundGrant;
    if (grant && mayApprove(grant.profile, PERM.REFUND, amount)) return go(grant.approverId);
    // A grant held from the button that does not cover this basket is spent, not stretched over it.
    this.refundGrant = null;
    return this.gate(
      PERM.REFUND,
      (approver) => go(approver ? approver.id : this.cashier!.id),
      { amount, decision: own.kind === 'denied' ? own : undefined, askOnDeny: false },
    );
  }

  /** The credit notes of the frozen basket, re-priced from each stored original (verifiedCredit); null — one changed. */
  private basketCredits(): { credits: BasketCredit[] } | { changed: true } {
    const f = this.checkout.frozen!;
    const refunds = f.refunds ?? [];
    const credits = basketCreditsOf(
      refunds.map((r) => ({
        key: r.rec.lineId,
        productId: r.line.productId,
        name: r.line.name,
        sku: r.line.sku,
        qty: r.rec.qty,
        unitAgorot: unitAgorot(r.line),
        totalAgorot: r.totalAgorot,
        refundOf: r.rec.receipt ? { transactionId: r.rec.receipt.transactionId, itemId: r.rec.receipt.itemId } : null,
      })),
    );
    const out: BasketCredit[] = [];
    for (const c of credits) {
      if (!c.originalId) {
        out.push(c);
        continue;
      }
      const original = this.svc.ledger.doc(c.originalId);
      if (!original || !isSaleType(original.documentType) || !settled(original)) return { changed: true };
      const items = refundItemsOf(original);
      const prior = this.priorRefundItems(original.id);
      const remaining = remainingQuantities(items, prior);
      const q = new Map<string, number>();
      for (const l of c.lines) q.set(l.sourceItemId!, (q.get(l.sourceItemId!) ?? 0) + l.qty);
      if ([...q].some(([id, n]) => n > (remaining.get(id) ?? 0) + 1e-9)) return { changed: true };
      const repriced = refundLines(items, q, original.totals.discountAgorot, alreadyRefunded(items, prior));
      const bySource = new Map(repriced.map((l) => [l.sourceItemId, l] as const));
      const cartBySource = new Map<string, number>();
      for (const l of c.lines) cartBySource.set(l.sourceItemId!, (cartBySource.get(l.sourceItemId!) ?? 0) + l.totalAgorot);
      if ([...cartBySource].some(([id, total]) => bySource.get(id)?.totalAgorot !== total)) return { changed: true };
      out.push({
        ...c,
        originalDocumentType: original.documentType,
        fullyRefunded: items.every((it) => (remaining.get(it.id) ?? 0) - (q.get(it.id) ?? 0) <= 1e-9),
      });
    }
    return { credits: out };
  }

  /**
   * Every document of the basket (buildBasketDocuments): the sale (if any) and each credit note, their legs as planned —
   * the real legs / the payout on top of the exchange — in one transaction. Null with no shift; `{refused}` when a
   * credited original changed meanwhile.
   */
  private writeBasket(input: { realLegs?: DocLeg[]; payout?: { method: 'cash' | 'card'; onCreditOf?: string | null } | null; tenderedAgorot?: number; changeAgorot?: number; status: 'pending' | 'completed'; refundApprover: string }): DocDraft[] | { refused: string } | null {
    const f = this.checkout.frozen!;
    const b = this.checkout.basket!;
    const verified = this.basketCredits();
    if ('changed' in verified) return { refused: WORDS.basketOriginalChanged };
    const credits = verified.credits;
    const refundsByLine = new Map((f.refunds ?? []).map((r) => [r.rec.lineId, r] as const));
    const hasSale = f.lines.length > 0;
    const dealer = this.svc.business().dealerType;
    let plan;
    try {
      plan = planBasketTenders({
        saleTotalAgorot: hasSale ? f.totals.totalAgorot : 0,
        creditTotals: credits.map(creditTotal),
        creditOriginals: credits.map((c) => c.originalId),
        realLegs: (input.realLegs ?? []).map((l) => ({ method: l.method, amountAgorot: l.amountAgorot }) as Tender),
        payout: input.payout ?? null,
      });
    } catch (e) {
      if (e instanceof BasketMismatch) return { refused: e.message };
      throw e;
    }
    const customer = b.customer.name || b.customer.phone || b.customer.address ? { name: b.customer.name, phone: b.customer.phone || null, address: b.customer.address || null } : null;
    const docs: BasketDocInput[] = [];
    if (hasSale) {
      docs.push({
        documentType: saleDocumentType(dealer),
        lines: f.lines,
        tracked: f.tracked,
        totals: f.totals,
        promotions: f.promotions,
        payments: plan.sale.map((t) => ({ method: t.method, amountAgorot: t.amountAgorot })),
        ...(typeof input.tenderedAgorot === 'number' ? { tenderedAgorot: input.tenderedAgorot, changeAgorot: input.changeAgorot ?? 0 } : {}),
        ...(this.discountApprover && f.totals.discountAgorot > 0 ? { approvedByPosUserId: this.discountApprover } : {}),
        ...this.basketDocField(f),
      });
    }
    credits.forEach((c, i) => {
      const legs = plan.credits[i];
      const paidOut = legs.filter((t) => t.method !== EXCHANGE).reduce((s, t) => s + t.amountAgorot, 0);
      const docType = creditDocumentType(dealer, c.originalDocumentType);
      const lines: SaleLine[] = c.lines.map((cl) => {
        const priced = cl.key ? refundsByLine.get(cl.key) : undefined;
        const base: SaleLine = priced?.line ?? { key: randomUUID(), productId: cl.productId, name: cl.name, sku: cl.sku, basePriceAgorot: cl.unitAgorot, options: [], notes: [], qty: cl.qty };
        return { ...base, qty: cl.qty, creditAgorot: cl.totalAgorot, refundOfItemId: cl.sourceItemId };
      });
      const tracked = (f.refunds ?? []).filter((r) => r.tracked).map((r) => r.line.productId);
      docs.push({
        documentType: docType,
        lines,
        tracked: [...new Set(tracked)],
        totals: creditTotals(lines, vatRateForType(docType, this.svc.vatRate())),
        payments: legs.map((t) => ({ method: t.method, amountAgorot: t.amountAgorot })),
        ...(paidOut > 0 ? { tenderedAgorot: paidOut, changeAgorot: 0 } : {}),
        refundOfTransactionId: c.originalId,
        fullyRefunded: c.fullyRefunded,
        approvedByPosUserId: input.refundApprover,
        ...(customer ? { customer } : {}),
      });
    });
    return this.svc.ledger.recordBasket(
      { prefix: this.prefix(), branchId: this.svc.business().branchId, operator: this.operator(), basketId: this.basketId, documents: docs },
      input.status,
    );
  }

  private async cashTender(amount: unknown): Promise<unknown> {
    this.signedIn();
    this.tenderOpen();
    const total = this.checkout.totalAgorot;
    // The vouchers paid it all ("סגור עסקה וממש שובר"): the document with their legs alone.
    if (amount === 0 && total > 0 && this.approvedLegs().length > 0 && dueOf(total, this.approvedLegs()) === 0 && !this.checkout.basket) {
      this.noRealMoneyInTest();
      const tap = () => {
        this.closeKind = 'tap';
        try {
          return this.closeSettled();
        } finally {
          this.closeKind = null;
        }
      };
      return this.voucherCloseGate(tap) ?? tap();
    }
    // Nothing to pay (VoucherZeroDue: "סגור עסקה" — a ₪0 sale, e.g. every line on the house): closed with no money moved.
    const zero = total === 0 && amount === 0;
    if (!zero && !validCashAmount(amount)) refuse('invalid_args');
    if (!zero) this.noRealMoneyInTest();
    const step = zero
      ? ({ kind: 'complete', leg: { method: 'cash', amountAgorot: 0, handedAgorot: 0 }, legs: [{ method: 'cash', amountAgorot: 0, handedAgorot: 0 }], tenderedAgorot: 0, changeAgorot: 0 } as const)
      : takeCash(total, this.approvedLegs(), amount as number);
    if (step.kind === 'partial') {
      this.checkout.legs.push({ ...step.leg, status: 'approved' });
      return undefined;
    }
    const gate = this.voucherCloseGate(() => this.cashTender(amount));
    if (gate) return gate;
    const f = this.checkout.frozen!;
    if (!this.ensureShift()) return refuse('shift_not_open', WORDS.shiftNone);
    if (this.checkout.basket) {
      // A basket with returns and a positive net: its documents, the cash legs for the net (refundAuthorised first).
      return this.withRefundAuthority((refundApprover) => {
        const written = this.writeBasket({ realLegs: step.legs.map((l) => ({ method: l.method, amountAgorot: l.amountAgorot })), tenderedAgorot: step.tenderedAgorot, changeAgorot: step.changeAgorot, status: 'completed', refundApprover });
        if (!written) return refuse('shift_not_open', WORDS.shiftNone);
        if (!Array.isArray(written)) return refuse('basket_changed', written.refused);
        this.checkout.legs.push({ ...step.leg, status: 'approved' });
        this.finalizeBasket(written, { changeAgorot: step.changeAgorot, tenderedAgorot: step.tenderedAgorot, handBack: 0 });
        return undefined;
      });
    }
    const doc = this.svc.ledger.recordCashSale({
      documentType: saleDocumentType(this.svc.business().dealerType),
      prefix: this.prefix(),
      branchId: this.svc.business().branchId,
      operator: this.operator(),
      orderId: null,
      lines: f.lines,
      tracked: f.tracked,
      totals: f.totals,
      promotions: f.promotions,
      payments: docLegs(step.legs),
      creditLegs: creditLegsOf(step.legs),
      tenderedAgorot: step.tenderedAgorot,
      changeAgorot: step.changeAgorot,
      channel: 'till',
      ...this.voucherDocFields(f),
      ...(this.discountApprover && f.totals.discountAgorot > 0 ? { approvedByPosUserId: this.discountApprover } : {}),
      ...this.basketDocField(f),
    });
    if (!doc) return refuse('shift_not_open', WORDS.shiftNone);
    this.checkout.legs.push({ ...step.leg, status: 'approved' });
    this.finalize(doc);
    return undefined;
  }

  /* --------------------------------------------------------- "מזומן במכשיר" (tillDeviceCash.ts) */

  /**
   * The payment opens at the cash device: the tenders' own refusals, then the pending document — numbered, with the earlier
   * legs and the device's for what is left — BEFORE the device hears anything (as a card's). A voucher close that must be
   * confirmed asks first and comes back here.
   */
  private deviceBegin(): { docId: string; amountAgorot: number } {
    this.signedIn();
    this.tenderOpen();
    if (this.checkout.basket) refuse('invalid_args', DEVICE_CASH_TEXT.inBasket);
    this.noRealMoneyInTest();
    if (this.svc.pay.cardInFlight) refuse('checkout_busy');
    const legs = this.approvedLegs();
    const due = dueOf(this.checkout.totalAgorot, legs);
    if (due < 1) refuse('invalid_args');
    const gate = this.voucherCloseGate(() => this.deviceCash.apply('deviceCash.pay', {}));
    if (gate) throw new DeviceGate(gate);
    if (!this.ensureShift()) refuse('shift_not_open', WORDS.shiftNone);
    const f = this.checkout.frozen!;
    const doc = this.svc.ledger.openCardSale({
      documentType: saleDocumentType(this.svc.business().dealerType),
      prefix: this.prefix(),
      branchId: this.svc.business().branchId,
      operator: this.operator(),
      orderId: null,
      lines: f.lines,
      tracked: f.tracked,
      totals: f.totals,
      promotions: f.promotions,
      payments: [...docLegs(legs), { method: 'cash', amountAgorot: due, device: true }],
      creditLegs: creditLegsOf(legs),
      channel: 'till',
      ...this.voucherDocFields(f),
      ...(this.discountApprover && f.totals.discountAgorot > 0 ? { approvedByPosUserId: this.discountApprover } : {}),
      ...this.basketDocField(f),
    });
    if (!doc) return refuse('shift_not_open', WORDS.shiftNone);
    this.checkout.docId = doc.id;
    this.checkout.docIds = [doc.id];
    this.checkout.legs.push({ method: 'cash', amountAgorot: due, handedAgorot: 0, status: 'pending' });
    this.checkout.phase = 'device_waiting';
    this.checkout.cardStatus = null;
    this.checkout.cardError = null;
    return { docId: doc.id, amountAgorot: due };
  }

  /** The device paid: the pending document completed with its transaction — the earlier legs, the device's for what was left. */
  private deviceComplete(docId: string, meta: DeviceLegMeta): DocDraft | null {
    const d = this.svc.ledger.doc(docId);
    if (!d || d.status !== 'pending') return d;
    const payments = d.payments ?? [];
    const earlier = payments.filter((l) => !l.device);
    const total = payments.reduce((s, l) => s + l.amountAgorot, 0);
    const settledNow = deviceSettle(
      total,
      earlier.map((l) => ({ method: l.method as TenderLeg['method'], amountAgorot: l.amountAgorot, handedAgorot: l.method === 'cash' ? l.amountAgorot : 0 })),
      meta,
    );
    if (!settledNow) {
      this.log(`device cash: document ${docId} does not settle (${total} agorot)`);
      return null;
    }
    const leg = settledNow.legs[settledNow.legs.length - 1];
    const done = this.svc.ledger.completeDeviceCashSale(docId, {
      cash: { ...meta, changeOwedAs: meta.changeOwedAs ?? null },
      payments: [...earlier, { method: 'cash', amountAgorot: leg.amountAgorot, device: true }],
      tenderedAgorot: settledNow.tenderedAgorot,
      changeAgorot: settledNow.changeAgorot,
      tipAgorot: settledNow.tipAgorot,
    });
    void this.svc.sync.flush();
    return done;
  }

  /** The live sale paid at the device: the done screen (the device gave the change — none from the drawer). */
  private deviceDone(doc: DocDraft) {
    if (this.checkout.docId !== doc.id) return;
    this.finalize(doc);
    this.checkout.changeAgorot = 0;
  }

  /** The device did not take the money: back to the tenders, the words shown. */
  private deviceFailed(message: string) {
    const c = this.checkout;
    if (c.phase !== 'device_waiting' && c.phase !== 'device_unknown') return;
    c.legs = c.legs.filter((l) => !(l.method === 'cash' && l.status === 'pending'));
    c.docId = null;
    c.docIds = [];
    c.phase = 'tender';
    c.cardStatus = null;
    c.cardError = message;
  }

  private prefix(): string | null {
    const me = this.svc.cloud.machine();
    return prefixFor(me?.documentPrefix ?? null, me?.posNumber ?? null);
  }

  private cardRefusals() {
    const pay = this.svc.pay;
    if (pay.cardInFlight) refuse('checkout_busy');
    // "ללא אשראי" (payment integration none): no card on this till, whatever a screen sends.
    if (pay.noCard) refuse('terminal_unavailable', WORDS.noCard);
    if (!pay.configured) refuse('terminal_unavailable', WORDS.noPaymentOptions);
    if (pay.blocked() || pay.unresolved()) refuse('terminal_unavailable', WORDS.cardPending);
  }

  private cardTender(): unknown {
    this.signedIn();
    this.tenderOpen();
    this.noRealMoneyInTest();
    this.cardRefusals();
    const gate = this.checkout.basket ? null : this.voucherCloseGate(() => this.cardTender());
    if (gate) return gate;
    const f = this.checkout.frozen!;
    const legs = cardLast(this.checkout.totalAgorot, this.approvedLegs());
    const card = legs[legs.length - 1];
    if (card.amountAgorot < 1) return refuse('invalid_args');
    const handed = handedTotal(legs);
    if (!this.ensureShift()) return refuse('shift_not_open', WORDS.shiftNone);
    if (this.checkout.basket) {
      return this.withRefundAuthority((refundApprover) => {
        // The basket written pending (every document of it) BEFORE the terminal is asked.
        const written = this.writeBasket({ realLegs: legs.map((l) => ({ method: l.method, amountAgorot: l.amountAgorot })), ...(handed > 0 ? { tenderedAgorot: handed, changeAgorot: 0 } : {}), status: 'pending', refundApprover });
        if (!written) return refuse('shift_not_open', WORDS.shiftNone);
        if (!Array.isArray(written)) return refuse('basket_changed', written.refused);
        this.startCard(written[0], card.amountAgorot, written.map((d) => d.id));
        return undefined;
      });
    }
    // The pending document is written (numbered, the counter saved first) BEFORE the terminal is asked.
    const doc = this.svc.ledger.openCardSale({
      documentType: saleDocumentType(this.svc.business().dealerType),
      prefix: this.prefix(),
      branchId: this.svc.business().branchId,
      operator: this.operator(),
      orderId: null,
      lines: f.lines,
      tracked: f.tracked,
      totals: f.totals,
      promotions: f.promotions,
      payments: docLegs(legs),
      creditLegs: creditLegsOf(legs),
      ...(handed > 0 ? { tenderedAgorot: handed, changeAgorot: 0 } : {}),
      channel: 'till',
      ...this.voucherDocFields(f),
      ...(this.discountApprover && f.totals.discountAgorot > 0 ? { approvedByPosUserId: this.discountApprover } : {}),
      ...this.basketDocField(f),
    });
    if (!doc) return refuse('shift_not_open', WORDS.shiftNone);
    this.startCard(doc, card.amountAgorot, [doc.id]);
    return undefined;
  }

  private startCard(doc: DocDraft, amount: number, docIds: string[], payout: { originalTransactionId: string | null } | null = null) {
    this.checkout.docId = doc.id;
    this.checkout.docIds = docIds;
    this.checkout.legs.push({ method: 'card', amountAgorot: amount, handedAgorot: 0, status: 'pending' });
    this.checkout.phase = 'card_waiting';
    this.checkout.cardError = null;
    this.checkout.cardStatus = WORDS.presentCard;
    void this.runCharge(doc, amount, payout);
  }

  private async runCharge(doc: DocDraft, amount: number, payout: { originalTransactionId: string | null } | null) {
    const outcome = payout
      ? await this.svc.pay.refund({
          transactionId: doc.id,
          amountAgorot: amount,
          originalTransactionId: payout.originalTransactionId,
          record: true,
          onSent: () => this.later(() => this.setCardStatus(WORDS.presentCard)),
          onProgress: (m) => void this.later(() => this.setCardStatus(m)),
        })
      : await this.svc.pay.charge({
          transactionId: doc.id,
          orderId: null,
          amountAgorot: amount,
          tipAgorot: 0,
          onSent: () => this.later(() => this.setCardStatus(WORDS.presentCard)),
          onProgress: (m) => void this.later(() => this.setCardStatus(m)),
        });
    await this.later(() => {
      const ref = this.svc.pay.attempts().find((a) => a.transactionId === doc.id)?.vuid ?? null;
      if (outcome.kind === 'approved') {
        const done = this.svc.ledger.completeCardSale(doc.id, outcome.card);
        if (ref) this.svc.pay.forgetAttempt(ref);
        if (done && settled(done)) this.finalizeAfterCard(done);
      } else if (outcome.kind === 'declined' || outcome.kind === 'refused') {
        this.svc.ledger.voidCardSale(doc.id, outcome.kind === 'declined' ? outcome.voidMeta : null);
        if (ref) this.svc.pay.forgetAttempt(ref);
        const message = outcome.kind === 'declined' ? outcome.message : WORDS.noPaymentOptions;
        this.cardFailed(payout && !payout.originalTransactionId ? WORDS.basketUnlinkedDeclined(message) : message);
        void this.svc.sync.flush();
      } else {
        // Unknown: never a second charge — the document stays pending and every tender waits for the answer.
        this.checkout.phase = 'card_unknown';
        this.checkout.cardStatus = null;
        this.checkout.cardError = outcome.message;
      }
      this.dirty = true;
      this.commit();
    });
  }

  /** The card approved: a single document finalises as before; a basket's (or a payout's) documents together. */
  private finalizeAfterCard(done: DocDraft) {
    // A card approved while the terminal works deferred: one more for the card company ("ממתינות לאישור").
    this.transmission.noteApprovedCard();
    if (this.checkout.basket || done.basketId) {
      const docs = done.basketId ? this.svc.ledger.basketDocs(done.basketId) : [done];
      const b = this.checkout.basket;
      const payout = b && b.netAgorot < 0 ? -b.netAgorot : 0;
      this.finalizeBasket(docs, { changeAgorot: 0, tenderedAgorot: done.tenderedAgorot ?? 0, handBack: payout, viaCard: true });
      return;
    }
    this.finalize(done);
  }

  private setCardStatus(m: string) {
    if (this.checkout.phase === 'card_waiting') {
      this.checkout.cardStatus = m;
      this.dirty = true;
      this.commit();
    }
  }

  /** The card did not go through (certainly not charged): back to the tenders, the words shown. */
  /* ------------------------------------------------------------- "חסום / אזל" */

  /**
   * A block or a "sold out" to the cloud: checked against its sheet, then ITEM_BLOCK — ITEM_BLOCK_WIDE beyond the till's own
   * reach — the operator alone or a manager's code (the approver is the cloud's `X-Pos-User-Id`). Refused for wanting the wider
   * right after all (`block_scope_not_allowed`, `needs`): asked once more for it.
   */
  private blockItem(a: Record<string, unknown>) {
    const plan = this.itemBlocks.plan(a);
    const run = (wide: boolean): unknown =>
      this.gate(
        wide ? PERM.ITEM_BLOCK_WIDE : PERM.ITEM_BLOCK,
        async (approver) => {
          const r = await this.itemBlocks.send(plan.request, approver?.id ?? null);
          if (!r.ok && r.needsWide && !wide) return run(true);
          this.toast(r.message, r.ok ? 'ok' : 'error');
          return r.ok ? { ok: true, message: r.message } : refuse('permission_denied', r.message);
        },
        { title: wide ? IB_TEXT.approveWide : IB_TEXT.approve },
      );
    return run(plan.wide);
  }

  /** "שחרר" / "שחרר הכל": one approval for them all (ITEM_BLOCK_WIDE when any of them reaches beyond the till). */
  private releaseBlocks(idsRaw: unknown) {
    this.signedIn();
    const ids = Array.isArray(idsRaw) ? idsRaw.filter((x): x is string => typeof x === 'string' && !!x) : [];
    if (ids.length === 0) return refuse('invalid_args');
    const wide = this.itemBlocks.releaseNeedsWide(ids);
    return this.gate(
      wide ? PERM.ITEM_BLOCK_WIDE : PERM.ITEM_BLOCK,
      async (approver) => {
        const r = await this.itemBlocks.release(ids, approver?.id ?? null);
        this.toast(r.message, r.ok ? 'ok' : 'error');
        return r.ok ? r : refuse('permission_denied', r.message);
      },
      { title: wide ? IB_TEXT.approveWide : IB_TEXT.approve },
    );
  }

  /* ------------------------------------------------------------- "פעולות אשראי" */

  /** The screen opened: its view in the state from now on; the terminal read, the batch, the history (in the background). */
  private transmissionOpen() {
    this.signedIn();
    this.transmissionShown = true;
    void this.transmission.open().catch((e: unknown) => this.log(`transmission screen: ${String(e)}`));
    return undefined;
  }

  /** A terminal action approved (TRANSMIT): it runs in the background, its answer on the screen and as a toast. */
  private transmissionAction(run: () => Promise<string>) {
    if (this.paying()) return refuse('checkout_busy', TX_TEXT.busy);
    void run()
      .then((text) => this.later(() => this.toast(text, 'info')))
      .catch((e: unknown) => this.log(`transmission: ${String(e)}`));
    return { started: true };
  }

  /** The deferred mode's switch: on — "להפעיל מצב לא מקוון?" first; then TRANSMIT (a manager's code where the role asks one). */
  private transmissionSwitch(on: boolean) {
    this.signedIn();
    const go = () => this.gate(PERM.TRANSMIT, () => this.transmissionAction(() => this.transmission.switchOffline(on)), { body: TX_TEXT.reasonOffline });
    if (!on) return go();
    this.openDialog({
      kind: 'confirm',
      title: TX_TEXT.confirmTitle,
      body: TX_TEXT.confirmBody,
      fields: [],
      actions: [
        { id: 'approve', label: TX_TEXT.turnOn, primary: true },
        { id: 'cancel', label: TX_TEXT.cancel },
      ],
      code: null,
      resume: () => go(),
    });
    return { dialogId: this.pending!.dialog.id };
  }

  private cardFailed(message0: string) {
    // §13: a card the terminal refused while deferred, named by its kind ("כרטיס דביט — לא נתמך במצב לא מקוון…").
    const refused = offlineRefusedCard(message0, this.transmission.offlineOn(), true);
    const message = refused ? REFUSED_OFFLINE_TEXT[refused] : message0;
    this.checkout.legs = this.checkout.legs.filter((l) => !(l.method === 'card' && l.status === 'pending'));
    this.checkout.docId = null;
    this.checkout.docIds = [];
    this.checkout.phase = 'tender';
    this.checkout.cardStatus = null;
    this.checkout.cardError = message;
  }

  /** "אישור החלפה" (confirmExchange): a basket that nets to zero — the goods swap, nothing is paid either way. */
  private confirmExchange() {
    this.signedIn();
    const b = this.checkout.basket;
    if (this.checkout.phase !== 'tender' || !b || b.step !== 'exchange' || b.netAgorot !== 0) return refuse('invalid_args');
    if (!this.ensureShift()) return refuse('shift_not_open', WORDS.noShiftBlocksSale);
    return this.withRefundAuthority((refundApprover) => {
      const written = this.writeBasket({ status: 'completed', refundApprover });
      if (!written) return refuse('shift_not_open', WORDS.noShiftBlocksSale);
      if (!Array.isArray(written)) return refuse('basket_changed', written.refused);
      this.finalizeBasket(written, { changeAgorot: 0, tenderedAgorot: 0, handBack: 0 });
      return undefined;
    });
  }

  /**
   * Money back on a basket that nets below zero (payoutCash / payoutCard): one leg, no split, no tip. Cash: written and
   * the drawer opens. Card: a linked refund when one card original can take it all, else an unlinked credit — the basket
   * written pending first, a decline voids all of it.
   */
  private payout(method: 'cash' | 'card') {
    this.signedIn();
    const b = this.checkout.basket;
    if (this.checkout.phase !== 'tender' || !b || b.step !== 'payout' || b.netAgorot >= 0) return refuse('invalid_args');
    if (!this.ensureShift()) return refuse('shift_not_open', WORDS.noShiftBlocksSale);
    const payout = -b.netAgorot;
    if (method === 'cash') {
      return this.withRefundAuthority((refundApprover) => {
        const written = this.writeBasket({ payout: { method: 'cash' }, status: 'completed', refundApprover });
        if (!written) return refuse('shift_not_open', WORDS.noShiftBlocksSale);
        if (!Array.isArray(written)) return refuse('basket_changed', written.refused);
        this.finalizeBasket(written, { changeAgorot: 0, tenderedAgorot: 0, handBack: payout });
        return undefined;
      });
    }
    if (this.svc.pay.noCard) return refuse('terminal_unavailable', WORDS.noCard);
    const route = b.route;
    if (route.kind === 'unavailable') return refuse('terminal_unavailable', WORDS.basketPayoutUnavailable);
    this.cardRefusals();
    return this.withRefundAuthority((refundApprover) => {
      const linked = route.kind === 'linked' ? route : null;
      const written = this.writeBasket({ payout: { method: 'card', onCreditOf: linked?.originalId ?? null }, status: 'pending', refundApprover });
      if (!written) return refuse('shift_not_open', WORDS.noShiftBlocksSale);
      if (!Array.isArray(written)) return refuse('basket_changed', written.refused);
      // The attempt names the credit note that carries the card leg (the basket completes or voids as one).
      const carrier = written.find((d) => (d.payments ?? []).some((l) => l.method === 'card')) ?? written[0];
      this.startCard(carrier, payout, written.map((d) => d.id), { originalTransactionId: linked?.acquirerTransactionId ?? null });
      return undefined;
    });
  }

  private checkoutCancel() {
    this.signedIn();
    const c = this.checkout;
    if (c.phase === 'card_waiting') {
      void this.svc.pay.cancel();
      c.cardStatus = WORDS.cancelling;
      return undefined;
    }
    if (c.phase === 'card_unknown' || c.phase === 'device_unknown') refuse('card_in_flight');
    // "חזרה" / "ביטול" while the cash device takes the money: the device's own cancel (it gives back what went in).
    if (c.phase === 'device_waiting') return this.deviceCash.cancel();
    if (c.phase !== 'tender') refuse('invalid_args');
    const handed = handedTotal(this.approvedLegs());
    const reset = () => {
      // "זיכוי מזומן" taken for a sale that is not closed: back on its credit (kept and retried until the cloud hears it).
      for (const l of this.checkout.legs) if (l.method === 'cash_credit' && l.credit) this.cash.credits.release(l.credit.redemptionId);
      // The vouchers held for it: given back.
      this.vouchers.abandon();
      const kiosk = this.checkout.kioskOrder;
      this.checkout = idleCheckout();
      // A kiosk order's basket is never edited here: backing out puts the order back on the list.
      if (kiosk) {
        this.kioskOrders.abandoned();
        this.clearBasket();
      }
      return undefined;
    };
    // "השובר לא מומש" (VoucherLeavePayment): vouchers applied and not redeemed — asked first; a simulation holds nothing.
    const leaving = this.vouchers.simulation() ? null : voucherLeaveText(this.vouchers.serials());
    if (handed === 0 && leaving) {
      this.openDialog({
        kind: 'confirm',
        title: VOUCHER_LEAVE_TEXT.title,
        body: leaving,
        fields: [],
        actions: [
          { id: 'approve', label: VOUCHER_LEAVE_TEXT.ok, primary: true },
          { id: 'cancel', label: VOUCHER_LEAVE_TEXT.stay },
        ],
        code: null,
        resume: () => reset(),
      });
      return { dialogId: this.pending!.dialog.id };
    }
    if (handed === 0) return reset();
    // Cash was already taken: the sale is abandoned only with the money handed back (Android "בטל מכירה והחזר מזומן").
    this.openDialog({
      kind: 'confirm',
      title: WORDS.returnCashTitle,
      body: `${WORDS.returnCashBody} ${sh(handed)}`,
      fields: [],
      actions: [
        { id: 'approve', label: WORDS.returnCashDone, primary: true },
        { id: 'cancel', label: WORDS.cancel },
      ],
      code: null,
      resume: () => reset(),
    });
    return { dialogId: this.pending!.dialog.id };
  }

  /**
   * "זיכוי מזומן" (Android CheckoutViewModel.redeemCashCredit): a station's credit (`CC:<code>`, scanned or typed) taken for
   * min(what is left on it, what is left of the goods) — a `cash_credit` leg naming its redemption; nothing left to collect —
   * the sale is closed at once with no money moved (no drawer).
   */
  private async creditTender(raw: unknown) {
    this.signedIn();
    this.tenderOpen();
    this.noRealMoneyInTest();
    // A basket with returns takes no credit (Android redeemCashCredit: `isBasket` → "לא ניתן לממש את הזיכוי כרגע").
    if (this.checkout.basket) return refuse('invalid_args', CREDIT_IN_BASKET);
    if (typeof raw !== 'string' || raw.length > 80) return refuse('invalid_args');
    const inSale = this.checkout.legs.flatMap((l) => (l.method === 'cash_credit' && l.credit ? [{ ...l.credit, amountAgorot: l.amountAgorot }] : []));
    const due = dueOf(this.checkout.totalAgorot, this.approvedLegs());
    const r = await redeemCredit(this.cash.credits, raw, due, inSale);
    if (r.kind === 'refused') return refuse('invalid_args', CREDIT_TEXT[r.why]);
    // The payment may have moved on while the cloud answered: then the credit goes back.
    if (this.checkout.phase !== 'tender') {
      this.cash.credits.release(r.use.redemptionId);
      return refuse('checkout_busy');
    }
    const amount = Math.min(r.use.amountAgorot, dueOf(this.checkout.totalAgorot, this.approvedLegs()));
    this.checkout.legs.push({ method: 'cash_credit', amountAgorot: amount, handedAgorot: 0, credit: { code: r.use.code, redemptionId: r.use.redemptionId }, status: 'approved' });
    if (dueOf(this.checkout.totalAgorot, this.approvedLegs()) > 0) return { creditAgorot: amount };
    // Settled by the credits: the document now — no cash handed over, no change.
    this.closeSettled();
    return { creditAgorot: amount };
  }

  /** "הסרת הזיכוי": the credit's leg off the payment, the amount back on the credit. */
  private removeCredit(redemptionId: unknown) {
    this.signedIn();
    this.tenderOpen();
    const i = this.checkout.legs.findIndex((l) => l.method === 'cash_credit' && l.credit?.redemptionId === redemptionId);
    if (i < 0) return refuse('invalid_args');
    const [leg] = this.checkout.legs.splice(i, 1);
    this.cash.credits.release(leg.credit!.redemptionId);
    return undefined;
  }

  private checkoutFinish() {
    if (this.checkout.phase !== 'done') refuse('invalid_args');
    this.vouchers.clear();
    this.deviceCash.clearDone();
    this.checkout = idleCheckout();
    return undefined;
  }

  /** The sale is complete: the cart is gone (never sold twice), the drawer, the receipt. */
  private finalize(doc: DocDraft) {
    const legs = legsOf(doc);
    const c = this.checkout;
    c.phase = 'done';
    c.docId = doc.id;
    c.docIds = [doc.id];
    c.documentRef = formatDocNumber(doc.prefix, String(doc.number));
    c.changeAgorot = doc.changeAgorot ?? 0;
    c.tenderedAgorot = doc.tenderedAgorot ?? 0;
    c.legs = legs
      .filter((l) => l.method !== EXCHANGE)
      .map((l) => ({
        method: l.method as 'cash' | 'card' | 'cash_credit' | 'production_voucher',
        amountAgorot: l.amountAgorot,
        handedAgorot: l.method === 'cash' ? l.amountAgorot : 0,
        status: 'approved' as const,
        ...(l.cashCredit ? { credit: l.cashCredit } : {}),
        ...(l.voucher ? { voucher: l.voucher } : {}),
      }));
    c.cardStatus = null;
    c.cardError = null;
    // "מסך הצלחה במימוש שובר": the vouchers this sale redeemed — by itself, the cashier's tap, or with money for the rest.
    const paidByMoney = legs.some((l) => (l.method === 'cash' || l.method === 'card') && l.amountAgorot > 0);
    c.voucherSuccess = this.voucherSuccessNow(this.closeKind ?? (paidByMoney ? 'with_payment' : 'tap'));
    // The vouchers confirmed with the document (it names them too), then nothing held any more.
    this.vouchers.settle(doc);
    this.vouchers.clear();
    // The order's name and take-away / eat-in: on its kitchen tickets (the headline, the band), never on the receipt.
    const order = { orderName: this.orderName, dining: this.orderDining };
    const kiosk = c.kioskOrder;
    c.kioskOrder = null;
    this.clearBasket();
    void this.svc.sync.flush();
    // A kiosk order paid here: reported paid (kept until the cloud has it).
    if (kiosk) this.kioskOrders.paid(kiosk, doc.id, formatDocNumber(doc.prefix, String(doc.number)));
    // "בונים במכירה" and the KDS (main/kitchen): queued durably before the receipt, never holding the sale — a kiosk order's
    // only when the kiosk did not send its bon before payment.
    const unrouted = kiosk?.kitchenSent ? [] : this.svc.tillKitchen(doc, order);
    c.kitchenWarning = unrouted.length > 0 ? `פריטים שלא נותבו למדפסת: ${unrouted.join(', ')}` : null;
    this.kickDrawer(doc);
    this.printOrAsk(doc);
  }

  /**
   * A basket written and settled (basketDone): the done screen, the drawer (cash taken or handed back), and the paper —
   * every document in the order numbered, each credit note followed by the shop's copy for the customer's signature.
   */
  private finalizeBasket(docs: DocDraft[], o: { changeAgorot: number; tenderedAgorot: number; handBack: number; viaCard?: boolean }) {
    const c = this.checkout;
    const primary = docs[0];
    c.phase = 'done';
    c.docId = primary.id;
    c.docIds = docs.map((d) => d.id);
    c.documentRef = formatDocNumber(primary.prefix, String(primary.number));
    c.changeAgorot = o.changeAgorot;
    c.tenderedAgorot = o.tenderedAgorot;
    c.legs = docs
      .flatMap((d) => legsOf(d))
      .filter((l) => l.method !== EXCHANGE)
      .map((l) => ({ method: l.method as 'cash' | 'card' | 'cash_credit', amountAgorot: l.amountAgorot, handedAgorot: l.method === 'cash' ? l.amountAgorot : 0, status: 'approved' as const }));
    c.cardStatus = null;
    c.cardError = null;
    if (c.basket) c.basket.handedBackAgorot = o.handBack;
    const order = { orderName: this.orderName, dining: this.orderDining };
    this.clearBasket();
    void this.svc.sync.flush();
    const sale = docs.find((d) => isSaleType(d.documentType));
    // "בונים במכירה" and the KDS (main/kitchen) for what the basket sold — never for its credit notes.
    const unrouted = sale ? this.svc.tillKitchen(sale, order) : [];
    c.kitchenWarning = unrouted.length > 0 ? `פריטים שלא נותבו למדפסת: ${unrouted.join(', ')}` : null;
    // Cash taken, or handed back (a return, change): the drawer opens.
    const cashMoved = docs.some((d) => legsOf(d).some((l) => l.method === 'cash'));
    if (cashMoved && !o.viaCard) {
      if (sale && legsOf(sale).some((l) => l.method === 'cash')) this.kickDrawer(sale);
      else this.refundDrawer(...docs.filter((d) => isCreditType(d.documentType)));
    }
    if (o.handBack > 0) this.toast(WORDS.checkoutRefundDone(sh(o.handBack)), 'ok');
    if (this.printMode().off) return;
    for (const d of docs) {
      this.svc.printDocReceipt(d, false);
      if (isCreditType(d.documentType)) this.svc.printDocReceipt(d, true, true);
    }
  }

  /**
   * "פתיחת מגירה" after a payment that moved cash (Android CheckoutViewModel.drawerAfterCash): through the drawer service only
   * — its rules, its audit, "לפתוח מגירה?" (`cashDrawer` "בתשלום מזומן — לשאול"), and on a device away from the drawer where
   * the money goes (drawer-away §5.3). The cash is what the cash legs took.
   */
  private kickDrawer(doc: DocDraft) {
    // "מזומן במכשיר": the device's leg is in the device — only cash taken at the counter opens the drawer.
    const cash = legsOf(doc)
      .filter((l) => l.method === 'cash' && !l.device)
      .reduce((sum, l) => sum + l.amountAgorot, 0);
    if (cash <= 0) return;
    void Promise.resolve(this.drawer.afterCashSale({ id: doc.id, documentType: doc.documentType, number: doc.number }, cash)).catch((e: unknown) => this.log(`cash drawer: ${String(e)}`));
  }

  private printMode(): { off: boolean; ask: boolean } {
    const params = this.svc.cloud.parameters();
    const reportsOnly = ['דוחות בלבד', 'reports', 'reports_only', 'reportsonly'].includes(String(params.printMode ?? '').trim().toLowerCase());
    const ask = ['true', '1', 'yes', 'כן'].includes(String(params.askBeforePrint ?? '').trim().toLowerCase());
    return { off: reportsOnly, ask: ask && !reportsOnly };
  }

  private printOrAsk(doc: DocDraft) {
    const m = this.printMode();
    if (m.off) return;
    if (m.ask) {
      this.checkout.askPrint = true;
      return;
    }
    this.printReceipt(doc, false);
  }

  private printReceipt(doc: DocDraft, copy: boolean) {
    const job = this.svc.printDocReceipt(doc, copy);
    if (!job) return;
    this.checkout.receiptJob = job;
    void this.watchPrint(job, doc.id);
  }

  /** A receipt that did not print is a warning on the done screen and a retry — never the sale's problem. */
  private async watchPrint(job: string, docId: string) {
    for (let i = 0; i < 30 && !this.stopped; i++) {
      await new Promise((r) => setTimeout(r, 1_000));
      if (this.stopped) return;
      let j: ReturnType<typeof this.svc.printQueue.job> = null;
      try {
        j = this.svc.printQueue.job(job);
      } catch {
        return; // the service is closing
      }
      if (!j) return;
      if (j.status === 'sent') return;
      if (j.status === 'failed') {
        await this.later(() => {
          if (this.checkout.docId === docId && this.checkout.phase === 'done') {
            this.checkout.printWarning = WORDS.receiptProblem(j.last_error ?? WORDS.noReceiptPrinter);
            this.dirty = true;
            this.commit();
          }
        });
        return;
      }
    }
  }

  private answerPrint(print: boolean) {
    const c = this.checkout;
    if (c.phase !== 'done' || !(c.askPrint || c.printWarning) || !c.docId) return refuse('invalid_args');
    c.askPrint = false;
    c.printWarning = null;
    if (print) {
      const doc = this.svc.ledger.doc(c.docId);
      if (doc) this.printReceipt(doc, false);
    }
    return undefined;
  }

  /**
   * "בדוק שוב" on a card whose answer is unknown (Android recheckCard): the terminal is asked about THE SAME reference
   * (payService.resolveOrphans) — approved completes the sale, certainly not charged voids the document and reopens the
   * tenders, still unknown stays.
   */
  private async recheckCard() {
    this.signedIn();
    const c = this.checkout;
    if (c.phase !== 'card_unknown' || !c.docId) return refuse('invalid_args');
    await this.svc.settleOrphans();
    const doc = this.svc.ledger.doc(c.docId);
    if (!doc) return refuse('invalid_args');
    if (settled(doc)) this.finalizeAfterCard(doc);
    else if (doc.status === 'cancelled') this.cardFailed('העסקה לא חויבה');
    else c.cardError = WORDS.cardPending;
    return undefined;
  }

  /** "סמן כלא אושר והמשך" — a manager's code (CARD_UNRESOLVED), after checking the terminal: void and forget. */
  private markNotApproved() {
    const user = this.signedIn();
    const c = this.checkout;
    if (c.phase !== 'card_unknown' || !c.docId) return refuse('invalid_args');
    const docId = c.docId;
    return this.gate(
      'CARD_UNRESOLVED',
      (by) => {
        const attempt = this.svc.pay.attempts().find((a) => a.transactionId === docId);
        const who = by ?? { id: user.id, name: displayName(user) };
        if (attempt) this.svc.pay.markNotApproved(attempt.vuid, who, (att, meta) => this.svc.ledger.voidCardSale(att.transactionId, meta));
        else this.svc.ledger.voidCardSale(docId, null);
        this.cardFailed('העסקה סומנה כלא אושרה באישור מנהל');
        void this.svc.sync.flush();
        return undefined;
      },
      { askOnDeny: true },
    );
  }

  /* --------------------------------------------------------- documents, copies */

  /** Today's documents — or, "24 השעות האחרונות", those of the last [hours]. */
  private history(hours: number | null) {
    this.signedIn();
    const docs = hours ? this.svc.ledger.docsBetween(new Date(this.nowFn() - hours * 3_600_000).toISOString(), new Date(this.nowFn() + 60_000).toISOString()) : this.svc.ledger.todaysDocs(localDate(this.nowFn()));
    return docs
      .slice(0, hours ? 200 : 40)
      .map((d) => ({
        id: d.id,
        ref: formatDocNumber(d.prefix, String(d.number)),
        totalAgorot: d.totals.totalAgorot,
        at: d.createdAt,
        cashier: d.cashierName,
        methods: legsOf(d)
          .map((l) => l.method)
          .filter((m) => m !== EXCHANGE),
        documentType: d.documentType,
        status: d.status,
      }));
  }

  private reprint(documentId: string) {
    this.signedIn();
    const doc = this.svc.ledger.doc(documentId);
    if (!doc || !settled(doc)) return refuse('invalid_args');
    // The copy of the sale just done, on its own done screen, is the checkout's (Android CheckoutViewModel.reprint): no code.
    if (this.checkout.phase === 'done' && (this.checkout.docId === documentId || this.checkout.docIds.includes(documentId))) {
      this.svc.printDocReceipt(doc, true);
      return undefined;
    }
    return this.gate(PERM.REPRINT, () => {
      // The checkout's own "הדפס העתק" (the sale just done) and the history's: a copy, as the Android till prints it.
      this.svc.printDocReceipt(doc, true);
      return undefined;
    });
  }

  /* ------------------------------------------------------------- held sales */

  /**
   * "להמתנה" (hold): the basket parked and the screen handed back empty — not gated on the shift (a parked basket is not a
   * document). Never with a return line, never empty; its basket discount kept with it in memory (parkedExtras).
   */
  private hold(labelRaw: unknown) {
    this.editable();
    const refusal = holdRefusal({ empty: this.cart.length === 0, hasRefundLines: this.cart.some((l) => l.refund) });
    if (refusal) return refuse('invalid_args', refusal);
    const p = this.priced();
    const byKey = new Map(p.lines.map((l) => [l.key, l] as const));
    const lines: HeldLine[] = this.cart.map((rec) => {
      const l = byKey.get(rec.lineId);
      return {
        id: rec.lineId,
        productId: rec.productId,
        name: l?.name ?? rec.name ?? rec.productId,
        qty: rec.qty,
        unitAgorot: l ? unitAgorot(l) : (rec.keptUnitAgorot ?? 0),
        discount: rec.discount ?? null,
        oth: rec.oth ?? null,
        // A configured line keeps its choices; its kept price is the dish's own (the choices are priced again on top).
        ...(rec.choices ? { choices: rec.choices, baseAgorot: l ? l.basePriceAgorot : (rec.keptUnitAgorot ?? 0) } : {}),
      };
    });
    // The lines' money as rung up (gross less each line's own discount): what the list shows.
    const total = p.lines.reduce((s, l) => s + lineGross(l) - (l.discountAgorot ?? 0), 0);
    const op = this.operator();
    // The order's name names the held sale when none was typed (Android hold(cashierId, cart.orderName)).
    const id = this.held.hold(lines, { id: op.id, name: op.name }, holdLabelOf(labelRaw) ?? this.orderName, total);
    if (!id) return refuse('invalid_args', HELD_TEXT.holdFailed);
    if (this.cartDiscount || this.discountApprover || this.orderDining || this.orderName) {
      this.parkedExtras.set(id, { discount: this.cartDiscount, approver: this.discountApprover, dining: this.orderDining, orderName: this.orderName });
    }
    this.clearBasket();
    return { id };
  }

  /**
   * "טען מכירה" (requestResume): with items rung up the cashier is asked first — the only offered answer parks what is on
   * screen ([parkLive]); nothing is merged or lost. The row is TAKEN (never two live copies of one basket).
   */
  private resumeHeld(id: string, parkLive: boolean) {
    this.editable();
    if (this.cart.some((l) => l.refund)) return refuse('invalid_args', HELD_TEXT.holdRefundBlocked);
    const target = this.held.peek(id);
    if (!target) return refuse('invalid_args', HELD_TEXT.heldGone);
    if (this.cart.length > 0) {
      if (!parkLive) {
        const p = this.priced();
        return refuse('checkout_busy', HELD_TEXT.conflictMessage(`${p.lines.reduce((s, l) => s + l.qty, 0)} פריטים, ${sh(p.netAgorot)}`), { conflict: true, title: HELD_TEXT.conflictTitle });
      }
      this.hold(null);
    }
    const sale = this.held.resume(id);
    if (!sale) return refuse('invalid_args', HELD_TEXT.heldGone);
    const extras = this.parkedExtras.get(id) ?? null;
    this.parkedExtras.delete(id);
    this.clearBasket();
    for (const l of sale.lines) {
      this.lineSeq += 1;
      this.cart.push({
        lineId: `l${this.lineSeq}`,
        productId: l.productId,
        qty: l.qty,
        discount: l.discount,
        oth: l.oth,
        keptUnitAgorot: l.choices ? (l.baseAgorot ?? null) : l.unitAgorot,
        name: l.name,
        ...(l.choices ? { choices: l.choices } : {}),
      });
    }
    if (extras) {
      this.cartDiscount = extras.discount;
      this.discountApprover = extras.approver;
      this.orderDining = extras.dining ?? null;
      this.orderName = extras.orderName ?? null;
    }
    return undefined;
  }

  /**
   * "בטל" on a held sale (heldCloseGate.requestCancel): HELD_SALE_CANCEL (a manager's code where the role asks it), a reason,
   * and its `held_sale_cancelled` till event — recorded only when this cancel took the row.
   */
  private cancelHeld(id: string, reasonRaw: unknown) {
    this.signedIn();
    const reason = typeof reasonRaw === 'string' ? reasonRaw.trim().slice(0, 300) : '';
    if (!reason) return refuse('invalid_args', WORDS.heldCancelReasonRequired);
    const target = this.held.peek(id);
    if (!target) return refuse('invalid_args', HELD_TEXT.heldGone);
    return this.gate(PERM.HELD_SALE_CANCEL, (approver) => {
      const summary = summaryOf(target);
      if (!this.held.discard(id)) return refuse('invalid_args', HELD_TEXT.heldGone);
      this.parkedExtras.delete(id);
      const op = this.cashier!;
      this.recordEvent(TILL_EVENT_HELD_SALE_CANCELLED, op.id, summary.totalAgorot, heldSaleCancelDetails(summary, HELD_CANCEL_LOCAL, reason, new Date(this.nowFn()).toISOString(), { approvedBy: approver?.id ?? op.id }));
      return undefined;
    });
  }

  private recordEvent(type: string, posUserId: string | null, amountAgorot: number | null, details: Record<string, unknown>, shiftId?: string | null) {
    this.svc.recordEngineEvent?.({
      id: randomUUID(),
      type,
      occurredAt: new Date(this.nowFn()).toISOString(),
      shiftId: shiftId === undefined ? (this.svc.ledger.currentShift()?.id ?? null) : shiftId,
      posUserId,
      ...(amountAgorot !== null ? { amount: amountAgorot / 100 } : {}),
      details,
    });
  }

  /**
   * Every local close asks first (heldSalesGate): "יש N מכירות מושהות" — paid or cancelled before the close; with
   * `allowCloseWithHeldSales` the close may go on and leave them ([keepHeld]).
   */
  private heldGate(keepHeld: boolean) {
    const n = this.held.count();
    const gate = heldSalesGate(n, allowCloseWithHeldSales(this.svc.cloud.parameters()));
    if (gate === 'proceed' || (gate === 'warn_with_keep_option' && keepHeld)) return;
    refuse('held_sales', HELD_TEXT.closeTitle(n), { count: n, keepAllowed: gate === 'warn_with_keep_option', body: HELD_TEXT.closeBody, sales: this.held.summaries() });
  }

  /* ------------------------------------------------------------------- shift */

  private noShiftsHere(): never {
    return refuse('permission_denied', 'בקופה הזו אין משמרות — הפקת Z סוגרת את המשמרת הפנימית');
  }

  private shiftOpen(opening: unknown) {
    const user = this.signedIn();
    if (this.shiftsHidden()) this.noShiftsHere();
    if (this.svc.ledger.currentShift()) refuse('shift_open');
    const amount = opening === undefined ? 0 : opening;
    if (!isInt(amount, 0, 100_000_000)) refuse('invalid_args');
    return this.gate(PERM.SHIFT_OPEN, () => {
      // The shift is the employee's: opened by them with the float counted into the drawer.
      this.svc.ledger.openShift({ id: user.id, name: displayName(user) }, new Date(this.nowFn()), amount as number);
      void this.svc.sync.flush();
      return undefined;
    });
  }

  private xFigures(shiftId: string) {
    const shift = this.svc.ledger.shift(shiftId)!;
    const x = buildXTill(this.svc.ledger.docsOfShift(shiftId).map(xDocOf), shift.opening_cash, this.svc.vatRate());
    // "מגירת מזומן": the shift's movements and wallets move the expected drawer (spec §8, drawer-away §5.6).
    return { shift, ...x, till: this.tillFigures(x.till, shiftId) };
  }

  /**
   * The X's till as every close of this till freezes it: the card tips paid out of the drawer ("טיפ באשראי משולם מהמזומן",
   * core/till/cardTipsFromDrawer.ts — the parameter now), the drawer's movements and wallets, the vouchers' sections.
   */
  private tillFigures(till: ReturnType<typeof buildXTill>['till'], shiftId: string) {
    const p = this.svc.cloud.parameters();
    // After the movements and wallets: the expected cash then is what the drawer has before the tips payout (§2 `available`).
    const tipsOut = withCashWithTips(this.withDrawer(till, shiftId), { param: cardTipsFromDrawerOn(p, false), shortfall: cardTipsShortfallOf(p), askChoice: this.cardTipsChoice });
    return this.withVouchers(tipsOut, shiftId);
  }

  /**
   * "כשאין מספיק מזומן לטיפים באשראי" (x-z-cash-with-tips §2) at a close: the manager's choice under `ask` (only when short),
   * 'partial' for a close nobody stands at (automatic, from the cloud, the shop Z's participant) — null: an X, a preview.
   */
  private cardTipsChoice: CardTipsChoice | null = null;

  private withTipsChoice<R>(choice: CardTipsChoice | null, f: () => R): R {
    const before = this.cardTipsChoice;
    this.cardTipsChoice = choice;
    try {
      return f();
    } finally {
      this.cardTipsChoice = before;
    }
  }

  /** `ask` and short with no choice: the close refuses with the question (the screen asks the manager and closes again). */
  private askTipsChoice(shiftId: string, choice: CardTipsChoice | null): void {
    if (choice) return;
    const t = this.xFigures(shiftId).till;
    if (t.cardTipsNeedsChoice !== true) return;
    const tips = Math.round(t.totalCardTips * 100);
    const room = Math.max(Math.round(t.expectedCash * 100) + Math.round((t.cardTipsFromDrawer ?? 0) * 100), 0);
    refuse('card_tips_choice', CARD_TIPS_ASK_TEXT.title, { body: CARD_TIPS_ASK_TEXT.body(amountText(tips), amountText(room)), partial: CARD_TIPS_ASK_TEXT.partial, negative: CARD_TIPS_ASK_TEXT.negative });
  }

  /** The production vouchers redeemed in the shift's written sales (`prepaidVouchersInfo`) — information, in no figure. */
  private voucherInfo(shiftId: string): VoucherInfoTotals {
    return voucherInfoOf(
      this.svc.ledger
        .docsOfShift(shiftId)
        .filter((d) => settled(d) && isSaleType(d.documentType))
        .map((d) => d.prepaidVouchers ?? []),
    );
  }

  private withVouchers(till: ReturnType<typeof buildXTill>['till'], shiftId: string) {
    const info = this.voucherInfo(shiftId);
    return voucherInfoEmpty(info) ? till : { ...till, prepaidVouchersInfo: voucherInfoJson(info) };
  }

  /** The X's `till` with the shift's Cash In / Out / deposits and wallets (only when not zero), as the close freezes them. */
  private withDrawer(till: ReturnType<typeof buildXTill>['till'], shiftId: string) {
    const t: { movements: CashMovementTotals; wallets: WalletTotals } = this.drawer.service.shiftTotals(shiftId);
    return tillWithDrawer(till, t.movements, t.wallets);
  }

  /** The open shift's expected drawer now (spec §8), with its movements and wallets; null with no shift. */
  private expectedNow(): number | null {
    const shift = this.svc.ledger.currentShift();
    if (!shift) return null;
    return ofShekels(this.xFigures(shift.id).till.expectedCash);
  }

  /** The shift closed with the counted cash: X frozen into the close and printed, the documents flushed (no gate: the callers' own). */
  private closeNow(user: RosterUser, counted: number, choice: CardTipsChoice | null = null) {
    return this.withTipsChoice(choice, () => this.closeNowWith(user, counted));
  }

  private closeNowWith(user: RosterUser, counted: number) {
    const closed = this.svc.ledger.closeShift({
      closedByName: displayName(user),
      closedByUserId: user.id,
      vatRate: this.svc.vatRate(),
      countedCashAgorot: counted,
      now: new Date(this.nowFn()),
      tillExtra: (till, shiftId) => this.tillFigures(till, shiftId),
    });
    if (closed.kind === 'pending') return refuse('checkout_busy', WORDS.pendingBlocksClose(closed.count));
    if (closed.kind === 'none') return refuse('shift_closed');
    const fig = this.xFigures(closed.shift.id);
    // "מגירת מזומן": the close's count as a count movement (spec §9) — counted, expected, variance, who.
    this.drawer.service.recordCount(counted, this.drawer.service.settings().blindCount, null, { expectedAgorot: ofShekels(fig.till.expectedCash), shiftId: closed.shift.id });
    // The internal shift of an independent till has no paper of its own: its Z is the paper.
    if (!this.shiftsHidden()) {
      this.svc.printX({
        refId: `x:${closed.shift.id}`,
        cashierName: displayName(user),
        shiftNumber: closed.shift.sequence_number,
        businessDate: closed.shift.business_date,
        openedAt: new Date(closed.shift.opened_at),
        closedAt: new Date(closed.shift.closed_at ?? this.nowFn()),
        till: fig.till,
        countedCash: counted / 100,
      });
    }
    void this.svc.sync.flush();
    const report = this.xReportOf(fig.till, closed.shift.sequence_number, true);
    return { ...report, countedCashAgorot: counted, differenceAgorot: counted - report.expectedCashAgorot, message: this.svc.outbox.count() === 0 ? WORDS.shiftClosedSynced : WORDS.shiftClosedQueued };
  }

  private shiftClose(counted: unknown, keepHeld: boolean, choice: CardTipsChoice | null = null) {
    const user = this.signedIn();
    if (this.shiftsHidden()) this.noShiftsHere();
    const shift = this.svc.ledger.currentShift();
    if (!shift) return refuse('shift_closed');
    if (this.cart.length > 0 || this.checkout.phase !== 'idle') refuse('checkout_busy');
    if (!isInt(counted, 0, 100_000_000)) refuse('invalid_args');
    const pendingDocs = this.svc.ledger.pendingInShift(shift.id);
    if (pendingDocs > 0) refuse('checkout_busy', WORDS.pendingBlocksClose(pendingDocs));
    return this.gate(PERM.SHIFT_CLOSE, () => {
      this.heldGate(keepHeld);
      this.askTipsChoice(shift.id, choice);
      return this.closeNow(user, counted as number, choice);
    });
  }

  private xReportOf(t: ReturnType<typeof buildXTill>['till'], number: number | null, showDrawerCash: boolean): XReport {
    const a = (shekels: number) => ofShekels(shekels);
    return {
      shiftNumber: number,
      salesCount: t.transactionsCount,
      salesAgorot: a(t.totalSales - t.totalDiscounts - t.totalRefunds),
      cashAgorot: a(t.totalCash),
      cardAgorot: a(t.totalCard),
      expectedCashAgorot: a(t.expectedCash),
      demo: false,
      openingCashAgorot: a(t.openingCash),
      discountsAgorot: a(t.totalDiscounts),
      refundsAgorot: a(t.totalRefunds),
      vatAgorot: a(t.vatTotal ?? 0),
      tipsAgorot: a(t.totalTips),
      itemsCount: t.itemsCount,
      ...(t.cashIn ? { cashInAgorot: a(t.cashIn) } : {}),
      ...(t.cashOut ? { cashOutAgorot: a(t.cashOut) } : {}),
      ...(t.deposits ? { depositsAgorot: a(t.deposits) } : {}),
      ...(t.walletIn ? { walletInAgorot: a(t.walletIn) } : {}),
      ...(t.walletDeposits ? { walletDepositsAgorot: a(t.walletDeposits) } : {}),
      ...(t.totalDeviceCash ? { deviceCashAgorot: a(t.totalDeviceCash) } : {}),
      ...(t.totalVouchers ? { vouchersAgorot: a(t.totalVouchers) } : {}),
      ...(typeof t.cardTipsFromDrawer === 'number' ? { cardTipsFromDrawerAgorot: a(t.cardTipsFromDrawer), cardTipsUnpaidAgorot: a(t.cardTipsUnpaid ?? 0), drawerCashAgorot: a(t.drawerCash ?? 0) } : {}),
      ...(t.cardTipsNeedsChoice ? { cardTipsNeedsChoice: true } : {}),
      // "מזומן במגירה" (x-z-cash-with-tips §1): always; total / short only where the expected cash may be seen.
      cashBlock: xCashBlock(t, showDrawerCash).map((l) => ({ key: l.key, label: l.label, amountAgorot: l.agorot, bold: l.bold, warn: l.warn })),
      ...(t.prepaidVouchersInfo ? { voucherInfo: voucherInfoLines(voucherInfoFromJson(t.prepaidVouchersInfo)) } : {}),
    };
  }

  /** "דוח X סניפי" is on this till (`shopXTills`, core/till/shopX.ts). */
  private shopXHere(): boolean {
    return shopXOffered(this.svc.cloud.parameters(), this.svc.cloud.credentials()?.machineId ?? null);
  }

  /**
   * "דוח X סניפי" (P:/specs/shop-x-report.md §6): the cloud's report — `GET` as it stands, `POST` with `refresh` (the
   * till's own documents sent first, the other tills asked) — on SHOP_X_REPORT (a manager's code where the role asks for
   * one: the cloud hears the approver as `X-Pos-User-Id`). `print`: the one on screen to the receipt printer. Offline:
   * the till's own X stays (§2.4). Nothing changes here — not a document, no number.
   */
  private shopX(refresh: boolean, print: boolean, scope?: 'shop' | 'area') {
    const user = this.signedIn();
    if (!this.shopXHere()) return refuse('permission_denied', SHOP_X_TEXT.notHere);
    // "X לנקודת המכירה" (P:/specs/chain-areas.md §11.2d): only the tills of this till's point of sale; none — refused.
    const area = scope === 'area';
    if (area && !this.svc.areaIdHere()) return refuse('permission_denied', 'הקופה אינה משויכת לנקודת מכירה');
    if (print) {
      if (!this.shopXDoc) return refuse('invalid_args');
      this.svc.printShopX(this.shopXDoc.doc, `shopx:${this.shopXDoc.at}`);
      this.toast(SHOP_X_TEXT.printed, 'ok');
      return { printed: true };
    }
    if (this.shopXBusy) return refuse('checkout_busy', 'הדוח כבר בדרך');
    return this.gate(PERM.SHOP_X, async (approver) => {
      const who = approver ?? { id: user.id, name: displayName(user) };
      const machine = this.svc.cloud.credentials()?.machineId;
      if (!machine) return refuse('permission_denied', SHOP_X_TEXT.needsCloud);
      this.shopXBusy = true;
      this.shopXError = null;
      this.refresh();
      try {
        if (refresh) await this.svc.sync.flush().catch(() => undefined);
        const headers = { 'X-Pos-User-Id': who.id };
        const path = `sync/${machine}/shop-x`;
        const r = refresh
          ? await this.svc.api.post(path, { posUserName: displayName(user), refresh: true, outbox: { documents: this.svc.outbox.count() }, ...(area ? { scope: 'area' } : {}) }, { headers, timeoutMs: 90_000 })
          : await this.svc.api.get(area ? `${path}?scope=area` : path, { headers, timeoutMs: 45_000 });
        if (r.kind === 'offline') {
          this.shopXError = SHOP_X_TEXT.needsCloud;
          return refuse('permission_denied', SHOP_X_TEXT.needsCloud);
        }
        if (r.kind === 'refused') {
          this.shopXError = shopXRefusal(r.status, r.body);
          return refuse('permission_denied', this.shopXError);
        }
        const body = (r.body ?? {}) as Record<string, unknown>;
        const doc = shopXDocumentOf(body.printDocument);
        if (!doc || body.available === false) {
          this.shopXError = SHOP_X_TEXT.failed;
          return refuse('permission_denied', SHOP_X_TEXT.failed);
        }
        this.shopXDoc = { doc, at: this.nowFn() };
        this.shopXScope = area ? 'area' : 'shop';
        return { ok: true };
      } finally {
        this.shopXBusy = false;
        this.refresh();
      }
    });
  }

  private reportX() {
    const user = this.signedIn();
    if (this.shiftsHidden()) this.noShiftsHere();
    const shift = this.svc.ledger.currentShift();
    if (!shift) return refuse('shift_closed');
    return this.gate(PERM.X, () => {
      const fig = this.xFigures(shift.id);
      this.svc.printX({
        refId: `x:${shift.id}:${this.nowFn()}`,
        cashierName: displayName(user),
        shiftNumber: shift.sequence_number,
        businessDate: shift.business_date,
        openedAt: new Date(shift.opened_at),
        closedAt: null,
        till: fig.till,
        countedCash: null,
        // "ספירה עיוורת": the interim X does not state the expected cash.
        blindCount: this.drawer.service.settings().blindCount,
      });
      return { ...this.xReportOf(fig.till, shift.sequence_number, !this.drawer.service.settings().blindCount), printed: true };
    });
  }

  /**
   * "הפק Z" (Android TillZRepository): only where this till makes its own Z (zMode = till). An open shift is closed first
   * (counted, X printed), then the machine's Z through tillZService — the one path that numbers a Z, strictly sequential,
   * offline-safe. In the shop's Z mode closing the shift is all this till does. The held sales are asked about first.
   */
  private async zProduce(counted: unknown, keepHeld: boolean, choice: CardTipsChoice | null = null) {
    const user = this.signedIn();
    if (zModeOf(this.svc.cloud.heartbeat().zMode) !== 'till') refuse('permission_denied', WORDS.zDisabled);
    if (this.checkout.phase !== 'idle' || this.cart.length > 0) refuse('checkout_busy');
    return this.gate(PERM.Z, async () => {
      this.heldGate(keepHeld);
      const open = this.svc.ledger.currentShift();
      if (open) {
        // "משמרת #N פתוחה. היא תיסגר קודם": counted, X printed, then the Z (the Z's own permission covers the close).
        if (!isInt(counted, 0, 100_000_000)) refuse('invalid_args', WORDS.zConfirmOpenShift(open.sequence_number));
        const pendingDocs = this.svc.ledger.pendingInShift(open.id);
        if (pendingDocs > 0) refuse('checkout_busy', WORDS.pendingBlocksClose(pendingDocs));
        this.askTipsChoice(open.id, choice);
        this.closeNow(user, counted as number, choice);
        // The close must be on the cloud before its Z (a flush already under way may have missed it: again, a few times).
        for (let i = 0; i < 3 && this.svc.ledger.closingCount() > 0; i++) await this.svc.sync.flush();
      }
      if (this.svc.isOffline) refuse('engine_offline', WORDS.zNeedsConnection);
      const z = await this.svc.tillZ.produce(displayName(user), false);
      if (z.kind === 'produced') {
        const n = Number(z.z.machineSequenceNumber ?? z.z.zNumber);
        this.lastZNumber = Number.isFinite(n) ? n : this.lastZNumber;
        return { zNumber: this.lastZNumber, message: WORDS.zDone(n) };
      }
      if (z.kind === 'refused') return refuse('invalid_args', z.refusal === 'nothing_to_report' ? WORDS.zNothing : WORDS.zCloudError);
      if (z.kind === 'waiting') return refuse('invalid_args', WORDS.zNotAccepted);
      if (z.kind === 'offline') return refuse('engine_offline', WORDS.zNeedsConnection);
      return refuse('invalid_args', WORDS.zCloudError);
    });
  }

  /**
   * The owner's rule (10.10.2026): an INDEPENDENT till (`independentTill` from the cloud, Z on the till) has no shifts in its UI —
   * the shift opens silently on the first sale (float 0) and is closed inside "הפק Z". The till parameter `independentTillZOnly`
   * (default on; read when present) can give the shift screens back. Shop-Z and own-Z tills keep the normal shift flow.
   */
  private shiftsHidden(): boolean {
    const beat = this.svc.cloud.heartbeat();
    if (beat.independentTill !== true || zModeOf(beat.zMode) !== 'till') return false;
    const p = this.svc.cloud.parameters().independentTillZOnly;
    return p === undefined || p === null || p === '' ? true : parameterOn(p);
  }

  /** The shift a sale is written in: the open one, or — on an independent till — one opened now by the first sale. */
  private ensureShift(): boolean {
    if (this.svc.ledger.currentShift()) return true;
    if (!this.shiftsHidden()) return false;
    this.svc.ledger.openShift(this.operator(), new Date(this.nowFn()), 0);
    return true;
  }

  /* --------------------------------------------------- the automatic close */

  /** The till's sale as the automatic close looks at it. */
  autoCloseLook(): AutoCloseSaleLook {
    const c = this.checkout;
    return {
      cardInFlight: this.svc.pay.cardInFlight || c.phase === 'card_waiting' || c.phase === 'card_unknown' || c.phase === 'device_waiting' || c.phase === 'device_unknown',
      checkoutOpen: c.phase !== 'idle',
      paymentTaken: c.phase === 'done' || c.legs.length > 0 || c.docId !== null,
      basketOpen: this.cart.length > 0,
      tableOpen: false,
    };
  }

  /**
   * `hold` / `discard` (AutoCloseSale): the payment screen backed out first when [abandon] and nothing was taken; a basket
   * with returns stays where it is (kept). Null when nothing could be handled now (looked at again on the next tick).
   */
  private autoCloseHandle(holds: boolean, abandon: boolean): AutoCloseCart | null {
    const c = this.checkout;
    if (c.phase !== 'idle') {
      if (!abandon || c.legs.some((l) => !l.external) || c.docId !== null) return null;
      this.vouchers.abandon();
      const kiosk = c.kioskOrder;
      this.checkout = idleCheckout();
      this.pending = null;
      // A kiosk order on the payment: back to the list (its basket is the kiosk's, never parked here).
      if (kiosk) {
        this.kioskOrders.abandoned();
        this.clearBasket();
        return null;
      }
    }
    if (this.cart.length === 0) return null;
    const p = this.priced();
    const items = this.cart.map((rec) => ({ name: p.lines.find((l) => l.key === rec.lineId)?.name ?? rec.name ?? rec.productId, quantity: rec.qty }));
    const itemCount = Math.ceil(this.cart.reduce((s, l) => s + l.qty, 0));
    const amount = p.netAgorot;
    const cashierId = this.cashier?.id ?? null;
    if (this.cart.some((l) => l.refund)) {
      return { action: 'kept', items, itemCount, amountAgorot: amount, heldSaleId: null, cashierId, paymentAbandoned: abandon, keptReason: 'refund_lines' };
    }
    if (holds) {
      const byKey = new Map(p.lines.map((l) => [l.key, l] as const));
      const lines: HeldLine[] = this.cart.map((rec) => {
        const l = byKey.get(rec.lineId);
        return {
          id: rec.lineId,
          productId: rec.productId,
          name: l?.name ?? rec.name ?? rec.productId,
          qty: rec.qty,
          unitAgorot: l ? unitAgorot(l) : (rec.keptUnitAgorot ?? 0),
          discount: rec.discount ?? null,
          oth: rec.oth ?? null,
          ...(rec.choices ? { choices: rec.choices, baseAgorot: l ? l.basePriceAgorot : (rec.keptUnitAgorot ?? 0) } : {}),
        };
      });
      const total = p.lines.reduce((s, l) => s + lineGross(l) - (l.discountAgorot ?? 0), 0);
      const id = this.held.hold(lines, { id: cashierId ?? '', name: this.cashier ? displayName(this.cashier) : null }, AUTO_CLOSE_PARK_LABEL, total);
      if (!id) return { action: 'kept', items, itemCount, amountAgorot: amount, heldSaleId: null, cashierId, paymentAbandoned: abandon, keptReason: 'hold_failed' };
      if (this.cartDiscount || this.discountApprover) this.parkedExtras.set(id, { discount: this.cartDiscount, approver: this.discountApprover });
      this.clearBasket();
      return { action: 'held', items, itemCount, amountAgorot: total, heldSaleId: id, cashierId, paymentAbandoned: abandon, keptReason: null };
    }
    this.clearBasket();
    return { action: 'discarded', items, itemCount, amountAgorot: amount, heldSaleId: null, cashierId, paymentAbandoned: abandon, keptReason: null };
  }

  /**
   * The till's automatic close (CloseShiftCoordinator.closeIfDue with AutoCloseOpenCart): at `autoCloseShiftAt`, never in
   * the middle of a card; the basket by `autoCloseOpenCart` (wait / hold / discard), the held sales by
   * `autoCloseHeldSales`, a payment waited for up to `autoCloseMaxWaitMin`. Each step said in the till's journal (till
   * events); the next shift is told once. A Z-only till: the Z follows (as the kiosk's automatic close).
   */
  async autoCloseTick(nowMs: number = this.nowFn()): Promise<AutoCloseRecord | null> {
    if (this.autoCloseBusy || this.stopped || !this.svc.fiscal) return null;
    const params = this.svc.cloud.parameters();
    const at = autoCloseTimeOf(null, params.autoCloseShiftAt);
    if (!at) return null;
    const open = this.svc.ledger.currentShift();
    if (!open || !autoCloseDue(nowMs, at, Date.parse(open.opened_at))) {
      this.autoPaymentWait = null;
      return null;
    }
    this.autoCloseBusy = true;
    try {
      const rules = autoCloseRulesOf(params);
      const look = this.autoCloseLook();
      if (!look.cardInFlight && !look.checkoutOpen) this.autoPaymentWait = null;
      const waited = this.autoPaymentWait && this.autoPaymentWait.shiftId === open.id ? nowMs - this.autoPaymentWait.since : 0;
      const decision = autoCloseDecision(rules, look, waited, true);
      let cart: AutoCloseCart | null = null;
      if (decision.step === 'wait_payment') {
        if (this.autoPaymentWait?.shiftId !== open.id) this.autoPaymentWait = { shiftId: open.id, since: nowMs };
        this.log(`automatic close at ${at} waits: a payment is under way (${Math.floor(waited / 1000)}s of ${rules.maxWaitMin} min)`);
        return null;
      }
      if (decision.step === 'wait_cart') return null;
      if (decision.step === 'hold' || decision.step === 'discard') {
        // Before anything is touched: a document still being written holds the close as always.
        if (this.svc.ledger.pendingInShift(open.id) > 0) return null;
        cart = this.autoCloseHandle(decision.step === 'hold', decision.abandonPayment);
        if (!cart) return null;
        const type = autoCloseCartEventType(cart.action);
        if (type) this.recordEvent(type, cart.cashierId, cart.amountAgorot, autoCloseCartDetails(cart, at, open.sequence_number), open.id);
      }
      // `autoCloseHeldSales` = `cancel`: the held sales cancelled — never the basket this close just parked.
      const cancelled: HeldSaleSummary[] = [];
      if (rules.held === 'cancel' && this.svc.ledger.pendingInShift(open.id) === 0) {
        for (const sale of this.held.all()) {
          if (sale.id === cart?.heldSaleId) continue;
          const summary = summaryOf(sale);
          if (!this.held.discard(sale.id)) continue;
          this.parkedExtras.delete(sale.id);
          this.recordEvent(TILL_EVENT_HELD_SALE_CANCELLED, null, summary.totalAgorot, heldSaleCancelDetails(summary, HELD_CANCEL_AUTO_CLOSE, `סגירה אוטומטית ב-${at}`, new Date(nowMs).toISOString()), open.id);
          cancelled.push(summary);
        }
        if (cancelled.length > 0) this.recordEvent(TILL_EVENT_AUTO_CLOSE_HELD_CANCELLED, null, cancelled.reduce((s, h) => s + h.totalAgorot, 0), autoCloseHeldCancelledDetails(cancelled, at), open.id);
      }
      // The close counts the expected cash (unattended by the till's own clock), the X frozen into it — with the drawer's
      // movements and wallets, as every close of this till.
      const closed = this.svc.ledger.closeShift({ closedByName: 'סגירה אוטומטית', vatRate: this.svc.vatRate(), now: new Date(nowMs), tillExtra: (till, shiftId) => this.withTipsChoice('partial', () => this.tillFigures(till, shiftId)) });
      if (closed.kind !== 'closed') return null;
      this.autoPaymentWait = null;
      const record: AutoCloseRecord = {
        shiftId: closed.shift.id,
        at,
        closedAt: closed.shift.closed_at,
        cart,
        heldCancelled: cancelled.length,
        heldCancelledAgorot: cancelled.reduce((s, h) => s + h.totalAgorot, 0),
        heldCarried: this.held.count(),
        tablesCarried: 0,
        overPayment: decision.overPayment,
        waitedMs: waited,
      };
      this.recordEvent(TILL_EVENT_SHIFT_AUTO_CLOSED, null, null, shiftAutoClosedDetails(record, rules), closed.shift.id);
      const kept = this.svc.kv.getJson<AutoCloseRecord[]>(AUTO_CLOSE_RECORDS) ?? [];
      this.svc.kv.setJson(AUTO_CLOSE_RECORDS, [...kept.filter((r) => r.shiftId !== record.shiftId), record].slice(-40));
      if (worthNotice(record)) this.svc.kv.setJson(AUTO_CLOSE_NOTICE, record);
      this.log(`automatic close at ${at}: shift ${closed.shift.id} closed`);
      void this.svc.sync.flush();
      // A Z-only till: the automatic close is a Z (the expected cash filed as the count, as always).
      if (this.shiftsHidden()) void this.svc.tillZ.produceOwed('סגירה אוטומטית').catch((e: unknown) => this.log(`automatic close: the Z did not start: ${String(e)}`));
      this.dirty = true;
      this.commit();
      return record;
    } finally {
      this.autoCloseBusy = false;
    }
  }

  /**
   * The cloud asked this till to close its shift (CloseShiftCoordinator.handleCloudRequest — a shop Z run's item, or the
   * dashboard): unattended, the request's id on the close (the cloud ties it to the run), the drawer's movements and the
   * vouchers on its X as every close of this till; a card under way or a document still pending holds it (`pending`). The
   * basket stays where it is (not a document). A Z-only till: its Z follows, as the automatic close's.
   */
  async remoteClose(requestId: string): Promise<'closed' | 'none' | 'pending'> {
    if (this.stopped || !this.svc.fiscal) return 'pending';
    if (this.svc.ledger.shiftByCloseRequest(requestId)) return 'closed';
    const c = this.checkout;
    if (this.svc.pay.cardInFlight || c.phase === 'card_waiting' || c.phase === 'card_unknown' || c.phase === 'device_waiting' || c.phase === 'device_unknown') return 'pending';
    const open = this.svc.ledger.currentShift();
    if (!open) return 'none';
    const closed = this.svc.ledger.closeShift({
      closedByName: 'סגירה מהענן',
      unattended: true,
      closeRequestId: requestId,
      vatRate: this.svc.vatRate(),
      now: new Date(this.nowFn()),
      tillExtra: (till, shiftId) => this.withTipsChoice('partial', () => this.tillFigures(till, shiftId)),
    });
    if (closed.kind === 'pending') return 'pending';
    if (closed.kind === 'none') return 'none';
    this.log(`cloud close ${requestId}: shift ${closed.shift.id} closed`);
    void this.svc.sync.flush();
    if (this.shiftsHidden()) void this.svc.tillZ.produceOwed('סגירה מהענן').catch((e: unknown) => this.log(`cloud close: the Z did not start: ${String(e)}`));
    this.dirty = true;
    this.commit();
    return 'closed';
  }

  /** The notice the shift opens with — never on the very shift it is about. */
  private autoCloseNotice(): { title: string; text: string } | null {
    const kept = this.svc.kv.getJson<AutoCloseRecord>(AUTO_CLOSE_NOTICE);
    if (!kept) return null;
    const open = this.svc.ledger.currentShift();
    if (!open || open.id === kept.shiftId) return null;
    const text = autoCloseNextShiftNotice(kept);
    return text ? { title: WORDS.autoCloseNoticeTitle, text } : null;
  }

  /* -------------------------------------------------------------------- mode */

  private modeSwitch(to: DeviceRoleName, managerCode: string | null) {
    const wm = this.attachedMode;
    if (to !== 'kiosk' || !wm || !wm.offered().toKiosk) return refuse('role_not_allowed');
    const user = this.signedIn();
    const refusal = wm.mayReturn();
    if (refusal) return refuse('mode_switch_busy', refusal.text, { reason: refusal.wire });
    const back = !wm.homeTill();
    const go = async (by: Approver) => {
      const r = await wm.returnToKiosk('manual', by.name, by.id);
      if (r) return refuse('mode_switch_busy', r.text, { reason: r.wire });
      // The employee's session ends with the till mode (Android: session.signOut).
      this.signOutNow();
      this.cart = [];
      return undefined;
    };
    const check = async (code: string) => {
      const m = await wm.checkManagerCode(code);
      return m.ok ? ({ ok: true, by: { id: m.id, name: m.name } } as const) : ({ ok: false, message: m.message } as const);
    };
    // Always a manager's code with KIOSK_TILL_MODE: the employee signed in counts when they hold it.
    if (stateOf(user, PERM.KIOSK_TILL_MODE) === 'allow') return go({ id: user.id, name: displayName(user) });
    if (managerCode) {
      return (async () => {
        const v = await check(managerCode);
        if (!v.ok) return refuse('wrong_pin', v.message);
        return go(v.by);
      })();
    }
    const title = back ? WORDS.workModeApproveBack : WORDS.workModeApproveToKiosk;
    this.openDialog({
      kind: 'manager_approval',
      title,
      body: '',
      fields: [{ name: 'pin', label: WORDS.managerCode, kind: 'pin' }],
      actions: [
        { id: 'approve', label: WORDS.approve, primary: true },
        { id: 'cancel', label: WORDS.cancel },
      ],
      code: null,
      // The runtime checks the code itself (KIOSK_TILL_MODE against the roster, with its own lock).
      verify: check,
      resume: (by) => (by ? go(by) : undefined),
    });
    return { dialogId: this.pending!.dialog.id };
  }

  /* ------------------------------------------------------------------- state */

  /** The product has something its sheet chooses (groups, a meal, note chips) — its line may be opened again. */
  private configurable(productId: string): boolean {
    const cat = this.svc.tillCatalogData();
    return (cat.groups[productId] ?? []).length > 0 || (cat.meals[productId] ?? []).length > 0 || (cat.quickNotes[productId] ?? []).length > 0;
  }

  private cartView(): { lines: CartLine[]; priced: Priced | null } {
    if (this.cart.length === 0) return { lines: [], priced: null };
    // After a payment opened, what it was priced from; else the cart as priced now.
    const f = this.checkout.frozen;
    const p: Priced =
      f && this.checkout.phase !== 'idle'
        ? {
            ...f,
            gone: [],
            refunds: f.refunds ?? [],
            saleTotalAgorot: f.lines.length > 0 ? f.totals.totalAgorot : 0,
            refundTotalAgorot: (f.refunds ?? []).reduce((s, r) => s + r.totalAgorot, 0),
            netAgorot: (f.lines.length > 0 ? f.totals.totalAgorot : 0) - (f.refunds ?? []).reduce((s, r) => s + r.totalAgorot, 0),
            lineDiscountsAgorot: f.lines.filter((l) => !l.oth).reduce((s, l) => s + (l.discountAgorot ?? 0), 0),
            othAgorot: f.lines.filter((l) => l.oth).reduce((s, l) => s + (l.discountAgorot ?? 0), 0),
            nonDiscountableAgorot: 0,
          }
        : this.priced();
    const refundsByKey = new Map(p.refunds.map((r) => [r.rec.lineId, r] as const));
    // A ₪0 voucher line's value (core/till/vouchers.ts): shown beside its mark, outside every total.
    const memo = offVoucherLineValues(p.prepaid ?? []);
    const lines: CartLine[] = [];
    for (const rec of this.cart) {
      const r = refundsByKey.get(rec.lineId);
      if (r) {
        lines.push({
          lineId: rec.lineId,
          productId: rec.productId,
          name: r.line.name,
          qty: rec.qty,
          unitAgorot: unitAgorot(r.line),
          discountPct: 0,
          totalAgorot: r.totalAgorot,
          refund: true,
          fromReceipt: rec.receipt?.documentNumber ?? null,
        });
        continue;
      }
      // The line and the lines a voucher split off it (its covered units at their voucher price, "l1~v0").
      for (const l of p.lines.filter((x) => x.key === rec.lineId || x.key.startsWith(`${rec.lineId}~v`))) {
        const unit = unitAgorot(l);
        const hand = l.discountAgorot ?? 0;
        const own = l.key === rec.lineId;
        lines.push({
          lineId: l.key,
          productId: rec.productId,
          name: l.name,
          qty: l.qty,
          unitAgorot: unit,
          discountPct: own ? (rec.oth ? 100 : rec.discount?.type === 'percentage' ? rec.discount.value / 100 : 0) : 0,
          totalAgorot: lineNet(l),
          ...(hand > 0 ? { discountAgorot: hand } : {}),
          ...(own && rec.oth ? { oth: rec.oth.reason } : {}),
          ...(l.noDiscount ? { noDiscount: true } : {}),
          ...(l.voucherMark ? { voucher: l.voucherMark } : {}),
          ...(memo.has(l.key) ? { voucherValueAgorot: memo.get(l.key)! } : {}),
          ...(() => {
            const words = lineWords({ options: l.options, meal: l.meal ? { components: l.meal.components } : null, notes: l.notes, important: l.important, allergies: l.allergies });
            return words.length > 0 ? { subLines: words } : {};
          })(),
          // "עריכת המנה": the line's own (not a voucher's split) with something to choose.
          ...(own && rec.choices && this.configurable(rec.productId) ? { choices: { ...rec.choices } } : {}),
        });
      }
    }
    return { lines, priced: p };
  }

  /** The payment's vouchers as the screens show them. */
  private voucherView(f: Frozen, due: number) {
    const v = this.vouchers.state(f.lines, due, f.voucherOutcomes ?? []);
    const goods = [...offVoucherLineValues(f.prepaid ?? []).values()].reduce((s, x) => s + x, 0);
    return { ...v, deductionAgorot: f.totals.prepaidDeductionAgorot ?? 0, goodsValueAgorot: goods };
  }

  private sessionHidden(): string[] {
    const role = this.roleProfile();
    if (!role) return [];
    const settings = this.deniedSettings();
    return ENTRIES.filter(([code, kind]) => !shows(role, code, settings, kind, code === PERM.REFUND && !!this.refundGrant)).map(([code]) => code);
  }

  private basketState(): CheckoutBasket | null {
    const b = this.checkout.basket;
    if (!b) return null;
    return {
      saleAgorot: b.saleAgorot,
      refundAgorot: b.refundAgorot,
      netAgorot: b.netAgorot,
      payoutAgorot: b.netAgorot < 0 ? -b.netAgorot : 0,
      hasUnlinked: b.hasUnlinked,
      step: b.step,
      customer: { ...b.customer, required: b.customerRequired },
      payoutRoute: b.route.kind,
      ...(b.handedBackAgorot > 0 ? { handedBackAgorot: b.handedBackAgorot } : {}),
    };
  }

  private buildState(): TillState {
    const user = this.cashier;
    const view = this.cartView();
    // A line the catalog no longer sells is dropped from the cart the next time it is looked at (never mid-payment).
    const gone = view.priced?.gone ?? [];
    if (gone.length > 0 && this.checkout.phase === 'idle') {
      this.cart = this.cart.filter((l) => !gone.includes(l.lineId));
    }
    const p = view.priced;
    const c = this.checkout;
    const approved = this.approvedLegs();
    const paid = paidOf(approved);
    const shift = this.svc.ledger.currentShift();
    const last = this.svc.ledger.lastClosedShift();
    const fig = shift ? this.xFigures(shift.id).till : null;
    const zMode = zModeOf(this.svc.cloud.heartbeat().zMode);
    const lastZ = this.svc.tillZ.list(1)[0]?.number ?? this.lastZNumber;
    const wm = this.attachedMode;
    const offered = wm?.offered() ?? { toTill: false, toKiosk: false };
    const homeTill = wm ? wm.homeTill() : true;
    const permissions = user ? SESSION_CODES.filter((code) => stateOf(user, code) !== 'deny') : [];
    const health = this.svc.printQueue.health();
    const terminal = this.svc.pay.cardInFlight ? 'busy' : this.svc.pay.configured && this.svc.pay.monitor.state !== 'unreachable' ? 'ok' : 'none';
    // A cash device taking the money shows as money in flight; its lost answer, as the card's, on the tenders.
    const checkoutPhase: CheckoutState['phase'] = c.phase === 'card_unknown' || c.phase === 'device_unknown' ? 'tender' : c.phase === 'device_waiting' ? 'card_waiting' : c.phase;
    const device = c.phase === 'idle' ? null : this.deviceCash.checkoutView();
    const dialog = this.pending?.dialog ?? null;
    const params = this.svc.cloud.parameters();
    const oth = othSettingsOf(params);
    const net = p ? p.netAgorot : 0;
    const vatOfNet = net === 0 ? 0 : net - vatNet(net, this.svc.vatRate());
    const hidden = this.sessionHidden();
    const basket = this.basketState();
    const state: TillState = {
      protocol: TILL_PROTOCOL,
      session: {
        cashier: user && !this.locked ? { id: user.id, name: displayName(user) } : null,
        locked: this.locked || !user,
        permissions,
        demo: false,
        ...(hidden.length > 0 ? { hidden } : {}),
      },
      sell: {
        catalogVersion: this.catalogVersion(),
        departmentId: this.department,
        search: this.search,
        lines: view.lines,
        itemCount: view.lines.reduce((s, l) => s + l.qty, 0),
        totalAgorot: net,
        vatAgorot: p && p.refunds.length === 0 ? p.totals.vatAgorot : vatOfNet,
        promotionsAgorot: p ? p.lines.reduce((s, l) => s + (l.promotionAgorot ?? 0), 0) : 0,
        ...(this.refundMode ? { refundMode: true } : {}),
        ...(this.refundChooser ? { refundChooser: true } : {}),
        ...(p && p.refunds.length > 0 ? { saleTotalAgorot: p.saleTotalAgorot, refundTotalAgorot: p.refundTotalAgorot } : {}),
        ...(this.cartDiscount && p
          ? {
              basketDiscount: {
                amountAgorot: p.basketDiscountAgorot ?? 0,
                type: this.cartDiscount.type,
                value: this.cartDiscount.value,
                ...(this.cartDiscount.preset ? { preset: { id: this.cartDiscount.preset.id, name: this.cartDiscount.preset.name, for: this.cartDiscount.preset.for } } : {}),
              },
            }
          : {}),
        ...(p && p.lineDiscountsAgorot > 0 ? { lineDiscountsAgorot: p.lineDiscountsAgorot } : {}),
        ...(p && p.othAgorot > 0 ? { othAgorot: p.othAgorot } : {}),
        ...(p && p.nonDiscountableAgorot > 0 ? { nonDiscountableAgorot: p.nonDiscountableAgorot } : {}),
        choicesAuto: { addOns: paramOn(params[PARAM_MODIFIERS_AUTO_OPEN]), notes: paramOn(params[PARAM_NOTES_AUTO_OPEN]) },
      },
      checkout: {
        phase: checkoutPhase,
        totalAgorot: c.phase === 'idle' ? 0 : c.totalAgorot,
        paidAgorot: c.phase === 'done' ? c.totalAgorot : paid,
        dueAgorot: c.phase === 'idle' || c.phase === 'done' ? 0 : dueOf(c.totalAgorot, approved),
        changeAgorot: c.changeAgorot,
        legs: c.legs.map((l) => ({ method: l.method, amountAgorot: l.amountAgorot, status: l.status, ...(l.credit ? { credit: l.credit } : {}), ...(l.voucher ? { voucher: { serial: l.voucher.serial } } : {}) })),
        documentRef: c.documentRef,
        documentId: c.phase === 'done' ? c.docId : null,
        tenderedAgorot: c.phase === 'done' ? c.tenderedAgorot : handedTotal(approved),
        askPrint: c.askPrint,
        printWarning: c.printWarning,
        kitchenWarning: c.phase === 'done' ? c.kitchenWarning : null,
        cardStatus: c.cardStatus,
        cardError: c.phase === 'card_unknown' ? (c.cardError ?? WORDS.cardPending) : c.cardError,
        // §13: while the terminal works deferred — "⚠ מצב לא מקוון: כרטיסי תייר (חו״ל), כרטיסי דיירקט וכרטיסי דביט לא יעברו…".
        ...(() => {
          const notice = c.phase === 'tender' || c.phase === 'card_waiting' ? this.transmission.notices().cashier : null;
          return notice ? { deferredNotice: notice } : {};
        })(),
        cardUnknown: c.phase === 'card_unknown',
        ...(basket ? { basket } : {}),
        ...(c.phase === 'done' && c.docIds.length > 1
          ? {
              documentRefs: c.docIds.map((id) => this.svc.docNumberOf(id) ?? id),
            }
          : {}),
        ...(c.phase !== 'idle' && c.phase !== 'done' && !c.basket && c.frozen ? { vouchers: this.voucherView(c.frozen, dueOf(c.totalAgorot, approved)) } : {}),
        ...(c.testEnd ? { testEnd: c.testEnd } : {}),
        ...(c.phase === 'done' && c.voucherSuccess ? { voucherSuccess: c.voucherSuccess } : {}),
        ...(device ? { deviceCash: device } : {}),
      },
      shift: {
        hidden: this.shiftsHidden(),
        open: !!shift,
        number: shift?.sequence_number ?? last?.sequence_number ?? null,
        openedAt: shift?.opened_at ?? null,
        openingCashAgorot: shift?.opening_cash ?? 0,
        salesCount: fig?.transactionsCount ?? 0,
        salesAgorot: fig ? ofShekels(fig.totalSales - fig.totalDiscounts - fig.totalRefunds) : 0,
        cashAgorot: fig ? ofShekels(fig.totalCash) : 0,
        cardAgorot: fig ? ofShekels(fig.totalCard) : 0,
      },
      z: {
        lastNumber: lastZ ?? null,
        canProduce: zMode === 'till',
        reason: zMode === 'till' ? null : WORDS.zDisabled,
        zMode: zMode === 'till' ? 'till' : 'shop',
      },
      health: {
        cloud: this.svc.isOffline ? 'offline' : 'online',
        printer: health === 'ok' ? 'ok' : health === 'unknown' ? 'none' : 'error',
        terminal,
        ...(this.svc.pay.noCard ? { noCard: true } : {}),
        outbox: this.svc.outbox.count(),
      },
      dialog,
      menuHidden: parseHiddenMenu(params[HIDDEN_MENU_PARAM]),
      ...(user && !this.locked ? { menu: this.menu.state() } : {}),
      ...(user && !this.locked && this.kiosks.count() > 0 ? { kiosks: this.kiosks.state() } : {}),
      ...(user && !this.locked ? { menuOffers: { shopZ: this.shopZ.menuShown([]), cloudZ: this.cloudZ.available() } } : {}),
      // The design's `look` over the tile-text parameters (Android applyTillDesign).
      tileText: tileTextOf(designParameters(params, this.design.config())),
      // "הכל" in the order's categories (Android SellAllTab: hidden unless the parameter says first / last).
      sellAllTab: parseSellAllTab(params[PARAM_SELL_ALL_TAB]),
      design: this.design.state({
        parameters: params,
        tenders: tendersOf(params, !this.svc.pay.noCard),
        presets: this.presetDiscounts().presets.map((p) => ({ id: p.id, name: p.name })),
        totalAgorot: net,
      }),
      theme: themeOf(this.design.config(), params, this.svc.cloud.settings().settings),
      drawer: this.drawer.state(),
      users: this.sessions.state(),
      owed: this.cash.state(),
      shopX: {
        offered: this.shopXHere(),
        report: this.shopXDoc?.doc ?? null,
        at: this.shopXDoc?.at ?? null,
        busy: this.shopXBusy,
        error: this.shopXError,
        areaName: this.svc.areaIdHere() ? (this.svc.areaHere()?.name ?? 'נקודת המכירה') : null,
        scope: this.shopXScope,
      },
      mode: {
        role: (homeTill ? 'till' : 'kiosk') as DeviceRoleName,
        current: 'till',
        rolesAllowed: offered.toKiosk ? ['kiosk'] : [],
        switchLabel: homeTill ? WORDS.workModeMenuToKiosk : WORDS.workModeMenuBack,
        countdownSec: wm?.countdownSec() ?? null,
      },
      held: {
        count: this.held.count(),
        sales: this.held.summaries().map((h) => ({ id: h.id, label: h.label, at: h.at, cashier: h.cashier, itemCount: h.itemCount, totalAgorot: h.totalAgorot, items: h.items })),
        keepAllowed: allowCloseWithHeldSales(params),
      },
      oth: { enabled: oth.enabled, requiresManager: oth.requiresManager, reasons: oth.reasons },
      ...(() => {
        const presets = user && !this.locked ? this.presetDiscountsView() : null;
        return presets ? { presetDiscounts: presets } : {};
      })(),
      notice: user && !this.locked ? this.autoCloseNotice() : null,
      ...(() => {
        const order = this.orderView();
        return order ? { order } : {};
      })(),
      ...(this.transmissionShown && user ? { transmission: this.transmission.view() } : {}),
      ...(() => {
        const q = user ? this.printQueue.view() : undefined;
        return q ? { printQueue: q } : {};
      })(),
      ...(() => {
        const banner = user ? this.transmission.banner() : null;
        return banner ? { terminalOffline: banner } : {};
      })(),
    };
    // The feature modules' slices (each omitted while it says nothing).
    for (const f of this.features) {
      const v = f.state();
      if (v !== undefined) (state as unknown as Record<string, unknown>)[f.key] = v;
    }
    return state;
  }

  /** Whether a payment, a cart or a question is open (the update and the mode switch wait for it). */
  get busy(): boolean {
    return this.cart.length > 0 || this.checkout.phase !== 'idle' || this.pending !== null || this.svc.pay.cardInFlight;
  }

  get lastActivity(): number {
    return this.lastActivityAt;
  }

  /** A till document left pending by a crash or a restart mid-card: the sale is not lost, the answer is asked for. */
  private restorePending() {
    // A cash device's pending document is the device's to settle (tillDeviceCash.ts), never a card's.
    const doc = this.svc.ledger.pendingDocs().find((d) => d.channel === 'till' && !(d.payments ?? []).some((l) => l.device));
    if (!doc) return;
    const docs = doc.basketId ? this.svc.ledger.basketDocs(doc.basketId).filter((d) => d.status === 'pending') : [doc];
    const carrier = docs.find((d) => (d.payments ?? []).some((l) => l.method === 'card')) ?? doc;
    this.checkout = {
      ...idleCheckout(),
      phase: 'card_unknown',
      totalAgorot: carrier.totals.totalAgorot,
      docId: carrier.id,
      docIds: docs.map((d) => d.id),
      legs: (carrier.payments ?? [])
        .filter((l) => l.method !== EXCHANGE)
        .map((l) => ({
          method: l.method as 'cash' | 'card' | 'production_voucher',
          amountAgorot: l.amountAgorot,
          handedAgorot: l.method === 'cash' ? l.amountAgorot : 0,
          status: l.method === 'card' ? ('pending' as const) : ('approved' as const),
          ...(l.voucher ? { voucher: l.voucher } : {}),
        })),
      cardError: WORDS.cardPending,
      token: randomUUID(),
      kioskOrder: this.kioskOrders?.current() ?? null,
      frozen: {
        lines: carrier.lines,
        tracked: carrier.tracked,
        promotions: carrier.promotions ?? [],
        totals: carrier.totals,
        // Its vouchers as the document wrote them: a retry after a decline writes them again.
        restoredVouchers: {
          ...(carrier.voucherDiscounts ? { voucherDiscounts: carrier.voucherDiscounts } : {}),
          ...(carrier.voucherReleases ? { voucherReleases: carrier.voucherReleases } : {}),
          ...(carrier.prepaidVouchers ? { prepaidVouchers: carrier.prepaidVouchers } : {}),
        },
      },
    };
  }
}

/** A sale's tenders as the document keeps them: a cash credit's leg with its redemption, a production voucher's with its hold. */
function docLegs(legs: readonly TenderLeg[]) {
  return legs.map((l) => ({
    method: l.method,
    amountAgorot: l.amountAgorot,
    ...(l.method === 'cash_credit' && l.credit ? { cashCredit: l.credit } : {}),
    ...(l.method === 'production_voucher' && l.voucher ? { voucher: l.voucher } : {}),
  }));
}

/** The cash credits among the tenders: "זיכוי מזומן C-K7Q3MX" on the receipt. */
function creditLegsOf(legs: readonly TenderLeg[]) {
  return legs.flatMap((l) => (l.method === 'cash_credit' && l.credit ? [{ redemptionId: l.credit.redemptionId, code: l.credit.code, amountAgorot: l.amountAgorot }] : []));
}

export { quickNotes, permLabel };

/** The manager's answer to "כשאין מספיק מזומן לטיפים באשראי" sent with a close; anything else — none. */
function tipsChoiceOf(v: unknown): CardTipsChoice | null {
  return v === 'partial' || v === 'negative' ? v : null;
}
