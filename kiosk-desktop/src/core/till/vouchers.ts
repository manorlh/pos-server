/**
 * Vouchers at the Windows till — the Android till's production vouchers ("שוברי הפקה", pos-android domain/VoucherPricing.kt,
 * VoucherCart.kt, VoucherRedemption.kt, VoucherAutoApply.kt, VoucherTestMode.kt, VoucherScanGuard.kt, data/repo/
 * ProductionVoucherTerms.kt) as pure rules: the voucher's terms from the lookup, the basket's units a voucher may cover, which
 * group each fills (lib/voucherGroups.ts — the cloud's own rules, fixture-pinned), whether the scan is applied at once
 * ("מימוש אוטומטי בסריקת שובר") or needs the cashier, and how each redemption is BOOKED on the sale by its
 * `redemptionAccounting`:
 *
 *  - `discount` (the default for new types): the covered lines keep their prices and are marked "כלול בשובר #N"; the voucher
 *    is a deduction from the document ("קיזוז שובר הפקה") — inside its discount, never a tender;
 *  - `payment`: the lines keep their prices (a fixed value reprices them to it), a "שוברי הפקה" tender leg pays them;
 *  - `zero`: the covered units are ₪0 lines, their value a memo outside every total.
 *
 * The cloud prices a held voucher (its answer is what is booked); a voucher of the older kind redeemed by `/redeem` is booked
 * by cover. "מצב בדיקה" (a batch being checked): a sale holding such a voucher is a simulation — nothing written.
 */

import { assignUnitsBy, checkSelection, UNIT_GROUP_FULL, UNIT_TOTAL_FULL, type Assignment, type SelectionRefusal } from '@dash-lib/voucherGroups';
import { entitlementLeft, type EntitlementLeft } from '@dash-lib/voucherEntitlement';
import type { VoucherInSale } from '@dash-lib/kioskVouchers';
import { formatAgorot } from '../money';
import { lineGross, unitAgorot, type SaleLine } from '../sale';

/* ------------------------------------------------------------------ words */

/** What this till tells the cloud it can do (the production vouchers contract §2) — never "offline": no store of its own. */
export const VOUCHER_FEATURES: readonly string[] = ['accounting', 'override', 'groups', 'production_voucher', 'reserve_goods'];

/** "מימוש אוטומטי בסריקת שובר" (`voucherAutoApply`): absent or unknown — on. */
export const VOUCHER_AUTO_APPLY_PARAM = 'voucherAutoApply';

export function resolveVoucherAutoApply(params: Record<string, unknown>): boolean {
  const v = String(params[VOUCHER_AUTO_APPLY_PARAM] ?? '')
    .trim()
    .toLowerCase();
  return !['off', 'false', '0', 'no'].includes(v);
}

export const VOUCHER_TEXT = {
  applied: (what: string) => `השובר הוחל: ${what}`,
  chip: (serial: number) => `שובר #${serial}`,
  scan: 'סריקת שובר',
  removed: 'השובר הוסר מהעסקה',
  alreadyScanned: 'השובר כבר נסרק בעסקה זו',
  noAnswer: 'אין תשובה מהענן — נסו שוב',
  notFound: 'השובר לא נמצא — ייתכן שהקוד נסרק או הוקלד לא נכון. בדקו את הקוד ונסו שוב.',
  offline: 'אין חיבור לענן — השובר לא נבדק ולא מומש, כי מימוש נבדק בענן בלבד. בדקו את החיבור ונסו שוב.',
  nothingInBasket: 'אף פריט מהשובר לא נמצא בסל — הוסיפו את הפריטים לסל ונסו שוב.',
  addItemsFirst: 'השובר משלם על פריטים שבסל — הוסיפו את הפריטים לסל, ואז סרקו את השובר (או לחצו "שובר" במסך התשלום).',
  forfeitTitle: 'מימוש חלקי',
  forfeitConfirm: 'השובר ממומש בעסקה אחת: מה שלא ימומש עכשיו יאבד. לממש בכל זאת?',
  afterTender: 'יש לממש שוברים לפני התשלום — בטלו את התשלום שהתקבל וסרקו שוב',
  inBasket: 'שובר אינו ממומש בעסקה עם החזרות',
  groupTitle: 'לאיזו קבוצה שייך הפריט?',
  groupBody: (item: string) => `"${item}" מתאים לכמה קבוצות פריטים בשובר — בחרו לאיזו לשייך אותו`,
  choiceTitle: 'איזה פריט השובר מכסה?',
  choiceBody: (group: string) => `בקבוצה "${group}" יש בסל יותר פריטים ממה שהשובר נותן — בחרו את הפריט שהשובר יכסה`,
  managerTitle: 'אישור מנהל לשובר',
  overrideBody: 'נדרש אישור מנהל להנחה שהוגדרה בשובר',
  testVoucherBody: 'מימוש שובר בדיקה — דורש אישור מנהל',
  closeTitle: 'סגירת עסקה עם שובר',
  close: 'סגור עסקה',
  addItem: 'הוסף פריט',
} as const;

/** "מצב בדיקה" (VoucherTestMode.kt VoucherTestText). */
export const VOUCHER_TEST_TEXT = {
  bar: 'מצב בדיקה — השובר לא ימומש ושום דבר לא יירשם',
  mixed: 'לא ניתן לשלב שובר בבדיקה עם מכירה אמיתית — סיימו את הבדיקה או בטלו',
  done: 'בדיקה הושלמה — השובר תקין. לא מומש ולא נרשם דבר',
  covered: (amount: string) => `היה מכוסה בשובר: ${amount}`,
  coveredItems: (n: number, amount: string) => `היו מכוסים בשובר: ${n} פריטים · ${amount}`,
  coveredOne: (amount: string) => `היה מכוסה בשובר: פריט אחד · ${amount}`,
  toPay: (amount: string) => `היה נותר לתשלום: ${amount}`,
  nothingToPay: 'לא היה נותר דבר לתשלום',
  finish: 'סיום בדיקה',
  due: (amount: string) => `נותר לתשלום: ${amount} — בבדיקה לא נגבה דבר`,
  nothingDue: 'השובר מכסה את כל העסקה — בבדיקה לא נגבה דבר',
  confirmTitle: 'מצב בדיקה',
  confirmGo: 'בדיקה',
} as const;

/** A test redemption's or hold's id, as the cloud gives it in test mode ("test-<id>"): never on a real document. */
export const TEST_VOUCHER_ID_PREFIX = 'test-';
export const isTestVoucherId = (id: string | null | undefined): boolean => typeof id === 'string' && id.startsWith(TEST_VOUCHER_ID_PREFIX);

/** The cloud's refusal of a test-mode voucher with a real one, or with real money. */
export const VOUCHER_TEST_MIXED = 'prepaid_voucher_test_mixed';
export const VOUCHER_TEST_UNSUPPORTED = 'prepaid_voucher_test_mode_unsupported';
/** A forced reduction needs a manager's code (the cloud's 409 `needsApproval`), or the one sent was not accepted. */
export const APPROVAL_NEEDED = 'prepaid_voucher_approval_needed';
export const APPROVAL_INVALID = 'prepaid_voucher_approval_invalid';
/** `/redeem` refused a voucher it does not take (not a plain batch): held instead (reserve → confirm). */
export const REDEEM_NEEDS_RESERVE = 'prepaid_voucher_reserve_required';
export const VOUCHER_IN_USE = 'prepaid_voucher_in_use';

