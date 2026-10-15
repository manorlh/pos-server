'use client';

/**
 * "סיכום יום" v2 on the dashboard (P:\specs\reports-designed-pdf.md §3, §7.3): the same parts,
 * in the same order, as the PDF the server draws — the KPI cards against the same weekday last
 * week and the 4-week average, the day's insights, the hours against last week, then the
 * tables: shop → point of sale → till, payments, departments and items (what rose, what fell),
 * tables, staff, risks and kiosks. Each table is a `ReportTableSpec`, so the reader's columns
 * and the export's are the same.
 */
import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import {
  AlertTriangle,
  Banknote,
  Clock,
  CreditCard,
  Gift,
  Lightbulb,
  Monitor,
  Package,
  Percent,
  Receipt,
  RotateCcw,
  ShoppingBasket,
  Star,
  Trophy,
  TrendingDown,
  TrendingUp,
  Users,
  UtensilsCrossed,
  Wallet,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import { formatCurrency, formatQuantity, formatShortDateTime } from '@/lib/format';
import {
  activeHours,
  changeTone,
  hierarchyDepths,
  hierarchyExportRows,
  shareValue,
  type DayDepartment,
  type DayHierarchyRow,
  type DayItem,
  type DayKioskRow,
  type DayKpi,
  type DayMover,
  type DayOpenTable,
  type DayPaymentMethod,
  type DayRiskByEmployee,
  type DayStaff,
  type DaySummaryV2,
} from '@/lib/daySummaryV2';
import type { ReportInsight } from '@/lib/designedReport';
import type { ReportColumn, ReportTableSpec } from '@/components/dashboard/report-framework';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

/** The day's tables, keyed by their export id. */
export interface DayTables {
  hierarchy: ReportTableSpec<DayHierarchyRow>;
  payments: ReportTableSpec<DayPaymentMethod>;
  departments: ReportTableSpec<DayDepartment>;
  items: ReportTableSpec<DayItem>;
  movers: ReportTableSpec<DayMover & { direction: 'up' | 'down' }>;
  staff: ReportTableSpec<DayStaff>;
  risks: ReportTableSpec<DayRiskByEmployee>;
  openTables: ReportTableSpec<DayOpenTable>;
  kiosks: ReportTableSpec<DayKioskRow>;
}

const ICONS: Record<string, LucideIcon> = {
  sales: Wallet,
  receipt: Receipt,
  basket: ShoppingBasket,
  items: Package,
  users: Users,
  user: Users,
  refund: RotateCcw,
  void: XCircle,
  discount: Percent,
  gift: Gift,
  tip: Banknote,
  clock: Clock,
  card: CreditCard,
  cash: Banknote,
  table: UtensilsCrossed,
  alert: AlertTriangle,
  star: Star,
  kiosk: Monitor,
  percent: Percent,
};

/** A KPI's value as the card writes it. */
export function formatKpi(kind: DayKpi['kind'], value: number | string | null): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  switch (kind) {
    case 'money':
      return formatCurrency(value);
    case 'percent':
      return `${value.toLocaleString('he-IL', { maximumFractionDigits: 1 })}%`;
    case 'duration': {
      const minutes = Math.round(value / 60);
      return minutes >= 60 ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}` : `${minutes}′`;
    }
    default:
      return formatQuantity(value);
  }
}

/** ▲ 12.3% in green / ▼ in red — the arrow says it without colour too (§5). */
export function ChangeTag({ pct, better, label }: { pct: number | null | undefined; better?: 'up' | 'down'; label?: string }) {
  const tone = changeTone(pct, better ?? 'up');
  if (tone.good === null) {
    return <span className="text-muted-foreground text-xs tabular-nums">{label ? `${label} —` : '—'}</span>;
  }
  return (
    <span
      className={cn(
        'inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-xs font-medium tabular-nums',
        tone.good ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' : 'bg-red-500/10 text-red-700 dark:text-red-400',
      )}
    >
      {label ? <span className="font-normal opacity-80">{label}</span> : null}
      <span aria-hidden>{tone.arrow}</span>
      {Math.abs(pct!).toLocaleString('he-IL', { maximumFractionDigits: 1 })}%
    </span>
  );
}

/** The last 7 days as a line; the day itself is the last point. */
function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const w = 72;
  const h = 22;
  const points = values.map((v, i) => `${((i / (values.length - 1)) * w).toFixed(1)},${(h - ((v - min) / span) * h).toFixed(1)}`);
  const last = points[points.length - 1].split(',');
  return (
    <svg width={w} height={h} viewBox={`-2 -2 ${w + 4} ${h + 4}`} aria-hidden className="text-primary overflow-visible">
      <polyline points={points.join(' ')} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" />
      <circle cx={last[0]} cy={last[1]} r={2.5} fill="currentColor" />
    </svg>
  );
}

export function DayKpiGrid({ kpis }: { kpis: DayKpi[] }) {
  const t = useTranslations('daySummary.v2');
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {kpis.map((k, i) => {
        const Icon = (k.icon && ICONS[k.icon]) || Wallet;
        return (
          <Card key={k.key} className={cn('relative overflow-hidden', i === 0 && 'ring-primary/40 ring-2')}>
            {/* The narrow colour band of the PDF's cards (§5). */}
            <span aria-hidden className="bg-primary absolute inset-y-0 start-0 w-1" />
            <CardHeader className="flex flex-row items-center justify-between pb-1">
              <CardTitle className="text-muted-foreground text-sm font-medium">{k.label}</CardTitle>
              <Icon className="text-muted-foreground h-4 w-4" aria-hidden />
            </CardHeader>
            <CardContent className="space-y-1.5">
              <div className="flex items-end justify-between gap-2">
                <p className={cn('font-bold tabular-nums', i === 0 ? 'text-3xl' : 'text-2xl')}>
                  {formatKpi(k.kind, k.value)}
                  {k.count !== undefined && k.count !== null ? (
                    <span className="text-muted-foreground ms-1 text-xs font-normal">{t('count', { count: k.count })}</span>
                  ) : null}
                </p>
                {k.spark?.length ? <Sparkline values={k.spark} /> : null}
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <ChangeTag pct={k.changePct} better={k.better} label={t('vsLastWeek')} />
                <ChangeTag pct={k.changePctAvg} better={k.better} label={t('vsAvg4w')} />
              </div>
              {k.lastWeek !== null || k.avg4w !== null ? (
                <p className="text-muted-foreground text-xs">
                  {t('compareValues', { lastWeek: formatKpi(k.kind, k.lastWeek), avg: formatKpi(k.kind, k.avg4w) })}
                </p>
              ) : null}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

const INSIGHT_LOOK: Record<string, { icon: LucideIcon; className: string }> = {
  leader: { icon: Trophy, className: 'bg-amber-500/10 text-amber-900 dark:text-amber-200' },
  up: { icon: TrendingUp, className: 'bg-emerald-500/10 text-emerald-900 dark:text-emerald-200' },
  down: { icon: TrendingDown, className: 'bg-red-500/10 text-red-900 dark:text-red-200' },
  alert: { icon: AlertTriangle, className: 'bg-orange-500/10 text-orange-900 dark:text-orange-200' },
  tip: { icon: Lightbulb, className: 'bg-sky-500/10 text-sky-900 dark:text-sky-200' },
};

/** The day's insights as the PDF shows them: small cards, an icon per type (§5). None: nothing. */
export function DayInsights({ insights, title }: { insights: ReportInsight[]; title?: string }) {
  const t = useTranslations('daySummary.v2');
  if (!insights.length) return null;
  return (
    <section aria-labelledby="ds-insights" className="space-y-2">
      <h2 id="ds-insights" className="text-lg font-semibold">
        {title ?? t('insights')}
      </h2>
      <ul className="grid gap-2 md:grid-cols-2">
        {insights.map((i, n) => {
          const look = INSIGHT_LOOK[i.type] ?? INSIGHT_LOOK.tip;
          const Icon = look.icon;
          return (
            <li key={n} className={cn('flex items-start gap-2 rounded-lg px-3 py-2 text-sm', look.className)}>
              <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span>{i.text}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** The day's sales by the hour against the same weekday last week. */
export function DayHourlyChart({ data }: { data: DaySummaryV2 }) {
  const t = useTranslations('daySummary.v2');
  const hours = activeHours(data.hourly);
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{t('hourly')}</CardTitle>
        <p className="text-muted-foreground text-xs">{t('hourlyHint', { lastWeek: data.compare.lastWeek })}</p>
      </CardHeader>
      <CardContent>
        {hours.length === 0 ? (
          <p className="text-muted-foreground py-10 text-center text-sm">{t('noSales')}</p>
        ) : (
          <div className="h-56 md:h-64" dir="ltr">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={hours} margin={{ top: 8, right: 4, bottom: 0, left: 4 }} barGap={2}>
                <CartesianGrid vertical={false} stroke="var(--border)" />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} interval="preserveStartEnd" minTickGap={12} />
                <YAxis
                  orientation="right"
                  tick={{ fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  width={52}
                  tickFormatter={(n: number) => (Math.abs(n) >= 1000 ? `₪${(n / 1000).toLocaleString('he-IL', { maximumFractionDigits: 1 })}K` : `₪${Math.round(n)}`)}
                />
                <Tooltip
                  formatter={(value, name) => [formatCurrency(Number(value)), name === 'net' ? t('today') : t('lastWeek')]}
                  labelFormatter={(label) => String(label)}
                />
                <Bar dataKey="lastWeekNet" name="lastWeekNet" fill="var(--muted-foreground)" fillOpacity={0.35} radius={[3, 3, 0, 0]} maxBarSize={18} isAnimationActive={false} />
                <Bar dataKey="net" name="net" fill="var(--primary)" radius={[3, 3, 0, 0]} maxBarSize={18} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
        <div className="text-muted-foreground mt-2 flex flex-wrap gap-4 text-xs">
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="bg-primary h-2.5 w-2.5 rounded-sm" />
            {t('today')}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="bg-muted-foreground/35 h-2.5 w-2.5 rounded-sm" />
            {t('lastWeek')}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

/** A trend cell: the change with its arrow (the table's "מגמה"). */
function trendCell(pct: number | null, better: 'up' | 'down' = 'up') {
  return <ChangeTag pct={pct} better={better} />;
}

/** The share with a small bar (§5 "פס התקדמות קטן בעמודת ה-%"). */
function shareCell(share: number) {
  const v = Math.max(0, Math.min(100, share));
  return (
    <span className="inline-flex items-center gap-2 tabular-nums">
      <span aria-hidden className="bg-muted relative h-1.5 w-12 overflow-hidden rounded-full">
        <span className="bg-primary absolute inset-y-0 start-0 rounded-full" style={{ width: `${v}%` }} />
      </span>
      {share.toLocaleString('he-IL', { maximumFractionDigits: 1 })}%
    </span>
  );
}

/** Every table of the day, as report tables (screen, Excel, CSV and the PDF's columns). */
export function useDayTables(data: DaySummaryV2 | undefined): DayTables | null {
  const t = useTranslations('daySummary.v2');
  return useMemo(() => {
    if (!data) return null;
    const total = t('total');
    const depths = hierarchyDepths(data.hierarchy);
    const labels = hierarchyExportRows(data.hierarchy);
    const level = (r: DayHierarchyRow) => t(`level.${r.level}`);
    const hierarchy: ReportTableSpec<DayHierarchyRow> = {
      id: 'main',
      title: t('hierarchy'),
      columns: [
        {
          key: 'name',
          header: t('col.place'),
          required: true,
          width: 30,
          value: (r) => labels[data.hierarchy.indexOf(r)]?.label ?? r.name,
          cell: (r) => (
            <span
              className={cn(r.level === 'shop' ? 'font-semibold' : r.level === 'area' ? 'font-medium' : 'text-muted-foreground')}
              style={{ paddingInlineStart: `${(depths[data.hierarchy.indexOf(r)] ?? 0) * 1.25}rem` }}
            >
              {r.name}
            </span>
          ),
        },
        { key: 'level', header: t('col.level'), value: (r) => level(r), defaultHidden: true },
        { key: 'net', header: t('col.net'), kind: 'money', value: (r) => r.net },
        { key: 'share', header: t('col.share'), kind: 'percent', value: (r) => shareValue(r.share), cell: (r) => shareCell(r.share) },
        { key: 'documents', header: t('col.documents'), kind: 'number', value: (r) => r.documents },
        { key: 'averageTicket', header: t('col.averageTicket'), kind: 'money', value: (r) => r.averageTicket },
        { key: 'lastWeekNet', header: t('col.lastWeek'), kind: 'money', value: (r) => r.lastWeekNet, defaultHidden: true },
        { key: 'changePct', header: t('col.change'), kind: 'percent', value: (r) => shareValue(r.changePct), cell: (r) => trendCell(r.changePct) },
      ],
      rows: data.hierarchy,
      rowKey: (r, i) => `${r.level}:${r.id ?? i}`,
      rowClassName: (r) => (r.level === 'shop' ? 'bg-muted/40' : undefined),
      emptyText: t('noSales'),
    };
    const payments: ReportTableSpec<DayPaymentMethod> = {
      id: 'payments',
      title: t('payments'),
      columns: [
        { key: 'method', header: t('col.method'), required: true, value: (r) => r.label },
        { key: 'amount', header: t('col.amount'), kind: 'money', value: (r) => r.amount, totalOf: (rows) => rows.reduce((s, r) => s + r.amount, 0) },
        { key: 'documents', header: t('col.documents'), kind: 'number', value: (r) => r.documents },
        { key: 'share', header: t('col.share'), kind: 'percent', value: (r) => shareValue(r.share), cell: (r) => shareCell(r.share) },
      ],
      rows: data.paymentMethods,
      rowKey: (r) => r.method,
      totalsLabel: total,
      emptyText: t('noSales'),
    };
    const departments: ReportTableSpec<DayDepartment> = {
      id: 'departments',
      title: t('departments'),
      columns: [
        { key: 'name', header: t('col.department'), required: true, value: (r) => r.name },
        { key: 'units', header: t('col.units'), kind: 'number', value: (r) => r.units },
        { key: 'net', header: t('col.net'), kind: 'money', value: (r) => r.net },
        { key: 'share', header: t('col.share'), kind: 'percent', value: (r) => shareValue(r.share), cell: (r) => shareCell(r.share) },
        { key: 'lastWeekNet', header: t('col.lastWeek'), kind: 'money', value: (r) => r.lastWeekNet, defaultHidden: true },
        { key: 'changePct', header: t('col.trend'), kind: 'percent', value: (r) => shareValue(r.changePct), cell: (r) => trendCell(r.changePct) },
      ],
      rows: data.departments,
      rowKey: (r, i) => r.id ?? `none-${i}`,
      emptyText: t('noSales'),
    };
    const items: ReportTableSpec<DayItem> = {
      id: 'items',
      title: t('topItems'),
      columns: [
        { key: 'name', header: t('col.item'), required: true, value: (r) => r.name },
        { key: 'units', header: t('col.units'), kind: 'number', value: (r) => r.units },
        { key: 'net', header: t('col.net'), kind: 'money', value: (r) => r.net },
        { key: 'share', header: t('col.share'), kind: 'percent', value: (r) => shareValue(r.share), cell: (r) => shareCell(r.share) },
        { key: 'lastWeekNet', header: t('col.lastWeek'), kind: 'money', value: (r) => r.lastWeekNet, defaultHidden: true },
        { key: 'changePct', header: t('col.trend'), kind: 'percent', value: (r) => shareValue(r.changePct), cell: (r) => trendCell(r.changePct) },
      ],
      rows: data.topItems,
      rowKey: (r, i) => r.productId ?? `item-${i}`,
      emptyText: t('noSales'),
    };
    const moverRows = [
      ...data.risers.map((m) => ({ ...m, direction: 'up' as const })),
      ...data.fallers.map((m) => ({ ...m, direction: 'down' as const })),
    ];
    const movers: ReportTableSpec<DayMover & { direction: 'up' | 'down' }> = {
      id: 'movers',
      title: t('movers'),
      columns: [
        { key: 'direction', header: t('col.direction'), value: (r) => (r.direction === 'up' ? t('rose') : t('fell')), cell: (r) => (r.direction === 'up' ? `▲ ${t('rose')}` : `▼ ${t('fell')}`) },
        { key: 'name', header: t('col.item'), required: true, value: (r) => r.name },
        { key: 'net', header: t('col.net'), kind: 'money', value: (r) => r.net },
        { key: 'lastWeekNet', header: t('col.lastWeek'), kind: 'money', value: (r) => r.lastWeekNet },
        { key: 'change', header: t('col.changeAmount'), kind: 'money', value: (r) => r.change },
        { key: 'changePct', header: t('col.change'), kind: 'percent', value: (r) => shareValue(r.changePct), cell: (r) => trendCell(r.changePct) },
      ],
      rows: moverRows,
      rowKey: (r, i) => `${r.direction}:${r.productId ?? i}`,
      emptyText: t('noMovers'),
    };
    const staff: ReportTableSpec<DayStaff> = {
      id: 'staff',
      title: t('staff'),
      columns: [
        { key: 'name', header: t('col.employee'), required: true, value: (r) => r.name },
        { key: 'net', header: t('col.net'), kind: 'money', value: (r) => r.net },
        { key: 'documents', header: t('col.documents'), kind: 'number', value: (r) => r.documents },
        { key: 'averageTicket', header: t('col.averageTicket'), kind: 'money', value: (r) => r.averageTicket },
        { key: 'tips', header: t('col.tips'), kind: 'money', value: (r) => r.tips },
        { key: 'hours', header: t('col.hours'), kind: 'number', value: (r) => r.hours, cell: (r) => (r.hours === null ? '—' : formatQuantity(r.hours)) },
      ],
      rows: data.staff,
      rowKey: (r, i) => r.cashierId ?? `staff-${i}`,
      emptyText: t('noStaff'),
    };
    const riskRow = (pick: (r: DayRiskByEmployee) => number): Pick<ReportColumn<DayRiskByEmployee>, 'totalOf'> => ({
      totalOf: (rows) => rows.reduce((s, r) => s + pick(r), 0),
    });
    const risks: ReportTableSpec<DayRiskByEmployee> = {
      id: 'risks',
      title: t('risksByEmployee'),
      columns: [
        { key: 'name', header: t('col.employee'), required: true, value: (r) => r.name },
        { key: 'refunds', header: t('col.refunds'), kind: 'money', value: (r) => r.refunds, ...riskRow((r) => r.refunds) },
        { key: 'refundsCount', header: t('col.refundsCount'), kind: 'number', value: (r) => r.refundsCount, ...riskRow((r) => r.refundsCount) },
        { key: 'voids', header: t('col.voids'), kind: 'money', value: (r) => r.voids, ...riskRow((r) => r.voids) },
        { key: 'voidsCount', header: t('col.voidsCount'), kind: 'number', value: (r) => r.voidsCount, ...riskRow((r) => r.voidsCount) },
        { key: 'tableCancels', header: t('col.tableCancels'), kind: 'number', value: (r) => r.tableCancels, ...riskRow((r) => r.tableCancels) },
        { key: 'discounts', header: t('col.discounts'), kind: 'money', value: (r) => r.discounts, ...riskRow((r) => r.discounts) },
        { key: 'oth', header: t('col.oth'), kind: 'money', value: (r) => r.oth, ...riskRow((r) => r.oth) },
        { key: 'drawerOpens', header: t('col.drawerOpens'), kind: 'number', value: (r) => r.drawerOpens, ...riskRow((r) => r.drawerOpens) },
      ],
      rows: data.risks?.byEmployee ?? [],
      rowKey: (r, i) => `${r.name}:${i}`,
      totalsLabel: total,
      emptyText: t('noRisks'),
    };
    const openTables: ReportTableSpec<DayOpenTable> = {
      id: 'open-tables',
      title: t('openTables'),
      columns: [
        { key: 'name', header: t('col.table'), required: true, value: (r) => r.name },
        { key: 'openedAt', header: t('col.openedAt'), kind: 'datetime', value: (r) => r.openedAt, cell: (r) => (r.openedAt ? formatShortDateTime(r.openedAt) : '—') },
        { key: 'total', header: t('col.total'), kind: 'money', value: (r) => r.total },
        { key: 'guests', header: t('col.guests'), kind: 'number', value: (r) => r.guests },
        { key: 'waiter', header: t('col.waiter'), value: (r) => r.waiter ?? '' },
      ],
      rows: data.tables?.open ?? [],
      rowKey: (r, i) => `${r.name}:${i}`,
      emptyText: t('noOpenTables'),
      noExport: !data.tables,
    };
    const kiosks: ReportTableSpec<DayKioskRow> = {
      id: 'kiosks',
      title: t('kiosks'),
      columns: [
        { key: 'name', header: t('col.kiosk'), required: true, value: (r) => r.name },
        { key: 'net', header: t('col.net'), kind: 'money', value: (r) => r.net },
        { key: 'documents', header: t('col.orders'), kind: 'number', value: (r) => r.documents },
      ],
      rows: data.kiosks?.byKiosk ?? [],
      rowKey: (r) => r.machineId,
      noExport: !data.kiosks,
    };
    return { hierarchy, payments, departments, items, movers, staff, risks, openTables, kiosks };
  }, [data, t]);
}

/** A labelled figure in a section's header row. */
export function Fact({ label, value, tone }: { label: string; value: string; tone?: 'warn' }) {
  return (
    <div className={cn('rounded-lg border px-3 py-2', tone === 'warn' && 'border-orange-500/40 bg-orange-500/5')}>
      <p className="text-muted-foreground text-xs">{label}</p>
      <p className="text-lg font-semibold tabular-nums">{value}</p>
    </div>
  );
}
