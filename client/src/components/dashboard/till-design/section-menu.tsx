'use client';

/**
 * "סדר התפריט": the categories and the products of a till in scope, in the till's order until
 * one is moved ("לפי סידור הקופה" — `categoryOrder` / `productOrder` empty), dragged by their
 * handle (or moved with the arrows, from the keyboard), a category hidden from the bar (still
 * found by search), a product starred as a favourite (the bar's strip, at most 24), and the way
 * back to the till's order.
 */

import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Eye, EyeOff, GripVertical, RotateCcw, Star } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { FAVORITES_MAX, flatProductOrder, formatShekels, moveTo, orderCategories, orderProducts } from '@/lib/tillDesign';
import { useTillEditor } from './editor-context';
import { FieldErrors, MoveButtons, OverrideMark, SectionCard } from './fields';

interface DragState {
  from: number;
  over: number;
}

/**
 * A list ordered by dragging a row's handle (pointer events: mouse, pen and touch alike): a line
 * shows where the row lands, and the order is written on release.
 */
function DragList<T>({
  items,
  keyOf,
  render,
  onMove,
  disabled,
  label,
}: {
  items: T[];
  keyOf: (item: T) => string;
  render: (item: T, index: number, handle: ReactNode, dragging: boolean) => ReactNode;
  onMove: (from: number, to: number) => void;
  disabled?: boolean;
  label: string;
}) {
  const t = useTranslations('tillDesign.menu');
  const [drag, setDrag] = useState<DragState | null>(null);
  const listRef = useRef<HTMLOListElement>(null);

  const overIndex = (clientY: number): number => {
    const rows = Array.from(listRef.current?.children ?? []) as HTMLElement[];
    let over = rows.length - 1;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i].getBoundingClientRect();
      if (clientY < r.top + r.height / 2) {
        over = i;
        break;
      }
    }
    return Math.max(0, over);
  };

  const handle = (index: number) => (
    <span
      role="button"
      tabIndex={-1}
      aria-label={t('dragHandle')}
      title={t('dragHandle')}
      className={cn('flex h-8 w-6 shrink-0 touch-none items-center justify-center text-muted-foreground', disabled ? 'opacity-40' : 'cursor-grab active:cursor-grabbing')}
      onPointerDown={(e: ReactPointerEvent<HTMLSpanElement>) => {
        if (disabled) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        setDrag({ from: index, over: index });
      }}
      onPointerMove={(e) => {
        if (!drag) return;
        const over = overIndex(e.clientY);
        if (over !== drag.over) setDrag({ ...drag, over });
      }}
      onPointerUp={() => {
        if (drag && drag.over !== drag.from) onMove(drag.from, drag.over);
        setDrag(null);
      }}
      onPointerCancel={() => setDrag(null)}
    >
      <GripVertical className="h-4 w-4" />
    </span>
  );

  return (
    <ol ref={listRef} aria-label={label} className="divide-y rounded-lg border">
      {items.map((item, i) => {
        const dragging = !!drag && i === drag.from;
        // Where the row would land: a line above (moving up) or below (moving down) the target.
        const before = !!drag && drag.over === i && drag.over < drag.from;
        const after = !!drag && drag.over === i && drag.over > drag.from;
        return (
          <li
            key={keyOf(item)}
            className={cn(
              'flex items-center gap-2 px-2 py-1.5 text-sm',
              dragging && 'bg-primary/5',
              before && 'shadow-[inset_0_2px_0_0_var(--color-primary)]',
              after && 'shadow-[inset_0_-2px_0_0_var(--color-primary)]',
            )}
          >
            {render(item, i, handle(i), dragging)}
          </li>
        );
      })}
    </ol>
  );
}

