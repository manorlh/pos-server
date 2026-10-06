'use client';

/**
 * The branch code ("קוד סניף") on every Z, the till number on every till Z — a branch may
 * run two Z sequences (the shop Z and an independent till's), told apart by the till — and
 * a till Z's run ("רצף מ-06/10/2026"), since a till made independent starts again at Z 1.
 * The rules are in lib/zIdentity.ts.
 */

import { useTranslations } from 'next-intl';
import { useTenantTimeZone } from '@/lib/auth';
import { zIdentityLabel, zRunDate, type ZIdentitySource } from '@/lib/zIdentity';

/** "קוד סניף 12 · קופה 6 (עצמאית) · Z מס׳ 1 · רצף מ-06/10/2026", as text (lists, exports). */
export function useZIdentityLabel() {
  const t = useTranslations('independentTill.identity');
  const timeZone = useTenantTimeZone();
  return (z: ZIdentitySource) => zIdentityLabel(z, (key, values) => t(key, values), timeZone);
}

/** "קוד סניף 12", or nothing when the Z has none. */
export function BranchCode({ code, className }: { code?: string | null; className?: string }) {
  const t = useTranslations('independentTill.identity');
  const value = code?.trim();
  if (!value) return null;
  return <span className={className}>{t('branch', { code: value })}</span>;
}

/** "רצף מ-06/10/2026" on a till Z of a run with a start; nothing otherwise. */
export function ZRun({ z, className, prefix = '' }: { z: ZIdentitySource; className?: string; prefix?: string }) {
  const t = useTranslations('independentTill.identity');
  const timeZone = useTenantTimeZone();
  const date = zRunDate(z, timeZone);
  if (!date) return null;
  return (
    <span className={className}>
      {prefix}
      {t('run', { date })}
    </span>
  );
}
