/**
 * "מצב עבודה: קיוסק / קופה" — the pure rules (core/workMode.ts), the port of the Android app's
 * KioskTillModeTest.kt and KioskHomeRole's cases: the parameters, the switch's refusals both ways, held sales
 * never blocking, the idle return, the dashboard's command, the sessions kept across a restart, what the cloud
 * hears, the manager's code (the same lock as the desktop exit's pad).
 */

import bcrypt from 'bcryptjs';
import { describe, expect, it } from 'vitest';
import { LOCKOUT_MS, MAX_FAILURES, type RosterUser } from '../src/core/desktopExit';
import {
  KIOSK_AT_REST,
  KIOSK_TILL_MODE,
  KioskHomeRole,
  MANAGER_TEXT,
  NOT_A_KIOSK,
  QUIET_TILL,
  REFUSALS,
  REFUSAL_TEXT,
  TILL_EVENT,
  WORK_TEXT,
  approval,
  decideManager,
  effectiveSnapshot,
  eventDetails,
  heldNoticeOf,
  idleCountdownSec,
  idleReturnDue,
  kioskFactsOf,
  managersFor,
  mayEnter,
  mayReturn,
  paramsOf,
  parseCommand,
  parseMode,
  parseSession,
  planAfterSync,
  rawFactsOf,
  remote,
  sessionToJson,
  statusJson,
  userHolds,
  workModeEvent,
  type KioskSideFacts,
  type TillModeParams,
  type TillModeRefusal,
  type TillSession,
  type TillSideFacts,
  type WorkModeCommand,
} from '../src/core/workMode';

const on: TillModeParams = { enabled: true, idleReturnMinutes: 3 };
const atRest: KioskSideFacts = KIOSK_AT_REST;
const quietTill: TillSideFacts = QUIET_TILL;
const till = (over: Partial<TillSideFacts>): TillSideFacts => ({ ...QUIET_TILL, ...over });
const kiosk = (over: Partial<KioskSideFacts>): KioskSideFacts => ({ ...KIOSK_AT_REST, ...over });
const wire = (r: TillModeRefusal | null) => r?.wire ?? null;

describe('the parameters — off by default, every value read sensibly', () => {
  it('defaults, and what the cloud sets', () => {
    expect(paramsOf({})).toEqual({ enabled: false, idleReturnMinutes: 3 });
    expect(paramsOf(null)).toEqual({ enabled: false, idleReturnMinutes: 3 });
    expect(paramsOf({ kioskTillModeEnabled: 'true', kioskTillModeIdleReturnMinutes: '0' })).toEqual({ enabled: true, idleReturnMinutes: 0 });
    // The cloud's own types: a boolean and an integer.
    expect(paramsOf({ kioskTillModeEnabled: true, kioskTillModeIdleReturnMinutes: 7 })).toEqual({ enabled: true, idleReturnMinutes: 7 });
  });

  it('wrong values fall back, never fail open; the dropped "require manager" parameter is ignored', () => {
    const bad = paramsOf({ kioskTillModeEnabled: 'maybe', kioskTillModeIdleReturnMinutes: '-2', kioskTillModeRequireManager: 'false' });
    expect(bad.enabled).toBe(false);
    expect(bad.idleReturnMinutes).toBe(3);
    expect(paramsOf({ kioskTillModeIdleReturnMinutes: '2.5' }).idleReturnMinutes).toBe(3);
    expect(paramsOf({ kioskTillModeIdleReturnMinutes: '999' }).idleReturnMinutes).toBe(240);
    expect(paramsOf({ kioskTillModeIdleReturnMinutes: '5.0' }).idleReturnMinutes).toBe(5);
    expect(paramsOf({ kioskTillModeIdleReturnMinutes: true }).idleReturnMinutes).toBe(3);
    expect(paramsOf({ kioskTillModeIdleReturnMinutes: '  ' }).idleReturnMinutes).toBe(3);
    // Hebrew and English words for the gate; a number that is not 0 / 1 is no answer.
    expect(paramsOf({ kioskTillModeEnabled: 'כן' }).enabled).toBe(true);
    expect(paramsOf({ kioskTillModeEnabled: 'לא' }).enabled).toBe(false);
    expect(paramsOf({ kioskTillModeEnabled: 1 }).enabled).toBe(true);
    expect(paramsOf({ kioskTillModeEnabled: 2 }).enabled).toBe(false);
    expect(paramsOf({ kioskTillModeEnabled: 'on' }).enabled).toBe(false);
  });
});

