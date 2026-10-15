'use client';

/**
 * "דוחות" (the production vouchers spec §15) under the page's filters (lib/prepaidVoucherFilters.ts,
 * as "מימושים לפי קופה" reads them): the settlement report (the active agreements and the batches no
 * agreement covers — only with the settlement section), the exceptions in one list (redemption flags,
 * after validity, reversed, cancelled, replaced, forced discounts), the forced discounts ("כפיות"),
 * and the catalog / eligibility of every batch.
 *
 * On the report framework (P:\specs\reports-upgrade.md §5): each report's tables are `ReportTable`s
 * (sort, columns, phone cards, totals) and each has the framework's export bar
 * (`prepaid-vouchers-reports.<report>`): Excel, PDF, print, export columns, with the vouchers'
 * filters — and the report's own (a kind of exception, "רק פריטים חסומים") — in words in the header.
 * The designed PDF's cards are each report's tiles (the exceptions: how many, by kind as a chart).
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { canAccess } from '@/lib/dashboardAccess';
import { useDashboardAccess } from '@/lib/dashboardAccessApi';
import { filtersToQuery, type VoucherFilters } from '@/lib/prepaidVoucherFilters';
import { kindsByCount, shekelsOf } from '@/lib/prepaidVoucherExtras';
import {
  fetchCatalogReport,
  fetchExceptionsReport,
  fetchOverridesReport,
  fetchSettlementReport,
  type CatalogRow,
  type ExceptionRow,
  type OverrideRow,
  type SettlementAgreementSummary,
  type SettlementReport,
} from '@/lib/prepaidVoucherExtrasApi';
import type { ReportFilterLine } from '@/lib/reportExport';
import { DEFAULT_WEIGHT_UNIT } from '@/lib/prepaidVoucherProducts';
import { Segmented } from '@/components/dashboard/insights/ios';
import {
  ReportExportBar,
  ReportTable,
  useReportExportScope,
  type ReportChart,
  type ReportExportBarProps,
  type ReportKpi,
  type ReportTableSpec,
} from '@/components/dashboard/report-framework';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { useVoucherFilterLines } from '../voucher-filters';
import { StatTile, Tag, money, useExtrasErrorText } from './extras-common';

type ReportKind = 'settlement' | 'exceptions' | 'overrides' | 'catalog';

/** `prepaid-vouchers-reports.settlement`, …: each report's own columns and company default. */
const reportKeyOf = (kind: ReportKind) => `prepaid-vouchers-reports.${kind}`;

export function ExtraReports({ filters }: { filters: VoucherFilters }) {
  const t = useTranslations('prepaidVouchers.extraReports');
  const access = useDashboardAccess();
  const settlementOk = canAccess(access, 'prepaid_voucher_settlement', 'view');
  const kinds: ReportKind[] = settlementOk ? ['settlement', 'exceptions', 'overrides', 'catalog'] : ['exceptions', 'overrides', 'catalog'];
  const [picked, setPicked] = useState<ReportKind>(kinds[0]);
  const kind = kinds.includes(picked) ? picked : kinds[0];
  return (
    <div className="space-y-3">
      <Segmented value={kind} onChange={setPicked} className="w-full max-w-xl print:hidden" label={t('label')}
        options={kinds.map((k) => ({ id: k, label: t(`kinds.${k}`) }))} />
      {kind === 'settlement' ? <SettlementReportView filters={filters} />
        : kind === 'exceptions' ? <ExceptionsReportView filters={filters} />
          : kind === 'overrides' ? <OverridesReportView filters={filters} />
            : <CatalogReportView filters={filters} />}
    </div>
  );
}

function useReportQuery<T>(name: string, filters: VoucherFilters, fn: (q: URLSearchParams) => Promise<T>) {
  const query = filtersToQuery(filters);
  return useQuery({ queryKey: ['prepaid-extra-report', name, query.toString()], queryFn: () => fn(query) });
}

function Loading() {
  return <Skeleton className="h-48 w-full rounded-xl" />;
}

/**
 * The framework's export bar for one of these reports: the vouchers' filters in words (and the
 * report's own [extraLines]); the redemption days as the range, unless [withRange] is false.
 * The designed PDF (P:\specs\reports-designed-pdf.md §7): the report's tiles as its cards
 * ([kpis]), and its [chart] or [chartFrom] the main table.
 */
