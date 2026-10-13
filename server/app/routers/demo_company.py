"""
"בניית חברת הדגמה" (P:/specs/demo-company.md, app/services/demo_company.py) — the super admin's.

GET  /demo-company        → the organization's demo company as it stands: its shops, the devices
                            to pair with their live codes, what the owner still has to fill, and
                            what to try in each shop (`{"exists": false}` before the first build)
POST /demo-company/build  → build what is missing — the first click everything, a second one only
                            what has no record yet (never twice, never over the owner's changes),
                            a fresh code for every device not paired yet. Body (all optional):
                            `{vatNumber, dealerType, address, city, phone}`. 409
                            `demo_company_build_in_progress` while another build runs.

Both: 403 for anybody but the super admin.
"""
from __future__ import annotations

from typing import Literal, Optional

from fastapi import APIRouter, BackgroundTasks, Depends
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_active_tenant_id, get_current_user
from app.models.user import User
from app.services import demo_company as DC

router = APIRouter(prefix="/demo-company", tags=["demo-company"])


class DemoCompanyBuildIn(BaseModel):
    """The business details the confirmation asks — every one optional, editable later."""

    model_config = ConfigDict(populate_by_name=True)

    #: ח.פ / עוסק.
    vat_number: Optional[str] = Field(None, alias="vatNumber", max_length=20)
    dealer_type: Optional[Literal["company", "licensed", "exempt"]] = Field(None, alias="dealerType")
    address: Optional[str] = Field(None, max_length=500)
    city: Optional[str] = Field(None, max_length=100)
    #: The phone under the receipt header.
    phone: Optional[str] = Field(None, max_length=30)


@router.get("")
def get_demo_company(
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    DC.check_super_admin(current_user)
    return DC.summary(db, active_tenant_id)


@router.post("/build")
def build_demo_company(
    background_tasks: BackgroundTasks,
    body: Optional[DemoCompanyBuildIn] = None,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    return DC.build(db, current_user, active_tenant_id, body or DemoCompanyBuildIn(), background_tasks)
