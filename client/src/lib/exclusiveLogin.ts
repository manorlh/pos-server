/**
 * "עובד מחובר בקופה אחת בלבד" (v2: P:/specs/exclusive-login-v2.md; pos-server
 * docs/SPEC_EXCLUSIVE_LOGIN.md) — the web till's side, as the APK's `UserSessionGuard` and
 * `LoginScreen` do it (the owner: the web till matches the APK in every configuration).
 *
 * The till asks the cloud before it lets an employee in (`claim`), says every minute that they
 * are still there (`heartbeat`), and lets go when they leave (`release`):
 *
 *   POST sync/{machineId}/user-session/claim      {posUserId, force?}   (+ X-Elevation-Token / X-Pos-User-Id)
 *   POST sync/{machineId}/user-session/heartbeat  {posUserId, signedInAt}
 *   POST sync/{machineId}/user-session/release    {posUserId}
 *
 * Every answer (200 or 409) carries the policy: `exclusive`, `staleMinutes`, `autoRelease`
 * (off | minutes), `offline` (allow | lan | manager), `duplicate` (warn | signout). 200 is
 * `claimed` / `held` / `off` / `exempt` (the employee holds "עבודה בכמה מכשירים במקביל");
 * 409 `user_signed_in_elsewhere` (where, since, `holderSilentSince`) or `user_session_released`.
 *
 * Here: reading the answers, the decisions (sign in / block with the two buttons / ask a
 * manager's code / warn / sign out at the end of the operation), the Hebrew the till shows, and
 * `UserSessionGuard` — the claim, the minute's heartbeat and releases kept until the cloud
 * answers. The screens (the web till's login, its banner, its idle gate) call these.
 *
 * Pure of React; relative imports only (the node tests compile it on its own).
 */

import type { ApiReply } from './kioskWebApi';

// ── The wire ─────────────────────────────────────────────────────────────────

export type ClaimStatus = 'claimed' | 'held' | 'off' | 'exempt';
export type AutoRelease = 'off' | 'minutes';
export type OfflineMode = 'allow' | 'lan' | 'manager';
export type DuplicateMode = 'warn' | 'signout';

export interface SessionPolicy {
  exclusive: boolean;
  staleMinutes: number;
  autoRelease: AutoRelease;
  offline: OfflineMode;
  duplicate: DuplicateMode;
}

/** The defaults a till keeps until the cloud says otherwise (the built-in parameters'). */
export const DEFAULT_POLICY: SessionPolicy = {
  exclusive: false,
  staleMinutes: 15,
  autoRelease: 'off',
  offline: 'allow',
  duplicate: 'warn',
};

/** Where an employee is signed in (the 409's detail, `tookOver`, a released session's `now`). */
export interface Holder {
  sessionId: string | null;
  posUserId: string | null;
  posUserName: string | null;
  machineId: string | null;
  machineName: string | null;
  posNumber: string | null;
  since: string | null;
  lastSeenAt: string | null;
  /** That device stopped reporting (three missed heartbeats): since when. */
  holderSilentSince: string | null;
}

export interface Released {
  /** manager | duplicate */
  releasedBy: string | null;
  releasedByName: string | null;
  releasedAt: string | null;
  fromDashboard: boolean;
  now: Holder | null;
}

export type SessionAnswer =
  | { kind: 'ok'; status: ClaimStatus; policy: SessionPolicy; sessionId: string | null; tookOver: (Holder & { releasedBy: string | null; approvedBy: string | null }) | null }
  | { kind: 'elsewhere'; holder: Holder; policy: SessionPolicy }
  | { kind: 'released'; released: Released; policy: SessionPolicy }
  /** 401: no approval, or the code was spent / expired — ask for a manager's code again. */
  | { kind: 'needsManager'; code: string }
  /** 403: this approval does not release here (another till's code, a code without the right, another employee's). */
  | { kind: 'forbidden'; code: string }
  /** No answer: no network, a timeout, the gateway, a 5xx. */
  | { kind: 'unreachable' }
  /** Any other refusal (404 `pos_user_not_found`, 409 `machine_not_assigned`…): the APK lets the employee in. */
  | { kind: 'refused'; status: number; code: string | null };

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : typeof v === 'number' ? String(v) : null;
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function oneOf<T extends string>(v: unknown, options: readonly T[], fallback: T): T {
  return typeof v === 'string' && (options as readonly string[]).includes(v) ? (v as T) : fallback;
}

