/**
 * "קיוסק — מה נחסם כשאין אינטרנט" (till parameter `kioskOfflineBlockScope`, pos-server till_parameters.py): what
 * "חסימת הזמנות כשאין אינטרנט" (`general.blockWhenOffline`) blocks while the kiosk is offline — `all` (the default:
 * every way to pay, the "offline" rest) or `pay_at_till` (only the till). One rule (core/offlineBlock.ts) for the
 * Windows kiosk (the parameter) and the Android web bundle (the config: the cloud puts a scope other than the
 * default there as `general.offlineBlockScope`).
 */
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  OFFLINE_BLOCK_CONFIG_FIELD,
  OFFLINE_BLOCK_SCOPE_DEFAULT,
  OFFLINE_BLOCK_SCOPE_KEY,
  configOfflineBlockScope,
  offlineBlockScopeOf,
  offlineRests,
  offlineUsable,
} from '../src/core/offlineBlock';
import { ANDROID_NO_CARD_TEXT, createAndroidBridges, normalizeView, type AndroidNative } from '../src/renderer/bridges/android';
import type { PaymentProvider } from '../src/main/payment/provider';
import type { Transport } from '../src/main/printer/transports';
import { KioskService } from '../src/main/service';
import type { KioskView } from '../src/shared/bridge';

describe('the rule', () => {
  it('the scope: the first value that is one, else `all`', () => {
    expect(OFFLINE_BLOCK_SCOPE_KEY).toBe('kioskOfflineBlockScope');
    expect(OFFLINE_BLOCK_CONFIG_FIELD).toBe('offlineBlockScope');
    expect(OFFLINE_BLOCK_SCOPE_DEFAULT).toBe('all');
    expect(offlineBlockScopeOf()).toBe('all');
    expect(offlineBlockScopeOf(undefined, null, 'x', 3)).toBe('all');
    expect(offlineBlockScopeOf('pay_at_till')).toBe('pay_at_till');
    expect(offlineBlockScopeOf(undefined, 'pay_at_till')).toBe('pay_at_till');
    expect(offlineBlockScopeOf('all', 'pay_at_till')).toBe('all');
    expect(configOfflineBlockScope({ general: { offlineBlockScope: 'pay_at_till' } })).toBe('pay_at_till');
    expect(configOfflineBlockScope({ general: {} })).toBeUndefined();
    expect(configOfflineBlockScope(null)).toBeUndefined();
  });

  it('`all` takes every way to pay and rests; `pay_at_till` only the till, and rests only when nothing is left', () => {
    const all = ['card', 'cash_at_till', 'voucher'] as const;
    expect(offlineUsable(all, false, 'all')).toEqual(all);
    expect(offlineUsable(all, true, 'all')).toEqual([]);
    expect(offlineUsable(all, true, 'pay_at_till')).toEqual(['card', 'voucher']);
    expect(offlineRests(false, 'all', [])).toBe(false);
    expect(offlineRests(true, 'all', ['card'])).toBe(true);
    expect(offlineRests(true, 'pay_at_till', ['card'])).toBe(false);
    expect(offlineRests(true, 'pay_at_till', [])).toBe(true);
    expect(offlineRests(true, 'pay_at_till', ['voucher'])).toBe(true);
  });
});

/* ------------------------------------------------------------------ Windows */

const MACHINE = '549e903c-4aba-4528-bc4a-c61b4019a64e';
const noPrinter: Transport = { send: async () => undefined, status: async () => ({ health: 'ok', detail: null }), list: async () => [], dispose: () => undefined };
const offlineFetch: typeof fetch = async () => {
  throw new TypeError('fetch failed');
};
const terminal: PaymentProvider = {
  kind: 'nayax_lan',
  describe: () => ({ kind: 'nayax_lan', address: 'https://10.0.0.5:8080/SPICy' }),
  newReference: () => 'ref1',
  check: async () => ({ ok: true, detail: null }),
  sale: async () => ({ answer: 'UNKNOWN', message: 'timeout', raw: null }),
  resolve: async () => ({ kind: 'unknown', message: 'x' }),
  abort: async () => undefined,
};

