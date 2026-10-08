/**
 * Run with `npm test`. "התראות" — the phone alerts' pure rules (lib/pushAlerts.ts).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  alertHref,
  attentionItems,
  draftFromPrefs,
  historyTone,
  prefsBody,
  prefsErrors,
  pushSupport,
  toggle,
  urlBase64ToUint8Array,
  type AlertsFeed,
  type FeedAlert,
  type PushPreferences,
} from './pushAlerts';

const env = { hasServiceWorker: true, hasPushManager: true, hasNotification: true, permission: 'default', userAgent: 'Chrome', standalone: false };

describe('this browser', () => {
  it('can, cannot, needs installing on an iPhone, or was refused', () => {
    assert.equal(pushSupport(env), 'ok');
    assert.equal(pushSupport({ ...env, hasPushManager: false }), 'unsupported');
    assert.equal(pushSupport({ ...env, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)' }), 'ios_needs_install');
    assert.equal(pushSupport({ ...env, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)', standalone: true }), 'ok');
    assert.equal(pushSupport({ ...env, permission: 'denied' }), 'denied');
  });

  it('turns the VAPID key into bytes', () => {
    const bytes = urlBase64ToUint8Array('BAEC_-8');
    assert.deepEqual([...bytes], [4, 1, 2, 255, 239]);
  });
});

const prefs: PushPreferences = {
  exists: true,
  enabled: true,
  categories: ['till_offline', 'large_void'],
  shopIds: null,
  eventIds: ['e1'],
  minAmount: 200,
  quietFrom: null,
  quietTo: null,
  rateLimitMinutes: 2,
  digestEnabled: true,
};

describe('the preferences form', () => {
  it('round-trips the preferences, in the catalogue order', () => {
    const d = draftFromPrefs(prefs);
    assert.equal(d.quiet, false);
    const body = prefsBody({ ...d, categories: ['large_void', 'till_offline'] });
    assert.deepEqual(body.categories, ['till_offline', 'large_void']);
    assert.equal(body.shopIds, null);
    assert.deepEqual(body.eventIds, ['e1']);
    assert.equal(body.quietFrom, null);
    assert.deepEqual(prefsBody({ ...d, quiet: true, quietFrom: '23:00', quietTo: '07:00' }).quietTo, '07:00');
  });

  it('checks it like the server', () => {
    const d = draftFromPrefs(prefs);
    assert.deepEqual(prefsErrors(d), []);
    assert.deepEqual(prefsErrors({ ...d, categories: [] }), ['categories']);
    assert.deepEqual(prefsErrors({ ...d, enabled: false, categories: [] }), []);
    assert.deepEqual(prefsErrors({ ...d, minAmount: '-1' }), ['minAmount']);
    assert.deepEqual(prefsErrors({ ...d, quiet: true, quietFrom: '07:00', quietTo: '07:00' }), ['quiet']);
    assert.deepEqual(prefsErrors({ ...d, rateLimitMinutes: '1.5' }), ['rateLimit']);
  });

  it('toggles a value in a list', () => {
    assert.deepEqual(toggle(['a', 'b'], 'a'), ['b']);
    assert.deepEqual(toggle(['a'], 'b'), ['a', 'b']);
  });
});

const alert = (over: Partial<FeedAlert>): FeedAlert => ({
  id: 'x', code: 'abc', kind: 'till_offline', kindLabel: 'קופה לא מחוברת', category: 'till_offline',
  categoryLabel: 'קופה התנתקה', severity: 'high', occurredAt: '2026-09-27T15:00:00Z', shopName: 'מרכז',
  machineName: 'קופה 2', posNumber: '2', posUserName: null, amount: null, summary: null, acknowledged: false,
  note: null, details: null, ...over,
});

describe('the attention feed', () => {
  it('lists open alerts, worst and newest first, with their actions', () => {
    const feed: AlertsFeed = {
      open: 2,
      canAcknowledge: true,
      alerts: [
        alert({ id: 'low', severity: 'low', occurredAt: '2026-09-27T16:00:00Z' }),
        alert({ id: 'done', acknowledged: true }),
        alert({ id: 'high' }),
      ],
    };
    const items = attentionItems(feed, () => '18:00');
    assert.deepEqual(items.map((i) => i.id), ['high', 'low']);
    assert.equal(items[0].title, 'קופה התנתקה · קופה 2');
    assert.equal(items[0].body, 'מרכז · קופה לא מחוברת · 18:00');
    assert.deepEqual(items[0].actions.map((a) => a.actionId), ['ack', 'open']);
    assert.deepEqual(attentionItems({ ...feed, canAcknowledge: false }, () => '').map((i) => i.actions.length), [1, 1]);
  });

  it('leads a target to the live screen, anything else to its page', () => {
    assert.equal(alertHref({ kind: 'target_reached', code: 'c', details: { eventId: 'e9' } }), '/dashboard/live-event/e9');
    assert.equal(alertHref({ kind: 'refund', code: 'c', details: null }), '/x/c');
  });

  it('colours the history', () => {
    assert.equal(historyTone('sent'), 'sent');
    assert.equal(historyTone('suppressed_quiet_hours'), 'held');
    assert.equal(historyTone('failed'), 'failed');
  });
});
