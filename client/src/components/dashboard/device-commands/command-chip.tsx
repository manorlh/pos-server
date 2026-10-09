'use client';

/**
 * "פקודה נשלחה: סנכרון · ממתין" — the small status chip on a device's row (ארגון → מכשירים, the
 * kiosks page, the cockpit's devices strip, remote control). Reads the shared store
 * (lib/deviceCommandsStore.ts); renders nothing when the device has no recent command.
 * Never blocks anything: a click opens the "פקודות שנשלחו" tray.
 */
import { useEffect, useState } from 'react';
import { AlertTriangle, Check, Clock, Loader2, X } from 'lucide-react';

import { chipText, latestForMachine, phaseTone, type TrackedCommand } from '@/lib/deviceCommands';
import { useDeviceCommandsStore } from '@/lib/deviceCommandsStore';
import { cn } from '@/lib/utils';

const TONE: Record<'wait' | 'ok' | 'bad' | 'muted', string> = {
  wait: 'border-sky-400/60 bg-sky-50 text-sky-800 dark:border-sky-500/40 dark:bg-sky-950/40 dark:text-sky-200',
  ok: 'border-emerald-400/60 bg-emerald-50 text-emerald-800 dark:border-emerald-500/40 dark:bg-emerald-950/40 dark:text-emerald-200',
  bad: 'border-red-400/60 bg-red-50 text-red-800 dark:border-red-500/40 dark:bg-red-950/40 dark:text-red-200',
  muted: 'border-border bg-muted text-muted-foreground',
};

export function CommandPhaseIcon({ c, className }: { c: Pick<TrackedCommand, 'phase' | 'sendError'>; className?: string }) {
  const cls = cn('size-3.5 shrink-0', className);
  if (c.sendError) return <AlertTriangle className={cls} aria-hidden />;
  switch (c.phase) {
    case 'sending':
    case 'sent':
      return <Loader2 className={cn(cls, 'animate-spin')} aria-hidden />;
    case 'received':
      return <Clock className={cls} aria-hidden />;
    case 'done':
      return <Check className={cls} aria-hidden />;
    case 'cancelled':
      return <X className={cls} aria-hidden />;
    default:
      return <AlertTriangle className={cls} aria-hidden />;
  }
}

export function commandToneClass(c: Pick<TrackedCommand, 'phase' | 'sendError'>): string {
  return TONE[c.sendError ? 'bad' : phaseTone(c.phase)];
}

/** Re-render every few seconds so a finished command leaves the row on time. */
export function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

export function DeviceCommandChip({ machineId, className }: { machineId: string; className?: string }) {
  const commands = useDeviceCommandsStore((s) => s.commands);
  const setTrayOpen = useDeviceCommandsStore((s) => s.setTrayOpen);
  const now = useNow(5_000);
  const c = latestForMachine(commands, machineId, now);
  if (!c) return null;
  const text = chipText(c);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        setTrayOpen(true);
      }}
      title={text}
      aria-label={text}
      className={cn(
        'inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4',
        commandToneClass(c),
        className,
      )}
    >
      <CommandPhaseIcon c={c} />
      <span className="truncate">{text}</span>
    </button>
  );
}
