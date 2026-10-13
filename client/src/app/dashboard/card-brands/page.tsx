'use client';

/**
 * Clearing report (דוח סליקה) — card takings per brand (מותג) and per acquirer
 * (חברת סליקה), sales and credit notes apart, per shop. For reconciling with the card
 * companies' settlement reports. Server: `GET /reports/card-brands`.
 *
 * The brand and acquirer come from the terminal's reply (`mutag` / `solek`), else the
 * card's BIN; "לא ידוע" is a leg whose reply named neither. Tips are not card legs, so
 * the net is the card total of "sales by payment method" for the same window — no tips
 * column here, on purpose (§2ה).
 *
 * On the report framework (P:\specs\reports-upgrade.md §5): days, hours, area and cashier in
 * the URL; the company (§4.1), the shop and the till from the scope.
 */

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { usePageScope } from '@/lib/scope';
import { formatCurrency } from '@/lib/format';
import { scopeApiParams, type ReportFilterSpec } from '@/lib/reportFilters';
import { useCardBrandLabels } from '@/lib/cardBrands';
import {
  fetchCardBrandsReport,
  type CardBrandRow,
  type CardBrandTotal,
  type CardBrandsReport,
} from '@/lib/salesReportsApi';
import { ReportWindowSummary } from '@/components/dashboard/report-window-summary';
import {
  ReportPage,
  ReportTable,
  reportQueryState,
  useReportFilters,
  type ReportTableSpec,
} from '@/components/dashboard/report-framework';

const SPEC: ReportFilterSpec = { filters: ['hours', 'area', 'cashier'] };

/** An amount with its count in brackets, as the breakdown shows them. */
function AmountWithCount({ amount, count }: { amount: number; count: number }) {
  return (
    <>
      {formatCurrency(amount)} <span className="text-muted-foreground text-xs">({count})</span>
    </>
  );
}

