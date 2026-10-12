"""
"תצורת עבודה של הסניף" on the dashboard (app/services/work_profile.py, P:/specs/shop-work-config.md §7ב).

GET /work-profile/templates     → `[{id, name, description, profile}]` — the six ready-made profiles
                                  (pinned: tests/fixtures/shop_work_templates.json)
GET /shops/{shop_id}/work-profile → `{profile, status, canEdit}` (and `stored`, `hasTills`): the
                                  shop's profile (as stored, else as the shop stands), each field
                                  applied / pending / blocked with its Hebrew reason, and whether
                                  this user may change it
PUT /shops/{shop_id}/work-profile → `{profile}`: saved, what needs no till applied now, the Z and
                                  the local server applied to the tills there are — all or
                                  nothing; answered as the GET. 422 a profile that is not one,
                                  403 a field this user may not change, 409 a refusal of the
                                  rules (an open till, a Z under way, the shop Z producer):
                                  `{detail: {code, message, field, …}}`

Reading is for the shop's managers (the printers page's people); saving for whoever sets up
shops — the Z and the local server, once the shop has tills, for the super admin alone.
"""
from __future__ import annotations

import uuid
from typing import Any, Dict

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import ensure_same_tenant, get_active_tenant_id, get_current_user
from app.models.shop import Shop
from app.models.user import User
from app.services import printers as K
from app.services import till_parameters as TP
from app.services import work_profile as WP
from app.services import work_profile_templates as T

router = APIRouter(tags=["work-profile"])


class WorkProfilePutIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    #: The whole profile (app/services/work_profile_templates.py); checked strictly by the service.
    profile: Dict[str, Any]


def _shop(db: Session, shop_id: uuid.UUID, user: User, tenant_id) -> Shop:
    shop = db.query(Shop).filter(Shop.id == shop_id).first()
    if shop is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Shop not found")
    if shop.tenant_id is None:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="tenant_forbidden")
    ensure_same_tenant(shop.tenant_id, tenant_id)
    K.check_read(db, user, shop)
    return shop


@router.get("/work-profile/templates")
def get_work_profile_templates(current_user: User = Depends(get_current_user)):
    return T.templates()


@router.get("/shops/{shop_id}/work-profile")
def get_shop_work_profile(
    shop_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    shop = _shop(db, shop_id, current_user, active_tenant_id)
    out = WP.view(db, current_user, shop)
    db.commit()  # the built-in parameters, if reading created them
    return out


@router.put("/shops/{shop_id}/work-profile")
def put_shop_work_profile(
    shop_id: uuid.UUID,
    body: WorkProfilePutIn,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    shop = _shop(db, shop_id, current_user, active_tenant_id)
    if not WP.may_manage(db, current_user, shop):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "code": "work_profile_forbidden",
                "message": "תצורת העבודה של הסניף נקבעת על ידי מנהל-על, מפיץ או מנהל החברה.",
            },
        )
    try:
        applied = WP.apply_profile(db, current_user, shop, body.profile)
    except T.ProfileInvalid as exc:
        db.rollback()
        raise WP.invalid(exc)
    except WP.WorkProfileRefused as refused:
        db.rollback()
        raise refused.http()
    db.commit()
    targets = WP.after_commit(db, shop, applied)
    out = WP.view(db, current_user, shop)
    out["changes"] = applied.changes
    db.commit()
    # One `settings` signal per till of the shop: each pulls its parameters, mode and hosts.
    if targets:
        background_tasks.add_task(TP.publish_parameters_notify, targets)
    return out
