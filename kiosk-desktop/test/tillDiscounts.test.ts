/**
 * Manual discounts, OTH and their ceilings (core/till/discounts.ts) — the Android till's BasketDiscountEntryTest (the basket
 * discount's preview), OthClubTest (the parameters, the refusals) and OwnerDecisions1410Test (§1 `staffTableDiscountCheck`,
 * §2 OTH's `maxAmount`), case for case.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OTH_REASONS,
  OTH_PERCENT,
  basketDiscountKindOf,
  basketDiscountPercent,
  basketDiscountPercentOf,
  basketDiscountPreview,
  basketDiscountRate,
  checkedDiscountPercent,
  committedBasketDiscount,
  documentDiscountAmount,
  lineDiscountAmount,
  openPriceAgorot,
  othDecide,
  othMayApprove,
  othNeed,
  othOverCeiling,
  othRefusal,
  othSettingsOf,
  parseOthReasons,
  staffTableDiscountCheck,
  tableOpeningSelfApproves,
} from '../src/core/till/discounts';
import { profileOf, type PermissionProfile } from '../src/core/till/permissions';
import { CODES } from '../src/core/desktopExit';

const ALLOW_ALL = Object.fromEntries(CODES.map((c) => [c, 'allow']));
const ROLES: Record<string, Record<string, string>> = {
  waiter: { DISCOUNT: 'approval', OTH: 'approval' },
  cashier: { DISCOUNT: 'approval', OTH: 'approval' },
  supervisor: { DISCOUNT: 'allow', OTH: 'allow' },
  manager: ALLOW_ALL,
};
const cloud = (key: string, limits: Record<string, Record<string, number>> = {}, states: Record<string, string> = {}): PermissionProfile =>
  profileOf({ id: key, role: key === 'manager' ? 'shop_manager' : 'cashier', permissions: { ...ROLES[key], ...states }, limits, tillRoleKey: key });
const oth = (max: number) => ({ OTH: { maxAmount: max } });
const discount = (max: number) => ({ DISCOUNT: { maxPercent: max } });

describe('the line and basket discount (Cart.discountAmount, documentDiscountAmount)', () => {
  it('a percentage is of the gross, in hundredths, rounded once at the line; never on a refund or a no-discount product', () => {
    expect(lineDiscountAmount(1_250, { type: 'percentage', value: 1_000 })).toBe(125);
    expect(lineDiscountAmount(999, { type: 'percentage', value: 1_000 })).toBe(99);
    expect(lineDiscountAmount(1_000, { type: 'fixed', value: 300 })).toBe(300);
    expect(lineDiscountAmount(1_000, { type: 'percentage', value: 1_000 }, true)).toBe(0);
    expect(lineDiscountAmount(1_000, { type: 'percentage', value: 1_000 }, false, true)).toBe(0);
    expect(lineDiscountAmount(1_000, null)).toBe(0);
    // OTH: 100%.
    expect(lineDiscountAmount(4_200, { type: 'percentage', value: OTH_PERCENT })).toBe(4_200);
  });

  it('the basket discount never takes more than the lines come to', () => {
    expect(documentDiscountAmount(10_000, { type: 'percentage', value: 1_000 })).toBe(1_000);
    expect(documentDiscountAmount(10_000, { type: 'fixed', value: 15_000 })).toBe(10_000);
    expect(documentDiscountAmount(10_000, null)).toBe(0);
  });
});

describe('the basket discount keypad (BasketDiscountEntryTest)', () => {
  it('a percentage is whole and stops at a hundred', () => {
    expect(basketDiscountPercent('10')).toBe(10);
    expect(basketDiscountPercent('150')).toBe(100);
    expect(basketDiscountPercent('')).toBe(0);
    expect(basketDiscountPercent('1.5')).toBe(0);
  });

  it('a fixed amount keys like every other sum on this till', () => {
    expect(openPriceAgorot('12.5')).toBe(1_250);
    expect(openPriceAgorot('12.')).toBe(1_200);
    expect(openPriceAgorot('.')).toBe(0);
    expect(openPriceAgorot('0')).toBe(0);
    expect(openPriceAgorot('12.345')).toBe(1_235);
    expect(openPriceAgorot('abc')).toBe(0);
  });

  it('a percentage preview shows the money and the new total', () => {
    const p = basketDiscountPreview('percent', '10', 8_500);
    expect(p.amountAgorot).toBe(850);
    expect(p.newTotalAgorot).toBe(7_650);
    expect(p.canApply).toBe(true);
  });

  it('nothing keyed is not applicable', () => {
    expect(basketDiscountPreview('percent', '', 8_500).canApply).toBe(false);
    expect(basketDiscountPreview('fixed', '', 8_500).canApply).toBe(false);
  });

  it('a fixed amount over the basket is refused, not silently clamped', () => {
    const p = basketDiscountPreview('fixed', '1000', 8_500);
    expect(p.exceedsBasket).toBe(true);
    expect(p.canApply).toBe(false);
    expect(p.amountAgorot).toBe(100_000);
    expect(p.newTotalAgorot).toBe(0);
  });

  it('a fixed amount exactly equal to the basket is allowed and says so', () => {
    const p = basketDiscountPreview('fixed', '85', 8_500);
    expect(p.canApply).toBe(true);
    expect(p.zeroesBasket).toBe(true);
  });

  it('a hundred percent is the deliberate route to a free basket', () => {
    const p = basketDiscountPreview('percent', '100', 8_500);
    expect(p.newTotalAgorot).toBe(0);
    expect(p.zeroesBasket).toBe(true);
  });

  it('an empty basket cannot be discounted at all', () => {
    expect(basketDiscountPreview('percent', '10', 0).canApply).toBe(false);
    expect(basketDiscountPreview('fixed', '1', 0).canApply).toBe(false);
  });

  it('"the customer pays ₪X": the discount is the difference; above the basket, or into the no-discount lines, refused', () => {
    const p = basketDiscountPreview('target', '80', 10_000);
    expect(p).toMatchObject({ amountAgorot: 2_000, newTotalAgorot: 8_000, canApply: true });
    expect(basketDiscountPreview('target', '120', 10_000).exceedsBasket).toBe(true);
    expect(basketDiscountPreview('target', '10', 10_000, 5_000).exceedsBasket).toBe(true);
    expect(committedBasketDiscount('target', '80', p)).toEqual({ type: 'fixed', value: 2_000 });
  });

  it('the lines that take no discount are out of the percentage and kept whole', () => {
    const p = basketDiscountPreview('percent', '10', 10_000, 4_000);
    expect(p.amountAgorot).toBe(600);
    expect(p.excludedAgorot).toBe(4_000);
    expect(basketDiscountPreview('fixed', '70', 10_000, 4_000).exceedsBasket).toBe(true);
  });

  it('the rate the ceiling is held to: as keyed, or the amount over the basket', () => {
    expect(basketDiscountRate('percent', '15', basketDiscountPreview('percent', '15', 10_000))).toBe(15);
    expect(basketDiscountRate('fixed', '25', basketDiscountPreview('fixed', '25', 10_000))).toBe(25);
    expect(committedBasketDiscount('percent', '15', basketDiscountPreview('percent', '15', 10_000))).toEqual({ type: 'percentage', value: 1_500 });
  });

  it('on the document: the kind and the rate of the basket discount', () => {
    expect(basketDiscountKindOf(0)).toBeNull();
    expect(basketDiscountKindOf(500)).toBe('manual');
    expect(basketDiscountPercentOf(500, { type: 'percentage', value: 1_000 })).toBe(10);
    expect(basketDiscountPercentOf(500, { type: 'fixed', value: 500 })).toBeNull();
  });
});

describe('OTH (OthClubTest)', () => {
  it('the parameters, off unless set', () => {
    expect(othSettingsOf({})).toEqual({ enabled: false, requiresManager: true, reasons: [...DEFAULT_OTH_REASONS] });
    expect(othSettingsOf({ othEnabled: 'true', othRequiresManager: 'false', othReasons: 'פיצוי, טעימה\nפיצוי' })).toEqual({ enabled: true, requiresManager: false, reasons: ['פיצוי', 'טעימה'] });
    expect(parseOthReasons('  ,  ')).toEqual([...DEFAULT_OTH_REASONS]);
    expect(parseOthReasons('א،ב')).toEqual(['א', 'ב']);
  });

  it('a product that takes no discount and a line coming back are never OTH', () => {
    expect(othRefusal({ refund: true, noDiscount: false, oth: null })).toBe('refund');
    expect(othRefusal({ refund: false, noDiscount: true, oth: null })).toBe('no_discount');
    expect(othRefusal({ refund: false, noDiscount: false, voucher: true, oth: null })).toBe('no_discount');
    expect(othRefusal({ refund: false, noDiscount: false, oth: { reason: 'פיצוי', by: null, approvedBy: null, approverName: null } })).toBe('already');
    expect(othRefusal(null)).toBe('no_line');
    expect(othRefusal({ refund: false, noDiscount: false, oth: null })).toBeNull();
  });
});

describe("the owner's decisions of 14.10.2026 (OwnerDecisions1410Test)", () => {
  const everyone = ['waiter', 'cashier', 'supervisor', 'manager'].map((k) => cloud(k));

  it('§1 the check is off unless the parameter says true', () => {
    expect(staffTableDiscountCheck({})).toBe(false);
    expect(staffTableDiscountCheck({ staffTableDiscountCheck: 'false' })).toBe(false);
    expect(staffTableDiscountCheck({ staffTableDiscountCheck: '' })).toBe(false);
    expect(staffTableDiscountCheck({ staffTableDiscountCheck: '1' })).toBe(false);
    expect(staffTableDiscountCheck({ staffTableDiscountCheck: ' TRUE ' })).toBe(true);
  });

  it('§1 off - every table opens exactly as before; on - only a staff or managers\' table with a discount is checked', () => {
    const capped = cloud('supervisor', discount(30));
    expect(checkedDiscountPercent('staff', 50, false)).toBeNull();
    expect(tableOpeningSelfApproves(capped, 'managers', 100, false)).toBe(true);
    expect(checkedDiscountPercent('staff', 50, true)).toBe(50);
    expect(checkedDiscountPercent('managers', 100, true)).toBe(100);
    expect(checkedDiscountPercent('regular', 10, true)).toBeNull();
    expect(checkedDiscountPercent('staff', 0, true)).toBeNull();
  });

  it('§1 on - within the ceiling alone, above it a manager is asked', () => {
    const sup = cloud('supervisor', discount(30));
    expect(tableOpeningSelfApproves(sup, 'staff', 25, true)).toBe(true);
    expect(tableOpeningSelfApproves(sup, 'staff', 50, true)).toBe(false);
    expect(tableOpeningSelfApproves(cloud('manager'), 'managers', 100, true)).toBe(true);
    expect(tableOpeningSelfApproves(cloud('cashier'), 'staff', 25, true)).toBe(false);
  });

  it("§2 no ceiling - every role answers exactly as before, with or without othRequiresManager", () => {
    for (const p of everyone) {
      for (const requiresManager of [true, false]) {
        for (const amount of [null, 5, 5_000]) {
          const d = othDecide(p, requiresManager, amount);
          if (d.kind === 'approval') {
            expect(d.why).toBe('role');
            expect(othNeed(d)).toEqual(amount === null ? { code: 'DISCOUNT', amount: null, takeover: false } : { code: 'OTH', amount, takeover: false });
          }
        }
      }
    }
    expect(othDecide(null, true, 10)).toEqual({ kind: 'denied', code: 'OTH', why: 'not_signed_in' });
  });

  it('§2 a ceiling - within it alone, above it an approval with the amount and the manager\'s takeover', () => {
    const capped = cloud('cashier', oth(50), { OTH: 'allow' });
    expect(othDecide(capped, true, 50).kind).toBe('allowed');
    const over = othDecide(capped, true, 60);
    expect(over).toEqual({ kind: 'approval', code: 'OTH', why: 'over_limit', amount: 60, percent: null });
    expect(othNeed(over as Extract<typeof over, { kind: 'approval' }>)).toEqual({ code: 'OTH', amount: 60, takeover: true });
    // `othRequiresManager` off waives the second person a role asks for — never the ceiling.
    expect(othDecide(capped, false, 60)).toEqual(over);
    expect(othDecide(capped, false, 40).kind).toBe('allowed');
    // Taking one back gives nothing away: no amount, as before.
    expect(othDecide(capped, true, null).kind).toBe('allowed');
    expect(othOverCeiling(capped, 60)).toBe(true);
    expect(othOverCeiling(capped, 50)).toBe(false);
    expect(othOverCeiling(cloud('manager'), 1_000_000)).toBe(false);
  });

  it('§2 othRequiresManager keeps working, and a denial stays one', () => {
    const cashier = cloud('cashier', oth(100));
    expect(othDecide(cashier, true, 30)).toEqual({ kind: 'approval', code: 'OTH', why: 'role', amount: 30, percent: null });
    expect(othDecide(cashier, false, 30).kind).toBe('allowed');
    const denied = cloud('waiter', {}, { OTH: 'deny' });
    for (const rm of [true, false]) expect(othDecide(denied, rm, 1).kind).toBe('denied');
  });

  it('§2 above the ceiling only approvers whose OTH ceiling covers the amount are offered', () => {
    const need = { code: 'OTH', amount: 150 };
    expect(othMayApprove(cloud('manager'), need)).toBe(true);
    expect(othMayApprove(cloud('supervisor', oth(200)), need)).toBe(true);
    expect(othMayApprove(cloud('supervisor', oth(100)), need)).toBe(false);
    expect(othMayApprove(cloud('supervisor', {}, { OTH: 'approval' }), need)).toBe(false);
    // Taking one back: on the discount scope, no amount — anyone allowed discounts.
    expect(othMayApprove(cloud('supervisor', oth(1)), { code: 'DISCOUNT', amount: null })).toBe(true);
  });
});
