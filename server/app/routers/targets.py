"""
"יעדים ותחרות" — app/services/sales_targets.py.

Dashboard (section `reports`; the machine admins' roles and org scope, app/services/kiosk_control.py):

GET    /targets            ?companyId=&shopId=          the targets
POST   /targets            {shopId, scope, period, amount, areaId?, posUserId?, eventId?, day?, dayStart?, dayEnd?, name?}
PUT    /targets/{id}       the same fields
DELETE /targets/{id}       archived (its hits stay in the log)
GET    /targets/progress   ?companyId=&shopId=&date=     progress with the pace forecast

Till (`get_pos_machine_for_sync_path`):

GET    /sync/{machine_id}/leaderboard                    the shop's cashiers today and its target
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_active_tenant_id, get_current_user, get_pos_machine_for_sync_path
from app.models.pos_machine import POSMachine
from app.models.sales_target import SalesTarget
from app.models.shop import Shop
from app.models.user import User, UserRole
from app.services import kiosk_control
from app.services import sales_targets as svc
from app.services.company_hierarchy import visible_shop_ids

router = APIRouter(prefix="/targets", tags=["targets"])
till_router = APIRouter(prefix="/sync", tags=["targets"])


def _shops(db: Session, user: User, tenant_id, company_id=None, shop_id=None) -> List[Shop]:
    kiosk_control.require_kiosk_role(user)
    q = db.query(Shop).filter(Shop.tenant_id == tenant_id)
    if company_id is not None:
        q = q.filter(Shop.company_id == company_id)
    if shop_id is not None:
        q = q.filter(Shop.id == shop_id)
    shops = q.order_by(Shop.name).all()
    if user.role == UserRole.COMPANY_MANAGER:
        allowed = {str(s) for s in visible_shop_ids(db, user)}
        shops = [s for s in shops if str(s.id) in allowed]
    elif user.role == UserRole.SHOP_MANAGER:
        shops = [s for s in shops if str(s.id) == str(user.shop_id)]
    return shops


def _shop_checked(db: Session, user: User, tenant_id, shop_id) -> Shop:
    shop = db.get(Shop, shop_id)
    if shop is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Shop not found")
    kiosk_control.check_shop_scope(db, user, shop, tenant_id)
    return shop


@router.get("")
def list_targets(
    company_id: Optional[uuid.UUID] = Query(None, alias="companyId"),
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    shops = _shops(db, current_user, active_tenant_id, company_id, shop_id)
    if not shops:
        return []
    rows = (
        db.query(SalesTarget)
        .filter(SalesTarget.shop_id.in_([s.id for s in shops]), SalesTarget.archived_at.is_(None))
        .order_by(SalesTarget.shop_id, SalesTarget.period, SalesTarget.scope, SalesTarget.created_at)
        .all()
    )
    return [svc.target_out(db, r) for r in rows]


@router.get("/progress")
def get_progress(
    company_id: Optional[uuid.UUID] = Query(None, alias="companyId"),
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    day: Optional[date] = Query(None, alias="date"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    shops = _shops(db, current_user, active_tenant_id, company_id, shop_id)
    out = svc.progress(db, [s.id for s in shops], day=day)
    db.commit()  # a target reached is recorded on the way ("יעד הושג")
    return out


@router.post("", status_code=status.HTTP_201_CREATED)
def create_target(
    body: Dict[str, Any] = Body(...),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    try:
        shop_id = uuid.UUID(str(body.get("shopId")))
    except (TypeError, ValueError):
        raise HTTPException(status_code=422, detail={"code": "shop_required", "message": "בחרו סניף"})
    shop = _shop_checked(db, current_user, active_tenant_id, shop_id)
    v = svc.validate(db, shop, body)
    row = SalesTarget(
        id=uuid.uuid4(), tenant_id=shop.tenant_id, company_id=shop.company_id, shop_id=shop.id,
        created_by_user_id=current_user.id, **v,
    )
    db.add(row)
    db.commit()
    return svc.target_out(db, row)


def _target_checked(db: Session, user: User, tenant_id, target_id) -> SalesTarget:
    row = db.get(SalesTarget, target_id)
    if row is None or str(row.tenant_id) != str(tenant_id) or row.archived_at is not None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="target_not_found")
    _shop_checked(db, user, tenant_id, row.shop_id)
    return row


@router.put("/{target_id}")
def update_target(
    target_id: uuid.UUID,
    body: Dict[str, Any] = Body(...),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    row = _target_checked(db, current_user, active_tenant_id, target_id)
    shop = db.get(Shop, row.shop_id)
    v = svc.validate(db, shop, body)
    for key, value in v.items():
        setattr(row, key, value)
    row.updated_at = datetime.now(timezone.utc)
    db.commit()
    return svc.target_out(db, row)


@router.delete("/{target_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_target(
    target_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    row = _target_checked(db, current_user, active_tenant_id, target_id)
    row.archived_at = datetime.now(timezone.utc)
    db.commit()


@till_router.get("/{machine_id}/leaderboard")
def till_leaderboard(
    machine_id: str,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    """The till's small leaderboard (till parameters `leaderboardEnabled` / `leaderboardMetric`)."""
    from app.services.till_parameters import till_parameters_for_machine

    params = till_parameters_for_machine(db, machine).parameters
    enabled = params.get(svc.PARAM_ENABLED) is True or str(params.get(svc.PARAM_ENABLED)).lower() == "true"
    if not enabled:
        return {"enabled": False, "cashiers": [], "target": None}
    metric = params.get(svc.PARAM_METRIC) or svc.METRIC_SALES
    out = svc.leaderboard(db, machine, metric=metric if metric in (svc.METRIC_SALES, svc.METRIC_UPSELL) else svc.METRIC_SALES)
    db.commit()
    return {"enabled": True, **out}
