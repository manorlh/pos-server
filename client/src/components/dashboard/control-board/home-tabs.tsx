'use client';

/**
 * The home page's views — "לוח בקרה | השוואות | תובנות" — as one segmented control. The
 * board and the comparisons are this page (`?view=compare`, lib/periodCompare.ts, written with
 * the scope in one push, so Back returns to the board and a shared link opens the
 * comparisons); "תובנות" is its own page (`/dashboard/insights`), linked in the same place.
 * A segment the user may not open is left out; with only the board there is no control.
 *
 * The insights page shows the same control (`view="insights"`): there the board and the
 * comparisons are links back to the home page, with the scope the user stands on.
 */

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { BarChart3, LayoutDashboard, Lightbulb } from 'lucide-react';
import { useScope, useScopeQuery } from '@/lib/scope';
import { compareQuery, type HomeView } from '@/lib/periodCompare';
import { cn } from '@/lib/utils';

const SEGMENT =
  'flex min-h-10 items-center justify-center gap-1.5 rounded-lg px-3 text-sm font-semibold transition-colors outline-none focus-visible:ring-2 focus-visible:ring-cb-blue/40';
const ON = 'bg-cb-card text-cb-ink shadow-sm';
const OFF = 'text-cb-muted hover:text-cb-ink';

/** The home page's address for a view, keeping the scope's query (`?shop=…`). */
function homeHref(scopeQuery: string, view: HomeView): string {
  const params = new URLSearchParams(scopeQuery.replace(/^\?/, ''));
  for (const [key, value] of Object.entries(compareQuery({ view }))) {
    if (value === null) params.delete(key);
    else params.set(key, value);
  }
  const query = params.toString();
  return query ? `/dashboard?${query}` : '/dashboard';
}

export function HomeTabs({
  view,
  canCompare,
  canInsights,
  className,
}: {
  /** The view shown: the home page's own, or `insights` on the insights page. */
  view: HomeView | 'insights';
  canCompare: boolean;
  canInsights: boolean;
  className?: string;
}) {
  const t = useTranslations('controlBoard.home');
  const scope = useScope();
  const scopeQuery = useScopeQuery((s) => s.query);
  if (!canCompare && !canInsights) return null;
  const onHome = view !== 'insights';
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
        const content = (
          <>
            <Icon className="size-4" aria-hidden />
            {label}
          </>
        );
        return onHome ? (
          <button
            key={id}
            type="button"
            aria-current={on ? 'page' : undefined}
            onClick={() => {
              if (!on) scope.setScope(scope.selection, 'push', compareQuery({ view: id }));
            }}
            className={cn(SEGMENT, on ? ON : OFF)}
          >
            {content}
          </button>
        ) : (
          <Link key={id} href={homeHref(scopeQuery, id)} className={cn(SEGMENT, OFF)}>
            {content}
          </Link>
        );
      })}
      {canInsights ? (
        <Link
          href="/dashboard/insights"
          aria-current={view === 'insights' ? 'page' : undefined}
          className={cn(SEGMENT, view === 'insights' ? ON : OFF)}
        >
          <Lightbulb className="size-4" aria-hidden />
          {t('insights')}
        </Link>
      ) : null}
    </nav>
  );
}
