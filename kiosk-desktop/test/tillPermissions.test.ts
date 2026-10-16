/**
 * "תפקידים והרשאות" with limits and "כשאין הרשאה" (core/till/permissions.ts) — the Android till's PermissionServiceTest
 * (limits, approvers, settings), DetailRefundApproverLimitTest (an approver held to their own ceiling) and DeniedActionsTest
 * (show / hide / code, the untouched and never-hidden codes, the line and basket entries), case for case on the roster's
 * shape (`permissions`, `limits`, `tillRoleKey`, `deniedUi`).
 */

import bcrypt from 'bcryptjs';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  APPROVER_OVER_LIMIT,
  DENIED_UI_UNTOUCHED,
  NEVER_HIDDEN,
  acting,
  actingProfile,
  approvalText,
  approveWithin,
  approversFor,
  basketDiscountShown,
  decide,
  deniedActionUiOf,
  deniedMode,
  deniedText,
  deniedUiSettingsOf,
  legacyUi,
  lineDiscountPercents,
  lineRemoveShown,
  mayActAlone,
  mayApprove,
  profileOf,
  shows,
  untouched,
  type ProfileUser,
} from '../src/core/till/permissions';
import { CODES, NO_LOCK, type RosterUser } from '../src/core/desktopExit';

type User = RosterUser & ProfileUser;

const ALLOW_ALL = Object.fromEntries(CODES.map((c) => [c, 'allow']));
/** The spec's built-in roles, the codes these tests read (till_permissions_matrix.json). */
const ROLES: Record<string, Record<string, string>> = {
  waiter: { DISCOUNT: 'approval', OTH: 'approval', REFUND: 'deny', LINE_VOID: 'allow', HELD_SALE_CANCEL: 'approval', SHIFT_CLOSE: 'allow', Z: 'deny', X: 'allow', SHOP_X_REPORT: 'deny', 'CASH_DRAWER.CASH_OUT': 'deny', 'CASH_DRAWER.OPEN_ON_CASH_SALE': 'deny', SHIFT_OPEN: 'deny', CARD_UNRESOLVED: 'deny', SELL_RESTRICTED_ITEMS: 'deny' },
  cashier: { DISCOUNT: 'approval', OTH: 'approval', REFUND: 'approval', LINE_VOID: 'allow', HELD_SALE_CANCEL: 'approval', SHIFT_CLOSE: 'allow', Z: 'approval', X: 'allow' },
  supervisor: { DISCOUNT: 'allow', OTH: 'allow', REFUND: 'allow', LINE_VOID: 'allow', 'CASH_DRAWER.CASH_OUT': 'allow', 'CASH_DRAWER.APPROVE_OPEN': 'allow' },
  manager: ALLOW_ALL,
};

let n = 0;
function user(key: string, extra: { limits?: Record<string, Record<string, number>>; states?: Record<string, string>; deniedUi?: string | null; pin?: string } = {}): User {
  n += 1;
  return {
    id: `${key}-${n}`,
    username: key,
    firstName: key,
    lastName: null,
    pinHash: bcrypt.hashSync(extra.pin ?? `${1000 + n}`, 4),
    role: key === 'manager' ? 'shop_manager' : 'cashier',
    isActive: true,
    shopId: null,
    permissions: { ...ROLES[key], ...(extra.states ?? {}) },
    limits: extra.limits ?? null,
    tillRoleKey: key,
    deniedUi: extra.deniedUi ?? null,
  };
}

const compare = (p: string, h: string) => bcrypt.compare(p, h);

