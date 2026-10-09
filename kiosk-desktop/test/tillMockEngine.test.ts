/**
 * S0-2 / S0-6: the mock till engine keeps the protocol's rules (spec §3.3) — the state from the
 * engine with a rising seq, one application per clientOpId, the engine's dialog in the state,
 * hardware asked of the host — and is never fiscal (no Z, demo documents say so).
 */
import { describe, expect, it } from 'vitest';
import { CASHIER_DISCOUNT_MAX_PCT, DEMO_MANAGER_PIN, lineTotal, MockTillEngine, vatOf } from '../src/shared/till/mockEngine';
import { MUTATING_OPS, TILL_ERRORS, type TILL_OPS, tillBusy, type EngineEvent, type EngineReply, type HwRequest, type TillState } from '../src/shared/till/protocol';

function setup(o: ConstructorParameters<typeof MockTillEngine>[0] = {}) {
  const timers: Array<() => void> = [];
  const engine = new MockTillEngine({ now: () => Date.UTC(2026, 9, 9, 12), schedule: (fn) => void timers.push(fn), ...o });
  const events: EngineEvent[] = [];
  engine.on((e) => events.push(e));
  let id = 0;
  let op = 0;
  const call = (name: (typeof TILL_OPS)[number], args: unknown = {}, clientOpId?: string): Promise<EngineReply> => {
    id += 1;
    op += 1;
    return engine.call({ id, op: name, args, clientOpId: MUTATING_OPS.has(name) ? (clientOpId ?? `op-${op}`) : undefined });
  };
  const state = () => engine.snapshot() as TillState;
  return { engine, events, call, state, timers };
}

const ok = (r: EngineReply) => {
  if (!r.ok) throw new Error(`refused: ${r.error.code}`);
  return r.value;
};

describe('the protocol rules', () => {
  it('starts with a full state on hello, demo, the shift open, no cart', () => {
    const { engine } = setup();
    const h = engine.hello();
    expect(h.protocol).toBe(1);
    expect(h.seq).toBe(1);
    expect(h.state.session.demo).toBe(true);
    expect(h.state.shift.open).toBe(true);
    expect(h.state.sell.lines).toEqual([]);
    expect(tillBusy(h.state)).toBe(false);
  });

  it('refuses a changing op without a clientOpId, and an unknown op', async () => {
    const { engine } = setup();
    const r = await engine.call({ id: 1, op: 'sell.add', args: { productId: 'p1' } });
    expect(r).toMatchObject({ ok: false, error: { code: 'missing_client_op_id' } });
    const u = await engine.call({ id: 2, op: 'nope' as never });
    expect(u).toMatchObject({ ok: false, error: { code: 'unknown_op' } });
  });

  it('applies an op ONCE per clientOpId (a resend after a reconnect is the same op)', async () => {
    const { call, state } = setup();
    ok(await call('sell.add', { productId: 'p1' }, 'same'));
    const again = await call('sell.add', { productId: 'p1' }, 'same');
    expect(again.ok).toBe(true);
    expect(state().sell.lines).toHaveLength(1);
    expect(state().sell.lines[0].qty).toBe(1);
    ok(await call('sell.add', { productId: 'p1' }, 'other'));
    expect(state().sell.lines[0].qty).toBe(2);
  });

  it('raises seq and sends the state on every change, not on a read', async () => {
    const { call, events } = setup();
    await call('catalog.snapshot');
    expect(events.filter((e) => e.ev === 'state')).toHaveLength(0);
    await call('sell.add', { productId: 'p1' });
    await call('sell.add', { productId: 'p2' });
    const seqs = events.filter((e) => e.ev === 'state').map((e) => e.seq);
    expect(seqs).toEqual([2, 3]);
  });

  it('every error has a Hebrew text', () => {
    for (const [code, text] of Object.entries(TILL_ERRORS)) {
      expect(code).toMatch(/^[a-z_]+$/);
      expect(text).toMatch(/[֐-׿]/);
    }
  });
});

