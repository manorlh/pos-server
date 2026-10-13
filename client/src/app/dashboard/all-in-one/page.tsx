'use client';

/**
 * "דוח שמכיל הכל" (docs/SPEC_REPORTS.md §5): one report over a range of days and the shops /
 * tills chosen — the sales summary, payment methods and card brands, by till, employee, day,
 * category and item, credit notes, discounts, tips, VAT, the Zs, the card transmissions, the
 * failed payment attempts, staff / managers' meals and the kiosks — on one page, and as one
 * Excel workbook with a sheet per section. Server: `GET /report-center/all-in-one`.
 *
 * On the report framework (P:\specs\reports-upgrade.md §5): the days, the hours (the documents'
 * sections), the shops / tills (`?shops=&tills=`) and which date the Z section reads
 * (`?zDateBasis=production`) in the URL. The workbook keeps every sheet in its order — built by
 * `allInOneSheets` as before, each sheet now a table whose columns can be chosen; the sheets with
 * no section on screen (Zs by till, the transmission reports, the meals list) are export-only.
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { usePageScope } from '@/lib/scope';
import { formatCurrency, formatDate, formatDateTime, formatHour, formatQuantity } from '@/lib/format';
import { useCardBrandLabels } from '@/lib/cardBrands';
import type { ReportFilterSpec } from '@/lib/reportFilters';
import type { ReportFilterLine } from '@/lib/reportExport';
import { fetchAllInOne, type AllInOneReport } from '@/lib/reportCenterApi';
import { allInOneSheets } from '@/lib/reportSheets';
import { keyedSheets, type KeyedSheet } from '@/lib/reportCenterView';
import { Z_DATE_BASES, type ZDateBasis } from '@/lib/zByDate';
import { usePaymentMethodLabel } from '@/components/dashboard/shifts/shift-parts';
import {
  CENTER_SCOPE_EXTRAS,
  CenterScopeFields,
  centerScopeIds,
  useCenterScopeLines,
} from '@/components/dashboard/report-center/center-scope-fields';
import { CenterTable, sheetTable, type SheetTableOptions } from '@/components/dashboard/report-center/sheet-table';
import { KpiGrid } from '@/components/dashboard/report-center/parts';
import { Label } from '@/components/ui/label';
import {
  ReportPage,
  reportQueryState,
  useReportFilters,
  type ReportTableSpec,
} from '@/components/dashboard/report-framework';

const SPEC: ReportFilterSpec = {
  filters: ['hours'],
  // The server's default: the Z section by business date.
  extras: { ...CENTER_SCOPE_EXTRAS, zDateBasis: 'business' },
};

const SCREEN_ROWS = 25;
/** The sheet builder run with the keys as its words: the columns' stable keys. */
const KEY = (k: string) => k;
const METHOD_KEY = (m: string) => `pm:${m}`;

/** Each sheet of `allInOneSheets` (by its name's key) → its table id; the tills are the main table. */
const SHEET_IDS: Record<string, string> = {
  sheetSummary: 'summary',
  sheetPayments: 'payments',
  sheetCardBrands: 'brands',
  sheetTills: 'main',
  sheetEmployees: 'employees',
  sheetDays: 'days',
  sheetCategories: 'categories',
  sheetItems: 'items',
  sheetRefunds: 'refunds',
  sheetDiscounts: 'discounts',
  sheetTips: 'tips',
  sheetVat: 'vat',
  sheetZs: 'zs',
  sheetZTills: 'ztills',
  sheetTransmissions: 'transmissions',
  sheetFailed: 'failed',
  sheetMeals: 'meals',
  sheetKiosks: 'kiosks',
};

/** The money columns each "by till / employee / day / kiosk" section shows. */
const MONEY_SCREEN = ['documents', 'gross', 'discounts', 'refunds', 'net', 'cash', 'card', 'tips'];

type R = AllInOneReport;
type Till = NonNullable<R['byTill']>[number];
type Item = NonNullable<R['byItem']>[number];
type Refund = NonNullable<R['refunds']>['items'][number];
type Vat = NonNullable<R['vat']>['rows'][number];
type Z = NonNullable<R['zs']>['zs'][number];
type TxTill = NonNullable<R['transmissions']>['byTill'][number];
type MealKind = { kind: 'staff' | 'managers'; count: number; before: number; discount: number; paid: number };

