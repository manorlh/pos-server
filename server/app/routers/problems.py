"""
"בעיות" — one screen of what needs a manager now (P:/specs/manager-problems.md §3, §6;
app/services/problems.py).

Dashboard (Clerk/user JWT + X-Tenant-Id):

GET /problems              → {counts: {high, medium, low}, total, hiddenGroups, groups: [{key, hidden,
                              total, items: [...]}]} — every group in one call (companyId / shopId narrow it)
GET /problems/preferences  → {hiddenGroups: [...]} — mine
PUT /problems/preferences  → {hiddenGroups: [...]} — mine, kept on my user (every device)

Scoped exactly like the exceptions log (`scoped()`): a cashier gets 403. The `integrity` group
("שלמות נתונים") is the super admin's only. Hidden groups still come back (`hidden: true`) but
are left out of `counts` / `total` — the menu's badge.
"""
from __future__ import annotations

import uuid
from typing import Any, Dict, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_active_tenant_id, get_current_user
from app.models.user import User, UserRole
from app.services import problems as svc
from app.services import user_preferences

router = APIRouter(prefix="/problems", tags=["problems"])

NO_READ_ROLES = {UserRole.CASHIER, getattr(UserRole, "PRODUCER_VIEW", UserRole.CASHIER)}


def _staff(user: User) -> User:
    if user.role in NO_READ_ROLES:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")
    return user


@router.get("")
def list_problems(
    company_id: Optional[uuid.UUID] = Query(None, alias="companyId"),
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    _staff(current_user)
    out = svc.build(
        db, current_user, active_tenant_id,
        hidden=user_preferences.read_problems_hidden(current_user),
        company_id=company_id, shop_id=shop_id,
    )
    # The kiosks' health view may note a kiosk offline in the exceptions, as `GET /kiosks/health` does.
    db.commit()
    return out


def _prefs_out(user: User) -> Dict[str, Any]:
    return {"hiddenGroups": user_preferences.read_problems_hidden(user), "groups": svc.known_groups(user)}


@router.get("/preferences")
def get_preferences(current_user: User = Depends(get_current_user)):
    _staff(current_user)
    return _prefs_out(current_user)


@router.put("/preferences")
def put_preferences(
    body: Dict[str, Any] = Body(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _staff(current_user)
    if not isinstance(body, dict) or "hiddenGroups" not in body:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="hiddenGroups is required")
    user_preferences.write_problems_hidden(db, current_user, body.get("hiddenGroups"))
    return _prefs_out(current_user)
