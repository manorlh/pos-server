import { describe, expect, it } from 'vitest';
import { KIOSK_DEFAULTS } from '@dash-lib/kioskConfig';
import { basketChanges, checkedBasePrice, overridesLive, overridesOf, totalChanged, CLOUD_OVERRIDE_TTL_MS } from '../src/core/basketCheck';
import { endReasonOf, enqueueFunnel, funnelReplyDrops, funnelStepOf, FunnelTracker, type FunnelEvent, type FunnelSnapshot } from '../src/core/kioskFunnel';
import { reduce, rulesOf, INITIAL_FLOW, type FlowConfigIn } from '../src/core/kioskFlow';

function tracker() {
  const events: FunnelEvent[] = [];
  let now = Date.parse('2026-10-07T10:00:00Z');
  let mono = 1000;
  let n = 0;
  const t = new FunnelTracker((e) => events.push(...e), () => `s${++n}`, 'windows', { now: () => now, mono: () => mono });
  const tick = (ms: number) => {
    now += ms;
    mono += ms;
  };
  return { t, events, tick };
}

const snap = (screen: string, over: Partial<FunnelSnapshot> = {}): FunnelSnapshot => ({
  screen,
  pay: 'idle',
  service: null,
  basketAgorot: 0,
  items: 0,
  idleWarn: false,
  ...over,
});

describe('"ביצועי קיוסקים": the funnel (core/kioskFunnel.ts — the till’s KioskFunnel.kt)', () => {
  it('a paid order: start, screens, the payment, the end — one session, numbered, timed', () => {
    const { t, events, tick } = tracker();
    t.observe(snap('attract'));
    expect(events).toHaveLength(0);
    t.observe(snap('service'));
    tick(4000);
    t.observe(snap('catalog', { service: 'eat_in' }));
    t.itemOpen('p1');
    tick(6000);
    t.itemAdd('p1', 1, false, 5200);
    t.observe(snap('catalog', { service: 'eat_in', basketAgorot: 5200, items: 1 }));
    t.observe(snap('cart', { service: 'eat_in', basketAgorot: 5200, items: 1 }));
    t.observe(snap('details', { sub: 'tip', service: 'eat_in', basketAgorot: 5200, items: 1 }));
    t.noteTip(500);
    t.observe(snap('pay', { service: 'eat_in', basketAgorot: 5200, items: 1 }));
    t.observe(snap('pay', { pay: 'starting', service: 'eat_in', basketAgorot: 5200, items: 1 }));
    tick(20000);
    t.observe(snap('success', { pay: 'approved', service: 'eat_in', basketAgorot: 5200, items: 1 }));
    t.noteEvent('successDone');
    t.observe(snap('attract'));
    expect(events.map((e) => [e.type, e.step])).toEqual([
      ['session_start', 'attract'],
      ['screen', 'service'],
      ['screen', 'catalog'],
      ['item_open', 'item'],
      ['item_add', 'catalog'],
      ['screen', 'cart'],
      ['screen', 'tip'],
      ['screen', 'pay'],
      ['pay', 'pay'],
      ['screen', 'success'],
      ['pay', 'pay'],
      ['session_end', 'success'],
    ]);
    expect(new Set(events.map((e) => e.sessionId))).toEqual(new Set(['s1']));
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
    const approved = events.find((e) => e.type === 'pay' && e.data?.result === 'approved')!;
    expect(approved.elapsedMs).toBe(30000);
    expect(approved.data?.amountAgorot).toBe(5700);
    expect(events.at(-1)!.data).toMatchObject({ reason: 'paid', basketAgorot: 5200, items: 1, tipAgorot: 500 });
    // Nothing personal in any event.
    expect(JSON.stringify(events)).not.toMatch(/customer|phone|last4|cardNumber|"name"/i);
  });

  it('why a session ended: timed out, cancelled, left, help, a declined card cancelled by the customer', () => {
    const { t, events } = tracker();
    t.observe(snap('catalog'));
    t.observe(snap('cart', { idleWarn: true, basketAgorot: 900, items: 1 }));
    t.noteEvent('reset');
    t.observe(snap('attract'));
    expect(events.at(-1)).toMatchObject({ type: 'session_end', step: 'cart', data: { reason: 'timeout', basketAgorot: 900 } });

    t.observe(snap('catalog'));
    t.noteEvent('reset');
    t.observe(snap('attract'));
    expect(events.at(-1)!.data?.reason).toBe('cancelled');

    t.observe(snap('service'));
    t.noteEvent('back');
    t.observe(snap('attract'));
    expect(events.at(-1)!.data?.reason).toBe('abandoned');

    t.observe(snap('pay'));
    t.observe(snap('pay', { pay: 'starting' }));
    t.noteCancelPayment();
    t.observe(snap('pay', { pay: 'declined' }));
    t.help();
    t.noteEvent('reset');
    t.observe(snap('attract'));
    const last = events.filter((e) => e.sessionId === events.at(-1)!.sessionId);
    expect(last.find((e) => e.type === 'pay' && e.data?.result !== 'started')!.data).toMatchObject({ result: 'cancelled', reason: 'cancelled_by_customer' });
    expect(last.at(-1)!.data?.reason).toBe('help');
    expect(new Set(events.map((e) => e.sessionId)).size).toBe(4);
  });

  it('the steps and the reasons', () => {
    expect(funnelStepOf('details', 'tip')).toBe('tip');
    expect(funnelStepOf('details', 'payMethod')).toBe('pay_method');
    expect(funnelStepOf('details', 'details')).toBe('details');
    expect(funnelStepOf('paused')).toBeNull();
    expect(endReasonOf({ paid: true, helped: true, lastEvent: 'reset', idleWarn: true, staff: false })).toBe('paid');
    expect(endReasonOf({ paid: false, helped: false, lastEvent: null, idleWarn: false, staff: true })).toBe('reset');
  });

  it('the queue: capped, and what an answer means', () => {
    const e = (seq: number): FunnelEvent => ({ sessionId: 's', seq, type: 'screen', at: 'x', step: 'cart' });
    expect(enqueueFunnel([e(1), e(2)], [e(3)], 2).map((x) => x.seq)).toEqual([2, 3]);
    expect(funnelReplyDrops({ kind: 'ok' })).toBe(true);
    expect(funnelReplyDrops({ kind: 'offline' })).toBe(false);
    expect(funnelReplyDrops({ kind: 'refused', status: 422 })).toBe(true);
    expect(funnelReplyDrops({ kind: 'refused', status: 403 })).toBe(true);
    expect(funnelReplyDrops({ kind: 'refused', status: 503 })).toBe(false);
    expect(funnelReplyDrops({ kind: 'refused', status: 401 })).toBe(false);
  });
});

