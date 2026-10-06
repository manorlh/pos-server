/**
 * "הודעות" — the notification service's dashboard API (server/app/routers/notifications.py).
 *
 * * The log: recipients come masked from the server and are shown exactly so; the full
 *   number only through `revealRecipient` (company managers and up, a reason, audited),
 *   and the page shows it transiently, never keeps it.
 * * "התקבל אצל הספק" (provider_accepted) is NOT "נמסר" (delivered): the provider took the
 *   message; only a delivery report says it reached the phone.
 * * The provider token is write-only: the server answers `{set, updatedAt}`, never the
 *   value, and the page sends `token` only when someone typed a new one ("" removes it).
 * * Balance: the server returns null (019's balance call is not verified) — the page
 *   says "יתרה לא ידועה", never a number.
 */
import { api } from './api';

// ── Errors ────────────────────────────────────────────────────────────────────

/** `{"detail": {"code", "userMessage", "retryable", "correlationId", …}}` (or a plain string). */
export interface ApiErrorDetail {
  code?: string;
  userMessage?: string | null;
  retryable?: boolean;
  correlationId?: string | null;
  [key: string]: unknown;
}

export function apiErrorDetail(err: unknown): ApiErrorDetail | null {
  const detail = (err as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
  if (detail && typeof detail === 'object' && !Array.isArray(detail)) return detail as ApiErrorDetail;
  if (typeof detail === 'string') return { code: detail };
  return null;
}

export function apiErrorCode(err: unknown): string | null {
  const code = apiErrorDetail(err)?.code;
  return typeof code === 'string' && code ? code : null;
}

export function apiUserMessage(err: unknown): string | null {
  const msg = apiErrorDetail(err)?.userMessage;
  return typeof msg === 'string' && msg.trim() ? msg : null;
}

// ── Log ───────────────────────────────────────────────────────────────────────

export const NOTIFICATION_STATES = [
  'queued',
  'processing',
  'provider_accepted',
  'delivered',
  'failed_retryable',
  'failed_permanent',
  'unknown_outcome',
  'suppressed',
  'expired',
  'cancelled',
] as const;
export type NotificationState = (typeof NOTIFICATION_STATES)[number];

export const NOTIFICATION_CATEGORIES = ['service', 'authentication', 'marketing', 'internal_operations'] as const;

export const NOTIFICATION_EVENTS = ['OrderReady', 'OtpCode', 'ClubWelcome', 'EquipmentAlert', 'Campaign'] as const;

/** A message can be cancelled only while it waits (server `cancel`). */
export const CANCELLABLE_STATES: readonly string[] = ['queued', 'failed_retryable'];
/** A new explicit message may be sent for these (server RESENDABLE_STATES); never an OTP. */
export const RESENDABLE_STATES: readonly string[] = [
  'provider_accepted',
  'delivered',
  'failed_permanent',
  'unknown_outcome',
  'expired',
];

export interface NotificationRow {
  id: string;
  createdAt: string | null;
  companyId: string | null;
  shopId: string | null;
  shopName: string | null;
  eventType: string;
  category: string;
  channel: string;
  /** Masked by the server ("050-•••-4567"); shown exactly as given. */
  recipient: string;
  contextLabel: string | null;
  aggregateRef: string | null;
  state: NotificationState | string;
  stateLabel: string;
  stateReason: string | null;
  providerMode: string | null;
  providerRef: string | null;
  attempts: number;
  isTest: boolean;
  templateKey: string | null;
  text: string | null;
  acceptedAt: string | null;
  deliveredAt: string | null;
  expiresAt: string | null;
  resendOf: string | null;
  resendReason: string | null;
}

export interface NotificationAttempt {
  sequence: number;
  mode: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  outcome: string | null;
  errorClass: string | null;
  providerStatus: string | null;
  providerMessage: string | null;
  httpStatus: number | null;
}

export interface NotificationDeliveryEvent {
  rawStatus: string | null;
  mappedState: string | null;
  applied: boolean;
  eventAt: string | null;
  receivedAt: string | null;
}

export interface NotificationDetail extends NotificationRow {
  attemptsDetail: NotificationAttempt[];
  deliveryEvents: NotificationDeliveryEvent[];
}

export interface NotificationOverview {
  since: string | null;
  counts: Record<string, number>;
  oldestQueuedAt: string | null;
  liveSendingEnabled: boolean;
}

export interface NotificationLogQuery {
  companyId?: string | null;
  shopId?: string | null;
  state?: string;
  category?: string;
  eventType?: string;
  q?: string;
  limit?: number;
  offset?: number;
}

function clean<T extends object>(params: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''),
  ) as Partial<T>;
}

