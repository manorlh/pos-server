/**
 * "עדכוני גרסה" — the pure rules of the app-updates page (app/dashboard/app-updates),
 * for every platform: the Android till app (APK), the Windows app (installer) and the
 * kiosk web bundle (`kiosk_web`: a zip of the kiosk's screens, shown by the Android kiosk).
 *
 * Self-contained (no `@/` imports) so `npm test` compiles it on its own; the server's
 * twin is pos-server `app/services/app_updates.py` — keep the version-code rule, the
 * installer file-name rule and the install-window rule equal on both sides.
 */

export type AppPlatform = 'android' | 'windows' | 'kiosk_web';
export type PlatformFilter = 'all' | AppPlatform;

export const APP_PLATFORMS: readonly AppPlatform[] = ['android', 'windows', 'kiosk_web'];

/** A row's platform; rows from before there were two platforms are Android. */
export function platformOf(row: { platform?: string | null }): AppPlatform {
  if (row.platform === 'windows') return 'windows';
  if (row.platform === 'kiosk_web') return 'kiosk_web';
  return 'android';
}

/**
 * Whether an assignment of this platform may roll a device back to a lower versionCode
 * (`allowDowngrade`): the Windows app and kiosk web bundles; never Android (the server's
 * `DOWNGRADE_PLATFORMS`).
 */
export function allowsDowngrade(platform: AppPlatform | null | undefined): boolean {
  return platform === 'windows' || platform === 'kiosk_web';
}

/** Why a kiosk shows its built-in screens although web is configured — the reasons it reports. */
export const FALLBACK_REASONS = ['ready_timeout', 'render_gone', 'js_errors', 'no_bundle', 'bridge_api', 'load_error'] as const;
export type FallbackReason = (typeof FALLBACK_REASONS)[number];

/** A reported fallback reason the page has a text for, else null (show the raw token). */
export function knownFallbackReason(reason: string | null | undefined): FallbackReason | null {
  return (FALLBACK_REASONS as readonly string[]).includes(reason ?? '') ? (reason as FallbackReason) : null;
}

/**
 * A rollout row's React key: a kiosk has an Android row and a kiosk_web row of the same
 * machine in the "all" view.
 */
export function rolloutRowKey(row: { machineId: string; platform?: string | null }): string {
  return `${row.machineId}:${platformOf(row)}`;
}

/** The rows of one platform, or every row for "all". */
export function filterByPlatform<T extends { platform?: string | null }>(rows: readonly T[], filter: PlatformFilter): T[] {
  return filter === 'all' ? [...rows] : rows.filter((r) => platformOf(r) === filter);
}

/** Per platform, how many devices are behind their assigned target. */
export function behindCounts(rows: readonly { platform?: string | null; behind?: boolean | null }[]): Record<AppPlatform, number> {
  const out: Record<AppPlatform, number> = { android: 0, windows: 0, kiosk_web: 0 };
  for (const r of rows) if (r.behind) out[platformOf(r)] += 1;
  return out;
}

/** The rollout table's "only devices that are behind" filter. */
export function onlyBehind<T extends { behind?: boolean | null }>(rows: readonly T[], on: boolean): T[] {
  return on ? rows.filter((r) => !!r.behind) : [...rows];
}

/** A typed rollout percent: a whole number 1..100, else null. Empty means the default, 100. */
export function parseRolloutPercent(text: string): number | null {
  const t = text.trim();
  if (t === '') return 100;
  if (!/^[0-9]{1,3}$/.test(t)) return null;
  const n = Number(t);
  return n >= 1 && n <= 100 ? n : null;
}

const WINDOWS_VERSION = /^\s*(\d+)\.(\d+)\.(\d+)(?:[-+].*)?\s*$/;
const INT32_MAX = 2_147_483_647;

/**
 * The Windows app's versionCode — the same rule as the server and the app's updater:
 * "a.b.c" (any "-pre" / "+build" suffix ignored) → a·1 000 000 + b·1 000 + c.
 * Null for a name that is not "a.b.c", b or c above 999, or out of range.
 */
export function windowsVersionCode(versionName: string): number | null {
  const m = WINDOWS_VERSION.exec(versionName ?? '');
  if (!m) return null;
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (minor > 999 || patch > 999) return null;
  const code = major * 1_000_000 + minor * 1_000 + patch;
  return code >= 1 && code <= INT32_MAX ? code : null;
}

const INSTALLER_NAME = /[-_ ](\d+\.\d+\.\d+)-setup\.exe$/i;

/** `R2M-Kiosk-0.2.0-setup.exe` → "0.2.0"; null when the file name carries no version. */
export function versionFromInstallerName(fileName: string | null | undefined): string | null {
  const m = INSTALLER_NAME.exec((fileName ?? '').trim());
  return m ? m[1] : null;
}

/**
 * The platform a chosen file looks like: an .exe is a Windows installer, an .apk an Android
 * build, a .zip a kiosk web bundle; else null (keep the choice).
 */
export function platformOfFile(fileName: string | null | undefined): AppPlatform | null {
  const name = (fileName ?? '').trim().toLowerCase();
  if (name.endsWith('.exe')) return 'windows';
  if (name.endsWith('.apk')) return 'android';
  if (name.endsWith('.zip')) return 'kiosk_web';
  return null;
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export type InstallWindowCheck =
  | { ok: true; window: { start: string; end: string } | null }
  | { ok: false };

/**
 * An install window as the server takes it: both ends "HH:MM" (it may cross midnight,
 * 22:00–05:00) or neither; one without the other, a malformed time or an empty window
 * (start = end) is refused.
 */
export function checkInstallWindow(start: string, end: string): InstallWindowCheck {
  const s = (start ?? '').trim();
  const e = (end ?? '').trim();
  if (!s && !e) return { ok: true, window: null };
  if (!s || !e || !HHMM.test(s) || !HHMM.test(e) || s === e) return { ok: false };
  return { ok: true, window: { start: s, end: e } };
}
