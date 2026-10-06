'use client';

/**
 * The pieces of "תקינות מכשירים": the words for the server's codes (`deviceHealth.*`, an
 * unknown code shown as sent), the status tones — never colour alone: each pill carries an
 * icon and its words — and the part pills a kiosk card and the drawer share.
 */

import { useEffect, useMemo, useState, type ComponentType } from 'react';
import { useTranslations } from 'next-intl';
import { formatDistanceStrict } from 'date-fns';
import { he } from 'date-fns/locale';
import {
  AlertTriangle,
  AppWindow,
  Cable,
  CheckCircle2,
  CircleDashed,
  CloudUpload,
  CreditCard,
  Image as ImageIcon,
  Info,
  MinusCircle,
  MonitorPlay,
  Printer,
  WifiOff,
  XCircle,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  OVERALL_STATES,
  PART_LEVELS,
  SCREEN_CODES,
  cardLockKey,
  knownCode,
  levelTone,
  overallTone,
  partCode,
  type HealthOverall,
  type HealthPart,
  type HealthPartKey,
  type HealthTone,
} from '@/lib/kioskInsights';

/** `Date.now()`, refreshed every `intervalMs`, so "לפני 2 דק׳" stays true between fetches. */
export function useNowMs(intervalMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** "לפני 3 דקות" relative to `nowMs`; null for nothing. */
export function agoText(iso: string | null | undefined, nowMs: number): string | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return null;
  return formatDistanceStrict(Math.min(at, nowMs), nowMs, { addSuffix: true, locale: he });
}

export const TONE: Record<HealthTone, { dot: string; pill: string; text: string; ring: string }> = {
  ok: {
    dot: 'bg-emerald-500',
    pill: 'bg-emerald-50 text-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-100',
    text: 'text-emerald-700 dark:text-emerald-300',
    ring: 'ring-emerald-500/40',
  },
  info: {
    dot: 'bg-sky-500',
    pill: 'bg-sky-50 text-sky-900 dark:bg-sky-950/50 dark:text-sky-100',
    text: 'text-sky-700 dark:text-sky-300',
    ring: 'ring-sky-500/40',
  },
  warn: {
    dot: 'bg-amber-500',
    pill: 'bg-amber-50 text-amber-900 dark:bg-amber-950/50 dark:text-amber-100',
    text: 'text-amber-700 dark:text-amber-300',
    ring: 'ring-amber-500/50',
  },
  error: {
    dot: 'bg-red-500',
    pill: 'bg-red-50 text-red-900 dark:bg-red-950/50 dark:text-red-100',
    text: 'text-red-700 dark:text-red-300',
    ring: 'ring-red-500/50',
  },
  muted: {
    dot: 'bg-neutral-400',
    pill: 'bg-muted text-muted-foreground',
    text: 'text-muted-foreground',
    ring: 'ring-neutral-400/40',
  },
};

const TONE_ICON: Record<HealthTone, ComponentType<{ className?: string }>> = {
  ok: CheckCircle2,
  info: Info,
  warn: AlertTriangle,
  error: XCircle,
  muted: MinusCircle,
};

export const PART_ICON: Record<HealthPartKey, ComponentType<{ className?: string }>> = {
  app: AppWindow,
  terminal: CreditCard,
  printer: Printer,
  tillLink: Cable,
  kds: MonitorPlay,
  media: ImageIcon,
  uploads: CloudUpload,
};

/** The icon of a state: the tone's, offline its own, a part never reported a dashed circle. */
export function ToneIcon({ tone, offline, unknown, className }: { tone: HealthTone; offline?: boolean; unknown?: boolean; className?: string }) {
  const Icon = offline ? WifiOff : unknown ? CircleDashed : TONE_ICON[tone];
  return <Icon className={cn('shrink-0', className)} aria-hidden />;
}

const TIME_KEYS = new Set(['since', 'until', 'checkedAt', 'at', 'lastSeenAt', 'oldestAt']);

