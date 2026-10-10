'use client';

/**
 * A Z detail as Excel (docs/ACCOUNTING_EXPORT_AND_REPORTS.md §4.1): the Z's own figures,
 * one row per till section (document ranges per number series, counts, money, tenders,
 * card transmission), the card brands, the waiters, the shifts — and its failed payment
 * attempts when there are any. Money goes out as the server sent it (decimal strings),
 * dates as the ISO strings the server sent.
 */

import { useTranslations } from 'next-intl';
import { zShowsExempt } from '@/lib/dealerType';
import { latePartTitleOf } from '@/lib/localShopZ';
import { useCardBrandLabels } from '@/lib/cardBrands';
import type { ExcelColumn, ExcelSheet, ExcelValue } from '@/lib/excelExport';
import type { Money, PeriodTransmission, ZReportDetail, ZReportMachineSection } from '@/lib/types';
import {
  usePaymentMethodLabel,
  useShiftLabel,
  useTillHeading,
} from '@/components/dashboard/shifts/shift-parts';
import { useFailedPaymentsSheets } from '@/components/dashboard/failed-payments/export-sheets';
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

export function useZExportSheets() {
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

  return async (z: ZReportDetail): Promise<ExcelSheet[]> => {
    const sections = z.perMachine as StoredSection[];
    const methods = methodsOf([z.paymentBreakdown, ...sections.map((s) => s.paymentBreakdown)]);
    const methodColumns: ExcelColumn[] = methods.map((m) => ({ header: methodLabel(m), kind: 'money' }));
    const dealerType = z.business?.dealerType;
    const vat = (x: { vatTotal?: Money | null }) => (zShowsExempt(dealerType, x.vatTotal) ? null : (x.vatTotal ?? null));
    const regular = sections.filter((s) => !latePartTitleOf(s));

    // ── The Z ────────────────────────────────────────────────────────────────
    const summary: ExcelSheet = {
      name: t('export.summarySheet'),
      columns: [
        { header: t('zNumber'), width: 16 },
        { header: t('filterOrigin'), width: 18 },
        { header: t('header.businessName'), width: 20 },
        { header: t('header.vatNumber'), width: 13 },
        { header: t('shop'), width: 18 },
        { header: t('area'), width: 14 },
        { header: t('export.till'), width: 22 },
        { header: t('businessDate'), kind: 'date' },
        { header: t('productionDate'), kind: 'date' },
        { header: t('closedAt'), kind: 'datetime' },
        { header: t('periodStart'), kind: 'datetime' },
        { header: t('periodEnd'), kind: 'datetime' },
        { header: t('tills'), kind: 'number' },
        { header: t('shiftsCount'), kind: 'number' },
        { header: t('documentsSalesAndCredits'), kind: 'number' },
        { header: t('grossSales'), kind: 'money' },
        { header: t('discounts'), kind: 'money' },
        { header: t('salesAfterDiscounts'), kind: 'money' },
        { header: t('refundsAndCredits'), kind: 'money' },
        { header: t('netSales'), kind: 'money' },
        { header: t('vatNetOfCredits'), kind: 'money' },
        { header: t('tips'), kind: 'money' },
        { header: t('export.cashTips'), kind: 'money' },
        { header: t('export.cardTips'), kind: 'money' },
        ...methodColumns,
        { header: t('openingCash'), kind: 'money' },
        { header: t('betweenShiftAdjustments'), kind: 'money' },
        { header: t('expectedCash'), kind: 'money' },
        { header: t('actualCash'), kind: 'money' },
        { header: t('discrepancy'), kind: 'money' },
      ],
      rows: [
        [
          zNumberLabel(zNumberSourceOf(z)),
          z.origin === 'till' ? t('originTillOption') : t('originCloudOption'),
          z.business?.businessName ?? null,
          z.business?.vatNumber ?? null,
          z.shopName ?? z.business?.shopName ?? null,
          z.business?.areaName ?? z.areaName ?? null,
          regular.map(tillText).join(', ') || z.machineName || null,
          z.businessDate,
          z.productionDate ?? z.closedAt,
          z.closedAt,
          z.periodStart ?? null,
          z.periodEnd ?? null,
          z.machineCount ?? regular.length,
          z.shiftCount ?? z.shifts.length,
          z.transactionsCount ?? null,
          z.grossSales ?? null,
          z.discountsTotal ?? null,
          z.totalSales ?? null,
          z.totalRefunds ?? null,
          z.netSales ?? null,
          vat(z),
          z.totalTips ?? null,
          z.totalCashTips ?? null,
          z.totalCardTips ?? null,
          ...methods.map((m) => z.paymentBreakdown?.[m] ?? null),
          z.openingCash ?? null,
          z.betweenShiftAdjustments ?? null,
          z.expectedCash ?? null,
          z.actualCash ?? null,
          z.discrepancy ?? null,
        ],
      ],
    };

    const sheets: ExcelSheet[] = [summary];

    // ── One row per till section ───────────────────────────────────────────
    if (sections.length > 0) {
      const series = [
        ...new Set(sections.flatMap((s) => (s.documentRanges ?? []).map((r) => String(r.documentType)))),
      ].sort((a, b) => Number(a) - Number(b));
      const rangeColumns: ExcelColumn[] =
        series.length > 0
          ? series.flatMap((code) => [
              { header: t('export.rangeFirst', { type: seriesLabel(code) }), width: 16 },
              { header: t('export.rangeLast', { type: seriesLabel(code) }), width: 16 },
              { header: t('export.rangeCount', { type: seriesLabel(code) }), kind: 'number' as const },
            ])
          : [
              { header: t('till.firstDocument'), width: 16 },
              { header: t('till.lastDocument'), width: 16 },
            ];
      const rangeValues = (s: StoredSection): ExcelValue[] =>
        series.length > 0
          ? series.flatMap((code) => {
              const r = (s.documentRanges ?? []).find((x) => String(x.documentType) === code);
              return [r?.first ?? null, r?.last ?? null, r?.count ?? null];
            })
          : [s.firstDocumentNumber ?? null, s.lastDocumentNumber ?? null];
      const tx = (s: StoredSection) => s.transmission ?? null;

      sheets.push({
        name: t('tillsTitle'),
        columns: [
          { header: t('export.posNumber'), width: 10 },
          { header: t('export.machineName'), width: 20 },
          { header: t('shiftsCount'), kind: 'number' },
          ...rangeColumns,
          { header: t('documentsSalesAndCredits'), kind: 'number' },
          { header: t('print.salesCount'), kind: 'number' },
          { header: t('print.creditNotesCount'), kind: 'number' },
          { header: t('print.nonSaleCount'), kind: 'number' },
          { header: t('grossSales'), kind: 'money' },
          { header: t('discounts'), kind: 'money' },
          { header: t('salesAfterDiscounts'), kind: 'money' },
          { header: t('refundsAndCredits'), kind: 'money' },
          { header: t('netSales'), kind: 'money' },
          { header: t('vatNetOfCredits'), kind: 'money' },
          { header: t('tips'), kind: 'money' },
          { header: t('export.cashTips'), kind: 'money' },
          { header: t('export.cardTips'), kind: 'money' },
          ...methodColumns,
          { header: t('openingCash'), kind: 'money' },
          { header: t('betweenShiftAdjustments'), kind: 'money' },
          { header: t('expectedCash'), kind: 'money' },
          { header: t('actualCash'), kind: 'money' },
          { header: t('discrepancy'), kind: 'money' },
          { header: t('export.cardLegs'), kind: 'number' },
          { header: t('export.transmittedLegs'), kind: 'number' },
          { header: t('export.untransmittedLegs'), kind: 'number' },
          { header: t('export.untransmittedAmount'), kind: 'money' },
        ],
        rows: sections.map((s) => [
          s.posNumber ?? null,
          latePartTitleOf(s) ?? s.machineName ?? s.machineId,
          s.shiftCount ?? null,
          ...rangeValues(s),
          s.transactionsCount ?? null,
          s.salesCount ?? null,
          s.creditNotesCount ?? null,
          s.nonSaleDocumentsCount ?? null,
          s.grossSales ?? null,
          s.discountsTotal ?? null,
          s.totalSales ?? null,
          s.totalRefunds ?? null,
          s.netSales ?? null,
          vat(s),
          s.totalTips ?? null,
          s.totalCashTips ?? null,
          s.totalCardTips ?? null,
          ...methods.map((m) => s.paymentBreakdown?.[m] ?? null),
          s.openingCash ?? null,
          s.betweenShiftAdjustments ?? null,
          s.expectedCash ?? null,
          // Null when any of the till's shifts is uncounted — never read as zero.
          s.countedCash ?? null,
          s.overShort ?? null,
          tx(s)?.cardLegs ?? null,
          tx(s)?.transmittedLegs ?? null,
          tx(s)?.untransmittedLegs ?? null,
          tx(s)?.untransmittedAmount ?? null,
        ]),
        // The Z's own figures, as the server summed them.
        totals: [
          tc('total'),
          null,
          z.shiftCount ?? z.shifts.length,
          ...rangeColumns.map(() => null),
          z.transactionsCount ?? null,
          sum(sections.map((s) => s.salesCount)),
          sum(sections.map((s) => s.creditNotesCount)),
          sum(sections.map((s) => s.nonSaleDocumentsCount)),
          z.grossSales ?? null,
          z.discountsTotal ?? null,
          z.totalSales ?? null,
          z.totalRefunds ?? null,
          z.netSales ?? null,
          vat(z),
          z.totalTips ?? null,
          z.totalCashTips ?? null,
          z.totalCardTips ?? null,
          ...methods.map((m) => z.paymentBreakdown?.[m] ?? null),
          z.openingCash ?? null,
          z.betweenShiftAdjustments ?? null,
          z.expectedCash ?? null,
          z.actualCash ?? null,
          z.discrepancy ?? null,
          sections.some(tx) ? sum(sections.map((s) => tx(s)?.cardLegs)) : null,
          sections.some(tx) ? sum(sections.map((s) => tx(s)?.transmittedLegs)) : null,
          sections.some(tx) ? sum(sections.map((s) => tx(s)?.untransmittedLegs)) : null,
          sections.some(tx) ? sum(sections.map((s) => tx(s)?.untransmittedAmount)) : null,
        ],
      });
    }

    // ── Card brands ──────────────────────────────────────────────────────────
    const cards = z.cardBrands ?? [];
    if (cards.length > 0) {
      sheets.push({
        name: tcb('zTitle'),
        columns: [
          { header: tcb('col.brand'), width: 16 },
          { header: tcb('col.acquirer'), width: 16 },
          { header: t('export.salesCount'), kind: 'number' },
          { header: tcb('col.sales'), kind: 'money' },
          { header: t('export.refundsCount'), kind: 'number' },
          { header: tcb('col.refunds'), kind: 'money' },
          { header: tcb('col.net'), kind: 'money' },
        ],
        rows: cards.map((r) => [
          brands.brand(r.brand),
          brands.acquirer(r.acquirer),
          r.salesCount,
          r.salesAmount,
          r.refundsCount,
          r.refundsAmount,
          r.net,
        ]),
        totals: [
          tc('total'),
          null,
          sum(cards.map((r) => r.salesCount)),
          sum(cards.map((r) => r.salesAmount)),
          sum(cards.map((r) => r.refundsCount)),
          sum(cards.map((r) => r.refundsAmount)),
          sum(cards.map((r) => r.net)),
        ],
      });
    }

    // ── Waiters ──────────────────────────────────────────────────────────────
    const waiters = z.byWaiter ?? [];
    if (waiters.length > 0) {
      sheets.push({
        name: t('waiters.title'),
        columns: [
          { header: t('waiters.col.waiter'), width: 18 },
          { header: t('waiters.col.tables'), kind: 'number' },
          { header: t('export.guests'), kind: 'number' },
          { header: t('export.salesCount'), kind: 'number' },
          { header: t('waiters.col.sales'), kind: 'money' },
          { header: t('export.refundsCount'), kind: 'number' },
          { header: t('waiters.col.refunds'), kind: 'money' },
          { header: t('waiters.col.net'), kind: 'money' },
          { header: t('waiters.col.cash'), kind: 'money' },
          { header: t('waiters.col.card'), kind: 'money' },
          { header: t('waiters.col.productionVoucher'), kind: 'money' },
          { header: t('export.other'), kind: 'money' },
          { header: t('waiters.col.tips'), kind: 'money' },
        ],
        rows: waiters.map((r) => [
          r.waiter || t('waiters.none'),
          r.tables,
          r.guests,
          r.salesCount,
          r.sales,
          r.refundsCount,
          r.refunds,
          r.net,
          r.cash,
          r.card,
          r.productionVoucher ?? '0.00',
          r.other,
          r.tips,
        ]),
        totals: [
          tc('total'),
          sum(waiters.map((r) => r.tables)),
          sum(waiters.map((r) => r.guests)),
          sum(waiters.map((r) => r.salesCount)),
          sum(waiters.map((r) => r.sales)),
          sum(waiters.map((r) => r.refundsCount)),
          sum(waiters.map((r) => r.refunds)),
          sum(waiters.map((r) => r.net)),
          sum(waiters.map((r) => r.cash)),
          sum(waiters.map((r) => r.card)),
          sum(waiters.map((r) => r.productionVoucher ?? '0.00')),
          sum(waiters.map((r) => r.other)),
          sum(waiters.map((r) => r.tips)),
        ],
      });
    }

    // ── Shifts ───────────────────────────────────────────────────────────────
    if (z.shifts.length > 0) {
      const tillOf = (machineId: string, machineName?: string | null) => {
        const s = sections.find((x) => x.machineId === machineId && !latePartTitleOf(x));
        return s ? tillText(s) : (machineName ?? machineId);
      };
      sheets.push({
        name: ts('title'),
        columns: [
          { header: ts('col.till'), width: 20 },
          { header: ts('col.shift'), width: 12 },
          { header: ts('col.businessDate'), kind: 'date' },
          { header: ts('col.opened'), kind: 'datetime' },
          { header: ts('detail.openedBy'), width: 14 },
          { header: ts('col.closed'), kind: 'datetime' },
          { header: ts('detail.closedBy'), width: 14 },
          { header: ts('col.sales'), kind: 'money' },
          { header: ts('col.expected'), kind: 'money' },
          { header: ts('col.counted'), kind: 'money' },
          { header: ts('col.overShort'), kind: 'money' },
        ],
        rows: z.shifts.map((s) => [
          tillOf(s.machineId, s.machineName),
          shiftLabel(s),
          s.businessDate,
          s.openedAt,
          s.openedByName ?? null,
          s.closedAt ?? null,
          s.unattended ? ts('closedRemotely') : (s.closedByName ?? null),
          s.serverTotals?.totalSales ?? null,
          s.expectedCash ?? null,
          s.countedCash ?? null,
          s.discrepancy ?? null,
        ]),
      });
    }

    // ── Failed payment attempts of the Z (information only) ─────────────────
    try {
      const failed = await failedSheets({ zReportId: z.id });
      sheets.push(...failed.filter((s) => s.rows.length > 0));
    } catch {
      // Information only: the Z's own sheets still go out.
    }

    return sheets;
  };
}
