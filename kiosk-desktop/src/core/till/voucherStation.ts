/**
 * "עמדת שובר" — the Android till's voucher station (pos-android domain/VoucherStation.kt, VoucherStationBasket.kt,
 * VoucherStationDiscount.kt, VoucherStationPicker.kt, VoucherStationSale.kt, ui/sell/VoucherStationScreen.kt) as pure rules:
 *
 *  - `voucherStation` (off — the default — / on): the sell screen is a voucher station — "סרקו שובר" (and "הקלדת קוד" when
 *    typing is on); a voucher scanned shows what it entitles ("תנאי המימוש") and its own picker; "יציאה למסך רגיל" from the
 *    menu (`voucherStationCatalogSwitch` off / manager — a manager's code, KIOSK_TILL_MODE — / free) and back;
 *  - more vouchers in one sale while the sale's stacking lets them ("סריקת שובר נוסף");
 *  - `voucherStationPaidItems` ("רכישה נוספת בתשלום בעמדת שובר"): one smart basket — the whole catalog, each tap to a voucher
 *    while one takes it (eligible, a group with room, its total and per-sale limit not used up, never twice where a group
 *    forbids it — in the order added), else a paid line; a tap on a basket row moves it between "בשובר" and "בתשלום"; a bar
 *    that says what the vouchers took, a package's missing part, the entitlement left, what is to pay; one primary button;
 *  - a discount voucher: an item discount opens a picker of the products its benefit targets; an order discount has nothing
 *    to choose (said, or the basket when it is on); with items already in the order — the till's own discount at the payment;
 *  - "מצב בדיקה": the orange bar, never with paid items or a real voucher.
 * The vouchers stay pending allocations until the payment — which looks them up again, holds and books them by the till's own
 * voucher flow (main/till/tillVouchers.ts): one document per sale. Pure, so it is tested.
 */

import { stackingBeforeScan } from '@dash-lib/kioskVoucherClient';
import { stackingRefusal, stackingText, VOUCHER_SAME_BATCH, type VoucherBenefit, type VoucherInSale, type VoucherKind } from '@dash-lib/kioskVouchers';
import { entitlementLeftMany, type EntitlementLeft } from '@dash-lib/voucherEntitlement';
import { checkSelection } from '@dash-lib/voucherGroups';
import { formatShekelSign } from '../money';
import { prepaidQtyText, quotaNumbers, type StampFormat } from './voucherBalance';
import { groupTakes, moneyText, unitLimit, unitsRemaining, voucherEntitlementOf, voucherReasonText, type VoucherGroupTerms, type VoucherTerms } from './vouchers';

/* ------------------------------------------------------------------ words */

/** The station's words — Android's, word for word (strings.xml vstation_* / vfast_*, the domain's Text objects). */
export const VOUCHER_STATION_TEXT = {
  // strings.xml
  title: 'עמדת שובר',
  scanButton: 'סריקת שובר',
  typeButton: 'הקלדת קוד שובר',
  hint: 'סרקו את השובר — הסורק פעיל תמיד',
  add: 'הוסף למימוש',
  rescan: 'סריקה נוספת',
  conditions: 'תנאי המימוש',
  openOrder: (items: string) => `הזמנה פתוחה: ${items}`,
  pay: 'המשך לתשלום',
  clear: 'ביטול ההזמנה',
  leave: 'יציאה למסך רגיל',
  back: 'חזרה לעמדת שובר',
  leaveAsk: 'יציאה מעמדת שובר למסך רגיל — נדרש קוד מנהל',
  finish: 'סיום וסגירת העסקה',
  scanAnother: 'סריקת שובר נוסף',
  scan: 'סרקו שובר',
  scanAnotherBig: 'סרקו שובר נוסף',
  hintHead: 'הסורק פעיל תמיד',
  type: 'הקלדת קוד',
  checking: 'בודק…',
  next: 'סרקו את השובר הבא',
  payOff: 'קופה זו אינה מקבלת שוברים — ממשו את השובר בקופה שמקבלת שוברים',
  codeLabel: 'קוד השובר',
  lookup: 'בדוק שובר',
  cancel: 'ביטול',
  serial: (n: number) => `שובר מס׳ ${n}`,
  production: (name: string) => `הפקה: ${name}`,
  validUntil: (at: string) => `בתוקף עד ${at}`,
  // VoucherStationText (the basket)
  usage: (n: number, of: number) => `בשובר: ${n} מתוך ${of}`,
  punch: (used: number, left: number) => `מומשו ${used} · נותרו ${left}`,
  full: 'השובר מומש במלואו — כל פריט נוסף בתשלום',
  fullSeveral: 'השוברים מומשו במלואם — כל פריט נוסף בתשלום',
  fullPerSale: 'הגעת למספר הפריטים המקסימלי בעסקה לשובר — כל פריט נוסף בתשלום',
  notIncluded: (price: string) => `לא כלול בשובר — בתשלום ${price}`,
  noRoom: (price: string) => `אין מקום בשובר לפריט זה — בתשלום ${price}`,
  groupFull: (group: string, price: string) => `הקבוצה "${group}" בשובר מלאה — נוסף בתשלום ${price}`,
  paid: (amount: string) => `בתשלום: ${amount}`,
  closeAll: 'סגור — הכל בשובר',
  payAmount: (amount: string) => `לתשלום ${amount}`,
  empty: 'הקישו על פריט כדי להוסיף אותו לסל',
  tagVoucher: 'בשובר',
  tagPaid: 'בתשלום',
  tagPaidPrice: (price: string) => `בתשלום ${price}`,
  /** ZeroDueText.REDEEM: all covered, `voucherAutoClose` off — the cashier's tap closes the sale. */
  closeManual: 'סגור עסקה וממש שובר',
  /** voucherSaleTapText (Covered). */
  addedTo: (title: string) => `נוסף ב${title}`,
  // VoucherStationPickerText
  paidItem: 'הוסף פריט בתשלום',
  paidOff: "רכישה בתשלום כבויה בעמדה (פרמטר 'רכישה נוספת בתשלום בעמדת שובר')",
  noPayOptions: 'אין אמצעי תשלום בקופה — הגדירו מזומן או אשראי',
  inSale: (what: string) => `בעסקה: ${what}`,
  inVoucher: (what: string) => `בשובר: ${what}`,
  oneItem: 'פריט אחד',
  items: (n: number) => `${n} פריטים`,
  busy: 'השובר הנוכחי עדיין נבדק — סרקו את השובר הנוסף בעוד רגע',
  // VoucherStationSaleText
  banner: (vouchers: string, items: string) => `${vouchers} · ${items} בשובר · הוסיפו פריטים בתשלום`,
  vouchers: (n: number) => `${n} שוברים`,
  noVoucher: 'אין עדיין שובר בעסקה · הוסיפו פריטים וסרקו שובר',
  backToScan: 'חזרה לסריקה',
  backTitle: 'לחזור לסריקה?',
  backBody: (items: string) => `הפריטים בתשלום יוסרו מהעסקה: ${items}. הפריטים שבשובר נשארים בעסקה.`,
  backYes: 'הסר וחזור לסריקה',
  stay: 'המשך בעסקה',
  removeVoucher: 'הסר שובר',
  removeTitle: (title: string) => `להסיר את ${title} מהעסקה?`,
  removeItems: (covers: string) => `בשובר: ${covers} — להשאיר את הפריטים בעסקה בתשלום, או להסיר אותם?`,
  removeEmpty: 'השובר יוסר מהעסקה ולא ימומש.',
  removeKeepPaid: 'השאר בתשלום',
  removeDrop: 'הסר את הפריטים',
  refused: (reason: string) => `השובר לא נוסף לעסקה — ${reason}`,
  cart: (n: string) => `סל · ${n}`,
  orderTotal: 'סה״כ הזמנה',
  inVouchers: 'בשובר',
  toPay: 'לתשלום',
  // VoucherDiscountStationText
  orderDiscount: 'שובר הנחה על כל ההזמנה — הוסיפו פריטים בתשלום או ממשו בקופה רגילה',
  orderDiscountBasket: 'שובר הנחה על כל ההזמנה — הוסיפו פריטים בתשלום וסרקו את השובר שוב',
  noUses: 'לא נותרו בשובר שימושים לעסקה זו',
  noBenefit: 'לשובר זה אין פריטים להנחה — ממשו אותו בקופה רגילה',
  nothing: 'לא ניתן להציג את השובר בעמדה זו — סרקו שוב או ממשו בקופה רגילה',
  discountGroup: 'פריטים בהנחה',
  // VoucherFirstText (the picker's counters)
  groupCounter: (name: string, taken: number, max: number) => `${name}: ${taken} מתוך ${max}`,
  oneMore: 'אפשר לבחור עוד פריט אחד',
  more: (n: number) => `אפשר לבחור עוד ${n} פריטים`,
  quotaReachedOne: 'נבחר הפריט האחרון שנותר בשובר — פריט נוסף ישולם בנפרד',
  quotaReached: (n: number) => `נבחרו כל ${n} הפריטים שנותרו בשובר — פריט נוסף ישולם בנפרד`,
  perSaleOne: 'בשובר זה אפשר לממש פריט אחד בכל עסקה — את היתרה ממשו בעסקה אחרת',
  perSale: (n: number) => `בשובר זה אפשר לממש עד ${n} פריטים בכל עסקה — את היתרה ממשו בעסקה אחרת`,
  nothingLeft: 'לא נותרה יתרה בשובר — כל הפריטים כבר מומשו',
  groupPickedOne: 'כבר נבחר פריט מקבוצה זו',
  groupPicked: (n: number) => `כבר נבחרו ${n} פריטים מקבוצה זו`,
  notSellable: 'לא זמין למכירה',
  /** ProductionVoucherRules.Text.PACKAGE_INCOMPLETE / VOUCHER. */
  packageIncomplete: (missing: string, type: string) => `חסר ${missing} להשלמת ${type}`,
  theVoucher: 'השובר',
  /** VOUCHER_SAME_BATCH_TEXT. */
  sameBatch: 'בעסקה כבר יש שובר מאותה סדרה, והסדרה אינה מאפשרת שילוב — ממשו אותו בעסקה נפרדת',
  /** VoucherTestText.MIXED. */
  testMixed: 'לא ניתן לשלב שובר בבדיקה עם מכירה אמיתית — סיימו את הבדיקה או בטלו',
  alreadyScanned: 'השובר כבר נסרק בעסקה זו',
  /** sell_all: the catalog's "all" chip. */
  all: 'הכל',
  /** vfast_menu. */
  menu: 'תפריט',
} as const;

