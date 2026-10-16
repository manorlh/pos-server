/**
 * "עובד מחובר בקופה אחת בלבד" — an employee signed in at one till cannot sign in at another until they sign out there
 * (pos-server docs/SPEC_EXCLUSIVE_LOGIN.md; v2: P:/specs/exclusive-login-v2.md — pos-android domain/ExclusiveLogin.kt and
 * data/remote/UserSessionApi.kt `sessionReplyOf`). The decisions, pure: what a sign-in does with the cloud's answer, what a
 * heartbeat's answer means, and how "where" is said. The calls and the loop are main/till/userSessions.ts.
 *
 * The one rule underneath: a till is never unusable without the cloud — unless the shop chose so (`exclusiveUserLoginOffline`).
 * By default no answer is a sign-in allowed (claimed when the connection is back); a refusal the till cannot place is too. Only
 * a clear "signed in elsewhere" stops it. v2: the rule is for whoever lacks MULTI_DEVICE_LOGIN (exempt: nothing claimed,
 * nothing recorded); without the cloud the shop's LAN host may arbitrate (`lan`) or a manager's code let them in (`manager`);
 * a duplicate found later may sign the later device out (`signout`).
 */

import { permissionState, type RosterUser } from '../desktopExit';

export const EXCLUSIVE_PARAMS = {
  ENABLED: 'exclusiveUserLogin',
  AUTO_RELEASE: 'exclusiveUserLoginAutoRelease',
  STALE_MINUTES: 'exclusiveUserLoginStaleMinutes',
  OFFLINE: 'exclusiveUserLoginOffline',
  DUPLICATE: 'exclusiveUserLoginDuplicate',
} as const;

export const MULTI_DEVICE_LOGIN = 'MULTI_DEVICE_LOGIN';
export const USER_SESSION_RELEASE = 'USER_SESSION_RELEASE';

export const DEFAULT_STALE_MINUTES = 15;
export const STALE_MINUTES_MIN = 2;
export const STALE_MINUTES_MAX = 720;
/** The heartbeat while someone is signed in; the cloud's stale default is 15 minutes. */
export const HEARTBEAT_MS = 60_000;
/** How soon a sign-out the cloud asked for is tried again while the till is mid-payment. */
export const KICK_RETRY_MS = 5_000;

/** `exclusiveUserLoginOffline`: what a sign-in does when the cloud does not answer (v2 §4). */
export type OfflineMode = 'allow' | 'lan' | 'manager';
/** `exclusiveUserLoginDuplicate`: an employee found signed in at two devices after an offline sign-in. */
export type DuplicateMode = 'warn' | 'signout';

export interface ExclusiveSettings {
  enabled: boolean;
  offline: OfflineMode;
  duplicate: DuplicateMode;
  /** Null: "off" — a silent device's session is let go only by a manager. */
  autoReleaseMinutes: number | null;
}

export const EXCLUSIVE_OFF: ExclusiveSettings = { enabled: false, offline: 'allow', duplicate: 'warn', autoReleaseMinutes: null };

const norm = (v: unknown): string => (v === undefined || v === null ? '' : String(v)).trim().toLowerCase();

export const enabledOf = (params: Record<string, unknown>): boolean => ['true', '1', 'yes', 'כן'].includes(norm(params[EXCLUSIVE_PARAMS.ENABLED]));

export function offlineOf(params: Record<string, unknown>): OfflineMode {
  const v = norm(params[EXCLUSIVE_PARAMS.OFFLINE]);
  return v === 'lan' || v === 'manager' ? v : 'allow';
}

export const duplicateOf = (params: Record<string, unknown>): DuplicateMode => (norm(params[EXCLUSIVE_PARAMS.DUPLICATE]) === 'signout' ? 'signout' : 'warn');

/** The minutes after which a silent device's session is let go, or null — "off", the default. Within 2–720; anything unusable is 15. */
export function autoReleaseMinutesOf(params: Record<string, unknown>): number | null {
  if (norm(params[EXCLUSIVE_PARAMS.AUTO_RELEASE]) !== 'minutes') return null;
  const raw = norm(params[EXCLUSIVE_PARAMS.STALE_MINUTES]);
  const n = raw ? Math.trunc(Number(raw)) : NaN;
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_STALE_MINUTES;
  return Math.min(STALE_MINUTES_MAX, Math.max(STALE_MINUTES_MIN, n));
}

