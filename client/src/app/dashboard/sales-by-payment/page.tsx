'use client';

/**
 * Sales by payment method (מכירות לפי אמצעי תשלום) — docs/ACCOUNTING_EXPORT_AND_REPORTS.md §4.3.1.
 *
 * Net takings per tender, from the tender legs (a credit note's legs subtract), so the
 * total is the per-cashier report's net for the same window. The breakdown is per local
 * day, shop and till; the cards are the window's totals per method.
 *
 * On the report framework (P:\specs\reports-upgrade.md §5): days, hours, area, cashier
 * (§4.1), a payment method and a search in the URL. The method narrows the rows on the
 * page (the endpoint has no such filter). Tips are their own section (§4.2), never inside the
 * methods' amounts.
 */

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { usePageScope } from '@/lib/scope';
import { formatCurrency } from '@/lib/format';
import { scopeApiParams, type ReportFilterSpec } from '@/lib/reportFilters';
import {
  fetchPaymentMethodsReport,
  type PaymentMethodRow,
  type PaymentMethodTotal,
  type PaymentMethodsReport,
  type TipTenderRow,
} from '@/lib/salesReportsApi';
import { ReportWindowSummary } from '@/components/dashboard/report-window-summary';
import { Card, CardContent } from '@/components/ui/card';
import {
  ReportPage,
  ReportTable,
  reportQueryState,
  useReportFilters,
  type ReportColumn,
  type ReportTableSpec,
} from '@/components/dashboard/report-framework';

const BAR = { cash: 'bg-emerald-500', card: 'bg-blue-500', exchange: 'bg-slate-400', production_voucher: 'bg-violet-500', other: 'bg-amber-500' };
/** The methods a filter offers before the report has run (the report's own add to them). */
const KNOWN_METHODS = ['cash', 'card', 'production_voucher', 'bit', 'check', 'exchange', 'other'];

const SPEC: ReportFilterSpec = {
  filters: ['hours', 'area', 'cashier', 'method', 'search'],
  clientFilters: ['method', 'search'],
};

const round2 = (n: number) => Math.round(n * 100) / 100;

