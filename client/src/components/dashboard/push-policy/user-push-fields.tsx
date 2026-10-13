'use client';

/**
 * "התראות בנייד" on the dashboard users page (pwa-push-required §5, §6):
 *
 * * `PushHealthCell` — the list's column: active devices, the last success, green / yellow (no
 *   success for 7 days) / red (no device), and "חובה" / "תזכורת" when the user must have them;
 * * `UserPushRequiredField` — the user form's level: inherit / off / reminder / required, with
 *   what inheriting means for this user. Saved by the form (the page), never by the user for
 *   themselves.
 */

import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { formatShortDateTime } from '@/lib/format';
import type { HealthTone, PushHealth, PushMode } from '@/lib/pushPolicy';
import { fetchUserPushPolicy } from '@/lib/pushPolicyApi';
import { cn } from '@/lib/utils';
import { ModeSelect } from './policy-editor';

const DOT: Record<HealthTone, string> = {
  green: 'bg-emerald-500',
  yellow: 'bg-amber-400',
  red: 'bg-red-500',
};

export function PushHealthCell({ health }: { health: PushHealth | null | undefined }) {
  const t = useTranslations('pushGate.health');
  const tp = useTranslations('pushGate.policy');
  if (!health) return <span className="text-xs text-muted-foreground">—</span>;
  return (
    <div className="flex min-w-36 items-start gap-2" title={t(`tone.${health.tone}`)}>
      <span className={cn('mt-1 size-2.5 shrink-0 rounded-full', DOT[health.tone])} aria-hidden />
      <span className="min-w-0 text-xs leading-snug">
        <span className="flex flex-wrap items-center gap-1">
          <span className="font-medium">{t('devices', { n: health.devices })}</span>
          {health.required && health.required !== 'off' ? (
            <span
              className={cn(
                'rounded px-1 text-[11px] font-medium',
                health.required === 'required'
                  ? 'bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-100'
                  : 'bg-orange-100 text-orange-900 dark:bg-orange-950 dark:text-orange-100',
              )}
            >
              {tp(`modes.${health.required}`)}
            </span>
          ) : null}
        </span>
        <span className="block text-muted-foreground">
          {health.devices === 0
            ? t('tone.red')
            : health.lastSuccessAt
              ? t('lastSuccess', { at: formatShortDateTime(health.lastSuccessAt) })
              : t('never')}
        </span>
        <span className="sr-only">{t(`tone.${health.tone}`)}</span>
      </span>
    </div>
  );
}

export function UserPushRequiredField({
  userId,
  value,
  onChange,
  isSelf,
}: {
  userId: string;
  value: PushMode | null;
  onChange: (mode: PushMode | null) => void;
  isSelf: boolean;
}) {
  const t = useTranslations('pushGate.policy');
  const query = useQuery({
    queryKey: ['push-policy', 'user', userId],
    queryFn: () => fetchUserPushPolicy(userId),
    retry: false,
  });
  const inherited = query.data?.inherited ?? null;
  const effective = value ?? inherited?.required ?? null;
  const source = value ? 'user' : inherited?.source;
  return (
    <div className="space-y-1">
      <label htmlFor={`push-required-${userId}`} className="text-sm font-medium">
        {t('userField')}
      </label>
      <ModeSelect
        id={`push-required-${userId}`}
        value={value}
        inherited={inherited?.required ?? null}
        disabled={isSelf || query.isError}
        onChange={onChange}
      />
      {effective && source ? (
        <p className="text-xs text-muted-foreground">
          {t('userNow', { mode: t(`modes.${effective}`), source: t(`sources.${source}`) })}
          {' · '}
          {t(`modeHints.${effective}`)}
        </p>
      ) : null}
      {isSelf ? <p className="text-xs text-muted-foreground">{t('userSelfNote')}</p> : null}
    </div>
  );
}
