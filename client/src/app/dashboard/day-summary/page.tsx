'use client';

/**
 * "סיכום יום" — two views of the same page (P:\specs\reports-designed-pdf.md §3, §7.3):
 *
 * * **סיכום היום** (`?view=day`, the default): one business day of the scope (shops, points of
 *   sale, tills) from `GET /reports/day-summary?date=…` (v2) — the KPIs against the same weekday
 *   last week and the 4-week average, the server's insights, the hours, shop → point of sale →
 *   till, payments, departments and items, tables, staff, risks and kiosks — with "הורד PDF"
 *   (`GET /reports/day-summary/pdf`, the PDF the server draws whole). Under it, the day's Zs
 *   (the drill-down to each Z) and the shop's interim X.
 * * **ימי Z** (`?view=zdays`): the Z reports of a range, one row per business date — as before.
 *
 * The Z days are built on Z reports (grouped by the Z's business date, one drill-down row per
 * till section of each Z), and the two consequences of that are what this view has to
 * communicate rather than hide:
 *
 * 1. **A day with no Z is absent, not zero.** Shifts awaiting a Z have declared nothing.
 *    So the range can legitimately come back with fewer rows than it has days, and
 *    the empty state says why instead of looking like a failed query.
 *
 * 2. **`variance` and `vat` can be unavailable.** Not zero — unavailable. A day
 *    containing one unattended close has no counted cash for that till, and printing
 *    "₪0.00" against it would assert that the drawer balanced when nobody opened it.
 *    Those cells render as an explicit "not available" with the reason and the number
 *    of tills responsible, and the contributor rows mark which ones they were.
 *
 * It is not a Z. It closes nothing and it is not a fiscal document.
 *
 * On the report framework (P:\specs\reports-upgrade.md §5): the days and the shops / tills
 * (`?shops=a,b&tills=c`) in the URL — the same keys in both views, so switching keeps them;
 * tips split into cash and card (§2ה, §4.2), per day and per Z when the server sends it.
 */

import { useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CalendarDays, Coins, CreditCard, FileDown, Info, Loader2, Percent, Scale, Wallet } from 'lucide-react';
import { fetchDaySummaryReport, fetchMachines, fetchShops } from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { usePageScope } from '@/lib/scope';
import { formatCurrency, formatDate, formatDateTime, formatQuantity } from '@/lib/format';
import type { ReportFilterSpec } from '@/lib/reportFilters';
import type { DaySummaryContributor, DaySummaryReport, DaySummaryRow, DaySummaryTotals } from '@/lib/types';
import { downloadBlob } from '@/lib/excelExport';
import { reportFileName } from '@/lib/reportExport';
import { dayExportKpis, type DaySummaryV2, type DaySummaryV2Params } from '@/lib/daySummaryV2';
import { downloadDaySummaryPdf, fetchDaySummaryV2 } from '@/lib/designedReportsApi';
import { EntityMultiSelect, type MultiSelectOption } from '@/components/dashboard/entity-multi-select';
import { ReportStatCard } from '@/components/dashboard/report-stat-card';
import { ReportErrorState, ReportWindowSummary } from '@/components/dashboard/report-window-summary';
import { useZNumberLabel } from '@/components/dashboard/z-report/z-number';
import { ShopXReportCard } from '@/components/dashboard/shop-x/shop-x-report';
import { useShopAreas } from '@/components/dashboard/areas/use-shop-areas';
import { ScopeGate } from '@/components/dashboard/scope-gate';
import {
  DayHourlyChart,
  DayInsights,
  DayKpiGrid,
  Fact,
  formatKpi,
  useDayTables,
} from '@/components/dashboard/day-summary/day-summary-v2';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { DatePicker } from '@/components/ui/date-picker';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { BranchCode, useZIdentityLabel, ZRun } from '@/components/dashboard/z-report/z-identity';
import { zRunDate, zTillColumn } from '@/lib/zIdentity';
import { useTenantTimeZone } from '@/lib/auth';
import { todayIso } from '@/lib/reportWindow';
import {
  ReportPage,
  ReportTable,
  StandaloneExportBar,
  reportQueryState,
  useReportExportScope,
  useReportFilters,
  type ReportColumn,
  type ReportTableSpec,
} from '@/components/dashboard/report-framework';

const SPEC: ReportFilterSpec = {
  filters: [],
  // Several shops / tills at once (comma-separated ids): comparing tills is the point here.
  extras: { shops: '', tills: '' },
};

const TENDER = 'bg-muted/40';
const ids = (raw: string | undefined) => (raw ? raw.split(',').filter(Boolean) : []);

/**
 * A money cell that may be genuinely unavailable.
 *
 * The whole reason this component exists is that `null` and `0` mean opposite
 * things here and both would render as a number if left to `formatCurrency`.
 */
function MaybeMoney({
  value,
  unavailableLabel,
  className = '',
}: {
  value: number | null;
  unavailableLabel: string;
  className?: string;
}) {
  if (value === null) {
    return (
      <span className={`text-muted-foreground text-xs ${className}`} title={unavailableLabel}>
        {unavailableLabel}
      </span>
    );
  }
  return <span className={`tabular-nums ${className}`}>{formatCurrency(value)}</span>;
}

