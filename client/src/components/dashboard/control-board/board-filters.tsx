'use client';

/**
 * The control board's filters: company › shop › point of sale › till, the day, and what
 * it is compared with.
 *
 * Everything lives in the URL — the levels as the shared scope's `?company=&shop=&machine=`
 * (so every other page keeps the position), the board's own as `?area=&date=&cmp=&cmpDate=`
 * and the event as `?event=&vsEvent=` (lib/periodCompare.ts) — so a refresh or a shared
 * link opens the same view. An event is one shop's: choosing another company or shop drops it. One change is one URL write (a
 * `push`, so Back undoes it): the levels and the board's params go through the scope
 * provider together.
 *
 * Wide screens: a row of four boxes, the day and the comparison in the header. A phone:
 * one bar ("סינון" + where you are) that opens all of it as a bottom sheet.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronLeft, Filter, RotateCcw } from 'lucide-react';
import { useScope } from '@/lib/scope';
import {
  BOARD_PARAM,
  DEFAULT_COMPARE,
  shiftIsoDay,
  weekdayOf,
  type BoardParams,
  type CompareMode,
} from '@/lib/controlBoard';
import { COMPARE_PARAM } from '@/lib/periodCompare';
import { numberedLabel } from '@/lib/orgNumber';
import { registerNumberOf } from '@/lib/registerNumber';
import { findBySameId, sameId } from '@/lib/entityLookup';
import { formatShortDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { FilterBox, boardSurface, type FilterOption } from './board-ui';

const PICK = '__pick__';

/** "ראשון 5/10", "היום", "אתמול", "ראשון שעבר" — the board's names for its days. */
export function useDayNames(today: string) {
  const t = useTranslations('controlBoard');
  const weekdays = t.raw('weekdays') as string[];
  const short = (day: string) => {
    return t('dayLabel', { weekday: weekdays[weekdayOf(day)] ?? '', date: formatShortDate(day) });
  };
  const relative = (day: string) =>
    day === today ? t('today') : day === shiftIsoDay(today, -1) ? t('yesterday') : short(day);
  /** The compared day, as the comparison names it. */
  const compared = (dayA: string, dayB: string, mode: CompareMode) => {
    if (mode === 'lastWeek') return t('lastWeekDay', { weekday: weekdays[weekdayOf(dayB)] ?? '' });
    return relative(dayB);
  };
  return { short, relative, compared };
}

/** Writes the board's filters; reads the current ones from the URL. */
export function useBoardFilters(board: BoardParams) {
  const scope = useScope();
  const sel = scope.selection;

  const write = (
    levels: { companyId?: string | null; shopId?: string | null; machineId?: string | null },
    extra: Record<string, string | null>,
  ) => scope.setScope(levels, 'push', extra);

  // An event is one shop's: another company or shop is no longer that event.
  const noEvent = { [COMPARE_PARAM.event]: null, [COMPARE_PARAM.vsEvent]: null };

  return {
    setCompany: (companyId: string | null) => write({ companyId }, { [BOARD_PARAM.area]: null, ...noEvent }),
    setShop: (shopId: string | null) => {
      const shop = shopId ? findBySameId(scope.shops, shopId) : undefined;
      write(
        { companyId: shop?.companyId ?? sel.companyId, shopId },
        { [BOARD_PARAM.area]: null, ...(shopId === sel.shopId ? {} : noEvent) },
      );
    },
    setArea: (areaId: string | null) => {
      const machine = sel.machineId ? findBySameId(scope.machines, sel.machineId) : undefined;
      // A till outside the new point of sale is no longer in view.
      const keepMachine = machine && (!areaId || sameId(machine.areaId ?? null, areaId));
      write(
        { companyId: sel.companyId, shopId: sel.shopId, machineId: keepMachine ? sel.machineId : null },
        { [BOARD_PARAM.area]: areaId },
      );
    },
    setMachine: (machineId: string | null) => {
      if (!machineId) {
        write({ ...sel, machineId: null }, {});
        return;
      }
      const machine = findBySameId(scope.machines, machineId);
      const shop = machine?.shopId ? findBySameId(scope.shops, machine.shopId) : undefined;
      write(
        {
          companyId: shop?.companyId ?? sel.companyId,
          shopId: machine?.shopId ?? sel.shopId,
          machineId,
        },
        // Picking a till of another point of sale moves the point of sale with it.
        { [BOARD_PARAM.area]: board.area && machine && sameId(machine.areaId ?? null, board.area) ? board.area : null },
      );
    },
    setDate: (date: string | null) => write(sel, { [BOARD_PARAM.date]: date }),
    setCompare: (cmp: CompareMode, cmpDate: string | null = null) =>
      write(sel, {
        [BOARD_PARAM.cmp]: cmp === DEFAULT_COMPARE ? null : cmp,
        [BOARD_PARAM.cmpDate]: cmp === 'custom' ? cmpDate : null,
      }),
    reset: () =>
      write(
        { companyId: null, shopId: null, machineId: null },
        {
          [BOARD_PARAM.area]: null,
          [BOARD_PARAM.date]: null,
          [BOARD_PARAM.cmp]: null,
          [BOARD_PARAM.cmpDate]: null,
          ...noEvent,
        },
      ),
  };
}

