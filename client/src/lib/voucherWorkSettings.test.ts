import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  VOUCHER_WORK_GROUPS,
  VOUCHER_WORK_GROUP_IDS,
  VOUCHER_WORK_KEYS,
  VOUCHER_WORK_OPEN_DEFAULT,
  VOUCHER_WORK_OPEN_STORAGE_KEY,
  isVoucherWorkKey,
  isVoucherWorkValue,
  parseVoucherWorkOpen,
  resolveVoucherWorkValue,
  toggleVoucherWorkOpen,
  voucherWorkBadges,
  voucherWorkControl,
  voucherWorkDependency,
  voucherWorkEffective,
  voucherWorkGroupKeys,
  voucherWorkGroupOf,
  voucherWorkOwnKeys,
  voucherWorkStationAdvice,
  voucherWorkSummary,
  voucherWorkVisibleKeys,
  type VoucherWorkKey,
  type VoucherWorkValues,
} from './voucherWorkSettings';

/** Unset everywhere: what each setting is (the server's defaults). */
const DEFAULTS: VoucherWorkValues = {
  // "שתי הדרכים" since 13.10.2026 (lib/voucherRedeemFlow.ts VOUCHER_REDEEM_FLOW_DEFAULT).
  voucherRedeemFlow: 'both',
  voucherShowUnavailable: true,
  voucherGuide: true,
  voucherPickFilter: 'eligible',
  voucherAutoPickSingle: true,
  voucherAutoApply: 'on',
  voucherFastMode: 'station',
  voucherFastAutoClose: 'on',
  voucherShowEntitlement: 'on',
  voucherBalanceCheck: 'auto',
  voucherAutoClose: 'on',
  voucherSuccessScreen: 'always',
  voucherSuccessDismiss: 'auto',
  voucherSuccessSeconds: 3,
  voucherStation: 'off',
  voucherStationPaidItems: 'off',
  voucherStationCamera: 'tap',
  voucherStationCameraFacing: 'back',
  voucherStationCatalogSwitch: 'manager',
  voucherStationHeader: 'logo',
  voucherStationTitle: 'עמדת מימוש שוברים',
  voucherSoundApprove: 'on',
  voucherSoundReject: 'on',
  voucherSoundBoost: 'on',
  voucherVibrate: 'both',
};

const words = (phrases: { key: string; value: string }[]) => phrases.map((p) => `${p.key}=${p.value}`);

// ── The groups ──

test('the four groups, their order and every setting in exactly one of them', () => {
  assert.deepEqual([...VOUCHER_WORK_GROUP_IDS], ['redeem', 'close', 'station', 'sound']);
  assert.deepEqual([...voucherWorkGroupKeys('redeem')], [
    'voucherRedeemFlow',
    'voucherShowUnavailable',
    // "בחר פריט לשובר" (P:/specs/voucher-station-fast-flows.md §4), with the item picker's other setting.
    'voucherGuide',
    'voucherPickFilter',
    'voucherAutoPickSingle',
    'voucherAutoApply',
    'voucherFastMode',
    'voucherFastAutoClose',
    'voucherShowEntitlement',
    'voucherBalanceCheck',
  ]);
  // How the success screen closes sits between the screen and its seconds (13.10.2026, §0 item 11).
  assert.deepEqual([...voucherWorkGroupKeys('close')], [
    'voucherAutoClose',
    'voucherSuccessScreen',
    'voucherSuccessDismiss',
    'voucherSuccessSeconds',
  ]);
  assert.deepEqual([...voucherWorkGroupKeys('station')], [
    'voucherStation',
    'voucherStationPaidItems',
    'voucherStationCamera',
    'voucherStationCameraFacing',
    'voucherStationCatalogSwitch',
    'voucherStationHeader',
    'voucherStationTitle',
  ]);
  assert.deepEqual([...voucherWorkGroupKeys('sound')], ['voucherSoundApprove', 'voucherSoundReject', 'voucherSoundBoost', 'voucherVibrate']);
  assert.equal(VOUCHER_WORK_KEYS.length, 25);
  assert.equal(new Set(VOUCHER_WORK_KEYS).size, 25);
  assert.deepEqual(Object.keys(DEFAULTS).sort(), [...VOUCHER_WORK_KEYS].sort());
  for (const g of VOUCHER_WORK_GROUPS) for (const key of g.keys) assert.equal(voucherWorkGroupOf(key), g.id);
  assert.equal(isVoucherWorkKey('voucherVibrate'), true);
  // The voucher's two payment switches stay with the payment methods, not here.
  assert.equal(isVoucherWorkKey('payVoucherManualEnabled'), false);
  assert.equal(isVoucherWorkKey('payVoucherEnabled'), false);
});

