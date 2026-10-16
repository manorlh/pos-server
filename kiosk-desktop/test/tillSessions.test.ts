/**
 * "עובד מחובר בקופה אחת בלבד" (exclusive login v2) and "נעילה בחוסר שימוש" on the Windows till — the Android till's cases
 * (pos-android ExclusiveLoginTest) against core/till/exclusiveLogin.ts and main/till/userSessions.ts, and the engine's sign-in
 * over a real KioskService with a fake cloud. Tests only: no real server.
 */

import bcrypt from 'bcryptjs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EXCLUSIVE_OFF,
  autoReleaseMinutesOf,
  cloudIdOf,
  duplicateOf,
  enabledOf,
  exclusiveSettingsOf,
  exempt,
  heartbeatBeat,
  offlineOf,
  releaseDone,
  releaseRoute,
  sessionReplyOf,
  signInDecision,
  signInUnder,
  sinceLabel,
  tillLabel,
  type ExclusiveSettings,
  type SessionHolder,
  type SessionReply,
} from '../src/core/till/exclusiveLogin';
import { UserSessionGuard, idleLockSecondsOf, noticeText, type GuardUser, type UserSessionHostRemote, type UserSessionRemote } from '../src/main/till/userSessions';
import { harness, type Harness, type HarnessOptions } from './tillEngineHarness';

const DANA = '11111111-2222-4333-8444-000000000001';
const RUTI = '11111111-2222-4333-8444-000000000002';
const holder: SessionHolder = { posUserName: 'דנה', machineId: 'm1', machineName: 'בר', posNumber: '3', since: '2026-10-05T11:05:00+00:00' };
const ok = (status: string, warnings: string[] = []): SessionReply => ({ kind: 'ok', status, warnings });
const elsewhere = (h: SessionHolder = holder, duplicate: 'warn' | 'signout' | null = null): SessionReply => ({ kind: 'elsewhere', holder: h, duplicate });
const offline: SessionReply = { kind: 'offline', reason: 'timeout' };

describe('the parameter, the ids and who the rule is for', () => {
  it('the rule is off unless the parameter says true', () => {
    expect(enabledOf({})).toBe(false);
    expect(enabledOf({ exclusiveUserLogin: 'false' })).toBe(false);
    expect(enabledOf({ exclusiveUserLogin: 'true' })).toBe(true);
    expect(enabledOf({ exclusiveUserLogin: ' TRUE ' })).toBe(true);
  });

  it('only an employee the cloud knows by a uuid is checked', () => {
    expect(cloudIdOf(DANA)).toBe(DANA);
    expect(cloudIdOf('local', DANA)).toBe(DANA);
    expect(cloudIdOf('demo-cashier')).toBeNull();
  });

  it('the v2 parameters, with their defaults', () => {
    expect(exclusiveSettingsOf({ exclusiveUserLogin: 'true' })).toEqual({ enabled: true, offline: 'allow', duplicate: 'warn', autoReleaseMinutes: null });
    expect(offlineOf({ exclusiveUserLoginOffline: ' LAN' })).toBe('lan');
    expect(offlineOf({ exclusiveUserLoginOffline: 'manager' })).toBe('manager');
    expect(offlineOf({ exclusiveUserLoginOffline: 'nonsense' })).toBe('allow');
    expect(duplicateOf({ exclusiveUserLoginDuplicate: 'signout' })).toBe('signout');
    expect(duplicateOf({ exclusiveUserLoginDuplicate: '' })).toBe('warn');
    expect(autoReleaseMinutesOf({ exclusiveUserLoginStaleMinutes: '30' })).toBeNull();
    const minutes = { exclusiveUserLoginAutoRelease: 'minutes' };
    expect(autoReleaseMinutesOf(minutes)).toBe(15);
    expect(autoReleaseMinutesOf({ ...minutes, exclusiveUserLoginStaleMinutes: '30' })).toBe(30);
    expect(autoReleaseMinutesOf({ ...minutes, exclusiveUserLoginStaleMinutes: '1' })).toBe(2);
    expect(autoReleaseMinutesOf({ ...minutes, exclusiveUserLoginStaleMinutes: '9999' })).toBe(720);
    expect(autoReleaseMinutesOf({ ...minutes, exclusiveUserLoginStaleMinutes: 'x' })).toBe(15);
  });

  it('whoever holds MULTI_DEVICE_LOGIN is exempt; a cloud that predates it keeps the rule for everyone', () => {
    expect(exempt({ role: 'cashier', permissions: { MULTI_DEVICE_LOGIN: 'allow' } })).toBe(true);
    expect(exempt({ role: 'cashier', permissions: { MULTI_DEVICE_LOGIN: 'deny' } })).toBe(false);
    expect(exempt({ role: 'cashier', permissions: { MULTI_DEVICE_LOGIN: 'approval' } })).toBe(false);
    expect(exempt({ role: 'cashier', permissions: { SELL: 'allow' } })).toBe(false);
    expect(exempt({ role: 'cashier' })).toBe(false);
  });

  it('the release is a supervisor\'s or a manager\'s now - a waiter or a cashier asks a manager', () => {
    const matrix = JSON.parse(readFileSync(path.resolve(__dirname, '..', '..', 'server', 'tests', 'fixtures', 'till_permissions_matrix.json'), 'utf8')) as { roles: Record<string, { states: Record<string, string> }> };
    for (const role of ['waiter', 'cashier']) {
      expect(matrix.roles[role].states.USER_SESSION_RELEASE, role).toBe('deny');
      expect(matrix.roles[role].states.MULTI_DEVICE_LOGIN, role).toBe('deny');
    }
    for (const role of ['supervisor', 'manager']) {
      expect(matrix.roles[role].states.USER_SESSION_RELEASE, role).toBe('allow');
      expect(matrix.roles[role].states.MULTI_DEVICE_LOGIN, role).toBe('allow');
    }
    expect(releaseRoute(false, false)).toBe('manager_code');
    expect(releaseRoute(true, false)).toBe('own_authority');
    expect(releaseRoute(true, true)).toBe('own_authority_on_host');
    expect(releaseRoute(false, true)).toBe('manager_code_on_host');
  });
});

