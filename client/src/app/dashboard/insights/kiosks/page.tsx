'use client';

/**
 * "ביצועי קיוסקים" — the self-order kiosks' report (pos-server `GET /insights/kiosks`,
 * app/services/kiosk_insights.py), in the insights' iOS language: the same period (7 / 28 /
 * 90 complete business days or custom, against the period before) and scope, narrowed to one
 * kiosk if wanted.
 *
 * The headline figures with their change, then the funnel (where each order got to), where
 * customers leave and why, the time to order, orders by hour, the daily trend, the top items,
 * upsell, payment failures, and every kiosk side by side — the table the CSV export takes,
 * with the funnel and the abandonment by step. Refreshed every five minutes while auto refresh
 * is on.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { he } from 'date-fns/locale';
import { ChevronRight, Download, RefreshCw, TabletSmartphone } from 'lucide-react';
import { agorot } from '@/lib/insightsApi';
import { downloadCsv } from '@/lib/csv';
import { cn } from '@/lib/utils';
import {
  buildKioskCsv,
  durationText,
  kioskCsvFilename,
  pctText,
  type KioskHeadline,
  type KioskInsightsParams,
  type KioskRef,
} from '@/lib/kioskInsights';
import { fetchKioskInsights } from '@/lib/kioskInsightsApi';
import { ALL_COMPANIES, EMPTY_ORG_SCOPE, type OrgScope } from '@/components/dashboard/org-scope-cascade';
import { ScopePicker } from '@/components/dashboard/live/scope-picker';
import { Card, Delta, IOS, InsightsSurface, Muted, SectionHeader, Segmented, SkeletonCard, Switch, Widget, dayMonth } from '@/components/dashboard/insights/ios';
import { scopeParams } from '@/components/dashboard/insights/scope-params';
import { AbandonmentChart, ByHourChart, DailyChart, FunnelChart, OrderTimeChart } from '@/components/dashboard/kiosk-insights/charts';
import { PaymentsBlock, PerKioskTable, TopItemsList, UpsellBlock } from '@/components/dashboard/kiosk-insights/tables';
import { useKioskLabels } from '@/components/dashboard/kiosk-insights/labels';

const AUTO_REFRESH_MS = 5 * 60_000;

type Range = '7' | '28' | '90' | 'custom';

function isoDaysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function kioskLabel(k: KioskRef): string {
  return [k.name || k.machineName, k.shopName].filter(Boolean).join(' · ');
}

export default function KioskInsightsPage() {
  const t = useTranslations('kioskInsights');
  const ti = useTranslations('insights');
  const L = useKioskLabels();

  const [scope, setScope] = useState<OrgScope>({ ...EMPTY_ORG_SCOPE, companyId: ALL_COMPANIES });
  const [range, setRange] = useState<Range>('28');
  const [customFrom, setCustomFrom] = useState(() => isoDaysAgo(28));
  const [customTo, setCustomTo] = useState(() => isoDaysAgo(1));
  const [auto, setAuto] = useState(true);
  const [kioskId, setKioskId] = useState('');

  const base: KioskInsightsParams =
    range === 'custom' ? { ...scopeParams(scope), from: customFrom, to: customTo } : { ...scopeParams(scope), days: Number(range) };
  const params: KioskInsightsParams = kioskId ? { ...base, kioskId } : base;

  const report = useQuery({
    queryKey: ['insights-kiosks', params],
    queryFn: () => fetchKioskInsights(params),
    refetchInterval: auto ? AUTO_REFRESH_MS : false,
    placeholderData: keepPreviousData,
    retry: 1,
  });
  // With one kiosk chosen the report lists only it: the picker keeps the scope's whole list
  // from the same report without `kioskId` (already cached from before the kiosk was picked).
  const all = useQuery({
    queryKey: ['insights-kiosks', base],
    queryFn: () => fetchKioskInsights(base),
    enabled: !!kioskId,
    staleTime: 10 * 60_000,
    placeholderData: keepPreviousData,
    retry: 1,
  });
  const data = report.data;
  const kiosks: KioskRef[] = (kioskId ? all.data?.kiosks : data?.kiosks) ?? data?.kiosks ?? [];

  // Re-render now and then so "updated N minutes ago" stays true.
  const [, tick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => tick((n) => n + 1), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const changeScope = (next: OrgScope) => {
    setScope(next);
    setKioskId('');
  };

  const exportCsv = () => {
    if (!data) return;
    downloadCsv(kioskCsvFilename(data.period), buildKioskCsv(data, L.csv));
  };

  const period = data?.period;
  const cur = data?.headline.current ?? null;
  const prev = data?.headline.previous ?? null;
  const vs = (pick: (h: KioskHeadline) => number | null, format: (n: number) => string, invert = false) => {
    if (!cur) return {};
    const a = pick(cur);
    const b = prev ? pick(prev) : null;
    if (a === null || b === null) return {};
    return { sub: ti('vsPrev', { value: format(b) }), delta: <Delta a={a} b={b} invert={invert} /> };
  };
  /** The change against the previous period, or — without one — a plain line under the figure. */
  const vsOr = (pick: (h: KioskHeadline) => number | null, format: (n: number) => string, invert: boolean, fallback?: string) => {
    const r = vs(pick, format, invert);
    return 'delta' in r && r.delta ? r : { sub: fallback };
  };
  const count = (n: number) => n.toLocaleString('he-IL');
  const pct = (n: number) => pctText(n);

  return (
    <InsightsSurface>
      <Link href="/dashboard/insights" className="mb-1 inline-flex items-center gap-0.5 px-1 text-[15px] text-[#007AFF] dark:text-[#0A84FF]">
        <ChevronRight className="h-4 w-4" aria-hidden />
        {t('backToInsights')}
      </Link>

      {/* Large title */}
      <div className="flex items-end justify-between gap-3 px-1">
        <div className="min-w-0">
          <p className="truncate text-[13px] font-semibold uppercase tracking-wide text-[#8E8E93]">
            {period
              ? ti('periodLine', { from: dayMonth(period.from), to: dayMonth(period.to), prevFrom: dayMonth(period.prevFrom), prevTo: dayMonth(period.prevTo) })
              : ti('loading')}
          </p>
          <h1 className="text-[34px] font-bold leading-tight tracking-tight">{t('title')}</h1>
        </div>
        <div className="mb-1 flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={exportCsv}
            disabled={!data?.hasKiosks}
            title={t('exportHint')}
            className="flex h-10 items-center gap-1.5 rounded-full bg-white px-4 text-[15px] text-[#007AFF] shadow-sm active:opacity-60 disabled:opacity-40 dark:bg-[#1C1C1E] dark:text-[#0A84FF]"
          >
            <Download className="h-[18px] w-[18px]" aria-hidden />
            <span className="hidden sm:inline">{t('export')}</span>
            <span className="sr-only sm:hidden">{t('export')}</span>
          </button>
          <button
            type="button"
            onClick={() => {
              void report.refetch();
              if (kioskId) void all.refetch();
            }}
            aria-label={ti('refresh')}
            className="flex h-10 w-10 items-center justify-center rounded-full bg-white text-[#007AFF] shadow-sm active:opacity-60 dark:bg-[#1C1C1E]"
          >
            <RefreshCw className={cn('h-[18px] w-[18px]', report.isFetching && 'animate-spin')} />
          </button>
        </div>
      </div>

      {/* Period */}
      <div className="mt-4 overflow-x-auto px-1 pb-1">
        <Segmented
          value={range}
          onChange={setRange}
          label={ti('range.label')}
          className="min-w-[320px]"
          options={[
            { id: '7', label: ti('range.d7') },
            { id: '28', label: ti('range.d28') },
            { id: '90', label: ti('range.d90') },
            { id: 'custom', label: ti('range.custom') },
          ]}
        />
      </div>
      {range === 'custom' ? (
        <Card className="mt-3 divide-y divide-[#3C3C4349] p-0 dark:divide-[#54545899]">
          <label className="flex items-center justify-between gap-3 px-4 py-2.5">
            <span className="text-[17px]">{ti('range.from')}</span>
            <input
              type="date"
              value={customFrom}
              max={customTo}
              onChange={(e) => setCustomFrom(e.target.value)}
              dir="ltr"
              className="rounded-lg bg-[#7676801F] px-2 py-1 text-[15px] text-[#007AFF] outline-none"
            />
          </label>
          <label className="flex items-center justify-between gap-3 px-4 py-2.5">
            <span className="text-[17px]">{ti('range.to')}</span>
            <input
              type="date"
              value={customTo}
              min={customFrom}
              max={isoDaysAgo(0)}
              onChange={(e) => setCustomTo(e.target.value)}
              dir="ltr"
              className="rounded-lg bg-[#7676801F] px-2 py-1 text-[15px] text-[#007AFF] outline-none"
            />
          </label>
        </Card>
      ) : null}

      {/* Scope, kiosk, refresh */}
      <SectionHeader>{ti('scope')}</SectionHeader>
      <Card className="space-y-3">
        <ScopePicker value={scope} onChange={changeScope} allowAll />
        <label className="flex items-center justify-between gap-3 border-t border-[#3C3C4349] pt-3 dark:border-[#54545899]">
          <span className="text-[17px]">{t('kiosk')}</span>
          <select
            value={kioskId}
            onChange={(e) => setKioskId(e.target.value)}
            disabled={kiosks.length === 0}
            className="min-w-0 max-w-[60%] truncate rounded-lg bg-[#7676801F] px-2 py-1.5 text-[15px] text-[#007AFF] outline-none disabled:opacity-50 dark:text-[#0A84FF]"
          >
            <option value="">{t('allKiosks')}</option>
            {kiosks.map((k) => (
              <option key={k.machineId} value={k.machineId}>
                {k.isKiosk ? kioskLabel(k) : t('notKiosk', { name: kioskLabel(k) })}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-center justify-between gap-3 border-t border-[#3C3C4349] pt-3 dark:border-[#54545899]">
          <div>
            <div className="text-[17px]">{ti('autoRefresh')}</div>
            <div className="text-[13px] text-[#8E8E93]">
              {report.dataUpdatedAt > 0
                ? ti('updatedAgo', { ago: formatDistanceToNow(report.dataUpdatedAt, { addSuffix: true, locale: he }) })
                : ti('autoRefreshHint')}
            </div>
          </div>
          <Switch checked={auto} onChange={setAuto} label={ti('autoRefresh')} />
        </div>
      </Card>

      {!data ? (
        report.isError ? (
          <Card className="mt-5 flex items-center justify-between gap-3">
            <Muted>{ti('loadError')}</Muted>
            <button type="button" onClick={() => void report.refetch()} className="text-[15px] text-[#007AFF] dark:text-[#0A84FF]">
              {ti('retry')}
            </button>
          </Card>
        ) : (
          <>
            <SectionHeader>{t('kpi.title')}</SectionHeader>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
              {Array.from({ length: 9 }).map((_, i) => (
                <SkeletonCard key={i} className="h-[104px]" />
              ))}
            </div>
            <SkeletonCard className="mt-5 h-80" />
          </>
        )
      ) : !data.hasKiosks ? (
        <Card className="mt-5 flex flex-col items-center gap-3 py-10 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-[16px] text-white" style={{ backgroundColor: IOS.indigo }}>
            <TabletSmartphone className="h-7 w-7" aria-hidden />
          </span>
          <div className="text-[20px] font-semibold">{t('noKiosks')}</div>
          <Muted className="max-w-md">{t('noKiosksHint')}</Muted>
          <Link href="/dashboard/kiosks" className="text-[15px] font-medium text-[#007AFF] dark:text-[#0A84FF]">
            {t('openKiosks')}
          </Link>
        </Card>
      ) : (
        <div className={cn('transition-opacity', report.isFetching && 'opacity-70')}>
          {!data.hasData ? (
            <Card className="mt-5 flex flex-col items-center gap-2 py-10 text-center">
              <div className="text-[20px] font-semibold">{t('noData')}</div>
              <Muted className="max-w-md">{t('noDataHint')}</Muted>
            </Card>
          ) : cur ? (
            <>
              {/* Headline figures */}
              <SectionHeader>{t('kpi.title')}</SectionHeader>
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
                <Widget
                  title={t('kpi.sessions')}
                  color={IOS.gray}
                  value={count(cur.sessions)}
                  {...vs((h) => h.sessions, count)}
                />
                <Widget
                  title={t('kpi.conversion')}
                  color={IOS.green}
                  value={pctText(cur.conversion)}
                  {...vs((h) => h.conversion, pct)}
                />
                <Widget title={t('kpi.orders')} color={IOS.purple} value={count(cur.orders)} {...vs((h) => h.orders, count)} />
                <Widget title={t('kpi.revenue')} color={IOS.blue} value={agorot(cur.revenue)} {...vs((h) => h.revenue, agorot)} />
                <Widget title={t('kpi.avgBasket')} color={IOS.teal} value={agorot(cur.avgBasket)} {...vs((h) => h.avgBasket, agorot)} />
                <Widget
                  title={t('kpi.itemsPerOrder')}
                  color={IOS.indigo}
                  value={cur.itemsPerOrder !== null ? cur.itemsPerOrder.toFixed(2) : '—'}
                  {...vs((h) => h.itemsPerOrder, (n) => n.toFixed(2))}
                />
                <Widget
                  title={t('kpi.medianOrder')}
                  color={IOS.orange}
                  value={durationText(cur.medianOrderSec)}
                  {...vs((h) => h.medianOrderSec, durationText, true)}
                />
                <Widget
                  title={t('kpi.upsellRate')}
                  color={IOS.pink}
                  value={pctText(cur.upsellRate)}
                  {...vsOr(
                    (h) => h.upsellRate,
                    pct,
                    false,
                    cur.upsellShown ? t('kpi.acceptedOf', { accepted: count(cur.upsellAccepted), shown: count(cur.upsellShown) }) : undefined,
                  )}
                />
                <Widget
                  title={t('kpi.payFailureRate')}
                  color={IOS.red}
                  value={pctText(cur.payFailureRate)}
                  {...vsOr(
                    (h) => h.payFailureRate,
                    pct,
                    true,
                    cur.payAttempts ? t('kpi.failedOf', { failed: count(cur.payFailures), attempts: count(cur.payAttempts) }) : undefined,
                  )}
                />
              </div>
              {cur.helpRequests > 0 || cur.basketChanged > 0 ? (
                <p className="mt-2 px-4 text-[13px] text-[#8E8E93]">
                  {[
                    cur.helpRequests > 0 ? t('kpi.helpRequests', { n: count(cur.helpRequests) }) : null,
                    cur.basketChanged > 0 ? t('kpi.basketChanged', { n: count(cur.basketChanged) }) : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              ) : null}

              <SectionHeader>{t('sections.funnel')}</SectionHeader>
              <FunnelChart funnel={data.funnel} />

              <SectionHeader trailing={<span className="text-[13px] text-[#8E8E93]">{t('abandonment.left', { n: count(data.abandonment.left) })}</span>}>
                {t('sections.abandonment')}
              </SectionHeader>
              <AbandonmentChart abandonment={data.abandonment} />

              <div className="grid gap-x-3 xl:grid-cols-2">
                <section>
                  <SectionHeader>{t('sections.orderTime')}</SectionHeader>
                  <OrderTimeChart orderTime={data.orderTime} />
                </section>
                <section>
                  <SectionHeader>{t('sections.byHour')}</SectionHeader>
                  <ByHourChart rows={data.byHour} />
                </section>
              </div>

              <SectionHeader>{t('sections.daily')}</SectionHeader>
              <DailyChart rows={data.daily} />

              <SectionHeader>{t('sections.topItems')}</SectionHeader>
              <TopItemsList items={data.topItems} />

              <SectionHeader>{t('sections.upsell')}</SectionHeader>
              <UpsellBlock upsell={data.upsell} />

              <SectionHeader>{t('sections.payments')}</SectionHeader>
              <PaymentsBlock payments={data.payments} />
            </>
          ) : null}

          <SectionHeader>{t('sections.perKiosk')}</SectionHeader>
          <PerKioskTable rows={data.perKiosk} selectedId={kioskId} onSelect={setKioskId} />
        </div>
      )}

      <p className="mt-6 px-4 text-[12px] leading-relaxed text-[#8E8E93]">
        {t('footnote', { hour: String(data?.dayStartHour ?? 4).padStart(2, '0'), tz: data?.timezone ?? 'Asia/Jerusalem' })}
      </p>
    </InsightsSurface>
  );
}
