'use client';

/**
 * The control board's "מה דורש תשומת לב" block: today's till anomalies of the board's scope
 * and a few products that barely sell, each with its one-tap actions, plus "מבצע מזדמן" and
 * "Happy hour". Its own component, mounted in one place on the board (src/app/dashboard/page.tsx).
 */

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { BadgePercent, ChevronLeft, Lightbulb, Megaphone, Monitor, Sparkles } from 'lucide-react';
import { anomalyMessage, type ActionScope, type AttentionAction } from '@/lib/insightsActions';
import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';
import { BoardCard, CardTitle } from '@/components/dashboard/control-board/board-ui';
import { useActionSheets } from './action-host';
import { useCanAct } from './sheet-parts';
import { useAnomalyFeed } from './use-anomaly-items';

const ICON = { quickMessage: Megaphone, quickPromo: BadgePercent, openMachine: Monitor } as const;
const DOT: Record<string, string> = {
  critical: 'bg-cb-red',
  warning: 'bg-cb-amber',
  opportunity: 'bg-cb-purple',
  positive: 'bg-cb-green',
  info: 'bg-cb-muted',
};

export function BoardInsightsBlock({
  scope,
  onOpenTill,
  className,
}: {
  scope: ActionScope;
  /** The board's till details sheet; without it, the till's page. */
  onOpenTill?: (machineId: string) => void;
  className?: string;
}) {
  const t = useTranslations('insightsActions.board');
  const ta = useTranslations();
  const canAct = useCanAct();
  const feed = useAnomalyFeed(scope);
  const sheets = useActionSheets(scope);
  const items = feed.items.slice(0, 6);

  const run = (item: { id: string }, a: AttentionAction) => {
    if (a.actionId === 'openMachine' && a.context.machineId) {
      if (onOpenTill) onOpenTill(a.context.machineId);
      else window.location.assign(`/dashboard/machines/${a.context.machineId}`);
      return;
    }
    const type = item.id.split(':')[0];
    sheets.open(a.actionId === 'quickPromo' ? 'quickPromo' : 'quickMessage', a.context, {
      initialText: a.context.machineId ? anomalyMessage(type) : undefined,
      source: a.context.machineId ? 'anomaly' : 'slow',
    });
  };

  const pill =
    'inline-flex min-h-9 items-center gap-1 rounded-full border border-cb-line bg-cb-card px-3 text-sm text-cb-blue-ink hover:bg-cb-soft';

  return (
    <BoardCard className={className} labelledBy="cb-insights-title">
      <CardTitle
        id="cb-insights-title"
        icon={Lightbulb}
        trailing={
          <Link href="/dashboard/insights" className="inline-flex min-h-9 items-center gap-1 rounded-lg px-2 text-sm font-medium text-cb-blue-ink hover:bg-cb-soft">
            {t('all')}
            <ChevronLeft className="size-4 ltr:rotate-180" aria-hidden />
          </Link>
        }
      >
        {t('title')}
      </CardTitle>
      {feed.isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-12 w-full bg-cb-soft" />
          <Skeleton className="h-12 w-full bg-cb-soft" />
        </div>
      ) : items.length === 0 ? (
        <p className="py-4 text-center text-sm text-cb-muted">{t('empty')}</p>
      ) : (
        <ul className="divide-y divide-cb-line">
          {items.map((item) => (
            <li key={item.id} className="flex flex-wrap items-start gap-3 py-2.5">
              <span className={cn('mt-1.5 size-2.5 shrink-0 rounded-full', DOT[item.severity] ?? 'bg-cb-muted')} aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-cb-ink">{item.title}</p>
                <p className="text-xs leading-snug text-cb-muted">{item.body}</p>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {item.actions
                  .filter((a) => a.actionId === 'openMachine' || canAct)
                  .map((a) => {
                    const Icon = ICON[a.actionId];
                    return (
                      <button key={a.actionId} type="button" onClick={() => run(item, a)} className={pill}>
                        <Icon className="size-3.5" aria-hidden />
                        {ta(a.labelKey)}
                      </button>
                    );
                  })}
              </div>
            </li>
          ))}
        </ul>
      )}
      {canAct ? (
        <div className="mt-3 flex flex-wrap gap-2 border-t border-cb-line pt-3">
          <button type="button" className={pill} onClick={() => sheets.open('quickPromo')}>
            <BadgePercent className="size-3.5" aria-hidden />
            {t('adhoc')}
          </button>
          <button type="button" className={pill} onClick={() => sheets.open('happyHour')}>
            <Sparkles className="size-3.5" aria-hidden />
            {t('happyHour')}
          </button>
          <button type="button" className={pill} onClick={() => sheets.open('quickMessage')}>
            <Megaphone className="size-3.5" aria-hidden />
            {t('message')}
          </button>
        </div>
      ) : null}
      {sheets.element}
    </BoardCard>
  );
}
