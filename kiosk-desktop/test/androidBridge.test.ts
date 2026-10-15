import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ANDROID_BRIDGE_API,
  ANDROID_CALLS,
  ANDROID_EVENTS,
  ANDROID_NO_CARD_TEXT,
  ANDROID_ORIGIN,
  ANDROID_PLACE_OPEN_ORDER_API,
  ANDROID_SENDS,
  ANDROID_WIRE_API,
  CALL_TIMEOUT_MS,
  NATIVE_STAFF,
  PAY_NO_ANSWER,
  PLACE_NO_ANSWER,
  androidNoCard,
  apkPlacesOpenOrders,
  apkSupports,
  createAndroidBridges,
  errorText,
  guardStaffCorners,
  inWebStaffCorner,
  injectScan,
  localMediaOnly,
  normalizeView,
  payOf,
  placeAnswerOf,
  scanKeys,
  voucherAnswerOf,
  type AndroidNative,
  type ScanKey,
} from '../src/renderer/bridges/android';
import { ScanKeyReader } from '../src/core/kioskScan';
import { KIOSK_DEFAULTS, kioskPayChooser, type KioskConfig } from '@dash-lib/kioskConfig';
import type { KioskView, PayProgress, PlaceOrderIn, StartPaymentIn, StartPaymentOut, VoucherAnswer, VoucherApplyIn } from '../src/shared/bridge';
import { INITIAL_FLOW, reduce, restingScreen, type KioskEvent, type KioskFlowRules } from '../src/core/kioskFlow';

