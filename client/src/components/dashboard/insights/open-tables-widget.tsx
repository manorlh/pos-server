'use client';

/**
 * "Open tables now" (שולחנות פתוחים עכשיו) for the control board and the insights page:
 * how many tables are open in the scope, their guests and open amount, the one seated
 * longest, occupancy, and the tables open longest — refreshed every 30 seconds while the
 * page's auto refresh is on. Hidden when the scope has no tables at all.
 *
 * `GET /insights/tables-live` (money in agorot): a synced order wins over a single
 * till's report of the same table, as on the tables page's live view.
 */

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChefHat, Clock, Receipt, UtensilsCrossed } from 'lucide-react';
import { agorot, fetchTablesLive, type OpenTableRow, type OpenTableState } from '@/lib/insightsApi';
import type { OrgScope } from '@/components/dashboard/org-scope-cascade';
import { cn } from '@/lib/utils';
import { Capsule, Card, ChartTokens, Chip, Figure, IOS, RowDivider, SectionHeader, hoursMinutes } from './ios';
import { scopeParams } from './scope-params';

const LIVE_REFRESH_MS = 30_000;

const STATE_STYLE: Record<OpenTableState, { color: string; icon: React.ReactNode }> = {
  occupied: { color: IOS.blue, icon: <UtensilsCrossed className="h-3 w-3" /> },
  sent: { color: IOS.orange, icon: <ChefHat className="h-3 w-3" /> },
  awaiting_payment: { color: IOS.green, icon: <Receipt className="h-3 w-3" /> },
};

export function useDuration() {
  const t = useTranslations('insights.tablesWidget');
  return (minutes: number | null | undefined) => {
    if (minutes === null || minutes === undefined) return '—';
    return minutes < 60 ? t('durationMinutes', { m: Math.round(minutes) }) : t('durationHours', { hm: hoursMinutes(minutes) });
  };
}

function TableRow({ row, showShop }: { row: OpenTableRow; showShop: boolean }) {
  const t = useTranslations('insights.tablesWidget');
  const duration = useDuration();
  const style = STATE_STYLE[row.state] ?? STATE_STYLE.occupied;
  const stateLabel =
    row.state === 'sent' ? t('state.sent') : row.state === 'awaiting_payment' ? t('state.awaiting_payment') : t('state.occupied');
  const where = [row.zoneName, showShop ? row.shopName : null].filter(Boolean).join(' · ');
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-3">
        <span
          className="flex h-9 min-w-9 shrink-0 items-center justify-center rounded-xl px-1.5 text-[15px] font-semibold text-white"
          style={{ backgroundColor: style.color }}
        >
          {row.number ?? '—'}
        </span>
        <div className="min-w-0">
          <div className="truncate text-[15px] font-medium">
            {row.name ? `${t('tableN', { number: row.number ?? '' })} · ${row.name}` : t('tableN', { number: row.number ?? '' })}
          </div>
          <div className="flex flex-wrap items-center gap-1.5 text-[13px] text-[#8E8E93]">
            <Chip color={style.color} icon={style.icon}>{stateLabel}</Chip>
            {where ? <span className="truncate">{where}</span> : null}
            {row.guests ? <span>{t('guestsN', { count: row.guests })}</span> : null}
          </div>
        </div>
      </div>
      <div className="shrink-0 text-end">
        <div className="text-[15px] font-semibold tabular-nums">{agorot(row.total)}</div>
        <div className={cn('flex items-center justify-end gap-1 text-[13px] tabular-nums', row.long ? 'font-semibold' : 'text-[#8E8E93]')}>
          {row.long ? <Clock className="h-3.5 w-3.5" style={{ color: IOS.orange }} aria-label={t('long')} /> : null}
          {duration(row.minutesOpen)}
        </div>
      </div>
    </div>
  );
}

