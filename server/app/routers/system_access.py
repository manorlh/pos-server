"""
"הרשאות" — GET /system/access (anyone signed in: the dashboard hides by it) and
PUT /system/access (the super admin's). See app/services/access.py.

"סוג עוסק" — GET /system/dealer-types (anyone signed in) and PUT (the super admin's):
the exempt dealer's turnover ceiling. See app/services/dealer_types.py.
"""
from __future__ import annotations

from typing import Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_current_user
from app.models.user import User, UserRole
from app.services import access, dealer_types

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


# ── "סוג עוסק": the exempt dealer's turnover ceiling (docs/SPEC_BUSINESS_TYPE.md) ──


class DealerTypesIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    #: The annual turnover above which an exempt dealer (עוסק פטור) stops being one, in
    #: shekels. Set by law and updated every year — so a setting, never a constant.
    #: null = not set (no warning anywhere).
    exempt_turnover_threshold: Optional[float] = Field(None, alias="exemptTurnoverThreshold", gt=0)
    #: Warn from this share of it (0.8 = from 80%).
    warn_ratio: float = Field(dealer_types.DEFAULT_WARN_RATIO, alias="warnRatio", gt=0, le=1)


@router.get("/dealer-types")
def get_dealer_types(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return dealer_types.get_settings(db)


@router.put("/dealer-types")
def put_dealer_types(
    body: DealerTypesIn, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    if current_user.role != UserRole.SUPER_ADMIN:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="super_admin_only")
    out = dealer_types.set_settings(
        db, current_user,
        {"exemptTurnoverThreshold": body.exempt_turnover_threshold, "warnRatio": body.warn_ratio},
    )
    db.commit()
    return out
