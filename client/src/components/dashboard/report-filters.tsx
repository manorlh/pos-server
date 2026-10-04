'use client';

/**
 * Filter bar shared by the three windowed reports (products, cashiers, tips).
 *
 * It used to carry shop and machine dropdowns as well. Those are gone: the shop
 * and the device come from the dashboard's shared scope now, so running the same
 * report for the same branch across three pages no longer means re-picking it
 * three times. What is left here is the part that genuinely belongs to a report
 * and not to a position in the hierarchy — the day range and the hour band.
 *
 * Its main job beyond collecting values is making the hour-window semantic
 * impossible to misread. `fromHour`/`toHour` do NOT describe one contiguous
 * stretch of time — they describe the same band of hours on *every* day in the
 * date range. A manager who asks for "18:00–22:00, 1st to 14th" and believes they
 * asked for one 336-hour block has been silently handed fourteen evenings, so the
 * band is shown as a strip labelled "on each day", multiplied by the day count,
 * and spelled out in prose underneath.
 */

import { useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { CalendarClock, Clock, Info } from 'lucide-react';
import { formatHour } from '@/lib/format';
import {
  HOUR_OPTIONS_FROM,
  HOUR_OPTIONS_TO,
  WHOLE_DAY,
  dayCount,
  hourSlots,
  hoursPerDay,
  isValidHourWindow,
  isWholeDay,
  totalHoursCovered,
  wrapsMidnight,
  type HourWindow,
} from '@/lib/reportWindow';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import { AREA_NONE } from '@/lib/api';
import { AreaFilterSelect } from '@/components/dashboard/areas/area-filter';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export interface ReportFiltersState {
  from: string;
  to: string;
  hours: HourWindow;
  /**
   * The report's `areaId`: `''`/absent = every area, `none` = sales of shifts with no
   * area, else an area of the shop in scope. Filters on the shift's stamped area.
   */
  areaId?: string;
}

interface ReportFiltersProps {
  value: ReportFiltersState;
  onChange: (next: ReportFiltersState) => void;
  onRun: () => void;
  isFetching: boolean;
  /** Report-specific extras (e.g. a row-limit select) rendered next to Run. */
  children?: React.ReactNode;
  /**
   * Offer the area filter. Its areas are those of `areaShopId` (the shop in scope);
   * without a shop only "no area" can be picked.
   */
  showArea?: boolean;
  areaShopId?: string | null;
}

/**
 * 24 hour-cells, filled where the band covers them, with the day multiplier
 * beside it. Forced to LTR: this is a time axis, and the app's charts (recharts)
 * already read left-to-right inside the RTL layout, so a right-to-left clock
 * would be the odd one out.
 */
function HourBandStrip({ hours, days }: { hours: HourWindow; days: number }) {
  const t = useTranslations('reports.filters');
  const slots = hourSlots(hours);

  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="min-w-[260px] flex-1 space-y-1" dir="ltr">
        <div className="grid grid-cols-[repeat(24,minmax(0,1fr))] gap-px overflow-hidden rounded-md border">
          {slots.map((on, h) => (
            <div
              key={h}
              title={formatHour(h)}
              className={on ? 'h-4 bg-primary' : 'h-4 bg-muted'}
              aria-hidden
            />
          ))}
        </div>
        <div className="grid grid-cols-[repeat(24,minmax(0,1fr))] text-[10px] text-muted-foreground tabular-nums">
          {slots.map((_, h) => (
            <span key={h} className="text-start">
              {h % 6 === 0 ? h : ''}
            </span>
          ))}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Badge variant="outline" className="gap-1">
          <CalendarClock aria-hidden />
          {t('daysMultiplier', { days })}
        </Badge>
        <span className="text-xs text-muted-foreground">{t('eachDay')}</span>
      </div>
    </div>
  );
}

