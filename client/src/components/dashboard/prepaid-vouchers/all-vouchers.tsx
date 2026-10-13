'use client';

/**
 * "כל השוברים": vouchers across every batch under the page's filters (lib/prepaidVoucherFilters.ts),
 * found by service number, code or note, a page at a time from the server; each with its batch, for
 * whom, its state and its redemption history (a click on the row).
 *
 * On the report framework (P:\specs\reports-upgrade.md §5): a `ReportTable` (sort within the page,
 * columns, phone cards) and the framework's export bar (`prepaid-vouchers-vouchers`): Excel / PDF of
 * every row the filters match — all of them, never just the page on screen (lib/fetchAllPages.ts) —
 * print, export columns, the filters in words in the header.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import type { ExcelSheet } from '@/lib/excelExport';
import { fetchAllPages } from '@/lib/fetchAllPages';
import { DEFAULT_WEIGHT_UNIT, quantityNumberText } from '@/lib/prepaidVoucherProducts';
import { filtersToQuery, type VoucherFilters, type VoucherState } from '@/lib/prepaidVoucherFilters';
import { fetchPrepaidVoucherRows, type PrepaidVoucherRow } from '@/lib/prepaidVouchersApi';
import { RedemptionHistory } from '@/components/dashboard/prepaid-vouchers/redemption-history';
import {
  ReportExportBar,
  ReportTable,
  useReportExportScope,
  type ReportColumn,
  type ReportTableSpec,
} from '@/components/dashboard/report-framework';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { useVoucherFilterLines } from './voucher-filters';

const REPORT_KEY = 'prepaid-vouchers-vouchers';
const PAGE = 100;
const EXPORT_PAGE = 1000;

export const STATE_STYLE: Record<VoucherState, string> = {
  open: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300',
  partial: 'bg-amber-100 text-amber-900 dark:bg-amber-950/40 dark:text-amber-300',
  redeemed: 'bg-muted text-muted-foreground',
  cancelled: 'bg-destructive/10 text-destructive',
  expired: 'bg-orange-100 text-orange-900 dark:bg-orange-950/40 dark:text-orange-300',
};

/** `prepaidVouchers.allVouchers`'s translator (with values). */
type Tr = (key: string, values?: Record<string, string | number>) => string;

/** What is left, with its unit (the glossary's "נותרו"): "נותרו 3 מתוך 5 שימושים", "קפה: נותרו 2 מתוך 3". */
export function remainingText(v: PrepaidVoucherRow, t: Tr): string {
  if (v.usesLeft != null) return t('usesLeft', { left: v.usesLeft, total: v.usesPerVoucher ?? 1 });
  // Item groups (a punch card): one quota of items — "נותרו 44 מתוך 50 פריטים".
  if (!v.items.length && v.quota != null && v.remaining != null) return t('unitsLeft', { left: v.remaining, total: v.quota });
  return v.items.map((i) => t('itemLeft', {
    name: i.name,
    left: quantityNumberText(i.remaining),
    // By weight: "0.2 מתוך 0.5 ק״ג", as the batch's own voucher list.
    total: i.weighed ? `${quantityNumberText(i.quantity)} ${i.unitLabel || DEFAULT_WEIGHT_UNIT}` : quantityNumberText(i.quantity),
  })).join(' · ');
}

/** The rows as an Excel sheet (every row the filters match) — a batch's own voucher list exports it. */
export function voucherSheet(rows: PrepaidVoucherRow[], t: Tr, ts: (k: string) => string): ExcelSheet {
  return {
    name: t('sheet'),
    columns: [
      { header: t('serial'), kind: 'number' },
      { header: t('code') },
      { header: t('batch'), width: 28 },
      { header: t('forWhom'), width: 24 },
      { header: t('state') },
      { header: t('remaining'), width: 36 },
      { header: t('lastRedeemed'), kind: 'datetime' },
    ],
    rows: rows.map((v) => [
      v.serial, v.displayCode, v.batch.name, v.batch.customerName ?? '', ts(`states.${v.state}`), remainingText(v, t),
      v.lastRedeemedAt ?? null,
    ]),
  };
}