describe('to the till — never when off, over a kiosk payment or a customer’s order', () => {
  it('the refusals, in order', () => {
    expect(wire(mayEnter({ enabled: false, idleReturnMinutes: 3 }, atRest))).toBe('disabled');
    expect(wire(mayEnter(on, kiosk({ paying: true })))).toBe('kiosk_payment');
    expect(wire(mayEnter(on, kiosk({ cardInFlight: true })))).toBe('kiosk_payment');
    expect(wire(mayEnter(on, kiosk({ ordering: true })))).toBe('customer_ordering');
    expect(wire(mayEnter(on, kiosk({ ordering: true, paying: true })))).toBe('kiosk_payment');
    expect(wire(mayEnter(on, atRest))).toBeNull();
  });

  it('the kiosk side is read from the kiosk’s own flow', () => {
    expect(kioskFactsOf({ flowState: 'attract', busy: false }, false)).toEqual(atRest);
    expect(kioskFactsOf({ flowState: 'paused', busy: false }, false)).toEqual(atRest);
    expect(kioskFactsOf({ flowState: 'ordering', busy: false }, false)).toEqual(kiosk({ ordering: true }));
    // The result on screen is a customer still reading it.
    expect(kioskFactsOf({ flowState: 'success', busy: false }, false)).toEqual(kiosk({ ordering: true }));
    expect(kioskFactsOf({ flowState: 'paying', busy: false }, false)).toEqual(kiosk({ paying: true }));
    expect(kioskFactsOf({ flowState: 'ordering', busy: true }, false)).toEqual(kiosk({ ordering: true, paying: true }));
    expect(kioskFactsOf({ flowState: 'attract', busy: false }, true)).toEqual(kiosk({ cardInFlight: true }));
  });
});

describe('always a manager’s code with KIOSK_TILL_MODE — none again when the code on screen is already one', () => {
  it('approval', () => {
    expect(approval(false)).toBe('manager');
    expect(approval(true)).toBe('none');
  });
});

describe('back to the kiosk — never over a sale, held sales never block and are said', () => {
  it('the refusals', () => {
    expect(wire(mayReturn(till({ basketOpen: true })))).toBe('basket_open');
    expect(wire(mayReturn(till({ checkoutOpen: true })))).toBe('payment_open');
    expect(wire(mayReturn(till({ holdsTender: true })))).toBe('payment_open');
    expect(wire(mayReturn(till({ cardInFlight: true, basketOpen: true })))).toBe('payment_open');
    expect(wire(mayReturn(till({ tableOpen: true })))).toBe('table_open');
    const held = till({ heldSales: 3 });
    expect(wire(mayReturn(held))).toBeNull();
    expect(heldNoticeOf(held)).toBe(3);
    expect(heldNoticeOf(quietTill)).toBeNull();
  });
});

