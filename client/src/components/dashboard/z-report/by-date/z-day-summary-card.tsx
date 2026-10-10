'use client';

/**
 * "דוחות Z שהופקו ב־1.10" — the day's (or range's) Zs at a glance: how many, the grand totals,
 * and the same by shop, by area and by kind of Z. By production date unless the list is on
 * business days. Exported as CSV (the summary, and every Z of it).
 */
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { FileDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ReportErrorState } from '@/components/dashboard/report-window-summary';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { downloadCsv } from '@/lib/csv';
import { formatDate } from '@/lib/format';
import { numberedLabel } from '@/lib/orgNumber';
import { csvFileName, zLinesCsv, zSummaryCsv, type ZByDateSummary } from '@/lib/zByDate';
import { fetchZSummaryByDate, type ZByDateFilters } from '@/lib/zByDateApi';
import { ZBreakdownTable, ZTotalsTiles, useZKindLabel } from './z-by-date-parts';

/** The summary of `from`..`to` — one request however many readers (the card, the list's day rows). */
export function useZSummaryByDate(from: string, to: string, filters: ZByDateFilters, closed: ClosedRange = {}) {
  const { closedFrom, closedTo } = closed;
  return useQuery<ZByDateSummary>({
    queryKey: ['z-by-date', 'summary', from, to, filters, closedFrom ?? '', closedTo ?? ''],
    queryFn: () => fetchZSummaryByDate({ ...filters, from, to, closedFrom, closedTo }),
    enabled: Boolean(from && to),
    placeholderData: (prev) => prev,
  });
}

/** The list's "הופק מ/עד" instants (ISO), when set: the card counts what the list shows. */
export type ClosedRange = { closedFrom?: string; closedTo?: string };

export function ZDaySummaryCard({
  from,
  to,
  filters,
  closed,
}: {
  from: string;
  to: string;
  filters: ZByDateFilters;
  closed?: ClosedRange;
}) {
  const t = useTranslations('zByDate');
  const tc = useTranslations('common');
  const tcsv = useTranslations('zByDate.csv');
  const kindLabel = useZKindLabel();
  const basis = filters.dateBasis ?? 'production';
  const { data, isLoading, isError, error } = useZSummaryByDate(from, to, filters, closed);

  const single = from === to;
  const title =
    basis === 'production'
      ? single
        ? t('dayTitle', { date: formatDate(from) })
        : t('rangeTitle', { from: formatDate(from), to: formatDate(to) })
      : single
        ? t('dayTitleBusiness', { date: formatDate(from) })
        : t('rangeTitleBusiness', { from: formatDate(from), to: formatDate(to) });

  return (
    <section className="rounded-lg border bg-card p-4 space-y-3" aria-label={title}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="font-semibold">{title}</h2>
          <p className="text-muted-foreground text-xs">
            {data ? t('count', { count: data.count }) : ' '}
            {data?.window.timezone ? ` · ${t('timezoneNote', { tz: data.window.timezone })}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={!data || data.count === 0}
            onClick={() => data && downloadCsv(csvFileName('summary', data.window), zSummaryCsv(data, tcsv, kindLabel))}
          >
            <FileDown className="h-4 w-4 me-1" aria-hidden />
            {t('exportSummaryCsv')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!data || data.count === 0}
            onClick={() => data && downloadCsv(csvFileName('list', data.window), zLinesCsv(data.zs, tcsv, kindLabel))}
          >
            <FileDown className="h-4 w-4 me-1" aria-hidden />
            {t('exportDayListCsv')}
          </Button>
        </div>
      </div>

      {isError ? (
        <ReportErrorState message={axiosErrorToToastMessage(error, tc('error'))} />
      ) : isLoading || !data ? (
        <Skeleton className="h-16 w-full" />
      ) : data.count === 0 ? (
        <p className="text-muted-foreground text-sm">{single ? t('noneDay') : t('noneRange')}</p>
      ) : (
        <>
          <ZTotalsTiles totals={data.totals} />
          <div className="grid gap-3 lg:grid-cols-2">
            <ZBreakdownTable
              title={t('byShop')}
              rows={data.byShop}
              heads={[t('cols.shop')]}
              cells={(s) => [numberedLabel(s.shopNumber, s.shopName ?? '—')]}
              rowKey={(s) => s.shopId ?? 'none'}
            />
            <ZBreakdownTable
              title={t('byArea')}
              rows={data.byArea}
              heads={[t('cols.shop'), t('cols.area')]}
              cells={(a) => [a.shopName ?? '—', a.areaName ?? <span className="text-muted-foreground">{t('noArea')}</span>]}
              rowKey={(a) => `${a.shopId ?? ''}|${a.areaId ?? ''}`}
            />
          </div>
          <ZBreakdownTable
            title={t('byKind')}
            rows={data.byKind}
            heads={[t('cols.kind')]}
            cells={(k) => [kindLabel(k.kind)]}
            rowKey={(k) => k.kind}
          />
          {!single ? (
            <ZBreakdownTable
              title={basis === 'production' ? t('byProductionDay') : t('byBusinessDay')}
              rows={data.byDay}
              heads={[t('cols.date')]}
              cells={(d) => [d.date ? formatDate(d.date) : '—']}
              rowKey={(d) => d.date ?? 'none'}
            />
          ) : null}
        </>
      )}
    </section>
  );
}