test('each setting keeps its control and values', () => {
  assert.deepEqual(voucherWorkControl('voucherRedeemFlow'), { kind: 'choice', values: ['items_first', 'voucher_first', 'both'] });
  assert.deepEqual(voucherWorkControl('voucherShowUnavailable'), { kind: 'switch' });
  assert.deepEqual(voucherWorkControl('voucherGuide'), { kind: 'switch' });
  assert.deepEqual(voucherWorkControl('voucherPickFilter'), { kind: 'choice', values: ['eligible', 'all'] });
  assert.deepEqual(voucherWorkControl('voucherAutoPickSingle'), { kind: 'switch' });
  assert.deepEqual(voucherWorkControl('voucherBalanceCheck'), { kind: 'choice', values: ['auto', 'on', 'off'] });
  assert.deepEqual(voucherWorkControl('voucherStation'), { kind: 'choice', values: ['off', 'on'] });
  assert.deepEqual(voucherWorkControl('voucherAutoClose'), { kind: 'choice', values: ['on', 'off'] });
  assert.deepEqual(voucherWorkControl('voucherVibrate'), { kind: 'choice', values: ['off', 'approve', 'reject', 'both'] });
  assert.deepEqual(voucherWorkControl('voucherStationHeader'), { kind: 'choice', values: ['logo', 'text', 'both', 'none'] });
  assert.deepEqual(voucherWorkControl('voucherSuccessSeconds'), { kind: 'seconds', values: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] });
  assert.deepEqual(voucherWorkControl('voucherSuccessDismiss'), { kind: 'choice', values: ['auto', 'confirm'] });
  assert.deepEqual(voucherWorkControl('voucherStationTitle'), { kind: 'text', max: 40 });
  for (const key of VOUCHER_WORK_KEYS) assert.ok(voucherWorkControl(key), key);
});

// ── Own values, what is in force ──

test("a level's own value: only a known one counts", () => {
  assert.equal(isVoucherWorkValue('voucherFastMode', 'all'), true);
  assert.equal(isVoucherWorkValue('voucherFastMode', 'on'), false);
  assert.equal(isVoucherWorkValue('voucherShowUnavailable', false), true);
  assert.equal(isVoucherWorkValue('voucherShowUnavailable', 'false'), false);
  assert.equal(isVoucherWorkValue('voucherSuccessSeconds', 7), true);
  assert.equal(isVoucherWorkValue('voucherSuccessSeconds', 11), false);
  assert.equal(isVoucherWorkValue('voucherSuccessSeconds', '7'), false);
  assert.equal(isVoucherWorkValue('voucherStationTitle', 'דוכן'), true);
  assert.equal(isVoucherWorkValue('voucherStationTitle', 'א'.repeat(50)), true); // typed: the row says it is too long
  assert.equal(isVoucherWorkValue('voucherStationTitle', null), false);
  assert.equal(isVoucherWorkValue('voucherSoundApprove', 'ON'), false);
  assert.equal(isVoucherWorkValue('voucherRedeemFlow', null), false);
  assert.equal(isVoucherWorkValue('voucherSuccessDismiss', 'confirm'), true);
  assert.equal(isVoucherWorkValue('voucherSuccessDismiss', 'manual'), false);
  assert.equal(isVoucherWorkValue('voucherGuide', false), true);
  assert.equal(isVoucherWorkValue('voucherGuide', 'off'), false);
  assert.equal(isVoucherWorkValue('voucherAutoPickSingle', true), true);
  assert.equal(isVoucherWorkValue('voucherAutoPickSingle', 0), false);
  assert.equal(isVoucherWorkValue('voucherPickFilter', 'all'), true);
  assert.equal(isVoucherWorkValue('voucherPickFilter', 'ALL'), false);
  assert.equal(isVoucherWorkValue('voucherPickFilter', true), false);
});

