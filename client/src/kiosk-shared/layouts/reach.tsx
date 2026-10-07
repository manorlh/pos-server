/**
 * "נגיש — הכל בחצי התחתון" (layout.reach = low, with any layout), as the Android kiosk's
 * layouts/KioskReach.kt: the top half shows what is going on (the business, the screen, the dish, the
 * order's total) and is never touched; the screen itself, its windows too, is drawn in the bottom half.
 * The ♿ button (layout.reachToggle) turns it over for the current customer.
 */

import { createContext, useState, type ReactNode } from 'react';
import { catalogKindOf, layoutOf, reachLow, REACH_DISPLAY_SHARE } from '@/lib/kioskLayout';
import { cartCount, cartTotal, type PProduct, type PreviewModel } from '@/components/dashboard/kiosks/preview-screens';
import { ProductImage } from '@/components/dashboard/kiosks/preview-screens';
import { CategoryVisual } from './icons';
import { kt, unitOf } from './parts';

/** The accessible mode for this customer. */
export function reachOn(m: PreviewModel): boolean {
  return reachLow(m.cfg, m.reach?.toggled ?? false);
}

/** A screen (or the windows over it), in the bottom half under the display when the accessible mode is on. */
/** A screen's window tells the display which dish it is about ("רוצים להפוך לארוחה?" over the menu). */
export const ReachDishContext = createContext<(dish: PProduct | null) => void>(() => {});

export function ReachFrame({ m, screen, dish, category, children }: {
  m: PreviewModel;
  screen: string;
  dish?: PProduct | null;
  category?: string | null;
  children: ReactNode;
}) {
  const [inWindow, setInWindow] = useState<PProduct | null>(null);
  if (!reachOn(m)) return <ReachDishContext.Provider value={setInWindow}>{children}</ReachDishContext.Provider>;
  return (
    <ReachDishContext.Provider value={setInWindow}>
      <div className="flex h-full flex-col">
        <ReachShowcase m={m} screen={screen} dish={dish ?? inWindow} category={category ?? null} />
        <div className="relative min-h-0" style={{ flex: `${1 - REACH_DISPLAY_SHARE} 1 0` }}>
          {children}
        </div>
      </div>
    </ReachDishContext.Provider>
  );
}

/** The windows' layer (the dish, the meal, the upsell…): the bottom half in the accessible mode. */
export function ReachSheets({ m, children }: { m: PreviewModel; children: ReactNode }) {
  if (!reachOn(m)) return <>{children}</>;
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30" style={{ height: `${(1 - REACH_DISPLAY_SHARE) * 100}%` }}>
      <div className="pointer-events-auto relative h-full">{children}</div>
    </div>
  );
}

function ReachShowcase({ m, screen, dish, category }: { m: PreviewModel; screen: string; dish: PProduct | null; category: string | null }) {
  const u = unitOf(m);
  // The landing page has no category until one is picked; the others open on the first.
  const cat = m.categories.find((c) => c.id === category) ?? (catalogKindOf(m.cfg) === 'landing' ? null : m.categories[0] ?? null);
  const count = cartCount(m.cart);
  return (
    <div
      className="relative flex min-h-0 flex-col items-center justify-center gap-2 px-6 text-center"
      style={{ flex: `${REACH_DISPLAY_SHARE} 1 0`, background: `linear-gradient(to bottom, ${m.c.surface}, ${m.c.primary}14)` }}
      aria-hidden
    >
      {/* The business, at the top of the display. */}
      <div className="absolute inset-x-0 top-4 flex justify-center">
        {m.logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={m.logoUrl} alt="" className="object-contain" style={{ height: 40 * u, maxWidth: 160 * u }} draggable={false} />
        ) : (
          <span className="text-lg font-extrabold" style={{ color: m.c.primary }}>
            {m.brandName}
          </span>
        )}
      </div>
      {dish ? (
        <>
          <span className="overflow-hidden rounded-full" style={{ width: 150 * u, height: 150 * u }}>
            <ProductImage m={m} p={dish} className="h-full w-full" />
          </span>
          <div className="text-2xl font-extrabold leading-tight">{dish.name}</div>
          <div className="text-xl font-bold tabular-nums" style={{ color: m.c.primary }}>
            {m.money(dish.price)}
          </div>
        </>
      ) : screen === 'catalog' && cat ? (
        <>
          <CategoryVisual m={m} cat={cat} mode={layoutOf(m.cfg).categoryIcons ?? 'duotone'} size={Math.round(110 * u)} />
          <div className="text-2xl font-extrabold leading-tight">{cat.name}</div>
          {count > 0 ? <div className="text-lg tabular-nums" style={{ color: m.c.mutedText }}>{m.money(cartTotal(m.cart))}</div> : null}
        </>
      ) : screen === 'attract' ? (
        <>
          <div className="text-3xl font-extrabold leading-tight">{m.txt('attractTitle')}</div>
          <div className="kt-15" style={{ color: m.c.mutedText }}>
            {m.txt('attractSubtitle')}
          </div>
        </>
      ) : count > 0 ? (
        <>
          <div className="text-2xl font-extrabold">{m.txt('cartTitle')}</div>
          <div className="text-xl font-bold tabular-nums" style={{ color: m.c.primary }}>
            {count === 1 ? kt(m, 'basketItemsOne') : kt(m, 'basketItems', { count })} · {m.money(cartTotal(m.cart))}
          </div>
        </>
      ) : (
        <div className="text-2xl font-extrabold">{m.txt('catalogTitle')}</div>
      )}
      <span className="absolute inset-x-0 bottom-0 h-0 border-b-2 border-dashed" style={{ borderColor: `${m.c.primary}8C` }} />
    </div>
  );
}

/** The ♿ glyph, stroked. */
function Wheelchair({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M13 3.6a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 1 0 0-3.2M12 8.5v6h5l2 5M8.5 11.2a5.5 5.5 0 1 0 7.6 7.4M12 11.5h4.5" />
    </svg>
  );
}

/** The strip the ♿ button keeps under the ordering screens (CSS px at the kiosk's 540 across). */
export const REACH_STRIP_PX = 56;

/** The ♿ button (layout.reachToggle): in the bottom left corner (physical), on and off for this customer. */
export function ReachToggle({ m, bottom = 10 }: { m: PreviewModel; bottom?: number }) {
  if (!layoutOf(m.cfg).reachToggle || !m.reach) return null;
  const u = unitOf(m);
  const on = reachOn(m);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        m.reach?.toggle();
      }}
      aria-pressed={on}
      aria-label={kt(m, 'reachToggle')}
      className="absolute z-40 flex items-center gap-1.5 ps-1.5 pe-3 kt-13 font-bold text-white shadow-lg"
      style={{ left: 10, bottom, minHeight: 44 * u, borderRadius: 999, background: on ? m.c.primary : '#14161A', border: '2px solid rgba(255,255,255,0.85)' }}
      dir="rtl"
    >
      <span className="flex items-center justify-center rounded-full" style={{ width: 32 * u, height: 32 * u, background: 'rgba(255,255,255,0.18)' }}>
        <Wheelchair size={Math.round(20 * u)} />
      </span>
      {kt(m, 'reachOn')}
    </button>
  );
}
