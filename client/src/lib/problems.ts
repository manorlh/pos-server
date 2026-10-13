/**
 * "בעיות" — one screen of what needs a manager now (pos-server `GET /problems`,
 * app/services/problems.py; P:/specs/manager-problems.md §3, §6): the types and the pure rules —
 * who may open the screen, the groups' order, hiding a group (and what the counts become), the
 * card a push alert names (`?focus=`), and which route "טופל" goes through.
 *
 * Pure (no React, no network, relative imports only) so `npm test` runs it with node:test.
 */

import { navHrefAllowed, type DashboardAccess } from './dashboardAccess';

export type ProblemSeverity = 'high' | 'medium' | 'low';
export type ProblemGroupKey = 'devices' | 'z_shift' | 'card' | 'kitchen' | 'integrity';

/** The screen's fixed order (the server's `GROUPS`). `integrity` comes only to a super admin. */
export const PROBLEM_GROUPS: ProblemGroupKey[] = ['devices', 'z_shift', 'card', 'kitchen', 'integrity'];
export const PROBLEM_SEVERITIES: ProblemSeverity[] = ['high', 'medium', 'low'];

export const PROBLEMS_HREF = '/dashboard/problems';
/** The screen refreshes itself this often (§3 "רענון: כל 30 שניות"). */
export const PROBLEMS_REFRESH_MS = 30_000;

export type SeverityCounts = Record<ProblemSeverity, number>;

export interface ProblemItem {
  id: string;
  kind: string;
  severity: ProblemSeverity;
  companyId: string | null;
  shopId: string | null;
  shopName: string | null;
  machineId: string | null;
  machineName: string | null;
  posNumber?: string | null;
  /** ISO moment, or a plain day ("2026-10-11") for a problem that dates from a business day. */
  since: string | null;
  title: string;
  detail: string | null;
  link: string | null;
  amount?: number | null;
  /** The exceptions log row, when the problem is one ("טופל" applies). */
  exceptionId: string | null;
  code?: string | null;
  resolvable: boolean;
  /** Which route "טופל" goes through: the log's own, or the phone alerts'. */
  resolveVia?: 'log' | 'alerts' | null;
}

export interface ProblemGroup {
  key: ProblemGroupKey;
  hidden: boolean;
  total: number;
  counts?: SeverityCounts;
  items: ProblemItem[];
}

export interface ProblemsResponse {
  generatedAt?: string;
  counts: SeverityCounts;
  total: number;
  hiddenGroups: ProblemGroupKey[];
  groups: ProblemGroup[];
}

export interface ProblemsPreferences {
  hiddenGroups: ProblemGroupKey[];
  groups?: ProblemGroupKey[];
}

const NO_PROBLEMS_ROLES = new Set(['cashier', 'producer_view']);

/**
 * Whether the screen (and its menu entry, its badge, the home page's link) is offered: every
 * dashboard role but the cashier — the server's own rule (`scoped()`) — and "דוחות" for a user
 * whose sections are narrowed ("הרשאות דשבורד": the page sits in that section).
 */
export function canSeeProblems(role: string | null | undefined, access: DashboardAccess): boolean {
  if (!role || NO_PROBLEMS_ROLES.has(role)) return false;
  return navHrefAllowed(access, PROBLEMS_HREF);
}

function zero(): SeverityCounts {
  return { high: 0, medium: 0, low: 0 };
}

function groupCounts(group: ProblemGroup): SeverityCounts {
  if (group.counts) return { ...zero(), ...group.counts };
  const out = zero();
  for (const item of group.items) out[item.severity] = (out[item.severity] ?? 0) + 1;
  return out;
}

/** The groups hidden, in the screen's order, without repeats or unknown keys. */
export function orderedGroups(keys: Iterable<string>): ProblemGroupKey[] {
  const set = new Set(keys);
  return PROBLEM_GROUPS.filter((g) => set.has(g));
}

/** Hide a group that is shown, show one that is hidden. */
export function toggleHidden(hidden: readonly string[], key: ProblemGroupKey): ProblemGroupKey[] {
  return hidden.includes(key) ? orderedGroups(hidden.filter((g) => g !== key)) : orderedGroups([...hidden, key]);
}

