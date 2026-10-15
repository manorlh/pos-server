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
import {
  StandaloneExportBar,
  sheetAsTable,
  type PreviousPeriod,
  type ReportKpi,
  type ReportTableSpec,
} from '@/components/dashboard/report-framework';
import { previousWindow } from '@/lib/designedReport';
import type { ExcelCellKind, ExcelSheet } from '@/lib/excelExport';
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

type T = ReturnType<typeof useTranslations>;

/** The report's groupings with each row's key and label, as the tables and the export show them. */
function labelledRows(data: DiscountsReport, t: T) {
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
    vouchersByBatch: (data.vouchers?.byBatch ?? []).map((r, i) => ({ ...r, key: r.batchId ?? `b${i}`, label: r.name ?? unknown })),
    vouchersByTill: (data.vouchers?.byTill ?? []).map((r, i) => ({ ...r, key: r.machineId ?? `t${i}`, label: tillLabel(r, unknown, register) })),
    vouchersByDay: (data.vouchers?.byDay ?? []).map((r) => ({ ...r, key: r.date, label: r.date })),
  };
}

type OthClubRows = ReturnType<typeof labelledRows>;

function useRows(data: DiscountsReport | undefined) {
  const t = useTranslations('othClubReport');
  return useMemo(() => (data ? labelledRows(data, t) : null), [data, t]);
}

/** The OTH grouping's first column in the export (its key, for the column choice and the chart). */
const OTH_KEY: Record<OthView, string> = { byItem: 'item', byEmployee: 'employee', byReason: 'reason', byTill: 'till', byDay: 'day' };
/** The export's table ids: OTH by item is the report's own table (the designed PDF's). */
const OTH_TABLE: Record<OthView, string> = {
  byItem: 'main',
  byEmployee: 'othEmployee',
  byReason: 'othReason',
  byTill: 'othTill',
  byDay: 'othDay',
};

/**
 * Every OTH grouping as its own sheet (not just the one on screen), then the club tables and
 * the discount vouchers as the page shows them, each with its export table id. Days go out as
 * the API's ISO dates (real date cells).
 */