const T = VOUCHER_STATION_TEXT;

/* ------------------------------------------------------------- the settings */

const onOff = (raw: unknown): boolean | null => {
  const v = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (['on', 'true', '1', 'yes'].includes(v)) return true;
  if (['off', 'false', '0', 'no'].includes(v)) return false;
  return null;
};

/** `voucherStation`: absent or unknown — off. */
export const resolveVoucherStation = (s: Record<string, unknown>): boolean => onOff(s.voucherStation) ?? false;
/** `voucherAutoClose`: absent or unknown — on, as the till always did. */
export const resolveVoucherAutoClose = (s: Record<string, unknown>): boolean => onOff(s.voucherAutoClose) ?? true;
/** `voucherStationPaidItems`: only "on" / true — off by default, the station of §2. */
export const resolveVoucherStationPaidItems = (s: Record<string, unknown>): boolean => onOff(s.voucherStationPaidItems) === true;

export type VoucherCatalogSwitch = 'off' | 'manager' | 'free';
/** `voucherStationCatalogSwitch`: the way from the station to the ordinary screen; absent or unknown — manager. */
export function resolveVoucherCatalogSwitch(s: Record<string, unknown>): VoucherCatalogSwitch {
  const v = String(s.voucherStationCatalogSwitch ?? '')
    .trim()
    .toLowerCase();
  return v === 'off' || v === 'free' ? v : 'manager';
}

export type VoucherStationHeader = 'logo' | 'text' | 'both' | 'none';
export const VOUCHER_STATION_TITLE_DEFAULT = 'עמדת מימוש שוברים';
export function resolveVoucherStationHeader(s: Record<string, unknown>): VoucherStationHeader {
  const v = String(s.voucherStationHeader ?? '')
    .trim()
    .toLowerCase();
  return v === 'text' || v === 'both' || v === 'none' ? v : 'logo';
}
/** `voucherStationTitle`: one line, up to 40 characters; absent or blank — "עמדת מימוש שוברים". */
export function voucherStationTitleOf(raw: unknown): string {
  const t = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
  return t ? t.slice(0, 40).trim() : VOUCHER_STATION_TITLE_DEFAULT;
}
/** The top's words (voucherStationHeaderShows): "לוגו" with no logo on the till shows the title — never an empty header. */
export function voucherStationHeaderText(header: VoucherStationHeader, hasLogo: boolean, title: string): string | null {
  if (header === 'none') return null;
  if (header === 'logo' && hasLogo) return null;
  return title;
}

/** "סריקת שובר" (`payVoucherEnabled`) and "שובר ידני" (`payVoucherManualEnabled`): each on unless the cloud says "false". */
export function resolveVoucherPayOptions(s: Record<string, unknown>): { scan: boolean; manual: boolean } {
  const flag = (v: unknown): boolean | null => {
    const t = String(v ?? '')
      .trim()
      .toLowerCase();
    return t === 'true' ? true : t === 'false' ? false : typeof v === 'boolean' ? v : null;
  };
  return { scan: flag(s.payVoucherEnabled) ?? true, manual: flag(s.payVoucherManualEnabled) ?? true };
}

