/**
 * "מגירת מזומן" on the Windows till — the Android till's acceptance cases (pos-android CashDrawerTest, DrawerAwayTest,
 * RemoteDrawerTest) against core/till/drawer.ts, core/till/drawerAway.ts and main/till/drawerService.ts, and the engine's
 * flows (main/till/tillDrawer.ts) over a real KioskService. Roles from the cloud's permissions matrix. Tests only: no real
 * drawer, printer or server.
 */

import bcrypt from 'bcryptjs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_DRAWER_SETTINGS,
  cashDrawerModeOf,
  drawerAskOpens,
  drawerAskSettingsOf,
  drawerSettingsOf,
  evaluateDrawer,
  expectedDrawer,
  hostDrawerVerdict,
  mayApproveDrawer,
  movementTotalsOf,
  remoteDrawerAction,
  remoteDrawerModeOf,
  tillWithDrawer,
  walletTotalsOf,
  type DrawerRequest,
  type DrawerSettings,
  type DrawerUser,
} from '../src/core/till/drawer';
import {
  DEFAULT_DRAWER_AWAY,
  awayPlan,
  drawerAwaySettingsOf,
  isAway,
  isHandheld,
  parseWallets,
  walletBalances,
  walletClockOutCheck,
  walletVariance,
  withPending,
  type DrawerChoice,
} from '../src/core/till/drawerAway';
import { openDb } from '../src/main/db/sqlite';
import { CashDrawerService, type DrawerPerson } from '../src/main/till/drawerService';
import { DrawerStore, cashMovementWire, drawerEventWire } from '../src/main/till/drawerStore';
import { MANAGER_PIN, PIN, harness, type Harness, type HarnessOptions } from './tillEngineHarness';

/* ------------------------------------------------------------- the roles */

const MATRIX = JSON.parse(readFileSync(path.resolve(__dirname, '..', '..', 'server', 'tests', 'fixtures', 'till_permissions_matrix.json'), 'utf8')) as {
  roles: Record<string, { states: Record<string, string>; limits: Record<string, Record<string, number>> }>;
};

const profile = (key: string): DrawerUser => ({ role: key === 'manager' ? 'shop_manager' : 'cashier', permissions: MATRIX.roles[key].states, limits: MATRIX.roles[key].limits });
const person = (id: string, key: string): DrawerPerson => ({ id, name: id, ...profile(key) });

const situation = (key: string | null, o: { shiftOpen?: boolean; settings?: DrawerSettings; opens?: number } = {}) => ({
  user: key ? profile(key) : null,
  shiftOpen: o.shiftOpen ?? true,
  settings: o.settings ?? DEFAULT_DRAWER_SETTINGS,
  manualOpensThisShift: o.opens ?? 0,
});