export function OpenTablesWidget({
  scope,
  auto = true,
  listLimit = 5,
  header = true,
}: {
  scope: OrgScope;
  auto?: boolean;
  listLimit?: number;
  header?: boolean;
}) {
  const t = useTranslations('insights.tablesWidget');
  const duration = useDuration();
  const params = scopeParams(scope);
  const { data, isLoading } = useQuery({
    queryKey: ['insights-tables-live', params],
    queryFn: () => fetchTablesLive(params),
    refetchInterval: auto ? LIVE_REFRESH_MS : false,
    placeholderData: keepPreviousData,
  });

  // Nothing until we know the scope has tables: a skeleton that then vanishes would make
  // the board jump for every shop that does not seat anyone.
  if (isLoading || !data || !data.hasTables) return null;

  const longest = data.longest;
  const shops = data.byShop.length > 1;
  const rows = data.tables.slice(0, listLimit);

  return (
    <ChartTokens>
      {header ? (
        <SectionHeader
          trailing={
            <span className="flex items-center gap-1.5 text-[13px] text-[#8E8E93]">
              <span className="relative flex h-2 w-2" aria-hidden>
                {auto ? <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#34C759] opacity-60" /> : null}
                <span className="relative inline-flex h-2 w-2 rounded-full bg-[#34C759]" />
              </span>
              {auto ? t('live') : t('paused')}
            </span>
          }
        >
          {t('title')}
        </SectionHeader>
      ) : null}
      <Card className="p-0">
        <div className="grid grid-cols-2 gap-y-3 py-3 sm:grid-cols-4 sm:divide-x sm:divide-x-reverse sm:divide-[#3C3C4349] dark:sm:divide-[#54545899]">
          <Figure
            value={<span>{data.openTables.toLocaleString('he-IL')}</span>}
            label={t('open')}
            sub={<span className="text-[#8E8E93]">{t('ofTotal', { total: data.tablesTotal })}</span>}
          />
          <Figure
            value={<span>{data.guests.toLocaleString('he-IL')}</span>}
            label={t('guests')}
            sub={data.awaitingPayment ? <span style={{ color: IOS.green }}>{t('awaiting', { count: data.awaitingPayment })}</span> : null}
          />
          <Figure value={<span>{agorot(data.openAmount)}</span>} label={t('openAmount')} />
          <Figure
            value={<span>{longest ? duration(longest.minutesOpen) : '—'}</span>}
            label={t('longest')}
            sub={longest ? <span className="text-[#8E8E93]">{t('tableN', { number: longest.number ?? '' })}</span> : null}
          />
        </div>
        <div className="border-t border-[#3C3C4349] px-4 py-3 dark:border-[#54545899]">
          <div className="mb-1.5 flex items-center justify-between gap-2 text-[13px]">
            <span className="text-[#8E8E93]">
              {t('occupancy', { pct: Math.round(data.occupancyPct ?? 0), guests: data.guests, seats: data.seatsTotal })}
            </span>
            {data.longOpen ? (
              <span className="flex items-center gap-1 font-semibold">
                <Clock className="h-3.5 w-3.5" style={{ color: IOS.orange }} aria-hidden />
                {t('longCount', { count: data.longOpen, minutes: data.longAfterMinutes })}
              </span>
            ) : null}
          </div>
          <Capsule value={data.openTables} max={data.tablesTotal} />
        </div>
        {data.openTables === 0 ? (
          <p className="border-t border-[#3C3C4349] px-4 py-3 text-[15px] text-[#8E8E93] dark:border-[#54545899]">{t('none')}</p>
        ) : (
          <ul className="border-t border-[#3C3C4349] dark:border-[#54545899]">
            {rows.map((row, i) => (
              <li key={row.tableId} className="relative px-4 py-2.5">
                {i > 0 ? <RowDivider /> : null}
                <TableRow row={row} showShop={shops} />
              </li>
            ))}
          </ul>
        )}
        {shops ? (
          <div className="border-t border-[#3C3C4349] px-4 py-3 dark:border-[#54545899]">
            <div className="mb-1 text-[13px] text-[#8E8E93]">{t('byShop')}</div>
            <ul className="space-y-1">
              {data.byShop.map((s) => (
                <li key={s.shopId ?? 'none'} className="flex items-center justify-between gap-2 text-[15px]">
                  <span className="truncate">{s.shopName ?? '—'}</span>
                  <span className="shrink-0 tabular-nums text-[#8E8E93]">
                    {t('shopLine', { tables: s.openTables, guests: s.guests, amount: agorot(s.openAmount) })}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <div className="border-t border-[#3C3C4349] px-4 py-2.5 text-end dark:border-[#54545899]">
          <Link href="/dashboard/tables" className="text-[15px] text-[#007AFF] dark:text-[#0A84FF]">
            {t('toTables')}
          </Link>
        </div>
      </Card>
    </ChartTokens>
  );
}
