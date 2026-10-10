'use client';

/**
 * Insights (תובנות) — docs/SPEC_INSIGHTS.md: what the manager should look at and do,
 * in plain Hebrew, over the control board's scope (organization › company › shop › point
 * of sale › till) and a period of complete business days (7 / 28 / 90 or custom, against
 * the period before it).
 *
 * First the headline figures and the feed of cards (most urgent first, each with a
 * suggested action and a link to its section), the open tables now, then the sections:
 * forecast, trends, weekday × hour, menu engineering (with unit costs typed in place),
 * ABC, slow movers and dead stock, stock-out risk, the basket, employees, the tables and
 * repeat customers. Each section is its own request (`/insights/...`, money in agorot),
 * refreshed every five minutes while auto refresh is on.
 *
 * The control board's iOS language: a large title, grouped grey background, white
 * rounded cards, segmented controls and a switch; dark mode included.
 */

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { keepPreviousData, useQuery, type UseQueryResult } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { he } from 'date-fns/locale';
import { RefreshCw } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { formatShortDate } from '@/lib/format';
import {
  agorot,
  fetchAbc,
  fetchBaskets,
  fetchCashierRates,
  fetchCustomers,
  fetchForecast,
  fetchHeatmap,
  fetchInsightsFeed,
  fetchMenuEngineering,
  fetchSlowProducts,
  fetchStockRisk,
  fetchTablesPeriod,
  fetchTrends,
  type InsightCard,
  type InsightScopeParams,
  type KpiBlock,
} from '@/lib/insightsApi';
import { cn } from '@/lib/utils';
import { ALL_COMPANIES, EMPTY_ORG_SCOPE, type OrgScope } from '@/components/dashboard/org-scope-cascade';
import { ScopePicker } from '@/components/dashboard/live/scope-picker';
import { Card, Delta, IOS, InsightsSurface, Muted, SectionHeader, Segmented, SkeletonCard, Switch, Widget } from '@/components/dashboard/insights/ios';
import { DatePicker } from '@/components/ui/date-picker';
import { scopeParams } from '@/components/dashboard/insights/scope-params';
import { InsightFeed } from '@/components/dashboard/insights/insight-feed';
import { OpenTablesWidget } from '@/components/dashboard/insights/open-tables-widget';
import { KioskInsightsLinkCard } from '@/components/dashboard/kiosk-insights/link-card';
import { ForecastSection } from '@/components/dashboard/insights/forecast-section';
import { ForecastCard } from '@/components/dashboard/event-live/forecast-card';
import { TrendsSection } from '@/components/dashboard/insights/trends-section';
import { HeatmapSection } from '@/components/dashboard/insights/heatmap-section';
import { MenuSection } from '@/components/dashboard/insights/menu-section';
import { AbcSection } from '@/components/dashboard/insights/abc-section';
import { SlowSection, type DeadDays } from '@/components/dashboard/insights/slow-section';
import { StockSection } from '@/components/dashboard/insights/stock-section';
import { BasketsSection } from '@/components/dashboard/insights/baskets-section';
import { CashiersSection } from '@/components/dashboard/insights/cashiers-section';
import { CustomersSection, TablesPeriodSection } from '@/components/dashboard/insights/tables-section';
import { useInsightsExport } from '@/components/dashboard/insights/export-sheets';
import { ReportExportToolbar } from '@/components/dashboard/report-export-toolbar';
// Till anomalies, quick actions, happy hour (docs/SPEC_INSIGHTS.md §10).
import { fetchEvents } from '@/lib/eventsApi';
import { fetchHappyHourSuggestions, fetchTillAnomalies } from '@/lib/insightsActionsApi';
import type { ActionScope } from '@/lib/insightsActions';
import { AnomaliesSection, TillActions, type AnomalyWindow } from '@/components/dashboard/insights-actions/anomalies-section';
import { HappyHourSection } from '@/components/dashboard/insights-actions/happy-hour-section';
import { RecentActions } from '@/components/dashboard/insights-actions/recent-actions';
import { ProductQuickActions, ResultChip, useLatestActionByProduct } from '@/components/dashboard/insights-actions/quick-action-buttons';
import { useCanAct } from '@/components/dashboard/insights-actions/sheet-parts';
import { useActionSheets } from '@/components/dashboard/insights-actions/action-host';
import { HomeTabs } from '@/components/dashboard/control-board/home-tabs';
import { useHomeAccess } from '@/components/dashboard/control-board/use-home-access';

