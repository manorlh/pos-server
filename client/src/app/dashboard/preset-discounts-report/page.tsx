'use client';

/**
 * "מעקב הנחות קבועות" (P:/specs/preset-discounts.md §6): every use of a preset discount — one
 * row per sale (the preset, its rate or amount, what it took off, the document, the till, the
 * cashier, the approver, the time, whom it was for), and the totals by preset, by person ("עבור
 * מי") and by cashier. Server: `GET /reports/preset-discounts`.
 *
 * On the report framework: days, hours and the cashier (with a shop in scope); the shop and the
 * till from the scope (the endpoint takes no company); the preset (`?preset=`) and the person
 * (`?person=`, a part of the name) are the report's own filters. The export carries every table.
 */

import { useMemo } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { usePageScope } from '@/lib/scope';
import { scopeApiParams, type ReportFilterSpec } from '@/lib/reportFilters';
import { previousWindow, type PreviousPeriod, type ReportKpi } from '@/lib/designedReport';
import {
  fetchPresetDiscountsReport,
  type PresetDiscountRow,
  type PresetDiscountsParams,
  type PresetDiscountsReport,
} from '@/lib/presetDiscountsApi';
import { ReportWindowSummary } from '@/components/dashboard/report-window-summary';
import { Combobox } from '@/components/ui/combobox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  ReportPage,
  ReportTable,
  reportQueryState,
  useReportFilters,
  type ReportColumn,
  type ReportTableSpec,
} from '@/components/dashboard/report-framework';

const SPEC: ReportFilterSpec = { filters: ['hours', 'area', 'cashier'], extras: { preset: '', person: '' } };

const PRESET_ID_MAX = 64;
const PERSON_MAX = 200;

type ByPreset = PresetDiscountsReport['byPreset'][number];
type ByPerson = PresetDiscountsReport['byPerson'][number];
type ByCashier = PresetDiscountsReport['byCashier'][number];

function totalsFigures(tot: PresetDiscountsReport['totals']): Record<string, number> {
  return { discounts: tot.amount, uses: tot.count };
}