describe('the pre-payment check (core/basketCheck.ts — the till’s KioskPriceCheck.kt)', () => {
  it('the cloud’s word: gone, repriced, kept for a while', () => {
    const o = overridesOf(
      {
        ok: false,
        lines: [
          { productId: 'a', available: false, reason: 'unavailable', priceAgorot: 1000, priceChanged: false },
          { productId: 'b', available: true, reason: null, priceAgorot: 5500, priceChanged: true },
          { productId: 'c', available: true, reason: null, priceAgorot: 900, priceChanged: false },
        ],
      },
      1000,
    );
    expect([...o.gone]).toEqual(['a']);
    expect(checkedBasePrice('b', 5200, o)).toBe(5500);
    expect(checkedBasePrice('c', 900, o)).toBe(900);
    expect(overridesLive(o, 1000 + CLOUD_OVERRIDE_TTL_MS - 1)).toBe(o);
    expect(overridesLive(o, 1000 + CLOUD_OVERRIDE_TTL_MS)).toBeNull();
  });

  it('what changed against what the screen showed', () => {
    const priced = new Map([
      ['l1', { name: 'בורגר', unitAgorot: 5500 }],
      ['l2', { name: 'קולה', unitAgorot: 900 }],
      ['l3', null],
    ]);
    const changes = basketChanges(
      [
        { key: 'l1', productId: 'b', unitAgorot: 5200 },
        { key: 'l2', productId: 'c', unitAgorot: 900 },
        { key: 'l3', productId: 'a', unitAgorot: 1000 },
        { key: 'l4', productId: 'd' },
      ],
      priced as never,
      new Map([['a', 'צ׳יפס']]),
    );
    expect(changes).toEqual([
      { kind: 'repriced', productId: 'b', key: 'l1', name: 'בורגר', from: 5200, to: 5500 },
      { kind: 'removed', productId: 'a', key: 'l3', name: 'צ׳יפס' },
      { kind: 'removed', productId: 'd', key: 'l4', name: '' },
    ]);
    expect(totalChanged(6100, 6400)).toBe(true);
    expect(totalChanged(6100, 6100)).toBe(false);
    expect(totalChanged(undefined, 6100)).toBe(false);
  });
});

describe('"חובה / רשות / כבוי" in the flow (payment.stepModes)', () => {
  const cfg = (stepModes: Record<string, string>, extra: Record<string, unknown> = {}): FlowConfigIn =>
    ({
      general: { ...KIOSK_DEFAULTS.general },
      payment: { ...KIOSK_DEFAULTS.payment, tipEnabled: true, stepModes, ...extra },
    }) as unknown as FlowConfigIn;

  it('the service off: straight to the menu as the first type', () => {
    const s = reduce(INITIAL_FLOW, { type: 'start' }, rulesOf(cfg({ service: 'off' }), true));
    expect(s).toMatchObject({ screen: 'catalog', service: 'take_away' });
    expect(reduce(INITIAL_FLOW, { type: 'start' }, rulesOf(cfg({ service: 'optional' }), true)).screen).toBe('service');
  });

  it('the tip off: "לתשלום" goes straight to the payment', () => {
    const atCart = { ...INITIAL_FLOW, screen: 'cart' as const, service: 'take_away' as const };
    const noDetails = { customerName: 'off' };
    expect(reduce(atCart, { type: 'checkout' }, rulesOf(cfg({ tip: 'off' }, noDetails), false)).screen).toBe('pay');
    expect(reduce(atCart, { type: 'checkout' }, rulesOf(cfg({ tip: 'required' }, noDetails), false)).screen).toBe('details');
  });
});
