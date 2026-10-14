'use client';

/**
 * Pieces shared by "בקשות אישור" (the list, one request, the menu's badge): the status pill,
 * a ticking clock, the countdown to `expiresAt`, and the pending request as a card.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ChevronLeft, Clock, MessageSquareText, UtensilsCrossed } from 'lucide-react';
import {
  STATUS_TONE_CLASS,
  formatCountdown,
  placeOf,
  reasonOf,
  requestedText,
  secondsLeft,
  statusTone,
  type ApprovalCard,
  type ApprovalStatus,
} from '@/lib/approvals';
import { formatShortDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';

/** `Date.now()`, re-read every `everyMs`. */
export function useNowMs(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), everyMs);
    return () => window.clearInterval(timer);
  }, [everyMs]);
  return now;
}

export function StatusPill({ status, className }: { status: ApprovalStatus; className?: string }) {
  const t = useTranslations('approvals');
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        STATUS_TONE_CLASS[statusTone(status)],
        className,
      )}
    >
      {t(`statuses.${status}`)}
    </span>
  );
}

/** "נשאר 2:59", red under 30 seconds; "פג הזמן" at 0. */
export function Countdown({ expiresAt, className }: { expiresAt: string | null; className?: string }) {
  const t = useTranslations('approvals');
  const now = useNowMs(1000);
  const left = secondsLeft(expiresAt, now);
  if (left === null) return null;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-xs font-medium tabular-nums',
        left === 0 ? 'text-muted-foreground' : left < 30 ? 'text-red-600 dark:text-red-400' : 'text-amber-700 dark:text-amber-300',
        className,
      )}
      aria-live="off"
    >
      <Clock className="size-3.5" aria-hidden />
      {left === 0 ? t('expired') : t('expiresIn', { time: formatCountdown(left) })}
    </span>
  );
}

/** A pending request on the list: what, how much, where, who, why, the clock and "פתח". */
export function PendingApprovalCard({ card }: { card: ApprovalCard }) {
  const t = useTranslations('approvals');
  const measure = requestedText(card);
  const reason = reasonOf(card);
  return (
    <li className="bg-card rounded-xl border p-4 shadow-xs">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="font-semibold leading-tight">{card.typeLabel}</p>
          {measure ? <p className="text-xl font-bold tabular-nums">{measure}</p> : null}
          {card.summary ? <p className="text-sm">{card.summary}</p> : null}
        </div>
        <Countdown expiresAt={card.expiresAt} className="mt-0.5" />
      </div>
      <dl className="text-muted-foreground mt-2 space-y-1 text-sm">
        {card.tableLabel ? (
          <div className="flex items-center gap-1.5">
            <UtensilsCrossed className="size-3.5 shrink-0" aria-hidden />
            <dt className="sr-only">{t('col.table')}</dt>
            <dd>{t('table', { table: card.tableLabel })}</dd>
          </div>
        ) : null}
        <div>
          <dt className="sr-only">{t('col.till')}</dt>
          <dd>{[card.shopName, placeOf(card)].filter(Boolean).join(' · ') || '—'}</dd>
        </div>
        <div>
          <dt className="sr-only">{t('col.requester')}</dt>
          <dd>{t('requestedBy', { name: card.requesterName ?? '—' })} · {formatShortDateTime(card.createdAt)}</dd>
        </div>
        {reason ? (
          <div>
            <dt className="sr-only">{t('col.reason')}</dt>
            <dd className="text-foreground">“{reason}”</dd>
          </div>
        ) : null}
        {card.note ? (
          <div className="flex items-start gap-1.5">
            <MessageSquareText className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <dt className="sr-only">{t('col.note')}</dt>
            <dd className="text-foreground">{card.note}</dd>
          </div>
        ) : null}
      </dl>
      <div className="mt-3 flex items-center justify-between gap-2">
        <span className="text-muted-foreground text-xs">{card.canDecide ? null : t('notYours')}</span>
        <Link
          href={`/dashboard/approvals/${card.id}`}
          className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex h-10 items-center gap-1 rounded-lg px-4 text-sm font-medium"
        >
          {t('open')}
          <ChevronLeft className="size-4" aria-hidden />
        </Link>
      </div>
    </li>
  );
}
