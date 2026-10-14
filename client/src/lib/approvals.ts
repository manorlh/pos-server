/**
 * "בקשות אישור מרחוק" (P:\specs\manager-approval-mobile.md): a till asks a manager's phone to
 * approve a refund, a discount, a void… The dashboard side — the requests (pending, history,
 * one request and its decision), the per-level policy (§4), an employee's own overrides and the
 * dashboard user ⇄ till employee link. The API calls are `lib/approvalsApi.ts`.
 *
 * Pure (no React, no network, relative imports only) so `npm test` runs it with node:test.
 * Owner rule: "הכל דינמי וניתן לשינוי" — every type, field, role and level comes from the
 * server's catalogue; nothing here lists them.
 */

import { formatCurrency } from './format';
import type { ExcelCellKind, ExcelValue } from './excelExport';

// ── Requests ─────────────────────────────────────────────────────────────────

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled';

export const APPROVAL_STATUSES: readonly ApprovalStatus[] = ['pending', 'approved', 'rejected', 'expired', 'cancelled'];

export type LimitUnit = 'amount' | 'percent' | 'count';
export type PolicyLevel = 'company' | 'shop' | 'area' | 'machine';
export const POLICY_LEVELS: readonly PolicyLevel[] = ['company', 'shop', 'area', 'machine'];

export interface ApprovalRecipient {
  userId: string;
  name: string;
}

export interface ApprovalCard {
  id: string;
  type: string;
  typeLabel: string;
  status: ApprovalStatus;
  shopId: string | null;
  shopName: string | null;
  machineId: string | null;
  machineName: string | null;
  areaName: string | null;
  requesterName: string | null;
  requesterPosUserId: string | null;
  amount: number | null;
  percent: number | null;
  reasonCode: string | null;
  reasonText: string | null;
  note: string | null;
  tableLabel: string | null;
  /** A line the cloud wrote for the approver ("שחרור עובד מחובר": who is signed in where, since when). */
  summary: string | null;
  createdAt: string;
  expiresAt: string | null;
  decidedAt: string | null;
  decidedByName: string | null;
  decidedByUserId: string | null;
  approvedAmount: number | null;
  approvedPercent: number | null;
  message: string | null;
  sentTo: ApprovalRecipient[];
  canDecide: boolean;
}

export interface ApprovalList {
  items: ApprovalCard[];
  total: number;
  pendingCount: number;
}

/** A personal or per-role ceiling, by the type's `limitUnit`. */
export interface RoleLimit {
  maxAmount?: number | null;
  maxPercent?: number | null;
  maxCount?: number | null;
}

export interface ApprovalDetail extends ApprovalCard {
  clientRequestId: string | null;
  /** Whatever the till sent (`lines`, `table`, `document`, …) — read defensively. */
  payload: Record<string, unknown>;
  allowPartial: boolean;
  quickApprove: boolean;
  limitUnit: LimitUnit | null;
  myLimit: RoleLimit | null;
  escalatedAt: string | null;
}

export type Decision = 'approve' | 'reject';

export interface DecideBody {
  decision: Decision;
  approvedAmount?: number;
  approvedPercent?: number;
  message?: string;
}

const str = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));

/** A number from the API (a number, or a decimal as a string), else null. */
export function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function isApprovalStatus(v: unknown): v is ApprovalStatus {
  return typeof v === 'string' && (APPROVAL_STATUSES as readonly string[]).includes(v);
}

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** One card off the wire: unknown fields dropped, numbers as numbers, an unknown status → expired. */
export function normalizeCard(raw: unknown): ApprovalCard {
  const r = asObject(raw);
  const sentTo = Array.isArray(r.sentTo)
    ? r.sentTo
        .map((x) => asObject(x))
        .map((x) => ({ userId: String(x.userId ?? x.approverId ?? ''), name: String(x.name ?? '') }))
        .filter((x) => x.userId || x.name)
    : [];
  return {
    id: String(r.id ?? ''),
    type: String(r.type ?? ''),
    typeLabel: str(r.typeLabel) ?? String(r.type ?? ''),
    status: isApprovalStatus(r.status) ? r.status : 'expired',
    shopId: str(r.shopId),
    shopName: str(r.shopName),
    machineId: str(r.machineId),
    machineName: str(r.machineName),
    areaName: str(r.areaName),
    requesterName: str(r.requesterName),
    requesterPosUserId: str(r.requesterPosUserId),
    amount: num(r.amount),
    percent: num(r.percent),
    reasonCode: str(r.reasonCode),
    reasonText: str(r.reasonText),
    note: str(r.note),
    tableLabel: str(r.tableLabel),
    summary: str(r.summary),
    createdAt: String(r.createdAt ?? ''),
    expiresAt: str(r.expiresAt),
    decidedAt: str(r.decidedAt),
    decidedByName: str(r.decidedByName),
    decidedByUserId: str(r.decidedByUserId),
    approvedAmount: num(r.approvedAmount),
    approvedPercent: num(r.approvedPercent),
    message: str(r.message),
    sentTo,
    canDecide: r.canDecide === true,
  };
}

function normalizeLimit(raw: unknown): RoleLimit | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const out: RoleLimit = {};
  for (const k of ['maxAmount', 'maxPercent', 'maxCount'] as const) {
    const n = num(r[k]);
    if (n !== null) out[k] = n;
  }
  return out;
}

