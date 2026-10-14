'use client';

/**
 * Events side by side (`/report-events/compare`): the customers who split one shop into
 * two events want to see which did better and why — the headline figures (the best of
 * each row marked), each event's tills by sales per hour, and the top items.
 *
 * The events are in the URL (`?ids=a,b`). Exported through the reports' export bar
 * (P:\specs\reports-upgrade.md §2ב–ד, key `event-compare`): Excel with the same three
 * sheets — the figures grid, the tills (weak and silent ones highlighted, as on screen) and
 * the top items — each with columns to choose; a PDF of the figures grid (the designed one: the
 * first event's cards against the second, every event's net as bars); print.
 */

import { useMemo } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Trophy } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { eventErrorMessage, fetchEventCompare, type EventCompareEntry } from '@/lib/eventsApi';
import { clockLabel, durationText } from '@/lib/eventReport';
import { CHART, Capsule, Card, InsightsSurface, Muted, SectionHeader, SkeletonCard, tooltipStyle } from '@/components/dashboard/insights/ios';
import { IosTable, StatusChip, Td, Th, compactMoney, count, money, pctText, tillColor } from '@/components/dashboard/events/event-parts';
import {
  ReportExportBar,
  useReportExportScope,
  type ReportChart,
  type ReportKpi,
  type ReportTableSpec,
} from '@/components/dashboard/report-framework';
import { EXCEL_FILL } from '@/lib/excelExport';

type Row = {
  key: string;
  value: (e: EventCompareEntry) => number | null;
  format: (n: number | null) => string;
  /** Less is better (refunds, alerts). */
  invert?: boolean;
};

const ROWS: Row[] = [
  { key: 'net', value: (e) => e.kpis.net, format: money },
  { key: 'netExVat', value: (e) => e.kpis.netExVat, format: money },
  { key: 'sales', value: (e) => e.kpis.salesCount, format: count },
  { key: 'avgTicket', value: (e) => e.kpis.avgTicket, format: money },
  { key: 'items', value: (e) => e.kpis.itemsSold, format: count },
  { key: 'tips', value: (e) => e.kpis.tips, format: money },
  { key: 'tipPct', value: (e) => e.kpis.tipPct, format: (n) => pctText(n) },
  { key: 'refunds', value: (e) => e.kpis.refunds, format: money, invert: true },
  { key: 'perActiveHour', value: (e) => e.kpis.avgPerActiveHour, format: money },
  { key: 'activeTills', value: (e) => e.perTill.activeTills, format: count },
  { key: 'avgPerTill', value: (e) => e.perTill.avgNet, format: money },
  { key: 'medianPerHour', value: (e) => e.perTill.medianSalesPerHour, format: money },
  { key: 'cash', value: (e) => e.kpis.cash, format: money },
  { key: 'card', value: (e) => e.kpis.card, format: money },
  { key: 'alerts', value: (e) => e.alerts, format: count, invert: true },
];

type TillRow = { entry: EventCompareEntry; till: EventCompareEntry['tills'][number] };
type ItemRow = { entry: EventCompareEntry; item: EventCompareEntry['topItems'][number] };

/** An event's tills, best sales per hour first (as the cards list them). */
function bySalesPerHour(e: EventCompareEntry) {
  return e.tills.slice().sort((a, b) => b.salesPerHour - a.salesPerHour);
}

