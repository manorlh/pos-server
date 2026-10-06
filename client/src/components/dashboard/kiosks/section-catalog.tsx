'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, ChevronLeft, Eye, EyeOff, Loader2, RotateCcw, Star, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { formatCurrency } from '@/lib/format';
import {
  KIOSK_LIMITS,
  categoryProductIds,
  kioskCatalogView,
  moveItem,
  toggleInList,
  type KioskCatalog,
  type MediaRef,
} from '@/lib/kioskConfig';
import type { KioskSourceProduct } from '@/lib/kioskApi';
import { useKioskEditor, useKioskField } from './editor-context';
import { FieldErrors, FieldShell, MediaInput, MoveButtons, SectionCard } from './fields';

function Thumb({ url, className }: { url: string | null | undefined; className?: string }) {
  if (!url) return <div className={cn('rounded-lg bg-muted', className)} />;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={url} alt="" className={cn('rounded-lg bg-muted object-cover', className)} />;
}

function FeaturedRow({ products }: { products: KioskSourceProduct[] }) {
  const t = useTranslations('kiosks.catalog');
  const tf = useTranslations('kiosks.fields');
  const f = useKioskField<string[]>('catalog.featuredProductIds');
  const ids = Array.isArray(f.value) ? f.value : [];
  const byId = new Map(products.map((p) => [p.id, p]));
  return (
    <FieldShell
      path="catalog.featuredProductIds"
      label={tf('catalog.featuredProductIds')}
      hint={t('featuredHint', { max: KIOSK_LIMITS.featuredMax })}
    >
      {ids.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('featuredEmpty')}</p>
      ) : (
        <ol className="flex flex-wrap gap-2">
          {ids.map((id, i) => {
            const p = byId.get(id);
            return (
              <li key={id} className="flex items-center gap-1.5 rounded-full border bg-card py-1 ps-1 pe-2 text-sm shadow-xs">
                <Thumb url={p?.imageUrl} className="h-7 w-7 rounded-full" />
                <span className="max-w-36 truncate">{p?.name ?? t('missingProduct')}</span>
                <MoveButtons index={i} count={ids.length} disabled={f.disabled} onMove={(d) => f.set(moveItem(ids, i, d))} />
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  aria-label={t('unfeature')}
                  disabled={f.disabled}
                  onClick={() => f.set(ids.filter((x) => x !== id))}
                >
                  <X />
                </Button>
              </li>
            );
          })}
        </ol>
      )}
    </FieldShell>
  );
}