describe('the idle return — off at 0, due after the minutes, never with a sale open, its notice', () => {
  const three = { ...on, idleReturnMinutes: 3 };
  it('due', () => {
    expect(idleReturnDue({ ...on, idleReturnMinutes: 0 }, 10 * 60_000, quietTill)).toBe(false);
    expect(idleReturnDue(three, 179_999, quietTill)).toBe(false);
    expect(idleReturnDue(three, 180_000, quietTill)).toBe(true);
    expect(idleReturnDue(three, 180_000, till({ heldSales: 2 }))).toBe(true);
    expect(idleReturnDue(three, 600_000, till({ basketOpen: true }))).toBe(false);
    expect(idleReturnDue({ ...three, enabled: false }, 600_000, quietTill)).toBe(false);
  });
  it('the notice, 30 s before', () => {
    expect(idleCountdownSec(three, 100_000, quietTill)).toBeNull();
    expect(idleCountdownSec(three, 150_000, quietTill)).toBe(30);
    expect(idleCountdownSec(three, 179_500, quietTill)).toBe(1);
    expect(idleCountdownSec(three, 180_000, quietTill)).toBeNull();
    expect(idleCountdownSec(three, 170_000, till({ basketOpen: true }))).toBeNull();
    expect(idleCountdownSec({ ...three, idleReturnMinutes: 0 }, 170_000, quietTill)).toBeNull();
    expect(idleCountdownSec({ ...three, enabled: false }, 170_000, quietTill)).toBeNull();
  });
});

describe('the dashboard’s switch — runs when it may, waits with the reason, done at once for the mode already on', () => {
  const toTill: WorkModeCommand = { id: 'c1', mode: 'till', by: 'דנה' };
  const toKiosk: WorkModeCommand = { id: 'c2', mode: 'kiosk', by: 'דנה' };
  it('the outcomes', () => {
    expect(remote(toTill, 'kiosk', on, atRest, quietTill)).toEqual({ run: true, done: true, blocked: null });
    expect(remote(toTill, 'kiosk', on, kiosk({ ordering: true }), quietTill)).toEqual({ run: false, done: false, blocked: REFUSALS.customer_ordering });
    expect(remote(toKiosk, 'till', on, atRest, till({ basketOpen: true }))).toEqual({ run: false, done: false, blocked: REFUSALS.basket_open });
    expect(remote(toKiosk, 'till', on, atRest, till({ heldSales: 4 }))).toEqual({ run: true, done: true, blocked: null });
    expect(remote(toKiosk, 'kiosk', on, atRest, quietTill)).toEqual({ run: false, done: true, blocked: null });
    // The owner's gate closed: the command is answered (done) and nothing moves.
    expect(remote(toTill, 'kiosk', { enabled: false, idleReturnMinutes: 3 }, atRest, quietTill)).toEqual({ run: false, done: true, blocked: REFUSALS.disabled });
  });

  it('the cloud’s command — read from kiosk sync, anything malformed ignored', () => {
    expect(parseCommand({ id: 'c1', mode: 'till', by: 'דנה' })).toEqual({ id: 'c1', mode: 'till', by: 'דנה' });
    expect(parseCommand({ id: 'c2', mode: 'kiosk', by: null })).toEqual({ id: 'c2', mode: 'kiosk', by: null });
    expect(parseCommand({ id: 'c3', mode: ' TILL ' })).toEqual({ id: 'c3', mode: 'till', by: null });
    expect(parseCommand({ id: 'c3', mode: 'tablet' })).toBeNull();
    expect(parseCommand({ mode: 'till' })).toBeNull();
    expect(parseCommand({ id: '  ', mode: 'till' })).toBeNull();
    expect(parseCommand(null)).toBeNull();
    expect(parseCommand('till')).toBeNull();
    expect(parseCommand([])).toBeNull();
    expect(parseMode('Kiosk')).toBe('kiosk');
    expect(parseMode(5)).toBeNull();
  });
});

describe('the session — kept across a restart as JSON', () => {
  it('round trip, odd values, nothing readable', () => {
    const s: TillSession = { sinceMs: 1_700_000_000_000, by: 'מנהל', byId: 'u1', source: 'remote' };
    expect(parseSession(sessionToJson(s))).toEqual(s);
    expect(parseSession('{"sinceMs":5,"by":null,"byId":null,"source":"?"}')).toEqual({ sinceMs: 5, by: null, byId: null, source: 'manual' });
    expect(parseSession('{"sinceMs":"7","by":"  ","byId":"","source":"idle"}')).toEqual({ sinceMs: 7, by: null, byId: null, source: 'idle' });
    expect(parseSession('not json')).toBeNull();
    expect(parseSession('5')).toBeNull();
    expect(parseSession('[]')).toBeNull();
    expect(parseSession(null)).toBeNull();
    expect(parseSession('')).toBeNull();
  });
});

