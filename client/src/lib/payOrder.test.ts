/**
 * Run with `npm test`. "סדר אמצעי התשלום" as the dashboard edits it (lib/payOrder.ts).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_PAY_ORDER,
  completePayOrder,
  groupPayOrder,
  isBigButton,
  movePayOrder,
  normalizePayOrder,
  samePayOrder,
} from './payOrder';

describe('completePayOrder', () => {
  it('reads nothing set as null (the default order)', () => {
    assert.equal(completePayOrder(undefined), null);
    assert.equal(completePayOrder(null), null);
    assert.equal(completePayOrder('cash,card'), null);
  });

  it('appends the ids a list leaves out, in the default order', () => {
    assert.deepEqual(completePayOrder(['fastCash', 'card']), [
      'fastCash',
      'card',
      'fastCard',
      'cash',
      'manualCard',
      'voucher',
    ]);
  });

  it('drops unknown ids and repeats', () => {
    assert.deepEqual(completePayOrder(['applePay', 'cash', 'cash', 7]), [
      'cash',
      'fastCard',
      'fastCash',
      'card',
      'manualCard',
      'voucher',
    ]);
  });
});

describe('the two groups', () => {
  it('big buttons are the fast ones at the top of the payment screen', () => {
    assert.deepEqual(
      DEFAULT_PAY_ORDER.filter(isBigButton),
      ['fastCard', 'cash', 'fastCash'],
    );
  });

  it('normalizing puts the big buttons first, each group keeping its order', () => {
    assert.deepEqual(normalizePayOrder(['voucher', 'fastCash', 'card', 'cash']), [
      'fastCash',
      'cash',
      'fastCard',
      'voucher',
      'card',
      'manualCard',
    ]);
    assert.deepEqual(groupPayOrder(DEFAULT_PAY_ORDER), {
      big: ['fastCard', 'cash', 'fastCash'],
      list: ['card', 'manualCard', 'voucher'],
    });
  });
});

describe('movePayOrder', () => {
  it('moves up and down within the group', () => {
    assert.deepEqual(movePayOrder(DEFAULT_PAY_ORDER, 'fastCash', -1), [
      'fastCard',
      'fastCash',
      'cash',
      'card',
      'manualCard',
      'voucher',
    ]);
    assert.deepEqual(movePayOrder(DEFAULT_PAY_ORDER, 'card', 1), [
      'fastCard',
      'cash',
      'fastCash',
      'manualCard',
      'card',
      'voucher',
    ]);
  });

  it('never crosses from the big buttons to the list', () => {
    // fastCash is the last big button: down leaves it where it is.
    assert.deepEqual(movePayOrder(DEFAULT_PAY_ORDER, 'fastCash', 1), [...DEFAULT_PAY_ORDER]);
    // card is the first list row: up leaves it where it is.
    assert.deepEqual(movePayOrder(DEFAULT_PAY_ORDER, 'card', -1), [...DEFAULT_PAY_ORDER]);
  });
});

describe('samePayOrder', () => {
  it('compares lists, and null (inherit) only with null', () => {
    assert.equal(samePayOrder(null, null), true);
    assert.equal(samePayOrder(null, [...DEFAULT_PAY_ORDER]), false);
    assert.equal(samePayOrder([...DEFAULT_PAY_ORDER], [...DEFAULT_PAY_ORDER]), true);
    assert.equal(samePayOrder(['cash', 'fastCard'], ['fastCard', 'cash']), false);
  });
});
