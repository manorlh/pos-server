'use client';

/**
 * "מצב אירוע חי" — the shortcut to an event's big screen (events list, the event's page) or,
 * without an event, to the picker that opens the only live one (the control board).
 */
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { MonitorPlay } from 'lucide-react';
import { cn } from '@/lib/utils';

export function LiveEventLink({ eventId, className, label }: { eventId?: string; className?: string; label?: boolean }) {
  const t = useTranslations('eventLive');
  const href = eventId ? `/dashboard/live-event/${eventId}` : '/dashboard/live-event?open=auto';
  return (
    <Link
      href={href}
      title={t('openLive')}
      aria-label={t('openLive')}
      className={cn(
        'inline-flex min-h-9 items-center gap-1.5 rounded-lg px-2 py-1 text-[15px] font-medium text-[#FF3B30] hover:bg-[#FF3B30]/10',
        className,
      )}
    >
      <MonitorPlay className="h-4 w-4" aria-hidden />
      {label === false ? null : <span className={eventId ? 'hidden sm:inline' : undefined}>{t('openLive')}</span>}
    </Link>
  );
}
