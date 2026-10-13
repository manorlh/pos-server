import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  VOUCHER_AUTO_APPLY_DEFAULT,
  VOUCHER_AUTO_APPLY_KEY,
  VOUCHER_AUTO_APPLY_VALUES,
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
  VOUCHER_SUCCESS_SCREEN_DEFAULT,
  VOUCHER_SUCCESS_SCREEN_KEY,
  VOUCHER_SUCCESS_SCREEN_VALUES,
  VOUCHER_SUCCESS_SECONDS_DEFAULT,
  VOUCHER_SUCCESS_SECONDS_KEY,
  VOUCHER_SUCCESS_SECONDS_MAX,
  VOUCHER_SUCCESS_SECONDS_MIN,
  VOUCHER_SUCCESS_SECONDS_VALUES,
  VOUCHER_SUCCESS_DISMISS_DEFAULT,
  VOUCHER_SUCCESS_DISMISS_KEY,
  VOUCHER_SUCCESS_DISMISS_VALUES,
  isVoucherBalanceCheckMode,
  isVoucherSuccessDismiss,
  resolveVoucherSuccessDismiss,
  isVoucherOnOff,
  isVoucherSuccessScreen,
  isVoucherSuccessSeconds,
  resolveVoucherAutoApply,
  resolveVoucherAutoClose,
  resolveVoucherBalanceCheck,
  resolveVoucherShowEntitlement,
  resolveVoucherSound,
  resolveVoucherStation,
  resolveVoucherStationPaidItems,
  resolveVoucherSuccessScreen,
  resolveVoucherSuccessSeconds,
  voucherBalanceCheckEnabled,
  voucherStationNeedsAdvice,
  voucherStationPaidItemsView,
  VOUCHER_FAST_CHOICES,
  VOUCHER_FAST_CHOICE_KEYS,
  VOUCHER_STATION_TITLE_DEFAULT,
  VOUCHER_STATION_TITLE_KEY,
  VOUCHER_STATION_TITLE_MAX,
  isVoucherFastChoiceKey,
  isVoucherFastChoiceValue,
  isVoucherStationTitle,
  normalizeVoucherStationTitle,
  resolveVoucherFastChoice,
  resolveVoucherStationTitle,
  voucherFastChoiceDefault,
  voucherFastChoiceValues,
  voucherStationTitleLength,
  voucherStationTitlePatch,
  voucherStationTitleTooLong,
  VOUCHER_AUTO_PICK_SINGLE_DEFAULT,
  VOUCHER_AUTO_PICK_SINGLE_KEY,
  VOUCHER_GUIDE_DEFAULT,
  VOUCHER_GUIDE_KEY,
  VOUCHER_PICK_FILTER_DEFAULT,
  VOUCHER_PICK_FILTER_KEY,
  VOUCHER_PICK_FILTER_VALUES,
  isVoucherPickFilter,
  resolveVoucherAutoPickSingle,
  resolveVoucherGuide,
  resolveVoucherPickFilter,
} from './voucherTillSettings';
import { resolveVoucherRedeemFlow } from './voucherRedeemFlow';
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