export function normalizeDetail(raw: unknown): ApprovalDetail {
  const r = asObject(raw);
  const unit = r.limitUnit;
  return {
    ...normalizeCard(raw),
    clientRequestId: str(r.clientRequestId),
    payload: asObject(r.payload),
    allowPartial: r.allowPartial === true,
    quickApprove: r.quickApprove === true,
    limitUnit: unit === 'amount' || unit === 'percent' || unit === 'count' ? unit : null,
    myLimit: normalizeLimit(r.myLimit),
    escalatedAt: str(r.escalatedAt),
  };
}

export function normalizeList(raw: unknown): ApprovalList {
  const r = asObject(raw);
  const items = Array.isArray(r.items) ? r.items.map(normalizeCard) : [];
  return { items, total: num(r.total) ?? items.length, pendingCount: num(r.pendingCount) ?? 0 };
}

// ── Showing a request ────────────────────────────────────────────────────────

export type StatusTone = 'pending' | 'ok' | 'error' | 'muted';

export function statusTone(status: ApprovalStatus): StatusTone {
  if (status === 'pending') return 'pending';
  if (status === 'approved') return 'ok';
  if (status === 'rejected') return 'error';
  return 'muted';
}

/** The status pill's colours, light and dark. */
export const STATUS_TONE_CLASS: Record<StatusTone, string> = {
  pending: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  ok: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200',
  error: 'bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200',
  muted: 'bg-slate-200 text-slate-800 dark:bg-slate-800 dark:text-slate-200',
};

/** 30 → "30%", 12.5 → "12.5%", nothing → "". */
export function formatPercent(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '';
  return `${Math.round(v * 100) / 100}%`;
}

/** Money as the dashboard writes it, nothing → "". */
export function formatAmount(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '';
  return formatCurrency(v);
}

/** What was asked: "30% · ₪120.00", the percent first (a discount reads by it). */
export function requestedText(card: Pick<ApprovalCard, 'amount' | 'percent'>): string {
  return [formatPercent(card.percent), formatAmount(card.amount)].filter(Boolean).join(' · ');
}

/** What was approved, when it is not simply what was asked. */
export function approvedText(card: Pick<ApprovalCard, 'approvedAmount' | 'approvedPercent'>): string {
  return [formatPercent(card.approvedPercent), formatAmount(card.approvedAmount)].filter(Boolean).join(' · ');
}

/** Approved for less than asked ("ביקשו 30% ואישר 20%"). */
export function isPartial(card: Pick<ApprovalCard, 'status' | 'amount' | 'percent' | 'approvedAmount' | 'approvedPercent'>): boolean {
  if (card.status !== 'approved') return false;
  const lower = (asked: number | null, got: number | null) => asked !== null && got !== null && got < asked;
  return lower(card.amount, card.approvedAmount) || lower(card.percent, card.approvedPercent);
}

/** The reason as the requester gave it: the fixed one's text, else its code. */
export function reasonOf(card: Pick<ApprovalCard, 'reasonText' | 'reasonCode'>): string {
  return card.reasonText ?? card.reasonCode ?? '';
}

/** The till as one line: "קופה 2 · בר". */
export function placeOf(card: Pick<ApprovalCard, 'machineName' | 'areaName'>): string {
  return [card.machineName, card.areaName].filter(Boolean).join(' · ');
}

/** Whole seconds until `expiresAt` (never below 0), or null when there is none / unreadable. */
export function secondsLeft(expiresAt: string | null | undefined, now: number): number | null {
  if (!expiresAt) return null;
  const at = Date.parse(expiresAt);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.ceil((at - now) / 1000));
}

/** 179 → "2:59", 3725 → "1:02:05". */
export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** The menu's badge: nothing at 0, "99+" above 99. */
export function badgeText(count: number | null | undefined): string | null {
  if (!count || count <= 0 || !Number.isFinite(count)) return null;
  return count > 99 ? '99+' : String(Math.floor(count));
}

// ── The request's payload ────────────────────────────────────────────────────

export interface PayloadLine {
  name: string;
  qty: number | null;
  price: number | null;
  total: number | null;
  sentToKitchen: boolean;
}

/** `payload.lines`, whatever shape each line has; a line without a name is "—". */
export function payloadLines(payload: unknown): PayloadLine[] {
  const lines = asObject(payload).lines;
  if (!Array.isArray(lines)) return [];
  return lines.map((raw) => {
    const l = asObject(raw);
    return {
      name: str(l.name ?? l.productName ?? l.description) ?? '—',
      qty: num(l.qty ?? l.quantity),
      price: num(l.price ?? l.unitPrice),
      total: num(l.total ?? l.lineTotal),
      sentToKitchen: l.sentToKitchen === true,
    };
  });
}

/** The table: the card's label, else `payload.table` (`label` / `name` / `number`), else a string table. */
export function payloadTable(payload: unknown, tableLabel?: string | null): string | null {
  if (tableLabel) return tableLabel;
  const t = asObject(payload).table;
  if (typeof t === 'string' || typeof t === 'number') return String(t);
  const o = asObject(t);
  return str(o.label ?? o.name ?? o.number);
}

export interface PayloadDocument {
  number: string | null;
  type: string | null;
  total: number | null;
  date: string | null;
}

export function payloadDocument(payload: unknown): PayloadDocument | null {
  const d = asObject(payload).document;
  if (!d || typeof d !== 'object') return null;
  const o = d as Record<string, unknown>;
  const doc = { number: str(o.number ?? o.documentNumber), type: str(o.type ?? o.typeLabel), total: num(o.total), date: str(o.date ?? o.createdAt) };
  return doc.number || doc.type || doc.total !== null || doc.date ? doc : null;
}

