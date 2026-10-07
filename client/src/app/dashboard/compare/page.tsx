'use client';

/**
 * Control board with comparisons (לוח בקרה): what the chosen scope sold on one day against
 * another — today against yesterday, against the same weekday last week, Saturday against
 * the Saturday before, or any two days picked by hand.
 *
 * Laid out the iOS way (Stocks / Health / Settings): a large title, a grouped grey
 * background with white rounded cards, the system colours, segmented controls and a
 * switch, inset lists instead of tables; follows the system's dark mode.
 *
 * Scope: the whole organization, a company, a shop, a point of sale or one till. For
 * each of the two days, side by side: the headline figures with the change, the day by
 * the hour, the split under the scope, the tenders and the best-selling items. All from
 * existing reports — `GET /reports/overview`, `/reports/hourly`, `/reports/live-items` —
 * fetched once per day; refreshed by hand or every minute.
 */

import { useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useQueries } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { he } from 'date-fns/locale';
import { ChevronDown, ChevronUp, RefreshCw } from 'lucide-react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { fetchCashierSalesReport, fetchLiveItems, fetchOverview } from '@/lib/api';
import { fetchCardBrandsReport, fetchHourlyReport, type CardBrandsReport } from '@/lib/salesReportsApi';
import { HEBREW_WEEKDAYS, formatCurrency, formatShortDate, zonedParts } from '@/lib/format';
import { DatePicker } from '@/components/ui/date-picker';
import type { CashierSalesReport, LiveItemsReport, OverviewReport, OverviewSales } from '@/lib/types';
import { cn } from '@/lib/utils';
import { ALL_COMPANIES, EMPTY_ORG_SCOPE, type OrgScope } from '@/components/dashboard/org-scope-cascade';
import { ScopePicker, useOrgScopeLabel } from '@/components/dashboard/live/scope-picker';
import { OpenTablesWidget } from '@/components/dashboard/insights/open-tables-widget';
import { ReportExportToolbar } from '@/components/dashboard/report-export-toolbar';
import type { ExcelSheet } from '@/lib/excelExport';

const AUTO_REFRESH_MS = 60_000;

// iOS system colours.
const IOS = {
  blue: '#007AFF',
  orange: '#FF9500',
  green: '#34C759',
  red: '#FF3B30',
  purple: '#AF52DE',
  teal: '#30B0C7',
  indigo: '#5856D6',
  pink: '#FF2D55',
};
const COLOR_A = IOS.blue; // the day being looked at
const COLOR_B = IOS.orange; // the day it is compared with

const BRAND_NAMES: Record<string, string> = {
  visa: 'ויזה',
  mastercard: 'מאסטרקארד',
  amex: 'אמקס',
  diners: 'דיינרס',
  isracard: 'ישראכרט',
  jcb: 'JCB',
  discover: 'דיסקבר',
  maestro: 'מאסטרו',
  other: 'אשראי — אחר',
};

const SF_FONT ='-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Segoe UI", Rubik, Arial, sans-serif';

type Mode = 'yesterday' | 'lastWeek' | 'saturdays' | 'custom';
const MODES: { id: Mode; label: string }[] = [
  { id: 'yesterday', label: 'מול אתמול' },
  { id: 'lastWeek', label: 'מול שבוע שעבר' },
  { id: 'saturdays', label: 'שבת מול שבת' },
  { id: 'custom', label: 'מותאם' },
];

function iso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function shift(d: Date, days: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + days);
  return out;
}

/** The two days a mode compares: [A, B]. */
function daysFor(mode: Mode, customA: string, customB: string): [string, string] {
  const today = new Date();
  if (mode === 'yesterday') return [iso(today), iso(shift(today, -1))];
  if (mode === 'lastWeek') return [iso(today), iso(shift(today, -7))];
  if (mode === 'saturdays') {
    // The most recent Saturday (today, if it is one) and the one before it.
    const back = (today.getDay() - 6 + 7) % 7;
    const sat = shift(today, -back);
    return [iso(sat), iso(shift(sat, -7))];
  }
  return [customA, customB];
}

function dayLabel(day: string): string {
  const p = zonedParts(day);
  return p ? `${HEBREW_WEEKDAYS[p.weekday]} ${formatShortDate(day)}` : formatShortDate(day);
}

function change(a: number, b: number): number | null {
  if (b === 0) return a === 0 ? 0 : null;
  return ((a - b) / Math.abs(b)) * 100;
}

