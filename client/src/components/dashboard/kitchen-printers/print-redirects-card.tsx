'use client';

/**
 * "מדפסת חלופית" — the last week's tickets and receipts that an employee sent to another
 * printer because theirs was not available (till parameter "שאלה על מדפסת חלופית כשמדפסת לא
 * זמינה", set in "הגדרות הדפסה" above). Shown only when there are some.
 */

import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { formatDateTime } from '@/lib/format';
import { fetchPrintRedirects } from '@/lib/printerScanApi';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

export function PrintRedirectsCard({ shopId }: { shopId: string }) {
  const t = useTranslations('kitchenPrinters.failover');
  const { data = [] } = useQuery({
    queryKey: ['print-redirects', shopId],
    queryFn: () => fetchPrintRedirects(shopId, 7),
    enabled: !!shopId,
  });
  if (data.length === 0) return null;

  return (
    <section className="space-y-2 rounded-lg border p-4">
      <div>
        <h2 className="text-lg font-semibold">{t('title')}</h2>
        <p className="text-sm text-muted-foreground">{t('hint')}</p>
      </div>
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('columns.when')}</TableHead>
              <TableHead>{t('columns.till')}</TableHead>
              <TableHead>{t('columns.what')}</TableHead>
              <TableHead>{t('columns.fromTo')}</TableHead>
              <TableHead>{t('columns.who')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="whitespace-nowrap text-sm">{formatDateTime(r.occurredAt)}</TableCell>
                <TableCell className="text-sm">{r.machineName ?? '—'}</TableCell>
                <TableCell className="text-sm">
                  {r.ticket ?? (r.kind === 'receipt' ? t('receipt') : t('ticket'))}
                </TableCell>
                <TableCell className="text-sm">
                  {t('fromTo', { from: r.fromName ?? '?', to: r.toName ?? '?' })}
                  {r.temporaryUntil && (
                    <div className="text-xs text-muted-foreground">
                      {t('temporary', { until: formatDateTime(r.temporaryUntil) })}
                    </div>
                  )}
                  {r.error && <div className="text-xs text-muted-foreground">{r.error}</div>}
                </TableCell>
                <TableCell className="text-sm">{r.posUserName ?? '—'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}
