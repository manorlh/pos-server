/**
 * "מצב עבודה: קיוסק / קופה" at work (main/workMode.ts) — the runtime over fakes (no Electron, no network, no
 * real clock): the switch both ways and its refusals, the owner's gate, persistence across a restart, the idle
 * return and its notice, the dashboard's commands (run / wait / done / `commandsDone` until the cloud stops
 * listing them), a till by role's kiosk mode (and its first kiosk config asked of the cloud), the manager's
 * code and its lock, what the cloud hears.
 */

import bcrypt from 'bcryptjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RosterUser } from '../src/core/desktopExit';
import { KIOSK_TILL_MODE, KIOSK_AT_REST, MANAGER_TEXT, NO_TILL_FACTS, REFUSAL_TEXT, type KioskSideFacts, type TillFacts, type TillModeRefusal } from '../src/core/workMode';
import { WorkModeRuntime, WorkSessions, type KvLike } from '../src/main/workMode';

class MemKv implements KvLike {
  readonly map = new Map<string, string>();
  get(k: string) {
    return this.map.get(k) ?? null;
  }
  set(k: string, v: string) {
    this.map.set(k, v);
  }
  delete(k: string) {
    this.map.delete(k);
  }
}

const hash = (pin: string) => bcrypt.hashSync(pin, 4);
const SHOP = '2b67dd9e-6541-43eb-b2f3-6d26b6ecb03d';
function person(over: Partial<RosterUser> & { pin?: string }): RosterUser {
  const { pin, ...rest } = over;
  return { id: 'u', username: 'x', firstName: 'דנה', lastName: 'כהן', pinHash: hash(pin ?? '1111'), role: 'cashier', isActive: true, shopId: SHOP, permissions: null, ...rest };
}
const manager = person({ id: 'mgr', username: 'boss', firstName: 'מנהלת', lastName: 'סניף', pin: '4821', role: 'shop_manager', permissions: { [KIOSK_TILL_MODE]: 'allow' } });
const cashier = person({ id: 'cash', username: 'cash', firstName: 'קופאי', lastName: '', pin: '1357', permissions: { [KIOSK_TILL_MODE]: 'deny' } });

const KIOSK_ROW = { kiosk: true, homeRole: 'kiosk', configVersion: 'v1' };
const TILL_ROW = { kiosk: true, homeRole: 'till', configVersion: 'v1' };
const NO_ROW = { kiosk: false };

interface WorldOptions {
  kv?: MemKv;
  snapshot?: Record<string, unknown> | null;
  deviceRole?: unknown;
  gate?: boolean | string;
  idle?: number;
  startAt?: number;
}

/** One device: the cloud's word, the clock, the till engine's facts, and what the runtime did about them. */
function world(o: WorldOptions = {}) {
  const kv = o.kv ?? new MemKv();
  const w = {
    kv,
    now: o.startAt ?? 1_800_000_000_000,
    paired: true,
    fiscal: true,
    snapshot: (o.snapshot === undefined ? KIOSK_ROW : o.snapshot) as Record<string, unknown> | null,
    deviceRole: (o.deviceRole === undefined ? 'kiosk' : o.deviceRole) as unknown,
    parameters: { kioskTillModeEnabled: o.gate === undefined ? true : o.gate, ...(o.idle === undefined ? {} : { kioskTillModeIdleReturnMinutes: o.idle }) } as Record<string, unknown>,
    roster: [manager, cashier] as RosterUser[],
    kioskFacts: { ...KIOSK_AT_REST } as KioskSideFacts,
    card: false,
    till: { ...NO_TILL_FACTS } as TillFacts,
    events: [] as Array<{ details: Record<string, unknown>; posUserId: string | null }>,
    changes: 0,
    syncs: 0,
    asked: [] as boolean[],
    signedOut: 0,
    log: [] as string[],
    /** What the cloud does on kiosk/sync (a test sets it: a reply, or nothing). */
    onSync: (() => undefined) as () => void | Promise<void>,
    tick: (ms: number) => {
      w.now += ms;
    },
  };
  const make = (sessions = new WorkSessions(kv)) => {
    const rt: WorkModeRuntime = new WorkModeRuntime({
      sessions,
      kv,
      now: () => w.now,
      paired: () => w.paired,
      fiscal: () => w.fiscal,
      snapshot: () => w.snapshot,
      deviceRole: () => w.deviceRole,
      parameters: () => w.parameters,
      roster: () => w.roster,
      shopId: () => SHOP,
      kioskFacts: () => w.kioskFacts,
      cardInFlight: () => w.card,
      kioskSync: async () => {
        w.syncs += 1;
        w.asked.push(rt.kioskModeRequested());
        await w.onSync();
      },
      recordEvent: (details, posUserId) => void w.events.push({ details, posUserId }),
      changed: () => void (w.changes += 1),
      compare: (p, h) => bcrypt.compare(p, h),
      log: (m) => void w.log.push(m),
    });
    rt.setTillFacts(() => w.till);
    rt.setTillSignOut(() => void (w.signedOut += 1));
    return rt;
  };
  return { w, kv, make, rt: make() };
}

