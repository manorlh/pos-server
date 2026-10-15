'use client';

/**
 * "שידורים" (docs/SPEC_REPORTS.md §7): every card transmission report the tills sent the
 * cloud in a range — per till its attempts, successes, failures, amount and last success, what
 * the till says waits now and what our records say beside it — and the reports themselves, with
 * how many sales each batch named and how many were assumed into it. Server:
 * `GET /report-center/transmissions`. One till's history and its untransmitted sales stay on
 * the till's own page (machines → שידור עסקאות).
 *
 * On the report framework (P:\specs\reports-upgrade.md §5): the days and the shops / tills
 * (`?shops=&tills=`) in the URL; the Excel keeps its sheets (the tills, the reports — each
 * coloured as on screen) plus the refused documents, every column choosable.
 */

import { useMemo } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { usePageScope } from '@/lib/scope';
import { formatCurrency, formatDate, formatDateTime, formatQuantity } from '@/lib/format';
import { EXCEL_FILL } from '@/lib/excelExport';
import type { ReportFilterSpec } from '@/lib/reportFilters';
import { kpiNumber, previousWindow, type PreviousPeriod, type ReportKpi } from '@/lib/designedReport';
import {
  fetchTransmissionsReport,
  type RefusedDocument,
  type TransmissionItem,
  type TransmissionsReport,
} from '@/lib/reportCenterApi';
import { transmissionsSheets } from '@/lib/reportSheets';
import { keyedSheets } from '@/lib/reportCenterView';
import {
  CENTER_SCOPE_EXTRAS,
  CenterScopeFields,
  centerScopeIds,
  useCenterScopeLines,
} from '@/components/dashboard/report-center/center-scope-fields';
import { CenterTable, sheetTable, type SheetRow } from '@/components/dashboard/report-center/sheet-table';
import { STATUS_ROW } from '@/components/dashboard/report-center/parts';
import { Badge } from '@/components/ui/badge';
import {
  ReportPage,
  reportQueryState,
  useReportFilters,
  type ReportTableSpec,
} from '@/components/dashboard/report-framework';

const SPEC: ReportFilterSpec = { filters: [], extras: { ...CENTER_SCOPE_EXTRAS } };

const SCREEN_ROWS = 200;
/** The sheet builders run with the keys as their words: the columns' stable keys. */
const KEY = (k: string) => k;

type Till = TransmissionsReport['tills'][number];

/** Card legs no transmission covered, or sales the till says still wait. */
const behind = (r: Till) => r.untransmittedCardLegs > 0 || (r.tillPendingCount ?? 0) > 0;

/** The tills' columns summed, as the designed PDF's cards (and the period before's), by KPI key. */
function transmissionFigures(r: TransmissionsReport): Record<string, number> {
  return {
    reports: r.count,
    failed: r.byTill.reduce((s, x) => s + x.failed, 0),
    untransmittedLegs: r.tills.reduce((s, x) => s + x.untransmittedCardLegs, 0),
    untransmittedAmount:
      Math.round(r.tills.reduce((s, x) => s + (kpiNumber(x.untransmittedCardAmount) ?? 0), 0) * 100) / 100,
    refused: (r.refusedDocuments ?? []).length,
  };
}

