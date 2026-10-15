'use client';

/**
 * The report of one prepaid voucher batch (שוברי הפקה), over its whole life:
 * vouchers by state, the goods (issued / taken / forfeited / outstanding / void), and the
 * redemptions by hour, day, shop, till and employee. Reversed redemptions — a payment
 * abandoned at the till — are left out by the server.
 *
 * On the report framework (P:\specs\reports-upgrade.md §5): the tables are `ReportTable`s (sort,
 * columns, phone cards, the days' totals) and the export bar is the framework's
 * (`prepaid-vouchers-batch`): Excel — the usage and the summary first, then every table, the hours
 * too — the goods' PDF (designed: the vouchers by state as its cards, the hours as its chart),
 * print, and the export columns.
 */

import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import {
  fetchPrepaidBatchReport,
  type PrepaidBatchReport,
  type PrepaidReportGroup,
  type PrepaidReportProduct,
  type PrepaidVoucherBatch,
} from '@/lib/prepaidVouchersApi';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { isDiscountKind } from '@/lib/prepaidVoucherBenefit';
import { DEFAULT_WEIGHT_UNIT } from '@/lib/prepaidVoucherProducts';
import { formatHour } from '@/lib/format';
import type { ExcelSheet } from '@/lib/excelExport';
import {
  ReportExportBar,
  ReportTable,
  useReportExportScope,
  type ReportChart,
  type ReportColumn,
  type ReportKpi,
  type ReportTableSpec,
} from '@/components/dashboard/report-framework';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

const REPORT_KEY = 'prepaid-vouchers-batch';

type Tr = ReturnType<typeof useTranslations>;
type Day = PrepaidBatchReport['byDay'][number];
type Hour = PrepaidBatchReport['byHour'][number];

function Counts({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="rounded-lg border px-3 py-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`text-xl font-semibold tabular-nums ${tone ?? ''}`}>{value}</p>
    </div>
  );
}

/** "זיתים (ק״ג)": by weight, every figure of the row is in its unit. */
const productName = (p: PrepaidReportProduct) => (p.weighed ? `${p.name ?? ''} (${p.unitLabel || DEFAULT_WEIGHT_UNIT})` : p.name ?? '');

/** By shop, till or employee: redemptions, vouchers and units ("פריטים", or a discount's "שימושים"). */
function groupTable(
  t: Tr,
  id: string,
  title: string,
  rows: PrepaidReportGroup[],
  nameHeader: string,
  unitsHeader: string,
  unknown: string,
  withShop = false,
): ReportTableSpec<PrepaidReportGroup> {
  return {
    id,
    title,
    rows,
    rowKey: (r, i) => r.key ?? `none-${i}`,
    emptyText: t('noRedemptions'),
    columns: [
      { key: 'name', header: nameHeader, required: true, value: (r) => r.name || unknown },
      ...(withShop ? [{ key: 'shop', header: t('col.shop'), value: (r: PrepaidReportGroup) => r.shopName || '' }] : []),
      { key: 'redemptions', header: t('col.redemptions'), kind: 'number', value: (r) => r.redemptions },
      { key: 'vouchers', header: t('col.vouchers'), kind: 'number', value: (r) => r.vouchers },
      { key: 'units', header: unitsHeader, kind: 'number', value: (r) => r.units },
    ],
  };
}

