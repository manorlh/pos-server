'use client';

/**
 * The report's export bar (P:\specs\reports-upgrade.md §2ב–ד, P:\specs\reports-designed-pdf.md
 * §1–§2, §6): one "ייצוא" button — PDF מעוצב · אקסל · CSV · הדפסה — and the export columns.
 *
 * * The columns that go out, first match wins: the choice made here for this export → the
 *   company's default for the report (`report_export_defaults`) → the columns the reader sees
 *   → all. A company manager, a distributor or the super admin (the server's `canEdit`) can
 *   save the current choice as the company's default.
 * * The designed PDF: `POST /reports/pdf` with the main table and the report's type, its KPI
 *   cards (each against the previous period when the page can fetch it), a chart, the previous
 *   period's rows and the subtotal grouping; the server writes the insights and draws it all.
 *   A server without the route: the browser's print, "save as PDF" — as before.
 * * Excel: a first sheet "סיכום ותובנות" (the KPIs and the server's insight sentences), then
 *   every table — each sheet opens with the header lines (title, business and shop, range,
 *   hours, the chosen filters, generated at) and carries only the chosen columns, with its
 *   totals row; the file is named "מכירות לפי מוצר — סניף X — 01.10–13.10.xlsx".
 * * CSV: the main table's chosen columns, plain values (or the page's own CSV).
 * * Print: unchanged — the page's print template with its header.
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ChevronDown, Columns3, Download, FileDown, FileSpreadsheet, FileText, Loader2, Printer } from 'lucide-react';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { formatDateTime } from '@/lib/format';
import { downloadCsv } from '@/lib/csv';
import {
  chartFromTable,
  cleanChart,
  cleanKpis,
  summarySheet,
  tableCsv,
  withCompare,
  type InsightKeys,
  type PreviousPeriod,
  type ReportChart,
  type ReportChartType,
  type ReportInsight,
  type ReportKpi,
} from '@/lib/designedReport';
import { downloadBlob, downloadExcel, type ExcelSheet } from '@/lib/excelExport';
import {
  MAIN_TABLE,
  MAX_DEFAULT_COLUMNS,
  companyDefaultColumns,
  qualifiedExportList,
  resolveExportColumns,
  visibleColumnKeys,
  type ExportColumnSource,
} from '@/lib/reportColumns';
import {
  exportTablePdfBody,
  exportTableSheet,
  rangeText,
  reportFileName,
  reportHeaderLines,
  type ExportTable,
  type ReportFilterLine,
} from '@/lib/reportExport';
import { PDF_MAX_ROWS, fetchReportInsights, fetchReportPdf, saveExportDefault } from '@/lib/reportFrameworkApi';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useReportContext } from './report-context';
import { searchRows } from './report-table';
import { prefsKeyOf, useExportDefaults, useReportColumnPrefs } from './use-report-prefs';
import type { ReportTableSpec } from './types';

type Orientation = 'auto' | 'portrait' | 'landscape';

export interface ReportExportBarProps {
  reportKey: string;
  title: string;
  /** The tables that go out (the first, or `pdfTableId`, is the PDF's). */
  tables: ReportTableSpec<unknown>[];
  /** Sheets that are not a table of the page (a heat map…), appended as they are; may be fetched. */
  extraSheets?: () => ExcelSheet[] | Promise<ExcelSheet[]>;
  extraSheetsFirst?: boolean;
  /** A workbook the server builds replaces the client's Excel (the columns choice is then the PDF's). */
  excel?: () => Promise<void>;
  /** More buttons in the bar (a CSV, a ZIP). */
  actions?: React.ReactNode;
  pdfTableId?: string;
  from?: string | null;
  to?: string | null;
  business: string;
  place?: string | null;
  filterLines: ReportFilterLine[];
  hours?: string | null;
  /** The company whose export defaults apply (the scope's; the user's own when none). */
  companyId?: string | null;
  companyName?: string | null;
  disabled?: boolean;
  /** Excel and its columns only — for a page that prints its own document (a Z). */
  excelOnly?: boolean;
  /**
   * The designed PDF, Excel and CSV, but no print template: a page that prints its own
   * documents (the Z list's A4 / 80 mm sequence, a Z) keeps its print to itself.
   */
  noPrint?: boolean;
  /** The server's `reportInsights.<type>` (§2); absent: a general designed report. */
  reportType?: string;
  /** The KPI cards (3–6), as the page shows them. */
  kpis?: ReportKpi[];
  /** The main figure's chart; `null`: none (absent: the server's default for the type). */
  chart?: ReportChart | null;
  /** No `chart`: one built from the exported main table (the top rows by `value`). */
  chartFrom?: { label: string; value: string; type?: ReportChartType; top?: number; kind?: ReportChart['kind']; title?: string };
  /** Which columns the server's insight rules read (§7.1); default: `chartFrom`'s, else the server guesses. */
  insightKeys?: InsightKeys;
  /** The main table's column keys the PDF's subtotals group by (shop → point of sale → till). */
  groupBy?: string[];
  /** The same report for the previous period, fetched on the click (KPI comparison, previous rows). */
  previous?: () => Promise<PreviousPeriod | null>;
  /** The page's own CSV instead of the main table's (a server file, a page's own columns). */
  csv?: () => void | Promise<void>;
  /**
   * A designed PDF the server builds whole from the report's own parameters (§7.3 "סיכום יום",
   * §7.6 "לפי ימים"), instead of `POST /reports/pdf` with the main table.
   */
  pdf?: () => Promise<void>;
  /**
   * The insights the page already has from the server (a report whose JSON carries them, §7.3,
   * §7.6): the Excel's "סיכום ותובנות" takes these instead of asking `POST /reports/insights`.
   */
  insights?: ReportInsight[];
}

