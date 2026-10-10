'use client';

/**
 * "מחייב אישור מנהל במכירה" (lib/restrictedItems.ts, pos-server app/services/restricted_items.py)
 * in the catalog editors: the switch on the product and category forms, saved with the form's
 * own "שמור", and the lists' badge — the row's own flag, or one it inherits from a category above.
 */

import { useTranslations } from 'next-intl';
import { KeyRound } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';

/** The form's row: the switch, what it does, and — when a category above restricts it anyway — that. */
export function RestrictedSwitch({
  checked,
  onChange,
  hint,
  inheritedNote,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  hint: string;
  /** Shown when a category above restricts it already (the switch then adds nothing). */
  inheritedNote?: string | null;
  disabled?: boolean;
}) {
  const t = useTranslations('products');
  return (
    <div className="space-y-1 rounded-md border p-3">
      <div className="flex items-center justify-between gap-4">
        <div>
          <Label className="flex items-center gap-1.5">
            <KeyRound className="h-3.5 w-3.5" aria-hidden />
            {t('requiresManagerApproval')}
          </Label>
          <p className="text-xs text-muted-foreground">{hint}</p>
        </div>
        <Switch
          checked={checked}
          disabled={disabled}
          onCheckedChange={(c) => onChange(c)}
          aria-label={t('requiresManagerApproval')}
        />
      </div>
      {inheritedNote ? (
        <p className="text-xs text-[#FF9500]" role="status">{inheritedNote}</p>
      ) : null}
    </div>
  );
}

/** "באישור מנהל" beside a name; nothing when not restricted. */
export function RestrictedBadge({ state }: { state: 'own' | 'inherited' | null }) {
  const t = useTranslations('products');
  if (!state) return null;
  return (
    <Badge
      variant="outline"
      className="gap-1 border-[#FF9500]/60 text-[#B25E00] dark:text-[#FFB340]"
      title={state === 'own' ? t('restrictedBadgeTitle') : t('restrictedBadgeInheritedTitle')}
    >
      <KeyRound className="h-3 w-3" aria-hidden />
      {state === 'own' ? t('restrictedBadge') : t('restrictedBadgeInherited')}
    </Badge>
  );
}
