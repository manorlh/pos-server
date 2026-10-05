'use client';

/**
 * Today's exceptions ("חריגות") as a chip on the overview: how many, and how many still
 * new, in the page's scope; a link to the exceptions page. Renders nothing for a role
 * that cannot read them, or while it has nothing to say.
 */

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { ShieldAlert } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { fetchExceptionSummary, type ExceptionSummary } from '@/lib/exceptionsApi';
import { todayIso } from '@/lib/reportWindow';
import { cn } from '@/lib/utils';

export function ExceptionsTodayChip({
  companyId,
  shopId,
  machineId,
}: {
  companyId?: string;
  shopId?: string;
  machineId?: string;
}) {
  const t = useTranslations('exceptions');
  const { user } = useAuth();
  const allowed = !!user?.role && user.role !== 'cashier';
  const today = todayIso();
  const { data } = useQuery<ExceptionSummary>({
    queryKey: ['exceptions-summary', 'today', today, companyId ?? null, shopId ?? null, machineId ?? null],
    queryFn: () => fetchExceptionSummary({ from: today, to: today, companyId, shopId, machineId }),
    enabled: allowed,
    refetchInterval: 60_000,
    retry: false,
  });
  if (!allowed || !data) return null;
  return (
    <Link
      href="/dashboard/exceptions"
      className={cn(
        'inline-flex min-h-11 items-center gap-1.5 rounded-full border bg-card px-3 text-sm hover:bg-muted',
        data.new > 0 && 'border-amber-400 text-amber-800 dark:text-amber-300',
      )}
    >
      <ShieldAlert className="h-4 w-4" aria-hidden />
      {t('todayChip', { total: data.total, new: data.new })}
    </Link>
  );
}
