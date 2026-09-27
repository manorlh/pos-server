'use client';

/**
 * One Z report (דו״ח Z): the shop's figures, then each register's section, then the
 * shifts it took — each linking to that shift's X.
 *
 * The header (business name, VAT id, address, branch) is the one frozen on the Z when
 * it was built. It is shown as stored: a Z is a fiscal document, and re-deriving it from
 * today's settings would quietly rewrite every Z after a rename or a move.
 *
 * "Print" opens the browser's print dialog on an A4 layout (`ZPrintDocument`) that is
 * hidden on screen; "save as PDF" there gives the file.
 */

import { use, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, FileBarChart, Printer } from 'lucide-react';
import { fetchZReport } from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { usePageScope } from '@/lib/scope';
import { formatCurrency, formatDate, formatDateTime } from '@/lib/format';
import type { Shift, ZReportDetail, ZReportMachineSection } from '@/lib/types';
import { ReportErrorState } from '@/components/dashboard/report-window-summary';
import {
  CountedCash,
  Fact,
  MoneyRow,
  OverShort,
  PaymentBreakdownRows,
  ShiftBadges,
  useShiftLabel,
} from '@/components/dashboard/shifts/shift-parts';
import { ZBadges } from '@/components/dashboard/z-report/z-badges';
import { ZPrintDocument } from '@/components/dashboard/z-report/z-print-document';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

