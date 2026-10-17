/**
 * "נוכחות" on the Windows till: the pure rules ported with pos-android's own cases (AttendanceStateMachineTest,
 * AttendanceClockOutTest, AttendanceCodeTest, AttendanceOutboxTest, AttendanceSeparationTest, AttendanceStringsTest), the
 * service through the engine harness (a fake cloud: `GET …/attendance/state`, `POST …/attendance/actions`), and the
 * screen's markup.
 */

import bcrypt from 'bcryptjs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ATTENDANCE_TEXT as A,
  AttendanceMachine,
  PinAttemptLimiter,
  attendanceParamsOf,
  byManager,
  checkClockOut,
  checkCode,
  clockActions,
  clockShown,
  cloudOf,
  correctionTimeIso,
  formatWorked,
  mergeShift,
  ownCode,
  payloadOf,
  sessionNeedsCode,
  sessionOnly,
  shiftOf,
  statusOf,
  timeInput,
  unionTables,
  withoutPrompt,
  workedMs,
  breakMs,
  DEFAULT_ATTENDANCE_PARAMS,
  FRESH_SIGN_IN_MS,
  type AttendanceOpenTable,
  type AttendanceOutcome,
  type AttendanceShift,
  type AttendanceState,
} from '../src/core/till/attendance';
import { TillAttendance } from '../src/main/till/tillAttendance';
import { AttendanceClockButton, AttendanceScreen, type AttendanceActions } from '../src/renderer/roles/till/screens/AttendanceScreen';
import type { TillOp } from '../src/shared/till/protocol';
import { harness, type Harness, type HarnessOptions } from './tillEngineHarness';

const user = '11111111-1111-1111-1111-111111111111';
const t0 = '2026-10-06T14:00:00.000Z';
const t1 = '2026-10-06T16:00:00.000Z';
const t2 = '2026-10-06T16:30:00.000Z';
const t3 = '2026-10-06T22:00:00.000Z';
const on = { ...DEFAULT_ATTENDANCE_PARAMS, enabled: true };

const done = (o: AttendanceOutcome) => {
  if (o.kind !== 'done') throw new Error(`refused: ${o.reason}`);
  return o;
};
const working = (): AttendanceShift => done(AttendanceMachine.clockIn(null, user, 's1', 'a1', t0, 'till-1')).shift;

