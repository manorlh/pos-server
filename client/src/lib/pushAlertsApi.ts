/**
 * "התראות" — the API calls (pos-server app/routers/push_alerts.py) and subscribing this browser.
 * Types and pure rules live in `lib/pushAlerts.ts`.
 */
import { api } from './api';
import {
  urlBase64ToUint8Array,
  type AlertsFeed,
  type HistoryRow,
  type PushConfig,
  type PushDevice,
  type PushOptions,
  type PushPreferences,
} from './pushAlerts';
import { safeGet, safeSet, STOPPED_HERE_KEY } from './pushGate';
import { deviceIdFrom, retryableSubscribeError, sameKey, wantedKey, type TestResponse } from './pushDiagnosis';

export async function fetchPushConfig(): Promise<PushConfig> {
  const { data } = await api.get<PushConfig>('/push/config');
  return data;
}

export async function fetchPushDevices(): Promise<PushDevice[]> {
  const { data } = await api.get<{ devices: PushDevice[] }>('/push/devices');
  return data.devices;
}

export async function removePushDevice(id: string): Promise<void> {
  await api.delete(`/push/devices/${id}`);
}

/** A super admin: "שלמות נתונים" on one of their devices, on or off. */
export async function setDeviceIntegrity(id: string, integrity: boolean): Promise<PushDevice> {
  const { data } = await api.patch<PushDevice>(`/push/devices/${id}`, { integrity });
  return data;
}

export async function fetchPushPreferences(): Promise<PushPreferences> {
  const { data } = await api.get<PushPreferences>('/push/preferences');
  return data;
}

export async function savePushPreferences(body: Record<string, unknown>): Promise<PushPreferences> {
  const { data } = await api.put<PushPreferences>('/push/preferences', body);
  return data;
}

/** A test message to every device of mine (the phone gate's flow); how many it went to. */
export async function sendPushTest(): Promise<number> {
  return (await runPushTest('all', await currentEndpointHash().catch(() => null))).sent;
}

/**
 * "בדיקת התראות": a test message to this browser (`this`) or to all my devices, sent by the server
 * now — the answer has each push service's status (pos-server `POST /push/test`).
 */
export async function runPushTest(scope: 'this' | 'all', endpointHash: string | null): Promise<TestResponse> {
  const { data } = await api.post<TestResponse>('/push/test', { scope, endpointHash });
  return data;
}

export async function fetchPushOptions(): Promise<PushOptions> {
  const { data } = await api.get<PushOptions>('/push/options');
  return data;
}

export interface AlertsScope {
  companyId?: string | null;
  shopId?: string | null;
  areaId?: string | null;
  machineId?: string | null;
  eventId?: string | null;
}

export async function fetchAlertsFeed(scope: AlertsScope, opts: { open?: boolean; days?: number; limit?: number } = {}): Promise<AlertsFeed> {
  const params: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(scope)) if (v) params[k] = v;
  if (opts.open) params.open = true;
  if (opts.days) params.days = opts.days;
  if (opts.limit) params.limit = opts.limit;
  const { data } = await api.get<AlertsFeed>('/push/alerts', { params });
  return data;
}

export async function acknowledgeAlert(id: string, acknowledged = true, note?: string | null): Promise<void> {
  await api.post(`/push/alerts/${id}/ack`, { acknowledged, note: note ?? null });
}

export async function fetchPushHistory(limit = 50): Promise<HistoryRow[]> {
  const { data } = await api.get<{ history: HistoryRow[] }>('/push/history', { params: { limit } });
  return data.history;
}

// ── This browser ─────────────────────────────────────────────────────────────

const WORKER_TIMEOUT_MS = 10_000;

function localStore() {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, code: string): Promise<T> {
  return Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(code)), ms))]);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The dashboard's service worker (public/sw.js), registered now if it is not yet, once it is
 * active — never waiting forever (a worker that failed to install would hang `ready`): `sw_timeout`.
 */
export async function ensureWorker(): Promise<ServiceWorkerRegistration> {
  const reg =
    (await navigator.serviceWorker.getRegistration('/')) ??
    (await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }));
  if (reg.active) return reg;
  return withTimeout(navigator.serviceWorker.ready, WORKER_TIMEOUT_MS, 'sw_timeout');
}

/** This browser's own id for the server (one subscription per browser per user). */
export function thisDeviceId(): string | null {
  return deviceIdFrom(localStore(), () =>
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
  );
}

/**
 * Tell the worker the API and the server's key: its `pushsubscriptionchange` moves the device to a
 * new subscription by itself (sw.js). Best effort.
 */
export async function tellWorker(publicKey: string | null, reg?: ServiceWorkerRegistration | null): Promise<void> {
  try {
    const registration = reg ?? (await navigator.serviceWorker.getRegistration('/'));
    const worker = registration?.active;
    if (!worker) return;
    const apiBase = new URL(String(api.defaults.baseURL ?? ''), window.location.origin).href.replace(/\/+$/, '');
    worker.postMessage({ type: 'r2m-push-config', apiBase, publicKey });
  } catch {
    // The worker learns it on the next open.
  }
}

export type SubscribeOutcome = 'subscribed' | 'denied' | 'not_configured';

