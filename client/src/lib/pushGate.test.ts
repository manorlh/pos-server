/**
 * Run with `npm test`. "התראות בנייד שחובה להפעיל" — the gate's pure rules (lib/pushGate.ts):
 * which device, which bar, the screen's steps (install → enable → test → ok), the reminder's
 * 24 hours, the required bar that never closes, a blocked permission.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  deniedHelp,
  detectPlatform,
  gateApplies,
  gateKeys,
  gateStage,
  gateView,
  initialStep,
  installHelp,
  iosPushCapable,
  iosVersion,
  nextStep,
  REMINDER_SNOOZE_MS,
  safeGet,
  safeSet,
  snoozedUntil,
  type FlowEvent,
  type FlowStep,
  type GateFacts,
  type KeyValueStore,
} from './pushGate';

const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';
const IPHONE_17 = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const IPHONE_16_3 = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_3_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.3 Mobile/15E148 Safari/604.1';
const IPAD_DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15';
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

/** An Android phone in Chrome, everything in order, nothing asked. */
const base: GateFacts = {
  applies: true,
  configured: true,
  mode: 'reminder',
  platform: 'android',
  standalone: true,
  supported: true,
  iosCapable: true,
  permission: 'default',
  registered: false,
  stoppedHere: false,
  resubscribeTried: false,
  installPrompt: false,
  reminderSnoozed: false,
  installSnoozed: false,
  onboarded: true,
  screenClosed: false,
};

describe('which device', () => {
  it('tells phones from computers by the user agent and the screen', () => {
    assert.equal(detectPlatform({ userAgent: ANDROID }), 'android');
    assert.equal(detectPlatform({ userAgent: IPHONE_17 }), 'ios');
    assert.equal(detectPlatform({ userAgent: IPAD_DESKTOP, maxTouchPoints: 5 }), 'ios');
    assert.equal(detectPlatform({ userAgent: IPAD_DESKTOP, maxTouchPoints: 0 }), 'desktop');
    assert.equal(detectPlatform({ userAgent: WINDOWS }), 'desktop');
    assert.equal(gateApplies({ userAgent: ANDROID, screenShortSide: 412 }), true);
    assert.equal(gateApplies({ userAgent: IPAD_DESKTOP, maxTouchPoints: 5, screenShortSide: 1024 }), true);
    assert.equal(gateApplies({ userAgent: WINDOWS, screenShortSide: 1080 }), false);
    // A phone's user agent on a desktop-wide screen is a computer.
    assert.equal(gateApplies({ userAgent: ANDROID, screenShortSide: 1440 }), false);
  });

  it('reads the iOS version: push from 16.4', () => {
    assert.deepEqual(iosVersion(IPHONE_17), { major: 17, minor: 5 });
    assert.deepEqual(iosVersion(IPHONE_16_3), { major: 16, minor: 3 });
    assert.deepEqual(iosVersion(IPAD_DESKTOP), { major: 17, minor: 2 });
    assert.equal(iosPushCapable(IPHONE_17), true);
    assert.equal(iosPushCapable(IPHONE_16_3), false);
    assert.equal(iosPushCapable('Mozilla/5.0 (iPhone; CPU iPhone OS 16_4 like Mac OS X)'), true);
    assert.equal(iosPushCapable('unknown'), true);
  });
});

describe('the stages: install → enable → ok', () => {
  it('an iPhone in Safari installs first; then enables; granted and registered is ok', () => {
    assert.equal(gateStage({ ...base, platform: 'ios', standalone: false }), 'install');
    assert.equal(gateStage({ ...base, platform: 'ios', standalone: true }), 'enable');
    assert.equal(gateStage({ ...base, platform: 'android', standalone: false }), 'enable');
    assert.equal(gateStage({ ...base, permission: 'granted', registered: false }), 'enable');
    assert.equal(gateStage({ ...base, permission: 'granted', registered: true }), 'ok');
  });
});

