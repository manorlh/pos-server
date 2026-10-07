import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ANDROID_BRIDGE_API,
  ANDROID_CALLS,
  ANDROID_EVENTS,
  ANDROID_ORIGIN,
  ANDROID_SENDS,
  NATIVE_STAFF,
  PAY_NO_ANSWER,
  apkSupports,
  createAndroidBridges,
  errorText,
  guardStaffCorners,
  inWebStaffCorner,
  injectScan,
  localMediaOnly,
  normalizeView,
  scanKeys,
  type AndroidNative,
  type ScanKey,
} from '../src/renderer/bridges/android';
import { ScanKeyReader } from '../src/core/kioskScan';
import { KIOSK_DEFAULTS, type KioskConfig } from '@dash-lib/kioskConfig';
import type { KioskView, PayProgress, StartPaymentIn, StartPaymentOut } from '../src/shared/bridge';

const fixture = JSON.parse(readFileSync(path.join(__dirname, 'fixtures/android_bridge_api.json'), 'utf8')) as {
  bridgeApi: number;
  calls: string[];
  sends: string[];
  events: string[];
  samples: { startPayment: StartPaymentIn; pay: PayProgress; startPaymentChanged: StartPaymentOut; reportFlow: Record<string, unknown> };
};

/** A fake APK: records what the screens ask; the test answers through the inbox. */
function fakeNative(api = 1) {
  const calls: Array<{ id: string; method: string; args: unknown }> = [];
  const sends: Array<{ method: string; payload: unknown }> = [];
  const native: AndroidNative = {
    bridgeApi: () => api,
    call: (id, method, argsJson) => void calls.push({ id, method, args: JSON.parse(argsJson) }),
    send: (method, json) => void sends.push({ method, payload: JSON.parse(json) }),
  };
  return { native, calls, sends };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('the Android bridge speaks the pinned wire (bridgeApi 1)', () => {
  it('every name is the fixture shared with pos-android', () => {
    expect(ANDROID_BRIDGE_API).toBe(fixture.bridgeApi);
    expect([...ANDROID_CALLS]).toEqual(fixture.calls);
    expect([...ANDROID_SENDS]).toEqual(fixture.sends);
    expect([...ANDROID_EVENTS]).toEqual(fixture.events);
  });

  it('an APK that speaks less is refused', () => {
    expect(apkSupports(1)).toBe(true);
    expect(apkSupports(2)).toBe(true);
    expect(apkSupports(0)).toBe(false);
    expect(apkSupports('1')).toBe(false);
    expect(apkSupports(undefined)).toBe(false);
    expect(apkSupports(1.5)).toBe(false);
  });
});

describe('calls and answers', () => {
  it('bootstrap: one call with its own id, the answer parsed', async () => {
    const { native, calls } = fakeNative();
    const b = createAndroidBridges(native);
    const p = b.kiosk.bootstrap();
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('bootstrap');
    expect(calls[0].args).toEqual({});
    const view = { phase: 'kiosk', appVersion: '0.1.230' } as unknown as KioskView;
    b.inbox.reply(calls[0].id, true, JSON.stringify(view));
    await expect(p).resolves.toEqual(view);
    expect(b.pending()).toBe(0);
  });

  it('ids never repeat; a late or unknown answer is ignored', async () => {
    const { native, calls } = fakeNative();
    const b = createAndroidBridges(native);
    const p1 = b.shell.view();
    const p2 = b.shell.view();
    expect(calls[0].id).not.toBe(calls[1].id);
    b.inbox.reply('nobody', true, '{}');
    b.inbox.reply(calls[1].id, true, '{"role":"kiosk"}');
    b.inbox.reply(calls[0].id, true, '{"role":"kiosk","n":1}');
    b.inbox.reply(calls[0].id, true, '{"role":"twice"}');
    await expect(p1).resolves.toEqual({ role: 'kiosk', n: 1 });
    await expect(p2).resolves.toEqual({ role: 'kiosk' });
  });

  it('a refusal rejects with the APK\'s message', async () => {
    const { native, calls } = fakeNative();
    const b = createAndroidBridges(native);
    const p = b.kiosk.bootstrap();
    b.inbox.reply(calls[0].id, false, JSON.stringify('not a kiosk'));
    await expect(p).rejects.toThrow('not a kiosk');
  });

  it('startPayment sends the screens\' basket as it is and returns the APK\'s verdict', async () => {
    const { native, calls } = fakeNative();
    const b = createAndroidBridges(native);
    const p = b.kiosk.startPayment(fixture.samples.startPayment);
    expect(calls[0].method).toBe('startPayment');
    expect(calls[0].args).toEqual(fixture.samples.startPayment);
    b.inbox.reply(calls[0].id, true, JSON.stringify(fixture.samples.startPaymentChanged));
    await expect(p).resolves.toEqual(fixture.samples.startPaymentChanged);
  });

  it('startPayment never rejects: no answer, a refusal or a broken APK is a message to the customer', async () => {
    vi.useFakeTimers();
    const { native, calls } = fakeNative();
    const b = createAndroidBridges(native, { timeouts: { startPayment: 1000 } });
    const silent = b.kiosk.startPayment(fixture.samples.startPayment);
    vi.advanceTimersByTime(1001);
    await expect(silent).resolves.toEqual({ ok: false, reason: 'error', message: PAY_NO_ANSWER });
    const refused = b.kiosk.startPayment(fixture.samples.startPayment);
    b.inbox.reply(calls[1].id, false, '"boom"');
    await expect(refused).resolves.toMatchObject({ ok: false, reason: 'error' });
    const broken = createAndroidBridges({ ...native, call: () => { throw new Error('gone'); } });
    await expect(broken.kiosk.startPayment(fixture.samples.startPayment)).resolves.toMatchObject({ ok: false, reason: 'error' });
    expect(b.pending()).toBe(0);
  });

  it('bootstrap with no answer rejects (the APK\'s watchdog sees no ready)', async () => {
    vi.useFakeTimers();
    const { native } = fakeNative();
    const b = createAndroidBridges(native, { timeouts: { bootstrap: 500 } });
    const p = b.kiosk.bootstrap();
    vi.advanceTimersByTime(501);
    await expect(p).rejects.toThrow('no answer');
  });

  it('receipt, cancel and help: their arguments, and never a rejection', async () => {
    const { native, calls } = fakeNative();
    const b = createAndroidBridges(native);
    const r = b.kiosk.receiptChoice('order-1', true);
    const c = b.kiosk.cancelPayment();
    const h = b.kiosk.helpRequest();
    expect(calls.map((x) => [x.method, x.args])).toEqual([
      ['receiptChoice', { orderId: 'order-1', print: true }],
      ['cancelPayment', {}],
      ['helpRequest', {}],
    ]);
    b.inbox.reply(calls[0].id, true, null);
    b.inbox.reply(calls[1].id, false, '"too late"');
    b.inbox.reply(calls[2].id, true, '{}');
    await expect(Promise.all([r, c, h])).resolves.toEqual([undefined, undefined, undefined]);
  });

  it('one-way messages: the flow, the funnel, a touch', () => {
    const { native, sends, calls } = fakeNative();
    const b = createAndroidBridges(native);
    b.kiosk.reportFlow(fixture.samples.reportFlow as never);
    b.kiosk.funnel?.([{ sessionId: 's', seq: 1, type: 'session_start', at: '2026-10-07T10:00:00Z' }]);
    b.shell.activity();
    expect(sends).toEqual([
      { method: 'reportFlow', payload: fixture.samples.reportFlow },
      { method: 'funnel', payload: [{ sessionId: 's', seq: 1, type: 'session_start', at: '2026-10-07T10:00:00Z' }] },
      { method: 'activity', payload: null },
    ]);
    expect(calls).toHaveLength(0);
  });

  it('no battery on Android: the APK shows it itself', () => {
    const b = createAndroidBridges(fakeNative().native);
    expect(b.kiosk.battery).toBeUndefined();
  });
});

describe('the staff stay native', () => {
  it('the screens\' own PIN pads never open anything, and never reach the APK', async () => {
    const { native, calls, sends } = fakeNative();
    const b = createAndroidBridges(native);
    await expect(b.kiosk.adminUnlock('1234')).resolves.toEqual({ ok: false, error: NATIVE_STAFF });
    await expect(b.kiosk.technicianUnlock('1995')).resolves.toMatchObject({ outcome: 'locked' });
    await expect(b.kiosk.adminAction({ type: 'exitKiosk' })).resolves.toEqual({ ok: false, message: NATIVE_STAFF });
    await expect(b.kiosk.technicianAction({ type: 'unpair' })).resolves.toEqual({ ok: false, message: NATIVE_STAFF });
    await expect(b.kiosk.adminInfo()).rejects.toThrow();
    await expect(b.kiosk.pair({ serverUrl: 'x', code: 'y', machineName: 'z' })).resolves.toMatchObject({ ok: false });
    expect(calls).toHaveLength(0);
    expect(sends).toHaveLength(0);
  });

  it('the corners: the admin\'s top-right square and the technician\'s top-left strip', () => {
    expect(inWebStaffCorner(1050, 10, 1080)).toBe(true);
    expect(inWebStaffCorner(1033, 47, 1080)).toBe(true);
    expect(inWebStaffCorner(1000, 10, 1080)).toBe(false);
    expect(inWebStaffCorner(1050, 60, 1080)).toBe(false);
    expect(inWebStaffCorner(5, 60, 1080)).toBe(true);
    expect(inWebStaffCorner(60, 5, 1080)).toBe(true);
    expect(inWebStaffCorner(60, 40, 1080)).toBe(false);
    expect(inWebStaffCorner(540, 900, 1080)).toBe(false);
  });

  it('a press in a corner is stopped at the window; elsewhere it goes on', () => {
    let handler: ((e: { clientX: number; clientY: number; stopPropagation(): void }) => void) | null = null;
    let capture = false;
    guardStaffCorners({
      innerWidth: 800,
      addEventListener: (_t, fn, c) => {
        handler = fn;
        capture = c;
      },
    });
    expect(capture).toBe(true);
    const press = (x: number, y: number) => {
      let stopped = false;
      handler!({ clientX: x, clientY: y, stopPropagation: () => void (stopped = true) });
      return stopped;
    };
    expect(press(790, 10)).toBe(true);
    expect(press(3, 30)).toBe(true);
    expect(press(400, 400)).toBe(false);
  });
});

describe('the APK\'s news', () => {
  it('view, pay and toast reach the kiosk\'s listeners; shell reaches the shell\'s', () => {
    const b = createAndroidBridges(fakeNative().native);
    const pays: PayProgress[] = [];
    const views: unknown[] = [];
    const toasts: unknown[] = [];
    const shells: unknown[] = [];
    const offPay = b.kiosk.on('pay', (p) => pays.push(p));
    b.kiosk.on('view', (v) => views.push(v));
    b.kiosk.on('toast', (t) => toasts.push(t));
    b.shell.on('view', (v) => shells.push(v));
    b.inbox.event('pay', JSON.stringify(fixture.samples.pay));
    b.inbox.event('view', '{"phase":"kiosk"}');
    b.inbox.event('toast', '{"text":"x","tone":"info"}');
    b.inbox.event('shell', '{"role":"kiosk"}');
    expect(pays).toEqual([fixture.samples.pay]);
    expect(views).toEqual([{ phase: 'kiosk' }]);
    expect(toasts).toEqual([{ text: 'x', tone: 'info' }]);
    expect(shells).toEqual([{ role: 'kiosk' }]);
    offPay();
    b.inbox.event('pay', JSON.stringify(fixture.samples.pay));
    expect(pays).toHaveLength(1);
  });

  it('a newer APK\'s unknown news, broken JSON or a failing listener harm nothing', () => {
    const b = createAndroidBridges(fakeNative().native);
    const seen: unknown[] = [];
    b.kiosk.on('view', () => {
      throw new Error('listener');
    });
    b.kiosk.on('view', (v) => seen.push(v));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => b.inbox.event('something_new', '{}')).not.toThrow();
    expect(() => b.inbox.event('view', '{broken')).not.toThrow();
    b.inbox.event('view', '{"ok":1}');
    spy.mockRestore();
    expect(seen).toEqual([{ ok: 1 }]);
  });
});

