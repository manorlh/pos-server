"""
Till elevation: a named person authorising a narrow action at a terminal.

Every route here authenticates the *machine* through its own token — the till says
which terminal is asking — and then authenticates the *person* with an email and a
till PIN, verified here rather than on the device. The device therefore never has
to be trusted to have checked anything, which is the whole point: a compromised
till saying "a manager approved this" would be worth nothing.
"""

from __future__ import annotations

import math
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, status
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import (
    ELEVATION_HEADER,
    get_pos_machine_from_machine_token,
)
from app.models.pos_machine import POSMachine
from app.models.user import User
from app.schemas.elevation import (
    ElevationRequest,
    ElevationResponse,
    ElevationStatus,
)
from app.services.auth import get_password_hash, verify_password
from app.services.elevation import (
    create_session,
    grantable_scopes,
    pin_lockout_remaining,
    resolve_session,
    revoke_session,
    usable_scopes,
    verify_till_pin,
)
from app.services.permissions import parse_scopes

router = APIRouter(prefix="/elevation", tags=["elevation"])


#: Burned when the email is unknown, so that "no such user" and "wrong PIN" cost
#: roughly the same wall-clock time and cannot be told apart by stopwatch.
_TIMING_DECOY = get_password_hash("timing-decoy-not-a-real-pin")


def _display_name(user: User) -> str:
    return user.username or user.email


def _require_assigned(machine: POSMachine) -> None:
    if not machine.shop_id or not machine.tenant_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Machine must be assigned to a shop",
        )


def _find_user(db: Session, email: str) -> Optional[User]:
    # Case-insensitive, matching how Clerk sign-in claims an invited row. Comparing
    # exactly here would let `Yossi@` and `yossi@` behave differently at the till
    # than they do at sign-in.
    return (
        db.query(User)
        .filter(func.lower(User.email) == (email or "").strip().lower())
        .first()
    )


def _invalid_credentials() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid_credentials"
    )


def _authenticate(db: Session, email: str, pin: str) -> User:
    """Resolve and verify a person, or raise. Never says which half was wrong."""
    user = _find_user(db, email)
    if user is None or not user.is_active or not user.till_pin_hash:
        verify_password(pin or "", _TIMING_DECOY)
        raise _invalid_credentials()

    remaining = pin_lockout_remaining(user)
    if remaining is not None:
        # Reported distinctly, unlike a wrong PIN. It technically confirms the
        # address exists, but the caller is already a paired till inside the shop,
        # so there is nothing here they could not learn by looking at the rota —
        # and a manager who cannot see "locked for 4 minutes" will just keep
        # retrying and stay locked.
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="pin_locked",
            headers={"Retry-After": str(max(1, math.ceil(remaining.total_seconds())))},
        )

    if not verify_till_pin(db, user, pin):
        db.commit()
        raise _invalid_credentials()
    return user


@router.post("/sessions", response_model=ElevationResponse)
def create_elevation(
    data: ElevationRequest,
    machine: POSMachine = Depends(get_pos_machine_from_machine_token),
    db: Session = Depends(get_db),
):
    """Exchange an email + till PIN for a scoped, short-lived grant at this machine."""
    _require_assigned(machine)
    user = _authenticate(db, data.email, data.pin)

    requested = parse_scopes(data.scopes)
    if not requested:
        db.commit()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="no_recognised_scopes"
        )

    granted = grantable_scopes(db, user, machine, requested)
    if not granted:
        db.commit()
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="not_permitted_here"
        )

    raw, session = create_session(db, user, machine, granted)
    db.commit()
    db.refresh(session)
    return ElevationResponse(
        token=raw,
        scopes=[scope.value for scope in granted],
        expires_at=session.expires_at,
        absolute_expires_at=session.absolute_expires_at,
        user_name=_display_name(user),
        user_email=user.email,
    )


@router.get("/sessions/current", response_model=ElevationStatus)
def read_current_elevation(
    machine: POSMachine = Depends(get_pos_machine_from_machine_token),
    elevation_token: Optional[str] = Header(None, alias=ELEVATION_HEADER),
    db: Session = Depends(get_db),
):
    """
    What the till currently holds. Reading this also slides the idle window, so a
    device polling to show a countdown keeps an attended session alive — which is
    the behaviour you want and worth knowing about.
    """
    session = resolve_session(db, elevation_token or "")
    if session is None or str(session.machine_id) != str(machine.id):
        db.commit()
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="elevation_expired"
        )
    user = session.user
    db.commit()
    return ElevationStatus(
        # What is *left*, not what was granted: a per-action scope already spent would
        # otherwise keep the till offering a button the next request refuses.
        scopes=usable_scopes(session),
        expires_at=session.expires_at,
        absolute_expires_at=session.absolute_expires_at,
        user_name=_display_name(user),
        user_email=user.email,
    )


@router.delete("/sessions/current", status_code=status.HTTP_204_NO_CONTENT)
def end_current_elevation(
    machine: POSMachine = Depends(get_pos_machine_from_machine_token),
    elevation_token: Optional[str] = Header(None, alias=ELEVATION_HEADER),
    db: Session = Depends(get_db),
):
    """
    Hand the grant back early — the manager stepping away rather than waiting out
    the window. Unknown or already-dead tokens succeed silently: the caller's goal
    is "no longer elevated", and that is true either way.
    """
    session = resolve_session(db, elevation_token or "")
    if session is not None and str(session.machine_id) == str(machine.id):
        revoke_session(db, session)
    db.commit()
    return None