describe('the state machine (AttendanceStateMachineTest)', () => {
  it('a whole shift — in, a break, back, out', () => {
    const inn = done(AttendanceMachine.clockIn(null, user, 's1', 'a1', t0, 'till-1'));
    expect(statusOf(inn.shift)).toBe('working');
    expect(inn.action.type).toBe('clock_in');
    expect(inn.action.shiftId).toBe('s1');
    const brk = done(AttendanceMachine.startBreak(inn.shift, 'b1', 'a2', t1));
    expect(statusOf(brk.shift)).toBe('on_break');
    expect(brk.action.breakId).toBe('b1');
    // Every action carries the shift's clock-in, for a cloud that never got it.
    expect(brk.action.shiftClockInAt).toBe(t0);
    expect(brk.action.shiftClockInMachineId).toBe('till-1');
    const back = done(AttendanceMachine.endBreak(brk.shift, 'a3', t2));
    expect(statusOf(back.shift)).toBe('working');
    expect(back.action.breakId).toBe('b1');
    expect(back.action.breakStartedAt).toBe(t1);
    const out = done(AttendanceMachine.clockOut(back.shift, 'a4', t3));
    expect(statusOf(out.shift)).toBe('not_working');
    expect(out.shift.closedBy).toBe('self');
    expect(workedMs(out.shift, Number.MAX_SAFE_INTEGER)).toBe((7 * 60 + 30) * 60_000);
    expect(formatWorked(workedMs(out.shift, Number.MAX_SAFE_INTEGER))).toBe('7:30');
  });

  it('the refusals', () => {
    const shift = working();
    expect(AttendanceMachine.clockIn(shift, user, 's2', 'a', t1, null)).toEqual({ kind: 'refused', reason: 'already_on_shift' });
    expect(AttendanceMachine.endBreak(shift, 'a', t1)).toEqual({ kind: 'refused', reason: 'not_on_break' });
    const onBreak = done(AttendanceMachine.startBreak(shift, 'b', 'a', t1)).shift;
    expect(AttendanceMachine.startBreak(onBreak, 'b2', 'a', t2)).toEqual({ kind: 'refused', reason: 'already_on_break' });
    expect(AttendanceMachine.clockOut(null, 'a', t1)).toEqual({ kind: 'refused', reason: 'not_on_shift' });
    expect(AttendanceMachine.startBreak(null, 'b', 'a', t1)).toEqual({ kind: 'refused', reason: 'not_on_shift' });
  });

  it('after a clock-out the next clock-in is a new shift; a clock-out during a break ends the break', () => {
    const out = done(AttendanceMachine.clockOut(working(), 'a', t1)).shift;
    const again = done(AttendanceMachine.clockIn(out, user, 's2', 'a2', t2, null));
    expect(again.shift.id).toBe('s2');
    expect(statusOf(again.shift)).toBe('working');
    const onBreak = done(AttendanceMachine.startBreak(working(), 'b1', 'a', t1)).shift;
    const ended = done(AttendanceMachine.clockOut(onBreak, 'a2', t2)).shift;
    expect(ended.breaks[0]!.endAt).toBe(t2);
    expect(breakMs(ended, Number.MAX_SAFE_INTEGER)).toBe(30 * 60_000);
  });

  it('a correction request never changes the shift here', () => {
    const action = AttendanceMachine.correction(working(), user, 'a9', t1, { id: 'c1', kind: 'missing_in', field: null, requestedTime: '2026-10-06T13:05:00.000Z', requestedEndTime: null, reason: 'שכחתי' });
    expect(action.type).toBe('correction_request');
    expect(action.shiftId).toBe('s1');
    expect(action.correction?.id).toBe('c1');
  });

  it('the parameters default to no change', () => {
    expect(attendanceParamsOf({})).toEqual({ enabled: false, requireClockIn: false, preventOpenTables: true, requireManager: false, requireCodePerAction: true });
    expect(attendanceParamsOf({ attendanceEnabled: 'true', requireClockInBeforeLogin: 'כן', preventClockOutWithOpenTables: 'false', requireManagerForClockOut: '1' })).toEqual({
      enabled: true,
      requireClockIn: true,
      preventOpenTables: false,
      requireManager: true,
      requireCodePerAction: true,
    });
    expect(attendanceParamsOf({ attendanceRequireCodePerAction: 'לא' }).requireCodePerAction).toBe(false);
    expect(attendanceParamsOf({ attendanceEnabled: true }).enabled).toBe(true);
  });

  it('the merge with the cloud', () => {
    const theirs: AttendanceShift = { id: 's9', posUserId: user, clockInAt: t0, clockInMachineId: 'till-2', breaks: [], clockOutAt: null, closedBy: null, roleName: null };
    const cloud = (open: AttendanceShift | null, known: AttendanceShift | null) => ({ open, known, openTables: [], pendingCorrections: 0, roleName: null, last24hSeconds: null });
    // The cloud's open shift from another till is adopted.
    expect(mergeShift(null, cloud(theirs, null))).toEqual(theirs);
    const finished = done(AttendanceMachine.clockOut(working(), 'a', t1)).shift;
    expect(mergeShift(finished, cloud(theirs, null))?.id).toBe('s9');
    // A manager's close in the cloud reaches this till.
    const mine = working();
    const closed = mergeShift(mine, cloud(null, { ...mine, clockOutAt: t3, closedBy: 'manager' }))!;
    expect(statusOf(closed)).toBe('not_working');
    expect(closed.closedBy).toBe('manager');
    // This till's unsent clock-out is not undone by a cloud that has not heard of it.
    const out = done(AttendanceMachine.clockOut(working(), 'a', t1)).shift;
    const stillOpen = { ...out, clockOutAt: null, closedBy: null };
    const kept = mergeShift(out, cloud(stillOpen, stillOpen))!;
    expect(kept.clockOutAt).toBe(t1);
    // A break taken at another till is kept.
    const withBreak = { ...mine, breaks: [{ id: 'bX', startAt: t1, endAt: null }] };
    expect(statusOf(mergeShift(mine, cloud(withBreak, withBreak)))).toBe('on_break');
    // This till's own open shift stays when the cloud has another.
    expect(mergeShift(mine, cloud({ ...theirs, id: 's7' }, null))?.id).toBe('s1');
    expect(mergeShift(mine, null)).toEqual(mine);
  });

  it("the local copy round-trips and the cloud's answer is read", () => {
    const shift = { ...done(AttendanceMachine.startBreak(working(), 'b1', 'a', t1)).shift, roleName: 'מלצר' };
    expect(shiftOf(JSON.parse(JSON.stringify(shift)))).toEqual(shift);
    expect(shiftOf('not json')).toBeNull();
    const c = cloudOf(
      JSON.parse(`{"serverTime":"2026-10-06T16:00:00+00:00","shift":{"id":"s1","posUserId":"${user}","clockInAt":"2026-10-06T14:00:00+00:00",
       "clockOutAt":null,"breaks":[{"id":"b1","startAt":"2026-10-06T15:00:00+00:00","endAt":null}],"roleName":"ברמן"},
       "known":null,"openTables":[{"orderId":"o1","tableId":"t1","number":12,"name":null,"total":428.5}],
       "pendingCorrections":2,"roleName":"ברמן","last24hSeconds":7200}`),
    )!;
    expect(statusOf(c.open)).toBe('on_break');
    expect(c.openTables[0]!.number).toBe(12);
    expect(c.openTables[0]!.totalAgorot).toBe(42_850);
    expect(c.pendingCorrections).toBe(2);
    expect(c.last24hSeconds).toBe(7200);
  });

  it('a corrected time is the local wall clock in UTC; typing a time', () => {
    const today = { y: 2026, m: 10, d: 6 };
    expect(correctionTimeIso(0, '16:05', today, 'Asia/Jerusalem')).toBe('2026-10-06T13:05:00.000Z');
    expect(correctionTimeIso(1, '23:30', today, 'Asia/Jerusalem')).toBe('2026-10-05T20:30:00.000Z');
    // Winter time (UTC+2) after the clocks go back.
    expect(correctionTimeIso(0, '09:00', { y: 2026, m: 12, d: 1 }, 'Asia/Jerusalem')).toBe('2026-12-01T07:00:00.000Z');
    expect(correctionTimeIso(0, '25:00', today, 'Asia/Jerusalem')).toBeNull();
    expect(correctionTimeIso(0, '', today, 'Asia/Jerusalem')).toBeNull();
    expect(timeInput('1605')).toBe('16:05');
    expect(timeInput('9:3a0')).toBe('9:30');
    expect(timeInput('12')).toHaveLength(2);
  });
});

