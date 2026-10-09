'use client';

/**
 * "דוחות Z שהופקו באוקטובר" — the month's Zs by production month (or business month), with the
 * totals, the same by day and by shop, and on each Z its documents by the month they are dated
 * in ("₪X מסמכי ספטמבר · ₪Y מסמכי אוקטובר"). VAT reporting and the uniform file go by the
 * document's date — said on the page, every time.
 */
import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { ChevronLeft, ChevronRight, FileDown, Info } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ReportErrorState } from '@/components/dashboard/report-window-summary';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { downloadCsv } from '@/lib/csv';
import { businessToday, formatCurrency, formatDate } from '@/lib/format';
import { numberedLabel } from '@/lib/orgNumber';
import {
  addMonths,
  csvFileName,
  documentMonthsText,
  hasOtherMonthDocuments,
  monthName,
  monthOfDay,
  tillsLabel,
  zLinesCsv,
  zSummaryCsv,
  type ZByDateMonth,
} from '@/lib/zByDate';
import { fetchZMonthByDate, type ZByDateFilters } from '@/lib/zByDateApi';
import { ZBreakdownTable, ZKindBadge, ZTotalsTiles, useZKindLabel } from './z-by-date-parts';

/** Rows drawn on the page; the CSV has every Z. */
const MAX_ROWS = 500;