/** [incoming] joining a sale of [existing] (and real money already, [realMoney]): a test voucher with anything real — refused. */
export function voucherTestMixRefusal(existing: ReadonlyArray<{ voucherId: string; testMode: boolean }>, incoming: { voucherId: string; testMode: boolean }, realMoney = false): string | null {
  const others = existing.filter((v) => v.voucherId !== incoming.voucherId);
  if (others.some((v) => v.testMode !== incoming.testMode)) return VOUCHER_TEST_MIXED;
  if (incoming.testMode && realMoney) return VOUCHER_TEST_MIXED;
  return null;
}

/** Real money in a test sale: refused. */
export function voucherTestMoneyRefusal(simulation: boolean, realMoney: boolean): string | null {
  return simulation && realMoney ? VOUCHER_TEST_MIXED : null;
}

/** "בדיקה הושלמה — השובר תקין. לא מומש ולא נרשם דבר", what would have been covered, what would have been left to pay. */
export function voucherTestEndLines(end: { coveredAgorot: number; items: number; toPayAgorot: number }): string[] {
  const amount = shekel(end.coveredAgorot);
  return [
    VOUCHER_TEST_TEXT.done,
    end.items === 1 ? VOUCHER_TEST_TEXT.coveredOne(amount) : end.items > 1 ? VOUCHER_TEST_TEXT.coveredItems(end.items, amount) : VOUCHER_TEST_TEXT.covered(amount),
    end.toPayAgorot > 0 ? VOUCHER_TEST_TEXT.toPay(shekel(end.toPayAgorot)) : VOUCHER_TEST_TEXT.nothingToPay,
  ];
}

const shekel = (agorot: number) => `₪${formatAgorot(agorot)}`;

/** The cloud's refusal codes in the cashier's Hebrew (PrepaidRedeemSheet prepaidReasonTextOf, the till's strings). */
export const VOUCHER_REASON_TEXT: Record<string, string> = {
  prepaid_voucher_not_found: VOUCHER_TEXT.notFound,
  prepaid_voucher_used: 'השובר כבר מומש במלואו — אין בו יתרה, ולא ניתן לממש אותו שוב.',
  prepaid_voucher_cancelled: 'השובר בוטל — לא ניתן לממש אותו. לבירור פנו למנהל.',
  prepaid_voucher_expired: 'פג תוקף השובר — לא ניתן לממש אותו. לבירור פנו למנהל.',
  prepaid_voucher_not_yet_valid: 'השובר טרם בתוקף — אפשר לממש אותו רק מתאריך תחילת התוקף.',
  prepaid_voucher_wrong_shop: 'השובר אינו תקף בנקודת מכירה זו — יש לממש אותו בנקודת מכירה שהשובר תקף בה.',
  prepaid_voucher_in_use: 'השובר פתוח כרגע בעסקה אחרת (בקופה אחרת או בעמדה) — סיימו או בטלו את העסקה שם, או נסו שוב בעוד כמה דקות.',
  prepaid_voucher_daily_limit: 'השובר הגיע למספר השימושים המקסימלי להיום — אפשר לממש אותו שוב מחר.',
  prepaid_voucher_kind_unsupported: 'זהו שובר הנחה, ולא ניתן לממש אותו כאן — סרקו אותו במסך התשלום.',
  prepaid_voucher_reservation_released: 'השובר הוסר מהעסקה (העסקה השתנתה או בוטלה) — סרקו אותו שוב כדי לממש.',
  prepaid_voucher_item_unusable: 'אחד מפריטי השובר אינו ניתן עוד למימוש — הורידו אותו מהבחירה ונסו שוב.',
  prepaid_voucher_quantity_fraction: 'כמות לא שלמה אפשרית רק במוצר שנמכר במשקל — תקנו את הכמות למספר שלם.',
  prepaid_voucher_already_applied: 'השובר כבר נמצא בעסקה זו — אין צורך לסרוק אותו שוב.',
  [VOUCHER_TEST_MIXED]: VOUCHER_TEST_TEXT.mixed,
  [VOUCHER_TEST_UNSUPPORTED]: 'הסדרה במצב בדיקה — יש לעדכן את הקופה לגרסה חדשה כדי לבדוק שובר זה',
  prepaid_voucher_not_stackable: 'שובר זה אינו ניתן לשילוב עם שוברים נוספים — ממשו אותו בעסקה נפרדת.',
  prepaid_voucher_other_not_stackable: 'בעסקה כבר יש שובר שאינו ניתן לשילוב עם שוברים נוספים — ממשו את השובר הזה בעסקה נפרדת.',
  prepaid_voucher_max_per_sale: 'הגעת למספר השוברים המקסימלי בעסקה — ממשו את השובר הנוסף בעסקה נפרדת',
  prepaid_voucher_same_batch: 'בעסקה כבר יש שובר מאותה סדרה, והסדרה אינה מאפשרת שילוב — ממשו אותו בעסקה נפרדת.',
  prepaid_voucher_min_purchase: 'סכום הקנייה (בלי פריטים שהשובר לא חל עליהם) נמוך ממינימום הקנייה של השובר — הוסיפו פריטים כדי להגיע אליו.',
  prepaid_voucher_no_eligible_items: 'אין בסל פריטים שהשובר חל עליהם — הוסיפו לסל פריט שהשובר חל עליו, ואז סרקו שוב.',
  prepaid_voucher_promotion_better: 'המבצע בסל משתלם יותר — השובר לא הוחל.',
  prepaid_voucher_update_required: 'יש לעדכן את גרסת הקופה כדי לממש שובר מסוג זה',
  [APPROVAL_NEEDED]: VOUCHER_TEXT.overrideBody,
  [APPROVAL_INVALID]: 'האישור אינו תקף — נדרש אישור של בעל הרשאת "אישור כפיית הנחה בשובר"',
};

/** A refusal's words: the cloud's own sentence first (who used it, when it expired), else the till's for its code. */
export function voucherReasonText(reason: string | null | undefined, cloudMessage?: string | null): string {
  if (cloudMessage && cloudMessage.trim()) return cloudMessage.trim();
  if (reason && VOUCHER_REASON_TEXT[reason]) return VOUCHER_REASON_TEXT[reason];
  return 'לא ניתן לממש את השובר כעת — נסו שוב, ואם זה חוזר פנו למנהל.';
}

/** A voucher code in the log: its last 4 characters only — never the whole code. */
export function voucherLogTail(code: string | null | undefined): string {
  const c = (code ?? '').trim();
  return `…${c.length > 4 ? c.slice(-4) : ''}`;
}

/** A voucher code as two scans of it compare: upper case, no spaces or dashes. */
export function voucherCodeKey(code: string | null | undefined): string | null {
  const k = (code ?? '').replace(/[\s-]+/g, '').toUpperCase();
  return k ? k : null;
}

/* ------------------------------------------------------------------ terms */

export type VoucherAccounting = 'discount' | 'payment' | 'zero';
export type VoucherPricingMode = 'cover' | 'fixed';

/** The lookup's word (`redemptionAccounting`, else the older `countsAsPayment`); anything unknown — `payment`. */
export function accountingOf(redemptionAccounting: unknown, countsAsPayment?: unknown): VoucherAccounting {
  const w = typeof redemptionAccounting === 'string' ? redemptionAccounting.trim().toLowerCase() : '';
  if (w === 'discount') return 'discount';
  if (w === 'zero' || w === 'zero_sale') return 'zero';
  if (w) return 'payment';
  if (countsAsPayment === false) return 'zero';
  return 'payment';
}

/** The voucher pays (or deducts) money on the document: not a ₪0 sale. */
export const countsAsPayment = (a: VoucherAccounting): boolean => a !== 'zero';

