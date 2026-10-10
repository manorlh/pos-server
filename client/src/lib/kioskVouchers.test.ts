/**
 * Run with `npm test`. Discount vouchers on the Windows and browser kiosks (lib/kioskVouchers.ts): the rules, ported
 * once from the Android till and kiosk (VoucherDiscount.kt) and the cloud (prepaid_voucher_rules.py), replayed from
 * the fixture the three share — `server/tests/fixtures/prepaid_voucher_rules.json`, the same bytes as pos-android's
 * `app/src/test/resources/prepaid_voucher_rules.json` — plus what the port adds on top (the order with its vouchers,
 * the wire).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  SUPPORTED_VOUCHER_KINDS,
  applyVoucherDiscounts,
  basketLineWire,
  discountFor,
  inSaleWire,
  stackingRefusal,
  stackingText,
  usesWanted,
  voucherBasketLines,
  voucherBenefitOf,
  voucherDiscountsWire,
  voucherKindOf,
  voucherLabel,
  voucherPolicyOf,
  voucherStackingOf,
  type AppliedDiscountVoucher,
  type VoucherBasketLine,
  type VoucherBenefit,
  type VoucherInSale,
  type VoucherLineIn,
} from './kioskVouchers';

/** The fixture's SHA-256, its line endings read as LF — the same constant as pos-server's and pos-android's tests. */
const RULES_SHA256 = '2576f9361a559d34e9d8c472307cebb16de4404ed4a8c52f7f6bca54ae4f5bdb';

function fixtureText(): string {
  const name = 'prepaid_voucher_rules.json';
  const candidates = [join(process.cwd(), '..', 'server', 'tests', 'fixtures', name), join(__dirname, '..', '..', 'server', 'tests', 'fixtures', name)];
  const found = candidates.find((p) => existsSync(p));
  assert.ok(found, `${name} not found`);
  return readFileSync(found, 'utf8').replace(/\r\n/g, '\n');
}

const text = fixtureText();
const fixture = JSON.parse(text) as {
  stacking: Array<{ name: string; existing: Array<Record<string, unknown>>; incoming: Record<string, unknown>; refusal: string | null; limit: number | null; text: string | null }>;
  discount: Array<{ name: string; benefit: Record<string, unknown>; uses: number; lines: Array<Record<string, unknown>>; expect: { amountAgorot: number; shares: Record<string, number>; dropPromotion: string[]; skipped: Array<{ lineId: string; reason: string }>; refusal: string | null } }>;
  usesWanted: Array<{ name: string; benefit: Record<string, unknown>; allowed: number; lines: Array<Record<string, unknown>>; uses: number }>;
};

const inSale = (v: Record<string, unknown>): VoucherInSale => ({
  voucherId: String(v.voucherId),
  batchId: String(v.batchId),
  kind: voucherKindOf(v.kind),
  stacking: voucherStackingOf(v.stacking),
  maxPerSale: typeof v.maxVouchersPerSale === 'number' ? v.maxVouchersPerSale : null,
});

const benefitOf = (b: Record<string, unknown>): VoucherBenefit => {
  const out = voucherBenefitOf(b);
  assert.ok(out, 'a benefit the rules can read');
  return out;
};

const lineOf = (l: Record<string, unknown>): VoucherBasketLine => ({
  id: String(l.id),
  productIds: l.productIds as string[],
  categoryIds: l.categoryIds as string[],
  quantity: l.quantity as number,
  gross: l.grossAgorot as number,
  lineDiscount: l.lineDiscountAgorot as number,
  promotion: l.promotionAgorot as number,
  voucher: l.voucherAgorot as number,
  discountable: l.discountable === true,
  weighed: l.weighed === true,
  general: l.general === true,
});