describe('the decisions', () => {
  it('a sign-in is stopped only by signed in elsewhere; no answer, or one the till cannot act on, lets the employee in', () => {
    for (const s of ['claimed', 'held', 'off', 'exempt']) expect(signInDecision(ok(s))).toEqual({ kind: 'proceed' });
    expect(signInDecision(elsewhere())).toEqual({ kind: 'blocked', holder, viaHost: false });
    expect(signInDecision(offline)).toEqual({ kind: 'proceed_unchecked' });
    expect(signInDecision({ kind: 'refused', status: 404, code: 'pos_user_not_found' })).toEqual({ kind: 'proceed' });
    expect(signInDecision({ kind: 'needs_manager', code: 'elevation_already_used' })).toEqual({ kind: 'ask_manager' });
    expect(signInDecision({ kind: 'manager_refused', code: 'elevation_wrong_machine' })).toEqual({ kind: 'approval_refused', code: 'elevation_wrong_machine' });
  });

  it('offline allow - in, unchecked, whatever the host would say', () => {
    expect(signInUnder(offline, 'allow', null)).toEqual({ kind: 'proceed_unchecked' });
    expect(signInUnder(offline, 'allow', elsewhere())).toEqual({ kind: 'proceed_unchecked' });
  });

  it('offline lan - the host decides, and without one it is allow', () => {
    expect(signInUnder(offline, 'lan', elsewhere())).toEqual({ kind: 'blocked', holder, viaHost: true });
    expect(signInUnder(offline, 'lan', ok('claimed'))).toEqual({ kind: 'proceed' });
    expect(signInUnder(offline, 'lan', null)).toEqual({ kind: 'proceed_unchecked' });
    expect(signInUnder(offline, 'lan', { kind: 'offline', reason: 'no LAN host' })).toEqual({ kind: 'proceed_unchecked' });
    expect(signInUnder(ok('held'), 'lan', elsewhere())).toEqual({ kind: 'proceed' });
    expect(signInUnder(elsewhere(), 'lan', null)).toEqual({ kind: 'blocked', holder, viaHost: false });
  });

  it('offline manager - the host if it answers, else a managers code', () => {
    expect(signInUnder(offline, 'manager', null)).toEqual({ kind: 'manager_code' });
    expect(signInUnder(offline, 'manager', { kind: 'offline', reason: 'x' })).toEqual({ kind: 'manager_code' });
    expect(signInUnder(offline, 'manager', ok('claimed'))).toEqual({ kind: 'proceed' });
    expect(signInUnder(offline, 'manager', elsewhere())).toEqual({ kind: 'blocked', holder, viaHost: true });
    expect(signInUnder(ok('claimed'), 'manager', null)).toEqual({ kind: 'proceed' });
  });

  it('a heartbeat warns, signs out only on a managers release, and otherwise waits; a duplicate signs out only where the shop chose', () => {
    expect(heartbeatBeat(ok('held'))).toEqual({ kind: 'fine' });
    expect(heartbeatBeat(elsewhere())).toEqual({ kind: 'warn', holder });
    const released: SessionReply = { kind: 'released', byName: 'רותי', fromDashboard: false, now: holder, releasedBy: null };
    expect(heartbeatBeat(released)).toEqual({ kind: 'sign_out', released });
    expect(heartbeatBeat(offline)).toEqual({ kind: 'again' });
    expect(heartbeatBeat({ kind: 'refused', status: 404, code: null })).toEqual({ kind: 'again' });
    expect(heartbeatBeat(elsewhere(), 'signout')).toEqual({ kind: 'sign_out_duplicate', holder });
    expect(heartbeatBeat(ok('held'), 'signout')).toEqual({ kind: 'fine' });
    // The cloud's duplicate mode in its answer wins over the till's own parameter.
    expect(heartbeatBeat(elsewhere(holder, 'signout'), 'warn')).toEqual({ kind: 'sign_out_duplicate', holder });
    expect(heartbeatBeat(elsewhere(holder, 'warn'), 'signout')).toEqual({ kind: 'warn', holder });
  });

  it('a release is done once the cloud answered at all', () => {
    expect(releaseDone(ok('not_held'))).toBe(true);
    expect(releaseDone({ kind: 'refused', status: 404, code: null })).toBe(true);
    expect(releaseDone(offline)).toBe(false);
  });

  it('since is the time today and the date before; the till is named by what the cloud gave', () => {
    const now = Date.parse('2026-10-05T15:00:00Z');
    expect(sinceLabel('2026-10-05T11:05:00+00:00', now)).toBe('14:05');
    expect(sinceLabel('2026-10-05T11:05:00.123456+00:00', now)).toBe('14:05');
    expect(sinceLabel('2026-10-03T19:30:00+00:00', now)).toBe('03/10 22:30');
    expect(sinceLabel('yesterday', now)).toBeNull();
    expect(sinceLabel(null, now)).toBeNull();
    expect(tillLabel(holder)).toBe('קופה 3 (בר)');
    expect(tillLabel({ ...holder, machineName: null })).toBe('קופה 3');
    expect(tillLabel({ ...holder, posNumber: ' ' })).toBe('קופה „בר”');
    expect(tillLabel({})).toBe('קופה אחרת');
  });

  it("the cloud's answers are read off the wire", () => {
    expect(sessionReplyOf(200, { status: 'claimed', exclusive: true })).toEqual(ok('claimed'));
    expect(sessionReplyOf(200, { status: 'exempt' })).toEqual(ok('exempt'));
    expect(sessionReplyOf(409, { detail: { code: 'user_signed_in_elsewhere', posUserName: 'דנה כהן', machineId: 'm1', machineName: 'בר', posNumber: '3', since: '2026-10-05T11:05:00+00:00', lastSeenAt: null } })).toEqual({
      kind: 'elsewhere',
      holder: { posUserName: 'דנה כהן', machineId: 'm1', machineName: 'בר', posNumber: '3', since: '2026-10-05T11:05:00+00:00', lastSeenAt: null, silentSince: null },
      duplicate: null,
    });
    expect(sessionReplyOf(409, { detail: { code: 'user_session_released', releasedBy: 'manager', releasedByName: 'רותי', fromDashboard: true, now: null } })).toEqual({
      kind: 'released',
      byName: 'רותי',
      fromDashboard: true,
      now: null,
      releasedBy: 'manager',
    });
    const dup = sessionReplyOf(409, { detail: { code: 'user_session_released', releasedBy: 'duplicate', fromDashboard: false, now: { machineId: 'm1', machineName: 'בר', posNumber: '1' } } });
    expect(dup.kind === 'released' && dup.releasedBy === 'duplicate' && dup.now?.machineName).toBe('בר');
    expect(sessionReplyOf(409, { detail: { code: 'user_signed_in_elsewhere', machineId: 'm1', duplicate: 'signout' } })).toMatchObject({ kind: 'elsewhere', duplicate: 'signout' });
    expect(sessionReplyOf(401, { detail: 'elevation_required' })).toEqual({ kind: 'needs_manager', code: 'elevation_required' });
    expect(sessionReplyOf(403, { detail: 'elevation_wrong_machine' })).toEqual({ kind: 'manager_refused', code: 'elevation_wrong_machine' });
    expect(sessionReplyOf(404, { detail: 'pos_user_not_found' })).toEqual({ kind: 'refused', status: 404, code: 'pos_user_not_found' });
    expect(sessionReplyOf(502, '<html>bad gateway</html>').kind).toBe('offline');
    // A forced claim that freed a silent device's tables says so.
    expect(sessionReplyOf(200, { status: 'claimed', tookOver: { warnings: ['שולחן 12 נפתח במכשיר שלא מדווח מאז 20:14.'] } })).toEqual(ok('claimed', ['שולחן 12 נפתח במכשיר שלא מדווח מאז 20:14.']));
  });

  it('a silent holder is said so - the other device has not reported since', () => {
    const r = sessionReplyOf(409, { detail: { code: 'user_signed_in_elsewhere', machineId: 'm1', since: '2026-10-05T11:05:00+00:00', lastSeenAt: '2026-10-05T11:20:00+00:00', holderSilentSince: '2026-10-05T11:20:00+00:00' } });
    expect(r.kind === 'elsewhere' && r.holder.silentSince).toBe('2026-10-05T11:20:00+00:00');
    expect(sinceLabel('2026-10-05T11:20:00+00:00', Date.parse('2026-10-05T12:00:00Z'))).toBe('14:20');
    const live = sessionReplyOf(409, { detail: { code: 'user_signed_in_elsewhere', machineId: 'm1', holderSilentSince: null } });
    expect(live.kind === 'elsewhere' && live.holder.silentSince).toBeNull();
  });
});

