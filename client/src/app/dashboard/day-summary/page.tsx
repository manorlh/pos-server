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
 * It is not a Z. It closes nothing, it is not a fiscal document, and there is
 * deliberately no print action.
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import {
  CalendarDays,
  ChevronDown,
  ChevronRight,
  Coins,
  CreditCard,
  Info,
  Percent,
  ReceiptText,
  Scale,
  Wallet,
} from 'lucide-react';
import {
  fetchDaySummaryReport,
  fetchMachines,
  fetchShops,
} from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { usePageScope } from '@/lib/scope';
import { ScopeGate } from '@/components/dashboard/scope-gate';
import { formatCurrency, formatQuantity } from '@/lib/format';
import { daysBackIso, todayIso } from '@/lib/reportWindow';
import type { DaySummaryReport, DaySummaryRow, DaySummaryTotals } from '@/lib/types';
import { EntityMultiSelect, type MultiSelectOption } from '@/components/dashboard/entity-multi-select';
import { ReportStatCard } from '@/components/dashboard/report-stat-card';
import {
  ReportErrorState,
  ReportWindowSummary,
} from '@/components/dashboard/report-window-summary';
import { useZNumberLabel } from '@/components/dashboard/z-report/z-number';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

/** Day row + the expander cell. */
const COLS = 10;

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