test('"בחר פריט לשובר": its own, else inherited, else the guide on, eligible only, the lone item picked', () => {
  assert.deepEqual(
    voucherWorkEffective({ voucherGuide: false, voucherPickFilter: 'junk', voucherAutoPickSingle: 'false' }, { voucherPickFilter: 'all', voucherAutoPickSingle: false }),
    { ...DEFAULTS, voucherGuide: false, voucherPickFilter: 'all', voucherAutoPickSingle: false },
  );
  assert.equal(resolveVoucherWorkValue('voucherGuide', undefined, 'off'), true); // junk inherited = the default
  assert.equal(resolveVoucherWorkValue('voucherPickFilter', 'eligible', 'all'), 'eligible');
  assert.equal(resolveVoucherWorkValue('voucherAutoPickSingle', true, false), true);
  // They depend on nothing, and nothing depends on them.
  const e = voucherWorkEffective({ voucherGuide: false, voucherPickFilter: 'all', voucherAutoPickSingle: false }, undefined);
  for (const key of VOUCHER_WORK_KEYS) {
    assert.equal(voucherWorkDependency(key, e), voucherWorkDependency(key, DEFAULTS), key);
  }
  for (const key of ['voucherGuide', 'voucherPickFilter', 'voucherAutoPickSingle'] as VoucherWorkKey[]) {
    assert.equal(voucherWorkDependency(key, voucherWorkEffective({ voucherFastMode: 'off', voucherRedeemFlow: 'items_first' }, undefined)), null, key);
  }
});

test('nothing set anywhere: the defaults', () => {
  assert.deepEqual(voucherWorkEffective({}, undefined), DEFAULTS);
  assert.deepEqual(voucherWorkEffective(null, null), DEFAULTS);
});

test('its own value wins, then the inherited one; junk of its own is unset', () => {
  const inherited = { voucherFastMode: 'all', voucherStation: 'on', voucherSuccessSeconds: 8, voucherShowUnavailable: false };
  const own = { voucherFastMode: 'off', voucherVibrate: 'reject', voucherStation: 'junk', voucherStationTitle: ' דוכן  1 ' };
  assert.deepEqual(voucherWorkEffective(own, inherited), {
    ...DEFAULTS,
    voucherFastMode: 'off',
    voucherVibrate: 'reject',
    voucherStation: 'on',
    voucherSuccessSeconds: 8,
    voucherShowUnavailable: false,
    voucherStationTitle: 'דוכן 1',
  });
  assert.equal(resolveVoucherWorkValue('voucherBalanceCheck', undefined, 'off'), 'off');
  assert.equal(resolveVoucherWorkValue('voucherRedeemFlow', 'both', 'voucher_first'), 'both');
  assert.equal(resolveVoucherWorkValue('voucherStationTitle', 'א'.repeat(41), 'רשת'), 'רשת');
});

test('"שונה ברמה הזו": the settings this level sets, and the filter shows only them', () => {
  const own = {
    voucherFastMode: 'off',
    voucherStationTitle: 'דוכן',
    voucherSuccessSeconds: 5,
    voucherShowUnavailable: false,
    voucherSoundApprove: 'maybe', // junk: not this level's
    payVoucherEnabled: false, // not a voucher work setting
  };
  assert.deepEqual(voucherWorkOwnKeys(own), ['voucherShowUnavailable', 'voucherFastMode', 'voucherSuccessSeconds', 'voucherStationTitle']);
  assert.deepEqual(voucherWorkOwnKeys({}), []);
  assert.deepEqual(voucherWorkOwnKeys(own, voucherWorkGroupKeys('station')), ['voucherStationTitle']);
  assert.deepEqual(voucherWorkVisibleKeys('redeem', own, true), ['voucherShowUnavailable', 'voucherFastMode']);
  assert.deepEqual(voucherWorkVisibleKeys('sound', own, true), []);
  assert.deepEqual(voucherWorkVisibleKeys('sound', own, false), [...voucherWorkGroupKeys('sound')]);
});

