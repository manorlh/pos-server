'use client';

/**
 * Stock-out risk (סכנת חוסר): for every stocked product in the scope's shops, how many
 * days the shelf lasts at the last 28 days' pace, what that means (out, critical under
 * the lead time, low under a week, below the shop's minimum, dead stock, overstock) and
 * how much to order to cover lead time + a week (or up to the shop's maximum).
 */

import { useTranslations } from 'next-intl';
import { AlertOctagon, AlertTriangle, ArchiveX, CheckCircle2, PackageOpen, ShoppingCart } from 'lucide-react';
import { agorot, type StockReport, type StockStatus } from '@/lib/insightsApi';
import { formatQuantity } from '@/lib/format';
import { Capsule, Card, Chip, IOS, Muted, RowDivider } from './ios';

const STATUS_STYLE: Record<StockStatus, { color: string; icon: React.ReactNode }> = {
  out: { color: IOS.red, icon: <AlertOctagon className="h-3 w-3" /> },
  critical: { color: IOS.red, icon: <AlertTriangle className="h-3 w-3" /> },
  low: { color: IOS.orange, icon: <AlertTriangle className="h-3 w-3" /> },
  below_min: { color: IOS.orange, icon: <ShoppingCart className="h-3 w-3" /> },
  dead: { color: IOS.gray, icon: <ArchiveX className="h-3 w-3" /> },
  overstock: { color: IOS.indigo, icon: <PackageOpen className="h-3 w-3" /> },
  ok: { color: IOS.green, icon: <CheckCircle2 className="h-3 w-3" /> },
};

export function StockSection({ data }: { data: StockReport }) {
  const t = useTranslations('insights.stock');
  const label = (s: StockStatus) =>
    s === 'out'
      ? t('status.out')
      : s === 'critical'
        ? t('status.critical')
        : s === 'low'
          ? t('status.low')
          : s === 'below_min'
            ? t('status.below_min')
            : s === 'dead'
              ? t('status.dead')
              : s === 'overstock'
                ? t('status.overstock')
                : t('status.ok');
  if (!data.hasStock || data.rows.length === 0) {
    return (
      <Card>
        <Muted>{t('none')}</Muted>
      </Card>
    );
  }
  const target = (data.params?.leadDays ?? 2) + (data.params?.targetDays ?? 7);
  return (
    <Card className="p-0">
      <p className="px-4 pb-2 pt-3 text-[13px] leading-snug text-[#8E8E93]">
        {t('hint', { days: data.params?.velocityDays ?? 28, lead: data.params?.leadDays ?? 2, target: data.params?.targetDays ?? 7 })}
      </p>
      <ul className="border-t border-[#3C3C4349] dark:border-[#54545899]">
        {data.rows.slice(0, 40).map((r, i) => {
          const style = STATUS_STYLE[r.status];
          return (
            <li key={`${r.key}-${r.shopId}`} className="relative px-4 py-2.5">
              {i > 0 ? <RowDivider /> : null}
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-[15px] font-medium">{r.name}</div>
                  <div className="flex flex-wrap items-center gap-1.5 text-[13px] text-[#8E8E93]">
                    <Chip color={style.color} icon={style.icon}>{label(r.status)}</Chip>
                    {r.shopName ? <span>{r.shopName}</span> : null}
                    <span className="tabular-nums">{t('line', { onHand: formatQuantity(r.onHand), perDay: formatQuantity(r.perDay) })}</span>
                    {r.sellThroughPct !== null ? <span className="tabular-nums">{t('sellThrough', { pct: Math.round(r.sellThroughPct) })}</span> : null}
                    {r.stockValue ? <span className="tabular-nums">{agorot(r.stockValue)}</span> : null}
                  </div>
                </div>
                <div className="shrink-0 text-end">
                  <div className="text-[15px] font-semibold tabular-nums">
                    {r.daysOfCover !== null ? t('cover', { days: formatQuantity(r.daysOfCover) }) : '—'}
                  </div>
                  {r.suggestedOrder ? <div className="text-[13px] font-semibold tabular-nums">{t('order', { qty: r.suggestedOrder })}</div> : null}
                </div>
              </div>
              {r.daysOfCover !== null ? (
                <div className="mt-1.5">
                  <Capsule value={Math.min(r.daysOfCover, target * 2)} max={target * 2} color={style.color} />
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
