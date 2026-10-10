/**
 * "יומן חריגות" and "התראות SMS על חריגות" (pos-server app/services/exception_alerts) — the
 * types and the pure helpers of both pages: the rule form (draft ⇄ API body, validated
 * like the server: Israeli mobiles, "N in M minutes" and quiet hours as pairs), the
 * source-document links of a log row, the SMS attempts' tone and text, and the Excel sheet.
 *
 * Pure (no React, no network, relative imports only) so `npm test` runs it with node:test.
 */
import type { ExcelSheet, ExcelValue } from './excelExport';
import { normalizeIsraeliMobile } from './clubSignup';

export type Severity = 'low' | 'medium' | 'high';
export const SEVERITIES: Severity[] = ['high', 'medium', 'low'];

export type DispatchStatus =
  | 'dry_run'
  | 'queued'
  | 'sent'
  | 'sending'
  | 'failed'
  | 'suppressed_rate_limit'
  | 'suppressed_quiet_hours'
  | 'suppressed_stale';

export type CountScope = 'machine' | 'employee' | 'shop';
export const COUNT_SCOPES: CountScope[] = ['machine', 'employee', 'shop'];

export interface LogKind {
  key: string;
  label: string;
  severity: Severity;
  source: string;
  amount: boolean;
  percent: boolean;
  link: 'document' | 'shift' | 'z' | 'none';
}

export interface SmsDispatch {
  id: string;
  ruleId: string | null;
  ruleName: string | null;
  kind: 'alert' | 'digest' | 'test';
  status: DispatchStatus;
  statusLabel: string;
  reason: string | null;
  recipient: string;
  recipientLabel: string | null;
  provider: string | null;
  providerMode: string | null;
  notificationId: string | null;
  digestId: string | null;
  digestCount: number | null;
  text: string | null;
  at: string | null;
  entryId?: string | null;
}

export interface LogEntry {
  id: string;
  code: string;
  kind: string;
  kindLabel: string;
  severity: Severity;
  source: string;
  link: LogKind['link'];
  occurredAt: string;
  receivedAt: string | null;
  companyId: string | null;
  shopId: string | null;
  shopName: string | null;
  areaId: string | null;
  areaName: string | null;
  machineId: string | null;
  machineName: string | null;
  posNumber: string | null;
  posUserId: string | null;
  posUserName: string | null;
  amount: number | null;
  value: number | null;
  threshold: number | null;
  summary: string | null;
  details: Record<string, unknown> | null;
  transactionId: string | null;
  transactionNumber: string | null;
  documentType: number | null;
  shiftId: string | null;
  shiftNumber: number | null;
  zReportId: string | null;
  auditExceptionId: string | null;
  backfilled: boolean;
  acknowledged: boolean;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  note: string | null;
  sms: SmsDispatch[];
}

export interface LogList {
  total: number;
  page: number;
  pageSize: number;
  items: LogEntry[];
}

export interface LogCount {
  key: string;
  label: string | null;
  total: number;
  open: number;
  amount?: number;
}

export interface LogSummary {
  total: number;
  open: number;
  acknowledged: number;
  byKind: LogCount[];
  byEmployee: LogCount[];
  bySeverity: { key: Severity; total: number; open: number }[];
}

export interface LogFilters {
  from: string;
  to: string;
  companyId?: string;
  shopId?: string;
  areaId?: string;
  machineId?: string;
  /** Comma-separated kinds. */
  kind?: string;
  /** Comma-separated severities. */
  severity?: string;
  employee?: string;
  /** 'true' = handled only, 'false' = open only, empty = both. */
  acknowledged?: '' | 'true' | 'false';
  /** An SMS link's code: that one entry, whatever its date. */
  code?: string;
  ruleId?: string;
}

// ── Rules ────────────────────────────────────────────────────────────────────

export interface AlertRecipient {
  phone: string;
  label?: string | null;
  userId?: string | null;
}

