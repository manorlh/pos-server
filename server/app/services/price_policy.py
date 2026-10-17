"""
Prices along the chain (P:/specs/chain-areas.md §9): which price a device sells at, who may change which, and the
log of every change.

**Resolution** (`resolve`): a point of sale's own price (`area_product_overrides.price`) → the shop's
(`shop_product_overrides.price`) → the chain's (`products.price`). An active menu's listed price still replaces
it on the till (catalog_menu_rules) — that is the menu's, not the catalog's.

**Who may change** (`check`): the company's "מי רשאי לשנות מחירים" (`price_policies.editors`):
`chain` — only the chain; `shop` — the chain and shop managers; `area` — and managers of points of sale (the
default, no row: today's behaviour). Per-shop exceptions, products / categories locked by the chain, and an
allowed range (± % of the chain's price) apply to everyone below the chain. Along a chain of companies (a
franchisee is a sub-company) every policy above the shop applies and the strictest wins: a franchisee cannot
open what the chain closed.

**The actor's level** (`actor_level`): `chain` — a super admin, a distributor, or a company manager whose company
scope covers the product's company and who is not narrowed to shops or points of sale; `area` — a manager of
points of sale (app/services/area_scope.py); otherwise `shop`. A till writes at the level it writes (a shop price
from a till is a `shop` change).
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from decimal import ROUND_HALF_UP, Decimal
from typing import Any, Dict, FrozenSet, List, Optional, Tuple

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.company import Company
from app.models.price_policy import PriceChange, PricePolicy
from app.models.product import Product
from app.models.product_availability_override import AreaProductOverride
from app.models.shop import Shop
from app.models.shop_area import ShopArea
from app.models.shop_product_override import ShopProductOverride
from app.models.user import UserRole

CHAIN, SHOP, AREA = "chain", "shop", "area"
EDITORS = (CHAIN, SHOP, AREA)
_RANK = {CHAIN: 0, SHOP: 1, AREA: 2}
LEVEL_BASE = "base"
LEVELS = (LEVEL_BASE, SHOP, AREA)

EDITORS_LABELS = {
    CHAIN: "רק הרשת",
    SHOP: "הרשת ומנהלי סניפים",
    AREA: "הרשת, מנהלי סניפים ומנהלי נקודות מכירה",
}

#: Hebrew refusals (the dashboard shows them as given).
MSG_CHAIN_ONLY = "מחירי המוצרים נקבעים ע״י הרשת"
MSG_SHOP_ONLY = "מחירים בנקודת מכירה נקבעים ע״י הרשת או מנהל הסניף"
MSG_LOCKED = "המחיר נעול ע״י הרשת"
MSG_BASE = "את מחיר הרשת משנה רק הרשת"


def _uuid(value: Any) -> Optional[uuid.UUID]:
    if value is None or isinstance(value, uuid.UUID):
        return value
    try:
        return uuid.UUID(str(value))
    except (TypeError, ValueError):
        return None


def _ids(raw: Any) -> FrozenSet[str]:
    if not isinstance(raw, (list, tuple)):
        return frozenset()
    return frozenset(str(p) for p in (_uuid(v) for v in raw) if p is not None)


def money(value: Any) -> Optional[Decimal]:
    if value is None:
        return None
    return Decimal(str(value)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


# ── Resolution ───────────────────────────────────────────────────────────────


def resolve(
    product: Any, shop_row: Optional[ShopProductOverride], area_row: Optional[AreaProductOverride]
) -> Tuple[float, str]:
    """`(price, level)` — the nearest price set: the point of sale's, the shop's, else the chain's."""
    area_price = getattr(area_row, "price", None) if area_row is not None else None
    if area_price is not None:
        return float(area_price), AREA
    shop_price = getattr(shop_row, "price", None) if shop_row is not None else None
    if shop_price is not None:
        return float(shop_price), SHOP
    return float(getattr(product, "price", 0) or 0), LEVEL_BASE


