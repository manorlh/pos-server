'use client';

/**
 * Document sequence (רצף מסמכים) — docs/ACCOUNTING_EXPORT_AND_REPORTS.md §4.3.7.
 *
 * Per till and document type, every number issued in the range (a cancelled document
 * still used its number) and what is missing between the first and the last — what an
 * auditor asks for. Duplicates and non-numeric numbers are flagged too.
 *
 * On the report framework (P:\specs\reports-upgrade.md §5): the days (the last 30 by
 * default) and a search in the URL; the shop and the till from the scope (no company, no
 * hours: a sequence is whole days). The gaps, one row each, are an Excel sheet of their own.
 */

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { usePageScope } from '@/lib/scope';
import { scopeApiParams, type ReportFilterSpec } from '@/lib/reportFilters';
import { sequenceGapRows, sequenceGapText, type SequenceGapRow } from '@/lib/auditReports';
import { previousWindow, type PreviousPeriod, type ReportChart, type ReportKpi } from '@/lib/designedReport';
import { fetchDocumentSequenceReport, type DocumentSequenceReport, type SequenceRow } from '@/lib/salesReportsApi';
import { ReportWindowSummary } from '@/components/dashboard/report-window-summary';
import { Badge } from '@/components/ui/badge';
import {
  ReportPage,
  ReportTable,
  reportQueryState,
  useReportFilters,
  type ReportTableSpec,
} from '@/components/dashboard/report-framework';

const SPEC: ReportFilterSpec = { filters: ['search'], clientFilters: ['search'], defaultDaysBack: 29 };

/** Gap badges shown per row; the rest are counted ("ועוד 12") and all are in the Excel. */
const SHOWN_GAPS = 20;

/** The summary as the designed PDF's cards (and the period before's), by KPI key. */
function sequenceFigures(r: DocumentSequenceReport): Record<string, number> {
  return {
    documents: r.rows.reduce((s, x) => s + x.documents, 0),
    missing: r.totalMissing,
    brokenSequences: r.rows.filter((x) => x.missing > 0).length,
  };
}

