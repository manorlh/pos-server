'use client';

/**
 * The owner: "גם בענן — שלא יפריע לעבודה, ויהיה חלון קטן באמצע המסך".
 *
 * The immediate feedback of a send: ONE small popup centred on the screen — "נשלחה פקודה:
 * סנכרון → קופה 2", live "ממתין" → "התקבל" → "בוצע ✓" (or "נכשל" with "נסה שוב"). Several sends
 * in a row stack as lines of the same popup. No backdrop, no overlay, no focus trap: only the
 * popup itself takes pointer events, so the page stays fully usable and more commands can be sent
 * while it shows. It leaves on its own (3 s after "בוצע"; a command still waiting after 5 s
 * shrinks into "פקודות שנשלחו"), or by its ✕. The rules: lib/deviceCommands.ts (`inPopup`).
 */
import { useEffect, useState } from 'react';
import { RotateCcw, X } from 'lucide-react';

import { popupItems, popupLine, popupStatus } from '@/lib/deviceCommands';
import { canRetry, closeCommandPopup, retryCommand, sweepCommandPopup, useDeviceCommandsStore } from '@/lib/deviceCommandsStore';
import { cn } from '@/lib/utils';
import { CommandPhaseIcon, commandToneClass } from './command-chip';

const TICK_MS = 500;

/**
 * "now" for the popup: ticks only while something may be in it, and forgets the lines that left
 * (so the tick stops once the popup is empty).
 */
function usePopupClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => {
      const at = Date.now();
      setNow(at);
      sweepCommandPopup(at);
    }, TICK_MS);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

export function DeviceCommandPopup() {
  const commands = useDeviceCommandsStore((s) => s.commands);
  const now = usePopupClock(commands.some((c) => c.popupAt != null));
  const items = popupItems(commands, now);
  return (
    <div
      className="pointer-events-none fixed inset-x-0 top-1/2 z-50 flex -translate-y-1/2 justify-center px-4 print:hidden"
      dir="rtl"
    >
      {/* Always mounted (empty when nothing shows), so screen readers hear each change politely. */}
      <div role="status" aria-live="polite" aria-atomic="false" className="w-full max-w-[360px]">
        {items.length > 0 ? (
          <section
            aria-label="פקודה נשלחה"
            className="pointer-events-auto overflow-hidden rounded-xl border bg-popover/95 text-popover-foreground shadow-xl backdrop-blur-sm"
          >
            <ul className="max-h-[50vh] divide-y overflow-y-auto overscroll-contain">
              {items.map((c) => (
                <li key={c.key} className="flex items-start gap-2 px-3 py-2.5 text-sm">
                  <span className={cn('mt-0.5 inline-flex rounded-full border p-1', commandToneClass(c))}>
                    <CommandPhaseIcon c={c} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{popupLine(c)}</p>
                    <p
                      className={cn(
                        'text-xs',
                        c.sendError || c.phase === 'failed' || c.phase === 'expired'
                          ? 'text-red-700 dark:text-red-300'
                          : c.phase === 'done'
                            ? 'text-emerald-700 dark:text-emerald-300'
                            : 'text-muted-foreground',
                      )}
                    >
                      {popupStatus(c)}
                    </p>
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
                  <button
                    type="button"
                    onClick={() => closeCommandPopup(c.key)}
                    aria-label="סגור"
                    className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted"
                  >
                    <X className="size-3.5" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </div>
  );
}