/** The station's home: "סריקת שובר", "הקלדת קוד" — neither: the till takes no vouchers, said. */
export function voucherStationHome(pay: { scan: boolean; manual: boolean }): { scan: boolean; manual: boolean; nothing: boolean } {
  return { scan: pay.scan, manual: pay.manual, nothing: !pay.scan && !pay.manual };
}

/** The smart basket is on: a station whose setting is on, with a cash / card way to pay the rest. */
export const voucherStationBasketOn = (station: boolean, paidItems: boolean, payOptions: boolean): boolean => station && paidItems && payOptions;

export type StationPaidItems = 'available' | 'off' | 'no_pay_options' | 'test';
export function voucherStationPaidItems(paidItems: boolean, payOptions: boolean, testMode = false): StationPaidItems {
  if (!paidItems) return 'off';
  if (!payOptions) return 'no_pay_options';
  if (testMode) return 'test';
  return 'available';
}
/** "הוסף פריט בתשלום": on, or off with why — never a button that does nothing. */
export function stationPaidButton(s: StationPaidItems): { enabled: boolean; why: string | null; text: string } {
  const why = s === 'off' ? T.paidOff : s === 'no_pay_options' ? T.noPayOptions : s === 'test' ? T.testMixed : null;
  return { enabled: why === null, why, text: T.paidItem };
}

/** The menu row ("יציאה למסך רגיל" / "חזרה לעמדת שובר"): the station on, and a way out offered — or it was left. */
export function voucherStationMenuRow(o: { station: boolean; left: boolean; catalogSwitch: VoucherCatalogSwitch }): { label: string } | null {
  if (!o.station) return null;
  if (!o.left && o.catalogSwitch === 'off') return null;
  return { label: o.left ? T.back : T.leave };
}

/* ------------------------------------------------------------- the model */

/** A product of the till's catalog as the station offers it. */
export interface StationProduct {
  id: string;
  name: string;
  priceAgorot: number;
  categoryId: string | null;
  /** Sellable now (not "לא זמין", not blocked / sold out). */
  available: boolean;
  barcode?: string | null;
  sku?: string | null;
}

/** A line of the sale (the till's cart), priced. */
export interface StationLine {
  lineId: string;
  productId: string;
  name: string;
  qty: number;
  unitAgorot: number;
  refund: boolean;
}

export interface StationPart {
  lineId: string;
  groupKey: string;
  qty: number;
}

/** One voucher of the station's sale: its terms, and the units of the sale it covers ([parts], pending until the payment). */
export interface StationVoucher {
  voucherId: string;
  code: string;
  serial: number;
  typeName: string | null;
  kind: VoucherKind;
  terms: VoucherTerms;
  inSale: VoucherInSale;
  /** The most units it may take in this sale: what it has left, within its per-sale limit. */
  cap: number;
  /** What it has left before this sale. */
  left: number;
  parts: StationPart[];
  testMode: boolean;
  /** A discount voucher: its benefit and the uses this sale may take — applied by the payment, no units of its own. */
  discount: { benefit: VoucherBenefit; uses: number } | null;
}

export const stationUnits = (a: StationVoucher): number => a.parts.reduce((s, p) => s + p.qty, 0);
export const onLine = (a: StationVoucher, lineId: string): number => a.parts.filter((p) => p.lineId === lineId).reduce((s, p) => s + p.qty, 0);
export const allocatedOnLine = (vs: readonly StationVoucher[], lineId: string): number => vs.reduce((s, a) => s + onLine(a, lineId), 0);
/** The whole units of a line a voucher may take. */
export const unitCount = (l: StationLine): number => (l.refund ? 0 : Math.max(0, Math.floor(l.qty + 1e-6)));
/** [stationCap]: never below 0. */
export const stationCap = (a: StationVoucher): number => Math.max(0, a.cap);
const taken = (a: StationVoucher, groupKey: string): number => a.parts.filter((p) => p.groupKey === groupKey).reduce((s, p) => s + p.qty, 0);

/** A group of [a] still short of its minimum — a package's missing part. Never a list voucher's (it may be taken in part). */
const short = (a: StationVoucher, g: VoucherGroupTerms): boolean => !a.terms.listItems && !a.terms.splitAllowed && taken(a, g.key) < Math.min(g.minUnits, g.remaining);

/** The voucher's groups said one by one (a package, "בחר 1 מתוך"): not a list voucher, nor one group of many units. */
export const voucherSaleShowsGroups = (a: StationVoucher): boolean =>
  !a.terms.listItems && a.terms.groups.length > 0 && (a.terms.groups.length >= 2 || unitLimit(a.terms) === 1);

/** A punch card: in parts, more than one unit. */
export const voucherIsMultiUse = (t: VoucherTerms): boolean => t.splitAllowed && unitLimit(t) > 1;

/** "שובר מס׳ 0008" (voucherTitle, no type). */
export const stationVoucherTitle = (serial: number): string => `שובר מס׳ ${String(Math.max(0, serial)).padStart(4, '0')}`;

/** The groups of [a] that take [productId] (the cloud's resolved lists). */
export const groupsFor = (a: StationVoucher, productId: string): VoucherGroupTerms[] => a.terms.groups.filter((g) => groupTakes(g, { productId }));

/**
 * Why one more unit of [productId] may not go into [g] of [a] now (the picker's whyNot): the voucher's total and per-sale
 * limit used up, the group full, a product once where the group says so; null — it may.
 */
export function stationWhyNot(a: StationVoucher, productId: string, g: VoucherGroupTerms, productOf: Readonly<Record<string, string>>): 'total' | 'group' | 'repeat' | null {
  if (stationUnits(a) >= stationCap(a)) return 'total';
  if (taken(a, g.key) >= g.remaining) return 'group';
  if (!g.allowRepeat && a.parts.some((p) => p.groupKey === g.key && productOf[p.lineId]?.toLowerCase() === productId.toLowerCase())) return 'repeat';
  return null;
}

export type StationUnitOutcome = 'covered' | 'not_eligible' | 'no_room' | 'group_full' | 'paid';

export interface StationAssign {
  vouchers: StationVoucher[];
  outcome: StationUnitOutcome;
  voucherId?: string | null;
  /** `group_full`: the full group's name. */
  group?: string | null;
}

const productOfLines = (lines: readonly StationLine[]): Record<string, string> => Object.fromEntries(lines.map((l) => [l.lineId, l.productId]));

/**
 * One more unit of [line] to the first of [vouchers], in the order scanned, that takes it now (voucherSaleDecide): eligible,
 * then a group with room (a package's group still short of its minimum first). None: paid, and why.
 */
