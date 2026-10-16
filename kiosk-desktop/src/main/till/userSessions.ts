/**
 * "עובד מחובר בקופה אחת בלבד" on the Windows till (pos-android data/repo/UserSessionGuard.kt, ui/auth/LoginScreen.kt,
 * ui/auth/SignedInUsersUi.kt; P:/specs/exclusive-login-v2.md): the claim at sign-in, the heartbeat while signed in, the release
 * on the way out — and "עובדים מחוברים" (§8), and "נעילה בחוסר שימוש" (`idleLockSeconds`, ui/common/ScreenSaver.kt).
 *
 *  - The way out is followed, not remembered by each caller: the engine says who signed in and who left (`signedIn`, `left`)
 *    on every path — sign-out, the idle lock, the work mode's return, a manager's release — and whoever left is released.
 *  - A release is owed until the cloud hears it: kept on disk and sent again every beat, so a sign-out without a connection
 *    still frees the employee once the till is back.
 *  - The heartbeat claims: a sign-in the cloud could not check (offline) is claimed by the next beat that gets through; found
 *    elsewhere by then, the till says so in a banner — or, where the shop chose `signout`, signs them out when the action ends.
 *    A session a manager released ends the sign-in here too — never over a payment.
 *  - An employee who holds MULTI_DEVICE_LOGIN is never claimed. Without the cloud: `allow` lets them in, `manager` asks a
 *    manager's code (the roster's); `lan` asks the shop's LAN host — none reachable from a Windows till yet, so as `allow`
 *    (the spec: "בלי מארח: כמו allow").
 *
 * A manager's code here is checked against the roster, and the cloud hears the approver as `X-Pos-User-Id` (their own role
 * must hold `user-session:release` there too).
 */

import { approveBy } from '../../core/till/approval';
import { displayName, type RosterUser } from '../../core/till/staff';
import { NO_LOCK, type ExitLock } from '../../core/desktopExit';
import {
  EXCLUSIVE_OFF,
  EXCLUSIVE_TEXT,
  HEARTBEAT_MS,
  KICK_RETRY_MS,
  cloudIdOf,
  exclusiveSettingsOf,
  exempt,
  heartbeatBeat,
  isRecorded,
  mayRelease,
  releaseDone,
  sessionReplyOf,
  signInDecision,
  signInUnder,
  sinceLabel,
  tillLabel,
  type ExclusiveSettings,
  type SessionHolder,
  type SessionReply,
  type SignInDecision,
} from '../../core/till/exclusiveLogin';
import type { Api } from '../sync/api';
import type { Kv } from '../db/schema';
import type { SignedInSession, UsersState } from '../../shared/till/protocol';
import type { TillContext } from './tillContext';

/* ------------------------------------------------------------- the remotes */

/** The cloud's side, as the guard talks to it (`POST /sync/{m}/user-session/claim | heartbeat | release`). */
export interface UserSessionRemote {
  claim(posUserId: string, force?: boolean, operatorId?: string | null): Promise<SessionReply>;
  heartbeat(posUserId: string, signedInAt?: string | null): Promise<SessionReply>;
  release(posUserId: string): Promise<SessionReply>;
  /** "עובדים מחוברים" (§8): the shop's sessions as the cloud answered (status and body), or null — no answer. */
  list(): Promise<{ status: number; body: unknown } | null>;
  /** A manager releases one session from here (§8א), on the approver's own authority (`X-Pos-User-Id`). */
  releaseSession(sessionId: string, operatorId: string): Promise<{ status: number; body: unknown } | null>;
}

/** The shop's LAN host's side (v2 §4, `lan` | `manager`): the same claim, heartbeat and release. */
export interface UserSessionHostRemote {
  claim(posUserId: string, posUserName: string | null, autoReleaseMinutes: number | null, o?: { observed?: boolean; approverId?: string | null; approverName?: string | null }): Promise<SessionReply>;
  heartbeat(posUserId: string, posUserName: string | null, autoReleaseMinutes: number | null, o?: { observed?: boolean; signedInAt?: string | null; duplicateSignout?: boolean }): Promise<SessionReply>;
  release(posUserId: string): Promise<SessionReply>;
}

