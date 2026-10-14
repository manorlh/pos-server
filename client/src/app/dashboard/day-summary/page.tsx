'use client';

/**
 * Day summary (סיכום יומי) — the Z reports of a range, one row per business date.
 *
 * Built on Z reports (grouped by the Z's business date, one drill-down row per till
 * section of each Z), and the two consequences of that are what this page has to
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
 * (`?shops=a,b&tills=c`) in the URL; tips split into cash and card (§2ה, §4.2), per day and
 * per Z when the server sends it.
 */

import { useMemo } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { CalendarDays, Coins, CreditCard, Info, Percent, Scale, Wallet } from 'lucide-react';
import { fetchDaySummaryReport, fetchMachines, fetchShops } from '@/lib/api';
import { usePageScope } from '@/lib/scope';
import { formatCurrency, formatDate } from '@/lib/format';
import type { ReportFilterSpec } from '@/lib/reportFilters';
import type { DaySummaryContributor, DaySummaryReport, DaySummaryRow, DaySummaryTotals } from '@/lib/types';
import { EntityMultiSelect, type MultiSelectOption } from '@/components/dashboard/entity-multi-select';
import { ReportStatCard } from '@/components/dashboard/report-stat-card';
import { ReportWindowSummary } from '@/components/dashboard/report-window-summary';
import { useZNumberLabel } from '@/components/dashboard/z-report/z-number';
import { ShopXReportCard } from '@/components/dashboard/shop-x/shop-x-report';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { BranchCode, useZIdentityLabel, ZRun } from '@/components/dashboard/z-report/z-identity';
import { zRunDate, zTillColumn } from '@/lib/zIdentity';
import { useTenantTimeZone } from '@/lib/auth';
import {
  ReportPage,
  ReportTable,
  reportQueryState,
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

export default function DaySummaryPage() {
  const t = useTranslations('daySummary');
  const tExport = useTranslations('independentTill.export');
  const zIdentity = useZIdentityLabel();
  const timeZone = useTenantTimeZone();

  // The scope still applies — it decides what the multi-selects can even offer —
  // but the selection itself is explicit, because "these three branches" is not a
  // position in the hierarchy.
  const { resolution, effective } = usePageScope({ maxLevel: 'machine' });
  const scopeCompanyId = effective.companyId;
  const scopeShopId = effective.shopId;
  const scopeMachineId = effective.machineId;
  const filters = useReportFilters(SPEC);
  const draftShops = ids(filters.draftExtras.shops);
  const draftTills = ids(filters.draftExtras.tills);

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

  const draftShopsKey = filters.draftExtras.shops;
  const machineOptions = useMemo<MultiSelectOption[]>(() => {
    const rows = machines ?? [];
    const shopNames = new Map((shops ?? []).map((s) => [s.id, s.name]));
    const chosenShops = new Set(ids(draftShopsKey));
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
  }, [draftShopsKey, machines, scopeMachineId, scopeShopId, shops]);

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

  return (
    <ReportPage
      reportKey="day-summary"
      title={t('title')}
      subtitle={t('subtitle')}
      resolution={resolution}
      filters={filters}
      bar={{
        children: (
          <>
            <EntityMultiSelect
              label={t('filters.shops')}
              options={shopOptions}
              selected={draftShops}
              onChange={(next) => {
                filters.setExtra('shops', next.join(','));
                // Tills outside the new shop selection would be a contradiction the
                // server correctly answers with nothing, so they are dropped here.
                const allowed = new Set(
                  (machines ?? [])
                    .filter((m) => next.length === 0 || (m.shopId && next.includes(m.shopId)))
                    .map((m) => m.id),
                );
                filters.setExtra('tills', draftTills.filter((id) => allowed.has(id)).join(','));
              }}
              allLabel={t('filters.allShops')}
              clearLabel={t('filters.clear')}
              emptyLabel={t('filters.noShops')}
            />
            <EntityMultiSelect
              label={t('filters.machines')}
              options={machineOptions}
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
      export={data ? { tables: [days, zs] as ReportTableSpec<unknown>[], from: data.window.from, to: data.window.to } : null}
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

