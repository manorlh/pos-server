"""
"ברירת מחדל לייצוא" — a company's default export columns per report (P:/specs/reports-upgrade.md
§4.3). Dashboard-only; the rules are in app/services/report_export_defaults.py.
"""
from __future__ import annotations

import uuid
from typing import List, Optional

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_active_tenant_id, get_current_user
from app.models.user import User
from app.services import report_export_defaults as svc

router = APIRouter(prefix="/report-export-defaults", tags=["reports"])


class ExportDefaultIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    company_id: uuid.UUID = Field(..., alias="companyId")
    #: Ordered column keys; an empty list removes the company's default.
    columns: List[str] = Field(default_factory=list)


def _company_or_none(value) -> Optional[uuid.UUID]:
    return value if isinstance(value, uuid.UUID) else None


@router.get("")
def get_export_defaults(
    company_id: Optional[uuid.UUID] = Query(
        None, alias="companyId", description="Defaults to the caller's company (a shop user's: their shop's)."
    ),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """The company's default export columns per report, a parent's filling in (`inherited`)."""
    company = svc.resolve_company(db, current_user, active_tenant_id, _company_or_none(company_id))
    svc.require_read(db, current_user, company)
    return svc.list_defaults(db, current_user, company)


@router.get("/audit")
def get_export_defaults_audit(
    company_id: Optional[uuid.UUID] = Query(None, alias="companyId"),
    report_key: Optional[str] = Query(None, alias="reportKey", max_length=64),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """The latest changes to the company's export defaults (who, when, before → after)."""
    company = svc.resolve_company(db, current_user, active_tenant_id, _company_or_none(company_id))
    svc.require_edit(db, current_user, company)
    return {"companyId": str(company.id), "items": svc.audit_log(db, company, report_key if isinstance(report_key, str) else None)}


@router.put("/{report_key}")
def put_export_default(
    report_key: str,
    body: ExportDefaultIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Set the company's default export columns for one report (an empty list removes it)."""
    svc.validate_report_key(report_key)
    company = svc.resolve_company(db, current_user, active_tenant_id, body.company_id)
    svc.require_edit(db, current_user, company)
    return svc.set_default(db, current_user, company, report_key, body.columns)