describe('the policy (the drawer spec §19, in its order)', () => {
  it('a cash sale opens only with its recorded sale', () => {
    expect(evaluateDrawer({ context: 'CASH_SALE' }, situation('cashier')).kind).toBe('refused');
    expect(evaluateDrawer({ context: 'CASH_SALE', saleId: 's1' }, situation('waiter'))).toEqual({ kind: 'proceed', eventType: 'CASH_SALE', permission: 'CASH_DRAWER.OPEN_ON_CASH_SALE', decision: 'allow' });
  });

  it('the spec matrix for a manual opening, a cash out, a test', () => {
    const manual: DrawerRequest = { context: 'MANUAL', reason: 'CORRECTION' };
    expect(evaluateDrawer(manual, situation('waiter')).kind).toBe('approval');
    expect(evaluateDrawer(manual, situation('cashier')).kind).toBe('approval');
    expect(evaluateDrawer(manual, situation('supervisor')).kind).toBe('proceed');
    const out: DrawerRequest = { context: 'CASH_OUT', reason: 'ספק', amountAgorot: 10_000 };
    expect(evaluateDrawer(out, situation('waiter')).kind).toBe('refused');
    expect(evaluateDrawer(out, situation('cashier')).kind).toBe('approval');
    const test: DrawerRequest = { context: 'TEST', reason: 'TEST' };
    expect(evaluateDrawer(test, situation('cashier')).kind).toBe('refused');
    expect(evaluateDrawer(test, situation('supervisor')).kind).toBe('approval');
    expect(evaluateDrawer(test, situation('manager')).kind).toBe('proceed');
  });

  it('a manual opening needs a reason, and other a note, when the till says so', () => {
    const sup = situation('supervisor');
    expect(evaluateDrawer({ context: 'MANUAL' }, sup).kind).toBe('refused');
    expect(evaluateDrawer({ context: 'MANUAL', reason: 'OTHER' }, sup).kind).toBe('refused');
    expect(evaluateDrawer({ context: 'MANUAL', reason: 'OTHER', note: 'x' }, sup).kind).toBe('proceed');
    expect(evaluateDrawer({ context: 'MANUAL' }, situation('supervisor', { settings: { ...DEFAULT_DRAWER_SETTINGS, requireReason: false } })).kind).toBe('proceed');
  });

  it('after the close it is its own permission, blocked by the setting, always marked', () => {
    const manual: DrawerRequest = { context: 'MANUAL', reason: 'CHANGE' };
    const mgr = evaluateDrawer(manual, situation('manager', { shiftOpen: false }));
    expect(mgr.eventType).toBe('AFTER_CLOSE');
    expect(mgr.permission).toBe('CASH_DRAWER.OPEN_AFTER_CLOSE');
    expect(mgr.kind).toBe('proceed');
    expect(evaluateDrawer(manual, situation('cashier', { shiftOpen: false })).kind).toBe('refused');
    expect(evaluateDrawer(manual, situation('supervisor', { shiftOpen: false })).kind).toBe('approval');
    expect(evaluateDrawer(manual, situation('manager', { shiftOpen: false, settings: { ...DEFAULT_DRAWER_SETTINGS, allowAfterClose: false } })).kind).toBe('refused');
  });

  it("limits - the shift's manual openings, the approval amount, every manual opening by a manager", () => {
    const manual: DrawerRequest = { context: 'MANUAL', reason: 'CHANGE' };
    const max = evaluateDrawer(manual, situation('supervisor', { settings: { ...DEFAULT_DRAWER_SETTINGS, maxManualPerShift: 2 }, opens: 2 }));
    expect(max.kind === 'approval' && max.why).toBe('OVER_LIMIT');
    const forced = { ...DEFAULT_DRAWER_SETTINGS, requireManagerForManual: true };
    // A manager who approves drawer actions approves themselves; a role without that is asked.
    expect(evaluateDrawer(manual, situation('supervisor', { settings: forced })).kind).toBe('proceed');
    const noApprove: DrawerUser = { ...profile('supervisor'), permissions: { ...MATRIX.roles.supervisor.states, 'CASH_DRAWER.APPROVE_OPEN': 'deny' } };
    const v = evaluateDrawer(manual, { user: noApprove, shiftOpen: true, settings: forced });
    expect(v.kind === 'approval' && v.why).toBe('SETTING');
    const out: DrawerRequest = { context: 'CASH_OUT', reason: 'ספק', amountAgorot: 15_000 };
    expect(evaluateDrawer(out, situation('manager', { settings: { ...DEFAULT_DRAWER_SETTINGS, approvalAmount: 100 } })).kind).toBe('approval');
  });

  it("a supervisor's 200 - up to it alone and approving, above it a manager", () => {
    const out = (agorot: number): DrawerRequest => ({ context: 'CASH_OUT', reason: 'ספק', amountAgorot: agorot });
    expect(evaluateDrawer(out(20_000), situation('supervisor')).kind).toBe('proceed');
    const over = evaluateDrawer(out(25_000), situation('supervisor'));
    if (over.kind !== 'approval') throw new Error('expected an approval');
    expect(mayApproveDrawer(profile('supervisor'), over)).toBe(false);
    expect(mayApproveDrawer(profile('manager'), over)).toBe(true);
    const cashier = evaluateDrawer(out(15_000), situation('cashier'));
    if (cashier.kind !== 'approval') throw new Error('expected an approval');
    expect(mayApproveDrawer(profile('supervisor'), cashier)).toBe(true);
  });

  it("a refund's payout rides on the refund's approval", () => {
    const req: DrawerRequest = { context: 'REFUND', saleId: 'credit-1', originalSaleId: 'sale-1', amountAgorot: 5_000 };
    expect(evaluateDrawer(req, situation('cashier')).kind).toBe('approval');
    expect(evaluateDrawer({ ...req, preApproved: true }, situation('cashier')).kind).toBe('proceed');
    expect(evaluateDrawer({ ...req, preApproved: true }, situation('waiter')).kind).toBe('refused');
  });

  it("the technician's test with nobody signed in, never anything else", () => {
    const test: DrawerRequest = { context: 'TEST', reason: 'TEST', technician: true };
    expect(evaluateDrawer(test, situation(null)).kind).toBe('proceed');
    expect(evaluateDrawer({ ...test, context: 'MANUAL' }, situation(null)).kind).toBe('refused');
  });

  it('a remote opening - decided under OPEN_REMOTE and every rule of its own kind', () => {
    const remote: DrawerRequest = { context: 'MANUAL', reason: 'CHANGE', remote: true };
    const cashier = evaluateDrawer(remote, situation('cashier'));
    expect(cashier).toMatchObject({ kind: 'approval', eventType: 'REMOTE_MANUAL', permission: 'CASH_DRAWER.OPEN_REMOTE' });
    expect(evaluateDrawer(remote, situation('supervisor'))).toMatchObject({ kind: 'proceed', eventType: 'REMOTE_MANUAL' });
    // The reason rule of a manual opening holds for another till's drawer too.
    expect(evaluateDrawer({ context: 'MANUAL', remote: true }, situation('supervisor')).kind).toBe('refused');
    expect(evaluateDrawer({ context: 'CASH_SALE', saleId: 's', remote: true }, situation('supervisor')).eventType).toBe('REMOTE_SALE');
  });

  it('the parameters are read the way the cloud writes them', () => {
    const s = drawerSettingsOf({
      'cashDrawer.requireReason': 'false',
      'cashDrawer.blindCount': 'true',
      'cashDrawer.maxManualOpensPerShift': '3',
      'cashDrawer.cashOutApprovalAmount': '250.5',
      'cashDrawer.allowOpenAfterClose': 'false',
    });
    expect(s).toMatchObject({ requireReason: false, blindCount: true, maxManualPerShift: 3, approvalAmount: 250.5, allowAfterClose: false });
    expect(drawerSettingsOf({})).toEqual(DEFAULT_DRAWER_SETTINGS);
  });

  it('the expected drawer and the X count the movements', () => {
    const m = movementTotalsOf([
      { type: 'cash_in', amountAgorot: 10_000 },
      { type: 'cash_out', amountAgorot: 15_000 },
      { type: 'deposit', amountAgorot: 40_000 },
      { type: 'count', amountAgorot: 1 },
    ]);
    expect(expectedDrawer({ openingAgorot: 50_000, cashNetAgorot: 120_000, cashTipsAgorot: 1_000, movements: m })).toBe(126_000);
    const till = tillWithDrawer({ openingCash: 500, expectedCash: 500, totalSales: 0, totalDiscounts: 0, totalRefunds: 0, totalCash: 0, totalCard: 0, totalTips: 0, totalCashTips: 0, totalCardTips: 0, transactionsCount: 0, itemsCount: 0 }, movementTotalsOf([
      { type: 'cash_in', amountAgorot: 10_000 },
      { type: 'cash_out', amountAgorot: 5_000 },
      { type: 'deposit', amountAgorot: 20_000 },
    ]), { walletIn: 0, walletDeposits: 0 });
    expect(till).toMatchObject({ expectedCash: 350, cashIn: 100, cashOut: 50, deposits: 200 });
    expect(till).not.toHaveProperty('walletIn');
  });
});

describe('the drawer mode, the question, another till (bill-print-other-till §9)', () => {
  it('cashDrawer - the new ask option, the old ones unchanged', () => {
    expect(cashDrawerModeOf({})).toBe('off');
    expect(cashDrawerModeOf({ cashDrawer: 'כבוי' })).toBe('off');
    expect(cashDrawerModeOf({ cashDrawer: 'בתשלום מזומן' })).toBe('on_cash');
    expect(cashDrawerModeOf({ cashDrawer: 'בתשלום מזומן + כפתור' })).toBe('on_cash_and_button');
    expect(cashDrawerModeOf({ cashDrawer: 'בתשלום מזומן — לשאול' })).toBe('on_cash_ask');
    expect(cashDrawerModeOf({ cashDrawer: 'בתשלום מזומן — לשאול + כפתור' })).toBe('on_cash_ask_and_button');
  });

  it('the question - 8 seconds, then open by default, or skip', () => {
    expect(drawerAskSettingsOf({})).toEqual({ timeoutSec: 8, openByDefault: true });
    expect(drawerAskSettingsOf({ cashDrawerAskTimeoutSec: '1', cashDrawerAskDefault: 'skip' })).toEqual({ timeoutSec: 3, openByDefault: false });
    expect(drawerAskSettingsOf({ cashDrawerAskTimeoutSec: 200 })).toMatchObject({ timeoutSec: 60 });
    expect(drawerAskOpens({ timeoutSec: 8, openByDefault: true }, null)).toBe(true);
    expect(drawerAskOpens({ timeoutSec: 8, openByDefault: false }, null)).toBe(false);
    expect(drawerAskOpens({ timeoutSec: 8, openByDefault: true }, false)).toBe(false);
  });

  it('remotePrintDrawer - never by default, ask, auto; only on cash, only where there is one', () => {
    expect(remoteDrawerModeOf(undefined)).toBe('never');
    expect(remoteDrawerModeOf('ask')).toBe('ask');
    expect(remoteDrawerModeOf('always')).toBe('auto');
    expect(remoteDrawerAction('auto', false, true)).toBe('none');
    expect(remoteDrawerAction('auto', true, false)).toBe('none');
    expect(remoteDrawerAction('auto', true, null)).toBe('open');
    expect(remoteDrawerAction('ask', true, true)).toBe('ask');
    expect(remoteDrawerAction('never', true, true)).toBe('none');
  });

  it('the host opens only with a drawer and not in a payment of its own', () => {
    expect(hostDrawerVerdict(true, false)).toBeNull();
    expect(hostDrawerVerdict(false, false)).toBe('no_drawer');
    expect(hostDrawerVerdict(true, true)).toBe('busy_payment');
    expect(hostDrawerVerdict(true, false, true)).toBe('expired');
  });
});