/**
 * The answer as it reads with these groups hidden — what the page shows the moment a group is
 * hidden or shown, before the server's next answer: the counts and the total leave hidden groups out.
 */
export function withHidden(data: ProblemsResponse, hidden: readonly string[]): ProblemsResponse {
  const set = new Set(hidden);
  const counts = zero();
  const groups = data.groups.map((g) => ({ ...g, hidden: set.has(g.key) }));
  for (const g of groups) {
    if (g.hidden) continue;
    const c = groupCounts(g);
    for (const s of PROBLEM_SEVERITIES) counts[s] += c[s];
  }
  return {
    ...data,
    groups,
    counts,
    total: counts.high + counts.medium + counts.low,
    hiddenGroups: orderedGroups(hidden),
  };
}

/** The open problems the menu's badge shows (hidden groups left out); 0 when nothing is known. */
export function badgeCount(data: ProblemsResponse | undefined | null): number {
  if (!data) return 0;
  return Number.isFinite(data.total) ? Math.max(0, data.total) : 0;
}

/** The badge's text: "99+" past 99. */
export function badgeText(count: number): string {
  return count > 99 ? '99+' : String(count);
}

/** The card a push alert names (`?focus=<log row id>`, or an item's own id), and its group. */
export function findFocus(
  data: ProblemsResponse | undefined | null,
  focus: string | null | undefined,
): { group: ProblemGroupKey; item: ProblemItem } | null {
  if (!data || !focus) return null;
  for (const g of data.groups) {
    const item = g.items.find((i) => i.exceptionId === focus || i.id === focus);
    if (item) return { group: g.key, item };
  }
  return null;
}

/** A plain-day `since` ("2026-10-11") read as that day, not a UTC midnight shown as yesterday. */
export function sinceDate(since: string | null | undefined): Date | null {
  if (!since) return null;
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(since);
  const at = day ? new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])) : new Date(since);
  return Number.isFinite(at.getTime()) ? at : null;
}

/** Whether `since` is a business day rather than a moment (the card then says the day). */
export function isDayOnly(since: string | null | undefined): boolean {
  return !!since && /^\d{4}-\d{2}-\d{2}$/.test(since);
}

/** "סניף מרכז · קופה ראשית" — where the problem is: the shop, and the till by name (else by number). */
export function placeOf(item: ProblemItem, registerLabel: (n: string) => string): string {
  const till = item.machineName || (item.posNumber ? registerLabel(item.posNumber) : null);
  return [item.shopName, till].filter(Boolean).join(' · ');
}

/**
 * "טופל" as a request: the log's own route when this user's dashboard may use it
 * (`PATCH /exception-log/{id}`), else the alerts' (`POST /push/alerts/{id}/ack`) — the server
 * said which (`resolveVia`). Null for a problem that is not a log row, or that this user may not mark.
 */
export function resolveRequest(
  item: ProblemItem,
): { method: 'patch' | 'post'; url: string; body: { acknowledged: true; note: null } } | null {
  if (!item.resolvable || !item.exceptionId) return null;
  const body = { acknowledged: true as const, note: null };
  if (item.resolveVia === 'alerts') return { method: 'post', url: `/push/alerts/${item.exceptionId}/ack`, body };
  return { method: 'patch', url: `/exception-log/${item.exceptionId}`, body };
}

/** The answer without one problem — the moment it is marked "טופל", before the next answer. */
export function withoutItem(data: ProblemsResponse, itemId: string): ProblemsResponse {
  let found: ProblemItem | null = null;
  const groups = data.groups.map((g) => {
    const item = g.items.find((i) => i.id === itemId);
    if (!item) return g;
    found = item;
    const counts = groupCounts(g);
    counts[item.severity] = Math.max(0, counts[item.severity] - 1);
    return { ...g, items: g.items.filter((i) => i.id !== itemId), total: Math.max(0, g.total - 1), counts };
  });
  if (!found) return data;
  return withHidden({ ...data, groups }, data.hiddenGroups);
}
