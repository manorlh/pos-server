'use client';

/**
 * One shift's X report (דו״ח X): the cash, the figures, and every reason to read
 * them with care.
 *
 * The figures are the cloud's own, recomputed from the documents it holds — the same
 * source every Z is built from. The till's own X is kept for audit and shown beside
 * them only when the two disagree, because that disagreement is the thing to chase.
 */

import { use } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Clock, FileBarChart } from 'lucide-react';
import { fetchShift } from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { usePageScope, useScopeQuery } from '@/lib/scope';
import { formatCurrency, formatDate, formatDateTimeInZone, moneyValue } from '@/lib/format';
import { useTenantTimeZone } from '@/lib/auth';
import { useCanProduceZ, zWizardHref } from '@/lib/zAccess';
import type { Shift } from '@/lib/types';
import { ReportErrorState } from '@/components/dashboard/report-window-summary';
import {
  CountedCash,
  Fact,
  MoneyRow,
  OverShort,
  PaymentBreakdownRows,
  ShiftBadges,
  TipsSplit,
  useShiftLabel,
} from '@/components/dashboard/shifts/shift-parts';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

/**
 * The till X keys the server compares, with the server figure each is compared to.
 *
 * The till's `totalSales` is gross (its line totals), so it is set against the cloud's
 * stored gross, not its net `totalSales`. A shift closed before gross was stored and
 * not backfilled has none; its cloud cell then stays empty rather than showing the net
 * figure as if it were comparable.
 */
const COMPARED = [
  { till: ['totalSales'], server: (s) => s.serverTotals?.grossSales },
  { till: ['totalDiscounts', 'discountsTotal'], server: (s) => s.serverTotals?.discountsTotal },
  { till: ['totalRefunds'], server: (s) => s.serverTotals?.totalRefunds },
  { till: ['totalCash'], server: (s) => s.serverTotals?.totalCash },
  { till: ['totalCard'], server: (s) => s.serverTotals?.totalCard },
  { till: ['totalTips'], server: (s) => s.serverTotals?.totalTips },
  { till: ['vatTotal'], server: (s) => s.serverTotals?.vatTotal },
  { till: ['transactionsCount'], server: (s) => s.serverTotals?.transactionsCount },
] as const satisfies ReadonlyArray<{ till: readonly string[]; server: (s: Shift) => unknown }>;

function display(value: unknown, key: string): string {
  if (value === null || value === undefined || value === '') return '—';
  if (key === 'transactionsCount') return String(value);
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? formatCurrency(n) : String(value);
}