/* -------------------------------------------------------- the service rig */

class Rig {
  readonly db = openDb(':memory:');
  readonly store: DrawerStore;
  readonly outbox: string[] = [];
  kicks = 0;
  online = true;
  kickError: string | null = null;
  shiftId: string | null = 'shift-1';
  ownDrawer: { id: string; name: string } | null = { id: 'local', name: 'קופה' };
  params: Record<string, unknown> = { cashDrawer: 'בתשלום מזומן + כפתור' };
  ids = 0;
  readonly service: CashDrawerService;
  constructor(public signedIn: DrawerPerson | null, base = 50_000) {
    this.db.exec('CREATE TABLE IF NOT EXISTS outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, ref_id TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT "", attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, next_at INTEGER NOT NULL DEFAULT 0, UNIQUE(kind, ref_id))');
    this.store = new DrawerStore(this.db);
    this.service = new CashDrawerService({
      store: this.store,
      operator: () => this.signedIn,
      parameters: () => this.params,
      ownDrawer: () => this.ownDrawer,
      kick: async () => {
        this.kicks += 1;
        if (this.kickError) throw new Error(this.kickError);
      },
      currentShiftId: () => this.shiftId,
      expectedBalance: () => {
        if (this.shiftId === null) return null;
        const rows = this.store.movementsOfShift(this.shiftId);
        const m = movementTotalsOf(rows);
        const w = walletTotalsOf(rows);
        return base + m.cashIn - m.cashOut - m.deposits + w.walletDeposits - w.walletIn;
      },
      identity: () => ({ companyId: null, shopId: null, machineId: 'm1', deviceId: null }),
      online: () => this.online,
      enqueue: (kind, id) => {
        this.outbox.push(`${kind}:${id}`);
        this.db.run('INSERT OR IGNORE INTO outbox (kind, ref_id) VALUES (?, ?)', kind, id);
      },
      now: () => '2026-10-16T10:00:00.000Z',
      newId: () => `00000000-0000-4000-8000-${String(++this.ids).padStart(12, '0')}`,
    });
  }
  events() {
    return this.store.eventsOfShift(this.shiftId ?? '').concat(this.shiftId === null ? this.db.all<{ json: string }>('SELECT json FROM till_drawer_events').map((r) => JSON.parse(r.json)) : []);
  }
}

describe('the service: audit, kick, override, movements, offline', () => {
  it('refused - recorded, never kicked', async () => {
    const rig = new Rig(person('dana', 'waiter'));
    const out = await rig.service.requestOpen({ context: 'CASH_OUT', reason: 'x', amountAgorot: 1_000 });
    expect(out.kind).toBe('denied');
    expect(rig.kicks).toBe(0);
    const row = rig.events()[0];
    expect(row).toMatchObject({ result: 'denied', decision: 'deny' });
    expect(rig.outbox).toContain(`drawer_event:${row.id}`);
  });

  it('an override is one action under the original user, both names recorded', async () => {
    const rig = new Rig(person('dana', 'cashier'));
    const request: DrawerRequest = { context: 'MANUAL', reason: 'CHANGE' };
    expect((await rig.service.requestOpen(request)).kind).toBe('approval');
    expect(rig.kicks).toBe(0);
    expect(rig.events()).toHaveLength(0);
    // A cashier cannot approve another cashier.
    expect((await rig.service.requestOpen(request, null, person('yossi', 'cashier'))).kind).toBe('denied');
    const opened = await rig.service.requestOpen(request, null, person('moshe', 'manager'));
    expect(opened.kind).toBe('opened');
    expect(rig.kicks).toBe(1);
    const row = rig.store.event(opened.kind === 'opened' ? opened.eventId : '')!;
    expect(row).toMatchObject({ result: 'approved', employeeId: 'dana', approverId: 'moshe', approverMethod: 'pin', eventType: 'MANUAL' });
    // The next action asks again.
    expect((await rig.service.requestOpen(request)).kind).toBe('approval');
  });

  it("a cash sale's opening is told apart from a manual one", async () => {
    const rig = new Rig(person('dana', 'cashier'));
    await rig.service.requestOpen({ context: 'CASH_SALE', saleId: 's1', amountAgorot: 4_000 });
    expect(rig.events()[0]).toMatchObject({ eventType: 'CASH_SALE', saleId: 's1', expectedBalanceAgorot: 50_000 });
  });

  it('movements move the expected balance, an opening alone does not', async () => {
    const rig = new Rig(person('sara', 'supervisor'));
    await rig.service.requestOpen({ context: 'MANUAL', reason: 'CHANGE' });
    expect(rig.service.expectedNow()).toBe(50_000);
    expect((await rig.service.cashMovement('CASH_IN', 10_000, 'עודף מהכספת', null, { source: 'כספת' })).kind).toBe('opened');
    expect((await rig.service.cashMovement('CASH_OUT', 5_000, 'ספק', 'חלב')).kind).toBe('opened');
    await rig.service.cashMovement('DEPOSIT', 20_000, 'הפקדה לבנק', null);
    expect(rig.service.expectedNow()).toBe(35_000);
    const cashOut = rig.store.movementsOfShift('shift-1').find((m) => m.type === 'cash_out')!;
    expect(cashOut).toMatchObject({ expectedBeforeAgorot: 60_000, expectedAfterAgorot: 55_000 });
    // Two records per movement: the movement and its opening, linked both ways.
    const opening = rig.events().find((e) => e.movementId === cashOut.id)!;
    expect(opening.id).toBe(cashOut.drawerEventId);
    expect(opening.cashMovementType).toBe('cash_out');
    // A count: what was counted against what was expected, blind or not.
    const count = rig.service.recordCount(34_000, true, null);
    expect(count).toMatchObject({ varianceAgorot: -1_000, blind: true });
    expect(rig.service.expectedNow()).toBe(35_000);
  });

  it('offline - recorded with its flag and queued once under its own id', async () => {
    const rig = new Rig(person('sara', 'supervisor'));
    rig.online = false;
    await rig.service.requestOpen({ context: 'MANUAL', reason: 'CORRECTION' });
    const row = rig.events()[0];
    expect(row.offline).toBe(true);
    expect(rig.outbox).toEqual([`drawer_event:${row.id}`]);
    // A permission decision offline still needs the role — offline is never a way around it.
    const waiter = new Rig(person('dana', 'waiter'));
    waiter.online = false;
    expect((await waiter.service.requestOpen({ context: 'CASH_OUT', reason: 'x', amountAgorot: 500 })).kind).toBe('denied');
    expect(waiter.kicks).toBe(0);
  });

  it('a failed kick is recorded as failed', async () => {
    const rig = new Rig(person('sara', 'supervisor'));
    rig.kickError = 'paper out';
    expect((await rig.service.requestOpen({ context: 'MANUAL', reason: 'CHANGE' })).kind).toBe('failed');
    expect(rig.events()[0].result).toBe('failed');
  });

  it('after the close the row is marked', async () => {
    const rig = new Rig(person('moshe', 'manager'));
    rig.shiftId = null;
    await rig.service.requestOpen({ context: 'MANUAL', reason: 'CHANGE' });
    const row = rig.events()[0];
    expect(row.eventType).toBe('AFTER_CLOSE');
    expect(row.details).toMatchObject({ afterClose: true });
  });

  it('no drawer - a movement and a count are recorded all the same, a manual opening fails', async () => {
    const rig = new Rig(person('sara', 'supervisor'));
    rig.params = { cashDrawer: 'בתשלום מזומן' };
    expect((await rig.service.requestOpen({ context: 'MANUAL', reason: 'CHANGE' })).kind).toBe('failed');
    expect((await rig.service.cashMovement('CASH_IN', 1_000, null, null)).kind).toBe('no_drawer');
    expect(rig.store.movementsOfShift('shift-1')).toHaveLength(1);
    expect(rig.kicks).toBe(0);
  });

  it('the wire is the cloud schema: uuids or nothing, shekels, pending never sent as pending, the reason within 32', async () => {
    const rig = new Rig(person('sara', 'supervisor'));
    await rig.service.cashMovement('CASH_OUT', 12_345, 'עודף חייב ללקוח · הזמנה 57 · C-K7Q3MX', null);
    const m = rig.store.movementsOfShift('shift-1')[0];
    const ev = rig.store.event(m.drawerEventId!)!;
    const evWire = drawerEventWire({ ...ev, result: 'pending' });
    expect(evWire).toMatchObject({ id: ev.id, eventType: 'CASH_OUT', result: 'failed', amount: 123.45, cashMovementType: 'cash_out', movementId: m.id });
    expect(String(evWire.reason).length).toBeLessThanOrEqual(32);
    expect(evWire).not.toHaveProperty('shiftId'); // "shift-1" is no uuid
    expect(cashMovementWire(m)).toMatchObject({ id: m.id, type: 'cash_out', amount: 123.45, reason: 'עודף חייב ללקוח · הזמנה 57 · C-K7Q3MX', drawerEventId: ev.id });
  });
});

