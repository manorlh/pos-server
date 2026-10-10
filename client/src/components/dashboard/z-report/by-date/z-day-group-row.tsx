'use client';

/**
 * The head of a day in the Z list: "הופקו ב־יום רביעי, 1 באוקטובר 2026 · 4 דוחות Z · ₪12,340"
 * (or the business day's, on that basis). The day's count and totals come from the summary —
 * a page may hold only part of a day — and are left out when the summary does not cover it.
 */
import { useTranslations } from 'next-intl';
import { TableCell, TableRow } from '@/components/ui/table';
import { formatCurrency, formatLongDate } from '@/lib/format';
import type { ZByDateTotals, ZDateBasis } from '@/lib/zByDate';

export function ZDayGroupRow({
  day,
  basis,
  colSpan,
  totals,
}: {
  day: string;
  basis: ZDateBasis;
  colSpan: number;
  totals?: ZByDateTotals | null;
}) {
  const t = useTranslations('zByDate');
  const label = day ? formatLongDate(day) : '—';
  return (
    <TableRow className="bg-muted/40 hover:bg-muted/40">
      <TableCell colSpan={colSpan} className="py-1.5 text-xs font-medium">
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
      </TableCell>
    </TableRow>
  );
}

/** The same, as a heading in the phone list. */
export function ZDayGroupHeading({ day, basis, totals }: { day: string; basis: ZDateBasis; totals?: ZByDateTotals | null }) {
  const t = useTranslations('zByDate');
  const label = day ? formatLongDate(day) : '—';
  return (
    <li className="bg-muted/40 px-3 py-1.5 text-xs font-medium">
      {basis === 'production' ? t('groupProduced', { date: label }) : t('groupBusiness', { date: label })}
      {totals ? (
        <span className="text-muted-foreground font-normal tabular-nums">
          {' · '}
          {t('count', { count: totals.count })} · {formatCurrency(totals.totalSales)}
        </span>
      ) : null}
    </li>
  );
}
