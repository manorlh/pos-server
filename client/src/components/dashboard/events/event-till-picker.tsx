'use client';

/**
 * "שיוך קופות מהיר לאירוע" — the tills picker of the event dialog, the compact "הוסף/הסר קופות"
 * and "שייך לאירוע": a search box, one-tap selectors ("כל הסניף", "רק קופות" / "רק קיוסקים",
 * by area — "נקודת מכירה" — and by device group), "העתק קופות מאירוע קודם", and the tills.
 *
 * A till in an overlapping draft event is never picked by a selector or a copy (they say how
 * many they skipped). Picked by hand it shows that event inline, with "העבר לאירוע הזה"; until
 * it is marked (or unpicked) the caller does not save. The rules: lib/eventTills.ts.
 */

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowLeftRight, Copy, Lock, Search, Store, X } from 'lucide-react';
import type { EventTillsView } from '@/lib/eventTypes';
import { eventErrorMessage } from '@/lib/eventsApi';
import { clockLabel } from '@/lib/eventReport';
import {
  applySelector,
  availableSelectors,
  copyFromEvent,
  searchTills,
  selectorState,
  tillConflicts,
  unresolvedConflicts,
  type TillSelector,
} from '@/lib/eventTills';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export interface EventTillPickerProps {
  view: EventTillsView | undefined;
  loading?: boolean;
  error?: unknown;
  selected: string[];
  moveIds: string[];
  onChange: (selected: string[], moveIds: string[]) => void;
  timeZone: string;
  /** A shorter list (the compact dialogs). */
  compact?: boolean;
  /** Under the toolbar, e.g. "choose the window first". */
  hint?: string | null;
}