/** The policy fields of any answer; anything missing or unknown is the default (an older cloud). */
export function policyOf(raw: unknown): SessionPolicy {
  const o = obj(raw);
  const minutes = typeof o.staleMinutes === 'number' && Number.isFinite(o.staleMinutes) ? o.staleMinutes : DEFAULT_POLICY.staleMinutes;
  return {
    exclusive: o.exclusive === true,
    staleMinutes: minutes,
    autoRelease: oneOf(o.autoRelease, ['off', 'minutes'] as const, DEFAULT_POLICY.autoRelease),
    offline: oneOf(o.offline, ['allow', 'lan', 'manager'] as const, DEFAULT_POLICY.offline),
    duplicate: oneOf(o.duplicate, ['warn', 'signout'] as const, DEFAULT_POLICY.duplicate),
  };
}

export function holderOf(raw: unknown): Holder {
  const o = obj(raw);
  return {
    sessionId: str(o.sessionId),
    posUserId: str(o.posUserId),
    posUserName: str(o.posUserName),
    machineId: str(o.machineId),
    machineName: str(o.machineName),
    posNumber: str(o.posNumber),
    since: str(o.since),
    lastSeenAt: str(o.lastSeenAt),
    holderSilentSince: str(o.holderSilentSince),
  };
}

/** One reply of claim / heartbeat (kioskWebApi's `ApiReply`) as the till reads it. */
export function readAnswer(reply: ApiReply): SessionAnswer {
  if (reply.kind === 'offline') return { kind: 'unreachable' };
  if (reply.kind === 'ok') {
    const o = obj(reply.body);
    const tookOver = o.tookOver && typeof o.tookOver === 'object'
      ? { ...holderOf(o.tookOver), releasedBy: str(obj(o.tookOver).releasedBy), approvedBy: str(obj(o.tookOver).approvedBy) }
      : null;
    return {
      kind: 'ok',
      status: oneOf(o.status, ['claimed', 'held', 'off', 'exempt'] as const, 'off'),
      policy: policyOf(o),
      sessionId: str(o.sessionId),
      tookOver,
    };
  }
  if (reply.status >= 500) return { kind: 'unreachable' };
  const detail = obj(obj(reply.body).detail);
  const code = reply.detail ?? str(detail.code);
  if (reply.status === 409 && code === 'user_signed_in_elsewhere') {
    return { kind: 'elsewhere', holder: holderOf(detail), policy: policyOf(detail) };
  }
  if (reply.status === 409 && code === 'user_session_released') {
    return {
      kind: 'released',
      released: {
        releasedBy: str(detail.releasedBy),
        releasedByName: str(detail.releasedByName),
        releasedAt: str(detail.releasedAt),
        fromDashboard: detail.fromDashboard === true,
        now: detail.now && typeof detail.now === 'object' ? holderOf(detail.now) : null,
      },
      policy: policyOf(detail),
    };
  }
  if (reply.status === 401) return { kind: 'needsManager', code: code ?? 'elevation_required' };
  if (reply.status === 403) return { kind: 'forbidden', code: code ?? 'forbidden' };
  return { kind: 'refused', status: reply.status, code };
}

// ── The decisions ────────────────────────────────────────────────────────────