describe('the till event and the status — what the cloud hears', () => {
  it('eventDetails', () => {
    const enter = eventDetails({ to: 'till', source: 'manual', by: 'מנהל', byId: 'u1', employee: null });
    expect(enter).toMatchObject({ action: 'enter', mode: 'till', reason: 'manual', by: 'מנהל', byId: 'u1', employee: null, heldSales: null, commandId: null });
    const exit = eventDetails({ to: 'kiosk', source: 'idle', by: 'דנה', byId: 'u2', employee: 'דנה', heldSales: 2, commandId: null });
    expect(exit).toMatchObject({ action: 'exit', mode: 'kiosk', reason: 'idle', heldSales: 2 });
    expect(eventDetails({ to: 'kiosk', source: 'remote', by: 'דנה', byId: null, employee: null, commandId: 'c9' }).commandId).toBe('c9');
    expect(TILL_EVENT).toBe('kiosk_till_mode');
  });

  it('the event as it goes to the cloud (TillEventIn)', () => {
    const e = workModeEvent({ id: 'e1', atMs: 0, shiftId: null, posUserId: 'u1', details: { action: 'enter' } });
    expect(e).toEqual({ id: 'e1', type: 'kiosk_till_mode', occurredAt: '1970-01-01T00:00:00.000Z', shiftId: null, posUserId: 'u1', details: { action: 'enter' } });
  });

  it('the wire the cloud validates (TillEventIn, type kiosk_till_mode): to the till and back', () => {
    const at = Date.parse('2026-10-10T08:30:00.000Z');
    const enter = workModeEvent({
      id: '2c9f6a14-7b3d-4e58-9a01-5d8e4f7b3c21',
      atMs: at,
      shiftId: '5b0c7e1d-1111-4222-8333-444455556666',
      posUserId: 'mgr',
      details: eventDetails({ to: 'till', source: 'manual', by: 'מנהלת סניף', byId: 'mgr', employee: null }),
    });
    const exit = workModeEvent({
      id: '8e1b5d37-6a42-4c90-b7f3-0a9c2d4e6f18',
      atMs: at + 5_400_000,
      shiftId: '5b0c7e1d-1111-4222-8333-444455556666',
      posUserId: 'e1',
      details: eventDetails({ to: 'kiosk', source: 'remote', by: 'דנה', byId: null, employee: 'דנה כהן', heldSales: 2, commandId: '3f2a9c1e-0b7d-4a65-8e14-2c5d7f9a1b30' }),
    });
    expect(enter.details).toEqual({ action: 'enter', mode: 'till', reason: 'manual', by: 'מנהלת סניף', byId: 'mgr', employee: null, heldSales: null, commandId: null });
    expect(exit.details).toMatchObject({ action: 'exit', mode: 'kiosk', reason: 'remote', employee: 'דנה כהן', heldSales: 2 });
    // The wire of TillEventIn: id, type, occurredAt, shiftId, posUserId, details — and nothing the cloud does not know.
    for (const e of [enter, exit]) {
      expect(Object.keys(e).sort()).toEqual(['details', 'id', 'occurredAt', 'posUserId', 'shiftId', 'type']);
      expect(e.type).toBe('kiosk_till_mode');
      expect(Number.isNaN(Date.parse(e.occurredAt))).toBe(false);
    }
    expect(exit.occurredAt).toBe('2026-10-10T10:00:00.000Z');
  });

  it('statusJson', () => {
    const status = statusJson({ sinceMs: 0, by: 'מנהל', byId: 'u1', source: 'manual' }, 'דנה', REFUSALS.basket_open);
    expect(status).toEqual({ since: '1970-01-01T00:00:00.000Z', enteredBy: 'מנהל', employee: 'דנה', source: 'manual', returnBlocked: 'basket_open' });
    // A till at home with a kiosk-mode row: no session.
    expect(statusJson(null, null, null)).toEqual({ since: null, enteredBy: null, employee: null, source: null, returnBlocked: null });
  });
});

