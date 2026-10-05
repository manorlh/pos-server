'use client';

/**
 * The overview's header figures for the scope, today: the money (from the server's
 * overview, the per-cashier report's definition) and the tills' live state (from the
 * machines list). Two columns on a phone, the sales figure across both.
 */

import { useTranslations } from 'next-intl';
import {
  AlertTriangle,
  Banknote,
  Clock,
  Receipt,
  ShoppingCart,
  TrendingUp,
  Wifi,
} from 'lucide-react';
import { formatCurrency, formatQuantity } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';
import type { OverviewKpis as Kpis } from '@/lib/types';

function Tile({
  label,
  icon: Icon,
  value,
  sub,
  loading,
  className,
  tone,
}: {
  label: string;
  icon: React.ElementType;
  value: React.ReactNode;
  sub?: React.ReactNode;
  loading: boolean;
  className?: string;
  tone?: 'warn';
}) {
  return (
    <div className={cn('min-w-0 rounded-xl bg-card p-3 ring-1 ring-foreground/10', className)}>
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="truncate">{label}</span>
        <Icon className={cn('h-4 w-4 shrink-0', tone === 'warn' && 'text-amber-600')} aria-hidden />
      </div>
      {loading ? (
        <Skeleton className="mt-2 h-7 w-20" />
      ) : (
        <>
          <p className="mt-1 truncate text-xl font-bold tabular-nums">{value}</p>
          {sub ? <div className="mt-0.5 truncate text-xs text-muted-foreground">{sub}</div> : null}
        </>
      )}
    </div>
  );
}

export function OverviewKpis({
  kpis,
  salesLoading,
  tills,
  liveLoading,
}: {
  kpis?: Kpis;
  salesLoading: boolean;
  tills: { online: number; total: number; openShifts: number; alerts: number };
  liveLoading: boolean;
}) {
  const t = useTranslations('dashboard.overview.kpi');
  const cashShare =
    kpis && kpis.cash + kpis.card > 0 ? Math.round((kpis.cash / (kpis.cash + kpis.card)) * 100) : null;

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <Tile
          className="col-span-2 md:col-span-1"
          label={t('sales')}
          icon={TrendingUp}
          loading={salesLoading}
          value={<span className="text-2xl">{formatCurrency(kpis?.salesToday ?? 0)}</span>}
          sub={
            kpis
              ? t('salesSub', { gross: formatCurrency(kpis.gross), refunds: formatCurrency(kpis.refunds) })
              : null
          }
        />
        <Tile
          label={t('documents')}
          icon={Receipt}
          loading={salesLoading}
          value={formatQuantity(kpis?.documentsToday ?? 0)}
          sub={kpis ? t('documentsSub', { sales: kpis.salesCount, refunds: kpis.refundsCount }) : null}
        />
        <Tile
          label={t('averageTicket')}
          icon={ShoppingCart}
          loading={salesLoading}
          value={formatCurrency(kpis?.averageTicket ?? 0)}
          sub={kpis && kpis.tips > 0 ? t('tips', { amount: formatCurrency(kpis.tips) }) : null}
        />
        <Tile
          className="col-span-2 md:col-span-1"
          label={t('cashCard')}
          icon={Banknote}
          loading={salesLoading}
          value={
            <span className="text-base">
              {formatCurrency(kpis?.cash ?? 0)} / {formatCurrency(kpis?.card ?? 0)}
            </span>
          }
          sub={
            cashShare !== null ? (
              <div className="space-y-1">
                {/* Not a chart: one proportion, read at a glance; the figures are above. */}
                <div className="flex h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
                  <div className="h-full bg-emerald-500" style={{ width: `${cashShare}%` }} />
                  <div className="h-full flex-1 bg-sky-500" />
                </div>
                <div className="flex justify-between">
                  <span>
                    {t('cash')} {cashShare}%
                  </span>
                  <span>
                    {t('card')} {100 - cashShare}%
                  </span>
                </div>
              </div>
            ) : null
          }
        />
      </div>
      <div className="grid grid-cols-3 gap-2">
        <Tile
          label={t('tillsOnline')}
          icon={Wifi}
          loading={liveLoading}
          value={
            <span dir="ltr">
              {tills.online}/{tills.total}
            </span>
          }
        />
        <Tile label={t('openShifts')} icon={Clock} loading={liveLoading} value={tills.openShifts} />
        <Tile
          label={t('alerts')}
          icon={AlertTriangle}
          loading={liveLoading}
          value={tills.alerts}
          tone={tills.alerts > 0 ? 'warn' : undefined}
        />
      </div>
    </div>
  );
}