describe('the APK\'s scanner into the screens', () => {
  it('scan news goes to the scanner hook', () => {
    const codes: string[] = [];
    const b = createAndroidBridges(fakeNative().native, { onScan: (c) => codes.push(c) });
    b.inbox.event('scan', '{"code":"7290000123456"}');
    b.inbox.event('scan', '{"code":""}');
    b.inbox.event('scan', '{}');
    expect(codes).toEqual(['7290000123456']);
  });

  it('a code becomes the keys a USB scanner types, Enter last, GS as Ctrl+]', () => {
    expect(scanKeys('A1')).toEqual([
      { key: 'A', code: '', ctrlKey: false },
      { key: '1', code: '', ctrlKey: false },
      { key: 'Enter', code: 'Enter', ctrlKey: false },
    ]);
    expect(scanKeys('01\u001d21')[2]).toEqual({ key: ']', code: 'BracketRight', ctrlKey: true });
  });

  it('the screens\' own scan reader reads the injected keys back as the very code', () => {
    for (const code of ['7290000123456', 'ABC-123/x', '(01)09506000134352\u001d21ABC', 'שובר1']) {
      const reader = new ScanKeyReader();
      const got: string[] = [];
      let at = 1000;
      const target = {
        dispatchEvent: (e: Event) => {
          const k = (e as unknown as { detail: ScanKey }).detail;
          const out = reader.down({ code: k.code, key: k.key, ctrl: k.ctrlKey, at: (at += 3) });
          if (out) got.push(out);
          return true;
        },
      };
      injectScan(code, target, (k) => ({ detail: k }) as unknown as Event);
      expect(got).toEqual([code]);
    }
  });
});

