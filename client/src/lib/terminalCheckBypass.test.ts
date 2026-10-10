/**
 * Run with `npm test`. "עקיפת בדיקת מספר מסוף" per device on the dashboard (lib/terminalCheckBypass.ts).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { checkBypassView, normalizeCheckBypass, tillStillBypassing } from './terminalCheckBypass';

describe('the fields off a machine row', () => {
  it('reads what the cloud resolved, off for a server that predates them', () => {
    assert.deepEqual(normalizeCheckBypass({}), {
      terminalNumberCheckBypass: false,
      terminalNumberCheckBypassSource: null,
      terminalNumberCheckBypassChange: null,
      terminalNumberCheckBypassReported: null,
      cardLockBypassed: null,
    });
    const on = normalizeCheckBypass({
      terminalNumberCheckBypass: true,
      terminalNumberCheckBypassSource: 'shop',
      terminalNumberCheckBypassChange: { userEmail: 'ran@x', userRole: 'super_admin', scopeType: 'shop', at: '2026-10-07T10:00:00Z' },
      terminalNumberCheckBypassReported: true,
      cardLockBypassed: 'mismatch',
    });
    assert.equal(on.terminalNumberCheckBypass, true);
    assert.equal(on.terminalNumberCheckBypassSource, 'shop');
    assert.equal(on.terminalNumberCheckBypassChange?.userEmail, 'ran@x');
    assert.equal(on.cardLockBypassed, 'mismatch');
  });

  it('never takes a truthy non-boolean for on, nor an unknown lock', () => {
    const f = normalizeCheckBypass({ terminalNumberCheckBypass: 'true', cardLockBypassed: 'mismatch' });
    assert.equal(f.terminalNumberCheckBypass, false);
    assert.equal(f.cardLockBypassed, null);
    assert.equal(normalizeCheckBypass({ terminalNumberCheckBypass: true, cardLockBypassed: 'other' }).cardLockBypassed, null);
  });

  it('keeps the till’s own report even while the cloud says off', () => {
    const f = normalizeCheckBypass({ terminalNumberCheckBypass: false, terminalNumberCheckBypassReported: true });
    assert.equal(f.terminalNumberCheckBypassReported, true);
    assert.equal(tillStillBypassing(f), true);
    assert.equal(tillStillBypassing(normalizeCheckBypass({})), false);
  });
});

describe('the warning', () => {
  it('says nothing while off', () => {
    assert.equal(checkBypassView({ terminalNumberCheckBypass: false }), null);
    assert.equal(checkBypassView({}), null);
  });

  it('names the level, who and when, and the lock it lifts', () => {
    const view = checkBypassView(
      normalizeCheckBypass({
        terminalNumberCheckBypass: true,
        terminalNumberCheckBypassSource: 'area',
        terminalNumberCheckBypassChange: { userEmail: 'mgr@x', at: '2026-10-07T10:00:00Z' },
        terminalNumberCheckBypassReported: true,
        cardLockBypassed: 'not_configured',
      }),
    );
    assert.deepEqual(view, { level: 'area', lifted: 'not_configured', by: 'mgr@x', at: '2026-10-07T10:00:00Z', till: null });
  });

  it('says the till has not applied it yet when it still reports the check on', () => {
    const view = checkBypassView(
      normalizeCheckBypass({ terminalNumberCheckBypass: true, terminalNumberCheckBypassSource: 'default', terminalNumberCheckBypassReported: false }),
    );
    assert.equal(view?.level, 'default');
    assert.equal(view?.till, 'pending');
    assert.equal(view?.lifted, null);
    assert.equal(view?.by, null);
  });
});
