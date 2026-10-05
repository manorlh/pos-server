'use client';

/**
 * Create / edit an event ("אירוע"): a name, the shop (the one in scope), a start date +
 * hour and an end date + hour (all four required, in the tenant's timezone), the shop's
 * tills as checkboxes — a till already in an overlapping event is marked with that
 * event's name and cannot be ticked — the producer, notes, and the insight thresholds
 * behind "מתקדם". The server checks it all again (docs/SPEC_EVENTS.md §1).
 */

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CalendarClock, ChevronDown, Lock, Settings2 } from 'lucide-react';
import {
  createEvent,
  eventErrorDetail,
  eventErrorMessage,
  fetchEventTills,
  updateEvent,
  type EventFormValues,
  type EventTillOption,
  type ReportEvent,
} from '@/lib/eventsApi';
import { DEFAULT_THRESHOLDS, clockLabel, durationText, formDurationMinutes, validateEventForm } from '@/lib/eventReport';
import { cn } from '@/lib/utils';
import { useTenantTimeZone } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function initialValues(event: ReportEvent | null): EventFormValues {
  if (event) {
    return {
      name: event.name,
      startDate: event.startDate,
      startTime: event.startTime,
      endDate: event.endDate,
      endTime: event.endTime,
      machineIds: [...event.machineIds],
      producerName: event.producerName ?? '',
      notes: event.notes ?? '',
      thresholds: { ...DEFAULT_THRESHOLDS, ...event.thresholds },
    };
  }
  const today = todayIso();
  // The hours are left empty on purpose: the window is the one thing that must be chosen.
  return {
    name: '',
    startDate: today,
    startTime: '',
    endDate: today,
    endTime: '',
    machineIds: [],
    producerName: '',
    notes: '',
    thresholds: { ...DEFAULT_THRESHOLDS },
  };
}

