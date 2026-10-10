"""
"פתיחת פריטים אוטומטית אחרי Z" — what the Zs reopened (docs/SPEC_AVAILABILITY.md).

    GET /availability/reopens?shopId=…&limit=…

The log `app/services/availability_reopen.py` writes: per Z and per scope whose day it
closed (the shop, a point of sale, a till), the items it reopened and those it kept closed
because they track stock and have none. Newest first. Reading it takes whatever reading the
shop takes (`_check_shop_access`).
"""
from __future__ import annotations

import uuid
from collections import defaultdict
from typing import Dict, List

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import ensure_same_tenant, get_active_tenant_id, get_current_user
from app.models.availability_reopen import AvailabilityReopen
from app.models.pos_machine import POSMachine
from app.models.shop import Shop
from app.models.shop_area import ShopArea
from app.models.user import User
from app.models.z_report import ZReport
from app.routers.shops import _check_shop_access
from app.schemas.availability_reopen import ReopenItemOut, ReopenRunOut
from app.services import availability_reopen as R

router = APIRouter(prefix="/availability", tags=["availability"])


@router.get("/reopens", response_model=List[ReopenRunOut], response_model_by_alias=True)
def list_reopens(
    shop_id: uuid.UUID = Query(..., alias="shopId"),
    limit: int = Query(30, ge=1, le=200),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    shop = db.query(Shop).filter(Shop.id == shop_id).first()
    if shop is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Shop not found")
    ensure_same_tenant(shop.tenant_id, active_tenant_id)
    _check_shop_access(current_user, shop, db)

    runs = R.recent(db, [shop.id], limit=limit)
    if not runs:
        return []
    items: Dict[str, List[AvailabilityReopen]] = defaultdict(list)
    for row in (
        db.query(AvailabilityReopen)
        .filter(AvailabilityReopen.day_close_id.in_([r.id for r in runs]))
        .order_by(AvailabilityReopen.kind, AvailabilityReopen.item_name)
        .all()
    ):
        items[str(row.day_close_id)].append(row)
    zs = {
        str(z.id): z
        for z in db.query(ZReport).filter(ZReport.id.in_({r.z_report_id for r in runs})).all()
    }
    areas = {str(a.id): a.name for a in db.query(ShopArea).filter(ShopArea.shop_id == shop.id).all()}
    machine_ids = [r.target_id for r in runs if r.level == R.MACHINE]
    machines = {
        str(m.id): m
        for m in (db.query(POSMachine).filter(POSMachine.id.in_(machine_ids)).all() if machine_ids else [])
    }

    def target_name(run) -> str:
        if run.level == R.SHOP:
            return shop.name
        if run.level == R.AREA:
            return areas.get(str(run.target_id), "")
        m = machines.get(str(run.target_id))
        return (m.name or m.pos_number or "") if m is not None else ""

    out = []
    for run in runs:
        z = zs.get(str(run.z_report_id))
        out.append(ReopenRunOut(
            z_report_id=run.z_report_id,
            z_number=(z.shop_sequence_number or z.machine_sequence_number) if z is not None else None,
            z_origin=getattr(z, "origin", None),
            level=run.level,
            target_id=run.target_id,
            target_name=target_name(run),
            closed_at=run.closed_at,
            mode=run.mode,
            ignore_stock=bool(run.ignore_stock),
            reopened_count=run.reopened_count,
            kept_count=run.kept_count,
            items=[
                ReopenItemOut(
                    kind=i.kind, item_id=i.item_id, name=i.item_name, outcome=i.outcome, blocked_at=i.blocked_at
                )
                for i in items.get(str(run.id), [])
            ],
        ))
    return out
