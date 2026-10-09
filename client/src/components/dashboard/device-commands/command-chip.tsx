'use client';

/**
 * "פקודה נשלחה: סנכרון · ממתין" — the small status chip on a device's row (ארגון → מכשירים, the
 * kiosks page, the cockpit's devices strip, remote control). Reads the shared store
 * (lib/deviceCommandsStore.ts); renders nothing when the device has no recent command.
 * Never blocks anything: a click opens the "פקודות שנשלחו" tray.
 */
import { useCallback, useSyncExternalStore } from 'react';
import { AlertTriangle, Check, Clock, Loader2, X } from 'lucide-react';

import { chipText, latestForMachine, phaseTone, type TrackedCommand } from '@/lib/deviceCommands';
import { useDeviceCommandsStore, useVisibleCommands } from '@/lib/deviceCommandsStore';
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

// ── One shared clock per period (not one interval per chip) ─────────────────

interface Ticker {
  now: number;
  subs: Set<() => void>;
  timer: ReturnType<typeof setInterval> | null;
}

const tickers = new Map<number, Ticker>();

function tickerOf(everyMs: number): Ticker {
  let t = tickers.get(everyMs);
  if (!t) {
    t = { now: Date.now(), subs: new Set(), timer: null };
    tickers.set(everyMs, t);
  }
  return t;
}

/**
 * "now", re-read every [everyMs] by ONE interval shared by every component asking that period;
 * [active] false: no subscription at all (a row with no command never re-renders on the clock).
 */
export function useNow(everyMs: number, active = true): number {
  const subscribe = useCallback(
    (onTick: () => void) => {
      if (!active) return () => undefined;
      const t = tickerOf(everyMs);
      t.subs.add(onTick);
      if (t.timer == null) {
        t.now = Date.now();
        t.timer = setInterval(() => {
          t.now = Date.now();
          for (const f of t.subs) f();
        }, everyMs);
      }
      return () => {
        t.subs.delete(onTick);
        if (t.subs.size === 0 && t.timer != null) {
          clearInterval(t.timer);
          t.timer = null;
        }
      };
    },
    [everyMs, active],
  );
  const snapshot = useCallback(() => tickerOf(everyMs).now, [everyMs]);
  return useSyncExternalStore(subscribe, snapshot, () => 0);
}

export function DeviceCommandChip({ machineId, className }: { machineId: string; className?: string }) {
  const commands = useVisibleCommands();
  const setTrayOpen = useDeviceCommandsStore((s) => s.setTrayOpen);
  const mine = commands.some((x) => x.machineId === machineId);
  const now = useNow(5_000, mine);
  const c = mine ? latestForMachine(commands, machineId, now) : null;
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
