import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  VOUCHER_AUTO_CLOSE_DEFAULT,
  VOUCHER_AUTO_CLOSE_VALUES,
  VOUCHER_BALANCE_CHECK_DEFAULT,
  VOUCHER_BALANCE_CHECK_MODES,
  VOUCHER_STATION_DEFAULT,
  VOUCHER_STATION_VALUES,
  isVoucherBalanceCheckMode,
  isVoucherOnOff,
  resolveVoucherAutoClose,
  resolveVoucherBalanceCheck,
  resolveVoucherStation,
  voucherBalanceCheckEnabled,
  voucherStationNeedsAdvice,
} from './voucherTillSettings';

test("the values and defaults are the server's (and the till's)", () => {
  assert.deepEqual([...VOUCHER_BALANCE_CHECK_MODES], ['auto', 'on', 'off']);
  assert.equal(VOUCHER_BALANCE_CHECK_DEFAULT, 'auto');
  assert.deepEqual([...VOUCHER_AUTO_CLOSE_VALUES], ['on', 'off']);
  assert.equal(VOUCHER_AUTO_CLOSE_DEFAULT, 'on');
  assert.deepEqual([...VOUCHER_STATION_VALUES], ['off', 'on']);
  assert.equal(VOUCHER_STATION_DEFAULT, 'off');
});

test("a layer's own value wins, then the inherited one, then the default", () => {
  assert.equal(resolveVoucherBalanceCheck('off', 'on'), 'off');
  assert.equal(resolveVoucherBalanceCheck(undefined, 'on'), 'on');
  assert.equal(resolveVoucherBalanceCheck(null, undefined), 'auto');
  assert.equal(resolveVoucherAutoClose('off', 'on'), 'off');
  assert.equal(resolveVoucherAutoClose(null, 'off'), 'off');
  assert.equal(resolveVoucherAutoClose(undefined, undefined), 'on');
  assert.equal(resolveVoucherStation('on', 'off'), 'on');
  assert.equal(resolveVoucherStation(undefined, 'on'), 'on');
  assert.equal(resolveVoucherStation(undefined, undefined), 'off');
});

test('anything outside the enum counts as unset', () => {
  for (const junk of ['AUTO', 'ON', 'true', '', 1, true, {}]) {
    assert.equal(isVoucherBalanceCheckMode(junk), false);
    assert.equal(isVoucherOnOff(junk), false);
    assert.equal(resolveVoucherBalanceCheck(junk, junk), 'auto');
    assert.equal(resolveVoucherAutoClose(junk, junk), 'on');
    assert.equal(resolveVoucherStation(junk, junk), 'off');
  }
});

test('"auto" is on while there are active vouchers; unknown stays unknown', () => {
  assert.equal(voucherBalanceCheckEnabled('on', false), true);
  assert.equal(voucherBalanceCheckEnabled('off', true), false);
  assert.equal(voucherBalanceCheckEnabled('auto', true), true);
  assert.equal(voucherBalanceCheckEnabled('auto', false), false);
  assert.equal(voucherBalanceCheckEnabled('auto', undefined), null);
});

test('the station recommends scanning first and a way to enter the voucher', () => {
  assert.equal(voucherStationNeedsAdvice('off', 'items_first', false, false), false);
  assert.equal(voucherStationNeedsAdvice('on', 'items_first', true, true), true);
  assert.equal(voucherStationNeedsAdvice('on', 'voucher_first', false, false), true);
  assert.equal(voucherStationNeedsAdvice('on', 'voucher_first', true, false), false);
  assert.equal(voucherStationNeedsAdvice('on', 'both', false, true), false);
});
