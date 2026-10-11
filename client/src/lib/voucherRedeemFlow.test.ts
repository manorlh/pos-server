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
  assert.equal(VOUCHER_REDEEM_FLOW_DEFAULT, 'items_first');
  assert.equal(VOUCHER_SHOW_UNAVAILABLE_DEFAULT, true);
});

test('a layer\'s own value wins, then the inherited one, then the default', () => {
  assert.equal(resolveVoucherRedeemFlow('both', 'voucher_first'), 'both');
  assert.equal(resolveVoucherRedeemFlow(undefined, 'voucher_first'), 'voucher_first');
  assert.equal(resolveVoucherRedeemFlow(null, undefined), 'items_first');
  assert.equal(resolveVoucherShowUnavailable(false, true), false);
  assert.equal(resolveVoucherShowUnavailable(null, false), false);
  assert.equal(resolveVoucherShowUnavailable(undefined, undefined), true);
});

test('anything outside the enum counts as unset', () => {
  for (const junk of ['ITEMS_FIRST', 'scan', '', 1, true, {}]) {
    assert.equal(isVoucherRedeemFlow(junk), false);
    assert.equal(resolveVoucherRedeemFlow(junk, junk), 'items_first');
  }
  assert.equal(resolveVoucherShowUnavailable('false', 0), true);
});