/** Whatever else the till sent as plain values (installments, expected / counted…), as label → text. */
export function payloadExtras(payload: unknown): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(asObject(payload))) {
    if (k === 'lines' || k === 'table' || k === 'document') continue;
    if (typeof v === 'string' && v.trim()) out.push([k, v]);
    else if (typeof v === 'number' && Number.isFinite(v)) out.push([k, String(v)]);
    else if (typeof v === 'boolean') out.push([k, v ? '✓' : '✗']);
  }
  return out;
}

// ── Deciding ─────────────────────────────────────────────────────────────────

/** Which value a partial approval lowers: the type's limit unit first, else what was asked. */
export function partialField(d: Pick<ApprovalDetail, 'limitUnit' | 'amount' | 'percent'>): 'percent' | 'amount' | null {
  if (d.limitUnit === 'percent' && d.percent !== null) return 'percent';
  if (d.limitUnit === 'amount' && d.amount !== null) return 'amount';
  if (d.percent !== null) return 'percent';
  if (d.amount !== null) return 'amount';
  return null;
}

/** My ceiling for that value, if the server gave one. */
export function myCeiling(d: Pick<ApprovalDetail, 'myLimit'>, field: 'percent' | 'amount' | null): number | null {
  if (!field || !d.myLimit) return null;
  return num(field === 'percent' ? d.myLimit.maxPercent : d.myLimit.maxAmount);
}

/** What the partial box starts with: what was asked, or my ceiling when that is lower. */
export function initialPartial(requested: number | null, ceiling: number | null): string {
  if (requested === null) return '';
  return String(ceiling !== null && ceiling < requested ? ceiling : requested);
}

export type PartialError = 'empty' | 'notPositive' | 'overRequested' | 'overLimit';

/** A lower amount / percent must be a number > 0, ≤ what was asked and ≤ my ceiling. */
export function partialError(text: string, requested: number | null, ceiling: number | null): PartialError | null {
  if (!text.trim()) return 'empty';
  const n = Number(text.trim());
  if (!Number.isFinite(n) || n <= 0) return 'notPositive';
  if (requested !== null && n > requested) return 'overRequested';
  if (ceiling !== null && n > ceiling) return 'overLimit';
  return null;
}

/**
 * The body of `POST /approvals/{id}/decide`. A partial value is sent only when it is lower than
 * what was asked (the same value is a plain approval); the message only when written.
 */
export function decideBody(
  decision: Decision,
  opts: { field?: 'percent' | 'amount' | null; requested?: number | null; partial?: string; message?: string } = {},
): DecideBody {
  const body: DecideBody = { decision };
  const message = (opts.message ?? '').trim();
  if (message) body.message = message;
  if (decision === 'approve' && opts.field && opts.partial !== undefined && opts.partial.trim()) {
    const n = Number(opts.partial.trim());
    if (Number.isFinite(n) && n > 0 && (opts.requested === null || opts.requested === undefined || n < opts.requested)) {
      if (opts.field === 'percent') body.approvedPercent = n;
      else body.approvedAmount = n;
    }
  }
  return body;
}

/** FastAPI's `{detail: "<code>"}` and the HTTP status off an axios error. */
export function apiErrorOf(err: unknown): { status: number | null; code: string | null } {
  const res = (err as { response?: { status?: unknown; data?: { detail?: unknown } } } | null)?.response;
  const status = typeof res?.status === 'number' ? res.status : null;
  const detail = res?.data?.detail;
  const code = typeof detail === 'string' ? detail : detail && typeof detail === 'object' && typeof (detail as { code?: unknown }).code === 'string' ? (detail as { code: string }).code : null;
  return { status, code };
}

/** What a failed decision means for the page: show the final state, say "not yours", or a plain error. */
export function decideFailure(err: unknown): 'decided' | 'notAllowed' | 'partialNotAllowed' | 'invalidAmount' | 'other' {
  const { status, code } = apiErrorOf(err);
  if (status === 409 || code === 'already_decided' || code === 'expired' || code === 'not_pending') return 'decided';
  if (status === 403 || code === 'not_allowed') return 'notAllowed';
  if (code === 'partial_not_allowed') return 'partialNotAllowed';
  if (code === 'invalid_amount') return 'invalidAmount';
  return 'other';
}

// ── History: filters and the export ──────────────────────────────────────────

export interface HistoryFilters {
  type: string;
  shopId: string;
  requester: string;
  approver: string;
  outcome: string;
  reason: string;
  from: string;
  to: string;
}

export const EMPTY_HISTORY_FILTERS: HistoryFilters = {
  type: '',
  shopId: '',
  requester: '',
  approver: '',
  outcome: '',
  reason: '',
  from: '',
  to: '',
};

/** `GET /approvals` query: only what is set, text trimmed. */
export function historyParams(
  f: HistoryFilters,
  page: { status?: 'pending' | 'all'; limit?: number; offset?: number } = {},
): Record<string, string | number> {
  const out: Record<string, string | number> = { status: page.status ?? 'all' };
  for (const key of ['type', 'shopId', 'requester', 'approver', 'outcome', 'reason', 'from', 'to'] as const) {
    const v = (f[key] ?? '').trim();
    if (v) out[key] = v;
  }
  out.limit = page.limit ?? 200;
  out.offset = page.offset ?? 0;
  return out;
}

/** How many history filters are set (the "סינונים" badge). */
export function activeFilterCount(f: HistoryFilters): number {
  return Object.values(f).filter((v) => (v ?? '').trim() !== '').length;
}

