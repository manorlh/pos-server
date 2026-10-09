'use client';

/**
 * `LiveEventLauncher` — for the Manager Cockpit: opens "מצב אירוע חי" full screen, in place,
 * for the scope's event; with only a shop (or nothing), for the one event live now. With none
 * or several live, it goes to the picker (`/dashboard/live-event`).
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Loader2, MonitorPlay } from 'lucide-react';
import { autoOpenEvent } from '@/lib/eventLive';
import { fetchCurrentLiveEvents } from '@/lib/eventLiveApi';
import { cn } from '@/lib/utils';
import { LiveScreen } from './live-screen';
import type { CockpitProps } from './types';

export function LiveEventLauncher({ scope, onDone, className }: CockpitProps & { className?: string }) {
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
      else router.push(scope.shopId ? `/dashboard/live-event?shop=${encodeURIComponent(scope.shopId)}` : "/dashboard/live-event");
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
