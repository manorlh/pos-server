'use client';

/**
 * The tables report: revenue, guests and average seating time per table and per zone
 * (paid orders, by the day they were paid), and cancellations by reason and by employee,
 * with every cancelled table listed (who, approver, what was on it).
 *
 * And the waiters' ("דוח מלצרים"): per waiter — tables, guests, takings, average check and
 * per guest, seating time, tips, cancellations — and every table of one waiter
 * ("שולחנות למלצר").
 */

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { previousWindow } from '@/lib/designedReport';
import { formatCurrency, formatDateTime } from '@/lib/format';
import { daysBackIso, todayIso } from '@/lib/reportWindow';
import { fetchTablesReport, type TablesReport, type TablesReportRow } from '@/lib/tablesApi';
import type { ExcelSheet } from '@/lib/excelExport';
import {
  StandaloneExportBar,
  sheetAsTable,
  type PreviousPeriod,
  type ReportChart,
  type ReportKpi,
  type ReportTableSpec,
} from '@/components/dashboard/report-framework';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

type T = ReturnType<typeof useTranslations>;

/**
 * Every table of the report as its own sheet, its columns keyed for the export's choice.
 * "שולחנות למלצר" follows the waiter picked above it (all waiters when none is).
 */
function reportSheets(d: TablesReport, t: T, tc: T, waiter: string) {
  const mins = (m: number | null | undefined) => (m == null ? null : Math.round(m));
  // A labelled table by its label ("3B", P:/specs/table-scope.md §6.4), never its internal number.
  const tableLabel = (n: number | string | null | undefined, name: string | null | undefined) =>
    [n, name].filter((v) => v != null && v !== '').join(' ');
  const figureColumns: ExcelSheet['columns'] = [
    { key: 'orders', header: t('orders'), kind: 'number' },
    { key: 'revenue', header: t('revenue'), kind: 'money' },
    { key: 'guests', header: t('guests'), kind: 'number' },
    { key: 'avgMinutes', header: t('export.avgMinutes'), kind: 'number' },
  ];
  const figures = (r: TablesReportRow) => [r.orders, r.revenue, r.guests, mins(r.avgMinutes)];
  const byWaiter: ExcelSheet | null = d.byWaiter
    ? {
        name: t('byWaiter'),
        columns: [
          { key: 'waiter', header: t('waiter') },
          { key: 'tables', header: t('waiterTables'), kind: 'number' },
          { key: 'guests', header: t('guests'), kind: 'number' },
          { key: 'revenue', header: t('revenue'), kind: 'money' },
          { key: 'avgCheck', header: t('avgCheck'), kind: 'money' },
          { key: 'avgPerGuest', header: t('avgPerGuest'), kind: 'money' },
          { key: 'avgMinutes', header: t('export.avgMinutes'), kind: 'number' },
          { key: 'tips', header: t('tips'), kind: 'money' },
          { key: 'cancelled', header: t('cancelledOrders'), kind: 'number' },
          { key: 'cancelledTotal', header: t('export.cancelledTotal'), kind: 'money' },
        ],
        rows: d.byWaiter.map((r) => [
          r.waiter, r.tables, r.guests, r.revenue, r.avgCheck, r.avgPerGuest, mins(r.avgMinutes), r.tips,
          r.cancelled, r.cancelledTotal,
        ]),
      }
    : null;
  const waiterTables: ExcelSheet | null = d.waiterTables
    ? {
        name: t('tablesOfWaiter'),
        columns: [
          { key: 'waiter', header: t('waiter') },
          { key: 'table', header: t('table') },
          { key: 'zone', header: t('zone') },
          { key: 'opened', header: t('opened'), kind: 'datetime' },
          { key: 'closed', header: t('closed'), kind: 'datetime' },
          { key: 'minutes', header: t('export.minutes'), kind: 'number' },
          { key: 'guests', header: t('guests'), kind: 'number' },
          { key: 'total', header: tc('total'), kind: 'money' },
          { key: 'tip', header: t('tips'), kind: 'money' },
          { key: 'receipt', header: t('receipt') },
          { key: 'status', header: tc('status'), width: 10 },
        ],
        rows: d.waiterTables
          .filter((r) => !waiter || r.waiter === waiter)
          .map((r) => [
            r.waiter, tableLabel(r.tableLabel || r.tableNumber, r.tableName), r.zoneName, r.openedAt, r.closedAt, mins(r.minutes),
            r.guests, r.total, r.tip, r.transactionNumber, r.status === 'cancelled' ? t('cancelledShort') : null,
          ]),
      }
    : null;
  return {
    byWaiter,
    waiterTables,
    byZone: {
      name: t('byZone'),
      columns: [{ key: 'zone', header: t('zone') }, ...figureColumns],
      rows: d.byZone.map((r) => [r.zoneName, ...figures(r)]),
    } satisfies ExcelSheet,
    byTable: {
      name: t('byTable'),
      columns: [{ key: 'table', header: t('table') }, { key: 'zone', header: t('zone') }, ...figureColumns],
      rows: d.byTable.map((r) => [tableLabel(r.label || r.number, r.name), r.zoneName, ...figures(r)]),
    } satisfies ExcelSheet,
    byReason: {
      name: t('cancelByReason'),
      columns: [
        { key: 'reason', header: t('reason') },
        { key: 'cancelled', header: t('cancelledOrders'), kind: 'number' },
        { key: 'total', header: tc('total'), kind: 'money' },
      ],
      rows: d.cancellations.byReason.map((r) => [r.reason, r.count, r.total]),
    } satisfies ExcelSheet,
    byEmployee: {
      name: t('cancelByEmployee'),
      columns: [
        { key: 'employee', header: t('cancelledBy') },
        { key: 'cancelled', header: t('cancelledOrders'), kind: 'number' },
        { key: 'total', header: tc('total'), kind: 'money' },
      ],
      rows: d.cancellations.byEmployee.map((r) => [r.employee, r.count, r.total]),
    } satisfies ExcelSheet,
    cancellations: {
      name: t('cancelRows'),
      columns: [
        { key: 'when', header: t('when'), kind: 'datetime' },
        { key: 'table', header: t('table') },
        { key: 'zone', header: t('zone') },
        { key: 'reason', header: t('reason') },
        { key: 'reasonText', header: t('reasonText') },
        { key: 'cancelledBy', header: t('cancelledBy') },
        { key: 'approvedBy', header: t('approvedBy') },
        { key: 'items', header: t('items'), width: 40 },
        { key: 'total', header: tc('total'), kind: 'money' },
      ],
      rows: d.cancellations.rows.map((r) => [
        r.closedAt, tableLabel(r.tableLabel || r.tableNumber, r.tableName), r.zoneName, r.reason, r.reasonText, r.cancelledBy,
        r.approvedBy, r.items.map((it) => `${it.quantity} × ${it.name}`).join(', '), r.total,
      ]),
    } satisfies ExcelSheet,
  };
}