function ExportBar({ kind, filters, tables, extraLines = [], withRange = true, disabled, kpis, chart, chartFrom, insightKeys }: {
  kind: ReportKind;
  filters: VoucherFilters;
  tables: ReportTableSpec<unknown>[];
  extraLines?: ReportFilterLine[];
  withRange?: boolean;
  disabled?: boolean;
} & Pick<ReportExportBarProps, 'kpis' | 'chart' | 'chartFrom' | 'insightKeys'>) {
  const t = useTranslations('prepaidVouchers.extraReports');
  const scope = useReportExportScope();
  const lines = useVoucherFilterLines(filters, withRange ? ['from', 'to'] : []);
  return (
    <ReportExportBar
      reportKey={reportKeyOf(kind)}
      title={t(`kinds.${kind}`)}
      tables={tables}
      from={withRange ? filters.from || null : null}
      to={withRange ? filters.to || null : null}
      business={scope.business}
      place={scope.place}
      filterLines={[...lines, ...extraLines]}
      companyId={scope.companyId}
      companyName={scope.companyName}
      disabled={disabled}
      reportType="prepaid-vouchers.extras"
      kpis={kpis}
      chart={chart}
      chartFrom={chartFrom}
      insightKeys={insightKeys}
    />
  );
}

// ── Settlement ───────────────────────────────────────────────────────────────

type UnassignedBatch = SettlementReport['unassigned'][number];