test('the station advice follows the flow in force: unset is "both" now, an explicit items_first still advises', () => {
  // No level sets the flow: it resolves to "both" (13.10.2026), which already scans first — no advice.
  assert.equal(voucherStationNeedsAdvice('on', resolveVoucherRedeemFlow(undefined, undefined), true, true), false);
  // "items_first" set at this level or above still wins over the default, and still gets the advice.
  assert.equal(voucherStationNeedsAdvice('on', resolveVoucherRedeemFlow('items_first', undefined), true, true), true);
  assert.equal(voucherStationNeedsAdvice('on', resolveVoucherRedeemFlow(undefined, 'items_first'), true, true), true);
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

// ── "מימוש אוטומטי בסריקת שובר" (voucherAutoApply, 12.10.2026) ──

test("voucherAutoApply: the server's key, values and default (on)", () => {
  assert.equal(VOUCHER_AUTO_APPLY_KEY, 'voucherAutoApply');
  assert.deepEqual([...VOUCHER_AUTO_APPLY_VALUES], ['on', 'off']);
  assert.equal(VOUCHER_AUTO_APPLY_DEFAULT, 'on');
});

test('voucherAutoApply: its own value, then the inherited one, then on; junk is unset', () => {
  assert.equal(resolveVoucherAutoApply('off', 'on'), 'off');
  assert.equal(resolveVoucherAutoApply('on', 'off'), 'on');
  assert.equal(resolveVoucherAutoApply(null, 'off'), 'off');
  assert.equal(resolveVoucherAutoApply(undefined, undefined), 'on');
  for (const junk of ['OFF', 'false', '', 0, false, {}]) {
    assert.equal(resolveVoucherAutoApply(junk, junk), 'on');
    assert.equal(resolveVoucherAutoApply(junk, 'off'), 'off');
  }
});

// ── "מסך הצלחה במימוש שובר" / "משך מסך ההצלחה (שניות)" (voucherSuccessScreen / voucherSuccessSeconds) ──

test("voucherSuccessScreen / voucherSuccessSeconds: the server's keys, values and defaults", () => {
  assert.equal(VOUCHER_SUCCESS_SCREEN_KEY, 'voucherSuccessScreen');
  assert.equal(VOUCHER_SUCCESS_SECONDS_KEY, 'voucherSuccessSeconds');
  assert.deepEqual([...VOUCHER_SUCCESS_SCREEN_VALUES], ['always', 'auto_close', 'off']);
  assert.equal(VOUCHER_SUCCESS_SCREEN_DEFAULT, 'always');
  assert.equal(VOUCHER_SUCCESS_SECONDS_MIN, 1);
  assert.equal(VOUCHER_SUCCESS_SECONDS_MAX, 10);
  assert.equal(VOUCHER_SUCCESS_SECONDS_DEFAULT, 3);
  assert.deepEqual([...VOUCHER_SUCCESS_SECONDS_VALUES], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test('voucherSuccessScreen: its own value, then the inherited one, then always; junk is unset', () => {
  for (const v of ['always', 'auto_close', 'off']) {
    assert.equal(isVoucherSuccessScreen(v), true);
    assert.equal(resolveVoucherSuccessScreen(v, 'off'), v);
    assert.equal(resolveVoucherSuccessScreen(undefined, v), v);
  }
  assert.equal(resolveVoucherSuccessScreen('off', 'auto_close'), 'off');
  assert.equal(resolveVoucherSuccessScreen(null, 'auto_close'), 'auto_close');
  assert.equal(resolveVoucherSuccessScreen(undefined, undefined), 'always');
  for (const junk of ['ALWAYS', 'on', 'auto-close', '', 0, 3, true, {}]) {
    assert.equal(isVoucherSuccessScreen(junk), false);
    assert.equal(resolveVoucherSuccessScreen(junk, junk), 'always');
    assert.equal(resolveVoucherSuccessScreen(junk, 'off'), 'off');
  }
});

test('voucherSuccessSeconds: an integer 1–10, its own, then the inherited one, then 3', () => {
  for (const n of [1, 2, 5, 9, 10]) {
    assert.equal(isVoucherSuccessSeconds(n), true);
    assert.equal(resolveVoucherSuccessSeconds(n, 7), n);
    assert.equal(resolveVoucherSuccessSeconds(undefined, n), n);
  }
  assert.equal(resolveVoucherSuccessSeconds(null, 8), 8);
  assert.equal(resolveVoucherSuccessSeconds(undefined, undefined), 3);
});

test('voucherSuccessSeconds: out of range, non-integer or not a number counts as unset', () => {
  for (const junk of [0, 11, -1, 100, 2.5, 9.99, NaN, Infinity, '5', '', true, null, undefined, {}, [3]]) {
    assert.equal(isVoucherSuccessSeconds(junk), false);
    assert.equal(resolveVoucherSuccessSeconds(junk, junk), 3);
    assert.equal(resolveVoucherSuccessSeconds(junk, 6), 6);
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

// ── The voucher fast mode (13.10.2026, P:/specs/voucher-fast-mode.md §0) ──

/** server/app/services/voucher_station_settings.py VOUCHER_FAST_CHOICES — the contract with the till. */
const FAST_CONTRACT: Record<string, [string[], string]> = {
  voucherFastMode: [['off', 'station', 'all'], 'station'],
  voucherFastAutoClose: [['on', 'off'], 'on'],
  voucherStationCamera: [['off', 'always', 'tap'], 'tap'],
  voucherStationCameraFacing: [['back', 'front'], 'back'],
  voucherVibrate: [['off', 'approve', 'reject', 'both'], 'both'],
  voucherSoundBoost: [['on', 'off'], 'on'],
  voucherStationCatalogSwitch: [['off', 'manager', 'free'], 'manager'],
  voucherStationHeader: [['logo', 'text', 'both', 'none'], 'logo'],
};

test("fast mode: the server's keys, values (in the dashboard's order) and defaults", () => {
  assert.deepEqual([...VOUCHER_FAST_CHOICE_KEYS], Object.keys(FAST_CONTRACT));
  assert.equal(VOUCHER_FAST_CHOICES.length, 8);
  for (const key of VOUCHER_FAST_CHOICE_KEYS) {
    const [values, fallback] = FAST_CONTRACT[key];
    assert.deepEqual([...voucherFastChoiceValues(key)], values, key);
    assert.equal(voucherFastChoiceDefault(key), fallback, key);
    assert.equal(isVoucherFastChoiceKey(key), true);
  }
  assert.equal(isVoucherFastChoiceKey(VOUCHER_STATION_TITLE_KEY), false);
  assert.equal(isVoucherFastChoiceKey('voucherSoundApprove'), false);
  assert.equal(VOUCHER_STATION_TITLE_KEY, 'voucherStationTitle');
  assert.equal(VOUCHER_STATION_TITLE_MAX, 40);
  assert.equal(VOUCHER_STATION_TITLE_DEFAULT, 'עמדת מימוש שוברים');
});

test('fast mode: a choice is its own value, then the inherited one, then the default', () => {
  for (const key of VOUCHER_FAST_CHOICE_KEYS) {
    const [values, fallback] = FAST_CONTRACT[key];
    for (const v of values) {
      assert.equal(isVoucherFastChoiceValue(key, v), true);
      assert.equal(resolveVoucherFastChoice(key, v, values[0]), v);
      assert.equal(resolveVoucherFastChoice(key, undefined, v), v);
      assert.equal(resolveVoucherFastChoice(key, null, v), v);
    }
    assert.equal(resolveVoucherFastChoice(key, undefined, undefined), fallback);
  }
  assert.equal(resolveVoucherFastChoice('voucherVibrate', 'off', 'approve'), 'off');
  assert.equal(resolveVoucherFastChoice('voucherFastMode', null, 'all'), 'all');
});

test("fast mode: junk, or another key's value, counts as unset", () => {
  for (const key of VOUCHER_FAST_CHOICE_KEYS) {
    const [values, fallback] = FAST_CONTRACT[key];
    for (const junk of ['ON', ' off', 'maybe', '', 0, 1, true, false, {}, [values[0]]]) {
      assert.equal(isVoucherFastChoiceValue(key, junk), false, `${key} ${String(junk)}`);
      assert.equal(resolveVoucherFastChoice(key, junk, junk), fallback);
      assert.equal(resolveVoucherFastChoice(key, junk, values[values.length - 1]), values[values.length - 1]);
    }
  }
  assert.equal(isVoucherFastChoiceValue('voucherStationCamera', 'front'), false);
  assert.equal(isVoucherFastChoiceValue('voucherStationHeader', 'off'), false);
  assert.equal(isVoucherFastChoiceValue('voucherFastMode', 'on'), false);
});

test('station title: one trimmed line, up to 40 characters, as the server stores it', () => {
  assert.equal(normalizeVoucherStationTitle('  עמדת   מימוש \n שוברים\t'), 'עמדת מימוש שוברים');
  assert.equal(normalizeVoucherStationTitle('א\u0000ב'), 'א ב');
  assert.equal(normalizeVoucherStationTitle('   '), '');
  assert.equal(voucherStationTitleLength('  ' + 'א'.repeat(40) + '  '), 40);
  assert.equal(voucherStationTitleLength('😀'.repeat(3)), 3); // characters, not UTF-16 units
  assert.equal(voucherStationTitleTooLong('א'.repeat(40)), false);
  assert.equal(voucherStationTitleTooLong(' ' + 'א'.repeat(40) + ' '), false);
  assert.equal(voucherStationTitleTooLong('א'.repeat(41)), true);
  assert.equal(voucherStationTitleTooLong(undefined), false);
});

test('station title: its own, then the inherited one, then "עמדת מימוש שוברים"; blank or too long is unset', () => {
  assert.equal(resolveVoucherStationTitle('דוכן 1', 'רשת'), 'דוכן 1');
  assert.equal(resolveVoucherStationTitle(undefined, 'רשת'), 'רשת');
  assert.equal(resolveVoucherStationTitle(null, ' רשת  ראשית '), 'רשת ראשית');
  assert.equal(resolveVoucherStationTitle(undefined, undefined), 'עמדת מימוש שוברים');
  for (const junk of ['', '   ', 'א'.repeat(41), 5, true, {}, ['x'], null]) {
    assert.equal(isVoucherStationTitle(junk), false);
    assert.equal(resolveVoucherStationTitle(junk, junk), 'עמדת מימוש שוברים');
    assert.equal(resolveVoucherStationTitle(junk, 'רשת'), 'רשת');
  }
});

test('station title: what a typed title sends — normalized, blank is null (inherit)', () => {
  assert.equal(voucherStationTitlePatch('  עמדת  שוברים '), 'עמדת שוברים');
  assert.equal(voucherStationTitlePatch(''), null);
  assert.equal(voucherStationTitlePatch('  \n'), null);
  assert.equal(voucherStationTitlePatch(null), null);
  assert.equal(voucherStationTitlePatch(undefined), null);
});

// ── "סגירת מסך 'שובר מומש'" (voucherSuccessDismiss, 13.10.2026, P:/specs/voucher-fast-mode.md §0 item 11) ──

test("voucherSuccessDismiss: the server's key, values and default (auto)", () => {
  assert.equal(VOUCHER_SUCCESS_DISMISS_KEY, 'voucherSuccessDismiss');
  assert.deepEqual([...VOUCHER_SUCCESS_DISMISS_VALUES], ['auto', 'confirm']);
  assert.equal(VOUCHER_SUCCESS_DISMISS_DEFAULT, 'auto');
});

test('voucherSuccessDismiss: its own value, then the inherited one, then auto; junk is unset', () => {
  for (const v of ['auto', 'confirm']) {
    assert.equal(isVoucherSuccessDismiss(v), true);
    assert.equal(resolveVoucherSuccessDismiss(v, 'auto'), v);
    assert.equal(resolveVoucherSuccessDismiss(undefined, v), v);
  }
  assert.equal(resolveVoucherSuccessDismiss('auto', 'confirm'), 'auto');
  assert.equal(resolveVoucherSuccessDismiss(null, 'confirm'), 'confirm');
  assert.equal(resolveVoucherSuccessDismiss(undefined, undefined), 'auto');
  for (const junk of ['AUTO', 'Confirm', ' confirm', 'on', 'tap', '', 0, true, {}, ['confirm']]) {
    assert.equal(isVoucherSuccessDismiss(junk), false);
    assert.equal(resolveVoucherSuccessDismiss(junk, junk), 'auto');
    assert.equal(resolveVoucherSuccessDismiss(junk, 'confirm'), 'confirm');
  }
});

// ── "בחר פריט לשובר" (voucherGuide / voucherPickFilter / voucherAutoPickSingle, 13.10.2026,
// P:/specs/voucher-station-fast-flows.md §4) ──

test("voucherGuide / voucherPickFilter / voucherAutoPickSingle: the server's keys, values and defaults", () => {
  assert.equal(VOUCHER_GUIDE_KEY, 'voucherGuide');
  assert.equal(VOUCHER_PICK_FILTER_KEY, 'voucherPickFilter');
  assert.equal(VOUCHER_AUTO_PICK_SINGLE_KEY, 'voucherAutoPickSingle');
  assert.deepEqual([...VOUCHER_PICK_FILTER_VALUES], ['eligible', 'all']);
  assert.equal(VOUCHER_GUIDE_DEFAULT, true);
  assert.equal(VOUCHER_PICK_FILTER_DEFAULT, 'eligible');
  assert.equal(VOUCHER_AUTO_PICK_SINGLE_DEFAULT, true);
});

test('voucherGuide / voucherAutoPickSingle: a real boolean of its own, then the inherited one, then true', () => {
  for (const resolve of [resolveVoucherGuide, resolveVoucherAutoPickSingle]) {
    assert.equal(resolve(undefined, undefined), true);
    assert.equal(resolve(false, true), false);
    assert.equal(resolve(true, false), true);
    assert.equal(resolve(undefined, false), false);
    assert.equal(resolve(null, false), false);
    for (const junk of ['false', 'off', 'on', 0, 1, '', {}, [false]]) {
      assert.equal(resolve(junk, junk), true);
      assert.equal(resolve(junk, false), false);
    }
  }
});

test('voucherPickFilter: its own value, then the inherited one, then eligible; junk is unset', () => {
  for (const v of ['eligible', 'all']) {
    assert.equal(isVoucherPickFilter(v), true);
    assert.equal(resolveVoucherPickFilter(v, 'eligible'), v);
    assert.equal(resolveVoucherPickFilter(undefined, v), v);
  }
  assert.equal(resolveVoucherPickFilter('eligible', 'all'), 'eligible');
  assert.equal(resolveVoucherPickFilter(null, 'all'), 'all');
  assert.equal(resolveVoucherPickFilter(undefined, undefined), 'eligible');
  for (const junk of ['ALL', 'Eligible', ' all', 'on', 'off', '', 0, true, {}, ['all']]) {
    assert.equal(isVoucherPickFilter(junk), false);
    assert.equal(resolveVoucherPickFilter(junk, junk), 'eligible');
    assert.equal(resolveVoucherPickFilter(junk, 'all'), 'all');
  }
});

test('the PATCH type takes each value and null (inherit again)', () => {
  const patches: PosSettingsPatch[] = [
    { voucherGuide: false, voucherPickFilter: 'all', voucherAutoPickSingle: false },
    { voucherGuide: null, voucherPickFilter: null, voucherAutoPickSingle: null },
  ];
  const effective: PosSettingsV1 = { voucherGuide: true, voucherPickFilter: 'eligible', voucherAutoPickSingle: true };
  assert.equal(patches.length, 2);
  assert.equal(resolveVoucherPickFilter(patches[0].voucherPickFilter, effective.voucherPickFilter), 'all');
  assert.equal(resolveVoucherGuide(patches[1].voucherGuide, effective.voucherGuide), true);
});