export async function fetchNotificationLog(
  query: NotificationLogQuery,
): Promise<{ items: NotificationRow[]; total: number }> {
  const { data } = await api.get('/notifications/log', { params: clean(query) });
  return data;
}

export async function fetchNotificationOverview(companyId?: string | null): Promise<NotificationOverview> {
  const { data } = await api.get('/notifications/overview', { params: clean({ companyId }) });
  return data;
}

export async function fetchNotification(id: string): Promise<NotificationDetail> {
  const { data } = await api.get(`/notifications/${encodeURIComponent(id)}`);
  return data;
}

/** The full number — audited on the server. The caller shows it briefly and drops it. */
export async function revealRecipient(id: string, reason: string): Promise<{ recipient: string }> {
  const { data } = await api.post(`/notifications/${encodeURIComponent(id)}/reveal-recipient`, { reason });
  return data;
}

export async function resendNotification(id: string, reason: string): Promise<NotificationRow> {
  const { data } = await api.post(`/notifications/${encodeURIComponent(id)}/resend`, { reason });
  return data;
}

export async function cancelNotification(id: string, reason?: string): Promise<NotificationRow> {
  const { data } = await api.post(`/notifications/${encodeURIComponent(id)}/cancel`, { reason: reason ?? '' });
  return data;
}

// ── Templates ─────────────────────────────────────────────────────────────────

export type TemplateStatus = 'draft' | 'approved' | 'active' | 'archived';

export interface BuiltinTemplate {
  eventType: string;
  category: string;
  title: string;
  body: string;
  fallbackBody: string | null;
  required: string[];
  optional: string[];
  secret: string[];
  sample: Record<string, string>;
  /** Campaign: a later phase. */
  p1: boolean;
}

export interface StoredTemplate {
  id: string;
  companyId: string | null;
  eventType: string;
  category: string;
  language: string;
  version: number;
  status: TemplateStatus | string;
  name: string | null;
  body: string;
  fallbackBody: string | null;
  allowedVariables: string[];
  approvedAt: string | null;
  activatedAt: string | null;
  createdAt: string | null;
}

export interface TemplatePreview {
  text: string;
  withoutOptional: string | null;
  usedFallback: boolean;
  /** An estimate only (`verified: false`) — never a price. */
  segments: { length: number; units: number; encoding: string; segments: number; verified: boolean };
}

export async function fetchTemplates(
  companyId?: string | null,
): Promise<{ builtins: BuiltinTemplate[]; items: StoredTemplate[] }> {
  const { data } = await api.get('/notifications/templates', { params: clean({ companyId }) });
  return data;
}

export async function createTemplate(
  companyId: string | null,
  body: { eventType: string; body: string; fallbackBody?: string | null; name?: string | null },
): Promise<StoredTemplate> {
  const { data } = await api.post('/notifications/templates', body, { params: clean({ companyId }) });
  return data;
}

export async function updateTemplate(
  id: string,
  patch: { body?: string; fallbackBody?: string | null; name?: string | null },
): Promise<StoredTemplate> {
  const { data } = await api.patch(`/notifications/templates/${encodeURIComponent(id)}`, patch);
  return data;
}

export async function templateAction(
  id: string,
  action: 'approve' | 'activate' | 'archive',
): Promise<StoredTemplate> {
  const { data } = await api.post(`/notifications/templates/${encodeURIComponent(id)}/${action}`);
  return data;
}