/* ------------------------------------------------------------ drawer away */

describe('the drawer away from the employee (drawer-away §5)', () => {
  const own: DrawerChoice = { id: 'own', name: 'קופה' };
  const host = (id: string, label: string): DrawerChoice => ({ id: `remote:${id}`, name: `המגירה ב${label}`, remote: { machineId: id, printerId: null, label } });

  it('the parameters default to none, auto, no target, warn', () => {
    expect(drawerAwaySettingsOf({})).toEqual(DEFAULT_DRAWER_AWAY);
    expect(drawerAwaySettingsOf({ drawerAwayPolicy: 'ask' }).policy).toBe('ask');
    expect(drawerAwaySettingsOf({ drawerAwayPolicy: ' Wallet ', drawerNear: 'away', drawerAwayTarget: ' m-2 ', walletBlockClockOut: 'block' })).toEqual({ policy: 'wallet', near: 'away', target: 'm-2', clockOut: 'block' });
    expect(drawerAwaySettingsOf({ drawerAwayPolicy: 'sometimes', drawerNear: '?', walletBlockClockOut: 'x' })).toEqual(DEFAULT_DRAWER_AWAY);
  });

  it("away by the device's kind unless set", () => {
    expect(isAway('auto', true, false)).toBe(false);
    expect(isAway('auto', false, false)).toBe(true);
    expect(isAway('auto', true, true)).toBe(true);
    expect(isAway('near', false, true)).toBe(false);
    expect(isAway('away', true, false)).toBe(true);
    expect(isHandheld(360)).toBe(true);
    expect(isHandheld(411)).toBe(true);
    expect(isHandheld(800)).toBe(false);
    expect(isHandheld(0)).toBe(false);
  });

  it('ask offers every drawer, or only the one set; remote opens the one set, asks which among several', () => {
    const a = host('m-1', 'קופה 1');
    const b = host('m-2', 'בר');
    const ask = { ...DEFAULT_DRAWER_AWAY, policy: 'ask' as const };
    expect(awayPlan(ask, [a, b])).toEqual({ kind: 'ask', drawers: [a, b] });
    expect(awayPlan({ ...ask, target: 'm-2' }, [a, b])).toEqual({ kind: 'ask', drawers: [b] });
    expect(awayPlan(ask, [])).toEqual({ kind: 'ask', drawers: [] });
    expect(awayPlan(DEFAULT_DRAWER_AWAY, [a, b])).toEqual({ kind: 'none' });
    const remote = { ...DEFAULT_DRAWER_AWAY, policy: 'remote' as const };
    expect(awayPlan({ ...remote, target: 'm-2' }, [a, b])).toEqual({ kind: 'open', drawer: b });
    expect(awayPlan(remote, [a])).toEqual({ kind: 'open', drawer: a });
    expect(awayPlan(remote, [a, b])).toEqual({ kind: 'choose', drawers: [a, b] });
    expect(awayPlan(remote, [])).toEqual({ kind: 'none' });
    expect(awayPlan({ ...remote, target: 'gone' }, [a, b])).toEqual({ kind: 'choose', drawers: [a, b] });
    expect(awayPlan({ ...remote, target: 'own' }, [own, a])).toEqual({ kind: 'open', drawer: own });
    expect(awayPlan({ ...DEFAULT_DRAWER_AWAY, policy: 'wallet' }, [a])).toEqual({ kind: 'wallet' });
  });

  const sale: DrawerRequest = { context: 'CASH_SALE', amountAgorot: 12_000, saleId: 's-1', documentType: '320', documentNumber: '1234' };

  it('the cash kept by the employee is a wallet_in movement, the drawer log says so', () => {
    const rig = new Rig(person('dana', 'waiter'));
    const m = rig.service.recordAway(sale, 'wallet', 'ask', 12_000)!;
    expect(rig.kicks).toBe(0);
    expect(m).toMatchObject({ type: 'wallet_in', amountAgorot: 12_000, employeeId: 'dana', source: 'sale:s-1', note: '320 1234', reason: 'WALLET', shiftId: 'shift-1', expectedBeforeAgorot: 50_000, expectedAfterAgorot: 38_000 });
    expect(rig.service.expectedNow()).toBe(38_000);
    expect(rig.outbox).toContain(`cash_movement:${m.id}`);
    const e = rig.events()[0];
    expect(e).toMatchObject({ eventType: 'CASH_SALE', result: 'failed', movementId: m.id });
    expect(e.id).toBe(m.drawerEventId);
    expect(e.details).toMatchObject({ drawerAway: 'wallet', awayPolicy: 'ask' });
    expect(e.details).not.toHaveProperty('askDismissed');
  });

  it('no drawer - recorded only, nothing moved', () => {
    const rig = new Rig(person('dana', 'waiter'));
    expect(rig.service.recordAway(sale, 'none', 'ask', 12_000, true)).toBeNull();
    expect(rig.store.movementsOfShift('shift-1')).toHaveLength(0);
    expect(rig.service.expectedNow()).toBe(50_000);
    expect(rig.events()[0].details).toMatchObject({ drawerAway: 'none', askDismissed: true });
    expect(rig.service.recordAway(sale, 'wallet', 'wallet', 0)).toBeNull();
  });

  it('a deposit opens the drawer, settles the wallet and records the variance', async () => {
    const rig = new Rig(person('rina', 'cashier'));
    const owner = { employeeId: 'dana', employeeName: 'דנה', balanceAgorot: 34_000, accruals: 1 };
    expect((await rig.service.walletDeposit(owner, owner.balanceAgorot, 33_000)).kind).toBe('opened');
    expect(rig.kicks).toBe(1);
    const m = rig.store.movementsOfShift('shift-1')[0];
    expect(m).toMatchObject({ type: 'wallet_deposit', amountAgorot: 33_000, expectedBeforeAgorot: 34_000, expectedAfterAgorot: 0, varianceAgorot: -1_000, employeeId: 'dana', approverId: 'rina' });
    expect(rig.store.event(m.drawerEventId!)).toMatchObject({ eventType: 'WALLET_DEPOSIT', permission: 'CASH_DRAWER.WALLET_DEPOSIT', cashMovementType: 'wallet_deposit', movementId: m.id });
    expect(rig.service.expectedNow()).toBe(83_000);
    expect(walletVariance(500, 500)).toBe(0);
  });

  it('a waiter may not receive a deposit, nothing is written; with no drawer it is recorded all the same', async () => {
    const waiter = new Rig(person('yossi', 'waiter'));
    const owner = { employeeId: 'dana', employeeName: 'דנה', balanceAgorot: 1_000, accruals: 1 };
    expect((await waiter.service.walletDeposit(owner, 1_000, 1_000)).kind).toBe('denied');
    expect(waiter.kicks).toBe(0);
    expect(waiter.store.movementsOfShift('shift-1')).toHaveLength(0);
    const noDrawer = new Rig(person('rina', 'cashier'));
    noDrawer.ownDrawer = null;
    expect((await noDrawer.service.walletDeposit(owner, 1_000, 1_000)).kind).toBe('no_drawer');
    expect(noDrawer.store.movementsOfShift('shift-1')[0].varianceAgorot).toBe(0);
  });

  it("the wallets from the cloud, with this device's rows not sent yet; a device's own balances settle by what was shown", () => {
    const parsed = parseWallets({ asOf: 'x', wallets: [{ employeeId: 'u-1', employeeName: 'דנה', balance: 340.0, accruals: 4 }, { employeeId: '', balance: 1 }] })!;
    expect(parsed).toEqual([{ employeeId: 'u-1', employeeName: 'דנה', balanceAgorot: 34_000, accruals: 4, firstAt: null, lastAt: null }]);
    expect(parseWallets('not json')).toBeNull();
    expect(parseWallets({ other: [] })).toBeNull();
    const merged = withPending(parsed, [
      { type: 'wallet_in', employeeId: 'u-1', employeeName: 'דנה', amountAgorot: 5_000, pending: true },
      { type: 'wallet_in', employeeId: 'u-2', employeeName: 'יוסי', amountAgorot: 2_000, pending: true },
      { type: 'wallet_in', employeeId: 'u-2', employeeName: 'יוסי', amountAgorot: 9_000, pending: false },
    ]);
    expect(merged.map((w) => w.balanceAgorot)).toEqual([39_000, 2_000]);
    expect(merged[0].accruals).toBe(5);
    expect(
      walletBalances([
        { type: 'wallet_in', employeeId: 'u-1', employeeName: 'דנה', amountAgorot: 10_000 },
        { type: 'wallet_in', employeeId: 'u-1', employeeName: 'דנה', amountAgorot: 5_000 },
        { type: 'wallet_deposit', employeeId: 'u-1', employeeName: 'דנה', amountAgorot: 9_000, settledAgorot: 10_000 },
        { type: 'wallet_in', employeeId: 'u-2', employeeName: 'יוסי', amountAgorot: 3_000 },
        { type: 'wallet_deposit', employeeId: 'u-2', employeeName: 'יוסי', amountAgorot: 3_000 },
        { type: 'cash_in', employeeId: 'u-3', employeeName: 'x', amountAgorot: 3_000 },
      ]),
    ).toEqual([{ employeeId: 'u-1', employeeName: 'דנה', balanceAgorot: 5_000, accruals: 2 }]);
  });

  it('money not deposited warns by default, blocks when set, a manager approves', () => {
    expect(walletClockOutCheck(34_000, 'warn', false, false)).toEqual({ kind: 'warning', amountAgorot: 34_000 });
    expect(walletClockOutCheck(34_000, 'warn', false, true)).toEqual({ kind: 'allowed' });
    expect(walletClockOutCheck(34_000, 'block', false, true)).toEqual({ kind: 'blocked', amountAgorot: 34_000 });
    expect(walletClockOutCheck(34_000, 'block', true, false)).toEqual({ kind: 'allowed' });
    expect(walletClockOutCheck(0, 'block', false, false)).toEqual({ kind: 'allowed' });
    expect(walletClockOutCheck(null, 'block', false, false)).toEqual({ kind: 'allowed' });
  });

  it('the X takes the wallets off and the deposits on the expected drawer; the close freezes them only when they moved', () => {
    const w = walletTotalsOf([
      { type: 'wallet_in', amountAgorot: 12_000 },
      { type: 'wallet_deposit', amountAgorot: 3_000 },
      { type: 'cash_in', amountAgorot: 1_000 },
    ]);
    expect(w).toEqual({ walletIn: 12_000, walletDeposits: 3_000 });
    const base = { openingCash: 500, expectedCash: 500, totalSales: 0, totalDiscounts: 0, totalRefunds: 0, totalCash: 0, totalCard: 0, totalTips: 0, totalCashTips: 0, totalCardTips: 0, transactionsCount: 0, itemsCount: 0 };
    const x = tillWithDrawer(base, { cashIn: 1_000, cashOut: 0, deposits: 0 }, w);
    expect(x.expectedCash).toBe((50_000 + 1_000 - 12_000 + 3_000) / 100);
    expect(x).toMatchObject({ walletIn: 120, walletDeposits: 30, cashIn: 10 });
    // None: exactly as before.
    expect(tillWithDrawer(base, { cashIn: 0, cashOut: 0, deposits: 0 }, { walletIn: 0, walletDeposits: 0 })).toEqual(base);
  });

  it('receiving a deposit - waiter denied, cashier supervisor manager allowed', () => {
    const expected: Record<string, string> = { waiter: 'deny', cashier: 'allow', supervisor: 'allow', manager: 'allow' };
    for (const [role, state] of Object.entries(expected)) expect(MATRIX.roles[role].states['CASH_DRAWER.WALLET_DEPOSIT'], role).toBe(state);
  });
});

