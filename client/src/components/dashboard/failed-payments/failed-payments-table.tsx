'use client';

/**
 * The transactions page's "ניסיונות תשלום שנכשלו" filter: the failed payment attempts of
 * the page's till / shop / dates (`GET /failed-payments`), their summary — informational,
 * never part of a total — and the cancelled sales no attempt accounts for.
 * docs/SPEC_FAILED_PAYMENTS.md.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Info } from 'lucide-react';
import { api } from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { formatCurrency, formatDateTime } from '@/lib/format';
import {
  agorotToShekels,
  failedPaymentsParams,
  isUnresolved,
  type FailedPaymentsResponse,
} from '@/lib/failedPayments';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  AttemptBadges,
  CardText,
  OutcomeText,
  PaidLaterText,
  VoidedDocument,
  useFailedPaymentLabels,
} from './parts';
import { CancelledSalesList } from './failed-payments-section';
import { CardCommandPanel, UnresolvedBadge } from './card-command-panel';
import { useFailedPaymentsSheets } from './export-sheets';
import { ReportExportToolbar } from '@/components/dashboard/report-export-toolbar';

const PAGE_SIZE = 50;

export function FailedPaymentsTable({
  machineId,
  shopId,
  from,
  to,
  cardLast4,
  onOpenTransaction,
}: {
  machineId?: string | null;
  shopId?: string | null;
  from?: string;
  to?: string;
  cardLast4?: string;
  /** Opens a document in the page's own details dialog. */
  onOpenTransaction?: (id: string) => void;
}) {
  const t = useTranslations('failedPayments');
  const labels = useFailedPaymentLabels();
  const exportSheets = useFailedPaymentsSheets();
  const [page, setPage] = useState(1);
  // A new filter is a new list: back to its first page (reset during render, as the page does).
  const filterKey = `${machineId ?? ''}|${shopId ?? ''}|${from ?? ''}|${to ?? ''}|${cardLast4 ?? ''}`;
  const [pageKey, setPageKey] = useState(filterKey);
  if (pageKey !== filterKey) {
    setPageKey(filterKey);
    setPage(1);
  }
  const params = failedPaymentsParams({ machineId, shopId, from, to, cardLast4, page, pageSize: PAGE_SIZE });
  const { data, isLoading, isError, error, isFetching } = useQuery<FailedPaymentsResponse>({
    queryKey: ['failed-payments', params],
    queryFn: () => api.get('/failed-payments', { params }).then((r) => r.data),
    placeholderData: (prev) => prev,
    // A card command waiting for its till ("בדוק במסוף" / a decision): its answer comes in the background.
    refetchInterval: (q) => (q.state.data?.items?.some((a) => a.cardCommand?.status === 'pending') ? 15_000 : false),
  });

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const money = (agorot: number) => formatCurrency(agorotToShekels(agorot));

  return (
    <div className="space-y-4">
      <div className="flex gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950">
        <Info className="h-4 w-4 shrink-0 mt-0.5" aria-hidden />
        <div className="space-y-1">
          <p className="font-medium">{t('infoOnly')}</p>
          <p className="text-xs">{t('listHint')}</p>
        </div>
      </div>

      {/* Every attempt of these filters, not just this page. */}
      <ReportExportToolbar
        title={t('title')}
        from={from}
        to={to}
        disabled={!data || (data.total === 0 && data.cancelledSales.count === 0)}
        getSheets={() => exportSheets({ machineId, shopId, from, to, cardLast4 })}
      />

      {data ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label={t('attempts')} value={String(data.summary.count)} />
          <Stat label={t('totalAmount')} value={money(data.summary.totalAgorot)} />
          <Stat label={t('paidLaterCount')} value={String(data.summary.paidLaterCount)} />
          {(data.summary.unresolvedCount ?? 0) > 0 ? (
            <Stat
              label={t('unresolvedCount')}
              value={t('countTotalValue', {
                count: data.summary.unresolvedCount ?? 0,
                total: money(data.summary.unresolvedTotalAgorot ?? 0),
              })}
              alert
            />
          ) : null}
          {(data.summary.approvedLateCount ?? 0) > 0 ? (
            <Stat label={t('approvedLateCount')} value={String(data.summary.approvedLateCount)} />
          ) : null}
          {data.summary.payoutCount > 0 ? (
            <Stat
              label={t('payouts')}
              value={t('countTotalValue', {
                count: data.summary.payoutCount,
                total: money(data.summary.payoutTotalAgorot),
              })}
            />
          ) : null}
        </div>
      ) : null}

      {isError ? (
        <p className="text-destructive text-sm">{axiosErrorToToastMessage(error, t('loadError'))}</p>
      ) : null}

      {/* A phone gets one card per attempt; the table from md up. */}
      <ul className="divide-y rounded-lg border bg-card md:hidden">
        {isLoading ? (
          Array.from({ length: 3 }).map((_, i) => (
            <li key={i} className="p-3"><Skeleton className="h-10 w-full" /></li>
          ))
        ) : !data || data.items.length === 0 ? (
          <li className="py-6 text-center text-sm text-muted-foreground">{t('none')}</li>
        ) : (
          data.items.map((a) => (
            <li key={a.id} className={cn('space-y-1 p-3 text-sm', isUnresolved(a) && 'bg-red-50/60 dark:bg-red-950/30')}>
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-medium">
                  {labels.outcome(a.outcome)}
                  <UnresolvedBadge a={a} />
                </span>
                <span className="font-medium tabular-nums">
                  {money(a.amountAgorot)}
                  <AttemptBadges a={a} />
                </span>
              </div>
              <div className="text-muted-foreground flex flex-wrap gap-x-2 text-xs">
                <span>{formatDateTime(a.occurredAt)}</span>
                <span>· {a.machineName ?? t('tillValue', { till: a.posNumber ?? '—' })}</span>
                {a.employeeName ? <span>· {a.employeeName}</span> : null}
                <span>· {labels.method(a.method)}</span>
                <span>· <CardText a={a} /></span>
              </div>
              {a.paidByTransactionId || a.paidByMethod ? (
                <div className="text-xs"><PaidLaterText a={a} onOpen={onOpenTransaction} /></div>
              ) : null}
              <CardCommandPanel a={a} />
            </li>
          ))
        )}
      </ul>

      <div className="hidden rounded-lg border bg-card overflow-hidden md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('col.time')}</TableHead>
              <TableHead>{t('col.till')}</TableHead>
              <TableHead>{t('col.employee')}</TableHead>
              <TableHead className="text-end">{t('col.amount')}</TableHead>
              <TableHead>{t('col.method')}</TableHead>
              <TableHead>{t('col.outcome')}</TableHead>
              <TableHead>{t('col.card')}</TableHead>
              <TableHead className="text-end">{t('col.lines')}</TableHead>
              <TableHead>{t('col.paidLater')}</TableHead>
              <TableHead>{t('col.voided')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 3 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell colSpan={10}><Skeleton className="h-6 w-full" /></TableCell>
                </TableRow>
              ))
            ) : !data || data.items.length === 0 ? (
              <TableRow>
                <TableCell colSpan={10} className="text-center text-muted-foreground py-6">
                  {t('none')}
                </TableCell>
              </TableRow>
            ) : (
              data.items.map((a) => [
                <TableRow key={a.id} className={cn(isUnresolved(a) && 'bg-red-50/60 dark:bg-red-950/30')}>
                  <TableCell className="whitespace-nowrap">{formatDateTime(a.occurredAt)}</TableCell>
                  <TableCell>
                    {a.machineName ?? '—'}
                    {a.posNumber ? (
                      <span className="text-muted-foreground ms-1 text-xs">
                        {t('tillValue', { till: a.posNumber })}
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell>{a.employeeName ?? a.posUserId ?? '—'}</TableCell>
                  <TableCell className="text-end font-medium tabular-nums whitespace-nowrap">
                    {money(a.amountAgorot)}
                    <AttemptBadges a={a} />
                  </TableCell>
                  <TableCell>{labels.method(a.method)}</TableCell>
                  <TableCell>
                    <OutcomeText a={a} />
                    <UnresolvedBadge a={a} />
                  </TableCell>
                  <TableCell><CardText a={a} /></TableCell>
                  <TableCell className="text-end tabular-nums">{a.lineCount ?? '—'}</TableCell>
                  <TableCell className="text-xs"><PaidLaterText a={a} onOpen={onOpenTransaction} /></TableCell>
                  <TableCell><VoidedDocument a={a} onOpen={onOpenTransaction} /></TableCell>
                </TableRow>,
                // "לא הוכרע": what it means, the command sent to the till, the manager's actions.
                isUnresolved(a) ? (
                  <TableRow key={`${a.id}-command`} className="bg-red-50/60 hover:bg-red-50/60 dark:bg-red-950/30">
                    <TableCell colSpan={10} className="pt-0">
                      <CardCommandPanel a={a} />
                    </TableCell>
                  </TableRow>
                ) : null,
              ])
            )}
          </TableBody>
        </Table>
      </div>

      {data && data.total > data.pageSize ? (
        <div className="flex items-center justify-end gap-2 text-sm">
          <Button
            size="sm" variant="outline"
            disabled={page <= 1 || isFetching}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
          <span className="text-muted-foreground tabular-nums">{page} / {totalPages}</span>
          <Button
            size="sm" variant="outline"
            disabled={page >= totalPages || isFetching}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
        </div>
      ) : null}

      {data && data.cancelledSales.count > 0 ? (
        <CancelledSalesList block={data.cancelledSales} onOpen={onOpenTransaction} showTill />
      ) : null}
    </div>
  );
}

function Stat({ label, value, alert = false }: { label: string; value: string; alert?: boolean }) {
  return (
    <div className={cn('rounded-lg border bg-card p-3', alert && 'border-red-300 bg-red-50 dark:border-red-900 dark:bg-red-950')}>
      <p className="text-muted-foreground text-xs">{label}</p>
      <p className="text-lg font-semibold tabular-nums">{value}</p>
    </div>
  );
}
