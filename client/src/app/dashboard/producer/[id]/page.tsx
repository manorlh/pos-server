'use client';

/**
 * "עמדת מפיק" — one event, for its producer, read-only: the sales (totals, by the hour, the
 * items), the vouchers of their production, and the settlement at production price when the
 * owner opened it. Refreshes every minute while the event runs. pos-server `/producer/events/{id}`.
 */

import { use, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight } from 'lucide-react';
import { hourlyBars, type ProducerSettlement, type ProducerSummary, type ProducerVouchers } from '@/lib/producer';
import { fetchMyEvent, fetchMyEventSettlement, fetchMyEventVouchers } from '@/lib/producerApi';
import { formatCurrency, formatQuantity, formatShortDateTime } from '@/lib/format';
import { Card, Muted, Segmented, SkeletonCard } from '@/components/dashboard/insights/ios';

type Tab = 'sales' | 'vouchers' | 'settlement';

function Tile({ label, value, sub }: { label: string; value: string; sub?: string | null }) {
  return (
    <Card className="min-w-0">
      <p className="text-[13px] text-[#8E8E93]">{label}</p>
      <p className="truncate text-2xl font-bold tabular-nums sm:text-3xl">{value}</p>
      {sub ? <p className="text-[13px] text-[#8E8E93]">{sub}</p> : null}
    </Card>
  );
}

