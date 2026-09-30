'use client';

/**
 * Device health for a POS terminal: serial, battery, clock skew, printer, last report.
 *
 * Two of these fields lie easily, so the rules are enforced here rather than at
 * each call site:
 *
 * * **`batteryPercent === null` means "the device could not read it", not 0%.**
 *   A null rendered as an empty battery is a false low-battery alarm in front of a
 *   distributor, so null gets a neutral "unknown" badge and no gauge at all.
 * * **`clockSkewMs` is signed**, and negative means the device is *behind* the
 *   server. It can legitimately be enormous (a terminal whose clock was never
 *   set), so it is shown as a human duration with an explicit direction, and
 *   graded against the same thresholds the till itself uses.
 *
 * * **`printerStatus === null` means the till never reported its printer** (an older
 *   build), which is not "the printer is fine": the row is left out rather than
 *   shown as OK. A reading is the till's last one, so it always says "as of".
 *
 * A terminal that has never reported health has nulls throughout; that renders as
 * "no data yet", never as a fault.
 */

import { useTranslations } from 'next-intl';
import { formatDistanceToNow } from 'date-fns';
import { he } from 'date-fns/locale';
import {
  Battery,
  BatteryCharging,
  BatteryFull,
  BatteryLow,
  BatteryMedium,
  BatteryWarning,
  Clock,
  Hash,
  Printer,
} from 'lucide-react';
import type { PosMachine, PrinterStatus } from '@/lib/types';
import { formatApproxDuration, formatDateTime } from '@/lib/format';
import { Badge } from '@/components/ui/badge';

/** Thresholds the till applies to its own clock: 2 min notable, 15 min severe. */
export const CLOCK_SKEW_NOTABLE_MS = 2 * 60 * 1000;
export const CLOCK_SKEW_SEVERE_MS = 15 * 60 * 1000;

export type ClockSkewSeverity = 'unknown' | 'ok' | 'notable' | 'severe';

export function clockSkewSeverity(ms: number | null | undefined): ClockSkewSeverity {
  if (ms === null || ms === undefined) return 'unknown';
  const abs = Math.abs(ms);
  if (abs >= CLOCK_SKEW_SEVERE_MS) return 'severe';
  if (abs >= CLOCK_SKEW_NOTABLE_MS) return 'notable';
  return 'ok';
}

/** True when the terminal has reported nothing at all — "no data", not a fault. */
export function hasNoHealthData(m: PosMachine): boolean {
  return (
    !m.lastHealthReportAt &&
    (m.batteryPercent === null || m.batteryPercent === undefined) &&
    (m.clockSkewMs === null || m.clockSkewMs === undefined) &&
    !m.serialNumber &&
    !m.printerStatus
  );
}

const SKEW_BADGE_CLASS: Record<ClockSkewSeverity, string> = {
  unknown: '',
  ok: '',
  notable: 'border-amber-500/50 bg-amber-500/15 text-amber-900 dark:text-amber-200',
  severe: '',
};

function skewBadgeVariant(s: ClockSkewSeverity): 'default' | 'secondary' | 'outline' | 'destructive' {
  if (s === 'severe') return 'destructive';
  if (s === 'notable') return 'outline';
  if (s === 'ok') return 'secondary';
  return 'outline';
}

/**
 * "The clock is 4 minutes ahead of / behind the server", or the unknown state.
 * Exported so the page-level drift banner and the card say the same thing.
 */
export function useClockSkewText() {
  const t = useTranslations('machines.health');
  return (ms: number | null | undefined): string => {
    if (ms === null || ms === undefined) return t('skewNoData');
    const severity = clockSkewSeverity(ms);
    if (severity === 'ok') return t('skewInSync', { duration: formatApproxDuration(ms) });
    const duration = formatApproxDuration(ms);
    return ms < 0 ? t('skewBehind', { duration }) : t('skewAhead', { duration });
  };
}

/** Explicit map rather than a template-literal key, matching how the machines
 *  page already resolves the pairing status labels. */
const BATTERY_STATUS_KEY = {
  charging: 'batteryStatus.charging',
  discharging: 'batteryStatus.discharging',
  full: 'batteryStatus.full',
  not_charging: 'batteryStatus.notCharging',
  unknown: 'batteryStatus.unknown',
} as const;

