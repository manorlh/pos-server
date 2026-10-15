'use client';

/**
 * "ארוחות עובדים ומנהלים": the meals eaten at staff and managers' tables (table types —
 * lib/tablePolicy.ts) over a range of days — per kind the count, the value before the
 * discount, the discount and what was paid; per employee; and every meal (whose, why,
 * who approved). Filterable by employee. From the sale documents the tills push
 * (`meal_kind` …, pos-server app/services/table_policies.py, meals_report).
 */

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { previousWindow } from '@/lib/designedReport';
import type { ExcelSheet } from '@/lib/excelExport';
import { formatCurrency, formatDateTime } from '@/lib/format';
import { daysBackIso, todayIso } from '@/lib/reportWindow';
import { fetchMealsReport } from '@/lib/tablesApi';
import { mealEmployees, percentText, type MealTotals, type MealsReport } from '@/lib/tablePolicy';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  StandaloneExportBar,
  sheetAsTable,
  type PreviousPeriod,
  type ReportKpi,
  type ReportTableSpec,
} from '@/components/dashboard/report-framework';

const ALL = '__all__';

type T = ReturnType<typeof useTranslations>;

/** The report's three tables as sheets — per kind, per employee, every meal — keyed for the export. */
function mealsSheets(data: MealsReport, t: T, tc: T) {
  const kinds = [
    { label: t('meals.staff'), x: data.staff },
    { label: t('meals.managers'), x: data.managers },
  ];
  const byKind: ExcelSheet = {
    name: t('meals.totals'),
    columns: [
      { key: 'kind', header: t('meals.kind'), width: 16 },
      { key: 'count', header: t('meals.count'), kind: 'number' },
      { key: 'before', header: t('meals.before'), kind: 'money' },
      { key: 'discount', header: t('meals.discount'), kind: 'money' },
      { key: 'paid', header: t('meals.paid'), kind: 'money' },
    ],
    rows: kinds.map(({ label, x }) => [label, x.count, x.before, x.discount, x.paid]),
    totals: [
      tc('total'),
      data.staff.count + data.managers.count,
      data.staff.before + data.managers.before,
      data.staff.discount + data.managers.discount,
      data.staff.paid + data.managers.paid,
    ],
  };
  const byEmployee: ExcelSheet = {
    name: t('meals.byEmployee'),
    columns: [
      { key: 'employee', header: t('meals.employee'), width: 18 },
      { key: 'kind', header: t('meals.kind'), width: 12 },
      { key: 'count', header: t('meals.count'), kind: 'number' },
      { key: 'before', header: t('meals.before'), kind: 'money' },
      { key: 'discount', header: t('meals.discount'), kind: 'money' },
      { key: 'paid', header: t('meals.paid'), kind: 'money' },
    ],
    rows: data.byEmployee.map((r) => [
      r.employee ?? null, t(`policy.kinds.${r.kind}`), r.count, r.before, r.discount, r.paid,
    ]),
    totals: [
      tc('total'), null,
      data.byEmployee.reduce((n, r) => n + r.count, 0),
      data.byEmployee.reduce((n, r) => n + r.before, 0),
      data.byEmployee.reduce((n, r) => n + r.discount, 0),
      data.byEmployee.reduce((n, r) => n + r.paid, 0),
    ],
  };
  const meals: ExcelSheet = {
    name: t('meals.rows'),
    columns: [
      { key: 'when', header: t('when'), kind: 'datetime' },
      { key: 'receipt', header: t('receipt'), width: 14 },
      { key: 'kind', header: t('meals.kind'), width: 12 },
      { key: 'employee', header: t('meals.employee'), width: 18 },
      { key: 'reason', header: t('reason'), width: 20 },
      { key: 'approvedBy', header: t('approvedBy'), width: 16 },
      { key: 'before', header: t('meals.before'), kind: 'money' },
      { key: 'discount', header: t('meals.discount'), kind: 'money' },
      { key: 'percent', header: t('meals.percent'), kind: 'percent' },
      { key: 'paid', header: t('meals.paid'), kind: 'money' },
    ],
    rows: data.meals.map((m) => [
      m.at, m.transactionNumber, t(`policy.kinds.${m.kind}`), m.employee ?? null, m.reason ?? null,
      m.approvedBy ?? null, m.before, m.discount, m.percent, m.paid,
    ]),
    totals: [
      tc('total'), null, null, null, null, null,
      data.meals.reduce((n, m) => n + m.before, 0),
      data.meals.reduce((n, m) => n + m.discount, 0),
      null,
      data.meals.reduce((n, m) => n + m.paid, 0),
    ],
  };
  return { byKind, byEmployee, meals };
}

