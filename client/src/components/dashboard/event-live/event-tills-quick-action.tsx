'use client';

/**
 * "הוסף/הסר קופות" for the Manager Cockpit (`{ scope, context?, onDone }`): the compact tills
 * picker of the scope's event (events/event-tills-quick-dialog.tsx). Without an event in the
 * scope, the draft events not over yet (of the scope's shop, when it has one): one goes straight
 * to its picker, several are listed to choose from, none says so.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { CalendarClock } from 'lucide-react';
import { fetchEvents, type EventListItem } from '@/lib/eventsApi';
import { joinableEvents } from '@/lib/eventTills';
import { useTenantTimeZone } from '@/lib/auth';
import { clockLabel } from '@/lib/eventReport';
import { Button, buttonVariants } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { EventTillsQuickDialog } from '@/components/dashboard/events/event-tills-quick-dialog';
import type { CockpitProps } from './types';

export function EventTillsQuickAction({ scope, onDone }: CockpitProps) {
  const [eventId, setEventId] = useState<string | null>(scope.eventId ?? null);
  const done = () => onDone?.();
  if (eventId) {
    return <EventTillsQuickDialog eventId={eventId} open onOpenChange={(o) => (o ? undefined : done())} />;
  }
  return <ChooseEvent shopId={scope.shopId ?? null} onChoose={setEventId} onClose={done} />;
}

function ChooseEvent({
  shopId,
  onChoose,
  onClose,
}: {
  shopId: string | null;
  onChoose: (id: string) => void;
  onClose: () => void;
}) {
  const t = useTranslations('eventTills');
  const tc = useTranslations('common');
  const timeZone = useTenantTimeZone();
  const events = useQuery<EventListItem[]>({
    queryKey: ['events', shopId, 'draft'],
    queryFn: () => fetchEvents({ ...(shopId ? { shopId } : {}), status: 'draft' }),
  });
  const open = joinableEvents(events.data ?? [], new Date());
  const onlyId = events.isSuccess && open.length === 1 ? open[0].id : null;
  // One event: no question to ask.
  useEffect(() => {
    if (onlyId) onChoose(onlyId);
  }, [onlyId, onChoose]);
  if (onlyId) return null;
  return (
    <Dialog open onOpenChange={(o) => (o ? undefined : onClose())}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CalendarClock className="h-5 w-5 text-[#007AFF]" aria-hidden />
            {t('quick.chooseEvent')}
          </DialogTitle>
        </DialogHeader>
        {events.isLoading ? (
          <p className="text-muted-foreground text-sm">{tc('loading')}</p>
        ) : events.isError ? (
          <p className="text-destructive text-sm">{tc('error')}</p>
        ) : open.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t('quick.noEvents')}</p>
        ) : (
          <div className="grid gap-1.5">
            {open.map((e) => (
              <button
                key={e.id}
                type="button"
                onClick={() => onChoose(e.id)}
                className="hover:bg-muted flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-start"
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium">{e.name}</span>
                  <span className="text-muted-foreground block truncate text-xs">
                    {[e.shopName, `${clockLabel(e.startsAt, timeZone, true)}–${clockLabel(e.endsAt, timeZone, true)}`]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
                <span className="text-muted-foreground shrink-0 text-xs tabular-nums">{e.machineIds.length}</span>
              </button>
            ))}
          </div>
        )}
        <DialogFooter>
          <Link href="/dashboard/events" className={buttonVariants({ variant: 'ghost' })} onClick={onClose}>
            {t('quick.toEvents')}
          </Link>
          <Button variant="outline" onClick={onClose}>{tc('cancel')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
