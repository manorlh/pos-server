/**
 * Manual discounts and OTH ("על חשבון הבית") on the till, with their ceilings — the Android till's Cart.kt discounts,
 * SellViewModel's basket-discount keypad (basketDiscountPreview), OthClub.kt (OthAuthority) and TablePolicy.kt's
 * `staffTableDiscountCheck` (P:/specs/owner-decisions-1410.md §1, §2), one to one, in agorot.
 *
 *  - a line discount is a percentage held in hundredths (10% → 1000) or a fixed sum; never on a refund line, a product that
 *    takes no discount ("לא מקבל הנחות"), or an OTH line; a hand-discounted line is out of the promotions;
 *  - the basket discount is taken after the line discounts, over the lines that take discounts only, never more than they
 *    come to — a percentage of them, a fixed sum, or "the customer pays ₪X" (TARGET, kept as the fixed sum that gets there);
 *  - DISCOUNT is decided with the rate (`maxPercent`); OTH with the full price of the lines marked (`maxAmount`, none by
 *    default) — `othRequiresManager` waives the second person a role asks for, never a ceiling; taking an OTH back is on
 *    the discount scope with no amount.
 *
 * Pure.
 */

import { decide, mayApprove, type Decision, type PermissionProfile } from './permissions';

export type DiscountType = 'percentage' | 'fixed';

/** "הנחה" on a line: what it takes off the gross (integer hundredths of a percent, rounded once at the line). */
export function lineDiscountAmount(grossAgorot: number, discount: { type: DiscountType; value: number } | null | undefined, refund = false, noDiscount = false): number {
  if (!discount || refund || noDiscount) return 0;
  if (discount.type === 'percentage') return Math.trunc((grossAgorot * discount.value) / 10_000);
  return discount.value;
}

/**
 * The basket discount in money (Cart.documentDiscountAmount): a percentage of what the lines come to after their own
 * discounts, or the fixed sum — never more than they come to.
 */
export function documentDiscountAmount(afterLinesAgorot: number, discount: { type: DiscountType; value: number } | null | undefined): number {
  if (!discount) return 0;
  const raw = discount.type === 'percentage' ? Math.trunc((afterLinesAgorot * discount.value) / 10_000) : discount.value;
  return raw > afterLinesAgorot ? afterLinesAgorot : raw;
}

/* --------------------------------------------------------- the basket discount */

/** "10% off everything", "call it ₪100" and "the customer pays ₪X". */
export type BasketDiscountMode = 'percent' | 'fixed' | 'target';

/** A hundred percent is allowed and nothing above it is. */
export const BASKET_DISCOUNT_MAX_PERCENT = 100;

/** Whole percent only, 0–100. */
export function basketDiscountPercent(input: string): number {
  const n = /^\d+$/.test(input.trim()) ? Number(input.trim()) : NaN;
  return Number.isFinite(n) ? Math.min(Math.max(n, 0), BASKET_DISCOUNT_MAX_PERCENT) : 0;
}

/** Keyed text to money (openPriceAgorot): blank, "." and junk are zero; a trailing point is fine; HALF_UP to the agora. */
export function openPriceAgorot(input: string): number {
  const text = input.trim().replace(/\.$/, '');
  if (!/^\d+(\.\d+)?$/.test(text)) return 0;
  const [whole, frac = ''] = text.split('.');
  const cents = Number((frac + '000').slice(0, 2));
  const up = Number((frac + '000').charAt(2)) >= 5 ? 1 : 0;
  const v = Number(whole) * 100 + cents + up;
  return v > 0 ? v : 0;
}

export interface BasketDiscountPreview {
  /** What was keyed, as money — unclamped, so a mis-key stays visible. */
  amountAgorot: number;
  /** What the basket would come to. */
  newTotalAgorot: number;
  /** A fixed amount larger than what is owed: refused, not quietly clamped. */
  exceedsBasket: boolean;
  /** Lines that take no discount: kept at full price, left out of what the discount is taken over. */
  excludedAgorot: number;
  canApply: boolean;
  zeroesBasket: boolean;
}

function preview(amount: number, newTotal: number, exceeds: boolean, excluded: number): BasketDiscountPreview {
  const canApply = amount > 0 && !exceeds;
  return { amountAgorot: amount, newTotalAgorot: newTotal, exceedsBasket: exceeds, excludedAgorot: excluded, canApply, zeroesBasket: canApply && newTotal === 0 };
}

