'use client';

/**
 * A shift's X for the report export bar (P:\specs\reports-upgrade.md §5): the shift and its
 * figures in one row, the tenders, the offline-declined card sales and the till-vs-cloud
 * comparison when they disagree — each a table with keyed columns, so a reader (and the
 * company's default) chooses what goes out — and, as sheets of their own, the card
 * transmission's batches and the shift's failed payment attempts when there are any. Money
 * goes out as the server sent it (decimal strings), times as the ISO strings it sent.
 */

import { useTranslations } from 'next-intl';
import type { ExcelSheet, ExcelValue } from '@/lib/excelExport';
import type { Money, PeriodOffline, Shift } from '@/lib/types';

type OfflineDeclined = PeriodOffline['declined'][number];
import { usePeriodTransmissionSheet } from '@/components/dashboard/machines/card-transmission';
import { useFailedPaymentsSheets } from '@/components/dashboard/failed-payments/export-sheets';
import type { ReportColumn, ReportTableSpec } from '@/components/dashboard/report-framework';
import { usePaymentMethodLabel, useShiftLabel } from './shift-parts';

/** One line of the till-vs-cloud table, as the page shows it. */
export interface ShiftMismatchRow {
  key: string;
  label: string;
  till: unknown;
  cloud: unknown;
}

/** A figure as a number when it is one (money or a count), else as text. */
export function shiftFigure(value: unknown): ExcelValue {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : String(value);
}

export interface ShiftExport {
  tables: ReportTableSpec<unknown>[];
  /** The transmission's batches and the failed attempts: sheets of their own (fetched). */
  extraSheets: () => Promise<ExcelSheet[]>;
}

