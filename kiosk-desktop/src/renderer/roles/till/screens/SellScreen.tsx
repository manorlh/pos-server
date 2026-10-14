/**
 * The sell screen: departments, search, the product grid and the cart — laid out by the display
 * profile (side by side, stacked, or one pane with the cart behind a bar on a handheld). The
 * department and the search are the engine's state too (`sell.department`, `sell.search`).
 */

import { useState } from 'react';
import type { Catalog, TillState } from '../../../../shared/till/protocol';
import type { TillLayout } from '../layout/tillLayout';
import { CartPane, type CartActions } from '../parts/CartPane';
import { ProductGrid } from '../parts/ProductGrid';
import { ProductInfo } from '../parts/ProductInfo';
import { displayProductText } from '../parts/tileText';
import { money, T } from '../text';

export function filterProducts(catalog: Catalog, departmentId: string | null, search: string) {
  const q = search.trim();
  return catalog.products.filter((p) => (departmentId === null || p.departmentId === departmentId) && (q === '' || p.name.includes(q)));
}

export function SellScreen({
  state,
  catalog,
  layout,
  onAdd,
  onDepartment,
  onSearch,
  cart,
}: {
  state: TillState;
  catalog: Catalog | null;
  layout: TillLayout;
  onAdd(productId: string): void;
  onDepartment(id: string | null): void;
  onSearch(text: string): void;
  cart: CartActions;
}) {
  const [cartOpen, setCartOpen] = useState(false);
  // "תג i": the product whose details are open (a tap on the "i", never on the tile, opens them).
  const [infoId, setInfoId] = useState<string | null>(null);
  const sell = state.sell;
  const products = catalog ? filterProducts(catalog, sell.departmentId, sell.search) : [];
  const info = infoId ? (catalog?.products.find((p) => p.id === infoId) ?? null) : null;
  const infoPanel = info ? (
    <ProductInfo
      product={info}
      department={catalog?.departments.find((d) => d.id === info.departmentId) ?? null}
      sheet={layout.panes === 'single'}
      onAdd={onAdd}
      onClose={() => setInfoId(null)}
    />
  ) : null;
  const catalogPane = (
    <section className="t-catalog" aria-label={T.sell}>
      <div className="t-catalog-bar">
        <div className="t-departments" role="tablist">
          <button type="button" role="tab" aria-selected={sell.departmentId === null} className={`t-chip${sell.departmentId === null ? ' t-chip-on' : ''}`} onClick={() => onDepartment(null)}>
            {T.allDepartments}
          </button>
          {(catalog?.departments ?? []).map((d) => (
            <button key={d.id} type="button" role="tab" aria-selected={sell.departmentId === d.id} className={`t-chip${sell.departmentId === d.id ? ' t-chip-on' : ''}`} onClick={() => onDepartment(d.id)}>
              {d.name}
            </button>
          ))}
        </div>
        <input className="t-search" type="search" inputMode="search" placeholder={T.searchPlaceholder} value={sell.search} onChange={(e) => onSearch(e.target.value)} />
      </div>
      <ProductGrid
        products={products}
        departments={catalog?.departments ?? []}
        columns={layout.columns}
        tileHeight={layout.tileHeightDp}
        productText={displayProductText(state.display)}
        onAdd={onAdd}
        onInfo={setInfoId}
      />
    </section>
  );

  if (layout.panes === 'side') {
    return (
      <div className="t-sell t-sell-side" style={{ gridTemplateColumns: `minmax(0, 1fr) ${layout.cartWidthDp}px` }}>
        {catalogPane}
        <CartPane sell={sell} actions={cart} />
        {infoPanel}
      </div>
    );
  }
  if (layout.panes === 'stacked') {
    const cartPct = Math.round(layout.cartHeightFraction * 100);
    return (
      <div className="t-sell t-sell-stacked" style={{ gridTemplateRows: `minmax(0, 1fr) ${cartPct}%` }}>
        {catalogPane}
        <CartPane sell={sell} actions={cart} compact />
        {infoPanel}
      </div>
    );
  }
  // One pane: the catalogue, the cart behind a bar (opened over it).
  return (
    <div className="t-sell t-sell-single">
      {cartOpen ? (
        <div className="t-cart-sheet">
          <button type="button" className="t-btn t-btn-ghost" onClick={() => setCartOpen(false)}>
            {T.back}
          </button>
          <CartPane sell={sell} actions={cart} />
        </div>
      ) : (
        catalogPane
      )}
      {!cartOpen ? (
        <button type="button" className="t-cart-bar" onClick={() => setCartOpen(true)}>
          <span>
            {T.cart} · {sell.itemCount} {T.items}
          </span>
          <strong>{money(sell.totalAgorot)}</strong>
        </button>
      ) : null}
      {infoPanel}
    </div>
  );
}