/** Variance is only meaningful with a sign, and only when it exists at all. */
function VarianceCell({ totals }: { totals: DaySummaryTotals }) {
  const t = useTranslations('daySummary');
  if (totals.variance === null) {
    return (
      <span
        className="text-muted-foreground inline-flex items-center gap-1 text-xs"
        title={t('unavailable.varianceReason', { count: totals.uncountedCount })}
      >
        <Info className="h-3 w-3" aria-hidden />
        {t('unavailable.short')}
      </span>
    );
  }
  const tone =
    totals.variance === 0
      ? 'text-muted-foreground'
      : totals.variance > 0
        ? 'text-emerald-600'
        : 'text-destructive';
  return (
    <span className={`tabular-nums font-medium ${tone}`}>
      {totals.variance > 0 ? '+' : ''}
      {formatCurrency(totals.variance)}
    </span>
  );
}

/**
 * Under a card figure: its offline-approved sales the acquirer later declined, in red.
 * Nothing when there were none (or the Zs predate the figure).
 */
function OfflineDeclined({ count, amount }: { count?: number; amount?: number }) {
  const t = useTranslations('daySummary');
  if (!count) return null;
  return (
    <div className="text-destructive text-xs whitespace-nowrap">
      {t('offlineDeclined', { count, amount: formatCurrency(amount ?? 0) })}
    </div>
  );
}