describe('"סיום משמרת" checks (AttendanceClockOutTest)', () => {
  const t12: AttendanceOpenTable = { tableId: 't12', number: 12, name: null, totalAgorot: 42_800 };
  const t14: AttendanceOpenTable = { tableId: 't14', number: 14, name: 'VIP', totalAgorot: 9_000 };
  const check = (params: typeof on, tables: AttendanceOpenTable[], selfIsManager: boolean, approved: boolean, more: Record<string, unknown> = {}) => checkClockOut({ params, openTables: tables, selfIsManager, approved, ...more });

  it('nothing open, nothing required — allowed; open tables block by default; a manager lets it through', () => {
    expect(check(on, [], false, false)).toEqual({ kind: 'allowed' });
    expect(check(on, [t12, t14], false, false)).toEqual({ kind: 'tables_blocked', tables: [t12, t14] });
    expect(check(on, [t12], false, true)).toEqual({ kind: 'allowed' });
  });

  it('with the parameter off they only warn, once; open tables first, then the manager', () => {
    const p = { ...on, preventOpenTables: false };
    expect(check(p, [t12], false, false)).toEqual({ kind: 'tables_warning', tables: [t12] });
    expect(check(p, [t12], false, false, { warningAcknowledged: true })).toEqual({ kind: 'allowed' });
    const pm = { ...p, requireManager: true };
    expect(check(pm, [t12], false, false).kind).toBe('tables_warning');
    expect(check(pm, [t12], false, false, { warningAcknowledged: true })).toEqual({ kind: 'needs_manager' });
  });

  it('require manager — a cashier needs one, a manager approves alone', () => {
    const p = { ...on, requireManager: true };
    expect(check(p, [], false, false)).toEqual({ kind: 'needs_manager' });
    expect(check(p, [], true, false)).toEqual({ kind: 'allowed' });
    expect(check(p, [], false, true)).toEqual({ kind: 'allowed' });
  });

  it('the cash not deposited warns (once) or blocks; a manager answers it', () => {
    expect(check(on, [], false, false, { walletAgorot: 34_000 })).toEqual({ kind: 'wallet_warning', amountAgorot: 34_000 });
    expect(check(on, [], false, false, { walletAgorot: 34_000, walletAcknowledged: true })).toEqual({ kind: 'allowed' });
    expect(check(on, [], false, false, { walletAgorot: 34_000, walletMode: 'block', walletAcknowledged: true })).toEqual({ kind: 'wallet_blocked', amountAgorot: 34_000 });
    expect(check(on, [], false, true, { walletAgorot: 34_000, walletMode: 'block' })).toEqual({ kind: 'allowed' });
    expect(check(on, [], false, false, { walletAgorot: 0, walletMode: 'block' })).toEqual({ kind: 'allowed' });
  });

  it("this till's tables and the cloud's are one list", () => {
    expect(unionTables([t12], [{ ...t12, totalAgorot: 50_000 }, t14]).map((t) => t.tableId)).toEqual(['t12', 't14']);
  });
});

