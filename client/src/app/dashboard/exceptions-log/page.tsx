'use client';

/**
 * "יומן חריגות" — every exception the system detected, in one log (`/exception-log`):
 * documents, shift closes and till events (the exceptions report's), Z anomalies, failed
 * card payments, refused documents, kiosk and device alerts, training mode, the terminal
 * check bypass. "טופל" with a note per row, the link to the source document / shift / Z, and
 * the SMS each exception made.
 *
 * On the report framework (P:\specs\reports-upgrade.md §5): the days, the dashboard's scope
 * (company ▸ shop ▸ till) and the bar's area, then the kind, the severity, the employee and
 * handled or not (`?kind=&severity=&employee=&handled=`) — all in the URL; the page runs at
 * once on the last 7 days as it always has. Excel and PDF take every row of the filters.
 *
 * An SMS link (`/x/<code>` → `?code=<code>`) opens the one entry it names, whatever its date:
 * no other filter, no summary.
 *
 * On a phone (below `md`, P:/specs/manager-problems.md §4) the log is a card per entry — kind,
 * severity, shop and till, time, amount and "טופל" — instead of the wide table, and the filters
 * open in a bottom sheet. A wide screen is unchanged.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { BellRing, Check, CheckCheck, CircleDot, ExternalLink, MessageSquareText, RotateCcw, ScrollText } from 'lucide-react';
import { AREA_NONE } from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { useAuth } from '@/lib/auth';
import { formatCurrency, formatDateTime } from '@/lib/format';
import { previousWindow, type PreviousPeriod, type ReportChart, type ReportKpi } from '@/lib/designedReport';
import { fetchAllPages } from '@/lib/fetchAllPages';
import { parseReportFilters, type ReportFilterSpec } from '@/lib/reportFilters';
import type { ReportFilterLine } from '@/lib/reportExport';
import { todayIso } from '@/lib/reportWindow';
import { usePageScope } from '@/lib/scope';
import {
  LOG_COLUMNS,
  SEVERITIES,
  dispatchTone,
  exceptionScopeParams,
  logRowValues,
  sourceLinks,
  type LogColumnKey,
  type LogEntry,
  type LogFilters,
  type LogLabels,
  type LogList,
  type LogSummary,
  type Severity,
  type SmsDispatch,
} from '@/lib/exceptionAlerts';
import { acknowledgeLogEntry, fetchLog, fetchLogKinds, fetchLogSummary } from '@/lib/exceptionAlertsApi';
import {
  ReportExportBar,
  ReportPage,
  ReportTable,
  reportQueryState,
  useReportExportScope,
  useReportFilters,
  type ReportColumn,
  type ReportTableSpec,
} from '@/components/dashboard/report-framework';
import { ReportStatCard } from '@/components/dashboard/report-stat-card';
import { ReportErrorState } from '@/components/dashboard/report-window-summary';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

const PAGE_SIZE = 50;
const ANY = '__any__';

/** The days and the area in the bar; kind, severity, employee and handled are the log's own. */
const SPEC: ReportFilterSpec = {
  filters: ['area'],
  extras: { kind: '', severity: '', employee: '', handled: '' },
};

const SEVERITY_TONE: Record<Severity, string> = {
  high: 'bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200',
  medium: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  low: 'bg-slate-200 text-slate-900 dark:bg-slate-800 dark:text-slate-200',
};

const TONE_CLASS = {
  ok: 'border-emerald-300 text-emerald-800 dark:border-emerald-800 dark:text-emerald-300',
  muted: 'border-slate-300 text-slate-700 dark:border-slate-700 dark:text-slate-300',
  warn: 'border-amber-300 text-amber-800 dark:border-amber-800 dark:text-amber-300',
  error: 'border-red-300 text-red-800 dark:border-red-800 dark:text-red-300',
} as const;

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
    <div className="min-w-0 space-y-1">
      <Label className="text-xs">{label}</Label>
      <Select value={value || ANY} onValueChange={(v) => onChange(!v || v === ANY ? '' : String(v))} items={items}>
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

const isSeverity = (v: string): v is Severity => (SEVERITIES as string[]).includes(v);