const AUTO_REFRESH_MS = 5 * 60_000;
const COST_EDITORS = new Set(['super_admin', 'distributor', 'company_manager']);

type Range = '7' | '28' | '90' | 'custom';

function isoDaysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** A section: its header, then a skeleton, an error with a retry, or its content. */
function Section<T>({
  id,
  title,
  query,
  trailing,
  children,
  skeleton = 'h-56',
}: {
  id: string;
  title: string;
  query: UseQueryResult<T>;
  trailing?: React.ReactNode;
  children: (data: T) => React.ReactNode;
  skeleton?: string;
}) {
  const t = useTranslations('insights');
  return (
    <section aria-labelledby={`ins-${id}-title`}>
      <SectionHeader id={`ins-${id}`} trailing={trailing}>
        <span id={`ins-${id}-title`}>{title}</span>
      </SectionHeader>
      {query.data ? (
        <div className={cn('transition-opacity', query.isFetching && 'opacity-70')}>{children(query.data)}</div>
      ) : query.isError ? (
        <Card className="flex items-center justify-between gap-3">
          <Muted>{t('loadError')}</Muted>
          <button type="button" onClick={() => void query.refetch()} className="text-[15px] text-[#007AFF] dark:text-[#0A84FF]">
            {t('retry')}
          </button>
        </Card>
      ) : (
        <SkeletonCard className={skeleton} />
      )}
    </section>
  );
}

