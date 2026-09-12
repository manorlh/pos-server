'use client';

/**
 * The terminal status light.
 *
 * Renders only. The status itself is resolved server-side (`machine_status.py`) so that
 * the dashboard, the close-day gate and anything added later read one definition — the
 * online window used to be a 90-second constant copy-pasted into both this page and the
 * server, which is one refactor away from telling a manager a till is reachable while
 * the close-day gate disagrees.
 *
 * A dot alone would be unreadable to anyone who has not memorised the colours, and
 * colour alone fails for the colour-blind, so every light carries its label and an
 * accessible title.
 */

import { useTranslations } from 'next-intl';
import type { PosMachine } from '@/lib/types';

type Status = NonNullable<PosMachine['status']>;

/** Dot colour per status. Deliberately the merchant's four, plus the three additions. */
const DOT: Record<Status, string> = {
  online: 'bg-emerald-500',
  pending_sync: 'bg-amber-500',
  close_pending: 'bg-blue-500',
  offline: 'bg-red-500',
  // Louder than plain offline on purpose: unsent money on a terminal nobody can reach.
  offline_with_unsynced: 'bg-red-600 ring-2 ring-red-300',
  day_closed: 'bg-neutral-800',
  retired: 'bg-neutral-400',
  not_paired: 'bg-neutral-300',
};

/**
 * A terminal that has never been paired reports no status of its own; treat the absence
 * as exactly that rather than defaulting to a colour that implies a working terminal.
 */
export function machineStatus(m: PosMachine): Status {
  return m.status ?? 'not_paired';
}

export function MachineStatusDot({ m, className = '' }: { m: PosMachine; className?: string }) {
  const t = useTranslations('machineStatus');
  const status = machineStatus(m);
  return (
    <span
      className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${DOT[status]} ${className}`}
      role="img"
      aria-label={t(`status.${status}`)}
      title={t(`status.${status}`)}
    />
  );
}

export function MachineStatusLabel({ m }: { m: PosMachine }) {
  const t = useTranslations('machineStatus');
  const status = machineStatus(m);
  const pending = m.pendingDocuments ?? 0;

  return (
    <span className="inline-flex items-center gap-2">
      <MachineStatusDot m={m} />
      <span className="text-sm">{t(`status.${status}`)}</span>
      {/* The count is what makes the amber and loud-red lights actionable — "3 sales
          not yet sent" is a different conversation from "something is pending". */}
      {pending > 0 && (status === 'pending_sync' || status === 'offline_with_unsynced') ? (
        <span className="text-muted-foreground text-xs tabular-nums">
          {t('pendingDocuments', { count: pending })}
        </span>
      ) : null}
    </span>
  );
}

/** Secondary conditions, as quiet badges. They never change the light. */
export function MachineStatusFlags({ m }: { m: PosMachine }) {
  const t = useTranslations('machineStatus');
  const flags = m.statusFlags ?? [];
  if (flags.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {flags.map((f) => (
        <span
          key={f}
          className="border-muted-foreground/30 text-muted-foreground rounded border px-1.5 py-0.5 text-[11px]"
        >
          {t(`flag.${f}`)}
        </span>
      ))}
    </span>
  );
}