describe('the code (AttendanceCodeTest)', () => {
  it('the menu asks every time — the cards right after a PIN count it', () => {
    const now = 1_000_000;
    expect(sessionNeedsCode(on, null, now)).toBe(true);
    expect(withoutPrompt(on, null, now)).toBeNull();
    expect(sessionNeedsCode(on, now - 5_000, now)).toBe(false);
    expect(withoutPrompt(on, now - 5_000, now)).toEqual(ownCode('session'));
    expect(sessionNeedsCode(on, now - FRESH_SIGN_IN_MS - 1, now)).toBe(true);
    // A clock moved back is not "fresh".
    expect(sessionNeedsCode(on, now + 10_000, now)).toBe(true);
  });

  it('with the parameter off a session acts as before and says so', () => {
    const off = { ...on, requireCodePerAction: false };
    expect(sessionNeedsCode(off, null, 0)).toBe(false);
    expect(withoutPrompt(off, null, 0)).toEqual(sessionOnly());
    expect(sessionOnly().verifiedBy).toBe('session');
  });

  it('a manager confirming their own action used their own code', () => {
    expect(byManager('boss', 'boss', 'רותי', 'clock')).toEqual(ownCode('clock'));
    const forDana = byManager('dana', 'boss', 'רותי', 'session');
    expect(forDana.verifiedBy).toBe('manager');
    expect(forDana.onBehalf).toEqual({ posUserId: 'boss', name: 'רותי', reason: 'on_behalf' });
  });

  it('the clock shows on tills only and only with attendance on; its actions by the state', () => {
    expect(clockShown(on, 'till', false, false)).toBe(true);
    expect(clockShown(on, null, false, false)).toBe(true);
    expect(clockShown(DEFAULT_ATTENDANCE_PARAMS, 'till', false, false)).toBe(false);
    expect(clockShown(on, 'kiosk', false, false)).toBe(false);
    expect(clockShown(on, 'till', true, false)).toBe(false);
    expect(clockShown(on, 'till', false, true)).toBe(false);
    expect(clockActions('not_working')).toEqual(['clock_in']);
    expect(clockActions('working')).toEqual(['break_start', 'clock_out']);
    expect(clockActions('on_break')).toEqual(['break_end', 'clock_out']);
  });

  it('five wrong codes lock for a minute and a right one starts the count again', () => {
    let now = 0;
    const limiter = new PinAttemptLimiter(() => now);
    for (let i = 0; i < 4; i++) expect(limiter.failure('k')).toBe(false);
    expect(limiter.lockedForMs('k')).toBe(0);
    limiter.success('k');
    for (let i = 0; i < 4; i++) limiter.failure('k');
    expect(limiter.lockedForMs('k')).toBe(0);
    expect(limiter.failure('k')).toBe(true);
    expect(limiter.lockedForSeconds('k')).toBe(60);
    expect(limiter.lockedForMs('other')).toBe(0);
    now += 59_001;
    expect(limiter.lockedForSeconds('k')).toBe(1);
    now += 1_000;
    expect(limiter.lockedForMs('k')).toBe(0);
  });

  const u = (id: string, hash: string) => ({ id, pinHash: hash });
  const dana = u('dana', 'h-1234');
  const yossi = u('yossi', 'h-5678');
  const tal = u('tal', 'h-5678');
  const boss = u('boss', 'h-9999');
  const verify = (pin: string, hash: string | null | undefined) => hash === `h-${pin}`;

  it('a code finds its employee, two who share it are asked which, a wrong one counts', async () => {
    const limiter = new PinAttemptLimiter(() => 0);
    const roster = [dana, yossi, tal, boss];
    expect(await checkCode('1234', roster, limiter, 'clock', verify)).toEqual({ kind: 'match', user: dana });
    expect(await checkCode('5678', roster, limiter, 'clock', verify)).toEqual({ kind: 'ambiguous', users: [yossi, tal] });
    expect(await checkCode('0000', roster, limiter, 'clock', verify)).toEqual({ kind: 'wrong' });
    expect(await checkCode('12', roster, limiter, 'clock', verify)).toEqual({ kind: 'wrong' });
  });

  it("in a session only the employee's own code is theirs; the fifth wrong locks and even the right one waits", async () => {
    const limiter = new PinAttemptLimiter(() => 0);
    expect(await checkCode('9999', [dana], limiter, 'dana', verify)).toEqual({ kind: 'wrong' });
    expect(await checkCode('1234', [dana], limiter, 'dana', verify)).toEqual({ kind: 'match', user: dana });
    const l2 = new PinAttemptLimiter(() => 0);
    for (let i = 0; i < 4; i++) expect(await checkCode('0000', [dana], l2, 'clock', verify)).toEqual({ kind: 'wrong' });
    expect(await checkCode('0000', [dana], l2, 'clock', verify)).toEqual({ kind: 'locked', seconds: 60 });
    expect(await checkCode('1234', [dana], l2, 'clock', verify)).toEqual({ kind: 'locked', seconds: 60 });
  });

  it('what the cloud is told: how it was confirmed, never the code; nulls left out', () => {
    const inn = done(AttendanceMachine.clockIn(null, user, 's1', 'a1', t0, 'till-1'));
    const plain = payloadOf(inn.action);
    expect(plain).toEqual({ id: 'a1', type: 'clock_in', posUserId: user, shiftId: 's1', at: t0 });
    const out = done(AttendanceMachine.clockOut(inn.shift, 'a4', t1, { posUserId: 'boss', name: 'רותי', reason: 'open_tables' }, [{ tableId: 't12', number: 12, name: null, totalAgorot: 42_850 }]));
    const body = payloadOf({ ...out.action, ...byManager(user, 'boss', 'רותי', 'session') });
    expect(body.approval).toEqual({ posUserId: 'boss', name: 'רותי', reason: 'open_tables' });
    expect(body.openTables).toEqual([{ tableId: 't12', number: 12, total: 428.5 }]);
    expect(body.verifiedBy).toBe('manager');
    expect(Object.keys(body).some((k) => /pin/i.test(k) || k.toLowerCase() === 'code')).toBe(false);
    expect('sentAt' in body).toBe(false);
  });
});

describe("the owner's words (AttendanceStringsTest)", () => {
  it('word for word', () => {
    expect(A.statusNotWorking).toBe('לא במשמרת');
    expect(A.statusWorkingSince('17:02')).toBe('במשמרת מ־17:02');
    expect(A.statusBreakSince('17:02')).toBe('בהפסקה מ־17:02');
    expect(A.clockIn).toBe('התחל משמרת');
    expect(A.breakStart).toBe('יציאה להפסקה');
    expect(A.breakEnd).toBe('חזרה מהפסקה');
    expect(A.clockOut).toBe('סיום משמרת');
    expect(A.blockedTitle).toBe('לא ניתן לסיים משמרת');
    expect(A.requestCorrection).toBe('בקשת תיקון נוכחות');
    expect(A.clockTitle).toBe('שעון נוכחות');
    expect(A.clockActionIn).toBe('כניסה');
    expect(A.clockActionOut).toBe('יציאה');
    expect(A.clockCorrection).toBe('בקשת תיקון');
    expect(A.clockDoneIn('17:02', 'דנה')).toBe('המשמרת התחילה ב־17:02 · שלום, דנה');
  });
});

/* ------------------------------------------------------------------ through the engine */

const DANA = '11111111-1111-1111-1111-111111111111';
const YOSSI = '22222222-2222-2222-2222-222222222222';
const TAL = '33333333-3333-3333-3333-333333333333';
const BOSS = '44444444-4444-4444-4444-444444444444';
const hash = (pin: string) => bcrypt.hashSync(pin, 4);
const STAFF = [
  { id: DANA, username: 'dana', firstName: 'דנה', lastName: 'כהן', pinHash: hash('1234'), role: 'cashier', isActive: true, shopId: null },
  { id: YOSSI, username: 'yossi', firstName: 'יוסי', lastName: null, pinHash: hash('5678'), role: 'cashier', isActive: true, shopId: null },
  { id: TAL, username: 'tal', firstName: 'טל', lastName: null, pinHash: hash('5678'), role: 'cashier', isActive: true, shopId: null },
  { id: BOSS, username: 'ruti', firstName: 'רותי', lastName: null, pinHash: hash('9876'), role: 'shop_manager', isActive: true, shopId: null },
];