/** The sheets that are not a table of the page — the usage and the summary — first in the workbook, as before. */
function summarySheets(r: PrepaidBatchReport, t: Tr, units: string): ExcelSheet[] {
  const v = r.vouchers;
  const u = r.usage;
  // Usage (docs/SPEC_VOUCHER_PRODUCTION.md §7): issued / used / remaining / void and the ₪ given —
  // "מכסה | מומשו | נותרו" (the glossary). Flat `usage*` keys: `report` has no `usage` object.
  const usage: ExcelSheet[] = u
    ? [{
        name: t('usageSheet'),
        columns: [{ header: t('col.measure'), width: 28 }, { header: u.unit === 'uses' ? t('usageUnitUses') : t('usageUnitUnits'), kind: 'number' }],
        rows: [
          [t('usageIssued'), u.issued],
          [t('usageUsed'), u.used],
          [t('usageRemaining'), u.remaining],
          [u.unit === 'uses' ? t('usageVoidUses') : t('usageVoid'), u.void],
          ...(u.unit === 'uses' ? [[t('usageHeld'), u.held], [t('usageFlagged'), u.flagged]] as (string | number)[][] : []),
        ],
      }, ...(u.benefit != null ? [{
        name: t('usageBenefit'),
        columns: [{ header: t('col.measure'), width: 28 }, { header: t('usageAmount'), kind: 'money' as const }],
        rows: [[t('usageBenefit'), u.benefit]],
      }] : [])]
    : [];
  return [
    ...usage,
    {
      name: t('sheet.summary'),
      columns: [{ header: t('col.measure'), width: 28 }, { header: t('col.count'), kind: 'number' }],
      rows: [
        [t('vouchers.total'), v.total],
        [t('vouchers.active'), v.active],
        [t('vouchers.partiallyUsed'), v.partiallyUsed],
        [t('vouchers.used'), v.used],
        [t('vouchers.cancelled'), v.cancelled],
        [t('col.redemptions'), r.totals.redemptions],
        [units, r.totals.units],
      ],
    },
  ];
}

