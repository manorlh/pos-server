'use client';

/**
 * "תקינות מכשירים": the summary chips (one per overall state — each a filter too) and the
 * kiosks as cards: name, shop, platform and version, connection, the screen it is on, its
 * paused / closed state, one pill per part, its open alerts and today's orders.
 */

import { useTranslations } from 'next-intl';
import { AlertTriangle, BellRing, ChevronLeft, EthernetPort, PauseCircle, Signal, Wifi, WifiOff } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatCurrency } from '@/lib/format';
import { OVERALL_STATES, orderedParts, overallTone, type HealthOverall, type KioskHealthRow } from '@/lib/kioskInsights';
import { OverallBadge, PartPill, TONE, ToneIcon, agoText, detailLines, type HealthLabels } from './health-ui';

export function HealthSummaryChips({
  counts,
  total,
  value,
  onChange,
  L,
}: {
  counts: Record<HealthOverall, number>;
  total: number;
  value: HealthOverall | '';
  onChange: (v: HealthOverall | '') => void;
  L: HealthLabels;
}) {
  const t = useTranslations('deviceHealth');
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label={t('filters.status')}>
      <button
        type="button"
        onClick={() => onChange('')}
        aria-pressed={value === ''}
        className={cn(
          'inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition-colors',
          value === '' ? 'border-primary bg-primary text-primary-foreground' : 'bg-background hover:bg-muted',
        )}
      >
        {t('allStates')}
        <span className="tabular-nums font-semibold">{total}</span>
      </button>
      {OVERALL_STATES.map((o) => {
        const tone = overallTone(o);
        const on = value === o;
        const n = counts[o] ?? 0;
        return (
          <button
            key={o}
            type="button"
            onClick={() => onChange(on ? '' : o)}
            aria-pressed={on}
            disabled={n === 0 && !on}
            className={cn(
              'inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition-colors disabled:opacity-45',
              TONE[tone].pill,
              on ? cn('border-transparent ring-2', TONE[tone].ring) : 'border-transparent hover:opacity-80',
            )}
          >
            <ToneIcon tone={tone} offline={o === 'offline'} className={cn('h-4 w-4', TONE[tone].text)} />
            {L.overall(o)}
            <span className="tabular-nums font-bold">{n}</span>
          </button>
        );
      })}
    </div>
  );
}

function NetworkIcon({ route }: { route?: string | null }) {
  if (route === 'cellular') return <Signal className="h-3.5 w-3.5" aria-hidden />;
  if (route === 'ethernet') return <EthernetPort className="h-3.5 w-3.5" aria-hidden />;
  return <Wifi className="h-3.5 w-3.5" aria-hidden />;
}

export function KioskHealthCard({
  row,
  L,
  nowMs,
  formatTime,
  onOpen,
}: {
  row: KioskHealthRow;
  L: HealthLabels;
  nowMs: number;
  formatTime: (iso: string) => string;
  onOpen: () => void;
}) {
  const t = useTranslations('deviceHealth.row');
  const tone = overallTone(row.overall);
  const contact = agoText(row.lastContactAt, nowMs);
  const platform = L.platform(row.platform);
  // Most kiosks run on mains power: "אין סוללה" is left to the drawer, not a pill on every card.
  const parts = orderedParts(row).filter((p) => !(p.key === 'battery' && p.code === 'none'));
  const sub = [
    row.shopName,
    row.posNumber ? t('pos', { n: row.posNumber }) : null,
    [platform, row.appVersion ? t('version', { version: row.appVersion }) : null].filter(Boolean).join(' '),
  ].filter(Boolean);
  const closed = row.flowState === 'closed';
  return (
    <article
      className={cn(
        'flex flex-col gap-3 rounded-2xl border bg-card p-4 shadow-sm transition-shadow hover:shadow-md',
        tone === 'error' && 'border-red-300 dark:border-red-900',
        tone === 'warn' && 'border-amber-300 dark:border-amber-900',
      )}
    >
      <button type="button" onClick={onOpen} className="flex items-start gap-3 text-start" aria-label={t('open', { name: row.name })}>
        <span className="min-w-0 flex-1 space-y-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="truncate text-base font-semibold">{row.name}</span>
            <OverallBadge overall={row.overall} L={L} />
          </span>
          {sub.length ? <span className="block truncate text-xs text-muted-foreground">{sub.join(' · ')}</span> : null}
        </span>
        <ChevronLeft className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      </button>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span className={cn('inline-flex items-center gap-1', row.online ? TONE.ok.text : TONE.error.text)}>
          {row.online ? <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" aria-hidden /> : <WifiOff className="h-3.5 w-3.5" aria-hidden />}
          {row.online ? t('online') : t('offline')}
        </span>
        <span className="text-muted-foreground" title={row.lastContactAt ? formatTime(row.lastContactAt) : undefined}>
          {contact ? t('lastContact', { ago: contact }) : t('neverSeen')}
        </span>
        {row.network?.route ? (
          <span className="inline-flex items-center gap-1 text-muted-foreground">
            <NetworkIcon route={row.network.route} /> {L.route(row.network.route)}
          </span>
        ) : null}
        {row.online && row.screen ? <span className="text-muted-foreground">{t('screen', { screen: L.screen(row.screen) })}</span> : null}
        {!row.enabled ? <span className="rounded-full bg-muted px-2 py-0.5 font-medium">{t('disabled')}</span> : null}
        {row.paused ? (
          <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium', TONE.warn.pill)}>
            <PauseCircle className="h-3.5 w-3.5" aria-hidden /> {t('paused')}
          </span>
        ) : closed ? (
          <span className="rounded-full bg-muted px-2 py-0.5 font-medium">{t('closed')}</span>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 xl:grid-cols-4">
        {parts.map((p) => (
          <PartPill
            key={p.key}
            part={p}
            L={L}
            title={[`${L.part(p.key)}: ${L.code(p)}`, ...detailLines(p, L, nowMs, formatTime).map((d) => `${d.label}: ${d.value}`)].join('\n')}
          />
        ))}
      </div>

      {row.alerts.length > 0 ? (
        <ul className="space-y-1 rounded-xl bg-red-50 p-2 text-xs text-red-900 dark:bg-red-950/40 dark:text-red-100">
          {row.alerts.map((a, i) => (
            <li key={`${a.key}:${i}`} className="flex items-start gap-1.5">
              {a.kind === 'help' ? <BellRing className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /> : <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />}
              <span className="min-w-0 flex-1">
                <span className="font-medium">{a.text || L.alertKind(a.kind)}</span>
                <span className="block opacity-75">
                  {[
                    L.alertKind(a.kind),
                    agoText(a.raisedAt, nowMs),
                    a.acknowledgedBy ? t('acknowledged', { name: a.acknowledgedBy }) : null,
                    a.cloud ? t('cloudAlert') : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t pt-2 text-xs text-muted-foreground">
        <span>
          {t('today', {
            orders: String(row.ordersToday ?? 0),
            sales: formatCurrency((row.salesTodayAgorot ?? 0) / 100),
          })}
        </span>
        {row.unprintedOrders.length > 0 ? (
          <span className={cn('rounded-full px-2 py-0.5 font-medium', TONE.warn.pill)}>{t('unprinted', { n: row.unprintedOrders.length })}</span>
        ) : null}
      </div>
    </article>
  );
}
