/**
 * The sell screen: departments, search, the product grid and the cart — laid out by the display
 * profile (side by side, stacked, or one pane with the cart behind a bar on a handheld). The
 * department and the search are the engine's state too (`sell.department`, `sell.search`).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Catalog, Product, TillState } from '../../../../shared/till/protocol';
import type { TillLayout } from '../layout/tillLayout';
import { CartPane, type CartActions, type CartView, type QuickButton } from '../parts/CartPane';
import type { TillDesignView } from '../../../../core/till/tillDesign';
import { ProductGrid } from '../parts/ProductGrid';
import { money, T } from '../text';
import { useSystemDark } from '../theme/tillTheme';
import { Icon } from '../theme/icons';
import { orderedCatalog, shownProducts } from '../design/designLayout';
import { DesignedSell, type DesignOps } from '../design/DesignedSell';
import { FlowHome } from '../design/FlowHome';
import { DT } from '../design/designText';
import { categoryBarOf } from '../../../../core/till/sellAllTab';

/** From this many pills the folded row offers "כל המחלקות ▾" (Android TABLET_CATEGORY_ALL_FROM). */
export const CATEGORY_ALL_FROM = 4;

export function filterProducts(catalog: Catalog, departmentId: string | null, search: string) {
  const q = search.trim();
  return catalog.products.filter((p) => (departmentId === null || p.departmentId === departmentId) && (q === '' || p.name.includes(q) || p.barcode === q || p.sku === q));
}

/**
 * A scanned (or typed) text that is a voucher's code — its QR's "PV:" + code, or the code itself as printed ("ABCD-EFGH-
 * 2345-6789": 16 of the cloud's unambiguous alphabet, a letter among them) — tried as a voucher when no product has it.
 */
export function looksLikeVoucher(text: string): boolean {
  const t = text.trim();
  if (/^pv:/i.test(t)) return true;
  const code = t.replace(/[\s-]+/g, '').toUpperCase();
  return /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{16}$/.test(code) && /[A-Z]/.test(code);
}

/** What a scanner typed + Enter: the product whose barcode, then SKU, is exactly that (core/kioskScan.ts's order). */
export function scanned(catalog: Catalog, text: string) {
  const q = text.trim();
  if (!q) return null;
  return catalog.products.find((p) => p.barcode === q) ?? catalog.products.find((p) => p.sku === q) ?? null;
}