# ── The policy ───────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Policy:
    editors: str = AREA
    locked_products: FrozenSet[str] = field(default_factory=frozenset)
    locked_categories: FrozenSet[str] = field(default_factory=frozenset)
    max_delta_pct: Optional[Decimal] = None
    #: The companies whose rows made it (nearest first) — for the dashboard's "set by".
    sources: Tuple[str, ...] = ()

    def locks(self, product: Any) -> bool:
        return str(getattr(product, "id", "")) in self.locked_products or (
            getattr(product, "category_id", None) is not None
            and str(product.category_id) in self.locked_categories
        )

    def out(self) -> Dict[str, Any]:
        return {
            "editors": self.editors,
            "editorsLabel": EDITORS_LABELS[self.editors],
            "maxDeltaPct": float(self.max_delta_pct) if self.max_delta_pct is not None else None,
            "lockedProductIds": sorted(self.locked_products),
            "lockedCategoryIds": sorted(self.locked_categories),
        }


DEFAULT = Policy()


def _stricter(a: str, b: str) -> str:
    return a if _RANK[a] <= _RANK[b] else b


def company_chain(db: Session, company_id: Any) -> List[uuid.UUID]:
    out: List[uuid.UUID] = []
    seen = set()
    cid = _uuid(company_id)
    while cid is not None and cid not in seen:
        seen.add(cid)
        out.append(cid)
        row = db.query(Company.parent_company_id).filter(Company.id == cid).first()
        cid = row[0] if row else None
    return out


def effective(db: Session, *, company_id: Any = None, shop_id: Any = None) -> Policy:
    """The policy in force at a shop (its company and every company above), or a company alone."""
    shop = db.get(Shop, _uuid(shop_id)) if shop_id is not None else None
    start = shop.company_id if shop is not None else company_id
    chain = company_chain(db, start)
    if not chain:
        return DEFAULT
    rows = {r.company_id: r for r in db.query(PricePolicy).filter(PricePolicy.company_id.in_(chain)).all()}
    if not rows:
        return DEFAULT
    editors = AREA
    products: set = set()
    categories: set = set()
    delta: Optional[Decimal] = None
    sources: List[str] = []
    for cid in chain:
        row = rows.get(cid)
        if row is None:
            continue
        sources.append(str(cid))
        editors = _stricter(editors, row.editors if row.editors in EDITORS else AREA)
        if shop is not None and isinstance(row.shop_editors, dict):
            own = row.shop_editors.get(str(shop.id))
            if own in EDITORS:
                editors = _stricter(editors, own)
        products |= _ids(row.locked_product_ids)
        categories |= _ids(row.locked_category_ids)
        if row.max_delta_pct is not None:
            pct = Decimal(str(row.max_delta_pct))
            delta = pct if delta is None else min(delta, pct)
    return Policy(editors, frozenset(products), frozenset(categories), delta, tuple(sources))


# ── The actor ────────────────────────────────────────────────────────────────


def actor_level(db: Session, user: Any, product: Any) -> str:
    from app.services import area_scope
    from app.services.dashboard_access import profile_scope

    role = getattr(user, "role", None)
    if role in (UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR):
        return CHAIN
    if area_scope.narrowed(db, user):
        return AREA
    if role == UserRole.COMPANY_MANAGER:
        scope = profile_scope(db, user)
        if scope is not None and scope.shop_ids and not scope.org_wide and not scope.company_ids:
            return SHOP
        company_id = getattr(product, "company_id", None)
        if company_id is None:
            # A tenant-wide product: the chain is whoever covers the whole organization.
            return CHAIN if scope is not None and scope.org_wide else SHOP
        from app.services.company_hierarchy import user_covers_company

        return CHAIN if user_covers_company(db, user, company_id) else SHOP
    return SHOP


# ── The check ────────────────────────────────────────────────────────────────


def _refuse(reason: str, message: str, **extra: Any) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail={"code": "price_policy", "reason": reason, "message": message, **extra},
    )


def refusal(policy: Policy, *, actor: str, product: Any, level: str, new_price: Any) -> Optional[HTTPException]:
    """Why `actor` may not set `level`'s price of `product` to `new_price` under `policy` (None = may)."""
    if actor == CHAIN:
        return None
    if level == LEVEL_BASE:
        return _refuse("base_is_chain", MSG_BASE)
    if _RANK[actor] > _RANK[policy.editors]:
        return _refuse("editors", MSG_CHAIN_ONLY if policy.editors == CHAIN else MSG_SHOP_ONLY, editors=policy.editors)
    if policy.locks(product):
        return _refuse("locked", MSG_LOCKED)
    price = money(new_price)
    base = money(getattr(product, "price", None))
    if price is not None and policy.max_delta_pct is not None and base is not None:
        pct = policy.max_delta_pct
        low = money(base * (Decimal(100) - pct) / Decimal(100))
        high = money(base * (Decimal(100) + pct) / Decimal(100))
        if price < low or price > high:
            return _refuse(
                "range",
                f"המחיר מחוץ לטווח שהרשת התירה (±{pct.normalize():f}% ממחיר הרשת: ₪{low}–₪{high})",
                min=float(low), max=float(high),
            )
    return None