function Sales({ data }: { data: ProducerSummary }) {
  const t = useTranslations('producer');
  const bars = hourlyBars(data.hourly);
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile label={t('net')} value={formatCurrency(data.totals.net)} />
        <Tile label={t('sales')} value={String(data.totals.sales)} sub={data.totals.refunds ? t('refunds', { n: data.totals.refunds }) : null} />
        <Tile label={t('avgTicket')} value={data.totals.avgTicket !== null ? formatCurrency(data.totals.avgTicket) : '—'} />
        <Tile label={t('itemsSold')} value={formatQuantity(data.totals.itemsSold)} />
      </div>
      <Card>
        <h2 className="mb-2 font-semibold">{t('byHour')}</h2>
        {bars.length === 0 ? (
          <Muted>{t('noSales')}</Muted>
        ) : (
          <ul className="space-y-1.5">
            {bars.map((b) => (
              <li key={b.label} className="flex items-center gap-2 text-sm">
                <span className="w-24 shrink-0 tabular-nums text-[#8E8E93]">{b.label}</span>
                <span className="h-5 flex-1 overflow-hidden rounded bg-[#7676801F]">
                  <span className="block h-full rounded bg-[#007AFF]" style={{ width: `${b.pct}%` }} />
                </span>
                <span className="w-24 shrink-0 text-end tabular-nums">{formatCurrency(b.net)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card className="p-0">
        <h2 className="px-4 pt-4 font-semibold">{t('items')}</h2>
        {data.items.length === 0 ? (
          <Muted className="p-4">{t('noSales')}</Muted>
        ) : (
          <table className="mt-2 w-full text-sm">
            <thead className="text-[#8E8E93]">
              <tr>
                <th className="px-4 py-2 text-start font-normal">{t('item')}</th>
                <th className="px-4 py-2 text-end font-normal">{t('quantity')}</th>
                <th className="px-4 py-2 text-end font-normal">{t('revenue')}</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((i) => (
                <tr key={i.key} className="border-t border-black/5 dark:border-white/10">
                  <td className="px-4 py-2">{i.name}</td>
                  <td className="px-4 py-2 text-end tabular-nums">{formatQuantity(i.quantity)}</td>
                  <td className="px-4 py-2 text-end tabular-nums">{formatCurrency(i.revenue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

function Vouchers({ data }: { data: ProducerVouchers }) {
  const t = useTranslations('producer');
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile label={t('vouchersRedeemed')} value={String(data.totals.redeemedVouchers)} sub={t('ofIssued', { n: data.totals.issued })} />
        <Tile label={t('redemptions')} value={String(data.totals.redemptions)} />
        <Tile label={t('units')} value={formatQuantity(data.totals.units)} />
      </div>
      <Card className="p-0">
        {data.batches.length === 0 ? (
          <Muted className="p-4">{t('noVouchers')}</Muted>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-[#8E8E93]">
              <tr>
                <th className="px-4 py-2 text-start font-normal">{t('batch')}</th>
                <th className="px-4 py-2 text-end font-normal">{t('vouchersRedeemed')}</th>
                <th className="px-4 py-2 text-end font-normal">{t('units')}</th>
                <th className="hidden px-4 py-2 text-end font-normal sm:table-cell">{t('lastRedeemed')}</th>
              </tr>
            </thead>
            <tbody>
              {data.batches.map((b) => (
                <tr key={b.batchId} className="border-t border-black/5 dark:border-white/10">
                  <td className="px-4 py-2">{b.name}</td>
                  <td className="px-4 py-2 text-end tabular-nums">{b.redeemedVouchers} / {b.issued}</td>
                  <td className="px-4 py-2 text-end tabular-nums">{formatQuantity(b.units)}</td>
                  <td className="hidden px-4 py-2 text-end sm:table-cell">{b.lastRedeemedAt ? formatShortDateTime(b.lastRedeemedAt) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

function Settlement({ data }: { data: ProducerSettlement }) {
  const t = useTranslations('producer');
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <Tile label={t('totalDue')} value={formatCurrency(data.totalAmount)} sub={data.missingPrices ? t('missingPrices') : null} />
        <Tile label={t('vouchersRedeemed')} value={String(data.redeemedVouchers)} />
      </div>
      <Card className="p-0">
        <table className="w-full text-sm">
          <thead className="text-[#8E8E93]">
            <tr>
              <th className="px-4 py-2 text-start font-normal">{t('batch')}</th>
              <th className="px-4 py-2 text-end font-normal">{t('vouchersRedeemed')}</th>
              <th className="px-4 py-2 text-end font-normal">{t('productionPrice')}</th>
              <th className="px-4 py-2 text-end font-normal">{t('amount')}</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={r.batchId} className="border-t border-black/5 dark:border-white/10">
                <td className="px-4 py-2">{r.name}</td>
                <td className="px-4 py-2 text-end tabular-nums">{r.redeemedVouchers}</td>
                <td className="px-4 py-2 text-end tabular-nums">{r.productionPrice !== null ? formatCurrency(r.productionPrice) : '—'}</td>
                <td className="px-4 py-2 text-end tabular-nums">{r.amount !== null ? formatCurrency(r.amount) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <Muted className="text-xs">{t('settlementBasis')}</Muted>
    </div>
  );
}

export default function ProducerEventPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const t = useTranslations('producer');
  const [tab, setTab] = useState<Tab>('sales');
  const summary = useQuery<ProducerSummary>({
    queryKey: ['producer-event', id],
    queryFn: () => fetchMyEvent(id),
    refetchInterval: (q) => (q.state.data?.event.phase === 'live' ? 60_000 : false),
  });
  const vouchers = useQuery<ProducerVouchers>({ queryKey: ['producer-vouchers', id], queryFn: () => fetchMyEventVouchers(id), enabled: tab === 'vouchers' });
  const settlementOpen = !!summary.data?.event.settlementEnabled;
  const settlement = useQuery<ProducerSettlement>({
    queryKey: ['producer-settlement', id],
    queryFn: () => fetchMyEventSettlement(id),
    enabled: tab === 'settlement' && settlementOpen,
  });

  if (summary.isError) {
    return (
      <Card>
        <p className="font-medium">{t('notFound')}</p>
        <Link href="/dashboard/producer?all=1" className="mt-2 inline-flex min-h-11 items-center text-[#007AFF]">{t('back')}</Link>
      </Card>
    );
  }
  if (!summary.data) return <SkeletonCard className="h-64" />;
  const ev = summary.data.event;
  const tabs: { id: Tab; label: string }[] = [
    { id: 'sales', label: t('tabs.sales') },
    { id: 'vouchers', label: t('tabs.vouchers') },
    ...(settlementOpen ? [{ id: 'settlement' as const, label: t('tabs.settlement') }] : []),
  ];

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <Link href="/dashboard/producer?all=1" className="inline-flex items-center gap-1 text-[15px] text-[#007AFF]">
          <ArrowRight className="size-4" aria-hidden />
          {t('myEvents')}
        </Link>
        <h1 className="text-[28px] font-bold leading-tight tracking-tight">{ev.name}</h1>
        <Muted>{[ev.shopName, `${ev.startDate} ${ev.startTime} – ${ev.endDate} ${ev.endTime}`, t(`phase.${ev.phase}`)].filter(Boolean).join(' · ')}</Muted>
      </div>
      <Segmented value={tab} onChange={setTab} options={tabs} label={t('tabsLabel')} className="max-w-md" />
      {tab === 'sales' ? <Sales data={summary.data} /> : null}
      {tab === 'vouchers' ? (vouchers.data ? <Vouchers data={vouchers.data} /> : <SkeletonCard className="h-40" />) : null}
      {tab === 'settlement' ? (settlement.data ? <Settlement data={settlement.data} /> : <SkeletonCard className="h-40" />) : null}
      <Muted className="text-xs">{t('readOnly', { time: formatShortDateTime(summary.data.now) })}</Muted>
    </div>
  );
}
