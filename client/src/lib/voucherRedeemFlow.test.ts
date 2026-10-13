import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  VOUCHER_REDEEM_FLOWS,
  VOUCHER_REDEEM_FLOW_DEFAULT,
  VOUCHER_SHOW_UNAVAILABLE_DEFAULT,
  isVoucherRedeemFlow,
  resolveVoucherRedeemFlow,
  resolveVoucherShowUnavailable,
} from './voucherRedeemFlow';

test('the values and defaults are the server\'s (and the till\'s)', () => {
  assert.deepEqual([...VOUCHER_REDEEM_FLOWS], ['items_first', 'voucher_first', 'both']);
  // The owner, 13.10.2026: unset = both ways in ("items_first" until then).
  assert.equal(VOUCHER_REDEEM_FLOW_DEFAULT, 'both');
  assert.equal(VOUCHER_SHOW_UNAVAILABLE_DEFAULT, true);
});

test('a layer\'s own value wins, then the inherited one, then the default', () => {
  assert.equal(resolveVoucherRedeemFlow('both', 'voucher_first'), 'both');
  assert.equal(resolveVoucherRedeemFlow(undefined, 'voucher_first'), 'voucher_first');
  assert.equal(resolveVoucherRedeemFlow(null, undefined), 'both');
  assert.equal(resolveVoucherShowUnavailable(false, true), false);
  assert.equal(resolveVoucherShowUnavailable(null, false), false);
  assert.equal(resolveVoucherShowUnavailable(undefined, undefined), true);
});

test('an explicitly set items_first still wins over the default', () => {
  // Set at this layer, or inherited from a layer above that set it: only the unset default moved.
  assert.equal(resolveVoucherRedeemFlow('items_first', undefined), 'items_first');
  assert.equal(resolveVoucherRedeemFlow('items_first', 'both'), 'items_first');
  assert.equal(resolveVoucherRedeemFlow(undefined, 'items_first'), 'items_first');
  assert.equal(resolveVoucherRedeemFlow(null, 'items_first'), 'items_first');
});

test('anything outside the enum counts as unset', () => {
  for (const junk of ['ITEMS_FIRST', 'scan', '', 1, true, {}]) {
    assert.equal(isVoucherRedeemFlow(junk), false);
    assert.equal(resolveVoucherRedeemFlow(junk, junk), 'both');
  }
  assert.equal(resolveVoucherShowUnavailable('false', 0), true);
});
