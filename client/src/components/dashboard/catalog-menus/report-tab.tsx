'use client';

/**
 * "דוח לפי תפריט" — the takings by the menu that was active on the till when each line
 * was added ("ללא תפריט" — none was): units sold and refunded, gross, discounts, refunds,
 * net, and how much was sold at the menu's own price. Server: `GET /reports/menu-sales`,
 * with the usual window and shop / till scope (as the other menu reports).
 */

import { useCallback, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { usePageScope } from '@/lib/scope';
import type { ReportWindowParams } from '@/lib/api';
import { previousWindow } from '@/lib/designedReport';
import { formatCurrency, formatHour, formatQuantity } from '@/lib/format';
import { WHOLE_DAY, daysBackIso, hourQueryParams, todayIso } from '@/lib/reportWindow';
import { fetchMenuSalesReport, type MenuSalesReport, type MenuSalesRow } from '@/lib/catalogMenusApi';
import { ScopeGate } from '@/components/dashboard/scope-gate';
import { ReportFilters, type ReportFiltersState } from '@/components/dashboard/report-filters';
import {
  StandaloneExportBar,
  type PreviousPeriod,
  type ReportKpi,
  type ReportTableSpec,
} from '@/components/dashboard/report-framework';
import { ReportErrorState, ReportWindowSummary } from '@/components/dashboard/report-window-summary';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ColorDot, useCatalogMenus, useMenuErrorText } from './shared';

export function ReportTab() {
  const t = useTranslations('catalogMenus.report');
  const { resolution, effective } = usePageScope({ maxLevel: 'machine', unsupported: ['company'] });
  const errorText = useMenuErrorText();
  const [filters, setFilters] = useState<ReportFiltersState>({ from: daysBackIso(6), to: todayIso(), hours: WHOLE_DAY });
  const [applied, setApplied] = useState<ReportFiltersState | null>(null);

  const params = useMemo(() => {
    if (!applied) return null;
    return {
      from: applied.from,
      to: applied.to,
      ...(effective.shopId ? { shopId: effective.shopId } : {}),
      ...(effective.machineId ? { machineId: effective.machineId } : {}),
      ...hourQueryParams(applied.hours),
    };
  }, [applied, effective.shopId, effective.machineId]);

  const report = useQuery<MenuSalesReport>({
    queryKey: ['report-menu-sales', params],
    queryFn: () => fetchMenuSalesReport(params!),
    enabled: params !== null,
  });

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t('note')}</p>
      <ScopeGate resolution={resolution}>
        <ReportFilters value={filters} onChange={setFilters} onRun={() => setApplied(filters)} isFetching={report.isFetching} />
        {!applied ? (
          <p className="py-12 text-center text-sm text-muted-foreground">{t('selectFilters')}</p>
        ) : report.isLoading ? (
          <Skeleton className="h-64 w-full" />
        ) : report.isError ? (
          <ReportErrorState message={errorText(report.error)} />
        ) : report.data && params ? (
          <ReportView data={report.data} params={params} />
        ) : null}
      </ScopeGate>
    </div>
  );
}

/** The report's figures by KPI key (the footer's totals). */
function menuKpis(data: MenuSalesReport) {
  return {
    net: data.totals.net,
    gross: data.totals.gross,
    units: data.totals.units,
    discounts: data.rows.reduce((s, r) => s + r.discounts, 0),
    refunds: data.totals.refunds,
  };
}