/* -------------------------------------------------------------- the engine */

const open: Harness[] = [];
afterEach(() => {
  for (const h of open.splice(0)) h.stop();
});

const WAITER_PIN = '5555';
const SUP_PIN = '7777';
/** The matrix's roles on the roster (the cloud's states and limits), and the legacy manager. */
function matrixRoster(): Array<Record<string, unknown>> {
  const u = (id: string, first: string, pin: string, key: string) => ({
    id,
    username: id,
    firstName: first,
    lastName: null,
    pinHash: bcrypt.hashSync(pin, 4),
    role: key === 'manager' ? 'shop_manager' : 'cashier',
    isActive: true,
    shopId: null,
    permissions: MATRIX.roles[key].states,
    limits: MATRIX.roles[key].limits,
    tillRoleKey: key,
  });
  return [u('u-cashier', 'דנה', PIN, 'cashier'), u('u-manager', 'אבי', MANAGER_PIN, 'manager'), u('u-waiter', 'יוסי', WAITER_PIN, 'waiter'), u('u-sup', 'שרה', SUP_PIN, 'supervisor')];
}

async function till(o: HarnessOptions = {}, pin = PIN): Promise<Harness> {
  const h = harness({ users: matrixRoster(), ...o });
  open.push(h);
  await h.ok('session.login', { pin });
  if (!h.svc.ledger.currentShift()) {
    // A float of ₪200: a waiter may not open a shift, the manager opens it for them.
    const r = await h.call('shift.open', { openingCashAgorot: 20_000 });
    if (!r.ok || h.state().dialog) {
      const d = h.state().dialog;
      if (d) await h.ok('dialog.answer', { dialogId: d.id, action: 'approve', answers: { pin: MANAGER_PIN } });
    }
  }
  return h;
}

