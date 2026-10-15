'use client';

/**
 * The control board's "ייצוא" (P:\specs\reports-designed-pdf.md §2): the designed PDF, Excel and
 * CSV of the board view as it stands — for today a snapshot of a live board (it refreshes every
 * 30 seconds). The tills the tree shows (its search and filter apply), by shop and point of
 * sale, each with its state and, where the board shows money, its sales; the day by the hour,
 * the tenders and the best sellers, each against the compared day when there is one. The
 * headline figures carry the comparison the board's cards show (▲/▼ against the compared day).
 *
 * Without "דוחות" (or with an event, whose tills' money the tree hides) no money goes out —
 * the same rule as the screen.
 */

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { EXCEL_FILL } from '@/lib/excelExport';
import type { ReportChart, ReportKpi } from '@/lib/designedReport';
import type { ReportFilterLine } from '@/lib/reportExport';
import { averageTicket, type HourPoint, type SalesFigures } from '@/lib/controlBoard';
import type { CompanyNode, TillNode } from '@/lib/overview';
import { StandaloneExportBar, type ReportColumn, type ReportTableSpec } from '@/components/dashboard/report-framework';

interface TillRow {
  company: string;
  shop: string;
  area: string | null;
  till: TillNode;
}

interface BoardItem {
  key: string;
  name: string;
  qtyA: number;
  netA: number;
  qtyB: number;
  netB: number;
}

type TenderKey = 'card' | 'cash' | 'other' | 'tips';
const TENDERS: TenderKey[] = ['card', 'cash', 'other', 'tips'];