function othClubSheets(data: DiscountsReport, rows: OthClubRows, t: T): { id: string; sheet: ExcelSheet }[] {
  const othSheet = (v: OthView): { id: string; sheet: ExcelSheet } => ({
    id: OTH_TABLE[v],
    sheet: {
      name: `OTH ${t(`oth.${v}`)}`,
      columns: [
        { key: OTH_KEY[v], header: t(`oth.col.${v}`), kind: v === 'byDay' ? 'date' : 'text' },
        { key: 'lines', header: t('col.lines'), kind: 'number' },
        { key: 'units', header: t('col.units'), kind: 'number' },
        { key: 'value', header: t('col.value'), kind: 'money' },
      ],
      rows:
        v === 'byDay'
          ? data.oth.byDay.map((r) => [r.date, r.count, r.quantity, r.value])
          : rows.oth[v].map((r) => [r.label, r.count, r.quantity, r.value]),
      totals: [t('total'), data.oth.totals.count, data.oth.totals.quantity, data.oth.totals.value],
    },
  });
  const clubSheet = (
    id: string,
    name: string,
    head: { key: string; header: string; kind: ExcelCellKind },
    list: (string | number)[][],
    totals: ClubFigures,
  ): { id: string; sheet: ExcelSheet } => ({
    id,
    sheet: {
      name,
      columns: [
        head,
        { key: 'sales', header: t('col.sales'), kind: 'number' },
        { key: 'amount', header: t('col.amount'), kind: 'money' },
      ],
      rows: list,
      totals: [t('total'), totals.count, totals.amount],
    },
  });
  const sheets: { id: string; sheet: ExcelSheet }[] = data.oth.totals.count > 0 ? OTH_VIEWS.map(othSheet) : [];
  if (rows.byKind.length > 0) {
    sheets.push(
      clubSheet(
        'clubKind',
        t('club.title'),
        { key: 'kind', header: t('club.col.kind'), kind: 'text' },
        rows.byKind.map((r) => [r.label, r.count, r.amount]),
        rows.byKind.reduce(
          (a, r) => ({ count: a.count + r.count, amount: a.amount + r.amount }),
          { count: 0, amount: 0 },
        ),
      ),
    );
    if (data.club.totals.count > 0) {
      sheets.push(
        clubSheet(
          'clubTill',
          t('club.byTill'),
          { key: 'till', header: t('club.col.till'), kind: 'text' },
          rows.clubByTill.map((r) => [r.label, r.count, r.amount]),
          data.club.totals,
        ),
        clubSheet(
          'clubDay',
          t('club.byDay'),
          { key: 'day', header: t('club.col.day'), kind: 'date' },
          data.club.byDay.map((r) => [r.date, r.count, r.amount]),
          data.club.totals,
        ),
      );
    }
  }
  const voucherTotals = data.vouchers?.totals;
  if (voucherTotals && voucherTotals.count > 0) {
    // Discount vouchers: by batch, till and day — the uses beside the sales and the ₪.
    const voucherSheet = (
      id: string,
      name: string,
      head: { key: string; header: string; kind: ExcelCellKind },
      list: (string | number)[][],
    ): { id: string; sheet: ExcelSheet } => ({
      id,
      sheet: {
        name: `${t('vouchers.title')} ${name}`,
        columns: [
          head,
          { key: 'sales', header: t('col.sales'), kind: 'number' },
          { key: 'uses', header: t('vouchers.col.uses'), kind: 'number' },
          { key: 'amount', header: t('col.amount'), kind: 'money' },
        ],
        rows: list,
        totals: [t('total'), voucherTotals.count, voucherTotals.uses, voucherTotals.amount],
      },
    });
    sheets.push(
      voucherSheet('voucherBatch', t('vouchers.byBatch'), { key: 'batch', header: t('vouchers.col.batch'), kind: 'text' },
        rows.vouchersByBatch.map((r) => [r.label, r.count, r.uses, r.amount])),
      voucherSheet('voucherTill', t('vouchers.byTill'), { key: 'till', header: t('vouchers.col.till'), kind: 'text' },
        rows.vouchersByTill.map((r) => [r.label, r.count, r.uses, r.amount])),
      voucherSheet('voucherDay', t('vouchers.byDay'), { key: 'day', header: t('vouchers.col.day'), kind: 'date' },
        (data.vouchers?.byDay ?? []).map((r) => [r.date, r.count, r.uses, r.amount])),
    );
  }
  return sheets;
}

