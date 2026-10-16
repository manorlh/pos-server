/**
 * "פס צד עם תמונות גדולות" (layout.catalog = rail — the fast-food template, McDonald's), as the Android
 * kiosk's layouts/KioskLayoutRail.kt: a tall rail of big category pictures on the start side (right
 * in Hebrew), 12 / 8 / 6 to a screen (railSize), the dishes beside it on their plates, two across, the
 * order bar fixed at the bottom. One category at a time (catalog.oneCategory, as today) or one list
 * the rail follows (layout.catalogScroll = continuous, or oneCategory off).
 *
 * "מסעדה — פס צד" (P:/specs/kiosk-rail-motion.md §6): railStyle circle — each category an icon in a
 * circle with its name under it, the chosen one filled and / or scaled (railEmphasis), in the theme's
 * rail colours (railMotionColors); railFollow off — the rail never scrolls by itself.
 */

import { useEffect, useRef, useState } from 'react';
import { basketDocked, basketKindOf, catalogContinuous, layoutOf, productColumns, railCircles, railEmphasisOf, railFollows, railMeasures, type LayoutCategoryIcons } from '@/lib/kioskLayout';
import { railMotionColors, type RailMotionColors } from '@/lib/kioskConfig';
import { kioskIcon } from '@/lib/kioskIcons';
import { readableTextOn } from '@/lib/categoryLook';
import { KioskSwap } from '@/components/dashboard/kiosks/preview-motion';
import { CartPanel, CatalogHeader, textSize, type PreviewModel } from '@/components/dashboard/kiosks/preview-screens';
import { TickerSlot, PREVIEW_FOOTER_PX } from '@/components/dashboard/kiosks/preview-ticker';
import { CategoryVisual, KioskIconSvg, categoryIconId } from './icons';
import { DockedBasket, FloatingBasket } from './baskets';
import { DP_PER_PX, Empty, LayoutDishCard, SectionTitle, cartCounts, widthDpOf } from './parts';
import { itemEnter } from '@/components/dashboard/kiosks/preview-motion';
import { cn } from '@/lib/utils';
import type { PCategory } from '@/components/dashboard/kiosks/preview-screens';

/**
 * A category on the circles rail: its icon (layout.categoryIcons — line / filled / duotone in railIcon,
 * the emoji) or its picture cropped round (photo / null), else its initial; `fill` — the chosen one's
 * circle in railSelectedBg with the icon readable on it.
 */
function RailCircle({ m, cat, mode, size, fill, rc }: {
  m: PreviewModel;
  cat: PCategory;
  mode: LayoutCategoryIcons | null;
  size: number;
  fill: boolean;
  rc: RailMotionColors;
}) {
  const id = categoryIconId(m, cat);
  // "תמונת מחלקה מהקטלוג": an initial (no picture, no icon) on the category's own colour while not chosen.
  const initialOnly = mode === null && !cat.imageUrl;
  const own = initialOnly && !fill && cat.color ? readableTextOn(cat.color) : null;
  const bg = own && cat.color ? cat.color : fill ? rc.railSelectedBg : rc.railCircleBg;
  const fg = own ?? (fill ? rc.railIconOn : rc.railIcon);
  let inner;
  if ((mode === 'photo' || mode === null) && cat.imageUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    inner = <img src={cat.imageUrl} alt="" draggable={false} loading="lazy" className="h-full w-full rounded-full object-cover" />;
  } else if (mode === 'line' || mode === 'filled' || mode === 'duotone') {
    inner = <KioskIconSvg id={id} style={mode} size={Math.round(size * 0.56)} color={fg} knock={bg} />;
  } else if (mode === 'emoji' || mode === 'photo') {
    inner = <span style={{ fontSize: size * 0.5, lineHeight: 1 }}>{kioskIcon(id)?.emoji ?? '🍽️'}</span>;
  } else {
    inner = (
      <span className="font-bold" style={{ fontSize: size * 0.4, color: fg }}>
        {cat.name.trim().charAt(0)}
      </span>
    );
  }
  return (
    <span
      data-circle
      className="flex shrink-0 items-center justify-center overflow-hidden rounded-full transition-[background-color,box-shadow] duration-200"
      style={{ width: size, height: size, background: bg, boxShadow: fill ? 'none' : `inset 0 0 0 1px ${rc.railIcon}1A` }}
    >
      {inner}
    </span>
  );
}