export default function ShiftDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const t = useTranslations('shifts');
  const shiftLabel = useShiftLabel();
  const canProduceZ = useCanProduceZ();
  usePageScope({ maxLevel: 'machine', silent: true });
  const tz = useTenantTimeZone();
  const router = useRouter();
  const searchParams = useSearchParams();
  const scopeQuery = useScopeQuery((st) => st.query);
  // `?list=` is the list this shift was opened from (scope and filters). Back there is
  // a real Back, so the list keeps its scroll; opened from anywhere else, the list is
  // rebuilt from the scope in effect.
  const listQuery = searchParams.get('list');
  const backHref =
    listQuery !== null
      ? `/dashboard/shifts${listQuery ? `?${listQuery}` : ''}`
      : `/dashboard/shifts${scopeQuery}`;
  const goBack = (e: React.MouseEvent) => {
    if (listQuery !== null && window.history.length > 1) {
      e.preventDefault();
      router.back();
    }
  };

  const { data: shift, isLoading, isError, error } = useQuery({
    queryKey: ['shift', id],
    queryFn: () => fetchShift(id),
  });

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (isError || !shift) {
    return <ReportErrorState message={axiosErrorToToastMessage(error, t('detail.notFound'))} />;
  }

  const totals = shift.serverTotals;
  const open = shift.status === 'open';
  const late = shift.lateDocuments ?? 0;
  const basis = shift.reconstructionBasis ?? null;
  const till = shift.tillTotals ?? null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Clock className="h-5 w-5 text-muted-foreground" aria-hidden />
            <h1 className="text-2xl font-bold">
              {t('detail.title', { shift: shiftLabel(shift) })}
            </h1>
            <ShiftBadges shift={shift} showZ={false} />
          </div>
          <p className="text-muted-foreground text-sm">
            <Link href={`/dashboard/machines/${shift.machineId}`} className="hover:underline">
              {shift.machineName ?? shift.machineId}
            </Link>
            {shift.shopName ? <> · {shift.shopName}</> : null}
            {/* The area stamped on the shift when it was created — not the till's area now. */}
            {shift.areaName ? <> · {t('detail.area', { area: shift.areaName })}</> : null}
            {' · '}
            {t('detail.businessDate', { date: formatDate(shift.businessDate) })}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {shift.zReportId ? (
            <Link
              href={`/dashboard/z-reports/${shift.zReportId}`}
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              <FileBarChart className="h-4 w-4 me-1" aria-hidden />
              {shift.zNumber != null ? t('inZNumbered', { number: shift.zNumber }) : t('inZ')}
            </Link>
          ) : !open && canProduceZ && shift.shopId ? (
            <Link
              href={zWizardHref(shift.shopId, shift.machineId)}
              className={buttonVariants({ size: 'sm' })}
            >
              {t('produceZ')}
            </Link>
          ) : null}
          <Link href={backHref} onClick={goBack} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            {t('detail.backToList')}
          </Link>
        </div>
      </div>

      {open ? (
        <div className="rounded-md border bg-muted/40 p-3 text-sm">{t('detail.openNotice')}</div>
      ) : null}

      {shift.reconstructed ? (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950">
          <p className="font-medium">{t('detail.reconstructedNotice')}</p>
          {basis ? (
            <p className="mt-1 text-xs">
              {t('detail.reconstructedBasis', {
                documents: Number(basis.documentsOnCloud ?? 0),
              })}
              {Number(basis.lastReportedPendingDocuments ?? 0) > 0
                ? ` ${t('detail.reconstructedOutstanding', {
                    count: Number(basis.lastReportedPendingDocuments ?? 0),
                  })}`
                : ''}
            </p>
          ) : null}
          {typeof basis?.note === 'string' && basis.note ? (
            <p className="mt-1 text-xs">{t('detail.reconstructedNote', { note: basis.note })}</p>
          ) : null}
        </div>
      ) : null}

      {late > 0 ? (
        <div className="flex gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" aria-hidden />
          <p>
            {shift.zReportId
              ? t('detail.lateAfterZ', { count: late })
              : t('detail.lateBeforeZ', { count: late })}
          </p>
        </div>
      ) : null}

      <Card>
        <CardContent className="grid grid-cols-2 gap-4 pt-4 sm:grid-cols-3 lg:grid-cols-6">
          <Fact label={t('detail.openedAt')}>{formatDateTimeInZone(shift.openedAt, tz)}</Fact>
          <Fact label={t('detail.openedBy')}>{shift.openedByName ?? '—'}</Fact>
          <Fact label={t('detail.closedAt')}>{open ? '—' : formatDateTimeInZone(shift.closedAt, tz)}</Fact>
          <Fact label={t('detail.closedBy')}>
            {open ? '—' : shift.unattended ? t('closedRemotely') : (shift.closedByName ?? '—')}
          </Fact>
          <Fact label={t('detail.closeAcceptedAt')}>{formatDateTimeInZone(shift.closeAcceptedAt, tz)}</Fact>
          <Fact label={t('detail.documentRange')}>
            {totals?.firstTransactionNumber || totals?.lastTransactionNumber ? (
              <span className="font-mono text-xs" dir="ltr">
                {totals?.firstTransactionNumber ?? '?'} – {totals?.lastTransactionNumber ?? '?'}
              </span>
            ) : (
              '—'
            )}
          </Fact>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {t('detail.cashTitle')}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <MoneyRow label={t('detail.openingCash')} value={shift.openingCash} />
            <MoneyRow label={t('detail.cashTaken')} value={totals?.totalCash} />
            <MoneyRow label={t('detail.cashTips')} value={totals?.totalCashTips} />
            <MoneyRow label={t('detail.expectedCash')} value={shift.expectedCash} strong />
            <MoneyRow label={t('detail.countedCash')}>
              {open ? '—' : <CountedCash value={shift.countedCash} />}
            </MoneyRow>
            <MoneyRow label={t('detail.overShort')}>
              {open ? '—' : <OverShort value={shift.discrepancy} />}
            </MoneyRow>
            {!open && shift.countedCash == null ? (
              <p className="text-muted-foreground pt-1 text-xs">
                {shift.unattended ? t('detail.uncountedUnattended') : t('detail.uncounted')}
              </p>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {t('detail.totalsTitle')}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            {totals ? (
              <>
                {/* Gross and discounts only when a discount was given: otherwise both
                    say what the net line already says. */}
                {moneyValue(totals.discountsTotal) ? (
                  <>
                    <MoneyRow label={t('detail.grossSales')} value={totals.grossSales} />
                    <MoneyRow label={t('detail.discounts')} value={totals.discountsTotal} />
                  </>
                ) : null}
                <MoneyRow label={t('detail.sales')} value={totals.totalSales} strong />
                <MoneyRow label={t('detail.refunds')} value={totals.totalRefunds} />
                <MoneyRow label={t('detail.vat')}>
                  {totals.vatTotal == null ? (
                    <span className="text-muted-foreground text-xs">{t('detail.vatMissing')}</span>
                  ) : (
                    formatCurrency(totals.vatTotal)
                  )}
                </MoneyRow>
                <MoneyRow label={t('detail.tips')} value={totals.totalTips} />
                <TipsSplit total={totals.totalTips} cash={totals.totalCashTips} card={totals.totalCardTips} />
                {shift.shopId && moneyValue(totals.totalTips) ? (
                  <Link
                    href={`/dashboard/tips?shiftId=${shift.id}&shop=${shift.shopId}`}
                    className="text-primary text-xs underline"
                  >
                    {t('detail.tipsByCashier')}
                  </Link>
                ) : null}
                <MoneyRow label={t('detail.documents')}>{totals.transactionsCount ?? 0}</MoneyRow>
                <p className="text-muted-foreground pt-1 text-xs">{t('detail.salesNetHint')}</p>
              </>
            ) : (
              <p className="text-muted-foreground text-xs">{t('detail.noTotalsYet')}</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {t('detail.paymentsTitle')}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            <PaymentBreakdownRows breakdown={shift.paymentBreakdown} />
            <p className="text-muted-foreground pt-2 text-xs">{t('detail.paymentsHint')}</p>
          </CardContent>
        </Card>
      </div>

      {shift.totalsMismatch && till ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-destructive">
              {t('detail.mismatchTitle')}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 p-0">
            <p className="text-muted-foreground px-4 text-xs">{t('detail.mismatchExplain')}</p>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('detail.mismatchKey')}</TableHead>
                  <TableHead className="text-end">{t('detail.mismatchTill')}</TableHead>
                  <TableHead className="text-end">{t('detail.mismatchCloud')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {COMPARED.map(({ till: keys, server }) => {
                  const key = keys.find((k) => k in till);
                  if (!key) return null;
                  return (
                    <TableRow key={key}>
                      <TableCell>{t(`detail.tillKey.${keys[0]}`)}</TableCell>
                      <TableCell className="text-end tabular-nums">{display(till[key], key)}</TableCell>
                      <TableCell className="text-end tabular-nums">
                        {display(server(shift), key)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
