'use client';

/**
 * "דו״ח Z — גרסה 2" on the Z page: the owner's sections — sales, VAT, payments, tips, receipts,
 * the drawer, then the card transmission, "כמה נמכר", order types, card brands and per employee —
 * as the till and the cloud print them: the same lines (lib/zReportSections.ts, pinned by the
 * shared golden fixture), in shekels, one card per block.
 */

import { useTranslations } from 'next-intl';
import { formatCurrency, formatDateTime } from '@/lib/format';
import { zSectionLines, type ZReportSections, type ZSectionsLabels } from '@/lib/zReportSections';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export function ZReportSectionsCards({
  sections,
  source,
  exempt,
}: {
  sections: ZReportSections | null | undefined;
  source?: string | null;
  exempt?: boolean;
}) {
  const t = useTranslations('zReports.reportSections');
  if (!sections) return null;
  const blocks = zSectionLines(sections, t.raw('labels') as ZSectionsLabels, {
    exempt,
    fmt: (v) => formatCurrency(v),
    stamp: (iso) => formatDateTime(iso),
  });
  return (
    <section className="space-y-2" aria-label={t('title')}>
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="text-lg font-semibold">{t('title')}</h2>
        {source === 'documents' ? <p className="text-muted-foreground text-xs">{t('fromDocuments')}</p> : null}
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {blocks.map(([title, rows]) => (
          <Card key={title}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1 text-sm">
              {rows.map(([label, value, bold], i) => (
                <div
                  key={`${label}-${i}`}
                  className={`flex items-baseline justify-between gap-3 ${bold ? 'font-semibold' : ''} ${label.startsWith('  ') ? 'ps-3 text-muted-foreground' : ''}`}
                >
                  <span className="min-w-0 break-words">{label.trim()}</span>
                  <span className="shrink-0 tabular-nums" dir="auto">{value}</span>
                </div>
              ))}
            </CardContent>
          </Card>
        ))}
      </div>
    </section>
  );
}