interface Cloud {
  down: boolean;
  posted: Array<Record<string, unknown>>;
  state: Record<string, unknown>;
  refuse: ((b: Record<string, unknown>) => Record<string, unknown> | null) | null;
}

let open: Harness[] = [];
afterEach(() => {
  for (const h of open) h.stop();
  open = [];
});

function setup(params: Record<string, unknown> = {}, o: HarnessOptions = {}, deps: ConstructorParameters<typeof TillAttendance>[1] = {}) {
  const cloud: Cloud = { down: false, posted: [], state: { shift: null, known: null, openTables: [], pendingCorrections: 0, roleName: 'מלצר' }, refuse: null };
  const h = harness({
    users: STAFF,
    parameters: { attendanceEnabled: true, ...params },
    answers: {
      'GET sync/m/attendance/state': () => {
        if (cloud.down) throw new Error('down');
        return JSON.parse(JSON.stringify(cloud.state));
      },
      'POST sync/m/attendance/actions': (b) => {
        if (cloud.down) throw new Error('down');
        const r = cloud.refuse?.(b!) ?? null;
        if (r) return r;
        cloud.posted.push(b!);
        return { status: 'accepted' };
      },
    },
    ...o,
  });
  open.push(h);
  const f = h.engine.register(new TillAttendance(h.engine.ctx, { timeZone: 'Asia/Jerusalem', ...deps }));
  const ok = (op: string, args: Record<string, unknown> = {}) => h.ok(op as TillOp, args);
  const view = () => (h.state() as unknown as Record<string, unknown>).attendance as AttendanceState | undefined;
  const settle = async () => {
    await f.idle();
    await f.flush();
    await f.idle();
  };
  return { h, f, cloud, ok, view, settle };
}