function DayRow({ row }: { row: DaySummaryRow }) {
  const t = useTranslations('daySummary');
  const tz = useTranslations('zReports');
  // A till Z has no shop number: it reads "קופה 2 · Z 12", never "#null".
  const zNumberLabel = useZNumberLabel();
  const [open, setOpen] = useState(false);
  const Chevron = open ? ChevronDown : ChevronRight;

  return (
    <>
      <TableRow className="cursor-pointer" onClick={() => setOpen((v) => !v)}>
        <TableCell className="w-8">
          <Chevron className="text-muted-foreground h-4 w-4" aria-hidden />
        </TableCell>
        <TableCell className="font-medium">{row.dayDate}</TableCell>
        <TableCell className="text-end tabular-nums">
          {row.machineCount}
          {/* Several Zs in a day (a Z per till, or a second run) are ordinary, so the
              Z count is shown whenever it differs rather than being silently collapsed. */}
          {row.zReportCount !== row.machineCount ? (
            <span className="text-muted-foreground ms-1 text-xs">
              {t('table.zCount', { count: row.zReportCount })}
            </span>
          ) : null}
        </TableCell>
        <TableCell className="text-end tabular-nums font-medium">
          {formatCurrency(row.totals.net)}
        </TableCell>
        <TableCell className="text-end tabular-nums">{formatCurrency(row.totals.refunds)}</TableCell>
        <TableCell className="bg-muted/40 text-end tabular-nums">
          {formatCurrency(row.totals.cashSales)}
        </TableCell>
        <TableCell className="bg-muted/40 text-end tabular-nums">
          {formatCurrency(row.totals.cardSales)}
        </TableCell>
        <TableCell className="text-end">
          <MaybeMoney value={row.totals.vat} unavailableLabel={t('unavailable.short')} />
        </TableCell>
        <TableCell className="text-end tabular-nums">{formatCurrency(row.totals.tips)}</TableCell>
        <TableCell className="text-end">
          <VarianceCell totals={row.totals} />
        </TableCell>
      </TableRow>

      {open ? (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={COLS} className="bg-muted/20 p-0">
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
                      </TableCell>
                      <TableCell className="font-medium">
                        {c.machineName ?? c.machineId}
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
                      <TableCell className="text-muted-foreground">{c.shopName ?? '—'}</TableCell>
                      <TableCell className="text-end tabular-nums">{formatCurrency(c.net)}</TableCell>
                      <TableCell className="text-end tabular-nums">
                        {formatCurrency(c.cashSales)}
                      </TableCell>
                      <TableCell className="text-end tabular-nums">
                        {formatCurrency(c.cardSales)}
                      </TableCell>
                      <TableCell className="text-end tabular-nums">{formatCurrency(c.tips)}</TableCell>
                      <TableCell className="text-end tabular-nums">
                        {formatCurrency(c.expectedCash)}
                      </TableCell>
                      <TableCell className="text-end">
                        <MaybeMoney
                          value={c.actualCash}
                          unavailableLabel={t('drill.notCounted')}
                        />
                      </TableCell>
                      <TableCell className="text-end">
                        <MaybeMoney
                          value={c.discrepancy}
                          unavailableLabel={t('unavailable.short')}
                        />
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
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
}

export default function DaySummaryPage() {
  const t = useTranslations('daySummary');
  const tc = useTranslations('common');

  // The scope still applies — it decides what the multi-selects can even offer —
  // but the selection itself is explicit, because "these three branches" is not a
  // position in the hierarchy.
  const { resolution, effective } = usePageScope({ maxLevel: 'machine' });
  const scopeCompanyId = effective.companyId;
  const scopeShopId = effective.shopId;
  const scopeMachineId = effective.machineId;

  const [from, setFrom] = useState(daysBackIso(6));
  const [to, setTo] = useState(todayIso());
  const [shopIds, setShopIds] = useState<string[]>([]);
  const [machineIds, setMachineIds] = useState<string[]>([]);
  const [applied, setApplied] = useState<{
    from: string;
    to: string;
    shopIds: string[];
    machineIds: string[];
  } | null>(null);

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
    const chosenShops = new Set(shopIds);
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
  }, [machines, scopeMachineId, scopeShopId, shopIds, shops]);

  const params = useMemo(() => {
    if (!applied) return null;
    const effectiveShops = applied.shopIds.length
      ? applied.shopIds
      : scopeShopId
        ? [scopeShopId]
        : [];
    const effectiveMachines = applied.machineIds.length
      ? applied.machineIds
      : scopeMachineId
        ? [scopeMachineId]
        : [];
    return {
      from: applied.from,
      to: applied.to,
      ...(effectiveShops.length ? { shopIds: effectiveShops } : {}),
      ...(effectiveMachines.length ? { machineIds: effectiveMachines } : {}),
    };
  }, [applied, scopeMachineId, scopeShopId]);

  const { data, isLoading, isFetching, isError, error } = useQuery<DaySummaryReport>({
    queryKey: ['report-day-summary', params],
    queryFn: () => fetchDaySummaryReport(params!),
    enabled: params !== null,
  });

  const rangeInvalid = from > to;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
      </div>

      <ScopeGate resolution={resolution}>
        <Card>
          <CardContent className="grid gap-4 pt-6 md:grid-cols-2 xl:grid-cols-5">
            <div className="space-y-1.5">
              <Label htmlFor="day-summary-from">{t('filters.from')}</Label>
              <Input
                id="day-summary-from"
                type="date"
                value={from}
                max={to}
                onChange={(e) => setFrom(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="day-summary-to">{t('filters.to')}</Label>
              <Input
                id="day-summary-to"
                type="date"
                value={to}
                min={from}
                onChange={(e) => setTo(e.target.value)}
              />
            </div>
            <EntityMultiSelect
              label={t('filters.shops')}
              options={shopOptions}
              selected={shopIds}
              onChange={(next) => {
                setShopIds(next);
                // Tills outside the new shop selection would be a contradiction the
                // server correctly answers with nothing, so they are dropped here.
                const allowed = new Set(
                  (machines ?? [])
                    .filter((m) => next.length === 0 || (m.shopId && next.includes(m.shopId)))
                    .map((m) => m.id),
                );
                setMachineIds((prev) => prev.filter((id) => allowed.has(id)));
              }}
              allLabel={t('filters.allShops')}
              clearLabel={t('filters.clear')}
              emptyLabel={t('filters.noShops')}
            />
            <EntityMultiSelect
              label={t('filters.machines')}
              options={machineOptions}
              selected={machineIds}
              onChange={setMachineIds}
              allLabel={t('filters.allMachines')}
              clearLabel={t('filters.clear')}
              emptyLabel={t('filters.noMachines')}
            />
            <div className="flex items-end">
              <Button
                className="w-full"
                disabled={rangeInvalid || isFetching}
                onClick={() => setApplied({ from, to, shopIds, machineIds })}
              >
                {isFetching ? tc('loading') : t('filters.run')}
              </Button>
            </div>
          </CardContent>
        </Card>

        {rangeInvalid ? (
          <p className="text-destructive py-2 text-sm">{t('filters.rangeInvalid')}</p>
        ) : null}

        {!applied ? (
          <p className="text-muted-foreground py-12 text-center text-sm">{t('selectFilters')}</p>
        ) : isLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-24 w-full" />
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-28 w-full" />
              ))}
            </div>
            <Skeleton className="h-64 w-full" />
          </div>
        ) : isError ? (
          <ReportErrorState message={axiosErrorToToastMessage(error, tc('error'))} />
        ) : data ? (
          <div className="space-y-4">
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
                subtitle={t('totals.cardIs', {
                  card: formatCurrency(data.totals.cardSales),
                })}
                icon={CreditCard}
              />
              <ReportStatCard
                title={t('totals.vat')}
                value={
                  data.totals.vat === null ? t('unavailable.short') : formatCurrency(data.totals.vat)
                }
                subtitle={
                  data.totals.vat === null
                    ? t('unavailable.vatReason', { count: data.totals.vatMissingCount })
                    : undefined
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
                value={
                  data.totals.variance === null
                    ? t('unavailable.short')
                    : formatCurrency(data.totals.variance)
                }
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
                  <CalendarDays
                    className="text-muted-foreground mx-auto mb-3 h-8 w-8"
                    aria-hidden
                  />
                  <p className="text-sm font-medium">{t('empty.title')}</p>
                  {/* Says *why* rather than looking like a failed query: this report
                      is made of Z reports, so an unclosed day has nothing to show. */}
                  <p className="text-muted-foreground mx-auto mt-1 max-w-md text-sm">
                    {t('empty.body')}
                  </p>
                </CardContent>
              </Card>
            ) : (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-sm font-medium">
                    <ReceiptText className="text-muted-foreground h-4 w-4" aria-hidden />
                    {t('table.title')}
                  </CardTitle>
                </CardHeader>
                <CardContent className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-8" />
                        <TableHead>{t('table.day')}</TableHead>
                        <TableHead className="text-end">{t('table.tills')}</TableHead>
                        <TableHead className="text-end">{t('table.net')}</TableHead>
                        <TableHead className="text-end">{t('table.refunds')}</TableHead>
                        <TableHead className="bg-muted/40 text-end">{t('table.cash')}</TableHead>
                        <TableHead className="bg-muted/40 text-end">{t('table.card')}</TableHead>
                        <TableHead className="text-end">{t('table.vat')}</TableHead>
                        <TableHead className="text-end">{t('table.tips')}</TableHead>
                        <TableHead className="text-end">{t('table.variance')}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.days.map((row) => (
                        <DayRow key={row.dayDate} row={row} />
                      ))}
                    </TableBody>
                    <TableFooter>
                      <TableRow>
                        <TableCell />
                        <TableCell className="font-medium">{t('table.total')}</TableCell>
                        <TableCell className="text-end tabular-nums">
                          {formatQuantity(data.totals.transactionsCount)}
                          <span className="text-muted-foreground ms-1 text-xs">
                            {t('table.documents')}
                          </span>
                        </TableCell>
                        <TableCell className="text-end tabular-nums font-medium">
                          {formatCurrency(data.totals.net)}
                        </TableCell>
                        <TableCell className="text-end tabular-nums">
                          {formatCurrency(data.totals.refunds)}
                        </TableCell>
                        <TableCell className="bg-muted/40 text-end tabular-nums">
                          {formatCurrency(data.totals.cashSales)}
                        </TableCell>
                        <TableCell className="bg-muted/40 text-end tabular-nums">
                          {formatCurrency(data.totals.cardSales)}
                        </TableCell>
                        <TableCell className="text-end">
                          <MaybeMoney
                            value={data.totals.vat}
                            unavailableLabel={t('unavailable.short')}
                          />
                        </TableCell>
                        <TableCell className="text-end tabular-nums">
                          {formatCurrency(data.totals.tips)}
                        </TableCell>
                        <TableCell className="text-end">
                          <VarianceCell totals={data.totals} />
                        </TableCell>
                      </TableRow>
                    </TableFooter>
                  </Table>
                </CardContent>
              </Card>
            )}

            <Card>
              <CardContent className="text-muted-foreground flex items-start gap-2 py-4 text-xs">
                <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                {/* Stated on the page, not just in the code: someone will eventually
                    ask whether this can be filed or printed for the accountant. */}
                <p>{t('notFiscal')}</p>
              </CardContent>
            </Card>
          </div>
        ) : null}
      </ScopeGate>
    </div>
  );
}
