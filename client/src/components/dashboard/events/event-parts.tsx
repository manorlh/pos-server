'use client';

/**
 * Small shared pieces of the event report page: the level colours and icons, the status
 * chip, the per-till palette, and a print-aware section wrapper — in the iOS language of
 * the insights page (components/dashboard/insights/ios.tsx).
 */

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { CircleCheck, Info, Lock, OctagonAlert, TriangleAlert } from 'lucide-react';
import type { EventStatus, InsightLevel, ReconcileStatus } from '@/lib/eventTypes';
import { formatCurrency } from '@/lib/format';
import { cn } from '@/lib/utils';
import { IOS, SectionHeader } from '@/components/dashboard/insights/ios';

export const LEVEL_COLOR: Record<InsightLevel, string> = {
  alert: IOS.red,
  warning: IOS.orange,
  info: IOS.blue,
};

export const LEVEL_ICON: Record<InsightLevel, typeof Info> = {
  alert: OctagonAlert,
  warning: TriangleAlert,
  info: Info,
};

/** One colour per till, in the order the report lists them. */
export const TILL_PALETTE = [IOS.blue, IOS.orange, IOS.green, IOS.purple, IOS.teal, IOS.pink, IOS.indigo, '#A2845E', IOS.red, '#64D2FF'];

export function tillColor(index: number): string {
  return TILL_PALETTE[index % TILL_PALETTE.length];
}

export const money = (value: number | null | undefined) => formatCurrency(value ?? null);

export function pctText(value: number | null | undefined, digits = 1): string {
  return value === null || value === undefined ? '—' : `${value.toFixed(digits)}%`;
}

export function count(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : value.toLocaleString('he-IL', { maximumFractionDigits: 3 });
}

/** "₪1.2K" style ticks for a chart axis. */
export function compactMoney(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `₪${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `₪${(value / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}K`;
  return `₪${Math.round(value)}`;
}

export function LevelBadge({ level }: { level: InsightLevel }) {
  const t = useTranslations('events.levels');
  const Icon = LEVEL_ICON[level];
  const color = LEVEL_COLOR[level];
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[12px] font-semibold"
      style={{ backgroundColor: `${color}1F`, color }}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {t(level)}
    </span>
  );
}

export function StatusChip({ status }: { status: EventStatus }) {
  const t = useTranslations('events.status');
  const confirmed = status === 'confirmed';
  const color = confirmed ? IOS.green : IOS.orange;
  const Icon = confirmed ? Lock : CircleCheck;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[12px] font-semibold"
      style={{ backgroundColor: `${color}1F`, color }}
    >
      {confirmed ? <Icon className="h-3.5 w-3.5" aria-hidden /> : null}
      {t(status)}
    </span>
  );
}

export function ReconcileChip({ status }: { status: ReconcileStatus | 'legacy' | 'n/a' | null | undefined }) {
  const t = useTranslations('events.reconcile.status');
  const key = status === 'n/a' ? 'na' : (status ?? 'none');
  const color =
    key === 'match' ? IOS.green : key === 'mismatch' ? IOS.red : key === 'pending' ? IOS.orange : IOS.gray;
  return (
    <span
      className="inline-flex items-center rounded-full px-2 py-0.5 text-[12px] font-semibold"
      style={{ backgroundColor: `${color}1F`, color }}
    >
      {t(key)}
    </span>
  );
}

/** A report section: the grouped header, then its content; kept whole on a printed page. */
export function EventSection({
  id,
  title,
  trailing,
  children,
  className,
}: {
  id: string;
  title: string;
  trailing?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section aria-labelledby={`ev-${id}-title`} className={cn('print:break-inside-avoid-page', className)}>
      <SectionHeader id={`ev-${id}`} trailing={trailing ? <div className="print:hidden">{trailing}</div> : undefined}>
        <span id={`ev-${id}-title`}>{title}</span>
      </SectionHeader>
      {children}
    </section>
  );
}

/** A plain table in the iOS card style (grey header, hairlines, tabular figures). */
export function IosTable({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('overflow-x-auto print:overflow-visible', className)}>
      <table className="w-full min-w-max text-[14px] tabular-nums print:min-w-0 print:text-[10px]">{children}</table>
    </div>
  );
}

export function Th({ children, end = false, className }: { children?: ReactNode; end?: boolean; className?: string }) {
  return (
    <th className={cn('whitespace-nowrap px-2 py-1.5 text-[12px] font-normal text-[#8E8E93]', end ? 'text-end' : 'text-start', className)}>
      {children}
    </th>
  );
}

export function Td({ children, end = false, className }: { children?: ReactNode; end?: boolean; className?: string }) {
  return (
    <td className={cn('whitespace-nowrap border-t border-[#3C3C4320] px-2 py-1.5 dark:border-[#54545866]', end && 'text-end', className)}>
      {children}
    </td>
  );
}
