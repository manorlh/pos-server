'use client';

import { useTranslations } from 'next-intl';
import type { ZReport } from '@/lib/types';
import { Badge } from '@/components/ui/badge';

/**
 * What kind of Z this is, on its face: produced by the till itself (and whether nobody
 * was at it), built over a reconstructed (dead-till) shift, over an unattended close,
 * with documents that arrived after it was built, or a pre-shift Z issued by one till.
 * Never left implicit.
 */
export function ZBadges({ z }: { z: ZReport }) {
  const t = useTranslations('zReports');
  const late = z.lateDocuments ?? 0;
  const fromTill = z.origin === 'till';
  return (
    <>
      {fromTill ? (
        <Badge variant="secondary" className="ms-2 text-[11px]" title={t('originTillHint')}>
          {t('originTill')}
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
