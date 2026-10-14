'use client';

/**
 * Sales by area — one shop's takings split by the areas its tills are grouped into.
 *
 * Every sale counts under the area stamped on its shift when the shift was created,
 * never the till's area today: moving a till does not rewrite past totals. Sales of
 * shifts with no area (and sales with no shift) make the "no area" row. The rows sum
 * to the shop's total for the window — the server guarantees it, the page only shows
 * it. Archived areas still appear when they had sales in the window.
 *
 * One shop at a time: `GET /reports/sales-by-area` requires `shopId` (P:\specs\reports-upgrade.md
 * §4.1). On the report framework (§5): days, hours on each day and a search in the URL; tips
 * split by tender when the server sends it (§4.2).
 */

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { fetchSalesByArea } from '@/lib/api';
import { usePageScope } from '@/lib/scope';
import { downloadCsv, toCsv } from '@/lib/csv';
import { kpiNumber, previousWindow, type PreviousPeriod, type ReportKpi } from '@/lib/designedReport';
import type { ReportFilterSpec } from '@/lib/reportFilters';
import type { SalesByAreaReport, SalesByAreaRow, SalesByAreaTotals } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import {
  ReportPage,
  ReportTable,
  reportQueryState,
  useReportFilters,
  type ReportColumn,
  type ReportTableSpec,
} from '@/components/dashboard/report-framework';

const MONEY_COLS = [
  'gross', 'discounts', 'productionVoucherDeductions', 'net', 'refunds', 'cash', 'card', 'productionVoucher', 'other', 'tips',
] as const;
/** The tips split (§4.2): shown when the server sends it. */
const TIP_COLS = ['tipsCash', 'tipsCard', 'tipsOther'] as const;

const SPEC: ReportFilterSpec = {
  filters: ['hours', 'search'],
  clientFilters: ['search'],
};

/** The totals the designed PDF's cards show and compare with the previous period, by KPI key. */
function totalsFigures(tot: SalesByAreaTotals): Record<string, number | null> {
  return {
    net: kpiNumber(tot.net),
    gross: kpiNumber(tot.gross),
    transactions: tot.transactionsCount,
    discounts: kpiNumber(tot.discounts),
    refunds: kpiNumber(tot.refunds),
    tips: kpiNumber(tot.tips),
  };
}

