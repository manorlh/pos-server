/**
 * Run with `npm test`. "עדכון שקט" (lib/deviceManagement.ts): the status a device reports, the
 * adb dialog's device types, the QR with the owner's Wi-Fi, "הפעל מחדש" — and the contract the
 * cloud and the till share (server/tests/fixtures/device_management_contract.json).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  ADB_COMMAND,
  ADB_CONDITIONS,
  COMPONENT_NAME,
  DEVICE_TYPES,
  OWNER_EFFECTS,
  QR_KEYS,
  QR_STEPS,
  androidVersion,
  canReboot,
  deviceTypeFor,
  kioskLockLabel,
  pathLabel,
  qrText,
  qrWarning,
  rebootPending,
  rebootStatusLabel,
  reportOfRolloutRow,
  silentLabel,
  silentState,
  tapReason,
  withWifi,
} from './deviceManagement';

const contract = JSON.parse(
  readFileSync(join(process.cwd(), '..', 'server', 'tests', 'fixtures', 'device_management_contract.json'), 'utf8'),
);

describe('the contract with the cloud and the till', () => {
  it('names the same component and command', () => {
    assert.equal(COMPONENT_NAME, contract.componentName);
    assert.equal(ADB_COMMAND, contract.adbCommand);
  });

  it('reads every path the till reports, silent exactly where the contract says', () => {
    for (const [path, silent] of Object.entries(contract.updatePaths as Record<string, boolean>)) {
      assert.equal(silentState({ silentUpdate: silent, updatePath: path }), silent ? 'silent' : 'tap', path);
      assert.notEqual(pathLabel(path), '—', path);
    }
    for (const lock of contract.kioskLocks as string[]) assert.notEqual(kioskLockLabel(lock), '—', lock);
  });
});

describe('silent update status', () => {
  it('is unknown until a till says, silent with its path, else a tap', () => {
    assert.equal(silentState(null), 'unknown');
    assert.equal(silentState({}), 'unknown');
    assert.equal(silentLabel(undefined), 'לא ידוע (גרסה ישנה)');
    assert.equal(silentLabel({ silentUpdate: true, updatePath: 'device_owner' }), 'פעיל · בעלות מכשיר');
    assert.equal(silentLabel({ silentUpdate: true, updatePath: 'pax' }), 'פעיל · המתקין של PAX');
    assert.equal(silentLabel({ silentUpdate: true }), 'פעיל');
    assert.equal(silentLabel({ silentUpdate: false, updatePath: 'tap' }), 'דורש לחיצה');
  });

  it('reads a rollout row\'s columns, or nothing from a device that has not said', () => {
    assert.equal(reportOfRolloutRow({}), null);
    assert.equal(reportOfRolloutRow({ silentUpdate: null, deviceOwner: null }), null);
    const report = reportOfRolloutRow({ deviceOwner: false, silentUpdate: true, updatePath: 'self_update', kioskLock: null });
    assert.deepEqual(report, { deviceOwner: false, silentUpdate: true, updatePath: 'self_update', kioskLock: undefined });
    assert.equal(silentLabel(report), 'פעיל · אנדרואיד 12 ומעלה');
  });

  it('says why a device needs a tap', () => {
    assert.equal(tapReason({ silentUpdate: true }), null);
    assert.match(tapReason({ silentUpdate: false, sdk: 29 })!, /אנדרואיד 11 ומטה/);
    assert.match(tapReason({ silentUpdate: false, sdk: 33 })!, /התקנת אפליקציות לא מוכרות/);
    assert.match(tapReason({ silentUpdate: false, sdk: 29, ownerSessionFailed: true })!, /נכשלה/);
  });

  it('names the Android versions in the field', () => {
    assert.equal(androidVersion(25), 'Android 7.1');
    assert.equal(androidVersion(27), 'Android 8.1');
    assert.equal(androidVersion(29), 'Android 10');
    assert.equal(androidVersion(33), 'Android 13');
    assert.equal(androidVersion(null), '—');
  });
});

describe('the adb dialog', () => {
  it('has the six device types, each with its Android', () => {
    assert.deepEqual(
      DEVICE_TYPES.map((t) => [t.id, t.android]),
      [
        ['F20', 'Android 10'],
        ['HIT_KIOSK', 'Android 12'],
        ['P18', 'Android 13'],
        ['SUNMI_T2', 'Android 7.1'],
        ['PAX_A77', 'Android 8.1'],
        ['UROVO_I9100', 'Android 8.1'],
      ],
    );
    for (const t of DEVICE_TYPES) assert.equal(androidVersion(t.sdk), t.android, t.id);
    assert.ok(ADB_CONDITIONS[0].includes('dumpsys account'));
    assert.ok(OWNER_EFFECTS.some((e) => e.includes('שחרור בעלות מכשיר')));
  });

  it('guesses the type from the model and the pairing info', () => {
    assert.equal(deviceTypeFor({ deviceModel: 'N55F' })?.id, 'F20');
    assert.equal(deviceTypeFor({ deviceModel: 'P18' })?.id, 'P18');
    assert.equal(deviceTypeFor({ deviceInfo: { model: 'Nebullar P18', manufacturer: 'Kozen' } })?.id, 'P18');
    assert.equal(deviceTypeFor({ deviceInfo: { model: 'T2', manufacturer: 'SUNMI' } })?.id, 'SUNMI_T2');
    assert.equal(deviceTypeFor({ deviceModel: 'PAX_A77' })?.id, 'PAX_A77');
    assert.equal(deviceTypeFor({ deviceInfo: { model: 'i9100', manufacturer: 'UROVO' } })?.id, 'UROVO_I9100');
    assert.equal(deviceTypeFor({ deviceInfo: { model: 'rk3568_s', manufacturer: 'rockchip' } })?.id, 'HIT_KIOSK');
    assert.equal(deviceTypeFor({ deviceModel: 'GENERIC_ANDROID' }), null);
    assert.equal(deviceTypeFor({}), null);
  });
});

describe('the QR', () => {
  const base = {
    [QR_KEYS.component]: COMPONENT_NAME,
    [QR_KEYS.download]: 'https://api.example.com/api/v1/device-management/provisioning/apk/t',
    [QR_KEYS.checksum]: 'WTM33vQB2dxc5FV0gND_vw1svUeLCxQene7afT4aa6M',
    [QR_KEYS.systemApps]: true,
  };

  it('adds the Wi-Fi in the browser, WPA with a password, open without one', () => {
    assert.deepEqual(withWifi(base, null), base);
    assert.deepEqual(withWifi(base, { ssid: '  ' }), base);
    const wpa = withWifi(base, { ssid: ' Shop ', password: 'p@ss' });
    assert.equal(wpa[QR_KEYS.wifiSsid], 'Shop');
    assert.equal(wpa[QR_KEYS.wifiSecurity], 'WPA');
    assert.equal(wpa[QR_KEYS.wifiPassword], 'p@ss');
    const open = withWifi(base, { ssid: 'Guest', hidden: true });
    assert.equal(open[QR_KEYS.wifiSecurity], 'NONE');
    assert.equal(open[QR_KEYS.wifiPassword], undefined);
    assert.equal(open[QR_KEYS.wifiHidden], true);
    // Changing the network replaces it; the cloud's keys stay.
    const again = withWifi(wpa, { ssid: 'Other', password: '', security: 'NONE' });
    assert.equal(again[QR_KEYS.wifiSsid], 'Other');
    assert.equal(again[QR_KEYS.wifiPassword], undefined);
    assert.equal(again[QR_KEYS.checksum], base[QR_KEYS.checksum]);
    assert.deepEqual(JSON.parse(qrText(again)), again);
  });

  it('explains the cloud\'s warnings', () => {
    for (const code of ['localhost', 'http', 'debug_key', 'not_assigned']) assert.notEqual(qrWarning(code), code);
    assert.equal(qrWarning('other'), 'other');
    assert.ok(QR_STEPS.some((s) => s.includes('6 פעמים')));
  });
});

describe('reboot', () => {
  it('is offered for a device-owner Android device only', () => {
    assert.equal(canReboot({ deviceManagement: { deviceOwner: true } }), true);
    assert.equal(canReboot({ deviceManagement: { deviceOwner: true }, platform: 'windows' }), false);
    assert.equal(canReboot({ deviceManagement: { deviceOwner: false } }), false);
    assert.equal(canReboot({}), false);
  });

  it('reads the request as it stands', () => {
    assert.equal(rebootPending({ id: '1', status: 'pending' }), true);
    assert.equal(rebootPending({ id: '1', status: 'deferred' }), true);
    assert.equal(rebootPending({ id: '1', status: 'rebooting' }), false);
    assert.equal(rebootPending(null), false);
    assert.match(rebootStatusLabel({ id: '1', status: 'deferred', reason: 'busy_sale' })!, /מכירה פתוחה/);
    assert.match(rebootStatusLabel({ id: '1', status: 'refused', reason: 'not_owner' })!, /אינה בעלת המכשיר/);
    assert.equal(rebootStatusLabel({ id: '1', status: 'rebooting' }), 'הופעל מחדש');
    assert.equal(rebootStatusLabel(null), null);
    for (const phase of contract.rebootAckPhases as string[]) {
      assert.ok(rebootStatusLabel({ id: '1', status: phase }), phase);
    }
  });
});
