'use client';

/**
 * "שייך לאירוע" on the devices page (ארגון → מכשירים): pick tills (of one shop), then an existing
 * draft event not over yet, or "אירוע חדש" — the event dialog with the shop, from now until the
 * end of the day and the tills picked. A picked till in an overlapping event shows it inline and
 * joins only on "העבר לאירוע הזה"; the assignment is one request, all of it or nothing.
 *
 * `useEventTillSelection` keeps the page's part to a few lines: its button, the table's
 * `selection`, and `ui` (the selection bar and the dialogs).
 */

import { useMemo, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowLeftRight, CalendarPlus, Plus } from 'lucide-react';
import {
  changeEventTills,
  eventErrorDetail,
  eventErrorMessage,
  fetchEvents,
  fetchEventTillsView,
  type EventFormValues,
  type EventListItem,
} from '@/lib/eventsApi';
import {
  assignableSelection,
  joinableEvents,
  movesToSend,
  nowUntilEndOfDay,
  tillConflicts,
  unresolvedConflicts,
} from '@/lib/eventTills';
import { clockLabel } from '@/lib/eventReport';
import { findBySameId } from '@/lib/entityLookup';
import type { PosMachine, Shop } from '@/lib/types';
import { useTenantTimeZone } from '@/lib/auth';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { EventFormDialog } from './event-form-dialog';
import { useCanAssignEventTills } from './event-tills-access';
import { eventTillsQueryKeys } from './event-tills-quick-dialog';

interface NewEvent {
  shopId: string;
  shopName: string;
  prefill: Partial<EventFormValues>;
}