export default function TransmissionsPage() {
  const t = useTranslations('reportCenter.transmissions');
  const tr = useTranslations('reportCenter');
  const tc = useTranslations('reportCenter.cols');
  const { scope, resolution, effective } = usePageScope({ maxLevel: 'machine' });
  const filters = useReportFilters(SPEC);
  const applied = filters.applied;

  const params = useMemo(() => {
    if (!applied) return null;
    const ids = centerScopeIds(applied.extras, effective, scope);
    return { from: applied.values.from, to: applied.values.to, shopIds: ids.shopIds, machineIds: ids.machineIds };
  }, [applied, effective, scope]);

  const query = useQuery<TransmissionsReport>({
    queryKey: ['report-transmissions', params],
    queryFn: () => fetchTransmissionsReport(params!),
    enabled: params !== null,
  });
  const data = query.data;

  const tables = useMemo(() => {
    if (!data) return null;
    const [tillsSheet, itemsSheet] = keyedSheets(transmissionsSheets(data, KEY), transmissionsSheets(data, tc));

    const tillsTable = sheetTable<Till>(tillsSheet, {
      id: 'main',
      src: data.tills,
      screen: ['till', 'attempts', 'success', 'failed', 'amount', 'lastSuccessAt', 'tillPending', 'untransmittedLegs'],
      cells: {
        till: (r) => (
          <Link className="hover:underline" href={`/dashboard/machines/${r.src.machineId}`}>
            {r.src.machineName ?? '—'}
          </Link>
        ),
        lastSuccessAt: (r) => (r.src.lastTransmissionAt ? formatDateTime(r.src.lastTransmissionAt) : t('never')),
        untransmittedLegs: (r) => (
          <span className={r.src.untransmittedCardLegs ? 'font-semibold text-destructive' : undefined}>
            {formatQuantity(r.src.untransmittedCardLegs)}
            {r.src.untransmittedCardLegs ? ` · ${formatCurrency(r.src.untransmittedCardAmount)}` : ''}
          </span>
        ),
      },
      extra: [
        {
          key: 'error',
          header: tc('error'),
          width: 30,
          value: (r: SheetRow<Till>) => r.src.lastError ?? null,
          cell: (r: SheetRow<Till>) => <span className="text-xs">{r.src.lastError ?? ''}</span>,
        },
      ],
      rowClassName: (r) => (behind(r.src) ? STATUS_ROW.difference : undefined),
    });
    // Amber in the sheet too.
    const tills: ReportTableSpec<SheetRow<Till>> = {
      ...tillsTable,
      rowFill: (r) => (behind(r.src) ? EXCEL_FILL.difference : null),
    };

    const reports = sheetTable<TransmissionItem>(itemsSheet, {
      id: 'reports',
      src: data.items,
      screen: [
        'till', 'startedAt', 'receivedAt', 'trigger', 'status', 'batchNumber', 'transactionCount', 'amount',
        'namedTransactions', 'assumedTransactions', 'error',
      ],
      cells: {
        trigger: (r) => tr(`trigger.${r.src.trigger}`),
        status: (r) => (
          <Badge variant={r.src.status === 'success' ? 'secondary' : 'destructive'}>{tr(`txStatus.${r.src.status}`)}</Badge>
        ),
        batchNumber: (r) => <span className="font-mono text-xs">{r.src.batchNumber ?? '—'}</span>,
        error: (r) => <span className="text-xs">{r.src.error ?? r.src.statusMessage ?? ''}</span>,
      },
      rowClassName: (r) =>
        r.src.status === 'failed' ? STATUS_ROW.missing : r.src.status === 'unknown' ? STATUS_ROW.difference : undefined,
    });

    // "מסמך שנדחה בענן" — a refused till document can never stay silent.
    const refused: ReportTableSpec<RefusedDocument> = {
      id: 'refused',
      title: t('refusedSheet'),
      rows: data.refusedDocuments ?? [],
      rowKey: (r) => r.id,
      rowClassName: (r) => (r.landedAt ? undefined : STATUS_ROW.missing),
      rowFill: (r) => (r.landedAt ? null : EXCEL_FILL.missing),
      columns: [
        {
          key: 'till',
          header: tc('till'),
          width: 16,
          required: true,
          value: (r) => r.machineName ?? r.machineId.slice(0, 8),
          cell: (r) => (
            <Link className="hover:underline" href={`/dashboard/machines/${r.machineId}`}>
              {r.machineName ?? r.machineId.slice(0, 8)}
            </Link>
          ),
        },
        { key: 'posNumber', header: tc('posNumber'), width: 8, exportOnly: true, value: (r) => r.posNumber },
        {
          key: 'documentNumber',
          header: tc('documentNumber'),
          width: 16,
          value: (r) => r.documentNumber ?? r.documentRef,
          cell: (r) => (
            <span>
              {t('refusedSubject')} · <span className="font-mono text-xs">{r.documentNumber ?? r.documentRef}</span>
            </span>
          ),
        },
        {
          key: 'documentType',
          header: tc('documentType'),
          width: 10,
          exportOnly: true,
          value: (r) => (r.documentType === null ? null : String(r.documentType)),
        },
        { key: 'issuedAt', header: t('refusedIssuedAt'), kind: 'datetime', exportOnly: true, value: (r) => r.issuedAt },
        { key: 'totalAmount', header: tc('totalAmount'), kind: 'money', exportOnly: true, value: (r) => r.totalAmount },
        { key: 'reason', header: t('refusedReason'), width: 40, value: (r) => r.reason, cell: (r) => <span className="text-xs">{r.reason}</span> },
        { key: 'attempts', header: t('refusedAttempts'), kind: 'number', value: (r) => r.attempts },
        { key: 'firstSeenAt', header: t('refusedFirstSeen'), kind: 'datetime', value: (r) => r.firstSeenAt },
        { key: 'lastSeenAt', header: t('refusedLastSeen'), kind: 'datetime', value: (r) => r.lastSeenAt },
        {
          key: 'state',
          header: t('refusedState'),
          width: 26,
          value: (r) => (r.landedAt ? t('refusedLanded', { at: formatDateTime(r.landedAt) }) : t('refusedOpen')),
          cell: (r) =>
            r.landedAt ? (
              <Badge variant="secondary">{t('refusedLanded', { at: formatDateTime(r.landedAt) })}</Badge>
            ) : (
              <Badge variant="destructive">{t('refusedOpen')}</Badge>
            ),
        },
      ],
    };

    return { tills, reports, refused };
  }, [data, t, tc, tr]);

  const filterLines = useCenterScopeLines(applied?.extras, effective, scope);

  // The designed PDF (P:\specs\reports-designed-pdf.md §7): the tills' figures summed as cards, and
  // the tills (the main table) of the period before.
  const figures = data ? transmissionFigures(data) : null;
  const kpis: ReportKpi[] = figures
    ? [
        { key: 'reports', label: tc('transmissionsCount'), value: figures.reports, kind: 'count', icon: 'card' },
        { key: 'failed', label: tc('failed'), value: figures.failed, kind: 'count', icon: 'alert' },
        { key: 'untransmittedLegs', label: tc('untransmittedLegs'), value: figures.untransmittedLegs, kind: 'count' },
        { key: 'untransmittedAmount', label: tc('untransmittedAmount'), value: figures.untransmittedAmount, kind: 'money' },
        { key: 'refused', label: t('refusedSheet'), value: figures.refused, kind: 'count', better: 'down' },
      ]
    : [];
  const previous = async (): Promise<PreviousPeriod | null> => {
    const w = previousWindow(data?.window.from, data?.window.to);
    if (!params || !w) return null;
    const before = await fetchTransmissionsReport({ ...params, ...w });
    // The tills sheet as the page builds it (fixed columns: its rows line up with the main table's).
    const [tillsSheet] = keyedSheets(transmissionsSheets(before, KEY), transmissionsSheets(before, tc));
    return {
      rows: sheetTable<Till>(tillsSheet, { id: 'main', src: before.tills }).rows,
      kpis: transmissionFigures(before),
      ...w,
    };
  };

  return (
    <ReportPage
      reportKey="transmissions"
      title={t('title')}
      subtitle={t('subtitle')}
      resolution={resolution}
      filters={filters}
      bar={{ children: <CenterScopeFields filters={filters} effective={effective} scope={scope} /> }}
      query={reportQueryState(query)}
      prompt={tr('selectFilters')}
      loading="table"
      export={
        data && tables
          ? {
              tables: [
                tables.tills,
                tables.reports,
                ...(tables.refused.rows.length ? [tables.refused] : []),
              ] as ReportTableSpec<unknown>[],
              filterLines,
              from: data.window.from,
              to: data.window.to,
              reportType: 'transmissions',
              kpis,
              insightKeys: { label: 'till', value: 'amount', count: 'attempts' },
              previous,
            }
          : null
      }
    >
      {data && tables ? (
        <>
          <p className="text-muted-foreground text-xs">{`${formatDate(data.window.from)} – ${formatDate(data.window.to)}`}</p>

          <CenterTable table={{ ...tables.tills, emptyText: tr('noRows') }} note={t('tillsNote')} />

          {tables.refused.rows.length > 0 ? (
            <CenterTable
              table={{ ...tables.refused, title: t('refused', { count: tables.refused.rows.length }) }}
              note={t('refusedNote')}
            />
          ) : null}

          <CenterTable
            table={{ ...tables.reports, title: t('reports', { count: data.count }), emptyText: tr('noRows') }}
            limit={SCREEN_ROWS}
          />
        </>
      ) : null}
    </ReportPage>
  );
}