const open: KioskService[] = [];
afterEach(() => {
  for (const s of open.splice(0)) s.stop();
});

/** A Windows kiosk set to [methods], "חסימת הזמנות כשאין אינטרנט" on, [offline] or not. */
function windowsKiosk(opts: { methods: string[]; offline: boolean; integration?: string | null; param?: unknown; configScope?: string; block?: boolean }) {
  const svc = new KioskService({
    dataDir: mkdtempSync(path.join(os.tmpdir(), 'kd-offscope-')),
    appVersion: '0.4.2',
    deviceInfo: { platform: 'windows' },
    transport: noPrinter,
    fetch: offlineFetch,
    providers: [() => terminal],
    downloader: async () => {
      throw new Error('no media');
    },
  });
  open.push(svc);
  svc.cloud.setCredentials({ serverUrl: 'http://localhost:8001', accessToken: 't', machineId: MACHINE, machineCode: null, tenantId: null, shopId: null, mqttClientId: null, realtimeChannel: null, pairedAt: '' });
  svc.api.setBase('http://localhost:8001');
  svc.cloud.setMachine({ machineId: MACHINE, machineName: 'קיוסק Windows', posNumber: '4' });
  const general: Record<string, unknown> = { blockWhenOffline: opts.block ?? true };
  if (opts.configScope) general.offlineBlockScope = opts.configScope;
  svc.cloud.setKioskSnapshot({
    kiosk: true,
    configVersion: 'v1',
    operator: { id: `kiosk:${MACHINE}`, name: 'קיוסק Windows' },
    config: { general, payment: { methods: opts.methods }, pickup: { scope: 'kiosk', prefix: 'K', start: 1, max: 99 } },
  });
  svc.cloud.setSettings({ settings: opts.integration ? { paymentIntegration: opts.integration } : {}, businessInfo: null, settingsUpdatedAt: '2026-10-14T09:00:00Z', serverTime: null });
  if (opts.param !== undefined) svc.cloud.setParameters({ [OFFLINE_BLOCK_SCOPE_KEY]: opts.param }, null);
  svc.applyProvider();
  const inner = svc as unknown as { offlineNow: boolean; viewDirty: boolean };
  inner.offlineNow = opts.offline;
  inner.viewDirty = true;
  return svc.view();
}

describe('the Windows kiosk', () => {
  const methods = ['card', 'cash_at_till', 'voucher'];

  it('`all` (the default, no parameter): offline with the block, nothing to take — the "offline" rest', () => {
    const view = windowsKiosk({ methods, offline: true });
    expect(view.pay.usable).toEqual([]);
    expect(view.state.noPayment).toBe(true);
    expect(view.state.noPaymentReason).toBe('offline');
    expect(windowsKiosk({ methods, offline: true, param: 'all' }).pay.usable).toEqual([]);
  });

  it('`pay_at_till`: only the till is blocked — the card goes on, no rest', () => {
    const view = windowsKiosk({ methods, offline: true, param: 'pay_at_till' });
    // The voucher needs the cloud (offline: never usable on Windows); the till is the block's.
    expect(view.pay.usable).toEqual(['card']);
    expect(view.state.noPayment).toBe(false);
    expect(view.state.noPaymentReason).toBeNull();
    // From the config, when the parameter has not come (the cloud's kiosk/sync carries it too).
    expect(windowsKiosk({ methods, offline: true, configScope: 'pay_at_till' }).pay.usable).toEqual(['card']);
    // The parameter wins over the config.
    expect(windowsKiosk({ methods, offline: true, param: 'all', configScope: 'pay_at_till' }).pay.usable).toEqual([]);
  });

  it('`pay_at_till` on "ללא אשראי": the till was all there was — the "offline" rest', () => {
    const view = windowsKiosk({ methods: ['cash_at_till', 'voucher'], offline: true, integration: 'none', param: 'pay_at_till' });
    expect(view.pay.usable).toEqual([]);
    expect(view.state.noPayment).toBe(true);
    expect(view.state.noPaymentReason).toBe('offline');
  });

  it('online, or without the block: the scope changes nothing', () => {
    for (const param of ['all', 'pay_at_till']) {
      expect(windowsKiosk({ methods, offline: false, param }).pay.usable).toEqual(['card', 'cash_at_till', 'voucher']);
      const unblocked = windowsKiosk({ methods, offline: true, param, block: false });
      expect(unblocked.pay.usable).toEqual(['card', 'cash_at_till']);
      expect(unblocked.state.noPayment).toBe(false);
    }
  });
});