/** Should the till ask the cloud at all (as the APK: the rule on here, and an employee the cloud knows). */
export function shouldClaim(exclusiveParam: unknown, cloudPosUserId: string | null | undefined): boolean {
  const on = exclusiveParam === true || (typeof exclusiveParam === 'string' && ['true', '1', 'yes', 'כן'].includes(exclusiveParam.trim().toLowerCase()));
  return on && !!cloudPosUserId;
}

export type SignInDecision =
  | { action: 'enter' }
  /** Blocked: the dialog, with "שחרור באישור מנהל" (a code) and, when offered, "בקשת שחרור ממנהל" (the phone). */
  | { action: 'block'; holder: Holder; offerCode: true; offerRemote: boolean }
  /** No answer and `offline = manager` (no host answered either): a manager's code lets them in. */
  | { action: 'managerCode' }
  /** The code did not release (401): ask for a manager's code again. */
  | { action: 'retryCode'; code: string }
  /** The approval does not release here (403): say so, stay on the sign-in. */
  | { action: 'notPermitted'; code: string };

export interface SignInContext {
  /** The policy last heard (a cached answer); the default until the cloud has answered once. */
  policy?: SessionPolicy | null;
  /** "בקשת שחרור ממנהל" is on for this till (approvals: `user_release` enabled with `remote`). */
  remoteApproval: boolean;
}

/**
 * What the sign-in does with a claim's answer — the APK's table: 200 or a refusal it does not know
 * → in; no answer → in (`allow`), or a manager's code (`manager`; `lan` falls back to `allow` when
 * no host answered); 409 → the dialog. After a forced claim: 401 → the code again, 403 → refused.
 */
export function signInDecision(answer: SessionAnswer, ctx: SignInContext): SignInDecision {
  switch (answer.kind) {
    case 'ok':
    case 'refused':
      return { action: 'enter' };
    case 'unreachable':
      return (ctx.policy ?? DEFAULT_POLICY).offline === 'manager' ? { action: 'managerCode' } : { action: 'enter' };
    case 'elsewhere':
      return { action: 'block', holder: answer.holder, offerCode: true, offerRemote: ctx.remoteApproval };
    case 'released':
      // A claim never says this; read as a sign-in that may go ahead.
      return { action: 'enter' };
    case 'needsManager':
      return { action: 'retryCode', code: answer.code };
    case 'forbidden':
      return { action: 'notPermitted', code: answer.code };
  }
}

export type HeartbeatDecision =
  /** Nothing to do; a warning shown before goes. */
  | { action: 'none' }
  /** Signed in elsewhere too (`warn`): the orange banner, work goes on. */
  | { action: 'warn'; holder: Holder }
  /**
   * Sign the employee out — only when no payment is on screen and no open table is held, as the idle
   * lock (the APK's `ScreenSaverGate`); until then the notice, retried every few seconds.
   */
  | { action: 'signOutWhenIdle'; reason: 'released' | 'duplicate'; released: Released | null; holder: Holder | null };

/** What the guard does with a heartbeat's answer. */
export function heartbeatDecision(answer: SessionAnswer): HeartbeatDecision {
  if (answer.kind === 'elsewhere') {
    return answer.policy.duplicate === 'signout'
      ? { action: 'signOutWhenIdle', reason: 'duplicate', released: null, holder: answer.holder }
      : { action: 'warn', holder: answer.holder };
  }
  if (answer.kind === 'released') {
    const reason = answer.released.releasedBy === 'duplicate' ? 'duplicate' : 'released';
    return { action: 'signOutWhenIdle', reason, released: answer.released, holder: answer.released.now };
  }
  return { action: 'none' };
}

// ── What the till shows ──────────────────────────────────────────────────────

