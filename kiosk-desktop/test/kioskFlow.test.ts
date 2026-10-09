import { describe, expect, it } from 'vitest';
import { KIOSK_DEFAULTS } from '@dash-lib/kioskConfig';
import { backAction, idleCheck, INITIAL_FLOW, reduce, rulesOf, wire, type KioskEvent, type KioskFlowRules, type KioskFlowState } from '../src/core/kioskFlow';

const rules = (over: Partial<KioskFlowRules> = {}): KioskFlowRules => ({ services: ['take_away', 'eat_in'], skipCart: 'off', asksDetails: () => false, cartEmpty: false, detailsStep: 'before_pay', ...over });
const run = (r: KioskFlowRules, ...events: KioskEvent[]) => events.reduce<KioskFlowState>((s, e) => reduce(s, e, r), INITIAL_FLOW);

describe('the kiosk flow (a port of the till’s KioskFlow.kt)', () => {
  it('attract → service → catalog → cart → pay', () => {
    const r = rules();
    const s = run(r, { type: 'start' }, { type: 'chooseService', service: 'eat_in' }, { type: 'openCart' }, { type: 'checkout' });
    expect(s).toMatchObject({ screen: 'pay', service: 'eat_in', pay: 'idle' });
  });

  it('one service: the service screen is skipped', () => {
    expect(run(rules({ services: ['take_away'] }), { type: 'start' })).toMatchObject({ screen: 'catalog', service: 'take_away' });
  });

  it('"לקחת / לשבת" on the attract screen: back from the menu is the attract screen', () => {
    const r = rules({ serviceOnAttract: true });
    const s = run(r, { type: 'startWith', service: 'take_away' });
    expect(s.screen).toBe('catalog');
    expect(reduce(s, { type: 'back' }, r).screen).toBe('attract');
  });

  it('"לקחת / לשבת" on the attract screen: a tap elsewhere (or a scan) starts nothing — the service is never a step too', () => {
    const r = rules({ serviceOnAttract: true });
    expect(reduce(INITIAL_FLOW, { type: 'start' }, r)).toBe(INITIAL_FLOW);
    expect(backAction(INITIAL_FLOW, r)).toBe('none');
    expect(run(r, { type: 'start' }, { type: 'startWith', service: 'eat_in' })).toMatchObject({ screen: 'catalog', service: 'eat_in' });
    // After the start button (the default): the service step as always.
    expect(run(rules(), { type: 'start' }).screen).toBe('service');
    // From the config: two services placed on the attract screen; one service starts as always.
    const cfg = (serviceTypes: string[], servicePlacement: string) => ({
      general: { serviceTypes, skipCart: 'off', askTableNumber: false, servicePlacement },
      payment: { customerName: 'off', customerPhone: 'off', tipEnabled: false },
    });
    expect(run(rulesOf(cfg(['take_away', 'eat_in'], 'attract'), false), { type: 'start' }).screen).toBe('attract');
    expect(run(rulesOf(cfg(['take_away', 'eat_in'], 'after_start'), false), { type: 'start' }).screen).toBe('service');
    expect(run(rulesOf(cfg(['eat_in'], 'attract'), false), { type: 'start' })).toMatchObject({ screen: 'catalog', service: 'eat_in' });
  });

  it('"לקחת / לשבת" on the attract screen: no way from there reaches the service step', () => {
    const events: KioskEvent[] = [
      { type: 'start' }, { type: 'startWith', service: 'take_away' }, { type: 'startWith', service: 'eat_in' }, { type: 'itemAdded' },
      { type: 'openCart' }, { type: 'backToCatalog' }, { type: 'checkout' }, { type: 'detailsDone' }, { type: 'back' }, { type: 'reset' },
      { type: 'paymentStarted' }, { type: 'paymentDeclined' }, { type: 'paymentApproved' }, { type: 'successDone' },
    ];
    for (const detailsStep of ['after_service', 'before_cart', 'before_pay', 'after_pay'] as const) {
      for (const asks of [false, true]) {
        const r = rules({ serviceOnAttract: true, detailsStep, asksDetails: () => asks });
        let seen = new Map<string, KioskFlowState>([[JSON.stringify(INITIAL_FLOW), INITIAL_FLOW]]);
        for (let depth = 0; depth < 5; depth++) {
          const next = new Map(seen);
          for (const s of seen.values()) for (const e of events) next.set(JSON.stringify(reduce(s, e, r)), reduce(s, e, r));
          seen = next;
        }
        expect([...seen.values()].some((s) => s.screen === 'service'), `${detailsStep} / ${asks}`).toBe(false);
        expect([...seen.values()].some((s) => s.screen === 'catalog')).toBe(true);
      }
    }
    // Back from the details asked right after the service: the attract screen — even one reached from a service screen.
    const r = rules({ serviceOnAttract: true, detailsStep: 'after_service', asksDetails: () => true });
    const details = run(r, { type: 'startWith', service: 'take_away' });
    expect(details.screen).toBe('details');
    expect(reduce(details, { type: 'back' }, r).screen).toBe('attract');
    expect(reduce({ ...details, cameFrom: 'service' }, { type: 'back' }, r).screen).toBe('attract');
    expect(reduce({ ...details, cameFrom: 'service' }, { type: 'back' }, { ...r, serviceOnAttract: false }).screen).toBe('service');
  });

  it('skip cart: direct → payment at once; confirm → a short confirmation', () => {
    expect(run(rules({ skipCart: 'direct' }), { type: 'start' }, { type: 'chooseService', service: 'take_away' }, { type: 'itemAdded' }).screen).toBe('pay');
    expect(run(rules({ skipCart: 'confirm' }), { type: 'start' }, { type: 'chooseService', service: 'take_away' }, { type: 'itemAdded' }).screen).toBe('confirm');
  });

  it('details asked at the configured step', () => {
    const asks = () => true;
    expect(run(rules({ asksDetails: asks }), { type: 'start' }, { type: 'chooseService', service: 'take_away' }, { type: 'checkout' })).toMatchObject({ screen: 'details', detailsNext: 'pay' });
    expect(run(rules({ asksDetails: asks, detailsStep: 'after_service' }), { type: 'start' }, { type: 'chooseService', service: 'take_away' })).toMatchObject({ screen: 'details', detailsNext: 'catalog' });
    const afterPay = run(rules({ asksDetails: asks, detailsStep: 'after_pay' }), { type: 'start' }, { type: 'chooseService', service: 'take_away' }, { type: 'checkout' }, { type: 'paymentStarted' }, { type: 'paymentCharging' }, { type: 'paymentApproved' });
    expect(afterPay).toMatchObject({ screen: 'details', pay: 'approved', detailsNext: 'success' });
    expect(backAction(afterPay, rules({ asksDetails: asks, detailsStep: 'after_pay' }))).toBe('blocked');
  });

  it('nothing resets, pauses or closes the kiosk while a payment is on its way or unknown', () => {
    const r = rules();
    for (const phase of ['starting', 'charging', 'unknown'] as const) {
      const paying: KioskFlowState = { ...INITIAL_FLOW, screen: 'pay', pay: phase, service: 'take_away' };
      expect(reduce(paying, { type: 'reset' }, r)).toBe(paying);
      expect(reduce(paying, { type: 'paused', paused: true }, r).screen).toBe('pay');
      expect(reduce(paying, { type: 'hours', open: false }, r).screen).toBe('pay');
      expect(reduce(paying, { type: 'terminal', canCharge: false }, r).screen).toBe('pay');
      expect(idleCheck(paying, 0, 10_000_000, { inactivitySec: 60, warningSec: 20, successSec: 12 }).kind).toBe('none');
      expect(wire(paying)).toBe('paying');
    }
  });

  it('an approval is never lost, even after a decline came late', () => {
    const r = rules();
    const s = run(r, { type: 'start' }, { type: 'chooseService', service: 'take_away' }, { type: 'checkout' }, { type: 'paymentStarted' }, { type: 'paymentApproved' }, { type: 'paymentDeclined' });
    expect(s).toMatchObject({ screen: 'success', pay: 'approved' });
  });

  it('unknown is held for a person; a retry only after a clear decline', () => {
    const r = rules();
    const unknown = run(r, { type: 'start' }, { type: 'chooseService', service: 'take_away' }, { type: 'checkout' }, { type: 'paymentStarted' }, { type: 'paymentUnknown' });
    expect(reduce(unknown, { type: 'retryPayment' }, r)).toBe(unknown);
    const released = reduce(unknown, { type: 'paymentReleased' }, r);
    expect(released.pay).toBe('declined');
    expect(reduce(released, { type: 'retryPayment' }, r).pay).toBe('idle');
  });

  it('a pause takes effect at rest, or once the customer is done', () => {
    const r = rules();
    expect(reduce(INITIAL_FLOW, { type: 'paused', paused: true }, r).screen).toBe('paused');
    const ordering = run(r, { type: 'start' });
    const paused = reduce(ordering, { type: 'paused', paused: true }, r);
    expect(paused.screen).toBe('service');
    expect(reduce(paused, { type: 'reset' }, r).screen).toBe('paused');
  });

  it('no usable terminal: the idle kiosk rests on "התשלום אינו זמין"', () => {
    expect(reduce(INITIAL_FLOW, { type: 'terminal', canCharge: false }, rules()).screen).toBe('no_payment');
  });

  it('leaving with a basket asks first; a charge on the terminal is cancelled; a payment under way is blocked', () => {
    const r = rules();
    const catalog = run(r, { type: 'start' }, { type: 'chooseService', service: 'take_away' });
    expect(backAction({ ...catalog, screen: 'service' }, r)).toBe('confirm_leave');
    expect(backAction({ ...catalog, screen: 'pay', pay: 'charging' }, r)).toBe('cancel_payment');
    expect(backAction({ ...catalog, screen: 'pay', pay: 'starting' }, r)).toBe('blocked');
    expect(backAction({ ...catalog, screen: 'pay', pay: 'unknown' }, r)).toBe('blocked');
  });

  it('the inactivity warning, then the reset', () => {
    const s: KioskFlowState = { ...INITIAL_FLOW, screen: 'catalog' };
    const t = { inactivitySec: 60, warningSec: 20, successSec: 12 };
    expect(idleCheck(s, 0, 59_000, t).kind).toBe('none');
    expect(idleCheck(s, 0, 61_000, t)).toEqual({ kind: 'warn', secondsLeft: 19 });
    expect(idleCheck(s, 0, 80_000, t).kind).toBe('reset');
  });

  it('the rules from the default config: before payment, name asked (optional)', () => {
    const r = rulesOf(KIOSK_DEFAULTS as never, false);
    expect(r.services).toEqual(['take_away', 'eat_in']);
    expect(r.detailsStep).toBe('before_pay');
    expect(r.asksDetails('take_away')).toBe(true);
    expect(r.asksTip).toBe(false);
  });
});