/* --------------------------------------------------------------- the guard */

class FakeRemote implements UserSessionRemote {
  claimReply: SessionReply = ok('claimed');
  forceReply: SessionReply | null = null;
  beatReply: SessionReply = ok('held');
  releaseReply: SessionReply = ok('released');
  calls: string[] = [];
  lastForce: [boolean, string | null] | null = null;
  lastSignedInAt: string | null = null;
  async claim(id: string, force = false, operatorId: string | null = null) {
    this.calls.push(force ? `force:${id}:${operatorId}` : `claim:${id}`);
    this.lastForce = [force, operatorId];
    return force ? (this.forceReply ?? this.claimReply) : this.claimReply;
  }
  async heartbeat(id: string, signedInAt: string | null = null) {
    this.calls.push(`heartbeat:${id}`);
    this.lastSignedInAt = signedInAt;
    return this.beatReply;
  }
  async release(id: string) {
    this.calls.push(`release:${id}`);
    return this.releaseReply;
  }
  async list() {
    return null;
  }
  async releaseSession() {
    return null;
  }
}

class FakeHost implements UserSessionHostRemote {
  claimReply: SessionReply = ok('claimed');
  beatReply: SessionReply = ok('held');
  calls: string[] = [];
  async claim(id: string, name: string | null, minutes: number | null, o: { observed?: boolean; approverId?: string | null } = {}) {
    this.calls.push(o.observed ? `observed-claim:${id}` : o.approverId ? `force:${id}:${o.approverId}` : `claim:${id}:${name}:${minutes}`);
    return this.claimReply;
  }
  async heartbeat(id: string, _name: string | null, _m: number | null, o: { observed?: boolean } = {}) {
    this.calls.push(o.observed ? `observed-heartbeat:${id}` : `heartbeat:${id}`);
    return this.beatReply;
  }
  async release(id: string) {
    this.calls.push(`release:${id}`);
    return ok('released');
  }
}