export function exclusiveSettingsOf(params: Record<string, unknown>): ExclusiveSettings {
  return { enabled: enabledOf(params), offline: offlineOf(params), duplicate: duplicateOf(params), autoReleaseMinutes: autoReleaseMinutesOf(params) };
}

/** "עבודה בכמה מכשירים במקביל" (v2 §1): the rule is not for them — no claim, no heartbeat, nothing recorded. */
export const exempt = (u: Pick<RosterUser, 'role' | 'permissions'>): boolean => permissionState(u, MULTI_DEVICE_LOGIN) === 'allow';

/** May the employee release a session on their own authority (a supervisor or a manager: their PIN is the code)? */
export const mayRelease = (u: Pick<RosterUser, 'role' | 'permissions'>): boolean => permissionState(u, USER_SESSION_RELEASE) === 'allow';

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** The id the cloud knows the employee by, or null for one it cannot (a demo's built-in staff), whose sign-in is never checked. */
export const cloudIdOf = (id: string, cloudId?: string | null): string | null => {
  const v = cloudId ?? id;
  return UUID.test(v) ? v : null;
};

/** Where an employee is signed in, as the cloud (or the LAN host) said. */
export interface SessionHolder {
  posUserName?: string | null;
  machineId?: string | null;
  machineName?: string | null;
  posNumber?: string | null;
  since?: string | null;
  lastSeenAt?: string | null;
  /** `holderSilentSince` (v2 §3): set only when the holding device is silent, so a manager knows it is safe to release. */
  silentSince?: string | null;
}

/** The cloud's answer to a claim, a heartbeat or a release. */
export type SessionReply =
  /** `claimed` | `held` | `off` | `exempt` | `released` | `not_held`; a forced claim's `tookOver.warnings`. */
  | { kind: 'ok'; status: string; warnings: string[] }
  /** 409 `user_signed_in_elsewhere`; `duplicate`: the cloud's resolved policy for this till (null — the till's own). */
  | { kind: 'elsewhere'; holder: SessionHolder; duplicate: DuplicateMode | null }
  /** 409 `user_session_released`: a manager released this till's session — or a duplicate (`releasedBy: duplicate`). */
  | { kind: 'released'; byName: string | null; fromDashboard: boolean; now: SessionHolder | null; releasedBy: string | null }
  /** 401: a forced claim without a (live, unspent) manager's approval. */
  | { kind: 'needs_manager'; code: string | null }
  /** 403: the approval does not cover this. */
  | { kind: 'manager_refused'; code: string | null }
  /** Any other refusal (404 an employee the cloud does not know here, 400, 422…). */
  | { kind: 'refused'; status: number; code: string | null }
  /** No answer: no network, a timeout, a 5xx, not paired. */
  | { kind: 'offline'; reason: string };

export const isRecorded = (r: SessionReply): boolean => r.kind === 'ok' && (r.status === 'claimed' || r.status === 'held');

const strOrNull = (o: Record<string, unknown> | null | undefined, k: string): string | null => {
  const v = o?.[k];
  return typeof v === 'string' && v !== '' ? v : null;
};

function holderOf(o: Record<string, unknown> | null | undefined): SessionHolder {
  return {
    posUserName: strOrNull(o, 'posUserName'),
    machineId: strOrNull(o, 'machineId'),
    machineName: strOrNull(o, 'machineName'),
    posNumber: strOrNull(o, 'posNumber'),
    since: strOrNull(o, 'since'),
    lastSeenAt: strOrNull(o, 'lastSeenAt'),
    silentSince: strOrNull(o, 'holderSilentSince'),
  };
}

/** The cloud's answer, read: `{"status": …}` on 2xx, FastAPI's `{"detail": {"code": …}}` or `{"detail": "code"}` on a refusal; a 5xx is no answer. */
export function sessionReplyOf(status: number, body: unknown): SessionReply {
  const root = body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
  if (status >= 200 && status < 300) {
    const took = root?.tookOver && typeof root.tookOver === 'object' ? (root.tookOver as Record<string, unknown>) : null;
    const warnings = Array.isArray(took?.warnings) ? (took!.warnings as unknown[]).filter((w): w is string => typeof w === 'string' && w.trim() !== '') : [];
    return { kind: 'ok', status: strOrNull(root, 'status') ?? 'ok', warnings };
  }
  if (status >= 500 || status === 0) return { kind: 'offline', reason: `HTTP ${status}` };
  const detail = root?.detail;
  const obj = detail && typeof detail === 'object' ? (detail as Record<string, unknown>) : null;
  const code = strOrNull(obj, 'code') ?? (typeof detail === 'string' ? detail : null);
  if (status === 409 && code === 'user_signed_in_elsewhere') {
    const d = strOrNull(obj, 'duplicate');
    return { kind: 'elsewhere', holder: holderOf(obj), duplicate: d === null ? null : d === 'signout' ? 'signout' : 'warn' };
  }
  if (status === 409 && code === 'user_session_released') {
    const now = obj?.now && typeof obj.now === 'object' ? holderOf(obj.now as Record<string, unknown>) : null;
    return { kind: 'released', byName: strOrNull(obj, 'releasedByName'), fromDashboard: obj?.fromDashboard === true, now, releasedBy: strOrNull(obj, 'releasedBy') };
  }
  if (status === 401) return { kind: 'needs_manager', code };
  if (status === 403) return { kind: 'manager_refused', code };
  return { kind: 'refused', status, code };
}

/* -------------------------------------------------------------- decisions */

/** What the sign-in does after the PIN was right. */
export type SignInDecision =
  /** In. The cloud recorded it, or the rule is off here. */
  | { kind: 'proceed' }
  /** In, unchecked: no answer. The heartbeat claims when the cloud is back. */
  | { kind: 'proceed_unchecked' }
  /** Stays out: signed in at another till. `viaHost`: the LAN host said so, the cloud not answering. */
  | { kind: 'blocked'; holder: SessionHolder; viaHost: boolean }
  /** A forced claim needs (another) manager's code. */
  | { kind: 'ask_manager' }
  /** The manager's approval was refused (not allowed here). */
  | { kind: 'approval_refused'; code: string | null }
  /** `manager`: neither the cloud nor the LAN host answered — in only on a manager's code (the roster's). */
  | { kind: 'manager_code' };

/** A sign-in's claim (forced or not) and what it answered. */
export function signInDecision(reply: SessionReply): SignInDecision {
  switch (reply.kind) {
    case 'ok':
      return { kind: 'proceed' };
    case 'elsewhere':
      return { kind: 'blocked', holder: reply.holder, viaHost: false };
    case 'needs_manager':
      return { kind: 'ask_manager' };
    case 'manager_refused':
      return { kind: 'approval_refused', code: reply.code };
    // Never locks the till: no answer, or an answer it cannot act on.
    case 'offline':
      return { kind: 'proceed_unchecked' };
    case 'refused':
    case 'released':
      return { kind: 'proceed' };
  }
}

/**
 * A sign-in under `mode` (v2 §4): the cloud's answer decides whenever there is one. Without it — `allow`: in, unchecked;
 * `lan`: the LAN host's answer (`host`, null with no host), and in unchecked when it gave none; `manager`: the host's answer,
 * and a manager's code when it gave none either.
 */
export function signInUnder(cloud: SessionReply, mode: OfflineMode, host: SessionReply | null): SignInDecision {
  if (cloud.kind !== 'offline') return signInDecision(cloud);
  const answered = host && host.kind !== 'offline' ? host : null;
  if (mode === 'allow') return { kind: 'proceed_unchecked' };
  if (answered) {
    const d = signInDecision(answered);
    return d.kind === 'blocked' ? { ...d, viaHost: true } : d;
  }
  if (mode === 'manager') return { kind: 'manager_code' };
  return { kind: 'proceed_unchecked' };
}

/** What a heartbeat's answer asks of the till. */
export type Beat =
  | { kind: 'fine' }
  /** Signed in at another till too (signed in here offline meanwhile): a warning, not a lock-out. */
  | { kind: 'warn'; holder: SessionHolder }
  /** A manager released this till's session: sign the employee out when nothing is in progress. */
  | { kind: 'sign_out'; released: Extract<SessionReply, { kind: 'released' }> }
  /** `signout`: signed in at another till too, found by this one (the later device): signs out when nothing is in progress. */
  | { kind: 'sign_out_duplicate'; holder: SessionHolder }
  /** No answer, or one to ignore: try again on the next beat. */
  | { kind: 'again' };

/** `duplicate`: the till's own parameter; the cloud's word in the answer wins. */
export function heartbeatBeat(reply: SessionReply, duplicate: DuplicateMode = 'warn'): Beat {
  switch (reply.kind) {
    case 'ok':
      return { kind: 'fine' };
    case 'elsewhere':
      return (reply.duplicate ?? duplicate) === 'signout' ? { kind: 'sign_out_duplicate', holder: reply.holder } : { kind: 'warn', holder: reply.holder };
    case 'released':
      return { kind: 'sign_out', released: reply };
    default:
      return { kind: 'again' };
  }
}

/** A release that got an answer is done; one that did not is kept and sent again. */
export const releaseDone = (reply: SessionReply): boolean => reply.kind !== 'offline';

/** How "שחרור באישור מנהל" goes. */
export type ReleaseRoute = 'own_authority' | 'own_authority_on_host' | 'manager_code' | 'manager_code_on_host';

export function releaseRoute(may: boolean, viaHost: boolean): ReleaseRoute {
  if (may && viaHost) return 'own_authority_on_host';
  if (may) return 'own_authority';
  if (viaHost) return 'manager_code_on_host';
  return 'manager_code';
}

/** "14:05" for a moment today, "03/10 14:05" for an earlier day — Israel's clock. Null for a missing or unreadable stamp. */
export function sinceLabel(iso: string | null | undefined, nowMs: number, timeZone = 'Asia/Jerusalem'): string | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  const parts = (ms: number) => {
    const f = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return { day: `${p.year}-${p.month}-${p.day}`, dm: `${p.day}/${p.month}`, hm: `${p.hour}:${p.minute}` };
  };
  const a = parts(at);
  const n = parts(nowMs);
  return a.day === n.day ? a.hm : `${a.dm} ${a.hm}`;
}

