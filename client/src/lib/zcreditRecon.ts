/**
 * "התאמת אשראי מול Z-Credit" (docs/SPEC_ZCREDIT.md "חלק ג׳") — the shapes the server sends and
 * the page's pure rules: categories and their severity, the filters, the CSV (the terminal masked
 * to its last four digits, a card to its last four, nothing more), the cockpit's attention items.
 *
 * Read-only toward Z-Credit: nothing here (or on the page) refunds — "צור זיכוי" opens the
 * existing remote credit / cloud card refund flows on a document of ours.
 */

import type { CsvCell } from './csv';

export type ReconCategory =
  | 'matched'
  | 'amount_mismatch'
  | 'status_mismatch'
  | 'zcredit_only'
  | 'ours_only'
  | 'duplicate'
  | 'deposit_mismatch';

/** Display order: what needs a hand first. */
export const RECON_CATEGORIES: ReconCategory[] = [
  'zcredit_only',
  'ours_only',
  'amount_mismatch',
  'status_mismatch',
  'duplicate',
  'deposit_mismatch',
  'matched',
];

export type ReconSeverity = 'ok' | 'warning' | 'error';

/** ✅ ok · ⚠️ warning · ❌ error — as the server's `CATEGORY_SEVERITY`. */
export const CATEGORY_SEVERITY: Record<ReconCategory, ReconSeverity> = {
  matched: 'ok',
  amount_mismatch: 'warning',
  status_mismatch: 'warning',
  zcredit_only: 'error',
  ours_only: 'error',
  duplicate: 'warning',
  deposit_mismatch: 'warning',
};

export const SEVERITY_MARK: Record<ReconSeverity, string> = { ok: '✅', warning: '⚠️', error: '❌' };

/** ❌ — each one is an exception in the exceptions log. */
export const HARD_CATEGORIES: ReconCategory[] = ['zcredit_only', 'ours_only'];

export interface ReconSummaryEntry {
  count: number;
  /** Shekels, refunds negative. */
  zcredit: number | null;
  ours: number | null;
}

export interface ReconDeposit {
  depositId: string | null;
  status: 'match' | 'difference' | 'missing';
  reason: string;
  zcredit: { debit: number | null; credit: number | null; net: number | null; count: number | null } | null;
  dayRows?: { count: number; net: number | null };
  ours?: {
    transmissions: { id: string; machineId: string; machineName: string | null; startedAt: string | null; amount: number | null; count: number | null }[];
    reportedAmount: number | null;
    reportedCount: number | null;
    legsCount: number;
    legsNet: number | null;
  };
}

export interface ReconRun {
  id: string;
  terminalKey: string;
  terminalLast4: string | null;
  /** "••••1234" — the server never sends more of the terminal. */
  terminal: string;
  businessDate: string;
  timezone: string;
  trigger: 'nightly' | 'manual';
  status: 'running' | 'done' | 'failed';
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  summary: Record<ReconCategory, ReconSummaryEntry>;
  zcreditRows: number;
  ourLegs: number;
  lookups: number;
  openHard: number | null;
  deposits: ReconDeposit[];
  shops: { id: string; name: string }[];
  machines: { id: string; name: string }[];
}

export interface ReconRelated {
  transactionId?: string | null;
  paymentId?: string | null;
  machineId?: string | null;
  documentNumber?: string | null;
  amount?: number | null;
  cardLast4?: string | null;
  localTime?: string | null;
  reference?: string | null;
  zcReference?: string | null;
  cloudCardRefundId?: string | null;
  /** unmatched_document · documented_charge · unmatched_zcredit · cloud_card_refund */
  kind?: string;
}

