"""
"סקירת שינויים לפני שידור לקופות" from the dashboard (docs/SPEC_MENU_BROADCAST_REVIEW.md,
app/services/menu_broadcast.py).

GET  /menu-broadcast/status?companyId=&shopId=   → the shops in scope in review mode, and
                                                   how many changes each has not broadcast
                                                   (the catalog pages' banner)
GET  /shops/{id}/menu-broadcast/preview          → the review: mode and why, the version the
                                                   tills have, every change per section,
                                                   the tills it would reach, a fingerprint
POST /shops/{id}/menu-broadcast                  → "אישור ושידור" `{fingerprint?, note?}`:
                                                   the next version, the shop's tills woken
GET  /shops/{id}/menu-broadcast/history          → "גרסאות שידור"
GET  /companies/{id}/menu-broadcast/preview      → the review of every shop of the company
                                                   (and its subsidiaries) in review mode
POST /companies/{id}/menu-broadcast              → `{shops: [{shopId, fingerprint}], note?}`:
                                                   each listed shop broadcast in turn
GET  /shops/{id}/work-types                      → "סוגי עבודה" (tables and the rest) and
                                                   whether review is on, and why
PUT  /shops/{id}/work-types                      → the super admin's

Reading: whoever is in charge of the shop. Broadcasting: the catalog's writers.
"""
from __future__ import annotations

import uuid
from typing import List, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import ensure_same_tenant, get_active_tenant_id, get_current_user
from app.models.company import Company
from app.models.shop import Shop
from app.models.user import User
from app.services import menu_broadcast as B
from app.services import till_parameters as TP

router = APIRouter(tags=["menu-broadcast"])


class BroadcastIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    #: The review the user approved; refused (409) when the draft moved since.
    fingerprint: Optional[str] = Field(None, max_length=64)
    note: Optional[str] = Field(None, max_length=500)


class ShopBroadcastIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    shop_id: uuid.UUID = Field(alias="shopId")
    fingerprint: Optional[str] = Field(None, max_length=64)


class CompanyBroadcastIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    shops: List[ShopBroadcastIn] = Field(min_length=1, max_length=500)
    note: Optional[str] = Field(None, max_length=500)


class WorkTypesIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    tables: Optional[bool] = None
    tables_mode: Optional[str] = Field(None, alias="tablesMode", max_length=100)
    take_away: Optional[bool] = Field(None, alias="takeAway")
    quick_order: Optional[bool] = Field(None, alias="quickOrder")
    delivery: Optional[bool] = None
    review_override: Optional[str] = Field(None, alias="reviewOverride", max_length=100)


def _shop(db: Session, shop_id: uuid.UUID, user: User, tenant_id) -> Shop:
    shop = db.query(Shop).filter(Shop.id == shop_id).first()
    if shop is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Shop not found")
    if shop.tenant_id is None:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="tenant_forbidden")
    ensure_same_tenant(shop.tenant_id, tenant_id)
    B.check_read(db, user, shop)
    return shop


def _company(db: Session, company_id: uuid.UUID, tenant_id) -> Company:
    company = db.query(Company).filter(Company.id == company_id).first()
    if company is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Company not found")
    ensure_same_tenant(company.tenant_id, tenant_id)
    return company


@router.get("/menu-broadcast/status")
def get_status(
    company_id: Optional[uuid.UUID] = Query(None, alias="companyId"),
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    shops = B.shops_in_scope(db, current_user, active_tenant_id, company_id=company_id, shop_id=shop_id)
    return B.status_for(db, shops)


@router.get("/shops/{shop_id}/menu-broadcast/preview")
def get_shop_preview(
    shop_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    shop = _shop(db, shop_id, current_user, active_tenant_id)
    return B.preview(db, shop)


@router.post("/shops/{shop_id}/menu-broadcast")
def post_shop_broadcast(
    shop_id: uuid.UUID,
    body: BroadcastIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    shop = _shop(db, shop_id, current_user, active_tenant_id)
    B.check_broadcast(db, current_user, shop)
    made = B.broadcast(db, shop, current_user, expected_fingerprint=body.fingerprint, note=body.note)
    return {"shopId": str(shop.id), "publication": B.publication_out(made), "targets": B.targets(db, shop)}


@router.get("/shops/{shop_id}/menu-broadcast/history")
def get_shop_history(
    shop_id: uuid.UUID,
    limit: int = Query(50, ge=1, le=200),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    shop = _shop(db, shop_id, current_user, active_tenant_id)
    return {"shopId": str(shop.id), "versions": B.history(db, shop, limit)}


@router.get("/companies/{company_id}/menu-broadcast/preview")
def get_company_preview(
    company_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    company = _company(db, company_id, active_tenant_id)
    shops = B.shops_in_scope(db, current_user, active_tenant_id, company_id=company.id)
    previews = []
    for shop in shops:
        out = B.preview(db, shop)
        if out["review"]["enabled"]:
            previews.append(out)
    return {
        "companyId": str(company.id),
        "shops": previews,
        "total": sum(p["total"] for p in previews),
    }


@router.post("/companies/{company_id}/menu-broadcast")
def post_company_broadcast(
    company_id: uuid.UUID,
    body: CompanyBroadcastIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    Each listed shop in turn, as its own broadcast. A shop refused (its draft moved, or
    nothing to broadcast) is reported and the others go on — every version stands alone.
    """
    company = _company(db, company_id, active_tenant_id)
    allowed = {
        str(s.id): s for s in B.shops_in_scope(db, current_user, active_tenant_id, company_id=company.id)
    }
    results = []
    for item in body.shops:
        shop = allowed.get(str(item.shop_id))
        if shop is None:
            results.append({"shopId": str(item.shop_id), "ok": False, "error": "shop_not_in_company"})
            continue
        try:
            B.check_broadcast(db, current_user, shop)
            made = B.broadcast(db, shop, current_user, expected_fingerprint=item.fingerprint, note=body.note)
        except HTTPException as exc:
            detail = exc.detail.get("code") if isinstance(exc.detail, dict) else exc.detail
            results.append({"shopId": str(shop.id), "shopName": shop.name, "ok": False, "error": detail})
            continue
        results.append({
            "shopId": str(shop.id), "shopName": shop.name, "ok": True, "publication": B.publication_out(made),
        })
    return {"companyId": str(company.id), "results": results}


@router.get("/shops/{shop_id}/work-types")
def get_work_types(
    shop_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    shop = _shop(db, shop_id, current_user, active_tenant_id)
    out = B.work_types_out(db, shop, current_user)
    db.commit()  # the built-in parameters, if reading created them
    return out


@router.put("/shops/{shop_id}/work-types")
def put_work_types(
    shop_id: uuid.UUID,
    body: WorkTypesIn,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    shop = _shop(db, shop_id, current_user, active_tenant_id)
    changed = B.set_work_types(
        db,
        shop,
        current_user,
        tables=body.tables,
        tables_mode=body.tables_mode,
        take_away=body.take_away,
        quick_order=body.quick_order,
        delivery=body.delivery,
        review_override=body.review_override,
    )
    if changed:
        # The tills' parameters (`tablesMode`) changed: one `settings` signal, as the
        # parameters page sends.
        background_tasks.add_task(TP.publish_parameters_notify, TP.notify_targets_for_scope(db, "shop", shop.id))
    return B.work_types_out(db, shop, current_user)