def check(db: Session, user: Any, product: Any, *, level: str, shop_id: Any, new_price: Any) -> None:
    """403 `price_policy` when the user may not set this price (whatever their permissions)."""
    policy = effective(db, company_id=getattr(product, "company_id", None), shop_id=shop_id)
    refused = refusal(policy, actor=actor_level(db, user, product), product=product, level=level, new_price=new_price)
    if refused is not None:
        raise refused


def check_till(db: Session, product: Any, *, shop_id: Any, new_price: Any, level: str = SHOP) -> None:
    """A price written from a till of `shop_id` — by the shop's staff, at the level it lands on (shop / area)."""
    policy = effective(db, shop_id=shop_id)
    refused = refusal(policy, actor=level, product=product, level=level, new_price=new_price)
    if refused is not None:
        raise refused


# ── The log ──────────────────────────────────────────────────────────────────


def record(
    db: Session,
    *,
    product: Any,
    level: str,
    target_id: Any,
    old: Any,
    new: Any,
    user: Any = None,
    pos_user_id: Any = None,
    machine: Any = None,
    source: str = "dashboard",
) -> Optional[PriceChange]:
    """One row per price that actually changed (no row for writing the same price)."""
    if money(old) == money(new):
        return None
    row = PriceChange(
        tenant_id=getattr(product, "tenant_id", None) or getattr(machine, "tenant_id", None),
        product_id=product.id,
        level=level,
        target_id=_uuid(target_id),
        old_price=money(old),
        new_price=money(new),
        actor_user_id=getattr(user, "id", None),
        actor_pos_user_id=_uuid(pos_user_id),
        machine_id=getattr(machine, "id", None),
        source=source,
    )
    db.add(row)
    return row


def changes_out(db: Session, product_id: Any, *, limit: int = 200) -> List[Dict[str, Any]]:
    from app.models.pos_machine import POSMachine
    from app.models.pos_user import PosUser
    from app.models.user import User

    rows = (
        db.query(PriceChange)
        .filter(PriceChange.product_id == _uuid(product_id))
        .order_by(PriceChange.created_at.desc())
        .limit(limit)
        .all()
    )
    users = {u.id: u for u in db.query(User).filter(User.id.in_([r.actor_user_id for r in rows if r.actor_user_id] or [uuid.uuid4()]))}
    staff = {u.id: u for u in db.query(PosUser).filter(PosUser.id.in_([r.actor_pos_user_id for r in rows if r.actor_pos_user_id] or [uuid.uuid4()]))}
    machines = {m.id: m for m in db.query(POSMachine).filter(POSMachine.id.in_([r.machine_id for r in rows if r.machine_id] or [uuid.uuid4()]))}
    targets = [r.target_id for r in rows if r.target_id]
    shops = {s.id: s.name for s in db.query(Shop).filter(Shop.id.in_(targets or [uuid.uuid4()]))}
    areas = {a.id: a.name for a in db.query(ShopArea).filter(ShopArea.id.in_(targets or [uuid.uuid4()]))}
    out = []
    for r in rows:
        who = None
        if r.actor_user_id in users:
            u = users[r.actor_user_id]
            who = u.username or u.email
        elif r.actor_pos_user_id in staff:
            p = staff[r.actor_pos_user_id]
            who = " ".join(x for x in (p.first_name, p.last_name) if x) or p.username
        out.append({
            "id": str(r.id),
            "level": r.level,
            "targetId": str(r.target_id) if r.target_id else None,
            "targetName": shops.get(r.target_id) or areas.get(r.target_id),
            "oldPrice": float(r.old_price) if r.old_price is not None else None,
            "newPrice": float(r.new_price) if r.new_price is not None else None,
            "by": who,
            "machine": getattr(machines.get(r.machine_id), "name", None),
            "source": r.source,
            "at": r.created_at.isoformat() if r.created_at else None,
        })
    return out


