'use client';

/**
 * The cockpit's scope header: what the manager runs — a shop or an event, as one big picker —
 * and the day; company, point of sale and till under "מתקדם". Everything in the URL, through
 * the board's own filters (board-filters.tsx), so a refresh or a shared link opens the same
 * place. Phone first: one column; from `md` the picker and the day side by side.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, SlidersHorizontal } from 'lucide-react';
import type { BoardParams } from '@/lib/controlBoard';
import { cn } from '@/lib/utils';
import { Segmented } from '@/components/dashboard/control-board/board-ui';
import { DayBoxes, ScopeBoxes } from '@/components/dashboard/control-board/board-filters';

export function CockpitScopeHeader({
  board,
  today,
  dayA,
  dayB,
  areas,
  areaId,
  eventId,
  canPickEvent,
  eventPickers,
  onClearEvent,
}: {
  board: BoardParams;
  today: string;
  dayA: string;
  dayB: string | null;
  areas: { id: string; name: string }[];
  areaId: string | null;
  /** The URL's event, when the cockpit runs one. */
  eventId: string | null;
  /** Events need the reports (their figures are sales). */
  canPickEvent: boolean;
  /** The event pickers (the event, and what it is compared with). */
  eventPickers: React.ReactNode;
  /** Back to a shop: drops the event. */
  onClearEvent: () => void;
}) {
  const t = useTranslations('controlBoard.cockpit.scope');
  const [wantEvent, setWantEvent] = useState(false);
  const mode: 'shop' | 'event' = eventId || wantEvent ? 'event' : 'shop';
  const [advanced, setAdvanced] = useState(false);

  return (
    <section aria-label={t('label')} className="space-y-3 rounded-2xl border border-cb-line bg-cb-card p-3 shadow-[var(--cb-shadow)] md:p-4">
      {canPickEvent ? (
        <Segmented
          label={t('label')}
          value={mode}
          onChange={(next) => {
            setWantEvent(next === 'event');
            if (next === 'shop' && eventId) onClearEvent();
          }}
          options={[
            { id: 'shop', label: t('shop') },
            { id: 'event', label: t('event') },
          ]}
        />
      ) : null}

      <div className="grid gap-3 md:grid-cols-2">
        {mode === 'event' ? (
          <div className="grid gap-3">{eventPickers}</div>
        ) : (
          <ScopeBoxes board={board} areas={areas} areaId={areaId} fields={['shop']} className="grid-cols-1" boxClassName="h-14 text-base" />
        )}
        {mode === 'event' ? null : <DayBoxes board={board} today={today} dayA={dayA} dayB={dayB} className="grid-cols-2" />}
      </div>

      <button
        type="button"
        onClick={() => setAdvanced((v) => !v)}
        aria-expanded={advanced}
        className="inline-flex min-h-10 items-center gap-1.5 text-sm font-medium text-cb-muted hover:text-cb-ink"
      >
        <SlidersHorizontal className="size-4" aria-hidden />
        {t('advanced')}
        <ChevronDown className={cn('size-4 transition-transform', advanced && 'rotate-180')} aria-hidden />
      </button>
      {advanced ? (
        <ScopeBoxes
          board={board}
          areas={areas}
          areaId={areaId}
          fields={['company', 'area', 'machine']}
          className="grid-cols-1 md:grid-cols-3"
        />
      ) : null}
    </section>
  );
}