export function EventFormDialog({
  open,
  onOpenChange,
  shopId,
  shopName,
  event,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  shopId: string;
  shopName: string;
  event: ReportEvent | null;
  onSaved?: (event: ReportEvent) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        {open ? (
          <EventForm
            key={event?.id ?? 'new'}
            shopId={shopId}
            shopName={shopName}
            event={event}
            onClose={() => onOpenChange(false)}
            onSaved={onSaved}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function EventForm({
  shopId,
  shopName,
  event,
  onClose,
  onSaved,
}: {
  shopId: string;
  shopName: string;
  event: ReportEvent | null;
  onClose: () => void;
  onSaved?: (event: ReportEvent) => void;
}) {
  const t = useTranslations('events.form');
  const te = useTranslations('events');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const timeZone = useTenantTimeZone();
  const [values, setValues] = useState<EventFormValues>(() => initialValues(event));
  const [tried, setTried] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const isNew = event === null;
  const set = <K extends keyof EventFormValues>(key: K, value: EventFormValues[K]) =>
    setValues((v) => ({ ...v, [key]: value }));

  const windowComplete = Boolean(values.startDate && values.startTime && values.endDate && values.endTime);
  const windowParams = windowComplete
    ? { startDate: values.startDate, startTime: values.startTime, endDate: values.endDate, endTime: values.endTime }
    : {};
  const tills = useQuery<EventTillOption[]>({
    queryKey: ['event-tills', shopId, windowParams, event?.id ?? null],
    queryFn: () => fetchEventTills({ shopId, ...windowParams, ...(event ? { excludeEventId: event.id } : {}) }),
    enabled: Boolean(shopId),
    retry: false,
  });

  // A till that turns out busy in the chosen window counts as unticked (and says why).
  const busyIds = useMemo(() => new Set((tills.data ?? []).filter((x) => x.busy).map((x) => x.id)), [tills.data]);
  const chosen = useMemo(
    () => ({ ...values, machineIds: values.machineIds.filter((id) => !busyIds.has(id)) }),
    [values, busyIds],
  );

  const errors = validateEventForm(chosen);
  const duration = formDurationMinutes(values);
  const show = (key: string) => tried && errors.includes(key as never);

  const save = useMutation({
    mutationFn: () => (isNew ? createEvent(shopId, chosen) : updateEvent(event!.id, chosen)),
    onSuccess: (saved) => {
      toast.success(isNew ? t('created') : t('updated'));
      void qc.invalidateQueries({ queryKey: ['events'] });
      void qc.invalidateQueries({ queryKey: ['event', saved.id] });
      void qc.invalidateQueries({ queryKey: ['event-report', saved.id] });
      onSaved?.(saved);
      onClose();
    },
    onError: (err) => {
      if (eventErrorDetail(err)?.code === 'till_in_overlapping_event') void tills.refetch();
      toast.error(eventErrorMessage(err, tc('error')));
    },
  });

  const submit = () => {
    setTried(true);
    if (errors.length === 0) save.mutate();
  };

  const free = (tills.data ?? []).filter((x) => !x.busy);
  const toggle = (id: string, on: boolean) =>
    set('machineIds', on ? [...values.machineIds, id] : values.machineIds.filter((m) => m !== id));
  const th = values.thresholds;
  const setTh = (key: keyof typeof th, raw: string) =>
    set('thresholds', { ...th, [key]: raw === '' ? (key === 'highTipAmount' ? null : Number.NaN) : Number(raw) });

  return (
    <div className="grid gap-4">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <CalendarClock className="h-5 w-5 text-[#007AFF]" aria-hidden />
          {isNew ? t('createTitle') : t('editTitle')}
        </DialogTitle>
        <p className="text-muted-foreground text-xs">{t('intro', { shop: shopName })}</p>
      </DialogHeader>

      <div className="grid gap-1.5">
        <Label htmlFor="event-name">{t('name')}</Label>
        <Input
          id="event-name"
          value={values.name}
          maxLength={120}
          placeholder={t('namePlaceholder')}
          aria-invalid={show('nameRequired')}
          onChange={(e) => set('name', e.target.value)}
        />
        {show('nameRequired') ? <p className="text-destructive text-xs">{t('errors.nameRequired')}</p> : null}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <fieldset className="grid gap-1.5 rounded-xl border p-3">
          <legend className="px-1 text-sm font-medium">{t('start')}</legend>
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <Input type="date" dir="ltr" aria-label={t('startDate')} value={values.startDate}
              aria-invalid={show('startRequired')} onChange={(e) => set('startDate', e.target.value)} />
            <Input type="time" dir="ltr" step={300} aria-label={t('startTime')} className="w-28" value={values.startTime}
              aria-invalid={show('startRequired')} onChange={(e) => set('startTime', e.target.value)} />
          </div>
          {show('startRequired') ? <p className="text-destructive text-xs">{t('errors.startRequired')}</p> : null}
        </fieldset>
        <fieldset className="grid gap-1.5 rounded-xl border p-3">
          <legend className="px-1 text-sm font-medium">{t('end')}</legend>
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <Input type="date" dir="ltr" aria-label={t('endDate')} value={values.endDate} min={values.startDate || undefined}
              aria-invalid={show('endRequired')} onChange={(e) => set('endDate', e.target.value)} />
            <Input type="time" dir="ltr" step={300} aria-label={t('endTime')} className="w-28" value={values.endTime}
              aria-invalid={show('endRequired')} onChange={(e) => set('endTime', e.target.value)} />
          </div>
          {show('endRequired') ? <p className="text-destructive text-xs">{t('errors.endRequired')}</p> : null}
        </fieldset>
      </div>
      <p className={cn('-mt-2 text-xs', errors.includes('endBeforeStart') || errors.includes('tooLong') ? 'text-destructive' : 'text-muted-foreground')}>
        {errors.includes('endBeforeStart') && duration !== null
          ? t('errors.endBeforeStart')
          : errors.includes('tooLong')
            ? t('errors.tooLong')
            : duration !== null
              ? t('duration', { duration: durationText(duration) })
              : t('windowHint')}
      </p>

      <div className="grid gap-1.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Label>{t('tills', { count: chosen.machineIds.length })}</Label>
          <div className="flex gap-1">
            <Button type="button" variant="ghost" size="sm" disabled={free.length === 0}
              onClick={() => set('machineIds', free.map((x) => x.id))}>
              {t('selectAll')}
            </Button>
            <Button type="button" variant="ghost" size="sm" disabled={chosen.machineIds.length === 0}
              onClick={() => set('machineIds', [])}>
              {t('selectNone')}
            </Button>
          </div>
        </div>
        {!windowComplete ? <p className="text-muted-foreground text-xs">{t('tillsWindowHint')}</p> : null}
        <div className="grid max-h-64 gap-1.5 overflow-y-auto rounded-xl border p-2 sm:grid-cols-2">
          {tills.isLoading ? (
            <p className="text-muted-foreground p-2 text-sm">{tc('loading')}</p>
          ) : tills.isError ? (
            <p className="text-destructive p-2 text-sm">{eventErrorMessage(tills.error, tc('error'))}</p>
          ) : (tills.data ?? []).length === 0 ? (
            <p className="text-muted-foreground p-2 text-sm">{t('noTills')}</p>
          ) : (
            (tills.data ?? []).map((till) => {
              const checked = chosen.machineIds.includes(till.id);
              const busy = till.busy;
              return (
                <label
                  key={till.id}
                  className={cn(
                    'flex cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors',
                    checked && 'bg-[#007AFF]/10',
                    busy && 'cursor-not-allowed opacity-60',
                  )}
                >
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 accent-[#007AFF]"
                    checked={checked}
                    disabled={Boolean(busy)}
                    onChange={(e) => toggle(till.id, e.target.checked)}
                  />
                  <span className="min-w-0">
                    <span className="block truncate font-medium">
                      {till.name}
                      {till.posNumber ? <span className="text-muted-foreground font-normal"> · {t('register', { n: till.posNumber })}</span> : null}
                    </span>
                    {busy ? (
                      <span className="flex items-center gap-1 text-xs text-[#C93400]">
                        <Lock className="h-3 w-3" aria-hidden />
                        {t('busy', {
                          name: busy.eventName,
                          from: clockLabel(busy.startsAt, timeZone, true),
                          to: clockLabel(busy.endsAt, timeZone, true),
                        })}
                      </span>
                    ) : till.areaName ? (
                      <span className="text-muted-foreground block text-xs">{till.areaName}</span>
                    ) : null}
                  </span>
                </label>
              );
            })
          )}
        </div>
        {show('tillsRequired') ? <p className="text-destructive text-xs">{t('errors.tillsRequired')}</p> : null}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="event-producer">{t('producer')}</Label>
          <Input id="event-producer" value={values.producerName} maxLength={120} placeholder={t('producerPlaceholder')}
            onChange={(e) => set('producerName', e.target.value)} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="event-notes">{t('notes')}</Label>
          <Input id="event-notes" value={values.notes} placeholder={t('notesPlaceholder')}
            onChange={(e) => set('notes', e.target.value)} />
        </div>
      </div>

      <div className="rounded-xl border">
        <button
          type="button"
          className="flex w-full items-center justify-between gap-2 px-3 py-2 text-sm font-medium"
          aria-expanded={advanced}
          onClick={() => setAdvanced((a) => !a)}
        >
          <span className="flex items-center gap-2">
            <Settings2 className="h-4 w-4 text-muted-foreground" aria-hidden />
            {t('advanced')}
          </span>
          <ChevronDown className={cn('h-4 w-4 transition-transform', advanced && 'rotate-180')} aria-hidden />
        </button>
        {advanced ? (
          <div className="grid gap-3 border-t p-3 sm:grid-cols-2">
            {(
              [
                ['weakTillPct', '%'],
                ['highTipPct', '%'],
                ['highTipAmount', '₪'],
                ['idleGapMinutes', t('minutes')],
                ['minActiveMinutes', t('minutes')],
              ] as const
            ).map(([key, unit]) => (
              <div key={key} className="grid gap-1">
                <Label htmlFor={`th-${key}`} className="text-xs">{t(`thresholds.${key}`)}</Label>
                <div className="flex items-center gap-2">
                  <Input
                    id={`th-${key}`}
                    type="number"
                    dir="ltr"
                    inputMode="decimal"
                    className="w-28"
                    value={th[key] === null || Number.isNaN(th[key] as number) ? '' : String(th[key])}
                    placeholder={key === 'highTipAmount' ? t('thresholds.off') : undefined}
                    onChange={(e) => setTh(key, e.target.value)}
                  />
                  <span className="text-muted-foreground text-xs">{unit}</span>
                </div>
                <p className="text-muted-foreground text-[11px] leading-snug">{t(`thresholds.${key}Hint`)}</p>
              </div>
            ))}
            {show('thresholdRange') ? <p className="text-destructive text-xs sm:col-span-2">{t('errors.thresholdRange')}</p> : null}
          </div>
        ) : null}
      </div>

      <p className="text-muted-foreground text-xs">{te('reportLevelOnly')}</p>

      <DialogFooter>
        <Button variant="outline" onClick={onClose}>{tc('cancel')}</Button>
        <Button onClick={submit} disabled={save.isPending}>
          {save.isPending ? tc('loading') : isNew ? t('create') : t('save')}
        </Button>
      </DialogFooter>
    </div>
  );
}
