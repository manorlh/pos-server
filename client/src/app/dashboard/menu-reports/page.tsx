'use client';

/**
 * Menu reports (docs/SPEC_MENU_MODIFIERS.md §10.4):
 *
 * * תוספות — how often each option was chosen and what it brought in; removals apart.
 * * ארוחות — each meal and its components, with the meal's money allocated to them
 *   (upcharges and paid modifiers to their component, the base by list price).
 * * הגדלות מכירה — per rule: shown, taken, dismissed, the rate, and the taken lines' money.
 *
 * Server: `GET /reports/modifier-sales`, `/reports/meal-sales`, `/reports/upsells`.
 */

import { Fragment, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { usePageScope } from '@/lib/scope';
import { formatCurrency, formatQuantity } from '@/lib/format';
import { WHOLE_DAY, daysBackIso, hourQueryParams, todayIso } from '@/lib/reportWindow';
import {
  fetchMealSalesReport,
  fetchModifierSalesReport,
  fetchUpsellReport,
  type MealSalesReport,
  type ModifierSalesReport,
  type UpsellReport,
} from '@/lib/menuApi';
import { ScopeGate } from '@/components/dashboard/scope-gate';
import { ReportFilters, type ReportFiltersState } from '@/components/dashboard/report-filters';
import { ReportExportToolbar } from '@/components/dashboard/report-export-toolbar';
import { ReportErrorState, ReportWindowSummary } from '@/components/dashboard/report-window-summary';
import { IosSegmented, IosTag } from '@/components/dashboard/menu/ios';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table';

type Tab = 'modifiers' | 'meals' | 'upsells';

export default function MenuReportsPage() {
  const t = useTranslations('menuReports');
  const tc = useTranslations('common');
  const { resolution, effective } = usePageScope({ maxLevel: 'machine', unsupported: ['company'] });
  const [tab, setTab] = useState<Tab>('modifiers');
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

  const modifiers = useQuery<ModifierSalesReport>({
    queryKey: ['report-modifier-sales', params],
    queryFn: () => fetchModifierSalesReport(params!),
    enabled: params !== null && tab === 'modifiers',
  });
  const meals = useQuery<MealSalesReport>({
    queryKey: ['report-meal-sales', params],
    queryFn: () => fetchMealSalesReport(params!),
    enabled: params !== null && tab === 'meals',
  });
  const upsells = useQuery<UpsellReport>({
    queryKey: ['report-upsells', params],
    queryFn: () => fetchUpsellReport(params!),
    enabled: params !== null && tab === 'upsells',
  });
  const current = tab === 'modifiers' ? modifiers : tab === 'meals' ? meals : upsells;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>
      <IosSegmented
        className="max-w-md"
        value={tab}
        onChange={setTab}
        options={[
          { id: 'modifiers', label: t('tabs.modifiers') },
          { id: 'meals', label: t('tabs.meals') },
          { id: 'upsells', label: t('tabs.upsells') },
        ]}
      />
      <ScopeGate resolution={resolution}>
        <ReportFilters value={filters} onChange={setFilters} onRun={() => setApplied(filters)} isFetching={current.isFetching} />
        {!applied ? (
          <p className="py-12 text-center text-sm text-muted-foreground">{t('selectFilters')}</p>
        ) : current.isLoading ? (
          <Skeleton className="h-64 w-full" />
        ) : current.isError ? (
          <ReportErrorState message={axiosErrorToToastMessage(current.error, tc('error'))} />
        ) : tab === 'modifiers' && modifiers.data ? (
          <ModifiersView data={modifiers.data} />
        ) : tab === 'meals' && meals.data ? (
          <MealsView data={meals.data} />
        ) : tab === 'upsells' && upsells.data ? (
          <UpsellsView data={upsells.data} />
        ) : null}
      </ScopeGate>
    </div>
  );
}

