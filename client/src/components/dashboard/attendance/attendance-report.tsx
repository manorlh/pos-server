'use client';

/**
 * "דוח נוכחות": one row per shift that started in the range (the organization's local days)
 * — date, employee, job title, in, out, breaks, hours, notes — then the totals per
 * employee. A click on the employee opens the shift: its times, breaks and audit trail.
 *
 * On the report framework (P:\specs\reports-upgrade.md §5): the company and the shop are the
 * dashboard's scope (the bar on top, and the shop beside the filters); the days, the job
 * title and the employee live in the URL (`?tab=report&from=&to=&role=&employee=`), so a
 * link is the report. It runs at once on the last 7 days, as it always did. Both tables
 * sort, choose their columns and turn into cards on a phone; Excel (the same two sheets,
 * same columns and totals), the designed PDF of the shifts (the counts against the days before,
 * hours per employee, subtotals by shop), print, and the CSV — the report's own, in the menu.
 *
 * Its own frame rather than `ReportPage`: it is a tab of "נוכחות עובדים", whose heading and
 * tabs sit right above it — a second page heading would only repeat the tab's name.
 *
 * Planned vs actual, overtime and payroll columns are phase 2/3 (docs/SPEC_ATTENDANCE.md):
 * they will read these rows, not change them.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { fetchEmployees, fetchReport, fetchRoles } from '@/lib/attendanceApi';
import {
  attendanceFilterLines,
  decimalHours,
  formatHours,
  noteKeys,
  noteText,
  REPORT_HEADER_KEYS,
  reportExportRows,
  type AttendanceShift,
  type AttendanceStatus,
  type EmployeeTotals,
} from '@/lib/attendance';
import { useAuth } from '@/lib/auth';
import { downloadCsv, toCsv } from '@/lib/csv';
import { formatDate, formatTime, toDate } from '@/lib/format';
import {
  defaultReportFilters,
  reportApiParams,
  scopeApiParams,
  type ReportFilterSpec,
} from '@/lib/reportFilters';
import { todayIso } from '@/lib/reportWindow';
import { usePageScope } from '@/lib/scope';
import { previousWindow } from '@/lib/designedReport';
import {
  ReportExportBar,
  ReportFilterBar,
  ReportTable,
  useReportExportScope,
  useReportFilters,
  type PreviousPeriod,
  type ReportChart,
  type ReportKpi,
  type ReportTableSpec,
} from '@/components/dashboard/report-framework';
import { ReportErrorState } from '@/components/dashboard/report-window-summary';
import { ScopeGate } from '@/components/dashboard/scope-gate';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { PickSelect } from './attendance-filters';
import { ShiftDetailDialog } from './shift-detail-dialog';

const REPORT_KEY = 'attendance';

/** The days (the last 7 by default) and the report's own job title and employee. */
const SPEC: ReportFilterSpec = { filters: [], defaultDaysBack: 6, extras: { role: '', employee: '' } };
const NO_EXTRAS: Record<string, string> = { role: '', employee: '' };

function timeOf(iso: string | null | undefined): string {
  if (!iso) return '';
  return toDate(iso) ? formatTime(iso) : '';
}

