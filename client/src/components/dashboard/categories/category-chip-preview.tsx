'use client';

/**
 * "תצוגה מקדימה": how a category's button looks on the till (P:/specs/category-color-image.md §1, §2) —
 * each way the till parameters can show it: `categoryColors` off (as today) / chip (the button filled
 * with the colour, its text white or black by `readableTextOn`) / accent (a stripe at the button's side
 * and under the heading), and `categoryImages` bar (a small picture in the button) / landing (a card on
 * the categories' page; no picture — the first letter on the colour). `size` is `categoryImageSize`.
 *
 * Also used by "עיצוב קופה"'s card (`mode`): one way only, for the categories of a till in scope.
 */

import type { CSSProperties, ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import {
  CATEGORY_IMAGE_PX,
  categoryInitial,
  normalizeHex,
  readableTextOn,
  type CategoryDisplay,
  type CategoryImageSize,
} from '@/lib/categoryLook';

export interface ChipCategory {
  name: string;
  color?: string | null;
  imageUrl?: string | null;
}

const NEUTRAL_BG = 'var(--muted)';
const NEUTRAL_FG = 'var(--foreground)';

function Picture({ url, size, radius, color, name }: { url?: string | null; size: number; radius: number; color: string | null; name: string }) {
  const box: CSSProperties = { width: size, height: size, borderRadius: radius };
  if (url) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={url} alt="" className="shrink-0 object-cover" style={box} draggable={false} />;
  }
  return (
    <span
      className="flex shrink-0 items-center justify-center font-bold"
      style={{ ...box, background: color ?? NEUTRAL_BG, color: (color && readableTextOn(color)) || NEUTRAL_FG, fontSize: size * 0.42 }}
    >
      {categoryInitial(name)}
    </span>
  );
}

/** One category button of the till's bar, as `display` draws it. */
export function TillCategoryChip({
  category,
  display,
  selected = false,
}: {
  category: ChipCategory;
  display: CategoryDisplay;
  selected?: boolean;
}) {
  const color = normalizeHex(category.color);
  const chip = display.categoryColors === 'chip' && color !== null;
  const accent = display.categoryColors === 'accent' && color !== null;
  const withImage = display.categoryImages === 'bar' && !!category.imageUrl;
  const px = CATEGORY_IMAGE_PX[display.categoryImageSize].bar;
  const style: CSSProperties = chip
    ? { background: color!, color: readableTextOn(color)!, borderColor: color! }
    : { background: selected ? 'var(--foreground)' : 'var(--background)', color: selected ? 'var(--background)' : NEUTRAL_FG };
  return (
    <span
      className={cn(
        'relative inline-flex h-10 shrink-0 items-center gap-1.5 overflow-hidden rounded-lg border px-3 text-sm font-semibold',
        chip && selected && 'ring-2 ring-foreground ring-offset-1 ring-offset-background',
      )}
      style={style}
    >
      {accent ? <span aria-hidden className="absolute inset-y-0 start-0 w-1.5" style={{ background: color! }} /> : null}
      {withImage ? <Picture url={category.imageUrl} size={px} radius={Math.round(px / 4)} color={color} name={category.name} /> : null}
      <span className="max-w-32 truncate">{category.name || '—'}</span>
    </span>
  );
}

/** One card of the categories' landing page ("עמוד פתיחה של מחלקות"). */
/**
 * A card of the categories' landing. `label`: the name as the till writes it ("עיצוב קופה" passes the
 * product tiles' text rules — the landing's names follow `productNameFit`); else cut to one line.
 */
export function TillCategoryCard({ category, size, label }: { category: ChipCategory; size: CategoryImageSize; label?: ReactNode }) {
  const color = normalizeHex(category.color);
  const px = CATEGORY_IMAGE_PX[size].landing;
  return (
    <span className="inline-flex shrink-0 flex-col items-center gap-1.5 rounded-xl border bg-background p-2" style={{ width: px + 16 }}>
      <Picture url={category.imageUrl} size={px} radius={12} color={color} name={category.name} />
      {label ?? <span className="w-full truncate text-center text-xs font-semibold">{category.name || '—'}</span>}
    </span>
  );
}

/** A heading of the till's order, under which a stripe of the colour runs (`accent`). */
function AccentHeading({ category }: { category: ChipCategory }) {
  const color = normalizeHex(category.color);
  return (
    <span className="inline-flex flex-col gap-1">
      <span className="text-sm font-bold">{category.name || '—'}</span>
      <span aria-hidden className="h-1 w-12 rounded-full" style={{ background: color ?? NEUTRAL_BG }} />
    </span>
  );
}

function Variant({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-1.5">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

/** The category dialog's preview: every way the till can show this category. */
export function CategoryChipPreview({ category, size = 'm' }: { category: ChipCategory; size?: CategoryImageSize }) {
  const t = useTranslations('categories.look.preview');
  const color = normalizeHex(category.color);
  const base: CategoryDisplay = { categoryColors: 'off', categoryImages: 'off', categoryImageSize: size };
  return (
    <div className="space-y-3 rounded-xl border bg-muted/40 p-3">
      <div className="flex flex-wrap items-end gap-3">
        <Variant label={t('off')}>
          <TillCategoryChip category={category} display={base} />
        </Variant>
        <Variant label={t('chip')}>
          <TillCategoryChip category={category} display={{ ...base, categoryColors: 'chip' }} selected />
        </Variant>
        <Variant label={t('accent')}>
          <span className="flex items-end gap-3">
            <TillCategoryChip category={category} display={{ ...base, categoryColors: 'accent' }} />
            <AccentHeading category={category} />
          </span>
        </Variant>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <Variant label={t('bar')}>
          <TillCategoryChip category={category} display={{ ...base, categoryColors: 'chip', categoryImages: 'bar' }} />
        </Variant>
        <Variant label={t('landing')}>
          <TillCategoryCard category={category} size={size} />
        </Variant>
      </div>
      {color === null ? <p className="text-xs text-muted-foreground">{t('noColor')}</p> : null}
      {!category.imageUrl ? <p className="text-xs text-muted-foreground">{t('noImage')}</p> : null}
      <p className="text-xs text-muted-foreground">{t('params')}</p>
    </div>
  );
}
