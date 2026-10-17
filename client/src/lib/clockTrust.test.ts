/**
 * Run with `npm test`. "שעון המכשיר" — how the dashboard reads a device's `clockTrust` (lib/clockTrust.ts).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CLOCK_TRUST_MS, clockTrustView } from './clockTrust';

describe('the device clock on the dashboard', () => {
  it('nothing from a device that never reported', () => {
    assert.equal(clockTrustView(null, 600_000), null);
    assert.equal(clockTrustView(undefined, null), null);
  });

  it('documents on the server clock: yellow, and it says so', () => {
    const v = clockTrustView(
      { source: 'server', offsetMs: 420_000, autoFix: 'device_owner', autoFixEnabled: true, lastFix: { at: '2026-10-17T10:00:00Z', action: 'set_time', result: 'ok' } },
      -420_000,
    )!;
    assert.equal(v.documents, 'מסמכים לפי שעון השרת');
    assert.equal(v.tone, 'warn');
    assert.equal(v.fix, 'תיקון אוטומטי: בעלות מכשיר — מתקן לבד');
    assert.equal(v.lastFix, 'תיקון אחרון: כיוון לפי השרת — הצליח');
  });

  it('a clock off on the device clock (no verified answer) warns; a right one is fine', () => {
    assert.equal(clockTrustView({ source: 'device', autoFix: 'none', autoFixEnabled: true }, CLOCK_TRUST_MS)!.tone, 'warn');
    const ok = clockTrustView({ source: 'device', autoFix: 'elevated', autoFixEnabled: true }, 1_000)!;
    assert.equal(ok.tone, 'ok');
    assert.equal(ok.documents, 'מסמכים לפי שעון המכשיר');
    assert.equal(ok.fix, 'תיקון אוטומטי: הרשאות מנהל ב-Windows — מתקן לבד');
    assert.equal(ok.lastFix, null);
  });

  it('the parameter off, a capability not known, a fix declined', () => {
    assert.equal(clockTrustView({ source: 'device', autoFix: 'device_owner', autoFixEnabled: false }, 0)!.fix, 'תיקון אוטומטי: כבוי');
    assert.equal(clockTrustView({ source: 'device', autoFix: 'weird' }, 0)!.fix, 'תיקון אוטומטי: ידני');
    assert.equal(
      clockTrustView({ source: 'device', lastFix: { at: 'x', action: 'enable_auto_time', result: 'refused' } }, 0)!.lastFix,
      'תיקון אחרון: הפעלת שעה אוטומטית — לא אושר',
    );
  });
});
