'use client';

/**
 * The head of a day in the Z list: "הופקו ב־יום רביעי, 1 באוקטובר 2026 · 4 דוחות Z · ₪12,340"
 * (or the business day's, on that basis). The day's count and totals come from the summary —
 * a page may hold only part of a day — and are left out when the summary does not cover it.
 *
 * The list's `ReportTable` puts it in a heading row before each day's Zs (`groupHeading`),
 * on a phone above that day's cards.
 */
import { useTranslations } from 'next-intl';
import { formatCurrency, formatLongDate } from '@/lib/format';
import type { ZByDateTotals, ZDateBasis } from '@/lib/zByDate';

export function ZDayGroupLabel({
  day,
  basis,
  totals,
}: {
  day: string;
  basis: ZDateBasis;
  totals?: ZByDateTotals | null;
}) {
  const t = useTranslations('zByDate');
  const label = day ? formatLongDate(day) : '—';
  return (
    <>
      {basis === 'production' ? t('groupProduced', { date: label }) : t('groupBusiness', { date: label })}
      {totals ? (
        <span className="text-muted-foreground font-normal tabular-nums">
          {' · '}
          {t('count', { count: totals.count })}
          {' · '}
          {t('totals.totalSales')} {formatCurrency(totals.totalSales)}
          {' · '}
          {t('totals.vatTotal')} {formatCurrency(totals.vatTotal)}
        </span>
      ) : null}
    </>
  );
}
