'use client';

/**
 * What the dashboard can say about a till while it waits for that till to close a shift.
 *
 * Used by a Z run's items and by the standalone remote close, which carry the same four
 * fields (docs/SHIFTS_API.md §2.14, §3.4). Two kinds of fact, kept apart on purpose:
 *
 * * the till's **own last report** of how many documents it still holds, always with
 *   its age — it is a reading, never a live count (a bug the machines page shipped once);
 * * how many of the closing shift's documents the **cloud already holds**, which the
 *   cloud knows first-hand.
 */

import { useTranslations } from 'next-intl';
import { formatDistanceToNow } from 'date-fns';
import { he } from 'date-fns/locale';
import { Wifi, WifiOff } from 'lucide-react';

export interface CloseProgressFacts {
  online?: boolean | null;
  pendingDocuments?: number | null;
  pendingAsOf?: string | null;
  documentsOnCloud?: number | null;
}

export function TillCloseProgress({ facts }: { facts: CloseProgressFacts }) {
  const t = useTranslations('closeProgress');
  const when = facts.pendingAsOf
    ? formatDistanceToNow(new Date(facts.pendingAsOf), { addSuffix: true, locale: he })
    : null;
  const pending = facts.pendingDocuments ?? null;

  return (
    <div className="text-muted-foreground space-y-0.5 text-xs">
      {typeof facts.online === 'boolean' ? (
        <p className="flex items-center gap-1">
          {facts.online ? (
            <Wifi className="h-3 w-3 text-green-500" aria-hidden />
          ) : (
            <WifiOff className="h-3 w-3" aria-hidden />
          )}
          {facts.online ? t('online') : t('offline')}
        </p>
      ) : null}
      <p>
        {when === null || pending === null
          ? t('neverReported')
          : pending > 0
            ? t('pendingReported', { when, count: pending })
            : t('noPendingReported', { when })}
      </p>
      {facts.documentsOnCloud != null ? (
        <p className="tabular-nums">{t('onCloud', { count: facts.documentsOnCloud })}</p>
      ) : null}
    </div>
  );
}
