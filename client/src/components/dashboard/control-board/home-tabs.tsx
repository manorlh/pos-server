'use client';

/**
 * The home page's views — "לוח בקרה | השוואות | תובנות" — as one segmented control. The
 * board and the comparisons are this page (`?view=compare`, lib/periodCompare.ts, written with
 * the scope in one push, so Back returns to the board and a shared link opens the
 * comparisons); "תובנות" is its own page (`/dashboard/insights`), linked in the same place.
 * A segment the user may not open is left out; with only the board there is no control.
 */

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { BarChart3, LayoutDashboard, Lightbulb } from 'lucide-react';
import { useScope } from '@/lib/scope';
import { compareQuery, type HomeView } from '@/lib/periodCompare';
import { cn } from '@/lib/utils';

const SEGMENT =
  'flex min-h-10 items-center justify-center gap-1.5 rounded-lg px-3 text-sm font-semibold transition-colors outline-none focus-visible:ring-2 focus-visible:ring-cb-blue/40';

export function HomeTabs({
  view,
  canCompare,
  canInsights,
  className,
}: {
  view: HomeView;
  canCompare: boolean;
  canInsights: boolean;
  className?: string;
}) {
  const t = useTranslations('controlBoard.home');
  const scope = useScope();
  if (!canCompare && !canInsights) return null;
  const views = [
    { id: 'board' as const, icon: LayoutDashboard, label: t('board') },
    ...(canCompare ? [{ id: 'compare' as const, icon: BarChart3, label: t('compare') }] : []),
  ];
  const columns = views.length + (canInsights ? 1 : 0);
  return (
    <nav
      aria-label={t('label')}
      className={cn(
        'grid rounded-xl border border-cb-line bg-cb-soft p-1 md:inline-grid',
        columns === 3 ? 'grid-cols-3 md:w-[27rem]' : 'grid-cols-2 md:w-80',
        className,
      )}
    >
      {views.map(({ id, icon: Icon, label }) => {
        const on = view === id;
        return (
          <button
            key={id}
            type="button"
            aria-current={on ? 'page' : undefined}
            onClick={() => {
              if (!on) scope.setScope(scope.selection, 'push', compareQuery({ view: id }));
            }}
            className={cn(SEGMENT, on ? 'bg-cb-card text-cb-ink shadow-sm' : 'text-cb-muted hover:text-cb-ink')}
          >
            <Icon className="size-4" aria-hidden />
            {label}
          </button>
        );
      })}
      {canInsights ? (
        <Link href="/dashboard/insights" className={cn(SEGMENT, 'text-cb-muted hover:text-cb-ink')}>
          <Lightbulb className="size-4" aria-hidden />
          {t('insights')}
        </Link>
      ) : null}
    </nav>
  );
}
