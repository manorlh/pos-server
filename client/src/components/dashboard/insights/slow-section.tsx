'use client';

/**
 * Slow movers and dead stock (מוצרים איטיים): what is on sale but has not sold for N days
 * — "don't order it again", or with stock on the shelf "sell it off first" — the long
 * tail that sells under a quarter of a fair share, and the items down 40% or more.
 */

import { useTranslations } from 'next-intl';
import { PackageX, Snail, TrendingDown } from 'lucide-react';
import { agorot, type SlowReport } from '@/lib/insightsApi';
import { formatDate, formatQuantity } from '@/lib/format';
import { Card, Chip, IOS, Muted, RowDivider, Segmented } from './ios';

export const DEAD_DAY_OPTIONS = ['14', '21', '30', '60'] as const;
export type DeadDays = (typeof DEAD_DAY_OPTIONS)[number];

function ListHeader({ icon, color, title, hint }: { icon: React.ReactNode; color: string; title: string; hint: string }) {
  return (
    <div className="flex items-start gap-3 px-4 pb-2 pt-3">
      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-white" style={{ backgroundColor: color }} aria-hidden>
        {icon}
      </span>
      <div className="min-w-0">
        <div className="text-[17px] font-semibold">{title}</div>
        <p className="text-[13px] leading-snug text-[#8E8E93]">{hint}</p>
      </div>
    </div>
  );
}

export function SlowSection({
  data,
  deadDays,
  onDeadDays,
  renderActions,
}: {
  data: SlowReport;
  deadDays: DeadDays;
  onDeadDays: (v: DeadDays) => void;
  /** One-tap actions under a product row (insights-actions: quick message / promotion and their result). */
  renderActions?: (row: { productId: string | null; name: string }) => React.ReactNode;
}) {
  const t = useTranslations('insights.slow');
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 px-1">
        <span className="text-[13px] text-[#8E8E93]">{t('threshold')}</span>
        <Segmented
          value={deadDays}
          onChange={onDeadDays}
          className="w-64"
          label={t('threshold')}
          options={DEAD_DAY_OPTIONS.map((d) => ({ id: d, label: t('days', { days: Number(d) }) }))}
        />
      </div>

      <Card className="p-0">
        <ListHeader icon={<PackageX className="h-4 w-4" />} color={IOS.orange} title={t('deadTitle', { count: data.dead.length })} hint={t('deadHint', { days: data.thresholds.deadDays })} />
        {data.dead.length === 0 ? (
          <Muted className="border-t border-[#3C3C4349] px-4 py-3 dark:border-[#54545899]">{t('noDead')}</Muted>
        ) : (
          <ul className="border-t border-[#3C3C4349] dark:border-[#54545899]">
            {data.dead.map((r, i) => (
              <li key={r.key} className="relative flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 px-4 py-2.5">
                {i > 0 ? <RowDivider /> : null}
                <div className="min-w-0">
                  <div className="truncate text-[15px] font-medium">{r.name}</div>
                  <div className="text-[13px] text-[#8E8E93]">
                    {r.never ? t('never', { days: r.lookbackDays }) : t('lastSold', { days: r.daysSinceSale ?? 0, date: formatDate(r.lastSold) })}
                    {r.onHand ? ` · ${t('onHand', { qty: formatQuantity(r.onHand) })}` : ''}
                    {r.stockValue ? ` · ${agorot(r.stockValue)}` : ''}
                  </div>
                </div>
                <Chip color={r.action === 'sell_off_dont_reorder' ? IOS.red : IOS.orange}>
                  {r.action === 'sell_off_dont_reorder' ? t('actionSellOff') : t('actionDontReorder')}
                </Chip>
                {renderActions ? <div className="basis-full">{renderActions(r)}</div> : null}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card className="p-0">
          <ListHeader icon={<Snail className="h-4 w-4" />} color={IOS.indigo} title={t('slowTitle', { count: data.slow.length })} hint={t('slowHint')} />
          {data.slow.length === 0 ? (
            <Muted className="border-t border-[#3C3C4349] px-4 py-3 dark:border-[#54545899]">{t('noSlow')}</Muted>
          ) : (
            <ul className="border-t border-[#3C3C4349] dark:border-[#54545899]">
              {data.slow.map((r, i) => (
                <li key={r.key} className="relative flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 px-4 py-2.5">
                  {i > 0 ? <RowDivider /> : null}
                  <div className="min-w-0">
                    <div className="truncate text-[15px] font-medium">{r.name}</div>
                    <div className="text-[13px] tabular-nums text-[#8E8E93]">
                      {t('slowLine', { perWeek: formatQuantity(r.perWeek ?? 0), mix: r.menuMix.toFixed(1), fair: r.fairShare.toFixed(1) })}
                    </div>
                  </div>
                  <span className="shrink-0 text-[13px] text-[#8E8E93]">
                    {r.action === 'order_less' ? t('actionOrderLess') : t('actionPromote')}
                  </span>
                  {renderActions ? <div className="basis-full">{renderActions(r)}</div> : null}
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card className="p-0">
          <ListHeader icon={<TrendingDown className="h-4 w-4" />} color={IOS.red} title={t('decliningTitle', { count: data.declining.length })} hint={t('decliningHint', { pct: data.thresholds.declinePct })} />
          {data.declining.length === 0 ? (
            <Muted className="border-t border-[#3C3C4349] px-4 py-3 dark:border-[#54545899]">{t('noDeclining')}</Muted>
          ) : (
            <ul className="border-t border-[#3C3C4349] dark:border-[#54545899]">
              {data.declining.map((r, i) => (
                <li key={r.key} className="relative flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 px-4 py-2.5">
                  {i > 0 ? <RowDivider /> : null}
                  <div className="min-w-0">
                    <div className="truncate text-[15px] font-medium">{r.name}</div>
                    <div className="text-[13px] tabular-nums text-[#8E8E93]">
                      {t('decliningLine', { units: formatQuantity(r.units), prev: formatQuantity(r.unitsPrev) })}
                    </div>
                  </div>
                  <span className="shrink-0 text-[15px] font-semibold tabular-nums" dir="ltr">
                    {r.changePct !== null ? `${Math.round(r.changePct)}%` : '—'}
                  </span>
                  {renderActions ? <div className="basis-full">{renderActions(r)}</div> : null}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