export function AttendanceReport() {
  const t = useTranslations('attendance');
  const tf = useTranslations('reportFramework.filters');
  const { user } = useAuth();
  const canManage = user?.canManagePosUsers === true;
  const { scope, resolution, effective, ready } = usePageScope({ maxLevel: 'shop' });
  const shopId = effective.shopId;
  const filters = useReportFilters(SPEC);
  const [opened, setOpened] = useState<string | null>(null);

  const roles = useQuery({ queryKey: ['attendance-roles', false], queryFn: () => fetchRoles(false) });
  const employees = useQuery({
    queryKey: ['attendance-employees', shopId],
    queryFn: () => fetchEmployees(shopId!),
    enabled: !!shopId,
  });

  // An employee belongs to one shop: another shop in scope drops the choice — the applied
  // one too, or the report would quietly run on a pair that matches nothing.
  const lastShop = useRef(shopId);
  const latest = useRef(filters);
  useEffect(() => {
    latest.current = filters;
  });
  useEffect(() => {
    if (lastShop.current === shopId) return;
    lastShop.current = shopId;
    const f = latest.current;
    if (f.applied?.extras.employee) f.apply({ extras: { employee: '' } });
    else if (f.draftExtras.employee) f.setExtra('employee', '');
  }, [shopId]);

  // It always ran at once: before "הפק דוח", the default days.
  const extras = filters.applied?.extras ?? NO_EXTRAS;
  const params = useMemo(() => {
    const range = filters.apiParams ?? reportApiParams(defaultReportFilters(SPEC, todayIso()), SPEC);
    // The shop, else the company (and its subsidiaries) — never both.
    const where = scopeApiParams(effective);
    return {
      from: String(range.from),
      to: String(range.to),
      companyId: where.companyId ?? null,
      shopId: where.shopId ?? null,
      roleId: extras.role || null,
      // The employee is picked from the shop's list: without a shop it is not a filter.
      posUserId: shopId ? extras.employee || null : null,
    };
  }, [effective, extras.employee, extras.role, filters.apiParams, shopId]);

  const query = useQuery({
    queryKey: ['attendance', 'report', params],
    queryFn: () => fetchReport(params),
    enabled: ready,
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

  const shifts = useMemo<ReportTableSpec<AttendanceShift>>(() => {
    const totals = data?.totals;
    return {
      id: 'main',
      title: t('report.sheetShifts'),
      rows: data?.rows ?? [],
      rowKey: (r) => r.id,
      // A row opens the shift: its times, breaks and audit trail (as it always did).
      onRowClick: (r) => setOpened(r.id),
      totalsLabel: t('report.total'),
      emptyText: t('report.empty'),
      // The order of the spreadsheet as it always was (REPORT_HEADER_KEYS).
      columns: [
        {
          key: 'date',
          header: t('col.date'),
          kind: 'date',
          value: (r) => r.date ?? null,
          cell: (r) => formatDate(r.date ?? r.clockInAt),
          className: 'tabular-nums',
        },
        {
          key: 'employee',
          header: t('col.employee'),
          required: true,
          value: (r) => r.posUserName ?? '',
          cell: (r) => (
            <button
              type="button"
              className="text-start font-medium hover:text-primary hover:underline"
              title={t('report.openShift')}
              onClick={() => setOpened(r.id)}
            >
              {r.posUserName}
              {r.shopName ? <span className="text-muted-foreground block text-xs font-normal">{r.shopName}</span> : null}
            </button>
          ),
        },
        { key: 'workerNumber', header: t('col.workerNumber'), exportOnly: true, value: (r) => r.workerNumber ?? '' },
        { key: 'role', header: t('col.role'), value: (r) => r.roleName ?? '' },
        // On screen the shop sits under the employee's name.
        { key: 'shop', header: t('col.shop'), exportOnly: true, value: (r) => r.shopName ?? '' },
        { key: 'in', header: t('col.in'), value: (r) => timeOf(r.clockInAt), className: 'tabular-nums' },
        { key: 'out', header: t('col.out'), value: (r) => (r.clockOutAt ? timeOf(r.clockOutAt) : ''), className: 'tabular-nums' },
        {
          key: 'breaks',
          header: t('col.breaks'),
          kind: 'number',
          value: (r) => r.breakCount ?? r.breaks.length,
          cell: (r) => (
            <>
              {r.breakCount ?? r.breaks.length}
              {r.breakSeconds ? <span className="text-muted-foreground text-xs"> · {formatHours(r.breakSeconds)}</span> : null}
            </>
          ),
          totalCell: totals ? formatHours(totals.breakSeconds) : undefined,
        },
        {
          key: 'breakTime',
          header: t('col.breakTime'),
          exportOnly: true,
          value: (r) => formatHours(r.breakSeconds),
          total: totals ? formatHours(totals.breakSeconds) : undefined,
        },
        {
          key: 'hours',
          header: t('col.hours'),
          kind: 'number',
          value: (r) => decimalHours(r.workedSeconds),
          cell: (r) => <span className="font-medium">{formatHours(r.workedSeconds)}</span>,
          total: totals ? decimalHours(totals.workedSeconds) : undefined,
          totalCell: totals ? formatHours(totals.workedSeconds) : undefined,
        },
        { key: 'status', header: t('col.status'), exportOnly: true, value: (r) => labels.status(r.status) },
        {
          key: 'notes',
          header: t('col.notes'),
          value: (r) => noteText(r, labels),
          cell: (r) => (
            <div className="flex flex-wrap gap-1">
              {noteKeys(r).map((k) => (
                <Badge key={k} variant="outline" className="text-xs">
                  {t(`notes.${k}`)}
                </Badge>
              ))}
            </div>
          ),
        },
      ],
    };
  }, [data, labels, t]);

  const byEmployee = useMemo<ReportTableSpec<EmployeeTotals>>(() => {
    const totals = data?.totals;
    return {
      id: 'employees',
      title: t('report.sheetEmployees'),
      rows: data?.byEmployee ?? [],
      rowKey: (e) => e.posUserId,
      totalsLabel: t('report.total'),
      columns: [
        { key: 'employee', header: t('col.employee'), required: true, value: (e) => e.posUserName ?? '', className: 'font-medium' },
        { key: 'workerNumber', header: t('col.workerNumber'), exportOnly: true, value: (e) => e.workerNumber ?? '' },
        { key: 'role', header: t('col.role'), value: (e) => e.roleName ?? '' },
        {
          key: 'shifts',
          header: t('report.shiftsCol'),
          kind: 'number',
          value: (e) => e.shifts,
          cell: (e) => (
            <>
              {e.shifts}
              {e.openShifts ? <span className="text-muted-foreground text-xs"> ({t('report.open', { n: e.openShifts })})</span> : null}
            </>
          ),
          total: totals?.shifts,
        },
        {
          key: 'breakTime',
          header: t('col.breakTime'),
          value: (e) => formatHours(e.breakSeconds),
          firstSort: 'desc',
          className: 'text-end tabular-nums',
          headClassName: 'text-end',
          total: totals ? formatHours(totals.breakSeconds) : undefined,
        },
        {
          key: 'hours',
          header: t('col.hours'),
          kind: 'number',
          value: (e) => decimalHours(e.workedSeconds),
          cell: (e) => <span className="font-medium">{formatHours(e.workedSeconds)}</span>,
          total: totals ? decimalHours(totals.workedSeconds) : undefined,
          totalCell: totals ? formatHours(totals.workedSeconds) : undefined,
        },
      ],
    };
  }, [data, t]);

  const roleOptions = (roles.data?.roles ?? []).map((r) => ({ value: r.id, label: r.name }));
  const employeeOptions = (employees.data?.employees ?? []).map((e) => ({ value: e.id, label: e.name || e.username }));
  const filterLines = attendanceFilterLines(
    { roleId: extras.role, posUserId: params.posUserId ?? '' },
    {
      role: (id) => roleOptions.find((o) => o.value === id)?.label,
      employee: (id) => employeeOptions.find((o) => o.value === id)?.label,
    },
    { role: t('filters.role'), employee: t('filters.employee'), unknown: tf('unknownChoice') },
  );
  const exportScope = useReportExportScope(scope.shop?.name ?? null);

  const exportCsv = () => {
    if (!data) return;
    const header = REPORT_HEADER_KEYS.map((k) => t(`col.${k}`));
    const rows = reportExportRows(data.rows, labels).map(([day, ...rest]) => [day ? formatDate(day) : '', ...rest]);
    downloadCsv(`attendance-${data.window.from}-${data.window.to}.csv`, toCsv(header, rows));
  };

  // The designed PDF (P:\specs\reports-designed-pdf.md §7): the counts the page shows (hours as a
  // duration), the hours per employee, subtotals by shop, and the same days before — one more
  // run of the report's own request, on the click; its totals are what the cards compare.
  const exportKpis: ReportKpi[] = data
    ? [
        { key: 'shifts', label: t('report.shiftsCol'), value: data.totals.shifts, kind: 'count', icon: 'calendar' },
        { key: 'workedTime', label: t('col.hours'), value: data.totals.workedSeconds, kind: 'duration', icon: 'clock' },
        { key: 'employees', label: t('report.employees'), value: data.byEmployee.length, kind: 'count', icon: 'users' },
        { key: 'breakTime', label: t('col.breakTime'), value: data.totals.breakSeconds, kind: 'duration', icon: 'clock' },
      ]
    : [];
  const topEmployees = [...(data?.byEmployee ?? [])].sort((a, b) => b.workedSeconds - a.workedSeconds).slice(0, 12);
  const exportChart: ReportChart | null = topEmployees.length
    ? {
        type: 'hbar',
        title: t('report.hoursByEmployee'),
        labels: topEmployees.map((e) => e.posUserName ?? ''),
        series: [{ name: t('col.hours'), values: topEmployees.map((e) => decimalHours(e.workedSeconds)) }],
        kind: 'number',
      }
    : null;
  const previous = async (): Promise<PreviousPeriod | null> => {
    const before = previousWindow(data?.window.from, data?.window.to);
    if (!before) return null;
    const prev = await fetchReport({ ...params, ...before });
    return {
      kpis: {
        shifts: prev.totals.shifts,
        workedTime: prev.totals.workedSeconds,
        employees: prev.byEmployee.length,
        breakTime: prev.totals.breakSeconds,
      },
      ...before,
    };
  };

  return (
    <div className="min-w-0 space-y-4">
      <ScopeGate resolution={resolution}>
        <ReportFilterBar filters={filters} isFetching={query.isFetching} shopId={shopId} scopeFields={{ shop: true }}>
          <PickSelect
            label={t('filters.role')}
            value={filters.draftExtras.role ?? ''}
            onChange={(roleId) => filters.setExtra('role', roleId)}
            options={roleOptions}
            anyLabel={t('filters.allRoles')}
          />
          <PickSelect
            label={t('filters.employee')}
            value={shopId ? (filters.draftExtras.employee ?? '') : ''}
            onChange={(posUserId) => filters.setExtra('employee', posUserId)}
            options={employeeOptions}
            anyLabel={shopId ? t('filters.allEmployees') : t('filters.chooseShopFirst')}
            disabled={!shopId}
          />
        </ReportFilterBar>

        {query.isError ? (
          <ReportErrorState message={axiosErrorToToastMessage(query.error, t('errors.load'))} />
        ) : !data ? (
          <Skeleton className="h-64" />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary" className="text-sm">{t('report.shifts', { n: data.totals.shifts })}</Badge>
              <Badge variant="secondary" className="text-sm">{t('report.hours', { h: formatHours(data.totals.workedSeconds) })}</Badge>
            </div>
            <ReportExportBar
              reportKey={REPORT_KEY}
              title={t('report.title')}
              tables={[shifts, byEmployee] as ReportTableSpec<unknown>[]}
              from={data.window.from}
              to={data.window.to}
              business={exportScope.business}
              place={exportScope.place}
              filterLines={filterLines}
              companyId={exportScope.companyId}
              companyName={exportScope.companyName}
              disabled={data.rows.length === 0}
              reportType="attendance"
              kpis={exportKpis}
              chart={exportChart}
              groupBy={['shop']}
              insightKeys={{ label: 'employee', value: 'hours', employee: 'employee' }}
              previous={previous}
              csv={exportCsv}
            />
            <ReportTable table={shifts} reportKey={REPORT_KEY} />
            {data.byEmployee.length > 0 ? <ReportTable table={byEmployee} reportKey={REPORT_KEY} /> : null}
          </>
        )}
      </ScopeGate>

      <ShiftDetailDialog shiftId={opened} canManage={canManage} onClose={() => setOpened(null)} />
    </div>
  );
}
