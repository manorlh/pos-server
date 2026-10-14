'use client';

/**
 * "עמדת מפיק" — one event, for its producer, read-only: the sales (totals, by the hour, the
 * items), the vouchers of their production, and the settlement at production price when the
 * owner opened it. Refreshes every minute while the event runs. pos-server `/producer/events/{id}`.
 *
 * "ייצוא" beside the tabs (P:\specs\reports-designed-pdf.md §2): the designed PDF, Excel and CSV
 * of the tab shown — the sales (items, by the hour), the vouchers or the settlement; while the
 * event runs, a snapshot of that moment.
 */

import { use, useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight } from 'lucide-react';
import {
  chargedLabelKey,
  hourlyBars,
  type ProducerSettlement,
  type ProducerSettlementRow,
  type ProducerSummary,
  type ProducerVoucherBatch,
  type ProducerVouchers,
} from '@/lib/producer';
import { fetchMyEvent, fetchMyEventSettlement, fetchMyEventVouchers } from '@/lib/producerApi';
import type { ReportChart, ReportKpi } from '@/lib/designedReport';
import { formatCurrency, formatQuantity, formatShortDateTime } from '@/lib/format';
import type { ReportFilterLine } from '@/lib/reportExport';
import { Card, Muted, Segmented, SkeletonCard } from '@/components/dashboard/insights/ios';
import { ReportExportBar, type ReportTableSpec } from '@/components/dashboard/report-framework';

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
  const charged = t(chargedLabelKey(data.basis));
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <Tile label={t('totalDue')} value={formatCurrency(data.totalAmount)} sub={data.missingPrices ? t('missingPrices') : null} />
        <Tile label={charged} value={String(data.chargeableVouchers)} />
      </div>
      <Card className="p-0">
        <table className="w-full text-sm">
          <thead className="text-[#8E8E93]">
            <tr>
              <th className="px-4 py-2 text-start font-normal">{t('batch')}</th>
              <th className="px-4 py-2 text-end font-normal">{charged}</th>
              <th className="px-4 py-2 text-end font-normal">{t('productionPrice')}</th>
              <th className="px-4 py-2 text-end font-normal">{t('amount')}</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={r.batchId} className="border-t border-black/5 dark:border-white/10">
                <td className="px-4 py-2">
                  {r.name}
                  {data.basis === 'mixed' || r.origin === 'agreement' ? (
                    <span className="block text-xs text-[#8E8E93]">
                      {[t(`basis.${r.basis}`), r.agreementName].filter(Boolean).join(' · ')}
                    </span>
                  ) : null}
                </td>
                <td className="px-4 py-2 text-end tabular-nums">{r.chargeable}</td>
                <td className="px-4 py-2 text-end tabular-nums">{r.productionPrice !== null ? formatCurrency(r.productionPrice) : '—'}</td>
                <td className="px-4 py-2 text-end tabular-nums">{r.amount !== null ? formatCurrency(r.amount) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <Muted className="text-xs">{data.basisText ?? t('settlementMixed')}</Muted>
    </div>
  );
}

type SummaryItem = ProducerSummary['items'][number];
type HourBar = ReturnType<typeof hourlyBars>[number];

/**
 * The tab's export. The producer sees one event of someone else's business: the bar is the
 * framework's own (not the scope's — a producer has none), with the event's shop as the business
 * line and no company (its export defaults are the user's own).
 */