describe('selling', () => {
  it('totals lines, quantities and VAT inside', async () => {
    const { call, state } = setup();
    ok(await call('sell.add', { productId: 'p1' })); // אספרסו 9.00
    ok(await call('sell.add', { productId: 'p4', qty: 2 })); // הפוך גדול 16.00 ×2
    const s = state().sell;
    expect(s.totalAgorot).toBe(900 + 3200);
    expect(s.itemCount).toBe(3);
    expect(s.vatAgorot).toBe(vatOf(4100));
    expect(vatOf(11800)).toBe(1800);
    ok(await call('sell.setQty', { lineId: s.lines[1].lineId, qty: 0 }));
    expect(state().sell.lines).toHaveLength(1);
    ok(await call('sell.remove', { lineId: state().sell.lines[0].lineId }));
    expect(state().sell.totalAgorot).toBe(0);
  });

  it('refuses bad quantities and unknown products', async () => {
    const { call } = setup();
    expect(await call('sell.add', { productId: 'nope' })).toMatchObject({ ok: false, error: { code: 'invalid_args' } });
    expect(await call('sell.add', { productId: 'p1', qty: 0 })).toMatchObject({ ok: false });
    expect(await call('sell.add', { productId: 'p1', qty: 1.5 })).toMatchObject({ ok: false });
  });

  it('a discount above the cashier\'s limit is the ENGINE\'s manager dialog', async () => {
    const { call, state } = setup();
    ok(await call('sell.add', { productId: 'p1' }));
    const lineId = state().sell.lines[0].lineId;
    ok(await call('sell.discount', { lineId, pct: 10 }));
    expect(state().sell.lines[0].totalAgorot).toBe(lineTotal(1, 900, 10));
    const r = ok(await call('sell.discount', { lineId, pct: CASHIER_DISCOUNT_MAX_PCT + 30 })) as { dialogId: string };
    const dialog = state().dialog!;
    expect(dialog.id).toBe(r.dialogId);
    expect(dialog.kind).toBe('manager_approval');
    expect(tillBusy(state())).toBe(true);
    expect(await call('dialog.answer', { dialogId: dialog.id, action: 'approve', answers: { pin: '0000' } })).toMatchObject({ ok: false, error: { code: 'wrong_pin' } });
    expect(state().dialog).not.toBeNull();
    ok(await call('dialog.answer', { dialogId: dialog.id, action: 'approve', answers: { pin: DEMO_MANAGER_PIN } }));
    expect(state().dialog).toBeNull();
    expect(state().sell.lines[0].discountPct).toBe(50);
  });

  it('a manager may give it without asking', async () => {
    const { call, state } = setup();
    ok(await call('session.login', { pin: DEMO_MANAGER_PIN }));
    ok(await call('sell.add', { productId: 'p1' }));
    ok(await call('sell.discount', { lineId: state().sell.lines[0].lineId, pct: 50 }));
    expect(state().dialog).toBeNull();
  });

  it('a locked till sells nothing', async () => {
    const { call, state } = setup();
    ok(await call('session.logout'));
    expect(state().session.locked).toBe(true);
    expect(await call('sell.add', { productId: 'p1' })).toMatchObject({ ok: false, error: { code: 'permission_denied' } });
    expect(await call('session.login', { pin: '12' })).toMatchObject({ ok: false, error: { code: 'wrong_pin' } });
    ok(await call('session.login', { pin: '5555' }));
    ok(await call('sell.add', { productId: 'p1' }));
  });
});