export interface VoucherGroupTerms {
  key: string;
  name: string;
  minUnits: number;
  maxUnits: number;
  /** What this voucher has left of the group. */
  remaining: number;
  /** Lower-cased ids (the cloud's and the till's) of the products it takes — the cloud's resolved list. */
  productIds: ReadonlySet<string>;
  excludedIds: ReadonlySet<string>;
  allowRepeat: boolean;
  /** "פריטים קבועים": an item of a fixed list as a group of its own ("item:<product>") — never sent as a group key. */
  item: boolean;
}

export interface VoucherTerms {
  typeName: string | null;
  pricing: VoucherPricingMode;
  tillValue: number | null;
  accounting: VoucherAccounting;
  groups: VoucherGroupTerms[];
  /** `totalMax`: units in all; null — the groups' maxima. */
  maxUnits: number | null;
  /** `totalRemaining`: what is left; null — the limit. */
  unitsLeft: number | null;
  splitAllowed: boolean;
  includeExtras: boolean;
  /** A voucher of fixed items (not of groups). */
  listItems: boolean;
}

export const ITEM_GROUP_PREFIX = 'item:';

export const unitLimit = (t: VoucherTerms): number => t.maxUnits ?? t.groups.reduce((s, g) => s + Math.max(0, g.maxUnits), 0);
export const unitsRemaining = (t: VoucherTerms): number => t.unitsLeft ?? unitLimit(t);

type Dto = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0).map((x) => x.toLowerCase()) : []);

/** A voucher of groups ("מנה 1/1 · משקה 0/1"): the new redemption; else the older list of goods. */
export function hasGroups(dto: Dto): boolean {
  return dto.selection === 'groups' || (Array.isArray(dto.groups) && dto.groups.length > 0);
}

/** A plain goods batch — a fixed list, cover, no till value, "לא מקבל הנחות" honoured: the only kind `/redeem` takes. */
export function isPlain(dto: Dto): boolean {
  const policy = dto.discountBlockPolicy && typeof dto.discountBlockPolicy === 'object' ? (dto.discountBlockPolicy as Dto).mode : null;
  return !hasGroups(dto) && (str(dto.pricing) ?? 'cover') === 'cover' && num(dto.tillValueAgorot) === null && (str(policy) ?? 'honour') === 'honour';
}

const DISCOUNT_KINDS = new Set(['order_discount', 'item_discount']);
export const isDiscountVoucher = (dto: Dto): boolean => DISCOUNT_KINDS.has(String(dto.kind ?? ''));

/** Held (reserve → confirm): a goods voucher of groups, or of a list that is not plain. */
export function isHeld(dto: Dto): boolean {
  return !isDiscountVoucher(dto) && (hasGroups(dto) || !isPlain(dto));
}

/** The voucher's terms as issued with its batch (a list voucher: each usable item left a group of its own). */
export function termsOf(dto: Dto): VoucherTerms {
  const split = typeof dto.wholeAtOnce === 'boolean' ? !dto.wholeAtOnce : dto.splitAllowed === true;
  const groups: VoucherGroupTerms[] = hasGroups(dto)
    ? (Array.isArray(dto.groups) ? (dto.groups as Dto[]) : []).map((g) => {
        const maxUnits = Math.max(0, Math.trunc(num(g.maxQty) ?? 1));
        const eligible = ids(g.eligibleProductIds);
        return {
          key: String(g.key ?? ''),
          name: str(g.name) ?? String(g.key ?? ''),
          minUnits: Math.max(0, Math.trunc(num(g.minQty) ?? 0)),
          maxUnits,
          remaining: Math.max(0, Math.trunc(num(g.remaining) ?? maxUnits)),
          productIds: new Set([...ids(g.productIds), ...eligible]),
          excludedIds: new Set([...ids(g.excludedIds), ...ids(g.excludeProductIds)]),
          allowRepeat: g.allowRepeat !== false,
          item: false,
        };
      })
    : (Array.isArray(dto.items) ? (dto.items as Dto[]) : [])
        .filter((it) => typeof it.productId === 'string' && it.usable !== false && (num(it.remaining) ?? 0) > 1e-9)
        .map((it) => {
          const left = it.weighed === true ? 1 : Math.max(1, Math.ceil((num(it.remaining) ?? 0) - 1e-9));
          const pid = String(it.productId).toLowerCase();
          const till = typeof it.tillProductId === 'string' && it.tillProductId ? it.tillProductId.toLowerCase() : null;
          return {
            key: ITEM_GROUP_PREFIX + pid,
            name: str(it.name) ?? pid,
            minUnits: split ? 0 : left,
            maxUnits: left,
            remaining: left,
            productIds: new Set(till ? [pid, till] : [pid]),
            excludedIds: new Set<string>(),
            allowRepeat: true,
            item: true,
          };
        });
  return {
    typeName: str(dto.typeName),
    pricing: dto.pricing === 'fixed' ? 'fixed' : 'cover',
    tillValue: num(dto.tillValueAgorot),
    accounting: accountingOf(dto.redemptionAccounting, dto.countsAsPayment),
    groups,
    maxUnits: hasGroups(dto) ? (num(dto.totalMax) ?? null) : null,
    unitsLeft: hasGroups(dto) ? (num(dto.totalRemaining) ?? num(dto.unitsLeft) ?? null) : null,
    splitAllowed: split,
    includeExtras: dto.includeExtras === true,
    listItems: !hasGroups(dto),
  };
}

/** A staff test voucher ("שובר בדיקה", the cloud's `isTest`; by its name when the flag is missing). */
export function isStaffTestVoucher(dto: Dto): boolean {
  if (typeof dto.isTest === 'boolean') return dto.isTest;
  return [dto.typeName, dto.batchName].some((n) => typeof n === 'string' && (n.trim() === 'שובר בדיקה' || n.trim().startsWith('שובר בדיקה ·')));
}

/* ------------------------------------------------------------------ units */

/** One unit of a sale line, as a voucher may cover it (a line of 3 is three units). */
export interface TillVoucherUnit {
  /** "<lineKey>#<n>". */
  id: string;
  lineKey: string;
  /** Lower-cased. */
  productId: string;
  name: string;
  categoryId: string | null;
  /** What the unit costs before the voucher (the share a voucher may cover of it), agorot. */
  price: number;
  /** Its menu price at redemption (the line's unit price, before any discount). */
  listValue: number;
  /** False: "לא מקבל הנחות" (or OTH). */
  discountable: boolean;
}

/** What a sale line costs now: its gross less every discount on it (promotions, discount vouchers, by hand, deductions). */
export function lineNet(l: SaleLine): number {
  return lineGross(l) - Math.max(0, l.promotionAgorot ?? 0) - Math.max(0, l.voucherAgorot ?? 0) - Math.max(0, l.discountAgorot ?? 0) - Math.max(0, l.prepaidDeductionAgorot ?? 0);
}

/** What a voucher may cover of a line: all of it with "כולל תוספות", else the dish's own share of what it costs. */
export function lineCoverable(l: SaleLine, includeExtras: boolean): number {
  const net = lineNet(l) + Math.max(0, l.prepaidDeductionAgorot ?? 0);
  const unit = unitAgorot(l);
  if (includeExtras || unit <= 0 || l.basePriceAgorot >= unit) return Math.max(0, net);
  return Math.max(0, Math.round((net * l.basePriceAgorot) / unit));
}