function ModifiersView({ data }: { data: ModifierSalesReport }) {
  const t = useTranslations('menuReports');
  const tk = useTranslations('menu.kind');
  return (
    <div className="space-y-4">
      <ReportExportToolbar
        title={t('modifiersTitle')}
        from={data.window.from}
        to={data.window.to}
        getSheets={() => [
          {
            name: t('modifiersTitle'),
            columns: [
              { header: t('col.group') },
              { header: t('col.option') },
              { header: t('col.kind') },
              { header: t('col.units'), kind: 'number' as const },
              { header: t('col.revenue'), kind: 'money' as const },
              { header: t('col.refunds'), kind: 'money' as const },
              { header: t('col.net'), kind: 'money' as const },
            ],
            rows: data.rows.map((r) => [r.groupName ?? '', r.name ?? '', r.kind ? tk(r.kind) : '', r.unitsNet, r.revenue, r.refunds, r.net]),
            totals: [t('total'), '', '', data.totals.units, data.totals.revenue, data.totals.refunds, data.totals.net],
          },
        ]}
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
                  <TableHead>{t('col.option')}</TableHead>
                  <TableHead>{t('col.group')}</TableHead>
                  <TableHead className="text-end">{t('col.units')}</TableHead>
                  <TableHead className="text-end">{t('col.revenue')}</TableHead>
                  <TableHead className="text-end">{t('col.refunds')}</TableHead>
                  <TableHead className="text-end">{t('col.net')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.rows.map((r, i) => (
                  <TableRow key={r.optionId ?? `r${i}`}>
                    <TableCell className="font-medium">
                      <span className="me-2">{r.name ?? '—'}</span>
                      {r.kind ? <IosTag tone={r.kind === 'removal' ? 'red' : r.kind === 'choice' ? 'blue' : 'green'}>{tk(r.kind)}</IosTag> : null}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{r.groupName ?? '—'}</TableCell>
                    <TableCell className="text-end tabular-nums">{formatQuantity(r.unitsNet)}</TableCell>
                    <TableCell className="text-end tabular-nums">{formatCurrency(r.revenue)}</TableCell>
                    <TableCell className="text-end tabular-nums">{formatCurrency(r.refunds)}</TableCell>
                    <TableCell className="text-end font-semibold tabular-nums">{formatCurrency(r.net)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
              <TableFooter>
                <TableRow>
                  <TableCell className="font-semibold">{t('total')}</TableCell>
                  <TableCell className="text-muted-foreground">{t('removals', { n: formatQuantity(data.totals.removals) })}</TableCell>
                  <TableCell className="text-end tabular-nums">{formatQuantity(data.totals.units)}</TableCell>
                  <TableCell className="text-end tabular-nums">{formatCurrency(data.totals.revenue)}</TableCell>
                  <TableCell className="text-end tabular-nums">{formatCurrency(data.totals.refunds)}</TableCell>
                  <TableCell className="text-end font-bold tabular-nums">{formatCurrency(data.totals.net)}</TableCell>
                </TableRow>
              </TableFooter>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function MealsView({ data }: { data: MealSalesReport }) {
  const t = useTranslations('menuReports');
  return (
    <div className="space-y-4">
      <ReportExportToolbar
        title={t('mealsTitle')}
        from={data.window.from}
        to={data.window.to}
        getSheets={() => [
          {
            name: t('mealsTitle'),
            columns: [
              { header: t('col.meal') },
              { header: t('col.component') },
              { header: t('col.units'), kind: 'number' as const },
              { header: t('col.gross'), kind: 'money' as const },
              { header: t('col.discounts'), kind: 'money' as const },
              { header: t('col.upcharges'), kind: 'money' as const },
              { header: t('col.net'), kind: 'money' as const },
            ],
            rows: data.rows.flatMap((m) => [
              [m.name ?? '', '', m.unitsNet, m.gross, m.discounts, 0, m.net],
              ...m.components.map((c) => [m.name ?? '', c.name ?? '', c.units, c.gross, c.discounts, c.upcharges, c.net]),
            ]),
            totals: [t('total'), '', data.totals.units, data.totals.gross, data.totals.discounts, '', data.totals.net],
          },
        ]}
      />
      <ReportWindowSummary window={data.window} generatedAt={data.generatedAt} />
      <p className="text-xs text-muted-foreground">{t('allocationNote')}</p>
      {data.rows.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">{t('noRows')}</p>
      ) : (
        <Card>
          <CardContent className="overflow-x-auto p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('col.meal')}</TableHead>
                  <TableHead className="text-end">{t('col.units')}</TableHead>
                  <TableHead className="text-end">{t('col.gross')}</TableHead>
                  <TableHead className="text-end">{t('col.discounts')}</TableHead>
                  <TableHead className="text-end">{t('col.upcharges')}</TableHead>
                  <TableHead className="text-end">{t('col.net')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.rows.map((m, i) => (
                  <Fragment key={m.productId ?? `m${i}`}>
                    <TableRow className="bg-muted/30">
                      <TableCell className="font-semibold">
                        {m.name ?? '—'}
                        {m.unredeemed?.length || m.takenLater || m.refills ? (
                          <span className="block text-[11px] font-normal text-muted-foreground">
                            {[
                              m.unredeemed?.length
                                ? t('unredeemed', { items: m.unredeemed.map((u) => `${u.slotName} ×${formatQuantity(u.count)}`).join(', ') })
                                : null,
                              m.takenLater ? t('takenLater', { n: formatQuantity(m.takenLater) }) : null,
                              m.refills ? t('refills', { n: formatQuantity(m.refills) }) : null,
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-end tabular-nums">{formatQuantity(m.unitsNet)}</TableCell>
                      <TableCell className="text-end tabular-nums">{formatCurrency(m.gross)}</TableCell>
                      <TableCell className="text-end tabular-nums">{formatCurrency(m.discounts)}</TableCell>
                      <TableCell />
                      <TableCell className="text-end font-semibold tabular-nums">{formatCurrency(m.net)}</TableCell>
                    </TableRow>
                    {m.components.map((c, k) => (
                      <TableRow key={`${m.productId}-${c.productId ?? k}`}>
                        <TableCell className="ps-8 text-muted-foreground">{c.name ?? '—'}</TableCell>
                        <TableCell className="text-end tabular-nums text-muted-foreground">{formatQuantity(c.units)}</TableCell>
                        <TableCell className="text-end tabular-nums text-muted-foreground">{formatCurrency(c.gross)}</TableCell>
                        <TableCell className="text-end tabular-nums text-muted-foreground">{formatCurrency(c.discounts)}</TableCell>
                        <TableCell className="text-end tabular-nums text-muted-foreground">{formatCurrency(c.upcharges)}</TableCell>
                        <TableCell className="text-end tabular-nums text-muted-foreground">{formatCurrency(c.net)}</TableCell>
                      </TableRow>
                    ))}
                  </Fragment>
                ))}
              </TableBody>
              <TableFooter>
                <TableRow>
                  <TableCell className="font-semibold">{t('total')}</TableCell>
                  <TableCell className="text-end tabular-nums">{formatQuantity(data.totals.units)}</TableCell>
                  <TableCell className="text-end tabular-nums">{formatCurrency(data.totals.gross)}</TableCell>
                  <TableCell className="text-end tabular-nums">{formatCurrency(data.totals.discounts)}</TableCell>
                  <TableCell />
                  <TableCell className="text-end font-bold tabular-nums">{formatCurrency(data.totals.net)}</TableCell>
                </TableRow>
              </TableFooter>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function UpsellsView({ data }: { data: UpsellReport }) {
  const t = useTranslations('menuReports');
  const tu = useTranslations('upsells');
  const pct = (r: number | null) => (r === null ? '—' : `${Math.round(r * 100)}%`);
  return (
    <div className="space-y-4">
      <ReportExportToolbar
        title={t('upsellsTitle')}
        from={data.window.from}
        to={data.window.to}
        getSheets={() => [
          {
            name: t('upsellsTitle'),
            columns: [
              { header: t('col.rule') },
              { header: t('col.shown'), kind: 'number' as const },
              { header: t('col.accepted'), kind: 'number' as const },
              { header: t('col.dismissed'), kind: 'number' as const },
              { header: t('col.rate') },
              { header: t('col.revenue'), kind: 'money' as const },
            ],
            rows: data.rows.map((r) => [r.name ?? '', r.shown, r.accepted, r.dismissed, pct(r.acceptanceRate), r.revenue]),
            totals: [t('total'), data.totals.shown, data.totals.accepted, data.totals.dismissed, pct(data.totals.acceptanceRate), data.totals.revenue],
          },
        ]}
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
                  <TableHead>{t('col.rule')}</TableHead>
                  <TableHead className="text-end">{t('col.shown')}</TableHead>
                  <TableHead className="text-end">{t('col.accepted')}</TableHead>
                  <TableHead className="text-end">{t('col.dismissed')}</TableHead>
                  <TableHead className="text-end">{t('col.rate')}</TableHead>
                  <TableHead className="text-end">{t('col.revenue')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.rows.map((r) => (
                  <TableRow key={r.ruleId}>
                    <TableCell className="font-medium">
                      <span className="me-2">{r.name ?? t('deletedRule')}</span>
                      {r.action ? <IosTag tone={r.action === 'upgrade' ? 'blue' : 'green'}>{tu(`action.${r.action}`)}</IosTag> : null}
                    </TableCell>
                    <TableCell className="text-end tabular-nums">{formatQuantity(r.shown)}</TableCell>
                    <TableCell className="text-end tabular-nums">{formatQuantity(r.accepted)}</TableCell>
                    <TableCell className="text-end tabular-nums">{formatQuantity(r.dismissed)}</TableCell>
                    <TableCell className="text-end font-semibold tabular-nums">{pct(r.acceptanceRate)}</TableCell>
                    <TableCell className="text-end tabular-nums">{formatCurrency(r.revenue)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
              <TableFooter>
                <TableRow>
                  <TableCell className="font-semibold">{t('total')}</TableCell>
                  <TableCell className="text-end tabular-nums">{formatQuantity(data.totals.shown)}</TableCell>
                  <TableCell className="text-end tabular-nums">{formatQuantity(data.totals.accepted)}</TableCell>
                  <TableCell className="text-end tabular-nums">{formatQuantity(data.totals.dismissed)}</TableCell>
                  <TableCell className="text-end font-bold tabular-nums">{pct(data.totals.acceptanceRate)}</TableCell>
                  <TableCell className="text-end font-bold tabular-nums">{formatCurrency(data.totals.revenue)}</TableCell>
                </TableRow>
              </TableFooter>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
