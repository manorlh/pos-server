'use client';

/**
 * Exceptions ("חריגות"): what a manager wants to look at after the fact — discounts,
 * refunds, cancelled baskets and voided lines, long orders, high tips, cash differences
 * at close and more — detected by the cloud from what the tills push (`/exceptions`).
 *
 * On the report framework (P:\specs\reports-upgrade.md §5): the days, the dashboard's scope
 * (company ▸ shop ▸ till) and the bar's area, then the type, the employee and the status
 * (`?type=&employee=&status=`) — all in the URL, and the page runs at once on the last 7 days
 * as it always has. A summary per type and per employee (a click narrows the list), then the
 * list, 50 a page, each row reviewed or dismissed with a note (one or a selection). Excel and
 * PDF take every row of the filters, not just the page. Rules (on/off and thresholds per
 * level) are on the "הגדרות חריגות" page.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Check, ExternalLink, RefreshCw, RotateCcw, ShieldAlert, X } from 'lucide-react';
import { AREA_NONE } from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { useAuth } from '@/lib/auth';
import { exceptionScopeParams } from '@/lib/exceptionAlerts';
import { formatCurrency, formatDateTime, formatTime } from '@/lib/format';
import { fetchAllPages } from '@/lib/fetchAllPages';
import { parseReportFilters, type ReportFilterSpec } from '@/lib/reportFilters';
import type { ReportFilterLine } from '@/lib/reportExport';
import { todayIso } from '@/lib/reportWindow';
import { usePageScope } from '@/lib/scope';
import {
  EXCEPTION_TYPES,
  fetchExceptionSummary,
  fetchExceptions,
  rescanExceptions,
  reviewException,
  reviewExceptions,
  type AuditException,
  type ExceptionFilters,
  type ExceptionList,
  type ExceptionStatus,
  type ExceptionSummary,
  type ExceptionType,
} from '@/lib/exceptionsApi';
import {
  ReportPage,
  ReportTable,
  reportQueryState,
  useReportFilters,
  type ReportColumn,
  type ReportTableSpec,
} from '@/components/dashboard/report-framework';
import { ReportStatCard } from '@/components/dashboard/report-stat-card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { othExceptionLine } from '@/components/dashboard/discounts/oth-club-report';
import { ZExceptionLink, ZMismatchTable } from '@/components/dashboard/z-report/z-exception-details';

const PAGE_SIZE = 50;
const ANY = '__any__';
const STATUSES: ExceptionStatus[] = ['new', 'reviewed', 'dismissed'];

/** The days and the area in the bar; the type, the employee and the status are the report's own. */
const SPEC: ReportFilterSpec = {
  filters: ['area'],
  extras: { type: '', employee: '', status: '' },
};