/** How the till is named in the message: its number and name, whichever the cloud gave (strings exclusive_login_till_*). */
export function tillLabel(h: SessionHolder): string {
  const number = h.posNumber?.trim() || null;
  const name = h.machineName?.trim() || null;
  if (number && name) return `קופה ${number} (${name})`;
  if (number) return `קופה ${number}`;
  if (name) return `קופה „${name}”`;
  return 'קופה אחרת';
}

/** Android's words (strings.xml exclusive_login_*, signed_in_*). */
export const EXCLUSIVE_TEXT = {
  title: 'מחובר/ת בקופה אחרת',
  blocked: (who: string, where: string, since: string | null) => (since ? `${who} מחובר/ת כרגע ב${where} מאז ${since}. יש להתנתק שם קודם.` : `${who} מחובר/ת כרגע ב${where}. יש להתנתק שם קודם.`),
  holderSilent: (since: string) => `המכשיר הקודם לא מדווח מאז ${since}.`,
  release: 'שחרור באישור מנהל',
  notPermitted: 'האישור לא מתיר שחרור עובד בקופה הזו',
  alsoElsewhere: (who: string, where: string, since: string) => `${who} מחובר/ת גם ב${where} (מאז ${since}). יש להתנתק שם.`,
  signingOut: (who: string) => `החיבור של ${who} שוחרר באישור מנהל. הקופה תתנתק בסיום הפעולה.`,
  signedOut: (who: string) => `${who} נותק/ה מקופה זו: החיבור שוחרר באישור מנהל.`,
  signedOutNow: (who: string, where: string) => `${who} נותק/ה מקופה זו: החיבור שוחרר באישור מנהל, ועכשיו מחובר/ת ב${where}.`,
  offlineManager: (who: string) => `אין תשובה מהענן. הכניסה של ${who} באישור מנהל.`,
  signingOutDuplicate: (who: string, where: string) => `${who} מחובר/ת גם ב${where}. הקופה תנתק את ${who} בסיום הפעולה.`,
  signedOutDuplicate: (who: string, where: string) => `${who} נותק/ה מקופה זו: מחובר/ת גם ב${where}.`,
  usersTitle: 'עובדים מחוברים',
  usersEmpty: 'אין עובדים מחוברים כרגע.',
  usersSince: (t: string) => `מאז ${t}`,
  usersSilent: (t: string) => `לא מדווח מאז ${t}`,
  usersTables: (n: number) => `שולחנות פתוחים: ${n}`,
  usersHere: 'המכשיר הזה',
  usersRelease: 'שחרור',
  usersCodeReason: 'כניסה ל"עובדים מחוברים" באישור מנהל',
  usersRefused: (why: string) => `אין גישה לרשימה (${why}).`,
  usersConfirm: (who: string, where: string) => `לשחרר את ${who} מ${where}?`,
  usersDone: (who: string) => `${who} שוחרר/ה. המכשיר ההוא ינתק בסיום הפעולה.`,
  usersNotHeld: (who: string) => `${who} כבר לא מחובר/ת.`,
  usersFailed: (why: string) => `השחרור לא הצליח (${why}).`,
  usersOffline: 'אין חיבור לענן או למארח המקומי. נסו שוב.',
} as const;
