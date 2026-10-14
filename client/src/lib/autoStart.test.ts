/**
 * Run with `npm test`. "פתיחה אוטומטית" (lib/autoStart.ts): the server's `autoStart` as the
 * indicator — green "מוכן" (and how), yellow "חסר אישור במכשיר", grey "כבוי", nothing when unknown.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { AUTO_START_TITLE, autoStartView } from './autoStart';

describe('autoStartView', () => {
  it('says ready, and how', () => {
    const ready = autoStartView({ state: 'ready', via: 'permission' });
    assert.equal(ready?.state, 'ready');
    assert.equal(ready?.tone, 'ok');
    assert.equal(ready?.label, 'מוכן · הרשאה');
    assert.equal(autoStartView({ state: 'ready', via: 'home' })?.label, 'מוכן · מסך בית');
    assert.equal(autoStartView({ state: 'ready', via: 'lock' })?.label, 'מוכן · נעילת קופה');
    // A way this page does not know, or none: just "מוכן".
    assert.equal(autoStartView({ state: 'ready', via: null })?.label, 'מוכן');
    assert.equal(autoStartView({ state: 'ready', via: 'magic' })?.label, 'מוכן');
  });

  it('says missing in yellow and off in grey, never with a way', () => {
    const missing = autoStartView({ state: 'missing', via: 'permission' });
    assert.equal(missing?.tone, 'warn');
    assert.equal(missing?.label, 'חסר אישור במכשיר');
    assert.match(missing?.hint ?? '', /פעם אחת במכשיר/);
    const off = autoStartView({ state: 'off', reportedAt: '2026-10-14T08:00:00+00:00' });
    assert.equal(off?.tone, 'muted');
    assert.equal(off?.label, 'כבוי');
  });

  it('shows nothing when unknown', () => {
    assert.equal(autoStartView(null), null);
    assert.equal(autoStartView(undefined), null);
    assert.equal(autoStartView({ state: 'unknown' }), null);
    assert.equal(autoStartView({ state: '' }), null);
  });

  it('names the column', () => {
    assert.equal(AUTO_START_TITLE, 'פתיחה אוטומטית');
  });
});
