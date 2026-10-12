import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  VOUCHER_AUTO_CLOSE_DEFAULT,
  VOUCHER_AUTO_CLOSE_VALUES,
  VOUCHER_BALANCE_CHECK_DEFAULT,
  VOUCHER_BALANCE_CHECK_MODES,
  VOUCHER_SHOW_ENTITLEMENT_DEFAULT,
  VOUCHER_SHOW_ENTITLEMENT_KEY,
  VOUCHER_SHOW_ENTITLEMENT_VALUES,
  VOUCHER_SOUND_APPROVE_KEY,
  VOUCHER_SOUND_DEFAULT,
  VOUCHER_SOUND_REJECT_KEY,
  VOUCHER_SOUND_VALUES,
  VOUCHER_STATION_DEFAULT,
  VOUCHER_STATION_PAID_ITEMS_DEFAULT,
  VOUCHER_STATION_PAID_ITEMS_KEY,
  VOUCHER_STATION_PAID_ITEMS_VALUES,
  VOUCHER_STATION_VALUES,
  isVoucherBalanceCheckMode,
  isVoucherOnOff,
  resolveVoucherAutoClose,
  resolveVoucherBalanceCheck,
  resolveVoucherShowEntitlement,
  resolveVoucherSound,
  resolveVoucherStation,
  resolveVoucherStationPaidItems,
  voucherBalanceCheckEnabled,
  voucherStationNeedsAdvice,
  voucherStationPaidItemsView,
} from './voucherTillSettings';
import type { PosSettingsPatch, PosSettingsV1 } from './types';

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

// ── "רכישה נוספת בתשלום בעמדת שובר" (voucherStationPaidItems, spec §5) ──

/** Every cash and card option blocked: a voucher-only till. */
const NO_CASH_OR_CARD: PosSettingsV1 = {
  payFastCashEnabled: false,
  payCashEnabled: false,
  payFastCardEnabled: false,
  payCardEnabled: false,
  payManualCardEnabled: false,
  payVoucherEnabled: true,
  payVoucherManualEnabled: true,
};

test("the paid items' key, values and default are the server's", () => {
  assert.equal(VOUCHER_STATION_PAID_ITEMS_KEY, 'voucherStationPaidItems');
  assert.deepEqual([...VOUCHER_STATION_PAID_ITEMS_VALUES], ['off', 'on']);
  assert.equal(VOUCHER_STATION_PAID_ITEMS_DEFAULT, 'off');
});

test("the paid items: a layer's own value wins, then the inherited one, then off", () => {
  assert.equal(resolveVoucherStationPaidItems('on', 'off'), 'on');
  assert.equal(resolveVoucherStationPaidItems('off', 'on'), 'off');
  assert.equal(resolveVoucherStationPaidItems(null, 'on'), 'on');
  assert.equal(resolveVoucherStationPaidItems(undefined, 'off'), 'off');
  assert.equal(resolveVoucherStationPaidItems(undefined, undefined), 'off');
  for (const junk of ['ON', 'true', '', 1, true, {}]) {
    assert.equal(resolveVoucherStationPaidItems(junk, junk), 'off');
    assert.equal(resolveVoucherStationPaidItems(junk, 'on'), 'on');
  }
});

test('the view: the value in force and what the layer would inherit', () => {
  assert.deepEqual(voucherStationPaidItemsView({}, undefined), { value: 'off', inheritedValue: 'off', noPaymentWarning: false });
  assert.deepEqual(voucherStationPaidItemsView({}, { voucherStationPaidItems: 'on' }), {
    value: 'on',
    inheritedValue: 'on',
    noPaymentWarning: false,
  });
  assert.deepEqual(voucherStationPaidItemsView({ voucherStationPaidItems: 'off' }, { voucherStationPaidItems: 'on' }), {
    value: 'off',
    inheritedValue: 'on',
    noPaymentWarning: false,
  });
  // `null` in the draft = back to inherit.
  assert.equal(voucherStationPaidItemsView({ voucherStationPaidItems: null }, { voucherStationPaidItems: 'on' }).value, 'on');
});

