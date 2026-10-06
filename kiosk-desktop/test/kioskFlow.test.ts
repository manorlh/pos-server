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
  });
});