/** "קופה 3 (בר)", "קופה 3", "קופה „בר”", "קופה אחרת" — the APK's `exclusive_login_till_*`. */
export function tillName(h: Pick<Holder, 'posNumber' | 'machineName'> | null | undefined): string {
  const n = h?.posNumber ?? null;
  const name = h?.machineName ?? null;
  if (n && name && name !== `קופה ${n}`) return `קופה ${n} (${name})`;
  if (n) return `קופה ${n}`;
  if (name) return `קופה „${name}”`;
  return 'קופה אחרת';
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** "14:05" today, "13.10 14:05" another day — local time. */
export function sinceText(iso: string | null | undefined, now: Date = new Date()): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const hm = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const sameDay = at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth() && at.getDate() === now.getDate();
  return sameDay ? hm : `${at.getDate()}.${pad(at.getMonth() + 1)} ${hm}`;
}

/** The dialog's line: "דנה מחובר/ת כרגע בקופה 3 (בר) מאז 14:05. יש להתנתק שם קודם." */
export function blockedText(holder: Holder, fallbackName: string, now?: Date): string {
  const who = holder.posUserName ?? fallbackName;
  const since = sinceText(holder.since, now);
  return since
    ? `${who} מחובר/ת כרגע ב${tillName(holder)} מאז ${since}. יש להתנתק שם קודם.`
    : `${who} מחובר/ת כרגע ב${tillName(holder)}. יש להתנתק שם קודם.`;
}

/** "המכשיר הקודם לא מדווח מאז 14:20." — so the manager knows it is safe to release. */
export function silentText(holder: Holder, now?: Date): string | null {
  const since = sinceText(holder.holderSilentSince, now);
  return since ? `המכשיר הקודם לא מדווח מאז ${since}.` : null;
}

/** The banner (`warn`): "דנה מחובר/ת גם בקופה 3 (בר) (מאז 14:05). יש להתנתק שם." */
export function warnText(holder: Holder, fallbackName: string, now?: Date): string {
  const who = holder.posUserName ?? fallbackName;
  const since = sinceText(holder.since, now);
  return since
    ? `${who} מחובר/ת גם ב${tillName(holder)} (מאז ${since}). יש להתנתק שם.`
    : `${who} מחובר/ת גם ב${tillName(holder)}. יש להתנתק שם.`;
}

/** While the sign-out waits for the operation to end. */
export function signingOutText(decision: Extract<HeartbeatDecision, { action: 'signOutWhenIdle' }>, name: string): string {
  if (decision.reason === 'duplicate') {
    return `${name} מחובר/ת גם ב${tillName(decision.holder)}. הקופה תנתק את ${name} בסיום הפעולה.`;
  }
  return `החיבור של ${name} שוחרר באישור מנהל. הקופה תתנתק בסיום הפעולה.`;
}

/** On the sign-in screen after the sign-out. */
export function signedOutText(decision: Extract<HeartbeatDecision, { action: 'signOutWhenIdle' }>, name: string): string {
  if (decision.reason === 'duplicate') return `${name} נותק/ה מקופה זו: מחובר/ת גם ב${tillName(decision.holder)}.`;
  return decision.holder
    ? `${name} נותק/ה מקופה זו: החיבור שוחרר באישור מנהל, ועכשיו מחובר/ת ב${tillName(decision.holder)}.`
    : `${name} נותק/ה מקופה זו: החיבור שוחרר באישור מנהל.`;
}

export const TEXTS = {
  title: 'מחובר/ת בקופה אחרת',
  releaseWithCode: 'שחרור באישור מנהל',
  requestFromPhone: 'בקשת שחרור ממנהל',
  notPermitted: 'האישור לא מתיר שחרור עובד בקופה הזו',
  checking: 'בודק…',
  offlineManager: (name: string) => `אין תשובה מהענן. הכניסה של ${name} באישור מנהל.`,
  elevateReason: (name: string, holder: Holder) => `שחרור ${name} מ${tillName(holder)} כדי להתחבר בקופה הזו`,
} as const;

// ── The guard ────────────────────────────────────────────────────────────────

/** The machine-token client (kioskWebApi's `KioskApi.post`). */
export interface SessionTransport {
  post(path: string, body?: unknown, opts?: { timeoutMs?: number; headers?: Record<string, string> }): Promise<ApiReply>;
}

