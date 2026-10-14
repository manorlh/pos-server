"""
"תפריט הקופה" — `hiddenMenuItems` at one level, edited outside the parameters page
(P:/specs/till-menu-hide.md §3, app/services/till_menu.py). One till parameter, two ways in:

    GET /till-menu-hide?level=company|shop|area|machine&id=   the device page's card
    PUT /till-menu-hide?level=&id=   {hidden: [keys] | null}
    GET /till-design/menu-hide?level=&id=                      "עיצוב קופה"'s card
    PUT /till-design/menu-hide?level=&id=   {hidden: [keys] | null}

Both answer the level's view (app/services/till_menu.py `level_view`: own, inherited and from where,
effective, the warnings, every item) with `canEdit`, and after a write also `ignored` — the keys
dropped because the cloud does not know them. `hidden` [] = nothing hidden at this level whatever the
levels above hide; null = the level's own list removed (it inherits again). Each change is a row in
`till_parameter_changes`, and every till the level reaches is told to pull its parameters (Ably
`settings`, `till_parameters_updated`). The super admin also edits it on "פרמטרים לקופות".

Who — reading for whoever reads the level in "עיצוב קופה" (app/routers/till_design.py `resolve_scope`:
a super admin, a distributor's own tills, a company manager's tree, a shop manager's shop). Writing, on
both routes alike (spec §3; the owner, 14.10 — hiding Z, the shift close or the settings is not a shop
manager's call): the super admin, a distributor and a company manager over the level — the company's
settings writers (`settingsWrite`). A shop manager sees the card read-only (`canEdit` false, 403 on a PUT).
"""
from __future__ import annotations

import uuid
from typing import Any, Dict, List, Literal, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_active_tenant_id, get_current_machine_admin, get_current_user
from app.models.user import User, UserRole
from app.routers.till_design import Scope, resolve_scope
from app.services import till_menu as TM

router = APIRouter(tags=["till-menu-hide"])

Level = Literal["company", "shop", "area", "machine"]

#: Who writes `hiddenMenuItems` on either route: the settings writers above a shop (spec §3,
#: `_check_company_settings_write`), each within their scope (`resolve_scope`). Never a shop manager.
SETTINGS_WRITERS = (UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR, UserRole.COMPANY_MANAGER)


class MenuHideIn(BaseModel):
    #: The keys hidden at this level ([] — none here); null removes the level's own list.
    hidden: Optional[List[str]] = Field(default=None, max_length=TM.MAX_ITEMS)


def _role(user: User):
    return getattr(user, "role", None)


def _view(db: Session, scope: Scope, can_edit: bool, ignored=()) -> Dict[str, Any]:
    view = TM.level_view(db, scope.level, scope.entity_id)
    view["canEdit"] = can_edit
    view["ignored"] = list(ignored)
    db.commit()  # `ensure_builtin_parameters` may have created the definition
    return view


def _refuse_non_writer(user: User) -> None:
    if _role(user) not in SETTINGS_WRITERS:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")


def _save(db: Session, background_tasks: Optional[BackgroundTasks], scope: Scope, body: MenuHideIn, user: User):
    from app.services.till_parameters import TillParameterValueError, publish_parameters_notify

    try:
        saved = TM.save(db, scope.level, scope.entity_id, body.hidden, user=user)
    except TillParameterValueError as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": "invalid_menu_keys", "message": str(exc)},
        ) from exc
    db.commit()
    if background_tasks is not None and saved.targets:
        background_tasks.add_task(publish_parameters_notify, saved.targets)
    return saved


# ── The device page ("תפריט הקופה", spec §3) ─────────────────────────────────


@router.get("/till-menu-hide")
def get_till_menu_hide(
    level: Level = Query(...),
    scope_id: uuid.UUID = Query(..., alias="id"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    scope = resolve_scope(db, current_user, level, scope_id, active_tenant_id)
    return _view(db, scope, _role(current_user) in SETTINGS_WRITERS)


@router.put("/till-menu-hide")
def put_till_menu_hide(
    body: MenuHideIn,
    background_tasks: BackgroundTasks,
    level: Level = Query(...),
    scope_id: uuid.UUID = Query(..., alias="id"),
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """403 for a shop manager (the spec's writers are the super admin and the company managers)."""
    _refuse_non_writer(current_user)
    scope = resolve_scope(db, current_user, level, scope_id, active_tenant_id)
    saved = _save(db, background_tasks, scope, body, current_user)
    return _view(db, scope, True, saved.ignored)


# ── "עיצוב קופה" ──────────────────────────────────────────────────────────────

design_router = APIRouter(prefix="/till-design", tags=["till-design"])


@design_router.get("/menu-hide")
def get_design_menu_hide(
    level: Level = Query(...),
    scope_id: uuid.UUID = Query(..., alias="id"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Read with the same access as `GET /till-design/settings`; `canEdit` for the settings writers only."""
    scope = resolve_scope(db, current_user, level, scope_id, active_tenant_id)
    return _view(db, scope, _role(current_user) in SETTINGS_WRITERS)


@design_router.put("/menu-hide")
def put_design_menu_hide(
    body: MenuHideIn,
    background_tasks: BackgroundTasks,
    level: Level = Query(...),
    scope_id: uuid.UUID = Query(..., alias="id"),
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    The design's scope (`resolve_scope`), written by the settings writers only — 403 for a shop manager, who
    may write the rest of the design. 422 `invalid_menu_keys` for what is not a key list.
    """
    _refuse_non_writer(current_user)
    scope = resolve_scope(db, current_user, level, scope_id, active_tenant_id)
    saved = _save(db, background_tasks, scope, body, current_user)
    return _view(db, scope, True, saved.ignored)
