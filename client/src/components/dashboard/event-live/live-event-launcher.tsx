'use client';

/**
 * `LiveEventLauncher` — for the Manager Cockpit: opens "מצב אירוע חי" full screen, in place,
 * for the scope's event; with only a shop (or nothing), for the one event live now. With none
 * or several live, it goes to the picker (`/dashboard/live-event`).
 *
 * Two ways in: its own button (the default), or `autoLaunch` — the cockpit's quick-actions bar
 * already was the tap, so it goes straight on with no button of its own (the cockpit's
 * `liveEvent` slot, cockpit/event-live-slots.tsx).
 */

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { Loader2, MonitorPlay } from 'lucide-react';
import { autoOpenEvent } from '@/lib/eventLive';
import { fetchCurrentLiveEvents } from '@/lib/eventLiveApi';
import { cn } from '@/lib/utils';
import { LiveScreen } from './live-screen';
import type { CockpitProps } from './types';

/** The picker of the live events (of a shop, when the scope has one). */
function pickerHref(shopId: string | null | undefined): string {
  return shopId ? `/dashboard/live-event?shop=${encodeURIComponent(shopId)}` : '/dashboard/live-event';
}

export function LiveEventLauncher({
  autoLaunch = false,
  ...props
}: CockpitProps & { className?: string; autoLaunch?: boolean }) {
  return autoLaunch ? <AutoLaunch {...props} /> : <LauncherButton {...props} />;
}

function LauncherButton({ scope, onDone, className }: CockpitProps & { className?: string }) {
  const t = useTranslations('eventLive');
  const router = useRouter();
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const launch = async () => {
    if (scope.eventId) {
      setOpen(scope.eventId);
      return;
    }
    setBusy(true);
    try {
      const events = await fetchCurrentLiveEvents(scope.shopId ?? null);
      const only = autoOpenEvent(events);
      if (only) setOpen(only);
      else router.push(pickerHref(scope.shopId));
    } catch {
      router.push('/dashboard/live-event');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => void launch()}
        disabled={busy}
        className={cn(
          'inline-flex min-h-11 items-center gap-2 rounded-full border border-[#FF3B30]/40 px-4 text-sm font-semibold text-[#FF3B30] hover:bg-[#FF3B30]/10 disabled:opacity-60',
          className,
        )}
      >
        {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <MonitorPlay className="size-4" aria-hidden />}
        {t('openLive')}
      </button>
      {open ? (
        <LiveScreen
          eventId={open}
          onClose={() => {
            setOpen(null);
            onDone?.();
          }}
        />
      ) : null}
    </>
  );
}

/** Opened already: the scope's event, else the one live now, on the live screen — or the picker. */
function AutoLaunch({ scope, onDone }: CockpitProps) {
  const router = useRouter();
  const current = useQuery({
    queryKey: ['live-events-current', scope.shopId ?? null],
    queryFn: () => fetchCurrentLiveEvents(scope.shopId ?? null),
    enabled: !scope.eventId,
    retry: false,
  });
  const eventId = scope.eventId ?? (current.data ? autoOpenEvent(current.data) : null);
  const toPicker = !scope.eventId && (current.isError || (current.isSuccess && !eventId));
  const sent = useRef(false);
  useEffect(() => {
    if (!toPicker || sent.current) return;
    sent.current = true;
    router.push(current.isError ? '/dashboard/live-event' : pickerHref(scope.shopId));
    onDone?.();
  }, [current.isError, onDone, router, scope.shopId, toPicker]);
  return eventId ? <LiveScreen eventId={eventId} onClose={() => onDone?.()} /> : null;
}
