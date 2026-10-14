'use client';

/**
 * "פתיחה אוטומטית" (pos-server app/services/autostart.py): green "מוכן" (and how), yellow "חסר אישור
 * במכשיר", grey "כבוי" — nothing for a device that never reported. In "תקינות מכשירים", the devices
 * list and the device page. The rules and the Hebrew are lib/autoStart.ts.
 */

import { Power } from 'lucide-react';
import { AUTO_START_TITLE, autoStartView, type AutoStartStatus, type AutoStartTone } from '@/lib/autoStart';
import { cn } from '@/lib/utils';

const TONE_STYLE: Record<AutoStartTone, string> = {
  ok: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  warn: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  muted: 'bg-muted text-muted-foreground',
};

/** The chip alone; null when unknown. */
export function AutoStartBadge({ status, className }: { status: AutoStartStatus | null | undefined; className?: string }) {
  const view = autoStartView(status);
  if (!view) return null;
  return (
    <span
      className={cn('inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium', TONE_STYLE[view.tone], className)}
      title={`${AUTO_START_TITLE}: ${view.label}\n${view.hint}`}
    >
      <Power className="h-3 w-3 shrink-0" aria-hidden />
      {view.label}
    </span>
  );
}

/** "פתיחה אוטומטית: [chip]" — a card's line; null when unknown. */
export function AutoStartLine({ status, className }: { status: AutoStartStatus | null | undefined; className?: string }) {
  if (!autoStartView(status)) return null;
  return (
    <span className={cn('inline-flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground', className)}>
      {AUTO_START_TITLE}:
      <AutoStartBadge status={status} />
    </span>
  );
}