/** What a keyed basket discount would do (basketDiscountPreview) — the same arithmetic as the cart's. */
export function basketDiscountPreview(mode: BasketDiscountMode, input: string, payableBeforeDiscountAgorot: number, nonDiscountableAgorot = 0): BasketDiscountPreview {
  const excluded = nonDiscountableAgorot > 0 ? nonDiscountableAgorot : 0;
  const discountable = Math.max(payableBeforeDiscountAgorot - excluded, 0);
  if (mode === 'target') {
    if (input.trim() === '') return preview(0, payableBeforeDiscountAgorot, false, excluded);
    const target = openPriceAgorot(input);
    if (target > payableBeforeDiscountAgorot || payableBeforeDiscountAgorot - target > discountable) return preview(0, target, true, excluded);
    return preview(payableBeforeDiscountAgorot - target, target, false, excluded);
  }
  const keyed = mode === 'percent' ? Math.trunc((discountable * (basketDiscountPercent(input) * 100)) / 10_000) : openPriceAgorot(input);
  const exceeds = keyed > discountable;
  const taken = exceeds ? discountable : keyed;
  return preview(keyed, payableBeforeDiscountAgorot - taken, exceeds, excluded);
}

/** The basket discount's rate for its limit: the percent as keyed, else the amount over the basket. */
export function basketDiscountRate(mode: BasketDiscountMode, input: string, p: BasketDiscountPreview): number | null {
  if (mode === 'percent') return basketDiscountPercent(input);
  const base = p.newTotalAgorot + p.amountAgorot;
  return base > 0 ? (p.amountAgorot * 100) / base : null;
}

/** What the committed basket discount is (commitBasketDiscount): a percent in hundredths, or the fixed sum that gets there. */
export function committedBasketDiscount(mode: BasketDiscountMode, input: string, p: BasketDiscountPreview): { type: DiscountType; value: number } | null {
  if (!p.canApply) return null;
  return mode === 'percent' ? { type: 'percentage', value: basketDiscountPercent(input) * 100 } : { type: 'fixed', value: p.amountAgorot };
}

/** `basketDiscountKind`: "manual" with a basket discount, none without (the till's club and tables are not here). */
export function basketDiscountKindOf(documentDiscountAgorot: number): string | null {
  return documentDiscountAgorot > 0 ? 'manual' : null;
}

/** The rate a basket discount was given at (10.0 for 10%), or null for a sum or none. */
export function basketDiscountPercentOf(documentDiscountAgorot: number, discount: { type: DiscountType; value: number } | null | undefined): number | null {
  if (documentDiscountAgorot === 0 || !discount || discount.type !== 'percentage') return null;
  return discount.value / 100;
}

/** "10" for 1000, "12.5" for 1250. */
export function percentLabel(hundredths: number): string {
  return String(Math.round(hundredths) / 100);
}

/** The line discount chips of the cart: 5 / 10 / 20 % and "ללא" (DeniedActions.lineDiscountPercents' `all`). */
export const LINE_DISCOUNT_CHIPS = [0, 5, 10, 20] as const;

/* ------------------------------------------------------------------------ OTH */

export const PARAM_OTH_ENABLED = 'othEnabled';
export const PARAM_OTH_REQUIRES_MANAGER = 'othRequiresManager';
export const PARAM_OTH_REASONS = 'othReasons';

export const DEFAULT_OTH_REASONS = ['לקוח קבוע', 'פיצוי', 'טעימה', 'עובד', 'אחר'] as const;
export const OTH_REASON_MAX = 100;
export const OTH_REASONS_MAX = 30;
/** The 100% an OTH line is discounted by, in hundredths of a percent. */
export const OTH_PERCENT = 10_000;

export interface OthSettings {
  enabled: boolean;
  requiresManager: boolean;
  reasons: string[];
}

const flag = (v: unknown) => v === true || (typeof v === 'string' && v.trim().toLowerCase() === 'true');
const onUnlessFalse = (v: unknown) => !(v === false || (typeof v === 'string' && v.trim().toLowerCase() === 'false'));

/** Comma separated (a Hebrew comma or a new line too); trimmed, unique, the default when none. */
export function parseOthReasons(raw: unknown): string[] {
  const text = typeof raw === 'string' ? raw : '';
  const out: string[] = [];
  for (const r of text.split(/[,،\n]/)) {
    const t = r.trim().slice(0, OTH_REASON_MAX);
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= OTH_REASONS_MAX) break;
  }
  return out.length > 0 ? out : [...DEFAULT_OTH_REASONS];
}

