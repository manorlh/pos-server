/**
 * "מסך לקוח" on the till's second screen (P:/specs/customer-display.md): pos-android CustomerDisplayStateTest and
 * CustomerDisplayConfigTest's cases on the Windows mapping — the basket, the payment phases, the thanks with the change, the
 * §13 notice on a card's states only, `show` filtering, the thanks held — and the till's module: the cloud's settings,
 * the state following the engine, nothing for a till whose setting is off. Tests only: a fake cloud.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULTS } from '@dash-lib/customerDisplay';
import { CustomerDisplayBus, IDLE_STATE, basketOf, displayConfigOf, filtered, holdWaitMs, sameScreen, screenOf, showsOnSecondScreen, type CdState } from '../src/core/till/customerDisplay';
import type { CheckoutState, SellState } from '../src/shared/till/protocol';
import { PIN, harness, type Harness } from './tillEngineHarness';

const SELL: SellState = {
  catalogVersion: 1,
  departmentId: null,
  search: '',
  lines: [
    { lineId: 'l1', productId: 'p-burger', name: 'המבורגר', qty: 1, unitAgorot: 5_400, discountPct: 0, totalAgorot: 5_400, discountAgorot: 0 },
    { lineId: 'l2', productId: 'p-cola', name: 'קולה', qty: 2, unitAgorot: 1_250, discountPct: 10, totalAgorot: 2_250, discountAgorot: 250 },
  ],
  itemCount: 3,
  totalAgorot: 7_650,
  vatAgorot: 1_167,
  promotionsAgorot: 0,
  lineDiscountsAgorot: 250,
  basketDiscount: null,
};

const CHECKOUT = (o: Partial<CheckoutState>): CheckoutState => ({ phase: 'tender', totalAgorot: 7_650, paidAgorot: 0, dueAgorot: 7_650, changeAgorot: 0, legs: [], documentRef: null, ...o });

describe('the mapping (CustomerDisplayStateTest)', () => {
  it('the basket: its lines, the discounts, the total, the count; empty — idle', () => {
    const b = basketOf(SELL);
    expect(b.phase).toBe('basket');
    expect(b.lines).toEqual([
      { id: 'l1', name: 'המבורגר', qty: 1, unit: null, total: 5_400, modifiers: [], discount: 0, promo: null, refund: false },
      { id: 'l2', name: 'קולה', qty: 2, unit: null, total: 2_250, modifiers: [], discount: 250, promo: null, refund: false },
    ]);
    expect([b.discount, b.total, b.itemCount]).toEqual([250, 7_650, 3]);
    expect(basketOf({ ...SELL, lines: [] })).toEqual(IDLE_STATE);
    expect(Object.keys(b).sort()).toEqual(['cash', 'discount', 'itemCount', 'lines', 'payment', 'phase', 'promotions', 'seq', 'thanks', 'tip', 'total', 'v', 'vouchers']);
  });

  it('the payment: choosing, the card waited for / processed / declined (with the §13 notice), the thanks with the change', () => {
    const b = basketOf(SELL);
    expect(screenOf(b, null, null)).toBe(b);
    expect(screenOf(b, CHECKOUT({ phase: 'idle' }), null)).toBe(b);
    expect(screenOf(b, CHECKOUT({}), 'N').payment).toEqual({ method: 'other', status: 'choose', due: 7_650, paid: 0 });
    expect(screenOf(b, CHECKOUT({ phase: 'card_waiting' }), 'N').payment).toEqual({ method: 'card', status: 'waiting_card', due: 7_650, paid: 0, notice: 'N' });
    expect(screenOf(b, CHECKOUT({ phase: 'card_waiting', cardUnknown: true }), null).payment?.status).toBe('processing');
    expect(screenOf(b, CHECKOUT({ cardError: 'סירוב' }), null).payment).toEqual({ method: 'card', status: 'declined', due: 7_650, paid: 0 });
    const done = screenOf(b, CHECKOUT({ phase: 'done', changeAgorot: 2_350 }), 'N');
    expect(done.phase).toBe('thanks');
    expect(done.thanks).toEqual({ total: 7_650, change: 2_350, tip: 0, receiptUrl: null });
    expect(done.payment).toBeNull();
  });

  it('show: hidden fields never leave the till', () => {
    const paying = screenOf(basketOf(SELL), CHECKOUT({ phase: 'card_waiting' }), null);
    const noPrices = filtered(paying, { ...DEFAULTS.show, prices: false, payment: false });
    expect(noPrices.lines.map((l) => [l.total, l.discount])).toEqual([
      [0, 0],
      [0, 0],
    ]);
    expect(noPrices.phase).toBe('basket');
    expect(noPrices.payment).toBeNull();
    expect(filtered(paying, { ...DEFAULTS.show, items: false }).lines).toEqual([]);
    const thanks = screenOf(basketOf(SELL), CHECKOUT({ phase: 'done', changeAgorot: 100 }), null);
    expect(filtered(thanks, { ...DEFAULTS.show, change: false }).thanks?.change).toBe(0);
    expect(filtered(thanks, { ...DEFAULTS.show, thanks: false }).phase).toBe('idle');
  });

  it('the thanks held (CdHold): only thanks → idle waits the rest of thanksSec', () => {
    const thanks = { ...IDLE_STATE, phase: 'thanks' } as CdState;
    expect(holdWaitMs(thanks, 10_000, IDLE_STATE, 12_000, 6_000)).toBe(4_000);
    expect(holdWaitMs(thanks, 10_000, IDLE_STATE, 17_000, 6_000)).toBe(0);
    expect(holdWaitMs(thanks, 10_000, basketOf(SELL), 12_000, 6_000)).toBe(0);
    expect(sameScreen({ ...IDLE_STATE, seq: 1 }, { ...IDLE_STATE, seq: 9 })).toBe(true);
  });

  it('the bus: each new screen a higher seq; the thanks held, a new sale at once', () => {
    let now = 1_000_000;
    const seen: CdState[] = [];
    const timers: Array<{ fn: () => void; at: number }> = [];
    const bus = new CustomerDisplayBus(
      (s) => seen.push(s),
      () => now,
      { set: (fn, ms) => (timers.push({ fn, at: now + ms }), 0 as unknown as ReturnType<typeof setTimeout>), clear: () => timers.splice(0) },
    );
    bus.publish(basketOf(SELL));
    bus.publish(basketOf(SELL));
    expect(seen.map((s) => s.phase)).toEqual(['basket']);
    bus.publish(screenOf(basketOf(SELL), CHECKOUT({ phase: 'done' }), null));
    now += 1_000;
    bus.publish(IDLE_STATE);
    expect(seen.map((s) => s.phase)).toEqual(['basket', 'thanks']);
    expect(timers[0].at).toBe(now + 5_000);
    timers[0].fn();
    expect(seen.map((s) => s.phase)).toEqual(['basket', 'thanks', 'idle']);
    expect(seen[2].seq).toBeGreaterThan(seen[1].seq);
  });

  it('the settings: a till with it on; leniently read', () => {
    const c = displayConfigOf({ config: { enabled: true, layout: 'weird', thanksSec: 99, show: { prices: false, bogus: true } }, branding: { shopName: 'הרצליה' }, role: 'till', poll: { configSec: 5 } })!;
    expect(c.config.layout).toBe('auto');
    expect(c.config.thanksSec).toBe(60);
    expect(c.config.show.prices).toBe(false);
    expect(c.configSec).toBe(10);
    expect(showsOnSecondScreen(c)).toBe(true);
    expect(showsOnSecondScreen({ ...c, role: 'none' })).toBe(false);
    expect(showsOnSecondScreen(displayConfigOf({ config: {} }))).toBe(false);
  });
});

let current: Harness | null = null;
afterEach(() => {
  current?.stop();
  current = null;
});

describe('the till\'s module', () => {
  it('the cloud\'s settings; the screen follows the till; the heartbeat says a screen shows it', async () => {
    const h = harness({ answers: { 'GET sync/m/customer-display': () => ({ config: { enabled: true, thanksSec: 2 }, branding: { shopName: 'הרצליה', logoUrl: '', primaryColor: null }, role: 'till', poll: { configSec: 120 } }) } });
    current = h;
    const cd = h.engine.customerDisplay;
    expect(cd.wanted()).toBe(false);
    await cd.pull(true);
    expect(cd.wanted()).toBe(true);
    const frames: string[] = [];
    cd.onChange((f) => frames.push(f.state.phase));
    await h.ok('session.login', { pin: PIN });
    await h.ok('shift.open', { openingCashAgorot: 0 });
    await h.ok('sell.add', { productId: 'p-cola' });
    expect(cd.frame().state.lines.map((l) => l.name)).toEqual(['קולה']);
    await h.ok('checkout.start');
    expect(cd.frame().state.phase).toBe('paying');
    await h.ok('checkout.cash', { amountAgorot: 2_000 });
    expect(cd.frame().state.thanks).toMatchObject({ total: 1_250, change: 750 });
    expect(frames).toContain('basket');
    cd.setScreenPresent(true);
    const hb = (h.svc as unknown as { remoteHooks(): { heartbeatExtras(): Record<string, unknown> } }).remoteHooks().heartbeatExtras();
    expect(hb.customerDisplayMedia).toEqual({ screen: true, held: [] });
  });

  it('off (the default): nothing is shown', async () => {
    const h = harness({ answers: { 'GET sync/m/customer-display': () => ({ config: { enabled: false }, role: 'till' }) } });
    current = h;
    await h.engine.customerDisplay.pull(true);
    await h.ok('session.login', { pin: PIN });
    await h.ok('shift.open', { openingCashAgorot: 0 });
    await h.ok('sell.add', { productId: 'p-cola' });
    expect(h.engine.customerDisplay.wanted()).toBe(false);
    expect(h.engine.customerDisplay.frame().state.phase).toBe('idle');
  });
});
