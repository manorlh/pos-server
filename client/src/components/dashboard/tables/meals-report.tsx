'use client';

/**
 * "ארוחות עובדים ומנהלים": the meals eaten at staff and managers' tables (table types —
 * lib/tablePolicy.ts) over a range of days — per kind the count, the value before the
 * discount, the discount and what was paid; per employee; and every meal (whose, why,
 * who approved). Filterable by employee. From the sale documents the tills push
 * (`meal_kind` …, pos-server app/services/table_policies.py, meals_report).
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { formatCurrency, formatDateTime } from '@/lib/format';
import { daysBackIso, todayIso } from '@/lib/reportWindow';
import { fetchMealsReport } from '@/lib/tablesApi';
import { mealEmployees, percentText, type MealTotals } from '@/lib/tablePolicy';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const ALL = '__all__';

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
