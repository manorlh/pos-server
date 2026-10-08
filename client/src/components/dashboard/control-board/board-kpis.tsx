'use client';

/**
 * The board's four headline figures for the scope and the day: sales, transactions,
 * average ticket (each against the compared day, ▲/▼ %) and the tills that are up now.
 * Two by two on a phone, a row of four from `lg`.
 */

import { useTranslations } from 'next-intl';
import { BarChart3, MonitorSmartphone, ShoppingCart, Tag } from 'lucide-react';
import { formatCurrency, formatQuantity } from '@/lib/format';
import { averageTicket, type SalesFigures } from '@/lib/controlBoard';
import { Skeleton } from '@/components/ui/skeleton';
import { Delta, IconBadge, type BadgeTone } from './board-ui';

/** The compared figure, whole shekels from ₪1,000 up: it has to fit beside the change on a phone. */
function shortMoney(n: number): string {
  return new Intl.NumberFormat('he-IL', {
    style: 'currency',
    currency: 'ILS',
    maximumFractionDigits: Math.abs(n) >= 1000 ? 0 : 2,
  }).format(n);
}

function KpiCard({
  label,
  icon,
  tone,
  value,
  compare,
  detail,
  loading,
}: {
  label: string;
  icon: React.ElementType;
  tone: BadgeTone;
  value: React.ReactNode;
  compare?: React.ReactNode;
  detail?: React.ReactNode;
  loading: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-2xl border border-cb-line bg-cb-card p-3.5 shadow-[var(--cb-shadow)] md:p-5">
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 pt-0.5 text-[13px] font-medium text-cb-muted md:text-sm">{label}</span>
        <IconBadge icon={icon} tone={tone} className="max-md:size-8 max-md:[&>svg]:size-4" />
      </div>
      {loading ? (
        <Skeleton className="mt-1 h-8 w-24 bg-cb-soft" />
      ) : (
        <>
          <p className="truncate text-[22px] font-bold leading-tight tracking-tight tabular-nums text-cb-ink md:text-[28px]">
            {value}
          </p>
          {compare ? <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-cb-muted">{compare}</div> : null}
          {detail ? <p className="text-[11px] leading-snug text-cb-muted md:text-xs">{detail}</p> : null}
        </>
      )}
    </div>
  );
}

export function BoardKpis({
  a,
  b,
  isToday,
  salesLoading,
  compareLoading,
  tills,
  liveLoading,
  versusTitle,
  showSales = true,
}: {
  a: SalesFigures;
  /** The compared day's figures; null with no comparison. */
  b: SalesFigures | null;
  isToday: boolean;
  salesLoading: boolean;
  compareLoading: boolean;
  tills: { online: number; total: number; openShifts: number };
  liveLoading: boolean;
  /** "מול ראשון שעבר", for the change's tooltip. */
  versusTitle: string;
  /** False for a user without "דוחות": only the tills that are up. */
  showSales?: boolean;
}) {
  const t = useTranslations('controlBoard.kpi');
  const tillsCard = (
    <KpiCard
      label={t('activeTills')}
      icon={MonitorSmartphone}
      tone="green"
      loading={liveLoading}
      value={t('activeTillsValue', { online: tills.online, total: tills.total })}
      detail={t('openShifts', { count: tills.openShifts })}
    />
  );
  if (!showSales) return <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">{tillsCard}</div>;

  const vs = (va: number, vb: number, format: (n: number) => string, invert = false) =>
    b && !compareLoading ? (
      <span className="inline-flex min-w-0 items-center gap-1.5" title={versusTitle}>
        <Delta a={va} b={vb} invert={invert} />
        <span className="truncate tabular-nums">{t('versus', { value: format(vb) })}</span>
      </span>
    ) : null;

  const avgA = averageTicket(a);
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
      <KpiCard
        label={isToday ? t('salesToday') : t('sales')}
        icon={BarChart3}
        tone="blue"
        loading={salesLoading}
        value={formatCurrency(a.salesToday)}
        compare={vs(a.salesToday, b?.salesToday ?? 0, shortMoney)}
        detail={t('salesSub', { gross: formatCurrency(a.gross), refunds: formatCurrency(a.refunds) })}
      />
      <KpiCard
        label={t('transactions')}
        icon={ShoppingCart}
        tone="blue"
        loading={salesLoading}
        value={formatQuantity(a.salesCount)}
        compare={vs(a.salesCount, b?.salesCount ?? 0, (n) => formatQuantity(n))}
        detail={t('transactionsSub', { documents: a.documentsToday, refunds: a.refundsCount })}
      />
      <KpiCard
        label={t('averageTicket')}
        icon={Tag}
        tone="purple"
        loading={salesLoading}
        value={formatCurrency(avgA)}
        compare={vs(avgA, b ? averageTicket(b) : 0, shortMoney)}
        detail={a.tips > 0 ? t('tips', { amount: formatCurrency(a.tips) }) : null}
      />
      {tillsCard}
    </div>
  );
}