describe('the shared voucher rules fixture', () => {
  it('is the pinned file', () => {
    assert.equal(createHash('sha256').update(text, 'utf8').digest('hex'), RULES_SHA256);
    assert.ok(fixture.stacking.length >= 20 && fixture.discount.length >= 30 && fixture.usesWanted.length >= 5);
  });

  for (const c of fixture.stacking) {
    it(`stacking: ${c.name}`, () => {
      const r = stackingRefusal(c.existing.map(inSale), inSale(c.incoming));
      assert.equal(r?.code ?? null, c.refusal);
      assert.equal(r?.limit ?? null, c.limit);
      // The words, as the cloud says them (null: the kiosk's own for the code).
      assert.equal(r ? stackingText(r.code, r.limit) : null, c.text);
    });
  }

  for (const c of fixture.discount) {
    it(`discount: ${c.name}`, () => {
      const r = discountFor(benefitOf(c.benefit), c.lines.map(lineOf), c.uses);
      assert.equal(r.amount, c.expect.amountAgorot, 'amount');
      assert.deepEqual(r.shares, c.expect.shares, 'shares');
      assert.deepEqual(r.dropPromotion, c.expect.dropPromotion, 'dropPromotion');
      assert.deepEqual(
        r.skipped.map(([lineId, reason]) => ({ lineId, reason })),
        c.expect.skipped,
        'skipped',
      );
      assert.equal(r.refusal, c.expect.refusal, 'refusal');
      // The shares always add up to the amount, line by line.
      assert.equal(Object.values(r.shares).reduce((s, v) => s + v, 0), r.amount);
    });
  }

  for (const c of fixture.usesWanted) {
    it(`uses wanted: ${c.name}`, () => {
      assert.equal(usesWanted(benefitOf(c.benefit), c.lines.map(lineOf), c.allowed), c.uses);
    });
  }
});

describe('the wire', () => {
  it('this kiosk says what it can apply: goods and both discount kinds', () => {
    assert.deepEqual([...SUPPORTED_VOUCHER_KINDS], ['items', 'order_discount', 'item_discount']);
  });

  it('an unknown kind is goods, as every voucher used to be; an unknown stacking is "one in a sale"; a policy defaults to exclude', () => {
    assert.equal(voucherKindOf(undefined), 'items');
    assert.equal(voucherKindOf('mystery'), 'items');
    assert.equal(voucherKindOf('order_discount'), 'order_discount');
    assert.equal(voucherStackingOf(null), 'single');
    assert.equal(voucherStackingOf('unlimited'), 'unlimited');
    assert.equal(voucherPolicyOf('soon'), 'exclude');
    assert.equal(voucherPolicyOf('best'), 'best');
  });

  it('the lookup\'s benefit is read as the rules take it; goods and a benefit with no value have none to apply', () => {
    const b = voucherBenefitOf({ kind: 'item_discount', discountType: 'percent', value: 2000, minPurchaseAgorot: null, maxDiscountAgorot: 500, maxUnits: 2, productIds: ['a', 'b'], categoryIds: ['c'], promotionPolicy: 'best', text: '20% הנחה על קפה' });
    assert.deepEqual(b, {
      kind: 'item_discount', discountType: 'percent', value: 2000, minPurchase: null, maxDiscount: 500, maxUnits: 2,
      productIds: ['a', 'b'], categoryIds: ['c'], promotionPolicy: 'best', text: '20% הנחה על קפה',
    });
    assert.equal(voucherBenefitOf({ kind: 'items' }), null);
    assert.equal(voucherBenefitOf({ kind: 'order_discount' }), null);
    assert.equal(voucherBenefitOf(null), null);
    // The kind may come from the voucher, not its benefit.
    assert.equal(voucherBenefitOf({ discountType: 'fixed', value: 300 }, 'order_discount')?.kind, 'order_discount');
  });

  it('a basket line as `reserve` takes it', () => {
    const l = lineOf(fixture.discount[0].lines[0]);
    assert.deepEqual(basketLineWire(l), {
      id: 'L1', productIds: ['p-coffee'], categoryIds: [], quantity: 2, grossAgorot: 2400, lineDiscountAgorot: 0, promotionAgorot: 0, voucherAgorot: 0, discountable: true, weighed: false, general: false,
    });
    assert.deepEqual(inSaleWire({ voucherId: 'v', batchId: 'b', kind: 'items', stacking: 'unlimited' }), { voucherId: 'v', batchId: 'b', kind: 'items', stacking: 'unlimited', maxVouchersPerSale: null });
  });

  it('the receipt line: "שובר #12 — פסטיבל הקיץ"', () => {
    assert.equal(voucherLabel(12, 'פסטיבל הקיץ'), 'שובר #12 — פסטיבל הקיץ');
    assert.equal(voucherLabel(0, null), 'שובר');
    assert.equal(voucherLabel(5, '  '), 'שובר #5');
  });
});

