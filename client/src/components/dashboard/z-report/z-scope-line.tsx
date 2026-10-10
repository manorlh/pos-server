'use client';

/**
 * What a Z includes ("קופה עצמאית בתוך סניף"): the server's sentence — "כולל: קופות 1–5;
 * קופה 6 עצמאית ואינה כלולה" — under the Z's title, or as a small muted line in a list.
 * Nothing on an older Z. A Z's number, once printed, is final: it is never renumbered.
 */

import { useTranslations } from 'next-intl';
import type { ZReport, ZReportDetail } from '@/lib/types';
import { asPrintedOf } from '@/lib/localShopZ';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';

/**
 * "נשמר כפי שהודפס בקופה הראשית" on a local shop Z: the main till's printed Z is the Z —
 * stored exactly as printed; the cloud never issues a corrective one.
 */
export function AsPrintedBadge({ z }: { z: ZReportDetail }) {
  const t = useTranslations('independentTill.zReport');
  const ti = useTranslations('independentTill');
  const stamp = asPrintedOf(z);
  if (!stamp) return null;
  const by = stamp.producedBy?.posNumber
    ? t('asPrintedBy', { till: ti('till', { n: stamp.producedBy.posNumber }) })
    : null;
  return (
    <Badge variant="outline" className="ms-2 text-[11px]" title={[t('asPrintedHint'), by].filter(Boolean).join(' · ')}>
      {stamp.note ?? t('asPrinted')}
    </Badge>
  );
}

export function ZScopeLine({
  z,
  compact = false,
  className,
}: {
  z: Pick<ZReport, 'scope'>;
  compact?: boolean;
  className?: string;
}) {
  const t = useTranslations('independentTill.zReport');
  const label = z.scope?.label?.trim() || null;
  if (!label) return null;
  if (compact) {
    return (
      <div
        className={cn('max-w-[22rem] truncate text-xs font-normal text-muted-foreground', className)}
        title={label}
      >
        {label}
      </div>
    );
  }
  return <p className={cn('text-sm text-muted-foreground', className)}>{t('includes', { label })}</p>;
}
