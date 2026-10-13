'use client';

/**
 * "מימושים לפי קופה": one row per till under the page's filters — its shop, vouchers and items
 * redeemed, the value per accounting mode (a deduction, a payment, memo value — never "a discount"),
 * what is flagged; redemptions over time by day or by hour; a till's redemptions (time, voucher,
 * batch, items, employee) under its row.
 *
 * On the report framework (P:\specs\reports-upgrade.md §5): the filters stay the vouchers' own
 * (lib/prepaidVoucherFilters.ts, already in the URL); the tables are `ReportTable`s (sort, columns,
 * phone cards, totals) and the export bar is the framework's (`prepaid-vouchers-tills`): Excel —
 * the tills, then every redemption the filters match (all pages) — the tills' PDF, print, and the
 * export columns, with the filters in words in the header.
 *
 * Top-ups, refusals, overrides and offline redemptions are not recorded yet (reserve → confirm, the
 * override audit and offline sync come later): their columns say so rather than show a 0.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { fetchAllPages } from '@/lib/fetchAllPages';
import { formatShortDate } from '@/lib/format';
import { agorotText, filtersToQuery, type VoucherFilters } from '@/lib/prepaidVoucherFilters';
import {
  fetchPrepaidRedemptions,
  fetchPrepaidTillReport,
  type PrepaidRedemptionRow,
  type PrepaidTillRow,
} from '@/lib/prepaidVouchersApi';
import { CHART, ChartTokens, Segmented, tooltipStyle } from '@/components/dashboard/insights/ios';
import {
  ReportExportBar,
  ReportTable,
  useReportExportScope,
  type ReportColumn,
  type ReportTableSpec,
} from '@/components/dashboard/report-framework';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { RedemptionFlags, useFlagTexts } from './redemption-flags';
import { useVoucherFilterLines } from './voucher-filters';

const REPORT_KEY = 'prepaid-vouchers-tills';
const PAGE = 100;
const MODES = ['discount', 'payment', 'zero'] as const;
/** The value columns' keys (no "." in a main table's key: lib/reportColumns.ts `unqualify`). */
const MODE_KEY: Record<(typeof MODES)[number], string> = { discount: 'valueDiscount', payment: 'valuePayment', zero: 'valueZero' };

const shekels = (agorot: number) => Math.round(agorot) / 100;

type Tr = ReturnType<typeof useTranslations>;

/** What the redemption took: "2× קפה, 1× מאפה", or a discount's uses ("3 שימושים"). */
function itemsText(r: PrepaidRedemptionRow, t: (key: string, values?: Record<string, number>) => string): string {
  if (r.uses) return t('usesN', { n: r.uses });
  return r.items.map((i) => `${i.quantity}× ${i.name ?? ''}`).join(', ');
}