export function useEventTillSelection({ machines, shops }: { machines: PosMachine[]; shops: Shop[] }): {
  button: ReactNode;
  selection: { selected: ReadonlySet<string>; onToggle: (ids: string[], on: boolean) => void } | undefined;
  ui: ReactNode;
} {
  const t = useTranslations('eventTills.assign');
  const canAssign = useCanAssignEventTills();
  const [active, setActive] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [dialogOpen, setDialogOpen] = useState(false);
  const [newEvent, setNewEvent] = useState<NewEvent | null>(null);

  const stop = () => {
    setActive(false);
    setPicked(new Set());
  };
  const onToggle = (ids: string[], on: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  const chosen = machines.filter((m) => picked.has(m.id));

  const button = canAssign ? (
    <Button variant={active ? 'secondary' : 'outline'} size="sm" aria-pressed={active} onClick={() => (active ? stop() : setActive(true))}>
      <CalendarPlus className="h-4 w-4 ms-1" aria-hidden /> {t('button')}
    </Button>
  ) : null;

  const ui = (
    <>
      {active ? (
        <div className="bg-background/95 fixed inset-x-0 bottom-4 z-40 mx-auto flex w-fit max-w-[calc(100%-2rem)] flex-wrap items-center gap-2 rounded-full border px-4 py-2 shadow-lg backdrop-blur">
          <span className="text-sm tabular-nums" role="status">
            {picked.size ? t('selected', { count: chosen.length }) : t('selecting')}
          </span>
          <Button size="sm" disabled={chosen.length === 0} onClick={() => setDialogOpen(true)}>
            {t('button')}
          </Button>
          <Button size="sm" variant="ghost" onClick={stop}>
            {t('cancel')}
          </Button>
        </div>
      ) : null}
      {dialogOpen ? (
        <AssignToEventDialog
          machines={chosen}
          shops={shops}
          onClose={() => setDialogOpen(false)}
          onAssigned={() => {
            setDialogOpen(false);
            stop();
          }}
          onNewEvent={(value) => {
            setDialogOpen(false);
            setNewEvent(value);
          }}
        />
      ) : null}
      {newEvent ? (
        <EventFormDialog
          open
          onOpenChange={(open) => (open ? undefined : setNewEvent(null))}
          shopId={newEvent.shopId}
          shopName={newEvent.shopName}
          event={null}
          prefill={newEvent.prefill}
          onSaved={() => stop()}
        />
      ) : null}
    </>
  );

  return { button, selection: active ? { selected: picked, onToggle } : undefined, ui };
}

function AssignToEventDialog({
  machines,
  shops,
  onClose,
  onAssigned,
  onNewEvent,
}: {
  machines: PosMachine[];
  shops: Shop[];
  onClose: () => void;
  onAssigned: () => void;
  onNewEvent: (value: NewEvent) => void;
}) {
  const t = useTranslations('eventTills');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const timeZone = useTenantTimeZone();
  const sel = useMemo(() => assignableSelection(machines), [machines]);
  const shopName = (sel.shopId && findBySameId(shops, sel.shopId)?.name) || '';
  const tillIds = sel.tills.map((m) => m.id);

  const events = useQuery<EventListItem[]>({
    queryKey: ['events', sel.shopId, 'draft'],
    queryFn: () => fetchEvents({ shopId: sel.shopId!, status: 'draft' }),
    enabled: Boolean(sel.shopId),
  });
  const drafts = useMemo(() => joinableEvents(events.data ?? [], new Date()), [events.data]);
  const [mode, setMode] = useState<'existing' | 'new' | null>(null);
  const shownMode = mode ?? (events.isSuccess && drafts.length === 0 ? 'new' : 'existing');
  const [eventId, setEventId] = useState<string | null>(null);
  const chosen = drafts.find((e) => e.id === eventId) ?? (drafts.length === 1 ? drafts[0] : null);
  const [moveIds, setMoveIds] = useState<string[]>([]);
  const [failure, setFailure] = useState<string | null>(null);

  const view = useQuery({
    queryKey: [
      'event-tills',
      sel.shopId,
      chosen ? { startDate: chosen.startDate, startTime: chosen.startTime, endDate: chosen.endDate, endTime: chosen.endTime } : {},
      chosen?.id ?? null,
    ],
    queryFn: () =>
      fetchEventTillsView({
        shopId: sel.shopId!,
        startDate: chosen!.startDate,
        startTime: chosen!.startTime,
        endDate: chosen!.endDate,
        endTime: chosen!.endTime,
        excludeEventId: chosen!.id,
      }),
    enabled: Boolean(sel.shopId && chosen),
    retry: false,
  });
  const already = chosen ? tillIds.filter((id) => chosen.machineIds.includes(id)) : [];
  const toAdd = tillIds.filter((id) => !already.includes(id));
  const conflicts = tillConflicts(toAdd, view.data?.tills ?? [], moveIds);
  const unresolved = unresolvedConflicts(conflicts);

  const assign = useMutation({
    mutationFn: () => {
      const move = movesToSend(toAdd, view.data?.tills ?? [], moveIds);
      return changeEventTills(chosen!.id, { add: toAdd.filter((id) => !move.includes(id)), remove: [], move });
    },
    onSuccess: (saved) => {
      toast.success(t('assign.done', { count: toAdd.length, name: saved.name }));
      for (const key of eventTillsQueryKeys(saved.id)) void qc.invalidateQueries({ queryKey: key });
      onAssigned();
    },
    onError: (err) => {
      if (eventErrorDetail(err)?.code === 'till_in_overlapping_event') void view.refetch();
      setFailure(eventErrorMessage(err, tc('error')));
    },
  });

  const blocked = !sel.shopId || sel.tills.length === 0;

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CalendarPlus className="h-5 w-5 text-[#007AFF]" aria-hidden />
            {t('assign.title')}
          </DialogTitle>
          {sel.shopId ? (
            <p className="text-muted-foreground text-xs">{t('assign.intro', { count: sel.tills.length, shop: shopName })}</p>
          ) : null}
        </DialogHeader>

        {sel.mixedShops ? <p className="text-destructive text-sm">{t('assign.mixedShops')}</p> : null}
        {sel.noShop.length ? <p className="text-muted-foreground text-xs">{t('assign.noShop', { count: sel.noShop.length })}</p> : null}
        {sel.screens.length ? <p className="text-muted-foreground text-xs">{t('assign.screens', { count: sel.screens.length })}</p> : null}

        {!blocked ? (
          <div className="grid gap-3">
            <div className="flex gap-1.5" role="tablist">
              {(['existing', 'new'] as const).map((m) => (
                <Button
                  key={m}
                  type="button"
                  role="tab"
                  aria-selected={shownMode === m}
                  size="sm"
                  variant={shownMode === m ? 'default' : 'outline'}
                  onClick={() => setMode(m)}
                >
                  {m === 'new' ? <Plus className="h-4 w-4" aria-hidden /> : null}
                  {t(`assign.${m}`)}
                </Button>
              ))}
            </div>

            {shownMode === 'new' ? (
              <div className="grid gap-2">
                <p className="text-muted-foreground text-sm">{t('assign.newHint', { shop: shopName })}</p>
                <Button
                  type="button"
                  className="justify-self-start"
                  onClick={() =>
                    onNewEvent({
                      shopId: sel.shopId!,
                      shopName,
                      prefill: { ...nowUntilEndOfDay(new Date(), timeZone), machineIds: tillIds },
                    })
                  }
                >
                  <Plus className="h-4 w-4" aria-hidden /> {t('assign.new')}
                </Button>
              </div>
            ) : events.isLoading ? (
              <p className="text-muted-foreground text-sm">{tc('loading')}</p>
            ) : events.isError ? (
              <p className="text-destructive text-sm">{eventErrorMessage(events.error, tc('error'))}</p>
            ) : drafts.length === 0 ? (
              <p className="text-muted-foreground text-sm">{t('assign.noDrafts')}</p>
            ) : (
              <div className="grid gap-1.5" role="radiogroup">
                {drafts.map((e) => (
                  <button
                    key={e.id}
                    type="button"
                    role="radio"
                    aria-checked={chosen?.id === e.id}
                    onClick={() => {
                      setEventId(e.id);
                      setMoveIds([]);
                      setFailure(null);
                    }}
                    className={cn(
                      'flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-start',
                      chosen?.id === e.id ? 'border-[#007AFF] bg-[#007AFF]/10' : 'hover:bg-muted',
                    )}
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{e.name}</span>
                      <span className="text-muted-foreground block text-xs">
                        {clockLabel(e.startsAt, timeZone, true)}–{clockLabel(e.endsAt, timeZone, true)}
                      </span>
                    </span>
                    <span className="text-muted-foreground shrink-0 text-xs tabular-nums">{e.machineIds.length}</span>
                  </button>
                ))}
              </div>
            )}

            {shownMode === 'existing' && chosen ? (
              <div className="grid gap-1.5">
                {already.length ? <p className="text-muted-foreground text-xs">{t('assign.already', { count: already.length })}</p> : null}
                {view.isLoading ? <p className="text-muted-foreground text-xs">{tc('loading')}</p> : null}
                {conflicts.map((c) => (
                  <div
                    key={c.till.id}
                    className={cn(
                      'grid gap-1 rounded-lg px-2 py-1.5 text-xs',
                      c.moving ? 'bg-[#007AFF]/10' : 'bg-[#FF9500]/10 ring-1 ring-[#FF9500]/40',
                    )}
                    role="status"
                  >
                    {c.moving ? (
                      <span className="flex flex-wrap items-center gap-x-2 text-[#007AFF]">
                        <ArrowLeftRight className="h-3 w-3" aria-hidden />
                        <span className="font-medium">{c.till.name}</span>
                        {t('moving', { event: c.eventName })}
                        <button type="button" className="underline" onClick={() => setMoveIds((m) => m.filter((x) => x !== c.till.id))}>
                          {t('undoMove')}
                        </button>
                      </span>
                    ) : (
                      <>
                        <span className="text-[#C93400]">
                          {t('conflict', {
                            till: c.till.name,
                            event: c.eventName,
                            from: clockLabel(c.startsAt, timeZone, true),
                            to: clockLabel(c.endsAt, timeZone, true),
                          })}
                        </span>
                        <span>
                          <Button type="button" size="sm" variant="outline" className="h-7" onClick={() => setMoveIds((m) => [...m, c.till.id])}>
                            <ArrowLeftRight className="h-3.5 w-3.5" aria-hidden />
                            {t('moveHere')}
                          </Button>
                        </span>
                      </>
                    )}
                  </div>
                ))}
                {unresolved.length > 1 ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="justify-self-start"
                    onClick={() => setMoveIds((m) => [...new Set([...m, ...unresolved.map((c) => c.till.id)])])}
                  >
                    {t('moveAll', { count: unresolved.length })}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}

        {failure ? (
          <p className="text-destructive text-sm" role="alert">
            {failure}
          </p>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{tc('cancel')}</Button>
          {shownMode === 'existing' && !blocked ? (
            <Button
              onClick={() => assign.mutate()}
              disabled={!chosen || toAdd.length === 0 || unresolved.length > 0 || view.isLoading || assign.isPending}
            >
              {assign.isPending ? tc('loading') : t('assign.submit')}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
