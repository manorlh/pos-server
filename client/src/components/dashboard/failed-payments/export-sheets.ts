'use client';

/**
 * "עסקאות שלא הושלמו" as Excel sheets: every attempt the query matches (`GET /failed-payments`,
 * page after page — never just the page on screen) and the cancelled sales block of the
 * same query. Shared by the transactions page's list, a shift's X and a Z.
 * docs/SPEC_FAILED_PAYMENTS.md.
 */

import { useTranslations } from 'next-intl';
import { api } from '@/lib/api';
import { useCardBrandLabels } from '@/lib/cardBrands';
import type { ExcelSheet } from '@/lib/excelExport';
import { fetchAllPages } from '@/lib/fetchAllPages';
import {
  agorotToShekels,
  failedPaymentsParams,
  maskedCard,
  reasonText,
  summarize,
  type FailedPaymentsQuery,
  type FailedPaymentsResponse,
} from '@/lib/failedPayments';
import { useFailedPaymentLabels } from './parts';

/** The server's largest page (`PAGE_SIZE_MAX` in app/services/failed_payments.py). */
const EXPORT_PAGE_SIZE = 500;

export function useFailedPaymentsSheets() {
  const t = useTranslations('failedPayments');
  const labels = useFailedPaymentLabels();
  const brands = useCardBrandLabels();

  const till = (row: { posNumber?: string | null; machineName?: string | null }) =>
    [row.machineName, row.posNumber ? t('tillValue', { till: row.posNumber }) : null].filter(Boolean).join(' · ') ||
    null;

  /**
   * The attempts sheet (always) and the cancelled sales sheet (when there are any), for
   * [query] without its page — every row of it.
   */
  return async (query: Omit<FailedPaymentsQuery, 'page' | 'pageSize'>): Promise<ExcelSheet[]> => {
    let cancelled: FailedPaymentsResponse['cancelledSales'] | null = null;
    const items = await fetchAllPages(
      async (page, pageSize) => {
        const data: FailedPaymentsResponse = await api
          .get('/failed-payments', { params: failedPaymentsParams({ ...query, page, pageSize }) })
          .then((r) => r.data);
        cancelled ??= data.cancelledSales;
        return data;
      },
      { pageSize: EXPORT_PAGE_SIZE },
    );
    const summary = summarize(items);

    const sheets: ExcelSheet[] = [
      {
        name: t('title'),
        columns: [
          { header: t('col.time'), kind: 'datetime' },
          { header: t('export.shop'), width: 16 },
          { header: t('col.till'), width: 18 },
          { header: t('col.employee'), width: 16 },
          { header: t('col.amount'), kind: 'money' },
          { header: t('col.method'), width: 12 },
          { header: t('export.kind'), width: 14 },
          { header: t('col.outcome'), width: 20 },
          { header: t('export.reason'), width: 28 },
          { header: t('col.card'), width: 18 },
          { header: t('col.lines'), kind: 'number', width: 8 },
          { header: t('col.paidLater'), width: 20 },
          { header: t('export.paidLaterDocument'), width: 16 },
          { header: t('col.voided'), width: 16 },
        ],
        rows: items.map((a) => {
          const terminal = labels.terminal(a.terminalType);
          return [
            a.occurredAt,
            a.shopName ?? null,
            till(a),
            a.employeeName ?? a.posUserId ?? null,
            agorotToShekels(a.amountAgorot),
            labels.method(a.method),
            [
              a.kind === 'payout' ? t('payoutBadge') : a.kind === 'keyed' ? t('keyedBadge') : null,
              a.channel === 'kiosk' ? t('kioskBadge') : null,
            ]
              .filter(Boolean)
              .join(' · ') || null,
            labels.outcome(a.outcome),
            [reasonText(a), terminal ? `${terminal}${a.terminalId ? ` ${a.terminalId}` : ''}` : null]
              .filter(Boolean)
              .join(' · ') || null,
            [a.cardBrand ? brands.brand(a.cardBrand) : null, maskedCard(a.cardLast4)].filter(Boolean).join(' ') ||
              null,
            a.lineCount ?? null,
            a.paidByTransactionId || a.paidByMethod ? labels.paidLater(a.paidByMethod) : null,
            a.paidByTransactionNumber ?? null,
            a.transactionNumber ?? null,
          ];
        }),
        // As the page's "סה״כ": the failed sales; payouts to a card are counted apart.
        totals: [
          t('totalAmount'),
          null,
          null,
          `${t('attempts')}: ${summary.count}`,
          agorotToShekels(summary.totalAgorot),
          null,
          null,
          null,
          null,
          null,
          null,
          `${t('paidLaterCount')}: ${summary.paidLaterCount}`,
          null,
          null,
        ],
      },
    ];

    const block = cancelled as FailedPaymentsResponse['cancelledSales'] | null;
    if (block && block.count > 0) {
      sheets.push({
        name: t('cancelled.title'),
        heading:
          block.items.length < block.count
            ? [t('export.cancelledTruncated', { shown: block.items.length, count: block.count })]
            : undefined,
        columns: [
          { header: t('col.time'), kind: 'datetime' },
          { header: t('cancelled.number'), width: 16 },
          { header: t('col.till'), width: 18 },
          { header: t('cancelled.cashier'), width: 16 },
          { header: t('col.amount'), kind: 'money' },
        ],
        rows: block.items.map((tx) => [
          tx.createdAt,
          tx.documentNumber ?? tx.transactionNumber,
          till(tx),
          tx.cashierName ?? null,
          tx.totalAmount,
        ]),
        totals: [t('totalAmount'), null, null, null, agorotToShekels(block.totalAgorot)],
      });
    }
    return sheets;
  };
}
