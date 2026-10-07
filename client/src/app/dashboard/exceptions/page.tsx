'use client';

/**
 * Exceptions ("חריגות"): what a manager wants to look at after the fact — discounts,
 * refunds, cancelled baskets and voided lines, long orders, high tips, cash differences
 * at close and more — detected by the cloud from what the tills push (`/exceptions`).
 *
 * Filters: days, company ▸ shop ▸ point of sale ▸ till (the org cascade), type, employee
 * and status. A summary per type and per employee, then the list, each row reviewed or
 * dismissed with a note. Rules (on/off and thresholds per level) are on the
 * "הגדרות חריגות" page.
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Check, ExternalLink, RefreshCw, RotateCcw, ShieldAlert, X } from 'lucide-react';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { useAuth } from '@/lib/auth';
import { formatCurrency, formatDateTime, formatTime } from '@/lib/format';
import { daysBackIso, todayIso } from '@/lib/reportWindow';
import { fetchAllPages } from '@/lib/fetchAllPages';
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
  ALL_COMPANIES,
  EMPTY_ORG_SCOPE,
  OrgScopeCascade,
  type OrgScope,
} from '@/components/dashboard/org-scope-cascade';
import { ReportExportToolbar } from '@/components/dashboard/report-export-toolbar';
import { ReportStatCard } from '@/components/dashboard/report-stat-card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { DatePicker } from '@/components/ui/date-picker';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { othExceptionLine } from '@/components/dashboard/discounts/oth-club-report';
import { ZExceptionLink, ZMismatchTable } from '@/components/dashboard/z-report/z-exception-details';

const PAGE_SIZE = 50;
const ANY = '__any__';
const STATUSES: ExceptionStatus[] = ['new', 'reviewed', 'dismissed'];

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
  till_replaced: 'bg-sky-200 text-sky-950 dark:bg-sky-900 dark:text-sky-100',
  shop_z_producer_forced: 'bg-amber-200 text-amber-950 dark:bg-amber-900 dark:text-amber-100',
  local_shop_z_mismatch: 'bg-red-300 text-red-950 dark:bg-red-800 dark:text-red-50',
  local_shop_z_till_unsynced: 'bg-amber-200 text-amber-950 dark:bg-amber-900 dark:text-amber-100',
  kiosk_offline: 'bg-zinc-200 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100',
  // "מגירת מזומן" (the drawer spec §11): the drawer's colour family, the gravest darkest.
  drawer_after_close: 'bg-orange-300 text-orange-950 dark:bg-orange-800 dark:text-orange-50',
  drawer_manual_burst: 'bg-orange-200 text-orange-950 dark:bg-orange-900 dark:text-orange-100',
  drawer_manual_over_max: 'bg-orange-200 text-orange-950 dark:bg-orange-900 dark:text-orange-100',
  cash_out_over_threshold: 'bg-rose-100 text-rose-900 dark:bg-rose-950 dark:text-rose-200',
  drawer_count_variance: 'bg-fuchsia-200 text-fuchsia-950 dark:bg-fuchsia-900 dark:text-fuchsia-100',
  drawer_open_near_variance: 'bg-red-200 text-red-950 dark:bg-red-900 dark:text-red-100',
  drawer_open_no_reason: 'bg-orange-100 text-orange-900 dark:bg-orange-950 dark:text-orange-200',
  drawer_open_denied: 'bg-slate-200 text-slate-900 dark:bg-slate-800 dark:text-slate-200',
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

export default function ExceptionsPage() {
  const t = useTranslations('exceptions');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const { user } = useAuth();
  const canReview = !!user?.role && user.role !== 'cashier' && user.role !== 'shift_supervisor';

  const [scope, setScope] = useState<OrgScope>(EMPTY_ORG_SCOPE);
  const [from, setFrom] = useState(daysBackIso(6));
  const [to, setTo] = useState(todayIso());
  const [type, setType] = useState('');
  const [employee, setEmployee] = useState('');
  const [status, setStatus] = useState<string>('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [reviewing, setReviewing] = useState<{ ids: string[]; status: ExceptionStatus; note: string } | null>(
    null,
  );

  const filters: ExceptionFilters | null = useMemo(() => {
    if (!from || !to || from > to) return null;
    return {
      from,
      to,
      companyId: scope.companyId && scope.companyId !== ALL_COMPANIES ? scope.companyId : undefined,
      shopId: scope.shopId || undefined,
      areaId: scope.areaId || undefined,
      machineId: scope.machineId || undefined,
      type: type || undefined,
      employee: employee || undefined,
      status: status || undefined,
    };
  }, [from, to, scope, type, employee, status]);

  // A filter change is a different list: back to its first page, nothing selected.
  const filterKey = JSON.stringify(filters);
  const [seenKey, setSeenKey] = useState(filterKey);
  if (seenKey !== filterKey) {
    setSeenKey(filterKey);
    setPage(1);
    setSelected(new Set());
  }

  const list = useQuery<ExceptionList>({
    queryKey: ['exceptions', filters, page],
    queryFn: () => fetchExceptions(filters!, page, PAGE_SIZE),
    enabled: filters !== null,
    placeholderData: (prev) => prev,
  });
  const summary = useQuery<ExceptionSummary>({
    queryKey: ['exceptions-summary', filters],
    queryFn: () => fetchExceptionSummary(filters!),
    enabled: filters !== null,
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
      rescanExceptions(from, to, { shopId: scope.shopId || undefined, machineId: scope.machineId || undefined }),
    onSuccess: (r) => {
      toast.success(t('rescanDone', { created: r.created }));
      invalidate();
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });

  const items = list.data?.items ?? [];
  const totalPages = list.data ? Math.max(1, Math.ceil(list.data.total / list.data.pageSize)) : 1;
  const typeLabel = (k?: string | null) => (k ? t(`types.${k}`) : '—');
  const who = (row: { posUserName?: string | null; posUserId?: string | null; label?: string | null; key?: string | null }) =>
    row.posUserName || row.label || (row.posUserId || row.key ? t('unknownEmployee') : t('noEmployee'));

  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold">{t('title')}</h1>
          <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
        </div>
        <Link href="/dashboard/exception-settings" className="text-primary text-sm hover:underline print:hidden">
          {t('settingsLink')}
        </Link>
      </div>

      <Card className="print:hidden">
        <CardContent className="space-y-3 pt-4">
          <OrgScopeCascade value={scope} onChange={setScope} allowAll />
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <div className="space-y-1">
              <Label className="text-xs">{t('from')}</Label>
              <DatePicker value={from} onChange={(e) => setFrom(e.target.value)} range={{ from, to, onSelect: (r) => { setFrom(r.from); setTo(r.to); } }} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t('to')}</Label>
              <DatePicker value={to} onChange={(e) => setTo(e.target.value)} range={{ from, to, onSelect: (r) => { setFrom(r.from); setTo(r.to); } }} />
            </div>
            <FilterSelect
              label={t('type')}
              value={type}
              onChange={setType}
              anyLabel={t('allTypes')}
              options={EXCEPTION_TYPES.map((k) => ({ value: k, label: t(`types.${k}`) }))}
            />
            <FilterSelect
              label={t('employee')}
              value={employee}
              onChange={setEmployee}
              anyLabel={t('allEmployees')}
              options={(summary.data?.byEmployee ?? [])
                .filter((r) => r.key)
                .map((r) => ({ value: r.key as string, label: r.label || r.key || '' }))}
            />
            <FilterSelect
              label={t('statusLabel')}
              value={status}
              onChange={setStatus}
              anyLabel={t('allStatuses')}
              options={STATUSES.map((s) => ({ value: s, label: t(`status.${s}`) }))}
            />
          </div>
          {filters === null ? <p className="text-destructive text-xs">{t('badRange')}</p> : null}
        </CardContent>
      </Card>

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
              label={(r) => typeLabel(r.key)}
              onPick={(r) => setType(r.key ?? '')}
            />
            <SummaryTable
              title={t('byEmployee')}
              rows={summary.data.byEmployee}
              label={(r) => who(r)}
              onPick={(r) => setEmployee(r.key ?? '')}
            />
          </div>
        </>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 print:hidden">
        <ReportExportToolbar
          title={t('title')}
          from={from}
          to={to}
          disabled={!items.length}
          // Every exception of these filters, not just this page (the list's largest page is 500).
          getSheets={async () => ({
            name: t('title'),
            columns: [
              { header: t('col.time'), kind: 'datetime' },
              { header: t('col.type') },
              { header: t('col.status') },
              { header: t('col.shop') },
              { header: t('col.area') },
              { header: t('col.till') },
              { header: t('col.employee') },
              { header: t('col.document') },
              { header: t('col.amount'), kind: 'money' },
              { header: t('col.value'), kind: 'number' },
              { header: t('col.note') },
            ],
            rows: (
              await fetchAllPages((p, pageSize) => fetchExceptions(filters!, p, pageSize), { pageSize: 500 })
            ).map((r) => [
              r.occurredAt,
              typeLabel(r.type),
              t(`status.${r.status}`),
              r.shopName ?? null,
              r.areaName ?? null,
              r.machineName ?? null,
              r.posUserId || r.posUserName ? who(r) : null,
              r.transactionNumber ?? (r.shiftNumber != null ? `#${r.shiftNumber}` : null),
              r.amount ?? null,
              r.value ?? null,
              r.reviewNote ?? null,
            ]),
          })}
        />
        {canReview ? (
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => rescan.mutate()}
              disabled={rescan.isPending || filters === null}
              title={t('rescanHint')}
            >
              <RefreshCw className={cn('size-4', rescan.isPending && 'animate-spin')} />
              {t('rescan')}
            </Button>
            {selected.size > 0 ? (
              <>
                <Button
                  size="sm"
                  onClick={() => setReviewing({ ids: [...selected], status: 'reviewed', note: '' })}
                >
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
        ) : null}
      </div>

      <div className="rounded-lg border bg-card">
        {list.isLoading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        ) : list.isError ? (
          <p className="text-destructive p-6 text-center text-sm">
            {axiosErrorToToastMessage(list.error, tc('error'))}
          </p>
        ) : items.length === 0 ? (
          <p className="text-muted-foreground p-10 text-center text-sm">{t('empty')}</p>
        ) : (
          <ul className="divide-y">
            {items.map((row) => (
              <ExceptionRow
                key={row.id}
                row={row}
                who={who(row)}
                canReview={canReview}
                checked={selected.has(row.id)}
                onToggle={() => toggle(row.id)}
                onReview={(s) => setReviewing({ ids: [row.id], status: s, note: row.reviewNote ?? '' })}
              />
            ))}
          </ul>
        )}
      </div>

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
    </div>
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
  return (row: AuditException): string | null => {
    if (row.value == null) return null;
    switch (row.type) {
      case 'discount':
      case 'high_tip':
        return t('measure.percent', { value: row.value, threshold: row.threshold ?? 0 });
      case 'long_order':
        return t('measure.minutes', { value: Math.round(row.value), threshold: row.threshold ?? 0 });
      case 'after_hours': {
        const local = typeof row.details?.localTime === 'string' ? row.details.localTime : String(row.value);
        return t('measure.time', { time: local });
      }
      default:
        return null;
    }
  };
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

function ExceptionRow({
  row,
  who,
  canReview,
  checked,
  onToggle,
  onReview,
}: {
  row: AuditException;
  who: string;
  canReview: boolean;
  checked: boolean;
  onToggle: () => void;
  onReview: (status: ExceptionStatus) => void;
}) {
  const t = useTranslations('exceptions');
  const measure = useMeasure()(row);
  const detail =
    row.type === 'table_cancelled'
      ? tableCancelLine(row.details ?? {}, t)
      : row.type === 'oth'
        ? othExceptionLine(row.details ?? {}, (name) => t('tableCancel.approvedBy', { name }))
        : row.type === 'kiosk_offline'
          ? kioskOfflineLine(row.details ?? {}, t)
          : detailLine(row);
  const till = [row.machineName, row.posNumber ? t('register', { n: row.posNumber }) : null]
    .filter(Boolean)
    .join(' · ');
  return (
    <li className="flex gap-3 px-4 py-3">
      {canReview ? (
        <input
          type="checkbox"
          className="mt-1 size-4 shrink-0 print:hidden"
          checked={checked}
          onChange={onToggle}
          aria-label={t('select')}
        />
      ) : null}
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <TypeBadge type={row.type} />
          <StatusBadge status={row.status} />
          {row.severity === 'high' ? <Badge variant="destructive">{t('severityHigh')}</Badge> : null}
          <span className="text-muted-foreground text-xs">{formatDateTime(row.occurredAt)}</span>
          {row.amount != null ? (
            <span className="ms-auto font-semibold tabular-nums">{formatCurrency(row.amount)}</span>
          ) : null}
        </div>
        <div className="text-sm">
          <span className="font-medium">{who}</span>
          {till ? <span className="text-muted-foreground"> · {till}</span> : null}
          {row.areaName ? <span className="text-muted-foreground"> · {row.areaName}</span> : null}
          {row.shopName ? <span className="text-muted-foreground"> · {row.shopName}</span> : null}
        </div>
        {measure || detail ? (
          <div className="text-muted-foreground text-xs">
            {[measure, detail].filter(Boolean).join(' · ')}
          </div>
        ) : null}
        {/* A local shop Z stored as printed: what it printed beside the cloud's check. */}
        {row.type === 'local_shop_z_mismatch' ? <ZMismatchTable details={row.details} /> : null}
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <ZExceptionLink details={row.details} />
          {row.transactionId ? (
            <Link
              href={`/dashboard/transactions?tx=${row.transactionId}`}
              className="text-primary inline-flex items-center gap-1 hover:underline"
            >
              <ExternalLink className="size-3" />
              {row.transactionNumber ? t('document', { n: row.transactionNumber }) : t('openDocument')}
            </Link>
          ) : null}
          {row.shiftId ? (
            <Link
              href={`/dashboard/shifts/${row.shiftId}`}
              className="text-primary inline-flex items-center gap-1 hover:underline"
            >
              <ExternalLink className="size-3" />
              {row.shiftNumber != null ? t('shift', { n: row.shiftNumber }) : t('openShift')}
            </Link>
          ) : null}
          {row.status !== 'new' && (row.reviewedBy || row.reviewNote) ? (
            <span className="text-muted-foreground">
              {t('reviewedBy', { who: row.reviewedBy ?? '—', at: formatDateTime(row.reviewedAt) })}
              {row.reviewNote ? ` — ${row.reviewNote}` : ''}
            </span>
          ) : null}
        </div>
      </div>
      {canReview ? (
        <div className="flex shrink-0 flex-col gap-1 print:hidden sm:flex-row sm:items-start">
          {row.status === 'new' ? (
            <>
              <Button size="sm" variant="outline" onClick={() => onReview('reviewed')} title={t('markReviewed')}>
                <Check className="size-4" />
                <span className="hidden sm:inline">{t('markReviewed')}</span>
              </Button>
              <Button size="sm" variant="ghost" onClick={() => onReview('dismissed')} title={t('dismiss')}>
                <X className="size-4" />
                <span className="hidden sm:inline">{t('dismiss')}</span>
              </Button>
            </>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => onReview('new')} title={t('reopen')}>
              <RotateCcw className="size-4" />
              <span className="hidden sm:inline">{t('reopen')}</span>
            </Button>
          )}
        </div>
      ) : null}
    </li>
  );
}