export type ApprovalColumnKey =
  | 'createdAt'
  | 'type'
  | 'status'
  | 'shop'
  | 'till'
  | 'table'
  | 'requester'
  | 'amount'
  | 'percent'
  | 'reason'
  | 'note'
  | 'sentTo'
  | 'decidedAt'
  | 'decidedBy'
  | 'approvedAmount'
  | 'approvedPercent'
  | 'message';

/** The history table's columns, in order — the screen, Excel and the PDF. */
export const APPROVAL_COLUMNS: Array<{ key: ApprovalColumnKey; kind: ExcelCellKind; width?: number }> = [
  { key: 'createdAt', kind: 'datetime' },
  { key: 'type', kind: 'text', width: 20 },
  { key: 'status', kind: 'text', width: 12 },
  { key: 'shop', kind: 'text' },
  { key: 'till', kind: 'text' },
  { key: 'table', kind: 'text', width: 12 },
  { key: 'requester', kind: 'text' },
  { key: 'amount', kind: 'money' },
  { key: 'percent', kind: 'percent' },
  { key: 'reason', kind: 'text', width: 24 },
  { key: 'note', kind: 'text', width: 30 },
  { key: 'sentTo', kind: 'text', width: 28 },
  { key: 'decidedAt', kind: 'datetime' },
  { key: 'decidedBy', kind: 'text' },
  { key: 'approvedAmount', kind: 'money' },
  { key: 'approvedPercent', kind: 'percent' },
  { key: 'message', kind: 'text', width: 30 },
];

export interface ApprovalLabels {
  status: (s: ApprovalStatus) => string;
}

/** One request as the export writes it (and the screen sorts / searches it). */
export function approvalRowValues(card: ApprovalCard, labels: ApprovalLabels): Record<ApprovalColumnKey, ExcelValue> {
  return {
    createdAt: card.createdAt || null,
    type: card.typeLabel || card.type,
    status: labels.status(card.status),
    shop: card.shopName,
    till: placeOf(card) || null,
    table: card.tableLabel,
    requester: card.requesterName,
    amount: card.amount,
    percent: card.percent,
    reason: reasonOf(card) || null,
    note: card.note,
    sentTo: card.sentTo.map((r) => r.name).filter(Boolean).join(', ') || null,
    decidedAt: card.decidedAt,
    decidedBy: card.decidedByName,
    approvedAmount: card.approvedAmount,
    approvedPercent: card.approvedPercent,
    message: card.message,
  };
}

/** The approver filter's choices: the users the server lists, plus anyone who decided a row. */
export function approverOptions(
  users: Array<{ id: string; name: string }>,
  rows: Array<Pick<ApprovalCard, 'decidedByUserId' | 'decidedByName'>>,
): Array<{ value: string; label: string }> {
  const seen = new Map<string, string>();
  for (const u of users) if (u.id) seen.set(u.id, u.name || u.id);
  for (const r of rows) if (r.decidedByUserId && !seen.has(r.decidedByUserId)) seen.set(r.decidedByUserId, r.decidedByName ?? r.decidedByUserId);
  return [...seen.entries()].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label, 'he'));
}

// ── The policy (§4) ──────────────────────────────────────────────────────────

export type FieldKind = 'bool' | 'enum' | 'int' | 'methods' | 'roles' | 'strings' | 'roleLimits' | 'roleBools';

export interface CatalogType {
  key: string;
  label: string;
  phase: number;
  limitUnit: LimitUnit | null;
  sees: string;
}

export interface CatalogRole {
  key: string;
  label: string;
  kind: 'till' | 'dash';
}

export interface CatalogField {
  key: string;
  label: string;
  kind: FieldKind;
  options?: string[];
  min?: number;
  max?: number;
  nullable?: boolean;
}

export type FieldValues = Record<string, unknown>;

/**
 * "סגנון האישור" (P:\specs\table-restore-payments.md §4): how a manager answers a till permission
 * that needs approval — `approve` ("אישור מנהל": the action stays the employee's), `takeover`
 * ("מנהל מבצע": the manager does it as themselves, once) or `both` (the sheet offers the two).
 */
export type ApprovalStyle = 'approve' | 'takeover' | 'both';
/** A level's word for every permission it does not name. */
export const STYLE_ALL = '*';

export interface StylePermission {
  code: string;
  label: string;
  group: string;
}

export interface StyleCatalog {
  options: ApprovalStyle[];
  default: ApprovalStyle;
  permissions: StylePermission[];
}

export interface ApprovalCatalog {
  levels: PolicyLevel[];
  types: CatalogType[];
  roles: CatalogRole[];
  fields: CatalogField[];
  defaults?: { enabled: boolean; types: Record<string, FieldValues> };
  approvalStyle?: StyleCatalog;
}

/** What one level sets: `enabled` null and a missing field = inherit. */
export interface PolicyDoc {
  enabled: boolean | null;
  types: Record<string, FieldValues>;
  /** `{code | "*": style}` — a missing code inherits. Always sent: the PUT replaces the whole doc. */
  approvalStyle?: Record<string, ApprovalStyle>;
}

export interface PolicyResponse {
  level: PolicyLevel;
  id: string;
  canWrite: boolean;
  own: PolicyDoc;
  inherited: { enabled: boolean; types: Record<string, FieldValues>; approvalStyle?: Record<string, ApprovalStyle> };
  inheritedSources: {
    enabled: string | null;
    types: Record<string, Record<string, string | null>>;
    approvalStyle?: Record<string, string | null>;
  };
  effective: { enabled: boolean; types: Record<string, FieldValues>; approvalStyle?: Record<string, ApprovalStyle> };
  catalog: ApprovalCatalog;
}

