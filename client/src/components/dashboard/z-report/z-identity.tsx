'use client';

/**
 * The branch code ("קוד סניף") on every Z and the till number on every till Z — a branch
 * may run two Z sequences (the shop Z and an independent till's), told apart by the till.
 * The rules are in lib/zIdentity.ts.
 */

import { useTranslations } from 'next-intl';
import { zIdentityLabel, type ZIdentitySource } from '@/lib/zIdentity';

/** "קוד סניף 12 · קופה 6 · Z מס׳ 1", as text (lists, exports). */
export function useZIdentityLabel() {
  const t = useTranslations('independentTill.identity');
  return (z: ZIdentitySource) => zIdentityLabel(z, (key, values) => t(key, values));
}

/** "קוד סניף 12", or nothing when the Z has none. */
export function BranchCode({ code, className }: { code?: string | null; className?: string }) {
  const t = useTranslations('independentTill.identity');
  const value = code?.trim();
  if (!value) return null;
  return <span className={className}>{t('branch', { code: value })}</span>;
}
