/**
 * The sell screen: departments, search, the product grid and the cart — laid out by the display
 * profile (side by side, stacked, or one pane with the cart behind a bar on a handheld). The
 * department and the search are the engine's state too (`sell.department`, `sell.search`).
 */

import { useState } from 'react';
import type { Catalog, Product, TillState } from '../../../../shared/till/protocol';
import type { TillLayout } from '../layout/tillLayout';
import { CartPane, type CartActions, type CartView } from '../parts/CartPane';
import { ProductGrid } from '../parts/ProductGrid';
import { money, T } from '../text';
import { CHOICES_TEXT } from '../../../../core/till/choices';
import { slipCode } from '../../../../core/till/kioskOrders';
import { ScreenEditBar, ScreenEditCategoryRow, type ScreenEditActions } from '../parts/ScreenEditOverlay';
import type { ScreenEditState } from '../../../../core/till/screenEdit';

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
  onCustomize,
  onKioskSlip,
  screenEdit,
  onDepartment,
  onSearch,
  onVoucher,
  onHold,
  cart,
  shiftOpen = true,
  goShift,
  cartView,
}: {
  state: TillState;
  catalog: Catalog | null;
  layout: TillLayout;
  onAdd(productId: string): void;
  /** "התאמה אישית": a product with something to choose opens its sheet from the "i" window. */
  onCustomize?(productId: string): void;
  /** "תשלום בקופה": a kiosk's slip ("KO:…") scanned — its order opens to be paid. */
  onKioskSlip?(code: string): void;
  /** "עריכת מסך" (core/till/screenEdit.ts): the tiles and the categories arranged in place. */
  screenEdit?: { view: ScreenEditState; actions: ScreenEditActions & { move(fromId: string, toId: string, shown: string[]): void; lock(productId: string, locked: boolean): void } } | null;
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
}) {
  const [cartOpen, setCartOpen] = useState(false);
  /** The "i" window's item (P:/specs/product-tile-text.md §4). */
  const [info, setInfo] = useState<Product | null>(null);
  const sell = state.sell;
  const products = catalog ? filterProducts(catalog, sell.departmentId, sell.search) : [];
  const catalogPane = (
    <section className="t-catalog" aria-label={T.sell}>
      <div className="t-catalog-bar">
        {screenEdit?.view.on ? (
          // "עריכת מסך": the categories are arranged in their own row, in place of the tabs.
          <ScreenEditCategoryRow departments={catalog?.departments ?? []} selectedId={sell.departmentId} allLabel={T.allDepartments} onSelect={onDepartment} onMove={screenEdit.actions.moveCategory} />
        ) : (
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
        )}
        <input
          className="t-search"
          type="search"
          inputMode="search"
          placeholder={T.searchOrScan}
          value={sell.search}
          onChange={(e) => onSearch(e.target.value)}
          onKeyDown={(e) => {
            // A USB scanner types the code and presses Enter: the product goes in and the box is cleared.
            if (e.key !== 'Enter' || !catalog) return;
            // A kiosk's slip is not a product: its order opens to be paid (SellViewModel's KioskOpenOrderCode).
            if (onKioskSlip && slipCode(sell.search)) {
              onKioskSlip(sell.search.trim());
              onSearch('');
              return;
            }
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
      {screenEdit?.view.on ? <ScreenEditBar view={screenEdit.view} actions={screenEdit.actions} /> : null}
      <ProductGrid
        arrange={screenEdit?.view.on ? { onMove: screenEdit.actions.move, onLock: screenEdit.actions.lock, busyId: screenEdit.view.lockBusy } : undefined}
        products={products}
        departments={catalog?.departments ?? []}
        columns={layout.columns}
        tileHeight={layout.tileHeightDp}
        onAdd={onAdd}
        onInfo={setInfo}
        onHold={onHold}
        tileText={state.tileText}
      />
      {info ? (
        <ItemInfo
          product={info}
          department={(catalog?.departments ?? []).find((d) => d.id === info.departmentId)?.name ?? null}
          onAdd={() => {
            onAdd(info.id);
            setInfo(null);
          }}
          onCustomize={
            onCustomize && info.choices && (info.choices.groupIds.length > 0 || (info.choices.meal?.length ?? 0) > 0)
              ? () => {
                  onCustomize(info.id);
                  setInfo(null);
                }
              : undefined
          }
          onClose={() => setInfo(null)}
        />
      ) : null}
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
export function ItemInfo({ product: p, department, onAdd, onCustomize, onClose }: { product: Product; department: string | null; onAdd(): void; onCustomize?: () => void; onClose(): void }) {
  const state = p.sale === 'blocked' ? T.blockedBadge : p.sale === 'unavailable' ? T.unavailableBadge : p.sale === 'sold_out' ? T.soldOutBadge : null;
  return (
    <div className="t-overlay" role="dialog" aria-modal="true" aria-label={T.itemInfo} onClick={onClose}>
      <div className="t-dialog t-item-info" onClick={(e) => e.stopPropagation()}>
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
        {onCustomize ? (
          // The tile's "+" on the Android till ("התאמה אישית"): the dish's sheet or the meal builder.
          <button type="button" className="t-btn t-btn-wide" onClick={onCustomize}>
            {CHOICES_TEXT.customize}
          </button>
        ) : null}
        <div className="t-dialog-actions">
          <button type="button" className="t-btn t-btn-ghost" onClick={onClose}>
            {T.infoClose}
          </button>
        </div>
      </div>
    </div>
  );
}
