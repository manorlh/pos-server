'use client';

/**
 * "עסקאות שלא הושלמו" and "מכירות שבוטלו" on a shift's X and on a Z's till: the failed
 * payment attempts of that shift / till of the Z (`GET /failed-payments`), marked as
 * information only — never part of the totals above them. Nothing is shown when there
 * is nothing. docs/SPEC_FAILED_PAYMENTS.md.
 */

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { Info } from 'lucide-react';
import { api } from '@/lib/api';
import { formatCurrency, formatDateTime } from '@/lib/format';
import {
  agorotToShekels,
  failedPaymentsParams,
  isEmpty,
  type FailedPaymentsQuery,
  type FailedPaymentsResponse,
} from '@/lib/failedPayments';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { AttemptBadges, CardText, OutcomeText, PaidLaterText, useFailedPaymentLabels } from './parts';
import { CardCommandPanel, UnresolvedBadge } from './card-command-panel';

/** Enough for any shift or Z; the list page pages through more. */
const SECTION_PAGE_SIZE = 500;

export function FailedPaymentsSection({
  query,
  showTill = false,
  bare = false,
}: {
  /** A shift (`shiftId`) or a Z (`zReportId`, with `machineId` for one of its tills). */
  query: Pick<FailedPaymentsQuery, 'shiftId' | 'zReportId' | 'machineId'>;
  /** Name the till on each line (a list over several tills). */
  showTill?: boolean;
  /** Inside another card: no card of its own. */
  bare?: boolean;
}) {
  const t = useTranslations('failedPayments');
  const labels = useFailedPaymentLabels();
  const params = failedPaymentsParams({ ...query, pageSize: SECTION_PAGE_SIZE });
  const enabled = !!(query.shiftId || query.zReportId);
  const { data } = useQuery<FailedPaymentsResponse>({
    queryKey: ['failed-payments', params],
    queryFn: () => api.get('/failed-payments', { params }).then((r) => r.data),
    enabled,
  });
  if (!enabled || isEmpty(data) || !data) return null;
  const money = (agorot: number) => formatCurrency(agorotToShekels(agorot));
  const { summary } = data;
  const sales = data.items.filter((a) => a.kind !== 'payout');
  const payouts = data.items.filter((a) => a.kind === 'payout');

  const body = (
    <div className="space-y-3 text-sm">
      {data.total > 0 ? (
        <div className="space-y-2">
          <p className="flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400">
            <Info className="h-3.5 w-3.5" aria-hidden />
            {t('infoOnly')}
          </p>
          {summary.count > 0 ? (
            <div className="flex justify-between gap-3 font-medium">
              <span>{t('countTotal')}</span>
              <span className="tabular-nums">
                {t('countTotalValue', { count: summary.count, total: money(summary.totalAgorot) })}
              </span>
            </div>
          ) : null}
          <ul className="divide-y rounded border">
            {[...sales, ...payouts].map((a) => (
              <li key={a.id} className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 px-2 py-1.5">
                <div className="min-w-0 space-y-0.5">
                  <div className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
                    <span className="tabular-nums">{formatDateTime(a.occurredAt)}</span>
                    {showTill ? <span>· {t('tillValue', { till: a.posNumber ?? a.machineName ?? '—' })}</span> : null}
                    <span>· {labels.method(a.method)}</span>
                    <span>· <CardText a={a} /></span>
                    {a.employeeName ? <span>· {a.employeeName}</span> : null}
                  </div>
                  <OutcomeText a={a} />
                  <UnresolvedBadge a={a} />
                  {a.paidByTransactionId || a.paidByMethod ? (
                    <div className="text-xs"><PaidLaterText a={a} /></div>
                  ) : null}
                  <CardCommandPanel a={a} compact />
                </div>
                <span className="font-medium tabular-nums whitespace-nowrap">
                  {money(a.amountAgorot)}
                  <AttemptBadges a={a} />
                </span>
              </li>
            ))}
          </ul>
          {summary.payoutCount > 0 ? (
            <div className="flex justify-between gap-3">
              <span>{t('payouts')}</span>
              <span className="tabular-nums">
                {t('countTotalValue', { count: summary.payoutCount, total: money(summary.payoutTotalAgorot) })}
              </span>
            </div>
          ) : null}
        </div>
      ) : null}
      {data.cancelledSales.count > 0 ? (
        <CancelledSalesList block={data.cancelledSales} showTill={showTill} embedded />
      ) : null}
    </div>
  );

  if (bare) {
    return (
      <div className="space-y-2 rounded border border-dashed p-3">
        <p className="text-sm font-medium">{t('title')}</p>
        {body}
      </div>
    );
  }
  return (
    <Card className="border-dashed">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {t('title')}
        </CardTitle>
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  );
}

/** "מכירות שבוטלו": cancelled sale documents no attempt accounts for. */
export function CancelledSalesList({
  block,
  onOpen,
  showTill = false,
  embedded = false,
}: {
  block: FailedPaymentsResponse['cancelledSales'];
  onOpen?: (transactionId: string) => void;
  showTill?: boolean;
  /** Under the attempts in the same box: a small heading instead of a box. */
  embedded?: boolean;
}) {
  const t = useTranslations('failedPayments');
  if (block.count === 0) return null;
  const money = (agorot: number) => formatCurrency(agorotToShekels(agorot));
  return (
    <div className={embedded ? 'space-y-2' : 'space-y-2 rounded-lg border bg-card p-4'}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-medium">{t('cancelled.title')}</p>
        <span className="text-sm tabular-nums">
          {t('countTotalValue', { count: block.count, total: money(block.totalAgorot) })}
        </span>
      </div>
      <p className="text-muted-foreground text-xs">{t('cancelled.hint')}</p>
      <ul className="divide-y rounded border text-sm">
        {block.items.map((tx) => {
          const number = tx.documentNumber ?? tx.transactionNumber;
          return (
            <li key={tx.id} className="flex flex-wrap items-center justify-between gap-x-3 px-2 py-1.5">
              <span className="flex flex-wrap items-center gap-x-1.5">
                <span className="text-muted-foreground tabular-nums text-xs">{formatDateTime(tx.createdAt)}</span>
                {onOpen ? (
                  <button
                    type="button"
                    className="text-primary font-mono text-xs underline"
                    title={t('openTransaction')}
                    onClick={() => onOpen(tx.id)}
                  >
                    {number}
                  </button>
                ) : (
                  <Link
                    href={`/dashboard/transactions?tx=${tx.id}`}
                    className="text-primary font-mono text-xs underline"
                    title={t('openTransaction')}
                  >
                    {number}
                  </Link>
                )}
                {showTill ? (
                  <span className="text-muted-foreground text-xs">
                    · {t('tillValue', { till: tx.posNumber ?? tx.machineName ?? '—' })}
                  </span>
                ) : null}
                {tx.cashierName ? <span className="text-muted-foreground text-xs">· {tx.cashierName}</span> : null}
              </span>
              <span className="font-medium tabular-nums">{formatCurrency(tx.totalAmount)}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