export function stationAssignUnit(vouchers: readonly StationVoucher[], line: StationLine, lines: readonly StationLine[]): StationAssign {
  if (line.refund) return { vouchers: [...vouchers], outcome: 'not_eligible' };
  const free = unitCount(line) - allocatedOnLine(vouchers, line.lineId) > 0;
  const productOf = productOfLines(lines);
  let eligible = false;
  let fullGroup: string | null = null;
  for (let i = 0; i < vouchers.length; i++) {
    const a = vouchers[i];
    if (a.discount) continue;
    const groups = groupsFor(a, line.productId);
    if (groups.length === 0) continue;
    eligible = true;
    if (!free) continue;
    const open = groups.filter((g) => stationWhyNot(a, line.productId, g, productOf) === null);
    const g = open.find((x) => short(a, x)) ?? open[0];
    if (g) {
      const parts = [...a.parts];
      const at = parts.findIndex((p) => p.lineId === line.lineId && p.groupKey === g.key);
      if (at >= 0) parts[at] = { ...parts[at], qty: parts[at].qty + 1 };
      else parts.push({ lineId: line.lineId, groupKey: g.key, qty: 1 });
      const next = [...vouchers];
      next[i] = { ...a, parts };
      return { vouchers: next, outcome: 'covered', voucherId: a.voucherId };
    }
    if (fullGroup === null && voucherSaleShowsGroups(a) && (stationUnits(a) >= stationCap(a) || groups.every((x) => taken(a, x.key) >= x.remaining))) fullGroup = groups[0].name;
  }
  if (fullGroup !== null) return { vouchers: [...vouchers], outcome: 'group_full', group: fullGroup };
  return { vouchers: [...vouchers], outcome: eligible ? 'no_room' : 'not_eligible' };
}

/** One unit of [lineId] off the vouchers ("בתשלום"): from the last voucher that covers it. */
export function stationReleaseUnit(vouchers: readonly StationVoucher[], lineId: string): StationVoucher[] {
  let i = -1;
  for (let k = vouchers.length - 1; k >= 0; k--) if (onLine(vouchers[k], lineId) > 0) {
    i = k;
    break;
  }
  if (i < 0) return [...vouchers];
  const a = vouchers[i];
  const parts = [...a.parts];
  let at = -1;
  for (let k = parts.length - 1; k >= 0; k--) if (parts[k].lineId === lineId && parts[k].qty > 0) {
    at = k;
    break;
  }
  if (parts[at].qty <= 1) parts.splice(at, 1);
  else parts[at] = { ...parts[at], qty: parts[at].qty - 1 };
  const next = [...vouchers];
  next[i] = { ...a, parts };
  return next;
}

/** A tap on a basket row: "בשובר" → "בתשלום" always; "בתשלום" → "בשובר" only when a voucher takes it now. */
export function stationToggle(vouchers: readonly StationVoucher[], lineId: string, toVoucher: boolean, lines: readonly StationLine[]): StationAssign {
  if (!toVoucher) {
    const before = allocatedOnLine(vouchers, lineId);
    const next = stationReleaseUnit(vouchers, lineId);
    return { vouchers: next, outcome: allocatedOnLine(next, lineId) < before ? 'paid' : 'not_eligible' };
  }
  const line = lines.find((l) => l.lineId === lineId && !l.refund);
  if (!line) return { vouchers: [...vouchers], outcome: 'not_eligible' };
  return stationAssignUnit(vouchers, line, lines);
}

/** The vouchers as the basket now is: a part of a line gone (or shrunk) dropped; a voucher left with nothing stays, empty. */
export function stationPrune(vouchers: readonly StationVoucher[], lines: readonly StationLine[]): StationVoucher[] {
  const room = new Map(lines.map((l) => [l.lineId, unitCount(l)] as const));
  return vouchers.map((a) => {
    const parts: StationPart[] = [];
    for (const p of a.parts) {
      const left = room.get(p.lineId) ?? 0;
      const q = Math.min(p.qty, left);
      if (q > 0) {
        parts.push(q === p.qty ? p : { ...p, qty: q });
        room.set(p.lineId, left - q);
      }
    }
    return parts.length === a.parts.length && parts.every((p, i) => p === a.parts[i]) ? a : { ...a, parts };
  });
}

export interface StationAuto {
  vouchers: StationVoucher[];
  /** Each line's whole units already decided. */
  seen: Record<string, number>;
  /** The last new unit's line and what became of it (the hint). */
  last: { lineId: string; outcome: StationUnitOutcome; group: string | null; voucherId: string | null } | null;
}

/**
 * The units added since [seen], in the basket's order (the order added), each to a voucher while one takes it, else paid. A
 * line that shrank is decided at its new size; a unit the cashier moved to "בתשלום" is never taken back by itself.
 */
export function stationAutoAssign(vouchers: readonly StationVoucher[], seen: Readonly<Record<string, number>>, lines: readonly StationLine[]): StationAuto {
  let v = [...vouchers];
  const next: Record<string, number> = {};
  let last: StationAuto['last'] = null;
  for (const l of lines) {
    if (l.refund) continue;
    const n = unitCount(l);
    for (let k = 0; k < Math.max(0, n - (seen[l.lineId] ?? 0)); k++) {
      const r = stationAssignUnit(v, l, lines);
      v = r.vouchers;
      last = { lineId: l.lineId, outcome: r.outcome, group: r.group ?? null, voucherId: r.voucherId ?? null };
    }
    next[l.lineId] = n;
  }
  return { vouchers: v, seen: next, last };
}

/** The note beside an item that went in paid; null — a voucher took it. */
export function stationAddHint(outcome: StationUnitOutcome, priceAgorot: number, group: string | null = null): string | null {
  const price = formatShekelSign(priceAgorot);
  switch (outcome) {
    case 'not_eligible':
      return T.notIncluded(price);
    case 'no_room':
      return T.noRoom(price);
    case 'group_full':
      return group ? T.groupFull(group, price) : T.noRoom(price);
    default:
      return null;
  }
}

/* ------------------------------------------------------------- the bar */

