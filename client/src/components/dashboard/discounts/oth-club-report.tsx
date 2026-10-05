'use client';

/**
 * The promotions report's discounts sections: OTH ("על חשבון הבית") by item, employee,
 * reason, till and day, and the club discount ("הנחת מועדון") by till and day beside the
 * manual basket discounts. Same window and scope as the report above it
 * (`GET /reports/discounts`, src/lib/discountsReportApi.ts).
 */

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import type { ReportWindowParams } from '@/lib/api';
import { formatCurrency, formatQuantity } from '@/lib/format';
import {
  fetchDiscountsReport,
  type ClubFigures,
  type DiscountsReport,
  type OthFigures,
  type TillLabel,
} from '@/lib/discountsReportApi';
import { ReportErrorState } from '@/components/dashboard/report-window-summary';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table';

type OthView = 'byItem' | 'byEmployee' | 'byReason' | 'byTill' | 'byDay';
const OTH_VIEWS: OthView[] = ['byItem', 'byEmployee', 'byReason', 'byTill', 'byDay'];

interface Labelled {
  key: string;
  label: string;
}

/**
 * One OTH exception's line on the exceptions page: "בירה ×2 · פיצוי · אישר: אבי".
 * `approvedBy` words the approver ("אישר: {name}").
 */
export function othExceptionLine(d: Record<string, unknown>, approvedBy: (name: string) => string): string {
  const qty = typeof d.quantity === 'number' && d.quantity !== 1 ? ` ×${formatQuantity(d.quantity)}` : '';
  const name = typeof d.productName === 'string' && d.productName ? `${d.productName}${qty}` : null;
  const reason = typeof d.reason === 'string' && d.reason ? d.reason : null;
  const approver = typeof d.approverName === 'string' && d.approverName ? approvedBy(d.approverName) : null;
  return [name, reason, approver].filter(Boolean).join(' · ');
}

function tillLabel(r: TillLabel, unknown: string, register: (n: string) => string): string {
  return [r.shopName, r.name, r.posNumber ? register(r.posNumber) : null].filter(Boolean).join(' · ') || unknown;
}

function OthTable({ head, rows, totals }: { head: string; rows: (OthFigures & Labelled)[]; totals: OthFigures }) {
  const t = useTranslations('othClubReport');
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{head}</TableHead>
          <TableHead className="text-end">{t('col.lines')}</TableHead>
          <TableHead className="text-end">{t('col.units')}</TableHead>
          <TableHead className="text-end">{t('col.value')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.key}>
            <TableCell className="font-medium">{r.label}</TableCell>
            <TableCell className="text-end tabular-nums">{formatQuantity(r.count)}</TableCell>
            <TableCell className="text-end tabular-nums">{formatQuantity(r.quantity)}</TableCell>
            <TableCell className="text-end font-semibold tabular-nums">{formatCurrency(r.value)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
      <TableFooter>
        <TableRow>
          <TableCell className="font-semibold">{t('total')}</TableCell>
          <TableCell className="text-end tabular-nums">{formatQuantity(totals.count)}</TableCell>
          <TableCell className="text-end tabular-nums">{formatQuantity(totals.quantity)}</TableCell>
          <TableCell className="text-end font-bold tabular-nums">{formatCurrency(totals.value)}</TableCell>
        </TableRow>
      </TableFooter>
    </Table>
  );
}

function ClubTable({ head, rows, totals }: { head: string; rows: (ClubFigures & Labelled)[]; totals: ClubFigures }) {
  const t = useTranslations('othClubReport');
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{head}</TableHead>
          <TableHead className="text-end">{t('col.sales')}</TableHead>
          <TableHead className="text-end">{t('col.amount')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.key}>
            <TableCell className="font-medium">{r.label}</TableCell>
            <TableCell className="text-end tabular-nums">{formatQuantity(r.count)}</TableCell>
            <TableCell className="text-end font-semibold tabular-nums">{formatCurrency(r.amount)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
      <TableFooter>
        <TableRow>
          <TableCell className="font-semibold">{t('total')}</TableCell>
          <TableCell className="text-end tabular-nums">{formatQuantity(totals.count)}</TableCell>
          <TableCell className="text-end font-bold tabular-nums">{formatCurrency(totals.amount)}</TableCell>
        </TableRow>
      </TableFooter>
    </Table>
  );
}

