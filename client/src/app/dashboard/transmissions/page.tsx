'use client';

/**
 * "שידורים" (docs/SPEC_REPORTS.md §7): every card transmission report the tills sent the
 * cloud in a range — per till its attempts, successes, failures, amount and last success, what
 * the till says waits now and what our records say beside it — and the reports themselves, with
 * how many sales each batch named and how many were assumed into it. Server:
 * `GET /report-center/transmissions`. One till's history and its untransmitted sales stay on
 * the till's own page (machines → שידור עסקאות).
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { usePageScope } from '@/lib/scope';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { formatCurrency, formatDate, formatDateTime, formatQuantity } from '@/lib/format';
import { daysBackIso, todayIso } from '@/lib/reportWindow';
import { fetchTransmissionsReport, type TransmissionsReport } from '@/lib/reportCenterApi';
import { transmissionsSheets } from '@/lib/reportSheets';
import { ScopeGate } from '@/components/dashboard/scope-gate';
import { ReportExportToolbar } from '@/components/dashboard/report-export-toolbar';
import { ReportErrorState } from '@/components/dashboard/report-window-summary';
import { CenterFilters, scopedIds, type CenterFiltersState } from '@/components/dashboard/report-center/center-filters';
import { STATUS_ROW, Section, SimpleTable } from '@/components/dashboard/report-center/parts';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';

const SCREEN_ROWS = 200;

export default function TransmissionsPage() {
  const t = useTranslations('reportCenter.transmissions');
  const tr = useTranslations('reportCenter');
  const tc = useTranslations('reportCenter.cols');
  const tcommon = useTranslations('common');
  const { scope, resolution, effective } = usePageScope({ maxLevel: 'machine' });

  const [filters, setFilters] = useState<CenterFiltersState>({ from: daysBackIso(6), to: todayIso(), shopIds: [], machineIds: [] });
  const [applied, setApplied] = useState<CenterFiltersState | null>(null);

  const params = useMemo(() => {
    if (!applied) return null;
    const ids = scopedIds(applied, effective, scope);
    return { from: applied.from, to: applied.to, shopIds: ids.shopIds, machineIds: ids.machineIds };
  }, [applied, effective, scope]);

  const { data, isLoading, isFetching, isError, error } = useQuery<TransmissionsReport>({
    queryKey: ['report-transmissions', params],
    queryFn: () => fetchTransmissionsReport(params!),
    enabled: params !== null,
  });

  const byTill = useMemo(() => new Map((data?.byTill ?? []).map((b) => [b.machineId, b])), [data]);

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
              getSheets={() => transmissionsSheets(data, tc)}
            />
            <p className="text-muted-foreground text-xs">
              {`${formatDate(data.window.from)} – ${formatDate(data.window.to)}`}
            </p>

            <Section title={tc('sheetTills')} note={t('tillsNote')}>
              <SimpleTable
                empty={tr('noRows')}
                rows={data.tills}
                rowClassName={(r) => (r.untransmittedCardLegs > 0 || (r.tillPendingCount ?? 0) > 0 ? STATUS_ROW.difference : undefined)}
                columns={[
                  { label: tc('till'), cell: (r) => <Link className="hover:underline" href={`/dashboard/machines/${r.machineId}`}>{r.machineName ?? '—'}</Link> },
                  { label: tc('attempts'), cell: (r) => formatQuantity(byTill.get(r.machineId)?.attempts ?? 0), end: true },
                  { label: tc('success'), cell: (r) => formatQuantity(byTill.get(r.machineId)?.success ?? 0), end: true },
                  { label: tc('failed'), cell: (r) => formatQuantity(byTill.get(r.machineId)?.failed ?? 0), end: true },
                  { label: tc('amount'), cell: (r) => formatCurrency(byTill.get(r.machineId)?.amount ?? 0), end: true },
                  { label: tc('lastSuccessAt'), cell: (r) => (r.lastTransmissionAt ? formatDateTime(r.lastTransmissionAt) : t('never')) },
                  { label: tc('tillPending'), cell: (r) => (r.tillPendingCount === null ? '—' : formatQuantity(r.tillPendingCount)), end: true },
                  {
                    label: tc('untransmittedLegs'),
                    end: true,
                    cell: (r) => (
                      <span className={r.untransmittedCardLegs ? 'font-semibold text-destructive' : undefined}>
                        {formatQuantity(r.untransmittedCardLegs)}
                        {r.untransmittedCardLegs ? ` · ${formatCurrency(r.untransmittedCardAmount)}` : ''}
                      </span>
                    ),
                  },
                  { label: tc('error'), cell: (r) => <span className="text-xs">{r.lastError ?? ''}</span> },
                ]}
              />
            </Section>

            {/* "מסמך שנדחה בענן" — a refused till document can never stay silent. */}
            {(data.refusedDocuments ?? []).length > 0 && (
              <Section title={t('refused', { count: (data.refusedDocuments ?? []).length })} note={t('refusedNote')}>
                <SimpleTable
                  empty={tr('noRows')}
                  rows={data.refusedDocuments ?? []}
                  rowClassName={(r) => (r.landedAt ? undefined : STATUS_ROW.missing)}
                  columns={[
                    { label: tc('till'), cell: (r) => <Link className="hover:underline" href={`/dashboard/machines/${r.machineId}`}>{r.machineName ?? r.machineId.slice(0, 8)}</Link> },
                    {
                      label: tc('documentNumber'),
                      cell: (r) => (
                        <span>
                          {t('refusedSubject')} · <span className="font-mono text-xs">{r.documentNumber ?? r.documentRef}</span>
                        </span>
                      ),
                    },
                    { label: t('refusedReason'), cell: (r) => <span className="text-xs">{r.reason}</span> },
                    { label: t('refusedAttempts'), cell: (r) => formatQuantity(r.attempts), end: true },
                    { label: t('refusedFirstSeen'), cell: (r) => (r.firstSeenAt ? formatDateTime(r.firstSeenAt) : '—') },
                    { label: t('refusedLastSeen'), cell: (r) => (r.lastSeenAt ? formatDateTime(r.lastSeenAt) : '—') },
                    {
                      label: t('refusedState'),
                      cell: (r) =>
                        r.landedAt ? (
                          <Badge variant="secondary">{t('refusedLanded', { at: formatDateTime(r.landedAt) })}</Badge>
                        ) : (
                          <Badge variant="destructive">{t('refusedOpen')}</Badge>
                        ),
                    },
                  ]}
                />
              </Section>
            )}

            <Section title={t('reports', { count: data.count })}>
              <SimpleTable
                empty={tr('noRows')}
                rows={data.items}
                limit={SCREEN_ROWS}
                more={(n) => tr('moreInExcel', { count: n })}
                rowClassName={(r) => (r.status === 'failed' ? STATUS_ROW.missing : r.status === 'unknown' ? STATUS_ROW.difference : undefined)}
                columns={[
                  { label: tc('till'), cell: (r) => r.machineName ?? r.machineId.slice(0, 8) },
                  { label: tc('startedAt'), cell: (r) => formatDateTime(r.startedAt) },
                  { label: tc('receivedAt'), cell: (r) => formatDateTime(r.receivedAt) },
                  { label: tc('trigger'), cell: (r) => tr(`trigger.${r.trigger}`) },
                  {
                    label: tc('status'),
                    cell: (r) => <Badge variant={r.status === 'success' ? 'secondary' : 'destructive'}>{tr(`txStatus.${r.status}`)}</Badge>,
                  },
                  { label: tc('batchNumber'), cell: (r) => <span className="font-mono text-xs">{r.batchNumber ?? '—'}</span> },
                  { label: tc('transactionCount'), cell: (r) => (r.transactionCount === null ? '—' : formatQuantity(r.transactionCount)), end: true },
                  { label: tc('amount'), cell: (r) => formatCurrency(r.amount), end: true },
                  { label: tc('namedTransactions'), cell: (r) => formatQuantity(r.terminalTransactionCount), end: true },
                  { label: tc('assumedTransactions'), cell: (r) => formatQuantity(r.assumedTransactionCount), end: true },
                  { label: tc('error'), cell: (r) => <span className="text-xs">{r.error ?? r.statusMessage ?? ''}</span> },
                ]}
              />
            </Section>
          </div>
        ) : null}
      </ScopeGate>
    </div>
  );
}
