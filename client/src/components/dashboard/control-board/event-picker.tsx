'use client';

/**
 * "אירוע": the board's event filter — a box like the other filters that opens a searchable
 * list of the events in the user's shops (`GET /reports/event-options`). A chosen event is
 * the board's period and tills (its window, its tills — docs/SPEC_EVENTS.md); "בלי אירוע"
 * goes back to days. The choice lives in the URL (`?event=`), written by the caller.
 */

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { CalendarClock, Check, ChevronDown, Search, X } from 'lucide-react';
import { fetchEventOptions, type EventBrief } from '@/lib/compareApi';
import { normalizeNavText } from '@/lib/navigation';
import { formatShortDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { boardSurface } from './board-ui';

/** Every event the user may filter by; shared by the board's and the comparisons' pickers. */
export function useEventOptions(enabled: boolean) {
  return useQuery({
    queryKey: ['event-options'],
    queryFn: () => fetchEventOptions(),
    enabled,
    staleTime: 60_000,
  });
}

export function useEventWhen() {
  const t = useTranslations('controlBoard.event');
  return (e: EventBrief) =>
    e.startDate === e.endDate
      ? t('when', { date: formatShortDate(e.startDate), from: e.startTime, to: e.endTime })
      : t('whenAcross', {
          date: formatShortDate(e.startDate),
          from: e.startTime,
          endDate: formatShortDate(e.endDate),
          to: e.endTime,
        });
}

export function EventPicker({
  value,
  events,
  loading,
  onChange,
  label,
  title,
  excludeId,
  dark,
  className,
}: {
  value: string | null;
  events: EventBrief[];
  loading: boolean;
  onChange: (event: EventBrief | null) => void;
  /** The box's label ("אירוע"). */
  label: string;
  /** The sheet's title. */
  title: string;
  /** An event that may not be picked here (the one already compared). */
  excludeId?: string | null;
  dark: boolean;
  className?: string;
}) {
  const t = useTranslations('controlBoard.event');
  const when = useEventWhen();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const chosen = events.find((e) => e.id === value) ?? null;

  const shown = useMemo(() => {
    const q = normalizeNavText(query.trim());
    return events.filter(
      (e) =>
        e.id !== excludeId &&
        (!q || normalizeNavText(`${e.name} ${e.shopName ?? ''}`).includes(q)),
    );
  }, [events, excludeId, query]);

  const pick = (e: EventBrief | null) => {
    setOpen(false);
    setQuery('');
    onChange(e);
  };

  return (
    <>
      <div
        className={cn(
          'relative flex h-11 min-w-0 items-center rounded-xl border border-cb-line bg-cb-card text-sm shadow-[var(--cb-shadow)] transition-colors hover:border-cb-blue/50',
          value && 'border-cb-blue/60 bg-cb-blue/6',
          className,
        )}
      >
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-haspopup="dialog"
          className="flex h-full min-w-0 flex-1 items-center gap-1.5 px-3 text-start outline-none focus-visible:ring-2 focus-visible:ring-cb-blue/30 rounded-xl"
        >
          <CalendarClock className="size-4 shrink-0 text-cb-muted" aria-hidden />
          <span className="shrink-0 text-cb-muted">{label}:</span>
          <span className="min-w-0 flex-1 truncate font-semibold text-cb-ink">
            {chosen ? chosen.name : value ? '…' : t('none')}
          </span>
          {value ? null : <ChevronDown className="size-4 shrink-0 text-cb-muted" aria-hidden />}
        </button>
        {value ? (
          <button
            type="button"
            onClick={() => pick(null)}
            aria-label={t('clear')}
            title={t('clear')}
            className="flex size-11 shrink-0 items-center justify-center rounded-e-xl text-cb-muted hover:text-cb-ink"
          >
            <X className="size-4" aria-hidden />
          </button>
        ) : null}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className={cn(boardSurface(dark), 'bg-cb-card text-cb-ink sm:max-w-md')}>
          <DialogHeader>
            <DialogTitle className="text-lg font-semibold">{title}</DialogTitle>
          </DialogHeader>
          <div className="relative">
            <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-cb-muted" aria-hidden />
            <Input
              type="search"
              inputMode="search"
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('searchPlaceholder')}
              aria-label={t('search')}
              className="h-11 rounded-xl border-cb-line bg-cb-card ps-9 text-base md:text-sm"
            />
          </div>
          <ul className="-mx-1 max-h-[55dvh] overflow-y-auto" role="listbox" aria-label={title}>
            <li>
              <button
                type="button"
                role="option"
                aria-selected={!value}
                onClick={() => pick(null)}
                className="flex min-h-12 w-full items-center gap-2 rounded-lg px-3 text-start text-sm hover:bg-cb-soft"
              >
                <span className="flex-1 font-medium">{t('clear')}</span>
                {!value ? <Check className="size-4 text-cb-blue-ink" aria-hidden /> : null}
              </button>
            </li>
            {loading ? (
              <li className="px-3 py-4 text-sm text-cb-muted">{t('loading')}</li>
            ) : events.length === 0 ? (
              <li className="px-3 py-4 text-sm text-cb-muted">{t('empty')}</li>
            ) : shown.length === 0 ? (
              <li className="px-3 py-4 text-sm text-cb-muted">{t('noMatch')}</li>
            ) : (
              shown.map((e) => (
                <li key={e.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={e.id === value}
                    onClick={() => pick(e)}
                    className="flex min-h-14 w-full items-center gap-3 rounded-lg px-3 py-2 text-start hover:bg-cb-soft"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold">{e.name}</span>
                      <span className="block truncate text-xs text-cb-muted">
                        {[when(e), e.shopName, t('tills', { count: e.machineIds.length })].filter(Boolean).join(' · ')}
                      </span>
                    </span>
                    <span
                      className={cn(
                        'shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium',
                        e.status === 'confirmed' ? 'bg-cb-green/15 text-cb-green-ink' : 'bg-cb-soft text-cb-muted',
                      )}
                    >
                      {e.status === 'confirmed' ? t('confirmed') : t('draft')}
                    </span>
                    {e.id === value ? <Check className="size-4 shrink-0 text-cb-blue-ink" aria-hidden /> : null}
                  </button>
                </li>
              ))
            )}
          </ul>
        </DialogContent>
      </Dialog>
    </>
  );
}
