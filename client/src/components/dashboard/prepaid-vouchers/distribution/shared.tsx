'use client';

/** What the distribution tab's parts share: error texts, state colours, dates, query keys. */

import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { formatDateTime, isoDate } from '@/lib/format';
import type { RecipientState } from '@/lib/voucherDistribution';
import { cn } from '@/lib/utils';

export const STATE_STYLE: Record<RecipientState, string> = {
  pending: 'bg-muted text-muted-foreground',
  sent: 'bg-sky-100 text-sky-900 dark:bg-sky-950/40 dark:text-sky-300',
  delivered: 'bg-indigo-100 text-indigo-900 dark:bg-indigo-950/40 dark:text-indigo-300',
  read: 'bg-violet-100 text-violet-900 dark:bg-violet-950/40 dark:text-violet-300',
  opened: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300',
  failed: 'bg-destructive/10 text-destructive',
};

export function StateBadge({ state, className }: { state: RecipientState; className?: string }) {
  const t = useTranslations('voucherDistribution.state');
  return <span className={cn('rounded-full px-2 py-0.5 text-[11px] whitespace-nowrap', STATE_STYLE[state], className)}>{t(state)}</span>;
}

export function when(iso: string | null | undefined): string {
  return isoDate(iso) ? formatDateTime(iso as string) : '';
}

/** A server `detail` code in Hebrew when we know it, else the generic toast text. */
export function useDistributionError() {
  const t = useTranslations('voucherDistribution.errors');
  const tp = useTranslations('prepaidVouchers');
  const tc = useTranslations('common');
  return (err: unknown) => {
    const detail = (err as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
    if (typeof detail === 'string') {
      if (t.has(detail)) return t(detail);
      if (detail.startsWith('prepaid_voucher_') && tp.has(`errors.${detail}`)) return tp(`errors.${detail}`);
    }
    return axiosErrorToToastMessage(err, tc('error'));
  };
}

export const keys = {
  overview: (batchId: string) => ['voucher-distribution', batchId] as const,
  recipients: (batchId: string) => ['voucher-distribution', batchId, 'recipients'] as const,
  groups: (batchId: string) => ['voucher-distribution', batchId, 'groups'] as const,
  events: (batchId: string) => ['voucher-distribution', batchId, 'events'] as const,
};

/** Everything of this batch's distribution read again (after any change). */
export function useRefreshDistribution(batchId: string) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['voucher-distribution', batchId] });
  };
}
