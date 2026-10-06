'use client';

/**
 * "דוח נוכחות": one row per shift that started in the range (the organization's local days)
 * — date, employee, job title, in, out, breaks, hours, notes — then the totals per
 * employee. Filters: company, shop, employee, job title, dates. Exported to Excel / print
 * (the reports' toolbar) and CSV. A row opens the shift: its times, breaks and audit trail.
 *
 * Planned vs actual, overtime and payroll columns are phase 2/3 (docs/SPEC_ATTENDANCE.md):
 * they will read these rows, not change them.
 */

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { Download } from 'lucide-react';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { fetchReport } from '@/lib/attendanceApi';
import {
  decimalHours,
  formatHours,
  noteKeys,
  REPORT_HEADER_KEYS,
  reportExportRows,
  type AttendanceStatus,
} from '@/lib/attendance';
import { useAuth } from '@/lib/auth';
import { downloadCsv, toCsv } from '@/lib/csv';
import type { ExcelCellKind } from '@/lib/excelExport';
import { formatDate } from '@/lib/format';
import { daysBackIso, todayIso } from '@/lib/reportWindow';
import { RangeFilter, type DayRange } from '@/components/dashboard/range-filter';
import { ReportExportToolbar } from '@/components/dashboard/report-export-toolbar';
import { ReportErrorState } from '@/components/dashboard/report-window-summary';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { AttendanceFilters, EMPTY_ATTENDANCE_SCOPE, scopeParams, type AttendanceScope } from './attendance-filters';
import { ShiftDetailDialog } from './shift-detail-dialog';

function timeOf(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
}