describe('the Android app’s Hebrew, word for word', () => {
  it('refusals', () => {
    expect(REFUSAL_TEXT).toEqual({
      disabled: 'מצב קופה אינו מופעל במכשיר הזה',
      kiosk_payment: 'יש תשלום בתהליך בקיוסק — אי אפשר לעבור עכשיו',
      customer_ordering: 'לקוח באמצע הזמנה — אפשר "איפוס מסך לקוח" ואז לעבור',
      basket_open: 'יש מכירה פתוחה — סיימו או השהו אותה',
      payment_open: 'יש תשלום בתהליך — סיימו אותו קודם',
      table_open: 'הזמנת שולחן פתוחה במסך — סגרו אותה קודם',
      kiosk_config_missing: 'אין עדיין תצורת קיוסק במכשיר — נדרש חיבור לענן בפעם הראשונה',
    });
  });
  it('the section, the banner, the countdown', () => {
    expect(WORK_TEXT.title).toBe('מצב עבודה');
    expect([WORK_TEXT.kiosk, WORK_TEXT.till]).toEqual(['קיוסק', 'קופה']);
    expect(WORK_TEXT.needsManager).toBe('המעבר לקופה דורש קוד של מנהל עם ההרשאה "מעבר למצב קופה בקיוסק".');
    expect(WORK_TEXT.hint).toContain('המכשיר יעבוד כקופה עד שיוחזר לקיוסק');
    expect(WORK_TEXT.countdown(12)).toBe('חוזר לקיוסק בעוד 12 שניות');
    expect(WORK_TEXT.stay).toBe('נשארים');
    expect(WORK_TEXT.heldNotice(3)).toBe('יש 3 מכירות מושהות — יחכו במצב קופה');
    expect(WORK_TEXT.banner).toBe('מצב קופה — הקיוסק מושבת ללקוחות');
    expect(WORK_TEXT.menuToKiosk).toBe('מעבר לקיוסק');
    expect(WORK_TEXT.menuBack).toBe('חזרה למצב קיוסק');
  });
});

/* ------------------------------------------------------------ the home role */

describe('KioskHomeRole — a till by role is a kiosk only while away; a kiosk by role is untouched', () => {
  const kioskByRole = { kiosk: true, homeTill: false };
  const tillRow = { kiosk: true, homeTill: true };

  it('what the cloud said, as facts', () => {
    expect(rawFactsOf(null)).toEqual(NOT_A_KIOSK);
    expect(rawFactsOf({ kiosk: false, homeRole: 'till' })).toEqual({ kiosk: false, homeTill: false });
    expect(rawFactsOf({ kiosk: true })).toEqual(kioskByRole);
    expect(rawFactsOf({ kiosk: true, homeRole: 'kiosk' })).toEqual(kioskByRole);
    expect(rawFactsOf({ kiosk: true, homeRole: 'till' })).toEqual(tillRow);
  });

  it('effective: no kiosk for a till at home', () => {
    expect(KioskHomeRole.effective(tillRow, false).kiosk).toBe(false);
    expect(KioskHomeRole.effective(tillRow, true).kiosk).toBe(true);
    expect(KioskHomeRole.effective(kioskByRole, false).kiosk).toBe(true);
    expect(KioskHomeRole.effective(NOT_A_KIOSK, true).kiosk).toBe(false);
    const snap = { kiosk: true, homeRole: 'till', configVersion: 'v3' };
    expect(effectiveSnapshot(snap, false)).toEqual({ ...snap, kiosk: false });
    expect(effectiveSnapshot(snap, true)).toBe(snap);
    expect(effectiveSnapshot({ kiosk: true }, false)).toEqual({ kiosk: true });
    expect(effectiveSnapshot(null, false)).toBeNull();
  });

  it('mode: a kiosk by role — till while its till session lasts; a till by role — kiosk while away', () => {
    expect(KioskHomeRole.mode(kioskByRole, false, false)).toBe('kiosk');
    expect(KioskHomeRole.mode(kioskByRole, true, false)).toBe('till');
    expect(KioskHomeRole.mode(tillRow, false, false)).toBe('till');
    expect(KioskHomeRole.mode(tillRow, false, true)).toBe('kiosk');
    expect(KioskHomeRole.mode(NOT_A_KIOSK, false, false)).toBe('till');
    // A stale session of the other kind changes nothing.
    expect(KioskHomeRole.mode(tillRow, true, false)).toBe('till');
    expect(KioskHomeRole.mode(kioskByRole, false, true)).toBe('kiosk');
    expect(KioskHomeRole.mode(NOT_A_KIOSK, false, true)).toBe('till');
  });

  it('home, kioskByRole and where the idle return applies', () => {
    expect(KioskHomeRole.home(kioskByRole)).toBe('kiosk');
    expect(KioskHomeRole.home(tillRow)).toBe('till');
    expect(KioskHomeRole.home(NOT_A_KIOSK)).toBe('till');
    expect(KioskHomeRole.kioskByRole(kioskByRole)).toBe(true);
    expect(KioskHomeRole.kioskByRole(tillRow)).toBe(false);
    expect(KioskHomeRole.kioskByRole(NOT_A_KIOSK)).toBe(false);
    expect(KioskHomeRole.idleReturnApplies(kioskByRole)).toBe(true);
    expect(KioskHomeRole.idleReturnApplies(tillRow)).toBe(false);
  });
});

