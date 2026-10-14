"""
"שחזור שולחן ותשלומים" — the dashboard's tables page edits the table-restore till parameters per level
(P:/specs/table-restore-payments.md §5, app/services/table_restore.py) — and, in the same card
("הגדרות שולחנות"), the staff / managers' tables' `staffTableDiscountCheck` (P:/specs/owner-decisions-1410.md §1):

    GET /companies/{id}/table-restore-params?scopeType=&scopeId=   what a level sets, inherits, the definitions
    PUT /companies/{id}/table-restore-params                        set / clear them at a level

Who: as the drawer's parameters on the roles page (app/routers/till_roles.py `_level_access`) —
reading for whoever reads the company's till roles; writing for the super admin, a distributor and a
company manager over the company, and a shop's manager for their own shop's levels. Every write tells
the tills under the level to pull their parameters (Ably `settings`, `till_parameters_updated`).
"""
from __future__ import annotations

import uuid
from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_active_tenant_id, get_current_user
from app.models.user import User, UserRole
from app.routers.till_roles import _company, _level_access, _readable, may_edit
from app.services import table_restore as TR

router = APIRouter(tags=["table-restore"])


class TableRestoreParamsIn(BaseModel):
    scope_type: str = Field(..., alias="scopeType")
    scope_id: uuid.UUID = Field(..., alias="scopeId")
    #: key → value; null clears this level's own value (it inherits again).
    values: Dict[str, Any]

    model_config = {"populate_by_name": True}


def _may_edit_level(db: Session, user: User, company, scope_type: str, scope_id: Any) -> bool:
    if may_edit(db, user, company):
        return True
    if scope_type == "company" or getattr(user, "role", None) != UserRole.SHOP_MANAGER:
        return False
    from app.services.cash_drawer import scope_company

    return str(scope_company(db, scope_type, scope_id)[1]) == str(getattr(user, "shop_id", None))


@router.get("/companies/{company_id}/table-restore-params")
def get_table_restore_params(
    company_id: str,
    scope_type: str = Query(..., alias="scopeType"),
    scope_id: uuid.UUID = Query(..., alias="scopeId"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    company = _readable(db, company_id, current_user, active_tenant_id)
    _level_access(db, company, scope_type, scope_id, current_user, write=False)
    view = TR.level_view(db, scope_type, scope_id)
    view["canEdit"] = _may_edit_level(db, current_user, company, scope_type, scope_id)
    db.commit()  # `ensure_builtin_parameters` may have created them
    return view


@router.put("/companies/{company_id}/table-restore-params")
def put_table_restore_params(
    company_id: str,
    body: TableRestoreParamsIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    from app.services.till_parameters import TillParameterValueError, publish_parameters_notify

    company = _company(db, company_id, active_tenant_id)
    _level_access(db, company, body.scope_type, body.scope_id, current_user, write=True)
    try:
        targets = TR.save_values(db, body.scope_type, body.scope_id, body.values, user=current_user)
    except TillParameterValueError as exc:
        db.rollback()
        raise HTTPException(status_code=422, detail={"code": "invalid_value", "message": str(exc)})
    db.commit()
    publish_parameters_notify(targets)
    view = TR.level_view(db, body.scope_type, body.scope_id)
    view["canEdit"] = True
    return view
