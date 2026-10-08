'use client';

/**
 * The two one-tap actions on a product row ("הודעה מהירה", "מבצע מהיר") and, once one ran,
 * its result: sales of the product since it started against the same hours before.
 */

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { BadgePercent, Megaphone } from 'lucide-react';
import { resultState } from '@/lib/insightsActions';
import { fetchQuickActions, type QuickAction } from '@/lib/insightsActionsApi';
import { cn } from '@/lib/utils';
import { useCanAct } from './sheet-parts';

/** The latest quick action per product (the list refreshes every minute). */
export function useLatestActionByProduct(): Map<string, QuickAction> {
  const q = useQuery({
    queryKey: ['quick-actions', 'list'],
    queryFn: () => fetchQuickActions({ limit: 60 }),
    refetchInterval: 60_000,
    retry: false,
  });
  return useMemo(() => {
    const out = new Map<string, QuickAction>();
    for (const a of q.data?.items ?? []) {
      if (a.productId && !out.has(a.productId)) out.set(a.productId, a);
    }
    return out;
  }, [q.data]);
}

export function ResultChip({ action }: { action: QuickAction }) {
  const t = useTranslations('insightsActions.result');
  const r = action.result;
  const state = resultState(r);
  const kind = action.kind === 'promotion' ? t('promo') : t('message');
  let text: string;
  if (state === 'waiting' || state === 'none') text = t('waiting', { kind });
  else if (state === 'new') text = t('new', { kind, units: r?.since?.units ?? 0 });
  else text = t('change', { kind, units: r?.since?.units ?? 0, before: r?.before?.units ?? 0 });
  const color =
    state === 'up' || state === 'new' ? 'text-[#248A3D] dark:text-[#30D158]' : state === 'down' ? 'text-[#C93400] dark:text-[#FF9F0A]' : 'text-[#8E8E93]';
  return (
    <span className={cn('text-[12px]', color)}>
      {text}
      {action.status !== 'active' ? ` · ${t(action.status)}` : ''}
    </span>
  );
}

export function ProductQuickActions({
  onMessage,
  onPromo,
  className,
}: {
  onMessage: () => void;
  onPromo: () => void;
  className?: string;
}) {
  const t = useTranslations('insightsActions.actions');
  const canAct = useCanAct();
  if (!canAct) return null;
  const pill =
    'inline-flex min-h-8 items-center gap-1 rounded-full bg-[#7676801F] px-2.5 text-[13px] font-medium text-[#007AFF] active:opacity-60 dark:bg-[#7676803D] dark:text-[#0A84FF]';
  return (
    <span className={cn('flex shrink-0 flex-wrap gap-1.5', className)}>
      <button type="button" onClick={onMessage} className={pill}>
        <Megaphone className="h-3.5 w-3.5" aria-hidden />
        {t('quickMessage')}
      </button>
      <button type="button" onClick={onPromo} className={pill}>
        <BadgePercent className="h-3.5 w-3.5" aria-hidden />
        {t('quickPromo')}
      </button>
    </span>
  );
}
