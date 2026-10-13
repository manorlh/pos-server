'use client';

/**
 * The report's export bar (P:\specs\reports-upgrade.md §2ב–ד): אקסל · PDF · הדפסה · עמודות לייצוא.
 *
 * * The columns that go out, first match wins: the choice made here for this export → the
 *   company's default for the report (`report_export_defaults`) → the columns the reader sees
 *   → all. A company manager, a distributor or the super admin (the server's `canEdit`) can
 *   save the current choice as the company's default.
 * * Excel: every sheet opens with the header lines (title, business and shop, range, hours,
 *   the chosen filters, generated at) and carries only the chosen columns, with its totals
 *   row; the file is named "מכירות לפי מוצר — סניף X — 01.10–13.10.xlsx".
 * * PDF: a real file from `POST /reports/pdf` (the main table, the same columns and header).
 *   A server without it: the browser's print, "save as PDF" — as before.
 * * Print: unchanged — the page's print template with its header.
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Columns3, FileDown, FileSpreadsheet, Loader2, Printer } from 'lucide-react';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { formatDateTime } from '@/lib/format';
import { downloadBlob, downloadExcel, type ExcelSheet } from '@/lib/excelExport';
import {
  MAIN_TABLE,
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
import { PDF_MAX_ROWS, fetchReportPdf, saveExportDefault } from '@/lib/reportFrameworkApi';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
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
}

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
  };
}

export function ReportExportBar({
  reportKey,
  title,
  tables,
  extraSheets,
  extraSheetsFirst = false,
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
  const [busy, setBusy] = useState<'excel' | 'pdf' | 'save' | null>(null);
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

  const onExcel = async () => {
    setBusy('excel');
    try {
      const sheets = await Promise.all(
        resolved.map(async (r) => {
          const p = await prepare(r);
          return exportTableSheet(p.table, p.keys);
        }),
      );
      const extra = (await extraSheets?.()) ?? [];
      await downloadExcel(extraSheetsFirst ? [...extra, ...sheets] : [...sheets, ...extra], fileName, {
        heading: headerLines(new Date().toISOString()),
        readableName: true,
      });
    } catch (err) {
      toast.error(axiosErrorToToastMessage(err, t('excelFailed')));
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
    const r = resolved.find((x) => x.table.id === pdfTableId) ?? resolved[0];
    if (!r) return;
    setBusy('pdf');
    try {
      const { table, keys } = await prepare(r);
      if (table.rows.length > PDF_MAX_ROWS) {
        toast.error(t('pdfTooMany', { max: PDF_MAX_ROWS.toLocaleString('he-IL') }));
        return;
      }
      const pdfTitle = r.table.id !== MAIN_TABLE && r.table.title ? `${title} · ${r.table.title}` : title;
      const range = rangeText(from, to);
      const blob = await fetchReportPdf(
        exportTablePdfBody(
          table,
          keys,
          {
            title: pdfTitle,
            subtitleLines: [
              [business, place].filter((s) => s && s.trim()).join(' · '),
              range ? t('rangeLine', { range }) : '',
              hours ? t('hoursLine', { band: hours }) : '',
            ].filter(Boolean),
            filterLines: filterLines.map((f) => `${f.label}: ${f.value}`),
            fileName,
            companyId,
          },
          orientation,
        ),
      );
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
  const allQualified = qualifiedExportList(resolved.map((r) => ({ tableId: r.table.id, keys: r.keys })));

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 print:hidden">
        <Button variant="outline" size="sm" onClick={onExcel} disabled={disabled || busy !== null}>
          {busy === 'excel' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <FileSpreadsheet className="h-4 w-4" aria-hidden />}
          {t('excel')}
        </Button>
        {excelOnly ? null : (
          <>
            <Button variant="outline" size="sm" onClick={onPdf} disabled={disabled || busy !== null}>
              {busy === 'pdf' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <FileDown className="h-4 w-4" aria-hidden />}
              {t('pdf')}
            </Button>
            <Button variant="outline" size="sm" onClick={print} disabled={disabled}>
              <Printer className="h-4 w-4" aria-hidden />
              {t('print')}
            </Button>
          </>
        )}
        <Button variant="ghost" size="sm" onClick={() => setPicker(true)} disabled={disabled || exported.length === 0}>
          <Columns3 className="h-4 w-4" aria-hidden />
          {t('columns')}
          <Badge variant="secondary" className="ms-1">
            {t('chosenColumns', { count: chosenCount })}
          </Badge>
        </Button>
      </div>

      {/* The print template's header. Never on screen. */}
      {excelOnly ? null : (
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
                <Button size="sm" onClick={() => void saveDefault(allQualified)} disabled={busy === 'save'}>
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