/** iOS Stocks style: a coloured ▲/▼ and the percentage. */
function Delta({ a, b, pill = false }: { a: number; b: number; pill?: boolean }) {
  const pct = change(a, b);
  const up = a > b;
  const same = a === b;
  const color = same ? '#8E8E93' : up ? IOS.green : IOS.red;
  const text = pct === null ? 'חדש' : `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`;
  if (pill) {
    return (
      <span
        className="inline-flex min-w-16 items-center justify-center gap-0.5 rounded-md px-2 py-1 text-[13px] font-semibold tabular-nums text-white"
        style={{ backgroundColor: color }}
        dir="ltr"
      >
        {text}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-0.5 text-[13px] font-semibold tabular-nums" style={{ color }} dir="ltr">
      {same ? null : up ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
      {text}
    </span>
  );
}

interface Node {
  id: string;
  name: string;
  sales: OverviewSales;
}

const ZERO_SALES: OverviewSales = {
  salesToday: 0, gross: 0, discounts: 0, refunds: 0, documentsToday: 0,
  salesCount: 0, refundsCount: 0, cash: 0, card: 0, other: 0, tips: 0,
};

/** The scope's own figures and the rows one level under it, from one day's overview. */
function scopeView(report: OverviewReport | undefined, scope: OrgScope): { total: OverviewSales; level: string; rows: Node[] } {
  if (!report) return { total: ZERO_SALES, level: '', rows: [] };
  const companies = report.companies;
  const shops = companies.flatMap((c) => c.shops);
  if (scope.machineId) {
    const m = shops.flatMap((s) => s.machines).find((x) => x.id === scope.machineId);
    return { total: m ?? ZERO_SALES, level: 'קופה', rows: m ? [{ id: m.id, name: m.name, sales: m }] : [] };
  }
  if (scope.areaId) {
    const shop = shops.find((s) => s.id === scope.shopId) ?? shops[0];
    const area = shop?.areas?.find((a) => a.id === scope.areaId);
    const rows = (shop?.machines ?? [])
      .filter((m) => area?.machineIds.includes(m.id))
      .map((m) => ({ id: m.id, name: m.posNumber ? `#${m.posNumber} · ${m.name}` : m.name, sales: m as OverviewSales }));
    return { total: area ?? ZERO_SALES, level: 'קופות בנקודת המכירה', rows };
  }
  if (scope.shopId) {
    const shop = shops.find((s) => s.id === scope.shopId);
    if (!shop) return { total: ZERO_SALES, level: '', rows: [] };
    const areas = shop.areas ?? [];
    const rows = areas.length
      ? areas.map((a) => ({ id: a.id, name: a.name, sales: a as OverviewSales }))
      : shop.machines.map((m) => ({ id: m.id, name: m.posNumber ? `#${m.posNumber} · ${m.name}` : m.name, sales: m as OverviewSales }));
    return { total: shop, level: areas.length ? 'נקודות מכירה' : 'קופות', rows };
  }
  if (scope.companyId && scope.companyId !== ALL_COMPANIES) {
    return {
      total: report.kpis,
      level: 'סניפים',
      rows: shops.map((s) => ({ id: s.id, name: s.number ? `#${s.number} · ${s.name}` : s.name, sales: s as OverviewSales })),
    };
  }
  return {
    total: report.kpis,
    level: companies.length > 1 ? 'חברות' : 'סניפים',
    rows:
      companies.length > 1
        ? companies.map((c) => ({ id: c.id, name: c.name, sales: c as OverviewSales }))
        : shops.map((s) => ({ id: s.id, name: s.name, sales: s as OverviewSales })),
  };
}

function avgTicket(s: OverviewSales): number {
  return s.salesCount > 0 ? (s.gross - s.discounts) / s.salesCount : 0;
}

/** An iOS card: white, very round, a hairline and a soft shadow; #1C1C1E in the dark. */
function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'rounded-[22px] bg-white p-4 shadow-[0_1px_2px_rgba(0,0,0,0.04),0_4px_16px_rgba(0,0,0,0.04)] dark:bg-[#1C1C1E] dark:shadow-none',
        className,
      )}
    >
      {children}
    </div>
  );
}

/** A grouped section's header, as in iOS Settings: small, grey, above the card. */
function SectionHeader({ children, trailing }: { children: React.ReactNode; trailing?: React.ReactNode }) {
  return (
    <div className="mb-1.5 mt-2 flex items-end justify-between px-4">
      <h2 className="text-[13px] font-normal uppercase tracking-wide text-[#6D6D72] dark:text-[#8E8E93]">{children}</h2>
      {trailing}
    </div>
  );
}

/** iOS segmented control: a grey track and a white thumb on the chosen segment. */
function Segmented<T extends string>({
  value,
  options,
  onChange,
  className,
}: {
  value: T;
  options: { id: T; label: string }[];
  onChange: (v: T) => void;
  className?: string;
}) {
  return (
    <div className={cn('flex rounded-[9px] bg-[#7676801F] p-[2px] dark:bg-[#7676803D]', className)} role="tablist">
      {options.map((o) => {
        const on = o.id === value;
        return (
          <button
            key={o.id}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onChange(o.id)}
            className={cn(
              'min-h-8 flex-1 whitespace-nowrap rounded-[7px] px-3 text-[13px] transition-all',
              on
                ? 'bg-white font-semibold text-black shadow-[0_3px_8px_rgba(0,0,0,0.12),0_3px_1px_rgba(0,0,0,0.04)] dark:bg-[#636366] dark:text-white'
                : 'font-medium text-black/80 dark:text-white/80',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** iOS switch. */
function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative h-[31px] w-[51px] shrink-0 rounded-full transition-colors',
        checked ? 'bg-[#34C759]' : 'bg-[#78788029] dark:bg-[#78788052]',
      )}
    >
      <span
        className={cn(
          'absolute top-[2px] h-[27px] w-[27px] rounded-full bg-white shadow-[0_3px_8px_rgba(0,0,0,0.15),0_3px_1px_rgba(0,0,0,0.06)] transition-all',
          checked ? 'right-[2px]' : 'right-[22px]',
        )}
      />
    </button>
  );
}

/** A widget like iOS's: a coloured label on top, the figure large, the comparison under it. */
function Widget({
  title, color, a, b, format,
}: {
  title: string;
  color: string;
  a: number;
  b: number;
  format: (n: number) => string;
}) {
  return (
    <Card className="flex flex-col gap-1">
      <span className="flex items-center gap-1.5 text-[13px] font-semibold" style={{ color }}>
        <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
        {title}
      </span>
      <span className="text-[28px] font-bold leading-tight tracking-tight tabular-nums text-black dark:text-white">{format(a)}</span>
      <span className="flex flex-wrap items-center gap-2 text-[13px] text-[#8E8E93]">
        <span className="tabular-nums">מול {format(b)}</span>
        <Delta a={a} b={b} />
      </span>
    </Card>
  );
}

/**
 * One of three figures in a card: the value, its label, and the change. [invert] for
 * figures where less is better (discounts, refunds): a rise shows red.
 */
function Trio({
  label, a, b, format, invert = false,
}: {
  label: string;
  a: number;
  b: number;
  format: (n: number) => string;
  invert?: boolean;
}) {
  const pct = change(a, b);
  const better = invert ? a < b : a > b;
  const color = a === b ? '#8E8E93' : better ? IOS.green : IOS.red;
  return (
    <div className="flex flex-col items-center gap-0.5 px-2 text-center">
      <span className="text-[20px] font-bold tabular-nums">{format(a)}</span>
      <span className="text-[13px] text-[#8E8E93]">{label}</span>
      <span className="text-[12px] font-semibold tabular-nums" style={{ color }} dir="ltr">
        {pct === null ? 'חדש' : `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`}
      </span>
    </div>
  );
}

/** Two thin capsules, A over B, as iOS Screen Time draws its bars. */
function Capsules({ a, b, max }: { a: number; b: number; max: number }) {
  return (
    <div className="mt-1.5 space-y-1">
      <div className="h-[6px] rounded-full bg-[#7676801F]">
        <div className="h-[6px] rounded-full" style={{ width: `${(a / max) * 100}%`, backgroundColor: COLOR_A }} />
      </div>
      <div className="h-[6px] rounded-full bg-[#7676801F]">
        <div className="h-[6px] rounded-full" style={{ width: `${(b / max) * 100}%`, backgroundColor: COLOR_B }} />
      </div>
    </div>
  );
}

function Legend({ dayA, dayB }: { dayA: string; dayB: string }) {
  return (
    <div className="flex items-center gap-3 text-[12px] text-[#8E8E93]">
      <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ backgroundColor: COLOR_A }} />{dayLabel(dayA)}</span>
      <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ backgroundColor: COLOR_B }} />{dayLabel(dayB)}</span>
    </div>
  );
}

