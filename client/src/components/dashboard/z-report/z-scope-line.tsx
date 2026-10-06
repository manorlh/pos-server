'use client';

/**
 * What a Z includes ("קופה עצמאית בתוך סניף"): the server's sentence — "כולל: קופות 1–5;
 * קופה 6 עצמאית ואינה כלולה" — under the Z's title, or as a small muted line in a list.
 * Nothing on an older Z. A Z's number, once printed, is final: it is never renumbered.
 */

import { useTranslations } from 'next-intl';
import type { ZReport } from '@/lib/types';
import { cn } from '@/lib/utils';

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