function useRows(data: DiscountsReport | undefined) {
  const t = useTranslations('othClubReport');
  return useMemo(() => {
    if (!data) return null;
    const unknown = t('unknown');
    const register = (n: string) => t('register', { n });
    const oth: Record<OthView, (OthFigures & Labelled)[]> = {
      byItem: data.oth.byItem.map((r, i) => ({ ...r, key: r.productId ?? `i${i}`, label: r.name ?? unknown })),
      byEmployee: data.oth.byEmployee.map((r, i) => ({
        ...r,
        key: r.posUserId ?? `e${i}`,
        label: r.name ?? (r.posUserId ? t('unknownEmployee') : unknown),
      })),
      byReason: data.oth.byReason.map((r, i) => ({ ...r, key: r.reason ?? `r${i}`, label: r.reason ?? unknown })),
      byTill: data.oth.byTill.map((r, i) => ({ ...r, key: r.machineId ?? `t${i}`, label: tillLabel(r, unknown, register) })),
      byDay: data.oth.byDay.map((r) => ({ ...r, key: r.date, label: r.date })),
    };
    return {
      oth,
      clubByTill: data.club.byTill.map((r, i) => ({ ...r, key: r.machineId ?? `t${i}`, label: tillLabel(r, unknown, register) })),
      clubByDay: data.club.byDay.map((r) => ({ ...r, key: r.date, label: r.date })),
      byKind: data.basketByKind.map((r) => ({ ...r, key: r.kind, label: t(`kind.${r.kind}`) })),
    };
  }, [data, t]);
}

/** Rendered under the promotions report; nothing until the report is run (`params` null). */
export function OthClubReport({ params }: { params: ReportWindowParams | null }) {
  const t = useTranslations('othClubReport');
  const tc = useTranslations('common');
  const [view, setView] = useState<OthView>('byItem');
  const { data, isLoading, isError, error } = useQuery<DiscountsReport>({
    queryKey: ['report-discounts', params],
    queryFn: () => fetchDiscountsReport(params!),
    enabled: params !== null,
  });
  const rows = useRows(data);

  if (params === null) return null;
  if (isLoading) return <Skeleton className="h-40 w-full" />;
  if (isError) return <ReportErrorState message={axiosErrorToToastMessage(error, tc('error'))} />;
  if (!data || !rows) return null;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{t('oth.title')}</CardTitle>
          <p className="text-sm text-muted-foreground">{t('oth.subtitle')}</p>
        </CardHeader>
        <CardContent className="space-y-3 p-0 pb-2">
          {data.oth.totals.count === 0 ? (
            <p className="px-6 py-6 text-center text-sm text-muted-foreground">{t('oth.none')}</p>
          ) : (
            <>
              <p className="px-6 text-sm">
                {t('oth.summary', {
                  lines: data.oth.totals.count,
                  units: formatQuantity(data.oth.totals.quantity),
                  value: formatCurrency(data.oth.totals.value),
                  documents: data.oth.totals.documents,
                })}
              </p>
              <div className="flex flex-wrap gap-2 px-6" role="tablist" aria-label={t('oth.title')}>
                {OTH_VIEWS.map((v) => (
                  <Button
                    key={v}
                    size="sm"
                    role="tab"
                    aria-selected={view === v}
                    variant={view === v ? 'default' : 'outline'}
                    onClick={() => setView(v)}
                  >
                    {t(`oth.${v}`)}
                  </Button>
                ))}
              </div>
              <div className="overflow-x-auto">
                <OthTable head={t(`oth.col.${view}`)} rows={rows.oth[view]} totals={data.oth.totals} />
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{t('club.title')}</CardTitle>
          <p className="text-sm text-muted-foreground">{t('club.subtitle')}</p>
        </CardHeader>
        <CardContent className="space-y-4 p-0 pb-2">
          {rows.byKind.length === 0 ? (
            <p className="px-6 py-6 text-center text-sm text-muted-foreground">{t('club.none')}</p>
          ) : (
            <>
              <div className="overflow-x-auto">
                <ClubTable
                  head={t('club.col.kind')}
                  rows={rows.byKind}
                  totals={rows.byKind.reduce(
                    (a, r) => ({ count: a.count + r.count, amount: a.amount + r.amount }),
                    { count: 0, amount: 0 },
                  )}
                />
              </div>
              {data.club.totals.count > 0 ? (
                <>
                  <h3 className="px-6 text-sm font-semibold">{t('club.byTill')}</h3>
                  <div className="overflow-x-auto">
                    <ClubTable head={t('club.col.till')} rows={rows.clubByTill} totals={data.club.totals} />
                  </div>
                  <h3 className="px-6 text-sm font-semibold">{t('club.byDay')}</h3>
                  <div className="overflow-x-auto">
                    <ClubTable head={t('club.col.day')} rows={rows.clubByDay} totals={data.club.totals} />
                  </div>
                </>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
