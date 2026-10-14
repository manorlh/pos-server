/**
 * The item's details the tile's "i" opens (P:/specs/product-tile-text.md §4; the APK's
 * ui/sell/ProductInfoSheet.kt): a bottom sheet on a phone / handheld, a small window on a tablet or a
 * PC — the full name and its department, the whole description, the price (or its range, and the
 * sizes / variants), the dietary tags and allergens, the picture, "אזל" / "חסום" with the reason, and
 * "הוסף לסל" — the tile's own tap (`sell.add`): the engine refuses or asks, as for a tap.
 */

import { priceRangeText } from '@dash-lib/productTileText';
import type { Department, Product } from '../../../../shared/till/protocol';
import { ALLERGEN_HE, DIETARY_HE, money, T } from '../text';

export function ProductInfo({
  product,
  department,
  sheet,
  onAdd,
  onClose,
}: {
  product: Product;
  department: Department | null;
  /** A bottom sheet (phone, handheld) rather than a window. */
  sheet: boolean;
  onAdd(productId: string): void;
  onClose(): void;
}) {
  const variants = product.variants ?? [];
  const price = priceRangeText(variants.length ? variants.map((v) => v.priceAgorot) : [product.priceAgorot], money);
  const description = product.description?.trim() ?? '';
  const dietary = product.dietaryTags ?? [];
  const allergens = product.allergens ?? [];
  return (
    <div className="t-info-scrim" role="presentation" onClick={onClose}>
      <div className={`t-info ${sheet ? 't-info-sheet' : 't-info-window'}`} role="dialog" aria-modal="true" aria-label={product.name} onClick={(e) => e.stopPropagation()}>
        {product.imageUrl ? <img className="t-info-image" src={product.imageUrl} alt="" /> : null}
        <div className="t-info-body">
          <div className="t-info-head">
            <div className="t-info-title">
              <h2 className="t-info-name">{product.name}</h2>
              {department ? <div className="t-info-department">{department.name}</div> : null}
            </div>
            <button type="button" className="t-btn t-btn-ghost" onClick={onClose}>
              {T.close}
            </button>
          </div>
          {product.blocked ? (
            <p className="t-info-flag">
              {product.blocked.kind === 'blocked' ? T.blocked : T.soldOut}
              {product.blocked.reason ? ` · ${product.blocked.reason}` : ''}
            </p>
          ) : null}
          <p className={`t-info-description${description ? '' : ' t-info-muted'}`}>{description || T.noDescription}</p>
          <div className="t-info-price">
            <span className="t-info-label">{variants.length > 1 ? T.priceRange : T.price}</span>
            <strong dir="ltr">{price}</strong>
          </div>
          {variants.length > 0 ? (
            <div className="t-info-group">
              <span className="t-info-label">{T.variants}</span>
              <ul className="t-info-variants">
                {variants.map((v) => (
                  <li key={v.name}>
                    <span>{v.name}</span>
                    <span dir="ltr">{money(v.priceAgorot)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {dietary.length > 0 ? (
            <div className="t-info-group">
              <span className="t-info-label">{T.dietary}</span>
              <span className="t-info-tags">
                {dietary.map((tag) => (
                  <span key={tag} className="t-info-tag">
                    {DIETARY_HE[tag] ?? tag}
                  </span>
                ))}
              </span>
            </div>
          ) : null}
          {allergens.length > 0 ? (
            <div className="t-info-group">
              <span className="t-info-label">{T.allergens}</span>
              <span className="t-info-allergens">{allergens.map((a) => ALLERGEN_HE[a] ?? a).join(', ')}</span>
            </div>
          ) : null}
          <button
            type="button"
            className="t-btn t-btn-primary t-btn-wide t-info-add"
            onClick={() => {
              onAdd(product.id);
              onClose();
            }}
          >
            {T.addToCart}
          </button>
        </div>
      </div>
    </div>
  );
}