function rig(o: { settings?: Partial<ExclusiveSettings>; withHost?: boolean } = {}) {
  const remote = new FakeRemote();
  const lan = new FakeHost();
  const pending = new Set<string>();
  const state = {
    operator: null as GuardUser | null,
    settings: { ...EXCLUSIVE_OFF, enabled: true, ...(o.settings ?? {}) } as ExclusiveSettings,
    safe: true,
    signedOut: 0,
    hostThere: o.withHost ?? true,
  };
  const guard = new UserSessionGuard({
    remote,
    operator: () => state.operator,
    signOut: () => {
      state.signedOut += 1;
      const u = state.operator;
      state.operator = null;
      if (u) guard.left(u);
    },
    settings: () => state.settings,
    paired: () => true,
    pending: { all: () => [...pending], add: (id) => void pending.add(id), remove: (id) => void pending.delete(id) },
    canSignOutNow: () => state.safe,
    host: () => (state.hostThere ? lan : null),
    now: () => Date.parse('2026-10-14T09:30:00Z'),
  });
  return { remote, lan, pending, state, guard };
}

const dana = (permissions: Record<string, string> | null = null): GuardUser => ({ id: DANA, name: 'דנה', role: 'cashier', permissions });

describe('the guard', () => {
  it('with the rule off a sign-in asks nobody; on, it claims, and elsewhere is a refusal', async () => {
    const off = rig({ settings: { enabled: false } });
    expect(await off.guard.claimForSignIn(dana())).toEqual({ kind: 'proceed' });
    expect(off.remote.calls).toEqual([]);
    const r = rig({ withHost: false });
    expect(await r.guard.claimForSignIn(dana())).toEqual({ kind: 'proceed' });
    expect(r.remote.calls).toEqual([`claim:${DANA}`]);
    r.remote.claimReply = elsewhere();
    expect(await r.guard.claimForSignIn(dana())).toEqual({ kind: 'blocked', holder, viaHost: false });
  });

  it("the demo till's staff are never checked; an exempt employee is never claimed, beaten for or released", async () => {
    const r = rig({ settings: { offline: 'lan' } });
    expect(await r.guard.claimForSignIn({ ...dana(), id: 'demo-cashier' })).toEqual({ kind: 'proceed' });
    const boss = dana({ MULTI_DEVICE_LOGIN: 'allow' });
    expect(await r.guard.claimForSignIn(boss)).toEqual({ kind: 'proceed' });
    r.state.operator = boss;
    await r.guard.tick();
    expect(r.remote.calls).toEqual([]);
    expect(r.lan.calls).toEqual([]);
  });

  it('the cloud answering exempt lets them in and records nothing: with the rule off later, their owed release is dropped', async () => {
    const r = rig({ withHost: false });
    r.remote.claimReply = ok('exempt');
    expect(await r.guard.claimForSignIn(dana())).toEqual({ kind: 'proceed' });
    r.state.settings = { ...r.state.settings, enabled: false };
    r.pending.add(DANA);
    await r.guard.tick();
    expect([...r.pending]).toEqual([]);
    expect(r.remote.calls).toEqual([`claim:${DANA}`]);
  });

  it("a forced claim carries the manager's own id", async () => {
    const r = rig();
    await r.guard.forceClaim(dana(), RUTI);
    expect(r.remote.lastForce).toEqual([true, RUTI]);
  });

  it('offline allow - the host is never asked; lan - the host decides; manager - no answer at all asks a code', async () => {
    const allow = rig({ settings: { offline: 'allow' } });
    allow.remote.claimReply = offline;
    expect(await allow.guard.claimForSignIn(dana())).toEqual({ kind: 'proceed_unchecked' });
    expect(allow.lan.calls).toEqual([]);
    const lan = rig({ settings: { offline: 'lan', autoReleaseMinutes: 30 } });
    lan.remote.claimReply = offline;
    lan.lan.claimReply = elsewhere();
    expect(await lan.guard.claimForSignIn(dana())).toEqual({ kind: 'blocked', holder, viaHost: true });
    expect(lan.lan.calls).toEqual([`claim:${DANA}:דנה:30`]);
    lan.state.hostThere = false;
    expect(await lan.guard.claimForSignIn(dana())).toEqual({ kind: 'proceed_unchecked' });
    const mgr = rig({ settings: { offline: 'manager' }, withHost: false });
    mgr.remote.claimReply = offline;
    expect(await mgr.guard.claimForSignIn(dana())).toEqual({ kind: 'manager_code' });
  });

  it('a heartbeat that finds them elsewhere warns, and the next good one clears it', async () => {
    const r = rig({ withHost: false });
    r.state.operator = dana();
    r.remote.beatReply = elsewhere();
    await r.guard.tick();
    expect(r.guard.notice).toEqual({ kind: 'also_elsewhere', userName: 'דנה', holder });
    expect(r.state.signedOut).toBe(0);
    r.remote.beatReply = ok('held');
    await r.guard.tick();
    expect(r.guard.notice).toBeNull();
  });

  it('duplicate signout - the later device signs out, but only when the action ends', async () => {
    const r = rig({ settings: { duplicate: 'signout' }, withHost: false });
    r.state.operator = dana();
    r.remote.beatReply = elsewhere();
    r.state.safe = false;
    await r.guard.tick();
    expect(r.state.signedOut).toBe(0);
    expect(r.guard.notice).toEqual({ kind: 'signing_out', userName: 'דנה', now: holder, duplicate: true });
    // Still mid-payment: still waiting, nothing asked of the cloud meanwhile.
    r.remote.calls = [];
    await r.guard.tick();
    expect(r.state.signedOut).toBe(0);
    expect(r.remote.calls).toEqual([]);
    r.state.safe = true;
    await r.guard.tick();
    expect(r.state.signedOut).toBe(1);
    expect(r.guard.notice).toEqual({ kind: 'signed_out', userName: 'דנה', now: holder, duplicate: true });
    expect(noticeText(r.guard.notice!, Date.now())).toBe('דנה נותק/ה מקופה זו: מחובר/ת גם בקופה 3 (בר).');
  });

  it("a manager's release signs out, but not over a payment", async () => {
    const r = rig({ withHost: false });
    r.state.operator = dana();
    r.remote.beatReply = { kind: 'released', byName: 'רותי', fromDashboard: false, now: holder, releasedBy: null };
    r.state.safe = false;
    await r.guard.tick();
    expect(r.state.signedOut).toBe(0);
    expect(r.guard.notice).toEqual({ kind: 'signing_out', userName: 'דנה', now: holder, duplicate: false });
    r.state.safe = true;
    await r.guard.tick();
    expect(r.state.signedOut).toBe(1);
    expect(r.guard.notice).toEqual({ kind: 'signed_out', userName: 'דנה', now: holder, duplicate: false });
  });

  it('every heartbeat says when this till signed the employee in', async () => {
    const r = rig({ withHost: false });
    r.guard.signedIn(dana());
    r.state.operator = dana();
    await r.guard.tick();
    expect(r.remote.lastSignedInAt).toBe('2026-10-14T09:30:00.000Z');
  });

  it('whoever stops being the operator is released; a release without an answer is owed until one comes', async () => {
    const r = rig({ withHost: false });
    r.remote.releaseReply = offline;
    r.guard.left(dana());
    await r.guard.tick();
    expect([...r.pending]).toEqual([DANA]);
    r.remote.releaseReply = ok('released');
    await r.guard.tick();
    expect([...r.pending]).toEqual([]);
    expect(r.remote.calls.filter((c) => c.startsWith('release'))).toEqual([`release:${DANA}`, `release:${DANA}`]);
  });

  it('offline lan - the heartbeat goes to the host when the cloud is away; while the cloud answers the host is told', async () => {
    const r = rig({ settings: { offline: 'lan', duplicate: 'signout' } });
    r.state.operator = dana();
    r.remote.beatReply = offline;
    await r.guard.tick();
    expect(r.lan.calls).toEqual([`heartbeat:${DANA}`]);
    r.lan.calls = [];
    r.remote.beatReply = ok('held');
    await r.guard.tick();
    expect(r.lan.calls).toEqual([`observed-heartbeat:${DANA}`]);
  });

  it('"נעילה בחוסר שימוש": the parameter\'s seconds, kept within 10 s – 1 h, off when 0 or blank', () => {
    expect(idleLockSecondsOf(undefined)).toBeNull();
    expect(idleLockSecondsOf('0')).toBeNull();
    expect(idleLockSecondsOf('')).toBeNull();
    expect(idleLockSecondsOf('5')).toBe(10);
    expect(idleLockSecondsOf('90')).toBe(90);
    expect(idleLockSecondsOf('99999')).toBe(3600);
  });
});

