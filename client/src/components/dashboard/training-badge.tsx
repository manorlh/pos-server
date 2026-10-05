'use client';

/**
 * The dashboard's marks of a shop in "מצב הדרכה" (docs/SPEC_TRAINING_MODE.md §9): an
 * orange "הדרכה" tag beside the shop's name wherever it is listed, and an orange stripe
 * across the top of the shop's pages. Both render nothing for a shop that works for real.
 */

import { useTranslations } from 'next-intl';
import { GraduationCap } from 'lucide-react';
import type { TrainingTillRef } from '@/lib/trainingMode';
import { cn } from '@/lib/utils';

/** "קופה 3 · בר" — the till's number when it has one, its name otherwise. */
export function useTrainingTillLabel() {
  const t = useTranslations('trainingMode');
  return (till: Pick<TrainingTillRef, 'name' | 'posNumber'>) =>
    till.posNumber ? t('till', { n: till.posNumber, name: till.name ?? '' }) : till.name || '—';
}

export function TrainingBadge({
  shop,
  className,
}: {
  shop: { trainingMode?: boolean } | null | undefined;
  className?: string;
}) {
  const t = useTranslations('trainingMode');
  if (!shop?.trainingMode) return null;
  return (
    <span
      title={t('badgeHint')}
      className={cn(
        'inline-flex h-5 w-fit shrink-0 items-center gap-1 rounded-full bg-orange-500 px-2 text-xs font-medium whitespace-nowrap text-white',
        className,
      )}
    >
      <GraduationCap className="h-3 w-3" aria-hidden />
      {t('badge')}
    </span>
  );
}

export function TrainingStripe({
  shop,
  className,
}: {
  shop: { trainingMode?: boolean } | null | undefined;
  className?: string;
}) {
  const t = useTranslations('trainingMode');
  if (!shop?.trainingMode) return null;
  return (
    <div
      role="status"
      className={cn(
        'flex w-full items-center gap-2 rounded-md bg-orange-500 px-4 py-2 text-sm font-medium text-white shadow-sm',
        className,
      )}
    >
      <GraduationCap className="h-4 w-4 shrink-0" aria-hidden />
      <span>{t('stripe')}</span>
    </div>
  );
}