export default function PresetDiscountsReportPage() {
  const t = useTranslations('presetDiscountsReport');
  const { resolution, effective } = usePageScope({ maxLevel: 'machine', unsupported: ['company'] });
  const filters = useReportFilters(SPEC);

  const presetId = (filters.applied?.extras.preset ?? '').trim().slice(0, PRESET_ID_MAX);
  const person = (filters.applied?.extras.person ?? '').trim().slice(0, PERSON_MAX);

  /** The window, the scope and the cashier — without the report's own two filters. */
  const baseParams = useMemo<PresetDiscountsParams | null>(
    () => (filters.apiParams ? { ...filters.apiParams, ...scopeApiParams(effective, false) } : null),
    [effective, filters.apiParams],
  );
  const params = useMemo<PresetDiscountsParams | null>(
    () => (baseParams ? { ...baseParams, ...(presetId ? { presetId } : {}), ...(person ? { person } : {}) } : null),
    [baseParams, person, presetId],
  );

  const query = useQuery<PresetDiscountsReport>({
    queryKey: ['report-preset-discounts', params],
    queryFn: () => fetchPresetDiscountsReport(params!),
    enabled: params !== null,
  });
  const data = query.data;
  // The preset filter's choices: the presets used in the window, from the run without the
  // report's own filters when it is cached (else from this one).
  const unfiltered = useQuery<PresetDiscountsReport>({
    queryKey: ['report-preset-discounts', baseParams],
    queryFn: () => fetchPresetDiscountsReport(baseParams!),
    enabled: false,
  });

  const presetOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of [...(unfiltered.data?.byPreset ?? []), ...(data?.byPreset ?? [])]) {
      if (r.presetId && !seen.has(r.presetId)) seen.set(r.presetId, r.name || t('unknown'));
    }
    const chosen = (filters.draftExtras.preset ?? '').trim();
    if (chosen && !seen.has(chosen)) seen.set(chosen, t('unknown'));
    return Array.from(seen, ([value, label]) => ({ value, label }));
  }, [data, filters.draftExtras.preset, t, unfiltered.data]);

  const filterLines = useMemo(() => {
    const lines: { label: string; value: string }[] = [];
    if (presetId) lines.push({ label: t('filter.preset'), value: presetOptions.find((o) => o.value === presetId)?.label ?? t('unknown') });
    if (person) lines.push({ label: t('filter.person'), value: person });
    return lines;
  }, [person, presetId, presetOptions, t]);

  const tables = useMemo(() => {
    const unknown = t('unknown');
    const totals = data?.totals;
    const figures = <R extends { count: number; amount: number }>(): ReportColumn<R>[] => [
      { key: 'uses', header: t('col.uses'), kind: 'number', value: (r) => r.count, total: totals?.count },
      { key: 'amount', header: t('col.amount'), kind: 'money', value: (r) => r.amount, total: totals?.amount, className: 'font-semibold' },
    ];
    const common = { totalsLabel: t('total'), emptyText: t('noRows') };

    const byPreset: ReportTableSpec<ByPreset> = {
      ...common,
      id: 'presets',
      title: t('byPreset'),
      rows: data?.byPreset ?? [],
      rowKey: (r, i) => r.presetId ?? `p${i}`,
      columns: [
        { key: 'preset', header: t('col.preset'), required: true, value: (r) => r.name ?? unknown, className: 'font-medium' },
        ...figures<ByPreset>(),
      ],
    };
    const byPerson: ReportTableSpec<ByPerson> = {
      ...common,
      id: 'people',
      title: t('byPerson'),
      rows: data?.byPerson ?? [],
      rowKey: (r, i) => `${r.for ?? ''}:${i}`,
      columns: [
        { key: 'person', header: t('col.for'), required: true, value: (r) => r.for ?? t('noPerson'), className: 'font-medium' },
        ...figures<ByPerson>(),
      ],
    };
    const byCashier: ReportTableSpec<ByCashier> = {
      ...common,
      id: 'cashiers',
      title: t('byCashier'),
      rows: data?.byCashier ?? [],
      rowKey: (r, i) => r.cashierId ?? `c${i}`,
      columns: [
        { key: 'cashier', header: t('col.cashier'), required: true, value: (r) => r.cashierName ?? unknown, className: 'font-medium' },
        ...figures<ByCashier>(),
      ],
    };
    const forKind = (k: PresetDiscountRow['forKind']) => (k ? t(`forKind.${k}`) : null);
    const rows: ReportTableSpec<PresetDiscountRow> = {
      ...common,
      id: 'main',
      title: t('rows'),
      rows: data?.rows ?? [],
      rowKey: (r) => r.transactionId,
      columns: [
        { key: 'time', header: t('col.time'), kind: 'datetime', required: true, value: (r) => r.createdAt, firstSort: 'desc' },
        { key: 'preset', header: t('col.preset'), value: (r) => r.presetName ?? unknown, className: 'font-medium' },
        {
          key: 'rate',
          header: t('col.rate'),
          value: (r) => (r.kind === 'percent' && r.percent !== null ? `${r.percent}%` : t('kindAmount')),
        },
        { key: 'amount', header: t('col.amount'), kind: 'money', value: (r) => r.amount, total: totals?.amount, className: 'font-semibold' },
        { key: 'total', header: t('col.total'), kind: 'money', value: (r) => r.total },
        { key: 'document', header: t('col.document'), value: (r) => r.documentNumber },
        {
          key: 'till',
          header: t('col.till'),
          value: (r) => [r.shopName, r.tillName, r.posNumber ? t('register', { n: r.posNumber }) : null].filter(Boolean).join(' · ') || unknown,
        },
        { key: 'cashier', header: t('col.cashier'), value: (r) => r.cashierName },
        { key: 'approver', header: t('col.approver'), value: (r) => r.approverName },
        { key: 'for', header: t('col.for'), value: (r) => r.for },
        { key: 'forKind', header: t('col.forKind'), value: (r) => forKind(r.forKind), defaultHidden: true },
      ],
    };
    return { rows, byPreset, byPerson, byCashier };
  }, [data, t]);

  const exportTables = [tables.rows, tables.byPreset, tables.byPerson, tables.byCashier] as ReportTableSpec<unknown>[];

  const figures = data ? totalsFigures(data.totals) : null;
  const kpis: ReportKpi[] = figures
    ? [
        { key: 'discounts', label: t('col.amount'), value: figures.discounts, kind: 'money', icon: 'discount' },
        { key: 'uses', label: t('col.uses'), value: figures.uses, kind: 'count', icon: 'receipt' },
      ]
    : [];
  const previous = async (): Promise<PreviousPeriod | null> => {
    const w = previousWindow(data?.window.from, data?.window.to);
    if (!params || !w) return null;
    const before = await fetchPresetDiscountsReport({ ...params, ...w });
    return { rows: before.rows, kpis: totalsFigures(before.totals), ...w };
  };

  return (
    <ReportPage
      reportKey="preset-discounts"
      title={t('title')}
      subtitle={t('subtitle')}
      resolution={resolution}
      filters={filters}
      bar={{
        shopId: effective.shopId,
        children: (
          <>
            <div className="min-w-0 space-y-1">
              <Label className="text-xs" htmlFor="preset-filter">
                {t('filter.preset')}
              </Label>
              <Combobox
                id="preset-filter"
                options={presetOptions}
                value={filters.draftExtras.preset ?? ''}
                onValueChange={(id) => filters.setExtra('preset', id ?? '')}
                placeholder={t('filter.all')}
                emptyText={t('filter.noMatch')}
                clearable
                size="sm"
              />
            </div>
            <div className="min-w-0 space-y-1">
              <Label className="text-xs" htmlFor="person-filter">
                {t('filter.person')}
              </Label>
              <Input
                id="person-filter"
                className="h-8"
                maxLength={PERSON_MAX}
                value={filters.draftExtras.person ?? ''}
                placeholder={t('filter.personPlaceholder')}
                onChange={(e) => filters.setExtra('person', e.target.value)}
              />
            </div>
          </>
        ),
      }}
      query={reportQueryState(query)}
      prompt={t('selectFilters')}
      loading="table"
      export={
        data
          ? {
              tables: exportTables,
              from: data.window.from,
              to: data.window.to,
              filterLines,
              reportType: 'preset-discounts',
              kpis,
              previous,
            }
          : null
      }
    >
      {data ? (
        <>
          <ReportWindowSummary window={data.window} generatedAt={data.generatedAt} />
          <p className="text-xs text-muted-foreground">
            {t('settingsHint')}{' '}
            <Link href="/dashboard/preset-discounts" className="font-medium text-primary hover:underline">
              {t('openSettings')}
            </Link>
          </p>
          {data.rows.length === 0 && data.totals.count === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">{t('noRows')}</p>
          ) : (
            <>
              <ReportTable table={tables.byPreset} />
              <ReportTable table={tables.byPerson} />
              <ReportTable table={tables.byCashier} />
              {data.truncated ? <p className="text-xs text-amber-700 dark:text-amber-400">{t('truncated', { n: data.rows.length })}</p> : null}
              <ReportTable table={tables.rows} />
            </>
          )}
        </>
      ) : null}
    </ReportPage>
  );
}
