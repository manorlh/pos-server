"""
"חיפוש מכשיר" — the cloud's device search (app/services/device_identity.py).

GET /machines/search → {items, total, skip, limit}

By serial (prefix), till number, name, shop / company / tenant, model, role (till / kiosk), app
version (prefix), last seen, IP (the cloud-seen or the LAN address, prefix), SIM carrier and phone
number, plus `q` over all of them. Paginated (at most 100 a page) and served by indexes. Scoped
exactly like the machines list; a super admin searches every tenant (or one, by `tenantId`).

Mounted before the machines router so `/machines/search` is never read as a machine id.
"""
from __future__ import annotations

import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_active_tenant_id, get_current_user
from app.models.user import User
from app.services import device_identity as svc

router = APIRouter(prefix="/machines", tags=["machines"])


def _uuid(value: Optional[str], name: str) -> Optional[uuid.UUID]:
    if value is None or not str(value).strip():
        return None
    try:
        return uuid.UUID(str(value).strip())
    except ValueError:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Invalid {name}")


@router.get("/search")
def search_machines(
    q: Optional[str] = Query(None, max_length=100, description="Free text over every field below."),
    serial: Optional[str] = Query(None, max_length=64, description="Serial number, by prefix."),
    pos_number: Optional[str] = Query(None, alias="posNumber", max_length=50, description="Till number."),
    name: Optional[str] = Query(None, max_length=100),
    shop_id: Optional[str] = Query(None, alias="shopId"),
    company_id: Optional[str] = Query(None, alias="companyId"),
    tenant_id: Optional[str] = Query(None, alias="tenantId"),
    model: Optional[str] = Query(None, max_length=32, description="Device model (N55F, P18, SUNMI_T2…)."),
    role: Optional[str] = Query(None, description="till | kiosk"),
    app_version: Optional[str] = Query(None, alias="appVersion", max_length=64, description="By prefix."),
    last_seen: Optional[str] = Query(None, alias="lastSeen", description="online | 1h | 24h | 7d | over7d | never"),
    ip: Optional[str] = Query(None, max_length=64, description="Cloud-seen or LAN address, by prefix."),
    carrier: Optional[str] = Query(None, max_length=40, description="SIM carrier (פרטנר, סלקום…)."),
    phone: Optional[str] = Query(None, max_length=32, description="SIM phone number."),
    include_inactive: bool = Query(False, alias="includeInactive"),
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=svc.SEARCH_LIMIT_MAX),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    if role is not None and role not in svc.ROLE_CHOICES:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid role")
    if last_seen is not None and last_seen not in svc.LAST_SEEN_CHOICES:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid lastSeen")
    filters = svc.SearchFilters(
        q=q,
        serial=serial,
        pos_number=pos_number,
        name=name,
        shop_id=_uuid(shop_id, "shopId"),
        company_id=_uuid(company_id, "companyId"),
        tenant_id=_uuid(tenant_id, "tenantId"),
        model=model,
        role=role,
        app_version=app_version,
        last_seen=last_seen,
        ip=ip,
        carrier=carrier,
        phone=phone,
        include_inactive=include_inactive,
    )
    return svc.search(db, current_user, active_tenant_id, filters, skip=skip, limit=limit)
