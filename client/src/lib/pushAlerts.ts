/**
 * "התראות" — the phone (Web Push) alerts (pos-server `/push/*`, app/services/exception_alerts/push.py):
 * the types and the pure rules — what this browser can do, the VAPID key for PushManager, the
 * preferences form ⇄ API body (validated like the server), and the alerts feed as the Manager
 * Cockpit's attention items.
 *
 * Pure (no React, no network, relative imports only) so `npm test` runs it with node:test.
 */

import { canAccess, type DashboardAccess } from './dashboardAccess';

export type AlertCategory =
  | 'till_offline'
  | 'card_terminal'
  | 'large_void'
  | 'drawer_no_sale'
  | 'till_low_sales'
  | 'target_reached'
  | 'card_reconcile'
  // "בון לא הודפס" — a kitchen / bar ticket of any till or kiosk that did not print (pos-server app/services/bon_alerts.py).
  | 'bon_unprinted'
  // The board's lights as alerts (P:/specs/manager-problems.md §2, pos-server status_watch.py).
  | 'z_shift'
  | 'card_transmission'
  | 'till_printer'
  // P:/specs/push-more.md §A, §B: the battery, and kinds sent where a level turns "שלח התראה לטלפון" on.
  | 'device_battery'
  | 'discounts'
  | 'cash_difference'
  | 'high_tip'
  | 'high_sale'
  | 'after_hours'
  | 'sensitive_actions'
  | 'staff_actions'
  | 'stock'
  // An order / a table open too long or a late KDS ticket (long_order, table_open_long, kds_ticket_late).
  | 'slow_order'
  // "זיהויים חדשים" (P:/specs/push-more.md §C): the shop not opened, its sales pace, the daily
  // summary (information).
  | 'shop_open'
  | 'sales_pace'
  | 'daily_summary'
  // A payment reversed inside a table, and a closed table restored (P:/specs/table-restore-payments.md §3).
  | 'payment_reversals'
  // "מכשיר מזומן" (P:/specs/cash-paylink.md §9א): every kiosk cash station alert (`cash_unit`), on by default.
  | 'cash'
  // "שלמות נתונים" (§1): a super admin's only — the server lists it to them alone.
  | 'integrity';

/** The types anyone may choose, in the form's order. */
export const ALERT_CATEGORIES: AlertCategory[] = [
  'till_offline',
  'card_terminal',
  'large_void',
  'drawer_no_sale',
  'till_low_sales',
  'target_reached',
  'card_reconcile',
  'bon_unprinted',
  'z_shift',
  'card_transmission',
  'till_printer',
  'device_battery',
  'discounts',
  'cash_difference',
  'high_tip',
  'high_sale',
  'after_hours',
  'sensitive_actions',
  'staff_actions',
  'stock',
  'slow_order',
  'shop_open',
  'sales_pace',
  'daily_summary',
  'payment_reversals',
  'cash',
];

export const INTEGRITY_CATEGORY: AlertCategory = 'integrity';

/**
 * The types the form offers this user: every type, and "שלמות נתונים" last when the server lists it
 * (`GET /push/config` / `GET /push/categories` — a super admin only).
 */
export function visibleCategories(config: Pick<PushConfig, 'categories'> | null | undefined): AlertCategory[] {
  const listed = new Set((config?.categories ?? []).map((c) => c.key));
  return listed.has(INTEGRITY_CATEGORY) ? [...ALERT_CATEGORIES, INTEGRITY_CATEGORY] : [...ALERT_CATEGORIES];
}

/**
 * Whether the personal minimum (₪) applies to what is chosen: some chosen type carries an amount
 * (the server's `amount` — a void, a discount, a cash difference, a large sale). It is a floor of
 * the user's own above each kind's rule (push-more §B2).
 */
export function minAmountApplies(config: Pick<PushConfig, 'categories'> | null | undefined, chosen: AlertCategory[]): boolean {
  const withAmount = new Set((config?.categories ?? []).filter((c) => c.amount).map((c) => c.key));
  return chosen.some((c) => withAmount.has(c));
}

export interface PushConfig {
  enabled: boolean;
  publicKey: string | null;
  /** fix/pwa-push: what is wrong with the server's keys, as a code (lib/pushDiagnosis.ts `configProblem`). */
  problem?: string | null;
  categories: { key: AlertCategory; label: string; hint: string; amount: boolean }[];
  defaults: { minAmount: number; rateLimitMinutes: number };
}

export interface PushPreferences {
  exists: boolean;
  enabled: boolean;
  categories: AlertCategory[];
  shopIds: string[] | null;
  eventIds: string[] | null;
  minAmount: number;
  quietFrom: string | null;
  quietTo: string | null;
  rateLimitMinutes: number;
  digestEnabled: boolean;
  /** A super admin only: "שלמות נתונים" narrowed to these companies (null = all) and the devices muted for it. */
  integrity?: { companyIds: string[] | null; mutedDeviceIds: string[] };
}

