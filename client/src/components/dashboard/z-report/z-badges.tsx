'use client';

import { useTranslations } from 'next-intl';
import type { ZReport } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { formatDateTime } from '@/lib/format';
import { zTransmissionFailed } from '@/lib/offlineZ';
import { isShopZ } from '@/lib/zParticipation';
import { ZVerificationBadge } from '@/components/dashboard/z-report/z-verification-panel';

/**
 * What kind of Z this is, on its face: produced by the till itself (and whether nobody
 * was at it), built over a reconstructed (dead-till) shift, over an unattended close,
 * with documents that arrived after it was built, or a pre-shift Z issued by one till.
 * Never left implicit.
 */
export function ZBadges({ z }: { z: ZReport }) {
  const t = useTranslations('zReports');
  const ti = useTranslations('independentTill.zReport');
  const late = z.lateDocuments ?? 0;
  const fromTill = z.origin === 'till';
  return (
    <>
      {fromTill ? (
        <Badge variant="secondary" className="ms-2 text-[11px]" title={t('originTillHint')}>
          {t('originTill')}
        </Badge>
      ) : null}
      {/* "קופה עצמאית בתוך סניף": a Z of a till that is not part of the shop Z. */}
      {z.scope?.kind === 'independent_till' ? (
        <Badge variant="secondary" className="ms-2 text-[11px]" title={ti('independentBadgeHint')}>
          {ti('independentBadge')}
        </Badge>
      ) : null}
      {/* On a till Z, unattended means the till produced it for a dashboard request. */}
      {fromTill && z.unattended ? (
        <Badge variant="outline" className="ms-2 text-[11px]" title={t('producedRemotelyHint')}>
          {t('producedRemotely')}
        </Badge>
      ) : null}
      {z.totalsMismatch ? (
        <Badge variant="destructive" className="ms-2 text-[11px]" title={t('totalsMismatchNotice')}>
          {t('totalsMismatch')}
        </Badge>
      ) : null}
      {/* Produced by support from the cloud for a dead till (docs/SPEC_OFFLINE_TILL_Z.md §4.6). */}
      {z.producedBySupport ? (
        <Badge
          variant="destructive"
          className="ms-2 text-[11px]"
          title={t('producedBySupportHint', {
            by: z.producedBySupport.by ?? '—',
            reason: z.producedBySupport.reasonText ?? '—',
          })}
        >
          {t('producedBySupport')}
        </Badge>
      ) : null}
      {/* Late documents of a period support closed, in this Z's own section (§4.6.3). */}
      {z.lateFromEarlier && z.lateFromEarlier.length > 0 ? (
        <Badge
          variant="outline"
          className="ms-2 text-[11px]"
          title={z.lateFromEarlier
            .map((l) => `${l.label ?? ''}: ${t('lateFromEarlierHint', { count: l.documents, sales: l.totalSales ?? '—' })}`)
            .join(' · ')}
        >
          {t('lateFromEarlier')}
        </Badge>
      ) : null}
      {/* The first Z after a till's device was replaced (docs/SPEC_OFFLINE_TILL_Z.md §4.6.2). */}
      {z.devicesReplaced && z.devicesReplaced.length > 0 ? (
        <Badge
          variant="outline"
          className="ms-2 text-[11px]"
          title={z.devicesReplaced
            .map((d) => t('deviceReplacedHint', { till: d.posNumber ?? d.name ?? '—', at: d.at ? formatDateTime(d.at) : '—' }))
            .join(' · ')}
        >
          {t('deviceReplaced')}
        </Badge>
      ) : null}
      {/* Closed at the till with no connection to the cloud (docs/SPEC_OFFLINE_TILL_Z.md). */}
      {z.builtOffline ? (
        <Badge
          variant="outline"
          className="ms-2 text-[11px] border-amber-500 text-amber-700 dark:text-amber-300"
          title={
            // A shop Z produced on the main till has no till of its own to name.
            isShopZ(z)
              ? ti('builtOfflineShopHint', { at: formatDateTime(z.uploadedAt) })
              : t('builtOfflineHint', { at: formatDateTime(z.uploadedAt) })
          }
        >
          {t('builtOffline')}
        </Badge>
      ) : null}
      {/* A local shop Z is stored as printed: its check is its verification state, below. */}
      {z.offlineDiscrepancies && z.offlineDiscrepancies.length > 0 && !isShopZ(z) ? (
        <Badge variant="destructive" className="ms-2 text-[11px]" title={t('offlineGapHint')}>
          {t('offlineGap')}
        </Badge>
      ) : null}
      {/* Waiting for documents, a till that did not finish syncing, or (super admin) a mismatch. */}
      <ZVerificationBadge z={z} />
      {zTransmissionFailed(z.cardTransmission) ? (
        <Badge variant="destructive" className="ms-2 text-[11px]" title={t('transmissionFailedHint')}>
          {t('transmissionFailed')}
        </Badge>
      ) : null}
      {z.reconstructed ? (
        <Badge variant="outline" className="ms-2 text-[11px]" title={t('reconstructedHint')}>
          {t('reconstructed')}
        </Badge>
      ) : null}
      {z.unattended && !fromTill ? (
        <Badge variant="outline" className="ms-2 text-[11px]" title={t('unattendedHint')}>
          {t('unattended')}
        </Badge>
      ) : null}
      {late > 0 ? (
        <Badge variant="destructive" className="ms-2 text-[11px]" title={t('lateHint')}>
          {t('late', { count: late })}
        </Badge>
      ) : null}
      {z.legacy ? (
        <Badge variant="secondary" className="ms-2 text-[11px]" title={t('legacyHint')}>
          {t('legacy')}
        </Badge>
      ) : null}
    </>
  );
}