export function EventTillPicker({
  view,
  loading,
  error,
  selected,
  moveIds,
  onChange,
  timeZone,
  compact = false,
  hint,
}: EventTillPickerProps) {
  const t = useTranslations('eventTills');
  const tf = useTranslations('events.form');
  const tc = useTranslations('common');
  const [query, setQuery] = useState('');
  const [copyOpen, setCopyOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const tills = useMemo(() => view?.tills ?? [], [view]);
  const groupNames = useMemo(() => new Map((view?.groups ?? []).map((g) => [g.id, g.name])), [view]);
  const chips = useMemo(
    () => availableSelectors({ tills, areas: view?.areas ?? [], groups: view?.groups ?? [] }),
    [tills, view],
  );
  const shown = useMemo(() => searchTills(tills, query, groupNames), [tills, query, groupNames]);
  const conflicts = useMemo(() => tillConflicts(selected, tills, moveIds), [selected, tills, moveIds]);
  const unresolved = unresolvedConflicts(conflicts);
  const conflictOf = new Map(conflicts.map((c) => [c.till.id, c]));
  const recent = view?.recentEvents ?? [];

  const keepMoves = (ids: string[]) => moveIds.filter((id) => ids.includes(id));
  const pick = (selector: TillSelector) => {
    const r = applySelector(selected, tills, selector);
    onChange(r.ids, keepMoves(r.ids));
    setNotice(r.skippedBusy.length ? t('pick.skippedBusy', { count: r.skippedBusy.length }) : null);
  };
  const toggle = (id: string, on: boolean) => {
    const ids = on ? [...selected, id] : selected.filter((x) => x !== id);
    onChange(ids, on ? moveIds : moveIds.filter((x) => x !== id));
  };
  const setMove = (id: string, on: boolean) =>
    onChange(selected, on ? [...new Set([...moveIds, id])] : moveIds.filter((x) => x !== id));
  const copy = (eventId: string) => {
    const source = recent.find((e) => e.id === eventId);
    if (!source) return;
    const r = copyFromEvent(tills, source.machineIds);
    onChange(r.ids, keepMoves(r.ids));
    setCopyOpen(false);
    setNotice(
      [
        t('pick.copied', { count: r.ids.length, name: source.name }),
        r.skippedBusy.length ? t('pick.skippedBusy', { count: r.skippedBusy.length }) : null,
        r.missing ? t('pick.copiedMissing', { count: r.missing }) : null,
      ]
        .filter(Boolean)
        .join(' · '),
    );
  };

  const chip = (key: string, label: string, selector: TillSelector, count?: number) => {
    const state = selectorState(selected, tills, selector);
    return (
      <button
        key={key}
        type="button"
        aria-pressed={state === 'on'}
        onClick={() => pick(selector)}
        className={cn(
          'inline-flex min-h-8 items-center gap-1 rounded-full border px-3 text-xs font-medium transition-colors',
          state === 'on' && 'border-[#007AFF] bg-[#007AFF] text-white',
          state === 'partial' && 'border-[#007AFF] bg-[#007AFF]/10 text-[#007AFF]',
          state === 'off' && 'text-muted-foreground hover:text-foreground',
        )}
      >
        {label}
        {count !== undefined ? <span className="tabular-nums opacity-70">{count}</span> : null}
      </button>
    );
  };

  const busyLine = (b: NonNullable<(typeof tills)[number]['busy']>) =>
    tf('busy', { name: b.eventName, from: clockLabel(b.startsAt, timeZone, true), to: clockLabel(b.endsAt, timeZone, true) });

  return (
    <div className="grid gap-2">
      <div className="relative">
        <Search className="text-muted-foreground pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2" aria-hidden />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('search')}
          aria-label={t('search')}
          className="ps-9 pe-2.5"
        />
      </div>

      {tills.length > 0 ? (
        <div className="grid gap-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            {chip('all', t('pick.all'), { kind: 'all' }, tills.length)}
            {chips.kinds.includes('tills') ? chip('tills', t('pick.tills'), { kind: 'tills' }) : null}
            {chips.kinds.includes('kiosks') ? chip('kiosks', t('pick.kiosks'), { kind: 'kiosks' }) : null}
            {recent.length > 0 ? (
              <button
                type="button"
                aria-expanded={copyOpen}
                onClick={() => setCopyOpen((o) => !o)}
                className="text-muted-foreground hover:text-foreground inline-flex min-h-8 items-center gap-1 rounded-full border border-dashed px-3 text-xs"
              >
                <Copy className="h-3.5 w-3.5" aria-hidden />
                {t('pick.copy')}
              </button>
            ) : null}
            <button
              type="button"
              disabled={selected.length === 0}
              onClick={() => {
                onChange([], []);
                setNotice(null);
              }}
              className="text-muted-foreground hover:text-foreground inline-flex min-h-8 items-center gap-1 px-2 text-xs disabled:opacity-40"
            >
              <X className="h-3.5 w-3.5" aria-hidden />
              {t('pick.clear')}
            </button>
          </div>
          {chips.areas.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t('pick.areas')}>
              <span className="text-muted-foreground inline-flex items-center gap-1 text-[11px]">
                <Store className="h-3 w-3" aria-hidden />
                {t('pick.areas')}
              </span>
              {chips.areas.map((a) => chip(`area-${a.id}`, a.name, { kind: 'area', areaId: a.id }, a.count))}
            </div>
          ) : null}
          {chips.groups.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t('pick.groups')}>
              <span className="text-muted-foreground text-[11px]">{t('pick.groups')}</span>
              {chips.groups.map((g) => chip(`group-${g.id}`, g.name, { kind: 'group', groupId: g.id }, g.count))}
            </div>
          ) : null}
          {copyOpen ? (
            <div className="grid gap-1 rounded-lg border p-1.5">
              {recent.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  onClick={() => copy(e.id)}
                  className="hover:bg-muted flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-start text-sm"
                >
                  <span className="min-w-0 truncate font-medium">{e.name}</span>
                  <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                    {clockLabel(e.startsAt, timeZone, true)} · {e.machineIds.length}
                  </span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {hint ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
      {notice ? (
        <p className="text-muted-foreground text-xs" role="status">
          {notice}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="text-muted-foreground tabular-nums">{t('count', { selected: selected.length, total: tills.length })}</span>
        {unresolved.length > 1 ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onChange(selected, [...new Set([...moveIds, ...unresolved.map((c) => c.till.id)])])}
          >
            <ArrowLeftRight className="h-3.5 w-3.5" aria-hidden />
            {t('moveAll', { count: unresolved.length })}
          </Button>
        ) : null}
      </div>

      <div
        className={cn(
          'grid gap-1 overflow-y-auto rounded-xl border p-2 sm:grid-cols-2',
          compact ? 'max-h-[45dvh]' : 'max-h-72',
        )}
      >
        {loading ? (
          <p className="text-muted-foreground p-2 text-sm">{tc('loading')}</p>
        ) : error ? (
          <p className="text-destructive p-2 text-sm">{eventErrorMessage(error, tc('error'))}</p>
        ) : tills.length === 0 ? (
          <p className="text-muted-foreground p-2 text-sm">{tf('noTills')}</p>
        ) : shown.length === 0 ? (
          <p className="text-muted-foreground p-2 text-sm">{t('noMatch')}</p>
        ) : (
          shown.map((till) => {
            const checked = selected.includes(till.id);
            const conflict = conflictOf.get(till.id);
            return (
              <div
                key={till.id}
                className={cn(
                  'rounded-lg px-2 py-1.5 text-sm transition-colors',
                  checked && !conflict && 'bg-[#007AFF]/10',
                  conflict && !conflict.moving && 'bg-[#FF9500]/10 ring-1 ring-[#FF9500]/40',
                  conflict?.moving && 'bg-[#007AFF]/10 ring-1 ring-[#007AFF]/30',
                )}
              >
                <label className="flex cursor-pointer items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 shrink-0 accent-[#007AFF]"
                    checked={checked}
                    onChange={(e) => toggle(till.id, e.target.checked)}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">
                      {till.name}
                      {till.posNumber ? (
                        <span className="text-muted-foreground font-normal"> · {tf('register', { n: till.posNumber })}</span>
                      ) : null}
                      {till.kind === 'kiosk' ? (
                        <span className="ms-1 rounded bg-muted px-1 text-[10px] font-normal">{t('kiosk')}</span>
                      ) : null}
                    </span>
                    {till.busy && !checked ? (
                      <span className="flex items-center gap-1 text-xs text-[#C93400]">
                        <Lock className="h-3 w-3 shrink-0" aria-hidden />
                        <span className="truncate">{busyLine(till.busy)}</span>
                      </span>
                    ) : !conflict && till.areaName ? (
                      <span className="text-muted-foreground block truncate text-xs">{till.areaName}</span>
                    ) : null}
                  </span>
                </label>
                {conflict ? (
                  <div className="mt-1 grid gap-1 ps-6 text-xs" role="status">
                    {conflict.moving ? (
                      <span className="flex flex-wrap items-center gap-x-2 text-[#007AFF]">
                        <ArrowLeftRight className="h-3 w-3" aria-hidden />
                        {t('moving', { event: conflict.eventName })}
                        <button type="button" className="underline" onClick={() => setMove(till.id, false)}>
                          {t('undoMove')}
                        </button>
                      </span>
                    ) : (
                      <>
                        <span className="text-[#C93400]">
                          {t('conflict', {
                            till: till.name,
                            event: conflict.eventName,
                            from: clockLabel(conflict.startsAt, timeZone, true),
                            to: clockLabel(conflict.endsAt, timeZone, true),
                          })}
                        </span>
                        <span>
                          <Button type="button" size="sm" variant="outline" className="h-7" onClick={() => setMove(till.id, true)}>
                            <ArrowLeftRight className="h-3.5 w-3.5" aria-hidden />
                            {t('moveHere')}
                          </Button>
                        </span>
                      </>
                    )}
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </div>
      {unresolved.length > 0 ? (
        <p className="text-xs text-[#C93400]" role="alert">
          {t('unresolved', { count: unresolved.length })}
        </p>
      ) : null}
    </div>
  );
}