export type { PreviousPeriod, ReportChart, ReportKpi };

/**
 * The columns that are known only from the exported rows (`expandInExport`, one per payment
 * method), written in their placeholder's place — in the table and in the chosen keys.
 */
export function expandExportColumns(
  table: ReportTableSpec<unknown>,
  rows: unknown[],
  keys: string[],
): { table: ReportTableSpec<unknown>; keys: string[] } {
  if (!table.columns.some((c) => c.expandInExport)) return { table, keys };
  const parts = new Map<string, string[]>();
  const columns = table.columns.flatMap((c) => {
    if (!c.expandInExport) return [c];
    const expanded = c.expandInExport(rows).map((x) => ({ ...x, key: `${c.key}:${x.key}` }));
    parts.set(c.key, expanded.map((x) => x.key));
    return expanded;
  });
  return { table: { ...table, columns }, keys: keys.flatMap((k) => parts.get(k) ?? [k]) };
}

/**
 * A table as the exports see it: no screen-only columns, the search applied, its totals row.
 * `allRows`: what the table's `exportRows` fetched (default: its rows on screen).
 */
export function toExportTable(
  table: ReportTableSpec<unknown>,
  q: string,
  fallbackName: string,
  allRows?: unknown[],
): ExportTable {
  const columns = table.columns.filter((c) => !c.screenOnly);
  const all = allRows ?? table.rows;
  const rows = searchRows(allRows ? { ...table, rows: allRows } : table, q);
  const totals =
    table.totalsLabel && all.length > 0
      ? columns.map((c, i) =>
          c.total !== undefined ? c.total : c.totalOf ? c.totalOf(all) : i === 0 ? table.totalsLabel! : null,
        )
      : undefined;
  return {
    tableId: table.id,
    name: table.title ?? fallbackName,
    heading: table.sheetHeading,
    columns: columns.map((c) => ({ key: c.key, header: c.header, kind: c.kind, width: c.width })),
    rows: rows.map((r) => columns.map((c) => c.value(r))),
    totals,
    ...(table.rowFill ? { rowFills: rows.map((r) => table.rowFill!(r) ?? null) } : {}),
    ...(table.autoFilter === false ? { autoFilter: false } : {}),
  };
}