/** The section's totals by KPI key: OTH, the club discount and the discount vouchers. */
function othClubKpis(data: DiscountsReport) {
  return {
    othValue: data.oth.totals.value,
    othLines: data.oth.totals.count,
    clubDiscount: data.club.totals.amount,
    clubSales: data.club.totals.count,
    ...(data.vouchers
      ? { voucherDiscount: data.vouchers.totals.amount, voucherUses: data.vouchers.totals.uses }
      : {}),
  };
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
  const exportTables = useMemo(
    () =>
      data && rows
        ? (othClubSheets(data, rows, t).map(({ id, sheet }) => sheetAsTable(sheet, id)) as ReportTableSpec<unknown>[])
        : [],
    [data, rows, t],
  );

  if (params === null) return null;
  if (isLoading) return <Skeleton className="h-40 w-full" />;
  if (isError) return <ReportErrorState message={axiosErrorToToastMessage(error, tc('error'))} />;
  if (!data || !rows) return null;

  const hasOth = data.oth.totals.count > 0;
  const voucherTotals = data.vouchers?.totals;
  const hasVouchers = (voucherTotals?.count ?? 0) > 0;
  const figures = othClubKpis(data);
  const exportKpis: ReportKpi[] = [
    { key: 'othValue', label: t('kpi.othValue'), value: figures.othValue, kind: 'money', icon: 'gift' },
    { key: 'othLines', label: t('kpi.othLines'), value: figures.othLines, kind: 'count', icon: 'gift' },
    { key: 'clubDiscount', label: t('kind.club'), value: figures.clubDiscount, kind: 'money', icon: 'discount' },
    { key: 'clubSales', label: t('kpi.clubSales'), value: figures.clubSales, kind: 'count', icon: 'receipt' },
    ...(data.vouchers
      ? [
          { key: 'voucherDiscount', label: t('kpi.voucherDiscount'), value: figures.voucherDiscount ?? null, kind: 'money' as const, icon: 'voucher' as const },
          { key: 'voucherUses', label: t('kpi.voucherUses'), value: figures.voucherUses ?? null, kind: 'count' as const, icon: 'voucher' as const },
        ]
      : []),
  ];
  /**
   * The same sections for the period before; its rows are those of the table the PDF draws
   * (OTH by item, or the first section there is).
   */
  const previous = async (): Promise<PreviousPeriod | null> => {
    const before = previousWindow(params.from, params.to);
    const mainId = exportTables[0]?.id;
    if (!before || !mainId) return null;
    const prev = await fetchDiscountsReport({ ...params, ...before });
    const sheet = othClubSheets(prev, labelledRows(prev, t), t).find((s) => s.id === mainId)?.sheet;
    return { rows: sheet ? sheetAsTable(sheet, mainId).rows : [], kpis: othClubKpis(prev), ...before };
  };

  return (
    <div className="space-y-4">
      <StandaloneExportBar
        reportKey="oth-club"
        reportType="promotions.oth-club"
        title={`${t('oth.title')} · ${t('club.title')}`}
        tables={exportTables}
        from={data.window.from}
        to={data.window.to}
        disabled={!hasOth && rows.byKind.length === 0 && !hasVouchers}
        kpis={exportKpis}
        chartFrom={{ label: 'item', value: 'value' }}
        previous={previous}
      />
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

      {data.productionVouchers && data.productionVouchers.totals.count > 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-3 text-sm text-muted-foreground">
          {t('productionVouchers', {
            amount: formatCurrency(data.productionVouchers.totals.amount),
            documents: data.productionVouchers.totals.documents,
          })}
        </p>
      ) : null}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{t('vouchers.title')}</CardTitle>
          <p className="text-sm text-muted-foreground">{t('vouchers.subtitle')}</p>
        </CardHeader>
        <CardContent className="space-y-4 p-0 pb-2">
          {!hasVouchers || !voucherTotals ? (
            <p className="px-6 py-6 text-center text-sm text-muted-foreground">{t('vouchers.none')}</p>
          ) : (
            <>
              <p className="px-6 text-sm">
                {t('vouchers.summary', {
                  count: voucherTotals.count,
                  uses: voucherTotals.uses,
                  amount: formatCurrency(voucherTotals.amount),
                  documents: voucherTotals.documents,
                })}
              </p>
              <h3 className="px-6 text-sm font-semibold">{t('vouchers.byBatch')}</h3>
              <div className="overflow-x-auto">
                <ClubTable head={t('vouchers.col.batch')} rows={rows.vouchersByBatch} totals={voucherTotals} />
              </div>
              <h3 className="px-6 text-sm font-semibold">{t('vouchers.byTill')}</h3>
              <div className="overflow-x-auto">
                <ClubTable head={t('vouchers.col.till')} rows={rows.vouchersByTill} totals={voucherTotals} />
              </div>
              <h3 className="px-6 text-sm font-semibold">{t('vouchers.byDay')}</h3>
              <div className="overflow-x-auto">
                <ClubTable head={t('vouchers.col.day')} rows={rows.vouchersByDay} totals={voucherTotals} />
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
