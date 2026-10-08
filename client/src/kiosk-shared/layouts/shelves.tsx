/**
 * "מדפים" (layout.catalog = shelves — the cafe template) on the web, as the Android kiosk's
 * layouts/KioskLayoutShelves.kt: the menu as shelves one under the other — each category its title
 * (with its emoji or icon) and a row of its dishes scrolling across, about 2.4 cards in view ("גודל
 * מוצרים" makes them more or fewer); "באנר מומלצים" over them (layout.hero). The cards are the tiles.
 */

import { cn } from '@/lib/utils';
import { heroShown, layoutOf } from '@/lib/kioskLayout';
import { itemEnter } from '@/components/dashboard/kiosks/preview-motion';
import type { PCategory, PreviewModel } from '@/components/dashboard/kiosks/preview-screens';
import { CategoryVisual } from './icons';
import { PhaseFrame } from './frame';
import { HeroBanner, shelfCardPx } from './hero';
import { Empty, LayoutDishCard, SectionTitle, cartCounts, unitOf } from './parts';

export function ShelvesCatalog({ m }: { m: PreviewModel }) {
  const counts = cartCounts(m);
  const card = shelfCardPx(m);
  return (
    <PhaseFrame m={m}>
      <div className="relative min-h-0 flex-1 space-y-4 overflow-y-auto pb-4 pt-1 [scrollbar-width:none]">
        {heroShown(m.cfg, m.featured.length) ? <HeroBanner m={m} /> : null}
        {m.categories.length === 0 ? <Empty m={m}>{m.t('empty')}</Empty> : null}
        {m.categories.map((cat, i) => (
          <Shelf key={cat.id} m={m} cat={cat} card={card} counts={counts} index={i} />
        ))}
      </div>
    </PhaseFrame>
  );
}

function Shelf({ m, cat, card, counts, index }: { m: PreviewModel; cat: PCategory; card: number; counts: Record<string, number>; index: number }) {
  const mode = layoutOf(m.cfg).categoryIcons;
  const e = itemEnter(m.transitions, index, true);
  return (
    <section data-section={cat.id} className={cn('space-y-1.5', e.className)} style={e.style}>
      <div className="flex items-center gap-2 px-3">
        {mode && mode !== 'none' ? <CategoryVisual m={m} cat={cat} mode={mode} size={Math.round(28 * unitOf(m))} /> : null}
        <SectionTitle m={m} title={cat.name} count={cat.products.length} />
      </div>
      <div className="flex gap-2.5 overflow-x-auto px-3 pb-1 [scrollbar-width:none]">
        {cat.products.map((p) => (
          <div key={p.id} data-product={p.id} className="flex shrink-0" style={{ width: card }}>
            <LayoutDishCard m={m} p={p} kind="tile" inCart={counts[p.id] ?? 0} />
          </div>
        ))}
      </div>
    </section>
  );
}
