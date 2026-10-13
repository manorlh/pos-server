'use client';

/**
 * "דוח התאמה" (docs/SPEC_REPORTS.md §6): the documents against the Zs against the card
 * transmissions, per shop, till, day and Z — every row with a status (תואם / הפרש / חסר /
 * ממתין), the reason, where its documents belong (the till's shift and the shop Z, or the
 * till's own Z) and the owner's action (a link when there is one), coloured on screen and in
 * the Excel.
 * Server: `GET /report-center/reconciliation`.
 *
 * On the report framework (P:\specs\reports-upgrade.md §5): the days, the shops / tills
 * (`?shops=&tills=`), the checks the server runs (`?checks=`), and the list's own check and
 * status chips (`?check=&status=`, applied at once) in the URL. The Excel keeps its sheets —
 * the summary, every row (whatever the chips), one sheet per check — each a table whose
 * columns can be chosen, with its rows coloured by status.
 */

import { useMemo } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { usePageScope } from '@/lib/scope';
import { formatCurrency, formatDate, formatDateTime, formatQuantity } from '@/lib/format';
import type { ReportFilterSpec } from '@/lib/reportFilters';
import type { ReportFilterLine } from '@/lib/reportExport';
import {
  RECONCILIATION_CHECKS,
  fetchReconciliation,
  type Reconciliation,
  type ReconciliationRow,
} from '@/lib/reportCenterApi';
import { statusFill } from '@/lib/reportSheets';
import {
  DEFAULT_STATUSES,
  RECONCILIATION_STATUSES,
  checkList,
  parseStatusList,
  reconciliationRows,
  statusListParam,
  toggleStatus,
} from '@/lib/reportCenterView';
import { EntityMultiSelect } from '@/components/dashboard/entity-multi-select';
import {
  CENTER_SCOPE_EXTRAS,
  CenterScopeFields,
  centerScopeIds,
  useCenterScopeLines,
} from '@/components/dashboard/report-center/center-scope-fields';
import { CenterTable } from '@/components/dashboard/report-center/sheet-table';
import { STATUS_ROW, StatusBadge } from '@/components/dashboard/report-center/parts';
import { Button } from '@/components/ui/button';
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
  // `checks`: what the server runs (none = all). `check` / `status`: the list's chips.
  extras: { ...CENTER_SCOPE_EXTRAS, checks: '', check: '', status: DEFAULT_STATUSES },
};

const SCREEN_ROWS = 300;
/** Numbering rows compare counts of numbers, not money: their expected / actual are counts. */
const COUNT_CHECKS: ReadonlySet<string> = new Set(['document_numbers', 'z_numbers']);

type CheckRow = Reconciliation['checks'][number];

