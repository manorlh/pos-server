"""
"עובד מחובר בקופה אחת בלבד" — see app/services/user_sessions.py and
docs/SPEC_EXCLUSIVE_LOGIN.md.

Till (machine JWT only):

POST /sync/{machine_id}/user-session/claim      {posUserId, force?} → 200 claimed | held | off;
                                                 409 `user_signed_in_elsewhere` (where, since)
POST /sync/{machine_id}/user-session/heartbeat  {posUserId} → 200 held | claimed | off;
                                                 409 `user_signed_in_elsewhere` / `user_session_released`
POST /sync/{machine_id}/user-session/release    {posUserId} → 200 released | not_held

`force: true` releases the session at the other till, with a manager's approval: a grant
for `user-session:release` in `X-Elevation-Token` (a manager's PIN at the till), or the
signed-in operator named by `X-Pos-User-Id` when their own role holds the scope — the
same two ways as a table's forced release. Recorded as an exception.

Dashboard (Clerk):

GET  /shops/{shop_id}/user-sessions                         → who is signed in where
POST /shops/{shop_id}/user-sessions/{session_id}/release    → a manager releases one
"""
from __future__ import annotations

import uuid
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import (
    ELEVATION_HEADER,
    POS_USER_HEADER,
    _checked_grant,
    _elevation_401,
    _operator_with_authority,
    ensure_same_tenant,
    get_active_tenant_id,
    get_current_user,
    get_pos_machine_from_sync_machine_token,
)
from app.models.elevated_session import ElevatedSession
from app.models.pos_machine import POSMachine
from app.models.pos_user import PosUser
from app.models.pos_user_session import PosUserSession
from app.models.user import User
from app.routers.pos_users import _check_read, _check_write, _get_shop_or_404
from app.services import user_sessions as svc
from app.services.elevation import consume_per_action_use
from app.services.permissions import Scope, requires_per_action_reauth

till_router = APIRouter(prefix="/sync", tags=["user-sessions"])
router = APIRouter(prefix="/shops", tags=["user-sessions"])

SCOPE = Scope.USER_SESSION_RELEASE


class _Camel(BaseModel):
    model_config = ConfigDict(populate_by_name=True)


class UserSessionIn(_Camel):
    pos_user_id: uuid.UUID = Field(alias="posUserId")


class UserSessionClaimIn(UserSessionIn):
    #: Release the session at another till (needs a manager's approval).
    force: bool = False


# ── The till's side ───────────────────────────────────────────────────────────


def _assigned(machine: POSMachine) -> None:
    if machine.shop_id is None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="machine_not_assigned")


def _pos_user(db: Session, machine: POSMachine, pos_user_id: uuid.UUID) -> PosUser:
    """An employee of this till's own shop — the only ones it may sign in."""
    pos_user = (
        db.query(PosUser)
        .filter(PosUser.id == pos_user_id, PosUser.shop_id == machine.shop_id)
        .first()
    )
    if pos_user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="pos_user_not_found")
    return pos_user


def _force_approval(
    db: Session,
    machine: POSMachine,
    elevation_token: Optional[str],
    operator_id: Optional[str],
) -> tuple[svc.Approval, Optional[ElevatedSession]]:
    """A grant for `user-session:release` at this till, or an operator whose role holds it."""
    if elevation_token:
        grant = _checked_grant(db, machine, elevation_token, SCOPE)
        pos_user_id = str(grant.pos_user_id) if grant.pos_user_id else None
        if grant.pos_user_id is not None:
            name = svc.pos_user_name(db.get(PosUser, grant.pos_user_id))
        else:
            name = svc.dashboard_user_name(db.get(User, grant.user_id)) if grant.user_id else None
        return svc.Approval(name=name, user_id=grant.user_id, pos_user_id=pos_user_id), grant
    operator = _operator_with_authority(db, machine, operator_id, SCOPE)
    if operator is None:
        raise _elevation_401("elevation_required")
    return svc.Approval(name=svc.pos_user_name(operator), pos_user_id=str(operator.id)), None