export default function EventsComparePage() {
  const t = useTranslations('events.compareView');
  const te = useTranslations('events');
  const tv = useTranslations('controlBoard.event');
  const ids =useSearchParams().get('ids') ?? '';
  const query = useQuery({
    queryKey: ['event-compare', ids],
    queryFn: () => fetchEventCompare(ids),
    enabled: ids.split(',').filter(Boolean).length >= 2,
  });
  const events = useMemo(() => query.data ?? [], [query.data]);

  const best = useMemo(
    () =>
      (row: Row): number | null => {
        const values = events.map(row.value).filter((v): v is number => v !== null);
        if (values.length < 2) return null;
        return row.invert ? Math.min(...values) : Math.max(...values);
      },
    [events],
  );
  const chart = events.map((e, i) => ({ name: e.event.name, net: e.kpis.net, avg: e.kpis.avgTicket, color: tillColor(i) }));

  /**
   * What goes out, sheet by sheet, as it always did: the figures grid (a row per figure, a
   * column per event — numbers, the unit in the figure's name, the best named beside it),
   * every event's tills by sales per hour (weak and silent tills filled red, as on screen),
   * and the top items. Not on screen as tables — the cards and the grid below are the view.
   */
  const tables = useMemo(() => {
    const unit = (row: Row) => (row.format === money ? ' (₪)' : row.key === 'tipPct' ? ' (%)' : '');
    const figures: ReportTableSpec<Row> = {
      id: 'main',
      title: t('figures'),
      rows: ROWS,
      rowKey: (row) => row.key,
      // A figure per row, not a list to filter (as the sheet always was).
      autoFilter: false,
      columns: [
        { key: 'figure', header: t('figures'), required: true, value: (row) => `${t(`rows.${row.key}`)}${unit(row)}` },
        // By position: "the first event", "the second"… — what a saved choice can mean here.
        ...events.map((e, i) => ({
          key: `event${i + 1}`,
          header: `${e.event.name} · ${clockLabel(e.event.startsAt, e.event.timezone, true)}`,
          kind: 'number' as const,
          width: 18,
          value: (row: Row) => row.value(e),
        })),
        {
          key: 'best',
          header: t('best'),
          value: (row) => {
            const top = best(row);
            return top === null ? null : events.filter((e) => row.value(e) === top).map((e) => e.event.name).join(', ');
          },
        },
      ],
    };
    const tills: ReportTableSpec<TillRow> = {
      id: 'tills',
      title: t('tills'),
      rows: events.flatMap((entry) => bySalesPerHour(entry).map((till) => ({ entry, till }))),
      rowKey: (r) => `${r.entry.event.id}:${r.till.machineId}`,
      rowFill: (r) => (r.till.weak || r.till.noSales ? EXCEL_FILL.missing : null),
      columns: [
        { key: 'event', header: te('form.name'), required: true, value: (r) => r.entry.event.name },
        { key: 'till', header: te('tills.till'), value: (r) => r.till.name },
        { key: 'perHour', header: te('tills.perHour'), kind: 'money', value: (r) => r.till.salesPerHour },
        { key: 'net', header: te('tills.net'), kind: 'money', value: (r) => r.till.net },
        { key: 'sales', header: te('tills.sales'), kind: 'number', value: (r) => r.till.salesCount },
        { key: 'avgTicket', header: te('tills.avgTicket'), kind: 'money', value: (r) => r.till.avgTicket },
        { key: 'share', header: te('tills.share'), kind: 'percent', value: (r) => r.till.sharePct },
        { key: 'tipPct', header: t('rows.tipPct'), kind: 'percent', value: (r) => r.till.tipPct },
      ],
    };
    const items: ReportTableSpec<ItemRow> = {
      id: 'items',
      title: t('topItems'),
      rows: events.flatMap((entry) => entry.topItems.map((item) => ({ entry, item }))),
      rowKey: (r) => `${r.entry.event.id}:${r.item.key}`,
      columns: [
        { key: 'event', header: te('form.name'), required: true, value: (r) => r.entry.event.name },
        { key: 'item', header: te('items.item'), value: (r) => r.item.name },
        { key: 'quantity', header: te('items.quantity'), kind: 'number', value: (r) => r.item.quantity },
        { key: 'revenue', header: te('items.revenue'), kind: 'money', value: (r) => r.item.revenue },
        { key: 'share', header: te('items.share'), kind: 'percent', value: (r) => r.item.sharePct },
      ],
    };
    return [figures, tills, items] as ReportTableSpec<unknown>[];
  }, [best, events, t, te]);

  const startDates = events.map((e) => e.event.startDate).filter(Boolean).sort();
  const endDates = events.map((e) => e.event.endDate).filter(Boolean).sort();
  const shopNames = [...new Set(events.map((e) => e.event.shopName).filter((s): s is string => Boolean(s)))];
  const exportScope = useReportExportScope(shopNames.length ? shopNames.join(', ') : null);
  const filterLines = events.length ? [{ label: t('eventsLabel'), value: events.map((e) => e.event.name).join(', ') }] : [];
  // The designed PDF (P:\specs\reports-designed-pdf.md §7): the first event's cards against the
  // second (`?ids=a,b` — the compare view links A then B), and every event's net as bars.
  const [first, second] = events;
  const versus = second ? tv('versus', { name: second.event.name }) : undefined;
  const exportKpis: ReportKpi[] = first
    ? (
        [
          ['net', 'money', 'sales'],
          ['sales', 'count', 'receipt'],
          ['avgTicket', 'money', 'basket'],
          ['items', 'count', 'items'],
          ['tips', 'money', 'tip'],
          ['refunds', 'money', 'refund'],
        ] as const
      ).map(([key, kind, icon]) => {
        const row = ROWS.find((r) => r.key === key)!;
        return {
          key,
          label: `${t(`rows.${key}`)} · ${first.event.name}`,
          value: row.value(first),
          kind,
          icon,
          ...(second && versus ? { compare: row.value(second), compareLabel: versus } : {}),
        };
      })
    : [];
  const exportChart: ReportChart | null = events.length
    ? {
        type: 'bar',
        title: t('net'),
        labels: chart.map((c) => c.name),
        series: [{ name: t('rows.net'), values: chart.map((c) => c.net) }],
        kind: 'money',
      }
    : null;

  return (
    <InsightsSurface className="print:bg-white">
      <div className="space-y-1 px-1">
        <Link href="/dashboard/events" className="flex items-center gap-1 text-[15px] text-[#007AFF] print:hidden">
          <ArrowRight className="h-4 w-4" aria-hidden />
          {te('page.back')}
        </Link>
        <h1 className="text-[34px] font-bold leading-tight tracking-tight">{t('title')}</h1>
        <p className="text-[15px] text-[#8E8E93]">{t('subtitle')}</p>
      </div>
      <div className="mt-3 px-1">
        <ReportExportBar
          reportKey="event-compare"
          title={t('title')}
          tables={tables}
          pdfTableId="main"
          from={startDates[0]}
          to={endDates[endDates.length - 1]}
          business={exportScope.business}
          place={exportScope.place}
          filterLines={filterLines}
          companyId={exportScope.companyId}
          companyName={exportScope.companyName}
          disabled={events.length === 0}
          reportType="event-compare"
          kpis={exportKpis}
          chart={exportChart}
        />
      </div>

      {query.isLoading ? (
        <div className="mt-4 space-y-3">
          <SkeletonCard className="h-64" />
          <SkeletonCard className="h-96" />
        </div>
      ) : query.isError ? (
        <Card className="mt-4">
          <Muted>{eventErrorMessage(query.error, te('loadError'))}</Muted>
        </Card>
      ) : events.length === 0 ? (
        <Card className="mt-4">
          <Muted>{t('pick')}</Muted>
        </Card>
      ) : (
        <>
          <SectionHeader>{t('net')}</SectionHeader>
          <Card>
            <div className="h-56" dir="ltr">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chart} margin={{ top: 8, right: 4, bottom: 0, left: 4 }}>
                  <CartesianGrid vertical={false} stroke={CHART.grid} />
                  <XAxis dataKey="name" tick={{ fontSize: 12, fill: '#8E8E93' }} axisLine={false} tickLine={false} />
                  <YAxis tickFormatter={compactMoney} tick={{ fontSize: 11, fill: '#8E8E93' }} axisLine={false} tickLine={false} width={56} orientation="right" />
                  <Tooltip contentStyle={tooltipStyle} formatter={(v) => [money(Number(v ?? 0)), t('rows.net')]} />
                  <Bar dataKey="net" radius={[6, 6, 0, 0]} maxBarSize={64}>
                    {chart.map((c) => (
                      <Cell key={c.name} fill={c.color} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Card>

          <SectionHeader>{t('figures')}</SectionHeader>
          <Card className="p-2">
            <IosTable>
              <thead>
                <tr>
                  <Th />
                  {events.map((e, i) => (
                    <Th key={e.event.id} end>
                      <Link href={`/dashboard/events/${e.event.id}`} className="inline-flex flex-col items-end gap-0.5 hover:underline">
                        <span className="flex items-center gap-1 text-[15px] font-semibold text-black dark:text-white">
                          <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: tillColor(i) }} aria-hidden />
                          {e.event.name}
                        </span>
                        <span>
                          {clockLabel(e.event.startsAt, e.event.timezone, true)} · {durationText(e.event.durationMinutes)}
                        </span>
                        <StatusChip status={e.event.status} />
                      </Link>
                    </Th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ROWS.map((row) => {
                  const top = best(row);
                  return (
                    <tr key={row.key}>
                      <Td className="text-[#3C3C43] dark:text-[#EBEBF5]">{t(`rows.${row.key}`)}</Td>
                      {events.map((e) => {
                        const v = row.value(e);
                        const isBest = top !== null && v === top;
                        return (
                          <Td key={e.event.id} end className={isBest ? 'font-semibold text-[#248A3D] dark:text-[#30D158]' : undefined}>
                            {isBest ? <Trophy className="me-1 inline h-3.5 w-3.5" aria-label={t('best')} /> : null}
                            {row.format(v)}
                          </Td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </IosTable>
          </Card>

          <SectionHeader>{t('tills')}</SectionHeader>
          <div className="grid gap-3 lg:grid-cols-2">
            {events.map((e) => {
              const max = Math.max(1, ...e.tills.map((x) => x.salesPerHour));
              return (
                <Card key={e.event.id} className="space-y-2">
                  <div className="text-[15px] font-semibold">{e.event.name}</div>
                  <ul className="space-y-2">
                    {bySalesPerHour(e).map((x) => (
                      <li key={x.machineId} className="grid grid-cols-[minmax(5rem,8rem)_1fr_auto] items-center gap-3 text-[14px]">
                        <span className="truncate">{x.name}</span>
                        <Capsule value={x.salesPerHour} max={max} color={x.weak || x.noSales ? '#FF3B30' : undefined} />
                        <span className="tabular-nums">{t('perHour', { value: money(x.salesPerHour) })}</span>
                      </li>
                    ))}
                  </ul>
                  <div className="border-t border-[#3C3C4320] pt-2 text-[13px] text-[#8E8E93] dark:border-[#54545866]">
                    {t('topItems')}: {e.topItems.map((i) => `${i.name} (${money(i.revenue)})`).join(' · ') || '—'}
                  </div>
                </Card>
              );
            })}
          </div>
        </>
      )}
    </InsightsSurface>
  );
}