/** The list's columns, in the Excel's order; without [showBatch] the batch and for whom are in the export only. */
function voucherColumns(t: Tr, ts: (k: string) => string, showBatch: boolean): ReportColumn<PrepaidVoucherRow>[] {
  return [
    {
      key: 'serial',
      header: t('serial'),
      kind: 'number',
      required: true,
      value: (v) => v.serial,
      cell: (v) => <span className="font-semibold tabular-nums">#{v.serial}</span>,
    },
    { key: 'code', header: t('code'), value: (v) => v.displayCode, cell: (v) => <span dir="ltr" className="font-mono text-xs">{v.displayCode}</span> },
    {
      key: 'batch',
      header: t('batch'),
      width: 28,
      exportOnly: !showBatch,
      value: (v) => v.batch.name,
      cell: (v) => (
        <>
          <span className="font-medium">{v.batch.name}</span>
          {v.batch.eventName ? <span className="text-xs text-muted-foreground"> · {v.batch.eventName}</span> : null}
        </>
      ),
    },
    { key: 'forWhom', header: t('forWhom'), width: 24, exportOnly: !showBatch, value: (v) => v.batch.customerName ?? '' },
    {
      key: 'state',
      header: t('state'),
      value: (v) => ts(`states.${v.state}`),
      cell: (v) => <span className={cn('rounded-full px-2 py-0.5 text-[11px]', STATE_STYLE[v.state])}>{ts(`states.${v.state}`)}</span>,
    },
    {
      key: 'remaining',
      header: t('remaining'),
      width: 36,
      className: 'min-w-48 whitespace-normal text-xs text-muted-foreground',
      value: (v) => remainingText(v, t),
    },
    { key: 'lastRedeemed', header: t('lastRedeemed'), kind: 'datetime', value: (v) => v.lastRedeemedAt ?? null, className: 'text-xs text-muted-foreground' },
  ];
}

export function VoucherRowsTable({
  filters,
  onQuery,
  batchId,
  showBatch = true,
}: {
  filters: VoucherFilters;
  /** The words box (service number / code / note) lives in the filters' `q`. */
  onQuery: (q: string) => void;
  /** One batch's vouchers (its own page) — else every batch's. */
  batchId?: string;
  showBatch?: boolean;
}) {
  const t = useTranslations('prepaidVouchers.allVouchers');
  const ts = useTranslations('prepaidVouchers.scope');
  const tabs = useTranslations('prepaidVouchers.tabs');
  const [offset, setOffset] = useState(0);
  const query = filtersToQuery(batchId ? { ...filters, batchId: [batchId] } : filters);
  const key = query.toString();
  // A new filter starts at the first page again.
  const [lastKey, setLastKey] = useState(key);
  if (lastKey !== key) {
    setLastKey(key);
    setOffset(0);
  }
  const list = useQuery({
    queryKey: ['prepaid-voucher-rows', key, offset],
    queryFn: () => fetchPrepaidVoucherRows(query, PAGE, offset),
  });
  const scope = useReportExportScope();
  // The words box is the list's own search: in the export's filters line with the rest.
  const filterLines = useVoucherFilterLines(filters);

  const table: ReportTableSpec<PrepaidVoucherRow> = {
    id: 'main',
    title: t('sheet'),
    rows: list.data?.items ?? [],
    rowKey: (v) => v.id,
    emptyText: t('empty'),
    // A click on a voucher: its redemption history.
    expand: (v) => (
      <div className="p-3">
        <RedemptionHistory voucherId={v.id} />
      </div>
    ),
    columns: voucherColumns(t, ts, showBatch),
  };
  // Every row the filters match, never just this page.
  const loadAll = async (): Promise<ReportTableSpec<unknown>[]> => {
    const rows = await fetchAllPages((page, size) => fetchPrepaidVoucherRows(query, size, (page - 1) * size), { pageSize: EXPORT_PAGE });
    return [{ ...table, rows }] as ReportTableSpec<unknown>[];
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground ltr:left-2.5 rtl:right-2.5" aria-hidden />
          <Input value={filters.q} onChange={(e) => onQuery(e.target.value)} placeholder={ts('qVouchers')} aria-label={ts('qVouchers')}
            className="ps-8" dir="auto" />
        </div>
        <span className="text-xs text-muted-foreground">{list.data ? t('count', { n: list.data.total }) : null}</span>
      </div>
      <ReportExportBar
        reportKey={REPORT_KEY}
        title={tabs('vouchers')}
        tables={[table] as ReportTableSpec<unknown>[]}
        loadAll={loadAll}
        from={filters.from || null}
        to={filters.to || null}
        business={scope.business}
        place={scope.place}
        filterLines={filterLines}
        companyId={scope.companyId}
        companyName={scope.companyName}
        disabled={!list.data?.total}
      />
      {list.isPending ? (
        <Skeleton className="h-40 w-full rounded-xl" />
      ) : list.isError ? (
        <p className="text-sm text-destructive">{axiosErrorToToastMessage(list.error, t('loadError'))}</p>
      ) : (
        <ReportTable table={table} reportKey={REPORT_KEY} />
      )}
      {list.data && list.data.total > PAGE ? (
        <div className="flex items-center justify-center gap-2">
          <Button size="sm" variant="outline" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>{t('previous')}</Button>
          <span className="text-xs tabular-nums text-muted-foreground">
            {offset + 1}–{Math.min(offset + PAGE, list.data.total)} / {list.data.total}
          </span>
          <Button size="sm" variant="outline" disabled={offset + PAGE >= list.data.total} onClick={() => setOffset(offset + PAGE)}>{t('next')}</Button>
        </div>
      ) : null}
    </div>
  );
}