describe('"טיפ לצוות" — a checkout step of its own (the till’s KioskFlow asksTip)', () => {
  const cfg = (payment: Record<string, unknown>, general: Record<string, unknown> = {}) =>
    ({ ...KIOSK_DEFAULTS, general: { ...KIOSK_DEFAULTS.general, ...general }, payment: { ...KIOSK_DEFAULTS.payment, ...payment } }) as never;
  const toPay = (r: KioskFlowRules) => run(r, { type: 'start' }, { type: 'chooseService', service: 'take_away' }, { type: 'openCart' }, { type: 'checkout' });

  it('the tip is not a detail: no name, no phone, the tip on → only the tip is asked', () => {
    const r = rulesOf(cfg({ customerName: 'off', customerPhone: 'off', tipEnabled: true }, { askTableNumber: true }), false);
    expect(r.asksDetails('take_away')).toBe(false);
    expect(r.asksDetails('eat_in')).toBe(true); // the table
    expect(r.asksTip).toBe(true);
    // Nothing to choose: no presets and no "סכום אחר".
    expect(rulesOf(cfg({ tipEnabled: true, tipPresets: [], tipOther: false }), false).asksTip).toBe(false);
    expect(rulesOf(cfg({ tipEnabled: true, tipPresets: [], tipOther: true }), false).asksTip).toBe(true);
  });

  it('tip off and nothing asked: the basket goes straight to payment, and back to the basket', () => {
    const r = rules({ asksTip: false });
    const pay = toPay(r);
    expect(pay).toMatchObject({ screen: 'pay', pay: 'idle' });
    expect(reduce(pay, { type: 'back' }, r).screen).toBe('cart');
  });

  it('tip on, no details: checkout → the details screen (the tip) → pay; back from pay → the tip again', () => {
    const r = rules({ asksTip: true });
    const tip = toPay(r);
    expect(tip).toMatchObject({ screen: 'details', detailsNext: 'pay', cameFrom: 'cart' });
    const pay = reduce(tip, { type: 'detailsDone' }, r);
    expect(pay).toMatchObject({ screen: 'pay', pay: 'idle' });
    expect(reduce(pay, { type: 'back' }, r)).toMatchObject({ screen: 'details', detailsNext: 'pay' });
    expect(reduce(tip, { type: 'back' }, r).screen).toBe('cart');
    // "דלג על סל" (direct): the first item goes to the tip, back from it is the menu.
    const direct = rules({ asksTip: true, skipCart: 'direct' });
    const fromItem = run(direct, { type: 'start' }, { type: 'chooseService', service: 'take_away' }, { type: 'itemAdded' });
    expect(fromItem).toMatchObject({ screen: 'details', detailsNext: 'pay' });
    expect(reduce(fromItem, { type: 'back' }, direct).screen).toBe('catalog');
  });

  it('details before the cart already given: the checkout asks only the tip', () => {
    const r = rules({ asksTip: true, asksDetails: () => true, detailsStep: 'before_cart' });
    const cartDetails = run(r, { type: 'start' }, { type: 'chooseService', service: 'take_away' }, { type: 'openCart' });
    expect(cartDetails).toMatchObject({ screen: 'details', detailsNext: 'cart' });
    const cart = reduce(cartDetails, { type: 'detailsDone' }, r);
    expect(cart).toMatchObject({ screen: 'cart', detailsDone: true });
    const tip = reduce(cart, { type: 'checkout' }, r);
    expect(tip).toMatchObject({ screen: 'details', detailsNext: 'pay', detailsDone: true });
    const pay = reduce(tip, { type: 'detailsDone' }, r);
    expect(pay.screen).toBe('pay');
    expect(reduce(pay, { type: 'back' }, r).screen).toBe('details');
    // Without the tip the same order goes straight to payment, and back to the basket.
    const noTip = rules({ asksDetails: () => true, detailsStep: 'before_cart' });
    expect(reduce({ ...cart }, { type: 'checkout' }, noTip).screen).toBe('pay');
    expect(reduce({ ...pay }, { type: 'back' }, noTip).screen).toBe('cart');
  });

  it('details after the payment: the tip before it, only the details after it', () => {
    const r = rules({ asksTip: true, asksDetails: () => true, detailsStep: 'after_pay' });
    const tip = toPay(r);
    expect(tip).toMatchObject({ screen: 'details', detailsNext: 'pay' });
    const pay = reduce(tip, { type: 'detailsDone' }, r);
    expect(pay.screen).toBe('pay');
    const paid = [{ type: 'paymentStarted' }, { type: 'paymentCharging' }, { type: 'paymentApproved' }].reduce<KioskFlowState>((s, e) => reduce(s, e as KioskEvent, r), pay);
    expect(paid).toMatchObject({ screen: 'details', pay: 'approved', detailsNext: 'success' });
    expect(reduce(paid, { type: 'detailsDone' }, r)).toMatchObject({ screen: 'success', pay: 'approved' });
  });
});
