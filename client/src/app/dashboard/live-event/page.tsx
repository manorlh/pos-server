'use client';

/**
 * "מצב אירוע חי" — which event to watch: the events of the scope that are live now, start
 * within 12 hours or ended in the last 3 (pos-server `GET /report-events/live/current`).
 * Arriving with `?open=auto` (the board's shortcut) opens the only live event straight away.
 */

import { useEffect } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { MonitorPlay, Radio } from 'lucide-react';
import { usePageScope } from '@/lib/scope';
import { autoOpenEvent, type CurrentLiveEvent } from '@/lib/eventLive';
import { fetchCurrentLiveEvents } from '@/lib/eventLiveApi';
import { Card, InsightsSurface, Muted, SkeletonCard } from '@/components/dashboard/insights/ios';

export default function LiveEventPickerPage() {
  const t = useTranslations('eventLive');
  const router = useRouter();
  const search = useSearchParams();
  const { effective } = usePageScope({ maxLevel: 'shop', silent: true });
  const shopId = effective.shopId ?? null;

  const events = useQuery<CurrentLiveEvent[]>({
    queryKey: ['live-events-current', shopId],
    queryFn: () => fetchCurrentLiveEvents(shopId),
    refetchInterval: 60_000,
  });

  const auto = search.get('open') === 'auto';
  const only = events.data ? autoOpenEvent(events.data) : null;
  useEffect(() => {
    if (auto && only) router.replace(`/dashboard/live-event/${only}`);
  }, [auto, only, router]);

  return (
    <InsightsSurface>
      <div className="space-y-1 px-1">
        <h1 className="flex items-center gap-2 text-[28px] font-bold leading-tight tracking-tight">
          <MonitorPlay className="size-7 text-[#007AFF]" aria-hidden />
          {t('pickerTitle')}
        </h1>
        <Muted>{t('pickerHint')}</Muted>
      </div>
      <div className="mt-4 space-y-3">
        {events.isPending ? (
          <>
            <SkeletonCard className="h-24" />
            <SkeletonCard className="h-24" />
          </>
        ) : events.isError ? (
          <Card>{t('loadError')}</Card>
        ) : (events.data ?? []).length === 0 ? (
          <Card>
            <p className="font-medium">{t('noCurrent')}</p>
            <Muted className="mt-1">{t('noCurrentHint')}</Muted>
            <Link href="/dashboard/events" className="mt-3 inline-flex min-h-11 items-center text-[#007AFF]">
              {t('toEvents')}
            </Link>
          </Card>
        ) : (
          (events.data ?? []).map((e) => (
            <Link key={e.id} href={`/dashboard/live-event/${e.id}`} className="block rounded-[22px] outline-none focus-visible:ring-2 focus-visible:ring-[#007AFF]">
              <Card className="flex items-center gap-4 transition-colors hover:bg-black/[0.02] dark:hover:bg-white/[0.04]">
                <span
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-sm font-semibold"
                  style={{
                    background: e.phase === 'live' ? 'rgba(255,59,48,0.12)' : e.phase === 'upcoming' ? 'rgba(255,149,0,0.12)' : 'rgba(142,142,147,0.15)',
                    color: e.phase === 'live' ? '#FF3B30' : e.phase === 'upcoming' ? '#C93400' : '#8E8E93',
                  }}
                >
                  {e.phase === 'live' ? <Radio className="size-4" aria-hidden /> : null}
                  {t(`phase.${e.phase}`)}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-lg font-semibold">{e.name}</p>
                  <Muted className="truncate">
                    {[e.shopName, `${e.startDate} ${e.startTime}–${e.endTime}`, e.producerName].filter(Boolean).join(' · ')}
                  </Muted>
                </div>
                <span className="shrink-0 text-[#007AFF]">{t('open')}</span>
              </Card>
            </Link>
          ))
        )}
      </div>
    </InsightsSurface>
  );
}