// ── Dependencies ──

test('the station settings do nothing while the voucher station is off', () => {
  const off = voucherWorkEffective({}, undefined);
  for (const key of voucherWorkGroupKeys('station')) {
    assert.equal(voucherWorkDependency(key, off), key === 'voucherStation' ? null : 'stationOff', key);
  }
  const on = voucherWorkEffective({ voucherStation: 'on', voucherStationHeader: 'both' }, undefined);
  for (const key of voucherWorkGroupKeys('station')) assert.equal(voucherWorkDependency(key, on), null, key);
});

test('each other dependency, and only while it holds', () => {
  const cases: [VoucherWorkKey, Record<string, unknown>, Record<string, unknown>, string][] = [
    ['voucherFastAutoClose', { voucherFastMode: 'off' }, { voucherFastMode: 'station' }, 'fastModeOff'],
    ['voucherStationCameraFacing', { voucherStation: 'on', voucherStationCamera: 'off' }, { voucherStation: 'on', voucherStationCamera: 'always' }, 'cameraOff'],
    ['voucherStationTitle', { voucherStation: 'on', voucherStationHeader: 'logo' }, { voucherStation: 'on', voucherStationHeader: 'text' }, 'headerNoText'],
    ['voucherStationTitle', { voucherStation: 'on', voucherStationHeader: 'none' }, { voucherStation: 'on', voucherStationHeader: 'both' }, 'headerNoText'],
    ['voucherSuccessSeconds', { voucherSuccessScreen: 'off' }, { voucherSuccessScreen: 'auto_close' }, 'successScreenOff'],
    ['voucherSuccessDismiss', { voucherSuccessScreen: 'off' }, { voucherSuccessScreen: 'always' }, 'successScreenOff'],
    ['voucherSuccessSeconds', { voucherSuccessDismiss: 'confirm' }, { voucherSuccessDismiss: 'auto' }, 'dismissConfirm'],
    ['voucherSoundBoost', { voucherSoundApprove: 'off', voucherSoundReject: 'off' }, { voucherSoundApprove: 'off' }, 'soundsOff'],
  ];
  for (const [key, holds, released, dep] of cases) {
    assert.equal(voucherWorkDependency(key, voucherWorkEffective(holds, undefined)), dep, key);
    assert.equal(voucherWorkDependency(key, voucherWorkEffective(released, undefined)), null, key);
  }
  // Inherited values count the same as this level's own.
  assert.equal(voucherWorkDependency('voucherFastAutoClose', voucherWorkEffective({}, { voucherFastMode: 'off' })), 'fastModeOff');
  // With no success screen at all, that comes first: the seconds are not used either way.
  assert.equal(
    voucherWorkDependency('voucherSuccessSeconds', voucherWorkEffective({ voucherSuccessDismiss: 'confirm' }, { voucherSuccessScreen: 'off' })),
    'successScreenOff',
  );
  // "confirm" inherited from the level above dims this level's seconds too.
  assert.equal(voucherWorkDependency('voucherSuccessSeconds', voucherWorkEffective({ voucherSuccessSeconds: 5 }, { voucherSuccessDismiss: 'confirm' })), 'dismissConfirm');
  assert.equal(voucherWorkDependency('voucherSuccessDismiss', voucherWorkEffective({ voucherSuccessDismiss: 'confirm' }, undefined)), null);
  // With the station off, that comes first.
  assert.equal(voucherWorkDependency('voucherStationCameraFacing', voucherWorkEffective({ voucherStationCamera: 'off' }, undefined)), 'stationOff');
  // Nothing else depends on anything.
  for (const key of ['voucherRedeemFlow', 'voucherFastMode', 'voucherAutoClose', 'voucherStation', 'voucherVibrate'] as VoucherWorkKey[]) {
    assert.equal(voucherWorkDependency(key, voucherWorkEffective({ voucherFastMode: 'off', voucherSoundApprove: 'off', voucherSoundReject: 'off' }, undefined)), null);
  }
});