/** [total] shared over [weights] to the agora — the largest remainder; no weight at all: an equal share each. */
export function shareByWeight(total: number, weights: readonly number[]): number[] {
  if (weights.length === 0) return [];
  if (total <= 0) return weights.map(() => 0);
  let w = weights.map((x) => Math.max(0, x));
  if (w.reduce((s, x) => s + x, 0) <= 0) w = w.map(() => 1);
  const sum = w.reduce((s, x) => s + x, 0);
  const raw = w.map((x) => (total * x) / sum);
  const out = raw.map((x) => Math.floor(x));
  let left = total - out.reduce((s, x) => s + x, 0);
  const order = raw.map((x, i) => [x - Math.floor(x), i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of order) {
    if (left <= 0) break;
    out[i] += 1;
    left -= 1;
  }
  return out;
}

/**
 * The basket's sale units a voucher may cover, in basket order (VoucherCart.voucherUnitsOf): one per whole unit of a line,
 * each its share of what the voucher may cover of the line; a credit line is none; a line the sale's production vouchers
 * already took units of offers only the rest ([covered]: units per line), and a marked line no voucher booked offers none.
 */
export function voucherUnitsOf(lines: readonly SaleLine[], o: { includeExtras: boolean; covered?: ReadonlyMap<string, number> }): TillVoucherUnit[] {
  const out: TillVoucherUnit[] = [];
  for (const l of lines) {
    if (typeof l.creditAgorot === 'number' || l.qty <= 0) continue;
    const skip = Math.min(l.qty, o.covered?.get(l.key) ?? 0);
    if (l.voucherMark && !o.covered?.has(l.key)) continue;
    const n = Math.floor(l.qty + 1e-6);
    if (n < 1 || skip >= n) continue;
    // Priced as the line was before a voucher's deduction took part of it.
    const prices = shareByWeight(lineCoverable(l, o.includeExtras), Array.from({ length: n }, () => 1));
    const listed = shareByWeight(lineGross(l), Array.from({ length: n }, () => 1));
    for (let i = skip; i < n; i++) {
      out.push({
        id: `${l.key}#${i}`,
        lineKey: l.key,
        productId: l.productId.toLowerCase(),
        name: l.name,
        categoryId: l.categoryId ?? null,
        price: prices[i],
        listValue: listed[i],
        discountable: !l.noDiscount && !l.oth,
      });
    }
  }
  return out;
}

/** Units of each line the sale's production vouchers took (voucherCoveredUnitCounts). */
export function coveredUnitCounts(redemptions: ReadonlyArray<{ units: ReadonlyArray<{ lineKey: string }> }>): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of redemptions) for (const u of r.units) out.set(u.lineKey, (out.get(u.lineKey) ?? 0) + 1);
  return out;
}

/* ------------------------------------------------------------- the scan */

/** Whether [group] takes [unit]: its resolved product list, less what it excludes. */
export function groupTakes(group: VoucherGroupTerms, unit: Pick<TillVoucherUnit, 'productId'>): boolean {
  const pid = unit.productId.toLowerCase();
  return group.productIds.has(pid) && !group.excludedIds.has(pid);
}

/** The most units a voucher may take in this sale: what it has left, within its per-sale limit less what it took here. */
export function voucherSaleCap(remaining: number, perSale: number | null | undefined, takenInSale = 0): number {
  return Math.max(0, perSale && perSale > 0 ? Math.min(remaining, perSale - takenInSale) : remaining);
}

export interface VoucherScanState {
  terms: VoucherTerms;
  units: TillVoucherUnit[];
  /** Unit id → group key: every single, clear match. */
  assigned: Record<string, string>;
  ambiguous: Assignment['ambiguous'];
  unassigned: Assignment['unassigned'];
  /** The most units this voucher may take in this sale. */
  cap: number;
  /** Why the placement cannot be redeemed as it stands (the cloud's check); null — it can. */
  refusal: SelectionRefusal | null;
}

/**
 * The redeem state of a voucher scanned against [units] (voucherScanState / VoucherRedeemState.of): every single, clear
 * match placed, held to what the voucher may take in this sale ([cap]).
 */
export function voucherScanState(terms: VoucherTerms, units: readonly TillVoucherUnit[], cap: number | null = null, already: Readonly<Record<string, string>> = {}): VoucherScanState {
  const left = unitsRemaining(terms);
  const total = Math.min(left, cap ?? left);
  const placedIds = new Set(Object.keys(already));
  const groups = terms.groups.map((g) => ({ key: g.key, remaining: g.remaining - Object.values(already).filter((k) => k === g.key).length, takes: (u: TillVoucherUnit) => groupTakes(g, u) }));
  const free = units.filter((u) => !placedIds.has(u.id));
  const a = assignUnitsBy(groups, free.map((u) => [u.id, u] as const), total - placedIds.size);
  const assigned: Record<string, string> = {};
  for (const u of units) {
    const k = already[u.id] ?? a.assigned[u.id];
    if (k) assigned[u.id] = k;
  }
  return { terms, units: [...units], assigned, ambiguous: a.ambiguous, unassigned: a.unassigned, cap: total, refusal: selectionRefusal(terms, units, assigned) };
}

/** The cloud's check of a placement (VoucherPricing.selectionRefusal): each unit by its product, each group what it takes. */
export function selectionRefusal(terms: VoucherTerms, units: readonly TillVoucherUnit[], assigned: Readonly<Record<string, string>>): SelectionRefusal | null {
  const byId = new Map(units.map((u) => [u.id, u] as const));
  const chosen = Object.entries(assigned).flatMap(([uid, key]) => {
    const u = byId.get(uid);
    return u ? [[u.productId, key, 1] as const] : [];
  });
  const groups = terms.groups.map((g) => ({
    key: g.key,
    name: g.name,
    minQty: g.minUnits,
    maxQty: g.maxUnits,
    remaining: g.remaining,
    productIds: units.filter((u) => groupTakes(g, u)).map((u) => u.productId),
    allowRepeat: g.allowRepeat,
    excludedIds: units.filter((u) => g.excludedIds.has(u.productId)).map((u) => u.productId),
  }));
  return checkSelection(groups, chosen, { totalMax: unitLimit(terms), totalRemaining: unitsRemaining(terms), wholeAtOnce: !terms.splitAllowed, typeName: terms.typeName });
}

/**
 * Units left out only because a group (or the voucher) is full, while a unit of ANOTHER product took the place: which item
 * the voucher covers is the cashier's choice. More of the same product is no choice — the first ones are covered.
 */
export function voucherGroupChoice(st: VoucherScanState): boolean {
  const byId = new Map(st.units.map((u) => [u.id, u] as const));
  const taken = new Set(Object.keys(st.assigned).map((id) => byId.get(id)?.productId));
  return st.unassigned.some(({ ref, reason }) => {
    if (reason !== UNIT_GROUP_FULL && reason !== UNIT_TOTAL_FULL) return false;
    const u = byId.get(ref);
    if (!u) return false;
    return st.terms.groups.some((g) => groupTakes(g, u)) && !taken.has(u.productId);
  });
}

/** A group and the candidates of it the cashier picks from (a choice): the units it could take that are not placed. */
export function choiceOf(st: VoucherScanState): { groupKey: string; groupName: string; placed: string[]; candidates: TillVoucherUnit[] } | null {
  const byId = new Map(st.units.map((u) => [u.id, u] as const));
  const takenProducts = new Set(Object.keys(st.assigned).map((id) => byId.get(id)?.productId));
  for (const g of st.terms.groups) {
    const left = st.unassigned.filter(({ ref, reason }) => (reason === UNIT_GROUP_FULL || reason === UNIT_TOTAL_FULL) && groupTakes(g, byId.get(ref)!) && !takenProducts.has(byId.get(ref)!.productId));
    if (left.length === 0) continue;
    const placed = Object.entries(st.assigned)
      .filter(([, k]) => k === g.key)
      .map(([id]) => id);
    // One unit per product: which product is the choice, not which of its units.
    const seen = new Set<string>();
    const candidates = [...placed.map((id) => byId.get(id)!), ...left.map((x) => byId.get(x.ref)!)].filter((u) => (seen.has(u.productId) ? false : (seen.add(u.productId), true)));
    return { groupKey: g.key, groupName: g.name, placed, candidates };
  }
  return null;
}