function ReportView({ data, params }: { data: MenuSalesReport; params: ReportWindowParams }) {
  const t = useTranslations('catalogMenus.report');
  const menus = useCatalogMenus();
  const colors = useMemo(() => new Map((menus.data?.menus ?? []).map((m) => [m.id, m.color])), [menus.data]);
  const nameOf = useCallback((r: MenuSalesRow) => (r.menuId === null ? t('noMenu') : (r.menuName ?? t('deleted'))), [t]);
  const share = (r: { menuPricedGross: number; gross: number }) =>
    r.gross > 0 ? `${Math.round((r.menuPricedGross / r.gross) * 100)}%` : '—';
  const totals = useMemo(
    () =>
      data.rows.reduce(
        (s, r) => ({
          unitsRefunded: s.unitsRefunded + r.unitsRefunded,
          discounts: s.discounts + r.discounts,
          menuPricedUnits: s.menuPricedUnits + r.menuPricedUnits,
          menuPricedGross: s.menuPricedGross + r.menuPricedGross,
        }),
        { unitsRefunded: 0, discounts: 0, menuPricedUnits: 0, menuPricedGross: 0 },
      ),
    [data.rows],
  );

  /** The table as the export writes it, with the footer's totals. */
  const exportTable = useMemo<ReportTableSpec<MenuSalesRow>>(
    () => ({
      id: 'main',
      title: t('title'),
      columns: [
        { key: 'menu', header: t('col.menu'), value: nameOf, required: true },
        { key: 'unitsSold', header: t('col.unitsSold'), kind: 'number', value: (r) => r.unitsSold, total: data.totals.units },
        { key: 'unitsRefunded', header: t('col.unitsRefunded'), kind: 'number', value: (r) => r.unitsRefunded, total: totals.unitsRefunded },
        { key: 'gross', header: t('col.gross'), kind: 'money', value: (r) => r.gross, total: data.totals.gross },
        { key: 'discounts', header: t('col.discounts'), kind: 'money', value: (r) => r.discounts, total: totals.discounts },
        { key: 'refunds', header: t('col.refunds'), kind: 'money', value: (r) => r.refunds, total: data.totals.refunds },
        { key: 'net', header: t('col.net'), kind: 'money', value: (r) => r.net, total: data.totals.net },
        { key: 'menuPricedUnits', header: t('col.menuPricedUnits'), kind: 'number', value: (r) => r.menuPricedUnits, total: totals.menuPricedUnits },
        { key: 'menuPricedGross', header: t('col.menuPricedGross'), kind: 'money', value: (r) => r.menuPricedGross, total: totals.menuPricedGross },
      ],
      rows: data.rows,
      rowKey: (r, i) => r.menuId ?? `none-${i}`,
      totalsLabel: t('total'),
    }),
    [data, nameOf, t, totals],
  );
  const figures = menuKpis(data);
  const exportKpis: ReportKpi[] = [
    { key: 'net', label: t('col.net'), value: figures.net, kind: 'money', icon: 'sales' },
    { key: 'gross', label: t('col.gross'), value: figures.gross, kind: 'money', icon: 'receipt' },
    { key: 'units', label: t('col.unitsSold'), value: figures.units, kind: 'count', icon: 'items' },
    { key: 'discounts', label: t('col.discounts'), value: figures.discounts, kind: 'money', icon: 'discount' },
    { key: 'refunds', label: t('col.refunds'), value: figures.refunds, kind: 'money', icon: 'refund' },
  ];
  const { fromHour, toHour } = data.window;
  const hours =
    fromHour != null && toHour != null && !(fromHour === 0 && toHour === 24)
      ? `${formatHour(fromHour)}–${formatHour(toHour)}`
      : null;
  /** The same report (scope and hours) for the period before. */
  const previous = async (): Promise<PreviousPeriod | null> => {
    const before = previousWindow(params.from, params.to);
    if (!before) return null;
    const prev = await fetchMenuSalesReport({ ...params, ...before });
    return { rows: prev.rows, kpis: menuKpis(prev), ...before };
  };

  return (
    <div className="space-y-4">
      <StandaloneExportBar
        reportKey="menu-sales"
        reportType="menus"
        title={t('title')}
        tables={[exportTable as ReportTableSpec<unknown>]}
        from={data.window.from}
        to={data.window.to}
        hours={hours}
        kpis={exportKpis}
        chartFrom={{ label: 'menu', value: 'net' }}
        previous={previous}
      />
      <ReportWindowSummary window={data.window} generatedAt={data.generatedAt} />
      {data.rows.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">{t('noRows')}</p>
      ) : (
        <Card>
          <CardContent className="overflow-x-auto p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('col.menu')}</TableHead>
                  <TableHead className="text-end">{t('col.unitsSold')}</TableHead>
                  <TableHead className="text-end">{t('col.unitsRefunded')}</TableHead>
                  <TableHead className="text-end">{t('col.gross')}</TableHead>
                  <TableHead className="text-end">{t('col.discounts')}</TableHead>
                  <TableHead className="text-end">{t('col.refunds')}</TableHead>
                  <TableHead className="text-end">{t('col.net')}</TableHead>
                  <TableHead className="text-end">{t('col.menuPriced')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.rows.map((r, i) => (
                  <TableRow key={r.menuId ?? `none-${i}`}>
                    <TableCell className="font-medium">
                      <span className="inline-flex items-center gap-1.5">
                        {r.menuId ? <ColorDot color={colors.get(r.menuId)} /> : null}
                        <span className={r.menuId === null ? 'text-muted-foreground' : undefined}>{nameOf(r)}</span>
                      </span>
                    </TableCell>
                    <TableCell className="text-end tabular-nums">{formatQuantity(r.unitsSold)}</TableCell>
                    <TableCell className="text-end tabular-nums">{formatQuantity(r.unitsRefunded)}</TableCell>
                    <TableCell className="text-end tabular-nums">{formatCurrency(r.gross)}</TableCell>
                    <TableCell className="text-end tabular-nums">{formatCurrency(r.discounts)}</TableCell>
                    <TableCell className="text-end tabular-nums">{formatCurrency(r.refunds)}</TableCell>
                    <TableCell className="text-end font-semibold tabular-nums">{formatCurrency(r.net)}</TableCell>
                    <TableCell className="text-end tabular-nums">
                      {r.menuId === null ? (
                        '—'
                      ) : (
                        <>
                          {share(r)}
                          <span className="block text-[11px] text-muted-foreground">
                            {t('menuPricedLine', { units: formatQuantity(r.menuPricedUnits), gross: formatCurrency(r.menuPricedGross) })}
                          </span>
                        </>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
              <TableFooter>
                <TableRow>
                  <TableCell className="font-semibold">{t('total')}</TableCell>
                  <TableCell className="text-end tabular-nums">{formatQuantity(data.totals.units)}</TableCell>
                  <TableCell className="text-end tabular-nums">{formatQuantity(totals.unitsRefunded)}</TableCell>
                  <TableCell className="text-end tabular-nums">{formatCurrency(data.totals.gross)}</TableCell>
                  <TableCell className="text-end tabular-nums">{formatCurrency(totals.discounts)}</TableCell>
                  <TableCell className="text-end tabular-nums">{formatCurrency(data.totals.refunds)}</TableCell>
                  <TableCell className="text-end font-bold tabular-nums">{formatCurrency(data.totals.net)}</TableCell>
                  <TableCell className="text-end tabular-nums">
                    {share({ menuPricedGross: totals.menuPricedGross, gross: data.totals.gross })}
                  </TableCell>
                </TableRow>
              </TableFooter>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