describe('the service', () => {
  it('nothing where the shop does not run attendance; the clock on the sign-in screen where it does', async () => {
    const off = setup({ attendanceEnabled: false });
    expect(off.view()).toBeUndefined();
    const s = setup();
    expect(s.view()?.clockShown).toBe(true);
    expect(s.view()?.menuLine).toBeNull();
    const kiosk = setup({}, {}, { kioskTakenForStaff: () => true });
    expect(kiosk.view()?.clockShown).toBe(false);
  });

  it('after a PIN: the offer, "התחל משמרת" with the PIN as the code, one action to the cloud', async () => {
    const s = setup();
    await s.ok('session.login', { pin: '1234' });
    await s.settle();
    expect(s.view()?.cardKind).toBe('offer');
    expect(s.view()?.card?.status).toBe('לא במשמרת');
    await s.ok('attendance.act', { action: 'clock_in' });
    await s.settle();
    expect(s.view()?.sheet).toBeNull();
    expect(s.view()?.message).toMatch(/^המשמרת התחילה ב־\d\d:\d\d$/);
    expect(s.view()?.menuLine).toMatch(/^במשמרת מ־/);
    expect(s.cloud.posted).toHaveLength(1);
    const b = s.cloud.posted[0]!;
    expect(b).toMatchObject({ type: 'clock_in', posUserId: DANA, verifiedBy: 'code', origin: 'session' });
    expect(typeof b.sentAt).toBe('string');
    expect(s.view()?.unsent).toBe(0);
    // The job title the cloud named is on the shift.
    expect(s.f.current({ id: DANA })?.roleName).toBe('מלצר');
  });

  it('the panel asks the code every time; a wrong one says so; a break signs out and the shift goes on', async () => {
    const s = setup();
    await s.ok('session.login', { pin: '1234' });
    await s.settle();
    await s.ok('attendance.act', { action: 'clock_in' });
    await s.ok('attendance.open');
    await s.settle();
    expect(s.view()?.cardKind).toBe('panel');
    expect(s.view()?.card?.buttons.map((b) => b.label)).toEqual(['יציאה להפסקה', 'סיום משמרת']);
    await s.ok('attendance.act', { action: 'break_start' });
    const sheet = s.view()?.sheet;
    expect(sheet?.kind).toBe('code');
    expect(sheet && 'prompt' in sheet ? sheet.prompt : '').toBe('דנה כהן, הקש/י את הקוד שלך לאישור: יציאה להפסקה');
    expect(await s.ok('attendance.code', { pin: '9876' })).toEqual({ ok: false });
    expect(s.view()?.sheet).toMatchObject({ kind: 'code', error: 'קוד שגוי' });
    await s.ok('attendance.code', { pin: '1234' });
    await s.settle();
    expect(s.h.state().session.cashier).toBeNull();
    expect(s.view()?.message).toBe('דנה כהן בהפסקה — הקופה ננעלה. לחזרה: קוד עובד.');
    expect(statusOf(s.f.current({ id: DANA }))).toBe('on_break');
    expect(s.cloud.posted.map((b) => b.type)).toEqual(['clock_in', 'break_start']);
    // Back: the gate "בהפסקה" blocks selling until the break ends.
    await s.ok('session.login', { pin: '1234' });
    await s.settle();
    expect(s.view()?.gate).toBe('break');
    expect(s.view()?.cardKind).toBe('gate');
    expect(s.f.sellRefusal()).toBe('את/ה בהפסקה. כדי להמשיך לעבוד — חזרה מהפסקה.');
    await s.ok('attendance.act', { action: 'break_end' });
    await s.settle();
    expect(s.view()?.gate).toBeNull();
    expect(s.view()?.message).toMatch(/^ברוכים השבים — במשמרת מ־/);
    const end = s.cloud.posted[2]!;
    expect(end).toMatchObject({ type: 'break_end', breakId: s.cloud.posted[1]!.breakId, breakStartedAt: s.cloud.posted[1]!.at });
  });

  it('"requireClockInBeforeLogin": the gate after a PIN, which only the clock-in or "יציאה" leaves', async () => {
    const s = setup({ requireClockInBeforeLogin: true });
    await s.ok('session.login', { pin: '1234' });
    expect(s.f.signedIn(s.h.engine.ctx.operator()!).gate).toBe('required');
    await s.settle();
    expect(s.view()?.gate).toBe('required');
    expect(s.view()?.card?.lines).toEqual(['כדי למכור יש להתחיל משמרת.']);
    await s.ok('attendance.close');
    expect(s.view()?.cardKind).toBe('gate');
    await s.ok('attendance.signOut');
    expect(s.h.state().session.cashier).toBeNull();
    expect(s.cloud.posted).toHaveLength(0);
  });

  it('offline: kept durably, sent in order when the cloud is back, each action once (the same id on a retry)', async () => {
    const s = setup();
    s.cloud.down = true;
    await s.ok('session.login', { pin: '1234' });
    await s.settle();
    expect(s.view()?.card?.offline).toBe(true);
    await s.ok('attendance.act', { action: 'clock_in' });
    await s.settle();
    expect(s.view()?.unsent).toBe(1);
    expect(statusOf(s.f.current({ id: DANA }))).toBe('working');
    // A restart: a new module on the same device keeps the queue and the copy.
    const again = new TillAttendance(s.h.engine.ctx, { timeZone: 'Asia/Jerusalem' });
    expect(again.outbox()).toHaveLength(1);
    expect(statusOf(again.current({ id: DANA }))).toBe('working');
    again.stop();
    s.cloud.down = false;
    // An answer lost on the way: the cloud has it, the till does not know — sent again with the same id.
    let lost = true;
    s.cloud.refuse = () => {
      if (!lost) return null;
      lost = false;
      return { __status: 503 };
    };
    await s.f.flush();
    expect(s.view()?.unsent).toBe(1);
    await s.f.flush();
    expect(s.view()?.unsent).toBe(0);
    expect(s.cloud.posted).toHaveLength(1);
    const ids = s.h.sent.filter((r) => r.path === 'sync/m/attendance/actions').map((r) => (r.body as { id: string }).id);
    expect(new Set(ids).size).toBe(1);
  });

  it('a refusal keeps the action (never lost) and does not hold the ones behind it', async () => {
    const s = setup();
    s.cloud.refuse = (b) => (b.type === 'clock_in' ? { __status: 409, detail: { code: 'attendance_id_conflict' } } : null);
    await s.ok('session.login', { pin: '1234' });
    await s.settle();
    await s.ok('attendance.act', { action: 'clock_in' });
    await s.settle();
    expect(s.f.outbox()).toMatchObject([{ parked: true }]);
    await s.ok('attendance.open');
    await s.ok('attendance.correction');
    await s.ok('attendance.correctionSend', { kind: 'missing_in', daysBack: 0, time: '09:00', reason: '  שכחתי  ' });
    await s.ok('attendance.code', { pin: '1234' });
    await s.settle();
    expect(s.cloud.posted.map((b) => b.type)).toEqual(['correction_request']);
    expect(s.cloud.posted[0]!.correction).toMatchObject({ kind: 'missing_in', reason: 'שכחתי' });
    expect(s.view()?.message).toBe('הבקשה נשלחה לאישור מנהל');
    expect(s.f.outbox()).toHaveLength(1);
  });

  it("\"סיום משמרת\" with the cloud's open tables: blocked, a manager's code, the approval and the tables sent", async () => {
    const s = setup();
    await s.ok('session.login', { pin: '1234' });
    await s.settle();
    await s.ok('attendance.act', { action: 'clock_in' });
    await s.settle();
    s.cloud.state = { ...s.cloud.state, openTables: [{ orderId: 'o1', tableId: 't12', number: 12, name: null, total: 428.5 }] };
    await s.ok('attendance.open');
    await s.ok('attendance.act', { action: 'clock_out' });
    await s.ok('attendance.code', { pin: '1234' });
    await s.settle();
    expect(s.view()?.sheet).toMatchObject({ kind: 'clockOut', variant: 'blocked', title: 'לא ניתן לסיים משמרת', lines: ['שולחן 12 · ₪428.50'], canApprove: true, canFinish: false, canTransfer: false });
    await s.ok('attendance.clockOutChoice', { choice: 'approve' });
    await s.settle();
    expect(s.view()?.sheet).toMatchObject({ kind: 'manager', prompt: 'סיום משמרת עם שולחנות פתוחים — דנה כהן' });
    expect(await s.ok('attendance.manager', { pin: '1234' })).toEqual({ ok: false });
    await s.ok('attendance.manager', { pin: '9876' });
    await s.settle();
    const out = s.cloud.posted.find((b) => b.type === 'clock_out')!;
    expect(out.approval).toEqual({ posUserId: BOSS, name: 'רותי', reason: 'open_tables' });
    expect(out.openTables).toEqual([{ tableId: 't12', number: 12, total: 428.5 }]);
    expect(statusOf(s.f.current({ id: DANA }))).toBe('not_working');
    expect(s.view()?.message).toMatch(/^המשמרת הסתיימה · \d+:\d\d שעות$/);
  });

  it('"requireManagerForClockOut": a cashier needs a manager, a manager clocks out alone; the cash not deposited warns', async () => {
    const s = setup({ requireManagerForClockOut: true, attendanceRequireCodePerAction: false }, {}, { walletAgorot: (u) => (u.id === BOSS ? 34_000 : null) });
    await s.ok('session.login', { pin: '1234' });
    await s.settle();
    await s.ok('attendance.act', { action: 'clock_in' });
    await s.ok('attendance.open');
    await s.ok('attendance.act', { action: 'clock_out' });
    await s.settle();
    expect(s.view()?.sheet).toMatchObject({ kind: 'manager', prompt: 'סיום משמרת — דנה כהן' });
    await s.ok('attendance.close');
    await s.ok('session.logout');
    await s.ok('session.login', { pin: '9876' });
    await s.settle();
    await s.ok('attendance.act', { action: 'clock_in' });
    await s.ok('attendance.open');
    await s.ok('attendance.act', { action: 'clock_out' });
    await s.settle();
    expect(s.view()?.sheet).toMatchObject({ kind: 'clockOut', variant: 'wallet_warning', body: 'יש בידך ₪340.00 להפקדה', canFinish: true });
    await s.ok('attendance.clockOutChoice', { choice: 'finish' });
    await s.settle();
    const out = s.cloud.posted.filter((b) => b.type === 'clock_out');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ posUserId: BOSS, verifiedBy: 'session' });
    expect(out[0]!.approval).toBeUndefined();
  });

  it('"שעון נוכחות": a code, the card, a punch — nobody signed in; two who share a code are asked which', async () => {
    const s = setup();
    await s.ok('attendance.clock');
    expect(s.view()?.sheet).toMatchObject({ kind: 'code', title: 'שעון נוכחות', prompt: 'הקש/י את הקוד האישי שלך', alternative: 'פעולה בשם עובד (באישור מנהל)' });
    await s.ok('attendance.code', { pin: '1234' });
    await s.settle();
    expect(s.view()?.cardKind).toBe('clock');
    expect(s.view()?.card?.buttons.map((b) => b.label)).toEqual(['כניסה']);
    await s.ok('attendance.act', { action: 'clock_in' });
    await s.settle();
    expect(s.view()?.sheet).toMatchObject({ kind: 'done' });
    expect((s.view()?.sheet as { text: string }).text).toMatch(/^המשמרת התחילה ב־\d\d:\d\d · שלום, דנה כהן$/);
    expect(s.h.state().session.cashier).toBeNull();
    expect(s.cloud.posted[0]).toMatchObject({ type: 'clock_in', posUserId: DANA, verifiedBy: 'code', origin: 'clock' });
    await s.ok('attendance.close');
    expect(s.view()?.clockOpen).toBe(false);
    // Yossi and Tal share 5678.
    await s.ok('attendance.clock');
    await s.ok('attendance.code', { pin: '5678' });
    expect(s.view()?.sheet).toMatchObject({ kind: 'pick', title: 'לקוד הזה יש יותר מעובד אחד — מי את/ה?' });
    await s.ok('attendance.pick', { userId: TAL });
    await s.settle();
    expect(s.view()?.card?.title).toBe('שלום, טל');
  });

  it('at the clock a manager acts for an employee: the card says so, the cloud is told who', async () => {
    const s = setup();
    await s.ok('attendance.clock');
    await s.ok('attendance.behalf');
    expect(s.view()?.sheet).toMatchObject({ kind: 'pick', title: 'בשם איזה עובד?' });
    await s.ok('attendance.pick', { userId: YOSSI });
    expect(s.view()?.sheet).toMatchObject({ kind: 'manager', prompt: 'נוכחות בשם יוסי — שעון נוכחות' });
    await s.ok('attendance.manager', { pin: '9876' });
    await s.settle();
    expect(s.view()?.card?.lines[0]).toBe('באישור מנהל: רותי');
    await s.ok('attendance.act', { action: 'clock_in' });
    await s.settle();
    expect(s.cloud.posted[0]).toMatchObject({ posUserId: YOSSI, verifiedBy: 'manager', origin: 'clock', onBehalf: { posUserId: BOSS, name: 'רותי', reason: 'on_behalf' } });
  });

  it('signing in and out, switching user, never start or end a shift (AttendanceSeparationTest)', async () => {
    const s = setup();
    await s.ok('session.login', { pin: '1234' });
    await s.settle();
    await s.ok('attendance.act', { action: 'clock_in' });
    await s.settle();
    const before = s.f.current({ id: DANA });
    await s.ok('session.logout');
    await s.ok('session.login', { pin: '5678' }).catch(() => undefined);
    await s.ok('session.logout').catch(() => undefined);
    await s.ok('session.login', { pin: '1234' });
    await s.settle();
    await s.ok('session.logout');
    await s.settle();
    expect(s.f.current({ id: DANA })).toEqual(before);
    expect(s.f.current({ id: YOSSI })).toBeNull();
    expect(s.cloud.posted.map((b) => b.type)).toEqual(['clock_in']);
  });

  it('the demo till\'s local staff are kept here only', async () => {
    const s = setup({}, { users: [{ id: 'local-1', username: 'demo', firstName: 'דמו', lastName: null, pinHash: hash('4321'), role: 'cashier', isActive: true, shopId: null }] });
    await s.ok('session.login', { pin: '4321' });
    await s.settle();
    await s.ok('attendance.act', { action: 'clock_in' });
    await s.settle();
    expect(statusOf(s.f.current({ id: 'local-1' }))).toBe('working');
    expect(s.f.outbox()).toHaveLength(0);
    expect(s.h.sent.some((r) => r.path.includes('attendance'))).toBe(false);
  });

  it('refuses what is not an op of its own shape', async () => {
    const s = setup();
    expect((await s.h.fail('attendance.act' as TillOp, { action: 'teleport' })).code).toBe('invalid_args');
    expect((await s.h.fail('attendance.open' as TillOp)).code).toBeTruthy();
  });
});

