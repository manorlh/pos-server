'use client';

/**
 * A shift's X as Excel: the shift and its figures in one row, the tenders, the card
 * transmission's batches, the offline-declined card sales, the till-vs-cloud comparison
 * when they disagree, and the shift's failed payment attempts when there are any. Money
 * goes out as the server sent it (decimal strings), times as the ISO strings it sent.
 */

import { useTranslations } from 'next-intl';
import type { ExcelSheet, ExcelValue } from '@/lib/excelExport';
import type { Shift } from '@/lib/types';
import { usePeriodTransmissionSheet } from '@/components/dashboard/machines/card-transmission';
import { useFailedPaymentsSheets } from '@/components/dashboard/failed-payments/export-sheets';
import { usePaymentMethodLabel, useShiftLabel } from './shift-parts';

/** One line of the till-vs-cloud table, as the page shows it. */
export interface ShiftMismatchRow {
  label: string;
  till: unknown;
  cloud: unknown;
}

/** A figure as a number when it is one (money or a count), else as text. */
function figure(value: unknown): ExcelValue {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : String(value);
}

export function useShiftExportSheets() {
  const t = useTranslations('shifts');
  const tz = useTranslations('zReports');
  const tr = useTranslations('transmission');
  const to = useTranslations('zReports.offline');
  const methodLabel = usePaymentMethodLabel();
  const shiftLabel = useShiftLabel();
  const transmissionSheet = usePeriodTransmissionSheet();
  const failedSheets = useFailedPaymentsSheets();

  return async (shift: Shift, mismatch: ShiftMismatchRow[] = []): Promise<ExcelSheet[]> => {
    const totals = shift.serverTotals;
    const open = shift.status === 'open';
    const tx = shift.transmission ?? null;

    const sheets: ExcelSheet[] = [
      {
        name: t('detail.title', { shift: shiftLabel(shift) }),
        columns: [
          { header: t('col.shift'), width: 12 },
          { header: t('col.till'), width: 18 },
          { header: tz('shop'), width: 18 },
          { header: t('col.area'), width: 14 },
          { header: t('col.businessDate'), kind: 'date' },
          { header: t('col.state'), width: 10 },
          { header: t('detail.openedAt'), kind: 'datetime' },
          { header: t('detail.openedBy'), width: 14 },
          { header: t('detail.closedAt'), kind: 'datetime' },
          { header: t('detail.closedBy'), width: 14 },
          { header: t('detail.closeAcceptedAt'), kind: 'datetime' },
          { header: tz('till.firstDocument'), width: 16 },
          { header: tz('till.lastDocument'), width: 16 },
          { header: t('detail.documents'), kind: 'number' },
          { header: t('detail.grossSales'), kind: 'money' },
          { header: t('detail.discounts'), kind: 'money' },
          { header: t('detail.sales'), kind: 'money' },
          { header: t('detail.refunds'), kind: 'money' },
          { header: t('detail.vat'), kind: 'money' },
          { header: t('detail.tips'), kind: 'money' },
          { header: t('detail.cashTips'), kind: 'money' },
          { header: tz('export.cardTips'), kind: 'money' },
          { header: t('detail.openingCash'), kind: 'money' },
          { header: t('detail.cashTaken'), kind: 'money' },
          { header: t('detail.expectedCash'), kind: 'money' },
          { header: t('detail.countedCash'), kind: 'money' },
          { header: t('detail.overShort'), kind: 'money' },
          { header: tr('export.cardLegs'), kind: 'number' },
          { header: tr('export.transmittedLegs'), kind: 'number' },
          { header: tr('export.untransmittedLegs'), kind: 'number' },
          { header: tr('export.untransmittedAmount'), kind: 'money' },
          { header: tz('zNumber'), kind: 'number' },
        ],
        rows: [
          [
            shiftLabel(shift),
            shift.machineName ?? shift.machineId,
            shift.shopName ?? null,
            shift.areaName ?? null,
            shift.businessDate,
            t(`status.${shift.status}`),
            shift.openedAt,
            shift.openedByName ?? null,
            open ? null : (shift.closedAt ?? null),
            open ? null : shift.unattended ? t('closedRemotely') : (shift.closedByName ?? null),
            shift.closeAcceptedAt ?? null,
            totals?.firstTransactionNumber ?? null,
            totals?.lastTransactionNumber ?? null,
            totals?.transactionsCount ?? null,
            totals?.grossSales ?? null,
            totals?.discountsTotal ?? null,
            totals?.totalSales ?? null,
            totals?.totalRefunds ?? null,
            totals?.vatTotal ?? null,
            totals?.totalTips ?? null,
            totals?.totalCashTips ?? null,
            totals?.totalCardTips ?? null,
            shift.openingCash ?? null,
            totals?.totalCash ?? null,
            shift.expectedCash ?? null,
            // Null = not counted: an empty cell, never a zero.
            open ? null : (shift.countedCash ?? null),
            open ? null : (shift.discrepancy ?? null),
            tx?.cardLegs ?? null,
            tx?.transmittedLegs ?? null,
            tx?.untransmittedLegs ?? null,
            tx?.untransmittedAmount ?? null,
            shift.zNumber ?? null,
          ],
        ],
      },
    ];

    // Tender → amount, cash and card first, as the page lists them.
    const tenders = Object.entries(shift.paymentBreakdown ?? {});
    if (tenders.length > 0) {
      const rank = (k: string) => (k === 'cash' ? 0 : k === 'card' ? 1 : 2);
      tenders.sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]));
      sheets.push({
        name: t('detail.paymentsTitle'),
        columns: [
          { header: t('export.method'), width: 20 },
          { header: t('export.amount'), kind: 'money' },
        ],
        rows: tenders.map(([method, amount]) => [methodLabel(method), amount]),
      });
    }

    if (tx && tx.batches.length > 0) sheets.push(transmissionSheet(tx));

    const declined = shift.offline?.declined ?? [];
    if (declined.length > 0) {
      sheets.push({
        name: to('declinedTitle'),
        columns: [
          { header: to('at'), kind: 'datetime' },
          { header: to('document'), width: 16 },
          { header: to('amount'), kind: 'money' },
          { header: tr('untransmitted.col.terminalId'), width: 20 },
        ],
        rows: declined.map((d) => [d.at ?? null, d.documentNumber ?? null, d.amount, d.terminalUid]),
        totals: [null, null, shift.offline?.declinedAmount ?? null, null],
      });
    }

    if (mismatch.length > 0) {
      sheets.push({
        name: t('detail.mismatchTitle').slice(0, 31),
        columns: [
          { header: t('detail.mismatchKey'), width: 18 },
          { header: t('detail.mismatchTill'), kind: 'number', width: 14 },
          { header: t('detail.mismatchCloud'), kind: 'number', width: 14 },
        ],
        rows: mismatch.map((r) => [r.label, figure(r.till), figure(r.cloud)]),
      });
    }

    try {
      const failed = await failedSheets({ shiftId: shift.id });
      sheets.push(...failed.filter((s) => s.rows.length > 0));
    } catch {
      // Information only: the X's own sheets still go out.
    }
    return sheets;
  };
}