/** The staff and managers' tiles, both kinds together, by KPI key. */
function mealsKpis(data: MealsReport) {
  return {
    meals: data.staff.count + data.managers.count,
    before: data.staff.before + data.managers.before,
    discount: data.staff.discount + data.managers.discount,
    paid: data.staff.paid + data.managers.paid,
    staffMeals: data.staff.count,
    managerMeals: data.managers.count,
  };
}

export function MealsReportView({ shopId }: { shopId: string }) {
  const t = useTranslations('tables');
  const tc = useTranslations('common');
  const [from, setFrom] = useState(daysBackIso(6));
  const [to, setTo] = useState(todayIso());
  const [applied, setApplied] = useState<{ from: string; to: string }>({ from: daysBackIso(6), to: todayIso() });
  const [employee, setEmployee] = useState('');
  const invalid = !from || !to || from > to;
  // Every employee of the range (for the filter), then the report as filtered.
  const all = useQuery({
    queryKey: ['tables-meals', shopId, applied.from, applied.to, ''],
    queryFn: () => fetchMealsReport(shopId, applied.from, applied.to),
  });
  const filtered = useQuery({
    queryKey: ['tables-meals', shopId, applied.from, applied.to, employee],
    queryFn: () => fetchMealsReport(shopId, applied.from, applied.to, employee),
    enabled: employee !== '',
  });
  const data = employee ? filtered.data : all.data;
  const loading = employee ? filtered.isLoading : all.isLoading;
  const failed = employee ? filtered.error : all.error;
  const people = mealEmployees(all.data);

  // The report is one response: every meal of the range (and employee) is in it. Per employee is
  // the designed PDF's table; per kind and every meal are its sheets beside it.
  const exportTables = useMemo(() => {
    if (!data) return [];
    const s = mealsSheets(data, t, tc);
    return [sheetAsTable(s.byKind, 'kinds'), sheetAsTable(s.byEmployee, 'main'), sheetAsTable(s.meals, 'meals')] as ReportTableSpec<unknown>[];
  }, [data, t, tc]);
  const figures = data ? mealsKpis(data) : null;
  const exportKpis: ReportKpi[] = figures
    ? [
        { key: 'meals', label: t('meals.count'), value: figures.meals, kind: 'count', icon: 'receipt' },
        { key: 'before', label: t('meals.before'), value: figures.before, kind: 'money', icon: 'sales' },
        { key: 'discount', label: t('meals.discount'), value: figures.discount, kind: 'money', icon: 'discount' },
        { key: 'paid', label: t('meals.paid'), value: figures.paid, kind: 'money', icon: 'cash' },
        { key: 'staffMeals', label: t('meals.staff'), value: figures.staffMeals, kind: 'count', icon: 'users' },
        { key: 'managerMeals', label: t('meals.managers'), value: figures.managerMeals, kind: 'count', icon: 'user' },
      ]
    : [];
  /** The same report (and employee) for the period before. */
  const previous = async (): Promise<PreviousPeriod | null> => {
    const before = data ? previousWindow(data.from, data.to) : null;
    if (!before) return null;
    const prev = await fetchMealsReport(shopId, before.from, before.to, employee || undefined);
    return { rows: sheetAsTable(mealsSheets(prev, t, tc).byEmployee, 'main').rows, kpis: mealsKpis(prev), ...before };
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3 rounded-lg border bg-card p-3">
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
        <div className="space-y-1">
          <Label className="text-xs">{t('meals.employee')}</Label>
          <Select value={employee || ALL} onValueChange={(v) => v && setEmployee(v === ALL ? '' : v)}>
            <SelectTrigger className="min-w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL} label={t('meals.allEmployees')}>{t('meals.allEmployees')}</SelectItem>
              {people.map((name) => (
                <SelectItem key={name} value={name} label={name}>{name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {loading ? (
        <Skeleton className="h-64 w-full" />
      ) : failed ? (
        <div className="rounded-lg border bg-card p-6 text-destructive">{axiosErrorToToastMessage(failed, tc('error'))}</div>
      ) : data ? (
        <>
          <StandaloneExportBar
            reportKey="meals-report"
            reportType="tables.meals"
            title={[t('sectionMeals'), employee].filter(Boolean).join(' · ')}
            tables={exportTables}
            pdfTableId="main"
            from={data.from}
            to={data.to}
            kpis={exportKpis}
            chartFrom={{ label: 'employee', value: 'discount' }}
            insightKeys={{ label: 'employee', value: 'discount', count: 'count', employee: 'employee' }}
            previous={previous}
          />
          <div className="grid gap-3 md:grid-cols-2">
            <Totals title={t('meals.staff')} totals={data.staff} />
            <Totals title={t('meals.managers')} totals={data.managers} />
          </div>

          <section className="space-y-2">
            <h3 className="font-semibold">{t('meals.byEmployee')}</h3>
            <div className="overflow-x-auto rounded-lg border bg-card">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('meals.employee')}</TableHead>
                    <TableHead>{t('meals.kind')}</TableHead>
                    <TableHead>{t('meals.count')}</TableHead>
                    <TableHead>{t('meals.before')}</TableHead>
                    <TableHead>{t('meals.discount')}</TableHead>
                    <TableHead>{t('meals.paid')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.byEmployee.map((r, i) => (
                    <TableRow key={i}>
                      <TableCell className="font-medium">{r.employee ?? '—'}</TableCell>
                      <TableCell>{t(`policy.kinds.${r.kind}`)}</TableCell>
                      <TableCell>{r.count}</TableCell>
                      <TableCell>{formatCurrency(r.before)}</TableCell>
                      <TableCell>{formatCurrency(r.discount)}</TableCell>
                      <TableCell>{formatCurrency(r.paid)}</TableCell>
                    </TableRow>
                  ))}
                  {data.byEmployee.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center text-muted-foreground">
                        {t('meals.none')}
                      </TableCell>
                    </TableRow>
                  ) : null}
                </TableBody>
              </Table>
            </div>
          </section>

          <section className="space-y-2">
            <h3 className="font-semibold">{t('meals.rows')}</h3>
            <div className="overflow-x-auto rounded-lg border bg-card">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('when')}</TableHead>
                    <TableHead>{t('receipt')}</TableHead>
                    <TableHead>{t('meals.kind')}</TableHead>
                    <TableHead>{t('meals.employee')}</TableHead>
                    <TableHead>{t('reason')}</TableHead>
                    <TableHead>{t('approvedBy')}</TableHead>
                    <TableHead>{t('meals.before')}</TableHead>
                    <TableHead>{t('meals.discount')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.meals.map((m) => (
                    <TableRow key={m.transactionId}>
                      <TableCell className="whitespace-nowrap">{m.at ? formatDateTime(m.at) : '—'}</TableCell>
                      <TableCell>{m.transactionNumber}</TableCell>
                      <TableCell>{t(`policy.kinds.${m.kind}`)}</TableCell>
                      <TableCell>{m.employee ?? '—'}</TableCell>
                      <TableCell>{m.reason ?? '—'}</TableCell>
                      <TableCell>{m.approvedBy ?? '—'}</TableCell>
                      <TableCell>{formatCurrency(m.before)}</TableCell>
                      <TableCell>
                        {formatCurrency(m.discount)}
                        {m.percent != null ? <span className="ms-1 text-xs text-muted-foreground">({percentText(m.percent)}%)</span> : null}
                      </TableCell>
                    </TableRow>
                  ))}
                  {data.meals.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={8} className="text-center text-muted-foreground">
                        {t('meals.none')}
                      </TableCell>
                    </TableRow>
                  ) : null}
                </TableBody>
              </Table>
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}

function Totals({ title, totals }: { title: string; totals: MealTotals }) {
  const t = useTranslations('tables');
  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="text-sm font-semibold">{title}</div>
      <div className="mt-2 grid grid-cols-4 gap-2 text-center">
        <Figure label={t('meals.count')} value={String(totals.count)} />
        <Figure label={t('meals.before')} value={formatCurrency(totals.before)} />
        <Figure label={t('meals.discount')} value={formatCurrency(totals.discount)} />
        <Figure label={t('meals.paid')} value={formatCurrency(totals.paid)} />
      </div>
    </div>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="font-semibold">{value}</div>
    </div>
  );
}
