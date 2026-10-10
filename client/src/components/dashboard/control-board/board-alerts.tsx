'use client';

/**
 * The alerts card (התראות): the tills that need someone, loudest first — offline with
 * sales it has not sent, unreachable with its shift open ("קופה 08 לא מחוברת — עדכון
 * אחרון לפני 12 דקות"), and reachable tills with something to look at (the overview's
 * alert badges, the card terminal offline, a failed update). A tap opens the till.
 *
 * The rule for who is on it is `alertTills` (lib/controlBoard.ts): a till that closed its
 * shift and was switched off for the night is not an alert.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { formatDistanceToNowStrict } from 'date-fns';
import { he } from 'date-fns/locale';
import { Bell, CircleCheck, CreditCard, TriangleAlert, WifiOff } from 'lucide-react';
import type { TillAlertKind } from '@/lib/controlBoard';
import { machinesColumnAlertCount, type TillNode } from '@/lib/overview';
import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';
import { MachineAlerts } from '@/components/dashboard/machines/machine-row';
import { UpdateChip } from '@/components/dashboard/overview/overview-tree';
import { BoardCard, CardTitle } from './board-ui';

const VISIBLE = 4;

const TONE: Record<TillAlertKind, string> = {
  unsynced: 'border-cb-red/35 bg-cb-red/8',
  offline: 'border-cb-amber/40 bg-cb-amber/10',
  flags: 'border-cb-line bg-cb-soft/60',
};

const ICON: Record<TillAlertKind, { icon: React.ElementType; className: string }> = {
  unsynced: { icon: TriangleAlert, className: 'text-cb-red-ink' },
  offline: { icon: WifiOff, className: 'text-cb-amber-ink' },
  flags: { icon: TriangleAlert, className: 'text-cb-amber-ink' },
};

export interface BoardAlert {
  till: TillNode;
  kind: TillAlertKind;
  /** The shop, when the scope spans more than one. */
  shopName?: string;
}

export function BoardAlerts({
  alerts,
  loading,
  onOpen,
  className,
  id,
}: {
  alerts: BoardAlert[];
  loading: boolean;
  onOpen: (tillId: string) => void;
  className?: string;
  id?: string;
}) {
  const t = useTranslations('controlBoard');
  const tTerminal = useTranslations('cardTerminal');
  const [all, setAll] = useState(false);
  const shown = all ? alerts : alerts.slice(0, VISIBLE);

  const tillName = (till: TillNode) => {
    const n = till.registerNumber;
    return n !== null ? t('tillLabel', { number: String(n).padStart(2, '0') }) : till.sales.name;
  };
  const ago = (iso?: string | null) =>
    iso ? formatDistanceToNowStrict(new Date(iso), { addSuffix: true, locale: he }) : null;

  return (
    <BoardCard id={id} className={cn('scroll-mt-4', className)} labelledBy="cb-alerts-title">
      <CardTitle
        id="cb-alerts-title"
        icon={Bell}
        trailing={
          alerts.length > 0 ? (
            <span className="rounded-full bg-cb-amber/15 px-2 py-0.5 text-xs font-semibold text-cb-amber-ink">
              {t('alerts.count', { count: alerts.length })}
            </span>
          ) : null
        }
      >
        {t('alerts.title')}
      </CardTitle>

      {loading ? (
        <div className="space-y-2">
          <Skeleton className="h-14 w-full bg-cb-soft" />
          <Skeleton className="h-14 w-full bg-cb-soft" />
        </div>
      ) : alerts.length === 0 ? (
        <div className="flex items-start gap-3 rounded-xl border border-cb-green/30 bg-cb-green/10 p-3">
          <CircleCheck className="mt-0.5 size-5 shrink-0 text-cb-green-ink" aria-hidden />
          <div>
            <p className="text-sm font-semibold text-cb-green-ink">{t('alerts.allGood')}</p>
            <p className="text-xs text-cb-muted">{t('alerts.allGoodHint')}</p>
          </div>
        </div>
      ) : (
        <ul className="space-y-2">
          {shown.map(({ till, kind, shopName }) => {
            const m = till.live;
            const base = till.registerNumber !== null ? `${tillName(till)} · ${till.sales.name}` : till.sales.name;
            const label = shopName ? `${base} (${shopName})` : base;
            const seen = ago(m?.lastHeartbeatAt);
            const { icon: Icon, className: iconClass } = ICON[kind];
            let text: string;
            if (kind === 'unsynced') {
              text = t('alerts.unsynced', { till: label, count: m?.pendingDocuments ?? 0, ago: seen ?? '—' });
            } else if (kind === 'offline') {
              text = seen ? t('alerts.offline', { till: label, ago: seen }) : t('alerts.offlineNever', { till: label });
            } else {
              text = label;
            }
            return (
              <li key={till.sales.id}>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest('a, button')) return;
                    onOpen(till.sales.id);
                  }}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return;
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onOpen(till.sales.id);
                    }
                  }}
                  className={cn(
                    'flex min-h-12 cursor-pointer items-start gap-2.5 rounded-xl border p-3 text-sm outline-none transition-colors hover:brightness-[0.98] focus-visible:ring-2 focus-visible:ring-cb-blue/40',
                    TONE[kind],
                  )}
                >
                  <Icon className={cn('mt-0.5 size-4 shrink-0', iconClass)} aria-hidden />
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <p className={cn('leading-snug text-cb-ink', kind !== 'flags' && 'font-medium')}>{text}</p>
                    {m && (kind === 'flags' || till.alerts > 0) ? (
                      <div className="flex min-w-0 flex-wrap items-center gap-1">
                        {machinesColumnAlertCount(m) > 0 ? <MachineAlerts m={m} /> : null}
                        {m.terminalOfflineMode ? (
                          <span className="inline-flex h-6 items-center gap-1 rounded border border-cb-amber/50 bg-cb-amber/10 px-1.5 text-[11px] leading-none text-cb-amber-ink">
                            <CreditCard className="h-3 w-3" aria-hidden />
                            {tTerminal('offlineMode')}
                          </span>
                        ) : null}
                        <UpdateChip row={till.rollout} quietWhenDone />
                      </div>
                    ) : null}
                  </div>
                </div>
              </li>
            );
          })}
          {alerts.length > VISIBLE ? (
            <li>
              <button
                type="button"
                onClick={() => setAll((v) => !v)}
                className="min-h-11 w-full rounded-xl text-sm font-medium text-cb-blue-ink hover:bg-cb-soft"
              >
                {all ? t('alerts.less') : t('alerts.more', { count: alerts.length - VISIBLE })}
              </button>
            </li>
          ) : null}
        </ul>
      )}
    </BoardCard>
  );
}