function SettlementReportView({ filters }: { filters: VoucherFilters }) {
  const t = useTranslations('prepaidVouchers.extraReports');
  const ts = useTranslations('prepaidVouchers.settlement');
  const errorText = useExtrasErrorText();
  const r = useReportQuery('settlement', filters, fetchSettlementReport);
  const scope = (a: { productionName: string | null; eventName: string | null; batchIds: string[] | null }) =>
    [a.productionName, a.eventName, a.batchIds?.length ? ts('scopeBatches', { n: a.batchIds.length }) : null].filter(Boolean).join(' · ');
  const d = r.data;

  const agreements: ReportTableSpec<SettlementAgreementSummary> = {
    id: 'main',
    title: t('settlement.agreements'),
    sheetHeading: [t('settlement.note')],
    rows: d?.items ?? [],
    rowKey: (a) => a.id,
    totalsLabel: ts('total'),
    emptyText: t('settlement.noAgreements'),
    columns: [
      { key: 'name', header: ts('form.name'), required: true, width: 30, className: 'font-medium', value: (a) => a.name },
      { key: 'scope', header: t('settlement.scope'), width: 30, className: 'whitespace-normal text-muted-foreground', value: (a) => scope(a) },
      { key: 'basis', header: ts('form.basis'), value: (a) => ts(`basis.${a.billingBasis}`) },
      { key: 'chargeable', header: ts('chargeable'), kind: 'number', value: (a) => a.totals.chargeable, total: d?.totals.chargeable },
      { key: 'amount', header: ts('amount'), kind: 'money', value: (a) => shekelsOf(a.totals.amountAgorot), total: shekelsOf(d?.totals.amountAgorot) },
      {
        key: 'invoices',
        header: ts('gap.invoices'),
        kind: 'money',
        value: (a) => shekelsOf(a.totals.invoicesAmountAgorot),
        total: shekelsOf(d?.totals.invoicesAmountAgorot),
      },
      { key: 'uninvoiced', header: ts('uninvoiced'), kind: 'number', value: (a) => a.totals.uninvoiced, total: d?.totals.uninvoiced },
      {
        key: 'uninvoicedAmount',
        header: t('settlement.uninvoicedAmount'),
        kind: 'money',
        exportOnly: true,
        value: (a) => shekelsOf(a.totals.uninvoicedAmountAgorot),
        total: shekelsOf(d?.totals.uninvoicedAmountAgorot),
      },
      { key: 'gap', header: ts('gap.gap'), kind: 'money', value: (a) => shekelsOf(a.totals.gapAgorot) },
      {
        key: 'tillValue',
        header: ts('tillValueShort'),
        kind: 'money',
        className: 'border-s bg-muted/30 text-muted-foreground',
        headClassName: 'border-s',
        value: (a) => shekelsOf(a.totals.tillValueAgorot),
      },
    ],
  };
  const unassigned: ReportTableSpec<UnassignedBatch> = {
    id: 'unassigned',
    title: t('settlement.unassigned'),
    rows: d?.unassigned ?? [],
    rowKey: (b) => b.batchId,
    emptyText: t('settlement.noUnassigned'),
    columns: [
      { key: 'batch', header: ts('batch'), required: true, width: 28, className: 'font-medium', value: (b) => b.name },
      { key: 'type', header: ts('type'), width: 20, value: (b) => b.typeName ?? '' },
      { key: 'production', header: ts('production'), width: 20, value: (b) => b.productionName ?? '' },
      { key: 'event', header: ts('event'), width: 20, value: (b) => b.eventName ?? '' },
      { key: 'issued', header: ts('issued'), kind: 'number', value: (b) => b.issued },
      { key: 'used', header: t('settlement.used'), kind: 'number', value: (b) => b.used },
      { key: 'productionPrice', header: ts('productionPrice'), kind: 'money', value: (b) => shekelsOf(b.productionPriceAgorot) },
    ],
  };
  // The tiles above the tables.
  const kpis: ReportKpi[] = d
    ? [
        { key: 'chargeable', label: ts('chargeable'), value: d.totals.chargeable, kind: 'count', icon: 'voucher' },
        { key: 'amount', label: ts('amount'), value: shekelsOf(d.totals.amountAgorot), kind: 'money', icon: 'sales' },
        { key: 'invoices', label: ts('gap.invoices'), value: shekelsOf(d.totals.invoicesAmountAgorot), kind: 'money', icon: 'receipt' },
        { key: 'uninvoiced', label: ts('uninvoiced'), value: d.totals.uninvoiced, kind: 'count', icon: 'alert', better: 'down' },
      ]
    : [];

  return (
    <div className="space-y-3">
      <ExportBar kind="settlement" filters={filters} tables={[agreements, unassigned] as ReportTableSpec<unknown>[]} disabled={!d}
        kpis={kpis} chartFrom={{ label: 'name', value: 'amount', type: 'hbar' }} insightKeys={{ label: 'name', value: 'amount', count: 'chargeable' }} />
      {r.isPending ? <Loading /> : r.isError ? <p className="text-sm text-destructive">{errorText(r.error)}</p> : (
        <>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile label={ts('chargeable')} value={r.data.totals.chargeable} />
            <StatTile label={ts('amount')} value={money(r.data.totals.amountAgorot)} hint={r.data.pricesVisible ? null : ts('pricesHidden')} />
            <StatTile label={ts('gap.invoices')} value={money(r.data.totals.invoicesAmountAgorot)} />
            <StatTile label={ts('uninvoiced')} value={r.data.totals.uninvoiced} hint={money(r.data.totals.uninvoicedAmountAgorot)}
              tone={r.data.totals.uninvoiced ? 'warn' : 'good'} />
          </div>
          <ReportTable table={agreements} reportKey={reportKeyOf('settlement')} />
          <p className="text-xs text-muted-foreground">{t('settlement.note')}</p>
          <ReportTable table={unassigned} reportKey={reportKeyOf('settlement')} />
          <p className="text-xs text-muted-foreground">{t('settlement.unassignedNote')}</p>
        </>
      )}
    </div>
  );
}

// ── Exceptions ───────────────────────────────────────────────────────────────

function exceptionDetails(r: ExceptionRow, t: (key: string, values?: Record<string, string | number>) => string): string {
  return [
    r.replacementSerial ? t('exceptions.replacedBy', { serial: r.replacementSerial }) : null,
    r.count ? t('exceptions.countN', { n: r.count }) : null,
    r.groupNo ? t('exceptions.groupN', { n: r.groupNo }) : null,
    r.productName ?? null,
    r.reductionAgorot ? money(r.reductionAgorot) : null,
    r.approvedBy ? t('exceptions.approvedBy', { name: r.approvedBy }) : null,
    r.reason ?? null,
    r.userName ?? null,
  ].filter(Boolean).join(' · ');
}