/** Escalation: in this level's own values 0 is "off here"; inherited / effective off is null. */
export const ESCALATE_FIELD = 'escalateAfterSeconds';
/** The fixed reasons: at most this many, each at most `REASON_MAX_LENGTH` characters. */
export const REASONS_MAX = 20;
export const REASON_MAX_LENGTH = 60;

const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

/** This level's own values as an editable draft (nulls dropped: a missing field inherits). */
export function draftFromPolicy(resp: Pick<PolicyResponse, 'own'>): PolicyDoc {
  const types: Record<string, FieldValues> = {};
  for (const [type, fields] of Object.entries(resp.own?.types ?? {})) {
    const kept: FieldValues = {};
    for (const [k, v] of Object.entries(fields ?? {})) if (v !== null && v !== undefined) kept[k] = clone(v);
    if (Object.keys(kept).length) types[type] = kept;
  }
  const enabled = resp.own?.enabled;
  return {
    enabled: enabled === true || enabled === false ? enabled : null,
    types,
    approvalStyle: cleanStyles(resp.own?.approvalStyle),
  };
}

export function isApprovalStyle(v: unknown): v is ApprovalStyle {
  return v === 'approve' || v === 'takeover' || v === 'both';
}

/** A style map with nulls and unknown values dropped, keys in a stable order. */
function cleanStyles(raw: unknown): Record<string, ApprovalStyle> {
  const out: Record<string, ApprovalStyle> = {};
  const map = asObject(raw);
  for (const code of Object.keys(map).sort()) if (isApprovalStyle(map[code])) out[code] = map[code] as ApprovalStyle;
  return out;
}

/** Set (or with null, inherit) one field of one type at this level. Returns a new draft. */
export function setOwnField(draft: PolicyDoc, type: string, field: string, value: unknown): PolicyDoc {
  const fields = { ...(draft.types[type] ?? {}) };
  if (value === null || value === undefined) delete fields[field];
  else fields[field] = value;
  const types = { ...draft.types };
  if (Object.keys(fields).length) types[type] = fields;
  else delete types[type];
  return { ...draft, types };
}

/** Every field of a type back to inherit. */
export function clearOwnType(draft: PolicyDoc, type: string): PolicyDoc {
  const types = { ...draft.types };
  delete types[type];
  return { ...draft, types };
}

/** The `PUT /approvals/policy` body: the whole own document, fields in a stable order. */
export function policyBody(draft: PolicyDoc): PolicyDoc {
  const types: Record<string, FieldValues> = {};
  for (const type of Object.keys(draft.types).sort()) {
    const fields = draft.types[type];
    const kept: FieldValues = {};
    for (const k of Object.keys(fields).sort()) if (fields[k] !== null && fields[k] !== undefined) kept[k] = fields[k];
    if (Object.keys(kept).length) types[type] = kept;
  }
  return { enabled: draft.enabled, types, approvalStyle: cleanStyles(draft.approvalStyle) };
}

export function policyDirty(draft: PolicyDoc, resp: Pick<PolicyResponse, 'own'>): boolean {
  return JSON.stringify(policyBody(draft)) !== JSON.stringify(policyBody(draftFromPolicy(resp)));
}

export function ownValue(draft: PolicyDoc, type: string, field: string): unknown {
  return draft.types[type]?.[field];
}

export function isOverridden(draft: PolicyDoc, type: string, field: string): boolean {
  const v = ownValue(draft, type, field);
  return v !== null && v !== undefined;
}

export function overriddenCount(draft: PolicyDoc, type: string): number {
  return Object.values(draft.types[type] ?? {}).filter((v) => v !== null && v !== undefined).length;
}

export function inheritedValue(resp: Pick<PolicyResponse, 'inherited'>, type: string, field: string): unknown {
  return resp.inherited?.types?.[type]?.[field];
}

/** The level an inherited value comes from ("company"…), or null for the built-in default. */
export function inheritedSource(resp: Pick<PolicyResponse, 'inheritedSources'>, type: string, field: string): string | null {
  return resp.inheritedSources?.types?.[type]?.[field] ?? null;
}

/** What applies with the draft: this level's value, else the inherited one (escalation 0 → off/null). */
export function effectiveValue(draft: PolicyDoc, resp: Pick<PolicyResponse, 'inherited'>, type: string, field: string): unknown {
  const own = ownValue(draft, type, field);
  if (own !== null && own !== undefined) return field === ESCALATE_FIELD && own === 0 ? null : own;
  return inheritedValue(resp, type, field);
}

export function effectiveEnabled(draft: PolicyDoc, resp: Pick<PolicyResponse, 'inherited'>): boolean {
  return draft.enabled ?? resp.inherited?.enabled === true;
}

/** The value a field starts from when it is first set at this level: what applies now. */
export function overrideStart(field: CatalogField, inherited: unknown): unknown {
  if (field.key === ESCALATE_FIELD) return inherited === null || inherited === undefined ? 0 : inherited;
  if (inherited !== null && inherited !== undefined) return clone(inherited);
  switch (field.kind) {
    case 'bool':
      return false;
    case 'enum':
      return field.options?.[0] ?? '';
    case 'int':
      return field.min ?? 0;
    case 'methods':
    case 'roles':
    case 'strings':
      return [];
    default:
      return {};
  }
}

