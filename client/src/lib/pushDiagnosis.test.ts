/**
 * Run with `npm test`. "בדיקת התראות" (fix/pwa-push) — lib/pushDiagnosis.ts: the steps, what each
 * push service answer means, the tips per platform, this browser's id, and when a computer
 * registers again by itself.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  browserName,
  configProblem,
  deviceIdFrom,
  DEVICE_ID_KEY,
  firstFailure,
  initialSteps,
  keeperShouldResubscribe,
  retryableSubscribeError,
  sameKey,
  serverOutcome,
  serviceName,
  setStep,
  tipsFor,
  tipsPlatform,
  wantedKey,
  type KeeperFacts,
} from './pushDiagnosis';
import type { KeyValueStore } from './pushGate';

const WIN_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const WIN_EDGE = `${WIN_CHROME} Edg/141.0.0.0`;
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36';
const SAMSUNG = 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0 Mobile Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15';

function memory(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

describe('the steps', () => {
  it('start pending, and a failure skips what is still ahead', () => {
    let steps = initialSteps();
    assert.deepEqual(steps.map((s) => s.id), ['support', 'permission', 'worker', 'subscription', 'server', 'arrived']);
    assert.ok(steps.every((s) => s.state === 'pending'));
    steps = setStep(steps, 'support', { state: 'ok', note: 'ok' });
    steps = setStep(steps, 'permission', { state: 'fail', note: 'denied' });
    assert.deepEqual(steps.map((s) => s.state), ['ok', 'fail', 'skipped', 'skipped', 'skipped', 'skipped']);
    assert.equal(firstFailure(steps), 'permission');
    assert.equal(firstFailure(initialSteps()), null);
  });
});

describe("the push service's answer", () => {
  const r = (status: number | null, extra: Partial<{ ok: boolean; error: string | null; gone: boolean }> = {}) => ({
    ok: false,
    status,
    error: status ? `http_${status}` : 'ConnectTimeout',
    gone: false,
    ...extra,
  });

  it('took it, or says why not — and what registering again fixes', () => {
    assert.deepEqual(serverOutcome({ ok: true, status: 201, error: null, gone: false }), { state: 'ok', note: 'accepted', fixable: false });
    assert.deepEqual(serverOutcome(r(410, { gone: true })), { state: 'fail', note: 'gone', fixable: true });
    assert.deepEqual(serverOutcome(r(404)), { state: 'fail', note: 'gone', fixable: true });
    assert.deepEqual(serverOutcome(r(403)), { state: 'fail', note: 'keyMismatch', fixable: true });
    assert.deepEqual(serverOutcome(r(400)), { state: 'fail', note: 'badRequest', fixable: true });
    assert.equal(serverOutcome(r(413)).note, 'tooLarge');
    assert.deepEqual(serverOutcome(r(429)), { state: 'warn', note: 'serviceBusy', fixable: false });
    assert.equal(serverOutcome(r(503)).note, 'serviceDown');
    assert.equal(serverOutcome(r(null)).note, 'unreachable');
    assert.equal(serverOutcome(r(null, { error: 'push_not_configured' })).note, 'notConfigured');
    assert.equal(serverOutcome(r(null, { error: 'sending_off' })).note, 'sendingOff');
  });

  it('names the push services', () => {
    assert.equal(serviceName('fcm'), 'Google (FCM)');
    assert.equal(serviceName('wns'), 'Microsoft (WNS)');
    assert.equal(serviceName('nope'), serviceName('other'));
    assert.equal(serviceName(null), serviceName('other'));
  });

  it("reads the server's key problems", () => {
    assert.deepEqual(configProblem('missing_private_key'), { note: 'missingKey', blocking: true });
    assert.deepEqual(configProblem('private_key_unreadable'), { note: 'unreadableKey', blocking: true });
    assert.deepEqual(configProblem('public_key_mismatch'), { note: 'publicMismatch', blocking: false });
    assert.deepEqual(configProblem('subject_localhost'), { note: 'subject', blocking: false });
    assert.equal(configProblem('public_key_missing'), null);
    assert.equal(configProblem(null), null);
  });
});

describe('the tips', () => {
  it('know the platform and the browser', () => {
    assert.equal(tipsPlatform(WIN_EDGE), 'windows');
    assert.equal(tipsPlatform(ANDROID), 'android');
    assert.equal(tipsPlatform(IPHONE), 'ios');
    assert.equal(tipsPlatform(MAC), 'mac');
    assert.equal(tipsPlatform(MAC, 5), 'ios'); // an iPad that says it is a Mac
    assert.equal(browserName(WIN_EDGE), 'Edge');
    assert.equal(browserName(WIN_CHROME), 'Chrome');
    assert.equal(browserName(SAMSUNG), 'Samsung Internet');
    assert.equal(browserName(IPHONE), 'Safari');
    assert.equal(browserName(''), null);
  });

  it('start with Focus Assist on Windows and with installing on Android', () => {
    assert.deepEqual(tipsFor('windows', { standalone: false, arrived: false }), ['winFocus', 'winSystem', 'winSite', 'winBackground', 'network']);
    assert.deepEqual(tipsFor('android', { standalone: false, arrived: false }), ['androidInstall', 'androidChannel', 'androidBattery', 'androidDnd', 'network']);
    // Installed already: no install tip.
    assert.equal(tipsFor('android', { standalone: true, arrived: false })[0], 'androidChannel');
    // It reached the browser: the system hid it — said first, and never "check the network".
    const arrived = tipsFor('windows', { standalone: false, arrived: true });
    assert.equal(arrived[0], 'arrivedHidden');
    assert.ok(!arrived.includes('network'));
    assert.deepEqual(tipsFor('ios', { standalone: false, arrived: false }).slice(0, 1), ['iosInstall']);
  });
});

describe('this browser', () => {
  it('keeps one random id', () => {
    const store = memory();
    const id = deviceIdFrom(store, () => '0f3c9a2e-1111-4222-8333-944455556666');
    assert.equal(id, '0f3c9a2e-1111-4222-8333-944455556666');
    assert.equal(deviceIdFrom(store, () => 'another-id-entirely'), id);
    // Something unusable stored: replaced.
    store.data.set(DEVICE_ID_KEY, 'bad id!');
    assert.equal(deviceIdFrom(store, () => 'abc_def-12345'), 'abc_def-12345');
    // Nowhere to keep it: none (the server goes by the endpoint).
    assert.equal(deviceIdFrom(null, () => 'abc_def-12345'), null);
    assert.equal(wantedKey('u1'), 'r2m.push.wanted.u1');
  });

  it('compares the keys a subscription was made with', () => {
    const key = new Uint8Array([4, 1, 2, 3]);
    assert.ok(sameKey(new Uint8Array([4, 1, 2, 3]).buffer, key));
    assert.ok(sameKey(new Uint8Array([9, 4, 1, 2, 3]).subarray(1), key));
    assert.ok(!sameKey(new Uint8Array([4, 1, 2, 4]).buffer, key));
    assert.ok(!sameKey(new Uint8Array([4, 1, 2]).buffer, key));
    assert.ok(!sameKey(null, key));
  });

  it("retries Edge's push service error, nothing else", () => {
    assert.ok(retryableSubscribeError({ name: 'AbortError', message: 'Registration failed - push service error' }));
    assert.ok(retryableSubscribeError(new Error('Registration failed - push service not available')));
    assert.ok(!retryableSubscribeError({ name: 'NotAllowedError', message: 'Registration failed - permission denied' }));
    assert.ok(!retryableSubscribeError({ name: 'InvalidStateError', message: 'key mismatch' }));
    assert.ok(!retryableSubscribeError(null));
  });
});

describe('a computer registers again by itself', () => {
  const ok: KeeperFacts = {
    configured: true,
    supported: true,
    permission: 'granted',
    wanted: true,
    hasSubscription: true,
    registered: true,
    failing: false,
    keyMatches: true,
    stoppedHere: false,
    tried: false,
  };

  it('only when something is missing', () => {
    assert.equal(keeperShouldResubscribe(ok), false);
    // After a sign-out (the browser unsubscribed): the same person signs in again.
    assert.equal(keeperShouldResubscribe({ ...ok, hasSubscription: false, registered: false }), true);
    // Gone at the push service (404 / 410 turned it off on the server), failing, or the server's key changed.
    assert.equal(keeperShouldResubscribe({ ...ok, registered: false }), true);
    assert.equal(keeperShouldResubscribe({ ...ok, failing: true }), true);
    assert.equal(keeperShouldResubscribe({ ...ok, keyMatches: false }), true);
  });

  it('never against the person or the browser', () => {
    const lost = { ...ok, registered: false };
    assert.equal(keeperShouldResubscribe({ ...lost, permission: 'default' }), false);
    assert.equal(keeperShouldResubscribe({ ...lost, permission: 'denied' }), false);
    assert.equal(keeperShouldResubscribe({ ...lost, stoppedHere: true }), false);
    assert.equal(keeperShouldResubscribe({ ...lost, tried: true }), false);
    assert.equal(keeperShouldResubscribe({ ...lost, configured: false }), false);
    // Someone else's browser (never turned on by this person, nothing subscribed): nothing.
    assert.equal(keeperShouldResubscribe({ ...lost, wanted: false, hasSubscription: false }), false);
    // A subscription the server knows as someone else's: never moved to whoever signed in.
    assert.equal(keeperShouldResubscribe({ ...lost, wanted: false }), false);
    // Mine on the server (subscribed before "wanted" was kept), failing or with an old key: renewed.
    assert.equal(keeperShouldResubscribe({ ...ok, wanted: false, failing: true }), true);
    assert.equal(keeperShouldResubscribe({ ...ok, wanted: false, keyMatches: false }), true);
    assert.equal(keeperShouldResubscribe({ ...ok, wanted: false }), false);
  });
});