// ── The summary and the badges ──

test('the summary at the defaults: one line per group, in plain words', () => {
  assert.deepEqual(words(voucherWorkSummary('redeem', DEFAULTS)), [
    'voucherRedeemFlow=both',
    'voucherGuide=on',
    'voucherPickFilter=eligible',
    'voucherAutoPickSingle=on',
    'voucherAutoApply=on',
    'voucherFastMode=station',
    'voucherFastAutoClose=on',
    'voucherShowEntitlement=on',
    'voucherBalanceCheck=auto',
  ]);
  assert.deepEqual(words(voucherWorkSummary('close', DEFAULTS)), ['voucherAutoClose=on', 'voucherSuccessScreen=always', 'voucherSuccessSeconds=3']);
  assert.deepEqual(words(voucherWorkSummary('station', DEFAULTS)), ['voucherStation=off']);
  assert.deepEqual(words(voucherWorkSummary('sound', DEFAULTS)), ['sounds=both', 'voucherSoundBoost=on', 'voucherVibrate=both']);
});

test('the summary leaves out what changes nothing', () => {
  const e = voucherWorkEffective(
    {
      voucherFastMode: 'off',
      voucherSuccessScreen: 'off',
      voucherStation: 'on',
      voucherStationCamera: 'off',
      voucherSoundApprove: 'off',
      voucherSoundReject: 'off',
      voucherVibrate: 'off',
    },
    undefined,
  );
  assert.equal(words(voucherWorkSummary('redeem', e)).includes('voucherFastAutoClose=on'), false);
  // The "בחר פריט לשובר" switches read as on / off, the filter as its value.
  assert.deepEqual(
    words(voucherWorkSummary('redeem', voucherWorkEffective({ voucherGuide: false, voucherPickFilter: 'all', voucherAutoPickSingle: false }, undefined))).slice(1, 4),
    ['voucherGuide=off', 'voucherPickFilter=all', 'voucherAutoPickSingle=off'],
  );
  assert.deepEqual(words(voucherWorkSummary('close', e)), ['voucherAutoClose=on', 'voucherSuccessScreen=off']);
  // Closed on "אישור": that, rather than the seconds.
  assert.deepEqual(words(voucherWorkSummary('close', voucherWorkEffective({ voucherSuccessDismiss: 'confirm', voucherSuccessSeconds: 6 }, undefined))), [
    'voucherAutoClose=on',
    'voucherSuccessScreen=always',
    'voucherSuccessDismiss=confirm',
  ]);
  assert.deepEqual(
    words(voucherWorkSummary('close', voucherWorkEffective({ voucherSuccessDismiss: 'confirm', voucherSuccessScreen: 'off' }, undefined))),
    ['voucherAutoClose=on', 'voucherSuccessScreen=off'],
  );
  assert.deepEqual(words(voucherWorkSummary('station', e)), [
    'voucherStation=on',
    'voucherStationPaidItems=off',
    'voucherStationCamera=off',
    'voucherStationCatalogSwitch=manager',
    'voucherStationHeader=logo',
  ]);
  assert.deepEqual(words(voucherWorkSummary('sound', e)), ['sounds=none', 'voucherVibrate=off']);
});

