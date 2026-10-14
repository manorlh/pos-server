'use client';

/**
 * Sales by hour (מכירות לפי שעה) — docs/ACCOUNTING_EXPORT_AND_REPORTS.md §4.3.4.
 *
 * A weekday × hour heat map of net takings in the tenant's timezone, for planning shifts,
 * and the same per hour summed over the week.
 *
 * On the report framework (P:\specs\reports-upgrade.md §5): days, area and cashier in the URL
 * (the endpoint takes both, §4.1 — no hour band: the hours are the report). Tips are their
 * own column when the server sends them (§4.2), never inside `net`.
 */

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { usePageScope } from '@/lib/scope';
import { formatCurrency, formatHour } from '@/lib/format';
import { scopeApiParams, type ReportFilterSpec } from '@/lib/reportFilters';
import { previousWindow, type PreviousPeriod, type ReportChart, type ReportKpi } from '@/lib/designedReport';
import { fetchHourlyReport, type HourlyReport } from '@/lib/salesReportsApi';
import { ReportWindowSummary } from '@/components/dashboard/report-window-summary';
import {
  ReportPage,
  ReportTable,
  reportQueryState,
  useReportFilters,
  type ReportColumn,
  type ReportTableSpec,
} from '@/components/dashboard/report-framework';

const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];

const SPEC: ReportFilterSpec = {
  filters: ['area', 'cashier'],
  defaultDaysBack: 27,
};

type HourRow = HourlyReport['byHour'][number];

/**
 * The totals row as the designed PDF's cards (and the period before's), by KPI key — the
 * average basket of the whole window, as each hour's row has its own.
 */
function totalsFigures(r: HourlyReport): Record<string, number | null> {
  return {
    net: r.total,
    transactions: r.documents,
    avgTicket: r.documents ? Math.round((r.total / r.documents) * 100) / 100 : null,
    tips: r.tipsTotal ?? null,
  };
}