/** [st] with [unitId] in [groupKey] in place of [replace] (the cashier's pick of an ambiguous unit or of a group's item). */
export function withPick(st: VoucherScanState, unitId: string, groupKey: string, replace: readonly string[] = []): VoucherScanState {
  const already: Record<string, string> = {};
  for (const [id, k] of Object.entries(st.assigned)) if (!replace.includes(id)) already[id] = k;
  already[unitId] = groupKey;
  return voucherScanState(st.terms, st.units, st.cap, already);
}

export type VoucherAutoBlock = 'off' | 'not_groups' | 'test_mode' | 'test_approval' | 'ambiguous' | 'incomplete' | 'choice';
export type VoucherAutoDecision = { kind: 'apply' } | { kind: 'discount' } | { kind: 'sheet'; why: VoucherAutoBlock };

/**
 * The rule (voucherAutoDecision): applied at once when `voucherAutoApply` is [on] and nothing needs a person — no unit fitting
 * several groups, no choice of which item fills a group, something the voucher can take as placed, not a test voucher, not
 * a simulation. A discount voucher keeps the order's own discount path either way. The manager's code of a forced reduction
 * is the cloud's answer (asked then).
 */
export function voucherAutoDecision(on: boolean, st: VoucherScanState | null, o: { discount?: boolean; testMode?: boolean; testNeedsApproval?: boolean } = {}): VoucherAutoDecision {
  if (o.discount) return { kind: 'discount' };
  if (!on) return { kind: 'sheet', why: 'off' };
  if (!st) return { kind: 'sheet', why: 'not_groups' };
  if (o.testMode) return { kind: 'sheet', why: 'test_mode' };
  if (o.testNeedsApproval) return { kind: 'sheet', why: 'test_approval' };
  if (st.ambiguous.length > 0) return { kind: 'sheet', why: 'ambiguous' };
  if (st.refusal || Object.keys(st.assigned).length === 0) return { kind: 'sheet', why: 'incomplete' };
  if (voucherGroupChoice(st)) return { kind: 'sheet', why: 'choice' };
  return { kind: 'apply' };
}

/** What the voucher still gives in this sale after [st]'s placement (the cloud's `entitlement_left`); null — nothing. */
export function voucherEntitlementOf(terms: VoucherTerms, takenByGroup: ReadonlyMap<string, number>, totalLeftAfter: number): EntitlementLeft | null {
  if (terms.listItems || terms.groups.length === 0) return null;
  return entitlementLeft(
    terms.groups.map((g) => ({ key: g.key, name: g.name, remaining: g.remaining - (takenByGroup.get(g.key) ?? 0) })),
    totalLeftAfter,
    terms.splitAllowed,
  );
}

/* ---------------------------------------------------------- the redemption */

/** One covered unit as the voucher priced it (the cloud's answer, or cover pricing for `/redeem`). */
export interface AppliedUnit {
  unitId: string;
  lineKey: string;
  groupKey: string | null;
  groupName: string | null;
  productId: string;
  name: string;
  /** Before the voucher. */
  price: number;
  /** What it is sold at with the voucher (fixed: its share of the value; cover: its price; zero: 0). */
  salePrice: number;
  /** What the voucher pays of it — its share of the deduction or the tender. */
  covered: number;
  listValue: number;
  forced: boolean;
  reduction: number;
}

/** A production voucher approved for this sale: by the cloud's hold ([reservationId]) or its `/redeem` ([source] `redeem`). */
export interface AppliedProduction {
  source: 'reserve' | 'redeem';
  /** The hold (reserve → confirm); null for `/redeem`. */
  reservationId: string | null;
  /** The cloud's redemption (`/redeem`), or the hold's request id. */
  redemptionId: string;
  code: string;
  voucherId: string;
  batchId: string;
  serial: number;
  typeName: string | null;
  batchName: string | null;
  productionName: string | null;
  accounting: VoucherAccounting;
  pricing: VoucherPricingMode;
  tillValue: number | null;
  includeExtras: boolean;
  /** What it pays: the deduction, or the tender leg; 0 in zero mode. */
  amountAgorot: number;
  topUpAgorot: number;
  note: string | null;
  units: AppliedUnit[];
  inSale: VoucherInSale & { testMode?: boolean };
  /** "מצב בדיקה": nothing was consumed — the sale is a simulation. */
  testMode: boolean;
  /** The manager whose code approved a forced reduction — sent again with the confirm. */
  approval: { posUserId: string; posUserName: string; method: string } | null;
  /** What it still gives in this sale (the payment's alert); null — nothing. */
  entitlement?: EntitlementLeft | null;
  validUntil?: string | null;
  usesToday?: number | null;
  maxUsesPerDay?: number | null;
}

/** The redemption as the document keeps it (VoucherRedemption, `transactions.prepaidVouchersJson`): its units by line. */
export interface DocPrepaidRedemption {
  redemptionId: string;
  reservationId: string | null;
  /** `/redeem`'s: linked to the document by `…/redemptions/{id}/transaction`. */
  legacy: boolean;
  voucherId: string | null;
  batchId: string | null;
  serial: number;
  typeName: string | null;
  batchName: string | null;
  productionName: string | null;
  accounting: VoucherAccounting;
  pricing: VoucherPricingMode;
  amountAgorot: number;
  topUpAgorot: number;
  approval: { posUserId: string; posUserName: string; method: string } | null;
  units: Array<{ lineKey: string; productId: string; groupId: string | null; groupName: string | null; name: string; listValueAgorot: number; salePriceAgorot: number; coveredAgorot: number }>;
}

/** "כלול בשובר #12 · שובר ארוחה" — the mark on a covered line. */
export function voucherLineMark(serial: number, typeName?: string | null): string {
  return `כלול בשובר #${serial}` + (typeName && typeName.trim() ? ` · ${typeName.trim()}` : '');
}

const scale = (a: number | undefined, keep: number): number | undefined => (a === undefined ? undefined : Math.round(a * keep));

/** The voucher reprices its units (zero: ₪0; a payment of a fixed value: its shares); cover keeps the prices and marks. */
export function repricedBy(a: Pick<AppliedProduction, 'accounting' | 'pricing' | 'tillValue'>): boolean {
  return !countsAsPayment(a.accounting) || (a.accounting === 'payment' && a.pricing === 'fixed' && a.tillValue !== null);
}

export interface BookedSale {
  lines: SaleLine[];
  /** The "שוברי הפקה" legs, in order: which voucher, and what it pays (never more than is owed then). */
  legs: Array<{ applied: AppliedProduction; amountAgorot: number }>;
  redemptions: DocPrepaidRedemption[];
  /** By promotion id: what the covered units had of it (taken off the promotions' totals). */
  promotionsLost: Map<string, number>;
}

/**
 * [applied] on the sale's [lines], in order (Cart.withProductionVouchers / applyVoucherRedemption): each voucher's units on its
 * lines — repriced to their voucher price on lines of their own (zero, a fixed payment), or marked; a deduction's share on
 * the lines it covers (never more than a line's own total); a payment voucher's leg for what it pays, never more than is
 * owed then ([totalOf]: the sale's total of these lines).
 */
