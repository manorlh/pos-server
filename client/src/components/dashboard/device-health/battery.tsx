'use client';

/**
 * "סוללה חלשה" in "תקינות מכשירים" (pos-server app/services/battery_alerts.py): every other
 * device of the scope (tills, handhelds, tablets) with its battery, the low-battery history,
 * and where the thresholds, the alarm and the routing are set.
 */

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Battery, BatteryCharging, BatteryFull, BatteryLow, BatteryMedium, BellRing, WifiOff } from 'lucide-react';
import { cn } from '@/lib/utils';
import { deviceKind, levelTone, type BatteryEvent, type BatteryEventRow, type HealthBattery, type HealthDevice, type HealthLevel } from '@/lib/kioskInsights';
import { OverallBadge, TONE, agoText, type HealthLabels } from './health-ui';

/** A battery icon that shows the charge (and charging), coloured by the part's level, and its percent. */
export function BatteryGauge({
  battery,
  level,
  className,
  big = false,
}: {
  battery: HealthBattery | null | undefined;
  level: HealthLevel | string;
  className?: string;
  big?: boolean;
}) {
  const t = useTranslations('deviceHealth.battery');
  const tone = levelTone(level);
  const pct = battery?.percent ?? null;
  const Icon = !battery || pct === null ? Battery : battery.charging ? BatteryCharging : pct <= 15 ? BatteryLow : pct <= 60 ? BatteryMedium : BatteryFull;
  return (
    <span className={cn('inline-flex items-center gap-1.5', className)}>
      <Icon className={cn('shrink-0', big ? 'h-6 w-6' : 'h-4 w-4', tone === 'muted' ? 'text-muted-foreground' : TONE[tone].text)} aria-hidden />
      <span className={cn('font-semibold tabular-nums', big ? 'text-xl' : 'text-sm')}>{pct !== null ? `${pct}%` : t('none')}</span>
      {battery?.charging ? <span className="text-xs text-muted-foreground">{t('charging')}</span> : null}
    </span>
  );
}

export function DeviceBatteryCard({
  device,
  L,
  nowMs,
  formatTime,
}: {
  device: HealthDevice;
  L: HealthLabels;
  nowMs: number;
  formatTime: (iso: string) => string;
}) {
  const t = useTranslations('deviceHealth.battery');
  const tr = useTranslations('deviceHealth.row');
  const part = device.batteryPart;
  const tone = levelTone(part.level);
  const alertOpen = part.code === 'critical' || part.code === 'low';
  const ackBy = typeof part.detail?.acknowledgedBy === 'string' ? part.detail.acknowledgedBy : null;
  const heartbeat = agoText(device.lastHeartbeatAt, nowMs);
  const sub = [deviceKind(device.device), device.shopName, device.posNumber ? tr('pos', { n: device.posNumber }) : null].filter(Boolean);
  return (
    <article
      className={cn(
        'flex flex-col gap-2 rounded-2xl border bg-card p-3 shadow-sm',
        tone === 'error' && 'border-red-300 dark:border-red-900',
        tone === 'warn' && 'border-amber-300 dark:border-amber-900',
      )}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold">{device.name}</div>
          {sub.length ? <div className="truncate text-xs text-muted-foreground">{sub.join(' · ')}</div> : null}
        </div>
        <OverallBadge overall={device.overall} L={L} />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <BatteryGauge battery={device.battery} level={part.level} big />
        {part.code !== 'discharging' && part.code !== 'charging' ? <span className="text-xs text-muted-foreground">{L.code(part)}</span> : null}
      </div>
      {device.battery?.stale && device.battery.reportedAt ? (
        <p className="text-xs text-amber-700 dark:text-amber-400" title={formatTime(device.battery.reportedAt)}>
          {t('asOf', { ago: agoText(device.battery.reportedAt, nowMs) ?? '' })}
        </p>
      ) : null}
      {alertOpen ? (
        <p className={cn('flex items-start gap-1.5 rounded-lg px-2 py-1 text-xs', TONE[tone].pill)}>
          <BellRing className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>
            {t(part.code === 'critical' ? 'alertCritical' : 'alertLow', {
              threshold: String(part.detail?.threshold ?? '—'),
            })}
            {ackBy ? ` · ${tr('acknowledged', { name: ackBy })}` : ''}
          </span>
        </p>
      ) : null}
      <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-0.5 border-t pt-1.5 text-xs text-muted-foreground">
        <span className={cn('inline-flex items-center gap-1', device.online ? TONE.ok.text : TONE.error.text)}>
          {device.online ? <span className="h-2 w-2 rounded-full bg-emerald-500" aria-hidden /> : <WifiOff className="h-3.5 w-3.5" aria-hidden />}
          {device.online ? tr('online') : tr('offline')}
        </span>
        <span title={device.lastHeartbeatAt ? formatTime(device.lastHeartbeatAt) : undefined}>
          {heartbeat ? t('heartbeat', { ago: heartbeat }) : tr('neverSeen')}
        </span>
        {device.appVersion ? <span dir="ltr">{device.appVersion}</span> : null}
      </div>
    </article>
  );
}

