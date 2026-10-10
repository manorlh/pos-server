/**
 * "מגזין" (layout.catalog = magazine — the magazine template) on the web, as the Android kiosk's
 * layouts/KioskLayoutMagazine.kt: dish after dish, each a page — a big picture over its name, its
 * description and its price with "הוספה" — most of the screen tall so the next one peeks; the scroll
 * stops on a dish (snap). layout.magazineFeed: every category in one feed the chips follow (each page
 * says its category); off — one category at a time, the chips switching it.
 */

import { useLayoutEffect, useRef, useState } from 'react';
import { Check, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { layoutOf, storyHeightDp } from '@/lib/kioskLayout';
import { KioskSwap } from '@/components/dashboard/kiosks/preview-motion';
import { DietaryChips, ProductImage, cardStyle, textSize, type PProduct, type PreviewModel } from '@/components/dashboard/kiosks/preview-screens';
import { CategoryChips, PhaseFrame, useSectionSpy } from './frame';
import { DP_PER_PX, Empty, cartCounts, kt, unitOf, useTapDish } from './parts';

export function MagazineCatalog({ m, activeCategory, onCategory }: { m: PreviewModel; activeCategory: string | null; onCategory: (id: string) => void }) {
  const layout = layoutOf(m.cfg);
  const feed = layout.magazineFeed;
  const scrollerRef = useRef<HTMLDivElement>(null);
  const { spy, onScroll, jump } = useSectionSpy(m, scrollerRef);
  // The page's height: a share of the feed's own height (measured once and on a resize).
  const [viewPx, setViewPx] = useState(0);
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const measure = () => setViewPx(el.clientHeight);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const pageH = viewPx > 0 ? storyHeightDp(Math.round(viewPx * DP_PER_PX), layout.productSize) / DP_PER_PX : 360;
  const counts = cartCounts(m);
  const current = m.categories.find((c) => c.id === activeCategory) ?? m.categories[0] ?? null;
  const lit = feed ? spy ?? current?.id ?? null : current?.id ?? null;
  const page = (p: PProduct, label: string | null) => <StoryPage key={p.id} m={m} p={p} label={label} height={pageH} inCart={counts[p.id] ?? 0} />;
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
            if (feed) jump(id);
            else scrollerRef.current?.scrollTo({ top: 0 });
          }}
        />
      }
    >
      <div
        ref={scrollerRef}
        onScroll={feed ? onScroll : undefined}
        className="relative min-h-0 flex-1 snap-y snap-mandatory space-y-3 overflow-y-auto px-3 pb-4 pt-1 [scrollbar-width:none]"
      >
        {m.categories.length === 0 ? (
          <Empty m={m}>{m.t('empty')}</Empty>
        ) : feed ? (
          m.categories.map((cat) => (
            // The section's mark for the chips; its pages carry its name.
            <section key={cat.id} data-section={cat.id} className="space-y-3">
              {cat.products.map((p) => page(p, cat.name))}
            </section>
          ))
        ) : current ? (
          <KioskSwap
            id={current.id}
            fx={m.transitions.categorySwitch}
            ms={m.transitions.categoryMs}
            ease={m.transitions.categoryEase}
            order={(id) => m.categories.findIndex((c) => c.id === id)}
            className="overflow-x-clip [overflow-clip-margin:12px]"
            render={(id) => {
              const cat = m.categories.find((c) => c.id === id);
              return cat ? <div className="space-y-3">{cat.products.map((p) => page(p, null))}</div> : null;
            }}
          />
        ) : null}
      </div>
    </PhaseFrame>
  );
}

/** One dish's page: the big picture, its category, name, description, the price and "הוספה". */
function StoryPage({ m, p, label, height, inCart }: { m: PreviewModel; p: PProduct; label: string | null; height: number; inCart: number }) {
  const tap = useTapDish(m);
  const u = unitOf(m);
  const added = m.justAddedId === p.id;
  const pic = (el: Element) => el.closest('[data-dish]')?.querySelector('[data-pic]')?.getBoundingClientRect() ?? null;
  return (
    <div
      role="button"
      tabIndex={0}
      data-dish={p.id}
      onClick={(e) => !p.soldOut && tap(p, false, pic(e.currentTarget))}
      className={cn('k-tap relative flex snap-start flex-col overflow-hidden text-start transition-transform duration-150 active:scale-[0.99]', p.soldOut && 'opacity-50')}
      style={{ ...cardStyle(m), height }}
    >
      <div data-pic className="relative min-h-0 flex-1">
        <ProductImage m={m} p={p} className="h-full w-full" />
        {p.soldOut ? <span className="absolute start-3 top-3 rounded-full bg-black/70 px-2.5 py-1 kt-11 font-bold text-white">{m.t('soldOut')}</span> : null}
        {inCart > 0 ? (
          <span className="absolute end-3 top-3 flex items-center justify-center rounded-full kt-15 font-bold" style={{ width: 34 * u, height: 34 * u, background: m.c.primary, color: m.c.buttonText }}>
            {inCart}
          </span>
        ) : null}
      </div>
      <div className="space-y-1 p-3.5">
        {label ? (
          <div className="truncate kt-11 font-bold" style={{ color: m.c.primary }}>
            {label}
          </div>
        ) : null}
        <div className="line-clamp-2 text-xl font-extrabold leading-tight" style={textSize(m, 'productName', 20)}>
          {p.name}
        </div>
        {m.cfg.theme.showDescriptions && p.description ? (
          <div className="line-clamp-3 kt-13" style={{ color: m.c.mutedText, ...textSize(m, 'productDescription', 13) }}>
            {p.description}
          </div>
        ) : null}
        <DietaryChips m={m} tags={p.dietaryTags} />
        <div className="flex items-center gap-3 pt-1.5">
          <span className="min-w-0 flex-1 truncate text-xl font-extrabold tabular-nums" style={{ color: p.soldOut ? m.c.mutedText : m.c.primary, textDecoration: p.soldOut ? 'line-through' : undefined, ...textSize(m, 'productPrice', 20) }}>
            {m.money(p.price)}
          </span>
          {p.soldOut ? null : (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                tap(p, true, pic(e.currentTarget));
              }}
              className="k-tap k-tap-solid relative flex shrink-0 items-center gap-1.5 px-5 kt-15 font-bold shadow-md transition-transform duration-150 active:scale-95"
              style={{ minHeight: 48 * u, borderRadius: m.btnRadius, background: added ? m.c.accent : m.c.button, color: m.c.buttonText, ...textSize(m, 'buttons', 15) }}
              data-text-key="quickAdd"
            >
              {added ? <Check className="h-5 w-5" /> : <Plus className="h-5 w-5" />}
              {kt(m, 'quickAdd')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