export interface ScopeFilterProps {
  board: BoardParams;
  /** The chosen shop's live points of sale. */
  areas: { id: string; name: string }[];
  /** The point of sale in effect (the URL's, once it is known to be the shop's). */
  areaId: string | null;
}

/** Options and labels for the four scope boxes. */
function useScopeOptions({ areas, areaId }: ScopeFilterProps) {
  const t = useTranslations('controlBoard.filters');
  const tBoard = useTranslations('controlBoard');
  const scope = useScope();
  const all = t('all');

  const companies: FilterOption[] = [
    { value: '', label: all },
    ...scope.tree.flat.map((node) => ({
      value: node.company.id,
      label: numberedLabel(node.company.companyNumber, node.company.name),
      depth: node.depth,
    })),
  ];
  const shops: FilterOption[] = [
    { value: '', label: all },
    ...scope.shopOptions.map((s) => ({ value: s.id, label: numberedLabel(s.shopNumber, s.name) })),
  ];
  const areaOptions: FilterOption[] = [{ value: '', label: all }, ...areas.map((a) => ({ value: a.id, label: a.name }))];
  const machines: FilterOption[] = [
    { value: '', label: all },
    ...scope.machineOptions
      .filter((m) => !areaId || sameId(m.areaId ?? null, areaId))
      .map((m) => {
        const n = registerNumberOf(m);
        return { value: m.id, label: n ? `${tBoard('tillLabel', { number: String(n).padStart(2, '0') })} · ${m.name}` : m.name };
      }),
  ];

  const companyName = scope.company?.name ?? (scope.companyId ? '…' : t('allCompanies'));
  const shopName = scope.shop?.name;
  const areaName = areas.find((a) => a.id === areaId)?.name;
  const machineName = scope.machine?.name;
  // "Runner › רמת גן › הכל"
  const crumbs = [companyName, ...(scope.shopId ? [shopName ?? '…', machineName ?? areaName ?? all] : [])];

  return {
    companies,
    shops,
    areas: areaOptions,
    machines,
    crumbs,
    noAreas: !!scope.shopId && areas.length === 0,
    values: {
      company: scope.companyId ?? '',
      shop: scope.shopId ?? '',
      area: areaId ?? '',
      machine: scope.machineId ?? '',
    },
  };
}