describe('paying', () => {
  it('cash: tender → done, change, a demo document, the drawer and the receipt asked of the host', async () => {
    const { call, state, events } = setup({ printerTarget: 'demo://printer', drawerTarget: 'demo://printer' });
    expect(await call('checkout.start')).toMatchObject({ ok: false, error: { code: 'cart_empty' } });
    ok(await call('sell.add', { productId: 'p2' })); // 12.00
    ok(await call('checkout.start'));
    expect(state().checkout.phase).toBe('tender');
    expect(await call('sell.add', { productId: 'p1' })).toMatchObject({ ok: false, error: { code: 'checkout_busy' } });
    ok(await call('checkout.cash', { amountAgorot: 2000 }));
    const c = state().checkout;
    expect(c.phase).toBe('done');
    expect(c.changeAgorot).toBe(800);
    expect(c.documentRef).toMatch(/^הדגמה-/);
    expect(state().shift.salesCount).toBe(1);
    expect(state().shift.cashAgorot).toBe(1200);
    const hw = events.filter((e) => e.ev === 'hw').map((e) => e.data as HwRequest);
    expect(hw.map((h) => h.type)).toEqual(['hw.drawer', 'hw.print']);
    const print = hw[1] as Extract<HwRequest, { type: 'hw.print' }>;
    expect(print.target).toBe('demo://printer');
    expect(print.bytesB64.length).toBeGreaterThan(100);
    ok(await call('checkout.finish'));
    expect(state().checkout.phase).toBe('idle');
    expect(state().sell.lines).toEqual([]);
  });

  it('card: refused without a terminal; with one, pending first, then approved', async () => {
    const plain = setup();
    ok(await plain.call('sell.add', { productId: 'p1' }));
    ok(await plain.call('checkout.start'));
    expect(await plain.call('checkout.card')).toMatchObject({ ok: false, error: { code: 'terminal_unavailable' } });

    const { call, state, timers } = setup({ terminal: true });
    ok(await call('sell.add', { productId: 'p1' }));
    ok(await call('checkout.start'));
    ok(await call('checkout.card'));
    expect(state().checkout.phase).toBe('card_waiting');
    expect(state().checkout.legs[0]).toMatchObject({ method: 'card', status: 'pending' });
    expect(tillBusy(state())).toBe(true);
    expect(await call('checkout.cancel')).toMatchObject({ ok: false, error: { code: 'card_in_flight' } });
    timers.shift()!();
    expect(state().checkout.phase).toBe('done');
    expect(state().shift.cardAgorot).toBe(900);
  });

  it('cancel: back to the cart when only cash was taken', async () => {
    const { call, state } = setup();
    ok(await call('sell.add', { productId: 'p4' }));
    ok(await call('checkout.start'));
    ok(await call('checkout.cash', { amountAgorot: 500 }));
    ok(await call('checkout.cancel'));
    expect(state().checkout.phase).toBe('idle');
    expect(state().sell.lines).toHaveLength(1);
  });

  it('the host\'s hardware answer: a failed print says so', async () => {
    const { call, state, events } = setup({ printerTarget: 'demo://printer' });
    ok(await call('sell.add', { productId: 'p1' }));
    ok(await call('checkout.start'));
    ok(await call('checkout.cash', { amountAgorot: 900 }));
    const req = events.find((e) => e.ev === 'hw')!.data as HwRequest;
    ok(await call('hw.result', { requestId: req.requestId, ok: false, code: 'offline', message: 'אין חיבור' }));
    expect(state().health.printer).toBe('error');
    expect(events.some((e) => e.ev === 'toast')).toBe(true);
  });
});

describe('the shift, Z and roles', () => {
  it('closes with an X and the difference; refuses a close mid-sale; reopens', async () => {
    const { call, state } = setup();
    ok(await call('sell.add', { productId: 'p1' }));
    expect(await call('shift.close', { countedCashAgorot: 0 })).toMatchObject({ ok: false, error: { code: 'checkout_busy' } });
    ok(await call('checkout.start'));
    ok(await call('checkout.cash', { amountAgorot: 900 }));
    ok(await call('checkout.finish'));
    const x = ok(await call('report.x')) as { expectedCashAgorot: number; demo: boolean };
    expect(x.expectedCashAgorot).toBe(20_000 + 900);
    expect(x.demo).toBe(true);
    const closed = ok(await call('shift.close', { countedCashAgorot: 20_800 })) as { differenceAgorot: number };
    expect(closed.differenceAgorot).toBe(-100);
    expect(state().shift.open).toBe(false);
    expect(await call('checkout.start')).toMatchObject({ ok: false });
    ok(await call('shift.open', { openingCashAgorot: 10_000 }));
    expect(state().shift.number).toBe(2);
  });

  it('never produces a Z in demo', async () => {
    const { call, state } = setup();
    expect(await call('z.produce')).toMatchObject({ ok: false, error: { code: 'z_not_in_demo' } });
    expect(state().z.canProduce).toBe(false);
  });

  it('switches role only to an allowed one, never mid-sale, and to a screen role only with the shift closed', async () => {
    const none = setup();
    expect(await none.call('mode.switch', { to: 'kiosk' })).toMatchObject({ ok: false, error: { code: 'role_not_allowed' } });

    const { call, state } = setup({ rolesAllowed: ['till', 'kiosk', 'kds'] });
    ok(await call('sell.add', { productId: 'p1' }));
    expect(await call('mode.switch', { to: 'kiosk' })).toMatchObject({ ok: false, error: { code: 'mode_switch_busy' } });
    ok(await call('sell.clear'));
    expect(await call('mode.switch', { to: 'kds' })).toMatchObject({ ok: false, error: { code: 'role_switch_open_shift' } });
    ok(await call('mode.switch', { to: 'kiosk' }));
    expect(state().mode.current).toBe('kiosk');
  });
});