/* ----------------------------------------------------------- the order with its vouchers */

const order = (kind: 'order_discount' | 'item_discount', discountType: 'fixed' | 'percent', value: number, extra: Partial<VoucherBenefit> = {}): VoucherBenefit => ({
  kind, discountType, value, minPurchase: null, maxDiscount: null, maxUnits: null, productIds: [], categoryIds: [], promotionPolicy: 'exclude', text: null, ...extra,
});

const applied = (id: string, benefit: VoucherBenefit, serial = 1, uses = 1): AppliedDiscountVoucher => ({
  reservationId: `r-${id}`, clientRequestId: `c-${id}`, voucherId: id, code: `CODE-${id}`, serial, batchId: `B-${id}`, batchName: `סדרה ${id}`, stacking: 'unlimited', benefit, uses, expiresAt: null,
});

const L = (id: string, product: string, qty: number, unit: number, extra: Partial<VoucherLineIn> = {}): VoucherLineIn => ({
  id, productIds: [product], categoryId: null, qty, grossAgorot: qty * unit, promotionAgorot: 0, promotionId: null, noDiscount: false, ...extra,
});

describe('the order with its discount vouchers', () => {
  it('a voucher takes its share of each line and the shares add up', () => {
    const r = applyVoucherDiscounts([L('A', 'p1', 2, 1200), L('B', 'p2', 1, 4000)], [applied('v1', order('order_discount', 'fixed', 3000))]);
    assert.equal(r.outcomes[0].amountAgorot, 3000);
    assert.deepEqual(r.lines.A, { voucherAgorot: 1125, promotionAgorot: 0, promotionYieldedAgorot: 0 });
    assert.deepEqual(r.lines.B, { voucherAgorot: 1875, promotionAgorot: 0, promotionYieldedAgorot: 0 });
  });

  it('"לא מקבל הנחות" takes none, and the voucher says why it left the line out', () => {
    const r = applyVoucherDiscounts([L('A', 'p1', 1, 10000, { noDiscount: true }), L('B', 'p2', 1, 5200)], [applied('v1', order('order_discount', 'percent', 2000))]);
    assert.equal(r.lines.A.voucherAgorot, 0);
    assert.equal(r.lines.B.voucherAgorot, 1040);
    assert.deepEqual(r.outcomes[0].skipped, [['A', 'no_discount']]);
  });

  it('the second voucher sees what the first took', () => {
    const r = applyVoucherDiscounts(
      [L('A', 'burger', 2, 5200), L('B', 'cola', 2, 1200)],
      [applied('v1', order('order_discount', 'fixed', 1000)), applied('v2', order('item_discount', 'percent', 5000, { productIds: ['cola'] }), 2)],
    );
    // ₪10 over ₪104 + ₪24: the cola's share is 1.87 (the burgers' 8.13 took the shared agora of the tie).
    assert.deepEqual(r.outcomes[0].shares, { A: 813, B: 187 });
    // Half of each cola's price net of that share (₪11.07 a unit, half up), not half of its gross: 2 × 5.53.
    assert.equal(r.outcomes[1].amountAgorot, 1106);
    assert.equal(r.lines.B.voucherAgorot, 187 + 1106);
  });

  it('best: a voucher that beats the promotion takes the promotion off the line', () => {
    const lines = [L('A', 'burger', 2, 5200, { promotionAgorot: 1560, promotionId: 'p-15' }), L('B', 'fries', 1, 1450)];
    const r = applyVoucherDiscounts(lines, [applied('v1', order('item_discount', 'percent', 3000, { productIds: ['burger'], promotionPolicy: 'best' }))]);
    // 30% of ₪104 = ₪31.20 beats the promotion's ₪15.60: the promotion gives way.
    assert.equal(r.lines.A.voucherAgorot, 3120);
    assert.equal(r.lines.A.promotionAgorot, 0);
    assert.equal(r.lines.A.promotionYieldedAgorot, 1560);
    assert.deepEqual(r.yielded, { 'p-15': 1560 });
    assert.equal(r.lines.B.voucherAgorot, 0);
  });

  it('best: a promotion that wins keeps its share, the voucher goes to the other lines', () => {
    const lines = [L('A', 'burger', 1, 5200, { promotionAgorot: 780, promotionId: 'p-15' }), L('B', 'cola', 1, 1200)];
    const r = applyVoucherDiscounts(lines, [applied('v1', order('order_discount', 'fixed', 300, { promotionPolicy: 'best' }))]);
    assert.equal(r.lines.A.voucherAgorot, 0);
    assert.equal(r.lines.A.promotionAgorot, 780);
    assert.equal(r.lines.B.voucherAgorot, 300);
    assert.deepEqual(r.outcomes[0].skipped, [['A', 'promotion_better']]);
  });

  it('applying a voucher takes nothing off an order that does not meet its terms, and says why', () => {
    const r = applyVoucherDiscounts([L('A', 'cola', 1, 1200)], [applied('v1', order('item_discount', 'fixed', 500, { productIds: ['burger'] }))]);
    assert.equal(r.outcomes[0].amountAgorot, 0);
    assert.equal(r.outcomes[0].refusal, 'prepaid_voucher_no_eligible_items');
    assert.deepEqual(r.lines.A, { voucherAgorot: 0, promotionAgorot: 0, promotionYieldedAgorot: 0 });
  });

  it('the basket lines the rules see are net of what came before', () => {
    const now = { A: { voucherAgorot: 500, promotionAgorot: 100, promotionYieldedAgorot: 0 } };
    const [a] = voucherBasketLines([L('A', 'p1', 1, 2000, { promotionAgorot: 300 })], now);
    assert.equal(a.voucher, 500);
    assert.equal(a.promotion, 100);
    assert.equal(a.gross, 2000);
    assert.equal(a.discountable, true);
    // An empty line is not a line.
    assert.deepEqual(voucherBasketLines([L('Z', 'p', 0, 100)]), []);
  });

  it('the document: each voucher that took something, its lines by item id, in shekels', () => {
    const lines = [L('A', 'p1', 2, 1200), L('B', 'p2', 1, 4000)];
    const r = applyVoucherDiscounts(lines, [applied('v1', order('order_discount', 'fixed', 3000), 12, 1), applied('v2', order('item_discount', 'fixed', 500, { productIds: ['nothing'] }), 13)]);
    const wire = voucherDiscountsWire(r.outcomes, (id) => `item-${id}`, (a) => a / 100);
    // The second took nothing: not on the document.
    assert.equal(wire.length, 1);
    assert.deepEqual(wire[0], {
      reservationId: 'r-v1', voucherId: 'v1', batchId: 'B-v1', serial: 12, batchName: 'סדרה v1', kind: 'order_discount', uses: 1, amount: 30,
      lines: [{ itemId: 'item-A', amount: 11.25 }, { itemId: 'item-B', amount: 18.75 }],
    });
  });
});
