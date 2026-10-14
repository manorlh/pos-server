'use client';

/**
 * "מכירות מוצרים לפי ימים" (P:\specs\reports-designed-pdf.md §8, §7.6) — the product sales page's
 * second view: for any range and scope, how much was sold on each day. In the same order as the
 * PDF the server draws: the range's KPIs, a row per day (table and bars), a section per day with
 * its products, then "סיכום כל הימים יחד" (every product over the range, and product × day), and
 * the insights. Quantities only when the reader turns the amounts off.
 */
import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { formatCurrency, formatQuantity } from '@/lib/format';
import { sortProducts, type ByDayDay, type ByDayProduct, type ByDaySummaryProduct, type ProductsByDayReport } from '@/lib/productsByDay';
import type { ServerKpi } from '@/lib/designedReport';
import { shareValue } from '@/lib/daySummaryV2';
import { ChangeTag, DayInsights, formatKpi } from '@/components/dashboard/day-summary/day-summary-v2';
import { ReportTable, type ReportColumn, type ReportTableSpec } from '@/components/dashboard/report-framework';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

type MatrixRow = ProductsByDayReport['matrix']['rows'][number];

/** The days, a day's products, the summary and the matrix, as report tables. */
export function useByDayTables(data: ProductsByDayReport | undefined, sort: 'qty' | 'amount') {
  const t = useTranslations('productSales.byDay');
  return useMemo(() => {
    if (!data) return null;
    const money = data.options.amounts;
    const total = t('total');
    const days: ReportTableSpec<ByDayDay> = {
      id: 'main',
      title: t('daysTitle'),
      columns: [
        { key: 'date', header: t('col.date'), kind: 'date', required: true, value: (d) => d.date, cell: (d) => d.label },
        { key: 'weekday', header: t('col.weekday'), value: (d) => d.weekday, defaultHidden: true },
        { key: 'items', header: t('col.items'), kind: 'number', value: (d) => d.items, total: data.summary.totals.units },
        ...(money
          ? [{ key: 'net', header: t('col.net'), kind: 'money' as const, value: (d: ByDayDay) => d.net, total: data.summary.totals.net }]
          : []),
        { key: 'documents', header: t('col.documents'), kind: 'number', value: (d) => d.documents, total: data.summary.totals.documents },
        {
          key: 'changePct',
          header: t('col.change'),
          kind: 'percent',
          value: (d) => shareValue(d.changePct),
          cell: (d) => <ChangeTag pct={d.changePct} />,
        },
      ],
      rows: data.days,
      rowKey: (d) => d.date,
      totalsLabel: total,
      emptyText: t('noDays'),
    };
    const productColumns = <R extends ByDayProduct>(extra: ReportColumn<R>[]): ReportColumn<R>[] => [
      { key: 'product', header: t('col.product'), required: true, width: 30, value: (p) => p.name, className: 'font-medium' },
      { key: 'department', header: t('col.department'), value: (p) => p.department ?? '', className: 'text-muted-foreground' },
      { key: 'units', header: t('col.units'), kind: 'number', value: (p) => p.units, className: 'font-semibold' },
      ...(money ? [{ key: 'net', header: t('col.net'), kind: 'money' as const, value: (p: R) => p.net }] : []),
      { key: 'share', header: t('col.share'), kind: 'percent', value: (p) => shareValue(p.share) },
      ...extra,
    ];
    const dayTable = (d: ByDayDay): ReportTableSpec<ByDayProduct> => ({
      id: `day-${d.date.replace(/-/g, '')}`,
      title: d.label,
      columns: productColumns<ByDayProduct>([]),
      rows: sortProducts(d.products, sort),
      rowKey: (p, i) => p.productId ?? `p-${i}`,
      totalsLabel: total,
      emptyText: t('noSalesDay'),
    });
    const summary: ReportTableSpec<ByDaySummaryProduct> = {
      id: 'summary',
      title: t('summaryTitle'),
      columns: productColumns<ByDaySummaryProduct>([
        { key: 'averagePerDay', header: t('col.averagePerDay'), kind: 'number', value: (p) => shareValue(p.averagePerDay) },
        { key: 'daysSold', header: t('col.daysSold'), kind: 'number', value: (p) => p.daysSold },
      ]).map((c) =>
        c.key === 'units' ? { ...c, total: data.summary.totals.units } : c.key === 'net' ? { ...c, total: data.summary.totals.net } : c,
      ),
      rows: sortProducts(data.summary.products, sort),
      rowKey: (p, i) => p.productId ?? `p-${i}`,
      totalsLabel: total,
      emptyText: t('noDays'),
    };
    const matrix: ReportTableSpec<MatrixRow> = {
      id: 'matrix',
      title: t('matrixTitle'),
      columns: [
        { key: 'product', header: t('col.product'), required: true, width: 28, value: (r) => r.name, className: 'font-medium' },
        ...data.matrix.columns.map<ReportColumn<MatrixRow>>((c, i) => ({
          key: `d${c.key.replace(/[^0-9A-Za-z]/g, '')}`,
          header: c.label,
          kind: 'number',
          width: 9,
          value: (r) => r.values[i] ?? 0,
          cell: (r) => (r.values[i] ? formatQuantity(r.values[i]) : <span className="text-muted-foreground">·</span>),
        })),
        { key: 'total', header: total, kind: 'number', value: (r) => r.total, className: 'font-semibold' },
      ],
      rows: data.matrix.rows,
      rowKey: (r, i) => r.productId ?? `m-${i}`,
    };
    return { days, dayTable, summary, matrix };
  }, [data, sort, t]);
}

