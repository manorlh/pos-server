/**
 * "מבנה הקיוסק" on the web — the one switch point (docs/SPEC_KIOSK_LAYOUTS.md), as the Android
 * kiosk's ui/kiosk/layouts/KioskLayouts.kt: the dashboard's live preview and the Windows kiosk ask here
 * for the menu screen, the dish's window and the frame of the ordering screens, and get the layout's
 * (config `layout`) — or today's screens, for `standard` and for anything this build does not draw.
 *
 * A new layout adds its screen to the tables below and its name to LAYOUT_CATALOGS_READY /
 * LAYOUT_TEMPLATES_READY (lib/kioskLayout.ts); no other layout is touched. Phase 2 added the shelves
 * (cafe), the list, the magazine and the wall, the compact dish window (inline / popover), the meal's
 * tray (combo) and the fab / drawer / receipt baskets; the service / name screens' variants are still
 * today's screens.
 */

import { useContext, useEffect, useState, type ComponentType, type ReactNode } from 'react';
import { catalogKindOf, itemViewOf, layoutOf, mealViewOf, type LayoutCatalog } from '@/lib/kioskLayout';
import { CatalogScreen, ProductSheet, type PGroup, type PLine, type PProduct, type PreviewModel } from '@/components/dashboard/kiosks/preview-screens';
import { MealChooser, MealSheet, StepsProductSheet } from './item';
import { ReachDishContext } from './reach';
import { guidedCheckout, LandingCatalog, serviceStepOf } from './landing';
import { GuidedBar, LayoutActionsContext } from './parts';
import { ListCatalog } from './list';
import { MagazineCatalog } from './magazine';
import { RailCatalog } from './rail';
import { ShelvesCatalog } from './shelves';
import { TabsCatalog } from './tabs';
import { WallCatalog } from './wall';

export { CategoryVisual, KioskIconSvg } from './icons';
export { ReachFrame, ReachSheets, ReachToggle, REACH_STRIP_PX, reachOn } from './reach';
export { WelcomeBlock } from './welcome';
export { GuidedBar, OrderSummaryBar, kt } from './parts';
export { DockedBasket, FloatingBasket, ReceiptBasket } from './baskets';

interface CatalogProps {
  m: PreviewModel;
  activeCategory: string | null;
  onCategory: (id: string) => void;
}

function RailEntry({ m, onCategory }: CatalogProps) {
  return <RailCatalog m={m} onCategory={onCategory} />;
}

function LandingEntry({ m, onCategory }: CatalogProps) {
  return <LandingCatalog m={m} onCategory={onCategory} />;
}

function ShelvesEntry({ m }: CatalogProps) {
  return <ShelvesCatalog m={m} />;
}

/** The catalogs by layout.catalog. */
const CATALOGS: Partial<Record<LayoutCatalog, ComponentType<CatalogProps>>> = {
  rail: RailEntry,
  top: TabsCatalog,
  landing: LandingEntry,
  shelves: ShelvesEntry,
  list: ListCatalog,
  magazine: MagazineCatalog,
  wall: WallCatalog,
};

/** The menu screen: the layout's catalog (today's, for standard), with "רוצים להפוך לארוחה?" over it. */
export function LayoutCatalog(props: CatalogProps) {
  const { m } = props;
  const [meal, setMeal] = useState<PProduct | null>(null);
  const kind = catalogKindOf(m.cfg);
  const Catalog = kind ? CATALOGS[kind] : undefined;
  const meals = meal ? (m.mealOptions?.(meal) ?? []) : [];
  // The accessible mode's display shows the dish asked about.
  const showDish = useContext(ReachDishContext);
  useEffect(() => {
    showDish(meal);
    return () => showDish(null);
  }, [meal, showDish]);
  return (
    <LayoutActionsContext.Provider value={{ askMeal: (p) => setMeal(p) }}>
      <div className="relative h-full">
        {Catalog ? <Catalog {...props} /> : <CatalogScreen {...props} />}
        {meal ? (
          <MealChooser
            m={m}
            product={meal}
            meals={meals}
            onClose={() => setMeal(null)}
            onDish={(from) => {
              setMeal(null);
              if (meal.addPath === 'direct' && m.quickAdd) m.quickAdd(meal, from);
              else m.openProduct(meal);
            }}
            onMeal={(chosen) => {
              setMeal(null);
              m.openProduct(chosen);
            }}
            onCustomize={() => {
              setMeal(null);
              m.openProduct(meal);
            }}
          />
        ) : null}
      </div>
    </LayoutActionsContext.Provider>
  );
}

interface SheetProps {
  m: PreviewModel;
  product: PProduct;
  groups: PGroup[];
  allergens: string[];
  onClose: () => void;
  onAdd: (line: PLine, from: DOMRect | null) => void;
  quickNotes?: string[];
}

/**
 * The dish's window as layout.itemView says: one group at a time (steps), the whole screen, a smaller
 * window, the compact one (inline — the list, popover — the wall), today's.
 */
export function LayoutProductSheet(props: SheetProps) {
  // A meal (the real kiosk's menu.meals): its window, a slot at a time, priced with its components —
  // drawn as a tray filling up where layout.mealView says so (combo).
  const meal = props.m.mealOf?.(props.product) ?? null;
  if (meal) return <MealSheet m={props.m} product={props.product} meal={meal} onClose={props.onClose} onAdd={props.onAdd} tray={mealViewOf(props.m.cfg) === 'tray'} />;
  const view = itemViewOf(props.m.cfg);
  if (view === 'steps') return <StepsProductSheet {...props} />;
  const variant = view === 'full' ? 'full' : view === 'modal' ? 'modal' : view === 'inline' || view === 'popover' ? 'compact' : 'sheet';
  return <ProductSheet {...props} variant={variant} />;
}

/**
 * An ordering screen in the guided flow (layout.flow = guided): the step bar over it. The categories'
 * screen draws its own; the checkout's steps have theirs.
 */
export function GuidedFrame({ m, screen, children }: { m: PreviewModel; screen: string; children: ReactNode }) {
  const layout = layoutOf(m.cfg);
  const step = screen === 'service' ? 'service' : screen === 'cart' ? 'basket' : screen === 'catalog' && catalogKindOf(m.cfg) !== 'landing' ? 'menu' : null;
  if (layout.flow !== 'guided' || !step) return <>{children}</>;
  return (
    <div className="flex h-full flex-col">
      <GuidedBar m={m} current={step} serviceStep={serviceStepOf(m)} checkout={guidedCheckout(m)} />
      <div className="relative min-h-0 flex-1">{children}</div>
    </div>
  );
}