export default function SalesByAreaPage() {
  const t = useTranslations('areaSales');
  const tc = useTranslations('common');

  // One shop at a time: an area belongs to one shop, and the rows add up to that shop.
  const { scope, resolution, effective } = usePageScope({ maxLevel: 'shop', minLevel: 'shop' });
  const shopId = effective.shopId;
  const shopName = scope.shop?.name ?? '';
  const filters = useReportFilters(SPEC);

  const params = useMemo(() => {
    const p = filters.apiParams;
    if (!p || !shopId) return null;
    return {
      shopId,
      dateFrom: String(p.from),
      dateTo: String(p.to),
      ...(p.fromHour !== undefined ? { fromHour: Number(p.fromHour), toHour: Number(p.toHour) } : {}),
    };
  }, [filters.apiParams, shopId]);

  const query = useQuery<SalesByAreaReport>({
    queryKey: ['report-sales-by-area', params],
    queryFn: () => fetchSalesByArea(params!),
    enabled: params !== null,
  });
  const data = query.data;

  const table = useMemo<ReportTableSpec<SalesByAreaRow>>(() => {
    const rowName = (row: Pick<SalesByAreaRow, 'areaId' | 'areaName'>) =>
      row.areaId === null ? t('unassigned') : (row.areaName ?? row.areaId);
    const totals = data?.totals;
    const hasTipSplit = Boolean(data && (totals?.tipsCash !== undefined || data.rows.some((r) => r.tipsCash !== undefined)));
    const columns: ReportColumn<SalesByAreaRow>[] = [
      {
        key: 'area',
        header: t('col.area'),
        required: true,
        value: rowName,
        className: 'font-medium',
        cell: (row) => (
          <span className="inline-flex flex-wrap items-center gap-2">
            <span className={row.areaId === null ? 'text-muted-foreground' : undefined}>{rowName(row)}</span>
            {row.archived ? <Badge variant="outline">{t('archivedBadge')}</Badge> : null}
          </span>
        ),
      },
      { key: 'archived', header: t('col.archived'), width: 8, exportOnly: true, value: (r) => (r.archived ? tc('yes') : null) },
      { key: 'transactions', header: t('col.transactions'), kind: 'number', value: (r) => r.transactionsCount, total: totals?.transactionsCount },
      ...MONEY_COLS.map(
        (c): ReportColumn<SalesByAreaRow> => ({
          key: c,
          header: t(`col.${c}`),
          kind: 'money',
          value: (r) => r[c] ?? null,
          total: totals?.[c] ?? null,
          className: c === 'net' ? 'font-semibold' : undefined,
        }),
      ),
      ...(hasTipSplit
        ? TIP_COLS.map(
            (c): ReportColumn<SalesByAreaRow> => ({
              key: c,
              header: t(`col.${c}`),
              kind: 'money',
              value: (r) => r[c] ?? null,
              total: totals?.[c] ?? null,
            }),
          )
        : []),
    ];
    return {
      id: 'main',
      title: t('title'),
      columns,
      rows: data?.rows ?? [],
      rowKey: (r) => r.areaId ?? '__none__',
      totalsLabel: t('totals'),
      emptyText: t('noRows'),
    };
  }, [data, t, tc]);

  /** The CSV the page always offered: every column, the server's values. */
  const exportCsv = () => {
    if (!data || !params) return;
    const cols = table.columns;
    const header = cols.map((c) => c.header);
    const rows = table.rows.map((r) => cols.map((c) => c.value(r)));
    rows.push(cols.map((c, i) => (i === 0 ? t('totals') : (c.total ?? ''))));
    const safeShop = shopName.replace(/[\\/:*?"<>|]+/g, '_').trim() || params.shopId;
    downloadCsv(`sales-by-area_${safeShop}_${params.dateFrom}_${params.dateTo}.csv`, toCsv(header, rows));
  };

  // The designed PDF (P:\specs\reports-designed-pdf.md §7): the totals row as cards, the areas
  // as bars, and the same shop's areas in the period before.
  const figures = data ? totalsFigures(data.totals) : null;
  const kpis: ReportKpi[] = figures
    ? [
        { key: 'net', label: t('col.net'), value: figures.net, kind: 'money', icon: 'sales' },
        { key: 'gross', label: t('col.gross'), value: figures.gross, kind: 'money' },
        { key: 'transactions', label: t('col.transactions'), value: figures.transactions, kind: 'count', icon: 'receipt' },
        { key: 'discounts', label: t('col.discounts'), value: figures.discounts, kind: 'money', icon: 'discount' },
        { key: 'refunds', label: t('col.refunds'), value: figures.refunds, kind: 'money', icon: 'refund' },
        { key: 'tips', label: t('col.tips'), value: figures.tips, kind: 'money', icon: 'tip' },
      ]
    : [];
  const previous = async (): Promise<PreviousPeriod | null> => {
    const w = previousWindow(params?.dateFrom, params?.dateTo);
    if (!params || !w) return null;
    const before = await fetchSalesByArea({ ...params, dateFrom: w.from, dateTo: w.to });
    return { rows: before.rows, kpis: totalsFigures(before.totals), ...w };
  };

  return (
    <ReportPage
      reportKey="area-sales"
      title={t('title')}
      subtitle={t('subtitle')}
      resolution={resolution}
      filters={filters}
      bar={{ shopId, hint: t('stampHint') }}
      query={reportQueryState(query)}
      prompt={t('selectFilters')}
      loading="table"
      export={
        data && params
          ? {
              tables: [table],
              from: params.dateFrom,
              to: params.dateTo,
              place: shopName,
              reportType: 'area-sales',
              kpis,
              chartFrom: { label: 'area', value: 'net', type: 'hbar' },
              previous,
              // The CSV the page always offered, now the export's.
              csv: exportCsv,
            }
          : null
      }
    >
      {data ? <ReportTable table={table} /> : null}
    </ReportPage>
  );
}