const kicks = (h: Harness) => h.printer.sent.filter((b) => b.length === 5 && b[0] === 0x1b && b[1] === 0x70).length;
const settle = () => new Promise((r) => setTimeout(r, 40));
const events = (h: Harness) => h.engine.drawer.service.store.eventsOfShift(h.svc.ledger.currentShift()!.id);
const movements = (h: Harness) => h.engine.drawer.service.store.movementsOfShift(h.svc.ledger.currentShift()!.id);

async function cashSale(h: Harness, agorot = 1_250) {
  await h.ok('sell.add', { productId: 'p-cola' });
  await h.ok('checkout.start');
  await h.ok('checkout.cash', { amountAgorot: agorot });
  await settle();
}

describe('the till: the drawer after a cash payment', () => {
  it('opens through the service: the audit before the kick, the sale on it, uploaded as a side row', async () => {
    const h = await till({ parameters: { cashDrawer: 'בתשלום מזומן' }, answers: { 'POST sync/m/cash-drawer/events': () => ({ status: 'accepted' }) } });
    await cashSale(h);
    expect(kicks(h)).toBe(1);
    const e = events(h).find((x) => x.eventType === 'CASH_SALE')!;
    expect(e).toMatchObject({ result: 'approved', employeeId: 'u-cashier', amountAgorot: 1_250, permission: 'CASH_DRAWER.OPEN_ON_CASH_SALE' });
    expect(e.saleId).toBe(h.state().checkout.documentId);
    await h.svc.sync.flush();
    expect(h.sent.some((s) => s.method === 'POST' && s.path === 'sync/m/cash-drawer/events' && (s.body as { id?: string }).id === e.id)).toBe(true);
    // A card sale moves no cash: no drawer.
    expect(kicks(h)).toBe(1);
  });

  it('with the drawer off nothing is kicked — the attempt is in the log, as on Android', async () => {
    const h = await till({ parameters: {} });
    await cashSale(h);
    expect(kicks(h)).toBe(0);
    expect(events(h).find((x) => x.eventType === 'CASH_SALE')).toMatchObject({ result: 'failed', resultReason: 'אין מגירה מחוברת לקופה' });
  });

  it('"בתשלום מזומן — לשאול": the question first; "לא" is in the log, not opened, never an exception', async () => {
    const h = await till({ parameters: { cashDrawer: 'בתשלום מזומן — לשאול' } });
    await cashSale(h);
    const d = h.state().dialog!;
    expect(d.title).toBe('לפתוח מגירה?');
    expect(d.expiresAt).toBeGreaterThan(Date.now());
    expect(kicks(h)).toBe(0);
    await h.ok('dialog.answer', { dialogId: d.id, action: 'skip' });
    expect(kicks(h)).toBe(0);
    expect(events(h).find((x) => x.eventType === 'CASH_SALE')).toMatchObject({ result: 'failed', details: { askDeclined: true, askTimedOut: false } });
    // "פתח" opens it.
    await h.ok('checkout.finish');
    await cashSale(h);
    await h.ok('dialog.answer', { dialogId: h.state().dialog!.id, action: 'open' });
    expect(kicks(h)).toBe(1);
  });

  it('unanswered: after the timeout the default — open (or skip when the till says so)', async () => {
    const h = await till({ parameters: { cashDrawer: 'בתשלום מזומן — לשאול', cashDrawerAskTimeoutSec: '3' } });
    await cashSale(h);
    expect(h.state().dialog).not.toBeNull();
    await new Promise((r) => setTimeout(r, 3_300));
    expect(h.state().dialog).toBeNull();
    expect(kicks(h)).toBe(1);
  }, 10_000);

  it('a device away from the drawer, "ask": "הכסף אצלי" keeps it with the employee — out of the expected drawer and on the close', async () => {
    const h = await till({ parameters: { drawerAwayPolicy: 'ask', drawerNear: 'away', cashDrawer: 'בתשלום מזומן' } });
    const before = h.engine.drawer.service.expectedNow()!;
    await cashSale(h, 2_000);
    const d = h.state().dialog!;
    expect(d.title).toBe('המזומן — איפה הכסף?');
    expect(d.actions.map((a) => a.label)).toEqual(['פתח מגירה בהקופה', 'הכסף אצלי, אפקיד אחר כך', 'בלי מגירה (רישום בלבד)']);
    await h.ok('dialog.answer', { dialogId: d.id, action: 'wallet' });
    expect(kicks(h)).toBe(0);
    const m = movements(h).find((x) => x.type === 'wallet_in')!;
    expect(m).toMatchObject({ amountAgorot: 1_250, employeeId: 'u-cashier', reason: 'WALLET' });
    // The sale's cash came in and went to the employee: the drawer expects what it did before.
    expect(h.engine.drawer.service.expectedNow()).toBe(before);
    await h.ok('checkout.finish');
    const r = await h.ok<{ expectedCashAgorot: number; walletInAgorot?: number }>('shift.close', { countedCashAgorot: before });
    expect(r).toMatchObject({ expectedCashAgorot: before, walletInAgorot: 1_250 });
    const close = JSON.parse(h.svc.ledger.lastClosedShift()!.close_payload!);
    expect(close.till).toMatchObject({ walletIn: 12.5, expectedCash: before / 100, totalCash: 12.5 });
    expect(close.till).not.toHaveProperty('walletDeposits');
  });

  it('a device near its drawer, or the policy none: today\'s way', async () => {
    const h = await till({ parameters: { drawerAwayPolicy: 'ask', cashDrawer: 'בתשלום מזומן' } });
    await cashSale(h);
    expect(h.state().dialog).toBeNull();
    expect(kicks(h)).toBe(1);
  });
});