export function bookProductionVouchers(lines: readonly SaleLine[], applied: readonly AppliedProduction[], totalOf: (lines: readonly SaleLine[]) => number): BookedSale {
  let cur = lines.map((l) => ({ ...l }));
  const legs: BookedSale['legs'] = [];
  const redemptions: DocPrepaidRedemption[] = [];
  const promotionsLost = new Map<string, number>();
  for (const a of applied) {
    const mark = voucherLineMark(a.serial, a.typeName);
    const lineOfUnit = new Map<string, string>();
    if (repricedBy(a)) cur = reprice(cur, a, mark, lineOfUnit, promotionsLost);
    else cur = markCovered(cur, a, mark, lineOfUnit);
    if (a.accounting === 'discount') {
      const share = new Map<string, number>();
      for (const u of a.units) {
        const key = lineOfUnit.get(u.unitId) ?? u.lineKey;
        share.set(key, (share.get(key) ?? 0) + u.covered);
      }
      cur = cur.map((l) => {
        const s = share.get(l.key);
        if (!s) return l;
        const room = Math.max(0, lineNet(l));
        return { ...l, prepaidDeductionAgorot: (l.prepaidDeductionAgorot ?? 0) + Math.min(s, room) };
      });
    }
    redemptions.push({
      redemptionId: a.redemptionId,
      reservationId: a.reservationId,
      legacy: a.source === 'redeem',
      voucherId: a.voucherId || null,
      batchId: a.batchId || null,
      serial: a.serial,
      typeName: a.typeName,
      batchName: a.batchName,
      productionName: a.productionName,
      accounting: a.accounting,
      pricing: a.pricing,
      amountAgorot: a.amountAgorot,
      topUpAgorot: a.topUpAgorot,
      approval: a.approval,
      units: a.units.map((u) => ({
        lineKey: lineOfUnit.get(u.unitId) ?? u.lineKey,
        productId: u.productId,
        groupId: u.groupKey,
        groupName: u.groupName,
        name: u.name,
        listValueAgorot: u.listValue,
        salePriceAgorot: u.salePrice,
        coveredAgorot: u.covered,
      })),
    });
    if (a.accounting === 'payment') {
      const owed = totalOf(cur) - legs.reduce((s, l) => s + l.amountAgorot, 0);
      legs.push({ applied: a, amountAgorot: owed <= 0 ? 0 : Math.min(a.amountAgorot, owed) });
    }
  }
  return { lines: cur, legs, redemptions, promotionsLost };
}

/** Cover: the lines whose units [a] covers, marked ("(2)" when part of the line) — the prices stay. */
function markCovered(lines: SaleLine[], a: AppliedProduction, mark: string, lineOfUnit: Map<string, string>): SaleLine[] {
  const counts = new Map<string, number>();
  for (const u of a.units) {
    counts.set(u.lineKey, (counts.get(u.lineKey) ?? 0) + 1);
    lineOfUnit.set(u.unitId, u.lineKey);
  }
  return lines.map((l) => {
    const n = counts.get(l.key);
    if (!n) return l;
    const note = mark + (n >= l.qty - 1e-9 ? '' : ` (${n})`);
    return { ...l, voucherMark: l.voucherMark ? `${note} · ${l.voucherMark}` : note };
  });
}

/**
 * Zero / a fixed payment (withVoucherPrices): each covered line's units on lines of their own — one per voucher price — at
 * that price with what the voucher does not cover of them (paid extras), no discount or promotion of their own and out of
 * the basket discount; the rest of the line stays as it was.
 */
function reprice(lines: SaleLine[], a: AppliedProduction, mark: string, lineOfUnit: Map<string, string>, promotionsLost: Map<string, number>): SaleLine[] {
  const byLine = new Map<string, AppliedUnit[]>();
  for (const u of a.units) byLine.set(u.lineKey, [...(byLine.get(u.lineKey) ?? []), u]);
  const out: SaleLine[] = [];
  const lose = (id: string | null | undefined, amount: number) => {
    if (id && amount > 0) promotionsLost.set(id, (promotionsLost.get(id) ?? 0) + amount);
  };
  for (const l of lines) {
    const units = byLine.get(l.key);
    if (!units || typeof l.creditAgorot === 'number') {
      out.push(l);
      continue;
    }
    const k = Math.min(units.length, l.qty);
    const rest = l.qty - k;
    if (rest > 1e-9) {
      const keep = rest / l.qty;
      const kept: SaleLine = {
        ...l,
        qty: rest,
        discountAgorot: scale(l.discountAgorot, keep),
        promotionAgorot: scale(l.promotionAgorot, keep),
        voucherAgorot: scale(l.voucherAgorot, keep),
        promotionYieldedAgorot: scale(l.promotionYieldedAgorot, keep),
      };
      lose(l.promotionId, (l.promotionAgorot ?? 0) - (kept.promotionAgorot ?? 0));
      out.push(kept);
    } else lose(l.promotionId, l.promotionAgorot ?? 0);
    const prices = new Map<number, AppliedUnit[]>();
    for (const u of units) prices.set(u.salePrice, [...(prices.get(u.salePrice) ?? []), u]);
    [...prices.entries()].forEach(([price, same], i) => {
      const key = rest > 1e-9 || i > 0 ? `${l.key}~v${i}` : l.key;
      for (const u of same) lineOfUnit.set(u.unitId, key);
      const free = a.includeExtras;
      out.push({
        ...l,
        key,
        qty: same.length,
        basePriceAgorot: price,
        // "כולל תוספות": the voucher's price is the dish's whole; else its paid extras are paid as before.
        options: free ? l.options.map((o) => ({ ...o, chargedAgorot: 0 })) : l.options,
        meal: free && l.meal ? { ...l.meal, components: l.meal.components.map((c) => ({ ...c, upchargeAgorot: 0, options: c.options.map((o) => ({ ...o, chargedAgorot: 0 })) })) } : l.meal,
        discountAgorot: undefined,
        promotionAgorot: undefined,
        promotionId: null,
        promotionName: null,
        voucherAgorot: undefined,
        promotionYieldedAgorot: undefined,
        prepaidDeductionAgorot: undefined,
        oth: null,
        // Out of the basket discount: the voucher's price is the price (§7).
        noDiscount: true,
        voucherMark: l.voucherMark ? `${mark} · ${l.voucherMark}` : mark,
      });
    });
  }
  return out;
}

/** Cover pricing of a voucher redeemed by `/redeem` (applyLegacyBooked): zero — ₪0; else each unit covered at its price. */
export function coverPriced(accounting: VoucherAccounting, units: readonly TillVoucherUnit[], groupOf: (u: TillVoucherUnit) => { key: string | null; name: string | null }): AppliedUnit[] {
  return units.map((u) => {
    const g = groupOf(u);
    const zero = !countsAsPayment(accounting);
    return { unitId: u.id, lineKey: u.lineKey, groupKey: g.key, groupName: g.name, productId: u.productId, name: u.name, price: u.price, salePrice: zero ? 0 : u.price, covered: zero ? 0 : u.price, listValue: u.listValue, forced: false, reduction: 0 };
  });
}

/** What [a] takes off what is left to pay (productionVoucherEffect). */
export function productionVoucherEffect(a: Pick<AppliedProduction, 'accounting' | 'pricing' | 'tillValue' | 'amountAgorot' | 'units'>): number {
  if (countsAsPayment(a.accounting) && (a.pricing === 'cover' || a.tillValue === null)) return a.amountAgorot;
  if (a.accounting === 'discount') return a.amountAgorot;
  return a.units.reduce((s, u) => s + u.price, 0);
}

