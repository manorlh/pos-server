'use client';

/**
 * Accounting export (ייצוא להנהלת חשבונות) — docs/ACCOUNTING_EXPORT_AND_REPORTS.md §2.
 *
 * Pick a company's Zs (by shop, business date, "only not exported"), preview the journal
 * entries they make, and export them as a batch: MOVEIN.DAT + MOVEIN.PRM + an Excel
 * journal, zipped and stored on the server. A Z already in a batch needs an explicit
 * confirmation to export again (no double posting by accident). Past batches download
 * again byte for byte.
 *
 * Export level (the company's setting, or chosen here): "ברמת חברה" writes one batch —
 * optionally consolidated into company entries with each line's shop as cost centre —
 * and "לפי סניף" writes a batch per shop, downloaded together as one zip. The lock is
 * per Z across both levels.
 *
 * On the report framework where it fits (P:\specs\reports-upgrade.md §5): the unified filter
 * bar (days with quick ranges, the Z date basis, "only not exported"; "הפק דוח" loads the Zs —
 * the last 30 days at once, as always), the export's options in the URL too (they take effect
 * at once), so a link opens the same form; the Zs and the past batches as `ReportTable`s
 * (sortable, columns, phone cards) with their checkboxes and download buttons. The export
 * itself — preview, problems, the re-export confirmation, the downloads — is as it was.
 *
 * "ייצוא" beside the heading (P:\specs\reports-designed-pdf.md §2) is a summary to read, not a
 * file for the bookkeeping software: the designed PDF, Excel and CSV of the Zs listed (net, VAT,
 * whether each was exported) with the period's totals, and the past batches. The MOVEIN /
 * Priority / Excel journal batches above are untouched.
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, Download, Eye, FileArchive, Settings2 } from 'lucide-react';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { usePageScope } from '@/lib/scope';
import { formatCurrency, formatDate } from '@/lib/format';
import { todayIso } from '@/lib/reportWindow';
import { defaultReportFilters, type ReportFilterSpec } from '@/lib/reportFilters';
import {
  ACCOUNTING_EXPORT_EXTRAS,
  parseAccountingExportForm,
  type AccountingExportExtraKey,
} from '@/lib/accountingExportForm';
import {
  createAccountingExport,
  downloadAccountingExport,
  downloadAccountingExportBundle,
  fetchAccountingExports,
  fetchAccountingSettings,
  fetchAccountingZs,
  previewAccountingExport,
  type AccountingExportLevel,
  type AlreadyExportedBatch,
  type AccountingZRow,
  type ExportBatch,
  type ExportPreview,
  type ExportProblem,
  type ExportRequest,
} from '@/lib/accountingApi';
import { ScopeGate } from '@/components/dashboard/scope-gate';
import { ZDateBasisToggle } from '@/components/dashboard/z-report/by-date/z-date-basis-toggle';
import { ReportErrorState } from '@/components/dashboard/report-window-summary';
import type { ReportChart, ReportKpi } from '@/lib/designedReport';
import type { ReportFilterLine } from '@/lib/reportExport';
import {
  ReportFilterBar,
  ReportTable,
  StandaloneExportBar,
  useReportFilters,
  type ReportColumn,
  type ReportTableSpec,
} from '@/components/dashboard/report-framework';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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

const SELECT =
  'border-input bg-background h-9 rounded-md border px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

const REPORT_KEY = 'accounting-export';

/** The last 30 days by default (as before); which Zs and the export's options as extras. */
const SPEC: ReportFilterSpec = {
  filters: [],
  defaultDaysBack: 30,
  extras: ACCOUNTING_EXPORT_EXTRAS,
};

type ApiError = { response?: { status?: number; data?: { detail?: unknown } } };

function problemsOf(err: unknown): ExportProblem[] | null {
  const detail = (err as ApiError)?.response?.data?.detail as { problems?: ExportProblem[] } | undefined;
  return detail && Array.isArray(detail.problems) ? detail.problems : null;
}

