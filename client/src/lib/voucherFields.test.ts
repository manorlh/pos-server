/**
 * Run with `npm test`. Which settings a production voucher shows: only its kind's, the dependent
 * ones only when they mean something, the bulk dialog only what every batch picked has — and the
 * goods' hidden set covers what the cloud's "ערוך סדרה" drops for goods (`_DISCOUNT_ONLY`).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  SERVER_DISCOUNT_ONLY,
  USES_FIELDS,
  commonVoucherFields,
  maxVouchersProblem,
  oneOfBatchPerSale,
  usesPerSaleProblem,
  voucherFieldsFor,
  type VoucherField,
} from './voucherFields';

const has = (s: ReadonlySet<VoucherField>, ...fields: VoucherField[]) => fields.every((f) => s.has(f));
const none = (s: ReadonlySet<VoucherField>, ...fields: VoucherField[]) => fields.every((f) => !s.has(f));

describe('voucherFieldsFor', () => {
  it('goods: contents, split, pricing, extras, policy — never a discount’s terms or the uses', () => {
    const f = voucherFieldsFor({ kind: 'items', stacking: 'unlimited', pricing: 'cover' });
    assert.ok(has(f.visible, 'items', 'splitAllowed', 'pricing', 'tillValue', 'allowTopUp', 'includeExtras',
      'discountBlockPolicy', 'redemptionAccounting', 'stacking', 'maxVouchersPerSale', 'validUntil', 'shopIds',
      'offlineAllowed', 'showCode', 'showItems'));
    assert.ok(none(f.visible, 'discountType', 'discountValue', 'minPurchase', 'maxDiscount', 'maxUnits', 'targets',
      'promotionPolicy', ...USES_FIELDS));
    assert.ok(none(f.visible, 'groups', 'totalQty'));
  });

  it('a package of groups: its groups and total instead of a list', () => {
    const f = voucherFieldsFor({ kind: 'items', selection: 'groups' });
    assert.ok(has(f.visible, 'groups', 'totalQty') && none(f.visible, 'items'));
  });

  it('a discount on the sale: its terms and uses — never goods, split, pricing, extras, targets', () => {
    const f = voucherFieldsFor({ kind: 'order_discount', discountType: 'fixed', usesPerVoucher: 5 });
    assert.ok(has(f.visible, 'discountType', 'discountValue', 'minPurchase', 'promotionPolicy', ...USES_FIELDS,
      'stacking', 'validFrom', 'shopIds', 'offlineAllowed', 'showValidity'));
    assert.ok(none(f.visible, 'items', 'groups', 'splitAllowed', 'pricing', 'tillValue', 'includeExtras', 'targets',
      'maxUnits', 'discountBlockPolicy', 'maxDiscount'));
    assert.ok(voucherFieldsFor({ kind: 'order_discount', discountType: 'percent' }).visible.has('maxDiscount'));
  });

  it('a discount on items: targets and units instead of a minimum and a cap', () => {
    const f = voucherFieldsFor({ kind: 'item_discount', discountType: 'percent' });
    assert.ok(has(f.visible, 'targets', 'maxUnits', ...USES_FIELDS));
    assert.ok(none(f.visible, 'minPurchase', 'maxDiscount', 'items', 'splitAllowed'));
  });

  it('dependent: the maximum per sale only with more than one voucher; top-up only for a cover', () => {
    assert.ok(!voucherFieldsFor({ kind: 'items', stacking: 'single' }).visible.has('maxVouchersPerSale'));
    assert.ok(voucherFieldsFor({ kind: 'items', stacking: 'distinct_batches' }).visible.has('maxVouchersPerSale'));
    assert.ok(!voucherFieldsFor({ kind: 'items', pricing: 'fixed' }).visible.has('allowTopUp'));
  });

  it('uses per sale is fixed at 1 while a voucher has one use', () => {
    assert.ok(voucherFieldsFor({ kind: 'order_discount', usesPerVoucher: '1' }).disabled.has('maxUsesPerSale'));
    assert.ok(!voucherFieldsFor({ kind: 'order_discount', usesPerVoucher: '3' }).disabled.has('maxUsesPerSale'));
  });

  it('"גם מאותה סדרה": an order discount says one of a batch per sale; an item discount and goods follow the stacking', () => {
    assert.equal(oneOfBatchPerSale('order_discount'), true);
    assert.equal(oneOfBatchPerSale('item_discount'), false);
    assert.equal(oneOfBatchPerSale('items'), false);
    assert.equal(oneOfBatchPerSale(null), false);
  });

  it('every field is either shown or hidden', () => {
    const f = voucherFieldsFor({ kind: 'items' });
    for (const x of f.hidden) assert.ok(!f.visible.has(x));
  });
});

describe('the cloud agrees', () => {
  it('goods hide every field "ערוך סדרה" drops for goods (_DISCOUNT_ONLY)', () => {
    const hidden = voucherFieldsFor({ kind: 'items', selection: 'items' }).hidden;
    for (const f of SERVER_DISCOUNT_ONLY) assert.ok(hidden.has(f), f);
    // The server's own list, when this checkout has it (the monorepo): the same fields.
    const file = [
      path.resolve(__dirname, '..', '..', 'server', 'app', 'services', 'prepaid_voucher_edit.py'),
      path.resolve(process.cwd(), '..', 'server', 'app', 'services', 'prepaid_voucher_edit.py'),
    ].find((p) => fs.existsSync(p));
    if (!file) return;
    const m = /_DISCOUNT_ONLY = \(([^)]*)\)/.exec(fs.readFileSync(file, 'utf8'));
    assert.ok(m, '_DISCOUNT_ONLY not found');
    const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
    const server = [...m![1].matchAll(/"([a-z_]+)"/g)].map((x) => camel(x[1])).sort();
    assert.deepEqual(server, [...SERVER_DISCOUNT_ONLY].sort());
    for (const f of server) assert.ok(hidden.has(f as VoucherField), f);
  });
});

describe('commonVoucherFields', () => {
  it('one kind: its fields, not mixed', () => {
    const c = commonVoucherFields([{ kind: 'items' }, { kind: 'items' }]);
    assert.equal(c.mixed, false);
    assert.ok(has(c.visible, 'splitAllowed', 'pricing', 'stacking'));
  });

  it('goods and a discount: only what both have, and mixed', () => {
    const c = commonVoucherFields([{ kind: 'items' }, { kind: 'order_discount' }]);
    assert.equal(c.mixed, true);
    assert.ok(has(c.visible, 'stacking', 'maxVouchersPerSale', 'validUntil', 'shopIds', 'offlineAllowed', 'showCode'));
    assert.ok(none(c.visible, 'splitAllowed', 'pricing', 'includeExtras', ...USES_FIELDS, 'discountType'));
  });

  it('a list and a package of groups are different kinds of goods', () => {
    const c = commonVoucherFields([{ kind: 'items', selection: 'items' }, { kind: 'items', selection: 'groups' }]);
    assert.equal(c.mixed, true);
    assert.ok(!c.visible.has('totalQty') && c.visible.has('splitAllowed'));
  });

  it('nothing picked: nothing', () => {
    assert.equal(commonVoucherFields([]).visible.size, 0);
  });
});

describe('the checks say the value and the limit', () => {
  it('uses per sale above the uses per voucher', () => {
    assert.deepEqual(usesPerSaleProblem('10', '1'), { value: 10, limit: 1 });
    assert.equal(usesPerSaleProblem('3', '3'), null);
    assert.equal(usesPerSaleProblem('', '3'), null);
  });

  it('vouchers per sale out of 1–N (empty: no maximum)', () => {
    assert.deepEqual(maxVouchersProblem('80', 50), { value: '80', max: 50 });
    assert.deepEqual(maxVouchersProblem('0', 50), { value: '0', max: 50 });
    assert.deepEqual(maxVouchersProblem('2.5', 50), { value: '2.5', max: 50 });
    assert.equal(maxVouchersProblem('', 50), null);
    assert.equal(maxVouchersProblem('7', 50), null);
  });
});
