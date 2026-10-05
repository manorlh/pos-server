'use client';

/**
 * Tables over the period (שולחנות — ביצועים), from the paid table orders: covers, spend
 * per cover, how long a table sits (a bill left open overnight is not averaged), table
 * turnover, revenue per available seat-hour (RevPASH, against the hours the place was
 * open) and seat occupancy — and by party size. Plus identified repeat customers, when
 * the tills record customers at all.
 */

import { useTranslations } from 'next-intl';
import { agorot, type Customers, type TablesPeriod } from '@/lib/insightsApi';
import { Card, Delta, Muted, RowDivider, Widget, IOS } from './ios';

export function TablesPeriodSection({ data }: { data: TablesPeriod }) {
  const t = useTranslations('insights.tables');
  if (!data.hasTables || !data.current) return null;
  const cur = data.current;
  const prev = data.previous ?? null;
  const delta = (a: number | null, b: number | null | undefined, invert = false) =>
    a !== null && b !== null && b !== undefined ? <Delta a={a} b={b} invert={invert} /> : null;
  if (cur.orders === 0) {
    return (
      <Card>
        <Muted>{t('none')}</Muted>
      </Card>
    );
  }
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Widget title={t('covers')} color={IOS.blue} value={cur.covers.toLocaleString('he-IL')} sub={t('ordersLine', { orders: cur.orders })} delta={delta(cur.covers, prev?.covers)} />
        <Widget title={t('spendPerCover')} color={IOS.green} value={agorot(cur.spendPerCover)} delta={delta(cur.spendPerCover, prev?.spendPerCover)} />
        <Widget title={t('avgPerOrder')} color={IOS.teal} value={agorot(cur.avgPerOrder)} delta={delta(cur.avgPerOrder, prev?.avgPerOrder)} />
        <Widget
          title={t('seated')}
          color={IOS.orange}
          value={cur.avgSeatedMinutes !== null ? t('minutes', { m: cur.avgSeatedMinutes }) : '—'}
          sub={cur.medianSeatedMinutes !== null ? t('median', { m: cur.medianSeatedMinutes }) : undefined}
          delta={delta(cur.avgSeatedMinutes, prev?.avgSeatedMinutes)}
        />
        <Widget title={t('turnover')} color={IOS.purple} value={cur.turnover !== null ? cur.turnover.toFixed(2) : '—'} sub={t('turnoverUnit')} delta={delta(cur.turnover, prev?.turnover)} />
        <Widget
          title={t('revPash')}
          color={IOS.indigo}
          value={agorot(cur.revPash)}
          sub={cur.seatOccupancyPct !== null ? t('occupancy', { pct: cur.seatOccupancyPct.toFixed(1) }) : t('revPashUnit')}
          delta={delta(cur.revPash, prev?.revPash)}
        />
      </div>
      {cur.byParty.length > 0 ? (
        <Card className="p-0">
          <div className="px-4 pb-1 pt-3 text-[17px] font-semibold">{t('byParty')}</div>
          <ul>
            {cur.byParty.map((b, i) => (
              <li key={b.party} className="relative flex items-center justify-between gap-3 px-4 py-2.5">
                {i > 0 ? <RowDivider /> : null}
                <span className="text-[15px]">{t('party', { party: b.party })}</span>
                <span className="text-[13px] tabular-nums text-[#8E8E93]">
                  {t('partyLine', { orders: b.orders, minutes: b.avgMinutes ?? '—', spend: agorot(b.spendPerCover) })}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      {cur.guestsRecordedPct !== null && cur.guestsRecordedPct < 80 ? (
        <Muted className="px-4 text-[13px]">{t('guestsMissing', { pct: Math.round(cur.guestsRecordedPct) })}</Muted>
      ) : null}
    </div>
  );
}

export function CustomersSection({ data }: { data: Customers }) {
  const t = useTranslations('insights.customers');
  const s = data.summary;
  if (!s) return null;
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Widget title={t('customers')} color={IOS.blue} value={s.customers.toLocaleString('he-IL')} sub={t('identified', { pct: s.identifiedPct ?? 0 })} />
      <Widget title={t('repeat')} color={IOS.green} value={`${(s.repeatPct ?? 0).toFixed(0)}%`} sub={t('repeatLine', { count: s.repeatCustomers })} />
      <Widget title={t('repeatNet')} color={IOS.purple} value={agorot(s.repeatNet)} sub={t('repeatNetLine', { pct: (s.repeatNetPct ?? 0).toFixed(0) })} />
      <Widget title={t('visits')} color={IOS.orange} value={s.visitsPerCustomer.toFixed(1)} />
    </div>
  );
}