/** One colour family per type, so the badge reads at a glance. */
const TYPE_TONE: Record<ExceptionType, string> = {
  discount: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  refund: 'bg-rose-100 text-rose-900 dark:bg-rose-950 dark:text-rose-200',
  drawer_open: 'bg-orange-100 text-orange-900 dark:bg-orange-950 dark:text-orange-200',
  line_void: 'bg-slate-200 text-slate-900 dark:bg-slate-800 dark:text-slate-200',
  basket_cancel: 'bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200',
  long_order: 'bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200',
  high_tip: 'bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-200',
  high_amount: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200',
  cash_difference: 'bg-fuchsia-100 text-fuchsia-900 dark:bg-fuchsia-950 dark:text-fuchsia-200',
  after_hours: 'bg-indigo-100 text-indigo-900 dark:bg-indigo-950 dark:text-indigo-200',
  price_override: 'bg-teal-100 text-teal-900 dark:bg-teal-950 dark:text-teal-200',
  card_failures: 'bg-yellow-100 text-yellow-900 dark:bg-yellow-950 dark:text-yellow-200',
  table_cancelled: 'bg-red-200 text-red-950 dark:bg-red-900 dark:text-red-100',
  reprint: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  user_session_release: 'bg-cyan-100 text-cyan-900 dark:bg-cyan-950 dark:text-cyan-200',
  attendance_manual: 'bg-indigo-200 text-indigo-950 dark:bg-indigo-900 dark:text-indigo-100',
  oth: 'bg-pink-100 text-pink-900 dark:bg-pink-950 dark:text-pink-200',
  offline_z_gap: 'bg-amber-200 text-amber-950 dark:bg-amber-900 dark:text-amber-100',
  z_transmission_failed: 'bg-yellow-200 text-yellow-950 dark:bg-yellow-900 dark:text-yellow-100',
  forced_z_close: 'bg-rose-200 text-rose-950 dark:bg-rose-900 dark:text-rose-100',
  offline_z_conflict: 'bg-red-300 text-red-950 dark:bg-red-800 dark:text-red-50',
  support_z_produced: 'bg-purple-200 text-purple-950 dark:bg-purple-900 dark:text-purple-100',
  till_reset: 'bg-purple-200 text-purple-950 dark:bg-purple-900 dark:text-purple-100',
  card_decision_override: 'bg-red-200 text-red-950 dark:bg-red-900 dark:text-red-100',
  till_replaced: 'bg-sky-200 text-sky-950 dark:bg-sky-900 dark:text-sky-100',
  local_server_switched: 'bg-sky-200 text-sky-950 dark:bg-sky-900 dark:text-sky-100',
  local_server_failover: 'bg-red-200 text-red-950 dark:bg-red-900 dark:text-red-100',
  local_server_failover_changed: 'bg-violet-200 text-violet-950 dark:bg-violet-900 dark:text-violet-100',
  shift_closed_from_cloud: 'bg-purple-200 text-purple-950 dark:bg-purple-900 dark:text-purple-100',
  cloud_closed_shift_late_documents: 'bg-orange-200 text-orange-950 dark:bg-orange-900 dark:text-orange-100',
  shop_z_producer_forced: 'bg-amber-200 text-amber-950 dark:bg-amber-900 dark:text-amber-100',
  z_forced_open_shifts: 'bg-amber-200 text-amber-950 dark:bg-amber-900 dark:text-amber-100',
  z_forced_pending_cloud_refund: 'bg-amber-200 text-amber-950 dark:bg-amber-900 dark:text-amber-100',
  local_shop_z_mismatch: 'bg-red-300 text-red-950 dark:bg-red-800 dark:text-red-50',
  local_shop_z_till_unsynced: 'bg-amber-200 text-amber-950 dark:bg-amber-900 dark:text-amber-100',
  kiosk_offline: 'bg-zinc-200 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100',
  zcredit_recon: 'bg-red-200 text-red-950 dark:bg-red-900 dark:text-red-100',
  // "מגירת מזומן" (the drawer spec §11): the drawer's colour family, the gravest darkest.
  drawer_after_close: 'bg-orange-300 text-orange-950 dark:bg-orange-800 dark:text-orange-50',
  drawer_manual_burst: 'bg-orange-200 text-orange-950 dark:bg-orange-900 dark:text-orange-100',
  drawer_manual_over_max: 'bg-orange-200 text-orange-950 dark:bg-orange-900 dark:text-orange-100',
  cash_out_over_threshold: 'bg-rose-100 text-rose-900 dark:bg-rose-950 dark:text-rose-200',
  drawer_count_variance: 'bg-fuchsia-200 text-fuchsia-950 dark:bg-fuchsia-900 dark:text-fuchsia-100',
  drawer_open_near_variance: 'bg-red-200 text-red-950 dark:bg-red-900 dark:text-red-100',
  drawer_open_no_reason: 'bg-orange-100 text-orange-900 dark:bg-orange-950 dark:text-orange-200',
  drawer_open_denied: 'bg-slate-200 text-slate-900 dark:bg-slate-800 dark:text-slate-200',
  // "מדיניות התראות": the board's lights as alerts.
  z_missing: 'bg-red-200 text-red-950 dark:bg-red-900 dark:text-red-100',
  shift_open_overdue: 'bg-amber-200 text-amber-950 dark:bg-amber-900 dark:text-amber-100',
  card_transmission_overdue: 'bg-yellow-200 text-yellow-950 dark:bg-yellow-900 dark:text-yellow-100',
  till_printer: 'bg-zinc-200 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100',
  // "זיהויים חדשים" (P:/specs/push-more.md §C, §B2).
  shop_not_opened: 'bg-zinc-200 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100',
  sales_pace_low: 'bg-emerald-200 text-emerald-950 dark:bg-emerald-900 dark:text-emerald-100',
  table_open_long: 'bg-sky-200 text-sky-950 dark:bg-sky-900 dark:text-sky-100',
  kds_ticket_late: 'bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200',
  till_idle: 'bg-teal-200 text-teal-950 dark:bg-teal-900 dark:text-teal-100',
  // A table's payments (table-restore-payments): the refunds' family.
  payment_reversed: 'bg-rose-200 text-rose-950 dark:bg-rose-900 dark:text-rose-100',
  table_restored: 'bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200',
  // "תמיכה מרחוק": QuickSupport signed by another certificate.
  quicksupport_signer_mismatch: 'bg-violet-200 text-violet-950 dark:bg-violet-900 dark:text-violet-100',
  // "הדפסה בקופה אחרת": a bill that did not print on another till — the printers' family.
  document_unprinted: 'bg-orange-200 text-orange-950 dark:bg-orange-900 dark:text-orange-100',
};

