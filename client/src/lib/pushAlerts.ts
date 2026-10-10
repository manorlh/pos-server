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
  | 'bon_unprinted';

export const ALERT_CATEGORIES: AlertCategory[] = [
  'till_offline',
  'card_terminal',
  'large_void',
  'drawer_no_sale',
  'till_low_sales',
  'target_reached',
  'card_reconcile',
  'bon_unprinted',
];

export interface PushConfig {
  enabled: boolean;
  publicKey: string | null;
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
}

export interface PushDevice {
  id: string;
  label: string | null;
  endpointHash: string;
  createdAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastError: string | null;
  active: boolean;
}

export interface PushOptions {
  shops: { id: string; name: string }[];
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
}

export function draftFromPrefs(p: PushPreferences): PrefsDraft {
  return {
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
  return {
    enabled: d.enabled,
    categories: ALERT_CATEGORIES.filter((c) => d.categories.includes(c)),
    shopIds: d.shopIds.length ? d.shopIds : null,
    eventIds: d.eventIds.length ? d.eventIds : null,
    minAmount: Number(d.minAmount),
    quietFrom: d.quiet ? d.quietFrom : null,
    quietTo: d.quiet ? d.quietTo : null,
    rateLimitMinutes: Number(d.rateLimitMinutes),
    digestEnabled: d.digestEnabled,
  };
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

/** The open alerts, newest first, as the cockpit's attention feed (the ack action only when allowed). */
export function attentionItems(feed: AlertsFeed, formatTime: (iso: string) => string): AttentionItem[] {
  const rank = { high: 0, medium: 1, low: 2 } as const;
  return feed.alerts
    .filter((a) => !a.acknowledged)
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