export async function previewTemplate(body: {
  eventType: string;
  body: string;
  fallbackBody?: string | null;
}): Promise<TemplatePreview> {
  const { data } = await api.post('/notifications/templates/preview', body);
  return data;
}

/** A TEST message with sample values, only to a number on the account's test list. */
export async function testSendTemplate(
  companyId: string | null,
  body: { phone: string; eventType: string; body?: string; fallbackBody?: string | null },
): Promise<NotificationRow> {
  const { data } = await api.post('/notifications/templates/test-send', body, { params: clean({ companyId }) });
  return data;
}

// ── Provider account ──────────────────────────────────────────────────────────

export type ProviderMode = 'mock' | 'test' | 'live';

export interface ProviderConfig {
  configured: boolean;
  /** The company has no account of its own and uses the organization's. */
  inherited?: boolean;
  id?: string;
  companyId?: string | null;
  provider?: string;
  mode?: ProviderMode | string;
  accountUsername?: string | null;
  sender?: string | null;
  brandName?: string | null;
  paused?: boolean;
  pausedReason?: string | null;
  pausedAt?: string | null;
  ratePerMinute?: number | null;
  dailyQuota?: number | null;
  alertThreshold?: number | null;
  testNumbers?: string[];
  liveRestrictedToTestNumbers?: boolean;
  enabledEvents?: Record<string, boolean>;
  orderReadyTtlMinutes?: number | null;
  dlrPollingEnabled?: boolean;
  lastAlert?: string | null;
  lastAlertAt?: string | null;
  /** Whether a token is stored, and when — never the value. */
  token?: { set: boolean; updatedAt: string | null };
  /** Always null: unknown, not a number. */
  balance?: null;
  /** The server-wide switch: while off, "live" sends nothing. */
  liveSendingEnabled: boolean;
}

export interface ProviderPatch {
  mode?: ProviderMode;
  accountUsername?: string;
  sender?: string;
  brandName?: string;
  ratePerMinute?: number;
  dailyQuota?: number;
  alertThreshold?: number;
  orderReadyTtlMinutes?: number;
  testNumbers?: string[];
  liveRestrictedToTestNumbers?: boolean;
  enabledEvents?: Record<string, boolean>;
  dlrPollingEnabled?: boolean;
  /** Write-only. Present only when the user typed a new one; "" removes it. */
  token?: string;
}

export async function fetchProvider(companyId?: string | null): Promise<ProviderConfig> {
  const { data } = await api.get('/notifications/provider', { params: clean({ companyId }) });
  return data;
}

export async function saveProvider(companyId: string | null, patch: ProviderPatch): Promise<ProviderConfig> {
  const { data } = await api.put('/notifications/provider', patch, { params: clean({ companyId }) });
  return data;
}

export async function pauseProvider(companyId: string | null, reason?: string): Promise<ProviderConfig> {
  const { data } = await api.post('/notifications/provider/pause', { reason: reason ?? '' }, {
    params: clean({ companyId }),
  });
  return data;
}

export async function resumeProvider(companyId: string | null): Promise<ProviderConfig> {
  const { data } = await api.post('/notifications/provider/resume', {}, { params: clean({ companyId }) });
  return data;
}

/** 019's `source`: up to 11 English letters / digits (server `is_valid_sender`). */
export function isValidSmsSender(sender: string): boolean {
  return /^[A-Za-z0-9]{1,11}$/.test(sender);
}

// ── Campaigns (P1 skeleton) ───────────────────────────────────────────────────

export interface CampaignRow {
  id: string;
  name: string;
  status: string;
  createdAt: string | null;
}

export async function fetchCampaigns(
  companyId?: string | null,
): Promise<{ sendingEnabled: boolean; items: CampaignRow[] }> {
  const { data } = await api.get('/notifications/campaigns', { params: clean({ companyId }) });
  return data;
}

export async function createCampaign(companyId: string, name: string): Promise<CampaignRow> {
  const { data } = await api.post('/notifications/campaigns', { name }, { params: { companyId } });
  return data;
}
