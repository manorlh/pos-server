/**
 * Run with `npm test`. "עסקאות שלא הושלמו" — the pure rules of lib/failedPayments.ts.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  agorotToShekels,
  failedPaymentsParams,
  isEmpty,
  maskedCard,
  outcomeKey,
  paidLaterKey,
  reasonText,
  summarize,
  tillLabel,
  wasPaidLater,
  cardCommandActions,
  cardCommandPhase,
  isFailedAttempt,
  isUnresolved,
  sortAttempts,
  type FailedPaymentAttempt,
  type FailedPaymentsResponse,
} from './failedPayments';

const attempt = (over: Partial<FailedPaymentAttempt> = {}): FailedPaymentAttempt => ({
  id: 'a1',
  occurredAt: '2026-10-07T12:00:00Z',
  machineId: 'm-0000-1111',
  amountAgorot: 14000,
  method: 'card',
  kind: 'sale',
  channel: 'till',
  outcome: 'declined',
  ...over,
});

describe('failedPaymentsParams', () => {
  it('keeps the page filters and leaves empty ones out', () => {
    assert.deepEqual(
      failedPaymentsParams({ machineId: 'm1', shopId: '', from: '2026-10-01', to: undefined, page: 1, pageSize: 50 }),
      { machineId: 'm1', from: '2026-10-01', pageSize: 50 },
    );
  });

  it('a shift or a Z, a card and a later page', () => {
    assert.deepEqual(failedPaymentsParams({ zReportId: 'z1', machineId: 'm2', cardLast4: '1234', page: 3 }), {
      machineId: 'm2',
      zReportId: 'z1',
      cardLast4: '1234',
      page: 3,
    });
    assert.deepEqual(failedPaymentsParams({ shiftId: 's1', cardLast4: '12' }), { shiftId: 's1' });
  });
});

describe('summarize', () => {
  it('counts sales and keyed sales, payouts apart, and the ones paid later', () => {
    const s = summarize([
      attempt({ amountAgorot: 14000, paidByTransactionId: 't9', paidByMethod: 'cash' }),
      attempt({ kind: 'keyed', amountAgorot: 2500 }),
      attempt({ kind: 'payout', amountAgorot: 7000, outcome: 'terminal_error' }),
    ]);
    assert.deepEqual(s, {
      count: 2,
      totalAgorot: 16500,
      payoutCount: 1,
      payoutTotalAgorot: 7000,
      paidLaterCount: 1,
      unresolvedCount: 0,
      unresolvedTotalAgorot: 0,
      approvedLateCount: 0,
    });
  });

  it('counts "לא הוכרע" in the figures and apart; "אושר בבדיקה" in none of them', () => {
    const s = summarize([
      attempt({ outcome: 'unresolved', amountAgorot: 5000 }),
      attempt({ outcome: 'approved_late', amountAgorot: 9900, paidByTransactionId: 't1', paidByMethod: 'card' }),
      attempt({ amountAgorot: 1000 }),
    ]);
    assert.equal(s.count, 2);
    assert.equal(s.totalAgorot, 6000);
    assert.equal(s.paidLaterCount, 0);
    assert.equal(s.unresolvedCount, 1);
    assert.equal(s.unresolvedTotalAgorot, 5000);
    assert.equal(s.approvedLateCount, 1);
  });
});

describe('"תשלום לא מוכרע"', () => {
  it('the new outcomes are known; approved_late is not a failure', () => {
    assert.equal(outcomeKey('unresolved'), 'unresolved');
    assert.equal(outcomeKey('approved_late'), 'approved_late');
    assert.equal(isFailedAttempt({ outcome: 'approved_late' }), false);
    assert.equal(isFailedAttempt({ outcome: 'unresolved' }), true);
    assert.equal(isUnresolved({ outcome: 'unresolved' }), true);
  });

  it('the unresolved first, then newest first', () => {
    const rows = sortAttempts([
      attempt({ id: 'new', occurredAt: '2026-10-07T13:00:00Z' }),
      attempt({ id: 'stuck', outcome: 'unresolved', occurredAt: '2026-10-07T09:00:00Z' }),
      attempt({ id: 'old', occurredAt: '2026-10-07T08:00:00Z' }),
    ]);
    assert.deepEqual(rows.map((r) => r.id), ['stuck', 'new', 'old']);
  });

  it('who may act, and on what', () => {
    const stuck = attempt({ outcome: 'unresolved', vuid: 'V1' });
    assert.deepEqual(cardCommandActions(stuck, 'shop_manager'), {
      check: true,
      markApproved: true,
      markNotApproved: true,
      cancel: false,
    });
    const none = { check: false, markApproved: false, markNotApproved: false, cancel: false };
    assert.deepEqual(cardCommandActions(stuck, 'cashier'), none);
    assert.deepEqual(cardCommandActions(stuck, null), none);
    assert.deepEqual(cardCommandActions(attempt({ vuid: 'V1' }), 'super_admin'), none);
    assert.deepEqual(cardCommandActions(attempt({ outcome: 'unresolved' }), 'super_admin'), none);
    const waiting = attempt({
      outcome: 'unresolved',
      vuid: 'V1',
      cardCommand: { id: 'c1', machineId: 'm1', action: 'check', status: 'pending' },
    });
    assert.deepEqual(cardCommandActions(waiting, 'company_manager'), { ...none, cancel: true });
    const answered = attempt({
      outcome: 'unresolved',
      vuid: 'V1',
      cardCommand: { id: 'c1', machineId: 'm1', action: 'check', status: 'done', resultOutcome: 'unknown' },
    });
    assert.equal(cardCommandActions(answered, 'distributor').check, true);
  });

  it('the command phase', () => {
    assert.equal(cardCommandPhase(null), 'none');
    assert.equal(cardCommandPhase({ id: 'c', machineId: 'm', action: 'check', status: 'pending' }), 'sent');
    assert.equal(
      cardCommandPhase({ id: 'c', machineId: 'm', action: 'check', status: 'pending', deliveredAt: '2026-10-08T10:00:00Z' }),
      'delivered',
    );
    assert.equal(cardCommandPhase({ id: 'c', machineId: 'm', action: 'check', status: 'busy' }), 'answered');
    assert.equal(cardCommandPhase({ id: 'c', machineId: 'm', action: 'check', status: 'expired' }), 'ended');
    assert.equal(cardCommandPhase({ id: 'c', machineId: 'm', action: 'check', status: 'cancelled' }), 'ended');
  });
});

describe('labels', () => {
  it('known outcomes have a message key; an unknown one shows as itself', () => {
    assert.equal(outcomeKey('no_answer'), 'no_answer');
    assert.equal(outcomeKey('card_locked'), 'card_locked');
    assert.equal(outcomeKey('something_new'), null);
  });

  it('paid later by cash, card, voucher, mixed — anything else is "other"', () => {
    assert.equal(paidLaterKey('cash'), 'cash');
    assert.equal(paidLaterKey(' MIXED '), 'mixed');
    assert.equal(paidLaterKey(null), 'other');
    assert.equal(wasPaidLater(attempt()), false);
    assert.equal(wasPaidLater(attempt({ paidByTransactionId: 'x' })), true);
  });

  it('only the last four digits of a card, masked', () => {
    assert.equal(maskedCard('1234'), '****1234');
    assert.equal(maskedCard('12345'), null);
    assert.equal(maskedCard(null), null);
  });

  it('the reason in one line', () => {
    assert.equal(reasonText({ reasonCode: '003', reasonMessage: ' התקשר ' }), '003 · התקשר');
    assert.equal(reasonText({ reasonCode: null, reasonMessage: '' }), null);
  });

  it('a till by its number, else its name, else its id', () => {
    assert.equal(tillLabel({ machineId: 'm-0000-1111', posNumber: '2', machineName: 'בר' }), '2');
    assert.equal(tillLabel({ machineId: 'm-0000-1111', machineName: 'בר' }), 'בר');
    assert.equal(tillLabel({ machineId: 'm-0000-1111' }), 'm-0000-1');
  });

  it('agorot to shekels', () => {
    assert.equal(agorotToShekels(14000), 140);
    assert.equal(agorotToShekels(1999), 19.99);
    assert.equal(agorotToShekels(null), 0);
  });
});

describe('isEmpty', () => {
  const empty: FailedPaymentsResponse = {
    page: 1,
    pageSize: 50,
    total: 0,
    summary: { count: 0, totalAgorot: 0, payoutCount: 0, payoutTotalAgorot: 0, paidLaterCount: 0 },
    items: [],
    cancelledSales: { count: 0, totalAgorot: 0, items: [] },
  };

  it('nothing at all is empty; a cancelled sale alone is not', () => {
    assert.equal(isEmpty(empty), true);
    assert.equal(isEmpty(undefined), true);
    assert.equal(isEmpty({ ...empty, cancelledSales: { count: 1, totalAgorot: 7900, items: [] } }), false);
    assert.equal(isEmpty({ ...empty, total: 1 }), false);
  });
});
