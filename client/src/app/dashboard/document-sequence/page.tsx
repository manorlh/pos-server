'use client';

/**
 * Document sequence (רצף מסמכים) — docs/ACCOUNTING_EXPORT_AND_REPORTS.md §4.3.7.
 *
 * Per till and document type, every number issued in the range (a cancelled document
 * still used its number) and what is missing between the first and the last — what an
 * auditor asks for. Duplicates and non-numeric numbers are flagged too.
 */

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { usePageScope } from '@/lib/scope';
import { formatQuantity } from '@/lib/format';
import { daysBackIso, todayIso } from '@/lib/reportWindow';
import { fetchDocumentSequenceReport, type DocumentSequenceReport } from '@/lib/salesReportsApi';
import { ScopeGate } from '@/components/dashboard/scope-gate';
import { RangeFilter, type DayRange } from '@/components/dashboard/range-filter';
import { ReportExportToolbar } from '@/components/dashboard/report-export-toolbar';
import {
  ReportErrorState,
  ReportWindowSummary,
} from '@/components/dashboard/report-window-summary';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

function gapText(g: { fromNumber: number; toNumber: number }) {
  return g.fromNumber === g.toNumber ? String(g.fromNumber) : `${g.fromNumber}–${g.toNumber}`;
}

export default function DocumentSequencePage() {
  const t = useTranslations('sequenceReport');
  const tc = useTranslations('common');
  const { resolution, effective } = usePageScope({ maxLevel: 'machine', unsupported: ['company'] });

  const [range, setRange] = useState<DayRange>({ from: daysBackIso(29), to: todayIso() });
  const [applied, setApplied] = useState<DayRange | null>(null);

  const params = useMemo(() => {
    if (!applied) return null;
    return {
      ...applied,
      ...(effective.shopId ? { shopId: effective.shopId } : {}),
      ...(effective.machineId ? { machineId: effective.machineId } : {}),
    };
  }, [applied, effective.shopId, effective.machineId]);

  const { data, isLoading, isFetching, isError, error } = useQuery<DocumentSequenceReport>({
    queryKey: ['report-document-sequence', params],
    queryFn: () => fetchDocumentSequenceReport(params!),
    enabled: params !== null,
  });

  const docType = (type?: number | null) =>
    type != null && t.has(`docType.${type}`) ? t(`docType.${type}`) : String(type ?? '—');

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
      </div>

      <ScopeGate resolution={resolution}>
        <RangeFilter value={range} onChange={setRange} onRun={() => setApplied(range)} isFetching={isFetching} />

        {!applied ? (
          <p className="text-muted-foreground py-12 text-center text-sm">{t('selectFilters')}</p>
        ) : isLoading ? (
          <Skeleton className="h-64 w-full" />
        ) : isError ? (
          <ReportErrorState message={axiosErrorToToastMessage(error, tc('error'))} />
        ) : data ? (
          <div className="space-y-4">
            <ReportExportToolbar
              title={t('title')}
              from={data.window.from}
              to={data.window.to}
              getSheets={() => [
                {
                  name: t('title'),
                  columns: [
                    { header: t('col.shop') },
                    { header: t('col.till') },
                    { header: t('col.type'), width: 16 },
                    { header: t('col.first'), width: 12 },
                    { header: t('col.last'), width: 12 },
                    { header: t('col.documents'), kind: 'number' },
                    { header: t('col.missing'), kind: 'number' },
                    { header: t('col.duplicates'), width: 20 },
                  ],
                  rows: data.rows.map((r) => [
                    r.shopName ?? null, r.machineName ?? null, docType(r.documentType), r.firstNumber ?? null,
                    r.lastNumber ?? null, r.documents, r.missing, r.duplicates.join(', ') || null,
                  ]),
                  totals: [t('total'), null, null, null, null, data.rows.reduce((s, r) => s + r.documents, 0), data.totalMissing, null],
                },
                {
                  name: t('gapsTitle'),
                  columns: [
                    { header: t('col.till') },
                    { header: t('col.type'), width: 16 },
                    { header: t('col.gapFrom'), kind: 'number' },
                    { header: t('col.gapTo'), kind: 'number' },
                    { header: t('col.missing'), kind: 'number' },
                  ],
                  rows: data.rows.flatMap((r) =>
                    r.gaps.map((g) => [r.machineName ?? null, docType(r.documentType), g.fromNumber, g.toNumber, g.missing]),
                  ),
                },
              ]}
            />
            <ReportWindowSummary window={data.window} generatedAt={data.generatedAt} />

            <p className={data.totalMissing > 0 ? 'text-destructive text-sm font-medium' : 'text-sm text-emerald-700'}>
              {data.totalMissing > 0 ? t('summaryMissing', { count: data.totalMissing }) : t('summaryOk')}
            </p>

            <div className="rounded-lg border bg-card overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('col.till')}</TableHead>
                    <TableHead>{t('col.type')}</TableHead>
                    <TableHead>{t('col.first')}</TableHead>
                    <TableHead>{t('col.last')}</TableHead>
                    <TableHead className="text-end">{t('col.documents')}</TableHead>
                    <TableHead className="text-end">{t('col.missing')}</TableHead>
                    <TableHead>{t('col.gaps')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.rows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={7} className="text-muted-foreground py-10 text-center">
                        {t('noRows')}
                      </TableCell>
                    </TableRow>
                  ) : (
                    data.rows.map((r) => (
                      <TableRow key={`${r.machineId}-${r.documentType}`}>
                        <TableCell>
                          <div className="font-medium">{r.machineName ?? r.machineId.slice(0, 8)}</div>
                          {r.shopName ? <div className="text-muted-foreground text-xs">{r.shopName}</div> : null}
                        </TableCell>
                        <TableCell>{docType(r.documentType)}</TableCell>
                        <TableCell className="font-mono text-xs" dir="ltr">{r.firstNumber ?? '—'}</TableCell>
                        <TableCell className="font-mono text-xs" dir="ltr">{r.lastNumber ?? '—'}</TableCell>
                        <TableCell className="text-end tabular-nums">{formatQuantity(r.documents)}</TableCell>
                        <TableCell className={`text-end tabular-nums ${r.missing ? 'text-destructive font-semibold' : ''}`}>
                          {r.missing || '—'}
                        </TableCell>
                        <TableCell className="space-x-1 space-y-1 text-xs">
                          {r.gaps.slice(0, 20).map((g) => (
                            <Badge key={g.fromNumber} variant="destructive" className="font-mono" dir="ltr">
                              {gapText(g)}
                            </Badge>
                          ))}
                          {r.gaps.length > 20 ? (
                            <span className="text-muted-foreground">{t('moreGaps', { count: r.gaps.length - 20 })}</span>
                          ) : null}
                          {r.duplicates.length > 0 ? (
                            <Badge variant="outline">{t('duplicates', { list: r.duplicates.slice(0, 5).join(', ') })}</Badge>
                          ) : null}
                          {r.nonNumeric > 0 ? (
                            <Badge variant="outline">{t('nonNumeric', { count: r.nonNumeric })}</Badge>
                          ) : null}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </div>
        ) : null}
      </ScopeGate>
    </div>
  );
}