export function SellScreen({
  state,
  catalog,
  layout,
  onAdd,
  onDepartment,
  onSearch,
  onVoucher,
  onHold,
  cart,
  shiftOpen = true,
  goShift,
  cartView,
  identity = null,
  design = null,
  quick,
  ops,
  onMenu,
  onFlowHome,
}: {
  state: TillState;
  catalog: Catalog | null;
  layout: TillLayout;
  onAdd(productId: string): void;
  onDepartment(id: string | null): void;
  onSearch(text: string): void;
  /** A voucher scanned with items in the order: the payment opens and applies it (`sell.voucher`); absent — none here. */
  onVoucher?(code: string): void;
  /** A tile held 7 s: its "חסום / אזל" sheet (absent: none). */
  onHold?(productId: string): void;
  cart: CartActions;
  /** No shift: the till says why it cannot charge and offers the way to open one (Android sell_no_shift). */
  shiftOpen?: boolean;
  goShift?(): void;
  /** What the cart shows for this operator (hidden options, OTH on, held sales). */
  cartView?: CartView;
  /** "הקופה · קופה 3" above the products (Android TillIdentityLine); null — none. */
  identity?: string | null;
  /** "עיצוב קופה" for this window's profile (core/till/tillDesign.ts designFor); null — none held (today's screen). */
  design?: TillDesignView | null;
  /** A quick-bar button (CartPane's QuickButton) — the designed screens' bar too. */
  quick?(button: QuickButton): void;
  /** The engine's ops the designed screens add (DesignOps: an add with a quantity, the order's details, a held sale back, a park). */
  ops?: DesignOps;
  /** "הדבורה": the flow home's "☰" — the till's menu (absent: none). */
  onMenu?(): void;
  /** "הדבורה": whether its home is on screen (Android draws it without the island). */
  onFlowHome?(home: boolean): void;
}) {
  const [cartOpen, setCartOpen] = useState(false);
  /** "כל המחלקות ▾": every category in sight, wrapped (Android TabletCategoryBar's open state). */
  const [catsOpen, setCatsOpen] = useState(false);
  /** The "i" window's item (P:/specs/product-tile-text.md §4). */
  const [info, setInfo] = useState<Product | null>(null);
  const sell = state.sell;
  // "עיצוב קופה" menu (design.menu): the departments and products in its order, a hidden department off the tabs — on
  // every template, clean included (Android MenuOrder).
  const ordered = useMemo(() => (catalog ? orderedCatalog(catalog, design?.menu) : null), [catalog, design?.menu]);
  const departments = ordered?.departments ?? [];
  // "הכל" as the parameter puts it (Android SellAllTab — hidden by default: the order opens on the first category). The
  // order opening (nothing in it yet, nothing tapped) takes the mode's opening rule; a tapped tab stands.
  const [chosen, setChosen] = useState(false);
  const opening = useRef(sell.lines.length === 0);
  useEffect(() => {
    const empty = sell.lines.length === 0;
    if (empty && !opening.current) setChosen(false);
    opening.current = empty;
  }, [sell.lines.length]);
  const bar = categoryBarOf(
    state.sellAllTab ?? 'hidden',
    departments.map((d) => d.id),
    sell.departmentId,
    chosen,
    (catalog?.departments ?? []).map((d) => d.id),
  );
  const pickDepartment = (id: string | null) => {
    setChosen(true);
    onDepartment(id);
  };
  // The order's count per product, for the tiles' badges.
  const inCart = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of sell.lines) if (!l.refund) m.set(l.productId, (m.get(l.productId) ?? 0) + l.qty);
    return m;
  }, [sell.lines]);
  const products = catalog && ordered ? shownProducts(catalog.products, ordered.products, bar.selected, sell.search) : [];
  // "הדבורה" (flow): the orders' home first; an order opened (or the one on the screen) shows the order screen, and a
  // sale done or cleared goes home again.
  const flow = design?.shell === 'flow';
  const [flowHome, setFlowHome] = useState(true);
  const flowHomeShown = design?.shell === 'flow' && flowHome;
  useEffect(() => {
    onFlowHome?.(flowHomeShown);
  }, [flowHomeShown, onFlowHome]);
  const hadLines = useRef(sell.lines.length > 0);
  useEffect(() => {
    const has = sell.lines.length > 0;
    if (flow && hadLines.current && !has) setFlowHome(true);
    hadLines.current = has;
  }, [flow, sell.lines.length]);
  const systemDark = useSystemDark();
  const searchInput = (className: string, autoFocus: boolean) => (
    <input
      className={className}
      type="search"
      inputMode="search"
      autoFocus={autoFocus}
      placeholder={design && design.drawn !== 'clean' ? DT.searchHint : T.productSearch}
      value={sell.search}
      onChange={(e) => onSearch(e.target.value)}
      onKeyDown={(e) => {
        // A USB scanner types the code and presses Enter: the product goes in and the box is cleared.
        if (e.key !== 'Enter' || !catalog) return;
        const p = scanned(catalog, sell.search);
        if (p) {
          onAdd(p.id);
          onSearch('');
        } else if (onVoucher && sell.lines.some((l) => !l.refund) && looksLikeVoucher(sell.search)) {
          // "בחרתי פריטים > סרקתי שובר": to the payment, where the voucher is applied.
          onVoucher(sell.search.trim());
          onSearch('');
        }
      }}
    />
  );
  const infoWindow = info ? (
    <ItemInfo
      product={info}
      department={(catalog?.departments ?? []).find((d) => d.id === info.departmentId)?.name ?? null}
      onAdd={() => {
        onAdd(info.id);
        setInfo(null);
      }}
      onClose={() => setInfo(null)}
    />
  ) : null;

  if (flow && design && flowHome) {
    const mode = state.theme?.mode;
    const dark = design.drawn === 'night' || (mode === 'dark' ? true : mode === 'light' ? false : systemDark);
    return (
      <FlowHome
        state={state}
        design={design}
        dark={dark}
        brand={state.theme?.brand ?? null}
        onOrder={() => setFlowHome(false)}
        onMenu={onMenu}
        onHeldSheet={cart.held}
        ops={ops}
      />
    );
  }
  const onBack = flow ? () => setFlowHome(true) : undefined;

  if (design && design.drawn !== 'clean') {
    return (
      <>
        <DesignedSell
          state={state}
          catalog={catalog}
          departments={departments}
          tabs={bar.tabs}
          selected={bar.selected}
          products={products}
          design={design}
          cart={cart}
          cartView={cartView ?? {}}
          quick={quick}
          onAdd={onAdd}
          onDepartment={pickDepartment}
          onSearch={onSearch}
          onHold={onHold}
          onInfo={setInfo}
          searchInput={searchInput}
          shiftOpen={shiftOpen}
          goShift={goShift}
          ops={ops}
          onBack={onBack}
        />
        {infoWindow}
      </>
    );
  }

  const catalogPane = (
    <section className="t-catalog" aria-label={T.sell}>
      {onBack ? (
        <button type="button" className="d-flow-back" onClick={onBack}>
          <Icon name="arrowBack" size={20} />
          <span>{DT.flowOrders}</span>
        </button>
      ) : null}
      {identity && layout.panes !== 'single' ? <div className="t-identity">{identity}</div> : null}
      {/* The tablet's catalogue (Android TabletCatalog.kt): "חיפוש מוצר" across the pane with its picture, then the
          category pills — one row that scrolls, "כל המחלקות ▾" opening them all (wrapped), "פחות ▴" folding back. */}
      <div className="t-search-row">
        <Icon name="search" />
        {searchInput('t-search', false)}
      </div>
      <div className={`t-catalog-bar${catsOpen ? ' t-catalog-bar-open' : ''}`}>
        <div className="t-departments" role="tablist">
          {bar.tabs.map((id) => (
            <button
              key={id ?? 'all'}
              type="button"
              role="tab"
              aria-selected={bar.selected === id}
              className={`t-chip${bar.selected === id ? ' t-chip-on' : ''}`}
              onClick={() => {
                pickDepartment(id);
                setCatsOpen(false);
              }}
            >
              {id === null ? T.allDepartments : departments.find((d) => d.id === id)?.name}
            </button>
          ))}
          {catsOpen ? (
            <button type="button" className="t-chip t-chip-fold" onClick={() => setCatsOpen(false)}>
              {T.categoriesLess} ▴
            </button>
          ) : null}
        </div>
        {!catsOpen && bar.tabs.length >= CATEGORY_ALL_FROM ? (
          <button type="button" className="t-chip t-chip-fold" onClick={() => setCatsOpen(true)}>
            {T.categoriesAll} ▾
          </button>
        ) : null}
      </div>
      {!shiftOpen ? (
        <div className="t-warn" role="note">
          <p>
            {T.noShift}. {T.noShiftBlocksSale}
          </p>
          {goShift ? (
            <button type="button" className="t-btn t-btn-small" onClick={goShift}>
              {T.openShift}
            </button>
          ) : null}
        </div>
      ) : null}
      <ProductGrid
        products={products}
        departments={departments}
        columns={layout.columns}
        tileHeight={layout.tileHeightDp}
        onAdd={onAdd}
        onInfo={setInfo}
        onHold={onHold}
        tileText={state.tileText}
        inCart={inCart}
        namePx={layout.cls === 'HANDHELD' ? 16 : design?.tileSize === 'xs' || design?.tileSize === 's' ? 18 : 22}
      />
      {infoWindow}
    </section>
  );

  if (layout.panes === 'side') {
    return (
      <div className="t-sell t-sell-side" style={{ gridTemplateColumns: `minmax(0, 1fr) ${layout.cartWidthDp}px` }}>
        {catalogPane}
        <CartPane sell={sell} actions={cart} view={cartView} />
      </div>
    );
  }
  if (layout.panes === 'stacked') {
    const cartPct = Math.round(layout.cartHeightFraction * 100);
    return (
      <div className="t-sell t-sell-stacked" style={{ gridTemplateRows: `minmax(0, 1fr) ${cartPct}%` }}>
        {catalogPane}
        <CartPane sell={sell} actions={cart} compact view={cartView} />
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
          <CartPane sell={sell} actions={cart} view={cartView} />
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
    </div>
  );
}

