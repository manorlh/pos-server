'use client';

/**
 * "פקודות שנשלחו" — one global, non-blocking tray of the commands this session sent to devices,
 * with their status (נשלח → התקבל במכשיר → בוצע / נכשל / פג תוקף). Mounted once in the dashboard
 * layout: a small pill at the bottom corner (only once something was sent), that opens a panel
 * above it — never an overlay, never a focus trap, never over the work area as a whole.
 *
 * It also runs the background read (lib/deviceCommandsStore.ts `pollDeviceCommands`): quickly
 * right after a send, slower later, not at all when nothing waits; an answer refreshes the
 * page's lists, and a failure is a non-blocking toast with "נסה שוב" where that makes sense.
 */
import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { RotateCcw, Send, Trash2, X } from 'lucide-react';

import { agoLabel, inPopup, isFinal, openCount, PHASE_LABELS, pollDelayMs, type TrackedCommand } from '@/lib/deviceCommands';
import {
  canRetry,
  clearFinished,
  dismissCommand,
  pollDeviceCommands,
  REFRESH_PREFIXES,
  retryCommand,
  useDeviceCommandsStore,
} from '@/lib/deviceCommandsStore';
import { cn } from '@/lib/utils';
import { CommandPhaseIcon, commandToneClass, useNow } from './command-chip';

const IDLE_CHECK_MS = 2_000;

function statusText(c: TrackedCommand): string {
  if (c.sendError) return `לא נשלח — ${c.sendError}`;
  const phase = c.phase === 'sent' ? 'נשלח · ממתין' : PHASE_LABELS[c.phase];
  return c.detail ? `${phase} — ${c.detail}` : phase;
}

/** The background read, once for the whole dashboard. */
function useDeviceCommandsPoller() {
  const qc = useQueryClient();
  const qcRef = useRef(qc);
  qcRef.current = qc;
  useEffect(() => {
    void useDeviceCommandsStore.persist.rehydrate();
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (stopped) return;
      const delay = pollDelayMs(useDeviceCommandsStore.getState().commands, Date.now());
      if (delay == null) {
        timer = setTimeout(schedule, IDLE_CHECK_MS); // nothing waits: no request at all
        return;
      }
      const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
      timer = setTimeout(async () => {
        if (stopped) return;
        try {
          const changed = await pollDeviceCommands();
          if (changed.length > 0) onChanged(changed);
        } catch {
          // read again next time
        } finally {
          schedule();
        }
      }, hidden ? delay * 4 : delay);
    };
    const onChanged = (changed: TrackedCommand[]) => {
      const prefixes = new Set(changed.flatMap((c) => REFRESH_PREFIXES[c.kind]));
      void qcRef.current.invalidateQueries({
        predicate: (q) => typeof q.queryKey[0] === 'string' && prefixes.has(q.queryKey[0] as string),
      });
      for (const c of changed) {
        if (c.phase !== 'failed' && c.phase !== 'expired') continue;
        if (inPopup(c, Date.now())) continue; // the centred popup says it, with "נסה שוב"
        const who = c.machineName ? ` · ${c.machineName}` : '';
        toast.error(`${c.label}${who}: ${statusText(c)}`, {
          id: `device-command:${c.key}`,
          ...(canRetry(c) ? { action: { label: 'נסה שוב', onClick: () => retryCommand(c.key) } } : {}),
        });
      }
    };
    schedule();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, []);
}

export function DeviceCommandsTray() {
  useDeviceCommandsPoller();
  const commands = useDeviceCommandsStore((s) => s.commands);
  const open = useDeviceCommandsStore((s) => s.trayOpen);
  const setOpen = useDeviceCommandsStore((s) => s.setTrayOpen);
  const now = useNow(15_000);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setOpen]);

  if (commands.length === 0) return null;
  const waiting = openCount(commands);
  const failed = commands.filter((c) => c.sendError != null || c.phase === 'failed' || c.phase === 'expired').length;

  return (
    <div className="pointer-events-none fixed bottom-3 end-3 z-40 flex flex-col items-end gap-2 print:hidden" dir="rtl">
      {open ? (
        <section
          role="region"
          aria-label="פקודות שנשלחו"
          className="pointer-events-auto flex max-h-[min(60vh,28rem)] w-[min(24rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-lg"
        >
          <header className="flex items-center gap-2 border-b px-3 py-2">
            <Send className="size-4 text-muted-foreground" aria-hidden />
            <h2 className="flex-1 text-sm font-semibold">פקודות שנשלחו</h2>
            {commands.some((c) => isFinal(c.phase) || c.sendError) ? (
              <button
                type="button"
                onClick={() => clearFinished()}
                className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground hover:bg-muted"
              >
                <Trash2 className="size-3.5" aria-hidden />
                נקה שהסתיימו
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="סגור"
              className="rounded-md p-1 text-muted-foreground hover:bg-muted"
            >
              <X className="size-4" aria-hidden />
            </button>
          </header>
          <ul className="min-h-0 flex-1 divide-y overflow-y-auto overscroll-contain">
            {commands.map((c) => (
              <li key={c.key} className="flex items-start gap-2 px-3 py-2 text-sm">
                <span className={cn('mt-0.5 inline-flex rounded-full border p-1', commandToneClass(c))}>
                  <CommandPhaseIcon c={c} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="truncate font-medium">{c.label}</span>
                    {c.machineName ? <span className="truncate text-xs text-muted-foreground">{c.machineName}</span> : null}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    <span className={cn(c.sendError || c.phase === 'failed' || c.phase === 'expired' ? 'text-red-700 dark:text-red-300' : c.phase === 'done' ? 'text-emerald-700 dark:text-emerald-300' : '')}>
                      {statusText(c)}
                    </span>
                    <span> · {agoLabel(c.sentAt, now)}</span>
                  </div>
                </div>
                {canRetry(c) ? (
                  <button
                    type="button"
                    onClick={() => retryCommand(c.key)}
                    className="inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted"
                  >
                    <RotateCcw className="size-3.5" aria-hidden />
                    נסה שוב
                  </button>
                ) : null}
                {isFinal(c.phase) || c.sendError ? (
                  <button
                    type="button"
                    onClick={() => dismissCommand(c.key)}
                    aria-label="הסר מהרשימה"
                    className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted"
                  >
                    <X className="size-3.5" aria-hidden />
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className={cn(
          'pointer-events-auto inline-flex items-center gap-2 rounded-full border bg-background/95 px-3 py-1.5 text-xs font-medium shadow-md backdrop-blur',
          failed > 0 && waiting === 0 ? 'border-red-400/60' : '',
        )}
      >
        <Send className="size-3.5" aria-hidden />
        פקודות שנשלחו
        {waiting > 0 ? (
          <span className="inline-flex min-w-5 items-center justify-center gap-1 rounded-full bg-sky-600 px-1.5 text-[10px] text-white">
            {waiting} ממתין
          </span>
        ) : null}
        {failed > 0 ? (
          <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-red-600 px-1.5 text-[10px] text-white">{failed}</span>
        ) : null}
      </button>
    </div>
  );
}