describe('the till: "פתיחת מגירה", the movements, the count, the deposit', () => {
  it('the menu offers what the drawer and the role allow', async () => {
    const h = await till({ parameters: { cashDrawer: 'בתשלום מזומן + כפתור' } });
    // A cashier sees no log (CASH_DRAWER.VIEW_LOG / VIEW_CASH_MOVEMENTS are a supervisor's); a manager does.
    expect(h.state().drawer!.offered).toEqual({ open: true, cashIn: true, cashOut: true, deposit: true, count: true, walletDeposit: true, log: false, remote: false });
    const m = await till({ parameters: { cashDrawer: 'בתשלום מזומן + כפתור' } }, MANAGER_PIN);
    expect(m.state().drawer!.offered.log).toBe(true);
    const w = await till({ parameters: { cashDrawer: 'בתשלום מזומן' } }, WAITER_PIN);
    expect(w.state().drawer!.offered).toMatchObject({ open: false, cashOut: false, walletDeposit: false });
  });

  it('a cashier\'s manual opening asks a manager; another cashier\'s code does not approve it; the manager\'s opens it, both recorded', async () => {
    const h = await till({ parameters: { cashDrawer: 'בתשלום מזומן + כפתור' } });
    expect((await h.fail('drawer.open', { reason: 'CASH_IN' })).code).toBe('invalid_args');
    await h.ok('drawer.open', { reason: 'CHANGE' });
    const d = h.state().dialog!;
    expect(d.body).toBe('פריטת כסף / מתן עודף — דורש אישור מנהל');
    expect((await h.fail('dialog.answer', { dialogId: d.id, action: 'approve', answers: { pin: PIN } })).message).toBe('קוד מנהל שגוי');
    await h.ok('dialog.answer', { dialogId: d.id, action: 'approve', answers: { pin: MANAGER_PIN } });
    expect(kicks(h)).toBe(1);
    expect(events(h).at(-1)).toMatchObject({ eventType: 'CHANGE', result: 'approved', employeeId: 'u-cashier', approverId: 'u-manager', approverMethod: 'pin', reason: 'CHANGE' });
  });

  it('a supervisor\'s cash out up to ₪200 alone; above it only a manager; the expected drawer and the X follow', async () => {
    const h = await till({ parameters: { cashDrawer: 'בתשלום מזומן + כפתור' } }, SUP_PIN);
    await h.ok('drawer.movement', { type: 'CASH_OUT', amountAgorot: 20_000, reason: 'ספק' });
    expect(h.state().dialog).toBeNull();
    await h.ok('drawer.movement', { type: 'CASH_OUT', amountAgorot: 25_000, reason: 'ספק' });
    const d = h.state().dialog!;
    expect(d.body).toBe('הוצאת מזומן — מעל המותר לך, דורש אישור מנהל');
    // The supervisor's own code does not cover it.
    expect((await h.fail('dialog.answer', { dialogId: d.id, action: 'approve', answers: { pin: SUP_PIN } })).code).toBe('wrong_pin');
    await h.ok('dialog.answer', { dialogId: d.id, action: 'approve', answers: { pin: MANAGER_PIN } });
    await h.ok('drawer.movement', { type: 'CASH_IN', amountAgorot: 5_000, reason: 'עודף', source: 'כספת' });
    expect(movements(h).map((m) => [m.type, m.amountAgorot, m.approverId])).toEqual([
      ['cash_out', 20_000, null],
      ['cash_out', 25_000, 'u-manager'],
      ['cash_in', 5_000, null],
    ]);
    const x = await h.ok<{ expectedCashAgorot: number; cashOutAgorot: number; cashInAgorot: number }>('report.x');
    expect(x).toMatchObject({ expectedCashAgorot: 20_000 - 45_000 + 5_000, cashOutAgorot: 45_000, cashInAgorot: 5_000 });
  });

  it('the X paper: the movements and the cash with employees, each only when it moved; under blind count the interim X states no expected cash', async () => {
    const h = await till({ parameters: { cashDrawer: 'בתשלום מזומן + כפתור', drawerAwayPolicy: 'wallet', drawerNear: 'away' } }, MANAGER_PIN);
    await h.ok('drawer.movement', { type: 'CASH_OUT', amountAgorot: 5_000, reason: 'ספק' });
    await cashSale(h, 1_250);
    await h.ok('checkout.finish');
    await h.ok('report.x');
    const papers = () => h.svc.db.all<{ doc: string }>("SELECT doc FROM print_jobs WHERE kind = 'z' ORDER BY created_at").map((r) => JSON.parse(r.doc) as { ops: Array<{ t: string; label?: string; value?: string }> });
    const rowsOf = (d: { ops: Array<{ t: string; label?: string; value?: string }> }) => d.ops.filter((o) => o.t === 'row').map((o) => o.label);
    const x = papers().at(-1)!;
    expect(rowsOf(x)).toEqual(expect.arrayContaining(['הוצאות', 'הכסף אצל עובדים', 'מזומן צפוי']));
    expect(rowsOf(x)).not.toContain('הכנסות');
    expect(rowsOf(x)).not.toContain('הפקדות מעובדים');
    const blind = await till({ parameters: { 'cashDrawer.blindCount': 'true' } }, MANAGER_PIN);
    await blind.ok('report.x');
    const bx = blind.svc.db.all<{ doc: string }>("SELECT doc FROM print_jobs WHERE kind = 'z'").map((r) => JSON.parse(r.doc) as { ops: Array<{ t: string; label?: string }> });
    expect(bx.at(-1)!.ops.filter((o) => o.t === 'row').map((o) => o.label)).not.toContain('מזומן צפוי');
  });

  it('a count, blind when the till says so: the expected is shown only after the amount; the close records its count', async () => {
    const h = await till({ parameters: { cashDrawer: 'בתשלום מזומן + כפתור', 'cashDrawer.blindCount': 'true' } }, SUP_PIN);
    await h.ok('drawer.count');
    expect(h.state().drawer!.count).toEqual({ blind: true, expectedAgorot: null, result: null });
    const r = await h.ok('drawer.countSave', { countedAgorot: 19_900 });
    expect(r).toEqual({ countedAgorot: 19_900, expectedAgorot: 20_000, varianceAgorot: -100 });
    expect(h.state().drawer!.count).toMatchObject({ expectedAgorot: 20_000 });
    await h.ok('drawer.countDone');
    expect(h.state().drawer!.count).toBeNull();
    expect(movements(h).filter((m) => m.type === 'count')).toHaveLength(1);
    const shift = h.svc.ledger.currentShift()!.id;
    await h.ok('shift.close', { countedCashAgorot: 20_000 });
    expect(h.engine.drawer.service.store.movementsOfShift(shift).filter((m) => m.type === 'count').map((m) => m.varianceAgorot)).toEqual([-100, 0]);
  });

  it('"הפקדת מזומן מעובד": the cloud\'s wallets, what was shown is what is settled, the variance said', async () => {
    const h = await till(
      {
        parameters: { cashDrawer: 'בתשלום מזומן + כפתור' },
        answers: { 'GET sync/m/cash-wallets': () => ({ asOf: 'x', wallets: [{ employeeId: 'u-waiter', employeeName: 'יוסי', balance: 340, accruals: 2 }] }) },
      },
      PIN,
    );
    const list = await h.ok<{ wallets: Array<{ employeeId: string; balanceAgorot: number }>; offline: boolean }>('drawer.wallets');
    expect(list).toMatchObject({ offline: false, wallets: [{ employeeId: 'u-waiter', balanceAgorot: 34_000 }] });
    await h.ok('drawer.walletDeposit', { employeeId: 'u-waiter', countedAgorot: 33_000 });
    expect(kicks(h)).toBe(1);
    expect(movements(h).at(-1)).toMatchObject({ type: 'wallet_deposit', amountAgorot: 33_000, expectedBeforeAgorot: 34_000, varianceAgorot: -1_000, employeeId: 'u-waiter', approverId: 'u-cashier' });
    const x = await h.ok<{ walletDepositsAgorot: number; expectedCashAgorot: number }>('report.x');
    expect(x).toMatchObject({ walletDepositsAgorot: 33_000, expectedCashAgorot: 53_000 });
  });

  it('no cloud: the deposit screen says so and deposits nothing', async () => {
    const h = await till({ parameters: { cashDrawer: 'בתשלום מזומן + כפתור' } });
    expect(await h.ok('drawer.wallets')).toEqual({ wallets: [], offline: true });
    expect((await h.fail('drawer.walletDeposit', { employeeId: 'u-waiter', countedAgorot: 100 })).message).toBe('אין חיבור לשרת — לא ניתן לבדוק כמה צפוי');
  });

  it('every manager override and every refusal of a gated action is in the same audit (category permission)', async () => {
    const h = await till({ parameters: {} }, WAITER_PIN);
    // A waiter may not see the shop's X: refused, recorded.
    const refusals = await h.call('report.shopX', {});
    expect(refusals.ok).toBe(false);
    await h.ok('sell.add', { productId: 'p-cola' });
    await h.ok('checkout.start');
    await h.ok('checkout.cash', { amountAgorot: 1_250 });
    const docId = h.state().checkout.documentId!;
    await h.ok('checkout.finish');
    // A copy from the history needs REPRINT: the manager approves it.
    await h.ok('doc.reprint', { documentId: docId });
    await h.ok('dialog.answer', { dialogId: h.state().dialog!.id, action: 'approve', answers: { pin: MANAGER_PIN } });
    const perms = h.engine.drawer.service.store.eventsOfShift(h.svc.ledger.currentShift()!.id).filter((e) => e.category === 'permission');
    expect(perms.map((e) => [e.permission, e.decision, e.result, e.employeeId, e.approverId])).toContainEqual(['REPRINT', 'approval', 'approved', 'u-waiter', 'u-manager']);
  });

  it('the log of the shift: openings and movements as the role may see them', async () => {
    const h = await till({ parameters: { cashDrawer: 'בתשלום מזומן + כפתור' } }, MANAGER_PIN);
    await h.ok('drawer.open', { reason: 'OTHER', note: 'בדיקה' });
    await h.ok('drawer.movement', { type: 'DEPOSIT', amountAgorot: 10_000 });
    const log = await h.ok<{ events: Array<{ eventType: string }>; movements: Array<{ type: string }> }>('drawer.log');
    expect(log.events.map((e) => e.eventType)).toEqual(['MANUAL', 'DEPOSIT']);
    expect(log.movements.map((m) => m.type)).toEqual(['deposit']);
  });
});

