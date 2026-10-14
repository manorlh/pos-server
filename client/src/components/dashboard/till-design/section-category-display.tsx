'use client';

/**
 * "צבע ותמונה למחלקה" in "עיצוב קופה" (P:/specs/category-color-image.md §2): the three till parameters
 * `categoryColors` (off / chip / accent), `categoryImages` (off / bar / landing) and `categoryImageSize`
 * (s / m / l) at the level being edited — what it sets, what it inherits, and a preview of the bar with
 * the categories of the till in scope (their colours and pictures from the catalog). They are till
 * parameters, not part of the design's layer: saved here at once (`PUT /till-design/category-display`),
 * each change in the parameters' log, and the tills pull them with their parameters.
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { fetchCatalogCategoryLooks } from '@/lib/kioskApi';
import { resolveProductText } from '@/lib/productTileText';
import {
  CATEGORY_IMAGE_PX,
  CATEGORY_DISPLAY_KEYS,
  categoryDisplayCodes,
  changedCategoryDisplay,
  resolveCategoryDisplay,
  type CategoryDisplayKey,
} from '@/lib/categoryLook';
import { fetchCategoryDisplay, saveCategoryDisplay } from '@/lib/tillDesignApi';
import { TillCategoryCard, TillCategoryChip, type ChipCategory } from '@/components/dashboard/categories/category-chip-preview';
import { useTillEditor } from './editor-context';
import { SectionCard, Segmented } from './fields';
import { FitLabel, useTileFonts } from './preview-tile-text';

const INHERIT = '';
const PREVIEW_MAX = 6;

/** A few made-up categories for the preview when no till is in scope. */
const SAMPLE: ChipCategory[] = [
  { name: 'שתייה', color: '#2563EB' },
  { name: 'מנות', color: '#F97316' },
  { name: 'קינוחים', color: '#EC4899' },
  { name: 'סלטים', color: '#22C55E' },
];

export function CategoryDisplayCard() {
  const t = useTranslations('tillDesign.categoryDisplay');
  const ed = useTillEditor();
  const qc = useQueryClient();
  const key = ['till-design-category-display', ed.level, ed.targetId];
  const view = useQuery({ queryKey: key, queryFn: () => fetchCategoryDisplay(ed.level, ed.targetId), retry: false });
  const looks = useQuery({ queryKey: ['kiosk-category-looks'], queryFn: fetchCatalogCategoryLooks, staleTime: 5 * 60_000, retry: false });
  const [edits, setEdits] = useState<Partial<Record<CategoryDisplayKey, string>>>({});

  const data = view.data;
  const own = useMemo(() => data?.own ?? {}, [data]);
  const values = useMemo(() => changedCategoryDisplay(own, edits), [own, edits]);
  const dirty = Object.keys(values).length > 0;
  const canEdit = !!data?.canEdit && ed.canEdit;

  const save = useMutation({
    mutationFn: () => saveCategoryDisplay(ed.level, ed.targetId, values),
    onSuccess: (next) => {
      qc.setQueryData(key, next);
      setEdits({});
      toast.success(t('saved'));
    },
    onError: (err) => toast.error(axiosErrorToToastMessage(err, t('saveFailed'))),
  });

  /** The level's choice for a key: '' = inherit. */
  const chosen = (k: CategoryDisplayKey): string => (k in edits ? (edits[k] ?? INHERIT) : (own[k] ?? INHERIT));
  const effective = resolveCategoryDisplay(
    Object.fromEntries(CATEGORY_DISPLAY_KEYS.map((k) => [k, chosen(k) || data?.inherited?.[k]])),
  );

  // The landing's names follow "שם הפריט על הכפתור" (the design's `look` over the till parameters).
  useTileFonts();
  const productText = resolveProductText(ed.draft.look, ed.legacy?.productText ?? null);

  const categories: ChipCategory[] = useMemo(() => {
    const list = ed.catalog?.categories ?? [];
    if (list.length === 0) return SAMPLE;
    return list.slice(0, PREVIEW_MAX).map((c) => ({
      name: c.name,
      color: looks.data?.colors[c.id] ?? null,
      imageUrl: looks.data?.images[c.id] ?? null,
    }));
  }, [ed.catalog, looks.data]);

  return (
    <SectionCard
      title={t('title')}
      description={t('description')}
      action={
        canEdit ? (
          <Button type="button" size="xs" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? t('saving') : t('save')}
          </Button>
        ) : null
      }
    >
      {view.isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : !data ? (
        <p className="text-sm text-destructive">{t('loadError')}</p>
      ) : (
        <div className="space-y-4">
          {data.parameters.map((p) => {
            const label = (code: string) => p.enumLabels?.[code] ?? code;
            const inherited = data.inherited?.[p.key] ?? p.defaultValue ?? '';
            const isOwn = chosen(p.key) !== INHERIT;
            const codes = categoryDisplayCodes(p.key);
            return (
              <div key={p.key} className="space-y-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{t.has(`names.${p.key}`) ? t(`names.${p.key}`) : p.label}</span>
                  {isOwn ? (
                    <Badge variant="secondary" className="bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200">
                      {t('own')}
                    </Badge>
                  ) : (
                    <span className="text-[11px] text-muted-foreground">{t('inheritedValue', { value: label(String(inherited)) })}</span>
                  )}
                </div>
                <Segmented
                  value={chosen(p.key)}
                  disabled={!canEdit || save.isPending}
                  ariaLabel={p.label}
                  onChange={(v) => setEdits((m) => ({ ...m, [p.key]: v }))}
                  options={[
                    { value: INHERIT, label: t('inherit') },
                    ...codes.map((code) => ({ value: code, label: label(code) })),
                  ]}
                />
                {t.has(`hints.${p.key}`) ? <p className="text-xs text-muted-foreground">{t(`hints.${p.key}`)}</p> : null}
              </div>
            );
          })}

          <div className="space-y-2 rounded-xl border bg-muted/40 p-3">
            <span className="text-[11px] text-muted-foreground">{t('preview')}</span>
            {effective.categoryImages === 'landing' ? (
              <div className="flex flex-wrap gap-2">
                {categories.map((c, i) => (
                  <TillCategoryCard
                    key={`${c.name}-${i}`}
                    category={c}
                    size={effective.categoryImageSize}
                    label={<FitLabel text={c.name} width={CATEGORY_IMAGE_PX[effective.categoryImageSize].landing} size={12} settings={productText} />}
                  />
                ))}
              </div>
            ) : (
              <div className="flex gap-2 overflow-x-auto pb-1">
                {categories.map((c, i) => (
                  <TillCategoryChip key={`${c.name}-${i}`} category={c} display={effective} selected={i === 0} />
                ))}
              </div>
            )}
            {(ed.catalog?.categories ?? []).length === 0 ? <p className="text-xs text-muted-foreground">{t('sample')}</p> : null}
            <p className="text-xs text-muted-foreground">
              {t('colorsFrom')}{' '}
              <Link href="/dashboard/categories" className="font-medium text-primary underline-offset-4 hover:underline">
                {t('categoriesLink')}
              </Link>
            </p>
          </div>
          {!canEdit ? <p className="text-xs text-muted-foreground">{t('readOnly')}</p> : null}
        </div>
      )}
    </SectionCard>
  );
}
