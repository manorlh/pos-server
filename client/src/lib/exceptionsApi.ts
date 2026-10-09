/**
 * Exceptions ("חריגות", `/exceptions`): discounts, refunds, cancelled baskets, voided
 * lines, long orders, high tips, cash differences… detected by the cloud from what the
 * tills push, with a review state per exception, and their rules per level
 * (organization → company → shop → point of sale → till; the most specific wins).
 */
import { api } from './api';

export const EXCEPTION_TYPES = [
  'discount',
  'refund',
  'drawer_open',
  'line_void',
  'basket_cancel',
  'long_order',
  'high_tip',
  'high_amount',
  'cash_difference',
  'after_hours',
  'price_override',
  'card_failures',
  // An open table cancelled with a reason and a manager's approval (table management).
  'table_cancelled',
  // A table's bill or kitchen tickets printed again, with the approving manager.
  'reprint',
  // An employee signed in at another till, released by a manager to sign in here.
  'user_session_release',
  // "שינוי נוכחות ידני": a manager's correction or close of an employee's attendance.
  'attendance_manual',
  // A line given free at the till ("OTH — על חשבון הבית"), at its list price.
  'oth',
  // A till Z closed with no connection whose figures differ from the cloud's
  // (pos-server docs/SPEC_OFFLINE_TILL_Z.md §6.1).
  'offline_z_gap',
  // A till Z closed although the card transmission before it failed (§7.3).
  'z_transmission_failed',
  // A remote Z close forced "even mid-sale", with who forced it and what was parked (§9).
  'forced_z_close',
  // A Z closed offline that the cloud could not take as printed — held for support,
  // never renumbered (§4.5). Supposed to be impossible.
  'offline_z_conflict',
  // Support produced a dead till's Z from the cloud (§4.6): who, why, the basis, the gaps.
  'support_z_produced',
  // Support ordered a reset of a till's data from the cloud — the only way (§4.7).
  'till_reset',
  // "תשלום לא מוכרע": a manager decided an unknown card from the cloud against what the terminal
  // said on a check, or with no check — on an explicit confirmation (who, when, the verdict).
  'card_decision_override',
  // "הוחלפה קופה": a replacement device took over a till (§4.6.2).
  'till_replaced',
  // A super admin moved the shop Z's production before its producer handed over
  // ("קופה עצמאית בתוך סניף", docs/SPEC_INDEPENDENT_TILL.md §8).
  'shop_z_producer_forced',
  // A super admin produced a shop Z past "חסימת Z כשיש משמרות פתוחות" without tills that had not
  // closed (details: runId, zReportId, tills, reason, forcedBy, summary).
  'z_forced_open_shifts',
  // A local shop Z stored as printed whose cloud recomputation differs — an internal check
  // for support only; the Z itself is never corrected (details: zReportId, zNumber,
  // discrepancies [{key, till, cloud}], summary).
  'local_shop_z_mismatch',
  // A till of a local shop Z that did not finish syncing the documents the Z names (removed,
  // dead, or 24 h late) — support closes its part on the Z's page (details: zReportId,
  // zNumber, machineId, posNumber, named, arrived, missing, shiftsAwaited, reason, summary).
  'local_shop_z_till_unsynced',
  // A self-order kiosk offline longer than the rule's minutes in its opening hours; closed
  // when it comes back (details: kiosk, offlineSince, backAt; value = minutes offline).
  'kiosk_offline',
  // "התאמת אשראי מול Z-Credit": a charge at Z-Credit with no document of ours, or a document with no
  // Z-Credit transaction (details: runId, itemId, category, businessDate, terminal, reference, summary).
  'zcredit_recon',
  // "מגירת מזומן" (pos-server app/services/cash_drawer_exceptions.py, docs/SPEC_ROLES_PERMISSIONS.md):
  // detected from the tills' drawer events and cash movements; thresholds on the roles page.
  'drawer_after_close',
  'drawer_manual_burst',
  'drawer_manual_over_max',
  'cash_out_over_threshold',
  'drawer_count_variance',
  'drawer_open_near_variance',
  'drawer_open_no_reason',
  'drawer_open_denied',
] as const;

export type ExceptionType = (typeof EXCEPTION_TYPES)[number];
export type ExceptionStatus = 'new' | 'reviewed' | 'dismissed';
export type RuleLevel = 'tenant' | 'company' | 'shop' | 'area' | 'machine';

