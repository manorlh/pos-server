/**
 * Run with `npm test`. Prepaid voucher kinds (lib/prepaidVoucherBenefit.ts): the words a
 * discount voucher prints — the same as the server's, pinned by the shared fixture
 * server/tests/fixtures/prepaid_voucher_rules.json — and the form's checks.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  benefitText,
  cardContents,
  discountDraftErrors,
  isDiscountKind,
  moneyText,
  percentText,
  termsOfBatch,
  type DiscountDraft,
  type PrepaidVoucherKind,
} from './prepaidVoucherBenefit';

interface TextCase {
  name: string;
  kind: PrepaidVoucherKind;
  discountType?: 'fixed' | 'percent';
  value?: number;
  minPurchaseAgorot?: number;
  maxDiscountAgorot?: number;
  maxUnits?: number;
  names?: string[];
  text: string | null;
}

const fixture = JSON.parse(
  readFileSync(join(process.cwd(), '..', 'server', 'tests', 'fixtures', 'prepaid_voucher_rules.json'), 'utf8'),
) as { benefitText: TextCase[] };

describe('benefitText (the server prints the same)', () => {
  for (const c of fixture.benefitText) {
    it(c.name, () => {
      assert.equal(benefitText(c), c.text);
    });
  }
});

describe('money and percent', () => {
  it('drops the decimals of whole shekels and trailing zeros of a percent', () => {
    assert.equal(moneyText(3000), '₪30');
    assert.equal(moneyText(1205), '₪12.05');
    assert.equal(percentText(2000), '20%');
    assert.equal(percentText(1250), '12.5%');
  });

  it('reads a batch as the API returns it (₪ and %)', () => {
    const t = termsOfBatch({ kind: 'order_discount', discountType: 'percent', discountValue: 20, maxDiscount: 50, minPurchase: 100 });
    assert.equal(benefitText(t), '20% הנחה על כל ההזמנה (עד ₪50) בקנייה מעל ₪100');
    assert.equal(benefitText(termsOfBatch({ kind: 'items' })), null);
    assert.equal(isDiscountKind('items'), false);
    assert.equal(isDiscountKind('item_discount'), true);
  });
});

describe('discountDraftErrors', () => {
  const draft = (over: Partial<DiscountDraft>): DiscountDraft => ({
    kind: 'order_discount', discountType: 'fixed', value: '30', minPurchase: '', maxDiscount: '', targetCount: 0,
    maxUnits: '1', usesPerVoucher: '1', maxUsesPerSale: '1', maxUsesPerDay: '', ...over,
  });

  it('accepts complete terms; goods have none', () => {
    assert.deepEqual(discountDraftErrors(draft({})), []);
    assert.deepEqual(discountDraftErrors(draft({ kind: 'items', value: '' })), []);
  });

  it('wants a value above zero, a percent of at most 100', () => {
    assert.deepEqual(discountDraftErrors(draft({ value: '' })), ['value']);
    assert.deepEqual(discountDraftErrors(draft({ value: '0' })), ['value']);
    assert.deepEqual(discountDraftErrors(draft({ discountType: 'percent', value: '120' })), ['percentOver100']);
  });

  it('an item discount names something; uses are whole numbers', () => {
    assert.deepEqual(discountDraftErrors(draft({ kind: 'item_discount' })), ['targets']);
    assert.deepEqual(discountDraftErrors(draft({ kind: 'item_discount', targetCount: 1, maxUnits: '0' })), ['maxUnits']);
    assert.deepEqual(discountDraftErrors(draft({ usesPerVoucher: '1.5', maxUsesPerDay: '0' })), ['uses', 'usesPerDay']);
  });
});

describe('cardContents ("הצגת הפריטים על השובר", as the server PDF)', () => {
  const goods = [{ name: 'נקניקייה' }, { name: 'שתייה' }];

  it('goods print their lines unless the batch hides them', () => {
    assert.deepEqual(cardContents({ kind: 'items', items: goods }), { benefit: null, items: goods });
    assert.deepEqual(cardContents({ kind: 'items', items: goods, showItems: true }), { benefit: null, items: goods });
    assert.deepEqual(cardContents({ kind: 'items', items: goods, showItems: false }), { benefit: null, items: [] });
  });

  it('a discount prints what it gives, unless hidden too', () => {
    const d = { kind: 'order_discount' as const, discountType: 'fixed' as const, discountValue: 30, items: [] as { name: string }[] };
    assert.deepEqual(cardContents(d), { benefit: '₪30 הנחה על כל ההזמנה', items: [] });
    assert.deepEqual(cardContents({ ...d, benefitText: 'מהשרת' }), { benefit: 'מהשרת', items: [] });
    assert.deepEqual(cardContents({ ...d, showItems: false }), { benefit: null, items: [] });
  });
});
