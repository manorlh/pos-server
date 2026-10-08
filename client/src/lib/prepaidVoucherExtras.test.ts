/**
 * Run with `npm test`. Production vouchers after redemption (lib/prepaidVoucherExtras.ts): the
 * refusal codes with their facts, serial ranges of deliveries, invoice quantities, quotas, the
 * forms' checks, replacement and the simulator's basket.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  agreementFormProblems,
  deliveryRangeProblem,
  errorCodeOf,
  gapState,
  invoiceLineProblems,
  invoiceLines,
  invoiceLinesAmount,
  isTestName,
  isoToLocalDateTime,
  kindsByCount,
  localDateTimeIso,
  parseDeliveryOverlap,
  overInvoicedOf,
  parseOverInvoiced,
  quotaBarPercent,
  quotaFormProblems,
  quotaState,
  rangeText,
  rangesCount,
  rangesText,
  replaceable,
  replacementReady,
  shekelsFromText,
  shekelsOf,
  simulateLines,
  splitErrorCode,
  wholeNumber,
} from './prepaidVoucherExtras';

describe('refusal codes', () => {
  it('splits a code from its facts', () => {
    assert.deepEqual(splitErrorCode('prepaid_settlement_overlap:abc'), { code: 'prepaid_settlement_overlap', facts: ['abc'] });
    assert.deepEqual(splitErrorCode('prepaid_settlement_scope_required'), { code: 'prepaid_settlement_scope_required', facts: [] });
    assert.equal(splitErrorCode('Something went wrong'), null);
    assert.equal(splitErrorCode(null), null);
    assert.equal(splitErrorCode([{ msg: 'x' }]), null);
  });

  it('reads the code of an axios error', () => {
    const err = { response: { status: 409, data: { detail: 'prepaid_voucher_already_replaced' } } };
    assert.deepEqual(errorCodeOf(err), { code: 'prepaid_voucher_already_replaced', facts: [] });
    assert.equal(errorCodeOf(new Error('Network Error')), null);
    assert.equal(errorCodeOf(undefined), null);
  });

  it('parses the over-invoiced refusal: the batch and what is left', () => {
    assert.deepEqual(parseOverInvoiced('prepaid_settlement_over_invoiced:9b2f-1:5'), { batchId: '9b2f-1', left: 5 });
    assert.deepEqual(parseOverInvoiced('prepaid_settlement_over_invoiced:b:0'), { batchId: 'b', left: 0 });
    assert.equal(parseOverInvoiced('prepaid_settlement_over_invoiced'), null);
    assert.equal(parseOverInvoiced('prepaid_settlement_over_invoiced:b:x'), null);
    assert.equal(parseOverInvoiced('prepaid_settlement_overlap:b:5'), null);
    assert.deepEqual(overInvoicedOf({ response: { data: { detail: 'prepaid_settlement_over_invoiced:b:3' } } }), { batchId: 'b', left: 3 });
    assert.equal(overInvoicedOf(new Error('x')), null);
  });

  it('parses the delivery overlap refusal', () => {
    assert.deepEqual(parseDeliveryOverlap('prepaid_voucher_delivery_overlap:1-50'), { from: 1, to: 50 });
    assert.equal(parseDeliveryOverlap('prepaid_voucher_delivery_overlap'), null);
    assert.equal(parseDeliveryOverlap('prepaid_voucher_delivery_bad_range'), null);
  });
});

describe('serial ranges', () => {
  it('writes one serial or a range', () => {
    assert.equal(rangeText(7, 7), '#7');
    assert.equal(rangeText(1, 50), '#1–#50');
    assert.equal(rangesText([{ from: 1, to: 50 }, { from: 61, to: 61 }]), '#1–#50, #61');
    assert.equal(rangesText([]), '');
    assert.equal(rangesCount([{ from: 1, to: 50 }, { from: 61, to: 61 }]), 51);
  });

  it('checks a delivery range against the batch and the live deliveries', () => {
    assert.equal(deliveryRangeProblem('1', '50', 100), null);
    assert.equal(deliveryRangeProblem('5', '', 100), null, 'one voucher: the "to" may be left empty');
    assert.equal(deliveryRangeProblem('', '5', 100), 'from');
    assert.equal(deliveryRangeProblem('0', '5', 100), 'from');
    assert.equal(deliveryRangeProblem('3', 'x', 100), 'to');
    assert.equal(deliveryRangeProblem('10', '5', 100), 'order');
    assert.equal(deliveryRangeProblem('90', '101', 100), 'beyond');
    assert.equal(deliveryRangeProblem('40', '60', 100, [{ from: 1, to: 50 }]), 'overlap');
    assert.equal(deliveryRangeProblem('51', '60', 100, [{ from: 1, to: 50 }]), null);
  });

  it('reads whole numbers only', () => {
    assert.equal(wholeNumber(' 12 '), 12);
    assert.equal(wholeNumber('1.5'), null);
    assert.equal(wholeNumber('-1'), null);
    assert.equal(wholeNumber(''), null);
  });
});

describe('money', () => {
  it('reads shekels as typed', () => {
    assert.equal(shekelsFromText('4200'), 4200);
    assert.equal(shekelsFromText('4,200.50'), 4200.5);
    assert.equal(shekelsFromText('₪ 60'), 60);
    assert.equal(shekelsFromText('60,5'), 60.5);
    assert.equal(shekelsFromText('1.234'), null);
    assert.equal(shekelsFromText('abc'), null);
    assert.equal(shekelsFromText(''), null);
  });

  it('agorot to a spreadsheet number', () => {
    assert.equal(shekelsOf(420000), 4200);
    assert.equal(shekelsOf(150), 1.5);
    assert.equal(shekelsOf(null), null);
  });

  it('the gap: over, under, none, unknown', () => {
    assert.equal(gapState(100), 'over');
    assert.equal(gapState(-1), 'under');
    assert.equal(gapState(0), 'none');
    assert.equal(gapState(null), 'unknown');
  });
});

describe('invoice lines', () => {
  const batches = [
    { batchId: 'a', uninvoiced: 70, productionPriceAgorot: 6000 },
    { batchId: 'b', uninvoiced: 0, productionPriceAgorot: 3000 },
    { batchId: 'c', uninvoiced: 10, productionPriceAgorot: null },
  ];

  it('keeps the quantities typed, the empty and zero ones out', () => {
    assert.deepEqual(invoiceLines({ a: '70', b: '', c: '0' }), [{ batchId: 'a', quantity: 70 }]);
  });

  it('flags more than is left, or a quantity that is not whole', () => {
    assert.deepEqual(invoiceLineProblems({ a: '70', b: '1', c: '2.5' }, batches), ['b', 'c']);
    assert.deepEqual(invoiceLineProblems({ a: '71' }, batches), ['a']);
    assert.deepEqual(invoiceLineProblems({ a: '' }, batches), []);
  });

  it('sums the lines at the production prices, or null without a price', () => {
    assert.equal(invoiceLinesAmount({ a: '70' }, batches), 420000);
    assert.equal(invoiceLinesAmount({ a: '70', c: '1' }, batches), null);
    assert.equal(invoiceLinesAmount({}, batches), 0);
  });
});

describe('quotas', () => {
  const q = { active: true, used: 0, maxRedemptions: 100, warnPercent: 80 };

  it('ok, warning at the warn percent, reached at the maximum, off when inactive', () => {
    assert.equal(quotaState({ ...q, used: 79 }), 'ok');
    assert.equal(quotaState({ ...q, used: 80 }), 'warning');
    assert.equal(quotaState({ ...q, used: 100 }), 'reached');
    assert.equal(quotaState({ ...q, used: 120 }), 'reached');
    assert.equal(quotaState({ ...q, active: false, used: null }), 'off');
    assert.equal(quotaState({ ...q, maxRedemptions: 0, used: 0 }), 'reached');
  });

  it('the bar is a whole percent, capped at 100', () => {
    assert.equal(quotaBarPercent(50, 200), 25);
    assert.equal(quotaBarPercent(300, 200), 100);
    assert.equal(quotaBarPercent(null, 200), 0);
    assert.equal(quotaBarPercent(0, 0), 100);
  });

  it('the create form: scope, a whole maximum, warn 1–100, a range needs an end', () => {
    const f = { scopeValue: 'פסטיבל', max: '500', period: 'overall' as const, from: '', to: '', warn: '80' };
    assert.deepEqual(quotaFormProblems(f), []);
    assert.deepEqual(quotaFormProblems({ ...f, scopeValue: ' ', max: 'x', warn: '0' }), ['scope', 'max', 'warn']);
    assert.deepEqual(quotaFormProblems({ ...f, period: 'range' }), ['period']);
    assert.deepEqual(quotaFormProblems({ ...f, period: 'range', from: '2026-10-09T10:00' }), []);
    assert.deepEqual(quotaFormProblems({ ...f, period: 'range', from: '2026-10-09T10:00', to: '2026-10-09T09:00' }), ['period']);
  });

  it('datetime-local values round trip', () => {
    assert.equal(localDateTimeIso(''), null);
    assert.equal(localDateTimeIso('tomorrow'), undefined);
    const iso = localDateTimeIso('2026-10-09T18:30');
    assert.ok(iso && iso.endsWith('Z'));
    assert.equal(isoToLocalDateTime(iso), '2026-10-09T18:30');
    assert.equal(isoToLocalDateTime(null), '');
  });
});

describe('agreements', () => {
  const f = { name: 'קייטרינג אלון', companyId: 'c1', productionName: 'קייטרינג אלון', eventName: '', batchIds: [], periodFrom: '', periodTo: '' };

  it('needs a name, a company and a scope (production, event or batches)', () => {
    assert.deepEqual(agreementFormProblems(f), []);
    assert.deepEqual(agreementFormProblems({ ...f, name: '', companyId: '', productionName: '' }), ['name', 'company', 'scope']);
    assert.deepEqual(agreementFormProblems({ ...f, productionName: '', batchIds: ['b1'] }), []);
  });

  it('the period may be open, never backwards', () => {
    assert.deepEqual(agreementFormProblems({ ...f, periodFrom: '2026-10-01' }), []);
    assert.deepEqual(agreementFormProblems({ ...f, periodFrom: '2026-10-09', periodTo: '2026-10-01' }), ['period']);
  });
});

describe('replacement, test batches, reports', () => {
  it('a replacement needs a known kind and a reason of 2+ characters', () => {
    assert.equal(replacementReady('lost', 'אבד בכניסה'), true);
    assert.equal(replacementReady('lost', ' א '), false);
    assert.equal(replacementReady('stolen', 'נגנב'), false);
  });

  it('only a live voucher can be replaced', () => {
    assert.equal(replaceable('active'), true);
    assert.equal(replaceable('partially_used'), true);
    assert.equal(replaceable('used'), false);
    assert.equal(replaceable('cancelled'), true);
  });

  it('a test batch is named by its label', () => {
    assert.equal(isTestName('שובר בדיקה · ארוחה'), true);
    assert.equal(isTestName('שובר בדיקה'), true);
    assert.equal(isTestName('ארוחה'), false);
    assert.equal(isTestName(null), false);
  });

  it('exception kinds by count, most first', () => {
    assert.deepEqual(kindsByCount({ late: 2, cancelled: 5, over_use: 2, replaced: 0 }), [
      { kind: 'cancelled', count: 5 },
      { kind: 'late', count: 2 },
      { kind: 'over_use', count: 2 },
    ]);
  });
});

describe('simulator basket', () => {
  it('keeps valid lines, the price only when typed', () => {
    assert.deepEqual(
      simulateLines([
        { productId: 'p1', quantity: '2', price: '' },
        { productId: 'p2', quantity: '0.5', price: '12.90' },
        { productId: 'p3', quantity: '0', price: '' },
        { productId: 'p4', quantity: '1', price: 'abc' },
      ]),
      [
        { productId: 'p1', quantity: 2, price: null },
        { productId: 'p2', quantity: 0.5, price: 12.9 },
      ],
    );
  });
});