describe('the view the APK sends', () => {
  const local = (name: string, kind = 'image') => ({ url: `${ANDROID_ORIGIN}/media/${name}`, kind, sha256: null, bytes: null });
  const remote = (name: string, kind = 'image') => ({ url: `https://cdn.example/${name}`, kind, sha256: null, bytes: null });

  it('the cloud\'s config resolved against the screens\' defaults, as the Windows kiosk resolves it', () => {
    const view = normalizeView({ phase: 'kiosk', config: { theme: { uiStyle: 'wolt' } } } as unknown as KioskView);
    const cfg = view.config as unknown as KioskConfig;
    expect(cfg.theme.uiStyle).toBe('wolt');
    expect(cfg.timers.inactivitySec).toBe(KIOSK_DEFAULTS.timers.inactivitySec);
    expect(cfg.general.serviceTypes).toEqual(KIOSK_DEFAULTS.general.serviceTypes);
  });

  it('only media on the device: a remote one is dropped (the screens never reach the network)', () => {
    expect(localMediaOnly({ logo: local('a.png'), bg: remote('b.png'), n: 1 })).toEqual({ logo: local('a.png'), bg: null, n: 1 });
    expect(localMediaOnly([{ media: local('v.mp4', 'video') }, { media: remote('w.mp4', 'video') }, { other: 1 }])).toEqual([{ media: local('v.mp4', 'video') }, { other: 1 }]);
    expect(localMediaOnly({ categoryImages: { c1: local('c1.png'), c2: remote('c2.png') } })).toEqual({ categoryImages: { c1: local('c1.png') } });
    expect(localMediaOnly({ url: 'data:image/png;base64,AA', kind: 'image' })).toEqual({ url: 'data:image/png;base64,AA', kind: 'image' });
  });

  it('bootstrap and later views are normalised; a view with no config is left as it is', async () => {
    const { native, calls } = fakeNative();
    const b = createAndroidBridges(native);
    const p = b.kiosk.bootstrap();
    b.inbox.reply(calls[0].id, true, JSON.stringify({ phase: 'kiosk', config: { theme: { logo: remote('l.png') } } }));
    const v = await p;
    expect((v.config as unknown as KioskConfig).theme.logo).toBeNull();
    const seen: KioskView[] = [];
    b.kiosk.on('view', (x) => seen.push(x));
    b.inbox.event('view', JSON.stringify({ phase: 'waiting', config: null }));
    expect(seen).toEqual([{ phase: 'waiting', config: null }]);
  });
});

describe('errors for the watchdog', () => {
  it('short, readable', () => {
    expect(errorText(new TypeError('x is undefined'))).toBe('TypeError: x is undefined');
    expect(errorText('boom')).toBe('boom');
    expect(errorText({ a: 1 })).toBe('{"a":1}');
    expect(errorText('x'.repeat(900))).toHaveLength(500);
  });
});