function TypeBadge({ type }: { type: ExceptionType }) {
  const t = useTranslations('exceptions');
  return (
    <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap', TYPE_TONE[type])}>
      {t(`types.${type}`)}
    </span>
  );
}

function StatusBadge({ status }: { status: ExceptionStatus }) {
  const t = useTranslations('exceptions');
  const variant = status === 'new' ? 'destructive' : status === 'reviewed' ? 'default' : 'outline';
  return <Badge variant={variant}>{t(`status.${status}`)}</Badge>;
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
  anyLabel,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  anyLabel: string;
}) {
  const items = [{ value: ANY, label: anyLabel }, ...options];
  return (
    <div className="space-y-1 min-w-0">
      <Label className="text-xs">{label}</Label>
      <Select
        value={value || ANY}
        onValueChange={(v) => onChange(!v || v === ANY ? '' : String(v))}
        items={items}
      >
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {items.map((o) => (
            <SelectItem key={o.value} value={o.value} label={o.label}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

const isType = (v: string): v is ExceptionType => (EXCEPTION_TYPES as readonly string[]).includes(v);
const isStatus = (v: string): v is ExceptionStatus => (STATUSES as string[]).includes(v);

export default function ExceptionsPage() {
  const t = useTranslations('exceptions');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const { user } = useAuth();
  const canReview = !!user?.role && user.role !== 'cashier' && user.role !== 'shift_supervisor';

  const { resolution, effective } = usePageScope({ maxLevel: 'machine' });
  const filters = useReportFilters(SPEC);
  const searchParams = useSearchParams();
  const urlKey = searchParams.toString();
  const today = todayIso();
  // What runs is what the URL says — a fresh visit runs the default days at once, as this
  // page always has (`ready`), and a link with a type or an employee runs it as well.
  const url = useMemo(() => parseReportFilters(new URLSearchParams(urlKey), SPEC, today), [urlKey, today]);
  const type = isType(url.extras.type) ? url.extras.type : '';
  const employee = url.extras.employee;
  const status = isStatus(url.extras.status) ? url.extras.status : '';
  const { from, to, areaId } = url.values;

  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [reviewing, setReviewing] = useState<{ ids: string[]; status: ExceptionStatus; note: string } | null>(
    null,
  );

  const { companyId, shopId, machineId } = effective;
  const apiFilters: ExceptionFilters = useMemo(
    () => ({
      from,
      to,
      // The company only when nothing narrower; the area only as an id (no "ללא אזור" here).
      ...exceptionScopeParams({ companyId, shopId, machineId }, areaId),
      type: type || undefined,
      employee: employee || undefined,
      status: status || undefined,
    }),
    [areaId, companyId, employee, from, machineId, shopId, status, to, type],
  );

  // The endpoint has no "ללא אזור": the bar's choice of it goes back to every area.
  const draftArea = filters.draft.areaId;
  const setDraft = filters.set;
  useEffect(() => {
    if (draftArea !== AREA_NONE) return;
    setDraft({ areaId: '' });
    toast.info(t('report.noAreaNone'));
  }, [draftArea, setDraft, t]);

  // A filter change is a different list: back to its first page, nothing selected.
  const filterKey = JSON.stringify(apiFilters);
  const [seenKey, setSeenKey] = useState(filterKey);
  if (seenKey !== filterKey) {
    setSeenKey(filterKey);
    setPage(1);
    setSelected(new Set());
  }

  const list = useQuery<ExceptionList>({
    queryKey: ['exceptions', apiFilters, page],
    queryFn: () => fetchExceptions(apiFilters, page, PAGE_SIZE),
    placeholderData: (prev) => prev,
  });
  const summary = useQuery<ExceptionSummary>({
    queryKey: ['exceptions-summary', apiFilters],
    queryFn: () => fetchExceptionSummary(apiFilters),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['exceptions'] });
    qc.invalidateQueries({ queryKey: ['exceptions-summary'] });
  };

  const review = useMutation({
    mutationFn: (r: { ids: string[]; status: ExceptionStatus; note: string }) =>
      r.ids.length === 1
        ? reviewException(r.ids[0], r.status, r.note || null).then(() => 1)
        : reviewExceptions(r.ids, r.status, r.note || null).then((x) => x.updated),
    onSuccess: (count) => {
      toast.success(t('reviewSaved', { count }));
      setReviewing(null);
      setSelected(new Set());
      invalidate();
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });

  const rescan = useMutation({
    mutationFn: () =>
      rescanExceptions(from, to, { shopId: shopId || undefined, machineId: machineId || undefined }),
    onSuccess: (r) => {
      toast.success(t('rescanDone', { created: r.created }));
      invalidate();
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });

  const items = useMemo(() => list.data?.items ?? [], [list.data]);
  const totalPages = list.data ? Math.max(1, Math.ceil(list.data.total / list.data.pageSize)) : 1;
  const employeeOptions = useMemo(() => {
    const options = (summary.data?.byEmployee ?? [])
      .filter((r) => r.key)
      .map((r) => ({ value: r.key as string, label: r.label || r.key || '' }));
    // An employee from a link who has nothing in this range still shows as chosen.
    const chosen = filters.draftExtras.employee;
    return chosen && !options.some((o) => o.value === chosen)
      ? [{ value: chosen, label: t('unknownEmployee') }, ...options]
      : options;
  }, [filters.draftExtras.employee, summary.data, t]);

  const filterLines = useMemo<ReportFilterLine[]>(() => {
    const lines: ReportFilterLine[] = [];
    if (type) lines.push({ label: t('type'), value: t(`types.${type}`) });
    if (employee) {
      const row = summary.data?.byEmployee.find((r) => r.key === employee);
      lines.push({ label: t('employee'), value: row?.label || t('unknownEmployee') });
    }
    if (status) lines.push({ label: t('statusLabel'), value: t(`status.${status}`) });
    return lines;
  }, [employee, status, summary.data, t, type]);

  const toggle = useCallback(
    (id: string) =>
      setSelected((s) => {
        const next = new Set(s);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    [],
  );

  const measureOf = useMeasure();
  const table = useMemo<ReportTableSpec<AuditException>>(() => {
    const typeLabel = (k?: string | null) => (k ? t(`types.${k}`) : '—');
    const who = (row: AuditException) =>
      row.posUserName || (row.posUserId ? t('unknownEmployee') : t('noEmployee'));
    const tillOf = (row: AuditException) =>
      [row.machineName, row.posNumber ? t('register', { n: row.posNumber }) : null].filter(Boolean).join(' · ');
    const detailOf = (row: AuditException) => {
      const detail =
        row.type === 'table_cancelled'
          ? tableCancelLine(row.details ?? {}, t)
          : row.type === 'oth'
            ? othExceptionLine(row.details ?? {}, (name) => t('tableCancel.approvedBy', { name }))
            : row.type === 'kiosk_offline'
              ? kioskOfflineLine(row.details ?? {}, t)
              : detailLine(row);
      return [measureOf(row), detail].filter(Boolean).join(' · ') || null;
    };
    const columns: ReportColumn<AuditException>[] = [
      ...(canReview
        ? [
            {
              key: 'select',
              header: t('select'),
              screenOnly: true,
              sortable: false,
              value: () => null,
              cell: (row: AuditException) => (
                <input
                  type="checkbox"
                  className="size-4 print:hidden"
                  checked={selected.has(row.id)}
                  onChange={() => toggle(row.id)}
                  aria-label={t('select')}
                />
              ),
            } satisfies ReportColumn<AuditException>,
          ]
        : []),
      { key: 'time', header: t('col.time'), kind: 'datetime', required: true, value: (r) => r.occurredAt },
      { key: 'type', header: t('col.type'), value: (r) => typeLabel(r.type), cell: (r) => <TypeBadge type={r.type} /> },
      {
        key: 'status',
        header: t('col.status'),
        value: (r) => t(`status.${r.status}`),
        cell: (r) => <StatusBadge status={r.status} />,
      },
      {
        key: 'severity',
        header: t('report.col.severity'),
        value: (r) => t(`report.severity.${r.severity}`),
        cell: (r) =>
          r.severity === 'high' ? (
            <Badge variant="destructive">{t('severityHigh')}</Badge>
          ) : (
            <span className="text-muted-foreground text-xs">{t(`report.severity.${r.severity}`)}</span>
          ),
      },
      {
        key: 'employee',
        header: t('col.employee'),
        value: (r) => (r.posUserId || r.posUserName ? who(r) : null),
        cell: (r) => <span className="font-medium">{who(r)}</span>,
      },
      { key: 'till', header: t('col.till'), value: (r) => tillOf(r) || null },
      { key: 'area', header: t('col.area'), value: (r) => r.areaName ?? null },
      { key: 'shop', header: t('col.shop'), value: (r) => r.shopName ?? null },
      {
        key: 'detail',
        header: t('report.col.detail'),
        value: (r) => detailOf(r),
        className: 'min-w-56 whitespace-normal',
        width: 40,
        cell: (r) => {
          const text = detailOf(r);
          return (
            <div className="space-y-1">
              {text ? <div className="text-muted-foreground text-xs">{text}</div> : null}
              {/* A local shop Z stored as printed: what it printed beside the cloud's check. */}
              {r.type === 'local_shop_z_mismatch' ? <ZMismatchTable details={r.details} /> : null}
              {!text && r.type !== 'local_shop_z_mismatch' ? '—' : null}
            </div>
          );
        },
      },
      { key: 'amount', header: t('col.amount'), kind: 'money', value: (r) => r.amount ?? null, className: 'font-semibold' },
      { key: 'value', header: t('col.value'), kind: 'number', value: (r) => r.value ?? null },
      {
        key: 'document',
        header: t('col.document'),
        value: (r) => r.transactionNumber ?? (r.shiftNumber != null ? `#${r.shiftNumber}` : null),
        cell: (r) => (
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <ZExceptionLink details={r.details} />
            {r.transactionId ? (
              <Link
                href={`/dashboard/transactions?tx=${r.transactionId}`}
                className="text-primary inline-flex items-center gap-1 hover:underline"
              >
                <ExternalLink className="size-3" />
                {r.transactionNumber ? t('document', { n: r.transactionNumber }) : t('openDocument')}
              </Link>
            ) : null}
            {r.shiftId ? (
              <Link
                href={`/dashboard/shifts/${r.shiftId}`}
                className="text-primary inline-flex items-center gap-1 hover:underline"
              >
                <ExternalLink className="size-3" />
                {r.shiftNumber != null ? t('shift', { n: r.shiftNumber }) : t('openShift')}
              </Link>
            ) : null}
          </div>
        ),
      },
      {
        key: 'note',
        header: t('col.note'),
        value: (r) => r.reviewNote ?? null,
        className: 'min-w-48 whitespace-normal',
        width: 30,
        cell: (r) =>
          r.status !== 'new' && (r.reviewedBy || r.reviewNote) ? (
            <span className="text-muted-foreground text-xs">
              {t('reviewedBy', { who: r.reviewedBy ?? '—', at: formatDateTime(r.reviewedAt) })}
              {r.reviewNote ? ` — ${r.reviewNote}` : ''}
            </span>
          ) : (
            '—'
          ),
      },
      { key: 'reviewedBy', header: t('report.col.reviewedBy'), defaultHidden: true, value: (r) => r.reviewedBy ?? null },
      {
        key: 'reviewedAt',
        header: t('report.col.reviewedAt'),
        kind: 'datetime',
        defaultHidden: true,
        value: (r) => r.reviewedAt ?? null,
      },
      ...(canReview
        ? [
            {
              key: 'actions',
              header: t('report.col.actions'),
              screenOnly: true,
              sortable: false,
              value: () => null,
              cell: (row: AuditException) => (
                <div className="flex gap-1 print:hidden">
                  {row.status === 'new' ? (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setReviewing({ ids: [row.id], status: 'reviewed', note: row.reviewNote ?? '' })}
                        title={t('markReviewed')}
                      >
                        <Check className="size-4" />
                        <span className="hidden sm:inline">{t('markReviewed')}</span>
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setReviewing({ ids: [row.id], status: 'dismissed', note: row.reviewNote ?? '' })}
                        title={t('dismiss')}
                      >
                        <X className="size-4" />
                        <span className="hidden sm:inline">{t('dismiss')}</span>
                      </Button>
                    </>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setReviewing({ ids: [row.id], status: 'new', note: row.reviewNote ?? '' })}
                      title={t('reopen')}
                    >
                      <RotateCcw className="size-4" />
                      <span className="hidden sm:inline">{t('reopen')}</span>
                    </Button>
                  )}
                </div>
              ),
            } satisfies ReportColumn<AuditException>,
          ]
        : []),
    ];
    return {
      id: 'main',
      title: t('title'),
      columns,
      rows: items,
      rowKey: (r) => r.id,
      emptyText: t('empty'),
    };
  }, [canReview, items, measureOf, selected, t, toggle]);

  const pickLabel = (r: ExceptionSummary['byType'][number]) =>
    r.label || (r.key ? t('unknownEmployee') : t('noEmployee'));

  return (
    <ReportPage
      reportKey="exceptions"
      title={t('title')}
      subtitle={t('subtitle')}
      headerExtra={
        <Link href="/dashboard/exception-settings" className="text-primary text-sm hover:underline print:hidden">
          {t('settingsLink')}
        </Link>
      }
      resolution={resolution}
      filters={filters}
      bar={{
        shopId,
        children: (
          <>
            <FilterSelect
              label={t('type')}
              value={filters.draftExtras.type}
              onChange={(v) => filters.setExtra('type', v)}
              anyLabel={t('allTypes')}
              options={EXCEPTION_TYPES.map((k) => ({ value: k, label: t(`types.${k}`) }))}
            />
            <FilterSelect
              label={t('employee')}
              value={filters.draftExtras.employee}
              onChange={(v) => filters.setExtra('employee', v)}
              anyLabel={t('allEmployees')}
              options={employeeOptions}
            />
            <FilterSelect
              label={t('statusLabel')}
              value={filters.draftExtras.status}
              onChange={(v) => filters.setExtra('status', v)}
              anyLabel={t('allStatuses')}
              options={STATUSES.map((s) => ({ value: s, label: t(`status.${s}`) }))}
            />
          </>
        ),
      }}
      query={reportQueryState(list)}
      ready
      prompt={t('empty')}
      export={
        list.data
          ? {
              tables: [
                {
                  ...table,
                  // Every exception of these filters, not just this page (the list's largest page is 500).
                  exportRows: () => fetchAllPages((p, pageSize) => fetchExceptions(apiFilters, p, pageSize), { pageSize: 500 }),
                } as ReportTableSpec<unknown>,
              ],
              filterLines,
              from,
              to,
            }
          : null
      }
    >
      {summary.isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : summary.data ? (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <ReportStatCard title={t('total')} value={String(summary.data.total)} icon={ShieldAlert} emphasis />
            <ReportStatCard title={t('status.new')} value={String(summary.data.new)} icon={ShieldAlert} />
            <ReportStatCard title={t('status.reviewed')} value={String(summary.data.reviewed)} icon={Check} />
            <ReportStatCard title={t('status.dismissed')} value={String(summary.data.dismissed)} icon={X} />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <SummaryTable
              title={t('byType')}
              rows={summary.data.byType}
              label={(r) => (r.key ? t(`types.${r.key}`) : '—')}
              onPick={(r) => filters.apply({ extras: { type: r.key ?? '' } })}
            />
            <SummaryTable
              title={t('byEmployee')}
              rows={summary.data.byEmployee}
              label={pickLabel}
              onPick={(r) => filters.apply({ extras: { employee: r.key ?? '' } })}
            />
          </div>
        </>
      ) : null}

      <ReportTable
        table={table}
        actions={
          canReview ? (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => rescan.mutate()}
                disabled={rescan.isPending || from > to}
                title={t('rescanHint')}
              >
                <RefreshCw className={cn('size-4', rescan.isPending && 'animate-spin')} />
                {t('rescan')}
              </Button>
              {selected.size > 0 ? (
                <>
                  <Button size="sm" onClick={() => setReviewing({ ids: [...selected], status: 'reviewed', note: '' })}>
                    <Check className="size-4" />
                    {t('reviewSelected', { count: selected.size })}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setReviewing({ ids: [...selected], status: 'dismissed', note: '' })}
                  >
                    <X className="size-4" />
                    {t('dismissSelected', { count: selected.size })}
                  </Button>
                </>
              ) : null}
            </>
          ) : null
        }
      />

      {list.data && list.data.total > PAGE_SIZE ? (
        <div className="flex items-center justify-between text-sm print:hidden">
          <span className="text-muted-foreground">
            {t('pageOf', { page, pages: totalPages, total: list.data.total })}
          </span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              {t('prev')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              {t('next')}
            </Button>
          </div>
        </div>
      ) : null}

      <Dialog open={reviewing !== null} onOpenChange={(open) => (!open ? setReviewing(null) : undefined)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {reviewing?.status === 'dismissed' ? t('dismissTitle') : t('reviewTitle')}
              {reviewing && reviewing.ids.length > 1 ? ` (${reviewing.ids.length})` : ''}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="exception-note">{t('note')}</Label>
            <textarea
              id="exception-note"
              className="border-input bg-background min-h-24 w-full rounded-md border px-3 py-2 text-sm"
              value={reviewing?.note ?? ''}
              maxLength={2000}
              placeholder={t('notePlaceholder')}
              onChange={(e) => setReviewing((r) => (r ? { ...r, note: e.target.value } : r))}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReviewing(null)}>
              {tc('cancel')}
            </Button>
            <Button onClick={() => reviewing && review.mutate(reviewing)} disabled={review.isPending}>
              {reviewing?.status === 'dismissed' ? t('dismiss') : t('markReviewed')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ReportPage>
  );
}

function SummaryTable({
  title,
  rows,
  label,
  onPick,
}: {
  title: string;
  rows: ExceptionSummary['byType'];
  label: (r: ExceptionSummary['byType'][number]) => string;
  onPick: (r: ExceptionSummary['byType'][number]) => void;
}) {
  const t = useTranslations('exceptions');
  return (
    <div className="rounded-lg border bg-card">
      <h2 className="px-4 pt-3 text-sm font-medium">{title}</h2>
      {rows.length === 0 ? (
        <p className="text-muted-foreground px-4 py-6 text-center text-sm">{t('empty')}</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-muted-foreground text-xs">
              <th className="px-4 py-2 text-start font-medium">{t('col.name')}</th>
              <th className="px-2 py-2 text-end font-medium">{t('col.count')}</th>
              <th className="px-2 py-2 text-end font-medium">{t('status.new')}</th>
              <th className="px-4 py-2 text-end font-medium">{t('col.amount')}</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.slice(0, 12).map((r) => (
              <tr
                key={r.key ?? '__none__'}
                className={cn(r.key && 'hover:bg-muted/50 cursor-pointer')}
                onClick={() => r.key && onPick(r)}
              >
                <td className="px-4 py-2">{label(r)}</td>
                <td className="px-2 py-2 text-end tabular-nums">{r.total}</td>
                <td className="px-2 py-2 text-end tabular-nums">{r.new || '—'}</td>
                <td className="px-4 py-2 text-end tabular-nums">{r.amount ? formatCurrency(r.amount) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** The measured value in words: "12%", "14 דקות"… by type. */
function useMeasure() {
  const t = useTranslations('exceptions');
  return useMemo(
    () =>
      (row: AuditException): string | null => {
        if (row.value == null) return null;
        switch (row.type) {
          case 'discount':
          case 'high_tip':
          case 'sales_pace_low':
            return t('measure.percent', { value: row.value, threshold: row.threshold ?? 0 });
          case 'long_order':
          case 'table_open_long':
          case 'kds_ticket_late':
          case 'till_idle':
            return t('measure.minutes', { value: Math.round(row.value), threshold: row.threshold ?? 0 });
          case 'after_hours': {
            const local = typeof row.details?.localTime === 'string' ? row.details.localTime : String(row.value);
            return t('measure.time', { time: local });
          }
          default:
            return null;
        }
      },
    [t],
  );
}

function detailLine(row: AuditException): string | null {
  const d = row.details ?? {};
  if (typeof d.productName === 'string') return d.productName;
  // Written by the cloud in Hebrew (a forced release: who, from which till, who approved).
  if (typeof d.summary === 'string' && d.summary) return d.summary;
  const lines = (d.lineDiscounts ?? d.lines) as Array<{ name?: string | null }> | undefined;
  if (Array.isArray(lines) && lines.length) {
    return lines
      .map((l) => l?.name)
      .filter(Boolean)
      .slice(0, 3)
      .join(', ');
  }
  return null;
}

/**
 * A cancelled table (table management): "שולחן 12 VIP · לקוח עזב — ריב · אישר: רותי · 3 שורות ·
 * פתוח 42 דק׳", from the details the cloud recorded with it.
 */
function tableCancelLine(
  d: Record<string, unknown>,
  t: ReturnType<typeof useTranslations<'exceptions'>>,
): string {
  const name = typeof d.tableName === 'string' && d.tableName ? ` ${d.tableName}` : '';
  const reason = [d.reason, d.reasonText].filter((x) => typeof x === 'string' && x).join(' — ');
  return [
    d.tableNumber != null ? t('tableCancel.table', { number: String(d.tableNumber), name }) : null,
    reason || null,
    typeof d.approvedBy === 'string' && d.approvedBy ? t('tableCancel.approvedBy', { name: d.approvedBy }) : null,
    typeof d.lineCount === 'number' ? t('tableCancel.lines', { count: d.lineCount }) : null,
    typeof d.openMinutes === 'number' ? t('tableCancel.openMinutes', { minutes: d.openMinutes }) : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** A kiosk offline: "קיוסק כניסה · לא מחובר מ-14:02 עד 14:31", or "… · עדיין לא חזר". */
function kioskOfflineLine(
  d: Record<string, unknown>,
  t: ReturnType<typeof useTranslations<'exceptions'>>,
): string | null {
  const hhmm = (v: unknown) => {
    if (typeof v !== 'string' || !v) return null;
    const at = new Date(v);
    return Number.isNaN(at.getTime()) ? null : formatTime(at);
  };
  const since = hhmm(d.offlineSince);
  if (!since) return typeof d.kiosk === 'string' ? d.kiosk : null;
  const back = hhmm(d.backAt);
  const span = back ? t('kioskOffline.span', { from: since, to: back }) : t('kioskOffline.notBack', { from: since });
  return [typeof d.kiosk === 'string' && d.kiosk ? d.kiosk : null, span].filter(Boolean).join(' · ');
}
