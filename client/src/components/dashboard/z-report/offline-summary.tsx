'use client';

/**
 * Offline-approved card sales on a Z (and an X): what the terminal approved on its own
 * while the acquirer was out of reach, and how the later authorization run answered.
 *
 * A declined one is a document the shop issued and money it will not be paid, so it is
 * shown in red with the documents named. Nothing is shown when there was no offline
 * activity at all — nor for a Z built before the figures existed (they are null there,
 * never a zero the Z did not say).
 */

import { useTranslations } from 'next-intl';
import { AlertTriangle } from 'lucide-react';
import { formatCurrency, formatDateTime } from '@/lib/format';
import type { Money, PeriodOffline } from '@/lib/types';
import { cn } from '@/lib/utils';
import { RemoteCreditQuickButton } from '@/components/dashboard/remote-credit/remote-credit-actions';

export interface OfflineFigures {
  authorizationCount: number;
  approvedCount: number;
  declinedCount: number;
  declinedAmount: Money | null | undefined;
}

/** A section's block as figures, or null when there is nothing to show. */
export function offlineOf(block: PeriodOffline | null | undefined): OfflineFigures | null {
  if (!block) return null;
  const figures = {
    authorizationCount: block.authorizationCount ?? 0,
    approvedCount: block.approvedCount ?? 0,
    declinedCount: block.declinedCount ?? 0,
    declinedAmount: block.declinedAmount,
  };
  return hasOfflineActivity(figures) ? figures : null;
}

/** The Z's totals as figures, or null when there is nothing to show. */
export function offlineOfZ(z: {
  offlineAuthorizationCount?: number | null;
  offlineApprovedCount?: number | null;
  offlineDeclinedCount?: number | null;
  offlineDeclinedAmount?: Money | null;
}): OfflineFigures | null {
  if (z.offlineDeclinedCount == null) return null;
  const figures = {
    authorizationCount: z.offlineAuthorizationCount ?? 0,
    approvedCount: z.offlineApprovedCount ?? 0,
    declinedCount: z.offlineDeclinedCount ?? 0,
    declinedAmount: z.offlineDeclinedAmount,
  };
  return hasOfflineActivity(figures) ? figures : null;
}

function hasOfflineActivity(f: OfflineFigures): boolean {
  return f.authorizationCount > 0 || f.approvedCount > 0 || f.declinedCount > 0;
}

/** "עסקאות במצב לא מקוון שנדחו: N (₪X)", or "… N אושרו, 0 נדחו". */
export function useOfflineLine() {
  const t = useTranslations('zReports.offline');
  return (f: OfflineFigures) =>
    f.declinedCount > 0
      ? t('declined', { count: f.declinedCount, amount: formatCurrency(f.declinedAmount) })
      : t('allApproved', { approved: f.approvedCount });
}

/** The line on screen: red with a hint when anything was declined, quiet otherwise. */
export function OfflineNotice({ figures, className }: { figures: OfflineFigures; className?: string }) {
  const t = useTranslations('zReports.offline');
  const line = useOfflineLine();
  if (figures.declinedCount > 0) {
    return (
      <div
        className={cn(
          'flex gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive',
          className,
        )}
      >
        <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" aria-hidden />
        <div>
          <p className="font-medium">{line(figures)}</p>
          <p className="text-xs">{t('declinedHint')}</p>
        </div>
      </div>
    );
  }
  return <div className={cn('rounded-md border bg-muted/40 p-3 text-sm', className)}>{line(figures)}</div>;
}

/** A till's declined documents: number, time and amount. */
export function OfflineDeclinedList({ declined }: { declined: PeriodOffline['declined'] }) {
  const t = useTranslations('zReports.offline');
  if (declined.length === 0) return null;
  return (
    <div className="space-y-1 text-sm">
      <p className="text-destructive text-xs font-medium">{t('declinedTitle')}</p>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-muted-foreground border-b">
            <th className="py-1 text-start font-normal">{t('document')}</th>
            <th className="py-1 text-start font-normal">{t('at')}</th>
            <th className="py-1 text-end font-normal">{t('amount')}</th>
          </tr>
        </thead>
        <tbody>
          {declined.map((d) => (
            <tr key={`${d.transactionId}-${d.terminalUid}`} className="border-b last:border-0">
              <td className="py-1">
                <span className="font-mono" dir="ltr">
                  {d.documentNumber ?? d.transactionId.slice(0, 8)}
                </span>
                {/* A declined sale is still a tax document: credit it (docs/SPEC_REMOTE_CREDIT.md). */}
                <span className="ms-2 print:hidden">
                  <RemoteCreditQuickButton transactionId={d.transactionId} documentNumber={d.documentNumber} />
                </span>
              </td>
              <td className="py-1">{formatDateTime(d.at)}</td>
              <td className="py-1 text-end tabular-nums text-destructive">{formatCurrency(d.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