export default function ReconciliationPage() {
  const t = useTranslations('reportCenter.reconciliation');
  const tr = useTranslations('reportCenter');
  const tc = useTranslations('reportCenter.cols');
  const { scope, resolution, effective } = usePageScope({ maxLevel: 'machine' });
  const filters = useReportFilters(SPEC);
  const applied = filters.applied;

  const params = useMemo(() => {
    if (!applied) return null;
    const ids = centerScopeIds(applied.extras, effective, scope);
    const checks = checkList(applied.extras.checks);
    return {
      from: applied.values.from,
      to: applied.values.to,
      shopIds: ids.shopIds,
      machineIds: ids.machineIds,
      ...(checks.length ? { checks } : {}),
    };
  }, [applied, effective, scope]);

  const query = useQuery<Reconciliation>({
    queryKey: ['report-reconciliation', params],
    queryFn: () => fetchReconciliation(params!),
    enabled: params !== null,
  });
  const data = query.data;

  // The list's chips: a check that was not run reads as "all".
  const chosenCheck = applied?.extras.check ?? '';
  const check = data?.checks.some((c) => c.key === chosenCheck) ? chosenCheck : '';
  const statusKey = applied?.extras.status ?? DEFAULT_STATUSES;
  const statuses = useMemo(() => parseStatusList(statusKey), [statusKey]);
  const rows = useMemo(() => reconciliationRows(data?.rows ?? [], check, statuses), [data, check, statuses]);
  const { apply } = filters;
  const show = (extras: Record<string, string>) => apply({ extras });

  const rowColumns = useMemo<ReportColumn<ReconciliationRow>[]>(() => {
    const counts = (r: ReconciliationRow) => COUNT_CHECKS.has(r.check);
    const money = (r: ReconciliationRow, v: number | null) =>
      v === null || v === undefined ? '—' : counts(r) ? formatQuantity(v) : formatCurrency(v);
    return [
      { key: 'status', header: tc('status'), width: 10, required: true, value: (r) => r.statusLabel, cell: (r) => <StatusBadge status={r.status} /> },
      { key: 'check', header: tc('check'), width: 20, value: (r) => r.checkLabel, cell: (r) => <span className="text-xs">{r.checkLabel}</span> },
      { key: 'shop', header: tc('shop'), exportOnly: true, value: (r) => r.shopName },
      {
        key: 'till',
        header: tc('till'),
        width: 16,
        value: (r) => r.machineName,
        cell: (r) => (
          <>
            {r.machineName ?? r.shopName ?? '—'}
            {r.terminal ? <div className="text-muted-foreground text-xs">{r.terminal}</div> : null}
          </>
        ),
      },
      { key: 'posNumber', header: tc('posNumber'), width: 8, exportOnly: true, value: (r) => r.posNumber },
      { key: 'terminal', header: tc('terminal'), width: 18, exportOnly: true, value: (r) => r.terminal },
      { key: 'day', header: tc('day'), kind: 'date', value: (r) => r.day },
      {
        key: 'zNumber',
        header: tc('zNumber'),
        width: 8,
        value: (r) => (r.zNumber === null || r.zNumber === undefined ? null : String(r.zNumber)),
        cell: (r) =>
          r.zReportId ? (
            <Link className="hover:underline" href={`/dashboard/z-reports/${r.zReportId}`}>
              {String(r.zNumber ?? '—')}
            </Link>
          ) : (
            (r.zNumber ?? '—')
          ),
      },
      {
        key: 'subject',
        header: tc('subject'),
        width: 30,
        value: (r) => r.subject,
        cell: (r) =>
          r.transactionId ? (
            <Link className="hover:underline" href={`/dashboard/transactions?tx=${r.transactionId}`}>
              {r.subject}
            </Link>
          ) : (
            (r.subject ?? '—')
          ),
      },
      { key: 'count', header: tc('count'), kind: 'number', value: (r) => r.count },
      { key: 'expected', header: tc('expected'), kind: 'money', value: (r) => (counts(r) ? null : r.expected), cell: (r) => money(r, r.expected) },
      { key: 'actual', header: tc('actual'), kind: 'money', value: (r) => (counts(r) ? null : r.actual), cell: (r) => money(r, r.actual) },
      {
        key: 'difference',
        header: tc('difference'),
        kind: 'money',
        value: (r) => (counts(r) ? null : r.difference),
        cell: (r) => <span className={r.difference ? 'font-semibold text-destructive' : undefined}>{money(r, r.difference)}</span>,
      },
      {
        key: 'reason',
        header: tc('reason'),
        width: 70,
        value: (r) => r.reason,
        cell: (r) => <span className="text-xs">{r.reason}</span>,
        className: 'min-w-80 whitespace-normal',
      },
      {
        key: 'container',
        header: tc('container'),
        width: 26,
        value: (r) => r.container ?? null,
        cell: (r) => <span className="text-xs">{r.container ?? '—'}</span>,
        className: 'min-w-40 whitespace-normal',
      },
      {
        key: 'ownerAction',
        header: tc('ownerAction'),
        width: 40,
        value: (r) => r.action?.label ?? null,
        className: 'min-w-48 whitespace-normal',
        cell: (r) =>
          !r.action ? (
            '—'
          ) : r.action.href ? (
            <Link className="text-xs font-medium text-primary hover:underline" href={r.action.href}>
              {r.action.label}
            </Link>
          ) : (
            <span className="text-xs">{r.action.label}</span>
          ),
      },
    ];
  }, [tc]);

  /** Per check, how many rows of each status — a click narrows the list to it. */
  const summary = useMemo<ReportTableSpec<CheckRow> | null>(() => {
    if (!data) return null;
    return {
      id: 'summary',
      title: tc('sheetSummary'),
      rows: data.checks,
      rowKey: (c) => c.key,
      totalsLabel: tc('total'),
      emptyText: tr('noRows'),
      columns: [
        {
          key: 'check',
          header: tc('check'),
          width: 26,
          required: true,
          value: (c) => c.label,
          cell: (c) => (
            <button type="button" className="hover:underline" onClick={() => apply({ extras: { check: c.key } })}>
              {c.label}
            </button>
          ),
        },
        ...RECONCILIATION_STATUSES.map(
          (s): ReportColumn<CheckRow> => ({
            key: s,
            header: tr(`status.${s}`),
            kind: 'number',
            value: (c) => data.summary[c.key]?.[s] ?? 0,
            total: data.totals[s] ?? 0,
            cell: (c) => {
              const n = data.summary[c.key]?.[s] ?? 0;
              return (
                <button
                  type="button"
                  className={`tabular-nums ${n && s !== 'match' ? 'font-semibold' : 'text-muted-foreground'} hover:underline`}
                  onClick={() => apply({ extras: { check: c.key, status: statusListParam([s]) } })}
                >
                  {formatQuantity(n)}
                </button>
              );
            },
          }),
        ),
      ],
    };
  }, [apply, data, tc, tr]);

  /** Every row (the Excel's "כל השורות"), coloured by status. */
  const allRows = useMemo<ReportTableSpec<ReconciliationRow>>(
    () => ({
      id: 'main',
      title: tc('sheetAllRows'),
      columns: rowColumns,
      rows: data?.rows ?? [],
      rowKey: (_r, i) => String(i),
      rowClassName: (r) => STATUS_ROW[r.status],
      rowFill: (r) => statusFill(r.status),
    }),
    [data, rowColumns, tc],
  );

  const exportTables = useMemo(() => {
    if (!data || !summary) return [];
    // One sheet per check (export only: its own columns to choose, the list's columns).
    const perCheck = data.checks.map(
      (c): ReportTableSpec<ReconciliationRow> => ({
        ...allRows,
        id: c.key,
        title: c.label,
        rows: data.rows.filter((r) => r.check === c.key),
      }),
    );
    return [summary, allRows, ...perCheck] as ReportTableSpec<unknown>[];
  }, [allRows, data, summary]);

  const scopeLines = useCenterScopeLines(applied?.extras, effective, scope);
  const runChecks = checkList(applied?.extras.checks);
  const filterLines: ReportFilterLine[] = [
    ...scopeLines,
    ...(runChecks.length ? [{ label: t('checksFilter'), value: runChecks.map((k) => t(`checkName.${k}`)).join(', ') }] : []),
  ];

  return (
    <ReportPage
      reportKey="reconciliation"
      title={t('title')}
      subtitle={t('subtitle')}
      resolution={resolution}
      filters={filters}
      bar={{
        children: (
          <>
            <CenterScopeFields filters={filters} effective={effective} scope={scope} />
            <EntityMultiSelect
              label={t('checksFilter')}
              options={RECONCILIATION_CHECKS.map((k) => ({ id: k, label: t(`checkName.${k}`) }))}
              selected={checkList(filters.draftExtras.checks)}
              onChange={(next) => filters.setExtra('checks', next.join(','))}
              allLabel={t('allChecks')}
              clearLabel={tr('clear')}
              emptyLabel={t('noChecks')}
            />
          </>
        ),
      }}
      query={reportQueryState(query)}
      prompt={tr('selectFilters')}
      loading="table"
      export={
        data
          ? { tables: exportTables, pdfTableId: 'main', filterLines, from: data.window.from, to: data.window.to }
          : null
      }
    >
      {data && summary ? (
        <>
          <p className="text-muted-foreground text-xs">
            {tr('generated', { at: formatDateTime(data.generatedAt), range: `${formatDate(data.window.from)} – ${formatDate(data.window.to)}` })}
          </p>

          <ReportTable table={{ ...summary, title: t('summary') }} />

          <div className="flex flex-wrap items-center gap-2 print:hidden">
            <span className="text-muted-foreground text-xs">{tc('check')}</span>
            <Button size="sm" variant={check === '' ? 'default' : 'outline'} className="rounded-full" onClick={() => show({ check: '' })}>
              {tr('all')}
            </Button>
            {data.checks.map((c) => (
              <Button
                key={c.key}
                size="sm"
                variant={check === c.key ? 'default' : 'outline'}
                className="rounded-full"
                onClick={() => show({ check: c.key })}
              >
                {c.label}
              </Button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2 print:hidden">
            <span className="text-muted-foreground text-xs">{tc('status')}</span>
            {RECONCILIATION_STATUSES.map((s) => (
              <Button
                key={s}
                size="sm"
                variant={statuses.includes(s) ? 'default' : 'outline'}
                className="rounded-full"
                aria-pressed={statuses.includes(s)}
                onClick={() => show({ status: statusListParam(toggleStatus(statuses, s)) })}
              >
                {tr(`status.${s}`)} ({formatQuantity(data.totals[s] ?? 0)})
              </Button>
            ))}
          </div>

          <CenterTable
            table={{ ...allRows, title: t('rows', { count: rows.length }), rows, emptyText: t('nothingToShow') }}
            limit={SCREEN_ROWS}
          />
        </>
      ) : null}
    </ReportPage>
  );
}
