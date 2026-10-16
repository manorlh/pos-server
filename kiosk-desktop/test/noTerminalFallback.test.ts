/**
 * "קיוסק — כשאין מסופון אשראי" (till parameter `kioskNoTerminalFallback`, pos-server till_parameters.py; the owner 16.10.2026:
 * "גם אם אין מסופון שיעלה"): with no terminal to charge on — none set up, or one that does not answer — and nothing else that
 * pays, the kiosk still opens and offers "תשלום בקופה" (`pay_at_till`, the default); `block` keeps the "no payment" rest.
 *
 * One rule (core/noTerminalFallback.ts), pinned by `no_terminal_fallback_golden.json` — byte-equal with pos-android's
 * (app/src/test/resources; KioskTillFallbackTest pins the same SHA-256). The Windows kiosk end to end: offlineKiosk.test.ts
 * §7. Here: the rule, and the Android web bundle (renderer/bridges/android.ts normalizeView) over an APK of bridge API 2.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { KIOSK_DEFAULTS, kioskPayChooser, type KioskConfig, type PaymentMethod } from '@dash-lib/kioskConfig';
import {
  CARD_FALLBACK_TEXT,
  NO_TERMINAL_FALLBACK_CONFIG_FIELD,
  NO_TERMINAL_FALLBACK_DEFAULT,
  NO_TERMINAL_FALLBACK_KEY,
  NO_TERMINAL_FALLBACKS,
  configNoTerminalFallback,
  fallbackCard,
  fallbackPayConfig,
  mayPayAtTill,
  noTerminalFallbackOf,
  tillFallbackApplies,
  withTillFallback,
  type FallbackCard,
  type NoTerminalFallback,
} from '../src/core/noTerminalFallback';
import { INITIAL_FLOW, reduce, restingScreen, type KioskFlowRules } from '../src/core/kioskFlow';
import { ANDROID_NO_CARD_TEXT, androidCard, normalizeView } from '../src/renderer/bridges/android';
import type { KioskView } from '../src/shared/bridge';

const GOLDEN = path.join(__dirname, 'fixtures', 'no_terminal_fallback_golden.json');
const GOLDEN_SHA256 = 'cd8e468723af098babece09fd2f42c2ceee23c096537e0023d08d6a0f08534ba';
const text = readFileSync(GOLDEN, 'utf8').replace(/\r\n/g, '\n');

interface Golden {
  key: string;
  configField: string;
  options: string[];
  default: string;
  cardText: string;
  modeOf: Array<{ param: string | null; config: string | null; mode: NoTerminalFallback }>;
  card: Array<{ configured: boolean; unreachable: boolean; locked: boolean; card: FallbackCard }>;
  cases: Array<{ mode: NoTerminalFallback; methods: PaymentMethod[]; card: FallbackCard; cashDeviceUsable: boolean; applies: boolean; out: PaymentMethod[] }>;
  mayPayAtTill: Array<{ methods: PaymentMethod[]; mode: NoTerminalFallback; may: boolean }>;
}
const golden = JSON.parse(text) as Golden;

describe('the rule (the golden, shared with pos-android)', () => {
  it('the fixture is the one pos-android pins', () => {
    expect(createHash('sha256').update(text, 'utf8').digest('hex')).toBe(GOLDEN_SHA256);
  });

  it('the names, the choices, the default and the customer\'s words', () => {
    expect(NO_TERMINAL_FALLBACK_KEY).toBe(golden.key);
    expect(NO_TERMINAL_FALLBACK_CONFIG_FIELD).toBe(golden.configField);
    expect([...NO_TERMINAL_FALLBACKS]).toEqual(golden.options);
    expect(NO_TERMINAL_FALLBACK_DEFAULT).toBe(golden.default);
    expect(CARD_FALLBACK_TEXT).toBe(golden.cardText);
  });

  it('the choice: the parameter, else the config\'s, else `pay_at_till` (an old cloud sends neither)', () => {
    for (const c of golden.modeOf) expect(noTerminalFallbackOf(c.param, c.config), JSON.stringify(c)).toBe(c.mode);
    expect(noTerminalFallbackOf()).toBe('pay_at_till');
    expect(noTerminalFallbackOf(undefined, 3, true)).toBe('pay_at_till');
    expect(configNoTerminalFallback({ general: { noTerminalFallback: 'block' } })).toBe('block');
    expect(configNoTerminalFallback({ general: {} })).toBeUndefined();
    expect(configNoTerminalFallback(null)).toBeUndefined();
  });

  it('the card: ok, not answering, or not there to charge on', () => {
    for (const c of golden.card) expect(fallbackCard(c), JSON.stringify(c)).toBe(c.card);
  });

  it('when "תשלום בקופה" is offered for the terminal, and the methods then', () => {
    for (const c of golden.cases) {
      const applies = tillFallbackApplies(c);
      expect(applies, JSON.stringify(c)).toBe(c.applies);
      expect(withTillFallback(c.methods, applies), JSON.stringify(c)).toEqual(c.out);
    }
  });

  it('an order to the till is taken while the kiosk may offer it — a terminal that came back in between never refuses it', () => {
    for (const c of golden.mayPayAtTill) expect(mayPayAtTill(c.methods, c.mode), JSON.stringify(c)).toBe(c.may);
  });
});

/* ------------------------------------------------------------------ "איך תרצו לשלם?" on the screens (KioskApp) */