/** The types of the catalogue by phase ("שלב 1", "שלב 2"…), in the catalogue's order. */
export function typesByPhase(types: CatalogType[]): Array<{ phase: number; types: CatalogType[] }> {
  const out: Array<{ phase: number; types: CatalogType[] }> = [];
  for (const t of types) {
    const phase = Number.isFinite(t.phase) ? t.phase : 1;
    let group = out.find((g) => g.phase === phase);
    if (!group) {
      group = { phase, types: [] };
      out.push(group);
    }
    group.types.push(t);
  }
  return out.sort((a, b) => a.phase - b.phase);
}

/** `limits` / the overrides' ceiling key for a limit unit. */
export function limitKeyOf(unit: LimitUnit | null | undefined): 'maxAmount' | 'maxPercent' | 'maxCount' | null {
  if (unit === 'amount') return 'maxAmount';
  if (unit === 'percent') return 'maxPercent';
  if (unit === 'count') return 'maxCount';
  return null;
}

/** A role's name from the catalogue (an unknown key — a deleted custom role — as itself). */
export function roleLabel(roles: CatalogRole[], key: string): string {
  return roles.find((r) => r.key === key)?.label ?? key;
}

/** Move one item of a list (the reasons' ↑ / ↓). Out of range: the list as it was. */
export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (from < 0 || from >= list.length || to < 0 || to >= list.length || from === to) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

export type ReasonsError = 'tooMany' | 'tooLong' | 'empty' | 'duplicate';

export function reasonsError(list: unknown): ReasonsError | null {
  if (!Array.isArray(list)) return null;
  if (list.length > REASONS_MAX) return 'tooMany';
  const texts = list.map((x) => String(x ?? '').trim());
  if (texts.some((x) => !x)) return 'empty';
  if (texts.some((x) => x.length > REASON_MAX_LENGTH)) return 'tooLong';
  if (new Set(texts).size !== texts.length) return 'duplicate';
  return null;
}

export type FieldError = 'range' | 'notNumber' | 'methods' | ReasonsError | 'limit';

/** The shortest escalation that is not "off" (the catalogue's minimum is 0 = off). */
export const ESCALATE_MIN = 10;

/** An int field's bounds; escalation's lower bound past "off" (0) is `ESCALATE_MIN`. */
export function fieldRange(field: CatalogField): { min?: number; max?: number } {
  if (field.key === ESCALATE_FIELD) return { min: Math.max(field.min ?? 0, ESCALATE_MIN), max: field.max };
  return { min: field.min, max: field.max };
}

/** A field's value against the catalogue (the server checks again; this keeps Save honest). */
export function fieldError(field: CatalogField, value: unknown): FieldError | null {
  if (value === null || value === undefined) return null;
  switch (field.kind) {
    case 'int': {
      if (typeof value !== 'number' || !Number.isInteger(value)) return 'notNumber';
      if (field.key === ESCALATE_FIELD && value === 0) return null;
      const { min, max } = fieldRange(field);
      if (min !== undefined && value < min) return 'range';
      if (max !== undefined && value > max) return 'range';
      return null;
    }
    case 'methods':
      return Array.isArray(value) && value.length > 0 ? null : 'methods';
    case 'strings':
      return reasonsError(value);
    case 'roleLimits': {
      for (const lim of Object.values(asObject(value))) {
        for (const v of Object.values(asObject(lim))) {
          if (v === null || v === undefined) continue;
          if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return 'limit';
        }
      }
      return null;
    }
    default:
      return null;
  }
}

/** Every invalid field of the draft, as `type.field` → error. */
export function policyErrors(draft: PolicyDoc, fields: CatalogField[]): Record<string, FieldError> {
  const out: Record<string, FieldError> = {};
  const byKey = new Map(fields.map((f) => [f.key, f]));
  for (const [type, values] of Object.entries(draft.types)) {
    for (const [key, value] of Object.entries(values)) {
      const field = byKey.get(key);
      const error = field ? fieldError(field, value) : null;
      if (error) out[`${type}.${key}`] = error;
    }
  }
  return out;
}

/** A ceiling typed in a box: '' = none (the key dropped); anything else must be a number ≥ 0. */
export function setRoleLimit(
  limits: Record<string, RoleLimit>,
  role: string,
  key: 'maxAmount' | 'maxPercent' | 'maxCount',
  text: string,
): Record<string, RoleLimit> {
  const next: Record<string, RoleLimit> = { ...limits };
  const entry: RoleLimit = { ...(next[role] ?? {}) };
  if (!text.trim()) delete entry[key];
  else entry[key] = Number(text.trim());
  if (Object.values(entry).some((v) => v !== null && v !== undefined)) next[role] = entry;
  else delete next[role];
  return next;
}

/** The roles a type's `limits` / `onShiftOnly` rows show: its approvers, then any role already set. */
export function rolesForMaps(approverRoles: unknown, ...maps: unknown[]): string[] {
  const out: string[] = Array.isArray(approverRoles) ? approverRoles.map(String) : [];
  for (const m of maps) for (const k of Object.keys(asObject(m))) if (!out.includes(k)) out.push(k);
  return out;
}

// ── "סגנון האישור" per till permission ──────────────────────────────────────

const ALL_STYLES: ApprovalStyle[] = ['approve', 'takeover', 'both'];

