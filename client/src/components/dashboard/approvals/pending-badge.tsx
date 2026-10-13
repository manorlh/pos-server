'use client';

/**
 * The menu's count of requests waiting for me (`GET /approvals/pending-count`), refreshed every
 * 15 seconds. Mounted only where the "בקשות אישור" entry is shown (the section's view), hidden at
 * 0; a server without the endpoint shows nothing and stops asking.
 */

import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { badgeText } from '@/lib/approvals';
import { fetchPendingApprovalsCount } from '@/lib/approvalsApi';
import { cn } from '@/lib/utils';

export const PENDING_COUNT_KEY = ['approvals', 'pending-count'] as const;

export function usePendingApprovalsCount(enabled = true): number {
  const { data } = useQuery({
    queryKey: PENDING_COUNT_KEY,
    queryFn: fetchPendingApprovalsCount,
    enabled,
    retry: false,
    refetchInterval: (query) => (query.state.status === 'error' ? false : 15_000),
    refetchOnWindowFocus: true,
  });
  return data ?? 0;
}

export function PendingApprovalsBadge({ active = false }: { active?: boolean }) {
  const t = useTranslations('approvals');
  const count = usePendingApprovalsCount();
  const text = badgeText(count);
  if (!text) return null;
  return (
    <span
      className={cn(
        'inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-semibold tabular-nums',
        active ? 'bg-primary-foreground text-primary' : 'bg-red-600 text-white dark:bg-red-500',
      )}
      aria-label={t('pendingCount', { count })}
      title={t('pendingCount', { count })}
    >
      {text}
    </span>
  );
}