/** The X's tables. `mismatch`: the comparison's rows (shown on the page too), when they disagree. */
export function useShiftExportTables() {
  const t = useTranslations('shifts');
  const tz = useTranslations('zReports');
  const tr = useTranslations('transmission');
  const to = useTranslations('zReports.offline');
  const methodLabel = usePaymentMethodLabel();
  const shiftLabel = useShiftLabel();
  const transmissionSheet = usePeriodTransmissionSheet();
  const failedSheets = useFailedPaymentsSheets();

  return (shift: Shift, mismatch: ShiftMismatchRow[]): ShiftExport => {
    const totals = shift.serverTotals;
    const open = shift.status === 'open';
    const tx = shift.transmission ?? null;

    const summary: ReportTableSpec<Shift> = {
      id: 'main',
      title: t('detail.title', { shift: shiftLabel(shift) }),
      rows: [shift],
      rowKey: (s) => s.id,
      columns: [
        { key: 'shift', header: t('col.shift'), width: 12, required: true, value: (s) => shiftLabel(s) },
        { key: 'till', header: t('col.till'), width: 18, value: (s) => s.machineName ?? s.machineId },
        { key: 'shop', header: tz('shop'), width: 18, value: (s) => s.shopName ?? null },
        { key: 'area', header: t('col.area'), width: 14, value: (s) => s.areaName ?? null },
        { key: 'businessDate', header: t('col.businessDate'), kind: 'date', value: (s) => s.businessDate },
        { key: 'state', header: t('col.state'), width: 10, value: (s) => t(`status.${s.status}`) },
        { key: 'openedAt', header: t('detail.openedAt'), kind: 'datetime', value: (s) => s.openedAt },
        { key: 'openedBy', header: t('detail.openedBy'), width: 14, value: (s) => s.openedByName ?? null },
        { key: 'closedAt', header: t('detail.closedAt'), kind: 'datetime', value: (s) => (open ? null : (s.closedAt ?? null)) },
        {
          key: 'closedBy',
          header: t('detail.closedBy'),
          width: 14,
          value: (s) => (open ? null : s.unattended ? t('closedRemotely') : (s.closedByName ?? null)),
        },
        { key: 'closeAcceptedAt', header: t('detail.closeAcceptedAt'), kind: 'datetime', value: (s) => s.closeAcceptedAt ?? null },
        { key: 'firstDocument', header: tz('till.firstDocument'), width: 16, value: () => totals?.firstTransactionNumber ?? null },
        { key: 'lastDocument', header: tz('till.lastDocument'), width: 16, value: () => totals?.lastTransactionNumber ?? null },
        { key: 'documents', header: t('detail.documents'), kind: 'number', value: () => totals?.transactionsCount ?? null },
        { key: 'grossSales', header: t('detail.grossSales'), kind: 'money', value: () => totals?.grossSales ?? null },
        { key: 'discounts', header: t('detail.discounts'), kind: 'money', value: () => totals?.discountsTotal ?? null },
        { key: 'sales', header: t('detail.sales'), kind: 'money', value: () => totals?.totalSales ?? null },
        { key: 'refunds', header: t('detail.refunds'), kind: 'money', value: () => totals?.totalRefunds ?? null },
        { key: 'vat', header: t('detail.vat'), kind: 'money', value: () => totals?.vatTotal ?? null },
        { key: 'tips', header: t('detail.tips'), kind: 'money', value: () => totals?.totalTips ?? null },
        { key: 'cashTips', header: t('detail.cashTips'), kind: 'money', value: () => totals?.totalCashTips ?? null },
        { key: 'cardTips', header: tz('export.cardTips'), kind: 'money', value: () => totals?.totalCardTips ?? null },
        { key: 'openingCash', header: t('detail.openingCash'), kind: 'money', value: (s) => s.openingCash ?? null },
        { key: 'cashTaken', header: t('detail.cashTaken'), kind: 'money', value: () => totals?.totalCash ?? null },
        { key: 'expectedCash', header: t('detail.expectedCash'), kind: 'money', value: (s) => s.expectedCash ?? null },
        // Null = not counted: an empty cell, never a zero.
        { key: 'countedCash', header: t('detail.countedCash'), kind: 'money', value: (s) => (open ? null : (s.countedCash ?? null)) },
        { key: 'overShort', header: t('detail.overShort'), kind: 'money', value: (s) => (open ? null : (s.discrepancy ?? null)) },
        { key: 'cardLegs', header: tr('export.cardLegs'), kind: 'number', value: () => tx?.cardLegs ?? null },
        { key: 'transmittedLegs', header: tr('export.transmittedLegs'), kind: 'number', value: () => tx?.transmittedLegs ?? null },
        { key: 'untransmittedLegs', header: tr('export.untransmittedLegs'), kind: 'number', value: () => tx?.untransmittedLegs ?? null },
        { key: 'untransmittedAmount', header: tr('export.untransmittedAmount'), kind: 'money', value: () => tx?.untransmittedAmount ?? null },
        { key: 'zNumber', header: tz('zNumber'), kind: 'number', value: (s) => s.zNumber ?? null },
      ],
    };

    const tables: ReportTableSpec<unknown>[] = [summary as ReportTableSpec<unknown>];

    // Tender → amount, cash and card first, as the page lists them.
    const tenders = Object.entries(shift.paymentBreakdown ?? {}) as [string, Money][];
    if (tenders.length > 0) {
      const rank = (k: string) => (k === 'cash' ? 0 : k === 'card' ? 1 : 2);
      tenders.sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]));
      const payments: ReportTableSpec<[string, Money]> = {
        id: 'payments',
        title: t('detail.paymentsTitle'),
        rows: tenders,
        rowKey: ([m]) => m,
        columns: [
          { key: 'method', header: t('export.method'), width: 20, required: true, value: ([m]) => methodLabel(m) },
          { key: 'amount', header: t('export.amount'), kind: 'money', value: ([, amount]) => amount },
        ],
      };
      tables.push(payments as ReportTableSpec<unknown>);
    }

    const declined = shift.offline?.declined ?? [];
    if (declined.length > 0) {
      const declinedTable: ReportTableSpec<OfflineDeclined> = {
        id: 'declined',
        title: to('declinedTitle'),
        rows: declined,
        rowKey: (d, i) => `${d.terminalUid}-${i}`,
        totalsLabel: t('report.total'),
        columns: [
          { key: 'at', header: to('at'), kind: 'datetime', value: (d) => d.at ?? null },
          { key: 'document', header: to('document'), width: 16, value: (d) => d.documentNumber ?? null },
          { key: 'amount', header: to('amount'), kind: 'money', value: (d) => d.amount, total: shift.offline?.declinedAmount ?? null },
          { key: 'terminalUid', header: tr('untransmitted.col.terminalId'), width: 20, value: (d) => d.terminalUid },
        ],
      };
      tables.push(declinedTable as ReportTableSpec<unknown>);
    }

    if (mismatch.length > 0) tables.push(shiftMismatchTable(mismatch, t) as ReportTableSpec<unknown>);

    return {
      tables,
      extraSheets: async () => {
        const sheets: ExcelSheet[] = [];
        if (tx && tx.batches.length > 0) sheets.push(transmissionSheet(tx));
        try {
          const failed = await failedSheets({ shiftId: shift.id });
          sheets.push(...failed.filter((s) => s.rows.length > 0));
        } catch {
          // Information only: the X's own sheets still go out.
        }
        return sheets;
      },
    };
  };
}

/** The till's X against the cloud's figures, key by key (on the page and in the export). */
export function shiftMismatchTable(
  rows: ShiftMismatchRow[],
  t: (key: string) => string,
  display?: (value: unknown, key: string) => string,
): ReportTableSpec<ShiftMismatchRow> {
  const cell = (pick: (r: ShiftMismatchRow) => unknown) =>
    display ? (r: ShiftMismatchRow) => display(pick(r), r.key) : undefined;
  const columns: ReportColumn<ShiftMismatchRow>[] = [
    { key: 'key', header: t('detail.mismatchKey'), width: 18, required: true, value: (r) => r.label },
    { key: 'till', header: t('detail.mismatchTill'), kind: 'number', width: 14, value: (r) => shiftFigure(r.till), cell: cell((r) => r.till) },
    { key: 'cloud', header: t('detail.mismatchCloud'), kind: 'number', width: 14, value: (r) => shiftFigure(r.cloud), cell: cell((r) => r.cloud) },
  ];
  return {
    id: 'mismatch',
    title: t('detail.mismatchTitle'),
    rows,
    rowKey: (r) => r.key,
    columns,
  };
}