/** The catalogue's style block, or the spec's when a server sends none. */
export function styleCatalogOf(catalog: Pick<ApprovalCatalog, 'approvalStyle'> | null | undefined): StyleCatalog {
  const raw = asObject(catalog?.approvalStyle);
  const options = Array.isArray(raw.options) ? raw.options.filter(isApprovalStyle) : [];
  const permissions = (Array.isArray(raw.permissions) ? raw.permissions : [])
    .map((p) => asObject(p))
    .map((p) => ({ code: String(p.code ?? ''), label: str(p.label) ?? String(p.code ?? ''), group: str(p.group) ?? '' }))
    .filter((p) => p.code && p.code !== STYLE_ALL);
  return {
    options: options.length ? options : ALL_STYLES,
    default: isApprovalStyle(raw.default) ? raw.default : 'both',
    permissions,
  };
}

/** The permissions by their till-roles group, in the catalogue's order. */
export function stylePermissionGroups(permissions: StylePermission[]): Array<{ group: string; permissions: StylePermission[] }> {
  const out: Array<{ group: string; permissions: StylePermission[] }> = [];
  for (const p of permissions) {
    let g = out.find((x) => x.group === p.group);
    if (!g) {
      g = { group: p.group, permissions: [] };
      out.push(g);
    }
    g.permissions.push(p);
  }
  return out;
}

/** Set (or with null, inherit) one permission's style — or "*" — at this level. Returns a new draft. */
export function setStyle(draft: PolicyDoc, code: string, style: ApprovalStyle | null): PolicyDoc {
  const next = { ...(draft.approvalStyle ?? {}) };
  if (style === null) delete next[code];
  else next[code] = style;
  return { ...draft, approvalStyle: next };
}

export function ownStyle(draft: PolicyDoc, code: string): ApprovalStyle | null {
  const v = draft.approvalStyle?.[code];
  return isApprovalStyle(v) ? v : null;
}

/**
 * Where a permission's style comes from with the draft: set here for it (`own`), set here for all
 * permissions (`ownAll`, the "*" row), or inherited (`inherited`, with the level — null = default).
 */
export interface StyleResolution {
  style: ApprovalStyle;
  from: 'own' | 'ownAll' | 'inherited';
  source: string | null;
}

export function resolveStyle(
  draft: PolicyDoc,
  resp: Pick<PolicyResponse, 'inherited' | 'inheritedSources'>,
  code: string,
  fallback: ApprovalStyle = 'both',
): StyleResolution {
  const own = ownStyle(draft, code);
  if (own) return { style: own, from: 'own', source: null };
  const all = ownStyle(draft, STYLE_ALL);
  if (all) return { style: all, from: 'ownAll', source: null };
  const inherited = resp.inherited?.approvalStyle?.[code];
  return {
    style: isApprovalStyle(inherited) ? inherited : fallback,
    from: 'inherited',
    source: resp.inheritedSources?.approvalStyle?.[code] ?? null,
  };
}

/**
 * What the "כל ההרשאות" row inherits: one style and one source when every permission inherits the
 * same, else `mixed` (the levels above differ by permission).
 */
export function inheritedStyleSummary(
  resp: Pick<PolicyResponse, 'inherited' | 'inheritedSources'>,
  codes: string[],
  fallback: ApprovalStyle = 'both',
): { style: ApprovalStyle | null; source: string | null; mixed: boolean } {
  if (!codes.length) return { style: fallback, source: null, mixed: false };
  const pairs = codes.map((code) => {
    const v = resp.inherited?.approvalStyle?.[code];
    return { style: isApprovalStyle(v) ? v : fallback, source: resp.inheritedSources?.approvalStyle?.[code] ?? null };
  });
  const same = pairs.every((p) => p.style === pairs[0].style && p.source === pairs[0].source);
  return same ? { ...pairs[0], mixed: false } : { style: null, source: null, mixed: true };
}

/** How many permissions this level names by themselves (the "*" row not counted). */
export function ownStyleCount(draft: PolicyDoc): number {
  return Object.keys(draft.approvalStyle ?? {}).filter((k) => k !== STYLE_ALL && isApprovalStyle(draft.approvalStyle?.[k])).length;
}

// ── Who would receive a level's requests ("מי יקבל בקשות", §5) ───────────────

export type HealthTone = 'green' | 'yellow' | 'red';

/** A user's phones as the push channel sees them (red = none registered). */
export interface ApproverHealth {
  devices: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  tone: HealthTone;
}

export interface PolicyApprover {
  userId: string;
  name: string;
  /** Role names (or keys) as the server gives them. */
  roles: string[];
  /** Request type keys they would receive. */
  types: string[];
  shops: string[];
  hasDevice: boolean;
  health: ApproverHealth;
}

export interface PolicyApprovers {
  items: PolicyApprover[];
  /** Names of those with no phone registered: they get no requests until they register one. */
  withoutDevice: string[];
}

function normalizeHealth(raw: unknown): ApproverHealth {
  const h = asObject(raw);
  const devices = num(h.devices) ?? 0;
  const tone = h.tone === 'green' || h.tone === 'yellow' || h.tone === 'red' ? h.tone : devices > 0 ? 'green' : 'red';
  return { devices, lastSuccessAt: str(h.lastSuccessAt), lastFailureAt: str(h.lastFailureAt), tone };
}

