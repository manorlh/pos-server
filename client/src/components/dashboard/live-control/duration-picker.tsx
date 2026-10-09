'use client';

/**
 * "לכמה זמן": presets (15 דק׳ … 4 שעות), "עד סוף היום", custom minutes, "עד שעה", "עד שאבטל" —
 * and the end the server computes in the shop's zone ("חסום עד 14:35"), with a clear warning
 * when a passed "עד שעה" rolled to tomorrow.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Clock } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import {
  DURATION_PRESETS,
  durationValid,
  formatUntil,
  parseHhmm,
  parseMinutes,
  presetLabel,
  type DurationChoice,
} from '@/lib/liveControl';
import { previewEnd } from '@/lib/liveControlApi';
import { useTick } from './active-blocks';

type Pick = { kind: 'preset'; minutes: number } | { kind: 'custom' } | { kind: 'time' } | { kind: 'end_of_day' } | { kind: 'none' };

export function DurationPicker({
  value,
  onChange,
  shopId,
  verb = 'עד',
}: {
  value: DurationChoice;
  onChange: (next: DurationChoice) => void;
  shopId?: string | null;
  /** The word before the end in the summary ("חסום עד", "מוסתר עד"). */
  verb?: string;
}) {
  const [pick, setPick] = useState<Pick>(() =>
    value.mode === 'minutes' && value.minutes && (DURATION_PRESETS as readonly number[]).includes(value.minutes)
      ? { kind: 'preset', minutes: value.minutes }
      : value.mode === 'minutes'
        ? { kind: 'custom' }
        : value.mode === 'time'
          ? { kind: 'time' }
          : value.mode === 'end_of_day'
            ? { kind: 'end_of_day' }
            : { kind: 'none' },
  );
  const [minutesText, setMinutesText] = useState(value.mode === 'minutes' && value.minutes ? String(value.minutes) : '');
  const [timeText, setTimeText] = useState(value.at ?? '');

  const emit = (p: Pick, minutes: string, time: string) => {
    setPick(p);
    setMinutesText(minutes);
    setTimeText(time);
    if (p.kind === 'preset') onChange({ mode: 'minutes', minutes: p.minutes });
    else if (p.kind === 'custom') onChange({ mode: 'minutes', minutes: parseMinutes(minutes) ?? undefined });
    else if (p.kind === 'time') onChange({ mode: 'time', at: parseHhmm(time) ?? undefined });
    else if (p.kind === 'end_of_day') onChange({ mode: 'end_of_day' });
    else onChange({ mode: 'none' });
  };

  const now = useTick(30_000);
  const ready = durationValid(value) && value.mode !== 'none';
  const preview = useQuery({
    queryKey: ['item-blocks', 'end-preview', value.mode, value.minutes ?? null, value.at ?? null, shopId ?? null],
    queryFn: () => previewEnd(value, shopId),
    enabled: ready,
    staleTime: 20_000,
    refetchInterval: 30_000,
  });

  const chip = (active: boolean) =>
    cn(
      'min-h-10 rounded-full border px-3 text-sm transition-colors',
      active ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-background hover:bg-muted',
    );

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2" role="group" aria-label="לכמה זמן">
        {DURATION_PRESETS.map((m) => (
          <button key={m} type="button" className={chip(pick.kind === 'preset' && pick.minutes === m)} onClick={() => emit({ kind: 'preset', minutes: m }, minutesText, timeText)}>
            {presetLabel(m)}
          </button>
        ))}
        <button type="button" className={chip(pick.kind === 'end_of_day')} onClick={() => emit({ kind: 'end_of_day' }, minutesText, timeText)}>
          עד סוף היום
        </button>
        <button type="button" className={chip(pick.kind === 'custom')} onClick={() => emit({ kind: 'custom' }, minutesText, timeText)}>
          דקות
        </button>
        <button type="button" className={chip(pick.kind === 'time')} onClick={() => emit({ kind: 'time' }, minutesText, timeText)}>
          עד שעה
        </button>
        <button type="button" className={chip(pick.kind === 'none')} onClick={() => emit({ kind: 'none' }, minutesText, timeText)}>
          עד שאבטל
        </button>
      </div>
      {pick.kind === 'custom' ? (
        <Input
          inputMode="numeric"
          dir="ltr"
          placeholder="מספר דקות"
          value={minutesText}
          onChange={(e) => emit(pick, e.target.value, timeText)}
          className="h-11 max-w-40"
          aria-label="מספר דקות"
        />
      ) : null}
      {pick.kind === 'time' ? (
        <Input
          type="time"
          dir="ltr"
          value={timeText}
          onChange={(e) => emit(pick, minutesText, e.target.value)}
          className="h-11 max-w-40"
          aria-label="עד שעה"
        />
      ) : null}
      <p className="flex items-center gap-1.5 text-sm text-muted-foreground" aria-live="polite">
        <Clock className="size-4" aria-hidden />
        {value.mode === 'none'
          ? 'עד שאבטל'
          : !ready
            ? 'בחרו משך'
            : preview.data?.until
              ? `${verb} ${formatUntil(preview.data.until, now) ?? ''}`
              : '…'}
      </p>
      {preview.data?.rolled ? (
        <p className="flex items-center gap-1.5 rounded-lg bg-amber-100 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          <AlertTriangle className="size-4 shrink-0" aria-hidden />
          השעה שבחרתם כבר עברה היום — זה יסתיים מחר בשעה הזו.
        </p>
      ) : null}
    </div>
  );
}
