'use client';

/**
 * The report of one prepaid voucher batch (שוברי הפקה), over its whole life:
 * vouchers by state, the goods (issued / taken / forfeited / outstanding / void), and the
 * redemptions by hour, day, shop, till and employee. Reversed redemptions — a payment
 * abandoned at the till — are left out by the server. Excel / print / PDF through the
 * shared report toolbar.
 */

import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import {
  fetchPrepaidBatchReport,
  type PrepaidBatchReport,
  type PrepaidReportGroup,
  type PrepaidVoucherBatch,
} from '@/lib/prepaidVouchersApi';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { formatDate, formatHour } from '@/lib/format';
import type { ExcelSheet } from '@/lib/excelExport';
import { ReportExportToolbar } from '@/components/dashboard/report-export-toolbar';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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

const NUM = 'text-end tabular-nums';

function Counts({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="rounded-lg border px-3 py-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`text-xl font-semibold tabular-nums ${tone ?? ''}`}>{value}</p>
    </div>
  );
}

function GroupTable({ title, rows, nameHeader, unknown, withShop }: {
  title: string;
  rows: PrepaidReportGroup[];
  nameHeader: string;
  unknown: string;
  withShop?: boolean;
}) {
  const t = useTranslations('prepaidVouchers.report');
  return (
    <Card className="break-inside-avoid">
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('noRedemptions')}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{nameHeader}</TableHead>
                {withShop ? <TableHead>{t('col.shop')}</TableHead> : null}
                <TableHead className="text-end">{t('col.redemptions')}</TableHead>
                <TableHead className="text-end">{t('col.vouchers')}</TableHead>
                <TableHead className="text-end">{t('col.units')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.key ?? '—'}>
                  <TableCell>{r.name || unknown}</TableCell>
                  {withShop ? <TableCell>{r.shopName || '—'}</TableCell> : null}
                  <TableCell className={NUM}>{r.redemptions}</TableCell>
                  <TableCell className={NUM}>{r.vouchers}</TableCell>
                  <TableCell className={NUM}>{r.units}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

/** Every table of the report as Excel sheets, in the order the page shows them. */
function sheetsOf(
  r: PrepaidBatchReport,
  t: ReturnType<typeof useTranslations>,
  labels: { unknownTill: string; unknownShop: string; unknownEmployee: string },
): ExcelSheet[] {
  const counts = [
    { header: t('col.redemptions'), kind: 'number' as const },
    { header: t('col.vouchers'), kind: 'number' as const },
    { header: t('col.units'), kind: 'number' as const },
  ];
  const group = (name: string, header: string, rows: PrepaidReportGroup[], unknown: string, withShop = false): ExcelSheet => ({
    name,
    columns: [{ header }, ...(withShop ? [{ header: t('col.shop') }] : []), ...counts],
    rows: rows.map((g) => [g.name || unknown, ...(withShop ? [g.shopName || ''] : []), g.redemptions, g.vouchers, g.units]),
  });
  const v = r.vouchers;
  return [
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
        [t('col.units'), r.totals.units],
      ],
    },
    {
      name: t('sheet.products'),
      columns: [
        { header: t('col.product'), width: 28 },
        { header: t('col.perVoucher'), kind: 'number' },
        { header: t('col.issued'), kind: 'number' },
        { header: t('col.taken'), kind: 'number' },
        { header: t('col.forfeited'), kind: 'number' },
        { header: t('col.outstanding'), kind: 'number' },
        { header: t('col.void'), kind: 'number' },
      ],
      rows: r.products.map((p) => [p.name ?? '', p.perVoucher, p.issued, p.taken, p.forfeited, p.outstanding, p.void]),
    },
    {
      name: t('sheet.byDay'),
      columns: [
        { header: t('col.date'), kind: 'date' },
        ...counts,
        ...r.products.map((p) => ({ header: p.name ?? '', kind: 'number' as const })),
      ],
      rows: r.byDay.map((d) => [
        d.date, d.redemptions, d.vouchers, d.units,
        ...r.products.map((p) => d.products.find((x) => x.productId === p.productId)?.quantity ?? 0),
      ]),
      totals: [
        t('total'), r.totals.redemptions, r.totals.vouchers, r.totals.units,
        ...r.products.map((p) => p.taken),
      ],
    },
    {
      name: t('sheet.byHour'),
      columns: [{ header: t('col.hour') }, ...counts],
      rows: r.byHour.map((h) => [formatHour(h.hour), h.redemptions, h.vouchers, h.units]),
    },
    group(t('sheet.byShop'), t('col.shop'), r.byShop, labels.unknownShop),
    group(t('sheet.byTill'), t('col.till'), r.byTill, labels.unknownTill, true),
    group(t('sheet.byEmployee'), t('col.employee'), r.byEmployee, labels.unknownEmployee),
  ];
}