/** "המבורגר, קולה ×2": the sale's items [a] covers, by their lines' names (voucherAppliedWhat). */
export function voucherAppliedWhat(a: Pick<AppliedProduction, 'units'>, lines: readonly SaleLine[]): string {
  const names = new Map(lines.map((l) => [l.key, l.name] as const));
  const counts = new Map<string, number>();
  for (const u of a.units) {
    const name = names.get(u.lineKey) ?? u.name;
    if (!name) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n)).join(', ');
}

/** "השובר כבר נסרק בעסקה זו (שובר #12 · burger ×2 · ₪32.00)" — a second scan of a voucher this sale holds. */
export function voucherRescanText(ref: { serial: number; covers: string | null; amountAgorot: number | null } | null): string {
  if (!ref) return VOUCHER_TEXT.alreadyScanned;
  const parts = [ref.serial > 0 ? `שובר #${ref.serial}` : null, ref.covers && ref.covers.trim() ? ref.covers : null, ref.amountAgorot && ref.amountAgorot > 0 ? shekel(ref.amountAgorot) : null].filter(Boolean);
  return parts.length === 0 ? VOUCHER_TEXT.alreadyScanned : `${VOUCHER_TEXT.alreadyScanned} (${parts.join(' · ')})`;
}

/* ------------------------------------------------------------- the close */

/** One voucher of the sale that still gives the customer something, as its close says it. */
export interface VoucherLeftTerms {
  list: string;
  splitAllowed: boolean;
  validUntil?: string | null;
  dayLimitReached?: boolean;
}

export const VOUCHER_CLOSE_TEXT = {
  lost: (list: string) => `סגירה עכשיו — מה שלא מומש מהשובר יאבד (${list})`,
  lostMany: (list: string) => `סגירה עכשיו — מה שלא מומש מהשוברים יאבד (${list})`,
  closing: 'סגירה עכשיו — ',
  stays: (list: string) => `מה שלא מומש יישאר בשובר (${list})`,
  validUntil: (date: string) => ` · בתוקף עד ${date}`,
  validToday: ' · בתוקף עד היום',
  againTomorrow: ' · ניתן לממש שוב מחר',
  notTaken: (list: string) => `לא נלקח: ${list}`,
} as const;

const pad2 = (n: number) => String(n).padStart(2, '0');

/** " · בתוקף עד 31.10.2026" / " · בתוקף עד היום 23:59" of [validUntil] seen at [now] (local time); null — none or unreadable. */
export function voucherValidityText(validUntil: string | null | undefined, now: Date): string | null {
  const raw = (validUntil ?? '').trim();
  if (!raw) return null;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);
  let at: Date | null = null;
  if (!dateOnly) {
    const t = Date.parse(raw);
    if (Number.isFinite(t)) at = new Date(t);
  }
  let y: number, m: number, d: number;
  if (at) [y, m, d] = [at.getFullYear(), at.getMonth() + 1, at.getDate()];
  else {
    const mm = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
    if (!mm) return null;
    [y, m, d] = [Number(mm[1]), Number(mm[2]), Number(mm[3])];
  }
  if (y === now.getFullYear() && m === now.getMonth() + 1 && d === now.getDate()) return VOUCHER_CLOSE_TEXT.validToday + (at ? ` ${pad2(at.getHours())}:${pad2(at.getMinutes())}` : '');
  return VOUCHER_CLOSE_TEXT.validUntil(`${pad2(d)}.${pad2(m)}.${y}`);
}

export function voucherStaysText(v: VoucherLeftTerms, now: Date): string {
  const validity = voucherValidityText(v.validUntil, now);
  const lastDay = validity?.startsWith(VOUCHER_CLOSE_TEXT.validToday) === true;
  return VOUCHER_CLOSE_TEXT.stays(v.list) + (validity ?? '') + (v.dayLimitReached && !lastDay ? VOUCHER_CLOSE_TEXT.againTomorrow : '');
}

/**
 * A sale closed while its vouchers still give the customer something — never blocked (voucherCloseMessages): ONE
 * confirmation when a voucher of one sale gives something up; what stays on vouchers in parts; the success's amber lines.
 */
export function voucherCloseMessages(vouchers: readonly VoucherLeftTerms[], now: Date): { confirm: string | null; note: string | null; notTaken: string } | null {
  if (vouchers.length === 0) return null;
  const lost = vouchers.filter((v) => !v.splitAllowed);
  const stays = vouchers.filter((v) => v.splitAllowed).map((v) => voucherStaysText(v, now));
  const lostText = lost.length === 0 ? null : lost.length === 1 ? VOUCHER_CLOSE_TEXT.lost(lost[0].list) : VOUCHER_CLOSE_TEXT.lostMany(lost.map((v) => v.list).join(' · '));
  return {
    confirm: lostText ? [lostText, ...stays].join('\n') : null,
    note: stays.length > 0 ? stays.join('\n') : null,
    notTaken: [VOUCHER_CLOSE_TEXT.notTaken(vouchers.map((v) => v.list).join(' · ')), ...(lostText ? [lostText.slice(VOUCHER_CLOSE_TEXT.closing.length)] : []), ...stays].join('\n'),
  };
}

/** A voucher's per-day limit is reached with this sale's redemption. */
export function voucherDayLimitReached(usesToday: number | null | undefined, maxPerDay: number | null | undefined): boolean {
  return typeof maxPerDay === 'number' && maxPerDay > 0 && (usesToday ?? 0) + 1 >= maxPerDay;
}

/** The entitlement's words as the close takes them (voucherLeftOfAlert): its list, and in parts when it says what stays. */
export function voucherLeftOf(a: AppliedProduction, now?: Date): VoucherLeftTerms | null {
  const e = a.entitlement;
  if (!e) return null;
  void now;
  return { list: e.groups.map((g) => `${g.name} ×${g.count}`).join(' · '), splitAllowed: e.closeConfirm === null && e.closeNote !== null, validUntil: a.validUntil ?? null, dayLimitReached: voucherDayLimitReached(a.usesToday, a.maxUsesPerDay) };
}

/* ------------------------------------------------------------ on the paper */

/** "שובר מס׳ 0008 · ארוחה" — the type's name without its leading "שובר". */
export function voucherTitle(serial: number, typeName: string | null | undefined): string {
  const type = (typeName ?? '').trim().replace(/^שובר/, '').trim();
  return `שובר מס׳ ${String(Math.max(0, serial)).padStart(4, '0')}` + (type ? ` · ${type}` : '');
}

/** "קיזוז שובר הפקה מס׳ 0008" — a deduction's row on the receipt (never "הנחה"). */
export function voucherDeductionLabel(serial: number): string {
  return `קיזוז שובר הפקה מס׳ ${String(Math.max(0, serial)).padStart(4, '0')}`;
}

/** What a voucher covered, one row per product (and group when a package names several): "מנה: המבורגר ×1". */
export function voucherCoveredLines(r: Pick<DocPrepaidRedemption, 'units'>): string[] {
  const labelled = new Set(r.units.map((u) => (u.groupName ?? '').trim()).filter(Boolean)).size > 1;
  const rows = new Map<string, number>();
  for (const u of r.units) {
    const key = `${labelled && u.groupName ? `${u.groupName}: ` : ''}${u.name || u.productId}`;
    rows.set(key, (rows.get(key) ?? 0) + 1);
  }
  return [...rows.entries()].map(([k, n]) => `${k} ×${n}`);
}

/** Per line: what a zero-mode voucher's goods were worth (the memo under a ₪0 line). */
export function offVoucherLineValues(redemptions: readonly DocPrepaidRedemption[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of redemptions) if (!countsAsPayment(r.accounting)) for (const u of r.units) out.set(u.lineKey, (out.get(u.lineKey) ?? 0) + u.listValueAgorot);
  return out;
}