export function ReportExportBar({
  reportKey,
  title,
  tables,
  extraSheets,
  extraSheetsFirst = false,
  excel,
  actions,
  pdfTableId,
  from,
  to,
  business,
  place,
  filterLines,
  hours,
  companyId,
  companyName,
  disabled,
  excelOnly = false,
  noPrint = false,
  reportType,
  kpis,
  chart,
  chartFrom,
  insightKeys,
  groupBy,
  previous,
  csv,
  pdf,
  insights,
}: ReportExportBarProps) {
  const t = useTranslations('reportFramework.export');
  const ctx = useReportContext();
  const q = ctx?.search ?? '';
  const qc = useQueryClient();
  const { byReport } = useReportColumnPrefs();
  const defaults = useExportDefaults(companyId);
  const companyDefault = defaults.data?.byReport[reportKey] ?? null;

  const exported = useMemo(() => tables.filter((tb) => !tb.noExport), [tables]);
  const [current, setCurrent] = useState<string[] | null>(null);
  const [orientation, setOrientation] = useState<Orientation>('auto');
  const [picker, setPicker] = useState(false);
  const [busy, setBusy] = useState<'excel' | 'pdf' | 'csv' | 'save' | null>(null);
  const [generatedAt, setGeneratedAt] = useState(() => new Date().toISOString());

  useEffect(() => {
    const after = () => {
      delete document.documentElement.dataset.print;
    };
    window.addEventListener('afterprint', after);
    return () => window.removeEventListener('afterprint', after);
  }, []);

  /** Each table's export columns and where they came from. */
  const resolved = useMemo(
    () =>
      exported.map((table) => {
        const columns = table.columns.filter((c) => !c.screenOnly);
        const keys = columns.map((c) => c.key);
        const visible = visibleColumnKeys(columns, byReport[prefsKeyOf(reportKey, table.id)] ?? null);
        const r = resolveExportColumns({ tableId: table.id, keys, visible }, { current, company: companyDefault?.columns });
        return { table, ...r };
      }),
    [byReport, companyDefault, current, exported, reportKey],
  );
  const mainSource: ExportColumnSource = resolved[0]?.source ?? 'all';
  const chosenCount = resolved.reduce((n, r) => n + r.keys.length, 0);

  const fileName = reportFileName(title, place, from, to);
  const words = {
    range: (range: string) => t('rangeLine', { range }),
    hours: (band: string) => t('hoursLine', { band }),
    filters: (list: string) => t('filtersLine', { list }),
    generatedAt: (at: string) => t('generatedAt', { at }),
    formatDateTime: (iso: string) => formatDateTime(iso),
  };
  const headerLines = (at: string) =>
    reportHeaderLines({ title, business, place, from, to, hours, filters: filterLines, generatedAt: at }, words);

  /** One table ready to write: a paged list's rows fetched now (`exportRows`), its data's columns expanded. */
  const prepare = async (r: (typeof resolved)[number]) => {
    const rows = r.table.exportRows ? await r.table.exportRows() : undefined;
    const x = expandExportColumns(r.table, rows ?? r.table.rows, r.keys);
    return { table: toExportTable(x.table, q, title, rows), keys: x.keys };
  };

  /** The PDF's table: `pdfTableId`, else the first exported. */
  const mainResolved = () => resolved.find((x) => x.table.id === pdfTableId) ?? resolved[0];
  const range = rangeText(from, to);
  const pdfHeader = (r: (typeof resolved)[number]) => ({
    title: r.table.id !== MAIN_TABLE && r.table.title ? `${title} · ${r.table.title}` : title,
    subtitleLines: [
      [business, place].filter((s) => s && s.trim()).join(' · '),
      range ? t('rangeLine', { range }) : '',
      hours ? t('hoursLine', { band: hours }) : '',
    ].filter(Boolean),
    filterLines: filterLines.map((f) => `${f.label}: ${f.value}`),
    fileName,
    companyId,
  });

  /**
   * The designed report's parts (§6) for the main table as exported: the KPIs against the
   * previous period, the chart, the previous period's rows in the same columns, the grouping.
   * The previous period is the page's to fetch; a failure there never fails the export.
   */
  const designed = async (main: { table: ExportTable; keys: string[] } | null, r: (typeof resolved)[number] | undefined) => {
    let before: PreviousPeriod | null = null;
    if (previous) {
      try {
        before = await previous();
      } catch {
        before = null;
      }
    }
    const beforeRange = before ? rangeText(before.from, before.to) : '';
    const previousLabel = before?.label ?? (beforeRange ? t('compareWith', { range: beforeRange }) : undefined);
    const cards = cleanKpis(withCompare(kpis ?? [], before?.kpis ?? null, previousLabel));
    const sheet = main ? exportTableSheet(main.table, main.keys) : null;
    let previousRows: (string | number | null)[][] | undefined;
    if (sheet && r && before?.rows) {
      // The previous period in the current one's columns, matched by key (a column the data
      // makes — one per payment method — may exist in one period only: blank in the other).
      const x = expandExportColumns(r.table, before.rows, r.keys);
      const prev = exportTableSheet(toExportTable(x.table, '', title, before.rows), x.keys);
      const at = sheet.columns.slice(0, 40).map((c) => prev.columns.findIndex((p) => p.key === c.key));
      const plain = (v: unknown): string | number | null => (typeof v === 'number' || typeof v === 'string' ? v : null);
      previousRows = prev.rows.map((row) => at.map((i) => (i < 0 ? null : plain(row[i]))));
    }
    const drawn =
      cleanChart(chart) ??
      (chartFrom && sheet
        ? cleanChart(
            chartFromTable(
              { columns: sheet.columns.map((c) => ({ key: c.key ?? c.header, header: c.header })), rows: sheet.rows },
              chartFrom.label,
              chartFrom.value,
              { type: chartFrom.type, top: chartFrom.top, kind: chartFrom.kind, title: chartFrom.title },
            ),
          )
        : undefined);
    const chosen = new Set(main?.keys ?? []);
    const groups = (groupBy ?? []).filter((k) => chosen.has(k)).slice(0, 3);
    const keys = insightKeys ?? (chartFrom ? { label: chartFrom.label, value: chartFrom.value } : undefined);
    const hints = keys
      ? Object.fromEntries(Object.entries(keys).filter(([, v]) => typeof v === 'string' && chosen.has(v)))
      : {};
    return {
      ...(reportType ? { reportType } : {}),
      // The header band's two lines (§7.1): the period, then business › place.
      ...(range ? { period: range.slice(0, 200) } : {}),
      ...(business || place ? { scope: [business, place].filter((x) => x && x.trim()).join(' › ').slice(0, 300) } : {}),
      ...(cards.length ? { kpis: cards } : {}),
      // No chart from the page: the server draws its type's default (§7.4); `null`: no chart at
      // all (a list of single records has nothing to plot).
      ...(chart === null ? { chart: null } : drawn ? { chart: drawn } : {}),
      ...(previousRows ? { previousRows } : {}),
      ...(previousLabel && before ? { previousLabel: previousLabel.slice(0, 80) } : {}),
      ...(groups.length ? { groupBy: groups } : {}),
      ...(Object.keys(hints).length ? { insightKeys: hints } : {}),
    };
  };

  /** The main table's PDF body with the designed parts (§6). */
  const designedBody = async (r: (typeof resolved)[number] | undefined) => {
    if (!r) return null;
    const main = await prepare(r);
    const body = exportTablePdfBody(main.table, main.keys, pdfHeader(r), orientation);
    return { main, body: { ...body, ...(await designed(main, r)) } };
  };

  const onExcel = async () => {
    setBusy('excel');
    try {
      if (excel) {
        await excel();
        return;
      }
      const main = mainResolved();
      const prepared = await Promise.all(resolved.map(async (r) => ({ r, p: await prepare(r) })));
      const sheets = prepared.map(({ p }) => exportTableSheet(p.table, p.keys));
      const extra = (await extraSheets?.()) ?? [];
      // "סיכום ותובנות" first (§1): the KPIs and the server's sentences about this report.
      const mainPrepared = prepared.find((x) => x.r === main)?.p ?? null;
      const summaryWords = {
        sheetName: t('summarySheet'),
        kpiHeader: t('summaryKpi'),
        valueHeader: t('summaryValue'),
        previousHeader: t('summaryPrevious'),
        changeHeader: t('summaryChange'),
        insightsHeading: t('summaryInsights'),
      };
      let summary: ExcelSheet | null = null;
      if (insights) {
        // The page has the server's sentences already (a report that carries them).
        summary = summarySheet(cleanKpis(kpis ?? []), insights, summaryWords);
      } else if (main && mainPrepared) {
        const body = {
          ...exportTablePdfBody(mainPrepared.table, mainPrepared.keys, pdfHeader(main), orientation),
          ...(await designed(mainPrepared, main)),
        };
        // The server's sentences, and its KPIs with the comparison worked out (§7.2).
        const answer = body.rows.length <= PDF_MAX_ROWS ? await fetchReportInsights(body) : null;
        summary = summarySheet(answer?.kpis.length ? answer.kpis : (body.kpis ?? []), answer?.insights ?? [], summaryWords);
      } else if (kpis?.length) {
        summary = summarySheet(cleanKpis(kpis), [], summaryWords);
      }
      const body = extraSheetsFirst ? [...extra, ...sheets] : [...sheets, ...extra];
      await downloadExcel(summary ? [summary, ...body] : body, fileName, {
        heading: headerLines(new Date().toISOString()),
        readableName: true,
      });
    } catch (err) {
      toast.error(axiosErrorToToastMessage(err, t('excelFailed')));
    } finally {
      setBusy(null);
    }
  };

  const onCsv = async () => {
    setBusy('csv');
    try {
      if (csv) {
        await csv();
        return;
      }
      const r = mainResolved();
      if (!r) return;
      const p = await prepare(r);
      downloadCsv(`${fileName}.csv`, tableCsv(exportTableSheet(p.table, p.keys)));
    } catch (err) {
      toast.error(axiosErrorToToastMessage(err, t('csvFailed')));
    } finally {
      setBusy(null);
    }
  };

  const print = () => {
    setGeneratedAt(new Date().toISOString());
    document.documentElement.dataset.print = 'report';
    const previousTitle = document.title;
    // The browser offers the document title as the PDF's file name.
    document.title = fileName;
    window.setTimeout(() => {
      window.print();
      document.title = previousTitle;
    }, 50);
  };

  const onPdf = async () => {
    if (pdf) {
      setBusy('pdf');
      try {
        await pdf();
      } catch (err) {
        toast.error(axiosErrorToToastMessage(err, t('pdfFailed')));
      } finally {
        setBusy(null);
      }
      return;
    }
    const r = mainResolved();
    if (!r) return;
    setBusy('pdf');
    try {
      const made = await designedBody(r);
      if (!made) return;
      if (made.main.table.rows.length > PDF_MAX_ROWS) {
        toast.error(t('pdfTooMany', { max: PDF_MAX_ROWS.toLocaleString('he-IL') }));
        return;
      }
      const blob = await fetchReportPdf(made.body);
      if (blob) downloadBlob(blob, `${fileName}.pdf`, 'application/pdf');
      else {
        toast.info(t('pdfFallback'));
        print();
      }
    } catch (err) {
      toast.error(axiosErrorToToastMessage(err, t('pdfFailed')));
    } finally {
      setBusy(null);
    }
  };

  const saveDefault = async (columns: string[]) => {
    const target = defaults.data?.companyId ?? companyId;
    if (!target) return;
    setBusy('save');
    try {
      await saveExportDefault(reportKey, target, columns);
      await qc.invalidateQueries({ queryKey: ['report-export-defaults'] });
      if (columns.length) {
        setCurrent(null);
        toast.success(t('companyDefaultSaved', { company: companyName ?? t('thisCompany') }));
      } else toast.success(t('companyDefaultCleared'));
    } catch (err) {
      toast.error(axiosErrorToToastMessage(err, t('companyDefaultFailed')));
    } finally {
      setBusy(null);
    }
  };

  /** Toggle one column of one table in this export's choice (kept in the report's order). */
  const toggle = (tableId: string, key: string, on: boolean) => {
    const next = resolved.map((r) => {
      if (r.table.id !== tableId) return { tableId: r.table.id, keys: r.keys };
      let keys = r.keys.filter((k) => k !== key);
      if (on) {
        // In at the report's place: before the first chosen column that comes after it.
        const pos = (k: string) => r.table.columns.findIndex((c) => c.key === k);
        const at = keys.findIndex((k) => pos(k) > pos(key));
        keys = at < 0 ? [...keys, key] : [...keys.slice(0, at), key, ...keys.slice(at)];
      }
      return { tableId: r.table.id, keys };
    });
    setCurrent(qualifiedExportList(next));
  };

  const sourceLabel: Record<ExportColumnSource, string> = {
    current: t('sourceCurrent'),
    company: t('sourceCompany'),
    visible: t('sourceVisible'),
    all: t('sourceAll'),
  };
  const canEdit = Boolean(defaults.data?.supported && defaults.data.canEdit && (defaults.data.companyId ?? companyId));
  const companyLabel = companyName ?? t('thisCompany');
  // A report of many tables can choose more columns than a company default holds (§4.3).
  const defaultList = companyDefaultColumns(
    resolved.map((r) => ({
      tableId: r.table.id,
      keys: r.keys,
      all: r.table.columns.filter((c) => !c.screenOnly).map((c) => c.key),
    })),
  );

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 print:hidden" data-report-export={reportType ?? reportKey}>
        {/* "ייצוא" (§2): the designed PDF, Excel, CSV and print, in one place on every report. */}
        <DropdownMenu>
          <DropdownMenuTrigger
            disabled={disabled || busy !== null}
            render={
              <Button variant="outline" size="sm" aria-label={t('menu')}>
                {busy && busy !== 'save' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Download className="h-4 w-4" aria-hidden />}
                {t('menu')}
                <ChevronDown className="h-3.5 w-3.5 opacity-70" aria-hidden />
              </Button>
            }
          />
          <DropdownMenuContent align="start" className="w-56">
            {excelOnly ? null : (
              <DropdownMenuItem onClick={() => void onPdf()} disabled={!pdf && exported.length === 0}>
                <FileDown aria-hidden />
                {t('pdfDesigned')}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={() => void onExcel()}>
              <FileSpreadsheet aria-hidden />
              {t('excel')}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void onCsv()} disabled={!csv && exported.length === 0}>
              <FileText aria-hidden />
              {t('csv')}
            </DropdownMenuItem>
            {excelOnly || noPrint ? null : (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={print}>
                  <Printer aria-hidden />
                  {t('print')}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button variant="ghost" size="sm" onClick={() => setPicker(true)} disabled={disabled || exported.length === 0}>
          <Columns3 className="h-4 w-4" aria-hidden />
          {t('columns')}
          <Badge variant="secondary" className="ms-1">
            {t('chosenColumns', { count: chosenCount })}
          </Badge>
        </Button>
        {actions}
      </div>

      {/* The print template's header. Never on screen. */}
      {excelOnly || noPrint ? null : (
        <div className="report-print-header hidden print:block" dir="rtl">
          {headerLines(generatedAt).map((line, i) => (
            <div key={i} className={i === 0 ? 'text-lg font-bold' : 'text-sm'}>
              {line}
            </div>
          ))}
        </div>
      )}

      <Dialog open={picker} onOpenChange={setPicker}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('columnsTitle')}</DialogTitle>
            <DialogDescription>
              {t('columnsHint')} {t('source', { source: sourceLabel[mainSource] })}
            </DialogDescription>
          </DialogHeader>

          <div className="max-h-[50dvh] space-y-4 overflow-y-auto">
            {resolved.map((r) => {
              const chosen = new Set(r.keys);
              return (
                <fieldset key={r.table.id} className="space-y-1.5">
                  {resolved.length > 1 ? (
                    <legend className="mb-1 text-sm font-semibold">{r.table.title ?? title}</legend>
                  ) : null}
                  <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                    {r.table.columns
                      .filter((c) => !c.screenOnly)
                      .map((c) => {
                        const id = `export-${r.table.id}-${c.key}`;
                        return (
                          <label key={c.key} htmlFor={id} className="flex items-center gap-2 rounded-md px-1 py-1 text-sm hover:bg-muted/50">
                            <input
                              id={id}
                              type="checkbox"
                              className="h-4 w-4 accent-[var(--primary)]"
                              checked={chosen.has(c.key)}
                              disabled={chosen.has(c.key) && chosen.size === 1}
                              onChange={(e) => toggle(r.table.id, c.key, e.target.checked)}
                            />
                            <span className="min-w-0 truncate">{c.header}</span>
                          </label>
                        );
                      })}
                  </div>
                </fieldset>
              );
            })}
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                setCurrent(
                  qualifiedExportList(
                    resolved.map((r) => ({
                      tableId: r.table.id,
                      keys: visibleColumnKeys(
                        r.table.columns.filter((c) => !c.screenOnly),
                        byReport[prefsKeyOf(reportKey, r.table.id)] ?? null,
                      ),
                    })),
                  ),
                )
              }
            >
              {t('asTable')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                setCurrent(
                  qualifiedExportList(
                    resolved.map((r) => ({ tableId: r.table.id, keys: r.table.columns.filter((c) => !c.screenOnly).map((c) => c.key) })),
                  ),
                )
              }
            >
              {t('all')}
            </Button>
            {companyDefault?.columns.length ? (
              <Button variant="outline" size="sm" onClick={() => setCurrent(companyDefault.columns)}>
                {t('companyDefault')}
              </Button>
            ) : null}
          </div>

          <div className={excelOnly ? 'hidden' : 'space-y-1'}>
            <Label className="text-xs">{t('orientation')}</Label>
            <Select
              value={orientation}
              onValueChange={(v) => setOrientation((v as Orientation) ?? 'auto')}
              items={[
                { value: 'auto', label: t('orientationAuto') },
                { value: 'portrait', label: t('orientationPortrait') },
                { value: 'landscape', label: t('orientationLandscape') },
              ]}
            >
              <SelectTrigger className="w-full sm:w-72">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto" label={t('orientationAuto')}>
                  {t('orientationAuto')}
                </SelectItem>
                <SelectItem value="portrait" label={t('orientationPortrait')}>
                  {t('orientationPortrait')}
                </SelectItem>
                <SelectItem value="landscape" label={t('orientationLandscape')}>
                  {t('orientationLandscape')}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          {canEdit ? (
            <div className="space-y-2 rounded-md border bg-muted/30 p-3">
              <p className="text-muted-foreground text-xs">{t('companyDefaultHint', { company: companyLabel })}</p>
              {companyDefault?.inherited ? (
                <p className="text-muted-foreground text-xs">{t('companyDefaultInherited')}</p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  onClick={() =>
                    defaultList
                      ? void saveDefault(defaultList)
                      : toast.error(t('companyDefaultTooMany', { max: MAX_DEFAULT_COLUMNS }))
                  }
                  disabled={busy === 'save'}
                >
                  {busy === 'save' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
                  {t('saveCompanyDefault')}
                </Button>
                {companyDefault && !companyDefault.inherited && companyDefault.columns.length ? (
                  <Button variant="ghost" size="sm" onClick={() => void saveDefault([])} disabled={busy === 'save'}>
                    {t('clearCompanyDefault')}
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}

          <DialogFooter>
            <Button size="sm" onClick={() => setPicker(false)}>
              {t('done')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