/**
 * The cloud over the till's API. Short timeouts on purpose (UserSessionApi): a claim stands between a correct PIN and the till,
 * and the answer to "no answer" is to let the employee in — so waiting long for one buys nothing.
 */
export class CloudUserSessions implements UserSessionRemote {
  constructor(private readonly d: { api: Api; machineId(): string | null }) {}

  private async call(action: string, body: Record<string, unknown>, headers: Record<string, string> = {}): Promise<SessionReply> {
    const m = this.d.machineId();
    if (!m) return { kind: 'offline', reason: 'not paired' };
    const r = await this.d.api.post(`sync/${m}/user-session/${action}`, body, { timeoutMs: 6_000, headers });
    if (r.kind === 'offline') return { kind: 'offline', reason: r.reason };
    return sessionReplyOf(r.status, r.body);
  }

  claim(posUserId: string, force = false, operatorId: string | null = null) {
    return this.call('claim', { posUserId, force }, operatorId ? { 'X-Pos-User-Id': operatorId } : {});
  }

  heartbeat(posUserId: string, signedInAt: string | null = null) {
    return this.call('heartbeat', { posUserId, ...(signedInAt ? { signedInAt } : {}) });
  }

  release(posUserId: string) {
    return this.call('release', { posUserId });
  }

  async list() {
    const m = this.d.machineId();
    if (!m) return null;
    const r = await this.d.api.get(`sync/${m}/user-sessions`, { timeoutMs: 8_000 });
    if (r.kind === 'offline') return null;
    return { status: r.status, body: r.body };
  }

  async releaseSession(sessionId: string, operatorId: string) {
    const m = this.d.machineId();
    if (!m) return null;
    const r = await this.d.api.post(`sync/${m}/user-sessions/${encodeURIComponent(sessionId)}/release`, { transfers: [] }, { timeoutMs: 10_000, headers: { 'X-Pos-User-Id': operatorId } });
    if (r.kind === 'offline') return null;
    return { status: r.status, body: r.body };
  }
}

/** Releases the cloud has not heard yet, by employee id — on the disk (they survive a restart). */
export class KvPendingReleases {
  private static readonly KEY = 'till.userSessionReleases';
  constructor(private readonly kv: Kv) {}
  all(): string[] {
    return this.kv.getJson<string[]>(KvPendingReleases.KEY) ?? [];
  }
  add(id: string) {
    const s = new Set(this.all());
    s.add(id);
    this.kv.setJson(KvPendingReleases.KEY, [...s]);
  }
  remove(id: string) {
    this.kv.setJson(
      KvPendingReleases.KEY,
      this.all().filter((x) => x !== id),
    );
  }
}

/* ---------------------------------------------------------------- the guard */

/** A message about the employee's sign-in that does not stop the till (the banner). */
export type SessionNotice =
  | { kind: 'also_elsewhere'; userName: string; holder: SessionHolder }
  | { kind: 'signing_out'; userName: string; now: SessionHolder | null; duplicate: boolean }
  | { kind: 'signed_out'; userName: string; now: SessionHolder | null; duplicate: boolean }
  | { kind: 'tables_freed'; userName: string; warnings: string[] };

export interface GuardUser {
  id: string;
  name: string;
  role: string;
  permissions?: Record<string, string> | null;
}