/** `GET /approvals/policy/approvers` read defensively; `withoutDevice` falls back to the items. */
export function normalizeApprovers(raw: unknown): PolicyApprovers {
  const r = asObject(raw);
  const list = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x ?? '')).filter(Boolean) : []);
  const items = (Array.isArray(r.items) ? r.items : [])
    .map((x) => asObject(x))
    .map((x) => {
      const health = normalizeHealth(x.health);
      return {
        userId: String(x.userId ?? ''),
        name: str(x.name) ?? '',
        roles: list(x.roles),
        types: list(x.types),
        shops: list(x.shops),
        hasDevice: typeof x.hasDevice === 'boolean' ? x.hasDevice : health.devices > 0,
        health,
      };
    })
    .filter((x) => x.userId || x.name);
  const withoutDevice = Array.isArray(r.withoutDevice) ? list(r.withoutDevice) : items.filter((i) => !i.hasDevice).map((i) => i.name);
  return { items, withoutDevice };
}

/** Type keys as their catalogue labels, in the catalogue's order (an unknown key as itself, last). */
export function typeLabels(keys: string[], types: Array<Pick<CatalogType, 'key' | 'label'>>): string[] {
  const known = types.filter((t) => keys.includes(t.key)).map((t) => t.label);
  const unknown = keys.filter((k) => !types.some((t) => t.key === k));
  return [...known, ...unknown];
}

// ── An employee's own overrides ("עקיפה לעובד") ─────────────────────────────

export interface ApprovalOverride {
  offShift?: boolean;
  maxAmount?: number;
  maxPercent?: number;
  maxCount?: number;
  noRequests?: boolean;
}

export interface ApprovalOverrides {
  all: ApprovalOverride;
  types: Record<string, ApprovalOverride>;
}

export interface OverrideDraft {
  offShift: boolean;
  noRequests: boolean;
  maxAmount: string;
  maxPercent: string;
  maxCount: string;
}

export const EMPTY_OVERRIDE_DRAFT: OverrideDraft = { offShift: false, noRequests: false, maxAmount: '', maxPercent: '', maxCount: '' };

export function overrideDraftOf(o: ApprovalOverride | null | undefined): OverrideDraft {
  const text = (v: unknown) => (num(v) === null ? '' : String(num(v)));
  return {
    offShift: o?.offShift === true,
    noRequests: o?.noRequests === true,
    maxAmount: text(o?.maxAmount),
    maxPercent: text(o?.maxPercent),
    maxCount: text(o?.maxCount),
  };
}

const CEILINGS = ['maxAmount', 'maxPercent', 'maxCount'] as const;

/** A box that is not empty must be a number ≥ 0 (a count: a whole number). */
export function overrideDraftErrors(d: OverrideDraft): Array<(typeof CEILINGS)[number]> {
  return CEILINGS.filter((k) => {
    const t = d[k].trim();
    if (!t) return false;
    const n = Number(t);
    return !Number.isFinite(n) || n < 0 || (k === 'maxCount' && !Number.isInteger(n));
  });
}

/** Only what is set: false switches and empty ceilings are "as the role says" and left out. */
export function overrideFromDraft(d: OverrideDraft): ApprovalOverride {
  const out: ApprovalOverride = {};
  if (d.offShift) out.offShift = true;
  if (d.noRequests) out.noRequests = true;
  for (const k of CEILINGS) {
    const t = d[k].trim();
    if (t && Number.isFinite(Number(t))) out[k] = Number(t);
  }
  return out;
}

export function isEmptyOverride(o: ApprovalOverride): boolean {
  return Object.keys(o).length === 0;
}

/** The `PUT …/approval-overrides` body: the "all types" row and every type that sets something. */
export function overridesBody(all: OverrideDraft, types: Record<string, OverrideDraft>): ApprovalOverrides {
  const out: ApprovalOverrides = { all: overrideFromDraft(all), types: {} };
  for (const type of Object.keys(types).sort()) {
    const o = overrideFromDraft(types[type]);
    if (!isEmptyOverride(o)) out.types[type] = o;
  }
  return out;
}

// ── Linked employees ("עובד מקושר") ──────────────────────────────────────────

export interface LinkedEmployee {
  posUserId: string;
  name: string;
  username: string | null;
  shopId: string | null;
  shopName: string | null;
  tillRoleName: string | null;
  /** Candidates only: the dashboard user this employee is already linked to. */
  linkedUserId?: string | null;
}

export function normalizeEmployees(raw: unknown): LinkedEmployee[] {
  const items = asObject(raw).items;
  if (!Array.isArray(items)) return [];
  return items
    .map((x) => asObject(x))
    .map((x) => ({
      posUserId: String(x.posUserId ?? ''),
      name: str(x.name) ?? str(x.username) ?? '',
      username: str(x.username),
      shopId: str(x.shopId),
      shopName: str(x.shopName),
      tillRoleName: str(x.tillRoleName),
      linkedUserId: str(x.linkedUserId),
    }))
    .filter((x) => x.posUserId);
}

/** "דנה כהן · סניף מרכז · מנהל". */
export function employeeHint(e: Pick<LinkedEmployee, 'username' | 'shopName' | 'tillRoleName'>): string {
  return [e.username, e.shopName, e.tillRoleName].filter(Boolean).join(' · ');
}

/** Add or remove one employee from the chosen list (by `posUserId`). */
export function toggleEmployee(list: LinkedEmployee[], e: LinkedEmployee): LinkedEmployee[] {
  return list.some((x) => x.posUserId === e.posUserId) ? list.filter((x) => x.posUserId !== e.posUserId) : [...list, e];
}

export function sameEmployeeIds(a: LinkedEmployee[], b: LinkedEmployee[]): boolean {
  const ids = (l: LinkedEmployee[]) => l.map((x) => x.posUserId).sort().join(',');
  return ids(a) === ids(b);
}
