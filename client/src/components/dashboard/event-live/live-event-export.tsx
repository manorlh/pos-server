'use client';

/**
 * "מצב אירוע חי" — "ייצוא" (P:\specs\reports-designed-pdf.md §2): the designed PDF, Excel and
 * CSV of the big screen. A snapshot of what the screen shows now (it refreshes itself every
 * 15 s to 5 min): the tills with their sales, every item of the event, the sales over time
 * (the screen's 1- or 5-minute buckets), the vouchers by kind, and the headline figures. The
 * PDF's chart is the sales by the hour (by the day for an event of more than two days), so a
 * long event still fits on it; the sheet keeps every bucket.
 */

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { EXCEL_FILL } from '@/lib/excelExport';
import type { ReportChart, ReportKpi } from '@/lib/designedReport';
import type { ReportFilterLine } from '@/lib/reportExport';
import { formatTime } from '@/lib/format';
import { chartRows, orderTills, type ChartRow, type EventLive, type LiveItem, type LivePoint, type LiveTill } from '@/lib/eventLive';
import { StandaloneExportBar, type ReportTableSpec } from '@/components/dashboard/report-framework';

type Batch = EventLive['vouchers']['byBatch'][number];

/** The chart's most labels (§7.1). */
const MAX_POINTS = 48;

/** "YYYY-MM-DD HH" of an instant in the event's zone. */
function hourKey(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}`;
}

/**
 * The sales over time for the PDF's chart: by the hour ("14:00", or "12/10 14:00" across
 * days), or by the day when the hours would be more than the chart takes.
 */
function liveChartPoints(series: LivePoint[], timeZone: string): { byDay: boolean; labels: string[]; values: number[] } {
  const sums = new Map<string, number>();
  for (const p of series) {
    const key = hourKey(p.at, timeZone);
    sums.set(key, (sums.get(key) ?? 0) + p.net);
  }
  const days = new Set([...sums.keys()].map((k) => k.slice(0, 10)));
  const dayLabel = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}`;
  if (sums.size > MAX_POINTS) {
    const byDay = new Map<string, number>();
    for (const [k, v] of sums) byDay.set(k.slice(0, 10), (byDay.get(k.slice(0, 10)) ?? 0) + v);
    return { byDay: true, labels: [...byDay.keys()].map(dayLabel), values: [...byDay.values()].map((v) => Math.round(v * 100) / 100) };
  }
  return {
    byDay: false,
    labels: [...sums.keys()].map((k) => `${days.size > 1 ? `${dayLabel(k.slice(0, 10))} ` : ''}${k.slice(11)}:00`),
    values: [...sums.values()].map((v) => Math.round(v * 100) / 100),
  };
}

