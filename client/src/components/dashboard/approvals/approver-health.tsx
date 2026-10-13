'use client';

/**
 * A user's phones as the push channel sees them — one dot by `tone` (green: delivering, yellow:
 * failing lately, red: no phone registered) with the details on hover / for screen readers.
 *
 * Kept as the ONE place that draws push health on the approvals pages, so another branch's
 * `PushHealthCell` (feat/pwa-push-required) can replace it at merge without touching the callers.
 */

import { useTranslations } from 'next-intl';
import type { ApproverHealth as Health } from '@/lib/approvals';
import { formatShortDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';

const TONE_CLASS: Record<Health['tone'], string> = {
  green: 'bg-emerald-500',
  yellow: 'bg-amber-500',
  red: 'bg-red-500',
};

export function ApproverHealth({ health, className }: { health: Health; className?: string }) {
  const t = useTranslations('approvals.receivers.health');
  const parts = [
    t(`tone.${health.tone}`),
    t('devices', { count: health.devices }),
    health.lastSuccessAt ? t('lastSuccess', { at: formatShortDateTime(health.lastSuccessAt) }) : null,
    health.lastFailureAt ? t('lastFailure', { at: formatShortDateTime(health.lastFailureAt) }) : null,
  ].filter(Boolean);
  const text = parts.join(' · ');
  return (
    <span className={cn('inline-flex shrink-0 items-center', className)} title={text}>
      <span className={cn('size-2.5 rounded-full', TONE_CLASS[health.tone])} aria-hidden />
      <span className="sr-only">{text}</span>
    </span>
  );
}
