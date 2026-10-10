'use client';

/**
 * One kiosk's health in a side drawer (`GET /kiosks/{id}/health`): every part with its
 * details, the terminal's identity and card lock, unprinted bons, open alerts, the shop's
 * KDS screens, the last events (alerts raised and cleared, commands, outages) and the last
 * customer sessions; the versions a technician asks for. The kiosk's actions (pause, close
 * the shift, print or settle an unprinted bon…) stay where they are — the kiosks page's
 * dialog, opened from here.
 */

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
import {
  AlertTriangle,
  Bell,
  BellRing,
  History,
  Loader2,
  PauseCircle,
  Play,
  Settings2,
  SlidersHorizontal,
  Terminal,
  WifiOff,
  Wrench,
  XIcon,
} from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { Dialog, DialogOverlay, DialogPortal } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { formatCurrency } from '@/lib/format';
import { durationText, levelTone, orderedParts, type KioskHealthEvent, type KioskHealthRow } from '@/lib/kioskInsights';
import { fetchKioskHealth } from '@/lib/kioskInsightsApi';
import { OverallBadge, PART_ICON, TONE, ToneIcon, agoText, detailLines, type HealthLabels } from './health-ui';
import { BatteryGauge, BatteryHistoryTable, BatterySettingsNote } from './battery';

function Section({ title, icon, children, trailing }: { title: string; icon?: React.ReactNode; children: React.ReactNode; trailing?: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          {icon}
          {title}
        </h3>
        {trailing}
      </div>
      {children}
    </section>
  );
}

function EventIcon({ e }: { e: KioskHealthEvent }) {
  const cls = 'h-4 w-4 shrink-0';
  if (e.type === 'alert_raised') return e.kind === 'help' ? <BellRing className={cn(cls, TONE.error.text)} aria-hidden /> : <AlertTriangle className={cn(cls, TONE.error.text)} aria-hidden />;
  if (e.type === 'alert_cleared') return <ToneIcon tone="ok" className={cn(cls, TONE.ok.text)} />;
  if (e.type === 'offline') return <WifiOff className={cn(cls, TONE.error.text)} aria-hidden />;
  if (e.action === 'pause') return <PauseCircle className={cn(cls, 'text-muted-foreground')} aria-hidden />;
  if (e.action === 'resume') return <Play className={cn(cls, 'text-muted-foreground')} aria-hidden />;
  return <Terminal className={cn(cls, 'text-muted-foreground')} aria-hidden />;
}

