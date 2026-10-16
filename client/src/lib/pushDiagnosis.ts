/**
 * "בדיקת התראות" (fix/pwa-push) — the pure rules of the notifications check and of keeping this
 * browser registered: the steps (browser → permission → service worker → subscription saved on the
 * server → the server's send → arrived here → "קיבלת?"), what each push service answer means, the
 * tips per platform, this browser's own id, and when a computer re-registers by itself.
 *
 * Pure (no React, no network, no browser globals, relative imports only) so `npm test` runs it
 * with node:test; components/dashboard/event-live/push-diagnosis.tsx gathers the facts.
 */

import { type KeyValueStore, safeGet, safeSet } from './pushGate';

// ── The steps ────────────────────────────────────────────────────────────────

export type DiagStepId = 'support' | 'permission' | 'worker' | 'subscription' | 'server' | 'arrived';
export type DiagState = 'pending' | 'running' | 'ok' | 'warn' | 'fail' | 'skipped';

export interface DiagStep {
  id: DiagStepId;
  state: DiagState;
  /** The message key under `phoneAlerts.diag.<step>.` that says what happened here. */
  note?: string;
  /** Values for the note (a status code, a push service, seconds). */
  values?: Record<string, string | number>;
}

export const DIAG_STEPS: DiagStepId[] = ['support', 'permission', 'worker', 'subscription', 'server', 'arrived'];

export function initialSteps(): DiagStep[] {
  return DIAG_STEPS.map((id) => ({ id, state: 'pending' as DiagState }));
}

/** The steps with one changed (and every later one still pending when it failed: skipped). */
export function setStep(steps: DiagStep[], id: DiagStepId, patch: Omit<DiagStep, 'id'>): DiagStep[] {
  const at = DIAG_STEPS.indexOf(id);
  return steps.map((s) => {
    if (s.id === id) return { id, ...patch };
    if (patch.state === 'fail' && DIAG_STEPS.indexOf(s.id) > at && s.state === 'pending') return { ...s, state: 'skipped' };
    return s;
  });
}

/** Where the check stopped: the first failed step, or null. */
export function firstFailure(steps: DiagStep[]): DiagStepId | null {
  return steps.find((s) => s.state === 'fail')?.id ?? null;
}

// ── The server's send ────────────────────────────────────────────────────────

export interface TestResult {
  deviceId: string;
  label: string | null;
  service: PushService;
  thisDevice: boolean;
  ok: boolean;
  status: number | null;
  error: string | null;
  detail: string | null;
  gone: boolean;
}

export interface TestResponse {
  sent: number;
  delivered: number;
  testId: string;
  results: TestResult[];
}

export type PushService = 'fcm' | 'wns' | 'mozilla' | 'apple' | 'other';

/** The push service by name, for the person ("Google (FCM)"). */
export const SERVICE_NAMES: Record<PushService, string> = {
  fcm: 'Google (FCM)',
  wns: 'Microsoft (WNS)',
  mozilla: 'Mozilla',
  apple: 'Apple',
  other: 'שירות ההתראות',
};

export function serviceName(service: string | null | undefined): string {
  return SERVICE_NAMES[(service as PushService) in SERVICE_NAMES ? (service as PushService) : 'other'];
}

/**
 * One device's answer → the step's state and the message key under `phoneAlerts.diag.server.`.
 * A gone subscription and a key mismatch are fixed by registering again (`fixable`).
 */
export function serverOutcome(r: Pick<TestResult, 'ok' | 'status' | 'error' | 'gone'>): {
  state: DiagState;
  note: string;
  fixable: boolean;
} {
  if (r.ok) return { state: 'ok', note: 'accepted', fixable: false };
  if (r.gone || r.status === 404 || r.status === 410) return { state: 'fail', note: 'gone', fixable: true };
  if (r.status === 401 || r.status === 403) return { state: 'fail', note: 'keyMismatch', fixable: true };
  if (r.status === 400) return { state: 'fail', note: 'badRequest', fixable: true };
  if (r.status === 413) return { state: 'fail', note: 'tooLarge', fixable: false };
  if (r.status === 429) return { state: 'warn', note: 'serviceBusy', fixable: false };
  if (typeof r.status === 'number' && r.status >= 500) return { state: 'warn', note: 'serviceDown', fixable: false };
  if (r.error === 'push_not_configured') return { state: 'fail', note: 'notConfigured', fixable: false };
  if (r.error === 'sending_off') return { state: 'fail', note: 'sendingOff', fixable: false };
  return { state: 'fail', note: 'unreachable', fixable: false };
}

/**
 * The server's key problem (`GET /push/config` `problem`) → the message key under
 * `phoneAlerts.diag.config.`, and whether push is off because of it.
 */
export function configProblem(problem: string | null | undefined): { note: string; blocking: boolean } | null {
  switch (problem) {
    case 'missing_private_key':
    case 'private_key_unreadable':
      return { note: problem === 'missing_private_key' ? 'missingKey' : 'unreadableKey', blocking: true };
    case 'public_key_mismatch':
      return { note: 'publicMismatch', blocking: false };
    case 'subject_localhost':
      return { note: 'subject', blocking: false };
    default:
      return null;
  }
}

// ── The platform's tips ──────────────────────────────────────────────────────

export type TipsPlatform = 'windows' | 'android' | 'ios' | 'mac' | 'linux' | 'other';

