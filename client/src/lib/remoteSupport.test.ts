/**
 * Run with `npm test`. "תמיכה מרחוק" (lib/remoteSupport.ts): the device's QuickSupport report, the
 * allowed signer fingerprint ("נקבע אוטומטית מהתקנה ראשונה"), and the replace dialog's checks — the
 * same rules as pos-server app/services/remote_support.py. Fingerprints here are obvious fakes.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  awaitsConfirmation,
  canUseAsPin,
  fingerprintsOf,
  formatFingerprint,
  installedLabel,
  originLabel,
  parseFingerprints,
  pinErrorText,
  pinNote,
  pinStatusLabel,
  reportOf,
  sameFingerprints,
  type SignerPin,
} from './remoteSupport';

const A = 'a1'.repeat(32);
const B = 'b2'.repeat(32);
const fmt = (iso: string) => `[${iso.slice(0, 10)}]`;

function pin(over: Partial<SignerPin> = {}): SignerPin {
  return {
    key: 'remoteSupportSignerSha256',
    parameterId: 'p1',
    active: true,
    value: [A],
    source: 'auto',
    auto: { machineId: 'm1', tillLabel: 'קופה 3', shopName: 'מרכז', at: '2026-10-14T09:00:00+00:00' },
    officialHost: 'download.teamviewer.com',
    ...over,
  };
}

describe('the report', () => {
  it('reads what the cloud kept, and nothing else', () => {
    assert.equal(reportOf(null), null);
    assert.equal(reportOf({}), null);
    assert.equal(reportOf({ remoteSupport: 'x' }), null);
    assert.equal(reportOf({ remoteSupport: [] }), null);
    const r = reportOf({
      platform: 'android',
      remoteSupport: {
        installed: true,
        package: 'com.teamviewer.quicksupport.market',
        signerSha256: [A.toUpperCase(), 'zz', 5],
        installedFrom: 'https://download.teamviewer.com/download/TeamViewerQS.apk',
        pinStatus: 'mismatch',
        extra: 1,
      },
    });
    assert.deepEqual(r, {
      installed: true,
      package: 'com.teamviewer.quicksupport.market',
      signerSha256: [A],
      installedFrom: 'https://download.teamviewer.com/download/TeamViewerQS.apk',
      pinStatus: 'mismatch',
    });
    assert.equal(reportOf({ remoteSupport: { pinStatus: 'whatever' } })?.pinStatus, undefined);
  });

  it('says installed, not installed, or not reported', () => {
    assert.equal(installedLabel(null), 'לא דווח');
    assert.equal(installedLabel({}), 'לא דווח');
    assert.equal(installedLabel({ installed: true }), 'מותקן');
    assert.equal(installedLabel({ installed: false }), 'לא מותקן');
  });

  it('shows a fingerprint as keytool prints it', () => {
    assert.equal(formatFingerprint('ab'.repeat(32)), Array(32).fill('AB').join(':'));
    assert.equal(formatFingerprint(Array(32).fill('cd').join(':')), Array(32).fill('CD').join(':'));
  });

  it('labels the match against the pin', () => {
    assert.equal(pinStatusLabel('match')?.tone, 'ok');
    assert.equal(pinStatusLabel('mismatch')?.tone, 'bad');
    assert.match(pinStatusLabel('mismatch')?.text ?? '', /לא תואם/);
    assert.equal(pinStatusLabel('no_pin')?.tone, 'muted');
    assert.equal(pinStatusLabel('pinned_first')?.tone, 'info');
    assert.equal(pinStatusLabel(undefined), null);
  });
});

describe('the pin', () => {
  it('compares fingerprints in any form and order', () => {
    assert.deepEqual(fingerprintsOf(`${A.toUpperCase()}, ${B},${A}`), [A, B]);
    assert.ok(sameFingerprints([A, B], `${B},${A.toUpperCase()}`));
    assert.ok(!sameFingerprints([A], [A, B]));
  });

  it('offers "השתמש כטביעת האצבע המותרת" only for a reported signer that is not the pin yet', () => {
    assert.equal(canUseAsPin(null, pin()), false);
    assert.equal(canUseAsPin({ installed: true, signerSha256: [] }, pin()), false);
    assert.equal(canUseAsPin({ signerSha256: [A] }, pin()), false);
    assert.equal(canUseAsPin({ signerSha256: [B] }, pin()), true);
    assert.equal(canUseAsPin({ signerSha256: [A] }, pin({ value: [] })), true);
    assert.equal(canUseAsPin({ signerSha256: [A] }, null), true);
  });

  it('says where an automatic pin came from, and that it was confirmed', () => {
    assert.equal(pinNote(pin(), fmt), 'נקבע אוטומטית מהתקנה ראשונה (קופה 3 · מרכז, [2026-10-14])');
    assert.equal(
      pinNote(pin({ source: 'confirmed', confirmedBy: 'boss@r2m.test', confirmedAt: '2026-10-15T08:00:00Z' }), fmt),
      'נקבע אוטומטית מהתקנה ראשונה (קופה 3 · מרכז, [2026-10-14]) · אושר ע״י boss@r2m.test [2026-10-15]',
    );
    assert.equal(pinNote(pin({ source: 'manual', auto: null }), fmt), null);
    assert.equal(pinNote(pin({ value: [] }), fmt), null);
    assert.equal(pinNote(null, fmt), null);
    assert.ok(awaitsConfirmation(pin()));
    assert.ok(!awaitsConfirmation(pin({ source: 'confirmed' })));
    assert.ok(!awaitsConfirmation(pin({ value: [] })));
  });

  it('names the till of the first install', () => {
    assert.equal(originLabel(null), 'קופה');
    assert.equal(originLabel({ posNumber: '7' }), 'קופה 7');
    assert.equal(originLabel({ machineName: 'בר', shopName: 'צפון' }), 'בר · צפון');
  });
});

describe('the replace dialog', () => {
  it('takes what the server takes', () => {
    assert.deepEqual(parseFingerprints(`${Array(32).fill('A1').join(':')}\n${B}, ${A}`), { value: [A, B], error: null });
    assert.match(parseFingerprints('').error ?? '', /לפחות/);
    assert.match(parseFingerprints('abc').error ?? '', /לא תקינה/);
    assert.match(parseFingerprints(`${A} ${B}`).error ?? '', /לא תקינה/);
    const eleven = Array.from({ length: 11 }, (_, i) => i.toString(16).padStart(64, '0')).join(',');
    assert.match(parseFingerprints(eleven).error ?? '', /עד 10/);
  });

  it('turns the refusal codes into Hebrew', () => {
    for (const code of ['remote_support_pin_not_auto', 'remote_support_pin_changed', 'remote_support_no_report', 'remote_support_pin_source']) {
      assert.ok(pinErrorText(code), code);
    }
    assert.equal(pinErrorText('other'), null);
  });
});
