/**
 * Run with `npm test`. The dealer-type rules the dashboard applies (lib/dealerType.ts).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  canChangeDealerType,
  dealerTypeOf,
  isDealerTypeChange,
  numberLabelKey,
  parseThreshold,
  receiptDocumentKey,
  turnoverPercent,
  zShowsExempt,
} from './dealerType';

describe('dealerTypeOf', () => {
  it('reads an older server (no field) and anything unknown as a company', () => {
    assert.equal(dealerTypeOf(undefined), 'company');
    assert.equal(dealerTypeOf('partnership'), 'company');
    assert.equal(dealerTypeOf('exempt'), 'exempt');
    assert.equal(dealerTypeOf('licensed'), 'licensed');
  });
});

describe('who may change it', () => {
  it('the company administrators, never a branch', () => {
    assert.deepEqual(
      ['super_admin', 'distributor', 'company_manager', 'shop_manager', 'shift_supervisor', 'cashier', undefined].map(
        canChangeDealerType,
      ),
      [true, true, true, false, false, false, false],
    );
  });

  it('sending the same type back is not a change', () => {
    assert.equal(isDealerTypeChange(undefined, 'company'), false);
    assert.equal(isDealerTypeChange('company', 'exempt'), true);
  });
});

describe('labels', () => {
  it('the number is a ח.פ., an עוסק מורשה or an עוסק פטור', () => {
    assert.deepEqual(['company', 'licensed', 'exempt', null].map(numberLabelKey), [
      'numberCompany',
      'numberLicensed',
      'numberExempt',
      'numberCompany',
    ]);
  });

  it('names the receipt and the receipt refund, and leaves 320 / 330 to the page', () => {
    assert.equal(receiptDocumentKey(400), 'docReceipt');
    assert.equal(receiptDocumentKey(-400), 'docReceiptRefund');
    assert.equal(receiptDocumentKey(320), null);
    assert.equal(receiptDocumentKey(null), null);
  });
});

describe('the Z', () => {
  it('says "without VAT" only for an exempt dealer whose Z has no VAT', () => {
    assert.equal(zShowsExempt('exempt', '0.00'), true);
    assert.equal(zShowsExempt('exempt', null), true);
    assert.equal(zShowsExempt('exempt', '18.00'), false);
    assert.equal(zShowsExempt('company', '0.00'), false);
  });
});

describe('the ceiling', () => {
  it('percent of the ceiling, none without one', () => {
    assert.equal(turnoverPercent({ turnover: 90000, threshold: 120000 }), 75);
    assert.equal(turnoverPercent({ turnover: 90000, threshold: null }), null);
  });

  it('parses what is typed', () => {
    assert.deepEqual(parseThreshold(' 120,000 ₪'), { ok: true, value: 120000 });
    assert.deepEqual(parseThreshold(''), { ok: true, value: null });
    assert.deepEqual(parseThreshold('-5'), { ok: false });
    assert.deepEqual(parseThreshold('abc'), { ok: false });
  });
});
