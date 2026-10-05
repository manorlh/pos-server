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

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { formatCurrency, formatDateTime } from '@/lib/format';
import { daysBackIso, todayIso } from '@/lib/reportWindow';
import { fetchTablesReport, type TablesReportRow } from '@/lib/tablesApi';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

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

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3 rounded-lg border bg-card p-3">
        <div className="space-y-1">
          <Label className="text-xs">{t('from')}</Label>
          <Input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">{t('to')}</Label>
          <Input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
        </div>
        <Button disabled={invalid} onClick={() => setApplied({ from, to })}>
          {t('show')}
        </Button>
      </div>

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
                            {[r.tableNumber, r.tableName].filter(Boolean).join(' ')}
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
                {rows(data.byTable, (r) => [r.number, r.name, r.zoneName ? `(${r.zoneName})` : null].filter(Boolean).join(' '))}
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
                      <TableCell>{[r.tableNumber, r.tableName].filter(Boolean).join(' ')}</TableCell>
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