export default function AccountingExportPage() {
  const t = useTranslations('accounting');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const { scope, resolution, effective } = usePageScope({ maxLevel: 'shop', minLevel: 'company' });
  const shopId = effective.shopId ?? undefined;
  const companyId = scope.shop?.companyId ?? effective.companyId ?? null;
  const tb = useTranslations('zByDate');

  /**
   * The form is the URL's (a link opens it as it was). The range and which Zs are listed run
   * with "הפק דוח" (before the first run: the defaults, loaded at once as always); the export's
   * options are written at once (`apply`) — they are what the next preview / export sends.
   */
  const filters = useReportFilters(SPEC);
  const { from, to } = filters.applied?.values ?? defaultReportFilters(SPEC, todayIso());
  const listed = parseAccountingExportForm(filters.applied?.extras ?? ACCOUNTING_EXPORT_EXTRAS);
  const form = parseAccountingExportForm(filters.draftExtras);
  const { format, grouping, encoding, method, level, consolidate } = form;
  const setOption = (key: AccountingExportExtraKey, value: string) => filters.apply({ extras: { [key]: value } });

  /**
   * Which Zs the range picks: by business date (as always), or by the date each Z was produced.
   * Only the choice of Zs — the export of a Z, and the uniform file, are the same either way.
   */
  const zDateBasis = listed.basis;
  const onlyUnexported = listed.onlyUnexported;

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<ExportPreview | null>(null);
  const [problems, setProblems] = useState<ExportProblem[] | null>(null);
  const [confirmReexport, setConfirmReexport] = useState<{
    batchNumbers: number[];
    batches: AlreadyExportedBatch[];
  } | null>(null);

  // Another basis / "only not exported" in the list: the choice starts over (a new basis
  // drops the preview too), as the page's toggles always did.
  const [listedSeen, setListedSeen] = useState({ basis: zDateBasis, onlyUnexported });
  if (listedSeen.basis !== zDateBasis || listedSeen.onlyUnexported !== onlyUnexported) {
    if (listedSeen.basis !== zDateBasis) setPreview(null);
    setListedSeen({ basis: zDateBasis, onlyUnexported });
    setSelected(new Set());
  }

  const zs = useQuery({
    queryKey: ['accounting-zs', companyId, shopId, from, to, onlyUnexported, zDateBasis],
    queryFn: () =>
      fetchAccountingZs({ companyId: companyId!, shopId, from, to, onlyUnexported, dateBasis: zDateBasis }),
    enabled: Boolean(companyId) && Boolean(from) && Boolean(to) && from <= to,
  });
  const settings = useQuery({
    queryKey: ['accounting-settings', companyId, null],
    queryFn: () => fetchAccountingSettings(companyId!, null),
    enabled: Boolean(companyId),
  });
  const batches = useQuery<ExportBatch[]>({
    queryKey: ['accounting-batches', companyId, shopId],
    queryFn: () => fetchAccountingExports(companyId!, shopId),
    enabled: Boolean(companyId),
  });

  const rows: AccountingZRow[] = useMemo(() => zs.data?.items ?? [], [zs.data]);
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const selectedRows = rows.filter((r) => selected.has(r.id));
  const selectedNet = selectedRows.reduce((s, r) => s + (r.netSales ?? 0), 0);
  const settingsLevel: AccountingExportLevel = settings.data?.company?.exportLevel === 'shop' ? 'shop' : 'company';
  const effectiveLevel: AccountingExportLevel = level || settingsLevel;
  const levelLabel = (l?: string | null) => t(`exportLevel.${l === 'shop' ? 'shop' : 'company'}`);

  const request = (confirm = false): ExportRequest => ({
    companyId: companyId!,
    zReportIds: selectedRows.map((r) => r.id),
    format,
    grouping,
    ...(encoding ? { encoding } : {}),
    ...(method ? { method } : {}),
    ...(level ? { level } : {}),
    ...(consolidate && effectiveLevel === 'company' ? { consolidate: consolidate === 'true' } : {}),
    confirmReexport: confirm,
  });

  const previewMutation = useMutation({
    mutationFn: () => previewAccountingExport(request()),
    onSuccess: (p) => {
      setPreview(p);
      setProblems(p.problems.length ? p.problems : null);
    },
    onError: (err) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });

  const exportMutation = useMutation({
    mutationFn: (confirm: boolean) => createAccountingExport(request(confirm)),
    onSuccess: async (batch) => {
      setConfirmReexport(null);
      setProblems(null);
      setSelected(new Set());
      setPreview(null);
      const group = batch.groupBatches ?? [];
      if (group.length > 1) {
        toast.success(
          t('exportedShops', {
            count: group.length,
            numbers: group.map((b) => b.batchNumber).join(', '),
          }),
        );
        await downloadAccountingExportBundle(group.map((b) => b.id));
      } else {
        toast.success(t('exported', { number: batch.batchNumber }));
        await downloadAccountingExport(batch);
      }
      qc.invalidateQueries({ queryKey: ['accounting-zs'] });
      qc.invalidateQueries({ queryKey: ['accounting-batches'] });
    },
    onError: (err) => {
      const status = (err as ApiError)?.response?.status;
      const detail = (err as ApiError)?.response?.data?.detail as
        | { batchNumbers?: number[]; batches?: AlreadyExportedBatch[] }
        | undefined;
      if (status === 409) {
        setConfirmReexport({ batchNumbers: detail?.batchNumbers ?? [], batches: detail?.batches ?? [] });
        return;
      }
      const list = problemsOf(err);
      if (list) {
        setProblems(list);
        return;
      }
      toast.error(axiosErrorToToastMessage(err, tc('error')));
    },
  });

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
    setPreview(null);
    setConfirmReexport(null);
  };

  const problemText = (p: ExportProblem) => {
    const where = [p.zNumber != null ? `Z ${p.zNumber}` : null, p.shopName || null].filter(Boolean).join(' · ');
    let what: string;
    if (p.code === 'missing_mapping') {
      const key = p.detail.replace('accounts.', '');
      what = t('problem.missing_mapping', {
        field: p.detail === 'movementType' ? t('fields.movementType') : t.has(`accounts.${key}`) ? t(`accounts.${key}`) : key,
      });
    } else if (t.has(`problem.${p.code}`)) {
      what = t(`problem.${p.code}`, { detail: p.detail });
    } else {
      what = `${p.code}: ${p.detail}`;
    }
    return where ? `${where} — ${what}` : what;
  };

  /** The Zs to choose: the checkbox and the Z's link in the first column. */
  const zColumns: ReportColumn<AccountingZRow>[] = [
    {
      key: 'z',
      header: t('col.z'),
      required: true,
      className: 'font-medium',
      value: (z) => z.shopSequenceNumber ?? null,
      cell: (z) => (
        <span className="inline-flex items-center gap-2">
          <input
            type="checkbox"
            aria-label={`Z ${z.shopSequenceNumber ?? '—'}`}
            checked={selected.has(z.id)}
            onChange={() => toggle(z.id)}
          />
          <Link href={`/dashboard/z-reports/${z.id}`} className="hover:underline">
            Z {z.shopSequenceNumber ?? '—'}
          </Link>
        </span>
      ),
    },
    { key: 'shop', header: t('col.shop'), value: (z) => z.shopName ?? null },
    { key: 'businessDate', header: t('col.businessDate'), kind: 'date', value: (z) => z.businessDate },
    { key: 'productionDate', header: tb('accounting.productionDate'), kind: 'date', value: (z) => z.productionDate ?? null },
    {
      key: 'net',
      header: t('col.net'),
      kind: 'money',
      value: (z) => z.netSales ?? null,
      total: selectedRows.length > 0 ? selectedNet : undefined,
      totalCell: selectedRows.length > 0 ? <span className="font-semibold">{formatCurrency(selectedNet)}</span> : undefined,
    },
    { key: 'vat', header: t('col.vat'), kind: 'money', value: (z) => z.vatTotal ?? null },
    {
      key: 'status',
      header: t('col.status'),
      value: (z) =>
        z.exported.length === 0
          ? t('notExported')
          : t('exportedIn', { numbers: z.exported.map((b) => `${b.batchNumber} (${levelLabel(b.level)})`).join(', ') }),
      cell: (z) =>
        z.exported.length === 0 ? (
          <span className="text-muted-foreground text-xs">{t('notExported')}</span>
        ) : (
          <Badge variant="secondary">
            {t('exportedIn', {
              numbers: z.exported.map((b) => `${b.batchNumber} (${levelLabel(b.level)})`).join(', '),
            })}
          </Badge>
        ),
    },
  ];
  const zTable: ReportTableSpec<AccountingZRow> = {
    id: 'main',
    columns: zColumns,
    rows,
    rowKey: (z) => z.id,
    // A click anywhere on the row ticks it, as the list always did.
    onRowClick: (z) => toggle(z.id),
    // The chosen Zs' count and net, while there are any (as the footer always was).
    totalsLabel: selectedRows.length > 0 ? t('selectedCount', { count: selectedRows.length }) : undefined,
    emptyText: t('noZs'),
    noExport: true,
  };

  /** Past batches, each downloaded again as it was written. */
  const batchColumns: ReportColumn<ExportBatch>[] = [
    {
      key: 'batch',
      header: t('col.batch'),
      required: true,
      className: 'font-medium',
      value: (b) => b.batchNumber,
      cell: (b) => (
        <>
          {t('batchNumber', { number: b.batchNumber })}
          {b.isReexport ? (
            <Badge variant="outline" className="ms-2">
              {t('reexportBadge')}
            </Badge>
          ) : null}
          <Badge variant="secondary" className="ms-2">
            {levelLabel(b.level)}
          </Badge>
        </>
      ),
    },
    { key: 'createdAt', header: t('col.createdAt'), kind: 'datetime', className: 'text-xs', value: (b) => b.createdAt },
    { key: 'createdBy', header: t('col.createdBy'), className: 'text-xs', value: (b) => b.createdBy ?? null },
    { key: 'shop', header: t('col.shop'), value: (b) => b.shopName ?? t('severalShops') },
    {
      key: 'range',
      header: t('col.range'),
      kind: 'date',
      className: 'text-xs',
      value: (b) => b.dateFrom ?? null,
      cell: (b) => `${formatDate(b.dateFrom)} – ${formatDate(b.dateTo)}`,
    },
    {
      key: 'format',
      header: t('fields.format'),
      className: 'text-xs',
      value: (b) =>
        `${t(`format.${b.format}`)} · ${t(`grouping.${b.grouping}`)}${b.format !== 'excel' ? ` · ${b.encoding}` : ''}`,
    },
    { key: 'zCount', header: t('col.zCount'), kind: 'number', value: (b) => b.zCount },
    {
      key: 'debit',
      header: t('col.debit'),
      kind: 'money',
      value: (b) => Number(b.totalDebit),
      cell: (b) => formatCurrency(b.totalDebit),
    },
    {
      key: 'download',
      header: t('download'),
      required: true,
      sortable: false,
      screenOnly: true,
      value: () => null,
      cell: (b) => (
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            downloadAccountingExport(b).catch((err) => toast.error(axiosErrorToToastMessage(err, tc('error'))))
          }
        >
          <Download className="h-4 w-4" aria-hidden /> {t('download')}
        </Button>
      ),
    },
  ];
  const batchTable: ReportTableSpec<ExportBatch> = {
    id: 'batches',
    title: t('batchesTitle'),
    columns: batchColumns,
    rows: batches.data ?? [],
    rowKey: (b) => b.id,
    emptyText: t('noBatches'),
    noExport: true,
  };

  // ── "ייצוא": a summary to read — the Zs listed with the period's totals, and the past batches ──
  const sumOf = (all: AccountingZRow[], of: (z: AccountingZRow) => number | null | undefined) =>
    all.reduce((n, z) => n + (of(z) ?? 0), 0);
  const zExport: ReportTableSpec<AccountingZRow> = {
    ...zTable,
    title: t('summaryExport.zs'),
    noExport: false,
    onRowClick: undefined,
    // Every Z listed, not only the chosen ones (the screen's footer is the choice's).
    totalsLabel: tc('total'),
    columns: zColumns.map((c): ReportColumn<AccountingZRow> =>
      c.key === 'net'
        ? { ...c, total: undefined, totalCell: undefined, totalOf: (all: AccountingZRow[]) => sumOf(all, (z) => z.netSales) }
        : c.key === 'vat'
          ? { ...c, totalOf: (all: AccountingZRow[]) => sumOf(all, (z) => z.vatTotal) }
          : c,
    ),
  };
  const batchExport: ReportTableSpec<ExportBatch> = {
    ...batchTable,
    noExport: false,
    // The range as two dates in the sheet (the screen writes "from – to" in one cell).
    columns: batchColumns.flatMap((c): ReportColumn<ExportBatch>[] =>
      c.key === 'range' ? [c, { key: 'dateTo', header: t('to'), kind: 'date', value: (b) => b.dateTo ?? null }] : [c],
    ),
  };
  const exportTables = [
    zExport as ReportTableSpec<unknown>,
    ...((batches.data ?? []).length ? [batchExport as ReportTableSpec<unknown>] : []),
  ];
  const netByDay = new Map<string, number>();
  for (const z of rows) {
    const day = (zDateBasis === 'production' ? z.productionDate : null) ?? z.businessDate;
    netByDay.set(day, (netByDay.get(day) ?? 0) + (z.netSales ?? 0));
  }
  const days = [...netByDay.keys()].sort();
  const exportChart: ReportChart | null = days.length
    ? {
        type: 'bar',
        title: t('summaryExport.netByDay'),
        labels: days.map((d) => formatDate(d)),
        series: [{ name: t('col.net'), values: days.map((d) => Math.round((netByDay.get(d) ?? 0) * 100) / 100) }],
        kind: 'money',
      }
    : null;
  const exportKpis: ReportKpi[] = [
    { key: 'zs', label: t('summaryExport.zs'), value: rows.length, kind: 'count', icon: 'receipt' },
    { key: 'net', label: t('col.net'), value: sumOf(rows, (z) => z.netSales), kind: 'money', icon: 'sales' },
    { key: 'vat', label: t('col.vat'), value: sumOf(rows, (z) => z.vatTotal), kind: 'money', icon: 'percent' },
    { key: 'notExported', label: t('summaryExport.notExported'), value: rows.filter((z) => z.exported.length === 0).length, kind: 'count', better: 'down' },
    { key: 'batches', label: t('summaryExport.batches'), value: (batches.data ?? []).length, kind: 'count', icon: 'box' },
  ];
  const exportLines: ReportFilterLine[] = [
    { label: tb('basisLabel').replace(/:$/, ''), value: tb(`basis.${zDateBasis === 'production' ? 'production' : 'business'}`) },
    ...(onlyUnexported ? [{ label: t('onlyUnexported'), value: tc('yes') }] : []),
    ...(zs.data?.truncated ? [{ label: t('summaryExport.zs'), value: t('truncated') }] : []),
  ];

  return (
    <div className="min-w-0 space-y-4 max-sm:px-1">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{t('exportTitle')}</h1>
          <p className="text-muted-foreground text-sm">{t('exportSubtitle')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {companyId ? (
            <StandaloneExportBar
              reportKey={REPORT_KEY}
              reportType="transactions.accounting"
              title={t('summaryExport.title')}
              tables={exportTables}
              from={from}
              to={to}
              place={scope.shop?.name ?? null}
              companyId={companyId}
              filterLines={exportLines}
              kpis={exportKpis}
              chart={exportChart}
              disabled={!zs.data || rows.length === 0}
            />
          ) : null}
          <Link href="/dashboard/accounting-settings" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            <Settings2 className="h-4 w-4" aria-hidden /> {t('settingsTitle')}
          </Link>
        </div>
      </div>

      <ScopeGate resolution={resolution}>
        {!companyId ? (
          <p className="text-muted-foreground py-12 text-center text-sm">{t('pickCompany')}</p>
        ) : (
          <>
            {settings.data && settings.data.missing.length > 0 ? (
              <div className="border-destructive/50 bg-destructive/5 text-destructive flex items-center gap-2 rounded-md border p-3 text-sm">
                <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
                <span>{t('settingsIncomplete')}</span>
                <Link href="/dashboard/accounting-settings" className="underline">
                  {t('settingsTitle')}
                </Link>
              </div>
            ) : null}

            <ReportFilterBar filters={filters} isFetching={zs.isFetching}>
              <div className="min-w-0 space-y-1 sm:col-span-2">
                <ZDateBasisToggle value={form.basis} onChange={(basis) => filters.setExtra('basis', basis)} />
                <p className="text-muted-foreground text-xs">
                  {form.basis === 'production' ? tb('accounting.basisHintProduction') : tb('accounting.basisHintBusiness')}
                </p>
              </div>
              <label className="flex items-center gap-2 self-end pb-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.onlyUnexported}
                  onChange={(e) => filters.setExtra('unexported', e.target.checked ? '1' : '0')}
                />
                {t('onlyUnexported')}
              </label>
            </ReportFilterBar>

            {zs.isLoading ? (
              <Skeleton className="h-48 w-full" />
            ) : zs.isError ? (
              <ReportErrorState message={axiosErrorToToastMessage(zs.error, tc('error'))} />
            ) : (
              <div className="min-w-0 space-y-2">
                <ReportTable
                  table={zTable}
                  reportKey={REPORT_KEY}
                  actions={
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={allSelected}
                        disabled={rows.length === 0}
                        onChange={() => {
                          setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)));
                          setPreview(null);
                        }}
                      />
                      {t('selectAll')}
                    </label>
                  }
                />
                {zs.data?.truncated ? <p className="text-muted-foreground text-xs">{t('truncated')}</p> : null}
              </div>
            )}

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">{t('optionsTitle')}</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-wrap items-end gap-4">
                <div className="space-y-1">
                  <Label className="text-xs">{t('fields.format')}</Label>
                  <select className={SELECT} value={format} onChange={(e) => setOption('format', e.target.value)}>
                    <option value="hashavshevet">{t('format.hashavshevet')}</option>
                    <option value="priority">{t('format.priority')}</option>
                    <option value="excel">{t('format.excel')}</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">{t('fields.grouping')}</Label>
                  <select
                    className={SELECT}
                    value={grouping}
                    onChange={(e) => {
                      setOption('grouping', e.target.value);
                      setPreview(null);
                    }}
                  >
                    <option value="z">{t('grouping.z')}</option>
                    <option value="day">{t('grouping.day')}</option>
                    <option value="month">{t('grouping.month')}</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">{t('fields.exportLevel')}</Label>
                  <select
                    className={SELECT}
                    value={level}
                    onChange={(e) => {
                      setOption('level', e.target.value);
                      setPreview(null);
                    }}
                  >
                    <option value="">{t('fromSettingsValue', { value: levelLabel(settingsLevel) })}</option>
                    <option value="company">{t('exportLevel.company')}</option>
                    <option value="shop">{t('exportLevel.shop')}</option>
                  </select>
                </div>
                {effectiveLevel === 'company' ? (
                  <div className="space-y-1">
                    <Label className="text-xs">{t('fields.consolidate')}</Label>
                    <select
                      className={SELECT}
                      value={consolidate}
                      onChange={(e) => {
                        setOption('consolidate', e.target.value);
                        setPreview(null);
                      }}
                    >
                      <option value="">{t('fromSettings')}</option>
                      <option value="false">{t('consolidate.false')}</option>
                      <option value="true">{t('consolidate.true')}</option>
                    </select>
                  </div>
                ) : null}
                {format !== 'excel' ? (
                  <>
                    <div className="space-y-1">
                      <Label className="text-xs">{t('fields.encoding')}</Label>
                      <select className={SELECT} value={encoding} onChange={(e) => setOption('encoding', e.target.value)}>
                        <option value="">{t('fromSettings')}</option>
                        <option value="cp1255">{t('encoding.cp1255')}</option>
                        <option value="cp862">{t('encoding.cp862')}</option>
                      </select>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">{t('fields.method')}</Label>
                      <select className={SELECT} value={method} onChange={(e) => setOption('importMethod', e.target.value)}>
                        <option value="">{t('fromSettings')}</option>
                        <option value="flexible">{t('method.flexible')}</option>
                        <option value="detailed">{t('method.detailed')}</option>
                      </select>
                    </div>
                  </>
                ) : null}
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    disabled={selectedRows.length === 0 || previewMutation.isPending}
                    onClick={() => previewMutation.mutate()}
                  >
                    <Eye className="h-4 w-4" aria-hidden /> {t('preview')}
                  </Button>
                  <Button
                    disabled={selectedRows.length === 0 || exportMutation.isPending}
                    onClick={() => exportMutation.mutate(false)}
                  >
                    <FileArchive className="h-4 w-4" aria-hidden /> {t('export')}
                  </Button>
                </div>
              </CardContent>
              <CardContent className="pt-0">
                <p className="text-muted-foreground text-xs">{t('verifyNote')}</p>
              </CardContent>
            </Card>

            {confirmReexport ? (
              <div className="flex flex-wrap items-center gap-3 rounded-md border border-amber-500/60 bg-amber-50 p-3 text-sm dark:bg-amber-950/30">
                <AlertTriangle className="h-4 w-4 text-amber-600" aria-hidden />
                <span>
                  {t('reexportWarning', {
                    numbers:
                      confirmReexport.batches.length > 0
                        ? confirmReexport.batches
                            .map((b) => `${b.batchNumber} (${levelLabel(b.level)})`)
                            .join(', ')
                        : confirmReexport.batchNumbers.join(', '),
                  })}
                  {confirmReexport.batches.some((b) => b.level !== effectiveLevel)
                    ? ` ${t('reexportOtherLevel')}`
                    : ''}
                </span>
                <Button size="sm" variant="destructive" onClick={() => exportMutation.mutate(true)}>
                  {t('reexportConfirm')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmReexport(null)}>
                  {tc('cancel')}
                </Button>
              </div>
            ) : null}

            {problems && problems.length > 0 ? (
              <div className="border-destructive/50 bg-destructive/5 space-y-1 rounded-md border p-3 text-sm">
                <div className="text-destructive flex items-center gap-2 font-medium">
                  <AlertTriangle className="h-4 w-4" aria-hidden /> {t('problemsTitle')}
                </div>
                <ul className="list-disc ps-6">
                  {problems.map((p, i) => (
                    <li key={i}>{problemText(p)}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {preview && preview.entries.length > 0 ? (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">{t('previewTitle', { count: preview.entries.length })}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  {preview.entries.map((e, i) => (
                    <div key={i} className="rounded-md border">
                      <div className="bg-muted/40 flex flex-wrap gap-x-4 gap-y-1 px-3 py-2 text-xs">
                        <span className="font-medium">{e.details}</span>
                        <span>{formatDate(e.entryDate)}</span>
                        <span>{t('ref1', { value: e.reference1 })}</span>
                        <span>{t('ref2', { value: e.reference2 || '—' })}</span>
                        <span>{t('movementTypeShort', { value: e.movementType })}</span>
                      </div>
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>{t('col.line')}</TableHead>
                            {e.lines.some((l) => l.branch != null) ? (
                              <TableHead>{t('col.costCenter')}</TableHead>
                            ) : null}
                            <TableHead>{t('col.account')}</TableHead>
                            <TableHead className="text-end">{t('col.debit')}</TableHead>
                            <TableHead className="text-end">{t('col.credit')}</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {e.lines.map((l, j) => (
                            <TableRow key={j}>
                              <TableCell>{l.label}</TableCell>
                              {e.lines.some((x) => x.branch != null) ? (
                                <TableCell className="text-xs">
                                  {[l.shopName, l.branch].filter(Boolean).join(' · ') || '—'}
                                </TableCell>
                              ) : null}
                              <TableCell className="font-mono text-xs" dir="ltr">
                                {l.account ?? '—'}
                              </TableCell>
                              <TableCell className="text-end tabular-nums">
                                {l.side === 'D' ? formatCurrency(l.amount) : ''}
                              </TableCell>
                              <TableCell className="text-end tabular-nums">
                                {l.side === 'C' ? formatCurrency(l.amount) : ''}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                        <TableFooter>
                          <TableRow>
                            <TableCell
                              colSpan={e.lines.some((l) => l.branch != null) ? 3 : 2}
                              className="font-semibold"
                            >
                              {t('total')}
                            </TableCell>
                            <TableCell className="text-end font-semibold tabular-nums">
                              {formatCurrency(e.totalDebit)}
                            </TableCell>
                            <TableCell className="text-end font-semibold tabular-nums">
                              {formatCurrency(e.totalCredit)}
                            </TableCell>
                          </TableRow>
                        </TableFooter>
                      </Table>
                    </div>
                  ))}
                </CardContent>
              </Card>
            ) : null}

            <ReportTable table={batchTable} reportKey={REPORT_KEY} />
          </>
        )}
      </ScopeGate>
    </div>
  );
}