export function tipsPlatform(userAgent: string, maxTouchPoints = 0): TipsPlatform {
  const ua = userAgent || '';
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  if (/Windows/.test(ua)) return 'windows';
  if (/Macintosh|Mac OS X/.test(ua)) return 'mac';
  if (/Linux|CrOS/.test(ua)) return 'linux';
  return 'other';
}

export function browserName(userAgent: string): string | null {
  const ua = userAgent || '';
  if (/Edg(A|iOS)?\//.test(ua)) return 'Edge';
  if (/SamsungBrowser\//.test(ua)) return 'Samsung Internet';
  if (/OPR\//.test(ua)) return 'Opera';
  if (/Firefox\/|FxiOS\//.test(ua)) return 'Firefox';
  if (/Chrome\/|CriOS\//.test(ua)) return 'Chrome';
  if (/Safari\//.test(ua)) return 'Safari';
  return null;
}

/**
 * "לא הופיעה" — what to check on this platform (message keys under `phoneAlerts.diag.tips.`), the
 * most likely first. `arrived`: the worker reported the message reached this browser — then it is
 * the system (or the browser's own setting) that hid it, never the server.
 */
export function tipsFor(platform: TipsPlatform, f: { standalone: boolean; arrived: boolean }): string[] {
  const out: string[] = [];
  if (f.arrived) out.push('arrivedHidden');
  switch (platform) {
    case 'windows':
      out.push('winFocus', 'winSystem', 'winSite', 'winBackground');
      break;
    case 'android':
      if (!f.standalone) out.push('androidInstall');
      out.push('androidChannel', 'androidBattery', 'androidDnd');
      break;
    case 'ios':
      out.push(f.standalone ? 'iosSettings' : 'iosInstall', 'iosFocus');
      break;
    case 'mac':
      out.push('macSystem', 'macFocus', 'winSite');
      break;
    default:
      out.push('otherSystem', 'winSite');
  }
  if (!f.arrived) out.push('network');
  return out;
}

// ── This browser ─────────────────────────────────────────────────────────────

/** This browser's own random id (localStorage): the server keeps one subscription per browser per user. */
export const DEVICE_ID_KEY = 'r2m.push.deviceId';
const DEVICE_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** The stored id, or a new one saved now (null when nothing can be stored: the server then goes by endpoint). */
export function deviceIdFrom(store: KeyValueStore | null, makeId: () => string): string | null {
  const existing = safeGet(store, DEVICE_ID_KEY);
  if (existing && DEVICE_ID.test(existing)) return existing;
  if (!store) return null;
  const id = makeId().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  if (!DEVICE_ID.test(id)) return null;
  safeSet(store, DEVICE_ID_KEY, id);
  return safeGet(store, DEVICE_ID_KEY) === id ? id : null;
}

/** "This person turned notifications on in this browser" — kept across a sign-out, cleared by "הפסק כאן". */
export function wantedKey(userId: string): string {
  return `r2m.push.wanted.${userId}`;
}

/** Two applicationServerKeys, byte by byte (a subscription made for another key cannot be used). */
export function sameKey(a: ArrayBuffer | ArrayBufferView | null | undefined, b: Uint8Array): boolean {
  if (!a) return false;
  const bytes = a instanceof ArrayBuffer ? new Uint8Array(a) : new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  return bytes.length === b.length && bytes.every((x, i) => x === b[i]);
}

/**
 * Whether `pushManager.subscribe` is worth another try: Edge's WNS answers "AbortError:
 * Registration failed - push service error" now and then (seen with Edge 155 on Windows 11), and
 * a second try a moment later works.
 */
export function retryableSubscribeError(err: unknown): boolean {
  const e = err as { name?: string; message?: string } | null;
  if (!e) return false;
  if (e.name === 'AbortError') return true;
  return /push service (error|not available)/i.test(e.message ?? '');
}

export interface KeeperFacts {
  configured: boolean;
  supported: boolean;
  permission: 'default' | 'granted' | 'denied' | 'unsupported';
  /** This person turned notifications on in this browser before (`wantedKey`). */
  wanted: boolean;
  /** The browser holds a push subscription. */
  hasSubscription: boolean;
  /** The server knows this subscription as one of my active devices (failing or not). */
  registered: boolean;
  /** Failing since its last success (the server's `thisDevice.failing`). */
  failing: boolean;
  /** The subscription was made with the server's current key. */
  keyMatches: boolean;
  /** "הפסק כאן" on this browser. */
  stoppedHere: boolean;
  /** Already tried on this open. */
  tried: boolean;
}

/**
 * A computer (and a tablet the gate treats as one) re-registers silently — the gate does this for
 * phones only — when the permission is there and the server lost the device (gone after a sign-out,
 * 404 / 410, replaced), it keeps failing, or the server's key changed. Only for this person: they
 * turned notifications on in this browser (`wanted`), or the server already knows this browser's
 * subscription as theirs — never someone else's subscription moved to whoever signed in. Never
 * asks anything.
 */
export function keeperShouldResubscribe(f: KeeperFacts): boolean {
  if (!f.configured || !f.supported || f.permission !== 'granted' || f.stoppedHere || f.tried) return false;
  if (!f.wanted && !(f.hasSubscription && f.registered)) return false;
  return !f.hasSubscription || !f.registered || f.failing || !f.keyMatches;
}