const tooltipStyle = {
  borderRadius: 14,
  border: 'none',
  boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
  fontFamily: SF_FONT,
  fontSize: 13,
};

export default function CompareBoardPage() {
  const [scope, setScope] = useState<OrgScope>({ ...EMPTY_ORG_SCOPE, companyId: ALL_COMPANIES });
  const [mode, setMode] = useState<Mode>('yesterday');
  const [customA, setCustomA] = useState(() => iso(new Date()));
  const [customB, setCustomB] = useState(() => iso(shift(new Date(), -1)));
  const [auto, setAuto] = useState(true);
  const [dayA, dayB] = daysFor(mode, customA, customB);

  const companyId = scope.companyId && scope.companyId !== ALL_COMPANIES ? scope.companyId : undefined;
  const overviewParams = (date: string) => ({
    date,
    companyId: scope.shopId || scope.machineId ? undefined : companyId,
    shopId: scope.machineId ? undefined : scope.shopId || undefined,
    machineId: scope.machineId || undefined,
  });
  const narrowParams = (date: string) => ({
    companyId,
    shopId: scope.shopId || undefined,
    areaId: scope.areaId || undefined,
    machineId: scope.machineId || undefined,
    date,
  });
  const windowParams = (date: string) => ({
    from: date,
    to: date,
    shopId: scope.shopId || undefined,
    areaId: scope.areaId || undefined,
    machineId: scope.machineId || undefined,
  });
  const refetchInterval = auto ? AUTO_REFRESH_MS : (false as const);

  const results = useQueries({
    queries: [
      { queryKey: ['cmp-overview', overviewParams(dayA)], queryFn: () => fetchOverview(overviewParams(dayA)), refetchInterval, placeholderData: keepPreviousData },
      { queryKey: ['cmp-overview', overviewParams(dayB)], queryFn: () => fetchOverview(overviewParams(dayB)), refetchInterval, placeholderData: keepPreviousData },
      {
        queryKey: ['cmp-hourly', dayA, scope],
        queryFn: () => fetchHourlyReport({ from: dayA, to: dayA, shopId: scope.shopId || undefined, machineId: scope.machineId || undefined }),
        refetchInterval,
        placeholderData: keepPreviousData,
      },
      {
        queryKey: ['cmp-hourly', dayB, scope],
        queryFn: () => fetchHourlyReport({ from: dayB, to: dayB, shopId: scope.shopId || undefined, machineId: scope.machineId || undefined }),
        refetchInterval,
        placeholderData: keepPreviousData,
      },
      { queryKey: ['cmp-items', narrowParams(dayA)], queryFn: () => fetchLiveItems({ ...narrowParams(dayA), limit: 200 }), refetchInterval, placeholderData: keepPreviousData },
      { queryKey: ['cmp-items', narrowParams(dayB)], queryFn: () => fetchLiveItems({ ...narrowParams(dayB), limit: 200 }), refetchInterval, placeholderData: keepPreviousData },
      {
        queryKey: ['cmp-brands', dayA, scope],
        queryFn: () => fetchCardBrandsReport({ from: dayA, to: dayA, shopId: scope.shopId || undefined, machineId: scope.machineId || undefined }),
        refetchInterval,
        placeholderData: keepPreviousData,
      },
      {
        queryKey: ['cmp-cashiers', dayA, scope],
        queryFn: () => fetchCashierSalesReport(windowParams(dayA)),
        refetchInterval,
        placeholderData: keepPreviousData,
      },
      {
        queryKey: ['cmp-cashiers', dayB, scope],
        queryFn: () => fetchCashierSalesReport(windowParams(dayB)),
        refetchInterval,
        placeholderData: keepPreviousData,
      },
    ],
  });
  const [ovA, ovB, hrA, hrB, itA, itB, brA, csA, csB] = results;
  const loading = results.some((r) => r.isLoading);
  const fetching = results.some((r) => r.isFetching);
  const updatedAt = Math.max(...results.map((r) => r.dataUpdatedAt || 0));
  const refetchAll = () => results.forEach((r) => void r.refetch());

  const viewA = useMemo(() => scopeView(ovA.data as OverviewReport | undefined, scope), [ovA.data, scope]);
  const viewB = useMemo(() => scopeView(ovB.data as OverviewReport | undefined, scope), [ovB.data, scope]);

  const hourly = useMemo(() => {
    const a = (hrA.data?.byHour ?? []) as { hour: number; net: number }[];
    const b = (hrB.data?.byHour ?? []) as { hour: number; net: number }[];
    const hours = Array.from(new Set([...a, ...b].map((r) => r.hour))).sort((x, y) => x - y);
    const out: { hour: string; a: number; b: number; ca: number; cb: number }[] = [];
    for (const h of hours) {
      const va = a.find((r) => r.hour === h)?.net ?? 0;
      const vb = b.find((r) => r.hour === h)?.net ?? 0;
      const prev = out[out.length - 1];
      out.push({ hour: `${String(h).padStart(2, '0')}:00`, a: va, b: vb, ca: (prev?.ca ?? 0) + va, cb: (prev?.cb ?? 0) + vb });
    }
    return out;
  }, [hrA.data, hrB.data]);
  const [hourView, setHourView] = useState<'cumulative' | 'hourly'>('cumulative');
  const cumulative = hourView === 'cumulative';

  const rows = useMemo(() => {
    const byId = new Map<string, { id: string; name: string; a: number; b: number; docsA: number; docsB: number }>();
    for (const n of viewA.rows) byId.set(n.id, { id: n.id, name: n.name, a: n.sales.salesToday, b: 0, docsA: n.sales.documentsToday, docsB: 0 });
    for (const n of viewB.rows) {
      const r = byId.get(n.id) ?? { id: n.id, name: n.name, a: 0, b: 0, docsA: 0, docsB: 0 };
      r.b = n.sales.salesToday;
      r.docsB = n.sales.documentsToday;
      byId.set(n.id, r);
    }
    return [...byId.values()].sort((x, y) => y.a - x.a || y.b - x.b);
  }, [viewA.rows, viewB.rows]);
  const maxRow = Math.max(1, ...rows.map((r) => Math.max(r.a, r.b)));

  const tenders = [
    { name: 'מזומן', a: viewA.total.cash, b: viewB.total.cash },
    { name: 'אשראי', a: viewA.total.card, b: viewB.total.card },
    { name: 'אחר', a: viewA.total.other, b: viewB.total.other },
  ];

  const items = useMemo(() => {
    const a = (itA.data as LiveItemsReport | undefined)?.rows ?? [];
    const b = (itB.data as LiveItemsReport | undefined)?.rows ?? [];
    const key = (r: { productId?: string | null; name?: string | null }) => r.productId ?? r.name ?? '';
    const map = new Map<string, { name: string; qtyA: number; qtyB: number; netA: number; netB: number }>();
    for (const r of a) map.set(key(r), { name: r.name ?? '—', qtyA: r.qty, qtyB: 0, netA: r.net, netB: 0 });
    for (const r of b) {
      const m = map.get(key(r)) ?? { name: r.name ?? '—', qtyA: 0, qtyB: 0, netA: 0, netB: 0 };
      m.qtyB = r.qty;
      m.netB = r.net;
      map.set(key(r), m);
    }
    return [...map.values()].sort((x, y) => y.netA - x.netA || y.netB - x.netB).slice(0, 15);
  }, [itA.data, itB.data]);

  // Items: how many, per sale and per unit — Nayax's "פריטים" card.
  const itemTotals = (r: LiveItemsReport | undefined, s: OverviewSales) => {
    const qty = r?.totals.qty ?? 0;
    const net = r?.totals.net ?? 0;
    return { qty, perSale: s.salesCount > 0 ? qty / s.salesCount : 0, perUnit: qty > 0 ? net / qty : 0 };
  };
  const itemsA = itemTotals(itA.data as LiveItemsReport | undefined, viewA.total);
  const itemsB = itemTotals(itB.data as LiveItemsReport | undefined, viewB.total);

  // Payment methods as a pie: each card brand, then cash, other and the tips.
  const pie = useMemo(() => {
    const brands = (brA.data as CardBrandsReport | undefined)?.byBrand ?? [];
    const slices: { name: string; value: number; color: string }[] = [];
    const palette = [IOS.blue, IOS.teal, IOS.indigo, IOS.purple, IOS.pink, '#5AC8FA', '#A2845E'];
    let cardsNamed = 0;
    brands.filter((b) => b.net > 0).forEach((b, i) => {
      slices.push({ name: BRAND_NAMES[b.key] ?? b.key, value: b.net, color: palette[i % palette.length] });
      cardsNamed += b.net;
    });
    const cardRest = viewA.total.card - cardsNamed;
    if (cardRest > 0.5) slices.push({ name: 'אשראי — אחר', value: cardRest, color: '#8E8E93' });
    if (viewA.total.cash > 0) slices.push({ name: 'מזומן', value: viewA.total.cash, color: IOS.green });
    if (viewA.total.other > 0) slices.push({ name: 'שוברים ואחר', value: viewA.total.other, color: IOS.orange });
    return slices;
  }, [brA.data, viewA.total]);
  const pieTotal = pie.reduce((s, x) => s + x.value, 0);

  // Sellers (מוכרנים): net, average basket and documents, day against day.
  const sellers = useMemo(() => {
    const a = (csA.data as CashierSalesReport | undefined)?.rows ?? [];
    const b = (csB.data as CashierSalesReport | undefined)?.rows ?? [];
    const key = (r: { cashierId?: string | null; cashierName?: string | null }) => r.cashierId ?? r.cashierName ?? '—';
    const map = new Map<string, { name: string; netA: number; netB: number; avgA: number; docsA: number }>();
    for (const r of a) map.set(key(r), { name: r.cashierName ?? 'ללא שם', netA: r.net, netB: 0, avgA: r.averageBasket, docsA: r.documentCount });
    for (const r of b) {
      const m = map.get(key(r)) ?? { name: r.cashierName ?? 'ללא שם', netA: 0, netB: 0, avgA: 0, docsA: 0 };
      m.netB = r.net;
      map.set(key(r), m);
    }
    return [...map.values()].sort((x, y) => y.netA - x.netA);
  }, [csA.data, csB.data]);
  const maxSeller = Math.max(1, ...sellers.map((s) => Math.max(s.netA, s.netB)));
  const maxItem = Math.max(1, ...items.map((i) => Math.max(i.netA, i.netB)));

  // By the hour, as a list: net, documents and basket per hour, day against day.
  const hourRows = useMemo(() => {
    const a = (hrA.data?.byHour ?? []) as { hour: number; net: number; documents: number; averageBasket: number }[];
    const b = (hrB.data?.byHour ?? []) as { hour: number; net: number; documents: number; averageBasket: number }[];
    const hours = Array.from(new Set([...a, ...b].map((r) => r.hour))).sort((x, y) => x - y);
    return hours.map((h) => {
      const ra = a.find((r) => r.hour === h);
      const rb = b.find((r) => r.hour === h);
      return {
        hour: h,
        netA: ra?.net ?? 0,
        netB: rb?.net ?? 0,
        docsA: ra?.documents ?? 0,
        docsB: rb?.documents ?? 0,
        avgA: ra?.averageBasket ?? 0,
      };
    });
  }, [hrA.data, hrB.data]);
  const maxHour = Math.max(1, ...hourRows.map((r) => Math.max(r.netA, r.netB)));
  const peak = hourRows.reduce<(typeof hourRows)[number] | null>((p, r) => (!p || r.netA > p.netA ? r : p), null);

  // Re-render now and then so "updated N minutes ago" stays true.
  const [, tick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => tick((n) => n + 1), 15_000);
    return () => window.clearInterval(id);
  }, []);

  const money = (n: number) => formatCurrency(n);
  const count = (n: number) => n.toLocaleString('he-IL');

  // Excel: every table of the board, day A against day B. The items are read again at the
  // report's largest limit — the board fetches 200 and shows 15.
  const scopeName = useOrgScopeLabel(scope);
  const labelA = dayLabel(dayA);
  const labelB = dayLabel(dayB);
  const getSheets = async (): Promise<ExcelSheet[]> => {
    const [allA, allB] = await Promise.all([
      fetchLiveItems({ ...narrowParams(dayA), limit: 1000 }),
      fetchLiveItems({ ...narrowParams(dayB), limit: 1000 }),
    ]);
    const key = (r: { productId?: string | null; name?: string | null }) => r.productId ?? r.name ?? '';
    const itemMap = new Map<string, { name: string; sku: string | null; qtyA: number; qtyB: number; netA: number; netB: number }>();
    for (const r of allA.rows) itemMap.set(key(r), { name: r.name ?? '—', sku: r.sku ?? null, qtyA: r.qty, qtyB: 0, netA: r.net, netB: 0 });
    for (const r of allB.rows) {
      const m = itemMap.get(key(r)) ?? { name: r.name ?? '—', sku: r.sku ?? null, qtyA: 0, qtyB: 0, netA: 0, netB: 0 };
      m.qtyB = r.qty;
      m.netB = r.net;
      itemMap.set(key(r), m);
    }
    const allItems = [...itemMap.values()].sort((x, y) => y.netA - x.netA || y.netB - x.netB);
    const sum = <T,>(list: T[], pick: (x: T) => number) => list.reduce((n, x) => n + pick(x), 0);
    const day = (d: string, s: OverviewSales, it: { qty: number; perSale: number; perUnit: number }) => [
      d, s.salesToday, s.documentsToday, s.salesCount, s.refundsCount, avgTicket(s), s.gross, s.discounts, s.refunds,
      s.cash, s.card, s.other, s.tips, it.qty, it.perSale, it.perUnit,
    ];
    return [
      {
        name: 'סיכום',
        columns: [
          { header: 'יום', kind: 'date' },
          { header: 'מכירות נטו', kind: 'money' },
          { header: 'מסמכים', kind: 'number' },
          { header: 'מכירות', kind: 'number' },
          { header: 'זיכויים', kind: 'number' },
          { header: 'ממוצע לעסקה', kind: 'money' },
          { header: 'מכירות ברוטו', kind: 'money' },
          { header: 'הנחות', kind: 'money' },
          { header: 'החזרות', kind: 'money' },
          { header: 'מזומן', kind: 'money' },
          { header: 'אשראי', kind: 'money' },
          { header: 'אחר', kind: 'money' },
          { header: 'טיפ', kind: 'money' },
          { header: 'סך הפריטים שנמכרו', kind: 'number' },
          { header: 'ממוצע פריטים למכירה', kind: 'number' },
          { header: 'מחיר ממוצע ליחידה', kind: 'money' },
        ],
        rows: [day(dayA, viewA.total, itemsA), day(dayB, viewB.total, itemsB)],
      },
      {
        name: 'פילוח לפי שעות',
        columns: [
          { header: 'שעה', width: 8 },
          { header: `נטו ${labelA}`, kind: 'money' },
          { header: `נטו ${labelB}`, kind: 'money' },
          { header: 'שינוי', kind: 'percent' },
          { header: `מסמכים ${labelA}`, kind: 'number' },
          { header: `מסמכים ${labelB}`, kind: 'number' },
          { header: `סל ממוצע ${labelA}`, kind: 'money' },
        ],
        rows: hourRows.map((r) => [
          `${String(r.hour).padStart(2, '0')}:00`, r.netA, r.netB, change(r.netA, r.netB), r.docsA, r.docsB, r.avgA,
        ]),
        totals: [
          'סה״כ', sum(hourRows, (r) => r.netA), sum(hourRows, (r) => r.netB),
          change(sum(hourRows, (r) => r.netA), sum(hourRows, (r) => r.netB)),
          sum(hourRows, (r) => r.docsA), sum(hourRows, (r) => r.docsB), null,
        ],
      },
      {
        name: 'מוכרנים',
        columns: [
          { header: 'מוכרן', width: 18 },
          { header: `נטו ${labelA}`, kind: 'money' },
          { header: `נטו ${labelB}`, kind: 'money' },
          { header: 'שינוי', kind: 'percent' },
          { header: `מסמכים ${labelA}`, kind: 'number' },
          { header: `ממוצע ${labelA}`, kind: 'money' },
        ],
        rows: sellers.map((s) => [s.name, s.netA, s.netB, change(s.netA, s.netB), s.docsA, s.avgA]),
        totals: [
          'סה״כ', sum(sellers, (s) => s.netA), sum(sellers, (s) => s.netB),
          change(sum(sellers, (s) => s.netA), sum(sellers, (s) => s.netB)), sum(sellers, (s) => s.docsA), null,
        ],
      },
      {
        name: `פילוח — ${viewA.level || viewB.level || 'לפי היקף'}`,
        columns: [
          { header: viewA.level || viewB.level || 'היקף', width: 22 },
          { header: `נטו ${labelA}`, kind: 'money' },
          { header: `נטו ${labelB}`, kind: 'money' },
          { header: 'שינוי', kind: 'percent' },
          { header: `מסמכים ${labelA}`, kind: 'number' },
          { header: `מסמכים ${labelB}`, kind: 'number' },
        ],
        rows: rows.map((r) => [r.name, r.a, r.b, change(r.a, r.b), r.docsA, r.docsB]),
        totals: [
          'סה״כ', sum(rows, (r) => r.a), sum(rows, (r) => r.b), change(sum(rows, (r) => r.a), sum(rows, (r) => r.b)),
          sum(rows, (r) => r.docsA), sum(rows, (r) => r.docsB),
        ],
      },
      {
        name: 'פריטים',
        columns: [
          { header: 'פריט', width: 26 },
          { header: 'מק״ט', width: 12 },
          { header: `יח׳ ${labelA}`, kind: 'number' },
          { header: `יח׳ ${labelB}`, kind: 'number' },
          { header: `נטו ${labelA}`, kind: 'money' },
          { header: `נטו ${labelB}`, kind: 'money' },
          { header: 'שינוי', kind: 'percent' },
        ],
        rows: allItems.map((i) => [i.name, i.sku, i.qtyA, i.qtyB, i.netA, i.netB, change(i.netA, i.netB)]),
        // The days' own totals: every item, even past the report's row limit.
        totals: ['סה״כ', null, allA.totals.qty, allB.totals.qty, allA.totals.net, allB.totals.net, change(allA.totals.net, allB.totals.net)],
      },
      {
        name: `אמצעי תשלום ${labelA}`,
        columns: [
          { header: 'אמצעי תשלום', width: 18 },
          { header: 'סכום', kind: 'money' },
          { header: 'חלק', kind: 'percent' },
        ],
        rows: [
          ...pie.map((s) => [s.name, s.value, (s.value / (pieTotal || 1)) * 100]),
          ...(viewA.total.tips ? [['טיפ', viewA.total.tips, null]] : []),
        ],
        totals: ['סה״כ', pieTotal, pieTotal ? 100 : null],
      },
    ];
  };

  return (
    <div
      className="-mx-2 rounded-[28px] bg-[#F2F2F7] px-3 pb-6 pt-4 text-black antialiased dark:bg-black dark:text-white sm:mx-0 sm:px-5"
      style={{ fontFamily: SF_FONT }}
    >
      {/* Large title */}
      <div className="flex items-end justify-between gap-3 px-1">
        <div>
          <p className="text-[13px] font-semibold uppercase tracking-wide text-[#8E8E93]">
            {dayLabel(dayA)} · מול {dayLabel(dayB)}
          </p>
          <h1 className="text-[34px] font-bold leading-tight tracking-tight">לוח בקרה</h1>
        </div>
        <div className="mb-1 flex shrink-0 items-center gap-2">
          <ReportExportToolbar
            title={`לוח בקרה — ${labelA} מול ${labelB}`}
            scopeLabel={scopeName}
            disabled={loading}
            getSheets={getSheets}
          />
          <button
            type="button"
            onClick={refetchAll}
            aria-label="רענון"
            className="flex h-10 w-10 items-center justify-center rounded-full bg-white text-[#007AFF] shadow-sm active:opacity-60 dark:bg-[#1C1C1E]"
          >
            <RefreshCw className={cn('h-[18px] w-[18px]', fetching && 'animate-spin')} />
          </button>
        </div>
      </div>

      {/* Compare */}
      <div className="mt-4 overflow-x-auto px-1 pb-1">
        <Segmented value={mode} options={MODES} onChange={setMode} className="min-w-[340px]" />
      </div>
      {mode === 'custom' ? (
        <Card className="mt-3 divide-y divide-[#3C3C4349] p-0 dark:divide-[#54545899]">
          <label className="flex items-center justify-between gap-3 px-4 py-2.5">
            <span className="flex items-center gap-2 text-[17px]"><span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: COLOR_A }} />יום</span>
            <DatePicker value={customA} onChange={(e) => setCustomA(e.target.value)} dir="ltr"
              className="w-40 shrink-0 text-[15px] text-[#007AFF]" />
          </label>
          <label className="flex items-center justify-between gap-3 px-4 py-2.5">
            <span className="flex items-center gap-2 text-[17px]"><span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: COLOR_B }} />מול יום</span>
            <DatePicker value={customB} onChange={(e) => setCustomB(e.target.value)} dir="ltr"
              className="w-40 shrink-0 text-[15px] text-[#FF9500]" />
          </label>
        </Card>
      ) : null}

      {/* Scope + refresh */}
      <SectionHeader>הצג עבור</SectionHeader>
      <Card className="space-y-3">
        <ScopePicker value={scope} onChange={setScope} allowAll />
        <div className="flex items-center justify-between gap-3 border-t border-[#3C3C4349] pt-3 dark:border-[#54545899]">
          <div>
            <div className="text-[17px]">רענון אוטומטי</div>
            <div className="text-[13px] text-[#8E8E93]">
              {updatedAt > 0 ? `עודכן ${formatDistanceToNow(updatedAt, { addSuffix: true, locale: he })}` : 'כל דקה'}
            </div>
          </div>
          <Switch checked={auto} onChange={setAuto} label="רענון אוטומטי" />
        </div>
      </Card>

      {/* Widgets */}
      <SectionHeader>סיכום</SectionHeader>
      {loading ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-[112px] animate-pulse rounded-[22px] bg-white dark:bg-[#1C1C1E]" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Widget title="מכירות נטו" color={IOS.blue} a={viewA.total.salesToday} b={viewB.total.salesToday} format={money} />
          <Widget title="מסמכים" color={IOS.purple} a={viewA.total.documentsToday} b={viewB.total.documentsToday} format={count} />
          <Widget title="ממוצע לעסקה" color={IOS.green} a={avgTicket(viewA.total)} b={avgTicket(viewB.total)} format={money} />
          <Widget title="הנחות וזיכויים" color={IOS.pink} a={viewA.total.discounts + viewA.total.refunds} b={viewB.total.discounts + viewB.total.refunds} format={money} />
        </div>
      )}

      {/* Open tables now — live; hidden when the scope has no tables */}
      <OpenTablesWidget scope={scope} auto={auto} />

      {/* Items and sales, three figures to a card with hairline dividers (Nayax's "פריטים" / "מכירות") */}
      <div className="mt-1 grid gap-3 lg:grid-cols-2">
        <div>
          <SectionHeader>פריטים</SectionHeader>
          <Card className="grid grid-cols-3 divide-x divide-x-reverse divide-[#3C3C4349] p-0 py-3 dark:divide-[#54545899]">
            <Trio label="סך הפריטים שנמכרו" a={itemsA.qty} b={itemsB.qty} format={(n) => n.toLocaleString('he-IL', { maximumFractionDigits: 1 })} />
            <Trio label="ממוצע פריטים למכירה" a={itemsA.perSale} b={itemsB.perSale} format={(n) => n.toFixed(1)} />
            <Trio label="מחיר ממוצע ליחידה" a={itemsA.perUnit} b={itemsB.perUnit} format={money} />
          </Card>
        </div>
        <div>
          <SectionHeader>מכירות</SectionHeader>
          <Card className="grid grid-cols-3 divide-x divide-x-reverse divide-[#3C3C4349] p-0 py-3 dark:divide-[#54545899]">
            <Trio label="הנחות" a={viewA.total.discounts} b={viewB.total.discounts} format={money} invert />
            <Trio label="החזרות" a={viewA.total.refunds} b={viewB.total.refunds} format={money} invert />
            <Trio label="מכירות ברוטו" a={viewA.total.gross} b={viewB.total.gross} format={money} />
          </Card>
        </div>
      </div>

      <div className="mt-1 grid gap-3 lg:grid-cols-5">
        {/* Hourly */}
        <div className="lg:col-span-3">
          <SectionHeader
            trailing={
              <Segmented
                value={hourView}
                options={[{ id: 'cumulative', label: 'מצטבר' }, { id: 'hourly', label: 'לכל שעה' }]}
                onChange={setHourView}
                className="w-44"
              />
            }
          >
            לפי שעות
          </SectionHeader>
          <Card>
            <Legend dayA={dayA} dayB={dayB} />
            {scope.areaId || (scope.companyId && scope.companyId !== ALL_COMPANIES && !scope.shopId) ? (
              <p className="mt-1 text-[12px] text-[#8E8E93]">הגרף לפי שעות מוצג לכל הסניפים שבהרשאתך (או לסניף/קופה שנבחרו).</p>
            ) : null}
            <div className="mt-2 h-60" dir="ltr">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={hourly} margin={{ top: 6, right: 4, bottom: 0, left: 4 }}>
                  <defs>
                    <linearGradient id="iosA" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={COLOR_A} stopOpacity={0.3} />
                      <stop offset="100%" stopColor={COLOR_A} stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="iosB" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={COLOR_B} stopOpacity={0.2} />
                      <stop offset="100%" stopColor={COLOR_B} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid vertical={false} stroke="#7676801F" />
                  <XAxis dataKey="hour" tick={{ fontSize: 11, fill: '#8E8E93' }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 11, fill: '#8E8E93' }} axisLine={false} tickLine={false} width={52} orientation="right" />
                  <Tooltip contentStyle={tooltipStyle} formatter={(v) => money(Number(v ?? 0))} />
                  <Area type="monotone" dataKey={cumulative ? 'cb' : 'b'} name={dayLabel(dayB)} stroke={COLOR_B} strokeWidth={2} strokeDasharray="5 4" fill="url(#iosB)" />
                  <Area type="monotone" dataKey={cumulative ? 'ca' : 'a'} name={dayLabel(dayA)} stroke={COLOR_A} strokeWidth={3} fill="url(#iosA)" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </Card>
        </div>

        {/* Tenders */}
        <div className="lg:col-span-2">
          <SectionHeader>אמצעי תשלום — {dayLabel(dayA)}</SectionHeader>
          <Card>
            {pie.length === 0 ? (
              <p className="py-6 text-center text-[15px] text-[#8E8E93]">אין תשלומים ביום הזה.</p>
            ) : (
              <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-center">
                <div className="h-40 w-40 shrink-0" dir="ltr">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={pie} dataKey="value" nameKey="name" innerRadius={44} outerRadius={70} paddingAngle={2} stroke="none">
                        {pie.map((s) => <Cell key={s.name} fill={s.color} />)}
                      </Pie>
                      <Tooltip contentStyle={tooltipStyle} formatter={(v) => money(Number(v ?? 0))} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <ul className="w-full space-y-1.5">
                  {pie.map((s) => (
                    <li key={s.name} className="flex items-center justify-between gap-2 text-[15px]">
                      <span className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: s.color }} />{s.name}</span>
                      <span className="tabular-nums">
                        {money(s.value)} <span className="text-[13px] text-[#8E8E93]">({((s.value / (pieTotal || 1)) * 100).toFixed(1)}%)</span>
                      </span>
                    </li>
                  ))}
                  {viewA.total.tips ? (
                    <li className="flex items-center justify-between gap-2 border-t border-[#3C3C4349] pt-1.5 text-[15px] dark:border-[#54545899]">
                      <span className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: IOS.red }} />טיפ</span>
                      <span className="tabular-nums">{money(viewA.total.tips)}</span>
                    </li>
                  ) : null}
                </ul>
              </div>
            )}
            <div className="mt-3 grid grid-cols-3 gap-2 border-t border-[#3C3C4349] pt-3 text-center dark:border-[#54545899]">
              {tenders.map((t) => (
                <div key={t.name}>
                  <div className="text-[13px] text-[#8E8E93]">{t.name}</div>
                  <div className="text-[15px] font-semibold tabular-nums">{money(t.a)}</div>
                  <Delta a={t.a} b={t.b} />
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>

      {/* By the hour — every hour's sales, documents and basket, day against day */}
      <SectionHeader
        trailing={peak && peak.netA > 0 ? (
          <span className="text-[13px] text-[#8E8E93]">
            שעת השיא: <span className="font-semibold" style={{ color: COLOR_A }}>{String(peak.hour).padStart(2, '0')}:00</span>
          </span>
        ) : null}
      >
        פילוח לפי שעות
      </SectionHeader>
      <Card className="p-0">
        {hourRows.length === 0 ? (
          <p className="px-4 py-3 text-[15px] text-[#8E8E93]">אין מכירות באף אחד מהימים.</p>
        ) : (
          <ul>
            {hourRows.map((r, i) => (
              <li key={r.hour} className="relative px-4 py-2.5">
                {i > 0 ? <span className="absolute left-0 right-4 top-0 h-px bg-[#3C3C4349] dark:bg-[#54545899]" /> : null}
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <span
                      className={cn(
                        'w-14 rounded-lg py-1 text-center text-[15px] font-semibold tabular-nums',
                        peak?.hour === r.hour && r.netA > 0 ? 'bg-[#007AFF] text-white' : 'bg-[#7676801F]',
                      )}
                      dir="ltr"
                    >
                      {String(r.hour).padStart(2, '0')}:00
                    </span>
                    <span className="text-[13px] tabular-nums text-[#8E8E93]">
                      {r.docsA} מסמכים · סל {money(r.avgA)} · מול {r.docsB}
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <div className="text-end">
                      <div className="text-[15px] font-semibold tabular-nums">{money(r.netA)}</div>
                      <div className="text-[13px] tabular-nums text-[#8E8E93]">{money(r.netB)}</div>
                    </div>
                    <Delta a={r.netA} b={r.netB} pill />
                  </div>
                </div>
                <Capsules a={r.netA} b={r.netB} max={maxHour} />
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* Sellers (מוכרנים) */}
      <SectionHeader>מוכרנים</SectionHeader>
      <Card className="p-0">
        {sellers.length === 0 ? (
          <p className="px-4 py-3 text-[15px] text-[#8E8E93]">אין מכירות לעובדים באף אחד מהימים.</p>
        ) : (
          <ul>
            {sellers.map((s, i) => (
              <li key={`${s.name}-${i}`} className="relative px-4 py-2.5">
                {i > 0 ? <span className="absolute left-0 right-4 top-0 h-px bg-[#3C3C4349] dark:bg-[#54545899]" /> : null}
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-b from-[#A0A0A8] to-[#7C7C84] text-[15px] font-semibold text-white">
                      {s.name.trim().charAt(0) || '?'}
                    </span>
                    <div className="min-w-0">
                      <div className="truncate text-[17px]">{s.name}</div>
                      <div className="text-[13px] tabular-nums text-[#8E8E93]">{s.docsA} מסמכים · ממוצע {money(s.avgA)}</div>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <div className="text-end">
                      <div className="text-[17px] font-semibold tabular-nums">{money(s.netA)}</div>
                      <div className="text-[13px] tabular-nums text-[#8E8E93]">{money(s.netB)}</div>
                    </div>
                    <Delta a={s.netA} b={s.netB} pill />
                  </div>
                </div>
                <Capsules a={s.netA} b={s.netB} max={maxSeller} />
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* Breakdown under the scope — an inset grouped list */}
      <SectionHeader>פילוח — {viewA.level || viewB.level || 'לפי היקף'}</SectionHeader>
      <Card className="p-0">
        {rows.length === 0 ? (
          <p className="px-4 py-3 text-[15px] text-[#8E8E93]">אין נתונים להיקף שנבחר.</p>
        ) : (
          <ul>
            {rows.map((r, i) => (
              <li key={r.id} className="relative px-4 py-3">
                {i > 0 ? <span className="absolute left-0 right-4 top-0 h-px bg-[#3C3C4349] dark:bg-[#54545899]" /> : null}
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-[17px]">{r.name}</div>
                    <div className="text-[13px] tabular-nums text-[#8E8E93]">
                      {r.docsA} מסמכים · מול {r.docsB}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <div className="text-end">
                      <div className="text-[17px] font-semibold tabular-nums">{money(r.a)}</div>
                      <div className="text-[13px] tabular-nums text-[#8E8E93]">{money(r.b)}</div>
                    </div>
                    <Delta a={r.a} b={r.b} pill />
                  </div>
                </div>
                <Capsules a={r.a} b={r.b} max={maxRow} />
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* Items — Stocks-style rows */}
      <SectionHeader>הפריטים המובילים</SectionHeader>
      <Card className="p-0">
        {items.length === 0 ? (
          <p className="px-4 py-3 text-[15px] text-[#8E8E93]">לא נמכרו פריטים באף אחד מהימים.</p>
        ) : (
          <ul>
            {items.map((it, i) => (
              <li key={it.name} className="relative flex items-center justify-between gap-3 px-4 py-2.5">
                {i > 0 ? <span className="absolute left-0 right-4 top-0 h-px bg-[#3C3C4349] dark:bg-[#54545899]" /> : null}
                <div className="flex min-w-0 items-center gap-3">
                  <span className="w-5 text-center text-[15px] font-semibold tabular-nums text-[#8E8E93]">{i + 1}</span>
                  <div className="min-w-0">
                    <div className="truncate text-[17px] font-medium">{it.name}</div>
                    <div className="text-[13px] tabular-nums text-[#8E8E93]">
                      {it.qtyA.toLocaleString('he-IL')} יח׳ · מול {it.qtyB.toLocaleString('he-IL')}
                    </div>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <div className="hidden w-24 sm:block">
                    <div className="h-[6px] rounded-full bg-[#7676801F]">
                      <div className="h-[6px] rounded-full" style={{ width: `${(it.netA / maxItem) * 100}%`, backgroundColor: COLOR_A }} />
                    </div>
                  </div>
                  <div className="text-end">
                    <div className="text-[17px] font-semibold tabular-nums">{money(it.netA)}</div>
                    <div className="text-[13px] tabular-nums text-[#8E8E93]">{money(it.netB)}</div>
                  </div>
                  <Delta a={it.netA} b={it.netB} pill />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