describe('the till: the drawer under "כשאין הרשאה" and with the refunds (the merged engine)', () => {
  it('show (the default): a denied row as before — hidden, or shown with "הצג מושבת עם הסבר"; hide: hidden either way', async () => {
    const show = await till({ parameters: { cashDrawer: 'בתשלום מזומן + כפתור' } }, WAITER_PIN);
    expect(show.state().drawer!.offered).toMatchObject({ cashOut: false, walletDeposit: false });
    const disabled = await till({ parameters: { cashDrawer: 'בתשלום מזומן + כפתור', permissionsDeniedUi: 'הצג מושבת עם הסבר' } }, WAITER_PIN);
    expect(disabled.state().drawer!.offered).toMatchObject({ cashOut: true, walletDeposit: true });
    const hide = await till({ parameters: { cashDrawer: 'בתשלום מזומן + כפתור', permissionsDeniedUi: 'הצג מושבת עם הסבר', deniedActionUi: 'hide' } }, WAITER_PIN);
    expect(hide.state().drawer!.offered).toMatchObject({ cashOut: false, walletDeposit: false, log: false });
  });

  it("code: a waiter's denied cash out is offered and asks a manager's code — recorded as the manager's approval; the log stays as under show", async () => {
    const h = await till({ parameters: { cashDrawer: 'בתשלום מזומן + כפתור', deniedActionUi: 'code' } }, WAITER_PIN);
    expect(h.state().drawer!.offered).toMatchObject({ cashOut: true, log: false });
    await h.ok('drawer.movement', { type: 'CASH_OUT', amountAgorot: 5_000, reason: 'ספק' });
    const d = h.state().dialog!;
    expect(d.body).toBe('הוצאת מזומן — דורש אישור מנהל');
    await h.ok('dialog.answer', { dialogId: d.id, action: 'approve', answers: { pin: MANAGER_PIN } });
    expect(movements(h).map((m) => [m.type, m.amountAgorot, m.employeeId, m.approverId])).toEqual([['cash_out', 5_000, 'u-waiter', 'u-manager']]);
    // Never relaxed into "allowed"; under show the same waiter is refused outright — no question, nothing moved.
    const show = await till({ parameters: { cashDrawer: 'בתשלום מזומן + כפתור' } }, WAITER_PIN);
    await show.ok('drawer.movement', { type: 'CASH_OUT', amountAgorot: 5_000, reason: 'ספק' });
    expect(show.state().dialog).toBeNull();
    expect(movements(show)).toEqual([]);
    expect(events(show).at(-1)).toMatchObject({ eventType: 'CASH_OUT', result: 'denied', employeeId: 'u-waiter' });
  });

  it("a cash refund opens the drawer through the drawer service: the refund's manager is not asked again and is named in the log", async () => {
    const h = await till({ parameters: { cashDrawer: 'בתשלום מזומן' } });
    await h.ok('sell.add', { productId: 'p-cola' });
    await h.ok('checkout.start');
    await h.ok('checkout.cash', { amountAgorot: 1_250 });
    const docId = h.state().checkout.documentId!;
    await h.ok('checkout.finish');
    await settle();
    const before = kicks(h);
    const r = await h.call('doc.refund', { documentId: docId });
    expect(r.ok).toBe(true);
    const d = h.state().dialog;
    if (d) await h.ok('dialog.answer', { dialogId: d.id, action: 'approve', answers: { pin: MANAGER_PIN } });
    await settle();
    expect(kicks(h)).toBe(before + 1);
    const refund = events(h).filter((e) => e.eventType === 'REFUND');
    expect(refund).toHaveLength(1);
    expect(refund[0]).toMatchObject({ result: 'approved', employeeId: 'u-cashier', permission: 'REFUND', ...(d ? { approverId: 'u-manager' } : {}) });
    // Nothing else asked: the refund's approval was the drawer's too.
    expect(h.state().dialog).toBeNull();
  });
});
