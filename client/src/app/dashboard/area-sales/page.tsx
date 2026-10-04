'use client';

/**
 * Sales by area — one shop's takings split by the areas its tills are grouped into.
 *
 * Every sale counts under the area stamped on its shift when the shift was created,
 * never the till's area today: moving a till does not rewrite past totals. Sales of
 * shifts with no area (and sales with no shift) make the "no area" row. The rows sum
 * to the shop's total for the window — the server guarantees it, the page only shows
 * it. Archived areas still appear when they had sales in the window.
 */

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { fetchSalesByArea } from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { usePageScope } from '@/lib/scope';
import { formatCurrency } from '@/lib/format';
import { daysBackIso, todayIso } from '@/lib/reportWindow';
import { downloadCsv, toCsv } from '@/lib/csv';
import type { SalesByAreaReport, SalesByAreaRow } from '@/lib/types';
import { ScopeGate } from '@/components/dashboard/scope-gate';
import { ReportErrorState } from '@/components/dashboard/report-window-summary';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ReportExportToolbar } from '@/components/dashboard/report-export-toolbar';

const MONEY_COLS = ['gross', 'discounts', 'net', 'refunds', 'cash', 'card', 'other', 'tips'] as const;
const COLS = 2 + MONEY_COLS.length;

export default function SalesByAreaPage() {
  const t = useTranslations('areaSales');
  const tc = useTranslations('common');

  // One shop at a time: an area belongs to one shop, and the rows add up to that shop.
  const { scope, resolution, effective } = usePageScope({ maxLevel: 'shop', minLevel: 'shop' });
  const shopId = effective.shopId;
  const shopName = scope.shop?.name ?? '';

  const [from, setFrom] = useState(daysBackIso(6));
  const [to, setTo] = useState(todayIso());
  const [applied, setApplied] = useState<{ from: string; to: string } | null>(null);
  const rangeInvalid = !from || !to || from > to;

  const params = useMemo(
    () => (applied && shopId ? { shopId, dateFrom: applied.from, dateTo: applied.to } : null),
    [applied, shopId],
  );

  const { data, isLoading, isFetching, isError, error } = useQuery<SalesByAreaReport>({
    queryKey: ['report-sales-by-area', params],
    queryFn: () => fetchSalesByArea(params!),
    enabled: params !== null,
  });

  const rowName = (row: Pick<SalesByAreaRow, 'areaId' | 'areaName'>) =>
    row.areaId === null ? t('unassigned') : (row.areaName ?? row.areaId);

  const exportCsv = () => {
    if (!data || !params) return;
    const header = [
      t('col.area'),
      t('col.archived'),
      t('col.transactions'),
      ...MONEY_COLS.map((c) => t(`col.${c}`)),
    ];
    const rows = data.rows.map((r) => [
      rowName(r),
      r.archived ? tc('yes') : '',
      r.transactionsCount,
      ...MONEY_COLS.map((c) => r[c]),
    ]);
    rows.push([
      t('totals'),
      '',
      data.totals.transactionsCount,
      ...MONEY_COLS.map((c) => data.totals[c]),
    ]);
    const safeShop = shopName.replace(/[\\/:*?"<>|]+/g, '_').trim() || params.shopId;
    downloadCsv(`sales-by-area_${safeShop}_${params.dateFrom}_${params.dateTo}.csv`, toCsv(header, rows));
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
      </div>

      <ScopeGate resolution={resolution}>
        <div className="rounded-lg border bg-card p-4 space-y-3 print:hidden">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label htmlFor="area-sales-from" className="text-xs">
                {t('from')}
              </Label>
              <Input
                id="area-sales-from"
                type="date"
                value={from}
                max={to || undefined}
                aria-invalid={rangeInvalid || undefined}
                onChange={(e) => setFrom(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="area-sales-to" className="text-xs">
                {t('to')}
              </Label>
              <Input
                id="area-sales-to"
                type="date"
                value={to}
                min={from || undefined}
                aria-invalid={rangeInvalid || undefined}
                onChange={(e) => setTo(e.target.value)}
              />
            </div>
            <Button disabled={rangeInvalid || isFetching} onClick={() => setApplied({ from, to })}>
              {isFetching ? t('running') : t('run')}
            </Button>
            {data && !isError ? (
              <Button variant="outline" onClick={exportCsv}>
                <Download className="h-4 w-4 me-1" aria-hidden />
                {t('exportCsv')}
              </Button>
            ) : null}
          </div>
          {from && to && from > to ? (
            <p className="text-destructive text-xs">{t('rangeInvalid')}</p>
          ) : null}
          <p className="text-muted-foreground text-xs">{t('stampHint')}</p>
        </div>

        {data && !isError && params ? (
          <ReportExportToolbar
            title={t('title')}
            from={params.dateFrom}
            to={params.dateTo}
            scopeLabel={shopName}
            getSheets={() => ({
              name: t('title'),
              columns: [
                { header: t('col.area') },
                { header: t('col.archived'), width: 8 },
                { header: t('col.transactions'), kind: 'number' },
                ...MONEY_COLS.map((c) => ({ header: t(`col.${c}`), kind: 'money' as const })),
              ],
              rows: data.rows.map((r) => [
                rowName(r), r.archived ? tc('yes') : null, r.transactionsCount, ...MONEY_COLS.map((c) => r[c]),
              ]),
              totals: [t('totals'), null, data.totals.transactionsCount, ...MONEY_COLS.map((c) => data.totals[c])],
            })}
          />
        ) : null}
        {!applied ? (
          <p className="text-muted-foreground py-12 text-center text-sm">{t('selectFilters')}</p>
        ) : isLoading ? (
          <Skeleton className="h-64 w-full" />
        ) : isError ? (
          <ReportErrorState message={axiosErrorToToastMessage(error, tc('error'))} />
        ) : data ? (
          <div className="rounded-lg border bg-card overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('col.area')}</TableHead>
                  <TableHead className="text-end">{t('col.transactions')}</TableHead>
                  {MONEY_COLS.map((c) => (
                    <TableHead key={c} className="text-end">
                      {t(`col.${c}`)}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={COLS} className="text-muted-foreground py-10 text-center">
                      {t('noRows')}
                    </TableCell>
                  </TableRow>
                ) : (
                  data.rows.map((row) => (
                    <TableRow key={row.areaId ?? '__none__'}>
                      <TableCell className="font-medium">
                        <span className="inline-flex flex-wrap items-center gap-2">
                          <span className={row.areaId === null ? 'text-muted-foreground' : undefined}>
                            {rowName(row)}
                          </span>
                          {row.archived ? <Badge variant="outline">{t('archivedBadge')}</Badge> : null}
                        </span>
                      </TableCell>
                      <TableCell className="text-end tabular-nums">{row.transactionsCount}</TableCell>
                      {MONEY_COLS.map((c) => (
                        <TableCell
                          key={c}
                          className={`text-end tabular-nums ${c === 'net' ? 'font-semibold' : ''}`}
                        >
                          {formatCurrency(row[c])}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))
                )}
              </TableBody>
              {data.rows.length > 0 ? (
                <TableFooter>
                  <TableRow>
                    <TableCell className="font-semibold">{t('totals')}</TableCell>
                    <TableCell className="text-end font-medium tabular-nums">
                      {data.totals.transactionsCount}
                    </TableCell>
                    {MONEY_COLS.map((c) => (
                      <TableCell
                        key={c}
                        className={`text-end tabular-nums ${c === 'net' ? 'font-bold' : 'font-medium'}`}
                      >
                        {formatCurrency(data.totals[c])}
                      </TableCell>
                    ))}
                  </TableRow>
                </TableFooter>
              ) : null}
            </Table>
          </div>
        ) : null}
      </ScopeGate>
    </div>
  );
}
