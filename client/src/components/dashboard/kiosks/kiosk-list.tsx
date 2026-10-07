'use client';

/**
 * The kiosks and their live status: a table on a desktop, cards on a phone. A kiosk that
 * is not connected shows its last reported numbers marked as such — "0 orders" from an
 * unreachable kiosk is never presented as an idle one.
 */

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { formatDistanceStrict } from 'date-fns';
import { he } from 'date-fns/locale';
import { AlertTriangle, ImageOff, PauseCircle, Printer, Settings2, SlidersHorizontal, WifiOff } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { formatCurrency, formatShortDateTime, formatTime } from '@/lib/format';
import { useTenantTimeZone } from '@/lib/auth';
import { agorotToShekels, isoDayInZone, kioskConnection, kioskOffline, type KioskConnection } from '@/lib/kioskConfig';
import type { KioskPrinterHealth, KioskSummary } from '@/lib/kioskApi';
import { KioskAlertsBadge } from './kiosk-ops-notes';
import { KioskZBadge } from './kiosk-z-actions';

const DOT: Record<KioskConnection, string> = {
  online: 'bg-emerald-500',
  stale: 'bg-amber-500',
  offline: 'bg-red-500',
  never: 'bg-neutral-300',
};

/** "לפני 3 דק׳" for a timestamp, relative to `nowMs`. */
export function agoText(iso: string | null | undefined, nowMs: number): string | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return null;
  return formatDistanceStrict(Math.min(at, nowMs), nowMs, { addSuffix: true, locale: he });
}

/** "14:32" for today, "05/10 14:32" for an earlier day — in the tenant's zone. */
export function seenAtText(iso: string | null | undefined, nowMs: number, timeZone: string): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  if (isoDayInZone(at, timeZone) === isoDayInZone(new Date(nowMs), timeZone)) return formatTime(at, { timeZone });
  return formatShortDateTime(at, timeZone);
}

/**
 * Connected, or "לא מחובר · נראה לאחרונה HH:MM" (kioskOffline: unseen for over 2 minutes, never
 * seen, or not online) — a red badge, so an offline kiosk's numbers never read as live.
 */
export function ConnectionBadge({ k, nowMs }: { k: KioskSummary; nowMs: number }) {
  const t = useTranslations('kiosks.connection');
  const timeZone = useTenantTimeZone();
  const state = kioskConnection(k, nowMs);
  if (!kioskOffline(k, nowMs)) {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm">
        <span className={cn('h-2.5 w-2.5 shrink-0 rounded-full animate-pulse', DOT.online)} aria-hidden />
        <span>{t('online')}</span>
      </span>
    );
  }
  const seen = seenAtText(k.lastSeenAt ?? k.lastKioskSyncAt, nowMs, timeZone);
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 text-sm">
      <Badge variant="destructive" className="gap-1">
        <span className={cn('h-2 w-2 shrink-0 rounded-full', DOT[state])} aria-hidden />
        <WifiOff /> {t('offline')}
      </Badge>
      <span className="text-xs text-muted-foreground">{seen ? t('lastSeenAt', { time: seen }) : t('never')}</span>
    </span>
  );
}

/** The kiosk's bon-printer report (ok/warn/error/none) or the heartbeat's receipt printer (ok/no_paper/…). */
function printerTone(state: string | null | undefined): string {
  if (state === 'ok') return 'text-emerald-600 dark:text-emerald-400';
  if (state === 'warn' || state === 'no_paper' || state === 'overheated') return 'text-amber-600 dark:text-amber-400';
  if (state === 'error' || state === 'unavailable') return 'text-red-600 dark:text-red-400';
  return 'text-muted-foreground';
}

export function PrinterStates({ k }: { k: KioskSummary }) {
  const t = useTranslations('kiosks.printer');
  const bon: KioskPrinterHealth | null = k.bonPrinter;
  const receipt = k.printerStatus;
  const word = (s: string | null | undefined) => (s && t.has(s) ? t(s) : s ? s : t('unknown'));
  return (
    <span className="flex flex-col gap-0.5 text-xs">
      <span className={cn('inline-flex items-center gap-1', printerTone(bon))}>
        <Printer className="h-3.5 w-3.5" /> {t('bon')}: {word(bon)}
      </span>
      <span className={cn('inline-flex items-center gap-1', printerTone(receipt))}>
        <Printer className="h-3.5 w-3.5" /> {t('receipt')}: {word(receipt)}
      </span>
    </span>
  );
}

