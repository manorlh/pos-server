'use client';

/**
 * "פירוט לפי מלצר" on a Z: per waiter, what the Z's documents took — a table's sale (and
 * its parts, and its credit note) by the table's waiter, any other sale by its cashier.
 * The server's `byWaiter` (frozen on the Z at build time; for a Z built before that, read
 * from its documents). The rows add up to the Z.
 */

import { useTranslations } from 'next-intl';
import { formatCurrency } from '@/lib/format';
import type { ZWaiterRow } from '@/lib/types';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

export function WaiterSummaryCard({
  rows,
  source,
}: {
  rows: ZWaiterRow[] | null | undefined;
  source?: string | null;
}) {
  const t = useTranslations('zReports.waiters');
  if (!rows || rows.length === 0) return null;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{t('title')}</CardTitle>
        {source === 'documents' ? <p className="text-muted-foreground text-xs">{t('fromDocuments')}</p> : null}
      </CardHeader>
      <CardContent className="overflow-x-auto p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('col.waiter')}</TableHead>
              <TableHead className="text-end">{t('col.tables')}</TableHead>
              <TableHead className="text-end">{t('col.sales')}</TableHead>
              <TableHead className="text-end">{t('col.refunds')}</TableHead>
              <TableHead className="text-end">{t('col.net')}</TableHead>
              <TableHead className="text-end">{t('col.cash')}</TableHead>
              <TableHead className="text-end">{t('col.card')}</TableHead>
              <TableHead className="text-end">{t('col.tips')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r, i) => (
              <TableRow key={`${r.waiterId ?? r.waiter ?? 'none'}-${i}`}>
                <TableCell className="whitespace-nowrap">{r.waiter || t('none')}</TableCell>
                <TableCell className="text-end tabular-nums">
                  {r.tables > 0 ? `${r.tables} · ${t('guests', { n: r.guests })}` : '—'}
                </TableCell>
                <TableCell className="text-end tabular-nums">
                  {formatCurrency(r.sales)} <span className="text-muted-foreground text-xs">({r.salesCount})</span>
                </TableCell>
                <TableCell className="text-end tabular-nums">
                  {r.refundsCount > 0 ? (
                    <>
                      {formatCurrency(-Number(r.refunds))}{' '}
                      <span className="text-muted-foreground text-xs">({r.refundsCount})</span>
                    </>
                  ) : (
                    '—'
                  )}
                </TableCell>
                <TableCell className="text-end font-medium tabular-nums">{formatCurrency(r.net)}</TableCell>
                <TableCell className="text-end tabular-nums">{formatCurrency(r.cash)}</TableCell>
                <TableCell className="text-end tabular-nums">{formatCurrency(r.card)}</TableCell>
                <TableCell className="text-end tabular-nums">{Number(r.tips) ? formatCurrency(r.tips) : '—'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
