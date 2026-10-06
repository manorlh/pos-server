'use client';

/**
 * The product form's "תיאור הפריט" and "סימוני תזונה" (lib/productDietary.ts, pos-server
 * docs/SPEC_PRODUCT_DIETARY.md). Both are fields of the product, saved with the form's own
 * "שמור" — on a new product too — and shown in the self-order kiosk (and, with the till
 * parameter "הצג סימוני תזונה בקופה", on the till's sell screen).
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  DESCRIPTION_MAX,
  DESCRIPTION_RECOMMENDED,
  DIETARY_TAGS,
  descriptionLevel,
  dietaryConflict,
  normalizeDietaryTags,
  toggleDietaryTag,
  type DietaryToggle,
} from '@/lib/productDietary';
import type { Product } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Label } from '@/components/ui/label';
import { IosChip } from '@/components/dashboard/menu/ios';

type Patch = (patch: Partial<Product>) => void;

/** "תיאור הפריט": a textarea with a counter against the kiosk's recommended length. */
export function ProductDescriptionField({ product, onChange }: { product: Partial<Product>; onChange: Patch }) {
  const t = useTranslations('productDietary');
  const value = product.description ?? '';
  const level = descriptionLevel(value);
  return (
    <div className="space-y-1">
      <Label htmlFor="product-description">{t('descriptionLabel')}</Label>
      <textarea
        id="product-description"
        dir="auto"
        rows={3}
        maxLength={DESCRIPTION_MAX}
        placeholder={t('descriptionPlaceholder')}
        aria-invalid={level === 'over' || undefined}
        className="min-h-20 w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
        value={value}
        onChange={(e) => onChange({ description: e.target.value })}
      />
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="text-muted-foreground">{t('descriptionHint', { recommended: DESCRIPTION_RECOMMENDED })}</span>
        <span
          className={cn(
            'tabular-nums',
            level === 'ok' && 'text-muted-foreground',
            level === 'long' && 'text-[#FF9500]',
            level === 'over' && 'text-destructive',
          )}
          aria-live="polite"
        >
          {t('descriptionCounter', { count: value.length, recommended: DESCRIPTION_RECOMMENDED, max: DESCRIPTION_MAX })}
        </span>
      </div>
      {level === 'long' ? <p className="text-xs text-[#FF9500]">{t('descriptionLong')}</p> : null}
    </div>
  );
}

/** "סימוני תזונה": toggle chips; a pick that clears or adds another chip says so. */
export function ProductDietarySection({ product, onChange }: { product: Partial<Product>; onChange: Patch }) {
  const t = useTranslations('productDietary');
  const tags = normalizeDietaryTags(product.dietaryTags);
  const [note, setNote] = useState<DietaryToggle | null>(null);
  // A stored pair that cannot go together (never saved by this form; the server refuses it).
  const conflict = dietaryConflict(product.dietaryTags ?? []);
  const names = (xs: readonly string[]) => xs.map((x) => t(`tags.${x}`)).join(', ');

  return (
    <div className="space-y-3 rounded-2xl border p-4">
      <div className="space-y-1">
        <h3 className="text-[15px] font-semibold">{t('title')}</h3>
        <p className="text-[12px] text-[#6D6D72]">{t('hint')}</p>
      </div>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('title')}>
        {DIETARY_TAGS.map((tag) => (
          <IosChip
            key={tag}
            tone={tag === 'spicy' ? 'red' : tag === 'meat' || tag === 'dairy' ? 'blue' : 'green'}
            on={tags.includes(tag)}
            onClick={() => {
              const result = toggleDietaryTag(tags, tag);
              setNote(result.added.length || result.cleared.length ? result : null);
              onChange({ dietaryTags: result.tags });
            }}
          >
            {t(`tags.${tag}`)}
          </IosChip>
        ))}
      </div>
      {note ? (
        <p className="rounded-lg bg-[#FF95001A] px-3 py-2 text-[12px]" role="status">
          {note.added.length ? t('noteAdded', { tags: names(note.added) }) : null}
          {note.added.length && note.cleared.length ? ' ' : null}
          {note.cleared.length ? t('noteCleared', { tags: names(note.cleared) }) : null}
        </p>
      ) : null}
      {conflict ? (
        <p className="text-[12px] text-destructive">{t('conflict', { a: t(`tags.${conflict[0]}`), b: t(`tags.${conflict[1]}`) })}</p>
      ) : null}
      <p className="text-[12px] text-[#6D6D72]">{t('rules')}</p>
    </div>
  );
}