describe('limits and approvers (PermissionServiceTest, DetailRefundApproverLimitTest)', () => {
  it('a discount up to the role\'s percent is alone, above it is asked', () => {
    const sup = profileOf(user('supervisor', { limits: { DISCOUNT: { maxPercent: 30 } } }));
    expect(decide(sup, 'DISCOUNT', { percent: 30 }).kind).toBe('allowed');
    expect(decide(sup, 'DISCOUNT', { percent: 31 })).toEqual({ kind: 'approval', code: 'DISCOUNT', why: 'over_limit', amount: null, percent: 31 });
  });

  it('a supervisor takes out up to 200 alone, above it a manager approves', () => {
    const sup = profileOf(user('supervisor', { limits: { 'CASH_DRAWER.CASH_OUT': { maxAmount: 200 } } }));
    expect(decide(sup, 'CASH_DRAWER.CASH_OUT', { amount: 200 }).kind).toBe('allowed');
    expect(decide(sup, 'CASH_DRAWER.CASH_OUT', { amount: 200.01 }).kind).toBe('approval');
  });

  it('settings force or waive a second person but never undo a denial', () => {
    const cashier = profileOf(user('cashier'));
    const waiter = profileOf(user('waiter'));
    const manager = profileOf(user('manager'));
    expect(decide(manager, 'DISCOUNT', { forceApproval: true })).toMatchObject({ kind: 'approval', why: 'setting' });
    expect(decide(cashier, 'OTH', { relaxApproval: true }).kind).toBe('allowed');
    expect(decide(waiter, 'REFUND', { relaxApproval: true }).kind).toBe('denied');
    expect(decide(waiter, 'REFUND', { forceApproval: true }).kind).toBe('denied');
  });

  it('nobody signed in is nobody\'s authority; an unknown code is never granted', () => {
    expect(decide(null, 'REFUND')).toEqual({ kind: 'denied', code: 'REFUND', why: 'not_signed_in' });
    const manager = profileOf(user('manager'));
    expect(decide(manager, 'NOT_A_CODE').kind).toBe('denied');
    expect(mayApprove(manager, 'NOT_A_CODE')).toBe(false);
    expect(mayActAlone(manager, 'REFUND')).toBe(true);
  });

  it('a drawer approver must also be allowed to approve drawer actions', () => {
    const sup = profileOf(user('supervisor'));
    const supNoApprove = profileOf(user('supervisor', { states: { 'CASH_DRAWER.APPROVE_OPEN': 'deny' } }));
    expect(mayApprove(sup, 'CASH_DRAWER.CASH_OUT', 100)).toBe(true);
    expect(mayApprove(supNoApprove, 'CASH_DRAWER.CASH_OUT', 100)).toBe(false);
  });

  it('the history refund prompt offers only approvers whose limit covers the credit', () => {
    const roster = [user('manager'), user('supervisor', { limits: { REFUND: { maxAmount: 500 } } }), user('supervisor', { limits: { REFUND: { maxAmount: 2000 } } }), user('cashier')];
    const at1000 = approversFor(roster, null, 'REFUND', 1000).map((u) => u.username + (u.id.split('-')[1] ?? ''));
    expect(at1000).toHaveLength(2);
    expect(approversFor(roster, null, 'REFUND', 300)).toHaveLength(3);
    expect(approversFor(roster, null, 'REFUND', 300, null, roster[0].id)).toHaveLength(2);
  });

  it('a 500 manager\'s code is not spent on a 2000 refund: said so, no wrong try counted', async () => {
    const small = user('supervisor', { limits: { REFUND: { maxAmount: 500 } }, pin: '5500' });
    const big = user('manager', { pin: '9900' });
    const users = [small, big];
    const over = await approveWithin({ users, shopId: null, code: 'REFUND', pin: '5500', lock: NO_LOCK, nowMs: 0, compare, amount: 2000 });
    expect(over).toMatchObject({ ok: false, reason: 'over_limit', message: APPROVER_OVER_LIMIT });
    if (!over.ok) expect(over.lock.failures).toBe(0);
    const ok = await approveWithin({ users, shopId: null, code: 'REFUND', pin: '9900', lock: NO_LOCK, nowMs: 0, compare, amount: 2000 });
    expect(ok.ok && ok.user.id).toBe(big.id);
    const within = await approveWithin({ users, shopId: null, code: 'REFUND', pin: '5500', lock: NO_LOCK, nowMs: 0, compare, amount: 400 });
    expect(within.ok && within.user.id).toBe(small.id);
    const wrong = await approveWithin({ users, shopId: null, code: 'REFUND', pin: '0000', lock: NO_LOCK, nowMs: 0, compare, amount: 400 });
    expect(wrong).toMatchObject({ ok: false, reason: 'wrong' });
  });

  it('a discount approver is held to their own percent', async () => {
    const sup30 = user('supervisor', { limits: { DISCOUNT: { maxPercent: 30 } }, pin: '3030' });
    const users = [sup30, user('cashier')];
    expect((await approveWithin({ users, shopId: null, code: 'DISCOUNT', pin: '3030', lock: NO_LOCK, nowMs: 0, compare, percent: 50 })).ok).toBe(false);
    expect((await approveWithin({ users, shopId: null, code: 'DISCOUNT', pin: '3030', lock: NO_LOCK, nowMs: 0, compare, percent: 20 })).ok).toBe(true);
  });

  it('the denial and approval lines name the permission', () => {
    expect(deniedText('REFUND', 'role')).toBe('אין לך הרשאה: זיכוי / החזר');
    expect(deniedText('REFUND', 'not_signed_in')).toBe('יש להתחבר לקופה');
    expect(deniedText('REFUND', 'setting')).toBe('זיכוי / החזר — חסום בהגדרות הקופה');
    expect(approvalText({ kind: 'approval', code: 'DISCOUNT', why: 'role', amount: null, percent: null })).toBe('הנחה — דורש אישור מנהל');
    expect(approvalText({ kind: 'approval', code: 'DISCOUNT', why: 'over_limit', amount: null, percent: 50 })).toBe('הנחה — מעל המותר לך, דורש אישור מנהל');
    expect(approvalText({ kind: 'approval', code: 'DISCOUNT', why: 'setting', amount: null, percent: null })).toBe('הנחה — באישור מנהל לפי הגדרות הקופה');
  });

  it('a roster with no profile answers as the legacy role (a cashier asks a manager for REFUND, DISCOUNT, OTH, HELD_SALE_CANCEL)', () => {
    const legacy = profileOf({ id: 'x', role: 'cashier', permissions: null });
    for (const code of ['REFUND', 'DISCOUNT', 'OTH', 'HELD_SALE_CANCEL']) expect(decide(legacy, code).kind).toBe('approval');
    expect(decide(legacy, 'LINE_VOID').kind).toBe('allowed');
    expect(decide(profileOf({ id: 'm', role: 'shop_manager', permissions: null }), 'REFUND').kind).toBe('allowed');
  });
});

