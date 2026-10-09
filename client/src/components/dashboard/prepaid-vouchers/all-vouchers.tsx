'use client';

/**
 * "כל השוברים": vouchers across every batch under the page's filters (lib/prepaidVoucherFilters.ts),
 * found by service number, code or note, a page at a time from the server; each with its batch, for
 * whom, its state and its redemption history; the filtered rows exported to Excel — all of them,
 * never just the page on screen (lib/fetchAllPages.ts).
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { FileSpreadsheet, History, Loader2, Search } from 'lucide-react';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { downloadExcel, type ExcelSheet } from '@/lib/excelExport';
import { fetchAllPages } from '@/lib/fetchAllPages';
import { formatDate, formatDateTime, isoDate } from '@/lib/format';
import { quantityNumberText } from '@/lib/prepaidVoucherProducts';
import { filtersToQuery, type VoucherFilters, type VoucherState } from '@/lib/prepaidVoucherFilters';
import { fetchPrepaidVoucherRows, type PrepaidVoucherRow } from '@/lib/prepaidVouchersApi';
import { RedemptionHistory } from '@/components/dashboard/prepaid-vouchers/redemption-history';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

const PAGE = 100;
const EXPORT_PAGE = 1000;

export const STATE_STYLE: Record<VoucherState, string> = {
  open: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300',
  partial: 'bg-amber-100 text-amber-900 dark:bg-amber-950/40 dark:text-amber-300',
  redeemed: 'bg-muted text-muted-foreground',
  cancelled: 'bg-destructive/10 text-destructive',
  expired: 'bg-orange-100 text-orange-900 dark:bg-orange-950/40 dark:text-orange-300',
};

const when = (iso: string | null | undefined) => (isoDate(iso) ? formatDateTime(iso) : '');

export function remainingText(v: PrepaidVoucherRow): string {
  if (v.usesLeft != null) return `${v.usesLeft}/${v.usesPerVoucher ?? 1}`;
  return v.items.map((i) => `${quantityNumberText(i.remaining)}/${quantityNumberText(i.quantity)} ${i.name}`).join(' · ');
}

/** The rows as an Excel sheet (every row the filters match). */
export function voucherSheet(rows: PrepaidVoucherRow[], t: (k: string) => string, ts: (k: string) => string): ExcelSheet {
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
      v.serial, v.displayCode, v.batch.name, v.batch.customerName ?? '', ts(`states.${v.state}`), remainingText(v),
      v.lastRedeemedAt ?? null,
    ]),
  };
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
  const [offset, setOffset] = useState(0);
  const [openHistory, setOpenHistory] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
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

  const exportAll = async () => {
    setExporting(true);
    try {
      const rows = await fetchAllPages((page, size) => fetchPrepaidVoucherRows(query, size, (page - 1) * size), { pageSize: EXPORT_PAGE });
      await downloadExcel([voucherSheet(rows, t, ts)], `${t('sheet')} ${formatDate(new Date().toISOString())}`);
    } catch (err) {
      toast.error(axiosErrorToToastMessage(err, t('exportFailed')));
    } finally {
      setExporting(false);
    }
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
        <Button size="sm" variant="outline" onClick={() => void exportAll()} disabled={exporting || !list.data?.total}>
          {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileSpreadsheet className="h-4 w-4" />} {t('export')}
        </Button>
      </div>
      {list.isPending ? (
        <Skeleton className="h-40 w-full rounded-xl" />
      ) : list.isError ? (
        <p className="text-sm text-destructive">{axiosErrorToToastMessage(list.error, t('empty'))}</p>
      ) : (
        <ul className="divide-y rounded-xl bg-card ring-1 ring-foreground/10">
          {list.data!.items.map((v) => (
            <li key={v.id} className="space-y-2 px-3 py-2">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="w-14 font-semibold tabular-nums">#{v.serial}</span>
                <span dir="ltr" className="font-mono text-xs">{v.displayCode}</span>
                <span className={cn('rounded-full px-2 py-0.5 text-[11px]', STATE_STYLE[v.state])}>{ts(`states.${v.state}`)}</span>
                {showBatch ? (
                  <span className="min-w-0 truncate text-xs">
                    <span className="font-medium">{v.batch.name}</span>
                    {v.batch.customerName ? <span className="text-muted-foreground"> · {v.batch.customerName}</span> : null}
                    {v.batch.eventName ? <span className="text-muted-foreground"> · {v.batch.eventName}</span> : null}
                  </span>
                ) : null}
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{remainingText(v)}</span>
                {v.lastRedeemedAt ? <span className="text-xs text-muted-foreground">{when(v.lastRedeemedAt)}</span> : null}
                <Button size="icon-sm" variant="ghost" aria-label={t('history')} title={t('history')}
                  onClick={() => setOpenHistory(openHistory === v.id ? null : v.id)}>
                  <History className="h-4 w-4" />
                </Button>
              </div>
              {openHistory === v.id ? <RedemptionHistory voucherId={v.id} /> : null}
            </li>
          ))}
          {list.data!.items.length === 0 ? <li className="p-4 text-center text-sm text-muted-foreground">{t('empty')}</li> : null}
        </ul>
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
