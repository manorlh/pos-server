'use client';

/**
 * The dashboard's date and time fields — a Hebrew calendar instead of the browser's.
 *
 * A native `<input type="date">` draws its calendar and its text in the browser's
 * language, so on an English Windows the owner got "10/07/2026" (month first) and an
 * English month grid starting on Monday. These fields are Israeli everywhere: the day is
 * typed and shown as dd/mm/yyyy, the calendar is right-to-left with Hebrew month and day
 * names and the week starts on Sunday, times are on the 24-hour clock, and "today" is
 * Israel's today. Quick ranges (היום, אתמול, 7 ימים אחרונים, החודש…) appear when the
 * field is one end of a range.
 *
 * The value is untouched: `DatePicker` hands back "2026-10-07", `DateTimePicker`
 * "2026-10-07T14:30" and `TimeInput` "14:30" — the strings the native inputs produced —
 * and `onChange` receives `{ target: { value } }` like the native event, so a page swaps
 * `<Input type="date">` for `<DatePicker>` and keeps its handler and its API query.
 * Pure logic lives in lib/calendar.ts and lib/format.ts.
 */

import * as React from 'react';
import { Popover as PopoverPrimitive } from '@base-ui/react/popover';
import { useTranslations } from 'next-intl';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  HEBREW_MONTHS,
  HEBREW_WEEKDAYS_SHORT,
  addDaysIso,
  businessToday,
  dateInputText,
  formatLongDate,
  parseDateInput,
  parseTimeInput,
} from '@/lib/format';
import {
  RANGE_PRESETS,
  inRange,
  matchingPreset,
  monthGrid,
  monthOf,
  outOfBounds,
  presetRange,
  shiftMonth,
  type DayRange,
  type YearMonth,
} from '@/lib/calendar';

/** What the native input's `onChange` carried, so existing handlers keep working. */
export interface DateChangeEvent {
  target: { value: string };
}

export type { DayRange };

interface FieldProps {
  id?: string;
  name?: string;
  className?: string;
  disabled?: boolean;
  required?: boolean;
  placeholder?: string;
  title?: string;
  autoFocus?: boolean;
  'aria-label'?: string;
  'aria-invalid'?: boolean | 'true' | 'false';
  'aria-describedby'?: string;
  /** Accepted for drop-in compatibility; the digits always run left to right. */
  dir?: string;
  onBlur?: () => void;
}

const FIELD =
  'h-full w-full min-w-0 rounded-lg border border-input bg-transparent py-1 text-base tabular-nums transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40';

const WRAPPER = 'relative h-8 w-full min-w-0 pointer-coarse:h-10';

function emitTo(
  value: string,
  onChange?: (e: DateChangeEvent) => void,
  onValueChange?: (value: string) => void,
) {
  onChange?.({ target: { value } });
  onValueChange?.(value);
}

/* ─────────────────────────────── The month grid ─────────────────────────────── */

interface CalendarProps {
  selected?: string;
  range?: Partial<DayRange> | null;
  min?: string;
  max?: string;
  today: string;
  onPick: (iso: string) => void;
}

