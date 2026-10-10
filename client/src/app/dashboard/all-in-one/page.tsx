'use client';

/**
 * "דוח שמכיל הכל" (docs/SPEC_REPORTS.md §5): one report over a range of days and the shops /
 * tills chosen — the sales summary, payment methods and card brands, by till, employee, day,
 * category and item, credit notes, discounts, tips, VAT, the Zs, the card transmissions, the
 * failed payment attempts, staff / managers' meals and the kiosks — on one page, and as one
 * Excel workbook with a sheet per section. Server: `GET /report-center/all-in-one`.
 */

import { useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { usePageScope } from '@/lib/scope';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { formatCurrency, formatDate, formatDateTime, formatQuantity } from '@/lib/format';
import { businessDaysBackIso, businessTodayIso } from '@/lib/reportWindow';
import { dayBasisQuery, type DayBasis } from '@/lib/businessDay';
import { DayBasisSelect, DocumentDateNote, WindowBasisLine } from '@/components/dashboard/business-day/day-basis';
import { useCardBrandLabels } from '@/lib/cardBrands';
import { fetchAllInOne, type AllInOneReport } from '@/lib/reportCenterApi';
import { allInOneSheets } from '@/lib/reportSheets';
import { ScopeGate } from '@/components/dashboard/scope-gate';
import { ReportExportToolbar } from '@/components/dashboard/report-export-toolbar';
import { ReportErrorState } from '@/components/dashboard/report-window-summary';
import { usePaymentMethodLabel } from '@/components/dashboard/shifts/shift-parts';
import { CenterFilters, scopedIds, type CenterFiltersState } from '@/components/dashboard/report-center/center-filters';
import { KpiGrid, Section, SimpleTable } from '@/components/dashboard/report-center/parts';
import { Skeleton } from '@/components/ui/skeleton';

type Money = { documents: number; gross: number; discounts: number; refunds: number; net: number; cash: number; card: number; other: number; tips: number };

const SCREEN_ROWS = 25;

export default function AllInOnePage() {
  const t = useTranslations('reportCenter.allInOne');
  const tr = useTranslations('reportCenter');
  const tc = useTranslations('reportCenter.cols');
  const tcommon = useTranslations('common');
  const method = usePaymentMethodLabel();
  const brands = useCardBrandLabels();
  const { scope, resolution, effective } = usePageScope({ maxLevel: 'machine' });

  const [filters, setFilters] = useState<CenterFiltersState>({ from: businessDaysBackIso(6), to: businessTodayIso(), shopIds: [], machineIds: [] });
  const [applied, setApplied] = useState<CenterFiltersState | null>(null);
  // "לפי יום עסקי" (the default) / "לפי תאריך מסמך"; the VAT section is always by document date.
  const [basis, setBasis] = useState<DayBasis>('business');

  const params = useMemo(() => {
    if (!applied) return null;
    const ids = scopedIds(applied, effective, scope);
    return { from: applied.from, to: applied.to, shopIds: ids.shopIds, machineIds: ids.machineIds, ...dayBasisQuery(basis) };
  }, [applied, basis, effective, scope]);

  const { data, isLoading, isFetching, isError, error } = useQuery<AllInOneReport>({
    queryKey: ['report-all-in-one', params],
    queryFn: () => fetchAllInOne(params!),
    enabled: params !== null,
  });

  const moneyCols = <T extends Money>(): { label: string; cell: (r: T) => ReactNode; end: boolean }[] => [
    { label: tc('documents'), cell: (r) => formatQuantity(r.documents), end: true },
    { label: tc('gross'), cell: (r) => formatCurrency(r.gross), end: true },
    { label: tc('discounts'), cell: (r) => formatCurrency(r.discounts), end: true },
    { label: tc('refunds'), cell: (r) => formatCurrency(r.refunds), end: true },
    { label: tc('net'), cell: (r) => <span className="font-semibold">{formatCurrency(r.net)}</span>, end: true },
    { label: tc('cash'), cell: (r) => formatCurrency(r.cash), end: true },
    { label: tc('card'), cell: (r) => formatCurrency(r.card), end: true },
    { label: tc('tips'), cell: (r) => formatCurrency(r.tips), end: true },
  ];
  const more = (n: number) => tr('moreInExcel', { count: n });

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
      </div>

      <ScopeGate resolution={resolution}>
        <CenterFilters
          value={filters}
          onChange={setFilters}
          onRun={() => setApplied(filters)}
          busy={isFetching}
          effective={effective}
          scope={scope}
        />
        <div className="print:hidden">
          <DayBasisSelect value={basis} onChange={setBasis} />
        </div>

        {!applied ? (
          <p className="text-muted-foreground py-12 text-center text-sm">{tr('selectFilters')}</p>
        ) : isLoading ? (
          <Skeleton className="h-96 w-full" />
        ) : isError ? (
          <ReportErrorState message={axiosErrorToToastMessage(error, tcommon('error'))} />
        ) : data && !data.empty && data.summary ? (
          <div className="space-y-4">
            <ReportExportToolbar
              title={t('title')}
              from={data.window.from}
              to={data.window.to}
              getSheets={() => allInOneSheets(data, tc, method, brands.brand)}
            />
            <p className="text-muted-foreground text-xs">
              {tr('generated', { at: formatDateTime(data.generatedAt), range: `${formatDate(data.window.from)} – ${formatDate(data.window.to)}` })}
            </p>
            <WindowBasisLine window={data.window} />

            <KpiGrid
              items={[
                { label: tc('net'), value: formatCurrency(data.summary.net) },
                { label: tc('gross'), value: formatCurrency(data.summary.gross) },
                { label: tc('discounts'), value: formatCurrency(data.summary.discounts) },
                { label: tc('refunds'), value: formatCurrency(data.summary.refunds) },
                { label: tc('vat'), value: formatCurrency(data.summary.vat) },
                { label: tc('netOfVat'), value: formatCurrency(data.summary.netOfVat) },
                { label: tc('documents'), value: formatQuantity(data.summary.documents) },
                { label: tc('averageBasket'), value: formatCurrency(data.summary.averageBasket) },
                { label: tc('tips'), value: formatCurrency(data.summary.tips) },
                { label: tc('cancelledDocuments'), value: formatQuantity(data.summary.cancelledDocuments) },
                { label: tc('failedAttempts'), value: formatQuantity(data.summary.failedAttempts), tone: data.summary.failedAttempts ? 'warn' : undefined },
                { label: tc('zCount'), value: formatQuantity(data.summary.zCount) },
              ]}
            />

            <div className="grid gap-4 lg:grid-cols-2">
              <Section title={tc('sheetPayments')}>
                <SimpleTable
                  empty={tr('noRows')}
                  rows={data.byPaymentMethod ?? []}
                  columns={[
                    { label: tc('paymentMethod'), cell: (r) => method(r.method) },
                    { label: tc('documents'), cell: (r) => formatQuantity(r.documents), end: true },
                    { label: tc('amount'), cell: (r) => formatCurrency(r.amount), end: true },
                    { label: tc('share'), cell: (r) => `${r.share.toFixed(1)}%`, end: true },
                  ]}
                />
              </Section>
              <Section title={tc('sheetCardBrands')}>
                <SimpleTable
                  empty={tr('noRows')}
                  rows={data.cardBrands ?? []}
                  columns={[
                    { label: tc('brand'), cell: (r) => brands.brand(r.brand) },
                    { label: tc('salesAmount'), cell: (r) => formatCurrency(r.salesAmount), end: true },
                    { label: tc('refundsAmount'), cell: (r) => formatCurrency(r.refundsAmount), end: true },
                    { label: tc('net'), cell: (r) => formatCurrency(r.net), end: true },
                  ]}
                />
              </Section>
            </div>

            <Section title={tc('sheetTills')}>
              <SimpleTable
                empty={tr('noRows')}
                rows={data.byTill ?? []}
                columns={[
                  { label: tc('till'), cell: (r) => <>{r.machineName ?? '—'}{r.kiosk ? <span className="text-muted-foreground ms-1 text-xs">({tr('kiosk')})</span> : null}</> },
                  { label: tc('shop'), cell: (r) => r.shopName ?? '—' },
                  ...moneyCols<NonNullable<AllInOneReport['byTill']>[number]>(),
                ]}
                footer={[tc('total'), '', formatQuantity(data.summary.documents), formatCurrency(data.summary.gross), formatCurrency(data.summary.discounts),
                  formatCurrency(data.summary.refunds), formatCurrency(data.summary.net), formatCurrency(data.summary.cash), formatCurrency(data.summary.card),
                  formatCurrency(data.summary.tips)]}
              />
            </Section>

            <Section title={tc('sheetEmployees')}>
              <SimpleTable
                empty={tr('noRows')}
                rows={data.byEmployee ?? []}
                columns={[
                  { label: tc('employee'), cell: (r) => r.cashierName ?? r.cashierId ?? '—' },
                  ...moneyCols<NonNullable<AllInOneReport['byEmployee']>[number]>(),
                ]}
              />
            </Section>

            <Section title={tc('sheetDays')}>
              <SimpleTable
                empty={tr('noRows')}
                rows={data.byDay ?? []}
                columns={[
                  { label: tc('day'), cell: (r) => formatDate(r.day) },
                  ...moneyCols<NonNullable<AllInOneReport['byDay']>[number]>(),
                ]}
              />
            </Section>

            <div className="grid gap-4 lg:grid-cols-2">
              <Section title={tc('sheetCategories')}>
                <SimpleTable
                  empty={tr('noRows')}
                  rows={data.byCategory ?? []}
                  limit={SCREEN_ROWS}
                  more={more}
                  columns={[
                    { label: tc('category'), cell: (r) => r.categoryName ?? '—' },
                    { label: tc('units'), cell: (r) => formatQuantity(r.units), end: true },
                    { label: tc('net'), cell: (r) => formatCurrency(r.net), end: true },
                    { label: tc('share'), cell: (r) => `${r.share.toFixed(1)}%`, end: true },
                  ]}
                />
              </Section>
              <Section title={tc('sheetItems')} note={data.itemsTruncated ? tr('itemsTruncated') : undefined}>
                <SimpleTable
                  empty={tr('noRows')}
                  rows={data.byItem ?? []}
                  limit={SCREEN_ROWS}
                  more={more}
                  columns={[
                    { label: tc('item'), cell: (r) => r.productName ?? r.sku ?? '—' },
                    { label: tc('unitsNet'), cell: (r) => formatQuantity(r.unitsNet), end: true },
                    { label: tc('net'), cell: (r) => formatCurrency(r.net), end: true },
                  ]}
                />
              </Section>
            </div>

            <Section title={tc('sheetRefunds')} note={tr('refundsNote', { count: data.refunds?.count ?? 0, total: formatCurrency(data.refunds?.total ?? 0) })}>
              <SimpleTable
                empty={tr('noRows')}
                rows={data.refunds?.items ?? []}
                limit={SCREEN_ROWS}
                more={more}
                columns={[
                  { label: tc('createdAt'), cell: (r) => formatDateTime(r.createdAt) },
                  { label: tc('documentNumber'), cell: (r) => <span className="font-mono text-xs">{r.documentNumber}</span> },
                  { label: tc('refundOf'), cell: (r) => <span className="font-mono text-xs">{r.originalNumber ?? '—'}</span> },
                  { label: tc('till'), cell: (r) => r.machineName ?? '—' },
                  { label: tc('employee'), cell: (r) => r.cashierName ?? '—' },
                  { label: tc('amount'), cell: (r) => formatCurrency(r.amount), end: true },
                ]}
              />
            </Section>

            <div className="grid gap-4 lg:grid-cols-3">
              <Section title={tc('sheetDiscounts')}>
                <SimpleTable
                  empty={tr('noRows')}
                  rows={[
                    { label: tc('documentDiscounts'), amount: data.discounts?.documentDiscounts ?? 0 },
                    { label: tc('lineDiscounts'), amount: data.discounts?.lineDiscounts ?? 0 },
                    { label: tc('promotionDiscounts'), amount: data.discounts?.promotionDiscounts ?? 0 },
                    ...(data.discounts?.byKind ?? []).map((k) => ({ label: `${tc('discountKind')}: ${k.kind}`, amount: k.amount })),
                  ]}
                  columns={[
                    { label: tc('item'), cell: (r) => r.label },
                    { label: tc('amount'), cell: (r) => formatCurrency(r.amount), end: true },
                  ]}
                />
              </Section>
              <Section title={tc('sheetTips')}>
                <SimpleTable
                  empty={tr('noRows')}
                  rows={[
                    { label: tc('tips'), amount: data.tips?.total ?? 0 },
                    { label: tc('cashTips'), amount: data.tips?.cash ?? 0 },
                    { label: tc('cardTips'), amount: data.tips?.card ?? 0 },
                  ]}
                  columns={[
                    { label: tc('item'), cell: (r) => r.label },
                    { label: tc('amount'), cell: (r) => formatCurrency(r.amount), end: true },
                  ]}
                />
              </Section>
              <Section title={tc('sheetVat')}>
                <DocumentDateNote kind="vat" />
                <SimpleTable
                  empty={tr('noRows')}
                  rows={data.vat?.rows ?? []}
                  columns={[
                    { label: tc('vatRate'), cell: (r) => (r.rate === null ? '—' : `${r.rate}%`) },
                    { label: tc('gross'), cell: (r) => formatCurrency(r.gross), end: true },
                    { label: tc('vat'), cell: (r) => formatCurrency(r.vat), end: true },
                    { label: tc('netOfVat'), cell: (r) => formatCurrency(r.netOfVat), end: true },
                  ]}
                  footer={[tc('total'), formatCurrency(data.vat?.totals.gross ?? 0), formatCurrency(data.vat?.totals.vat ?? 0), formatCurrency(data.vat?.totals.netOfVat ?? 0)]}
                />
              </Section>
            </div>

            <Section title={tc('sheetZs')}>
              <SimpleTable
                empty={tr('noRows')}
                rows={data.zs?.zs ?? []}
                limit={SCREEN_ROWS}
                more={more}
                columns={[
                  { label: tc('zNumber'), cell: (r) => <Link className="hover:underline" href={`/dashboard/z-reports/${r.id}`}>{r.zNumber ?? '—'}</Link> },
                  { label: tc('zType'), cell: (r) => r.zTypeLabel },
                  { label: tc('tills'), cell: (r) => r.tills ?? '—' },
                  { label: tc('businessDate'), cell: (r) => formatDate(r.businessDate) },
                  { label: tc('netSales'), cell: (r) => formatCurrency(r.netSales), end: true },
                  { label: tc('vat'), cell: (r) => formatCurrency(r.vatTotal), end: true },
                  { label: tc('untransmittedLegs'), cell: (r) => formatQuantity(r.transmission.untransmittedLegs), end: true },
                ]}
              />
            </Section>

            <div className="grid gap-4 lg:grid-cols-2">
              <Section title={tc('sheetTransmissions')}>
                <SimpleTable
                  empty={tr('noRows')}
                  rows={data.transmissions?.byTill ?? []}
                  columns={[
                    { label: tc('till'), cell: (r) => r.machineName ?? '—' },
                    { label: tc('attempts'), cell: (r) => formatQuantity(r.attempts), end: true },
                    { label: tc('success'), cell: (r) => formatQuantity(r.success), end: true },
                    { label: tc('failed'), cell: (r) => formatQuantity(r.failed), end: true },
                    { label: tc('amount'), cell: (r) => formatCurrency(r.amount), end: true },
                    { label: tc('lastSuccessAt'), cell: (r) => formatDateTime(r.lastSuccessAt) },
                  ]}
                />
              </Section>
              <Section title={tc('sheetFailed')} note={tr('failedNote', { count: data.failedPayments?.summary.count ?? 0, total: formatCurrency((data.failedPayments?.summary.totalAgorot ?? 0) / 100) })}>
                <SimpleTable
                  empty={tr('noRows')}
                  rows={data.failedPayments?.items ?? []}
                  limit={SCREEN_ROWS}
                  more={more}
                  columns={[
                    { label: tc('occurredAt'), cell: (r) => formatDateTime(r.occurredAt) },
                    { label: tc('till'), cell: (r) => r.machineName ?? '—' },
                    { label: tc('outcome'), cell: (r) => r.outcomeLabel },
                    { label: tc('amount'), cell: (r) => formatCurrency(r.amount), end: true },
                  ]}
                />
              </Section>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <Section title={tc('sheetMeals')}>
                <SimpleTable
                  empty={tr('noRows')}
                  rows={[
                    { label: tc('meal_staff'), ...(data.meals?.staff ?? { count: 0, before: 0, discount: 0, paid: 0 }) },
                    { label: tc('meal_managers'), ...(data.meals?.managers ?? { count: 0, before: 0, discount: 0, paid: 0 }) },
                  ]}
                  columns={[
                    { label: tc('mealKind'), cell: (r) => r.label },
                    { label: tc('count'), cell: (r) => formatQuantity(r.count), end: true },
                    { label: tc('before'), cell: (r) => formatCurrency(r.before), end: true },
                    { label: tc('discount'), cell: (r) => formatCurrency(r.discount), end: true },
                    { label: tc('paid'), cell: (r) => formatCurrency(r.paid), end: true },
                  ]}
                />
              </Section>
              <Section title={tc('sheetKiosks')}>
                <SimpleTable
                  empty={tr('noKiosks')}
                  rows={data.kiosks?.byKiosk ?? []}
                  columns={[
                    { label: tc('till'), cell: (r) => r.machineName ?? '—' },
                    { label: tc('documents'), cell: (r) => formatQuantity(r.documents), end: true },
                    { label: tc('net'), cell: (r) => formatCurrency(r.net), end: true },
                    { label: tc('card'), cell: (r) => formatCurrency(r.card), end: true },
                  ]}
                />
              </Section>
            </div>
          </div>
        ) : (
          <p className="text-muted-foreground py-12 text-center text-sm">{tr('noRows')}</p>
        )}
      </ScopeGate>
    </div>
  );
}
