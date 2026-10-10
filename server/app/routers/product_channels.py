"""
"מופיע ב — עריכה בכמות": the four channels of many products at once, on item-blocks' model of
"מופיע ב" (`products.appears_in`, app/services/product_channels.py — the canonical one; this router
adds only the bulk screen's two routes).

* `GET  /product-channels/list` — the catalog's products a page at a time with their channels,
  filtered on the server (search, categories, each channel on / off).
* `POST /product-channels/bulk` — switch one or more channels on or off for the rows selected, or for
  "all matching" a filter — run here on the server, pages never loaded included. `dryRun` answers the
  counts first (matched / would change / unchanged / not yours or not found) with a sample. Products
  the caller may not edit are reported, never silently skipped. A change goes through
  `product_channels.apply` (which keeps `sales_channel` in step for the tills and kiosks).
"""
from __future__ import annotations

import logging
import uuid as uuid_mod
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import String, and_, cast, false, not_, or_
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_active_tenant_id, get_current_user
from app.models.product import CatalogLevel, Product
from app.models.user import User
from app.routers.products import _CATALOG_ROLES, _check_product_access
from app.services import product_channels as PC
from app.services import product_list_filters as list_filters
from app.services import sales_channel as SC
from app.services.catalog_notify import notify_all_machines_for_tenant
from app.services.company_hierarchy import catalog_visibility_filter

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/product-channels", tags=["product-channels"])

#: The most products one bulk request changes ("all matching" beyond it is refused, not cut).
BULK_MAX = 20000
SAMPLE_SIZE = 12


def channel_condition(model: Any, channel: str, on: bool):
    """
    SQL: the product's "מופיע ב" names `channel` (`on`) / does not. A product that never had a list
    (`appears_in` NULL) appears where `sales_channel` says, never online nor in the menu
    (product_channels.appears_in).
    """
    text = cast(model.appears_in, String)
    unset = or_(model.appears_in.is_(None), text == "null")
    if channel == PC.POS:
        legacy = model.sales_channel.in_([SC.ALL, SC.POS_ONLY])
    elif channel == PC.KIOSK:
        legacy = model.sales_channel.in_([SC.ALL, SC.KIOSK_ONLY])
    elif channel in (PC.ONLINE, PC.MENU):
        legacy = false()
    else:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unknown channel")
    cond = or_(and_(unset, legacy), and_(not_(unset), text.like(f'%"{channel}"%')))
    return cond if on else not_(cond)


def _clean_set(v):
    if not isinstance(v, dict) or not v:
        raise ValueError("set at least one channel")
    out = {}
    for key, value in v.items():
        if key not in PC.CHANNELS:
            raise ValueError(f"unknown channel {key}")
        if not isinstance(value, bool):
            raise ValueError(f"channel {key} must be true or false")
        out[key] = value
    return out