function ExceptionsReportView({ filters }: { filters: VoucherFilters }) {
  const t = useTranslations('prepaidVouchers.extraReports');
  const errorText = useExtrasErrorText();
  const [only, setOnly] = useState<string | null>(null);
  const r = useReportQuery('exceptions', filters, fetchExceptionsReport);
  const all = r.data?.items ?? [];
  const rows = only ? all.filter((x) => x.kind === only) : all;
  const chips = kindsByCount(r.data?.counts ?? {});
  const kindText = (k: string) => r.data?.kinds[k] ?? k;

  const table: ReportTableSpec<ExceptionRow> = {
    id: 'main',
    title: t('kinds.exceptions'),
    rows,
    rowKey: (x, i) => `${x.kind}-${x.redemptionId ?? x.voucherId ?? x.batchId}-${i}`,
    emptyText: t('exceptions.empty'),
    columns: [
      { key: 'at', header: t('exceptions.at'), kind: 'datetime', required: true, className: 'tabular-nums', value: (x) => x.at },
      {
        key: 'kind',
        header: t('exceptions.kind'),
        width: 26,
        value: (x) => x.kindText,
        cell: (x) => (
          <>
            {x.kindText}
            {x.test ? <> <Tag tone="warn">{t('exceptions.testYes')}</Tag></> : null}
          </>
        ),
      },
      {
        key: 'batch',
        header: t('exceptions.batch'),
        width: 26,
        value: (x) => x.batchName ?? '',
        cell: (x) => (
          <>
            {x.batchName ?? ''}
            {x.typeName ? <span className="block text-xs text-muted-foreground">{x.typeName}</span> : null}
          </>
        ),
      },
      { key: 'type', header: t('exceptions.type'), width: 18, exportOnly: true, value: (x) => x.typeName ?? '' },
      { key: 'voucher', header: t('exceptions.voucher'), className: 'tabular-nums', value: (x) => (x.serial ? `#${x.serial}` : '') },
      { key: 'till', header: t('exceptions.till'), width: 16, value: (x) => x.machineName ?? '' },
      { key: 'employee', header: t('exceptions.employee'), width: 16, value: (x) => x.employeeName ?? '' },
      {
        key: 'details',
        header: t('exceptions.details'),
        width: 40,
        className: 'min-w-48 whitespace-normal text-xs text-muted-foreground',
        value: (x) => exceptionDetails(x, t),
      },
      { key: 'test', header: t('exceptions.test'), exportOnly: true, value: (x) => (x.test ? t('exceptions.testYes') : '') },
    ],
  };

  // How many, and by kind as the chips count them.
  const shownCount = only ? (r.data?.counts[only] ?? rows.length) : (r.data?.total ?? rows.length);
  const kpis: ReportKpi[] = r.data ? [{ key: 'exceptions', label: t('kinds.exceptions'), value: shownCount, kind: 'count', icon: 'alert', better: 'down' }] : [];
  const byKind = only ? chips.filter((c) => c.kind === only) : chips;
  const chart: ReportChart | null = byKind.length
    ? {
        type: 'hbar',
        title: t('exceptions.kind'),
        labels: byKind.map((c) => kindText(c.kind)),
        series: [{ name: t('kinds.exceptions'), values: byKind.map((c) => c.count) }],
        kind: 'number',
      }
    : null;

  return (
    <div className="space-y-3">
      <ExportBar kind="exceptions" filters={filters} tables={[table] as ReportTableSpec<unknown>[]} disabled={!rows.length}
        extraLines={only ? [{ label: t('exceptions.kind'), value: kindText(only) }] : []}
        kpis={kpis} chart={chart} insightKeys={{ label: 'kind', employee: 'employee' }} />
      {r.isPending ? <Loading /> : r.isError ? <p className="text-sm text-destructive">{errorText(r.error)}</p> : (
        <>
          <div className="flex flex-wrap gap-1.5 print:hidden">
            <button type="button" onClick={() => setOnly(null)}
              className={cn('rounded-full border px-3 py-1 text-xs', !only ? 'border-primary bg-primary/10 text-primary' : 'hover:bg-muted')}>
              {t('exceptions.all', { n: r.data.total })}
            </button>
            {chips.map((c) => (
              <button key={c.kind} type="button" onClick={() => setOnly(only === c.kind ? null : c.kind)}
                className={cn('rounded-full border px-3 py-1 text-xs', only === c.kind ? 'border-primary bg-primary/10 text-primary' : 'hover:bg-muted')}>
                {kindText(c.kind)} <span className="tabular-nums font-semibold">{c.count}</span>
              </button>
            ))}
          </div>
          {r.data.overridesRecorded === false ? <p className="text-xs text-muted-foreground">{t('exceptions.overridesNotRecorded')}</p> : null}
          {r.data.total > all.length ? <p className="text-xs text-muted-foreground">{t('exceptions.capped', { shown: all.length, total: r.data.total })}</p> : null}
          <ReportTable table={table} reportKey={reportKeyOf('exceptions')} />
        </>
      )}
    </div>
  );
}