export function BoardExport({
  tree,
  showSales,
  showTillMoney,
  a,
  b,
  labelA,
  labelB,
  points,
  items,
  tills,
  from,
  to,
  place,
  filterLines,
  disabled,
}: {
  /** The tree as shown (search and filter applied). */
  tree: CompanyNode[];
  /** The user sees the figures ("דוחות"). */
  showSales: boolean;
  /** The tills' own money is shown (not with an event). */
  showTillMoney: boolean;
  a: SalesFigures;
  b: SalesFigures | null;
  labelA: string;
  labelB: string | null;
  points: HourPoint[];
  items: BoardItem[];
  tills: { total: number; online: number; openShifts: number; alerts: number };
  from: string | null;
  to: string | null;
  place: string | null;
  filterLines: ReportFilterLine[];
  disabled: boolean;
}) {
  const t = useTranslations('controlBoard');
  const tO = useTranslations('dashboard.overview');
  const tc = useTranslations('common');

  const tables = useMemo(() => {
    const rows: TillRow[] = tree.flatMap((company) =>
      company.shops.flatMap((shop) =>
        shop.tills.map((till) => ({
          company: company.sales.name,
          shop: shop.sales.name,
          area: (shop.sales.areas ?? []).find((x) => x.id === till.sales.areaId)?.name ?? null,
          till,
        })),
      ),
    );
    const money = showSales && showTillMoney;
    const tillTable: ReportTableSpec<TillRow> = {
      id: 'main',
      title: t('tills.title'),
      rows,
      rowKey: (r) => r.till.sales.id,
      rowFill: (r) => (r.till.online ? (r.till.alerts > 0 ? EXCEL_FILL.difference : null) : EXCEL_FILL.missing),
      ...(money ? { totalsLabel: tc('total') } : {}),
      columns: [
        { key: 'company', header: t('filters.company'), width: 18, defaultHidden: true, value: (r) => r.company },
        { key: 'shop', header: t('filters.shop'), width: 18, value: (r) => r.shop },
        { key: 'area', header: t('filters.area'), width: 16, value: (r) => r.area },
        { key: 'till', header: t('filters.machine'), width: 18, required: true, value: (r) => r.till.sales.name },
        { key: 'register', header: t('boardExport.register'), kind: 'number', value: (r) => r.till.registerNumber },
        { key: 'status', header: t('tills.status'), width: 12, value: (r) => (r.till.online ? tO('till.online') : tO('till.offline')) },
        { key: 'openShift', header: t('boardExport.openShift'), width: 10, value: (r) => (r.till.openShift ? tc('yes') : tc('no')) },
        { key: 'alerts', header: t('boardExport.alerts'), kind: 'number', value: (r) => r.till.alerts },
        ...(money
          ? ([
              {
                key: 'net',
                header: t('boardExport.net'),
                kind: 'money',
                value: (r) => r.till.sales.salesToday,
                totalOf: (all) => all.reduce((n, r) => n + r.till.sales.salesToday, 0),
              },
              {
                key: 'transactions',
                header: t('kpi.transactions'),
                kind: 'number',
                value: (r) => r.till.sales.salesCount,
                totalOf: (all) => all.reduce((n, r) => n + r.till.sales.salesCount, 0),
              },
            ] satisfies ReportColumn<TillRow>[])
          : []),
      ],
    };
    if (!showSales) return [tillTable as ReportTableSpec<unknown>];

    const hours: ReportTableSpec<HourPoint> = {
      id: 'hours',
      title: t('hourly.title'),
      rows: points,
      rowKey: (p) => String(p.hour),
      columns: [
        { key: 'hour', header: t('boardExport.hour'), width: 10, required: true, value: (p) => p.label },
        { key: 'netA', header: t('boardExport.netOf', { label: labelA }), kind: 'money', value: (p) => p.a },
        ...(labelB ? [{ key: 'netB', header: t('boardExport.netOf', { label: labelB }), kind: 'money', value: (p) => p.b } satisfies ReportColumn<HourPoint>] : []),
        { key: 'cumulativeA', header: t('boardExport.cumulativeOf', { label: labelA }), kind: 'money', value: (p) => p.ca },
      ],
    };
    const tenders: ReportTableSpec<TenderKey> = {
      id: 'tenders',
      title: t('tenders.title'),
      rows: TENDERS,
      rowKey: (k) => k,
      autoFilter: false,
      columns: [
        { key: 'tender', header: t('boardExport.tender'), width: 16, required: true, value: (k) => t(`tenders.${k}`) },
        { key: 'amountA', header: t('boardExport.amountOf', { label: labelA }), kind: 'money', value: (k) => a[k] },
        ...(labelB && b ? [{ key: 'amountB', header: t('boardExport.amountOf', { label: labelB }), kind: 'money', value: (k) => b[k] } satisfies ReportColumn<TenderKey>] : []),
      ],
    };
    const best: ReportTableSpec<BoardItem> = {
      id: 'items',
      title: t('items.title'),
      rows: items,
      rowKey: (i) => i.key,
      columns: [
        { key: 'item', header: t('boardExport.item'), width: 24, required: true, value: (i) => i.name },
        { key: 'qtyA', header: t('boardExport.qtyOf', { label: labelA }), kind: 'number', value: (i) => i.qtyA },
        { key: 'netA', header: t('boardExport.netOf', { label: labelA }), kind: 'money', value: (i) => i.netA },
        ...(labelB
          ? ([
              { key: 'qtyB', header: t('boardExport.qtyOf', { label: labelB }), kind: 'number', value: (i) => i.qtyB },
              { key: 'netB', header: t('boardExport.netOf', { label: labelB }), kind: 'money', value: (i) => i.netB },
            ] satisfies ReportColumn<BoardItem>[])
          : []),
      ],
    };
    return [
      tillTable as ReportTableSpec<unknown>,
      ...(points.length ? [hours as ReportTableSpec<unknown>] : []),
      tenders as ReportTableSpec<unknown>,
      ...(items.length ? [best as ReportTableSpec<unknown>] : []),
    ];
  }, [a, b, items, labelA, labelB, points, showSales, showTillMoney, t, tO, tc, tree]);

  // The cards' figures, each against the compared day as the cards show it.
  const vs = (value: number) => (b ? { compare: value, compareLabel: labelB ?? undefined } : {});
  const kpis: ReportKpi[] = showSales
    ? [
        { key: 'net', label: t('kpi.sales'), value: a.salesToday, kind: 'money', icon: 'sales', ...vs(b?.salesToday ?? 0) },
        { key: 'transactions', label: t('kpi.transactions'), value: a.salesCount, kind: 'count', icon: 'receipt', ...vs(b?.salesCount ?? 0) },
        { key: 'avgTicket', label: t('kpi.averageTicket'), value: averageTicket(a), kind: 'money', icon: 'basket', ...vs(b ? averageTicket(b) : 0) },
        { key: 'refunds', label: t('boardExport.refunds'), value: a.refunds, kind: 'money', icon: 'refund', better: 'down', ...vs(b?.refunds ?? 0) },
        ...(a.tips > 0 ? [{ key: 'tips', label: t('tenders.tips'), value: a.tips, kind: 'money', icon: 'tip', ...vs(b?.tips ?? 0) } satisfies ReportKpi] : []),
        { key: 'activeTills', label: t('kpi.activeTills'), value: tills.online, kind: 'count', icon: 'kiosk' },
      ]
    : [
        { key: 'tills', label: t('tills.title'), value: tills.total, kind: 'count', icon: 'kiosk' },
        { key: 'online', label: tO('kpi.tillsOnline'), value: tills.online, kind: 'count' },
        { key: 'openShifts', label: tO('kpi.openShifts'), value: tills.openShifts, kind: 'count', icon: 'clock' },
        { key: 'alerts', label: tO('kpi.alerts'), value: tills.alerts, kind: 'count', icon: 'alert', better: 'down' },
      ];
  const chart: ReportChart | null =
    showSales && points.length
      ? {
          type: 'bar',
          title: t('hourly.title'),
          labels: points.map((p) => p.label),
          series: [
            { name: labelA, values: points.map((p) => p.a) },
            ...(labelB ? [{ name: labelB, values: points.map((p) => p.b) }] : []),
          ],
          kind: 'money',
        }
      : !showSales && tills.total > 0
        ? {
            type: 'donut',
            title: t('tills.title'),
            labels: [tO('till.online'), tO('till.offline')],
            series: [{ name: t('tills.title'), values: [tills.online, tills.total - tills.online] }],
            kind: 'number',
          }
        : null;

  return (
    <StandaloneExportBar
      reportKey="home-board"
      reportType="compare.board"
      title={t('title')}
      tables={tables}
      from={from}
      to={to}
      place={place}
      filterLines={filterLines}
      kpis={kpis}
      chart={chart}
      groupBy={['shop', 'area']}
      disabled={disabled}
    />
  );
}