export function PrepaidBatchReportView({ batch }: { batch: PrepaidVoucherBatch }) {
  const t = useTranslations('prepaidVouchers.report');
  const q = useQuery({
    queryKey: ['prepaid-voucher-report', batch.id],
    queryFn: () => fetchPrepaidBatchReport(batch.id),
  });
  const labels = {
    unknownTill: t('unknownTill'),
    unknownShop: t('unknownShop'),
    unknownEmployee: t('unknownEmployee'),
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

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2 print:hidden">
        <p className="text-xs text-muted-foreground">{t('reversedNote')}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => void q.refetch()} disabled={q.isFetching}>
            <RefreshCw className={`h-4 w-4 ${q.isFetching ? 'animate-spin' : ''}`} aria-hidden />
            {t('refresh')}
          </Button>
          <ReportExportToolbar
            title={title}
            scopeLabel={batch.shops.length ? batch.shops.map((s) => s.name).join(', ') : batch.companyName ?? ''}
            getSheets={() => sheetsOf(r, t, labels)}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <Counts label={t('vouchers.total')} value={r.vouchers.total} />
        <Counts label={t('vouchers.active')} value={r.vouchers.active} />
        <Counts label={t('vouchers.partiallyUsed')} value={r.vouchers.partiallyUsed} tone="text-amber-700 dark:text-amber-300" />
        <Counts label={t('vouchers.used')} value={r.vouchers.used} tone="text-emerald-700 dark:text-emerald-300" />
        <Counts label={t('vouchers.cancelled')} value={r.vouchers.cancelled} tone="text-destructive" />
      </div>

      <Card className="break-inside-avoid">
        <CardHeader>
          <CardTitle className="text-base">{t('productsTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('col.product')}</TableHead>
                <TableHead className="text-end">{t('col.perVoucher')}</TableHead>
                <TableHead className="text-end">{t('col.issued')}</TableHead>
                <TableHead className="text-end">{t('col.taken')}</TableHead>
                <TableHead className="text-end">{t('col.forfeited')}</TableHead>
                <TableHead className="text-end">{t('col.outstanding')}</TableHead>
                <TableHead className="text-end">{t('col.void')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {r.products.map((p) => (
                <TableRow key={p.productId}>
                  <TableCell>{p.name}</TableCell>
                  <TableCell className={NUM}>{p.perVoucher}</TableCell>
                  <TableCell className={NUM}>{p.issued}</TableCell>
                  <TableCell className={`${NUM} font-semibold`}>{p.taken}</TableCell>
                  <TableCell className={NUM}>{p.forfeited}</TableCell>
                  <TableCell className={NUM}>{p.outstanding}</TableCell>
                  <TableCell className={NUM}>{p.void}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="break-inside-avoid">
          <CardHeader>
            <CardTitle className="text-base">{t('byDay')}</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            {r.byDay.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('noRedemptions')}</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('col.date')}</TableHead>
                    <TableHead className="text-end">{t('col.redemptions')}</TableHead>
                    <TableHead className="text-end">{t('col.vouchers')}</TableHead>
                    {r.products.map((p) => (
                      <TableHead key={p.productId} className="text-end">{p.name}</TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {r.byDay.map((d) => (
                    <TableRow key={d.date}>
                      <TableCell>{formatDate(d.date)}</TableCell>
                      <TableCell className={NUM}>{d.redemptions}</TableCell>
                      <TableCell className={NUM}>{d.vouchers}</TableCell>
                      {r.products.map((p) => (
                        <TableCell key={p.productId} className={NUM}>
                          {d.products.find((x) => x.productId === p.productId)?.quantity ?? 0}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
                <TableFooter>
                  <TableRow>
                    <TableCell>{t('total')}</TableCell>
                    <TableCell className={NUM}>{r.totals.redemptions}</TableCell>
                    <TableCell className={NUM}>{r.totals.vouchers}</TableCell>
                    {r.products.map((p) => (
                      <TableCell key={p.productId} className={NUM}>{p.taken}</TableCell>
                    ))}
                  </TableRow>
                </TableFooter>
              </Table>
            )}
          </CardContent>
        </Card>

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
                    <span className="w-28 shrink-0 text-end text-xs tabular-nums text-muted-foreground">
                      {t('hourLine', { units: h.units, redemptions: h.redemptions })}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <GroupTable title={t('byShop')} rows={r.byShop} nameHeader={t('col.shop')} unknown={labels.unknownShop} />
        <GroupTable title={t('byTill')} rows={r.byTill} nameHeader={t('col.till')} unknown={labels.unknownTill} withShop />
        <GroupTable title={t('byEmployee')} rows={r.byEmployee} nameHeader={t('col.employee')} unknown={labels.unknownEmployee} />
      </div>
    </div>
  );
}