/** Company, shop, point of sale, till: four boxes in a row (or a column, in the sheet). */
export function ScopeBoxes({ className, ...props }: ScopeFilterProps & { className?: string }) {
  const t = useTranslations('controlBoard.filters');
  const scope = useScope();
  const o = useScopeOptions(props);
  const f = useBoardFilters(props.board);
  return (
    <div className={cn('grid gap-3', className)}>
      <FilterBox
        label={t('company')}
        value={o.values.company}
        options={o.companies}
        onChange={(v) => f.setCompany(v || null)}
      />
      <FilterBox
        label={t('shop')}
        value={o.values.shop}
        options={o.shops}
        onChange={(v) => f.setShop(v || null)}
      />
      <FilterBox
        label={t('area')}
        value={o.values.area}
        options={o.areas}
        onChange={(v) => f.setArea(v || null)}
        disabled={!scope.shopId || o.noAreas}
        display={o.noAreas ? t('noAreas') : undefined}
      />
      <FilterBox
        label={t('machine')}
        value={o.values.machine}
        options={o.machines}
        onChange={(v) => f.setMachine(v || null)}
        disabled={o.machines.length <= 1 && !scope.machineId}
      />
    </div>
  );
}

/** A date field (the Hebrew calendar) that takes focus as it appears. */
function DayInput({
  label,
  max,
  initial,
  onPick,
  onCancel,
}: {
  label: string;
  max: string;
  initial: string;
  onPick: (day: string) => void;
  onCancel: () => void;
}) {
  // Focus moving from the field into its calendar (a portal) stays inside; leaving both cancels.
  const leaving = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(leaving.current), []);
  return (
    <div
      className="min-w-0"
      onFocus={() => window.clearTimeout(leaving.current)}
      onBlur={() => {
        leaving.current = window.setTimeout(onCancel, 0);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onCancel();
      }}
    >
      <DatePicker
        autoFocus
        defaultOpen
        aria-label={label}
        max={max}
        value={initial}
        dir="ltr"
        onChange={(e) => {
          // Typing a year digit by digit passes through 0002, 0020…: only a real year counts.
          if (e.target.value >= '2000-01-01' && e.target.value <= max) onPick(e.target.value);
        }}
        className="h-11 rounded-lg bg-cb-card text-sm text-cb-ink ring-2 ring-cb-blue/30"
      />
    </div>
  );
}

/** The day looked at, and what it is compared with. */
export function DayBoxes({
  board,
  today,
  dayA,
  dayB,
  className,
}: {
  board: BoardParams;
  today: string;
  dayA: string;
  dayB: string | null;
  className?: string;
}) {
  const t = useTranslations('controlBoard');
  const names = useDayNames(today);
  const f = useBoardFilters(board);
  const [picking, setPicking] = useState<'date' | 'cmp' | null>(null);
  const yesterday = shiftIsoDay(today, -1);
  const isToday = dayA === today;

  const dateValue = isToday ? '' : dayA;
  const dateOptions: FilterOption[] = [
    { value: '', label: t('today') },
    { value: yesterday, label: t('yesterday') },
    ...(dateValue && dateValue !== yesterday ? [{ value: dateValue, label: names.short(dateValue) }] : []),
    { value: PICK, label: t('pickDate') },
  ];

  const customDay = board.cmp === 'custom' ? board.cmpDate : null;
  const cmpValue = board.cmp === 'custom' ? `custom:${customDay}` : board.cmp;
  const cmpOptions: FilterOption[] = [
    { value: 'none', label: t('compare.none') },
    { value: 'prevDay', label: isToday ? t('compare.prevDay') : t('compare.prevDayOf') },
    { value: 'lastWeek', label: t('compare.lastWeek') },
    ...(customDay ? [{ value: `custom:${customDay}`, label: t('compare.versus', { day: names.relative(customDay) }) }] : []),
    { value: PICK, label: t('compare.custom') },
  ];
  const cmpDisplay =
    board.cmp === 'none' || !dayB ? t('compare.none') : t('compare.versus', { day: names.compared(dayA, dayB, board.cmp) });

  return (
    <div className={cn('grid gap-3', className)}>
      {picking === 'date' ? (
        <DayInput
          label={t('filters.dateInput')}
          max={today}
          initial={dayA}
          onPick={(day) => {
            setPicking(null);
            f.setDate(day === today ? null : day);
          }}
          onCancel={() => setPicking(null)}
        />
      ) : (
        <FilterBox
          label={t('filters.day')}
          value={dateValue}
          options={dateOptions}
          display={names.relative(dayA)}
          onChange={(v) => {
            if (v === PICK) setPicking('date');
            else f.setDate(v || null);
          }}
        />
      )}
      {picking === 'cmp' ? (
        <DayInput
          label={t('filters.compareDateInput')}
          max={today}
          initial={dayB ?? shiftIsoDay(dayA, -1)}
          onPick={(day) => {
            setPicking(null);
            f.setCompare('custom', day);
          }}
          onCancel={() => setPicking(null)}
        />
      ) : (
        <FilterBox
          label={t('filters.compare')}
          value={cmpValue}
          options={cmpOptions}
          display={cmpDisplay}
          onChange={(v) => {
            if (v === PICK) setPicking('cmp');
            else if (v.startsWith('custom:')) f.setCompare('custom', v.slice('custom:'.length));
            else f.setCompare(v as CompareMode);
          }}
        />
      )}
    </div>
  );
}