export function StateBadges({ k }: { k: KioskSummary }) {
  const t = useTranslations('kiosks');
  return (
    <span className="flex flex-wrap items-center gap-1">
      {!k.enabled ? <Badge variant="outline">{t('disabled')}</Badge> : null}
      {k.paused ? (
        <Badge className="bg-amber-500 text-white">
          <PauseCircle /> {t('paused')}
        </Badge>
      ) : k.flowState === 'no_payment' ? (
        // The pinpad is not configured or not reachable: the kiosk cannot take payments.
        <Badge className="bg-amber-500 text-white">
          <AlertTriangle /> {t('flow.no_payment')}
        </Badge>
      ) : k.flowState ? (
        <Badge variant="secondary">{t.has(`flow.${k.flowState}`) ? t(`flow.${k.flowState}`) : k.flowState}</Badge>
      ) : null}
      {k.shiftOpen === true ? (
        <Badge variant="outline" className="border-emerald-300 text-emerald-700 dark:text-emerald-300">
          {t('shiftOpen')}
        </Badge>
      ) : k.shiftOpen === false ? (
        <Badge variant="outline">{t('shiftClosed')}</Badge>
      ) : null}
    </span>
  );
}

export function ModeBadge({ k }: { k: KioskSummary }) {
  const t = useTranslations('kiosks.mode');
  return <Badge variant={k.fulfillmentMode === 'KDS' ? 'outline' : 'secondary'}>{t(k.fulfillmentMode === 'KDS' ? 'KDS' : 'BON')}</Badge>;
}

export function SyncCell({ k, nowMs }: { k: KioskSummary; nowMs: number }) {
  const t = useTranslations('kiosks.config');
  const last = agoText(k.lastKioskSyncAt, nowMs);
  return (
    <span className="flex flex-col gap-0.5 text-xs">
      <span>{last ?? '—'}</span>
      {k.appliedConfigVersion ? (
        <span className={k.configUpToDate ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-400'}>
          {k.configUpToDate ? t('upToDate') : t('outdated')}
        </span>
      ) : (
        <span className="text-muted-foreground">{t('unknown')}</span>
      )}
    </span>
  );
}

export function MediaCell({ k }: { k: KioskSummary }) {
  const t = useTranslations('kiosks.media');
  if (k.mediaReady === null || k.mediaReady === undefined) return <span className="text-xs text-muted-foreground">{t('unknown')}</span>;
  return k.mediaReady ? (
    <span className="text-xs text-emerald-700 dark:text-emerald-400">{t('ready')}</span>
  ) : (
    <span className="inline-flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400">
      <ImageOff className="h-3.5 w-3.5" /> {t('missing', { n: k.mediaMissing ?? 0 })}
    </span>
  );
}

export function TodayCell({ k, nowMs }: { k: KioskSummary; nowMs: number }) {
  const t = useTranslations('kiosks.today');
  const state = kioskConnection(k, nowMs);
  if (k.ordersToday === null || k.ordersToday === undefined) return <span className="text-xs text-muted-foreground">{t('unknown')}</span>;
  return (
    <span className="flex flex-col gap-0.5">
      <span className="text-sm font-semibold tabular-nums">{formatCurrency(agorotToShekels(k.salesTodayAgorot) ?? 0)}</span>
      <span className="text-xs text-muted-foreground tabular-nums">{t('orders', { n: k.ordersToday })}</span>
      {state !== 'online' ? <span className="text-[11px] text-amber-700 dark:text-amber-400">{t('staleNote')}</span> : null}
    </span>
  );
}

export function UnprintedCell({ k }: { k: KioskSummary }) {
  const t = useTranslations('kiosks');
  const n = k.unprintedBons ?? 0;
  // "התראות לקופות" open now, beside the bons (kiosk-ops-notes.tsx).
  if (n <= 0) {
    return (
      <span className="inline-flex flex-col gap-0.5">
        <span className="text-xs text-muted-foreground">0</span>
        <KioskAlertsBadge k={k} />
      </span>
    );
  }
  return (
    <span className="inline-flex flex-col gap-0.5">
      <span className="inline-flex items-center gap-1 text-xs font-semibold text-red-600 dark:text-red-400">
        <AlertTriangle className="h-3.5 w-3.5" /> {t('unprinted', { n })}
      </span>
      <KioskAlertsBadge k={k} />
    </span>
  );
}

function Labeled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-0.5">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div>{children}</div>
    </div>
  );
}