/**
 * Ask for permission, subscribe with the server's VAPID key, and register the device. `initial`
 * narrows the preferences the first device creates (the shop / event it was subscribed from).
 * `userId`: this person wants notifications in this browser — kept so a computer registers again
 * by itself after a sign-out (components/dashboard/push-gate/push-keeper.tsx).
 */
export async function subscribeThisBrowser(
  publicKey: string | null,
  initial: { shopIds?: string[]; eventIds?: string[] } = {},
  userId?: string | null,
): Promise<SubscribeOutcome> {
  if (!publicKey) return 'not_configured';
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return 'denied';
  await registerThisBrowser(publicKey, initial, userId);
  // Turned on again on purpose: the dashboard may keep it on from now (lib/pushGate.ts).
  safeSet(localStore(), STOPPED_HERE_KEY, null);
  return 'subscribed';
}

/**
 * "התראות בנייד" (pwa-push-required §2.4): the permission is there but the registration is not
 * (gone, rotated, failing) — subscribe and register again without asking anything. False when
 * there is no permission to do it with.
 */
export async function resubscribeThisBrowserSilently(publicKey: string | null, userId?: string | null): Promise<boolean> {
  if (!publicKey || typeof Notification === 'undefined' || Notification.permission !== 'granted') return false;
  await registerThisBrowser(publicKey, {}, userId);
  return true;
}

/** Subscribe, retrying what Edge's push service refuses now and then (lib/pushDiagnosis.ts). */
async function subscribeWithRetry(reg: ServiceWorkerRegistration, key: Uint8Array<ArrayBuffer>): Promise<PushSubscription> {
  const waits = [0, 800, 2500];
  let last: unknown = null;
  for (const wait of waits) {
    if (wait) await sleep(wait);
    try {
      return await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    } catch (err) {
      last = err;
      if (!retryableSubscribeError(err)) throw err;
    }
  }
  throw last;
}

/** Subscribe with the server's VAPID key (a subscription for another key is replaced) and register the device. */
async function registerThisBrowser(
  publicKey: string,
  initial: { shopIds?: string[]; eventIds?: string[] },
  userId?: string | null,
): Promise<void> {
  const reg = await ensureWorker();
  const want = urlBase64ToUint8Array(publicKey);
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub.options.applicationServerKey, want)) {
    // A subscription made for another key (keys rotated) cannot be used: replace it.
    await sub.unsubscribe();
    sub = null;
  }
  if (!sub) sub = await subscribeWithRetry(reg, want);
  const json = sub.toJSON();
  await api.post('/push/devices', { endpoint: json.endpoint, keys: json.keys, deviceId: thisDeviceId(), ...initial });
  if (userId) safeSet(localStore(), wantedKey(userId), '1');
  await tellWorker(publicKey, reg);
}

/** This browser's subscription endpoint, if it has one (to mark "this device" in the list). */
export async function currentEndpoint(): Promise<string | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  const reg = await navigator.serviceWorker.getRegistration('/');
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  return sub?.endpoint ?? null;
}

/** Whether this browser's subscription was made with `publicKey` (true when there is none to compare). */
export async function subscriptionKeyMatches(publicKey: string | null): Promise<boolean> {
  if (!publicKey || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return true;
  const reg = await navigator.serviceWorker.getRegistration('/');
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  return !sub || sameKey(sub.options.applicationServerKey, urlBase64ToUint8Array(publicKey));
}

/** Whether this person turned notifications on in this browser (and did not stop them here). */
export function wantedHere(userId: string | null | undefined): boolean {
  return !!userId && safeGet(localStore(), wantedKey(userId)) === '1';
}

/** Whether "הפסק כאן" was chosen on this browser. */
export function stoppedHere(): boolean {
  return safeGet(localStore(), STOPPED_HERE_KEY) === '1';
}

/**
 * Stop this browser. `byUser` ("הפסק כאן"): a choice — the dashboard does not silently turn it
 * back on (lib/pushGate.ts `stoppedHere`); a required user still sees the red bar.
 */
export async function unsubscribeThisBrowser(opts: { byUser?: boolean; userId?: string | null } = {}): Promise<void> {
  if (opts.byUser) {
    safeSet(localStore(), STOPPED_HERE_KEY, '1');
    if (opts.userId) safeSet(localStore(), wantedKey(opts.userId), null);
  }
  const reg = await navigator.serviceWorker.getRegistration('/');
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  if (!sub) return;
  await api.post('/push/devices/unsubscribe', { endpoint: sub.endpoint });
  await sub.unsubscribe();
}

/**
 * On sign-out: this browser stops receiving the person's alerts (a shared phone must not keep
 * showing them on its lock screen). Best effort and quick — never holds the sign-out up. Their
 * "wanted here" stays: signing in again on this browser turns it back on (push-keeper.tsx).
 */
export async function forgetThisBrowserOnSignOut(): Promise<void> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  await Promise.race([
    unsubscribeThisBrowser().catch(() => {}),
    new Promise<void>((resolve) => setTimeout(resolve, 3000)),
  ]);
}

/** SHA-256 hex of this browser's push endpoint (the server's `endpointHash`), or null. */
export async function currentEndpointHash(): Promise<string | null> {
  const endpoint = await currentEndpoint();
  if (!endpoint || typeof crypto === 'undefined' || !crypto.subtle) return null;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