export interface PushDevice {
  id: string;
  label: string | null;
  endpointHash: string;
  createdAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastError: string | null;
  /** fix/pwa-push: failures in a row, and the push service (fcm / wns / mozilla / apple). */
  failureCount?: number;
  service?: string;
  active: boolean;
  /** A super admin only: "שלמות נתונים" arrives on this device. */
  integrity?: boolean;
}

export interface PushOptions {
  shops: { id: string; name: string }[];
  /** A super admin only: every company of every organization ("שלמות נתונים"). */
  companies?: { id: string; name: string; tenantId: string; tenantName: string }[];
  events: { id: string; name: string; shopId: string; shopName: string | null; startsAt: string; endsAt: string }[];
}

export interface FeedAlert {
  id: string;
  code: string;
  kind: string;
  kindLabel: string;
  category: AlertCategory;
  categoryLabel: string;
  severity: 'low' | 'medium' | 'high';
  occurredAt: string;
  shopName: string | null;
  machineName: string | null;
  posNumber: string | null;
  posUserName: string | null;
  amount: number | null;
  summary: string | null;
  acknowledged: boolean;
  note: string | null;
  details: Record<string, unknown> | null;
  /** Information (a daily summary), not a problem: never an attention item (pos-server catalog.INFO_KINDS). */
  info?: boolean;
}

export interface AlertsFeed {
  alerts: FeedAlert[];
  open: number;
  canAcknowledge?: boolean;
  /** An alert's own page is the exceptions log's — only with its section. */
  canOpenLog?: boolean;
}

export interface HistoryRow {
  id: string;
  kind: 'alert' | 'digest' | 'test';
  status: string;
  statusLabel: string;
  reason: string | null;
  device: string | null;
  title: string;
  body: string;
  at: string | null;
  sentAt: string | null;
  entryId: string | null;
  entryCode: string | null;
  category: AlertCategory | null;
  digestCount: number | null;
}

// ── This browser ─────────────────────────────────────────────────────────────

export type PushSupport = 'ok' | 'unsupported' | 'ios_needs_install' | 'denied';

/** Whether this browser can receive push, from what it exposes (pure: the caller passes the facts). */
export function pushSupport(env: {
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  hasNotification: boolean;
  permission?: string | null;
  userAgent: string;
  standalone: boolean;
}): PushSupport {
  const ios = /iPhone|iPad|iPod/.test(env.userAgent);
  if (ios && !env.standalone) return 'ios_needs_install';
  if (!env.hasServiceWorker || !env.hasPushManager || !env.hasNotification) return 'unsupported';
  if (env.permission === 'denied') return 'denied';
  return 'ok';
}

/** The VAPID public key (base64url) as PushManager wants it. */
export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = typeof atob === 'function' ? atob(padded) : Buffer.from(padded, 'base64').toString('binary');
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

// ── The preferences form ─────────────────────────────────────────────────────

export interface PrefsDraft {
  enabled: boolean;
  categories: AlertCategory[];
  shopIds: string[];
  eventIds: string[];
  minAmount: string;
  quiet: boolean;
  quietFrom: string;
  quietTo: string;
  rateLimitMinutes: string;
  digestEnabled: boolean;
  /** A super admin's "שלמות נתונים" companies (empty = all); undefined for anyone else. */
  integrityCompanyIds?: string[];
}

