"""
"הרשאות" — GET /system/access (anyone signed in: the dashboard hides by it) and
PUT /system/access (the super admin's). See app/services/access.py.
"""
from __future__ import annotations

from typing import Dict, List

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_current_user
from app.models.user import User, UserRole
from app.services import access

router = APIRouter(prefix="/system", tags=["system"])


class AccessIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    hidden_nav: Dict[str, List[str]] = Field(default_factory=dict, alias="hiddenNav")
    denied_features: Dict[str, List[str]] = Field(default_factory=dict, alias="deniedFeatures")


@router.get("/access")
def get_access(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return {**access.get_access(db), "roles": list(access.ROLES), "features": list(access.FEATURES)}


@router.put("/access")
def put_access(body: AccessIn, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    if current_user.role != UserRole.SUPER_ADMIN:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="super_admin_only")
    out = access.set_access(db, current_user, {"hiddenNav": body.hidden_nav, "deniedFeatures": body.denied_features})
    db.commit()
    return {**out, "roles": list(access.ROLES), "features": list(access.FEATURES)}
