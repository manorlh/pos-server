/**
 * "דף פתיחה": where a sign-in lands. Every sign-in (the Clerk redirect, `/`, the installed
 * app's start URL) goes to `/dashboard/start`, which sends the user to their opening page —
 * the control board unless they chose another in their profile. The choice is kept on the
 * server, on the user (`GET/PUT /users/me/preferences`; ids as pos-server
 * app/services/user_preferences.py `HOME_PAGES`), so it follows them to every device.
 *
 * The board is open to everyone signed in (it shows what they may see); another page is
 * used only when the user may open it — else the board.
 *
 * No React, no path aliases: `npm test` compiles this file on its own.
 */

import { canAccess, levelForPath, sectionForPath, type DashboardAccess } from './dashboardAccess';

export type HomePageId =
  | 'board'
  | 'compare'
  | 'live_items'
  | 'transactions'
  | 'shifts'
  | 'z_reports'
  | 'machines'
  | 'products';

export const DEFAULT_HOME_PAGE: HomePageId = 'board';

/** The opening pages offered in the profile, in order, and where each one is. */
export const HOME_PAGES: { id: HomePageId; href: string }[] = [
  { id: 'board', href: '/dashboard' },
  { id: 'compare', href: '/dashboard?view=compare' },
  { id: 'live_items', href: '/dashboard/live-items' },
  { id: 'transactions', href: '/dashboard/transactions' },
  { id: 'shifts', href: '/dashboard/shifts' },
  { id: 'z_reports', href: '/dashboard/z-reports' },
  { id: 'machines', href: '/dashboard/machines' },
  { id: 'products', href: '/dashboard/products' },
];

/** The landing route every sign-in goes through. */
export const LANDING_PATH = '/dashboard/start';

/** A stored value as one of ours; anything else (an older or newer server's) is the board. */
export function parseHomePage(raw: unknown): HomePageId {
  return HOME_PAGES.some((p) => p.id === raw) ? (raw as HomePageId) : DEFAULT_HOME_PAGE;
}

/** The page's path without its query. */
function pathOf(href: string): string {
  return href.split('?')[0];
}

/** Whether the user may open this opening page: its section at the page's level, and not hidden from the role. */
export function homePageAllowed(id: HomePageId, access: DashboardAccess, hiddenForRole: ReadonlySet<string> = new Set()): boolean {
  if (id === 'board') return true;
  const href = HOME_PAGES.find((p) => p.id === id)?.href ?? '/dashboard';
  // "השוואות" lives on the board but is a reports page (its own address is /dashboard/compare).
  const path = id === 'compare' ? '/dashboard/compare' : pathOf(href);
  if (hiddenForRole.has(path)) return false;
  const section = sectionForPath(path);
  return section === undefined || canAccess(access, section, levelForPath(path));
}

/** Where a sign-in lands for this user: their opening page if they may open it, else the board. */
export function landingTarget(raw: unknown, access: DashboardAccess, hiddenForRole: ReadonlySet<string> = new Set()): string {
  const id = parseHomePage(raw);
  if (!homePageAllowed(id, access, hiddenForRole)) return '/dashboard';
  return HOME_PAGES.find((p) => p.id === id)?.href ?? '/dashboard';
}
