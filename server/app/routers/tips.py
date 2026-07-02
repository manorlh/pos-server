"""Dashboard tips report per shop."""
from datetime import date
from typing import Optional
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_current_user, get_active_tenant_id, ensure_same_tenant
from app.models.shop import Shop
from app.models.user import User
from app.routers.shops import _check_shop_access
from app.schemas.tips import TipsReportResponse
from app.services.tips import build_tips_report

router = APIRouter(tags=["tips"])


def _get_shop_or_404(db: Session, shop_id: str, active_tenant_id) -> Shop:
    shop = db.query(Shop).filter(Shop.id == shop_id).first()
    if not shop:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Shop not found")
    ensure_same_tenant(shop.tenant_id, active_tenant_id)
    return shop


@router.get(
    "/shops/{shop_id}/tips/report",
    response_model=TipsReportResponse,
    response_model_by_alias=True,
)
def get_tips_report(
    shop_id: str,
    from_date: Optional[date] = Query(None, alias="from"),
    to_date: Optional[date] = Query(None, alias="to"),
    trading_day_id: Optional[str] = Query(None, alias="tradingDayId"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    shop = _get_shop_or_404(db, shop_id, active_tenant_id)
    _check_shop_access(current_user, shop, db)

    td_uuid: Optional[uuid.UUID] = None
    if trading_day_id:
        try:
            td_uuid = uuid.UUID(trading_day_id)
        except ValueError:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid tradingDayId")

    if not td_uuid and not from_date and not to_date:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Provide tradingDayId or from/to date range",
        )

    return build_tips_report(
        db,
        shop,
        from_date=from_date,
        to_date=to_date,
        trading_day_id=td_uuid,
    )