/* -------------------------------------------------------------- the engine */

const open: Harness[] = [];
afterEach(() => {
  for (const h of open.splice(0)) h.stop();
});

const CASHIER = '11111111-2222-4333-8444-0000000000c1';
const MANAGER = '11111111-2222-4333-8444-0000000000a1';
const C_PIN = '1234';
const M_PIN = '9876';

function uuidRoster() {
  return [
    { id: CASHIER, username: 'dana', firstName: 'דנה', lastName: 'כהן', pinHash: bcrypt.hashSync(C_PIN, 4), role: 'cashier', isActive: true, shopId: null, permissions: { SELL: 'allow', USER_SESSION_RELEASE: 'deny', MULTI_DEVICE_LOGIN: 'deny' } },
    { id: MANAGER, username: 'avi', firstName: 'אבי', lastName: 'לוי', pinHash: bcrypt.hashSync(M_PIN, 4), role: 'shop_manager', isActive: true, shopId: null, permissions: { SELL: 'allow', USER_SESSION_RELEASE: 'allow', MULTI_DEVICE_LOGIN: 'deny' } },
  ];
}

function till(o: HarnessOptions = {}) {
  const h = harness({ users: uuidRoster(), ...o, parameters: { exclusiveUserLogin: 'true', ...(o.parameters ?? {}) } });
  open.push(h);
  return h;
}

