/**
 * "לשוניות עליונות + עמוד גולל" (layout.catalog = top — the tabs template, Wolt / Uber Eats), as the
 * Android kiosk's layouts/KioskLayoutTabs.kt: the categories at the top as chips with their icons,
 * held under the header, over ONE scrolling menu with a title per category; the chip of the section
 * on screen lights as it scrolls (scroll-spy) and a tap scrolls to its section. With
 * catalog.oneCategory a chip shows its category alone. The basket floats at the bottom.
 */

import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { basketKindOf, layoutOf } from '@/lib/kioskLayout';
import { KioskSwap, itemEnter } from '@/components/dashboard/kiosks/preview-motion';
import { CartBar, CartPanel, CatalogHeader, type PCategory, type PreviewModel } from '@/components/dashboard/kiosks/preview-screens';
import { TickerSlot, PREVIEW_FOOTER_PX } from '@/components/dashboard/kiosks/preview-ticker';
import { CategoryVisual, KioskIconSvg, categoryIconId } from './icons';
import { Empty, LayoutDishCard, OrderSummaryBar, SectionTitle, cartCounts, dishColumnsFor, unitOf, widthDpOf } from './parts';
import { kioskIcon } from '@/lib/kioskIcons';

export function TabsCatalog({ m, activeCategory, onCategory }: { m: PreviewModel; activeCategory: string | null; onCategory: (id: string) => void }) {
  const layout = layoutOf(m.cfg);
  const one = m.cfg.catalog.oneCategory;
  const current = m.categories.find((c) => c.id === activeCategory) ?? m.categories[0] ?? null;
  const scrollerRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const [spy, setSpy] = useState<string | null>(null);
  const lit = one ? current?.id ?? null : spy ?? current?.id ?? null;
  const basket = basketKindOf(m.cfg, widthDpOf(m));
  const counts = cartCounts(m);
  const rows = layout.card === 'row';
  const cols = rows ? 1 : dishColumnsFor(m, m.screen.w - (m.panel ? 132 : 0));

  // The lit chip stays in view as the menu scrolls under it.
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip || !lit) return;
    const chip = strip.querySelector<HTMLElement>(`[data-cat="${CSS.escape(lit)}"]`);
    if (!chip) return;
    const left = chip.offsetLeft - 16;
    const right = chip.offsetLeft + chip.offsetWidth + 16;
    if (left < strip.scrollLeft) strip.scrollTo({ left, behavior: m.cfg.general.reduceMotion ? 'auto' : 'smooth' });
    else if (right > strip.scrollLeft + strip.clientWidth) strip.scrollTo({ left: right - strip.clientWidth, behavior: m.cfg.general.reduceMotion ? 'auto' : 'smooth' });
  }, [lit, m.cfg.general.reduceMotion]);

  const pick = (id: string) => {
    onCategory(id);
    setSpy(id);
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
    for (const s of Array.from(scroller.querySelectorAll<HTMLElement>('[data-section]'))) if (s.offsetTop <= scroller.scrollTop + 24) found = s.dataset.section ?? found;
    if (found && found !== spy) setSpy(found);
  };
  const grid = (cat: PCategory, enter: boolean) => (
    <div className="grid gap-2.5" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
      {cat.products.map((p, i) => {
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
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
        <CatalogHeader m={m}>
          {m.categories.length > 1 ? (
            <div ref={stripRef} className="flex gap-2 overflow-x-auto px-3 pb-2 [scrollbar-width:none]">
              {m.categories.map((cat) => (
                <IconChip key={cat.id} m={m} cat={cat} on={cat.id === lit} onPick={() => pick(cat.id)} />
              ))}
            </div>
          ) : null}
        </CatalogHeader>
        <div ref={scrollerRef} onScroll={onScroll} className="relative min-h-0 flex-1 space-y-5 overflow-y-auto px-3 pb-4 pt-1 [scrollbar-width:none]">
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
        {basket === 'bar' && !m.panel ? (
          <div className="shrink-0 p-2" style={{ background: `linear-gradient(to top, ${m.c.background}, ${m.c.background}00)` }}>
            <CartBar m={m} />
          </div>
        ) : null}
        <TickerSlot m={m} screen="catalog" position="bottom" gapBelow={basket === 'summary' ? 0 : m.live ? 0 : PREVIEW_FOOTER_PX} />
        {basket === 'summary' ? <OrderSummaryBar m={m} /> : null}
      </div>
      {m.panel && basket === 'panel' ? <CartPanel m={m} /> : null}
    </div>
  );
}

/** A chip with its category's icon (layout.categoryIcons) and name; the lit one in the brand colour. */
function IconChip({ m, cat, on, onPick }: { m: PreviewModel; cat: PCategory; on: boolean; onPick: () => void }) {
  const mode = layoutOf(m.cfg).categoryIcons;
  const u = unitOf(m);
  const size = Math.round(22 * u);
  const fg = on ? m.c.buttonText : m.c.text;
  const id = categoryIconId(m, cat);
  return (
    <button
      type="button"
      data-cat={cat.id}
      data-active={on || undefined}
      onClick={onPick}
      className="flex shrink-0 items-center gap-1.5 ps-2.5 pe-3.5 kt-13 font-semibold transition-colors duration-200"
      style={{
        minHeight: 42 * u,
        borderRadius: m.btnRadius,
        background: on ? m.c.button : m.c.surface,
        color: fg,
        border: on ? '1px solid transparent' : `1px solid ${m.c.border}`,
      }}
    >
      {mode === 'line' || mode === 'filled' || mode === 'duotone' ? (
        <KioskIconSvg id={id} style={mode} size={size} color={on ? m.c.buttonText : m.c.primary} knock={on ? m.c.button : m.c.surface} />
      ) : mode === 'emoji' ? (
        <span style={{ fontSize: size, lineHeight: 1 }}>{kioskIcon(id)?.emoji}</span>
      ) : mode === 'photo' ? (
        <CategoryVisual m={m} cat={cat} mode="photo" size={size + 6} style={{ borderRadius: 999 }} />
      ) : null}
      <span className={on ? 'font-bold' : undefined}>{cat.name}</span>
    </button>
  );
}
