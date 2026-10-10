/**
 * "באנר מומלצים" (layout.hero, docs/SPEC_KIOSK_LAYOUTS.md) on the web, as the Android kiosk's
 * LayoutHeroBanner: "מומלצים" and the kiosk's featured dishes as wide pictures in a row that snaps a
 * dish at a time — still ("manual"), or turning to the next every few seconds ("auto"; not while the
 * pointer is on it, and at once with reduce motion). The shelves and the tabs' one menu carry it.
 */

import { useEffect, useRef } from 'react';
import { Check, Plus, Sparkles } from 'lucide-react';
import { HERO_TURN_MS, layoutOf, shelfCardDp } from '@/lib/kioskLayout';
import { ProductImage, cardStyle, textSize, type PProduct, type PreviewModel } from '@/components/dashboard/kiosks/preview-screens';
import { DP_PER_PX, cartCounts, kt, unitOf, useTapDish, widthDpOf } from './parts';

export function HeroBanner({ m }: { m: PreviewModel }) {
  const stripRef = useRef<HTMLDivElement>(null);
  const hovered = useRef(false);
  const auto = layoutOf(m.cfg).hero === 'auto';
  const count = m.featured.length;
  const reduce = m.cfg.general.reduceMotion;
  useEffect(() => {
    if (!auto || count < 2) return;
    let at = 0;
    const id = window.setInterval(() => {
      const strip = stripRef.current;
      if (!strip || hovered.current) return;
      at = (at + 1) % count;
      const card = strip.children[at] as HTMLElement | undefined;
      if (!card) return;
      // The card's start edge onto the strip's start (right in Hebrew), the strip's own scroll only.
      const rtl = getComputedStyle(strip).direction === 'rtl';
      const s = strip.getBoundingClientRect();
      const c = card.getBoundingClientRect();
      const delta = rtl ? c.right - (s.right - 12) : c.left - (s.left + 12);
      strip.scrollBy({ left: delta, behavior: reduce ? 'auto' : 'smooth' });
    }, HERO_TURN_MS);
    return () => window.clearInterval(id);
  }, [auto, count, reduce]);
  if (count === 0) return null;
  const width = Math.min(widthDpOf(m) - 40 - (count > 1 ? 56 : 0), 760) / DP_PER_PX;
  const counts = cartCounts(m);
  return (
    <section className="space-y-2" data-hero>
      <h3 className="flex items-center gap-1.5 px-3 text-base font-extrabold">
        <Sparkles className="h-4 w-4" style={{ color: m.c.accent }} /> {m.t('featured')}
      </h3>
      <div
        ref={stripRef}
        onPointerEnter={() => (hovered.current = true)}
        onPointerLeave={() => (hovered.current = false)}
        className="flex snap-x snap-mandatory gap-2.5 overflow-x-auto px-3 pb-1 [scrollbar-width:none]"
      >
        {m.featured.map((p) => (
          <HeroCard key={p.id} m={m} p={p} width={Math.max(160, width)} inCart={counts[p.id] ?? 0} />
        ))}
      </div>
    </section>
  );
}

/** A featured dish, wide: its picture, its name and price on a strip at its bottom, the "+". */
function HeroCard({ m, p, width, inCart }: { m: PreviewModel; p: PProduct; width: number; inCart: number }) {
  const tap = useTapDish(m);
  const u = unitOf(m);
  const added = m.justAddedId === p.id;
  return (
    <button
      type="button"
      data-dish={p.id}
      disabled={p.soldOut}
      onClick={(e) => tap(p, false, e.currentTarget.querySelector('[data-pic]')?.getBoundingClientRect() ?? null)}
      className="k-tap relative shrink-0 snap-start overflow-hidden text-start transition-transform duration-150 active:scale-[0.98]"
      style={{ ...cardStyle(m), width, aspectRatio: '16 / 9' }}
    >
      <div data-pic className="absolute inset-0">
        <ProductImage m={m} p={p} className="h-full w-full" />
      </div>
      <div className="absolute inset-x-0 bottom-0 flex items-center gap-2 px-3 py-2" style={{ background: 'rgba(17,17,17,0.8)', color: '#fff' }}>
        <span className="min-w-0 flex-1">
          <span className="block truncate kt-15 font-bold" style={textSize(m, 'productName', 15)}>
            {p.name}
          </span>
          <span className="block kt-13 font-extrabold tabular-nums" style={textSize(m, 'productPrice', 13)}>
            {m.money(p.price)}
          </span>
        </span>
        <span
          role="button"
          aria-label={kt(m, 'quickAdd')}
          onClick={(e) => {
            e.stopPropagation();
            tap(p, true, e.currentTarget.closest('[data-dish]')?.querySelector('[data-pic]')?.getBoundingClientRect() ?? null);
          }}
          className="flex shrink-0 items-center justify-center rounded-full font-bold shadow-md"
          style={{ width: 38 * u, height: 38 * u, background: inCart > 0 && !added ? m.c.primary : added ? m.c.accent : m.c.button, color: m.c.buttonText }}
        >
          {added ? <Check className="h-1/2 w-1/2" /> : inCart > 0 ? inCart : <Plus className="h-1/2 w-1/2" />}
        </span>
      </div>
    </button>
  );
}

/** The shelves' card width in these screens' px (the till's dp, shelfCardDp). */
export function shelfCardPx(m: PreviewModel): number {
  return shelfCardDp(widthDpOf(m), layoutOf(m.cfg).productSize) / DP_PER_PX;
}
