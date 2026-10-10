'use client';

/**
 * "דוחות" (the production vouchers spec §15) under the page's filters (lib/prepaidVoucherFilters.ts,
 * as "מימושים לפי קופה" reads them): the settlement report (the active agreements and the batches no
 * agreement covers — only with the settlement section), the exceptions in one list (redemption flags,
 * after validity, reversed, cancelled, replaced, forced discounts), the forced discounts ("כפיות"),
 * and the catalog / eligibility of every batch. Each has Excel / print / PDF.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import type { ExcelSheet } from '@/lib/excelExport';
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
} from '@/lib/prepaidVoucherExtrasApi';
import { DEFAULT_WEIGHT_UNIT } from '@/lib/prepaidVoucherProducts';
import { Segmented } from '@/components/dashboard/insights/ios';
import { ReportExportToolbar } from '@/components/dashboard/report-export-toolbar';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { Empty, Section, StatTile, TD, TD_END, TH, TH_END, Tag, money, useExtrasErrorText, whenText } from './extras-common';

type ReportKind = 'settlement' | 'exceptions' | 'overrides' | 'catalog';

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

// ── Settlement ───────────────────────────────────────────────────────────────

function SettlementReportView({ filters }: { filters: VoucherFilters }) {
  const t = useTranslations('prepaidVouchers.extraReports');
  const ts = useTranslations('prepaidVouchers.settlement');
  const errorText = useExtrasErrorText();
  const r = useReportQuery('settlement', filters, fetchSettlementReport);
  const scope = (a: { productionName: string | null; eventName: string | null; batchIds: string[] | null }) =>
    [a.productionName, a.eventName, a.batchIds?.length ? ts('scopeBatches', { n: a.batchIds.length }) : null].filter(Boolean).join(' · ');

  const getSheets = (): ExcelSheet[] => {
    const d = r.data!;
    return [
      {
        name: t('settlement.sheetAgreements'),
        heading: [t('settlement.note')],
        columns: [
          { header: ts('form.name'), width: 30 }, { header: t('settlement.scope'), width: 30 }, { header: ts('form.basis') },
          { header: ts('chargeable'), kind: 'number' }, { header: ts('amount'), kind: 'money' },
          { header: ts('gap.invoices'), kind: 'money' }, { header: ts('uninvoiced'), kind: 'number' },
          { header: t('settlement.uninvoicedAmount'), kind: 'money' }, { header: ts('gap.gap'), kind: 'money' },
          { header: ts('tillValueShort'), kind: 'money' },
        ],
        rows: d.items.map((a) => [
          a.name, scope(a), ts(`basis.${a.billingBasis}`), a.totals.chargeable, shekelsOf(a.totals.amountAgorot),
          shekelsOf(a.totals.invoicesAmountAgorot), a.totals.uninvoiced, shekelsOf(a.totals.uninvoicedAmountAgorot),
          shekelsOf(a.totals.gapAgorot), shekelsOf(a.totals.tillValueAgorot),
        ]),
        totals: [ts('total'), '', '', d.totals.chargeable, shekelsOf(d.totals.amountAgorot), shekelsOf(d.totals.invoicesAmountAgorot),
          d.totals.uninvoiced, shekelsOf(d.totals.uninvoicedAmountAgorot), null, null],
      },
      {
        name: t('settlement.sheetUnassigned'),
        columns: [
          { header: ts('batch'), width: 28 }, { header: ts('type'), width: 20 }, { header: ts('production'), width: 20 },
          { header: ts('event'), width: 20 }, { header: ts('issued'), kind: 'number' }, { header: t('settlement.used'), kind: 'number' },
          { header: ts('productionPrice'), kind: 'money' },
        ],
        rows: d.unassigned.map((b) => [b.name, b.typeName ?? '', b.productionName ?? '', b.eventName ?? '', b.issued, b.used, shekelsOf(b.productionPriceAgorot)]),
      },
    ];
  };

  return (
    <div className="space-y-3">
      <ReportExportToolbar title={t('kinds.settlement')} from={filters.from || undefined} to={filters.to || undefined}
        getSheets={getSheets} disabled={!r.data} />
      {r.isPending ? <Loading /> : r.isError ? <p className="text-sm text-destructive">{errorText(r.error)}</p> : (
        <>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile label={ts('chargeable')} value={r.data.totals.chargeable} />
            <StatTile label={ts('amount')} value={money(r.data.totals.amountAgorot)} hint={r.data.pricesVisible ? null : ts('pricesHidden')} />
            <StatTile label={ts('gap.invoices')} value={money(r.data.totals.invoicesAmountAgorot)} />
            <StatTile label={ts('uninvoiced')} value={r.data.totals.uninvoiced} hint={money(r.data.totals.uninvoicedAmountAgorot)}
              tone={r.data.totals.uninvoiced ? 'warn' : 'good'} />
          </div>
          <Section title={t('settlement.agreements')}>
            {r.data.items.length === 0 ? <p className="text-sm text-muted-foreground">{t('settlement.noAgreements')}</p> : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-xs text-muted-foreground">
                    <tr className="border-b">
                      <th className={TH}>{ts('form.name')}</th>
                      <th className={TH}>{t('settlement.scope')}</th>
                      <th className={TH}>{ts('form.basis')}</th>
                      <th className={TH_END}>{ts('chargeable')}</th>
                      <th className={TH_END}>{ts('amount')}</th>
                      <th className={TH_END}>{ts('gap.invoices')}</th>
                      <th className={TH_END}>{ts('uninvoiced')}</th>
                      <th className={TH_END}>{ts('gap.gap')}</th>
                      <th className={cn(TH_END, 'border-s bg-muted/30')}>{ts('tillValueShort')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.data.items.map((a) => (
                      <tr key={a.id} className="border-b last:border-0">
                        <td className={cn(TD, 'font-medium')}>{a.name}</td>
                        <td className={cn(TD, 'text-muted-foreground')}>{scope(a)}</td>
                        <td className={TD}>{ts(`basis.${a.billingBasis}`)}</td>
                        <td className={TD_END}>{a.totals.chargeable}</td>
                        <td className={TD_END}>{money(a.totals.amountAgorot)}</td>
                        <td className={TD_END}>{money(a.totals.invoicesAmountAgorot)}</td>
                        <td className={TD_END}>{a.totals.uninvoiced}</td>
                        <td className={TD_END}>{money(a.totals.gapAgorot)}</td>
                        <td className={cn(TD_END, 'border-s bg-muted/30 text-muted-foreground')}>{money(a.totals.tillValueAgorot)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="text-xs text-muted-foreground">{t('settlement.note')}</p>
          </Section>
          <Section title={t('settlement.unassigned')}>
            {r.data.unassigned.length === 0 ? <p className="text-sm text-muted-foreground">{t('settlement.noUnassigned')}</p> : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-xs text-muted-foreground">
                    <tr className="border-b">
                      <th className={TH}>{ts('batch')}</th>
                      <th className={TH}>{ts('type')}</th>
                      <th className={TH}>{ts('production')}</th>
                      <th className={TH}>{ts('event')}</th>
                      <th className={TH_END}>{ts('issued')}</th>
                      <th className={TH_END}>{t('settlement.used')}</th>
                      <th className={TH_END}>{ts('productionPrice')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.data.unassigned.map((b) => (
                      <tr key={b.batchId} className="border-b last:border-0">
                        <td className={cn(TD, 'font-medium')}>{b.name}</td>
                        <td className={TD}>{b.typeName ?? ''}</td>
                        <td className={TD}>{b.productionName ?? ''}</td>
                        <td className={TD}>{b.eventName ?? ''}</td>
                        <td className={TD_END}>{b.issued}</td>
                        <td className={TD_END}>{b.used}</td>
                        <td className={TD_END}>{money(b.productionPriceAgorot)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="text-xs text-muted-foreground">{t('settlement.unassignedNote')}</p>
          </Section>
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

  const getSheets = (): ExcelSheet => ({
    name: t('kinds.exceptions'),
    heading: only ? [kindText(only)] : undefined,
    columns: [
      { header: t('exceptions.at'), kind: 'datetime' }, { header: t('exceptions.kind'), width: 26 }, { header: t('exceptions.batch'), width: 26 },
      { header: t('exceptions.type'), width: 18 }, { header: t('exceptions.voucher') }, { header: t('exceptions.till'), width: 16 },
      { header: t('exceptions.employee'), width: 16 }, { header: t('exceptions.details'), width: 40 }, { header: t('exceptions.test') },
    ],
    rows: rows.map((x) => [
      x.at, x.kindText, x.batchName ?? '', x.typeName ?? '', x.serial ? `#${x.serial}` : '', x.machineName ?? '', x.employeeName ?? '',
      exceptionDetails(x, t), x.test ? t('exceptions.testYes') : '',
    ]),
  });

  return (
    <div className="space-y-3">
      <ReportExportToolbar title={t('kinds.exceptions')} from={filters.from || undefined} to={filters.to || undefined}
        getSheets={getSheets} disabled={!rows.length} />
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
          {rows.length === 0 ? <Empty>{t('exceptions.empty')}</Empty> : (
            <div className="overflow-x-auto rounded-xl bg-card ring-1 ring-foreground/10">
              <table className="w-full text-sm">
                <thead className="text-xs text-muted-foreground">
                  <tr className="border-b">
                    <th className={TH}>{t('exceptions.at')}</th>
                    <th className={TH}>{t('exceptions.kind')}</th>
                    <th className={TH}>{t('exceptions.batch')}</th>
                    <th className={TH}>{t('exceptions.voucher')}</th>
                    <th className={TH}>{t('exceptions.till')}</th>
                    <th className={TH}>{t('exceptions.employee')}</th>
                    <th className={TH}>{t('exceptions.details')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((x, i) => (
                    <tr key={`${x.kind}-${x.redemptionId ?? x.voucherId ?? x.batchId}-${i}`} className="border-b align-top last:border-0">
                      <td className={cn(TD, 'whitespace-nowrap tabular-nums')}>{whenText(x.at)}</td>
                      <td className={TD}>{x.kindText}{x.test ? <> <Tag tone="warn">{t('exceptions.testYes')}</Tag></> : null}</td>
                      <td className={TD}>{x.batchName ?? ''}{x.typeName ? <span className="block text-xs text-muted-foreground">{x.typeName}</span> : null}</td>
                      <td className={cn(TD, 'tabular-nums')}>{x.serial ? `#${x.serial}` : ''}</td>
                      <td className={TD}>{x.machineName ?? ''}</td>
                      <td className={TD}>{x.employeeName ?? ''}</td>
                      <td className={cn(TD, 'text-xs text-muted-foreground')}>{exceptionDetails(x, t)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
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

  const getSheets = (): ExcelSheet => ({
    name: t('kinds.overrides'),
    columns: [
      { header: t('exceptions.at'), kind: 'datetime' }, { header: t('exceptions.batch'), width: 24 }, { header: t('exceptions.type'), width: 18 },
      { header: t('overrides.product'), width: 22 }, { header: t('overrides.category'), width: 16 },
      { header: t('overrides.listPrice'), kind: 'money' }, { header: t('overrides.value'), kind: 'money' },
      { header: t('overrides.reduction'), kind: 'money' }, { header: t('overrides.policy') }, { header: t('overrides.approvedBy') },
      { header: t('exceptions.employee') }, { header: t('exceptions.till') },
    ],
    rows: rows.map((x) => [
      x.at, x.batchName ?? '', x.typeName ?? '', x.productName ?? '', x.categoryName ?? '', shekelsOf(x.listPriceAgorot),
      shekelsOf(x.valueAgorot), shekelsOf(x.reductionAgorot), policyText(x.policy), x.approvedBy ?? '', x.employeeName ?? '',
      x.machineName ?? '',
    ]),
  });

  return (
    <div className="space-y-3">
      <ReportExportToolbar title={t('kinds.overrides')} from={filters.from || undefined} to={filters.to || undefined}
        getSheets={getSheets} disabled={!rows.length} />
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
          {rows.length === 0 ? <Empty>{t('overrides.empty')}</Empty> : (
            <div className="overflow-x-auto rounded-xl bg-card ring-1 ring-foreground/10">
              <table className="w-full text-sm">
                <thead className="text-xs text-muted-foreground">
                  <tr className="border-b">
                    <th className={TH}>{t('exceptions.at')}</th>
                    <th className={TH}>{t('exceptions.batch')}</th>
                    <th className={TH}>{t('overrides.product')}</th>
                    <th className={TH_END}>{t('overrides.listPrice')}</th>
                    <th className={TH_END}>{t('overrides.value')}</th>
                    <th className={TH_END}>{t('overrides.reduction')}</th>
                    <th className={TH}>{t('overrides.policy')}</th>
                    <th className={TH}>{t('overrides.approvedBy')}</th>
                    <th className={TH}>{t('exceptions.employee')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((x, i) => (
                    <tr key={`${x.transactionId ?? ''}-${x.productId ?? ''}-${i}`} className="border-b last:border-0">
                      <td className={cn(TD, 'whitespace-nowrap tabular-nums')}>{whenText(x.at)}</td>
                      <td className={TD}>{x.batchName ?? ''}{x.typeName ? <span className="block text-xs text-muted-foreground">{x.typeName}</span> : null}</td>
                      <td className={TD}>{x.productName ?? ''}{x.categoryName ? <span className="block text-xs text-muted-foreground">{x.categoryName}</span> : null}</td>
                      <td className={TD_END}>{money(x.listPriceAgorot)}</td>
                      <td className={TD_END}>{money(x.valueAgorot)}</td>
                      <td className={TD_END}>{money(x.reductionAgorot)}</td>
                      <td className={TD}>{policyText(x.policy)}</td>
                      <td className={TD}>{x.approvedBy ?? ''}</td>
                      <td className={TD}>{x.employeeName ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
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

  const getSheets = (): ExcelSheet => ({
    name: t('kinds.catalog'),
    columns: [
      { header: t('exceptions.batch'), width: 26 }, { header: t('exceptions.type'), width: 18 }, { header: t('catalog.mode.label'), width: 18 },
      { header: t('catalog.roleLabel'), width: 18 }, { header: t('catalog.name'), width: 24 }, { header: t('catalog.category'), width: 16 },
      { header: t('catalog.quantity'), kind: 'number' }, { header: t('catalog.priceNow'), kind: 'money' },
      { header: t('catalog.noDiscount') }, { header: t('catalog.status'), width: 30 }, { header: t('catalog.notes'), width: 40 },
      { header: t('overrides.policy') },
    ],
    rows: rows.map((x) => [
      x.batchName, x.typeName ?? '', modeText(x.catalogMode), roleText(x), name(x), x.role === 'target_category' ? '' : x.categoryName ?? '',
      x.quantity ?? null, x.priceNow ?? null, x.noDiscount ? t('catalog.yes') : '', blockText(x), notesText(x), policyText(x.policyMode),
    ]),
  });

  return (
    <div className="space-y-3">
      <ReportExportToolbar title={t('kinds.catalog')} getSheets={getSheets} disabled={!rows.length} />
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
          {rows.length === 0 ? <Empty>{t('catalog.empty')}</Empty> : (
            <div className="overflow-x-auto rounded-xl bg-card ring-1 ring-foreground/10">
              <table className="w-full text-sm">
                <thead className="text-xs text-muted-foreground">
                  <tr className="border-b">
                    <th className={TH}>{t('exceptions.batch')}</th>
                    <th className={TH}>{t('catalog.roleLabel')}</th>
                    <th className={TH}>{t('catalog.name')}</th>
                    <th className={TH_END}>{t('catalog.quantity')}</th>
                    <th className={TH_END}>{t('catalog.priceNow')}</th>
                    <th className={TH}>{t('catalog.status')}</th>
                    <th className={TH}>{t('catalog.notes')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((x, i) => (
                    <tr key={`${x.batchId}-${x.productId ?? x.categoryId ?? ''}-${i}`} className="border-b align-top last:border-0">
                      <td className={TD}>
                        {x.batchName}
                        <span className="block text-xs text-muted-foreground">{[x.typeName, modeText(x.catalogMode)].filter(Boolean).join(' · ')}</span>
                      </td>
                      <td className={cn(TD, 'text-xs')}>{roleText(x)}</td>
                      <td className={TD}>
                        {name(x)}
                        {x.role !== 'target_category' && x.categoryName ? <span className="block text-xs text-muted-foreground">{x.categoryName}</span> : null}
                        {x.nameNow && x.productName && x.nameNow !== x.productName
                          ? <span className="block text-xs text-muted-foreground">{t('catalog.nameNow', { name: x.nameNow })}</span> : null}
                      </td>
                      <td className={TD_END}>{x.quantity ?? ''}</td>
                      <td className={TD_END}>{x.priceNow != null ? `₪${x.priceNow.toFixed(2)}` : ''}</td>
                      <td className={TD}>
                        <Tag tone={x.usable ? 'good' : 'bad'}>{blockText(x)}</Tag>
                        {x.noDiscount ? <span className="block text-xs text-muted-foreground">{t('catalog.noDiscount')}{x.overrideApplies ? ` · ${t('catalog.overrideApplies')}` : ''}</span> : null}
                      </td>
                      <td className={cn(TD, 'text-xs text-muted-foreground')}>{notesText(x)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