export function ZMonthView({ filters }: { filters: ZByDateFilters }) {
  const t = useTranslations('zByDate');
  const tc = useTranslations('common');
  const tcsv = useTranslations('zByDate.csv');
  const kindLabel = useZKindLabel();
  const basis = filters.dateBasis ?? 'production';
  const thisMonth = monthOfDay(businessToday());
  const [month, setMonth] = useState(thisMonth);

  const { data, isLoading, isFetching, isError, error } = useQuery<ZByDateMonth>({
    queryKey: ['z-by-date', 'month', month, filters],
    queryFn: () => fetchZMonthByDate({ ...filters, month }),
    placeholderData: (prev) => prev,
  });

  const name = monthName(month, true);
  const title = basis === 'production' ? t('monthTitle', { month: name }) : t('monthTitleBusiness', { month: name });
  const shown = data?.zs.slice(0, MAX_ROWS) ?? [];

  return (
    <section className="space-y-4" aria-label={title}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {/* RTL: the previous month is on the right. */}
          <Button size="sm" variant="outline" aria-label={t('prevMonth')} onClick={() => setMonth((m) => addMonths(m, -1))}>
            <ChevronRight className="h-4 w-4" />
          </Button>
          <h2 className="min-w-48 text-center font-semibold">{title}</h2>
          <Button
            size="sm"
            variant="outline"
            aria-label={t('nextMonth')}
            disabled={month >= thisMonth}
            onClick={() => setMonth((m) => addMonths(m, 1))}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          {month !== thisMonth ? (
            <Button size="sm" variant="ghost" onClick={() => setMonth(thisMonth)}>
              {t('thisMonth')}
            </Button>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={!data || data.count === 0 || isFetching}
            onClick={() => data && downloadCsv(csvFileName('month-summary', data.window), zSummaryCsv(data, tcsv, kindLabel))}
          >
            <FileDown className="h-4 w-4 me-1" aria-hidden />
            {t('exportSummaryCsv')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!data || data.count === 0 || isFetching}
            onClick={() => data && downloadCsv(csvFileName('month', data.window), zLinesCsv(data.zs, tcsv, kindLabel))}
          >
            <FileDown className="h-4 w-4 me-1" aria-hidden />
            {t('exportMonthListCsv')}
          </Button>
        </div>
      </div>

      {/* Always on the month: the books are kept by the document's date, not the Z's. */}
      <div role="note" className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100">
        <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <div>
          <p className="font-medium">{t('monthNote')}</p>
          <p className="text-xs opacity-80">{t('monthNoteDetail')}</p>
        </div>
      </div>

      {isError ? (
        <ReportErrorState message={axiosErrorToToastMessage(error, tc('error'))} />
      ) : isLoading || !data ? (
        <Skeleton className="h-40 w-full" />
      ) : data.count === 0 ? (
        <p className="text-muted-foreground rounded-lg border bg-card p-6 text-center text-sm">{t('noneMonth')}</p>
      ) : (
        <>
          <div className="rounded-lg border bg-card p-4 space-y-3">
            <p className="text-muted-foreground text-xs">
              {t('count', { count: data.count })} · {t('timezoneNote', { tz: data.window.timezone })}
            </p>
            <ZTotalsTiles totals={data.totals} />
            {data.documentMonths.length > 0 ? (
              <p className="text-sm">
                <span className="text-muted-foreground">{t('documentMonthsOfMonth')} </span>
                <span className="tabular-nums">{documentMonthsText(data.documentMonths, data.window.from)}</span>
              </p>
            ) : null}
          </div>

          <div className="grid gap-3 lg:grid-cols-2">
            <ZBreakdownTable
              title={basis === 'production' ? t('byProductionDay') : t('byBusinessDay')}
              rows={data.byDay}
              heads={[t('cols.date')]}
              cells={(d) => [d.date ? formatDate(d.date) : '—']}
              rowKey={(d) => d.date ?? 'none'}
            />
            <div className="space-y-3">
              <ZBreakdownTable
                title={t('byShop')}
                rows={data.byShop}
                heads={[t('cols.shop')]}
                cells={(s) => [numberedLabel(s.shopNumber, s.shopName ?? '—')]}
                rowKey={(s) => s.shopId ?? 'none'}
              />
              <ZBreakdownTable
                title={t('byKind')}
                rows={data.byKind}
                heads={[t('cols.kind')]}
                cells={(k) => [kindLabel(k.kind)]}
                rowKey={(k) => k.kind}
              />
            </div>
          </div>

          <section className="space-y-1">
            <h3 className="text-sm font-medium">{t('monthZs')}</h3>
            <div className="overflow-x-auto rounded-lg border bg-card">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('cols.zNumber')}</TableHead>
                    <TableHead>{t('cols.kind')}</TableHead>
                    <TableHead>{t('cols.producedAt')}</TableHead>
                    <TableHead>{t('cols.businessDay')}</TableHead>
                    <TableHead>{t('cols.where')}</TableHead>
                    <TableHead className="text-end">{t('totals.totalSales')}</TableHead>
                    <TableHead className="text-end">{t('totals.vatTotal')}</TableHead>
                    <TableHead className="text-end">{t('totals.cashSales')}</TableHead>
                    <TableHead className="text-end">{t('totals.cardSales')}</TableHead>
                    <TableHead className="text-end">{t('totals.totalTips')}</TableHead>
                    <TableHead className="text-end">{t('totals.documents')}</TableHead>
                    <TableHead>{t('cols.documentMonths')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {shown.map((z) => {
                    const other = hasOtherMonthDocuments(z);
                    return (
                      <TableRow key={z.id}>
                        <TableCell className="font-medium tabular-nums whitespace-nowrap">
                          <Link href={`/dashboard/z-reports/${z.id}`} className="hover:underline">
                            {z.zNumber ?? '—'}
                          </Link>
                        </TableCell>
                        <TableCell><ZKindBadge kind={z.kind} /></TableCell>
                        <TableCell className="whitespace-nowrap tabular-nums">
                          {z.productionDate ? formatDate(z.productionDate) : '—'} {z.productionTime ?? ''}
                        </TableCell>
                        <TableCell className="whitespace-nowrap">{z.businessDate ? formatDate(z.businessDate) : '—'}</TableCell>
                        <TableCell className="text-sm">
                          {numberedLabel(z.shopNumber, z.shopName ?? '—')}
                          {z.areaName ? <div className="text-muted-foreground text-xs">{z.areaName}</div> : null}
                          {tillsLabel(z) ? <div className="text-muted-foreground text-xs">{tillsLabel(z)}</div> : null}
                        </TableCell>
                        <TableCell className="text-end tabular-nums">{formatCurrency(z.totalSales)}</TableCell>
                        <TableCell className="text-end tabular-nums">{formatCurrency(z.vatTotal)}</TableCell>
                        <TableCell className="text-end tabular-nums">{formatCurrency(z.cashSales)}</TableCell>
                        <TableCell className="text-end tabular-nums">{formatCurrency(z.cardSales)}</TableCell>
                        <TableCell className="text-end tabular-nums">{formatCurrency(z.totalTips)}</TableCell>
                        <TableCell className="text-end tabular-nums">{z.documents}</TableCell>
                        <TableCell className="text-xs">
                          {other ? (
                            <div className="space-y-0.5">
                              <Badge variant="outline" className="font-normal">{t('otherMonthBadge')}</Badge>
                              <div className="tabular-nums">{documentMonthsText(z.documentMonths, z.productionDate)}</div>
                            </div>
                          ) : (
                            <span className="text-muted-foreground">{t('sameMonth')}</span>
                          )}
                          {z.documentsMatchZ === false ? (
                            <div className="text-muted-foreground">{t('documentsDiffer')}</div>
                          ) : null}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
            {data.zs.length > MAX_ROWS ? (
              <p className="text-muted-foreground text-xs">{t('rowsCapped', { shown: MAX_ROWS, total: data.zs.length })}</p>
            ) : null}
          </section>
        </>
      )}
    </section>
  );
}
