'use client';

/** "קופה עצמאית" beside a till's Z mode: its own Z, outside the shop Z and its main till. */

import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

export function IndependentTillBadge({
  machine,
  className,
}: {
  machine: { independentTill?: boolean | null };
  className?: string;
}) {
  const t = useTranslations('independentTill.machine');
  if (!machine.independentTill) return null;
  return (
    <Badge variant="secondary" className={cn('shrink-0', className)} title={t('hint')}>
      {t('badge')}
    </Badge>
  );
}