test('on with no cash or card option at the level warns; off never does', () => {
  // Inherited voucher-only, the paid items on here.
  assert.equal(voucherStationPaidItemsView({ voucherStationPaidItems: 'on' }, NO_CASH_OR_CARD).noPaymentWarning, true);
  // Inherited on, the options blocked in this layer's own draft.
  const blockedHere: PosSettingsPatch = {
    payFastCashEnabled: false,
    payCashEnabled: false,
    payFastCardEnabled: false,
    payCardEnabled: false,
    payManualCardEnabled: false,
  };
  assert.equal(voucherStationPaidItemsView(blockedHere, { voucherStationPaidItems: 'on' }).noPaymentWarning, true);
  // Off: nothing to warn about, whatever the options.
  assert.equal(voucherStationPaidItemsView({ voucherStationPaidItems: 'off' }, NO_CASH_OR_CARD).noPaymentWarning, false);
  assert.equal(voucherStationPaidItemsView({}, NO_CASH_OR_CARD).noPaymentWarning, false);
});

test('any one cash or card option, own or inherited, is enough to take the payment', () => {
  const on: PosSettingsPatch = { voucherStationPaidItems: 'on' };
  assert.equal(voucherStationPaidItemsView({ ...on, payCashEnabled: true }, NO_CASH_OR_CARD).noPaymentWarning, false);
  assert.equal(voucherStationPaidItemsView(on, { ...NO_CASH_OR_CARD, payFastCardEnabled: true }).noPaymentWarning, false);
  assert.equal(voucherStationPaidItemsView({ ...on, payManualCardEnabled: true }, NO_CASH_OR_CARD).noPaymentWarning, false);
  // An own "inherit" (null) falls back to the inherited blocked value.
  assert.equal(voucherStationPaidItemsView({ ...on, payCashEnabled: null }, NO_CASH_OR_CARD).noPaymentWarning, true);
  // Nothing set anywhere: the options' defaults are on.
  assert.equal(voucherStationPaidItemsView(on, undefined).noPaymentWarning, false);
  assert.equal(voucherStationPaidItemsView(on, {}).noPaymentWarning, false);
  // The voucher's own switches do not pay for the extra items.
  assert.equal(
    voucherStationPaidItemsView({ ...on, payVoucherEnabled: true, payVoucherManualEnabled: true }, NO_CASH_OR_CARD).noPaymentWarning,
    true,
  );
});

// ── "הצג לקופאי מה מגיע ללקוח בסריקת שובר" (voucherShowEntitlement, 13.10.2026) ──

test("voucherShowEntitlement: the server's key, values and default (on)", () => {
  assert.equal(VOUCHER_SHOW_ENTITLEMENT_KEY, 'voucherShowEntitlement');
  assert.deepEqual([...VOUCHER_SHOW_ENTITLEMENT_VALUES], ['on', 'off']);
  assert.equal(VOUCHER_SHOW_ENTITLEMENT_DEFAULT, 'on');
});

test('voucherShowEntitlement: its own value, then the inherited one, then on; junk is unset', () => {
  assert.equal(resolveVoucherShowEntitlement('off', 'on'), 'off');
  assert.equal(resolveVoucherShowEntitlement(null, 'off'), 'off');
  assert.equal(resolveVoucherShowEntitlement(undefined, undefined), 'on');
  for (const junk of ['OFF', 'false', '', 0, false, {}]) {
    assert.equal(resolveVoucherShowEntitlement(junk, junk), 'on');
    assert.equal(resolveVoucherShowEntitlement(junk, 'off'), 'off');
  }
});

// ── "צליל אישור / סירוב במימוש שובר" (voucherSoundApprove / voucherSoundReject, 12.10.2026) ──

test("voucherSoundApprove / voucherSoundReject: the server's keys, values and default (on)", () => {
  assert.equal(VOUCHER_SOUND_APPROVE_KEY, 'voucherSoundApprove');
  assert.equal(VOUCHER_SOUND_REJECT_KEY, 'voucherSoundReject');
  assert.deepEqual([...VOUCHER_SOUND_VALUES], ['on', 'off']);
  assert.equal(VOUCHER_SOUND_DEFAULT, 'on');
});

test('voucher sounds: their own value, then the inherited one, then on; junk is unset', () => {
  assert.equal(resolveVoucherSound('off', 'on'), 'off');
  assert.equal(resolveVoucherSound(null, 'off'), 'off');
  assert.equal(resolveVoucherSound(undefined, undefined), 'on');
  for (const junk of ['OFF', 'false', '', 0, false, {}]) {
    assert.equal(resolveVoucherSound(junk, junk), 'on');
    assert.equal(resolveVoucherSound(junk, 'off'), 'off');
  }
});
