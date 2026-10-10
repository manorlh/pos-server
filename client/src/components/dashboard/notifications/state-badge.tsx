'use client';

import { useTranslations } from 'next-intl';
import { FlaskConical } from 'lucide-react';
import type { NotificationRow } from '@/lib/notificationsApi';
import { Badge } from '@/components/ui/badge';
import { NC } from './shared';

/** Colour by what the state means for the customer, not by the word. */
export function stateTone(state: string): string {
  switch (state) {
    case 'delivered':
      return 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-300';
    case 'provider_accepted':
      return 'bg-sky-500/15 text-sky-800 dark:text-sky-300';
    case 'failed_permanent':
    case 'failed_retryable':
      return 'bg-destructive/10 text-destructive';
    case 'unknown_outcome':
      return 'bg-amber-500/15 text-amber-800 dark:text-amber-300';
    case 'queued':
    case 'processing':
      return 'bg-secondary text-secondary-foreground';
    default:
      return 'bg-muted text-muted-foreground';
  }
}

/** The server's state label; "התקבל אצל הספק" carries a hint that it is not "נמסר". */
export function StateBadge({ row }: { row: Pick<NotificationRow, 'state' | 'stateLabel' | 'isTest'> }) {
  const t = useTranslations(`${NC}.notifications`);
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Badge
        className={stateTone(row.state)}
        title={row.state === 'provider_accepted' ? t('acceptedIsNotDelivered') : undefined}
      >
        {row.stateLabel || t(`states.${row.state}`)}
      </Badge>
      {row.isTest ? (
        <Badge variant="outline" className="border-amber-500/60 text-amber-800 dark:text-amber-300">
          <FlaskConical aria-hidden />
          TEST
        </Badge>
      ) : null}
    </span>
  );
}
