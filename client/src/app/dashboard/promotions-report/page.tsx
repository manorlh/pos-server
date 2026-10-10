'use client';

/**
 * Promotions report (דוח מבצעים): how many times each promotion applied, on how many
 * sales, and what it took off — by promotion, shop, till and day. Credit notes are left
 * out: a return credits what was paid for the item, and the promotion it was sold under
 * stays given. Server: `GET /reports/promotions`.
 */

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { usePageScope } from '@/lib/scope';
import { formatCurrency, formatDate, formatQuantity } from '@/lib/format';
import { WHOLE_DAY, businessDaysBackIso, businessTodayIso, hourQueryParams } from '@/lib/reportWindow';
import { dayBasisQuery } from '@/lib/businessDay';
import {
  fetchPromotionsReport,
  type PromotionReportFigures,
  type PromotionsReport,
} from '@/lib/promotionsApi';
import { ScopeGate } from '@/components/dashboard/scope-gate';
import { OthClubReport } from '@/components/dashboard/discounts/oth-club-report';
import { ReportFilters, type ReportFiltersState } from '@/components/dashboard/report-filters';
import { ReportExportToolbar } from '@/components/dashboard/report-export-toolbar';
import { ReportErrorState, ReportWindowSummary } from '@/components/dashboard/report-window-summary';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

interface Row extends PromotionReportFigures {
  key: string;
  label: string;
}

function FiguresTable({ title, head, rows, totals }: { title: string; head: string; rows: Row[]; totals: PromotionReportFigures }) {
  const t = useTranslations('promotionsReport');
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="overflow-x-auto p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{head}</TableHead>
              <TableHead className="text-end">{t('col.applications')}</TableHead>
              <TableHead className="text-end">{t('col.documents')}</TableHead>
              <TableHead className="text-end">{t('col.discount')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.key}>
                <TableCell className="font-medium">{r.label}</TableCell>
                <TableCell className="text-end tabular-nums">{formatQuantity(r.applications)}</TableCell>
                <TableCell className="text-end tabular-nums">{formatQuantity(r.documents)}</TableCell>
                <TableCell className="text-end font-semibold tabular-nums">{formatCurrency(r.discount)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell className="font-semibold">{t('total')}</TableCell>
              <TableCell className="text-end tabular-nums">{formatQuantity(totals.applications)}</TableCell>
              <TableCell className="text-end tabular-nums">{formatQuantity(totals.documents)}</TableCell>
              <TableCell className="text-end font-bold tabular-nums">{formatCurrency(totals.discount)}</TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      </CardContent>
    </Card>
  );
}

export default function PromotionsReportPage() {
  const t = useTranslations('promotionsReport');
  const tt = useTranslations('promotions.types');
  const tc = useTranslations('common');
  const { resolution, effective } = usePageScope({ maxLevel: 'machine', unsupported: ['company'] });

  const [filters, setFilters] = useState<ReportFiltersState>({ from: businessDaysBackIso(6), to: businessTodayIso(), hours: WHOLE_DAY });
  const [applied, setApplied] = useState<ReportFiltersState | null>(null);

  const params = useMemo(() => {
    if (!applied) return null;
    return {
      from: applied.from,
      to: applied.to,
      ...(effective.shopId ? { shopId: effective.shopId } : {}),
      ...(effective.machineId ? { machineId: effective.machineId } : {}),
      ...hourQueryParams(applied.hours),
      ...dayBasisQuery(applied.dayBasis),
    };
  }, [applied, effective.shopId, effective.machineId]);

  const { data, isLoading, isFetching, isError, error } = useQuery<PromotionsReport>({
    queryKey: ['report-promotions', params],
    queryFn: () => fetchPromotionsReport(params!),
    enabled: params !== null,
  });

  const tables = useMemo(() => {
    if (!data) return null;
    const unknown = t('unknown');
    return {
      byPromotion: data.byPromotion.map((r, i) => ({
        ...r,
        key: r.promotionId ?? `p${i}`,
        label: `${r.name ?? unknown}${r.type ? ` · ${tt(`${r.type}.name`)}` : ''}`,
      })),
      byShop: data.byShop.map((r, i) => ({ ...r, key: r.shopId ?? `s${i}`, label: r.name ?? unknown })),
      byTill: data.byTill.map((r, i) => ({
        ...r,
        key: r.machineId ?? `m${i}`,
        label: [r.shopName, r.name, r.posNumber ? t('register', { n: r.posNumber }) : null].filter(Boolean).join(' · ') || unknown,
      })),
      byDay: data.byDay.map((r) => ({ ...r, key: r.date, label: formatDate(r.date) })),
    };
  }, [data, t, tt]);

  const sheet = (name: string, head: string, rows: Row[], totals: PromotionReportFigures) => ({
    name,
    columns: [
      { header: head },
      { header: t('col.applications'), kind: 'number' as const },
      { header: t('col.documents'), kind: 'number' as const },
      { header: t('col.discount'), kind: 'money' as const },
    ],
    rows: rows.map((r) => [r.label, r.applications, r.documents, r.discount]),
    totals: [t('total'), totals.applications, totals.documents, totals.discount],
  });

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>

      <ScopeGate resolution={resolution}>
        <ReportFilters value={filters} onChange={setFilters} onRun={() => setApplied(filters)} isFetching={isFetching} />

        {!applied ? (
          <p className="py-12 text-center text-sm text-muted-foreground">{t('selectFilters')}</p>
        ) : isLoading ? (
          <Skeleton className="h-64 w-full" />
        ) : isError ? (
          <ReportErrorState message={axiosErrorToToastMessage(error, tc('error'))} />
        ) : data && tables ? (
          <div className="space-y-4">
            <ReportExportToolbar
              title={t('title')}
              from={data.window.from}
              to={data.window.to}
              getSheets={() => [
                sheet(t('byPromotion'), t('col.promotion'), tables.byPromotion, data.totals),
                sheet(t('byShop'), t('col.shop'), tables.byShop, data.totals),
                sheet(t('byTill'), t('col.till'), tables.byTill, data.totals),
                sheet(t('byDay'), t('col.day'), tables.byDay, data.totals),
              ]}
            />
            <ReportWindowSummary window={data.window} generatedAt={data.generatedAt} />
            {data.byPromotion.length === 0 ? (
              <p className="py-10 text-center text-sm text-muted-foreground">{t('noRows')}</p>
            ) : (
              <>
                <FiguresTable title={t('byPromotion')} head={t('col.promotion')} rows={tables.byPromotion} totals={data.totals} />
                <FiguresTable title={t('byShop')} head={t('col.shop')} rows={tables.byShop} totals={data.totals} />
                <FiguresTable title={t('byTill')} head={t('col.till')} rows={tables.byTill} totals={data.totals} />
                <FiguresTable title={t('byDay')} head={t('col.day')} rows={tables.byDay} totals={data.totals} />
              </>
            )}
          </div>
        ) : null}
        {/* OTH ("על חשבון הבית") and the club discount, over the same window and scope. */}
        <OthClubReport params={params} />
      </ScopeGate>
    </div>
  );
}