export function CatalogSection() {
  const t = useTranslations('kiosks.catalog');
  const ts = useTranslations('kiosks.settings');
  const ed = useKioskEditor();
  const catalogField = useKioskField<KioskCatalog>('catalog');
  const cat = ed.draft.catalog;
  const [open, setOpen] = useState<string | null>(null);
  const disabled = !ed.canEdit;

  const view = useMemo(
    () =>
      ed.catalog
        ? kioskCatalogView(ed.catalog.categories, ed.catalog.products, { catalog: cat, general: ed.draft.general }, { includeHidden: true })
        : null,
    [cat, ed.catalog, ed.draft.general],
  );

  if (ed.catalogLoading) {
    return (
      <SectionCard title={t('title')}>
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> {t('loading')}
        </p>
      </SectionCard>
    );
  }
  if (!ed.catalog || !view) {
    return (
      <SectionCard title={t('title')} description={t('hint')} paths={['catalog']}>
        <p className="text-sm text-muted-foreground">{t('noSource')}</p>
      </SectionCard>
    );
  }

  const products = ed.catalog.products;
  const set = (key: keyof KioskCatalog, value: unknown) => ed.set(`catalog.${key}`, value);
  const categoryIds = view.categories.map((c) => c.category.id);
  const featuredFull = cat.featuredProductIds.length >= KIOSK_LIMITS.featuredMax;

  return (
    <div className="space-y-4">
      <SectionCard
        title={t('title')}
        description={
          <>
            {t('hint')}
            <span className="mt-1 block text-xs">{t('source', { name: ed.catalog.machineName })}</span>
          </>
        }
        paths={['catalog.categoryOrder', 'catalog.productOrder', 'catalog.hiddenCategories', 'catalog.hiddenProducts', 'catalog.categoryImages']}
        action={
          ed.canEdit && (cat.categoryOrder.length > 0 || Object.keys(cat.productOrder).length > 0) ? (
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={() => {
                set('categoryOrder', []);
                set('productOrder', {});
              }}
            >
              <RotateCcw /> {t('resetOrder')}
            </Button>
          ) : null
        }
      >
        <div className="flex flex-wrap gap-3 text-xs">
          {(['categoryOrder', 'productOrder', 'hiddenCategories', 'hiddenProducts', 'categoryImages'] as const).map((key) =>
            catalogField.overridden && JSON.stringify(cat[key]) !== JSON.stringify(ed.inherited.catalog[key]) ? (
              <Badge key={key} variant="secondary" className="bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200">
                {t(`changed.${key}`)}
              </Badge>
            ) : null,
          )}
        </div>
        <FieldErrors path="catalog" />
        <ol className="space-y-2">
          {view.categories.map((row, i) => {
            const c = row.category;
            const expanded = open === c.id;
            const kioskImage: MediaRef | undefined = cat.categoryImages[c.id];
            const imageUrl = kioskImage?.url ?? ed.categoryImageUrls[c.id];
            const ids = categoryProductIds(products, c.id, cat.productOrder);
            return (
              <li
                key={c.id}
                className={cn('rounded-2xl border bg-card transition-all duration-200', row.hidden && 'opacity-60', expanded && 'shadow-sm')}
              >
                <div className="flex items-center gap-2 p-2">
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-expanded={expanded}
                    aria-label={expanded ? t('hideProducts') : t('showProducts')}
                    onClick={() => setOpen(expanded ? null : c.id)}
                  >
                    {expanded ? <ChevronDown /> : <ChevronLeft />}
                  </Button>
                  <Thumb url={imageUrl} className="h-10 w-10" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium">{c.name}</span>
                      {row.hidden ? <Badge variant="outline">{t('hidden')}</Badge> : null}
                    </div>
                    <span className="text-xs text-muted-foreground">{t('products', { n: row.products.length })}</span>
                  </div>
                  <MoveButtons
                    index={i}
                    count={categoryIds.length}
                    disabled={disabled}
                    onMove={(d) => set('categoryOrder', moveItem(categoryIds, i, d))}
                  />
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    disabled={disabled}
                    aria-label={row.hidden ? t('show') : t('hide')}
                    title={row.hidden ? t('show') : t('hide')}
                    onClick={() => set('hiddenCategories', toggleInList(cat.hiddenCategories, c.id))}
                  >
                    {row.hidden ? <EyeOff /> : <Eye />}
                  </Button>
                </div>
                {expanded ? (
                  <div className="space-y-3 border-t p-3 animate-in fade-in slide-in-from-top-1 duration-200">
                    <div className="space-y-1">
                      <span className="text-sm font-medium">{t('categoryImage')}</span>
                      <MediaInput
                        value={kioskImage ?? null}
                        disabled={disabled}
                        thumbClassName="h-16 w-24"
                        onChange={(ref) => ed.set(`catalog.categoryImages.${c.id}`, ref ?? undefined)}
                      />
                      {!kioskImage && ed.categoryImageUrls[c.id] ? (
                        <p className="text-xs text-muted-foreground">{t('tillImage')}</p>
                      ) : null}
                    </div>
                    <ol className="divide-y rounded-xl border">
                      {row.products.map((p, j) => {
                        const featured = cat.featuredProductIds.includes(p.product.id);
                        return (
                          <li key={p.product.id} className={cn('flex items-center gap-2 px-2 py-1.5', p.hidden && 'opacity-60')}>
                            <Thumb url={p.product.imageUrl} className="h-9 w-9" />
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5">
                                <span className="truncate text-sm">{p.product.name}</span>
                                {p.soldOut ? <Badge variant="destructive">{t('soldOut')}</Badge> : null}
                                {p.hidden ? <Badge variant="outline">{t('hidden')}</Badge> : null}
                              </div>
                              <span className="text-xs text-muted-foreground tabular-nums">{formatCurrency(p.product.price)}</span>
                            </div>
                            <MoveButtons
                              index={j}
                              count={ids.length}
                              disabled={disabled}
                              onMove={(d) => set('productOrder', { ...cat.productOrder, [c.id]: moveItem(ids, j, d) })}
                            />
                            <Button
                              type="button"
                              size="icon-sm"
                              variant="ghost"
                              disabled={disabled || (!featured && featuredFull)}
                              aria-pressed={featured}
                              aria-label={featured ? t('unfeature') : t('feature')}
                              title={featured ? t('unfeature') : featuredFull ? t('featuredFull', { max: KIOSK_LIMITS.featuredMax }) : t('feature')}
                              onClick={() => set('featuredProductIds', toggleInList(cat.featuredProductIds, p.product.id))}
                            >
                              <Star className={cn(featured && 'fill-amber-400 text-amber-500')} />
                            </Button>
                            <Button
                              type="button"
                              size="icon-sm"
                              variant="ghost"
                              disabled={disabled}
                              aria-label={cat.hiddenProducts.includes(p.product.id) ? t('show') : t('hide')}
                              title={cat.hiddenProducts.includes(p.product.id) ? t('show') : t('hide')}
                              onClick={() => set('hiddenProducts', toggleInList(cat.hiddenProducts, p.product.id))}
                            >
                              {cat.hiddenProducts.includes(p.product.id) ? <EyeOff /> : <Eye />}
                            </Button>
                          </li>
                        );
                      })}
                    </ol>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>
        {view.categories.length === 0 ? <p className="text-sm text-muted-foreground">{ts('noProducts')}</p> : null}
      </SectionCard>

      <SectionCard title={t('featuredTitle')} paths={['catalog.featuredProductIds']}>
        <FeaturedRow products={products} />
      </SectionCard>
    </div>
  );
}