export class UserSessionGuard {
  notice: SessionNotice | null = null;
  /** Employees whose session the cloud recorded for this till (claimed or held). */
  private readonly held = new Set<string>();
  private kick: { userId: string; now: SessionHolder | null; duplicate: boolean } | null = null;
  /** Who is signed in here and since when (this till's clock): every heartbeat says it (`signedInAt`). */
  private signedInAt: { userId: string; at: string } | null = null;
  private pendingWarnings: { id: string; warnings: string[] } | null = null;
  /** A manager's release the LAN host made while the cloud did not answer: owed to the cloud as that manager's forced claim. */
  private readonly owedForce = new Map<string, string>();
  private readonly hostOwed = new Set<string>();
  private ticking: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private readonly d: {
      remote: UserSessionRemote;
      operator(): GuardUser | null;
      signOut(): void;
      settings(): ExclusiveSettings;
      paired(): boolean;
      pending: Pick<KvPendingReleases, 'all' | 'add' | 'remove'>;
      /** Nothing in progress that a sign-out would cut short (a payment). */
      canSignOutNow(): boolean;
      host?: () => UserSessionHostRemote | null;
      now?: () => number;
      log?: (m: string) => void;
    },
  ) {}

  private host(): UserSessionHostRemote | null {
    return this.d.host?.() ?? null;
  }

  private cloudId(u: GuardUser): string | null {
    return cloudIdOf(u.id);
  }

  private settings(): ExclusiveSettings | null {
    try {
      return this.d.settings();
    } catch {
      return null;
    }
  }

  start() {
    this.stopped = false;
    this.schedule(0);
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(ms: number) {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.tick().finally(() => this.schedule(this.kick ? KICK_RETRY_MS : HEARTBEAT_MS));
    }, ms);
    this.timer.unref?.();
  }

  /** Something changed (a sign-in, a sign-out): a beat soon. */
  wake() {
    this.schedule(50);
  }

  /** After the right PIN, before the till: may `user` sign in here? */
  async claimForSignIn(user: GuardUser): Promise<SignInDecision> {
    const id = this.cloudId(user);
    if (!id || exempt(user) || !this.d.paired()) return { kind: 'proceed' };
    const s = this.settings() ?? EXCLUSIVE_OFF;
    if (!s.enabled) return { kind: 'proceed' };
    const reply = await this.d.remote.claim(id);
    this.noteHeld(id, reply);
    let hostReply: SessionReply | null = null;
    const host = s.offline !== 'allow' ? this.host() : null;
    if (host) {
      if (reply.kind === 'offline') hostReply = await host.claim(id, user.name, s.autoReleaseMinutes);
      else if (isRecorded(reply)) void host.claim(id, user.name, s.autoReleaseMinutes, { observed: true }).catch(() => undefined);
    }
    return signInUnder(reply, s.offline, hostReply);
  }

  /** "שחרור באישור מנהל": claim with the other till's session released — on `operatorId`'s own authority (a manager). */
  async forceClaim(user: GuardUser, operatorId: string): Promise<SignInDecision> {
    const id = this.cloudId(user);
    if (!id || !this.d.paired()) return { kind: 'proceed' };
    const reply = await this.d.remote.claim(id, true, operatorId);
    this.noteHeld(id, reply);
    if (reply.kind === 'ok' && reply.warnings.length > 0) this.warnAfterSignIn(user, reply.warnings);
    return signInDecision(reply);
  }

  /** Say `warnings` once `user` is in (the sign-in's release freed a silent device's tables, §8ב). */
  warnAfterSignIn(user: GuardUser, warnings: string[]) {
    if (warnings.length === 0) return;
    const id = this.cloudId(user) ?? user.id;
    const before = this.pendingWarnings?.id === id ? this.pendingWarnings.warnings : [];
    this.pendingWarnings = { id, warnings: [...new Set([...before, ...warnings])] };
  }

  /** `user` is the operator now: what was said about the last sign-in no longer applies (unless their own sign-in freed tables). */
  signedIn(user: GuardUser) {
    const id = this.cloudId(user) ?? user.id;
    const warned = this.pendingWarnings?.id === id ? this.pendingWarnings.warnings : null;
    this.pendingWarnings = null;
    this.notice = warned ? { kind: 'tables_freed', userName: user.name, warnings: warned } : null;
    this.kick = null;
    this.signedInAt = { userId: user.id, at: new Date(this.d.now?.() ?? Date.now()).toISOString() };
    this.wake();
  }

  /** `user` stopped being the operator here: owe the cloud (and the LAN host) their release. */
  left(user: GuardUser) {
    const id = this.cloudId(user);
    if (this.signedInAt?.userId === user.id) this.signedInAt = null;
    if (!id) return;
    if (this.kick?.userId === user.id) this.kick = null;
    this.owedForce.delete(id);
    this.d.pending.add(id);
    this.hostOwed.add(id);
    this.wake();
  }

  dismissNotice() {
    this.notice = null;
  }

  /** One pass now: what is owed, then the operator's heartbeat (never two at once). */
  tick(): Promise<void> {
    if (!this.ticking) {
      this.ticking = this.tickOnce().finally(() => {
        this.ticking = null;
      });
    }
    return this.ticking;
  }

  private async tickOnce(): Promise<void> {
    const s = this.settings();
    await this.sendOwedReleases(s);
    const user = this.d.operator();
    if (!user) return;
    if (this.signOutIfAsked(user)) return;
    const id = this.cloudId(user);
    if (!id || !s) return;
    if (!this.d.paired() || !s.enabled || exempt(user)) {
      if (this.notice?.kind === 'also_elsewhere') this.notice = null;
      return;
    }
    const approver = this.owedForce.get(id);
    if (approver) {
      const forced = await this.d.remote.claim(id, true, approver);
      this.noteHeld(id, forced);
      if (forced.kind !== 'offline') this.owedForce.delete(id);
    }
    const since = this.signedInAt?.userId === user.id ? this.signedInAt.at : null;
    let reply = await this.d.remote.heartbeat(id, since);
    this.noteHeld(id, reply);
    const lan = s.offline !== 'allow' ? this.host() : null;
    const cloudAnswered = reply.kind !== 'offline';
    if (lan) {
      const signout = s.duplicate === 'signout';
      if (reply.kind === 'offline') reply = await lan.heartbeat(id, user.name, s.autoReleaseMinutes, { signedInAt: since, duplicateSignout: signout });
      else if (isRecorded(reply)) {
        // The host is told what the cloud says — and a release it made itself still stands.
        const told = await lan.heartbeat(id, user.name, s.autoReleaseMinutes, { observed: true, signedInAt: since, duplicateSignout: signout });
        if (told.kind === 'released') reply = told;
      }
    }
    let beat = heartbeatBeat(reply, s.duplicate);
    if (beat.kind === 'sign_out_duplicate' && cloudAnswered && lan) {
      // The LAN host gave this till the session while the cloud was away: a warning meanwhile, never a sign-out.
      const there = await lan.heartbeat(id, user.name, s.autoReleaseMinutes, { signedInAt: since });
      if (there.kind === 'ok' && there.status === 'held') beat = { kind: 'warn', holder: beat.holder };
    }
    switch (beat.kind) {
      case 'fine':
        if (this.notice?.kind === 'also_elsewhere') this.notice = null;
        break;
      case 'warn':
        this.notice = { kind: 'also_elsewhere', userName: user.name, holder: beat.holder };
        break;
      case 'sign_out':
        // A manager's release — or a duplicate's: the other device signed in first and keeps them.
        this.kick = { userId: user.id, now: beat.released.now, duplicate: beat.released.releasedBy === 'duplicate' };
        this.signOutIfAsked(user);
        break;
      case 'sign_out_duplicate':
        this.kick = { userId: user.id, now: beat.holder, duplicate: true };
        this.signOutIfAsked(user);
        break;
      case 'again':
        break;
    }
  }

  private async sendOwedReleases(s: ExclusiveSettings | null) {
    if (this.hostOwed.size > 0) {
      const lan = s && s.enabled && s.offline !== 'allow' ? this.host() : null;
      if (!lan) this.hostOwed.clear();
      else for (const id of [...this.hostOwed]) if ((await lan.release(id)).kind !== 'offline') this.hostOwed.delete(id);
    }
    const owed = this.d.pending.all();
    // Not paired (any more): nobody to tell — the cloud released them when it unpaired the till.
    if (owed.length === 0 || !this.d.paired()) return;
    const rule = s?.enabled ?? true;
    for (const id of owed) {
      // The rule off and nothing recorded for them: there is nothing to release.
      if (!rule && !this.held.has(id)) {
        this.d.pending.remove(id);
        continue;
      }
      if (releaseDone(await this.d.remote.release(id))) {
        this.d.pending.remove(id);
        this.held.delete(id);
      }
    }
  }

  /** True when a sign-out asked for is pending for `user` (done now, or waiting). */
  private signOutIfAsked(user: GuardUser): boolean {
    const asked = this.kick;
    if (!asked) return false;
    if (asked.userId !== user.id) {
      this.kick = null;
      return false;
    }
    let safe = false;
    try {
      safe = this.d.canSignOutNow();
    } catch {
      safe = false;
    }
    if (safe) {
      this.kick = null;
      this.notice = { kind: 'signed_out', userName: user.name, now: asked.now, duplicate: asked.duplicate };
      this.d.log?.(`user session: ${user.name} signed out here (${asked.duplicate ? 'signed in elsewhere too' : 'released by a manager'})`);
      this.d.signOut();
      // The sign-out's own `left` cleared what was said: the reason stays on the screen.
      this.notice = { kind: 'signed_out', userName: user.name, now: asked.now, duplicate: asked.duplicate };
    } else {
      this.notice = { kind: 'signing_out', userName: user.name, now: asked.now, duplicate: asked.duplicate };
    }
    return true;
  }

  private noteHeld(id: string, reply: SessionReply) {
    if (isRecorded(reply)) this.held.add(id);
  }
}

