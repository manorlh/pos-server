'use client';

/**
 * The basket (סל קנייה): average check, items per sale, how many different products a
 * basket holds, and the pairs bought together more than chance would have it (lift ≥ 1.2,
 * at least 15% of the first item's buyers, a minimum number of baskets) — the candidates
 * for a combo or a suggestion at the till.
 */

import { useTranslations } from 'next-intl';
import { agorot, type Baskets } from '@/lib/insightsApi';
import { Capsule, Card, Figure, Muted, RowDivider } from './ios';

export function BasketsSection({ data }: { data: Baskets }) {
  const t = useTranslations('insights.baskets');
  const tr = useTranslations('insights');
  if (!data.sales) {
    return (
      <Card>
        <Muted>{tr('noData')}</Muted>
      </Card>
    );
  }
  const maxBucket = Math.max(1, ...data.sizes.buckets.map((b) => b.baskets));
  return (
    <div className="space-y-3">
      <Card className="grid grid-cols-3 divide-x divide-x-reverse divide-[#3C3C4349] p-0 py-3 dark:divide-[#54545899]">
        <Figure value={agorot(data.avgCheck)} label={t('avgCheck')} />
        <Figure value={data.itemsPerSale !== null ? data.itemsPerSale.toFixed(1) : '—'} label={t('itemsPerSale')} />
        <Figure
          value={data.sizes.singleItemShare !== null ? `${Math.round(data.sizes.singleItemShare)}%` : '—'}
          label={t('singleItem')}
        />
      </Card>
      <div className="grid gap-3 lg:grid-cols-2">
        <Card>
          <div className="mb-2 text-[17px] font-semibold">{t('sizesTitle')}</div>
          <ul className="space-y-2">
            {data.sizes.buckets.map((b) => (
              <li key={b.size}>
                <div className="flex items-center justify-between text-[15px]">
                  <span>{b.size === '1' ? t('size1') : t('sizeN', { size: b.size })}</span>
                  <span className="tabular-nums text-[#8E8E93]">
                    {t('sizeLine', { baskets: b.baskets.toLocaleString('he-IL'), pct: Math.round(b.share) })}
                  </span>
                </div>
                <Capsule value={b.baskets} max={maxBucket} />
              </li>
            ))}
          </ul>
        </Card>
        <Card className="p-0">
          <div className="px-4 pb-2 pt-3">
            <div className="text-[17px] font-semibold">{t('pairsTitle')}</div>
            <p className="text-[13px] leading-snug text-[#8E8E93]">{t('pairsHint', { min: data.minCount })}</p>
          </div>
          {data.pairs.length === 0 ? (
            <Muted className="border-t border-[#3C3C4349] px-4 py-3 dark:border-[#54545899]">{t('noPairs')}</Muted>
          ) : (
            <ul className="border-t border-[#3C3C4349] dark:border-[#54545899]">
              {data.pairs.map((p, i) => (
                <li key={`${p.a}-${p.b}`} className="relative px-4 py-2.5">
                  {i > 0 ? <RowDivider /> : null}
                  <div className="text-[15px] font-medium">
                    {p.aName} + {p.bName}
                  </div>
                  <div className="text-[13px] tabular-nums text-[#8E8E93]">
                    {t('pairLine', { conf: Math.round(p.confidence), a: p.aName, b: p.bName, count: p.together, lift: p.lift.toFixed(1) })}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