export interface AlertRule {
  id: string;
  companyId: string;
  shopId: string | null;
  shopName: string | null;
  name: string;
  enabled: boolean;
  kinds: string[];
  minSeverity: Severity | null;
  minAmount: number | null;
  minPercent: number | null;
  countThreshold: number | null;
  countWindowMinutes: number | null;
  countScope: CountScope;
  recipients: AlertRecipient[];
  quietFrom: string | null;
  quietTo: string | null;
  rateLimitMinutes: number;
  digestEnabled: boolean;
  canWrite: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface ProviderInfo {
  provider: 'dry_run' | 'notifications';
  dryRun: boolean;
  mode: string | null;
  configured?: boolean;
  paused?: boolean;
  liveSendingEnabled: boolean;
  liveRestrictedToTestNumbers?: boolean | null;
}

export interface RulesResponse {
  companyId: string;
  canWriteCompany: boolean;
  canWriteShop: boolean | null;
  provider: ProviderInfo;
  rules: AlertRule[];
}

/** What the form edits: text inputs as typed, validated into the API body by `validateDraft`. */
export interface RuleDraft {
  name: string;
  enabled: boolean;
  shopId: string;
  kinds: string[];
  minSeverity: '' | Severity;
  minAmount: string;
  minPercent: string;
  countThreshold: string;
  countWindowMinutes: string;
  countScope: CountScope;
  recipients: { phone: string; label: string; userId: string }[];
  quietFrom: string;
  quietTo: string;
  rateLimitMinutes: string;
  digestEnabled: boolean;
}

export function emptyDraft(shopId = ''): RuleDraft {
  return {
    name: '',
    enabled: true,
    shopId,
    kinds: [],
    minSeverity: '',
    minAmount: '',
    minPercent: '',
    countThreshold: '',
    countWindowMinutes: '',
    countScope: 'machine',
    recipients: [{ phone: '', label: '', userId: '' }],
    quietFrom: '',
    quietTo: '',
    rateLimitMinutes: '10',
    digestEnabled: true,
  };
}

const str = (v: number | null | undefined): string => (v === null || v === undefined ? '' : String(v));

export function draftFromRule(rule: AlertRule): RuleDraft {
  return {
    name: rule.name,
    enabled: rule.enabled,
    shopId: rule.shopId ?? '',
    kinds: [...rule.kinds],
    minSeverity: rule.minSeverity ?? '',
    minAmount: str(rule.minAmount),
    minPercent: str(rule.minPercent),
    countThreshold: str(rule.countThreshold),
    countWindowMinutes: str(rule.countWindowMinutes),
    countScope: rule.countScope ?? 'machine',
    recipients: rule.recipients.length
      ? rule.recipients.map((r) => ({ phone: r.phone, label: r.label ?? '', userId: r.userId ?? '' }))
      : [{ phone: '', label: '', userId: '' }],
    quietFrom: rule.quietFrom ?? '',
    quietTo: rule.quietTo ?? '',
    rateLimitMinutes: str(rule.rateLimitMinutes),
    digestEnabled: rule.digestEnabled,
  };
}

/** Which thresholds mean something for these kinds (none chosen = every kind). */
export function thresholdsApply(kinds: string[], catalog: LogKind[]): { amount: boolean; percent: boolean } {
  const chosen = kinds.length ? catalog.filter((k) => kinds.includes(k.key)) : catalog;
  return { amount: chosen.some((k) => k.amount), percent: chosen.some((k) => k.percent) };
}

export type DraftErrors = Partial<Record<string, string>>;

export interface RuleBody {
  name: string;
  enabled: boolean;
  shopId: string | null;
  kinds: string[];
  minSeverity: Severity | null;
  minAmount: number | null;
  minPercent: number | null;
  countThreshold: number | null;
  countWindowMinutes: number | null;
  countScope: CountScope;
  recipients: AlertRecipient[];
  quietFrom: string | null;
  quietTo: string | null;
  rateLimitMinutes: number;
  digestEnabled: boolean;
}

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

function numberField(
  raw: string,
  key: string,
  errors: DraftErrors,
  { min, max, integer = false }: { min: number; max: number; integer?: boolean },
): number | null {
  const text = raw.trim();
  if (!text) return null;
  const n = Number(text);
  if (!Number.isFinite(n)) {
    errors[key] = 'number_invalid';
    return null;
  }
  if (n < min || n > max) {
    errors[key] = 'number_out_of_range';
    return null;
  }
  if (integer && !Number.isInteger(n)) {
    errors[key] = 'number_not_integer';
    return null;
  }
  return n;
}

/** The form → the API body, with the server's rules checked first (codes as the server's). */
export function validateDraft(draft: RuleDraft): { errors: DraftErrors; body: RuleBody | null } {
  const errors: DraftErrors = {};
  const name = draft.name.trim().replace(/\s+/g, ' ');
  if (!name) errors.name = 'name_required';
  if (!draft.kinds.length && !draft.minSeverity) errors.kinds = 'kinds_required';
  const minAmount = numberField(draft.minAmount, 'minAmount', errors, { min: 0, max: 1_000_000 });
  const minPercent = numberField(draft.minPercent, 'minPercent', errors, { min: 0, max: 1000 });
  const count = numberField(draft.countThreshold, 'countThreshold', errors, { min: 2, max: 100, integer: true });
  const window = numberField(draft.countWindowMinutes, 'countWindowMinutes', errors, { min: 1, max: 1440, integer: true });
  if (!errors.countThreshold && !errors.countWindowMinutes && (count === null) !== (window === null)) {
    errors[count === null ? 'countThreshold' : 'countWindowMinutes'] = 'count_needs_both';
  }
  const quietFrom = draft.quietFrom.trim();
  const quietTo = draft.quietTo.trim();
  if (quietFrom && !TIME.test(quietFrom)) errors.quietFrom = 'time_invalid';
  if (quietTo && !TIME.test(quietTo)) errors.quietTo = 'time_invalid';
  if (!errors.quietFrom && !errors.quietTo && !!quietFrom !== !!quietTo) {
    errors[quietFrom ? 'quietTo' : 'quietFrom'] = 'quiet_needs_both';
  }
  if (quietFrom && quietFrom === quietTo) errors.quietTo = 'quiet_empty';
  const rate = numberField(draft.rateLimitMinutes, 'rateLimitMinutes', errors, { min: 0, max: 1440, integer: true });

  const recipients: AlertRecipient[] = [];
  const seen = new Set<string>();
  draft.recipients.forEach((r, i) => {
    if (!r.phone.trim() && !r.label.trim() && !r.userId) return; // an empty row is ignored
    const phone = normalizeIsraeliMobile(r.phone);
    if (!phone.ok) {
      errors[`recipients.${i}`] = phone.code;
      return;
    }
    if (seen.has(phone.e164)) return;
    seen.add(phone.e164);
    recipients.push({ phone: phone.e164, label: r.label.trim() || null, userId: r.userId || null });
  });
  if (recipients.length > 10) errors.recipients = 'too_many_recipients';
  if (draft.enabled && !recipients.length && !Object.keys(errors).some((k) => k.startsWith('recipients.'))) {
    errors.recipients = 'recipients_required';
  }
  if (Object.keys(errors).length) return { errors, body: null };
  return {
    errors,
    body: {
      name,
      enabled: draft.enabled,
      shopId: draft.shopId || null,
      kinds: [...new Set(draft.kinds)],
      minSeverity: draft.minSeverity || null,
      minAmount,
      minPercent,
      countThreshold: count,
      countWindowMinutes: window,
      countScope: draft.countScope,
      recipients,
      quietFrom: quietFrom || null,
      quietTo: quietTo || null,
      rateLimitMinutes: rate ?? 10,
      digestEnabled: draft.digestEnabled,
    },
  };
}

/** "22:00–07:00" (or null with no quiet hours). */
export function quietHoursText(from: string | null, to: string | null): string | null {
  return from && to ? `${from}–${to}` : null;
}

// ── Log rows ─────────────────────────────────────────────────────────────────

export type SourceLink =
  | { kind: 'document'; href: string; number: string | null }
  | { kind: 'shift'; href: string; number: number | null }
  | { kind: 'z'; href: string; number: string | number | null };

/** Where a log row links: its document, its shift, its Z — each that it has. */
export function sourceLinks(row: Pick<LogEntry, 'transactionId' | 'transactionNumber' | 'shiftId' | 'shiftNumber' | 'zReportId' | 'details'>): SourceLink[] {
  const out: SourceLink[] = [];
  if (row.transactionId) {
    out.push({ kind: 'document', href: `/dashboard/transactions?tx=${row.transactionId}`, number: row.transactionNumber ?? null });
  }
  if (row.shiftId) out.push({ kind: 'shift', href: `/dashboard/shifts/${row.shiftId}`, number: row.shiftNumber ?? null });
  const details = row.details ?? {};
  const zId = row.zReportId || (typeof details.zReportId === 'string' ? details.zReportId : null);
  if (zId) {
    const zNumber = details.zNumber;
    out.push({
      kind: 'z',
      href: `/dashboard/z-reports/${zId}`,
      number: typeof zNumber === 'string' || typeof zNumber === 'number' ? zNumber : null,
    });
  }
  return out;
}

export type Tone = 'ok' | 'muted' | 'warn' | 'error';

export function dispatchTone(status: DispatchStatus): Tone {
  switch (status) {
    case 'sent':
    case 'queued':
      return 'ok';
    case 'dry_run':
    case 'sending':
      return 'muted';
    case 'failed':
      return 'error';
    default:
      return 'warn';
  }
}

export function isHeldBack(status: DispatchStatus): boolean {
  return status === 'suppressed_rate_limit' || status === 'suppressed_quiet_hours' || status === 'suppressed_stale';
}

/** One line per SMS attempt: "דנה 050-•••-4567: הדמיה — לא נשלח". */
export function smsText(sms: SmsDispatch[]): string {
  return sms
    .map((d) => `${[d.recipientLabel, d.recipient].filter(Boolean).join(' ')}: ${d.statusLabel}`)
    .join('; ');
}

export type Tr = (key: string) => string;

/** The log as an Excel sheet (headers through [t], the `exceptionsLog.col` translator). */
export function logSheet(
  rows: LogEntry[],
  t: Tr,
  name: string,
  labels: { severity: (s: Severity) => string; acknowledged: (yes: boolean) => string },
): ExcelSheet {
  return {
    name,
    columns: [
      { header: t('time'), kind: 'datetime' },
      { header: t('kind'), width: 26 },
      { header: t('severity'), width: 10 },
      { header: t('shop') },
      { header: t('area') },
      { header: t('till'), width: 16 },
      { header: t('employee') },
      { header: t('amount'), kind: 'money' },
      { header: t('details'), width: 40 },
      { header: t('document'), width: 14 },
      { header: t('status'), width: 10 },
      { header: t('acknowledgedBy') },
      { header: t('note'), width: 30 },
      { header: t('sms'), width: 40 },
      { header: t('code'), width: 10 },
    ],
    rows: rows.map((r): ExcelValue[] => [
      r.occurredAt,
      r.kindLabel,
      labels.severity(r.severity),
      r.shopName,
      r.areaName,
      [r.machineName, r.posNumber].filter(Boolean).join(' · ') || null,
      r.posUserName ?? r.posUserId,
      r.amount,
      r.summary,
      r.transactionNumber ?? (r.shiftNumber != null ? `#${r.shiftNumber}` : null),
      labels.acknowledged(r.acknowledged),
      r.acknowledgedBy,
      r.note,
      r.sms.length ? smsText(r.sms) : null,
      r.code,
    ]),
  };
}