/** OTH as the parameters set it on this till: off unless `othEnabled` is "true"; a manager on unless switched off. */
export function othSettingsOf(params: Record<string, unknown>): OthSettings {
  return { enabled: flag(params[PARAM_OTH_ENABLED]), requiresManager: onUnlessFalse(params[PARAM_OTH_REQUIRES_MANAGER]), reasons: parseOthReasons(params[PARAM_OTH_REASONS]) };
}

/** What makes a line OTH: why, who gave it, who approved it. */
export interface OthMark {
  reason: string;
  /** The till user who gave it (`pos_users.id`). */
  by: string | null;
  /** Who approved it — a till user's id; null when nobody had to. */
  approvedBy: string | null;
  approverName: string | null;
}

/** The scope an OTH given on an approval is asked on, and the one taking it back is. */
export const OTH_SCOPE = 'OTH';
export const OTH_UNDO_SCOPE = 'DISCOUNT';

/** The operator's own OTH ceiling is below [amount] (none set: never). */
export function othOverCeiling(profile: PermissionProfile | null, amountShekels: number | null): boolean {
  if (!profile || amountShekels === null) return false;
  const max = profile.limits.OTH?.maxAmount;
  return typeof max === 'number' && Math.abs(amountShekels) > max + 1e-9;
}

/**
 * OthAuthority.decide: giving lines worth [amountShekels] on the house; null (taking one back) — as before.
 * `othRequiresManager` waives the second person a role asks for (approval counts as allowed), never a ceiling.
 */
export function othDecide(profile: PermissionProfile | null, requiresManager: boolean, amountShekels: number | null): Decision {
  const base = decide(profile, 'OTH', { relaxApproval: !requiresManager });
  if (base.kind === 'denied') return base;
  if (base.kind === 'approval') return { ...base, amount: amountShekels };
  if (othOverCeiling(profile, amountShekels)) return { kind: 'approval', code: 'OTH', why: 'over_limit', amount: amountShekels, percent: null };
  return base;
}

/** How an OTH approval is asked: giving (an amount) on OTH's own permission; taking back on DISCOUNT with none. */
export function othNeed(d: Extract<Decision, { kind: 'approval' }>): { code: string; amount: number | null; takeover: boolean } {
  return d.amount === null ? { code: OTH_UNDO_SCOPE, amount: null, takeover: false } : { code: OTH_SCOPE, amount: d.amount, takeover: d.why === 'over_limit' };
}

/** May [approver] approve that OTH need: allowed it alone within their own OTH ceiling (or DISCOUNT, taking one back). */
export function othMayApprove(approver: PermissionProfile, need: { code: string; amount: number | null }): boolean {
  return mayApprove(approver, need.code, need.amount);
}

export type OthRefusal = 'no_line' | 'refund' | 'no_discount' | 'already';

/** Why a line cannot be given OTH: a refund line, a product that takes no discount (or a voucher), one already OTH. */
export function othRefusal(line: { refund: boolean; noDiscount: boolean; voucher?: boolean; oth: OthMark | null } | null | undefined): OthRefusal | null {
  if (!line) return 'no_line';
  if (line.refund) return 'refund';
  if (line.noDiscount || line.voucher) return 'no_discount';
  if (line.oth) return 'already';
  return null;
}

/* ---------------------------------------------- staff / managers' table ceiling */

/** "שולחן עובדים / מנהלים עם הנחה — בדיקת תקרת ההנחה": only "true" (absent from an older cloud — off). */
export const PARAM_STAFF_TABLE_DISCOUNT_CHECK = 'staffTableDiscountCheck';

export function staffTableDiscountCheck(params: Record<string, unknown>): boolean {
  const v = params[PARAM_STAFF_TABLE_DISCOUNT_CHECK];
  return typeof v === 'string' ? v.trim().toLowerCase() === 'true' : v === true;
}

export type TableKind = 'regular' | 'staff' | 'managers';

/** The percent a table's discount is checked at against DISCOUNT's `maxPercent` (TablePolicy.checkedDiscountPercent). */
export function checkedDiscountPercent(kind: TableKind, discountPercent: number, check: boolean): number | null {
  const rate = Math.round(Math.min(Math.max(discountPercent, 0), 100) * 100);
  return check && (kind === 'staff' || kind === 'managers') && rate > 0 ? discountPercent : null;
}

/** May the operator open such a table on their own authority (tableOpeningSelfApproves). */
export function tableOpeningSelfApproves(profile: PermissionProfile | null, kind: TableKind, discountPercent: number, check: boolean): boolean {
  return decide(profile, 'DISCOUNT', { percent: checkedDiscountPercent(kind, discountPercent, check) }).kind === 'allowed';
}