export interface ReconItem {
  id: string;
  runId: string;
  category: ReconCategory;
  categoryLabel: string;
  severity: ReconSeverity;
  reason: string | null;
  zcredit: {
    reference: string | null;
    amount: number | null;
    statusCode: number | null;
    statusLabel: string | null;
    dealType: string | null;
    isRefund: boolean;
    depositId: string | null;
    cardLast4: string | null;
    cardName: string | null;
    payments: number | null;
    approval: string | null;
    savedAt: string | null;
    source: 'report' | 'lookup' | null;
  } | null;
  ours: {
    transactionId: string | null;
    paymentId: string;
    machineId: string | null;
    machineName: string | null;
    shopId: string | null;
    documentNumber: string | null;
    documentType: number | null;
    amount: number | null;
    status: string | null;
    cardLast4: string | null;
    createdAt: string | null;
    transmitted: boolean | null;
    batch: string | null;
  } | null;
  related: ReconRelated[];
  handled: { at: string | null; by: string | null; note: string | null } | null;
  /** "צור זיכוי": a charge (not a refund) at Z-Credit with no document of ours. */
  canCredit: boolean;
}

export interface ReconRunDetail extends ReconRun {
  items: ReconItem[];
}

export interface ReconTerminal {
  key: string;
  last4: string | null;
  terminal: string;
  enabled: boolean;
  runTime: string;
  shops: { id: string; name: string }[];
  machines: { id: string; name: string; active: boolean }[];
  lastRun: { id: string; businessDate: string; status: string; finishedAt: string | null } | null;
}

export interface ReconProblem {
  machineId: string;
  machineName: string;
  code: string;
  message: string;
}

export interface ReconTerminals {
  terminals: ReconTerminal[];
  problems: ReconProblem[];
  categories: { key: ReconCategory; label: string; severity: ReconSeverity }[];
}

export interface ReconAttention {
  open: number;
  runs: { runId: string; terminalKey: string; terminal: string; businessDate: string; finishedAt: string | null; zcreditOnly: number; oursOnly: number }[];
  failed: { runId: string; terminal: string; businessDate: string; errorMessage: string | null }[];
}

export const PAGE_HREF = '/dashboard/zcredit-reconciliation';

/** The terminal as shown anywhere: its last four digits only. */
export function maskedTerminal(last4: string | null | undefined): string {
  const digits = (last4 ?? '').replace(/\D/g, '').slice(-4);
  return digits ? `••••${digits}` : '••••';
}

/** A card as shown anywhere: its last four digits only, whatever came in. */
export function cardTail(value: string | null | undefined): string | null {
  const digits = (value ?? '').replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : null;
}

/** The day "הרץ התאמה עכשיו" defaults to: yesterday (the nightly run's day). */
export function defaultRunDay(todayIso: string): string {
  const [y, m, d] = todayIso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  t.setUTCDate(t.getUTCDate() - 1);
  return t.toISOString().slice(0, 10);
}

export function reconHref(params: { runId?: string | null; terminalKey?: string | null; date?: string | null } = {}): string {
  const q = new URLSearchParams();
  if (params.runId) q.set('run', params.runId);
  if (params.terminalKey) q.set('terminal', params.terminalKey);
  if (params.date) q.set('date', params.date);
  const s = q.toString();
  return s ? `${PAGE_HREF}?${s}` : PAGE_HREF;
}

export interface ItemFilter {
  categories: ReconCategory[];
  openOnly: boolean;
  search: string;
}

export const DEFAULT_FILTER: ItemFilter = {
  categories: RECON_CATEGORIES.filter((c) => c !== 'matched'),
  openOnly: false,
  search: '',
};

