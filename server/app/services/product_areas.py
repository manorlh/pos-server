"""
"שיוך מוצר לנקודות מכירה" (P:/specs/chain-areas.md §6): in which points of sale of a shop a product is sold.

**Where it lives.** On the shop's assortment row, `shop_product_overrides.area_ids` — the shop already decides
whether it sells a global product (`is_listed`) and at what price; *where in the shop* is the same decision one
level down. Null = every point of sale (today, and every row before this). A list = only those points of sale.

**What a device gets.** A device standing in a point of sale the row does not name gets the product *unlisted*
(`shopListed` false, `inStock` false) — hidden, exactly like a product the shop does not sell; never "locked"
(that is availability, a separate thing). A device standing in no point of sale is not narrowed: it gets every
product the shop sells (`sold_in_area`). A device moved between points of sale gets its new list on the next pull
(`pos_machines.area_changed_at` already moves every row's `updatedAt`).

**Writing** (`set_areas`): the selection is normalised — every live point of sale of the shop → null; none →
the shop stops selling the product (`is_listed` false), since "sold nowhere in the shop" is that. Adding a point of
sale to a product the shop does not sell lists it there only. A manager of points of sale
(app/services/area_scope.py) changes only their own points of sale: the points of sale whose membership changes
must all be theirs (`AREA_NOT_YOURS`), whatever else the row holds.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.product import Product
from app.models.shop import Shop
from app.models.shop_area import ShopArea
from app.models.shop_product_override import ShopProductOverride

#: 4xx details.
AREA_NOT_IN_SHOP = "area_not_in_shop"
AREA_ARCHIVED = "area_archived"
AREA_NOT_YOURS = "outside_your_points_of_sale"
NO_AREAS = "shop_has_no_areas"
MAX_BULK = 500


def _uuid(value: Any) -> Optional[uuid.UUID]:
    if value is None or isinstance(value, uuid.UUID):
        return value
    try:
        return uuid.UUID(str(value))
    except (TypeError, ValueError):
        return None


def stored_ids(row: Optional[ShopProductOverride]) -> Optional[Set[str]]:
    """The row's points of sale as strings, or None (every point of sale)."""
    raw = getattr(row, "area_ids", None) if row is not None else None
    if not isinstance(raw, (list, tuple)):
        return None
    out = {str(p) for p in (_uuid(v) for v in raw) if p is not None}
    return out if out else None


def sold_in_area(row: Optional[ShopProductOverride], area_id: Any) -> bool:
    """Is the row's product sold on a device standing in `area_id` (None = in no point of sale)?"""
    if area_id is None:
        return True
    ids = stored_ids(row)
    return ids is None or str(area_id) in ids


def live_areas(db: Session, shop_id: Any) -> List[ShopArea]:
    return (
        db.query(ShopArea)
        .filter(ShopArea.shop_id == _uuid(shop_id), ShopArea.archived_at.is_(None))
        .order_by(ShopArea.sort_order, ShopArea.name)
        .all()
    )


def effective_ids(row: Optional[ShopProductOverride], areas: Sequence[ShopArea]) -> Set[str]:
    """The points of sale (of `areas`, the shop's live ones) where the row's product is sold now."""
    if row is None or not row.is_listed:
        return set()
    ids = stored_ids(row)
    every = {str(a.id) for a in areas}
    return every if ids is None else (ids & every)


def _bad(detail: str, code: int = status.HTTP_400_BAD_REQUEST) -> HTTPException:
    return HTTPException(status_code=code, detail=detail)


@dataclass
class Change:
    shop_id: uuid.UUID
    product_id: uuid.UUID
    before: Set[str]
    after: Set[str]

    @property
    def changed(self) -> bool:
        return self.before != self.after


def _validate(db: Session, shop: Shop, wanted: Iterable[Any]) -> Set[str]:
    out: Set[str] = set()
    ids = [_uuid(v) for v in wanted or ()]
    if any(i is None for i in ids):
        raise _bad(AREA_NOT_IN_SHOP)
    if not ids:
        return out
    rows = {a.id: a for a in db.query(ShopArea).filter(ShopArea.id.in_(ids)).all()}
    for i in ids:
        area = rows.get(i)
        if area is None or area.shop_id != shop.id:
            raise _bad(f"{AREA_NOT_IN_SHOP}:{i}")
        if area.archived_at is not None:
            raise _bad(f"{AREA_ARCHIVED}:{i}", status.HTTP_409_CONFLICT)
        out.add(str(i))
    return out


def _row(db: Session, shop: Shop, product: Product) -> Optional[ShopProductOverride]:
    return (
        db.query(ShopProductOverride)
        .filter(ShopProductOverride.shop_id == shop.id, ShopProductOverride.global_product_id == product.id)
        .first()
    )


