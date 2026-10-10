'use client';

/**
 * "כפה סגירה (גם באמצע מכירה)" on a remote Z close (pos-server docs/SPEC_OFFLINE_TILL_Z.md
 * §9): the till parks an open basket as a held sale and closes; a card charge in flight
 * is waited out, never interrupted. Ticking it asks first, saying exactly that.
 */

import { useTranslations } from 'next-intl';

export function ForceCloseOption({
  checked,
  onChange,
  disabled,
  className,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  className?: string;
}) {
  const t = useTranslations('forceClose');
  return (
    <label className={`flex items-start gap-2 text-sm ${className ?? ''}`}>
      <input
        type="checkbox"
        className="mt-0.5 h-4 w-4 shrink-0"
        checked={checked}
        disabled={disabled}
        onChange={(e) => {
          if (e.target.checked && !window.confirm(t('confirm'))) return;
          onChange(e.target.checked);
        }}
      />
      <span>
        <span className="font-medium">{t('label')}</span>
        <span className="block text-muted-foreground text-xs">{t('hint')}</span>
      </span>
    </label>
  );
}