describe('the bars', () => {
  it('never on a computer, and nothing asked of an "off" user but the install suggestion', () => {
    assert.equal(gateView({ ...base, applies: false, mode: 'required' }).banner, 'none');
    const off = gateView({ ...base, mode: 'off', standalone: false });
    assert.equal(off.banner, 'install');
    assert.equal(off.dismissible, true);
    assert.equal(off.autoScreen, false);
    assert.equal(gateView({ ...base, mode: 'off', standalone: false, installSnoozed: true }).banner, 'none');
    assert.equal(gateView({ ...base, mode: 'off', standalone: true }).banner, 'none');
  });

  it('reminder: orange, closable for 24 hours', () => {
    const v = gateView(base);
    assert.equal(v.banner, 'reminder');
    assert.equal(v.tone, 'warning');
    assert.equal(v.dismissible, true);
    assert.equal(gateView({ ...base, reminderSnoozed: true }).banner, 'none');
  });

  it('required: red, never closable, the screen on every open', () => {
    const v = gateView({ ...base, mode: 'required' });
    assert.equal(v.banner, 'required');
    assert.equal(v.tone, 'danger');
    assert.equal(v.dismissible, false);
    assert.equal(v.autoScreen, true);
    // A snooze left over from a reminder does not hide a requirement.
    assert.equal(gateView({ ...base, mode: 'required', reminderSnoozed: true }).banner, 'required');
    // Closed for this session: the bar stays, the screen waits for the next open.
    const closed = gateView({ ...base, mode: 'required', screenClosed: true });
    assert.equal(closed.banner, 'required');
    assert.equal(closed.autoScreen, false);
  });

  it('the screen opens by itself for a reminder only the first time from the icon', () => {
    assert.equal(gateView({ ...base, onboarded: false, standalone: true }).autoScreen, true);
    assert.equal(gateView({ ...base, onboarded: true, standalone: true }).autoScreen, false);
    assert.equal(gateView({ ...base, onboarded: false, standalone: false }).autoScreen, false);
  });

  it('nothing when this device is on; nothing either when the server cannot push', () => {
    assert.equal(gateView({ ...base, mode: 'required', permission: 'granted', registered: true }).banner, 'none');
    assert.equal(gateView({ ...base, mode: 'required', configured: false }).banner, 'none');
  });

  it('blocked in the system: the unblocking help, in the mode’s colour', () => {
    const v = gateView({ ...base, mode: 'required', permission: 'denied' });
    assert.equal(v.banner, 'denied');
    assert.equal(v.tone, 'danger');
    assert.equal(gateView({ ...base, permission: 'denied' }).tone, 'warning');
  });

  it('an iPhone: install first (16.4+), or update iOS; a browser without push', () => {
    assert.equal(gateView({ ...base, platform: 'ios', standalone: false }).banner, 'install_required');
    assert.equal(gateView({ ...base, platform: 'ios', standalone: false, iosCapable: false }).banner, 'ios_update');
    assert.equal(gateView({ ...base, platform: 'ios', standalone: true, iosCapable: false, supported: false }).banner, 'ios_update');
    assert.equal(gateView({ ...base, supported: false }).banner, 'unsupported');
  });

  it('granted but not registered (or rotated, or failing): re-subscribe silently, no bar', () => {
    const v = gateView({ ...base, mode: 'required', permission: 'granted', registered: false });
    assert.equal(v.resubscribe, true);
    assert.equal(v.banner, 'none');
    // Not for an "off" user, not after "הפסק כאן", not from Safari on an iPhone.
    assert.equal(gateView({ ...base, mode: 'off', permission: 'granted' }).resubscribe, false);
    const stopped = gateView({ ...base, mode: 'required', permission: 'granted', stoppedHere: true });
    assert.equal(stopped.resubscribe, false);
    assert.equal(stopped.banner, 'required');
    assert.equal(gateView({ ...base, platform: 'ios', standalone: false, permission: 'granted' }).resubscribe, false);
    // Tried once on this open and still not registered: the bar shows instead of a loop.
    const tried = gateView({ ...base, mode: 'required', permission: 'granted', resubscribeTried: true });
    assert.equal(tried.resubscribe, false);
    assert.equal(tried.banner, 'required');
  });
});