/**
 * The phone's filter bar: "סינון" and where you are ("Runner › רמת גן › הכל"), the day
 * and the comparison under it; a tap opens the sheet with every filter.
 */
export function PhoneFilterBar({
  board,
  today,
  dayA,
  dayB,
  areas,
  areaId,
  dark,
  eventLine,
  eventSlot,
}: ScopeFilterProps & {
  today: string;
  dayA: string;
  dayB: string | null;
  dark: boolean;
  /** With an event chosen: what the bar says instead of the days ("אירוע: …"). */
  eventLine?: string | null;
  /** The event filter, in the sheet; with an event chosen it replaces the days. */
  eventSlot?: ReactNode;
}) {
  const t = useTranslations('controlBoard');
  const names = useDayNames(today);
  const o = useScopeOptions({ board, areas, areaId });
  const f = useBoardFilters(board);
  const [open, setOpen] = useState(false);
  const crumbs = o.crumbs.join(' › ');
  const when =
    eventLine ??
    [
      names.relative(dayA),
      dayB ? t('compare.versus', { day: names.compared(dayA, dayB, board.cmp) }) : t('compare.none'),
    ].join(' · ');

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={t('filters.openLabel', { scope: `${crumbs} · ${when}` })}
        className="flex min-h-14 w-full items-center gap-3 rounded-2xl border border-cb-line bg-cb-card px-3 py-2 text-start shadow-[var(--cb-shadow)] outline-none focus-visible:ring-2 focus-visible:ring-cb-blue/40 md:hidden"
      >
        <span className="flex h-9 shrink-0 items-center gap-1.5 rounded-xl bg-cb-blue/12 px-2.5 text-sm font-semibold text-cb-blue-ink">
          <Filter className="size-4" aria-hidden />
          {t('filters.open')}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-cb-ink">{crumbs}</span>
          <span className="block truncate text-xs text-cb-muted">{when}</span>
        </span>
        <ChevronLeft className="size-4 shrink-0 text-cb-muted ltr:rotate-180" aria-hidden />
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className={cn(boardSurface(dark), 'bg-cb-card text-cb-ink sm:max-w-md')}>
          <DialogHeader>
            <DialogTitle className="text-lg font-semibold">{t('filters.title')}</DialogTitle>
          </DialogHeader>
          <ScopeBoxes board={board} areas={areas} areaId={areaId} className="grid-cols-1" />
          {eventSlot}
          {eventLine ? null : <DayBoxes board={board} today={today} dayA={dayA} dayB={dayB} className="grid-cols-1" />}
          <DialogFooter className="bg-cb-soft">
            <Button type="button" variant="outline" onClick={() => f.reset()}>
              <RotateCcw aria-hidden />
              {t('filters.reset')}
            </Button>
            <Button type="button" onClick={() => setOpen(false)}>
              {t('filters.done')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