export function AttendanceReport() {
  const t = useTranslations('attendance');
  const { user } = useAuth();
  const canManage = user?.canManagePosUsers === true;
  const [scope, setScope] = useState<AttendanceScope>(EMPTY_ATTENDANCE_SCOPE);
  const [range, setRange] = useState<DayRange>({ from: daysBackIso(6), to: todayIso() });
  const [run, setRun] = useState<{ range: DayRange; scope: AttendanceScope }>({ range, scope });
  const [opened, setOpened] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ['attendance', 'report', run],
    queryFn: () =>
      fetchReport({
        ...scopeParams(run.scope),
        posUserId: run.scope.posUserId || null,
        from: run.range.from,
        to: run.range.to,
      }),
  });
  const data = query.data;

  const labels = useMemo(
    () => ({
      note: (k: string) => t(`notes.${k}`),
      status: (s: AttendanceStatus) => t(`status.${s}`),
      time: timeOf,
    }),
    [t],
  );
  const header = REPORT_HEADER_KEYS.map((k) => t(`col.${k}`));

  const exportCsv = () => {
    if (!data) return;
    downloadCsv(`attendance-${data.window.from}-${data.window.to}.csv`, toCsv(header, reportExportRows(data.rows, labels)));
  };

  return (
    <div className="space-y-4">
      <Card className="print:hidden">
        <CardContent className="space-y-3 pt-4">
          <AttendanceFilters value={scope} onChange={setScope} withEmployee />
        </CardContent>
      </Card>
      <RangeFilter value={range} onChange={setRange} onRun={() => setRun({ range, scope })} isFetching={query.isFetching} />

      {query.isError ? (
        <ReportErrorState message={axiosErrorToToastMessage(query.error, t('errors.load'))} />
      ) : !data ? (
        <Skeleton className="h-64" />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary" className="text-sm">{t('report.shifts', { n: data.totals.shifts })}</Badge>
            <Badge variant="secondary" className="text-sm">{t('report.hours', { h: formatHours(data.totals.workedSeconds) })}</Badge>
            <div className="ms-auto flex flex-wrap gap-2 print:hidden">
              <Button variant="outline" size="sm" onClick={exportCsv} disabled={data.rows.length === 0}>
                <Download className="size-4" />
                CSV
              </Button>
            </div>
          </div>
          <ReportExportToolbar
            title={t('report.title')}
            from={data.window.from}
            to={data.window.to}
            disabled={data.rows.length === 0}
            getSheets={() => [
              {
                name: t('report.sheetShifts'),
                columns: REPORT_HEADER_KEYS.map((k) => ({
                  header: t(`col.${k}`),
                  kind: (k === 'hours' || k === 'breaks' ? 'number' : 'text') as ExcelCellKind,
                })),
                rows: reportExportRows(data.rows, labels),
                totals: [t('report.total'), null, null, null, null, null, null, null,
                  formatHours(data.totals.breakSeconds), decimalHours(data.totals.workedSeconds), null, null],
              },
              {
                name: t('report.sheetEmployees'),
                columns: [
                  { header: t('col.employee') },
                  { header: t('col.workerNumber') },
                  { header: t('col.role') },
                  { header: t('report.shiftsCol'), kind: 'number' },
                  { header: t('col.breakTime') },
                  { header: t('col.hours'), kind: 'number' },
                ],
                rows: data.byEmployee.map((e) => [
                  e.posUserName ?? '', e.workerNumber ?? '', e.roleName ?? '', e.shifts,
                  formatHours(e.breakSeconds), decimalHours(e.workedSeconds),
                ]),
              },
            ]}
          />

          {data.rows.length === 0 ? (
            <p className="text-muted-foreground rounded-lg border bg-card p-6 text-center text-sm">{t('report.empty')}</p>
          ) : (
            <div className="rounded-lg border bg-card">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('col.date')}</TableHead>
                    <TableHead>{t('col.employee')}</TableHead>
                    <TableHead>{t('col.role')}</TableHead>
                    <TableHead>{t('col.in')}</TableHead>
                    <TableHead>{t('col.out')}</TableHead>
                    <TableHead className="text-end">{t('col.breaks')}</TableHead>
                    <TableHead className="text-end">{t('col.hours')}</TableHead>
                    <TableHead>{t('col.notes')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.rows.map((r) => (
                    <TableRow key={r.id} className="cursor-pointer" onClick={() => setOpened(r.id)}>
                      <TableCell className="tabular-nums">{formatDate(r.date ?? r.clockInAt)}</TableCell>
                      <TableCell className="font-medium">
                        {r.posUserName}
                        {r.shopName ? <span className="text-muted-foreground block text-xs">{r.shopName}</span> : null}
                      </TableCell>
                      <TableCell>{r.roleName ?? '—'}</TableCell>
                      <TableCell className="tabular-nums">{timeOf(r.clockInAt)}</TableCell>
                      <TableCell className="tabular-nums">{r.clockOutAt ? timeOf(r.clockOutAt) : '—'}</TableCell>
                      <TableCell className="text-end tabular-nums">
                        {r.breakCount ?? r.breaks.length}
                        {r.breakSeconds ? <span className="text-muted-foreground text-xs"> · {formatHours(r.breakSeconds)}</span> : null}
                      </TableCell>
                      <TableCell className="text-end tabular-nums font-medium">{formatHours(r.workedSeconds)}</TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {noteKeys(r).map((k) => (
                            <Badge key={k} variant="outline" className="text-xs">{t(`notes.${k}`)}</Badge>
                          ))}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
                <TableFooter>
                  <TableRow>
                    <TableCell colSpan={5}>{t('report.total')}</TableCell>
                    <TableCell className="text-end tabular-nums">{formatHours(data.totals.breakSeconds)}</TableCell>
                    <TableCell className="text-end tabular-nums">{formatHours(data.totals.workedSeconds)}</TableCell>
                    <TableCell />
                  </TableRow>
                </TableFooter>
              </Table>
            </div>
          )}

          {data.byEmployee.length > 0 ? (
            <div className="rounded-lg border bg-card">
              <p className="px-4 pt-3 font-medium">{t('report.sheetEmployees')}</p>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('col.employee')}</TableHead>
                    <TableHead>{t('col.role')}</TableHead>
                    <TableHead className="text-end">{t('report.shiftsCol')}</TableHead>
                    <TableHead className="text-end">{t('col.breakTime')}</TableHead>
                    <TableHead className="text-end">{t('col.hours')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.byEmployee.map((e) => (
                    <TableRow key={e.posUserId}>
                      <TableCell className="font-medium">{e.posUserName}</TableCell>
                      <TableCell>{e.roleName ?? '—'}</TableCell>
                      <TableCell className="text-end tabular-nums">
                        {e.shifts}
                        {e.openShifts ? <span className="text-muted-foreground text-xs"> ({t('report.open', { n: e.openShifts })})</span> : null}
                      </TableCell>
                      <TableCell className="text-end tabular-nums">{formatHours(e.breakSeconds)}</TableCell>
                      <TableCell className="text-end tabular-nums font-medium">{formatHours(e.workedSeconds)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : null}
        </>
      )}

      <ShiftDetailDialog shiftId={opened} canManage={canManage} onClose={() => setOpened(null)} />
    </div>
  );
}