describe('"כשאין הרשאה" (DeniedActionsTest)', () => {
  it('the wire values and the parameter', () => {
    expect(deniedActionUiOf('show')).toBe('show');
    expect(deniedActionUiOf(' HIDE ')).toBe('hide');
    expect(deniedActionUiOf('code')).toBe('code');
    expect(deniedActionUiOf('inherit')).toBeNull();
    expect(deniedActionUiOf('')).toBeNull();
    expect(deniedActionUiOf(null)).toBeNull();
  });

  it('the parameters - show by default, the older permissionsDeniedUi kept beside', () => {
    expect(deniedUiSettingsOf({})).toEqual({ level: 'show', legacy: 'hide' });
    expect(deniedUiSettingsOf({ deniedActionUi: 'hide', permissionsDeniedUi: 'הצג מושבת עם הסבר' })).toEqual({ level: 'hide', legacy: 'disable' });
    expect(deniedUiSettingsOf({ deniedActionUi: 'nonsense' }).level).toBe('show');
  });

  it("the untouched codes are the cloud's list - rules and capabilities, never options", () => {
    expect([...DENIED_UI_UNTOUCHED].sort()).toEqual(['CASH_DRAWER.APPROVE_OPEN', 'CASH_DRAWER.OPEN_ON_CASH_SALE', 'DESKTOP_EXIT', 'MULTI_DEVICE_LOGIN', 'SELL_RESTRICTED_ITEMS']);
    expect(untouched('APPROVE_REMOTE.refund')).toBe(true);
    expect(untouched('REFUND')).toBe(false);
    // The server's own list, when it is next to us (feat/denied-actions-ui's till_permissions.py).
    const server = path.resolve(__dirname, '..', '..', 'server', 'app', 'services', 'till_permissions.py');
    if (existsSync(server)) {
      const src = readFileSync(server, 'utf8');
      const m = /DENIED_UI_UNTOUCHED: FrozenSet\[str\] = frozenset\(\{([\s\S]*?)\}\)/.exec(src);
      if (m) expect([...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]).sort()).toEqual([...DENIED_UI_UNTOUCHED].sort());
    }
  });

  it('the roster carries it, an older cloud does not', () => {
    expect(profileOf(user('waiter', { deniedUi: 'hide' })).deniedUi).toBe('hide');
    expect(profileOf(user('waiter')).deniedUi).toBeNull();
    expect(profileOf({ id: 'x', role: 'cashier', permissions: null, deniedUi: 'nonsense' }).deniedUi).toBeNull();
  });

  it("the operator's own answer wins over the level's, and the level over show", () => {
    const own = profileOf(user('waiter', { deniedUi: 'code' }));
    const none = profileOf(user('waiter'));
    expect(deniedMode(own, { level: 'hide', legacy: 'hide' })).toBe('code');
    expect(deniedMode(none, { level: 'hide', legacy: 'hide' })).toBe('hide');
    expect(deniedMode(none, deniedUiSettingsOf({}))).toBe('show');
  });

  it('under code every denial but the untouched is an approval - nothing becomes allowed', () => {
    const waiter = profileOf(user('waiter'));
    const turned = acting(waiter, 'code', CODES);
    expect(turned.state('REFUND')).toBe('approval');
    expect(turned.state('Z')).toBe('approval');
    expect(turned.state('CASH_DRAWER.CASH_OUT')).toBe('approval');
    expect(turned.state('LINE_VOID')).toBe('allow');
    expect(turned.state('DISCOUNT')).toBe('approval');
    // The untouched stay denied.
    expect(turned.state('CASH_DRAWER.OPEN_ON_CASH_SALE')).toBe('deny');
    expect(turned.state('SELL_RESTRICTED_ITEMS')).toBe('deny');
    expect(turned.askedForCode.has('REFUND')).toBe(true);
    expect(acting(waiter, 'show', CODES)).toBe(waiter);
    expect(acting(waiter, 'hide', CODES)).toBe(waiter);
  });

  it('a denial asked as a code is never relaxed into allowed - OTH without othRequiresManager', () => {
    const waiter = profileOf(user('waiter', { states: { OTH: 'deny' } }));
    const turned = acting(waiter, 'code', CODES);
    expect(decide(turned, 'OTH', { relaxApproval: true }).kind).toBe('approval');
    // An approval the role itself gives is relaxed as before.
    expect(decide(profileOf(user('cashier')), 'OTH', { relaxApproval: true }).kind).toBe('allowed');
  });

  it("the role's hide over the level's code - per operator", () => {
    const hider = profileOf(user('waiter', { deniedUi: 'hide' }));
    const p = actingProfile(hider, { level: 'code', legacy: 'hide' }, CODES)!;
    expect(p.state('REFUND')).toBe('deny');
    expect(shows(hider, 'REFUND', { level: 'code', legacy: 'hide' })).toBe(false);
  });

  it('hide leaves out only a role\'s denial - allowed and approval always shown', () => {
    const waiter = profileOf(user('waiter'));
    const hide = { level: 'hide' as const, legacy: 'hide' as const };
    expect(shows(waiter, 'REFUND', hide)).toBe(false);
    expect(shows(waiter, 'Z', hide)).toBe(false);
    expect(shows(waiter, 'DISCOUNT', hide)).toBe(true);
    expect(shows(waiter, 'LINE_VOID', hide)).toBe(true);
    // Under show (today) every option is shown — a tap says "אין הרשאה".
    expect(shows(waiter, 'REFUND', deniedUiSettingsOf({}))).toBe(true);
    // Under code, shown — the tap asks a manager.
    expect(shows(waiter, 'REFUND', { level: 'code', legacy: 'hide' })).toBe(true);
  });

  it('never hidden - what is needed to finish or to get out - and the safety places', () => {
    const waiter = profileOf(user('waiter'));
    const hide = { level: 'hide' as const, legacy: 'hide' as const };
    for (const code of NEVER_HIDDEN) expect(shows(profileOf(user('waiter', { states: { [code]: 'deny' } })), code, hide)).toBe(true);
    expect(shows(waiter, 'REFUND', hide, 'safety')).toBe(true);
    // An approval the till holds for it shows it again.
    expect(shows(waiter, 'REFUND', hide, 'option', true)).toBe(true);
  });

  it('the entries that always read permissionsDeniedUi keep doing so under show - and only there', () => {
    const waiter = profileOf(user('waiter'));
    expect(shows(waiter, 'SHOP_X_REPORT', { level: 'show', legacy: 'hide' }, 'legacy')).toBe(false);
    expect(shows(waiter, 'SHOP_X_REPORT', { level: 'show', legacy: 'disable' }, 'legacy')).toBe(true);
    expect(shows(waiter, 'SHOP_X_REPORT', { level: 'code', legacy: 'hide' }, 'legacy')).toBe(true);
    expect(legacyUi(waiter, { level: 'hide', legacy: 'disable' })).toBe('hide');
    expect(legacyUi(waiter, { level: 'show', legacy: 'disable' })).toBe('disable');
    // Nobody signed in: as today.
    expect(shows(null, 'SHOP_X_REPORT', { level: 'hide', legacy: 'hide' }, 'legacy')).toBe(false);
    expect(shows(null, 'REFUND', { level: 'hide', legacy: 'hide' })).toBe(true);
  });

  it("a line's remove and discount chips", () => {
    expect(lineRemoveShown(false, false, 0)).toBe(false);
    expect(lineRemoveShown(false, true, 0)).toBe(true);
    expect(lineRemoveShown(false, false, 1)).toBe(true);
    expect(lineDiscountPercents([0, 5, 10, 20], true, false)).toEqual([0, 5, 10, 20]);
    expect(lineDiscountPercents([0, 5, 10, 20], false, true)).toEqual([0]);
    expect(lineDiscountPercents([0, 5, 10, 20], false, false)).toEqual([]);
    expect(basketDiscountShown(false, true)).toBe(true);
    expect(basketDiscountShown(false, false)).toBe(false);
  });
});