export function MenuSection() {
  const t = useTranslations('tillDesign.menu');
  const ed = useTillEditor();
  const menu = ed.draft.menu;
  const favorites = ed.draft.bar.favorites ?? [];
  const catalog = ed.catalog;
  const categories = useMemo(() => (catalog ? orderCategories(catalog.categories, menu) : []), [catalog, menu]);
  const products = useMemo(() => (catalog ? orderProducts(catalog.products, menu) : []), [catalog, menu]);
  const [chosen, setChosen] = useState<string | null>(null);
  const current = categories.find((c) => c.id === chosen) ?? categories[0] ?? null;
  const own = current ? products.filter((p) => p.categoryId === current.id) : [];
  const hidden = new Set(menu.hiddenCategories ?? []);
  const auto = (menu.categoryOrder?.length ?? 0) === 0 && (menu.productOrder?.length ?? 0) === 0;

  const moveCategory = (from: number, to: number) => {
    ed.set('menu.categoryOrder', moveTo(categories, from, to).map((c) => c.id));
  };
  const moveProduct = (from: number, to: number) => {
    if (!catalog || !current) return;
    const moved = moveTo(own, from, to).map((p) => p.id);
    const flat = flatProductOrder(catalog.categories, catalog.products, menu);
    const rest = flat.filter((id) => !moved.includes(id));
    // The moved category's products go back where its first product stood.
    const firstAt = flat.findIndex((id) => moved.includes(id));
    const next = [...rest.slice(0, Math.max(0, firstAt)), ...moved, ...rest.slice(Math.max(0, firstAt))];
    ed.set('menu.productOrder', next);
  };
  const toggleHidden = (id: string) => {
    const list = menu.hiddenCategories ?? [];
    ed.set('menu.hiddenCategories', list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  };
  const toggleFavorite = (id: string) => {
    ed.set('bar.favorites', favorites.includes(id) ? favorites.filter((x) => x !== id) : [...favorites, id]);
  };
  const productName = (id: string) => catalog?.products.find((p) => p.id === id)?.name ?? t('unknownProduct');

  let body: ReactNode;
  if (ed.catalogLoading) {
    body = <Skeleton className="h-64 w-full rounded-lg" />;
  } else if (!catalog || catalog.products.length === 0) {
    body = <p className="rounded-lg border bg-muted/40 p-4 text-sm text-muted-foreground">{t('noCatalog')}</p>;
  } else {
    body = (
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h4 className="text-sm font-semibold">{t('categories')}</h4>
            <OverrideMark path="menu.categoryOrder" />
          </div>
          <DragList
            items={categories}
            keyOf={(c) => c.id}
            label={t('categories')}
            disabled={!ed.canEdit}
            onMove={moveCategory}
            render={(c, i, handle) => {
              const isHidden = hidden.has(c.id);
              const count = catalog.products.filter((p) => p.categoryId === c.id).length;
              return (
                <>
                  {handle}
                  <button
                    type="button"
                    onClick={() => setChosen(c.id)}
                    className={cn('flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-start', current?.id === c.id && 'bg-muted font-semibold')}
                  >
                    <span className={cn('truncate', isHidden && 'text-muted-foreground line-through')}>{c.name}</span>
                    <span className="text-xs text-muted-foreground">{t('productsCount', { n: count })}</span>
                    {isHidden ? <Badge variant="outline">{t('hidden')}</Badge> : null}
                  </button>
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    disabled={!ed.canEdit}
                    aria-label={isHidden ? t('show') : t('hide')}
                    title={isHidden ? t('show') : t('hide')}
                    onClick={() => toggleHidden(c.id)}
                  >
                    {isHidden ? <EyeOff /> : <Eye />}
                  </Button>
                  <MoveButtons index={i} count={categories.length} disabled={!ed.canEdit} onMove={(d) => moveCategory(i, i + d)} />
                </>
              );
            }}
          />
          <FieldErrors path="menu" />
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h4 className="text-sm font-semibold">{current ? t('productsOf', { name: current.name }) : t('products')}</h4>
            <OverrideMark path="menu.productOrder" />
          </div>
          {own.length === 0 ? (
            <p className="rounded-lg border p-3 text-sm text-muted-foreground">{t('noProducts')}</p>
          ) : (
            <DragList
              items={own}
              keyOf={(p) => p.id}
              label={t('products')}
              disabled={!ed.canEdit}
              onMove={moveProduct}
              render={(p, i, handle) => {
                const fav = favorites.includes(p.id);
                const full = !fav && favorites.length >= FAVORITES_MAX;
                return (
                  <>
                    {handle}
                    <span className={cn('min-w-0 flex-1 truncate', !p.available && 'text-muted-foreground')}>
                      {p.name}
                      {!p.available ? <span className="ms-1 text-xs">({t('soldOut')})</span> : null}
                    </span>
                    <span dir="ltr" className="text-xs tabular-nums text-muted-foreground">
                      {formatShekels(Math.round(p.price * 100))}
                    </span>
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost"
                      disabled={!ed.canEdit || full}
                      aria-pressed={fav}
                      aria-label={fav ? t('unfavorite') : t('favorite')}
                      title={full ? t('favoritesFull', { n: FAVORITES_MAX }) : fav ? t('unfavorite') : t('favorite')}
                      onClick={() => toggleFavorite(p.id)}
                      className={fav ? 'text-amber-600' : undefined}
                    >
                      <Star className={fav ? 'fill-current' : undefined} />
                    </Button>
                    <MoveButtons index={i} count={own.length} disabled={!ed.canEdit} onMove={(d) => moveProduct(i, i + d)} />
                  </>
                );
              }}
            />
          )}
        </div>
      </div>
    );
  }

  return (
    <SectionCard
      title={t('title')}
      description={catalog ? t('descriptionWith', { name: catalog.machineName }) : t('description')}
      paths={['menu', 'bar.favorites']}
      action={
        auto ? (
          <Badge variant="outline">{t('auto')}</Badge>
        ) : ed.canEdit ? (
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => {
              ed.set('menu.categoryOrder', []);
              ed.set('menu.productOrder', []);
            }}
          >
            <RotateCcw /> {t('backToTill')}
          </Button>
        ) : null
      }
    >
      {body}
      <div className="space-y-2 rounded-lg border p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm font-medium">{t('favoritesTitle', { n: favorites.length, max: FAVORITES_MAX })}</span>
          <OverrideMark path="bar.favorites" />
        </div>
        <p className="text-xs text-muted-foreground">{t('favoritesHint')}</p>
        {favorites.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('favoritesEmpty')}</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {favorites.map((id, i) => (
              <span key={id} className="inline-flex items-center gap-1 rounded-md border bg-muted/40 px-2 py-0.5 text-xs">
                {productName(id)}
                <MoveButtons index={i} count={favorites.length} disabled={!ed.canEdit} onMove={(d) => ed.set('bar.favorites', moveTo(favorites, i, i + d))} />
                <button
                  type="button"
                  disabled={!ed.canEdit}
                  className="text-muted-foreground hover:text-foreground"
                  aria-label={t('unfavorite')}
                  onClick={() => toggleFavorite(id)}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <FieldErrors path="bar.favorites" />
      </div>
    </SectionCard>
  );
}