const hebrewList = (names: readonly string[]): string => (names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} ו${names[names.length - 1]}`);

/** A package's missing groups: "חסר תוספת ומשקה להשלמת שובר ארוחה"; null — nothing missing. */
export function stationMissingText(a: StationVoucher): string | null {
  const missing = a.terms.groups.filter((g) => short(a, g)).map((g) => g.name);
  if (missing.length === 0) return null;
  return T.packageIncomplete(hebrewList(missing), a.terms.typeName ?? T.theVoucher);
}

/** What [a] still gives in this sale — its cap less what it covers — as the cloud's `entitlement_left`; null — nothing. */
export function stationEntitlement(a: StationVoucher): EntitlementLeft | null {
  if (a.terms.listItems || a.discount) return null;
  const takenBy = new Map(a.terms.groups.map((g) => [g.key, taken(a, g.key)] as const));
  return voucherEntitlementOf(a.terms, takenBy, stationCap(a) - stationUnits(a));
}

/** "הלקוח זכאי לעוד פריט": over the vouchers that cover something, their package complete, in the order scanned. */
export const stationAlert = (vouchers: readonly StationVoucher[]): EntitlementLeft | null =>
  entitlementLeftMany(vouchers.map((a) => (stationUnits(a) > 0 && stationMissingText(a) === null ? stationEntitlement(a) : null)));

/** What a voucher took in this sale: a punch card "מומשו 2 · נותרו 48", else "בשובר: 2 מתוך 3". */
export const stationUsageText = (a: StationVoucher): string =>
  voucherIsMultiUse(a.terms) ? T.punch(stationUnits(a), Math.max(0, a.left - stationUnits(a))) : T.usage(stationUnits(a), stationCap(a));

export interface StationBar {
  usage: string[];
  full: boolean;
  fullText: string | null;
  missing: string | null;
  paid: string | null;
  alert: string | null;
  closeConfirm: string | null;
  closeNote: string | null;
}

/** The bar (goods vouchers only): each voucher's use, green once all are used up, a package's missing part, the sum to pay. */
export function stationBar(goods: readonly StationVoucher[], toPayAgorot: number): StationBar {
  const several = goods.length > 1;
  const usage = goods.map((a) => (several ? `${stationVoucherTitle(a.serial)}: ${stationUsageText(a)}` : stationUsageText(a)));
  const full = goods.length > 0 && goods.every((a) => stationUnits(a) >= stationCap(a));
  const perSale = goods.every((a) => a.left > stationCap(a));
  const fullText = !full ? null : perSale ? T.fullPerSale : several ? T.fullSeveral : T.full;
  const alert = full ? null : stationAlert(goods);
  return {
    usage,
    full,
    fullText,
    missing: goods.map(stationMissingText).find((x): x is string => !!x) ?? null,
    paid: toPayAgorot > 0 ? T.paid(formatShekelSign(toPayAgorot)) : null,
    alert: alert?.tillText ?? null,
    closeConfirm: alert?.closeConfirm ?? null,
    closeNote: alert?.closeNote ?? null,
  };
}

/* ------------------------------------------------------------- the catalog */

export type StationTag = 'completes' | 'voucher' | 'paid';

/**
 * The whole catalog, the items a voucher takes now first ("בשובר") — those that complete a package's missing part before
 * them — then everything else ("בתשלום ₪X"); each tier in the catalog's order.
 */
export function stationCatalog(products: readonly StationProduct[], vouchers: readonly StationVoucher[], lines: readonly StationLine[]): Array<{ product: StationProduct; tag: StationTag }> {
  const productOf = productOfLines(lines);
  const withRoom = vouchers.filter((a) => !a.discount && stationUnits(a) < stationCap(a));
  const items = products.map((p) => {
    let tag: StationTag = 'paid';
    for (const a of withRoom) {
      const open = groupsFor(a, p.id).filter((g) => stationWhyNot(a, p.id, g, productOf) === null);
      if (open.some((g) => short(a, g))) {
        tag = 'completes';
        break;
      }
      if (open.length > 0) tag = 'voucher';
    }
    return { product: p, tag };
  });
  return [...items.filter((i) => i.tag === 'completes'), ...items.filter((i) => i.tag === 'voucher'), ...items.filter((i) => i.tag === 'paid')];
}

/* ------------------------------------------------------------- the rows */

export interface StationRow {
  lineId: string;
  name: string;
  quantity: number;
  covered: boolean;
  /** What the row's units come to on the order (before the voucher). */
  amountAgorot: number;
}

/** Each sale line as its covered row ("בשובר") and its paid row ("בתשלום"), in the basket's order. */
export function stationRows(lines: readonly StationLine[], vouchers: readonly StationVoucher[]): StationRow[] {
  return lines.flatMap((l) => {
    if (l.refund || l.qty <= 1e-9) return [];
    const covered = Math.min(allocatedOnLine(vouchers, l.lineId), unitCount(l));
    const paid = Math.max(0, l.qty - covered);
    const rows: StationRow[] = [];
    if (covered > 0) rows.push({ lineId: l.lineId, name: l.name, quantity: covered, covered: true, amountAgorot: Math.round(l.unitAgorot * covered) });
    if (paid > 1e-9) rows.push({ lineId: l.lineId, name: l.name, quantity: paid, covered: false, amountAgorot: Math.round(l.unitAgorot * paid) });
    return rows;
  });
}

/* ------------------------------------------------------------- what is to pay */

/**
 * What a voucher takes off the order as placed — an estimate (the payment prices it): its covered units' prices; a fixed
 * value its value (a deduction at most the units'); and why it cannot be redeemed as placed (a package not complete…).
 */
export function stationEstimate(a: StationVoucher, lines: readonly StationLine[]): { effectAgorot: number; refusal: string | null } {
  if (a.discount || stationUnits(a) === 0) return { effectAgorot: 0, refusal: null };
  const byLine = new Map(lines.map((l) => [l.lineId, l] as const));
  const sum = a.parts.reduce((s, p) => s + (byLine.get(p.lineId)?.unitAgorot ?? 0) * p.qty, 0);
  const productOf = productOfLines(lines);
  const chosen = a.parts.map((p) => [(productOf[p.lineId] ?? '').toLowerCase(), p.groupKey, p.qty] as const);
  const groups = a.terms.groups.map((g) => ({
    key: g.key,
    name: g.name,
    minQty: g.minUnits,
    maxQty: g.maxUnits,
    remaining: g.remaining,
    productIds: [...g.productIds],
    allowRepeat: g.allowRepeat,
    excludedIds: [...g.excludedIds],
  }));
  const r = checkSelection(groups, chosen, { totalMax: unitLimit(a.terms), totalRemaining: unitsRemaining(a.terms), wholeAtOnce: !a.terms.splitAllowed, typeName: a.terms.typeName });
  if (r) return { effectAgorot: 0, refusal: r.text };
  let effect = sum;
  if (a.terms.pricing === 'fixed' && a.terms.tillValue !== null) effect = a.terms.accounting === 'payment' ? a.terms.tillValue : Math.min(a.terms.tillValue, sum);
  return { effectAgorot: Math.max(0, effect), refusal: null };
}

/** What is left to pay: the order's total less what the vouchers take off it, never below ₪0. */
export const stationToPay = (totalAgorot: number, effects: readonly number[]): number => Math.max(0, totalAgorot - effects.reduce((s, e) => s + e, 0));

export type StationPrimary =
  | { kind: 'empty' }
  | { kind: 'close_all' }
  | { kind: 'close_manual' }
  | { kind: 'pay'; amountAgorot: number }
  | { kind: 'blocked'; why: string };

/** The bottom button: nothing yet; a voucher that cannot be redeemed as placed; something to pay; or all covered. */
export function stationPrimary(saleLines: number, covering: number, refusals: ReadonlyArray<string | null>, toPayAgorot: number, autoClose = true): StationPrimary {
  if (saleLines === 0) return { kind: 'empty' };
  const why = refusals.find((r): r is string => !!r);
  if (why) return { kind: 'blocked', why };
  if (toPayAgorot > 0 || covering === 0) return { kind: 'pay', amountAgorot: Math.max(0, toPayAgorot) };
  return autoClose ? { kind: 'close_all' } : { kind: 'close_manual' };
}

export const stationCloses = (p: StationPrimary): boolean => p.kind === 'close_all' || p.kind === 'close_manual';

export function stationPrimaryText(p: StationPrimary): string {
  switch (p.kind) {
    case 'empty':
      return T.empty;
    case 'close_all':
      return T.closeAll;
    case 'close_manual':
      return T.closeManual;
    case 'pay':
      return T.payAmount(formatShekelSign(p.amountAgorot));
    case 'blocked':
      return p.why;
  }
}

/** The bar's buttons: the primary (enabled when it pays or closes), "סריקת שובר נוסף" while the stacking allows another. */
export function stationSaleButtons(primary: StationPrimary, scanOn: boolean, manualOn: boolean, mayAddAnother: boolean): { text: string; enabled: boolean; green: boolean; scanAnother: boolean; typeCode: boolean } {
  const another = scanOn && mayAddAnother;
  return { text: stationPrimaryText(primary), enabled: stationCloses(primary) || primary.kind === 'pay', green: stationCloses(primary), scanAnother: another, typeCode: another && manualOn };
}

/* ------------------------------------------------------------- the strip, the banner */

export const stationItemsText = (n: number): string => (n === 1 ? T.oneItem : T.items(n));

/** "בעסקה: שובר מס׳ 0008 · 3 פריטים"; null — nothing in the sale yet. */
export function stationSaleStrip(vouchers: readonly string[], items: number): string | null {
  const parts = [...vouchers.filter((v) => v.trim()), ...(items > 0 ? [stationItemsText(items)] : [])];
  return parts.length === 0 ? null : T.inSale(parts.join(' · '));
}

/** The picker's bottom bar once the sale has voucher items: "בשובר: N פריטים" and its one button. */
export function stationPickerBar(voucherUnits: number, toPayAgorot: number, autoClose = true): { text: string; primary: StationPrimary; button: string } | null {
  if (voucherUnits <= 0) return null;
  const primary: StationPrimary = toPayAgorot > 0 ? { kind: 'pay', amountAgorot: toPayAgorot } : autoClose ? { kind: 'close_all' } : { kind: 'close_manual' };
  return { text: T.inVoucher(stationItemsText(voucherUnits)), primary, button: stationPrimaryText(primary) };
}

export type StationBannerTone = 'normal' | 'missing' | 'alert' | 'full';

/** The banner over the station's basket: the vouchers and the units they cover, then the bar's missing / alert / full. */
export function stationSaleBanner(goods: readonly StationVoucher[], bar: StationBar): { title: string; status: string | null; note: string | null; tone: StationBannerTone } {
  const title =
    goods.length === 0 ? T.noVoucher : T.banner(goods.length === 1 ? stationVoucherTitle(goods[0].serial) : T.vouchers(goods.length), stationItemsText(goods.reduce((s, a) => s + stationUnits(a), 0)));
  if (bar.missing) return { title, status: bar.missing, note: null, tone: 'missing' };
  if (bar.alert) return { title, status: bar.alert, note: bar.closeNote, tone: 'alert' };
  if (bar.full) return { title, status: bar.fullText, note: null, tone: 'full' };
  return { title, status: null, note: null, tone: 'normal' };
}

/* ------------------------------------------------------------- back, removal */

/** "burger ×1 · chips ×1": what a voucher covers, by line; null — nothing. */
export function stationCoversText(a: StationVoucher, lines: readonly StationLine[]): string | null {
  const rows = lines.filter((l) => onLine(a, l.lineId) > 0).map((l) => `${l.name} ×${prepaidQtyText(onLine(a, l.lineId))}`);
  return rows.length > 0 ? rows.join(' · ') : null;
}

/** "חזרה לסריקה": the paid items go (each line cut to its covered units), the vouchers' stay. */
export function stationBackPlan(lines: readonly StationLine[], vouchers: readonly StationVoucher[]): { cuts: Record<string, number>; text: string | null; asks: boolean } {
  const cuts: Record<string, number> = {};
  const dropped: string[] = [];
  for (const l of lines) {
    if (l.refund || l.qty <= 1e-9) continue;
    const covered = Math.min(allocatedOnLine(vouchers, l.lineId), unitCount(l));
    if (covered <= 0) {
      cuts[l.lineId] = 0;
      dropped.push(`${l.name} ×${prepaidQtyText(l.qty)}`);
    } else if (l.qty > covered + 1e-9) {
      cuts[l.lineId] = covered;
      dropped.push(`${l.name} ×${prepaidQtyText(l.qty - covered)}`);
    }
  }
  return { cuts, text: dropped.length > 0 ? T.backBody(dropped.join(', ')) : null, asks: Object.keys(cuts).length > 0 };
}

/** "הסר שובר": its question, and — "הסר את הפריטים" — each of its lines cut by the units it covered. Null — not in the sale. */
export function stationVoucherRemoval(lines: readonly StationLine[], vouchers: readonly StationVoucher[], voucherId: string): { title: string; text: string; hasItems: boolean; cuts: Record<string, number> } | null {
  const a = vouchers.find((v) => v.voucherId === voucherId);
  if (!a) return null;
  const covers = stationCoversText(a, lines);
  const cuts: Record<string, number> = {};
  for (const l of lines) {
    const n = onLine(a, l.lineId);
    if (n > 0 && !l.refund) cuts[l.lineId] = Math.max(0, l.qty - n);
  }
  return { title: T.removeTitle(stationVoucherTitle(a.serial)), text: covers ? T.removeItems(covers) : T.removeEmpty, hasItems: covers !== null, cuts };
}

/* ------------------------------------------------------------- stacking */

/** Another voucher refused by the sale's stacking, in words; null — it may. The same voucher again is not another one. */
export function voucherStationRefusal(held: readonly VoucherInSale[], incoming: VoucherInSale | null = null): string | null {
  const r = incoming ? stackingRefusal(held, incoming) : stackingBeforeScan(held);
  if (!r) return null;
  return stackingText(r.code, r.limit, incoming?.kind ?? null) ?? (r.code === VOUCHER_SAME_BATCH ? T.sameBatch : voucherReasonText(r.code));
}

export const voucherStationMayAddAnother = (held: readonly VoucherInSale[]): boolean => voucherStationRefusal(held) === null;

/** "השובר לא נוסף לעסקה — …" (red, on the basket). */
export const stationRefusedText = (reason: string): string => T.refused(reason);

/* ------------------------------------------------------------- discount vouchers */

export type VoucherDiscountRoute = 'goods' | 'till_discount' | 'item_discount_picker' | 'order_discount_basket' | 'order_discount_refused';

/** Where a voucher scanned at the station goes, by its kind (voucherDiscountRoute, station = true). */
export function voucherDiscountRoute(kind: VoucherKind, orderHasItems: boolean, basket: boolean): VoucherDiscountRoute {
  if (kind === 'items') return 'goods';
  if (orderHasItems) return 'till_discount';
  if (kind === 'item_discount') return 'item_discount_picker';
  return basket ? 'order_discount_basket' : 'order_discount_refused';
}

/** The uses one sale may take of a discount voucher: the least of the per-sale limit, what is available and the day's (none — one). */
export function voucherDiscountUses(maxUsesPerSale: number | null, usesAvailable: number | null, usesToday: number | null): number {
  const xs = [maxUsesPerSale, usesAvailable, usesToday].filter((x): x is number => typeof x === 'number');
  return Math.max(0, xs.length > 0 ? Math.min(...xs) : 1);
}

/** The units the picker allows: uses × the benefit's units a use (none — one). */
export const voucherDiscountUnitCap = (benefit: Pick<VoucherBenefit, 'maxUnits'>, uses: number): number => (uses <= 0 ? 0 : uses * (benefit.maxUnits && benefit.maxUnits > 0 ? benefit.maxUnits : 1));

/** "100%" / "₪10": the discount's value. */
export function voucherDiscountValueText(benefit: Pick<VoucherBenefit, 'discountType' | 'value'>): string {
  if (benefit.discountType === 'percent') {
    const bp = benefit.value;
    return bp % 100 === 0 ? `${bp / 100}%` : `${Math.trunc(bp / 100)}.${String(bp % 100).padStart(2, '0').replace(/0+$/, '')}%`;
  }
  return moneyText(benefit.value);
}

export const voucherUsesText = (uses: number): string => (uses === 1 ? 'שימוש אחד' : `${uses} שימושים`);

/** "הנחה 100% · שימוש אחד · נבחרו 0". */
export const voucherDiscountHeader = (benefit: Pick<VoucherBenefit, 'discountType' | 'value'>, uses: number, selected: number): string =>
  `הנחה ${voucherDiscountValueText(benefit)} · ${voucherUsesText(uses)} · נבחרו ${selected}`;

/** "100% הנחה על: פיצה, פופקורן… · שימוש אחד". */
export function voucherDiscountCardText(benefit: Pick<VoucherBenefit, 'discountType' | 'value' | 'text'>, uses: number, names: readonly string[], shown = 3): string {
  const distinct = [...new Set(names.map((n) => n.trim()).filter((n) => n))];
  const what =
    distinct.length > 0
      ? `${voucherDiscountValueText(benefit)} הנחה על: ${distinct.slice(0, shown).join(', ')}${distinct.length > shown ? '…' : ''}`
      : benefit.text?.trim()
        ? benefit.text.trim()
        : `${voucherDiscountValueText(benefit)} הנחה`;
  return `${what} · ${voucherUsesText(uses)}`;
}

/** The catalog's products an item discount takes (by product id, or its category), never twice. */
export function voucherDiscountProducts(benefit: Pick<VoucherBenefit, 'kind' | 'productIds' | 'categoryIds'>, products: readonly StationProduct[]): StationProduct[] {
  if (benefit.kind !== 'item_discount') return [];
  const ids = new Set(benefit.productIds.map((x) => x.toLowerCase()));
  const cats = new Set(benefit.categoryIds);
  const seen = new Set<string>();
  return products.filter((p) => {
    if (seen.has(p.id)) return false;
    if (!ids.has(p.id.toLowerCase()) && !(p.categoryId && cats.has(p.categoryId))) return false;
    seen.add(p.id);
    return true;
  });
}

/* ------------------------------------------------------------- the conditions */

export interface VoucherConditions {
  validFrom: string | null;
  validUntil: string | null;
  validTimes: string | null;
  quota: { quota: number; used: number; remaining: number } | null;
  perSale: number | null;
  groups: Array<[string, number]>;
  splitAllowed: boolean;
  includeExtras: boolean;
  stacking: 'single' | 'distinct_batches' | 'unlimited' | null;
  maxVouchersPerSale: number | null;
  shops: string[];
  value: number | null;
  fixedValue: boolean;
}

const words = (raw: unknown): string | null => {
  if (typeof raw === 'string') return raw.trim() || null;
  if (Array.isArray(raw)) {
    const parts = raw.map(words).filter((x): x is string => !!x);
    return parts.length ? parts.join(', ') : null;
  }
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    return words(o.text ?? o.name ?? o.label ?? null);
  }
  return null;
};

/** "תנאי המימוש" of a looked-up voucher (PrepaidVoucherDto.conditions). */
export function voucherConditionsOf(dto: Record<string, unknown>, terms: VoucherTerms): VoucherConditions {
  const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const hasGroups = !terms.listItems;
  const [q, u, r] = quotaNumbers(dto);
  const perSale = n(dto.maxUnitsPerSale);
  const total = q ?? unitLimit(terms);
  const left = Math.max(0, r ?? unitsRemaining(terms));
  const stacking = dto.stacking === 'single' || dto.stacking === 'distinct_batches' || dto.stacking === 'unlimited' ? dto.stacking : null;
  return {
    validFrom: typeof dto.validFrom === 'string' ? dto.validFrom : null,
    validUntil: typeof dto.validUntil === 'string' ? dto.validUntil : null,
    validTimes: words(dto.validTimes),
    quota: hasGroups || n(dto.totalMax) !== null || q !== null ? { quota: total, used: u ?? Math.max(0, total - left), remaining: left } : null,
    perSale,
    groups: terms.groups.map((g) => [g.name, g.maxUnits]),
    splitAllowed: terms.splitAllowed,
    includeExtras: terms.includeExtras,
    stacking,
    maxVouchersPerSale: n(dto.maxVouchersPerSale),
    shops: Array.isArray(dto.validShops) ? dto.validShops.map(words).filter((x): x is string => !!x) : [],
    value: terms.tillValue,
    fixedValue: terms.pricing === 'fixed',
  };
}

/** The conditions in words, one line each, in the spec's order (voucherConditionsLines). */
export function voucherConditionsLines(c: VoucherConditions, showValue = true, format: StampFormat = (x) => x ?? null): string[] {
  const out: string[] = [];
  const from = format(c.validFrom);
  const until = format(c.validUntil);
  if (from && until) out.push(`תוקף: מ־${from} עד ${until}`);
  else if (until) out.push(`תוקף: עד ${until}`);
  else if (from) out.push(`תוקף: מ־${from}`);
  if (c.validTimes && c.validTimes.trim()) out.push(`שעות וימים: ${c.validTimes}`);
  if (c.quota) out.push(`מכסה ${c.quota.quota} | מומשו ${c.quota.used} | נותרו ${c.quota.remaining}`);
  if (c.perSale && c.perSale > 0) out.push(c.perSale === 1 ? 'עד פריט אחד בעסקה' : `עד ${c.perSale} פריטים בעסקה`);
  if (c.groups.length > 0) out.push(c.groups.map(([name, k]) => `${name} ${k}`).join(' + '));
  out.push(c.splitAllowed ? 'מימוש בחלקים — היתרה נשמרת בשובר' : 'מימוש בעסקה אחת — מה שלא ימומש עכשיו יאבד');
  out.push(c.includeExtras ? 'כולל תוספות' : 'תוספות בתשלום אינן כלולות');
  if (c.stacking === 'single') out.push('שילוב שוברים: שובר אחד בעסקה');
  else if (c.maxVouchersPerSale && c.maxVouchersPerSale > 0) out.push(`שילוב שוברים: עד ${c.maxVouchersPerSale} שוברים בעסקה`);
  else if (c.stacking === 'distinct_batches') out.push('שילוב שוברים: כמה שוברים, רק מסדרות שונות');
  else if (c.stacking === 'unlimited') out.push('שילוב שוברים: כמה שוברים בעסקה (גם מאותה סדרה)');
  if (c.shops.length > 0) out.push(`תקף בסניפים: ${c.shops.join(', ')}`);
  if (showValue && c.value && c.value > 0) out.push(c.fixedValue ? `שווי קבוע ${moneyText(c.value)}` : `עד ${moneyText(c.value)}`);
  return out;
}

/* ------------------------------------------------------------- the picker */

/** The picker's line under the counters ("אפשר לבחור עוד 2 פריטים", the per-sale limit, nothing left). */
export function voucherLimitNote(cap: number, remaining: number, perSale: number | null, selected: number): string {
  const perSaleBinds = perSale !== null && perSale > 0 && perSale < remaining;
  const left = cap - selected;
  if (left <= 0 && cap === 0 && !perSaleBinds) return T.nothingLeft;
  if (left <= 0 && perSaleBinds) return cap === 1 ? T.perSaleOne : T.perSale(cap);
  if (left <= 0) return cap === 1 ? T.quotaReachedOne : T.quotaReached(cap);
  return left === 1 ? T.oneMore : T.more(left);
}

/* ------------------------------------------------------------- the view */

export type VoucherStationPhase = 'home' | 'checking' | 'refused' | 'picker' | 'basket';

/** A product row of the picker or the basket's catalog. */
export interface StationItemView {
  productId: string;
  /** The picker: the group it fills (a product of two groups shows once per group). */
  groupKey: string | null;
  name: string;
  price: string;
  /** "בשובר" / "בתשלום ₪X" / "משלים" (the basket's catalog). */
  tag: StationTag | null;
  tagText: string | null;
  /** The picker: chosen now. */
  count: number;
  /** Why one more cannot be chosen; null — it can. */
  why: string | null;
  available: boolean;
}

export interface StationGroupView {
  key: string;
  /** "מנה: 1 מתוך 1". */
  counter: string;
  full: boolean;
  items: StationItemView[];
}

export interface StationPickerView {
  voucherId: string;
  title: string;
  typeName: string | null;
  event: string | null;
  production: string | null;
  validUntil: string | null;
  testBar: string | null;
  /** "תנאי המימוש". */
  conditions: string[];
  /** A discount voucher's header ("הנחה 100% · שימוש אחד · נבחרו 0") / card. */
  discount: { header: string; card: string } | null;
  groups: StationGroupView[];
  /** "אפשר לבחור עוד…". */
  limitNote: string;
  selected: number;
  /** Why the selection cannot go into the sale as it is (a package not complete…); null — it may. */
  refusal: string | null;
  /** "הלקוח זכאי לעוד פריט…". */
  entitlement: string | null;
  /** "הוסף למימוש". */
  canAdd: boolean;
  /** "הוסף פריט בתשלום". */
  paidButton: { enabled: boolean; why: string | null; text: string };
  /** "סריקת שובר נוסף" offered. */
  scanAnother: boolean;
  /** The bottom bar ("בשובר: N פריטים" + the button); null — no voucher item yet. */
  bar: { text: string; button: string; green: boolean } | null;
  /** "מוצג חלקית": the items were capped. */
  more: number;
}

export interface StationBasketView {
  banner: { title: string; status: string | null; note: string | null; tone: StationBannerTone };
  bar: StationBar;
  categories: Array<{ id: string | null; name: string; on: boolean }>;
  items: StationItemView[];
  more: number;
  rows: Array<StationRow & { amount: string; tagText: string; mayMove: boolean }>;
  /** The last tap's note ("לא כלול בשובר — בתשלום ₪12", "נוסף בשובר מס׳ 0008"). */
  hint: { text: string; covered: boolean } | null;
  /** "השובר לא נוסף לעסקה — …". */
  refused: string | null;
  /** The sale's figures: "סה״כ הזמנה", "בשובר", "לתשלום". */
  totals: { order: string; vouchers: string; toPay: string };
  primary: { text: string; enabled: boolean; green: boolean };
  scanAnother: boolean;
  typeCode: boolean;
  vouchers: Array<{ voucherId: string; title: string; usage: string }>;
}

/** What the screens draw of the station (`TillState.voucherStation`). */
export interface VoucherStationState {
  /** The station replaces the sell screen now (`voucherStation` on, not left for the ordinary screen this session). */
  active: boolean;
  /** The menu row: "יציאה למסך רגיל" / "חזרה לעמדת שובר"; null — no row. */
  menu: { label: string } | null;
  phase: VoucherStationPhase;
  /** The station's top (`voucherStationHeader` / `voucherStationTitle`); null — none. */
  header: string | null;
  home: {
    scan: boolean;
    manual: boolean;
    /** "קופה זו אינה מקבלת שוברים…". */
    nothing: string | null;
    /** "סרקו שובר" / "סרקו שובר נוסף" — the big words; null — no scan offered now. */
    scanText: string | null;
    hint: string;
    /** "בעסקה: שובר מס׳ 0008 · 3 פריטים". */
    strip: string | null;
    /** Each voucher in the sale ("הסר שובר"). */
    vouchers: Array<{ voucherId: string; title: string; covers: string | null }>;
    /** "סיום וסגירת העסקה" offered. */
    finish: boolean;
    /** "הזמנה פתוחה: …" — an order left open with no voucher: paid or given up. */
    openOrder: string | null;
    /** "הוסף פריט בתשלום" back to the basket (a sale under way, the basket on). */
    basket: boolean;
  };
  /** A refusal (red), or the checking cover. */
  notice: { text: string; detail: string | null; tone: 'red' | 'orange' } | null;
  picker: StationPickerView | null;
  basket: StationBasketView | null;
  /** A test voucher in the sale: "מצב בדיקה — …". */
  testBar: string | null;
  /** Busy with the till (adding the lines, opening the payment). */
  busy: boolean;
}