/** The summary's tiles as the designed PDF's cards (and the period before's), by KPI key. */
function summaryFigures(s: LogSummary): Record<string, number> {
  return { exceptions: s.total, open: s.open, handled: s.acknowledged };
}

export default function ExceptionsLogPage() {
  const t = useTranslations('exceptionsLog');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const urlKey = searchParams.toString();
  const code = (searchParams.get('code') ?? '').trim().toLowerCase();
  const { user } = useAuth();
  const canHandle = !!user?.role && user.role !== 'cashier' && user.role !== 'shift_supervisor';

  const { resolution, effective } = usePageScope({ maxLevel: 'machine' });
  const filters = useReportFilters(SPEC);
  const exportScope = useReportExportScope();
  const today = todayIso();
  // What runs is what the URL says — a fresh visit runs the default days at once, as this
  // page always has (`ready`).
  const url = useMemo(() => parseReportFilters(new URLSearchParams(urlKey), SPEC, today), [urlKey, today]);
  const { from, to, areaId } = url.values;
  const kind = url.extras.kind;
  const severity = isSeverity(url.extras.severity) ? url.extras.severity : '';
  const employee = url.extras.employee;
  const handled = url.extras.handled === 'true' || url.extras.handled === 'false' ? url.extras.handled : '';

  const [page, setPage] = useState(1);
  const [handling, setHandling] = useState<{ row: LogEntry; acknowledged: boolean; note: string } | null>(null);

  const kinds = useQuery({ queryKey: ['exception-log-kinds'], queryFn: fetchLogKinds, staleTime: 60 * 60 * 1000 });

  const { companyId, shopId, machineId } = effective;
  const apiFilters: LogFilters = useMemo(() => {
    // An SMS link names one entry, whatever its date: nothing else narrows it.
    if (code) return { from, to, code };
    return {
      from,
      to,
      // The company only when nothing narrower; the area only as an id (no "ללא אזור" here).
      ...exceptionScopeParams({ companyId, shopId, machineId }, areaId),
      kind: kind || undefined,
      severity: severity || undefined,
      employee: employee || undefined,
      acknowledged: handled,
    };
  }, [areaId, code, companyId, employee, from, handled, kind, machineId, severity, shopId, to]);

  // The endpoint has no "ללא אזור": the bar's choice of it goes back to every area.
  const draftArea = filters.draft.areaId;
  const setDraft = filters.set;
  useEffect(() => {
    if (draftArea !== AREA_NONE) return;
    setDraft({ areaId: '' });
    toast.info(t('report.noAreaNone'));
  }, [draftArea, setDraft, t]);

  // A filter change is a different list: back to its first page.
  const filterKey = JSON.stringify(apiFilters);
  const [seenKey, setSeenKey] = useState(filterKey);
  if (seenKey !== filterKey) {
    setSeenKey(filterKey);
    setPage(1);
  }

  const list = useQuery<LogList>({
    queryKey: ['exception-log', apiFilters, page],
    queryFn: () => fetchLog(apiFilters, page, PAGE_SIZE),
    placeholderData: (prev) => prev,
  });
  const summary = useQuery<LogSummary>({
    queryKey: ['exception-log-summary', apiFilters],
    queryFn: () => fetchLogSummary(apiFilters),
    enabled: !code,
  });

  const handle = useMutation({
    mutationFn: (h: { row: LogEntry; acknowledged: boolean; note: string }) =>
      acknowledgeLogEntry(h.row.id, h.acknowledged, h.note || null),
    onSuccess: () => {
      toast.success(t('saved'));
      setHandling(null);
      qc.invalidateQueries({ queryKey: ['exception-log'] });
      qc.invalidateQueries({ queryKey: ['exception-log-summary'] });
      // The exceptions report's review mirrors "טופל".
      qc.invalidateQueries({ queryKey: ['exceptions'] });
      qc.invalidateQueries({ queryKey: ['exceptions-summary'] });
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });

  const items = useMemo(() => list.data?.items ?? [], [list.data]);
  // Below `md`: a card per entry (the table stays the wide screen's, and the print's).
  const phoneCards = (
    <LogCards
      rows={items}
      code={code}
      canHandle={canHandle}
      onHandle={(row, acknowledged) => setHandling({ row, acknowledged, note: row.note ?? '' })}
    />
  );
  const totalPages = list.data ? Math.max(1, Math.ceil(list.data.total / list.data.pageSize)) : 1;
  const kindOptions = (kinds.data?.kinds ?? []).map((k) => ({ value: k.key, label: k.label }));
  const kindLabel = useCallback(
    (key: string) => kinds.data?.kinds.find((k) => k.key === key)?.label ?? key,
    [kinds.data],
  );
  const smsSent = items.reduce((n, r) => n + r.sms.filter((d) => d.kind !== 'test').length, 0);
  const employeeOptions = useMemo(() => {
    const options = (summary.data?.byEmployee ?? []).map((r) => ({ value: r.key, label: r.label || r.key }));
    // An employee from a link who has nothing in this range still shows as chosen.
    const chosen = filters.draftExtras.employee;
    return chosen && !options.some((o) => o.value === chosen) ? [{ value: chosen, label: chosen }, ...options] : options;
  }, [filters.draftExtras.employee, summary.data]);

  const filterLines = useMemo<ReportFilterLine[]>(() => {
    if (code) return [{ label: t('col.code'), value: code }];
    const lines: ReportFilterLine[] = [];
    if (kind) lines.push({ label: t('kind'), value: kindLabel(kind) });
    if (severity) lines.push({ label: t('severity'), value: t(`severities.${severity}`) });
    if (employee) {
      const row = summary.data?.byEmployee.find((r) => r.key === employee);
      lines.push({ label: t('employee'), value: row?.label || employee });
    }
    if (handled) lines.push({ label: t('statusLabel'), value: handled === 'true' ? t('handled') : t('open') });
    return lines;
  }, [code, employee, handled, kind, kindLabel, severity, summary.data, t]);

  const table = useMemo<ReportTableSpec<LogEntry>>(() => {
    const labels: LogLabels = {
      severity: (s) => t(`severities.${s}`),
      acknowledged: (yes) => (yes ? t('acknowledged.yes') : t('acknowledged.no')),
    };
    // The export's columns and values are `logSheet`'s; the screen keeps the log's look.
    const screen: Partial<Record<LogColumnKey, Partial<ReportColumn<LogEntry>>>> = {
      time: { required: true },
      kind: {
        cell: (r) => (
          <span className="inline-flex items-center gap-1">
            <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap', SEVERITY_TONE[r.severity])}>
              {r.kindLabel}
            </span>
            {r.backfilled ? <Badge variant="secondary">{t('backfilled')}</Badge> : null}
          </span>
        ),
      },
      severity: {
        cell: (r) =>
          r.severity === 'high' ? (
            <Badge variant="outline">{t('severities.high')}</Badge>
          ) : (
            <span className="text-muted-foreground text-xs">{t(`severities.${r.severity}`)}</span>
          ),
      },
      till: {
        cell: (r) =>
          [r.machineName, r.posNumber ? t('register', { n: r.posNumber }) : null].filter(Boolean).join(' · ') || '—',
      },
      employee: {
        cell: (r) => <span className="font-medium">{r.posUserName || r.posUserId || t('noEmployee')}</span>,
      },
      amount: { className: 'font-semibold' },
      details: {
        className: 'min-w-56 whitespace-normal',
        cell: (r) => {
          const measure = r.value != null && (r.kind === 'discount' || r.kind === 'high_tip') ? `${r.value}%` : null;
          const text = [measure, r.summary].filter(Boolean).join(' · ');
          return text ? <span className="text-muted-foreground text-xs">{text}</span> : '—';
        },
      },
      document: {
        cell: (r) => {
          const links = sourceLinks(r);
          return links.length ? (
            <div className="flex flex-wrap items-center gap-3 text-xs">
              {links.map((l) => (
                <Link key={l.kind} href={l.href} className="text-primary inline-flex items-center gap-1 hover:underline">
                  <ExternalLink className="size-3" />
                  {l.kind === 'document'
                    ? l.number
                      ? t('document', { n: l.number })
                      : t('openDocument')
                    : l.kind === 'shift'
                      ? l.number != null
                        ? t('shift', { n: l.number })
                        : t('openShift')
                      : l.number != null
                        ? t('z', { n: String(l.number) })
                        : t('openZ')}
                </Link>
              ))}
            </div>
          ) : (
            '—'
          );
        },
      },
      status: {
        cell: (r) => (
          <Badge variant={r.acknowledged ? 'default' : 'destructive'}>{r.acknowledged ? t('handled') : t('open')}</Badge>
        ),
      },
      acknowledgedBy: {
        className: 'whitespace-normal',
        cell: (r) =>
          r.acknowledged ? (
            <span className="text-muted-foreground text-xs">
              {t('handledBy', { who: r.acknowledgedBy ?? '—', at: formatDateTime(r.acknowledgedAt) })}
            </span>
          ) : (
            '—'
          ),
      },
      note: { className: 'min-w-40 whitespace-normal' },
      sms: {
        className: 'min-w-56 whitespace-normal',
        cell: (r) =>
          r.sms.length ? (
            <div className="flex flex-wrap gap-1.5">
              {r.sms.map((d) => (
                <SmsChip key={d.id} d={d} />
              ))}
            </div>
          ) : (
            '—'
          ),
      },
      // The SMS link's code: in the Excel, as it always was; the screen never showed it.
      code: { exportOnly: true },
    };
    const columns: ReportColumn<LogEntry>[] = LOG_COLUMNS.map((c) => ({
      key: c.key,
      header: t(`col.${c.key}`),
      kind: c.kind,
      width: c.width,
      value: (r: LogEntry) => logRowValues(r, labels)[c.key],
      ...screen[c.key],
    }));
    if (canHandle) {
      columns.push({
        key: 'actions',
        header: t('report.actions'),
        screenOnly: true,
        sortable: false,
        value: () => null,
        cell: (row) =>
          row.acknowledged ? (
            <Button
              size="sm"
              variant="ghost"
              className="print:hidden"
              onClick={() => setHandling({ row, acknowledged: false, note: row.note ?? '' })}
              title={t('reopen')}
            >
              <RotateCcw className="size-4" />
              <span className="hidden sm:inline">{t('reopen')}</span>
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="print:hidden"
              onClick={() => setHandling({ row, acknowledged: true, note: row.note ?? '' })}
              title={t('markHandled')}
            >
              <Check className="size-4" />
              <span className="hidden sm:inline">{t('markHandled')}</span>
            </Button>
          ),
      });
    }
    return {
      id: 'main',
      title: t('title'),
      columns,
      rows: items,
      rowKey: (r) => r.id,
      emptyText: t('empty'),
      // The entry an SMS link named.
      rowClassName: (r) => (code && r.code === code ? 'bg-amber-50 dark:bg-amber-950/30' : undefined),
    };
  }, [canHandle, code, items, t]);

  const exportTables = [table as ReportTableSpec<unknown>];

  // The designed PDF (P:\specs\reports-designed-pdf.md §7): the summary's tiles as cards (not the
  // SMS count — it is this page's), the kinds as bars, the tiles against the period before (the
  // entries themselves have no row to set against another).
  const s = summary.data;
  const kpis: ReportKpi[] = s
    ? [
        { key: 'exceptions', label: t('total'), value: s.total, kind: 'count', better: 'down', icon: 'alert' },
        { key: 'open', label: t('openCount'), value: s.open, kind: 'count', better: 'down' },
        { key: 'handled', label: t('handledCount'), value: s.acknowledged, kind: 'count', better: 'up' },
      ]
    : [];
  const byKind = s ? [...s.byKind].sort((a, b) => b.total - a.total) : [];
  const chart: ReportChart | null = byKind.length
    ? {
        type: 'hbar',
        title: t('byKind'),
        labels: byKind.map((r) => r.label || kindLabel(r.key)),
        series: [{ name: t('col.count'), values: byKind.map((r) => r.total) }],
        kind: 'number',
      }
    : null;
  const previous = async (): Promise<PreviousPeriod | null> => {
    const w = previousWindow(from, to);
    if (!w) return null;
    return { kpis: summaryFigures(await fetchLogSummary({ ...apiFilters, ...w })), ...w };
  };

  // Every entry of these filters, not just this page (the log's largest page is 500).
  const allExportTables = [
    {
      ...table,
      exportRows: () => fetchAllPages((p, pageSize) => fetchLog(apiFilters, p, pageSize), { pageSize: 500 }),
    } as ReportTableSpec<unknown>,
  ];

  const headerLinks = (
    <div className="flex gap-4 text-sm print:hidden">
      <Link href="/dashboard/exceptions" className="text-primary hover:underline">
        {t('reportLink')}
      </Link>
      {canHandle ? (
        <Link href="/dashboard/exception-alerts" className="text-primary inline-flex items-center gap-1 hover:underline">
          <BellRing className="size-4" />
          {t('alertsLink')}
        </Link>
      ) : null}
    </div>
  );

  const pager =
    list.data && list.data.total > PAGE_SIZE ? (
      <div className="flex items-center justify-between text-sm print:hidden">
        <span className="text-muted-foreground">{t('pageOf', { page, pages: totalPages, total: list.data.total })}</span>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            {t('prev')}
          </Button>
          <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
            {t('next')}
          </Button>
        </div>
      </div>
    ) : null;

  const dialog = (
    <Dialog open={handling !== null} onOpenChange={(open) => (!open ? setHandling(null) : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{handling?.acknowledged ? t('handleTitle') : t('reopenTitle')}</DialogTitle>
        </DialogHeader>
        {handling ? (
          <p className="text-muted-foreground text-sm">
            {handling.row.kindLabel} · {formatDateTime(handling.row.occurredAt)}
            {handling.row.amount != null ? ` · ${formatCurrency(handling.row.amount)}` : ''}
          </p>
        ) : null}
        <div className="space-y-2">
          <Label htmlFor="exception-log-note">{t('note')}</Label>
          <textarea
            id="exception-log-note"
            className="border-input bg-background min-h-24 w-full rounded-md border px-3 py-2 text-sm"
            value={handling?.note ?? ''}
            maxLength={2000}
            placeholder={t('notePlaceholder')}
            onChange={(e) => setHandling((h) => (h ? { ...h, note: e.target.value } : h))}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setHandling(null)}>
            {tc('cancel')}
          </Button>
          <Button onClick={() => handling && handle.mutate(handling)} disabled={handle.isPending}>
            {handling?.acknowledged ? t('markHandled') : t('reopen')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  if (code) {
    // An SMS link: the one entry, with no filter bar and no summary — and a way back to the log.
    const clearCode = () => {
      const next = new URLSearchParams(urlKey);
      next.delete('code');
      const query = next.toString();
      router.replace(query ? `${pathname}?${query}` : pathname);
    };
    return (
      <div className="min-w-0 space-y-4 max-sm:px-1">
        {/* As `ReportPage` heads the log. */}
        <div>
          <h1 className="text-2xl font-bold">{t('title')}</h1>
          <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
        </div>
        {headerLinks}
        <Card className="print:hidden">
          <CardContent className="flex flex-wrap items-center justify-between gap-2 pt-4 text-sm">
            <span>{t('codeFilter')}</span>
            <Button variant="outline" size="sm" onClick={clearCode}>
              {t('clearCode')}
            </Button>
          </CardContent>
        </Card>
        {list.isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : list.isError ? (
          <ReportErrorState message={axiosErrorToToastMessage(list.error, tc('error'))} />
        ) : (
          <>
            <ReportExportBar
              reportKey="exceptions-log"
              title={t('title')}
              tables={exportTables}
              from={null}
              to={null}
              business={exportScope.business}
              place={exportScope.place}
              filterLines={filterLines}
              companyId={exportScope.companyId}
              companyName={exportScope.companyName}
              disabled={!items.length}
              // The one entry an SMS named: the designed PDF without a summary or a period before.
              reportType="exceptions-log"
            />
            <div className="hidden md:block print:block">
              <ReportTable table={table} reportKey="exceptions-log" />
            </div>
            {phoneCards}
          </>
        )}
        {dialog}
      </div>
    );
  }

  return (
    <ReportPage
      reportKey="exceptions-log"
      title={t('title')}
      subtitle={t('subtitle')}
      headerExtra={headerLinks}
      resolution={resolution}
      filters={filters}
      bar={{
        shopId,
        children: (
          <>
            <FilterSelect
              label={t('kind')}
              value={filters.draftExtras.kind}
              onChange={(v) => filters.setExtra('kind', v)}
              anyLabel={t('allKinds')}
              options={kindOptions}
            />
            <FilterSelect
              label={t('severity')}
              value={filters.draftExtras.severity}
              onChange={(v) => filters.setExtra('severity', v)}
              anyLabel={t('allSeverities')}
              options={SEVERITIES.map((s) => ({ value: s, label: t(`severities.${s}`) }))}
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
              value={filters.draftExtras.handled}
              onChange={(v) => filters.setExtra('handled', v)}
              anyLabel={t('allStatuses')}
              options={[
                { value: 'false', label: t('open') },
                { value: 'true', label: t('handled') },
              ]}
            />
          </>
        ),
      }}
      query={reportQueryState(list)}
      ready
      phoneFilters={{ label: t('phone.filters'), title: t('phone.filtersTitle') }}
      prompt={t('empty')}
      export={
        list.data
          ? {
              tables: allExportTables,
              filterLines,
              from,
              to,
              reportType: 'exceptions-log',
              kpis,
              chart,
              insightKeys: { label: 'kind', value: 'amount', employee: 'employee' },
              groupBy: ['shop', 'area', 'till'],
              previous,
            }
          : null
      }
    >
      {summary.isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : summary.data ? (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <ReportStatCard title={t('total')} value={String(summary.data.total)} icon={ScrollText} emphasis />
            <ReportStatCard title={t('openCount')} value={String(summary.data.open)} icon={CircleDot} />
            <ReportStatCard title={t('handledCount')} value={String(summary.data.acknowledged)} icon={CheckCheck} />
            <ReportStatCard title={t('smsSent')} value={String(smsSent)} icon={MessageSquareText} />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <CountTable
              title={t('byKind')}
              rows={summary.data.byKind.map((r) => ({ ...r, label: r.label || kindLabel(r.key) }))}
              onPick={(key) => filters.apply({ extras: { kind: key } })}
              money
            />
            <CountTable
              title={t('byEmployee')}
              rows={summary.data.byEmployee.map((r) => ({ ...r, label: r.label || r.key }))}
              onPick={(key) => filters.apply({ extras: { employee: key } })}
            />
          </div>
        </>
      ) : null}

      <div className="hidden md:block print:block">
        <ReportTable table={table} />
      </div>
      {phoneCards}
      {pager}
      {dialog}
    </ReportPage>
  );
}

function CountTable({
  title,
  rows,
  onPick,
  money = false,
}: {
  title: string;
  rows: { key: string; label: string; total: number; open: number; amount?: number }[];
  onPick: (key: string) => void;
  money?: boolean;
}) {
  const t = useTranslations('exceptionsLog');
  return (
    <div className="bg-card rounded-lg border">
      <h2 className="px-4 pt-3 text-sm font-medium">{title}</h2>
      {rows.length === 0 ? (
        <p className="text-muted-foreground px-4 py-6 text-center text-sm">{t('empty')}</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-muted-foreground text-xs">
              <th className="px-4 py-2 text-start font-medium">{t('col.name')}</th>
              <th className="px-2 py-2 text-end font-medium">{t('col.count')}</th>
              <th className="px-2 py-2 text-end font-medium">{t('openCount')}</th>
              {money ? <th className="px-4 py-2 text-end font-medium">{t('col.amount')}</th> : null}
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.slice(0, 12).map((r) => (
              <tr key={r.key} className="hover:bg-muted/50 cursor-pointer" onClick={() => onPick(r.key)}>
                <td className="px-4 py-2">{r.label}</td>
                <td className="px-2 py-2 text-end tabular-nums">{r.total}</td>
                <td className="px-2 py-2 text-end tabular-nums">{r.open || '—'}</td>
                {money ? (
                  <td className="px-4 py-2 text-end tabular-nums">{r.amount ? formatCurrency(r.amount) : '—'}</td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function SmsChip({ d }: { d: SmsDispatch }) {
  const t = useTranslations('exceptionAlerts');
  const kind = d.kind !== 'alert' ? `${t(`dispatchKinds.${d.kind}`)} · ` : '';
  return (
    <span
      className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs', TONE_CLASS[dispatchTone(d.status)])}
      title={[d.ruleName, d.text].filter(Boolean).join('\n')}
    >
      <MessageSquareText className="size-3" />
      {kind}
      {d.statusLabel}
      <span className="opacity-80">· {d.recipientLabel || d.recipient}</span>
    </span>
  );
}

/** The log on a phone: one card per entry (P:/specs/manager-problems.md §4). */
function LogCards({
  rows,
  code,
  canHandle,
  onHandle,
}: {
  rows: LogEntry[];
  code: string;
  canHandle: boolean;
  onHandle: (row: LogEntry, acknowledged: boolean) => void;
}) {
  const t = useTranslations('exceptionsLog');
  if (rows.length === 0) {
    return (
      <p className="text-muted-foreground bg-card rounded-lg border py-8 text-center text-sm md:hidden print:hidden">{t('empty')}</p>
    );
  }
  return (
    <ul className="space-y-2 md:hidden print:hidden">
      {rows.map((r) => {
        const till = [r.machineName, r.posNumber ? t('register', { n: r.posNumber }) : null].filter(Boolean).join(' · ');
        const place = [r.shopName, till].filter(Boolean).join(' · ');
        const links = sourceLinks(r);
        return (
          <li
            key={r.id}
            className={cn(
              'bg-card rounded-xl border p-3',
              code && r.code === code && 'border-amber-400 bg-amber-50 dark:bg-amber-950/30',
              r.acknowledged && 'opacity-75',
            )}
          >
            <div className="flex items-start justify-between gap-2">
              <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', SEVERITY_TONE[r.severity])}>{r.kindLabel}</span>
              <span className="text-muted-foreground shrink-0 text-xs tabular-nums">{formatDateTime(r.occurredAt)}</span>
            </div>
            <div className="mt-2 flex items-baseline justify-between gap-3">
              <span className="min-w-0 text-sm break-words">{place || '—'}</span>
              {r.amount != null ? (
                <span className="shrink-0 font-semibold tabular-nums" title={t('phone.amount')}>
                  {formatCurrency(r.amount)}
                </span>
              ) : null}
            </div>
            {r.summary ? <p className="text-muted-foreground mt-1 line-clamp-2 text-xs">{r.summary}</p> : null}
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <span className="flex flex-wrap items-center gap-2 text-xs">
                <span className="text-muted-foreground">{t(`severities.${r.severity}`)}</span>
                {links.map((l) => (
                  <Link key={l.kind} href={l.href} className="text-primary inline-flex min-h-8 items-center gap-1 hover:underline">
                    <ExternalLink className="size-3" />
                    {l.kind === 'document'
                      ? l.number
                        ? t('document', { n: l.number })
                        : t('openDocument')
                      : l.kind === 'shift'
                        ? l.number != null
                          ? t('shift', { n: l.number })
                          : t('openShift')
                        : l.number != null
                          ? t('z', { n: String(l.number) })
                          : t('openZ')}
                  </Link>
                ))}
              </span>
              {canHandle ? (
                <Button
                  size="sm"
                  variant={r.acknowledged ? 'ghost' : 'outline'}
                  className="min-h-10"
                  onClick={() => onHandle(r, !r.acknowledged)}
                >
                  {r.acknowledged ? <RotateCcw className="size-4" /> : <Check className="size-4" />}
                  {r.acknowledged ? t('reopen') : t('markHandled')}
                </Button>
              ) : (
                <Badge variant={r.acknowledged ? 'default' : 'destructive'}>
                  {r.acknowledged ? t('phone.handledShort') : t('phone.openShort')}
                </Badge>
              )}
            </div>
            {r.acknowledged && r.acknowledgedBy ? (
              <p className="text-muted-foreground mt-1 text-xs">
                {t('handledBy', { who: r.acknowledgedBy, at: formatDateTime(r.acknowledgedAt) })}
              </p>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