/* ------------------------------------------------------------------ the screen */

const noop = () => undefined;
const actions: AttendanceActions = { close: noop, act: noop, code: noop, behalf: noop, manager: noop, pick: noop, clockOutChoice: noop, transfer: noop, correction: noop, correctionSend: noop, signOut: noop };

/** A realistic state for the layout audit. */
export const ATTENDANCE_FIXTURE: AttendanceState = {
  clockShown: false,
  clockOpen: false,
  menuLine: 'במשמרת מ־17:02',
  gate: null,
  card: {
    userId: DANA,
    title: 'נוכחות · דנה כהן',
    status: 'במשמרת מ־17:02',
    lines: ['מלצרית', 'שעות במשמרת: 3:12', 'הפסקות: 1 · 0:20', 'בקשות תיקון ממתינות לאישור: 1'],
    offline: false,
    buttons: [
      { action: 'break_start', label: 'יציאה להפסקה', tone: 'tonal' },
      { action: 'clock_out', label: 'סיום משמרת', tone: 'danger' },
    ],
    loading: false,
  },
  cardKind: 'panel',
  sheet: null,
  message: null,
  busy: false,
  unsent: 0,
};

describe('the screen', () => {
  const html = (view: AttendanceState) => renderToStaticMarkup(createElement(AttendanceScreen, { view, actions }));

  it('draws nothing with nothing to show', () => {
    expect(renderToStaticMarkup(createElement(AttendanceScreen, { view: undefined, actions }))).toBe('');
    expect(html({ ...ATTENDANCE_FIXTURE, card: null, cardKind: null })).toBe('');
  });

  it('the panel: the state, the lines, the buttons, the correction and "סגירה"', () => {
    const out = html(ATTENDANCE_FIXTURE);
    for (const w of ['נוכחות · דנה כהן', 'במשמרת מ־17:02', 'שעות במשמרת: 3:12', 'יציאה להפסקה', 'סיום משמרת', 'בקשת תיקון נוכחות', 'סגירה']) expect(out).toContain(w);
  });

  it('the gate: no dismiss but "יציאה"; offline says so', () => {
    const out = html({ ...ATTENDANCE_FIXTURE, gate: 'required', cardKind: 'gate', card: { ...ATTENDANCE_FIXTURE.card!, title: 'שלום, דנה כהן', status: 'לא במשמרת', lines: ['כדי למכור יש להתחיל משמרת.'], offline: true, buttons: [{ action: 'clock_in', label: 'התחל משמרת', tone: 'primary' }] } });
    expect(out).toContain('כדי למכור יש להתחיל משמרת.');
    expect(out).toContain('התחל משמרת');
    expect(out).toContain('>יציאה<');
    expect(out).toContain(A.offline);
    expect(out).not.toContain('סגירה');
  });

  it('the sheets: the code, the clock-out checks, the form, the clock\'s word; the banner', () => {
    expect(html({ ...ATTENDANCE_FIXTURE, sheet: { kind: 'code', title: 'קוד עובד', prompt: 'דנה, הקש/י את הקוד שלך לאישור: סיום משמרת', error: 'קוד שגוי', lockedSeconds: 0, busy: false, alternative: 'אישור מנהל' } })).toContain('קוד שגוי');
    expect(html({ ...ATTENDANCE_FIXTURE, sheet: { kind: 'code', title: 'קוד עובד', prompt: 'x', error: null, lockedSeconds: 42, busy: false, alternative: null } })).toContain('בעוד 42 שניות');
    const blocked = html({ ...ATTENDANCE_FIXTURE, sheet: { kind: 'clockOut', variant: 'blocked', title: A.blockedTitle, body: A.blockedBody, lines: ['שולחן 12 · ₪428.50'], transferHint: null, canApprove: true, canFinish: false, canTransfer: true } });
    for (const w of ['לא ניתן לסיים משמרת', 'שולחן 12 · ₪428.50', 'העברת שולחנות', 'אישור מנהל']) expect(blocked).toContain(w);
    expect(blocked).not.toContain('סיים בכל זאת');
    const form = html({ ...ATTENDANCE_FIXTURE, sheet: { kind: 'correction', busy: false } });
    for (const w of ['כניסה חסרה', 'יציאה חסרה', 'שעה שגויה', 'הפסקה', 'היום', 'אתמול', 'שעה (למשל 16:05)', 'עד שעה (רשות)', 'סיבה', 'שליחה לאישור מנהל', 'הנוכחות לא משתנה עד שמנהל מאשר את הבקשה.']) expect(form).toContain(w);
    expect(html({ ...ATTENDANCE_FIXTURE, sheet: { kind: 'done', text: 'המשמרת התחילה ב־17:02 · שלום, דנה' } })).toContain('המשמרת התחילה ב־17:02 · שלום, דנה');
    expect(html({ ...ATTENDANCE_FIXTURE, card: null, cardKind: null, message: 'המשמרת התחילה ב־17:02' })).toContain('t-att-banner');
  });

  it('"שעון נוכחות" on the sign-in screen only where shown', () => {
    expect(renderToStaticMarkup(createElement(AttendanceClockButton, { view: { ...ATTENDANCE_FIXTURE, clockShown: true }, onOpen: noop }))).toContain('שעון נוכחות');
    expect(renderToStaticMarkup(createElement(AttendanceClockButton, { view: ATTENDANCE_FIXTURE, onOpen: noop }))).toBe('');
  });
});
