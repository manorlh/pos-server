'use client';

/**
 * Sales by department (מכירות לפי מחלקה) — docs/ACCOUNTING_EXPORT_AND_REPORTS.md §4.3.5.
 *
 * The product report's line money, rolled up to each product's category: units, gross,
 * discounts, refunds, net and each one's share of the net. No tips: a tip belongs to no item
 * (P:\specs\reports-upgrade.md §2ה).
 *
 * On the report framework (§5): filters in the URL (days, hours, area, cashier, search),
 * sortable columns the reader can hide and reorder, export columns.
 */

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { usePageScope } from '@/lib/scope';
import { formatCurrency } from '@/lib/format';
import { scopeApiParams, type ReportFilterSpec } from '@/lib/reportFilters';
import { fetchDepartmentReport, type DepartmentReport, type DepartmentRow } from '@/lib/salesReportsApi';
import { ReportWindowSummary } from '@/components/dashboard/report-window-summary';
import {
  ReportPage,
  ReportTable,
  reportQueryState,
  useReportFilters,
  type ReportColumn,
  type ReportTableSpec,
} from '@/components/dashboard/report-framework';

const SPEC: ReportFilterSpec = {
  filters: ['hours', 'area', 'cashier', 'search'],
  clientFilters: ['search'],
};

export default function DepartmentSalesPage() {
  const t = useTranslations('departmentReport');
  const { resolution, effective } = usePageScope({ maxLevel: 'machine' });
  const filters = useReportFilters(SPEC);

  const params = useMemo(
    () => (filters.apiParams ? { ...filters.apiParams, ...scopeApiParams(effective) } : null),
    [effective, filters.apiParams],
  );

  const query = useQuery<DepartmentReport>({
    queryKey: ['report-departments', params],
    queryFn: () => fetchDepartmentReport(params!),
    enabled: params !== null,
  });
  const data = query.data;

  const table = useMemo<ReportTableSpec<DepartmentRow>>(() => {
    const totals = data?.totals;
    const columns: ReportColumn<DepartmentRow>[] = [
      { key: 'department', header: t('col.department'), required: true, width: 26, value: (r) => r.categoryName ?? t('noCategory'), className: 'font-medium' },
      { key: 'units', header: t('col.units'), kind: 'number', value: (r) => r.units, total: totals?.units },
      { key: 'gross', header: t('col.gross'), kind: 'money', value: (r) => r.gross, total: totals?.gross },
      {
        key: 'discounts',
        header: t('col.discounts'),
        kind: 'money',
        value: (r) => r.discounts,
        cell: (r) => (r.discounts ? formatCurrency(r.discounts) : '—'),
        total: totals?.discounts,
      },
      {
        key: 'refunds',
        header: t('col.refunds'),
        kind: 'money',
        value: (r) => r.refunds,
        cell: (r) => (r.refunds ? formatCurrency(r.refunds) : '—'),
        total: totals?.refunds,
      },
      { key: 'net', header: t('col.net'), kind: 'money', value: (r) => r.net, total: totals?.net, className: 'font-semibold' },
      {
        key: 'share',
        header: t('col.share'),
        kind: 'percent',
        value: (r) => r.share,
        total: totals?.share,
        totalCell: '',
        headClassName: 'w-48',
        cell: (r) => (
          <div className="flex min-w-32 items-center gap-2">
            <div className="bg-muted h-2 flex-1 overflow-hidden rounded-full">
              <div className="bg-primary h-2" style={{ width: `${Math.min(100, Math.max(0, r.share))}%` }} />
            </div>
            <span className="w-12 text-end text-xs tabular-nums">{r.share.toFixed(1)}%</span>
          </div>
        ),
      },
    ];
    return {
      id: 'main',
      title: t('title'),
      columns,
      rows: data?.rows ?? [],
      rowKey: (r, i) => r.categoryId ?? `none-${i}`,
      totalsLabel: t('total'),
      emptyText: t('noRows'),
    };
  }, [data, t]);

  return (
    <ReportPage
      reportKey="department-sales"
      title={t('title')}
      subtitle={t('subtitle')}
      resolution={resolution}
      filters={filters}
      bar={{ shopId: effective.shopId }}
      query={reportQueryState(query)}
      prompt={t('selectFilters')}
      loading="table"
      export={data ? { tables: [table], from: data.window.from, to: data.window.to } : null}
    >
      {data ? (
        <>
          <ReportWindowSummary window={data.window} generatedAt={data.generatedAt} />
          <ReportTable table={table} />
        </>
      ) : null}
    </ReportPage>
  );
}