/** The Zs behind one day: one row per Z × till ("פתח" leads to the Z itself). */
function Contributors({ row, tipSplit }: { row: DaySummaryRow; tipSplit: boolean }) {
  const t = useTranslations('daySummary');
  const tz = useTranslations('zReports');
  const ti = useTranslations('independentTill.daySummary');
  // A till Z has no shop number: it reads "קופה 2 · Z 12", never "#null".
  const zNumberLabel = useZNumberLabel();
  return (
    <div className="space-y-2 p-3">
      <p className="text-muted-foreground text-xs">{t('drill.caption')}</p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('drill.zNumber')}</TableHead>
            <TableHead>{t('drill.machine')}</TableHead>
            <TableHead>{t('drill.shop')}</TableHead>
            <TableHead className="text-end">{t('drill.net')}</TableHead>
            <TableHead className="text-end">{t('drill.cash')}</TableHead>
            <TableHead className="text-end">{t('drill.card')}</TableHead>
            <TableHead className="text-end">{t('drill.tips')}</TableHead>
            {tipSplit ? <TableHead className="text-end">{t('drill.cashTips')}</TableHead> : null}
            {tipSplit ? <TableHead className="text-end">{t('drill.cardTips')}</TableHead> : null}
            <TableHead className="text-end">{t('drill.expected')}</TableHead>
            <TableHead className="text-end">{t('drill.counted')}</TableHead>
            <TableHead className="text-end">{t('drill.discrepancy')}</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {row.contributors.map((c) => (
            // One row per Z × till: a Z over three tills contributes three.
            <TableRow key={`${c.zReportId}:${c.machineId}`}>
              <TableCell className="font-medium tabular-nums whitespace-nowrap">
                {zNumberLabel(c)}
                {c.origin === 'till' ? (
                  <Badge variant="secondary" className="ms-2 text-xs" title={tz('originTillHint')}>
                    {tz('originTill')}
                  </Badge>
                ) : null}
                {/* One till can have two "Z 1": a later run says when it started. */}
                <ZRun z={c} className="block text-muted-foreground text-xs font-normal" />
              </TableCell>
              <TableCell className="font-medium">
                {c.machineName ?? c.machineId}
                {c.independent ? (
                  <Badge variant="secondary" className="ms-2 text-xs" title={ti('independentHint')}>
                    {ti('independent')}
                  </Badge>
                ) : null}
                {c.reconstructed ? (
                  <Badge variant="outline" className="ms-2 text-xs">
                    {t('drill.reconstructed')}
                  </Badge>
                ) : c.unattended ? (
                  <Badge variant="outline" className="ms-2 text-xs">
                    {t('drill.unattended')}
                  </Badge>
                ) : null}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {c.shopName ?? '—'}
                <BranchCode code={c.branchCode} className="block text-xs" />
              </TableCell>
              <TableCell className="text-end tabular-nums">{formatCurrency(c.net)}</TableCell>
              <TableCell className="text-end tabular-nums">{formatCurrency(c.cashSales)}</TableCell>
              <TableCell className="text-end tabular-nums">
                {formatCurrency(c.cardSales)}
                <OfflineDeclined count={c.offlineDeclinedCount} amount={c.offlineDeclinedAmount} />
              </TableCell>
              <TableCell className="text-end tabular-nums">{formatCurrency(c.tips)}</TableCell>
              {tipSplit ? <TableCell className="text-end tabular-nums">{formatCurrency(c.cashTips ?? null)}</TableCell> : null}
              {tipSplit ? <TableCell className="text-end tabular-nums">{formatCurrency(c.cardTips ?? null)}</TableCell> : null}
              <TableCell className="text-end tabular-nums">{formatCurrency(c.expectedCash)}</TableCell>
              <TableCell className="text-end">
                <MaybeMoney value={c.actualCash} unavailableLabel={t('drill.notCounted')} />
              </TableCell>
              <TableCell className="text-end">
                <MaybeMoney value={c.discrepancy} unavailableLabel={t('unavailable.short')} />
              </TableCell>
              <TableCell className="text-end">
                {/* The document itself, not a restatement of it. */}
                <Link
                  href={`/dashboard/z-reports/${c.zReportId}`}
                  className="text-primary text-xs underline"
                  onClick={(event) => event.stopPropagation()}
                >
                  {t('drill.open')}
                </Link>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

type ZRow = DaySummaryContributor & { dayDate: string };

/** The Z days and the Zs behind them, as report tables (screen, Excel, PDF). */
function useZDayTables(data: DaySummaryReport | undefined) {
  const t = useTranslations('daySummary');
  const tExport = useTranslations('independentTill.export');
  const zIdentity = useZIdentityLabel();
  const timeZone = useTenantTimeZone();
  const tipSplit = Boolean(data?.days.some((d) => d.contributors.some((c) => c.cashTips !== undefined)));

  const days = useMemo<ReportTableSpec<DaySummaryRow>>(() => {
    const tot = data?.totals;
    const unavailable = t('unavailable.short');
    const columns: ReportColumn<DaySummaryRow>[] = [
      {
        key: 'day',
        header: t('table.day'),
        kind: 'date',
        required: true,
        value: (r) => r.dayDate,
        className: 'font-medium',
        cell: (r) => (
          <>
            {formatDate(r.dayDate)}
            {/* What the day's Zs include: the shop Z's tills, and each independent till's own Z. */}
            {r.includesNote ? (
              <div className="text-muted-foreground max-w-md text-xs font-normal whitespace-normal">{r.includesNote}</div>
            ) : null}
          </>
        ),
      },
      {
        key: 'tills',
        header: t('table.tills'),
        kind: 'number',
        value: (r) => r.machineCount,
        // Several Zs in a day (a Z per till, or a second run) are ordinary, so the
        // Z count is shown whenever it differs rather than being silently collapsed.
        cell: (r) => (
          <>
            {r.machineCount}
            {r.zReportCount !== r.machineCount ? (
              <span className="text-muted-foreground ms-1 text-xs">{t('table.zCount', { count: r.zReportCount })}</span>
            ) : null}
          </>
        ),
        totalCell: tot ? (
          <>
            {tot.transactionsCount}
            <span className="text-muted-foreground ms-1 text-xs">{t('table.documents')}</span>
          </>
        ) : null,
      },
      { key: 'net', header: t('table.net'), kind: 'money', value: (r) => r.totals.net, total: tot?.net, className: 'font-medium' },
      { key: 'refunds', header: t('table.refunds'), kind: 'money', value: (r) => r.totals.refunds, total: tot?.refunds },
      { key: 'cash', header: t('table.cash'), kind: 'money', value: (r) => r.totals.cashSales, total: tot?.cashSales, className: TENDER, headClassName: TENDER },
      {
        key: 'card',
        header: t('table.card'),
        kind: 'money',
        value: (r) => r.totals.cardSales,
        total: tot?.cardSales,
        className: TENDER,
        headClassName: TENDER,
        cell: (r) => (
          <>
            {formatCurrency(r.totals.cardSales)}
            <OfflineDeclined count={r.totals.offlineDeclinedCount} amount={r.totals.offlineDeclinedAmount} />
          </>
        ),
        totalCell: tot ? (
          <>
            {formatCurrency(tot.cardSales)}
            <OfflineDeclined count={tot.offlineDeclinedCount} amount={tot.offlineDeclinedAmount} />
          </>
        ) : null,
      },
      {
        key: 'vat',
        header: t('table.vat'),
        kind: 'money',
        value: (r) => r.totals.vat,
        total: tot?.vat,
        cell: (r) => <MaybeMoney value={r.totals.vat} unavailableLabel={unavailable} />,
        totalCell: tot ? <MaybeMoney value={tot.vat} unavailableLabel={unavailable} /> : null,
      },
      { key: 'tips', header: t('table.tips'), kind: 'money', value: (r) => r.totals.tips, total: tot?.tips },
      { key: 'cashTips', header: t('table.cashTips'), kind: 'money', value: (r) => r.totals.cashTips, total: tot?.cashTips },
      { key: 'cardTips', header: t('table.cardTips'), kind: 'money', value: (r) => r.totals.cardTips, total: tot?.cardTips },
      {
        key: 'variance',
        header: t('table.variance'),
        kind: 'money',
        value: (r) => r.totals.variance,
        total: tot?.variance,
        cell: (r) => <VarianceCell totals={r.totals} />,
        totalCell: tot ? <VarianceCell totals={tot} /> : null,
      },
    ];
    return {
      id: 'main',
      title: t('table.title'),
      columns,
      rows: data?.days ?? [],
      rowKey: (r) => r.dayDate,
      totalsLabel: t('table.total'),
      expand: (r) => <Contributors row={r} tipSplit={tipSplit} />,
    };
  }, [data, t, tipSplit]);

  // Each Z behind the days, with its branch code and till: a branch may run two
  // Z sequences (the shop Z and an independent till's), told apart by the till.
  const zs = useMemo<ReportTableSpec<ZRow>>(
    () => ({
      id: 'zs',
      title: tExport('zSheet'),
      columns: [
        { key: 'day', header: t('table.day'), kind: 'date', required: true, value: (c) => c.dayDate },
        { key: 'z', header: tExport('z'), value: (c) => zIdentity(c) },
        { key: 'branchCode', header: tExport('branchCode'), value: (c) => c.branchCode ?? '' },
        { key: 'till', header: tExport('till'), value: (c) => zTillColumn(c) },
        { key: 'run', header: tExport('run'), value: (c) => zRunDate(c, timeZone) ?? '' },
        { key: 'shop', header: t('drill.shop'), value: (c) => c.shopName ?? '' },
        { key: 'net', header: t('drill.net'), kind: 'money', value: (c) => c.net },
        { key: 'cash', header: t('drill.cash'), kind: 'money', value: (c) => c.cashSales },
        { key: 'card', header: t('drill.card'), kind: 'money', value: (c) => c.cardSales },
        { key: 'tips', header: t('drill.tips'), kind: 'money', value: (c) => c.tips },
        ...(tipSplit
          ? [
              { key: 'cashTips', header: t('drill.cashTips'), kind: 'money' as const, value: (c: ZRow) => c.cashTips ?? null },
              { key: 'cardTips', header: t('drill.cardTips'), kind: 'money' as const, value: (c: ZRow) => c.cardTips ?? null },
            ]
          : []),
      ],
      rows: (data?.days ?? []).flatMap((d) => d.contributors.map((c) => ({ ...c, dayDate: d.dayDate }))),
      rowKey: (c) => `${c.zReportId}:${c.machineId}`,
    }),
    [data, t, tExport, timeZone, tipSplit, zIdentity],
  );

  return { days, zs };
}

type View = 'day' | 'zdays';

/** The page's URL: the view, the day, and the shops / points of sale / tills chosen. */
function useDayUrl() {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const view: View = search.get('view') === 'zdays' ? 'zdays' : 'day';
  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(search.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    const q = next.toString();
    router.replace(q ? `${pathname}?${q}` : pathname, { scroll: false });
  };
  return {
    view,
    date: search.get('date') ?? '',
    shops: ids(search.get('shops') ?? ''),
    areas: ids(search.get('areas') ?? ''),
    tills: ids(search.get('tills') ?? ''),
    set,
  };
}

/** "סיכום היום" · "ימי Z": the page's two views. */
function ViewSwitch({ view, onChange }: { view: View; onChange: (v: View) => void }) {
  const t = useTranslations('daySummary.v2');
  return (
    <div role="tablist" aria-label={t('views')} className="bg-muted inline-flex rounded-lg p-1 print:hidden">
      {(['day', 'zdays'] as const).map((v) => (
        <button
          key={v}
          type="button"
          role="tab"
          aria-selected={view === v}
          onClick={() => onChange(v)}
          className={
            view === v
              ? 'bg-background rounded-md px-3 py-1.5 text-sm font-medium shadow-sm'
              : 'text-muted-foreground hover:text-foreground rounded-md px-3 py-1.5 text-sm'
          }
        >
          {v === 'day' ? t('viewDay') : t('viewZDays')}
        </button>
      ))}
    </div>
  );
}

/** The shops and tills the scope offers, for the multi-selects of both views. */
function usePlaceOptions(scopeCompanyId: string | null, scopeShopId: string | null, scopeMachineId: string | null, shopsChosen: string) {
  const { data: shops } = useQuery({
    queryKey: ['shops', scopeCompanyId],
    queryFn: () => fetchShops(scopeCompanyId ?? undefined),
  });
  const { data: machines } = useQuery({ queryKey: ['machines'], queryFn: fetchMachines });

  const shopOptions = useMemo<MultiSelectOption[]>(() => {
    const rows = shops ?? [];
    // A scope pinned to one shop is not a filter to re-pick; it is the answer.
    const inScope = scopeShopId ? rows.filter((s) => s.id === scopeShopId) : rows;
    return inScope.map((s) => ({ id: s.id, label: s.name }));
  }, [scopeShopId, shops]);

  const machineOptions = useMemo<MultiSelectOption[]>(() => {
    const rows = machines ?? [];
    const shopNames = new Map((shops ?? []).map((s) => [s.id, s.name]));
    const chosenShops = new Set(ids(shopsChosen));
    const inScope = rows.filter((m) => {
      if (scopeMachineId) return m.id === scopeMachineId;
      if (scopeShopId && m.shopId !== scopeShopId) return false;
      // Narrowing shops narrows the till list too, so the two selects cannot be
      // combined into a contradiction that silently returns nothing.
      if (chosenShops.size > 0 && (!m.shopId || !chosenShops.has(m.shopId))) return false;
      return true;
    });
    return inScope.map((m) => ({
      id: m.id,
      label: m.name ?? m.machineCode ?? m.id,
      hint: m.shopId ? shopNames.get(m.shopId) : null,
    }));
  }, [machines, scopeMachineId, scopeShopId, shops, shopsChosen]);

  /** The tills that stay valid when the shops change to `next`. */
  const tillsWithin = (next: string[], tills: string[]) => {
    const allowed = new Set(
      (machines ?? []).filter((m) => next.length === 0 || (m.shopId && next.includes(m.shopId))).map((m) => m.id),
    );
    return tills.filter((id) => allowed.has(id));
  };

  return { shopOptions, machineOptions, tillsWithin };
}

/** A titled section of the day. */
function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="min-w-0 space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

const DAY_REPORT_KEY = 'day-summary-day';

/** "סיכום היום" (§3): one business day, every part of it, and its PDF. */
function DayView({ viewSwitch }: { viewSwitch: ReactNode }) {
  const t = useTranslations('daySummary');
  const tv = useTranslations('daySummary.v2');
  const url = useDayUrl();
  const { resolution, effective } = usePageScope({ maxLevel: 'machine' });
  const scopeShopId = effective.shopId;
  const scopeMachineId = effective.machineId;
  const places = usePlaceOptions(effective.companyId, scopeShopId, scopeMachineId, url.shops.join(','));
  const [pdfBusy, setPdfBusy] = useState(false);

  // Points of sale are a shop's: offered when one shop is in view.
  const areaShop = scopeShopId ?? (url.shops.length === 1 ? url.shops[0] : null);
  const { data: areas = [] } = useShopAreas(areaShop);
  const areaOptions = useMemo<MultiSelectOption[]>(() => areas.map((a) => ({ id: a.id, label: a.name })), [areas]);

  const shopIds = url.shops.length ? url.shops : scopeShopId ? [scopeShopId] : [];
  const machineIds = url.tills.length ? url.tills : scopeMachineId ? [scopeMachineId] : [];
  const areaIds = areaShop ? url.areas : [];
  const params: DaySummaryV2Params = {
    date: url.date || null,
    companyId: effective.companyId ?? null,
    shopIds,
    areaIds,
    machineIds,
  };
  const paramsKey = JSON.stringify(params);

  const query = useQuery<DaySummaryV2>({
    queryKey: ['report-day-summary-v2', paramsKey],
    queryFn: () => fetchDaySummaryV2(params),
    enabled: resolution.status === 'ok',
    retry: (count, err) => !(err instanceof Error && err.message === 'day-summary-v1') && count < 2,
  });
  const data = query.data;
  const day = url.date || data?.date || '';

  // The day's Zs, under the summary: the drill-down to each Z of that business date.
  const zQuery = useQuery<DaySummaryReport>({
    queryKey: ['report-day-summary', { from: day, to: day, shopIds, machineIds }],
    queryFn: () =>
      fetchDaySummaryReport({
        from: day,
        to: day,
        ...(shopIds.length ? { shopIds } : {}),
        ...(machineIds.length ? { machineIds } : {}),
      }),
    enabled: Boolean(day) && resolution.status === 'ok',
  });
  const z = useZDayTables(zQuery.data);
  const tables = useDayTables(data);
  const exportScope = useReportExportScope(data?.scope.label || null);

  const title = t('title');
  const fileName = reportFileName(title, exportScope.place, day, day);
  const downloadPdf = async () => {
    const blob = await downloadDaySummaryPdf({ ...params, date: day || null });
    downloadBlob(blob, `${fileName}.pdf`, 'application/pdf');
  };
  const onPdfButton = async () => {
    setPdfBusy(true);
    try {
      await downloadPdf();
    } catch (err) {
      toast.error(axiosErrorToToastMessage(err, tv('pdfFailed')));
    } finally {
      setPdfBusy(false);
    }
  };

  const xShopId = scopeShopId ?? (url.shops.length === 1 ? url.shops[0] : null);
  const serverOld = query.error instanceof Error && query.error.message === 'day-summary-v1';
  const exportTables = tables
    ? ([
        tables.hierarchy,
        tables.payments,
        tables.departments,
        tables.items,
        tables.movers,
        tables.staff,
        tables.risks,
        tables.openTables,
        tables.kiosks,
        z.zs,
      ] as ReportTableSpec<unknown>[])
    : [];

  return (
    <div className="min-w-0 space-y-4 max-sm:px-1">
      <div>
        <h1 className="text-2xl font-bold">{title}</h1>
        <p className="text-muted-foreground text-sm">{tv('subtitle')}</p>
      </div>
      {viewSwitch}
      <ScopeGate resolution={resolution}>
        <div className="flex flex-wrap items-end gap-3 print:hidden">
          <div className="min-w-0 space-y-1">
            <Label className="text-xs" htmlFor="ds-date">
              {tv('date')}
            </Label>
            <DatePicker
              id="ds-date"
              value={day}
              max={todayIso()}
              onValueChange={(v) => url.set({ date: v || null })}
              className="w-44"
            />
          </div>
          <EntityMultiSelect
            label={t('filters.shops')}
            options={places.shopOptions}
            selected={url.shops}
            onChange={(next) =>
              url.set({
                shops: next.join(',') || null,
                tills: places.tillsWithin(next, url.tills).join(',') || null,
                // Points of sale belong to one shop: another choice of shops drops them.
                areas: null,
              })
            }
            allLabel={t('filters.allShops')}
            clearLabel={t('filters.clear')}
            emptyLabel={t('filters.noShops')}
          />
          {areaShop ? (
            <EntityMultiSelect
              label={tv('areas')}
              options={areaOptions}
              selected={url.areas}
              onChange={(next) => url.set({ areas: next.join(',') || null })}
              allLabel={tv('allAreas')}
              clearLabel={t('filters.clear')}
              emptyLabel={tv('noAreas')}
            />
          ) : null}
          <EntityMultiSelect
            label={t('filters.machines')}
            options={places.machineOptions}
            selected={url.tills}
            onChange={(next) => url.set({ tills: next.join(',') || null })}
            allLabel={t('filters.allMachines')}
            clearLabel={t('filters.clear')}
            emptyLabel={t('filters.noMachines')}
          />
          <Button size="sm" onClick={() => void onPdfButton()} disabled={!data || pdfBusy}>
            {pdfBusy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <FileDown className="h-4 w-4" aria-hidden />}
            {tv('downloadPdf')}
          </Button>
          <StandaloneExportBar
            reportKey={DAY_REPORT_KEY}
            reportType="day-summary"
            title={title}
            tables={exportTables}
            from={day || null}
            to={day || null}
            place={exportScope.place}
            kpis={data ? dayExportKpis(data.kpis, tv('lastWeek')) : undefined}
            insights={data?.insights}
            pdf={downloadPdf}
            disabled={!data}
          />
        </div>

        {query.isLoading ? (
          <div className="space-y-4" aria-busy="true">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="h-32 w-full" />
              ))}
            </div>
            <Skeleton className="h-64 w-full" />
          </div>
        ) : serverOld ? (
          <ReportErrorState message={tv('serverOld')} />
        ) : query.isError ? (
          <ReportErrorState message={axiosErrorToToastMessage(query.error, tv('failed'))} />
        ) : data && tables ? (
          <div className="min-w-0 space-y-6">
            <p className="text-muted-foreground text-sm">
              {tv('dayLine', {
                weekday: data.weekday,
                date: formatDate(data.date),
                scope: data.scope.label,
                hour: String(data.businessDay.startHour).padStart(2, '0'),
              })}
              <span className="ms-2 text-xs">{tv('generatedAt', { at: formatDateTime(data.generatedAt) })}</span>
            </p>

            {data.empty ? (
              <Card>
                <CardContent className="py-10 text-center">
                  <CalendarDays className="text-muted-foreground mx-auto mb-3 h-8 w-8" aria-hidden />
                  <p className="text-sm font-medium">{tv('emptyTitle')}</p>
                  <p className="text-muted-foreground mx-auto mt-1 max-w-md text-sm">{tv('emptyBody')}</p>
                </CardContent>
              </Card>
            ) : (
              <>
                <DayKpiGrid kpis={data.kpis} />
                <DayInsights insights={data.insights} />
                <DayHourlyChart data={data} />

                <Section title={tv('hierarchy')}>
                  <ReportTable table={tables.hierarchy} reportKey={DAY_REPORT_KEY} />
                </Section>

                <Section title={tv('payments')}>
                  {data.payAtTill?.orders || data.noMoneyMovement?.documents ? (
                    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                      {data.payAtTill?.orders ? (
                        <Fact
                          label={tv('payAtTill')}
                          value={tv('countAmount', { count: data.payAtTill.orders, amount: formatCurrency(data.payAtTill.amount) })}
                        />
                      ) : null}
                      {data.noMoneyMovement?.documents ? (
                        <Fact
                          label={tv('noMoneyMovement')}
                          value={tv('countAmount', {
                            count: data.noMoneyMovement.documents,
                            amount: formatCurrency(data.noMoneyMovement.amount),
                          })}
                        />
                      ) : null}
                    </div>
                  ) : null}
                  <ReportTable table={tables.payments} reportKey={DAY_REPORT_KEY} />
                </Section>

                <div className="grid min-w-0 gap-6 xl:grid-cols-2">
                  <Section title={tv('departments')}>
                    <ReportTable table={tables.departments} reportKey={DAY_REPORT_KEY} />
                  </Section>
                  <Section title={tv('topItems')}>
                    <ReportTable table={tables.items} reportKey={DAY_REPORT_KEY} />
                  </Section>
                </div>
                {tables.movers.rows.length ? (
                  <Section title={tv('movers')}>
                    <ReportTable table={tables.movers} reportKey={DAY_REPORT_KEY} />
                  </Section>
                ) : null}

                {data.tables ? (
                  <Section title={tv('tables')}>
                    <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
                      <Fact label={tv('tablesOpened')} value={formatQuantity(data.tables.opened)} />
                      <Fact label={tv('tablesPaid')} value={formatQuantity(data.tables.paid)} />
                      <Fact label={tv('tablesCancelled')} value={formatQuantity(data.tables.cancelled)} />
                      <Fact
                        label={tv('tablesStillOpen')}
                        value={formatQuantity(data.tables.stillOpen)}
                        tone={data.tables.stillOpen ? 'warn' : undefined}
                      />
                      <Fact label={tv('averageSeated')} value={formatKpi('duration', data.tables.averageSeatedMinutes === null ? null : data.tables.averageSeatedMinutes * 60)} />
                      <Fact label={tv('averagePerTable')} value={formatKpi('money', data.tables.averagePerTable)} />
                    </div>
                    {data.tables.open.length ? <ReportTable table={tables.openTables} reportKey={DAY_REPORT_KEY} /> : null}
                  </Section>
                ) : null}

                <Section title={tv('staff')}>
                  <ReportTable table={tables.staff} reportKey={DAY_REPORT_KEY} />
                </Section>

                {data.risks ? (
                  <Section title={tv('risks')}>
                    <div className="grid gap-2 sm:grid-cols-3">
                      <Fact
                        label={tv('untransmittedCard')}
                        value={tv('countAmount', {
                          count: data.risks.untransmittedCard.count,
                          amount: formatCurrency(data.risks.untransmittedCard.amount),
                        })}
                        tone={data.risks.untransmittedCard.count ? 'warn' : undefined}
                      />
                      <Fact
                        label={tv('drawerOpensNoSale')}
                        value={formatQuantity(data.risks.drawerOpensNoSale)}
                        tone={data.risks.drawerOpensNoSale ? 'warn' : undefined}
                      />
                      <Fact
                        label={tv('cancelledDocuments')}
                        value={tv('countAmount', {
                          count: data.risks.cancelledDocuments.count,
                          amount: formatCurrency(data.risks.cancelledDocuments.amount),
                        })}
                      />
                    </div>
                    {data.risks.untransmittedCard.tills.length ? (
                      <p className="text-muted-foreground text-xs">
                        {data.risks.untransmittedCard.tills
                          .map((x) => tv('untransmittedTill', { name: x.name, count: x.count, amount: formatCurrency(x.amount) }))
                          .join(' · ')}
                      </p>
                    ) : null}
                    {data.risks.exceptions.length ? (
                      <div className="flex flex-wrap gap-1.5">
                        {data.risks.exceptions.map((e) => (
                          <Badge key={e.type} variant="outline">
                            {e.label} · {e.count}
                          </Badge>
                        ))}
                      </div>
                    ) : null}
                    <ReportTable table={tables.risks} reportKey={DAY_REPORT_KEY} />
                  </Section>
                ) : null}

                {data.kiosks ? (
                  <Section title={tv('kiosks')}>
                    <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
                      <Fact label={tv('kioskOrders')} value={formatQuantity(data.kiosks.orders)} />
                      <Fact label={tv('kioskNet')} value={formatCurrency(data.kiosks.net)} />
                      <Fact label={tv('kioskAverage')} value={formatCurrency(data.kiosks.averageTicket)} />
                      <Fact label={tv('kioskSessions')} value={formatQuantity(data.kiosks.sessions)} />
                      <Fact label={tv('kioskAbandoned')} value={formatQuantity(data.kiosks.abandoned)} tone={data.kiosks.abandoned ? 'warn' : undefined} />
                      <Fact label={tv('kioskMedian')} value={formatKpi('duration', data.kiosks.medianOrderSec)} />
                    </div>
                    {data.kiosks.byKiosk.length ? <ReportTable table={tables.kiosks} reportKey={DAY_REPORT_KEY} /> : null}
                  </Section>
                ) : null}
              </>
            )}
          </div>
        ) : null}

        {/* The day's Zs and the shop's open period: the closed documents behind the summary. */}
        {xShopId ? <ShopXReportCard shopId={xShopId} /> : null}
        {day ? (
          <Section title={tv('zOfDay')}>
            {zQuery.isLoading ? (
              <Skeleton className="h-24 w-full" />
            ) : zQuery.data && zQuery.data.days.length ? (
              <ReportTable table={z.days} reportKey="day-summary" />
            ) : zQuery.data ? (
              <p className="text-muted-foreground text-sm">{t('empty.body')}</p>
            ) : null}
          </Section>
        ) : null}
        <Card>
          <CardContent className="text-muted-foreground flex items-start gap-2 py-4 text-xs">
            <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <p>{t('notFiscal')}</p>
          </CardContent>
        </Card>
      </ScopeGate>
    </div>
  );
}

/** "ימי Z": the Z reports of a range, one row per business date (the page as it was). */
function ZDaysView({ viewSwitch }: { viewSwitch: ReactNode }) {
  const t = useTranslations('daySummary');

  // The scope still applies — it decides what the multi-selects can even offer —
  // but the selection itself is explicit, because "these three branches" is not a
  // position in the hierarchy.
  const { resolution, effective } = usePageScope({ maxLevel: 'machine' });
  const scopeShopId = effective.shopId;
  const scopeMachineId = effective.machineId;
  const filters = useReportFilters(SPEC);
  const draftShops = ids(filters.draftExtras.shops);
  const draftTills = ids(filters.draftExtras.tills);
  const places = usePlaceOptions(effective.companyId, scopeShopId, scopeMachineId, filters.draftExtras.shops);

  const params = useMemo(() => {
    if (!filters.applied) return null;
    const appliedShops = ids(filters.applied.extras.shops);
    const appliedTills = ids(filters.applied.extras.tills);
    const effectiveShops = appliedShops.length ? appliedShops : scopeShopId ? [scopeShopId] : [];
    const effectiveMachines = appliedTills.length ? appliedTills : scopeMachineId ? [scopeMachineId] : [];
    return {
      from: filters.applied.values.from,
      to: filters.applied.values.to,
      ...(effectiveShops.length ? { shopIds: effectiveShops } : {}),
      ...(effectiveMachines.length ? { machineIds: effectiveMachines } : {}),
    };
  }, [filters.applied, scopeMachineId, scopeShopId]);

  // One shop in view (the scope's, or the only one chosen): its interim X ("דוח X סניפי").
  const appliedShops = filters.applied ? ids(filters.applied.extras.shops) : [];
  const xShopId = scopeShopId ?? (appliedShops.length === 1 ? appliedShops[0] : null);

  const query = useQuery<DaySummaryReport>({
    queryKey: ['report-day-summary', params],
    queryFn: () => fetchDaySummaryReport(params!),
    enabled: params !== null,
  });
  const data = query.data;
  const { days, zs } = useZDayTables(data);

  return (
    <ReportPage
      reportKey="day-summary"
      title={t('title')}
      subtitle={t('subtitle')}
      headerExtra={viewSwitch}
      resolution={resolution}
      filters={filters}
      bar={{
        children: (
          <>
            <EntityMultiSelect
              label={t('filters.shops')}
              options={places.shopOptions}
              selected={draftShops}
              onChange={(next) => {
                filters.setExtra('shops', next.join(','));
                // Tills outside the new shop selection would be a contradiction the
                // server correctly answers with nothing, so they are dropped here.
                filters.setExtra('tills', places.tillsWithin(next, draftTills).join(','));
              }}
              allLabel={t('filters.allShops')}
              clearLabel={t('filters.clear')}
              emptyLabel={t('filters.noShops')}
            />
            <EntityMultiSelect
              label={t('filters.machines')}
              options={places.machineOptions}
              selected={draftTills}
              onChange={(next) => filters.setExtra('tills', next.join(','))}
              allLabel={t('filters.allMachines')}
              clearLabel={t('filters.clear')}
              emptyLabel={t('filters.noMachines')}
            />
          </>
        ),
      }}
      query={reportQueryState(query)}
      prompt={t('selectFilters')}
      export={
        data
          ? {
              tables: [days, zs] as ReportTableSpec<unknown>[],
              from: data.window.from,
              to: data.window.to,
              reportType: 'day-summary',
              kpis: [
                { key: 'net', label: t('totals.net'), value: data.totals.net, kind: 'money', icon: 'sales' },
                { key: 'cash', label: t('table.cash'), value: data.totals.cashSales, kind: 'money', icon: 'cash' },
                { key: 'card', label: t('table.card'), value: data.totals.cardSales, kind: 'money', icon: 'card' },
                { key: 'refunds', label: t('table.refunds'), value: data.totals.refunds, kind: 'money', icon: 'refund' },
                { key: 'tips', label: t('totals.tips'), value: data.totals.tips, kind: 'money', icon: 'tip' },
                ...(data.totals.variance !== null
                  ? [{ key: 'variance', label: t('totals.variance'), value: data.totals.variance, kind: 'money' as const, icon: 'cash' as const }]
                  : []),
              ],
              chartFrom: { label: 'day', value: 'net', type: 'bar' },
            }
          : null
      }
    >
      {/* "דוח X סניפי" (P:/specs/shop-x-report.md §3): the open period of one shop, beside its closed days. */}
      {xShopId ? <ShopXReportCard shopId={xShopId} /> : null}
      {data ? (
        <>
          <ReportWindowSummary window={data.window} generatedAt={data.generatedAt} />

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
            <ReportStatCard
              title={t('totals.net')}
              value={formatCurrency(data.totals.net)}
              subtitle={t('totals.netFormula')}
              icon={Wallet}
              emphasis
            />
            <ReportStatCard
              title={t('totals.cashCard')}
              value={formatCurrency(data.totals.cashSales)}
              subtitle={t('totals.cardIs', { card: formatCurrency(data.totals.cardSales) })}
              icon={CreditCard}
            />
            <ReportStatCard
              title={t('totals.vat')}
              value={data.totals.vat === null ? t('unavailable.short') : formatCurrency(data.totals.vat)}
              subtitle={
                data.totals.vat === null ? t('unavailable.vatReason', { count: data.totals.vatMissingCount }) : undefined
              }
              icon={Percent}
            />
            <ReportStatCard
              title={t('totals.tips')}
              value={formatCurrency(data.totals.tips)}
              subtitle={t('totals.tipsSplit', {
                cash: formatCurrency(data.totals.cashTips),
                card: formatCurrency(data.totals.cardTips),
              })}
              icon={Coins}
            />
            <ReportStatCard
              title={t('totals.variance')}
              value={data.totals.variance === null ? t('unavailable.short') : formatCurrency(data.totals.variance)}
              subtitle={
                data.totals.variance === null
                  ? t('unavailable.varianceReason', { count: data.totals.uncountedCount })
                  : t('totals.varianceFormula')
              }
              icon={Scale}
            />
          </div>

          {data.days.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center">
                <CalendarDays className="text-muted-foreground mx-auto mb-3 h-8 w-8" aria-hidden />
                <p className="text-sm font-medium">{t('empty.title')}</p>
                {/* Says *why* rather than looking like a failed query: this report
                    is made of Z reports, so an unclosed day has nothing to show. */}
                <p className="text-muted-foreground mx-auto mt-1 max-w-md text-sm">{t('empty.body')}</p>
              </CardContent>
            </Card>
          ) : (
            <ReportTable table={days} />
          )}

          <Card>
            <CardContent className="text-muted-foreground flex items-start gap-2 py-4 text-xs">
              <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              {/* Stated on the page, not just in the code: someone will eventually
                  ask whether this can be filed or printed for the accountant. */}
              <p>{t('notFiscal')}</p>
            </CardContent>
          </Card>
        </>
      ) : null}
    </ReportPage>
  );
}

export default function DaySummaryPage() {
  const url = useDayUrl();
  const viewSwitch = <ViewSwitch view={url.view} onChange={(v) => url.set({ view: v === 'day' ? null : v })} />;
  return url.view === 'day' ? <DayView viewSwitch={viewSwitch} /> : <ZDaysView viewSwitch={viewSwitch} />;
}
