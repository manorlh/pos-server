/**
 * "קיר כפתורים" (layout.catalog = wall — the wall template) on the web, as the Android kiosk's
 * layouts/KioskLayoutWall.kt: every dish a big button — its name and price, no picture — three across
 * on a portrait kiosk ("גודל מוצרים" makes them more or fewer), a strip of its category's colour along
 * its top; one tap adds it (layout.quickAdd), one with a choice to make opens the compact window
 * (itemView popover); ✓ on the button for a moment, the count in the basket on its corner. The
 * categories as chips with their emoji; one category at a time (catalog.oneCategory) or one wall.
 */

import { useRef } from 'react';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { contrastText } from '@/lib/kioskConfig';
import { kioskIcon } from '@/lib/kioskIcons';
import { layoutOf, wallColumns } from '@/lib/kioskLayout';
import { KioskSwap, itemEnter } from '@/components/dashboard/kiosks/preview-motion';
import { cardStyle, textSize, type PCategory, type PProduct, type PreviewModel } from '@/components/dashboard/kiosks/preview-screens';
import { categoryIconId } from './icons';
import { CategoryChips, PhaseFrame, useSectionSpy } from './frame';
import { Empty, SectionTitle, cartCounts, unitOf, useTapDish, widthDpOf } from './parts';

/** A category's colour on the wall: its icon's hue (else the brand colour). */
function tintOf(m: PreviewModel, cat: PCategory): string {
  const hue = kioskIcon(categoryIconId(m, cat))?.hue;
  return hue === undefined ? m.c.primary : `hsl(${hue} 62% ${m.c.dark ? 45 : 55}%)`;
}

export function WallCatalog({ m, activeCategory, onCategory }: { m: PreviewModel; activeCategory: string | null; onCategory: (id: string) => void }) {
  const one = m.cfg.catalog.oneCategory;
  const scrollerRef = useRef<HTMLDivElement>(null);
  const { spy, onScroll, jump } = useSectionSpy(m, scrollerRef);
  const current = m.categories.find((c) => c.id === activeCategory) ?? m.categories[0] ?? null;
  const lit = one ? current?.id ?? null : spy ?? current?.id ?? null;
  const cols = wallColumns(widthDpOf(m), layoutOf(m.cfg).productSize);
  const counts = cartCounts(m);
  const grid = (cat: PCategory, enter: boolean) => (
    <div className="grid gap-2.5" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
      {cat.products.map((p, i) => {
        const e = itemEnter(m.transitions, i, enter);
        return (
          <div key={p.id} data-product={p.id} className={cn('flex', e.className)} style={e.style}>
            <WallButton m={m} p={p} tint={tintOf(m, cat)} inCart={counts[p.id] ?? 0} />
          </div>
        );
      })}
    </div>
  );
  return (
    <PhaseFrame
      m={m}
      top={
        <CategoryChips
          m={m}
          lit={lit}
          onPick={(id) => {
            onCategory(id);
            m.onCategoryPicked?.(id);
            if (one) scrollerRef.current?.scrollTo({ top: 0 });
            else jump(id);
          }}
        />
      }
    >
      <div ref={scrollerRef} onScroll={one ? undefined : onScroll} className="relative min-h-0 flex-1 space-y-5 overflow-y-auto px-3 pb-4 pt-1 [scrollbar-width:none]">
        {m.categories.length === 0 ? (
          <Empty m={m}>{m.t('empty')}</Empty>
        ) : one && current ? (
          <KioskSwap
            id={current.id}
            fx={m.transitions.categorySwitch}
            ms={m.transitions.categoryMs}
            order={(id) => m.categories.findIndex((c) => c.id === id)}
            className="overflow-x-clip [overflow-clip-margin:12px]"
            render={(id) => {
              const cat = m.categories.find((c) => c.id === id);
              return cat ? (
                <section data-section={cat.id} className="space-y-2">
                  <SectionTitle m={m} title={cat.name} count={cat.products.length} />
                  {grid(cat, true)}
                </section>
              ) : null;
            }}
          />
        ) : (
          m.categories.map((cat, i) => (
            <section key={cat.id} data-section={cat.id} className="space-y-2">
              <SectionTitle m={m} title={cat.name} count={cat.products.length} />
              {grid(cat, i === 0)}
            </section>
          ))
        )}
      </div>
    </PhaseFrame>
  );
}

/** One button: the category's strip, the name (two lines kept — a row the same height), the price; one tap adds. */
function WallButton({ m, p, tint, inCart }: { m: PreviewModel; p: PProduct; tint: string; inCart: number }) {
  const tap = useTapDish(m);
  const u = unitOf(m);
  const added = m.justAddedId === p.id;
  const ink = added ? contrastText(m.c.accent) : m.c.text;
  return (
    <button
      type="button"
      data-dish={p.id}
      data-pic
      disabled={p.soldOut}
      onClick={(e) => tap(p, false, e.currentTarget.getBoundingClientRect())}
      className="relative flex w-full flex-col items-center justify-center overflow-hidden px-2 pb-3 pt-5 text-center transition-transform duration-150 active:scale-[0.97] disabled:opacity-45"
      style={{ ...cardStyle(m), minHeight: 96 * u, background: added ? m.c.accent : cardStyle(m).background, color: ink }}
    >
      <span className="absolute inset-x-0 top-0 h-1.5" style={{ background: tint }} />
      <span className="line-clamp-2 kt-15 font-bold leading-tight" style={{ minHeight: '2.5em', ...textSize(m, 'productName', 15) }}>
        {p.name}
      </span>
      <span className="mt-1 kt-15 font-extrabold tabular-nums" style={{ color: added ? ink : m.c.primary, ...textSize(m, 'productPrice', 15) }}>
        {p.soldOut ? m.t('soldOut') : m.money(p.price)}
      </span>
      {inCart > 0 && !added ? (
        <span className="absolute start-1.5 top-2.5 flex items-center justify-center rounded-full kt-11 font-bold" style={{ width: 22 * u, height: 22 * u, background: m.c.primary, color: contrastText(m.c.primary) }}>
          {inCart}
        </span>
      ) : null}
      {added ? <Check className="absolute end-1.5 top-2.5 h-5 w-5" /> : null}
    </button>
  );
}
