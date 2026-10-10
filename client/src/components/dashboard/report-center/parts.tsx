'use client';

/** Small shared pieces of the report center pages: a section card, a plain table, a KPI grid, a status badge. */

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import type { ReconciliationStatus } from '@/lib/reportCenterApi';

export function Section({ title, children, note }: { title: string; children: ReactNode; note?: ReactNode }) {
  return (
    <Card className="break-inside-avoid">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
        {note ? <p className="text-muted-foreground text-xs">{note}</p> : null}
      </CardHeader>
      <CardContent className="overflow-x-auto p-0">{children}</CardContent>
    </Card>
  );
}

export interface SimpleColumn<T> {
  label: string;
  cell: (row: T) => ReactNode;
  end?: boolean;
  className?: string;
}

export function SimpleTable<T>({
  columns,
  rows,
  footer,
  empty,
  rowClassName,
  limit,
  more,
}: {
  columns: SimpleColumn<T>[];
  rows: T[];
  footer?: ReactNode[];
  empty: string;
  rowClassName?: (row: T) => string | undefined;
  /** Rows shown on screen; the Excel has them all. */
  limit?: number;
  more?: (hidden: number) => string;
}) {
  const shown = limit ? rows.slice(0, limit) : rows;
  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            {columns.map((c, i) => (
              <TableHead key={i} className={c.end ? 'text-end' : undefined}>{c.label}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={columns.length} className="text-muted-foreground py-6 text-center">{empty}</TableCell>
            </TableRow>
          ) : (
            shown.map((row, r) => (
              <TableRow key={r} className={rowClassName?.(row)}>
                {columns.map((c, i) => (
                  <TableCell key={i} className={`${c.end ? 'text-end tabular-nums' : ''} ${c.className ?? ''}`}>{c.cell(row)}</TableCell>
                ))}
              </TableRow>
            ))
          )}
        </TableBody>
        {footer && rows.length > 0 ? (
          <TableFooter>
            <TableRow>
              {footer.map((f, i) => (
                <TableCell key={i} className={`font-semibold ${columns[i]?.end ? 'text-end tabular-nums' : ''}`}>{f}</TableCell>
              ))}
            </TableRow>
          </TableFooter>
        ) : null}
      </Table>
      {limit && rows.length > limit && more ? (
        <p className="text-muted-foreground px-4 py-2 text-xs">{more(rows.length - limit)}</p>
      ) : null}
    </>
  );
}

export function KpiGrid({ items }: { items: { label: string; value: ReactNode; tone?: 'warn' | 'bad' }[] }) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-6">
      {items.map((k) => (
        <div
          key={k.label}
          className={`rounded-lg border bg-card p-3 ${k.tone === 'bad' ? 'border-destructive/50' : k.tone === 'warn' ? 'border-amber-500/50' : ''}`}
        >
          <div className="text-muted-foreground text-xs">{k.label}</div>
          <div className="text-lg font-semibold tabular-nums">{k.value}</div>
        </div>
      ))}
    </div>
  );
}

const STATUS_VARIANT: Record<ReconciliationStatus, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  match: 'secondary',
  difference: 'outline',
  missing: 'destructive',
  pending: 'outline',
};

export const STATUS_ROW: Record<ReconciliationStatus, string | undefined> = {
  match: undefined,
  difference: 'bg-amber-50 dark:bg-amber-950/30',
  missing: 'bg-red-50 dark:bg-red-950/30',
  pending: 'bg-sky-50 dark:bg-sky-950/30',
};

export function StatusBadge({ status }: { status: ReconciliationStatus }) {
  const t = useTranslations('reportCenter.status');
  return (
    <Badge
      variant={STATUS_VARIANT[status]}
      className={status === 'difference' ? 'border-amber-500 text-amber-700 dark:text-amber-400' : status === 'pending' ? 'border-sky-500 text-sky-700 dark:text-sky-400' : undefined}
    >
      {t(status)}
    </Badge>
  );
}