def plan(
    db: Session,
    user: Any,
    shop: Shop,
    product: Product,
    *,
    area_ids: Optional[Iterable[Any]] = None,
    add: Iterable[Any] = (),
    remove: Iterable[Any] = (),
) -> Change:
    """
    What setting the product's points of sale in `shop` changes: `area_ids` (the whole selection; None with no
    `add`/`remove` = every point of sale) or `add` / `remove` on top of what it is now. Refuses a point of sale
    of another shop, an archived one, and — for a manager of points of sale — any change outside theirs.
    """
    from app.services import area_scope

    areas = live_areas(db, shop.id)
    if not areas:
        raise _bad(NO_AREAS, status.HTTP_409_CONFLICT)
    every = {str(a.id) for a in areas}
    row = _row(db, shop, product)
    before = effective_ids(row, areas)
    add_ids = _validate(db, shop, add)
    remove_ids = _validate(db, shop, remove)
    if area_ids is None and not add_ids and not remove_ids:
        after = set(every)
    elif area_ids is not None:
        after = _validate(db, shop, area_ids)
    else:
        after = set(before)
    after = (after | add_ids) - remove_ids
    reach = area_scope.reach_of(db, user)
    if reach.narrowed:
        mine = {str(a) for a in reach.area_ids}
        if (before ^ after) - mine:
            raise _bad(AREA_NOT_YOURS, status.HTTP_403_FORBIDDEN)
    return Change(shop_id=shop.id, product_id=product.id, before=before, after=after)


def apply(db: Session, shop: Shop, product: Product, change: Change) -> Optional[ShopProductOverride]:
    """Write a planned change (no commit). Returns the row (None when nothing was there and nothing is sold)."""
    if not change.changed:
        return _row(db, shop, product)
    areas = live_areas(db, shop.id)
    every = {str(a.id) for a in areas}
    row = _row(db, shop, product)
    if not change.after:
        if row is not None and row.is_listed:
            from app.services import general_item

            general_item.refuse_general_item_unlist(product)
            row.is_listed = False
            row.area_ids = None
            row.assigned_by_rule = False
        return row
    stored = None if change.after >= every else sorted(change.after)
    if row is None:
        row = ShopProductOverride(
            shop_id=shop.id, global_product_id=product.id, is_listed=True, area_ids=stored,
        )
        db.add(row)
        return row
    if not row.is_listed:
        row.is_listed = True
        row.assigned_by_rule = False
    # A new list object, so the JSON column is seen as changed (and `updated_at` moves: the tills' delta).
    row.area_ids = list(stored) if stored is not None else None
    return row


def default_for_new(db: Session, user: Any, shop_id: Any, chosen: Optional[Iterable[Any]]) -> Optional[List[str]]:
    """
    The points of sale a new product starts in at `shop_id`: what the editor chose (the top bar's point of sale),
    else a manager of points of sale's own points of sale of that shop, else None (every point of sale).
    """
    from app.services import area_scope

    if chosen:
        wanted = {str(p) for p in (_uuid(v) for v in chosen) if p is not None}
        rows = db.query(ShopArea.id).filter(
            ShopArea.id.in_([uuid.UUID(w) for w in wanted]), ShopArea.shop_id == _uuid(shop_id),
            ShopArea.archived_at.is_(None),
        ).all()
        picked = sorted(str(r[0]) for r in rows)
        if picked:
            return picked
    return area_scope.default_area_ids_for_new(db, user, shop_id)


def view(db: Session, user: Any, product: Product, shops: Sequence[Shop]) -> List[Dict[str, Any]]:
    """`GET /products/{id}/areas`: per shop the user reaches, its live points of sale and where it is sold."""
    from app.services import area_scope

    reach = area_scope.reach_of(db, user)
    rows = {
        r.shop_id: r
        for r in db.query(ShopProductOverride).filter(
            ShopProductOverride.global_product_id == product.id,
            ShopProductOverride.shop_id.in_([s.id for s in shops] or [uuid.uuid4()]),
        )
    }
    out: List[Dict[str, Any]] = []
    for shop in shops:
        if not reach.covers_shop(shop.id):
            continue
        areas = live_areas(db, shop.id)
        if not areas:
            continue
        row = rows.get(shop.id)
        sold = effective_ids(row, areas)
        out.append({
            "shopId": str(shop.id),
            "shopName": shop.name,
            "listed": bool(row is not None and row.is_listed),
            "allAreas": bool(row is not None and row.is_listed and stored_ids(row) is None),
            "areas": [
                {
                    "id": str(a.id),
                    "name": a.name,
                    "sold": str(a.id) in sold,
                    "editable": reach.covers_area(a.id),
                }
                for a in areas
            ],
        })
    return out


# ── Till users' points of sale (P:/specs/chain-areas.md §8) ──────────────────


def clean_user_areas(db: Session, shop_id: Any, wanted: Optional[Iterable[Any]]) -> Optional[List[str]]:
    """A till user's points of sale: live ones of their shop (400 otherwise); none / every one → None."""
    if wanted is None:
        return None
    shop = db.get(Shop, _uuid(shop_id))
    if shop is None:
        raise _bad("shop_not_found", status.HTTP_404_NOT_FOUND)
    ids = _validate(db, shop, wanted)
    if not ids:
        return None
    return sorted(ids)


def check_user_areas_write(db: Session, user: Any, before: Optional[Iterable[Any]], after: Optional[Iterable[Any]]) -> None:
    """
    A manager of points of sale edits only employees of their own points of sale, and keeps them there: both the
    employee's points of sale before and after must be theirs (an employee of the whole shop — none — is not).
    """
    from app.services import area_scope

    reach = area_scope.reach_of(db, user)
    if not reach.narrowed:
        return
    mine = {str(a) for a in reach.area_ids}
    for side in (before, after):
        ids = {str(a) for a in side} if side else set()
        if not ids or not ids <= mine:
            raise _bad(AREA_NOT_YOURS, status.HTTP_403_FORBIDDEN)