export default function HourlySalesPage() {
  const t = useTranslations('hourlyReport');
  const { resolution, effective } = usePageScope({ maxLevel: 'machine' });
  const filters = useReportFilters(SPEC);

  const params = useMemo(
    () => (filters.apiParams ? { ...filters.apiParams, ...scopeApiParams(effective) } : null),
    [effective, filters.apiParams],
  );

  const query = useQuery<HourlyReport>({
    queryKey: ['report-hourly', params],
    queryFn: () => fetchHourlyReport(params!),
    enabled: params !== null,
  });
  const data = query.data;

  const grid = useMemo(() => {
    const map = new Map<string, { net: number; documents: number; tips?: number }>();
    for (const c of data?.cells ?? []) map.set(`${c.weekday}-${c.hour}`, c);
    const hours = (data?.byHour ?? []).map((h) => h.hour);
    const max = Math.max(0, ...(data?.cells ?? []).map((c) => c.net));
    return { map, hours, max };
  }, [data]);

  const dayName = (d: number) => t(`weekday.${d}`);

  const table = useMemo<ReportTableSpec<HourRow>>(() => {
    const hasTips = Boolean(data && (data.tipsTotal !== undefined || data.byHour.some((h) => h.tips !== undefined)));
    const columns: ReportColumn<HourRow>[] = [
      { key: 'hour', header: t('col.hour'), required: true, width: 8, value: (h) => formatHour(h.hour), sortable: false },
      { key: 'net', header: t('col.net'), kind: 'money', value: (h) => h.net, total: data?.total, className: 'font-medium' },
      { key: 'documents', header: t('col.documents'), kind: 'number', value: (h) => h.documents, total: data?.documents },
      { key: 'averageBasket', header: t('col.averageBasket'), kind: 'money', value: (h) => h.averageBasket },
      ...(hasTips
        ? [{ key: 'tips', header: t('col.tips'), kind: 'money' as const, value: (h: HourRow) => h.tips ?? 0, total: data?.tipsTotal ?? null }]
        : []),
    ];
    return {
      id: 'main',
      title: t('byHourTitle'),
      columns,
      rows: data?.byHour ?? [],
      rowKey: (h) => String(h.hour),
      totalsLabel: t('total'),
      emptyText: t('noRows'),
    };
  }, [data, t]);

  // The designed PDF (P:\specs\reports-designed-pdf.md §7): the totals as cards, the takings by
  // hour as bars (in the hours' order), and the hours of the period before.
  const figures = data ? totalsFigures(data) : null;
  const kpis: ReportKpi[] = figures
    ? [
        { key: 'net', label: t('col.net'), value: figures.net, kind: 'money', icon: 'sales' },
        { key: 'transactions', label: t('col.documents'), value: figures.transactions, kind: 'count', icon: 'receipt' },
        { key: 'avgTicket', label: t('col.averageBasket'), value: figures.avgTicket, kind: 'money', icon: 'basket' },
        // The tips only when the server sends them (§4.2), as the table's column.
        ...(figures.tips === null
          ? []
          : [{ key: 'tips', label: t('col.tips'), value: figures.tips, kind: 'money', icon: 'tip' } satisfies ReportKpi]),
      ]
    : [];
  const chart: ReportChart | null = data?.byHour.length
    ? {
        type: 'bar',
        title: t('byHourTitle'),
        labels: data.byHour.map((h) => formatHour(h.hour)),
        series: [{ name: t('col.net'), values: data.byHour.map((h) => h.net) }],
        kind: 'money',
      }
    : null;
  const previous = async (): Promise<PreviousPeriod | null> => {
    const w = previousWindow(data?.window.from, data?.window.to);
    if (!params || !w) return null;
    const before = await fetchHourlyReport({ ...params, ...w });
    return { rows: before.byHour, kpis: totalsFigures(before), ...w };
  };

  return (
    <ReportPage
      reportKey="hourly-sales"
      title={t('title')}
      subtitle={t('subtitle')}
      resolution={resolution}
      filters={filters}
      bar={{ shopId: effective.shopId }}
      query={reportQueryState(query)}
      prompt={t('selectFilters')}
      loading="table"
      export={
        data
          ? {
              tables: [table],
              // The heat map is not a table of columns: its sheet goes as it is, first, as always.
              extraSheets: () => [
                {
                  name: t('heatTitle'),
                  columns: [
                    { header: t('col.hour'), width: 8 },
                    ...WEEKDAYS.map((d) => ({ header: dayName(d), kind: 'money' as const })),
                  ],
                  rows: grid.hours.map((h) => [formatHour(h), ...WEEKDAYS.map((d) => grid.map.get(`${d}-${h}`)?.net ?? null)]),
                },
              ],
              extraSheetsFirst: true,
              from: data.window.from,
              to: data.window.to,
              reportType: 'hourly-sales',
              kpis,
              chart,
              insightKeys: { label: 'hour', hour: 'hour', value: 'net', count: 'documents' },
              previous,
            }
          : null
      }
    >
      {data ? (
        <>
          <ReportWindowSummary window={data.window} generatedAt={data.generatedAt} />

          {grid.hours.length === 0 ? (
            <p className="text-muted-foreground py-10 text-center text-sm">{t('noRows')}</p>
          ) : (
            <div className="overflow-x-auto rounded-lg border bg-card p-3">
              <h2 className="mb-2 text-sm font-medium">{t('heatTitle')}</h2>
              <table className="w-full min-w-[28rem] border-separate border-spacing-0.5 text-xs">
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
                                ? [
                                    t('cellTitle', {
                                      day: dayName(d),
                                      hour: formatHour(h),
                                      net: formatCurrency(cell.net),
                                      documents: cell.documents,
                                    }),
                                    cell.tips ? t('cellTips', { tips: formatCurrency(cell.tips) }) : '',
                                  ]
                                    .filter(Boolean)
                                    .join(' · ')
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

          <ReportTable table={table} />
        </>
      ) : null}
    </ReportPage>
  );
}