describe('what the cloud’s word does to the two sessions', () => {
  const kioskByRole = { kiosk: true, homeTill: false };
  const tillRow = { kiosk: true, homeTill: true };
  const none = { till: false, away: false };
  const noOp = { dropTill: false, dropAway: false, startTill: false };

  it('no longer a kiosk: the whole kiosk side goes at once', () => {
    expect(planAfterSync(kioskByRole, NOT_A_KIOSK, { till: true, away: false }, false)).toEqual({ ...noOp, dropTill: true });
    expect(planAfterSync(tillRow, NOT_A_KIOSK, { till: false, away: true }, false)).toEqual({ ...noOp, dropAway: true });
    expect(planAfterSync(NOT_A_KIOSK, NOT_A_KIOSK, none, false)).toEqual(noOp);
  });

  it('a till made a kiosk by role while an employee is signed in is never yanked away', () => {
    expect(planAfterSync(NOT_A_KIOSK, kioskByRole, none, true)).toEqual({ ...noOp, startTill: true });
    expect(planAfterSync(NOT_A_KIOSK, kioskByRole, none, false)).toEqual(noOp);
    expect(planAfterSync(tillRow, kioskByRole, none, true)).toEqual({ ...noOp, startTill: true });
    // Already a kiosk by role: nothing to start.
    expect(planAfterSync(kioskByRole, kioskByRole, none, true)).toEqual(noOp);
  });

  it('a kiosk by role made a till’s kiosk-mode row, or the reverse: the other mode’s session goes', () => {
    expect(planAfterSync(kioskByRole, tillRow, { till: true, away: false }, false)).toEqual({ ...noOp, dropTill: true });
    expect(planAfterSync(tillRow, kioskByRole, { till: false, away: true }, false)).toEqual({ ...noOp, dropAway: true });
    expect(planAfterSync(tillRow, tillRow, { till: false, away: true }, false)).toEqual(noOp);
  });
});

/* ---------------------------------------------------------- the manager's code */

const hash = (pin: string) => bcrypt.hashSync(pin, 4);
const compare = (p: string, h: string) => bcrypt.compare(p, h);
const SHOP = '2b67dd9e-6541-43eb-b2f3-6d26b6ecb03d';

