'use client';

/**
 * Menu reports (docs/SPEC_MENU_MODIFIERS.md §10.4):
 *
 * * תוספות — how often each option was chosen and what it brought in; removals apart.
 * * ארוחות — each meal and its components, with the meal's money allocated to them
 *   (upcharges and paid modifiers to their component, the base by list price).
 * * הגדלות מכירה — per rule: shown, taken, dismissed, declined ("הלקוח סירב" in the
 *   window), the rate, the taken lines' money, and which options were taken.
 *
 * Server: `GET /reports/modifier-sales`, `/reports/meal-sales`, `/reports/upsells` — days,
 * hours, shop and till (no company, area or cashier).
 *
 * On the report framework (P:\specs\reports-upgrade.md §5): the filters in the URL, the tab
 * too (`?tab=meals`, kept by "הפק דוח" and "נקה הכל"); each tab is a report of its own
 * (lib/menuTargetsReports.ts `MENU_REPORT_KEYS`) with its columns, Excel and PDF. The meals
 * keep their hierarchy — each meal with its components right under it — so that table does
 * not sort by a column.
 */

import { useMemo } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { usePageScope } from '@/lib/scope';
import { formatCurrency, formatQuantity } from '@/lib/format';
import { scopeApiParams, type ReportFilterSpec } from '@/lib/reportFilters';
import {
  fetchMealSalesReport,
  fetchModifierSalesReport,
  fetchUpsellReport,
  type MealComponentRow,
  type MealSalesReport,
  type MealSalesRow,
  type ModifierSalesReport,
  type ModifierSalesRow,
  type UpsellReport,
  type UpsellReportRow,
} from '@/lib/menuApi';
import {
  MENU_REPORT_KEYS,
  MENU_REPORT_TAB_PARAM,
  mealLines,
  mealNotes,
  optionsTakenText,
  parseMenuReportTab,
  ratePercent,
  rateText,
  withMenuReportTab,
  type MealLine,
  type MenuReportTab,
} from '@/lib/menuTargetsReports';
import { ReportWindowSummary } from '@/components/dashboard/report-window-summary';
import { IosSegmented, IosTag } from '@/components/dashboard/menu/ios';
import {
  ReportPage,
  ReportTable,
  reportQueryState,
  useReportFilters,
  type ReportTableSpec,
} from '@/components/dashboard/report-framework';

/** The days and the hours: what the three endpoints take besides the scope. */
const SPEC: ReportFilterSpec = { filters: ['hours'] };

type MealRow = MealLine<MealSalesRow, MealComponentRow>;

