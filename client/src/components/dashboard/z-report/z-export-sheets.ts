'use client';

/**
 * A Z detail for the report export bar (docs/ACCOUNTING_EXPORT_AND_REPORTS.md §4.1,
 * P:\specs\reports-upgrade.md §5): the Z's own figures, one row per till section (document
 * ranges per number series, counts, money, tenders, card transmission), the card brands, the
 * waiters, the shifts — each a table with keyed columns, so the reader (and the company's
 * default) chooses what goes out — and its failed payment attempts as sheets of their own when
 * there are any. Money goes out as the server sent it (decimal strings), dates as the ISO
 * strings the server sent. The same cells and totals the Z's Excel always had.
 */

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { zShowsExempt } from '@/lib/dealerType';
import { latePartTitleOf } from '@/lib/localShopZ';
import { useCardBrandLabels, type CardBrandBreakdownRow } from '@/lib/cardBrands';
import type { ExcelSheet, ExcelValue } from '@/lib/excelExport';
import type {
  Money,
  PeriodTransmission,
  Shift,
  ZReportDetail,
  ZReportMachineSection,
  ZWaiterRow,
} from '@/lib/types';
import {
  usePaymentMethodLabel,
  useShiftLabel,
  useTillHeading,
} from '@/components/dashboard/shifts/shift-parts';
import { useFailedPaymentsSheets } from '@/components/dashboard/failed-payments/export-sheets';
import type { ReportColumn, ReportTableSpec } from '@/components/dashboard/report-framework';
import { useZNumberLabel, zNumberSourceOf } from './z-number';

/** What a stored section carries beyond the typed fields (app/services/z_builder.py). */
type StoredSection = ZReportMachineSection & {
  documentRanges?: { documentType: number | string; first?: string | null; last?: string | null; count?: number }[];
  transmission?: PeriodTransmission | null;
};

