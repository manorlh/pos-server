'use client';

/**
 * Sales by hour (מכירות לפי שעה) — docs/ACCOUNTING_EXPORT_AND_REPORTS.md §4.3.4.
 *
 * A weekday × hour heat map of net takings in the tenant's timezone, for planning shifts,
 * and the same per hour summed over the week.
 */

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { usePageScope } from '@/lib/scope';
import { formatCurrency, formatHour, formatQuantity } from '@/lib/format';
import { daysBackIso, todayIso } from '@/lib/reportWindow';
import { fetchHourlyReport, type HourlyReport } from '@/lib/salesReportsApi';
import { ScopeGate } from '@/components/dashboard/scope-gate';
import { RangeFilter, type DayRange } from '@/components/dashboard/range-filter';
import { ReportExportToolbar } from '@/components/dashboard/report-export-toolbar';
import {
  ReportErrorState,
  ReportWindowSummary,
} from '@/components/dashboard/report-window-summary';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];

export default function HourlySalesPage() {
  const t = useTranslations('hourlyReport');
  const tc = useTranslations('common');
  const { resolution, effective } = usePageScope({ maxLevel: 'machine', unsupported: ['company'] });

  const [range, setRange] = useState<DayRange>({ from: daysBackIso(27), to: todayIso() });
  const [applied, setApplied] = useState<DayRange | null>(null);

  const params = useMemo(() => {
    if (!applied) return null;
    return {
      ...applied,
      ...(effective.shopId ? { shopId: effective.shopId } : {}),
      ...(effective.machineId ? { machineId: effective.machineId } : {}),
    };
  }, [applied, effective.shopId, effective.machineId]);

  const { data, isLoading, isFetching, isError, error } = useQuery<HourlyReport>({
    queryKey: ['report-hourly', params],
    queryFn: () => fetchHourlyReport(params!),
    enabled: params !== null,
  });

  const grid = useMemo(() => {
    const map = new Map<string, { net: number; documents: number }>();
    for (const c of data?.cells ?? []) map.set(`${c.weekday}-${c.hour}`, c);
    const hours = (data?.byHour ?? []).map((h) => h.hour);
    const max = Math.max(0, ...(data?.cells ?? []).map((c) => c.net));
    return { map, hours, max };
  }, [data]);

  const dayName = (d: number) => t(`weekday.${d}`);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
      </div>

      <ScopeGate resolution={resolution}>
        <RangeFilter value={range} onChange={setRange} onRun={() => setApplied(range)} isFetching={isFetching} />

        {!applied ? (
          <p className="text-muted-foreground py-12 text-center text-sm">{t('selectFilters')}</p>
        ) : isLoading ? (
          <Skeleton className="h-64 w-full" />
        ) : isError ? (
          <ReportErrorState message={axiosErrorToToastMessage(error, tc('error'))} />
        ) : data ? (
          <div className="space-y-4">
            <ReportExportToolbar
              title={t('title')}
              from={data.window.from}
              to={data.window.to}
              getSheets={() => [
                {
                  name: t('heatTitle'),
                  columns: [
                    { header: t('col.hour'), width: 8 },
                    ...WEEKDAYS.map((d) => ({ header: dayName(d), kind: 'money' as const })),
                  ],
                  rows: grid.hours.map((h) => [
                    formatHour(h),
                    ...WEEKDAYS.map((d) => grid.map.get(`${d}-${h}`)?.net ?? null),
                  ]),
                },
                {
                  name: t('byHourTitle'),
                  columns: [
                    { header: t('col.hour'), width: 8 },
                    { header: t('col.net'), kind: 'money' },
                    { header: t('col.documents'), kind: 'number' },
                    { header: t('col.averageBasket'), kind: 'money' },
                  ],
                  rows: data.byHour.map((h) => [formatHour(h.hour), h.net, h.documents, h.averageBasket]),
                  totals: [t('total'), data.total, data.documents, null],
                },
              ]}
            />
            <ReportWindowSummary window={data.window} generatedAt={data.generatedAt} />

            {grid.hours.length === 0 ? (
              <p className="text-muted-foreground py-10 text-center text-sm">{t('noRows')}</p>
            ) : (
              <div className="rounded-lg border bg-card overflow-x-auto p-3">
                <h2 className="mb-2 text-sm font-medium">{t('heatTitle')}</h2>
                <table className="w-full border-separate border-spacing-0.5 text-xs">
                  <thead>
                    <tr>
                      <th className="text-muted-foreground w-14 text-start font-normal">{t('col.hour')}</th>
                      {WEEKDAYS.map((d) => (
                        <th key={d} className="text-muted-foreground font-normal">
                          {dayName(d)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {grid.hours.map((h) => (
                      <tr key={h}>
                        <td className="text-muted-foreground tabular-nums">{formatHour(h)}</td>
                        {WEEKDAYS.map((d) => {
                          const cell = grid.map.get(`${d}-${h}`);
                          const ratio = cell && grid.max > 0 ? Math.max(0, cell.net) / grid.max : 0;
                          return (
                            <td
                              key={d}
                              className="h-8 rounded text-center tabular-nums"
                              style={{
                                backgroundColor: cell ? `rgba(37, 99, 235, ${0.08 + ratio * 0.72})` : undefined,
                                color: ratio > 0.55 ? 'white' : undefined,
                              }}
                              title={
                                cell
                                  ? t('cellTitle', {
                                      day: dayName(d),
                                      hour: formatHour(h),
                                      net: formatCurrency(cell.net),
                                      documents: cell.documents,
                                    })
                                  : undefined
                              }
                            >
                              {cell ? Math.round(cell.net).toLocaleString('he-IL') : ''}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="rounded-lg border bg-card overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('col.hour')}</TableHead>
                    <TableHead className="text-end">{t('col.net')}</TableHead>
                    <TableHead className="text-end">{t('col.documents')}</TableHead>
                    <TableHead className="text-end">{t('col.averageBasket')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.byHour.map((h) => (
                    <TableRow key={h.hour}>
                      <TableCell className="tabular-nums">{formatHour(h.hour)}</TableCell>
                      <TableCell className="text-end tabular-nums">{formatCurrency(h.net)}</TableCell>
                      <TableCell className="text-end tabular-nums">{formatQuantity(h.documents)}</TableCell>
                      <TableCell className="text-end tabular-nums">{formatCurrency(h.averageBasket)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
                <TableFooter>
                  <TableRow>
                    <TableCell className="font-semibold">{t('total')}</TableCell>
                    <TableCell className="text-end font-bold tabular-nums">{formatCurrency(data.total)}</TableCell>
                    <TableCell className="text-end tabular-nums">{formatQuantity(data.documents)}</TableCell>
                    <TableCell />
                  </TableRow>
                </TableFooter>
              </Table>
            </div>
          </div>
        ) : null}
      </ScopeGate>
    </div>
  );
}
