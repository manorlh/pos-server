"""
"שינוי מחיר מהקופה" (P:/specs/chain-areas.md §9.6):

GET  /sync/{machine_id}/products/{product_id}/price-options → {levels, defaultLevel, ask, approvalRequired, areaId,
                                                               areaName, prices: {area, shop, base, effective}}
PUT  /sync/{machine_id}/products/{product_id}/price          {price: number | null, level?: "area" | "shop"}
                                                             → {level, price, effectivePrice, priceLevel}

The till's own permission gate decides who (`CATALOG_PRICE`, an authorised person's code or a remote approval —
`require_catalog_authority`); `tillPriceChangeApproval` on demands a grant even from an employee who holds it. The
level must be one the till may change (`tillPriceChangeLevels`), then the chain's price policy as for the dashboard.
Logged in `price_changes` with the employee, the approver and the till. The open sale keeps its lines' prices (the
till's); the shop's other devices are nudged to pull.
"""
from __future__ import annotations

import uuid
from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import (
    FISCAL_SYNC_PATH,
    CatalogAuthority,
    get_pos_machine_for_sync_path,
    require_catalog_authority,
)
from app.models.pos_machine import POSMachine
from app.models.product import Product
from app.models.product_availability_override import AreaProductOverride
from app.models.shop_area import ShopArea
from app.models.shop_product_override import ShopProductOverride
from app.services import price_policy as PP
from app.services import till_price as TPR
from app.services.permissions import Scope

router = APIRouter(tags=["till-price"])


class TillPriceIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    price: Optional[float] = Field(None, ge=0, le=1_000_000)
    level: Optional[Literal["area", "shop"]] = None


def _machine(machine_id: str, machine: POSMachine) -> POSMachine:
    if str(machine.id) != str(machine_id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="machine_mismatch")
    if machine.shop_id is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Machine must be assigned to a shop")
    return machine


def _product_and_row(db: Session, machine: POSMachine, product_id: str):
    try:
        pid = uuid.UUID(str(product_id))
    except (TypeError, ValueError):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Product not found")
    product = db.get(Product, pid)
    if product is None and machine is not None:
        # A till's local copy: its global product.
        local = db.query(Product).filter(Product.id == pid, Product.pos_machine_id == machine.id).first()
        product = db.get(Product, local.global_product_id) if local is not None and local.global_product_id else None
    if product is None or str(product.tenant_id) != str(machine.tenant_id) or product.pos_machine_id is not None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Product not found")
    row = (
        db.query(ShopProductOverride)
        .filter(ShopProductOverride.shop_id == machine.shop_id, ShopProductOverride.global_product_id == product.id)
        .first()
    )
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Product not in shop assortment")
    return product, row


def _area_row(db: Session, machine: POSMachine, product: Product) -> Optional[AreaProductOverride]:
    if machine.area_id is None:
        return None
    return (
        db.query(AreaProductOverride)
        .filter(AreaProductOverride.area_id == machine.area_id, AreaProductOverride.product_id == product.id)
        .first()
    )


@router.get("/sync/{machine_id}/products/{product_id}/price-options")
def till_price_options(
    machine_id: str,
    product_id: str,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    machine = _machine(machine_id, machine)
    product, row = _product_and_row(db, machine, product_id)
    arow = _area_row(db, machine, product)
    price, level = PP.resolve(product, row, arow)
    policy = PP.effective(db, shop_id=machine.shop_id)
    blocked = {
        lvl: (lambda r: r.detail.get("message") if r is not None else None)(
            PP.refusal(policy, actor=lvl, product=product, level=lvl, new_price=None)
        )
        for lvl in TPR.allowed_levels(db, machine)
    }
    return {
        **TPR.info(db, machine, row),
        "refusals": blocked,
        "prices": {
            "area": float(arow.price) if arow is not None and arow.price is not None else None,
            "shop": float(row.price) if row.price is not None else None,
            "base": float(product.price or 0),
            "effective": price,
            "effectiveLevel": level,
        },
    }


@router.put("/sync/{machine_id}/products/{product_id}/price", dependencies=FISCAL_SYNC_PATH)
def till_price_set(
    machine_id: str,
    product_id: str,
    body: TillPriceIn,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    authority: Any = Depends(require_catalog_authority(None)),
    db: Session = Depends(get_db),
):
    machine = _machine(machine_id, machine)
    product, row = _product_and_row(db, machine, product_id)
    actor = authority.require(Scope.CATALOG_PRICE) if isinstance(authority, CatalogAuthority) else authority
    if TPR.approval_required(db, machine) and not getattr(authority, "elevation_token", None):
        # "תמיד באישור מורשה": the till asks for an authorised person's code (its 401 path).
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "elevation_required", "message": "שינוי מחיר דורש אישור מורשה"},
        )
    levels = TPR.allowed_levels(db, machine)
    level = body.level or TPR.default_level(db, machine)
    if not levels:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": "till_price_off", "message": "שינוי מחיר מהקופה אינו מופעל"},
        )
    if level not in levels:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": "till_price_level", "message": "לא ניתן לשנות את המחיר ברמה הזו מהקופה", "levels": levels},
        )
    PP.check_till(db, product, shop_id=machine.shop_id, new_price=body.price, level=level)
    pos_user_id = getattr(actor, "pos_user_id", None)
    approver = getattr(actor, "user_id", None)
    if level == TPR.SHOP:
        old = row.price
        row.price = PP.money(body.price)
        target = machine.shop_id
        new = row.price
    else:
        area = db.get(ShopArea, machine.area_id)
        arow = _area_row(db, machine, product)
        if arow is None:
            arow = AreaProductOverride(area_id=area.id, product_id=product.id)
            db.add(arow)
        old = arow.price
        arow.price = PP.money(body.price)
        from datetime import datetime, timezone

        arow.updated_at = datetime.now(timezone.utc)
        target = area.id
        new = arow.price
    from types import SimpleNamespace

    PP.record(
        db, product=product, level=level, target_id=target, old=old, new=new,
        user=SimpleNamespace(id=approver) if approver else None, pos_user_id=pos_user_id, machine=machine, source="till",
    )
    db.commit()
    from app.services.price_bulk import notify

    notify(db, machine.shop_id)
    price, price_level = PP.resolve(product, row, _area_row(db, machine, product))
    return {"level": level, "price": float(new) if new is not None else None, "effectivePrice": price, "priceLevel": price_level}