function CalendarMonth({ selected, range, min, max, today, onPick }: CalendarProps) {
  const t = useTranslations('datePicker');
  const start = (selected && monthOf(selected) ? selected : null) ?? (range?.from && monthOf(range.from) ? range.from : null) ?? today;
  const [shown, setShown] = React.useState<YearMonth>(() => monthOf(start)!);
  const [view, setView] = React.useState<'days' | 'months'>('days');
  const [focusIso, setFocusIso] = React.useState(start);
  const gridRef = React.useRef<HTMLDivElement>(null);
  const keyboardMove = React.useRef(false);

  React.useEffect(() => {
    if (!keyboardMove.current) return;
    keyboardMove.current = false;
    gridRef.current?.querySelector<HTMLButtonElement>(`[data-iso="${focusIso}"]`)?.focus();
  }, [focusIso, shown]);

  const moveFocus = (iso: string) => {
    keyboardMove.current = true;
    setFocusIso(iso);
    const ym = monthOf(iso)!;
    if (ym.year !== shown.year || ym.month !== shown.month) setShown(ym);
  };

  const onGridKey = (e: React.KeyboardEvent) => {
    // The grid is right-to-left: the arrow pointing left walks forward in time.
    const step: Record<string, number> = { ArrowLeft: 1, ArrowRight: -1, ArrowUp: -7, ArrowDown: 7 };
    if (e.key in step) {
      e.preventDefault();
      moveFocus(addDaysIso(focusIso, step[e.key]));
    } else if (e.key === 'PageUp' || e.key === 'PageDown') {
      e.preventDefault();
      const target = shiftMonth(monthOf(focusIso)!, e.key === 'PageUp' ? -1 : 1);
      const day = Math.min(Number(focusIso.slice(8, 10)), 28);
      moveFocus(`${target.year}-${String(target.month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      const weekday = new Date(`${focusIso}T00:00:00Z`).getUTCDay();
      moveFocus(addDaysIso(focusIso, e.key === 'Home' ? -weekday : 6 - weekday));
    }
  };

  const header = (label: string, onLabel: (() => void) | null, delta: number) => (
    <div className="mb-2 flex items-center justify-between gap-1">
      <button
        type="button"
        className="inline-flex size-7 items-center justify-center rounded-md hover:bg-muted"
        aria-label={view === 'days' ? t('prevMonth') : String(shown.year - 1)}
        onClick={() => setShown((s) => shiftMonth(s, -delta))}
      >
        <ChevronRight className="size-4" aria-hidden />
      </button>
      {onLabel ? (
        <button type="button" className="rounded-md px-2 py-0.5 text-sm font-semibold hover:bg-muted" onClick={onLabel}>
          {label}
        </button>
      ) : (
        <span className="px-2 py-0.5 text-sm font-semibold">{label}</span>
      )}
      <button
        type="button"
        className="inline-flex size-7 items-center justify-center rounded-md hover:bg-muted"
        aria-label={view === 'days' ? t('nextMonth') : String(shown.year + 1)}
        onClick={() => setShown((s) => shiftMonth(s, delta))}
      >
        <ChevronLeft className="size-4" aria-hidden />
      </button>
    </div>
  );

  if (view === 'months') {
    return (
      <div dir="rtl" className="w-64">
        {header(String(shown.year), null, 12)}
        <div className="grid grid-cols-3 gap-1">
          {HEBREW_MONTHS.map((name, i) => {
            const current = selected && monthOf(selected)?.year === shown.year && monthOf(selected)?.month === i + 1;
            return (
              <button
                key={name}
                type="button"
                className={cn(
                  'rounded-md py-2 text-sm hover:bg-muted',
                  current && 'bg-primary text-primary-foreground hover:bg-primary/90',
                )}
                onClick={() => {
                  setShown({ year: shown.year, month: i + 1 });
                  setView('days');
                }}
              >
                {name}
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  const weeks = monthGrid(shown);
  const focusInView = weeks.some((w) => w.some((d) => d.iso === focusIso && d.inMonth));
  return (
    <div dir="rtl" className="w-64">
      {header(`${HEBREW_MONTHS[shown.month - 1]} ${shown.year}`, () => setView('months'), 1)}
      <div ref={gridRef} role="grid" aria-label={`${HEBREW_MONTHS[shown.month - 1]} ${shown.year}`} onKeyDown={onGridKey}>
        <div role="row" className="mb-1 grid grid-cols-7 text-center text-xs text-muted-foreground">
          {HEBREW_WEEKDAYS_SHORT.map((d) => (
            <span key={d} role="columnheader" className="py-1">
              {d}
            </span>
          ))}
        </div>
        {weeks.map((week) => (
          <div role="row" key={week[0].iso} className="grid grid-cols-7">
            {week.map((d) => {
              const disabled = outOfBounds(d.iso, min, max);
              const isSelected = d.iso === selected;
              const isEdge = Boolean(range && (d.iso === range.from || d.iso === range.to));
              const between = inRange(d.iso, range);
              const tabbable = focusInView ? d.iso === focusIso : d.inMonth && d.day === 1;
              return (
                <span role="gridcell" key={d.iso} aria-selected={isSelected || undefined} className="p-px">
                  <button
                    type="button"
                    data-iso={d.iso}
                    tabIndex={tabbable ? 0 : -1}
                    disabled={disabled}
                    aria-label={formatLongDate(d.iso)}
                    aria-current={d.iso === today ? 'date' : undefined}
                    onClick={() => onPick(d.iso)}
                    onFocus={() => setFocusIso(d.iso)}
                    className={cn(
                      'h-8 w-full rounded-md text-sm tabular-nums outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-30',
                      !d.inMonth && 'text-muted-foreground/60',
                      between && 'rounded-none bg-primary/10',
                      d.iso === today && 'font-bold underline underline-offset-4',
                      (isSelected || isEdge) && 'rounded-md bg-primary text-primary-foreground hover:bg-primary/90',
                    )}
                  >
                    {d.day}
                  </button>
                </span>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─────────────────────────────── DatePicker ─────────────────────────────── */

export interface DatePickerProps extends FieldProps {
  /** "2026-10-07", or '' for none. */
  value: string | null | undefined;
  onChange?: (e: DateChangeEvent) => void;
  onValueChange?: (value: string) => void;
  min?: string;
  max?: string;
  /**
   * This field is one end of a range: the calendar shades the range and lists the quick
   * ranges (היום, אתמול, 7 ימים אחרונים…), which set both ends through `onSelect`. A quick
   * range replaces both ends, so it ignores this field's `min`/`max` (usually the other
   * end); `range.min`/`range.max` bound it instead.
   */
  range?: { from: string; to: string; onSelect: (range: DayRange) => void; today?: string; min?: string; max?: string };
  /** Open the calendar as soon as the field mounts (a field shown on demand). */
  defaultOpen?: boolean;
}

export function DatePicker({
  value,
  onChange,
  onValueChange,
  min,
  max,
  range,
  defaultOpen,
  id,
  name,
  className,
  disabled,
  required,
  placeholder,
  title,
  autoFocus,
  onBlur,
  'aria-label': ariaLabel,
  'aria-invalid': ariaInvalid,
  'aria-describedby': ariaDescribedBy,
}: DatePickerProps) {
  const t = useTranslations('datePicker');
  const [draft, setDraft] = React.useState<string | null>(null);
  const [open, setOpen] = React.useState(Boolean(defaultOpen) && !disabled);
  const wrapperRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const iso = value ?? '';
  const text = draft ?? dateInputText(iso);
  const today = range?.today ?? businessToday();
  const minDay = min?.slice(0, 10) || undefined;
  const maxDay = max?.slice(0, 10) || undefined;
  const draftInvalid = draft !== null && draft.trim() !== '' && parseDateInput(draft) === null;
  const invalid = draftInvalid || (iso !== '' && outOfBounds(iso, minDay, maxDay)) || ariaInvalid === true || ariaInvalid === 'true';

  const emit = (v: string) => {
    if (v !== iso) emitTo(v, onChange, onValueChange);
  };

  const commit = () => {
    if (draft === null) return;
    if (draft.trim() === '') {
      emit('');
      setDraft(null);
      return;
    }
    const parsed = parseDateInput(draft);
    if (parsed) {
      emit(parsed);
      setDraft(null);
    }
  };

  const pick = (day: string) => {
    setDraft(null);
    emit(day);
    setOpen(false);
  };

  const presetsActive = range ? matchingPreset(range, today) : null;

  return (
    <PopoverPrimitive.Root
      open={open}
      onOpenChange={(next, details) => {
        // A click or focus back into the text box is not "outside": keep the calendar open while typing.
        const event = details.event as (Event & { relatedTarget?: EventTarget | null }) | undefined;
        const target = (details.reason === 'focus-out' ? event?.relatedTarget : event?.target) as Node | null | undefined;
        const intoField = Boolean(target && wrapperRef.current?.contains(target));
        if (!next && intoField && (details.reason === 'outside-press' || details.reason === 'focus-out')) return;
        setOpen(next);
      }}
    >
      <div ref={wrapperRef} className={cn(WRAPPER, 'min-w-36', className)}>
        <input
          ref={inputRef}
          id={id}
          name={name}
          type="text"
          dir="ltr"
          inputMode="numeric"
          autoComplete="off"
          title={title ?? (draftInvalid ? t('invalid') : undefined)}
          autoFocus={autoFocus}
          disabled={disabled}
          required={required}
          placeholder={placeholder ?? t('placeholder')}
          aria-label={ariaLabel}
          aria-invalid={invalid || undefined}
          aria-describedby={ariaDescribedBy}
          value={text}
          className={cn(FIELD, 'pr-2.5 pl-9 text-right')}
          onChange={(e) => {
            const next = e.target.value;
            setDraft(next);
            // A full four-digit year (or eight digits) is a finished day — hand it over as typed,
            // like the native field; a two-digit year waits for the blur.
            const parsed = parseDateInput(next);
            if (parsed && (/\d{4}\s*$/.test(next) || /^\d{8}$/.test(next.trim()))) emit(parsed);
            if (next.trim() === '') emit('');
          }}
          onClick={() => {
            if (!disabled) setOpen(true);
          }}
          onBlur={() => {
            commit();
            onBlur?.();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'ArrowDown' && !disabled) {
              e.preventDefault();
              setOpen(true);
            }
            if (e.key === 'Escape' && open) setOpen(false);
          }}
        />
        <PopoverPrimitive.Trigger
          type="button"
          disabled={disabled}
          aria-label={t('openCalendar')}
          className="absolute inset-y-0 left-0 inline-flex w-8 items-center justify-center rounded-s-lg text-muted-foreground hover:text-foreground disabled:opacity-50"
        >
          <CalendarDays className="size-4" aria-hidden />
        </PopoverPrimitive.Trigger>
      </div>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Positioner anchor={wrapperRef} side="bottom" align="start" sideOffset={4} className="isolate z-50">
          <PopoverPrimitive.Popup
            dir="rtl"
            initialFocus={false}
            finalFocus={inputRef}
            className="z-50 flex max-w-[calc(100vw-2rem)] flex-col gap-3 rounded-lg bg-popover p-3 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none sm:flex-row"
          >
            {range ? (
              <div className="flex flex-wrap gap-1 border-b pb-2 sm:w-36 sm:flex-col sm:flex-nowrap sm:border-b-0 sm:border-l sm:pb-0 sm:pl-2">
                <span className="w-full px-2 text-xs font-medium text-muted-foreground">{t('quickRanges')}</span>
                {RANGE_PRESETS.map((key) => (
                  <button
                    key={key}
                    type="button"
                    className={cn(
                      'rounded-md px-2 py-1 text-start text-sm hover:bg-muted',
                      presetsActive === key && 'bg-primary/10 font-semibold text-primary',
                    )}
                    onClick={() => {
                      setDraft(null);
                      range.onSelect(presetRange(key, today, range.min, range.max));
                      setOpen(false);
                    }}
                  >
                    {t(`presets.${key}`)}
                  </button>
                ))}
              </div>
            ) : null}
            <div className="flex flex-col gap-2">
              <CalendarMonth
                selected={iso || undefined}
                range={range ? { from: range.from, to: range.to } : null}
                min={minDay}
                max={maxDay}
                today={today}
                onPick={pick}
              />
              <div className="flex items-center justify-between border-t pt-2">
                <button
                  type="button"
                  className="rounded-md px-2 py-1 text-sm text-primary hover:bg-muted disabled:opacity-40"
                  disabled={outOfBounds(today, minDay, maxDay)}
                  onClick={() => pick(today)}
                >
                  {t('today')}
                </button>
                {!required && iso ? (
                  <button
                    type="button"
                    className="rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-muted"
                    onClick={() => pick('')}
                  >
                    {t('clear')}
                  </button>
                ) : null}
              </div>
            </div>
          </PopoverPrimitive.Popup>
        </PopoverPrimitive.Positioner>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

/* ─────────────────────────────── TimeInput ─────────────────────────────── */

export interface TimeInputProps extends FieldProps {
  /** "14:30", or '' for none. */
  value: string | null | undefined;
  onChange?: (e: DateChangeEvent) => void;
  onValueChange?: (value: string) => void;
  /** Accepted for drop-in compatibility with `<input type="time">`. */
  step?: number;
  min?: string;
  max?: string;
}

/** A 24-hour "HH:mm" field — never AM/PM, whatever the browser's language. */
export function TimeInput({
  value,
  onChange,
  onValueChange,
  id,
  name,
  className,
  disabled,
  required,
  placeholder,
  title,
  autoFocus,
  onBlur,
  'aria-label': ariaLabel,
  'aria-invalid': ariaInvalid,
  'aria-describedby': ariaDescribedBy,
}: TimeInputProps) {
  const t = useTranslations('datePicker');
  const [draft, setDraft] = React.useState<string | null>(null);
  const current = (value ?? '').slice(0, 5);
  const text = draft ?? current;
  const draftInvalid = draft !== null && draft.trim() !== '' && parseTimeInput(draft) === null;

  const emit = (v: string) => {
    if (v !== current) emitTo(v, onChange, onValueChange);
  };
  const commit = () => {
    if (draft === null) return;
    if (draft.trim() === '') {
      emit('');
      setDraft(null);
      return;
    }
    const parsed = parseTimeInput(draft);
    if (parsed) {
      emit(parsed);
      setDraft(null);
    }
  };

  return (
    <div className={cn(WRAPPER, 'min-w-20', className)}>
      <input
        id={id}
        name={name}
        type="text"
        dir="ltr"
        inputMode="numeric"
        autoComplete="off"
        maxLength={5}
        title={title ?? (draftInvalid ? t('invalidTime') : undefined)}
        autoFocus={autoFocus}
        disabled={disabled}
        required={required}
        placeholder={placeholder ?? t('timePlaceholder')}
        aria-label={ariaLabel}
        aria-invalid={draftInvalid || ariaInvalid === true || ariaInvalid === 'true' || undefined}
        aria-describedby={ariaDescribedBy}
        value={text}
        className={cn(FIELD, 'px-2.5 text-center')}
        onChange={(e) => {
          const next = e.target.value;
          setDraft(next);
          // "14:30" or "1430" is a finished time; "14" may still grow.
          if (/^\d{1,2}[:.]\d{2}$|^\d{4}$/.test(next.trim())) {
            const parsed = parseTimeInput(next);
            if (parsed) emit(parsed);
          }
          if (next.trim() === '') emit('');
        }}
        onBlur={() => {
          commit();
          onBlur?.();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
        }}
      />
    </div>
  );
}

/* ─────────────────────────────── DateTimePicker ─────────────────────────────── */

export interface DateTimePickerProps extends FieldProps {
  /** "2026-10-07T14:30" (what `datetime-local` held), or '' for none. */
  value: string | null | undefined;
  onChange?: (e: DateChangeEvent) => void;
  onValueChange?: (value: string) => void;
  /** "2026-10-07T00:00" or a plain day — the calendar keeps to the days. */
  min?: string;
  max?: string;
  step?: number;
}

/** A day from the Hebrew calendar and a 24-hour time beside it. */
export function DateTimePicker({
  value,
  onChange,
  onValueChange,
  min,
  max,
  id,
  className,
  disabled,
  required,
  'aria-label': ariaLabel,
  'aria-invalid': ariaInvalid,
  onBlur,
}: DateTimePickerProps) {
  const t = useTranslations('datePicker');
  const current = value ?? '';
  const day = /^\d{4}-\d{2}-\d{2}/.test(current) ? current.slice(0, 10) : '';
  const time = day ? current.slice(11, 16) : '';
  // A time typed before any day is held until a day is picked.
  const [pendingTime, setPendingTime] = React.useState('');

  const emit = (nextDay: string, nextTime: string) => {
    const v = nextDay ? `${nextDay}T${nextTime || '00:00'}` : '';
    if (v !== current) emitTo(v, onChange, onValueChange);
  };

  return (
    <div className={cn('flex w-full min-w-0 items-center gap-2', className)}>
      <DatePicker
        id={id}
        value={day}
        min={min}
        max={max}
        disabled={disabled}
        required={required}
        aria-label={ariaLabel}
        aria-invalid={ariaInvalid}
        onBlur={onBlur}
        onValueChange={(d) => emit(d, time || pendingTime)}
        className="flex-1"
      />
      <TimeInput
        value={day ? time : pendingTime}
        disabled={disabled}
        aria-label={ariaLabel ? `${ariaLabel} — ${t('time')}` : t('time')}
        onValueChange={(tm) => (day ? emit(day, tm) : setPendingTime(tm))}
        className="w-20 shrink-0"
      />
    </div>
  );
}