function BatteryRow({ machine: m }: { machine: PosMachine }) {
  const t = useTranslations('machines.health');
  const pct = m.batteryPercent;
  const status = m.batteryStatus ?? null;

  const statusLabel =
    status && status !== 'unknown' ? t(BATTERY_STATUS_KEY[status]) : null;

  // Unknown charge. Deliberately no gauge and no warning colour: the device
  // failed to read the battery, which says nothing about the battery.
  if (pct === null || pct === undefined) {
    return (
      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground flex items-center gap-1.5">
            <Battery className="h-3.5 w-3.5" aria-hidden />
            {t('battery')}
          </span>
          <Badge variant="secondary">{t('batteryUnknown')}</Badge>
        </div>
        <p className="text-muted-foreground text-xs">{t('batteryUnknownNote')}</p>
      </div>
    );
  }

  const charging = status === 'charging';
  const Icon = charging
    ? BatteryCharging
    : pct >= 90 || status === 'full'
      ? BatteryFull
      : pct >= 40
        ? BatteryMedium
        : pct >= 15
          ? BatteryLow
          : BatteryWarning;

  // Colour tracks charge only when the device is not on the charger — a terminal
  // sitting at 4% while charging is not something to alarm about.
  const low = !charging && pct < 15;
  const mid = !charging && pct < 40;

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground flex items-center gap-1.5">
          <Icon
            className={`h-3.5 w-3.5 ${low ? 'text-destructive' : charging ? 'text-emerald-500' : ''}`}
            aria-hidden
          />
          {t('battery')}
        </span>
        <span className={`tabular-nums font-medium ${low ? 'text-destructive' : ''}`}>
          {t('batteryPercent', { pct })}
          {statusLabel ? <span className="text-muted-foreground font-normal"> · {statusLabel}</span> : null}
        </span>
      </div>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-muted"
        role="img"
        aria-label={t('batteryPercent', { pct })}
      >
        <div
          className={low ? 'h-full bg-destructive' : mid ? 'h-full bg-amber-500' : 'h-full bg-emerald-500'}
          style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
        />
      </div>
    </div>
  );
}

/** The statuses that raise the server's `printer_problem` flag. */
const PRINTER_PROBLEMS: readonly PrinterStatus[] = ['no_paper', 'overheated', 'error'];

const PRINTER_STATUS_KEY = {
  ok: 'printerStatus.ok',
  no_paper: 'printerStatus.noPaper',
  overheated: 'printerStatus.overheated',
  error: 'printerStatus.error',
  unavailable: 'printerStatus.unavailable',
  unknown: 'printerStatus.unknown',
} as const;

/** Black-mark sensor codes: an error, but one worth naming — it is the paper type. */
const BLACK_MARK_CODES = [132, 133];

function PrinterRow({ machine: m }: { machine: PosMachine }) {
  const t = useTranslations('machines.health');
  const status = m.printerStatus;
  if (!status) return null;

  const problem = PRINTER_PROBLEMS.includes(status);
  const code = m.printerErrorCode;
  const label =
    status === 'error' && code != null && BLACK_MARK_CODES.includes(code)
      ? t('printerStatus.blackMark')
      : t(PRINTER_STATUS_KEY[status]);
  const text = problem && code != null ? t('printerWithCode', { label, code }) : label;
  const asOf = m.printerStatusAt ?? m.printerReportedAt;

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground flex items-center gap-1.5">
          <Printer className={`h-3.5 w-3.5 ${problem ? 'text-destructive' : ''}`} aria-hidden />
          {t('printer')}
        </span>
        <Badge
          variant={problem ? 'destructive' : status === 'ok' ? 'secondary' : 'outline'}
          title={m.printerMessage ?? undefined}
        >
          {text}
        </Badge>
      </div>
      {problem && m.printerMessage ? (
        <p className="text-muted-foreground text-xs" dir="auto">{m.printerMessage}</p>
      ) : null}
      <p className="text-muted-foreground text-xs">
        {asOf ? t('printerAsOf', { when: formatDateTime(asOf) }) : null}
        {asOf ? ' · ' : null}
        {m.printerLastOkAt
          ? t('printerLastOk', { at: formatDateTime(m.printerLastOkAt) })
          : t('printerNeverOk')}
      </p>
    </div>
  );
}

