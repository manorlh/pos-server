'use client';

/**
 * Card takings of a Z per brand (מותג) and per acquirer (חברת סליקה), sales and refunds
 * apart — the server's `cardBrands` on the Z detail (frozen in each till's section at
 * build time; for a Z built before that, read from its documents).
 */

import { useTranslations } from 'next-intl';
import { formatCurrency } from '@/lib/format';
import { totalsBy, useCardBrandLabels, type CardBrandBreakdownRow } from '@/lib/cardBrands';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

function useGroups(rows: CardBrandBreakdownRow[]) {
  const labels = useCardBrandLabels();
  return [
    { key: 'brand' as const, rows: totalsBy(rows, 'brand'), label: labels.brand },
    { key: 'acquirer' as const, rows: totalsBy(rows, 'acquirer'), label: labels.acquirer },
  ];
}

/** On screen: two small tables, by brand and by acquirer. */
export function CardBrandSummaryCard({
  rows,
  source,
}: {
  rows: CardBrandBreakdownRow[] | null | undefined;
  source?: string | null;
}) {
  const t = useTranslations('cardBrands');
  const groups = useGroups(rows ?? []);
  if (!rows || rows.length === 0) return null;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{t('zTitle')}</CardTitle>
        {source === 'documents' ? <p className="text-muted-foreground text-xs">{t('fromDocuments')}</p> : null}
      </CardHeader>
      <CardContent className="grid gap-4 md:grid-cols-2">
        {groups.map((g) => (
          <Table key={g.key}>
            <TableHeader>
              <TableRow>
                <TableHead>{t(`col.${g.key}`)}</TableHead>
                <TableHead className="text-end">{t('col.sales')}</TableHead>
                <TableHead className="text-end">{t('col.refunds')}</TableHead>
                <TableHead className="text-end">{t('col.net')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {g.rows.map((r) => (
                <TableRow key={r.code}>
                  <TableCell>{g.label(r.code)}</TableCell>
                  <TableCell className="text-end tabular-nums">
                    {formatCurrency(r.salesAmount)} <span className="text-muted-foreground text-xs">({r.salesCount})</span>
                  </TableCell>
                  <TableCell className="text-end tabular-nums">
                    {r.refundsCount > 0 ? (
                      <>
                        {formatCurrency(-r.refundsAmount)}{' '}
                        <span className="text-muted-foreground text-xs">({r.refundsCount})</span>
                      </>
                    ) : (
                      '—'
                    )}
                  </TableCell>
                  <TableCell className="text-end font-medium tabular-nums">{formatCurrency(r.net)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ))}
      </CardContent>
    </Card>
  );
}

/** In the A4 print: rows for the print document's own two-column tables. */
export function CardBrandPrintRows({
  rows,
  Row,
  SubHeading,
}: {
  rows: CardBrandBreakdownRow[];
  Row: (p: { label: string; value: React.ReactNode }) => React.ReactNode;
  SubHeading: (p: { children: React.ReactNode }) => React.ReactNode;
}) {
  const t = useTranslations('cardBrands');
  const groups = useGroups(rows);
  return (
    <>
      {groups.map((g) => (
        <GroupRows key={g.key} title={t(`print.${g.key}`)} SubHeading={SubHeading}>
          {g.rows.map((r) => (
            <Row
              key={r.code}
              label={
                r.refundsCount > 0
                  ? t('print.lineWithRefunds', {
                      name: g.label(r.code),
                      count: r.salesCount + r.refundsCount,
                      refunds: formatCurrency(r.refundsAmount),
                    })
                  : t('print.line', { name: g.label(r.code), count: r.salesCount })
              }
              value={formatCurrency(r.net)}
            />
          ))}
        </GroupRows>
      ))}
    </>
  );
}

function GroupRows({
  title,
  SubHeading,
  children,
}: {
  title: string;
  SubHeading: (p: { children: React.ReactNode }) => React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <>
      <SubHeading>{title}</SubHeading>
      {children}
    </>
  );
}
