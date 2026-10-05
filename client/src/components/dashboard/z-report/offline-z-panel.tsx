'use client';

/**
 * On a till Z's page: "נסגר ללא חיבור" — when it was closed and uploaded, and every
 * figure where the till's paper differs from the cloud's own (each one also an
 * exception) — and the card transmission the till ran before the Z, as the terminal
 * answered. pos-server docs/SPEC_OFFLINE_TILL_Z.md.
 */

import { useTranslations } from 'next-intl';
import { AlertTriangle, CloudOff, CreditCard } from 'lucide-react';
import type { ZReportDetail } from '@/lib/types';
import { formatCurrency, formatDateTime } from '@/lib/format';
import { discrepancyValue, sortedDiscrepancies, zTransmissionFailed } from '@/lib/offlineZ';

export function OfflineZPanel({ z }: { z: ZReportDetail }) {
  const t = useTranslations('zReports');
  const gaps = sortedDiscrepancies(z.offlineDiscrepancies);
  const closedAt = typeof z.offlineReport?.closedAt === 'string' ? z.offlineReport.closedAt : z.closedAt;
  const card = z.cardTransmission;
  if (!z.builtOffline && !card) return null;
  const label = (key: string) => (t.has(`offlineKeys.${key}`) ? t(`offlineKeys.${key}`) : key);
  return (
    <div className="space-y-3">
      {z.builtOffline ? (
        <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950">
          <div className="flex gap-2 font-medium">
            <CloudOff className="h-4 w-4 shrink-0 mt-0.5" aria-hidden />
            {t('builtOfflineNotice', { closedAt: formatDateTime(closedAt), uploadedAt: formatDateTime(z.uploadedAt) })}
          </div>
          {gaps.length > 0 ? (
            <>
              <div className="flex gap-2 text-destructive">
                <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" aria-hidden />
                {t('offlineGapNotice')}
              </div>
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-muted-foreground">
                    <th className="text-start font-normal py-1">{t('offlineGapField')}</th>
                    <th className="text-end font-normal py-1">{t('offlineGapTill')}</th>
                    <th className="text-end font-normal py-1">{t('offlineGapCloud')}</th>
                  </tr>
                </thead>
                <tbody>
                  {gaps.map((g) => (
                    <tr key={g.key} className="border-t">
                      <td className="py-1">{label(g.key)}</td>
                      <td className="py-1 text-end tabular-nums">{discrepancyValue(g.till)}</td>
                      <td className="py-1 text-end tabular-nums">{discrepancyValue(g.cloud)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : (
            <div className="text-muted-foreground">{t('offlineNoGap')}</div>
          )}
        </div>
      ) : null}
      {card ? (
        <div
          className={
            zTransmissionFailed(card)
              ? 'space-y-1 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm'
              : 'space-y-1 rounded-md border bg-muted/40 p-3 text-sm'
          }
        >
          <div className="flex gap-2 font-medium">
            <CreditCard className="h-4 w-4 shrink-0 mt-0.5" aria-hidden />
            {card.outcome === 'success'
              ? t('cardTransmissionOk', { batch: card.batchNumber ?? '—' })
              : card.outcome === 'skipped'
                ? t('cardTransmissionNone')
                : t('cardTransmissionFailed')}
          </div>
          {(card.byBrand ?? []).map((b) => (
            <div key={b.brand} className="flex justify-between text-xs tabular-nums">
              <span>{b.brand}</span>
              <span>
                {b.count} · {formatCurrency(b.amount)}
              </span>
            </div>
          ))}
          {card.outcome === 'success' && card.transactionCount != null ? (
            <div className="flex justify-between text-xs font-medium tabular-nums">
              <span>{t('cardTransmissionTotal')}</span>
              <span>
                {card.transactionCount} · {formatCurrency(card.amount)}
              </span>
            </div>
          ) : null}
          {zTransmissionFailed(card) && (card.statusMessage || card.error) ? (
            <div className="text-xs">{t('cardTransmissionTerminal', { text: card.statusMessage ?? card.error ?? '' })}</div>
          ) : null}
          {card.confirmedFailure ? (
            <div className="text-xs">{t('cardTransmissionConfirmed', { name: card.confirmedByName ?? '—' })}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