const elsewhereBody = () => ({ __status: 409, detail: { code: 'user_signed_in_elsewhere', posUserName: 'דנה כהן', machineId: 'm1', machineName: 'בר', posNumber: '3', since: '2026-10-05T11:05:00+00:00' } });

describe('the till: the sign-in', () => {
  it('signed in elsewhere: not in — the dialog says where; a manager\'s code releases it there (the cloud hears the manager), and she is in', async () => {
    let forced: { body: unknown } | null = null;
    const h = till({
      answers: {
        'POST sync/m/user-session/claim': (body) => {
          if (body?.force === true) {
            forced = { body };
            return { status: 'claimed' };
          }
          return elsewhereBody();
        },
      },
    });
    const r = await h.ok<{ dialogId: string; blocked: true }>('session.login', { pin: C_PIN });
    expect(r.blocked).toBe(true);
    expect(h.state().session.cashier).toBeNull();
    const d = h.state().dialog!;
    expect(d.title).toBe('מחובר/ת בקופה אחרת');
    expect(d.body).toContain('דנה כהן מחובר/ת כרגע בקופה 3 (בר) מאז');
    expect(d.actions[0].label).toBe('שחרור באישור מנהל');
    // The cashier's own code is no manager's.
    expect((await h.fail('dialog.answer', { dialogId: d.id, action: 'approve', answers: { pin: C_PIN } })).code).toBe('wrong_pin');
    await h.ok('dialog.answer', { dialogId: d.id, action: 'approve', answers: { pin: M_PIN } });
    expect(forced).not.toBeNull();
    const claim = h.sent.filter((s) => s.path === 'sync/m/user-session/claim');
    expect(claim.map((s) => (s.body as { force?: boolean }).force)).toEqual([false, true]);
    expect(h.state().session.cashier?.id).toBe(CASHIER);
  });

  it('a manager signing in releases on their own authority — no second code', async () => {
    const h = till({ answers: { 'POST sync/m/user-session/claim': (body) => (body?.force === true ? { status: 'claimed' } : elsewhereBody()) } });
    await h.ok('session.login', { pin: M_PIN });
    const d = h.state().dialog!;
    expect(d.fields).toEqual([]);
    await h.ok('dialog.answer', { dialogId: d.id, action: 'release' });
    expect(h.state().session.cashier?.id).toBe(MANAGER);
  });

  it('no answer from the cloud: in by default; under "manager" a manager\'s code lets her in', async () => {
    // No answer at all (the network down: the request throws).
    const down = {
      'POST sync/m/user-session/claim': () => {
        throw new TypeError('fetch failed');
      },
    };
    const allow = till({ answers: down });
    await allow.ok('session.login', { pin: C_PIN });
    expect(allow.state().session.cashier?.id).toBe(CASHIER);
    const mgr = till({ answers: down, parameters: { exclusiveUserLogin: 'true', exclusiveUserLoginOffline: 'manager' } });
    await mgr.ok('session.login', { pin: C_PIN });
    expect(mgr.state().session.cashier).toBeNull();
    const d = mgr.state().dialog!;
    expect(d.body).toBe('אין תשובה מהענן. הכניסה של דנה כהן באישור מנהל.');
    await mgr.ok('dialog.answer', { dialogId: d.id, action: 'approve', answers: { pin: M_PIN } });
    expect(mgr.state().session.cashier?.id).toBe(CASHIER);
  });

  it('the rule off: nobody is asked', async () => {
    const h = harness({ users: uuidRoster() });
    open.push(h);
    await h.ok('session.login', { pin: C_PIN });
    expect(h.sent.filter((s) => s.path.includes('user-session'))).toEqual([]);
  });

  it('a sign-out is the release; a manager\'s release from elsewhere signs her out when the till is not mid-payment', async () => {
    const h = till({
      answers: {
        'POST sync/m/user-session/claim': () => ({ status: 'claimed' }),
        'POST sync/m/user-session/heartbeat': () => ({ __status: 409, detail: { code: 'user_session_released', releasedBy: 'manager', releasedByName: 'רותי', fromDashboard: true, now: null } }),
        'POST sync/m/user-session/release': () => ({ status: 'not_held' }),
      },
    });
    await h.ok('session.login', { pin: C_PIN });
    await h.engine.sessions.guard.tick();
    await new Promise((r) => setTimeout(r, 30));
    expect(h.state().session.cashier).toBeNull();
    expect(h.state().users?.notice).toBe('דנה כהן נותק/ה מקופה זו: החיבור שוחרר באישור מנהל.');
    await h.engine.sessions.guard.tick();
    expect(h.sent.some((s) => s.path === 'sync/m/user-session/release' && (s.body as { posUserId?: string }).posUserId === CASHIER)).toBe(true);
  });
});