function ProducerExport({
  tab,
  summary,
  vouchers,
  settlement,
}: {
  tab: Tab;
  summary: ProducerSummary;
  vouchers: ProducerVouchers | undefined;
  settlement: ProducerSettlement | undefined;
}) {
  const t = useTranslations('producer');
  const tc = useTranslations('common');
  const ev = summary.event;

  const tables = useMemo(() => {
    if (tab === 'vouchers') {
      const batches: ReportTableSpec<ProducerVoucherBatch> = {
        id: 'vouchers',
        title: t('tabs.vouchers'),
        rows: vouchers?.batches ?? [],
        rowKey: (b) => b.batchId,
        totalsLabel: tc('total'),
        columns: [
          { key: 'batch', header: t('batch'), width: 24, required: true, value: (b) => b.name },
          { key: 'issued', header: t('export.issued'), kind: 'number', value: (b) => b.issued, totalOf: (rows) => rows.reduce((n, b) => n + b.issued, 0) },
          {
            key: 'redeemedVouchers',
            header: t('vouchersRedeemed'),
            kind: 'number',
            value: (b) => b.redeemedVouchers,
            totalOf: (rows) => rows.reduce((n, b) => n + b.redeemedVouchers, 0),
          },
          { key: 'redemptions', header: t('redemptions'), kind: 'number', value: (b) => b.redemptions, totalOf: (rows) => rows.reduce((n, b) => n + b.redemptions, 0) },
          { key: 'units', header: t('units'), kind: 'number', value: (b) => b.units, totalOf: (rows) => rows.reduce((n, b) => n + b.units, 0) },
          { key: 'lastRedeemedAt', header: t('lastRedeemed'), kind: 'datetime', value: (b) => b.lastRedeemedAt },
        ],
      };
      return [batches as ReportTableSpec<unknown>];
    }
    if (tab === 'settlement') {
      const charged = settlement ? t(chargedLabelKey(settlement.basis)) : t('charged');
      const rows: ReportTableSpec<ProducerSettlementRow> = {
        id: 'settlement',
        title: t('tabs.settlement'),
        rows: settlement?.rows ?? [],
        rowKey: (r) => r.batchId,
        totalsLabel: tc('total'),
        columns: [
          { key: 'batch', header: t('batch'), width: 24, required: true, value: (r) => r.name },
          { key: 'basis', header: t('export.basisCol'), width: 12, value: (r) => t(`basis.${r.basis}`) },
          { key: 'agreement', header: t('export.agreement'), width: 18, value: (r) => r.agreementName },
          { key: 'chargeable', header: charged, kind: 'number', value: (r) => r.chargeable, totalOf: (all) => all.reduce((n, r) => n + r.chargeable, 0) },
          { key: 'productionPrice', header: t('productionPrice'), kind: 'money', value: (r) => r.productionPrice },
          // The server's total, prices that are missing left out as it leaves them.
          { key: 'amount', header: t('amount'), kind: 'money', value: (r) => r.amount, total: settlement?.totalAmount },
        ],
      };
      return [rows as ReportTableSpec<unknown>];
    }
    const items: ReportTableSpec<SummaryItem> = {
      id: 'main',
      title: t('items'),
      rows: summary.items,
      rowKey: (i) => i.key,
      totalsLabel: tc('total'),
      columns: [
        { key: 'item', header: t('item'), width: 26, required: true, value: (i) => i.name },
        { key: 'quantity', header: t('quantity'), kind: 'number', value: (i) => i.quantity, totalOf: (rows) => rows.reduce((n, i) => n + i.quantity, 0) },
        { key: 'revenue', header: t('revenue'), kind: 'money', value: (i) => i.revenue, totalOf: (rows) => rows.reduce((n, i) => n + i.revenue, 0) },
      ],
    };
    const hours: ReportTableSpec<HourBar> = {
      id: 'hours',
      title: t('byHour'),
      rows: hourlyBars(summary.hourly),
      rowKey: (h) => h.label,
      totalsLabel: tc('total'),
      columns: [
        { key: 'hour', header: t('export.hour'), width: 14, required: true, value: (h) => h.label },
        { key: 'net', header: t('net'), kind: 'money', value: (h) => h.net, totalOf: (rows) => rows.reduce((n, h) => n + h.net, 0) },
        { key: 'docs', header: t('export.docs'), kind: 'number', value: (h) => h.docs, totalOf: (rows) => rows.reduce((n, h) => n + h.docs, 0) },
      ],
    };
    return [items as ReportTableSpec<unknown>, ...(hours.rows.length ? [hours as ReportTableSpec<unknown>] : [])];
  }, [settlement, summary, t, tab, tc, vouchers]);

  let kpis: ReportKpi[] = [];
  let chart: ReportChart | null = null;
  let filterLines: ReportFilterLine[] = [];
  if (tab === 'sales') {
    const s = summary.totals;
    kpis = [
      { key: 'net', label: t('net'), value: s.net, kind: 'money', icon: 'sales' },
      { key: 'transactions', label: t('sales'), value: s.sales, kind: 'count', icon: 'receipt' },
      { key: 'avgTicket', label: t('avgTicket'), value: s.avgTicket, kind: 'money', icon: 'basket' },
      { key: 'items', label: t('itemsSold'), value: s.itemsSold, kind: 'number', icon: 'items' },
      { key: 'refunds', label: t('export.refundsCount'), value: s.refunds, kind: 'count', icon: 'refund', better: 'down' },
    ];
    const bars = hourlyBars(summary.hourly);
    chart = bars.length
      ? { type: 'bar', title: t('byHour'), labels: bars.map((b) => b.label), series: [{ name: t('net'), values: bars.map((b) => b.net) }], kind: 'money' }
      : null;
  } else if (tab === 'vouchers' && vouchers) {
    const v = vouchers.totals;
    kpis = [
      { key: 'redeemedVouchers', label: t('vouchersRedeemed'), value: v.redeemedVouchers, kind: 'count', icon: 'voucher' },
      { key: 'issued', label: t('export.issued'), value: v.issued, kind: 'count' },
      { key: 'redemptions', label: t('redemptions'), value: v.redemptions, kind: 'count' },
      { key: 'units', label: t('units'), value: v.units, kind: 'number', icon: 'items' },
    ];
    chart = vouchers.batches.length
      ? {
          type: 'hbar',
          title: t('export.redemptionsByBatch'),
          labels: vouchers.batches.map((b) => b.name),
          series: [{ name: t('redemptions'), values: vouchers.batches.map((b) => b.redemptions) }],
          kind: 'number',
        }
      : null;
  } else if (tab === 'settlement' && settlement) {
    kpis = [
      { key: 'totalDue', label: t('totalDue'), value: settlement.totalAmount, kind: 'money', icon: 'sales' },
      { key: 'chargeable', label: t(chargedLabelKey(settlement.basis)), value: settlement.chargeableVouchers, kind: 'count', icon: 'voucher' },
      { key: 'redeemedVouchers', label: t('vouchersRedeemed'), value: settlement.redeemedVouchers, kind: 'count' },
    ];
    const priced = settlement.rows.filter((r) => r.amount !== null);
    chart = priced.length
      ? {
          type: 'hbar',
          title: t('export.amountByBatch'),
          labels: priced.map((r) => r.name),
          series: [{ name: t('amount'), values: priced.map((r) => r.amount) }],
          kind: 'money',
        }
      : null;
    filterLines = [
      { label: t('export.basisCol'), value: settlement.basisText ?? t('settlementMixed') },
      ...(settlement.missingPrices ? [{ label: t('productionPrice'), value: t('missingPrices') }] : []),
    ];
  }
  const ready = tab === 'sales' || (tab === 'vouchers' ? !!vouchers : !!settlement);

  return (
    <ReportExportBar
      reportKey="producer-event"
      reportType="events.producer"
      title={`${ev.name} — ${t(`tabs.${tab}`)}`}
      tables={tables}
      from={ev.startDate}
      to={ev.endDate}
      business={ev.shopName ?? t('title')}
      place={null}
      filterLines={filterLines}
      companyId={null}
      kpis={kpis}
      chart={chart}
      disabled={!ready}
    />
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
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Segmented value={tab} onChange={setTab} options={tabs} label={t('tabsLabel')} className="max-w-md flex-1" />
        <ProducerExport tab={tab} summary={summary.data} vouchers={vouchers.data} settlement={settlement.data} />
      </div>
      {tab === 'sales' ? <Sales data={summary.data} /> : null}
      {tab === 'vouchers' ? (vouchers.data ? <Vouchers data={vouchers.data} /> : <SkeletonCard className="h-40" />) : null}
      {tab === 'settlement' ? (settlement.data ? <Settlement data={settlement.data} /> : <SkeletonCard className="h-40" />) : null}
      <Muted className="text-xs">{t('readOnly', { time: formatShortDateTime(summary.data.now) })}</Muted>
    </div>
  );
}
