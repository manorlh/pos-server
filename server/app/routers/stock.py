"""Dashboard stock management per shop."""
from decimal import Decimal
from typing import List
import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_current_user, get_active_tenant_id, ensure_same_tenant
from app.models.shop import Shop
from app.models.stock_movement import StockMovementReason
from app.models.user import User, UserRole
from app.services.permission_matrix import Action, Resource, roles_for
from app.routers.shops import _check_shop_access
from app.services.company_hierarchy import user_covers_shop
from app.schemas.stock import (
    AdjustmentRequest,
    GoodsReceiptRequest,
    StockLevelOut,
    StocktakeRequest,
)
from app.services.catalog_notify import notify_machines_for_shop
from app.services.stock import (
    apply_movement,
    get_levels_for_shop,
    serialize_stock_level,
    set_quantity,
    utc_now,
)

router = APIRouter(tags=["stock"])

_STOCK_WRITE_ROLES = roles_for(Resource.STOCK, Action.WRITE)


def _check_stock_write(user: User, shop: Shop, db: Session) -> None:
    if user.role not in _STOCK_WRITE_ROLES:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")
    if user.role == UserRole.COMPANY_MANAGER and not user_covers_shop(db, user, shop):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")
    if user.role == UserRole.SHOP_MANAGER and shop.id != user.shop_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")


def _get_shop_or_404(db: Session, shop_id: str, active_tenant_id) -> Shop:
    shop = db.query(Shop).filter(Shop.id == shop_id).first()
    if not shop:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Shop not found")
    ensure_same_tenant(shop.tenant_id, active_tenant_id)
    return shop


@router.get("/shops/{shop_id}/stock", response_model=List[StockLevelOut], response_model_by_alias=True)
def list_shop_stock(
    shop_id: str,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    shop = _get_shop_or_404(db, shop_id, active_tenant_id)
    _check_shop_access(current_user, shop, db)
    levels = get_levels_for_shop(db, shop.id)
    return [
        StockLevelOut(
            product_id=l.product_id,
            product_name=l.product.name if l.product else None,
            sku=l.product.sku if l.product else None,
            quantity=l.quantity,
            reorder_min=l.reorder_min,
            reorder_max=l.reorder_max,
            reorder_opt=l.reorder_opt,
            updated_at=l.updated_at,
        )
        for l in levels
    ]


def _update_through_locations(
    db: Session, user: User, shop: Shop, *, product_id, op: str, quantity: Decimal, note
) -> StockLevelOut:
    """
    The shop page's receipt / adjustment / stocktake, through the stock screens' one write path
    (app/services/stock_admin.py `update`): the tenant's own product, the location the shop's stock
    is managed at (with stock locations off: the shop, as always), the user's scope — never a write to
    a shop row that no longer holds the product's stock.
    """
    from app.services import stock_admin
    from app.services import stock_locations as L
    from app.services.stock import level_at
    from app.services.stock_locations import Location

    path = L.path_of(db, "shop", shop.id)
    out = stock_admin.update(
        db, user, shop.tenant_id, path, product_id=product_id, op=op, quantity=Decimal(str(quantity)), note=note,
    )
    db.commit()
    notify_machines_for_shop(db, str(shop.id), reason="stock_updated")
    level = level_at(db, Location(out["location"]["level"], uuid.UUID(out["location"]["targetId"])), uuid.UUID(out["productId"]))
    if level is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Stock level not found")
    db.refresh(level)
    return StockLevelOut(
        product_id=level.product_id,
        product_name=level.product.name if level.product else None,
        sku=level.product.sku if level.product else None,
        quantity=level.quantity,
        reorder_min=level.reorder_min,
        reorder_max=level.reorder_max,
        reorder_opt=level.reorder_opt,
        updated_at=level.updated_at,
    )


@router.post(
    "/shops/{shop_id}/stock/goods-receipt",
    response_model=StockLevelOut,
    response_model_by_alias=True,
)
def goods_receipt(
    shop_id: str,
    body: GoodsReceiptRequest,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    shop = _get_shop_or_404(db, shop_id, active_tenant_id)
    _check_shop_access(current_user, shop, db)
    _check_stock_write(current_user, shop, db)
    return _update_through_locations(
        db, current_user, shop, product_id=body.product_id, op="receive", quantity=body.quantity, note=body.note,
    )


@router.post(
    "/shops/{shop_id}/stock/adjustment",
    response_model=StockLevelOut,
    response_model_by_alias=True,
)
def adjustment(
    shop_id: str,
    body: AdjustmentRequest,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    shop = _get_shop_or_404(db, shop_id, active_tenant_id)
    _check_shop_access(current_user, shop, db)
    _check_stock_write(current_user, shop, db)

    if body.delta == 0:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Delta cannot be zero")
    delta = Decimal(str(body.delta))
    return _update_through_locations(
        db, current_user, shop, product_id=body.product_id, op="add" if delta > 0 else "remove", quantity=abs(delta), note=body.note,
    )


@router.post(
    "/shops/{shop_id}/stock/stocktake",
    response_model=StockLevelOut,
    response_model_by_alias=True,
)
def stocktake(
    shop_id: str,
    body: StocktakeRequest,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    shop = _get_shop_or_404(db, shop_id, active_tenant_id)
    _check_shop_access(current_user, shop, db)
    _check_stock_write(current_user, shop, db)
    return _update_through_locations(
        db, current_user, shop, product_id=body.product_id, op="count", quantity=body.quantity, note=body.note,
    )