export function draftFromPrefs(p: PushPreferences): PrefsDraft {
  return {
    ...(p.integrity ? { integrityCompanyIds: [...(p.integrity.companyIds ?? [])] } : {}),
    enabled: p.enabled,
    categories: [...p.categories],
    shopIds: [...(p.shopIds ?? [])],
    eventIds: [...(p.eventIds ?? [])],
    minAmount: String(p.minAmount),
    quiet: !!(p.quietFrom && p.quietTo),
    quietFrom: p.quietFrom ?? '23:00',
    quietTo: p.quietTo ?? '07:00',
    rateLimitMinutes: String(p.rateLimitMinutes),
    digestEnabled: p.digestEnabled,
  };
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export type PrefsError = 'categories' | 'minAmount' | 'quiet' | 'rateLimit';

/** The draft's problems, the server's rules: ≥ 1 type when on, ₪ ≥ 0, a quiet range of two different times. */
export function prefsErrors(d: PrefsDraft): PrefsError[] {
  const out: PrefsError[] = [];
  if (d.enabled && d.categories.length === 0) out.push('categories');
  const amount = Number(d.minAmount);
  if (d.minAmount.trim() === '' || !Number.isFinite(amount) || amount < 0 || amount > 1_000_000) out.push('minAmount');
  if (d.quiet && (!HHMM.test(d.quietFrom) || !HHMM.test(d.quietTo) || d.quietFrom === d.quietTo)) out.push('quiet');
  const rate = Number(d.rateLimitMinutes);
  if (!Number.isInteger(rate) || rate < 0 || rate > 1440) out.push('rateLimit');
  return out;
}

export function prefsBody(d: PrefsDraft): Record<string, unknown> {
  const body: Record<string, unknown> = {
    enabled: d.enabled,
    categories: [...ALERT_CATEGORIES, INTEGRITY_CATEGORY].filter((c) => d.categories.includes(c)),
    shopIds: d.shopIds.length ? d.shopIds : null,
    eventIds: d.eventIds.length ? d.eventIds : null,
    minAmount: Number(d.minAmount),
    quietFrom: d.quiet ? d.quietFrom : null,
    quietTo: d.quiet ? d.quietTo : null,
    rateLimitMinutes: Number(d.rateLimitMinutes),
    digestEnabled: d.digestEnabled,
  };
  if (d.integrityCompanyIds) body.integrity = { companyIds: d.integrityCompanyIds.length ? d.integrityCompanyIds : null };
  return body;
}

export function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

// ── The feed as attention items ──────────────────────────────────────────────

export interface AttentionItem {
  id: string;
  severity: 'low' | 'medium' | 'high';
  title: string;
  body: string;
  at: string;
  actions: { labelKey: string; actionId: 'ack' | 'open'; context: Record<string, unknown> }[];
}

/**
 * Where an alert leads: an event's live screen for a target, else the entry's page (`/x/<code>`)
 * — that one only for someone who may read the exceptions log (`canOpenLog`); else nowhere (null).
 */
export function alertHref(a: Pick<FeedAlert, 'kind' | 'code' | 'details'>, canOpenLog = true): string | null {
  const eventId = a.details && typeof a.details.eventId === 'string' ? a.details.eventId : null;
  if (a.kind === 'target_reached' && eventId) return `/dashboard/live-event/${eventId}`;
  // "התאמת אשראי מול Z-Credit": the run's page, where the row is handled.
  const runId = a.details && typeof a.details.runId === 'string' ? a.details.runId : null;
  if (a.kind === 'zcredit_recon' && runId) return `/dashboard/zcredit-reconciliation?run=${runId}`;
  // "מכשיר מזומן": the cash station's page (P:/specs/cash-paylink.md §12).
  const stationId = a.details && typeof a.details.stationId === 'string' ? a.details.stationId : null;
  if (a.kind === 'cash_unit' && stationId) return `/dashboard/cash-stations/${encodeURIComponent(stationId)}`;
  return canOpenLog && a.code ? `/x/${a.code}` : null;
}

/**
 * Whether "טופל" is offered — on the alerts page and in the cockpit alike, never by role: "התראות"
 * at edit (the ack route's section) and the server's own `canAcknowledge` (it says exactly what
 * `POST /push/alerts/{id}/ack` lets through). An older server without the flag: the section decides.
 */
export function canAcknowledgeAlerts(access: DashboardAccess, feed: Pick<AlertsFeed, 'canAcknowledge'> | null | undefined): boolean {
  return canAccess(access, 'alerts', 'edit') && feed?.canAcknowledge !== false;
}

/**
 * The open alerts, newest first, as the cockpit's attention feed (the ack action only when allowed).
 * A daily summary informs: it is never one.
 */
export function attentionItems(feed: AlertsFeed, formatTime: (iso: string) => string): AttentionItem[] {
  const rank = { high: 0, medium: 1, low: 2 } as const;
  return feed.alerts
    .filter((a) => !a.acknowledged && !a.info)
    .sort((a, b) => rank[a.severity] - rank[b.severity] || Date.parse(b.occurredAt) - Date.parse(a.occurredAt))
    .map((a) => {
      const till = a.machineName ?? (a.posNumber ? `קופה ${a.posNumber}` : null);
      const actions: AttentionItem['actions'] = [];
      if (feed.canAcknowledge !== false) actions.push({ labelKey: 'actions.ack', actionId: 'ack', context: { entryId: a.id } });
      const href = alertHref(a, feed.canOpenLog !== false);
      if (href) actions.push({ labelKey: 'actions.open', actionId: 'open', context: { href } });
      return {
        id: a.id,
        severity: a.severity,
        title: [a.categoryLabel, till].filter(Boolean).join(' · '),
        body: [a.shopName, a.summary ?? a.kindLabel, formatTime(a.occurredAt)].filter(Boolean).join(' · '),
        at: a.occurredAt,
        actions,
      };
    });
}

export type HistoryTone = 'sent' | 'held' | 'failed';

export function historyTone(status: string): HistoryTone {
  if (status === 'sent' || status === 'queued') return 'sent';
  if (status === 'failed') return 'failed';
  return 'held';
}