// ── Overrides ("כפיות") ───────────────────────────────────────────────────────

function OverridesReportView({ filters }: { filters: VoucherFilters }) {
  const t = useTranslations('prepaidVouchers.extraReports');
  const errorText = useExtrasErrorText();
  const r = useReportQuery('overrides', filters, fetchOverridesReport);
  const rows = r.data?.items ?? [];
  const policyText = (p: string | null) => (p && t.has(`policy.${p}`) ? t(`policy.${p}`) : p ?? '');

  const table: ReportTableSpec<OverrideRow> = {
    id: 'main',
    title: t('kinds.overrides'),
    rows,
    rowKey: (x, i) => `${x.transactionId ?? ''}-${x.productId ?? ''}-${i}`,
    emptyText: t('overrides.empty'),
    columns: [
      { key: 'at', header: t('exceptions.at'), kind: 'datetime', required: true, className: 'tabular-nums', value: (x) => x.at },
      {
        key: 'batch',
        header: t('exceptions.batch'),
        width: 24,
        value: (x) => x.batchName ?? '',
        cell: (x) => (
          <>
            {x.batchName ?? ''}
            {x.typeName ? <span className="block text-xs text-muted-foreground">{x.typeName}</span> : null}
          </>
        ),
      },
      { key: 'type', header: t('exceptions.type'), width: 18, exportOnly: true, value: (x) => x.typeName ?? '' },
      {
        key: 'product',
        header: t('overrides.product'),
        width: 22,
        value: (x) => x.productName ?? '',
        cell: (x) => (
          <>
            {x.productName ?? ''}
            {x.categoryName ? <span className="block text-xs text-muted-foreground">{x.categoryName}</span> : null}
          </>
        ),
      },
      { key: 'category', header: t('overrides.category'), width: 16, exportOnly: true, value: (x) => x.categoryName ?? '' },
      { key: 'listPrice', header: t('overrides.listPrice'), kind: 'money', value: (x) => shekelsOf(x.listPriceAgorot) },
      { key: 'value', header: t('overrides.value'), kind: 'money', value: (x) => shekelsOf(x.valueAgorot) },
      { key: 'reduction', header: t('overrides.reduction'), kind: 'money', value: (x) => shekelsOf(x.reductionAgorot) },
      { key: 'policy', header: t('overrides.policy'), value: (x) => policyText(x.policy) },
      { key: 'approvedBy', header: t('overrides.approvedBy'), value: (x) => x.approvedBy ?? '' },
      { key: 'employee', header: t('exceptions.employee'), value: (x) => x.employeeName ?? '' },
      { key: 'till', header: t('exceptions.till'), exportOnly: true, value: (x) => x.machineName ?? '' },
    ],
  };

  // The tiles above the table (once the overrides are recorded).
  const totals = r.data?.recorded ? r.data.totals : null;
  const kpis: ReportKpi[] = totals
    ? [
        { key: 'units', label: t('overrides.units'), value: totals.units ?? rows.length, kind: 'count', icon: 'items' },
        { key: 'reduction', label: t('overrides.reduction'), value: shekelsOf(totals.reductionAgorot ?? null), kind: 'money', icon: 'discount' },
        { key: 'preset', label: t('overrides.preset'), value: totals.preset ?? 0, kind: 'count', icon: 'gift' },
        { key: 'approved', label: t('overrides.approved'), value: totals.approved ?? 0, kind: 'count', icon: 'user' },
      ]
    : [];

  return (
    <div className="space-y-3">
      <ExportBar kind="overrides" filters={filters} tables={[table] as ReportTableSpec<unknown>[]} disabled={!rows.length}
        kpis={kpis} insightKeys={{ label: 'product', value: 'reduction', employee: 'employee' }} />
      {r.isPending ? <Loading /> : r.isError ? <p className="text-sm text-destructive">{errorText(r.error)}</p> : !r.data.recorded ? (
        <div className="rounded-xl border border-dashed p-6 text-center">
          <p className="text-sm font-medium">{t('overrides.notRecorded')}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t('overrides.notRecordedHint')}</p>
        </div>
      ) : (
        <>
          <div className="grid gap-2 sm:grid-cols-4">
            <StatTile label={t('overrides.units')} value={r.data.totals.units ?? rows.length} />
            <StatTile label={t('overrides.reduction')} value={money(r.data.totals.reductionAgorot ?? null)} />
            <StatTile label={t('overrides.preset')} value={r.data.totals.preset ?? 0} />
            <StatTile label={t('overrides.approved')} value={r.data.totals.approved ?? 0} />
          </div>
          <ReportTable table={table} reportKey={reportKeyOf('overrides')} />
        </>
      )}
    </div>
  );
}

