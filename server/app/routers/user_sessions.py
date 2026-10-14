"""
"עובד מחובר בקופה אחת בלבד" — see app/services/user_sessions.py and
docs/SPEC_EXCLUSIVE_LOGIN.md (v2: P:/specs/exclusive-login-v2.md).

Till (machine JWT only):

POST /sync/{machine_id}/user-session/claim      {posUserId, force?} → 200 claimed | held | off | exempt;
                                                 409 `user_signed_in_elsewhere` (where, since, holderSilentSince)
POST /sync/{machine_id}/user-session/heartbeat  {posUserId, signedInAt?} → 200 held | claimed | off | exempt;
                                                 409 `user_signed_in_elsewhere` / `user_session_released`
POST /sync/{machine_id}/user-session/release    {posUserId} → 200 released | not_held

Every claim / heartbeat answer, 200 or 409, carries the policy the till follows: `exclusive`,
`staleMinutes`, `autoRelease` (off | minutes), `offline` (allow | lan | manager) and
`duplicate` (warn | signout).

`force: true` releases the session at the other till, with a manager's approval: a grant
for `user-session:release` in `X-Elevation-Token` (a manager's PIN at the till, or the grant
of a phone's approval of "שחרור עובד מחובר" — remote-approval type `user_release`), or the
signed-in operator named by `X-Pos-User-Id` when their own role holds the scope — the
same ways as a table's forced release. Recorded as an exception.

Dashboard (Clerk):

GET  /shops/{shop_id}/user-sessions                         → who is signed in where (+ `canRelease`)
POST /shops/{shop_id}/user-sessions/{session_id}/release    → a manager releases one (`user_sessions_release`)
"""
from __future__ import annotations

import uuid
from datetime import datetime
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
from app.routers.pos_users import _check_read, _get_shop_or_404
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


class UserSessionHeartbeatIn(UserSessionIn):
    #: When the till let the employee in, by its own clock: which of two devices signed in last
    #: (`exclusiveUserLoginDuplicate = signout`), and that a sign-in after a release is a new one.
    signed_in_at: Optional[datetime] = Field(None, alias="signedInAt")


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


def _remote_approval(db: Session, grant: ElevatedSession, pos_user: PosUser) -> svc.Approval:
    """
    A phone's approval of "שחרור עובד מחובר" (`user_release`): good for the employee it was asked
    for only (403 `elevation_wrong_user`), and named as the approver who decided it.
    """
    from app.models.remote_approval import ApprovalRequest

    wanted = svc.remote_grant_user(db, grant.approval_request_id)
    if wanted is not None and wanted != str(pos_user.id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="elevation_wrong_user")
    req = db.get(ApprovalRequest, grant.approval_request_id)
    name = (req.decided_by_name if req is not None else None) or (
        svc.dashboard_user_name(db.get(User, grant.user_id)) if grant.user_id else None
    )
    decided_by = req.decided_by_pos_user_id if req is not None else None
    return svc.Approval(
        name=name,
        user_id=grant.user_id,
        pos_user_id=str(decided_by) if decided_by else None,
        via=svc.VIA_REMOTE,
        approval_request_id=str(grant.approval_request_id),
    )


def _force_approval(
    db: Session,
    machine: POSMachine,
    pos_user: PosUser,
    elevation_token: Optional[str],
    operator_id: Optional[str],
) -> tuple[svc.Approval, Optional[ElevatedSession]]:
    """
    A grant for `user-session:release` at this till — a code typed there, or a phone's approval —
    or the signed-in operator whose own role holds it.
    """
    if elevation_token:
        grant = _checked_grant(db, machine, elevation_token, SCOPE)
        if isinstance(getattr(grant, "approval_request_id", None), uuid.UUID):
            return _remote_approval(db, grant, pos_user), grant
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
    till's, held by a till gone silent (auto release on), or not bound by the rule (`exempt`);
    409 `user_signed_in_elsewhere` with where, since when and whether that device still
    reports otherwise. `force` with a manager's approval releases the other till's.
    """
    _assigned(machine)
    pos_user = _pos_user(db, machine, body.pos_user_id)
    approval, grant = (None, None)
    if body.force:
        approval, grant = _force_approval(db, machine, pos_user, elevation_token, operator_id)
    try:
        result = svc.claim(db, machine, pos_user, approval=approval)
    except svc.SignedInElsewhere as conflict:
        # What the claim tidied on the way (a stale or a leftover session) is kept.
        db.commit()
        raise _conflict("user_signed_in_elsewhere", conflict.detail())
    if result.forced:
        if grant is not None and requires_per_action_reauth(SCOPE) and not consume_per_action_use(db, grant):
            raise _elevation_401("elevation_already_used")
        svc.record_forced_release(db, machine, pos_user, result.took_over, approval)
    db.commit()
    return result.out()


@till_router.post("/{machine_id}/user-session/heartbeat")
def heartbeat_user_session(
    machine_id: str,
    body: UserSessionHeartbeatIn,
    machine: POSMachine = Depends(get_pos_machine_from_sync_machine_token),
    db: Session = Depends(get_db),
):
    """About every minute while an employee is signed in at this till."""
    _assigned(machine)
    pos_user = _pos_user(db, machine, body.pos_user_id)
    try:
        # (A caller that builds the body itself may hand the plain `UserSessionIn`: no sign-in time.)
        result = svc.heartbeat(db, machine, pos_user, signed_in_at=getattr(body, "signed_in_at", None))
    except svc.SessionReleased as released:
        db.commit()
        raise _conflict("user_session_released", released.detail())
    except svc.SignedInElsewhere as conflict:
        db.commit()
        raise _conflict("user_signed_in_elsewhere", conflict.detail())
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
    """
    Who is signed in at which device of the shop now. `silent`: that device stopped reporting;
    `canRelease`: this user may release one ("שחרור עובד מחובר במכשיר").
    """
    shop = _get_shop_or_404(db, shop_id)
    ensure_same_tenant(shop.tenant_id, active_tenant_id)
    _check_read(current_user, shop, db)
    from app.services.till_parameters import resolve_for_shop

    return {
        "exclusive": svc.enabled_of(resolve_for_shop(db, shop).get(svc.PARAM_ENABLED)),
        "sessions": svc.active_sessions_for_shop(db, shop.id),
        "canRelease": svc.may_release_from_dashboard(db, current_user),
    }


def _check_release(user: User, shop, db: Session) -> None:
    """"שחרור עובד מחובר במכשיר": the role and the dashboard permission, over this shop."""
    if not svc.may_release_from_dashboard(db, user):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": "section_forbidden", "section": svc.RELEASE_SECTION, "level": "edit"},
        )
    _check_read(user, shop, db)


@router.post("/{shop_id}/user-sessions/{session_id}/release")
def release_user_session_from_dashboard(
    shop_id: str,
    session_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    A manager frees an employee (a device that went down, or one they left signed in); that
    device signs them out if it is up. Recorded as an exception. Already released: `not_held`.
    """
    shop = _get_shop_or_404(db, shop_id)
    ensure_same_tenant(shop.tenant_id, active_tenant_id)
    _check_release(current_user, shop, db)
    row = (
        db.query(PosUserSession)
        .filter(PosUserSession.id == session_id, PosUserSession.shop_id == shop.id)
        .first()
    )
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found")
    released = svc.release_by_dashboard(db, row, current_user)
    db.commit()
    return {"status": "released" if released else "not_held"}
