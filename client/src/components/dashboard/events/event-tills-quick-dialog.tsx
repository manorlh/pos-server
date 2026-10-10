'use client';

/**
 * "הוסף/הסר קופות" — the compact tills picker of one event (the live screen, the cockpit): the
 * quick picker (./event-till-picker.tsx) on the event's tills, saved in one request
 * (`POST /report-events/{id}/tills`) — all of it or nothing. A till in an overlapping event moves
 * only when marked "העבר לאירוע הזה"; a refusal (409 / 403) leaves everything as it was.
 */

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { MonitorSmartphone } from 'lucide-react';
import {
  changeEventTills,
  eventErrorDetail,
  eventErrorMessage,
  fetchEvent,
  fetchEventTillsView,
  type ReportEvent,
} from '@/lib/eventsApi';
import { hasChanges, movesToSend, tillChanges, tillConflicts, unresolvedConflicts } from '@/lib/eventTills';
import { useTenantTimeZone } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { EventTillPicker } from './event-till-picker';

/** Everything that shows an event's tills, after they changed. */
export function eventTillsQueryKeys(eventId: string): unknown[][] {
  return [['events'], ['event', eventId], ['event-report', eventId], ['event-live', eventId], ['event-tills'], ['event-readiness', eventId]];
}

export function EventTillsQuickDialog({
  eventId,
  open,
  onOpenChange,
  onSaved,
}: {
  eventId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: (event: ReportEvent) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        {open ? <QuickTills eventId={eventId} onClose={() => onOpenChange(false)} onSaved={onSaved} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function QuickTills({
  eventId,
  onClose,
  onSaved,
}: {
  eventId: string;
  onClose: () => void;
  onSaved?: (event: ReportEvent) => void;
}) {
  const t = useTranslations('eventTills');
  const tc = useTranslations('common');
  const event = useQuery<ReportEvent>({ queryKey: ['event', eventId], queryFn: () => fetchEvent(eventId) });

  if (event.isError) {
    return (
      <div className="grid gap-4">
        <DialogHeader>
          <DialogTitle>{t('quick.title')}</DialogTitle>
        </DialogHeader>
        <p className="text-destructive text-sm">{eventErrorMessage(event.error, t('quick.loadError'))}</p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{tc('cancel')}</Button>
        </DialogFooter>
      </div>
    );
  }
  if (!event.data) return <p className="text-muted-foreground p-4 text-sm">{tc('loading')}</p>;
  // Remounted per version: the picker starts from the event's tills as saved.
  return <QuickTillsForm key={`${event.data.id}:${event.data.updatedAt}`} event={event.data} onClose={onClose} onSaved={onSaved} />;
}

function QuickTillsForm({
  event,
  onClose,
  onSaved,
}: {
  event: ReportEvent;
  onClose: () => void;
  onSaved?: (event: ReportEvent) => void;
}) {
  const t = useTranslations('eventTills');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const timeZone = useTenantTimeZone();
  const [selected, setSelected] = useState<string[]>(() => [...event.machineIds]);
  const [moveIds, setMoveIds] = useState<string[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const confirmed = event.status !== 'draft';

  const view = useQuery({
    queryKey: ['event-tills', event.shopId, { startDate: event.startDate, startTime: event.startTime, endDate: event.endDate, endTime: event.endTime }, event.id],
    queryFn: () =>
      fetchEventTillsView({
        shopId: event.shopId,
        startDate: event.startDate,
        startTime: event.startTime,
        endDate: event.endDate,
        endTime: event.endTime,
        excludeEventId: event.id,
      }),
    retry: false,
  });
  const tills = useMemo(() => view.data?.tills ?? [], [view.data]);
  const unresolved = unresolvedConflicts(tillConflicts(selected, tills, moveIds));
  const changes = tillChanges(event.machineIds, selected, movesToSend(selected, tills, moveIds));

  const save = useMutation({
    mutationFn: () => changeEventTills(event.id, changes),
    onSuccess: (saved) => {
      const moved = saved.changes?.moved?.length ?? 0;
      toast.success(moved ? t('quick.savedMoved', { count: moved }) : t('quick.saved'));
      for (const key of eventTillsQueryKeys(event.id)) void qc.invalidateQueries({ queryKey: key });
      onSaved?.(saved);
      onClose();
    },
    onError: (err) => {
      // All or nothing: nothing changed. A till that became busy shows up as a conflict.
      if (eventErrorDetail(err)?.code === 'till_in_overlapping_event') void view.refetch();
      setFailure(eventErrorMessage(err, tc('error')));
    },
  });

  return (
    <div className="grid gap-3">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <MonitorSmartphone className="h-5 w-5 text-[#007AFF]" aria-hidden />
          {t('quick.title')}
        </DialogTitle>
        <p className="text-muted-foreground text-xs">
          {t('quick.intro', {
            name: event.name,
            window: `${event.startDate === event.endDate ? '' : `${event.startDate} `}${event.startTime}–${event.endTime}`,
          })}
          {event.shopName ? ` · ${event.shopName}` : ''}
        </p>
      </DialogHeader>

      {confirmed ? (
        <p className="text-muted-foreground text-sm">{t('quick.confirmed')}</p>
      ) : (
        <EventTillPicker
          view={view.data}
          loading={view.isLoading}
          error={view.isError ? view.error : null}
          selected={selected}
          moveIds={moveIds}
          onChange={(ids, moves) => {
            setSelected(ids);
            setMoveIds(moves);
            setFailure(null);
          }}
          timeZone={timeZone}
          compact
        />
      )}

      {failure ? (
        <p className="text-destructive text-sm" role="alert">
          {failure}
        </p>
      ) : null}

      <DialogFooter className="items-center gap-2 sm:justify-between">
        <span className="text-muted-foreground text-xs tabular-nums">
          {hasChanges(changes)
            ? t('quick.summary', { add: changes.add.length, remove: changes.remove.length, move: changes.move.length })
            : t('quick.nothing')}
        </span>
        <div className="flex gap-2">
          <Button variant="outline" onClick={onClose}>{tc('cancel')}</Button>
          <Button
            onClick={() => save.mutate()}
            disabled={confirmed || save.isPending || !hasChanges(changes) || unresolved.length > 0}
          >
            {save.isPending ? tc('loading') : t('quick.save')}
          </Button>
        </div>
      </DialogFooter>
    </div>
  );
}