export interface AuditException {
  id: string;
  type: ExceptionType;
  severity: 'low' | 'medium' | 'high';
  status: ExceptionStatus;
  occurredAt: string;
  detectedAt: string;
  companyId?: string | null;
  shopId?: string | null;
  shopName?: string | null;
  areaId?: string | null;
  areaName?: string | null;
  machineId?: string | null;
  machineName?: string | null;
  posNumber?: string | null;
  shiftId?: string | null;
  shiftNumber?: number | null;
  transactionId?: string | null;
  transactionNumber?: string | null;
  /** 320 / 330 / 400 / -400: a number names a document only with its type (one series per type). */
  documentType?: number | null;
  posUserId?: string | null;
  posUserName?: string | null;
  amount?: number | null;
  value?: number | null;
  threshold?: number | null;
  details?: Record<string, unknown> | null;
  reviewedBy?: string | null;
  reviewedAt?: string | null;
  reviewNote?: string | null;
}

export interface ExceptionList {
  total: number;
  page: number;
  pageSize: number;
  items: AuditException[];
}

export interface CountRow {
  key?: string | null;
  label?: string | null;
  total: number;
  new: number;
  amount: number;
}

export interface ExceptionSummary {
  total: number;
  new: number;
  reviewed: number;
  dismissed: number;
  byType: CountRow[];
  byEmployee: CountRow[];
}

export interface ExceptionFilters {
  from: string;
  to: string;
  companyId?: string;
  shopId?: string;
  areaId?: string;
  machineId?: string;
  /** Comma-separated types. */
  type?: string;
  employee?: string;
  /** Comma-separated statuses (list only). */
  status?: string;
}

function clean(params: object): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') out[k] = v;
  return out;
}

export async function fetchExceptions(
  filters: ExceptionFilters,
  page = 1,
  pageSize = 50,
): Promise<ExceptionList> {
  const { data } = await api.get<ExceptionList>('/exceptions', {
    params: clean({ ...filters, page, pageSize }),
  });
  return data;
}

export async function fetchExceptionSummary(filters: ExceptionFilters): Promise<ExceptionSummary> {
  // The summary counts every status; the status filter is the list's.
  const { status: _status, ...rest } = filters;
  void _status;
  const { data } = await api.get<ExceptionSummary>('/exceptions/summary', { params: clean(rest) });
  return data;
}

export async function reviewException(
  id: string,
  status: ExceptionStatus,
  note?: string | null,
): Promise<AuditException> {
  const { data } = await api.patch<AuditException>(`/exceptions/${id}`, { status, note: note ?? null });
  return data;
}

export async function reviewExceptions(
  ids: string[],
  status: ExceptionStatus,
  note?: string | null,
): Promise<{ updated: number }> {
  const { data } = await api.post<{ updated: number }>('/exceptions/review', {
    ids,
    status,
    note: note ?? null,
  });
  return data;
}

export async function rescanExceptions(
  from: string,
  to: string,
  scope: { shopId?: string; machineId?: string } = {},
): Promise<{ created: number; updated: number }> {
  const { data } = await api.post<{ created: number; updated: number }>(
    '/exceptions/rescan',
    { from, to },
    { params: clean(scope) },
  );
  return data;
}

// ── Rules ────────────────────────────────────────────────────────────────────

export interface RuleParam {
  key: string;
  default: number;
  min: number;
  max: number;
  integer: boolean;
}

export interface ExceptionRule {
  type: ExceptionType;
  available: boolean;
  source: 'document' | 'shift' | 'till_event';
  severity: string;
  defaultEnabled: boolean;
  params: RuleParam[];
  ownEnabled: boolean | null;
  ownParams: Record<string, number>;
  inheritedEnabled: boolean;
  inheritedParams: Record<string, number>;
  inheritedSources: Record<string, RuleLevel | null>;
  effectiveEnabled: boolean;
  effectiveParams: Record<string, number>;
}

export interface RulesResponse {
  level: RuleLevel;
  id: string | null;
  canWrite: boolean;
  rules: ExceptionRule[];
}

export interface RuleInput {
  type: ExceptionType;
  enabled: boolean | null;
  params: Record<string, number | null>;
}

export async function fetchExceptionRules(level: RuleLevel, id: string | null): Promise<RulesResponse> {
  const { data } = await api.get<RulesResponse>('/exceptions/rules', { params: clean({ level, id }) });
  return data;
}

export async function saveExceptionRules(
  level: RuleLevel,
  id: string | null,
  rules: RuleInput[],
): Promise<RulesResponse> {
  const { data } = await api.put<RulesResponse>('/exceptions/rules', { rules }, { params: clean({ level, id }) });
  return data;
}