describe('"איך תרצו לשלם?" while the till is offered for the terminal (KioskApp: kioskPayChooser over fallbackPayConfig)', () => {
  const cardOnly = (stepMode?: string) =>
    ({ ...KIOSK_DEFAULTS, payment: { ...KIOSK_DEFAULTS.payment, methods: ['card'], stepModes: { ...KIOSK_DEFAULTS.payment.stepModes, ...(stepMode ? { payMethod: stepMode } : {}) } } }) as KioskConfig;
  const ask = (cfg: KioskConfig, methods: PaymentMethod[], usable: PaymentMethod[], tillFallback: boolean) =>
    kioskPayChooser(fallbackPayConfig(cfg, methods, tillFallback), methods, usable);

  it('no terminal: asked, the till the way through — whatever the card-only kiosk\'s step says', () => {
    for (const mode of [undefined, 'off', 'required']) {
      expect(ask(cardOnly(mode), ['card', 'cash_at_till'], ['cash_at_till'], true), String(mode)).toEqual({ asks: true, optional: false, fallback: 'cash_at_till' });
    }
  });

  it('a terminal that does not answer: asked (never the card alone) — "רשות" passes with the card, the till a tap away', () => {
    for (const mode of [undefined, 'off', 'required']) {
      expect(ask(cardOnly(mode), ['card', 'cash_at_till'], ['card', 'cash_at_till'], true), String(mode)).toEqual({ asks: true, optional: false, fallback: 'card' });
    }
    expect(ask(cardOnly('optional'), ['card', 'cash_at_till'], ['card', 'cash_at_till'], true)).toEqual({ asks: true, optional: true, fallback: 'card' });
  });

  it('not offered: the config as it is — a card-only kiosk goes straight to the card', () => {
    expect(fallbackPayConfig(cardOnly('off'), ['card'], false)).toEqual(cardOnly('off'));
    expect(ask(cardOnly(), ['card'], ['card'], false)).toEqual({ asks: false, optional: false, fallback: 'card' });
  });
});

/* ------------------------------------------------------------------ the Android web bundle */