function person(over: Partial<RosterUser> & { pin?: string }): RosterUser {
  const { pin, ...rest } = over;
  return { id: 'u-1', username: 'dana', firstName: 'דנה', lastName: 'כהן', pinHash: hash(pin ?? '1111'), role: 'cashier', isActive: true, shopId: SHOP, permissions: null, ...rest };
}
const manager = person({ id: 'mgr', username: 'boss', firstName: 'מנהלת', lastName: 'סניף', pin: '4821', role: 'shop_manager', permissions: { [KIOSK_TILL_MODE]: 'allow' } });
const cashier = person({ id: 'cash', username: 'cash', firstName: 'קופאי', lastName: '', pin: '1357', role: 'cashier', permissions: { [KIOSK_TILL_MODE]: 'deny' } });
const NOW = 1_800_000_000_000;

describe('the manager’s code — only a holder of KIOSK_TILL_MODE, five wrong codes lock it for a minute', () => {
  const base = { users: [manager, cashier], shopId: SHOP, lock: null, nowMs: NOW, compare };

  it('who may: active, of this shop, the permission allowed (an approval is a second person’s, not a pad’s)', () => {
    expect(managersFor([manager, cashier], SHOP).map((u) => u.id)).toEqual(['mgr']);
    expect(managersFor([{ ...manager, isActive: false }], SHOP)).toEqual([]);
    expect(managersFor([{ ...manager, shopId: 'other' }], SHOP)).toEqual([]);
    expect(managersFor([{ ...manager, permissions: { [KIOSK_TILL_MODE]: 'approval' } }], SHOP)).toEqual([]);
    // A roster from a server before roles: the legacy role answers — a shop manager yes, a cashier no.
    expect(managersFor([{ ...manager, permissions: null }, { ...cashier, permissions: null }], SHOP).map((u) => u.id)).toEqual(['mgr']);
    expect(userHolds([manager, cashier], SHOP, 'mgr')).toBe(true);
    expect(userHolds([manager, cashier], SHOP, 'cash')).toBe(false);
    expect(userHolds([manager, cashier], SHOP, null)).toBe(false);
  });

  it('granted, wrong, and the lock', async () => {
    const ok = await decideManager({ ...base, code: '4821' });
    expect(ok).toMatchObject({ outcome: 'granted', lock: { failures: 0, lockedUntilMs: 0 }, message: null });
    expect(ok.user?.id).toBe('mgr');
    // The cashier's own code is not a manager's.
    const wrong = await decideManager({ ...base, code: '1357' });
    expect(wrong).toMatchObject({ outcome: 'wrong', triesLeft: MAX_FAILURES - 1, lock: { failures: 1, lockedUntilMs: 0 } });
    expect(wrong.message).toBe(MANAGER_TEXT.wrong(MAX_FAILURES - 1));
    expect(await decideManager({ ...base, code: '   ' })).toMatchObject({ outcome: 'blank', message: MANAGER_TEXT.blank });
    expect(await decideManager({ ...base, users: [cashier], code: '1357' })).toMatchObject({ outcome: 'no_managers', message: MANAGER_TEXT.noManagers });
    const last = await decideManager({ ...base, lock: { failures: MAX_FAILURES - 1, lockedUntilMs: 0 }, code: '0000' });
    expect(last).toMatchObject({ outcome: 'locked_out', lockedForMs: LOCKOUT_MS, lock: { failures: MAX_FAILURES, lockedUntilMs: NOW + LOCKOUT_MS } });
    // While it runs even the right code is not looked at; a minute later it is clear again.
    const locked = await decideManager({ ...base, lock: last.lock, nowMs: NOW + 1_000, code: '4821' });
    expect(locked).toMatchObject({ outcome: 'locked', triesLeft: 0 });
    expect(locked.lockedForMs).toBe(LOCKOUT_MS - 1_000);
    expect(await decideManager({ ...base, lock: last.lock, nowMs: NOW + LOCKOUT_MS + 1, code: '4821' })).toMatchObject({ outcome: 'granted' });
  });

  it('the permission is spelled as the cloud’s catalogue', () => {
    expect(KIOSK_TILL_MODE).toBe('KIOSK_TILL_MODE');
  });
});
