/**
 * Which build of the Windows app this is — the pure rules (P:/specs/windows7-till.md).
 *
 *  - `standard`: Electron 44, Windows 10/11, every role.
 *  - `win7`: the same code built on Electron 22 (Chromium 108, Node 16.17) for old PCs — Windows 7 / 8.1 x64,
 *    Celeron J1900, 4 GB. The owner (10.10.2026): Windows 7 runs ONLY the till. Any other role the cloud gives
 *    the device (a kiosk, a KDS, a board, a customer display, a cash host — or the kiosk mode of "מצב עבודה")
 *    is refused here: the device shows why and stays idle (no kiosk, no sales) until the dashboard makes it a
 *    till again or it is paired anew with a till code.
 *
 * Updates: the win7 build asks the cloud for the `windows7` platform (GET /sync/{m}/app-update?platform=windows7),
 * so it never receives a standard (Electron 44) installer that would not start on Windows 7. A win7 build on a
 * PC that was upgraded to Windows 10 or later asks for `windows` again and moves to the standard build (same
 * appId, same data folder).
 */

import type { AppRole } from '../shared/roles';

export type AppBuild = 'standard' | 'win7';

/** The esbuild define (`process.env.R2M_APP_BUILD`) → the build; anything else is the standard one. */
export function appBuildOf(raw: unknown): AppBuild {
  return typeof raw === 'string' && raw.trim().toLowerCase() === 'win7' ? 'win7' : 'standard';
}

/** The update platform each build asks for (server app/services/app_updates.py PLATFORMS). */
export type UpdatePlatform = 'windows' | 'windows7';

/** "6.1.7601" → 6; "10.0.19045" → 10; null when not a version. */
export function ntMajorOf(release: string | null | undefined): number | null {
  const m = /^\s*(\d+)\./.exec(release ?? '');
  return m ? Number(m[1]) : null;
}

/**
 * The platform the updater asks for. The standard build: always `windows`. The win7 build: `windows7` on
 * Windows 7 / 8 / 8.1 (NT 6.x) — and when the version cannot be read (never risk an Electron 44 installer on
 * Windows 7); `windows` on NT 10 and later (the PC was upgraded: the standard build runs there).
 */
export function updatePlatformOf(build: AppBuild, osRelease: string | null | undefined): UpdatePlatform {
  if (build !== 'win7') return 'windows';
  const major = ntMajorOf(osRelease);
  return major !== null && major >= 10 ? 'windows' : 'windows7';
}

/** The roles each build runs. */
export function rolesOf(build: AppBuild): readonly AppRole[] | 'all' {
  return build === 'win7' ? ['till'] : 'all';
}

export const WIN7_TILL_ONLY_TITLE = 'גרסת Windows 7 תומכת בקופה בלבד';
export const WIN7_TILL_ONLY_BODY =
  'המחשב הזה מריץ את גרסת Windows 7 של R2M POS, שבה פועלת רק הקופה. בדשבורד הוגדר לו תפקיד אחר — הגדירו אותו כקופה (מכשירים ← סוג מכשיר), או צמדו אותו מחדש עם קוד של קופה. קיוסק, מסך מטבח ומסכים אחרים דורשים Windows 10 ומעלה.';

/** Why a role does not run on this build (shown on the device as is), or null when it runs. */
export interface RoleLock {
  /** The role the cloud gave the device. */
  role: AppRole;
  title: string;
  message: string;
}

/**
 * The role the device opens in under this build: the win7 build opens only the till — another role is
 * locked (the device shows `lock` and runs nothing of it). Null (not known yet) is left as it is.
 */
export function applyBuildRoles(build: AppBuild, role: AppRole | null): { role: AppRole | null; lock: RoleLock | null } {
  const allowed = rolesOf(build);
  if (role === null || allowed === 'all' || allowed.includes(role)) return { role, lock: null };
  return { role: null, lock: { role, title: WIN7_TILL_ONLY_TITLE, message: WIN7_TILL_ONLY_BODY } };
}

/**
 * "סוג רישיון" as this build sees it: the win7 build is a till only whatever the cloud says, so the kiosk mode
 * of "מצב עבודה" never opens there (core/workMode.ts `workModeAllowed('till')` is false).
 */
export function licenseProductFor(build: AppBuild, cloud: unknown): unknown {
  return build === 'win7' ? 'till' : cloud;
}

/* ------------------------------------------------------------------ the GPU on old PCs */

/** kiosk.json `hardwareAcceleration`: "auto" (default), "on", "off". */
export type GpuSetting = 'auto' | 'on' | 'off';

export function gpuSettingOf(raw: unknown): GpuSetting {
  const s = typeof raw === 'string' ? raw.trim().toLowerCase() : typeof raw === 'boolean' ? (raw ? 'on' : 'off') : '';
  return s === 'on' || s === 'off' ? s : 'auto';
}

/** GPU process crashes are counted for this long; this many in the window turn the GPU off ("auto"). */
export const GPU_CRASH_WINDOW_MS = 24 * 60 * 60_000;
export const GPU_CRASHES_TO_DISABLE = 2;

/** The recorded crash times still inside the window (newest last, at most 10 kept). */
export function recentGpuCrashes(times: unknown, now: number): number[] {
  if (!Array.isArray(times)) return [];
  return times.filter((t): t is number => typeof t === 'number' && Number.isFinite(t) && t <= now && now - t < GPU_CRASH_WINDOW_MS).slice(-10);
}

export interface GpuDecision {
  /** `app.disableHardwareAcceleration()` before ready: software rendering. */
  disable: boolean;
  /** Chromium switches to add (the standard build's smooth-GPU pair, unless the build or the setting says otherwise). */
  switches: string[];
  /** Said in the log at start. */
  reason: string;
}

/**
 * How the window draws:
 *  - standard build: as always — GPU rasterization and the blocklist ignored — unless kiosk.json says "off".
 *  - win7 build, "auto": Chromium's own GPU blocklist decides (the Bay Trail / HD Graphics drivers of a J1900 on
 *    Windows 7 are often on it → software compositing, which is the safe path there); after
 *    {@link GPU_CRASHES_TO_DISABLE} GPU process crashes within a day, hardware acceleration is off altogether.
 *    "on" forces the standard pair; "off" is software rendering from the start.
 */
export function gpuDecision(o: { build: AppBuild; setting: GpuSetting; recentCrashes: number }): GpuDecision {
  const smooth = ['enable-gpu-rasterization', 'ignore-gpu-blocklist'];
  if (o.setting === 'off') return { disable: true, switches: [], reason: 'kiosk.json hardwareAcceleration=off' };
  if (o.build !== 'win7' || o.setting === 'on') return { disable: false, switches: smooth, reason: o.build === 'win7' ? 'kiosk.json hardwareAcceleration=on' : 'standard' };
  if (o.recentCrashes >= GPU_CRASHES_TO_DISABLE) return { disable: true, switches: [], reason: `${o.recentCrashes} GPU crashes in 24 h` };
  return { disable: false, switches: [], reason: 'win7 auto: Chromium blocklist decides' };
}
