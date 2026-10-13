'use client';

/**
 * "נשאר בסוף היום" — what each daily reset found before it set the opening stock: per location and
 * product, what was left, the opening it went back to, and the difference (a shortfall when topping up
 * from the store found too little there). Late sales from tills that were offline are counted in.
 *
 * One sortable table (the report framework's `ReportTable`, P:\specs\reports-upgrade.md §5): each
 * reset's day, location and trigger are columns of its rows. The day picked lives in the URL
 * (`?day=`); the export is the framework's (`stock-leftover`) with the Excel's columns as before.
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Input } from '@/components/ui/input';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { dmy } from '@/lib/reportExport';
import { cn } from '@/lib/utils';
import { ReportExportBar, ReportTable, useReportExportScope, type ReportTableSpec } from '@/components/dashboard/report-framework';
import { formatQty, locationLabel } from '@/lib/stockLive';
import { fetchLeftover, stockKeys, type LeftoverRow } from '@/lib/stockLiveApi';
import { useStockUrlParams } from './quick-stock-tab';

const REPORT_KEY = 'stock-leftover';

const triggerText = (r: LeftoverRow) => (r.trigger === 'manual' ? 'איפוס ידני' : 'איפוס אוטומטי');

export function LeftoverTab({ scope }: { scope: { companyId?: string | null; shopId?: string | null } }) {
  const [params, setParams] = useStockUrlParams();
  const rawDay = params.get('day') ?? '';
  const day = /^\d{4}-\d{2}-\d{2}$/.test(rawDay) ? rawDay : '';
  const setDay = (v: string) => setParams({ day: v || null });
  const data = useQuery({ queryKey: stockKeys.leftover(scope, day || null), queryFn: () => fetchLeftover(scope, day || null) });
  const rows = useMemo(() => data.data ?? [], [data.data]);
  const exportScope = useReportExportScope();

  const table: ReportTableSpec<LeftoverRow> = {
    id: 'main',
    title: 'נשאר בסוף היום',
    rows,
    rowKey: (r) => `${r.resetId}-${r.productId}`,
    columns: [
      { key: 'day', header: 'יום', kind: 'date', width: 12, value: (r) => r.closedDay },
      { key: 'location', header: 'מיקום', width: 24, value: (r) => locationLabel(r.location) },
      // The reset's trigger, as each reset's heading said it; on screen only (the Excel never had it).
      { key: 'trigger', header: 'איפוס', screenOnly: true, className: 'text-muted-foreground', value: triggerText },
      { key: 'product', header: 'מוצר', required: true, width: 28, className: 'font-medium', value: (r) => r.productName ?? null },
      {
        key: 'leftover',
        header: 'נשאר',
        kind: 'number',
        value: (r) => r.leftover,
        cell: (r) => <span className={cn(r.leftover < 0 && 'text-destructive')}>{formatQty(r.leftover)}</span>,
      },
      { key: 'opening', header: 'מלאי פתיחה', kind: 'number', value: (r) => r.opening, cell: (r) => formatQty(r.opening) },
      {
        key: 'delta',
        header: 'שינוי',
        kind: 'number',
        value: (r) => r.delta,
        cell: (r) => (
          <>
            {r.delta > 0 ? '+' : ''}
            {formatQty(r.delta)}
            {r.shortfall ? <span className="ms-1 text-xs text-amber-700 dark:text-amber-400">(חסרו {formatQty(r.shortfall)} במחסן)</span> : null}
          </>
        ),
      },
      // On screen: the note in the change's cell.
      { key: 'shortfall', header: 'חוסר במחסן', kind: 'number', exportOnly: true, value: (r) => r.shortfall },
    ],
  };

  return (
    <section className="space-y-3">
      <label className="block space-y-1 text-sm">
        <span className="block text-muted-foreground">יום שנסגר (ריק: האחרונים)</span>
        <Input type="date" value={day} onChange={(e) => setDay(e.target.value)} className="h-11 w-44" />
      </label>
      <ReportExportBar
        reportKey={REPORT_KEY}
        title="נשאר בסוף היום"
        tables={[table] as ReportTableSpec<unknown>[]}
        business={exportScope.business}
        place={exportScope.place}
        filterLines={day ? [{ label: 'יום שנסגר', value: dmy(day) }] : []}
        companyId={exportScope.companyId}
        companyName={exportScope.companyName}
        disabled={rows.length === 0}
      />
      {data.isPending ? (
        <div className="h-40 animate-pulse rounded-2xl bg-muted" />
      ) : data.isError ? (
        <p className="text-sm text-destructive">{axiosErrorToToastMessage(data.error, 'הטעינה נכשלה')}</p>
      ) : rows.length === 0 ? (
        <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
          {day ? 'אין איפוסים ליום הזה' : 'עוד לא היו איפוסים יומיים. מפעילים איפוס ב"מלאי פתיחה ואיפוס יומי".'}
        </p>
      ) : (
        <ReportTable table={table} reportKey={REPORT_KEY} />
      )}
    </section>
  );
}