def _conflict(code: str, info: dict) -> HTTPException:
    return HTTPException(status_code=status.HTTP_409_CONFLICT, detail={"code": code, **(info or {})})


@till_router.post("/{machine_id}/user-session/claim")
def claim_user_session(
    machine_id: str,
    body: UserSessionClaimIn,
    machine: POSMachine = Depends(get_pos_machine_from_sync_machine_token),
    elevation_token: Optional[str] = Header(None, alias=ELEVATION_HEADER),
    operator_id: Optional[str] = Header(None, alias=POS_USER_HEADER),
    db: Session = Depends(get_db),
):
    """
    Before the till lets an employee in. 200 when the employee is free here, already this
    till's, or held by a till gone silent; 409 `user_signed_in_elsewhere` with where and
    since when otherwise. `force` with a manager's approval releases the other till's.
    """
    _assigned(machine)
    pos_user = _pos_user(db, machine, body.pos_user_id)
    approval, grant = (None, None)
    if body.force:
        approval, grant = _force_approval(db, machine, elevation_token, operator_id)
    try:
        result = svc.claim(db, machine, pos_user, approval=approval)
    except svc.SignedInElsewhere as conflict:
        # What the claim tidied on the way (a stale or a leftover session) is kept.
        db.commit()
        raise _conflict("user_signed_in_elsewhere", conflict.info)
    if result.forced:
        if grant is not None and requires_per_action_reauth(SCOPE) and not consume_per_action_use(db, grant):
            raise _elevation_401("elevation_already_used")
        svc.record_forced_release(db, machine, pos_user, result.took_over, approval)
    db.commit()
    return result.out()


@till_router.post("/{machine_id}/user-session/heartbeat")
def heartbeat_user_session(
    machine_id: str,
    body: UserSessionIn,
    machine: POSMachine = Depends(get_pos_machine_from_sync_machine_token),
    db: Session = Depends(get_db),
):
    """About every minute while an employee is signed in at this till."""
    _assigned(machine)
    pos_user = _pos_user(db, machine, body.pos_user_id)
    try:
        result = svc.heartbeat(db, machine, pos_user)
    except svc.SessionReleased as released:
        db.commit()
        raise _conflict("user_session_released", released.info)
    except svc.SignedInElsewhere as conflict:
        db.commit()
        raise _conflict("user_signed_in_elsewhere", conflict.info)
    db.commit()
    return result.out()


@till_router.post("/{machine_id}/user-session/release")
def release_user_session(
    machine_id: str,
    body: UserSessionIn,
    machine: POSMachine = Depends(get_pos_machine_from_sync_machine_token),
    db: Session = Depends(get_db),
):
    """The employee signed out (or switched, or the till locked). Idempotent."""
    released = svc.release(db, machine, body.pos_user_id)
    db.commit()
    return {"status": "released" if released else "not_held"}


# ── The dashboard's side ──────────────────────────────────────────────────────


@router.get("/{shop_id}/user-sessions")
def list_user_sessions(
    shop_id: str,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Who is signed in at which till of the shop now. `stale`: its till has gone silent."""
    shop = _get_shop_or_404(db, shop_id)
    ensure_same_tenant(shop.tenant_id, active_tenant_id)
    _check_read(current_user, shop, db)
    from app.services.till_parameters import resolve_for_shop

    return {
        "exclusive": svc.enabled_of(resolve_for_shop(db, shop).get(svc.PARAM_ENABLED)),
        "sessions": svc.active_sessions_for_shop(db, shop.id),
    }


@router.post("/{shop_id}/user-sessions/{session_id}/release")
def release_user_session_from_dashboard(
    shop_id: str,
    session_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """A manager frees an employee (a till that went down); that till signs them out if it is up."""
    shop = _get_shop_or_404(db, shop_id)
    ensure_same_tenant(shop.tenant_id, active_tenant_id)
    _check_write(current_user, shop, db)
    row = (
        db.query(PosUserSession)
        .filter(PosUserSession.id == session_id, PosUserSession.shop_id == shop.id)
        .first()
    )
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found")
    svc.release_by_dashboard(db, row, current_user)
    db.commit()
    return {"status": "released"}
