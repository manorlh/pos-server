/**
 * "מסך מחלקות במרכז ← נכנסים" (layout.catalog = landing — the landing and guided templates), as the
 * Android kiosk's layouts/KioskLayoutLanding.kt: the categories in the middle of the screen as big
 * tiles (their icon or picture, "8 מנות"); a tap enters the category ("מעבר בין קטגוריות" plays), with
 * "כל המחלקות" back, the breadcrumb and the other categories as chips; the basket at the bottom. In the
 * guided flow: the step bar, the dishes as rows, and the main button on to the basket.
 */

import { useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { basketKindOf, layoutOf, landingColumnsFor } from '@/lib/kioskLayout';
import { checkoutStepsNow } from '@/lib/kioskConfig';
import { KioskSwap, itemEnter } from '@/components/dashboard/kiosks/preview-motion';
import { CartBar, CartPanel, CatalogHeader, cardStyle, serviceAsked, serviceOnAttractOf, type PCategory, type PreviewModel } from '@/components/dashboard/kiosks/preview-screens';
import { detailsFields } from '@/components/dashboard/kiosks/preview-entry';
import { TickerSlot, PREVIEW_FOOTER_PX } from '@/components/dashboard/kiosks/preview-ticker';
import { CategoryVisual } from './icons';
import { Empty, GuidedBar, GuidedBasketButton, LayoutDishCard, OrderSummaryBar, cartCounts, itemsCount, kt, unitOf, widthDpOf } from './parts';

const HOME = '\u0000home';

/** The guided step bar's checkout steps for this order (the tip, the details, the payment method). */
export function guidedCheckout(m: PreviewModel): Array<'tip' | 'details' | 'payMethod'> {
  return checkoutStepsNow(m.cfg.payment, detailsFields(m.cfg, m.service).length > 0, false) as Array<'tip' | 'details' | 'payMethod'>;
}

/** The service is its own screen (and so a step of the guided bar): asked, and not on the attract screen's two buttons. */
export function serviceStepOf(m: PreviewModel): boolean {
  return serviceAsked(m) && !serviceOnAttractOf(m);
}

export function LandingCatalog({ m, onCategory }: { m: PreviewModel; onCategory?: (id: string) => void }) {
  const layout = layoutOf(m.cfg);
  const guided = layout.flow === 'guided';
  const [entered, setEntered] = useState<string | null>(null);
  const current = m.categories.find((c) => c.id === entered) ?? null;
  const basket = guided ? 'guided' : basketKindOf(m.cfg, widthDpOf(m));
  const enter = (id: string | null) => {
    setEntered(id);
    if (id) onCategory?.(id);
    if (id) m.onCategoryPicked?.(id);
  };
  const live = m.live?.back;
  const back = current ? () => enter(null) : live;
  return (
    <div className="flex h-full flex-col">
      <CatalogHeader m={m.live ? { ...m, live: { ...m.live, back } } : m} />
      {guided ? <GuidedBar m={m} current="menu" serviceStep={serviceStepOf(m)} checkout={guidedCheckout(m)} /> : null}
      <div className="flex min-h-0 flex-1">
        <div className="relative flex min-w-0 flex-1 flex-col">
          <div className="relative min-h-0 flex-1 overflow-y-auto [scrollbar-width:none]">
            {m.categories.length === 0 ? (
              <Empty m={m}>{m.t('empty')}</Empty>
            ) : (
              <KioskSwap
                id={current?.id ?? HOME}
                fx={m.transitions.categorySwitch}
                ms={m.transitions.categoryMs}
                order={(id) => (id === HOME ? -1 : m.categories.findIndex((c) => c.id === id))}
                className="overflow-x-clip [overflow-clip-margin:12px]"
                render={(id) => {
                  const cat = m.categories.find((c) => c.id === id);
                  return cat ? <CategoryPage m={m} cat={cat} onEnter={enter} /> : <LandingHome m={m} onEnter={enter} />;
                }}
              />
            )}
          </div>
          {basket === 'bar' && !m.panel ? (
            <div className="shrink-0 p-2" style={{ background: `linear-gradient(to top, ${m.c.background}, ${m.c.background}00)` }}>
              <CartBar m={m} />
            </div>
          ) : null}
          {basket === 'guided' ? <GuidedBasketButton m={m} /> : null}
        </div>
        {m.panel && basket === 'panel' ? <CartPanel m={m} /> : null}
      </div>
      <TickerSlot m={m} screen="catalog" position="bottom" gapBelow={basket === 'summary' ? 0 : m.live ? 0 : PREVIEW_FOOTER_PX} />
      {basket === 'summary' ? <OrderSummaryBar m={m} /> : null}
      {basket === 'summary' && !m.live ? <div className="shrink-0" style={{ height: PREVIEW_FOOTER_PX, background: m.cfg.theme.mode === 'dark' ? m.c.surface : '#14161A' }} /> : null}
    </div>
  );
}

/** "מה בא לכם היום?" and the categories' tiles. */
function LandingHome({ m, onEnter }: { m: PreviewModel; onEnter: (id: string) => void }) {
  const layout = layoutOf(m.cfg);
  const guided = layout.flow === 'guided';
  const cols = landingColumnsFor(m.cfg, widthDpOf(m));
  const u = unitOf(m);
  const tileW = (m.screen.w - 24 - 10 * (cols - 1)) / cols;
  const icon = Math.round(Math.max(36, Math.min(110, tileW * (cols <= 2 ? 0.36 : 0.44))));
  return (
    <div className="space-y-3 px-3 pb-4 pt-2">
      <div className="space-y-0.5 py-1 text-center">
        <h2 className="text-xl font-extrabold leading-tight" data-text-key={guided ? 'guidedMenuTitle' : 'landingTitle'}>
          {kt(m, guided ? 'guidedMenuTitle' : 'landingTitle')}
        </h2>
        <p className="kt-13" style={{ color: m.c.mutedText }} data-text-key={guided ? 'guidedMenuSubtitle' : 'landingSubtitle'}>
          {kt(m, guided ? 'guidedMenuSubtitle' : 'landingSubtitle')}
        </p>
      </div>
      <div className="grid gap-2.5" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
        {m.categories.map((cat, i) => {
          const e = itemEnter(m.transitions, i, true);
          return (
            <div key={cat.id} className={cn('flex', e.className)} style={e.style}>
              <button
                type="button"
                data-cat={cat.id}
                onClick={() => onEnter(cat.id)}
                className="flex w-full flex-col items-center justify-center gap-1.5 px-2 text-center transition-transform duration-150 active:scale-[0.97]"
                style={{ ...cardStyle(m), minHeight: icon + 60 * u, paddingTop: 12 * u, paddingBottom: 12 * u }}
              >
                <CategoryVisual m={m} cat={cat} mode={layout.categoryIcons ?? 'duotone'} size={icon} />
                <span className="line-clamp-2 kt-15 font-bold leading-tight">{cat.name}</span>
                {layout.landingShowCounts ? (
                  <span className="kt-11" style={{ color: m.c.mutedText }}>
                    {itemsCount(m, cat.products.length)}
                  </span>
                ) : null}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** A category entered: "כל המחלקות", the breadcrumb, its title, the chips, its dishes. */
function CategoryPage({ m, cat, onEnter }: { m: PreviewModel; cat: PCategory; onEnter: (id: string | null) => void }) {
  const layout = layoutOf(m.cfg);
  const counts = cartCounts(m);
  const rows = layout.card === 'row';
  const cols = rows ? 1 : Math.max(2, Math.floor((m.screen.w - (m.panel ? 132 : 0)) / 210));
  const u = unitOf(m);
  return (
    <section data-section={cat.id} className="space-y-3 px-3 pb-4 pt-2">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => onEnter(null)}
          className="flex items-center gap-1.5 px-3 kt-13 font-bold"
          style={{ minHeight: 40 * u, borderRadius: 999, background: `${m.c.primary}1A`, color: m.c.primary }}
        >
          <ArrowRight className="h-4 w-4" /> {kt(m, 'allCategories')}
        </button>
        <span className="truncate kt-11" style={{ color: m.c.mutedText }}>
          {kt(m, 'breadcrumbMenu')} ‹ <b>{cat.name}</b>
        </span>
      </div>
      <div className="flex items-center gap-3">
        <CategoryVisual m={m} cat={cat} mode={layout.categoryIcons ?? 'duotone'} size={Math.round(48 * u)} />
        <div className="min-w-0">
          <h2 className="truncate text-xl font-extrabold leading-tight">{cat.name}</h2>
          <div className="kt-11" style={{ color: m.c.mutedText }}>
            {itemsCount(m, cat.products.length)}
          </div>
        </div>
      </div>
      {m.categories.length > 1 ? (
        <div className="-mx-3 flex gap-2 overflow-x-auto px-3 [scrollbar-width:none]">
          {m.categories.map((other) => {
            const on = other.id === cat.id;
            return (
              <button
                key={other.id}
                type="button"
                data-cat={other.id}
                data-active={on || undefined}
                onClick={() => onEnter(other.id)}
                className="shrink-0 px-3.5 kt-13 font-semibold"
                style={{
                  minHeight: 38 * u,
                  borderRadius: 999,
                  background: on ? m.c.button : m.cfg.theme.mode === 'dark' ? '#FFFFFF14' : '#0000000D',
                  color: on ? m.c.buttonText : m.c.text,
                }}
              >
                {other.name}
              </button>
            );
          })}
        </div>
      ) : null}
      <div className="grid gap-2.5" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
        {cat.products.map((p, i) => {
          const e = itemEnter(m.transitions, i, true);
          return (
            <div key={p.id} data-product={p.id} className={cn('flex', e.className)} style={e.style}>
              <LayoutDishCard m={m} p={p} inCart={counts[p.id] ?? 0} />
            </div>
          );
        })}
      </div>
    </section>
  );
}
