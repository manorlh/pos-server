'use client';

/**
 * "תשלומים לא מוכרעים" from the cockpit: the card payments in the scope that the till could not
 * settle and that may have been charged — amount, till, card, when — in place. Deciding one
 * (checking on the terminal, the cloud's decision) stays on the transactions page's full list,
 * linked at the bottom.
 */

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { he } from 'date-fns/locale';
import { api } from '@/lib/api';
import { agorotToShekels, failedPaymentsParams, maskedCard, type FailedPaymentsResponse } from '@/lib/failedPayments';
import { formatCurrency } from '@/lib/format';
import { Skeleton } from '@/components/ui/skeleton';
import type { CockpitActionProps } from '../types';

export function FailedPaymentsSheet({ scope, context }: CockpitActionProps) {
  const t = useTranslations('controlBoard.cockpit.failedPayments');
  const params = failedPaymentsParams({
    shopId: scope.shopId ?? null,
    machineId: context?.machineId ?? scope.machineId ?? null,
    outcome: 'unresolved',
    pageSize: 50,
  });
  const query = useQuery<FailedPaymentsResponse>({
    queryKey: ['cockpit-failed-payments-sheet', params],
    queryFn: async () => (await api.get<FailedPaymentsResponse>('/failed-payments', { params })).data,
  });
  const items = query.data?.items ?? [];
  return (
    <div className="space-y-3">
      <p className="text-sm text-cb-muted">{t('hint')}</p>
      {query.isPending ? (
        <Skeleton className="h-24 w-full bg-cb-soft" />
      ) : items.length === 0 ? (
        <p className="py-4 text-center text-sm text-cb-muted">{t('none')}</p>
      ) : (
        <ul className="max-h-[50dvh] divide-y divide-cb-line overflow-y-auto">
          {items.map((a) => (
            <li key={a.id} className="flex items-center justify-between gap-3 py-2.5">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-cb-ink">{a.machineName ?? '—'}</p>
                <p className="truncate text-xs text-cb-muted">
                  {[maskedCard(a.cardLast4), formatDistanceToNow(new Date(a.occurredAt), { addSuffix: true, locale: he })]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              </div>
              <span className="shrink-0 font-semibold tabular-nums text-cb-red-ink">
                {formatCurrency(agorotToShekels(a.amountAgorot))}
              </span>
            </li>
          ))}
        </ul>
      )}
      <Link href="/dashboard/transactions" className="inline-flex min-h-11 items-center text-sm font-medium text-cb-blue-ink hover:underline">
        {t('decide')}
      </Link>
    </div>
  );
}
