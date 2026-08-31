'use client';

/**
 * Today's takings for whatever the shared scope points at.
 *
 * This panel used to carry its own company and shop dropdowns — two more copies
 * of the pickers that were on every other page. They are gone: the scope bar in
 * the dashboard shell is the only place a company or shop is chosen, and clicking
 * a bar in the breakdown moves that shared scope rather than a local `useState`,
 * so drilling in here also updates the URL, the breadcrumbs and every other page.
 *
 * One honest caveat is surfaced rather than hidden: the server's `companyId`
 * filter matches a company's own shops, not its descendants', so a parent company
 * with child companies gets a note saying the roll-up covers its own shops only.
 */

import { useMemo } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import {
  Banknote,
  CreditCard,
  Coins,
  Receipt,
  RotateCcw,
  ShoppingBag,
  TrendingUp,
  Wallet,
} from 'lucide-react';
import {
  Bar,
  BarChart,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { fetchDashboardBreakdown, fetchDashboardStats } from '@/lib/api';
import { useScope } from '@/lib/scope';
import { companyChildren } from '@/lib/companyTree';
import type { DashboardBreakdownRow, ScopeSelection } from '@/lib/types';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';

const POLL_MS = 10_000;
/** Hex fallbacks — Recharts SVG fill is unreliable with bare CSS variables in some browsers. */
const CHART_COLORS = ['#3b82f6', '#14b8a6', '#f59e0b', '#ef4444', '#a855f7'];
const PAYMENT_COLORS = {
  cash: '#10b981',
  card: '#3b82f6',
} as const;

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('he-IL', {
    style: 'currency',
    currency: 'ILS',
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(amount);
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('he-IL', {
    maximumFractionDigits: value % 1 === 0 ? 0 : 2,
  }).format(value);
}

function getLocalDayBounds(): { from: string; to: string } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  return { from: start.toISOString(), to: end.toISOString() };
}

function StatCard({
  title,
  value,
  subtitle,
  icon: Icon,
  isLoading,
}: {
  title: string;
  value?: string;
  subtitle?: string;
  icon: React.ElementType;
  isLoading: boolean;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-8 w-24" />
        ) : (
          <>
            <p className="text-2xl font-bold">{value ?? '—'}</p>
            {subtitle ? <p className="text-xs text-muted-foreground mt-1">{subtitle}</p> : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function SalesStats({ scope: override }: { scope?: ScopeSelection }) {
  const t = useTranslations('dashboard.sales');
  const tScope = useTranslations('scope');
  const scope = useScope();
  const dayBounds = useMemo(() => getLocalDayBounds(), []);

  // A drill-down page passes its own route entity; the overview uses the bar.
  const selection: ScopeSelection = override ?? scope.selection;

  const statsParams = useMemo(
    () => ({
      ...dayBounds,
      companyId: selection.companyId ?? undefined,
      shopId: selection.shopId ?? undefined,
      machineId: selection.machineId ?? undefined,
    }),
    [dayBounds, selection.companyId, selection.machineId, selection.shopId],
  );

  const stats = useQuery({
    queryKey: ['dashboard-stats', statsParams],
    queryFn: () => fetchDashboardStats(statsParams),
    placeholderData: keepPreviousData,
    refetchInterval: POLL_MS,
    refetchOnWindowFocus: true,
  });

  /**
   * Breakdown: by company at the top level, by shop once a company is in scope,
   * and nothing at all once a single shop or device is — the KPIs above already
   * represent exactly that one row.
   */
  const breakdownMode: 'company' | 'shop' | null = useMemo(() => {
    if (selection.shopId || selection.machineId) return null;
    return selection.companyId ? 'shop' : 'company';
  }, [selection.companyId, selection.machineId, selection.shopId]);

  const breakdown = useQuery({
    queryKey: ['dashboard-breakdown', dayBounds, breakdownMode, selection.companyId ?? 'all'],
    queryFn: () =>
      fetchDashboardBreakdown({
        ...dayBounds,
        companyId: breakdownMode === 'shop' ? selection.companyId ?? undefined : undefined,
      }),
    enabled: breakdownMode !== null,
    placeholderData: keepPreviousData,
    refetchInterval: POLL_MS,
    refetchOnWindowFocus: true,
  });

  const paymentChartData = useMemo(() => {
    if (!stats.data) return [];
    return [
      { name: t('cash'), value: stats.data.paymentCash, color: PAYMENT_COLORS.cash },
      { name: t('card'), value: stats.data.paymentCard, color: PAYMENT_COLORS.card },
    ].filter((row) => row.value > 0);
  }, [stats.data, t]);

  const breakdownRows = breakdown.data?.rows ?? [];
  const breakdownInitialLoad = breakdown.isPending && breakdownRows.length === 0;

  // Clicking a bar moves the shared scope, so the drill-in is shareable and
  // reversible with the browser's Back button.
  const handleBarClick = (row: DashboardBreakdownRow) => {
    if (override) return;
    if (breakdownMode === 'company') scope.setCompany(row.id);
    else if (breakdownMode === 'shop') scope.setShop(row.id);
  };

  const hasChildCompanies =
    !!selection.companyId && companyChildren(scope.tree, selection.companyId).length > 0;

  if (stats.isError) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
        {t('loadError')}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold">{t('title')}</h2>
        <Badge variant="secondary" className="text-xs">
          {t('live')}
        </Badge>
      </div>

      {hasChildCompanies ? (
        <p className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          {tScope('companyRollupDirectOnly')}
        </p>
      ) : null}

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <StatCard
          title={t('grossRevenue')}
          value={stats.data ? formatCurrency(stats.data.grossRevenue) : undefined}
          icon={TrendingUp}
          isLoading={stats.isLoading}
        />
        <StatCard
          title={t('netRevenue')}
          value={stats.data ? formatCurrency(stats.data.netRevenue) : undefined}
          icon={Wallet}
          isLoading={stats.isLoading}
        />
        <StatCard
          title={t('transactions')}
          value={stats.data ? formatNumber(stats.data.transactionsCount) : undefined}
          subtitle={
            stats.data && stats.data.transactionsCount > 0
              ? `${t('avgBasket')}: ${formatCurrency(stats.data.averageBasket)}`
              : undefined
          }
          icon={Receipt}
          isLoading={stats.isLoading}
        />
        <StatCard
          title={t('itemsSold')}
          value={stats.data ? formatNumber(stats.data.itemsSold) : undefined}
          icon={ShoppingBag}
          isLoading={stats.isLoading}
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <StatCard
          title={t('refunds')}
          value={stats.data ? formatCurrency(stats.data.refundsAmount) : undefined}
          subtitle={
            stats.data && stats.data.refundsCount > 0
              ? t('refundsCount', { count: stats.data.refundsCount })
              : undefined
          }
          icon={RotateCcw}
          isLoading={stats.isLoading}
        />
        <StatCard
          title={t('tipsCash')}
          value={stats.data ? formatCurrency(stats.data.tipsCash) : undefined}
          icon={Coins}
          isLoading={stats.isLoading}
        />
        <StatCard
          title={t('tipsCard')}
          value={stats.data ? formatCurrency(stats.data.tipsCard) : undefined}
          icon={CreditCard}
          isLoading={stats.isLoading}
        />
        <StatCard
          title={t('paymentSplit')}
          value={
            stats.data
              ? `${formatCurrency(stats.data.paymentCash)} / ${formatCurrency(stats.data.paymentCard)}`
              : undefined
          }
          subtitle={stats.data ? `${t('cash')} / ${t('card')}` : undefined}
          icon={Banknote}
          isLoading={stats.isLoading}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {breakdownMode ? (
          <Card className="lg:col-span-2">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  {breakdownMode === 'company' ? t('byCompany') : t('byShop')}
                </CardTitle>
                {breakdownRows.length > 0 && !override ? (
                  <span className="text-xs text-muted-foreground">{t('drillHint')}</span>
                ) : null}
              </div>
            </CardHeader>
            <CardContent>
              {breakdownInitialLoad ? (
                <Skeleton className="h-48 w-full" />
              ) : breakdownRows.length === 0 ? (
                <p className="text-sm text-muted-foreground py-8 text-center">{t('breakdownEmpty')}</p>
              ) : (
                <div
                  className={breakdown.isFetching ? 'opacity-60 transition-opacity' : undefined}
                  style={{ width: '100%', height: Math.max(160, breakdownRows.length * 44) }}
                >
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={breakdownRows}
                      layout="vertical"
                      margin={{ top: 4, right: 16, bottom: 4, left: 8 }}
                    >
                      <XAxis type="number" hide />
                      <YAxis
                        type="category"
                        dataKey="name"
                        width={130}
                        tickLine={false}
                        axisLine={false}
                        tick={{ fontSize: 12 }}
                      />
                      <Tooltip
                        cursor={{ fill: 'var(--muted)', opacity: 0.4 }}
                        formatter={(value) =>
                          formatCurrency(typeof value === 'number' ? value : Number(value ?? 0))
                        }
                      />
                      <Bar
                        dataKey="grossRevenue"
                        radius={[0, 4, 4, 0]}
                        cursor={override ? 'default' : 'pointer'}
                        onClick={(data: unknown) => handleBarClick((data as { payload: DashboardBreakdownRow }).payload)}
                      >
                        {breakdownRows.map((_, index) => (
                          <Cell key={index} fill={CHART_COLORS[index % CHART_COLORS.length]} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </CardContent>
          </Card>
        ) : null}

        {paymentChartData.length > 0 ? (
          <Card className={breakdownMode ? '' : 'lg:col-span-3'}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">{t('paymentSplit')}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="h-48 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={paymentChartData}
                      dataKey="value"
                      nameKey="name"
                      cx="50%"
                      cy="50%"
                      innerRadius={48}
                      outerRadius={72}
                      paddingAngle={2}
                    >
                      {paymentChartData.map((row) => (
                        <Cell key={row.name} fill={row.color} />
                      ))}
                    </Pie>
                    <Tooltip
                      formatter={(value) => formatCurrency(typeof value === 'number' ? value : Number(value ?? 0))}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className="mt-2 flex flex-wrap justify-center gap-4 text-xs text-muted-foreground">
                {paymentChartData.map((row) => (
                  <div key={row.name} className="flex items-center gap-1.5">
                    <span
                      className="inline-block size-2.5 rounded-full"
                      style={{ backgroundColor: row.color }}
                      aria-hidden
                    />
                    <span>
                      {row.name}: {formatCurrency(row.value)}
                    </span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        ) : null}
      </div>
    </div>
  );
}
