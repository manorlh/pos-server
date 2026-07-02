'use client';

import { useEffect, useMemo, useState } from 'react';
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
import { api, fetchDashboardBreakdown, fetchDashboardStats } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { entitySelectItems } from '@/lib/selectItems';
import type { Company, DashboardBreakdownRow, Shop } from '@/lib/types';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const POLL_MS = 10_000;
const ALL = 'all';
const CHART_COLORS = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
];

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

export function SalesStats() {
  const t = useTranslations('dashboard.sales');
  const role = useAuth((s) => s.user?.role);
  const dayBounds = useMemo(() => getLocalDayBounds(), []);

  const [companyId, setCompanyId] = useState<string>(ALL);
  const [shopId, setShopId] = useState<string>(ALL);

  const companies = useQuery<Company[]>({
    queryKey: ['dashboard-companies'],
    queryFn: () => api.get('/companies').then((r) => r.data),
  });

  // A single-company scope (e.g. company_manager, or a one-company tenant) drills to shops directly.
  const effectiveCompanyId = useMemo(() => {
    if (companyId !== ALL) return companyId;
    if (companies.data && companies.data.length === 1) return companies.data[0].id;
    return undefined;
  }, [companyId, companies.data]);

  const shops = useQuery<Shop[]>({
    queryKey: ['dashboard-shops', effectiveCompanyId ?? ALL],
    queryFn: () =>
      api
        .get('/shops', { params: effectiveCompanyId ? { companyId: effectiveCompanyId } : undefined })
        .then((r) => r.data),
  });

  // Reset shop selection whenever the company scope changes.
  useEffect(() => {
    setShopId(ALL);
  }, [companyId]);

  const statsParams = useMemo(
    () => ({
      ...dayBounds,
      companyId: effectiveCompanyId,
      shopId: shopId !== ALL ? shopId : undefined,
    }),
    [dayBounds, effectiveCompanyId, shopId],
  );

  const stats = useQuery({
    queryKey: ['dashboard-stats', statsParams],
    queryFn: () => fetchDashboardStats(statsParams),
    placeholderData: keepPreviousData,
    refetchInterval: POLL_MS,
    refetchOnWindowFocus: true,
  });

  // Breakdown: by company at the top level, by shop once a company is in scope.
  // Hidden entirely when a single shop is selected (the KPIs already represent it).
  const breakdownMode: 'company' | 'shop' | null = useMemo(() => {
    if (shopId !== ALL) return null;
    if (effectiveCompanyId) return 'shop';
    return 'company';
  }, [shopId, effectiveCompanyId]);

  const breakdown = useQuery({
    queryKey: ['dashboard-breakdown', dayBounds, breakdownMode, effectiveCompanyId ?? ALL],
    queryFn: () =>
      fetchDashboardBreakdown({
        ...dayBounds,
        companyId: breakdownMode === 'shop' ? effectiveCompanyId : undefined,
      }),
    enabled: breakdownMode !== null,
    placeholderData: keepPreviousData,
    refetchInterval: POLL_MS,
    refetchOnWindowFocus: true,
  });

  const showCompanySelect = (companies.data?.length ?? 0) > 1;
  const showShopSelect = !!effectiveCompanyId && (shops.data?.length ?? 0) > 1;

  const paymentChartData = useMemo(() => {
    if (!stats.data) return [];
    return [
      { name: t('cash'), value: stats.data.paymentCash },
      { name: t('card'), value: stats.data.paymentCard },
    ].filter((row) => row.value > 0);
  }, [stats.data, t]);

  const breakdownRows = breakdown.data?.rows ?? [];
  const breakdownInitialLoad = breakdown.isPending && breakdownRows.length === 0;

  const handleBarClick = (row: DashboardBreakdownRow) => {
    if (breakdownMode === 'company') {
      setCompanyId(row.id);
    } else if (breakdownMode === 'shop') {
      setShopId(row.id);
    }
  };

  if (stats.isError) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
        {t('loadError')}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold">{t('title')}</h2>
          <Badge variant="secondary" className="text-xs">
            {t('live')}
          </Badge>
        </div>

        <div className="flex flex-wrap items-end gap-3 ms-auto">
          {showCompanySelect ? (
            <div className="space-y-1">
              <Label className="text-xs">{t('company')}</Label>
              <Select
                value={companyId}
                onValueChange={(v) => setCompanyId((v as string) ?? ALL)}
                items={[{ value: ALL, label: t('allCompanies') }, ...entitySelectItems(companies.data ?? [])]}
              >
                <SelectTrigger size="sm" className="min-w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>{t('allCompanies')}</SelectItem>
                  {(companies.data ?? []).map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}

          {showShopSelect ? (
            <div className="space-y-1">
              <Label className="text-xs">{t('shop')}</Label>
              <Select
                value={shopId}
                onValueChange={(v) => setShopId((v as string) ?? ALL)}
                items={[{ value: ALL, label: t('allShops') }, ...entitySelectItems(shops.data ?? [])]}
              >
                <SelectTrigger size="sm" className="min-w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>{t('allShops')}</SelectItem>
                  {(shops.data ?? []).map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
        </div>
      </div>

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
                {breakdownRows.length > 0 ? (
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
                        cursor="pointer"
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
                      {paymentChartData.map((_, index) => (
                        <Cell key={index} fill={CHART_COLORS[index % CHART_COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip
                      formatter={(value) => formatCurrency(typeof value === 'number' ? value : Number(value ?? 0))}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>
        ) : null}
      </div>
    </div>
  );
}