export default function AllInOnePage() {
  const t = useTranslations('reportCenter.allInOne');
  const tr = useTranslations('reportCenter');
  const tc = useTranslations('reportCenter.cols');
  const tw = useTranslations('reports.window');
  const tz = useTranslations('zByDate');
  const method = usePaymentMethodLabel();
  const brands = useCardBrandLabels();
  // New functions on every render, the same words (one locale): kept from the first, so the
  // workbook is not rebuilt on every render.
  const [labels] = useState(() => ({ method, brand: brands.brand }));
  const { scope, resolution, effective } = usePageScope({ maxLevel: 'machine' });
  const filters = useReportFilters(SPEC);
  const applied = filters.applied;

  const params = useMemo(() => {
    if (!applied || !filters.apiParams) return null;
    const ids = centerScopeIds(applied.extras, effective, scope);
    return {
      ...filters.apiParams,
      shopIds: ids.shopIds,
      machineIds: ids.machineIds,
      ...(applied.extras.zDateBasis === 'production' ? { zDateBasis: 'production' } : {}),
    };
  }, [applied, effective, filters.apiParams, scope]);

  const query = useQuery<AllInOneReport>({
    queryKey: ['report-all-in-one', params],
    queryFn: () => fetchAllInOne(params!),
    enabled: params !== null,
  });
  const data = query.data;

  /** Every sheet of the workbook, keyed, by table id. */
  const sheets = useMemo(() => {
    if (!data) return null;
    const keyed = keyedSheets(allInOneSheets(data, KEY, METHOD_KEY, KEY), allInOneSheets(data, tc, labels.method, labels.brand));
    return new Map<string, KeyedSheet>(keyed.map((s) => [SHEET_IDS[s.key] ?? s.key.toLowerCase(), s]));
  }, [data, labels, tc]);

  const tables = useMemo(() => {
    if (!data || !sheets) return null;
    /** The workbook's tables by id (the order is the sheets'). */
    const specs = new Map<string, ReportTableSpec<unknown>>();
    const of = <T,>(id: string, opts: Omit<SheetTableOptions<T>, 'id'> = {}) => {
      const ks = sheets.get(id);
      if (!ks) return null;
      const spec = sheetTable<T>(ks, { id, emptyText: tr('noRows'), ...opts });
      specs.set(id, spec as ReportTableSpec<unknown>);
      return spec;
    };
    const mono = (v: unknown) => <span className="font-mono text-xs">{v === null || v === undefined || v === '' ? '—' : String(v)}</span>;
    const net = { net: 'font-semibold' };

    // The tables on screen have their sections; the others go to the workbook only.
    const screen = {
      summary: of('summary'),
      payments: of('payments'),
      brands: of('brands', { screen: ['brand', 'salesAmount', 'refundsAmount', 'net'] }),
      tills: of<Till>('main', {
        src: data.byTill ?? [],
        screen: ['till', 'shop', ...MONEY_SCREEN],
        classNames: net,
        cells: {
          till: (r) => (
            <>
              {r.src.machineName ?? '—'}
              {r.src.kiosk ? <span className="text-muted-foreground ms-1 text-xs">({tr('kiosk')})</span> : null}
            </>
          ),
        },
      }),
      employees: of('employees', { screen: ['employee', ...MONEY_SCREEN], classNames: net }),
      days: of('days', { screen: ['day', ...MONEY_SCREEN], classNames: net }),
      categories: of('categories', { screen: ['category', 'units', 'net', 'share'] }),
      items: of<Item>('items', {
        src: data.byItem ?? [],
        screen: ['item', 'unitsNet', 'net'],
        cells: { item: (r) => r.src.productName ?? r.src.sku ?? '—' },
      }),
      refunds: of<Refund>('refunds', {
        src: data.refunds?.items ?? [],
        screen: ['createdAt', 'documentNumber', 'refundOf', 'till', 'employee', 'amount'],
        cells: { documentNumber: (r) => mono(r.src.documentNumber), refundOf: (r) => mono(r.src.originalNumber) },
      }),
      discounts: of('discounts', { screen: ['item', 'amount'] }),
      tips: of('tips'),
      vat: of<Vat>('vat', {
        src: data.vat?.rows ?? [],
        screen: ['vatRate', 'gross', 'vat', 'netOfVat'],
        cells: { vatRate: (r) => (r.src.rate === null ? '—' : `${r.src.rate}%`) },
      }),
      zs: of<Z>('zs', {
        src: data.zs?.zs ?? [],
        screen: ['zNumber', 'zType', 'tills', 'businessDate', 'netSales', 'vat', 'untransmittedLegs'],
        cells: {
          zNumber: (r) => (
            <Link className="hover:underline" href={`/dashboard/z-reports/${r.src.id}`}>
              {r.src.zNumber ?? '—'}
            </Link>
          ),
        },
      }),
      ztills: of('ztills'),
      transmissions: of('transmissions'),
      failed: of('failed', { screen: ['occurredAt', 'till', 'outcome', 'amount'] }),
      meals: of('meals'),
      kiosks: of('kiosks', { screen: ['till', 'documents', 'net', 'card'], emptyText: tr('noKiosks') }),
    };

    // On screen only, as before (the workbook has the transmission reports and the meals list).
    const txTills: ReportTableSpec<TxTill> = {
      id: 'tx-tills',
      title: t('transmissionsByTill'),
      noExport: true,
      rows: data.transmissions?.byTill ?? [],
      rowKey: (_r, i) => String(i),
      emptyText: tr('noRows'),
      columns: [
        { key: 'till', header: tc('till'), required: true, value: (r) => r.machineName },
        { key: 'attempts', header: tc('attempts'), kind: 'number', value: (r) => r.attempts },
        { key: 'success', header: tc('success'), kind: 'number', value: (r) => r.success },
        { key: 'failed', header: tc('failed'), kind: 'number', value: (r) => r.failed },
        { key: 'amount', header: tc('amount'), kind: 'money', value: (r) => r.amount },
        { key: 'lastSuccessAt', header: tc('lastSuccessAt'), kind: 'datetime', value: (r) => r.lastSuccessAt },
      ],
    };
    const zeroMeal = { count: 0, before: 0, discount: 0, paid: 0 };
    const mealKinds: ReportTableSpec<MealKind> = {
      id: 'meal-kinds',
      title: tc('sheetMeals'),
      noExport: true,
      rows: [
        { kind: 'staff', ...(data.meals?.staff ?? zeroMeal) },
        { kind: 'managers', ...(data.meals?.managers ?? zeroMeal) },
      ],
      rowKey: (r) => r.kind,
      columns: [
        { key: 'mealKind', header: tc('mealKind'), required: true, value: (r) => tc(`meal_${r.kind}`) },
        { key: 'count', header: tc('count'), kind: 'number', value: (r) => r.count },
        { key: 'before', header: tc('before'), kind: 'money', value: (r) => r.before },
        { key: 'discount', header: tc('discount'), kind: 'money', value: (r) => r.discount },
        { key: 'paid', header: tc('paid'), kind: 'money', value: (r) => r.paid },
      ],
    };
    // The workbook, in `allInOneSheets`' order (an empty report: the summary alone).
    const workbook = Array.from(sheets.keys())
      .map((id) => specs.get(id))
      .filter((spec): spec is ReportTableSpec<unknown> => Boolean(spec));
    return { ...screen, txTills, mealKinds, workbook };
  }, [data, sheets, t, tc, tr]);

  const basis = (applied?.extras.zDateBasis === 'production' ? 'production' : 'business') as ZDateBasis;
  const draftBasis = (filters.draftExtras.zDateBasis === 'production' ? 'production' : 'business') as ZDateBasis;
  const scopeLines = useCenterScopeLines(applied?.extras, effective, scope);
  const filterLines: ReportFilterLine[] = [
    ...scopeLines,
    ...(basis === 'production' ? [{ label: t('zDateBasis'), value: tz('basis.production') }] : []),
  ];

  const w = data?.window;
  const hours =
    w && w.fromHour !== null && w.fromHour !== undefined && w.toHour !== null && w.toHour !== undefined
      ? tw('hourBandEachDay', { band: `${formatHour(w.fromHour)}–${formatHour(w.toHour)}` })
      : null;
  const s = data?.summary;
  const exportTables = tables?.workbook ?? [];

  return (
    <ReportPage
      reportKey="all-in-one"
      title={t('title')}
      subtitle={t('subtitle')}
      resolution={resolution}
      filters={filters}
      bar={{
        hint: t('hoursHint'),
        children: (
          <>
            <CenterScopeFields filters={filters} effective={effective} scope={scope} />
            <div className="min-w-0 space-y-1">
              <Label className="text-xs">{t('zDateBasis')}</Label>
              <div className="inline-flex rounded-md border p-0.5" role="group" aria-label={t('zDateBasis')}>
                {[...Z_DATE_BASES].reverse().map((b) => (
                  <button
                    key={b}
                    type="button"
                    aria-pressed={draftBasis === b}
                    onClick={() => filters.setExtra('zDateBasis', b)}
                    className={`rounded px-2.5 py-1 text-xs ${
                      draftBasis === b ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {tz(`basis.${b}`)}
                  </button>
                ))}
              </div>
            </div>
          </>
        ),
      }}
      query={reportQueryState(query)}
      prompt={tr('selectFilters')}
      export={
        data && exportTables.length
          ? { tables: exportTables, pdfTableId: 'main', filterLines, from: data.window.from, to: data.window.to }
          : null
      }
    >
      {data && tables && s && !data.empty ? (
        <>
          <p className="text-muted-foreground text-xs">
            {tr('generated', { at: formatDateTime(data.generatedAt), range: `${formatDate(data.window.from)} – ${formatDate(data.window.to)}` })}
            {hours ? ` · ${hours}` : ''}
          </p>

          <KpiGrid
            items={[
              { label: tc('net'), value: formatCurrency(s.net) },
              { label: tc('gross'), value: formatCurrency(s.gross) },
              { label: tc('discounts'), value: formatCurrency(s.discounts) },
              { label: tc('refunds'), value: formatCurrency(s.refunds) },
              { label: tc('vat'), value: formatCurrency(s.vat) },
              { label: tc('netOfVat'), value: formatCurrency(s.netOfVat) },
              { label: tc('documents'), value: formatQuantity(s.documents) },
              { label: tc('averageBasket'), value: formatCurrency(s.averageBasket) },
              { label: tc('tips'), value: formatCurrency(s.tips) },
              { label: tc('cancelledDocuments'), value: formatQuantity(s.cancelledDocuments) },
              { label: tc('failedAttempts'), value: formatQuantity(s.failedAttempts), tone: s.failedAttempts ? 'warn' : undefined },
              { label: tc('zCount'), value: formatQuantity(s.zCount) },
            ]}
          />

          <div className="grid gap-4 lg:grid-cols-2">
            {tables.payments ? <CenterTable table={tables.payments} /> : null}
            {tables.brands ? <CenterTable table={tables.brands} /> : null}
          </div>

          {tables.tills ? <CenterTable table={tables.tills} /> : null}
          {tables.employees ? <CenterTable table={tables.employees} /> : null}
          {tables.days ? <CenterTable table={tables.days} /> : null}

          <div className="grid gap-4 lg:grid-cols-2">
            {tables.categories ? <CenterTable table={tables.categories} limit={SCREEN_ROWS} /> : null}
            {tables.items ? (
              <CenterTable table={tables.items} limit={SCREEN_ROWS} note={data.itemsTruncated ? tr('itemsTruncated') : undefined} />
            ) : null}
          </div>

          {tables.refunds ? (
            <CenterTable
              table={tables.refunds}
              limit={SCREEN_ROWS}
              note={tr('refundsNote', { count: data.refunds?.count ?? 0, total: formatCurrency(data.refunds?.total ?? 0) })}
            />
          ) : null}

          <div className="grid gap-4 lg:grid-cols-3">
            {tables.discounts ? <CenterTable table={tables.discounts} /> : null}
            {tables.tips ? <CenterTable table={tables.tips} /> : null}
            {tables.vat ? <CenterTable table={tables.vat} /> : null}
          </div>

          {tables.zs ? <CenterTable table={tables.zs} limit={SCREEN_ROWS} /> : null}

          <div className="grid gap-4 lg:grid-cols-2">
            <CenterTable table={tables.txTills} />
            {tables.failed ? (
              <CenterTable
                table={tables.failed}
                limit={SCREEN_ROWS}
                note={tr('failedNote', {
                  count: data.failedPayments?.summary.count ?? 0,
                  total: formatCurrency((data.failedPayments?.summary.totalAgorot ?? 0) / 100),
                })}
              />
            ) : null}
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <CenterTable table={tables.mealKinds} />
            {tables.kiosks ? <CenterTable table={tables.kiosks} /> : null}
          </div>
        </>
      ) : data ? (
        <p className="text-muted-foreground py-12 text-center text-sm">{tr('noRows')}</p>
      ) : null}
    </ReportPage>
  );
}