/** The stat tiles (and the old summary sheet's figures), by KPI key. */
function summaryKpis(s: TablesReport['summary']) {
  return {
    paidOrders: s.paidOrders,
    revenue: s.revenue,
    guests: s.guests,
    avgSeatingMinutes: s.avgSeatingMinutes,
    cancelledOrders: s.cancelledOrders,
    cancelledTotal: s.cancelledTotal,
    payConflicts: s.payConflicts,
  };
}

export function TablesReportView({ shopId }: { shopId: string }) {
  const t = useTranslations('tables');
  const tc = useTranslations('common');
  const [from, setFrom] = useState(daysBackIso(6));
  const [to, setTo] = useState(todayIso());
  const [applied, setApplied] = useState<{ from: string; to: string }>({ from: daysBackIso(6), to: todayIso() });
  /** "שולחנות למלצר": the waiter whose tables are listed; empty — every waiter. */
  const [waiter, setWaiter] = useState('');
  const invalid = !from || !to || from > to;
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['tables-report', shopId, applied.from, applied.to],
    queryFn: () => fetchTablesReport(shopId, applied.from, applied.to),
  });

  const minutes = (m: number | null | undefined) => (m == null ? '—' : t('minutesValue', { minutes: Math.round(m) }));
  const rows = (list: TablesReportRow[], first: (r: TablesReportRow) => string) =>
    list.map((r, i) => (
      <TableRow key={i}>
        <TableCell className="font-medium">{first(r)}</TableCell>
        <TableCell>{r.orders}</TableCell>
        <TableCell>{formatCurrency(r.revenue)}</TableCell>
        <TableCell>{r.guests}</TableCell>
        <TableCell>{minutes(r.avgMinutes)}</TableCell>
      </TableRow>
    ));

  /**
   * The export: the per-table figures are the designed PDF's table, every other table its own
   * sheet (in the screen's order); the stat tiles are the KPIs ("סיכום ותובנות" in Excel).
   */
  const exportTables = useMemo(() => {
    if (!data) return [];
    const s = reportSheets(data, t, tc, waiter);
    return [
      s.byWaiter ? sheetAsTable(s.byWaiter, 'waiters') : null,
      s.waiterTables ? sheetAsTable(s.waiterTables, 'waiterTables') : null,
      sheetAsTable(s.byZone, 'zones'),
      sheetAsTable(s.byTable, 'main'),
      sheetAsTable(s.byReason, 'reasons'),
      sheetAsTable(s.byEmployee, 'employees'),
      sheetAsTable(s.cancellations, 'cancellations'),
    ].filter((x) => x !== null) as ReportTableSpec<unknown>[];
  }, [data, t, tc, waiter]);
  const exportKpis: ReportKpi[] = data
    ? [
        { key: 'paidOrders', label: t('paidOrders'), value: data.summary.paidOrders, kind: 'count', icon: 'table' },
        { key: 'revenue', label: t('revenue'), value: data.summary.revenue, kind: 'money', icon: 'sales' },
        { key: 'guests', label: t('guests'), value: data.summary.guests, kind: 'count', icon: 'users' },
        { key: 'avgSeatingMinutes', label: t('avgSeating'), value: data.summary.avgSeatingMinutes, kind: 'minutes', icon: 'clock' },
        { key: 'cancelledOrders', label: t('cancelledOrders'), value: data.summary.cancelledOrders, kind: 'count', icon: 'void' },
        { key: 'cancelledTotal', label: t('export.cancelledTotal'), value: data.summary.cancelledTotal, kind: 'money', icon: 'void' },
        ...(data.summary.payConflicts > 0
          ? [{ key: 'payConflicts', label: t('export.payConflicts'), value: data.summary.payConflicts, kind: 'count' as const, icon: 'alert' as const, better: 'down' as const }]
          : []),
      ]
    : [];
  // Revenue by zone when there are zones to compare; else the tables' (the PDF's table).
  const zoneChart: ReportChart | null =
    data && data.byZone.length > 1
      ? {
          type: 'hbar',
          title: t('byZone'),
          labels: data.byZone.map((r) => r.zoneName ?? '—'),
          series: [{ name: t('revenue'), values: data.byZone.map((r) => r.revenue) }],
          kind: 'money',
        }
      : null;
  /** The same report for the period before (one day: the same weekday a week before). */
  const previous = async (): Promise<PreviousPeriod | null> => {
    const before = data ? previousWindow(data.from, data.to) : null;
    if (!before) return null;
    const prev = await fetchTablesReport(shopId, before.from, before.to);
    return {
      rows: sheetAsTable(reportSheets(prev, t, tc, waiter).byTable, 'main').rows,
      kpis: summaryKpis(prev.summary),
      ...before,
    };
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3 rounded-lg border bg-card p-3 print:hidden">
        <div className="space-y-1">
          <Label className="text-xs">{t('from')}</Label>
          <DatePicker value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} range={{ from, to, onSelect: (r) => { setFrom(r.from); setTo(r.to); } }} />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">{t('to')}</Label>
          <DatePicker value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} range={{ from, to, onSelect: (r) => { setFrom(r.from); setTo(r.to); } }} />
        </div>
        <Button disabled={invalid} onClick={() => setApplied({ from, to })}>
          {t('show')}
        </Button>
      </div>
      <StandaloneExportBar
        reportKey="tables-report"
        reportType="tables"
        title={t('sectionReport')}
        tables={exportTables}
        pdfTableId="main"
        from={data?.from ?? applied.from}
        to={data?.to ?? applied.to}
        disabled={!data}
        kpis={exportKpis}
        chart={zoneChart}
        chartFrom={{ label: 'table', value: 'revenue' }}
        previous={previous}
      />

      {isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : isError ? (
        <div className="rounded-lg border bg-card p-6 text-destructive">{axiosErrorToToastMessage(error, tc('error'))}</div>
      ) : data ? (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label={t('paidOrders')} value={String(data.summary.paidOrders)} />
            <Stat label={t('revenue')} value={formatCurrency(data.summary.revenue)} />
            <Stat label={t('avgSeating')} value={minutes(data.summary.avgSeatingMinutes)} />
            <Stat
              label={t('cancelledOrders')}
              value={`${data.summary.cancelledOrders} · ${formatCurrency(data.summary.cancelledTotal)}`}
            />
          </div>
          {data.summary.payConflicts > 0 ? (
            <p className="text-sm text-orange-700">{t('payConflicts', { count: data.summary.payConflicts })}</p>
          ) : null}

          {data.byWaiter ? (
            <Section title={t('byWaiter')}>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('waiter')}</TableHead>
                      <TableHead>{t('waiterTables')}</TableHead>
                      <TableHead>{t('guests')}</TableHead>
                      <TableHead>{t('revenue')}</TableHead>
                      <TableHead>{t('avgCheck')}</TableHead>
                      <TableHead>{t('avgPerGuest')}</TableHead>
                      <TableHead>{t('avgSeating')}</TableHead>
                      <TableHead>{t('tips')}</TableHead>
                      <TableHead>{t('cancelledOrders')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.byWaiter.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={9} className="text-center text-muted-foreground">
                          {t('noWaiters')}
                        </TableCell>
                      </TableRow>
                    ) : (
                      data.byWaiter.map((r, i) => (
                        <TableRow
                          key={i}
                          className="cursor-pointer hover:bg-muted/40"
                          onClick={() => setWaiter(r.waiter)}
                        >
                          <TableCell className="font-medium">{r.waiter}</TableCell>
                          <TableCell>{r.tables}</TableCell>
                          <TableCell>{r.guests}</TableCell>
                          <TableCell>{formatCurrency(r.revenue)}</TableCell>
                          <TableCell>{r.avgCheck == null ? '—' : formatCurrency(r.avgCheck)}</TableCell>
                          <TableCell>{r.avgPerGuest == null ? '—' : formatCurrency(r.avgPerGuest)}</TableCell>
                          <TableCell>{minutes(r.avgMinutes)}</TableCell>
                          <TableCell>{formatCurrency(r.tips)}</TableCell>
                          <TableCell>
                            {r.cancelled > 0 ? `${r.cancelled} · ${formatCurrency(r.cancelledTotal)}` : '—'}
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </Section>
          ) : null}

          {data.waiterTables ? (
            <Section title={t('tablesOfWaiter')}>
              <div className="flex flex-wrap items-center gap-2 border-b p-2">
                <Label htmlFor="waiter-filter" className="text-xs">
                  {t('waiter')}
                </Label>
                <select
                  id="waiter-filter"
                  className="border-input bg-background h-9 rounded-md border px-3 text-sm"
                  value={waiter}
                  onChange={(e) => setWaiter(e.target.value)}
                >
                  <option value="">{t('allWaiters')}</option>
                  {(data.byWaiter ?? []).map((r) => (
                    <option key={r.waiter} value={r.waiter}>
                      {r.waiter}
                    </option>
                  ))}
                </select>
              </div>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('waiter')}</TableHead>
                      <TableHead>{t('table')}</TableHead>
                      <TableHead>{t('opened')}</TableHead>
                      <TableHead>{t('closed')}</TableHead>
                      <TableHead>{t('avgSeating')}</TableHead>
                      <TableHead>{t('guests')}</TableHead>
                      <TableHead>{tc('total')}</TableHead>
                      <TableHead>{t('tips')}</TableHead>
                      <TableHead>{t('receipt')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.waiterTables
                      .filter((r) => !waiter || r.waiter === waiter)
                      .map((r) => (
                        <TableRow key={r.orderId} className={r.status === 'cancelled' ? 'text-muted-foreground' : ''}>
                          <TableCell>{r.waiter}</TableCell>
                          <TableCell>
                            {[r.tableLabel || r.tableNumber, r.tableName].filter(Boolean).join(' ')}
                            {r.zoneName ? <span className="text-xs text-muted-foreground"> ({r.zoneName})</span> : null}
                          </TableCell>
                          <TableCell>{r.openedAt ? formatDateTime(r.openedAt) : '—'}</TableCell>
                          <TableCell>{r.closedAt ? formatDateTime(r.closedAt) : '—'}</TableCell>
                          <TableCell>{minutes(r.minutes)}</TableCell>
                          <TableCell>{r.guests ?? '—'}</TableCell>
                          <TableCell>
                            {formatCurrency(r.total)}
                            {r.status === 'cancelled' ? <span className="ms-1 text-xs">({t('cancelledShort')})</span> : null}
                          </TableCell>
                          <TableCell>{r.tip ? formatCurrency(r.tip) : '—'}</TableCell>
                          <TableCell>{r.transactionNumber ?? '—'}</TableCell>
                        </TableRow>
                      ))}
                  </TableBody>
                </Table>
              </div>
            </Section>
          ) : null}

          <Section title={t('byZone')}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('zone')}</TableHead>
                  <TableHead>{t('orders')}</TableHead>
                  <TableHead>{t('revenue')}</TableHead>
                  <TableHead>{t('guests')}</TableHead>
                  <TableHead>{t('avgSeating')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>{rows(data.byZone, (r) => r.zoneName ?? '—')}</TableBody>
            </Table>
          </Section>

          <Section title={t('byTable')}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('table')}</TableHead>
                  <TableHead>{t('orders')}</TableHead>
                  <TableHead>{t('revenue')}</TableHead>
                  <TableHead>{t('guests')}</TableHead>
                  <TableHead>{t('avgSeating')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows(data.byTable, (r) => [r.label || r.number, r.name, r.zoneName ? `(${r.zoneName})` : null].filter(Boolean).join(' '))}
              </TableBody>
            </Table>
          </Section>

          <div className="grid gap-4 md:grid-cols-2">
            <Section title={t('cancelByReason')}>
              <Table>
                <TableBody>
                  {data.cancellations.byReason.map((r, i) => (
                    <TableRow key={i}>
                      <TableCell>{r.reason}</TableCell>
                      <TableCell>{r.count}</TableCell>
                      <TableCell>{formatCurrency(r.total)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Section>
            <Section title={t('cancelByEmployee')}>
              <Table>
                <TableBody>
                  {data.cancellations.byEmployee.map((r, i) => (
                    <TableRow key={i}>
                      <TableCell>{r.employee}</TableCell>
                      <TableCell>{r.count}</TableCell>
                      <TableCell>{formatCurrency(r.total)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Section>
          </div>

          <Section title={t('cancelRows')}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('when')}</TableHead>
                  <TableHead>{t('table')}</TableHead>
                  <TableHead>{t('reason')}</TableHead>
                  <TableHead>{t('cancelledBy')}</TableHead>
                  <TableHead>{t('approvedBy')}</TableHead>
                  <TableHead>{t('items')}</TableHead>
                  <TableHead>{tc('total')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.cancellations.rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center text-muted-foreground">
                      {t('noCancellations')}
                    </TableCell>
                  </TableRow>
                ) : (
                  data.cancellations.rows.map((r) => (
                    <TableRow key={r.orderId}>
                      <TableCell>{formatDateTime(r.closedAt)}</TableCell>
                      <TableCell>{[r.tableLabel || r.tableNumber, r.tableName].filter(Boolean).join(' ')}</TableCell>
                      <TableCell>
                        {r.reason}
                        {r.reasonText ? <span className="text-muted-foreground"> — {r.reasonText}</span> : null}
                      </TableCell>
                      <TableCell>{r.cancelledBy ?? '—'}</TableCell>
                      <TableCell>{r.approvedBy ?? '—'}</TableCell>
                      <TableCell className="text-xs">
                        {r.items.map((it) => `${it.quantity} × ${it.name}`).join(', ')}
                      </TableCell>
                      <TableCell>{formatCurrency(r.total)}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </Section>
        </>
      ) : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-xl font-bold">{value}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <h3 className="font-semibold">{title}</h3>
      <div className="overflow-hidden rounded-lg border bg-card">{children}</div>
    </div>
  );
}
