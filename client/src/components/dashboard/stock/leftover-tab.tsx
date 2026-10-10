'use client';

/**
 * "נשאר בסוף היום" — what each daily reset found before it set the opening stock: per location and
 * product, what was left, the opening it went back to, and the difference (a shortfall when topping up
 * from the store found too little there). Late sales from tills that were offline are counted in.
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { cn } from '@/lib/utils';
import { ReportExportToolbar } from '@/components/dashboard/report-export-toolbar';
import { formatQty, locationLabel } from '@/lib/stockLive';
import { fetchLeftover, stockKeys, type LeftoverRow } from '@/lib/stockLiveApi';

export function LeftoverTab({ scope }: { scope: { companyId?: string | null; shopId?: string | null } }) {
  const [day, setDay] = useState('');
  const data = useQuery({ queryKey: stockKeys.leftover(scope, day || null), queryFn: () => fetchLeftover(scope, day || null) });
  const rows = useMemo(() => data.data ?? [], [data.data]);
  const groups = useMemo(() => {
    const out = new Map<string, LeftoverRow[]>();
    for (const r of rows) {
      const list = out.get(r.resetId) ?? [];
      list.push(r);
      out.set(r.resetId, list);
    }
    return [...out.values()];
  }, [rows]);

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <label className="space-y-1 text-sm">
          <span className="block text-muted-foreground">יום שנסגר (ריק: האחרונים)</span>
          <Input type="date" value={day} onChange={(e) => setDay(e.target.value)} className="h-11 w-44" />
        </label>
        <ReportExportToolbar
          title="נשאר בסוף היום"
          disabled={rows.length === 0}
          getSheets={() => ({
            name: 'נשאר בסוף היום',
            columns: [
              { header: 'יום', width: 12 },
              { header: 'מיקום', width: 24 },
              { header: 'מוצר', width: 28 },
              { header: 'נשאר', kind: 'number' },
              { header: 'מלאי פתיחה', kind: 'number' },
              { header: 'שינוי', kind: 'number' },
              { header: 'חוסר במחסן', kind: 'number' },
            ],
            rows: rows.map((r) => [r.closedDay, locationLabel(r.location), r.productName ?? null, r.leftover, r.opening, r.delta, r.shortfall]),
          })}
        />
      </div>
      {data.isPending ? (
        <div className="h-40 animate-pulse rounded-2xl bg-muted" />
      ) : data.isError ? (
        <p className="text-sm text-destructive">{axiosErrorToToastMessage(data.error, 'הטעינה נכשלה')}</p>
      ) : groups.length === 0 ? (
        <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
          {day ? 'אין איפוסים ליום הזה' : 'עוד לא היו איפוסים יומיים. מפעילים איפוס ב"מלאי פתיחה ואיפוס יומי".'}
        </p>
      ) : (
        groups.map((g) => (
          <div key={g[0].resetId} className="space-y-1">
            <h3 className="text-sm font-semibold">
              {locationLabel(g[0].location)} · סוף יום {g[0].closedDay}
              <span className="font-normal text-muted-foreground"> · {g[0].trigger === 'manual' ? 'איפוס ידני' : 'איפוס אוטומטי'}</span>
            </h3>
            <div className="overflow-x-auto rounded-xl border bg-card">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>מוצר</TableHead>
                    <TableHead>נשאר</TableHead>
                    <TableHead>פתיחה</TableHead>
                    <TableHead>שינוי</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {g.map((r) => (
                    <TableRow key={`${r.resetId}-${r.productId}`}>
                      <TableCell className="font-medium">{r.productName ?? '—'}</TableCell>
                      <TableCell className={cn('tabular-nums', r.leftover < 0 && 'text-destructive')}>{formatQty(r.leftover)}</TableCell>
                      <TableCell className="tabular-nums">{formatQty(r.opening)}</TableCell>
                      <TableCell className="tabular-nums">
                        {r.delta > 0 ? '+' : ''}
                        {formatQty(r.delta)}
                        {r.shortfall ? <span className="ms-1 text-xs text-amber-700 dark:text-amber-400">(חסרו {formatQty(r.shortfall)} במחסן)</span> : null}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        ))
      )}
    </section>
  );
}