# ── Writing a price ──────────────────────────────────────────────────────────


def set_shop_price(db: Session, user: Any, product: Product, row: ShopProductOverride, price: Any) -> None:
    """The shop's price (null = back to the chain's), checked and logged. No commit."""
    check(db, user, product, level=SHOP, shop_id=row.shop_id, new_price=price)
    old = row.price
    row.price = money(price)
    record(db, product=product, level=SHOP, target_id=row.shop_id, old=old, new=row.price, user=user)


def set_area_price(db: Session, user: Any, product: Product, area: ShopArea, price: Any) -> AreaProductOverride:
    check(db, user, product, level=AREA, shop_id=area.shop_id, new_price=price)
    row = (
        db.query(AreaProductOverride)
        .filter(AreaProductOverride.area_id == area.id, AreaProductOverride.product_id == product.id)
        .first()
    )
    if row is None:
        row = AreaProductOverride(area_id=area.id, product_id=product.id)
        db.add(row)
    old = row.price
    row.price = money(price)
    record(db, product=product, level=AREA, target_id=area.id, old=old, new=row.price, user=user)
    return row


def prices_view(db: Session, user: Any, product: Product, shops: List[Shop]) -> Dict[str, Any]:
    """`GET /products/{id}/prices`: the chain's price and, per shop the user reaches, the shop's and its points'."""
    from app.services import area_scope

    reach = area_scope.reach_of(db, user)
    actor = actor_level(db, user, product)
    shop_rows = {
        r.shop_id: r
        for r in db.query(ShopProductOverride).filter(
            ShopProductOverride.global_product_id == product.id,
            ShopProductOverride.shop_id.in_([s.id for s in shops] or [uuid.uuid4()]),
        )
    }
    base_refusal = refusal(DEFAULT, actor=actor, product=product, level=LEVEL_BASE, new_price=product.price)
    out_shops = []
    for shop in shops:
        if not reach.covers_shop(shop.id):
            continue
        row = shop_rows.get(shop.id)
        if row is None:
            continue
        policy = effective(db, shop_id=shop.id)
        areas = (
            db.query(ShopArea)
            .filter(ShopArea.shop_id == shop.id, ShopArea.archived_at.is_(None))
            .order_by(ShopArea.sort_order, ShopArea.name)
            .all()
        )
        area_rows = {
            r.area_id: r
            for r in db.query(AreaProductOverride).filter(
                AreaProductOverride.product_id == product.id,
                AreaProductOverride.area_id.in_([a.id for a in areas] or [uuid.uuid4()]),
            )
        }
        shop_refusal = refusal(policy, actor=actor, product=product, level=SHOP, new_price=None)
        if shop_refusal is None and reach.narrowed:
            shop_refusal = _refuse("needs_whole_shop", "מחיר הסניף משתנה ע״י מנהל הסניף")
        shop_price, _ = resolve(product, row, None)
        out_areas = []
        for a in areas:
            arow = area_rows.get(a.id)
            price, level = resolve(product, row, arow)
            refused = refusal(policy, actor=actor, product=product, level=AREA, new_price=None)
            if refused is None and not reach.covers_area(a.id):
                refused = _refuse("outside_your_points_of_sale", "נקודת מכירה שאינה באחריותך")
            out_areas.append({
                "areaId": str(a.id),
                "areaName": a.name,
                "price": float(arow.price) if arow is not None and arow.price is not None else None,
                "effectivePrice": price,
                "effectiveLevel": level,
                "editable": refused is None,
                "reason": refused.detail.get("message") if refused is not None else None,
            })
        out_shops.append({
            "shopId": str(shop.id),
            "shopName": shop.name,
            "price": float(row.price) if row.price is not None else None,
            "effectivePrice": shop_price,
            "editable": shop_refusal is None,
            "reason": shop_refusal.detail.get("message") if shop_refusal is not None else None,
            "policy": policy.out(),
            "areas": out_areas,
        })
    return {
        "productId": str(product.id),
        "basePrice": float(product.price or 0),
        "baseEditable": base_refusal is None,
        "baseReason": base_refusal.detail.get("message") if base_refusal is not None else None,
        "actorLevel": actor,
        "locked": effective(db, company_id=product.company_id).locks(product) if product.company_id else False,
        "shops": out_shops,
    }