/** A refusal's wire code (null: none). */
const code = (r: TillModeRefusal | null) => r?.wire ?? null;
const employee = { id: 'e1', name: 'דנה כהן' };
/** The cloud's reply as the sync engine hands it to the hook: the snapshot changes, then the hook runs. */
function reply(w: ReturnType<typeof world>['w'], rt: WorkModeRuntime, next: Record<string, unknown>) {
  const prev = w.snapshot;
  w.snapshot = next;
  rt.onKioskReply(next, prev);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('where it exists — only with the owner’s gate on, only on a till or a kiosk', () => {
  it('the gate off: nothing is offered anywhere, the switch is refused', async () => {
    const { rt, w } = world({ gate: false });
    expect(rt.params()).toEqual({ enabled: false, idleReturnMinutes: 3 });
    expect(rt.offered()).toEqual({ toTill: false, toKiosk: false });
    expect(rt.view().enabled).toBe(false);
    expect(code(rt.mayEnter())).toBe('disabled');
    expect(code(await rt.enterTill('מנהל', 'm', 'manual'))).toBe('disabled');
    expect(rt.mode()).toBe('kiosk');
    expect(w.events).toEqual([]);
  });

  it('the gate on: a kiosk is offered the till, not the way back (it is home)', () => {
    const { rt } = world();
    expect(rt.offered()).toEqual({ toTill: true, toKiosk: false });
    expect(rt.view()).toMatchObject({ enabled: true, mode: 'kiosk', homeTill: false, toTill: true, toKiosk: false });
  });

  it('a screen (KDS, board), an unpaired device, a till never allowed the kiosk mode: not concerned', async () => {
    const kds = world({ snapshot: NO_ROW, deviceRole: 'kds' });
    expect(kds.rt.offered()).toEqual({ toTill: false, toKiosk: false });
    expect(code(await kds.rt.returnToKiosk('manual'))).toBe('disabled');
    const unfiscal = world();
    unfiscal.w.fiscal = false;
    expect(unfiscal.rt.offered()).toEqual({ toTill: false, toKiosk: false });
    const unpaired = world();
    unpaired.w.paired = false;
    expect(unpaired.rt.offered()).toEqual({ toTill: false, toKiosk: false });
    const unknown = world({ snapshot: null, deviceRole: null });
    expect(unknown.rt.offered()).toEqual({ toTill: false, toKiosk: false });
    expect(unknown.rt.statusFields()).toEqual({});
  });
});

describe('to the till — from the kiosk, by a manager', () => {
  it('refused over a kiosk customer’s payment or order, with the Android words', async () => {
    const { rt, w } = world();
    w.kioskFacts = { ...KIOSK_AT_REST, paying: true };
    expect(code(rt.mayEnter())).toBe('kiosk_payment');
    expect(code(await rt.enterTill('מנהל', 'm', 'manual'))).toBe('kiosk_payment');
    w.kioskFacts = { ...KIOSK_AT_REST, ordering: true };
    expect(code(await rt.enterTill('מנהל', 'm', 'manual'))).toBe('customer_ordering');
    expect(REFUSAL_TEXT.customer_ordering).toContain('איפוס מסך לקוח');
    w.kioskFacts = KIOSK_AT_REST;
    w.card = true;
    expect(code(await rt.enterTill('מנהל', 'm', 'manual'))).toBe('kiosk_payment');
    expect(rt.mode()).toBe('kiosk');
    expect(w.events).toEqual([]);
  });

  it('done: the till session, the event (who, how, no fiscal move), the cloud told at once, the change delivered', async () => {
    const { rt, w, kv } = world();
    const changes = vi.fn();
    rt.onChange(changes);
    expect(await rt.enterTill('מנהלת סניף', 'mgr', 'manual')).toBeNull();
    expect(rt.mode()).toBe('till');
    expect(rt.offered()).toEqual({ toTill: false, toKiosk: true });
    expect(w.events).toHaveLength(1);
    expect(w.events[0]).toMatchObject({ posUserId: 'mgr', details: { action: 'enter', mode: 'till', reason: 'manual', by: 'מנהלת סניף', byId: 'mgr', employee: null } });
    expect(w.syncs).toBe(1);
    expect(w.changes).toBeGreaterThan(0);
    expect(changes).toHaveBeenCalled();
    expect(JSON.parse(kv.get('workMode.till')!)).toMatchObject({ by: 'מנהלת סניף', byId: 'mgr', source: 'manual' });
    // Already a till: nothing again.
    expect(await rt.enterTill('מנהלת סניף', 'mgr', 'manual')).toBeNull();
    expect(w.events).toHaveLength(1);
  });

  it('survives a restart: the device boots back into the till, who and when kept; the kiosk row still reports', async () => {
    const first = world();
    await first.rt.enterTill('מנהלת סניף', 'mgr', 'manual');
    const again = world({ kv: first.kv, startAt: first.w.now + 3_600_000 });
    expect(again.rt.mode()).toBe('till');
    expect(again.rt.inTillSession()).toBe(true);
    expect(again.rt.statusFields()).toMatchObject({ flowState: 'till_mode', tillMode: { enteredBy: 'מנהלת סניף', source: 'manual' } });
    expect(again.rt.statusFields().tillMode?.since).toBe(new Date(first.w.now).toISOString());
  });
});

describe('back to the kiosk — never over a sale, held sales wait', () => {
  async function inTill(o: WorldOptions = {}) {
    const x = world(o);
    await x.rt.enterTill('מנהלת סניף', 'mgr', 'manual');
    x.w.events.length = 0;
    x.w.syncs = 0;
    return x;
  }

  it('refused with a basket, a payment screen, a tender, a card, a table — the reason in Hebrew', async () => {
    const { rt, w } = await inTill();
    w.till = { ...NO_TILL_FACTS, basketOpen: true };
    expect(code(rt.mayReturn())).toBe('basket_open');
    expect(code(await rt.returnToKiosk('manual'))).toBe('basket_open');
    w.till = { ...NO_TILL_FACTS, checkoutOpen: true };
    expect(code(await rt.returnToKiosk('manual'))).toBe('payment_open');
    w.till = { ...NO_TILL_FACTS, holdsTender: true };
    expect(code(await rt.returnToKiosk('manual'))).toBe('payment_open');
    w.till = { ...NO_TILL_FACTS, tableOpen: true };
    expect(code(await rt.returnToKiosk('manual'))).toBe('table_open');
    w.till = NO_TILL_FACTS;
    w.card = true;
    expect(code(await rt.returnToKiosk('manual'))).toBe('payment_open');
    expect(rt.mode()).toBe('till');
    expect(w.events).toEqual([]);
    expect(w.signedOut).toBe(0);
  });

  it('held sales never block: the employee leaves, the way back is recorded with their count, the notice is said once', async () => {
    const { rt, w, kv } = await inTill();
    w.till = { ...NO_TILL_FACTS, heldSales: 3, employee };
    expect(await rt.returnToKiosk('manual', 'דנה כהן', 'e1')).toBeNull();
    expect(rt.mode()).toBe('kiosk');
    expect(rt.heldNotice()).toBe(3);
    expect(w.signedOut).toBe(1);
    expect(kv.get('workMode.till')).toBeNull();
    expect(w.events[0]).toMatchObject({ posUserId: 'e1', details: { action: 'exit', mode: 'kiosk', reason: 'manual', by: 'דנה כהן', byId: 'e1', employee: 'דנה כהן', heldSales: 3 } });
    expect(w.syncs).toBe(1);
    rt.dismissHeldNotice();
    expect(rt.heldNotice()).toBeNull();
    // Already the kiosk.
    expect(await rt.returnToKiosk('manual')).toBeNull();
    expect(w.events).toHaveLength(1);
  });

  it('with no one named, the employee signed in is who it is recorded for', async () => {
    const { rt, w } = await inTill();
    w.till = { ...NO_TILL_FACTS, employee };
    await rt.returnToKiosk('manual');
    expect(w.events[0].details).toMatchObject({ by: 'דנה כהן', byId: 'e1', employee: 'דנה כהן' });
  });

  it('a restart in the kiosk after the way back: no till session is kept', async () => {
    const { rt, w, kv } = await inTill();
    await rt.returnToKiosk('manual');
    const again = world({ kv, startAt: w.now + 1_000 });
    expect(again.rt.mode()).toBe('kiosk');
  });
});

describe('the idle return — a kiosk by role in till mode only, at rest only', () => {
  async function inTill(o: WorldOptions = {}) {
    const x = world({ idle: 3, ...o });
    await x.rt.enterTill('מנהלת סניף', 'mgr', 'manual');
    x.w.events.length = 0;
    return x;
  }

  it('after the minutes without a touch it goes back, with its notice 30 s before (נשארים starts it over)', async () => {
    const { rt, w } = await inTill();
    w.till = { ...NO_TILL_FACTS, lastActivityAtMs: w.now };
    w.tick(100_000);
    expect(rt.countdownSec()).toBeNull();
    await rt.tick();
    expect(rt.mode()).toBe('till');
    w.tick(50_000); // 150 s idle
    expect(rt.countdownSec()).toBe(30);
    expect(rt.view().countdownSec).toBe(30);
    w.tick(20_500);
    expect(rt.countdownSec()).toBe(10);
    await rt.tick();
    expect(rt.mode()).toBe('till');
    // "נשארים": a touch — the clock starts again.
    rt.stay();
    expect(rt.countdownSec()).toBeNull();
    w.tick(179_000);
    await rt.tick();
    expect(rt.mode()).toBe('till');
    w.tick(1_000);
    await rt.tick();
    expect(rt.mode()).toBe('kiosk');
    expect(w.events[0].details).toMatchObject({ action: 'exit', reason: 'idle' });
    expect(rt.countdownSec()).toBeNull();
  });

  it('a touch of the till’s screens counts; so does a touch of the shell', async () => {
    const { rt, w } = await inTill();
    w.tick(170_000);
    w.till = { ...NO_TILL_FACTS, lastActivityAtMs: w.now - 1_000 };
    await rt.tick();
    expect(rt.mode()).toBe('till');
    w.tick(170_000);
    rt.touched();
    await rt.tick();
    expect(rt.mode()).toBe('till');
  });

  it('never with a basket, a payment or a table open — it waits; once they are gone it goes; held sales do not hold it', async () => {
    const { rt, w } = await inTill();
    w.till = { ...NO_TILL_FACTS, basketOpen: true, lastActivityAtMs: w.now };
    w.tick(10 * 60_000);
    expect(rt.countdownSec()).toBeNull();
    await rt.tick();
    expect(rt.mode()).toBe('till');
    w.till = { ...NO_TILL_FACTS, heldSales: 2, lastActivityAtMs: w.now - 10 * 60_000 };
    await rt.tick();
    expect(rt.mode()).toBe('kiosk');
    expect(rt.heldNotice()).toBe(2);
  });

  it('0 minutes = never', async () => {
    const { rt, w } = await inTill({ idle: 0 });
    w.tick(5 * 3_600_000);
    await rt.tick();
    expect(rt.mode()).toBe('till');
    expect(rt.countdownSec()).toBeNull();
  });

  it('a till by role at home never returns by itself', async () => {
    const { rt, w } = world({ snapshot: NO_ROW, deviceRole: 'till', idle: 1 });
    w.tick(3_600_000);
    await rt.tick();
    expect(rt.mode()).toBe('till');
    expect(rt.countdownSec()).toBeNull();
    expect(w.events).toEqual([]);
  });

  it('the tick runs by itself: every 2 s in till mode, and the owner’s gate closing sends the device home', async () => {
    vi.useFakeTimers();
    const { rt, w } = await inTill();
    rt.start();
    w.parameters.kioskTillModeEnabled = false;
    await vi.advanceTimersByTimeAsync(2_100);
    expect(rt.mode()).toBe('kiosk');
    rt.stop();
  });
});

describe('the owner’s gate closes — back home as soon as nothing is open', () => {
  it('a kiosk in till mode waits for the sale, then goes (reason: cloud); the till session is gone', async () => {
    const { rt, w, kv } = world();
    await rt.enterTill('מנהלת סניף', 'mgr', 'manual');
    w.events.length = 0;
    w.parameters.kioskTillModeEnabled = false;
    w.till = { ...NO_TILL_FACTS, basketOpen: true };
    await rt.tick();
    expect(rt.mode()).toBe('till');
    expect(rt.offered()).toEqual({ toTill: false, toKiosk: true });
    w.till = NO_TILL_FACTS;
    await rt.tick();
    expect(rt.mode()).toBe('kiosk');
    expect(w.events[0].details).toMatchObject({ action: 'exit', reason: 'cloud' });
    expect(kv.get('workMode.till')).toBeNull();
    expect(rt.offered()).toEqual({ toTill: false, toKiosk: false });
  });

  it('a till by role away in its kiosk mode comes home — but never over a customer', async () => {
    const x = world({ snapshot: TILL_ROW, deviceRole: 'till' });
    expect(await x.rt.returnToKiosk('manual', 'מנהל', 'mgr')).toBeNull();
    expect(x.rt.mode()).toBe('kiosk');
    x.w.events.length = 0;
    x.w.parameters.kioskTillModeEnabled = false;
    x.w.kioskFacts = { ...KIOSK_AT_REST, ordering: true };
    await x.rt.tick();
    expect(x.rt.mode()).toBe('kiosk');
    x.w.kioskFacts = KIOSK_AT_REST;
    await x.rt.tick();
    expect(x.rt.mode()).toBe('till');
    expect(x.w.events[0].details).toMatchObject({ action: 'enter', reason: 'cloud' });
  });
});

describe('the dashboard’s switch — enter_till / return_kiosk, both ways', () => {
  it('enter_till: carried out when it may, answered as done until the cloud stops listing it', async () => {
    const { rt, w, kv } = world();
    reply(w, rt, { ...KIOSK_ROW, workMode: { id: 'c1', mode: 'till', by: 'דנה' } });
    await rt.tick();
    expect(rt.mode()).toBe('till');
    expect(w.events[0]).toMatchObject({ posUserId: null, details: { action: 'enter', reason: 'remote', by: 'דנה', commandId: 'c1' } });
    expect(rt.statusFields().commandsDone).toEqual(['c1']);
    expect(JSON.parse(kv.get('workMode.done')!)).toEqual(['c1']);
    // The cloud still lists it (it has not heard yet): said again, never run again.
    w.till = NO_TILL_FACTS;
    await rt.returnToKiosk('manual');
    w.events.length = 0;
    reply(w, rt, { ...KIOSK_ROW, workMode: { id: 'c1', mode: 'till', by: 'דנה' } });
    await rt.tick();
    expect(rt.mode()).toBe('kiosk');
    expect(w.events).toEqual([]);
    expect(rt.statusFields().commandsDone).toEqual(['c1']);
    // The cloud took it: it no longer lists it, nothing more to say.
    reply(w, rt, { ...KIOSK_ROW, workMode: null });
    expect(rt.statusFields().commandsDone).toBeUndefined();
    expect(kv.get('workMode.done')).toBeNull();
    // …and a later command with another id works as the first.
    reply(w, rt, { ...KIOSK_ROW, workMode: { id: 'c2', mode: 'till', by: 'דנה' } });
    await rt.tick();
    expect(rt.mode()).toBe('till');
  });

  it('enter_till over a customer’s order: it waits, then runs; the cloud hears nothing wrong', async () => {
    const { rt, w } = world();
    w.kioskFacts = { ...KIOSK_AT_REST, ordering: true };
    reply(w, rt, { ...KIOSK_ROW, workMode: { id: 'c1', mode: 'till', by: 'דנה' } });
    await rt.tick();
    expect(rt.mode()).toBe('kiosk');
    expect(code(rt.blockedReason())).toBe('customer_ordering');
    expect(rt.statusFields().commandsDone).toBeUndefined();
    // Still a kiosk: only the reason goes up ("ממתין — לקוח באמצע הזמנה"), no till mode yet.
    expect(rt.statusFields()).toEqual({ tillMode: { since: null, enteredBy: null, employee: null, source: null, returnBlocked: 'customer_ordering' } });
    w.kioskFacts = KIOSK_AT_REST;
    await rt.tick();
    expect(rt.mode()).toBe('till');
    expect(code(rt.blockedReason())).toBeNull();
    expect(rt.statusFields().commandsDone).toEqual(['c1']);
  });

  it('return_kiosk with a sale open: it waits and says why on every status (tillMode.returnBlocked) — held sales do not block', async () => {
    const { rt, w } = world();
    await rt.enterTill('מנהלת סניף', 'mgr', 'manual');
    w.events.length = 0;
    w.till = { ...NO_TILL_FACTS, basketOpen: true, employee, heldSales: 2, lastActivityAtMs: w.now };
    reply(w, rt, { ...KIOSK_ROW, workMode: { id: 'r1', mode: 'kiosk', by: 'דנה' } });
    await rt.tick();
    expect(rt.mode()).toBe('till');
    expect(code(rt.blockedReason())).toBe('basket_open');
    expect(rt.statusFields()).toMatchObject({ flowState: 'till_mode', tillMode: { returnBlocked: 'basket_open', employee: 'דנה כהן', enteredBy: 'מנהלת סניף' } });
    expect(rt.statusFields().commandsDone).toBeUndefined();
    w.till = { ...NO_TILL_FACTS, employee, heldSales: 2, lastActivityAtMs: w.now };
    await rt.tick();
    expect(rt.mode()).toBe('kiosk');
    expect(code(rt.blockedReason())).toBeNull();
    expect(w.events[0]).toMatchObject({ details: { action: 'exit', reason: 'remote', by: 'דנה', commandId: 'r1', heldSales: 2 } });
    expect(rt.statusFields().commandsDone).toEqual(['r1']);
  });

  it('a command for the mode already on is done at once; with the gate closed it is answered and nothing moves', async () => {
    const same = world();
    reply(same.w, same.rt, { ...KIOSK_ROW, workMode: { id: 'c1', mode: 'kiosk', by: null } });
    await same.rt.tick();
    expect(same.rt.statusFields().commandsDone).toEqual(['c1']);
    expect(same.w.events).toEqual([]);
    const closed = world({ gate: false });
    reply(closed.w, closed.rt, { ...KIOSK_ROW, workMode: { id: 'c2', mode: 'till', by: null } });
    await closed.rt.tick();
    expect(closed.rt.mode()).toBe('kiosk');
    expect(closed.rt.statusFields().commandsDone).toEqual(['c2']);
    expect(code(closed.rt.blockedReason())).toBeNull();
  });

  it('the answers survive a restart, and so does a command still waiting for the cloud to hear them', async () => {
    const first = world();
    reply(first.w, first.rt, { ...KIOSK_ROW, workMode: { id: 'c1', mode: 'till', by: 'דנה' } });
    await first.rt.tick();
    const again = world({ kv: first.kv, startAt: first.w.now + 60_000 });
    expect(again.rt.statusFields().commandsDone).toEqual(['c1']);
    // The cloud lists it once more after the restart: not run again (it is a till now, and was handled).
    await again.rt.returnToKiosk('manual');
    again.w.events.length = 0;
    reply(again.w, again.rt, { ...KIOSK_ROW, workMode: { id: 'c1', mode: 'till', by: 'דנה' } });
    await again.rt.tick();
    expect(again.rt.mode()).toBe('kiosk');
    expect(again.w.events).toEqual([]);
  });

  it('a switch the door refuses at the last moment keeps waiting (never marked done)', async () => {
    const { rt, w } = world();
    // The customer starts an order between the check (a customer at rest) and the switch (a customer ordering).
    let looks = 0;
    w.kioskFacts = new Proxy({ ...KIOSK_AT_REST }, {
      get: (t, k) => (k === 'ordering' ? ++looks > 1 : (t as never)[k]),
    });
    reply(w, rt, { ...KIOSK_ROW, workMode: { id: 'c1', mode: 'till', by: 'דנה' } });
    await rt.tick();
    expect(rt.mode()).toBe('kiosk');
    expect(rt.statusFields().commandsDone).toBeUndefined();
    expect(code(rt.blockedReason())).toBe('customer_ordering');
    w.kioskFacts = KIOSK_AT_REST;
    await rt.tick();
    expect(rt.mode()).toBe('till');
  });
});

describe('a till by role — its kiosk mode is the second mode', () => {
  it('opens as a till: home is the till; "מעבר לקיוסק" is offered only where the owner allowed it', () => {
    const on = world({ snapshot: NO_ROW, deviceRole: 'till' });
    expect(on.rt.mode()).toBe('till');
    expect(on.rt.homeTill()).toBe(true);
    expect(on.rt.offered()).toEqual({ toTill: false, toKiosk: true });
    expect(on.rt.inTillSession()).toBe(false);
    const off = world({ snapshot: NO_ROW, deviceRole: 'till', gate: false });
    expect(off.rt.offered()).toEqual({ toTill: false, toKiosk: false });
    // Same for a till that already has its kiosk-mode row.
    expect(world({ snapshot: TILL_ROW, deviceRole: 'till', gate: false }).rt.offered()).toEqual({ toTill: false, toKiosk: false });
  });

  it('the first time with no kiosk config: asked of the cloud (requestKioskMode) — answered, it goes; the employee leaves; the same machine reports', async () => {
    const { rt, w, kv } = world({ snapshot: NO_ROW, deviceRole: 'till' });
    w.till = { ...NO_TILL_FACTS, employee, heldSales: 1 };
    w.onSync = () => {
      // The cloud makes the kiosk-mode row: kiosk/sync answers it (the hook runs after the snapshot is kept).
      reply(w, rt, { ...TILL_ROW });
    };
    expect(await rt.returnToKiosk('manual', 'מנהלת סניף', 'mgr')).toBeNull();
    expect(w.asked[0]).toBe(true); // the request that asked for the row
    expect(rt.kioskModeRequested()).toBe(false);
    expect(rt.mode()).toBe('kiosk');
    expect(rt.awayInKiosk()).toBe(true);
    expect(w.signedOut).toBe(1);
    expect(rt.heldNotice()).toBe(1);
    expect(w.events[0]).toMatchObject({ details: { action: 'exit', mode: 'kiosk', reason: 'manual', by: 'מנהלת סניף', byId: 'mgr', employee: 'דנה כהן', heldSales: 1 } });
    expect(JSON.parse(kv.get('workMode.kiosk')!)).toMatchObject({ by: 'מנהלת סניף', source: 'manual' });
    // …a plain sync after it does not ask again.
    expect(w.asked.slice(1).every((a) => a === false)).toBe(true);
    // It still IS a till by role: no idle return, the kiosk row reports (flowState is the kiosk's own now).
    expect(rt.homeTill()).toBe(true);
    expect(rt.statusFields()).toEqual({});
    expect(rt.offered()).toEqual({ toTill: true, toKiosk: false });
  });

  it('the first time without the cloud: kiosk_config_missing, nothing recorded, nobody signed out', async () => {
    const { rt, w } = world({ snapshot: NO_ROW, deviceRole: 'till' });
    w.till = { ...NO_TILL_FACTS, employee };
    expect(code(await rt.returnToKiosk('manual', 'מנהלת סניף', 'mgr'))).toBe('kiosk_config_missing');
    expect(REFUSAL_TEXT.kiosk_config_missing).toContain('נדרש חיבור לענן');
    expect(rt.mode()).toBe('till');
    expect(w.events).toEqual([]);
    expect(w.signedOut).toBe(0);
    expect(rt.kioskModeRequested()).toBe(false);
  });

  it('with the kiosk config already there it goes without a word to the cloud first; a sale open refuses it', async () => {
    const { rt, w } = world({ snapshot: TILL_ROW, deviceRole: 'till' });
    w.till = { ...NO_TILL_FACTS, basketOpen: true };
    expect(code(await rt.returnToKiosk('manual', 'מנהל', 'mgr'))).toBe('basket_open');
    w.till = NO_TILL_FACTS;
    expect(await rt.returnToKiosk('manual', 'מנהל', 'mgr')).toBeNull();
    expect(w.asked.some((a) => a)).toBe(false);
    expect(rt.mode()).toBe('kiosk');
    expect(rt.view()).toMatchObject({ mode: 'kiosk', homeTill: true, toTill: true, toKiosk: false });
  });

  it('with the owner’s gate closed a till at home does not go to the kiosk', async () => {
    const { rt } = world({ snapshot: TILL_ROW, deviceRole: 'till', gate: false });
    expect(code(await rt.returnToKiosk('manual', 'מנהל', 'mgr'))).toBe('disabled');
    expect(rt.mode()).toBe('till');
  });

  it('"קופה" in the kiosk’s admin brings it home; the kiosk side is checked first', async () => {
    const x = world({ snapshot: TILL_ROW, deviceRole: 'till' });
    await x.rt.returnToKiosk('manual', 'מנהל', 'mgr');
    x.w.events.length = 0;
    x.w.kioskFacts = { ...KIOSK_AT_REST, paying: true };
    expect(code(await x.rt.enterTill('מנהל', 'mgr', 'manual'))).toBe('kiosk_payment');
    x.w.kioskFacts = KIOSK_AT_REST;
    expect(await x.rt.enterTill('מנהל', 'mgr', 'manual')).toBeNull();
    expect(x.rt.mode()).toBe('till');
    expect(x.rt.awayInKiosk()).toBe(false);
    expect(x.kv.get('workMode.kiosk')).toBeNull();
    expect(x.w.events[0].details).toMatchObject({ action: 'enter', mode: 'till', reason: 'manual', by: 'מנהל' });
  });

  it('what it tells the cloud: a till at home with a kiosk row reports "till_mode" with no session; a plain till says nothing', () => {
    const home = world({ snapshot: TILL_ROW, deviceRole: 'till' });
    home.w.till = { ...NO_TILL_FACTS, employee };
    expect(home.rt.statusFields()).toEqual({
      flowState: 'till_mode',
      tillMode: { since: null, enteredBy: null, employee: 'דנה כהן', source: null, returnBlocked: null },
    });
    expect(world({ snapshot: NO_ROW, deviceRole: 'till' }).rt.statusFields()).toEqual({});
  });

  it('survives a restart away in the kiosk, and comes home with the cloud saying it is no kiosk any more', async () => {
    const first = world({ snapshot: TILL_ROW, deviceRole: 'till' });
    await first.rt.returnToKiosk('manual', 'מנהל', 'mgr');
    const again = world({ snapshot: TILL_ROW, deviceRole: 'till', kv: first.kv });
    expect(again.rt.mode()).toBe('kiosk');
    reply(again.w, again.rt, { kiosk: false });
    expect(again.rt.mode()).toBe('till');
    expect(again.kv.get('workMode.kiosk')).toBeNull();
  });

  it('a dashboard return_kiosk to a till: it goes (the cloud made its row on the dashboard’s word)', async () => {
    const { rt, w } = world({ snapshot: NO_ROW, deviceRole: 'till' });
    reply(w, rt, { ...TILL_ROW, workMode: { id: 'r1', mode: 'kiosk', by: 'דנה' } });
    await rt.tick();
    expect(rt.mode()).toBe('kiosk');
    expect(w.events[0]).toMatchObject({ details: { action: 'exit', reason: 'remote', commandId: 'r1' } });
    // Away it is a kiosk with a kiosk's own flow state, and the done id is told with every status until the cloud stops listing it.
    expect(rt.statusFields()).toEqual({ commandsDone: ['r1'] });
  });
});

describe('the cloud’s word changes the role', () => {
  it('no longer a kiosk: the till session goes with it', async () => {
    const { rt, w, kv } = world();
    await rt.enterTill('מנהלת סניף', 'mgr', 'manual');
    reply(w, rt, { kiosk: false });
    expect(kv.get('workMode.till')).toBeNull();
    expect(rt.mode()).toBe('till'); // a till by role, nothing more
    expect(rt.inTillSession()).toBe(false);
  });

  it('a till made a kiosk by role with an employee signed in (perhaps mid-sale) is never yanked away', async () => {
    const { rt, w, kv } = world({ snapshot: NO_ROW, deviceRole: 'till' });
    w.till = { ...NO_TILL_FACTS, employee, basketOpen: true };
    w.deviceRole = 'kiosk';
    reply(w, rt, { ...KIOSK_ROW });
    expect(rt.mode()).toBe('till');
    expect(rt.inTillSession()).toBe(true);
    expect(JSON.parse(kv.get('workMode.till')!)).toMatchObject({ by: 'דנה כהן', byId: 'e1', source: 'cloud' });
    expect(w.events[0].details).toMatchObject({ action: 'enter', reason: 'cloud' });
    // …with the way back to the kiosk for when they are done.
    expect(code(await rt.returnToKiosk('manual'))).toBe('basket_open');
    w.till = { ...NO_TILL_FACTS, employee };
    expect(await rt.returnToKiosk('manual', 'דנה כהן', 'e1')).toBeNull();
    expect(rt.mode()).toBe('kiosk');
  });

  it('a till made a kiosk by role with nobody signed in becomes the kiosk at once', () => {
    const { rt, w } = world({ snapshot: NO_ROW, deviceRole: 'till' });
    w.deviceRole = 'kiosk';
    reply(w, rt, { ...KIOSK_ROW });
    expect(rt.mode()).toBe('kiosk');
  });

  it('unpaired: no mode is kept', async () => {
    const { rt, w, kv } = world();
    await rt.enterTill('מנהלת סניף', 'mgr', 'manual');
    w.paired = false;
    await rt.tick();
    expect(kv.get('workMode.till')).toBeNull();
  });
});

describe('the manager’s code — the same pad rules as the desktop exit', () => {
  it('a manager with KIOSK_TILL_MODE is granted; a cashier’s own code is not', async () => {
    const { rt } = world();
    expect(await rt.checkManagerCode('4821')).toEqual({ ok: true, id: 'mgr', name: 'מנהלת סניף' });
    const wrong = await rt.checkManagerCode('1357');
    expect(wrong).toMatchObject({ ok: false, reason: 'wrong', triesLeft: 4 });
    expect(wrong.ok === false && wrong.message).toBe(MANAGER_TEXT.wrong(4));
    expect(await rt.checkManagerCode('')).toMatchObject({ ok: false, reason: 'blank' });
  });

  it('five wrong codes lock it for a minute — across a restart; a minute later it opens again', async () => {
    const first = world();
    for (let i = 0; i < 5; i++) await first.rt.checkManagerCode('0000');
    expect(await first.rt.checkManagerCode('4821')).toMatchObject({ ok: false, reason: 'locked' });
    const again = world({ kv: first.kv, startAt: first.w.now + 5_000 });
    const still = await again.rt.checkManagerCode('4821');
    expect(still).toMatchObject({ ok: false, reason: 'locked' });
    expect(still.ok === false && still.lockedForMs).toBeGreaterThan(50_000);
    again.w.tick(61_000);
    expect(await again.rt.checkManagerCode('4821')).toMatchObject({ ok: true });
  });

  it('its own lock: the desktop exit’s pad is not touched', async () => {
    const { rt, kv } = world();
    await rt.checkManagerCode('0000');
    expect(kv.get('workMode.lock')).toContain('"failures":1');
    expect(kv.get('desktopExit.lock')).toBeNull();
  });

  it('concurrent wrong codes are each counted', async () => {
    const { rt } = world();
    await Promise.all([rt.checkManagerCode('1'), rt.checkManagerCode('2'), rt.checkManagerCode('3')]);
    expect(await rt.checkManagerCode('4')).toMatchObject({ ok: false, reason: 'wrong', triesLeft: 1 });
  });

  it('no manager in the shop: said, with where to set it', async () => {
    const { rt, w } = world();
    w.roster = [cashier];
    const r = await rt.checkManagerCode('1357');
    expect(r).toMatchObject({ ok: false, reason: 'no_managers' });
    expect(r.ok === false && r.message).toContain('מעבר למצב קופה בקיוסק');
  });

  it('the user whose code is already on screen counts when they hold the permission — no second code', () => {
    const { rt } = world();
    expect(rt.holds('mgr')).toBe(true);
    expect(rt.holds('cash')).toBe(false);
    expect(rt.holds(null)).toBe(false);
    expect(rt.approval('mgr')).toBe('none');
    expect(rt.approval('cash')).toBe('manager');
  });
});

describe('the till engine’s facts and the card at the terminal', () => {
  it('until a provider is set the till side is all quiet; a provider that throws is quiet too (never a trap)', async () => {
    const { w, make } = world();
    const bare = make();
    expect(bare.tillFacts()).toEqual({ ...NO_TILL_FACTS });
    bare.setTillFacts(() => {
      throw new Error('engine down');
    });
    expect(bare.tillFacts()).toEqual({ ...NO_TILL_FACTS });
    await bare.enterTill('מנהל', 'm', 'manual');
    expect(await bare.returnToKiosk('manual')).toBeNull();
    expect(w.log.some((m) => m.includes('till facts failed'))).toBe(true);
  });

  it('a card at the terminal blocks both ways, whoever holds it', async () => {
    const { rt, w } = world();
    w.card = true;
    expect(rt.kioskFacts().cardInFlight).toBe(true);
    expect(code(await rt.enterTill('מנהל', 'm', 'manual'))).toBe('kiosk_payment');
    w.card = false;
    await rt.enterTill('מנהל', 'm', 'manual');
    w.card = true;
    expect(code(await rt.returnToKiosk('manual'))).toBe('payment_open');
  });

  it('the shell’s view: what the till shows of the mode', async () => {
    const { rt, w } = world({ idle: 3 });
    await rt.enterTill('מנהלת סניף', 'mgr', 'manual');
    w.till = { ...NO_TILL_FACTS, lastActivityAtMs: w.now };
    w.tick(160_000);
    expect(rt.view()).toEqual({ enabled: true, mode: 'till', homeTill: false, toTill: false, toKiosk: true, countdownSec: 20, heldNotice: null, blocked: null });
  });
});