function ShiftTable({ shifts }: { shifts: Shift[] }) {
  const t = useTranslations('shifts');
  const shiftLabel = useShiftLabel();
  if (shifts.length === 0) return null;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t('col.shift')}</TableHead>
          <TableHead>{t('col.businessDate')}</TableHead>
          <TableHead>{t('col.opened')}</TableHead>
          <TableHead>{t('col.closed')}</TableHead>
          <TableHead className="text-end">{t('col.sales')}</TableHead>
          <TableHead className="text-end">{t('col.counted')}</TableHead>
          <TableHead className="text-end">{t('col.overShort')}</TableHead>
          <TableHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        {shifts.map((s) => (
          <TableRow key={s.id}>
            <TableCell className="font-medium">
              <Link href={`/dashboard/shifts/${s.id}`} className="hover:underline">
                {shiftLabel(s)}
              </Link>
            </TableCell>
            <TableCell>{formatDate(s.businessDate)}</TableCell>
            <TableCell className="text-xs">
              {formatDateTime(s.openedAt)}
              {s.openedByName ? <span className="text-muted-foreground"> · {s.openedByName}</span> : null}
            </TableCell>
            <TableCell className="text-xs">
              {formatDateTime(s.closedAt)}
              <span className="text-muted-foreground">
                {s.unattended ? ` · ${t('closedRemotely')}` : s.closedByName ? ` · ${s.closedByName}` : ''}
              </span>
            </TableCell>
            <TableCell className="text-end">{formatCurrency(s.serverTotals?.totalSales)}</TableCell>
            <TableCell className="text-end">
              <CountedCash value={s.countedCash} />
            </TableCell>
            <TableCell className="text-end">
              <OverShort value={s.discrepancy} />
            </TableCell>
            <TableCell>
              <ShiftBadges shift={s} showStatus={false} showZ={false} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function TillCard({ s, shifts }: { s: ZReportMachineSection; shifts: Shift[] }) {
  const t = useTranslations('zReports');
  const uncounted = (s.uncountedShiftCount ?? 0) > 0;
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <CardTitle className="text-base">
            <Link href={`/dashboard/machines/${s.machineId}`} className="hover:underline">
              {s.posNumber ? t('tillNumbered', { number: s.posNumber }) : (s.machineName ?? s.machineId)}
            </Link>
            {s.posNumber && s.machineName ? (
              <span className="text-muted-foreground ms-2 text-sm font-normal">{s.machineName}</span>
            ) : null}
          </CardTitle>
          <span className="text-muted-foreground text-xs">
            {s.firstShiftSequence != null && s.lastShiftSequence != null
              ? t('till.shiftRange', {
                  count: s.shiftCount ?? 0,
                  first: s.firstShiftSequence,
                  last: s.lastShiftSequence,
                })
              : t('till.shiftCount', { count: s.shiftCount ?? 0 })}
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Fact label={t('till.firstDocument')}>
            <span className="font-mono text-xs" dir="ltr">{s.firstDocumentNumber ?? '—'}</span>
          </Fact>
          <Fact label={t('till.lastDocument')}>
            <span className="font-mono text-xs" dir="ltr">{s.lastDocumentNumber ?? '—'}</span>
          </Fact>
          <Fact label={t('till.documents')}>
            {t('till.documentsSplit', {
              sales: s.salesCount ?? 0,
              credit: s.creditNotesCount ?? 0,
              other: s.nonSaleDocumentsCount ?? 0,
            })}
          </Fact>
          <Fact label={t('till.flags')}>
            {(s.reconstructedShiftCount ?? 0) + (s.unattendedShiftCount ?? 0) === 0
              ? '—'
              : [
                  (s.reconstructedShiftCount ?? 0) > 0
                    ? t('till.reconstructed', { count: s.reconstructedShiftCount ?? 0 })
                    : null,
                  (s.unattendedShiftCount ?? 0) > 0
                    ? t('till.unattended', { count: s.unattendedShiftCount ?? 0 })
                    : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
          </Fact>
        </div>
        <div className="grid gap-4 md:grid-cols-3 text-sm">
          <div className="space-y-1 rounded border bg-muted/30 p-3">
            <MoneyRow label={t('totalSales')} value={s.totalSales} strong />
            <MoneyRow label={t('discounts')} value={s.discountsTotal} />
            <MoneyRow label={t('totalRefunds')} value={s.totalRefunds} />
            <MoneyRow label={t('vat')}>
              {formatCurrency(s.vatTotal)}
              {(s.vatMissingCount ?? 0) > 0 ? (
                <span className="text-muted-foreground ms-1 text-xs">
                  {t('vatMissingCount', { count: s.vatMissingCount ?? 0 })}
                </span>
              ) : null}
            </MoneyRow>
            <MoneyRow label={t('tips')} value={s.totalTips} />
          </div>
          <div className="rounded border bg-muted/30 p-3">
            <PaymentBreakdownRows breakdown={s.paymentBreakdown} />
          </div>
          <div className="space-y-1 rounded border bg-muted/30 p-3">
            <MoneyRow label={t('openingCash')} value={s.openingCash} />
            <MoneyRow label={t('expectedCash')} value={s.expectedCash} />
            <MoneyRow label={t('actualCash')}>
              {uncounted ? (
                <span className="text-muted-foreground text-xs">
                  {t('uncountedShifts', { count: s.uncountedShiftCount ?? 0 })}
                </span>
              ) : (
                <CountedCash value={s.countedCash} />
              )}
            </MoneyRow>
            <MoneyRow label={t('discrepancy')}>
              <OverShort value={uncounted ? null : s.overShort} uncountedLabel={t('discrepancyWithheld')} />
            </MoneyRow>
          </div>
        </div>
      </CardContent>
      {shifts.length > 0 ? (
        <CardContent className="border-t p-0">
          <ShiftTable shifts={shifts} />
        </CardContent>
      ) : null}
    </Card>
  );
}

function Header({ z }: { z: ZReportDetail }) {
  const t = useTranslations('zReports');
  const b = z.business;
  if (!b) {
    return <p className="text-muted-foreground text-xs">{t('noHeader')}</p>;
  }
  const address = [b.address, b.addressNumber].filter(Boolean).join(' ');
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
      <Fact label={t('header.businessName')}>{b.businessName ?? '—'}</Fact>
      <Fact label={t('header.vatNumber')}>{b.vatNumber ?? '—'}</Fact>
      <Fact label={t('header.address')}>
        {[address, b.city, b.zip].filter(Boolean).join(', ') || '—'}
      </Fact>
      <Fact label={t('header.branch')}>
        {b.shopName ?? '—'}
        {b.branchId ? <span className="text-muted-foreground text-xs"> · {b.branchId}</span> : null}
      </Fact>
      <Fact label={t('header.capturedAt')}>{formatDateTime(b.capturedAt)}</Fact>
    </div>
  );
}

export default function ZReportDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const t = useTranslations('zReports');
  usePageScope({ maxLevel: 'machine', silent: true });
  // Stamped when the print dialog opens, so the paper says when it was printed.
  const [printedAt, setPrintedAt] = useState(() => new Date().toISOString());

  const { data: z, isLoading, isError, error } = useQuery({
    queryKey: ['z-report', id],
    queryFn: () => fetchZReport(id),
  });

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (isError || !z) {
    return <ReportErrorState message={axiosErrorToToastMessage(error, t('notFound'))} />;
  }

  const uncountedShifts = z.perMachine.reduce((n, s) => n + (s.uncountedShiftCount ?? 0), 0);
  const withheld = z.actualCash == null;
  const late = z.lateDocuments ?? 0;
  const shiftsOf = (machineId: string) => z.shifts.filter((s) => s.machineId === machineId);

  const print = () => {
    setPrintedAt(new Date().toISOString());
    // Let the new timestamp render before the dialog snapshots the page.
    window.setTimeout(() => window.print(), 50);
  };

  return (
    <>
      <div className="space-y-6 print:hidden">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-1">
              <FileBarChart className="h-5 w-5 text-muted-foreground me-1" aria-hidden />
              <h1 className="text-2xl font-bold">
                {z.shopSequenceNumber != null
                  ? t('detailsNumbered', { number: z.shopSequenceNumber })
                  : t('details')}
              </h1>
              <ZBadges z={z} />
            </div>
            <p className="text-muted-foreground text-sm">
              {z.shopName ?? z.business?.shopName ?? '—'} ·{' '}
              {t('businessDateValue', { date: formatDate(z.businessDate) })}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={print}>
              <Printer className="h-4 w-4 me-1" aria-hidden />
              {t('print')}
            </Button>
            <Link href="/dashboard/z-reports" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
              {t('backToList')}
            </Link>
          </div>
        </div>

        {z.reconstructed ? (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950">
            {t('reconstructedNotice')}
          </div>
        ) : null}
        {late > 0 ? (
          <div className="flex gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" aria-hidden />
            {t('lateNotice', { count: late })}
          </div>
        ) : null}
        {z.legacy ? (
          <div className="rounded-md border bg-muted/40 p-3 text-sm">
            {t('legacyNotice', { till: z.machineName ?? z.machineId ?? '—' })}
          </div>
        ) : null}

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">{t('header.title')}</CardTitle>
          </CardHeader>
          <CardContent>
            <Header z={z} />
          </CardContent>
        </Card>

        <Card>
          <CardContent className="grid grid-cols-2 gap-4 pt-4 sm:grid-cols-3 lg:grid-cols-5">
            <Fact label={t('periodStart')}>{formatDateTime(z.periodStart)}</Fact>
            <Fact label={t('periodEnd')}>{formatDateTime(z.periodEnd)}</Fact>
            <Fact label={t('closedAt')}>{formatDateTime(z.closedAt)}</Fact>
            <Fact label={t('tills')}>{z.machineCount ?? z.perMachine.length}</Fact>
            <Fact label={t('shiftsCount')}>{z.shiftCount ?? z.shifts.length}</Fact>
          </CardContent>
        </Card>

        <div className="grid gap-4 lg:grid-cols-3">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">{t('totalsTitle')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1 text-sm">
              <MoneyRow label={t('totalSales')} value={z.totalSales} strong />
              <MoneyRow label={t('discounts')} value={z.discountsTotal} />
              <MoneyRow label={t('totalRefunds')} value={z.totalRefunds} />
              <MoneyRow label={t('vat')}>
                {z.vatTotal == null ? (
                  <span className="text-muted-foreground text-xs">{t('vatMissing')}</span>
                ) : (
                  formatCurrency(z.vatTotal)
                )}
              </MoneyRow>
              <MoneyRow label={t('tips')} value={z.totalTips} />
              <p className="text-muted-foreground text-xs">
                {t('tipsSplit', {
                  cash: formatCurrency(z.totalCashTips),
                  card: formatCurrency(z.totalCardTips),
                })}
              </p>
              <MoneyRow label={t('transactionsCount')}>{z.transactionsCount ?? 0}</MoneyRow>
              <p className="text-muted-foreground pt-1 text-xs">{t('salesNetHint')}</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">{t('paymentsTitle')}</CardTitle>
            </CardHeader>
            <CardContent className="text-sm">
              <PaymentBreakdownRows breakdown={z.paymentBreakdown} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">{t('cashTitle')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1 text-sm">
              <MoneyRow label={t('openingCash')} value={z.openingCash} />
              <MoneyRow label={t('expectedCash')} value={z.expectedCash} />
              <MoneyRow label={t('actualCash')}>
                {withheld ? (
                  <span className="text-muted-foreground text-xs">
                    {uncountedShifts > 0 ? t('uncountedShifts', { count: uncountedShifts }) : t('notCounted')}
                  </span>
                ) : (
                  formatCurrency(z.actualCash)
                )}
              </MoneyRow>
              <MoneyRow label={t('discrepancy')}>
                <OverShort value={z.discrepancy} uncountedLabel={t('discrepancyWithheld')} />
              </MoneyRow>
              {withheld ? <p className="text-muted-foreground pt-1 text-xs">{t('cashWithheldHint')}</p> : null}
            </CardContent>
          </Card>
        </div>

        {z.perMachine.length > 0 ? (
          <div className="space-y-3">
            <h2 className="text-lg font-semibold">{t('tillsTitle')}</h2>
            {z.perMachine.map((s) => (
              <TillCard key={s.machineId} s={s} shifts={shiftsOf(s.machineId)} />
            ))}
          </div>
        ) : z.shifts.length > 0 ? (
          <Card>
            <CardContent className="p-0">
              <ShiftTable shifts={z.shifts} />
            </CardContent>
          </Card>
        ) : null}

        {z.legacy && z.payload ? (
          <details className="rounded border p-2">
            <summary className="cursor-pointer text-xs text-muted-foreground">{t('rawPayload')}</summary>
            <pre className="mt-2 max-h-72 overflow-auto rounded bg-muted/40 p-2 text-xs" dir="ltr">
              {JSON.stringify(z.payload, null, 2)}
            </pre>
          </details>
        ) : null}
      </div>

      <ZPrintDocument z={z} printedAt={printedAt} />
    </>
  );
}
