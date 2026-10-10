'use client';

/**
 * "עמדת מפיק" — the producer's home: the events opened to them (pos-server `GET /producer/events`).
 * The only event (or the only live one) opens straight away; `?all=1` shows the list.
 */

import { useEffect } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, Radio } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { autoOpen, isProducer, type ProducerEventCard } from '@/lib/producer';
import { fetchMyEvents } from '@/lib/producerApi';
import { Card, Muted, SkeletonCard } from '@/components/dashboard/insights/ios';

export default function ProducerHomePage() {
  const t = useTranslations('producer');
  const router = useRouter();
  const search = useSearchParams();
  const role = useAuth((s) => s.user?.role);
  const producer = isProducer(role);
  const events = useQuery<ProducerEventCard[]>({ queryKey: ['producer-events'], queryFn: fetchMyEvents, enabled: producer });
  const only = events.data && search.get('all') !== '1' ? autoOpen(events.data) : null;
  useEffect(() => {
    if (only) router.replace(`/dashboard/producer/${only}`);
  }, [only, router]);

  if (!producer) {
    return (
      <Card className="max-w-xl">
        <p className="font-medium">{t('staffTitle')}</p>
        <Muted className="mt-1">{t('staffHint')}</Muted>
        <Link href="/dashboard/events" className="mt-3 inline-flex min-h-11 items-center text-[#007AFF]">
          {t('toEvents')}
        </Link>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      <h1 className="text-[28px] font-bold leading-tight tracking-tight">{t('myEvents')}</h1>
      {events.isPending ? (
        <SkeletonCard className="h-24" />
      ) : events.isError ? (
        <Card>{t('loadError')}</Card>
      ) : (events.data ?? []).length === 0 ? (
        <Card>
          <p className="font-medium">{t('noEvents')}</p>
          <Muted className="mt-1">{t('noEventsHint')}</Muted>
        </Card>
      ) : (
        (events.data ?? []).map((e) => (
          <Link key={e.id} href={`/dashboard/producer/${e.id}`} className="block rounded-[22px] outline-none focus-visible:ring-2 focus-visible:ring-[#007AFF]">
            <Card className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 truncate text-lg font-semibold">
                  {e.phase === 'live' ? <Radio className="size-4 shrink-0 text-[#FF3B30]" aria-label={t('phase.live')} /> : null}
                  {e.name}
                </p>
                <Muted className="truncate">
                  {[e.shopName, `${e.startDate} ${e.startTime}–${e.endTime}`, t(`phase.${e.phase}`)].filter(Boolean).join(' · ')}
                </Muted>
              </div>
              <ChevronLeft className="size-5 shrink-0 text-[#C7C7CC]" aria-hidden />
            </Card>
          </Link>
        ))
      )}
    </div>
  );
}
