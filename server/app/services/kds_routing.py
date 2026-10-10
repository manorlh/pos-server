"""
KDS routing (owner's spec §6; docs/SPEC_KDS.md §4): which station prepares an item.

The station lists are the kitchen printers module's (`kitchen_stations`, with one
station per product or category in `kitchen_station_targets`), so a product routed to
"גריל" prints on the grill's printers and shows on the grill's screen — one assignment.

Resolution, first match wins:

1. An override for the product in this shop (`kds_route_overrides`), the most specific
   first: point of sale + service type, point of sale, service type, the shop.
2. The product's own station.
3. Its category, then up the category tree — at each level its overrides (same order)
   and then its station: the category is the default.
4. Nothing: the item is *unrouted* — it still becomes a task (shown on the Expo with an
   alert), never silently dropped.

An override with no station is an explicit "no station here" (unrouted). A till's
machine-local copy of a product routes as its global product.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy.orm import Session

from app.models.category import Category
from app.models.kds import KdsRouteOverride, KdsStationSetting
from app.models.printers import KitchenStation, KitchenStationTarget
from app.models.product import Product

_NONE = object()


def _uuid(value: Any) -> Optional[uuid.UUID]:
    if value is None or value == "":
        return None
    if isinstance(value, uuid.UUID):
        return value
    try:
        return uuid.UUID(str(value))
    except (ValueError, TypeError):
        return None


@dataclass
class Route:
    station_id: Optional[uuid.UUID]
    station_name: Optional[str]
    #: prep | view (the station's kind in this shop).
    target_kind: str = "prep"
    #: product_override | product | category_override | category | none
    source: str = "none"


@dataclass
class RoutingContext:
    """Everything routing needs for one shop, loaded once per release."""

    tenant_id: uuid.UUID
    shop_id: uuid.UUID
    area_id: Optional[uuid.UUID]
    service_type: Optional[str]
    stations: Dict[uuid.UUID, str] = field(default_factory=dict)
    kinds: Dict[uuid.UUID, str] = field(default_factory=dict)
    targets: Dict[Tuple[str, uuid.UUID], uuid.UUID] = field(default_factory=dict)
    parents: Dict[uuid.UUID, Optional[uuid.UUID]] = field(default_factory=dict)
    #: (target_type, target_id) → [(rank, station_id or None)]
    overrides: Dict[Tuple[str, uuid.UUID], List[Tuple[int, Optional[uuid.UUID]]]] = field(default_factory=dict)
    products: Dict[str, Tuple[Optional[uuid.UUID], Optional[uuid.UUID]]] = field(default_factory=dict)


def load_context(
    db: Session, tenant_id: Any, shop_id: Any, area_id: Any = None, service_type: Optional[str] = None
) -> RoutingContext:
    tenant = _uuid(tenant_id)
    shop = _uuid(shop_id)
    area = _uuid(area_id)
    ctx = RoutingContext(tenant_id=tenant, shop_id=shop, area_id=area, service_type=service_type)
    for s in db.query(KitchenStation).filter(KitchenStation.tenant_id == tenant).all():
        ctx.stations[s.id] = s.name
    for row in db.query(KdsStationSetting).filter(KdsStationSetting.shop_id == shop).all():
        ctx.kinds[row.station_id] = row.target_kind or "prep"
    for t in db.query(KitchenStationTarget).filter(KitchenStationTarget.tenant_id == tenant).all():
        ctx.targets[(t.target_type, t.target_id)] = t.station_id
    for cid, pid in db.query(Category.id, Category.parent_id).filter(Category.tenant_id == tenant).all():
        ctx.parents[cid] = pid
    for o in db.query(KdsRouteOverride).filter(KdsRouteOverride.shop_id == shop).all():
        rank = _override_rank(o, area, service_type)
        if rank is None:
            continue
        ctx.overrides.setdefault((o.target_type, o.target_id), []).append((rank, o.station_id))
    for bucket in ctx.overrides.values():
        bucket.sort(key=lambda r: r[0])
    return ctx


def _override_rank(o: KdsRouteOverride, area: Optional[uuid.UUID], service_type: Optional[str]) -> Optional[int]:
    """Lower is more specific; None: the override does not apply here."""
    if o.area_id is not None and o.area_id != area:
        return None
    if o.service_type is not None and o.service_type != service_type:
        return None
    if o.area_id is not None and o.service_type is not None:
        return 0
    if o.area_id is not None:
        return 1
    if o.service_type is not None:
        return 2
    return 3


def _override(ctx: RoutingContext, target_type: str, target_id: Optional[uuid.UUID]):
    if target_id is None:
        return _NONE
    bucket = ctx.overrides.get((target_type, target_id))
    if not bucket:
        return _NONE
    return bucket[0][1]


def _product_ids(db: Session, ctx: RoutingContext, product_id: Optional[str]) -> Tuple[Optional[uuid.UUID], Optional[uuid.UUID]]:
    """(the product as routed — a local copy's global product —, its category)."""
    if not product_id:
        return None, None
    if product_id in ctx.products:
        return ctx.products[product_id]
    pid = _uuid(product_id)
    out: Tuple[Optional[uuid.UUID], Optional[uuid.UUID]] = (pid, None)
    if pid is not None:
        row = (
            db.query(Product.id, Product.category_id, Product.global_product_id, Product.tenant_id)
            .filter(Product.id == pid)
            .first()
        )
        if row is not None and row.tenant_id == ctx.tenant_id:
            routed = row.global_product_id or row.id
            category = row.category_id
            if row.global_product_id is not None and category is None:
                parent = db.query(Product.category_id).filter(Product.id == row.global_product_id).first()
                category = parent[0] if parent else None
            out = (routed, category)
    ctx.products[product_id] = out
    return out


def route(db: Session, ctx: RoutingContext, product_id: Optional[str], category_id: Optional[str]) -> Route:
    routed_product, product_category = _product_ids(db, ctx, product_id)

    def found(station_id: Optional[uuid.UUID], source: str) -> Route:
        if station_id is None or station_id not in ctx.stations:
            return Route(None, None, "prep", "none")
        return Route(station_id, ctx.stations[station_id], ctx.kinds.get(station_id, "prep"), source)

    raw_product = _uuid(product_id)
    for pid in [p for p in (routed_product, raw_product) if p is not None]:
        hit = _override(ctx, "product", pid)
        if hit is not _NONE:
            return found(hit, "product_override")
    for pid in [p for p in (routed_product, raw_product) if p is not None]:
        station = ctx.targets.get(("product", pid))
        if station is not None:
            return found(station, "product")

    current = _uuid(category_id) or product_category
    seen = set()
    while current is not None and current not in seen:
        seen.add(current)
        hit = _override(ctx, "category", current)
        if hit is not _NONE:
            return found(hit, "category_override")
        station = ctx.targets.get(("category", current))
        if station is not None:
            return found(station, "category")
        current = ctx.parents.get(current)
    return Route(None, None, "prep", "none")