export default function InsightsPage() {
  const t = useTranslations('insights');
  const role = useAuth((s) => s.user?.role);
  const canEditCosts = !!role && COST_EDITORS.has(role);
  // "לוח בקרה | השוואות | תובנות": the home page's control, its segments gated the same way.
  const { compareAllowed, insightsAllowed } = useHomeAccess();

  const [scope, setScope] = useState<OrgScope>({ ...EMPTY_ORG_SCOPE, companyId: ALL_COMPANIES });
  const [range, setRange] = useState<Range>('28');
  const [customFrom, setCustomFrom] = useState(() => isoDaysAgo(28));
  const [customTo, setCustomTo] = useState(() => isoDaysAgo(1));
  const [auto, setAuto] = useState(true);
  const [deadDays, setDeadDays] = useState<DeadDays>('21');
  const [categoryId, setCategoryId] = useState('');
  const [byCategory, setByCategory] = useState(true);
  // An event's scope: its tills, window and days (the period and the org scope give way).
  const [eventId, setEventId] = useState('');
  const [anomalyWindow, setAnomalyWindow] = useState<AnomalyWindow>('period');
  const tA = useTranslations('insightsActions');

  const params: InsightScopeParams = eventId
    ? { eventId }
    : range === 'custom'
      ? { ...scopeParams(scope), from: customFrom, to: customTo }
      : { ...scopeParams(scope), days: Number(range) };
  const common = {
    refetchInterval: auto ? AUTO_REFRESH_MS : (false as const),
    placeholderData: keepPreviousData,
    retry: 1,
  };

  const feed = useQuery({ queryKey: ['insights-feed', params], queryFn: () => fetchInsightsFeed(params), ...common });
  const availability = feed.data?.availability;
  const forecast = useQuery({ queryKey: ['insights-forecast', params], queryFn: () => fetchForecast(params), ...common });
  const trends = useQuery({ queryKey: ['insights-trends', params], queryFn: () => fetchTrends(params), ...common });
  const heatmap = useQuery({ queryKey: ['insights-heatmap', params], queryFn: () => fetchHeatmap(params), ...common });
  const menuParams = { ...params, categoryId: categoryId || undefined, byCategory };
  const menu = useQuery({ queryKey: ['insights-menu', menuParams], queryFn: () => fetchMenuEngineering(menuParams), ...common });
  const abc = useQuery({ queryKey: ['insights-abc', params], queryFn: () => fetchAbc(params), ...common });
  const slowParams = { ...params, deadDays: Number(deadDays) };
  const slow = useQuery({ queryKey: ['insights-slow', slowParams], queryFn: () => fetchSlowProducts(slowParams), ...common });
  // Excel: every section the page shows, through these same queries, all rows.
  const insightsExport = useInsightsExport(scope);
  const stock = useQuery({
    queryKey: ['insights-stock', params],
    queryFn: () => fetchStockRisk(params),
    enabled: !!availability?.hasStock,
    ...common,
  });
  const baskets = useQuery({ queryKey: ['insights-baskets', params], queryFn: () => fetchBaskets(params), ...common });
  const cashiers = useQuery({ queryKey: ['insights-cashiers', params], queryFn: () => fetchCashierRates(params), ...common });
  const tables = useQuery({
    queryKey: ['insights-tables', params],
    queryFn: () => fetchTablesPeriod(params),
    enabled: !!availability?.hasTables,
    ...common,
  });
  const customers = useQuery({ queryKey: ['insights-customers', params], queryFn: () => fetchCustomers(params), ...common });
  const anomalies = useQuery({
    queryKey: ['till-anomalies', anomalyWindow, params],
    queryFn: () => fetchTillAnomalies({ ...params, window: anomalyWindow }),
    ...common,
  });
  const happyHours = useQuery({
    queryKey: ['happy-hour-suggestions', params],
    queryFn: () => fetchHappyHourSuggestions(params),
    enabled: !eventId,
    ...common,
  });
  const events = useQuery({ queryKey: ['report-events', 'insights'], queryFn: () => fetchEvents({}), staleTime: 60_000, retry: false });

  // The sheets act on the page's scope (or its event).
  const companyScope = scope.companyId && scope.companyId !== ALL_COMPANIES ? scope.companyId : undefined;
  const actionScope: ActionScope = eventId
    ? { eventId }
    : { companyId: companyScope, shopId: scope.shopId || undefined, areaId: scope.areaId || undefined, machineId: scope.machineId || undefined };
  const sheets = useActionSheets(actionScope);
  const canAct = useCanAct();
  const latestByProduct = useLatestActionByProduct();
  const productActions = (row: { productId: string | null; name: string }, source: string) =>
    row.productId ? (
      <div className="flex flex-wrap items-center gap-2">
        <ProductQuickActions
          onMessage={() => sheets.open('quickMessage', { productId: row.productId! }, { source })}
          onPromo={() => sheets.open('quickPromo', { productId: row.productId! }, { source })}
        />
        {latestByProduct.get(row.productId) ? <ResultChip action={latestByProduct.get(row.productId)!} /> : null}
      </div>
    ) : null;
  const openTillMessage = (machineId: string, text: string) => sheets.open('quickMessage', { machineId }, { initialText: text, source: 'anomaly' });
  const cardActions = (card: InsightCard) => {
    if (card.type.startsWith('till_')) return <TillActions card={card} onMessage={openTillMessage} canMessage={canAct} />;
    const productId = typeof card.params.productId === 'string' ? card.params.productId : null;
    const source = card.type === 'product_dead' ? 'dead' : card.type === 'product_declining' || card.type === 'product_falling' ? 'declining' : 'slow';
    return productId ? productActions({ productId, name: String(card.params.name ?? '') }, source) : null;
  };

  const all = [feed, forecast, trends, heatmap, menu, abc, slow, stock, baskets, cashiers, tables, customers, anomalies, happyHours];
  const fetching = all.some((q) => q.isFetching);
  const updatedAt = Math.max(...all.map((q) => q.dataUpdatedAt || 0));
  const refetchAll = () => all.forEach((q) => void q.refetch());

  // Re-render now and then so "updated N minutes ago" stays true.
  const [, tick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => tick((n) => n + 1), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const open = (section: string) => {
    const el = document.getElementById(`ins-${section}`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const period = feed.data?.period;
  const kpi = feed.data?.kpis;
  const cur = kpi?.current;
  const prev = kpi?.previous ?? null;
  const vs = (pick: (k: KpiBlock) => number | null, format: (n: number) => string, invert = false) => {
    if (!cur) return {};
    const a = pick(cur);
    const b = prev ? pick(prev) : null;
    if (a === null || b === null) return { sub: undefined, delta: undefined };
    return { sub: t('vsPrev', { value: format(b) }), delta: <Delta a={a} b={b} invert={invert} /> };
  };
  const count = (n: number) => n.toLocaleString('he-IL');
  const pctFmt = (n: number) => `${n.toFixed(1)}%`;

  return (
    <InsightsSurface>
      {/* "לוח בקרה | השוואות | תובנות" — the same control as the home page's */}
      <HomeTabs view="insights" canCompare={compareAllowed} canInsights={insightsAllowed} className="mb-4" />
      {/* Large title */}
      <div className="flex items-end justify-between gap-3 px-1">
        <div className="min-w-0">
          <p className="truncate text-[13px] font-semibold uppercase tracking-wide text-[#8E8E93]">
            {period
              ? t('periodLine', { from: formatShortDate(period.from), to: formatShortDate(period.to), prevFrom: formatShortDate(period.prevFrom), prevTo: formatShortDate(period.prevTo) })
              : t('loading')}
          </p>
          <h1 className="text-[34px] font-bold leading-tight tracking-tight">{t('title')}</h1>
        </div>
        <button
          type="button"
          onClick={refetchAll}
          aria-label={t('refresh')}
          className="mb-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white text-[#007AFF] shadow-sm active:opacity-60 dark:bg-[#1C1C1E]"
        >
          <RefreshCw className={cn('h-[18px] w-[18px]', fetching && 'animate-spin')} />
        </button>
      </div>

      {/* Excel · Print · PDF */}
      <ReportExportToolbar
        title={t('title')}
        from={period?.from}
        to={period?.to}
        scopeLabel={insightsExport.scopeLabel}
        getSheets={() => insightsExport.getSheets({ params, menuParams, slowParams })}
        disabled={feed.isPending}
        className="mt-3 px-1"
      />

      {/* Period */}
      <div className="mt-4 overflow-x-auto px-1 pb-1">
        <Segmented
          value={range}
          onChange={setRange}
          label={t('range.label')}
          className="min-w-[320px]"
          options={[
            { id: '7', label: t('range.d7') },
            { id: '28', label: t('range.d28') },
            { id: '90', label: t('range.d90') },
            { id: 'custom', label: t('range.custom') },
          ]}
        />
      </div>
      {range === 'custom' ? (
        <Card className="mt-3 divide-y divide-[#3C3C4349] p-0 dark:divide-[#54545899]">
          <label className="flex items-center justify-between gap-3 px-4 py-2.5">
            <span className="text-[17px]">{t('range.from')}</span>
            <DatePicker
              value={customFrom}
              max={customTo}
              onChange={(e) => setCustomFrom(e.target.value)}
              range={{ from: customFrom, to: customTo, onSelect: (r) => { setCustomFrom(r.from); setCustomTo(r.to); } }}
              dir="ltr"
              className="w-40 shrink-0 text-[15px] text-[#007AFF]"
            />
          </label>
          <label className="flex items-center justify-between gap-3 px-4 py-2.5">
            <span className="text-[17px]">{t('range.to')}</span>
            <DatePicker
              value={customTo}
              min={customFrom}
              max={isoDaysAgo(0)}
              onChange={(e) => setCustomTo(e.target.value)}
              range={{ from: customFrom, to: customTo, onSelect: (r) => { setCustomFrom(r.from); setCustomTo(r.to); } }}
              dir="ltr"
              className="w-40 shrink-0 text-[15px] text-[#007AFF]"
            />
          </label>
        </Card>
      ) : null}

      {/* Scope + refresh */}
      <SectionHeader>{t('scope')}</SectionHeader>
      <Card className="space-y-3">
        <ScopePicker value={scope} onChange={setScope} allowAll />
        {(events.data ?? []).length ? (
          <label className="flex flex-wrap items-center justify-between gap-3 border-t border-[#3C3C4349] pt-3 dark:border-[#54545899]">
            <span>
              <span className="block text-[17px]">{tA('page.event')}</span>
              <span className="block text-[13px] text-[#8E8E93]">{tA('page.eventHint')}</span>
            </span>
            <select
              value={eventId}
              onChange={(e) => setEventId(e.target.value)}
              aria-label={tA('page.event')}
              className="min-h-10 max-w-64 rounded-lg bg-transparent text-[15px] text-[#007AFF] dark:text-[#0A84FF]"
            >
              <option value="">{tA('page.eventNone')}</option>
              {(events.data ?? []).map((ev) => (
                <option key={ev.id} value={ev.id}>{ev.name}</option>
              ))}
            </select>
          </label>
        ) : null}
        <div className="flex items-center justify-between gap-3 border-t border-[#3C3C4349] pt-3 dark:border-[#54545899]">
          <div>
            <div className="text-[17px]">{t('autoRefresh')}</div>
            <div className="text-[13px] text-[#8E8E93]">
              {updatedAt > 0 ? t('updatedAgo', { ago: formatDistanceToNow(updatedAt, { addSuffix: true, locale: he }) }) : t('autoRefreshHint')}
            </div>
          </div>
          <Switch checked={auto} onChange={setAuto} label={t('autoRefresh')} />
        </div>
      </Card>

      {/* Headline figures */}
      <SectionHeader>{t('kpi.title')}</SectionHeader>
      {!cur ? (
        feed.isError ? (
          <Card className="flex items-center justify-between gap-3">
            <Muted>{t('loadError')}</Muted>
            <button type="button" onClick={() => void feed.refetch()} className="text-[15px] text-[#007AFF] dark:text-[#0A84FF]">
              {t('retry')}
            </button>
          </Card>
        ) : (
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 2xl:grid-cols-6">
            {Array.from({ length: 6 }).map((_, i) => (
              <SkeletonCard key={i} className="h-[104px]" />
            ))}
          </div>
        )
      ) : (
        <div className={cn('grid grid-cols-2 gap-3 transition-opacity lg:grid-cols-3 2xl:grid-cols-6', feed.isFetching && 'opacity-70')}>
          <Widget title={t('kpi.net')} color={IOS.blue} value={agorot(cur.net)} {...vs((k) => k.net, agorot)} />
          <Widget title={t('kpi.sales')} color={IOS.purple} value={count(cur.sales)} {...vs((k) => k.sales, count)} />
          <Widget title={t('kpi.avgCheck')} color={IOS.green} value={agorot(cur.avgCheck)} {...vs((k) => k.avgCheck, agorot)} />
          <Widget
            title={t('kpi.itemsPerSale')}
            color={IOS.teal}
            value={cur.itemsPerSale !== null ? cur.itemsPerSale.toFixed(2) : '—'}
            {...vs((k) => k.itemsPerSale, (n) => n.toFixed(2))}
          />
          <Widget
            title={t('kpi.discountPct')}
            color={IOS.pink}
            value={cur.discountPct !== null ? pctFmt(cur.discountPct) : '—'}
            {...vs((k) => k.discountPct, pctFmt, true)}
          />
          <Widget
            title={t('kpi.tips')}
            color={IOS.orange}
            value={agorot(cur.tips)}
            sub={cur.tipPct !== null ? t('kpi.tipPct', { pct: cur.tipPct.toFixed(1) }) : undefined}
          />
        </div>
      )}

      {/* The feed */}
      <SectionHeader id="ins-feed">{t('feed.title')}</SectionHeader>
      {feed.data ? (
        availability && !availability.hasSales ? (
          <Card>
            <Muted>{t('noData')}</Muted>
          </Card>
        ) : (
          <div className={cn('transition-opacity', feed.isFetching && 'opacity-70')}>
            <InsightFeed feed={feed.data} onOpen={open} renderActions={cardActions} />
          </div>
        )
      ) : feed.isError ? null : (
        <div className="grid gap-3 lg:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <SkeletonCard key={i} className="h-40" />
          ))}
        </div>
      )}

      {/* Open tables now (hidden when the scope has no tables) */}
      <OpenTablesWidget scope={scope} auto={auto} />

      {/* Till anomalies: each till against its peers, with its actions */}
      <Section id="anomalies" title={tA('page.anomalies')} query={anomalies}>
        {(data) => (
          <AnomaliesSection
            data={data}
            window={anomalyWindow}
            onWindow={setAnomalyWindow}
            onMessage={openTillMessage}
            canMessage={canAct}
            eventScope={!!eventId}
          />
        )}
      </Section>

      {/* What was done from here, and how it went */}
      <SectionHeader
        trailing={
          canAct ? (
            <button type="button" onClick={() => sheets.open('quickPromo')} className="text-[15px] text-[#007AFF] dark:text-[#0A84FF]">
              {tA('page.adhoc')}
            </button>
          ) : undefined
        }
      >
        {tA('page.recent')}
      </SectionHeader>
      <RecentActions />

      {/* "ביצועי קיוסקים" — its own page */}
      <KioskInsightsLinkCard />

      <Section id="forecast" title={t('sections.forecast')} query={forecast}>
        {(data) => <ForecastSection data={data} />}
      </Section>
      {/* feat/event-live: "תחזית ואיוש" per shop — the next hours, tomorrow by the hour, the tills to open. */}
      <div className="mt-5">
        <ForecastCard scope={{ companyId: params.companyId, shopId: params.shopId, areaId: params.areaId, machineId: params.machineId }} />
      </div>
      <Section id="trends" title={t('sections.trends')} query={trends}>
        {(data) => <TrendsSection data={data} />}
      </Section>
      <Section id="heatmap" title={t('sections.heatmap')} query={heatmap}>
        {(data) => <HeatmapSection data={data} />}
      </Section>
      {!eventId ? (
        <Section id="happy-hour" title={tA('page.happyHour')} query={happyHours}>
          {(data) => (
            <HappyHourSection
              data={data}
              onApply={(s) => sheets.open('happyHour', undefined, { suggestion: s })}
              onCustom={() => sheets.open('happyHour')}
            />
          )}
        </Section>
      ) : null}
      <Section id="menu" title={t('sections.menu')} query={menu} skeleton="h-96">
        {(data) => (
          <MenuSection
            data={data}
            categoryId={categoryId}
            onCategory={setCategoryId}
            byCategory={byCategory}
            onByCategory={setByCategory}
            canEdit={canEditCosts}
          />
        )}
      </Section>
      <Section id="abc" title={t('sections.abc')} query={abc}>
        {(data) => <AbcSection data={data} />}
      </Section>
      <Section id="slow" title={t('sections.slow')} query={slow}>
        {(data) => (
          <SlowSection data={data} deadDays={deadDays} onDeadDays={setDeadDays} renderActions={(row) => productActions(row, 'slow')} />
        )}
      </Section>
      {availability?.hasStock ? (
        <Section id="stock" title={t('sections.stock')} query={stock}>
          {(data) => <StockSection data={data} />}
        </Section>
      ) : null}
      <Section id="baskets" title={t('sections.baskets')} query={baskets}>
        {(data) => <BasketsSection data={data} />}
      </Section>
      <Section id="cashiers" title={t('sections.cashiers')} query={cashiers}>
        {(data) => <CashiersSection data={data} />}
      </Section>
      {availability?.hasTables ? (
        <Section id="tables" title={t('sections.tables')} query={tables}>
          {(data) => <TablesPeriodSection data={data} />}
        </Section>
      ) : null}
      {customers.data?.summary ? (
        <Section id="customers" title={t('sections.customers')} query={customers}>
          {(data) => <CustomersSection data={data} />}
        </Section>
      ) : null}

      <p className="mt-6 px-4 text-[12px] leading-relaxed text-[#8E8E93]">
        {t('footnote', { hour: String(feed.data?.dayStartHour ?? 4).padStart(2, '0'), tz: feed.data?.timezone ?? 'Asia/Jerusalem' })}
      </p>
      {sheets.element}
    </InsightsSurface>
  );
}