export function useHealthLabels() {
  const t = useTranslations('deviceHealth');
  return useMemo(() => {
    const has = (key: string) => t.has(key);
    return {
      part: (key: HealthPartKey) => t(`parts.${key}`),
      code: (p: Pick<HealthPart, 'key' | 'code'>) => (partCode(p) ? t(`codes.${p.key}.${p.code}`) : p.code),
      level: (level: string) => (knownCode(PART_LEVELS, level) ? t(`levels.${level}`) : level),
      overall: (o: string) => (knownCode(OVERALL_STATES, o) ? t(`overall.${o}`) : o),
      screen: (s: string | null | undefined) => (knownCode(SCREEN_CODES, s) ? t(`screens.${s}`) : s || '—'),
      lock: (l: unknown) => {
        const k = cardLockKey(l);
        return k ? t(`lock.${k}`) : String(l ?? '—');
      },
      platform: (p: string | null | undefined) => (p === 'android' || p === 'windows' ? t(`platform.${p}`) : null),
      route: (r: string | null | undefined) => (r && has(`network.${r}`) ? t(`network.${r}`) : r || null),
      alertKind: (k: string) => (has(`alertKinds.${k}`) ? t(`alertKinds.${k}`) : k),
      command: (a: string | null | undefined) => (a && has(`commands.${a}`) ? t(`commands.${a}`) : a || '—'),
      commandStatus: (s: string | null | undefined) => (s && has(`commandStatus.${s}`) ? t(`commandStatus.${s}`) : s || ''),
      endReason: (r: string | null | undefined) => (r && has(`endReasons.${r}`) ? t(`endReasons.${r}`) : r || t('endReasons.open')),
      kdsRole: (r: string) => (has(`kdsRoles.${r}`) ? t(`kdsRoles.${r}`) : r),
      detailKey: (k: string) => (has(`detailKeys.${k}`) ? t(`detailKeys.${k}`) : k),
      linkMode: (m: string) => (has(`codes.tillLink.${m}`) ? t(`codes.tillLink.${m}`) : m),
      /** The settings level a value comes from ("shop" → "סניף"). */
      source: (s: string) => (has(`sources.${s}`) ? t(`sources.${s}`) : s),
    };
  }, [t]);
}

export type HealthLabels = ReturnType<typeof useHealthLabels>;

/** A part's detail as label / value lines: times as "לפני …", codes worded, the rest as sent. */
export function detailLines(
  part: Pick<HealthPart, 'key' | 'detail'>,
  L: HealthLabels,
  nowMs: number,
  formatTime: (iso: string) => string,
): { key: string; label: string; value: string; title?: string }[] {
  const out: { key: string; label: string; value: string; title?: string }[] = [];
  for (const [key, raw] of Object.entries(part.detail ?? {})) {
    if (raw === null || raw === undefined || raw === '') continue;
    let value: string;
    let title: string | undefined;
    if (TIME_KEYS.has(key) && typeof raw === 'string') {
      value = agoText(raw, nowMs) ?? raw;
      title = formatTime(raw);
    } else if (key === 'screen') {
      value = L.screen(String(raw));
    } else if (key === 'lock') {
      value = L.lock(raw);
    } else if (key === 'mode') {
      value = L.linkMode(String(raw));
    } else if (typeof raw === 'number') {
      value = raw.toLocaleString('he-IL');
    } else if (typeof raw === 'boolean') {
      value = raw ? '✓' : '✗';
    } else {
      value = typeof raw === 'string' ? raw : JSON.stringify(raw);
    }
    out.push({ key, label: L.detailKey(key), value, title });
  }
  return out;
}

/** One part: its icon and name, a tone icon, and the code in words — a tooltip with the details. */
export function PartPill({ part, L, title, compact = false }: { part: HealthPart; L: HealthLabels; title?: string; compact?: boolean }) {
  const tone = levelTone(part.level);
  const Icon = PART_ICON[part.key] ?? AppWindow;
  return (
    <span
      className={cn('flex min-w-0 items-start gap-1.5 rounded-xl px-2 py-1.5', TONE[tone].pill)}
      title={title ?? `${L.part(part.key)}: ${L.code(part)}`}
    >
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 opacity-70" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1 text-[11px] font-medium opacity-80">
          <span className="truncate">{L.part(part.key)}</span>
        </span>
        {!compact ? <span className="block truncate text-xs font-semibold">{L.code(part)}</span> : null}
      </span>
      <ToneIcon tone={tone} unknown={part.level === 'unknown'} className={cn('mt-0.5 h-3.5 w-3.5', TONE[tone].text)} />
    </span>
  );
}

/** The kiosk's overall state as a badge: icon, colour and its word. */
export function OverallBadge({ overall, L, className }: { overall: HealthOverall | string; L: HealthLabels; className?: string }) {
  const tone = overallTone(overall);
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold', TONE[tone].pill, className)}>
      <ToneIcon tone={tone} offline={overall === 'offline'} className={cn('h-3.5 w-3.5', TONE[tone].text)} />
      {L.overall(overall)}
    </span>
  );
}
