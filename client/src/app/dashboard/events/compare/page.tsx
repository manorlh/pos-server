'use client';

/**
 * Events side by side (`/report-events/compare`): the customers who split one shop into
 * two events want to see which did better and why — the headline figures (the best of
 * each row marked), each event's tills by sales per hour, and the top items.
 */

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
import { ReportExportToolbar } from '@/components/dashboard/report-export-toolbar';
import { EXCEL_FILL, type ExcelSheet } from '@/lib/excelExport';

type Row = {
  key: string;
  value: (e: EventCompareEntry) => number | null;
  format: (n: number | null) => string;
  /** Less is better (refunds, alerts). */
  invert?: boolean;
};

export default function EventsComparePage() {
  const t = useTranslations('events.compareView');
  const te = useTranslations('events');
  const ids = useSearchParams().get('ids') ?? '';
  const query = useQuery({
    queryKey: ['event-compare', ids],
    queryFn: () => fetchEventCompare(ids),
    enabled: ids.split(',').filter(Boolean).length >= 2,
  });
  const events = query.data ?? [];

  const rows: Row[] = [
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
  const best = (row: Row): number | null => {
    const values = events.map(row.value).filter((v): v is number => v !== null);
    if (values.length < 2) return null;
    return row.invert ? Math.min(...values) : Math.max(...values);
  };
  const chart = events.map((e, i) => ({ name: e.event.name, net: e.kpis.net, avg: e.kpis.avgTicket, color: tillColor(i) }));

  /**
   * The figures grid (a row per figure, a column per event — numbers, the unit in the
   * figure's name, the best named beside it), every event's tills by sales per hour (weak
   * and silent tills highlighted, as on screen), and the top items.
   */
  const exportSheets = (): ExcelSheet[] => {
    const unit = (row: Row) => (row.format === money ? ' (₪)' : row.key === 'tipPct' ? ' (%)' : '');
    const tills = events.flatMap((e) =>
      e.tills
        .slice()
        .sort((a, b) => b.salesPerHour - a.salesPerHour)
        .map((x) => ({ event: e.event.name, x })),
    );
    return [
      {
        name: t('figures'),
        columns: [
          { header: t('figures') },
          ...events.map((e) => ({
            header: `${e.event.name} · ${clockLabel(e.event.startsAt, e.event.timezone, true)}`,
            kind: 'number' as const,
            width: 18,
          })),
          { header: t('best') },
        ],
        rows: rows.map((row) => {
          const top = best(row);
          return [
            `${t(`rows.${row.key}`)}${unit(row)}`,
            ...events.map(row.value),
            top === null ? null : events.filter((e) => row.value(e) === top).map((e) => e.event.name).join(', '),
          ];
        }),
        autoFilter: false,
      },
      {
        name: t('tills'),
        columns: [
          { header: te('form.name') },
          { header: te('tills.till') },
          { header: te('tills.perHour'), kind: 'money' },
          { header: te('tills.net'), kind: 'money' },
          { header: te('tills.sales'), kind: 'number' },
          { header: te('tills.avgTicket'), kind: 'money' },
          { header: te('tills.share'), kind: 'percent' },
          { header: t('rows.tipPct'), kind: 'percent' },
        ],
        rows: tills.map(({ event, x }) => [
          event, x.name, x.salesPerHour, x.net, x.salesCount, x.avgTicket, x.sharePct, x.tipPct,
        ]),
        rowFills: tills.map(({ x }) => (x.weak || x.noSales ? EXCEL_FILL.missing : null)),
      },
      {
        name: t('topItems'),
        columns: [
          { header: te('form.name') },
          { header: te('items.item') },
          { header: te('items.quantity'), kind: 'number' },
          { header: te('items.revenue'), kind: 'money' },
          { header: te('items.share'), kind: 'percent' },
        ],
        rows: events.flatMap((e) => e.topItems.map((i) => [e.event.name, i.name, i.quantity, i.revenue, i.sharePct])),
      },
    ];
  };
  const startDates = events.map((e) => e.event.startDate).filter(Boolean).sort();
  const endDates = events.map((e) => e.event.endDate).filter(Boolean).sort();

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
      <ReportExportToolbar
        className="mt-3 px-1"
        title={t('title')}
        from={startDates[0]}
        to={endDates[endDates.length - 1]}
        disabled={events.length === 0}
        getSheets={exportSheets}
      />

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
                {rows.map((row) => {
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
                    {e.tills
                      .slice()
                      .sort((a, b) => b.salesPerHour - a.salesPerHour)
                      .map((x) => (
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