export default function DocumentSequencePage() {
  const t = useTranslations('sequenceReport');
  const { resolution, effective } = usePageScope({ maxLevel: 'machine', unsupported: ['company'] });
  const filters = useReportFilters(SPEC);

  const params = useMemo(
    () => (filters.apiParams ? { ...filters.apiParams, ...scopeApiParams(effective, false) } : null),
    [effective, filters.apiParams],
  );

  const query = useQuery<DocumentSequenceReport>({
    queryKey: ['report-document-sequence', params],
    queryFn: () => fetchDocumentSequenceReport(params!),
    enabled: params !== null,
  });
  const data = query.data;

  const docType = useMemo(
    () => (type?: number | null) => (type != null && t.has(`docType.${type}`) ? t(`docType.${type}`) : String(type ?? '—')),
    [t],
  );

  const main = useMemo<ReportTableSpec<SequenceRow>>(() => {
    const rows = data?.rows ?? [];
    return {
      // No heading of its own: the page's title names it (and the Excel sheet).
      id: 'main',
      rows,
      rowKey: (r) => `${r.machineId}-${r.documentType}`,
      totalsLabel: t('total'),
      emptyText: t('noRows'),
      columns: [
        // The screen writes the shop under the till; Excel keeps it as its own column.
        { key: 'shop', header: t('col.shop'), exportOnly: true, value: (r) => r.shopName ?? null },
        {
          key: 'till',
          header: t('col.till'),
          required: true,
          value: (r) => r.machineName ?? r.machineId.slice(0, 8),
          cell: (r) => (
            <>
              <div className="font-medium">{r.machineName ?? r.machineId.slice(0, 8)}</div>
              {r.shopName ? <div className="text-muted-foreground text-xs">{r.shopName}</div> : null}
            </>
          ),
        },
        { key: 'type', header: t('col.type'), width: 16, value: (r) => docType(r.documentType) },
        {
          key: 'first',
          header: t('col.first'),
          width: 12,
          value: (r) => r.firstNumber ?? null,
          cell: (r) => (
            <span className="font-mono text-xs" dir="ltr">
              {r.firstNumber ?? '—'}
            </span>
          ),
        },
        {
          key: 'last',
          header: t('col.last'),
          width: 12,
          value: (r) => r.lastNumber ?? null,
          cell: (r) => (
            <span className="font-mono text-xs" dir="ltr">
              {r.lastNumber ?? '—'}
            </span>
          ),
        },
        {
          key: 'documents',
          header: t('col.documents'),
          kind: 'number',
          value: (r) => r.documents,
          total: rows.reduce((s, r) => s + r.documents, 0),
        },
        {
          key: 'missing',
          header: t('col.missing'),
          kind: 'number',
          value: (r) => r.missing,
          cell: (r) => <span className={r.missing ? 'text-destructive font-semibold' : ''}>{r.missing || '—'}</span>,
          total: data?.totalMissing,
        },
        {
          key: 'gaps',
          header: t('col.gaps'),
          screenOnly: true,
          sortable: false,
          value: (r) => r.gaps.map(sequenceGapText).join(' '),
          className: 'text-xs whitespace-normal',
          cell: (r) => (
            <div className="flex flex-wrap gap-1">
              {r.gaps.slice(0, SHOWN_GAPS).map((g) => (
                <Badge key={g.fromNumber} variant="destructive" className="font-mono" dir="ltr">
                  {sequenceGapText(g)}
                </Badge>
              ))}
              {r.gaps.length > SHOWN_GAPS ? (
                <span className="text-muted-foreground">{t('moreGaps', { count: r.gaps.length - SHOWN_GAPS })}</span>
              ) : null}
              {r.duplicates.length > 0 ? (
                <Badge variant="outline">{t('duplicates', { list: r.duplicates.slice(0, 5).join(', ') })}</Badge>
              ) : null}
              {r.nonNumeric > 0 ? <Badge variant="outline">{t('nonNumeric', { count: r.nonNumeric })}</Badge> : null}
            </div>
          ),
        },
        // The flags the screen shows as badges, as columns of the export.
        { key: 'duplicates', header: t('col.duplicates'), exportOnly: true, width: 20, value: (r) => r.duplicates.join(', ') || null },
        { key: 'nonNumeric', header: t('col.nonNumeric'), kind: 'number', exportOnly: true, value: (r) => r.nonNumeric || null },
      ],
    };
  }, [data, docType, t]);

  /** Every gap, one row each — the Excel's second sheet (the screen shows them as badges). */
  const gaps = useMemo<ReportTableSpec<SequenceGapRow>>(
    () => ({
      id: 'gaps',
      title: t('gapsTitle'),
      rows: sequenceGapRows(data?.rows ?? []),
      rowKey: (g) => g.key,
      columns: [
        { key: 'till', header: t('col.till'), required: true, value: (g) => g.machineName },
        { key: 'shop', header: t('col.shop'), value: (g) => g.shopName },
        { key: 'type', header: t('col.type'), width: 16, value: (g) => docType(g.documentType) },
        { key: 'gapFrom', header: t('col.gapFrom'), kind: 'number', value: (g) => g.fromNumber },
        { key: 'gapTo', header: t('col.gapTo'), kind: 'number', value: (g) => g.toNumber },
        { key: 'missing', header: t('col.missing'), kind: 'number', value: (g) => g.missing },
      ],
    }),
    [data, docType, t],
  );

  // The designed PDF (P:\specs\reports-designed-pdf.md §7): the documents and what is missing as
  // cards, the missing numbers per till as bars, and the sequences of the period before.
  const figures = data ? sequenceFigures(data) : null;
  const kpis: ReportKpi[] = figures
    ? [
        { key: 'documents', label: t('col.documents'), value: figures.documents, kind: 'count', icon: 'receipt' },
        { key: 'missing', label: t('col.missing'), value: figures.missing, kind: 'count', better: 'down', icon: 'alert' },
        { key: 'brokenSequences', label: t('brokenSequences'), value: figures.brokenSequences, kind: 'count', better: 'down' },
      ]
    : [];
  // A till's document types summed: one bar per till that is missing numbers.
  const missingByTill = new Map<string, { label: string; missing: number }>();
  for (const r of data?.rows ?? []) {
    if (!r.missing) continue;
    const till = missingByTill.get(r.machineId) ?? { label: r.machineName ?? r.machineId.slice(0, 8), missing: 0 };
    missingByTill.set(r.machineId, { ...till, missing: till.missing + r.missing });
  }
  const tillsMissing = [...missingByTill.values()].sort((a, b) => b.missing - a.missing);
  const chart: ReportChart | null = tillsMissing.length
    ? {
        type: 'hbar',
        title: t('col.missing'),
        labels: tillsMissing.map((x) => x.label),
        series: [{ name: t('col.missing'), values: tillsMissing.map((x) => x.missing) }],
        kind: 'number',
      }
    : null;
  const previous = async (): Promise<PreviousPeriod | null> => {
    const w = previousWindow(data?.window.from, data?.window.to);
    if (!params || !w) return null;
    const before = await fetchDocumentSequenceReport({ ...params, ...w });
    return { rows: before.rows, kpis: sequenceFigures(before), ...w };
  };

  return (
    <ReportPage
      reportKey="document-sequence"
      title={t('title')}
      subtitle={t('subtitle')}
      resolution={resolution}
      filters={filters}
      query={reportQueryState(query)}
      prompt={t('selectFilters')}
      loading="table"
      export={
        data
          ? {
              tables: [main, gaps] as ReportTableSpec<unknown>[],
              from: data.window.from,
              to: data.window.to,
              reportType: 'document-sequence',
              kpis,
              chart,
              insightKeys: { label: 'till', value: 'missing', count: 'documents' },
              groupBy: ['shop', 'till'],
              previous,
            }
          : null
      }
    >
      {data ? (
        <>
          <ReportWindowSummary window={data.window} generatedAt={data.generatedAt} />

          <p className={data.totalMissing > 0 ? 'text-destructive text-sm font-medium' : 'text-sm text-emerald-700'}>
            {data.totalMissing > 0 ? t('summaryMissing', { count: data.totalMissing }) : t('summaryOk')}
          </p>

          <ReportTable table={main} />
        </>
      ) : null}
    </ReportPage>
  );
}
