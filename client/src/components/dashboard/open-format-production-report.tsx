'use client';

/**
 * The production report ("דוח הפקה") of an open-format file — 1.31 §2.6, laid out as the
 * regulation's sample: the business, "ביצוע ממשק פתוח הסתיים בהצלחה", where the files were
 * saved, the period, the totals per document type and per record type, and the software.
 * These are the numbers the Tax Authority's simulator asks for. Printable (the page hides
 * everything else in print), so "save as PDF" from the print dialog gives the PDF.
 */

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Printer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { reportDate, type OpenFormatProductionReport } from '@/lib/taxOpenFormatForm';

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex flex-wrap gap-x-2">
      <dt className="text-muted-foreground print:text-black">{label}:</dt>
      <dd className="min-w-0 break-all font-medium">{value}</dd>
    </div>
  );
}

const th = 'border px-2 py-1 text-start font-semibold bg-muted/50 print:bg-transparent';
const td = 'border px-2 py-1';
const num = `${td} text-end tabular-nums`;

export function OpenFormatProductionReportView({
  report,
  previewOnly = false,
}: {
  report: OpenFormatProductionReport;
  previewOnly?: boolean;
}) {
  const t = useTranslations('taxReports.productionReport');
  const anyCancelled = report.documents.some((d) => d.cancelledCount > 0);
  const docSum = report.documents.reduce((acc, d) => acc + Math.round(parseFloat(d.total) * 100), 0);
  const shekels = (agorot: number) => `${agorot < 0 ? '-' : ''}${Math.floor(Math.abs(agorot) / 100)}.${String(Math.abs(agorot) % 100).padStart(2, '0')}`;

  return (
    <section
      aria-label={t('title')}
      className="space-y-4 rounded-lg border bg-background p-4 text-sm print:border-0 print:p-0 print:text-black"
      data-open-format-production-report
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-lg font-bold">{t('heading')}</h2>
          <p className="font-semibold">{t('success')}</p>
        </div>
        <Button type="button" size="sm" variant="outline" className="print:hidden" onClick={() => window.print()}>
          <Printer className="size-4" />
          {t('print')}
        </Button>
      </div>

      {previewOnly ? <p className="text-amber-700 dark:text-amber-400 print:hidden">{t('previewOnly')}</p> : null}

      <dl className="grid gap-1 sm:grid-cols-2">
        <Row label={t('vatNumber')} value={report.business.vatNumber || '—'} />
        <Row label={t('businessName')} value={report.business.name || '—'} />
        {report.business.address || report.business.city ? (
          <Row label={t('address')} value={[report.business.address, report.business.city].filter(Boolean).join(', ')} />
        ) : null}
        <Row
          label={t('period')}
          value={
            report.taxYear
              ? `${t('taxYear')} ${report.taxYear}`
              : t('periodRange', { from: reportDate(report.periodFrom), to: reportDate(report.periodTo) })
          }
        />
        <Row
          label={t('savedTo')}
          value={report.outputPath ? <span dir="ltr" className="font-mono">{report.outputPath}</span> : t('pathNotSet')}
        />
        <Row label={t('files')} value={<span dir="ltr">{report.files.join(', ')}</span>} />
        {report.fileName ? <Row label={t('fileName')} value={<span dir="ltr">{report.fileName}</span>} /> : null}
        <Row label={t('primaryId')} value={<span dir="ltr" className="font-mono">{report.primaryId}</span>} />
        <Row
          label={t('producedAt')}
          value={`${reportDate(report.producedDate)} ${report.producedTime ?? ''}`.trim()}
        />
      </dl>

      <div className="space-y-1">
        <h3 className="font-semibold">{t('documentsTitle')}</h3>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                <th className={th}>{t('docCode')}</th>
                <th className={th}>{t('docName')}</th>
                <th className={`${th} text-end`}>{t('docCount')}</th>
                <th className={`${th} text-end`}>{t('docTotal')}</th>
                {anyCancelled ? <th className={`${th} text-end`}>{t('docCancelled')}</th> : null}
              </tr>
            </thead>
            <tbody>
              {report.documents.length === 0 ? (
                <tr>
                  <td className={td} colSpan={anyCancelled ? 5 : 4}>
                    {t('noDocuments')}
                  </td>
                </tr>
              ) : (
                report.documents.map((d) => (
                  <tr key={d.code}>
                    <td className={`${td} font-mono`}>{d.code}</td>
                    <td className={td}>{d.name}</td>
                    <td className={num}>{d.count.toLocaleString('he-IL')}</td>
                    <td className={num} dir="ltr">{d.total}</td>
                    {anyCancelled ? (
                      <td className={num}>
                        {d.cancelledCount > 0 ? (
                          <>
                            {d.cancelledCount} · <span dir="ltr">{d.cancelledTotal}</span>
                          </>
                        ) : (
                          '0'
                        )}
                      </td>
                    ) : null}
                  </tr>
                ))
              )}
            </tbody>
            {report.documents.length > 1 ? (
              <tfoot>
                <tr className="font-semibold">
                  <td className={td} colSpan={2}>{t('total')}</td>
                  <td className={num}>{report.documentsCount.toLocaleString('he-IL')}</td>
                  <td className={num} dir="ltr">{shekels(docSum)}</td>
                  {anyCancelled ? <td className={td} /> : null}
                </tr>
              </tfoot>
            ) : null}
          </table>
        </div>
        {anyCancelled ? <p className="text-muted-foreground text-xs print:text-black">{t('cancelledNote')}</p> : null}
      </div>

      <div className="space-y-1">
        <h3 className="font-semibold">{t('recordsTitle')}</h3>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                <th className={th}>{t('recCode')}</th>
                <th className={th}>{t('recName')}</th>
                <th className={`${th} text-end`}>{t('recCount')}</th>
              </tr>
            </thead>
            <tbody>
              {report.records.map((r) => (
                <tr key={r.code}>
                  <td className={`${td} font-mono`}>{r.code}</td>
                  <td className={td}>{r.name}</td>
                  <td className={num}>{r.count.toLocaleString('he-IL')}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="font-semibold">
                <td className={td} colSpan={2}>{t('total')}</td>
                <td className={num}>{report.recordsTotal.toLocaleString('he-IL')}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      {report.payments.length > 0 ? (
        <div className="space-y-1">
          <h3 className="font-semibold">{t('paymentsTitle')}</h3>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  <th className={th}>{t('payCode')}</th>
                  <th className={th}>{t('payName')}</th>
                  <th className={`${th} text-end`}>{t('payCount')}</th>
                  <th className={`${th} text-end`}>{t('payTotal')}</th>
                </tr>
              </thead>
              <tbody>
                {report.payments.map((p) => (
                  <tr key={p.code}>
                    <td className={`${td} font-mono`}>{p.code}</td>
                    <td className={td}>{p.name}</td>
                    <td className={num}>{p.count.toLocaleString('he-IL')}</td>
                    <td className={num} dir="ltr">{p.total}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {report.unmappedTenders.length > 0 ? (
            <p className="text-amber-700 dark:text-amber-400 print:text-black">
              {t('unmapped', { list: report.unmappedTenders.map((u) => `${u.method} (${u.count})`).join(', ') })}
            </p>
          ) : null}
        </div>
      ) : null}

      <p className="text-muted-foreground border-t pt-2 text-xs print:text-black">
        {t('software', {
          name: report.software.name,
          version: report.software.version,
          registration: report.software.registrationNumber,
          manufacturer: report.software.manufacturerName,
          manufacturerVat: report.software.manufacturerVatNumber,
        })}
      </p>
    </section>
  );
}
