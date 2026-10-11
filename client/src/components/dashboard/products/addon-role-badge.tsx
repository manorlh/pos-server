'use client';

import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { addonRoleOf } from '@/lib/addonRole';

/** "תוספת" on the product list: nothing for a regular item; "תוספת בלבד" / "גם וגם" otherwise. */
export function AddonRoleBadge({ role }: { role: unknown }) {
  const t = useTranslations('products');
  const code = addonRoleOf(role);
  if (code === 'none') return null;
  return (
    <Badge
      variant="outline"
      className={code === 'addon_only' ? 'border-amber-500/50 text-amber-700 dark:text-amber-300' : 'border-emerald-500/50 text-emerald-700 dark:text-emerald-300'}
      title={t(`addonRoleHint.${code}`)}
    >
      {code === 'addon_only' ? t('addonRoleBadgeOnly') : t('addonRoleBadgeBoth')}
    </Badge>
  );
}