export default function MenuReportsPage() {
  const t = useTranslations('menuReports');
  const tk = useTranslations('menu.kind');
  const tu = useTranslations('upsells');
  const tr = useTranslations('specials.report');
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const tab = parseMenuReportTab(searchParams.get(MENU_REPORT_TAB_PARAM));
  const setTab = (next: MenuReportTab) => {
    const q = withMenuReportTab(searchParams.toString(), next);
    router.replace(q ? `${pathname}?${q}` : pathname, { scroll: false });
  };

  const { resolution, effective } = usePageScope({ maxLevel: 'machine', unsupported: ['company'] });
  const filters = useReportFilters(SPEC);
  const params = useMemo(
    () => (filters.apiParams ? { ...filters.apiParams, ...scopeApiParams(effective, false) } : null),
    [effective, filters.apiParams],
  );

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

  // ── תוספות ──
  const modifiersTable = useMemo<ReportTableSpec<ModifierSalesRow>>(() => {
    const totals = modifiers.data?.totals;
    return {
      id: 'main',
      title: t('modifiersTitle'),
      rows: modifiers.data?.rows ?? [],
      rowKey: (r, i) => r.optionId ?? `r${i}`,
      totalsLabel: t('total'),
      emptyText: t('noRows'),
      columns: [
        {
          key: 'option',
          header: t('col.option'),
          required: true,
          width: 24,
          value: (r) => r.name ?? null,
          className: 'font-medium',
          cell: (r) => (
            <>
              <span className="me-2">{r.name ?? '—'}</span>
              {r.kind ? (
                <IosTag tone={r.kind === 'removal' ? 'red' : r.kind === 'choice' ? 'blue' : 'green'}>{tk(r.kind)}</IosTag>
              ) : null}
            </>
          ),
        },
        {
          key: 'group',
          header: t('col.group'),
          width: 20,
          value: (r) => r.groupName ?? null,
          className: 'text-muted-foreground',
          // The totals line counts the removals apart (they bring in nothing).
          total: totals ? t('removals', { n: formatQuantity(totals.removals) }) : undefined,
        },
        { key: 'kind', header: t('col.kind'), exportOnly: true, width: 10, value: (r) => (r.kind ? tk(r.kind) : null) },
        { key: 'units', header: t('col.units'), kind: 'number', value: (r) => r.unitsNet, total: totals?.units },
        { key: 'revenue', header: t('col.revenue'), kind: 'money', value: (r) => r.revenue, total: totals?.revenue },
        { key: 'refunds', header: t('col.refunds'), kind: 'money', value: (r) => r.refunds, total: totals?.refunds },
        { key: 'net', header: t('col.net'), kind: 'money', value: (r) => r.net, total: totals?.net, className: 'font-semibold' },
      ],
    };
  }, [modifiers.data, t, tk]);

  // ── ארוחות: each meal, its components under it (not sortable: sorting would scatter them) ──
  const mealsTable = useMemo<ReportTableSpec<MealRow>>(() => {
    const totals = meals.data?.totals;
    const notesOf = (m: MealSalesRow) =>
      mealNotes(m, {
        unredeemed: (items) => t('unredeemed', { items }),
        takenLater: (n) => t('takenLater', { n }),
        refills: (n) => t('refills', { n }),
        qty: formatQuantity,
      });
    const figure = (meal: (m: MealSalesRow) => number, component: (c: MealComponentRow) => number) => (r: MealRow) =>
      r.component ? component(r.component) : meal(r.meal);
    return {
      id: 'main',
      title: t('mealsTitle'),
      rows: mealLines(meals.data?.rows ?? []),
      rowKey: (r) => r.key,
      totalsLabel: t('total'),
      emptyText: t('noRows'),
      rowClassName: (r) => (r.component ? 'text-muted-foreground max-md:ms-4' : 'bg-muted/30'),
      columns: [
        {
          key: 'meal',
          header: t('col.meal'),
          required: true,
          sortable: false,
          width: 26,
          // In the export a component's line names its meal too (meal + component columns).
          value: (r) => r.meal.name ?? null,
          cell: (r) => {
            if (r.component) return <span className="inline-block ps-6">{r.component.name ?? '—'}</span>;
            const notes = notesOf(r.meal);
            return (
              <span className="font-semibold">
                {r.meal.name ?? '—'}
                {notes.length ? (
                  <span className="block text-[11px] font-normal text-muted-foreground">{notes.join(' · ')}</span>
                ) : null}
              </span>
            );
          },
        },
        {
          key: 'component',
          header: t('col.component'),
          exportOnly: true,
          sortable: false,
          width: 22,
          value: (r) => (r.component ? (r.component.name ?? null) : null),
        },
        {
          key: 'units',
          header: t('col.units'),
          kind: 'number',
          sortable: false,
          value: figure((m) => m.unitsNet, (c) => c.units),
          total: totals?.units,
        },
        {
          key: 'gross',
          header: t('col.gross'),
          kind: 'money',
          sortable: false,
          value: figure((m) => m.gross, (c) => c.gross),
          total: totals?.gross,
        },
        {
          key: 'discounts',
          header: t('col.discounts'),
          kind: 'money',
          sortable: false,
          value: figure((m) => m.discounts, (c) => c.discounts),
          total: totals?.discounts,
        },
        {
          key: 'upcharges',
          header: t('col.upcharges'),
          kind: 'money',
          sortable: false,
          // A meal's own line has none (its components carry them): blank on screen, 0 in the export as before.
          value: figure(() => 0, (c) => c.upcharges),
          cell: (r) => (r.component ? formatCurrency(r.component.upcharges) : ''),
        },
        {
          key: 'net',
          header: t('col.net'),
          kind: 'money',
          sortable: false,
          value: figure((m) => m.net, (c) => c.net),
          cell: (r) =>
            r.component ? formatCurrency(r.component.net) : <span className="font-semibold">{formatCurrency(r.meal.net)}</span>,
          total: totals?.net,
          totalCell: totals ? <span className="font-bold">{formatCurrency(totals.net)}</span> : undefined,
        },
        {
          key: 'notes',
          header: t('col.notes'),
          exportOnly: true,
          sortable: false,
          width: 40,
          value: (r) => (r.component ? null : notesOf(r.meal).join(' · ') || null),
        },
      ],
    };
  }, [meals.data, t]);

  // ── הגדלות מכירה ──
  const upsellsTable = useMemo<ReportTableSpec<UpsellReportRow>>(() => {
    const totals = upsells.data?.totals;
    return {
      id: 'main',
      title: t('upsellsTitle'),
      rows: upsells.data?.rows ?? [],
      rowKey: (r) => r.ruleId,
      totalsLabel: t('total'),
      emptyText: t('noRows'),
      columns: [
        {
          key: 'rule',
          header: t('col.rule'),
          required: true,
          width: 26,
          value: (r) => r.name ?? t('deletedRule'),
          className: 'font-medium',
          cell: (r) => (
            <>
              <span className="me-2">{r.name ?? t('deletedRule')}</span>
              {r.action ? <IosTag tone={r.action === 'upgrade' ? 'blue' : 'green'}>{tu(`action.${r.action}`)}</IosTag> : null}
              {r.optionsTaken?.length ? (
                <span className="block text-xs font-normal text-muted-foreground">
                  {tr('optionsTaken', { items: optionsTakenText(r.optionsTaken) })}
                </span>
              ) : null}
            </>
          ),
        },
        { key: 'action', header: t('col.action'), exportOnly: true, width: 10, value: (r) => (r.action ? tu(`action.${r.action}`) : null) },
        { key: 'shown', header: t('col.shown'), kind: 'number', value: (r) => r.shown, total: totals?.shown },
        { key: 'accepted', header: t('col.accepted'), kind: 'number', value: (r) => r.accepted, total: totals?.accepted },
        { key: 'dismissed', header: t('col.dismissed'), kind: 'number', value: (r) => r.dismissed, total: totals?.dismissed },
        {
          key: 'declined',
          header: tr('declined'),
          kind: 'number',
          value: (r) => r.declined ?? 0,
          total: totals ? (totals.declined ?? 0) : undefined,
        },
        {
          key: 'rate',
          header: t('col.rate'),
          kind: 'percent',
          // On screen the whole percent, as always; the export carries one decimal.
          value: (r) => ratePercent(r.acceptanceRate),
          cell: (r) => <span className="font-semibold">{rateText(r.acceptanceRate)}</span>,
          total: totals ? ratePercent(totals.acceptanceRate) : undefined,
          totalCell: totals ? <span className="font-bold">{rateText(totals.acceptanceRate)}</span> : undefined,
        },
        {
          key: 'revenue',
          header: t('col.revenue'),
          kind: 'money',
          value: (r) => r.revenue,
          total: totals?.revenue,
          totalCell: totals ? <span className="font-bold">{formatCurrency(totals.revenue)}</span> : undefined,
        },
        {
          key: 'optionsTaken',
          header: tr('optionsTakenHeader'),
          exportOnly: true,
          width: 40,
          value: (r) => optionsTakenText(r.optionsTaken) || null,
        },
      ],
    };
  }, [upsells.data, t, tr, tu]);

  const tabs: Record<MenuReportTab, { query: typeof modifiers | typeof meals | typeof upsells; table: ReportTableSpec<unknown>; title: string }> = {
    modifiers: { query: modifiers, table: modifiersTable as ReportTableSpec<unknown>, title: t('modifiersTitle') },
    meals: { query: meals, table: mealsTable as ReportTableSpec<unknown>, title: t('mealsTitle') },
    upsells: { query: upsells, table: upsellsTable as ReportTableSpec<unknown>, title: t('upsellsTitle') },
  };
  const current = tabs[tab];
  const data = current.query.data;

  return (
    <ReportPage
      reportKey={MENU_REPORT_KEYS[tab]}
      title={t('title')}
      subtitle={t('subtitle')}
      headerExtra={
        <IosSegmented
          className="max-w-md print:hidden"
          value={tab}
          onChange={setTab}
          options={[
            { id: 'modifiers', label: t('tabs.modifiers') },
            { id: 'meals', label: t('tabs.meals') },
            { id: 'upsells', label: t('tabs.upsells') },
          ]}
        />
      }
      resolution={resolution}
      filters={filters}
      bar={{ shopId: effective.shopId }}
      query={reportQueryState(current.query)}
      prompt={t('selectFilters')}
      loading="table"
      export={data ? { title: current.title, tables: [current.table], from: data.window.from, to: data.window.to } : null}
    >
      {data ? (
        <>
          <ReportWindowSummary window={data.window} generatedAt={data.generatedAt} />
          {tab === 'modifiers' ? (
            <ReportTable table={modifiersTable} />
          ) : tab === 'meals' ? (
            <>
              <p className="text-xs text-muted-foreground">{t('allocationNote')}</p>
              <ReportTable table={mealsTable} />
            </>
          ) : (
            <ReportTable table={upsellsTable} />
          )}
        </>
      ) : null}
    </ReportPage>
  );
}
