/**
 * The frame the phase-2 catalogs share on the web (shelves, list, magazine, wall — docs/SPEC_KIOSK_LAYOUTS.md),
 * as the Android kiosk's layouts/KioskLayoutFrame.kt: the header with what the screen keeps under it
 * (the chips), the dishes' column, the basket the layout says (floating, docked or the side panel),
 * the ticker; and the categories' chips that follow the scrolling menu and jump to a section.
 */

import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { basketDocked, basketKindOf } from '@/lib/kioskLayout';
import { CartPanel, CatalogHeader, type PCategory, type PreviewModel } from '@/components/dashboard/kiosks/preview-screens';
import { TickerSlot, PREVIEW_FOOTER_PX } from '@/components/dashboard/kiosks/preview-ticker';
import { DockedBasket, FloatingBasket } from './baskets';
import { widthDpOf } from './parts';
import { IconChip } from './tabs';

/** A phase-2 catalog: the header (with `top` under it), `children` (the dishes' scroller), the basket, the ticker. */
export function PhaseFrame({ m, top, search = true, children }: { m: PreviewModel; top?: ReactNode; search?: boolean; children: ReactNode }) {
  const basket = basketKindOf(m.cfg, widthDpOf(m));
  return (
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
        <CatalogHeader m={m} search={search}>
          {top}
        </CatalogHeader>
        {children}
        <FloatingBasket m={m} kind={basket} />
        <TickerSlot m={m} screen="catalog" position="bottom" gapBelow={basketDocked(basket) ? 0 : m.live ? 0 : PREVIEW_FOOTER_PX} />
        <DockedBasket m={m} kind={basket} />
      </div>
      {m.panel && basket === 'panel' ? <CartPanel m={m} /> : null}
    </div>
  );
}

/**
 * The categories as chips with their icons (layout.categoryIcons), the lit one kept in view; a tap
 * picks it (`onPick`). `lit` follows the menu as it scrolls (useSectionSpy).
 */
export function CategoryChips({ m, lit, onPick }: { m: PreviewModel; lit: string | null; onPick: (id: string) => void }) {
  const stripRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip || !lit) return;
    const chip = strip.querySelector<HTMLElement>(`[data-cat="${CSS.escape(lit)}"]`);
    if (!chip) return;
    const left = chip.offsetLeft - 16;
    const right = chip.offsetLeft + chip.offsetWidth + 16;
    const behavior = m.cfg.general.reduceMotion ? 'auto' : 'smooth';
    if (left < strip.scrollLeft) strip.scrollTo({ left, behavior });
    else if (right > strip.scrollLeft + strip.clientWidth) strip.scrollTo({ left: right - strip.clientWidth, behavior });
  }, [lit, m.cfg.general.reduceMotion]);
  if (m.categories.length < 2) return null;
  return (
    <div ref={stripRef} className="flex gap-2 overflow-x-auto px-3 pb-2 [scrollbar-width:none]">
      {m.categories.map((cat: PCategory) => (
        <IconChip key={cat.id} m={m} cat={cat} on={cat.id === lit} onPick={() => onPick(cat.id)} />
      ))}
    </div>
  );
}

/**
 * Scroll-spy over `[data-section]` children of the scroller: the section at its top. `jump` scrolls to
 * a section (smoothly, but with reduce motion).
 */
export function useSectionSpy(m: PreviewModel, scrollerRef: RefObject<HTMLDivElement | null>): { spy: string | null; setSpy: (id: string | null) => void; onScroll: () => void; jump: (id: string) => void } {
  const [spy, setSpy] = useState<string | null>(null);
  const onScroll = () => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    let found: string | null = null;
    for (const s of Array.from(scroller.querySelectorAll<HTMLElement>('[data-section]'))) if (s.offsetTop <= scroller.scrollTop + 24) found = s.dataset.section ?? found;
    if (found && found !== spy) setSpy(found);
  };
  const jump = (id: string) => {
    setSpy(id);
    const scroller = scrollerRef.current;
    const section = scroller?.querySelector<HTMLElement>(`[data-section="${CSS.escape(id)}"]`);
    if (scroller && section) scroller.scrollTo({ top: section.offsetTop - 4, behavior: m.cfg.general.reduceMotion ? 'auto' : 'smooth' });
  };
  return { spy, setSpy, onScroll, jump };
}