/**
 * The "i" window (P:/specs/product-tile-text.md §4): the full name and its department, the full description, the price,
 * the dietary tags and allergens, "אזל" / "חסום" with why, and "הוסף לסל" — which is a tap on the tile (the engine's gates
 * and approvals as always).
 */
export function ItemInfo({ product: p, department, onAdd, onClose }: { product: Product; department: string | null; onAdd(): void; onClose(): void }) {
  const state = p.sale === 'blocked' ? T.blockedBadge : p.sale === 'unavailable' ? T.unavailableBadge : p.sale === 'sold_out' ? T.soldOutBadge : null;
  return (
    <div className="t-overlay t-sheet-wrap" role="dialog" aria-modal="true" aria-label={T.itemInfo} onClick={onClose}>
      <div className="t-dialog t-sheet t-item-info" onClick={(e) => e.stopPropagation()}>
        <h2 className="t-dialog-title">{p.name}</h2>
        {department ? <p className="t-muted t-small">{department}</p> : null}
        <p className="t-dialog-body t-item-desc">{p.description ?? T.infoNoDescription}</p>
        <p className="t-item-price">{money(p.priceAgorot)}</p>
        {p.dietary && p.dietary.length > 0 ? (
          <p className="t-small">
            {T.infoDietary}: {p.dietary.join(' · ')}
          </p>
        ) : null}
        {p.allergens && p.allergens.length > 0 ? (
          <p className="t-small">
            {T.infoAllergens}: {p.allergens.join(' · ')}
          </p>
        ) : null}
        {state ? (
          <p className="t-warn t-small" role="note">
            {state}
            {p.saleReason ? ` — ${p.saleReason}` : ''}
          </p>
        ) : null}
        <button type="button" className="t-btn t-btn-primary t-btn-wide" onClick={onAdd}>
          {T.infoAdd}
        </button>
        <div className="t-dialog-actions">
          <button type="button" className="t-btn t-btn-ghost" onClick={onClose}>
            {T.infoClose}
          </button>
        </div>
      </div>
    </div>
  );
}
