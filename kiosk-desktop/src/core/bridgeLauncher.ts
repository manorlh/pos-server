/**
 * "פתיחה בהפעלה" (docs/SPEC_KIOSK.md §28.6): after Windows starts, the bridge opens Chrome or Edge
 * in kiosk mode on this device's page (the browser kiosk `/k`, a KDS or the "מוכן / לא מוכן" board),
 * in a profile of its own, and opens it again when it is closed — until a technician leaves kiosk
 * mode with the code. Pure: the paths, the arguments, the address and the back-off.
 */

import { normalizeOrigin, type BridgeRole } from './bridgeProtocol';

export type BrowserChoice = 'auto' | 'edge' | 'chrome';
export type BrowserKind = 'edge' | 'chrome';

export interface LauncherSettings {
  enabled: boolean;
  browser: BrowserChoice;
  /** The page to open (the paired page's own address, or one typed in the bridge's window). */
  url: string | null;
  role: BridgeRole;
}

export const DEFAULT_LAUNCHER: LauncherSettings = { enabled: false, browser: 'auto', url: null, role: 'kiosk' };

/** The dashboard's page per role (the browser kiosk is `/k`; a page that paired tells its own). */
export const ROLE_PATHS: Record<BridgeRole, string> = { kiosk: '/k', kds: '/kds', order_status_board: '/board' };

export interface WinEnv {
  programFiles?: string | null;
  programFilesX86?: string | null;
  localAppData?: string | null;
}

/** The usual install places of Edge and Chrome (per machine and per user). */
export function browserCandidates(env: WinEnv): Record<BrowserKind, string[]> {
  const roots = [env.programFilesX86, env.programFiles, env.localAppData].filter((r): r is string => !!r && r.trim().length > 0);
  const join = (root: string, rest: string) => `${root.replace(/[\\/]+$/, '')}\\${rest}`;
  return {
    edge: roots.map((r) => join(r, 'Microsoft\\Edge\\Application\\msedge.exe')),
    chrome: [env.programFiles, env.programFilesX86, env.localAppData].filter((r): r is string => !!r && r.trim().length > 0).map((r) => join(r, 'Google\\Chrome\\Application\\chrome.exe')),
  };
}

/** The browser to open: the chosen one, or for "auto" Chrome when installed, else Edge (always on Windows 10/11). */
export function pickBrowser(choice: BrowserChoice, env: WinEnv, exists: (path: string) => boolean): { kind: BrowserKind; exe: string } | null {
  const c = browserCandidates(env);
  const first = (kind: BrowserKind) => {
    const exe = c[kind].find(exists);
    return exe ? { kind, exe } : null;
  };
  if (choice === 'edge') return first('edge');
  if (choice === 'chrome') return first('chrome');
  return first('chrome') ?? first('edge');
}

/** The browser's command line: kiosk mode, its own profile, no first-run screens. */
export function browserArgs(kind: BrowserKind, url: string, profileDir: string): string[] {
  const common = [
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-session-crashed-bubble',
    '--disable-features=TranslateUI',
    '--autoplay-policy=no-user-gesture-required',
    '--kiosk',
  ];
  // Edge's documented kiosk switch; both open the page as an app window, full screen.
  return kind === 'edge' ? [...common, '--edge-kiosk-type=fullscreen', `--app=${url}`] : [...common, `--app=${url}`];
}

/** The role's page on the dashboard: `https://dash.example` + `/k`. */
export function urlForRole(dashboard: string, role: BridgeRole): string | null {
  const origin = normalizeOrigin(dashboard);
  return origin ? `${origin}${ROLE_PATHS[role]}` : null;
}

/** An address the launcher may open: http(s), on one of the bridge's allowed origins, no credentials in it. */
export function launchable(url: unknown, allowed: readonly string[]): string | null {
  if (typeof url !== 'string' || !url.trim()) return null;
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  const origin = normalizeOrigin(u.origin);
  if (!origin || !allowed.includes(origin) || u.username || u.password) return null;
  u.hash = '';
  return u.toString();
}

/**
 * A link pasted from the dashboard ("הוספת מכשיר": `https://dash/k#pair=AB12CD34`): the page to
 * open (without the fragment), the cloud's pairing code in it, and the role its path names.
 */
export function parseDashboardLink(raw: string): { url: string; pairCode: string | null; role: BridgeRole | null } | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const pair = /(?:^#|&)pair=([A-Za-z0-9-]{4,16})/.exec(u.hash)?.[1]?.toUpperCase().replace(/-/g, '') ?? null;
  u.hash = '';
  const path = u.pathname.replace(/\/+$/, '') || '/';
  const role = (Object.entries(ROLE_PATHS) as Array<[BridgeRole, string]>).find(([, p]) => path === p)?.[0] ?? null;
  return { url: u.toString(), pairCode: pair, role };
}

/**
 * The address the browser is opened on: the page, and in its fragment (never sent to a server)
 * the bridge's one-time code when no page is paired yet, and the cloud's pairing code once.
 */
export function launchUrl(url: string, opts: { bridgeCode?: string | null; pairCode?: string | null } = {}): string {
  const parts: string[] = [];
  if (opts.pairCode) parts.push(`pair=${encodeURIComponent(opts.pairCode)}`);
  if (opts.bridgeCode) parts.push(`bridge=${encodeURIComponent(opts.bridgeCode)}`);
  const base = url.split('#')[0];
  return parts.length > 0 ? `${base}#${parts.join('&')}` : base;
}

/** A browser that closed within this long of being opened did not really start (or was closed at once). */
export const QUICK_EXIT_MS = 15_000;

/** How long to wait before opening it again: a few seconds, longer when it keeps closing at once. */
export function relaunchDelayMs(quickExitsInARow: number): number {
  if (quickExitsInARow <= 0) return 3_000;
  if (quickExitsInARow === 1) return 5_000;
  if (quickExitsInARow === 2) return 10_000;
  return 60_000;
}

export type LauncherPhase = 'off' | 'no_url' | 'no_browser' | 'starting' | 'running' | 'waiting' | 'paused';

export const LAUNCHER_TEXT: Record<LauncherPhase, string> = {
  off: 'כבוי',
  no_url: 'לא נקבעה כתובת לפתיחה',
  no_browser: 'לא נמצא Chrome או Edge במחשב',
  starting: 'פותח את הדפדפן…',
  running: 'הדפדפן פתוח במצב קיוסק',
  waiting: 'הדפדפן נסגר — נפתח שוב בעוד רגע',
  paused: 'יצאו ממצב קיוסק (עד ההפעלה הבאה או "פתח עכשיו")',
};
