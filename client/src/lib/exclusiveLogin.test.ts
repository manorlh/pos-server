/**
 * Run with `npm test`. The web till's "עובד מחובר בקופה אחת בלבד" (lib/exclusiveLogin.ts — v2:
 * P:/specs/exclusive-login-v2.md §7 "קופת web: claim, heartbeat וחסימה"): the answers as the
 * cloud sends them (tests/test_user_sessions.py on the server), the sign-in's decisions (the
 * dialog with both buttons, `offline`), the heartbeat's (`duplicate`), the Hebrew, and the guard
 * against a pretend cloud (headers, `signedInAt`, releases kept until answered).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ApiReply } from './kioskWebApi';
import {
  DEFAULT_POLICY,
  TEXTS,
  UserSessionGuard,
  blockedText,
  heartbeatDecision,
  holderOf,
  policyOf,
  readAnswer,
  shouldClaim,
  signInDecision,
  signedOutText,
  signingOutText,
  silentText,
  sinceText,
  tillName,
  warnText,
  type HeartbeatDecision,
  type PendingStore,
  type SessionTransport,
} from './exclusiveLogin';

const POLICY = { exclusive: true, staleMinutes: 15, autoRelease: 'off', offline: 'allow', duplicate: 'warn' };
const NOW = new Date(2026, 9, 14, 16, 30);
const TODAY_1405 = new Date(2026, 9, 14, 14, 5).toISOString();
const TODAY_1420 = new Date(2026, 9, 14, 14, 20).toISOString();

const ok = (body: unknown): ApiReply => ({ kind: 'ok', status: 200, body, date: null, etag: null });
const refused = (status: number, body: unknown, detail: string | null = null): ApiReply => ({ kind: 'refused', status, body, detail });
const offline: ApiReply = { kind: 'offline', reason: 'TypeError: Failed to fetch' };

const elsewhere = (extra: Record<string, unknown> = {}): ApiReply => {
  const detail = {
    code: 'user_signed_in_elsewhere', sessionId: 's-1', posUserId: 'dana', posUserName: 'דנה', machineId: 'm-3',
    machineName: 'בר', posNumber: '3', since: TODAY_1405, lastSeenAt: TODAY_1420, holderSilentSince: null,
    ...POLICY, ...extra,
  };
  return refused(409, { detail }, 'user_signed_in_elsewhere');
};

describe('reading the answers', () => {
  it('a 200 with its status and the policy', () => {
    const a = readAnswer(ok({ status: 'exempt', ...POLICY, offline: 'lan', sessionId: null, since: null, tookOver: null }));
    assert.equal(a.kind, 'ok');
    if (a.kind !== 'ok') return;
    assert.equal(a.status, 'exempt');
    assert.deepEqual(a.policy, { ...POLICY, offline: 'lan' });
  });

  it('an older cloud with no v2 fields reads as the defaults', () => {
    assert.deepEqual(policyOf({ exclusive: true, staleMinutes: 20 }), { ...DEFAULT_POLICY, exclusive: true, staleMinutes: 20 });
    assert.deepEqual(policyOf({ autoRelease: 'sometimes', offline: 7 }), DEFAULT_POLICY);
  });

  it('409 elsewhere: where, since when, since when it is silent, and the policy', () => {
    const a = readAnswer(elsewhere({ holderSilentSince: TODAY_1420, duplicate: 'signout' }));
    assert.equal(a.kind, 'elsewhere');
    if (a.kind !== 'elsewhere') return;
    assert.equal(a.holder.posNumber, '3');
    assert.equal(a.holder.holderSilentSince, TODAY_1420);
    assert.equal(a.policy.duplicate, 'signout');
  });

  it('409 released: by whom, and where the employee is now', () => {
    const a = readAnswer(refused(409, { detail: {
      code: 'user_session_released', releasedBy: 'manager', releasedByName: 'רותי', releasedAt: TODAY_1420,
      fromDashboard: false, now: { posNumber: '2', machineName: 'קופה 2' }, ...POLICY,
    } }, 'user_session_released'));
    assert.equal(a.kind, 'released');
    if (a.kind !== 'released') return;
    assert.equal(a.released.releasedByName, 'רותי');
    assert.equal(a.released.now?.posNumber, '2');
  });

  it('no answer, a gateway or a 5xx are unreachable; 401 / 403 / 404 are their own', () => {
    assert.equal(readAnswer(offline).kind, 'unreachable');
    assert.equal(readAnswer(refused(500, null)).kind, 'unreachable');
    assert.deepEqual(readAnswer(refused(401, { detail: 'elevation_already_used' }, 'elevation_already_used')), { kind: 'needsManager', code: 'elevation_already_used' });
    assert.deepEqual(readAnswer(refused(403, { detail: 'elevation_wrong_user' }, 'elevation_wrong_user')), { kind: 'forbidden', code: 'elevation_wrong_user' });
    assert.deepEqual(readAnswer(refused(404, { detail: 'pos_user_not_found' }, 'pos_user_not_found')), { kind: 'refused', status: 404, code: 'pos_user_not_found' });
  });
});

describe('the sign-in', () => {
  const ctx = { policy: null, remoteApproval: true };

  it('asks the cloud only when the rule is on and the employee is the cloud\'s', () => {
    assert.equal(shouldClaim(true, 'dana'), true);
    assert.equal(shouldClaim('true', 'dana'), true);
    assert.equal(shouldClaim(false, 'dana'), false);
    assert.equal(shouldClaim(true, null), false);
  });

  it('every 200 lets the employee in — claimed, held, off, exempt', () => {
    for (const status of ['claimed', 'held', 'off', 'exempt']) {
      assert.deepEqual(signInDecision(readAnswer(ok({ status, ...POLICY })), ctx), { action: 'enter' });
    }
  });

  it('blocked: the dialog with both buttons, the phone only when it is on', () => {
    const d = signInDecision(readAnswer(elsewhere()), ctx);
    assert.equal(d.action, 'block');
    if (d.action !== 'block') return;
    assert.equal(d.offerCode, true);
    assert.equal(d.offerRemote, true);
    const off = signInDecision(readAnswer(elsewhere()), { ...ctx, remoteApproval: false });
    assert.equal(off.action === 'block' && off.offerRemote, false);
  });

  it('no answer: in (allow, lan with no host) — or a manager\'s code (manager)', () => {
    assert.deepEqual(signInDecision({ kind: 'unreachable' }, ctx), { action: 'enter' });
    assert.deepEqual(signInDecision({ kind: 'unreachable' }, { ...ctx, policy: { ...DEFAULT_POLICY, offline: 'lan' } }), { action: 'enter' });
    assert.deepEqual(signInDecision({ kind: 'unreachable' }, { ...ctx, policy: { ...DEFAULT_POLICY, offline: 'manager' } }), { action: 'managerCode' });
  });

  it('after a forced claim: 401 asks for the code again, 403 says it does not release here', () => {
    assert.deepEqual(signInDecision({ kind: 'needsManager', code: 'elevation_expired' }, ctx), { action: 'retryCode', code: 'elevation_expired' });
    assert.deepEqual(signInDecision({ kind: 'forbidden', code: 'elevation_wrong_machine' }, ctx), { action: 'notPermitted', code: 'elevation_wrong_machine' });
  });

  it('a refusal it does not know lets the employee in, as the APK', () => {
    assert.deepEqual(signInDecision(readAnswer(refused(404, null, 'pos_user_not_found')), ctx), { action: 'enter' });
  });
});

describe('the heartbeat', () => {
  it('held / claimed: nothing; warn: the banner; signout: out at the end of the operation', () => {
    assert.deepEqual(heartbeatDecision(readAnswer(ok({ status: 'held', ...POLICY }))), { action: 'none' });
    assert.equal(heartbeatDecision(readAnswer(elsewhere())).action, 'warn');
    const d = heartbeatDecision(readAnswer(elsewhere({ duplicate: 'signout' })));
    assert.equal(d.action, 'signOutWhenIdle');
    assert.equal(d.action === 'signOutWhenIdle' && d.reason, 'duplicate');
  });

  it('a manager\'s release or a duplicate\'s: out at the end of the operation', () => {
    const released = (by: string) => readAnswer(refused(409, { detail: { code: 'user_session_released', releasedBy: by, ...POLICY } }, 'user_session_released'));
    const m = heartbeatDecision(released('manager'));
    assert.equal(m.action === 'signOutWhenIdle' && m.reason, 'released');
    const dup = heartbeatDecision(released('duplicate'));
    assert.equal(dup.action === 'signOutWhenIdle' && dup.reason, 'duplicate');
  });

  it('no answer changes nothing', () => {
    assert.deepEqual(heartbeatDecision({ kind: 'unreachable' }), { action: 'none' });
  });
});

describe('the Hebrew', () => {
  const holder = holderOf({ posUserName: 'דנה', posNumber: '3', machineName: 'בר', since: TODAY_1405, holderSilentSince: TODAY_1420 });

  it('the till as the APK names it', () => {
    assert.equal(tillName({ posNumber: '3', machineName: 'בר' }), 'קופה 3 (בר)');
    assert.equal(tillName({ posNumber: '3', machineName: 'קופה 3' }), 'קופה 3');
    assert.equal(tillName({ posNumber: null, machineName: 'בר' }), 'קופה „בר”');
    assert.equal(tillName(null), 'קופה אחרת');
  });

  it('since: the time today, the date another day', () => {
    assert.equal(sinceText(TODAY_1405, NOW), '14:05');
    assert.equal(sinceText(new Date(2026, 9, 13, 9, 7).toISOString(), NOW), '13.10 09:07');
    assert.equal(sinceText(null, NOW), null);
  });

  it('the dialog, the silent device, the banner', () => {
    assert.equal(blockedText(holder, 'x', NOW), 'דנה מחובר/ת כרגע בקופה 3 (בר) מאז 14:05. יש להתנתק שם קודם.');
    assert.equal(silentText(holder, NOW), 'המכשיר הקודם לא מדווח מאז 14:20.');
    assert.equal(silentText(holderOf({ since: TODAY_1405 }), NOW), null);
    assert.equal(warnText(holder, 'x', NOW), 'דנה מחובר/ת גם בקופה 3 (בר) (מאז 14:05). יש להתנתק שם.');
    assert.equal(TEXTS.releaseWithCode, 'שחרור באישור מנהל');
    assert.equal(TEXTS.requestFromPhone, 'בקשת שחרור ממנהל');
  });

  it('signing out, and afterwards', () => {
    const released: HeartbeatDecision = { action: 'signOutWhenIdle', reason: 'released', released: null, holder: holderOf({ posNumber: '2' }) };
    const dup: HeartbeatDecision = { action: 'signOutWhenIdle', reason: 'duplicate', released: null, holder };
    assert.equal(signingOutText(released, 'דנה'), 'החיבור של דנה שוחרר באישור מנהל. הקופה תתנתק בסיום הפעולה.');
    assert.equal(signedOutText(released, 'דנה'), 'דנה נותק/ה מקופה זו: החיבור שוחרר באישור מנהל, ועכשיו מחובר/ת בקופה 2.');
    assert.equal(signingOutText(dup, 'דנה'), 'דנה מחובר/ת גם בקופה 3 (בר). הקופה תנתק את דנה בסיום הפעולה.');
    assert.equal(signedOutText(dup, 'דנה'), 'דנה נותק/ה מקופה זו: מחובר/ת גם בקופה 3 (בר).');
  });
});

type Sent = { path: string; body: unknown; headers: Record<string, string> };

function cloud(answer: (s: Sent) => ApiReply): { api: SessionTransport; sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    sent,
    api: {
      async post(path, body, opts) {
        const s = { path, body, headers: opts?.headers ?? {} };
        sent.push(s);
        return answer(s);
      },
    },
  };
}

function memory(): PendingStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, get: (k) => data.get(k) ?? null, set: (k, v) => void data.set(k, v) };
}

describe('the guard', () => {
  it('claims with the machine\'s path and remembers the policy', async () => {
    const { api, sent } = cloud(() => ok({ status: 'claimed', ...POLICY, offline: 'manager' }));
    const g = new UserSessionGuard('m-1', api);
    const a = await g.claim('dana');
    assert.equal(a.kind, 'ok');
    assert.deepEqual(sent[0], { path: 'sync/m-1/user-session/claim', body: { posUserId: 'dana' }, headers: {} });
    assert.equal(g.lastPolicy?.offline, 'manager');
  });

  it('a forced claim carries the approval: a code or a phone\'s grant, or the operator', async () => {
    const { api, sent } = cloud(() => ok({ status: 'claimed', ...POLICY }));
    const g = new UserSessionGuard('m-1', api);
    await g.claim('dana', { elevationToken: 'apg_x' });
    await g.claim('boss', { operatorId: 'boss' });
    assert.deepEqual(sent[0].body, { posUserId: 'dana', force: true });
    assert.deepEqual(sent[0].headers, { 'X-Elevation-Token': 'apg_x' });
    assert.deepEqual(sent[1].headers, { 'X-Pos-User-Id': 'boss' });
  });

  it('the heartbeat says when this till let the employee in', async () => {
    const { api, sent } = cloud(() => ok({ status: 'held', ...POLICY }));
    await new UserSessionGuard('m-1', api).heartbeat('dana', '2026-10-14T11:05:00.000Z');
    assert.deepEqual(sent[0], {
      path: 'sync/m-1/user-session/heartbeat', body: { posUserId: 'dana', signedInAt: '2026-10-14T11:05:00.000Z' }, headers: {},
    });
  });

  it('a release with no network waits, and goes when the cloud answers', async () => {
    let up = false;
    const { api, sent } = cloud(() => (up ? ok({ status: 'released' }) : offline));
    const store = memory();
    const g = new UserSessionGuard('m-1', api, store);
    await g.release('dana');
    assert.deepEqual(JSON.parse(store.data.get('r2m.userSession.pendingReleases') ?? '[]'), ['dana']);
    // Even after a reload: a new guard over the same store.
    up = true;
    await new UserSessionGuard('m-1', api, store).flush();
    assert.deepEqual(JSON.parse(store.data.get('r2m.userSession.pendingReleases') ?? '[]'), []);
    assert.equal(sent.filter((s) => s.path.endsWith('/release')).length, 2);
  });

  it('whoever stops being the operator is released', async () => {
    const { api, sent } = cloud(() => ok({ status: 'released' }));
    const g = new UserSessionGuard('m-1', api, memory());
    await g.operatorChanged('dana', 'yossi');
    await g.operatorChanged('yossi', 'yossi');
    await g.operatorChanged(null, 'dana');
    assert.deepEqual(sent.map((s) => s.body), [{ posUserId: 'dana' }]);
  });
});