describe('the Android web bundle (an APK of bridge API 2 places orders for the till)', () => {
  const STATE = { paused: false, pausedMessage: null, pausedUntil: null, noPayment: false, terminal: 'ready', offline: false, offlineSince: null, cardBlocked: false };
  /** The APK's view (pos-android KioskWebSnapshot): the cloud's config as it came, the terminal as the APK sees it. */
  const apkView = (methods: string[], state: Record<string, unknown> = {}, general: Record<string, unknown> = {}) =>
    ({ phase: 'kiosk', config: { payment: { methods }, general }, state: { ...STATE, ...state } }) as unknown as KioskView;
  const cfgOf = (methods: string[]) => ({ ...KIOSK_DEFAULTS, payment: { ...KIOSK_DEFAULTS.payment, methods } }) as KioskConfig;
  /** Where the screens rest (KioskApp: it sells while "איך תרצו לשלם?" has a way to pay). */
  const restsOn = (pay: KioskView['pay'], methods: string[]) => {
    const rules: KioskFlowRules = { services: ['take_away'], skipCart: 'off', asksDetails: () => false, cartEmpty: true, detailsStep: 'before_pay', asksPayMethod: false };
    const s = reduce(reduce(INITIAL_FLOW, { type: 'ready', ready: true }, rules), { type: 'terminal', canCharge: kioskPayChooser(cfgOf(methods), pay.methods, pay.usable).fallback !== null }, rules);
    return restingScreen(s);
  };

  it('the APK\'s terminal as the rule reads it', () => {
    expect(androidCard({ state: { ...STATE, terminal: 'ready' } } as KioskView)).toBe('ok');
    expect(androidCard({ state: { ...STATE, terminal: 'unreachable' } } as KioskView)).toBe('flaky');
    for (const terminal of ['unconfigured', 'not_external', 'no_card']) expect(androidCard({ state: { ...STATE, terminal } } as KioskView)).toBe('missing');
    // "חסימת אשראי כשיש תשלום לא מוכרע" holds the card: not there to charge on.
    expect(androidCard({ state: { ...STATE, cardBlocked: true } } as KioskView)).toBe('missing');
    expect(androidCard(null)).toBe('ok');
  });

  it('no terminal set up, card only: the till offered, the card\'s tile says why — the kiosk sells', () => {
    const pay = normalizeView(apkView(['card'], { terminal: 'unconfigured', noPayment: true }), { payAtTill: true }).pay;
    expect(pay).toEqual({ methods: ['card', 'cash_at_till'], usable: ['cash_at_till'], cardOff: CARD_FALLBACK_TEXT, tillFallback: true });
    expect(restsOn(pay, ['card'])).toBe('attract');
    // "ללא אשראי" with the card alone: the till alone.
    const none = normalizeView(apkView(['card'], { terminal: 'no_card', noPayment: true }), { payAtTill: true }).pay;
    expect(none).toEqual({ methods: ['cash_at_till'], usable: ['cash_at_till'], cardOff: ANDROID_NO_CARD_TEXT, tillFallback: true });
    expect(restsOn(none, ['card'])).toBe('attract');
  });

  it('set up but not answering: the card stays (the APK tries it on the press) with the till beside it', () => {
    const pay = normalizeView(apkView(['card'], { terminal: 'unreachable' }), { payAtTill: true }).pay;
    expect(pay).toEqual({ methods: ['card', 'cash_at_till'], usable: ['card', 'cash_at_till'], cardOff: null, tillFallback: true });
    // Answering: as before.
    expect(normalizeView(apkView(['card']), { payAtTill: true }).pay).toEqual({ methods: ['card'], usable: ['card'], cardOff: null });
  });

  it('`block` in the config: as before — the card alone, tried on the press', () => {
    const block = { noTerminalFallback: 'block' };
    expect(normalizeView(apkView(['card'], { terminal: 'unconfigured', noPayment: true }, block), { payAtTill: true }).pay).toEqual({ methods: ['card'], usable: ['card'], cardOff: null });
    expect(normalizeView(apkView(['card'], { terminal: 'unreachable' }, block), { payAtTill: true }).pay).toEqual({ methods: ['card'], usable: ['card'], cardOff: null });
  });

  it('the till configured already: nothing added, nothing taken off', () => {
    expect(normalizeView(apkView(['card', 'cash_at_till'], { terminal: 'unconfigured', noPayment: true }), { payAtTill: true }).pay).toEqual({
      methods: ['card', 'cash_at_till'],
      usable: ['card', 'cash_at_till'],
      cardOff: null,
    });
  });

  it('"חסימת הזמנות כשאין אינטרנט" still holds what it holds: offline with it on, the "offline" rest', () => {
    const view = normalizeView(apkView(['card'], { terminal: 'unconfigured', noPayment: true, offline: true }, { blockWhenOffline: true }), { payAtTill: true });
    expect(view.pay.usable).toEqual([]);
    expect(view.state.noPaymentReason).toBe('offline');
    // Offline without the block: the till still takes it (the APK hands it to the LAN, else its slip).
    expect(normalizeView(apkView(['card'], { terminal: 'unconfigured', noPayment: true, offline: true }), { payAtTill: true }).pay.usable).toEqual(['cash_at_till']);
  });

  it('an APK of API 1 (no order to the till from these screens): as before', () => {
    expect(normalizeView(apkView(['card'], { terminal: 'unconfigured', noPayment: true })).pay).toEqual({ methods: ['card'], usable: ['card'], cardOff: null });
  });
});