/** "₪25.00 · כלול בשובר #12 · שובר ארוחה" — under a ₪0 voucher line. */
export function voucherLineMemo(valueAgorot: number, mark: string | null | undefined): string {
  const rest = (mark ?? '').replace(/^כלול בשובר/, '').trim();
  return `${shekel(valueAgorot)} · כלול בשובר${rest ? ` ${rest}` : ''}`;
}

/** "שווי הפריטים בשובר: ₪80.00 · שולם בשובר הפקה" — under the items, outside every total. */
export function voucherGoodsSummaryText(valueAgorot: number): string {
  return `שווי הפריטים בשובר: ${shekel(valueAgorot)} · שולם בשובר הפקה`;
}

/* --------------------------------------------------------- the X and the Z */

/** The production vouchers redeemed in a shift's written sales (VoucherInfoTotals): information, added to nothing. */
export interface VoucherInfoTotals {
  redeemed: number;
  redeemedItems: number;
  deductionAgorot: number;
  byType: Array<{ name: string; vouchers: number }>;
  byProduction: Array<{ name: string; vouchers: number }>;
  vouchers: number;
  items: number;
  valueAgorot: number;
  rows: Array<{ name: string; vouchers: number; items: number; valueAgorot: number }>;
}

export function voucherInfoOf(byDocument: ReadonlyArray<readonly DocPrepaidRedemption[]>): VoucherInfoTotals {
  const all = byDocument.flat().filter((r) => r.units.length > 0 || r.amountAgorot > 0);
  const count = (list: readonly DocPrepaidRedemption[]) => new Set(list.map((r) => r.voucherId ?? r.redemptionId)).size;
  const counts = (list: readonly DocPrepaidRedemption[], name: (r: DocPrepaidRedemption) => string | null) => {
    const m = new Map<string, DocPrepaidRedemption[]>();
    for (const r of list) {
      const n = (name(r) ?? '').trim();
      m.set(n, [...(m.get(n) ?? []), r]);
    }
    return [...m.entries()].map(([n, rs]) => ({ name: n, vouchers: count(rs) })).sort((a, b) => a.name.localeCompare(b.name));
  };
  const paying = all.filter((r) => countsAsPayment(r.accounting));
  const off = all.filter((r) => !countsAsPayment(r.accounting));
  const rowsMap = new Map<string, DocPrepaidRedemption[]>();
  for (const r of off) {
    const n = (r.typeName ?? '').trim() || (r.batchName ?? '').trim();
    rowsMap.set(n, [...(rowsMap.get(n) ?? []), r]);
  }
  const listValue = (r: DocPrepaidRedemption) => r.units.reduce((s, u) => s + u.listValueAgorot, 0);
  return {
    redeemed: count(paying),
    redeemedItems: paying.reduce((s, r) => s + r.units.length, 0),
    deductionAgorot: paying.filter((r) => r.accounting === 'discount').reduce((s, r) => s + r.amountAgorot, 0),
    byType: counts(paying, (r) => r.typeName ?? r.batchName),
    byProduction: counts(paying, (r) => r.productionName),
    vouchers: count(off),
    items: off.reduce((s, r) => s + r.units.length, 0),
    valueAgorot: off.reduce((s, r) => s + listValue(r), 0),
    rows: [...rowsMap.entries()]
      .map(([name, list]) => ({ name, vouchers: count(list), items: list.reduce((s, r) => s + r.units.length, 0), valueAgorot: list.reduce((s, r) => s + listValue(r), 0) }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export const voucherInfoEmpty = (i: VoucherInfoTotals): boolean => i.redeemed === 0 && i.vouchers === 0;

/** The X's / Z's sections (voucherInfoLines): "שוברי הפקה" and "שוברי הפקה (לא כלול בסה״כ)". */
export function voucherInfoLines(info: VoucherInfoTotals): Array<{ label: string; value: string; title?: boolean }> {
  if (voucherInfoEmpty(info)) return [];
  const out: Array<{ label: string; value: string; title?: boolean }> = [];
  if (info.redeemed > 0) {
    out.push({ label: 'שוברי הפקה', value: '', title: true });
    out.push({ label: 'שוברים', value: String(info.redeemed) });
    out.push({ label: 'פריטים', value: String(info.redeemedItems) });
    if (info.deductionAgorot > 0) out.push({ label: 'קיזוזי שוברים', value: formatAgorot(info.deductionAgorot) });
    const types = info.byType.filter((t) => t.name);
    if (types.length > 0) {
      out.push({ label: 'לפי סוג שובר', value: '' });
      for (const t of types) out.push({ label: `  ${t.name}`, value: String(t.vouchers) });
    }
    const productions = info.byProduction.filter((t) => t.name);
    if (productions.length > 0) {
      out.push({ label: 'לפי הפקה', value: '' });
      for (const t of productions) out.push({ label: `  ${t.name}`, value: String(t.vouchers) });
    }
  }
  if (info.vouchers > 0) {
    out.push({ label: 'שוברי הפקה (לא כלול בסה״כ)', value: '', title: true });
    out.push({ label: 'שוברים', value: String(info.vouchers) });
    out.push({ label: 'פריטים', value: String(info.items) });
    out.push({ label: 'שווי', value: formatAgorot(info.valueAgorot) });
    if (info.rows.length > 1 || info.rows.some((r) => r.name)) {
      for (const r of info.rows) out.push({ label: r.name || 'שובר', value: `${r.vouchers} · ${r.items} · ${formatAgorot(r.valueAgorot)}` });
    }
  }
  return out;
}

/** Read back ([voucherInfoJson], a close's `prepaidVouchersInfo`, a Z's `prepaidVouchers`): anything missing is none. */
export function voucherInfoFromJson(o: unknown): VoucherInfoTotals {
  const x = o && typeof o === 'object' ? (o as Record<string, unknown>) : {};
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const counts = (v: unknown) =>
    (Array.isArray(v) ? v : []).flatMap((r) => (r && typeof r === 'object' ? [{ name: String((r as Record<string, unknown>).name ?? ''), vouchers: n((r as Record<string, unknown>).vouchers) }] : []));
  return {
    redeemed: n(x.redeemed),
    redeemedItems: n(x.redeemedItems),
    deductionAgorot: n(x.deductionAgorot),
    byType: counts(x.byType),
    byProduction: counts(x.byProduction),
    vouchers: n(x.vouchers),
    items: n(x.items),
    valueAgorot: n(x.valueAgorot),
    rows: (Array.isArray(x.rows) ? x.rows : []).flatMap((r) => {
      if (!r || typeof r !== 'object') return [];
      const o2 = r as Record<string, unknown>;
      return [{ name: String(o2.name ?? ''), vouchers: n(o2.vouchers), items: n(o2.items), valueAgorot: n(o2.valueAgorot) }];
    }),
  };
}

/** [info] as the shift close keeps it (`prepaidVouchersInfo`, voucherInfoJson). */
export function voucherInfoJson(info: VoucherInfoTotals): Record<string, unknown> {
  return {
    redeemed: info.redeemed,
    redeemedItems: info.redeemedItems,
    deductionAgorot: info.deductionAgorot,
    byType: info.byType,
    byProduction: info.byProduction,
    vouchers: info.vouchers,
    items: info.items,
    valueAgorot: info.valueAgorot,
    rows: info.rows,
  };
}

/* ------------------------------------------------------------ the refunds */

/** A product that is a voucher is credited from its receipt only (SellViewModel.refundRefusal). */
export function voucherRefundRefusal(product: { name: string; voucherId?: string | null }): string | null {
  return product.voucherId ? `${product.name} הוא שובר. זיכוי שובר רק מקבלה.` : null;
}