/** The range's KPI cards as the server worked them out. */
function ByDayKpis({ kpis }: { kpis: ServerKpi[] }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
      {kpis.map((k, i) => (
        <Card key={k.key} className={cn('relative overflow-hidden', i === 0 && 'ring-primary/40 ring-2')}>
          <span aria-hidden className="bg-primary absolute inset-y-0 start-0 w-1" />
          <CardHeader className="pb-1">
            <CardTitle className="text-muted-foreground text-sm font-medium">{k.label}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className={cn('font-bold tabular-nums', k.kind === 'text' ? 'text-base' : 'text-2xl')}>
              {k.display ?? formatKpi(k.kind as 'money', k.value)}
            </p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

/** The days as bars: ₪, or items when the amounts are off. */
function DaysChart({ data }: { data: ProductsByDayReport }) {
  const t = useTranslations('productSales.byDay');
  const money = data.options.amounts;
  const points = data.days.map((d) => ({ label: d.label.split(' ').slice(-1)[0]?.slice(0, 5) ?? d.date, value: money ? d.net : d.items, full: d.label }));
  if (!points.some((p) => p.value)) return null;
  return (
    <div className="h-56" dir="ltr">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={points} margin={{ top: 8, right: 4, bottom: 0, left: 4 }}>
          <CartesianGrid vertical={false} stroke="var(--border)" />
          <XAxis dataKey="label" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} interval="preserveStartEnd" minTickGap={8} />
          <YAxis
            orientation="right"
            tick={{ fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            width={52}
            tickFormatter={(n: number) => (money ? (Math.abs(n) >= 1000 ? `₪${(n / 1000).toLocaleString('he-IL', { maximumFractionDigits: 1 })}K` : `₪${Math.round(n)}`) : formatQuantity(n))}
          />
          <Tooltip
            formatter={(value) => [money ? formatCurrency(Number(value)) : formatQuantity(Number(value)), money ? t('col.net') : t('col.items')]}
            labelFormatter={(_, payload) => String((payload?.[0]?.payload as { full?: string } | undefined)?.full ?? '')}
          />
          <Bar dataKey="value" fill="var(--primary)" radius={[3, 3, 0, 0]} maxBarSize={28} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** The day's heading: "יום ג' 14.10.2026 · ₪23,410 · 812 פריטים". */
function dayHeading(d: ByDayDay, money: boolean, items: (n: string) => string): string {
  return [d.label, money ? formatCurrency(d.net) : null, items(formatQuantity(d.items))].filter(Boolean).join(' · ');
}

export function ProductsByDayView({ data, sort, reportKey }: { data: ProductsByDayReport; sort: 'qty' | 'amount'; reportKey: string }) {
  const t = useTranslations('productSales.byDay');
  const tables = useByDayTables(data, sort);
  if (!tables) return null;
  const money = data.options.amounts;
  // A long range opens closed: the reader picks the days to read.
  const openDays = data.days.length <= 7;
  return (
    <div className="min-w-0 space-y-6">
      <ByDayKpis kpis={data.kpis} />

      <section className="min-w-0 space-y-2">
        <h2 className="text-lg font-semibold">{t('daysTitle')}</h2>
        <DaysChart data={data} />
        <ReportTable table={tables.days} reportKey={reportKey} />
      </section>

      <section className="min-w-0 space-y-2">
        <h2 className="text-lg font-semibold">{t('perDayTitle')}</h2>
        {data.days.map((d) => (
          <details key={d.date} open={openDays} className="group rounded-lg border">
            <summary className="hover:bg-muted/40 cursor-pointer list-none px-3 py-2 text-sm font-semibold">
              <span aria-hidden className="text-muted-foreground me-2 inline-block transition-transform group-open:rotate-90">
                ‹
              </span>
              {dayHeading(d, money, (n) => t('itemsCount', { n }))}
            </summary>
            <div className="border-t p-2">
              <ReportTable table={tables.dayTable(d)} reportKey={`${reportKey}.day`} />
            </div>
          </details>
        ))}
      </section>

      <section className="min-w-0 space-y-2">
        <h2 className="text-lg font-semibold">{t('summaryTitle')}</h2>
        <ReportTable table={tables.summary} reportKey={reportKey} />
        <h3 className="pt-2 font-semibold">{t('matrixTitle')}</h3>
        {data.matrix.grouping === 'week' ? <p className="text-muted-foreground text-xs">{t('matrixByWeek')}</p> : null}
        <ReportTable table={tables.matrix} reportKey={reportKey} />
      </section>

      <DayInsights insights={data.insights} title={t('insights')} />
    </div>
  );
}