/** Compact drift chip for a card header / list row. Renders nothing when fine. */
export function ClockSkewChip({ machine: m }: { machine: PosMachine }) {
  const t = useTranslations('machines.health');
  const severity = clockSkewSeverity(m.clockSkewMs);
  if (severity === 'unknown' || severity === 'ok') return null;
  return (
    <Badge
      variant={skewBadgeVariant(severity)}
      className={`gap-1 ${SKEW_BADGE_CLASS[severity]}`}
      title={t(severity === 'severe' ? 'skewSevere' : 'skewNotable')}
    >
      <Clock aria-hidden />
      {t(severity === 'severe' ? 'skewSevere' : 'skewNotable')}
    </Badge>
  );
}

export function MachineHealthPanel({ machine: m }: { machine: PosMachine }) {
  const t = useTranslations('machines.health');
  const skewText = useClockSkewText();
  const severity = clockSkewSeverity(m.clockSkewMs);

  if (hasNoHealthData(m)) {
    return (
      <div className="rounded-md border border-dashed bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
        {t('noData')}
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-md border bg-muted/30 px-3 py-2 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground">{t('title')}</span>
        <ClockSkewChip machine={m} />
      </div>

      {m.serialNumber ? (
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground flex items-center gap-1.5">
            <Hash className="h-3.5 w-3.5" aria-hidden />
            {t('serialNumber')}
          </span>
          <span className="font-mono text-xs" dir="ltr">{m.serialNumber}</span>
        </div>
      ) : null}

      <BatteryRow machine={m} />

      <PrinterRow machine={m} />

      <div className="flex items-start justify-between gap-2">
        <span className="text-muted-foreground flex items-center gap-1.5">
          <Clock className="h-3.5 w-3.5" aria-hidden />
          {t('clockSkew')}
        </span>
        <span
          className={`text-end ${
            severity === 'severe'
              ? 'text-destructive font-medium'
              : severity === 'notable'
                ? 'text-amber-700 dark:text-amber-400'
                : ''
          }`}
        >
          {skewText(m.clockSkewMs)}
        </span>
      </div>

      <div className="text-muted-foreground text-xs">
        {m.lastHealthReportAt
          ? t('lastReport', {
              ago: formatDistanceToNow(new Date(m.lastHealthReportAt), {
                addSuffix: true,
                locale: he,
              }),
              at: formatDateTime(m.lastHealthReportAt),
            })
          : t('neverReported')}
      </div>
    </div>
  );
}

/**
 * Page-level banner naming the terminals whose clocks have drifted.
 *
 * This is the field a distributor scans the list for, and a drifting clock is
 * invisible on a card they have to scroll to — so it is surfaced once, up top,
 * with the offenders named.
 */
export function ClockDriftBanner({ machines }: { machines: PosMachine[] }) {
  const t = useTranslations('machines.health');
  const skewText = useClockSkewText();
  const severe = machines.filter((m) => clockSkewSeverity(m.clockSkewMs) === 'severe');
  const notable = machines.filter((m) => clockSkewSeverity(m.clockSkewMs) === 'notable');
  if (severe.length === 0 && notable.length === 0) return null;

  const worst = severe.length > 0 ? 'severe' : 'notable';
  const listed = [...severe, ...notable].slice(0, 6);

  return (
    <div
      role="status"
      className={
        worst === 'severe'
          ? 'rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive'
          : 'rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-200'
      }
    >
      <div className="flex items-start gap-2">
        <Clock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <div className="min-w-0 space-y-1">
          <p className="font-semibold">
            {t('driftBannerTitle', { severe: severe.length, notable: notable.length })}
          </p>
          <ul className="space-y-0.5 text-xs">
            {listed.map((m) => (
              <li key={m.id}>
                <span className="font-medium">{m.name}</span> — {skewText(m.clockSkewMs)}
              </li>
            ))}
          </ul>
          {severe.length + notable.length > listed.length ? (
            <p className="text-xs">
              {t('driftBannerMore', { count: severe.length + notable.length - listed.length })}
            </p>
          ) : null}
          <p className="text-xs opacity-80">{t('driftBannerWhy')}</p>
        </div>
      </div>
    </div>
  );
}
