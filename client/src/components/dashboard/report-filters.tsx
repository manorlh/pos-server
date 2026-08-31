'use client';

/**
 * Filter bar shared by the three windowed reports (products, cashiers, tips).
 *
 * Its main job beyond collecting values is making the hour-window semantic
 * impossible to misread. `fromHour`/`toHour` do NOT describe one contiguous
 * stretch of time — they describe the same band of hours on *every* day in the
 * date range. A manager who asks for "18:00–22:00, 1st to 14th" and believes they
 * asked for one 336-hour block has been silently handed fourteen evenings, so the
 * band is shown as a strip labelled "on each day", multiplied by the day count,
 * and spelled out in prose underneath.
 */

import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { CalendarClock, Clock, Info } from 'lucide-react';
import { api } from '@/lib/api';
import { entitySelectItems } from '@/lib/selectItems';
import { normalizePosMachine } from '@/lib/posMachine';
import type { PosMachine, Shop } from '@/lib/types';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export const ALL = 'all';

export interface ReportFiltersState {
  from: string;
  to: string;
  shopId: string;
  machineId: string;
  hours: HourWindow;
}

interface ReportFiltersProps {
  value: ReportFiltersState;
  onChange: (next: ReportFiltersState) => void;
  onRun: () => void;
  isFetching: boolean;
  /** Report-specific extras (e.g. a row-limit select) rendered next to Run. */
  children?: React.ReactNode;
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
}: ReportFiltersProps) {
  const t = useTranslations('reports.filters');

  const { data: shops = [] } = useQuery<Shop[]>({
    queryKey: ['shops'],
    queryFn: () => api.get('/shops').then((r) => r.data),
  });

  const { data: machines = [] } = useQuery<PosMachine[]>({
    queryKey: ['machines'],
    queryFn: async () => {
      const { data } = await api.get('/machines');
      const list = Array.isArray(data) ? data : [];
      return list.map((row: Record<string, unknown>) => normalizePosMachine(row));
    },
  });

  const set = (patch: Partial<ReportFiltersState>) => onChange({ ...value, ...patch });

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
    <div className="rounded-lg border bg-card p-4 space-y-4">
      <div className="grid gap-3 md:grid-cols-4">
        <div className="space-y-1">
          <Label className="text-xs">{t('shop')}</Label>
          <Select
            value={value.shopId}
            onValueChange={(v) => set({ shopId: v ?? ALL })}
            items={[{ value: ALL, label: t('allShops') }, ...entitySelectItems(shops)]}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL} label={t('allShops')}>
                {t('allShops')}
              </SelectItem>
              {shops.map((s) => (
                <SelectItem key={s.id} value={s.id} label={s.name}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">{t('machine')}</Label>
          <Select
            value={value.machineId}
            onValueChange={(v) => set({ machineId: v ?? ALL })}
            items={[{ value: ALL, label: t('allMachines') }, ...entitySelectItems(machines)]}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL} label={t('allMachines')}>
                {t('allMachines')}
              </SelectItem>
              {machines.map((m) => (
                <SelectItem key={m.id} value={m.id} label={m.name}>
                  {m.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
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
        <div className="flex flex-wrap items-end gap-3">{children}</div>
        <Button disabled={!canRun} onClick={onRun}>
          {isFetching ? t('running') : t('run')}
        </Button>
      </div>
    </div>
  );
}
