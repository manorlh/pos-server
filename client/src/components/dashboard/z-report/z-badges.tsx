'use client';

import { useTranslations } from 'next-intl';
import type { ZReport } from '@/lib/types';
import { Badge } from '@/components/ui/badge';

/**
 * What kind of Z this is, on its face: built over a reconstructed (dead-till) shift,
 * over an unattended close, with documents that arrived after it was built, or a
 * pre-shift Z issued by one till. Never left implicit.
 */
export function ZBadges({ z }: { z: ZReport }) {
  const t = useTranslations('zReports');
  const late = z.lateDocuments ?? 0;
  return (
    <>
      {z.reconstructed ? (
        <Badge variant="outline" className="ms-2 text-[11px]" title={t('reconstructedHint')}>
          {t('reconstructed')}
        </Badge>
      ) : null}
      {z.unattended ? (
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
