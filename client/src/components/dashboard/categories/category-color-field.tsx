'use client';

/**
 * "צבע" in the category dialog (P:/specs/category-color-image.md §1): a ready palette, the browser's
 * picker and the hex itself, and "ללא צבע". The value is `#RRGGBB` or null (no colour: the till's
 * button looks as today).
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Check, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { CATEGORY_PALETTE, normalizeHex, readableTextOn } from '@/lib/categoryLook';

export function CategoryColorField({
  value,
  onChange,
  disabled = false,
}: {
  value: string | null | undefined;
  onChange: (color: string | null) => void;
  disabled?: boolean;
}) {
  const t = useTranslations('categories.look');
  const current = normalizeHex(value);
  const [text, setText] = useState(current ?? '');
  const [shown, setShown] = useState(current);
  // A colour picked elsewhere (a swatch, the picker, another category) shows in the field — but not
  // over what is being typed ("#256" on the way to "#2563EB" is already that colour).
  if (shown !== current) {
    setShown(current);
    if (normalizeHex(text) !== current) setText(current ?? '');
  }
  const invalid = text.trim() !== '' && normalizeHex(text) === null;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={t('palette')}>
        {CATEGORY_PALETTE.map((hex) => {
          const on = current === hex;
          return (
            <button
              key={hex}
              type="button"
              role="radio"
              aria-checked={on}
              aria-label={hex}
              title={hex}
              disabled={disabled}
              onClick={() => onChange(hex)}
              className={cn(
                'flex h-7 w-7 items-center justify-center rounded-md border transition-transform hover:scale-105 disabled:opacity-50',
                on && 'ring-2 ring-foreground ring-offset-2 ring-offset-background',
              )}
              style={{ backgroundColor: hex }}
            >
              {on ? <Check className="h-3.5 w-3.5" style={{ color: readableTextOn(hex) ?? undefined }} /> : null}
            </button>
          );
        })}
      </div>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={current ?? '#6366F1'}
          disabled={disabled}
          aria-label={t('pickColor')}
          onChange={(e) => onChange(normalizeHex(e.target.value))}
          className="h-9 w-9 shrink-0 cursor-pointer rounded border bg-transparent p-0.5"
        />
        <Input
          dir="ltr"
          className={cn('flex-1 font-mono', invalid && 'border-destructive')}
          value={text}
          disabled={disabled}
          placeholder={t('noColorPlaceholder')}
          aria-invalid={invalid}
          onChange={(e) => {
            const next = e.target.value;
            setText(next);
            if (next.trim() === '') onChange(null);
            else {
              const hex = normalizeHex(next);
              if (hex) onChange(hex);
            }
          }}
        />
        <Button type="button" variant="ghost" size="sm" disabled={disabled || current === null} onClick={() => onChange(null)}>
          <X className="h-3.5 w-3.5" /> {t('noColor')}
        </Button>
      </div>
      {invalid ? <p className="text-xs text-destructive">{t('invalidColor')}</p> : null}
    </div>
  );
}