export function LiveEventExport({ live }: { live: EventLive }) {
  const t = useTranslations('eventLive');
  const tc = useTranslations('common');
  const tz = live.event.timezone;

  const tables = useMemo(() => {
    const tills: ReportTableSpec<LiveTill> = {
      id: 'main',
      title: t('tills'),
      rows: orderTills(live.tills),
      rowKey: (x) => x.machineId,
      rowFill: (x) => (x.online ? null : EXCEL_FILL.missing),
      totalsLabel: tc('total'),
      columns: [
        { key: 'till', header: t('export.till'), width: 18, required: true, value: (x) => x.name },
        { key: 'pos', header: t('export.pos'), width: 8, value: (x) => x.posNumber },
        { key: 'connection', header: t('export.connection'), width: 12, value: (x) => (x.online ? t('online') : t('offline')) },
        { key: 'net', header: t('export.net'), kind: 'money', value: (x) => x.net, totalOf: (rows) => rows.reduce((n, x) => n + x.net, 0) },
        { key: 'sales', header: t('export.sales'), kind: 'number', value: (x) => x.sales, totalOf: (rows) => rows.reduce((n, x) => n + x.sales, 0) },
        { key: 'docs', header: t('export.docs'), kind: 'number', value: (x) => x.docs, totalOf: (rows) => rows.reduce((n, x) => n + x.docs, 0) },
        { key: 'lastSale', header: t('export.lastSale'), kind: 'datetime', value: (x) => x.lastSaleAt },
        { key: 'lastSeen', header: t('export.lastSeen'), kind: 'datetime', value: (x) => x.lastSeenAt },
        { key: 'pending', header: t('export.pending'), kind: 'number', value: (x) => x.pendingDocuments },
      ],
    };
    const items: ReportTableSpec<LiveItem> = {
      id: 'items',
      title: t('export.items'),
      rows: live.items.event,
      rowKey: (i) => i.key,
      totalsLabel: tc('total'),
      columns: [
        { key: 'item', header: t('export.item'), width: 26, required: true, value: (i) => i.name },
        { key: 'quantity', header: t('export.quantity'), kind: 'number', value: (i) => i.quantity, totalOf: (rows) => rows.reduce((n, i) => n + i.quantity, 0) },
        { key: 'revenue', header: t('export.revenue'), kind: 'money', value: (i) => i.revenue, totalOf: (rows) => rows.reduce((n, i) => n + i.revenue, 0) },
      ],
    };
    // The screen's own chart rows: each bucket's time in the event's zone, its sales and the running total.
    const timeline: ReportTableSpec<ChartRow> = {
      id: 'timeline',
      title: t('export.timeline'),
      sheetHeading: [t('chartTitle', { minutes: live.bucketMinutes })],
      rows: chartRows(live.series, tz),
      rowKey: (_p, i) => String(i),
      columns: [
        { key: 'time', header: t('export.time'), width: 10, required: true, value: (p) => p.label },
        { key: 'net', header: t('netPerBucket'), kind: 'money', value: (p) => p.net },
        { key: 'docs', header: t('export.docs'), kind: 'number', value: (p) => p.docs },
        { key: 'cumulative', header: t('runningTotal'), kind: 'money', value: (p) => p.cumulative },
      ],
    };
    const vouchers: ReportTableSpec<Batch> = {
      id: 'vouchers',
      title: t('export.vouchersSheet'),
      rows: live.vouchers.byBatch,
      rowKey: (b) => b.batchId,
      totalsLabel: tc('total'),
      columns: [
        { key: 'batch', header: t('export.batch'), width: 24, required: true, value: (b) => b.name },
        { key: 'redemptions', header: t('export.redemptions'), kind: 'number', value: (b) => b.redemptions, totalOf: (rows) => rows.reduce((n, b) => n + b.redemptions, 0) },
        { key: 'vouchers', header: t('export.vouchers'), kind: 'number', value: (b) => b.vouchers, totalOf: (rows) => rows.reduce((n, b) => n + b.vouchers, 0) },
        { key: 'units', header: t('export.units'), kind: 'number', value: (b) => b.units, totalOf: (rows) => rows.reduce((n, b) => n + b.units, 0) },
      ],
    };
    return [
      tills as ReportTableSpec<unknown>,
      ...(items.rows.length ? [items as ReportTableSpec<unknown>] : []),
      ...(timeline.rows.length ? [timeline as ReportTableSpec<unknown>] : []),
      ...(vouchers.rows.length ? [vouchers as ReportTableSpec<unknown>] : []),
    ];
  }, [live, t, tc, tz]);

  const totals = live.totals;
  const kpis: ReportKpi[] = [
    { key: 'net', label: t('export.net'), value: totals.net, kind: 'money', icon: 'sales' },
    ...(live.target
      ? [{ key: 'targetProgress', label: t('progress'), value: live.target.progressPct, kind: 'percent', icon: 'target' } satisfies ReportKpi]
      : []),
    ...(live.phase === 'live' && live.pace.projected !== null
      ? [{ key: 'projected', label: t('projected'), value: live.pace.projected, kind: 'money', icon: 'chart' } satisfies ReportKpi]
      : []),
    { key: 'transactions', label: t('documents'), value: totals.sales, kind: 'count', icon: 'receipt' },
    { key: 'avgTicket', label: t('avgTicket'), value: totals.avgTicket, kind: 'money', icon: 'basket' },
    { key: 'docsPerHour', label: t('docsPerHour'), value: totals.docsPerHour !== null ? Math.round(totals.docsPerHour) : null, kind: 'number', icon: 'clock' },
    { key: 'vouchers', label: t('export.kpiVouchers'), value: live.vouchers.redemptions, kind: 'count', icon: 'voucher' },
  ];
  const points = liveChartPoints(live.series, tz);
  const chart: ReportChart | null = points.labels.length
    ? {
        type: 'bar',
        title: points.byDay ? t('export.byDay') : t('export.byHour'),
        labels: points.labels,
        series: [{ name: t('export.net'), values: points.values }],
        kind: 'money',
      }
    : null;
  const filterLines: ReportFilterLine[] = [
    { label: t('export.phase'), value: t(`phase.${live.phase}`) },
    { label: t('export.asOf'), value: formatTime(live.now, { timeZone: tz }) },
  ];

  return (
    <StandaloneExportBar
      reportKey="live-event"
      reportType="events.live"
      title={t('export.title', { name: live.event.name })}
      tables={tables}
      from={live.event.startDate}
      to={live.event.endDate}
      place={live.event.shopName}
      filterLines={filterLines}
      kpis={kpis}
      chart={chart}
      // The screen is a fixed overlay: its print would be the dark wall, not a report.
      noPrint
    />
  );
}
