/**
 * What the basket check may keep, for the Windows kiosk (kiosk-desktop KioskService.priceBasket) and the browser kiosk
 * (WebKioskService.checkBasket) — ONE lookup, the Android kiosk's (pos-android domain/KioskBasketLookup, KioskBasketCheck.of):
 * a basket line stays only while its product is still sold here (docs/SPEC_MENUS.md §5.1) — blocks and channels always win.
 *
 *  - **a dish** is found where the kiosk SHOWS it now: on its catalog (the active menu's products, the machine's list, the
 *    channel, the manager's-code and delisting rules — lib/kioskSellable.ts) AND through the kiosk's own settings
 *    (`kioskCatalogView`: the products and categories it hides, a block's own "hide" look), not sold out or blocked, and not
 *    one the cloud says is gone. A line added under a menu may also stay on a product the active menu does not place but the
 *    catalog sells (`held`) — by the same rules, hiding included. Anything else — "קופות בלבד", restricted, hidden for this
 *    kiosk, in an inactive category, blocked, sold out, off the machine's list while no menu places it — goes.
 *  - **a meal's component** need not be on a screen of its own (a side that only the meal sells, hidden for the kiosk or not
 *    placed by the menu), but blocks, sold-out and the cloud's word still apply: the meal goes whole.
 *
 * Pure; imports only the self-contained kioskConfig.ts (the node tests compile it alone).
 */

import { kioskCatalogView } from './kioskConfig';

/** A product as the basket check reads it (WebProduct / KProduct). */
export interface BasketProduct {
  id: string;
  categoryId: string | null;
  /** "אזל" / "חסום" at this kiosk, now (stock, a block, the lock, delisting). */
  soldOut: boolean;
  available?: boolean;
  /** A block's own look on the kiosks ("hide" / "grey"); null: `soldOutMode` decides. */
  kioskDisplay?: 'hide' | 'grey' | null;
}

type ViewCfg = Parameters<typeof kioskCatalogView>[2];

export interface BasketSoldIn<P extends BasketProduct> {
  /** What the kiosk sells now (`catalog.products`) and the categories the active menu shows (`catalog.categories`). */
  products: readonly P[];
  categories: ReadonlyArray<{ id: string }>;
  /** What the catalog sells on this kiosk but the active menu does not place (`catalog.held`). */
  held: readonly P[];
  /** The kiosk's settings: its hidden products and categories, its sold-out mode. */
  cfg: ViewCfg;
  /** The cloud's word a moment ago: products it says are not sold here any more. */
  gone?: ReadonlySet<string> | null;
}

export interface BasketSold<P extends BasketProduct> {
  /** The dish of a line (`addedUnderMenu`: the line carries a menu), or null: it is no longer sold here. */
  dish(id: string, addedUnderMenu: boolean): P | null;
  /** A meal's component, or null: it is blocked, sold out or gone. Not hidden by the kiosk's settings, not placed by a menu: still found. */
  component(id: string): P | null;
}

/** The ids of the products `kioskCatalogView` shows. */
function shownIds(categories: ReadonlyArray<{ id: string }>, products: readonly BasketProduct[], cfg: ViewCfg): Set<string> {
  const view = kioskCatalogView(categories, products, cfg);
  return new Set(view.categories.flatMap((c) => c.products.map((x) => x.product.id)));
}

export function basketSold<P extends BasketProduct>(src: BasketSoldIn<P>): BasketSold<P> {
  const byId = new Map(src.products.map((p) => [p.id, p]));
  const heldById = new Map(src.held.map((p) => [p.id, p]));
  const live = (p: P | undefined): P | null => (p && !p.soldOut && !src.gone?.has(p.id) ? p : null);
  // Built when a line asks, once: an order whose lines are all on the screens never pays for the held's view.
  let shown: Set<string> | null = null;
  let heldShown: Set<string> | null = null;
  return {
    dish(id, addedUnderMenu) {
      const p = byId.get(id);
      if (p) {
        shown ??= shownIds(src.categories, src.products, src.cfg);
        // On the kiosk's catalog but not on its screens (hidden): gone — never kept for having been added under a menu.
        return shown.has(id) ? live(p) : null;
      }
      const h = addedUnderMenu ? heldById.get(id) : undefined;
      if (!h) return null;
      // The held's own categories, the kiosk's own settings over them — as the screens would show them with no menu.
      heldShown ??= shownIds([...new Set(src.held.map((x) => x.categoryId).filter((c): c is string => !!c))].map((c) => ({ id: c })), src.held, src.cfg);
      return heldShown.has(id) ? live(h) : null;
    },
    component(id) {
      return live(byId.get(id) ?? heldById.get(id));
    },
  };
}
