"""
"תחזית ואיוש" — the forecast for the next hours and for tomorrow per shop, and the tills to open
each hour (app/services/insights/staffing.py). Scoped exactly like the insights (the caller's
role; `companyId` / `shopId` / `areaId` / `machineId` only narrow); money in integer agorot.

GET /insights/staffing → per shop: tomorrow (net, documents, band, confidence, holiday, by the
                         hour with tills to open), the next hours of today (with the pace),
                         the observed capacity per till, the trend
"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_active_tenant_id, get_current_user
from app.models.user import User
from app.routers.insights import InsightParams, _uuid, insight_params
from app.services.areas import parse_area_filter
from app.services.insights import service as S
from app.services.insights import staffing as ST
from app.services.insights.data import InsightScope

router = APIRouter(prefix="/insights", tags=["insights"])


@router.get("/staffing")
def get_forecast_staffing(
    p: InsightParams = Depends(insight_params),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    clock = S.make_clock(db, active_tenant_id, tz=p.tz, day_start_hour=p.day_start_hour)
    scope = InsightScope(
        user=current_user, tenant_id=active_tenant_id, company_id=_uuid(p.company_id), shop_id=_uuid(p.shop_id),
        area_filter=parse_area_filter(p.area_id), machine_id=_uuid(p.machine_id),
    )
    return ST.build(db, scope, clock)
