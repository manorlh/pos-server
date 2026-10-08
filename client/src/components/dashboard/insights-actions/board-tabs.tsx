'use client';

/**
 * "לוח בקרה | השוואות | תובנות" — the segmented control on top of the control board, the
 * comparisons and the insights: three views of one place, the scope kept in the link.
 */

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useScopeQuery } from '@/lib/scope';
import { cn } from '@/lib/utils';

export type BoardTab = 'board' | 'compare' | 'insights';

const HREF: Record<BoardTab, string> = {
  board: '/dashboard',
  compare: '/dashboard/compare',
  insights: '/dashboard/insights',
};

export function BoardTabs({ active, className }: { active: BoardTab; className?: string }) {
  const t = useTranslations('insightsActions.tabs');
  const scopeQuery = useScopeQuery((s) => s.query);
  return (
    <nav aria-label={t('label')} className={cn('flex rounded-[9px] bg-[#7676801F] p-[2px] dark:bg-[#7676803D]', className)}>
      {(Object.keys(HREF) as BoardTab[]).map((tab) => {
        const on = tab === active;
        return (
          <Link
            key={tab}
            href={`${HREF[tab]}${scopeQuery}`}
            aria-current={on ? 'page' : undefined}
            className={cn(
              'flex min-h-8 flex-1 items-center justify-center whitespace-nowrap rounded-[7px] px-3 text-[13px] transition-all',
              on
                ? 'bg-white font-semibold text-black shadow-[0_3px_8px_rgba(0,0,0,0.12),0_3px_1px_rgba(0,0,0,0.04)] dark:bg-[#636366] dark:text-white'
                : 'font-medium text-black/80 dark:text-white/80',
            )}
          >
            {t(tab)}
          </Link>
        );
      })}
    </nav>
  );
}
