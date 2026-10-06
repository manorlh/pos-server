/**
 * When the Windows app takes an update — the pure rules (main/update/updater.ts runs them).
 *
 *  - The cloud offers (GET /sync/{m}/app-update?platform=windows) the release assigned to this
 *    machine (machine → area → shop → company → tenant, staged by percent); only a Windows offer
 *    with an id and a SHA-256 is taken, and never a lower version unless the assignment is a
 *    rollback (`allowDowngrade`).
 *  - It downloads by itself, in the background; the file must hash to the cloud's SHA-256.
 *  - It installs by itself only when the assignment says `autoInstall`, and only when the device
 *    is quiet: never while an order or a payment is open (kiosk: on the attract / closed screens,
 *    nothing in flight, no payment waiting to be settled; KDS: nobody touched it lately), and —
 *    when the assignment (or kiosk.json) gives a window — only inside it ("02:00–05:00").
 *  - "התקן עכשיו" (technician) skips the window and the quiet time, never the payment rule.
 */

import type { AppRole } from '../shared/roles';

export interface UpdateOffer {
  available: boolean;
  releaseId: string | null;
  versionCode: number | null;
  versionName: string | null;
  sha256: string | null;
  sizeBytes: number | null;
  notes?: string | null;
  autoInstall: boolean;
  platform?: string | null;
  allowDowngrade?: boolean;
  rolloutPercent?: number | null;
  installWindow?: { start: string; end: string } | null;
}

/** "1.2.3" (any "+build" / "-pre" suffix ignored) → 1002003; the cloud computes the same. */
export function versionCodeOf(version: string): number {
  const [a, b, c] = version
    .split(/[+-]/)[0]
    .split('.')
    .map((x) => Number.parseInt(x, 10) || 0);
  return (a ?? 0) * 1_000_000 + (b ?? 0) * 1_000 + (c ?? 0);
}

/** b is a later version than a. */
export function newer(a: string, b: string): boolean {
  return versionCodeOf(b) > versionCodeOf(a);
}

const HEX64 = /^[0-9a-f]{64}$/i;

/** Only a Windows release is for this app; never the version it runs; never lower unless a rollback. */
export function acceptOffer(o: UpdateOffer | null | undefined, currentVersion: string): boolean {
  if (!o || !o.available || o.platform !== 'windows' || !o.releaseId || !o.versionName || !o.sha256 || !HEX64.test(o.sha256)) return false;
  if (o.versionName === currentVersion) return false;
  const code = o.versionCode ?? versionCodeOf(o.versionName);
  if (code < versionCodeOf(currentVersion) && o.allowDowngrade !== true) return false;
  return true;
}

/** Whether a downloaded file is the release: same SHA-256 (hex, any case) and, when given, size. */
export function verifies(expected: { sha256: string; sizeBytes?: number | null }, actual: { sha256: string; sizeBytes: number }): boolean {
  if (!HEX64.test(expected.sha256) || expected.sha256.toLowerCase() !== actual.sha256.toLowerCase()) return false;
  if (typeof expected.sizeBytes === 'number' && expected.sizeBytes > 0 && expected.sizeBytes !== actual.sizeBytes) return false;
  return true;
}

/** "HH:MM" → minutes after midnight, or null. */
export function minutesOf(hhmm: string | null | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec((hhmm ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? h * 60 + min : null;
}

/** "02:00-05:00" (kiosk.json) → a window, or null. */
export function parseWindow(s: string | null | undefined): { start: string; end: string } | null {
  const m = /^\s*(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})\s*$/.exec(s ?? '');
  if (!m || minutesOf(m[1]) === null || minutesOf(m[2]) === null) return null;
  return { start: m[1], end: m[2] };
}

/** Local time inside [start, end); a window may cross midnight (23:00–04:00). Equal ends = never. */
export function inWindow(now: Date, w: { start: string; end: string }): boolean {
  const s = minutesOf(w.start);
  const e = minutesOf(w.end);
  if (s === null || e === null || s === e) return false;
  const t = now.getHours() * 60 + now.getMinutes();
  return s < e ? t >= s && t < e : t >= s || t < e;
}

/** What the device is doing, as the role reports it. */
export interface Activity {
  role: AppRole | null;
  /** The kiosk's screen (attract, catalog, pay, success, closed…); '' for other roles. */
  screen: string;
  /** A payment holds the kiosk (starting / charging / unknown). */
  busy: boolean;
  /** Nobody is ordering (not service/catalog/cart/details/pay/success). */
  idle: boolean;
  /** A card request is out at the terminal right now. */
  cardInFlight: boolean;
  /** A charge whose outcome is unknown waits for staff. */
  cardBlocked: boolean;
  /** Epoch ms of the last touch / screen change (null: never). */
  lastActivityAt: number | null;
}

/** Screens of an order in progress (kiosk): never restart under them. */
const ORDER_SCREENS = new Set(['service', 'catalog', 'cart', 'confirm', 'details', 'pay', 'success']);

/** The one rule nothing overrides: not during an order or a payment. A refusal reason in Hebrew, or null. */
export function paymentGuard(a: Activity): string | null {
  if (a.cardInFlight || a.busy || a.screen === 'pay' || a.screen === 'success') return 'לא בזמן תשלום';
  if (ORDER_SCREENS.has(a.screen) || (a.role === 'kiosk' && !a.idle)) return 'יש הזמנה פתוחה';
  return null;
}

/** How long the device must be quiet before an automatic install. */
export const QUIET_MS: Record<AppRole | 'unknown', number> = {
  kiosk: 60_000,
  till: 5 * 60_000,
  kds: 3 * 60_000,
  order_status_board: 0,
  customer_display: 0,
  unknown: 60_000,
};

export type AutoDecision = { install: true } | { install: false; wait: string };

/** Whether an automatic install may run now (the release is downloaded and verified). */
export function autoInstallDecision(input: {
  offer: Pick<UpdateOffer, 'autoInstall' | 'installWindow'>;
  /** kiosk.json's window, used when the assignment gives none. */
  localWindow?: { start: string; end: string } | null;
  activity: Activity;
  now: Date;
}): AutoDecision {
  if (!input.offer.autoInstall) return { install: false, wait: 'ממתין להתקנה ידנית ("התקן עכשיו")' };
  const guard = paymentGuard(input.activity);
  if (guard) return { install: false, wait: guard };
  if (input.activity.cardBlocked) return { install: false, wait: 'תשלום ממתין לבירור' };
  const window = input.offer.installWindow ?? input.localWindow ?? null;
  if (window && !inWindow(input.now, window)) return { install: false, wait: `ממתין לחלון ההתקנה ${window.start}–${window.end}` };
  const quiet = QUIET_MS[input.activity.role ?? 'unknown'];
  const last = input.activity.lastActivityAt;
  if (quiet > 0 && last !== null && input.now.getTime() - last < quiet) return { install: false, wait: 'ממתין שהמכשיר יהיה פנוי' };
  return { install: true };
}

/** "התקן עכשיו": only the payment rule. */
export function manualInstallDecision(activity: Activity): AutoDecision {
  const guard = paymentGuard(activity);
  return guard ? { install: false, wait: guard } : { install: true };
}

/** Back-off after failed downloads of the same release: 1, 2, 4… minutes, at most an hour. */
export function retryDelayMs(failures: number): number {
  if (failures <= 0) return 0;
  return Math.min(60 * 60_000, 60_000 * 2 ** Math.min(10, failures - 1));
}
