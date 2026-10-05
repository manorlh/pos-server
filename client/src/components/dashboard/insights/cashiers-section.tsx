'use client';

/**
 * Employees (עובדים): each one's manual discounts, refunds and voided lines as a share
 * of their sales, against the team. Flagged from twice the team's rate, above a floor
 * (3% / 1% / 1.5%) and from 20 sales — something to look at in the exceptions, not a
 * verdict. Promotions are automatic and are not counted as anyone's discount.
 */

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { AlertTriangle, ShieldAlert } from 'lucide-react';
import { agorot, type CashierMetric, type Cashiers } from '@/lib/insightsApi';
import { Card, Chip, IOS, Muted, RowDivider } from './ios';

function Rate({ label, value, flagged }: { label: string; value: number | null; flagged: boolean }) {
  return (
    <div className="flex min-w-0 flex-col">
      <span className="text-[12px] text-[#8E8E93]">{label}</span>
      <span className={flagged ? 'flex items-center gap-1 text-[15px] font-bold tabular-nums' : 'text-[15px] tabular-nums'}>
        {flagged ? <AlertTriangle className="h-3.5 w-3.5" style={{ color: IOS.orange }} aria-hidden /> : null}
        {value !== null ? `${value.toFixed(1)}%` : '—'}
      </span>
    </div>
  );
}

export function CashiersSection({ data }: { data: Cashiers }) {
  const t = useTranslations('insights.cashiers');
  const tr = useTranslations('insights');
  if (data.rows.length === 0) {
    return (
      <Card>
        <Muted>{tr('noData')}</Muted>
      </Card>
    );
  }
  const metricLabel = (m: CashierMetric) => (m === 'discount' ? t('discounts') : m === 'refund' ? t('refunds') : t('voids'));
  return (
    <Card className="p-0">
      <div className="flex flex-wrap items-start justify-between gap-2 px-4 pb-2 pt-3">
        <p className="max-w-xl text-[13px] leading-snug text-[#8E8E93]">
          {t('hint', { ratio: data.ratio, min: data.minSales, discount: data.floors.discount, refund: data.floors.refund, void: data.floors.void })}
        </p>
        <Link href="/dashboard/exceptions" className="flex items-center gap-1 text-[15px] text-[#007AFF] dark:text-[#0A84FF]">
          <ShieldAlert className="h-4 w-4" aria-hidden />
          {t('toExceptions')}
        </Link>
      </div>
      <div className="grid grid-cols-3 gap-2 border-t border-[#3C3C4349] px-4 py-2 text-center dark:border-[#54545899]">
        <Rate label={t('teamDiscounts')} value={data.team.discountPct} flagged={false} />
        <Rate label={t('teamRefunds')} value={data.team.refundPct} flagged={false} />
        <Rate label={t('teamVoids')} value={data.team.voidPct} flagged={false} />
      </div>
      <ul className="border-t border-[#3C3C4349] dark:border-[#54545899]">
        {data.rows.map((r, i) => {
          const flagged = new Set(r.flags.map((f) => f.metric));
          return (
            <li key={r.cashierId ?? `none-${i}`} className="relative px-4 py-2.5">
              {i > 0 ? <RowDivider /> : null}
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-b from-[#A0A0A8] to-[#7C7C84] text-[15px] font-semibold text-white" aria-hidden>
                    {(r.name ?? '?').trim().charAt(0) || '?'}
                  </span>
                  <div className="min-w-0">
                    <div className="truncate text-[15px] font-medium">{r.name ?? t('noName')}</div>
                    <div className="text-[12px] tabular-nums text-[#8E8E93]">
                      {t('line', { sales: r.sales, gross: agorot(r.gross), cancels: r.cancelsCount })}
                    </div>
                  </div>
                </div>
                <div className="grid shrink-0 grid-cols-3 gap-3 text-center">
                  <Rate label={t('discounts')} value={r.discountPct} flagged={flagged.has('discount')} />
                  <Rate label={t('refunds')} value={r.refundPct} flagged={flagged.has('refund')} />
                  <Rate label={t('voids')} value={r.voidPct} flagged={flagged.has('void')} />
                </div>
              </div>
              {r.flags.length > 0 ? (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {r.flags.map((f) => (
                    <Chip key={f.metric} color={f.level === 'high' ? IOS.red : IOS.orange} icon={<AlertTriangle className="h-3 w-3" />}>
                      {t('flag', { metric: metricLabel(f.metric), times: f.times.toFixed(1), team: f.team.toFixed(1) })}
                    </Chip>
                  ))}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
