'use client';

/**
 * "דוח התאמה" (docs/SPEC_REPORTS.md §6): the documents against the Zs against the card
 * transmissions, per shop, till, day and Z — every row with a status (תואם / הפרש / חסר /
 * ממתין), the reason, where its documents belong (the till's shift and the shop Z, or the
 * till's own Z) and the owner's action (a link when there is one), coloured on screen and in
 * the Excel.
 * Server: `GET /report-center/reconciliation`.
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { usePageScope } from '@/lib/scope';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { formatCurrency, formatDate, formatDateTime, formatQuantity } from '@/lib/format';
import { daysBackIso, todayIso } from '@/lib/reportWindow';
import {
  fetchReconciliation,
  type Reconciliation,
  type ReconciliationCheck,
  type ReconciliationRow,
  type ReconciliationStatus,
} from '@/lib/reportCenterApi';
import { reconciliationSheets } from '@/lib/reportSheets';
import { ScopeGate } from '@/components/dashboard/scope-gate';
import { ReportExportToolbar } from '@/components/dashboard/report-export-toolbar';
import { ReportErrorState } from '@/components/dashboard/report-window-summary';
import { CenterFilters, scopedIds, type CenterFiltersState } from '@/components/dashboard/report-center/center-filters';
import { STATUS_ROW, Section, SimpleTable, StatusBadge } from '@/components/dashboard/report-center/parts';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

const STATUSES: ReconciliationStatus[] = ['missing', 'difference', 'pending', 'match'];
const SCREEN_ROWS = 300;

export default function ReconciliationPage() {
  const t = useTranslations('reportCenter.reconciliation');
  const tr = useTranslations('reportCenter');
  const tc = useTranslations('reportCenter.cols');
  const tcommon = useTranslations('common');
  const { scope, resolution, effective } = usePageScope({ maxLevel: 'machine' });

  const [filters, setFilters] = useState<CenterFiltersState>({ from: daysBackIso(6), to: todayIso(), shopIds: [], machineIds: [] });
  const [applied, setApplied] = useState<CenterFiltersState | null>(null);
  const [check, setCheck] = useState<ReconciliationCheck | ''>('');
  /** Default: what needs looking at — everything but the matches. */
  const [statuses, setStatuses] = useState<ReconciliationStatus[]>(['missing', 'difference', 'pending']);

  const params = useMemo(() => {
    if (!applied) return null;
    const ids = scopedIds(applied, effective, scope);
    return { from: applied.from, to: applied.to, shopIds: ids.shopIds, machineIds: ids.machineIds };
  }, [applied, effective, scope]);

  const { data, isLoading, isFetching, isError, error } = useQuery<Reconciliation>({
    queryKey: ['report-reconciliation', params],
    queryFn: () => fetchReconciliation(params!),
    enabled: params !== null,
  });

  const rows = useMemo(
    () => (data?.rows ?? []).filter((r) => (!check || r.check === check) && statuses.includes(r.status)),
    [data, check, statuses],
  );
  const toggleStatus = (s: ReconciliationStatus) =>
    setStatuses((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));
  const money = (r: ReconciliationRow, v: number | null) =>
    v === null || v === undefined ? '—' : r.check === 'document_numbers' || r.check === 'z_numbers' ? formatQuantity(v) : formatCurrency(v);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
      </div>

      <ScopeGate resolution={resolution}>
        <CenterFilters
          value={filters}
          onChange={setFilters}
          onRun={() => setApplied(filters)}
          busy={isFetching}
          effective={effective}
          scope={scope}
        />

        {!applied ? (
          <p className="text-muted-foreground py-12 text-center text-sm">{tr('selectFilters')}</p>
        ) : isLoading ? (
          <Skeleton className="h-96 w-full" />
        ) : isError ? (
          <ReportErrorState message={axiosErrorToToastMessage(error, tcommon('error'))} />
        ) : data ? (
          <div className="space-y-4">
            <ReportExportToolbar
              title={t('title')}
              from={data.window.from}
              to={data.window.to}
              getSheets={() => reconciliationSheets(data, tc)}
            />
            <p className="text-muted-foreground text-xs">
              {tr('generated', { at: formatDateTime(data.generatedAt), range: `${formatDate(data.window.from)} – ${formatDate(data.window.to)}` })}
            </p>

            {/* Per check, how many rows of each status — a click narrows the list to it. */}
            <Section title={t('summary')}>
              <SimpleTable
                empty={tr('noRows')}
                rows={data.checks}
                columns={[
                  { label: tc('check'), cell: (c) => <button type="button" className="hover:underline" onClick={() => setCheck(c.key)}>{c.label}</button> },
                  ...STATUSES.map((s) => ({
                    label: tr(`status.${s}`),
                    end: true,
                    cell: (c: { key: ReconciliationCheck }) => {
                      const n = data.summary[c.key]?.[s] ?? 0;
                      return (
                        <button
                          type="button"
                          className={`tabular-nums ${n && s !== 'match' ? 'font-semibold' : 'text-muted-foreground'} hover:underline`}
                          onClick={() => { setCheck(c.key); setStatuses([s]); }}
                        >
                          {formatQuantity(n)}
                        </button>
                      );
                    },
                  })),
                ]}
                footer={[tc('total'), ...STATUSES.map((s) => formatQuantity(data.totals[s] ?? 0))]}
              />
            </Section>

            <div className="flex flex-wrap items-center gap-2 print:hidden">
              <span className="text-muted-foreground text-xs">{tc('check')}</span>
              <Button size="sm" variant={check === '' ? 'default' : 'outline'} className="rounded-full" onClick={() => setCheck('')}>
                {tr('all')}
              </Button>
              {data.checks.map((c) => (
                <Button key={c.key} size="sm" variant={check === c.key ? 'default' : 'outline'} className="rounded-full" onClick={() => setCheck(c.key)}>
                  {c.label}
                </Button>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2 print:hidden">
              <span className="text-muted-foreground text-xs">{tc('status')}</span>
              {STATUSES.map((s) => (
                <Button
                  key={s}
                  size="sm"
                  variant={statuses.includes(s) ? 'default' : 'outline'}
                  className="rounded-full"
                  aria-pressed={statuses.includes(s)}
                  onClick={() => toggleStatus(s)}
                >
                  {tr(`status.${s}`)} ({formatQuantity(data.totals[s] ?? 0)})
                </Button>
              ))}
            </div>

            <Section title={t('rows', { count: rows.length })}>
              <SimpleTable
                empty={t('nothingToShow')}
                rows={rows}
                limit={SCREEN_ROWS}
                more={(n) => tr('moreInExcel', { count: n })}
                rowClassName={(r) => STATUS_ROW[r.status]}
                columns={[
                  { label: tc('status'), cell: (r) => <StatusBadge status={r.status} /> },
                  { label: tc('check'), cell: (r) => <span className="text-xs">{r.checkLabel}</span> },
                  { label: tc('till'), cell: (r) => <>{r.machineName ?? r.shopName ?? '—'}{r.terminal ? <div className="text-muted-foreground text-xs">{r.terminal}</div> : null}</> },
                  { label: tc('day'), cell: (r) => (r.day ? formatDate(r.day) : '—') },
                  {
                    label: tc('zNumber'),
                    cell: (r) => (r.zReportId ? <Link className="hover:underline" href={`/dashboard/z-reports/${r.zReportId}`}>{String(r.zNumber ?? '—')}</Link> : (r.zNumber ?? '—')),
                  },
                  {
                    label: tc('subject'),
                    cell: (r) =>
                      r.transactionId ? (
                        <Link className="hover:underline" href={`/dashboard/transactions?tx=${r.transactionId}`}>{r.subject}</Link>
                      ) : (
                        r.subject
                      ),
                  },
                  { label: tc('count'), cell: (r) => (r.count === null ? '—' : formatQuantity(r.count)), end: true },
                  { label: tc('expected'), cell: (r) => money(r, r.expected), end: true },
                  { label: tc('actual'), cell: (r) => money(r, r.actual), end: true },
                  {
                    label: tc('difference'),
                    end: true,
                    cell: (r) => (
                      <span className={r.difference ? 'font-semibold text-destructive' : undefined}>{money(r, r.difference)}</span>
                    ),
                  },
                  { label: tc('reason'), cell: (r) => <span className="text-xs">{r.reason}</span>, className: 'min-w-80 whitespace-normal' },
                  {
                    label: tc('container'),
                    cell: (r) => <span className="text-xs">{r.container ?? '—'}</span>,
                    className: 'min-w-40 whitespace-normal',
                  },
                  {
                    label: tc('ownerAction'),
                    className: 'min-w-48 whitespace-normal',
                    cell: (r) =>
                      !r.action ? (
                        '—'
                      ) : r.action.href ? (
                        <Link className="text-xs font-medium text-primary hover:underline" href={r.action.href}>
                          {r.action.label}
                        </Link>
                      ) : (
                        <span className="text-xs">{r.action.label}</span>
                      ),
                  },
                ]}
              />
            </Section>
          </div>
        ) : null}
      </ScopeGate>
    </div>
  );
}