/** "היסטוריית סוללה חלשה": each alert, the device, how low, when raised and how it ended. */
export function BatteryHistoryTable({
  rows,
  formatTime,
  showDevice = true,
}: {
  /** Named rows (`batteryHistoryRows`), or one device's own events with `showDevice` off. */
  rows: (BatteryEvent & Partial<Pick<BatteryEventRow, 'name' | 'kind' | 'shopName'>>)[];
  formatTime: (iso: string) => string;
  showDevice?: boolean;
}) {
  const t = useTranslations('deviceHealth.battery');
  if (rows.length === 0) return <p className="text-xs text-muted-foreground">{t('historyEmpty')}</p>;
  return (
    <div className="overflow-x-auto rounded-2xl border">
      <table className={cn('w-full text-xs', showDevice ? 'min-w-[720px]' : 'min-w-[480px]')}>
        <thead>
          <tr className="text-muted-foreground">
            {showDevice ? <th className="px-2 py-1.5 text-start font-normal">{t('colDevice')}</th> : null}
            <th className="px-2 py-1.5 text-start font-normal">{t('colLevel')}</th>
            <th className="px-2 py-1.5 text-end font-normal">{t('colPercent')}</th>
            <th className="px-2 py-1.5 text-start font-normal">{t('colRaised')}</th>
            <th className="px-2 py-1.5 text-start font-normal">{t('colCleared')}</th>
            <th className="px-2 py-1.5 text-start font-normal">{t('colAck')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const critical = r.severity === 'critical';
            const tone = r.clearedAt ? 'muted' : critical ? 'error' : 'warn';
            return (
              <tr key={r.id} className="border-t">
                {showDevice ? (
                  <td className="px-2 py-1.5">
                    <span className="font-medium">{r.name}</span>
                    {r.kind || r.shopName ? <span className="block text-muted-foreground">{[r.kind, r.shopName].filter(Boolean).join(' · ')}</span> : null}
                  </td>
                ) : null}
                <td className="px-2 py-1.5">
                  <span className={cn('rounded-full px-1.5 py-0.5 font-medium', TONE[tone].pill)}>
                    {t(critical ? 'severityCritical' : 'severityWarning', { level: String(r.level) })}
                  </span>
                </td>
                <td className="px-2 py-1.5 text-end tabular-nums">
                  {r.percent !== null ? `${r.percent}%` : '—'}
                  {r.lastPercent !== null && r.lastPercent !== r.percent ? <span className="block text-muted-foreground">{t('lowest', { percent: String(r.lastPercent) })}</span> : null}
                </td>
                <td className="px-2 py-1.5 tabular-nums">{r.raisedAt ? formatTime(r.raisedAt) : '—'}</td>
                <td className="px-2 py-1.5">
                  {r.clearedAt ? (
                    <>
                      <span className="tabular-nums">{formatTime(r.clearedAt)}</span>
                      {r.clearReason ? (
                        <span className="block text-muted-foreground">{t.has(`clear.${r.clearReason}`) ? t(`clear.${r.clearReason}`) : r.clearReason}</span>
                      ) : null}
                    </>
                  ) : (
                    <span className={cn('rounded-full px-1.5 py-0.5 font-medium', TONE[critical ? 'error' : 'warn'].pill)}>{t('open')}</span>
                  )}
                </td>
                <td className="px-2 py-1.5">{r.acknowledgedBy ?? '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Where the thresholds, the alarm and the routing are set. */
export function BatterySettingsNote({ isSuperAdmin, className }: { isSuperAdmin: boolean; className?: string }) {
  const t = useTranslations('deviceHealth.battery');
  return (
    <p className={cn('text-xs leading-relaxed text-muted-foreground', className)}>
      {t('settingsNote')}{' '}
      {isSuperAdmin ? (
        <Link href="/dashboard/till-parameters" className="text-primary underline">
          {t('settingsParams')}
        </Link>
      ) : null}
      {isSuperAdmin ? ' · ' : null}
      <Link href="/dashboard/kiosks" className="text-primary underline">
        {t('settingsRouting')}
      </Link>
    </p>
  );
}