/** A redemption's columns: on screen (one till's, without the till) and in the Excel sheet (every till's). */
function redemptionColumns(
  t: Tr,
  flagTexts: (flags: readonly string[] | null | undefined) => string[],
  withTill: boolean,
): ReportColumn<PrepaidRedemptionRow>[] {
  return [
    { key: 'time', header: t('time'), kind: 'datetime', required: true, value: (r) => r.redeemedAt, className: 'tabular-nums' },
    ...(withTill ? [{ key: 'till', header: t('till'), width: 18, value: (r: PrepaidRedemptionRow) => r.machineName ?? '' }] : []),
    {
      key: 'voucher',
      header: t('voucher'),
      value: (r) => (r.serial ? `#${r.serial} ${r.displayCode ?? ''}` : ''),
      cell: (r) => (
        <>
          {r.serial ? <span className="font-medium">#{r.serial}</span> : null}{' '}
          <span dir="ltr" className="font-mono text-xs text-muted-foreground">{r.displayCode}</span>
        </>
      ),
    },
    {
      key: 'batch',
      header: t('batch'),
      width: 26,
      className: 'whitespace-normal',
      value: (r) => r.batch.name,
      cell: (r) => (
        <>
          {r.batch.name}
          {r.batch.customerName ? <span className="text-muted-foreground"> · {r.batch.customerName}</span> : null}
        </>
      ),
    },
    {
      key: 'items',
      header: t('itemsCol'),
      width: 36,
      className: 'min-w-48 whitespace-normal',
      value: (r) => itemsText(r, t),
      cell: (r) => (
        <>
          {itemsText(r, t)}
          <RedemptionFlags flags={r.flags} />
        </>
      ),
    },
    { key: 'employee', header: t('employee'), width: 16, value: (r) => r.employeeName ?? '' },
    {
      key: 'value',
      header: t('valueCol'),
      kind: 'money',
      value: (r) => shekels(r.value),
      cell: (r) => <span title={t(`basis.${r.valueBasis}`)}>{agorotText(r.value)}</span>,
    },
    { key: 'flags', header: t('flagsCol'), width: 26, exportOnly: true, value: (r) => flagTexts(r.flags).join(', ') },
  ];
}

export function TillsReport({ filters }: { filters: VoucherFilters }) {
  const t = useTranslations('prepaidVouchers.tills');
  const flagTexts = useFlagTexts();
  const [bucket, setBucket] = useState<'day' | 'hour'>('day');
  const query = filtersToQuery(filters);
  const key = query.toString();
  const report = useQuery({
    queryKey: ['prepaid-till-report', key, bucket],
    queryFn: () => fetchPrepaidTillReport(query, bucket),
  });
  const rows = report.data?.items ?? [];
  const totals = report.data?.totals;
  const usedModes = MODES.filter((m) => rows.some((r) => r.value[m] !== 0));
  const modes = usedModes.length ? usedModes : (['discount'] as const);
  const notRecorded = <span className="text-xs text-muted-foreground">{t('notRecorded')}</span>;
  const scope = useReportExportScope();
  const filterLines = useVoucherFilterLines(filters);

  const tills: ReportTableSpec<PrepaidTillRow> = {
    id: 'main',
    title: t('sheetTills'),
    sheetHeading: [t('valueNote')],
    rows,
    rowKey: (r) => r.machineId ?? 'none',
    totalsLabel: t('total'),
    emptyText: t('empty'),
    // A click on a till: its redemptions, under its row.
    expand: (r) => <TillRedemptions till={r} filters={filters} />,
    columns: [
      { key: 'till', header: t('till'), required: true, width: 22, className: 'font-medium', value: (r) => r.name ?? t('unknownTill') },
      { key: 'shop', header: t('shop'), width: 18, className: 'text-muted-foreground', value: (r) => r.shopName ?? '' },
      { key: 'redemptions', header: t('redemptions'), kind: 'number', value: (r) => r.redemptions, total: totals?.redemptions },
      { key: 'vouchers', header: t('vouchers'), kind: 'number', value: (r) => r.vouchers, total: totals?.vouchers },
      { key: 'items', header: t('items'), kind: 'number', value: (r) => r.items, total: totals?.items },
      ...modes.map(
        (m): ReportColumn<PrepaidTillRow> => ({
          key: MODE_KEY[m],
          header: t(`value.${m}`),
          kind: 'money',
          value: (r) => shekels(r.value[m]),
          cell: (r) => agorotText(r.value[m]),
          total: totals ? shekels(totals.value[m]) : undefined,
          totalCell: totals ? agorotText(totals.value[m]) : undefined,
        }),
      ),
      {
        key: 'valueTotal',
        header: t('value.total'),
        kind: 'money',
        exportOnly: true,
        value: (r) => shekels(r.value.total),
        total: totals ? shekels(totals.value.total) : undefined,
      },
      {
        key: 'topUp',
        header: t('topUp'),
        kind: 'money',
        screenOnly: true,
        value: (r) => (r.topUp == null ? null : shekels(r.topUp)),
        cell: (r) => (r.topUp == null ? notRecorded : agorotText(r.topUp)),
      },
      {
        key: 'refusals',
        header: t('refusals'),
        kind: 'number',
        screenOnly: true,
        value: (r) => r.refusals,
        cell: (r) => (r.refusals == null ? notRecorded : r.refusals),
      },
      {
        key: 'overrides',
        header: t('overrides'),
        kind: 'number',
        screenOnly: true,
        value: (r) => r.overrides,
        cell: (r) => (r.overrides == null ? notRecorded : r.overrides),
      },
      {
        key: 'offlinePending',
        header: t('offlinePending'),
        kind: 'number',
        screenOnly: true,
        value: (r) => r.offlinePending,
        cell: (r) => (r.offlinePending == null ? notRecorded : r.offlinePending),
      },
      { key: 'flagged', header: t('flagged'), kind: 'number', value: (r) => r.flagged, cell: (r) => r.flagged || '' },
    ],
  };

  // Every redemption the filters match (all pages), the Excel's second sheet. Not on screen.
  const redemptions: ReportTableSpec<PrepaidRedemptionRow> = {
    id: 'redemptions',
    title: t('sheetRedemptions'),
    rows: [],
    rowKey: (r) => r.id,
    columns: redemptionColumns(t, flagTexts, true),
  };
  const loadAll = async (): Promise<ReportTableSpec<unknown>[]> => {
    const all = await fetchAllPages((page, size) => fetchPrepaidRedemptions(query, size, (page - 1) * size), { pageSize: 1000 });
    return [tills, { ...redemptions, rows: all }] as ReportTableSpec<unknown>[];
  };

  return (
    <div className="space-y-3">
      <ReportExportBar
        reportKey={REPORT_KEY}
        title={t('title')}
        tables={[tills, redemptions] as ReportTableSpec<unknown>[]}
        loadAll={loadAll}
        from={filters.from || null}
        to={filters.to || null}
        business={scope.business}
        place={scope.place}
        filterLines={filterLines}
        companyId={scope.companyId}
        companyName={scope.companyName}
        disabled={!report.data || rows.length === 0}
      />
      {report.data?.testBatchesExcluded ? (
        <p className="text-xs text-muted-foreground">{t('testExcluded', { count: report.data.testBatchesExcluded })}</p>
      ) : null}
      {report.isPending ? (
        <Skeleton className="h-48 w-full rounded-xl" />
      ) : report.isError ? (
        <p className="text-sm text-destructive">{axiosErrorToToastMessage(report.error, t('loadError'))}</p>
      ) : rows.length === 0 ? (
        <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <>
          <div className="rounded-xl bg-card p-3 ring-1 ring-foreground/10">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-medium">{t('chart')}</h3>
              <Segmented value={bucket} onChange={setBucket} className="w-44 print:hidden"
                options={[{ id: 'day', label: t('byDay') }, { id: 'hour', label: t('byHour') }]} />
            </div>
            <ChartTokens>
              <div className="h-56" dir="ltr">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={report.data!.series} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid vertical={false} stroke={CHART.grid} />
                    <XAxis dataKey="key" tick={{ fontSize: 11 }}
                      tickFormatter={(k) => (bucket === 'hour' ? `${String(k).padStart(2, '0')}:00` : formatShortDate(String(k)))} />
                    <YAxis allowDecimals={false} width={32} tick={{ fontSize: 11 }} />
                    <Tooltip contentStyle={tooltipStyle}
                      labelFormatter={(k) => (bucket === 'hour' ? `${String(k).padStart(2, '0')}:00` : formatShortDate(String(k)))}
                      formatter={(v) => [String(v), t('redemptions')]} />
                    <Bar dataKey="redemptions" fill={CHART.accent} radius={[4, 4, 0, 0]} maxBarSize={24} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </ChartTokens>
          </div>

          <ReportTable table={tills} reportKey={REPORT_KEY} />
          <p className="text-xs text-muted-foreground">{t('valueNote')}</p>
          <p className="text-xs text-muted-foreground">{t('notRecordedNote')}</p>
        </>
      )}
    </div>
  );
}

/** One till's redemptions, a page at a time — under its row in the tills table. */
function TillRedemptions({ till, filters }: { till: PrepaidTillRow; filters: VoucherFilters }) {
  const t = useTranslations('prepaidVouchers.tills');
  const flagTexts = useFlagTexts();
  const [offset, setOffset] = useState(0);
  const query = filtersToQuery({ ...filters, machineId: till.machineId ? [till.machineId] : [] });
  const key = query.toString();
  const list = useQuery({
    queryKey: ['prepaid-redemptions', key, offset],
    queryFn: () => fetchPrepaidRedemptions(query, PAGE, offset),
  });
  const table: ReportTableSpec<PrepaidRedemptionRow> = {
    id: 'till',
    title: t('details', { name: till.name ?? t('unknownTill') }),
    rows: list.data?.items ?? [],
    rowKey: (r) => r.id,
    columns: redemptionColumns(t, flagTexts, false),
  };
  return (
    <div className="space-y-2 p-3">
      {list.isPending ? (
        <Skeleton className="h-24 w-full" />
      ) : list.isError ? (
        <p className="text-sm text-destructive">{axiosErrorToToastMessage(list.error, t('loadError'))}</p>
      ) : (
        <ReportTable table={table} reportKey={REPORT_KEY} />
      )}
      {list.data && list.data.total > PAGE ? (
        <div className="flex items-center justify-center gap-2 print:hidden">
          <Button size="sm" variant="outline" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>‹</Button>
          <span className="text-xs tabular-nums text-muted-foreground">{offset + 1}–{Math.min(offset + PAGE, list.data.total)} / {list.data.total}</span>
          <Button size="sm" variant="outline" disabled={offset + PAGE >= list.data.total} onClick={() => setOffset(offset + PAGE)}>›</Button>
        </div>
      ) : null}
    </div>
  );
}