/** Cash and card first (the two the regulation names), then the rest by code. */
function methodsOf(breakdowns: (Record<string, Money> | null | undefined)[]): string[] {
  const all = new Set<string>();
  for (const b of breakdowns) for (const k of Object.keys(b ?? {})) all.add(k);
  const rank = (k: string) => (k === 'cash' ? 0 : k === 'card' ? 1 : 2);
  return [...all].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

const sum = (values: (Money | number | null | undefined)[]): number =>
  Math.round(values.reduce<number>((acc, v) => acc + (Number(v) || 0), 0) * 100) / 100;

/** A key part from a code (`pay:cash`, `range:320:first`). */
const keyPart = (code: string | number) => String(code).replace(/[^A-Za-z0-9_.:-]/g, '_');

export interface ZExport {
  tables: ReportTableSpec<unknown>[];
  /** The Z's failed payment attempts (fetched), as sheets of their own. */
  extraSheets: () => Promise<ExcelSheet[]>;
}

export function useZExportTables() {
  const t = useTranslations('zReports');
  const ts = useTranslations('shifts');
  const tc = useTranslations('common');
  const tcb = useTranslations('cardBrands');
  const tSeq = useTranslations('sequenceReport');
  const brands = useCardBrandLabels();
  const methodLabel = usePaymentMethodLabel();
  const tillHeading = useTillHeading();
  const shiftLabel = useShiftLabel();
  const zNumberLabel = useZNumberLabel();
  const failedSheets = useFailedPaymentsSheets();

  const tillText = (s: { posNumber?: string | null; machineName?: string | null; machineId: string }) => {
    const h = tillHeading(s);
    return [h.title, h.name].filter(Boolean).join(' · ');
  };
  const seriesLabel = (series: number | string) =>
    tSeq.has(`docType.${series}`) ? tSeq(`docType.${series}`) : String(series);

  return (z: ZReportDetail): ZExport => {
    const sections = z.perMachine as StoredSection[];
    const methods = methodsOf([z.paymentBreakdown, ...sections.map((s) => s.paymentBreakdown)]);
    const dealerType = z.business?.dealerType;
    const vat = (x: { vatTotal?: Money | null }) => (zShowsExempt(dealerType, x.vatTotal) ? null : (x.vatTotal ?? null));
    const regular = sections.filter((s) => !latePartTitleOf(s));
    /** A money / count column of the Z and of a section alike. */
    const methodColumns = <R extends { paymentBreakdown?: Record<string, Money> | null }>(total?: (m: string) => ExcelValue) =>
      methods.map(
        (m): ReportColumn<R> => ({
          key: `pay:${keyPart(m)}`,
          header: methodLabel(m),
          kind: 'money',
          value: (r) => r.paymentBreakdown?.[m] ?? null,
          ...(total ? { total: total(m) } : {}),
        }),
      );

    // ── The Z ────────────────────────────────────────────────────────────────
    const summary: ReportTableSpec<ZReportDetail> = {
      id: 'main',
      title: t('export.summarySheet'),
      rows: [z],
      rowKey: (x) => x.id,
      columns: [
        { key: 'zNumber', header: t('zNumber'), width: 16, required: true, value: (x) => zNumberLabel(zNumberSourceOf(x)) },
        {
          key: 'origin',
          header: t('filterOrigin'),
          width: 18,
          value: (x) => (x.origin === 'till' ? t('originTillOption') : t('originCloudOption')),
        },
        { key: 'businessName', header: t('header.businessName'), width: 20, value: (x) => x.business?.businessName ?? null },
        { key: 'vatNumber', header: t('header.vatNumber'), width: 13, value: (x) => x.business?.vatNumber ?? null },
        { key: 'shop', header: t('shop'), width: 18, value: (x) => x.shopName ?? x.business?.shopName ?? null },
        { key: 'area', header: t('area'), width: 14, value: (x) => x.business?.areaName ?? x.areaName ?? null },
        { key: 'till', header: t('export.till'), width: 22, value: (x) => regular.map(tillText).join(', ') || x.machineName || null },
        { key: 'businessDate', header: t('businessDate'), kind: 'date', value: (x) => x.businessDate },
        { key: 'productionDate', header: t('productionDate'), kind: 'date', value: (x) => x.productionDate ?? x.closedAt ?? null },
        { key: 'closedAt', header: t('closedAt'), kind: 'datetime', value: (x) => x.closedAt ?? null },
        { key: 'periodStart', header: t('periodStart'), kind: 'datetime', value: (x) => x.periodStart ?? null },
        { key: 'periodEnd', header: t('periodEnd'), kind: 'datetime', value: (x) => x.periodEnd ?? null },
        { key: 'tills', header: t('tills'), kind: 'number', value: (x) => x.machineCount ?? regular.length },
        { key: 'shifts', header: t('shiftsCount'), kind: 'number', value: (x) => x.shiftCount ?? x.shifts.length },
        { key: 'documents', header: t('documentsSalesAndCredits'), kind: 'number', value: (x) => x.transactionsCount ?? null },
        { key: 'grossSales', header: t('grossSales'), kind: 'money', value: (x) => x.grossSales ?? null },
        { key: 'discounts', header: t('discounts'), kind: 'money', value: (x) => x.discountsTotal ?? null },
        { key: 'salesAfterDiscounts', header: t('salesAfterDiscounts'), kind: 'money', value: (x) => x.totalSales ?? null },
        { key: 'refunds', header: t('refundsAndCredits'), kind: 'money', value: (x) => x.totalRefunds ?? null },
        { key: 'netSales', header: t('netSales'), kind: 'money', value: (x) => x.netSales ?? null },
        { key: 'vat', header: t('vatNetOfCredits'), kind: 'money', value: (x) => vat(x) },
        { key: 'tips', header: t('tips'), kind: 'money', value: (x) => x.totalTips ?? null },
        { key: 'cashTips', header: t('export.cashTips'), kind: 'money', value: (x) => x.totalCashTips ?? null },
        { key: 'cardTips', header: t('export.cardTips'), kind: 'money', value: (x) => x.totalCardTips ?? null },
        ...methodColumns<ZReportDetail>(),
        { key: 'openingCash', header: t('openingCash'), kind: 'money', value: (x) => x.openingCash ?? null },
        { key: 'betweenShiftAdjustments', header: t('betweenShiftAdjustments'), kind: 'money', value: (x) => x.betweenShiftAdjustments ?? null },
        { key: 'expectedCash', header: t('expectedCash'), kind: 'money', value: (x) => x.expectedCash ?? null },
        { key: 'actualCash', header: t('actualCash'), kind: 'money', value: (x) => x.actualCash ?? null },
        { key: 'discrepancy', header: t('discrepancy'), kind: 'money', value: (x) => x.discrepancy ?? null },
      ],
    };

    const tables: ReportTableSpec<unknown>[] = [summary as ReportTableSpec<unknown>];

    // ── One row per till section ───────────────────────────────────────────
    if (sections.length > 0) {
      const series = [
        ...new Set(sections.flatMap((s) => (s.documentRanges ?? []).map((r) => String(r.documentType)))),
      ].sort((a, b) => Number(a) - Number(b));
      const rangeOf = (s: StoredSection, code: string) => (s.documentRanges ?? []).find((x) => String(x.documentType) === code);
      const rangeColumns: ReportColumn<StoredSection>[] =
        series.length > 0
          ? series.flatMap((code): ReportColumn<StoredSection>[] => [
              { key: `range:${keyPart(code)}:first`, header: t('export.rangeFirst', { type: seriesLabel(code) }), width: 16, value: (s) => rangeOf(s, code)?.first ?? null },
              { key: `range:${keyPart(code)}:last`, header: t('export.rangeLast', { type: seriesLabel(code) }), width: 16, value: (s) => rangeOf(s, code)?.last ?? null },
              { key: `range:${keyPart(code)}:count`, header: t('export.rangeCount', { type: seriesLabel(code) }), kind: 'number', value: (s) => rangeOf(s, code)?.count ?? null },
            ])
          : [
              { key: 'firstDocument', header: t('till.firstDocument'), width: 16, value: (s) => s.firstDocumentNumber ?? null },
              { key: 'lastDocument', header: t('till.lastDocument'), width: 16, value: (s) => s.lastDocumentNumber ?? null },
            ];
      const tx = (s: StoredSection) => s.transmission ?? null;
      const anyTx = sections.some(tx);
      const tills: ReportTableSpec<StoredSection> = {
        id: 'tills',
        title: t('tillsTitle'),
        rows: sections,
        rowKey: (s, i) => `${s.machineId}-${i}`,
        // The Z's own figures, as the server summed them.
        totalsLabel: tc('total'),
        columns: [
          { key: 'posNumber', header: t('export.posNumber'), width: 10, value: (s) => s.posNumber ?? null },
          { key: 'machineName', header: t('export.machineName'), width: 20, required: true, value: (s) => latePartTitleOf(s) ?? s.machineName ?? s.machineId },
          { key: 'shifts', header: t('shiftsCount'), kind: 'number', value: (s) => s.shiftCount ?? null, total: z.shiftCount ?? z.shifts.length },
          ...rangeColumns,
          { key: 'documents', header: t('documentsSalesAndCredits'), kind: 'number', value: (s) => s.transactionsCount ?? null, total: z.transactionsCount ?? null },
          { key: 'salesCount', header: t('print.salesCount'), kind: 'number', value: (s) => s.salesCount ?? null, total: sum(sections.map((s) => s.salesCount)) },
          { key: 'creditNotesCount', header: t('print.creditNotesCount'), kind: 'number', value: (s) => s.creditNotesCount ?? null, total: sum(sections.map((s) => s.creditNotesCount)) },
          { key: 'nonSaleCount', header: t('print.nonSaleCount'), kind: 'number', value: (s) => s.nonSaleDocumentsCount ?? null, total: sum(sections.map((s) => s.nonSaleDocumentsCount)) },
          { key: 'grossSales', header: t('grossSales'), kind: 'money', value: (s) => s.grossSales ?? null, total: z.grossSales ?? null },
          { key: 'discounts', header: t('discounts'), kind: 'money', value: (s) => s.discountsTotal ?? null, total: z.discountsTotal ?? null },
          { key: 'salesAfterDiscounts', header: t('salesAfterDiscounts'), kind: 'money', value: (s) => s.totalSales ?? null, total: z.totalSales ?? null },
          { key: 'refunds', header: t('refundsAndCredits'), kind: 'money', value: (s) => s.totalRefunds ?? null, total: z.totalRefunds ?? null },
          { key: 'netSales', header: t('netSales'), kind: 'money', value: (s) => s.netSales ?? null, total: z.netSales ?? null },
          { key: 'vat', header: t('vatNetOfCredits'), kind: 'money', value: (s) => vat(s), total: vat(z) },
          { key: 'tips', header: t('tips'), kind: 'money', value: (s) => s.totalTips ?? null, total: z.totalTips ?? null },
          { key: 'cashTips', header: t('export.cashTips'), kind: 'money', value: (s) => s.totalCashTips ?? null, total: z.totalCashTips ?? null },
          { key: 'cardTips', header: t('export.cardTips'), kind: 'money', value: (s) => s.totalCardTips ?? null, total: z.totalCardTips ?? null },
          ...methodColumns<StoredSection>((m) => z.paymentBreakdown?.[m] ?? null),
          { key: 'openingCash', header: t('openingCash'), kind: 'money', value: (s) => s.openingCash ?? null, total: z.openingCash ?? null },
          { key: 'betweenShiftAdjustments', header: t('betweenShiftAdjustments'), kind: 'money', value: (s) => s.betweenShiftAdjustments ?? null, total: z.betweenShiftAdjustments ?? null },
          { key: 'expectedCash', header: t('expectedCash'), kind: 'money', value: (s) => s.expectedCash ?? null, total: z.expectedCash ?? null },
          // Null when any of the till's shifts is uncounted — never read as zero.
          { key: 'actualCash', header: t('actualCash'), kind: 'money', value: (s) => s.countedCash ?? null, total: z.actualCash ?? null },
          { key: 'discrepancy', header: t('discrepancy'), kind: 'money', value: (s) => s.overShort ?? null, total: z.discrepancy ?? null },
          { key: 'cardLegs', header: t('export.cardLegs'), kind: 'number', value: (s) => tx(s)?.cardLegs ?? null, total: anyTx ? sum(sections.map((s) => tx(s)?.cardLegs)) : null },
          { key: 'transmittedLegs', header: t('export.transmittedLegs'), kind: 'number', value: (s) => tx(s)?.transmittedLegs ?? null, total: anyTx ? sum(sections.map((s) => tx(s)?.transmittedLegs)) : null },
          { key: 'untransmittedLegs', header: t('export.untransmittedLegs'), kind: 'number', value: (s) => tx(s)?.untransmittedLegs ?? null, total: anyTx ? sum(sections.map((s) => tx(s)?.untransmittedLegs)) : null },
          { key: 'untransmittedAmount', header: t('export.untransmittedAmount'), kind: 'money', value: (s) => tx(s)?.untransmittedAmount ?? null, total: anyTx ? sum(sections.map((s) => tx(s)?.untransmittedAmount)) : null },
        ],
      };
      tables.push(tills as ReportTableSpec<unknown>);
    }

    // ── Card brands ──────────────────────────────────────────────────────────
    const cards = z.cardBrands ?? [];
    if (cards.length > 0) {
      const cardTable: ReportTableSpec<CardBrandBreakdownRow> = {
        id: 'cards',
        title: tcb('zTitle'),
        rows: cards,
        rowKey: (r, i) => `${r.brand}-${r.acquirer}-${i}`,
        totalsLabel: tc('total'),
        columns: [
          { key: 'brand', header: tcb('col.brand'), width: 16, required: true, value: (r) => brands.brand(r.brand) },
          { key: 'acquirer', header: tcb('col.acquirer'), width: 16, value: (r) => brands.acquirer(r.acquirer) },
          { key: 'salesCount', header: t('export.salesCount'), kind: 'number', value: (r) => r.salesCount, total: sum(cards.map((r) => r.salesCount)) },
          { key: 'sales', header: tcb('col.sales'), kind: 'money', value: (r) => r.salesAmount, total: sum(cards.map((r) => r.salesAmount)) },
          { key: 'refundsCount', header: t('export.refundsCount'), kind: 'number', value: (r) => r.refundsCount, total: sum(cards.map((r) => r.refundsCount)) },
          { key: 'refunds', header: tcb('col.refunds'), kind: 'money', value: (r) => r.refundsAmount, total: sum(cards.map((r) => r.refundsAmount)) },
          { key: 'net', header: tcb('col.net'), kind: 'money', value: (r) => r.net, total: sum(cards.map((r) => r.net)) },
        ],
      };
      tables.push(cardTable as ReportTableSpec<unknown>);
    }

    // ── Waiters ──────────────────────────────────────────────────────────────
    const waiters = z.byWaiter ?? [];
    if (waiters.length > 0) {
      const waiterTable: ReportTableSpec<ZWaiterRow> = {
        id: 'waiters',
        title: t('waiters.title'),
        rows: waiters,
        rowKey: (r, i) => `${r.waiter ?? ''}-${i}`,
        totalsLabel: tc('total'),
        columns: [
          { key: 'waiter', header: t('waiters.col.waiter'), width: 18, required: true, value: (r) => r.waiter || t('waiters.none') },
          { key: 'tables', header: t('waiters.col.tables'), kind: 'number', value: (r) => r.tables, total: sum(waiters.map((r) => r.tables)) },
          { key: 'guests', header: t('export.guests'), kind: 'number', value: (r) => r.guests, total: sum(waiters.map((r) => r.guests)) },
          { key: 'salesCount', header: t('export.salesCount'), kind: 'number', value: (r) => r.salesCount, total: sum(waiters.map((r) => r.salesCount)) },
          { key: 'sales', header: t('waiters.col.sales'), kind: 'money', value: (r) => r.sales, total: sum(waiters.map((r) => r.sales)) },
          { key: 'refundsCount', header: t('export.refundsCount'), kind: 'number', value: (r) => r.refundsCount, total: sum(waiters.map((r) => r.refundsCount)) },
          { key: 'refunds', header: t('waiters.col.refunds'), kind: 'money', value: (r) => r.refunds, total: sum(waiters.map((r) => r.refunds)) },
          { key: 'net', header: t('waiters.col.net'), kind: 'money', value: (r) => r.net, total: sum(waiters.map((r) => r.net)) },
          { key: 'cash', header: t('waiters.col.cash'), kind: 'money', value: (r) => r.cash, total: sum(waiters.map((r) => r.cash)) },
          { key: 'card', header: t('waiters.col.card'), kind: 'money', value: (r) => r.card, total: sum(waiters.map((r) => r.card)) },
          {
            key: 'productionVoucher',
            header: t('waiters.col.productionVoucher'),
            kind: 'money',
            value: (r) => r.productionVoucher ?? '0.00',
            total: sum(waiters.map((r) => r.productionVoucher ?? '0.00')),
          },
          { key: 'other', header: t('export.other'), kind: 'money', value: (r) => r.other, total: sum(waiters.map((r) => r.other)) },
          { key: 'tips', header: t('waiters.col.tips'), kind: 'money', value: (r) => r.tips, total: sum(waiters.map((r) => r.tips)) },
        ],
      };
      tables.push(waiterTable as ReportTableSpec<unknown>);
    }

    // ── Shifts ───────────────────────────────────────────────────────────────
    if (z.shifts.length > 0) {
      const tillOf = (machineId: string, machineName?: string | null) => {
        const s = sections.find((x) => x.machineId === machineId && !latePartTitleOf(x));
        return s ? tillText(s) : (machineName ?? machineId);
      };
      tables.push(zShiftsExportTable(z.shifts, tillOf) as ReportTableSpec<unknown>);
    }

    return {
      tables,
      // The Z's failed payment attempts (information only).
      extraSheets: async () => {
        try {
          const failed = await failedSheets({ zReportId: z.id });
          return failed.filter((s) => s.rows.length > 0);
        } catch {
          // Information only: the Z's own sheets still go out.
          return [];
        }
      },
    };
  };

  /** The Z's shifts — one table on screen (under each till) and in the export, so the columns are shared. */
  function zShiftsExportTable(shifts: Shift[], tillOf: (machineId: string, machineName?: string | null) => string) {
    return zShiftsTableSpec(shifts, { ts, shiftLabel, tillOf });
  }
}

/**
 * The Z's shifts as a report table (key `z-report`, table `shifts`): on the Z's page under each
 * till, and the "משמרות" sheet of its Excel — the same columns, so the reader's choice is shared.
 */
export function zShiftsTableSpec(
  shifts: Shift[],
  {
    ts,
    shiftLabel,
    tillOf,
    screen,
  }: {
    ts: (key: string) => string;
    shiftLabel: (s: Shift) => string;
    tillOf: (machineId: string, machineName?: string | null) => string;
    /** The screen's cells (links, badges); the export reads the values. */
    screen?: Partial<Record<'shift' | 'opened' | 'closed' | 'counted' | 'overShort' | 'badges', (s: Shift) => ReactNode>>;
  },
): ReportTableSpec<Shift> {
  const columns: ReportColumn<Shift>[] = [
    { key: 'till', header: ts('col.till'), width: 20, exportOnly: true, value: (s) => tillOf(s.machineId, s.machineName) },
    { key: 'shift', header: ts('col.shift'), width: 12, required: true, value: (s) => shiftLabel(s), cell: screen?.shift },
    { key: 'businessDate', header: ts('col.businessDate'), kind: 'date', value: (s) => s.businessDate },
    { key: 'opened', header: ts('col.opened'), kind: 'datetime', value: (s) => s.openedAt, cell: screen?.opened },
    { key: 'openedBy', header: ts('detail.openedBy'), width: 14, exportOnly: true, value: (s) => s.openedByName ?? null },
    { key: 'closed', header: ts('col.closed'), kind: 'datetime', value: (s) => s.closedAt ?? null, cell: screen?.closed },
    {
      key: 'closedBy',
      header: ts('detail.closedBy'),
      width: 14,
      exportOnly: true,
      value: (s) => (s.unattended ? ts('closedRemotely') : (s.closedByName ?? null)),
    },
    { key: 'sales', header: ts('col.sales'), kind: 'money', value: (s) => s.serverTotals?.totalSales ?? null },
    { key: 'expected', header: ts('col.expected'), kind: 'money', exportOnly: true, value: (s) => s.expectedCash ?? null },
    { key: 'counted', header: ts('col.counted'), kind: 'money', value: (s) => s.countedCash ?? null, cell: screen?.counted },
    { key: 'overShort', header: ts('col.overShort'), kind: 'money', value: (s) => s.discrepancy ?? null, cell: screen?.overShort },
    ...(screen?.badges
      ? [{ key: 'badges', header: ts('col.state'), screenOnly: true, sortable: false, value: () => null, cell: screen.badges } as ReportColumn<Shift>]
      : []),
  ];
  return {
    id: 'shifts',
    title: ts('title'),
    columns,
    rows: shifts,
    rowKey: (s) => s.id,
  };
}