export function RailCatalog({ m, onCategory }: { m: PreviewModel; onCategory?: (id: string) => void }) {
  const layout = layoutOf(m.cfg);
  const one = !catalogContinuous(m.cfg);
  const circles = railCircles(m.cfg);
  const emphasis = railEmphasisOf(m.cfg);
  const follow = railFollows(m.cfg);
  const rc = railMotionColors(m.cfg.theme);
  const [active, setActive] = useState<string | null>(m.categories[0]?.id ?? null);
  const current = m.categories.some((c) => c.id === active) ? active : (m.categories[0]?.id ?? null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [bodyH, setBodyH] = useState(600);
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBodyH(el.clientHeight));
    ro.observe(el);
    setBodyH(el.clientHeight);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const rail = railRef.current;
    // "הפס עוקב אחרי הבחירה" off: the rail stays where the customer left it.
    if (!rail || !current || !follow) return;
    const item = rail.querySelector<HTMLElement>(`[data-cat="${CSS.escape(current)}"]`);
    if (!item) return;
    if (item.offsetTop < rail.scrollTop) rail.scrollTo({ top: item.offsetTop - 8 });
    else if (item.offsetTop + item.offsetHeight > rail.scrollTop + rail.clientHeight) rail.scrollTo({ top: item.offsetTop + item.offsetHeight - rail.clientHeight + 8 });
  }, [current, follow]);

  const basket = basketKindOf(m.cfg, widthDpOf(m));
  const measures = railMeasures(layout.railSize, widthDpOf(m), Math.round(bodyH * DP_PER_PX));
  const railW = Math.round(measures.widthDp / DP_PER_PX);
  const itemH = Math.round(measures.itemDp / DP_PER_PX);
  const imageSize = Math.round(measures.imageDp / DP_PER_PX);
  const gridPx = m.screen.w - railW - (m.panel ? 132 : 0);
  const cols = productColumns(Math.max(2, Math.floor(gridPx / 190)), layout.productSize, gridPx * DP_PER_PX, layout.card === 'row');
  const counts = cartCounts(m);
  const pick = (id: string) => {
    setActive(id);
    onCategory?.(id);
    m.onCategoryPicked?.(id);
    const scroller = scrollerRef.current;
    if (!scroller) return;
    if (one) return scroller.scrollTo({ top: 0 });
    const section = scroller.querySelector<HTMLElement>(`[data-section="${CSS.escape(id)}"]`);
    if (section) scroller.scrollTo({ top: section.offsetTop - 4, behavior: m.cfg.general.reduceMotion ? 'auto' : 'smooth' });
  };
  const onScroll = () => {
    const scroller = scrollerRef.current;
    if (!scroller || one) return;
    let found: string | null = null;
    for (const s of Array.from(scroller.querySelectorAll<HTMLElement>('[data-section]'))) if (s.offsetTop <= scroller.scrollTop + 16) found = s.dataset.section ?? found;
    if (found && found !== active) setActive(found);
  };
  const grid = (products: typeof m.categories[number]['products'], enter: boolean) => (
    <div className="grid gap-2.5" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
      {products.map((p, i) => {
        const e = itemEnter(m.transitions, i, enter);
        return (
          <div key={p.id} data-product={p.id} className={cn('flex', e.className)} style={e.style}>
            <LayoutDishCard m={m} p={p} inCart={counts[p.id] ?? 0} />
          </div>
        );
      })}
    </div>
  );

  return (
    <div className="flex h-full flex-col">
      <CatalogHeader m={m} />
      <div ref={bodyRef} className="flex min-h-0 flex-1">
        <div
          ref={railRef}
          className={cn('flex shrink-0 flex-col overflow-y-auto [scrollbar-width:none]', circles && 'gap-1 py-2')}
          style={{ width: railW, background: circles ? rc.railBg : m.c.surface }}
        >
          {m.categories.map((cat) => {
            const on = cat.id === current;
            if (circles) {
              const d = Math.max(40, Math.round(Math.min(railW * 0.7, imageSize)));
              return (
                <button
                  key={cat.id}
                  type="button"
                  data-cat={cat.id}
                  data-active={on || undefined}
                  aria-current={on || undefined}
                  onClick={() => pick(cat.id)}
                  className="relative flex shrink-0 flex-col items-center justify-center gap-1.5 px-1.5 text-center"
                  style={{ minHeight: itemH }}
                >
                  <span
                    className="transition-transform duration-200"
                    // The grown circle keeps its room (layout audit 16.10: a big circle grown ×scale covered its own name).
                    style={{ transform: `scale(${on ? emphasis.scale : 1})`, marginBlock: on ? Math.max(0, Math.round(((emphasis.scale - 1) * d) / 2)) : 0, transitionTimingFunction: 'cubic-bezier(0.34, 1.26, 0.64, 1)' }}
                  >
                    <RailCircle m={m} cat={cat} mode={layout.categoryIcons} size={d} fill={on && emphasis.fill} rc={rc} />
                  </span>
                  <span
                    className={cn('line-clamp-2 w-full leading-tight [overflow-wrap:anywhere]', itemH >= 100 ? 'kt-13' : 'kt-11', on ? 'font-extrabold' : 'font-semibold')}
                    style={{ color: rc.railText, ...textSize(m, 'categoryName', itemH >= 100 ? 13 : 11) }}
                  >
                    {cat.name}
                  </span>
                </button>
              );
            }
            return (
              <button
                key={cat.id}
                type="button"
                data-cat={cat.id}
                data-active={on || undefined}
                onClick={() => pick(cat.id)}
                className="relative flex shrink-0 flex-col items-center justify-center gap-1 px-1.5 text-center transition-colors duration-200"
                style={{ height: itemH, background: on ? `${m.c.primary}14` : 'transparent' }}
              >
                {on ? <span className="absolute inset-y-2 start-0 w-1 rounded-full" style={{ background: m.c.primary }} aria-hidden /> : null}
                <span className="transition-transform duration-200" style={{ transform: on ? 'scale(1.04)' : 'scale(0.96)' }}>
                  <CategoryVisual m={m} cat={cat} mode={layout.categoryIcons ?? 'photo'} size={imageSize} on={on} />
                </span>
                <span className={cn('line-clamp-2 w-full leading-tight [overflow-wrap:anywhere]', itemH >= 100 ? 'kt-13' : 'kt-11', on ? 'font-extrabold' : 'font-semibold')} style={{ color: on ? m.c.primary : m.c.text, ...textSize(m, 'categoryName', itemH >= 100 ? 13 : 11) }}>
                  {cat.name}
                </span>
              </button>
            );
          })}
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <div ref={scrollerRef} onScroll={onScroll} className="relative min-h-0 flex-1 space-y-4 overflow-y-auto px-3 pb-4 pt-2 [scrollbar-width:none]">
            {m.categories.length === 0 ? (
              <Empty m={m}>{m.t('empty')}</Empty>
            ) : one ? (
              <KioskSwap
                id={current ?? ''}
                fx={m.transitions.categorySwitch}
                ms={m.transitions.categoryMs}
                ease={m.transitions.categoryEase}
                order={(id) => m.categories.findIndex((c) => c.id === id)}
                className="overflow-x-clip [overflow-clip-margin:12px]"
                render={(id) => {
                  const cat = m.categories.find((c) => c.id === id);
                  return cat ? (
                    <section data-section={cat.id} className="space-y-2">
                      <SectionTitle m={m} title={cat.name} count={cat.products.length} />
                      {grid(cat.products, true)}
                    </section>
                  ) : null;
                }}
              />
            ) : (
              m.categories.map((cat, i) => (
                <section key={cat.id} data-section={cat.id} className="space-y-2">
                  <SectionTitle m={m} title={cat.name} count={cat.products.length} />
                  {grid(cat.products, i === 0)}
                </section>
              ))
            )}
          </div>
          <FloatingBasket m={m} kind={basket} />
        </div>
        {m.panel && basket === 'panel' ? <CartPanel m={m} /> : null}
      </div>
      <TickerSlot m={m} screen="catalog" position="bottom" gapBelow={basketDocked(basket) ? 0 : m.live ? 0 : PREVIEW_FOOTER_PX} />
      <DockedBasket m={m} kind={basket} />
    </div>
  );
}
