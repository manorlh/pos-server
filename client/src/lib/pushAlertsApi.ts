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

export async function fetchPushPreferences(): Promise<PushPreferences> {
  const { data } = await api.get<PushPreferences>('/push/preferences');
  return data;
}

export async function savePushPreferences(body: Record<string, unknown>): Promise<PushPreferences> {
  const { data } = await api.put<PushPreferences>('/push/preferences', body);
  return data;
}

export async function sendPushTest(): Promise<number> {
  const { data } = await api.post<{ sent: number }>('/push/test');
  return data.sent;
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

/** The dashboard's service worker (public/sw.js), registered now if it is not yet. */
async function serviceWorker(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration('/');
  if (existing) return existing;
  return navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });
}

export type SubscribeOutcome = 'subscribed' | 'denied' | 'not_configured';

/**
 * Ask for permission, subscribe with the server's VAPID key, and register the device. `initial`
 * narrows the preferences the first device creates (the shop / event it was subscribed from).
 */
export async function subscribeThisBrowser(
  publicKey: string | null,
  initial: { shopIds?: string[]; eventIds?: string[] } = {},
): Promise<SubscribeOutcome> {
  if (!publicKey) return 'not_configured';
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return 'denied';
  const reg = await serviceWorker();
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (sub) {
    // A subscription made for another key (keys rotated) cannot be used: replace it.
    const key = sub.options.applicationServerKey;
    const want = urlBase64ToUint8Array(publicKey);
    const same = key && new Uint8Array(key).every((b, i) => b === want[i]) && new Uint8Array(key).length === want.length;
    if (!same) {
      await sub.unsubscribe();
      sub = null;
    }
  }
  if (!sub) {
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
  }
  const json = sub.toJSON();
  await api.post('/push/devices', { endpoint: json.endpoint, keys: json.keys, ...initial });
  return 'subscribed';
}

/** This browser's subscription endpoint, if it has one (to mark "this device" in the list). */
export async function currentEndpoint(): Promise<string | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  const reg = await navigator.serviceWorker.getRegistration('/');
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  return sub?.endpoint ?? null;
}

export async function unsubscribeThisBrowser(): Promise<void> {
  const reg = await navigator.serviceWorker.getRegistration('/');
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  if (!sub) return;
  await api.post('/push/devices/unsubscribe', { endpoint: sub.endpoint });
  await sub.unsubscribe();
}

/**
 * On sign-out: this browser stops receiving the person's alerts (a shared phone must not keep
 * showing them on its lock screen). Best effort and quick — never holds the sign-out up.
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