test('the station on with a camera, and one sound', () => {
  const e = voucherWorkEffective({ voucherStation: 'on', voucherStationCamera: 'always', voucherStationCameraFacing: 'front' }, { voucherSoundReject: 'off' });
  assert.deepEqual(words(voucherWorkSummary('station', e)).slice(0, 4), [
    'voucherStation=on',
    'voucherStationPaidItems=off',
    'voucherStationCamera=always',
    'voucherStationCameraFacing=front',
  ]);
  assert.deepEqual(words(voucherWorkSummary('sound', e))[0], 'sounds=approve');
  assert.deepEqual(words(voucherWorkSummary('sound', voucherWorkEffective({ voucherSoundApprove: 'off' }, undefined)))[0], 'sounds=reject');
});

test('the group headers: one or two short badges each', () => {
  assert.deepEqual(words(voucherWorkBadges('redeem', DEFAULTS)), ['voucherFastMode=station', 'voucherAutoApply=on']);
  assert.deepEqual(words(voucherWorkBadges('close', DEFAULTS)), ['voucherAutoClose=on', 'voucherSuccessScreen=always']);
  assert.deepEqual(words(voucherWorkBadges('station', DEFAULTS)), ['voucherStation=off']);
  assert.deepEqual(words(voucherWorkBadges('station', { ...DEFAULTS, voucherStation: 'on' })), ['voucherStation=on', 'voucherStationCamera=tap']);
  assert.deepEqual(words(voucherWorkBadges('sound', DEFAULTS)), ['sounds=both', 'voucherVibrate=both']);
});

// ── The station's recommendation, as before ──

test('"מומלץ לעמדת שובר": the station on with items first, or with no way to enter the voucher', () => {
  assert.equal(voucherWorkStationAdvice({}, undefined), false); // the station off
  // The flow unset resolves to "both" (13.10.2026), which already scans first: no advice.
  assert.equal(voucherWorkStationAdvice({ voucherStation: 'on' }, undefined), false);
  // "items_first" set here or above still wins over the default, and still gets the advice.
  assert.equal(voucherWorkStationAdvice({ voucherStation: 'on', voucherRedeemFlow: 'items_first' }, undefined), true);
  assert.equal(voucherWorkStationAdvice({ voucherStation: 'on' }, { voucherRedeemFlow: 'items_first' }), true);
  assert.equal(voucherWorkStationAdvice({ voucherStation: 'on', voucherRedeemFlow: 'voucher_first' }, undefined), false);
  assert.equal(voucherWorkStationAdvice({ voucherRedeemFlow: 'both' }, { voucherStation: 'on' }), false);
  assert.equal(
    voucherWorkStationAdvice({ voucherStation: 'on', voucherRedeemFlow: 'voucher_first', payVoucherEnabled: false }, { payVoucherManualEnabled: false }),
    true,
  );
  assert.equal(
    voucherWorkStationAdvice({ voucherStation: 'on', voucherRedeemFlow: 'voucher_first', payVoucherEnabled: false }, undefined),
    false, // typing the code is still on (unset = on)
  );
});

// ── Open / closed, remembered ──

test('the first group open, the rest closed; what was remembered wins, junk is ignored', () => {
  assert.equal(VOUCHER_WORK_OPEN_STORAGE_KEY, 'r2m.voucherWorkSettings.open.v1');
  assert.deepEqual(VOUCHER_WORK_OPEN_DEFAULT, { redeem: true, close: false, station: false, sound: false });
  for (const raw of [null, undefined, '', 'not json', '[true]', '"x"', '42', 'null']) {
    assert.deepEqual(parseVoucherWorkOpen(raw), VOUCHER_WORK_OPEN_DEFAULT, String(raw));
  }
  assert.deepEqual(parseVoucherWorkOpen('{"redeem":false,"station":true,"sound":"yes","other":true}'), {
    redeem: false,
    close: false,
    station: true,
    sound: false,
  });
  const open = toggleVoucherWorkOpen(VOUCHER_WORK_OPEN_DEFAULT, 'sound');
  assert.deepEqual(open, { redeem: true, close: false, station: false, sound: true });
  assert.deepEqual(parseVoucherWorkOpen(JSON.stringify(open)), open);
  assert.deepEqual(VOUCHER_WORK_OPEN_DEFAULT.sound, false); // the default is never changed in place
});
