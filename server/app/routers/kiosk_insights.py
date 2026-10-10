"""
"ביצועי קיוסקים" and "תקינות מכשירים" — docs/SPEC_KIOSK_INSIGHTS.md.

Till (`get_pos_machine_for_sync_path`: the machine token, path machine = token machine):

POST /sync/{machine_id}/kiosk/events        the kiosk's funnel events, batched (idempotent by
                                            session + seq) → {accepted, duplicates, rejected}
POST /sync/{machine_id}/kiosk/basket-check  before the charge: each line's availability and
                                            price now, and whether the promotions changed

Dashboard (Clerk):

GET  /insights/kiosks          the kiosks' report over the insights' scope and period
                               (`kioskId` narrows to one kiosk)
GET  /kiosks/health            every kiosk in scope with its parts (app, terminal, printer,
                               till link, KDS, media, uploads), the shops' KDS screens
GET  /kiosks/{id}/health       one kiosk, with its last events and sessions
"""
from __future__ import annotations

import uuid
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_active_tenant_id, get_current_user, get_pos_machine_for_sync_path
from app.models.pos_machine import POSMachine
from app.models.user import User
from app.routers.insights import InsightParams, build_context, insight_params
from app.services import kiosk_basket_check
from app.services import kiosk_control as svc
from app.services import kiosk_funnel
from app.services import kiosk_health
from app.services import kiosk_insights
from app.services.insights import service as S

till_router = APIRouter(prefix="/sync", tags=["kiosk-insights"])
router = APIRouter(tags=["kiosk-insights"])


class KioskEventsIn(BaseModel):
    """A batch of funnel events; each is checked alone (a bad one is dropped, never the batch)."""

    model_config = ConfigDict(populate_by_name=True)

    events: List[Any] = Field(default_factory=list, max_length=kiosk_funnel.BATCH_MAX)


class BasketLineIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    product_id: str = Field(..., alias="productId", min_length=1, max_length=64)
    quantity: float = Field(1, ge=0, le=10_000)
    #: The product's base price as the kiosk holds it (agorot, without any menu).
    unit_price_agorot: Optional[int] = Field(None, alias="unitPriceAgorot", ge=0, le=100_000_000)


class BasketCheckIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    lines: List[BasketLineIn] = Field(default_factory=list, max_length=kiosk_basket_check.LINES_MAX)
    promotions_etag: Optional[str] = Field(None, alias="promotionsEtag", max_length=64)


# ── The kiosk ────────────────────────────────────────────────────────────────


@till_router.post("/{machine_id}/kiosk/events")
def post_kiosk_events(
    machine_id: str,
    body: KioskEventsIn,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    """The kiosk's anonymous funnel. 403 `not_a_kiosk` for a till that is not one."""
    svc.require_kiosk_device(db, machine)
    out = kiosk_funnel.ingest(db, machine, body.events)
    db.commit()
    return out


@till_router.post("/{machine_id}/kiosk/basket-check")
def post_basket_check(
    machine_id: str,
    body: BasketCheckIn,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    """Each line's availability and base price now, and the promotions' ETag. Read-only."""
    svc.require_kiosk_device(db, machine)
    lines: List[Dict[str, Any]] = [
        {"productId": l.product_id, "quantity": l.quantity, "unitPriceAgorot": l.unit_price_agorot} for l in body.lines
    ]
    return kiosk_basket_check.check(db, machine, lines, body.promotions_etag)


# ── The dashboard ────────────────────────────────────────────────────────────


@router.get("/insights/kiosks")
def get_kiosk_insights(
    kiosk_id: Optional[uuid.UUID] = Query(None, alias="kioskId", description="One kiosk (its machine id)."),
    p: InsightParams = Depends(insight_params),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """"ביצועי קיוסקים": funnel, where they leave, time to order, basket, upsell, payments, per kiosk."""
    ctx = build_context(db, current_user, active_tenant_id, p)
    kid = kiosk_id if isinstance(kiosk_id, uuid.UUID) else None
    return {**S.meta_block(ctx), **kiosk_insights.report(ctx, kid)}


@router.get("/kiosks/health")
def get_kiosks_health(
    company_id: Optional[uuid.UUID] = Query(None, alias="companyId"),
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """"תקינות מכשירים": every kiosk in scope, its parts and alerts, the shops' KDS screens."""
    out = kiosk_health.health_view(
        db, current_user, active_tenant_id,
        company_id=company_id if isinstance(company_id, uuid.UUID) else None,
        shop_id=shop_id if isinstance(shop_id, uuid.UUID) else None,
    )
    db.commit()
    return out


@router.get("/kiosks/{machine_id}/health")
def get_kiosk_health(
    machine_id: str,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """One kiosk's health with its last events (alerts raised / cleared, commands, outages) and sessions."""
    out = kiosk_health.kiosk_detail(db, current_user, active_tenant_id, machine_id)
    db.commit()
    return out