export default function SalesByPaymentPage() {
  const t = useTranslations('paymentReport');
  const tt = useTranslations('tips');
  const { resolution, effective } = usePageScope({ maxLevel: 'machine' });
  const filters = useReportFilters(SPEC);

  const params = useMemo(
    () => (filters.apiParams ? { ...filters.apiParams, ...scopeApiParams(effective) } : null),
    [effective, filters.apiParams],
  );

  const query = useQuery<PaymentMethodsReport>({
    queryKey: ['report-payment-methods', params],
    queryFn: () => fetchPaymentMethodsReport(params!),
    enabled: params !== null,
  });
  const data = query.data;

  const methodLabel = useMemo(() => (m: string) => (t.has(`method.${m}`) ? t(`method.${m}`) : m), [t]);
  const method = filters.applied?.values.method ?? '';

  const methodOptions = useMemo(() => {
    const seen = new Set<string>();
    return [...KNOWN_METHODS, ...(data?.totals ?? []).map((m) => m.method)]
      .filter((m) => (seen.has(m) ? false : (seen.add(m), true)))
      .map((m) => ({ value: m, label: methodLabel(m) }));
  }, [data, methodLabel]);

  const rows = useMemo(() => (data?.rows ?? []).filter((r) => !method || r.method === method), [data, method]);
  const methodTotals = useMemo(() => (data?.totals ?? []).filter((m) => !method || m.method === method), [data, method]);
  const total = method ? round2(rows.reduce((s, r) => s + r.amount, 0)) : (data?.total ?? 0);

  const breakdown = useMemo<ReportTableSpec<PaymentMethodRow>>(() => {
    const columns: ReportColumn<PaymentMethodRow>[] = [
      { key: 'day', header: t('col.day'), kind: 'date', required: true, value: (r) => r.day },
      { key: 'shop', header: t('col.shop'), value: (r) => r.shopName ?? null, className: 'text-muted-foreground' },
      { key: 'till', header: t('col.till'), value: (r) => r.machineName ?? null },
      { key: 'method', header: t('col.method'), value: (r) => methodLabel(r.method) },
      { key: 'amount', header: t('col.amount'), kind: 'money', value: (r) => r.amount, total, className: 'font-medium' },
      { key: 'documents', header: t('col.documents'), kind: 'number', value: (r) => r.documents },
    ];
    return {
      id: 'main',
      title: t('breakdownTitle'),
      columns,
      rows,
      rowKey: (r, i) => `${r.day}-${r.machineId}-${r.method}-${i}`,
      totalsLabel: t('total'),
      emptyText: t('noRows'),
    };
  }, [methodLabel, rows, t, total]);

  const byMethod = useMemo<ReportTableSpec<PaymentMethodTotal>>(
    () => ({
      id: 'methods',
      title: t('totalsTitle'),
      columns: [
        { key: 'method', header: t('col.method'), required: true, value: (r) => methodLabel(r.method), className: 'font-medium' },
        { key: 'amount', header: t('col.amount'), kind: 'money', value: (r) => r.amount, total },
        { key: 'documents', header: t('col.documents'), kind: 'number', value: (r) => r.documents },
        { key: 'share', header: t('col.share'), kind: 'percent', value: (r) => r.share, total: method ? null : 100 },
      ],
      rows: methodTotals,
      rowKey: (r) => r.method,
      totalsLabel: t('total'),
      emptyText: t('noRows'),
    }),
    [method, methodLabel, methodTotals, t, total],
  );

  /** Tips by tender, apart from the takings (§4.2) — when the server sends them. */
  const tips = useMemo<ReportTableSpec<TipTenderRow> | null>(() => {
    if (!data?.tips) return null;
    const label = (m: TipTenderRow['method']) => (m === 'cash' ? tt('cashTips') : m === 'card' ? tt('cardTips') : tt('otherTips'));
    return {
      id: 'tips',
      title: t('tipsTitle'),
      columns: [
        { key: 'method', header: t('col.method'), required: true, value: (r) => label(r.method), className: 'font-medium' },
        { key: 'amount', header: t('col.amount'), kind: 'money', value: (r) => r.amount, total: data.tipsTotal ?? null },
        {
          key: 'documents',
          header: t('col.tippedDocuments'),
          kind: 'number',
          value: (r) => r.documents,
          total: data.tips.reduce((s, r) => s + r.documents, 0),
        },
      ],
      rows: data.tips,
      rowKey: (r) => r.method,
      totalsLabel: t('total'),
      emptyText: t('noRows'),
    };
  }, [data, t, tt]);

  const tables = [byMethod, breakdown, ...(tips ? [tips] : [])] as ReportTableSpec<unknown>[];

  return (
    <ReportPage
      reportKey="sales-by-payment"
      title={t('title')}
      subtitle={t('subtitle')}
      resolution={resolution}
      filters={filters}
      bar={{ shopId: effective.shopId, methodOptions }}
      query={reportQueryState(query)}
      prompt={t('selectFilters')}
      loading="table"
      export={data ? { tables, pdfTableId: 'main', from: data.window.from, to: data.window.to } : null}
    >
      {data ? (
        <>
          <ReportWindowSummary window={data.window} generatedAt={data.generatedAt} />

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {methodTotals.map((m) => (
              <Card key={m.method}>
                <CardContent className="space-y-2 pt-6">
                  <div className="text-muted-foreground text-sm">{methodLabel(m.method)}</div>
                  <div className="text-2xl font-bold tabular-nums">{formatCurrency(m.amount)}</div>
                  <div className="bg-muted h-2 overflow-hidden rounded-full">
                    <div
                      className={`h-2 ${BAR[m.bucket] ?? BAR.other}`}
                      style={{ width: `${Math.min(100, Math.max(0, m.share))}%` }}
                    />
                  </div>
                  <div className="text-muted-foreground text-xs">
                    {t('shareOf', { share: m.share.toFixed(1), documents: m.documents })}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          <ReportTable table={breakdown} />
          {tips ? (
            <div className="space-y-1">
              <ReportTable table={tips} />
              <p className="text-muted-foreground text-xs">{t('tipsNote')}</p>
            </div>
          ) : null}
        </>
      ) : null}
    </ReportPage>
  );
}
