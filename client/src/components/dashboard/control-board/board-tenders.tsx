'use client';

/**
 * Payment methods (אמצעי תשלום): card, cash and other as one stacked bar with its legend
 * — amount and share, and the change against the compared day, whose own mix sits
 * under it as a thinner bar. Tips apart: they are not takings.
 */

import { useTranslations } from 'next-intl';
import { formatCurrency } from '@/lib/format';
import { tenderShares, type SalesFigures, type TenderKey, type TenderShare } from '@/lib/controlBoard';
import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';
import { BoardCard, CardTitle, Delta } from './board-ui';

const FILL: Record<TenderKey, string> = {
  card: 'bg-cb-blue',
  cash: 'bg-cb-teal',
  other: 'bg-cb-purple',
};

function StackedBar({ shares, thin = false, label }: { shares: TenderShare[]; thin?: boolean; label: string }) {
  const parts = shares.filter((s) => s.share > 0);
  return (
    <div
      role="img"
      aria-label={label}
      className={cn('flex w-full gap-0.5 overflow-hidden rounded-full bg-cb-soft', thin ? 'h-2 opacity-60' : 'h-4')}
    >
      {parts.map((s) => (
        <span key={s.key} className={cn('h-full first:rounded-s-full last:rounded-e-full', FILL[s.key])} style={{ width: `${s.share}%` }} />
      ))}
    </div>
  );
}

export function BoardTenders({
  a,
  b,
  labelA,
  labelB,
  loading,
  className,
}: {
  a: SalesFigures;
  b: SalesFigures | null;
  labelA: string;
  labelB: string | null;
  loading: boolean;
  className?: string;
}) {
  const t = useTranslations('controlBoard.tenders');
  const sharesA = tenderShares(a);
  const sharesB = b ? tenderShares(b) : null;
  const total = sharesA.reduce((s, x) => s + Math.max(0, x.amount), 0);
  const describe = (shares: TenderShare[], day: string) =>
    `${t('split', { day })}: ${shares
      .filter((s) => s.share > 0)
      .map((s) => `${t(s.key)} ${s.share}%`)
      .join(', ')}`;

  return (
    <BoardCard className={className} labelledBy="cb-tenders-title">
      <CardTitle id="cb-tenders-title">{t('title')}</CardTitle>
      {loading ? (
        <Skeleton className="h-24 w-full bg-cb-soft" />
      ) : total <= 0 ? (
        <p className="py-6 text-center text-sm text-cb-muted">{t('empty')}</p>
      ) : (
        <div className="space-y-4">
          <div className="space-y-1.5">
            <StackedBar shares={sharesA} label={describe(sharesA, labelA)} />
            {sharesB && labelB && sharesB.some((s) => s.share > 0) ? (
              <div className="flex items-center gap-2">
                <StackedBar shares={sharesB} thin label={describe(sharesB, labelB)} />
                <span className="shrink-0 text-[11px] text-cb-muted">{labelB}</span>
              </div>
            ) : null}
          </div>
          <ul className="space-y-2.5">
            {sharesA
              .filter((s) => s.amount !== 0 || s.key !== 'other')
              .map((s) => {
                const before = sharesB?.find((x) => x.key === s.key);
                return (
                  <li key={s.key} className="flex items-center justify-between gap-2 text-sm">
                    <span className="flex min-w-0 items-center gap-2">
                      <span aria-hidden className={cn('size-2.5 shrink-0 rounded-full', FILL[s.key])} />
                      <span className="truncate text-cb-ink">{t(s.key)}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2 tabular-nums">
                      <span className="font-semibold text-cb-ink">{formatCurrency(s.amount)}</span>
                      <span className="text-cb-muted">• {s.share}%</span>
                      {before ? <Delta a={s.amount} b={before.amount} /> : null}
                    </span>
                  </li>
                );
              })}
            {a.tips > 0 || (b?.tips ?? 0) > 0 ? (
              <li className="flex items-center justify-between gap-2 border-t border-cb-line pt-2.5 text-sm">
                <span className="text-cb-muted">{t('tips')}</span>
                <span className="flex items-center gap-2 tabular-nums">
                  <span className="font-semibold text-cb-ink">{formatCurrency(a.tips)}</span>
                  {b ? <Delta a={a.tips} b={b.tips} /> : null}
                </span>
              </li>
            ) : null}
          </ul>
        </div>
      )}
    </BoardCard>
  );
}