/** Where releases wait for an answer (localStorage on the web till; a map in tests). */
export interface PendingStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

/** Short, so a sign-in with no network does not wait for nothing (the APK: 4 s to connect, 6 s to answer). */
export const CLAIM_TIMEOUT_MS = 6_000;
/** The heartbeat's pace while someone is signed in (the APK's guard loop). */
export const HEARTBEAT_EVERY_MS = 60_000;
const PENDING_KEY = 'r2m.userSession.pendingReleases';

export interface ForceApproval {
  /** A manager's code at this till, or a phone's approval (`grantId`): `X-Elevation-Token`. */
  elevationToken?: string;
  /** The signed-in operator whose own role releases (a manager signing in): `X-Pos-User-Id`. */
  operatorId?: string;
}

export class UserSessionGuard {
  private policy: SessionPolicy | null = null;

  constructor(
    private readonly machineId: string,
    private readonly api: SessionTransport,
    private readonly store: PendingStore | null = null,
  ) {}

  /** The policy of the last answer (null until the cloud has answered). */
  get lastPolicy(): SessionPolicy | null {
    return this.policy;
  }

  private path(what: string): string {
    return `sync/${encodeURIComponent(this.machineId)}/user-session/${what}`;
  }

  private remember(answer: SessionAnswer): SessionAnswer {
    if (answer.kind === 'ok' || answer.kind === 'elsewhere' || answer.kind === 'released') this.policy = answer.policy;
    return answer;
  }

  /** Before the employee is let in; `force` with a manager's approval releases the other device. */
  async claim(posUserId: string, force?: ForceApproval): Promise<SessionAnswer> {
    const headers: Record<string, string> = {};
    if (force?.elevationToken) headers['X-Elevation-Token'] = force.elevationToken;
    if (force?.operatorId) headers['X-Pos-User-Id'] = force.operatorId;
    const body = force ? { posUserId, force: true } : { posUserId };
    return this.remember(readAnswer(await this.api.post(this.path('claim'), body, { timeoutMs: CLAIM_TIMEOUT_MS, headers })));
  }

  /** Every minute while signed in; `signedInAt` is when this till let them in (its own clock). */
  async heartbeat(posUserId: string, signedInAt: Date | string): Promise<SessionAnswer> {
    const at = typeof signedInAt === 'string' ? signedInAt : signedInAt.toISOString();
    return this.remember(readAnswer(await this.api.post(this.path('heartbeat'), { posUserId, signedInAt: at })));
  }

  private pending(): string[] {
    try {
      const raw = this.store?.get(PENDING_KEY);
      const list = raw ? (JSON.parse(raw) as unknown) : [];
      return Array.isArray(list) ? list.filter((v): v is string => typeof v === 'string') : [];
    } catch {
      return [];
    }
  }

  private savePending(ids: string[]): void {
    try {
      this.store?.set(PENDING_KEY, JSON.stringify(Array.from(new Set(ids))));
    } catch {
      // A store that cannot write: the release is tried once, and the session goes stale at worst.
    }
  }

  /** The employee left this till (sign-out, switch, idle lock): kept until the cloud answers. */
  async release(posUserId: string): Promise<void> {
    this.savePending([...this.pending(), posUserId]);
    await this.flush();
  }

  /** Send every release still waiting (each round of the heartbeat loop, and at start). */
  async flush(): Promise<void> {
    const left: string[] = [];
    for (const id of this.pending()) {
      const reply = await this.api.post(this.path('release'), { posUserId: id });
      // Answered (released / not_held) or refused for good (a 4xx): done. No answer: kept.
      if (reply.kind === 'offline' || (reply.kind === 'refused' && reply.status >= 500)) left.push(id);
    }
    this.savePending(left);
  }

  /** The operator changed: whoever stopped being the operator is released — no screen has to remember. */
  async operatorChanged(previous: string | null, next: string | null): Promise<void> {
    if (previous && previous !== next) await this.release(previous);
  }
}