const fixture = JSON.parse(readFileSync(path.join(__dirname, 'fixtures/android_bridge_api.json'), 'utf8')) as {
  bridgeApi: number;
  calls: string[];
  sends: string[];
  events: string[];
  samples: {
    startPayment: StartPaymentIn;
    pay: PayProgress;
    startPaymentChanged: StartPaymentOut;
    reportFlow: Record<string, unknown>;
    voucherApply: VoucherApplyIn;
    voucherRemove: { serial: number };
    voucherAnswer: VoucherAnswer;
    placeOpenOrder: PlaceOrderIn;
    placeOpenOrderOk: Record<string, unknown>;
    placeOpenOrderRefused: { ok: false; reason: string; message: string };
  };
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

describe('the Android bridge speaks the pinned wire (bridgeApi 2, runs on 1)', () => {
  it('every name is the fixture shared with pos-android', () => {
    expect(ANDROID_WIRE_API).toBe(fixture.bridgeApi);
    expect([...ANDROID_CALLS]).toEqual(fixture.calls);
    expect([...ANDROID_SENDS]).toEqual(fixture.sends);
    expect([...ANDROID_EVENTS]).toEqual(fixture.events);
    expect(ANDROID_CALLS).toContain('placeOpenOrder');
    expect(ANDROID_PLACE_OPEN_ORDER_API).toBe(2);
    // Every call has its own wait.
    for (const c of ANDROID_CALLS) expect(CALL_TIMEOUT_MS[c]).toBeGreaterThan(0);
  });

  it('the bundle still needs only API 1 (its manifest): an APK of API 1 keeps running it, without the till', () => {
    expect(ANDROID_BRIDGE_API).toBe(1);
    expect(ANDROID_BRIDGE_API).toBeLessThan(ANDROID_WIRE_API);
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

  it('cash stage 2 (§11.15): the owed choice and "להשלים באשראי" — their arguments, never a rejection', async () => {
    expect(fixture.calls).toEqual(expect.arrayContaining(['cashOwedChoice', 'cashSplit']));
    const { native, calls } = fakeNative(2);
    const b = createAndroidBridges(native);
    const choice = b.kiosk.cashOwedChoice!('tip');
    const split = b.kiosk.cashSplit!();
    const refused = b.kiosk.cashSplit!();
    const broken = b.kiosk.cashOwedChoice!('credit');
    expect(calls.map((x) => [x.method, x.args])).toEqual([
      ['cashOwedChoice', { choice: 'tip' }],
      ['cashSplit', {}],
      ['cashSplit', {}],
      ['cashOwedChoice', { choice: 'credit' }],
    ]);
    b.inbox.reply(calls[0].id, true, 'null');
    b.inbox.reply(calls[1].id, true, '{"ok":true}');
    b.inbox.reply(calls[2].id, true, '{"ok":false}');
    b.inbox.reply(calls[3].id, false, '"unknown call cashOwedChoice"');
    await expect(Promise.all([choice, split, refused, broken])).resolves.toEqual([undefined, { ok: true }, { ok: false }, undefined]);
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

describe('production vouchers: the APK holds them ("שוברי הפקה")', () => {
  it('voucherApply sends the code and the basket as they are; the answer is the order\'s vouchers now', async () => {
    const { native, calls } = fakeNative();
    const b = createAndroidBridges(native);
    const p = b.kiosk.voucherApply!(fixture.samples.voucherApply);
    expect(calls.map((c) => [c.method, c.args])).toEqual([['voucherApply', fixture.samples.voucherApply]]);
    b.inbox.reply(calls[0].id, true, JSON.stringify(fixture.samples.voucherAnswer));
    // The owner's layout: ₪50, the voucher's ₪40 off (and what it covered), ₪10 to pay.
    await expect(p).resolves.toEqual(fixture.samples.voucherAnswer);
  });

  it('voucherRemove sends the serial; a refusal is an answer with the APK\'s words and the vouchers as they stand', async () => {
    const { native, calls } = fakeNative();
    const b = createAndroidBridges(native);
    const p = b.kiosk.voucherRemove!(fixture.samples.voucherRemove.serial);
    expect(calls.map((c) => [c.method, c.args])).toEqual([['voucherRemove', fixture.samples.voucherRemove]]);
    const refused = { ok: false, error: 'ניתן לממש שובר אחד בלבד בעסקה', note: null, totalAgorot: null, deductionAgorot: 0, dueAgorot: 5000, vouchers: [] };
    b.inbox.reply(calls[0].id, true, JSON.stringify(refused));
    await expect(p).resolves.toEqual(refused);
  });

  it('never a rejection: no answer, a refusal or a broken APK is null (the screens keep what they had)', async () => {
    vi.useFakeTimers();
    const { native, calls } = fakeNative();
    const b = createAndroidBridges(native, { timeouts: { voucherApply: 1000 } });
    const silent = b.kiosk.voucherApply!(fixture.samples.voucherApply);
    vi.advanceTimersByTime(1001);
    await expect(silent).resolves.toBeNull();
    const refused = b.kiosk.voucherRemove!(8);
    b.inbox.reply(calls[1].id, false, '"unknown method"');
    await expect(refused).resolves.toBeNull();
    const broken = createAndroidBridges({ ...native, call: () => { throw new Error('gone'); } });
    await expect(broken.kiosk.voucherApply!(fixture.samples.voucherApply)).resolves.toBeNull();
    expect(b.pending()).toBe(0);
  });

  it('an answer not of the answer\'s shape is no answer; a missing title or line is filled, never shown broken', () => {
    expect(voucherAnswerOf(null)).toBeNull();
    expect(voucherAnswerOf({ ok: true })).toBeNull();
    expect(voucherAnswerOf({ ok: true, dueAgorot: 100, vouchers: [{ serial: 'x', amountAgorot: 1 }] })).toBeNull();
    expect(voucherAnswerOf({ ok: true, dueAgorot: -5, deductionAgorot: null, vouchers: [{ serial: 8, amountAgorot: 4000, lines: ['מנה ×1', 3, ''] }] })).toEqual({
      ok: true,
      error: null,
      note: null,
      totalAgorot: null,
      deductionAgorot: 0,
      dueAgorot: 0,
      vouchers: [{ serial: 8, title: 'שובר מס׳ 0008', mode: 'payment', amountAgorot: 4000, lines: ['מנה ×1'] }],
    });
    // "ok" with an error is not ok.
    expect(voucherAnswerOf({ ok: true, error: 'השובר כבר מומש', dueAgorot: 5000, vouchers: [] })?.ok).toBe(false);
  });

  it('the view: the voucher tile where the kiosk takes one, the card alone otherwise', () => {
    const pay = (methods: string[]) => normalizeView({ phase: 'kiosk', config: { payment: { methods } } } as unknown as KioskView).pay;
    expect(pay(['card', 'voucher'])).toEqual({ methods: ['card', 'voucher'], usable: ['card', 'voucher'], cardOff: null });
    expect(pay(['voucher', 'cash_at_till', 'card'])).toEqual({ methods: ['card', 'voucher'], usable: ['card', 'voucher'], cardOff: null });
    expect(pay(['card', 'cash_at_till'])).toEqual({ methods: ['card'], usable: ['card'], cardOff: null });
    const own = { methods: ['card'], usable: [], cardOff: 'x' };
    expect(normalizeView({ phase: 'kiosk', config: {}, pay: own } as unknown as KioskView).pay).toEqual(own);
  });

  it('"ללא אשראי": the APK\'s terminal `no_card` is no card at all and no terminal fault', () => {
    // pos-android KioskWebSnapshot: `state.terminal` "no_card", `noPayment` true, the config's methods without the card.
    const view = (methods: string[], terminal = 'no_card') =>
      normalizeView({
        phase: 'kiosk',
        config: { payment: { methods } },
        state: { paused: false, pausedMessage: null, pausedUntil: null, noPayment: true, terminal, offline: false, offlineSince: null, cardBlocked: false },
      } as unknown as KioskView);
    expect(androidNoCard(view(['cash_at_till']))).toBe(true);
    expect(androidNoCard(view(['card'], 'ready'))).toBe(false);
    // No card tile, not even one shown off; the card's line says why, never "the terminal is not available".
    for (const methods of [['cash_at_till'], ['cash_at_till', 'voucher'], ['voucher'], []]) {
      const pay = view(methods).pay;
      expect(pay.methods).not.toContain('card');
      expect(pay.usable).not.toContain('card');
      expect(pay.cardOff).toBe(ANDROID_NO_CARD_TEXT);
    }
    // The voucher stays a tile where the kiosk takes one; with no card and no till here it cannot finish an order.
    expect(view(['cash_at_till', 'voucher']).pay).toEqual({ methods: ['voucher'], usable: [], cardOff: ANDROID_NO_CARD_TEXT });
    // Nothing usable: no way to pay is asked or fallen back to — the screens rest ("no payment"), never a card charge.
    const cfg = { ...KIOSK_DEFAULTS, payment: { ...KIOSK_DEFAULTS.payment, methods: ['cash_at_till', 'voucher'] } } as KioskConfig;
    const pay = view(['cash_at_till', 'voucher']).pay;
    expect(kioskPayChooser(cfg, pay.methods, pay.usable).fallback).toBeNull();
    const rules: KioskFlowRules = { services: ['take_away'], skipCart: 'off', asksDetails: () => false, cartEmpty: true, detailsStep: 'before_pay', asksPayMethod: false };
    let s = reduce(INITIAL_FLOW, { type: 'ready', ready: true }, rules);
    s = reduce(s, { type: 'terminal', canCharge: kioskPayChooser(cfg, pay.methods, pay.usable).fallback !== null }, rules);
    expect(restingScreen(s)).toBe('no_payment');
    // Any other terminal state keeps the card as before.
    expect(view(['card', 'voucher'], 'unreachable').pay).toEqual({ methods: ['card', 'voucher'], usable: ['card', 'voucher'], cardOff: null });
  });

  it('the checkout reports "details" and the charge "pay" — the APK keeps the vouchers there, "cart" gives them back', () => {
    const rules: KioskFlowRules = { services: ['take_away'], skipCart: 'off', asksDetails: () => false, cartEmpty: false, detailsStep: 'before_pay', asksPayMethod: true };
    const run = (...events: KioskEvent[]) => events.reduce((s, e) => reduce(s, e, rules), INITIAL_FLOW);
    const toPayMethod: KioskEvent[] = [{ type: 'start' }, { type: 'openCart' }, { type: 'checkout' }];
    expect(run(...toPayMethod)).toMatchObject({ screen: 'details', detailsNext: 'pay' });
    expect(run(...toPayMethod, { type: 'detailsDone' })).toMatchObject({ screen: 'pay' });
    // Declined, or back from the charge: the checkout again — the vouchers stay.
    expect(run(...toPayMethod, { type: 'detailsDone' }, { type: 'paymentStarted' }, { type: 'paymentDeclined' })).toMatchObject({ screen: 'pay' });
    expect(run(...toPayMethod, { type: 'detailsDone' }, { type: 'back' })).toMatchObject({ screen: 'details', detailsNext: 'pay' });
    // Back out of the checkout: the basket — the APK gives them back.
    expect(run(...toPayMethod, { type: 'back' })).toMatchObject({ screen: 'cart' });
    const { native, sends } = fakeNative();
    const b = createAndroidBridges(native);
    b.kiosk.reportFlow({ flowState: 'ordering', screen: run(...toPayMethod).screen, busy: false, idle: false });
    expect(sends).toEqual([{ method: 'reportFlow', payload: { flowState: 'ordering', screen: 'details', busy: false, idle: false } }]);
  });
});

describe('"תשלום בקופה" through the APK (bridgeApi 2: placeOpenOrder)', () => {
  const NO_CARD_STATE = { paused: false, pausedMessage: null, pausedUntil: null, noPayment: true, terminal: 'no_card', offline: false, offlineSince: null, cardBlocked: false };
  /** The APK's view (pos-android KioskWebSnapshot): "ללא אשראי" sends the config's methods without the card. */
  const apkView = (methods: string[], state: Record<string, unknown> = NO_CARD_STATE, general: Record<string, unknown> = {}) =>
    ({ phase: 'kiosk', config: { payment: { methods }, general }, state }) as unknown as KioskView;
  const cfgOf = (methods: string[]) => ({ ...KIOSK_DEFAULTS, payment: { ...KIOSK_DEFAULTS.payment, methods } }) as KioskConfig;
  /** Where the screens rest with this view's ways to pay (KioskApp: it sells while one of them can take the money). */
  const restsOn = (pay: KioskView['pay'], methods: string[]) => {
    const rules: KioskFlowRules = { services: ['take_away'], skipCart: 'off', asksDetails: () => false, cartEmpty: true, detailsStep: 'before_pay', asksPayMethod: false };
    let s = reduce(INITIAL_FLOW, { type: 'ready', ready: true }, rules);
    s = reduce(s, { type: 'terminal', canCharge: kioskPayChooser(cfgOf(methods), pay.methods, pay.usable).fallback !== null }, rules);
    return restingScreen(s);
  };
  /** The view as the bridge over an APK of [api] hands it to the screens (bootstrap). */
  const bootView = async (api: number, view: KioskView) => {
    const { native, calls } = fakeNative(api);
    const b = createAndroidBridges(native);
    const p = b.kiosk.bootstrap();
    b.inbox.reply(calls[0].id, true, JSON.stringify(view));
    return { view: await p, bridges: b };
  };

  it('feature detection: `R2MAndroid.bridgeApi()` of 2 or more, nothing else', () => {
    expect(apkPlacesOpenOrders(fakeNative(2).native)).toBe(true);
    expect(apkPlacesOpenOrders(fakeNative(3).native)).toBe(true);
    expect(apkPlacesOpenOrders(fakeNative(1).native)).toBe(false);
    expect(apkPlacesOpenOrders({})).toBe(false);
    expect(apkPlacesOpenOrders({ bridgeApi: 2 })).toBe(false);
    expect(apkPlacesOpenOrders({ bridgeApi: () => '2' })).toBe(false);
    expect(apkPlacesOpenOrders({ bridgeApi: () => Number.NaN })).toBe(false);
    expect(
      apkPlacesOpenOrders({
        bridgeApi: () => {
          throw new Error('gone');
        },
      }),
    ).toBe(false);
    expect(apkPlacesOpenOrders(null)).toBe(false);
    // The call is there only where the APK speaks it: the screens offer the till only then (KioskApp reads `placeOpenOrder`).
    expect(createAndroidBridges(fakeNative(2).native).kiosk.placeOpenOrder).toBeTypeOf('function');
    expect(createAndroidBridges(fakeNative(1).native).kiosk.placeOpenOrder).toBeUndefined();
    const { native } = fakeNative(1);
    expect(createAndroidBridges({ call: native.call, send: native.send } as unknown as AndroidNative).kiosk.placeOpenOrder).toBeUndefined();
  });

  it('placed: the screens\' order as the fixture sends it; the answer is the Windows kiosk\'s PlaceOrder result', async () => {
    const { native, calls } = fakeNative(2);
    const b = createAndroidBridges(native);
    const p = b.kiosk.placeOpenOrder!(fixture.samples.placeOpenOrder);
    expect(calls.map((c) => [c.method, c.args])).toEqual([['placeOpenOrder', fixture.samples.placeOpenOrder]]);
    b.inbox.reply(calls[0].id, true, JSON.stringify(fixture.samples.placeOpenOrderOk));
    // What KioskApp's success ("גשו לקופה לתשלום") reads: the number, what the till collects, the code, the vouchers.
    await expect(p).resolves.toEqual({ ok: true, localId: 'order-2', pickupLabel: 'A18', vouchers: [], dueAgorot: 5200, pending: false, code: 'KO:order-2' });
    expect(b.pending()).toBe(0);
    // No vouchers / discounts given: sent as empty lists, as the contract has them.
    const bare = { ...fixture.samples.placeOpenOrder } as Partial<PlaceOrderIn>;
    delete bare.vouchers;
    delete bare.discounts;
    void b.kiosk.placeOpenOrder!(bare as PlaceOrderIn);
    expect(calls[1].args).toEqual(fixture.samples.placeOpenOrder);
  });

  it('placed: the vouchers the APK took with it, its number, waiting for the tills', () => {
    expect(
      placeAnswerOf({
        ok: true,
        localId: 'order-3',
        orderNumber: 'A19',
        vouchers: [{ redemptionId: 'r-1', serial: 8, amountAgorot: 4000 }, { serial: 'x' }],
        dueAgorot: 1000,
        pending: true,
        code: 'KO:order-3',
      }),
    ).toEqual({
      ok: true,
      localId: 'order-3',
      pickupLabel: 'A19',
      vouchers: [{ redemptionId: 'r-1', serial: 8, amountAgorot: 4000, eventName: null, redeemed: [] }],
      dueAgorot: 1000,
      pending: true,
      code: 'KO:order-3',
    });
    // "ok" with no order in it is not placed (the customer is told; nothing claims a number).
    expect(placeAnswerOf({ ok: true, dueAgorot: 100 })).toEqual({ ok: false, reason: 'error', message: PLACE_NO_ANSWER });
    expect(placeAnswerOf({ ok: true, localId: 'order-4' })).toEqual({ ok: false, reason: 'error', message: PLACE_NO_ANSWER });
    expect(placeAnswerOf({ ok: true, localId: 'order-4', dueAgorot: 0 })).toMatchObject({ ok: true, pickupLabel: '', code: 'KO:order-4' });
  });

  it('changed: the basket\'s changes and the total now, as startPayment\'s (the screens confirm before anything goes)', async () => {
    const { native, calls } = fakeNative(2);
    const b = createAndroidBridges(native);
    const p = b.kiosk.placeOpenOrder!(fixture.samples.placeOpenOrder);
    b.inbox.reply(calls[0].id, true, JSON.stringify(fixture.samples.startPaymentChanged));
    await expect(p).resolves.toEqual(fixture.samples.startPaymentChanged);
    // A price that only went up (no line changed): the new total alone.
    expect(placeAnswerOf({ ok: false, reason: 'changed', changes: [], totalAgorot: 5400 })).toEqual({ ok: false, reason: 'changed', changes: [], totalAgorot: 5400 });
    // A broken change is dropped, never shown broken.
    expect(placeAnswerOf({ ok: false, reason: 'changed', changes: [{ kind: 'repriced', productId: 'p' }, null] })).toEqual({ ok: false, reason: 'changed', changes: [] });
  });

  it('refused: the APK\'s words; no answer, a refusal of the call or a broken APK is "not placed" — never a rejection', async () => {
    vi.useFakeTimers();
    const { native, calls } = fakeNative(2);
    const b = createAndroidBridges(native, { timeouts: { placeOpenOrder: 1000 } });
    const refused = b.kiosk.placeOpenOrder!(fixture.samples.placeOpenOrder);
    b.inbox.reply(calls[0].id, true, JSON.stringify(fixture.samples.placeOpenOrderRefused));
    await expect(refused).resolves.toEqual({ ok: false, reason: 'error', message: 'תשלום בקופה אינו מוגדר לקיוסק' });
    for (const reason of ['empty', 'rejected'] as const) {
      expect(placeAnswerOf({ ok: false, reason, message: 'x' })).toEqual({ ok: false, reason, message: 'x' });
    }
    expect(placeAnswerOf({ ok: false, reason: 'something_new' })).toEqual({ ok: false, reason: 'error', message: PLACE_NO_ANSWER });
    expect(placeAnswerOf(null)).toEqual({ ok: false, reason: 'error', message: PLACE_NO_ANSWER });
    const silent = b.kiosk.placeOpenOrder!(fixture.samples.placeOpenOrder);
    vi.advanceTimersByTime(1001);
    await expect(silent).resolves.toEqual({ ok: false, reason: 'error', message: PLACE_NO_ANSWER });
    const unknown = b.kiosk.placeOpenOrder!(fixture.samples.placeOpenOrder);
    b.inbox.reply(calls[2].id, false, '"unknown call placeOpenOrder"');
    await expect(unknown).resolves.toEqual({ ok: false, reason: 'error', message: PLACE_NO_ANSWER });
    const broken = createAndroidBridges({
      ...native,
      call: () => {
        throw new Error('gone');
      },
    });
    await expect(broken.kiosk.placeOpenOrder!(fixture.samples.placeOpenOrder)).resolves.toEqual({ ok: false, reason: 'error', message: PLACE_NO_ANSWER });
    expect(b.pending()).toBe(0);
  });

  it('"ללא אשראי" with pay at the till offered: "תשלום בקופה" is the way to pay, and the kiosk sells', async () => {
    const { view, bridges } = await bootView(2, apkView(['cash_at_till']));
    expect(view.pay).toEqual({ methods: ['cash_at_till'], usable: ['cash_at_till'], cardOff: ANDROID_NO_CARD_TEXT });
    expect(kioskPayChooser(cfgOf(['cash_at_till']), view.pay.methods, view.pay.usable).fallback).toBe('cash_at_till');
    expect(restsOn(view.pay, ['cash_at_till'])).toBe('attract');
    // With a voucher: it can be finished at the till now — both offered, never the card.
    const both = (await bootView(2, apkView(['cash_at_till', 'voucher']))).view.pay;
    expect(both).toEqual({ methods: ['cash_at_till', 'voucher'], usable: ['cash_at_till', 'voucher'], cardOff: ANDROID_NO_CARD_TEXT });
    // The APK's later views too.
    const seen: KioskView[] = [];
    bridges.kiosk.on('view', (v) => seen.push(v));
    bridges.inbox.event('view', JSON.stringify(apkView(['voucher', 'cash_at_till'])));
    expect(seen[0].pay).toEqual({ methods: ['voucher', 'cash_at_till'], usable: ['voucher', 'cash_at_till'], cardOff: ANDROID_NO_CARD_TEXT });
    // Not offered (no "cash_at_till" configured): as before — nothing to sell by, the "no payment" rest.
    const none = (await bootView(2, apkView(['voucher']))).view.pay;
    expect(none).toEqual({ methods: ['voucher'], usable: [], cardOff: ANDROID_NO_CARD_TEXT });
    expect(restsOn(none, ['voucher'])).toBe('no_payment');
    // "חסימת הזמנות כשאין אינטרנט", offline: no order to the till either.
    const blocked = (await bootView(2, apkView(['cash_at_till', 'voucher'], { ...NO_CARD_STATE, offline: true }, { blockWhenOffline: true }))).view.pay;
    expect(blocked.usable).toEqual([]);
    expect(restsOn(blocked, ['cash_at_till', 'voucher'])).toBe('no_payment');
    // Offline without the block: the till still takes it.
    expect((await bootView(2, apkView(['cash_at_till'], { ...NO_CARD_STATE, offline: true }))).view.pay.usable).toEqual(['cash_at_till']);
  });

  it('a card kiosk on API 2: the till beside the card, in the configured order, as on Windows', async () => {
    const READY = { ...NO_CARD_STATE, noPayment: false, terminal: 'ready' };
    expect((await bootView(2, apkView(['card', 'cash_at_till'], READY))).view.pay).toEqual({ methods: ['card', 'cash_at_till'], usable: ['card', 'cash_at_till'], cardOff: null });
    expect((await bootView(2, apkView(['voucher', 'cash_at_till', 'card'], READY))).view.pay).toEqual({
      methods: ['voucher', 'cash_at_till', 'card'],
      usable: ['voucher', 'cash_at_till', 'card'],
      cardOff: null,
    });
    // Without the till configured: exactly as on API 1.
    expect((await bootView(2, apkView(['card', 'voucher'], READY))).view.pay).toEqual({ methods: ['card', 'voucher'], usable: ['card', 'voucher'], cardOff: null });
    expect((await bootView(2, apkView(['card'], READY))).view.pay).toEqual({ methods: ['card'], usable: ['card'], cardOff: null });
  });

  it('an APK of API 1: today\'s behaviour — no till, a "ללא אשראי" kiosk rests on "no payment"', async () => {
    const { view, bridges } = await bootView(1, apkView(['cash_at_till', 'voucher']));
    expect(bridges.kiosk.placeOpenOrder).toBeUndefined();
    expect(view.pay).toEqual({ methods: ['voucher'], usable: [], cardOff: ANDROID_NO_CARD_TEXT });
    expect(restsOn(view.pay, ['cash_at_till', 'voucher'])).toBe('no_payment');
    const READY = { ...NO_CARD_STATE, noPayment: false, terminal: 'ready' };
    expect((await bootView(1, apkView(['card', 'cash_at_till'], READY))).view.pay).toEqual({ methods: ['card'], usable: ['card'], cardOff: null });
    // A view that already carries its own ways to pay is kept, whichever the API.
    const own = { methods: ['card'], usable: [], cardOff: 'x' };
    expect((await bootView(2, { ...apkView(['cash_at_till']), pay: own } as unknown as KioskView)).view.pay).toEqual(own);
  });

  it('the checkout with the till: details → "לתשלום" → placed is the success; refused or changed is back on the payment', () => {
    // KioskApp's startPayment on "cash_at_till": paymentStarted, then placeOpenOrder's answer — placed → paymentApproved
    // (the success shows the number), anything else → paymentDeclined (the message, or the basket's changes).
    const rules: KioskFlowRules = { services: ['take_away'], skipCart: 'off', asksDetails: () => false, cartEmpty: false, detailsStep: 'before_pay', asksPayMethod: true };
    const run = (...events: KioskEvent[]) => events.reduce((s, e) => reduce(s, e, rules), INITIAL_FLOW);
    const toPay: KioskEvent[] = [{ type: 'start' }, { type: 'openCart' }, { type: 'checkout' }, { type: 'detailsDone' }, { type: 'paymentStarted' }];
    expect(run(...toPay)).toMatchObject({ screen: 'pay', pay: 'starting' });
    expect(run(...toPay, { type: 'paymentApproved' })).toMatchObject({ screen: 'success', pay: 'approved' });
    expect(run(...toPay, { type: 'paymentDeclined' })).toMatchObject({ screen: 'pay', pay: 'declined' });
    // Back to the start once the success is done: the APK clears its own success on "attract".
    expect(run(...toPay, { type: 'paymentApproved' }, { type: 'successDone' })).toMatchObject({ screen: 'attract', pay: 'idle' });
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

  it("the corners: the admin's top-right square (96, the APK's KioskAdminCorner) and the technician's top-left strip", () => {
    expect(inWebStaffCorner(1050, 10, 1080)).toBe(true);
    expect(inWebStaffCorner(1033, 47, 1080)).toBe(true);
    expect(inWebStaffCorner(1000, 10, 1080)).toBe(true);
    expect(inWebStaffCorner(1050, 90, 1080)).toBe(true);
    expect(inWebStaffCorner(980, 10, 1080)).toBe(false);
    expect(inWebStaffCorner(1050, 100, 1080)).toBe(false);
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

  it('the pay event\'s cash, stage 2: the card\'s part of a split as the screens name it; the choices and the split as they came', () => {
    const b = createAndroidBridges(fakeNative(2).native);
    const pays: PayProgress[] = [];
    b.kiosk.on('pay', (p) => pays.push(p));
    const base = { orderId: 'o-1', phase: 'charging', message: null, amountAgorot: 7470, canCancel: true, cancelling: false };
    const insert = { stage: 'insert', insertedAgorot: 2000, dueAgorot: 7470, canSplit: true, splitRestAgorot: 5470 };
    const split = { stage: 'split_card', splitAgorot: 2000, cardAgorot: 5470, insertedAgorot: 2000, dueAgorot: 2000 };
    const owed = { stage: 'owed_choice', owedChoices: ['slip', 'tip'], owedDeadlineAt: 1791364212000, changeOwedAgorot: 1300 };
    for (const cash of [insert, split, owed]) b.inbox.event('pay', JSON.stringify({ ...base, cash }));
    expect(pays.map((p) => p.cash)).toEqual([insert, { ...split, cardRestAgorot: 5470 }, owed]);
    // Nothing to map, or no cash at all: as it came.
    expect(payOf({ ...base, cash: null })).toEqual({ ...base, cash: null });
    expect(payOf(fixture.samples.pay)).toEqual(fixture.samples.pay);
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