class BulkFilter(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    search: Optional[str] = None
    category_ids: Optional[List[str]] = Field(None, alias="categoryIds")
    channel_on: Optional[List[str]] = Field(None, alias="channelOn")
    channel_off: Optional[List[str]] = Field(None, alias="channelOff")
    company_id: Optional[uuid_mod.UUID] = Field(None, alias="companyId")


class BulkSelection(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    #: The rows the user ticked (a page or a few).
    ids: Optional[List[uuid_mod.UUID]] = Field(None, max_length=BULK_MAX)
    #: "כל התוצאות": every product matching this filter, on the server.
    all_matching: Optional[BulkFilter] = Field(None, alias="allMatching")


class BulkIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    selection: BulkSelection
    set: Dict[str, bool]
    dry_run: bool = Field(True, alias="dryRun")

    @field_validator("set", mode="before")
    @classmethod
    def _set(cls, v):
        return _clean_set(v)


def _matching_query(db: Session, user: User, tenant_id, f: BulkFilter):
    """The catalog products a filter matches — the product list's own conditions, on the server."""
    q = db.query(Product).filter(
        Product.tenant_id == tenant_id,
        Product.catalog_level == CatalogLevel.GLOBAL,
        Product.pos_machine_id.is_(None),
    )
    visible = catalog_visibility_filter(db, user, Product)
    if visible is not None:
        q = q.filter(visible)
    if f.company_id is not None:
        q = q.filter(Product.company_id == f.company_id)
    matches = list_filters.search_condition(f.search)
    if matches is not None:
        q = q.filter(matches)
    in_categories = list_filters.category_condition([c for c in (f.category_ids or []) if c], False, tenant_id)
    if in_categories is not None:
        q = q.filter(in_categories)
    for wanted, on in ((f.channel_on, True), (f.channel_off, False)):
        for channel in [c for c in (wanted or []) if c]:
            q = q.filter(channel_condition(Product, channel, on))
    return q


def _row(p: Product) -> Dict[str, Any]:
    return {"id": str(p.id), "name": p.name, "categoryId": str(p.category_id) if p.category_id else None,
            "appearsIn": list(PC.appears_in(p))}


@router.get("/list")
def list_products(
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200, alias="pageSize"),
    search: Optional[str] = Query(None),
    category_ids: Optional[List[str]] = Query(None, alias="categoryIds"),
    channel_on: Optional[List[str]] = Query(None, alias="channelOn"),
    channel_off: Optional[List[str]] = Query(None, alias="channelOff"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    f = BulkFilter(search=search, categoryIds=category_ids, channelOn=channel_on, channelOff=channel_off)
    q = _matching_query(db, current_user, active_tenant_id, f)
    total = q.count()
    rows = q.order_by(Product.name, Product.id).offset((page - 1) * page_size).limit(page_size).all()
    return {"page": page, "pageSize": page_size, "total": total, "items": [_row(p) for p in rows]}


def _after(p: Product, changes: Dict[str, bool]) -> List[str]:
    current = set(PC.appears_in(p))
    for channel, on in changes.items():
        if on:
            current.add(channel)
        else:
            current.discard(channel)
    return [c for c in PC.CHANNELS if c in current]


@router.post("/bulk")
def bulk_product_channels(
    body: BulkIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    if not body.dry_run and current_user.role not in _CATALOG_ROLES:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")
    sel = body.selection
    if (sel.ids is None) == (sel.all_matching is None):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="choose ids or allMatching")
    missing: List[str] = []
    if sel.ids is not None:
        ids = list(dict.fromkeys(sel.ids))
        products: List[Product] = []
        for start in range(0, len(ids), 500):
            products += db.query(Product).filter(Product.id.in_(ids[start:start + 500])).all()
        found = {p.id for p in products}
        products = [p for p in products if str(p.tenant_id) == str(active_tenant_id)]
        kept = {p.id for p in products}
        missing = [str(i) for i in ids if i not in found or i not in kept]
    else:
        q = _matching_query(db, current_user, active_tenant_id, sel.all_matching)
        total = q.count()
        if total > BULK_MAX:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={"code": "too_many", "message": f"יותר מ-{BULK_MAX} מוצרים — צמצמו את הסינון", "matched": total},
            )
        products = q.order_by(Product.name, Product.id).all()

    refused: List[Dict[str, Any]] = []
    allowed: List[Product] = []
    for p in products:
        if p.catalog_level not in (CatalogLevel.GLOBAL, "global") or p.pos_machine_id is not None:
            refused.append({"id": str(p.id), "name": p.name, "reason": "not_catalog"})
            continue
        try:
            _check_product_access(current_user, p, db)
        except HTTPException:
            refused.append({"id": str(p.id), "name": p.name, "reason": "not_yours"})
            continue
        allowed.append(p)

    changes = []
    for p in allowed:
        before = list(PC.appears_in(p))
        after = _after(p, body.set)
        if after != before:
            changes.append((p, before, after))
    result = {
        "matched": len(products) + len(missing),
        "changed": len(changes),
        "unchanged": len(allowed) - len(changes),
        "refused": len(refused) + len(missing),
        "refusedSample": refused[:SAMPLE_SIZE] + [{"id": m, "name": None, "reason": "not_found"} for m in missing[:SAMPLE_SIZE]],
        "sample": [{"id": str(p.id), "name": p.name, "before": b, "after": a} for p, b, a in changes[:SAMPLE_SIZE]],
        "set": body.set,
        "applied": False,
    }
    if body.dry_run or not changes:
        return result
    now = datetime.now(timezone.utc)
    for p, _before, after in changes:
        PC.apply(p, appears=after)
        p.updated_at = now
    db.commit()
    notify_all_machines_for_tenant(db, str(active_tenant_id), reason="product_change")
    logger.info("product channels bulk set=%s changed=%d refused=%d by=%s",
                body.set, len(changes), result["refused"], getattr(current_user, "id", None))
    result["applied"] = True
    return result