describe('the till: "עובדים מחוברים" and the idle lock', () => {
  it('a manager sees the shop\'s sessions and releases one as themselves (X-Pos-User-Id)', async () => {
    const h = till({
      answers: {
        'POST sync/m/user-session/claim': () => ({ status: 'claimed' }),
        'GET sync/m/user-sessions': () => ({ releaseTables: 'keep', sessions: [{ id: 's-1', posUserId: CASHIER, posUserName: 'דנה כהן', machineName: 'בר', posNumber: '3', startedAt: '2026-10-05T11:05:00+00:00', openTables: 0 }] }),
        'POST sync/m/user-sessions/s-1/release': () => ({ status: 'released', warnings: [] }),
      },
    });
    await h.ok('session.login', { pin: M_PIN });
    await h.ok('users.open');
    expect(h.state().users?.list?.sessions.map((s) => s.posUserName)).toEqual(['דנה כהן']);
    await h.ok('users.release', { sessionId: 's-1' });
    const d = h.state().dialog!;
    expect(d.body).toBe('לשחרר את דנה כהן מקופה 3 (בר)?');
    await h.ok('dialog.answer', { dialogId: d.id, action: 'release' });
    expect(h.state().users?.list?.sessions).toEqual([]);
    expect(h.events.some((e) => e.ev === 'toast' && (e.data as { text: string }).text === 'דנה כהן שוחרר/ה. המכשיר ההוא ינתק בסיום הפעולה.')).toBe(true);
  });

  it('a cashier opens it only on a manager\'s code', async () => {
    const h = till({ answers: { 'POST sync/m/user-session/claim': () => ({ status: 'claimed' }), 'GET sync/m/user-sessions': () => ({ sessions: [] }) } });
    await h.ok('session.login', { pin: C_PIN });
    await h.ok('users.open');
    const d = h.state().dialog!;
    expect(d.body).toBe('כניסה ל"עובדים מחוברים" באישור מנהל');
    await h.ok('dialog.answer', { dialogId: d.id, action: 'approve', answers: { pin: M_PIN } });
    expect(h.state().users?.list?.sessions).toEqual([]);
  });

  it('"נעילה בחוסר שימוש": no touch for the seconds signs the operator out — never over a payment', async () => {
    let now = Date.parse('2026-10-16T10:00:00Z');
    const h = harness({ users: uuidRoster(), parameters: { idleLockSeconds: '30' }, now: () => now });
    open.push(h);
    await h.ok('session.login', { pin: C_PIN });
    await h.ok('shift.open', { openingCashAgorot: 0 });
    now += 20_000;
    h.engine.sessions.idleCheck();
    await new Promise((r) => setTimeout(r, 10));
    expect(h.state().session.cashier).not.toBeNull();
    // A payment open: held.
    await h.ok('sell.add', { productId: 'p-cola' });
    await h.ok('checkout.start');
    now += 60_000;
    h.engine.sessions.idleCheck();
    await new Promise((r) => setTimeout(r, 10));
    expect(h.state().session.cashier).not.toBeNull();
    await h.ok('checkout.cancel');
    now += 60_000;
    h.engine.sessions.idleCheck();
    await new Promise((r) => setTimeout(r, 10));
    expect(h.state().session.cashier).toBeNull();
  });
});