export default function CardBrandsReportPage() {
  const t = useTranslations('cardBrandsReport');
  const labels = useCardBrandLabels();
  const { resolution, effective } = usePageScope({ maxLevel: 'machine' });
  const filters = useReportFilters(SPEC);

  const params = useMemo(
    () => (filters.apiParams ? { ...filters.apiParams, ...scopeApiParams(effective) } : null),
    [effective, filters.apiParams],
  );

  const query = useQuery<CardBrandsReport>({
    queryKey: ['report-card-brands', params],
    queryFn: () => fetchCardBrandsReport(params!),
    enabled: params !== null,
  });
  const data = query.data;

  const { acquirer: acquirerLabel, brand: brandLabel } = labels;

  /** By acquirer / by brand: one row per code, the report's totals below. */
  const totalsTable = useMemo(
    () =>
      (id: string, title: string, nameHeader: string, rows: CardBrandTotal[], label: (code: string) => string): ReportTableSpec<CardBrandTotal> => ({
        id,
        title,
        rows,
        rowKey: (r) => r.key,
        totalsLabel: t('total'),
        emptyText: t('noRows'),
        columns: [
          { key: 'name', header: nameHeader, required: true, value: (r) => label(r.key), className: 'font-medium' },
          { key: 'salesCount', header: t('col.salesCount'), kind: 'number', value: (r) => r.salesCount, total: data?.salesCount },
          { key: 'salesAmount', header: t('col.salesAmount'), kind: 'money', value: (r) => r.salesAmount, total: data?.salesAmount },
          { key: 'refundsCount', header: t('col.refundsCount'), kind: 'number', value: (r) => r.refundsCount, total: data?.refundsCount },
          {
            key: 'refundsAmount',
            header: t('col.refundsAmount'),
            kind: 'money',
            // Positive in the export (as the server sends it); the screen shows it as a deduction.
            value: (r) => r.refundsAmount,
            cell: (r) => (r.refundsAmount ? formatCurrency(-r.refundsAmount) : '—'),
            total: data?.refundsAmount,
            totalCell: data ? (data.refundsAmount ? formatCurrency(-data.refundsAmount) : '—') : undefined,
          },
          { key: 'net', header: t('col.net'), kind: 'money', value: (r) => r.net, total: data?.net, className: 'font-semibold' },
          // The export's totals row says 100%, as it always has; the screen leaves the cell empty.
          { key: 'share', header: t('col.share'), kind: 'percent', value: (r) => r.share, total: 100, totalCell: null },
        ],
      }),
    [data, t],
  );

  const byAcquirer = useMemo(
    () => totalsTable('main', t('byAcquirer'), t('col.acquirer'), data?.byAcquirer ?? [], acquirerLabel),
    [acquirerLabel, data, t, totalsTable],
  );
  const byBrand = useMemo(
    () => totalsTable('brands', t('byBrand'), t('col.brand'), data?.byBrand ?? [], brandLabel),
    [brandLabel, data, t, totalsTable],
  );

  const breakdown = useMemo<ReportTableSpec<CardBrandRow>>(
    () => ({
      id: 'shops',
      title: t('breakdownTitle'),
      rows: data?.rows ?? [],
      rowKey: (r, i) => `${r.shopId}-${r.acquirer}-${r.brand}-${i}`,
      totalsLabel: t('total'),
      emptyText: t('noRows'),
      columns: [
        { key: 'shop', header: t('col.shop'), required: true, value: (r) => r.shopName ?? null, className: 'text-muted-foreground' },
        { key: 'acquirer', header: t('col.acquirer'), value: (r) => acquirerLabel(r.acquirer) },
        { key: 'brand', header: t('col.brand'), value: (r) => brandLabel(r.brand) },
        // The screen writes each count in brackets beside its amount; the export has them as columns.
        { key: 'salesCount', header: t('col.salesCount'), kind: 'number', exportOnly: true, value: (r) => r.salesCount, total: data?.salesCount },
        {
          key: 'salesAmount',
          header: t('col.salesAmount'),
          kind: 'money',
          value: (r) => r.salesAmount,
          cell: (r) => <AmountWithCount amount={r.salesAmount} count={r.salesCount} />,
          total: data?.salesAmount,
          totalCell: data ? <AmountWithCount amount={data.salesAmount} count={data.salesCount} /> : undefined,
        },
        { key: 'refundsCount', header: t('col.refundsCount'), kind: 'number', exportOnly: true, value: (r) => r.refundsCount, total: data?.refundsCount },
        {
          key: 'refundsAmount',
          header: t('col.refundsAmount'),
          kind: 'money',
          value: (r) => r.refundsAmount,
          cell: (r) => (r.refundsCount ? <AmountWithCount amount={-r.refundsAmount} count={r.refundsCount} /> : '—'),
          total: data?.refundsAmount,
          totalCell: data ? (data.refundsCount ? <AmountWithCount amount={-data.refundsAmount} count={data.refundsCount} /> : '—') : undefined,
        },
        { key: 'net', header: t('col.net'), kind: 'money', value: (r) => r.net, total: data?.net, className: 'font-medium' },
      ],
    }),
    [acquirerLabel, brandLabel, data, t],
  );

  const tables = [byAcquirer, byBrand, breakdown] as ReportTableSpec<unknown>[];

  return (
    <ReportPage
      reportKey="card-brands"
      title={t('title')}
      subtitle={t('subtitle')}
      resolution={resolution}
      filters={filters}
      bar={{ shopId: effective.shopId }}
      query={reportQueryState(query)}
      prompt={t('selectFilters')}
      loading="table"
      export={data ? { tables, from: data.window.from, to: data.window.to } : null}
    >
      {data ? (
        <>
          <ReportWindowSummary window={data.window} generatedAt={data.generatedAt} />
          {data.rows.length === 0 ? (
            <p className="text-muted-foreground py-10 text-center text-sm">{t('noRows')}</p>
          ) : (
            <>
              <ReportTable table={byAcquirer} />
              <ReportTable table={byBrand} />
              <ReportTable table={breakdown} />
            </>
          )}
        </>
      ) : null}
    </ReportPage>
  );
}