/** The items the table shows: chosen categories, open only, and a free search (reference, document, card, till). */
export function filterItems(items: ReconItem[], filter: ItemFilter): ReconItem[] {
  const q = filter.search.trim().toLowerCase();
  return items.filter((i) => {
    if (filter.categories.length && !filter.categories.includes(i.category)) return false;
    if (filter.openOnly && i.handled) return false;
    if (!q) return true;
    const hay = [
      i.zcredit?.reference,
      i.zcredit?.cardLast4,
      i.zcredit?.depositId,
      i.ours?.documentNumber,
      i.ours?.cardLast4,
      i.ours?.machineName,
      i.ours?.batch,
      i.reason,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return hay.includes(q);
  });
}

/** Per category, how many of [items] (for the chips). */
export function countByCategory(items: ReconItem[]): Record<ReconCategory, number> {
  const out = Object.fromEntries(RECON_CATEGORIES.map((c) => [c, 0])) as Record<ReconCategory, number>;
  for (const i of items) out[i.category] = (out[i.category] ?? 0) + 1;
  return out;
}

/** The documents a Z-Credit charge with no document may belong to — "צור זיכוי" offers these. */
export function creditCandidates(item: ReconItem): ReconRelated[] {
  if (!item.canCredit) return [];
  return item.related.filter((r) => !!r.transactionId && (r.kind === 'unmatched_document' || r.kind === 'documented_charge'));
}

export interface CsvLabels {
  header: string[];
  category: (c: ReconCategory) => string;
  yes: string;
  no: string;
}

export const CSV_COLUMNS = [
  'category', 'severity', 'terminal', 'businessDate', 'zcReference', 'zcSavedAt', 'zcAmount', 'zcStatus', 'zcDeal',
  'zcDeposit', 'zcCard', 'zcPayments', 'zcSource', 'document', 'till', 'oursAmount', 'oursStatus', 'oursCard',
  'oursCreatedAt', 'transmitted', 'batch', 'reason', 'handledAt', 'handledBy', 'handledNote',
] as const;

/** The CSV rows of [items] — values as the server sent them (numbers stay numbers). */
export function itemsCsvRows(run: Pick<ReconRun, 'terminalLast4' | 'businessDate'>, items: ReconItem[], labels: CsvLabels): CsvCell[][] {
  const terminal = maskedTerminal(run.terminalLast4);
  return items.map((i) => [
    labels.category(i.category),
    SEVERITY_MARK[i.severity] ?? '',
    terminal,
    run.businessDate,
    i.zcredit?.reference ?? null,
    i.zcredit?.savedAt ?? null,
    i.zcredit?.amount ?? null,
    i.zcredit ? (i.zcredit.statusLabel ?? i.zcredit.statusCode) : null,
    i.zcredit?.dealType ?? null,
    i.zcredit?.depositId ?? null,
    cardTail(i.zcredit?.cardLast4),
    i.zcredit?.payments ?? null,
    i.zcredit?.source ?? null,
    i.ours?.documentNumber ?? null,
    i.ours?.machineName ?? null,
    i.ours?.amount ?? null,
    i.ours?.status ?? null,
    cardTail(i.ours?.cardLast4),
    i.ours?.createdAt ?? null,
    i.ours ? (i.ours.transmitted ? labels.yes : labels.no) : null,
    i.ours?.batch ?? null,
    i.reason,
    i.handled?.at ?? null,
    i.handled?.by ?? null,
    i.handled?.note ?? null,
  ]);
}

export function csvFileName(run: Pick<ReconRun, 'terminalLast4' | 'businessDate'>): string {
  return `zcredit-reconciliation-${run.businessDate}-${(run.terminalLast4 ?? 'terminal').replace(/\D/g, '') || 'terminal'}.csv`;
}

/** The cockpit's attention items: one per terminal and day with open ❌, and each run Z-Credit could not be read. */
export interface ReconAttentionItem {
  id: string;
  /** As the cockpit's feed orders them (lib/cockpitGates.ts `AttentionSeverity`). */
  severity: 'critical' | 'warning';
  runId: string;
  terminal: string;
  businessDate: string;
  zcreditOnly: number;
  oursOnly: number;
  failed: boolean;
  errorMessage: string | null;
  at: string | null;
  href: string;
}

export function attentionOf(data: ReconAttention | null | undefined): ReconAttentionItem[] {
  if (!data) return [];
  const open = data.runs.map((r) => ({
    id: `zcreditRecon:${r.runId}`,
    severity: 'critical' as const,
    runId: r.runId,
    terminal: r.terminal,
    businessDate: r.businessDate,
    zcreditOnly: r.zcreditOnly,
    oursOnly: r.oursOnly,
    failed: false,
    errorMessage: null,
    at: r.finishedAt,
    href: reconHref({ runId: r.runId }),
  }));
  const failed = data.failed.map((r) => ({
    id: `zcreditRecon:failed:${r.runId}`,
    severity: 'warning' as const,
    runId: r.runId,
    terminal: r.terminal,
    businessDate: r.businessDate,
    zcreditOnly: 0,
    oursOnly: 0,
    failed: true,
    errorMessage: r.errorMessage,
    at: null,
    href: reconHref({ runId: r.runId }),
  }));
  return [...open, ...failed];
}