export function KioskHealthDrawer({
  row,
  open,
  onOpenChange,
  L,
  nowMs,
  formatTime,
  actions,
  isSuperAdmin,
  onOpenActions,
}: {
  /** The kiosk as the list has it; the drawer refreshes it from its own request. */
  row: KioskHealthRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  L: HealthLabels;
  nowMs: number;
  formatTime: (iso: string) => string;
  /** The kiosks page's actions dialog: its kiosk list still loading, ready, or this kiosk not in it. */
  actions: 'loading' | 'ready' | 'none';
  isSuperAdmin: boolean;
  onOpenActions: (machineId: string) => void;
}) {
  const t = useTranslations('deviceHealth.drawer');
  const tr = useTranslations('deviceHealth.row');
  const te = useTranslations('deviceHealth.events');
  const ts = useTranslations('deviceHealth.sessions');
  const machineId = row?.machineId ?? '';
  const detail = useQuery({
    queryKey: ['kiosk-health', machineId],
    queryFn: () => fetchKioskHealth(machineId),
    enabled: open && !!machineId,
    refetchInterval: open ? 15_000 : false,
  });
  const kiosk = detail.data?.kiosk.machineId === machineId ? detail.data.kiosk : row;
  const identity = detail.data?.terminalIdentity ?? null;
  const events = detail.data?.events ?? [];
  const sessions = detail.data?.sessions ?? [];
  const batteryHistory = detail.data?.batteryHistory ?? [];
  const tb = useTranslations('deviceHealth.battery');
  const tTerminal = useTranslations('cardTerminal');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        <DialogOverlay />
        <DialogPrimitive.Popup
          className={cn(
            'fixed inset-y-0 end-0 z-50 flex w-full max-w-xl flex-col bg-popover text-sm text-popover-foreground shadow-2xl ring-1 ring-foreground/10 outline-none',
            'duration-200 data-open:animate-in data-open:slide-in-from-left data-closed:animate-out data-closed:slide-out-to-left',
          )}
        >
          {kiosk ? (
            <>
              <header className="flex items-start gap-3 border-b px-5 pb-3 pt-[calc(1rem+env(safe-area-inset-top))]">
                <div className="min-w-0 flex-1 space-y-1">
                  <DialogPrimitive.Title className="flex flex-wrap items-center gap-2 text-lg font-semibold">
                    {kiosk.name} <OverallBadge overall={kiosk.overall} L={L} />
                  </DialogPrimitive.Title>
                  <DialogPrimitive.Description className="text-xs text-muted-foreground">
                    {[
                      kiosk.shopName,
                      kiosk.machineName && kiosk.machineName !== kiosk.name ? kiosk.machineName : null,
                      kiosk.posNumber ? tr('pos', { n: kiosk.posNumber }) : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </DialogPrimitive.Description>
                </div>
                {detail.isFetching ? <Loader2 className="mt-1 h-4 w-4 animate-spin text-muted-foreground" aria-hidden /> : null}
                <DialogPrimitive.Close render={<Button variant="ghost" size="icon-sm" />}>
                  <XIcon />
                  <span className="sr-only">{t('close')}</span>
                </DialogPrimitive.Close>
              </header>

              <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4 pb-[calc(1.5rem+env(safe-area-inset-bottom))]">
                {/* Status line */}
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                  <span className={cn('inline-flex items-center gap-1 font-medium', kiosk.online ? TONE.ok.text : TONE.error.text)}>
                    {kiosk.online ? <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" aria-hidden /> : <WifiOff className="h-3.5 w-3.5" aria-hidden />}
                    {kiosk.online ? tr('online') : tr('offline')}
                  </span>
                  <span className="text-muted-foreground" title={kiosk.lastContactAt ? formatTime(kiosk.lastContactAt) : undefined}>
                    {agoText(kiosk.lastContactAt, nowMs) ? tr('lastContact', { ago: agoText(kiosk.lastContactAt, nowMs) ?? '' }) : tr('neverSeen')}
                  </span>
                  {kiosk.online && kiosk.screen ? <span className="text-muted-foreground">{tr('screen', { screen: L.screen(kiosk.screen) })}</span> : null}
                  {kiosk.paused ? (
                    <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium', TONE.warn.pill)}>
                      <PauseCircle className="h-3.5 w-3.5" aria-hidden /> {tr('paused')}
                      {kiosk.pausedUntil ? ` · ${t('until', { time: formatTime(kiosk.pausedUntil) })}` : ''}
                    </span>
                  ) : null}
                  {kiosk.paused && kiosk.pauseMessage ? <span className="w-full text-muted-foreground">“{kiosk.pauseMessage}”</span> : null}
                </div>

                {/* Actions — the kiosks page's own dialog and settings */}
                <div className="flex flex-wrap gap-2">
                  {actions !== 'none' ? (
                    <Button size="sm" disabled={actions === 'loading'} onClick={() => onOpenActions(kiosk.machineId)}>
                      {actions === 'loading' ? <Loader2 className="animate-spin" /> : <SlidersHorizontal />} {t('openActions')}
                    </Button>
                  ) : null}
                  <Link href="/dashboard/kiosks" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
                    <Settings2 /> {t('openSettings')}
                  </Link>
                </div>
                {actions !== 'none' ? <p className="-mt-3 text-xs text-muted-foreground">{t('actionsHint')}</p> : null}

                {/* Parts */}
                <Section title={t('parts')}>
                  <ul className="divide-y rounded-2xl border">
                    {orderedParts(kiosk).map((p) => {
                      const tone = levelTone(p.level);
                      const Icon = PART_ICON[p.key];
                      const lines = detailLines(p, L, nowMs, formatTime);
                      return (
                        <li key={p.key} className="flex items-start gap-3 px-3 py-2.5">
                          <span className={cn('mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg', TONE[tone].pill)}>
                            <Icon className="h-4 w-4" aria-hidden />
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-x-2">
                              <span className="font-medium">{L.part(p.key)}</span>
                              <span className={cn('inline-flex items-center gap-1 text-xs font-semibold', TONE[tone].text)}>
                                <ToneIcon tone={tone} unknown={p.level === 'unknown'} className="h-3.5 w-3.5" />
                                {L.code(p)}
                              </span>
                            </div>
                            {lines.length > 0 ? (
                              <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
                                {lines.map((d) => (
                                  <div key={d.key} className="contents">
                                    <dt className="text-muted-foreground">{d.label}</dt>
                                    <dd className="min-w-0 break-words" title={d.title}>
                                      {d.value}
                                    </dd>
                                  </div>
                                ))}
                              </dl>
                            ) : null}
                          </div>
                          <span className="shrink-0 text-[11px] text-muted-foreground">{L.level(p.level)}</span>
                        </li>
                      );
                    })}
                  </ul>
                </Section>

                {/* Open alerts, and where they go */}
                <Section title={t('alerts')} icon={<Bell className="h-4 w-4" aria-hidden />}>
                  {kiosk.alerts.length === 0 ? (
                    <p className="text-xs text-muted-foreground">{t('noAlerts')}</p>
                  ) : (
                    <ul className="space-y-1.5">
                      {kiosk.alerts.map((a, i) => (
                        <li key={`${a.key}:${i}`} className={cn('rounded-xl px-3 py-2 text-xs', TONE.error.pill)}>
                          <div className="font-medium">{a.text || L.alertKind(a.kind)}</div>
                          <div className="opacity-75">
                            {[
                              L.alertKind(a.kind),
                              a.raisedAt ? agoText(a.raisedAt, nowMs) : null,
                              a.acknowledgedBy ? tr('acknowledged', { name: a.acknowledgedBy }) : null,
                              a.cloud ? tr('cloudAlert') : null,
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className="rounded-xl bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
                    {t('alertsRouting')}{' '}
                    <Link href="/dashboard/kiosks" className="text-primary underline">
                      {t('alertsRoutingLink')}
                    </Link>
                  </p>
                </Section>

                {/* "סוללה חלשה": the kiosk's battery (when it has one) and its low-battery history */}
                {kiosk.battery || batteryHistory.length > 0 ? (
                  <Section title={tb('title')}>
                    {kiosk.battery ? (
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-2xl border px-3 py-2.5">
                        <BatteryGauge
                          battery={kiosk.battery}
                          level={kiosk.parts.find((p) => p.key === 'battery')?.level ?? 'unknown'}
                          big
                        />
                        {kiosk.battery.stale && kiosk.battery.reportedAt ? (
                          <span className="text-xs text-amber-700 dark:text-amber-400" title={formatTime(kiosk.battery.reportedAt)}>
                            {tb('asOf', { ago: agoText(kiosk.battery.reportedAt, nowMs) ?? '' })}
                          </span>
                        ) : null}
                      </div>
                    ) : null}
                    <div className="text-xs font-medium text-muted-foreground">{tb('history')}</div>
                    <BatteryHistoryTable rows={batteryHistory} formatTime={formatTime} showDevice={false} />
                    <BatterySettingsNote isSuperAdmin={isSuperAdmin} />
                  </Section>
                ) : null}

                {/* Unprinted bons */}
                {kiosk.unprintedOrders.length > 0 ? (
                  <Section title={t('unprinted', { n: kiosk.unprintedOrders.length })}>
                    <ul className="divide-y rounded-2xl border">
                      {kiosk.unprintedOrders.map((o) => (
                        <li key={o.localId} className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs">
                          <span className="font-semibold tabular-nums" dir="ltr">
                            {o.label || o.localId}
                          </span>
                          {o.paidAt ? <span className="text-muted-foreground">{formatTime(o.paidAt)}</span> : null}
                          {o.detail ? <span className="w-full text-muted-foreground">{o.detail}</span> : null}
                        </li>
                      ))}
                    </ul>
                    <p className="text-xs text-muted-foreground">{t('unprintedHint')}</p>
                  </Section>
                ) : null}

                {/* Terminal identity and card lock */}
                {identity ? (
                  <Section title={t('terminal')}>
                    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-2xl border px-3 py-2.5 text-xs">
                      <dt className="text-muted-foreground">{t('terminalExpected')}</dt>
                      <dd>
                        {identity.expected ?? '—'}
                        {identity.expected && identity.expectedSource && identity.expectedSource !== 'machine' ? (
                          <span className="text-muted-foreground"> · {t('terminalInherited', { source: L.source(identity.expectedSource) })}</span>
                        ) : null}
                      </dd>
                      <dt className="text-muted-foreground">{t('terminalReported')}</dt>
                      <dd>
                        {[identity.reportedNumber, identity.reportedMerchant].filter(Boolean).join(' / ') || '—'}
                        {identity.reportedAt ? <span className="text-muted-foreground"> · {agoText(identity.reportedAt, nowMs)}</span> : null}
                      </dd>
                      <dt className="text-muted-foreground">{t('cardLock')}</dt>
                      <dd className={identity.cardLock ? cn('font-semibold', TONE.error.text) : undefined}>
                        {identity.cardLock ? L.lock(identity.cardLock) : t('cardLockNone')}
                      </dd>
                      {identity.numberCheckBypass ? (
                        // "עקיפת בדיקת מספר מסוף" (docs/SPEC_KIOSK.md §20.1): no lock because the check is off.
                        <>
                          <dt className="text-muted-foreground">{tTerminal('checkBypass.title')}</dt>
                          <dd className={cn('font-semibold', TONE.warn.text)} title={tTerminal('checkBypass.warning')}>
                            {identity.numberCheckBypassSource && identity.numberCheckBypassSource !== 'default'
                              ? tTerminal('checkBypass.from', { level: L.source(identity.numberCheckBypassSource) })
                              : tTerminal('checkBypass.fromDefault')}
                          </dd>
                        </>
                      ) : null}
                    </dl>
                  </Section>
                ) : null}

                {/* KDS screens */}
                {kiosk.fulfillmentMode === 'KDS' ? (
                  <Section title={t('kds')}>
                    {kiosk.kdsScreens.length === 0 ? (
                      <p className="text-xs text-muted-foreground">{t('noKds')}</p>
                    ) : (
                      <ul className="divide-y rounded-2xl border">
                        {kiosk.kdsScreens.map((s) => (
                          <li key={s.id} className="flex items-center gap-2 px-3 py-2 text-xs">
                            <span className={cn('h-2 w-2 shrink-0 rounded-full', s.online ? TONE.ok.dot : s.active ? TONE.error.dot : TONE.muted.dot)} aria-hidden />
                            <span className="font-medium">{s.name}</span>
                            <span className="text-muted-foreground">{L.kdsRole(s.role)}</span>
                            <span className="ms-auto text-muted-foreground">
                              {!s.active ? t('kdsInactive') : s.online ? tr('online') : agoText(s.lastSeenAt, nowMs) ?? tr('neverSeen')}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </Section>
                ) : null}

                {/* Events */}
                <Section title={t('events')} icon={<History className="h-4 w-4" aria-hidden />}>
                  {detail.isLoading ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  ) : detail.isError ? (
                    <p className="text-xs text-destructive">{t('loadFailed')}</p>
                  ) : events.length === 0 ? (
                    <p className="text-xs text-muted-foreground">{t('noEvents')}</p>
                  ) : (
                    <ol className="relative space-y-2 border-s ps-4">
                      {events.map((e, i) => (
                        <li key={`${e.at}:${e.type}:${i}`} className="relative text-xs">
                          <span className="absolute -start-[1.4rem] top-0 rounded-full bg-popover p-0.5">
                            <EventIcon e={e} />
                          </span>
                          <div className="flex flex-wrap items-baseline gap-x-2">
                            <span className="font-medium">
                              {e.type === 'command'
                                ? te('command', { action: L.command(e.action) })
                                : e.type === 'offline'
                                  ? te('offline')
                                  : e.type === 'alert_cleared'
                                    ? te('alert_cleared', { kind: L.alertKind(e.kind ?? '') })
                                    : te('alert_raised', { kind: L.alertKind(e.kind ?? '') })}
                            </span>
                            <span className="text-muted-foreground" title={e.at ? formatTime(e.at) : undefined}>
                              {e.at ? formatTime(e.at) : '—'}
                            </span>
                          </div>
                          <div className="text-muted-foreground">
                            {[
                              e.text,
                              e.type === 'command' && e.status ? L.commandStatus(e.status) : null,
                              e.type === 'offline' && e.minutes ? te('offlineFor', { minutes: String(e.minutes) }) : null,
                              e.type === 'offline' && e.backAt ? te('backAt', { time: formatTime(e.backAt) }) : null,
                              e.by ? te('by', { name: e.by }) : null,
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                          </div>
                        </li>
                      ))}
                    </ol>
                  )}
                </Section>

                {/* Sessions */}
                <Section title={t('sessions')}>
                  {detail.isLoading ? null : sessions.length === 0 ? (
                    <p className="text-xs text-muted-foreground">{t('noSessions')}</p>
                  ) : (
                    <div className="overflow-x-auto rounded-2xl border">
                      <table className="w-full min-w-[480px] text-xs">
                        <thead>
                          <tr className="text-muted-foreground">
                            <th className="px-2 py-1.5 text-start font-normal">{ts('started')}</th>
                            <th className="px-2 py-1.5 text-start font-normal">{ts('end')}</th>
                            <th className="px-2 py-1.5 text-start font-normal">{ts('step')}</th>
                            <th className="px-2 py-1.5 text-end font-normal">{ts('time')}</th>
                            <th className="px-2 py-1.5 text-end font-normal">{ts('basket')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {sessions.map((s) => (
                            <tr key={s.sessionId} className="border-t">
                              <td className="px-2 py-1.5 tabular-nums">{s.startedAt ? formatTime(s.startedAt) : '—'}</td>
                              <td className="px-2 py-1.5">
                                <span className={cn('rounded-full px-1.5 py-0.5 font-medium', s.paid ? TONE.ok.pill : TONE.muted.pill)}>
                                  {L.endReason(s.paid ? 'paid' : s.endReason)}
                                </span>
                                {s.help ? <span className="ms-1 text-muted-foreground">{ts('help')}</span> : null}
                                {s.payFailures > 0 ? <span className="ms-1 text-muted-foreground">{ts('payFailures', { n: s.payFailures })}</span> : null}
                              </td>
                              <td className="px-2 py-1.5">{L.screen(s.lastStep)}</td>
                              <td className="px-2 py-1.5 text-end tabular-nums">{s.orderSec !== null ? durationText(s.orderSec) : '—'}</td>
                              <td className="px-2 py-1.5 text-end tabular-nums">
                                {s.basketAgorot !== null ? formatCurrency(s.basketAgorot / 100) : '—'}
                                {s.items ? <span className="block text-muted-foreground">{ts('items', { n: s.items })}</span> : null}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </Section>

                {/* For the technician */}
                <Section title={t('technician')} icon={<Wrench className="h-4 w-4" aria-hidden />}>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-2xl border px-3 py-2.5 text-xs">
                    <dt className="text-muted-foreground">{t('platform')}</dt>
                    <dd>{L.platform(kiosk.platform) ?? '—'}</dd>
                    <dt className="text-muted-foreground">{t('appVersion')}</dt>
                    <dd dir="ltr" className="text-end">
                      {kiosk.appVersion ?? '—'}
                    </dd>
                    <dt className="text-muted-foreground">{t('config')}</dt>
                    <dd>{kiosk.configUpToDate === false ? t('configPending') : kiosk.configUpToDate ? t('configCurrent') : '—'}</dd>
                    <dt className="text-muted-foreground">{t('network')}</dt>
                    <dd>
                      {kiosk.network
                        ? [L.route(kiosk.network.route), kiosk.network.online === false ? t('networkDown') : null].filter(Boolean).join(' · ') || '—'
                        : '—'}
                    </dd>
                    <dt className="text-muted-foreground">{t('heartbeat')}</dt>
                    <dd title={kiosk.lastHeartbeatAt ? formatTime(kiosk.lastHeartbeatAt) : undefined}>{agoText(kiosk.lastHeartbeatAt, nowMs) ?? '—'}</dd>
                    <dt className="text-muted-foreground">{t('machine')}</dt>
                    <dd>{[kiosk.machineName, kiosk.posNumber ? tr('pos', { n: kiosk.posNumber }) : null].filter(Boolean).join(' · ') || '—'}</dd>
                    <dt className="text-muted-foreground">{t('machineId')}</dt>
                    <dd dir="ltr" className="select-all break-all text-end font-mono text-[11px]">
                      {kiosk.machineId}
                    </dd>
                  </dl>
                  <p className="text-xs text-muted-foreground">
                    {t('technicianNote')}{' '}
                    {isSuperAdmin ? (
                      <Link href="/dashboard/till-parameters" className="text-primary underline">
                        {t('technicianLink')}
                      </Link>
                    ) : null}
                  </p>
                </Section>
              </div>
            </>
          ) : null}
        </DialogPrimitive.Popup>
      </DialogPortal>
    </Dialog>
  );
}