/** The banner's words for a notice (Android strings exclusive_login_*). */
export function noticeText(n: SessionNotice, nowMs: number): string {
  const where = (h: SessionHolder | null) => (h ? tillLabel(h) : 'קופה אחרת');
  switch (n.kind) {
    case 'also_elsewhere':
      return EXCLUSIVE_TEXT.alsoElsewhere(n.userName, where(n.holder), sinceLabel(n.holder.since, nowMs) ?? '');
    case 'signing_out':
      return n.duplicate ? EXCLUSIVE_TEXT.signingOutDuplicate(n.userName, where(n.now)) : EXCLUSIVE_TEXT.signingOut(n.userName);
    case 'signed_out':
      if (n.duplicate) return EXCLUSIVE_TEXT.signedOutDuplicate(n.userName, where(n.now));
      return n.now ? EXCLUSIVE_TEXT.signedOutNow(n.userName, where(n.now)) : EXCLUSIVE_TEXT.signedOut(n.userName);
    case 'tables_freed':
      return n.warnings.join(' ');
  }
}

/* ------------------------------------------------------- "עובדים מחוברים" */

export function parseSessions(body: unknown): SignedInSession[] {
  const arr = body && typeof body === 'object' ? (body as { sessions?: unknown }).sessions : null;
  if (!Array.isArray(arr)) return [];
  const s = (o: Record<string, unknown>, k: string) => (typeof o[k] === 'string' && o[k] !== '' ? (o[k] as string) : null);
  return arr
    .filter((o): o is Record<string, unknown> => !!o && typeof o === 'object' && typeof (o as { id?: unknown }).id === 'string')
    .map((o) => ({
      id: String(o.id),
      posUserId: String(o.posUserId ?? ''),
      posUserName: s(o, 'posUserName'),
      machineName: s(o, 'machineName'),
      posNumber: s(o, 'posNumber'),
      startedAt: s(o, 'startedAt'),
      lastSeenAt: s(o, 'lastSeenAt'),
      silentSince: s(o, 'silentSince'),
      openTables: typeof o.openTables === 'number' ? o.openTables : 0,
      here: o.here === true,
    }));
}