/* ------------------------------------------------------------------ Android */

describe('the Android web bundle', () => {
  const NO_CARD = { paused: false, pausedMessage: null, pausedUntil: null, noPayment: true, terminal: 'no_card', offline: true, offlineSince: null, cardBlocked: false };
  const READY = { ...NO_CARD, noPayment: false, terminal: 'ready' };
  /** The APK's view: the cloud's config as it came (with `general.offlineBlockScope` when the scope is not the default). */
  const apkView = (methods: string[], state: Record<string, unknown>, scope?: string, block = true) =>
    ({ phase: 'kiosk', config: { payment: { methods }, general: { blockWhenOffline: block, ...(scope ? { offlineBlockScope: scope } : {}) } }, state }) as unknown as KioskView;
  const fake = (api: number): AndroidNative => ({ bridgeApi: () => api, call: () => undefined, send: () => undefined });

  it('`all` (the default): nothing to take, the "offline" words — on API 2 and on API 1', () => {
    for (const payAtTill of [true, false]) {
      const view = normalizeView(apkView(['card', 'cash_at_till', 'voucher'], READY), { payAtTill });
      expect(view.pay.usable).toEqual([]);
      expect(view.state.noPayment).toBe(true);
      expect(view.state.noPaymentReason).toBe('offline');
    }
  });

  it('`pay_at_till`: the till alone is blocked — on API 2 the card and the voucher it finishes stay', () => {
    const view = normalizeView(apkView(['card', 'cash_at_till', 'voucher'], READY, 'pay_at_till'), { payAtTill: true });
    expect(view.pay).toEqual({ methods: ['card', 'cash_at_till', 'voucher'], usable: ['card', 'voucher'], cardOff: null });
    expect(view.state.noPaymentReason).toBeUndefined();
    // API 1 (no till here at all): the card as it was.
    expect(normalizeView(apkView(['card', 'cash_at_till'], READY, 'pay_at_till')).pay.usable).toEqual(['card']);
    // "ללא אשראי": the till was all there was — the "offline" rest.
    const noCard = normalizeView(apkView(['cash_at_till', 'voucher'], NO_CARD, 'pay_at_till'), { payAtTill: true });
    expect(noCard.pay).toEqual({ methods: ['cash_at_till', 'voucher'], usable: [], cardOff: ANDROID_NO_CARD_TEXT });
    expect(noCard.state.noPaymentReason).toBe('offline');
  });

  it('online, or without the block: the scope changes nothing', () => {
    const online = { ...READY, offline: false };
    for (const scope of [undefined, 'pay_at_till']) {
      expect(normalizeView(apkView(['card', 'cash_at_till'], online, scope), { payAtTill: true }).pay.usable).toEqual(['card', 'cash_at_till']);
      const unblocked = normalizeView(apkView(['card', 'cash_at_till'], READY, scope, false), { payAtTill: true });
      expect(unblocked.pay.usable).toEqual(['card', 'cash_at_till']);
      expect(unblocked.state.noPaymentReason).toBeUndefined();
    }
  });

  it('through the bridge: the APK\'s views carry it', async () => {
    const b = createAndroidBridges(fake(2));
    const seen: KioskView[] = [];
    b.kiosk.on('view', (v) => seen.push(v));
    b.inbox.event('view', JSON.stringify(apkView(['card', 'cash_at_till'], READY)));
    b.inbox.event('view', JSON.stringify(apkView(['card', 'cash_at_till'], READY, 'pay_at_till')));
    expect(seen.map((v) => v.pay.usable)).toEqual([[], ['card']]);
  });
});