describe('the "הפעל התראות" screen', () => {
  it('starts where the device is', () => {
    assert.equal(initialStep({ ...base, platform: 'ios', standalone: false }), 'install');
    assert.equal(initialStep({ ...base, platform: 'ios', iosCapable: false }), 'update_ios');
    assert.equal(initialStep({ ...base, supported: false }), 'unsupported');
    assert.equal(initialStep({ ...base, permission: 'denied' }), 'denied');
    assert.equal(initialStep({ ...base, permission: 'granted', registered: true }), 'done');
    assert.equal(initialStep(base), 'enable');
  });

  it('enable → working → test → "קיבלתי" → done', () => {
    const run = (start: FlowStep, events: FlowEvent[]) => events.reduce(nextStep, start);
    assert.equal(run('enable', ['tap_enable']), 'working');
    assert.equal(run('enable', ['tap_enable', 'subscribed']), 'test');
    assert.equal(run('enable', ['tap_enable', 'subscribed', 'received']), 'done');
    // "לא הגיעה" → tips → send again → test → received.
    assert.equal(run('enable', ['tap_enable', 'subscribed', 'not_received']), 'not_received');
    assert.equal(run('enable', ['tap_enable', 'subscribed', 'not_received', 'resent', 'received']), 'done');
    // The system said no; a failure can be retried.
    assert.equal(run('enable', ['tap_enable', 'denied']), 'denied');
    assert.equal(run('enable', ['tap_enable', 'failed']), 'error');
    assert.equal(run('enable', ['tap_enable', 'failed', 'tap_enable', 'subscribed']), 'test');
    // Events out of place change nothing.
    assert.equal(run('done', ['tap_enable', 'failed', 'not_received']), 'done');
    assert.equal(run('install', ['tap_enable', 'subscribed']), 'install');
  });
});

describe('help per platform', () => {
  it('unblocking', () => {
    assert.equal(deniedHelp('android', true), 'android_app');
    assert.equal(deniedHelp('android', false), 'android_browser');
    assert.equal(deniedHelp('ios', true), 'ios_app');
    assert.equal(deniedHelp('other_mobile', false), 'other');
  });

  it('installing', () => {
    assert.equal(installHelp({ platform: 'android', standalone: false, installPrompt: true, iosCapable: true }), 'android_prompt');
    assert.equal(installHelp({ platform: 'android', standalone: false, installPrompt: false, iosCapable: true }), 'android_menu');
    assert.equal(installHelp({ platform: 'ios', standalone: false, installPrompt: false, iosCapable: true }), 'ios_steps');
    assert.equal(installHelp({ platform: 'ios', standalone: false, installPrompt: false, iosCapable: false }), 'ios_update');
    assert.equal(installHelp({ platform: 'android', standalone: true, installPrompt: true, iosCapable: true }), 'none');
  });
});

describe('flags on the device', () => {
  it('the reminder snooze lasts 24 hours', () => {
    const now = Date.UTC(2026, 9, 13, 9);
    const until = String(now + REMINDER_SNOOZE_MS);
    assert.equal(snoozedUntil(until, now), true);
    assert.equal(snoozedUntil(until, now + REMINDER_SNOOZE_MS + 1), false);
    assert.equal(snoozedUntil(null, now), false);
    assert.equal(snoozedUntil('garbage', now), false);
  });

  it('storage that throws (private mode) never breaks the gate', () => {
    const broken: KeyValueStore = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceeded');
      },
      removeItem: () => {
        throw new Error('SecurityError');
      },
    };
    assert.equal(safeGet(broken, 'x'), null);
    assert.doesNotThrow(() => safeSet(broken, 'x', '1'));
    assert.doesNotThrow(() => safeSet(broken, 'x', null));
    assert.equal(safeGet(null, 'x'), null);
    const map = new Map<string, string>();
    const ok: KeyValueStore = { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v), removeItem: (k) => void map.delete(k) };
    const keys = gateKeys('u1');
    safeSet(ok, keys.reminderUntil, '5');
    assert.equal(safeGet(ok, keys.reminderUntil), '5');
    safeSet(ok, keys.reminderUntil, null);
    assert.equal(safeGet(ok, keys.reminderUntil), null);
    assert.notEqual(gateKeys('u1').reminderUntil, gateKeys('u2').reminderUntil);
  });
});
