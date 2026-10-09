"""
"הרשאות" — GET /system/access (anyone signed in: the dashboard hides by it) and
PUT /system/access (the super admin's). See app/services/access.py.

"סוג עוסק" — GET /system/dealer-types (anyone signed in) and PUT (the super admin's):
the exempt dealer's turnover ceiling. See app/services/dealer_types.py.

"ממשק פתוח" — GET /system/open-format (anyone signed in) and PUT (the super admin's): the
software details every open-format file names (A000 1006–1012). See
app/services/open_format/software.py.
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
from app.services.open_format import software as open_format_software

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


# ── "ממשק פתוח": the software details in every open-format file ─────────────────


class OpenFormatSoftwareIn(BaseModel):
    """
    The software house's registration of the software, the same for every customer.
    Each field: null / absent = not configured (the file writes a placeholder).
    """

    model_config = ConfigDict(populate_by_name=True)

    #: A000 1007 "שם התוכנה", up to 20 characters.
    software_name: Optional[str] = Field(None, alias="softwareName")
    #: A000 1008 "מהדורת התוכנה"; empty = the newest till release's version.
    software_version: Optional[str] = Field(None, alias="softwareVersion")
    #: A000 1010 "שם יצרן התוכנה", up to 20 characters.
    manufacturer_name: Optional[str] = Field(None, alias="manufacturerName")
    #: A000 1009 "מספר ע"מ של יצרן התוכנה": 9 digits, valid check digit.
    manufacturer_vat_number: Optional[str] = Field(None, alias="manufacturerVatNumber")
    #: A000 1006 "מספר תעודת הרישום של התוכנה": up to 8 digits.
    registration_number: Optional[str] = Field(None, alias="registrationNumber")
    #: The drive the files are saved to ("C:"), for A000 1012.
    output_drive: Optional[str] = Field(None, alias="outputDrive")


@router.get("/open-format")
def get_open_format(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return open_format_software.get_settings(db)


@router.put("/open-format")
def put_open_format(
    body: OpenFormatSoftwareIn, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    if current_user.role != UserRole.SUPER_ADMIN:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="super_admin_only")
    try:
        out = open_format_software.set_settings(db, current_user, body.model_dump(by_alias=True))
    except open_format_software.SoftwareSettingsError as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"field": exc.field, "message": exc.message},
        )
    db.commit()
    return out