export function PrepaidBatchReportView({ batch }: { batch: PrepaidVoucherBatch }) {
  const t = useTranslations('prepaidVouchers.report');
  const scope = useReportExportScope();
  const q = useQuery({
    queryKey: ['prepaid-voucher-report', batch.id],
    queryFn: () => fetchPrepaidBatchReport(batch.id),
  });
  // A discount batch's "units" are its uses (the server's batch report).
  const discount = isDiscountKind(batch.kind);
  const labels = {
    unknownTill: t('unknownTill'),
    unknownShop: t('unknownShop'),
    unknownEmployee: t('unknownEmployee'),
    units: discount ? t('col.uses') : t('col.units'),
  };

  if (q.isPending) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-20 w-full rounded-xl" />
        <Skeleton className="h-40 w-full rounded-xl" />
      </div>
    );
  }
  if (q.isError || !q.data) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
        <span>{axiosErrorToToastMessage(q.error, t('loadError'))}</span>
        <Button variant="outline" size="sm" onClick={() => void q.refetch()}>{t('retry')}</Button>
      </div>
    );
  }

  const r = q.data;
  const title = t('title', { name: batch.eventName || batch.name });
  const maxHour = Math.max(1, ...r.byHour.map((h) => h.units));
  const counts = (units: string): ReportColumn<{ redemptions: number; vouchers: number; units: number }>[] => [
    { key: 'redemptions', header: t('col.redemptions'), kind: 'number', value: (x) => x.redemptions },
    { key: 'vouchers', header: t('col.vouchers'), kind: 'number', value: (x) => x.vouchers },
    { key: 'units', header: units, kind: 'number', value: (x) => x.units },
  ];

  const products: ReportTableSpec<PrepaidReportProduct> = {
    id: 'main',
    title: t('productsTitle'),
    rows: r.products,
    rowKey: (p) => p.productId,
    columns: [
      { key: 'product', header: t('col.product'), required: true, width: 28, value: productName },
      { key: 'perVoucher', header: t('col.perVoucher'), kind: 'number', value: (p) => p.perVoucher },
      { key: 'issued', header: t('col.issued'), kind: 'number', value: (p) => p.issued },
      { key: 'taken', header: t('col.taken'), kind: 'number', className: 'font-semibold', value: (p) => p.taken },
      { key: 'forfeited', header: t('col.forfeited'), kind: 'number', value: (p) => p.forfeited },
      { key: 'outstanding', header: t('col.outstanding'), kind: 'number', value: (p) => p.outstanding },
      { key: 'void', header: t('col.void'), kind: 'number', value: (p) => p.void },
    ],
  };
  const [redemptionsCol, vouchersCol, unitsCol] = counts(labels.units);
  const days: ReportTableSpec<Day> = {
    id: 'days',
    title: t('byDay'),
    rows: r.byDay,
    rowKey: (d) => d.date,
    totalsLabel: t('total'),
    emptyText: t('noRedemptions'),
    columns: [
      { key: 'date', header: t('col.date'), kind: 'date', required: true, value: (d) => d.date },
      { ...redemptionsCol, total: r.totals.redemptions },
      { ...vouchersCol, total: r.totals.vouchers },
      // On screen the goods' columns say it; the sheet has the units too.
      { ...unitsCol, exportOnly: true, total: r.totals.units },
      ...r.products.map(
        (p): ReportColumn<Day> => ({
          key: `p:${p.productId}`,
          header: p.name ?? '',
          kind: 'number',
          value: (d) => d.products.find((x) => x.productId === p.productId)?.quantity ?? 0,
          total: p.taken,
        }),
      ),
    ],
  };
  // The bars on screen; a table in the export.
  const hours: ReportTableSpec<Hour> = {
    id: 'hours',
    title: t('byHour'),
    rows: r.byHour,
    rowKey: (h) => String(h.hour),
    columns: [{ key: 'hour', header: t('col.hour'), required: true, value: (h) => formatHour(h.hour) }, ...counts(labels.units)],
  };
  const shops = groupTable(t, 'shops', t('byShop'), r.byShop, t('col.shop'), labels.units, labels.unknownShop);
  const tills = groupTable(t, 'tills', t('byTill'), r.byTill, t('col.till'), labels.units, labels.unknownTill, true);
  const employees = groupTable(t, 'employees', t('byEmployee'), r.byEmployee, t('col.employee'), labels.units, labels.unknownEmployee);
  // The designed PDF (P:\specs\reports-designed-pdf.md §7): the vouchers by state and the
  // redemptions as its cards, the goods as its table, the hours' bars as its chart.
  const exportKpis: ReportKpi[] = [
    { key: 'vouchers', label: t('vouchers.total'), value: r.vouchers.total, kind: 'count', icon: 'voucher' },
    { key: 'active', label: t('vouchers.active'), value: r.vouchers.active, kind: 'count', icon: 'gift' },
    { key: 'partiallyUsed', label: t('vouchers.partiallyUsed'), value: r.vouchers.partiallyUsed, kind: 'count', icon: 'chart' },
    { key: 'used', label: t('vouchers.used'), value: r.vouchers.used, kind: 'count', icon: 'star' },
    { key: 'cancelled', label: t('vouchers.cancelled'), value: r.vouchers.cancelled, kind: 'count', icon: 'void' },
    { key: 'redemptions', label: t('col.redemptions'), value: r.totals.redemptions, kind: 'count', icon: 'receipt' },
  ];
  const exportChart: ReportChart | null = r.byHour.length
    ? {
        type: 'bar',
        title: t('byHour'),
        labels: r.byHour.map((h) => formatHour(h.hour)),
        series: [{ name: labels.units, values: r.byHour.map((h) => h.units) }],
        kind: 'number',
      }
    : null;

  return (
    <div className="space-y-4">
      {r.isTest ? (
        <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          {t('testBatch')}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-2 print:hidden">
        <p className="text-xs text-muted-foreground">{t('reversedNote')}</p>
        <Button variant="ghost" size="sm" onClick={() => void q.refetch()} disabled={q.isFetching}>
          <RefreshCw className={`h-4 w-4 ${q.isFetching ? 'animate-spin' : ''}`} aria-hidden />
          {t('refresh')}
        </Button>
      </div>
      <ReportExportBar
        reportKey={REPORT_KEY}
        title={title}
        tables={[products, days, hours, shops, tills, employees] as ReportTableSpec<unknown>[]}
        extraSheets={() => summarySheets(r, t, labels.units)}
        extraSheetsFirst
        business={batch.companyName ?? scope.business}
        place={batch.shops.length ? batch.shops.map((s) => s.name).join(', ') : batch.companyName ?? ''}
        filterLines={[]}
        companyId={batch.companyId || scope.companyId}
        companyName={batch.companyName ?? scope.companyName}
        reportType="prepaid-vouchers.batch"
        kpis={exportKpis}
        chart={exportChart}
        insightKeys={{ label: 'product', value: 'taken' }}
      />

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <Counts label={t('vouchers.total')} value={r.vouchers.total} />
        <Counts label={t('vouchers.active')} value={r.vouchers.active} />
        <Counts label={t('vouchers.partiallyUsed')} value={r.vouchers.partiallyUsed} tone="text-amber-700 dark:text-amber-300" />
        <Counts label={t('vouchers.used')} value={r.vouchers.used} tone="text-emerald-700 dark:text-emerald-300" />
        <Counts label={t('vouchers.cancelled')} value={r.vouchers.cancelled} tone="text-destructive" />
      </div>

      {r.usage ? (
        <Card className="break-inside-avoid">
          <CardHeader>
            <CardTitle className="text-base">
              {t('usageTitle')} · {r.usage.unit === 'uses' ? t('usageUnitUses') : t('usageUnitUnits')}
            </CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            <Counts label={t('usageIssued')} value={r.usage.issued} />
            <Counts label={t('usageUsed')} value={r.usage.used} tone="text-emerald-700 dark:text-emerald-300" />
            <Counts label={t('usageRemaining')} value={r.usage.remaining} />
            <Counts label={r.usage.unit === 'uses' ? t('usageVoidUses') : t('usageVoid')} value={r.usage.void} tone="text-destructive" />
            {r.usage.benefit != null ? (
              <div className="rounded-lg border px-3 py-2">
                <p className="text-xs text-muted-foreground">{t('usageBenefit')}</p>
                <p className="text-xl font-semibold tabular-nums">₪{r.usage.benefit.toFixed(2)}</p>
              </div>
            ) : null}
            {r.usage.unit === 'uses' && (r.usage.held || r.usage.flagged) ? (
              <p className="col-span-full text-xs text-muted-foreground">
                {t('usageHeld')}: {r.usage.held} · {t('usageFlagged')}: {r.usage.flagged}
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <ReportTable table={products} reportKey={REPORT_KEY} className="break-inside-avoid" />

      <div className="grid gap-4 lg:grid-cols-2">
        <ReportTable table={days} reportKey={REPORT_KEY} className="break-inside-avoid" />

        <Card className="break-inside-avoid">
          <CardHeader>
            <CardTitle className="text-base">{t('byHour')}</CardTitle>
          </CardHeader>
          <CardContent>
            {r.byHour.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('noRedemptions')}</p>
            ) : (
              <ul className="space-y-1">
                {r.byHour.map((h) => (
                  <li key={h.hour} className="flex items-center gap-2 text-sm">
                    <span className="w-12 shrink-0 tabular-nums" dir="ltr">{formatHour(h.hour)}</span>
                    <div className="h-3 flex-1 overflow-hidden rounded bg-muted">
                      <div className="h-full rounded bg-primary/70" style={{ width: `${(h.units / maxHour) * 100}%` }} />
                    </div>
                    <span className="w-36 shrink-0 text-end text-xs tabular-nums text-muted-foreground">
                      {t(discount ? 'hourLineUses' : 'hourLine', { units: h.units, redemptions: h.redemptions })}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <ReportTable table={shops} reportKey={REPORT_KEY} className="break-inside-avoid" />
        <ReportTable table={tills} reportKey={REPORT_KEY} className="break-inside-avoid" />
        <ReportTable table={employees} reportKey={REPORT_KEY} className="break-inside-avoid" />
      </div>
    </div>
  );
}
