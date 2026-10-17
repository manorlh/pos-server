'use client';

/**
 * "שעון המכשיר" (pos-server app/services/clock_trust.py): whether the device stamps documents with the server's time,
 * whether it fixes its own clock (`clockAutoFix`), and its last fix. Nothing for a device that never reported. In the
 * device page's health panel and "תקינות מכשירים". The rules and the Hebrew are lib/clockTrust.ts.
 */

import { Clock } from 'lucide-react';
import { clockTrustView, type ClockTrustStatus, type ClockTrustTone } from '@/lib/clockTrust';
import { cn } from '@/lib/utils';

const TONE_STYLE: Record<ClockTrustTone, string> = {
  ok: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  warn: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  muted: 'bg-muted text-muted-foreground',
};

/** The chip: "מסמכים לפי שעון השרת" (yellow) / "…המכשיר"; the auto-fix and the last fix in its title. */
export function ClockTrustBadge({
  status,
  skewMs,
  className,
}: {
  status: ClockTrustStatus | null | undefined;
  skewMs: number | null | undefined;
  className?: string;
}) {
  const view = clockTrustView(status, skewMs);
  if (!view) return null;
  return (
    <span
      className={cn('inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium', TONE_STYLE[view.tone], className)}
      title={[view.hint, view.fix, view.lastFix].filter(Boolean).join('\n')}
    >
      <Clock className="h-3 w-3 shrink-0" aria-hidden />
      {view.documents}
    </span>
  );
}

/** The health panel's lines: the chip, the auto-fix, the last fix. */
export function ClockTrustLines({ status, skewMs }: { status: ClockTrustStatus | null | undefined; skewMs: number | null | undefined }) {
  const view = clockTrustView(status, skewMs);
  if (!view) return null;
  return (
    <div className="flex flex-col items-end gap-0.5 text-xs text-muted-foreground">
      <ClockTrustBadge status={status} skewMs={skewMs} />
      <span>{view.fix}</span>
      {view.lastFix ? <span>{view.lastFix}</span> : null}
    </div>
  );
}