// ── Catalog / eligibility ────────────────────────────────────────────────────

function CatalogReportView({ filters }: { filters: VoucherFilters }) {
  const t = useTranslations('prepaidVouchers.extraReports');
  const te = useTranslations('prepaidVouchers.eligibility');
  const errorText = useExtrasErrorText();
  const [blockedOnly, setBlockedOnly] = useState(false);
  const r = useReportQuery('catalog', filters, fetchCatalogReport);
  const all = r.data?.rows ?? [];
  const rows = blockedOnly ? all.filter((x) => !x.usable) : all;

  const blockText = (x: CatalogRow) => {
    if (x.usable) return t('catalog.usable');
    const b = x.blockReason ?? '';
    if (b === 'missing') return t('catalog.missing');
    if (b && te.has(`blocked.${b}`)) return te(`blocked.${b}`);
    return b || t('catalog.blocked');
  };
  const notesText = (x: CatalogRow) =>
    (x.notes ?? []).map((n) => {
      const key = n === 'till_made' ? 'till_made_plain' : n;
      return te.has(`notes.${key}`) ? te(`notes.${key}`, { unit: DEFAULT_WEIGHT_UNIT, shop: '' }) : String(n);
    }).join(' · ');
  const name = (x: CatalogRow) => (x.role === 'target_category' ? x.categoryName ?? '' : x.productName ?? x.nameNow ?? '');
  const roleText = (x: CatalogRow) => (t.has(`catalog.role.${x.role}`) ? t(`catalog.role.${x.role}`) : x.role);
  const modeText = (m: string) => (t.has(`catalog.mode.${m}`) ? t(`catalog.mode.${m}`) : m);
  const policyText = (p: string | null) => (p && t.has(`policy.${p}`) ? t(`policy.${p}`) : p ?? '');

  const table: ReportTableSpec<CatalogRow> = {
    id: 'main',
    title: t('kinds.catalog'),
    rows,
    rowKey: (x, i) => `${x.batchId}-${x.productId ?? x.categoryId ?? ''}-${i}`,
    emptyText: t('catalog.empty'),
    columns: [
      {
        key: 'batch',
        header: t('exceptions.batch'),
        required: true,
        width: 26,
        className: 'whitespace-normal',
        value: (x) => x.batchName,
        cell: (x) => (
          <>
            {x.batchName}
            <span className="block text-xs text-muted-foreground">{[x.typeName, modeText(x.catalogMode)].filter(Boolean).join(' · ')}</span>
          </>
        ),
      },
      { key: 'type', header: t('exceptions.type'), width: 18, exportOnly: true, value: (x) => x.typeName ?? '' },
      { key: 'mode', header: t('catalog.mode.label'), width: 18, exportOnly: true, value: (x) => modeText(x.catalogMode) },
      { key: 'role', header: t('catalog.roleLabel'), width: 18, className: 'text-xs', value: (x) => roleText(x) },
      {
        key: 'name',
        header: t('catalog.name'),
        width: 24,
        className: 'whitespace-normal',
        value: (x) => name(x),
        cell: (x) => (
          <>
            {name(x)}
            {x.role !== 'target_category' && x.categoryName ? <span className="block text-xs text-muted-foreground">{x.categoryName}</span> : null}
            {x.nameNow && x.productName && x.nameNow !== x.productName
              ? <span className="block text-xs text-muted-foreground">{t('catalog.nameNow', { name: x.nameNow })}</span> : null}
          </>
        ),
      },
      {
        key: 'category',
        header: t('catalog.category'),
        width: 16,
        exportOnly: true,
        value: (x) => (x.role === 'target_category' ? '' : x.categoryName ?? ''),
      },
      { key: 'quantity', header: t('catalog.quantity'), kind: 'number', value: (x) => x.quantity ?? null, cell: (x) => x.quantity ?? '' },
      { key: 'priceNow', header: t('catalog.priceNow'), kind: 'money', value: (x) => x.priceNow ?? null, cell: (x) => (x.priceNow != null ? `₪${x.priceNow.toFixed(2)}` : '') },
      { key: 'noDiscount', header: t('catalog.noDiscount'), exportOnly: true, value: (x) => (x.noDiscount ? t('catalog.yes') : '') },
      {
        key: 'status',
        header: t('catalog.status'),
        width: 30,
        value: (x) => blockText(x),
        cell: (x) => (
          <>
            <Tag tone={x.usable ? 'good' : 'bad'}>{blockText(x)}</Tag>
            {x.noDiscount ? <span className="block text-xs text-muted-foreground">{t('catalog.noDiscount')}{x.overrideApplies ? ` · ${t('catalog.overrideApplies')}` : ''}</span> : null}
          </>
        ),
      },
      {
        key: 'notes',
        header: t('catalog.notes'),
        width: 40,
        className: 'min-w-48 whitespace-normal text-xs text-muted-foreground',
        value: (x) => notesText(x),
      },
      { key: 'policy', header: t('overrides.policy'), exportOnly: true, value: (x) => policyText(x.policyMode) },
    ],
  };
  // The tiles above the table.
  const totals = r.data?.totals;
  const kpis: ReportKpi[] = totals
    ? [
        { key: 'batches', label: t('catalog.batches'), value: totals.batches, kind: 'count', icon: 'voucher' },
        { key: 'entries', label: t('catalog.entries'), value: totals.entries, kind: 'count', icon: 'items' },
        { key: 'blocked', label: t('catalog.blockedN'), value: totals.blocked, kind: 'count', icon: 'void', better: 'down' },
        { key: 'noDiscount', label: t('catalog.noDiscountN'), value: totals.noDiscount, kind: 'count', icon: 'discount' },
      ]
    : [];

  return (
    <div className="space-y-3">
      {/* As before: the catalog is the batches' eligibility now — no redemption range. */}
      <ExportBar kind="catalog" filters={filters} tables={[table] as ReportTableSpec<unknown>[]} disabled={!rows.length} withRange={false}
        extraLines={blockedOnly ? [{ label: t('catalog.status'), value: t('catalog.blockedOnly') }] : []}
        kpis={kpis} insightKeys={{ label: 'name', value: 'quantity' }} />
      {r.isPending ? <Loading /> : r.isError ? <p className="text-sm text-destructive">{errorText(r.error)}</p> : (
        <>
          <div className="grid gap-2 sm:grid-cols-4">
            <StatTile label={t('catalog.batches')} value={r.data.totals.batches} />
            <StatTile label={t('catalog.entries')} value={r.data.totals.entries} />
            <StatTile label={t('catalog.blockedN')} value={r.data.totals.blocked} tone={r.data.totals.blocked ? 'bad' : 'good'} />
            <StatTile label={t('catalog.noDiscountN')} value={r.data.totals.noDiscount} />
          </div>
          <label className="flex items-center gap-2 text-sm print:hidden">
            <input type="checkbox" className="h-4 w-4 accent-primary" checked={blockedOnly} onChange={(e) => setBlockedOnly(e.target.checked)} />
            {t('catalog.blockedOnly')}
          </label>
          <ReportTable table={table} reportKey={reportKeyOf('catalog')} />
        </>
      )}
    </div>
  );
}
