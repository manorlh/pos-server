'use client';

/**
 * Echo of the window the *server* actually used, shown above every windowed report.
 *
 * Two things here are not decoration. The timezone is resolved server-side
 * (tz param → tenant setting → Asia/Jerusalem), so the reader must be told which
 * zone their hours were measured in rather than assuming their own. And when an
 * hour filter is active, `windowStart`/`windowEnd` are the bounds of the outer day
 * range only — the hours actually covered are a subset of that span, which is said
 * out loud rather than left to be inferred.
 */

import { useTranslations } from 'next-intl';
import { CalendarRange, Clock, Globe, Info, Scissors } from 'lucide-react';
import type { ReportWindowOut } from '@/lib/types';
import { formatDate, formatDateTime, formatDateTimeInZone, formatHour, formatQuantity } from '@/lib/format';
import { dayCount } from '@/lib/reportWindow';
import { Badge } from '@/components/ui/badge';

function hasHourFilter(w: ReportWindowOut): boolean {
  return w.fromHour !== null && w.fromHour !== undefined
    && w.toHour !== null && w.toHour !== undefined;
}

export function ReportWindowSummary({
  window: w,
  generatedAt,
}: {
  window: ReportWindowOut;
  generatedAt: string;
}) {
  const t = useTranslations('reports.window');
  const days = dayCount(w.from, w.to);
  const hourly = hasHourFilter(w);
  const band = hourly ? `${formatHour(w.fromHour!)}–${formatHour(w.toHour!)}` : null;
  const wraps = hourly && w.fromHour! > w.toHour!;

  return (
    <div className="rounded-lg border bg-muted/30 p-3 space-y-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary" className="gap-1">
          <CalendarRange aria-hidden />
          {t('dayRange', { from: formatDate(w.from), to: formatDate(w.to), days })}
        </Badge>
        <Badge variant={hourly ? 'default' : 'outline'} className="gap-1">
          <Clock aria-hidden />
          {hourly ? t('hourBandEachDay', { band: band! }) : t('wholeDay')}
        </Badge>
        <Badge variant="outline" className="gap-1">
          <Globe aria-hidden />
          {t('timezone', { tz: w.timezone })}
        </Badge>
      </div>

      {hourly && days > 1 ? (
        <p className="text-xs text-muted-foreground">
          {t('subsetNote', { days, band: band! })}
          {wraps ? ` ${t('wrapNote')}` : ''}
        </p>
      ) : null}

      <p className="text-xs text-muted-foreground">
        {t('absoluteBounds', {
          start: formatDateTimeInZone(w.windowStart, w.timezone),
          end: formatDateTimeInZone(w.windowEnd, w.timezone),
          tz: w.timezone,
        })}
      </p>
      <p className="text-xs text-muted-foreground">
        {t('generatedAt', { at: formatDateTime(generatedAt) })}
      </p>
    </div>
  );
}

/**
 * Shown when the server trimmed the row tail. Totals are computed over ALL rows
 * before the cap, so the visible rows genuinely will not add up to the totals —
 * which is stated here, because the alternative is a reader quietly concluding
 * the numbers are wrong.
 */
export function ReportTruncatedNotice({
  rowLimit,
  visibleRows,
  totalCount,
}: {
  rowLimit: number;
  visibleRows: number;
  totalCount?: number;
}) {
  const t = useTranslations('reports.truncated');
  return (
    <div
      role="status"
      className="flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-900 dark:text-amber-200"
    >
      <Scissors className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div className="space-y-1">
        <p className="font-semibold">{t('title', { rowLimit, visibleRows })}</p>
        <p>
          {totalCount !== undefined
            ? t('bodyWithCount', { totalCount: formatQuantity(totalCount) })
            : t('body')}
        </p>
      </div>
    </div>
  );
}

/** Uniform error state for a report that failed to load. */
export function ReportErrorState({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="flex gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive"
    >
      <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <span>{message}</span>
    </div>
  );
}
