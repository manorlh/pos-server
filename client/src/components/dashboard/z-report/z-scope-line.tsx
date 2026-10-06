'use client';

/**
 * What a Z includes ("קופה עצמאית בתוך סניף"): the server's sentence — "כולל: קופות 1–5;
 * קופה 6 עצמאית ואינה כלולה" — under the Z's title, or as a small muted line in a list;
 * and, for a shop Z produced on the main till with no internet whose number changed on
 * upload, the number it was printed with. Nothing on an older Z.
 */

import { useTranslations } from 'next-intl';
import type { ZReport } from '@/lib/types';
import { cn } from '@/lib/utils';

export function ZScopeLine({
  z,
  compact = false,
  className,
}: {
  z: Pick<ZReport, 'scope' | 'renumberedFrom'>;
  compact?: boolean;
  className?: string;
}) {
  const t = useTranslations('independentTill.zReport');
  const label = z.scope?.label?.trim() || null;
  const renumbered = z.renumberedFrom != null ? t('renumbered', { from: z.renumberedFrom }) : null;
  if (!label && !renumbered) return null;
  if (compact) {
    return (
      <div className={cn('max-w-[22rem] space-y-0.5 text-xs font-normal text-muted-foreground', className)}>
        {label ? (
          <div className="truncate" title={label}>
            {label}
          </div>
        ) : null}
        {renumbered ? <div className="text-amber-700 dark:text-amber-400">{renumbered}</div> : null}
      </div>
    );
  }
  return (
    <div className={cn('space-y-0.5', className)}>
      {label ? <p className="text-sm text-muted-foreground">{t('includes', { label })}</p> : null}
      {renumbered ? <p className="text-xs text-amber-700 dark:text-amber-400">{renumbered}</p> : null}
    </div>
  );
}
