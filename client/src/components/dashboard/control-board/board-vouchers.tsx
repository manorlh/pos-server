'use client';

/**
 * "שוברים" (the owner: "הצג בלוח בקרה כמה שוברים נוצלו בסניף — שם שובר"): the prepaid
 * vouchers redeemed in the scope over the board's day, range or event (`GET
 * /reports/prepaid-vouchers`) — how many, and per voucher name its vouchers, units and
 * value, each against the compared period (▲/▼ %). A row opens that batch in the vouchers
 * module. Not drawn at all when nothing was redeemed in either period.
 */

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ChevronLeft, TicketCheck } from 'lucide-react';
import { formatCurrency, formatQuantity } from '@/lib/format';
import type { VoucherBoardReport } from '@/lib/compareApi';
import { Skeleton } from '@/components/ui/skeleton';
import { BoardCard, CardTitle, Delta, DeltaPill } from './board-ui';

/** Whether there is anything to show: a redemption in the period or the compared one. */
export function hasVoucherActivity(report: VoucherBoardReport | undefined): boolean {
  if (!report) return false;
  return report.totals.redemptions > 0 || (report.previous?.redemptions ?? 0) > 0;
}

export function BoardVouchers({
  report,
  loading,
  labelB,
  className,
}: {
  report: VoucherBoardReport | undefined;
  loading: boolean;
  /** "מול ראשון שעבר"; null with no comparison. */
  labelB: string | null;
  className?: string;
}) {
  const t = useTranslations('controlBoard.vouchers');
  if (loading && !report) {
    return (
      <BoardCard className={className}>
        <Skeleton className="h-24 w-full bg-cb-soft" />
      </BoardCard>
    );
  }
  if (!report || !hasVoucherActivity(report)) return null;
  const comparing = !!report.previous && !!labelB;
  const { totals, previous } = report;
  const max = Math.max(1, ...report.rows.map((r) => Math.max(r.current.vouchers, comparing ? (r.previous?.vouchers ?? 0) : 0)));

  return (
    <BoardCard className={className} labelledBy="cb-vouchers-title">
      <CardTitle
        id="cb-vouchers-title"
        icon={TicketCheck}
        trailing={
          <Link
            href="/dashboard/prepaid-vouchers"
            className="inline-flex min-h-9 items-center gap-1 rounded-lg px-2 text-sm font-medium text-cb-blue-ink hover:bg-cb-soft"
          >
            {t('all')}
            <ChevronLeft className="size-4 ltr:rotate-180" aria-hidden />
          </Link>
        }
      >
        {t('title')}
      </CardTitle>

      <div className="mb-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
        <div>
          <p className="text-[26px] font-bold leading-tight tabular-nums text-cb-ink">{formatQuantity(totals.vouchers)}</p>
          <p className="text-xs text-cb-muted">
            {t('redeemed', { count: totals.vouchers })} · {t('redemptions', { count: totals.redemptions })}
          </p>
        </div>
        <div className="flex flex-col items-end gap-0.5 text-xs text-cb-muted">
          {comparing && previous ? (
            <span className="inline-flex items-center gap-1.5" title={labelB ?? undefined}>
              <Delta a={totals.vouchers} b={previous.vouchers} />
              <span className="tabular-nums">{t('versus', { count: formatQuantity(previous.vouchers) })}</span>
            </span>
          ) : null}
          {totals.value > 0 ? (
            <span className="tabular-nums">
              {t('value')} {formatCurrency(totals.value)}
            </span>
          ) : null}
        </div>
      </div>

      <ul className="divide-y divide-cb-line">
        {report.rows.map((row) => (
          <li key={row.batchId}>
            <Link
              href={`/dashboard/prepaid-vouchers?batch=${encodeURIComponent(row.batchId)}`}
              aria-label={t('open', { name: row.name })}
              className="-mx-2 flex min-h-14 items-center gap-3 rounded-lg px-2 py-2 hover:bg-cb-soft/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cb-blue/40"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-cb-ink">{row.name}</p>
                <p className="truncate text-xs tabular-nums text-cb-muted">
                  {t(`kinds.${row.kind === 'order_discount' || row.kind === 'item_discount' ? row.kind : 'items'}`)}
                  {' · '}
                  {t('rowUnits', { units: formatQuantity(row.current.units), kind: row.kind === 'items' ? 'items' : 'uses' })}
                  {row.current.value > 0 ? ` · ${formatCurrency(row.current.value)}` : ''}
                </p>
                <div className="mt-1.5 h-1.5 rounded-full bg-cb-soft" aria-hidden>
                  <div className="h-1.5 rounded-full bg-cb-purple" style={{ width: `${(row.current.vouchers / max) * 100}%` }} />
                </div>
              </div>
              <div className="shrink-0 text-end">
                <p className="text-sm font-semibold tabular-nums text-cb-ink">{formatQuantity(row.current.vouchers)}</p>
                {comparing && row.previous ? (
                  <p className="text-xs tabular-nums text-cb-muted">{formatQuantity(row.previous.vouchers)}</p>
                ) : null}
              </div>
              {comparing && row.previous ? <DeltaPill a={row.current.vouchers} b={row.previous.vouchers} /> : null}
              <ChevronLeft className="size-4 shrink-0 text-cb-muted ltr:rotate-180" aria-hidden />
            </Link>
          </li>
        ))}
      </ul>
    </BoardCard>
  );
}