export function ReportFilters({
  value,
  onChange,
  onRun,
  isFetching,
  children,
  showArea = false,
  areaShopId = null,
}: ReportFiltersProps) {
  const t = useTranslations('reports.filters');

  const set = (patch: Partial<ReportFiltersState>) => onChange({ ...value, ...patch });

  // An area belongs to one shop: when the scope moves to another shop, a chosen area
  // no longer applies ("no area" still does).
  const lastShop = useRef(areaShopId);
  const latest = useRef({ value, onChange });
  useEffect(() => {
    latest.current = { value, onChange };
  });
  useEffect(() => {
    if (lastShop.current === areaShopId) return;
    lastShop.current = areaShopId;
    const { value: v, onChange: change } = latest.current;
    if (v.areaId && v.areaId !== AREA_NONE) change({ ...v, areaId: '' });
  }, [areaShopId]);

  const days = dayCount(value.from, value.to);
  const hoursValid = isValidHourWindow(value.hours);
  const wholeDay = isWholeDay(value.hours);
  const rangeValid = Boolean(value.from) && Boolean(value.to) && days > 0;
  const canRun = rangeValid && hoursValid && !isFetching;

  /** The prose that has to leave no room for the "one contiguous span" reading. */
  const semantic = (() => {
    if (!hoursValid) return { tone: 'error' as const, text: t('semanticInvalid') };
    if (wholeDay) return { tone: 'muted' as const, text: t('semanticWholeDay') };
    const band = `${formatHour(value.hours.fromHour)}–${formatHour(value.hours.toHour)}`;
    if (days === 1) {
      return {
        tone: 'muted' as const,
        text: t('semanticSingleDay', { band, date: value.from }),
      };
    }
    const parts = [
      t('semanticRepeats', {
        days,
        band,
        hoursPerDay: hoursPerDay(value.hours),
        totalHours: totalHoursCovered(value.from, value.to, value.hours),
      }),
    ];
    if (wrapsMidnight(value.hours)) {
      parts.push(
        t('semanticWrap', {
          fromHour: formatHour(value.hours.fromHour),
          toHour: formatHour(value.hours.toHour),
        }),
      );
    }
    return { tone: 'warn' as const, text: parts.join(' ') };
  })();

  return (
    <div className="rounded-lg border bg-card p-4 space-y-4 print:hidden">
      <div className="grid gap-3 md:grid-cols-2 lg:max-w-lg">
        <div className="space-y-1">
          <Label className="text-xs">{t('from')}</Label>
          <Input type="date" value={value.from} onChange={(e) => set({ from: e.target.value })} />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">{t('to')}</Label>
          <Input type="date" value={value.to} onChange={(e) => set({ to: e.target.value })} />
        </div>
      </div>

      <Separator />

      <div className="space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label className="flex items-center gap-1.5 text-xs">
              <Clock className="h-3.5 w-3.5" aria-hidden />
              {t('hoursTitle')}
            </Label>
            <div className="flex items-end gap-2">
              <Select
                value={String(value.hours.fromHour)}
                onValueChange={(v) =>
                  set({ hours: { ...value.hours, fromHour: Number(v ?? 0) } })
                }
                items={HOUR_OPTIONS_FROM.map((h) => ({ value: String(h), label: formatHour(h) }))}
              >
                <SelectTrigger className="w-24">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {HOUR_OPTIONS_FROM.map((h) => (
                    <SelectItem key={h} value={String(h)} label={formatHour(h)}>
                      {formatHour(h)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="pb-1.5 text-muted-foreground">–</span>
              <Select
                value={String(value.hours.toHour)}
                onValueChange={(v) => set({ hours: { ...value.hours, toHour: Number(v ?? 24) } })}
                items={HOUR_OPTIONS_TO.map((h) => ({ value: String(h), label: formatHour(h) }))}
              >
                <SelectTrigger className="w-24">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {HOUR_OPTIONS_TO.map((h) => (
                    <SelectItem key={h} value={String(h)} label={formatHour(h)}>
                      {formatHour(h)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={wholeDay}
                onClick={() => set({ hours: WHOLE_DAY })}
              >
                {t('wholeDayReset')}
              </Button>
            </div>
          </div>
          <p className="pb-1.5 text-xs text-muted-foreground">{t('hoursBoundsHint')}</p>
        </div>

        <HourBandStrip hours={value.hours} days={days} />

        <div
          role="note"
          className={
            semantic.tone === 'warn'
              ? 'flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-900 dark:text-amber-200'
              : semantic.tone === 'error'
                ? 'flex gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive'
                : 'flex gap-2 rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground'
          }
        >
          <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>{semantic.text}</span>
        </div>
      </div>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3">
          {showArea ? (
            <AreaFilterSelect
              shopId={areaShopId}
              value={value.areaId ?? ''}
              onChange={(areaId) => set({ areaId })}
            />
          ) : null}
          {children}
        </div>
        <Button disabled={!canRun} onClick={onRun}>
          {isFetching ? t('running') : t('run')}
        </Button>
      </div>
    </div>
  );
}
