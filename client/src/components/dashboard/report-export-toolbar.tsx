'use client';

/**
 * One toolbar for every report: Excel · Print · PDF (docs/ACCOUNTING_EXPORT_AND_REPORTS.md §4.1).
 *
 * * Excel is built here, in the browser, from the rows the page already shows
 *   (`lib/excelExport.ts`): an RTL sheet with real numbers and a totals row.
 * * Print and PDF share one print template: the dashboard chrome and the filters hide
 *   themselves (`print:hidden`), this component's header — business, shop, range,
 *   generated at — appears at the top, and the page box carries "page X of Y"
 *   (`html[data-print='report']` in globals.css). PDF is the browser's own "save as
 *   PDF" from that same print, so Hebrew renders with the page's fonts rather than a
 *   server's.
 */

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { FileDown, FileSpreadsheet, Loader2, Printer } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useScope } from '@/lib/scope';
import { formatDateTime } from '@/lib/format';
import { downloadExcel, safeFileName, type ExcelSheet } from '@/lib/excelExport';
import { axiosErrorToToastMessage } from '@/lib/apiError';

export interface ReportExportToolbarProps {
  /** The report's name, as its page heading says it. */
  title: string;
  /** Inclusive ISO dates of the window, when the report has one. */
  from?: string;
  to?: string;
  /** Free text under the title in print and Excel (e.g. "סניף מרכז · קופה 2"). Defaults to the scope. */
  scopeLabel?: string;
  /**
   * The sheet(s) to write; called on click so it reads the rows as shown. May be async:
   * a paged list fetches every row the current filters match first (`lib/fetchAllPages.ts`,
   * or the page's export endpoint) — an export is never just the page on screen.
   */
  getSheets: () => ExcelSheet | ExcelSheet[] | Promise<ExcelSheet | ExcelSheet[]>;
  /** No data yet: the buttons are disabled. */
  disabled?: boolean;
  className?: string;
  /**
   * Excel only — no Print / PDF buttons and no print header: for a page that prints its own
   * documents (the Z list's A4 / 80 mm sequence, the Z page).
   */
  excelOnly?: boolean;
}

function dmy(iso?: string): string {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return d && m && y ? `${d}/${m}/${y}` : iso;
}

export function ReportExportToolbar({
  title,
  from,
  to,
  scopeLabel,
  getSheets,
  disabled,
  className = '',
  excelOnly = false,
}: ReportExportToolbarProps) {
  const t = useTranslations('reportExport');
  const scope = useScope();
  const [busy, setBusy] = useState(false);
  const [generatedAt, setGeneratedAt] = useState(() => new Date().toISOString());

  const business = scope.company?.name ?? t('allOrganization');
  const where =
    scopeLabel ??
    [scope.shop?.name, scope.machine?.name].filter(Boolean).join(' · ');
  const range = from || to ? (from === to ? dmy(from) : `${dmy(from)} – ${dmy(to)}`) : '';

  useEffect(() => {
    const after = () => {
      delete document.documentElement.dataset.print;
    };
    window.addEventListener('afterprint', after);
    return () => window.removeEventListener('afterprint', after);
  }, []);

  const heading = (): string[] =>
    [
      title,
      [business, where].filter(Boolean).join(' · '),
      range ? t('range', { range }) : '',
      t('generatedAt', { at: formatDateTime(new Date().toISOString()) }),
    ].filter(Boolean);

  const onExcel = async () => {
    setBusy(true);
    try {
      const sheets = await getSheets();
      const list = Array.isArray(sheets) ? sheets : [sheets];
      await downloadExcel(
        list.map((s, i) => ({ ...s, heading: i === 0 ? heading() : s.heading })),
        [title, from, to].filter(Boolean).join('_'),
      );
    } catch (err) {
      // A list too long to export says so (the server's own words), never just "failed".
      toast.error(axiosErrorToToastMessage(err, t('excelFailed')));
    } finally {
      setBusy(false);
    }
  };

  const print = (asPdf: boolean) => {
    setGeneratedAt(new Date().toISOString());
    document.documentElement.dataset.print = 'report';
    const previousTitle = document.title;
    // The browser offers the document title as the PDF's file name.
    if (asPdf) document.title = safeFileName([title, from, to].filter(Boolean).join('_'));
    // Let React paint the fresh "generated at" before the dialog freezes the page.
    window.setTimeout(() => {
      window.print();
      document.title = previousTitle;
    }, 50);
  };

  return (
    <>
      <div className={`flex flex-wrap items-center gap-2 print:hidden ${className}`}>
        <Button variant="outline" size="sm" onClick={onExcel} disabled={disabled || busy}>
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <FileSpreadsheet className="h-4 w-4" aria-hidden />
          )}
          {t('excel')}
        </Button>
        {excelOnly ? null : (
          <>
            <Button variant="outline" size="sm" onClick={() => print(false)} disabled={disabled}>
              <Printer className="h-4 w-4" aria-hidden />
              {t('print')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => print(true)}
              disabled={disabled}
              title={t('pdfHint')}
            >
              <FileDown className="h-4 w-4" aria-hidden />
              {t('pdf')}
            </Button>
          </>
        )}
      </div>

      {/* The print template's header. Never on screen. */}
      <div className={`report-print-header hidden ${excelOnly ? '' : 'print:block'}`} dir="rtl">
        <div className="text-lg font-bold">{title}</div>
        <div className="text-sm">
          {[business, where].filter(Boolean).join(' · ')}
          {range ? ` · ${t('range', { range })}` : ''}
        </div>
        <div className="text-xs">{t('generatedAt', { at: formatDateTime(generatedAt) })}</div>
      </div>
    </>
  );
}