export function KioskList({
  kiosks,
  nowMs,
  onManage,
  onSettings,
}: {
  kiosks: KioskSummary[];
  nowMs: number;
  onManage: (k: KioskSummary) => void;
  onSettings: (k: KioskSummary) => void;
}) {
  const t = useTranslations('kiosks.list');
  const tc = useTranslations('kiosks.list.columns');

  const name = (k: KioskSummary) => (
    <div className="min-w-0">
      <div className="truncate font-semibold">{k.name}</div>
      <div className="truncate text-xs text-muted-foreground">
        {[k.machineName !== k.name ? k.machineName : null, k.posNumber ? t('pos', { n: k.posNumber }) : null]
          .filter(Boolean)
          .join(' · ')}
      </div>
    </div>
  );
  const actions = (k: KioskSummary) => (
    <div className="flex gap-1">
      <Button size="sm" variant="outline" onClick={() => onManage(k)}>
        <SlidersHorizontal /> {t('manage')}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => onSettings(k)}>
        <Settings2 /> {t('settings')}
      </Button>
    </div>
  );

  return (
    <>
      {/* Phone: cards. */}
      <div className="grid gap-3 md:hidden">
        {kiosks.map((k) => (
          <div
            key={k.machineId}
            className={cn('space-y-3 rounded-2xl border bg-card p-4 shadow-sm', k.paused && 'border-amber-300 dark:border-amber-800')}
          >
            <div className="flex items-start justify-between gap-2">
              {name(k)}
              <span className="flex flex-wrap justify-end gap-1">
                <ModeBadge k={k} />
                <KioskZBadge k={k} />
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <ConnectionBadge k={k} nowMs={nowMs} />
              <StateBadges k={k} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Labeled label={tc('today')}>
                <TodayCell k={k} nowMs={nowMs} />
              </Labeled>
              <Labeled label={tc('lastOrder')}>
                <span className="text-sm">{agoText(k.lastOrderAt, nowMs) ?? '—'}</span>
              </Labeled>
              <Labeled label={tc('printers')}>
                <PrinterStates k={k} />
              </Labeled>
              <Labeled label={tc('sync')}>
                <SyncCell k={k} nowMs={nowMs} />
              </Labeled>
              <Labeled label={tc('media')}>
                <MediaCell k={k} />
              </Labeled>
              <Labeled label={tc('unprinted')}>
                <UnprintedCell k={k} />
              </Labeled>
            </div>
            {k.shopName ? <div className="text-xs text-muted-foreground">{k.shopName}</div> : null}
            {actions(k)}
          </div>
        ))}
      </div>

      {/* Desktop: a table. */}
      <div className="hidden overflow-x-auto rounded-2xl border md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{tc('kiosk')}</TableHead>
              <TableHead>{tc('shop')}</TableHead>
              <TableHead>{tc('connection')}</TableHead>
              <TableHead>{tc('state')}</TableHead>
              <TableHead>{tc('today')}</TableHead>
              <TableHead>{tc('lastOrder')}</TableHead>
              <TableHead>{tc('printers')}</TableHead>
              <TableHead>{tc('unprinted')}</TableHead>
              <TableHead>{tc('sync')}</TableHead>
              <TableHead>{tc('media')}</TableHead>
              <TableHead>{tc('mode')}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {kiosks.map((k) => (
              <TableRow key={k.machineId} className={cn(k.paused && 'bg-amber-50/60 dark:bg-amber-950/20')}>
                <TableCell className="max-w-48">{name(k)}</TableCell>
                <TableCell className="text-sm">{k.shopName ?? '—'}</TableCell>
                <TableCell>
                  <ConnectionBadge k={k} nowMs={nowMs} />
                </TableCell>
                <TableCell>
                  <StateBadges k={k} />
                </TableCell>
                <TableCell>
                  <TodayCell k={k} nowMs={nowMs} />
                </TableCell>
                <TableCell className="text-sm">{agoText(k.lastOrderAt, nowMs) ?? '—'}</TableCell>
                <TableCell>
                  <PrinterStates k={k} />
                </TableCell>
                <TableCell>
                  <UnprintedCell k={k} />
                </TableCell>
                <TableCell>
                  <SyncCell k={k} nowMs={nowMs} />
                </TableCell>
                <TableCell>
                  <MediaCell k={k} />
                </TableCell>
                <TableCell>
                  {/* Fulfilment (BON / KDS) and the Z mode ("Z סניפי" / "Z עצמאי", kiosk-z-actions.tsx). */}
                  <span className="flex flex-wrap gap-1">
                    <ModeBadge k={k} />
                    <KioskZBadge k={k} />
                  </span>
                </TableCell>
                <TableCell>{actions(k)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </>
  );
}