/* ---------------------------------------------------------- "נעילה בחוסר שימוש" */

/** `idleLockSeconds`: no touch for this long signs the operator out (0 / blank = off). Kept within 10 s – 1 h. */
export const IDLE_LOCK_PARAM = 'idleLockSeconds';

export function idleLockSecondsOf(v: unknown): number | null {
  const n = Math.trunc(Number(String(v ?? '').trim()));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(3600, Math.max(10, n));
}

/* ------------------------------------------------------------ the till's side */

const APPROVAL_LOCK = 'till.sessionApprovalLock';

/**
 * The engine's side of it: the sign-in's check and its dialogs (blocked — "שחרור באישור מנהל"; no answer under `manager` — a
 * manager's code), the banner, "עובדים מחוברים", and the idle lock.
 */
export class TillSessions {
  readonly guard: UserSessionGuard;
  private readonly remote: UserSessionRemote;
  private list: UsersState['list'] = null;
  private busy = false;
  private error: string | null = null;
  /** A manager who opened "עובדים מחוברים" with their code: the releases there are theirs. */
  private approver: { id: string; name: string } | null = null;
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly c: TillContext,
    private readonly o: {
      /** Let `user` in (the PIN was right and the check passed). */
      completeSignIn(user: RosterUser): unknown;
      /** Sign the operator out (the idle lock, a manager's release). */
      signOut(reason: 'idle' | 'released'): void;
      /** The last touch (ms). */
      lastActivity(): number;
      /** Nothing in progress a sign-out would cut short. */
      canSignOutNow(): boolean;
      remote?: UserSessionRemote;
      host?: () => UserSessionHostRemote | null;
    },
  ) {
    const svc = c.svc;
    this.remote = o.remote ?? new CloudUserSessions({ api: svc.api, machineId: () => svc.machineId });
    this.guard = new UserSessionGuard({
      remote: this.remote,
      operator: () => this.guardUser(c.operator()),
      // From the heartbeat's loop: in the engine's turn, never between two steps of an op.
      signOut: () =>
        void c.later(() => {
          o.signOut('released');
          c.changed();
        }),
      settings: () => this.settings(),
      paired: () => svc.paired,
      pending: new KvPendingReleases(svc.kv),
      canSignOutNow: () => o.canSignOutNow(),
      host: o.host,
      now: () => c.now(),
      log: (m) => c.log(m),
    });
  }

  settings(): ExclusiveSettings {
    return exclusiveSettingsOf(this.c.svc.cloud.parameters());
  }

  guardUser(u: RosterUser | null): GuardUser | null {
    return u ? { id: u.id, name: displayName(u), role: u.role, permissions: u.permissions ?? null } : null;
  }

  start() {
    this.guard.start();
    this.idleTimer = setInterval(() => this.idleCheck(), 1_000);
    this.idleTimer.unref?.();
  }

  stop() {
    this.guard.stop();
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = null;
  }

  /** "נעילה בחוסר שימוש": no touch for the parameter's seconds signs the operator out — never over a payment. */
  idleCheck() {
    const secs = idleLockSecondsOf(this.c.svc.cloud.parameters()[IDLE_LOCK_PARAM]);
    if (secs === null || !this.c.operator()) return;
    if (this.c.now() - this.o.lastActivity() < secs * 1000) return;
    if (!this.o.canSignOutNow()) return;
    void this.c.later(() => {
      if (!this.c.operator() || this.c.now() - this.o.lastActivity() < secs * 1000 || !this.o.canSignOutNow()) return;
      this.c.log('idle lock: the operator signed out');
      this.o.signOut('idle');
      this.c.changed();
    });
  }

  /** The engine's sign-in / sign-out, told to the guard. */
  signedIn(u: RosterUser) {
    this.guard.signedIn(this.guardUser(u)!);
  }

  left(u: RosterUser) {
    this.guard.left(this.guardUser(u)!);
    this.list = null;
    this.approver = null;
    this.error = null;
  }

  /**
   * The check after the right PIN: in ("in"), or a question (the dialog's id) — signed in elsewhere: "שחרור באישור מנהל"; no
   * answer under `manager`: a manager's code. The question's answer completes the sign-in itself.
   */
  async afterPin(user: RosterUser): Promise<'in' | { dialogId: string; blocked?: true }> {
    const decision = await this.guard.claimForSignIn(this.guardUser(user)!);
    return this.decide(user, decision);
  }

  private decide(user: RosterUser, decision: SignInDecision): 'in' | { dialogId: string; blocked?: true } {
    const name = displayName(user);
    switch (decision.kind) {
      case 'proceed':
      case 'proceed_unchecked':
        return 'in';
      case 'manager_code':
        // No answer from the cloud nor the LAN host, and the shop asks a manager then — unless the one signing in is one.
        if (mayRelease(user)) return 'in';
        return this.c.ask({
          kind: 'manager_approval',
          title: EXCLUSIVE_TEXT.title,
          body: EXCLUSIVE_TEXT.offlineManager(name),
          fields: [{ name: 'pin', label: 'קוד מנהל', kind: 'pin' }],
          actions: [
            { id: 'approve', label: 'אישור', primary: true },
            { id: 'cancel', label: 'ביטול' },
          ],
          verify: (pin) => this.verifyManager(pin),
          resume: (by) => {
            this.c.log(`exclusive login: ${name} signed in without an answer, on ${by?.name ?? '-'}'s code`);
            return this.o.completeSignIn(user);
          },
        });
      case 'blocked':
        return { ...this.askRelease(user, decision.holder), blocked: true };
      case 'ask_manager':
        return this.askRelease(user, null, true);
      case 'approval_refused':
        return this.c.refuse('permission_denied', EXCLUSIVE_TEXT.notPermitted);
    }
  }

  /** "דנה מחובר/ת כרגע בקופה 3 מאז 14:05" with "שחרור באישור מנהל": their own authority, else a manager's code. */
  private askRelease(user: RosterUser, holder: SessionHolder | null, again = false): { dialogId: string } {
    const name = displayName(user);
    const now = this.c.now();
    const silent = holder?.silentSince ? sinceLabel(holder.silentSince, now) : null;
    const body = [
      holder ? EXCLUSIVE_TEXT.blocked(holder.posUserName ?? name, tillLabel(holder), sinceLabel(holder.since, now)) : again ? EXCLUSIVE_TEXT.notPermitted : '',
      silent ? EXCLUSIVE_TEXT.holderSilent(silent) : '',
    ]
      .filter(Boolean)
      .join('\n');
    const own = mayRelease(user);
    const force = (approver: { id: string; name: string }) => this.force(user, approver);
    if (own) {
      // A shop manager signing in has just typed their own PIN and holds the authority: released on it.
      return this.c.ask({
        kind: 'confirm',
        title: EXCLUSIVE_TEXT.title,
        body,
        fields: [],
        actions: [
          { id: 'release', label: EXCLUSIVE_TEXT.release, primary: true },
          { id: 'cancel', label: 'ביטול' },
        ],
        onAction: () => force({ id: user.id, name }),
      });
    }
    return this.c.ask({
      kind: 'manager_approval',
      title: EXCLUSIVE_TEXT.title,
      body,
      fields: [{ name: 'pin', label: 'קוד מנהל', kind: 'pin' }],
      actions: [
        { id: 'approve', label: EXCLUSIVE_TEXT.release, primary: true },
        { id: 'cancel', label: 'ביטול' },
      ],
      verify: (pin) => this.verifyManager(pin),
      resume: (by) => (by ? force(by) : undefined),
    });
  }

  private async force(user: RosterUser, approver: { id: string; name: string }) {
    const d = await this.guard.forceClaim(this.guardUser(user)!, approver.id);
    if (d.kind === 'proceed' || d.kind === 'proceed_unchecked' || d.kind === 'manager_code') return this.o.completeSignIn(user);
    return this.decide(user, d);
  }

  /** A manager's code that may release an employee (USER_SESSION_RELEASE alone), against the roster. */
  private async verifyManager(pin: string): Promise<{ ok: true; by: { id: string; name: string } } | { ok: false; message: string }> {
    const svc = this.c.svc;
    const out = await approveBy({
      users: this.c.roster(),
      shopId: this.c.shopId(),
      pin,
      may: (u) => mayRelease(u),
      noApprover: `אין בסניף מנהל עם ההרשאה "שחרור עובד מקופה אחרת"`,
      lock: svc.kv.getJson<ExitLock>(APPROVAL_LOCK) ?? NO_LOCK,
      nowMs: this.c.now(),
      compare: this.c.compare,
    });
    if (!out.ok) {
      svc.kv.setJson(APPROVAL_LOCK, out.lock);
      return { ok: false, message: out.message };
    }
    svc.kv.setJson(APPROVAL_LOCK, NO_LOCK);
    return { ok: true, by: { id: out.user.id, name: displayName(out.user) } };
  }

  /* ------------------------------------------------------ "עובדים מחוברים" */

  state(): UsersState {
    const u = this.c.operator();
    const s = this.settings();
    return {
      notice: this.guard.notice ? noticeText(this.guard.notice, this.c.now()) : null,
      // The menu's row: the rule on here, and someone who may release — or ask a manager's code (§8א: "בלי מנהל מחובר").
      offered: !!u && s.enabled,
      list: this.list,
      busy: this.busy,
      error: this.error,
    };
  }

  /** Open "עובדים מחוברים": the operator's own authority, else a manager's code (USER_SESSION_RELEASE) — then the cloud's list. */
  open(): Promise<unknown> | unknown {
    const u = this.c.signedIn();
    if (mayRelease(u)) {
      this.approver = { id: u.id, name: displayName(u) };
      return this.load();
    }
    return this.c.ask({
      kind: 'manager_approval',
      title: EXCLUSIVE_TEXT.usersTitle,
      body: EXCLUSIVE_TEXT.usersCodeReason,
      fields: [{ name: 'pin', label: 'קוד מנהל', kind: 'pin' }],
      actions: [
        { id: 'approve', label: 'אישור', primary: true },
        { id: 'cancel', label: 'ביטול' },
      ],
      verify: (pin) => this.verifyManager(pin),
      resume: (by) => {
        this.approver = by;
        return this.load();
      },
    });
  }

  async load(): Promise<unknown> {
    if (!this.approver) return this.c.refuse('permission_denied', `אין לך הרשאה: שחרור עובד מקופה אחרת`);
    this.busy = true;
    this.error = null;
    this.c.changed();
    try {
      const r = await this.remote.list();
      if (!r) {
        this.error = EXCLUSIVE_TEXT.usersOffline;
        return this.c.refuse('engine_offline', EXCLUSIVE_TEXT.usersOffline);
      }
      if (r.status >= 300) {
        this.error = EXCLUSIVE_TEXT.usersRefused(`HTTP ${r.status}`);
        return this.c.refuse('permission_denied', this.error);
      }
      this.list = { sessions: parseSessions(r.body), at: this.c.now() };
      return { count: this.list.sessions.length };
    } finally {
      this.busy = false;
      this.c.changed();
    }
  }

  /** "שחרור" on a row: confirmed, then released from wherever it is, as the manager who opened the screen. */
  release(sessionId: unknown): unknown {
    this.c.signedIn();
    const row = typeof sessionId === 'string' ? this.list?.sessions.find((x) => x.id === sessionId) : undefined;
    if (!row || !this.approver) return this.c.refuse('invalid_args');
    const approver = this.approver;
    const who = row.posUserName ?? '';
    return this.c.ask({
      kind: 'confirm',
      title: EXCLUSIVE_TEXT.usersTitle,
      body: EXCLUSIVE_TEXT.usersConfirm(who, tillLabel({ machineName: row.machineName, posNumber: row.posNumber })),
      fields: [],
      actions: [
        { id: 'release', label: EXCLUSIVE_TEXT.usersRelease, primary: true },
        { id: 'cancel', label: 'ביטול' },
      ],
      onAction: async () => {
        const r = await this.remote.releaseSession(row.id, approver.id);
        if (!r) return this.c.refuse('engine_offline', EXCLUSIVE_TEXT.usersOffline);
        const body = (r.body ?? {}) as Record<string, unknown>;
        if (r.status >= 300) {
          const detail = body.detail;
          const code = detail && typeof detail === 'object' ? String((detail as { code?: unknown }).code ?? '') : typeof detail === 'string' ? detail : `HTTP ${r.status}`;
          return this.c.refuse('permission_denied', EXCLUSIVE_TEXT.usersFailed(code));
        }
        this.c.toast(body.status === 'not_held' ? EXCLUSIVE_TEXT.usersNotHeld(who) : EXCLUSIVE_TEXT.usersDone(who), 'ok');
        if (Array.isArray(body.warnings)) for (const w of body.warnings) if (typeof w === 'string') this.c.toast(w, 'info');
        if (this.list) this.list = { ...this.list, sessions: this.list.sessions.filter((x) => x.id !== row.id) };
        return { status: body.status ?? 'released' };
      },
    });
  }

  closeList() {
    this.list = null;
    this.error = null;
    return undefined;
  }

  dismissNotice() {
    this.guard.dismissNotice();
    return undefined;
  }
}
